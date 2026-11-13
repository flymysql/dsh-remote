import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

function setup(t, listing) {
  const machine = { id: 'dev', name: 'Fixture', host: '127.0.0.1', username: 'root', port: 22 }
  const requests = []
  let cancelled = 0
  const ui = mountClient({ effectDependencies: true, fetch: async (url, init = {}) => {
    requests.push({ url: String(url), init })
    const reply = data => ({ ok: true, status: 200, json: async () => data })
    if (String(url).includes('/machines')) return reply({ machines: [machine], currentId: 'dev' })
    if (String(url).includes('/ls')) {
      const path = new URL(String(url), 'http://fixture').searchParams.get('path') || '/home/fixture'
      if (listing) return listing(path, reply)
      return reply({ path, items: Array.from({ length: 20 }, (_, i) => ({ name: 'dir-' + String(i).padStart(2, '0'), type: 'dir' })) })
    }
    return reply({ ok: true })
  } })
  const Picker = ui.component('sidebar.workspaces.directoryFlow')
  const props = { open: true, initialMachineId: 'dev', initialTab: 'remote', busy: false, onPicked() {}, onCancel() { cancelled++ } }
  const render = () => ui.settleComponent(Picker, props)
  const browse = async () => { const tree = await render(); ui.button(tree, /^浏览/).el.props.onClick(); await ui.tick(); return render() }
  t.after(() => ui.dispose())
  return { ui, render, browse, requests, cancelled: () => cancelled }
}

test('browse takes the picker content area and does not compete with autocomplete or a second footer', async t => {
  const { ui, browse } = setup(t)
  const tree = await browse()
  const elements = ui.elements(tree)
  assert.equal(elements.some(e => e.props.className === 'dsh-rw-suggestions'), false)
  assert.equal(elements.some(e => e.props['data-rw-picker-commit']), false)
  const region = elements.find(e => e.props['data-rw-directory-list'])
  assert.ok(region)
  assert.equal(region.props.style.flex, 1)
  assert.equal(region.props.style.minHeight, 0)
  assert.equal(ui.buttons(tree).filter(b => /选用此路径/.test(b.label)).length, 1)
  assert.equal(elements.filter(e => e.props.role === 'button').length, 20, 'every directory is keyboard reachable')
})

test('directory keyboard entry updates the selected browser path; Escape returns to path input without closing', async t => {
  const { ui, render, browse, cancelled } = setup(t)
  let tree = await browse()
  const row = ui.elements(tree).find(e => e.props.role === 'button' && ui.textOf(e).includes('dir-00'))
  let stopped = false
  row.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() { stopped = true } })
  await ui.tick(); tree = await render()
  assert.ok(stopped)
  assert.match(ui.textOf(tree), /选中：?\s*\/home\/fixture\/dir-00|所选.*\/home\/fixture\/dir-00/)
  const combo = ui.inputs(tree).find(p => p.role === 'combobox')
  combo.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  tree = await render()
  assert.equal(ui.elements(tree).some(e => e.props['data-rw-directory-browser']), false)
  assert.equal(ui.elements(tree).some(e => e.props.className === 'dsh-rw-suggestions'), true)
  assert.equal(cancelled(), 0)
})

test('a pending directory navigation cannot accept the previous directory', async t => {
  let finish
  const { ui, render, browse } = setup(t, (path, reply) => path.endsWith('dir-00')
    ? new Promise(resolve => { finish = () => resolve(reply({ path, items: [] })) })
    : reply({ path, items: [{ name: 'dir-00', type: 'dir' }] }))
  let tree = await browse()
  ui.elements(tree).find(e => e.props.role === 'button').props.onClick()
  tree = await render()
  assert.equal(ui.button(tree, /^选用此路径$/).disabled, true)
  finish(); await ui.tick(); tree = await render()
  assert.equal(ui.button(tree, /^选用此路径$/).disabled, false)
})
