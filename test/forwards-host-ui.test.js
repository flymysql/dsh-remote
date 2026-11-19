// The two settings-page holes behind "我新加的 host 没法配置转发":
//
//   1. The port-forward form had no host field at all. `define` tagged whatever
//      machine happened to be connected, so a host that was not connected could
//      never be given a tunnel — and there was no way to say "this forward is for
//      that host".
//   2. A host added to ~/.ssh/config rendered in the host list WITHOUT any
//      actions (only a probe), because only SAVED machines had the `...` menu.
//      There was therefore no edit entry and no place to type the login password;
//      that in turn made the host impossible to connect, hence impossible to
//      forward through.
//
// Both defects are about which props the rendered controls end up with after a
// click, so this drives the REAL settings component with REAL React (same harness
// idea as settings-credentials-ui.test.js) instead of asserting on source text.

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

const CURRENT = {
  id: 'm-current', name: 'box', host: '10.0.0.9', port: 22, username: 'root',
  passwordSet: true, passphraseSet: false, credentialBackend: 'plain',
  useAgent: false, keyboardInteractive: false, useSshConfig: false, backend: 'native',
  recentWorkspaces: [],
}
const OTHER = {
  ...CURRENT, id: 'm-other', name: 'other', host: '10.0.0.10',
}
const SSH_HOST = { alias: '172.16.11.143', host: '172.16.11.143', user: 'kali', port: 22 }

/** Load the client bundle, run apply(), expose the settings component and the
 *  request log. The fake host answers the three routes this page reads. */
function mountClient(opts = {}) {
  const list = [{ ...CURRENT }, { ...OTHER }]
  const forwards = (opts.forwards || []).map((f) => ({ ...f }))
  const calls = []
  const fetchStub = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ method, url: String(url), body })
    const reply = (obj) => ({ ok: true, status: 200, json: async () => obj })
    const u = String(url)
    if (u.includes('/dsh-remote/machines')) {
      if (method === 'POST') {
        const id = body.id || 'm-adopted'
        const rec = {
          ...CURRENT, ...body, id,
          passwordSet: !!body.password || (body.id ? CURRENT.passwordSet : false),
          passphraseSet: false, credentialBackend: 'plain',
        }
        delete rec.password
        const at = list.findIndex((m) => m.id === id)
        if (at >= 0) list[at] = rec; else list.push(rec)
        return reply({ ok: true, machine: rec, machines: list.map((m) => ({ ...m })), currentId: 'm-current' })
      }
      return reply({ machines: list.map((m) => ({ ...m })), currentId: 'm-current' })
    }
    if (u.includes('/dsh-remote/ssh-config')) {
      return reply({ entries: [{ ...SSH_HOST }], file: '/home/u/.ssh/config' })
    }
    if (u.includes('/dsh-remote/forwards')) {
      if (method === 'POST') {
        if (body.action === 'define') {
          const forward = {
            id: 'fwd-new', direction: body.direction, listenPort: body.listenPort,
            targetHost: body.targetHost, targetPort: body.targetPort,
            // A pre-#PR host half ignores the field and tags the ACTIVE machine.
            machineId: opts.ignoreForwardHost ? 'm-current' : body.machineId,
            autoStart: !!body.autoStart, active: false,
          }
          forwards.push(forward)
          return reply({ ok: true, forward, forwards: forwards.map((f) => ({ ...f })) })
        }
        const forward = forwards.find((f) => f.id === body.id)
        if (body.action === 'update') {
          // A pre-edit host half knows only 自动重连 and ignores the rest.
          const keys = opts.ignoreForwardEdit ? ['autoStart'] : ['direction', 'listenPort', 'targetHost', 'targetPort', 'machineId', 'autoStart']
          for (const key of keys) {
            if (key in body) forward[key] = body[key]
          }
        } else if (body.action === 'remove') {
          const at = forwards.indexOf(forward); if (at >= 0) forwards.splice(at, 1)
        } else if (body.action === 'start') forward.active = true
        else if (body.action === 'stop') forward.active = false
        return reply({ ok: true, forward, forwards: forwards.map((f) => ({ ...f })) })
      }
      return reply({ forwards: forwards.map((f) => ({ ...f })) })
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
    fetch: fetchStub,
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { relativeTime: () => ({ unit: 'now', n: 0 }), ...(opts.primitives || {}) }
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
  return { Page, calls, list }
}

/** Positional hook driver (same shape as settings-credentials-ui.test.js). */
function makeDriver(Page) {
  const state = []
  const refs = new Map()
  const deps = new Map()
  const cleanups = []
  let cursor = 0
  let pending = []

  const dispatcher = {
    useState(init) {
      const i = cursor++
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
      return [state[i], (v) => { state[i] = typeof v === 'function' ? v(state[i]) : v }]
    },
    // Dependency-aware, unlike the older rigs: the forwards form is filled by an
    // effect that fires only after /machines answers, and a run-once model would
    // never exercise the re-render the user actually sees.
    useEffect(fn, list) {
      const i = cursor++
      const prev = deps.get(i)
      const changed = !prev || !list || list.length !== prev.length || list.some((d, k) => !Object.is(d, prev[k]))
      if (changed) { deps.set(i, list || []); pending.push(fn) }
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
  installTestDispatcher(React, dispatcher)

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
    for (let pass = 0; pass < 8; pass++) {
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
  return elements(tree).filter((el) => el.type === 'button' && re.test(textOf(el).trim()))
}

/** Flush the promise chains started by a click (fetch → setState → refresh). */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

test('the forward form names its host instead of inheriting the connected one', async () => {
  const { Page, calls } = mountClient()
  const { settle, dispose } = makeDriver(Page)
  try {
    let tree = await settle()
    // The forwards panel is collapsed by default; open it the way a user does.
    const toggle = buttonByText(tree, /端口转发/)
    assert.equal(toggle.length, 1, 'the forwards section toggle must render')
    toggle[0].props.onClick()
    tree = await settle()

    const select = elements(tree).find((el) => el.type === 'select' && el.props['data-testid'] === 'fwd-host')
    assert.ok(select, 'the add-forward form must render a host selector')
    assert.equal(select.props.value, 'm-current', 'it defaults to the currently connected machine')
    const options = elements(select).filter((el) => el.type === 'option').map(textOf)
    assert.ok(options.some((t) => /box/.test(t) && /当前/.test(t)), `current host must be marked, got: ${options.join(' | ')}`)
    assert.ok(options.some((t) => /other/.test(t)), 'every saved machine is selectable, not just the connected one')

    // Pick the host that is NOT connected, then fill the port and add.
    select.props.onChange({ target: { value: 'm-other' } })
    tree = await settle()
    const listen = elements(tree).find((el) => el.type === 'input' && el.props.placeholder === '监听端口')
    assert.ok(listen, 'the listen-port field must render')
    listen.props.onChange({ target: { value: '9000' } })
    tree = await settle()

    const add = buttonByText(tree, /^添加转发$/)
    assert.equal(add.length, 1, 'the add button must render')
    assert.equal(add[0].props.disabled, false, 'a chosen host + port must enable 添加转发')
    add[0].props.onClick()
    await flush()
    await settle()

    const posted = calls.find((c) => c.method === 'POST' && c.url.includes('/dsh-remote/forwards'))
    assert.ok(posted, 'a define request must be sent')
    assert.equal(posted.body.machineId, 'm-other', 'the selected host must own the definition')
    assert.equal(posted.body.listenPort, 9000)
  } finally { dispose() }
})

test('an unsaved ~/.ssh/config host has an edit entry that can save a login password', async () => {
  // A host Menu primitive present: this is the production path, where the
  // discovered row's `...` opens the same portaled menu as a saved machine.
  const Menu = ({ items, onSelect }) => React.createElement('div', { 'data-fake-menu': true },
    items.map((it) => React.createElement('button', { key: it.id, 'data-menu-item': it.id, onClick: () => onSelect(it.id) }, it.label)))
  const { Page, calls, list } = mountClient({ primitives: { Menu } })
  const { settle, dispose } = makeDriver(Page)
  try {
    let tree = await settle()
    // The discovered row now carries the SAME `...` menu trigger as a saved
    // machine (it used to be a bare text button that turned into `...` after the
    // first save).
    const triggers = elements(tree).filter((el) => el.type === 'button' && /保存为机器/.test(String(el.props['aria-label'])))
    assert.equal(triggers.length, 1, `exactly one menu trigger (the SSH-config host), got ${triggers.length}`)
    assert.equal(triggers[0].props['aria-haspopup'], 'menu', 'it must be a menu, not a one-off button')

    const triggerEl = { focus() {}, getBoundingClientRect: () => ({ top: 7, left: 3, right: 13, bottom: 27, width: 10, height: 20 }) }
    triggers[0].props.onClick({ currentTarget: triggerEl })
    tree = await settle()
    // The shared host menu mounts as a function component; assert on the props
    // it is handed (anchor + items + handler) and drive its selection.
    const menu = elements(tree).find((el) => el.type === Menu)
    assert.ok(menu, 'the `...` trigger must open the shared host menu')
    assert.equal(menu.props.anchor, null)
    assert.equal(menu.props.anchorRef.current, triggerEl,
      'the menu must be anchored to the button that was pressed, not to a stale rect')
    assert.equal(typeof menu.props.returnFocus, 'function', 'closing must return focus to the trigger')
    // Pre-0.2.2 hosts only know the rect prop; they must keep working too.
    assert.equal(typeof menu.props.getAnchorRect, 'function')
    assert.equal(menu.props.getAnchorRect().top, 7, 'the legacy rect comes from the pressed button')
    assert.deepEqual(menu.props.items.map((it) => it.id), ['edit'],
      'a discovered alias offers 编辑 only (there is no registry record to delete)')
    menu.props.onSelect('edit')
    tree = await settle()

    // The machine form is now open, prefilled as an ALIAS.
    const hostInput = elements(tree).find((el) => el.type === 'input' && el.props.value === SSH_HOST.alias)
    assert.ok(hostInput, 'the form must be prefilled with the SSH-config host')
    const pwd = elements(tree).find((el) => el.type === 'input' && el.props.type === 'password' && /SSH 密码/.test(String(el.props.placeholder)))
    assert.ok(pwd, 'the form must offer the login-password field for this host')
    pwd.props.onChange({ target: { value: 'kali-pw' } })
    tree = await settle()

    const save = buttonByText(tree, /^保存$/)
    assert.equal(save.length, 1, 'the save button must render')
    save[0].props.onClick()
    await flush()
    tree = await settle()

    const posted = calls.find((c) => c.method === 'POST' && c.url.includes('/dsh-remote/machines'))
    assert.ok(posted, 'saving must create a machine record')
    assert.equal(posted.body.action, 'add', 'a discovered host is ADDED, never silently rewritten on disk')
    assert.equal(posted.body.host, SSH_HOST.alias)
    assert.equal(posted.body.useSshConfig, true, 'the alias stays the source of truth')
    assert.equal(posted.body.backend, 'openssh', 'the user\'s own ssh interprets the Host block')
    assert.equal(posted.body.password, 'kali-pw', 'the password the user typed must be saved')
    assert.ok(list.some((m) => m.host === SSH_HOST.alias), 'the adopted host shows up as a saved machine')
  } finally { dispose() }
})
test('a host half that ignores the host field cannot leave the tunnel on the wrong machine', async () => {
  const { Page, calls } = mountClient({ ignoreForwardHost: true })
  const { settle, dispose } = makeDriver(Page)
  try {
    let tree = await settle()
    buttonByText(tree, /端口转发/)[0].props.onClick()
    tree = await settle()
    const select = elements(tree).find((el) => el.type === 'select' && el.props['data-testid'] === 'fwd-host')
    select.props.onChange({ target: { value: 'm-other' } })
    tree = await settle()
    elements(tree).find((el) => el.type === 'input' && el.props.placeholder === '监听端口').props.onChange({ target: { value: '9001' } })
    tree = await settle()
    buttonByText(tree, /^添加转发$/)[0].props.onClick()
    await flush()
    tree = await settle()

    // The wrong attachment is detected and undone instead of being shown as success.
    const removed = calls.find((c) => c.method === 'POST' && c.url.includes('/dsh-remote/forwards') && c.body && c.body.action === 'remove')
    assert.ok(removed, 'the mis-attached definition must be removed')
    assert.equal(removed.body.id, 'fwd-new')
    assert.ok(elements(tree).some((el) => /重启 DSH/.test(textOf(el))),
      'the user must be told why and what to do (restart DSH)')
  } finally { dispose() }
})

test('an existing forward can be edited (including its host) instead of deleted and re-added', async () => {
  const existing = {
    id: 'f1', direction: 'local', listenPort: 9000, targetHost: '127.0.0.1',
    targetPort: 8080, machineId: 'm-current', autoStart: false, active: false,
  }
  const { Page, calls } = mountClient({ forwards: [existing] })
  const { settle, dispose } = makeDriver(Page)
  try {
    let tree = await settle()
    buttonByText(tree, /端口转发/)[0].props.onClick()
    tree = await settle()

    const edit = elements(tree).filter((el) => el.props && el.props['data-testid'] === 'fwd-edit')
    assert.equal(edit.length, 1, 'every forward row exposes 编辑')
    assert.equal(edit[0].props.disabled, false, 'an inactive forward can be edited')
    edit[0].props.onClick()
    tree = await settle()

    // Prefilled from the definition, and the primary action says it saves.
    const listen = elements(tree).find((el) => el.type === 'input' && el.props.placeholder === '监听端口')
    assert.equal(listen.props.value, '9000', 'the form must be prefilled with the existing definition')
    const select0 = elements(tree).find((el) => el.type === 'select' && el.props['data-testid'] === 'fwd-host')
    assert.equal(select0.props.value, 'm-current')
    assert.equal(buttonByText(tree, /^保存修改$/).length, 1, '添加转发 becomes 保存修改 while editing')
    assert.equal(buttonByText(tree, /^取消$/).length, 1, 'editing can be cancelled')

    // The edited RECORD stays identifiable through the highlighted row (plus its
    // 编辑中 badge) — no extra banner above the form.
    const highlighted = elements(tree).filter((el) => el.props && el.props['data-fwd-editing'] === 'true')
    assert.equal(highlighted.length, 1, 'exactly the record being edited is highlighted')
    assert.match(textOf(highlighted[0]), /编辑中/, 'the highlighted row carries the badge')

    listen.props.onChange({ target: { value: '9100' } })
    tree = await settle()
    // Re-read after the re-render: handlers close over the form they rendered.
    elements(tree).find((el) => el.type === 'select' && el.props['data-testid'] === 'fwd-host')
      .props.onChange({ target: { value: 'm-other' } })
    tree = await settle()

    buttonByText(tree, /^保存修改$/)[0].props.onClick()
    await flush()
    tree = await settle()

    const update = calls.find((c) => c.method === 'POST' && c.body && c.body.action === 'update')
    assert.ok(update, 'an update request must be sent')
    assert.equal(update.body.id, 'f1')
    assert.equal(update.body.listenPort, 9100, 'the new listen port is persisted')
    assert.equal(update.body.targetPort, 8080, 'untouched fields keep their values')
    assert.equal(update.body.machineId, 'm-other', 'the owning host can be changed too')
    assert.equal(calls.some((c) => c.body && c.body.action === 'define'), false,
      'editing must not create a second definition')
    assert.match(textOf(tree), /9100/, 'the row shows the updated definition')
    assert.equal(elements(tree).filter((el) => el.props && el.props['data-fwd-editing'] === 'true').length, 0,
      'the highlight must clear once the edit is saved')
  } finally { dispose() }
})

test('editing a RUNNING forward stops it, patches it and starts it again', async () => {
  const existing = {
    id: 'f1', direction: 'local', listenPort: 9000, targetHost: '127.0.0.1',
    targetPort: 8080, machineId: 'm-current', autoStart: true, active: true,
  }
  const { Page, calls } = mountClient({ forwards: [existing] })
  const { settle, dispose } = makeDriver(Page)
  try {
    let tree = await settle()
    buttonByText(tree, /端口转发/)[0].props.onClick()
    tree = await settle()
    elements(tree).find((el) => el.props && el.props['data-testid'] === 'fwd-edit').props.onClick()
    tree = await settle()

    elements(tree).find((el) => el.type === 'input' && el.props.placeholder === '目标端口')
      .props.onChange({ target: { value: '9090' } })
    tree = await settle()
    buttonByText(tree, /^保存修改$/)[0].props.onClick()
    await flush()
    await settle()

    const actions = calls.filter((c) => c.method === 'POST' && c.url.includes('/dsh-remote/forwards'))
      .map((c) => c.body && c.body.action)
    // A live socket keeps its old bind, so the edit is applied to a stopped
    // definition and the tunnel is put back afterwards.
    assert.deepEqual(actions, ['stop', 'update', 'start'])
    assert.equal(calls.find((c) => c.body && c.body.action === 'update').body.targetPort, 9090)
  } finally { dispose() }
})

test('a host half that cannot edit forwards does not report a silent success', async () => {
  const existing = {
    id: 'f1', direction: 'local', listenPort: 9000, targetHost: '127.0.0.1',
    targetPort: 8080, machineId: 'm-current', autoStart: false, active: false,
  }
  const { Page, calls } = mountClient({ forwards: [existing], ignoreForwardEdit: true })
  const { settle, dispose } = makeDriver(Page)
  try {
    let tree = await settle()
    buttonByText(tree, /端口转发/)[0].props.onClick()
    tree = await settle()
    elements(tree).find((el) => el.props && el.props['data-testid'] === 'fwd-edit').props.onClick()
    tree = await settle()
    elements(tree).find((el) => el.type === 'input' && el.props.placeholder === '监听端口')
      .props.onChange({ target: { value: '9100' } })
    tree = await settle()
    buttonByText(tree, /^保存修改$/)[0].props.onClick()
    await flush()
    tree = await settle()

    assert.ok(elements(tree).some((el) => /没能保存这些修改/.test(textOf(el))),
      'an update the host did not apply must not look saved')
    // The editor stays open so the user can retry after restarting DSH.
    assert.equal(buttonByText(tree, /^保存修改$/).length, 1)
    // And the old definition is still the one in the list (never a second one).
    assert.equal(calls.some((c) => c.body && c.body.action === 'define'), false)
  } finally { dispose() }
})

test('host menus carry the current CSS-anchor props, not only the legacy rect', () => {
  // DSH 0.2.2-alpha.2 replaced getAnchorRect with anchorRef / anchorPoint. A host
  // menu that passes ONLY the rect is silently left unattached (this is how the
  // edit/delete popup ended up away from the `...` button, and the explorer
  // context menu away from the pointer). Both APIs are passed for old hosts.
  assert.match(src, /anchorRef: settingsMenu\.anchorRef/,
    'the settings menu must anchor to the pressed button element')
  assert.match(src, /anchorPoint: \{ x: menu\.x, y: menu\.y \}/,
    'the explorer context menu must anchor to the pointer')
  assert.match(src, /getAnchorRect: settingsMenu\.getAnchorRect/,
    'older hosts still get the rect fallback')
})
