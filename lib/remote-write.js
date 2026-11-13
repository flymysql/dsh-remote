// Stage complete writes beside their target, check the captured baseline, then
// replace. This is optimistic conflict detection, not a cross-process CAS.
import { randomUUID, createHash } from 'node:crypto'
import { CHANGE_CAPTURE_BYTES } from './file-changes.js'

export const missingRemoteFile = error => error?.code === 2 || error?.code === 'ENOENT' || error?.code === 'NO_SUCH_FILE'
export const remoteRevision = buf => createHash('sha256').update(buf).digest('hex')
const conflict = () => Object.assign(new Error('Remote file changed while saving; reload and compare before retrying.'), { httpStatus: 409, code: 'REMOTE_FILE_CONFLICT' })
const statOrMissing = async (sftp, path) => { try { return await sftp.stat(path) } catch (error) { if (!missingRemoteFile(error)) throw error; return null } }

export async function captureRemoteFile(sftp, path, { read = false, maxBytes = CHANGE_CAPTURE_BYTES, maxReadBytes = 0 } = {}) {
  const stat = await statOrMissing(sftp, path)
  if (!stat) return { path, target: path, stat: null, bytes: null }
  if (stat.isDirectory?.()) throw new Error('A file path is required, not a directory')
  if (read && maxReadBytes > 0 && stat.size > maxReadBytes) throw Object.assign(new Error('File exceeds the configured editing size limit'), { httpStatus: 413, code: 'REMOTE_FILE_TOO_LARGE' })
  const target = typeof sftp.realpath === 'function' ? await sftp.realpath(path) : path
  let bytes
  if (read || stat.size <= maxBytes) {
    // Production surfaces have a bounded range reader. Request one byte past
    // the observed size to detect growth without reading an arbitrarily large
    // file that changed after stat().
    bytes = typeof sftp.readPartial === 'function'
      ? await sftp.readPartial(target, 0, stat.size + 1)
      : await sftp.readFile(target)
    if (bytes.byteLength !== stat.size) throw conflict()
  }
  return { path, target, stat, bytes }
}

export async function atomicRemoteWrite(sftp, snapshot, content) {
  const { path, target, stat, bytes } = snapshot
  const temporary = `${target}.dsh-remote-edit-${randomUUID()}.tmp`
  try {
    // Passing mode at creation avoids a public temporary copy of a 0600 file.
    await sftp.writeFile(temporary, content, { mode: typeof stat?.mode === 'number' ? stat.mode & 0o777 : 0o666 })
    if (stat && typeof stat.mode === 'number' && typeof sftp.setstat === 'function') await sftp.setstat(temporary, { mode: stat.mode & 0o777 })
    const current = await statOrMissing(sftp, path)
    if (!!stat !== !!current || stat && (stat.size !== current.size || stat.mtime !== current.mtime)) throw conflict()
    if (stat && typeof sftp.realpath === 'function' && await sftp.realpath(path) !== target) throw conflict()
    if (stat && bytes) {
      const latest = typeof sftp.readPartial === 'function'
        ? await sftp.readPartial(target, 0, bytes.byteLength + 1)
        : await sftp.readFile(target)
      if (!Buffer.from(latest).equals(Buffer.from(bytes))) throw conflict()
    }
    if (stat) await sftp.renameOverwrite(temporary, target)
    else await sftp.rename(temporary, target)
  } finally {
    try { await sftp.unlink(temporary) } catch { /* original error wins */ }
  }
}
