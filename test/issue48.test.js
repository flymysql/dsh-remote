// Issue #48 — "通过 Agent 自行连接的 ssh 不会继承已有配置".
//
// Three reported defects, three test groups:
//
//  A. A bad machine config CRASHED THE WHOLE HOST — "dsh: fatal load failure:
//     Cannot parse privateKey: Encrypted private OpenSSH key detected, but no
//     passphrase given" — and every restart re-crashed because boot-restore
//     re-dials the saved current machine. Root cause: ssh2 parses the key
//     SYNCHRONOUSLY inside Client.connect() and throws; that throw lived in an
//     orphaned buildOpts().then() fulfillment handler, so it surfaced as an
//     UNHANDLED REJECTION (process kill) while the outer connect promise hung
//     forever. Fix: pool catches the sync throw and rejects normally.
//     The negative control IS the assertion shape: pre-fix the connect promise
//     never settles (the race timeout fires) AND an unhandledRejection lands.
//
//  B. rw_connect exposed only host/username/port/password/privateKeyPath —
//     the agent could not supply passphrase/useAgent/keyboardInteractive/
//     hostKeyMode, so a machine that needs them was impossible to connect.
//
//  C. There was no way to connect with an ALREADY SAVED machine's full stored
//     settings: rw_machines lists them (secrets stripped) and
//     rw_connect(machineId=...) reuses the record wholesale.
//
// The fixture below is a THROWAWAY test-only ed25519 key (passphrase
// "test-passphrase"), generated with ssh-keygen and never used anywhere else.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SshPool } from '../lib/pool.js'
import { friendlyMessage } from '../lib/errors.js'

const LF = '\n'

// ── fixtures ────────────────────────────────────────────────────────────────

const ENCRYPTED_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABCbr3S5Fc',
  'JsTGF9oWrrYOCmAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIHX/JSFjLJvDBAKU',
  'uNv2HgAyurzeIti/Xx6zAWkGQTNUAAAAoPpKdBeepwcDQaa3RVsVyugdF8I/l/RZxhgfCU',
  'jk0hQtTpFVhm4MweIj/Z9RPmXTf+8IyorZqfhMUgvHDEQ6HQPLl2iFgzS6P55UQWZ904AA',
  'Bl5HnAgQqZYtaKJtgfGDRJN6nFIJGOKfhSwQTU8bofOAKkEloD3JFJl2XqI9uVLO9c7HW/',
  '07BDqwfApYuMjRsh1+6ec7WodtNMiHiLx8keQ=',
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join(LF)
const KEY_PASSPHRASE = 'test-passphrase'

function writeKey(dir) {
  const p = path.join(dir, 'id_ed25519')
  writeFileSync(p, ENCRYPTED_KEY, { mode: 0o600 })
  return p
}

function poolConfig(over = {}) {
  return {
    host: '127.0.0.1', port: 1, username: 'nobody', password: '',
    privateKeyPath: '', passphrase: '', workspace: '', shell: '',
    commandTimeoutMs: 1200, connectTimeoutMs: 800,
    maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
    useAgent: false, keyboardInteractive: false,
    ...over,
  }
}

/** Count unhandled rejections for the lifetime of fn (the A-group control). */
async function withoutUnhandledRejections(fn) {
  let count = 0
  const onUnhandled = () => { count++ }
  process.on('unhandledRejection', onUnhandled)
  try {
    const out = await fn()
    // Let any orphaned rejection surface before we count.
    await new Promise((r) => setTimeout(r, 250))
    return out
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    assert.equal(count, 0, 'no unhandled rejection may escape the pool (that was the host crash)')
  }
}

// ── A. the crash ────────────────────────────────────────────────────────────

test('A1: encrypted key without passphrase rejects NORMALLY (no hang, no unhandled rejection)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-i48-'))
  try {
    await withoutUnhandledRejections(async () => {
      const pool = new SshPool(poolConfig({ privateKeyPath: writeKey(dir) }))
      // Pre-fix this promise NEVER settled (the sync throw orphaned the chain);
      // the race timeout firing is the negative control.
      const outcome = await Promise.race([
        pool.connect().then(() => 'resolved', (e) => `rejected: ${e.message}`),
        new Promise((r) => setTimeout(() => r('HUNG'), 3000)),
      ])
      assert.notEqual(outcome, 'HUNG', 'connect must settle (pre-fix it hung forever)')
      assert.match(outcome, /^rejected: /, 'connect must reject, not resolve')
      assert.match(outcome, /no passphrase given|Cannot parse privateKey/i)
      pool.close()
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A2: the same pool WITH the passphrase gets past key parsing (fails later at the network)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-i48-'))
  try {
    const pool = new SshPool(poolConfig({ privateKeyPath: writeKey(dir), passphrase: KEY_PASSPHRASE }))
    const err = await pool.connect().then(() => null, (e) => e)
    assert.ok(err, 'port 1 must fail')
    assert.doesNotMatch(String(err.message), /Cannot parse privateKey|no passphrase given/i)
    // The point is "it got PAST key parsing and failed at the NETWORK layer", not
    // one particular errno spelling: ssh2 reports a socket that dies during the
    // handshake as `Connection lost before handshake` on Windows, where the same
    // closed port yields ECONNREFUSED on Linux/macOS. Both mean the key was fine.
    assert.match(String(err.message), /ECONNREFUSED|timed out|timeout|connection lost before handshake/i)
    pool.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('A3: friendlyMessage explains the encrypted-key failure in actionable terms', () => {
  const msg = friendlyMessage(new Error('Cannot parse privateKey: Encrypted private OpenSSH key detected, but no passphrase given'), { host: 'h', port: 22 })
  assert.match(msg, /passphrase/)
  assert.match(msg, /私钥/)
})

// ── plugin harness (same shape as sshconfig-alias.test.js) ──────────────────

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1200, connectTimeoutMs: 800,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

function makeCtx() {
  const routes = new Map()
  const tools = new Map()
  const ctx = {
    effect: () => {},
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    get: (k) => (k === 'webServer' ? { register: (r) => { routes.set(r.path, r); return () => {} } } : undefined),
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes, tools }
}

async function call(routes, routePath, { method = 'POST', body = {} } = {}) {
  const route = routes.get(routePath)
  assert.ok(route, `route ${routePath} must be registered`)
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = routePath
  const res = {
    statusCode: 0, headers: {}, payload: '',
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(res.payload) } catch { /* not JSON */ }
  return { status: res.statusCode, json }
}

async function withPlugin(machines, fn) {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'dsh-remote-i48home-'))
  mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true })
  const dshHome = mkdtempSync(path.join(tmpdir(), 'dsh-remote-i48dsh-'))
  mkdirSync(path.join(dshHome, 'remote-workspaces'), { recursive: true })
  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE
  const savedDsh = process.env.DSH_HOME
  try {
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.DSH_HOME = dshHome
    if (machines) {
      writeFileSync(path.join(dshHome, 'remote-workspaces', 'machines.json'), JSON.stringify(machines, null, 2))
    }
    const mod = await import(`../lib/index.js?i48=${Math.random()}`)
    const { ctx, routes, tools } = makeCtx()
    await mod.apply(ctx, { ...CONFIG })
    return await fn({ routes, tools, fakeHome, dshHome, machinesFile: path.join(dshHome, 'remote-workspaces', 'machines.json') })
  } finally {
    for (const [k, v] of [['HOME', savedHome], ['USERPROFILE', savedProfile], ['DSH_HOME', savedDsh]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  }
}

const KEY_MACHINE = {
  id: 'm-key', name: 'encrypted-key-box', host: '192.0.2.7', port: 2222,
  username: 'ops', password: '', privateKeyPath: 'FIXTURE',
  passphrase: KEY_PASSPHRASE, workspace: '/home/ops',
}

// ── A. boot restore with a bad CURRENT machine must not take the host down ──

test('A4: boot-restore re-dialing a machine with a broken key fails quietly (the restart crash loop)', async () => {
  await withoutUnhandledRejections(async () => {
    await withPlugin(null, async ({ dshHome }) => {
      const keyDir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-i48key-'))
      try {
        const bad = { ...KEY_MACHINE, privateKeyPath: writeKey(keyDir), passphrase: '' }
        writeFileSync(path.join(dshHome, 'remote-workspaces', 'machines.json'), JSON.stringify({ list: [bad], currentId: 'm-key' }, null, 2))
        const mod = await import(`../lib/index.js?i48boot=${Math.random()}`)
        const { ctx } = makeCtx()
        // apply() itself resolves — the restore dial happens in a setImmediate.
        await mod.apply(ctx, { ...CONFIG })
        // Give the restore probe time to run and FAIL. Pre-fix this window is
        // where the unhandled rejection killed the host.
        await new Promise((r) => setTimeout(r, 600))
      } finally {
        rmSync(keyDir, { recursive: true, force: true })
      }
    })
  })
})

// ── C. rw_machines + rw_connect(machineId) ──────────────────────────────────

test('C1: rw_machines lists saved machines with auth flags and NO secret values', async () => {
  await withPlugin({ list: [{ ...KEY_MACHINE, password: 'hunter2' }], currentId: 'm-key' }, async ({ tools }) => {
    const list = tools.get('rw_machines')
    assert.ok(list, 'rw_machines must be registered')
    const out = (await list.execute({}, {})).text
    assert.match(out, /m-key/)
    assert.match(out, /encrypted-key-box/)
    assert.match(out, /ops@192\.0\.2\.7:2222/)
    assert.match(out, /\[CURRENT\]/)
    assert.match(out, /passphrase set/)
    assert.match(out, /password/)
    // Secrets are flags, never values.
    assert.ok(!out.includes(KEY_PASSPHRASE), 'passphrase value must never be listed')
    assert.ok(!out.includes('hunter2'), 'password value must never be listed')
  })
})

test('C2: rw_machines on an empty registry explains how to add one', async () => {
  await withPlugin(null, async ({ tools }) => {
    const out = (await tools.get('rw_machines').execute({}, {})).text
    assert.match(out, /No saved machines/)
  })
})

test('C3: rw_connect(machineId) adopts the stored machine wholesale and makes it current', async () => {
  await withPlugin({ list: [{ ...KEY_MACHINE, privateKeyPath: '' }], currentId: null }, async ({ routes, tools, machinesFile }) => {
    const connect = tools.get('rw_connect')
    // Dialing 192.0.2.7 times out fast here (connectTimeoutMs=800) — the point
    // is WHICH identity got applied, not the network outcome.
    await connect.execute({ machineId: 'm-key' }, {}).catch(() => {})
    const saved = JSON.parse(readFileSync(machinesFile, 'utf8'))
    assert.equal(saved.currentId, 'm-key', 'the named machine becomes current')
    const st = await call(routes, '/dsh-remote/status', { method: 'GET' })
    assert.equal(st.json.host, '192.0.2.7')
    assert.equal(st.json.port, 2222)
    assert.equal(st.json.username, 'ops')
  })
})

test('C4: rw_connect(machineId) with an unknown id fails with a pointer to rw_machines', async () => {
  await withPlugin({ list: [{ ...KEY_MACHINE }], currentId: null }, async ({ tools }) => {
    const err = await tools.get('rw_connect').execute({ machineId: 'm-nope' }, {}).then(() => null, (e) => e)
    assert.ok(err)
    assert.match(err.message, /m-nope/)
    assert.match(err.message, /rw_machines/)
  })
})

test('C5: rw_connect with neither host nor machineId explains both options', async () => {
  await withPlugin(null, async ({ tools }) => {
    const err = await tools.get('rw_connect').execute({}, {}).then(() => null, (e) => e)
    assert.ok(err, 'must fail')
    assert.match(err.message, /host is required/)
    assert.match(err.message, /machineId/)
  })
})

// ── B. the full field set + secret preservation on upsert ───────────────────

test('B1: rw_connect passes passphrase/useAgent/keyboardInteractive/hostKeyMode/name into the registry', async () => {
  await withPlugin(null, async ({ tools, machinesFile }) => {
    await tools.get('rw_connect').execute({
      host: '192.0.2.9', port: 22, username: 'ops',
      privateKeyPath: '/home/ops/.ssh/id', passphrase: 'pp',
      useAgent: true, keyboardInteractive: true, hostKeyMode: 'strict', name: 'my box',
    }, {}).catch(() => {})
    const rec = JSON.parse(readFileSync(machinesFile, 'utf8')).list[0]
    assert.equal(rec.passphrase, 'pp')
    assert.equal(rec.useAgent, true)
    assert.equal(rec.keyboardInteractive, true)
    assert.equal(rec.hostKeyMode, 'strict')
    assert.equal(rec.name, 'my box')
  })
})

test('B2: re-connecting WITHOUT a passphrase keeps the stored one (and never clobbers it with a default)', async () => {
  await withPlugin({ list: [{ ...KEY_MACHINE, privateKeyPath: '/k' }], currentId: 'm-key' }, async ({ tools, machinesFile }) => {
    // Same identity, only a new password — the agent "reconnects" the way it
    // always did. The stored passphrase must survive.
    await tools.get('rw_connect').execute({ host: '192.0.2.7', port: 2222, username: 'ops', password: 'newpw' }, {}).catch(() => {})
    const rec = JSON.parse(readFileSync(machinesFile, 'utf8')).list[0]
    assert.equal(rec.passphrase, KEY_PASSPHRASE, 'stored passphrase preserved')
    assert.equal(rec.password, 'newpw', 'supplied password updated')
    assert.equal(rec.useAgent, undefined, 'unsupplied booleans are not forced to false')
  })
})

// ── end-to-end through the test-connect route (pool + classification) ───────

test('B3: /test-connect with an encrypted key + no passphrase returns the friendly credentials error (no crash)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-i48tc-'))
  try {
    await withoutUnhandledRejections(async () => {
      await withPlugin(null, async ({ routes }) => {
        const r = await call(routes, '/dsh-remote/test-connect', {
          body: { host: '127.0.0.1', port: 1, username: 'x', privateKeyPath: writeKey(dir), passphrase: '' },
        })
        assert.equal(r.status, 200, 'probe failures are 200 + ok:false, never a crash')
        assert.equal(r.json.ok, false)
        assert.match(r.json.error, /passphrase/)
      })
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('B4: /test-connect with the passphrase gets PAST parsing to the network error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-i48tc-'))
  try {
    await withPlugin(null, async ({ routes }) => {
      const r = await call(routes, '/dsh-remote/test-connect', {
        body: { host: '127.0.0.1', port: 1, username: 'x', privateKeyPath: writeKey(dir), passphrase: KEY_PASSPHRASE },
      })
      assert.equal(r.status, 200)
      assert.equal(r.json.ok, false)
      assert.doesNotMatch(r.json.error, /passphrase|Cannot parse/i)
      assert.match(r.json.error, /拒绝|ECONNREFUSED|超时/i)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
