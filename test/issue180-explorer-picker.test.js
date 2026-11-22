// Issue #180 — "勾选远程文件没有响应" on a Windows→Linux remote session.
//
// Three defects combined into a pane that looked broken:
//   1. the "…" entry point that opens the remote-workspace picker disappeared in
//      1.0.0 (b28fcc3) — only the `explorer.more` translation string survived —
//      while the empty state still told the user to click it;
//   2. even if reached, `onPicked` threw the picked path away and re-resolved the
//      SAME session cwd, so choosing a remote directory changed nothing;
//   3. when `GET /dsh-remote/bindings` failed, the session was silently labelled
//      "this session is a local workspace" — a guess presented as a fact.
//
// The picker is an EXPLORER-ONLY override: it must never write the session's
// workspace binding and never fall back to "the current machine" (issue #13).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const reply = (value) => ({ ok: true, status: 200, json: async () => value })
const failed = (status = 500, error = 'bindings unavailable') => ({ ok: false, status, json: async () => ({ error }) })

const CWD = '/home/me/localproj'
const sessions = { list: { getSnapshot: () => ({ byId: { s1: { cwd: CWD } } }), subscribe: () => () => {} } }
const tabInfo = () => ({ tab: { visible: true, actions: { openTab() {}, openResource() {} } } })

/** Mount the native explorer (the shipped "工作区文件" panel) on a scripted backend. */
async function setup(t, { bindings, resolveMirror, ls } = {}) {
  const calls = []
  const ui = mountClient({
    effectDependencies: true,
    withHostChrome: true,
    services: { sessions },
    fetch: async (url, init = {}) => {
      const request = { url: String(url), method: init.method || 'GET' }
      calls.push(request)
      if (request.url.includes('/bindings')) return bindings ? bindings() : reply({ mirrors: [] })
      if (request.url.includes('/resolve-mirror')) return resolveMirror ? resolveMirror() : reply({})
      if (request.url.includes('/ls')) return ls ? ls(request) : reply({ path: CWD, items: [] })
      if (request.url.includes('/status')) return reply({ connected: true, host: 'fixture', username: 'dev' })
      if (request.url.includes('/workspace-context')) return reply({ kind: 'local', root: CWD, connected: true })
      return reply({ ok: true })
    },
  })
  t.after(() => ui.dispose())
  const Explorer = ui.body('dsh-remote/explorer')
  const props = { sessionId: 's1', useTabInfo: tabInfo }
  const render = (next = props) => ui.settleComponent(Explorer, next)
  const lsPaths = () => calls
    .filter((c) => c.url.includes('/ls?'))
    .map((c) => decodeURIComponent(new URL(c.url, 'http://x').searchParams.get('path') || ''))
  return { ui, Explorer, props, render, calls, lsPaths }
}

const action = (ui, tree, icon) => ui.components(tree).find((c) => c.type.name === 'WorkbenchAction' && c.props.icon === icon)

test('#180: the explorer exposes the "…" remote-workspace picker entry point', async t => {
  const { ui, render } = await setup(t)
  const tree = await render()
  const more = action(ui, tree, 'more')
  assert.ok(more, 'the "…" action must exist — the empty-state copy tells the user to click it')
  assert.equal(more.props.label, '选择远程工作区', 'and it is labelled for what it does, not just "…"')
  assert.equal(more.props.pressed, false, 'closed by default')
  more.props.onClick()
  const opened = await render()
  assert.equal(action(ui, opened, 'more').props.pressed, true, 'clicking opens the picker')
  assert.ok(ui.components(opened).some((c) => c.type.name === 'DirPicker'), 'the picker is mounted from the explorer itself')
})

test('#180: picking a remote directory actually re-roots the tree at that path', async t => {
  const { ui, render, lsPaths } = await setup(t)
  let tree = await render()
  // A local session with no pick: the local root is what gets listed.
  assert.ok(lsPaths().includes(CWD), 'without a pick the local root is listed')
  assert.ok(!lsPaths().includes('/srv/app'), 'and no remote path is read for a local session')

  action(ui, tree, 'more').props.onClick()
  tree = await render()
  const Picker = ui.components(tree).find((c) => c.type.name === 'DirPicker')
  // DirPicker reports (localMirror, remotePath) — the REMOTE path is the root.
  Picker.props.onPicked('/srv/app', '/srv/app')
  tree = await render()

  assert.ok(lsPaths().includes('/srv/app'), 'the picked remote directory is listed, got: ' + JSON.stringify(lsPaths()))
  assert.equal(action(ui, tree, 'more').props.pressed, false, 'the picker closes after a pick')
  // Picking is a view override only: it must not create a mirror behind the
  // user's back (registerWorkspace:false stays false).
  assert.equal(Picker.props.registerWorkspace, false, 'the explorer picker never registers a workspace')
})

test('#180: an unreadable workspace registry is reported, not silently called "local"', async t => {
  const { ui, render } = await setup(t, { bindings: () => failed() })
  const tree = await render()
  const text = ui.textOf(tree)
  assert.doesNotMatch(text, /当前会话是本地工作区/,
    'we cannot prove the session is local when the registry failed — do not claim it')
  assert.match(text, /暂时无法读取此会话的远程工作区/, 'say what actually went wrong')
  assert.match(text, /无法读取远程工作区列表/, 'and name the failed request')
  const retry = ui.buttons(tree).find((b) => b.label === '重试')
  assert.ok(retry, 'an empty pane the user cannot act on is the bug — offer Retry')
  assert.equal(retry.disabled, false)
})

test('#180: a healthy registry with no mirror still reports a plain local session', async t => {
  const { ui, render } = await setup(t, { bindings: () => reply({ mirrors: [] }) })
  const tree = await render()
  assert.match(ui.textOf(tree), /本地工作区/, 'the local session keeps its local labels')
  assert.equal(ui.buttons(tree).some((b) => b.label === '重试'), false, 'no error affordance when nothing failed')
})
