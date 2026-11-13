import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectRemoteGit, parseGitStatus, createGitRoutes } from '../lib/remote-git.js'
import { SshPool } from '../lib/pool.js'
import { startDiskWorkspace } from './harness/disk-workspace.js'

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } })

async function setup(t, { aliasedRoot = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-workspace-'))
  const root = aliasedRoot ? path.join(directory, 'alias') : directory
  if (aliasedRoot) {
    const physical = path.join(directory, 'disk')
    fs.mkdirSync(physical); fs.symlinkSync(physical, root, 'dir')
  }
  git(root, 'init', '-q', '-b', 'daily-work')
  for (const [name, content] of Object.entries({ 'main.c': 'int before = 1;\n', 'delete.txt': 'delete me\n', 'old name.txt': 'rename me\n', '[test].js': 'before bracket\n', 'test1.js': 'before wildcard\n', 'src/nested.txt': 'nested before\n' })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), content)
  }
  git(root, 'add', '--all'); git(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline')
  fs.writeFileSync(path.join(root, 'main.c'), 'int staged = 2;\n'); git(root, 'add', '--', 'main.c'); fs.writeFileSync(path.join(root, 'main.c'), 'int working = 3;\n')
  fs.unlinkSync(path.join(root, 'delete.txt')); git(root, 'mv', 'old name.txt', 'new name.txt')
  fs.writeFileSync(path.join(root, '[test].js'), 'after bracket\n'); fs.writeFileSync(path.join(root, 'test1.js'), 'after wildcard\n')
  fs.writeFileSync(path.join(root, 'src/nested.txt'), 'nested after\n'); fs.writeFileSync(path.join(root, '新文件.txt'), 'new\n'); fs.writeFileSync(path.join(root, 'empty.txt'), '')
  fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([1,0,2])); fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(70 * 1024))
  const server = await startDiskWorkspace(root)
  const pool = new SshPool({ host: '127.0.0.1', port: server.port, username: 'root', password: 'test-only', hostKeyMode: 'off', connectTimeoutMs: 5000, commandTimeoutMs: 5000, maxOutputChars: 40 })
  t.after(async () => { pool.close(); await server.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { root, pool, server, binding: { pool, ws: root, bound: true } }
}

test('porcelain parsing keeps rename paths, conflicts, unicode and literal special names; clipped records stay partial', () => {
  const r = parseGitStatus('R  new name\0old name\0MM main.c\0UU conflict.c\0?? 中文.txt\0 M [test].js\0 M clipped', { repo: '/project' })
  assert.equal(r.truncated, true); assert.equal(r.files.length, 5)
  assert.equal(r.files[0].previousPath, 'old name'); assert.equal(r.files[0].absolutePath, '/project/new name')
  assert.equal(r.files[2].conflict, true); assert.equal(r.files[3].untracked, true)
  assert.equal(r.files.some(f => f.path === 'clipped'), false)
  const limited = parseGitStatus(' M src/a\0 M other/b\0 M src/c\0', { repo: '/project', workspace: '/project/src', limit: 1 })
  assert.equal(limited.files.length, 1); assert.equal(limited.truncated, true)
})

test('Git inspection refuses unbound sessions and unsafe paths before opening a connection', async () => {
  const pool = { detect: () => { throw new Error('must not connect') } }
  await assert.rejects(inspectRemoteGit({ pool, ws: '/project' }), e => e.httpStatus === 403)
  for (const value of ['../outside', '/absolute', ':!foo', 'C:\\outside', 'src/../outside', 'nul\0name']) await assert.rejects(inspectRemoteGit({ pool, ws: '/project', bound: true }, { action: 'diff', path: value }), e => e.httpStatus === 400)
  await assert.rejects(inspectRemoteGit({ pool, ws: '/project', bound: true }, { action: 'reset' }), e => e.httpStatus === 400)
})

test('HTTP Git route requires session context and returns binding denials as structured JSON', async () => {
  let binds = 0
  const route = createGitRoutes({ sendJson: (res, status, json) => Object.assign(res, { status, json }), config: {}, resolveRequestBinding: async () => { binds++; throw Object.assign(new Error('this session is LOCAL'), { httpStatus: 403 }) } })[0]
  const call = async req => { const res = {}; await route.handler(req, res); return res }
  assert.equal((await call({ method: 'POST', url: '/dsh-remote/git' })).status, 405)
  assert.equal((await call({ method: 'GET', url: '/dsh-remote/git' })).status, 400); assert.equal(binds, 0)
  const denied = await call({ method: 'GET', url: '/dsh-remote/git?sessionId=local' })
  assert.equal(denied.status, 403); assert.match(denied.json.error, /LOCAL/)
})

test('unsupported native Windows shell is explained without sending POSIX-quoted Git commands', async () => {
  const pool = { platform: 'windows', detect: async () => {}, exec: () => { throw new Error('must not run') } }
  assert.deepEqual(await inspectRemoteGit({ pool, ws: 'C:\\project', bound: true }), { ok: true, available: false, reason: 'unsupported-shell' })
})

test('real SSH Git status and working/staged diffs inspect remote disk without changing index or worktree', { skip: process.platform === 'win32' }, async t => {
  const { root, binding, server } = await setup(t)
  const marker = path.join(root, 'GIT_HELPER_MUST_NOT_RUN')
  git(root, 'config', 'diff.external', `touch ${marker}`)
  git(root, 'config', 'diff.unsafe.textconv', `touch ${marker}`)
  git(root, 'config', 'core.fsmonitor', `touch ${marker}`)
  fs.writeFileSync(path.join(root, '.gitattributes'), 'main.c diff=unsafe\n')
  const index = fs.readFileSync(path.join(root, '.git/index'))
  const status = await inspectRemoteGit(binding)
  assert.equal(status.branch, 'daily-work'); assert.equal(status.available, true)
  const main = status.files.find(f => f.path === 'main.c'); assert.equal(main.indexStatus, 'M'); assert.equal(main.worktreeStatus, 'M')
  assert.equal(status.files.find(f => f.path === 'new name.txt').previousPath, 'old name.txt')
  assert.equal(status.files.find(f => f.path === 'delete.txt').deleted, true)
  const working = await inspectRemoteGit(binding, { action: 'diff', path: 'main.c' })
  assert.match(working.patch, /-int staged = 2;/); assert.match(working.patch, /\+int working = 3;/)
  const staged = await inspectRemoteGit(binding, { action: 'diff', path: 'main.c', staged: true })
  assert.match(staged.patch, /-int before = 1;/); assert.match(staged.patch, /\+int staged = 2;/)
  const literal = await inspectRemoteGit(binding, { action: 'diff', path: '[test].js' })
  assert.match(literal.patch, /after bracket/); assert.doesNotMatch(literal.patch, /after wildcard/)
  const fresh = await inspectRemoteGit(binding, { action: 'diff', path: '新文件.txt' })
  assert.equal(fresh.untracked, true); assert.match(fresh.patch, /@@ -0,0 \+1,1 @@/); assert.match(fresh.patch, /\+new\n$/)
  const empty = await inspectRemoteGit(binding, { action: 'diff', path: 'empty.txt' }); assert.equal(empty.patch, ''); assert.equal(empty.empty, true)
  const binary = await inspectRemoteGit(binding, { action: 'diff', path: 'image.bin' }); assert.equal(binary.reason, 'binary')
  const large = await inspectRemoteGit(binding, { action: 'diff', path: 'large.txt' }); assert.equal(large.truncated, true); assert.equal(large.reason, 'too-large')
  assert.equal(fs.existsSync(marker), false, 'configured external diff, textconv and fsmonitor programs must not execute')
  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), index)
  assert.equal(fs.readFileSync(path.join(root, 'main.c'), 'utf8'), 'int working = 3;\n')
  assert.ok(server.commands.filter(c => c.includes("'git'")).every(c => c.includes("'--no-optional-locks'")))
})

test('an aliased workspace root permits canonical Git preview paths within the same disposable disk', { skip: process.platform === 'win32' }, async t => {
  const { root, binding, server } = await setup(t, { aliasedRoot: true })
  const canonical = fs.realpathSync(root)
  assert.notEqual(root, canonical, 'exercise the /var versus /private/var distinction on every POSIX platform')
  const state = await inspectRemoteGit(binding)
  assert.equal(state.repo, canonical)
  assert.equal(state.files.find(file => file.path === '新文件.txt').absolutePath, path.join(root, '新文件.txt'))
  const preview = await inspectRemoteGit(binding, { action: 'diff', path: '新文件.txt' })
  assert.equal(preview.untracked, true)
  assert.match(preview.patch, /\+new\n$/)
  assert.equal(preview.absolutePath, path.join(root, '新文件.txt'))
  for (const outside of [root + '-sibling/file', canonical + '-sibling/file', path.join(root, '..', 'outside'), path.join(canonical, '..', 'outside')]) {
    assert.throws(() => server.fs.resolve(outside), /outside disposable workspace/, 'accept only the logical and real roots, not their siblings or parents')
  }
})

test('subdirectory workspaces only expose their files and reject a parent repository file', { skip: process.platform === 'win32' }, async t => {
  const { root, binding } = await setup(t); binding.ws = path.join(root, 'src')
  const status = await inspectRemoteGit(binding)
  assert.deepEqual(status.files.map(f => f.path), ['src/nested.txt'])
  const nested = await inspectRemoteGit(binding, { action: 'diff', path: 'src/nested.txt' }); assert.match(nested.patch, /nested after/)
  await assert.rejects(inspectRemoteGit(binding, { action: 'diff', path: 'main.c' }), e => e.httpStatus === 403)
  const link = path.join(root, 'linked-src'); fs.symlinkSync(path.join(root, 'src'), link)
  binding.ws = link
  const linked = await inspectRemoteGit(binding)
  assert.equal(linked.files[0].absolutePath, path.join(link, 'nested.txt'))
})


test('missing Git, non-repositories and timeouts have distinct outcomes', async () => {
  for (const [result, reason] of [[{ code: 127, stderr: 'git: command not found' }, 'git-unavailable'], [{ code: 128, stderr: 'fatal: not a git repository' }, 'not-repository']]) {
    const pool = { platform: 'posix', detect: async () => {}, exec: async () => result }
    assert.equal((await inspectRemoteGit({ pool, ws: '/project', bound: true })).reason, reason)
  }
  const pool = { detect: async () => {}, exec: async () => ({ code: -1, signal: 'TIMEOUT', stdout: '', stderr: '' }) }
  await assert.rejects(inspectRemoteGit({ pool, ws: '/project', bound: true }), /timed out/)
})

test('streamed status is bounded even when an underlying exec formatter truncates differently', async () => {
  let calls = 0
  const pool = { detect: async () => {}, exec: async (_command, options) => {
    calls++
    if (calls === 1) return { code: 0, stdout: '/project\n\n' }
    if (calls === 2) {
      const output = Buffer.from(' M file\0'.repeat(40000)); options.onData('stdout', output)
      assert.equal(options.signal.aborted, true)
      return { code: -1, signal: 'ABORTED', stdout: 'truncated by transport' }
    }
    return { code: 0, stdout: 'branch\n' }
  } }
  const state = await inspectRemoteGit({ pool, ws: '/project', bound: true })
  assert.equal(state.truncated, true); assert.equal(state.files.length, 500)
  assert.ok(state.files.every(f => f.path === 'file'))
})


test('detached HEAD and a new repository without commits still produce useful status', { skip: process.platform === 'win32' }, async t => {
  const { root, binding } = await setup(t)
  git(root, 'checkout', '--detach', '-q')
  let state = await inspectRemoteGit(binding)
  assert.equal(state.detached, true); assert.equal(state.branch, '')
  fs.rmSync(path.join(root, '.git'), { recursive: true, force: true }); git(root, 'init', '-q', '-b', 'unborn-branch')
  state = await inspectRemoteGit(binding)
  assert.equal(state.detached, false); assert.equal(state.branch, 'unborn-branch')
  assert.ok(state.files.length > 0); assert.ok(state.files.every(f => f.untracked))
})
