// dsh-remote — portable recursive search over SFTP.
// Replaces `find … -exec grep` (which needs a POSIX shell and dies on
// Windows remotes). Walks the remote tree over SFTP readdir/stat/readFile with
// the same bounded-parallelism + ignore rules as the mirror sync.
import { joinRemotePath } from './paths.js'

function mapLimit(items, limit, fn) {
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
  return Promise.all(workers)
}

/** fnmatch-lite for the `glob` filter (matches the entry BASENAME). */
export function matchGlob(name, glob) {
  let re = ''
  let i = 0
  const g = String(glob || '')
  while (i < g.length) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i += 2; continue }
      re += '[^/]*'; i++; continue
    }
    if (c === '?') { re += '[^/]'; i++; continue }
    if ('\\^$+{}[]()|.'.includes(c)) re += '\\' + c
    else re += c
    i++
  }
  return new RegExp('^' + re + '$').test(String(name))
}

const BINARY_SNIFF = 8192
function looksBinary(buf) {
  const n = Math.min(buf.length, BINARY_SNIFF)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/**
 * Recursively search a remote directory.
 * @returns {Promise<{matches: Array<{path, line, text}>, scanned: number, truncated: boolean}>}
 */
export async function searchTree(sftp, rootDir, opts = {}) {
  const {
    regex,             // RegExp (already compiled with ignoreCase where asked)
    glob,              // optional basename glob filter
    contextLines = 0,
    maxMatches = 500,
    maxDepth = 12,
    maxFiles = 20000,
    maxScanBytes = 1024 * 1024,
    isIgnored = () => false,
  } = opts

  const matches = []
  let scanned = 0
  let truncated = false

  const walk = async (dir, depth) => {
    if (truncated || scanned >= maxFiles) return
    let entries = []
    try { entries = (await sftp.readdir(dir)) || [] } catch { return }
    const dirs = []
    for (const e of entries) {
      const name = String(e.filename)
      if (name === '.' || name === '..') continue
      const isDir = !!(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory())
      if (isDir) dirs.push(name)
    }
    // Depth-first, dirs first, but stop as soon as we hit caps.
    for (const name of dirs) {
      if (truncated || scanned >= maxFiles) return
      if (depth <= 0) continue
      const sub = joinRemotePath(dir, name)
      if (isIgnored(name, true)) continue
      await walk(sub, depth - 1)
    }
    if (truncated || scanned >= maxFiles) return

    const fileNames = entries
      .filter((e) => !(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory()))
      .map((e) => String(e.filename))
      .filter((n) => n !== '.' && n !== '..')
    await mapLimit(fileNames, 4, async (name) => {
      if (truncated || scanned >= maxFiles || matches.length >= maxMatches) return
      if (glob && !matchGlob(name, glob)) return
      if (isIgnored(name, false)) return
      const fp = joinRemotePath(dir, name)
      scanned++
      let st
      try { st = await sftp.stat(fp) } catch { return }
      if (st.size > maxScanBytes) return
      let buf
      try { buf = await sftp.readFile(fp) } catch { return }
      if (looksBinary(buf)) return
      const content = buf.toString('utf8').replace(/\r\n/g, '\n')
      const lines = content.split('\n')
      const hitLines = new Set()
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          regex.lastIndex = 0
          for (let c = Math.max(0, i - contextLines); c <= Math.min(lines.length - 1, i + contextLines); c++) {
            hitLines.add(c)
          }
          if (matches.length >= maxMatches) { truncated = true; return }
        }
      }
      if (hitLines.size) {
        for (const ln of [...hitLines].sort((a, b) => a - b)) {
          if (matches.length >= maxMatches) { truncated = true; return }
          matches.push({ path: fp, line: ln + 1, text: lines[ln] })
        }
      }
    })
  }

  await walk(rootDir, maxDepth)
  return { matches, scanned, truncated }
}
