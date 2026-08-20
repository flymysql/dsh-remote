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

/** Create every level of a remote dir via SFTP (mkdir -p semantics), working
 * for both POSIX (`/a/b`) and Windows (`D:\a\b`) paths. Best effort: an
 * existing or permission-denied level is skipped. */
export async function mkdirRemoteDirs(sftp, dir) {
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

/** Basename of a remote absolute path (POSIX or Windows). */
export function remotePathBase(p) {
  const norm = normalizeRemotePath(p).replace(/[\\/]+$/, '')
  const base = norm.split(/[\\/]/).pop()
  // Windows drive root (D:\) has no meaningful basename
  if (!base || /^[a-zA-Z]:$/.test(base)) return 'workspace'
  return base
}

/** Relative path of `p` under `root` (POSIX form, no leading slash), or null
 * when `p` is not inside `root`. Both POSIX and Windows drive paths work
 * (Windows is compared in its `/D:/…` POSIX-equivalent form). */
export function relPathUnder(root, p) {
  const posix = (x) => {
    let n = normalizeRemotePath(x).replace(/[\\/]+$/, '')
    const m = n.match(/^([a-zA-Z]):(.*)$/s)
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

export function truncate(s, max) {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[truncated: ${s.length - max} more chars]`
}

/** 32-bit string hash rendered in base36 (short, collision-safe enough). */
export function shortHash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}
