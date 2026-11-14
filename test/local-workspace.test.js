import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHost } from './harness/plugin-host.js'
import { createLocalWorkspacePool, sameLocalPath } from '../lib/local-workspace.js'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-local-workspace-'))
  const a = path.join(root, 'a'), b = path.join(root, 'b')
  await fs.mkdir(a); await fs.mkdir(b)
  await fs.writeFile(path.join(a, 'main.js'), 'first\r\nsecond\r\n')
  await fs.writeFile(path.join(b, 'private.txt'), 'other project')
  const sessions = { get: id => ({ a: { header: { cwd: a } }, b: { header: { cwd: b } } })[id] }
  const host = await createHost({ services: { sessions } })
  t.after(async () => { await host.dispose(); await fs.rm(root, { recursive: true, force: true }) })
  const get = (route, query = {}, id = 'a') => host.call('/dsh-remote/' + route + '?' + new URLSearchParams({ sessionId: id, workspace: 'local', ...query }), { method: 'GET' })
  const post = (route, body = {}, id = 'a') => host.call('/dsh-remote/' + route, { method: 'POST', body: { sessionId: id, workspace: 'local', ...body } })
  return { root, a, b, host, get, post }
}

test('local files use the recorded session root; unmarked remote routes and rw_* still refuse local sessions', async t => {
  const { a, host, get } = await fixture(t)
  const context = await get('workspace-context')
  assert.equal(context.status, 200); assert.equal(context.json.kind, 'local'); assert.equal(context.json.root, a); assert.equal(context.json.host, '')
  const listed = await get('ls', { path: a })
  assert.equal(listed.status, 200); assert.ok(listed.json.items.some(f => f.name === 'main.js'))
  const posted = await host.call('/dsh-remote/ls', { body: { sessionId: 'a', workspace: 'local', path: a } })
  assert.equal(posted.status, 200); assert.ok(posted.json.items.some(f => f.name === 'main.js'))
  assert.equal((await host.call('/dsh-remote/ls?sessionId=a&path=' + encodeURIComponent(a), { method: 'GET' })).status, 403)
  const exec = { agent: { session: { header: { cwd: a } } } }
  await assert.rejects(() => host.tool('rw_read_file').execute({ path: 'main.js' }, exec), /LOCAL|local/)
  let forwarded = false
  for (const listener of host.listeners.get('tools/pre-execute') || []) {
    await listener({ ...exec, name: 'write', args: { path: 'main.js', content: 'native write' } }, () => { forwarded = true })
  }
  assert.equal(forwarded, true, 'native local Agent tools remain on the host path')
})

test('shared local editor saves CRLF, rejects stale revisions and sees files created by native tools', async t => {
  const { a, get, post } = await fixture(t)
  const file = path.join(a, 'main.js'), before = await get('read', { path: file })
  assert.equal(before.status, 200); assert.equal(before.json.content, 'first\nsecond\n'); assert.equal(before.json.eol, 'crlf')
  const saved = await post('write', { path: file, content: 'updated\r\n', expectedRevision: before.json.revision })
  assert.equal(saved.status, 200); assert.equal(await fs.readFile(file, 'utf8'), 'updated\r\n')
  await fs.writeFile(file, 'agent change\n')
  const conflict = await post('write', { path: file, content: 'stale', expectedRevision: saved.json.revision })
  assert.equal(conflict.status, 409); assert.equal(await fs.readFile(file, 'utf8'), 'agent change\n')
  await fs.writeFile(path.join(a, 'generated.html'), '<h1>native generated</h1>')
  assert.equal((await get('read', { path: path.join(a, 'generated.html') })).json.content, '<h1>native generated</h1>')
})

test('cross-project paths, untrusted root hints, workspace deletion and symlink escapes fail closed', async t => {
  const { a, b, root, host, get, post } = await fixture(t)
  assert.equal((await get('read', { path: path.join(b, 'private.txt') })).status, 403)
  assert.equal((await get('read', { path: path.join(a, '..', 'b', 'private.txt') })).status, 403)
  assert.equal((await get('read', { path: path.join(a, 'main.js'), local: b })).status, 403)
  assert.equal((await host.call('/dsh-remote/read?' + new URLSearchParams({ workspace: 'local', local: a, path: path.join(a, 'main.js') }), { method: 'GET' })).status, 403)
  assert.equal((await post('fs', { op: 'remove', path: a })).status, 403)
  assert.equal((await fs.stat(path.join(a, 'main.js'))).isFile(), true)
  await fs.symlink(b, path.join(a, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await get('read', { path: path.join(a, 'escape', 'private.txt') })).status, 403)
  assert.equal((await post('write', { path: path.join(a, 'escape', 'new.txt'), content: 'must not write' })).status, 403)
  assert.equal((await post('write', { path: path.join(root, 'sibling.txt'), content: 'must not write' })).status, 403)
})

test('local names and content search have progress, cancellation and per-session ownership', async t => {
  const { a, get, post } = await fixture(t)
  await fs.mkdir(path.join(a, 'nested')); await fs.writeFile(path.join(a, 'nested', 'match.txt'), 'needle here\n')
  const started = await post('search', { action: 'start', query: 'match', mode: 'names' })
  assert.equal(started.status, 200)
  const id = started.json.search.id
  let progress
  for (let i = 0; i < 100; i++) {
    progress = await get('search', { id })
    if (progress.json.search.status !== 'running') break
    await new Promise(r => setTimeout(r, 5))
  }
  assert.equal(progress.json.search.status, 'completed'); assert.ok(progress.json.search.scannedFiles >= 2)
  assert.ok(progress.json.search.results.some(r => r.path === path.join(a, 'nested', 'match.txt')))
  assert.equal((await get('search', { id }, 'b')).status, 404)
  assert.equal((await post('search', { action: 'cancel', id }, 'b')).status, 404)
  const content = await post('search', { action: 'start', query: 'needle', mode: 'content' })
  for (let i = 0; i < 100; i++) {
    progress = await get('search', { id: content.json.search.id })
    if (progress.json.search.status !== 'running') break
    await new Promise(r => setTimeout(r, 5))
  }
  assert.ok(progress.json.search.results.some(r => r.line === 1))
})

test('local Git status and staged/worktree diffs run real Git without modifying the index', async t => {
  const { a, get } = await fixture(t)
  const git = args => execFileSync('git', ['-C', a, ...args], { encoding: 'utf8' })
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'core.autocrlf', 'false'])
  git(['add', 'main.js']); git(['commit', '-qm', 'initial'])
  await fs.writeFile(path.join(a, 'main.js'), 'staged\n'); git(['add', 'main.js']); await fs.writeFile(path.join(a, 'main.js'), 'working\n')
  const index = git(['diff', '--cached'])
  const previousGitDir = process.env.GIT_DIR
  process.env.GIT_DIR = path.join(a, 'nonexistent-inherited-git-dir')
  let status
  try { status = await get('git') } finally { if (previousGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousGitDir }
  assert.equal(status.status, 200); assert.equal(status.json.available, true); assert.ok(status.json.files.some(f => f.path === 'main.js'))
  const staged = await get('git', { action: 'diff', path: 'main.js', staged: '1' })
  const working = await get('git', { action: 'diff', path: 'main.js' })
  assert.match(staged.json.patch, /\+staged/); assert.match(working.json.patch, /\+working/)
  assert.equal(git(['diff', '--cached']), index)
})

test('local file operations create, rename without clobbering and delete without following nested symlinks', async t => {
  const { a, b, post } = await fixture(t)
  const dir = path.join(a, 'new', 'nested'), file = path.join(dir, 'file.txt')
  assert.equal((await post('fs', { op: 'mkdir', path: dir })).status, 200)
  assert.equal((await post('write', { path: file, content: 'new file' })).status, 200)
  const renamed = path.join(dir, 'renamed.txt')
  assert.equal((await post('fs', { op: 'rename', path: file, dest: renamed })).status, 200)
  await fs.writeFile(file, 'keep')
  assert.notEqual((await post('fs', { op: 'rename', path: file, dest: renamed })).status, 200)
  assert.equal(await fs.readFile(file, 'utf8'), 'keep')
  await fs.symlink(b, path.join(dir, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await post('fs', { op: 'remove', path: path.join(a, 'new') })).status, 200)
  assert.equal(await fs.readFile(path.join(b, 'private.txt'), 'utf8'), 'other project')
})

test('local adapter supports an aliased workspace root and rejects a root symlink retarget', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-local-alias-')); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'project'), other = path.join(root, 'other'), alias = path.join(root, 'alias')
  await fs.mkdir(project); await fs.mkdir(other); await fs.writeFile(path.join(project, 'a.txt'), 'content')
  await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const pool = await createLocalWorkspacePool(alias), disk = await pool.sftp()
  assert.equal((await disk.readFile(path.join(alias, 'a.txt'))).toString(), 'content')
  await fs.unlink(alias); await fs.symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(() => disk.readFile(path.join(alias, 'a.txt')), /outside/)
})


test('local preview refuses FIFOs instead of blocking the Web server', { skip: process.platform === 'win32' }, async t => {
  const { a, get } = await fixture(t)
  const pipe = path.join(a, 'dev.pipe')
  execFileSync('mkfifo', [pipe])
  const read = await get('read', { path: pipe })
  assert.equal(read.status, 415)
})


test('Windows workspace-root identity ignores case and separator differences', () => {
  assert.equal(sameLocalPath('C:\\Projects\\App', 'c:/projects/app', path.win32), true)
  assert.equal(sameLocalPath('C:\\Projects\\App', 'C:\\Projects\\App2', path.win32), false)
  assert.equal(sameLocalPath('/projects/app', '/projects/App', path.posix), false)
})
