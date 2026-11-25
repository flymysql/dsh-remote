// Issue #211 — high-RTT links paid a 6x per-command penalty from two stacked
// defects (reporter's measurements on a 72ms WireGuard link: `echo ok` 856ms
// → 146ms after both fixes):
//
//   1. ssh-config alias machines were hard-pinned to the system-OpenSSH
//      backend at adoption ("from-ssh-config"), even when the Host block
//      carries an IdentityFile ssh2 could use itself. openssh spawns one `ssh`
//      per command — every command re-pays TCP + SSH handshake. Only Host
//      blocks without a key (agent / keychain / GSSAPI territory) or with a
//      jump host still need the system `ssh`.
//   2. The native pool never disabled Nagle: ssh2 writes each SSH packet's
//      length/payload/padding as separate socket writes, and on a high-RTT
//      path every burst waits for the previous ACK (plus delayed-ACK) before
//      the next small write goes out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import { SshPool } from '../lib/pool.js'
import { createHost } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

async function withSshConfig(text, fn, opts = {}) {
  const saved = process.env.DSH_REMOTE_SSH_CONFIG
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-211-'))
  const file = path.join(dir, 'config')
  writeFileSync(file, text, 'utf8')
  process.env.DSH_REMOTE_SSH_CONFIG = file
  const host = await createHost(opts.host)
  try {
    await fn({ host })
  } finally {
    await host.dispose()
    if (saved === undefined) delete process.env.DSH_REMOTE_SSH_CONFIG
    else process.env.DSH_REMOTE_SSH_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
}

test('#211: from-ssh-config adopts a Host block WITH an IdentityFile on the native backend', async () => {
  const text = [
    'Host keyhost',
    '  HostName 10.9.0.2',
    '  User jimlon',
    '  IdentityFile ~/.ssh/id_ed25519',
    '  IdentitiesOnly yes',
  ].join('\n')
  await withSshConfig(text, async ({ host }) => {
    const r = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: 'keyhost' } })
    assert.equal(r.status, 200, r.raw)
    assert.equal(r.json.machine.backend, 'native',
      'an IdentityFile is a credential ssh2 can use — no reason to spawn ssh per command')
    assert.match(r.json.machine.privateKeyPath, /id_ed25519/, 'the key snapshot is recorded for the backend decision')
    // The record on disk agrees.
    const rec = host.readMachines().find((m) => m.host === 'keyhost')
    assert.equal(rec.backend, 'native')
    assert.match(rec.privateKeyPath, /id_ed25519/)
    assert.equal(rec.useSshConfig, true, 'the alias stays the source of truth')
  })
})

test('#211: a Host block with a ProxyJump still goes to openssh (native cannot honor it alone)', async () => {
  const text = [
    'Host jumped',
    '  HostName 10.9.0.2',
    '  User jimlon',
    '  IdentityFile ~/.ssh/id_ed25519',
    '  ProxyJump bastion',
  ].join('\n')
  await withSshConfig(text, async ({ host }) => {
    const r = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: 'jumped' } })
    assert.equal(r.status, 200, r.raw)
    assert.equal(r.json.machine.backend, 'openssh', 'the system ssh interprets ProxyJump itself')
  })
})

test('#211: an editing save keeps the native alias machine native (no flip back to openssh)', async () => {
  const text = [
    'Host keyhost',
    '  HostName 10.9.0.2',
    '  User jimlon',
    '  IdentityFile ~/.ssh/id_ed25519',
  ].join('\n')
  await withSshConfig(text, async ({ host }) => {
    const add = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: 'keyhost' } })
    const id = add.json.machine.id
    // The settings form's save shape: the alias fields loaded into the form,
    // privateKeyPath included (empty password box = keep the saved secret).
    const save = await host.call('/dsh-remote/machines', {
      body: { action: 'update', id, name: 'keyhost', host: 'keyhost', useSshConfig: true, username: 'jimlon', privateKeyPath: '~/.ssh/id_ed25519', backend: 'native' },
    })
    assert.equal(save.status, 200, save.raw)
    const rec = host.readMachines().find((m) => m.id === id)
    assert.equal(rec.backend, 'native', 'an edited save must not recompute the backend away from native')
  })
})

test('#211: the native pool disables Nagle once the connection is READY (never before connect)', async () => {
  // Source pin first: the call must live INSIDE the 'ready' handler — ssh2's
  // setNoDelay only reaches the socket, which does not exist until connected,
  // so a pre-connect call is a silent no-op (that is the trap this guards).
  const src = readFileSync(new URL('../lib/pool.js', import.meta.url), 'utf8')
  const ready = src.slice(src.indexOf("client.on('ready', () => {"), src.indexOf("client.on('error', (e) => rejectOnce(e))"))
  assert.ok(ready.includes('setNoDelay(true)'),
    'setNoDelay(true) must run inside the ready handler (the socket only exists then)')

  // Behavioral proof against a real ssh2 connection: patch the prototype,
  // connect to the fake server, and observe the call with the right argument.
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: {} })
  const orig = ssh2.Client.prototype.setNoDelay
  const calls = []
  ssh2.Client.prototype.setNoDelay = function (noDelay) { calls.push(noDelay); return orig.apply(this, arguments) }
  const pool = new SshPool({
    host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: '',
    commandTimeoutMs: 5000, connectTimeoutMs: 5000, maxOutputChars: 10000, maxFileBytes: 100000,
    hostKeyMode: 'off', useAgent: false, keyboardInteractive: false,
  })
  try {
    await pool.connect()
    await pool.exec('echo ok')
    assert.ok(calls.includes(true), `ssh2's setNoDelay(true) must be called — saw: ${JSON.stringify(calls)}`)
  } finally {
    ssh2.Client.prototype.setNoDelay = orig
    pool.close()
    await srv.close()
  }
})
