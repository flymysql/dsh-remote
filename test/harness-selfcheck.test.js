// Self-check for the two new harnesses.
//
// These tests exist so a broken harness fails LOUDLY and early instead of
// silently turning 40 downstream tests into no-ops ("the fake server accepted
// nothing, so every route test passed because everything failed"). They also
// pin the harness's own contract: real ssh2 protocol, real SFTP, real exec.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeSsh } from './harness/fake-ssh.js'
import { createHost, machine } from './harness/plugin-host.js'
import { SshPool } from '../lib/pool.js'

const POOL_CONFIG = {
  host: '127.0.0.1', port: 22, username: 'root', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 3000, connectTimeoutMs: 5000,
  maxOutputChars: 100000, maxFileBytes: 1000000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

test('fake SSH: password auth, exec, platform detection and SFTP all work over a real ssh2 connection', async () => {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: { '/home/user/a.txt': 'hello' } })
  const pool = new SshPool({ ...POOL_CONFIG, port: srv.port, username: 'root', password: 'pw' })
  try {
    await pool.connect()
    const res = await pool.exec('echo hi')
    assert.equal(String(res.stdout).trim(), 'hi', 'exec must reach the fake shell')
    await pool.detect()
    assert.equal(pool.platform, 'posix', '`cmd /c ver` fails and `uname -s` says Linux → posix')

    const sftp = await pool.sftp()
    const entries = await sftp.readdir('/home/user')
    assert.deepEqual(entries.map((e) => e.filename).sort(), ['a.txt'])
    assert.equal((await sftp.readFile('/home/user/a.txt')).toString(), 'hello')
    await sftp.writeFile('/home/user/b.txt', Buffer.from('written'))
    assert.equal(srv.fs.readText('/home/user/b.txt'), 'written', 'the write must land in the fake fs')
    await sftp.mkdir('/home/user/sub')
    await sftp.rename('/home/user/b.txt', '/home/user/sub/c.txt')
    assert.equal(srv.fs.readText('/home/user/sub/c.txt'), 'written')
    await sftp.unlink('/home/user/sub/c.txt')
    assert.equal(srv.fs.has('/home/user/sub/c.txt'), false)
  } finally {
    pool.close()
    await srv.close()
  }
})

test('fake SSH: a wrong password is rejected (so auth branches are testable)', async () => {
  const srv = await startFakeSsh({ users: { root: { password: 'right' } } })
  const pool = new SshPool({ ...POOL_CONFIG, port: srv.port, username: 'root', password: 'wrong' })
  try {
    const err = await pool.connect().then(() => null, (e) => e)
    assert.ok(err, 'connecting with a wrong password must fail')
    assert.match(String(err.message), /authentication|All configured authentication methods failed/i)
    assert.ok(srv.authAttempts >= 1)
  } finally {
    pool.close()
    await srv.close()
  }
})

test('host harness: the plugin boots, registers every route and tool, and disposes cleanly', async () => {
  const host = await createHost()
  try {
    // 34 routes and 21 tools are the documented surface; a registration that
    // silently disappears (e.g. a throw halfway through apply) must fail here.
    assert.ok(host.routes.size >= 34, `expected >=34 routes, got ${host.routes.size}`)
    assert.ok(host.tools.size >= 21, `expected >=21 tools, got ${host.tools.size}`)
    assert.ok(host.commands.size >= 3, 'slash commands register too')
    const status = await host.call('/dsh-remote/status', { method: 'GET' })
    assert.equal(status.status, 200)
    assert.equal(status.rejected, null)
  } finally {
    await host.dispose()
  }
})

test('host harness: a seeded machine is visible, and /test-connect really connects to the fake server', async () => {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } } })
  const host = await createHost({
    machines: [machine({ host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw' })],
  })
  try {
    const list = await host.call('/dsh-remote/machines', { method: 'GET' })
    assert.equal(list.json.machines.length, 1)
    const rec = list.json.machines[0]

    // The probe the settings page sends after 编辑 (empty password) must succeed
    // against a reachable host — this is the case that used to say 缺少凭据.
    const probe = await host.call('/dsh-remote/test-connect', {
      body: { id: rec.id, host: '127.0.0.1', port: srv.port, username: 'root', password: '' },
    })
    assert.equal(probe.json.ok, true, `probe failed: ${probe.json.error}`)
    assert.equal(probe.json.usedSavedCredential, true)
    assert.equal(probe.json.platform, 'posix')
  } finally {
    await host.dispose()
    await srv.close()
  }
})
