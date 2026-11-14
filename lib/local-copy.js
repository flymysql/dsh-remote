// Recovery for an explicitly identified local mirror copy. A remote read never
// substitutes these bytes, and publishing uses SFTP exclusive creation.
import { open, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { mirrorDownloadTarget, assertDownloadHasNoSymlinks } from './mirror-paths.js'
import { requestSessionHint } from './binding.js'
import { remoteRevision, missingRemoteFile } from './remote-write.js'
import { normalizeRemotePath, remoteDirname, mkdirRemoteDirs, joinRemotePath } from './paths.js'

const HARD_CAP = 2 * 1024 * 1024
const failure = (message, httpStatus, code) => Object.assign(new Error(message), { httpStatus, code })
const changed = () => failure('本地副本已变化，请重新查看后再上传。', 409, 'LOCAL_COPY_CHANGED')
const unsupported = () => failure('仅支持查看和上传完整的 UTF-8 文本副本；此文件不是受支持的文本。', 415, 'LOCAL_COPY_UNSUPPORTED')
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

async function checkRemoteParents(sftp, binding, target, allowMissing) {
  const root = normalizeRemotePath(binding.ws)
  const grammar = /^(?:[a-z]:[\\/]|\\\\)/i.test(root) ? path.win32 : path.posix
  const relative = grammar.relative(root, remoteDirname(target))
  let current = root
  for (const part of ['', ...relative.split(grammar.sep).filter(Boolean)]) {
    if (part) current = joinRemotePath(current, part)
    let stat
    try { stat = await sftp.lstat(current) }
    catch (error) { if (allowMissing && missingRemoteFile(error)) return; throw error }
    if (stat.isSymbolicLink?.() || !stat.isDirectory?.()) throw failure('远端父路径不是普通目录或含符号链接，未上传。', 403, 'LOCAL_COPY_UNSAFE_REMOTE_PATH')
  }
}

async function resolveCopy(binding, target) {
  if (!binding.bound || !binding.ws || !binding.mirrorDir) throw failure('An explicitly bound remote session is required', 403, 'LOCAL_COPY_UNBOUND')
  const local = mirrorDownloadTarget(binding.mirrorDir, binding.ws, target)
  assertDownloadHasNoSymlinks(binding.mirrorDir, local)
  const root = await realpath(binding.mirrorDir), physical = await realpath(local)
  const within = path.relative(root, physical)
  if (!within || path.isAbsolute(within) || within.split(path.sep).includes('..')) throw failure('The local copy is outside this session workspace mirror', 403, 'LOCAL_COPY_UNSAFE')
  const stat = await lstat(local)
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure('The local copy must be a regular file without symbolic links', 403, 'LOCAL_COPY_UNSAFE')
  return { local, stat, relativePath: path.relative(path.resolve(binding.mirrorDir), local).split(path.sep).join('/') }
}

export async function localCopyInfo(binding, target) {
  if (!binding.bound || !binding.mirrorDir) return null
  try {
    const copy = await resolveCopy(binding, target)
    return { available: true, source: 'local-mirror', relativePath: copy.relativePath, size: copy.stat.size, mtime: Math.floor(copy.stat.mtimeMs / 1000) }
  } catch (error) {
    // A remote missing-file response is still truthful when a local candidate
    // cannot be offered safely. Do not disclose files behind links/outside root.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.httpStatus === 403) return null
    throw error
  }
}

export async function readLocalCopy(binding, target, { maxFileBytes = 0 } = {}) {
  let copy
  try { copy = await resolveCopy(binding, target) }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw failure('本地副本已不存在。', 404, 'LOCAL_COPY_NOT_FOUND'); throw error }
  const cap = maxFileBytes > 0 ? Math.min(maxFileBytes, HARD_CAP) : HARD_CAP
  if (copy.stat.size > cap) throw failure(`本地副本超过 ${cap} bytes 的文本恢复上限。`, 413, 'LOCAL_COPY_TOO_LARGE')
  if (/\.(?:png|jpe?g|gif|webp|bmp|ico|avif|pdf)$/i.test(target)) throw unsupported()
  const handle = await open(copy.local, 'r')
  let bytes
  try {
    const before = await handle.stat()
    if (!sameFile(copy.stat, before)) throw changed()
    // Resolve and recheck after opening; a replaced file or parent link must
    // never turn an apparent mirror read into an unrelated local read.
    const verified = await resolveCopy(binding, target)
    if (!sameFile(copy.stat, verified.stat)) throw changed()
    const buffer = Buffer.alloc(copy.stat.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    if (offset !== copy.stat.size || !sameFile(copy.stat, await handle.stat())) throw changed()
    bytes = buffer.subarray(0, offset)
  } finally { await handle.close() }
  if (bytes.includes(0)) throw unsupported()
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw unsupported() }
  return { bytes, preview: { ok: true, source: 'local-mirror', readOnly: true, path: target,
    relativePath: copy.relativePath, content: text.replace(/\r\n/g, '\n'), localRevision: remoteRevision(bytes),
    size: bytes.length, mtime: Math.floor(copy.stat.mtimeMs / 1000), binary: false, image: false, truncated: false } }
}

export async function publishLocalCopy(binding, target, expectedLocalRevision, options = {}) {
  if (typeof expectedLocalRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedLocalRevision)) throw failure('A localRevision from the complete local-copy preview is required', 400, 'LOCAL_COPY_REVISION_REQUIRED')
  const { bytes, preview } = await readLocalCopy(binding, target, options)
  if (preview.localRevision !== expectedLocalRevision) throw changed()
  const sftp = await binding.pool.sftp()
  const existing = await sftp.lstat(target).catch(error => { if (missingRemoteFile(error)) return null; throw error })
  if (existing) throw failure('远端已有同名文件，未覆盖。请重新读取并比较。', 409, 'REMOTE_FILE_EXISTS')
  await checkRemoteParents(sftp, binding, target, true)
  await mkdirRemoteDirs(sftp, remoteDirname(target))
  await checkRemoteParents(sftp, binding, target, false)
  try {
    // This flag is forwarded to SSH_FXP_OPEN as CREAT|EXCL. A concurrent file
    // appearing after lstat MUST fail at the server; no replace/rename follows.
    await sftp.createFileExclusive(target, bytes)
  } catch (error) {
    if (error.exclusiveFileCreated) throw failure('上传未完整完成，远端可能留下新建的不完整文件；请检查远端后再重试。', 502, 'LOCAL_COPY_UPLOAD_INCOMPLETE')
    if (error.exclusiveOpenFailed && [4, 11, 'EEXIST'].includes(error.code)) {
      const appeared = await sftp.lstat(target).catch(probe => { if (missingRemoteFile(probe)) return null; throw error })
      if (appeared) throw failure('远端已出现同名文件，上传未覆盖该文件；请重新读取并检查。', 409, 'REMOTE_FILE_EXISTS')
    }
    throw error
  }
  return { ok: true, source: 'remote', path: target, bytes: bytes.length, revision: remoteRevision(bytes) }
}

export function createLocalCopyRoutes({ sendJson, readBody, resolveRequestBinding, config, audit, onRemoteMutation = () => {} }) {
  return ['read', 'publish'].map(action => ({ kind: 'exact', path: '/dsh-remote/local-copy/' + action, async handler(req, res) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    try {
      const body = JSON.parse((await readBody(req)) || '{}'), hint = requestSessionHint(req, body)
      if (!hint.sessionId && !hint.local) throw failure('An explicit sessionId or local workspace context is required', 403, 'LOCAL_COPY_UNBOUND')
      if (typeof body.path !== 'string' || !body.path.trim()) throw failure('path is required', 400, 'LOCAL_COPY_PATH_REQUIRED')
      const target = normalizeRemotePath(body.path), binding = await resolveRequestBinding(req, body)
      if (action === 'read') return sendJson(res, 200, (await readLocalCopy(binding, target, config)).preview)
      const result = await publishLocalCopy(binding, target, body.expectedLocalRevision, config)
      audit?.('publish-local-copy', `publish ${target}`, 0, binding)
      onRemoteMutation()
      return sendJson(res, 200, result)
    } catch (error) { return sendJson(res, error.httpStatus || 500, { ok: false, error: error.message || String(error), ...(error.code ? { code: error.code } : {}) }) }
  } }))
}
