import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const reply = value => ({ ok: true, status: 200, json: async () => value })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const snapshot = (query = 'block', status = 'running', extra = {}) => ({ id: 'search-' + query, query, mode: 'names', status, phase: 'scanning', results: [], scannedDirs: 3, scannedFiles: 12, skipped: 0, errors: 0, elapsedMs: 450, ...extra })
const file = { path: '/project/src/block.c', relative: 'src/block.c', name: 'block.c', type: 'file' }
const directory = { path: '/project/deep/block-dir', relative: 'deep/block-dir', name: 'block-dir', type: 'directory' }

async function setup(t, searchFetch) {
  const calls = []
  const ui = mountClient({ effectDependencies: true, fetch: async (url, init = {}) => {
    const request = { url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null }
    calls.push(request)
    if (request.url.includes('/search')) return searchFetch(request)
    if (request.url.includes('/resolve-mirror')) return reply({ remotePath: '/project' })
    if (request.url.includes('/status')) return reply({ connected: true, host: 'fixture', username: 'dev' })
    if (request.url.includes('/ls')) return reply({ path: '/project', items: [] })
    return reply({ ok: true })
  } })
  t.after(() => ui.dispose())
  const Explorer = ui.body('dsh-remote/explorer')
  const info = { sessionId: 'extract', useTabInfo: () => ({ tab: { visible: true, actions: { openResource() {}, openTab() {} } } }) }
  let tree = await ui.settleComponent(Explorer, info)
  const toggle = ui.components(tree).find(c => c.type.name === 'WorkbenchAction' && c.props.icon === 'search')
  assert.ok(toggle, 'native explorer exposes its remote search action')
  assert.doesNotMatch(ui.textOf(tree), /镜像同步/, 'the live tree does not repeat mirror synchronization status')
  toggle.props.onClick(); tree = await ui.settleComponent(Explorer, info)
  ui.inputs(tree).find(p => p['aria-label'] === '搜索远程工作区').onChange({ target: { value: 'extract' } })
  tree = await ui.settleComponent(Explorer, info)
  assert.equal(ui.elements(tree).find(e => e.props.className === 'dsh-rw-search-options')?.props.open, undefined, 'advanced search controls are collapsed by default')
  assert.equal(ui.buttons(tree).some(b => b.label === '新建目录'), false, 'active search does not show the tree footer')
  const Search = ui.components(tree).find(c => c.type.name === 'RemoteWorkspaceSearch')?.type
  assert.ok(Search, 'search is the actual component contributed by the native explorer')
  ui.resetState()
  const opened = [], revealed = []
  const props = { sessionId: 'a', root: '/project', query: 'block', mode: 'names', includeIgnored: false, caseSensitive: false,
    onOpenFile: (...args) => opened.push(args), onRevealDirectory: path => revealed.push(path) }
  const render = (next = props) => ui.settleComponent(Search, next)
  const searchCalls = () => calls.filter(c => c.url.includes('/search'))
  return { ui, Search, props, render, searchCalls, opened, revealed }
}

test('remote search shows immediate preparation, actual scan progress, incremental results and file/directory navigation', async t => {
  const { ui, render, searchCalls, opened, revealed } = await setup(t, request => reply({ ok: true, search: request.method === 'POST'
    ? snapshot('block', 'running', { results: [directory] })
    : snapshot('block', 'completed', { results: [directory, { ...file, line: 7, text: 'literal block match' }], scannedDirs: 8, scannedFiles: 39 }) }))
  let tree = await render()
  assert.match(ui.textOf(tree), /准备搜索/)
  assert.equal(searchCalls().length, 0, 'typing does not start a request before debounce')
  assert.equal(ui.elements(tree).find(e => e.type === 'section').props['aria-busy'], true)
  const details = ui.elements(tree).find(e => e.type === 'details')
  assert.equal(details.props.open, undefined, 'scan details are collapsed by default')
  assert.ok(ui.elements(details).some(e => e.type === 'summary' && e.props['aria-label'] === '扫描详情'))
  await wait(370); await ui.tick(); tree = await render()
  assert.match(ui.textOf(tree), /正在搜索/); assert.match(ui.textOf(tree), /3 个目录 · 12 个文件 · 1 个结果/)
  assert.ok(ui.elements(tree).some(e => e.type === 'progress'))
  ui.elements(tree).find(e => e.props['data-rw-search-result'] === directory.relative).props.onClick()
  assert.deepEqual(revealed, [directory.path])
  await wait(770); await ui.tick(); tree = await render()
  assert.match(ui.textOf(tree), /搜索完成/); assert.match(ui.textOf(tree), /8 个目录 · 39 个文件 · 2 个结果/)
  assert.match(ui.textOf(tree), /第 7 行/)
  ui.elements(tree).find(e => e.props['data-rw-search-result'] === file.relative).props.onClick()
  assert.deepEqual(opened, [[file.path, 7]])
  assert.equal(ui.elements(tree).find(e => e.type === 'section').props['aria-busy'], false)
})

test('a replaced query/session cancels a late-created old job without publishing its results', async t => {
  const old = deferred()
  const { ui, render, props, searchCalls } = await setup(t, request => {
    if (request.body?.action === 'cancel') return reply({ ok: true, search: snapshot(request.body.id, 'cancelled') })
    if (request.body?.sessionId === 'a') return old.promise
    return reply({ ok: true, search: snapshot('fresh', 'completed', { results: [{ ...file, name: 'NEW_SESSION_ONLY', path: '/other/fresh.c' }] }) })
  })
  await render(); await wait(370); await ui.tick()
  const next = { ...props, sessionId: 'b', root: '/other', query: 'fresh' }
  let tree = await render(next)
  assert.match(ui.textOf(tree), /准备搜索/); assert.doesNotMatch(ui.textOf(tree), /OLD_SESSION/)
  await wait(370); await ui.tick(); tree = await render(next)
  old.resolve(reply({ ok: true, search: snapshot('block', 'completed', { id: 'old-job', results: [{ ...file, name: 'OLD_SESSION_RESULT' }] }) }))
  await ui.tick(); tree = await render(next)
  assert.match(ui.textOf(tree), /NEW_SESSION_ONLY/); assert.doesNotMatch(ui.textOf(tree), /OLD_SESSION_RESULT/)
  assert.ok(searchCalls().some(c => c.body?.action === 'cancel' && c.body?.id === 'old-job' && c.body?.sessionId === 'a'))
})

test('stopping a running search retains found results and rejects an in-flight poll, then retry creates a new job', async t => {
  const poll = deferred(); let starts = 0
  const { ui, render, searchCalls } = await setup(t, request => {
    if (request.method === 'GET') return poll.promise
    if (request.body.action === 'cancel') return reply({ ok: true, search: snapshot('block', 'cancelled') })
    return reply({ ok: true, search: snapshot('block', 'running', { id: 'job-' + ++starts, results: [file] }) })
  })
  await render(); await wait(370); await ui.tick()
  let tree = await render(); await wait(770); await ui.tick()
  ui.button(tree, /^停止$/).el.props.onClick(); tree = await render()
  assert.match(ui.textOf(tree), /搜索已停止/); assert.match(ui.textOf(tree), /block.c/)
  assert.ok(searchCalls().some(c => c.body?.action === 'cancel' && c.body.id === 'job-1'))
  poll.resolve(reply({ ok: true, search: snapshot('block', 'completed', { results: [{ ...file, name: 'LATE_POLL_RESULT' }] }) }))
  await ui.tick(); tree = await render(); assert.doesNotMatch(ui.textOf(tree), /LATE_POLL_RESULT/)
  ui.button(tree, /^重新搜索$/).el.props.onClick(); await ui.tick(); tree = await render(); await ui.tick(); tree = await render()
  assert.equal(starts, 2); assert.match(ui.textOf(tree), /正在搜索/)
})

test('search mode, case and ignored-directory choices reach the backend; empty, partial and error states are explicit', async t => {
  let result = snapshot('block', 'completed', { mode: 'content' })
  const { ui, render, props, searchCalls } = await setup(t, request => request.body?.action === 'cancel' ? reply({ ok: true, search: snapshot('block', 'cancelled') }) : reply({ ok: true, search: result }))
  const content = { ...props, mode: 'content', includeIgnored: true, caseSensitive: true }
  await render(content); await wait(370); await ui.tick(); let tree = await render(content)
  const start = searchCalls().find(c => c.body?.action === 'start')
  assert.equal(start.body.mode, 'content'); assert.equal(start.body.includeIgnored, true); assert.equal(start.body.caseSensitive, true)
  assert.match(ui.textOf(tree), /未找到匹配项/)
  result = snapshot('block', 'partial', { mode: 'content', skipped: 4, errors: 1, results: [file] })
  ui.button(tree, /^重新搜索$/).el.props.onClick(); tree = await render(content); await ui.tick(); tree = await render(content)
  assert.match(ui.textOf(tree), /已找到部分结果/); assert.match(ui.textOf(tree), /跳过 4 项 · 1 项读取失败/)
  result = { ...snapshot('block', 'failed', { mode: 'content' }), error: 'SSH permission denied' }
  ui.button(tree, /^重新搜索$/).el.props.onClick(); tree = await render(content); await ui.tick(); tree = await render(content)
  assert.match(ui.textOf(tree), /搜索失败/); assert.match(ui.textOf(tree), /SSH permission denied/)
})

test('same query invalidates results when session, root, case sensitivity or ignore policy changes', async t => {
  const { ui, render, props, searchCalls } = await setup(t, request => reply({ ok: true, search: snapshot('block', request.body?.action === 'cancel' ? 'cancelled' : 'completed', { results: [{ ...file, name: 'PREVIOUS_SCOPE_RESULT' }] }) }))
  let active = props
  await render(active); await wait(370); await ui.tick()
  let tree = await render(active); assert.match(ui.textOf(tree), /PREVIOUS_SCOPE_RESULT/)
  for (const change of [{ sessionId: 'b' }, { root: '/different-root' }, { caseSensitive: true }, { includeIgnored: true }]) {
    active = { ...active, ...change }
    tree = await render(active)
    assert.match(ui.textOf(tree), /准备搜索/)
    assert.doesNotMatch(ui.textOf(tree), /PREVIOUS_SCOPE_RESULT/, 'the previous scope cannot remain actionable while a new scope is preparing')
    await wait(370); await ui.tick(); tree = await render(active)
    assert.match(ui.textOf(tree), /PREVIOUS_SCOPE_RESULT/)
  }
  const starts = searchCalls().filter(c => c.body?.action === 'start')
  assert.equal(starts.length, 5)
  assert.equal(starts.at(-1).body.caseSensitive, true)
  assert.equal(starts.at(-1).body.includeIgnored, true)
})

test('stop during debounce prevents any remote job', async t => {
  const { ui, render, searchCalls } = await setup(t, () => { throw new Error('a cancelled debounce must not reach the backend') })
  let tree = await render()
  ui.button(tree, /^停止$/).el.props.onClick(); tree = await render()
  assert.match(ui.textOf(tree), /搜索已停止/)
  await wait(370); await ui.tick()
  assert.equal(searchCalls().length, 0)
})
