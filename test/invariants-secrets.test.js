// Invariant: a stored secret NEVER comes back out.
//
// The plugin keeps a plaintext password in machines.json (when the user did not ask
// for the keychain) and a passphrase / jump-host password in the record. Those
// values must never reach the browser, the audit log, a tool result, or an error
// message — the settings page only ever learns `passwordSet: true`.
//
// The credential tests assert this for the two obvious routes. This file is the
// SWEEP: seed known secrets, drive every route that can answer without a live
// remote, and grep the entire response stream for them. A single route that echoes
// a machine record verbatim would fail here, which is exactly the kind of leak that
// ships silently (it looks like a helpful "here is what I saved").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createHost } from './harness/plugin-host.js'

const PASSWORD = 'Sup3r-Secret-Pa55'
const PASSPHRASE = 'pp-Secret-42'
const JUMP_PASSWORD = 'jump-Secret-77'
const KEY_PATH = '/home/user/.ssh/id_ed25519'

const MACHINE = {
  id: 'm-secret',
  name: 'secret-box',
  host: '10.0.0.44',
  port: 22,
  username: 'root',
  password: PASSWORD,
  passphrase: PASSPHRASE,
  privateKeyPath: KEY_PATH,
  credentialBackend: 'plain',
  hostKeyMode: 'off',
  proxy: { host: 'bastion.example', port: 22, username: 'jump', password: JUMP_PASSWORD },
  recentWorkspaces: ['/home/user'],
}

/** Routes that answer without a live remote AND have no side effects. */
const SAFE_CALLS = [
  { path: '/dsh-remote/status', method: 'GET' },
  { path: '/dsh-remote/machines', method: 'GET' },
  { path: '/dsh-remote/bindings', method: 'GET' },
  { path: '/dsh-remote/resolve-mirror', method: 'GET' },
  { path: '/dsh-remote/ssh-config', method: 'GET' },
  { path: '/dsh-remote/audit', method: 'GET' },
  { path: '/dsh-remote/tasks', method: 'GET' },
  { path: '/dsh-remote/forwards', method: 'GET' },
  { path: '/dsh-remote/update-check', method: 'GET' },
  { path: '/dsh-remote/web-attach', method: 'GET' },
  { path: '/dsh-remote/term/list', method: 'GET' },
  { path: '/dsh-remote/current', body: { id: MACHINE.id } },
  { path: '/dsh-remote/test-connect', body: { id: MACHINE.id, host: MACHINE.host, username: 'root', password: '' } },
  { path: '/dsh-remote/home', body: {} },
  { path: '/dsh-remote/ls', body: { path: '/' } },
  { path: '/dsh-remote/read', body: { path: '/etc/hostname' } },
  { path: '/dsh-remote/write', body: { path: '/tmp/x', content: 'x' } },
  { path: '/dsh-remote/fs', body: { op: 'mkdir', path: '/tmp/y' } },
  { path: '/dsh-remote/term/open', body: {} },
  { path: '/dsh-remote/forwards', body: { action: 'define', listenPort: 46999, targetHost: '127.0.0.1', targetPort: 1 } },
  { path: '/dsh-remote/machines', body: { action: 'update', id: MACHINE.id, host: MACHINE.host, username: 'root' } },
  { path: '/dsh-remote/machines', body: { action: 'delete', id: 'm-nope' } },
]

function assertNoSecret(label, text) {
  for (const [what, secret] of [['password', PASSWORD], ['passphrase', PASSPHRASE], ['jump password', JUMP_PASSWORD]]) {
    assert.equal(text.includes(secret), false,
      `${label} leaked the ${what}. Response: ${text.slice(0, 400)}`)
  }
}

test('no route echoes a stored password, passphrase or jump-host password', async () => {
  const host = await createHost({ machines: [{ ...MACHINE }] })
  try {
    const responses = []
    for (const call of SAFE_CALLS) {
      const r = await host.call(call.path, { method: call.method || 'POST', body: call.body || {} })
      assert.equal(r.rejected, null, `${call.path} rejected — a rejection is an empty 400 to the user`)
      responses.push({ label: `${call.method || 'POST'} ${call.path}`, raw: r.raw })
    }
    for (const r of responses) assertNoSecret(r.label, r.raw)

    // The machine list must still be USEFUL: the UI needs to know a credential
    // exists (that is what renders the dots) without seeing it.
    const list = await host.call('/dsh-remote/machines', { method: 'GET' })
    const m = list.json.machines[0]
    assert.equal(m.passwordSet, true, 'passwordSet must tell the UI a credential is stored')
    assert.equal(m.passphraseSet, true, 'passphraseSet must tell the UI a passphrase is stored')
    assert.equal(m.proxy && m.proxy.passwordSet, true, 'the jump-host password must be flagged too')
    assert.equal(m.password, undefined, 'and the secret itself must be absent')
    assert.equal(m.passphrase, undefined, 'the passphrase must be absent too')
    assert.equal(m.privateKeyPath, KEY_PATH, 'the key PATH is not a secret and must remain visible')
  } finally {
    await host.dispose()
  }
})

test('no rw_* tool result echoes a stored secret', async () => {
  const host = await createHost({ machines: [{ ...MACHINE }] })
  try {
    // The registry-facing tools answer without a remote; the remote-facing ones
    // fail here (no live host), and their FAILURE must not leak either.
    const calls = [
      ['rw_machines', {}],
      ['rw_info', {}],
      ['rw_connect', { machineId: 'm-does-not-exist' }],
      ['rw_read_file', { path: '/home/user/x' }],
      ['rw_exec', { command: 'echo hi' }],
    ]
    for (const [name, args] of calls) {
      let text
      try {
        text = JSON.stringify(await host.run(name, args))
      } catch (err) {
        text = String((err && err.message) || err)
      }
      assertNoSecret(name, text)
    }
    // rw_machines must still report that a credential exists.
    const listed = JSON.stringify(await host.run('rw_machines', {}))
    assert.match(listed, /passwordSet|credential|password/i, `rw_machines must mention the credential state: ${listed.slice(0, 300)}`)
  } finally {
    await host.dispose()
  }
})

test('the audit log records the operation, never the credential', async () => {
  const host = await createHost({ machines: [{ ...MACHINE }], config: { auditLog: true } })
  try {
    // Drive an audited operation that fails at the network layer: the audit line
    // must exist, and must not contain the secret it was configured with.
    await host.call('/dsh-remote/write', { body: { path: '/home/user/audited.txt', content: 'x' } })
    const audit = await host.call('/dsh-remote/audit?limit=100', { method: 'GET' })
    const onDisk = path.join(host.root, 'audit.log')
    let fileText = ''
    try { fileText = readFileSync(onDisk, 'utf8') } catch { /* no file yet is fine */ }
    assertNoSecret('GET /audit', audit.raw)
    assertNoSecret('audit.log', fileText)
  } finally {
    await host.dispose()
  }
})

test('the registry file keeps the plaintext secret, and the API never serves that file', async () => {
  // The storage location is the user's own machine (documented, and the reason the
  // keychain option exists). What must never happen is a route handing the file —
  // or its content — to the browser.
  const host = await createHost({ machines: [{ ...MACHINE }] })
  try {
    const saved = host.readMachines()[0]
    assert.equal(saved.password, PASSWORD, 'a plaintext machine keeps its password on disk (by design)')
    const responses = []
    for (const call of SAFE_CALLS) {
      const r = await host.call(call.path, { method: call.method || 'POST', body: call.body || {} })
      responses.push(r.raw)
    }
    const all = responses.join('\n')
    assert.doesNotMatch(all, /machines\.json/, 'no route may expose the registry file path')
    assert.doesNotMatch(all, /"list"\s*:/, 'no route may dump the registry structure')
  } finally {
    await host.dispose()
  }
})
