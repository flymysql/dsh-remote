// dsh-remote — remote-work assistant for DeepSeek Harness.
//
// Host half. Turns "give me a remote host + login" into a usable REMOTE WORKSPACE:
//   • one persistent SSH/SFTP pool per configured remote (password OR private key),
//   • a "current remote workspace" — a remote directory the agent treats as the
//     active project root (user@host:/path) — injected into every system prompt,
//   • model tools `rw_info` / `rw_connect` / `rw_pick_workspace` /
//     `rw_list_dir` / `rw_read_file` / `rw_exec`,
//   • JSON endpoints the client settings page uses to connect → browse → select the
//     remote workspace over the harness `webServer`.
//
// The engine (path guard + shell quoting + ssh pool + exec) reuses the foundation
// proven by dsh-remote-debug, extended with password auth and a mutable workspace:
// `ctx.fs` / the local workspace registry stay untouched — this is a REMOTE workspace
// presented as such to the model and UI, not a replacement of the local one.
//
// Plugin Config MUST be a schemastery schema (zod rejects the undefined row config).
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ssh2 from 'ssh2'
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'

const { Client } = ssh2

export const name = 'dsh-remote'

// tools + systemPrompt + webServer are required. webServer is INJECTED (not just
// lazily read) so this plugin activates only after the web server is up — otherwise
// apply() runs ahead of webServer and the /dsh-remote/* JSON routes never register
// (silently: the boot shows no error, but status/ls/workspace return the SPA fallback).
export const inject = ['tools', 'systemPrompt', 'webServer']

export const Config = z.object({
  /** Remote SSH host (empty → the plugin starts disconnected). */
  host: z.string().default(''),
  /** Remote SSH port (22 unless the machine uses a custom port). */
  port: z.number().step(1).min(1).max(65535).default(22),
  /** SSH login user. */
  username: z.string().default(''),
  /** Password login (only when the remote has no key. Override the fallback below). */
  password: z.string().default(''),
  /** Absolute private-key path; empty → ~/.ssh/id_rsa. */
  privateKeyPath: z.string().default(''),
  /** Key passphrase when the key is encrypted. */
  passphrase: z.string().default(''),
  /** Initial remote workspace path (absolute dir the agent should treat as root). */
  workspace: z.string().default(''),
  /** Per-command timeout. */
  commandTimeoutMs: z.number().step(1).min(1000).default(20000),
  /** SSH connection establishment timeout. */
  connectTimeoutMs: z.number().step(1).min(1000).default(15000),
  /** Hard ceiling on collected remote output per call. */
  maxOutputChars: z.number().step(1).min(1024).default(200000),
})

// ── shell / path helpers (proven in the read tooling) ───────────────────────

/** Single-quote one shell argument verbatim. */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** Collapse `.`/`..`/duplicate slashes into a clean absolute remote path. */
function normalizeRemotePath(p) {
  const parts = []
  for (const seg of String(p).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return '/' + parts.join('/')
}

/** Parent dir of a remote absolute path (string-level). */
function remoteDirname(p) {
  const norm = normalizeRemotePath(p)
  if (norm === '/') return '/'
  const idx = norm.lastIndexOf('/')
  return idx <= 0 ? '/' : norm.slice(0, idx)
}

function truncate(s, max) {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[truncated: ${s.length - max} more chars]`
}

// ── local mirror of an OS remote workspace ────────────────────────────────
// Makes a chosen remote workspace a REAL local directory (fs.realpath passes),
// so the DSH host `workspaceRegistry.create(dir)` accepts it as a native
// workspace. dsh-remote syncs that local mirror <-> the remote over SFTP.

const remotePathBase = (p) => {
  const norm = normalizeRemotePath(p).replace(/\/+$/, '')
  const base = norm.split('/').pop()
  return base || 'workspace'
}

/** Stable local root for one remote host's mirrors */
function mirrorRootFor(host, user, port) {
  const tag = [host, user, port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(homedir(), '.dsh', 'remote-workspaces', tag)
}

/** Local mirror dir for a specific remote path (idempotent → returns same dir). */
function mirrorDirFor(remotePath, host, user, port) {
  const base = remotePathBase(remotePath)
  const h = createHash('sha1').update(`${host}:${port}:${remotePath}`).digest('hex').slice(0, 8)
  return path.join(mirrorRootFor(host, user, port), `${base}-${h}`)
}

/** Create the local mirror dir + a meta file describing its remote origin. */
function ensureMirror(remotePath, host, user, port) {
  const dir = mirrorDirFor(remotePath, host, user, port)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, '.dsh-remote-meta.json'),
    JSON.stringify({ host, port, username: user, remotePath, createdAt: new Date().toISOString() }, null, 2),
  )
  return dir
}

/** Recursively sync remote → local mirror. Bounded by depth/files. */
async function syncTree(sftp, remoteDir, localDir, maxDepth, maxFiles) {
  const entries = await sftp.readdir(remoteDir).then(
    (list) => list,
    () => [],
  )
  let files = 0
  const touched = []
  for (const e of entries) {
    const name = String(e.filename)
    if (name === '.' || name === '..') continue
    const rp = remoteDir === '/' ? '/' + name : remoteDir + '/' + name
    const lp = path.join(localDir, name)
    const isDir = e.attrs && e.attrs.isDirectory && e.attrs.isDirectory()
    if (isDir) {
      if (maxDepth <= 0) continue
      mkdirSync(lp, { recursive: true })
      const sub = await syncTree(sftp, rp, lp, maxDepth - 1, maxFiles)
      files += sub.files
      touched.push(...sub.touched)
      continue
    }
    if (files >= maxFiles) break
    try {
      const buf = await sftp.readFile(rp)
      writeFileSync(lp, buf)
      touched.push(rp)
      files++
    } catch {
      /* skip unreadable */
    }
  }
  return { files, touched }
}

/** Recursively upload a local mirror tree → remote SFTP dir. Bounded by files. */
async function pushTree(sftp, localDir, remoteDir, remoteBaseDir, maxFiles) {
  const entries = readdirSync(localDir, { withFileTypes: true }).filter((e) => e.name !== '.dsh-remote-meta.json')
  let files = 0
  let dirsCreated = 0
  const pushed = []
  for (const e of entries) {
    if (e.isDirectory()) {
      const rp = remoteDir === '/' ? '/' + e.name : remoteDir + '/' + e.name
      try {
        await sftp.mkdir(rp)
        dirsCreated++
      } catch { /* already exists */ }
      const sub = await pushTree(sftp, path.join(localDir, e.name), rp, remoteBaseDir, maxFiles)
      files += sub.files
      pushed.push(...sub.pushed)
      continue
    }
    if (files >= maxFiles) break
    const lp = path.join(localDir, e.name)
    const rp = remoteDir === '/' ? '/' + e.name : remoteDir + '/' + e.name
    try {
      const buf = readFileSync(lp)
      await sftp.writeFile(rp, buf)
      pushed.push(rp)
      files++
    } catch {
      /* skip unreadable / unwritable */
    }
  }
  return { files, pushed }
}

// ── persistent multi-machine registry ─────────────────────────────────────
const MACHINES_FILE = 'machines.json'
const machinesFile = () => path.join(homedir(), '.dsh', 'remote-workspaces', MACHINES_FILE)
function loadMachines() {
  try {
    const j = JSON.parse(readFileSync(machinesFile(), 'utf8'))
    if (Array.isArray(j.list)) return { list: j.list, currentId: j.currentId || (j.list[0] && j.list[0].id) || null }
  } catch {}
  return { list: [], currentId: null }
}
function saveMachines(list, currentId) {
  try { mkdirSync(path.dirname(machinesFile()), { recursive: true }) } catch {}
  writeFileSync(machinesFile(), JSON.stringify({ list, currentId }, null, 2))
}
function sanitizeMachine(m) {
  if (!m) return m
  const { password, ...rest } = m
  return { ...rest, passwordSet: !!(m.password && m.password.length) }
}
/** Apply a machine's fields onto the live config object (pool + tools read it). */
function applyMachine(config, m) {
  if (!m) return
  config.host = m.host
  config.port = Number(m.port) || 22
  config.username = m.username || ''
  config.password = m.password || ''
  config.privateKeyPath = m.privateKeyPath || ''
  config.passphrase = m.passphrase || ''
  config.workspace = m.workspace || (config.workspace || '')
}
function machineId() { return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) }

// ── SSH pool (key OR password) ──────────────────────────────────────────────

class SshPool {
  constructor(config) {
    this.config = config
    this.client = null
    this.connecting = null
  }

  resolveKeyPath() {
    const p = this.config.privateKeyPath
    if (!p) return path.join(homedir(), '.ssh', 'id_rsa')
    if (p.startsWith('~/') || p === '~') return path.join(homedir(), p.slice(1))
    return p
  }

  /** Configure (and reconnect with) a new target. Returns this pool for chaining. */
  setTarget({ host, port, username, password, privateKeyPath, passphrase, workspace }) {
    if (host !== undefined) this.config.host = String(host)
    if (port !== undefined && Number(port)) this.config.port = Number(port)
    if (username !== undefined) this.config.username = String(username)
    if (password !== undefined && password !== null) this.config.password = String(password)
    if (privateKeyPath !== undefined) this.config.privateKeyPath = String(privateKeyPath)
    if (passphrase !== undefined) this.config.passphrase = String(passphrase)
    if (workspace !== undefined) this.config.workspace = String(workspace)
    this.close()
    return this
  }

  connect() {
    if (this.client) return Promise.resolve(this.client)
    if (this.connecting) return this.connecting
    this.connecting = this._doConnect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        if (this.client === client) this.client = null
        reject(err)
      }
      client.on('ready', () => {
        if (settled) return
        settled = true
        this.client = client
        resolve(client)
      })
      client.on('error', fail)
      client.on('close', () => {
        if (this.client === client) this.client = null
        fail(new Error('ssh connection closed'))
      })

      const opts = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        readyTimeout: this.config.connectTimeoutMs,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
      }
      if (this.config.password) {
        opts.password = this.config.password
      } else {
        let key
        try {
          key = readFileSync(this.resolveKeyPath())
        } catch (err) {
          return fail(
            new Error(`cannot read private key "${this.resolveKeyPath()}": ${err && err.message}`),
          )
        }
        opts.privateKey = key
        opts.passphrase = this.config.passphrase || undefined
      }
      client.connect(opts)
    })
  }

  /** Run one remote command; resolves { code, signal, stdout, stderr }. */
  exec(command, timeoutMs) {
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          client.exec(command, (err, stream) => {
            if (err) return reject(new Error('ssh exec failed: ' + ((err && err.message) || err)))
            let stdout = ''
            let stderr = ''
            let settled = false
            let exitCode = null
            let exitSignal = null
            const hardCap = Math.max(this.config.maxOutputChars * 4, 1024 * 1024)
            const settle = () => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve({
                code: exitCode,
                signal: exitSignal,
                stdout: truncate(stdout, this.config.maxOutputChars),
                stderr: truncate(stderr, this.config.maxOutputChars),
              })
            }
            const timer = setTimeout(() => {
              if (settled) return
              exitCode = -1
              exitSignal = 'TIMEOUT'
              try {
                stream.close()
              } catch {}
              settle()
            }, timeoutMs || this.config.commandTimeoutMs)
            stream.on('close', (code, signal) => {
              if (settled) return
              exitCode = code
              exitSignal = signal
              settle()
            })
            stream.on('data', (d) => {
              if (stdout.length < hardCap) stdout += d
            })
            stream.stderr.on('data', (d) => {
              if (stderr.length < hardCap) stderr += d
            })
            stream.on('error', (e) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              reject(new Error('ssh stream error: ' + ((e && e.message) || e)))
            })
          })
        }),
    )
  }

  /** Resolve a promisified SFTP client for binary file transfers (sync). */
  sftp() {
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          client.sftp((err, sftp) => {
            if (err) return reject(new Error('ssh sftp failed: ' + ((err && err.message) || err)))
            resolve({
              readdir: (dir) => new Promise((r2, j2) => sftp.readdir(dir, (e, list) => (e ? j2(e) : r2(list)))),
              stat: (p) => new Promise((r2, j2) => sftp.stat(p, (e, st) => (e ? j2(e) : r2(st)))),
              mkdir: (dir) => new Promise((r2, j2) => sftp.mkdir(dir, (e) => (e ? j2(e) : r2()) )),
              readFile: (p) => new Promise((r2, j2) => sftp.readFile(p, (e, buf) => (e ? j2(e) : r2(buf)))),
              writeFile: (p, data) => new Promise((r2, j2) => sftp.writeFile(p, data, (e) => (e ? j2(e) : r2()))),
            })
          })
        }),
    )
  }

  close() {
    const client = this.client
    this.client = null
    if (client) {
      try {
        client.end()
      } catch {}
    }
  }
}

// ── helper: run + text ─────────────────────────────────────────────────────

export async function apply(ctx, config) {
  const pool = new SshPool(config)
  ctx.effect(() => () => pool.close(), 'dsh-remote.close')

  // ── machine registry (multi-host) ─────────────────────────────────────────
  const store = loadMachines()
  const machines = store.list
  const machineIndex = (id) => machines.findIndex((m) => m.id === id)
  const currentMachine = () => {
    if (store.currentId) {
      const i = machineIndex(store.currentId)
      if (i >= 0) return machines[i]
    }
    // fall back to config-derived default (host set via cordis config)
    if (config.host) return { id: machineId(), name: config.host, host: config.host, port: config.port, username: config.username, password: config.password, privateKeyPath: config.privateKeyPath, passphrase: config.passphrase }
    return null
  }
  const setCurrent = (id) => {
    const i = machineIndex(id)
    if (i < 0) return false
    store.currentId = id
    saveMachines(machines, id)
    applyMachine(config, machines[i])
    pool.setTarget({ host: config.host, port: config.port, username: config.username, password: config.password, privateKeyPath: config.privateKeyPath, passphrase: config.passphrase })
    return true
  }
  // If no stored current, adopt a CLI-provided default as the active machine.
  {
    const cur = currentMachine()
    if (cur && cur.host) applyMachine(config, cur)
  }

  const run = async (cmd, opts = {}) => {
    const res = await pool.exec(cmd, opts.timeoutMs)
    const parts = []
    if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''))
    if (res.stderr) parts.push('-- stderr --\n' + res.stderr.replace(/\s+$/, ''))
    if (!parts.length) parts.push('(no output)')
    let text = parts.join('\n')
    if (res.signal === 'TIMEOUT') text += `\n[command timed out after ${opts.timeoutMs ?? config.commandTimeoutMs}ms]`
    else if (res.code !== 0) text += `\n[exit code: ${res.code}]`
    return text
  }

  // ── remote workspace state ────────────────────────────────────────────────

  const wsPath = () => (config.workspace || '').trim()
  const status = () => ({
    host: config.host,
    port: config.port,
    username: config.username,
    connected: !!pool.client,
    workspace: wsPath(),
    localMirror: wsPath() ? mirrorDirFor(wsPath(), config.host, config.username, config.port) : '',
    currentId: store.currentId || null,
    machines: machines.map(sanitizeMachine),
  })

  // ── tools ─────────────────────────────────────────────────────────────────

  const renderErr = (err) => ({
    kind: 'error',
    text: String((err && err.message) || err),
  })

  const tools = [
    defineTool({
      name: 'rw_info',
      description:
        'Show the remote environment: host/user/port, connection health, and the current remote workspace path. Call this first to orient, or when a remote_* call fails to check connectivity.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, v) => [{ type: 'text', text: v.text }],
      },
      async execute() {
        const s = status()
        const lines = [
          `Remote host: ${s.username || '<user>'}@${s.host || '<host>'}:${s.port}`,
          `Current remote workspace: ${s.workspace || '(none — call rw_pick_workspace to set one)'}`,
          `Connected: ${s.connected ? 'yes' : 'no'}`,
          '',
        ]
        if (s.host && s.workspace) {
          try {
            const res = await pool.exec('echo ok; hostname; pwd', Math.min(config.commandTimeoutMs, 8000))
            if (res.signal === 'TIMEOUT') lines.push('Ping: timeout')
            else if (res.code === 0) lines.push('Ping: OK — ' + res.stdout.replace(/\s+/g, ' ').trim())
            else lines.push('Ping: FAILED — ' + (res.stderr || res.stdout || `exit ${res.code}`).trim())
          } catch (err) {
            lines.push('Ping: FAILED — ' + ((err && err.message) || err))
          }
        } else {
          lines.push('No host + workspace configured — call rw_connect with a host to get started.')
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'rw_connect',
      description:
        'Connect SSH to a remote host for remote workspace work. Provide host (required), user, optional password or privateKeyPath/port. Once connected, call rw_pick_workspace to pick the workspace directory this session should work in.',
      parameters: {
        host: { type: 'string', required: true, description: 'Remote host IP or hostname' },
        username: { type: 'string', description: 'SSH user (default from config or root)' },
        port: { type: 'integer', description: 'SSH port (default 22)' },
        password: { type: 'string', description: 'SSH password (prefer SSH key when possible)' },
        privateKeyPath: { type: 'string', description: 'Absolute private-key path' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const host = String(args.host || '').trim()
        if (!host) throw new Error('rw_connect: host is required')
        pool.setTarget({
          host,
          username: args.username || config.username || 'root',
          port: args.port || undefined,
          password: args.password !== undefined ? args.password : undefined,
          privateKeyPath: args.privateKeyPath || undefined,
        })
        try {
          const res = await pool.exec('echo ok; hostname', 8000)
          if (res.code !== 0 && !res.stdout) return { text: 'connect failed: ' + (res.stderr || 'exit ' + res.code) }
          return { text: `Connected to ${host} as ${config.username}.\nhostname: ${res.stdout.replace(/\s+/g, ' ').trim()}\n\npick a workspace with rw_pick_workspace (path=<abs>).` }
        } catch (err) {
          throw err
        }
      },
    }),

    defineTool({
      name: 'rw_pick_workspace',
      description:
        'Set the remote workspace directory this session should treat as its working root on the connected remote. Verifies it exists (a directory). Use rw_list_dir to browse first if unsure.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote directory path, e.g. /home/dev/code/project' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_pick_workspace: path must be an absolute directory')
        const res = await pool.exec(`if [ -d ${shq(p)} ]; then echo DIR; else echo NOTDIR; fi`)
        const ok = res.stdout.trim() === 'DIR'
        if (!ok) return { text: `not a directory (or missing) on ${p}` }
        config.workspace = p
        const local = ensureMirror(p, config.host, config.username, config.port)
        return {
          text: `Remote workspace set to ${p} on ${config.username}@${config.host}.\nLocal mirror (native workspace path): ${local}\n\nRun rw_sync to download its files into the local mirror.`,
        }
      },
    }),

    defineTool({
      name: 'rw_sync',
      description:
        'Download the current remote workspace into its local mirror directory over SFTP (bounded). Makes the remote files visible/editable locally so the DSH native workspace / fs tools can operate on them.',
      parameters: {
        depth: { type: 'integer', description: 'Max directory depth to mirror (default 5)' },
        maxFiles: { type: 'integer', description: 'Max files to download (default 500)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const p = wsPath()
        if (!p) throw new Error('rw_sync: no remote workspace set — call rw_pick_workspace first')
        const local = mirrorDirFor(p, config.host, config.username, config.port)
        mkdirSync(local, { recursive: true })
        const depth = Math.min(Math.max(Number(args.depth) || 5, 1), 8)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 500, 1), 2000)
        let sftp
        try {
          sftp = await pool.sftp()
        } catch (err) {
          return { text: 'sftp unavailable: ' + ((err && err.message) || err) }
        }
        const { files, touched } = await syncTree(sftp, p, local, depth, maxFiles)
        return { text: `Downloaded ${files} file(s) from ${p} → ${local}${files >= maxFiles ? ' (hit download cap)' : ''}.` }
      },
    }),

    defineTool({
      name: 'rw_push',
      description:
        'Upload the local mirror of the current remote workspace back to the remote host over SFTP (bounded). Use after editing files in the local mirror so the remote reflects your changes (bidirectional sync).',
      parameters: {
        maxFiles: { type: 'integer', description: 'Max files to upload (default 500)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const p = wsPath()
        if (!p) throw new Error('rw_push: no remote workspace set — call rw_pick_workspace first')
        const local = mirrorDirFor(p, config.host, config.username, config.port)
        if (!existsSync(local)) throw new Error(`rw_push: local mirror does not exist — run rw_sync first (${local})`)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 500, 1), 2000)
        let sftp
        try {
          sftp = await pool.sftp()
        } catch (err) {
          return { text: 'sftp unavailable: ' + ((err && err.message) || err) }
        }
        const { files } = await pushTree(sftp, local, p, p, maxFiles)
        return { text: `Uploaded ${files} file(s) from ${local} → ${p}.` }
      },
    }),

    defineTool({
      name: 'rw_list_dir',
      description:
        'List a remote directory (or a single file) via SSH. Path is absolute; if omitted, lists the current remote workspace.',
      parameters: {
        path: { type: 'string', description: 'Absolute remote path (default: current remote workspace)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const p = args.path ? normalizeRemotePath(String(args.path)) : wsPath()
        if (!p) throw new Error('rw_list_dir: no path and no remote workspace set')
        return { text: await run(`ls -la --color=never ${shq(p)}`) }
      },
    }),

    defineTool({
      name: 'rw_read_file',
      description:
        'Read a text file on the remote host with line numbers. Supports paging with startLine/endLine. Path is absolute.', 
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        startLine: { type: 'integer', description: '1-based first line (default 1)' },
        endLine: { type: 'integer', description: '1-based last line (inclusive)' },
        maxLines: { type: 'integer', description: 'Max lines (default 2000)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p) throw new Error('rw_read_file: path is required')
        const maxLines = Math.min(Math.max(Number(args.maxLines) || 2000, 1), 10000)
        let from = Math.max(Number(args.startLine) || 1, 1)
        let to = Number(args.endLine) || 0
        if (!to || to - from + 1 > maxLines) to = from + maxLines - 1
        const raw = await run(`sed -n '${from},${to}p' -- ${shq(p)}`, { timeoutMs: config.commandTimeoutMs })
        const numbered = raw.split('\n').map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n').replace(/\s+$/, '')
        let text = numbered === '' ? '(empty or out of range)' : numbered
        if (!args.endLine) text += '\n(shown up to ' + maxLines + ' lines; use startLine/endLine to page)'
        return { text }
      },
    }),

    defineTool({
      name: 'rw_exec',
      description:
        'Run a shell command on the remote host. Use for anything that is not reading a file (build, test, grep, etc). Output is capped.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command (run on the remote host)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const cmd = String(args.command || '')
        if (!cmd) throw new Error('rw_exec: command is required')
        return { text: await run(cmd, { timeoutMs: config.commandTimeoutMs }) }
      },
    }),
  ]

  for (const t of tools) {
    ctx.tools.register(t)
  }

  // ── system-prompt injection: the current remote workspace ─────────────────
  ctx.systemPrompt.section({
    name: 'dsh-remote',
    order: 88,
    text: () => {
      const w = wsPath()
      if (!w || !config.host) return ''
      return (
        '## Remote workspace\n' +
        `Current remote workspace: ${config.username}@${config.host}:${w}\n` +
        'Use the remote_* tools (rw_list_dir / rw_read_file / rw_exec) to inspect and act on files on the remote host. Treat this directory as the working root for this task.'
      )
    },
  })

  // ── slash command: /remote reports status + connection hints ──────────────
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'remote',
      description: 'Show the current remote workspace / connection status and how to use remote tools.',
      handler: (invocation) => {
        const s = status()
        return {
          kind: 'success',
          text:
            `Remote host: ${s.username}@${s.host || '<none>'} (connected: ${s.connected})\n` +
            `Remote workspace: ${s.workspace || '(none)'}\n` +
            `\nUse tools: rw_list_dir / rw_read_file / rw_exec.` +
            (s.workspace ? `\nCurrently working in ${s.workspace}.` : ''),
        }
      },
    })
  }

  // ── JSON endpoints for settings UI ─────────────────────────────────────────
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(chunks.join('')))
    })

  const routes = [
    {
      kind: 'exact',
      path: '/dsh-remote/status',
      handler: async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, status())
        sendJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          pool.setTarget({
            host: payload.host,
            port: payload.port,
            username: payload.username,
            password: payload.password !== undefined && payload.password !== '' ? payload.password : undefined,
            privateKeyPath: payload.privateKeyPath,
            workspace: payload.workspace,
          })
          await pool.exec('echo ok', Math.min(config.commandTimeoutMs, 8000))
          return sendJson(res, 200, { ok: true, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/ls',
      handler: async (req, res) => {
        try {
          const m = (req.url || '').match(/path=([^&]*)/)
          const p = m ? decodeURIComponent(m[1]) : wsPath()
          const out = await run(`ls -la --color=never ${shq(p || '/')}`)
          return sendJson(res, 200, { path: p, text: out })
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/workspace',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = normalizeRemotePath(String(payload.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { error: 'path must be an absolute directory' })
          const r = await pool.exec(`if [ -d ${shq(p)} ]; then echo DIR; else echo NOTDIR; fi`)
          if (r.stdout.trim() !== 'DIR') return sendJson(res, 400, { ok: false, error: `not a directory: ${p}` })
          config.workspace = p
          const local = ensureMirror(p, config.host, config.username, config.port)
          return sendJson(res, 200, { ok: true, workspace: p, localMirror: local, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/mirror',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = normalizeRemotePath(String(payload.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path must be an absolute directory' })
          if (!config.host) return sendJson(res, 400, { ok: false, error: 'no remote host configured/connected — connect first' })
          // optional: verify it's a directory over SSH when connected
          if (pool.client) {
            const r = await pool.exec(`if [ -d ${shq(p)} ]; then echo DIR; else echo NOTDIR; fi`)
            if (r.stdout.trim() !== 'DIR') return sendJson(res, 400, { ok: false, error: `not a directory (or unreachable): ${p}` })
          }
          const local = ensureMirror(p, config.host, config.username, config.port)
          config.workspace = p
          return sendJson(res, 200, { ok: true, path: p, localMirror: local, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/machines',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          return sendJson(res, 200, { machines: machines.map(sanitizeMachine), currentId: store.currentId })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const action = body.action || 'add'
            if (action === 'add' || action === 'update') {
              const host = String(body.host || '').trim()
              if (!host) return sendJson(res, 400, { ok: false, error: 'host required' })
              const rec = {
                id: body.id || machineId(),
                name: String(body.name || '').trim() || host,
                host,
                port: Number(body.port) || 22,
                username: String(body.username || '').trim() || 'root',
                password: body.password || '',
                privateKeyPath: String(body.privateKeyPath || '').trim(),
                passphrase: body.passphrase || '',
                workspace: String(body.workspace || '').trim(),
              }
              const i = machineIndex(rec.id)
              if (i >= 0) machines[i] = rec; else machines.push(rec)
              if (!store.currentId) { store.currentId = rec.id }
              saveMachines(machines, store.currentId)
              if (store.currentId === rec.id) applyMachine(config, rec)
              return sendJson(res, 200, { ok: true, machine: sanitizeMachine(rec), machines: machines.map(sanitizeMachine), currentId: store.currentId })
            }
            if (action === 'delete') {
              const i = machineIndex(String(body.id || ''))
              if (i < 0) return sendJson(res, 404, { ok: false, error: 'machine not found' })
              machines.splice(i, 1)
              if (store.currentId === body.id) store.currentId = machines[0] ? machines[0].id : null
              saveMachines(machines, store.currentId)
              return sendJson(res, 200, { ok: true, machines: machines.map(sanitizeMachine), currentId: store.currentId })
            }
            return sendJson(res, 400, { ok: false, error: 'unknown action' })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/current',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const okSet = setCurrent(String(body.id || ''))
          if (!okSet) return sendJson(res, 404, { ok: false, error: 'machine not found' })
          return sendJson(res, 200, { ok: true, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]

  const disposers = routes.map((r) => webServer.register(r))
  ctx.effect(() => () => disposers.forEach((d) => d && d()), 'dsh-remote.routes')
}