// A reverse forward (`ssh -R` semantics) must consume the event ssh2 actually
// emits. ssh2 documents 'tcp connection' for forwarded-tcpip channels; a
// listener registered only for 'tcpip' leaves the remote port bound while every
// incoming connection hangs, because no one ever accepts the channel.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { Duplex } from 'node:stream'
import { ForwardManager } from '../lib/forwards.js'

class FakeClient extends EventEmitter {
  constructor() {
    super()
    this.bound = []
    this.unbound = []
  }
  forwardIn(addr, port, cb) {
    this.bound.push([addr, port])
    cb(null, port)
  }
  unforwardIn(addr, port, cb) {
    this.unbound.push([addr, port])
    cb(null)
  }
}

function connectionStream() {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, cb) { cb() },
  })
}

function fakeNet() {
  const connections = []
  return {
    connections,
    createServer() {
      throw new Error('local forwards are not under test')
    },
    connect(opts) {
      const socket = connectionStream()
      connections.push({ opts, socket })
      return socket
    },
  }
}

async function startedReverse() {
  const client = new FakeClient()
  const net = fakeNet()
  const mgr = new ForwardManager({ connect: async () => client }, { file: null, net, currentMachine: () => 'm-1' })
  mgr.attach(client, 'm-1')
  const def = mgr.define({
    direction: 'reverse',
    listenPort: 17890,
    targetHost: '127.0.0.1',
    targetPort: 7897,
    machineId: 'm-1',
  })
  const r = await mgr.start(def)
  assert.equal(r.ok, true, r.error)
  return { mgr, client, net, def }
}

function forwardConnection(client, net, eventName, { listenPort, targetHost, targetPort }) {
  const channel = connectionStream()
  channel.close = () => channel.destroy()
  const count = net.connections.length
  let accepted = false
  client.emit(
    eventName,
    { destIP: '127.0.0.1', destPort: listenPort, srcIP: '127.0.0.1', srcPort: 50000 },
    () => {
      accepted = true
      return channel
    },
    () => {
      throw new Error(`channel rejected (event ${eventName})`)
    },
  )
  assert.equal(accepted, true, `a forwarded connection must be accepted on '${eventName}'`)
  assert.equal(net.connections.length, count + 1)
  const { opts, socket } = net.connections.at(-1)
  assert.deepEqual(opts, { host: targetHost, port: targetPort })
  assert.equal(socket.destroyed, false)
  assert.equal(channel.destroyed, false)
  return { socket, channel }
}

test('reverse forward accepts a forwarded connection on "tcp connection"', async () => {
  const { client, net, def } = await startedReverse()
  assert.deepEqual(client.bound, [['127.0.0.1', 17890]])
  forwardConnection(client, net, 'tcp connection', def)
})

test('reverse forward still accepts the legacy "tcpip" event name', async () => {
  const { client, net, def } = await startedReverse()
  forwardConnection(client, net, 'tcpip', def)
})

test('detach stops listening on both event names', async () => {
  const { mgr, client } = await startedReverse()
  mgr.detach()
  assert.equal(client.listenerCount('tcp connection'), 0)
  assert.equal(client.listenerCount('tcpip'), 0)
})

test('stopping a native reverse forward closes only its established connections', async (t) => {
  const { mgr, client, net, def } = await startedReverse()
  t.after(() => mgr.detach())
  const otherDef = mgr.define({ direction: 'reverse', listenPort: 17891, targetPort: 7898 })
  assert.deepEqual(await mgr.start(otherDef), { ok: true, active: true })
  const first = forwardConnection(client, net, 'tcp connection', def)
  const second = forwardConnection(client, net, 'tcp connection', def)
  const other = forwardConnection(client, net, 'tcp connection', otherDef)

  mgr.stop(def.id, { forget: true })

  for (const { socket, channel } of [first, second]) {
    assert.equal(socket.destroyed, true)
    assert.equal(channel.destroyed, true)
  }
  assert.equal(other.socket.destroyed, false)
  assert.equal(other.channel.destroyed, false)
  assert.deepEqual(client.unbound, [['127.0.0.1', def.listenPort]])
  assert.deepEqual(mgr.list().map(({ id, active }) => [id, active]), [[def.id, false], [otherDef.id, true]])
})

test('closing the SSH channel closes its paired local socket', async () => {
  const { mgr, client, net, def } = await startedReverse()
  const { socket, channel } = forwardConnection(client, net, 'tcp connection', def)
  const closed = once(channel, 'close')
  channel.destroy()
  await closed
  assert.equal(socket.destroyed, true)
  assert.equal(mgr.list()[0].active, true)
  mgr.detach()
})

for (const [name, disconnect] of [
  ['detach', (mgr) => mgr.detach()],
  ['SSH client close', (_mgr, client) => client.emit('close')],
]) {
  test(`${name} closes native reverse connections when unforwardIn throws`, async () => {
    const { mgr, client, net, def } = await startedReverse()
    const { socket, channel } = forwardConnection(client, net, 'tcp connection', def)
    client.unforwardIn = () => { throw new Error('SSH client is closed') }

    disconnect(mgr, client)

    assert.equal(socket.destroyed, true)
    assert.equal(channel.destroyed, true)
    assert.equal(mgr.list()[0].active, false)
    assert.equal(mgr.list()[0].lastActive, true)
  })
}

// ── an edit that lands while the bind is still in flight ────────────────────
//
// The update route refuses bind changes only for REGISTERED forwards (a live
// tunnel must keep its old bind). While forwardIn is still pending the row is
// not active yet, so the same edit passes and update() mutates the definition
// under the bind. The entry must remember the port its attempt actually bound:
// dispatch and teardown read the definition, so they would otherwise follow
// the EDITED port while the remote keeps listening on the one it bound.

const tick = () => new Promise((r) => setTimeout(r, 0))

/** A FakeClient whose forwardIn callback is held back until completeBind(). */
function deferredReverseClient() {
  const client = new FakeClient()
  const pending = []
  client.forwardIn = (addr, port, cb) => {
    client.bound.push([addr, port])
    pending.push(cb)
  }
  client.completeBind = () => pending.shift()(null)
  return client
}

const BIND_PORT = 12000
const EDITED_PORT = 12001

/** A reverse forward that bound BIND_PORT and whose definition was then edited
 *  to EDITED_PORT while that bind was still in flight. */
async function startedReverseEditedMidBind() {
  const client = deferredReverseClient()
  const net = fakeNet()
  const mgr = new ForwardManager({ connect: async () => client }, { file: null, net, currentMachine: () => 'm-1' })
  mgr.attach(client, 'm-1')
  const def = mgr.define({
    direction: 'reverse',
    listenPort: BIND_PORT,
    targetHost: '127.0.0.1',
    targetPort: 4747,
    machineId: 'm-1',
  })
  const starting = mgr.start(def)
  await tick() // the attempt has called forwardIn; its callback is still held
  // Exactly the edit the route allows while the forward is not active yet.
  assert.equal(mgr.update(def.id, { listenPort: EDITED_PORT }).listenPort, EDITED_PORT)
  client.completeBind()
  assert.deepEqual(await starting, { ok: true, active: true })
  assert.deepEqual(client.bound, [['127.0.0.1', BIND_PORT]], 'the remote was asked for the ORIGINAL port')
  return { mgr, client, net, def }
}

test('stopping a reverse forward edited mid-bind unforwards the port it actually bound', async () => {
  const { mgr, client, def } = await startedReverseEditedMidBind()

  mgr.stop(def.id, { forget: true })

  // The remote listener sits on BIND_PORT, so that is the port Stop must
  // release. Unforwarding the edited port would leave the real listener bound
  // until the SSH connection itself dies.
  assert.deepEqual(client.unbound, [['127.0.0.1', BIND_PORT]])
  assert.equal(mgr.list().find((f) => f.id === def.id).active, false)
})

test('a reverse forward edited mid-bind keeps accepting connections on its bound port', async (t) => {
  const { mgr, client, net, def } = await startedReverseEditedMidBind()
  t.after(() => mgr.detach())

  forwardConnection(client, net, 'tcp connection', {
    listenPort: BIND_PORT, targetHost: '127.0.0.1', targetPort: 4747,
  })

  const entry = mgr.servers.get(def.id)
  assert.ok(entry && entry.kind === 'reverse', 'the running entry must still be registered')
  assert.equal(entry.connections.size, 1, 'the accepted pair must be tracked on the entry')
})
