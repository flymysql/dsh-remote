// Shared remote SFTP helpers used by both rw_* tools and the sidebar HTTP routes.
import { joinRemotePath, normalizeRemotePath } from './paths.js'
import { remoteRevision } from './remote-write.js'

/** Structured listing: name + type + size + mtime + mode (SFTP protocol-level). */
export async function listDirStructured(sftp, p) {
  const target = normalizeRemotePath(p || '/')
  let list
  try {
    list = await sftp.readdir(target)
  } catch (err) {
    const msg = String((err && err.message) || err)
    if (/no such file|not found|does not exist|ENOENT/i.test(msg)) {
      return { path: target, items: [], missing: true }
    }
    throw new Error('browse failed: ' + msg)
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
  if (symIdx.length) {
    // Resolve what each symlink POINTS TO. This must be stat (follows links),
    // not lstat: lstat describes the link itself, so a symlink to a directory
    // was misclassified as 'file' and the workspace picker refused to enter
    // it (issue #59). A dangling link fails stat and degrades to 'file'.
    await Promise.all(symIdx.map(async (i) => {
      const full = joinRemotePath(target, items[i].name)
      try {
        const st = await sftp.stat(full)
        items[i].type = st && st.isDirectory && st.isDirectory() ? 'dir' : 'file'
        items[i].link = true
      } catch { items[i].type = 'file' /* dangling link: degrade to file */ }
    }))
  }
  return { path: target, items }
}

/** Windows drive letters as display-form dir entries ("This PC" root view). */
export async function listRemoteDrives(sshPool) {
  let letters = []
  try {
    const res = await sshPool.exec('cmd /c fsutil fsinfo drives', { timeoutMs: Math.min(sshPool.config.commandTimeoutMs || 8000, 8000) })
    letters = [...String(res.stdout || '').matchAll(/([a-zA-Z]):\\?/g)].map((mm) => mm[1].toUpperCase())
  } catch {}
  if (!letters.length) {
    try {
      const res = await sshPool.exec('ls -d /[a-z] 2>/dev/null', { timeoutMs: Math.min(sshPool.config.commandTimeoutMs || 8000, 8000) })
      letters = String(res.stdout || '')
        .split(/\s+/)
        .map((s) => s.replace(/^\/+|\/+$/g, ''))
        .filter((s) => /^[a-zA-Z]$/.test(s))
        .map((s) => s.toUpperCase())
    } catch {}
  }
  return [...new Set(letters)].sort().map((l) => ({ name: l + ':\\', path: l + ':\\', type: 'dir', drive: true, size: 0, mtime: 0 }))
}

/** Recursive remote delete (bounded): unlink files bottom-up, then rmdir. */
export async function removeRemoteTree(sftp, p, maxFiles = 2000) {
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

/** MIME types for image formats the preview panel can render inline. */
const IMAGE_MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/**
 * Read a remote file for the sidebar/editor. Oversized files use a range read
 * (`readPartial`) so we never `fastGet` the whole blob onto disk.
 *
 * Images are the exception (issue #66): a PREFIX of an image is a broken
 * picture, not a preview, so for a recognised image extension the caller's
 * text-oriented cap is skipped and the file is read whole up to the hard 2MB
 * ceiling; the panel renders it inline as `<img src="data:…">`. An image past
 * the ceiling degrades to the plain binary stub + download button rather than
 * shipping a guaranteed-broken half render. (`<img>` is also the safe sink
 * for SVG: unlike inline markup it cannot run the file's scripts.)
 */
export async function previewRemoteFile(sftp, target, opts = {}) {
  const {
    maxBytes = 256 * 1024,
    encoding = 'utf-8',
    decodeBuf = (buf) => buf.toString('utf8'),
  } = opts
  const hardCap = 2 * 1024 * 1024
  const name = String(target).split(/[\\/]/).pop() || ''
  const imageMime = IMAGE_MIME_TYPES[(name.split('.').pop() || '').toLowerCase()]
  const cap = imageMime ? hardCap : Math.min(Math.max(Number(maxBytes) || 256 * 1024, 1024), hardCap)
  const st = await sftp.stat(target)
  const mtime = st && typeof st.mtime === 'number' ? st.mtime : 0
  const size = st && typeof st.size === 'number' ? st.size : 0
  let buf
  let truncated = false
  if (size > cap) {
    truncated = true
    if (typeof sftp.readPartial === 'function') {
      buf = await sftp.readPartial(target, 0, cap)
    } else {
      const full = await sftp.readFile(target)
      buf = full.subarray(0, cap)
    }
  } else {
    buf = await sftp.readFile(target)
  }
  if (imageMime && !truncated) {
    return { ok: true, binary: false, image: true, mime: imageMime, content: buf.toString('base64'), truncated, size, mtime }
  }
  if (looksBinary(buf)) {
    return {
      ok: true, binary: true, size, mtime,
      head: buf.slice(0, Math.min(buf.length, 4096)).toString('base64'),
      truncated,
    }
  }
  const decoded = decodeBuf(buf, encoding)
  // Empty/no-newline files default to LF for future edits. A bare CR is kept
  // in the conservative 'mixed' bucket: clients must not rewrite it silently.
  const crlf = /\r\n/.test(decoded)
  const eol = /\r(?!\n)/.test(decoded) || crlf && /(^|[^\r])\n/.test(decoded) ? 'mixed' : crlf ? 'crlf' : 'lf'
  let content = decoded.replace(/\r\n/g, '\n')
  if (!truncated && content.length > cap) {
    truncated = true
    content = content.slice(0, cap)
  }
  if (truncated) content += `\n…[truncated: ${Math.max(0, size - cap)} more bytes]`
  return { ok: true, binary: false, content, truncated, size, mtime, ...(!truncated ? { revision: remoteRevision(buf), eol } : {}) }
}
