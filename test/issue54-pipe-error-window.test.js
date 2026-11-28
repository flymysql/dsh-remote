// Issue #54 (continued) — the forwardOut ROUND-TRIP window is as fatal as the
// synchronous throw, and the #54 guard did not cover it.
//
// `WebAttach._pipe` (lib/web-attach.js) and ForwardManager's local-forward
// connection handler (lib/forwards.js) both accept a socket and used to wire
// its 'error'/'close' handling only INSIDE the forwardOut callback. A LIVE
// forwardOut answers on a LATER turn — a real round-trip to the remote sshd —
// so a client that reset inside that window (browser tab closed mid-request,
// TCP RST) emitted 'error' on a socket with NO listener, which Node raises
// from TCP.onconnection as an uncaught exception and the desktop Host treats
// as fatal. Same destination as the pinned #54 stack, reached from a
// connection that was perfectly healthy:
//
//   dsh: fatal uncaught exception: Error: read ECONNRESET
//       at WebAttach._pipe (lib/web-attach.js)
//       at Server.<anonymous> (lib/web-attach.js)
//       at TCP.onconnection (node:net)
//
// The fix line this continues — the try/catch around `forwardOut` for ssh2's
// synchronous 'Not connected' throw — is pinned by
// test/issue54-stale-client.test.js. This file pins the missing half: the
// socket must be wired the moment it is ACCEPTED, before forwardOut is called,
// the kill must be idempotent so the late channel wiring cannot
// double-register or resurrect a dead pair, and a channel that answers AFTER
// the reset must be closed rather than piped into a destroyed socket. The
// uncaught-exception assertion follows the transport-reliability line of
// #118/#121/#122 (test/issue118-openssh-stdin-epipe.test.js): the reset is
// delivered on a later turn from a timer context — where a real RST lands and
// a missing listener is an UNCAUGHT exception, not a local throw — and the
// process-level hook is what proves nothing escaped. Everything is in-memory
// doubles: no port is bound and no sshd is reached.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { WebAttach } from '../lib/web-attach.js'
import { ForwardManager } from '../lib/forwards.js'

/** Collect every 'uncaughtException' that fires while the trap is armed. */
function trapUncaught() {
  const seen = []
  const onUncaught = (err) => seen.push(err)
  process.on('uncaughtException', onUncaught)
  return {
    seen,
    stop() { process.removeListener('uncaughtException', onUncaught) },
  }
}

/**
 * A client whose forwardOut DEFERS its answer: the callback is recorded and
 * never called, so the SSH round-trip window stays open until the test answers
 * it — exactly the window a client can reset inside.
 */
class DeferringClient extends EventEmitter {
  constructor() {
    super()
    this.pending = []
  }

  forwardOut(_srcHost, _srcPort, _dstHost, _dstPort, cb) {
    this.pending.push(cb)
  }

  /** Deliver the oldest recorded answer, as the remote sshd eventually would. */
  answer(err, channel) {
    const cb = this.pending.shift()
    if (cb) cb(err, channel)
  }
}

/** A channel double: close() is observable, so a leak is assertable. */
function fakeChannel() {
  const ch = new EventEmitter()
  ch.closed = false
  ch.close = () => { ch.closed = true }
  ch.pipe = () => ch
  return ch
}

/** A socket double for the client side of the local listener. */
function fakeSocket() {
  const s = new EventEmitter()
  s.destroyed = false
  s.destroy = () => { s.destroyed = true }
  s.pipe = () => s
  return s
}

/** A net.Server double whose connection handler can be driven by the test. */
function fakeNet() {
  return {
    servers: [],
    createServer(onConnection) {
      const server = new EventEmitter()
      server.connections = []
      // Replay what the OS would do: the listen callback fires once bound, and
      // the connection handler is called with each incoming socket.
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

/** A pool double whose connect() hands back a scripted client. */
function poolWith(client) {
  return { client, async connect() { return this.client } }
}

/** One full event-loop turn: enough for the scripted emission to have run. */
const turn = () => new Promise((r) => setImmediate(r))

/** Abruptly reset `socket`: destroyed, then the RST lands on a later turn. */
function abruptReset(socket) {
  socket.destroy()
  setImmediate(() => {
    socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    socket.emit('close')
  })
}

// ── WebAttach._pipe ──────────────────────────────────────────────────────────

test('a client reset inside the forwardOut window is cleanup, never an uncaught exception', async () => {
  const uncaught = trapUncaught()
  try {
    const client = new DeferringClient()
    const attach = new WebAttach({ net: fakeNet(), trackPool: false })
    await attach.open({
      pool: poolWith(client), machineId: 'm-1',
      existingUrl: 'http://127.0.0.1:42080/?token=preset',
    })
    const socket = fakeSocket()
    attach.server.accept(socket)
    assert.equal(client.pending.length, 1, 'the SSH round-trip is in flight')

    // Before the fix the socket had no listener until that round-trip
    // answered, so the RST below was the host-killing uncaught exception.
    abruptReset(socket)
    await turn()
    await turn()

    assert.deepEqual(uncaught.seen, [], 'a client reset must be cleanup, never an uncaught exception')
    assert.equal(socket.destroyed, true, 'the reset socket is torn down')
    assert.equal(attach.sockets.has(socket), false, 'a dead pair must not be tracked any more')

    // The round-trip ANSWERS after the reset: the fresh channel must be
    // closed, never piped into a destroyed socket — one leaked remote channel
    // per mid-window reset otherwise.
    const channel = fakeChannel()
    client.answer(null, channel)
    await turn()
    assert.equal(channel.closed, true, 'a late channel for a dead socket must not be leaked')
    assert.equal(attach.sockets.has(socket), false)
  } finally {
    uncaught.stop()
  }
})

test('the socket is wired at accept time, and the late answer does not double-register', async () => {
  const client = new DeferringClient()
  const attach = new WebAttach({ net: fakeNet(), trackPool: false })
  await attach.open({
    pool: poolWith(client), machineId: 'm-1',
    existingUrl: 'http://127.0.0.1:42080/?token=preset',
  })
  const socket = fakeSocket()
  attach.server.accept(socket)

  // Tracked and wired BEFORE forwardOut is called: this is what lets close()
  // destroy a socket still inside the round-trip window, and what makes a
  // mid-window reset a reportable event instead of an uncaught one.
  assert.equal(attach.sockets.has(socket), true, 'an accepted socket is tracked while its round-trip is pending')
  assert.equal(socket.listenerCount('error'), 1, 'the socket is wired when it is accepted')
  assert.equal(socket.listenerCount('close'), 1)

  const channel = fakeChannel()
  client.answer(null, channel)
  await turn()

  assert.equal(attach.sockets.has(socket), true, 'a live pair stays tracked')
  assert.equal(socket.listenerCount('error'), 1, 'the late wiring must not stack a second listener')
  assert.equal(socket.listenerCount('close'), 1)
  assert.equal(channel.listenerCount('error'), 1)
  assert.equal(channel.listenerCount('close'), 1)
  assert.equal(channel.closed, false, 'a healthy pair is left alone')

  // The kill is idempotent: an error followed by 'close' tears the pair down
  // without either event resurrecting it.
  channel.emit('error', new Error('channel died'))
  channel.emit('close')
  assert.equal(socket.destroyed, true)
  assert.equal(channel.closed, true)
  assert.equal(attach.sockets.has(socket), false)
})

// ── ForwardManager, user-defined local forward ──────────────────────────────

/** Start one local forward on the double net; returns its listener. */
async function startLocalForward(client) {
  const netDouble = fakeNet()
  const mgr = new ForwardManager({ connect: async () => client }, { net: netDouble })
  const def = mgr.define({ direction: 'local', listenPort: 7002, targetHost: '127.0.0.1', targetPort: 9999 })
  const res = await mgr.start(def)
  assert.equal(res.ok, true)
  return netDouble.servers[netDouble.servers.length - 1]
}

test('a local forward survives a client reset inside the forwardOut window', async () => {
  const uncaught = trapUncaught()
  try {
    const client = new DeferringClient()
    const server = await startLocalForward(client)
    const socket = fakeSocket()
    server.accept(socket)
    assert.equal(client.pending.length, 1, 'the SSH round-trip is in flight')

    abruptReset(socket)
    await turn()
    await turn()

    assert.deepEqual(uncaught.seen, [], 'a client reset must be cleanup, never an uncaught exception')
    assert.equal(socket.destroyed, true, 'the reset socket is torn down')

    const channel = fakeChannel()
    client.answer(null, channel)
    await turn()
    assert.equal(channel.closed, true, 'a late channel for a dead socket must not be leaked')
  } finally {
    uncaught.stop()
  }
})

test('the local forward wires its socket at accept time without double-registration', async () => {
  const client = new DeferringClient()
  const server = await startLocalForward(client)
  const socket = fakeSocket()
  server.accept(socket)
  assert.equal(socket.listenerCount('error'), 1, 'the socket is wired when it is accepted')
  assert.equal(socket.listenerCount('close'), 1)

  const channel = fakeChannel()
  client.answer(null, channel)
  await turn()

  assert.equal(socket.listenerCount('error'), 1, 'the late wiring must not stack a second listener')
  assert.equal(socket.listenerCount('close'), 1)
  assert.equal(channel.listenerCount('error'), 1)
  assert.equal(channel.listenerCount('close'), 1)

  channel.emit('error', new Error('channel died'))
  assert.equal(socket.destroyed, true)
  assert.equal(channel.closed, true)
})
