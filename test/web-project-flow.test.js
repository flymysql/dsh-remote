import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient as mount } from './harness/render.js'

const mountClient = (fetch) => mount({ fetch })
const machine = { id: 'dev', name: 'Development', host: 'dev.example', username: 'dev', port: 22, recentWorkspaces: ['/srv/app', '/srv/api'] }
const ok = (data) => ({ ok: true, json: async () => data })
const flush = () => new Promise((r) => setImmediate(r))

test('the native remote entry presents searchable projects and SSH config hosts without settings', async () => {
  const ui = mountClient((url) => Promise.resolve(ok(String(url).includes('machines') ? { machines: [machine], currentId: machine.id } : { entries: [{ alias: 'staging', hostName: 'stage.example' }] })))
  const Picker = ui.component('sidebar.workspaces.directoryFlow')
  const props = { open: true, onCancel() {}, onPicked() {} }
  let tree = await ui.settleComponent(Picker, props)
  ui.button(tree, /^远程$/).el.props.onClick()
  tree = await ui.settleComponent(Picker, props)
  const chooser = ui.components(tree).find((c) => c.type.name === 'RemoteProjectChooser')
  assert.ok(chooser, 'the standard Add workspace flow must include project-first selection')
  const opened = []
  const selected = []
  ui.resetState()
  const chooserProps = { ...chooser.props, onProject: (m, p) => opened.push([m.id, p]), onMachine: (m) => selected.push(m.id) }
  tree = await ui.settleComponent(chooser.type, chooserProps)
  assert.match(ui.textOf(tree), /最近打开的项目/)
  assert.match(ui.textOf(tree), /staging/)
  const search = ui.inputs(tree)[0]
  search.onChange({ target: { value: 'api' } })
  tree = await ui.settleComponent(chooser.type, chooserProps)
  assert.match(ui.textOf(tree), /\/srv\/api/)
  assert.doesNotMatch(ui.textOf(tree), /\/srv\/app/)
  ui.button(tree, /api/).el.props.onClick()
  assert.deepEqual(opened, [['dev', '/srv/api']])
  assert.deepEqual(selected, [])
})

test('specified hosts start on remote folders and do not expose the local picker first', async () => {
  const ui = mountClient(() => Promise.resolve(ok({ machines: [machine], currentId: machine.id })))
  const tree = await ui.settleComponent(ui.component('sidebar.workspaces.directoryFlow'), { open: true, initialMachineId: 'dev', onCancel() {}, onPicked() {} })
  assert.equal(ui.elements(tree).filter((e) => e.props.role === 'combobox').length, 1)
  assert.match(ui.textOf(tree), /Development/)
  assert.doesNotMatch(ui.textOf(tree), /选用此本地路径/)
})

test('open is locked synchronously; cancellation aborts fetch and fences a late response', async () => {
  let finishMirror, mirrorSignal
  let submitted = 0
  const ui = mountClient((url, opts) => {
    if (String(url).includes('/mirror')) {
      submitted++; mirrorSignal = opts.signal
      return new Promise((resolve) => { finishMirror = () => resolve(ok({ localMirror: '/local/app', path: '/srv/app' })) })
    }
    return Promise.resolve(ok(String(url).includes('/machines') ? { machines: [machine], currentId: machine.id } : {}))
  })
  const picked = []
  const props = { open: true, initialMachineId: 'dev', onCancel() {}, onPicked: (...args) => picked.push(args) }
  const Picker = ui.component('sidebar.workspaces.directoryFlow')
  let tree = await ui.settleComponent(Picker, props)
  ui.elements(tree).find((e) => e.props.role === 'combobox').props.onChange({ target: { value: '/srv/app' } })
  tree = await ui.settleComponent(Picker, props)
  const submit = ui.button(tree, /^设为远程工作区$/).el.props.onClick
  submit(); submit()
  for (let n = 0; n < 20 && !finishMirror; n++) await flush()
  assert.equal(submitted, 1)
  tree = await ui.settleComponent(Picker, props)
  ui.button(tree, /^取消打开$/).el.props.onClick()
  assert.equal(mirrorSignal.aborted, true)
  finishMirror()
  await flush(); await flush()
  assert.deepEqual(picked, [])
  tree = await ui.settleComponent(Picker, props)
  assert.equal(ui.elements(tree).find((e) => e.props.role === 'combobox').props.value, '/srv/app')
  assert.equal(ui.button(tree, /^设为远程工作区$/).disabled, false)
})


test('reopening the same mounted directory flow returns to recent projects', async () => {
  const ui = mount({ effectDependencies: true, fetch: async () => ok({ machines: [machine], currentId: machine.id, entries: [] }) })
  const Picker = ui.component('sidebar.workspaces.directoryFlow')
  const props = { open: true, onPicked() {}, onCancel() {} }
  let tree = await ui.settleComponent(Picker, props)
  ui.button(tree, /^远程$/).el.props.onClick()
  tree = await ui.settleComponent(Picker, props)
  ui.components(tree).find((c) => c.type.name === 'RemoteProjectChooser').props.onMachine(machine)
  tree = await ui.settleComponent(Picker, props)
  assert.ok(ui.elements(tree).some((e) => e.props.role === 'combobox'))
  await ui.settleComponent(Picker, { ...props, open: false })
  tree = await ui.settleComponent(Picker, props)
  assert.ok(ui.components(tree).some((c) => c.type.name === 'RemoteProjectChooser'))
})
