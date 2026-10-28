// Embedded interactive terminal (PTY over SSH).
//
// The gap: rw_exec runs ONE command and closes — no PTY, no stdin after the
// writer returns, so `vim`, `top`, a `sudo` prompt or any full-screen TUI is
// impossible. A real ssh session needs a persistent shell channel with a window
// size, which is what `pool.shell()` opens and this manager owns.
//
// The transport is deliberately boring: the session lives on the HOST and the
// browser POLLS for output deltas (input is written immediately on its own
// request, so typing never waits for the poll cadence). That avoids depending on
// a socket-upgrade path the host may not expose.
//
// What these tests pin: the monotonic offset model (reload-safe, lossy-aware),
// the machine fence (a session on host A can never be driven from a request
// bound to host B), the idle/limit guards, and disposal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createTerminalManager, TERMINAL_RING_BYTES, TERMINAL_MAX_SESSIONS,
} from '../lib/terminal.js'

/** A stand-in for an ssh2 shell channel. */
class FakeStream extends EventEmitter {
  constructor() {
    super()
    this.stderr = new EventEmitter()
    this.written = []
    this.windows = []
    this.ended = false
    this.closed = false
  }
  write(d) { this.written.push(d); return true }
  setWindow(rows, cols, h, w) { this.windows.push({ rows, cols, h, w }) }
  end() { this.ended = true; this.emit('close') }
  close() { this.closed = true }
}

function fakePool() {
  const streams = []
  return {
    streams,
    async shell() { const s = new FakeStream(); streams.push(s); return s },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

test('a session streams output and reports monotonic offsets', async () => {
  const mgr = createTerminalManager()
  const pool = fakePool()
  try {
    const { ok, id } = await mgr.open({ pool, machine: 'host-a', cols: 100, rows: 30 })
    assert.equal(ok, true)
    const stream = pool.streams[0]
    stream.emit('data', 'hello ')
    stream.emit('data', 'world')

    const first = mgr.owned(id, 'host-a').session.readFrom(0)
    assert.deepEqual(first.chunks, ['hello ', 'world'])
    assert.equal(first.next, 'hello world'.length, 'next is a byte offset into the whole stream')
    assert.equal(first.lossy, false)

    // A poller that already saw everything gets nothing new...
    const idle = mgr.owned(id, 'host-a').session.readFrom(first.next)
    assert.deepEqual(idle.chunks, [])
    // ...and one that resumes from an earlier offset replays from there.
    const replay = mgr.owned(id, 'host-a').session.readFrom('hello '.length)
    assert.deepEqual(replay.chunks, ['world'])
  } finally { mgr.dispose() }
})

test('a reloaded page can resume from its stored offset (no per-client cursors needed)', async () => {
  const mgr = createTerminalManager()
  const pool = fakePool()
  try {
    const { id } = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
    pool.streams[0].emit('data', 'abc')
    const a = mgr.owned(id, 'h').session.readFrom(0)
    pool.streams[0].emit('data', 'def')
    // The reload only remembers `next`; the server needs no per-tab state.
    const b = mgr.owned(id, 'h').session.readFrom(a.next)
    assert.deepEqual(b.chunks, ['def'])
    assert.equal(b.next, 6)
  } finally { mgr.dispose() }
})

test('input is written to the channel verbatim, and a closed session refuses it', async () => {
  const mgr = createTerminalManager()
  const pool = fakePool()
  try {
    const { id } = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
    const s = mgr.owned(id, 'h').session
    assert.equal(s.write('ls\r'), true)
    assert.deepEqual(pool.streams[0].written, ['ls\r'])
    s.end()
    assert.equal(s.write('nope'), false, 'writing to a closed session must not throw')
  } finally { mgr.dispose() }
})

test('resize updates the window on the channel and clamps nonsense', async () => {
  const mgr = createTerminalManager()
  const pool = fakePool()
  try {
    const { id } = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
    const s = mgr.owned(id, 'h').session
    s.resize(120, 40)
    assert.deepEqual(pool.streams[0].windows.at(-1), { rows: 40, cols: 120, h: 0, w: 0 })
    s.resize(-5, 0)
    assert.ok(s.cols >= 2 && s.rows >= 2, 'a nonsense size must clamp, not propagate')
  } finally { mgr.dispose() }
})

test('the machine fence: a session on host A cannot be driven from host B', async () => {
  const mgr = createTerminalManager()
  const pool = fakePool()
  try {
    const { id } = await mgr.open({ pool, machine: 'host-a', cols: 80, rows: 24 })
    assert.equal(mgr.owned(id, 'host-a').session !== undefined, true)
    const foreign = mgr.owned(id, 'host-b')
    assert.match(foreign.error, /different machine/, 'cross-machine attachment must be refused')
    // Same for close.
    const r = mgr.close(id, 'host-b')
    assert.equal(r.ok, false)
    assert.ok(mgr.has(id), 'the refused close must not have killed the session')
  } finally { mgr.dispose() }
})

test('an unknown session id is a clean error, not a crash', () => {
  const mgr = createTerminalManager()
  try {
    const r = mgr.owned('does-not-exist', 'h')
    assert.match(r.error, /no such terminal session/)
  } finally { mgr.dispose() }
})

test('the output ring drops the oldest bytes past its budget and says so', async () => {
  const mgr = createTerminalManager()
  const pool = fakePool()
  try {
    const { id } = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
    const s = mgr.owned(id, 'h').session
    const big = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 8; i++) pool.streams[0].emit('data', big) // ~512KB > 256KB cap
    const out = s.readFrom(0)
    assert.equal(out.lossy, true, 'a reader starting before the retained window is told bytes are missing')
    assert.ok(s.retained <= TERMINAL_RING_BYTES * 1.2, `retained ${s.retained} must stay near the cap`)
    // A reader at the head is not lossy and still gets live output.
    const live = s.readFrom(s.total)
    assert.equal(live.lossy, false)
    assert.deepEqual(live.chunks, [])
  } finally { mgr.dispose() }
})

test('session count is capped so a runaway UI cannot exhaust remote MaxSessions', async () => {
  const mgr = createTerminalManager()
  const pool = fakePool()
  try {
    for (let i = 0; i < TERMINAL_MAX_SESSIONS; i++) {
      const r = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
      assert.equal(r.ok, true, `session ${i} should open`)
    }
    const over = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
    assert.equal(over.ok, false)
    assert.match(over.error, /too many terminal sessions/)
  } finally { mgr.dispose() }
})

test('closing one session leaves the others running', async () => {
  const mgr = createTerminalManager()
  const pool = fakePool()
  try {
    const a = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
    const b = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
    assert.equal(mgr.close(a.id, 'h').ok, true)
    assert.equal(mgr.has(a.id), false)
    assert.equal(mgr.has(b.id), true, 'closing A must not hang up B')
    assert.equal(mgr.list().length, 1)
  } finally { mgr.dispose() }
})

test('a channel that dies on its own is reported as closed with a note', async () => {
  const mgr = createTerminalManager()
  const pool = fakePool()
  try {
    const { id } = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
    const s = mgr.owned(id, 'h').session
    pool.streams[0].emit('data', 'bye')
    pool.streams[0].emit('close')
    await flush()
    const out = s.readFrom(0)
    assert.equal(out.closed, true)
    assert.match(out.note, /closed/)
    assert.deepEqual(out.chunks, ['bye'], 'output produced before the hangup is still readable')
  } finally { mgr.dispose() }
})

test('a pool without shell() is refused with a clear reason', async () => {
  const mgr = createTerminalManager()
  try {
    const r = await mgr.open({ pool: { exec: async () => ({}) }, machine: 'h' })
    assert.equal(r.ok, false)
    assert.match(r.error, /cannot open an interactive shell/)
  } finally { mgr.dispose() }
})

test('a failing shell open is surfaced, not swallowed', async () => {
  const mgr = createTerminalManager()
  try {
    const r = await mgr.open({ pool: { shell: async () => { throw new Error('channel open failure: MaxSessions') } }, machine: 'h' })
    assert.equal(r.ok, false)
    assert.match(r.error, /MaxSessions/)
  } finally { mgr.dispose() }
})

test('dispose hangs up every session (plugin unload must not leak shells)', async () => {
  const mgr = createTerminalManager()
  const pool = fakePool()
  const a = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
  const b = await mgr.open({ pool, machine: 'h', cols: 80, rows: 24 })
  assert.equal(mgr.size(), 2)
  mgr.dispose()
  assert.equal(mgr.size(), 0)
  assert.ok(pool.streams.every((s) => s.ended), 'every remote shell must be hung up')
  assert.equal(mgr.has(a.id) || mgr.has(b.id), false)
})
