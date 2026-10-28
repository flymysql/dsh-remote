// Remote sandbox parity — a confined session must not be able to reach a
// remote host and mutate it freely.
//
// The gap: local tools run under `ctx.sandboxPolicy`, but every rw_* tool ran
// remote operations with NO policy. A `read-only` session could `rw_write_file`
// anywhere on any reachable host — not because the sandbox was bypassed, but
// because it had no say over a different machine.
//
// `ctx.sandbox.confine()` cannot close this: it wraps argv for a spawn on THIS
// machine, and our process runs on the far side of an SSH channel (the core
// docs say remote execution REPLACES the surrounding seam). So the fence lives
// at the tool boundary with the OFFICIAL denial shape, and its threat model is
// stated honestly: containment, not a security boundary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isInsideRemote, checkRemoteSandbox, remoteSandboxDenial, REMOTE_SANDBOX_MODES,
} from '../lib/remote-sandbox.js'

// ── containment predicate ──────────────────────────────────────────────────

test('isInsideRemote is separator-aware (no /tmp/foo vs /tmp/foobar trap)', () => {
  assert.equal(isInsideRemote('/tmp/foo/a.txt', '/tmp/foo'), true)
  assert.equal(isInsideRemote('/tmp/foo', '/tmp/foo'), true, 'the root itself is inside')
  assert.equal(isInsideRemote('/tmp/foobar/a.txt', '/tmp/foo'), false, 'a sibling prefix must NOT count')
  assert.equal(isInsideRemote('/tmp/foo/../etc/passwd', '/tmp/foo'), false, 'normalization kills .. escapes')
  assert.equal(isInsideRemote('/tmp/foo/sub/../../etc', '/tmp/foo'), false)
  assert.equal(isInsideRemote('/tmp/foo/', '/tmp/foo'), true, 'trailing separators are irrelevant')
})

test('a filesystem-root workspace contains everything (issue #60 setup stays usable)', () => {
  assert.equal(isInsideRemote('/anything/at/all', '/'), true)
  assert.equal(isInsideRemote('/etc/passwd', '/'), true)
})

test('non-string / relative inputs never claim containment', () => {
  assert.equal(isInsideRemote(null, '/tmp/foo'), false)
  assert.equal(isInsideRemote('/tmp/foo/a', null), false)
  assert.equal(isInsideRemote('/tmp/foo/a', 'tmp/foo'), false, 'a relative root cannot prove anything')
})

// ── the decision table ─────────────────────────────────────────────────────

const ROOT = '/srv/proj'

test('danger-full-access permits every remote operation', () => {
  for (const op of ['read', 'write', 'exec', 'tunnel', 'connect']) {
    const v = checkRemoteSandbox({ mode: 'danger-full-access', operation: op, path: '/etc/passwd', workspaceRoot: ROOT })
    assert.equal(v.allowed, true, `${op} must be allowed`)
  }
})

test('read-only refuses remote MUTATION but still reads and connects', () => {
  const w = checkRemoteSandbox({ mode: 'read-only', operation: 'write', path: '/srv/proj/a.txt', workspaceRoot: ROOT })
  assert.equal(w.allowed, false, 'read-only must refuse a remote write even inside the workspace')
  assert.equal(w.mode, 'read-only')
  const e = checkRemoteSandbox({ mode: 'read-only', operation: 'exec', workspaceRoot: ROOT })
  assert.equal(e.allowed, false, 'read-only must refuse running remote commands')
  assert.equal(e.subject, 'command')
  const t = checkRemoteSandbox({ mode: 'read-only', operation: 'tunnel', workspaceRoot: ROOT })
  assert.equal(t.allowed, false, 'read-only must refuse opening a remote tunnel')
  // Reads and connections change no remote state, so they stay available —
  // otherwise a read-only session could not even inspect the machine.
  for (const op of ['read', 'connect']) {
    assert.equal(checkRemoteSandbox({ mode: 'read-only', operation: op, workspaceRoot: ROOT }).allowed, true, op)
  }
})

test('workspace-write fences writes to the workspace, allows exec/tunnel/read', () => {
  const inside = checkRemoteSandbox({ mode: 'workspace-write', operation: 'write', path: '/srv/proj/src/a.c', workspaceRoot: ROOT })
  assert.equal(inside.allowed, true)
  const outside = checkRemoteSandbox({ mode: 'workspace-write', operation: 'write', path: '/etc/passwd', workspaceRoot: ROOT })
  assert.equal(outside.allowed, false)
  assert.match(outside.reason, /only permits changes inside \/srv\/proj/)
  const sibling = checkRemoteSandbox({ mode: 'workspace-write', operation: 'write', path: '/srv/proj-evil/x', workspaceRoot: ROOT })
  assert.equal(sibling.allowed, false, 'the prefix trap must not open a hole')
  // Commands and tunnels run: a lexical fence cannot bound what a shell does,
  // and pretending otherwise would be worse than documenting the limit.
  assert.equal(checkRemoteSandbox({ mode: 'workspace-write', operation: 'exec', workspaceRoot: ROOT }).allowed, true)
  assert.equal(checkRemoteSandbox({ mode: 'workspace-write', operation: 'tunnel', workspaceRoot: ROOT }).allowed, true)
})

test('workspace-write with no resolvable root fails closed', () => {
  const v = checkRemoteSandbox({ mode: 'workspace-write', operation: 'write', path: '/srv/proj/a', workspaceRoot: '' })
  assert.equal(v.allowed, false)
  assert.match(v.reason, /needs a remote workspace root/)
})

test('an unknown mode falls back to read-only (fail closed)', () => {
  const v = checkRemoteSandbox({ mode: 'sudo-everything', operation: 'write', path: '/x', workspaceRoot: ROOT })
  assert.equal(v.allowed, false)
  assert.equal(v.mode, 'read-only')
})

test('the three official mode names are exactly what we accept', () => {
  assert.deepEqual(REMOTE_SANDBOX_MODES, ['read-only', 'workspace-write', 'danger-full-access'])
})

// ── denial shape ───────────────────────────────────────────────────────────

test('the denial carries the official markers so escalation affordances still work', () => {
  const err = remoteSandboxDenial({ mode: 'workspace-write', subject: 'operation', reason: 'outside the workspace' })
  assert.equal(err.code, 'FS_SANDBOX_DENIED')
  assert.match(err.message, /^\[sandbox: workspace-write\]/)
  assert.match(err.message, /outside the workspace/)
  assert.match(err.message, /\[escalation: .*operation.*\]/, 'the same-turn escalation hint must ride along')
  assert.deepEqual(err.remoteSandbox, { mode: 'workspace-write', subject: 'operation' })
})

test('a command denial names the command subject', () => {
  const err = remoteSandboxDenial({ mode: 'read-only', subject: 'command', reason: 'no commands' })
  assert.match(err.message, /\[escalation: .*command.*\]/)
})
