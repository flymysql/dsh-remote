import { test } from 'node:test'
import assert from 'node:assert/strict'
import ssh2 from 'ssh2'
import { createValidHostKey } from './harness/fake-ssh.js'

const { Server, utils } = ssh2

test('fake SSH retries an unparseable generated host key before constructing Server', () => {
  const valid = utils.generateKeyPairSync('ed25519').private
  const generated = ['not an OpenSSH private key', valid]
  let calls = 0
  const selected = createValidHostKey(() => generated[calls++])
  assert.equal(calls, 2, 'the first malformed key is rejected and generation retried')
  assert.equal(selected, valid)
  const server = new Server({ hostKeys: [selected] }, () => {})
  server.close()
})

test('fake SSH never caches an unparseable key after the bounded retry budget', () => {
  let calls = 0
  assert.throws(
    () => createValidHostKey(() => { calls++; return 'still not a key' }),
    /after 32 attempts/,
  )
  assert.equal(calls, 32)
})
