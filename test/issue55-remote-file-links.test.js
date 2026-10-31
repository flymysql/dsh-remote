// Issue #55 — "file links inside a remote session don't open".
//
// How a link works in DSH (0.2.0-rc.2): a model-emitted `[x](src/main.c)` or a
// `@src/main.c` chip renders as a button whose click hands the path to the chat,
// which turns it into `dsh-resource://file/session/<sessionId>/<path>` and calls
// `sidebarRight.openResource`. Routing picks the best registered tab type for
// that address; the built-in text preview claims `dsh-resource://file/**` in the
// `fallback` band and reads the file through the HOST's `ctx.fs`.
//
// Why that fails here: for a remote Session the header cwd is the LOCAL MIRROR
// created by this plugin, which starts EMPTY and only fills on `rw_sync`. So the
// click opened a tab, the stat failed, and the chat showed a file-open error.
//
// The fix cannot be "teach the built-in preview about SSH": `ctx.resources`
// allows ONE provider per protocol, and `file` is taken. It also cannot be a
// core patch. The supported seam is an `extension`-band tab type claiming the
// SAME address — which by contract outranks the built-in preview — with a
// conservative synchronous `canOpen`.
//
// The tests below pin BOTH directions, because the dangerous failure here is a
// false positive: if `canOpen` ever claims a LOCAL session's link, every local
// file link in the product breaks (it would be sent to SFTP against a path that
// only exists locally). The negative controls are therefore the point of this
// file, not an afterthought.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const SETTINGS = 'settings.section'

/** Replay the host's dependency bookkeeping (see test/client-lifecycle.test.js). */
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
    set(name, value) { values.set(name, value); for (const w of watchers) reconcile(w) },
    remove(name) { values.delete(name); for (const w of watchers) reconcile(w) },
    inject(names, callback) {
      const watcher = { names: Array.isArray(names) ? [...names] : [names], callback, active: false }
      watchers.add(watcher)
      reconcile(watcher)
      return () => { watchers.delete(watcher); if (watcher.active) { watcher.active = false; watcher.cleanup?.() } }
    },
  }
}

/**
 * Load the classic client bundle in a VM with scripted HTTP answers.
 *
 * `routes` maps a URL substring to a JSON body, so the mirror registry
 * (`/dsh-remote/bindings`) and the file routes can be answered per test and the
 * `canOpen` predicate can be driven from real recorded data rather than a stub.
 */
function loadClient({ routes = {}, sessions = [] } = {}) {
  let plugin
  const requests = []
  const effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    // Real `useState` CALLS a function initializer; a double that returned the
    // function itself would silently hand the component a thunk instead of the
    // value (and hide any lazy-init bug).
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: (fn) => { effects.push(fn) },
  }
  vm.runInNewContext(source, {
    window: {
      location: { protocol: 'https:' },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {}, get length() { return 0 }, key: () => null },
      __ModuleLoader__: { load({ id, factory }) { plugin = factory(() => React) } },
    },
    navigator: { languages: ['en'], platform: 'Linux x86_64' },
    URL,
    console,
    fetch: async (url) => {
      requests.push(url)
      for (const [needle, body] of Object.entries(routes)) {
        if (String(url).includes(needle)) return { ok: true, json: async () => body }
      }
      return { ok: true, json: async () => ({}) }
    },
  }, { filename: 'lib/client.js' })
  return { plugin, requests, effects, sessions }
}

/** A host whose `sidebarRightTabs` records every registration. */
function sidebarHost({ sessions, rejectLinkType = false } = {}) {
  const types = new Map()
  return {
    types,
    tabs: {
      register(type) {
        // A DSH whose tab registry cannot express an address claim FOR THE CORE
        // scheme. The plugin must survive this: file links simply keep working
        // the old way. (`dsh-resource://dsh-remote/**` is the plugin's own
        // scheme and has shipped for many versions, so it is not what a legacy
        // build would reject.)
        if (rejectLinkType && (type.patterns || []).some((p) => p.startsWith('dsh-resource://file/'))) {
          throw new Error('this DSH build does not support address claims')
        }
        // The real registry throws on a duplicate id/kind, so a test double that
        // silently overwrote would hide the wiring mistake it exists to catch.
        assert.ok(!types.has(type.kind), `duplicate tab kind ${type.kind}`)
        types.set(type.kind, type)
        return () => types.delete(type.kind)
      },
      get(kind) { return types.get(kind) },
    },
    sessionsService: sessions
      ? { list: { getSnapshot: () => ({ byId: Object.fromEntries(sessions.map((s) => [s.id, s])) }) } }
      : undefined,
  }
}

const MIRROR = {
  dir: '/home/dev/.dsh/remote-workspaces/host-user-22',
  host: 'host', port: 22, username: 'user', remotePath: '/srv/app',
}

/** Boot the plugin far enough that the sidebar type is registered. */
function bootWithSidebar({ routes = {}, sessions = [], rejectLinkType = false } = {}) {
  const { plugin, requests } = loadClient({ routes, sessions })
  const host = sidebarHost({ sessions, rejectLinkType })
  const cleanups = []
  const bodies = new Map()
  const slots = {
    inject: (n, cb) => { cb(); return () => {} },
    register(meta, render) { bodies.set(meta.key, render); return () => bodies.delete(meta.key) },
  }
  const services = new Map([
    ['slots', slots],
    ['locale', { register: () => () => {}, bind: () => (k) => k }],
    ['sidebarRightTabs', host.tabs],
  ])
  // The plugin learns each Session's cwd from the `sessions` service and caches
  // the service object; without it `sessionCwdFor()` returns '' and `canOpen`
  // can never prove a mirror — so this seat is part of the fix's contract, not
  // test scaffolding.
  if (host.sessionsService) services.set('sessions', host.sessionsService)
  const inner = {
    get: (n) => services.get(n),
    effect: (cb) => { const c = cb(); if (typeof c === 'function') cleanups.push(c); return c },
    inject: (names, cb) => {
      if (names.every((n) => services.has(n))) cb({ get: (n) => services.get(n), effect: inner.effect })
      return () => {}
    },
  }
  plugin.apply({
    get: (n) => services.get(n),
    inject: (names, cb) => {
      if (names.every((n) => services.has(n))) cb(inner)
      return () => {}
    },
    effect: inner.effect,
  })
  return { types: host.types, requests, cleanups, bodies }
}

/** Render the link body for an address and read the REMOTE path it decided on. */
function remotePathFor(bodies, address, sessionId) {
  const body = bodies.get('dsh-remote/remote-link')
  assert.ok(body, 'the link body must be registered')
  const node = body({
    sessionId,
    useTabInfo: () => ({ tab: { navigation: { address } } }),
  })
  // The unresolved state renders a plain explanatory element; the resolved one
  // renders the same editor the explorer uses (`RemoteFileTab`).
  if (node.type !== 'RemoteFileTab' && typeof node.type !== 'function') return null
  return node.props.tab.path
}

// ── the address grammar ────────────────────────────────────────────────────

test('the plugin claims the CORE file address, not just its own', () => {
  const { types } = bootWithSidebar()
  const link = types.get('dsh-remote/remote-link')
  assert.ok(link, 'the remote-link type must be registered')
  assert.deepEqual([...link.patterns], ['dsh-resource://file/**'])
  // Declaring no priority puts it in the `extension` band, which is the ONLY
  // band that outranks a `fallback` type — without this the built-in local
  // preview would keep winning and the fix would do nothing.
  assert.equal(link.priority, undefined)
})

test('canOpen refuses every address that is not a session-scoped core file link', () => {
  const { types } = bootWithSidebar()
  const { canOpen } = types.get('dsh-remote/remote-link')
  for (const address of [
    '',
    'not a url',
    'https://example.com/a.c',
    // This plugin's OWN scheme (the explorer's): a different claimant owns it.
    'dsh-resource://dsh-remote/s1/%2Fworkspace%2Fa.c',
    // `file` with no scope.
    'dsh-resource://file/',
    // An `absolute/` scope cannot be mapped back onto any mirror, so it must be
    // refused rather than guessed at.
    'dsh-resource://file/absolute/%2Fhome%2Fu%2Fa.c',
    // A session scope with no path at all.
    'dsh-resource://file/session/s1',
  ]) {
    assert.equal(canOpen(address), false, `must not claim ${JSON.stringify(address)}`)
  }
})

test('canOpen refuses a LOCAL session link (the destructive false positive)', () => {
  // This is the regression that would matter most: an `extension` type claiming
  // `dsh-resource://file/**` wins for EVERY session, so claiming a local one
  // would route a local file into SFTP and break the shipped text preview.
  const { types } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [MIRROR] } },
    sessions: [{ id: 'local-1', cwd: '/home/dev/project' }],
  })
  const { canOpen } = types.get('dsh-remote/remote-link')
  assert.equal(canOpen('dsh-resource://file/session/local-1/src/main.c'), false,
    'a cwd outside every mirror is NOT a remote session')
})

test('canOpen refuses a remote link before the mirror registry has loaded', () => {
  // `canOpen` is synchronous, so it cannot wait for the registry. A cold start
  // must degrade to the previous behaviour rather than gamble on the session
  // being remote: an empty registry can prove nothing.
  const { types } = bootWithSidebar({
    // No `/dsh-remote/bindings` route, so the registry stays empty.
    sessions: [{ id: 'remote-1', cwd: MIRROR.dir + '/sub' }],
  })
  const { canOpen } = types.get('dsh-remote/remote-link')
  assert.equal(canOpen('dsh-resource://file/session/remote-1/src/main.c'), false,
    'an unloaded registry must never claim a link')
})

test('canOpen refuses a session id it does not know', () => {
  const { types } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [MIRROR] } },
    sessions: [{ id: 'remote-1', cwd: MIRROR.dir }],
  })
  const { canOpen } = types.get('dsh-remote/remote-link')
  // The mirror is warm and IS this mirror's dir, but the address names another
  // session. Trusting the address's own id would let a forged link borrow the
  // mirror and read an arbitrary remote path.
  assert.equal(canOpen('dsh-resource://file/session/some-other/src/main.c'), false)
})

// ── the mapping ────────────────────────────────────────────────────────────

test('canOpen ACCEPTS a remote link once the registry is warm', async () => {
  const { types, requests } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [MIRROR] } },
    sessions: [{ id: 'remote-1', cwd: MIRROR.dir + '/sub' }],
  })
  const { canOpen } = types.get('dsh-remote/remote-link')
  // `registerNativeSidebar` warms the registry precisely so the FIRST click of a
  // page load already resolves; wait for that request to settle.
  await new Promise((r) => setImmediate(r))
  assert.ok(requests.some((u) => u.includes('/dsh-remote/bindings')), 'the registry must be warmed on attach')
  assert.equal(canOpen('dsh-resource://file/session/remote-1/src/main.c'), true)
})

test('canOpen CLAIMS Markdown links in a remote session (issue #74 supersedes #64)', async () => {
  // Issue #64 refused .md here so the built-in preview could RENDER it. Issue #74
  // showed that reasoning was wrong for a remote session: the built-in preview reads
  // the LOCAL MIRROR, and a .md that was never synced dies with ENOENT — the user
  // sees nothing. The remote-link editor now opens the file over SFTP and RENDERS
  // it with the host's MarkdownText, so claiming .md is no longer a downgrade.
  const { types } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [MIRROR] } },
    sessions: [{ id: 'remote-1', cwd: MIRROR.dir + '/sub' }],
  })
  const { canOpen } = types.get('dsh-remote/remote-link')
  await new Promise((r) => setImmediate(r))
  assert.equal(canOpen('dsh-resource://file/session/remote-1/README.md'), true)
  assert.equal(canOpen('dsh-resource://file/session/remote-1/docs/guide.markdown'), true)
  assert.equal(canOpen('dsh-resource://file/session/remote-1/NOTES.MD'), true)
  // ...and plain text files in the SAME session keep being claimed.
  assert.equal(canOpen('dsh-resource://file/session/remote-1/src/main.c'), true)
  assert.equal(canOpen('dsh-resource://file/session/remote-1/notes.txt'), true)
})

test('a relative link maps onto the remote root, and an absolute one is kept', async () => {
  const { types } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [MIRROR] } },
    sessions: [{ id: 'remote-1', cwd: MIRROR.dir + '/sub' }],
  })
  const link = types.get('dsh-remote/remote-link')
  await new Promise((r) => setImmediate(r))
  assert.equal(link.canOpen('dsh-resource://file/session/remote-1/src/main.c'), true)
  // The title is what the tab chip shows, and must be the FILE NAME only.
  assert.equal(link.title('dsh-resource://file/session/remote-1/src/main.c'), 'main.c')
  // A percent-encoded path (spaces, '#') survives the round trip.
  assert.equal(link.title('dsh-resource://file/session/remote-1/a%20b%23c.md'), 'a b#c.md')
  // A link written against the MIRROR path (what `@` completion inserts into the
  // prompt) has the mirror prefix stripped, so the remote path is not duplicated
  // under the remote root. The encoded path is its own segment.
  const mirrorAbsolute = 'dsh-resource://file/session/remote-1/' + encodeURIComponent(MIRROR.dir + '/x.c')
  assert.equal(link.canOpen(mirrorAbsolute), true)
  assert.equal(link.title(mirrorAbsolute), 'x.c')
})

test('a Windows-shaped mirror keeps its backslashes and drive-absolute links are kept', async () => {
  const winMirror = {
    dir: 'C:\\Users\\dev\\.dsh\\remote-workspaces\\host-user-22',
    host: 'host', port: 22, username: 'user', remotePath: 'D:\\srv\\app',
  }
  const { types } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [winMirror] } },
    sessions: [{ id: 'w1', cwd: winMirror.dir + '\\sub' }],
  })
  const link = types.get('dsh-remote/remote-link')
  await new Promise((r) => setImmediate(r))
  assert.equal(link.canOpen('dsh-resource://file/session/w1/src/main.c'), true)
  assert.equal(link.title('dsh-resource://file/session/w1/sub\\deep.c'), 'deep.c')
})

// ── safety: the body and the registry contract ─────────────────────────────

test('the body opens the file on the REMOTE host, not under the local mirror', async () => {
  // The mapping is the real bug surface: a wrong path would show the WRONG
  // remote file, which is worse than failing to open. A relative link is
  // mirror-rooted, so it must be joined onto the mirror's recorded remote root.
  const { bodies } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [MIRROR] } },
    sessions: [{ id: 'remote-1', cwd: MIRROR.dir + '/sub' }],
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(
    remotePathFor(bodies, 'dsh-resource://file/session/remote-1/src/main.c', 'remote-1'),
    '/srv/app/src/main.c',
  )
})

test('the body strips a mirror-prefixed path instead of duplicating the root', async () => {
  // `@` completion inserts a path as the reader wrote it — often the LOCAL
  // mirror path. Joining that onto the remote root unchanged would look for
  // /srv/app/home/dev/.dsh/remote-workspaces/... on the remote.
  const { bodies } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [MIRROR] } },
    sessions: [{ id: 'remote-1', cwd: MIRROR.dir + '/sub' }],
  })
  await new Promise((r) => setImmediate(r))
  const address = 'dsh-resource://file/session/remote-1/' + encodeURIComponent(MIRROR.dir + '/x.c')
  assert.equal(remotePathFor(bodies, address, 'remote-1'), '/srv/app/x.c')
})

test('the body keeps an already-absolute remote path as the reader wrote it', async () => {
  const { bodies } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [MIRROR] } },
    sessions: [{ id: 'remote-1', cwd: MIRROR.dir + '/sub' }],
  })
  await new Promise((r) => setImmediate(r))
  const address = 'dsh-resource://file/session/remote-1/' + encodeURIComponent('/etc/nginx/nginx.conf')
  assert.equal(remotePathFor(bodies, address, 'remote-1'), '/etc/nginx/nginx.conf')
})

test('the body explains an unmappable address instead of showing an empty editor', () => {
  const { bodies } = bootWithSidebar({
    // Warm registry, but the Session is LOCAL: nothing to map onto.
    routes: { '/dsh-remote/bindings': { mirrors: [MIRROR] } },
    sessions: [{ id: 'local-1', cwd: '/home/dev/project' }],
  })
  assert.equal(remotePathFor(bodies, 'dsh-resource://file/session/local-1/src/main.c', 'local-1'), null)
})

test('a Windows mirror produces a Windows remote path', async () => {
  const winMirror = {
    dir: 'C:\\Users\\dev\\.dsh\\remote-workspaces\\host-user-22',
    host: 'host', port: 22, username: 'user', remotePath: 'D:\\srv\\app',
  }
  const { bodies } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [winMirror] } },
    sessions: [{ id: 'w1', cwd: winMirror.dir + '\\sub' }],
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(
    remotePathFor(bodies, 'dsh-resource://file/session/w1/src/main.c', 'w1'),
    'D:\\srv\\app\\src\\main.c',
  )
})

// The separator must come from the REMOTE root, not from this machine's path
// style. A Windows client mirroring a Linux host is the ORDINARY case for this
// plugin, and deriving the separator from the local path glued a POSIX root to a
// Windows join ("/home/u/app" + "\" + "x.c") — a path that can never be opened.
// Found by driving the deployed bundle against a real mirror record.
test('a Windows client mirroring a POSIX host joins with a forward slash', async () => {
  const mixed = {
    dir: 'D:\\tmp\\iso\\remote-workspaces\\9.134.186.191-jimmycppliu-36000\\QQMail',
    host: '9.134.186.191', port: 36000, username: 'jimmycppliu',
    remotePath: '/home/jimmycppliu/QQMail',
  }
  const { bodies } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [mixed] } },
    sessions: [{ id: 'm1', cwd: mixed.dir + '\\sub' }],
  })
  await new Promise((r) => setImmediate(r))
  assert.equal(
    remotePathFor(bodies, 'dsh-resource://file/session/m1/blocksvr/main.cc', 'm1'),
    '/home/jimmycppliu/QQMail/blocksvr/main.cc',
    'a POSIX remote root must never be joined with a backslash',
  )
  // The mirror prefix is still stripped when it arrives with either separator,
  // and the local side folds case because Windows paths do.
  const prefixed = 'dsh-resource://file/session/m1/' + encodeURIComponent(mixed.dir + '\\x.c')
  assert.equal(remotePathFor(bodies, prefixed, 'm1'), '/home/jimmycppliu/QQMail/x.c')
  const prefixedLower = 'dsh-resource://file/session/m1/'
    + encodeURIComponent(mixed.dir.toLowerCase().replace(/\\/g, '/') + '/y.c')
  assert.equal(remotePathFor(bodies, prefixedLower, 'm1'), '/home/jimmycppliu/QQMail/y.c',
    'the comparison is separator- and case-insensitive on the Windows side')
})

test('a drive-letter path is refused on a POSIX remote rather than invented into it', async () => {
  const mixed = {
    dir: 'D:\\tmp\\iso\\remote-workspaces\\host-user-22',
    host: 'host', port: 22, username: 'user', remotePath: '/srv/app',
  }
  const { bodies } = bootWithSidebar({
    routes: { '/dsh-remote/bindings': { mirrors: [mixed] } },
    sessions: [{ id: 'm1', cwd: mixed.dir + '\\sub' }],
  })
  await new Promise((r) => setImmediate(r))
  // `D:/elsewhere/x.c` is a LOCAL path outside the mirror. Nothing on a Linux
  // remote can name it, so the honest answer is "cannot resolve"; inventing
  // "/srv/app/D:/elsewhere/x.c" would show a confusing error instead.
  const addr = 'dsh-resource://file/session/m1/' + encodeURIComponent('D:/elsewhere/x.c')
  assert.equal(remotePathFor(bodies, addr, 'm1'), null)
})

test('the link body is registered under the same kind as the type', () => {
  const { types } = bootWithSidebar()
  // The pane seat finds the body under the DEFINITION's own id, so a mismatch
  // would render an empty pane rather than an error.
  assert.ok(types.has('dsh-remote/remote-link'))
})

test('a second registration of the same kind is a wiring error, not a silent overwrite', () => {
  // The double asserts uniqueness (as the real registry does), so this proves
  // the plugin registers each kind exactly once per lifetime.
  assert.doesNotThrow(() => bootWithSidebar())
})

test('no terminal tab type is registered: DSH owns the core terminal', () => {
  // Issue #55's second ask is "the terminal should be the REMOTE one". This
  // plugin must NOT pretend to provide it: DSH's sidebar terminal is a core
  // `builtin` type whose PTY comes from the context-global `subprocess` service,
  // which a plugin cannot replace. The supported answer is the remote DSH Web UI
  // (issue #46), whose terminal genuinely runs on the remote host.
  const { types } = bootWithSidebar()
  assert.equal(types.has('terminal'), false, 'never shadow the core terminal type')
  assert.equal([...types.keys()].some((k) => /terminal/i.test(k)), false)
})

// ── compatibility: the address-claiming half is not universal ──────────────

test('a DSH whose tab registry rejects address claims degrades instead of breaking', () => {
  // The plugin supports BOTH the 0.1.x and 0.2.x DSH lines, and the
  // `patterns`/`canOpen` contract is what 0.2.x exposes. On a build that cannot
  // express an address claim the ONLY acceptable outcomes are "the link type is
  // absent" and "the explorer and file types still work" — a throw here would
  // take the whole optional integration down with it.
  let result
  assert.doesNotThrow(() => { result = bootWithSidebar({ rejectLinkType: true }) })
  const { types, bodies } = result
  assert.equal(types.has('dsh-remote/remote-link'), false, 'the link type is absent, as designed')
  assert.ok(types.has('dsh-remote/explorer'), 'the explorer must survive')
  assert.ok(types.has('dsh-remote/file'), 'the file type must survive')
  // And no orphaned body is left behind for a kind nothing claims.
  assert.equal(bodies.has('dsh-remote/remote-link'), false)
  assert.ok(bodies.has('dsh-remote/file'))
})

test('the link type and its body are registered together on a supporting build', () => {
  const { types, bodies } = bootWithSidebar()
  assert.ok(types.has('dsh-remote/remote-link'))
  assert.ok(bodies.has('dsh-remote/remote-link'), 'the body must accompany the type')
})
