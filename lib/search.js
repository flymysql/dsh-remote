// dsh-remote — portable recursive search over SFTP.
// Replaces `find … -exec grep` (which needs a POSIX shell and dies on
// Windows remotes). Walks the remote tree over SFTP readdir/stat/readFile with
// the same bounded-parallelism + ignore rules as the mirror sync.
import { joinRemotePath, relPathUnder, shq } from './paths.js'

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
 *
 * Cancellation (issue #44): the walk takes an AbortSignal and checks it at every
 * directory and every entry. Before this it was completely uninterruptible —
 * no signal was accepted and no flag was consulted — so a large-tree search
 * could never be stopped: DSH tool cancellation is *cooperative*
 * (@deepseek-ai/dsh-tool-call-timeout-policy can only ask a tool to stop), which
 * meant `session/cancel`, steering, and the tool timeout policy all had no
 * effect and the turn stayed `running` forever. On abort we return the partial
 * result instead of throwing, so the model still gets whatever was found.
 *
 * @param {object} sftp - pooled SFTP client
 * @param {string} rootDir
 * @param {object} opts - `signal` (AbortSignal), `maxDurationMs`, plus the caps below
 * @returns {Promise<{matches: Array<{path, line, text}>, scanned: number, truncated: boolean, cancelled?: boolean}>}
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
    maxDurationMs = 0, // 0 = no wall-clock budget
    isIgnored = () => false,
    signal,
  } = opts

  const matches = []
  let scanned = 0
  let truncated = false
  let cancelled = false
  const startedAt = Date.now()

  /** True when the caller asked us to stop (abort, time budget, or a full cap). */
  const shouldStop = () => {
    if (cancelled || truncated) return true
    if (signal && signal.aborted) { cancelled = true; return true }
    if (maxDurationMs > 0 && Date.now() - startedAt >= maxDurationMs) { truncated = true; return true }
    // A full cap is itself the honest truncation signal — there may be more
    // matches beyond it in files this walk never reads. Before this branch,
    // `truncated` was only set when a FURTHER match arrived past the cap, but
    // the per-entry guard skips remaining files unread, so a cap filled exactly
    // on a file's last matching line never set it: shouldStop never fired, the
    // directory loop burned a readdir round-trip on every remaining directory,
    // and the walk ended with truncated:false while dropping matches (or said
    // TRUNCATED only after maxDurationMs burned). Continues the issue #44
    // hardening: a cancellable walk must also stop for its own caps.
    if (matches.length >= maxMatches) { truncated = true; return true }
    return false
  }

  const walk = async (dir, depth) => {
    if (shouldStop() || scanned >= maxFiles) return
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
      if (shouldStop() || scanned >= maxFiles) return
      if (depth <= 0) continue
      const sub = joinRemotePath(dir, name)
      // isIgnored receives the path RELATIVE to the search root (the same
      // contract sync has), so root-anchored ignore rules — `/proc/` when the
      // workspace is the filesystem root (issue #60), `Library/Caches/` in the
      // default search set — actually match here; a bare basename would never
      // satisfy an anchored pattern and those rules were silently dead.
      if (isIgnored(relPathUnder(rootDir, sub) || name, true)) continue
      await walk(sub, depth - 1)
    }
    if (shouldStop() || scanned >= maxFiles) return

    const fileNames = entries
      .filter((e) => !(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory()))
      .map((e) => String(e.filename))
      .filter((n) => n !== '.' && n !== '..')
    await mapLimit(fileNames, 4, async (name) => {
      // Checked per entry: this is the loop that used to run for hours.
      if (shouldStop() || scanned >= maxFiles || matches.length >= maxMatches) return
      if (glob && !matchGlob(name, glob)) return
      const fp = joinRemotePath(dir, name)
      if (isIgnored(relPathUnder(rootDir, fp) || name, false)) return
      scanned++
      let st
      try { st = await sftp.stat(fp) } catch { return }
      if (shouldStop()) return
      if (st.size > maxScanBytes) return
      let buf
      try { buf = await sftp.readFile(fp) } catch { return }
      if (shouldStop()) return
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
  if (scanned >= maxFiles) truncated = true
  return { matches, scanned, truncated, cancelled }
}

function parseGrepLines(stdout, maxMatches) {
  const matches = []
  let truncated = false
  for (const line of String(stdout || '').split('\n')) {
    if (!line) continue
    const m = line.match(/^(.*?):(\d+):(.*)$/)
    if (!m) continue
    if (matches.length >= maxMatches) { truncated = true; break }
    matches.push({ path: m[1], line: Number(m[2]), text: m[3] })
  }
  return { matches, truncated }
}

/**
 * POSIX fast path: `rg` then `grep -R`. Returns null when the remote has
 * neither, so the caller can fall back to an SFTP walk (Windows / no grep).
 */
export async function searchViaShell(pool, rootDir, opts = {}) {
  const {
    pattern,
    ignoreCase = true,
    glob,
    contextLines = 0,
    maxMatches = 500,
    signal,
  } = opts
  // Honour an already-aborted signal before spawning a remote grep on a huge tree.
  if (signal && signal.aborted) {
    return { matches: [], scanned: 0, truncated: false, cancelled: true, via: 'none' }
  }
  const ic = ignoreCase ? ' -i' : ''
  const globFlag = glob ? ` --glob ${shq(glob)}` : ''
  const ctx = contextLines > 0 ? ` -C ${Number(contextLines)}` : ''
  const rg = `rg -n --no-heading -I${ic}${globFlag}${ctx} --max-count ${maxMatches} -- ${shq(pattern)} ${shq(rootDir)}`
  const grepGlob = glob ? ` --include=${shq(glob)}` : ''
  const grep = `grep -R -n -I -E${ic}${grepGlob}${ctx} -- ${shq(pattern)} ${shq(rootDir)}`
  const script = `if command -v rg >/dev/null 2>&1; then ${rg}; elif command -v grep >/dev/null 2>&1; then ${grep}; else exit 127; fi`
  const res = await pool.exec(script, { timeoutMs: opts.timeoutMs, signal })
  // A cancelled call must return as cancelled (with whatever partial output the
  // remote produced), NOT throw: throwing would make searchRemote fall through
  // to the slower SFTP walk, i.e. keep running after the caller said stop.
  if (res.signal === 'ABORTED') {
    const partial = parseGrepLines(res.stdout, maxMatches)
    return { matches: partial.matches, scanned: partial.matches.length, truncated: false, cancelled: true, via: 'none' }
  }
  // 0 = hits, 1 = no hits; other codes mean the tools are missing / failed.
  if (res.signal === 'TIMEOUT') throw new Error('search timed out')
  if (res.code !== 0 && res.code !== 1) throw new Error(res.stderr || `search exit ${res.code}`)
  const parsed = parseGrepLines(res.stdout, maxMatches)
  return {
    matches: parsed.matches,
    scanned: parsed.matches.length,
    truncated: parsed.truncated || /truncated|max-count/i.test(String(res.stderr || '')),
    via: /rg/.test(String(res.stderr || '')) ? 'rg' : 'grep',
  }
}

/** Prefer a POSIX grep/rg, fall back to the portable SFTP walk. */
export async function searchRemote(pool, rootDir, opts = {}) {
  if (pool && pool.platform !== 'windows') {
    try {
      const fast = await searchViaShell(pool, rootDir, opts)
      if (fast && Array.isArray(fast.matches)) return fast
    } catch (e) {
      // An abort is terminal, not a "try the slower fallback" signal.
      if (opts.signal && opts.signal.aborted) {
        return { matches: [], scanned: 0, truncated: false, cancelled: true, via: 'none' }
      }
    }
  }
  const sftp = await pool.sftp()
  return searchTree(sftp, rootDir, opts)
}
