// SystemOpenSshPool.close()/invalidate() must reap every `ssh` child they own.
//
// The leak (audit3, measured in-process with a fake `ssh` binary): a command
// child spawned by `_runSsh` with `timeoutMs: 0` — the promoted-background-job
// shape, which deliberately arms NO kill timer (issue #95) — survived
// pool.close() untouched, because close() only killed the SFTP child and the
// connection's tunnel children. rw_disconnect therefore reported success while
// the remote command kept running. The same hole held the SFTP child while its
// handshake was still pending: `this._sftpChild` was assigned only AFTER the
// handshake completed, so `_dropSftpSession()` killed nothing and the child
// lived until its own commandTimeoutMs timer fired.
//
// The fake binary announces its own pid and then holds the line, so "the
// process is gone" is asserted against the OS, not against bookkeeping — every
// failure below was a real leaked process on the unfixed code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { SystemOpenSshPool } from '../lib/openssh.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Pool config pointing at a fake `ssh` binary — no host is ever contacted. */
function baseConfig(over = {}) {
  return {
    host: 'fake.example',
    port: 22,
    username: 'u',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    hostKeyMode: 'off',
    connectTimeoutMs: 5000,
    commandTimeoutMs: 30000,
    maxOutputChars: 10000,
    backend: 'openssh',
    ...over,
  }
}

/**
 * A fake `ssh` binary that writes its own pid to `pidFile` and then holds the
 * line: as a command child it simply runs, and as an `ssh -s sftp` child it
 * never speaks the handshake. `exec` replaces the shell image, so the pid it
 * announced is the pid the pool must reap — a SIGTERM reaches the sleep itself
 * and no orphaned grandchild is left behind.
 */
function slowFakeSsh(dir, pidFile) {
  const bin = path.join(dir, 'ssh-slow')
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$$" > '${pidFile}'\nexec sleep 10\n`)
  chmodSync(bin, 0o755)
  return bin
}

/** Wait until the fake binary has announced the pid the pool must reap. */
async function waitForPid(pidFile, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch { /* not announced yet */ }
    if (Date.now() > deadline) throw new Error(`the fake ssh binary never announced its pid within ${ms}ms`)
    await sleep(25)
  }
}

/** Wait until `pid` is really gone from the OS (signal 0 stops succeeding). */
async function waitForExit(pid, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    try { process.kill(pid, 0) } catch { return true }
    if (Date.now() > deadline) return false
    await sleep(25)
  }
}

/** Best-effort cleanup: a FAILED run must not leave the leaked process behind. */
function killIfAlive(pid) {
  if (!pid) return
  try { process.kill(pid, 'SIGKILL') } catch { /* already reaped */ }
}

// ── the command children ────────────────────────────────────────────────────

test('close() reaps a no-deadline command child (the promoted-job shape)', {
  skip: process.platform === 'win32' ? 'needs a POSIX executable as the fake ssh binary' : false,
  timeout: 20000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-close-reap-'))
  const pidFile = path.join(dir, 'pid')
  let pid = 0
  try {
    const pool = new SystemOpenSshPool(baseConfig({ sshBinary: slowFakeSsh(dir, pidFile) }))
    // timeoutMs 0 arms NO kill timer (issue #95): nothing but close() can end
    // this child — the exact in-flight job rw_disconnect abandons.
    const pending = pool._runSsh(['sleep'], { timeoutMs: 0 })
    pending.catch(() => { /* settlement is expected via the reap, not a failure */ })
    pid = await waitForPid(pidFile, 5000)
    pool.close()
    const gone = await waitForExit(pid, 1500)
    assert.ok(gone,
      `the no-deadline ssh child (pid ${pid}) outlived close() by 1.5s — a promoted background job is leaked`)
    // The abandoned call settles through the kill instead of hanging on a
    // process that no longer exists.
    const res = await pending
    assert.equal(res.code, null)
    assert.ok(res.signal === 'SIGTERM' || res.signal === 'SIGKILL',
      `the child must die by a signal, got ${res.signal}`)
  } finally {
    killIfAlive(pid)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalidate() reaps no-deadline command children too', {
  skip: process.platform === 'win32' ? 'needs a POSIX executable as the fake ssh binary' : false,
  timeout: 20000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-invalidate-reap-'))
  const pidFile = path.join(dir, 'pid')
  let pid = 0
  try {
    const pool = new SystemOpenSshPool(baseConfig({ sshBinary: slowFakeSsh(dir, pidFile) }))
    const pending = pool._runSsh(['sleep'], { timeoutMs: 0 })
    pending.catch(() => { /* settlement is expected via the reap, not a failure */ })
    pid = await waitForPid(pidFile, 5000)
    pool.invalidate()
    const gone = await waitForExit(pid, 1500)
    assert.ok(gone,
      `the no-deadline ssh child (pid ${pid}) outlived invalidate() by 1.5s — a target switch leaks the old commands`)
    const res = await pending
    assert.ok(res.signal === 'SIGTERM' || res.signal === 'SIGKILL',
      `the child must die by a signal, got ${res.signal}`)
  } finally {
    killIfAlive(pid)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── the SFTP child while its handshake is pending ────────────────────────────

test('close() reaps the SFTP child while its handshake is still pending', {
  skip: process.platform === 'win32' ? 'needs a POSIX executable as the fake ssh binary' : false,
  timeout: 20000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sftp-reap-'))
  const pidFile = path.join(dir, 'pid')
  let pid = 0
  try {
    // Short on purpose: the handshake deadline is the ONLY thing that could end
    // an unreaped child on the unfixed code, so it must sit well past the poll
    // window — and it keeps the suite from hanging no matter what.
    const pool = new SystemOpenSshPool(baseConfig({
      sshBinary: slowFakeSsh(dir, pidFile),
      commandTimeoutMs: 3000,
    }))
    const session = pool.sftp()
    session.catch(() => { /* close() below rejects the pending handshake */ })
    pid = await waitForPid(pidFile, 5000)
    pool.close()
    const gone = await waitForExit(pid, 1500)
    assert.ok(gone,
      `the handshaking sftp child (pid ${pid}) outlived close() — before the fix nothing killed a pending session`)
  } finally {
    killIfAlive(pid)
    rmSync(dir, { recursive: true, force: true })
  }
})
