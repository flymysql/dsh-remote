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
import { fakeTimers } from './harness/fake-timers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const require = createRequire(import.meta.url)
const React = require('react')
const src = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

/** Load the client bundle and return the DirPicker component it registers. */
function loadDirPicker(opts = {}) {
  let loaded = null
  const timers = fakeTimers()
  const requests = []
  const sandbox = {
    window: {
      addEventListener: () => {},
      location: { protocol: 'http:', href: 'http://127.0.0.1:3080/' },
      localStorage: { getItem: () => null, setItem: () => {} },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
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
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, console,
    fetch: opts.fetch || (async () => ({ ok: true, json: async () => ({}) })),
  }
  if (opts.fetch) {
    const inner = opts.fetch
    sandbox.fetch = async (url, options) => { requests.push({ url: String(url), options }); return inner(url, options) }
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
  return { Picker, timers, requests }
}

const { Picker } = loadDirPicker()

/** Mount DirPicker once, capturing its hook state and setters. */
function mount(props = {}, Comp = Picker) {
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
    return Comp({ open: true, busy: false, onPicked: () => {}, onCancel: () => { cancellations.n++ }, ...props })
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

// ── the render-level click chain (testing.md §7's open item) ────────────────
// Route level already proved /mirror → mirror → rw_sync; this pins the CLIENT
// half end to end: typing → debounce → suggestions → pick → submit → mirror.

test('click chain: type → 220ms debounce → suggestion pick → submit → mirror created', async () => {
  const MACHINE = { id: 'm1', name: 'dev', host: '10.0.0.1', port: 22, username: 'dev' }
  const MIRROR = 'C:\\Users\\me\\.dsh\\remote-workspaces\\m1\\dev'
  const { Picker: P, timers, requests } = loadDirPicker({
    fetch: async (url) => {
      const u = String(url)
      if (u.includes('/dsh-remote/ls?')) {
        return { ok: true, json: async () => ({
          path: '/home', platform: 'posix',
          machine: { host: '10.0.0.1', port: 22, username: 'dev' },
          items: [
            { type: 'dir', name: 'dev', path: '/home/dev' },
            { type: 'dir', name: 'app', path: '/home/app' },
            { type: 'file', name: 'README.md', path: '/home/README.md' },
          ],
        }) }
      }
      if (u.includes('/dsh-remote/current')) return { ok: true, json: async () => ({ ok: true }) }
      if (u.includes('/dsh-remote/mirror')) return { ok: true, json: async () => ({ ok: true, localMirror: MIRROR, path: '/home/dev' }) }
      return { ok: true, json: async () => ({}) }
    },
  })
  const picked = []
  const m = mount({ onPicked: (local, remote) => picked.push([local, remote]) }, P)
  m.setters[0]('remote')
  m.setters[1]([MACHINE])
  m.setters[2]('m1')
  // Poll-until-quiescent, never a magic tick count: a fixed N ticks makes the
  // UNASSERTED tail of the chain (the fresh /ls after a pick, the mirror .then)
  // land or not depending on machine load — which is exactly the client.js
  // coverage wobble this test must not reintroduce.
  const until = async (cond, what) => {
    for (let i = 0; i < 200; i++) {
      if (cond()) return
      await new Promise((r) => setImmediate(r))
    }
    assert.fail(`timed out waiting for: ${what}`)
  }

  // 1) Type into the REMOTE path box (the only text input on the remote tab).
  let tree = m.render()
  const pathInput = () => elements(tree).filter((el) => el.type === 'input' && typeof el.props.onChange === 'function')
  assert.equal(pathInput().length, 1, 'the remote tab has exactly one text input')
  pathInput()[0].props.onChange({ target: { value: '/home/' } })
  assert.equal(timers.pending(), 1, 'typing schedules the 220ms debounce, nothing fires yet')

  // 2) The debounce fires deterministically — no wall clock involved.
  timers.flush(220)
  await until(() => requests.some((r) => r.url.includes('/dsh-remote/ls?path=%2Fhome')), 'the /ls request')
  // The suggestions state is set in the SAME chain after the listing resolves;
  // wait for the state, not the request, before rendering what we assert on.
  await until(() => m.hookState[10] === true, 'the open dropdown state')
  tree = m.render()
  const items = elements(tree).filter((el) => el.props && el.props.className === 'dsh-rw-list-item')
  assert.deepEqual(items.map((el) => el.props.children), ['/home/app', '/home/dev'], 'dirs only, sorted')

  // 3) Click the 「/home/dev」 suggestion: path gains the trailing separator
  //    and a FRESH listing is requested for the new directory.
  const dev = items.find((el) => el.props.children === '/home/dev')
  dev.props.onMouseDown({ preventDefault() {}, stopPropagation() {} })
  await until(() => m.hookState[3] === '/home/dev/', 'the input to show the picked dir')
  await until(() => requests.some((r) => r.url.includes('/dsh-remote/ls?path=%2Fhome%2Fdev')), 'the fresh listing of the picked dir')
  tree = m.render()
  assert.equal(pathInput()[0].props.value, '/home/dev/', 'picking appends the separator for continued typing')

  // 4) Submit: /current asserts the machine BEFORE /mirror creates anything.
  //    (This sandbox runs the zh-CN dictionaries, so the label is the real
  //    user-facing text, not the key.)
  const submit = elements(tree).find((el) => el.type === 'button' && el.props.children === '设为远程工作区')
  assert.ok(submit, 'the submit button renders with its visible label')
  assert.equal(submit.props.disabled, false)
  submit.props.onClick()
  await until(() => picked.length === 1, 'onPicked after the mirror chain')

  const posts = requests.filter((r) => r.options && r.options.method === 'POST')
  const current = posts.findIndex((r) => r.url.includes('/dsh-remote/current'))
  const mirror = posts.findIndex((r) => r.url.includes('/dsh-remote/mirror'))
  assert.ok(current >= 0 && mirror > current, '/current must land before /mirror (machine identity contract)')
  const body = JSON.parse(posts[mirror].options.body)
  // Note: the picker keeps the trailing separator it appended for continued
  // typing; the host normalizes it (its reply carries the clean path, which is
  // what onPicked reports). This pins the current wire shape.
  assert.deepEqual(body, { path: '/home/dev/', machineId: 'm1', registerWorkspace: true })
  assert.deepEqual(picked, [[MIRROR, '/home/dev']], 'onPicked hands back (localMirror, remotePath)')
})
