// dsh-remote — remote-backed `@file` completion (issue #39).
//
// ## Why this module exists
//
// The harness resolves `@` candidates through `ctx.fileReferences`. Its only
// shipped provider (`@deepseek-ai/dsh-file-reference-local`) indexes the
// AGENT SESSION's cwd on the LOCAL filesystem. A dsh-remote session bound to a
// remote workspace has a cwd that is the local MIRROR directory — which
// `ensureMirror()` creates EMPTY (files only appear once the user syncs) — so
// `@` listed nothing at all in a remote session.
//
// The seam's own README names this gap: "other namespaces (remote or virtual
// filesystems) need a provider whose discovery matches the effective tools".
// `ctx.fileReferences` is a single-owner service, so a second provider cannot
// be mounted next to the local one. This module therefore WRAPS
// `fileReferences.list`: a call whose agent is bound to a remote workspace is
// answered from the remote host over SFTP; every other call is delegated to the
// original implementation, untouched.
//
// ## Contract
//
// Candidates are workspace-RELATIVE, POSIX-separated paths (`src/main.c`) —
// the seam's documented shape and the same shape the local provider returns.
// Only paths are ever read: file contents stay behind `rw_read_file` / the
// mirror, exactly like the local provider.
//
// ## Cost control
//
// A bare (slash-free) query searches the whole remote tree, so the traversal is
// bounded four ways — entry budget, directory budget, wall-clock deadline and a
// per-root index cache with stale-while-revalidate. A remote listing failure
// opens a short circuit breaker for that root so a broken/unauthenticated host
// cannot make every keystroke wait for an SSH connect timeout. A missing or
// unreadable DIRECTORY is not a host failure, though: it answers only its own
// query (an empty result, like the traversal skipping an unreadable subtree)
// and never opens the breaker.

/** Directory basenames skipped by the remote traversal (mirrors the local
 *  provider's default list, so both namespaces hide the same noise). */
export const DEFAULT_EXCLUDED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
]

/** Maximum candidates rendered for one query (matches the local default). */
export const DEFAULT_MAX_RESULTS = 20
/** Maximum entries retained in the remote index of one workspace. */
export const DEFAULT_MAX_ENTRIES = 3000
/** Maximum remote directories visited while building one index. */
export const DEFAULT_MAX_DIRS = 300
/** Wall-clock budget for one indexing pass; on expiry the partial index is used. */
export const DEFAULT_TIMEOUT_MS = 4000
/** How long a built index is considered fresh. */
export const DEFAULT_CACHE_TTL_MS = 10000
/** Cooldown after a failed remote listing, during which local results are used. */
export const DEFAULT_FAILURE_COOLDOWN_MS = 30000

/**
 * Rank candidates for a query. Ported from `@deepseek-ai/dsh-file-reference-local`
 * (same author, MIT) so a remote listing orders exactly like a local one.
 * @param {Array<{path: string, kind: string}>} candidates
 * @param {string} query
 * @param {number} limit
 * @returns {Array<{path: string, kind: string}>}
 */
export function rankCandidates(candidates, query, limit) {
  const ranked = []
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, query)
    if (score !== undefined) ranked.push({ candidate, score })
  }
  ranked.sort((left, right) =>
    right.score - left.score
    || kindRank(left.candidate.kind) - kindRank(right.candidate.kind)
    || (query === '' ? 0 : left.candidate.path.length - right.candidate.path.length)
    || compareText(left.candidate.path, right.candidate.path))
  return ranked.slice(0, limit).map((entry) => entry.candidate)
}

function scoreCandidate(candidate, query) {
  if (query === '') return 0
  const path = candidate.path.toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const needle = query.toLowerCase()
  const directoryBonus = candidate.kind === 'directory' ? 25 : 0
  if (name === needle) return 1000 + directoryBonus
  if (name.startsWith(needle)) return 900 + directoryBonus
  if (name.includes(needle)) return 700 + directoryBonus
  if (path.includes(needle)) return 500 + directoryBonus
  const subsequence = subsequenceScore(path, needle)
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus
}

function subsequenceScore(target, query) {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

function kindRank(kind) {
  return kind === 'directory' ? 0 : 1
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

/** A dot-prefixed path segment stays out of a bare (no-slash) fuzzy query
 *  unless the user asked for hidden entries explicitly. */
function visibleForGlobalQuery(path, query) {
  if (query.startsWith('.') || query.includes('/.')) return true
  return !path.split('/').some((segment) => segment.startsWith('.'))
}

/** Whether a workspace-relative directory is safe to resolve: no `..` segment
 *  (which would escape the remote workspace root) and no absolute prefix. */
export function isSafeRelativeDir(rel) {
  const s = String(rel || '')
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) return false
  return !s.split('/').some((segment) => segment === '..')
}

/** Error codes that describe ONE path — a missing or unreadable directory.
 *  ssh2 keeps SFTP statuses NUMERIC (2 = SSH_FX_NO_SUCH_FILE,
 *  3 = SSH_FX_PERMISSION_DENIED); other layers reuse the Node fs names. */
const PER_PATH_ERROR_CODES = new Set([
  2, 3, // ssh2: SSH_FX_NO_SUCH_FILE / SSH_FX_PERMISSION_DENIED
  'NO_SUCH_FILE', 'NO_SUCH_PATH', 'PERMISSION_DENIED',
  'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM',
])

/**
 * Whether a `readDir` failure describes THIS directory (missing or
 * unreadable) rather than the whole transport. A per-path failure answers one
 * query empty — the same degradation scan() applies to an unreadable subtree —
 * instead of surfacing to the overlay's breaker, which would exile every LEGAL
 * query to the local mirror for failureCooldownMs. Transport failures (a broken
 * pool or connection: `ssh sftp failed: …`, `ECONNREFUSED`, handshake
 * timeouts, a generic SFTP `Failure`) match neither branch and keep throwing.
 * main.js's `listDir` re-wraps SFTP errors as `browse failed: <message>`
 * without a code, so the per-path wording is matched as well.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isPerPathError(err) {
  if (err && typeof err === 'object' && PER_PATH_ERROR_CODES.has(err.code)) return true
  const msg = String((err && err.message) || err)
  // Transport markers win over per-path wording: an OpenSSH handshake failure
  // reaches here as "sftp session to <dest> timed out: Permission denied
  // (publickey)" — classifying THAT per-path would make every keystroke pay a
  // full connect timeout without ever tripping the breaker, the exact stall
  // the breaker exists to prevent. Any transport-shaped message is the
  // transport's failure, whatever else it also says.
  if (/ssh sftp failed|sftp session|timed out|econnrefused|econnreset|econnaborted|enotfound|connection|handshake|host key|not connected|channel closed/i.test(msg)) return false
  return /no such file|no such path|not found|does not exist|permission denied|access denied|enoent|enotdir|eacces|eperm/i.test(msg)
}

/**
 * Cancellable, cached remote-tree index rooted at one remote workspace.
 *
 * `listDir(relDir)` is injected: it returns the direct children of a
 * workspace-relative directory ('' = the workspace root) as
 * `{ name, kind: 'file'|'directory' }` and throws when the transport fails
 * (a missing or unreadable directory throws too, and `listDirectory()`
 * degrades that per-query). Everything else here is pure logic, which is what
 * the unit tests exercise without an SSH server.
 */
export class RemoteWorkspaceIndex {
  /**
   * @param {object} opts
   * @param {(relDir: string) => Promise<Array<{name: string, kind: string}>>} opts.listDir
   * @param {number} [opts.maxResults]
   * @param {number} [opts.maxEntries]
   * @param {number} [opts.maxDirs]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.cacheTtlMs]
   * @param {string[]} [opts.excludedDirectories]
   * @param {(err: unknown) => void} [opts.onError]
   * @param {() => number} [opts.now]
   */
  constructor({
    listDir,
    maxResults = DEFAULT_MAX_RESULTS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxDirs = DEFAULT_MAX_DIRS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    excludedDirectories = DEFAULT_EXCLUDED_DIRECTORIES,
    onError,
    now = () => Date.now(),
  }) {
    this.listDir = listDir
    this.maxResults = maxResults
    this.maxEntries = maxEntries
    this.maxDirs = maxDirs
    this.timeoutMs = timeoutMs
    this.cacheTtlMs = cacheTtlMs
    this.excluded = new Set(excludedDirectories)
    this.onError = onError
    this.now = now
    /** Settled index plus the time its traversal started. */
    this.settled = undefined
    /** Single-flight traversal. */
    this.generation = undefined
    /** Monotonic invalidation counter; a settled index below it is stale. */
    this.invalidations = 0
    this.disposed = false
    /** True once a traversal stopped early on a budget instead of finishing. */
    this.truncated = false
  }

  /**
   * Candidates for the active `@` token.
   * @param {string} rawQuery - path text after `@` (or `@"`).
   * @param {AbortSignal} [signal] - cancels this caller's wait, not a shared traversal.
   */
  async list(rawQuery, signal) {
    throwIfAborted(signal)
    if (this.disposed) return []
    const query = String(rawQuery ?? '').replaceAll('\\', '/')
    const slash = query.lastIndexOf('/')
    if (query === '' || slash >= 0) {
      const directory = slash < 0 ? '' : query.slice(0, slash + 1)
      const fragment = slash < 0 ? '' : query.slice(slash + 1)
      return this.listDirectory(directory, fragment, signal)
    }
    const entries = await this.indexFor(signal)
    throwIfAborted(signal)
    return rankCandidates(entries.filter((candidate) => visibleForGlobalQuery(candidate.path, query)), query, this.maxResults)
  }

  /** Mark the settled index stale: the next bare query rebuilds it. */
  invalidate() {
    if (this.disposed) return
    this.invalidations += 1
  }

  /** Abort the traversal and make later queries return nothing. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.generation) this.generation.controller.abort(new Error('remote file-reference index disposed'))
    this.generation = undefined
    this.settled = undefined
  }

  /** Direct children of one workspace-relative directory. */
  async listDirectory(displayDirectory, fragment, signal) {
    throwIfAborted(signal)
    const rel = displayDirectory.replace(/\/+$/, '')
    if (!isSafeRelativeDir(rel)) return []
    if (rel.split('/').some((segment) => this.excluded.has(segment))) return []
    let items
    try {
      items = await this.readDir(rel)
    } catch (err) {
      // An aborted keystroke is not a listing failure.
      if (signal && signal.aborted) throw err
      // A missing or unreadable directory (a typo like `@nope/fi`, an EACCES
      // subtree) answers only THIS query, so it degrades to an empty result
      // exactly like scan() skipping an unreadable subtree — it must not reach
      // the overlay's breaker and exile every LEGAL query to the local mirror
      // for failureCooldownMs. Transport-level failures still surface for that.
      if (!isPerPathError(err)) throw err
      this.onError?.(err)
      items = []
    }
    throwIfAborted(signal)
    const candidates = []
    for (const item of items) {
      const name = String(item.name || '')
      if (!name || name === '.' || name === '..') continue
      if (name.startsWith('.') && !String(fragment).startsWith('.')) continue
      const kind = item.kind === 'directory' ? 'directory' : 'file'
      if (kind === 'directory' && this.excluded.has(name)) continue
      candidates.push({ path: `${displayDirectory}${name}`, kind })
    }
    return rankCandidates(candidates, fragment, this.maxResults)
  }

  /** Entries a bare fuzzy query ranks. Only the first query of a workspace
   *  waits for the traversal; afterwards a stale index answers immediately and
   *  its replacement builds behind the caret. Staleness is either an explicit
   *  invalidation (a tool result changed the tree) or the cache TTL. */
  async indexFor(signal) {
    const settled = this.settled
    if (settled === undefined) return waitFor(this.ensureIndex(), signal)
    if (settled.version < this.invalidations || this.now() - settled.builtAt > this.cacheTtlMs) {
      this.ensureIndex().catch(() => {})
    }
    return settled.entries
  }

  ensureIndex() {
    if (this.disposed) return Promise.resolve([])
    if (this.generation !== undefined) return this.generation.promise
    const controller = new AbortController()
    const version = this.invalidations
    const generation = { controller, promise: Promise.resolve([]) }
    generation.promise = this.scan(controller.signal).then((entries) => {
      if (this.disposed) return entries
      this.generation = undefined
      this.settled = { entries, version, builtAt: this.now() }
      return entries
    }, (error) => {
      if (this.generation === generation) this.generation = undefined
      throw error
    })
    this.generation = generation
    return generation.promise
  }

  /** Breadth-first bounded traversal of the remote tree. */
  async scan(signal) {
    const entries = []
    const deadline = this.now() + this.timeoutMs
    const directories = ['']
    let visited = 0
    for (let cursor = 0; cursor < directories.length; cursor += 1) {
      throwIfAborted(signal)
      if (entries.length >= this.maxEntries || visited >= this.maxDirs) { this.truncated = true; break }
      if (this.now() > deadline) { this.truncated = true; break }
      const rel = directories[cursor]
      visited += 1
      let items
      try {
        items = await this.readDir(rel)
      } catch (err) {
        // An unreachable root is a connection problem, not a missing subtree:
        // surface it so the caller can open the circuit breaker.
        if (rel === '') throw err
        this.onError?.(err)
        continue
      }
      for (const item of items) {
        throwIfAborted(signal)
        const name = String(item.name || '')
        if (!name || name === '.' || name === '..') continue
        const path = rel === '' ? name : `${rel}/${name}`
        if (item.kind === 'directory') {
          if (this.excluded.has(name)) continue
          entries.push({ path, kind: 'directory' })
          directories.push(path)
        } else {
          entries.push({ path, kind: 'file' })
        }
        if (entries.length >= this.maxEntries) { this.truncated = true; break }
      }
    }
    return entries
  }

  async readDir(rel) {
    const items = await this.listDir(rel)
    return Array.isArray(items) ? items : []
  }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal.reason)
}

function abortError(reason) {
  if (reason instanceof Error) return reason
  const err = new Error('file-reference query aborted')
  err.name = 'AbortError'
  return err
}

function waitFor(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal.reason))
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortError(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolvePromise(value) },
      (error) => { signal.removeEventListener('abort', onAbort); rejectPromise(error) },
    )
  })
}

/**
 * One remote workspace's discovery provider, with the failure circuit breaker
 * that keeps a broken host from stalling every keystroke.
 *
 * `list()` never rejects: it returns `null` when the breaker is open or the
 * remote listing failed at the transport level, which tells the overlay to fall
 * back to the original (local) provider instead of showing an empty list. (A
 * missing or unreadable directory answers `[]` instead — a per-path failure
 * is not a host failure, see isPerPathError.)
 */
export function createRemoteFileReference({ listDir, config = {}, onError, now }) {
  const index = new RemoteWorkspaceIndex({ listDir, ...config, onError, now })
  const clock = now || (() => Date.now())
  const cooldownMs = config.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS
  let downUntil = 0
  return {
    root: config.root || '',
    /** False while the last failure is still cooling down. */
    ready: () => clock() >= downUntil,
    /** Called when the remote listing fails; opens the cooldown window. */
    markDown: () => { downUntil = clock() + cooldownMs },
    async list(query, signal) {
      try {
        return await index.list(query, signal)
      } catch (err) {
        if (signal && signal.aborted) throw err
        onError?.(err)
        return null
      }
    },
    invalidate: () => index.invalidate(),
    dispose: () => index.dispose(),
  }
}

/**
 * Wrap `ctx.fileReferences.list` so remote-bound sessions are served from the
 * remote host.
 *
 * The seam is a single-owner service, so this is an overlay rather than a
 * second provider: `resolve(agent)` returns a remote provider for an agent whose
 * workspace is a dsh-remote mirror, and `null` for every other agent (including
 * a remote agent whose host is currently unavailable) — in which case the
 * original implementation answers with the local view.
 *
 * @param {object} ctx - plugin context.
 * @param {object} opts
 * @param {(agent: object) => ({list: Function, ready: Function, markDown: Function}|null)} opts.resolve
 * @param {(err: unknown) => void} [opts.onError]
 * @returns {{dispose: () => void}|undefined} teardown handle, when the seam exists.
 */
export function installFileReferenceOverlay(ctx, { resolve, onError } = {}) {
  if (!ctx || typeof ctx.inject !== 'function' || typeof resolve !== 'function') return undefined
  const report = (err) => { try { onError?.(err) } catch { /* a logging hook must never break completion */ } }
  let restore = null
  const fiber = ctx.inject(['fileReferences'], (inner) => {
    const service = inner.fileReferences
    if (!service || typeof service.list !== 'function') return
    const original = service.list
    const patched = function (agent, query, signal) {
      let remote = null
      try {
        remote = resolve(agent)
      } catch (err) {
        report(err)
        remote = null
      }
      // Fall back to the local provider whenever this agent is not a remote
      // session, the feature is off, or the host is cooling down after a
      // failure: showing the synced mirror beats showing nothing.
      if (!remote || (typeof remote.ready === 'function' && !remote.ready())) {
        return original.call(service, agent, query, signal)
      }
      const fallback = () => original.call(service, agent, query, signal)
      try {
        return Promise.resolve(remote.list(String(query ?? ''), signal)).then(
          (candidates) => {
            if (candidates === null) {
              remote.markDown?.()
              return fallback()
            }
            return candidates
          },
          (err) => {
            // An aborted keystroke is not a host failure: don't open the breaker.
            if (signal && signal.aborted) throw err
            report(err)
            remote.markDown?.()
            return fallback()
          },
        )
      } catch (err) {
        report(err)
        remote.markDown?.()
        return fallback()
      }
    }
    service.list = patched
    restore = () => { if (service.list === patched) service.list = original }
    try {
      inner.effect(() => () => { if (restore) restore() }, 'dsh-remote: file-reference overlay')
    } catch { /* no effect registry: the returned handle still unpatches */ }
  })
  return {
    dispose() {
      try { if (restore) restore() } catch { /* already restored */ }
      restore = null
      try { fiber?.dispose?.() } catch { /* fiber already torn down */ }
    },
  }
}
