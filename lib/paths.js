// dsh-remote — pure path / shell helpers (no fs, no ssh).
// Split out of lib/index.js so they are unit-testable without loading the
// plugin. Both POSIX (`/a/b`) and Windows (`D:\Code`, `\\server\share`) forms
// are supported everywhere.

/** Single-quote one shell argument verbatim. */
export function shq(s) {
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
export function normalizeRemotePath(p) {
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
export function joinRemotePath(dir, name) {
  const d = String(dir)
  if (!d) return String(name)
  if (d.endsWith('/') || d.endsWith('\\')) return d + String(name)
  return d + (d.includes('\\') ? '\\' : '/') + String(name)
}

/** Parent dir of a remote absolute path (string-level; POSIX or Windows). */
export function remoteDirname(p) {
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

/** Create every level of a remote dir via SFTP (true mkdir -p: parents AND the
 * target itself), working for both POSIX (`/a/b`) and Windows (`D:\a\b`)
 * paths. Best effort: an existing or permission-denied level is skipped.
 * FILE-oriented callers must pass the parent dir (remoteDirname(filePath)). */
export async function mkdirRemoteDirs(sftp, dir) {
  const target = normalizeRemotePath(dir)
  const isWin = target.includes('\\')
  // Split off a Windows drive prefix (D:) so it is not treated as a segment.
  const drive = isWin ? (target.match(/^([a-zA-Z]:)[\\/]?(.*)$/s) || null) : null
  const segs = drive ? drive[2].split(/[\\/]/).filter(Boolean) : target.split(/[\\/]/).filter(Boolean)
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

/**
 * Convert an internal remote path (POSIX `/a/b` or Windows `D:\Code`) into the
 * path format the SFTP server understands.
 *
 * Windows OpenSSH's sftp-server accepts POSIX-style paths: a drive letter is
 * written `/D:/…` (equivalent to `D:\…`). POSIX paths pass through unchanged.
 * UNC paths are kept as-is (the server resolves `\\server\share` itself).
 */
export function toSftpPath(p) {
  const norm = normalizeRemotePath(p)
  const m = norm.match(/^([a-zA-Z]):\\(.*)$/s)
  if (m) return '/' + m[1] + ':/' + m[2].replace(/\\/g, '/')
  return norm
}

/**
 * Convert a remote path to the form used in SHELL commands on the remote.
 *
 * On Windows remotes running Git Bash, native `D:\Code` (or `D:/Code`,
 * `/D:/Code`, `/d/Code`) becomes the Git-Bash mount form `/d/Code`; a path
 * already in Git-Bash form passes through unchanged. UNC (`\\server\share`)
 * maps to `//server/share`. POSIX paths are normalized as-is. The conversion
 * is syntactic, so it is safe on POSIX remotes too (only unambiguous Windows
 * forms are rewritten).
 */
export function toShellPath(p) {
  let t = String(p || '').replace(/\\/g, '/')
  const unc = t.match(/^\/\/([^/]+)(?:\/(.*))?$/)
  if (unc) return '//' + unc[1] + (unc[2] ? '/' + unc[2] : '')
  const drive = t.match(/^([a-zA-Z]):(\/|$)/) || t.match(/^\/([a-zA-Z]):(\/|$)/)
  if (drive) {
    t = '/' + drive[1].toLowerCase() + (drive[2] ? '/' : '') + t.slice(drive[0].length)
  }
  const parts = []
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  return '/' + parts.join('/')
}

/**
 * Display form of a path for a Windows remote: a Git-Bash mount `/d/Code` (or
 * `/D:/Code`, `D:/Code`) renders as `D:\Code`; anything else (POSIX paths,
 * native Windows paths) is returned normalized. POSIX remotes always pass
 * through unchanged.
 */
export function toDisplayPath(p, platform) {
  if (platform !== 'windows') return normalizeRemotePath(p)
  const t = String(p || '').replace(/\\/g, '/')
  // /X:/rest (Win32-OpenSSH SFTP form)
  const gs = t.match(/^\/([a-zA-Z]):\/(.*)$/)
  if (gs) return gs[1].toUpperCase() + ':\\' + gs[2].replace(/\//g, '\\')
  // /x/rest (Git-Bash mount form) and bare /x
  const git = t.match(/^\/([a-zA-Z])(?:\/(.*))?$/)
  if (git) return git[1].toUpperCase() + ':\\' + (git[2] || '').replace(/\//g, '\\')
  // native X:/rest
  const drive = t.match(/^([a-zA-Z]):(?:\/(.*))?$/)
  if (drive) return drive[1].toUpperCase() + ':\\' + (drive[2] || '').replace(/\//g, '\\')
  return t
}

/** Basename of a remote absolute path (POSIX or Windows). */
export function remotePathBase(p) {
  const norm = normalizeRemotePath(p).replace(/[\\/]+$/, '')
  const base = norm.split(/[\\/]/).pop()
  // Windows drive root (D:\) has no meaningful basename
  if (!base || /^[a-zA-Z]:$/.test(base)) return 'workspace'
  return base
}

/**
 * Workspace title for a REMOTE mirror: `<machine>-<remote basename>`.
 *
 * The Harness derives a Workspace title from the basename of the directory it
 * registers, and a remote workspace is registered on its LOCAL mirror
 * (`$DSH_HOME/remote-workspaces/<host>-<user>-<port>/<basename>`). That last
 * segment is still the remote basename, so a local `/mnt/xdfs` and a remote
 * `/mnt/xdfs` both read "xdfs". dsh-remote pre-registers the mirror with this
 * host-qualified title, so the two are distinguishable from the start.
 *
 * The machine's display name wins; a machine saved without one (or named after
 * the folder itself) falls back to its host. A workspace title must be
 * non-empty, so the bare basename is the last resort.
 *
 * @param {string} remotePath - remote workspace directory (POSIX or Windows).
 * @param {{name?: string, host?: string}} [machine] - the machine registry record.
 * @returns {string} a non-empty, host-qualified title.
 */
export function remoteWorkspaceTitle(remotePath, machine) {
  const base = remotePathBase(remotePath)
  const label = String((machine && machine.name) || '').trim()
  const host = String((machine && machine.host) || '').trim()
  if (label && label !== base) return label + '-' + base
  if (host && host !== base) return host + '-' + base
  return base
}

/** Relative path of `p` under `root` (POSIX form, no leading slash), or null
 * when `p` is not inside `root`. Both POSIX and Windows drive paths work
 * (Windows is compared in its `/d:/…` POSIX-equivalent form, including `/D:/…`
 * SFTP paths). */
export function relPathUnder(root, p) {
  const posix = (x) => {
    let n = normalizeRemotePath(x).replace(/[\\/]+$/, '')
    const m = n.match(/^\/?([a-zA-Z]):(.*)$/s)
    if (m) return '/' + m[1].toLowerCase() + ':/' + (m[2] ? m[2].replace(/\\/g, '/').replace(/^\/+/, '') : '')
    return n.replace(/\\/g, '/')
  }
  const r = posix(root)
  const n = posix(p)
  if (n === r) return ''
  const prefix = r === '/' ? '/' : r + '/'
  if (n.startsWith(prefix)) return n.slice(prefix.length)
  return null
}

/**
 * Join a workspace-relative path onto a remote root, segment by segment, so the
 * root's separator style (`/` on POSIX, `\` on Windows) is preserved.
 */
export function joinRemoteRel(base, rel) {
  let out = base
  for (const segment of String(rel || '').split(/[\\/]+/)) {
    if (!segment || segment === '.') continue
    out = joinRemotePath(out, segment)
  }
  return out
}

/**
 * Resolve a tool's `path` argument against a session's remote workspace root `ws`.
 *
 * - Relative paths (`src/main.c`, `./a`, empty) resolve under `ws` (issue #39).
 * - If `mirrorDir` is given and `raw` points at `mirrorDir` itself or a child
 *   under `mirrorDir` (because the harness reports the local mirror as the
 *   session's working directory), the mirror prefix is stripped and mapped
 *   onto `ws` instead of being sent to SFTP as a literal local path.
 * - Any other absolute POSIX (`/a/b`), Windows (`D:\a`, `/D:/a`) or UNC
 *   (`\\host\share`) path passes through `normalizeRemotePath()` unchanged.
 */
export function resolveRemoteWorkspacePath(ws, raw, mirrorDir = '') {
  const s = String(raw ?? '').trim()
  if (mirrorDir && ws && s) {
    const mirrorRel = relPathUnder(mirrorDir, s)
    if (mirrorRel !== null) {
      return normalizeRemotePath(mirrorRel ? joinRemoteRel(ws, mirrorRel) : ws)
    }
  }
  const absolute = s.startsWith('/') || s.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(s)
  if (absolute) return normalizeRemotePath(s)
  const rel = s.replace(/^\.\//, '').replace(/^[\\/]+/, '')
  if (!rel) return normalizeRemotePath(ws || '')
  return normalizeRemotePath(ws ? joinRemoteRel(ws, rel.replace(/\\/g, '/')) : rel)
}

export function truncate(s, max) {
  // A missing/NaN cap is a CONFIG BUG (measured: a bare `new SshPool({...})`
  // with no maxOutputChars turned EVERY exec result into a 29-char truncation
  // marker — `'x'.length <= undefined` is false, so the "cap" branch always ran
  // and `s.length - undefined` printed NaN — silently destroying every remote
  // output, including the web-attach startup token). A bad cap must disable
  // truncation, not destroy the string.
  const limit = Number(max)
  if (!Number.isFinite(limit) || limit <= 0) return s
  if (s.length <= limit) return s
  return s.slice(0, limit) + `\n…[truncated: ${s.length - limit} more chars]`
}

/** 32-bit string hash rendered in base36 (short, collision-safe enough). */
export function shortHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
