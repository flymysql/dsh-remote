// Issue #49 — the sidebar's remote-session mark.
//
// The Client half paints a green dot on a Session row and names the host in its
// hover card. It must NOT ask the host one question per row (a 40-row sidebar
// would issue 40 requests, and a row whose session the host no longer knows
// would go unmarked). Instead GET /dsh-remote/bindings returns the WHOLE local
// mirror registry once, and the client matches each row's own cwd against it.
//
// This file pins the host contract that makes that safe:
//   • every mirror with a usable meta is listed, with its recorded origin;
//   • a mirror whose meta is missing/unparsable or has no host is SKIPPED — the
//     same rule resolveMirror() applies host-side, because guessing a host would
//     label a session with a machine it is not bound to (worse than no badge);
//   • a mirror that resolves to a saved machine also carries that machine's
//     display name, so the UI can show the friendly name next to the address.
//
// The route reads the filesystem only: it must NOT consult the active machine,
// which is what keeps a saved-but-not-current machine from labelling a LOCAL
// session (issue #13's invariant, restated for this feature).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-bindings-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({
    list: [
      { id: 'm-linux', name: 'linuxbox', host: '10.0.0.1', port: 22, username: 'lucas', password: 'pw' },
      { id: 'm-other', name: 'otherbox', host: '10.0.0.9', port: 2222, username: 'root', password: 'pw' },
    ],
    // Deliberately NOT the machine that owns the single mirror below: the route
    // must ignore this field entirely.
    currentId: 'm-other',
  }))
  const mirror = (hostUserPort, base, meta) => {
    const dir = path.join(root, hostUserPort, base)
    mkdirSync(dir, { recursive: true })
    if (meta !== null) writeFileSync(path.join(dir, '.dsh-remote-meta.json'), typeof meta === 'string' ? meta : JSON.stringify(meta))
    return dir
  }
  return {
    home,
    linuxDir: mirror('10.0.0.1-lucas-22', 'proj', { host: '10.0.0.1', port: 22, username: 'lucas', remotePath: '/home/lucas/proj' }),
    otherDir: mirror('10.0.0.9-root-2222', 'srv', { host: '10.0.0.9', port: 2222, username: 'root', remotePath: '/srv/data' }),
    // Meta shapes that must be skipped rather than guessed at.
    noMeta: mirror('10.0.0.50-user-22', 'nometa', null),
    brokenMeta: mirror('10.0.0.51-user-22', 'broken', '{not json'),
    hostlessMeta: mirror('10.0.0.52-user-22', 'hostless', { remotePath: '/tmp/x' }),
  }
}

function makeCtx(sessions) {
  const routes = new Map()
  const ctx = {
    effect: () => {},
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    get: (k) => {
      if (k === 'webServer') return { register: (r) => { routes.set(r.path, r); return () => {} } }
      if (k === 'sessions') return sessions
      return undefined
    },
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
  const mod = await import(`../lib/index.js?bindings=${Math.random()}`)
  const { ctx, routes } = makeCtx(null)
  await mod.apply(ctx, { ...CONFIG })
  return { routes }
}

async function call(routes, routePath, { method = 'GET', url, body } = {}) {
  const route = routes.get(routePath)
  assert.ok(route, `route ${routePath} must be registered`)
  const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req = Readable.from([Buffer.from(payload)])
  req.method = method
  req.url = url || routePath
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
  return { status: res.statusCode, json, rejected, raw: res.payload }
}

const hostnames = (json) => (json.mirrors || []).map((m) => m.host).sort()

test('/bindings lists every usable mirror with its recorded origin', async () => {
  const { home } = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const r = await call(routes, '/dsh-remote/bindings')
    assert.equal(r.rejected, null)
    assert.equal(r.status, 200)
    // The three unusable metas are absent; the two real mirrors are present.
    assert.deepEqual(hostnames(r.json), ['10.0.0.1', '10.0.0.9'])
    const linux = r.json.mirrors.find((m) => m.host === '10.0.0.1')
    assert.equal(linux.port, 22)
    assert.equal(linux.username, 'lucas')
    assert.equal(linux.remotePath, '/home/lucas/proj')
    assert.ok(path.isAbsolute(linux.dir), `dir must be absolute, got ${linux.dir}`)
    // The saved machine's friendly name rides along for the tooltip.
    assert.equal(linux.name, 'linuxbox')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('a mirror whose meta is missing, unparsable, or hostless is skipped, never guessed', async () => {
  const { home } = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const r = await call(routes, '/dsh-remote/bindings')
    const hosts = hostnames(r.json)
    for (const skipped of ['10.0.0.50', '10.0.0.51', '10.0.0.52']) {
      assert.ok(!hosts.includes(skipped), `mirror without a usable host must not be listed: ${skipped}`)
    }
    // Every listed entry has a real host and a port, so the client can render a
    // target for it without defending against missing fields.
    for (const m of r.json.mirrors) {
      assert.ok(m.host, 'every listed mirror names a host')
      assert.ok(Number(m.port) > 0, 'every listed mirror has a port')
    }
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('the ACTIVE machine never leaks into the listing (issue #13 invariant)', async () => {
  const { home } = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    // The registry's current machine is 10.0.0.9 (otherbox), and one mirror
    // belongs to it. The response must be a pure function of the MIRRORS on
    // disk: removing that mirror drops it even though it is the current one.
    const before = await call(routes, '/dsh-remote/bindings')
    const other = before.json.mirrors.find((m) => m.host === '10.0.0.9')
    assert.ok(other, 'precondition: the second mirror is listed')
    rmSync(other.dir, { recursive: true, force: true })
    const after = await call(routes, '/dsh-remote/bindings')
    assert.deepEqual(hostnames(after.json), ['10.0.0.1'],
      'the listing follows the mirrors on disk, not the active-machine field')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('an empty registry is an empty list, not an error', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-bindings-empty-'))
  mkdirSync(path.join(home, 'remote-workspaces'), { recursive: true })
  try {
    const { routes } = await loadPlugin(home)
    const r = await call(routes, '/dsh-remote/bindings')
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.mirrors, [])
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('/bindings rejects a non-GET method', async () => {
  const { home } = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const r = await call(routes, '/dsh-remote/bindings', { method: 'POST', body: {} })
    assert.equal(r.status, 405)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})
