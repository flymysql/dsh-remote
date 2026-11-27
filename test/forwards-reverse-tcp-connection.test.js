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
