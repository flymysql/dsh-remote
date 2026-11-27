// Files crossing between a remote workspace and its local mirror must obey
// both path grammars and must never traverse local symlinks.
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeRemotePath, remotePathBase, shortHash } from './paths.js'

const MIRROR_META = '.dsh-remote-meta.json'
const lstat = (p) => lstatSync(p, { throwIfNoEntry: false })

function childDirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch { return [] }
}

export function* mirrorDirectoriesUnder(root) {
  for (const name of childDirectories(root)) {
    const group = path.join(root, name)
    for (const entry of childDirectories(group)) yield path.join(group, entry)
  }
}

export function readMirrorMeta(dir) {
  try {
    if (!lstat(path.dirname(dir))?.isDirectory() || !lstat(dir)?.isDirectory()) return null
    const file = path.join(dir, MIRROR_META)
    if (lstat(file)?.isFile()) return JSON.parse(readFileSync(file, 'utf8'))
  } catch { /* occupied by something other than a readable mirror */ }
  return null
}

export function sameMirrorMachine(meta, { host, username, port, alias = '' }) {
  if (!meta || typeof meta.host !== 'string' || !meta.host || typeof meta.username !== 'string') return false
  const storedPort = typeof meta.port === 'string' && /^\d+$/.test(meta.port) ? Number(meta.port) : meta.port
  if (!Number.isInteger(storedPort) || storedPort < 1 || storedPort > 65535) return false
  // A saved SSH alias is the identity even when its resolved address changes.
  // Literal connections use every component of the recorded endpoint.
  const storedAlias = meta.alias === undefined ? '' : meta.alias
  if (typeof storedAlias !== 'string') return false
  if (alias || storedAlias) return alias === storedAlias
  return meta.host === host && meta.username === username && storedPort === port
}

function mirrorSegment(name, fallback) {
  if (!name || name === '.' || name === '..' || name.includes('\0') || Buffer.byteLength(name) > 255) return fallback
  if (process.platform === 'win32' && (/[<>:"|?*\\\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) return fallback
  return name
}

// Claim a new directory without adopting an existing entry. Another allocator
// may have created it since the last lookup.
function claimDirectory(dir) {
  try {
    mkdirSync(dir)
    return true
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    return false
  }
}

export function mirrorDirectory(root, remotePath, host, username, port, { alias = '', create = false } = {}) {
  const origin = { host: String(host || ''), port: Number(port) || 22, username: String(username || ''), alias }
  const remote = normalizeRemotePath(remotePath)
  const tag = mirrorSegment([origin.host, origin.username, origin.port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_'), 'machine')
  const base = mirrorSegment(remotePathBase(remote), 'workspace')
  const hash = shortHash(remote)
  const suffix = mirrorSegment(base + '-' + hash, 'workspace-' + hash)
  const preferred = path.join(root, tag)
  const matches = (dir) => {
    const meta = readMirrorMeta(dir)
    return meta?.remotePath === remote && sameMirrorMachine(meta, origin)
  }

  // Try both historical names first. A rebound mirror may live under its old
  // machine directory, and a suffixed mirror still belongs to its workspace
  // after a directory that once blocked the preferred name is removed.
  for (const name of [base, suffix]) {
    const dir = path.join(preferred, name)
    if (matches(dir)) return dir
  }
  for (const dir of mirrorDirectoriesUnder(root)) {
    if (matches(dir)) return dir
  }

  if (create) mkdirSync(root, { recursive: true })
  let group
  for (let n = 1; ; n++) {
    group = path.join(root, n === 1 ? tag : mirrorSegment(tag + '-' + n, 'machine-' + n))
    const entry = lstat(group)
    if (entry?.isDirectory()) break
    if (!entry && (!create || claimDirectory(group) || lstat(group)?.isDirectory())) break
  }
  for (let n = 0; ; n++) {
    const name = n === 0 ? base : n === 1 ? suffix : mirrorSegment(suffix + '-' + n, 'workspace-' + hash + '-' + n)
    const dir = path.join(group, name)
    if (!lstat(dir) && (!create || claimDirectory(dir))) {
      if (create) {
        const meta = { host: origin.host, port: origin.port, username: origin.username, remotePath: remote, createdAt: new Date().toISOString() }
        if (alias) meta.alias = alias
        writeFileSync(path.join(dir, MIRROR_META), JSON.stringify(meta, null, 2), { flag: 'wx' })
      }
      return dir
    }
    if (matches(dir)) return dir
  }
}

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


// An explicit `localPath` argument (the rw_download tool surface) must land
// inside the same mirror the HTTP route writes into. Resolve it in the local
// grammar and refuse anything that would escape the root, alias the meta
// record, or smuggle Windows-unusable names — the same guarantees the
// remote-derived form gets from mirrorDownloadTarget.
export function mirrorConstrainLocalTarget(base, localPathArg, localPathApi = path) {
  const root = localPathApi.resolve(base)
  const target = localPathApi.resolve(String(localPathArg || ''))
  const within = localPathApi.relative(root, target)
  if (!within || localPathApi.isAbsolute(within) || within.split(localPathApi.sep).some(part => part === '..')) throw unsafeDownload()
  const parts = within.split(localPathApi.sep)
  // This local-only record determines the session's remote identity.
  if (parts.length === 1 && (localPathApi.sep === '\\' ? parts[0].toLowerCase() : parts[0]) === '.dsh-remote-meta.json') throw unsafeDownload()
  if (localPathApi.sep === '\\' && parts.some(part => /[<>:"|?*\\\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw unsafeDownload()
  return target
}
