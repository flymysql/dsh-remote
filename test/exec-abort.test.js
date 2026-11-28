// Exec cancellation must be honoured BEFORE the command leaves this host.
//
// Both backends used to discover a pre-aborted signal too late:
//   • `pool.js` `_execRaw` called `client.exec(...)` first and only looked at
//     the caller's AbortSignal inside the exec callback — the SSH exec request
//     had already been dispatched to the remote host.
//   • `openssh.js` `_runSsh` spawned the `ssh` child before its own aborted
//     check, so the command (argv and all) was already in flight.
//
// A cancelled call must cost nothing on the network:
//   1. native backend: a pre-aborted signal resolves ABORTED with ZERO
//      client.exec dispatches (the old code dispatched once, then noticed).
//   2. openssh backend: a pre-aborted signal never spawns the ssh child. The
//      fake binary TRAPS TERM so a wrong spawn that survives its first ticks
//      stays findable for the whole check — but the old code's kill() fires
//      in the SAME tick as its spawn, and that immediate SIGTERM lands
//      before the shebang shell can arm its trap (measured 20/20), so
//      liveness alone cannot expose the base: the check-vs-spawn ORDER in
//      _runSsh's source is pinned as well, the way issue #118 pins wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { SshPool } from '../lib/pool.js'
import { SystemOpenSshPool } from '../lib/openssh.js'

/** One controllable fake exec channel (what ssh2 hands our callback). */
function fakeStream() {
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.signals = []
  stream.signal = (name) => stream.signals.push(name)
  stream.closed = false
  stream.close = () => { stream.closed = true }
  return stream
}

/** PIDs whose full command line mentions `needle` (pgrep exits 1 when none). */
function pidsMatching(needle) {
  try {
    return execFileSync('pgrep', ['-f', needle], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

// ── native: no dispatch for an already-cancelled call ────────────────────────

test('a pre-aborted signal dispatches NOTHING on the native backend', async (t) => {
  const pool = new SshPool({
    host: 'fake', username: 'u', port: 22,
    commandTimeoutMs: 50, maxOutputChars: 100000, connectTimeoutMs: 1000,
  })
  // Skip detect(): this test is only about the dispatch decision under it.
  pool.platform = 'posix'
  t.after(() => pool.close())

  const dispatched = []
  pool.connect = async () => ({
    exec(command, _opts, cb) {
      // Recording this line already means the request left for the host.
      dispatched.push(command)
      cb(null, fakeStream())
    },
  })

  const res = await pool.exec('echo sensitive', { signal: AbortSignal.abort(), timeoutMs: 1000 })

  assert.equal(dispatched.length, 0,
    `a cancelled call must not reach client.exec (dispatched: ${JSON.stringify(dispatched)})`)
  assert.equal(res.code, -1)
  assert.equal(res.signal, 'ABORTED')
  assert.equal(res.stdout, '')
  assert.equal(res.stderr, '')
})

// ── openssh: no spawn for an already-cancelled call ──────────────────────────

test('a pre-aborted signal never spawns the ssh child on the openssh backend', {
  skip: process.platform === 'win32' ? 'the TERM-trap fake needs a POSIX /bin/sh' : false,
}, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-exec-abort.'))
  // TRAPS TERM on purpose: a wrong spawn that gets past the base's immediate
  // kill must not exit quietly where the check below cannot see it. The 30s
  // sleep keeps such a child findable for the whole check.
  const bin = path.join(dir, 'fake-ssh')
  writeFileSync(bin, '#!/bin/sh\ntrap \'\' TERM\nsleep 30\n')
  chmodSync(bin, 0o755)
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } })

  const pool = new SystemOpenSshPool({
    host: 'example.internal', port: 22, username: 'root', password: '',
    privateKeyPath: '', passphrase: '', workspace: '', useAgent: false,
    keyboardInteractive: false, hostKeyMode: 'accept-new', connectTimeoutMs: 15000,
    commandTimeoutMs: 20000, maxOutputChars: 200000, backend: 'openssh', sshBinary: bin,
  })
  // Skip detect(): its probes would legitimately spawn the binary, and this
  // test is only about what a cancelled call costs.
  pool.platform = 'posix'
  t.after(() => pool.close())

  try {
    const res = await pool.exec('echo sensitive', { signal: AbortSignal.abort(), timeoutMs: 1000 })
    assert.equal(res.code, -1)
    assert.equal(res.signal, 'ABORTED')
    assert.equal(res.stdout, '')
    assert.equal(res.stderr, '')
    // A wrong spawn that survived past its first ticks lives for its whole
    // 30s sleep; give it a moment to be visible, then rule on its existence.
    await new Promise((r) => setTimeout(r, 300))
    const alive = pidsMatching(bin)
    assert.deepEqual(alive, [],
      `a cancelled call must never spawn the ssh child (alive: ${alive.join(', ')})`)
    // Liveness alone cannot expose the base: its kill() fires in the SAME
    // tick as its spawn, and that immediate SIGTERM lands before the shebang
    // shell can arm its trap (measured 20/20), so a wrong spawn leaves no
    // survivor to pgrep. What it does leave is the wrong ORDER — pin that,
    // the way issue #118 pins wiring it cannot reproduce live.
    const src = readFileSync(new URL('../lib/openssh.js', import.meta.url), 'utf8')
    const start = src.indexOf('async _runSsh(')
    const end = src.indexOf('/** Detect the remote platform', start)
    const body = src.slice(start, end === -1 ? undefined : end)
    const spawnAt = body.indexOf('child = spawn(')
    assert.ok(spawnAt > -1, 'sanity: _runSsh still spawns its ssh child somewhere')
    const abortAt = body.search(/signal[?]?[.]aborted/)
    assert.ok(abortAt > -1, 'sanity: _runSsh still checks the caller signal somewhere')
    assert.ok(abortAt < spawnAt,
      'the pre-aborted check must run BEFORE the ssh child is spawned — the old order let the command leave first')
  } finally {
    // The trap ignores TERM by design, so leftovers need SIGKILL — and must
    // never outlive this test even when an assertion above failed.
    for (const pid of pidsMatching(bin)) { try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ } }
  }
})
