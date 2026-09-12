// Regression tests for issue #30 — "every failure is just an empty HTTP 400".
//
// Root cause pinned here: `/dsh-remote/test-connect` and `/dsh-remote/connect`
// read a JSON body into a `const` declared INSIDE their try block, then the
// catch block referenced that const. A try-scoped const is invisible in catch,
// so the catch itself threw `ReferenceError: body is not defined` before it
// could send anything; dsh-host-webserver turns a rejected handler into
// `400` with an empty body, and the UI could only print "HTTP 400" — no matter
// whether the port was closed, the password wrong or the JSON malformed.
//
// The tests below drive the REAL registered route handlers (through a fake
// webServer) and assert that every failure still produces a JSON body with a
// reason. The SSH layer is not mocked: a closed port fails fast and for real.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { persistPassword } from '../lib/credential.js'

const HOME_ROOT = () => path.join(process.env.DSH_HOME, 'remote-workspaces')

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-routes-'))
  mkdirSync(path.join(home, 'remote-workspaces'), { recursive: true })
  return home
}

/** Minimal ctx: apply() needs effect/get/tools/systemPrompt; the fake webServer
 *  captures every registered route so tests can call it directly. */
function makeCtx() {
  const routes = new Map()
  const tools = new Map()
  const ctx = {
    effect: () => {},
    get: (k) => (k === 'webServer' ? { register: (r) => { routes.set(r.path, r); return () => {} } } : undefined),
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes, tools }
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
  const mod = await import(`../lib/index.js?routes=${Math.random()}`)
  const { ctx, routes } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  return { routes, mod }
}

/** Drive one route handler with a raw body, the way the webserver does. */
async function call(routes, routePath, { method = 'POST', body = '', raw = false } = {}) {
  const route = routes.get(routePath)
  assert.ok(route, `route ${routePath} must be registered`)
  const req = Readable.from([Buffer.from(raw ? body : JSON.stringify(body))])
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
  return { status: res.statusCode, headers: res.headers, raw: res.payload, json, rejected }
}

// A closed local port: connecting fails immediately with ECONNREFUSED.
const DEAD = { host: '127.0.0.1', port: 1, username: 'user', password: 'x' }

test('test-connect: a failed probe answers 200 + JSON reason, it never rejects', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const r = await call(routes, '/dsh-remote/test-connect', { body: DEAD })

    assert.equal(r.rejected, null, 'the handler must not reject (issue #30)')
    assert.equal(r.status, 200)
    assert.match(String(r.headers['Content-Type']), /application\/json/)
    assert.equal(r.json.ok, false)
    assert.ok(r.json.error && r.json.error.length > 0, 'the failure must carry a reason')
    assert.match(r.json.error, /127\.0\.0\.1/, `the reason must name the host, got: ${r.json.error}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('test-connect: a malformed JSON body is reported, not swallowed into an empty 400', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const r = await call(routes, '/dsh-remote/test-connect', { body: '{"host": ', raw: true })

    assert.equal(r.rejected, null)
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /不是合法 JSON/)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('connect: a failed connect answers JSON with a reason (500) instead of an empty 400', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const r = await call(routes, '/dsh-remote/connect', { body: DEAD })

    assert.equal(r.rejected, null, 'the handler must not reject (issue #30)')
    assert.equal(r.status, 500)
    assert.match(String(r.headers['Content-Type']), /application\/json/)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /127\.0\.0\.1/)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('connect: a malformed JSON body answers 400 + JSON (still a readable reason)', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const r = await call(routes, '/dsh-remote/connect', { body: 'nope', raw: true })

    assert.equal(r.rejected, null)
    assert.equal(r.status, 400)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /不是合法 JSON/)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('machines: a plaintext save keeps the password and reports no warning', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const r = await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', host: '10.1.2.3', port: 22, username: 'u', password: 'pw', encryptPassword: false },
    })

    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.warning, undefined, 'no warning when nothing was encrypted')
    assert.equal(r.json.machine.credentialBackend, 'plain')
    assert.equal(r.json.machine.password, undefined, 'the password must never be echoed back')
    assert.equal(r.json.machine.passwordSet, true)

    const onDisk = JSON.parse(readFileSync(path.join(HOME_ROOT(), 'machines.json'), 'utf8'))
    const saved = onDisk.list.find((m) => m.host === '10.1.2.3')
    assert.ok(saved, 'the machine must be persisted')
    assert.equal(saved.password, 'pw', 'a plaintext credential must actually be written')
    assert.equal(saved.credentialBackend, 'plain')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

// ── the credential decision itself (issue #30, second half) ────────────────
// The OS store is best-effort; a failure must never silently produce a machine
// with no credential at all.

test('persistPassword: a failed OS-store write falls back to plaintext + warning', async () => {
  const res = await persistPassword({
    backend: 'windows',
    machineId: 'm1',
    password: 'hunter2',
    secretsDir: '/nonexistent',
    save: async () => ({ ok: false, backend: 'windows', error: 'Add-Type: type not found' }),
  })

  assert.equal(res.stored, 'plain')
  assert.equal(res.credentialBackend, 'plain')
  assert.equal(res.password, 'hunter2', 'the password must survive the fallback')
  assert.equal(res.warning, 'secret-store-failed')
  assert.match(res.error, /Add-Type/)
})

test('persistPassword: a successful OS-store write keeps the secret out of the registry', async () => {
  const res = await persistPassword({
    backend: 'keychain',
    machineId: 'm1',
    password: 'hunter2',
    secretsDir: '/nonexistent',
    save: async () => ({ ok: true, backend: 'keychain', error: '' }),
  })

  assert.equal(res.stored, 'secret')
  assert.equal(res.credentialBackend, 'keychain')
  assert.equal(res.password, '')
  assert.equal(res.warning, '')
})

test('persistPassword: a thrown store error is reported without echoing the password', async () => {
  const res = await persistPassword({
    backend: 'windows',
    machineId: 'm1',
    password: 'hunter2',
    secretsDir: '/nonexistent',
    save: async () => { throw new Error("Command failed: security add-generic-password -w hunter2") },
  })

  assert.equal(res.warning, 'secret-store-failed')
  assert.ok(!res.error.includes('hunter2'), `the diagnostic leaked the password: ${res.error}`)
  assert.match(res.error, /\*\*\*/)
})

test('persistPassword: no password requested → nothing is stored, nothing is warned', async () => {
  const res = await persistPassword({ backend: 'keychain', machineId: 'm1', password: '', secretsDir: '/nonexistent' })
  assert.equal(res.stored, 'none')
  assert.equal(res.warning, '')
})

test('persistPassword: backend "plain" never touches the OS store', async () => {
  let called = false
  const res = await persistPassword({
    backend: 'plain',
    machineId: 'm1',
    password: 'hunter2',
    secretsDir: '/nonexistent',
    save: async () => { called = true; return { ok: true } },
  })
  assert.equal(called, false)
  assert.equal(res.stored, 'plain')
  assert.equal(res.password, 'hunter2')
})
