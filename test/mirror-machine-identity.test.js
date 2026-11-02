// Regression: a machine-scoped picker commit must not land on a machine that
// another actor switched to while the picker was open.
//
// The workspace picker acts on the shared ACTIVE pool but remembers its own
// `machineId`. Before PR #42 it re-posted /current before every /ls, which
// incidentally kept the active pool pinned to the picker's machine; the
// per-keystroke reconnect fix (issue #41) removed that accident. With the
// client cache a cache-hit re-type issues NO host request at all, so nothing
// re-applied the picker's machine before its commit — and /mirror carried no
// identity, so it used whatever machine happened to be active. Reproduced
// against a real host: the picker displayed machine A's tree and the mirror was
// created with machine B's identity.
//
// The contract: /mirror (and /home) accept an optional `machineId` naming the
// machine the caller is showing, and the host re-asserts it before acting.
//   • named machine → re-applied (the commit lands on the intended identity)
//   • unknown id    → refused (404), never a silent fall back to the active one
//   • absent id     → unchanged machine-scoped behaviour (active pool)
//
// The route ordering is what makes this testable without SSH: the identity
// re-assertion happens BEFORE the directory probe, so a failing probe still
// proves which machine the request was bound to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const M1 = { id: 'm1', name: 'one', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw1' }
const M2 = { id: 'm2', name: 'two', host: '127.0.0.22', port: 1, username: 'root', password: 'pw2' }

function makeHome(currentId) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-ident-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: [M1, M2], currentId }))
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
  // A truthy host is what /mirror requires before it does anything else; it is
  // the active machine's identity and is expected to be re-pointed by the
  // routes below.
  host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw1', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

async function loadPlugin(home) {
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?ident=${Math.random()}`)
  const { ctx, routes } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  return { routes }
}

async function call(routes, pathname, body, method = 'POST') {
  const route = routes.get(pathname)
  assert.ok(route, `route ${pathname} must be registered`)
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))])
  req.method = method
  req.url = pathname
  const res = {
    statusCode: 0,
    payload: '',
    setHeader() {},
    end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.payload || 'null') }
}

const status = (routes) => call(routes, '/dsh-remote/status', {}, 'GET')

const cleanup = (home) => { delete process.env.DSH_HOME; rmSync(home, { recursive: true, force: true }) }

test('/mirror re-asserts the machine the picker names, undoing an external switch', async () => {
  const home = makeHome('m1')
  try {
    const { routes } = await loadPlugin(home)

    // Another actor (settings page / rw_connect in another session) switches the
    // active machine while the picker is still showing m1's tree.
    const sw = await call(routes, '/dsh-remote/current', { id: 'm2' })
    assert.equal(sw.status, 200)
    const switched = await status(routes)
    assert.equal(switched.json.currentId, 'm2', 'precondition: the active machine really moved')

    // The picker commits a path it browsed on m1. The directory probe fails
    // (port 1), which is fine — the identity binding happens first.
    const r = await call(routes, '/dsh-remote/mirror', { path: '/proj', machineId: 'm1' })
    assert.equal(r.status, 400, 'the unreachable host must fail the directory probe')

    const after = await status(routes)
    assert.equal(after.json.currentId, 'm1', 'the named machine must win over the externally switched one')
    assert.equal(after.json.host, '127.0.0.11', 'the pool must be re-pointed at the named machine')
  } finally { cleanup(home) }
})

test('/mirror with an UNKNOWN machine id is refused and never falls back to the active machine', async () => {
  const home = makeHome('m1')
  try {
    const { routes } = await loadPlugin(home)
    const r = await call(routes, '/dsh-remote/mirror', { path: '/proj', machineId: 'does-not-exist' })
    assert.equal(r.status, 404, 'an unknown machine must be refused, not silently ignored')
    assert.equal(r.json.ok, false)
    const after = await status(routes)
    assert.equal(after.json.currentId, 'm1', 'a refused commit must not change the active machine')
  } finally { cleanup(home) }
})

test('/mirror without a machine id keeps the machine-scoped active-pool behaviour', async () => {
  const home = makeHome('m1')
  try {
    const { routes } = await loadPlugin(home)
    // No machineId: the request is machine-scoped through the active pool, as
    // generated by every pre-PR client and the settings page's workspace flow.
    // The probe still runs (and fails on port 1) — that is the observable proof
    // it was NOT refused by the new identity check.
    const r = await call(routes, '/dsh-remote/mirror', { path: '/proj' })
    assert.equal(r.status, 400, 'the request must reach the directory probe')
    assert.match(String(r.json.error || ''), /not a directory|unreachable/)
  } finally { cleanup(home) }
})

test('/home re-asserts the named machine too', async () => {
  const home = makeHome('m1')
  try {
    const { routes } = await loadPlugin(home)
    await call(routes, '/dsh-remote/current', { id: 'm2' })
    const r = await call(routes, '/dsh-remote/home', { machineId: 'm1' })
    // The exec fails (unreachable), and /home answers 200 with a null home.
    assert.equal(r.status, 200)
    const after = await status(routes)
    assert.equal(after.json.currentId, 'm1', '/home must bind to the machine it was told to describe')
  } finally { cleanup(home) }
})

// ── client half: the picker must actually SEND its machine identity ─────────

const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('the picker sends machineId on /mirror and /home', () => {
  const bodyOf = (name) => {
    const start = clientSrc.indexOf('const ' + name + ' = ')
    assert.ok(start >= 0, `lib/client.js must define const ${name}`)
    // Slice to the next sibling `const … =` inside DirPicker.
    const rest = clientSrc.slice(start + 1)
    const next = rest.search(/\n      const \w+ = /)
    return clientSrc.slice(start, next > 0 ? start + 1 + next : start + 1400)
  }
  const mirror = bodyOf('commitPath')
  assert.match(mirror, /api\('POST', '\/dsh-remote\/mirror', \{ path: target, machineId[^}]*\}\)/,
    'commitPath must name the machine the pick was made on')
  // The same commit also tells the host whether the core will adopt the mirror
  // as a workspace (the native Add-workspace flow) or the picker only chose a
  // folder (settings / Remote Files); the host uses it to decide whether to
  // pre-register a host-qualified workspace title.
  assert.match(mirror, /registerWorkspace: registerWorkspace !== false/,
    'commitPath must forward the picker\'s workspace-registration intent')
  const home = bodyOf('pickHome')
  assert.match(home, /api\('POST', '\/dsh-remote\/home', \{ machineId \}\)/,
    'pickHome must name the machine it is describing')
})
