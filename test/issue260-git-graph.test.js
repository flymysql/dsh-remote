// Issue #260 — a read-only commit graph for the remote workspace. The local
// mirror deliberately never carries .git, so the host's Git tab (better-sidebar)
// can render history only when the DATA comes from the remote. action=graph
// reuses runGit: log with %H/%h/%P/%an/%ad/%D/%s, for-each-ref for branches,
// symbolic-ref for HEAD. parents drives fork/merge edges; refs drives badges.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectRemoteGit } from '../lib/remote-git.js'
import { SshPool } from '../lib/pool.js'
import { startDiskWorkspace } from './harness/disk-workspace.js'

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } })

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-graph-'))
  git(directory, 'init', '-q', '-b', 'main')
  const commit = (file, content, message) => {
    fs.writeFileSync(path.join(directory, file), content)
    git(directory, 'add', '--all')
    git(directory, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message)
  }
  commit('a.txt', 'one\n', 'first commit')
  commit('b.txt', 'two\n', 'second commit')
  commit('a.txt', 'one-changed\n', 'third commit')
  const server = await startDiskWorkspace(directory)
  const pool = new SshPool({ host: '127.0.0.1', port: server.port, username: 'root', password: 'test-only', hostKeyMode: 'off', connectTimeoutMs: 5000, commandTimeoutMs: 5000, maxOutputChars: 40000 })
  t.after(async () => { pool.close(); await server.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { root: directory, pool, binding: { pool, ws: directory, bound: true } }
}

test('#260: graph returns commits with parents, refs and branches', { skip: process.platform === 'win32' }, async (t) => {
  const { pool, binding } = await setup(t)
  const result = await inspectRemoteGit(binding, { action: 'graph', count: 50 })
  assert.equal(result.ok, true)
  assert.equal(result.available, true)
  assert.equal(result.current, 'main')
  assert.equal(result.entries.length, 3, 'all three commits are listed')
  const [third, second, first] = result.entries
  assert.equal(third.subject, 'third commit')
  assert.ok(third.hashFull.length === 40 && third.hash.length < 40, 'full and abbreviated hashes')
  assert.equal(third.parents.length, 1, 'a linear commit has one parent')
  assert.equal(second.subject, 'second commit')
  assert.equal(first.parents.length, 0, 'the root commit has no parents')
  assert.ok(third.refs.some((r) => /HEAD/.test(r)), 'HEAD decorates the tip')
  assert.ok(result.branches.some((b) => b.name === 'main' && /^refs\/heads\//.test(b.ref)), 'the branch list names main')
})

test('#260: graph respects the count cap and a branch filter', { skip: process.platform === 'win32' }, async (t) => {
  const { pool, binding } = await setup(t)
  const limited = await inspectRemoteGit(binding, { action: 'graph', count: 2 })
  assert.equal(limited.entries.length, 2, 'count caps the history')
  const filtered = await inspectRemoteGit(binding, { action: 'graph', branch: 'refs/heads/main', count: 50 })
  assert.equal(filtered.entries.length, 3)
})

test('#260: graph is read-only — status and diff keep their shapes', { skip: process.platform === 'win32' }, async (t) => {
  const { pool, binding } = await setup(t)
  const status = await inspectRemoteGit(binding, { action: 'status' })
  assert.equal(status.ok, true)
  assert.equal(status.available, true)
  assert.equal(status.branch, 'main')
  // graph is additive: existing actions still work
  await inspectRemoteGit(binding, { action: 'diff', path: 'a.txt' })
})

test('#260: an invalid branch name is rejected (no git argument injection)', { skip: process.platform === 'win32' }, async (t) => {
  const { pool, binding } = await setup(t)
  const r = await inspectRemoteGit(binding, { action: 'graph', branch: '--upload-pack=evil', count: 50 })
  // The branch regex only accepts refs/heads/<word chars>, so a hostile value
  // falls back to --all rather than being passed through to git.
  assert.equal(r.entries.length, 3)
})

test('#260: graph requires a bound session', async () => {
  const pool = { detect: () => { throw new Error('must not connect') } }
  await assert.rejects(inspectRemoteGit({ pool, ws: '/project' }, { action: 'graph' }), e => e.httpStatus === 403)
})

// Cross-platform semantic pins (mock pool): no real git needed.
function mockPool(stdout) {
  return {
    local: false,
    platform: 'posix',
    detect: async () => {},
    exec: async (script) => {
      if (/rev-parse/.test(script)) return { code: 0, stdout: '/srv/proj\n\n', stderr: '' }
      if (/symbolic-ref/.test(script)) return { code: 0, stdout: 'main\n', stderr: '' }
      if (/for-each-ref/.test(script)) return { code: 0, stdout: 'main\x1f' + 'a'.repeat(40) + '\x1frefs/heads/main\n', stderr: '' }
      if (/'log'/.test(script)) return { code: 0, stdout, stderr: '' }
      return { code: 127, stderr: 'unknown' }
    },
  }
}

const LOG_RECORD = ['a'.repeat(40), 'abc123', '', 'alice', '2026-11-27T10:00:00+08:00', 'HEAD -> main', 'first commit'].join('\x1f') + '\x1e'

test('#260 (cross-platform): graph parses record separators and parent lists correctly', async () => {
  const two = ['b'.repeat(40), 'def456', 'a'.repeat(40), 'bob', '2026-11-27T11:00:00+08:00', '', 'second commit'].join('\x1f') + '\x1e'
  const pool = mockPool(two + LOG_RECORD)
  const result = await inspectRemoteGit({ pool, ws: '/srv/proj', bound: true }, { action: 'graph', count: 50 })
  assert.equal(result.entries.length, 2)
  const [second, first] = result.entries
  assert.equal(second.subject, 'second commit')
  assert.equal(second.parents.length, 1, 'the second commit points at the first')
  assert.equal(second.parents[0], 'a'.repeat(40))
  assert.equal(first.parents.length, 0, 'the root has no parents')
  assert.equal(first.subject, 'first commit')
  assert.ok(first.refs.includes('HEAD -> main'))
  assert.equal(result.current, 'main')
  assert.equal(result.branches.length, 1)
})

test('#260 (cross-platform): a hostile branch argument is never passed to git', async () => {
  const pool = mockPool(LOG_RECORD)
  pool.execCalls = []
  const origExec = pool.exec
  pool.exec = async (script) => { pool.execCalls.push(script); return origExec(script) }
  const result = await inspectRemoteGit({ pool, ws: '/srv/proj', bound: true }, { action: 'graph', branch: '--upload-pack=evil', count: 50 })
  assert.equal(result.entries.length, 1)
  const logCall = pool.execCalls.find((s) => /'log'/.test(s))
  assert.ok(logCall.includes('--all'), 'an invalid branch falls back to --all, never the hostile string')
  assert.ok(!logCall.includes('upload-pack'), 'no injection reaches git')
})
