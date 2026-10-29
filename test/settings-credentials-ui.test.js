// The settings UI contract the user was (rightly) angry about:
//
//   1. 「密码框为什么是空白？？？」 — after saving a password, the box came back
//      empty with a neutral placeholder, i.e. the UI looked like the plugin had
//      forgotten it. Secrets never travel back to the browser, so the ONLY honest
//      signal is a masked placeholder ("••••••••（已保存）") plus a hint.
//
//   2. 「点保存后不能点测试」 — save() called clearForm(), which emptied `host`;
//      the 测试连接 button is disabled without a host, so it went dead at exactly
//      the moment the user wanted to verify what they had just saved.
//
// This drives the REAL component with REAL React (same harness idea as
// settings-render.test.js) and clicks the REAL buttons, because both defects are
// invisible to a source-level assertion: they are about which props the rendered
// elements end up with after a click.

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

const MACHINE = {
  id: 'm-test',
  name: 'box',
  host: '10.0.0.9',
  port: 22,
  username: 'root',
  passwordSet: true,
  passphraseSet: false,
  credentialBackend: 'plain',
  useAgent: false,
  keyboardInteractive: false,
  useSshConfig: false,
  backend: 'native',
  recentWorkspaces: [],
}

/** Load the client bundle, run apply(), and hand back the settings component plus
 *  the mutable machine list the fake host serves. */
function mountClient() {
  const list = [{ ...MACHINE }]
  const calls = []
  const fetchStub = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ method, url: String(url), body })
    const reply = (obj) => ({ ok: true, status: 200, json: async () => obj })
    if (String(url).includes('/dsh-remote/machines')) {
      if (method === 'POST') {
        const id = body.id || 'm-new'
        const rec = { ...MACHINE, ...body, id, passwordSet: !!body.password || MACHINE.passwordSet }
        delete rec.password
        const at = list.findIndex((m) => m.id === id)
        if (at >= 0) list[at] = rec; else list.push(rec)
        return reply({ ok: true, machine: rec, machines: list.map((m) => ({ ...m })), currentId: '' })
      }
      return reply({ machines: list.map((m) => ({ ...m })), currentId: '' })
    }
    if (String(url).includes('/dsh-remote/test-connect')) {
      return reply({ ok: true, host: '10.0.0.9', user: 'root', latencyMs: 7, platform: 'posix', usedSavedCredential: true })
    }
    return reply({})
  }
  let loaded = null
  const sandbox = {
    window: {
      addEventListener: () => {},
      location: { protocol: 'http:', href: 'http://127.0.0.1:3080/' },
      localStorage: { getItem: () => null, setItem: () => {} },
      confirm: () => true,
      __ModuleLoader__: { load: (m) => { loaded = m } },
    },
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
      getElementById: () => null,
    },
    navigator: { clipboard: null, userAgent: 'node', languages: ['zh-CN'] },
    setTimeout, clearTimeout, console,
    fetch: fetchStub,
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { relativeTime: () => ({ unit: 'now', n: 0 }) }
    throw new Error('unexpected require: ' + id)
  }
  const run = new Function(
    'window', 'document', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'fetch', 'require', src,
  )
  run(sandbox.window, sandbox.document, sandbox.navigator, setTimeout, clearTimeout, console, fetchStub, requireStub)

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
  return { Page, calls, list }
}

/** A minimal but faithful hook driver: state lives in an array (positional, like
 *  React), effects run once per hook slot, and re-rendering re-reads the state. */
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
  // React 18 reads `.current` off the captured dispatcher OBJECT, so it must be
  // mutated in place (assigning a new object leaves React with a null dispatcher).
  React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher

  const settle = async () => {
    // The registered section is a thin, hook-free wrapper
    // (`() => React.createElement(RemoteWorkspacePage, null)`), so mounting it
    // once is enough to reach the real page — and it keeps the hook slots in one
    // flat positional array, which is all this driver models.
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
    for (let pass = 0; pass < 8; pass++) {
      tree = renderPage()
      const batch = pending
      if (!batch.length) return tree
      for (const fn of batch) {
        const c = fn()
        if (typeof c === 'function') cleanups.push(c)
      }
      // Let the promise chains inside the effects land before re-rendering.
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    }
    return tree
  }
  const dispose = () => { for (const c of cleanups.splice(0)) { try { c() } catch {} } }
  return { settle, dispose }
}

/** Collect every element in the tree (no component mounting — the settings panel
 *  builds its whole subtree inline, so the controls are all reachable). */
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

const passwordInputs = (tree) => elements(tree).filter((el) => el.type === 'input' && el.props.type === 'password')

test('editing a machine shows its saved password as dots instead of an empty box', async () => {
  const { Page } = mountClient()
  const { settle, dispose } = makeDriver(Page)
  try {
    let tree = await settle()
    buttonByText(tree, /^(编辑|Edit)$/).props.onClick()
    tree = await settle()

    const pwd = passwordInputs(tree)
    assert.equal(pwd.length, 1, 'the SSH password box is the only visible secret input')
    assert.match(String(pwd[0].props.placeholder), /•{6,}/,
      `a saved password must render as dots, got placeholder: ${pwd[0].props.placeholder}`)
    assert.equal(pwd[0].props.value, '', 'the secret itself must NOT be put into the DOM')
    // …and the page says, in words, what an empty box will do.
    const hint = elements(tree).some((el) => /留空保存 = 沿用已保存的密码/.test(textOf(el)))
    assert.ok(hint, 'the saved-password hint must be visible under the field')
  } finally { dispose() }
})

test('a machine with no credential at all says so before the user hits 连接', async () => {
  const { Page, list } = mountClient()
  list[0] = { ...MACHINE, passwordSet: false }
  const { settle, dispose } = makeDriver(Page)
  try {
    let tree = await settle()
    buttonByText(tree, /^(编辑|Edit)$/).props.onClick()
    tree = await settle()
    const pwd = passwordInputs(tree)
    assert.equal(pwd.length, 1)
    assert.doesNotMatch(String(pwd[0].props.placeholder), /•/, 'nothing is saved, so no dots')
    assert.ok(elements(tree).some((el) => /还没有任何凭据/.test(textOf(el))),
      'the "no credential yet" warning must be rendered')
  } finally { dispose() }
})

test('saving keeps the form bound to the machine, so 测试连接 stays clickable', async () => {
  const { Page, calls } = mountClient()
  const { settle, dispose } = makeDriver(Page)
  try {
    let tree = await settle()
    buttonByText(tree, /^(编辑|Edit)$/).props.onClick()
    tree = await settle()

    const testBefore = buttonByText(tree, /^(测试连接|Test connection)$/)
    assert.equal(testBefore.props.disabled, false, 'test must be available while editing')

    buttonByText(tree, /^(保存|Save)$/).props.onClick()
    // save() → fetch → .then(refresh) → .then(setForm/clearForm)
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
    tree = await settle()

    const testAfter = buttonByText(tree, /^(测试连接|Test connection)$/)
    assert.equal(testAfter.props.disabled, false,
      'the 测试连接 button must still be enabled after a save (it used to go dead because save() cleared the host)')

    // The saved machine is still the form's subject, and the secret box reports
    // the credential it now holds.
    const pwd = passwordInputs(tree)
    assert.equal(pwd.length, 1)
    assert.equal(pwd[0].props.value, '', 'the secret input is cleared after a save')
    assert.match(String(pwd[0].props.placeholder), /•{6,}/, 'the placeholder must confirm the saved password')

    // And the save posted the machine identity, not a blank record.
    const posted = calls.find((c) => c.method === 'POST' && c.url.includes('/dsh-remote/machines'))
    assert.ok(posted, 'a save request must have been sent')
    assert.equal(posted.body.host, '10.0.0.9')
  } finally { dispose() }
})

test('测试连接 posts the machine id and the auth flags so the host can reuse saved credentials', async () => {
  const { Page, calls } = mountClient()
  const { settle, dispose } = makeDriver(Page)
  try {
    let tree = await settle()
    buttonByText(tree, /^(编辑|Edit)$/).props.onClick()
    tree = await settle()
    buttonByText(tree, /^(测试连接|Test connection)$/).props.onClick()
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
    tree = await settle()

    const probe = calls.find((c) => c.url.includes('/dsh-remote/test-connect'))
    assert.ok(probe, 'a probe request must have been sent')
    assert.equal(probe.body.id, 'm-test', 'the host needs the machine id to resolve its saved password')
    assert.equal(probe.body.password, '', 'the form cannot send the secret back — the host must merge it')
    assert.equal(probe.body.useAgent, false, 'auth method flags travel with the probe')
    // The success path tells the user the saved credential was used.
    assert.ok(elements(tree).some((el) => /本次测试使用了已保存的密码/.test(textOf(el))),
      'the panel must say the probe used the saved password')
  } finally { dispose() }
})
