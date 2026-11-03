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
  // Windows returns ECONNRESET where POSIX returns ECONNREFUSED — both are the
  // same user action, so both must classify as network with a real hint.
  const reset = classifyError(new Error('read ECONNRESET'))
  assert.equal(reset.category, 'network')
  assert.match(reset.hint, /重置/)
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

test('friendlyMessage is idempotent (pool classifies, callers re-classify)', () => {
  const once = friendlyMessage(new Error('connect ECONNREFUSED 10.0.0.1:22'), { host: '10.0.0.1', port: 22 })
  assert.match(once, /^连接被拒绝/)
  const twice = friendlyMessage(new Error(once), { host: '10.0.0.1', port: 22 })
  assert.equal(twice, once, 'a classified message must pass through unchanged, not grow a second shell')
})

test('every classifyError hint starts with a known prefix (the idempotence table stays honest)', () => {
  // One representative error per branch. The prefix list here is DELIBERATELY
  // a second copy (not imported): if a new hint lands without its prefix being
  // registered in BOTH places, this fails before the double-wrap bug ships.
  const battery = [
    'host key CHANGED (stored a, received b)',
    'Permission denied (publickey)',
    'no SSH agent available',
    'no credentials: set a password',
    'getaddrinfo ENOTFOUND x',
    'Connection lost before handshake',
    'connect ECONNREFUSED 1.2.3.4:22',
    'read ECONNRESET',
    'sftp operation timed out',
    'ETIMEDOUT',
    'cannot read private key "/x"',
    'no passphrase given',
  ]
  const PREFIXES = [
    '主机指纹校验失败', '认证失败', 'SSH agent 不可用', '缺少凭据', '主机不可达',
    'SSH 握手未完成', '连接被拒绝', '连接被重置', 'SFTP 操作失败', '连接/操作超时',
    '无法读取私钥文件', '私钥解析失败',
  ]
  for (const raw of battery) {
    const { category, hint } = classifyError(new Error(raw))
    assert.notEqual(category, 'other', `battery entry must exercise a real branch: ${raw}`)
    assert.ok(PREFIXES.some((p) => hint.startsWith(p)), `hint for "${raw}" starts with an unregistered prefix: ${hint.slice(0, 20)}…`)
  }
})
