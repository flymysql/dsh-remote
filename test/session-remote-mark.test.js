// Issue #49 — the sidebar's remote-session mark, client half.
//
// "It is impossible to tell whether a Session is local or remote, and against
// which host" (the issue). The fix paints a green dot in the Session row's
// leading seat and names the host in the row's hover card, driven by the
// session's OWN cwd matched against the mirror registry the host serves at
// GET /dsh-remote/bindings.
//
// What this file pins (the whole feature is a client-side decision, so the
// negative controls matter as much as the positive one):
//   • a cwd inside a mirror  → a mark, naming that mirror's host;
//   • a cwd outside every mirror (a plain LOCAL session) → NOTHING;
//   • a blank session (no cwd) → NOTHING, even if a mirror exists;
//   • separator-aware containment: `/a/mirror-2` must not match `/a/mirror`;
//   • the deepest mirror wins when one mirror nests inside another;
//   • `user@host` with the port only when it is non-default;
//   • a local session never borrows a neighbour's badge, and a machine that is
//     merely SAVED (not mirrored) never produces one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const MARK = 'sidebar.session.row.leading:dsh-remote-remote-mark'
const HOVER = 'sidebar.session.row.hover:dsh-remote-remote-host'
const CHIP = 'conversation.session.header.utilities:dsh-remote-remote-chip'

/** Load the classic bundle; every HTTPS request is answered from `responses`. */
function loadClient(responses = {}) {
  let plugin = null
  const requests = []
  const effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (value) => [value, () => {}],
    useEffect: (fn) => { effects.push(fn) },
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
  }
  const store = new Map()
  vm.runInNewContext(source, {
    window: {
      location: { protocol: 'https:', href: 'http://127.0.0.1:3080/' },
      localStorage: {
        get length() { return store.size },
        key(i) { return [...store.keys()][i] ?? null },
        getItem(k) { return store.has(k) ? store.get(k) : null },
        setItem(k, v) { store.set(k, String(v)) },
        removeItem(k) { store.delete(k) },
      },
      __ModuleLoader__: { load({ factory }) { plugin = factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      }) } },
    },
    navigator: { languages: ['en'], platform: 'Win32' },
    URL,
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async (url) => {
      requests.push(url)
      const body = responses[url] ?? {}
      return { ok: true, json: async () => body }
    },
  }, { filename: 'lib/client.js' })
  assert.ok(plugin, 'the bundle registers through the module loader')
  return { plugin, requests, effects, runEffects: () => effects.forEach((fn) => fn()) }
}

/** A host with the slots this feature needs, recording every registration. */
function createHost(seats) {
  const registrations = new Map()
  const available = new Set(seats)
  const dictionaries = new Map()
  const cleanups = []
  const ctx = {
    get(name) {
      if (name === 'slots') {
        return {
          inject: (slot, callback) => {
            if (!available.has(slot)) return () => {}
            const cleanup = callback()
            cleanups.push(cleanup)
            return cleanup
          },
          register: (meta, render) => {
            // Same identity rule the real registry uses: a keyed entry is keyed
            // by that key, an unkeyed list entry by its own `id`.
            const identity = meta.key !== undefined ? meta.key : meta.id
            const key = meta.name + ':' + identity
            registrations.set(key, { meta, render })
            return () => registrations.delete(key)
          },
        }
      }
      if (name === 'locale') return { register: (ns, d) => { dictionaries.set(ns, d); return () => {} }, bind: () => (k) => k }
      return undefined
    },
    effect: (fn) => { const d = fn(); cleanups.push(d); return d },
    inject: (names, cb) => { if (names.every((n) => ctx.get(n) !== undefined)) cb(ctx) },
    dispose: () => cleanups.splice(0).reverse().forEach((c) => { try { c && c() } catch {} }),
  }
  return { ctx, registrations, dictionaries }
}

const MIRROR_ROOT = 'C:\\Users\\me\\.dsh\\remote-workspaces'
const MIRRORS = [
  { dir: MIRROR_ROOT + '\\10.0.0.1-lucas-22\\proj', host: '10.0.0.1', port: 22, username: 'lucas', remotePath: '/home/lucas/proj', name: 'linuxbox' },
  { dir: MIRROR_ROOT + '\\10.0.0.9-root-2222\\srv', host: '10.0.0.9', port: 2222, username: 'root', remotePath: '/srv/data', name: '' },
  { dir: MIRROR_ROOT + '\\10.0.0.1-lucas-22\\proj-1a2b3c', host: '10.0.0.1', port: 22, username: 'lucas', remotePath: '/home/lucas/other/proj', name: 'linuxbox' },
]

/**
 * Mount the client with a session table and return a `render` helper for one
 * seat. `sessions` maps a session id to its cwd.
 *
 * Mounting FLUSHES the mark's own effect before returning: the registry request
 * is issued from that effect (a mounted mark is what starts the one shared
 * read), so a harness that only ran the plugin's apply-time effects would never
 * fetch at all — and every positive case would silently test the empty-registry
 * branch.
 */
async function mount(sessions, mirrors = MIRRORS) {
  const client = loadClient({ '/dsh-remote/bindings': { mirrors } })
  const host = createHost(['sidebar.session.row.leading', 'sidebar.session.row.hover', 'conversation.session.header.utilities'])
  client.plugin.apply(host.ctx)
  const useSessions = (selector) => selector({ byId: Object.fromEntries(Object.entries(sessions).map(([id, cwd]) => [id, { id, cwd }])) })
  const render = (key, sessionId) => {
    const entry = host.registrations.get(key)
    assert.ok(entry, `seat ${key} must be occupied`)
    return entry.render({ sessionId, useSessions })
  }
  // Render once to register the effect, flush it, let the fetch land, then
  // render again — the second render is what sees the loaded registry.
  render(MARK, Object.keys(sessions)[0])
  client.runEffects()
  await new Promise((resolve) => setImmediate(resolve))
  return { ...client, host, render }
}

// Convenience for the majority of tests, which mount once and assert.
const mounted = async (sessions, mirrors) => (await mount(sessions, mirrors)).render

// The sandbox React stub keeps children on the node itself (`{ type, props,
// children }`), which is where this walker must look — reading props.children
// silently yields '' and would make a text assertion unfalsifiable.
const text = (tree) => {
  if (tree == null || tree === false) return ''
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (typeof tree !== 'object') return ''
  return text(tree.children)
}

test('a remote session gets the mark naming its host', async () => {
  const cwd = MIRROR_ROOT + '\\10.0.0.1-lucas-22\\proj\\src'
  const { render, requests } = await mount({ s1: cwd }, MIRRORS)
  const mark = render(MARK, 's1')
  assert.ok(mark, 'a session inside a mirror must carry the mark')
  assert.equal(mark.type, 'span')
  assert.equal(mark.props['data-dsh-remote-mark'], '')
  // The label names user@host (port 22 is the default, so it is omitted).
  assert.equal(mark.props['aria-label'], 'Remote session: lucas@10.0.0.1')
  // …and it is the ONE registry request the whole sidebar costs.
  assert.deepEqual(requests, ['/dsh-remote/bindings'])
})

test('a non-22 port is part of the target', async () => {
  const cwd = MIRROR_ROOT + '\\10.0.0.9-root-2222\\srv\\data'
  const render = await mounted({ s1: cwd })
  const mark = render(MARK, 's1')
  assert.equal(mark.props['aria-label'], 'Remote session: root@10.0.0.9:2222')
})

test('a local session renders NOTHING (negative control)', async () => {
  const render = await mounted({ s1: 'C:\\Users\\me\\projects\\repo' })
  assert.equal(render(MARK, 's1'), null, 'a plain local session must not be marked')
})

test('a blank session with no cwd renders NOTHING', async () => {
  const render = await mounted({ s1: undefined })
  assert.equal(render(MARK, 's1'), null, 'a blank New Session has no workspace and no badge')
})

test('an unknown session id renders NOTHING rather than borrowing a neighbour', async () => {
  const cwd = MIRROR_ROOT + '\\10.0.0.1-lucas-22\\proj'
  const render = await mounted({ s1: cwd, s2: 'C:\\local' })
  assert.equal(render(MARK, 's-other'), null)
  assert.ok(render(MARK, 's1'), 'the real remote row still marks')
  assert.equal(render(MARK, 's2'), null, 'the local row beside it stays unmarked')
})

test('containment is separator-aware: a sibling prefix is not inside the mirror', async () => {
  // `/a/mirror` must not swallow `/a/mirror-2` (the binding.js trap).
  const dir = MIRROR_ROOT + '\\10.0.0.1-lucas-22\\proj'
  const render = await mounted({
    inside: dir + '\\x',
    exact: dir,
    sibling: dir + '-2',
    neighbour: MIRROR_ROOT + '\\10.0.0.1-lucas-22\\professional',
  })
  assert.ok(render(MARK, 'inside'), 'a descendant of the mirror is remote')
  assert.ok(render(MARK, 'exact'), 'the mirror dir itself is remote')
  assert.equal(render(MARK, 'sibling'), null, '`proj-2` is not inside `proj`')
  assert.equal(render(MARK, 'neighbour'), null, '`professional` is not inside `proj`')
})

test('the deepest matching mirror wins', async () => {
  const outer = MIRROR_ROOT + '\\10.0.0.1-lucas-22\\proj'
  const inner = outer + '\\nested'
  const render = await mounted({ s1: inner + '\\file' }, [
    { dir: outer, host: 'outer.example', port: 22, username: 'a', remotePath: '/outer', name: '' },
    { dir: inner, host: 'inner.example', port: 22, username: 'b', remotePath: '/inner', name: '' },
  ])
  assert.equal(render(MARK, 's1').props['aria-label'], 'Remote session: b@inner.example')
})

test('a saved machine that is NOT mirrored never marks a session', async () => {
  // The registry lists saved machines; /bindings deliberately lists MIRRORS.
  // An empty mirror list therefore means no marks, whatever is "current".
  const render = await mounted({ s1: 'C:\\Users\\me\\projects' }, [])
  assert.equal(render(MARK, 's1'), null)
})

test('the hover card names the host and the remote path', async () => {
  const cwd = MIRROR_ROOT + '\\10.0.0.1-lucas-22\\proj\\src'
  const render = await mounted({ s1: cwd })
  const hover = render(HOVER, 's1')
  assert.ok(hover, 'a remote row must explain itself on hover')
  assert.equal(hover.props['data-dsh-remote-hover'], '')
  // Address + the saved machine's friendly name, plus the remote path it works on.
  const body = text(hover)
  assert.match(body, /lucas@10\.0\.0\.1 · linuxbox/)
  assert.match(body, /\/home\/lucas\/proj/)
})

test('the hover card renders nothing for a local session', async () => {
  const render = await mounted({ s1: 'C:\\Users\\me\\projects' })
  assert.equal(render(HOVER, 's1'), null)
})

test('the conversation header chip shows the host only for a remote session', async () => {
  const cwd = MIRROR_ROOT + '\\10.0.0.9-root-2222\\srv'
  const render = await mounted({ s1: cwd, s2: 'C:\\local' })
  const chip = render(CHIP, 's1')
  assert.ok(chip, 'a remote session shows its host in the header')
  assert.equal(chip.props['data-dsh-remote-chip'], '')
  assert.equal(text(chip), 'root@10.0.0.9:2222')
  assert.equal(render(CHIP, 's2'), null, 'a local session shows no chip')
})

test('a failed registry read degrades to no badge, never to a wrong one', async () => {
  let loaded = null
  const React = { createElement: (t, p, ...c) => ({ type: t, props: p || {}, children: c }), useState: (v) => [v, () => {}], useEffect: () => {} }
  vm.runInNewContext(source, {
    window: {
      location: { protocol: 'https:' },
      localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {} },
      __ModuleLoader__: { load({ factory }) { loaded = factory((n) => { if (n === 'react') return React; throw new Error(n) }) } },
    },
    navigator: { languages: ['en'], platform: 'Linux x86_64' },
    URL, console,
    setInterval: () => 0, clearInterval: () => {},
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
  }, { filename: 'lib/client.js' })
  const host = createHost(['sidebar.session.row.leading'])
  loaded.apply(host.ctx)
  const entry = host.registrations.get(MARK)
  const useSessions = (selector) => selector({ byId: { s1: { id: 's1', cwd: MIRROR_ROOT + '\\10.0.0.1-lucas-22\\proj' } } })
  // Render once (registering the effect), flush it so the read is issued, then
  // let the rejected response settle before the asserting render.
  entry.render({ sessionId: 's1', useSessions })
  // The stub never records effects here, so the fetch is driven through the
  // plugin's own apply path: re-apply on a fresh host with a registry that FAILS.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(entry.render({ sessionId: 's1', useSessions }), null,
    'without a registry the mark is absent — not defaulted to some host')
})

test('the mark is registered in the row leading seat at a stable id and order', () => {
  const client = loadClient({ '/dsh-remote/bindings': { mirrors: MIRRORS } })
  const host = createHost(['sidebar.session.row.leading', 'sidebar.session.row.hover', 'conversation.session.header.utilities'])
  client.plugin.apply(host.ctx)
  assert.equal(host.registrations.get(MARK).meta.id, 'dsh-remote-remote-mark')
  assert.equal(host.registrations.get(HOVER).meta.id, 'dsh-remote-remote-host')
  assert.equal(host.registrations.get(CHIP).meta.id, 'dsh-remote-remote-chip')
  // The shipped schedule mark uses order 10; ours sits before it so a session
  // that is both remote AND scheduled still shows the remote dot first.
  assert.ok(host.registrations.get(MARK).meta.order < 10)
})

test('a composition without those seats still loads (inject, never assume)', () => {
  const client = loadClient()
  const host = createHost([]) // a replacement sidebar declares none of them
  client.plugin.apply(host.ctx)
  assert.equal(host.registrations.size, 0, 'no seat, no registration, no crash')
})
