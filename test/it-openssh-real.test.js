// REAL-MACHINE integration: the system-OpenSSH backend (`ssh` as the transport).
//
// `lib/openssh.js` was the least covered file in the repo (48% union lines) and for
// a structural reason: it drives the LOCAL `ssh` binary, so nothing short of a real
// host can prove it works. Everything it does differently from the native backend is
// exactly what enterprise machines need — `~/.ssh/config` as the single source,
// askpass for passwords/passphrases, GSSAPI/Kerberos, ProxyCommand, and the CLI's
// own host-key checking.
//
// Gated by IT_SSH_HOST (+ IT_SSH_PASSWORD or IT_SSH_KEY). Set IT_SSH_ALIAS and
// IT_SSH_GSSAPI=1 to exercise the Kerberos path (a host that only accepts GSSAPI).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SystemOpenSshPool } from '../lib/openssh.js'
import { createPool } from '../lib/pool.js'
import { realTarget, skipMessage, localSshAvailable, poolConfigFor, exists } from './harness/real-host.js'

const target = realTarget('IT_SSH')
const canRun = !!target && localSshAvailable() && (!!target.password || exists(target.privateKeyPath) || !!target.alias)
const why = !target
  ? skipMessage('IT_SSH')
  : !localSshAvailable()
    ? 'no `ssh` on PATH — the OpenSSH backend cannot run here'
    : 'set IT_SSH_PASSWORD, IT_SSH_KEY or IT_SSH_ALIAS'

/** Build a pool for the real target on the system-OpenSSH backend. */
function openSshPool(overrides = {}) {
  const config = poolConfigFor(target, { backend: 'openssh', ...overrides })
  // An alias is handed to `ssh` VERBATIM: host/user/port/key come from ~/.ssh/config.
  if (target.alias) {
    config.host = target.alias
    config.username = ''
    config.port = 22
    config.privateKeyPath = ''
  }
  return createPool(config, {})
}

test('the system-OpenSSH backend really connects, runs a command and lists a directory', { skip: canRun ? false : why }, async () => {
  const pool = openSshPool()
  try {
    assert.ok(pool instanceof SystemOpenSshPool, 'the openssh backend must be selected for backend:"openssh"')
    await pool.connect()
    const res = await pool.exec('echo it-openssh-ok')
    assert.match(String(res.stdout), /it-openssh-ok/, `exec must reach the real shell, got: ${JSON.stringify(res).slice(0, 200)}`)

    // `~` resolution goes through the same path /dsh-remote/home uses.
    const home = await pool.exec('echo ~')
    assert.ok(String(home.stdout).trim().length > 0, 'the shell must answer ~')

    const sftp = await pool.sftp()
    const entries = await sftp.readdir(String(home.stdout).trim())
    assert.ok(Array.isArray(entries), 'SFTP must list the home directory')

    await pool.detect()
    assert.ok(['posix', 'windows'].includes(pool.platform), `platform detection must conclude something, got ${pool.platform}`)
  } finally {
    pool.close()
  }
})

test('the openssh backend reports a wrong password as an auth failure instead of hanging', { skip: canRun && target.password ? false : 'needs IT_SSH_PASSWORD' }, async () => {
  const pool = openSshPool({ password: 'definitely-not-the-password' })
  try {
    const started = Date.now()
    const err = await pool.connect().then(() => null, (e) => e)
    assert.ok(err, 'a wrong password must fail')
    assert.match(String(err.message), /permission denied|authentication|denied|exit/i,
      `the failure must name authentication, got: ${err.message}`)
    assert.ok(Date.now() - started < 40000, 'and must fail in bounded time (no infinite askpass retry)')
  } finally {
    pool.close()
  }
})

test('the openssh backend survives a reconnect after close (no stale CLI state)', { skip: canRun ? false : why }, async () => {
  const pool = openSshPool()
  try {
    await pool.connect()
    assert.match(String((await pool.exec('echo one')).stdout), /one/)
    pool.close()
    // A fresh connect on the same pool must work: the CLI keeps no socket, so a
    // closed pool must not remember a dead client.
    await pool.connect()
    assert.match(String((await pool.exec('echo two')).stdout), /two/)
  } finally {
    pool.close()
  }
})

test('a ~/.ssh/config ALIAS drives host/user/port/key through the file alone', { skip: target && localSshAvailable() && target.alias ? false : 'needs IT_SSH_ALIAS (a Host alias that resolves to a reachable machine)' }, async () => {
  const pool = openSshPool()
  try {
    await pool.connect()
    const res = await pool.exec('echo alias-ok')
    assert.match(String(res.stdout), /alias-ok/)
  } finally {
    pool.close()
  }
})

test('GSSAPI/Kerberos-only host: the openssh backend is the only one that can reach it', { skip: target && target.gssapi ? false : 'needs IT_SSH_GSSAPI=1 plus an alias that only accepts Kerberos' }, async () => {
  // The point of this case: the native backend has no GSSAPI at all, so if this
  // connects, it connected BECAUSE the system `ssh` (with the user's kinit ticket)
  // did the authentication. Nothing else in the plugin can.
  const pool = openSshPool()
  try {
    await pool.connect()
    const res = await pool.exec('id -un')
    assert.ok(String(res.stdout).trim().length > 0, 'the authenticated user must be reported by the remote')
  } finally {
    pool.close()
  }
})
