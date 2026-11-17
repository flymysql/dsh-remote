// Port forwarding: the route's lifecycle and its FAILURE branches.
//
// `forwards.js` was at ~64% coverage and only the happy path was ever exercised
// (the tools matrix proves a tunnel carries bytes). What a user actually hits is
// the rest of the lifecycle: the listen port is already taken, the target refuses
// the connection, a forward is started twice, stopped when it is not running, or
// removed while running (the listener must not leak). A leaked listener is
// invisible until the user tries to bind that port again — hours later.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'
import { ForwardManager } from '../lib/forwards.js'

/**
 * A free TCP port (also used to occupy one deliberately).
 *
 * Bind-then-close is inherently racy: test files run in parallel, so another process
 * can take the port between the close and the forward's own bind. That produced two
 * one-off red runs out of ~8 (all six tests here failing at once because the shared
 * helper threw). Tests that need the bind to SUCCEED use `startOnFreePort`.
 */
async function freePort() {
  const srv = net.createServer()
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  await new Promise((resolve) => srv.close(resolve))
  return port
}

/** Define + start a local forward, retrying on a fresh port if the port was taken. */
async function startOnFreePort(host, post, targetPort, attempts = 3) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    const listenPort = await freePort()
    const defined = await post(host, { action: 'define', listenPort, targetHost: '127.0.0.1', targetPort })
    const fwd = defined.json.forward
    const started = await post(host, { action: 'start', id: fwd.id })
    if (started.json.ok) return { listenPort, fwd, started }
    last = started
    if (!/EADDRINUSE|in use|占用/i.test(String(started.json.error))) break
    await post(host, { action: 'remove', id: fwd.id })
  }
  return { listenPort: null, fwd: null, started: last }
}

async function echoServer() {
  const srv = net.createServer((socket) => { socket.pipe(socket) })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  return { port: srv.address().port, close: () => new Promise((resolve) => srv.close(resolve)) }
}

async function withForwards(fn) {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/home/user' })
  const rec = machine({ host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw' })
  const host = await createHost({ machines: [rec] })
  try {
    const cur = await host.call('/dsh-remote/current', { body: { id: rec.id } })
    assert.equal(cur.json.ok, true, `binding failed: ${cur.raw}`)
    await fn({ host, srv })
  } finally {
    await host.dispose()
    await srv.close()
  }
}

const post = (host, body) => host.call('/dsh-remote/forwards', { body })

test('a forward runs through the route lifecycle: define → start → list → stop → remove', async () => {
  const echo = await echoServer()
  try {
    await withForwards(async ({ host }) => {
      // A bind-then-close port can be stolen by a parallel test file between the
      // close and the forward's own bind; the helper retries on a fresh port when
      // that happens, and the assertions below stay strict.
      const started0 = await startOnFreePort(host, post, echo.port)
      assert.equal(started0.started.json.ok, true, `start failed: ${started0.started.raw}`)
      const listenPort = started0.listenPort
      const fwd = started0.fwd
      assert.equal(fwd.listenPort, listenPort)
      assert.equal(fwd.targetPort, echo.port)
      assert.equal(started0.started.json.forwards.find((f) => f.id === fwd.id).active, true,
        'a successful start must report the forward as active')

      const started = started0.started
      assert.equal(started.json.forwards.find((f) => f.id === fwd.id).active, true)

      const listed = await host.call('/dsh-remote/forwards', { method: 'GET' })
      assert.ok(listed.json.forwards.some((f) => f.id === fwd.id && f.active), 'GET must report it as active')

      const stopped = await post(host, { action: 'stop', id: fwd.id })
      assert.equal(stopped.json.ok, true)
      assert.equal(stopped.json.forwards.find((f) => f.id === fwd.id).active, false, 'stop must free the listener')

      const removed = await post(host, { action: 'remove', id: fwd.id })
      assert.equal(removed.json.ok, true)
      assert.equal(removed.json.forwards.some((f) => f.id === fwd.id), false, 'remove must drop the definition')
    })
  } finally { await echo.close() }
})

test('starting a forward on a port that is already taken fails with a reason, not a hang', async () => {
  const echo = await echoServer()
  const squatter = net.createServer((socket) => socket.end())
  try {
    await withForwards(async ({ host }) => {
      const taken = await freePort()
      await new Promise((resolve) => squatter.listen(taken, '127.0.0.1', resolve))
      const defined = await post(host, { action: 'define', listenPort: taken, targetHost: '127.0.0.1', targetPort: echo.port })
      const fwd = defined.json.forward
      const started = await post(host, { action: 'start', id: fwd.id })
      assert.equal(started.json.ok, false, 'binding an occupied port must fail')
      assert.ok(String(started.json.error || '').length > 0, 'and must say why')
      assert.match(String(started.json.error), /EADDRINUSE|in use|占用|address/i,
        `the error must name the port conflict, got: ${started.json.error}`)
      // The failure response carries the CURRENT list, so the UI can refresh the
      // row instead of staying on 启动 (a tunnel may have come up despite the
      // error when a concurrent autoStart pass won the port).
      assert.ok(Array.isArray(started.json.forwards), 'a failed start must still return the forward list')
      assert.equal(started.json.forwards.find((f) => f.id === fwd.id).active, false)
      // The definition survives the failed start, so the user can fix the port.
      const listed = await host.call('/dsh-remote/forwards', { method: 'GET' })
      const still = listed.json.forwards.find((f) => f.id === fwd.id)
      assert.ok(still, 'a failed start must not lose the definition')
      assert.equal(still.active, false)
    })
  } finally {
    await new Promise((resolve) => squatter.close(resolve))
    await echo.close()
  }
})

test('a forward to a refusing target reports the failure when traffic arrives', async () => {
  await withForwards(async ({ host }) => {
    const listenPort = await freePort()
    const deadTarget = await freePort() // nothing listens there
    const defined = await post(host, { action: 'define', listenPort, targetHost: '127.0.0.1', targetPort: deadTarget })
    const fwd = defined.json.forward
    const started = await post(host, { action: 'start', id: fwd.id })
    // The listener itself can bind (the target is only dialed per connection), so
    // start may succeed — what must not happen is a silent black hole.
    assert.ok(started.json.ok === true || started.json.ok === false)
    const outcome = await new Promise((resolve) => {
      const socket = net.connect(listenPort, '127.0.0.1')
      let settled = false
      const done = (value) => { if (settled) return; settled = true; try { socket.destroy() } catch { /* gone */ } resolve(value) }
      socket.setTimeout(4000, () => done('timeout'))
      socket.on('connect', () => socket.write('ping'))
      socket.on('data', () => done('data'))
      socket.on('error', (err) => done('error:' + err.message))
      socket.on('close', () => done('closed'))
    })
    assert.ok(outcome === 'closed' || outcome === 'error:' || String(outcome).startsWith('error:') || outcome === 'timeout',
      `a dead target must surface as a closed/errored connection, got: ${outcome}`)
    assert.notEqual(outcome, 'data', 'nothing should answer from a dead target')
    await post(host, { action: 'remove', id: fwd.id })
  })
})

test('starting an already-running forward is idempotent, and stopping a stopped one is harmless', async () => {
  const echo = await echoServer()
  try {
    await withForwards(async ({ host }) => {
      const listenPort = await freePort()
      const defined = await post(host, { action: 'define', listenPort, targetHost: '127.0.0.1', targetPort: echo.port })
      const fwd = defined.json.forward
      assert.equal((await post(host, { action: 'start', id: fwd.id })).json.ok, true)
      const twice = await post(host, { action: 'start', id: fwd.id })
      assert.equal(twice.json.ok, true, 'starting twice must not error (the listener is already up)')
      assert.equal(twice.json.forwards.find((f) => f.id === fwd.id).active, true)

      assert.equal((await post(host, { action: 'stop', id: fwd.id })).json.ok, true)
      const stopAgain = await post(host, { action: 'stop', id: fwd.id })
      assert.equal(stopAgain.json.ok, true, 'stopping an inactive forward must not error')
      await post(host, { action: 'remove', id: fwd.id })
    })
  } finally { await echo.close() }
})

test('removing a RUNNING forward releases its listener instead of leaking it', async () => {
  const echo = await echoServer()
  try {
    await withForwards(async ({ host }) => {
      const listenPort = await freePort()
      const defined = await post(host, { action: 'define', listenPort, targetHost: '127.0.0.1', targetPort: echo.port })
      const fwd = defined.json.forward
      await post(host, { action: 'start', id: fwd.id })
      await post(host, { action: 'remove', id: fwd.id })

      // If the listener leaked, binding the same port again would fail.
      const rebind = net.createServer()
      const err = await new Promise((resolve) => {
        rebind.once('error', resolve)
        rebind.listen(listenPort, '127.0.0.1', () => resolve(null))
      })
      await new Promise((resolve) => rebind.close(resolve))
      assert.equal(err, null, `the port must be free after removing a running forward, got: ${err && err.message}`)
    })
  } finally { await echo.close() }
})

test('starting through the route persists lastActive and Stop clears it', async () => {
  await withForwards(async ({ host }) => {
    const defined = await post(host, {
      action: 'define', listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 22, autoStart: true,
    })
    const fwd = defined.json.forward
    const started = await post(host, { action: 'start', id: fwd.id })
    assert.equal(started.json.ok, true, started.json.error)
    assert.equal(started.json.forwards.find((f) => f.id === fwd.id).lastActive, true,
      'a successful start must be remembered for 自动重连 / the next boot')

    const stopped = await post(host, { action: 'stop', id: fwd.id })
    assert.equal(stopped.json.ok, true)
    assert.equal(stopped.json.forwards.find((f) => f.id === fwd.id).lastActive, false,
      'a user Stop must clear the persisted flag')
  })
})

test('lastActive is persisted and restored by a fresh process after its first connect', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-fwd-persist-'))
  const file = path.join(dir, 'forwards.json')
  try {
    const conn1 = new EventEmitter()
    let fm = new ForwardManager({ connect: async () => conn1 }, { file, currentMachine: () => 'm1' })
    const d = fm.define({ listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 9, autoStart: true, machineId: 'm1' })
    assert.equal((await fm.start(d)).ok, true)
    // A dropped connection / shutdown must NOT clear the persisted flag.
    fm.stopAll()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).defs.find((x) => x.id === d.id).lastActive, true,
      'start() must persist lastActive')

    // New process: same forwards.json, fresh manager, boot connect.
    const conn = new EventEmitter()
    fm = new ForwardManager({ connect: async () => conn }, { file, currentMachine: () => 'm1' })
    assert.equal(fm.hasPendingRestore(), true, 'the persisted flag must be visible before connecting')
    fm.attach(conn)
    await settleStarts()
    assert.equal(fm.list().find((f) => f.id === d.id).active, true,
      'the previous session\'s running forward must come back on the first connect')
    fm.stopAll()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a user stop clears lastActive, so it stays down on the next connect', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-fwd-forget-'))
  const file = path.join(dir, 'forwards.json')
  try {
    const conn1 = new EventEmitter()
    let fm = new ForwardManager({ connect: async () => conn1 }, { file, currentMachine: () => 'm1' })
    const d = fm.define({ listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 9, autoStart: true, machineId: 'm1' })
    await fm.start(d)
    fm.stop(d.id, { forget: true }) // what the route's Stop button does
    assert.equal(fm.list().find((f) => f.id === d.id).lastActive, false)

    const conn = new EventEmitter()
    fm = new ForwardManager({ connect: async () => conn }, { file, currentMachine: () => 'm1' })
    assert.equal(fm.hasPendingRestore(), false)
    fm.attach(conn)
    await settleStarts()
    assert.equal(fm.list().find((f) => f.id === d.id).active, false, 'a stopped forward must not be restored')
    fm.stopAll()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('autoStart can be toggled on an existing definition and shows up in the list', async () => {
  await withForwards(async ({ host }) => {
    const defined = await post(host, {
      action: 'define', listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 22, autoStart: false,
    })
    const fwd = defined.json.forward
    assert.equal(fwd.autoStart, false)

    const on = await post(host, { action: 'update', id: fwd.id, autoStart: true })
    assert.equal(on.status, 200)
    assert.equal(on.json.forward.autoStart, true)
    assert.equal(on.json.forwards.find((f) => f.id === fwd.id).autoStart, true)

    const off = await post(host, { action: 'update', id: fwd.id, autoStart: false })
    assert.equal(off.json.forwards.find((f) => f.id === fwd.id).autoStart, false)
    // And the change is what a later GET (and the next attach()) sees.
    assert.equal((await host.call('/dsh-remote/forwards', { method: 'GET' })).json.forwards
      .find((f) => f.id === fwd.id).autoStart, false)

    assert.equal((await post(host, { action: 'update', id: 'nope', autoStart: true })).status, 404)
    assert.equal((await post(host, { action: 'update', id: fwd.id, autoStart: 'yes' })).status, 400,
      'a non-boolean must be refused instead of silently coercing')
  })
})

test('unknown forward ids and actions are refused with 404/400 and a reason', async () => {
  await withForwards(async ({ host }) => {
    const start = await post(host, { action: 'start', id: 'nope' })
    assert.equal(start.status, 404)
    assert.equal(start.json.ok, false)
    assert.match(String(start.json.error), /not found/)

    const stop = await post(host, { action: 'stop', id: 'nope' })
    assert.equal(stop.status, 404)

    const bad = await post(host, { action: 'explode' })
    assert.equal(bad.status, 400)
    assert.match(String(bad.json.error), /unknown action/)

    // A define with no usable listen port must be REFUSED: listen(0) would pick
    // an ephemeral port and show the user a forward listening somewhere they never
    // asked for.
    const zero = await post(host, { action: 'define', listenPort: 0, targetPort: 1 })
    assert.equal(zero.status, 400)
    assert.equal(zero.json.ok, false)
    assert.match(String(zero.json.error), /listenPort/)
    const tooBig = await post(host, { action: 'define', listenPort: 70000 })
    assert.equal(tooBig.status, 400)
  })
})

// ── autoStart semantics + concurrent starts ────────────────────────────────
//
// 自动重连 means RESTORE: a forward that was running when the connection
// dropped comes back. It must NOT mean "start every checked forward on any
// connect": on a fresh session, clicking one forward established the connection
// and lit up every other autoStart row. The old loop also ignored machineId, so
// a connection to machine B could start machine A's forward through B.
//
// `attach()` restarts autoStart definitions from inside `pool.connect()`, which
// is also where the manual 启动 promise is still pending — so one attempt per
// definition (see start()) has to be shared, not bound twice.

/** Let fire-and-forget restore starts (attach → start) settle. */
async function settleStarts() { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }

test('an autoStart forward does not start just because another forward connected', async () => {
  const conn = new EventEmitter()
  let fm
  const pool = { connect: async () => { fm.attach(conn); return conn } }
  fm = new ForwardManager(pool, { file: null, currentMachine: () => 'm1' })
  try {
    const auto = fm.define({ listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 9, autoStart: true, machineId: 'm1' })
    const manual = fm.define({ listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 9, autoStart: false, machineId: 'm1' })
    const active = (id) => fm.list().find((f) => f.id === id).active

    fm.attach(conn)
    await settleStarts()
    assert.equal(active(auto.id), false, 'the first connect must not auto-start anything')

    const started = await fm.start(manual)
    assert.equal(started.ok, true)
    await settleStarts()
    assert.equal(active(manual.id), true)
    assert.equal(active(auto.id), false,
      'starting the manual forward must not pull the autoStart one up (that was the reported "both turn green" bug)')
  } finally { fm.stopAll() }
})

test('autoStart restores a forward that was running when the connection dropped', async () => {
  const conn1 = new EventEmitter()
  const conn2 = new EventEmitter()
  let fm
  const pool = { connect: async () => fm.client || conn2 }
  fm = new ForwardManager(pool, { file: null, currentMachine: () => 'm1' })
  try {
    const auto = fm.define({ listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 9, autoStart: true, machineId: 'm1' })
    const active = () => fm.list().find((f) => f.id === auto.id).active

    fm.attach(conn1)
    assert.equal((await fm.start(auto)).ok, true)
    assert.equal(active(), true)

    fm.detach()
    assert.equal(active(), false, 'a dropped connection stops the listener')
    fm.attach(conn2)
    await settleStarts()
    assert.equal(active(), true, 'a forward that was RUNNING must come back on reconnect')
  } finally { fm.stopAll() }
})

test('autoStart restores after a socket that died without detach()', async () => {
  // The common real-world drop is not a graceful pool.close(): the SSH socket
  // just closes (network blip, keepalive timeout). The restore snapshot must be
  // taken there too, otherwise 自动重连 restores nothing after the case it is
  // for. The dead handle must also be dropped so the retry attaches the new one.
  const conn1 = new EventEmitter()
  const conn2 = new EventEmitter()
  let fm
  const pool = { connect: async () => fm.client || conn2 }
  fm = new ForwardManager(pool, { file: null, currentMachine: () => 'm1' })
  try {
    const auto = fm.define({ listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 9, autoStart: true, machineId: 'm1' })
    const active = () => fm.list().find((f) => f.id === auto.id).active

    fm.attach(conn1)
    await fm.start(auto)
    assert.equal(active(), true)

    conn1.emit('close') // abrupt drop: pool.detach() never runs
    await settleStarts()
    assert.equal(active(), false, 'the listener must go down with the socket')
    assert.equal(fm.client, null, 'a dead client must not be reused')

    fm.attach(conn2)
    await settleStarts()
    assert.equal(active(), true, 'a forward that was RUNNING must come back after an abrupt drop')
  } finally { fm.stopAll() }
})

test('a reverse forward the user opted into is restored after the connection drops', async () => {
  // Reverse tunnels re-open a listener on the REMOTE, so upstream deliberately
  // never auto-restarted them. They are restored now only because the user
  // explicitly checked 自动重连 (the UI shows a direction-specific warning first).
  const conn1 = new EventEmitter()
  conn1.forwardIn = (_host, _port, cb) => cb(null)
  conn1.unforwardIn = () => {}
  const conn2 = new EventEmitter()
  conn2.forwardIn = (_host, _port, cb) => cb(null)
  conn2.unforwardIn = () => {}
  let fm
  const pool = { connect: async () => fm.client || conn2 }
  fm = new ForwardManager(pool, { file: null, currentMachine: () => 'm1' })
  try {
    const rev = fm.define({ direction: 'reverse', listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 22, autoStart: true, machineId: 'm1' })
    const active = () => fm.list().find((f) => f.id === rev.id).active
    fm.attach(conn1)
    assert.equal((await fm.start(rev)).ok, true)
    assert.equal(active(), true)

    fm.detach()
    assert.equal(active(), false, 'the remote listener dies with the connection')
    fm.attach(conn2)
    await settleStarts()
    assert.equal(active(), true, 'an opted-in reverse forward must come back on reconnect')
  } finally { fm.stopAll() }
})

test('autoStart restore is scoped to the machine that reconnects', async () => {
  const connA = new EventEmitter()
  const connB = new EventEmitter()
  const connA2 = new EventEmitter()
  let current = 'A'
  let fm
  const pool = { connect: async () => fm.client || (current === 'B' ? connB : connA2) }
  fm = new ForwardManager(pool, { file: null, currentMachine: () => current })
  try {
    const autoA = fm.define({ listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 9, autoStart: true, machineId: 'A' })
    const active = () => fm.list().find((f) => f.id === autoA.id).active

    fm.attach(connA)
    await fm.start(autoA)
    assert.equal(active(), true)
    fm.detach() // remembers A's running set

    current = 'B'
    fm.attach(connB)
    await settleStarts()
    assert.equal(active(), false, "machine B's connect must not restore machine A's forward")

    current = 'A'
    fm.attach(connA2)
    await settleStarts()
    assert.equal(active(), true, "A's forward must come back when A reconnects")
  } finally { fm.stopAll() }
})

test("a manual start racing attach()'s restore shares one attempt", async () => {
  const listenPort = await freePort()
  const conn1 = new EventEmitter()
  const conn2 = new EventEmitter()
  let conn = conn1
  let fm
  // Mirrors SystemOpenSshPool._doConnect: onReady (attach) fires inside
  // connect(), before the returned promise resolves.
  const pool = { connect: async () => { fm.attach(conn); return conn } }
  fm = new ForwardManager(pool, { file: null, currentMachine: () => 'm1' })
  try {
    const d = fm.define({ listenPort, targetHost: '127.0.0.1', targetPort: 9, autoStart: true, machineId: 'm1' })
    // Make it "was running before the drop" so the reconnect restores it.
    fm.attach(conn1)
    await fm.start(d)
    fm.detach()

    conn = conn2
    const [first, second] = await Promise.all([fm.start(d), fm.start(d)])
    assert.deepEqual(first, { ok: true, active: true }, 'the manual start must not lose the race')
    assert.deepEqual(second, { ok: true, active: true })
    assert.equal(fm.list().find((f) => f.id === d.id).active, true)

    // The port is held by exactly one listener, not two.
    const probe = net.createServer()
    const err = await new Promise((resolve) => {
      probe.once('error', resolve)
      probe.listen(listenPort, '127.0.0.1', () => resolve(null))
    })
    assert.ok(err, 'the forward listener must still own the port')
    await new Promise((resolve) => probe.close(resolve))
  } finally {
    fm.stopAll()
  }
  // And stopAll released it.
  const probe = net.createServer()
  const err = await new Promise((resolve) => {
    probe.once('error', resolve)
    probe.listen(listenPort, '127.0.0.1', () => resolve(null))
  })
  await new Promise((resolve) => probe.close(resolve))
  assert.equal(err, null, `stopAll must free the port, got: ${err && err.message}`)
})

// ── review follow-ups: identity, cancellation, migration, backend cleanup ──
//
// The maintainer's dynamic probes found these on the first head: an ephemeral
// (save:false / persist:false) machine still restored the registry machine's
// forwards, Stop/Remove could not cancel an in-flight start, and a disconnect
// during the start window registered a dead client. These tests pin the fixes.

const tick = () => new Promise((r) => setTimeout(r, 0))

function controlledNet() {
  const servers = []
  return {
    servers,
    createServer() {
      const server = new EventEmitter()
      server.closed = false
      server.listen = (port, host, cb) => {
        server.complete = () => { if (!server.closed) cb() }
        server.fail = (message) => { if (!server.closed) server.emit('error', new Error(message)) }
        servers.push(server)
      }
      server.close = () => { server.closed = true }
      return server
    },
    connect() { throw new Error('not used by these ownership tests') },
  }
}

test('a late stale success cannot replace or orphan a restarted listener', async () => {
  const conn = new EventEmitter()
  const fakeNet = controlledNet()
  const fm = new ForwardManager({ connect: async () => conn }, { file: null, net: fakeNet, currentMachine: () => 'A' })
  const d = fm.define({ listenPort: 18080, targetHost: '127.0.0.1', targetPort: 22, autoStart: true, machineId: 'A' })
  try {
    const oldStart = fm.start(d)
    await tick()
    fm.stop(d.id, { forget: true })
    const newStart = fm.start(d)
    await tick()
    assert.equal(fakeNet.servers.length, 2)
    fakeNet.servers[1].complete()
    assert.equal((await newStart).ok, true)
    assert.equal(fm.servers.get(d.id).server, fakeNet.servers[1])

    fakeNet.servers[0].complete()
    const oldResult = await oldStart
    assert.equal(oldResult.ok, false)
    assert.equal(fakeNet.servers[0].closed, true, 'the stale attempt must close its own listener')
    assert.equal(fakeNet.servers[1].closed, false, 'stale cleanup must not close the restarted listener')
    assert.equal(fm.servers.get(d.id).server, fakeNet.servers[1], 'the restarted entry keeps ownership')
    assert.equal(fm.list()[0].active, true)
  } finally { fm.stopAll() }
})

test('a late stale error cannot close a restarted listener', async () => {
  const conn = new EventEmitter()
  const fakeNet = controlledNet()
  const fm = new ForwardManager({ connect: async () => conn }, { file: null, net: fakeNet, currentMachine: () => 'A' })
  const d = fm.define({ listenPort: 18081, targetHost: '127.0.0.1', targetPort: 22, autoStart: true, machineId: 'A' })
  try {
    const oldStart = fm.start(d)
    await tick()
    fm.stop(d.id, { forget: true })
    const newStart = fm.start(d)
    await tick()
    fakeNet.servers[1].complete()
    assert.equal((await newStart).ok, true)
    fakeNet.servers[0].fail('old attempt failed late')
    assert.equal((await oldStart).ok, false)
    assert.equal(fakeNet.servers[1].closed, false, 'a stale error must not close the new listener')
    assert.equal(fm.servers.get(d.id).server, fakeNet.servers[1])
    assert.equal(fm.list()[0].active, true)
  } finally { fm.stopAll() }
})

test('a late forwardIn success only unforwards its own attempt', async () => {
  const conn = new EventEmitter()
  const callbacks = []
  const remoteListeners = new Set()
  let unforwardCalls = 0
  conn.forwardIn = (_host, port, cb) => callbacks.push((err) => { if (!err) remoteListeners.add(port); cb(err) })
  conn.unforwardIn = (_host, port, cb) => { unforwardCalls++; remoteListeners.delete(port); cb() }
  const fm = new ForwardManager({ connect: async () => conn }, { file: null, currentMachine: () => 'A' })
  const d = fm.define({ direction: 'reverse', listenPort: 18082, targetHost: '127.0.0.1', targetPort: 22, machineId: 'A' })
  try {
    const oldStart = fm.start(d)
    await tick()
    fm.stop(d.id, { forget: true })
    const newStart = fm.start(d)
    await tick()
    assert.equal(callbacks.length, 2)
    callbacks[1](null)
    assert.equal((await newStart).ok, true)
    assert.equal(remoteListeners.has(d.listenPort), true)
    callbacks[0](null)
    assert.equal((await oldStart).ok, false)
    assert.equal(unforwardCalls, 0, 'a newer owner on the same client must block stale unforwardIn')
    assert.equal(remoteListeners.has(d.listenPort), true, 'the real restarted remote listener must survive')
    assert.equal(fm.list()[0].active, true, 'the restarted reverse listener must remain active')
  } finally { fm.stopAll() }
})

test('a stale forwardIn without a replacement still unforwards its own listener', async () => {
  const conn = new EventEmitter()
  const callbacks = []
  const remoteListeners = new Set()
  let unforwardCalls = 0
  conn.forwardIn = (_host, port, cb) => callbacks.push((err) => { if (!err) remoteListeners.add(port); cb(err) })
  conn.unforwardIn = (_host, port, cb) => { unforwardCalls++; remoteListeners.delete(port); cb() }
  const fm = new ForwardManager({ connect: async () => conn }, { file: null, currentMachine: () => 'A' })
  const d = fm.define({ direction: 'reverse', listenPort: 18084, targetHost: '127.0.0.1', targetPort: 22, machineId: 'A' })
  try {
    const pending = fm.start(d)
    await tick()
    fm.stop(d.id, { forget: true })
    callbacks[0](null)
    assert.equal((await pending).ok, false)
    assert.equal(unforwardCalls, 1, 'without a replacement, stale cleanup must unforward its own listener')
    assert.equal(remoteListeners.has(d.listenPort), false)
    assert.equal(fm.list()[0].active, false)
  } finally { fm.stopAll() }
})

test('a late OpenSSH reverse handle closes only its own attempt', async () => {
  const conn = new EventEmitter()
  const releases = []
  const closed = { old: 0, new: 0 }
  conn.reverseForward = () => new Promise((resolve) => releases.push(resolve))
  const fm = new ForwardManager({ connect: async () => conn }, { file: null, currentMachine: () => 'A' })
  const d = fm.define({ direction: 'reverse', listenPort: 18083, targetHost: '127.0.0.1', targetPort: 22, machineId: 'A' })
  const oldHandle = { close() { closed.old++ } }
  const newHandle = { close() { closed.new++ } }
  try {
    const oldStart = fm.start(d)
    await tick()
    fm.stop(d.id, { forget: true })
    const newStart = fm.start(d)
    await tick()
    releases[1](newHandle)
    assert.equal((await newStart).ok, true)
    releases[0](oldHandle)
    assert.equal((await oldStart).ok, false)
    assert.deepEqual(closed, { old: 1, new: 0 }, 'stale cleanup must close old, not new')
    assert.equal(fm.list()[0].active, true)
  } finally { fm.stopAll() }
})

test('unknown identity is fail-closed and a foreign forward cannot be started', async () => {
  const conn = new EventEmitter()
  let fm
  const pool = { connect: async () => conn }
  // Provider returns null (ephemeral switched away / cleared): nothing may
  // restore, even a definition whose machineId is also null.
  fm = new ForwardManager(pool, { file: null, currentMachine: () => null })
  const legacy = fm.define({ listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 9, autoStart: true })
  legacy.lastActive = true
  try {
    fm.attach(conn)
    await tick()
    assert.equal(fm.list().find((f) => f.id === legacy.id).active, false, 'null identity must not match a null definition')
    assert.equal(fm.hasPendingRestore(), false)

    const foreign = fm.define({ listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 9, machineId: 'm-A' })
    const refused = await fm.start(foreign)
    assert.equal(refused.ok, false)
    assert.match(String(refused.error), /另一台机器|身份未知/)
  } finally { fm.stopAll() }
})

test('Stop during an in-flight start cancels it: no listener, no lastActive', async () => {
  const listenPort = await freePort()
  const conn = new EventEmitter()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let fm
  const pool = { connect: async () => { await gate; return conn } }
  fm = new ForwardManager(pool, { file: null })
  try {
    const d = fm.define({ listenPort, targetHost: '127.0.0.1', targetPort: 9, autoStart: true })
    const pending = fm.start(d)
    await tick()
    fm.stop(d.id, { forget: true })
    release()
    const res = await pending
    assert.equal(res.ok, false)
    assert.equal(fm.list().find((f) => f.id === d.id).active, false)
    assert.equal(fm.list().find((f) => f.id === d.id).lastActive, false)
    const probe = net.createServer()
    const err = await new Promise((resolve) => {
      probe.once('error', resolve)
      probe.listen(listenPort, '127.0.0.1', () => resolve(null))
    })
    await new Promise((resolve) => probe.close(resolve))
    assert.equal(err, null, `a cancelled start must not leave a listener: ${err && err.message}`)
  } finally { fm.stopAll() }
})

test('Remove during an in-flight start leaves no definition and no orphan listener', async () => {
  const listenPort = await freePort()
  const conn = new EventEmitter()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let fm
  const pool = { connect: async () => { await gate; return conn } }
  fm = new ForwardManager(pool, { file: null })
  try {
    const d = fm.define({ listenPort, targetHost: '127.0.0.1', targetPort: 9 })
    const pending = fm.start(d)
    await tick()
    fm.remove(d.id)
    release()
    const res = await pending
    assert.equal(res.ok, false)
    assert.equal(fm.list().length, 0)
    const probe = net.createServer()
    const err = await new Promise((resolve) => {
      probe.once('error', resolve)
      probe.listen(listenPort, '127.0.0.1', () => resolve(null))
    })
    await new Promise((resolve) => probe.close(resolve))
    assert.equal(err, null, `a removed in-flight start must close its listener: ${err && err.message}`)
  } finally { fm.stopAll() }
})

test('a disconnect during the start window cannot register a dead client', async () => {
  const conn1 = new EventEmitter()
  const conn2 = new EventEmitter()
  const pending = []
  const fakeNet = {
    createServer() {
      const entry = { listenCb: null, closed: false }
      pending.push(entry)
      return {
        on() {},
        listen(_port, _host, cb) { entry.listenCb = cb },
        close() { entry.closed = true },
        address() { return { port: 0 } },
      }
    },
    connect() { throw new Error('not used') },
  }
  let fm
  const pool = { connect: async () => (fm.client === conn1 ? conn1 : conn2) }
  fm = new ForwardManager(pool, { net: fakeNet, file: null })
  try {
    const d = fm.define({ listenPort: 12345, targetHost: '127.0.0.1', targetPort: 9 })
    fm.attach(conn1)
    const pendingStart = fm.start(d)
    await tick()
    conn1.emit('close') // drops the connection while listen() is still in flight
    pending[0].listenCb()
    const res = await pendingStart
    assert.equal(res.ok, false)
    assert.equal(fm.list().find((f) => f.id === d.id).active, false, 'the late listener must not be registered')
    assert.equal(pending[0].closed, true, 'the late listener must be torn down')

    // The new connection must be usable: servers.has() can no longer block it.
    const retry = fm.start(d)
    await tick()
    pending[1].listenCb()
    const retried = await retry
    assert.equal(retried.ok, true, JSON.stringify(retried))
    assert.equal(fm.servers.get(d.id).client, conn2)
  } finally { fm.stopAll() }
})

test('legacy autoStart definitions are paused and require re-consent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-fwd-legacy-'))
  const file = path.join(dir, 'forwards.json')
  try {
    writeFileSync(file, JSON.stringify({
      defs: [
        { id: 'legacy-local', direction: 'local', listenPort: 15001, targetHost: '127.0.0.1', targetPort: 9, autoStart: true, machineId: 'm1' },
        { id: 'legacy-reverse', direction: 'reverse', listenPort: 15002, targetHost: '127.0.0.1', targetPort: 9, autoStart: true, machineId: 'm1' },
      ],
    }))
    const fm = new ForwardManager({}, { file, currentMachine: () => 'm1' })
    for (const f of fm.list()) {
      assert.equal(f.autoStart, false, `${f.id}: old autoStart must be paused`)
      assert.equal(f.lastActive, false)
      assert.equal(f.needsReconsent, true, `${f.id}: the row must ask for re-consent`)
    }
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.defs.find((d) => d.id === 'legacy-local').autoStart, false, 'migration is persisted')

    const updated = fm.update('legacy-local', { autoStart: true })
    assert.equal(updated.autoStart, true)
    assert.equal(fm.list().find((f) => f.id === 'legacy-local').needsReconsent, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an OpenSSH reverse child exiting on its own clears the active row', async () => {
  const { EventEmitter: EE } = await import('node:events')
  const child = new EE()
  const conn = new EE()
  conn.reverseForward = async () => ({ child, close() {} })
  let fm
  const pool = { connect: async () => conn }
  fm = new ForwardManager(pool, { file: null })
  try {
    const d = fm.define({ direction: 'reverse', listenPort: 15003, targetHost: '127.0.0.1', targetPort: 9 })
    assert.equal((await fm.start(d)).ok, true)
    assert.equal(fm.list().find((f) => f.id === d.id).active, true)
    child.emit('close')
    assert.equal(fm.list().find((f) => f.id === d.id).active, false, 'a died ssh -R child must not stay active')
  } finally { fm.stopAll() }
})

test('an ephemeral (save:false) connection does not restore or start the saved machine forward', async () => {
  // Production wiring: rw_connect(save:false) switches the pool to B while
  // store.currentId still points at A. The manager must follow the pool's
  // applied identity, not the registry.
  const srvA = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/home/user' })
  const srvB = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/home/user' })
  const recA = machine({ name: 'A', host: '127.0.0.1', port: srvA.port, username: 'root', password: 'pw' })
  const recB = machine({ name: 'B', host: '127.0.0.1', port: srvB.port, username: 'root', password: 'pw' })
  const host = await createHost({ machines: [recA, recB] })
  try {
    assert.equal((await host.call('/dsh-remote/current', { body: { id: recA.id } })).json.ok, true)
    const defined = await post(host, {
      action: 'define', listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 22, autoStart: true,
    })
    const fwd = defined.json.forward
    assert.equal(fwd.machineId, recA.id, 'a saved machine definition is tagged with the pool identity')
    assert.equal((await post(host, { action: 'start', id: fwd.id })).json.ok, true)

    const connected = await host.run('rw_connect', {
      host: '127.0.0.1', port: srvB.port, username: 'root', password: 'pw', save: false,
    })
    assert.ok(connected, 'ephemeral connect must answer')
    await tick()

    const listed = (await host.call('/dsh-remote/forwards', { method: 'GET' })).json.forwards
    assert.equal(listed.find((f) => f.id === fwd.id).active, false, 'A forward must not restore on the ephemeral B connection')

    const retried = await post(host, { action: 'start', id: fwd.id })
    assert.equal(retried.json.ok, false, 'A forward must not be startable while the pool talks to B')
    assert.match(String(retried.json.error), /另一台机器|身份未知/)

    const definedOnB = await post(host, {
      action: 'define', listenPort: await freePort(), targetHost: '127.0.0.1', targetPort: 22, autoStart: false,
    })
    const bFwd = definedOnB.json.forward
    assert.ok(bFwd.machineId, 'defining while ephemeral still records an applied identity')
    assert.notEqual(bFwd.machineId, recA.id, 'the new definition must not be tagged as saved machine A')
  } finally {
    await host.dispose()
    await srvA.close()
    await srvB.close()
  }
})

test('rw_forward on an ephemeral connection uses its applied identity and carries bytes', async () => {
  const echo = await echoServer()
  const srvA = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/home/user' })
  const srvB = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/home/user' })
  const recA = machine({ name: 'A', host: '127.0.0.1', port: srvA.port, username: 'root', password: 'pw' })
  const recB = machine({ name: 'B', host: '127.0.0.1', port: srvB.port, username: 'root', password: 'pw' })
  const host = await createHost({ machines: [recA, recB] })
  try {
    assert.equal((await host.call('/dsh-remote/current', { body: { id: recA.id } })).json.ok, true)
    await host.run('rw_connect', { host: '127.0.0.1', port: srvB.port, username: 'root', password: 'pw', save: false })
    const listenPort = await freePort()
    const started = await host.run('rw_forward', {
      listenPort, targetHost: '127.0.0.1', targetPort: echo.port, autoStart: true,
    })
    assert.match(JSON.stringify(started), /forward active/)

    const rows = (await host.call('/dsh-remote/forwards', { method: 'GET' })).json.forwards
    const row = rows.find((f) => f.listenPort === listenPort)
    assert.ok(row, 'rw_forward must persist its definition')
    assert.ok(row.machineId, 'an ephemeral definition still needs a real applied identity')
    assert.notEqual(row.machineId, recA.id, 'the definition must not be tagged as the saved old machine')
    assert.equal(row.active, true)

    const roundTrip = await new Promise((resolve) => {
      const socket = net.connect(listenPort, '127.0.0.1')
      let got = ''
      const done = (value) => { try { socket.destroy() } catch {} resolve(value) }
      socket.setTimeout(4000, () => done('timeout'))
      socket.on('connect', () => socket.write('ping'))
      socket.on('data', (chunk) => { got += chunk.toString(); if (got.includes('ping')) done(got) })
      socket.on('error', (err) => done('error: ' + err.message))
    })
    assert.equal(roundTrip, 'ping')
    await host.run('rw_forward', { listenPort, remove: true })
  } finally {
    await host.dispose()
    await srvA.close()
    await srvB.close()
    await echo.close()
  }
})
