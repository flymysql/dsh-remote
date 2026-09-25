// Regression: POST /dsh-remote/current for the ALREADY-current machine must be
// idempotent — no registry rewrite, no credential re-read, no pool re-point.
// The picker used to post this before every /ls, so every autocomplete
// keystroke rewrote machines.json and re-applied the machine.
//
// Observable contract used here: an idempotent /current never WRITES
// machines.json. The test deletes the file after the machine is applied and
// asserts it stays deleted — sharper than mtime comparison and independent of
// filesystem timestamp granularity.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-current-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  const machines = [
    { id: 'm-linux', name: 'linuxbox', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw-linux' },
    { id: 'm-win', name: 'winbox', host: '127.0.0.22', port: 1, username: 'Administrator', password: 'pw-win' },
  ]
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: machines, currentId: 'm-win' }))
  return { home, machinesFile: path.join(root, 'machines.json') }
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
  const mod = await import(`../lib/index.js?current=${Math.random()}`)
  const { ctx, routes } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  return { routes }
}

async function postCurrent(routes, id) {
  const route = routes.get('/dsh-remote/current')
  assert.ok(route, 'route /dsh-remote/current must be registered')
  const req = Readable.from([Buffer.from(JSON.stringify({ id }))])
  req.method = 'POST'
  req.url = '/dsh-remote/current'
  const res = {
    statusCode: 0,
    payload: '',
    setHeader() {},
    end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.payload) }
}

test('POST /current for the already-current machine never rewrites machines.json', async () => {
  const { home, machinesFile } = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    // Switch to m-linux once — this one DOES persist state (currentId changes).
    const first = await postCurrent(routes, 'm-linux')
    assert.equal(first.status, 200)
    assert.equal(first.json.ok, true)
    assert.ok(existsSync(machinesFile), 'a real switch must persist the registry')
    rmSync(machinesFile)
    // Re-applying the SAME machine must be a no-op: no registry write at all.
    for (let i = 0; i < 3; i++) {
      const r = await postCurrent(routes, 'm-linux')
      assert.equal(r.status, 200)
      assert.equal(r.json.ok, true, `call ${i} must report ok`)
    }
    assert.ok(!existsSync(machinesFile), 'idempotent /current must not rewrite machines.json')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /current for a DIFFERENT machine still persists the switch', async () => {
  const { home, machinesFile } = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    await postCurrent(routes, 'm-linux')
    rmSync(machinesFile)
    const r = await postCurrent(routes, 'm-win')
    assert.equal(r.status, 200)
    assert.ok(existsSync(machinesFile), 'a real switch must rewrite machines.json')
    const saved = JSON.parse((await import('node:fs')).readFileSync(machinesFile, 'utf8'))
    assert.equal(saved.currentId, 'm-win')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})
