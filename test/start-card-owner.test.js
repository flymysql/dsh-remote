// Who owns the 远程文件 card on the right sidebar's start page (开始).
//
// The card is a `guide` entry of a native tab type, and two providers can
// publish one:
//   · this plugin registers `dsh-remote/explorer` with a guide entry of its
//     own, so a plain install always lists the card (no switch anywhere);
//   · dsh-better-sidebar registers a native type per tab descriptor it hosts,
//     so `dsh-remote:explorer` ALSO gets a guide row there, governed by the
//     side-card switch in its own settings.
//
// Both at once is what made that switch look broken: turning the type off
// removed better-sidebar's row and left ours, so the card never disappeared.
// These tests pin the contract that fixed it — the card belongs to exactly one
// provider, and when better-sidebar is present that provider is better-sidebar.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Dependency bookkeeping that models arrival and disposal (see client-lifecycle). */
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
    set(name, value) { values.set(name, value); for (const watcher of watchers) reconcile(watcher) },
    remove(name) { values.delete(name); for (const watcher of watchers) reconcile(watcher) },
    inject(names, callback) {
      const watcher = { names: Array.isArray(names) ? [...names] : [names], callback, active: false }
      watchers.add(watcher)
      reconcile(watcher)
      return () => { watchers.delete(watcher); if (watcher.active) { watcher.active = false; watcher.cleanup?.() } }
    },
  }
}

/**
 * The `sidebarRightTabs` registry, shaped like the host's: an id and a kind may
 * each be registered once at a time, and `guide()` is the flattened start-page
 * list (provider-tagged, sorted by `order`) the host renders.
 */
function nativeTabs() {
  const byId = new Map()
  const byKind = new Map()
  return {
    byKind,
    register(definition) {
      assert.ok(!byId.has(definition.id), `tab type id "${definition.id}" is already registered`)
      assert.ok(!byKind.has(definition.kind), `tab kind "${definition.kind}" is already registered`)
      byId.set(definition.id, definition)
      byKind.set(definition.kind, definition)
      return () => {
        byId.delete(definition.id)
        if (byKind.get(definition.kind) === definition) byKind.delete(definition.kind)
      }
    },
    guide() {
      return [...byKind.values()]
        .flatMap((definition) => (definition.guide ?? []).map((entry) => ({
          ...entry, kind: definition.kind, providerId: definition.id,
        })))
        .sort((left, right) => left.order - right.order)
    },
  }
}

/** better-sidebar's service face, as far as this plugin uses it. */
function betterSidebar() {
  const tabs = new Map()
  return {
    tabs,
    registerTab(tab) { tabs.set(tab.id, tab); return () => tabs.delete(tab.id) },
    // An empty session id means the auto-open path stops immediately (issue #13).
    getSnapshot() { return { sessionId: '' } },
    subscribeState() { return () => {} },
    openTab() { assert.fail('nothing in this harness opens a tab') },
  }
}

function loadClient() {
  let plugin
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  }
  const store = new Map()
  vm.runInNewContext(source, {
    window: {
      location: { protocol: 'https:' },
      localStorage: {
        get length() { return store.size },
        key(i) { return [...store.keys()][i] ?? null },
        getItem(k) { return store.has(k) ? store.get(k) : null },
        setItem(k, v) { store.set(k, String(v)) },
        removeItem(k) { store.delete(k) },
      },
      __ModuleLoader__: { load({ factory }) { plugin = factory(() => React) } },
    },
    navigator: { languages: ['en'], platform: 'Linux x86_64' },
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
      getElementById: () => null,
    },
    URL,
    console,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  }, { filename: 'lib/client.js' })
  assert.ok(plugin, 'the classic module loader receives the plugin')
  return plugin
}

/**
 * Activate the plugin and hand back the registries.
 * @param {object} [options] - `betterSidebar` present at activation, if any;
 *   `deferTabs` leaves the native registry out so its late arrival is testable.
 */
function mount({ betterSidebar: bs, deferTabs = false } = {}) {
  const registrations = []
  const services = dependencies([
    ['locale', { register: () => () => {}, bind: () => (key) => key }],
    ['slots', {
      inject: (name, callback) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(meta) { registrations.push(meta); return () => {} },
    }],
  ])
  const tabHost = nativeTabs()
  if (!deferTabs) services.set('sidebarRightTabs', tabHost)
  if (bs) services.set('betterSidebar', bs)

  // One scope per injection, like Cordis: `effect` cleanups belong to the
  // lifetime of the injection that created them, so removing a dependency
  // really does unwind everything registered underneath it.
  const makeScope = (owned) => ({
    get: (name) => services.values.get(name),
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') owned.push(dispose)
      return dispose
    },
    inject: (names, callback) => services.inject(names, () => {
      const inner = []
      callback(makeScope(inner))
      return () => { for (const dispose of inner.splice(0).reverse()) dispose() }
    }),
  })
  const ctx = makeScope([])
  loadClient().apply(ctx)
  return { tabs: tabHost, services, registrations, ctx }
}

/** The cards on the start page that are about remote files. */
function remoteCards(tabs) {
  return tabs.guide().filter((entry) => entry.kind.startsWith('dsh-remote'))
}

test('a plain install lists the card, and there is no switch for it', () => {
  const { tabs } = mount()
  const cards = remoteCards(tabs)
  assert.equal(cards.length, 1, 'the start page offers the card')
  assert.equal(cards[0].providerId, 'dsh-remote/explorer', 'and it is this plugin’s')
  assert.equal(cards[0].order, 55)
})

test('with better-sidebar installed the card is not ours to publish', () => {
  // Two providers listing one card is the defect: better-sidebar's switch
  // removed its own row and left ours, so the card never went away.
  const bs = betterSidebar()
  const { tabs } = mount({ betterSidebar: bs })
  assert.ok(tabs.byKind.has('dsh-remote/explorer'), 'the tab type itself stays registered')
  assert.deepEqual(remoteCards(tabs), [], 'this plugin contributes no start-page card')
  assert.ok(bs.tabs.has('dsh-remote:explorer'), 'better-sidebar still gets the tree descriptor')
  assert.equal(bs.tabs.has('dsh-remote:file'), false,
    'the file viewer is a resource type, not a page: no descriptor, no dead switch')
})

test('better-sidebar arriving later takes the card over', () => {
  // The two plugins may activate in either order: the card must move, and the
  // handover must not trip the host’s one-id/one-kind registration rules.
  const host = mount()
  assert.equal(remoteCards(host.tabs).length, 1)
  host.services.set('betterSidebar', betterSidebar())
  assert.deepEqual(remoteCards(host.tabs), [])
  assert.ok(host.tabs.byKind.has('dsh-remote/explorer'))
})

test('better-sidebar going away hands the card back', () => {
  const host = mount({ betterSidebar: betterSidebar() })
  assert.deepEqual(remoteCards(host.tabs), [])
  host.services.remove('betterSidebar')
  assert.equal(remoteCards(host.tabs).length, 1, 'a plain install always lists the card')
  assert.equal(remoteCards(host.tabs)[0].providerId, 'dsh-remote/explorer')
})

test('the native registry arriving after better-sidebar never publishes the card', () => {
  // The two services come from different plugins, so either may land first.
  // This order registers the type straight into the handover branch — and must
  // not leave a duplicate registration behind on the way there.
  const host = mount({ betterSidebar: betterSidebar(), deferTabs: true })
  assert.deepEqual(remoteCards(host.tabs), [])
  host.services.set('sidebarRightTabs', host.tabs)
  assert.deepEqual(remoteCards(host.tabs), [])
  assert.ok(host.tabs.byKind.has('dsh-remote/explorer'), 'the type is registered exactly once')
})

test('better-sidebar’s side-card switch is then the only lever', () => {
  const { tabs } = mount({ betterSidebar: betterSidebar() })
  // What better-sidebar's native surface registers for one ENABLED descriptor
  // (its `sync()` runs from `store.subscribe`, so flipping the switch disposes
  // exactly this row).
  const disposeRow = tabs.register({
    id: 'dsh-better-sidebar:dsh-remote:explorer',
    kind: 'dsh-remote:explorer',
    title: () => '远程文件',
    guide: [{ id: 'dsh-remote:explorer', order: 55, title: () => '远程文件' }],
  })
  assert.equal(remoteCards(tabs).length, 1, 'exactly one card on the start page')
  assert.equal(remoteCards(tabs)[0].providerId, 'dsh-better-sidebar:dsh-remote:explorer')

  disposeRow() // the switch goes off
  assert.deepEqual(remoteCards(tabs), [], 'and nothing of ours is left behind')
  assert.ok(tabs.byKind.has('dsh-remote/explorer'), 'the type and its body are untouched')
})

test('the native body stays registered on both compositions', () => {
  // A tab can still be opened by kind (better-sidebar opens
  // `dsh-remote:explorer`, the host may open ours): dropping the guide must not
  // take the body with it.
  for (const bs of [undefined, betterSidebar()]) {
    const { registrations } = mount({ betterSidebar: bs })
    const keys = registrations.map((meta) => `${meta.name}:${meta.key}`)
    assert.ok(keys.includes('sidebar.right.pane.tab:dsh-remote/explorer'))
    assert.ok(keys.includes('sidebar.right.pane.tab:dsh-remote/file'))
  }
})

test('no settings switch of this plugin’s own came back with it', () => {
  // The switch belongs to better-sidebar; this plugin must not grow a second
  // one (nor a preferences route, nor a preferences file).
  assert.doesNotMatch(source, /sidebarExplorerCard|sidebarFileCard|ui-prefs/)
})

test('the file viewer is opened through the host registry, never a descriptor', () => {
  // The viewer only exists relative to an ADDRESS: a better-sidebar descriptor
  // for it could not draw a card (there is no page to open, no path to seed),
  // so its settings switch could only unregister the viewer and refuse file
  // opens — exactly the "switch does nothing visible" report. The tree hands
  // the address to the host instead, which routes it to `dsh-remote/file`.
  assert.doesNotMatch(source, /SIDEBAR_FILE_ID/, 'no descriptor id for the viewer')
  assert.match(source, /openResource\(remoteFileAddress\(/,
    'the tree opens a file by address through ctx.sidebarRight')
  assert.match(source, /patterns: \['dsh-resource:\/\/dsh-remote\/\*\*'\]/,
    'and the type claiming that address is the viewer')
})
