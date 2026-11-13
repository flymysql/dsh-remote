import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const props = (sessionId) => ({ sessionId, useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://dsh-remote/file/' + encodeURIComponent('/project/main.js') } } }) })
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })

test('drafts survive remount, stay in their session, and refuse a changed remote baseline', async () => {
  let mtime = 1
  const ui = mountClient({ effectDependencies: true, fetch: async () => response({ content: 'original', mtime }) })
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  ui.button(tree, /^编辑$/).el.props.onClick()
  tree = await ui.settleComponent(body, props('a'))
  ui.elements(tree).find((e) => e.type === 'textarea').props.onChange({ target: { value: 'unsaved draft' } })
  await ui.settleComponent(body, props('a'))
  ui.resetState()
  tree = await ui.settleComponent(body, props('b'))
  assert.equal(ui.elements(tree).filter((e) => e.type === 'textarea').length, 0, 'another session must not inherit the draft')
  ui.resetState()
  mtime = 2
  tree = await ui.settleComponent(body, props('a'))
  assert.equal(ui.elements(tree).find((e) => e.type === 'textarea').props.value, 'unsaved draft')
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
  ui.button(tree, /^编辑$/).el.props.onClick()
  tree = await ui.settleComponent(body, props('a'))
  ui.elements(tree).find((e) => e.type === 'textarea').props.onChange({ target: { value: 'modified' } })
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
  assert.equal(ui.elements(tree).filter((e) => e.type === 'textarea').length, 0)
})

test('unsaved drafts guard browser unload even after their file tab is closed, and reverting clears the guard', async () => {
  const ui = mountClient({ effectDependencies: true, fetch: async () => response({ content: 'original', mtime: 1 }) })
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  ui.button(tree, /^编辑$/).el.props.onClick()
  tree = await ui.settleComponent(body, props('a'))
  ui.elements(tree).find((e) => e.type === 'textarea').props.onChange({ target: { value: 'unsaved' } })
  await ui.settleComponent(body, props('a'))
  ui.resetState()
  let prevented = 0
  const event = { preventDefault() { prevented++ }, returnValue: 'unchanged' }
  ui.dispatchWindowEvent('beforeunload', event)
  assert.equal(prevented, 1)
  assert.equal(event.returnValue, '')
  tree = await ui.settleComponent(body, props('a'))
  ui.elements(tree).find((e) => e.type === 'textarea').props.onChange({ target: { value: 'original' } })
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
  assert.equal(ui.components(tree).find((c) => c.type.name === 'CodeView').props.code, 'before')
  content = 'agent modification'; mtime++; revision++
  tree = await ui.settleComponent(body, input)
  assert.equal(ui.components(tree).find((c) => c.type.name === 'CodeView').props.code, 'agent modification')
  ui.button(tree, /^编辑$/).el.props.onClick()
  tree = await ui.settleComponent(body, input)
  ui.elements(tree).find((e) => e.type === 'textarea').props.onChange({ target: { value: 'human draft' } })
  await ui.settleComponent(body, input)
  content = 'another agent modification'; mtime++; revision++
  tree = await ui.settleComponent(body, input)
  assert.equal(ui.elements(tree).find((e) => e.type === 'textarea').props.value, 'human draft')
  assert.equal(ui.button(tree, /^保存到远程$/).disabled, true)
  assert.match(ui.textOf(tree), /远端文件已变化，草稿已保留/)
})
