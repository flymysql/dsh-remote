// Session → remote-binding resolution.
//
// A session's remote target is derived from its own workspace mirror, never
// from the plugin's mutable active-machine state. That is what keeps concurrent
// sessions on different hosts independent: with a single shared connection and
// a single shared workspace value, one session switching machines redirected
// every other session's commands to the wrong host (issue #25).
//
// The mirror directory is the durable record of that binding: `ensureMirror()`
// writes `.dsh-remote-meta.json` with the remote origin (`host`/`port`/
// `username`/`remotePath`) when the workspace is picked, so a session's cwd
// alone identifies both the machine to connect to and the workspace root.

import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** Strip trailing separators so a mirror root and a path inside it compare cleanly. */
const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '') || ''

/** Whether `base` is `dir` itself or nested under it (separator-aware, so
 *  `/a/mirror-2` is NOT treated as living inside `/a/mirror`). Windows paths
 *  compare case-insensitively: the same directory can be spelled `F:\\Work`
 *  and `f:\\work`, and a drive letter's case is not stable across APIs. */
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
const isUnder = (base, dir) => {
  const b = process.platform === 'win32' ? base.toLowerCase() : base
  const d = process.platform === 'win32' ? dir.toLowerCase() : dir
  return b === d || b.startsWith(d + path.sep) || b.startsWith(d + '/')
}

/** Real path when the OS can resolve it, else the normalized spelling.
 *  `path.resolve` is purely lexical: it never resolves a junction/symlink, so
 *  the same physical directory can arrive spelled two different ways. */
const tryRealpath = (p) => { try { return norm(realpathSync(p)) } catch { return norm(p) } }

/** Path depth, used to pick the deepest matching mirror regardless of spelling. */
const depth = (p) => p.split(/[\\/]+/).filter(Boolean).length

/** Re-spell `mirrorReal` the way `base` spells the SAME directory: step up
 *  from `base` once per segment `baseReal` sits below `mirrorReal`. Walking
 *  with path.dirname keeps the platform's root intact ('/' on POSIX, 'C:\\'
 *  or a UNC share on Windows) — rebuilding the string from segments loses it.
 *  This keeps a resolved mirror path comparable with the session cwd it came
 *  from, even when only one of the two was written through a link. */
function spellLike(base, mirrorReal, baseReal) {
  const rel = path.relative(baseReal, mirrorReal)
  if (!rel) return base
  let out = base
  for (let i = 0; i < rel.split(/[\\/]+/).filter(Boolean).length; i++) out = path.dirname(out)
  return out
}

/**
 * Resolve which remote workspace a LOCAL path belongs to by scanning the mirror
 * registry for the mirror that contains it.
 *
 * Mirrors live exactly one level under the registry root as
 * `<host>-<user>-<port>/<basename>`, and `mirrorDirFor()` appends a short hash
 * when two remote paths share a basename, so containment is unambiguous. The
 * longest containing path still wins, which keeps the result stable if a
 * future layout ever nests them.
 *
 * A mirror whose meta is missing, unparsable, or has no `host` is skipped
 * rather than guessed at: reporting no binding makes the caller refuse loudly,
 * while guessing would send commands to an unintended host.
 *
 * @param {string} local - absolute local path, typically a session's cwd.
 * @param {string} root - the mirror registry root (`$DSH_HOME/remote-workspaces`).
 * @returns {{mirrorDir: string|null, remotePath: string, machine: {host: string, port: number, username: string, alias: string}|null}}
 *   `machine` is the mirror-recorded origin (`alias` is the ~/.ssh/config alias
 *   it was created through, '' when the machine uses literal values), or null
 *   when `local` is not inside a usable mirror (in which case `remotePath` is
 *   empty too).
 */
export function resolveMirror(local, root) {
  let mirrorDir = null
  let remotePath = ''
  let machine = null
  if (!local || !root || !existsSync(root)) return { mirrorDir, remotePath, machine }
  const base = norm(local)
  const realBase = tryRealpath(local)
  // Issue #173: the registry root is spelled the way DSH_HOME is written
  // (`~/.dsh/...`), while a session's cwd can be spelled through a junction or
  // symlink to that same directory (or the reverse). A purely lexical prefix
  // comparison then says "not inside any mirror" and every rw_* tool refuses
  // the session as LOCAL. Scanning both spellings keeps a plain prefix test
  // usable and lets the reported mirrorDir keep the cwd's own spelling.
  const scanRoots = [norm(root)]
  const realRoot = tryRealpath(root)
  if (!samePath(realRoot, scanRoots[0])) scanRoots.push(realRoot)
  const seen = new Set()
  for (const scanRoot of scanRoots) {
    for (const mirror of mirrorsUnder(scanRoot)) {
      // Prefer the spelling the cwd already uses; fall back to resolving the
      // mirror itself when only the mirror's tail is a link.
      const resolved = isUnder(base, mirror.dir)
        ? mirror.dir
        : (isUnder(realBase, tryRealpath(mirror.dir)) ? spellLike(base, tryRealpath(mirror.dir), realBase) : null)
      if (!resolved) continue
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
      if (seen.has(key)) continue
      // Deepest match wins; the same physical mirror seen under two spellings
      // must not be reported twice.
      if (mirrorDir && depth(resolved) <= depth(mirrorDir)) continue
      let meta
      try {
        meta = JSON.parse(readFileSync(mirror.metaPath, 'utf8'))
      } catch { continue /* unparsable meta → not a usable binding */ }
      if (!meta || !meta.host) continue
      seen.add(key)
      mirrorDir = resolved
      remotePath = String(meta.remotePath || '')
      machine = {
        host: String(meta.host),
        port: Number(meta.port) || 22,
        username: String(meta.username || ''),
        // The ~/.ssh/config alias this mirror was created through, when the
        // machine was saved as one (issue #38): it keeps the mirror bound to
        // its machine even if that alias's HostName/port later change.
        alias: String(meta.alias || ''),
      }
    }
  }
  return { mirrorDir, remotePath, machine }
}

/** Every mirror directory (one that carries a meta file) directly under `root`. */
function mirrorsUnder(root) {
  const found = []
  let hostDirs
  try {
    hostDirs = readdirSync(root)
  } catch {
    return found
  }
  for (const hostDir of hostDirs) {
    const hostPath = path.join(root, hostDir)
    if (!statSync(hostPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
    let entries
    try {
      entries = readdirSync(hostPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = norm(path.join(hostPath, entry))
      const metaPath = path.join(dir, '.dsh-remote-meta.json')
      if (existsSync(metaPath)) found.push({ dir, metaPath })
    }
  }
  return found
}

/**
 * Stable pool key for a remote identity. Two sessions on the same machine
 * produce the same key and therefore share one SSH connection; sessions on
 * different machines never collide.
 * @param {{host: string, port?: number|string, username?: string}} m - the remote identity.
 * @returns {string} the canonical `user@host:port` key.
 */
export function poolKey(m) {
  return `${(m && m.username) || ''}@${(m && m.host) || ''}:${Number(m && m.port) || 22}`
}

/** Safe path segment for a session id (mirrors DSH's encodeSegment). */
export function encodeSegmentSafe(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9._-]/g, '_')
  return s || 'session'
}

function sessionHeaderLine(file, buf, partial = false) {
  if (/\.z(?:st|std)$/.test(file)) buf = zlib.zstdDecompressSync(buf)
  else if (/\.gz$/.test(file)) {
    buf = zlib.gunzipSync(buf, partial ? { finishFlush: zlib.constants.Z_SYNC_FLUSH } : undefined)
  }
  const nl = buf.indexOf(10)
  return nl < 0 ? '' : buf.subarray(0, nl).toString('utf8')
}

function readSessionHeader(file) {
  try {
    const fd = openSync(file, 'r')
    try {
      // The first JSONL line or compressed frame usually fits in the prefix.
      const prefix = Buffer.allocUnsafe(8192)
      const size = readSync(fd, prefix, 0, prefix.length, 0)
      let line
      if (size < prefix.length) {
        line = sessionHeaderLine(file, prefix.subarray(0, size))
      } else {
        try { line = sessionHeaderLine(file, prefix, true) } catch { /* frame extends past the prefix */ }
        if (!line) line = sessionHeaderLine(file, readFileSync(fd))
      }
      return line ? JSON.parse(line) : undefined
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

/** Read the cwd from a session log header (JSONL / .gz / zstd first frame). */
export function readSessionHeaderCwd(file) {
  const header = readSessionHeader(file)
  return typeof header?.cwd === 'string' ? header.cwd : ''
}

/** Read session logs written by any DSH release: `session.<format>.jsonl[.zst|.gz]`.
 *  The format segment (`v4`, `v3`, …) changes between releases, so a fixed name
 *  list silently stopped finding the cwd of every newer session. */
const SESSION_LOG_RE = /^session(\.[A-Za-z0-9]+)*\.jsonl(\.zst|\.zstd|\.gz)?$/

/** Newest session log in a session directory, or '' when there is none. */
function sessionLogFile(sessDir) {
  try {
    const names = readdirSync(sessDir).filter((n) => SESSION_LOG_RE.test(n))
    if (!names.length) return ''
    // Highest format version first, compressed before raw; only the header line
    // matters, so the first readable file is enough.
    const rank = (n) => {
      const version = /\.v(\d+)\./.exec(n)
      return [version ? Number(version[1]) : 0, /\.(zst|zstd|gz)$/.test(n) ? 1 : 0]
    }
    names.sort((a, b) => {
      const [av, ac] = rank(a)
      const [bv, bc] = rank(b)
      return bv - av || bc - ac || a.localeCompare(b)
    })
    return names.map((n) => path.join(sessDir, n)).find((p) => existsSync(p)) || ''
  } catch { return '' }
}

/** Read a persisted session's cwd for ownership checks in its own directory. */
export function readStoredSessionCwd(dir, id) {
  const file = sessionLogFile(dir)
  if (!file) return ''
  try {
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return ''
    const header = readSessionHeader(file)
    if (header?.type !== 'session' || header.id !== id) return ''
    return typeof header.cwd === 'string' ? header.cwd : ''
  } catch {
    return ''
  }
}

/**
 * Resolve a session's workspace cwd from the live sessions service, then from
 * durable session logs under `$DSH_HOME/sessions`.
 */
export function lookupSessionCwd(sessionId, { sessions, dshHome } = {}) {
  if (!sessionId) return ''
  try {
    if (sessions && typeof sessions.get === 'function') {
      const s = sessions.get(sessionId)
      const cwd = s && s.header && s.header.cwd
      if (cwd) return String(cwd)
    }
  } catch { /* sessions service unavailable */ }
  if (!dshHome) return ''
  try {
    const sessionsRoot = path.join(dshHome, 'sessions')
    if (!existsSync(sessionsRoot)) return ''
    const targetDir = encodeSegmentSafe(sessionId)
    for (const projDir of readdirSync(sessionsRoot)) {
      const projPath = path.join(sessionsRoot, projDir)
      if (!statSync(projPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
      const sessDir = path.join(projPath, targetDir)
      if (!statSync(sessDir, { throwIfNoEntry: false })?.isDirectory?.()) continue
      const logFile = sessionLogFile(sessDir)
      if (!logFile) continue
      const cwd = readSessionHeaderCwd(logFile)
      if (cwd) return cwd
    }
  } catch { /* session log scan failed */ }
  return ''
}

/** Pull sessionId / local from a JSON HTTP request (query string + body). */
export function requestSessionHint(req, body = {}) {
  let sessionId = ''
  let local = ''
  try {
    const q = new URL(req.url || '', 'http://localhost').searchParams
    // URLSearchParams has already decoded these values. Decoding twice can
    // discard a literal '%' in a mirror path and lose its machine binding.
    sessionId = q.get('sessionId') || ''
    local = q.get('local') || ''
  } catch { /* malformed url */ }
  if (!sessionId && body && body.sessionId) sessionId = String(body.sessionId)
  if (!local && body && body.local) local = String(body.local)
  return { sessionId: String(sessionId || '').trim(), local: String(local || '').trim() }
}
