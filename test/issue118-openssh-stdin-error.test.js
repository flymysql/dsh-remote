// Issue #118 — a dead `ssh -s sftp` child reports stdin EPIPE asynchronously.
// The negative control is built into the first assertion: without a stdin
// 'error' listener, EventEmitter throws right here; with the fix, the child is
// killed, the cached session is dropped, and a fresh handshake succeeds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { SystemOpenSshPool, sshBinaryAvailable } from '../lib/openssh.js'
import { startFakeSsh } from './harness/fake-ssh.js'

const canRun = sshBinaryAvailable('ssh')

test('#118: stdin error kills the old child, drops only its session, and reconnects', {
  skip: canRun ? false : 'no `ssh` on PATH — the openssh backend cannot run here',
}, async (t) => {
  const srv = await startFakeSsh({
    users: {},
    silent: true,
    fs: { '/home/user/a.txt': 'hello' },
  })
  const khDir = mkdtempSync(path.join(tmpdir(), 'dsh-issue118-'))
  const pool = new SystemOpenSshPool({
    host: '127.0.0.1',
    port: srv.port,
    username: 'root',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    hostKeyMode: 'off',
    connectTimeoutMs: 10000,
    commandTimeoutMs: 5000,
    maxOutputChars: 10000,
    backend: 'openssh',
  }, { knownHostsFile: path.join(khDir, 'known_hosts') })
  t.after(async () => {
    pool.close()
    await srv.close()
    rmSync(khDir, { recursive: true, force: true })
  })

  const first = await pool.sftp()
  const firstChild = pool._sftpChild
  assert.ok(firstChild, 'the ready session owns its ssh child')

  const closed = once(firstChild, 'close')
  const epipe = Object.assign(new Error('simulated closed SSH stdin'), { code: 'EPIPE' })
  // NEGATIVE CONTROL: the unpatched code has no listener and throws here.
  assert.doesNotThrow(() => firstChild.stdin.emit('error', epipe))
  await closed

  assert.equal(pool._sftpSession, null, 'close/drop clears the cached surface')
  assert.equal(pool._sftpChild, null, 'close/drop clears the cached child')
  await assert.rejects(() => first.stat('/home/user/a.txt'), /sftp channel closed/)

  const second = await pool.sftp()
  const secondChild = pool._sftpChild
  assert.ok(secondChild, 'the next call performs a fresh handshake')
  assert.notStrictEqual(secondChild, firstChild)

  // A stale event from the old child must not evict the replacement session.
  firstChild.emit('close', 0)
  assert.strictEqual(pool._sftpChild, secondChild)
  assert.strictEqual(await pool.sftp(), second)
  assert.equal((await second.stat('/home/user/a.txt')).size, 5)
})
