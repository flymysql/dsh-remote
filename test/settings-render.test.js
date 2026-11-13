// Render the REAL settings component with REAL React and assert the cards a user
// expects are actually there.
//
// Why this exists on top of client-smoke.test.js: that test proves apply() runs
// and the dictionaries are registered. It does NOT prove the settings page
// renders — a component that throws while building its tree, or a card whose
// element tree collapses to nothing, passes a source-level assertion and still
// shows the user an empty panel. This walks the real element tree the way React
// would mount it.
//
// Two harness details matter and both were learning experiences:
//   · use ONE React instance (required through the same `require` the bundle
//     gets). An ESM import here created a second copy → "Invalid hook call",
//     which looks exactly like a broken component.
//   · React 18 captures the dispatcher OBJECT at load and reads `.current`, so
//     the dispatcher must be MUTATED in place; assigning a new `{current}` leaves
//     React reading a null dispatcher.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { fakeTimers } from './harness/fake-timers.js'
import { installTestDispatcher } from './harness/react-dispatcher.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const require = createRequire(import.meta.url)
const React = require('react')
const src = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

/** Load the client bundle and run apply(), returning the settings component. */
function mountClient(opts = {}) {
  let loaded = null
  const requests = []
  const timers = fakeTimers()
  const sandbox = {
    window: {
      addEventListener: () => {},
      location: { protocol: 'http:', href: 'http://127.0.0.1:3080/' },
      localStorage: opts.localStorage || { getItem: () => null, setItem: () => {} },
      confirm: () => true,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      __ModuleLoader__: { load: (m) => { loaded = m } },
    },
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
      getElementById: () => null,
    },
    navigator: { clipboard: null, userAgent: 'node', languages: ['zh-CN'] },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, console,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      if (opts.fetch) return opts.fetch(url, init)
      return { ok: true, json: async () => ({}) }
    },
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { relativeTime: () => ({ unit: 'now', n: 0 }), ...(opts.primitives || {}) }
    throw new Error('unexpected require: ' + id)
  }
  const run = new Function(
    'window', 'document', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'fetch', 'require', src,
  )
  run(sandbox.window, sandbox.document, sandbox.navigator, timers.setTimeout, timers.clearTimeout, console, sandbox.fetch, requireStub)

  const mod = loaded.factory(requireStub)
  let Page = null
  const sections = []
  const slotsSeen = []
  const ctx = {
    get(name) {
      if (name === 'locale') return { register: () => {}, bind: () => (k) => k }
      if (name === 'slots') {
        return {
          // `slots.inject(slot, fn)` runs fn so it can register into the slot.
          inject: (slot, fn) => { slotsSeen.push(slot); fn(); return () => {} },
          register: (decl, comp) => {
            sections.push(decl)
            if (comp && decl && decl.name === 'settings.section') Page = comp
            return () => {}
          },
          get: () => [],
        }
      }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {} }) } }
      // Optional sidebar UI absent, as in a Web install without the sidebar plugin.
      if (name === 'betterSidebar' || name === 'sidebarRightTabs' || name === 'directoryPicker') return undefined
      return undefined
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(names, cb) { if (names.every((n) => this.get(n) !== undefined)) cb(this) },
    on() {},
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  }
  mod.apply(ctx)
  return { Page, sections, slotsSeen, requests }
}

/** Walk an element tree, collecting rendered text, mounting function components. */
function collectText(tree) {
  if (Array.isArray(tree)) return tree.map(collectText).join(' ')
  if (tree == null || tree === false || tree === true) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (typeof tree !== 'object') return ''
  const isElement = tree.$$typeof !== undefined || tree.props !== undefined
  if (!isElement) return ''
  if (typeof tree.type === 'function' && tree.type !== React.Fragment) {
    try { return collectText(tree.type(tree.props)) } catch { /* needs effects; use children */ }
  }
  return tree.props ? collectText(tree.props.children) : ''
}

test('the settings page renders, and it contains the cards the user expects', () => {
  const { Page, sections, slotsSeen } = mountClient()
  assert.ok(Page, 'the settings section component must be registered')

  // Install the initial-render dispatcher ON the captured object (see header).
  const hookState = []
  let hookIndex = 0
  installTestDispatcher(React, {
    useState(init) {
      const i = hookIndex++
      if (hookState[i] === undefined) hookState[i] = typeof init === 'function' ? init() : init
      return [hookState[i], (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }]
    },
    useEffect() {}, useLayoutEffect() {}, useInsertionEffect() {},
    useMemo(fn) { return fn() }, useCallback(fn) { return fn },
    useRef(v) { return { current: v } }, useContext() { return {} },
    useReducer(_r, init) { return [init, () => {}] },
    useDebugValue() {}, useId() { return 'id' },
    useTransition() { return [false, (f) => f && f()] }, useDeferredValue(v) { return v },
    useImperativeHandle() {},
  })

  // Rendering must not throw: a throw here means the user sees a broken panel.
  const tree = Page({})
  const text = collectText(tree)

  assert.ok(text.length > 100, 'the panel must render real content')
  assert.match(text, /远程工作区/, 'the plugin title renders')
  // The workspace-backup capability was REMOVED in 0.8.41 (the user asked for it
  // to go): its card must not render, and its i18n keys must be gone entirely.
  assert.doesNotMatch(text, /工作区备份/, 'the backup card is gone')
  // The deploy entry must be present on a FRESH page (it used to require a prior
  // The deploy card was REMOVED on request: no deploy / health-check UI may come
  // back, and the audit panel must now offer to open the log file itself.
  assert.doesNotMatch(text, /体检|部署并验证|远端 dsh 体检|一键部署/, 'the deploy card is gone')
  assert.match(text, /审计日志/, 'the audit card is still there')
  assert.match(text, /打开日志文件/, 'and it can open the log file on the host')
  // No raw i18n key may leak into the UI (a missing dictionary entry renders the
  // key itself, which is how these panels silently show `settings.foo`).
  const leaked = text.match(/\bsettings\.[a-zA-Z][\w.]*/g)
  assert.deepEqual(leaked, null, `raw i18n keys leaked into the UI: ${leaked}`)
  assert.ok(sections.some((d) => d && d.name === 'settings.section'), 'registered into settings.section')
  assert.ok(slotsSeen.includes('settings.section'), 'the settings slot was used')
})

/** Issue #78 helpers: find elements by predicate, and a per-test hook rig. */
function findAll(tree, pred, out = []) {
  if (Array.isArray(tree)) { tree.forEach((n) => findAll(n, pred, out)); return out }
  if (tree == null || typeof tree !== 'object') return out
  if (tree.props && pred(tree)) out.push(tree)
  if (typeof tree.type === 'function' && tree.type !== React.Fragment) {
    try { findAll(tree.type(tree.props), pred, out) } catch { /* needs effects */ }
  }
  if (tree.props && tree.props.children) findAll(tree.props.children, pred, out)
  return out
}

function installHookRig() {
  const hookState = []
  let hookIndex = 0
  installTestDispatcher(React, {
    useState(init) {
      const i = hookIndex++
      if (hookState[i] === undefined) hookState[i] = typeof init === 'function' ? init() : init
      return [hookState[i], (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }]
    },
    useEffect() {}, useLayoutEffect() {}, useInsertionEffect() {},
    useMemo(fn) { return fn() }, useCallback(fn) { return fn },
    useRef(v) { return { current: v } }, useContext() { return {} },
    useReducer(_r, init) { return [init, () => {}] },
    useDebugValue() {}, useId() { return 'id' },
    useTransition() { return [false, (f) => f && f()] }, useDeferredValue(v) { return v },
    useImperativeHandle() {},
  })
  return () => { hookIndex = 0 }
}

test('issue #78: auto-open checkbox defaults on, persists off, reads back on remount', () => {
  const store = new Map()
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
  const { Page } = mountClient({ localStorage })
  const reset = installHookRig()
  const render = () => { reset(); return Page({}) }

  let tree = render()
  let box = findAll(tree, (el) => el.props && el.props['data-testid'] === 'explorer-auto-open')
  assert.equal(box.length, 1, 'exactly one auto-open checkbox renders')
  assert.equal(box[0].props.checked, true, 'default is ON (existing behaviour preserved)')
  // The label must carry the TRANSLATED text, not a raw key (the global leak
  // check in the first test guards everything; this pins the text to THIS control).
  assert.match(collectText(tree), /打开远程工作区时，自动在侧边栏展开「远程文件」/)

  box[0].props.onChange({ target: { checked: false } })
  assert.equal(store.get('dsh-remote:explorerAutoOpen'), '0', 'uncheck persists immediately')
  tree = render()
  box = findAll(tree, (el) => el.props && el.props['data-testid'] === 'explorer-auto-open')
  assert.equal(box[0].props.checked, false, 're-render reflects the stored choice')

  // A fresh mount (the "restart") starts from the stored value.
  const remount = mountClient({ localStorage })
  installHookRig()()
  const tree2 = remount.Page({})
  const box2 = findAll(tree2, (el) => el.props && el.props['data-testid'] === 'explorer-auto-open')
  assert.equal(box2[0].props.checked, false, 'a restart reads the persisted opt-out')
})

test('with a host Switch the toggles ride it: ids on wrappers, bare-boolean onChange persists', () => {
  const store = new Map()
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
  // Faithful to the shipped bundle: onChange delivers a bare boolean, and the
  // component ignores unknown props (so a data-testid handed to it would die).
  const SwitchStub = (props) => React.createElement('button', {
    type: 'button', role: 'switch', 'aria-checked': props.checked, disabled: props.disabled,
    onClick: () => props.onChange(!props.checked),
  })
  const { Page } = mountClient({ localStorage, primitives: { Switch: SwitchStub } })
  const reset = installHookRig()
  const render = () => { reset(); return Page({}) }

  let tree = render()
  const wrap = findAll(tree, (el) => el.props && el.props['data-testid'] === 'explorer-auto-open')
  assert.equal(wrap.length, 1, 'exactly one explorer-auto-open element on the Switch path')
  const hosted = findAll(wrap[0], (el) => el.type === SwitchStub)
  assert.equal(hosted.length, 1, 'the wrapper carries the host Switch')
  assert.equal(hosted[0].props.checked, true, 'default ON flows onto the Switch')
  assert.equal(findAll(tree, (el) => el.type === 'input' && el.props && el.props['data-testid']).length, 0,
    'the native checkbox is gone when the host Switch renders')

  hosted[0].props.onChange(false) // bare boolean, per the bundle contract
  assert.equal(store.get('dsh-remote:explorerAutoOpen'), '0', 'flipping off persists immediately')
  tree = render()
  const again = findAll(findAll(tree, (el) => el.props && el.props['data-testid'] === 'explorer-auto-open')[0], (el) => el.type === SwitchStub)
  assert.equal(again[0].props.checked, false, 're-render reflects the stored choice')
})

test('issue #119: storage get/set errors fall back safely and still POST the host choice', () => {
  const localStorage = {
    getItem() { throw new Error('storage blocked') },
    setItem() { throw new Error('storage blocked') },
  }
  const { Page, requests } = mountClient({ localStorage })
  const reset = installHookRig()
  const render = () => { reset(); return Page({}) }

  let box = findAll(render(), (el) => el.props && el.props['data-testid'] === 'explorer-auto-open')
  assert.equal(box[0].props.checked, true, 'an unreadable local store still defaults ON')
  assert.doesNotThrow(() => box[0].props.onChange({ target: { checked: false } }), 'a blocked setItem cannot break the toggle')
  box = findAll(render(), (el) => el.props && el.props['data-testid'] === 'explorer-auto-open')
  assert.equal(box[0].props.checked, false, 'the in-memory effective preference changes immediately')
  const write = requests.find((r) => r.url === '/dsh-remote/explorer-auto-open' && r.init && r.init.method === 'POST')
  assert.ok(write, 'the choice is sent to DSH_HOME even when localStorage is unavailable')
  assert.equal(JSON.parse(write.init.body).enabled, false)
})

test('issue #125: the per-machine discover command renders in advanced settings', () => {
  const { Page } = mountClient()
  const hookState = []
  const setters = []
  let hookIndex = 0
  installTestDispatcher(React, {
    useState(init) { const i = hookIndex++; if (hookState[i] === undefined) hookState[i] = typeof init === 'function' ? init() : init; if (!setters[i]) setters[i] = (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }; return [hookState[i], setters[i]] },
    useEffect() {}, useLayoutEffect() {}, useInsertionEffect() {},
    useMemo(fn) { return fn() }, useCallback(fn) { return fn },
    useRef(v) { return { current: v } }, useContext() { return {} },
    useReducer(_r, init) { return [init, () => {}] },
    useDebugValue() {}, useId() { return 'id' },
    useTransition() { return [false, (f) => f && f()] }, useDeferredValue(v) { return v },
    useImperativeHandle() {},
  })
  const render = () => { hookIndex = 0; return Page({}) }
  let tree = render()
  assert.equal(findAll(tree, (el) => el.props && el.props['data-testid'] === 'web-attach-discover-command').length, 0,
    'the edit form is closed on a fresh page')
  // The form only exists while editing a saved machine (issue #73). Drive the
  // REAL form state into that mode rather than mocking the component output.
  const formIndex = hookState.findIndex((v) => v && typeof v === 'object' && 'host' in v && 'passwordSet' in v)
  assert.ok(formIndex >= 0, 'found the real machine-form state')
  setters[formIndex]({ ...hookState[formIndex], id: 'm125', host: '10.0.0.5', webAttachDiscoverCommand: 'cat /tmp/dsh-url' })
  // Expand every collapsed section, including the machine form's advanced area.
  for (const i of hookState.map((v, j) => (v === false ? j : -1)).filter((j) => j >= 0)) setters[i](true)
  tree = render()
  const inputs = findAll(tree, (el) => el.props && el.props['data-testid'] === 'web-attach-discover-command')
  assert.equal(inputs.length, 1, 'the discover command input is really mounted')
  assert.equal(inputs[0].props.value, 'cat /tmp/dsh-url')
  assert.match(inputs[0].props.placeholder, /留空 = 总是新起一个远端 dsh web/)
  inputs[0].props.onChange({ target: { value: 'powershell -NoProfile -Command "Get-Content $env:USERPROFILE\\.dsh-web-url"' } })
  tree = render()
  const changed = findAll(tree, (el) => el.props && el.props['data-testid'] === 'web-attach-discover-command')
  assert.match(changed[0].props.value, /^powershell /, 'editing flows back into the real form state')
})

test('no backup i18n key survives the capability removal', () => {
  // The card is gone; nothing backup-shaped may render in ANY section state.
  // This test owns its hook state: the first test's arrays belong to ITS render
  // (their cursor positions would corrupt a fresh mount's slots).
  const { Page } = mountClient()
  const hookState = []
  const setters = []
  let hookIndex = 0
  installTestDispatcher(React, {
    useState(init) { const i = hookIndex++; if (hookState[i] === undefined) hookState[i] = typeof init === 'function' ? init() : init; if (!setters[i]) setters[i] = (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v }; return [hookState[i], setters[i]] },
    useEffect() {}, useLayoutEffect() {}, useInsertionEffect() {},
    useMemo(fn) { return fn() }, useCallback(fn) { return fn },
    useRef(v) { return { current: v } }, useContext() { return {} },
    useReducer(_r, init) { return [init, () => {}] },
    useDebugValue() {}, useId() { return 'id' },
    useTransition() { return [false, (f) => f && f()] }, useDeferredValue(v) { return v },
    useImperativeHandle() {},
  })
  const render = () => { hookIndex = 0; return collectText(Page({})) }
  const collapsed = render()
  // Expand every collapsed section: the removal must hold everywhere, not only
  // in the default view.
  const collapsedIdx = hookState.map((v, i) => (v === false ? i : -1)).filter((i) => i >= 0)
  for (const i of collapsedIdx) setters[i](true)
  const expanded = render()
  for (const text of [collapsed, expanded]) {
    assert.doesNotMatch(text, /工作区备份|备份时间点|选择要恢复/, 'no backup UI survives anywhere')
  }
})
