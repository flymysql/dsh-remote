// Reusable CLIENT harness: mount the real client bundle, drive the real React
// component, click the real buttons.
//
// Why this exists: `lib/client.js` is 3800 lines of UI and the coverage tool
// cannot even see it (it is evaluated from a string, not imported as a module).
// Eight test files touched it, but only two rendered the settings page and none
// drove more than one interaction — so "the password box looks empty" and "the
// test button dies after saving" were invisible to the suite even though both are
// pure props-on-rendered-elements facts.
//
//   const ui = mountClient({ fetch: myFetchStub })
//   let tree = await ui.settle()               // render + run effects + let promises land
//   ui.click(tree, /^编辑$/)                    // click by visible text
//   tree = await ui.settle()
//   ui.buttons(tree)                           // [{ label, disabled, title, el }]
//   ui.dispose()                               // clear intervals registered by effects
//
// Two harness details that cost real time and are worth keeping:
//   · the registered slot component is a thin, hook-free WRAPPER
//     (`() => React.createElement(RemoteWorkspacePage)`), so it must be mounted
//     once to reach the real page — otherwise the hook driver sees zero hooks and
//     every assertion "passes" against an empty tree;
//   · React 18 reads `.current` off the captured dispatcher OBJECT, so the
//     dispatcher must be MUTATED in place, never replaced.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = readFileSync(path.join(here, '..', '..', 'lib', 'client.js'), 'utf8')

/**
 * Load the client bundle and register every slot component it declares.
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetch] - fetch stub (default: `{}` for every call).
 * @param {Array<string>} [opts.languages] - navigator.languages (default zh-CN).
 * @param {object} [opts.services] - extra ctx.get(name) services.
 * @returns {object} the harness (see the file header).
 */
export function mountClient(opts = {}) {
  const require_ = createRequire(path.join(here, '..', 'settings-render.test.js'))
  const React = require_('react')
  const fetchStub = opts.fetch || (async () => ({ ok: true, status: 200, json: async () => ({}) }))
  const slots = []
  let loaded = null
  // Intervals registered by effects are CAPTURED, not started: a test fires them on
  // demand with `ui.fireIntervals()`, which is the only way to assert "the page
  // notices a change made elsewhere" (e.g. an agent calling rw_connect) without
  // waiting on a real clock.
  const intervals = []
  const setIntervalStub = (fn, ms) => {
    intervals.push({ fn, ms })
    return intervals.length
  }
  const clearIntervalStub = (handle) => {
    if (typeof handle === 'number' && handle > 0) intervals[handle - 1] = null
  }
  const sandbox = {
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      location: { protocol: 'http:', href: 'http://127.0.0.1:3080/' },
      localStorage: { getItem: () => null, setItem: () => {} },
      confirm: () => true,
      __ModuleLoader__: { load: (m) => { loaded = m } },
    },
    document: {
      head: { appendChild: () => {} },
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: () => {},
    },
    navigator: { clipboard: null, userAgent: 'node', languages: opts.languages || ['zh-CN'] },
    setTimeout, clearTimeout, setInterval: setIntervalStub, clearInterval: clearIntervalStub, console,
    fetch: fetchStub,
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      // The real package ships MarkdownText (used for remote .md rendering, issue
      // #74); the stub renders text inside a marker element so tests can tell a
      // rendered doc from a raw source wall.
      return {
        relativeTime: () => ({ unit: 'now', n: 0 }),
        MarkdownText: (props) => React.createElement('div', { className: 'md-stub' }, props.text),
      }
    }
    throw new Error('unexpected require: ' + id)
  }
  const run = new Function(
    'window', 'document', 'navigator', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'fetch', 'require', CLIENT_SRC,
  )
  run(sandbox.window, sandbox.document, sandbox.navigator, setTimeout, clearTimeout, setIntervalStub, clearIntervalStub, console, fetchStub, requireStub)

  const mod = loaded.factory(requireStub)
  const registered = new Map()
  // Right-pane bodies share ONE slot name, so key by `key` when it exists.
  const bodies = new Map()
  const tabTypes = new Map()
  const ctx = {
    get(name) {
      if (name === 'locale') return { register: () => {}, bind: () => (k) => k }
      if (name === 'slots') {
        return {
          inject: (slot, fn) => { slots.push(slot); fn(); return () => {} },
          register: (decl, comp) => {
            registered.set(decl && decl.name, { decl, comp })
            bodies.set((decl && (decl.key || decl.name)) || '', comp)
            // Tab bodies share one slot name and are distinguished by `key`.
            if (decl && decl.key) registered.set('key:' + decl.key, { decl, comp })
            return () => {}
          },
          get: () => [],
        }
      }
      if (name === 'sidebarRightTabs') {
        return {
          register: (type) => { tabTypes.set(type.kind || type.id, type); return () => tabTypes.delete(type.kind || type.id) },
          get: (kind) => tabTypes.get(kind),
        }
      }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {} }) } }
      return (opts.services || {})[name]
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(names, cb) { if (names.every((n) => this.get(n) !== undefined)) cb(this) },
    on() {},
    logger: { warn() {}, info() {}, debug() {} },
  }
  mod.apply(ctx)

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
    useRef(v) {
      const i = cursor++
      if (!refs.has(i)) refs.set(i, { current: v })
      return refs.get(i)
    },
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

  /** Render a component (mounting the hook-free slot wrapper first) and run its effects. */
  async function settleFor(Comp, props = {}) {
    let tree = null
    for (let pass = 0; pass < 8; pass++) {
      cursor = 0
      pending = []
      tree = Comp(props)
      while (tree && typeof tree === 'object' && !Array.isArray(tree) && typeof tree.type === 'function' && !tree.props?.children) {
        tree = tree.type(tree.props || {})
      }
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

  const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }

  return {
    React,
    registered,
    slots,
    /** Component registered into a named slot. */
    component(slotName = 'settings.section') {
      const entry = registered.get(slotName)
      if (!entry) throw new Error(`slot ${slotName} is not registered (have: ${[...registered.keys()].join(', ')})`)
      return entry.comp
    },
    /** Body registered under a right-pane key (e.g. 'dsh-remote/file'). */
    body(key) {
      const comp = bodies.get(key)
      if (!comp) throw new Error(`body ${key} is not registered (have: ${[...bodies.keys()].filter(Boolean).join(', ')})`)
      return comp
    },
    /** The native tab types captured from the sidebarRightTabs registry. */
    tabTypes,
    /** Render a slot component and settle its effects. */
    settle(slotName = 'settings.section') { return settleFor(this.component(slotName)) },
    /** Render an arbitrary function component. */
    settleComponent(Comp, props = {}) { return settleFor(Comp, props) },
    /**
     * Drop all hook state. Mounting a SECOND component family without this lets
     * the new component's `useState(0)` read the previous family's slot — e.g. the
     * link body found the settings page's machines array where its own
     * `remotePath` should be, and rendered the file tab with a non-string path.
     */
    resetState() { state.length = 0; refs.clear(); seen.clear() },
    tick,
    elements,
    textOf,
    /** Every <button> with its visible label and disabled/title props. */
    buttons(tree) {
      return elements(tree)
        .filter((el) => el.type === 'button')
        .map((el) => ({ label: textOf(el).trim(), disabled: !!el.props.disabled, title: el.props.title || '', el }))
    },
    /** The single button whose label matches; throws with the available labels. */
    button(tree, re) {
      const all = this.buttons(tree)
      const hit = all.filter((b) => re.test(b.label))
      if (hit.length !== 1) throw new Error(`expected exactly one button matching ${re}, got ${hit.length}: ${all.map((b) => b.label).join(' | ')}`)
      return hit[0]
    },
    /** Click it and settle (async work inside the handler included). */
    async click(tree, re) {
      const b = this.button(tree, re)
      b.el.props.onClick()
      await tick()
      return this.settle()
    },
    inputs(tree, type) {
      return elements(tree)
        .filter((el) => el.type === 'input' && (!type || el.props.type === type))
        .map((el) => el.props)
    },
    /**
     * Elements whose `type` is a FUNCTION (i.e. a nested component that the walker
     * does not mount). Used to assert that a modal is on screen without paying for
     * its hook state: `components(tree).some((el) => el.type === ui.component('…'))`.
     */
    components(tree) {
      return elements(tree)
        .filter((el) => typeof el.type === 'function')
        .map((el) => ({ type: el.type, props: el.props }))
    },
    /** Text of the whole tree (for "does the panel say X" assertions). */
    text(tree) { return textOf(tree) },
    /** Fire every interval a mounted effect registered (the page's own polling). */
    async fireIntervals() {
      const live = intervals.filter(Boolean)
      for (const t of live) { try { t.fn() } catch { /* one poll must not break the rest */ } }
      await tick()
      return live.length
    },
    /** Intervals currently registered (for asserting a poll exists / was cleared). */
    intervals() { return intervals.filter(Boolean).map((t) => t.ms) },
    dispose() { for (const c of cleanups.splice(0)) { try { c() } catch { /* gone */ } } },
  }
}

/** Collect every element in the tree (no component mounting). */
export function elements(tree, out = []) {
  if (Array.isArray(tree)) { for (const t of tree) elements(t, out); return out }
  if (!tree || typeof tree !== 'object') return out
  if (tree.props === undefined && tree.$$typeof === undefined) return out
  out.push(tree)
  if (tree.props && tree.props.children !== undefined) elements(tree.props.children, out)
  return out
}

/** Flatten an element's visible text. */
export function textOf(node) {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.props) return textOf(node.props.children)
  return ''
}
