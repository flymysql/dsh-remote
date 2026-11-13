import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAutoUpdater } from '../lib/auto-update.js'
import { gtVersion } from '../lib/update.js'

function fixture(overrides = {}) {
  const calls = { probe: 0, apply: [], reload: 0, cleared: 0 }
  let mode = 'auto', time = 1000, tick
  const updater = createAutoUpdater({
    mode: () => mode, isInstalled: () => true,
    probe: async () => { calls.probe++; return { version: '1.0.1' } },
    apply: async (v) => { calls.apply.push(v) },
    diskVersion: () => '1.0.0', loadedVersion: '1.0.0', gtVersion,
    reload: () => { calls.reload++ }, now: () => time,
    setTimer: (fn) => { tick = fn; return { unref() {} } },
    clearTimer: () => { calls.cleared++ }, ...overrides,
  })
  return { updater, calls, setMode: (v) => { mode = v; return updater.modeChanged() }, advance: (ms) => { time += ms }, tick: () => tick?.() }
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

test('manual → auto checks and installs immediately; off prevents future automatic checks', async () => {
  const f = fixture()
  await f.setMode('manual'); await f.updater.start()
  assert.equal(f.calls.probe, 0)
  await f.setMode('auto')
  assert.deepEqual(f.calls.apply, ['1.0.1']); assert.equal(f.calls.reload, 1)
  await f.setMode('off'); f.advance(3600000); f.tick(); await f.updater.check()
  assert.equal(f.calls.probe, 1); assert.equal(f.updater.snapshot().phase, 'paused')
  f.updater.stop(); assert.equal(f.calls.cleared, 1)
})

test('overlapping timer checks share one download and reload', async () => {
  const gate = deferred(); let probes = 0
  const f = fixture({ probe: async () => { probes++; return gate.promise } })
  const first = f.updater.start(); const second = f.updater.check({ force: true }); f.tick()
  gate.resolve({ version: '1.0.1' }); await Promise.all([first, second])
  assert.equal(probes, 1); assert.equal(f.calls.apply.length, 1); assert.equal(f.calls.reload, 1)
})

test('turning off while a registry check is in flight prevents installation', async () => {
  const gate = deferred(); const f = fixture({ probe: () => gate.promise })
  const first = f.updater.start(); await Promise.resolve(); await f.setMode('off')
  gate.resolve({ version: '1.0.1' }); await first
  assert.deepEqual(f.calls.apply, []); assert.equal(f.calls.reload, 0)
})

test('re-enabling auto during an old request starts a fresh check after it settles', async () => {
  const gate = deferred(); let n = 0
  const f = fixture({ probe: () => ++n === 1 ? gate.promise : Promise.resolve({ version: '1.0.1' }) })
  const first = f.updater.start(); await Promise.resolve(); await f.setMode('off')
  const enabled = f.setMode('auto'); gate.resolve({ version: '9.0.0' }); await Promise.all([first, enabled])
  assert.equal(n, 2); assert.deepEqual(f.calls.apply, ['1.0.1'])
})

test('already installed disk version reloads without another registry request or download', async () => {
  const f = fixture({ diskVersion: () => '1.0.1' }); await f.updater.start()
  assert.equal(f.calls.probe, 0); assert.deepEqual(f.calls.apply, []); assert.equal(f.calls.reload, 1)
  assert.equal(f.updater.snapshot().phase, 'reloading')
})

test('explicitly disabled reload reports restart required after installation', async () => {
  const f = fixture({ autoReload: () => false }); await f.updater.start()
  assert.equal(f.calls.apply.length, 1); assert.equal(f.calls.reload, 0)
  assert.equal(f.updater.snapshot().phase, 'restart-required')
})

test('probe and download failures retry with bounded backoff and expose the error', async () => {
  let n = 0
  const f = fixture({ probe: async () => ++n === 1 ? { error: 'HTTP 429' } : { version: '1.0.1' }, apply: async () => { throw new Error('download failed') } })
  await f.updater.start()
  assert.equal(f.updater.snapshot().error, 'HTTP 429'); assert.equal(f.updater.snapshot().nextCheckAt, 61000)
  f.advance(59999); await f.updater.check(); assert.equal(n, 1)
  f.advance(1); await f.updater.check()
  assert.equal(f.updater.snapshot().error, 'download failed'); assert.equal(f.updater.snapshot().nextCheckAt, 181000)
  for (let i = 0; i < 8; i++) { f.advance(1800000); await f.updater.check() }
  const state = f.updater.snapshot(); assert.ok(state.nextCheckAt - state.checkedAt <= 1800000)
})

test('successful checks respect the default 30 minute interval', async () => {
  const f = fixture({ probe: async () => ({ version: '1.0.0' }) }); await f.updater.start()
  assert.equal(f.updater.snapshot().phase, 'current'); assert.equal(f.updater.snapshot().nextCheckAt, 1801000)
  f.advance(1799999); await f.updater.check(); assert.equal(f.updater.snapshot().checkedAt, 1000)
  f.advance(1); await f.updater.check(); assert.equal(f.updater.snapshot().checkedAt, 1801000)
})

test('disposing during download never reloads the disposed plugin', async () => {
  const gate = deferred(); const f = fixture({ apply: () => gate.promise })
  const first = f.updater.start(); await Promise.resolve(); await Promise.resolve()
  f.updater.stop(); gate.resolve(); await first
  assert.equal(f.calls.reload, 0); assert.equal(f.calls.cleared, 1)
})

test('source checkouts never start timers or probe the registry', async () => {
  const f = fixture({ isInstalled: () => false }); await f.updater.start()
  assert.equal(f.calls.probe, 0); assert.equal(f.updater.snapshot().phase, 'unsupported')
})
