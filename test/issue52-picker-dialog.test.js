// Issue #52 — the workspace picker's two compounded defects.
//
//   1. A bare `onClick` on a modal backdrop closes on ANY click whose press and
//      release share an ancestor. Picking an autocomplete suggestion presses an
//      element INSIDE the panel; the panel then re-lays-out (the suggestion list
//      used to be in document flow), so the release lands on the backdrop — and
//      `click` is dispatched on the backdrop, closing the whole dialog. The
//      guard must be "did the press START here", not "did the click reach me".
//   2. The suggestion list used to be an in-flow block, so expanding it pushed
//      the primary 「设为远程工作区」 button down: a button the user aims at moves
//      away mid-gesture.
//
// These run the REAL DirPicker from lib/client.js with REAL React and a fake
// hook dispatcher (the settings-render.test.js pattern — no jsdom needed), then
// drive the actual props the browser would invoke. Asserting on the source text
// would not prove the guard fires for the right gesture.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const require = createRequire(import.meta.url)
const React = require('react')
const src = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

/** Load the client bundle and return the DirPicker component it registers. */
function loadDirPicker() {
  let loaded = null
  const sandbox = {
    window: {
      addEventListener: () => {},
      location: { protocol: 'http:', href: 'http://127.0.0.1:3080/' },
      localStorage: { getItem: () => null, setItem: () => {} },
      __ModuleLoader__: { load: (m) => { loaded = m } },
    },
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
      getElementById: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    navigator: { clipboard: null, userAgent: 'node', languages: ['zh-CN'] },
    setTimeout, clearTimeout, console,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { relativeTime: () => ({ unit: 'now', n: 0 }) }
    throw new Error('unexpected require: ' + id)
  }
  const run = new Function(
    // (sourceURL: attribute V8 coverage of the eval'd body to lib/client.js)
    'window', 'document', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'fetch', 'require', `${src}\n//# sourceURL=lib/client.js`,
  )
  run(sandbox.window, sandbox.document, sandbox.navigator, setTimeout, clearTimeout, console, sandbox.fetch, requireStub)

  const mod = loaded.factory(requireStub)
  let Picker = null
  const ctx = {
    get(name) {
      if (name === 'locale') return { register: () => {}, bind: () => (k) => k }
      if (name === 'slots') {
        return {
          inject: (slot, fn) => { fn(); return () => {} },
          register: (decl, comp) => {
            // DirPicker is registered into the two directory-flow slots.
            if (String(decl && decl.name || '').includes('directoryFlow') && typeof comp === 'function') Picker = comp
            return () => {}
          },
          get: () => [],
        }
      }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {} }) } }
      if (name === 'betterSidebar' || name === 'sidebarRightTabs' || name === 'directoryPicker') return undefined
      return undefined
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(names, cb) { if (names.every((n) => this.get(n) !== undefined)) cb(this) },
    on() {},
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  }
  mod.apply(ctx)
  assert.ok(Picker, 'lib/client.js must register DirPicker into a directoryFlow slot')
  return Picker
}

const Picker = loadDirPicker()

/** Mount DirPicker once, capturing its hook state and setters. */
function mount(props = {}) {
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
  // DirPicker's hook order: 0 tab 1 machines 2 machineId 3 path 4 items 5 err
  // 6 loading 7 levels 8 popOpen 9 suggest 10 suggestOpen 11 recent 12 win
  // 13 localPop 14 newDirName 15 mkdirPrompt 16 mOpen
  const render = () => {
    hookIndex = 0
    return Picker({ open: true, busy: false, onPicked: () => {}, onCancel: () => { cancellations.n++ }, ...props })
  }
  // The setters array is only populated by a render; do one now (its output is
  // discarded) so callers can drive state before rendering what they assert on.
  render()
  return { render, hookState, setters, cancelled: () => cancellations.n }
}

/** Every element in the tree (depth-first). */
function elements(tree, out = []) {
  if (Array.isArray(tree)) { for (const t of tree) elements(t, out); return out }
  if (tree == null || typeof tree !== 'object') return out
  if (tree.props !== undefined) out.push(tree)
  if (tree.props) elements(tree.props.children, out)
  return out
}

/** The full-screen fixed backdrop of the picker modal. */
function backdropOf(tree) {
  const hit = elements(tree).find((el) => {
    const s = (el.props && el.props.style) || {}
    return s.position === 'fixed' && s.inset === 0 && typeof el.props.onMouseDown === 'function'
  })
  assert.ok(hit, 'the modal must render a guarded full-screen backdrop')
  return hit
}

/** Drive the picker into the "remote tab, machine chosen, suggestions open" state. */
function remoteWithSuggestions() {
  const m = mount()
  m.setters[0]('remote')                 // tab
  m.setters[1]([{ id: 'm1', name: 'dev', host: '10.0.0.1', port: 22, username: 'dev' }])
  m.setters[2]('m1')                     // machineId
  m.setters[3]('/home/')                 // path
  m.setters[9](['/home/dev', '/home/a']) // suggest
  m.setters[10](true)                    // suggestOpen
  return m
}

// ── defect 1: the backdrop guard ────────────────────────────────────────────

test('#52: a press that STARTS inside the panel does not dismiss the dialog when released on the backdrop', () => {
  const m = remoteWithSuggestions()
  const tree = m.render()
  const backdrop = backdropOf(tree)

  // The suggestion's own mousedown (a different target than the backdrop) ...
  backdrop.props.onMouseDown({ target: { kind: 'suggestion' }, currentTarget: backdrop })
  // ... then the browser reports the click on the backdrop, because the panel
  // moved under the pointer mid-gesture (this is the real repro).
  backdrop.props.onClick({ target: backdrop, currentTarget: backdrop })
  assert.equal(m.cancelled(), 0, 'a gesture that began on a suggestion must never close the dialog')
})

test('#52: a press that STARTS on the backdrop still dismisses it (the guard is not "never close")', () => {
  const m = remoteWithSuggestions()
  const tree = m.render()
  const backdrop = backdropOf(tree)

  backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop })
  backdrop.props.onClick({ target: backdrop, currentTarget: backdrop })
  assert.equal(m.cancelled(), 1, 'click-outside-to-dismiss must keep working')
})

test('#52: the guard re-arms per gesture (a stale press cannot dismiss a later click)', () => {
  const m = remoteWithSuggestions()
  const tree = m.render()
  const backdrop = backdropOf(tree)

  // Press inside, release on backdrop → ignored (and the flag must RESET).
  backdrop.props.onMouseDown({ target: { kind: 'suggestion' }, currentTarget: backdrop })
  backdrop.props.onClick({ target: backdrop, currentTarget: backdrop })
  assert.equal(m.cancelled(), 0)
  // A later, genuine backdrop click must still work; a stuck flag would break it.
  backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop })
  backdrop.props.onClick({ target: backdrop, currentTarget: backdrop })
  assert.equal(m.cancelled(), 1, 'the guard must reset after every gesture')
})

test('#52: every full-screen backdrop in the picker is guarded, not just the modal', () => {
  // The modal and the local-browse popup are distinct overlays. Both must carry
  // the press-origin guard, and neither may use a bare onClick to dismiss.
  // The local popup only renders on the LOCAL tab, so exercise both tabs.
  const remote = remoteWithSuggestions()
  const remoteTree = remote.render()
  const local = mount()
  local.setters[0]('local')                                    // tab
  local.setters[13]({ path: '/tmp', home: '/home/u', crumbs: [], entries: [], truncated: false }) // localPop
  const localTree = local.render()

  const backdrops = [...elements(remoteTree), ...elements(localTree)].filter((el) => {
    const s = (el.props && el.props.style) || {}
    return s.position === 'fixed' && s.inset === 0
  })
  assert.ok(backdrops.length >= 2,
    `both the modal and the local-browse popup are full-screen overlays (found ${backdrops.length})`)
  for (const el of backdrops) {
    assert.equal(typeof el.props.onMouseDown, 'function',
      'a full-screen backdrop without a press-origin guard can be dismissed by a drag that merely ends on it')
  }
})

test('#52: the suggestion item swallows the gesture so no ancestor sees a click that began on it', () => {
  const m = remoteWithSuggestions()
  const tree = m.render()
  const rows = elements(tree).filter((el) => el.props.className === 'dsh-rw-list-item')
  assert.ok(rows.length >= 2, 'suggestions render as list items')
  // The machine dropdown also uses dsh-rw-list-item; the suggestion rows are the
  // ones whose mousedown takes an event argument (they call preventDefault).
  const suggestionRow = rows.find((el) => el.props.onMouseDown.length >= 1)
  assert.ok(suggestionRow, 'a suggestion row must accept the event so it can swallow the gesture')

  let prevented = false
  let stopped = false
  suggestionRow.props.onMouseDown({
    preventDefault: () => { prevented = true },
    stopPropagation: () => { stopped = true },
  })
  assert.equal(prevented, true, 'preventDefault keeps the press from becoming a click on the backdrop')
  assert.equal(stopped, true, 'stopPropagation keeps the gesture away from every ancestor')
})

// ── defect 2: the dropdown must not push the primary button ─────────────────

test('#52: the suggestion dropdown is out of document flow, so it cannot push the primary button', () => {
  const m = remoteWithSuggestions()
  const tree = m.render()

  const dropdown = elements(tree).find((el) => {
    const s = (el.props && el.props.style) || {}
    return s.position === 'absolute' && s.top === '100%' && typeof s.maxHeight === 'number' && s.zIndex
  })
  assert.ok(dropdown, 'the suggestion dropdown must be absolutely positioned against suggestRef')
  assert.equal(dropdown.props.style.zIndex, 60)
  assert.ok(!dropdown.props.style.position.match(/static|relative/),
    'an in-flow (static/relative) dropdown reflows the panel and moves the button')
})

test('#52: the action row is lifted above the dropdown and is opaque', () => {
  const m = remoteWithSuggestions()
  const tree = m.render()

  // The row holding 「设为远程工作区」 is the flex-end row whose child is a primary button.
  const row = elements(tree).find((el) => {
    const s = (el.props && el.props.style) || {}
    if (s.justifyContent !== 'flex-end' || !s.zIndex) return false
    return elements(el).some((c) => typeof c.props.className === 'string' && c.props.className.includes('dsh-rw-primary'))
  })
  assert.ok(row, 'the action row must sit above the dropdown')
  assert.ok(row.props.style.zIndex > 60, `the action row zIndex (${row.props.style.zIndex}) must exceed the dropdown's 60`)
  assert.ok(row.props.style.background, 'an opaque action row lets the list slide underneath it')
})

test('#52: the remote column stops clipping when the dropdown is open', () => {
  const m = remoteWithSuggestions()
  const tree = m.render()
  // Opening must switch the scroll container to `visible`, or an absolutely
  // positioned dropdown is clipped by its own scroller.
  const scroller = elements(tree).find((el) => el.props.style && el.props.style.overflowY === 'visible')
  assert.ok(scroller, 'the remote column must not clip the absolutely positioned dropdown')
})
