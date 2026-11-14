// The API path must follow the page's BASE, not the server root.
//
// Why this exists: the plugin registered its routes at the server ROOT
// ('/dsh-remote/...'), and the client asked for them ROOT-ABSOLUTE. That is
// correct on a plain `dsh web --port 13080`, and WRONG whenever the harness is
// mounted UNDER A PATH PREFIX — the fnOS console serves it at
// '/app/<app>/dsh/', and a prefix-stripping reverse proxy does the same. The
// request then left the mount and hit the gateway's own SPA: HTTP 404 with an
// empty body, so the remote workspace panel silently showed NO hosts.
//
// The page carries <base href="./">, so every relative resource on it already
// resolves against the mount directory. The API route must resolve the same
// way, or the plugin bundle and its API can disagree about where the mount is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fakeTimers } from './harness/fake-timers.js'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Load the client bundle with a page mounted at `baseURI`.
 *
 * @param {string} baseURI - the page's document.baseURI.
 * @param {string} [protocol] - window.location.protocol.
 * @returns {object} the loader's plugin and the requests it made.
 */
function loadClient(baseURI, protocol = 'https:') {
  let plugin
  const requests = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
  }
  const timers = fakeTimers()
  vm.runInNewContext(source, {
    window: {
      location: { protocol, href: baseURI },
      localStorage: { getItem: () => null, setItem: () => {} },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, 'dsh-remote')
          plugin = factory(() => React)
        },
      },
    },
    document: { baseURI },
    navigator: { languages: ['en'], platform: 'Linux x86_64' },
    URL,
    console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options })
      return { ok: true, status: 200, json: async () => ({}) }
    },
  }, { filename: 'lib/client.js' })
  assert.ok(plugin, 'classic module loader receives the plugin')
  return { plugin, requests }
}

/**
 * Minimal client host: the bundle needs `slots` and `locale`, and the
 * remote explorer's first API call is triggered by a betterSidebar session.
 */
function makeHost() {
  const services = new Map()
  const watchers = new Set()
  const ctx = {
    get: (name) => services.get(name),
    effect(fn) { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {} },
    inject(names, cb) {
      const names_ = Array.isArray(names) ? names : [names]
      const watcher = { names: names_, cb, active: false }
      watchers.add(watcher)
      const reconcile = () => {
        const ready = names_.every((name) => services.has(name))
        if (watcher.active === ready) return
        watcher.active = ready
        if (ready) cb(ctx)
      }
      reconcile()
      return () => watchers.delete(watcher)
    },
    on() {},
    logger: { warn() {}, info() {}, debug() {} },
  }
  services.set('slots', {
    inject: (names, cb) => ctx.inject(names, cb),
    register: () => () => {},
    get: () => [],
  })
  services.set('locale', { register: () => {}, bind: () => (key) => key })
  return {
    ctx,
    services,
    set(name, value) {
      services.set(name, value)
      for (const watcher of watchers) {
        if (watcher.names.every((n) => services.has(n)) !== watcher.active) {
          watcher.active = !watcher.active
          if (watcher.active) watcher.cb(ctx)
        }
      }
    },
  }
}

/** A betterSidebar double whose session event starts the remote explorer. */
function betterSidebar() {
  const subscribers = new Set()
  let sessionId = ''
  return {
    registerTab: () => () => {},
    getSnapshot: () => ({ sessionId }),
    subscribeState(callback) { subscribers.add(callback); return () => subscribers.delete(callback) },
    emit(id) { sessionId = id; for (const callback of subscribers) callback(id) },
    openTab() {},
  }
}

/** Drive the bundle's first API call and return the URL it requested. */
async function requestUrl(baseURI, protocol = 'https:') {
  const { plugin, requests } = loadClient(baseURI, protocol)
  const host = makeHost()
  plugin.apply(host.ctx)
  const bs = betterSidebar()
  host.set('betterSidebar', bs)
  bs.emit('test-session')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(requests.length > 0, 'the bundle must issue its first API request')
  return requests[0].url
}

test('a plain root mount keeps the root-absolute route', async () => {
  assert.equal(await requestUrl('http://127.0.0.1:13080/'), '/dsh-remote/explorer-auto-open')
})

test('a path-prefixed mount keeps the request inside the mount', async () => {
  // The fnOS console mount: the harness lives under /app/<app>/dsh/.
  const url = await requestUrl('https://nas:5667/app/Harness/dsh/')
  assert.equal(url, '/app/Harness/dsh/dsh-remote/explorer-auto-open')
  assert.ok(url.startsWith('/app/Harness/dsh/'), 'the request must not escape the mount')
})

test('a path-prefixed mount behind a reverse proxy resolves the same way', async () => {
  assert.equal(
    await requestUrl('https://example.com/ui/dsh/'),
    '/ui/dsh/dsh-remote/explorer-auto-open',
  )
})

test('the Electron carrier keeps its fixed /api root', async () => {
  assert.equal(
    await requestUrl('dsh-app://host/index.html', 'dsh-app:'),
    '/api/dsh-remote/explorer-auto-open',
  )
})

test('a page without a usable base falls back to the root-absolute route', async () => {
  assert.equal(await requestUrl(''), '/dsh-remote/explorer-auto-open')
})
