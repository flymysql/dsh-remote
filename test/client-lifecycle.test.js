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

function loadClient(protocol = 'https:', platform = 'Linux x86_64') {
  let plugin
  const requests = []
  // Effects are recorded (and run on demand by `runEffects`) so a component
  // body's React.useEffect logic is testable without a real reconciler.
  const effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [value, () => {}],
    useEffect: (fn) => { effects.push(fn) },
  }
  // Minimal Storage stand-in so the issue #32 eager migration is testable.
  const store = new Map()
  const localStorage = {
    get length() { return store.size },
    key(i) { return [...store.keys()][i] ?? null },
    getItem(k) { return store.has(k) ? store.get(k) : null },
    setItem(k, v) { store.set(k, String(v)) },
    removeItem(k) { store.delete(k) },
  }
  vm.runInNewContext(source, {
    window: {
      location: { protocol },
      localStorage,
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
    navigator: { languages: ['en'], platform },
    URL,
    console,
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({}) }
    },
  }, { filename: 'lib/client.js' })
  assert.ok(plugin, 'classic module loader receives the plugin')
  return { plugin, requests, effects, runEffects: () => effects.forEach((fn) => fn()), store, localStorage }
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

// Issue #32 regression: the remote explorer must not treat better-sidebar's
// session-shared `expanded` array as its own state, and it must evict the
// remote paths an older dsh-remote left there (that set is persisted, and the
// built-in local Files tree loads every entry through a LOCAL fs.realpath, so a
// remote /home/... path became D:\home\... -> ENOENT).
test('remote explorer owns its expansion and heals a polluted shared set', (t) => {
  const { plugin } = loadClient()
  const host = createHost()
  t.after(() => host.ctx.dispose())
  plugin.apply(host.ctx)

  const updates = []
  const bs = betterSidebar()
  bs.openTab = () => {}
  bs.updateTab = (id, patch) => updates.push({ id, patch })
  host.services.set('betterSidebar', bs)

  const descriptor = bs.tabs.get('dsh-remote:explorer')
  assert.ok(descriptor, 'explorer tab registers')

  // The framework hands the tab the SESSION-shared pair; a polluted set already
  // holds two remote paths.
  const shared = ['/home/os/IsaacLab', '/home/os/IsaacLab/source']
  const toggled = []
  const tab = { id: 'tab-1', type: 'dsh-remote:explorer' }
  const rendered = descriptor.component({
    ctx: host.ctx, tab, scope: { sessionId: 's1' }, visible: true,
    expanded: shared, onToggleDir: (p) => toggled.push(p),
  })

  // The tree's own expansion starts EMPTY — the shared set is not its state.
  // (Arrays cross a VM realm boundary, so compare copies, not prototypes.)
  assert.deepEqual([...rendered.props.expanded], [], 'the shared set must not seed the tree')
  assert.equal(rendered.props.expanded === shared, false)
  // Toggling goes to the TAB's meta, never into the shared set.
  rendered.props.onToggleDir('/home/os/IsaacLab/lib')
  assert.deepEqual([...toggled], [], 'toggling must not write into the shared set')
  assert.deepEqual([...updates.at(-1).patch.meta.remoteExpanded], ['/home/os/IsaacLab/lib'])

  // Healing (root-scoped): exactly the current remote root and its children.
  const mirror = 'C:\\Users\\me\\.dsh\\remote-workspaces\\h-u-22\\IsaacLab'
  const polluted = [...toggled, ...['/home/os/IsaacLab', '/home/os/IsaacLab/source',
    '/home/other/dir', '/unrelated/local/dir', mirror]]
  const evicted = []
  const healing = descriptor.component({
    ctx: host.ctx, tab: { id: 'tab-2', type: 'dsh-remote:explorer' },
    scope: { sessionId: 's1' }, visible: true,
    expanded: polluted, onToggleDir: (p) => evicted.push(p),
  })
  const stray = [...healing.props.evictStray('/home/os/IsaacLab')]
  assert.deepEqual(stray, ['/home/os/IsaacLab', '/home/os/IsaacLab/source'],
    'only the current remote root and its children are evicted')
  assert.deepEqual([...evicted], ['/home/os/IsaacLab', '/home/os/IsaacLab/source'])
  // A local mirror path and an unrelated directory are never evicted.
  assert.equal(stray.includes(mirror), false)
  assert.equal(stray.includes('/unrelated/local/dir'), false)
  assert.equal(stray.includes('/home/other/dir'), false)
  // A "/" root evicts only exact-match entries (the bare root itself).
  assert.deepEqual([...healing.props.evictStray('')], [])
})

// The rule that heals EXISTING pollution (no remote root needed): on Windows a
// POSIX-absolute entry can never be a valid local path, so every stray remote
// path is swept even if it belonged to a previous remote root.
test('windows hosts sweep every POSIX-absolute entry from the shared set', (t) => {
  const { plugin } = loadClient('https:', 'Win32')
  const host = createHost()
  t.after(() => host.ctx.dispose())
  plugin.apply(host.ctx)

  const bs = betterSidebar()
  bs.openTab = () => {}
  bs.updateTab = () => {}
  host.services.set('betterSidebar', bs)
  const descriptor = bs.tabs.get('dsh-remote:explorer')

  const mirror = 'C:\\Users\\me\\.dsh\\remote-workspaces\\h-u-22\\IsaacLab'
  const local = 'C:\\Users\\me\\projects'
  const shared = ['/home/os/IsaacLab', '/home/os/IsaacLab/source', '/srv/data',
    '/unrelated/local/dir', local, mirror]
  const evicted = []
  const owned = descriptor.component({
    ctx: host.ctx, tab: { id: 'tab-w', type: 'dsh-remote:explorer' },
    scope: { sessionId: 's1' }, visible: true,
    expanded: shared, onToggleDir: (p) => evicted.push(p),
  })
  const swept = [...owned.props.evictStray('')]
  assert.deepEqual(swept, ['/home/os/IsaacLab', '/home/os/IsaacLab/source', '/srv/data', '/unrelated/local/dir'],
    'every POSIX-absolute entry is swept on Windows')
  // Real Windows paths and the local mirror are preserved.
  assert.equal(swept.includes(local), false)
  assert.equal(swept.includes(mirror), false)
})

// The eager migration is what fixes an ALREADY-affected user: the polluted set
// is persisted in localStorage, and the built-in Files tree loads it before any
// React effect can run. It must therefore be cleaned at activation.
test('activation migrates already-persisted sidebar state on Windows', (t) => {
  const { plugin, store } = loadClient('https:', 'Win32')
  const host = createHost()
  t.after(() => host.ctx.dispose())

  // A user who already hit issue #32: their persisted state holds remote paths.
  const mirror = 'C:\\Users\\me\\.dsh\\remote-workspaces\\h-u-22\\IsaacLab'
  const state = {
    panelOpen: true, width: 420, activePane: 'p', nextTerminal: 1, nextBrowser: 1,
    expanded: ['/home/os/IsaacLab', '/home/os/IsaacLab/source', '/srv/data',
      'C:\\Users\\me\\projects', mirror],
    revealed: [],
    splits: { kind: 'leaf', id: 'p', active: 't', tabs: [{ id: 't', type: 'editor', title: 'Files' }] },
    bottomOpen: false, bottomHeight: 220, bottomOpenedOnce: false,
    bottomSplits: { kind: 'leaf', id: 'q', tabs: [], active: null }, floats: [],
  }
  store.set('dsh-sidebar:v1:session-x', JSON.stringify(state))
  // Unrelated keys and unparsable values must be left alone.
  store.set('other-app:key', JSON.stringify({ expanded: ['/home/keep'] }))
  store.set('dsh-sidebar:v1:broken', '{not json')

  plugin.apply(host.ctx)
  const bs = betterSidebar()
  bs.openTab = () => {}
  host.services.set('betterSidebar', bs) // triggers registerSidebarIntegration

  const after = JSON.parse(store.get('dsh-sidebar:v1:session-x'))
  assert.deepEqual(after.expanded, ['C:\\Users\\me\\projects', mirror],
    'remote paths are gone; real Windows paths and the mirror survive')
  assert.equal(JSON.parse(store.get('other-app:key')).expanded[0], '/home/keep',
    'other applications\' storage is untouched')
  assert.equal(store.get('dsh-sidebar:v1:broken'), '{not json',
    'an unparsable value is left as-is')
})

test('non-windows hosts keep POSIX paths (they are valid local paths there)', (t) => {
  const { plugin } = loadClient('https:', 'MacIntel')
  const host = createHost()
  t.after(() => host.ctx.dispose())
  plugin.apply(host.ctx)

  const bs = betterSidebar()
  bs.openTab = () => {}
  bs.updateTab = () => {}
  host.services.set('betterSidebar', bs)
  const descriptor = bs.tabs.get('dsh-remote:explorer')

  const owned = descriptor.component({
    ctx: host.ctx, tab: { id: 'tab-m', type: 'dsh-remote:explorer' },
    scope: { sessionId: 's1' }, visible: true,
    expanded: ['/Users/me/projects', '/home/os/IsaacLab'], onToggleDir: () => {},
  })
  const evicted = []
  const healing = descriptor.component({
    ctx: host.ctx, tab: { id: 'tab-m2', type: 'dsh-remote:explorer' },
    scope: { sessionId: 's1' }, visible: true,
    expanded: ['/Users/me/projects', '/home/os/IsaacLab'], onToggleDir: (p) => evicted.push(p),
  })
  // Nothing swept without a root, because those paths ARE valid locally on macOS.
  assert.deepEqual([...owned.props.evictStray('')], [])
  assert.deepEqual([...evicted], [])
  // With the remote root known, only that root's own range is swept.
  assert.deepEqual([...healing.props.evictStray('/home/os/IsaacLab')], ['/home/os/IsaacLab'])
})

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
