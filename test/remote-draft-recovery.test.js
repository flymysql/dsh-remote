import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const props = (sessionId) => ({ sessionId, useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://dsh-remote/file/' + encodeURIComponent('/project/main.js') } } }) })
const editor = (ui, tree) => { const component = ui.components(tree).find(c => c.type.name === 'HighlightedEditor'); assert.ok(component, 'complete text is editable by default'); return component.props }
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })

test('drafts survive remount, stay in their session, and refuse a changed remote baseline', async () => {
  let mtime = 1
  const ui = mountClient({ effectDependencies: true, fetch: async () => response({ content: 'original', mtime }) })
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  editor(ui, tree).onChange({ target: { value: 'unsaved draft' } })
  await ui.settleComponent(body, props('a'))
  ui.resetState()
  tree = await ui.settleComponent(body, props('b'))
  assert.equal(editor(ui, tree).value, 'original', 'another session must not inherit the draft')
  assert.equal(ui.button(tree, /^保存到远程$/).disabled, true)
  ui.resetState()
  mtime = 2
  tree = await ui.settleComponent(body, props('a'))
  assert.equal(editor(ui, tree).value, 'unsaved draft')
  assert.equal(ui.button(tree, /^保存到远程$/).disabled, true)
  assert.match(ui.textOf(tree), /远端文件已变化，草稿已保留/)
  assert.ok(ui.button(tree, /^复制草稿$/))
})

test('restored drafts keep their original mtime guard and submit once before React rerenders', async () => {
  const writes = []
  let finish
  const ui = mountClient({ effectDependencies: true, fetch: async (url, opts) => {
    if (String(url).includes('/write')) {
      writes.push(JSON.parse(opts.body))
      await new Promise((r) => { finish = r })
      return response({ ok: true })
    }
    return response({ content: 'original', mtime: 41 })
  } })
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  editor(ui, tree).onChange({ target: { value: 'modified' } })
  ui.resetState()
  tree = await ui.settleComponent(body, props('a'))
  const save = ui.button(tree, /^保存到远程$/).el.props.onClick
  save(); save()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].expectedMtime, 41)
  assert.equal(writes[0].content, 'modified')
  assert.equal(writes[0].sessionId, 'a')
  finish()
  await ui.tick()
})


test('a truncated file preview cannot be edited or overwrite unread remote content', async () => {
  const ui = mountClient({ fetch: async () => response({ content: 'partial preview', mtime: 1, truncated: true }) })
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  const edit = ui.button(tree, /^编辑$/)
  assert.equal(edit.disabled, true)
  assert.match(edit.title, /预览不完整/)
  edit.el.props.onClick()
  tree = await ui.settleComponent(body, props('a'))
  assert.equal(ui.components(tree).some(c => c.type.name === 'HighlightedEditor'), false)
  assert.equal(ui.elements(tree).some(e => e.type === 'textarea'), false)
})

for (const [kind, data] of [['binary', { binary: true, size: 3 }], ['image', { image: true, mime: 'image/png', content: 'aGVsbG8=', size: 5 }]]) {
  test(`a ${kind} preview never opens a text editor or enables remote saving`, async t => {
    const writes = []
    const ui = mountClient({ fetch: async (url, options) => {
      if (String(url).includes('/write')) writes.push(options)
      return response({ mtime: 1, ...data })
    } })
    t.after(() => ui.dispose())
    const body = ui.body('dsh-remote/file')
    let tree = await ui.settleComponent(body, props('a'))
    const edit = ui.button(tree, /^编辑$/)
    assert.equal(edit.disabled, true)
    edit.el.props.onClick()
    tree = await ui.settleComponent(body, props('a'))
    assert.equal(ui.components(tree).some(component => component.type.name === 'HighlightedEditor'), false)
    assert.equal(ui.buttons(tree).some(button => /^保存到远程$/.test(button.label) && !button.disabled), false)
    assert.deepEqual(writes, [])
    if (kind === 'image') assert.ok(ui.elements(tree).some(element => element.type === 'img'), 'image preview remains available')
  })
}

test('unsaved drafts guard browser unload even after their file tab is closed, and reverting clears the guard', async () => {
  const ui = mountClient({ effectDependencies: true, fetch: async () => response({ content: 'original', mtime: 1 }) })
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  editor(ui, tree).onChange({ target: { value: 'unsaved' } })
  await ui.settleComponent(body, props('a'))
  ui.resetState()
  let prevented = 0
  const event = { preventDefault() { prevented++ }, returnValue: 'unchanged' }
  ui.dispatchWindowEvent('beforeunload', event)
  assert.equal(prevented, 1)
  assert.equal(event.returnValue, '')
  tree = await ui.settleComponent(body, props('a'))
  editor(ui, tree).onChange({ target: { value: 'original' } })
  await ui.settleComponent(body, props('a'))
  ui.dispatchWindowEvent('beforeunload', { preventDefault() { prevented++ } })
  assert.equal(prevented, 1, 'reverting to the original text leaves no unsaved draft')
})

test('navigating again to an open file revalidates remote content and preserves a conflicting local draft', async () => {
  let content = 'before', mtime = 1, revision = 1
  const ui = mountClient({ effectDependencies: true, fetch: async () => response({ content, mtime }) })
  const body = ui.body('dsh-remote/file')
  const input = { sessionId: 'a', useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://dsh-remote/file/' + encodeURIComponent('/project/main.js'), revision } } }) }
  let tree = await ui.settleComponent(body, input)
  assert.equal(editor(ui, tree).value, 'before')
  content = 'agent modification'; mtime++; revision++
  tree = await ui.settleComponent(body, input)
  assert.equal(editor(ui, tree).value, 'agent modification')
  editor(ui, tree).onChange({ target: { value: 'human draft' } })
  await ui.settleComponent(body, input)
  content = 'another agent modification'; mtime++; revision++
  tree = await ui.settleComponent(body, input)
  assert.equal(editor(ui, tree).value, 'human draft')
  assert.equal(ui.button(tree, /^保存到远程$/).disabled, true)
  assert.match(ui.textOf(tree), /远端文件已变化，草稿已保留/)
})

test('retained editor revalidates on reveal without background reads or losing its draft', async t => {
  let visible = true, mtime = 1, reads = 0
  const ui = mountClient({ effectDependencies: true, fetch: async url => {
    if (String(url).includes('/dsh-remote/read')) reads++
    return response({ content: mtime === 1 ? 'original' : 'changed externally', mtime })
  } })
  t.after(() => ui.dispose())
  const body = ui.body('dsh-remote/file')
  const info = { sessionId: 'retained-session', useTabInfo: () => ({ tab: { visible, navigation: { address: 'dsh-resource://dsh-remote/retained-session/' + encodeURIComponent('/project/main.js') } } }) }
  let tree = await ui.settleComponent(body, info)
  editor(ui, tree).onChange({ target: { value: 'keep my unsaved input' } })
  visible = false; await ui.settleComponent(body, info)
  mtime = 2
  assert.equal(reads, 1, 'a hidden retained editor does not read in the background')
  visible = true; tree = await ui.settleComponent(body, info)
  assert.equal(reads, 2, 'revealing a retained tab rechecks actual remote contents')
  assert.equal(editor(ui, tree).value, 'keep my unsaved input')
  assert.match(ui.textOf(tree), /远端文件已变化，草稿已保留/)
  assert.equal(ui.button(tree, /^保存到远程$/).disabled, true)
})
