// A reverse forward (`ssh -R` semantics) must consume the event ssh2 actually
// emits. ssh2 documents 'tcp connection' for forwarded-tcpip channels; a
// listener registered only for 'tcpip' leaves the remote port bound while every
// incoming connection hangs, because no one ever accepts the channel.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ForwardManager } from '../lib/forwards.js'

class FakeClient extends EventEmitter {
  constructor() {
    super()
    this.bound = []
  }
  forwardIn(addr, port, cb) {
    this.bound.push([addr, port])
    cb(null, port)
  }
  unforwardIn() {}
}

function channel() {
  const ch = new EventEmitter()
  ch.pipe = () => ch
  ch.close = () => {}
  return ch
}

function fakeNet() {
  const connections = []
  return {
    connections,
    createServer() {
      throw new Error('local forwards are not under test')
    },
    connect(opts) {
      connections.push(opts)
      const s = new EventEmitter()
      s.pipe = () => s
      s.destroy = () => {}
      return s
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
  return { mgr, client, net }
}

function forwardConnection(client, net, eventName) {
  let accepted = false
  client.emit(
    eventName,
    { destIP: '127.0.0.1', destPort: 17890, srcIP: '127.0.0.1', srcPort: 50000 },
    () => {
      accepted = true
      return channel()
    },
    () => {
      throw new Error(`channel rejected (event ${eventName})`)
    },
  )
  assert.equal(accepted, true, `a forwarded connection must be accepted on '${eventName}'`)
  assert.deepEqual(net.connections, [{ host: '127.0.0.1', port: 7897 }])
}

test('reverse forward accepts a forwarded connection on "tcp connection"', async () => {
  const { client, net } = await startedReverse()
  assert.deepEqual(client.bound, [['127.0.0.1', 17890]])
  forwardConnection(client, net, 'tcp connection')
})

test('reverse forward still accepts the legacy "tcpip" event name', async () => {
  const { client, net } = await startedReverse()
  forwardConnection(client, net, 'tcpip')
})

test('detach stops listening on both event names', async () => {
  const { mgr, client } = await startedReverse()
  mgr.detach()
  assert.equal(client.listenerCount('tcp connection'), 0)
  assert.equal(client.listenerCount('tcpip'), 0)
})
