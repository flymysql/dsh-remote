import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mountClient } from './harness/render.js'
const response = data => ({ ok: true, status: 200, json: async () => data })
const root = '/local/project'
const sessions = { list: { getSnapshot: () => ({ byId: { a: { cwd: root } } }), subscribe: () => () => {} } }
const fileProps = { sessionId: 'a', useTabInfo: () => ({ tab: { visible: true, navigation: { address: 'dsh-resource://dsh-remote/a/' + encodeURIComponent(root + '/main.js') } } }) }
const action = (ui, tree, label) => {
  const component = ui.components(tree).find(c => c.type.name === 'WorkbenchAction' && c.props.label === label)
  assert.ok(component, 'missing action ' + label); return component.props
}

test('local explorer resolves its own project, has local labels and sends explicit local context', async () => {
  const requests = []
  const ui = mountClient({ services: { sessions }, fetch: async (url, opts) => {
    requests.push([url, opts]);
    if (url.includes('/bindings')) return response({ mirrors: [] })
    if (url.includes('/workspace-context')) return response({ kind: 'local', root, connected: true })
    if (url.includes('/ls')) return response({ path: root, items: [{ name: 'main.js', path: root + '/main.js', type: 'file' }] })
    return response({})
  } })
  try {
    const tree = await ui.settleComponent(ui.body('dsh-remote/explorer'), { sessionId: 'a', useTabInfo: () => ({ tab: { visible: true, actions: {} } }) })
    assert.match(ui.textOf(tree), /本地工作区/)
    assert.ok(action(ui, tree, '打开本地终端')); assert.ok(action(ui, tree, '搜索本地工作区'))
    assert.ok(requests.some(([url]) => url.includes('/ls?') && url.includes('workspace=local') && url.includes('sessionId=a')))
    assert.equal(requests.some(([url]) => url.includes('/connect')), false)
  } finally { ui.dispose() }
})

test('local highlighted editor saves through local context and terminal ignores remote preferred shell', async () => {
  const calls = [], requests = []
  const ui = mountClient({ withCodeHighlighter: true, services: {
    sessions,
    webTerminals: { launchShells: async () => ({ selectedShell: '/tools/remote ssh', shells: [{ name: 'remote ssh', path: '/tools/remote ssh' }, { name: 'bash', path: '/bin/bash' }] }) },
    sidebarRight: { mounted: { getSnapshot: () => 'a' }, openTab: (...args) => calls.push(args) },
  }, fetch: async (url, opts) => {
    requests.push([url, opts]);
    if (url.includes('/bindings')) return response({ mirrors: [] })
    if (url.includes('/read')) return response({ ok: true, content: 'const value = 1;\n', eol: 'crlf', revision: 'a'.repeat(64), mtime: 1 })
    return response({ ok: true, revision: 'b'.repeat(64), mtime: 2 })
  } })
  try {
    const body = ui.body('dsh-remote/file')
    let tree = await ui.settleComponent(body, fileProps)
    const editor = ui.components(tree).find(c => c.type.name === 'HighlightedEditor')
    assert.ok(editor); editor.props.onChange({ target: { value: 'const value = 2;\n' } })
    tree = await ui.settleComponent(body, fileProps)
    ui.button(tree, /^保存到本地$/).el.props.onClick()
    await ui.tick()
    const write = requests.find(([url]) => url === '/dsh-remote/write')
    assert.ok(write)
    const sent = JSON.parse(write[1].body)
    assert.equal(sent.workspace, 'local'); assert.equal(sent.sessionId, 'a'); assert.equal(sent.content, 'const value = 2;\r\n')
    await action(ui, tree, '打开本地终端').onClick()
    assert.deepEqual(calls, [['terminal', { params: { shellPath: '/bin/bash' } }]])
  } finally { ui.dispose() }
})

test('local sessions expose IDE mode without requiring any saved SSH host', async () => {
  const ui = mountClient({ services: { sessions, sidebarRight: { mounted: { getSnapshot: () => 'a' }, openResourceIn() {} } }, fetch: async () => response({ mirrors: [] }) })
  try {
    const toggle = ui.body('conversation.session.header.actions')
    const tree = await ui.settleComponent(toggle, { sessionId: 'a' })
    assert.ok(tree); assert.equal(tree.props['data-rw-ide-toggle'], ''); assert.equal(tree.props.disabled, false)
  } finally { ui.dispose() }
})

// A forced refresh (`refreshStatus({ force: true })`) must not reclassify a local
// session as remote.
//
// `refreshMirrors()` clears `MIRRORS.loaded` for the whole /bindings round-trip,
// and the explorer derives both its badge and its view identity from
// `localWorkspaceSession()`. Deriving that from `loaded` meant any render inside
// the window demoted the pane ("远程工作区"), changed its view key, reset `root`
// and discarded the resolution that landed afterwards — the shared refresh button
// left a local workspace blank until the window was reloaded.
//
// The stub HOLDS /bindings so the window is observable; with an instant reply it
// is too short for a render to land in and the test would pass either way.
test('a forced refresh does not drop a local pane into the remote category', async () => {
  const requests = []
  let bindingsCalls = 0
  let releaseBindings
  const held = new Promise((resolve) => { releaseBindings = resolve })
  const ui = mountClient({ services: { sessions }, fetch: async (url) => {
    requests.push(String(url))
    if (url.includes('/bindings')) {
      bindingsCalls += 1
      if (bindingsCalls > 1) await held
      return response({ mirrors: [] })
    }
    if (url.includes('/workspace-context')) return response({ kind: 'local', root, connected: true })
    if (url.includes('/ls')) return response({ path: root, items: [{ name: 'main.js', path: root + '/main.js', type: 'file' }] })
    return response({})
  } })
  try {
    const body = ui.body('dsh-remote/explorer')
    const props = { sessionId: 'a', useTabInfo: () => ({ tab: { visible: true, actions: {} } }) }
    let tree = await ui.settleComponent(body, props)
    assert.match(ui.textOf(tree), /main\.js/)

    const refresh = ui.components(tree).find(c => c.type.name === 'WorkbenchAction' && c.props.label === '刷新')
    assert.ok(refresh, 'the explorer lost its refresh action')
    refresh.props.onClick()
    await ui.tick()
    tree = await ui.settleComponent(body, props)
    // Inside the refresh window the pane is still the local workspace. Match the
    // badge, not the words: the empty-state copy itself mentions 远程工作区.
    assert.match(ui.textOf(tree), /资源管理器本地工作区/)
    assert.doesNotMatch(ui.textOf(tree), /资源管理器远程工作区/)

    releaseBindings()
    for (let pass = 0; pass < 4; pass++) { await ui.tick(); tree = await ui.settleComponent(body, props) }
    assert.match(ui.textOf(tree), /资源管理器本地工作区/)
    assert.ok(requests.filter(url => url.includes('/workspace-context')).length >= 2, 'the refresh must actually re-resolve the workspace')
  } finally { ui.dispose() }
})

// The classification above is the ONLY thing that must not move, so pin its
// input: a latched "we have read the registry" flag, not the transient `loaded`
// that a refresh clears.
test('local/remote classification is latched, not tied to a bindings round-trip', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('function localWorkspaceSession(')
  assert.ok(start > 0, 'localWorkspaceSession is gone')
  const body = src.slice(start, src.indexOf('\n    }', start))
  assert.match(body, /MIRRORS\.known/)
  assert.doesNotMatch(body, /MIRRORS\.loaded/)
  assert.match(src, /const MIRRORS = \{ list: \[\], loaded: false, known: false, error: '' \}/)
  assert.match(src, /MIRRORS\.known = true/)
})
