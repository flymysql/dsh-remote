// dsh-remote — serve the core `workspaceFiles` Remote from the REMOTE origin
// for mirror sessions (issue #194).
//
// The core service (@deepseek-ai/dsh-api-workspace-files) resolves every
// read/readBytes/stat/list against the session header's cwd. For a remote
// Session that cwd is the LOCAL MIRROR, so the core file surfaces answered
// from the mirror — silently stale whenever the remote changed outside this
// plugin's own writes, and `list` showed a tree that could lag arbitrarily
// behind the real workspace. The two surfaces the plugin already owns
// (NATIVE_LINK file links and the sidebar explorer) never had the bug; this
// closes the remaining consumers: the `file` resource provider's stat/read,
// byte windows, workspace listings, and any third-party Remote client.
//
// There is no provider vocabulary on this service (unlike `skills`): a second
// cordis Service under the same name throws, and the wire descriptor stays
// bound to the core instance. The Gateway resolves methods with Reflect.get on
// the LIVE service at call time, so the supported seam is an instance-method
// wrapper — installed inject-scoped, keyed strictly on the mirror binding, and
// exactly reversible on dispose:
//
//   • only read / readBytes / stat / list are wrapped. `changes` keeps the
//     core's local watcher: a remote has no inotify over SFTP, and today's
//     local-mirror watch still fires for every write this plugin makes (it
//     syncs the mirror), so remote-external edits remain the only misses —
//     the same trade the file tab already makes. See the issue for the
//     upstream polling vocabulary this would need.
//   • a call is served remotely ONLY when its workspaceFileScope resolves to
//     a usable mirror binding (meta-recorded host/port/user; a mirror whose
//     meta is missing is skipped, never guessed — the resolveMirror rule).
//     Every other scope falls through to the core implementation untouched.
//   • errors propagate with the core's `workspace-file/*` codes — no silent
//     fallback to the stale mirror, which is exactly the bug being fixed.
//     RemoteError is constructed STRUCTURALLY (isDSHRemoteError marker), the
//     same cross-bundle identification the protocol itself uses, so no new
//     peer dependency on the typert package is required.
//   • path mapping reuses resolveRemoteWorkspacePath, the rw_* tools' proven
//     rule: workspace-relative paths join onto the mirror's remotePath, a
//     local path INSIDE the mirror maps to the same remote file, any other
//     absolute path is a path in the session's execution world (the remote).
//
// The remote side enforces the same caps the core deployment configures
// (read off the live service instance when present): maxBytes per page,
// maxLines per page, maxFileBytes for complete reads, maxEntries per listing.
// One deliberate addition: paging to a far line requires scanning from byte 0,
// cheap on a local disk but a slow SFTP round-trip stream remotely — the scan
// is bounded by maxFileBytes, so an offset deep into a giant file fails fast
// with `workspace-file/too-large` instead of grinding the connection.

import { listDirStructured } from './remote-fs.js'
import { missingRemoteFile } from './remote-write.js'
import {
  normalizeRemotePath, joinRemoteRel, remoteDirname, relPathUnder, resolveRemoteWorkspacePath, shq,
} from './paths.js'

// Defaults mirror dsh-api-workspace-files' Config so behavior holds even when
// the live instance hides its config (a future host build may).
const DEFAULT_CAPS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxLines: 5000,
  maxEntries: 2000,
})

/** Structural RemoteError — see the header; never `instanceof` across bundles. */
function remoteError(code, message, details = {}) {
  return Object.assign(new Error(message), {
    name: 'RemoteError', isDSHRemoteError: true, code, details,
  })
}

const badRequest = (message) => remoteError('gateway/bad-request', message, {})
const notFound = (path) => remoteError('workspace-file/not-found', `no entry at "${path}"`, { path })
const notRegularFile = (path, kind) =>
  remoteError('workspace-file/not-regular-file', `"${path}" is a ${kind}`, { path, kind })
const notText = (path) =>
  remoteError('workspace-file/not-text', `"${path}" is not UTF-8 text`, { path })
const tooLarge = (path, message, limit) =>
  remoteError('workspace-file/too-large', message, { path, limit })
const notDirectory = (path, kind) =>
  remoteError('workspace-file/not-directory', `"${path}" is a ${kind}`, { path, kind })
const outsideWorkspace = (path) =>
  remoteError('workspace-file/outside-workspace', `"${path}" is outside the workspace`, { path })
const searchFailed = (message) =>
  remoteError('workspace-file/search-failed', message, {})

const NUL = String.fromCharCode(0)
const isMissingError = (error) =>
  missingRemoteFile(error) || /no such file|not found|does not exist|enoent|not a directory|enotdir/i.test(String((error && error.message) || error))

function throwIfAborted(signal) {
  if (!signal || signal.aborted !== true) return
  throw signal.reason || Object.assign(new Error('remote workspace file read aborted'), { name: 'AbortError' })
}

/** ssh2 Stats → the core's entry vocabulary ('symlink' is the link itself). */
function attrKind(attrs) {
  if (!attrs || typeof attrs !== 'object') return 'other'
  if (typeof attrs.isDirectory === 'function' && attrs.isDirectory()) return 'directory'
  if (typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink()) return 'symlink'
  if (typeof attrs.isFile === 'function' && attrs.isFile()) return 'file'
  return 'other'
}

/**
 * Opaque freshness token for one remote stat. mtime has second resolution on
 * plain SFTP, so two same-size writes within one second share a version — the
 * client then skips one re-stat of an already-superseded preview. Coarser than
 * the local backend's token, but the honest remote identity available without
 * hashing the whole file.
 */
function versionOf(attrs) {
  const mtime = typeof attrs?.mtime === 'number' ? attrs.mtime : 0
  const size = typeof attrs?.size === 'number' ? attrs.size : 0
  return `sftp:${mtime}:${size}`
}

/** Caps of the live core service, falling back to the core defaults. */
function capsOf(service) {
  const config = service && typeof service === 'object' ? service.config : undefined
  if (!config || typeof config !== 'object') return DEFAULT_CAPS
  const pick = (key) => Number.isFinite(Number(config[key])) && Number(config[key]) > 0 ? Number(config[key]) : DEFAULT_CAPS[key]
  return { maxBytes: pick('maxBytes'), maxFileBytes: pick('maxFileBytes'), maxLines: pick('maxLines'), maxEntries: pick('maxEntries') }
}

/**
 * Map one incoming path onto the session's remote execution world. Returns the
 * absolute remote path (rw_* semantics, see the header); an EMPTY input is an
 * error the caller reports before mapping.
 */
function remoteTargetOf(binding, path) {
  const raw = String(path ?? '')
  if (!raw) throw badRequest('path is required')
  if (raw.includes(NUL)) throw badRequest('path must not contain NUL')
  return resolveRemoteWorkspacePath(binding.remotePath, raw, binding.mirrorDir)
}

/** The mirror binding for one wire scope, or null when the scope is not ours. */
function bindingOf(resolveBinding, scope) {
  if (!scope || typeof scope !== 'object' || typeof scope.workspaceRoot !== 'string' || !scope.workspaceRoot) return null
  let binding = null
  try { binding = resolveBinding(scope.workspaceRoot) || null } catch { binding = null }
  if (!binding || !binding.machine || !binding.remotePath || !binding.mirrorDir) return null
  return binding
}

async function sftpFor(poolForMachine, binding) {
  return poolForMachine(binding.machine).sftp()
}

/** lstat the final component (the core refuses to read through a symlink). */
async function lstatEntry(sftp, remote, path) {
  try {
    return await sftp.lstat(remote)
  } catch (error) {
    if (isMissingError(error)) throw notFound(path)
    throw error
  }
}

/** stat (follows links) for identity, size and version. */
async function statEntry(sftp, remote, path) {
  try {
    return await sftp.stat(remote)
  } catch (error) {
    if (isMissingError(error)) throw notFound(path)
    throw error
  }
}

/** The core's locateFile gates: lstat must see a regular file, stat confirms. */
async function locateRemoteFile(sftp, remote, path) {
  const entry = await lstatEntry(sftp, remote, path)
  if (attrKind(entry) !== 'file') throw notRegularFile(path, attrKind(entry))
  const attrs = await statEntry(sftp, remote, path)
  if (attrKind(attrs) !== 'file') throw notRegularFile(path, attrKind(attrs))
  return attrs
}

/** Page defaults and caps, the core's resolvePage rules. */
function resolvePage(range, caps) {
  const rawOffset = range?.offset
  const offset = rawOffset === undefined ? 1 : Math.trunc(Number(rawOffset))
  if (rawOffset !== undefined && (!Number.isFinite(offset) || offset < 1 || Number(rawOffset) !== offset)) {
    throw badRequest('offset must be a positive integer')
  }
  const rawLimit = range?.limit
  const limit = rawLimit === undefined ? caps.maxLines : Math.trunc(Number(rawLimit))
  if (rawLimit !== undefined && (!Number.isFinite(limit) || limit < 1 || Number(rawLimit) !== limit)) {
    throw badRequest('limit must be a positive integer')
  }
  if (limit > caps.maxLines) throw badRequest(`limit must be at most ${caps.maxLines}`)
  return { offset, limit }
}

/** Byte-window defaults and cap, the core's resolveWindow rules. */
function resolveWindow(range, caps, path) {
  const rawOffset = range?.offset
  const offset = rawOffset === undefined ? 0 : Math.trunc(Number(rawOffset))
  const rawLength = range?.length
  const length = rawLength === undefined ? caps.maxBytes : Math.trunc(Number(rawLength))
  if (rawOffset !== undefined && (!Number.isFinite(offset) || offset < 0 || Number(rawOffset) !== offset)) throw badRequest('offset must be a non-negative integer')
  if (rawLength !== undefined && (!Number.isFinite(length) || length < 1 || Number(rawLength) !== length)) throw badRequest('length must be a positive integer')
  if (offset + length > Number.MAX_SAFE_INTEGER) throw badRequest('offset plus length must stay a safe integer')
  if (length > caps.maxBytes) throw tooLarge(path, `${length} bytes of "${path}" exceed the ${caps.maxBytes} byte cap`, caps.maxBytes)
  return { offset, length }
}

/**
 * Decoded remote text as a chunk stream: SFTP windows fed through an incremental
 * fatal UTF-8 decoder, so the file is never held whole and invalid sequences
 * fail as `workspace-file/not-text` exactly like the core's streamText.
 */
async function* remoteTextChunks(sftp, remote, size, { chunkBytes = 128 * 1024, maxScanBytes } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let offset = 0
  let scanned = 0
  while (offset < size) {
    const length = Math.min(chunkBytes, size - offset)
    const buf = await sftp.readPartial(remote, offset, length)
    if (!buf || buf.length === 0) break
    offset += buf.length
    scanned += buf.length
    if (maxScanBytes && scanned > maxScanBytes) {
      throw tooLarge(remote, `scanning "${remote}" past ${maxScanBytes} bytes while seeking a page exceeds the full-file cap`, maxScanBytes)
    }
    let text
    try {
      text = decoder.decode(buf, { stream: true })
    } catch {
      throw notText(remote)
    }
    if (text) yield text
  }
  let tail
  try {
    tail = decoder.decode()
  } catch {
    throw notText(remote)
  }
  if (tail) yield tail
}

/**
 * Cut lines offset..offset+limit-1 from decoded chunks. A port of the core's
 * cutPage: lines before the page are counted, not kept; the page is refused the
 * moment its bytes exceed maxBytes (a giant line cannot grow memory past the
 * cap either); the loop stops at the first character past the page.
 */
async function cutPage(chunks, offset, limit, maxBytes, path) {
  const last = offset + limit - 1
  const lines = []
  let current = ''
  let bytes = 0
  let lineNumber = 1
  const admit = (size) => {
    bytes += size
    if (bytes > maxBytes) {
      throw tooLarge(path, `lines ${offset}-${last} of "${path}" exceed the ${maxBytes} byte cap`, maxBytes)
    }
  }
  const complete = () => {
    if (lines.length > 0) admit(1)
    lines.push(current)
    current = ''
  }
  for await (const chunk of chunks) {
    let position = 0
    while (position < chunk.length) {
      if (lineNumber > last) return { text: lines.join('\n'), lines: lines.length, eof: false }
      const newline = chunk.indexOf('\n', position)
      const segment = newline === -1 ? chunk.slice(position) : chunk.slice(position, newline)
      if (lineNumber >= offset) {
        admit(Buffer.byteLength(segment, 'utf8'))
        current += segment
      }
      if (newline === -1) break
      if (lineNumber >= offset) complete()
      lineNumber += 1
      position = newline + 1
    }
  }
  if (current.length > 0) complete()
  return { text: lines.join('\n'), lines: lines.length, eof: true }
}

/** The four remote implementations. Each takes (binding, args-after-scope, service, deps). */
const remoteImpl = {
  async read(binding, [path, range, signal], service, deps) {
    const caps = capsOf(service)
    const { offset, limit } = resolvePage(range, caps)
    throwIfAborted(signal)
    const sftp = await sftpFor(deps.poolForMachine, binding)
    const remote = remoteTargetOf(binding, path)
    const attrs = await locateRemoteFile(sftp, remote, path)
    throwIfAborted(signal)
    const page = await cutPage(
      remoteTextChunks(sftp, remote, typeof attrs.size === 'number' ? attrs.size : 0, { maxScanBytes: caps.maxFileBytes }),
      offset, limit, caps.maxBytes, path,
    )
    if (page.text.includes(NUL)) throw notText(path)
    return {
      absolutePath: remote,
      version: versionOf(attrs),
      ...(typeof attrs.size === 'number' ? { bytes: attrs.size } : {}),
      offset,
      text: page.text,
      lines: page.lines,
      eof: page.eof,
    }
  },

  async readBytes(binding, [path, options, signal], service, deps) {
    const caps = capsOf(service)
    options = options || {}
    throwIfAborted(signal)
    const sftp = await sftpFor(deps.poolForMachine, binding)
    let target = path
    if (options.baseFile !== undefined) {
      // The core resolves a relative target against the BASE file's directory,
      // and the base file must itself be a locatable regular file.
      const base = remoteTargetOf(binding, options.baseFile)
      await locateRemoteFile(sftp, base, options.baseFile)
      const raw = String(path ?? '')
      if (!raw) throw badRequest('path is required')
      if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) {
        throw badRequest('path must be relative when baseFile is provided')
      }
      target = normalizeRemotePath(joinRemoteRel(remoteDirname(base), raw))
    }
    const remote = remoteTargetOf(binding, target)
    const attrs = await locateRemoteFile(sftp, remote, path)
    throwIfAborted(signal)
    if (options.range === undefined) {
      const limit = caps.maxFileBytes
      if (typeof attrs.size === 'number' && attrs.size > limit) {
        throw tooLarge(path, `"${path}" exceeds the ${limit} byte full-file cap`, limit)
      }
      const want = typeof attrs.size === 'number' ? attrs.size : 0
      const data = want > 0 ? await sftp.readPartial(remote, 0, want) : Buffer.alloc(0)
      return {
        absolutePath: remote,
        version: versionOf(attrs),
        ...(typeof attrs.size === 'number' ? { bytes: attrs.size } : {}),
        offset: 0,
        data: data || Buffer.alloc(0),
        eof: true,
      }
    }
    const { offset, length } = resolveWindow(options.range, caps, path)
    const data = await sftp.readPartial(remote, offset, length)
    const got = data ? data.length : 0
    const eof = typeof attrs.size === 'number' ? offset + got >= attrs.size : got < length
    return {
      absolutePath: remote,
      version: versionOf(attrs),
      ...(typeof attrs.size === 'number' ? { bytes: attrs.size } : {}),
      offset,
      data: data || Buffer.alloc(0),
      eof,
    }
  },

  async stat(binding, [path, signal], service, deps) {
    throwIfAborted(signal)
    const sftp = await sftpFor(deps.poolForMachine, binding)
    const remote = remoteTargetOf(binding, path)
    const attrs = await locateRemoteFile(sftp, remote, path)
    return {
      absolutePath: remote,
      version: versionOf(attrs),
      ...(typeof attrs.size === 'number' ? { bytes: attrs.size } : {}),
    }
  },

  async list(binding, [path, signal], service, deps) {
    const caps = capsOf(service)
    throwIfAborted(signal)
    const sftp = await sftpFor(deps.poolForMachine, binding)
    const remote = remoteTargetOf(binding, path)
    // Directories stay workspace-scoped, exactly like the core's confine().
    const workspacePath = relPathUnder(binding.remotePath, remote)
    if (workspacePath === null) throw outsideWorkspace(path)
    const entry = await lstatEntry(sftp, remote, path)
    const kind = attrKind(entry)
    if (kind !== 'directory' && kind !== 'symlink') throw notDirectory(path, kind)
    if (kind === 'symlink') {
      const attrs = await statEntry(sftp, remote, path)
      if (attrKind(attrs) !== 'directory') throw notDirectory(path, 'symlink')
    }
    throwIfAborted(signal)
    const listing = await listDirStructured(sftp, remote)
    if (!listing || listing.missing) throw notFound(path)
    const entries = [...listing.items]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((item) => ({
        name: item.name,
        type: item.type === 'dir' ? 'directory' : 'file',
        // listDirStructured already resolved symlinks to their destination's
        // type and degrades dangling links to 'file'; sockets/devices also
        // report 'file' (the core's 'other' bucket) — an approximation that
        // only affects display, never read authority.
        ...(item.type === 'file' && typeof item.size === 'number' ? { size: item.size } : {}),
      }))
    return {
      path: workspacePath,
      entries: entries.slice(0, caps.maxEntries),
      truncated: entries.length > caps.maxEntries,
    }
  },

  /**
   * Issue #228: the core `search` (added on the host after #194) lists files
   * under the LOCAL MIRROR with ripgrep, so a remote file that has not been
   * synced yet is invisible to the core workspace search. Serve the same
   * query shape from the remote: enumerate with `rg --files` over the remote
   * root, admit name/path matches exactly as the core does (case-insensitive
   * substring; with `/` the query matches the relative path), infer ancestor
   * directories, and answer { matches, truncated, incomplete } in the core's
   * vocabulary. Paths in the result are workspace-relative, never remote
   * absolutes.
   */
  async search(binding, [request, signal], service, deps) {
    throwIfAborted(signal)
    const query = String(request && request.query || '').trim()
    if (!query) throw badRequest('query is required')
    const excluded = Array.isArray(request && request.excludedPaths) ? request.excludedPaths.map(String) : []
    const includeHidden = !!(request && request.includeHidden)
    const respectGitignore = !request || request.respectGitignore !== false
    const limits = (service && service.config && service.config.search) || {}
    const maxResults = Number.isFinite(Number(limits.maxResults)) && Number(limits.maxResults) > 0 ? Number(limits.maxResults) : 200
    const maxEntries = Number.isFinite(Number(limits.maxEntries)) && Number(limits.maxEntries) > 0 ? Number(limits.maxEntries) : 20000
    const graceMs = Number.isFinite(Number(limits.graceMs)) && Number(limits.graceMs) > 0 ? Number(limits.graceMs) : 2000
    const timeoutMs = Number.isFinite(Number(limits.timeoutMs)) && Number(limits.timeoutMs) > 0 ? Number(limits.timeoutMs) : 30000

    // Confirm the workspace root itself (core: not-found / not-directory).
    const pool = deps.poolForMachine(binding.machine)
    const sftp = await pool.sftp()
    const root = binding.remotePath
    const rootEntry = await lstatEntry(sftp, root, root)
    if (attrKind(rootEntry) === 'symlink') {
      const resolved = await statEntry(sftp, root, root)
      if (attrKind(resolved) !== 'directory') throw notDirectory(root, 'symlink')
    } else if (attrKind(rootEntry) !== 'directory') throw notDirectory(root, attrKind(rootEntry))

    // Enumerate with ripgrep when present (the core's own vocabulary); fall
    // back to `find` on hosts without rg — same result set, native ignore
    // rules only apply where rg exists.
    const excludeGlobs = excluded.map((p) => `--glob=!${shq(p.includes('/') ? '/' + p : p)}`).join(' ')
    const rgFlags = ['--files', '--sort=path', '--null', '--path-separator=/',
      includeHidden ? '--hidden' : '',
      respectGitignore ? '' : '--no-ignore',
      excludeGlobs,
    ].filter(Boolean).join(' ')
    const rgScript = `cd ${shq(root)} && if command -v rg >/dev/null 2>&1; then rg ${rgFlags}; else find . -type f | sed 's|^\\./||'; fi`
    const res = await pool.exec(rgScript, { timeoutMs: Math.min(timeoutMs, 600000), signal })
    if (res.signal === 'ABORTED') throwIfAborted(signal)
    if (res.signal === 'TIMEOUT') throw searchFailed(`workspace file search timed out after ${timeoutMs}ms`)
    if (res.code !== 0) {
      throw searchFailed(`workspace file search failed (exit ${res.code}): ${String(res.stderr || res.stdout || '').trim().slice(0, 200)}`)
    }
    const incomplete = res.code === 2 || /too many|max-count|truncat/i.test(String(res.stderr || ''))

    const needle = query.toLowerCase()
    const byPath = query.includes('/')
    const entries = new Map()
    let listed = 0
    let overEntries = false
    const admit = (path, type) => {
      const name = path.slice(path.lastIndexOf('/') + 1)
      if ((byPath ? path : name).toLowerCase().includes(needle)) entries.set(path, { path, type })
    }
    for (const rawLine of String(res.stdout || '').split(/\r?\n|\u0000/)) {
      // The remote lists ABSOLUTE paths under the root; the core answers
      // workspace-RELATIVE ones. Strip the root prefix and the find fallback's
      // leading './', so the ancestor walk below never sees a leading slash
      // (a leading slash would make lastIndexOf('/', 0) keep returning 0).
      const rel = rawLine.replace(/^\.\//, '').trim()
      if (!rel) continue
      const relative = rel.startsWith(root + '/') ? rel.slice(root.length + 1) : rel
      if (!relative) continue
      listed += 1
      if (listed > maxEntries) { overEntries = true; break }
      admit(relative, 'file')
      let end = relative.lastIndexOf('/')
      while (end > 0) {
        admit(relative.slice(0, end), 'directory')
        end = relative.lastIndexOf('/', end - 1)
      }
    }
    const matches = [...entries.values()].sort((a, b) => {
      const da = a.path.split('/').length, db = b.path.split('/').length
      return da !== db ? da - db : (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    })
    return {
      matches: matches.slice(0, maxResults),
      truncated: matches.length > maxResults,
      incomplete: incomplete || overEntries,
    }
  },
}

/** Methods wrapped, and the wire's positional arguments after the scope. */
const WRAPPED_METHODS = ['read', 'readBytes', 'stat', 'list', 'search']

/**
 * Wrap the core `workspaceFiles` service so mirror sessions are served from
 * their remote origin. Inert (returns a no-op handle) when the service is
 * absent or exposes none of the expected methods — a composition without the
 * file service keeps whatever behavior it already had.
 *
 * @param {object} ctx - host plugin context.
 * @param {object} opts
 * @param {(local: string) => {mirrorDir: string|null, remotePath: string, machine: object|null}} opts.resolveBinding
 * @param {(machine: object) => object} opts.poolForMachine
 * @param {object} [opts.logger]
 * @returns {{dispose: () => void}}
 */
export function installWorkspaceFilesRemote(ctx, opts = {}) {
  const { resolveBinding, poolForMachine } = opts
  const noop = { dispose() {} }
  if (typeof ctx?.inject !== 'function' || typeof resolveBinding !== 'function' || typeof poolForMachine !== 'function') return noop
  let installed = null
  let unregistered = false
  ctx.inject(['workspaceFiles'], (scope) => {
    const service = typeof scope?.get === 'function' ? scope.get('workspaceFiles') : scope?.workspaceFiles
    if (!service || typeof service !== 'object' || unregistered) return
    const wrapped = new Map()
    for (const name of WRAPPED_METHODS) {
      const original = service[name]
      if (typeof original !== 'function') continue
      const hadOwn = Object.hasOwn(service, name)
      const routed = (...args) => routeRemote(name, service, original, args, { resolveBinding, poolForMachine })
      try {
        service[name] = routed
        wrapped.set(name, { original, routed, hadOwn })
      } catch {
        // A frozen or readonly service face (an older host build): leave it be.
      }
    }
    if (!wrapped.size) return
    const restore = () => {
      for (const [name, { original, routed, hadOwn }] of wrapped) {
        if (service[name] !== routed) continue // someone else replaced it; theirs wins
        if (hadOwn) service[name] = original
        else delete service[name]
      }
      wrapped.clear()
    }
    installed = { restore }
    if (typeof scope.effect === 'function') {
      scope.effect(() => {
        unregistered = true
        restore()
      })
    }
  })
  return {
    dispose() {
      unregistered = true
      if (installed) installed.restore()
      installed = null
    },
  }
}

/** One gateway call: mirror binding → remote implementation, else the core's. */
async function routeRemote(name, service, original, args, deps) {
  const binding = bindingOf(deps.resolveBinding, args[0])
  if (!binding) return Reflect.apply(original, service, args)
  return remoteImpl[name](binding, args.slice(1), service, deps)
}