// Read-only Git inspection in the session's execution world, never the mirror.
import { shq, normalizeRemotePath, joinRemotePath, relPathUnder } from './paths.js'
import { previewRemoteFile } from './remote-fs.js'

const LIMIT = 192 * 1024
const safeRelative = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f\\:]/.test(value) && !value.startsWith('/') && !value.split('/').some(p => p === '..' || p === '.')
const errorText = result => result.signal === 'TIMEOUT' ? 'Git inspection timed out; narrow the workspace and retry' : String(result.stderr || result.stdout || 'Git command failed').slice(0, 2000)
const gitPath = value => /^[a-z]:[\\/]/i.test(value) ? value.replace(/\\/g, '/') : value

export function parseGitStatus(text, { repo, workspace = repo, limit = 500 } = {}) {
  const parts = text.split('\0'), files = []
  let truncated = !text.endsWith('\0') && text.length > 0
  // Never turn a clipped record into a plausible filename.
  if (truncated) parts.pop()
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]
    if (!record) continue
    if (record.length < 4 || record[2] !== ' ') { truncated = true; continue }
    const indexStatus = record[0], worktreeStatus = record[1], path = record.slice(3)
    let previousPath
    if (/[RC]/.test(indexStatus + worktreeStatus)) { previousPath = parts[++i]; if (!previousPath) { truncated = true; continue } }
    if (!safeRelative(path)) { truncated = true; continue }
    const absolutePath = joinRemotePath(repo, path)
    if (relPathUnder(workspace, absolutePath) === null) continue
    if (files.length >= limit) { truncated = true; break }
    files.push({ path, absolutePath, ...(previousPath ? { previousPath } : {}), indexStatus, worktreeStatus,
      untracked: indexStatus === '?', deleted: worktreeStatus === 'D' || indexStatus === 'D' && worktreeStatus === ' ',
      conflict: indexStatus === 'U' || worktreeStatus === 'U' || ['AA','DD'].includes(indexStatus + worktreeStatus) })
  }
  return { files, truncated }
}

async function runGit(pool, cwd, args, signal, limit = LIMIT) {
  const cancel = new AbortController()
  const abort = () => cancel.abort()
  if (signal?.aborted) cancel.abort()
  signal?.addEventListener('abort', abort, { once: true })
  let output = [], size = 0, tapped = false, truncated = false
  try {
    const command = ['git', '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'color.ui=false', '-C', gitPath(cwd), ...args].map(shq).join(' ')
    const result = await pool.exec(command, { timeoutMs: 15000, signal: cancel.signal, onData(channel, chunk) {
      if (channel !== 'stdout') return
      tapped = true
      const bytes = Buffer.from(chunk)
      if (size < limit) output.push(bytes.subarray(0, limit - size))
      size += bytes.length
      if (size > limit) { truncated = true; cancel.abort() }
    } })
    const stdout = tapped ? Buffer.concat(output).toString('utf8') : String(result.stdout || '').slice(0, limit)
    return { ...result, stdout, truncated: truncated || !tapped && String(result.stdout || '').length > limit }
  } finally { signal?.removeEventListener('abort', abort) }
}

export async function inspectRemoteGit(binding, { action = 'status', path: relative, staged = false, signal, decodeBuf, encoding } = {}) {
  const { pool, ws } = binding
  if (!binding.bound || !ws) throw Object.assign(new Error('Git inspection requires a session bound to a remote workspace'), { httpStatus: 403 })
  if (!['status', 'diff'].includes(action)) throw Object.assign(new Error('action must be status or diff'), { httpStatus: 400 })
  if (action === 'diff' && !safeRelative(relative)) throw Object.assign(new Error('A repository-relative Git file path is required'), { httpStatus: 400 })
  await pool.detect()
  if (pool.platform === 'windows' && !pool.gitBashPath) return { ok: true, available: false, reason: 'unsupported-shell' }
  const top = await runGit(pool, ws, ['rev-parse', '--show-toplevel', '--show-prefix'], signal, 8192)
  if (top.code !== 0) {
    if (top.code === 127 || /not recognized|command not found/i.test(top.stderr || '')) return { ok: true, available: false, reason: 'git-unavailable' }
    if (/not a git repository/i.test(top.stderr || '')) return { ok: true, available: false, reason: 'not-repository' }
    throw new Error(errorText(top))
  }
  const rootLines = top.stdout.replace(/\r\n/g, '\n').split('\n')
  const repo = normalizeRemotePath(rootLines[0] || '')
  const prefix = (rootLines[1] || '').replace(/\/$/, '')
  if (top.truncated || rootLines.length !== 3 || rootLines[2] !== '' || !repo || /[\x00-\x1f\x7f]/.test(repo) || prefix && !safeRelative(prefix)) throw new Error('Git returned an unsupported repository path')
  // Git canonicalizes symlinked workspace roots. Keep filtering in that same
  // world, but return navigation paths under the user's original workspace.
  const gitWorkspace = prefix ? joinRemotePath(repo, prefix) : repo
  const navigationPath = target => {
    const within = relPathUnder(gitWorkspace, target)
    return within === null ? null : within ? joinRemotePath(ws, within) : ws
  }
  if (signal?.aborted) throw new Error('Git inspection cancelled')
  if (action === 'status') {
    const status = await runGit(pool, ws, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--', '.'], signal)
    if (status.code !== 0 && !status.truncated) throw new Error(errorText(status))
    const head = await runGit(pool, ws, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal, 4096)
    if (![0,1].includes(head.code)) throw new Error(errorText(head))
    const parsed = parseGitStatus(status.stdout, { repo, workspace: gitWorkspace })
    return { ok: true, available: true, repo, workspace: ws, branch: head.code === 0 ? head.stdout.trim() : '', detached: head.code === 1,
      ...parsed, files: parsed.files.map(file => ({ ...file, absolutePath: navigationPath(file.absolutePath) })),
      truncated: parsed.truncated || status.truncated || head.truncated }
  }
  const target = joinRemotePath(repo, relative)
  if (relPathUnder(gitWorkspace, target) === null) throw Object.assign(new Error('The requested file is outside this remote workspace'), { httpStatus: 403 })
  // Literal pathspecs matter: filenames such as "[test].js" are not patterns.
  const diff = await runGit(pool, repo, ['--literal-pathspecs', 'diff', ...(staged ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', '--', relative], signal)
  if (diff.code !== 0 && !diff.truncated) throw new Error(errorText(diff))
  if (diff.stdout || staged) return { ok: true, available: true, repo, path: relative, absolutePath: navigationPath(target), staged, patch: diff.stdout, truncated: diff.truncated }
  // Git diff intentionally omits untracked files. Only read files Git confirms
  // are untracked; do not follow symlinks into an unrelated execution target.
  const untracked = await runGit(pool, repo, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', relative], signal, 8192)
  if (untracked.code !== 0) throw new Error(errorText(untracked))
  if (!untracked.stdout.split('\0').includes(relative)) return { ok: true, available: true, path: relative, absolutePath: navigationPath(target), patch: '', truncated: false }
  const sftp = await pool.sftp()
  const stat = await sftp.lstat(target)
  if (stat.isSymbolicLink?.()) return { ok: true, available: true, path: relative, absolutePath: navigationPath(target), patch: '', reason: 'symlink', untracked: true }
  const preview = await previewRemoteFile(sftp, target, { maxBytes: 64 * 1024, decodeBuf, encoding })
  if (preview.binary || preview.image || preview.truncated) return { ok: true, available: true, path: relative, absolutePath: navigationPath(target), patch: '', reason: preview.truncated ? 'too-large' : 'binary', untracked: true, truncated: !!preview.truncated }
  const content = preview.content || ''
  const lines = content ? content.split('\n') : []
  if (content.endsWith('\n')) lines.pop()
  const patch = content ? `--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line).join('\n') + (content.endsWith('\n') ? '\n' : '\n\\ No newline at end of file\n') : ''
  return { ok: true, available: true, path: relative, absolutePath: navigationPath(target), untracked: true, truncated: false,
    patch, empty: content.length === 0 }
}

export function createGitRoutes({ sendJson, resolveRequestBinding, decodeBuf, config }) {
  return [{ kind: 'exact', path: '/dsh-remote/git', async handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const cancel = new AbortController(), close = () => cancel.abort()
    res.on?.('close', close)
    try {
      const q = new URL(req.url, 'http://localhost').searchParams
      if (!q.get('sessionId') && !q.get('local')) return sendJson(res, 400, { ok: false, error: 'sessionId or local workspace context is required' })
      const binding = await resolveRequestBinding(req)
      const result = await inspectRemoteGit(binding, { action: q.get('action') || 'status', path: q.get('path'), staged: q.get('staged') === '1', signal: cancel.signal, decodeBuf, encoding: config.encoding })
      if (!cancel.signal.aborted) sendJson(res, 200, result)
    } catch (error) { if (!cancel.signal.aborted) sendJson(res, error.httpStatus || 500, { ok: false, error: error.message || String(error) }) }
    finally { res.off?.('close', close) }
  } }]
}
