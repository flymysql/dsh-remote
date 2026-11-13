// Issue #54 (second half) — the per-machine remote-dsh command must be
// settable from the settings UI, not only by the deploy flow.
//
// The gap reported alongside the crash: README (README.md:121, README.en.md:134)
// tells the user "when the remote `dsh` is not on the SSH login PATH, point
// `webAttachCommand` at its absolute path" — and the settings page had no field
// for it. Grepping lib/client.js for `webAttachCommand` returned ZERO hits, so
// the only ways to set it were (a) finish a successful "deploy & verify", or
// (b) hand-edit $DSH_HOME/remote-workspaces/machines.json. The README never said
// which, so the instruction was unfollowable as written.
//
// These tests drive the REAL registered route with HOME/DSH_HOME pointed at a
// scratch directory, and assert the value round-trips through machines.json —
// the same contract the ssh-config-alias tests use for other machine fields.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
  try { json = JSON.parse(res.payload) } catch { /* non-JSON bodies are fine */ }
  return { status: res.statusCode, json, text: res.payload }
}

/** Run `fn` with HOME/DSH_HOME in scratch dirs and the plugin freshly applied. */
async function withPlugin(machines, fn) {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'i54-home-'))
  const dshHome = mkdtempSync(path.join(tmpdir(), 'i54-dsh-'))
  mkdirSync(path.join(dshHome, 'remote-workspaces'), { recursive: true })
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DSH_HOME: process.env.DSH_HOME }
  try {
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    process.env.DSH_HOME = dshHome
    const machinesFile = path.join(dshHome, 'remote-workspaces', 'machines.json')
    if (machines) writeFileSync(machinesFile, JSON.stringify(machines, null, 2))
    const mod = await import(`../lib/index.js?issue54=${Math.random()}`)
    const { ctx, routes } = makeCtx()
    await mod.apply(ctx, { ...CONFIG })
    return await fn({ routes, machinesFile })
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  }
}

test('a machine saved from the settings UI keeps its webAttachCommand', async () => {
  await withPlugin(null, async ({ routes, machinesFile }) => {
    const saved = '/home/dev/.nvm/versions/node/v22.19.0/bin/node /home/dev/.dsh-remote/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    const { status, json } = await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', name: 'devbox', host: '10.0.0.5', username: 'dev', webAttachCommand: saved },
    })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    const rec = JSON.parse(readFileSync(machinesFile, 'utf8')).list.find((m) => m.host === '10.0.0.5')
    assert.ok(rec, 'the machine must be persisted')
    assert.equal(rec.webAttachCommand, saved, 'the command must survive the round trip')
  })
})

test('the saved command is exposed to the settings UI on the next read', async () => {
  const saved = '/usr/local/bin/node /opt/dsh/lib/bin.js'
  await withPlugin({ list: [{ id: 'm1', name: 'devbox', host: '10.0.0.5', port: 22, username: 'dev', webAttachCommand: saved }], currentId: '' }, async ({ routes }) => {
    const { status, json } = await call(routes, '/dsh-remote/machines', { method: 'GET' })
    assert.equal(status, 200)
    // The UI reads this field to populate the input, so a whitelist that drops
    // it would silently blank the box on every edit.
    assert.equal(json.machines[0].webAttachCommand, saved)
  })
})

test('editing another field does not wipe the stored command', async () => {
  const saved = '/usr/local/bin/node /opt/dsh/lib/bin.js'
  await withPlugin({ list: [{ id: 'm1', name: 'devbox', host: '10.0.0.5', port: 22, username: 'dev', webAttachCommand: saved }], currentId: '' }, async ({ routes, machinesFile }) => {
    // A form that omits the field (an older browser half, or a client that
    // never touched it) must not erase it — the deploy flow writes this value
    // and losing it silently points every later attach back at PATH `dsh`.
    const { status } = await call(routes, '/dsh-remote/machines', {
      body: { action: 'update', id: 'm1', name: 'renamed', host: '10.0.0.5', username: 'dev' },
    })
    assert.equal(status, 200)
    const rec = JSON.parse(readFileSync(machinesFile, 'utf8')).list.find((m) => m.id === 'm1')
    assert.equal(rec.name, 'renamed', 'the edit itself applied')
    assert.equal(rec.webAttachCommand, saved, 'an omitted field must be preserved')
  })
})

test('clearing the field falls back to the global command (empty, not stale)', async () => {
  const saved = '/usr/local/bin/node /opt/dsh/lib/bin.js'
  await withPlugin({ list: [{ id: 'm1', name: 'devbox', host: '10.0.0.5', port: 22, username: 'dev', webAttachCommand: saved }], currentId: '' }, async ({ routes, machinesFile }) => {
    const { status } = await call(routes, '/dsh-remote/machines', {
      body: { action: 'update', id: 'm1', name: 'devbox', host: '10.0.0.5', username: 'dev', webAttachCommand: '' },
    })
    assert.equal(status, 200)
    const rec = JSON.parse(readFileSync(machinesFile, 'utf8')).list.find((m) => m.id === 'm1')
    // `webAttachCommandFor()` treats '' as "use config.webAttachCommand", so an
    // explicit clear is a real, honoured choice.
    assert.equal(rec.webAttachCommand, '')
  })
})

test('a machine that never had one saves as empty rather than undefined', async () => {
  await withPlugin(null, async ({ routes, machinesFile }) => {
    await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', name: 'plain', host: '10.0.0.9', username: 'root' },
    })
    const rec = JSON.parse(readFileSync(machinesFile, 'utf8')).list.find((m) => m.host === '10.0.0.9')
    assert.equal(rec.webAttachCommand, '')
  })
})

test('surrounding whitespace is trimmed, so a pasted path cannot break the launch', async () => {
  await withPlugin(null, async ({ routes, machinesFile }) => {
    await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', name: 'ws', host: '10.0.0.7', username: 'dev', webAttachCommand: '  /usr/bin/node /opt/dsh/bin.js  ' },
    })
    const rec = JSON.parse(readFileSync(machinesFile, 'utf8')).list.find((m) => m.host === '10.0.0.7')
    // The value is interpolated into a shell command line
    // (`$SET nohup <command> --profile …`), so a trailing newline or leading
    // space is not cosmetic — it changes what the remote shell runs.
    assert.equal(rec.webAttachCommand, '/usr/bin/node /opt/dsh/bin.js')
  })
})

// Issue #125: the discover command is a sibling machine field, with the same
// persistence and merge semantics as webAttachCommand.
test('issue125: a discover command round-trips through the real registry and settings read', async () => {
  const saved = 'cat "$HOME/.dsh-web-url" 2>/dev/null'
  await withPlugin({ list: [{ id: 'm1', name: 'devbox', host: '10.0.0.5', port: 22, username: 'dev', webAttachDiscoverCommand: saved }], currentId: '' }, async ({ routes, machinesFile }) => {
    const listed = await call(routes, '/dsh-remote/machines', { method: 'GET' })
    assert.equal(listed.json.machines[0].webAttachDiscoverCommand, saved)

    await call(routes, '/dsh-remote/machines', {
      body: { action: 'update', id: 'm1', name: 'renamed', host: '10.0.0.5', username: 'dev' },
    })
    const kept = JSON.parse(readFileSync(machinesFile, 'utf8')).list.find((m) => m.id === 'm1')
    assert.equal(kept.webAttachDiscoverCommand, saved, 'an omitted discover field must not wipe it')

    await call(routes, '/dsh-remote/machines', {
      body: { action: 'update', id: 'm1', name: 'renamed', host: '10.0.0.5', username: 'dev', webAttachDiscoverCommand: '' },
    })
    const cleared = JSON.parse(readFileSync(machinesFile, 'utf8')).list.find((m) => m.id === 'm1')
    assert.equal(cleared.webAttachDiscoverCommand, '', 'an explicit empty value really disables discovery')
  })
})

test('issue125: a new machine without discovery persists an empty command and trims supplied values', async () => {
  await withPlugin(null, async ({ routes, machinesFile }) => {
    await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', name: 'plain', host: '10.0.0.9', username: 'root' },
    })
    await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', name: 'discover', host: '10.0.0.10', username: 'root', webAttachDiscoverCommand: '  cat /tmp/url  ' },
    })
    const list = JSON.parse(readFileSync(machinesFile, 'utf8')).list
    assert.equal(list.find((m) => m.host === '10.0.0.9').webAttachDiscoverCommand, '')
    assert.equal(list.find((m) => m.host === '10.0.0.10').webAttachDiscoverCommand, 'cat /tmp/url')
  })
})
