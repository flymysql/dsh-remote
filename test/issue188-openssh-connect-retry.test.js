// Issue #188 — the openssh backend retried NOTHING at the connect stage.
//
// A fresh dial that lost its SYN burned the whole `ConnectTimeout` (15s by
// default) and then surfaced as a hard transport failure, even though the very
// next dial succeeded in ~700ms. #185 gave the native backend one bounded,
// caller-shared retry for `SSH_HANDSHAKE_CLOSED`; this file pins the same
// contract for the `ssh` CLI backend.
//
// What must hold:
//   • a transient dial failure (timeout / reset / banner drop) is retried ONCE
//   • concurrent callers share that one retry instead of dialing per caller
//   • a DETERMINISTIC failure (credentials, host key, DNS, refused, unreachable)
//     is never retried — a second dial only doubles the wait
//   • both attempts' durations reach the user when the retry also fails
//   • closing/re-pointing the pool during backoff cancels the retry
//   • nothing authenticated is replayed (the probe is `ssh -- <host> true`)

import test from 'node:test'
import assert from 'node:assert/strict'
import { SystemOpenSshPool, transientConnectFailure, CONNECT_RETRY_DELAY_MS } from '../lib/openssh.js'

const baseConfig = (over = {}) => ({
  host: 'example.internal',
  port: 22,
  username: 'root',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  workspace: '',
  useAgent: false,
  keyboardInteractive: false,
  hostKeyMode: 'accept-new',
  connectTimeoutMs: 15000,
  commandTimeoutMs: 20000,
  maxOutputChars: 200000,
  backend: 'openssh',
  // `_runSsh` is stubbed in every test below, so the binary is never spawned.
  // An absolute, always-present executable keeps `sshBinaryAvailable()` honest
  // without making these tests depend on a real OpenSSH install.
  sshBinary: process.execPath,
  ...over,
})

const TIMEOUT_STDERR = 'ssh: connect to host example.internal port 22: Connection timed out'
const ok = { code: 0, signal: null, stdout: '', stderr: '' }
const dialFailure = (stderr) => ({ code: 255, signal: null, stdout: '', stderr })

/** Build a pool whose dials follow `script` (one entry per attempt). */
function scriptedPool(t, script) {
  const pool = new SystemOpenSshPool(baseConfig())
  t.after(() => pool.close())
  const attempts = []
  pool._runSsh = async () => {
    attempts.push(Date.now())
    const step = script[attempts.length - 1]
    if (step === undefined) throw new Error('unexpected extra dial: ' + attempts.length)
    return typeof step === 'function' ? step() : step
  }
  return { pool, attempts }
}

test('#188: transientConnectFailure classifies only retryable CONNECT-stage failures', () => {
  const transient = [
    TIMEOUT_STDERR,
    'ssh: connect to host h port 22: Connection reset by peer',
    'Connection closed by 10.0.0.1 port 22',
    'kex_exchange_identification: Connection closed by remote host',
    'ssh: connect to host h port 22: Operation timed out',
  ]
  for (const stderr of transient) {
    assert.equal(transientConnectFailure(dialFailure(stderr)), true, stderr)
  }
  // Our own probe timer fired: the host never answered inside the budget.
  assert.equal(transientConnectFailure({ code: -1, signal: 'TIMEOUT', stdout: '', stderr: '' }), true)

  const deterministic = [
    'root@h: Permission denied (publickey,password).',
    'Host key verification failed.',
    '@@@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@@@',
    'ssh: Could not resolve hostname h: Name or service not known',
    'ssh: connect to host h port 22: Connection refused',
    'ssh: connect to host h port 22: No route to host',
    'ssh: connect to host h port 22: Network is unreachable',
    'Unable to negotiate with 10.0.0.1 port 22: no matching key exchange method found',
    'Received disconnect from 10.0.0.1 port 22:2: Too many authentication failures',
  ]
  for (const stderr of deterministic) {
    assert.equal(transientConnectFailure(dialFailure(stderr)), false, stderr)
  }

  // PRECEDENCE: OpenSSH prefixes real auth failures with "Connection closed by
  // ...", so the deterministic list must win over the transient one.
  assert.equal(
    transientConnectFailure(dialFailure('Connection closed by 10.0.0.1 port 22: Permission denied (publickey).')),
    false,
    'an auth failure dressed as a closed connection must NOT be retried',
  )
  // Not enough evidence to spend a second dial.
  assert.equal(transientConnectFailure(dialFailure('')), false)
  assert.equal(transientConnectFailure(null), false)
})

test('#188: a transient connect timeout is retried once and the second dial wins', async t => {
  const { pool, attempts } = scriptedPool(t, [dialFailure(TIMEOUT_STDERR), ok])
  const started = Date.now()
  const conn = await pool.connect()
  assert.equal(attempts.length, 2, 'exactly one retry')
  assert.equal(pool.client, conn)
  assert.ok(Date.now() - started >= CONNECT_RETRY_DELAY_MS, 'the retry waits out the backoff')
  // The failure left no residue: a later connect() is served by the live client.
  assert.equal(await pool.connect(), conn)
  assert.equal(attempts.length, 2)
})

test('#188: our own probe timeout (signal TIMEOUT) is treated as transient', async t => {
  const { pool, attempts } = scriptedPool(t, [
    { code: -1, signal: 'TIMEOUT', stdout: '', stderr: '' },
    ok,
  ])
  await pool.connect()
  assert.equal(attempts.length, 2)
})

test('#188: a persistently timing-out host stops after two dials and reports BOTH durations', async t => {
  const { pool, attempts } = scriptedPool(t, [dialFailure(TIMEOUT_STDERR), dialFailure(TIMEOUT_STDERR)])
  await assert.rejects(pool.connect(), (error) => {
    assert.equal(error.code, 'SSH_CONNECT_TRANSIENT')
    assert.match(error.message, /Connection timed out/, 'the real ssh message survives')
    assert.match(error.message, /connect retried once: first attempt \d+ms, retry \d+ms/,
      'both attempt durations are reported so flaky link != host down')
    return true
  })
  assert.equal(attempts.length, 2, 'bounded: two dials, never a loop')
  assert.equal(pool.connecting, null, 'the shared promise is cleared for the next caller')
})

test('#188: deterministic failures surface on the FIRST attempt with no extra dial', async t => {
  const cases = [
    'root@h: Permission denied (publickey).',
    'Host key verification failed.',
    'ssh: Could not resolve hostname h: Name or service not known',
    'ssh: connect to host h port 22: Connection refused',
    'ssh: connect to host h port 22: No route to host',
    'Unable to negotiate with 10.0.0.1 port 22: no matching key exchange method found',
  ]
  for (const stderr of cases) {
    const { pool, attempts } = scriptedPool(t, [dialFailure(stderr)])
    await assert.rejects(pool.connect(), (error) => {
      assert.notEqual(error.code, 'SSH_CONNECT_TRANSIENT', stderr)
      assert.ok(error.message.includes(stderr.split(':')[0]), 'the cause reaches the caller')
      return true
    })
    assert.equal(attempts.length, 1, `must not retry: ${stderr}`)
  }
})

test('#188: concurrent callers share ONE retry instead of dialing per caller', async t => {
  const { pool, attempts } = scriptedPool(t, [dialFailure(TIMEOUT_STDERR), ok])
  const [a, b, c] = await Promise.all([pool.connect(), pool.connect(), pool.connect()])
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(attempts.length, 2, '3 simultaneous callers cost 2 dials, not 6')
})

test('#188: closing the pool during backoff cancels the retry', async t => {
  const pool = new SystemOpenSshPool(baseConfig())
  t.after(() => pool.close())
  let attempts = 0
  pool._runSsh = async () => {
    attempts += 1
    setTimeout(() => pool.close(), 20)
    return dialFailure(TIMEOUT_STDERR)
  }
  await assert.rejects(pool.connect(), /target changed/)
  // Outlive the backoff: no second dial may have happened.
  await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS + 250))
  assert.equal(attempts, 1)
})

test('#188: the retry re-dials the SAME target and leaves handshake policy untouched', async t => {
  const pool = new SystemOpenSshPool(baseConfig({ hostKeyMode: 'strict' }))
  t.after(() => pool.close())
  const calls = []
  pool._runSsh = async (extraArgs, opts) => {
    calls.push({ extraArgs, opts })
    return calls.length === 1 ? dialFailure(TIMEOUT_STDERR) : ok
  }
  await pool.connect()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].extraArgs, calls[1].extraArgs, 'identical argv: same destination, same policy')
  assert.equal(calls[0].opts.timeoutMs, calls[1].opts.timeoutMs, 'same connect budget')
  assert.equal(pool.config.hostKeyMode, 'strict', 'the retry never relaxes host-key checking')
})
