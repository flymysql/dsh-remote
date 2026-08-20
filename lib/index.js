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
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, copyFileSync, utimesSync } from 'node:fs'
import { homedir } from 'node:os'
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
})

// ── shell / path helpers (proven in the read tooling) ───────────────────────

/** Single-quote one shell argument verbatim. */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/**
 * Normalize a remote path into a clean absolute path, supporting BOTH POSIX
 * (`/home/user`) and Windows (`D:\Code`, `C:/Users/x`, `\\server\share`) forms.
 *
 * - POSIX paths keep `/` separators and a leading `/`.
 * - Windows drive paths keep their `X:` prefix and are returned with `\`
 *   separators (the native form on a Windows remote); a leading `/` is NOT
 *   added, so `D:\Code` stays `D:\Code` instead of becoming `/D:\Code`.
 * - UNC paths (`\\server\share\…`) keep the `\\server\share` prefix.
 * - `.` / `..` segments are collapsed in both separator styles.
 */
function normalizeRemotePath(p) {
  const s = String(p)
  // Windows UNC: \\server\share\…
  const unc = s.match(/^(\\\\[^\\]+(?:\\[^\\]+)?)(?:\\|$)(.*)$/s)
  if (unc) {
    const [prefix, rest] = [unc[1], unc[2]]
    const parts = []
    for (const seg of rest.split(/[\\/]+/)) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') { parts.pop(); continue }
      parts.push(seg)
    }
    return parts.length ? prefix + '\\' + parts.join('\\') : prefix
  }
  // Windows drive: X:\… or X:/…
  const drive = s.match(/^([a-zA-Z]:)(?:[\\/]|$)(.*)$/s)
  if (drive) {
    const [prefix, rest] = [drive[1], drive[2]]
    const parts = []
    for (const seg of rest.split(/[\\/]+/)) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') { parts.pop(); continue }
      parts.push(seg)
    }
    return prefix + '\\' + parts.join('\\')
  }
  // POSIX: /a/b/c
  const parts = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return '/' + parts.join('/')
}

/** Join a remote dir + entry name, honoring the dir's own separator style. */
function joinRemotePath(dir, name) {
  const d = String(dir)
  if (!d) return String(name)
  if (d.endsWith('/') || d.endsWith('\\')) return d + String(name)
  return d + (d.includes('\\') ? '\\' : '/') + String(name)
}

/** Create every level of a remote dir via SFTP (mkdir -p semantics), working
 * for both POSIX (`/a/b`) and Windows (`D:\a\b`) paths. Best effort: an
 * existing or permission-denied level is skipped. */
async function mkdirRemoteDirs(sftp, dir) {
  const parent = remoteDirname(dir)
  const isWin = parent.includes('\\')
  // Split off a Windows drive prefix (D:) so it is not treated as a segment.
  const drive = isWin ? (parent.match(/^([a-zA-Z]:)[\\/]?(.*)$/s) || null) : null
  const segs = drive ? drive[2].split(/[\\/]/).filter(Boolean) : parent.split(/[\\/]/).filter(Boolean)
  let cur = isWin ? (drive ? drive[1] + '\\' : '') : ''
  // Drive root (D:\) itself, best effort (usually exists).
  if (isWin && cur) { try { await sftp.mkdir(cur) } catch { /* exists */ } }
  for (const s of segs) {
    if (cur) {
      if (!cur.endsWith('\\') && !cur.endsWith('/')) cur += isWin ? '\\' : '/'
      cur += s
    } else {
      cur = (isWin ? s + ':' : '/' + s)
    }
    try { await sftp.mkdir(cur) } catch { /* exists or no perms */ }
  }
}

/** Parent dir of a remote absolute path (string-level; POSIX or Windows). */
function remoteDirname(p) {
  const norm = normalizeRemotePath(p)
  // Windows drive/UNC root: D:\ or \\server\share
  if (norm === '/' || /^[a-zA-Z]:\\?$/.test(norm) || /^\\\\[^\\]+\\[^\\]+$/.test(norm)) {
    // Ensure a drive root ends with a backslash: D: → D:\
    const m = norm.match(/^([a-zA-Z]:)$/)
    return m ? m[1] + '\\' : norm
  }
  const sep = norm.includes('\\') ? '\\' : '/'
  const idx = norm.lastIndexOf(sep)
  if (idx <= 0) {
    // Windows drive with a child (D:\Code) → D:\
    const m = norm.match(/^([a-zA-Z]:)\\/)
    return m ? m[1] + '\\' : sep === '/' && norm.startsWith('/') ? '/' : norm
  }
  // A parent that is a Windows drive root also needs the trailing backslash.
  const parent = norm.slice(0, idx)
  if (sep === '\\' && /^[a-zA-Z]:$/.test(parent)) return parent + '\\'
  return parent
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
  const norm = normalizeRemotePath(p).replace(/[\\/]+$/, '')
  const base = norm.split(/[\\/]/).pop()
  // Windows drive root (D:\) has no meaningful basename
  if (!base || /^[a-zA-Z]:$/.test(base)) return 'workspace'
  return base
}

/**
 * Convert an internal remote path (POSIX `/a/b` or Windows `D:\Code`) into the
 * path format the SFTP server understands.
 *
 * Windows OpenSSH's sftp-server accepts POSIX-style paths: a drive letter is
 * written `/D:/…` (equivalent to `D:\…`). POSIX paths pass through unchanged.
 * UNC paths are kept as-is (the server resolves `\\server\share` itself).
 */
function toSftpPath(p) {
  const norm = normalizeRemotePath(p)
  const m = norm.match(/^([a-zA-Z]):\\(.*)$/s)
  if (m) return '/' + m[1] + ':/' + m[2].replace(/\\/g, '/')
  return norm
}

/** Harness home: respect `DSH_HOME` when set (the desktop app sets it to its
 * own `userData/harness`), otherwise fall back to `~/.dsh`. Keeping plugin
 * data under the same root the harness uses means uninstalling / upgrading the
 * app no longer leaves state behind in the home directory. */
function dshBase() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return path.resolve(String(env).trim())
  return path.join(homedir(), '.dsh')
}

/** Root holding every remote host's mirrors + the machine registry. */
function remoteWorkspacesRoot() {
  return path.join(dshBase(), 'remote-workspaces')
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

/** One-time migration of pre-0.6 data (which lived at `~/.dsh/remote-workspaces`
 * regardless of `DSH_HOME`). Moves the legacy dir into the current home so a
 * desktop install keeps its existing machines and mirrors. Idempotent; a
 * rename across devices falls back to a copy. */
function migrateLegacyData() {
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

/** 32-bit string hash rendered in base36 (short, collision-safe enough). */
function shortHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** Stable local root for one remote host's mirrors */
function mirrorRootFor(host, user, port) {
  const tag = [host, user, port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(remoteWorkspacesRoot(), tag)
}

/** Local mirror dir for a specific remote path (idempotent → returns same dir).
 * Named after the remote directory's basename so the harness workspace label
 * reads cleanly (e.g. .../project). When the plain basename dir is already
 * taken by a DIFFERENT remote path on the same host, a short path-hash suffix
 * is appended so mirrors never collide. */
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
  // Plain dir is free → first mirror for this basename keeps the clean name.
  // It exists but points elsewhere (or is a non-mirror dir) → hashed variant.
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

/** Run `fn` over `items` with at most `limit` concurrent in-flight calls. */
async function mapLimit(items, limit, fn) {
  const limitN = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try { await fn(items[i], i) } catch { /* per-item errors are the fn's concern */ }
    }
  }
  const workers = []
  for (let w = 0; w < limitN; w++) workers.push(worker())
  await Promise.all(workers)
}

/** Recursively sync remote → local mirror. Bounded by depth/files/size;
 * skips files whose size+mtime already match locally. Returns counters. */
async function syncTree(sftp, remoteDir, localDir, maxDepth, maxFiles, maxFileBytes) {
  const entries = await sftp.readdir(remoteDir).then(
    (list) => list,
    () => [],
  )
  const stats = { files: 0, dirs: 0, skippedUnchanged: 0, skippedLarge: 0, touched: [] }

  // Directories first (sequential, depth-bounded) so every file has a home.
  for (const e of entries) {
    const name = String(e.filename)
    if (name === '.' || name === '..') continue
    const isDir = e.attrs && e.attrs.isDirectory && e.attrs.isDirectory()
    if (!isDir) continue
    if (maxDepth <= 0 || stats.files >= maxFiles) continue
    const rp = joinRemotePath(remoteDir, name)
    const lp = path.join(localDir, name)
    mkdirSync(lp, { recursive: true })
    const sub = await syncTree(sftp, rp, lp, maxDepth - 1, maxFiles - stats.files, maxFileBytes)
    stats.dirs += sub.dirs + 1
    stats.files += sub.files
    stats.skippedUnchanged += sub.skippedUnchanged
    stats.skippedLarge += sub.skippedLarge
    stats.touched.push(...sub.touched)
    if (stats.files >= maxFiles) break
  }
  if (stats.files >= maxFiles) return stats

  // Files in one bounded-parallel sweep per directory level.
  const fileEntries = entries.filter(
    (e) => !(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory()) &&
      String(e.filename) !== '.' && String(e.filename) !== '..',
  )
  await mapLimit(fileEntries, 4, async (e) => {
    if (stats.files >= maxFiles) return
    const name = String(e.filename)
    const rp = joinRemotePath(remoteDir, name)
    const lp = path.join(localDir, name)
    try {
      const st = await sftp.stat(rp)
      if (maxFileBytes > 0 && st.size > maxFileBytes) { stats.skippedLarge++; return }
      const lpStat = existsSync(lp) ? statSync(lp) : null
      const unchanged = lpStat && lpStat.size === st.size && Math.floor(lpStat.mtimeMs / 1000) === st.mtime
      if (unchanged) { stats.skippedUnchanged++; return }
      const buf = await sftp.readFile(rp)
      writeFileSync(lp, buf)
      try { utimesSync(lp, new Date(st.mtime * 1000), new Date(st.mtime * 1000)) } catch {}
      stats.files++
      stats.touched.push(rp)
    } catch {
      /* skip unreadable */
    }
  })
  return stats
}

/** Recursively upload a local mirror tree → remote SFTP dir. Bounded by files;
 * skips files whose remote copy already matches (same size, remote no older). */
async function pushTree(sftp, localDir, remoteDir, maxFiles, maxFileBytes) {
  const entries = readdirSync(localDir, { withFileTypes: true }).filter((e) => e.name !== '.dsh-remote-meta.json')
  const stats = { files: 0, dirs: 0, skippedUnchanged: 0, skippedLarge: 0, pushed: [] }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (stats.files >= maxFiles) break
    const rp = joinRemotePath(remoteDir, e.name)
    try { await sftp.mkdir(rp) } catch { /* already exists */ }
    stats.dirs++
    const sub = await pushTree(sftp, path.join(localDir, e.name), rp, maxFiles - stats.files, maxFileBytes)
    stats.files += sub.files
    stats.skippedUnchanged += sub.skippedUnchanged
    stats.skippedLarge += sub.skippedLarge
    stats.pushed.push(...sub.pushed)
    if (stats.files >= maxFiles) break
  }
  if (stats.files >= maxFiles) return stats

  const fileEntries = entries.filter((e) => !e.isDirectory())
  await mapLimit(fileEntries, 4, async (e) => {
    if (stats.files >= maxFiles) return
    const lp = path.join(localDir, e.name)
    const rp = joinRemotePath(remoteDir, e.name)
    try {
      const lstat = statSync(lp)
      if (maxFileBytes > 0 && lstat.size > maxFileBytes) { stats.skippedLarge++; return }
      let rstat = null
      try { rstat = await sftp.stat(rp) } catch { /* remote file absent → upload */ }
      const unchanged = rstat && rstat.size === lstat.size && rstat.mtime >= Math.floor(lstat.mtimeMs / 1000)
      if (unchanged) { stats.skippedUnchanged++; return }
      const buf = readFileSync(lp)
      await sftp.writeFile(rp, buf)
      stats.files++
      stats.pushed.push(rp)
    } catch {
      /* skip unreadable / unwritable */
    }
  })
  return stats
}

// ── persistent multi-machine registry ─────────────────────────────────────
const MACHINES_FILE = 'machines.json'
const machinesFile = () => path.join(remoteWorkspacesRoot(), MACHINES_FILE)
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

// ── host-key registry (TOFU: trust-on-first-use, like ssh accept-new) ──────
const KNOWN_HOSTS_FILE = 'known_hosts.json'
const knownHostsFile = () => path.join(remoteWorkspacesRoot(), KNOWN_HOSTS_FILE)

/** Read the trusted host-key map { "host:port": { algo, fingerprint } }. */
function loadKnownHosts() {
  try {
    const j = JSON.parse(readFileSync(knownHostsFile(), 'utf8'))
    if (j && typeof j === 'object' && !Array.isArray(j)) return j
  } catch {}
  return {}
}

/** Extract the host-key algorithm name from a raw SSH host-key blob
 * (SSH wire format: `uint32 len` + algorithm string + key data). */
function blobAlgorithm(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 4) return ''
  try {
    const len = blob.readUInt32BE(0)
    return blob.toString('utf8', 4, 4 + len)
  } catch {
    return ''
  }
}

/** SHA-256 fingerprint (base64) of an ssh2 host-key blob, like `SHA256:…`
 * in a known_hosts file (without the `SHA256:` prefix).
 *
 * ssh2 v1.17 passes hostVerifier the RAW host-key blob Buffer (the SSH
 * wire-format `string(algo) string(keydata)`), NOT the old `{ algo, hash }`
 * object. Fingerprinting `key.hash` on a raw Buffer crashed with "The 'data'
 * argument must be of type string or an instance of Buffer, TypedArray, or
 * DataView. Received undefined" on EVERY connect (v0.6.6 bug) — so the
 * v0.6.1 TOFU guard never actually worked against real ssh2. Accept both
 * shapes defensively. */
function keyFingerprint(key) {
  const blob = Buffer.isBuffer(key) ? key : (key && key.hash)
  if (!blob) throw new Error('host key missing (hostVerifier received no key blob)')
  return createHash('sha256').update(blob).digest('base64')
}

/** Build an ssh2 `hostVerifier` bound to the current config. Returns
 * `{ mode, verifier, lastError, knownHosts, forgetHost }`. The verifier:
 *  - `off` → always accepts;
 *  - `accept-new` → records a host's key on first connect, rejects any CHANGE
 *    afterwards (classic TOFU / MITM detection);
 *  - `verify` → same, plus rejects hosts never recorded before. */
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

// ── SSH pool (key OR password) ──────────────────────────────────────────────

class SshPool {
  constructor(config) {
    this.config = config
    this.client = null
    this.connecting = null
    // Generational token: bumped on every target change / close so a stale
    // in-flight connect can never hand this pool a connection to an old host.
    this.epoch = 0
  }

  resolveKeyPath() {
    const p = this.config.privateKeyPath
    if (!p) return ''
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
    const epoch = this.epoch
    const pending = this._doConnect(epoch)
    this.connecting = pending
    const clear = () => {
      if (this.epoch === epoch && this.connecting === pending) this.connecting = null
    }
    // Keep the chain clean in both directions: the raw pending is what callers
    // await (they still see rejections); this side just clears the slot.
    pending.then(clear, clear)
    return pending
  }

  _doConnect(epoch) {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let settled = false
      // Fresh host-key guard per connect attempt so lastError is never stale.
      const guard = createHostKeyGuard(this.config)
      const isCurrent = () => this.epoch === epoch
      const fail = (err) => {
        if (settled) return
        settled = true
        if (isCurrent() && this.client === client) this.client = null
        reject(guard.lastError ? new Error(guard.lastError) : err)
      }
      client.on('ready', () => {
        if (settled) return
        settled = true
        if (!isCurrent()) {
          // The target changed while we were connecting — never adopt this
          // client, and make sure the caller learns the connect is void.
          try { client.end() } catch {}
          reject(new Error('ssh target changed during connect'))
          return
        }
        this.client = client
        resolve(client)
      })
      client.on('error', fail)
      client.on('close', () => {
        if (isCurrent() && this.client === client) this.client = null
        fail(new Error('ssh connection closed'))
      })

      const opts = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        readyTimeout: this.config.connectTimeoutMs,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: (key) => guard.verifier(key),
      }
      if (this.config.password) {
        opts.password = this.config.password
      } else {
        const keyPath = this.resolveKeyPath()
        if (!keyPath) {
          return fail(new Error('no credentials: set a password or a privateKeyPath to connect'))
        }
        let key
        try {
          key = readFileSync(keyPath)
        } catch (err) {
          return fail(new Error(`cannot read private key "${keyPath}": ${err && err.message}`))
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
              // Kill the remote command (SIGTERM) rather than just dropping the
              // channel, so a runaway process cannot keep running and holding
              // the SSH connection after we've given up on its output. The hard
              // close below frees the channel even if the process ignores it.
              try {
                if (typeof stream.signal === 'function') stream.signal('SIGTERM')
              } catch {}
              const hardClose = setTimeout(() => {
                try { stream.close() } catch {}
              }, 800)
              if (typeof hardClose.unref === 'function') hardClose.unref()
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

  /** Resolve a promisified SFTP client for binary file transfers (sync).
   * All path arguments are normalized via toSftpPath() so Windows remotes
   * (drive-letter paths) work too. */
  sftp() {
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          client.sftp((err, sftp) => {
            if (err) return reject(new Error('ssh sftp failed: ' + ((err && err.message) || err)))
            // Wrap a raw SFTP method so a stuck server can never hang a tool call.
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
              readFile: (p) => withTimeout((d, cb) => sftp.readFile(d, cb))(P(p)),
              writeFile: (p, data) => withTimeout((d, data2, cb) => sftp.writeFile(d, data2, cb))(P(p), data),
            })
          })
        }),
    )
  }

  close() {
    // Bump the epoch so any in-flight connect is orphaned, drop the pending
    // promise (its rejection becomes nobody's problem — swallow it), and end
    // the live client if there is one.
    this.epoch++
    const client = this.client
    this.client = null
    const pending = this.connecting
    this.connecting = null
    if (pending && typeof pending.catch === 'function') {
      try { pending.catch(() => {}) } catch {}
    }
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

  // Bring any pre-0.6 data (~/.dsh/remote-workspaces) into the DSH_HOME-based
  // location so existing machines + mirrors keep working after the move.
  migrateLegacyData()

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

  /** Set the active remote workspace AND persist it on the current machine so
   * it survives restarts (previously a tool-set workspace reset on reload). */
  const persistWorkspace = (p) => {
    config.workspace = p
    if (store.currentId) {
      const i = machineIndex(store.currentId)
      if (i >= 0) {
        machines[i].workspace = p
        saveMachines(machines, store.currentId)
      }
    }
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

  /** Structured-listing of a remote dir: name + usable type.
   *
   * Uses SFTP readdir (protocol-level), so it works on ANY remote — Linux,
   * macOS, or Windows (cmd.exe / PowerShell) — with no dependency on a POSIX
   * shell or `ls`. Entry types come straight from SFTP attrs; symlinks are
   * resolved with one bounded lstat (if it fails they degrade to files). */
  const listDirStructured = async (p, timeoutMs) => {
    const target = normalizeRemotePath(p || '/')
    let sftp
    try {
      sftp = await pool.sftp()
    } catch (err) {
      throw new Error('browse failed: ' + ((err && err.message) || err))
    }
    let list = []
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
      if (a.isSymbolicLink && a.isSymbolicLink()) {
        items.push({ type: 'symlink', name })
        symIdx.push(items.length - 1)
      } else if (a.isDirectory && a.isDirectory()) {
        items.push({ type: 'dir', name })
      } else {
        items.push({ type: 'file', name })
      }
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

  /** Verify a remote path is an existing directory, via SFTP stat (works on
   * any remote shell: POSIX sh, cmd.exe, PowerShell). Returns false when the
   * path is missing, is a file, or the stat errors. */
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
    hostKeyMode: config.hostKeyMode === 'verify' || config.hostKeyMode === 'off' ? config.hostKeyMode : 'accept-new',
    hostKeyKnown: config.host ? isHostKeyKnown(config.host, config.port) : false,
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
        'Show the remote environment: host/user/port, connection health, and the current remote workspace path. Call this first to orient, or when an rw_* call fails to check connectivity.',
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
          `Local mirror: ${s.localMirror || '(none)'}`,
          `Connected: ${s.connected ? 'yes' : 'no'}`,
          '',
        ]
        if (s.host && s.workspace) {
          try {
            // `echo ok` only — the `;`-joined probes broke on cmd.exe remotes.
            const res = await pool.exec('echo ok', Math.min(config.commandTimeoutMs, 8000))
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
          const res = await pool.exec('echo ok', 8000)
          if (res.code !== 0 && !res.stdout) return { text: 'connect failed: ' + (res.stderr || 'exit ' + res.code) }
          return { text: `Connected to ${host} as ${config.username}.\n\npick a workspace with rw_pick_workspace (path=<abs>).` }
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
        const ok = await isRemoteDir(p)
        if (!ok) return { text: `not a directory (or missing) on ${p}` }
        persistWorkspace(p)
        const local = ensureMirror(p, config.host, config.username, config.port)
        return {
          text: `Remote workspace set to ${p} on ${config.username}@${config.host} (saved for this machine).\nLocal mirror (native workspace path): ${local}\n\nRun rw_sync to download its files into the local mirror.`,
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
        const r = await syncTree(sftp, p, local, depth, maxFiles, config.maxFileBytes)
        let text = `Downloaded ${r.files} file(s) from ${p} → ${local}${r.files >= maxFiles ? ' (hit download cap)' : ''}.`
        if (r.skippedUnchanged) text += ` ${r.skippedUnchanged} unchanged.`
        if (r.skippedLarge) text += ` ${r.skippedLarge} too large (over ${config.maxFileBytes} bytes).`
        return { text }
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
        const { files, skippedUnchanged, skippedLarge, pushed } = await pushTree(sftp, local, p, maxFiles, config.maxFileBytes)
        let text = `Uploaded ${files} file(s) from ${local} → ${p}.`
        if (skippedUnchanged) text += ` ${skippedUnchanged} unchanged.`
        if (skippedLarge) text += ` ${skippedLarge} too large (over ${config.maxFileBytes} bytes).`
        return { text }
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
        // SFTP readdir listing — works on any remote shell (POSIX, cmd.exe,
        // PowerShell) unlike `ls -la`.
        let list
        try {
          const sftp = await pool.sftp()
          list = await sftp.readdir(p)
        } catch (err) {
          throw new Error('rw_list_dir: ' + ((err && err.message) || err))
        }
        const lines = list
          .filter((e) => String(e.filename) !== '.' && String(e.filename) !== '..')
          .map((e) => {
            const a = e.attrs || {}
            const type = a.isDirectory && a.isDirectory() ? 'd' : (a.isSymbolicLink && a.isSymbolicLink() ? 'l' : '-')
            const size = typeof a.size === 'number' ? String(a.size) : '?'
            return `${type} ${size.padStart(10)} ${String(e.filename)}`
          })
        return { text: lines.length ? lines.join('\n') : '(empty directory)' }
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
        // SFTP readFile is used instead of `sed -n` so Windows remotes (cmd.exe
        // / PowerShell, no POSIX sed) work too.
        let buf
        try {
          const sftp = await pool.sftp()
          buf = await sftp.readFile(p)
        } catch (err) {
          throw new Error('rw_read_file: ' + ((err && err.message) || err))
        }
        const content = buf.toString('utf8').replace(/\r\n/g, '\n')
        const allLines = content.split('\n')
        const page = allLines.slice(from - 1, to)
        const numbered = page.map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n').replace(/\s+$/, '')
        let text = numbered === '' ? '(empty or out of range)' : numbered
        if (!args.endLine) text += '\n(shown up to ' + maxLines + ' lines; use startLine/endLine to page)'
        return { text }
      },
    }),

    defineTool({
      name: 'rw_exec',
      description:
        'Run a shell command on the remote host. Use for anything that is not reading a file (build, test, grep, etc). Output is capped. Runs in the current remote workspace by default; pass cwd to run elsewhere.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command (run on the remote host)' },
        cwd: { type: 'string', description: 'Working directory for the command (default: the current remote workspace)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const cmd = String(args.command || '')
        if (!cmd) throw new Error('rw_exec: command is required')
        const ws = wsPath()
        const cwd = args.cwd ? normalizeRemotePath(String(args.cwd)) : (ws || '')
        const full = cwd ? `cd ${shq(cwd)} && ${cmd}` : cmd
        return { text: await run(full, { timeoutMs: config.commandTimeoutMs }) }
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
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, bytes: { type: 'integer' }, text: { type: 'string' } } },
        render: (_a, a) => [{ type: 'text', text: a.text || (a.ok ? 'written' : 'failed') }],
      },
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_write_file: a file path is required')
        const content = String(args.content == null ? '' : args.content)
        let sftp
        try {
          sftp = await pool.sftp()
        } catch (err) {
          throw new Error('rw_write_file: sftp unavailable: ' + ((err && err.message) || err))
        }
        const mkdir = args.mkdir !== false
        if (mkdir) {
          // create each level from the root so mkdir -p semantics survive even
          // when intermediate privileged-parent dirs don't allow create (best effort)
          await mkdirRemoteDirs(sftp, p)
        }
        const buf = Buffer.from(content, 'utf8')
        await sftp.writeFile(p, buf)
        const bytes = Buffer.byteLength(content, 'utf8')
        return { ok: true, bytes, text: `wrote ${bytes} bytes to ${p}` }
      },
    }),

    defineTool({
      name: 'rw_search',
      description:
        'Search remote files for a pattern (grep, recursive, case-insensitive by default). Returns matching file:line rows; output is capped. Use instead of rw_exec grep when you want a bounded, portable search.',
      parameters: {
        pattern: { type: 'string', required: true, description: 'Pattern to search for (extended regex)' },
        path: { type: 'string', description: 'Directory to search (default: current remote workspace)' },
        glob: { type: 'string', description: 'Only files whose name matches this glob, e.g. *.ts (optional)' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default true)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute(args) {
        const pattern = String(args.pattern || '')
        if (!pattern) throw new Error('rw_search: pattern is required')
        const ws = wsPath()
        const dir = args.path ? normalizeRemotePath(String(args.path)) : (ws || '')
        if (!dir) throw new Error('rw_search: no path and no remote workspace set')
        if (dir.includes('\\')) {
          // Windows remotes have no POSIX find/grep; the search would need a
          // recursive SFTP walk. Give an actionable hint instead of a broken cmd.
          return { text: `rw_search does not support Windows-remote paths yet (${dir}). Use rw_exec with a PowerShell one-liner, e.g.: powershell -NoProfile -Command "Get-ChildItem -Recurse -File | Select-String -Pattern '${pattern}'"` }
        }
        const flags = 'r' + (args.ignoreCase === false ? '' : 'i') + 'nE'
        const name = args.glob ? ` -name ${shq(String(args.glob))}` : ''
        // find … -exec grep {} + is POSIX (BSD + GNU): `grep -RInE` alone would
        // differ on BSD, and GNU-only --include is avoided in favor of find -name.
        const cmd = `find ${shq(dir)} -type f${name} -exec grep -${flags} -H -- ${shq(pattern)} {} + 2>/dev/null | head -n 2000`
        return { text: await run(cmd, { timeoutMs: Math.max(config.commandTimeoutMs, 30000) }) }
      },
    }),

    defineTool({
      name: 'rw_download',
      description:
        'Download a single remote file over SFTP into the local mirror of the current workspace (or to an explicit local path). Use when you need the actual file content locally, not just its text.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        localPath: { type: 'string', description: 'Local destination (default: the workspace mirror, preserving the relative path)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, bytes: { type: 'integer' }, text: { type: 'string' } } },
        render: (_a, a) => [{ type: 'text', text: a.text || (a.ok ? 'downloaded' : 'failed') }],
      },
      async execute(args) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_download: a remote file path is required')
        let sftp
        try {
          sftp = await pool.sftp()
        } catch (err) {
          throw new Error('rw_download: sftp unavailable: ' + ((err && err.message) || err))
        }
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
        const buf = await sftp.readFile(p)
        writeFileSync(local, buf)
        const bytes = buf.byteLength
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
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, bytes: { type: 'integer' }, text: { type: 'string' } } },
        render: (_a, a) => [{ type: 'text', text: a.text || (a.ok ? 'uploaded' : 'failed') }],
      },
      async execute(args) {
        const rp = normalizeRemotePath(String(args.path || ''))
        const lp = String(args.localPath || '')
        if (!rp || rp === '/' || !lp) throw new Error('rw_upload: both localPath and a remote path are required')
        if (!existsSync(lp)) throw new Error(`rw_upload: local file not found: ${lp}`)
        let sftp
        try {
          sftp = await pool.sftp()
        } catch (err) {
          throw new Error('rw_upload: sftp unavailable: ' + ((err && err.message) || err))
        }
        await mkdirRemoteDirs(sftp, rp)
        const buf = readFileSync(lp)
        await sftp.writeFile(rp, buf)
        const bytes = buf.byteLength
        return { ok: true, bytes, text: `uploaded ${bytes} bytes from ${lp} → ${rp}` }
      },
    }),

    defineTool({
      name: 'rw_disconnect',
      description:
        'Close the current SSH connection to the remote host, releasing the persistent pool. Useful to rotate connections or after a long idle.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, text: { type: 'string' } } },
        render: (_a, a) => [{ type: 'text', text: a.text }],
      },
      async execute() {
        pool.close()
        return { ok: true, text: 'disconnected' }
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
        'Use the rw_* tools (rw_list_dir / rw_read_file / rw_write_file / rw_exec / rw_search) to inspect and act on files on the remote host. Treat this directory as the working root for this task.'
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
            `Host key: ${s.hostKeyKnown ? 'trusted ✓' : 'not yet trusted'} (mode=${s.hostKeyMode})\n` +
            (s.hostKeyKnown ? `  — if the key changed / was mistrusted, run /remote-forget-key\n` : '') +
            `\nUse tools: rw_list_dir / rw_read_file / rw_exec / rw_search.` +
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
  }

  // ── JSON endpoints for settings UI ─────────────────────────────────────────
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  // Cap request bodies (1 MiB) so a malformed client cannot force us to buffer
  // unbounded memory on a local-only route.
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
  // 背景：web-app 的 `directory-picker` 行（-auto）在桌面启动路径里不物化成
  // loader 条目，`ctx.get('directoryPicker')` 实测为 null（沙箱 + 产品同路径）。
  // 因此插件自带原生选择器：macOS osascript / Linux zenity→kdialog，与 DSH
  // native 后端同一套调用约定（取消 → { cancelled }，成功 → { path }）。
  const PICK_TIMEOUT_MS = 120000
  const runPick = (bin, args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: PICK_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (err) {
          const code = err.code
          const msg = String(stderr || '')
          // 用户在对话框里点了取消：osascript 退出码 1 + "User canceled"/-128
          if (code === 1 && /(?:user canceled|-128)/i.test(msg)) return resolve({ cancelled: true })
          if (err.signal || err.killed) return reject(new Error('目录选择已超时，请重试或直接在输入框填本地路径'))
          if (code === 'ENOENT') return reject(Object.assign(new Error('未找到目录选择器程序 ' + bin), { code }))
          return reject(new Error((msg.trim() || (err && err.message) || '无法打开系统文件夹选择器').split('\n')[0]))
        }
        const p = String(stdout || '').replace(/[\r\n]+$/, '').trim()
        resolve(p ? { path: p } : { cancelled: true })
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
    throw new Error('当前系统不支持自动打开目录选择器，请在输入框直接填本地路径')
  }

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
          // Proper URL parsing so `+` in a path decodes to a literal space
          // (the old regex missed it).
          const q = new URL(req.url, 'http://localhost').searchParams
          const p = q.get('path') ? decodeURIComponent(q.get('path')) : wsPath()
          const out = await listDirStructured(p || '/')
          return sendJson(res, 200, { path: p, items: out.items })
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
          const okDir = await isRemoteDir(p)
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory: ${p}` })
          persistWorkspace(p)
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
          // Always verify over SSH (connecting if needed) so an unconnected or
          // wrong host can never silently mint a mirror for a bogus path.
          const okDir = await isRemoteDir(p)
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory (or unreachable): ${p}` })
          const local = ensureMirror(p, config.host, config.username, config.port)
          persistWorkspace(p)
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
          // 1) 优先用 DSH directoryPicker 服务（native 后端）。必须用
          //    ctx.get() 按名取：属性形式 ctx.directoryPicker 会抛 cordis
          //    "cannot get property ... without inject"（该名字未在本插件
          //    inject 里声明），ctx.get() 无此要求、缺失返回 null。
          // 2) 服务缺位或非 native（实测 web-app 的 -auto 行在桌面启动路径
          //    不物化后端）→ 自持 osascript/zenity/kdialog 兜底。
          let outcome = null
          let via = 'service'
          const dp = (ctx && typeof ctx.get === 'function') ? (ctx.get('directoryPicker') || null) : null
          if (dp && typeof dp.capability === 'function') {
            try {
              const cap = await Promise.resolve(dp.capability())
              if (cap && cap.kind === 'native' && typeof cap.pick === 'function') {
                const pickAbort = new AbortController()
                const p = await Promise.resolve(cap.pick(pickAbort.signal || null))
                pickAbort.abort()
                outcome = (typeof p === 'string' && p) ? { path: p } : { cancelled: true }
              }
            } catch (err) {
              outcome = null // DSH 服务出错 → 落到自持兜底
            }
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
            connectTimeoutMs: Math.min(Math.max(Number(body.connectTimeoutMs) || config.connectTimeoutMs, 2000), 30000),
            commandTimeoutMs: 10000,
          })
          const started = Date.now()
          await probe.connect()
          await probe.exec('true', 10000)
          probe.close()
          return sendJson(res, 200, { ok: true, host: probe.config.host, user: probe.config.username, latencyMs: Date.now() - started })
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: String((err && err.message) || err) })
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
          const okSet = setCurrent(String(body.id || ''))
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
        // Drop the trusted host-key record for the CURRENT target so the next
        // connect re-records it (use after an intentional host reinstall or a
        // false MITM alarm).
        createHostKeyGuard(config).forgetHost()
        return sendJson(res, 200, { ok: true, ...status() })
      },
    },
  ]

  const disposers = routes.map((r) => webServer.register(r))
  ctx.effect(() => () => disposers.forEach((d) => d && d()), 'dsh-remote.routes')
}