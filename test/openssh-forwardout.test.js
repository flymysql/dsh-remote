// OpenSSH backend: `forwardOut` must hand the channel over while the tunnel is
// still open.
//
// `ssh -W` IS the tunnel — it stays alive for as long as the channel is usable
// and only exits when the peer or the caller closes it. Resolving the callback
// from the child's 'close' event therefore never happens for a healthy tunnel:
// ForwardManager/WebAttach never receive the channel, never write the first
// byte, the peer times out (a DSH web attach answers 408 after ~76 s), and one
// `ssh -W` process is leaked per stalled connection. The native ssh2 backend
// reports "channel open" instead, which is why only `backend: openssh` hung.
//
// The fake server really dials the requested target, so the first test is a
// true end-to-end proof: real `ssh -W` against the in-process sshd, bytes to a
// local echo server and back. The second covers the failure path (a child that
// exits non-zero must surface as a channel error, not a silent close).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { OpenSshConnection, SystemOpenSshPool, sshBinaryAvailable } from '../lib/openssh.js'
import { forwardOutChannel } from '../lib/pool.js'
import { startFakeSsh } from './harness/fake-ssh.js'

const canRun = sshBinaryAvailable('ssh')

/** Race `promise` against a deadline without leaking the original rejection. */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

function baseConfig(port) {
  return {
    host: '127.0.0.1',
    port,
    username: 'root',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    hostKeyMode: 'off',
    connectTimeoutMs: 10000,
    commandTimeoutMs: 5000,
    maxOutputChars: 10000,
    backend: 'openssh',
  }
}

test('openssh backend: forwardOut resolves while `ssh -W` is still alive, and bytes flow', {
  skip: canRun ? false : 'no `ssh` on PATH — the openssh backend cannot run here',
  timeout: 30000,
}, async (t) => {
  const srv = await startFakeSsh({ silent: true })
  const khDir = mkdtempSync(path.join(tmpdir(), 'dsh-forwardout-'))
  const pool = new SystemOpenSshPool(baseConfig(srv.port), { knownHostsFile: path.join(khDir, 'known_hosts') })
  const echo = net.createServer((socket) => { socket.on('data', (d) => socket.write(d)) })
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const targetPort = echo.address().port

  t.after(async () => {
    try { pool.close() } catch { /* already closed */ }
    await new Promise((resolve) => echo.close(resolve))
    await srv.close()
    rmSync(khDir, { recursive: true, force: true })
  })

  const client = await pool.connect()
  const started = Date.now()
  // The deadline is the regression: before the fix this promise never settled
  // while the tunnel stayed healthy, and the peer was the one that timed out.
  const channel = await withTimeout(
    forwardOutChannel(client, { dstHost: '127.0.0.1', dstPort: targetPort }),
    3000,
    'forwardOut never resolved: the caller never received the channel (the ssh -W process is still alive)',
  )
  assert.ok(Date.now() - started < 3000, 'the channel must be handed over without waiting for ssh -W to exit')

  const echoed = await withTimeout(new Promise((resolve, reject) => {
    let buf = ''
    channel.on('data', (d) => {
      buf += d
      if (buf.length >= 4) resolve(buf)
    })
    channel.once('error', reject)
    channel.write('ping')
  }), 3000, 'no bytes came back through the tunnel')
  assert.equal(echoed.slice(0, 4), 'ping')

  channel.close()
})

test('openssh backend: a non-zero `ssh -W` exit surfaces on the channel as an error', {
  skip: process.platform === 'win32' ? 'needs a POSIX executable as the fake ssh binary' : false,
  timeout: 15000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-forwardout-fail-'))
  const bin = path.join(dir, 'ssh-fail')
  writeFileSync(bin, '#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 255\n')
  chmodSync(bin, 0o755)
  const conn = new OpenSshConnection(
    { _argConfig: () => ({ host: 'fake.example', port: 22, username: 'u' }), destination: () => 'fake.example' },
    { sshBinary: bin, secret: '' },
  )
  try {
    // Handing the channel over early must not swallow the failure: the caller
    // still learns WHY the tunnel died (exit status + stderr), instead of
    // waiting for a 'close' that never carries a reason.
    const channel = await withTimeout(
      forwardOutChannel(conn, { dstHost: 'fake.example', dstPort: 22 }),
      2000,
      'forwardOut did not resolve for a failing child either',
    )
    const err = await withTimeout(new Promise((resolve) => channel.once('error', resolve)), 3000, 'no channel error after exit 255')
    assert.match(err.message, /exit 255/)
    assert.match(err.message, /Permission denied/)
  } finally {
    conn.close()
    rmSync(dir, { recursive: true, force: true })
  }
})