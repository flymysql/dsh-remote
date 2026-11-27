// Issue #65 — "one SFTP timeout wedges the machine for the whole process".
//
// The reported cascade: a single operation eats the full commandTimeoutMs, the
// rejection surfaces… and nothing else happens. The channel is not marked
// dead, not closed, and the pool keeps handing it out, so every later
// rw_read_file / rw_list_dir / rw_edit queues behind the wedged request and
// pays its own 20s — until a disconnect/restart. Worse, rw_edit staged its
// write directly onto the target file, so an interrupted write truncated it.
//
// The surface-level contract these tests pin:
//   1. a timed-out operation KILLS the surface: later calls reject
//      immediately with "sftp channel closed" instead of paying the timeout
//      again;
//   2. the pool/openssh backend is told through `onTimeout`, so it can close
//      the subchannel / kill the child and count the strike;
//   3. a callback arriving AFTER the timeout must not resolve or double-
//      reject the already-settled promise (the wedged peer can still answer
//      late).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSftpSurface } from '../lib/sftp-surface.js'

/** An sftp channel whose operations never answer — the wedged peer. */
function wedgedChannel() {
  const listeners = new Map()
  return {
    on(ev, fn) { listeners.set(ev, fn) },
    emit(ev) { const fn = listeners.get(ev); if (fn) fn() },
    readdir(_d, _cb) { /* never calls back */ },
    stat(_p, _cb) { /* never calls back */ },
  }
}

test('a timeout marks the surface dead so the NEXT call fails fast', async () => {
  const sftp = wedgedChannel()
  const surface = buildSftpSurface(sftp, { commandTimeoutMs: 25 })

  const t0 = Date.now()
  await assert.rejects(() => surface.stat('/x'), /timed out/)
  const first = Date.now() - t0
  assert.ok(first >= 20, `first call should pay the timeout (took ${first}ms)`)

  const t1 = Date.now()
  await assert.rejects(() => surface.readdir('/x'), /sftp channel closed/)
  const second = Date.now() - t1
  assert.ok(second < 20, `second call must fail fast, not pay another timeout (took ${second}ms)`)
})

test('the onTimeout hook fires exactly once per surface, even across several timed-out calls', async () => {
  const sftp = wedgedChannel()
  let calls = 0
  const surface = buildSftpSurface(sftp, { commandTimeoutMs: 20, onTimeout: () => { calls++ } })
  await assert.rejects(() => surface.stat('/a'))
  // The surface is dead now; a second call rejects via the dead check before
  // any timer is even armed.
  await assert.rejects(() => surface.stat('/b'), /sftp channel closed/)
  assert.equal(calls, 1)
})

test('a late answer after the timeout cannot settle the promise again', async () => {
  let saved
  const sftp = {
    on() {},
    stat(_p, cb) { saved = cb }, // capture, answer later
  }
  const surface = buildSftpSurface(sftp, { commandTimeoutMs: 20 })
  const outcome = await Promise.allSettled([
    surface.stat('/late'),
    (async () => {
      await new Promise((r) => setTimeout(r, 60)) // well past the timeout
      saved(null, { size: 1 }) // the wedged peer finally answers
      await new Promise((r) => setTimeout(r, 10))
    })(),
  ])
  assert.equal(outcome[0].status, 'rejected')
  assert.match(String(outcome[0].reason), /timed out/)
})

test('an end/close event still fails fast without invoking onTimeout (issue #44 path intact)', async () => {
  const sftp = wedgedChannel()
  let calls = 0
  const surface = buildSftpSurface(sftp, { commandTimeoutMs: 20, onTimeout: () => { calls++ } })
  sftp.emit('close')
  await assert.rejects(() => surface.stat('/x'), /sftp channel closed/)
  assert.equal(calls, 0, 'a clean EOF is not a timeout — no strike counted')
})

test('a healthy channel resolves normally and never touches onTimeout', async () => {
  const sftp = {
    on() {},
    stat(p, cb) { cb(null, { size: 3, path: p }) },
  }
  let calls = 0
  const surface = buildSftpSurface(sftp, { commandTimeoutMs: 50, onTimeout: () => { calls++ } })
  const st = await surface.stat('/ok')
  assert.equal(st.size, 3)
  assert.equal(calls, 0)
})

test('renameOverwrite uses posix-rename when the server advertises it', async () => {
  // rw_edit's atomic write renames OVER an existing file. Plain SSH_FXP_RENAME
  // refuses that (OpenSSH's sftp-server enforces the spec), so the wrapper must
  // reach for the posix-rename extension the server already advertised — this
  // is the exact failure a bare "Failure" gave every edit on OpenSSH_9.6.
  const calls = []
  const sftp = {
    on() {},
    _extensions: { 'posix-rename@openssh.com': '1' },
    ext_openssh_rename(a, b, cb) { calls.push(['ext', a, b]); cb(null) },
    rename(a, b, cb) { calls.push(['plain', a, b]); cb(new Error('Failure')) },
  }
  const surface = buildSftpSurface(sftp, { commandTimeoutMs: 50 })
  await surface.renameOverwrite('/f.tmp', '/f.txt')
  assert.deepEqual(calls, [['ext', '/f.tmp', '/f.txt']], 'the extension path must win when advertised')
})

test('renameOverwrite falls back to the move-aside dance without the extension', async () => {
  const fs = new Map([['/f.txt', 'old'], ['/f.tmp', 'new']])
  const renames = []
  const sftp = {
    on() {},
    _extensions: {},
    rename(a, b, cb) {
      renames.push([a, b])
      if (fs.has(b)) return cb(new Error('Failure')) // spec: no overwrite
      const v = fs.get(a)
      fs.delete(a); fs.set(b, v)
      cb(null)
    },
    unlink(p, cb) { fs.delete(p); cb(null) },
  }
  const surface = buildSftpSurface(sftp, { commandTimeoutMs: 50 })
  await surface.renameOverwrite('/f.tmp', '/f.txt')
  assert.equal(fs.get('/f.txt'), 'new')
  assert.equal([...fs.keys()].some((k) => k.includes('dsh-remote-bak')), false, 'backup must be cleaned up')
  assert.deepEqual(renames[0], ['/f.txt', renames[0][1]], 'hop 1 moves the destination aside')
  assert.deepEqual(renames[1], ['/f.tmp', '/f.txt'], 'hop 2 installs the new content')
})

test('renameOverwrite tries to restore the original when the install hop fails', async (t) => {
  const installError = Object.assign(new Error('disk full'), { code: 4 })

  function fixture(rollbackError) {
    const fs = new Map([['/f.txt', 'old'], ['/f.tmp', 'new']])
    const renames = []
    const unlinks = []
    const sftp = {
      on() {},
      _extensions: {},
      rename(a, b, cb) {
        renames.push([a, b])
        if (renames.length === 2) return cb(installError)
        if (renames.length === 3 && rollbackError) return cb(rollbackError)
        const v = fs.get(a)
        fs.delete(a); fs.set(b, v)
        cb(null)
      },
      unlink(p, cb) { unlinks.push(p); fs.delete(p); cb(null) },
    }
    const surface = buildSftpSurface(sftp, { commandTimeoutMs: 50 })
    return { fs, renames, unlinks, surface }
  }

  await t.test('successful rollback returns the original install error', async () => {
    const { fs, unlinks, surface } = fixture()
    await assert.rejects(() => surface.renameOverwrite('/f.tmp', '/f.txt'), error => error === installError)
    assert.equal(fs.get('/f.txt'), 'old', 'the original content must be restored')
    assert.deepEqual(unlinks, [])
  })

  await t.test('failed rollback reports both errors and retains the backup', async () => {
    const rollbackError = Object.assign(new Error('permission denied'), { code: 3 })
    const { fs, renames, unlinks, surface } = fixture(rollbackError)
    await assert.rejects(() => surface.renameOverwrite('/f.tmp', '/f.txt'), error => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [installError, rollbackError])
      assert.equal(error.code, installError.code)
      assert.match(error.message, /install failed.*disk full/i)
      assert.match(error.message, /rollback failed.*permission denied/i)
      assert.ok(error.message.includes(renames[0][1]), 'the error must name the retained backup')
      return true
    })
    const backup = renames[0][1]
    assert.deepEqual(renames, [['/f.txt', backup], ['/f.tmp', '/f.txt'], [backup, '/f.txt']])
    assert.deepEqual(fs, new Map([['/f.tmp', 'new'], [backup, 'old']]))
    assert.deepEqual(unlinks, [])
  })
})

test('setstat passes through with the same timeout/dead rules (rw_edit mode restore)', async () => {
  // rw_edit's atomic rename swaps in a fresh inode, so the edit path restores
  // the original permission bits via setstat. The wrapper must behave like
  // every other operation: passthrough on a healthy channel, fail fast on a
  // dead one.
  const seen = []
  const sftp = {
    on() {},
    setstat(p, attrs, cb) { seen.push([p, attrs]); cb(null) },
  }
  const surface = buildSftpSurface(sftp, { commandTimeoutMs: 50 })
  await surface.setstat('/proj/run.sh', { mode: 0o755 })
  assert.deepEqual(seen, [['/proj/run.sh', { mode: 0o755 }]])

  const wedged = buildSftpSurface({ on() {}, setstat() { /* never answers */ } }, { commandTimeoutMs: 20 })
  await assert.rejects(() => wedged.setstat('/x', { mode: 0o644 }), /timed out/)
  await assert.rejects(() => wedged.setstat('/x', { mode: 0o644 }), /sftp channel closed/)
})
