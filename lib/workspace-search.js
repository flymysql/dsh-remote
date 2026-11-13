// Incremental remote workspace search. A job is owned by one session binding;
// cancelling it never closes the SSH pool used by other sessions or terminals.
import { randomUUID } from 'node:crypto'
import { joinRemotePath } from './paths.js'
import { requestSessionHint } from './binding.js'
import { matchGlob } from './search.js'

function interrupted(signal) { return Object.assign(new Error(signal.reason === 'timeout' ? 'Search time budget reached' : 'Search cancelled'), { name: 'AbortError' }) }
// A cancelled caller must stop waiting immediately, but an SSH request already
// sent still owns capacity until its actual promise settles. Otherwise rapid
// typing can leave unlimited abandoned reads on the shared SFTP channel.
class SearchOperations {
  constructor(limit = 6) { this.limit = limit; this.active = 0; this.waiting = [] }
  run(operation, signal) {
    if (signal.aborted) return Promise.reject(interrupted(signal))
    return new Promise((resolve, reject) => {
      const entry = { operation, signal, resolve, reject, started: false }
      entry.abort = () => {
        if (!entry.started) {
          const index = this.waiting.indexOf(entry)
          if (index >= 0) this.waiting.splice(index, 1)
          signal.removeEventListener('abort', entry.abort)
        }
        reject(interrupted(signal))
      }
      signal.addEventListener('abort', entry.abort, { once: true })
      this.waiting.push(entry)
      this.pump()
    })
  }
  pump() {
    while (this.active < this.limit && this.waiting.length) {
      const entry = this.waiting.shift()
      if (entry.signal.aborted) { entry.abort(); continue }
      entry.started = true
      this.active++
      Promise.resolve().then(() => {
        if (entry.signal.aborted) throw interrupted(entry.signal)
        return entry.operation()
      }).then(entry.resolve, entry.reject).finally(() => {
        entry.signal.removeEventListener('abort', entry.abort)
        this.active--
        this.pump()
      })
    }
  }
}

function matchingSnippet(line, normalizedIndex, queryLength, normalizedLength) {
  let startMatch = normalizedIndex, endMatch = normalizedIndex + queryLength
  if (normalizedLength !== line.length) {
    // Lowercasing can expand a character (e.g. Turkish dotted capital I). Map
    // folded offsets back before centering the original, case-preserving text.
    let folded = 0, raw = 0, foundStart = false
    for (const character of line) {
      const next = folded + character.toLowerCase().length
      if (!foundStart && next > normalizedIndex) { startMatch = raw; foundStart = true }
      raw += character.length
      if (next >= normalizedIndex + queryLength) { endMatch = raw; break }
      folded = next
    }
  }
  let from = Math.max(0, startMatch - 100)
  let to = Math.min(line.length, Math.max(from + 500, endMatch))
  if (from > 0 && /[\uDC00-\uDFFF]/.test(line[from])) from--
  if (to < line.length && /[\uDC00-\uDFFF]/.test(line[to])) to++
  return (from > 0 ? '…' : '') + line.slice(from, to) + (to < line.length ? '…' : '')
}
const terminal = status => ['completed','partial','cancelled','failed'].includes(status)

export class WorkspaceSearches {
  constructor({ maxEntries = 50000, maxResults = 300, timeoutMs = 30000, maxReadBytes = 256 * 1024, maxDepth = 30, decodeBuf = b => b.toString('utf8'), encoding = 'utf-8', now = Date.now } = {}) {
    Object.assign(this, { maxEntries, maxResults, timeoutMs, maxReadBytes, maxDepth, decodeBuf, encoding, now })
    this.jobs = new Map()
    this.operations = new WeakMap()
  }
  owner(binding, hint) { return JSON.stringify([hint.sessionId || hint.local, binding.host, binding.port, binding.username, binding.ws]) }
  snapshot(job) {
    return { id: job.id, query: job.query, mode: job.mode, status: job.status, phase: job.phase,
      results: job.results.slice(), scannedFiles: job.scannedFiles, scannedDirs: job.scannedDirs, scannedEntries: job.scannedEntries,
      skipped: job.skipped, errors: job.errors, currentPath: job.currentPath, elapsedMs: (job.finishedAt ?? this.now()) - job.startedAt,
      truncated: job.truncated, reason: job.reason || '', error: job.error || '' }
  }
  get(owner, id) { const job = this.jobs.get(id); return job?.owner === owner ? this.snapshot(job) : null }
  cancel(owner, id) {
    const job = this.jobs.get(id)
    if (!job || job.owner !== owner) return null
    if (!terminal(job.status)) { job.controller.abort('cancelled'); job.status = 'cancelled'; job.finishedAt = this.now() }
    return this.snapshot(job)
  }
  start(owner, binding, { query, mode = 'names', includeIgnored = false, caseSensitive = false, isIgnored = () => false } = {}) {
    query = typeof query === 'string' ? query.trim() : ''
    if (!query || query.length > 256 || !['names','files','directories','content'].includes(mode)) throw Object.assign(new Error('query (1–256 characters) and a valid search mode are required'), { httpStatus: 400 })
    if (!binding.bound || !binding.ws) throw Object.assign(new Error('Search requires a session bound to a remote workspace'), { httpStatus: 403 })
    for (const job of this.jobs.values()) {
      if (!terminal(job.status) && job.owner === owner) this.cancel(owner, job.id)
      if (terminal(job.status) && this.now() - job.finishedAt > 5 * 60000) this.jobs.delete(job.id)
    }
    if ([...this.jobs.values()].filter(j => !terminal(j.status)).length >= 4) throw Object.assign(new Error('Too many active searches; stop a search and retry'), { httpStatus: 429 })
    while (this.jobs.size >= 40) {
      const old = [...this.jobs.values()].find(j => terminal(j.status))
      if (!old) break
      this.jobs.delete(old.id)
    }
    const job = { id: randomUUID(), owner, query, mode, status: 'running', phase: 'connecting', results: [], scannedFiles: 0, scannedDirs: 0, scannedEntries: 0,
      skipped: 0, errors: 0, currentPath: '', truncated: false, startedAt: this.now(), finishedAt: null, controller: new AbortController() }
    this.jobs.set(job.id, job)
    job.promise = this.run(job, binding, { includeIgnored, caseSensitive, isIgnored })
    return this.snapshot(job)
  }
  async run(job, binding, { includeIgnored, caseSensitive, isIgnored }) {
    const signal = job.controller.signal
    let operations = this.operations.get(binding.pool)
    if (!operations) { operations = new SearchOperations(); this.operations.set(binding.pool, operations) }
    const timer = setTimeout(() => job.controller.abort('timeout'), this.timeoutMs)
    timer.unref?.()
    const stop = () => signal.aborted || job.truncated
    const normalize = value => caseSensitive ? value : value.toLowerCase()
    const query = normalize(job.query)
    const nameMatches = (name, relative) => /[*?]/.test(query)
      ? matchGlob(normalize(job.query.includes('/') ? relative : name), query)
      : normalize(relative).includes(query)
    const add = result => {
      if (stop()) return
      if (job.results.length >= this.maxResults) { job.truncated = true; job.reason = 'results'; return }
      job.results.push(result)
    }
    try {
      const sftp = await operations.run(() => binding.pool.sftp(), signal)
      const queue = [{ path: binding.ws, relative: '', depth: 0 }]
      job.phase = 'scanning'
      const visit = async directory => {
        if (stop()) return
        job.currentPath = directory.relative || '.'
        let entries
        try { entries = await operations.run(() => sftp.readdir(directory.path), signal) }
        catch (error) {
          if (signal.aborted) throw error
          if (!directory.relative) throw error
          job.errors++; return
        }
        if (stop()) return
        job.scannedDirs++
        const files = []
        for (const entry of entries || []) {
          if (stop()) break
          const name = String(entry.filename || '')
          if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name) || /^[a-z]:/i.test(name)) continue
          if (++job.scannedEntries > this.maxEntries) { job.truncated = true; job.reason = 'entries'; break }
          const attrs = entry.attrs || {}, link = !!attrs.isSymbolicLink?.(), dir = !link && !!attrs.isDirectory?.()
          const relative = directory.relative ? directory.relative + '/' + name : name
          if (!includeIgnored && isIgnored(relative, dir)) { job.skipped++; continue }
          const path = joinRemotePath(directory.path, name)
          if (!dir) job.scannedFiles++
          if (job.mode !== 'content' && (job.mode === 'names' || job.mode === 'directories' && dir || job.mode === 'files' && !dir) && nameMatches(name, relative)) add({ path, relative, name, type: dir ? 'directory' : link ? 'symlink' : 'file' })
          if (dir) {
            if (directory.depth < this.maxDepth) queue.push({ path, relative, depth: directory.depth + 1 })
            else { job.skipped++; job.truncated = true; job.reason = 'depth' }
          } else if (job.mode === 'content') {
            if (link || attrs.size > this.maxReadBytes) job.skipped++
            else files.push({ path, relative, name, attrs })
          }
        }
        // Bounded pipelining keeps high-RTT SFTP usable without unbounded reads.
        for (let offset = 0; offset < files.length && !stop(); offset += 3) {
          await Promise.all(files.slice(offset, offset + 3).map(async file => {
            if (stop()) return
            try {
              let stat = file.attrs
              if (!Number.isFinite(stat.size)) stat = await operations.run(() => sftp.stat(file.path), signal)
              if (stat.size > this.maxReadBytes) { job.skipped++; return }
              const bytes = await operations.run(() => typeof sftp.readPartial === 'function' ? sftp.readPartial(file.path, 0, this.maxReadBytes + 1) : sftp.readFile(file.path), signal)
              if (stop()) return
              if (bytes.length > this.maxReadBytes || bytes.subarray(0, 8192).includes(0)) { job.skipped++; return }
              const lines = this.decodeBuf(bytes, this.encoding).replace(/\r\n/g, '\n').split('\n')
              for (let i = 0; i < lines.length && !stop(); i++) {
                const normalized = normalize(lines[i]), match = normalized.indexOf(query)
                if (match >= 0) add({ path: file.path, relative: file.relative, name: file.name, type: 'file', line: i + 1,
                  text: matchingSnippet(lines[i], match, query.length, normalized.length) })
              }
            } catch (error) { if (signal.aborted) throw error; job.errors++ }
          }))
        }
      }
      while (queue.length && !stop()) await Promise.all(queue.splice(0, 2).map(visit))
      if (signal.aborted) throw interrupted(signal)
      if (!terminal(job.status)) job.status = job.truncated || job.errors ? 'partial' : 'completed'
    } catch (error) {
      if (signal.aborted) {
        job.status = signal.reason === 'timeout' ? 'partial' : 'cancelled'
        if (signal.reason === 'timeout') { job.truncated = true; job.reason = 'timeout' }
      } else { job.status = 'failed'; job.error = error.message || String(error) }
    } finally { clearTimeout(timer); job.finishedAt ??= this.now(); job.currentPath = '' }
  }
  dispose() { for (const job of this.jobs.values()) if (!terminal(job.status)) job.controller.abort('disposed'); this.jobs.clear() }
}

export function createSearchRoutes({ searches, sendJson, readBody, resolveRequestBinding, isIgnoredFor = () => () => false }) {
  return [{ kind: 'exact', path: '/dsh-remote/search', async handler(req, res) {
    if (!['GET','POST'].includes(req.method)) return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    try {
      const q = new URL(req.url, 'http://localhost').searchParams
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {}
      const hint = requestSessionHint(req, body)
      if (!hint.sessionId && !hint.local) return sendJson(res, 400, { ok: false, error: 'sessionId or local remote workspace context is required' })
      const binding = await resolveRequestBinding(req, body)
      if (!binding.bound) return sendJson(res, 403, { ok: false, error: 'Search requires a remote workspace' })
      const owner = searches.owner(binding, hint), id = String(body.id || q.get('id') || '')
      if (req.method === 'GET' || body.action === 'cancel') {
        if (!id) return sendJson(res, 400, { ok: false, error: 'search id is required' })
        const search = body.action === 'cancel' ? searches.cancel(owner, id) : searches.get(owner, id)
        return sendJson(res, search ? 200 : 404, search ? { ok: true, search } : { ok: false, error: 'Search not found in this workspace' })
      }
      if (body.action && body.action !== 'start') return sendJson(res, 400, { ok: false, error: 'action must be start or cancel' })
      const search = searches.start(owner, binding, { query: body.query, mode: body.mode, caseSensitive: body.caseSensitive === true, includeIgnored: body.includeIgnored === true, isIgnored: isIgnoredFor(binding.ws) })
      return sendJson(res, 200, { ok: true, search })
    } catch (error) { return sendJson(res, error.httpStatus || 500, { ok: false, error: error.message || String(error) }) }
  } }]
}
