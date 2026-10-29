// Regression tests for the credential path the settings page actually walks.
//
// Reported as: 「缺少凭据：请设置 password 或 privateKeyPath…」 even though every
// field was filled in — and, worst of all, on a machine that was ALREADY
// connected: open 编辑, click 测试连接, and the same error came back.
//
// Two independent defects produced that single message:
//
//   1. `/dsh-remote/test-connect` built its probe from the REQUEST BODY ONLY.
//      The settings form can never send a stored secret back (the host strips
//      it), so an edit-then-test posted `password: ''` and the probe threw
//      `no credentials` — while a real connect, which resolves the saved
//      password through the pool's `passwordResolver`, worked fine. The probe is
//      a MERGE of form-over-stored now (resolveProbeCredentials).
//
//   2. `passwordSet` was `!!machine.password`, i.e. "a PLAINTEXT password is in
//      machines.json". A machine whose password lives in the OS keychain keeps
//      `password: ''` by design, so it reported "no password saved" and the
//      settings page showed an empty box — which is why the password box looked
//      blank no matter how many times it had been saved.
//
// The route tests drive the REAL registered handlers through a fake webServer;
// the network layer is not mocked (a closed local port fails for real).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveProbeCredentials, sanitizeMachine, hasStoredPassword } from '../lib/registry.js'

const HOME_ROOT = () => path.join(process.env.DSH_HOME, 'remote-workspaces')

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-cred-'))
  mkdirSync(path.join(home, 'remote-workspaces'), { recursive: true })
  return home
}

function makeCtx() {
  const routes = new Map()
  const ctx = {
    effect: () => {},
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    get: (k) => (k === 'webServer' ? { register: (r) => { routes.set(r.path, r); return () => {} } } : undefined),
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes }
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

async function loadPlugin(home) {
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?cred=${Math.random()}`)
  const { ctx, routes } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  return { routes, mod }
}

async function call(routes, routePath, { method = 'POST', body = {} } = {}) {
  const route = routes.get(routePath)
  assert.ok(route, `route ${routePath} must be registered`)
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = routePath
  const res = {
    statusCode: 0,
    headers: {},
    payload: '',
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  let rejected = null
  await route.handler(req, res).catch((e) => { rejected = e })
  let json = null
  try { json = JSON.parse(res.payload) } catch { /* not JSON */ }
  return { status: res.statusCode, json, raw: res.payload, rejected }
}

const onDiskMachines = () => JSON.parse(readFileSync(path.join(HOME_ROOT(), 'machines.json'), 'utf8')).list

// ── 1) the pure merge ────────────────────────────────────────────────────────

test('probe credentials: a blank form password falls back to the SAVED one', () => {
  const rec = { host: 'h', port: 22, username: 'u', password: 'stored-pw', credentialBackend: 'plain' }
  const c = resolveProbeCredentials({ host: 'h', port: 22, username: 'u', password: '' }, rec, 'stored-pw')
  assert.equal(c.password, 'stored-pw', 'the saved password must be dialed')
  assert.equal(c.usedSavedCredential, true, 'the UI must be able to say the saved password was used')
})

test('probe credentials: a typed password always wins over the stored one', () => {
  const rec = { password: 'stored-pw' }
  const c = resolveProbeCredentials({ password: 'typed-pw' }, rec, 'stored-pw')
  assert.equal(c.password, 'typed-pw')
  assert.equal(c.usedSavedCredential, false)
})

test('probe credentials: auth METHOD flags come from the record when the form omits them', () => {
  // A machine that authenticates through an agent was probed with useAgent:false,
  // i.e. with no auth method at all — same "no credentials" dead end.
  const rec = { useAgent: true, keyboardInteractive: true, privateKeyPath: '/k/id_ed25519' }
  const c = resolveProbeCredentials({ host: 'h' }, rec, '')
  assert.equal(c.useAgent, true)
  assert.equal(c.keyboardInteractive, true)
  assert.equal(c.privateKeyPath, '/k/id_ed25519')
})

test('probe credentials: an explicit form boolean is authoritative', () => {
  const rec = { useAgent: true, keyboardInteractive: true }
  const c = resolveProbeCredentials({ useAgent: false, keyboardInteractive: false }, rec, '')
  assert.equal(c.useAgent, false)
  assert.equal(c.keyboardInteractive, false)
})

test('probe credentials: a jump-host password the form did not re-supply is carried over', () => {
  const rec = { proxy: { host: 'bastion', port: 2222, username: 'jump', password: 'jump-pw' } }
  const c = resolveProbeCredentials({
    host: 'h',
    proxy: { host: 'bastion', port: 2222, username: 'jump', password: '' },
  }, rec, '')
  assert.equal(c.proxy.password, 'jump-pw', 'the bastion credential must survive an edit')
  assert.equal(c.proxy.port, 2222)
})

test('probe credentials: a stored jump host is used even when the form has none', () => {
  const rec = { proxy: { host: 'bastion', username: 'jump', password: 'jump-pw' } }
  const c = resolveProbeCredentials({ host: 'h' }, rec, '')
  assert.equal(c.proxy.host, 'bastion')
  assert.equal(c.proxy.password, 'jump-pw')
})

test('probe credentials: no record and no form value → still empty (real missing credential)', () => {
  const c = resolveProbeCredentials({ host: 'h' }, null, '')
  assert.equal(c.password, '')
  assert.equal(c.proxy, undefined)
  assert.equal(c.usedSavedCredential, false)
})

test('probe credentials: backend falls back to the stored machine, then native', () => {
  assert.equal(resolveProbeCredentials({}, { backend: 'openssh' }, '').backend, 'openssh')
  assert.equal(resolveProbeCredentials({}, null, '').backend, 'native')
})

// ── 2) passwordSet must tell the truth about keychain-backed machines ────────

test('sanitizeMachine: a plaintext password is reported as set and never echoed', () => {
  const out = sanitizeMachine({ id: 'm1', password: 'pw', credentialBackend: 'plain' })
  assert.equal(out.password, undefined, 'secrets never round-trip')
  assert.equal(out.passwordSet, true)
})

test('sanitizeMachine: an OS-keychain machine reports passwordSet even though password is ""', () => {
  // This is the bug behind "密码框为什么是空白": the secret lives in the keychain,
  // so the record legitimately holds an empty password.
  const out = sanitizeMachine({ id: 'm1', password: '', credentialBackend: 'windows', secretStored: true })
  assert.equal(out.passwordSet, true)
  assert.equal(out.password, undefined)
})

test('sanitizeMachine: a legacy keychain record (no secretStored flag) is still reported as set', () => {
  const out = sanitizeMachine({ id: 'm1', password: '', credentialBackend: 'keychain' })
  assert.equal(out.passwordSet, true)
})

test('sanitizeMachine: a machine with no credential reports passwordSet false', () => {
  const out = sanitizeMachine({ id: 'm1', password: '', credentialBackend: 'plain' })
  assert.equal(out.passwordSet, false)
  assert.equal(hasStoredPassword({ id: 'm1', password: '', credentialBackend: 'plain' }), false)
})

test('sanitizeMachine: a stored passphrase is flagged, not echoed', () => {
  const out = sanitizeMachine({ id: 'm1', passphrase: 'secret-pp' })
  assert.equal(out.passphrase, undefined, 'the private-key passphrase must not reach the browser')
  assert.equal(out.passphraseSet, true)
  assert.equal(sanitizeMachine({ id: 'm1' }).passphraseSet, false)
})

test('sanitizeMachine: a jump-host password is flagged the same way', () => {
  const out = sanitizeMachine({ id: 'm1', proxy: { host: 'bastion', password: 'jump-pw' } })
  assert.equal(out.proxy.password, '', 'stripped')
  assert.equal(out.proxy.passwordSet, true)
})

// ── 3) the routes: "already connected → edit → test" must work ───────────────

test('test-connect: an edited machine reuses its SAVED password instead of failing with no credentials', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const saved = await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', name: 'box', host: '127.0.0.1', port: 1, username: 'u', password: 'saved-pw' },
    })
    assert.equal(saved.status, 200)
    const id = saved.json.machine.id

    // What the settings form actually posts after 编辑: the secret boxes are
    // empty because the host never sends secrets back.
    const probe = await call(routes, '/dsh-remote/test-connect', {
      body: { id, host: '127.0.0.1', port: 1, username: 'u', password: '' },
    })

    assert.equal(probe.rejected, null, 'a probe never rejects')
    assert.equal(probe.status, 200)
    assert.equal(probe.json.ok, false, 'port 1 is closed, so the dial must fail')
    assert.doesNotMatch(String(probe.json.error), /缺少凭据|no credentials/,
      `the saved password must be used — got: ${probe.json.error}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('test-connect: a machine with NO credential still reports the missing-credential error (negative control)', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const saved = await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', name: 'bare', host: '127.0.0.1', port: 1, username: 'u' },
    })
    const id = saved.json.machine.id
    assert.equal(saved.json.machine.passwordSet, false)

    const probe = await call(routes, '/dsh-remote/test-connect', {
      body: { id, host: '127.0.0.1', port: 1, username: 'u', password: '' },
    })
    assert.equal(probe.json.ok, false)
    assert.match(String(probe.json.error), /缺少凭据|no credentials/,
      'without any credential the actionable error must still be shown')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('test-connect: an agent machine says the AGENT is missing, not that nothing was configured', async (t) => {
  if (process.env.SSH_AUTH_SOCK) {
    t.skip('this host has an ssh-agent socket; the missing-agent branch cannot be exercised')
    return
  }
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const saved = await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', name: 'agentbox', host: '127.0.0.1', port: 1, username: 'u', useAgent: true },
    })
    const id = saved.json.machine.id

    const probe = await call(routes, '/dsh-remote/test-connect', {
      body: { id, host: '127.0.0.1', port: 1, username: 'u', password: '' },
    })
    assert.equal(probe.json.ok, false)
    assert.match(String(probe.json.error), /SSH agent|SSH_AUTH_SOCK/,
      `the error must name the agent, got: ${probe.json.error}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 4) an edit must never DELETE a secret it cannot show ────────────────────

test('machines: saving an edit without retyping the passphrase keeps it', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const added = await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', host: '10.9.9.9', port: 22, username: 'u', privateKeyPath: '/k/id', passphrase: 'pp-secret' },
    })
    const id = added.json.machine.id
    assert.equal(added.json.machine.passphraseSet, true, 'the UI must know a passphrase is saved')
    assert.equal(added.json.machine.passphrase, undefined, 'and must not receive it')

    // The form re-sends the machine with an EMPTY passphrase box.
    const upd = await call(routes, '/dsh-remote/machines', {
      body: { action: 'update', id, host: '10.9.9.9', port: 22, username: 'u', privateKeyPath: '/k/id', passphrase: '' },
    })
    assert.equal(upd.status, 200)
    const rec = onDiskMachines().find((m) => m.id === id)
    assert.equal(rec.passphrase, 'pp-secret', 'an empty box means "unchanged", not "delete"')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('machines: saving an edit without retyping the jump password keeps it', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const added = await call(routes, '/dsh-remote/machines', {
      body: {
        action: 'add', host: '10.9.9.9', port: 22, username: 'u', password: 'pw',
        proxy: { host: 'bastion', port: 2222, username: 'jump', password: 'jump-pw' },
      },
    })
    const id = added.json.machine.id
    assert.equal(added.json.machine.proxy.passwordSet, true)

    const upd = await call(routes, '/dsh-remote/machines', {
      body: {
        action: 'update', id, host: '10.9.9.9', port: 22, username: 'u',
        proxy: { host: 'bastion', port: 2222, username: 'jump', password: '' },
      },
    })
    assert.equal(upd.status, 200)
    const rec = onDiskMachines().find((m) => m.id === id)
    assert.equal(rec.proxy.password, 'jump-pw', 'the bastion credential must survive an edit')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('machines: an update that omits proxy entirely keeps the stored jump host', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const added = await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', host: '10.9.9.8', username: 'u', proxy: { host: 'bastion', username: 'jump' } },
    })
    const id = added.json.machine.id
    await call(routes, '/dsh-remote/machines', { body: { action: 'update', id, host: '10.9.9.8', username: 'u' } })
    const rec = onDiskMachines().find((m) => m.id === id)
    assert.equal(rec.proxy && rec.proxy.host, 'bastion')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('machines: an EXPLICIT null proxy removes the jump host (the field must be clearable)', async () => {
  // The settings form posts `proxy: null` when the jump-host box is empty, which
  // is how "omitted = keep" and "cleared = remove" stay distinguishable.
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const added = await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', host: '10.9.9.6', username: 'u', proxy: { host: 'bastion', username: 'jump' } },
    })
    const id = added.json.machine.id
    const upd = await call(routes, '/dsh-remote/machines', {
      body: { action: 'update', id, host: '10.9.9.6', username: 'u', proxy: null },
    })
    assert.equal(upd.status, 200)
    const rec = onDiskMachines().find((m) => m.id === id)
    assert.equal(rec.proxy, undefined, 'an explicit null must clear the stored jump host')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('machines: GET /machines flags the saved credential so the form can show dots', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', host: '10.9.9.7', username: 'u', password: 'pw' },
    })
    const list = await call(routes, '/dsh-remote/machines', { method: 'GET' })
    const m = list.json.machines.find((x) => x.host === '10.9.9.7')
    assert.equal(m.passwordSet, true)
    assert.equal(m.password, undefined)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})
