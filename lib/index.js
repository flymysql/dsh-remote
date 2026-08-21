// dsh-remote — remote-work assistant for DeepSeek Harness.
//
// Host half. Turns "give me a remote host + login" into a usable REMOTE WORKSPACE:
//   • one persistent SSH/SFTP pool per configured remote (password OR private key,
//     SSH agent, keyboard-interactive, proxy jump),
//   • a "current remote workspace" — a remote directory the agent treats as the
//     active project root (user@host:/path) — injected into every system prompt,
//   • model tools `rw_*` (info/connect/workspace/list/read/write/edit/append/mkdir/
//     remove/move/stat/exec/search/download/upload/sync/push/forward/disconnect),
//   • JSON endpoints the client settings page + sidebar use over the harness
//     `webServer` (machines / ls / read / write / fs / forwards / task / audit /
//     ssh-config / local-pick / …),
//   • local mirror of the remote workspace (three-way conflict-aware SFTP sync),
//   • optional OS-keychain password storage, command audit log, TOFU host keys.
//
// The engine (path guard + shell quoting + ssh pool + exec) keeps the proven
// foundation; `ctx.fs` / the local workspace registry stay untouched — this is a
// REMOTE workspace presented as such to the model and UI.
//
// Plugin Config MUST be a schemastery schema (zod rejects the undefined row config).
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ssh2 from 'ssh2'
import { execFile } from 'node:child_process'
import zlib from 'node:zlib'
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, copyFileSync, utimesSync, appendFileSync, unlinkSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'

import {
  shq, normalizeRemotePath, joinRemotePath, remoteDirname, mkdirRemoteDirs,
  toSftpPath, remotePathBase, truncate, shortHash, relPathUnder,
} from './paths.js'
import { blobAlgorithm, keyFingerprint } from './hostkey.js'
import { compileIgnore, DEFAULT_IGNORE } from './ignore.js'
import { friendlyMessage } from './errors.js'
import { importableEntries, sshConfigPath, readSshConfigText } from './sshconfig.js'
import { saveSecret, getSecret, deleteSecret, platformBackend } from './credential.js'
import { syncTree, pushTree, loadSyncState, saveSyncState, pushOneFile } from './sync.js'
import { searchTree } from './search.js'
import { TaskManager } from './tasks.js'
import { ForwardManager } from './forwards.js'
import { selfDir, readVersion, gtVersion, fetchLatestVersion, applyUpdate, persistUpdateMode, readUpdateMode } from './update.js'

const { Client } = ssh2

export const name = 'dsh-remote'

// tools + systemPrompt + webServer are required. webServer is INJECTED (not just
// lazily read) so this plugin activates only after the web server is up — otherwise
// apply() runs ahead of webServer and the /dsh-remote/* JSON routes never register.
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
  /** Explicit SSH private-key path (optional; only used when supplied). Never auto-reads ~/.ssh. */
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
  /** Skip mirroring files larger than this many bytes (0 = no cap). */
  maxFileBytes: z.number().step(1).min(0).default(52428800),
  /** Host-key policy: `accept-new` (default) records a host's key on first
   * connect and verifies it afterwards (mirrors ssh's StrictHostKeyChecking
   * accept-new); `verify` also rejects hosts never seen before; `off` skips
   * verification entirely (MITM-unsafe, not recommended). */
  hostKeyMode: z.string().default('accept-new'),
  /** Use the OpenSSH agent (SSH_AUTH_SOCK) when no password/key is configured. */
  useAgent: z.boolean().default(false),
  /** Allow keyboard-interactive auth (OTP/MFA chains) using the configured password. */
  keyboardInteractive: z.boolean().default(false),
  /** Jump host / bastion: connect through this machine first. All fields have
   * defaults so this works on schemastery versions without `.optional()`; an
   * empty `host` means "no jump host". */
  proxy: z.object({
    host: z.string().default(''),
    port: z.number().step(1).min(1).max(65535).default(22),
    username: z.string().default(''),
    password: z.string().default(''),
    privateKeyPath: z.string().default(''),
  }),
  /** Auto-push edited mirror files back to the remote (watcher, debounced). Default off. */
  autoPush: z.boolean().default(false),
  /** Append executed commands to the audit log under the harness home. */
  auditLog: z.boolean().default(true),
  /** Text encoding for remote file reads/writes (utf-8 default; gbk etc.). */
  encoding: z.string().default('utf-8'),
  /** Update mode: `manual` (default) only checks when asked; `auto` checks on
   * load and periodically, applying a newer npm release automatically;
   * `off` disables version checks entirely. (schemastery 3.18 has no .enum —
   * keep string and validate in code.) */
  updateMode: z.string().default('manual'),
  /** How often (ms) auto mode checks the npm registry for a newer release. */
  updateCheckIntervalMs: z.number().step(1).min(60000).default(6 * 3600 * 1000),
})

// ── shell / path helpers (pure implementations in lib/paths.js) ───────────

/** Harness home: respect `DSH_HOME` when set (the desktop app sets it to its
 * own `userData/harness`), otherwise fall back to `~/.dsh`. */
function dshBase() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return path.resolve(String(env).trim())
  return path.join(homedir(), '.dsh')
}

/** Root holding every remote host's mirrors + the machine registry. */
function remoteWorkspacesRoot() {
  return path.join(dshBase(), 'remote-workspaces')
}

/** Safe path segment for a session id (mirrors DSH's encodeSegment: alnum + _- .).
 *  Session dirs keep the id mostly verbatim; sanitize anything exotic. */
function encodeSegmentSafe(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9._-]/g, '_')
  return s || 'session'
}

/** Read the cwd from a session log header. Handles plain JSONL, .gz, and
 *  multi-frame zstd (decompress only the first frame, which holds the header).
 *  Returns the header cwd string, or '' when unreadable/absent. */
function readSessionHeaderCwd(file) {
  try {
    let buf = readFileSync(file)
    if (/\.zstd$/.test(file)) {
      buf = zlib.zstdDecompressSync(buf)
    } else if (/\.gz$/.test(file)) {
      buf = zlib.gunzipSync(buf)
    }
    const nl = buf.indexOf(10)
    if (nl < 0) return ''
    const head = JSON.parse(buf.subarray(0, nl).toString('utf8'))
    return typeof head.cwd === 'string' ? head.cwd : ''
  } catch {
    return ''
  }
}

/** Local mirrors of one remote host. */
function mirrorRootFor(host, user, port) {
  const tag = [host, user, port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(remoteWorkspacesRoot(), tag)
}

/** Local mirror dir for a specific remote path (idempotent → returns same dir). */
function mirrorDirFor(remotePath, host, user, port) {
  const base = remotePathBase(remotePath)
  const root = mirrorRootFor(host, user, port)
  const plain = path.join(root, base)
  const norm = normalizeRemotePath(remotePath)
  // A pre-existing mirror for this exact remote origin → reuse it (idempotent).
  try {
    const meta = JSON.parse(readFileSync(path.join(plain, '.dsh-remote-meta.json'), 'utf8'))
    if (meta.remotePath === norm) return plain
  } catch {
    /* no mirror yet → fall through */
  }
  if (!existsSync(plain)) return plain
  return path.join(root, base + '-' + shortHash(norm))
}

/** Create the local mirror dir + a meta file describing its remote origin. */
function ensureMirror(remotePath, host, user, port) {
  const dir = mirrorDirFor(remotePath, host, user, port)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, '.dsh-remote-meta.json'),
    JSON.stringify({ host, port, username: user, remotePath: normalizeRemotePath(remotePath), createdAt: new Date().toISOString() }, null, 2),
  )
  return dir
}

/** Recursive directory copy (EXDEV fallback for migrateLegacyData). */
function copyDirSync(from, to) {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name)
    const d = path.join(to, e.name)
    if (e.isDirectory()) copyDirSync(s, d)
    else try { copyFileSync(s, d) } catch { /* skip unreadable */ }
  }
}

/** One-time migration of pre-0.6 data (~/.dsh/remote-workspaces) into DSH_HOME.
 * Only runs when the harness is on its DEFAULT home: an explicitly-set DSH_HOME
 * pointing elsewhere means ~/.dsh belongs to another installation — migrating
 * would RENAME that other installation's live data out from under it. */
function migrateLegacyData() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim() && path.resolve(String(env).trim()) !== path.join(homedir(), '.dsh')) return
  const legacy = path.join(homedir(), '.dsh', 'remote-workspaces')
  const target = remoteWorkspacesRoot()
  if (legacy === target || !existsSync(legacy) || existsSync(target)) return
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    try {
      renameSync(legacy, target)
    } catch (err) {
      if (err.code !== 'EXDEV') throw err
      copyDirSync(legacy, target)
    }
  } catch {
    // Migration is best-effort: a fresh registry is created on next save.
  }
}

// ── persistent multi-machine registry ─────────────────────────────────────
const MACHINES_FILE = 'machines.json'
const machinesFile = () => path.join(remoteWorkspacesRoot(), MACHINES_FILE)
const secretsDir = () => path.join(remoteWorkspacesRoot(), '.secrets')
const forwardsFile = () => path.join(remoteWorkspacesRoot(), 'forwards.json')
const auditFile = () => path.join(remoteWorkspacesRoot(), 'audit.log')
const ignoreFile = () => path.join(remoteWorkspacesRoot(), '.dsh-remote-ignore')

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
  const { password, proxy, ...rest } = m
  const out = { ...rest, passwordSet: !!(m.password && m.password.length) }
  if (proxy) out.proxy = { ...proxy, password: proxy.password ? '' : undefined, passwordSet: !!(proxy.password && proxy.password.length) }
  return out
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
  if (m.hostKeyMode) config.hostKeyMode = m.hostKeyMode
  if (typeof m.useAgent === 'boolean') config.useAgent = m.useAgent
  if (typeof m.keyboardInteractive === 'boolean') config.keyboardInteractive = m.keyboardInteractive
  config.proxy = m.proxy && m.proxy.host ? m.proxy : undefined
}
function machineId() { return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) }

// ── host-key registry (TOFU) ──────────────────────────────────────────────
const KNOWN_HOSTS_FILE = 'known_hosts.json'
const knownHostsFile = () => path.join(remoteWorkspacesRoot(), KNOWN_HOSTS_FILE)

function loadKnownHosts() {
  try {
    const j = JSON.parse(readFileSync(knownHostsFile(), 'utf8'))
    if (j && typeof j === 'object' && !Array.isArray(j)) return j
  } catch {}
  return {}
}

/** Build an ssh2 `hostVerifier` bound to the current config. */
function createHostKeyGuard(config) {
  const id = () => `${config.host}:${config.port}`
  const mode = config.hostKeyMode === 'verify' || config.hostKeyMode === 'off'
    ? config.hostKeyMode
    : 'accept-new'
  const guard = {
    mode,
    lastError: null,
    knownHosts: loadKnownHosts,
    forgetHost() {
      const kh = loadKnownHosts()
      delete kh[id()]
      try { mkdirSync(path.dirname(knownHostsFile()), { recursive: true }) } catch {}
      writeFileSync(knownHostsFile(), JSON.stringify(kh, null, 2))
    },
    verifier(key) {
      if (mode === 'off') return true
      const fp = keyFingerprint(key)
      const kh = loadKnownHosts()
      const stored = kh[id()]
      if (stored) {
        if (stored.fingerprint === fp) return true
        guard.lastError =
          `host key for ${id()} CHANGED (stored ${stored.fingerprint}, received ${fp}) — ` +
          'possible man-in-the-middle; run /remote-forget-key to re-trust if this is expected'
        return false
      }
      if (mode === 'verify') {
        guard.lastError = `unknown host key for ${id()} (hostKeyMode=verify) — trust it first with accept-new`
        return false
      }
      kh[id()] = { algo: blobAlgorithm(key) || (key && key.algo) || 'unknown', fingerprint: fp, firstSeen: new Date().toISOString() }
      try { mkdirSync(path.dirname(knownHostsFile()), { recursive: true }) } catch {}
      writeFileSync(knownHostsFile(), JSON.stringify(kh, null, 2))
      return true
    },
  }
  return guard
}

/** Whether the current target's key has been recorded/trusted before. */
function isHostKeyKnown(host, port) {
  return Object.prototype.hasOwnProperty.call(loadKnownHosts(), `${host}:${port}`)
}

// ── SSH pool (key / password / agent / keyboard-interactive / proxy) ──────

class SshPool {
  constructor(config) {
    this.config = config
    this.client = null
    this.connecting = null
    this.proxyPool = null
    // Generational token: bumped on every target change / close so a stale
    // in-flight connect can never hand this pool a connection to an old host.
    this.epoch = 0
    /** Optional async resolver for a machine-stored (keychain) password. */
    this.passwordResolver = null
    /** Optional hook called with the live client after a successful connect. */
    this.onReady = null
    /** Optional hook called when the pool closes. */
    this.onCloseHook = null
  }

  resolveKeyPath() {
    const p = this.config.privateKeyPath
    if (!p) return ''
    if (p.startsWith('~/') || p === '~') return path.join(homedir(), p.slice(1))
    return p
  }

  setTarget({ host, port, username, password, privateKeyPath, passphrase, workspace, useAgent, keyboardInteractive, proxy, hostKeyMode }) {
    if (host !== undefined) this.config.host = String(host)
    if (port !== undefined && Number(port)) this.config.port = Number(port)
    if (username !== undefined) this.config.username = String(username)
    if (password !== undefined && password !== null) this.config.password = String(password)
    if (privateKeyPath !== undefined) this.config.privateKeyPath = String(privateKeyPath)
    if (passphrase !== undefined) this.config.passphrase = String(passphrase)
    if (workspace !== undefined) this.config.workspace = String(workspace)
    if (useAgent !== undefined) this.config.useAgent = !!useAgent
    if (keyboardInteractive !== undefined) this.config.keyboardInteractive = !!keyboardInteractive
    if (proxy !== undefined) this.config.proxy = proxy
    if (hostKeyMode !== undefined) this.config.hostKeyMode = String(hostKeyMode)
    this.close()
    return this
  }

  connect() {
    if (this.client) return Promise.resolve(this.client)
    if (this.connecting) return this.connecting
    const epoch = this.epoch
    const pending = this._doConnect(epoch)
    this.connecting = pending
    const clear = () => {
      if (this.epoch === epoch && this.connecting === pending) this.connecting = null
    }
    pending.then(clear, clear)
    return pending
  }

  async _doConnect(epoch) {
    const isCurrent = () => this.epoch === epoch
    const guard = createHostKeyGuard(this.config)
    const client = new Client()
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      if (isCurrent() && this.client === client) this.client = null
      throw guard.lastError ? new Error(guard.lastError) : err
    }

    // Proxy jump: SSH to the bastion first, then tunnel to the target through it.
    let sock = null
    const proxyCfg = this.config.proxy
    if (proxyCfg && proxyCfg.host) {
      try {
        this.proxyPool = new SshPool({
          ...this.config,
          host: proxyCfg.host,
          port: Number(proxyCfg.port) || 22,
          username: proxyCfg.username || this.config.username || 'root',
          password: proxyCfg.password || '',
          privateKeyPath: proxyCfg.privateKeyPath || '',
          passphrase: proxyCfg.passphrase || '',
          proxy: undefined,
        })
        const pclient = await this.proxyPool.connect()
        if (!isCurrent()) throw new Error('ssh target changed during proxy connect')
        sock = await new Promise((res, rej) => {
          pclient.forwardOut('127.0.0.1', 0, this.config.host, this.config.port, (e, ch) => (e ? rej(new Error('proxy forward to target failed: ' + ((e && e.message) || e))) : res(ch)))
        })
      } catch (err) {
        return fail(err)
      }
    }

    return new Promise((resolve, reject) => {
      const rejectOnce = (err) => {
        if (settled) return
        settled = true
        if (isCurrent() && this.client === client) this.client = null
        reject(guard.lastError ? new Error(guard.lastError) : err)
      }
      client.on('ready', () => {
        if (settled) return
        settled = true
        if (!isCurrent()) {
          try { client.end() } catch {}
          reject(new Error('ssh target changed during connect'))
          return
        }
        this.client = client
        resolve(client)
        if (this.onReady) { try { this.onReady(client) } catch {} }
      })
      client.on('error', (e) => rejectOnce(e))
      client.on('close', () => {
        if (isCurrent() && this.client === client) this.client = null
        rejectOnce(new Error('ssh connection closed'))
      })

      const buildOpts = async () => {
        const opts = {
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          readyTimeout: this.config.connectTimeoutMs,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          hostVerifier: (key) => guard.verifier(key),
        }
        if (sock) opts.sock = sock
        if (this.config.useAgent) {
          const sockPath = process.env.SSH_AUTH_SOCK
          if (sockPath) opts.agent = sockPath
        }
        let password = this.config.password || ''
        if (!password && this.passwordResolver) {
          try { password = (await this.passwordResolver()) || '' } catch {}
        }
        if (password) {
          opts.password = password
          opts.tryKeyboard = true
        } else if (this.config.keyboardInteractive && !this.config.privateKeyPath) {
          opts.tryKeyboard = true
        }
        if (this.config.privateKeyPath) {
          const keyPath = this.resolveKeyPath()
          if (!keyPath) {
            throw new Error('no credentials: set a password or a privateKeyPath to connect')
          }
          let key
          try {
            key = readFileSync(keyPath)
          } catch (err) {
            throw new Error(`cannot read private key "${keyPath}": ${err && err.message}`)
          }
          opts.privateKey = key
          opts.passphrase = this.config.passphrase || undefined
        } else if (!password && !opts.agent) {
          throw new Error('no credentials: set a password, a privateKeyPath, or enable useAgent to connect')
        }
        return opts
      }

      buildOpts().then(
        (opts) => {
          if (opts.tryKeyboard) {
            client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
              finish(prompts.map(() => this.config.password || ''))
            })
          }
          client.connect(opts)
        },
        (err) => rejectOnce(err),
      )
    })
  }

  /** Run one remote command; resolves { code, signal, stdout, stderr }.
   * Accepts `exec(cmd, timeoutMs)` (legacy) or `exec(cmd, {timeoutMs, pty, env})`. */
  exec(command, timeoutMsOrOpts) {
    const opts = timeoutMsOrOpts && typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : { timeoutMs: timeoutMsOrOpts }
    const timeoutMs = opts.timeoutMs || this.config.commandTimeoutMs
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          let retried = false
          const runOn = (c) => {
            const execOpts = {}
            if (opts.pty) execOpts.pty = true
            if (opts.env && typeof opts.env === 'object') execOpts.env = opts.env
            c.exec(command, execOpts, (err, stream) => {
              if (err) {
                // Channel-open failure usually means the pooled connection died
                // server-side (idle timeout / network reset) while keepalive
                // hadn't noticed. Drop it and retry ONCE on a fresh connection.
                if (!retried && /channel open failure|open failed/i.test(String((err && err.message) || err))) {
                  retried = true
                  this.invalidate()
                  return this.connect().then(
                    (fresh) => runOn(fresh),
                    (e2) => reject(new Error('ssh exec failed (reconnect): ' + ((e2 && e2.message) || e2))),
                  )
                }
                return reject(new Error('ssh exec failed: ' + ((err && err.message) || err)))
              }
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
                // Kill the remote command (SIGTERM) rather than just dropping the
                // channel, so a runaway process cannot keep running and holding
                // the SSH connection after we've given up on its output.
                try {
                  if (typeof stream.signal === 'function') stream.signal('SIGTERM')
                } catch {}
                const hardClose = setTimeout(() => {
                  try { stream.close() } catch {}
                }, 800)
                if (typeof hardClose.unref === 'function') hardClose.unref()
                settle()
              }, timeoutMs)
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
          }
          runOn(client)
        }),
    )
  }

  /** Resolve a promisified SFTP client. All paths normalized via toSftpPath(). */
  sftp() {
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          let retried = false
          const runOn = (c) => {
            c.sftp((err, sftp) => {
              if (err) {
                // Same dead-connection recovery as exec(): a channel open
                // failure means the pooled connection is stale — drop it and
                // retry ONCE on a fresh connection.
                if (!retried && /channel open failure|open failed/i.test(String((err && err.message) || err))) {
                  retried = true
                  this.invalidate()
                  return this.connect().then(
                    (fresh) => runOn(fresh),
                    (e2) => reject(new Error('ssh sftp failed (reconnect): ' + ((e2 && e2.message) || e2))),
                  )
                }
                return reject(new Error('ssh sftp failed: ' + ((err && err.message) || err)))
              }
              const withTimeout = (fn) => (...args) =>
                new Promise((r2, j2) => {
                  const timer = setTimeout(() => j2(new Error('sftp operation timed out')), this.config.commandTimeoutMs)
                  const done = (e, v) => {
                    clearTimeout(timer)
                    e ? j2(e) : r2(v)
                  }
                  try { fn(...args, done) } catch (e) { clearTimeout(timer); j2(e) }
                })
              const P = (p) => toSftpPath(p)
              resolve({
                readdir: (dir) => withTimeout((d, cb) => sftp.readdir(d, cb))(P(dir)),
                stat: (p) => withTimeout((d, cb) => sftp.stat(d, cb))(P(p)),
                lstat: (p) => withTimeout((d, cb) => sftp.lstat(d, cb))(P(p)),
                mkdir: (dir) => withTimeout((d, cb) => sftp.mkdir(d, cb))(P(dir)),
                rmdir: (dir) => withTimeout((d, cb) => sftp.rmdir(d, cb))(P(dir)),
                unlink: (p) => withTimeout((d, cb) => sftp.unlink(d, cb))(P(p)),
                rename: (p, d) => withTimeout((a, b, cb) => sftp.rename(a, b, cb))(P(p), P(d)),
                realpath: (p) => withTimeout((d, cb) => sftp.realpath(d, cb))(P(p)),
                readFile: (p) => withTimeout((d, cb) => sftp.readFile(d, cb))(P(p)),
                writeFile: (p, data) => withTimeout((d, data2, cb) => sftp.writeFile(d, data2, cb))(P(p), data),
                fastGet: (p, lp) => withTimeout((d, l, cb) => sftp.fastGet(d, l, cb))(P(p), lp),
                fastPut: (p, lp) => withTimeout((d, l, cb) => sftp.fastPut(d, l, cb))(P(p), lp),
              })
            })
          }
          runOn(client)
        }),
    )
  }

  /**
   * Drop the cached client and force a fresh connection on the next call.
   * Called when a channel open fails (e.g. "Channel open failure: open
   * failed") — the pooled SSH connection is usually dead server-side while
   * keepalive has not yet noticed, and reusing it keeps failing. The epoch
   * bump orphans any in-flight connect; the client is ended so ssh2 frees
   * its sockets.
   */
  invalidate() {
    this.epoch++
    const client = this.client
    this.client = null
    const pending = this.connecting
    this.connecting = null
    if (pending && typeof pending.catch === 'function') {
      try { pending.catch(() => {}) } catch {}
    }
    if (this.proxyPool) {
      try { this.proxyPool.close() } catch {}
      this.proxyPool = null
    }
    if (client) {
      try { client.end() } catch {}
    }
  }

  close() {
    this.epoch++
    const client = this.client
    this.client = null
    const pending = this.connecting
    this.connecting = null
    if (pending && typeof pending.catch === 'function') {
      try { pending.catch(() => {}) } catch {}
    }
    if (this.proxyPool) {
      try { this.proxyPool.close() } catch {}
      this.proxyPool = null
    }
    if (client) {
      try {
        client.end()
      } catch {}
    }
    if (this.onCloseHook) {
      try { this.onCloseHook() } catch {}
    }
  }
}

// ── encoding helpers ───────────────────────────────────────────────────────

function decodeBuf(buf, enc) {
  const e = enc && !/^utf-?8$/i.test(String(enc)) ? String(enc).toLowerCase() : null
  return e ? iconv.decode(buf, e) : buf.toString('utf8')
}
function encodeText(s, enc) {
  const e = enc && !/^utf-?8$/i.test(String(enc)) ? String(enc).toLowerCase() : null
  return e ? iconv.encode(String(s), e) : Buffer.from(String(s), 'utf8')
}

// ── apply ─────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  const pool = new SshPool(config)
  ctx.effect(() => () => pool.close(), 'dsh-remote.close')

  migrateLegacyData()

  // ── machine registry (multi-host) ─────────────────────────────────────────
  const store = loadMachines()
  const machines = store.list
  const machineIndex = (id) => machines.findIndex((m) => m.id === id)

  /** The machine the pool is currently bound to: an ephemeral tool connection
   * (rw_connect save:false) wins, then the stored current, then config default. */
  let ephemeral = null
  const activeMachine = () => {
    if (ephemeral) return ephemeral
    if (store.currentId) {
      const i = machineIndex(store.currentId)
      if (i >= 0) return machines[i]
    }
    if (config.host) return { id: machineId(), name: config.host, host: config.host, port: config.port, username: config.username, password: config.password, privateKeyPath: config.privateKeyPath, passphrase: config.passphrase }
    return null
  }
  const currentMachine = activeMachine

  /** Resolve a machine's effective password (keychain backend support). */
  const machinePassword = async (m) => {
    if (m && m.password) return m.password
    if (m && m.credentialBackend && m.credentialBackend !== 'plain') {
      const p = await getSecret(m.id, secretsDir())
      if (p) return p
    }
    return ''
  }

  // The pool resolves keychain-stored passwords lazily at connect time.
  pool.passwordResolver = async () => {
    const m = activeMachine()
    return machinePassword(m)
  }

  const applyActiveMachine = async () => {
    const m = activeMachine()
    if (!m || !m.host) return
    const pw = await machinePassword(m)
    applyMachine(config, { ...m, password: pw || m.password || '' })
    pool.setTarget({
      host: config.host, port: config.port, username: config.username,
      password: config.password, privateKeyPath: config.privateKeyPath,
      passphrase: config.passphrase, workspace: config.workspace,
      useAgent: config.useAgent, keyboardInteractive: config.keyboardInteractive,
      proxy: config.proxy, hostKeyMode: config.hostKeyMode,
    })
  }

  const setCurrent = async (id) => {
    const i = machineIndex(id)
    if (i < 0) return false
    store.currentId = id
    ephemeral = null
    saveMachines(machines, id)
    await applyActiveMachine()
    return true
  }

  // If no stored current, adopt a CLI-provided default as the active machine.
  {
    const cur = currentMachine()
    if (cur && cur.host && !store.currentId) applyMachine(config, cur)
  }

  /** Persist the active workspace on the machine the pool is actually bound to
   * (fixes the old bug where a tool-connected machine saved its workspace onto
   * the registry's current machine instead). */
  const persistWorkspace = (p) => {
    config.workspace = p
    const m = activeMachine()
    if (m) {
      if (store.currentId && m.id === store.currentId && machineIndex(m.id) >= 0) {
        const rec = machines[machineIndex(m.id)]
        rec.workspace = p
        rec.recentWorkspaces = [p, ...(rec.recentWorkspaces || []).filter((x) => x !== p)].slice(0, 8)
        saveMachines(machines, store.currentId)
      } else if (ephemeral) {
        ephemeral.workspace = p
      }
    }
  }

  // ── audit log ─────────────────────────────────────────────────────────────
  const audit = (op, cmd, code) => {
    if (!config.auditLog) return
    try {
      const line = [new Date().toISOString(), `${config.username || '?'}@${config.host || '?'}:${config.port}`, op, code == null ? '-' : String(code), String(cmd || '').replace(/\s+/g, ' ').slice(0, 400)].join(' | ') + '\n'
      appendFileSync(auditFile(), line, 'utf8')
    } catch {}
  }
  const readAudit = (limit) => {
    try {
      const text = readFileSync(auditFile(), 'utf8')
      const lines = text.split('\n').filter(Boolean)
      return lines.slice(-Math.max(1, Math.min(Number(limit) || 50, 500)))
    } catch {
      return []
    }
  }

  // ── ignore rules (defaults + user file) ───────────────────────────────────
  const ignoreMatcher = () => {
    try {
      const fromFile = readFileSync(ignoreFile(), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      return compileIgnore(DEFAULT_IGNORE.concat(fromFile))
    } catch {
      return compileIgnore(DEFAULT_IGNORE)
    }
  }

  // ── task + forward managers ───────────────────────────────────────────────
  const tasks = new TaskManager()
  const forwards = new ForwardManager(pool, { file: forwardsFile() })
  pool.onReady = (client) => forwards.attach(client)
  pool.onCloseHook = () => forwards.detach()

  // ── auto-push watcher (config.autoPush, default off) ──────────────────────
  // Watches the local mirror; local edits are pushed back to the remote after a
  // 3s debounce, honoring ignore rules + the three-way conflict guard (a remote
  // change is never clobbered — it is recorded as a conflict in the audit log).
  const autoPushWatchers = new Map() // localDir → { watcher, pending:Set, timer }
  const flushAutoPush = async (localDir) => {
    const entry = autoPushWatchers.get(localDir)
    if (!entry || !entry.pending.size) return
    const rels = [...entry.pending]
    entry.pending.clear()
    const ws = wsPath()
    if (!ws || mirrorDirFor(ws, config.host, config.username, config.port) !== localDir) return
    let sftp
    try { sftp = await pool.sftp() } catch { return }
    const matcher = ignoreMatcher()
    const state = loadSyncState(localDir)
    const next = { ...state }
    if (rels.includes('*')) {
      const r = await pushTree(sftp, localDir, ws, { maxFiles: 500, maxFileBytes: config.maxFileBytes, isIgnored: matcher, state: next })
      Object.assign(next, r.nextState)
      for (const c of r.stats.conflicts) audit('auto-push-conflict', `push ${c.path}`, 1)
    } else {
      for (const rel of rels) {
        const r = await pushOneFile(sftp, localDir, ws, rel, { maxFileBytes: config.maxFileBytes, isIgnored: matcher, state: next })
        if (r.status === 'pushed' && r.state) Object.assign(next, r.state)
        else if (r.status === 'conflict') audit('auto-push-conflict', `push ${rel}`, 1)
      }
    }
    saveSyncState(localDir, next)
  }
  const startAutoPush = (localDir) => {
    if (!config.autoPush || autoPushWatchers.has(localDir)) return
    const entry = { pending: new Set(), timer: null, watcher: null }
    const schedule = () => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => flushAutoPush(localDir), 3000)
    }
    const onEvent = (eventType, filename) => {
      if (!filename) { entry.pending.add('*'); return schedule() }
      const rel = String(filename).replace(/\\/g, '/')
      if (rel === '.dsh-remote-meta.json' || rel === '.dsh-remote-sync-state.json' || rel.startsWith('.dsh-remote-sync-state.json.tmp')) return
      entry.pending.add(rel)
      schedule()
    }
    try {
      entry.watcher = watch(localDir, { recursive: true }, onEvent)
    } catch {
      try { entry.watcher = watch(localDir, onEvent) } catch { return }
    }
    autoPushWatchers.set(localDir, entry)
  }
  ctx.effect(() => () => {
    for (const e of autoPushWatchers.values()) {
      if (e.timer) clearTimeout(e.timer)
      try { e.watcher && e.watcher.close() } catch {}
    }
    autoPushWatchers.clear()
  }, 'dsh-remote.autopush')

  const run = async (cmd, opts = {}) => {
    const res = await pool.exec(cmd, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {})
    const parts = []
    if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''))
    if (res.stderr) parts.push('-- stderr --\n' + res.stderr.replace(/\s+$/, ''))
    if (!parts.length) parts.push('(no output)')
    let text = parts.join('\n')
    if (res.signal === 'TIMEOUT') text += `\n[command timed out after ${opts.timeoutMs ?? config.commandTimeoutMs}ms]`
    else if (res.code !== 0) text += `\n[exit code: ${res.code}]`
    return text
  }

  /** Structured listing: name + type + size + mtime + mode (SFTP protocol-level,
   * works on any remote: POSIX / cmd.exe / PowerShell). */
  const listDirStructured = async (p) => {
    const target = normalizeRemotePath(p || '/')
    let sftp
    try {
      sftp = await pool.sftp()
    } catch (err) {
      throw new Error('browse failed: ' + ((err && err.message) || err))
    }
    let list
    try {
      list = await sftp.readdir(target)
    } catch (err) {
      throw new Error('browse failed: ' + ((err && err.message) || err))
    }
    const items = []
    const symIdx = []
    for (const e of list) {
      const name = String(e.filename)
      if (name === '.' || name === '..' || !name) continue
      const a = e.attrs || {}
      let type
      if (a.isSymbolicLink && a.isSymbolicLink()) {
        type = 'symlink'
        symIdx.push(items.length)
      } else if (a.isDirectory && a.isDirectory()) {
        type = 'dir'
      } else {
        type = 'file'
      }
      items.push({
        type,
        name,
        size: typeof a.size === 'number' ? a.size : 0,
        mtime: typeof a.mtime === 'number' ? a.mtime : 0,
        mode: typeof a.mode === 'number' ? a.mode.toString(8) : '',
      })
    }
    // Resolve symlink-to-dir vs symlink-to-file (bounded, failure-tolerant).
    if (symIdx.length) {
      await Promise.all(symIdx.map(async (i) => {
        const full = joinRemotePath(target, items[i].name)
        try {
          const st = await sftp.lstat(full)
          items[i].type = st && st.isDirectory && st.isDirectory() ? 'dir' : 'file'
        } catch { /* degrade to file */ }
      }))
    }
    return { path: target, items }
  }

  const isRemoteDir = async (p) => {
    const target = normalizeRemotePath(p)
    try {
      const sftp = await pool.sftp()
      const st = await sftp.stat(target)
      return !!(st && st.isDirectory && st.isDirectory())
    } catch {
      return false
    }
  }

  /** Recursive remote delete (bounded): unlink files bottom-up, then rmdir. */
  const removeRemoteTree = async (sftp, p, maxFiles = 2000) => {
    let removed = 0
    const walk = async (dir) => {
      if (removed >= maxFiles) return
      let entries = []
      try { entries = (await sftp.readdir(dir)) || [] } catch { return }
      for (const e of entries) {
        if (removed >= maxFiles) return
        const name = String(e.filename)
        if (name === '.' || name === '..') continue
        const fp = joinRemotePath(dir, name)
        const isDir = !!(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory())
        if (isDir) await walk(fp)
        else {
          try { await sftp.unlink(fp); removed++ } catch {}
        }
      }
      try { await sftp.rmdir(dir); removed++ } catch { /* already gone or non-empty */ }
    }
    await walk(p)
    return removed
  }

  // ── remote workspace state ────────────────────────────────────────────────
  const wsPath = () => (config.workspace || '').trim()
  if (config.autoPush && wsPath()) {
    startAutoPush(mirrorDirFor(wsPath(), config.host, config.username, config.port))
  }
  const status = () => ({
    host: config.host,
    port: config.port,
    username: config.username,
    connected: !!pool.client,
    workspace: wsPath(),
    localMirror: wsPath() ? mirrorDirFor(wsPath(), config.host, config.username, config.port) : '',
    currentId: store.currentId || null,
    activeSource: ephemeral ? 'ephemeral' : (store.currentId ? 'machine' : (config.host ? 'config' : 'none')),
    machines: machines.map(sanitizeMachine),
    hostKeyMode: config.hostKeyMode === 'verify' || config.hostKeyMode === 'off' ? config.hostKeyMode : 'accept-new',
    hostKeyKnown: config.host ? isHostKeyKnown(config.host, config.port) : false,
    forwards: forwards.list(),
    auditEnabled: !!config.auditLog,
    backend: platformBackend(),
  })

  // ── tools ─────────────────────────────────────────────────────────────────

  const textOut = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_a, v) => [{ type: 'text', text: v.text }],
  }
  const okOut = {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, bytes: { type: 'integer' }, text: { type: 'string' } } },
    render: (_a, a) => [{ type: 'text', text: a.text || (a.ok ? 'ok' : 'failed') }],
  }

  const tools = [
    defineTool({
      name: 'rw_info',
      description:
        'Show the remote environment: host/user/port, connection health, current remote workspace path, active port forwards. Call this first to orient, or when an rw_* call fails to check connectivity.',
      parameters: {},
      output: textOut,
      async execute() {
        const s = status()
        const lines = [
          `Remote host: ${s.username || '<user>'}@${s.host || '<host>'}:${s.port}${s.activeSource !== 'machine' ? ` (source: ${s.activeSource})` : ''}`,
          `Current remote workspace: ${s.workspace || '(none — call rw_pick_workspace to set one)'}`,
          `Local mirror: ${s.localMirror || '(none)'}`,
          `Connected: ${s.connected ? 'yes' : 'no'}`,
          `Active forwards: ${s.forwards.filter((f) => f.active).length} / ${s.forwards.length}`,
          `Host key: ${s.hostKeyKnown ? 'trusted' : 'not yet trusted'} (mode=${s.hostKeyMode})`,
          '',
        ]
        if (s.host && s.workspace) {
          try {
            const res = await pool.exec('echo ok', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
            if (res.signal === 'TIMEOUT') lines.push('Ping: timeout')
            else if (res.code === 0) lines.push('Ping: OK — ' + res.stdout.replace(/\s+/g, ' ').trim())
            else lines.push('Ping: FAILED — ' + (res.stderr || res.stdout || `exit ${res.code}`).trim())
          } catch (err) {
            lines.push('Ping: FAILED — ' + friendlyMessage(err, s))
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
        'Connect SSH to a remote host for remote workspace work. Provide host (required), user, optional password or privateKeyPath/port. Defaults to saving the machine to the registry (save=false keeps it as a temporary connection). Once connected, call rw_pick_workspace to pick the workspace directory this session should work in.',
      parameters: {
        host: { type: 'string', required: true, description: 'Remote host IP or hostname' },
        username: { type: 'string', description: 'SSH user (default from config or root)' },
        port: { type: 'integer', description: 'SSH port (default 22)' },
        password: { type: 'string', description: 'SSH password (prefer SSH key when possible)' },
        privateKeyPath: { type: 'string', description: 'Absolute private-key path' },
        save: { type: 'boolean', description: 'Save this machine to the registry and make it current (default true)' },
      },
      output: textOut,
      async execute(args) {
        const host = String(args.host || '').trim()
        if (!host) throw new Error('rw_connect: host is required')
        const user = args.username || config.username || 'root'
        const port = Number(args.port) || undefined
        const rec = {
          host,
          port: port || 22,
          username: user,
          password: args.password !== undefined ? String(args.password) : '',
          privateKeyPath: args.privateKeyPath || '',
        }
        if (args.save !== false) {
          // Upsert into the registry and make it the current machine so the
          // settings UI and the tools always agree on who is active.
          const i = machines.findIndex((m) => m.host === rec.host && m.username === rec.username && Number(m.port) === rec.port)
          if (i >= 0) {
            machines[i] = { ...machines[i], ...rec, id: machines[i].id, password: rec.password || machines[i].password || '' }
            store.currentId = machines[i].id
            saveMachines(machines, store.currentId)
          } else {
            const id = machineId()
            machines.push({ id, name: host, ...rec })
            store.currentId = id
            saveMachines(machines, store.currentId)
          }
          ephemeral = null
          await applyActiveMachine()
        } else {
          ephemeral = { id: machineId(), name: host, ...rec }
          pool.setTarget({
            host, port: port || 22, username: user,
            password: rec.password, privateKeyPath: rec.privateKeyPath,
            workspace: config.workspace,
          })
        }
        try {
          const res = await pool.exec('echo ok', { timeoutMs: 8000 })
          if (res.code !== 0 && !res.stdout) {
            audit('connect', `connect ${user}@${host}:${port || 22}`, res.code)
            return { text: 'connect failed: ' + (res.stderr || 'exit ' + res.code) }
          }
          audit('connect', `connect ${user}@${host}:${port || 22}`, 0)
          return { text: `Connected to ${host} as ${config.username}.\n\npick a workspace with rw_pick_workspace (path=<abs>).` }
        } catch (err) {
          throw new Error(friendlyMessage(err, { host, port }))
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
      output: textOut,
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_pick_workspace: path must be an absolute directory')
        const ok = await isRemoteDir(p)
        if (!ok) return { text: `not a directory (or missing) on ${p}` }
        persistWorkspace(p)
        const local = ensureMirror(p, config.host, config.username, config.port)
        startAutoPush(local)
        return {
          text: `Remote workspace set to ${p} on ${config.username}@${config.host} (saved for this machine).\nLocal mirror (native workspace path): ${local}\n\nRun rw_sync to download its files into the local mirror.`,
        }
      },
    }),

    defineTool({
      name: 'rw_sync',
      description:
        'Download the current remote workspace into its local mirror directory over SFTP (bounded, three-way conflict-aware). Makes the remote files visible/editable locally so the DSH native workspace / fs tools can operate on them. Conflicts (both sides modified) are reported and never overwritten; use force=true to override.',
      parameters: {
        depth: { type: 'integer', description: 'Max directory depth to mirror (default 5)' },
        maxFiles: { type: 'integer', description: 'Max files to download (default 500)' },
        dryRun: { type: 'boolean', description: 'Compute the plan without downloading (default false)' },
        force: { type: 'boolean', description: 'Overwrite conflicting files (default false)' },
        async: { type: 'boolean', description: 'Run in the background and return a task id (default false)' },
      },
      output: textOut,
      async execute(args) {
        const p = wsPath()
        if (!p) throw new Error('rw_sync: no remote workspace set — call rw_pick_workspace first')
        const local = mirrorDirFor(p, config.host, config.username, config.port)
        mkdirSync(local, { recursive: true })
        const depth = Math.min(Math.max(Number(args.depth) || 5, 1), 8)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 500, 1), 2000)
        const isIgnored = ignoreMatcher()
        const body = { depth, maxFiles, dryRun: !!args.dryRun, force: !!args.force, isIgnored }
        const runSync = async () => {
          let sftp
          try {
            sftp = await pool.sftp()
          } catch (err) {
            throw new Error('sftp unavailable: ' + ((err && err.message) || err))
          }
          const state = loadSyncState(local)
          const { stats, nextState } = await syncTree(sftp, p, local, { ...body, state, maxFileBytes: config.maxFileBytes })
          if (!args.dryRun) saveSyncState(local, nextState)
          let text = `${args.dryRun ? 'WOULD download' : 'Downloaded'} ${stats.files} file(s) from ${p} → ${local}${stats.files >= maxFiles ? ' (hit download cap)' : ''}.`
          if (stats.skippedUnchanged) text += ` ${stats.skippedUnchanged} unchanged.`
          if (stats.skippedLarge) text += ` ${stats.skippedLarge} too large (over ${config.maxFileBytes} bytes).`
          if (stats.staleRemote) text += ` ${stats.staleRemote} remote entries gone (kept locally; use rw_push to mirror deletions).`
          if (stats.conflicts.length) {
            text += `\n⚠ ${stats.conflicts.length} conflict(s), NOT overwritten:`
            for (const c of stats.conflicts.slice(0, 10)) text += `\n  ${c.path} — ${c.reason}`
            if (stats.conflicts.length > 10) text += `\n  … and ${stats.conflicts.length - 10} more`
            text += '\n(use force=true to override)'
          }
          return { text }
        }
        if (args.async) {
          const t = tasks.start('sync', `sync ${p}`, runSync)
          return { text: `sync started in background: taskId=${t.id} (GET /dsh-remote/task?id=${t.id} for progress)` }
        }
        return runSync()
      },
    }),

    defineTool({
      name: 'rw_push',
      description:
        'Upload the local mirror of the current remote workspace back to the remote host over SFTP (bounded, three-way conflict-aware). Use after editing files in the local mirror so the remote reflects your changes. Conflicts (both sides modified) are reported and never overwritten; use force=true to override.',
      parameters: {
        maxFiles: { type: 'integer', description: 'Max files to upload (default 500)' },
        dryRun: { type: 'boolean', description: 'Compute the plan without uploading (default false)' },
        force: { type: 'boolean', description: 'Overwrite conflicting files (default false)' },
        async: { type: 'boolean', description: 'Run in the background and return a task id (default false)' },
      },
      output: textOut,
      async execute(args) {
        const p = wsPath()
        if (!p) throw new Error('rw_push: no remote workspace set — call rw_pick_workspace first')
        const local = mirrorDirFor(p, config.host, config.username, config.port)
        if (!existsSync(local)) throw new Error(`rw_push: local mirror does not exist — run rw_sync first (${local})`)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 500, 1), 2000)
        const isIgnored = ignoreMatcher()
        const body = { maxFiles, dryRun: !!args.dryRun, force: !!args.force, isIgnored }
        const runPush = async () => {
          let sftp
          try {
            sftp = await pool.sftp()
          } catch (err) {
            throw new Error('sftp unavailable: ' + ((err && err.message) || err))
          }
          const state = loadSyncState(local)
          const { stats, nextState } = await pushTree(sftp, local, p, { ...body, state, maxFileBytes: config.maxFileBytes })
          if (!args.dryRun) saveSyncState(local, nextState)
          let text = `${args.dryRun ? 'WOULD upload' : 'Uploaded'} ${stats.files} file(s) from ${local} → ${p}.`
          if (stats.skippedUnchanged) text += ` ${stats.skippedUnchanged} unchanged.`
          if (stats.skippedLarge) text += ` ${stats.skippedLarge} too large (over ${config.maxFileBytes} bytes).`
          if (stats.staleLocal) text += ` ${stats.staleLocal} local entries gone remotely (kept remotely; use rw_remove to mirror deletions).`
          if (stats.conflicts.length) {
            text += `\n⚠ ${stats.conflicts.length} conflict(s), NOT overwritten:`
            for (const c of stats.conflicts.slice(0, 10)) text += `\n  ${c.path} — ${c.reason}`
            if (stats.conflicts.length > 10) text += `\n  … and ${stats.conflicts.length - 10} more`
            text += '\n(use force=true to override)'
          }
          return { text }
        }
        if (args.async) {
          const t = tasks.start('push', `push ${p}`, runPush)
          return { text: `push started in background: taskId=${t.id} (GET /dsh-remote/task?id=${t.id} for progress)` }
        }
        return runPush()
      },
    }),

    defineTool({
      name: 'rw_list_dir',
      description:
        'List a remote directory (or a single file) via SSH. Path is absolute; if omitted, lists the current remote workspace. Shows type, size, mtime.',
      parameters: {
        path: { type: 'string', description: 'Absolute remote path (default: current remote workspace)' },
      },
      output: textOut,
      async execute(args) {
        const p = args.path ? normalizeRemotePath(String(args.path)) : wsPath()
        if (!p) throw new Error('rw_list_dir: no path and no remote workspace set')
        let list
        try {
          const sftp = await pool.sftp()
          list = await sftp.readdir(p)
        } catch (err) {
          throw new Error('rw_list_dir: ' + ((err && err.message) || err))
        }
        const fmtMtime = (t) => {
          if (!t) return '?'
          const d = new Date(t * 1000)
          const pad = (n) => String(n).padStart(2, '0')
          return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
        }
        const lines = list
          .filter((e) => String(e.filename) !== '.' && String(e.filename) !== '..')
          .map((e) => {
            const a = e.attrs || {}
            const type = a.isDirectory && a.isDirectory() ? 'd' : (a.isSymbolicLink && a.isSymbolicLink() ? 'l' : '-')
            const size = typeof a.size === 'number' ? String(a.size) : '?'
            return `${type} ${size.padStart(10)} ${fmtMtime(a.mtime).padEnd(17)} ${String(e.filename)}`
          })
        return { text: lines.length ? lines.join('\n') : '(empty directory)' }
      },
    }),

    defineTool({
      name: 'rw_stat',
      description:
        'Show detailed stat of a remote file or directory: type, size, mtime, mode (SFTP attrs). Use to verify a remote path exists or to compare files.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote path' },
      },
      output: textOut,
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p) throw new Error('rw_stat: path is required')
        const sftp = await pool.sftp()
        let st
        try {
          st = await sftp.stat(p)
        } catch (err) {
          throw new Error('rw_stat: not found or unreadable: ' + ((err && err.message) || err))
        }
        const type = st.isDirectory && st.isDirectory() ? 'directory' : (st.isSymbolicLink && st.isSymbolicLink() ? 'symlink' : 'file')
        const lines = [
          `path: ${p}`,
          `type: ${type}`,
          `size: ${st.size} bytes`,
          `mtime: ${new Date(st.mtime * 1000).toISOString()}`,
          `mode: ${typeof st.mode === 'number' ? st.mode.toString(8) : '?'}`,
        ]
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'rw_read_file',
      description:
        'Read a text file on the remote host with line numbers. Supports paging with startLine/endLine and an encoding param (utf-8 default, gbk etc). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        startLine: { type: 'integer', description: '1-based first line (default 1)' },
        endLine: { type: 'integer', description: '1-based last line (inclusive)' },
        maxLines: { type: 'integer', description: 'Max lines (default 2000)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: textOut,
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p) throw new Error('rw_read_file: path is required')
        const maxLines = Math.min(Math.max(Number(args.maxLines) || 2000, 1), 10000)
        let from = Math.max(Number(args.startLine) || 1, 1)
        let to = Number(args.endLine) || 0
        if (!to || to - from + 1 > maxLines) to = from + maxLines - 1
        const sftp = await pool.sftp()
        let st
        try { st = await sftp.stat(p) } catch (err) { throw new Error('rw_read_file: ' + ((err && err.message) || err)) }
        if (config.maxFileBytes > 0 && st.size > config.maxFileBytes) {
          throw new Error(`rw_read_file: file is ${st.size} bytes (over ${config.maxFileBytes} cap); use rw_download or rw_exec to read it`)
        }
        let buf
        try {
          buf = await sftp.readFile(p)
        } catch (err) {
          throw new Error('rw_read_file: ' + ((err && err.message) || err))
        }
        const content = decodeBuf(buf, args.encoding || config.encoding).replace(/\r\n/g, '\n')
        const allLines = content.split('\n')
        const page = allLines.slice(from - 1, to)
        const numbered = page.map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n').replace(/\s+$/, '')
        let text = numbered === '' ? '(empty or out of range)' : numbered
        if (!args.endLine) text += '\n(shown up to ' + maxLines + ' lines; use startLine/endLine to page)'
        return { text }
      },
    }),

    defineTool({
      name: 'rw_write_file',
      description:
        'Write text to a file on the remote host (creating parent directories if needed). Path is absolute. Use this to create or overwrite a remote file directly, instead of round-tripping through a local mirror.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        content: { type: 'string', required: true, description: 'File content to write (overwrites existing file)' },
        mkdir: { type: 'boolean', description: 'Create missing parent directories (default true)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_write_file: a file path is required')
        const content = String(args.content == null ? '' : args.content)
        const sftp = await pool.sftp()
        if (args.mkdir !== false) await mkdirRemoteDirs(sftp, remoteDirname(p))
        const buf = encodeText(content, args.encoding || config.encoding)
        await sftp.writeFile(p, buf)
        const bytes = buf.byteLength
        audit('write_file', `write ${p} (${bytes}B)`, 0)
        return { ok: true, bytes, text: `wrote ${bytes} bytes to ${p}` }
      },
    }),

    defineTool({
      name: 'rw_edit',
      description:
        'Edit a remote text file by replacing literal text (read-modify-write with an mtime optimistic lock: aborts if the file changed on the remote between read and write). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        old: { type: 'string', required: true, description: 'Literal text to replace (must appear exactly once unless count is given)' },
        new: { type: 'string', required: true, description: 'Replacement text' },
        count: { type: 'integer', description: 'How many occurrences to replace (default: error if the text appears more than once)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_edit: a file path is required')
        const oldS = String(args.old ?? '')
        const newS = String(args.new ?? '')
        if (oldS === '') throw new Error('rw_edit: old text must not be empty')
        const sftp = await pool.sftp()
        const st0 = await sftp.stat(p)
        const buf = await sftp.readFile(p)
        const content = decodeBuf(buf, args.encoding || config.encoding)
        const count = args.count == null ? 0 : Math.max(Number(args.count) || 1, 1)
        const idxs = []
        let from = 0
        let hit
        while ((hit = content.indexOf(oldS, from)) !== -1) { idxs.push(hit); from = hit + oldS.length }
        if (!idxs.length) throw new Error(`rw_edit: old text not found in ${p}`)
        if (count === 0 && idxs.length > 1) {
          throw new Error(`rw_edit: "old" appears ${idxs.length} times in ${p} — pass count=<n> to pick how many to replace`)
        }
        const n = count === 0 ? 1 : Math.min(count, idxs.length)
        let out = content
        for (let i = n - 1; i >= 0; i--) {
          out = out.slice(0, idxs[i]) + newS + out.slice(idxs[i] + oldS.length)
        }
        // Optimistic lock: the remote must not have changed since we read it.
        const st1 = await sftp.stat(p)
        if (st1.size !== st0.size || st1.mtime !== st0.mtime) {
          throw new Error(`rw_edit: ${p} changed on the remote while editing (conflict) — re-read and retry`)
        }
        await sftp.writeFile(p, encodeText(out, args.encoding || config.encoding))
        audit('edit', `edit ${p} (${n} occurrence(s))`, 0)
        return { ok: true, bytes: Buffer.byteLength(out), text: `edited ${p}: replaced ${n} occurrence(s)` }
      },
    }),

    defineTool({
      name: 'rw_append',
      description:
        'Append text to a remote file (creates it when missing). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        content: { type: 'string', required: true, description: 'Text to append' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_append: a file path is required')
        const sftp = await pool.sftp()
        let existing = ''
        try { existing = decodeBuf(await sftp.readFile(p), args.encoding || config.encoding) } catch { /* new file */ }
        const content = existing + String(args.content ?? '')
        await sftp.writeFile(p, encodeText(content, args.encoding || config.encoding))
        const bytes = Buffer.byteLength(content)
        audit('append', `append ${p}`, 0)
        return { ok: true, bytes, text: `appended to ${p} (now ${bytes} bytes)` }
      },
    }),

    defineTool({
      name: 'rw_mkdir',
      description:
        'Create a remote directory (mkdir -p semantics, all levels). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote directory path' },
      },
      output: textOut,
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_mkdir: a directory path is required')
        const sftp = await pool.sftp()
        await mkdirRemoteDirs(sftp, p)
        audit('mkdir', `mkdir ${p}`, 0)
        return { text: `created ${p}` }
      },
    }),

    defineTool({
      name: 'rw_remove',
      description:
        'Delete a remote file (or an empty directory). recursive=true removes a directory tree (bounded). Path is absolute. This is destructive — the agent should confirm intent before calling.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote path to delete' },
        recursive: { type: 'boolean', description: 'Recursively delete a directory (default false)' },
      },
      output: okOut,
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_remove: a path is required')
        const sftp = await pool.sftp()
        const st = await sftp.stat(p).catch(() => null)
        if (!st) return { ok: false, text: `not found: ${p}` }
        if (st.isDirectory && st.isDirectory()) {
          if (!args.recursive) throw new Error(`rw_remove: ${p} is a directory — pass recursive=true to delete its tree`)
          const removed = await removeRemoteTree(sftp, p)
          audit('remove', `remove -r ${p}`, 0)
          return { ok: true, text: `removed ${removed} entries under ${p}` }
        }
        await sftp.unlink(p)
        audit('remove', `remove ${p}`, 0)
        return { ok: true, text: `removed ${p}` }
      },
    }),

    defineTool({
      name: 'rw_move',
      description:
        'Rename or move a remote file/directory (SFTP rename, same filesystem). Paths are absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Current absolute remote path' },
        dest: { type: 'string', required: true, description: 'Destination absolute remote path' },
      },
      output: textOut,
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        const d = normalizeRemotePath(String(args.dest || ''))
        if (!p || !d || p === '/') throw new Error('rw_move: both path and dest are required')
        const sftp = await pool.sftp()
        await mkdirRemoteDirs(sftp, remoteDirname(d))
        await sftp.rename(p, d)
        audit('move', `move ${p} → ${d}`, 0)
        return { text: `moved ${p} → ${d}` }
      },
    }),

    defineTool({
      name: 'rw_exec',
      description:
        'Run a shell command on the remote host. Use for anything that is not reading a file (build, test, grep, etc). Output is capped. Runs in the current remote workspace by default; pass cwd to run elsewhere. pty=true helps interactive commands (sudo prompts, REPLs); env sets environment variables.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command (run on the remote host)' },
        cwd: { type: 'string', description: 'Working directory for the command (default: the current remote workspace)' },
        pty: { type: 'boolean', description: 'Allocate a pseudo-terminal (interactive commands, default false)' },
        env: { type: 'object', additionalProperties: true, description: 'Extra environment variables (string values)' },
      },
      output: textOut,
      async execute(args) {
        const cmd = String(args.command || '')
        if (!cmd) throw new Error('rw_exec: command is required')
        const ws = wsPath()
        const cwd = args.cwd ? normalizeRemotePath(String(args.cwd)) : (ws || '')
        const full = cwd && !cwd.includes('\\') ? `cd ${shq(cwd)} && ${cmd}` : cmd
        try {
          const res = await pool.exec(full, { timeoutMs: config.commandTimeoutMs, pty: !!args.pty, env: args.env })
          audit('exec', cmd, res.code)
          const parts = []
          if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''))
          if (res.stderr) parts.push('-- stderr --\n' + res.stderr.replace(/\s+$/, ''))
          if (!parts.length) parts.push('(no output)')
          let text = parts.join('\n')
          if (res.signal === 'TIMEOUT') text += `\n[command timed out after ${config.commandTimeoutMs}ms]`
          else if (res.code !== 0) text += `\n[exit code: ${res.code}]`
          return { text }
        } catch (err) {
          throw new Error(friendlyMessage(err, { host: config.host, port: config.port }))
        }
      },
    }),

    defineTool({
      name: 'rw_search',
      description:
        'Search remote files for a pattern (recursive SFTP walk — works on ANY remote including Windows, honors ignore rules). Returns matching file:line rows; output is capped.',
      parameters: {
        pattern: { type: 'string', required: true, description: 'Pattern to search for (extended regex)' },
        path: { type: 'string', description: 'Directory to search (default: current remote workspace)' },
        glob: { type: 'string', description: 'Only files whose NAME matches this glob, e.g. *.ts (optional)' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default true)' },
        contextLines: { type: 'integer', description: 'Lines of context around each match (default 0)' },
        maxMatches: { type: 'integer', description: 'Max matches to return (default 500)' },
      },
      output: textOut,
      async execute(args) {
        const pattern = String(args.pattern || '')
        if (!pattern) throw new Error('rw_search: pattern is required')
        const ws = wsPath()
        const dir = args.path ? normalizeRemotePath(String(args.path)) : (ws || '')
        if (!dir) throw new Error('rw_search: no path and no remote workspace set')
        let regex
        try {
          regex = new RegExp(pattern, args.ignoreCase === false ? '' : 'i')
        } catch (err) {
          throw new Error('rw_search: bad pattern: ' + ((err && err.message) || err))
        }
        const sftp = await pool.sftp()
        const maxMatches = Math.min(Math.max(Number(args.maxMatches) || 500, 1), 2000)
        const matcher = ignoreMatcher()
        const { matches, scanned, truncated } = await searchTree(sftp, dir, {
          regex,
          glob: args.glob,
          contextLines: Math.min(Math.max(Number(args.contextLines) || 0, 0), 10),
          maxMatches,
          maxScanBytes: Math.min(config.maxFileBytes || 1024 * 1024, 1024 * 1024),
          isIgnored: (name, isDir) => matcher(name, isDir),
        })
        if (!matches.length) return { text: `no matches for /${pattern}/ in ${dir} (${scanned} files scanned)` }
        let text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n')
        text += `\n(${matches.length} match(es), ${scanned} files scanned${truncated ? ', TRUNCATED' : ''})`
        return { text: truncate(text, config.maxOutputChars) }
      },
    }),

    defineTool({
      name: 'rw_download',
      description:
        'Download a single remote file over SFTP into the local mirror of the current workspace (or to an explicit local path). Use when you need the actual file content locally, not just its text. Streams to disk (fastGet).',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        localPath: { type: 'string', description: 'Local destination (default: the workspace mirror, preserving the relative path)' },
      },
      output: okOut,
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_download: a remote file path is required')
        const sftp = await pool.sftp()
        let local
        if (args.localPath) {
          local = path.resolve(String(args.localPath))
        } else {
          const ws = wsPath()
          if (!ws) throw new Error('rw_download: no remote workspace set — pass localPath explicitly')
          const base = mirrorDirFor(ws, config.host, config.username, config.port)
          const rel = p.startsWith(ws) ? p.slice(ws.length).replace(/^\/+/, '') : p.slice(1)
          local = path.join(base, rel)
        }
        mkdirSync(path.dirname(local), { recursive: true })
        const st = await sftp.stat(p).catch(() => null)
        if (config.maxFileBytes > 0 && st && st.size > config.maxFileBytes) {
          throw new Error(`rw_download: file is ${st.size} bytes (over ${config.maxFileBytes} cap)`)
        }
        await sftp.fastGet(p, local)
        const bytes = existsSync(local) ? statSync(local).size : 0
        return { ok: true, bytes, text: `downloaded ${bytes} bytes from ${p} → ${local}` }
      },
    }),

    defineTool({
      name: 'rw_upload',
      description:
        'Upload a local file over SFTP to a path on the remote host (creating parent directories if needed). Use to push a local file directly, without a full rw_push of the whole mirror.',
      parameters: {
        localPath: { type: 'string', required: true, description: 'Absolute local file path' },
        path: { type: 'string', required: true, description: 'Absolute remote destination path' },
      },
      output: okOut,
      async execute(args) {
        const rp = normalizeRemotePath(String(args.path || ''))
        const lp = String(args.localPath || '')
        if (!rp || rp === '/' || !lp) throw new Error('rw_upload: both localPath and a remote path are required')
        if (!existsSync(lp)) throw new Error(`rw_upload: local file not found: ${lp}`)
        const sftp = await pool.sftp()
        await mkdirRemoteDirs(sftp, remoteDirname(rp))
        const st = statSync(lp)
        await sftp.fastPut(rp, lp)
        audit('upload', `upload ${lp} → ${rp}`, 0)
        return { ok: true, bytes: st.size, text: `uploaded ${st.size} bytes from ${lp} → ${rp}` }
      },
    }),

    defineTool({
      name: 'rw_forward',
      description:
        'Manage SSH port forwards. Direction "local" listens on 127.0.0.1:<listenPort> on THIS machine and forwards connections through SSH to <targetHost>:<targetPort> on the remote. Direction "reverse" asks the REMOTE to listen on 127.0.0.1:<listenPort> and pipes connections back to <targetHost>:<targetPort> on this machine. Call with a listenPort to create+start; with remove=true to delete.',
      parameters: {
        listenPort: { type: 'integer', required: true, description: 'Port to listen on (local for direction=local, remote for direction=reverse)' },
        targetHost: { type: 'string', description: 'Forward target host (default 127.0.0.1)' },
        targetPort: { type: 'integer', description: 'Forward target port (default: same as listenPort)' },
        direction: { type: 'string', description: 'local (default) or reverse' },
        autoStart: { type: 'boolean', description: 'Restart this forward automatically on future connects (default false)' },
        remove: { type: 'boolean', description: 'Remove an existing forward by listenPort (default false)' },
      },
      output: textOut,
      async execute(args) {
        const port = Number(args.listenPort)
        if (!port || port < 1 || port > 65535) throw new Error('rw_forward: a valid listenPort is required')
        const dir = args.direction === 'reverse' ? 'reverse' : 'local'
        const existing = forwards.list().find((f) => Number(f.listenPort) === port && f.direction === dir)
        if (args.remove) {
          if (!existing) return { text: `no forward on port ${port} to remove` }
          forwards.remove(existing.id)
          return { text: `removed ${existing.direction} forward on port ${port}` }
        }
        if (existing && existing.active) return { text: `already active: ${existing.direction} forward 127.0.0.1:${port} → ${existing.targetHost}:${existing.targetPort}` }
        const d = existing || forwards.define({
          direction: dir,
          listenPort: port,
          targetHost: args.targetHost || '127.0.0.1',
          targetPort: Number(args.targetPort) || port,
          autoStart: !!args.autoStart,
          machineId: store.currentId,
        })
        const r = await forwards.start(d)
        audit('forward', `${d.direction} forward ${port} → ${d.targetHost}:${d.targetPort}`, r.ok ? 0 : 1)
        if (!r.ok) throw new Error(r.error)
        return { text: `${d.direction} forward active: 127.0.0.1:${port} → ${d.targetHost}:${d.targetPort} (id=${d.id})` }
      },
    }),

    defineTool({
      name: 'rw_disconnect',
      description:
        'Close the current SSH connection to the remote host, releasing the persistent pool (and stopping all active port forwards). Useful to rotate connections or after a long idle.',
      parameters: {},
      output: okOut,
      async execute() {
        pool.close()
        return { ok: true, text: 'disconnected (forwards stopped)' }
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
      const fwd = forwards.list().filter((f) => f.active).map((f) => `${f.direction}:127.0.0.1:${f.listenPort}→${f.targetHost}:${f.targetPort}`)
      let extra = ''
      if (fwd.length) extra = `\nActive port forwards: ${fwd.join(', ')}`
      return (
        '## Remote workspace\n' +
        `Current remote workspace: ${config.username}@${config.host}:${w}\n` +
        'Use the rw_* tools (rw_list_dir / rw_read_file / rw_write_file / rw_edit / rw_exec / rw_search / rw_sync / rw_push) to inspect and act on files on the remote host. Treat this directory as the working root for this task.' +
        extra
      )
    },
  })

  // ── slash commands ─────────────────────────────────────────────────────────
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'remote',
      description: 'Show the current remote workspace / connection status, active forwards, and how to use remote tools.',
      handler: (invocation) => {
        const s = status()
        const fwd = s.forwards.filter((f) => f.active)
        return {
          kind: 'success',
          text:
            `Remote host: ${s.username}@${s.host || '<none>'} (connected: ${s.connected}, source: ${s.activeSource})\n` +
            `Remote workspace: ${s.workspace || '(none)'}\n` +
            `Host key: ${s.hostKeyKnown ? 'trusted ✓' : 'not yet trusted'} (mode=${s.hostKeyMode})\n` +
            (s.hostKeyKnown ? `  — if the key changed / was mistrusted, run /remote-forget-key\n` : '') +
            (fwd.length ? `Active forwards:\n${fwd.map((f) => `  ${f.direction} 127.0.0.1:${f.listenPort} → ${f.targetHost}:${f.targetPort}`).join('\n')}\n` : '') +
            `\nUse tools: rw_list_dir / rw_read_file / rw_edit / rw_exec / rw_search / rw_forward.` +
            (s.workspace ? `\nCurrently working in ${s.workspace}.` : ''),
        }
      },
    })
    commands.register({
      name: 'remote-forget-key',
      description: 'Drop the trusted host-key record for the current machine so the next connect re-records it.',
      handler: () => {
        createHostKeyGuard(config).forgetHost()
        return { kind: 'success', text: `forgot host key for ${config.host || '<none>'}:${config.port} — the next connect will re-record it.` }
      },
    })
    commands.register({
      name: 'remote-ignore',
      description: 'Show the mirror ignore rules file location and the current default patterns (gitignore syntax).',
      handler: () => {
        return {
          kind: 'success',
          text:
            `Ignore file: ${ignoreFile()}\n(defaults merged with the file; gitignore syntax, '#' comments)\n\nDefault patterns:\n${DEFAULT_IGNORE.map((p) => '  ' + p).join('\n')}`,
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
  const MAX_BODY_BYTES = 1024 * 1024
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      let total = 0
      req.on('data', (c) => {
        total += c.length
        if (total > MAX_BODY_BYTES) {
          req.removeAllListeners('data')
          resolve('{}')
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(chunks.join('')))
    })

  // ── 本机目录选择器：DSH directoryPicker 服务优先，缺位/非原生则自持兜底 ──
  const PICK_TIMEOUT_MS = 120000
  const runPick = (bin, args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: PICK_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (err) {
          const code = err.code
          const msg = String(stderr || '')
          if (code === 1 && /(?:user canceled|-128)/i.test(msg)) return resolve({ cancelled: true })
          if (err.signal || err.killed) return reject(new Error('目录选择已超时，请重试或直接在输入框填本地路径'))
          if (code === 'ENOENT') return reject(Object.assign(new Error('未找到目录选择器程序 ' + bin), { code }))
          return reject(new Error((msg.trim() || (err && err.message) || '无法打开系统文件夹选择器').split('\n')[0]))
        }
        const p = String(stdout || '').replace(/[\r\n]+$/, '').trim()
        resolve(p === 'CANCELED' ? { cancelled: true } : (p ? { path: p } : { cancelled: true }))
      })
    })
  const pickLocalNative = async () => {
    const platform = process.platform
    if (platform === 'darwin') {
      return runPick('osascript', ['-e', 'set selectedFolder to choose folder with prompt "Select Workspace Directory"', '-e', 'POSIX path of selectedFolder'])
    }
    if (platform === 'linux') {
      try {
        return await runPick('zenity', ['--file-selection', '--directory', '--title=Select Workspace Directory'])
      } catch (err) {
        if (err && err.code === 'ENOENT') return runPick('kdialog', ['--getexistingdirectory', '.', '--title', 'Select Workspace Directory'])
        throw err
      }
    }
    if (platform === 'win32') {
      const script =
        `Add-Type -AssemblyName System.Windows.Forms;` +
        `$f = New-Object System.Windows.Forms.FolderBrowserDialog;` +
        `$f.Description = 'Select Workspace Directory';` +
        `if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath } else { 'CANCELED' }`
      return runPick('powershell', ['-NoProfile', '-STA', '-Command', script])
    }
    throw new Error('当前系统不支持自动打开目录选择器，请在输入框直接填本地路径')
  }

  /** The ctx.directoryPicker capability object, or null when the service is
   * absent/unusable. Never throws — callers fall through to pickLocalNative. */
  const localPickCapability = async () => {
    const dp = (ctx && typeof ctx.get === 'function') ? (ctx.get('directoryPicker') || null) : null
    if (!dp || typeof dp.capability !== 'function') return null
    try {
      return await Promise.resolve(dp.capability())
    } catch {
      return null
    }
  }

  // ── route helpers ─────────────────────────────────────────────────────────
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
      // Map a LOCAL path (typically a session cwd that sits inside a remote
      // mirror dir) to the remote path it mirrors, by reading each mirror
      // dir's .dsh-remote-meta.json. Falls back to the machine workspace so
      // the sidebar still shows something sensible for non-mirror cwds.
      // Accepts either ?local=<abs path> or ?sessionId=<id> (resolved via
      // the host sessions service header.cwd).
      kind: 'exact',
      path: '/dsh-remote/resolve-mirror',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          let local = q.get('local') ? decodeURIComponent(q.get('local')) : ''
          const sessionId = q.get('sessionId') ? decodeURIComponent(q.get('sessionId')) : ''
          let resolvedVia = 'query'
          if (!local && sessionId) {
            // 1) Live in-memory session header (active sessions only).
            try {
              const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
              const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
              const header = session && session.header ? session.header : null
              if (header && header.cwd) {
                local = String(header.cwd)
                resolvedVia = 'session'
              }
            } catch { /* sessions service unavailable */ }
            // 2) Durable session log header (works for historical sessions too):
            //    walk $DSH_HOME/sessions/<projectKey>/<sessionId>/session.jsonl.zstd
            //    and read the header line (first zstd frame) for cwd.
            if (!local) {
              try {
                const sessionsRoot = path.join(dshBase(), 'sessions')
                if (existsSync(sessionsRoot)) {
                  const targetDir = encodeSegmentSafe(sessionId)
                  for (const projDir of readdirSync(sessionsRoot)) {
                    const projPath = path.join(sessionsRoot, projDir)
                    if (!statSync(projPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
                    const sessDir = path.join(projPath, targetDir)
                    if (!statSync(sessDir, { throwIfNoEntry: false })?.isDirectory?.()) continue
                    const logFile = ['session.jsonl.zstd', 'session.jsonl', 'session.jsonl.gz'].map((n) => path.join(sessDir, n)).find((p) => existsSync(p))
                    if (!logFile) continue
                    const cwd = readSessionHeaderCwd(logFile)
                    if (cwd) {
                      local = cwd
                      resolvedVia = 'session-log'
                      break
                    }
                  }
                }
              } catch { /* session log scan failed */ }
            }
          }
          const remote = status().workspace || ''
          const root = remoteWorkspacesRoot()
          const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '') || ''
          let matched = ''
          let matchedRemote = ''
          if (local && existsSync(root)) {
            const base = norm(local)
            for (const hostDir of readdirSync(root)) {
              const hostPath = path.join(root, hostDir)
              if (!statSync(hostPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
              for (const mirrorDir of readdirSync(hostPath)) {
                const metaPath = path.join(hostPath, mirrorDir, '.dsh-remote-meta.json')
                if (!existsSync(metaPath)) continue
                try {
                  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
                  const mirrorAbs = norm(path.join(hostPath, mirrorDir))
                  // Exact mirror dir match, or the local path is inside the mirror dir.
                  if (mirrorAbs === base || base.startsWith(mirrorAbs + path.sep) || base.startsWith(mirrorAbs + '/')) {
                    if (mirrorAbs.length > matched.length) {
                      matched = mirrorAbs
                      matchedRemote = String(meta.remotePath || '')
                    }
                  }
                } catch { /* skip unparsable meta */ }
              }
            }
          }
          const remotePath = matchedRemote || remote
          return sendJson(res, 200, { local, remotePath, mirrorDir: matched || null, fallback: !matchedRemote, resolvedVia })
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) })
        }
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
          await pool.exec('echo ok', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
          return sendJson(res, 200, { ok: true, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: friendlyMessage(err, { host: payload && payload.host, port: payload && payload.port }) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/ls',
      handler: async (req, res) => {
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          const p = q.get('path') ? decodeURIComponent(q.get('path')) : wsPath()
          const out = await listDirStructured(p || '/')
          return sendJson(res, 200, { path: out.path, items: out.items })
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      // Read a remote file over SFTP (live). Text returns as content (CRLF→LF,
      // encoding-aware), binary is reported with size+head (base64). A stat
      // happens first; oversized files are previewed from a streamed head chunk
      // instead of being fully buffered.
      kind: 'exact',
      path: '/dsh-remote/read',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          let p = q.get('path') ? decodeURIComponent(q.get('path')) : ''
          let encoding = ''
          let maxBytes = 256 * 1024
          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}')
            if (!p) p = String(body.path || '')
            if (body.encoding) encoding = String(body.encoding)
            if (body.maxBytes) maxBytes = Number(body.maxBytes)
          }
          if (q.get('maxBytes')) maxBytes = Number(q.get('maxBytes'))
          if (!p) return sendJson(res, 400, { ok: false, error: 'path is required' })
          const target = normalizeRemotePath(p)
          maxBytes = Math.min(Math.max(Number(maxBytes) || 256 * 1024, 1024), 2 * 1024 * 1024)
          let sftp
          try {
            sftp = await pool.sftp()
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: 'sftp unavailable: ' + ((err && err.message) || err) })
          }
          let st
          try { st = await sftp.stat(target) } catch (err) {
            return sendJson(res, 500, { ok: false, error: 'read failed: ' + ((err && err.message) || err) })
          }
          if (st.size > maxBytes) {
            // Head preview for oversized files: fastGet to a temp file, read the
            // first maxBytes, delete the temp. Never buffers the whole file.
            const tmp = path.join(dshBase(), '.dsh-remote-preview-' + process.pid)
            try {
              await sftp.fastGet(target, tmp)
              const { open } = await import('node:fs/promises')
              const fd = await open(tmp, 'r')
              const head = Buffer.alloc(Math.min(maxBytes, st.size))
              await fd.read(head, 0, head.length, 0)
              await fd.close()
              try { unlinkSync(tmp) } catch {}
              const content = decodeBuf(head, encoding || config.encoding).replace(/\r\n/g, '\n')
              return sendJson(res, 200, { ok: true, binary: false, content, truncated: true, size: st.size })
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: 'read failed: ' + ((err && err.message) || err) })
            }
          }
          let buf
          try {
            buf = await sftp.readFile(target)
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: 'read failed: ' + ((err && err.message) || err) })
          }
          const headN = Math.min(buf.length, 8192)
          let binary = false
          for (let i = 0; i < headN; i++) {
            if (buf[i] === 0) { binary = true; break }
          }
          if (binary) {
            return sendJson(res, 200, { ok: true, binary: true, size: buf.length, head: buf.slice(0, Math.min(buf.length, 4096)).toString('base64') })
          }
          let content = decodeBuf(buf, encoding || config.encoding).replace(/\r\n/g, '\n')
          const truncated = content.length > maxBytes
          if (truncated) content = content.slice(0, maxBytes) + `\n…[truncated: ${buf.length - maxBytes} more bytes]`
          return sendJson(res, 200, { ok: true, binary: false, content, truncated })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      // Write a remote file (sidebar editor save). `expectedMtime` is an
      // optimistic lock: a 409 is returned when the remote changed meanwhile.
      kind: 'exact',
      path: '/dsh-remote/write',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const p = normalizeRemotePath(String(body.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path is required' })
          const sftp = await pool.sftp()
          let st = null
          try { st = await sftp.stat(p) } catch { /* new file */ }
          if (body.expectedMtime != null && st && st.mtime !== Number(body.expectedMtime)) {
            return sendJson(res, 409, { ok: false, error: `远端文件已变化（mtime ${st.mtime} ≠ ${body.expectedMtime}），已放弃保存——请重新读取后再编辑` })
          }
          const buf = encodeText(String(body.content ?? ''), body.encoding || config.encoding)
          if (!st) await mkdirRemoteDirs(sftp, remoteDirname(p))
          await sftp.writeFile(p, buf)
          audit('write', `write ${p}`, 0)
          const st2 = await sftp.stat(p).catch(() => null)
          return sendJson(res, 200, { ok: true, bytes: buf.byteLength, mtime: st2 ? st2.mtime : Math.floor(Date.now() / 1000) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      // Generic remote fs ops used by the sidebar context menu + picker:
      // mkdir / rename / remove (recursive) / write / append.
      kind: 'exact',
      path: '/dsh-remote/fs',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const op = String(body.op || '')
          const sftp = await pool.sftp()
          if (op === 'mkdir') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            await mkdirRemoteDirs(sftp, p)
            audit('mkdir', `mkdir ${p}`, 0)
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'rename') {
            const p = normalizeRemotePath(String(body.path || ''))
            const d = normalizeRemotePath(String(body.dest || ''))
            if (!p || !d) return sendJson(res, 400, { ok: false, error: 'path and dest required' })
            await sftp.rename(p, d)
            audit('move', `move ${p} → ${d}`, 0)
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'remove') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            const st = await sftp.stat(p).catch(() => null)
            if (!st) return sendJson(res, 404, { ok: false, error: 'not found' })
            if (st.isDirectory && st.isDirectory()) {
              await removeRemoteTree(sftp, p)
            } else {
              await sftp.unlink(p)
            }
            audit('remove', `remove ${p}`, 0)
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'write' || op === 'append') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            let content = ''
            if (op === 'append') {
              try { content = decodeBuf(await sftp.readFile(p), body.encoding || config.encoding) } catch { /* new */ }
            }
            const buf = encodeText(content + String(body.content ?? ''), body.encoding || config.encoding)
            if (op === 'write' && !(await sftp.stat(p).catch(() => null))) await mkdirRemoteDirs(sftp, remoteDirname(p))
            await sftp.writeFile(p, buf)
            audit(op, `${op} ${p}`, 0)
            return sendJson(res, 200, { ok: true, bytes: buf.byteLength })
          }
          if (op === 'download') {
            // Download a remote file into the current workspace mirror.
            const p = normalizeRemotePath(String(body.path || ''))
            const ws = wsPath()
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            if (!ws) return sendJson(res, 400, { ok: false, error: 'no remote workspace set' })
            const st = await sftp.stat(p).catch(() => null)
            if (!st) return sendJson(res, 404, { ok: false, error: 'not found' })
            if (config.maxFileBytes > 0 && st.size > config.maxFileBytes) {
              return sendJson(res, 400, { ok: false, error: `file is ${st.size} bytes (over ${config.maxFileBytes} cap)` })
            }
            const base = mirrorDirFor(ws, config.host, config.username, config.port)
            const rel = p.startsWith(ws) ? p.slice(ws.length).replace(/^\/+/, '') : p.slice(1)
            const local = path.join(base, rel)
            mkdirSync(path.dirname(local), { recursive: true })
            await sftp.fastGet(p, local)
            audit('download', `download ${p}`, 0)
            return sendJson(res, 200, { ok: true, bytes: st.size, local })
          }
          return sendJson(res, 400, { ok: false, error: 'unknown op' })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
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
          const okDir = await isRemoteDir(p)
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory: ${p}` })
          persistWorkspace(p)
          const local = ensureMirror(p, config.host, config.username, config.port)
          startAutoPush(local)
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
          const okDir = await isRemoteDir(p)
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory (or unreachable): ${p}` })
          const local = ensureMirror(p, config.host, config.username, config.port)
          persistWorkspace(p)
          startAutoPush(local)
          return sendJson(res, 200, { ok: true, path: p, localMirror: local, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-pick',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          let outcome = null
          let via = 'service'
          const cap = await localPickCapability()
          if (cap && cap.kind === 'native' && typeof cap.pick === 'function') {
            try {
              const pickAbort = new AbortController()
              const p = await Promise.resolve(cap.pick(pickAbort.signal || null))
              pickAbort.abort()
              outcome = (typeof p === 'string' && p) ? { path: p } : { cancelled: true }
            } catch (err) {
              outcome = null
            }
          }
          // DSH Desktop (Electron) deliberately mounts the BROWSE backend on
          // win32 — the native backend's Win32 dialog worker spawns
          // process.execPath as a plain node script, which cannot work inside
          // an Electron binary. Honor the host's chosen interaction instead of
          // ignoring it: hand the client an in-app local directory browser
          // backed by /dsh-remote/local-list (+ /dsh-remote/local-mkdir).
          // This also serves headless/remote hosts where no OS dialog can
          // open but the browse capability still lists real directories.
          if (!outcome && cap && cap.kind === 'browse' && typeof cap.list === 'function') {
            return sendJson(res, 200, { ok: true, kind: 'browse', via: 'browse' })
          }
          if (!outcome) {
            via = 'own'
            try {
              outcome = await pickLocalNative()
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) + ' — 可直接在输入框填本地路径' })
            }
          }
          if (outcome.cancelled) return sendJson(res, 200, { ok: true, cancelled: true, via })
          return sendJson(res, 200, { ok: true, path: outcome.path, via })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-list',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const cap = await localPickCapability()
          if (!cap || cap.kind !== 'browse' || typeof cap.list !== 'function') return sendJson(res, 400, { ok: false, error: '当前目录选择器不是浏览后端，无法列出本机目录' })
          const m = (req.url || '').match(/path=([^&]*)/)
          const raw = m ? decodeURIComponent(m[1]) : ''
          // No path → the browse backend lists the host home directory.
          try {
            const out = await Promise.resolve(cap.list(raw ? raw : undefined))
            return sendJson(res, 200, { ok: true, ...out })
          } catch (listErr) {
            return sendJson(res, 400, { ok: false, error: String((listErr && listErr.message) || listErr), code: (listErr && listErr.code) || 'directory-unreadable' })
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-mkdir',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const cap = await localPickCapability()
          if (!cap || cap.kind !== 'browse' || typeof cap.createDirectory !== 'function') return sendJson(res, 400, { ok: false, error: '当前目录选择器不是浏览后端，无法新建文件夹' })
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = String(payload.path || '')
          const name = String(payload.name || '')
          if (!p.trim() || !name.trim()) return sendJson(res, 400, { ok: false, error: 'path and name required' })
          try {
            const created = await Promise.resolve(cap.createDirectory(p, name))
            return sendJson(res, 200, { ok: true, path: created })
          } catch (mkErr) {
            return sendJson(res, 400, { ok: false, error: String((mkErr && mkErr.message) || mkErr), code: (mkErr && mkErr.code) || 'directory-create-failed' })
          }
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
              const id = body.id || machineId()
              const i = machineIndex(id)
              const prev = i >= 0 ? machines[i] : null
              const credBackend = body.credentialBackend === 'plain' ? 'plain'
                : (body.encryptPassword ? platformBackend() : (prev && prev.credentialBackend ? prev.credentialBackend : 'plain'))
              const rec = {
                id,
                name: String(body.name || '').trim() || host,
                host,
                port: Number(body.port) || 22,
                username: String(body.username || '').trim() || 'root',
                password: '',
                privateKeyPath: String(body.privateKeyPath || '').trim(),
                passphrase: body.passphrase || '',
                workspace: String(body.workspace || '').trim(),
                hostKeyMode: body.hostKeyMode || '',
                useAgent: !!body.useAgent,
                keyboardInteractive: !!body.keyboardInteractive,
                proxy: body.proxy && body.proxy.host ? {
                  host: String(body.proxy.host),
                  port: Number(body.proxy.port) || 22,
                  username: String(body.proxy.username || '').trim(),
                  password: String(body.proxy.password || ''),
                  privateKeyPath: String(body.proxy.privateKeyPath || '').trim(),
                } : undefined,
                credentialBackend: credBackend,
                recentWorkspaces: prev && prev.recentWorkspaces ? prev.recentWorkspaces : [],
                lastConnectedAt: prev && prev.lastConnectedAt ? prev.lastConnectedAt : null,
                latencyMs: prev && prev.latencyMs ? prev.latencyMs : null,
              }
              if (body.password) {
                if (credBackend !== 'plain') {
                  await saveSecret(id, String(body.password), secretsDir())
                  rec.password = ''
                } else {
                  rec.password = String(body.password)
                }
              } else if (prev && prev.password) {
                rec.password = prev.password
              }
              if (i >= 0) machines[i] = rec; else machines.push(rec)
              if (!store.currentId) store.currentId = id
              saveMachines(machines, store.currentId)
              if (store.currentId === id) await applyActiveMachine()
              return sendJson(res, 200, { ok: true, machine: sanitizeMachine(rec), machines: machines.map(sanitizeMachine), currentId: store.currentId })
            }
            if (action === 'delete') {
              const i = machineIndex(String(body.id || ''))
              if (i < 0) return sendJson(res, 404, { ok: false, error: 'machine not found' })
              const m = machines[i]
              if (m.credentialBackend && m.credentialBackend !== 'plain') {
                await deleteSecret(m.id, secretsDir()).catch(() => {})
              }
              machines.splice(i, 1)
              if (store.currentId === body.id) store.currentId = machines[0] ? machines[0].id : null
              saveMachines(machines, store.currentId)
              if (store.currentId) await applyActiveMachine()
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
      path: '/dsh-remote/test-connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const probe = new SshPool({
            ...config,
            host: String(body.host || config.host),
            port: Number(body.port) || config.port,
            username: String(body.username || config.username),
            password: String(body.password || ''),
            privateKeyPath: String(body.privateKeyPath || config.privateKeyPath),
            passphrase: String(body.passphrase || ''),
            proxy: body.proxy && body.proxy.host ? {
              host: String(body.proxy.host),
              port: Number(body.proxy.port) || 22,
              username: String(body.proxy.username || ''),
              password: String(body.proxy.password || ''),
              privateKeyPath: String(body.proxy.privateKeyPath || ''),
            } : undefined,
            connectTimeoutMs: Math.min(Math.max(Number(body.connectTimeoutMs) || config.connectTimeoutMs, 2000), 30000),
            commandTimeoutMs: 10000,
          })
          const started = Date.now()
          await probe.connect()
          await probe.exec('true', { timeoutMs: 10000 })
          probe.close()
          const latencyMs = Date.now() - started
          const mi = machines.findIndex((m) => m.host === probe.config.host && m.username === probe.config.username && Number(m.port) === probe.config.port)
          if (mi >= 0) {
            machines[mi].lastConnectedAt = new Date().toISOString()
            machines[mi].latencyMs = latencyMs
            saveMachines(machines, store.currentId)
          }
          return sendJson(res, 200, { ok: true, host: probe.config.host, user: probe.config.username, latencyMs, lastConnectedAt: new Date().toISOString() })
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: friendlyMessage(err, { host: body && body.host, port: body && body.port }) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/current',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const okSet = await setCurrent(String(body.id || ''))
          if (!okSet) return sendJson(res, 404, { ok: false, error: 'machine not found' })
          return sendJson(res, 200, { ok: true, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/forget-key',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        createHostKeyGuard(config).forgetHost()
        return sendJson(res, 200, { ok: true, ...status() })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/forwards',
      handler: async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { forwards: forwards.list() })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const action = String(body.action || '')
          if (action === 'define') {
            const d = forwards.define({
              direction: body.direction === 'reverse' ? 'reverse' : 'local',
              listenPort: Number(body.listenPort),
              targetHost: body.targetHost || '127.0.0.1',
              targetPort: Number(body.targetPort) || Number(body.listenPort),
              autoStart: !!body.autoStart,
              machineId: store.currentId,
            })
            return sendJson(res, 200, { ok: true, forward: d, forwards: forwards.list() })
          }
          if (action === 'start' || action === 'stop') {
            const d = forwards.list().find((f) => f.id === body.id)
            if (!d) return sendJson(res, 404, { ok: false, error: 'forward not found' })
            if (action === 'start') {
              const r = await forwards.start(d)
              if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error })
            } else {
              forwards.stop(d.id)
            }
            return sendJson(res, 200, { ok: true, forwards: forwards.list() })
          }
          if (action === 'remove') {
            forwards.remove(String(body.id || ''))
            return sendJson(res, 200, { ok: true, forwards: forwards.list() })
          }
          return sendJson(res, 400, { ok: false, error: 'unknown action' })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/task',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const q = new URL(req.url, 'http://localhost').searchParams
          const id = q.get('id') || ''
          const t = tasks.get(id)
          if (!t) return sendJson(res, 404, { ok: false, error: 'task not found' })
          return sendJson(res, 200, { ok: true, task: t })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const id = String(body.id || '')
            if (body.action === 'cancel') {
              const ok = tasks.cancel(id)
              return sendJson(res, 200, { ok, task: tasks.get(id) })
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
      path: '/dsh-remote/tasks',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendJson(res, 200, { ok: true, tasks: tasks.list() })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/audit',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const q = new URL(req.url, 'http://localhost').searchParams
        return sendJson(res, 200, { ok: true, auditEnabled: !!config.auditLog, file: auditFile(), lines: readAudit(q.get('limit')) })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/ssh-config',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const text = readSshConfigText()
          return sendJson(res, 200, { ok: true, file: sshConfigPath(), present: !!text, entries: importableEntries(text) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/home',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const out = await pool.exec('echo ~', { timeoutMs: Math.min(config.commandTimeoutMs, 5000) })
          const home = String(out.stdout || '').replace(/\s+/g, '').trim()
          if (!home) return sendJson(res, 200, { ok: true, home: null, hint: 'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径' })
          return sendJson(res, 200, { ok: true, home })
        } catch (err) {
          return sendJson(res, 200, { ok: true, home: null, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-check',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const current = readVersion()
        const latest = await fetchLatestVersion()
        if (latest === null) return sendJson(res, 200, { ok: false, current, error: '无法连接 npm registry' })
        const rawMode = readUpdateMode() || config.updateMode || 'manual'
        return sendJson(res, 200, {
          ok: true,
          current,
          latest,
          updateAvailable: gtVersion(latest, current),
          updateMode: ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : 'manual',
          updatedMarker: existsSync(path.join(selfDir(), '.dsh-remote-updated')),
        })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-apply',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const target = String(body.version || '')
          if (!target) return sendJson(res, 400, { ok: false, error: 'version is required' })
          const result = await applyUpdate(target)
          return sendJson(res, 200, { ok: true, from: readVersion(), ...result })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-mode',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const mode = String(body.mode || '')
          if (!['manual', 'auto', 'off'].includes(mode)) return sendJson(res, 400, { ok: false, error: 'mode must be manual | auto | off' })
          if (!persistUpdateMode(mode)) return sendJson(res, 500, { ok: false, error: 'cannot persist mode' })
          return sendJson(res, 200, { ok: true, mode })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]

  const disposers = routes.map((r) => webServer.register(r))
  ctx.effect(() => () => disposers.forEach((d) => d && d()), 'dsh-remote.routes')

  // ── auto-update: check on load + on an interval; apply silently ───────────
  // Failures are swallowed (never break the plugin). The persisted override
  // (settings UI) wins over the profile-config default.
  const rawMode = readUpdateMode() || config.updateMode || 'manual'
  const effectiveUpdateMode = ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : 'manual'
  if (effectiveUpdateMode === 'auto') {
    const currentVersion = readVersion()
    const checkAndApply = async () => {
      const latest = await fetchLatestVersion()
      if (latest && gtVersion(latest, currentVersion)) {
        try { await applyUpdate(latest) } catch {}
      }
    }
    void checkAndApply()
    const updateTimer = setInterval(checkAndApply, Math.max(config.updateCheckIntervalMs, 60000))
    if (typeof updateTimer.unref === 'function') updateTimer.unref()
    ctx.effect(() => () => clearInterval(updateTimer), 'dsh-remote.update-timer')
  }
}
