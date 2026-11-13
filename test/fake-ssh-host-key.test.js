import { test } from 'node:test'
import assert from 'node:assert/strict'
import ssh2 from 'ssh2'
import net from 'node:net'
import { once } from 'node:events'
import { createValidHostKey, startFakeSsh } from './harness/fake-ssh.js'

const { Server, utils } = ssh2

test('fake SSH retries an unparseable generated host key before constructing Server', () => {
  const valid = createValidHostKey()
  const generated = ['not an OpenSSH private key', valid]
  let calls = 0
  const selected = createValidHostKey(() => generated[calls++])
  assert.equal(calls, 2, 'the first malformed key is rejected and generation retried')
  assert.equal(selected, valid)
  const server = new Server({ hostKeys: [selected] }, () => {})
  server.close()
})

test('fake SSH teardown closes a TCP client that never finishes its SSH handshake', { timeout: 5000 }, async () => {
  const fixture = await startFakeSsh()
  const socket = net.connect(fixture.port, '127.0.0.1')
  socket.on('error', () => {})
  try {
    await once(socket, 'connect')
    const closed = new Promise((resolve) => socket.once('close', resolve))
    await fixture.close()
    await closed
    assert.equal(socket.destroyed, true)
  } finally { socket.destroy() }
})

test('fake SSH never caches an unparseable key after the bounded retry budget', () => {
  let calls = 0
  assert.throws(
    () => createValidHostKey(() => { calls++; return 'still not a key' }),
    /after 32 attempts/,
  )
  assert.equal(calls, 32)
})
