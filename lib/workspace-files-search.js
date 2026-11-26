// Remote file enumeration for the core workspaceFiles search contract (#228).
import { StringDecoder } from 'node:string_decoder'
import { compileIgnore } from './ignore.js'
import { joinRemotePath, shq } from './paths.js'

const VCS_NAMES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']
const MAX_IGNORE_BYTES = 16 * 1024
const isChildName = name => name && name !== '.' && name !== '..' && !/[\/\0]/.test(name)

async function listWithRipgrep(pool, root, request, maxEntries, run, signal) {
  if (!root.startsWith('/') || typeof pool.exec !== 'function') return null
  if (typeof pool.detect === 'function') await run(() => pool.detect())
  if (pool.platform !== 'posix') return null

  const exclusions = [...VCS_NAMES, ...request.excludedPaths].filter(path => path && !path.includes('\0'))
  const args = ['--no-config', '--files', '--sort=path', '--null', '--path-separator=/']
  if (request.includeHidden) args.push('--hidden')
  if (!request.respectGitignore) args.push('--no-ignore')
  for (const path of exclusions) {
    const literal = path.replace(/[\\*?\[\]{}!]/g, '\\$&')
    args.push('--glob=!' + (path.includes('/') ? '/' : '') + literal)
  }
  const script = 'cd ' + shq(root) + ' || exit 125; exec rg ' + args.map(shq).join(' ')
  const stop = new AbortController()
  const execSignal = AbortSignal.any([signal, stop.signal])
  const decoder = new StringDecoder('utf8')
  const files = []
  let pending = ''
  let incomplete = false
  let capped = false
  let invalidOutput = false
  const outcome = await run(() => pool.exec(script, {
    signal: execSignal,
    timeoutMs: 0, // The outer budget also covers connection and platform detection.
    onData(channel, chunk) {
      if (channel !== 'stdout' || execSignal.aborted) return
      pending += decoder.write(chunk)
      let start = 0
      let end = pending.indexOf('\0')
      while (end !== -1) {
        const path = pending.slice(start, end)
        if (!path.split('/').every(isChildName)) incomplete = true
        else if (files.length === maxEntries) {
          capped = true
          stop.abort()
          return
        } else files.push(path)
        start = end + 1
        end = pending.indexOf('\0', start)
      }
      pending = pending.slice(start)
      // rg paths are bounded, also guard against a remote shell that writes
      // non-rg output to stdout without a record separator.
      if (pending.length > 64 * 1024) {
        invalidOutput = true
        stop.abort()
      }
    },
  }))
  if (capped) return { files, incomplete: true }
  if (invalidOutput || outcome.signal || ![0, 1, 2].includes(outcome.code)) return null
  return { files, incomplete: incomplete || outcome.code === 2 || !!(pending + decoder.end()) }
}

async function localIgnoreRules(entries, directory, sftp, run, join) {
  const rules = []
  for (const entry of entries) {
    if (!['.gitignore', '.ignore'].includes(entry.filename) || !entry.attrs?.isFile?.() || entry.attrs.size > MAX_IGNORE_BYTES) continue
    let bytes
    try { bytes = await run(() => sftp.readPartial(join(directory, entry.filename), 0, MAX_IGNORE_BYTES + 1)) }
    catch { continue } // Fallback ignore handling is reported as incomplete.
    if (bytes.length > MAX_IGNORE_BYTES || bytes.includes(0)) continue
    const lines = bytes.toString('utf8').split('\n').map(line => line.trim()).filter(line =>
      !/[!\\\[\]]/.test(line) && (line.match(/\*/g)?.length ?? 0) <= 2)
    const ignored = compileIgnore(lines.filter(line => !line.endsWith('/')))
    const ignoredDir = compileIgnore(lines.filter(line => line.endsWith('/')))
    rules.push((path, isDir) => ignored(path) || isDir && ignoredDir(path))
  }
  return rules
}

async function listWithSftp(sftp, root, request, maxEntries, run, signal) {
  const excludedNames = new Set(VCS_NAMES)
  const excludedPaths = new Set()
  for (const path of request.excludedPaths) (path.includes('/') ? excludedPaths : excludedNames).add(path)

  const files = []
  let incomplete = request.respectGitignore
  let capped = false
  // A backslash can be part of a POSIX name, so keep the root's separator
  // style even after descending into such a directory.
  const join = root.startsWith('/') ? (dir, name) => dir.replace(/\/$/, '') + '/' + name : joinRemotePath
  const walk = async (directory, relative, inherited) => {
    let entries
    try { entries = await run(() => sftp.readdir(directory)) }
    catch {
      signal.throwIfAborted()
      incomplete = true
      return
    }
    const localRules = request.respectGitignore ? await localIgnoreRules(entries, directory, sftp, run, join) : []
    const offset = relative ? relative.length + 1 : 0
    const ignored = [...inherited, ...localRules.map(rule => (path, isDir) => rule(path.slice(offset), isDir))]
    entries.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
    for (const { filename: name, attrs } of entries) {
      signal.throwIfAborted()
      if (capped) return
      if (name === '.' || name === '..') continue
      if (!isChildName(name) || (!root.startsWith('/') && name.includes('\\'))) {
        incomplete = true
        continue
      }
      if (excludedNames.has(name) || !request.includeHidden && name.startsWith('.') || attrs?.isSymbolicLink?.()) continue
      const path = relative ? relative + '/' + name : name
      const isDir = !!attrs?.isDirectory?.()
      if (excludedPaths.has(path) || ignored.some(rule => rule(path, isDir))) continue
      if (isDir) await walk(join(directory, name), path, ignored)
      else if (attrs?.isFile?.()) {
        if (files.length === maxEntries) {
          incomplete = true
          capped = true
          return
        }
        files.push(path)
      }
    }
  }
  await walk(root, '', [])
  return { files, incomplete }
}

export async function listWorkspaceSearchFiles(pool, sftp, root, request, maxEntries, run, signal) {
  let fast
  try { fast = await listWithRipgrep(pool, root, request, maxEntries, run, signal) }
  catch { signal.throwIfAborted() }
  if (fast) return fast
  return listWithSftp(sftp, root, request, maxEntries, run, signal)
}
