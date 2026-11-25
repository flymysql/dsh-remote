// Issue #204 — a link flap left a Web UI attach as a PERMANENT dead end:
//
//   · the ssh client died → the pool cleared its own reference (no reconnect —
//     the pool only dials when something CALLS it),
//   · the attach noticed via the client's own 'close' (issue #54) but its
//     recovery machinery (onReady → re-attach + re-resolve) needed SOMEONE to
//     reconnect the pool first,
//   · so an idle attach kept its local listener accepting connections that
//     _pipe() could only RST (this.client === null), while the remote dsh web
//     process was alive and well the whole time. The UI said nothing; the only
//     way out was manually disconnecting.
//
// The fix: _clientLost now drives its own reconnect loop (pool.connect with a
// growing backoff; the pool memoizes in-flight dials so concurrent drivers
// share one attempt). A successful dial fires the existing onReady chain,
// which re-attaches the client and re-resolves (restarting the remote when it
// did not survive). The loop stops on success, close(), or pool change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebAttach, TAIL_MARKER } from '../lib/web-attach.js'

const READY = (port = 43129, token = 'tok123') =>
  `__DSH_PID__=999\n dsh web: http://127.0.0.1:${port}/?token=${token}\n${TAIL_MARKER}\n`

/** A client that models the ssh2 behaviour this issue cares about: an
 *  EventEmitter whose 'close' can be fired by the test. */
class ScriptedClient extends EventEmitter {}

/** A net.Server double (same shape as test/issue54-stale-client.test.js). */
function fakeNet() {
  return {
    servers: [],
    createServer(onConnection) {
      const server = new EventEmitter()
      server.connections = []
      server.listen = (port, host, cb) => {
        server.port = port
        server.host = host
        setImmediate(() => { server.emit('listening'); if (cb) cb() })
      }
      server.close = (cb) => { server.closed = true; setImmediate(() => cb && cb()) }
      server.accept = (socket) => { server.connections.push(socket); onConnection(socket) }
      this.servers.push(server)
      return server
    },
  }
}

/** The exec double for a remote that SURVIVED the flap: the launch line is in
 *  the log, PID 999 is alive and LISTENing on 43129 (0xA8A9) the whole time. */
function survivingRemoteExec(cmd) {
  if (/nohup/.test(cmd)) return { code: 0, stdout: READY(), stderr: '' }
  if (/cat "\$HOME\//.test(cmd)) return { code: 0, stdout: READY(), stderr: '' }
  if (/\[ -d \/proc\/999 \]/.test(cmd)) return { code: 0, stdout: 'ALIVE\n', stderr: '' }
  if (/ls -l \/proc\/999\/fd/.test(cmd)) return { code: 0, stdout: '123456\n', stderr: '' }
  if (/\/proc\/net\/tcp/.test(cmd)) {
    return { code: 0, stdout: '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
      + '   0: 0100007F:A8A9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1\n', stderr: '' }
  }
  return { code: 0, stdout: '', stderr: '' }
}

/** A pool double with the onReady/onCloseHook single-slot props and a
 *  scripted connect(): fails `failTimes` times, then succeeds and fires
 *  onReady BEFORE resolving (the real pool's ordering). */
function flakyPool({ failTimes = 0, exec = survivingRemoteExec } = {}) {
  const state = { failTimes }
  const pool = {
    connectAttempts: 0,
    onReady: null,
    onCloseHook: null,
    client: new ScriptedClient(),
    set failTimes(v) { state.failTimes = v },
    get failTimes() { return state.failTimes },
    async connect() {
      pool.connectAttempts += 1
      if (pool.connectAttempts <= state.failTimes) throw new Error('Connection timed out')
      if (pool.onReady) pool.onReady(pool.client)
      return pool.client
    },
    async exec(cmd, opts) { return exec(cmd, opts) },
  }
  return pool
}

test('#204: a spontaneous connection loss self-heals — the attach dials the pool itself', async () => {
  const pool = flakyPool()
  const attach = new WebAttach({ net: fakeNet(), reconnectBaseDelayMs: 5 })
  await attach.open({ pool, machineId: 'm-1' })
  const firstClient = attach.client
  assert.ok(firstClient, 'open() attached the first client')
  assert.equal(attach.remotePort, 43129, 'the initial launch port')
  assert.equal(pool.connectAttempts, 1, 'exactly one dial so far (the open)')

  // The link flaps: the ssh client emits 'close', and the NEXT two dials fail
  // (link still down). NOTHING else touches the pool — under the old code the
  // recovery never ran here.
  pool.failTimes = pool.connectAttempts + 2

  // The link flaps: the ssh client emits 'close'. NOTHING else touches the
  // pool afterwards — under the old code the recovery never ran here.
  firstClient.emit('close')
  assert.equal(attach.connectionLost, true)
  assert.equal(attach.client, null, 'the dead handle is dropped')
  assert.equal(attach.active, true, 'the local listener stays bound (the URL must keep working)')

  // Give the loop time to fail twice (5ms, 10ms backoff) and then succeed.
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(pool.connectAttempts >= 3, `the attach drove its own reconnect — attempts: ${pool.connectAttempts}`)
  assert.equal(attach.client, pool.client, 'the fresh client is attached')
  assert.equal(attach.connectionLost, false, 'the tunnel is healed')
  assert.equal(attach.lastError, '')
  assert.equal(attach._reconnectTimer, null, 'the loop stopped after success')
  assert.equal(attach.active, true)
  await attach.close()
})

test('#204: the loop keeps retrying while the link is down, and close() stops it', async () => {
  const pool = flakyPool()
  const attach = new WebAttach({ net: fakeNet(), reconnectBaseDelayMs: 5 })
  await attach.open({ pool, machineId: 'm-1' })
  pool.failTimes = Number.POSITIVE_INFINITY
  attach.client.emit('close')

  await new Promise((r) => setTimeout(r, 60))
  const attemptsAfter60ms = pool.connectAttempts
  assert.ok(attemptsAfter60ms >= 2, `retries continue while the link is down — attempts: ${attemptsAfter60ms}`)

  await attach.close()
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(pool.connectAttempts, attemptsAfter60ms, 'close() stops the loop — no dial after teardown')
  assert.equal(attach._reconnectTimer, null)
})

test('#204: a mid-outage close() cancels a PENDING backoff timer, not just the flag', async () => {
  const pool = flakyPool()
  const attach = new WebAttach({ net: fakeNet(), reconnectBaseDelayMs: 80 })
  await attach.open({ pool, machineId: 'm-1' })
  pool.failTimes = Number.POSITIVE_INFINITY
  attach.client.emit('close')
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(pool.connectAttempts >= 1, 'the first (immediate) attempt ran')
  await attach.close()
  const at = pool.connectAttempts
  // The 80ms backoff timer must have been CLEARED, not merely ignored.
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(pool.connectAttempts, at, 'no further dial after close()')
})

test('#204: the backoff resets after a heal, so the NEXT flap recovers fast', async () => {
  const pool = flakyPool()
  const attach = new WebAttach({ net: fakeNet(), reconnectBaseDelayMs: 5 })
  await attach.open({ pool, machineId: 'm-1' })

  pool.failTimes = pool.connectAttempts + 1
  attach.client.emit('close')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(attach.connectionLost, false, 'healed once')
  assert.equal(attach._reconnectDelayMs, 0, 'the backoff resets on success')

  // A second flap: every dial from here on succeeds, so the very FIRST dial
  // of the new loop must re-attach — no stale timer/backoff may linger.
  attach.client.emit('close')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(attach.connectionLost, false, 'healed twice, promptly')
  await attach.close()
})
