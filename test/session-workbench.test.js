import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'
const response = (data) => ({ ok: true, status: 200, json: async () => data })
const props = (sessionId = 'a') => ({ sessionId, useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://dsh-remote/file/' + encodeURIComponent('/project/main.js') } } }) })
const action = (ui, tree, label) => {
  const item = ui.components(tree).find((c) => c.type.name === 'WorkbenchAction' && c.props.label === label)
  assert.ok(item, `missing action: ${label}`)
  return item.props
}

test('the default editor offers find, wrap, path navigation and session-scoped view preferences', async () => {
  const ui = mountClient({ fetch: async () => response({ content: 'hello remote\nhello again', mtime: 1, size: 24 }) })
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props())
  action(ui, tree, '在文件中查找').onClick()
  tree = await ui.settleComponent(body, props())
  ui.inputs(tree).find((p) => p['aria-label'] === '在文件中查找').onChange({ target: { value: 'hello' } })
  tree = await ui.settleComponent(body, props())
  assert.match(ui.textOf(tree), /1 \/ 2/)
  action(ui, tree, '下一个匹配').onClick()
  tree = await ui.settleComponent(body, props())
  assert.match(ui.textOf(tree), /2 \/ 2/)
  action(ui, tree, '自动换行').onClick()
  tree = await ui.settleComponent(body, props())
  assert.equal(action(ui, tree, '自动换行').pressed, true)
  const code = ui.components(tree).find((c) => c.type.name === 'HighlightedEditor')
  assert.ok(code, 'complete text opens directly in the highlighted editor')
  assert.equal(code.props.value, 'hello remote\nhello again')
  assert.equal(code.props.wrap, true)
  assert.deepEqual(code.props.matchingLines, [1, 2])
  assert.ok(action(ui, tree, '返回文件树'))
  ui.resetState()
  tree = await ui.settleComponent(body, props())
  assert.equal(action(ui, tree, '自动换行').pressed, true, 'file preferences survive tab remount')
  ui.resetState()
  tree = await ui.settleComponent(body, props('b'))
  assert.equal(action(ui, tree, '自动换行').pressed, false, 'another session has its own file preferences')
})

test('remote-terminal action explicitly picks remote ssh even when local shell is preferred', async () => {
  const calls = []
  const ui = mountClient({ fetch: async () => response({ content: 'file', mtime: 1 }), services: {
    webTerminals: { launchShells: async (sessionId) => { calls.push(sessionId); return { selectedShell: '/bin/bash', shells: [{ name: 'bash', path: '/bin/bash' }, { name: 'remote ssh', path: '/tools/remote ssh' }] } } },
    sidebarRight: { mounted: { getSnapshot: () => 'a' }, openTab: (...args) => calls.push(args) },
  } })
  const tree = await ui.settleComponent(ui.body('dsh-remote/file'), props())
  await action(ui, tree, '打开远程终端').onClick()
  assert.deepEqual(calls, ['a', ['terminal', { params: { shellPath: '/tools/remote ssh' } }]])
})

test('late terminal discovery never opens a terminal in the newly selected session', async () => {
  let finish, current = 'a'
  const opened = []
  const ui = mountClient({ fetch: async () => response({ content: 'file', mtime: 1 }), services: {
    webTerminals: { launchShells: () => new Promise((r) => { finish = r }) },
    sidebarRight: { mounted: { getSnapshot: () => current }, openTab: (...args) => opened.push(args) },
  } })
  const tree = await ui.settleComponent(ui.body('dsh-remote/file'), props())
  const pending = action(ui, tree, '打开远程终端').onClick()
  current = 'b'
  finish({ shells: [{ name: 'remote ssh', path: '/tools/remote ssh' }] })
  await pending
  assert.deepEqual(opened, [])
})

test('the default editor delegates selected-line indentation and keeps composing save shortcuts untouched', async () => {
  const ui = mountClient({ fetch: async () => response({ content: 'first\nsecond\nthird', mtime: 1 }) })
  try {
    const tree = await ui.settleComponent(ui.body('dsh-remote/file'), props())
    const editor = ui.components(tree).find(c => c.type.name === 'HighlightedEditor')
    assert.ok(editor, 'no edit-mode toggle is required')
    assert.equal(editor.props.value, 'first\nsecond\nthird')
    assert.equal(typeof editor.props.indent, 'function', 'the visual editor uses the shared draft indentation transform')
    const indented = editor.props.indent(editor.props.value, 0, 13, false)
    assert.equal(indented.text, '  first\n  second\nthird', 'a selection ending at the next line must not indent that line')
    const outdented = editor.props.indent(indented.text, 0, 0, true)
    assert.equal(outdented.text, 'first\n  second\nthird', 'Shift+Tab at column one outdents the current line')
    let prevented = 0
    editor.props.onKeyDown({ key: 's', ctrlKey: true, isComposing: true, preventDefault() { prevented++ } })
    assert.equal(prevented, 0, 'a composing keystroke must not be consumed by the parent save shortcut')
  } finally { ui.dispose() }
})
