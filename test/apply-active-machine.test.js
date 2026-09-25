// Regression: applyActiveMachine / clearActiveMachine must re-point the shared
// pool even though they read the new target OUT OF the config they just
// mutated. `new SshPool(config)` shares the LIVE config object with the plugin
// and lib/registry.js applyMachine mutates that object IN PLACE before
// pool.setTarget is called — so a config-vs-config diff is always EQUAL (the
// dead no-op check introduced by 5246082). Consequence: switching machines via
// POST /dsh-remote/current kept the OLD ssh2 client and stale platform cache
// and commands executed on the OLD host while the registry reported the NEW
// one (the wrong-host hazard of issue #25).
//
// The pool-level tests model that EXACT call shape: a config object shared with
// pool.config, mutated applyMachine-style BEFORE setTarget is called with
// values read from that same config, with the pre-mutation snapshot as the diff
// baseline (the fixed signature). The plugin-level tests pin the production
// wiring through POST /dsh-remote/current. Written FIRST and captured RED
// against the un-fixed code (strict TDD).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SshPool } from '../lib/pool.js'
import { applyMachine } from '../lib/registry.js'

// ── pool-level: the real applyActiveMachine call shape ──────────────────────

const baseConfig = () => ({
  host: 'a.test', port: 22, username: 'dev', password: 'pw-a',
  privateKeyPath: '', passphrase: '', workspace: '/ws', shell: '',
  useAgent: false, keyboardInteractive: false, hostKeyMode: 'off',
  connectTimeoutMs: 500, commandTimeoutMs: 500,
})

const machineB = {
  host: 'b.test', port: 2222, username: 'root', password: 'pw-b',
  privateKeyPath: '', passphrase: '', workspace: '/ws-b',
  useAgent: false, keyboardInteractive: false, hostKeyMode: 'off',
}

// Mirror of the field set pool.setTarget diffs (kept in sync with lib/index.js).
const targetFields = (c) => ({
  host: c.host, port: c.port, username: c.username,
  password: c.password, privateKeyPath: c.privateKeyPath,
  passphrase: c.passphrase, workspace: c.workspace,
  useAgent: c.useAgent, keyboardInteractive: c.keyboardInteractive,
  proxy: c.proxy, hostKeyMode: c.hostKeyMode,
})

// Mirror of applyActiveMachine's production call shape (lib/index.js): take the
// diff baseline BEFORE applyMachine mutates the shared config, then call
// setTarget with values READ FROM THAT SAME config plus the snapshot.
function applyActiveMachineShape(pool, machine) {
  const config = pool.config
  const previous = targetFields(config)
  applyMachine(config, { ...machine })
  return pool.setTarget(targetFields(config), previous)
}

// Mirror of clearActiveMachine's production call shape (lib/index.js): zero the
// shared config FIRST (applyMachine keeps an empty workspace, so it cannot be
// used for a full reset), with the pre-zeroing snapshot as the diff baseline.
function clearActiveMachineShape(pool) {
  const config = pool.config
  const previous = targetFields(config)
  config.host = ''
  config.port = 22
  config.username = ''
  config.password = ''
  config.workspace = ''
  return pool.setTarget({ host: '', port: 22, username: '', workspace: '' }, previous)
}

function warmPool() {
  const config = baseConfig()
  const pool = new SshPool(config, { knownHostsFile: () => '' })
  const stats = { ended: 0 }
  // Simulate the state between picker keystrokes: connection live, platform
  // detected for the machine currently applied to the shared config.
  pool.client = { end() { stats.ended++ }, destroy() { stats.ended++ } }
  pool.platform = 'posix'
  pool.shellMode = 'native'
  pool.gitBashPath = ''
  return { pool, stats }
}

test('applyActiveMachine shape: switching machines closes the old connection + re-detects', () => {
  const { pool, stats } = warmPool()
  applyActiveMachineShape(pool, machineB)
  assert.equal(stats.ended, 1, 'a machine switch must close the OLD connection')
  assert.equal(pool.client, null, 'the stale client must not be reused')
  assert.equal(pool.platform, 'unknown', 'the new machine must be re-detected')
  assert.equal(pool.config.host, 'b.test', 'the shared config must carry the new identity')
  assert.equal(pool.config.port, 2222)
  assert.equal(pool.config.username, 'root')
})

test('applyActiveMachine shape: re-applying the SAME machine keeps the live connection', () => {
  const { pool, stats } = warmPool()
  // Same record values (what POST /current does on every picker keystroke).
  applyActiveMachineShape(pool, { ...baseConfig(), shell: undefined })
  assert.equal(stats.ended, 0, 'an identical target must NOT close the connection')
  assert.ok(pool.client, 'the client must stay cached')
  assert.equal(pool.platform, 'posix', 'the platform-detection cache must survive')
})

test('clearActiveMachine shape: "active remote = none" disconnects the shared pool', () => {
  const { pool, stats } = warmPool()
  clearActiveMachineShape(pool)
  assert.equal(stats.ended, 1, 'clearing the active machine must close the connection')
  assert.equal(pool.client, null)
  assert.equal(pool.config.host, '', 'the shared config must be zeroed')
})

// ── plugin-level: the production wiring through POST /dsh-remote/current ────

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-apply-'))
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
  const mod = await import(`../lib/index.js?apply=${Math.random()}`)
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

// Call-through spies (observation only — the real methods always run): the
// plugin's active pool is internal, so "the live connection was closed" is
// observed by arming a fake client on the real pool instance and watching
// whether the real setTarget/close path ends it. dev-standards §1: this is not
// a mock of the contract under test — the production code path is untouched.
const origSetTarget = SshPool.prototype.setTarget
const origExec = SshPool.prototype.exec
let obs = null
SshPool.prototype.setTarget = function (...args) {
  if (obs && !obs.pool) obs.pool = this
  return origSetTarget.apply(this, args)
}
SshPool.prototype.exec = function (cmd, ...rest) {
  if (obs && !obs.pool) obs.pool = this
  const p = origExec.call(this, cmd, ...rest)
  if (obs && obs.onRestoreSettled && String(cmd).includes('dsh-remote-restore')) {
    const done = obs.onRestoreSettled
    obs.onRestoreSettled = null
    p.then(done, done)
  }
  return p
}

// Arm a fake live connection + detected platform on the plugin's pool — the
// exact state the pool is in between picker keystrokes. `ended` counts how
// often the production code closed that connection.
function makeObs() {
  const o = {
    pool: null,
    ended: 0,
    onRestoreSettled: null,
    armFake() {
      o.ended = 0
      o.pool.client = { end() { o.ended++ }, destroy() { o.ended++ } }
      o.pool.platform = 'posix'
      o.pool.shellMode = 'native'
      o.pool.gitBashPath = ''
    },
  }
  return o
}

// The boot-restore path (lib/index.js) applies the stored current machine and
// probes it with `echo dsh-remote-restore`; waiting for that probe to settle
// guarantees the restore apply has fully completed before the test acts.
async function afterBootRestore(o) {
  const settled = new Promise((resolve) => { o.onRestoreSettled = resolve })
  await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 5000))])
}

test('POST /current for a DIFFERENT machine re-points the pool (closes + re-detects)', async () => {
  const { home } = makeHome()
  obs = makeObs()
  try {
    const { routes } = await loadPlugin(home)
    await afterBootRestore(obs)
    obs.armFake()
    const r = await postCurrent(routes, 'm-linux')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(obs.ended, 1, 'switching machines must close the OLD connection (shared-config shape)')
    assert.equal(obs.pool.client, null, 'the stale client must not be reused')
    assert.equal(obs.pool.platform, 'unknown', 'the new machine must be re-detected')
    assert.equal(obs.pool.config.host, '127.0.0.11')
  } finally {
    obs = null
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /current with an empty id disconnects the pool (clearActiveMachine shape)', async () => {
  const { home } = makeHome()
  obs = makeObs()
  try {
    const { routes } = await loadPlugin(home)
    await afterBootRestore(obs)
    obs.armFake()
    const r = await postCurrent(routes, '')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(obs.ended, 1, '"active remote = none" must close the connection (shared-config shape)')
    assert.equal(obs.pool.client, null)
    assert.equal(obs.pool.config.host, '', 'the shared config must be zeroed')
  } finally {
    obs = null
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('boot restore keeps POST /current idempotent (fingerprint maintained in applyActiveMachine)', async () => {
  const { home, machinesFile } = makeHome()
  obs = makeObs()
  try {
    const { routes } = await loadPlugin(home)
    await afterBootRestore(obs)
    // The boot-restore path applied m-win via applyActiveMachine DIRECTLY —
    // setCurrent never ran, so the fingerprint must still record the applied
    // machine (A3 drift: otherwise every /current re-applies + rewrites).
    rmSync(machinesFile, { force: true })
    for (let i = 0; i < 3; i++) {
      const r = await postCurrent(routes, 'm-win')
      assert.equal(r.status, 200)
      assert.equal(r.json.ok, true, `call ${i} must report ok`)
    }
    assert.ok(!existsSync(machinesFile), 'same-machine /current after a boot-restore apply must not rewrite machines.json')
  } finally {
    obs = null
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})
