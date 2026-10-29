// The embedded terminal, end to end: a REAL PTY channel to a real (fake) sshd.
//
// routes-term.js + terminal.js are the only interactive surface in the plugin, and
// they were the least covered part of the host half: the route guards were tested,
// nothing else. The failure modes that matter are all behavioural — the prompt
// never arriving, input not reaching the shell, a session that dies silently, or
// (worst) a session belonging to machine A being driven by a request bound to
// machine B. Those are what this file asserts.
//
// The fake server answers a PTY shell by echoing input and closing on `exit`, so a
// round trip through open → output → input → output → close is a genuine one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

async function withTerminal(config = {}, fn) {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/home/user' })
  const rec = machine({ host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: '/home/user' })
  const host = await createHost({ machines: [rec], config })
  try {
    const cur = await host.call('/dsh-remote/current', { body: { id: rec.id } })
    assert.equal(cur.json.ok, true, `binding failed: ${cur.raw}`)
    await fn({ host, srv, rec })
  } finally {
    await host.dispose()
    await srv.close()
  }
}

/** Poll the output route until `predicate` holds (the PTY is asynchronous). */
async function waitForOutput(host, id, predicate, { from = 0, tries = 40 } = {}) {
  let next = from
  let seen = ''
  for (let i = 0; i < tries; i++) {
    const r = await host.call(`/dsh-remote/term/output?id=${encodeURIComponent(id)}&from=${next}`, { method: 'GET' })
    assert.equal(r.json.ok, true, `output poll failed: ${r.raw}`)
    for (const chunk of r.json.chunks || []) seen += chunk
    next = r.json.next
    if (predicate(seen, r.json)) return { text: seen, next, closed: r.json.closed }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`terminal output never satisfied the condition; saw: ${JSON.stringify(seen)}`)
}

test('a terminal opens, shows a prompt, echoes input and survives a resize', async () => {
  await withTerminal({}, async ({ host }) => {
    const open = await host.call('/dsh-remote/term/open', { body: { cols: 100, rows: 30 } })
    assert.equal(open.json.ok, true, `open failed: ${open.raw}`)
    const id = open.json.id
    assert.ok(id, 'open must return a session id')

    const prompt = await waitForOutput(host, id, (text) => text.includes('fake-ssh$'))
    assert.match(prompt.text, /fake-ssh\$/, 'the remote prompt must reach the browser')

    const input = await host.call('/dsh-remote/term/input', { body: { id, data: 'echo hello-terminal\r' } })
    assert.equal(input.json.ok, true, `input failed: ${input.raw}`)
    const echoed = await waitForOutput(host, id, (text) => text.includes('hello-terminal'), { from: prompt.next })
    assert.match(echoed.text, /hello-terminal/, 'what the user types must round-trip through the PTY')

    const resize = await host.call('/dsh-remote/term/resize', { body: { id, cols: 132, rows: 43 } })
    assert.equal(resize.json.ok, true, `resize failed: ${resize.raw}`)
    assert.equal(resize.json.cols, 132)
    assert.equal(resize.json.rows, 43)

    // A second poll from `next` must be empty (nothing new) — the polling
    // contract the browser depends on, and the reason the terminal does not
    // re-render its whole buffer on every tick.
    const quiet = await host.call(`/dsh-remote/term/output?id=${encodeURIComponent(id)}&from=${echoed.next}`, { method: 'GET' })
    assert.equal(quiet.json.ok, true)
    assert.deepEqual(quiet.json.chunks, [], 'no new output → no chunks')

    const list = await host.call('/dsh-remote/term/list', { method: 'GET' })
    assert.equal(list.json.ok, true)
    assert.ok(list.json.sessions.some((s) => s.id === id), `the open session must be listed: ${list.raw}`)
  })
})

test('closing a terminal ends the session, and further polls say so instead of hanging', async () => {
  await withTerminal({}, async ({ host }) => {
    const open = await host.call('/dsh-remote/term/open', { body: {} })
    const id = open.json.id
    await waitForOutput(host, id, (text) => text.includes('fake-ssh$'))

    const closed = await host.call('/dsh-remote/term/close', { body: { id } })
    assert.equal(closed.json.ok, true, `close failed: ${closed.raw}`)

    // After close the session is gone: driving it must answer 404, not silently
    // "succeed" (a UI that keeps polling a dead id would otherwise spin forever).
    const again = await host.call('/dsh-remote/term/input', { body: { id, data: 'x' } })
    assert.equal(again.json.ok, false)
    assert.equal(again.status, 404)
    const poll = await host.call(`/dsh-remote/term/output?id=${encodeURIComponent(id)}`, { method: 'GET' })
    assert.equal(poll.status, 404)

    const list = await host.call('/dsh-remote/term/list', { method: 'GET' })
    assert.equal(list.json.sessions.some((s) => s.id === id), false, 'a closed session must leave the list')
  })
})

test('a shell that exits on its own is reported as closed, with a note', async () => {
  await withTerminal({}, async ({ host }) => {
    const open = await host.call('/dsh-remote/term/open', { body: {} })
    const id = open.json.id
    const prompt = await waitForOutput(host, id, (text) => text.includes('fake-ssh$'))
    await host.call('/dsh-remote/term/input', { body: { id, data: 'exit\r' } })
    const ended = await waitForOutput(host, id, (_text, json) => json.closed === true, { from: prompt.next })
    assert.equal(ended.closed, true, 'the poll must report the session as closed')
  })
})

test('a terminal opened on one machine cannot be driven after the active machine changes', async () => {
  // The fence that matters: session ids are opaque, but the MACHINE binding is the
  // real boundary. Driving machine A's terminal from a request bound to machine B
  // must be refused, not silently accepted.
  const srvA = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/home/user' })
  const srvB = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/srv/b' })
  const a = machine({ name: 'A', host: '127.0.0.1', port: srvA.port, username: 'root', password: 'pw' })
  const b = machine({ name: 'B', host: '127.0.0.1', port: srvB.port, username: 'root', password: 'pw' })
  const host = await createHost({ machines: [a, b] })
  try {
    await host.call('/dsh-remote/current', { body: { id: a.id } })
    const open = await host.call('/dsh-remote/term/open', { body: {} })
    assert.equal(open.json.ok, true, `open on A failed: ${open.raw}`)
    const id = open.json.id

    // Switch the active machine to B.
    const sw = await host.call('/dsh-remote/current', { body: { id: b.id } })
    assert.equal(sw.json.ok, true)

    const input = await host.call('/dsh-remote/term/input', { body: { id, data: 'rm -rf /\r' } })
    assert.equal(input.json.ok, false, 'a session must not be drivable from another machine')
    assert.equal(input.status, 404)
    const poll = await host.call(`/dsh-remote/term/output?id=${encodeURIComponent(id)}`, { method: 'GET' })
    assert.equal(poll.status, 404, 'and it must not be readable either')
    const close = await host.call('/dsh-remote/term/close', { body: { id } })
    assert.equal(close.json.ok, false, 'nor closable')

    const listB = await host.call('/dsh-remote/term/list', { method: 'GET' })
    assert.equal(listB.json.sessions.some((s) => s.id === id), false, 'B must not even see A\'s sessions')
  } finally {
    await host.dispose()
    await srvA.close()
    await srvB.close()
  }
})

test('the per-process session cap refuses politely instead of exhausting the remote', async () => {
  await withTerminal({}, async ({ host }) => {
    const opened = []
    let refused = null
    for (let i = 0; i < 10; i++) {
      const r = await host.call('/dsh-remote/term/open', { body: {} })
      if (r.json.ok) opened.push(r.json.id)
      else { refused = r; break }
    }
    assert.ok(refused, 'opening an unbounded number of PTYs must eventually be refused')
    assert.equal(refused.json.ok, false)
    assert.ok(refused.status >= 400, `a refusal must carry an HTTP error, got ${refused.status}`)
    assert.ok(String(refused.json.error || '').length > 0, 'and a reason the user can act on')
    assert.ok(opened.length <= 8, `at most 8 sessions may be open at once, got ${opened.length}`)
    for (const id of opened) await host.call('/dsh-remote/term/close', { body: { id } })
  })
})
