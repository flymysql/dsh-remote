import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const reply = data => ({ ok: true, status: 200, json: async () => data })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const status = (session = 'a', extra = {}) => ({ ok: true, available: true, repo: '/remote/' + session, workspace: '/remote/' + session, branch: 'branch-' + session, files: [
  { path: 'main.c', absolutePath: '/remote/' + session + '/main.c', indexStatus: 'M', worktreeStatus: 'M' },
  { path: 'new.txt', absolutePath: '/remote/' + session + '/new.txt', indexStatus: '?', worktreeStatus: '?', untracked: true },
  { path: 'deleted.c', absolutePath: '/remote/' + session + '/deleted.c', indexStatus: ' ', worktreeStatus: 'D', deleted: true },
], ...extra })
const patch = value => `diff --git a/main.c b/main.c\n--- a/main.c\n+++ b/main.c\n@@ -1,2 +1,2 @@\n context\n-before\n+${value}\n`
const props = (sessionId, opened = []) => ({ sessionId, useTabInfo: () => ({ tab: { visible: true, actions: { openResource: (...args) => opened.push({ sessionId, args }) } } }) })
const input = (ui, tree) => ui.inputs(tree).find(p => p['aria-label'] === '筛选改动文件')
const action = (ui, tree, label) => {
  const node = ui.components(tree).find(c => c.type.name === 'WorkbenchAction' && c.props.label === label)
  assert.ok(node, 'missing action ' + label)
  return node.props
}

test('remote Git workbench separates working/staged patches and opens the selected remote file at its diff line', async t => {
  const requests = [], opened = []
  const ui = mountClient({ effectDependencies: true, fetch: async url => {
    const q = new URL(String(url), 'http://localhost').searchParams; requests.push(q)
    return reply(q.get('action') === 'status' ? status() : { ok: true, available: true, patch: patch(q.get('staged') === '1' ? 'STAGED_CHANGE' : 'WORKING_CHANGE') })
  } })
  t.after(() => ui.dispose()); const body = ui.body('dsh-remote/changes'), p = props('a', opened)
  let tree = await ui.settleComponent(body, p)
  assert.match(ui.textOf(tree), /branch-a/); assert.match(ui.textOf(tree), /WORKING_CHANGE/)
  const line = ui.buttons(tree).find(b => b.el.props['data-rw-diff-line'] === 2)
  assert.ok(line); line.el.props.onClick()
  assert.deepEqual(opened, [{ sessionId: 'a', args: ['dsh-resource://dsh-remote/a/%2Fremote%2Fa%2Fmain.c', { params: { line: 2 } }] }])
  await ui.click(tree, /^已暂存/); tree = await ui.settleComponent(body, p)
  assert.match(ui.textOf(tree), /STAGED_CHANGE/); assert.doesNotMatch(ui.textOf(tree), /WORKING_CHANGE/)
  assert.deepEqual(ui.elements(tree).filter(e => e.props['data-rw-git-file']).map(e => e.props['data-rw-git-file']), ['main.c'])
  assert.ok(requests.some(q => q.get('action') === 'diff' && q.get('staged') === '1'))
  input(ui, tree).onChange({ target: { value: 'not-found' } }); tree = await ui.settleComponent(body, p)
  assert.match(ui.textOf(tree), /没有匹配的改动文件/)
})

test('a late Git status response cannot replace the next session or its file navigation', async t => {
  const first = deferred(), opened = []
  const ui = mountClient({ effectDependencies: true, fetch: async url => {
    const q = new URL(String(url), 'http://localhost').searchParams
    if (q.get('action') === 'status') return q.get('sessionId') === 'a' ? first.promise : reply(status('b'))
    return reply({ ok: true, available: true, patch: patch('B_ONLY') })
  } })
  t.after(() => ui.dispose()); const body = ui.body('dsh-remote/changes')
  await ui.settleComponent(body, props('a', opened))
  let tree = await ui.settleComponent(body, props('b', opened))
  first.resolve(reply(status('a'))); await ui.tick(); tree = await ui.settleComponent(body, props('b', opened))
  assert.match(ui.textOf(tree), /branch-b/); assert.doesNotMatch(ui.textOf(tree), /branch-a/)
  action(ui, tree, '打开远端文件').onClick()
  assert.equal(opened[0].sessionId, 'b'); assert.match(opened[0].args[0], /^dsh-resource:\/\/dsh-remote\/b\//)
})

test('selecting another Git file hides and rejects an older diff that arrives afterwards', async t => {
  const first = deferred()
  const ui = mountClient({ effectDependencies: true, fetch: async url => {
    const q = new URL(String(url), 'http://localhost').searchParams
    if (q.get('action') === 'status') return reply(status())
    return q.get('path') === 'main.c' ? first.promise : reply({ ok: true, available: true, patch: patch('NEW_FILE_ONLY') })
  } })
  t.after(() => ui.dispose()); const body = ui.body('dsh-remote/changes'), p = props('a')
  let tree = await ui.settleComponent(body, p)
  ui.elements(tree).find(e => e.props['data-rw-git-file'] === 'new.txt').props.onClick(); tree = await ui.settleComponent(body, p)
  first.resolve(reply({ ok: true, available: true, patch: patch('STALE_MAIN_DIFF') })); await ui.tick(); tree = await ui.settleComponent(body, p)
  assert.match(ui.textOf(tree), /NEW_FILE_ONLY/); assert.doesNotMatch(ui.textOf(tree), /STALE_MAIN_DIFF/)
})

test('Git empty, unavailable, bounded and failed states remain explicit and retryable', async t => {
  let state = { ok: true, available: false, reason: 'git-unavailable' }
  const ui = mountClient({ effectDependencies: true, fetch: async () => reply(state) })
  t.after(() => ui.dispose()); const body = ui.body('dsh-remote/changes'), p = props('a')
  let tree = await ui.settleComponent(body, p); assert.match(ui.textOf(tree), /远端未安装 Git/)
  state = status('a', { files: [] }); await action(ui, tree, '刷新').onClick(); tree = await ui.settleComponent(body, p)
  assert.match(ui.textOf(tree), /工作区干净/)
  state = status('a', { files: [{ path: 'deleted.c', absolutePath: '/remote/a/deleted.c', indexStatus: ' ', worktreeStatus: 'D', deleted: true }], truncated: true })
  await action(ui, tree, '刷新').onClick(); tree = await ui.settleComponent(body, p)
  assert.match(ui.textOf(tree), /仅显示部分结果/)
  assert.equal(action(ui, tree, '打开远端文件').disabled, true)
  state = { ok: false, error: 'remote permission denied' }; await action(ui, tree, '刷新').onClick(); tree = await ui.settleComponent(body, p)
  assert.match(ui.textOf(tree), /remote permission denied/); assert.match(ui.textOf(tree), /上次成功读取/)
})
