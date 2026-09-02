// Session → remote-binding resolution (issue #25).
//
// The bug: SSH connection and remote workspace were process-global, so two
// sessions working on DIFFERENT machines took the connection from each other
// and commands landed on the wrong host — silently, because the connection
// itself was healthy.
//
// The fix these tests pin: a session's remote target comes from its own
// workspace mirror's `.dsh-remote-meta.json`, so it never depends on which
// machine happens to be active, and two machines never share a pool key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveMirror, poolKey } from '../lib/binding.js'

const root = () => mkdtempSync(path.join(tmpdir(), 'dsh-remote-bind-'))

/** Create a mirror dir with its origin meta, as ensureMirror() does. */
function mirror(rootDir, { host, port = 22, username, remotePath, base }) {
  const tag = [host, username, port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  const dir = path.join(rootDir, tag, base)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({ host, port, username, remotePath }))
  return dir
}

test('resolveMirror: a session cwd resolves to ITS OWN mirror machine, not a shared one', () => {
  const d = root()
  const linux = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj', base: 'proj' })
  const win = mirror(d, { host: '10.0.0.2', username: 'Administrator', remotePath: 'C:\\work\\tool', base: 'tool' })

  const a = resolveMirror(linux, d)
  const b = resolveMirror(win, d)

  assert.equal(a.machine.host, '10.0.0.1')
  assert.equal(a.remotePath, '/home/lucas/proj')
  assert.equal(b.machine.host, '10.0.0.2')
  assert.equal(b.remotePath, 'C:\\work\\tool')
  // The two sessions must not be able to reach each other's connection.
  assert.notEqual(poolKey(a.machine), poolKey(b.machine))
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: a path NESTED inside a mirror resolves to that mirror', () => {
  const d = root()
  const m = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj', base: 'proj' })
  const nested = path.join(m, 'src', 'deep')
  mkdirSync(nested, { recursive: true })

  const r = resolveMirror(nested, d)
  assert.equal(r.mirrorDir, m)
  assert.equal(r.remotePath, '/home/lucas/proj')
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: two mirrors of the same remote basename stay distinct', () => {
  const d = root()
  // mirrorDirFor() disambiguates a basename collision with a short hash, so the
  // registry holds `<host-tag>/<base>` and `<host-tag>/<base>-<hash>` side by
  // side. Each must resolve to its OWN remote path.
  const first = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/a/proj', base: 'proj' })
  const second = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/b/proj', base: 'proj-1a2b3c' })

  assert.equal(resolveMirror(first, d).remotePath, '/home/lucas/a/proj')
  assert.equal(resolveMirror(second, d).remotePath, '/home/lucas/b/proj')
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: a sibling whose name PREFIXES a mirror is not treated as inside it', () => {
  const d = root()
  mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj', base: 'proj' })
  // `proj-2` shares the `proj` string prefix but is a different workspace.
  const sibling = mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj-2', base: 'proj-2' })

  assert.equal(resolveMirror(sibling, d).remotePath, '/home/lucas/proj-2')
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: a LOCAL (non-mirror) cwd yields no binding — callers must refuse, not guess', () => {
  const d = root()
  mirror(d, { host: '10.0.0.1', username: 'lucas', remotePath: '/home/lucas/proj', base: 'proj' })

  const r = resolveMirror('/root/some/local/project', d)
  assert.equal(r.machine, null)
  assert.equal(r.remotePath, '')
  assert.equal(r.mirrorDir, null)
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: unparsable or host-less meta is skipped rather than guessed at', () => {
  const d = root()
  const broken = path.join(d, 'host-user-22', 'broken')
  mkdirSync(broken, { recursive: true })
  writeFileSync(path.join(broken, '.dsh-remote-meta.json'), '{ not json')
  const hostless = path.join(d, 'host-user-22', 'hostless')
  mkdirSync(hostless, { recursive: true })
  writeFileSync(path.join(hostless, '.dsh-remote-meta.json'), JSON.stringify({ remotePath: '/tmp/x' }))

  assert.equal(resolveMirror(broken, d).machine, null)
  assert.equal(resolveMirror(hostless, d).machine, null)
  rmSync(d, { recursive: true, force: true })
})

test('resolveMirror: missing registry root / empty path are handled without throwing', () => {
  assert.deepEqual(resolveMirror('', '/nonexistent'), { mirrorDir: null, remotePath: '', machine: null })
  assert.deepEqual(resolveMirror('/x', '/nonexistent-root-xyz'), { mirrorDir: null, remotePath: '', machine: null })
})

test('poolKey: same machine shares one key; any identity field change splits it', () => {
  const base = { host: 'h', port: 22, username: 'u' }
  assert.equal(poolKey(base), poolKey({ ...base }))
  assert.equal(poolKey(base), 'u@h:22')
  // Sessions on the same host but a different user or port are different
  // logins, so they must not share a connection.
  assert.notEqual(poolKey(base), poolKey({ ...base, username: 'other' }))
  assert.notEqual(poolKey(base), poolKey({ ...base, port: 2222 }))
  assert.notEqual(poolKey(base), poolKey({ ...base, host: 'other' }))
})

test('poolKey: a missing port defaults to 22 so both spellings share one pool', () => {
  assert.equal(poolKey({ host: 'h', username: 'u' }), 'u@h:22')
  assert.equal(poolKey({ host: 'h', username: 'u', port: '22' }), 'u@h:22')
})
