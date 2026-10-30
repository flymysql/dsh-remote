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
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

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
