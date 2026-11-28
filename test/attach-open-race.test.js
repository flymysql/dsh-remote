// The web-attach OPEN race: two concurrent POSTs for ONE machine.
//
// Verified with real loopback sockets against main 984053c: two `open`
// actions for the same machine both answered 200. The live-check in the
// open branch ran BEFORE the multi-second `await attach.open()`, so both
// requests saw "no live tunnel" and both proceeded; `webAttaches.set`
// (routes-web-attach.js) then overwrote the map entry, and the LOSER's
// local listener stayed bound but invisible — status listed only the
// winner, close only touched the map entry, the loser's pool hooks kept
// firing on every reconnect, and on the launch path an extra remote
// `dsh web` kept running that nothing could stop (the unload sweeper in
// main.js iterates map values, so it could never reach the loser either).
//
// This continues the web-attach lifecycle line: #54 (stale client), #125
// (discovery), #204 (self-reconnect) — those fixes made ONE session survive
// its connection; this one makes one MACHINE hold one session even when the
// UI fires two opens at once.
//
// What must hold once open is serialized per machineId (an in-flight
// promise map in the route factory):
//   • two concurrent opens end with exactly ONE listening local port, one
//     map entry, and ONE success audit line
//   • the second answer REUSES the first's session instead of describing a
//     second one
//   • after close NO local port still accepts — the stranded-listener leak
//     is the regression this file exists for
//   • the stale close-before-reopen is kept but runs ONCE, not once per
//     racing request
//   • a second open proceeds FRESH when the in-flight one failed — the
//     gate must not turn one failure into two
//
// The double-open drives the real route factory with a REAL node:net
// listener (no net double): the existingUrl path makes open() await only
// `pool.connect()` before binding, so a pool whose connect() answers on
// the next macrotask parks both handlers inside the exact window the
// unserialized code raced in — deterministically, with no sleeps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createWebAttachRoutes } from '../lib/routes-web-attach.js'

const localPort = () => 24000 + Math.floor(Math.random() * 20000)

/** True when 127.0.0.1:port still accepts a TCP connection. */
function portAccepts(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { try { socket.destroy() } catch { /* probe done */ } resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

/** Which of the candidate ports still accept, in the order given. */
async function acceptingPorts(ports) {
  const out = []
  for (const port of ports) if (await portAccepts(port)) out.push(port)
  return out
}

/** A client double whose forwardOut refuses every channel: probing the
 *  tunnel's port must not arm the issue #204 reconnect machinery. */
const refusingClient = {
  on() { /* not an ssh2 client; nothing to watch */ },
  forwardOut(host, sport, rhost, rport, cb) { cb(new Error('probe only')) },
}

/** The fake neighbourhood (same shape as web-attach-routes.test.js), with
 *  a pool whose connect() answers on the NEXT macrotask — the deferred
 *  dial that opens the race window for both requests at once. */
function makeWorld(over = {}) {
  const sent = []
  const audits = []
  const webAttaches = over.webAttaches || new Map()
  const portStart = over.portStart || localPort()
  const pool = over.pool || {
    connect: async () => {
      await new Promise((resolve) => setImmediate(resolve))
      return refusingClient
    },
    exec: async () => ({ stdout: '', code: 0 }),
  }
  const routes = createWebAttachRoutes({
    sendJson: (res, status, body) => { sent.push({ status, body }) },
    readBody: async () => over.rawBody,
    parseJsonObject: (raw) => JSON.parse(raw || '{}'),
    config: { webAttachPortStart: portStart, webAttachDshHome: '', webAttachWaitSeconds: 5 },
    webAttaches,
    store: { currentId: 'm1' },
    machines: [{ id: 'm1', host: 'box.example.com', port: 22, username: 'u' }],
    poolForMachine: () => pool,
    identityOf: (m) => ({ host: m.host, port: 22, username: m.username || '' }),
    webAttachCommandFor: () => 'dsh',
    webAttachDiscoverCommandFor: () => '',
    audit: (...args) => audits.push(args),
  })
  return { route: routes[0], sent, audits, webAttaches, pool, portStart }
}

/** Fire two POST opens concurrently — both handlers must be on the wire at
 *  the same time, which the one-response `call` helper of the routes
 *  suite cannot express. */
function doubleOpen(world) {
  const post = () => world.route.handler({ method: 'POST', url: '/dsh-remote/web-attach', headers: {} }, {})
  return Promise.all([post(), post()])
}

test('two concurrent opens for one machine end with ONE listener and a reused second answer', async (t) => {
  const world = makeWorld({ rawBody: JSON.stringify({ action: 'open', machineId: 'm1', existingUrl: 'http://127.0.0.1:3999/?token=t0ken' }) })
  t.after(async () => { const live = world.webAttaches.get('m1'); if (live) await live.close() })

  await doubleOpen(world)

  // Both requests are answered, both 200 — the panel renders one of them.
  assert.equal(world.sent.length, 2)
  assert.equal(world.sent[0].status, 200)
  assert.equal(world.sent[1].status, 200)
  // One machine, one session: the registry is the ONLY handle status, close
  // and the unload sweeper have, so a second listener must never exist.
  assert.equal(world.webAttaches.size, 1, 'one machine holds one attach session')
  const winner = world.webAttaches.get('m1')
  assert.equal(winner.active, true)
  // Exactly ONE listening local port, and it is the one the registry names.
  assert.deepEqual(
    await acceptingPorts([world.portStart, world.portStart + 1]),
    [winner.localPort],
    "the loser's listener must not stay bound behind the registry's back",
  )
  // The second answer reuses the first's session instead of describing a
  // second one (the unfixed code answered with a fresh attach).
  const reused = world.sent.filter((r) => r.body.reused === true)
  assert.equal(reused.length, 1, 'exactly one of the two answers is a reuse')
  assert.equal(reused[0].body.attach.localPort, winner.localPort)
  // And ONE open actually happened: one success audit line, not two.
  assert.equal(world.audits.filter((a) => a[2] === 0).length, 1)
  // After close NOTHING accepts on the whole candidate range — the
  // stranded listener is the leak this regression exists for.
  await winner.close()
  assert.deepEqual(await acceptingPorts([world.portStart, world.portStart + 1]), [])
})

test('a racing pair releases a stale entry ONCE before the fresh open (close-before-reopen kept, not doubled)', async (t) => {
  let closed = 0
  const world = makeWorld({
    webAttaches: new Map([['m1', { active: false, close: async () => { closed += 1 } }]]),
    rawBody: JSON.stringify({ action: 'open', machineId: 'm1', existingUrl: 'http://127.0.0.1:3999/?token=t0ken' }),
  })
  t.after(async () => { const live = world.webAttaches.get('m1'); if (live) await live.close() })

  await doubleOpen(world)

  assert.equal(closed, 1, 'the stale session is released once, by the one request that runs the open')
  assert.equal(world.webAttaches.size, 1)
  const winner = world.webAttaches.get('m1')
  assert.equal(winner.active, true)
  assert.deepEqual(await acceptingPorts([world.portStart, world.portStart + 1]), [winner.localPort])
  await winner.close()
  assert.deepEqual(await acceptingPorts([world.portStart, world.portStart + 1]), [])
})

test('a second open proceeds FRESH when the in-flight open failed', async (t) => {
  let dials = 0
  const world = makeWorld({
    pool: {
      connect: async () => {
        dials += 1
        await new Promise((resolve) => setImmediate(resolve))
        if (dials === 1) throw new Error('dial exploded')
        return refusingClient
      },
      exec: async () => ({ stdout: '', code: 0 }),
    },
    rawBody: JSON.stringify({ action: 'open', machineId: 'm1', existingUrl: 'http://127.0.0.1:3999/?token=t0ken' }),
  })
  t.after(async () => { const live = world.webAttaches.get('m1'); if (live) await live.close() })

  await doubleOpen(world)

  // The failed open answers 500 on its own response; the other still gets
  // its tunnel — waiting behind a failure must not fail the follower.
  assert.deepEqual(world.sent.map((r) => r.status).sort(), [200, 500])
  const fail = world.sent.find((r) => r.status === 500)
  assert.match(String(fail.body.error), /dial exploded/)
  assert.equal(world.webAttaches.size, 1)
  const winner = world.webAttaches.get('m1')
  assert.equal(winner.active, true)
  assert.deepEqual(await acceptingPorts([world.portStart, world.portStart + 1]), [winner.localPort])
  // One failure audit, one success audit — the follower really ran.
  assert.deepEqual(world.audits.map((a) => a[2]).sort(), [0, 1])
  await winner.close()
  assert.deepEqual(await acceptingPorts([world.portStart, world.portStart + 1]), [])
})
