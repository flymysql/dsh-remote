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
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { lookupSessionCwd, resolveMirror, poolKey, encodeSegmentSafe } from '../lib/binding.js'

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
  assert.deepEqual(resolveMirror(path.join(nested, 'new-dir'), d), r)
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

/** Build a `$DSH_HOME` holding one session log, as DSH writes it on disk. */
const sessionHome = (sessionId, fileName, header) => {
  const home = root()
  const dir = path.join(home, 'sessions', '--project--', encodeSegmentSafe(sessionId))
  mkdirSync(dir, { recursive: true })
  const body = Buffer.from(JSON.stringify(header) + '\n')
  writeFileSync(path.join(dir, fileName), fileName.endsWith('.gz') ? gzipSync(body) : body)
  return home
}

// DSH names the log `session.<format>.jsonl[.zst|.gz]`, and the format segment
// changes between releases (v4 today). A fixed name list made every session of a
// newer DSH look like it had no cwd: the host then answered 403 for
// `/dsh-remote/workspace-context` and the explorer showed "this session is a
// local workspace" even for a remote one.
test('lookupSessionCwd: finds a versioned session log written by a newer DSH', () => {
  const home = sessionHome('session-abc', 'session.v4.jsonl.gz', { type: 'session', version: 4, id: 'session-abc', cwd: '/work/project' })
  assert.equal(lookupSessionCwd('session-abc', { dshHome: home }), '/work/project')
  rmSync(home, { recursive: true, force: true })
})

test('lookupSessionCwd: keeps reading unversioned logs and prefers the newest format', () => {
  const home = root()
  const dir = path.join(home, 'sessions', '--project--', encodeSegmentSafe('session-old'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'session.jsonl'), JSON.stringify({ type: 'session', cwd: '/work/old' }) + '\n')
  assert.equal(lookupSessionCwd('session-old', { dshHome: home }), '/work/old')

  // A newer format appears next to it: the newest one wins, so an upgrade does
  // not keep resolving through the stale file.
  writeFileSync(path.join(dir, 'session.v4.jsonl'), JSON.stringify({ type: 'session', cwd: '/work/new' }) + '\n')
  assert.equal(lookupSessionCwd('session-old', { dshHome: home }), '/work/new')
  rmSync(home, { recursive: true, force: true })
})

test('lookupSessionCwd: unknown session resolves to empty, never to a sibling cwd', () => {
  const home = sessionHome('session-known', 'session.v4.jsonl', { type: 'session', cwd: '/work/known' })
  assert.equal(lookupSessionCwd('session-missing', { dshHome: home }), '')
  rmSync(home, { recursive: true, force: true })
})


/** Link `target` at `link` (junction on Windows — no admin needed). Returns
 *  false when the OS refuses, so the case is SKIPPED, never silently passed. */
function linkDir(target, link) {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

// Issue #173: `%USERPROFILE%\.dsh` is often an NTFS Junction to another drive,
// while a session's cwd arrives in the REAL spelling. `path.resolve` is purely
// lexical, so the prefix test said "not inside any mirror" and every rw_* tool
// refused the session as LOCAL.
test('resolveMirror: a cwd in the REAL spelling still binds when the registry root is a junction', (t) => {
  const real = root()
  const links = root()
  const m = mirror(real, { host: '192.168.0.204', port: 3022, username: 'root', remotePath: '/srv/app', base: 'default' })
  const linkedRoot = path.join(links, '.dsh', 'remote-workspaces')
  mkdirSync(path.dirname(linkedRoot), { recursive: true })
  if (!linkDir(real, linkedRoot)) { rmSync(real, { recursive: true, force: true }); rmSync(links, { recursive: true, force: true }); return t.skip('this OS refuses directory links') }
  try {
    const nested = path.join(m, 'src', 'deep')
    mkdirSync(nested, { recursive: true })
    const r = resolveMirror(nested, linkedRoot)
    assert.equal(r.machine?.host, '192.168.0.204')
    assert.equal(r.machine?.port, 3022)
    assert.equal(r.remotePath, '/srv/app')
    // The reported mirror keeps the CWD's spelling, so downstream path mapping
    // compares like with like.
    assert.equal(r.mirrorDir, m)
    rmSync(nested, { recursive: true, force: true })
  } finally {
    rmSync(real, { recursive: true, force: true })
    rmSync(links, { recursive: true, force: true })
  }
})

test('resolveMirror: a cwd written THROUGH a junction still binds to a literally spelled root', (t) => {
  const real = root()
  const links = root()
  const m = mirror(real, { host: '10.9.9.9', username: 'dev', remotePath: '/home/dev/proj', base: 'proj' })
  const linkedMirror = path.join(links, 'proj-link')
  if (!linkDir(m, linkedMirror)) { rmSync(real, { recursive: true, force: true }); rmSync(links, { recursive: true, force: true }); return t.skip('this OS refuses directory links') }
  try {
    const nested = path.join(linkedMirror, 'src')
    mkdirSync(nested, { recursive: true })
    const r = resolveMirror(nested, real)
    assert.equal(r.machine?.host, '10.9.9.9')
    assert.equal(r.remotePath, '/home/dev/proj')
    // ...and the mirror is re-spelled the way the cwd spells it.
    assert.equal(r.mirrorDir, linkedMirror)
    rmSync(nested, { recursive: true, force: true })
  } finally {
    rmSync(real, { recursive: true, force: true })
    rmSync(links, { recursive: true, force: true })
  }
})

test('resolveMirror: nested directory aliases still resolve to the registered mirror root', (t) => {
  const registry = root()
  const links = root()
  t.after(() => {
    rmSync(links, { recursive: true, force: true })
    rmSync(registry, { recursive: true, force: true })
  })
  const m = mirror(registry, { host: 'mirror.example', username: 'dev', remotePath: '/srv/app', base: 'app' })
  const linkedRoot = path.join(links, 'registry')
  if (!linkDir(registry, linkedRoot)) return t.skip('this OS refuses directory links')

  const src = path.join(m, 'src')
  const view = path.join(m, 'views', 'default')
  mkdirSync(src)
  mkdirSync(view, { recursive: true })
  if (!linkDir(src, path.join(view, 'sources'))) return t.skip('this OS refuses directory links')

  const cwd = path.join(linkedRoot, path.relative(registry, view), 'sources')
  const r = resolveMirror(cwd, registry)
  assert.equal(r.remotePath, '/srv/app')
  assert.equal(realpathSync.native(r.mirrorDir), realpathSync.native(m))
})

test('resolveMirror: a linked root never makes a NON-mirror path look bound', (t) => {
  const real = root()
  const links = root()
  mirror(real, { host: '10.0.0.7', username: 'u', remotePath: '/srv/a', base: 'a' })
  mkdirSync(path.join(real, 'not-a-mirror', 'sub'), { recursive: true })
  const linkedRoot = path.join(links, 'root-link')
  if (!linkDir(real, linkedRoot)) { rmSync(real, { recursive: true, force: true }); rmSync(links, { recursive: true, force: true }); return t.skip('this OS refuses directory links') }
  try {
    const r = resolveMirror(path.join(linkedRoot, 'not-a-mirror', 'sub'), linkedRoot)
    assert.equal(r.machine, null, 'a directory without meta must never bind')
    assert.equal(r.mirrorDir, null)
  } finally {
    rmSync(real, { recursive: true, force: true })
    rmSync(links, { recursive: true, force: true })
  }
})
