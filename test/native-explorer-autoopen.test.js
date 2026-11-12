// Native right-column auto-open parity (the better-sidebar world has had it
// since #78; the native rightbar never did, so a remote session showed the
// LOCAL mirror in the built-in Files panel with no hint of the remote tree).
//
// Trigger: the conversation-header chip mounts exactly when a session is on
// screen and its cwd resolves to a mirror. Then (and only then) we openTab the
// native explorer — once per session, honoring the #78 opt-out, never fighting
// better-sidebar for the presentation, and never latching a failed call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fakeTimers } from './harness/fake-timers.js'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const CHIP = 'conversation.session.header.utilities:dsh-remote-remote-chip'
const MIRROR_ROOT = 'C:\\Users\\me\\.dsh\\remote-workspaces'
const MIRRORS = [
  { dir: MIRROR_ROOT + '\\10.0.0.1-lucas-22\\proj', host: '10.0.0.1', port: 22, username: 'lucas', remotePath: '/home/lucas/proj', name: 'linuxbox' },
]

/** Load the bundle; `/dsh-remote/bindings` answers the mirror registry. */
function loadClient(storeInit = {}, options = {}) {
  let plugin = null
  const effects = []
  const requests = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: (fn) => { effects.push(fn) },
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
  }
  const store = new Map(Object.entries(storeInit))
  const timers = fakeTimers()
  vm.runInNewContext(source, {
    window: {
      location: { protocol: 'https:', href: 'http://127.0.0.1:3080/' },
      localStorage: options.localStorage || {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      __ModuleLoader__: { load({ factory }) { plugin = factory((n) => (n === 'react' ? React : (() => { throw new Error('unexpected require: ' + n) })())) } },
    },
    navigator: { languages: ['en'], platform: 'Win32' },
    URL, console,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      if (options.fetch) return options.fetch(url, init)
      return { ok: true, json: async () => (String(url).includes('/dsh-remote/bindings') ? { mirrors: MIRRORS } : {}) }
    },
  }, { filename: 'lib/client.js' })
  assert.ok(plugin)
  return { plugin, requests, store, runEffects: () => { const batch = effects.splice(0); batch.forEach((fn) => fn()) } }
}

/** A host whose sidebarRight service is a spy; slots carries the chip seat. */
function createHost(openTabSpy) {
  const registrations = new Map()
  const cleanups = []
  const ctx = {
    get(name) {
      if (name === 'slots') {
        return {
          inject: (slot, cb) => { if (slot !== 'conversation.session.header.utilities') return () => {}; const c = cb(); cleanups.push(c); return c },
          register: (meta, render) => { registrations.set(meta.name + ':' + (meta.key ?? meta.id), { meta, render }); return () => {} },
          get: () => [],
        }
      }
      if (name === 'locale') return { register: () => {}, bind: () => (k) => k }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {} }) } }
      if (name === 'sidebarRight') return { openTab: openTabSpy }
      return undefined
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d },
    inject(names, cb) { if (names.every((n) => ctx.get(n) !== undefined)) cb(ctx) },
    on() {},
    logger: { warn: () => {}, info() {}, debug() {} },
    dispose: () => cleanups.splice(0).reverse().forEach((c) => { try { c() } catch {} }),
  }
  return { ctx, registrations }
}

/** Mount with one session → cwd; flush effects twice (registry fetch lands in between). */
async function mount(cwd, { storeInit, openTab, ...options } = {}) {
  const client = loadClient(storeInit, options)
  const calls = []
  const spy = openTab || ((kind) => calls.push(kind))
  const host = createHost(spy)
  client.plugin.apply(host.ctx)
  const useSessions = (sel) => sel({ byId: { s1: { id: 's1', cwd } } })
  const renderChip = () => host.registrations.get(CHIP).render({ sessionId: 's1', useSessions })
  renderChip()           // registers the mark effect (fires the bindings fetch)
  client.runEffects()
  await new Promise((r) => setImmediate(r))
  renderChip()           // registry warm now; chip effect decides
  client.runEffects()
  await new Promise((r) => setImmediate(r))
  renderChip()           // one more pass: dedupe must hold
  client.runEffects()
  return { calls, renderChip, client }
}

const REMOTE_CWD = MIRROR_ROOT + '\\10.0.0.1-lucas-22\\proj'
const LOCAL_CWD = 'C:\\Users\\me\\projects\\repo'

test('a remote session on screen auto-opens the native explorer tab, once', async () => {
  const { calls } = await mount(REMOTE_CWD)
  assert.deepEqual(calls, ['dsh-remote/explorer'], 'one auto-open per session, not one per render')
})

test('a local session never triggers it', async () => {
  const { calls } = await mount(LOCAL_CWD)
  assert.deepEqual(calls, [])
})

test('the #78 opt-out covers the native world too', async () => {
  const { calls } = await mount(REMOTE_CWD, { storeInit: { 'dsh-remote:explorerAutoOpen': '0' } })
  assert.deepEqual(calls, [])
})

const AUTO_OPEN_ROUTE = '/dsh-remote/explorer-auto-open'
const flush = () => new Promise((resolve) => setImmediate(resolve))
function preferenceFetch(enabled, persisted = true) {
  return async (url, init) => {
    if (String(url).includes(AUTO_OPEN_ROUTE)) {
      if (init && init.method === 'POST') {
        const body = JSON.parse(init.body)
        return { ok: true, json: async () => ({ ok: true, enabled: body.enabled, persisted: true }) }
      }
      return { ok: true, json: async () => ({ ok: true, enabled, persisted }) }
    }
    if (String(url).includes('/dsh-remote/bindings')) return { ok: true, json: async () => ({ mirrors: MIRRORS }) }
    return { ok: true, json: async () => ({}) }
  }
}

test('issue #119: one host OFF covers two isolated browser origins', async () => {
  const fetch = preferenceFetch(false)
  const first = await mount(REMOTE_CWD, {
    storeInit: { 'dsh-remote:explorerAutoOpen': '1' }, // even an old local ON loses to explicit host OFF
    fetch,
  })
  const second = await mount(REMOTE_CWD, { fetch }) // fresh, empty localStorage
  assert.deepEqual(first.calls, [])
  assert.deepEqual(second.calls, [])
})

test('issue #119: a deferred host OFF cannot arrive after an eager openTab', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetch = async (url, init) => {
    if (String(url).includes(AUTO_OPEN_ROUTE) && !(init && init.method === 'POST')) {
      await gate
      return { ok: true, json: async () => ({ ok: true, enabled: false, persisted: true }) }
    }
    return preferenceFetch(true)(url, init)
  }
  const { calls } = await mount(REMOTE_CWD, { fetch })
  assert.deepEqual(calls, [], 'nothing opens while the host preference is pending')
  release()
  await flush()
  await flush()
  assert.deepEqual(calls, [], 'the late OFF still suppresses the first open')
})

test('issue #119: explicit host ON is the positive control and wins over local OFF', async () => {
  const { calls } = await mount(REMOTE_CWD, {
    storeInit: { 'dsh-remote:explorerAutoOpen': '0' },
    fetch: preferenceFetch(true),
  })
  assert.deepEqual(calls, ['dsh-remote/explorer'])
})

test('issue #119: an unset host migrates local OFF instead of failing open', async () => {
  const { calls, client } = await mount(REMOTE_CWD, {
    storeInit: { 'dsh-remote:explorerAutoOpen': '0' },
    fetch: preferenceFetch(true, false),
  })
  assert.deepEqual(calls, [])
  const migration = client.requests.find((r) => r.url.includes(AUTO_OPEN_ROUTE) && r.init && r.init.method === 'POST')
  assert.ok(migration, 'the old local value is written back to an unset host')
  assert.equal(JSON.parse(migration.init.body).enabled, false)
})

test('issue #119: host unreachable keeps local OFF; storage get errors still honor host OFF', async () => {
  const unreachable = await mount(REMOTE_CWD, {
    storeInit: { 'dsh-remote:explorerAutoOpen': '0' },
    fetch: async (url) => {
      if (String(url).includes(AUTO_OPEN_ROUTE)) throw new Error('host unreachable')
      return preferenceFetch(true)(url)
    },
  })
  assert.deepEqual(unreachable.calls, [])

  const throwingStorage = await mount(REMOTE_CWD, {
    localStorage: { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } },
    fetch: preferenceFetch(false),
  })
  assert.deepEqual(throwingStorage.calls, [])
})

test('a throwing openTab is not latched: the next view retries', async () => {
  let fail = true
  const calls = []
  const spy = (kind) => { if (fail) throw new Error('kind not registered yet'); calls.push(kind) }
  const { renderChip, client } = await mount(REMOTE_CWD, { openTab: spy })
  assert.deepEqual(calls, [], 'every early attempt threw, none latched')
  // The kind registers later; the next on-screen pass must retry and succeed
  // — same bundle instance, so the not-latched session is still eligible.
  fail = false
  renderChip()
  client.runEffects()
  await flush()
  assert.deepEqual(calls, ['dsh-remote/explorer'])
})
