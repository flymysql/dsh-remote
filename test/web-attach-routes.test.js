// HTTP-surface tests for lib/routes-web-attach.js (the issue #82 split).
//
// The web-attach MECHANISM (startup-line parsing, launch, stop, pool-follow,
// reconnect re-resolve) is pinned exhaustively in web-attach.test.js against
// injected doubles; what sat UNTESTED inside the god-file was the HTTP
// orchestration around it: which machine a request targets, when a live tunnel
// is reused instead of leaking a second remote process, what lands in the audit
// log, and the exact failure shapes the deploy panel renders. Moving that
// surface into its own module put it under the 60% per-file coverage floor, so
// these tests drive the real factory with fake deps (registry array, attach
// map, per-identity pools). The single open-SUCCESS case attaches to an
// `existingUrl` and binds a REAL loopback listener — cheap and hermetic, no
// SSH — because skipping it would leave the set/audit/report tail uncovered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWebAttachRoutes } from '../lib/routes-web-attach.js'

/**
 * A full fake neighbourhood for the route factory. Records what the handler
 * sent (`sent`), what it audited (`audits`) and which pools were resolved
 * (`pools`), so each test asserts the orchestration, not the mechanics.
 */
function makeWorld(over = {}) {
  const sent = []
  const audits = []
  const webAttaches = over.webAttaches || new Map()
  const machines = over.machines || [{ id: 'm1', host: 'box.example.com', port: 22, username: 'u' }]
  const store = { currentId: 'currentId' in over ? over.currentId : 'm1' }
  const pools = []
  const routes = createWebAttachRoutes({
    sendJson: (res, status, body) => { sent.push({ status, body }) },
    readBody: async () => (over.rawBody !== undefined ? over.rawBody : '{}'),
    parseJsonObject: (raw) => {
      const parsed = JSON.parse(raw || '{}')
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const err = new Error('请求体必须是一个 JSON 对象')
        err.httpStatus = 400
        throw err
      }
      return parsed
    },
    config: { webAttachPortStart: 24488, webAttachDshHome: '', webAttachWaitSeconds: 5 },
    webAttaches,
    store,
    machines,
    poolForMachine: (identity) => {
      const p = over.makePool
        ? over.makePool(identity)
        : { connect: async () => ({}), exec: async () => ({ stdout: '', code: 0 }) }
      pools.push(p)
      return p
    },
    identityOf: (m) => ({ host: m.host, port: Number(m.port) || 22, username: m.username || '' }),
    webAttachCommandFor: () => 'dsh',
    audit: (...args) => audits.push(args),
  })
  assert.equal(routes.length, 1, 'the factory mounts exactly one route')
  assert.equal(routes[0].path, '/dsh-remote/web-attach')
  return { route: routes[0], sent, audits, webAttaches, machines, store, pools }
}

/** Invoke the handler and return the single JSON response it sent. */
async function call(world, { method = 'POST', url = '/dsh-remote/web-attach' } = {}) {
  await world.route.handler({ method, url, headers: {} }, {})
  assert.equal(world.sent.length, 1, 'the handler must answer exactly once')
  return world.sent[0]
}

// ── GET status ─────────────────────────────────────────────────────────────

test('GET without machineId describes every live attach (empty map → empty list)', async () => {
  const world = makeWorld()
  const r = await call(world, { method: 'GET' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, attach: null, attaches: [] })
})

test('GET with machineId describes that attach, and lists all of them', async () => {
  const webAttaches = new Map([
    ['m1', { describe: () => ({ machineId: 'm1', localPort: 3001 }) }],
    ['m2', { describe: () => ({ machineId: 'm2', localPort: 3002 }) }],
  ])
  const world = makeWorld({ webAttaches })
  const r = await call(world, { method: 'GET', url: '/dsh-remote/web-attach?machineId=m1' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.attach, { machineId: 'm1', localPort: 3001 })
  assert.deepEqual(r.body.attaches, [{ machineId: 'm1', localPort: 3001 }, { machineId: 'm2', localPort: 3002 }])
})

// ── method + targeting guards ───────────────────────────────────────────────

test('a method that is neither GET nor POST is a 405', async () => {
  const world = makeWorld()
  const r = await call(world, { method: 'DELETE' })
  assert.equal(r.status, 405)
  assert.match(String(r.body.error), /method not allowed/)
})

test('a POST with no machineId anywhere is refused before touching anything', async () => {
  const world = makeWorld({ currentId: '' })
  const r = await call(world, { method: 'POST' })
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /machineId/)
  assert.equal(world.pools.length, 0, 'no pool may be resolved for an untargeted request')
})

test('an unknown action is a readable 400', async () => {
  const world = makeWorld()
  const r = await call(world, { method: 'POST' })
  // `{}` → action '' → falls through to the action guard.
  assert.equal(r.status, 400)
  assert.match(String(r.body.error), /open \| close/)
})

// ── open: reuse, stale teardown, unknown machine ────────────────────────────

test('open reuses a live tunnel instead of starting a second remote process', async () => {
  const webAttaches = new Map([['m1', { active: true, describe: () => ({ machineId: 'm1', localPort: 3001 }) }]])
  const world = makeWorld({ webAttaches, rawBody: JSON.stringify({ action: 'open' }) })
  const r = await call(world)
  assert.equal(r.status, 200)
  assert.equal(r.body.reused, true)
  assert.deepEqual(r.body.attach, { machineId: 'm1', localPort: 3001 })
  assert.equal(world.pools.length, 0, 'a reused tunnel resolves no pool and boots nothing')
  assert.equal(world.audits.length, 0, 'a no-op reuse has nothing to audit')
})

test('open tears down a dead tunnel before dialling, then 404s an unknown machine', async () => {
  let closed = 0
  const webAttaches = new Map([['ghost', { active: false, close: async () => { closed++ } }]])
  const world = makeWorld({ webAttaches, rawBody: JSON.stringify({ action: 'open', machineId: 'ghost' }) })
  const r = await call(world)
  assert.equal(closed, 1, 'the stale tunnel must be released before the fresh session')
  assert.equal(r.status, 404)
  assert.match(String(r.body.error), /ghost/)
})

// ── open: failure and success tails ─────────────────────────────────────────

test('an open that throws answers 500, audits the failure, and stores nothing', async () => {
  const world = makeWorld({
    rawBody: JSON.stringify({ action: 'open', machineId: 'm1' }),
    makePool: () => ({
      connect: async () => ({}),
      exec: async () => { throw new Error('dial exploded') },
    }),
  })
  const r = await call(world)
  assert.equal(r.status, 500)
  assert.match(String(r.body.error), /dial exploded/)
  assert.equal(world.webAttaches.has('m1'), false, 'a failed open must not be registered as live')
  assert.equal(world.audits.length, 1)
  assert.equal(world.audits[0][0], 'web-attach')
  assert.match(String(world.audits[0][1]), /failed/)
  assert.equal(world.audits[0][2], 1, 'the failure is audited with a non-zero code')
})

test('open onto an existingUrl binds a loopback listener and reports it', async (t) => {
  const world = makeWorld({
    rawBody: JSON.stringify({ action: 'open', machineId: 'm1', existingUrl: 'http://127.0.0.1:3999/?token=t0ken' }),
  })
  const r = await call(world)
  // The listener is real: whatever happens, it must not outlive the test.
  t.after(async () => {
    const live = world.webAttaches.get('m1')
    if (live) await live.close()
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.attach.localPort, 24488)
  assert.equal(r.body.attach.remotePort, 3999)
  assert.equal(r.body.attach.managed, false, 'attaching to the user’s own instance is hands-off')
  assert.equal(world.webAttaches.get('m1') && world.webAttaches.get('m1').active, true)
  assert.deepEqual(world.audits.map((a) => a[2]), [0], 'the success is audited with code 0')
})

// ── close ───────────────────────────────────────────────────────────────────

test('close without a live tunnel says so, without claiming success', async () => {
  const world = makeWorld({ rawBody: JSON.stringify({ action: 'close', machineId: 'nobody' }) })
  const r = await call(world)
  assert.equal(r.status, 200)
  assert.equal(r.body.closed, false)
})

test('close releases the tunnel, audits it, and only claims stoppedRemote for a managed pid', async () => {
  const calls = []
  const webAttaches = new Map([['m1', {
    cleanUrl: 'http://127.0.0.1:24488/',
    remotePid: 777,
    close: async (opts) => { calls.push(opts) },
  }]])
  const world = makeWorld({ webAttaches, rawBody: JSON.stringify({ action: 'close', machineId: 'm1', stopRemote: true }) })
  const r = await call(world)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, closed: true, stoppedRemote: true })
  assert.equal(webAttaches.has('m1'), false, 'the closed tunnel leaves the registry')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].stopRemote, true)
  // The route hands close() an exec bound to THAT machine's pool — prove the
  // wiring by running it once.
  const out = await calls[0].exec('true')
  assert.deepEqual(out, { stdout: '', code: 0 })
  assert.equal(world.pools.length, 1)
  assert.equal(world.audits.length, 1)
  assert.match(String(world.audits[0][1]), /remote stopped/)
})

test('close with stopRemote on an unmanaged attach reports stoppedRemote:false', async () => {
  const webAttaches = new Map([['m1', { cleanUrl: 'http://127.0.0.1:24488/', remotePid: 0, close: async () => {} }]])
  const world = makeWorld({ webAttaches, rawBody: JSON.stringify({ action: 'close', machineId: 'm1', stopRemote: true }) })
  const r = await call(world)
  assert.equal(r.body.stoppedRemote, false, 'no recorded PID → nothing was signalled')
})

// ── the handler never rejects ───────────────────────────────────────────────

test('a malformed JSON body surfaces as a 500 JSON reason (outer catch), never a rejection', async () => {
  const world = makeWorld({ rawBody: '{"machineId": ' })
  const r = await call(world, { method: 'POST' })
  assert.equal(r.status, 500)
  assert.equal(r.body.ok, false)
  assert.ok(String(r.body.error).length > 0)
})
