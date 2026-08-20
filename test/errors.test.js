import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyError, friendlyMessage } from '../lib/errors.js'

test('auth failures get an actionable hint', () => {
  const c = classifyError(new Error('Permission denied (publickey,password).'))
  assert.equal(c.category, 'auth')
  assert.match(c.hint, /认证失败/)
})

test('host key changes are flagged as MITM risk', () => {
  const c = classifyError(new Error('host key for 1.2.3.4:22 CHANGED (stored abc, received def)'))
  assert.equal(c.category, 'hostkey')
  assert.match(c.hint, /remote-forget-key/)
})

test('network categories', () => {
  assert.equal(classifyError(new Error('getaddrinfo ENOTFOUND host')).category, 'network')
  assert.equal(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:22')).category, 'network')
  assert.equal(classifyError(new Error('connect ETIMEDOUT')).category, 'timeout')
})

test('credentials + sftp categories', () => {
  assert.equal(classifyError(new Error('no credentials: set a password or a privateKeyPath')).category, 'credentials')
  assert.equal(classifyError(new Error('cannot read private key "/x": ENOENT')).category, 'credentials')
  assert.equal(classifyError(new Error('sftp operation timed out')).category, 'sftp')
})

test('friendlyMessage keeps the raw message for unknown errors', () => {
  assert.equal(friendlyMessage(new Error('weird custom error')), 'weird custom error')
  const m = friendlyMessage(new Error('Permission denied (publickey).'))
  assert.match(m, /认证失败/)
  assert.match(m, /Permission denied/)
})
