// Architecture alignment with the host's primitives (P0 of the 2026-11 review).
//
// The plugin used to hand-roll every overlay and call native `window.confirm`;
// the host ships Modal/Menu/writeClipboard in the shared primitives module.
// Native confirm is visually alien, can be suppressed by embedders, and its
// blocking call does not compose with our async flows. These tests drive the
// REAL settings page (same driver as settings-credentials-ui.test.js) through a
// machine deletion and pin BOTH paths:
//
//   · with a Modal-shipping host: the confirm rides the host Modal (portal,
//     focus trap, autofocus) and window.confirm is provably never consulted;
//   · without one: our own press-guarded portalized overlay carries it.
//
// Plus the structural pins for the softer adoptions (context menu → host Menu,
// clipboard → writeClipboard), whose behavioral paths are covered elsewhere.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { fakeTimers } from './harness/fake-timers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const require = createRequire(import.meta.url)
const React = require('react')
const src = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

const MACHINE = {
  id: 'm-test', name: 'box', host: '10.0.0.9', port: 22, username: 'root',
  passwordSet: true, credentialBackend: 'plain', useAgent: false, backend: 'native', recentWorkspaces: [],
}

/** Mount the client with a primitives stub; `withModal` toggles the host Modal. */
function mountClient({ withModal }) {
  const list = [{ ...MACHINE }]
  const calls = []
  const fetchStub = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ method, url: String(url), body })
    const reply = (obj) => ({ ok: true, status: 200, json: async () => obj })
    if (String(url).includes('/dsh-remote/machines')) {
      if (method === 'POST' && body && body.action === 'delete') {
        const at = list.findIndex((m) => m.id === body.id)
        if (at >= 0) list.splice(at, 1)
        return reply({ ok: true, machines: list.map((m) => ({ ...m })), currentId: '' })
      }
      return reply({ machines: list.map((m) => ({ ...m })), currentId: '' })
    }
    return reply({})
  }
  let loaded = null
  const timers = fakeTimers()
  const sandbox = {
    window: {
      addEventListener: () => {},
      location: { protocol: 'http:', href: 'http://127.0.0.1:3080/' },
      localStorage: { getItem: () => null, setItem: () => {} },
      // The whole point: native confirm must NEVER be consulted anymore.
      confirm: () => { throw new Error('window.confirm must not be used') },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      __ModuleLoader__: { load: (m) => { loaded = m } },
    },
    document: {
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
      getElementById: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    navigator: { clipboard: null, userAgent: 'node', languages: ['zh-CN'] },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, console,
    fetch: fetchStub,
  }
  // Marker Modal: identifiable by element type, renders its children inline so
  // the test can reach the footer buttons.
  const ModalStub = (props) => React.createElement('primitive-modal', { 'data-open': props.open }, ...(Array.isArray(props.children) ? props.children : [props.children]))
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') throw new Error('unexpected require: react-dom')
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        relativeTime: () => ({ unit: 'now', n: 0 }),
        ...(withModal ? { Modal: ModalStub } : {}),
      }
    }
    throw new Error('unexpected require: ' + id)
  }
  const run = new Function(
    'window', 'document', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'fetch', 'require', `${src}\n//# sourceURL=lib/client.js`,
  )
  run(sandbox.window, sandbox.document, sandbox.navigator, timers.setTimeout, timers.clearTimeout, console, fetchStub, requireStub)

  const mod = loaded.factory(requireStub)
  let Page = null
  const ctx = {
    get(name) {
      if (name === 'locale') return { register: () => {}, bind: () => (k) => k }
      if (name === 'slots') {
        return {
          inject: (slot, fn) => { fn(); return () => {} },
          register: (decl, comp) => { if (comp && decl && decl.name === 'settings.section') Page = comp; return () => {} },
          get: () => [],
        }
      }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {} }) } }
      return undefined
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(names, cb) { if (names.every((n) => this.get(n) !== undefined)) cb(this) },
    on() {},
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  }
  mod.apply(ctx)
  assert.ok(Page, 'the settings section component must be registered')
  return { Page, calls, list, ModalStub }
}

/** Positional hook driver (identical mechanics to settings-credentials-ui). */
function makeDriver(Page) {
  const state = []
  const refs = new Map()
  const cleanups = []
  const seen = new Set()
  let cursor = 0
  let pending = []
  const dispatcher = {
    useState(init) {
      const i = cursor++
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v }]
    },
    useEffect(fn) {
      const i = cursor++
      if (!seen.has('e' + i)) { seen.add('e' + i); pending.push(fn) }
    },
    useRef(v) { const i = cursor++; if (!refs.has(i)) refs.set(i, { current: v }); return refs.get(i) },
    useCallback(fn) { cursor++; return fn },
    useMemo(fn) { cursor++; return fn() },
    useLayoutEffect() {}, useInsertionEffect() {},
    useContext() { return {} },
    useReducer(_r, init) { cursor++; return [init, () => {}] },
    useDebugValue() {}, useId() { cursor++; return 'id' + cursor },
    useTransition() { cursor++; return [false, (f) => f && f()] },
    useDeferredValue(v) { cursor++; return v },
    useImperativeHandle() {},
  }
  React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher
  const settle = async () => {
    const renderPage = () => {
      cursor = 0
      pending = []
      let tree = Page({})
      while (tree && typeof tree === 'object' && !Array.isArray(tree) && typeof tree.type === 'function') {
        tree = tree.type(tree.props)
      }
      return tree
    }
    let tree = null
    for (let pass = 0; pass < 10; pass++) {
      tree = renderPage()
      const batch = pending
      if (!batch.length) return tree
      for (const fn of batch) {
        const c = fn()
        if (typeof c === 'function') cleanups.push(c)
      }
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    }
    return tree
  }
  const dispose = () => { for (const c of cleanups.splice(0)) { try { c() } catch {} } }
  return { settle, dispose }
}

function elements(tree, out = []) {
  if (Array.isArray(tree)) { for (const t of tree) elements(t, out); return out }
  if (!tree || typeof tree !== 'object') return out
  if (tree.props === undefined && tree.$$typeof === undefined) return out
  out.push(tree)
  if (tree.props && tree.props.children !== undefined) elements(tree.props.children, out)
  return out
}

function textOf(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.props) return textOf(node.props.children)
  return ''
}

function buttonByText(tree, re) {
  const hit = elements(tree).filter((el) => el.type === 'button' && re.test(textOf(el).trim()))
  assert.equal(hit.length, 1, `expected exactly one button matching ${re}, got ${hit.length}: ${hit.map((b) => textOf(b).trim()).join(' | ')}`)
  return hit[0]
}

/**
 * Drive the delete flow to the point where the confirm dialog is OPEN, and
 * return the freshly built dialog subtree. The dialog element sits unmounted
 * in the page tree (a nested function component); calling its type here — once,
 * after settling, with the dispatcher still installed — yields its real subtree
 * without disturbing the page's positional hook slots.
 */
async function openDeleteConfirm(mounted) {
  const driver = makeDriver(mounted.Page)
  let tree = await driver.settle()
  buttonByText(tree, /^(删除|Delete)$/).props.onClick()
  tree = await driver.settle()
  const dialog = elements(tree).find((el) => typeof el.type === 'function'
    && el.props && typeof el.props.message === 'string' && el.props.message.length > 0)
  assert.ok(dialog, 'clicking 删除 must open the themed confirm dialog')
  return { driver, dialogTree: dialog.type(dialog.props), calls: mounted.calls, ModalStub: mounted.ModalStub }
}

test('with a Modal-shipping host the delete confirm rides the host Modal (no native confirm)', async () => {
  const mounted = mountClient({ withModal: true })
  const { driver, dialogTree, calls, ModalStub } = await openDeleteConfirm(mounted)
  const modal = elements(dialogTree).find((el) => el.type === ModalStub)
  assert.ok(modal, 'ConfirmDialog must render through the host Modal when it exists')
  assert.equal(modal.props.open, true)
  // Confirm inside the modal → the delete POST fires, no window.confirm involved
  // (the sandbox's throws if anything still calls it).
  buttonByText(dialogTree, /^(确认|Confirm)$/).props.onClick()
  await driver.settle()
  const del = calls.find((c) => c.method === 'POST' && c.url.includes('/dsh-remote/machines') && c.body && c.body.action === 'delete')
  assert.ok(del, 'confirming issues the delete call')
  assert.equal(del.body.id, 'm-test')
  driver.dispose()
})

test('without Modal the guarded in-house overlay carries the confirm (still no native confirm)', async () => {
  const mounted = mountClient({ withModal: false })
  const { driver, dialogTree, calls } = await openDeleteConfirm(mounted)
  assert.ok(!elements(dialogTree).some((el) => el.type === 'primitive-modal'), 'no host Modal in the fallback path')
  const overlay = elements(dialogTree).find((el) => {
    const s = (el.props && el.props.style) || {}
    return s.position === 'fixed' && s.inset === 0 && typeof el.props.onMouseDown === 'function'
  })
  assert.ok(overlay, 'the fallback keeps the press-origin-guarded overlay')
  buttonByText(dialogTree, /^(确认|Confirm)$/).props.onClick()
  await driver.settle()
  assert.ok(calls.some((c) => c.method === 'POST' && c.body && c.body.action === 'delete'), 'fallback confirm issues the delete call')
  driver.dispose()
})

test('a dismissed confirm issues NO mutation', async () => {
  const mounted = mountClient({ withModal: true })
  const { driver, dialogTree, calls } = await openDeleteConfirm(mounted)
  buttonByText(dialogTree, /^(取消|Cancel)$/).props.onClick()
  await driver.settle()
  assert.ok(!calls.some((c) => c.method === 'POST' && c.body && c.body.action === 'delete'), 'cancel must not delete')
  driver.dispose()
})

// ── structural pins for the declarative adoptions ───────────────────────────
// The context menu and clipboard paths are data-thin wrappers; their behavior
// is pinned by explorer tests. What must not rot is the WIRING shape.

test('the context menu prefers the host Menu primitive with a body portal', () => {
  assert.match(src, /HostMenu = \(Primitives && typeof Primitives\.Menu === 'function'\)/)
  assert.match(src, /portal:\s*true/)
  // Fallback imperative menu must be skipped when the primitive exists.
  assert.match(src, /if \(!menu \|\| HostMenu\) return/)
})

test('the clipboard goes through the host writeClipboard when present', () => {
  assert.match(src, /writeClipboardFn = \(Primitives && typeof Primitives\.writeClipboard === 'function'\)/)
  assert.match(src, /if \(writeClipboardFn\)/)
})

test('no native confirm remains anywhere in the client bundle', () => {
  assert.ok(!/window\.confirm\s*\(/.test(src), 'window.confirm must be gone (ConfirmDialog replaced it)')
})

// ── long-tail visual adoptions (Switch / SegmentedTabs / FileTypeIcon) ─────
// Contracts verified against the SHIPPED host bundle (the npm type package
// trails it): Switch takes {checked, disabled, title, label} and an onChange
// delivering a bare BOOLEAN; SegmentedTabs takes {items:[{value,label}], value,
// onChange(value)}; FileTypeIcon takes {kind}|{path} + size.

test('settings toggles adopt the host Switch; each test id exists on BOTH paths', () => {
  assert.match(src, /HostSwitch = \(Primitives && typeof Primitives\.Switch === 'function'\)/)
  // The host Switch swallows unknown props (no data-testid forwarding), so
  // each stable id appears twice: on the fallback <input>, and on the wrapper
  // span that carries it whenever the Switch renders.
  const ids = src.match(/'data-testid': '(explorer-auto-open|telemetry-toggle)'/g) || []
  assert.equal(ids.length, 4, `want 4 id sites (2 toggles x fallback/adopted), got ${ids.length}`)
})

test('the dir picker adopts host SegmentedTabs for its 本机/远程 switch', () => {
  assert.match(src, /HostSegmentedTabs = \(Primitives && typeof Primitives\.SegmentedTabs === 'function'\)/)
  assert.match(src, /React\.createElement\(HostSegmentedTabs, \{/)
  // onChange delivers the item value — exactly what switchTab consumes.
  assert.match(src, /onChange: switchTab/)
})

test('explorer and picker rows adopt the host FileTypeIcon', () => {
  assert.match(src, /HostFileTypeIcon = \(Primitives && typeof Primitives\.FileTypeIcon === 'function'\)/)
  assert.match(src, /kind: 'folder'/, 'directories take the folder kind')
  // Files derive their glyph from the entry name; unknown extensions degrade
  // to the host's generic 'other' file icon.
  assert.match(src, /React\.createElement\(HostFileTypeIcon, \{ path: String\(name \|\| ''\), size: 14 \}\)/)
  // The hand-drawn SVGs stay as the no-primitive fallback.
  assert.match(src, /viewBox: '0 0 16 16'/)
})
