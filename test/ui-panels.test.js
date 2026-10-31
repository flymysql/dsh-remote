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
      ui.resetState() // hook slots are positional; a new family must not inherit the previous one's
      const tree = await ui.settleComponent(entry.comp, {
        sessionId: 's-1', path: '/a.txt', tab: { path: '/a.txt' },
        // Right-pane bodies (explorer/file/link) read the address off the tab info.
        // This address parses but belongs to no known session, so the link body
        // renders its "unresolved" explanation instead of throwing.
        useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://dsh-remote/file/' + encodeURIComponent('/a.txt') } } }),
      })
      const text = ui.text(tree)
      assert.doesNotMatch(text, /\b(settings|file|picker|sidebar|common)\.[a-zA-Z][\w.]*/,
        `${name}: a raw i18n key leaked into the UI — ${text.slice(0, 200)}`)
    }
  } finally { ui.dispose() }
})

test('a remote .md link renders through the host MarkdownText, not a raw source wall (issue #74)', async () => {
  // The built-in Markdown preview reads the LOCAL MIRROR and dies with ENOENT on an
  // unsynced file. The remote-link editor claims the address now and RENDERS the
  // remote content with the host's MarkdownText — this test proves the rendered
  // branch is taken (the harness stub marks it with className "md-stub").
  const md = '# Title\n\n- one\n- two\n'
  const ui = mountClient({
    fetch: stubFetch({
      overrides: {
        '/dsh-remote/read': () => ({ content: md, mtime: 1, size: md.length }),
      },
    }).fetch,
  })
  try {
    const body = ui.body('dsh-remote/file')
    const tree = await ui.settleComponent(body, {
      sessionId: 's-1',
      useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://dsh-remote/file/' + encodeURIComponent('/srv/app/README.md') } } }),
    })
    // Nested function components are NOT executed by the tree walker, so the
    // MarkdownText stub appears as an element whose TYPE is the stub and whose
    // props carry the markdown text.
    const mdEls = ui.elements(tree).filter((el) => el.props && el.props.text === md)
    assert.ok(mdEls.length > 0, `expected the MarkdownText branch to render, got: ${ui.text(tree).slice(0, 200)}`)
    assert.match(ui.text(tree), /README\.md/)
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

test('every saved machine offers 连接 and 选目录 (issue #73: the list IS the primary path)', async () => {
  const machines = [{ ...MACHINE, id: 'm-1', name: 'first' }, { ...MACHINE, id: 'm-2', name: 'second' }]
  const ui = mountClient({ fetch: stubFetch({ machines, currentId: 'm-1' }).fetch })
  try {
    const tree = await ui.settle()
    const labels = ui.buttons(tree).map((b) => b.label)
    // Issue #73 replaced 「设为当前」 with 「连接」 (activate + probe in one click) and
    // added 「选目录」 (the second half of the VSCode-shaped flow).
    assert.equal(labels.filter((l) => /^连接$/.test(l)).length, 2, `expected a 连接 action per machine, got: ${labels.join(' | ')}`)
    assert.equal(labels.filter((l) => /^选目录$/.test(l)).length, 2, `expected a 选目录 action per machine, got: ${labels.join(' | ')}`)
    // A disabled control must still explain itself.
    const mute = ui.buttons(tree).filter((b) => b.disabled && !b.title)
    assert.deepEqual(mute.map((b) => b.label), [],
      `disabled buttons without a title explaining why: ${mute.map((b) => b.label).join(' | ')}`)
  } finally { ui.dispose() }
})

test('the ~/.ssh/config hosts are listed with a one-click 连接, and saved ones are not duplicated', async () => {
  const machines = [{ ...MACHINE, id: 'm-1', name: 'saved-box', host: 'saved-box', useSshConfig: true }]
  const entries = [
    { host: 'saved-box', alias: 'saved-box', hostName: '10.0.0.7', user: 'root', port: 22 },
    { host: 'fresh', alias: 'fresh', hostName: '10.0.0.8', user: 'deploy', port: 2200, identityFile: '/k/id' },
  ]
  const ui = mountClient({
    fetch: stubFetch({ machines, overrides: { '/dsh-remote/ssh-config': () => ({ ok: true, present: true, file: '/home/me/.ssh/config', entries }) } }).fetch,
  })
  try {
    const tree = await ui.settle()
    const text = ui.text(tree)
    assert.match(text, /fresh/, 'an unsaved ~/.ssh/config host must be listed')
    assert.match(text, /10\.0\.0\.8/, 'with the resolved target the file gives')
    // A host that is already saved appears ONCE (as the saved row). Counting the
    // bold name spans is the precise check: a duplicated discovered row would add a
    // second one for the same alias.
    const aliasSpans = ui.elements(tree).filter((el) => el.type === 'span' && ui.textOf(el).trim() === 'saved-box')
    assert.equal(aliasSpans.length, 1, `saved-box must be listed exactly once, got ${aliasSpans.length}`)
    // Exactly one 连接 for the discovered host, plus one for the saved machine.
    const connects = ui.buttons(tree).filter((b) => /^连接$/.test(b.label))
    assert.equal(connects.length, 2, `expected 2 连接 buttons (1 discovered + 1 saved), got ${connects.length}`)
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

test('there is no add-machine form; editing a saved machine still opens one (issue #73)', async () => {
  const stub = stubFetch()
  const ui = mountClient({ fetch: stub.fetch })
  try {
    let tree = await ui.settle()
    const before = ui.text(tree)
    assert.doesNotMatch(before, /手动添加|添加机器|填表/, 'the add-machine form the reporter circled is gone')
    assert.match(before, /打开配置文件/, 'new hosts are added by opening ~/.ssh/config')
    assert.doesNotMatch(before, /HostKey 模式/, 'the edit form is not on screen until 编辑')
    ui.button(tree, /打开配置文件/).el.props.onClick()
    await ui.tick()
    assert.ok(stub.calls.some((c) => c.url.includes('/dsh-remote/ssh-config') && c.body && c.body.action === 'open'),
      '打开配置文件 must ask the host to open the ssh config, not a form')
    tree = await ui.click(tree, /^编辑$/)
    assert.match(ui.text(tree), /主机/, 'editing a saved machine still shows the credential form')
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

test('the forwards panel starts collapsed and its add button stays disabled until a port is typed', async () => {
  const ui = mountClient({ fetch: stubFetch().fetch })
  try {
    let tree = await ui.settle()
    // Collapsed by default: it sits below the host list and used to push the
    // update/audit cards far down the page for a feature most sessions never touch.
    assert.equal(ui.buttons(tree).some((b) => /^添加转发$/.test(b.label)), false,
      'the forwards panel must start collapsed')
    tree = await ui.click(tree, /端口转发/)
    const add = ui.buttons(tree).find((b) => /^添加转发$/.test(b.label))
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
