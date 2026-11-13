import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const props = (output, meta, extra = {}) => ({
  toolName: 'rw_exec', callId: 'compile', phase: 'result',
  block: { kind: 'tool-result', call: { argsRaw: JSON.stringify({ command: 'gcc src/main.c', cwd: '/remote/project' }) }, content: [{ type: 'text', text: output }], isError: false, meta },
  ...extra,
})
const facts = (status, code) => ({ kind: 'dsh-remote.exec', version: 1, status, code, host: 'build-host', cwd: '/remote/project/subdir', durationMs: 1234 })
const statusOf = (ui, tree) => ui.elements(tree).find((e) => e.props['data-rw-agent-status']).props['data-rw-agent-status']

test('compiler errors are failed cards and diagnostics navigate to the remote cwd and line', async () => {
  const opened = []
  const ui = mountClient()
  const data = props('src/main.c:3:26: error: expected semicolon\n[exit code: 1]', facts('failed', 1), { openFile: (...args) => opened.push(args) })
  const tree = await ui.settleComponent(ui.body('rw_exec'), data)
  assert.equal(statusOf(ui, tree), 'failed')
  assert.match(ui.textOf(tree), /执行失败/)
  assert.match(ui.textOf(tree), /退出码 1/)
  assert.match(ui.textOf(tree), /耗时 1.2 秒/)
  const diagnostic = ui.buttons(tree).find((b) => b.el.props['aria-label'] === '打开 src/main.c 第 3 行')
  assert.ok(diagnostic, 'the failed card opens its diagnostics automatically')
  diagnostic.el.props.onClick()
  assert.deepEqual(opened, [['/remote/project/subdir/src/main.c', { line: 3 }]])
})

test('durable execution facts outrank output text and historical silence is not labelled successful', async () => {
  const ui = mountClient()
  const view = ui.body('rw_exec')
  let tree = await ui.settleComponent(view, props('compiler printed [exit code: 1]', facts('completed', 0)))
  assert.equal(statusOf(ui, tree), 'completed', 'stdout must not override the actual exit status')
  ui.resetState()
  tree = await ui.settleComponent(view, props('(no output)'))
  assert.equal(statusOf(ui, tree), 'unknown', 'legacy logs do not prove a successful exit')
  ui.resetState()
  tree = await ui.settleComponent(view, props('failed\n[exit code: 2]'))
  assert.equal(statusOf(ui, tree), 'failed')
  ui.resetState()
  tree = await ui.settleComponent(view, props('partial', facts('stopped', -1)))
  assert.equal(statusOf(ui, tree), 'stopped')
  ui.resetState()
  tree = await ui.settleComponent(view, props('partial', facts('timeout', -1)))
  assert.equal(statusOf(ui, tree), 'timeout')
  ui.resetState()
  tree = await ui.settleComponent(view, props('job-1', { ...facts('background', undefined), jobId: 'job-1' }))
  assert.equal(statusOf(ui, tree), 'background')
})

test('compiler errors remain prominent when a trailing shell command returns zero', async () => {
  const ui = mountClient()
  const tree = await ui.settleComponent(ui.body('rw_exec'), props('src/main.c:3:26: error: expected semicolon\n[gcc exit: 1]\n[exit code: 0]', facts('completed', 0)))
  assert.equal(statusOf(ui, tree), 'completed', 'retain the actual shell status')
  assert.match(ui.textOf(tree), /1 项编译错误/)
  assert.match(ui.textOf(tree), /退出码 0/)
  assert.ok(ui.buttons(tree).some((button) => button.el.props['aria-expanded'] === true), 'the diagnostic opens automatically')
})

test('TypeScript Windows diagnostics open an absolute remote path; malformed line references do not become actions', async () => {
  const opened = []
  const ui = mountClient()
  const tree = await ui.settleComponent(ui.body('rw_exec'), props('C:\\work\\src\\app.ts(12,4): error TS2322: incompatible type\nfile.c:0:1: error: invalid line', facts('failed', 2), { openFile: (...args) => opened.push(args) }))
  const diagnostic = ui.buttons(tree).find((b) => b.el.props['aria-label']?.includes('第 12 行'))
  assert.ok(diagnostic)
  diagnostic.el.props.onClick()
  assert.deepEqual(opened, [['C:\\work\\src\\app.ts', { line: 12 }]])
  assert.equal(ui.buttons(tree).some((b) => b.el.props['aria-label']?.includes('第 0 行')), false)
})

test('preparing, tool failures and edit replacements retain honest states and the recorded change', async () => {
  const ui = mountClient()
  let tree = await ui.settleComponent(ui.body('rw_exec'), { toolName: 'rw_exec', callId: 'pending', phase: 'preparing', block: { phase: 'preparing' } })
  assert.equal(statusOf(ui, tree), 'preparing')
  ui.resetState()
  tree = await ui.settleComponent(ui.body('rw_exec'), { ...props('Error: permission denied'), block: { ...props('').block, isError: true, content: [{ type: 'text', text: 'Error: permission denied' }] } })
  assert.equal(statusOf(ui, tree), 'failed')
  assert.match(ui.textOf(tree), /permission denied/)
  ui.resetState()
  tree = await ui.settleComponent(ui.body('rw_edit'), { toolName: 'rw_edit', callId: 'edit', phase: 'result', block: { call: { argsRaw: JSON.stringify({ path: '/remote/a.c', old_string: 'before', new_string: 'after' }) }, content: [{ type: 'text', text: 'replaced' }] } })
  ui.buttons(tree).find((b) => b.el.props['aria-expanded'] === false).el.props.onClick()
  tree = await ui.settleComponent(ui.body('rw_edit'), { toolName: 'rw_edit', callId: 'edit', phase: 'result', block: { call: { argsRaw: JSON.stringify({ path: '/remote/a.c', old_string: 'before', new_string: 'after' }) }, content: [{ type: 'text', text: 'replaced' }] } })
  assert.match(ui.textOf(tree), /替换前before替换后after/)
})
