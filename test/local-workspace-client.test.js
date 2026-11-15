import test from 'node:test'
import assert from 'node:assert/strict'
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
