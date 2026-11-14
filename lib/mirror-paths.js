// Files crossing between a remote workspace and its local mirror must obey
// both path grammars and must never traverse local symlinks.
import { lstatSync } from 'node:fs'
import path from 'node:path'
import { normalizeRemotePath } from './paths.js'

const unsafeDownload = () => Object.assign(new Error('The download destination must be a regular file inside this workspace mirror'), { httpStatus: 403 })

// Remote POSIX names may contain backslashes that become separators on a
// Windows host. Resolve in each filesystem's own grammar, never by prefix.
export function mirrorDownloadTarget(base, workspace, remote, localPath = path) {
  const remotePath = /^(?:[a-z]:[\\/]|\\\\)/i.test(workspace) ? path.win32 : path.posix
  const relative = remotePath.relative(normalizeRemotePath(workspace), normalizeRemotePath(remote))
  if (!relative || remotePath.isAbsolute(relative) || relative.split(remotePath.sep).some(part => part === '..') || relative.includes('\0')) throw unsafeDownload()
  const parts = relative.split(remotePath.sep)
  // This local-only record determines the session's remote identity.
  if (parts.length === 1 && (localPath.sep === '\\' ? parts[0].toLowerCase() : parts[0]) === '.dsh-remote-meta.json') throw unsafeDownload()
  if (localPath.sep === '\\' && parts.some(part => /[<>:"|?*\\\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw unsafeDownload()
  const root = localPath.resolve(base), target = localPath.resolve(root, ...parts)
  const within = localPath.relative(root, target)
  if (!within || localPath.isAbsolute(within) || within.split(localPath.sep).some(part => part === '..')) throw unsafeDownload()
  return target
}

export function assertDownloadHasNoSymlinks(base, target) {
  const root = path.resolve(base)
  let current = root
  for (const segment of ['', ...path.relative(root, target).split(path.sep)]) {
    if (segment) current = path.join(current, segment)
    try { if (lstatSync(current).isSymbolicLink()) throw unsafeDownload() }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

