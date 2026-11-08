// Issue #95 — a promoted/background job was SIGTERM'd 20s in.
//
// `startExecJob` deliberately registered jobs with NO `jobDeadlineMs`, meaning
// "the command outlives the tool call". But it then OMITTED `timeoutMs` from
// the transport call, and both backends (`SshPool._execRaw`, openssh `_runSsh`)
// substituted the machine-wide `commandTimeoutMs` (default 20s) for a missing
// value. Every background job was therefore killed at 20s, and the kill message
// printed `timed out after undefinedms`.
//
// The contract is now explicit: `timeoutMs: 0` opts the transport out of any
// deadline; an absent value keeps enforcing the config default. These tests pin
// both halves against a fake client, plus the invariant that caller abort stays
// lethal when no timer exists.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createPool } from '../lib/pool.js'

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

/** A pool whose connect() yields a fake client producing channels on demand. */
function poolOverFakeClient(config = {}) {
  const streams = []
  const pool = createPool({
    host: 'fake', username: 'u', port: 22,
    commandTimeoutMs: 50, maxOutputChars: 100000, connectTimeoutMs: 1000,
    ...config,
  })
  pool.connect = async () => ({
    exec(_command, _opts, cb) {
      const stream = fakeStream()
      streams.push(stream)
      cb(null, stream)
    },
  })
  return { pool, streams }
}

/** Track settlement without awaiting. */
function watch(promise) {
  const state = { settled: false, value: undefined }
  promise.then((value) => { state.settled = true; state.value = value })
  return state
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('timeoutMs 0 arms no kill timer: the command outlives the config default', async () => {
  const { pool, streams } = poolOverFakeClient()
  const pending = pool._execRaw('sleep 5', { timeoutMs: 0 })
  const watched = watch(pending)
  await sleep(150) // 3× the 50ms config default — the buggy code killed at 50ms
  assert.equal(watched.settled, false, 'a no-deadline exec must still be running past the config default')
  assert.deepEqual(streams[0].signals, [], 'no SIGTERM was sent')
  streams[0].emit('close', 0, null)
  const res = await pending
  assert.equal(res.code, 0)
  assert.equal(res.signal, null)
})

test('omitting timeoutMs still enforces the config default (control)', async () => {
  const { pool, streams } = poolOverFakeClient()
  const watched = watch(pool._execRaw('sleep 5', {}))
  await sleep(150)
  assert.equal(watched.settled, true, 'the default deadline must still fire')
  assert.equal(watched.value.signal, 'TIMEOUT')
  assert.deepEqual(streams[0].signals, ['SIGTERM'], 'timeout kills the remote process, not just the call')
})

test('a no-deadline exec still obeys caller abort', async () => {
  const { pool, streams } = poolOverFakeClient()
  const ac = new AbortController()
  const watched = watch(pool._execRaw('sleep 5', { timeoutMs: 0, signal: ac.signal }))
  await sleep(20)
  ac.abort()
  await sleep(20)
  assert.equal(watched.settled, true)
  assert.equal(watched.value.signal, 'ABORTED')
  assert.deepEqual(streams[0].signals, ['SIGTERM'], 'abort reaches the remote process even with no timer armed')
})
