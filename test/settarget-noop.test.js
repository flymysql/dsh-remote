// Regression: SshPool.setTarget with an UNCHANGED target must be a no-op.
//
// The workspace picker posts /dsh-remote/current before every /ls; that route
// funnels into applyActiveMachine → pool.setTarget. The old unconditional
// close() made every autocomplete keystroke kill the live SSH connection and
// re-run platform detection (the "slow remote path autocomplete" bug).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SshPool } from '../lib/pool.js'

const baseConfig = () => ({
  host: 'example.test', port: 22, username: 'dev', password: 'pw',
  privateKeyPath: '', passphrase: '', workspace: '/ws', shell: '',
  useAgent: false, keyboardInteractive: false, hostKeyMode: 'off',
  connectTimeoutMs: 500, commandTimeoutMs: 500,
})

function warmPool() {
  const pool = new SshPool(baseConfig(), { knownHostsFile: () => '' })
  const stats = { ended: 0 }
  // Simulate the state between keystrokes: connection live, platform detected.
  pool.client = { end() { stats.ended++ }, destroy() { stats.ended++ } }
  pool.platform = 'posix'
  pool.shellMode = 'native'
  pool.gitBashPath = ''
  return { pool, stats }
}

test('setTarget with the identical target keeps the live connection + platform cache', () => {
  const { pool, stats } = warmPool()
  const ret = pool.setTarget(baseConfig())
  assert.equal(ret, pool, 'setTarget must return the pool')
  assert.equal(stats.ended, 0, 'an identical target must NOT close the connection')
  assert.ok(pool.client, 'the client must stay cached')
  assert.equal(pool.platform, 'posix', 'the platform-detection cache must survive')
})

test('setTarget with a changed host DOES close + re-detect', () => {
  const { pool, stats } = warmPool()
  pool.setTarget({ ...baseConfig(), host: 'other.test' })
  assert.equal(stats.ended, 1, 'a changed target must close the old connection')
  assert.equal(pool.client, null)
  assert.equal(pool.platform, 'unknown')
  assert.equal(pool.config.host, 'other.test')
})

test('setTarget with a changed password closes (credential change ⇒ reconnect)', () => {
  const { pool, stats } = warmPool()
  pool.setTarget({ ...baseConfig(), password: 'newpw' })
  assert.equal(stats.ended, 1)
  assert.equal(pool.client, null)
  assert.equal(pool.config.password, 'newpw')
})

test('setTarget ignores unspecified fields (undefined ≠ change)', () => {
  const { pool, stats } = warmPool()
  // Partial call with equal values (what rw_connect / /connect send).
  pool.setTarget({ host: 'example.test', port: 22, username: 'dev', workspace: '/ws' })
  assert.equal(stats.ended, 0, 'a partial call with equal values must not close')
  pool.setTarget({ host: undefined, port: undefined, password: undefined })
  assert.equal(stats.ended, 0, 'an all-undefined call must not close')
  assert.equal(pool.config.password, 'pw', 'unspecified fields must stay untouched')
})
