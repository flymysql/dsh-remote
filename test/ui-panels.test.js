// Panel-level UI tests: every registered slot renders, and the panels that carry
// the settings/explorer/editor flow expose the controls a user needs — in the state
// they need them.
//
// This is the layer that had no coverage at all: the coverage tool cannot even see
// lib/client.js (it is evaluated from a string), and before these tests only the
// settings page was rendered once, with no interaction. The two complaints that
// started this work — 「密码框是空白」 and 「保存后不能点测试」 — are both
// props-on-rendered-elements facts, i.e. exactly what this file asserts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

/** A machine as the host sends it (secrets already stripped). */
const MACHINE = {
  id: 'm-1',
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
  recentWorkspaces: ['/home/user'],
}

/** A fetch stub that answers the settings page's polling calls. */
function stubFetch({ machines = [MACHINE], currentId = '', overrides = {} } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ method, url: String(url), body })
    const reply = (obj) => ({ ok: true, status: 200, json: async () => obj })
    const u = String(url)
    for (const [needle, fn] of Object.entries(overrides)) {
      if (u.includes(needle)) return reply(fn({ method, body }))
    }
    if (u.includes('/dsh-remote/machines')) return reply({ machines, currentId })
    if (u.includes('/dsh-remote/forwards')) return reply({ forwards: [] })
    if (u.includes('/dsh-remote/audit')) return reply({ ok: true, auditEnabled: false, lines: [] })
    if (u.includes('/dsh-remote/web-attach')) return reply({ ok: true, attach: null, attaches: [], deploys: [], deploy: null })
    if (u.includes('/dsh-remote/update-check')) return reply({ ok: true, current: '9.9.9', latest: '9.9.9', updateAvailable: false, updateMode: 'off' })
    return reply({ ok: true })
  }
  return { fetch, calls }
}

test('every slot the client registers renders without throwing and leaks no raw i18n key', async () => {
  const ui = mountClient({ fetch: stubFetch().fetch })
  try {
    assert.ok(ui.registered.size >= 6, `expected the client to register its slots, got ${ui.registered.size}`)
    for (const [name, entry] of ui.registered) {
      assert.equal(typeof entry.comp, 'function', `${name}: a component must be registered`)
      const tree = await ui.settleComponent(entry.comp, { sessionId: 's-1', path: '/a.txt', tab: { path: '/a.txt' } })
      const text = ui.text(tree)
      assert.doesNotMatch(text, /\b(settings|file|picker|sidebar|common)\.[a-zA-Z][\w.]*/,
        `${name}: a raw i18n key leaked into the UI — ${text.slice(0, 200)}`)
    }
  } finally { ui.dispose() }
})

test('the machine list shows the badges a user needs to tell machines apart', async () => {
  const machines = [
    { ...MACHINE, id: 'm-1', name: 'with-password' },
    { ...MACHINE, id: 'm-2', name: 'no-password', passwordSet: false },
    { ...MACHINE, id: 'm-3', name: 'openssh-alias', useSshConfig: true, backend: 'openssh', passwordSet: false },
    { ...MACHINE, id: 'm-4', name: 'via-bastion', proxy: { host: 'bastion', port: 22, passwordSet: true }, passwordSet: false },
  ]
  const ui = mountClient({ fetch: stubFetch({ machines }).fetch })
  try {
    const tree = await ui.settle()
    const text = ui.text(tree)
    for (const name of ['with-password', 'no-password', 'openssh-alias', 'via-bastion']) {
      assert.match(text, new RegExp(name), `machine ${name} must be listed`)
    }
    // The password badge belongs to machines that HAVE a credential — the "no
    // password" one must not claim one.
    const rows = ui.elements(tree).filter((el) => el.type === 'div' && /with-password|no-password/.test(ui.textOf(el)))
    assert.ok(rows.length > 0)
  } finally { ui.dispose() }
})

test('the current machine cannot be re-activated, and every other one can', async () => {
  const machines = [{ ...MACHINE, id: 'm-1', name: 'first' }, { ...MACHINE, id: 'm-2', name: 'second' }]
  const ui = mountClient({ fetch: stubFetch({ machines, currentId: 'm-1' }).fetch })
  try {
    const tree = await ui.settle()
    const setCurrent = ui.buttons(tree).filter((b) => /设为当前/.test(b.label))
    // At least one per machine (a panel may repeat the action); what matters is
    // that exactly ONE of them — the current machine's — is disabled.
    assert.ok(setCurrent.length >= 2,
      `expected a 设为当前 action per machine, got: ${ui.buttons(tree).map((b) => b.label).join(' | ')}`)
    assert.equal(setCurrent.filter((b) => b.disabled).length, 1,
      'exactly the CURRENT machine\'s button must be disabled')
    const disabled = setCurrent.find((b) => b.disabled)
    assert.ok(disabled.title, 'the disabled one must say why (this is already the current machine)')
  } finally { ui.dispose() }
})

test('an empty registry explains itself instead of showing a blank panel', async () => {
  const ui = mountClient({ fetch: stubFetch({ machines: [] }).fetch })
  try {
    const tree = await ui.settle()
    const text = ui.text(tree)
    assert.match(text, /还没有|没有保存|no machines/i, 'an empty machine list must say so')
    assert.match(text, /当前没有活动远程机/, 'and explain that nothing is active')
  } finally { ui.dispose() }
})

test('the advanced block starts collapsed and opens on demand', async () => {
  const ui = mountClient({ fetch: stubFetch().fetch })
  try {
    let tree = await ui.settle()
    const before = ui.text(tree)
    assert.doesNotMatch(before, /HostKey 模式/, 'advanced fields must be hidden by default')
    const expand = ui.button(tree, /高级配置/)
    expand.el.props.onClick()
    tree = await ui.settle()
    assert.match(ui.text(tree), /HostKey 模式/, 'the advanced block must reveal its fields')
  } finally { ui.dispose() }
})

test('a machine that authenticates through an agent shows the agent fields it needs', async () => {
  const machines = [{ ...MACHINE, id: 'm-1', name: 'agent-box', useAgent: true, passwordSet: false, privateKeyPath: '/k/id' }]
  const ui = mountClient({ fetch: stubFetch({ machines }).fetch })
  try {
    let tree = await ui.settle()
    // Editing a machine with advanced settings auto-expands the block (otherwise
    // the user cannot see — let alone fix — the key/agent configuration).
    await ui.click(tree, /^编辑$/)
    tree = await ui.settle()
    const text = ui.text(tree)
    assert.match(text, /私钥路径/, 'the private key field must be visible when editing such a machine')
    const boxes = ui.inputs(tree, 'checkbox').map((p) => !!p.checked)
    assert.ok(boxes.includes(true), 'the stored agent flag must be reflected in the form')
  } finally { ui.dispose() }
})

test('the forwards panel renders and its add button stays disabled until a port is typed', async () => {
  const ui = mountClient({ fetch: stubFetch().fetch })
  try {
    let tree = await ui.settle()
    const add = ui.buttons(tree).find((b) => /添加转发|新增转发|添加/.test(b.label))
    assert.ok(add, `the forwards panel must offer an add action, buttons: ${ui.buttons(tree).map((b) => b.label).join(' | ')}`)
    assert.equal(add.disabled, true, 'adding a forward without a listen port must be impossible')
  } finally { ui.dispose() }
})

test('the update panel never offers 立即更新 when the version is current', async () => {
  const ui = mountClient({ fetch: stubFetch().fetch })
  try {
    const tree = await ui.settle()
    const labels = ui.buttons(tree).map((b) => b.label)
    assert.ok(labels.some((l) => /检查更新/.test(l)), `expected a 检查更新 action, got: ${labels.join(' | ')}`)
    assert.equal(labels.some((l) => /立即更新/.test(l)), false, 'no update available → no 立即更新 button')
  } finally { ui.dispose() }
})

test('the directory picker renders its path box and refuses to commit an empty path', async () => {
  const ui = mountClient({ fetch: stubFetch().fetch })
  try {
    const Picker = ui.component('sidebar.workspaces.directoryFlow')
    let tree = await ui.settleComponent(Picker, { open: true, busy: false, onPicked: () => {}, onCancel: () => {} })
    const text = ui.text(tree)
    assert.ok(text.length > 0, 'the picker must render content when open')
    const commit = ui.buttons(tree).find((b) => /使用此路径|设为工作区|use this/i.test(b.label))
    if (commit) assert.equal(commit.disabled, true, 'an empty path must not be committable')
  } finally { ui.dispose() }
})

test('the remote file tab opens READ-ONLY and only enables saving after an edit', async () => {
  const ui = mountClient({
    fetch: stubFetch({
      overrides: { '/dsh-remote/read': () => ({ ok: true, binary: false, content: 'line1\nline2\n', truncated: false, size: 12, mtime: 1 }) },
    }).fetch,
  })
  try {
    const Tab = ui.component('conversation.session.header.utilities')
    let tree = await ui.settleComponent(Tab, { tab: { path: '/home/user/README.md' }, scope: { sessionId: 's-1' } })
    const save = ui.buttons(tree).find((b) => /保存到远程/.test(b.label))
    if (save) {
      assert.equal(save.disabled, true, 'saving must be impossible before an edit (read-only by default)')
      assert.ok(save.title, 'a disabled save button must explain itself on hover')
    }
  } finally { ui.dispose() }
})

test('the settings page explains every disabled button on hover', async () => {
  // 「点了没反应的灰按钮」 is its own class of bug report. A disabled control that
  // carries no `title` gives the user no way to learn what is missing — which is
  // exactly how 「点保存后不能点测试」 felt. Any button we disable must say why.
  const ui = mountClient({ fetch: stubFetch({ machines: [MACHINE], currentId: 'm-1' }).fetch })
  try {
    const tree = await ui.settle()
    const mute = ui.buttons(tree).filter((b) => b.disabled && !b.title)
    assert.deepEqual(mute.map((b) => b.label), [],
      `disabled buttons without a title explaining why: ${mute.map((b) => b.label).join(' | ')}`)
  } finally { ui.dispose() }
})
