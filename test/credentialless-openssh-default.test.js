// A ~/.ssh/config alias whose Host block carries only HostName/User has no
// credential the native (ssh2) backend can use: OpenSSH discovers default
// identities itself (id_rsa/id_ed25519, the agent, AddKeysToAgent/UseKeychain),
// while ssh2 authenticates only through a password, a privateKeyPath, an agent or
// keyboard-interactive. Dialing such a machine on native therefore reports
// 「缺少凭据」 for a host `ssh <alias>` reaches fine.
//
// These tests pin the resolution rule: a credential-less machine must dial
// through the user's own ssh (openssh), and every machine that does carry a
// native-usable credential — or that explicitly chooses openssh — must keep its
// chosen backend.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost, machine } from './harness/plugin-host.js'

/** Point the plugin at a scratch ~/.ssh/config for one test. */
async function withSshConfig(text, fn, { machines = [], config = {} } = {}) {
  const saved = process.env.DSH_REMOTE_SSH_CONFIG
  // A temp dir of its own — never the real ~/.ssh/config and never the cwd.
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-sshcfg-'))
  const file = path.join(dir, 'config')
  writeFileSync(file, text, 'utf8')
  process.env.DSH_REMOTE_SSH_CONFIG = file
  const host = await createHost({ machines, config })
  try {
    await fn({ host, file })
  } finally {
    await host.dispose()
    if (saved === undefined) delete process.env.DSH_REMOTE_SSH_CONFIG
    else process.env.DSH_REMOTE_SSH_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
}

const ALIAS = 'home-node0'
// The reported shape: HostName/User only, no IdentityFile — ssh finds a default
// identity, ssh2 has nothing to authenticate with.
const ALIAS_CONFIG = [
  `Host ${ALIAS}`,
  '  HostName 127.0.0.1',
  '  User david',
  '  Port 1',
].join('\n')

// ── from-ssh-config adoption ────────────────────────────────────────────────

test('from-ssh-config adopts a credential-less host on openssh', async () => {
  await withSshConfig(ALIAS_CONFIG, async ({ host }) => {
    const r = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: ALIAS } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true, `adopt failed: ${r.raw}`)
    assert.equal(r.json.machine.backend, 'openssh', 'the user\'s own ssh must interpret this Host block')
    assert.equal(host.readMachines().find((m) => m.host === ALIAS).backend, 'openssh')
  })
})

test('from-ssh-config upgrades an existing native credential-less record in place', async () => {
  await withSshConfig(ALIAS_CONFIG, async ({ host }) => {
    const r = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: ALIAS } })
    assert.equal(r.json.created, false, 'the saved record must be reused, not duplicated')
    assert.equal(r.json.machine.backend, 'openssh', `adopted-before-fix records must be upgraded — got ${r.json.machine.backend}`)
    assert.equal(host.readMachines().find((m) => m.host === ALIAS).backend, 'openssh')
  }, {
    machines: [machine({ id: 'm-native', name: ALIAS, host: ALIAS, useSshConfig: true, backend: 'native', password: '', privateKeyPath: '' })],
  })
})

test('from-ssh-config leaves a native record alone when it has a credential', async () => {
  await withSshConfig(ALIAS_CONFIG, async ({ host }) => {
    const r = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: ALIAS } })
    assert.equal(r.json.machine.backend, 'native', 'a stored password is a credential native can use')
  }, {
    machines: [machine({ id: 'm-pw', name: ALIAS, host: ALIAS, useSshConfig: true, backend: 'native', password: 'pw' })],
  })
})

// ── saving a machine ───────────────────────────────────────────────────────

test('saving a credential-less ~/.ssh/config machine gives it openssh', async () => {
  await withSshConfig(ALIAS_CONFIG, async ({ host }) => {
    const r = await host.call('/dsh-remote/machines', {
      body: { action: 'add', name: ALIAS, host: ALIAS, useSshConfig: true, port: 22, username: 'root' },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.machine.backend, 'openssh')
  })
})

test('native is kept for every credential it can actually authenticate with', async () => {
  const host = await createHost({ config: { credentialFallback: 'plain' } })
  try {
    const cases = [
      ['a password', { password: 'pw' }],
      ['a private key path', { privateKeyPath: '/home/david/.ssh/id_ed25519' }],
      ['the ssh agent', { useAgent: true }],
      ['keyboard-interactive', { keyboardInteractive: true }],
    ]
    for (let i = 0; i < cases.length; i++) {
      const [label, body] = cases[i]
      const r = await host.call('/dsh-remote/machines', {
        body: { action: 'add', host: `cred-${i}.internal`, username: 'u', ...body },
      })
      assert.equal(r.json.machine.backend, 'native', `${label} must stay on native — got ${r.json.machine.backend}`)
    }
  } finally {
    await host.dispose()
  }
})

test('a keychain-backed secret keeps native although the record holds no password', async () => {
  const host = await createHost({
    machines: [machine({ id: 'm-key', host: 'keychain-box.internal', password: '', credentialBackend: 'keychain', secretStored: true })],
  })
  try {
    const r = await host.call('/dsh-remote/machines', {
      body: { action: 'update', id: 'm-key', host: 'keychain-box.internal', username: 'root' },
    })
    assert.equal(r.status, 200)
    assert.equal(r.json.machine.backend, 'native', 'a secret the OS store holds is still a native credential')
  } finally {
    await host.dispose()
  }
})

test('an explicit openssh choice wins over the credential heuristic', async () => {
  const host = await createHost()
  try {
    const withPassword = await host.call('/dsh-remote/machines', {
      body: { action: 'add', host: 'kerberos-box.internal', username: 'u', password: 'pw', backend: 'openssh' },
    })
    assert.equal(withPassword.json.machine.backend, 'openssh')
    const bare = await host.call('/dsh-remote/machines', {
      body: { action: 'add', host: 'kerberos-bare.internal', username: 'u', backend: 'openssh' },
    })
    assert.equal(bare.json.machine.backend, 'openssh')
  } finally {
    await host.dispose()
  }
})

// ── dialing ────────────────────────────────────────────────────────────────
// An unreachable ssh binary makes the selected backend identifiable in the
// failure: openssh names its missing executable, native reports missing
// credentials. The real-ssh tests below then assert the classification itself.

test('test-connect dials openssh for a credential-less machine', async () => {
  await withSshConfig(ALIAS_CONFIG, async ({ host }) => {
    const saved = await host.call('/dsh-remote/machines', {
      body: { action: 'add', name: ALIAS, host: ALIAS, useSshConfig: true },
    })
    const probe = await host.call('/dsh-remote/test-connect', {
      body: { id: saved.json.machine.id, host: ALIAS, useSshConfig: true, password: '' },
    })
    assert.equal(probe.status, 200)
    assert.equal(probe.json.ok, false, 'port 1 is closed, so the dial must fail')
    assert.match(String(probe.json.error), /system-OpenSSH backend needs/, `expected the openssh backend, got: ${probe.json.error}`)
    assert.doesNotMatch(String(probe.json.error), /缺少凭据|no credentials/)
  }, { config: { sshBinary: 'definitely-not-an-ssh-binary-xyz' } })
})

test('test-connect on a credential-less machine no longer reports missing credentials', async () => {
  await withSshConfig(ALIAS_CONFIG, async ({ host }) => {
    const saved = await host.call('/dsh-remote/machines', {
      body: { action: 'add', name: ALIAS, host: ALIAS, useSshConfig: true },
    })
    const probe = await host.call('/dsh-remote/test-connect', {
      body: { id: saved.json.machine.id, host: ALIAS, useSshConfig: true, password: '' },
    })
    assert.equal(probe.json.ok, false)
    assert.doesNotMatch(String(probe.json.error), /缺少凭据|no credentials/, `got: ${probe.json.error}`)
    assert.match(String(probe.json.error), /ssh failed|system-OpenSSH backend needs/, `got: ${probe.json.error}`)
    // `process.execPath` is a runnable binary that rejects ssh's argv, so the
    // probe fails at the delegated transport without touching a real machine.
  }, { config: { sshBinary: process.execPath } })
})

test('the /connect route hands a credential-less target to the local ssh', async () => {
  await withSshConfig(ALIAS_CONFIG, async ({ host }) => {
    const r = await host.call('/dsh-remote/connect', { body: { host: ALIAS, port: 22, username: 'root', password: '' } })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true, `a credential-less alias must not be refused as missing credentials — got: ${r.raw}`)
    assert.doesNotMatch(r.raw, /缺少凭据|no credentials/)
  }, { config: { sshBinary: process.execPath } })
})

test('the /connect route keeps native when the target carries a password', async () => {
  const host = await createHost({ config: { sshBinary: 'definitely-not-an-ssh-binary-xyz' } })
  try {
    const r = await host.call('/dsh-remote/connect', { body: { host: '127.0.0.1', port: 1, username: 'u', password: 'pw' } })
    assert.equal(r.json.ok, false, 'port 1 is closed')
    assert.doesNotMatch(String(r.json.error), /system-OpenSSH backend needs/, `a password must stay on native — got: ${r.json.error}`)
  } finally {
    await host.dispose()
  }
})

test('rw_connect without saving dials openssh for a credential-less alias', async () => {
  await withSshConfig(ALIAS_CONFIG, async ({ host }) => {
    const res = await host.run('rw_connect', { host: ALIAS, useSshConfig: true, save: false })
      .then((r) => ({ r }), (e) => ({ thrown: e }))
    assert.ok(!res.thrown, `a credential-less alias must not be refused as missing credentials — got: ${res.thrown && res.thrown.message}`)
    assert.doesNotMatch(String(res.r.text || ''), /缺少凭据|no credentials/, `got: ${res.r.text}`)
    assert.match(String(res.r.text || ''), /connect failed|ssh failed/, `got: ${res.r.text}`)
  }, { config: { sshBinary: process.execPath } })
})
