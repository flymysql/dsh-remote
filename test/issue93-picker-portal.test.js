// Issue #93 — the directory picker painted but ignored every click in an
// EXISTING conversation (the hero page was fine).
//
// Root cause: the picker's full-screen overlay was rendered INLINE into the
// slot's React subtree. A `position:fixed` layer inside the 0.2.2 conversation
// container inherits that container's pointer-events/stacking trap, so clicks
// fell straight through to the chat text. The host's own Modal/Menu escape this
// by portaling to document.body; the plugin's context menu already did the same
// imperatively. Now the picker does `ReactDOM.createPortal(overlay, document.body)`
// whenever react-dom is available, and keeps the inline overlay as the fallback
// for hosts (and harnesses) without it.
//
// Same driving style as issue52: the REAL DirPicker, real React, fake hook
// dispatcher; the render OUTPUT is asserted — a portal marker vs the inline tree.

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

/**
 * Load the client bundle and extract the DirPicker.
 * `reactDom` — undefined simulates a host without react-dom in the shared map;
 * an object simulates one (its createPortal is asserted upon).
 */
function loadDirPicker({ reactDom } = {}) {
  let loaded = null
  const timers = fakeTimers()
  const body = { is: 'document.body' }
  const sandbox = {
    window: {
      addEventListener: () => {},
      location: { protocol: 'http:', href: 'http://127.0.0.1:3080/' },
      localStorage: { getItem: () => null, setItem: () => {} },
      __ModuleLoader__: { load: (m) => { loaded = m } },
    },
    document: {
      head: { appendChild: () => {} },
      body,
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
      getElementById: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    navigator: { clipboard: null, userAgent: 'node', languages: ['zh-CN'] },
    console,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { relativeTime: () => ({ unit: 'now', n: 0 }) }
    if (id === 'react-dom') {
      if (reactDom === undefined) throw new Error('unexpected require: react-dom')
      return reactDom
    }
    throw new Error('unexpected require: ' + id)
  }
  const run = new Function(
    'window', 'document', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'fetch', 'require',
    `${src}\n//# sourceURL=lib/client.js`,
  )
  run(sandbox.window, sandbox.document, sandbox.navigator, timers.setTimeout, timers.clearTimeout, console, sandbox.fetch, requireStub)

  const mod = loaded.factory(requireStub)
  let Picker = null
  const ctx = {
    get(name) {
      if (name === 'locale') return { register: () => {}, bind: () => (k) => k }
      if (name === 'slots') {
        return {
          inject: (slot, fn) => { fn(); return () => {} },
          register: (decl, comp) => {
            if (String(decl && decl.name || '').includes('directoryFlow') && typeof comp === 'function') Picker = comp
            return () => {}
          },
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
  assert.ok(Picker, 'lib/client.js must register DirPicker into a directoryFlow slot')
  return { Picker, body }
}

/** Render the picker once with the fake hook dispatcher. */
function renderOnce(Picker) {
  React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = {
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}] },
    useEffect() {}, useLayoutEffect() {}, useInsertionEffect() {},
    useMemo(fn) { return fn() }, useCallback(fn) { return fn },
    useRef(v) { return { current: v } }, useContext() { return {} },
    useReducer(_r, init) { return [init, () => {}] },
    useDebugValue() {}, useId() { return 'id' },
    useTransition() { return [false, (f) => f && f()] }, useDeferredValue(v) { return v },
    useImperativeHandle() {},
  }
  return Picker({ open: true, busy: false, onPicked: () => {}, onCancel: () => {} })
}

/** Depth-first hunt for the fixed full-screen backdrop in a plain element tree. */
function hasInlineBackdrop(tree) {
  if (Array.isArray(tree)) return tree.some(hasInlineBackdrop)
  if (tree == null || typeof tree !== 'object') return false
  const style = (tree.props && tree.props.style) || {}
  if (style.position === 'fixed' && style.inset === 0 && typeof tree.props.onMouseDown === 'function') return true
  return tree.props ? hasInlineBackdrop(tree.props.children) : false
}

test('#93: with react-dom available the overlay is portaled to document.body', () => {
  const calls = []
  const reactDom = {
    // A portal-shaped marker: identity-passthrough would hide whether the
    // portal machinery actually ran, so the spy returns a recognizable wrapper.
    createPortal: (element, container) => {
      calls.push({ element, container })
      return { __portal: true, element, container }
    },
  }
  const { Picker, body } = loadDirPicker({ reactDom })
  const out = renderOnce(Picker)
  assert.equal(calls.length, 1, 'the picker must portal exactly once per render')
  assert.equal(calls[0].container, body, 'the portal target is document.body, escaping the slot subtree')
  assert.equal(out.__portal, true)
  assert.ok(hasInlineBackdrop(calls[0].element), 'the portaled payload is the guarded overlay itself')
})

test('#93: without react-dom the inline overlay keeps working (fallback)', () => {
  const { Picker } = loadDirPicker({ reactDom: undefined })
  const out = renderOnce(Picker)
  assert.ok(out && out.props, 'renders a plain element, not a crash')
  assert.ok(hasInlineBackdrop(out), 'the fixed overlay is inline, as before the fix')
})
