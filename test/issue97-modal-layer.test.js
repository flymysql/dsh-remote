// Issue #97 — the DirPicker adopts the host's useModalLayer when the bundle
// ships it: focus trap + autofocus + focus restore + the IME-composition guard,
// WITHOUT surrendering our press-origin mask guard (issue #52; the host Modal's
// mask dismisses on bare click — that is why the picker keeps its own overlay).
//
// What these pin:
//   · the layer is driven with (ref, open, dismissFn) — and its Escape reaches
//     our LAYERED cascade (suggestions → browse popup → cancel), not a bare
//     cancel;
//   · while the mkdir prompt is open the cascade refuses to cancel beneath it;
//   · when the layer is absent, our document keydown still owns Escape (the
//     issue #52 era behaviour, kept as the fallback);
//   · the path input carries data-modal-autofocus so the layer focuses it.
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

// DirPicker hook order (pinned by issue52; the layer additions sit at the end):
// 0 tab 1 machines 2 machineId 3 path 4 items 5 err 6 loading 7 levels
// 8 popOpen 9 suggest 10 suggestOpen 11 recent 12 win 13 localPop
// 14 newDirName 15 mkdirPrompt 16 mOpen

/** Load the client, extract DirPicker, with an optional useModalLayer spy. */
function loadPicker({ withLayer }) {
  let loaded = null
  const timers = fakeTimers()
  const layerCalls = []
  const sandbox = {
    window: {
      addEventListener: () => {},
      location: { protocol: 'http:', href: 'http://127.0.0.1:3080/' },
      localStorage: { getItem: () => null, setItem: () => {} },
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      __ModuleLoader__: { load: (m) => { loaded = m } },
    },
    document: {
      head: { appendChild: () => {} },
      body: {},
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
      getElementById: () => null,
      addEventListener: () => {}, removeEventListener: () => {},
    },
    navigator: { clipboard: null, userAgent: 'node', languages: ['zh-CN'] },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, console,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') throw new Error('unexpected require: react-dom')
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        relativeTime: () => ({ unit: 'now', n: 0 }),
        ...(withLayer ? { useModalLayer: (ref, open, onClose) => { layerCalls.push({ ref, open, onClose }) } } : {}),
      }
    }
    throw new Error('unexpected require: ' + id)
  }
  const run = new Function('window', 'document', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'fetch', 'require', `${src}\n//# sourceURL=lib/client.js`)
  run(sandbox.window, sandbox.document, sandbox.navigator, timers.setTimeout, timers.clearTimeout, console, sandbox.fetch, requireStub)
  const mod = loaded.factory(requireStub)
  let Picker = null
  const ctx = {
    get(name) {
      if (name === 'locale') return { register: () => {}, bind: () => (k) => k }
      if (name === 'slots') {
        return {
          inject: (slot, fn) => { fn(); return () => {} },
          register: (decl, comp) => { if (String(decl && decl.name || '').includes('directoryFlow')) Picker = comp; return () => {} },
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
  assert.ok(Picker, 'DirPicker must register into a directoryFlow slot')
  return { Picker, layerCalls }
}

/** Mount with captured hook state/setters (the issue52 pattern). */
function mount(Picker, props = {}) {
  const hookState = []
  const setters = []
  const cancellations = { n: 0 }
  let hookIndex = 0
  React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = {
    useState(init) {
      const i = hookIndex++
      if (hookState[i] === undefined) hookState[i] = typeof init === 'function' ? init() : init
      if (!setters[i]) setters[i] = (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }
      return [hookState[i], setters[i]]
    },
    useEffect() {}, useLayoutEffect() {}, useInsertionEffect() {},
    useMemo(fn) { return fn() }, useCallback(fn) { return fn },
    useRef(v) { return { current: v } }, useContext() { return {} },
    useReducer(_r, init) { return [init, () => {}] },
    useDebugValue() {}, useId() { return 'id' },
    useTransition() { return [false, (f) => f && f()] }, useDeferredValue(v) { return v },
    useImperativeHandle() {},
  }
  const render = () => {
    hookIndex = 0
    return Picker({ open: true, busy: false, onPicked: () => {}, onCancel: () => { cancellations.n++ }, ...props })
  }
  render()
  return { render, hookState, setters, cancellations }
}

test('with the host layer the picker registers (ref, open, dismiss) and Escape cascades', () => {
  const { Picker, layerCalls } = loadPicker({ withLayer: true })
  const m = mount(Picker)
  m.setters[1]([{ id: 'm1', name: 'dev', host: '10.0.0.1', port: 22, username: 'dev' }])
  m.setters[2]('m1')
  m.render()
  const last = layerCalls[layerCalls.length - 1]
  assert.ok(last, 'useModalLayer must be called')
  assert.equal(last.open, true)
  assert.ok(last.ref && typeof last.ref === 'object' && 'current' in last.ref, 'the overlay ref reaches the layer')
  assert.equal(typeof last.onClose, 'function')
  // The layer's Escape → our cascade → dialog cancels (nothing else open).
  last.onClose()
  assert.equal(m.cancellations.n, 1)
})

test('the cascade closes suggestions before it cancels', () => {
  const { Picker, layerCalls } = loadPicker({ withLayer: true })
  const m = mount(Picker)
  m.setters[1]([{ id: 'm1', name: 'dev', host: '10.0.0.1', port: 22, username: 'dev' }])
  m.setters[2]('m1')
  m.setters[9](['/home/dev', '/home/a'])
  m.setters[10](true) // suggestOpen
  m.render()
  layerCalls[layerCalls.length - 1].onClose()
  assert.equal(m.hookState[10], false, 'the first Escape closes the suggestion list')
  assert.equal(m.cancellations.n, 0, 'and does NOT close the dialog beneath it')
  // The host layer re-reads the LATEST callback per render (ref-tracked), so
  // the second Escape must come from the post-close render, not the stale one.
  m.render()
  layerCalls[layerCalls.length - 1].onClose()
  assert.equal(m.cancellations.n, 1, 'the next Escape cancels')
})

test('while the mkdir prompt is open, the cascade refuses to cancel beneath it', () => {
  const { Picker, layerCalls } = loadPicker({ withLayer: true })
  const m = mount(Picker)
  m.setters[1]([{ id: 'm1', name: 'dev', host: '10.0.0.1', port: 22, username: 'dev' }])
  m.setters[2]('m1')
  m.setters[15]({ base: '/home/dev' }) // mkdirPrompt
  m.render()
  layerCalls[layerCalls.length - 1].onClose()
  assert.equal(m.cancellations.n, 0, 'the prompt owns Escape while open')
  assert.ok(m.hookState[15], 'the prompt is still open')
})

test('the path input carries data-modal-autofocus for the layer', () => {
  const { Picker } = loadPicker({ withLayer: true })
  const m = mount(Picker)
  const tree = m.render()
  const findAutofocus = (node) => {
    if (Array.isArray(node)) return node.some(findAutofocus)
    if (!node || typeof node !== 'object') return false
    if (node.props && node.props['data-modal-autofocus']) return true
    return node.props ? findAutofocus(node.props.children) : false
  }
  assert.ok(findAutofocus(tree), 'the layer needs an autofocus target')
})

test('without the host layer nothing is registered and the document listener still owns Escape', () => {
  const { Picker, layerCalls } = loadPicker({ withLayer: false })
  mount(Picker).render()
  assert.equal(layerCalls.length, 0, 'no layer calls without the primitive')
  // Structural pin: the document keydown keeps its Escape branch exactly when
  // the layer is absent (module-constant condition).
  assert.match(src, /if \(!useModalLayerFn && e\.key === 'Escape'\)/)
  assert.match(src, /useModalLayerFn\) \{\s*\n\s*try \{ useModalLayerFn\(/)
})
