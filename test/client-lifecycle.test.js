// Execute the classic client bundle in a VM, like i18n.test.js, without a
// browser or installed DSH packages. These doubles model dependency arrival
// and disposal; they are not a replacement for Cordis integration tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const SETTINGS = 'settings.section'
const HERO = 'conversation.hero.workspace.directoryFlow'
const SIDEBAR = 'sidebar.workspaces.directoryFlow'

// A dependency callback runs only when ALL its requested names exist. Removing
// a dependency disposes the callback; adding it back creates a fresh lifetime.
function dependencies(initial = []) {
  const values = new Map(initial)
  const watchers = new Set()
  function reconcile(watcher) {
    const ready = watcher.names.every((name) => values.has(name))
    if (watcher.active && !ready) {
      watcher.active = false
      watcher.cleanup?.()
    } else if (!watcher.active && ready) {
      watcher.active = true
      watcher.cleanup = watcher.callback()
    }
  }
  return {
    values,
    set(name, value) {
      values.set(name, value)
      for (const watcher of watchers) reconcile(watcher)
    },
    remove(name) {
      values.delete(name)
      for (const watcher of watchers) reconcile(watcher)
    },
    inject(names, callback) {
      const watcher = { names: Array.isArray(names) ? [...names] : [names], callback, active: false }
      watchers.add(watcher)
      reconcile(watcher)
      return () => {
        watchers.delete(watcher)
        if (watcher.active) {
          watcher.active = false
          watcher.cleanup?.()
        }
      }
    },
  }
}

function loadClient(protocol = 'https:') {
  let plugin
  const requests = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [value, () => {}],
  }
  vm.runInNewContext(source, {
    window: {
      location: { protocol },
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, 'dsh-remote')
          plugin = factory((name) => {
            assert.equal(name, 'react', 'bundle requires only its declared React external')
            return React
          })
        },
      },
    },
    navigator: { languages: ['en'] },
    URL,
    console,
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({}) }
    },
  }, { filename: 'lib/client.js' })
  assert.ok(plugin, 'classic module loader receives the plugin')
  return { plugin, requests }
}

function createHost(seats = [SETTINGS]) {
  const slotsAvailable = dependencies(seats.map((name) => [name, true]))
  const services = dependencies()
  const registrations = new Map()
  const dictionaries = new Map()
  const injections = []
  function scope() {
    const cleanups = []
    return {
      get(name) { return services.values.get(name) },
      effect(callback) {
        const cleanup = callback()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
        return cleanup
      },
      inject(names, callback) {
        injections.push([...names])
        const dispose = services.inject(names, () => {
          const inner = scope()
          inner.effect(() => callback(inner))
          return () => inner.dispose()
        })
        cleanups.push(dispose)
        return dispose
      },
      own(cleanup) { cleanups.push(cleanup); return cleanup },
      dispose() {
        for (const cleanup of cleanups.splice(0).reverse()) cleanup()
      },
    }
  }
  const ctx = scope()
  services.set('slots', {
    inject(names, callback) { return ctx.own(slotsAvailable.inject(names, callback)) },
    register(meta, render) {
      const registrationKey = meta.key ? meta.name + ':' + meta.key : meta.name
      assert.ok(slotsAvailable.values.has(meta.name), 'registration must wait for its seat')
      assert.ok(!registrations.has(registrationKey), 'no duplicate remote contribution')
      const entry = { meta, render }
      registrations.set(registrationKey, entry)
      return () => {
        if (registrations.get(registrationKey) === entry) registrations.delete(registrationKey)
      }
    },
  })
  services.set('locale', {
    register(namespace, dictionary) {
      dictionaries.set(namespace, dictionary)
      return () => dictionaries.delete(namespace)
    },
    bind(namespace) { return (key) => dictionaries.get(namespace)?.en[key] || key },
  })
  return { ctx, services, slotsAvailable, registrations, dictionaries, injections }
}

function betterSidebar() {
  const tabs = new Map()
  const subscribers = new Set()
  let sessionId = ''
  return {
    tabs, subscribers,
    registerTab(tab) {
      assert.ok(!tabs.has(tab.id), 'sidebar tab registers once per lifetime')
      tabs.set(tab.id, tab)
      return () => tabs.delete(tab.id)
    },
    getSnapshot() { return { sessionId } },
    subscribeState(callback) { subscribers.add(callback); return () => subscribers.delete(callback) },
    emit(id) { sessionId = id; for (const callback of subscribers) callback() },
    openTab() { assert.fail('empty mirror response must not open a remote tab') },
  }
}

test('manifest requires the current renderer and locale, not native workspace packages', () => {
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-locale',
  ])
})

test('client hard dependencies are slots and locale only', () => {
  assert.deepEqual([...loadClient().plugin.inject], ['slots', 'locale'])
})

test('native right-sidebar attaches late, opens a session-scoped remote file, and disposes', (t) => {
  const { plugin } = loadClient('dsh-app:')
  const host = createHost([SETTINGS, 'sidebar.right.pane.tab'])
  t.after(() => host.ctx.dispose())
  plugin.apply(host.ctx)
  const types = new Map()
  host.services.set('sidebarRightTabs', { register(type) {
    assert.ok(!types.has(type.kind))
    types.set(type.kind, type)
    return () => types.delete(type.kind)
  } })
  assert.deepEqual([...types.keys()], ['dsh-remote/explorer', 'dsh-remote/file'])
  assert.equal(types.get('dsh-remote/explorer').guide.length, 1)
  assert.deepEqual([...types.get('dsh-remote/file').patterns], ['dsh-resource://dsh-remote/**'])
  const explorer = host.registrations.get('sidebar.right.pane.tab:dsh-remote/explorer')
  const file = host.registrations.get('sidebar.right.pane.tab:dsh-remote/file')
  let address
  const child = explorer.render({ sessionId: 'session-one', useTabInfo: () => ({ tab: {
    visible: true, actions: { openResource(value) { address = value } },
  } }) })
  assert.equal(child.props.scope.sessionId, 'session-one')
  child.props.onOpenFile('/workspace/中文 #?.md')
  assert.equal(address, 'dsh-resource://dsh-remote/session-one/%2Fworkspace%2F%E4%B8%AD%E6%96%87%20%23%3F.md')
  const reader = file.render({ sessionId: 'session-one', useTabInfo: () => ({ tab: { navigation: { address } } }) })
  assert.equal(reader.props.tab.path, '/workspace/中文 #?.md')
  assert.equal(types.get('dsh-remote/file').title(address), '中文 #?.md')
  host.services.remove('sidebarRightTabs')
  assert.equal(types.size, 0)
  assert.deepEqual([...host.registrations.keys()], [SETTINGS])
})

for (const protocol of ['https:', 'dsh-app:']) {
  test(`${protocol} chooses its API carrier before sending requests`, async (t) => {
    const { plugin, requests } = loadClient(protocol)
    const host = createHost()
    t.after(() => host.ctx.dispose())
    plugin.apply(host.ctx)
    const bs = betterSidebar()
    host.services.set('betterSidebar', bs)
    bs.emit('test-session')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, (protocol === 'dsh-app:' ? '/api' : '') + '/dsh-remote/resolve-mirror?sessionId=test-session')
  })
}

test('settings register at order 40 without sessions, workspace, or better-sidebar', (t) => {
  const { plugin } = loadClient()
  const host = createHost()
  t.after(() => host.ctx.dispose())
  plugin.apply(host.ctx)
  assert.deepEqual([...host.services.values.keys()], ['slots', 'locale'])
  assert.deepEqual([...host.registrations.keys()], [SETTINGS])
  const settings = host.registrations.get(SETTINGS)
  assert.equal(settings.meta.id, 'dsh-remote')
  assert.equal(settings.meta.order, 40)
  assert.equal(settings.meta.label(), host.dictionaries.get('dsh-remote').en['settings.title'])
  assert.equal(typeof settings.render().type, 'function', 'settings exposes a renderable component')
  assert.ok(host.injections.some((names) => names.length === 1 && names[0] === 'sessions'))
  assert.ok(host.injections.some((names) => names.length === 1 && names[0] === 'betterSidebar'))
  host.ctx.dispose()
  assert.equal(host.registrations.size, 0)
  assert.equal(host.dictionaries.size, 0, 'locale dictionary is disposed with the plugin')
})

test('settings can arrive after apply and remount without duplicate registrations', (t) => {
  const { plugin } = loadClient()
  const host = createHost([])
  t.after(() => host.ctx.dispose())
  plugin.apply(host.ctx)
  assert.equal(host.registrations.size, 0)
  host.slotsAvailable.set(SETTINGS, true)
  assert.equal(host.registrations.size, 1)
  host.slotsAvailable.remove(SETTINGS)
  assert.equal(host.registrations.size, 0)
  host.slotsAvailable.set(SETTINGS, true)
  assert.equal(host.registrations.get(SETTINGS).meta.order, 40)
})

for (const seat of [SIDEBAR, HERO]) {
  test(`${seat} registers independently of the other directory seat`, (t) => {
    const { plugin } = loadClient()
    const host = createHost([SETTINGS, seat])
    t.after(() => host.ctx.dispose())
    plugin.apply(host.ctx)
    const settings = host.registrations.get(SETTINGS)
    assert.deepEqual([...host.registrations.keys()].sort(), [SETTINGS, seat].sort())
    assert.equal(host.registrations.get(seat).meta.priority, -100)
    assert.equal(typeof host.registrations.get(seat).render, 'function')
    host.slotsAvailable.remove(seat)
    assert.deepEqual([...host.registrations.keys()], [SETTINGS])
    host.slotsAvailable.set(seat, true)
    const other = seat === SIDEBAR ? HERO : SIDEBAR
    host.slotsAvailable.set(other, true)
    assert.equal(host.registrations.size, 3)
    assert.equal(host.registrations.get(seat).render, host.registrations.get(other).render)
    assert.equal(host.registrations.get(SETTINGS), settings, 'directory lifecycle leaves settings mounted')
  })
}

test('optional better-sidebar attaches late and cleans up tabs and subscription on removal', (t) => {
  const { plugin } = loadClient()
  const host = createHost()
  t.after(() => host.ctx.dispose())
  plugin.apply(host.ctx)
  const settings = host.registrations.get(SETTINGS)
  const sidebar = betterSidebar()
  host.services.set('betterSidebar', sidebar)
  assert.deepEqual([...sidebar.tabs.keys()], ['dsh-remote:explorer', 'dsh-remote:file'])
  assert.equal(sidebar.subscribers.size, 1)
  host.services.remove('betterSidebar')
  assert.equal(sidebar.tabs.size, 0)
  assert.equal(sidebar.subscribers.size, 0)
  host.services.set('betterSidebar', sidebar)
  assert.equal(sidebar.tabs.size, 2)
  assert.equal(sidebar.subscribers.size, 1)
  assert.equal(host.registrations.get(SETTINGS), settings)
  host.ctx.dispose()
  assert.equal(sidebar.tabs.size, 0)
  assert.equal(sidebar.subscribers.size, 0)
})

test('late sessions supply cwd and disposal restores host-side session fallback', async (t) => {
  const { plugin, requests } = loadClient()
  const host = createHost()
  t.after(() => host.ctx.dispose())
  plugin.apply(host.ctx)
  const settings = host.registrations.get(SETTINGS)
  const sidebar = betterSidebar()
  host.services.set('betterSidebar', sidebar)
  sidebar.emit('before')
  assert.equal(requests.at(-1).url, '/dsh-remote/resolve-mirror?sessionId=before')
  const sessionService = (cwd) => ({ list: { getSnapshot: () => ({ byId: { current: { cwd } } }) } })
  host.services.set('sessions', sessionService('mirror/first'))
  sidebar.emit('current')
  assert.equal(requests.at(-1).url, '/dsh-remote/resolve-mirror?local=mirror%2Ffirst')
  host.services.remove('sessions')
  sidebar.emit('current')
  assert.equal(requests.at(-1).url, '/dsh-remote/resolve-mirror?sessionId=current', 'must not retain disposed sessions')
  host.services.set('sessions', sessionService('mirror/second'))
  sidebar.emit('current')
  assert.equal(requests.at(-1).url, '/dsh-remote/resolve-mirror?local=mirror%2Fsecond')
  assert.equal(host.registrations.get(SETTINGS), settings, 'sessions hotplug leaves settings mounted')
  // Let the stubbed fetch/json promises settle before test cleanup.
  await new Promise((resolve) => setImmediate(resolve))
})
