import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const props = (sessionId, path = '/project/generated.html', revision = 1) => ({ sessionId, useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://dsh-remote/file/' + encodeURIComponent(path), revision } } }) })
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const missing = () => response({ code: 'REMOTE_FILE_MISSING_LOCAL_COPY', localCopy: { available: true }, error: 'No such file' }, 404)

test('missing remote artifact requires explicit local preview and create-only upload before editing', async t => {
  let published = false
  const requests = []
  const ui = mountClient({ effectDependencies: true, fetch: async (url, options) => {
    const body = JSON.parse(options.body || '{}')
    requests.push({ url: String(url), body })
    if (String(url).endsWith('/local-copy/read')) return response({ source: 'local-mirror', content: '<h1>Generated</h1>', localRevision: 'local-hash' })
    if (String(url).endsWith('/local-copy/publish')) { published = true; return response({ ok: true }) }
    return published ? response({ content: '<h1>Generated</h1>', revision: 'remote-hash', mtime: 7 }) : missing()
  } })
  t.after(() => ui.dispose())
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  assert.match(ui.textOf(tree), /远端没有此文件/)
  assert.equal(ui.components(tree).some(c => c.type.name === 'HighlightedEditor'), false)
  assert.equal(requests.some(r => r.url.includes('/local-copy/')), false, 'opening never reads or uploads the local copy silently')
  ui.button(tree, /^查看本地副本$/).el.props.onClick()
  await ui.tick()
  tree = await ui.settleComponent(body, props('a'))
  assert.match(ui.textOf(tree), /本地镜像副本 · 只读/)
  assert.equal(ui.components(tree).some(c => c.type.name === 'HighlightedEditor'), false)
  ui.button(tree, /^上传到远端并打开$/).el.props.onClick()
  await ui.tick()
  tree = await ui.settleComponent(body, props('a'))
  assert.equal(ui.components(tree).find(c => c.type.name === 'HighlightedEditor').props.value, '<h1>Generated</h1>')
  const upload = requests.find(r => r.url.endsWith('/local-copy/publish'))
  assert.deepEqual(upload.body, { path: '/project/generated.html', expectedLocalRevision: 'local-hash', sessionId: 'a' })
})

test('upload conflict keeps the local copy read-only and never falls through to remote write', async t => {
  const requests = []
  const ui = mountClient({ effectDependencies: true, fetch: async (url, options) => {
    requests.push(String(url))
    if (String(url).endsWith('/local-copy/read')) return response({ source: 'local-mirror', content: 'local', localRevision: 'v1' })
    if (String(url).endsWith('/local-copy/publish')) return response({ error: 'Remote file now exists' }, 409)
    return missing()
  } })
  t.after(() => ui.dispose())
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  ui.button(tree, /^查看本地副本$/).el.props.onClick()
  await ui.tick()
  tree = await ui.settleComponent(body, props('a'))
  ui.button(tree, /^上传到远端并打开$/).el.props.onClick()
  await ui.tick()
  tree = await ui.settleComponent(body, props('a'))
  assert.match(ui.textOf(tree), /Remote file now exists/)
  assert.equal(ui.components(tree).some(c => c.type.name === 'HighlightedEditor'), false)
  assert.equal(requests.some(url => url.endsWith('/write')), false)
})

test('permission failures never offer local fallback', async t => {
  const ui = mountClient({ fetch: async () => response({ error: 'Permission denied' }, 403) })
  t.after(() => ui.dispose())
  const tree = await ui.settleComponent(ui.body('dsh-remote/file'), props('a'))
  assert.match(ui.textOf(tree), /Permission denied/)
  assert.equal(ui.buttons(tree).some(b => /查看本地副本/.test(b.label)), false)
})

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const editor = (ui, tree) => ui.components(tree).find(component => component.type.name === 'HighlightedEditor')
const preview = (ui, tree) => ui.components(tree).find(component => component.type.name === 'CodeView')?.props.code

test('an in-flight local preview stays scoped to its session and does not block another session recovery', async t => {
  const pending = deferred(), requests = []
  const ui = mountClient({ effectDependencies: true, fetch: async (url, options) => {
    const body = JSON.parse(options.body || '{}'); requests.push({ url: String(url), body })
    if (String(url).endsWith('/local-copy/read')) return body.sessionId === 'a' ? pending.promise : response({ content: 'LOCAL_B', localRevision: 'b1' })
    return missing()
  } })
  t.after(() => ui.dispose())
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  const readA = ui.button(tree, /^查看本地副本$/).el.props.onClick
  readA(); readA()
  assert.equal(requests.filter(request => request.url.endsWith('/local-copy/read')).length, 1, 'double click starts only one request in the same view')
  tree = await ui.settleComponent(body, props('b'))
  ui.button(tree, /^查看本地副本$/).el.props.onClick()
  await ui.tick(); tree = await ui.settleComponent(body, props('b'))
  assert.equal(preview(ui, tree), 'LOCAL_B', 'a slow request in session A cannot prevent B from opening its own copy')
  pending.resolve(response({ content: 'STALE_A', localRevision: 'a1' }))
  await ui.tick(); tree = await ui.settleComponent(body, props('b'))
  assert.equal(preview(ui, tree), 'LOCAL_B', 'late A bytes cannot replace B preview')
  assert.deepEqual(requests.filter(request => request.url.endsWith('/local-copy/read')).map(request => request.body.sessionId), ['a', 'b'])
  assert.equal(requests.some(request => request.url.endsWith('/write') || request.url.endsWith('/local-copy/publish')), false)
})

test('a refreshed remote file cannot be masked by a late local preview from the same path', async t => {
  const pending = deferred()
  let exists = false
  const ui = mountClient({ effectDependencies: true, fetch: async (url) => {
    if (String(url).endsWith('/local-copy/read')) return pending.promise
    return exists ? response({ content: 'ACTUAL_REMOTE', revision: 'r2', mtime: 2 }) : missing()
  } })
  t.after(() => ui.dispose())
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  ui.button(tree, /^查看本地副本$/).el.props.onClick()
  exists = true
  tree = await ui.settleComponent(body, props('a', '/project/generated.html', 2))
  assert.equal(editor(ui, tree)?.props.value, 'ACTUAL_REMOTE')
  pending.resolve(response({ content: 'OBSOLETE_LOCAL', localRevision: 'old-copy' }))
  await ui.tick(); tree = await ui.settleComponent(body, props('a', '/project/generated.html', 2))
  assert.equal(preview(ui, tree), undefined, 'the revalidated remote result owns the current view')
  assert.equal(editor(ui, tree)?.props.value, 'ACTUAL_REMOTE')
  assert.equal(ui.elements(tree).some(element => element.props['data-rw-local-copy-preview'] !== undefined), false)
})

test('finishing an upload after switching paths never reloads or edits the new path', async t => {
  const pending = deferred(), requests = []
  const ui = mountClient({ effectDependencies: true, fetch: async (url, options) => {
    const body = JSON.parse(options.body || '{}'); requests.push({ url: String(url), body })
    if (String(url).endsWith('/local-copy/read')) return response({ content: 'LOCAL_A', localRevision: 'a1' })
    if (String(url).endsWith('/local-copy/publish')) return pending.promise
    if (body.path === '/project/other.html') return response({ content: 'REMOTE_B', revision: 'b1', mtime: 9 })
    return missing()
  } })
  t.after(() => ui.dispose())
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  ui.button(tree, /^查看本地副本$/).el.props.onClick()
  await ui.tick(); tree = await ui.settleComponent(body, props('a'))
  const publish = ui.button(tree, /^上传到远端并打开$/).el.props.onClick
  publish(); publish()
  assert.equal(requests.filter(request => request.url.endsWith('/local-copy/publish')).length, 1)
  tree = await ui.settleComponent(body, props('a', '/project/other.html'))
  assert.equal(editor(ui, tree)?.props.value, 'REMOTE_B')
  const readCount = requests.filter(request => request.url.endsWith('/read')).length
  pending.resolve(response({ ok: true }))
  await ui.tick(); tree = await ui.settleComponent(body, props('a', '/project/other.html'))
  assert.equal(editor(ui, tree)?.props.value, 'REMOTE_B')
  assert.equal(requests.filter(request => request.url.endsWith('/read')).length, readCount, 'a completed upload for the old path cannot refresh the active path')
  assert.equal(requests.some(request => request.url.endsWith('/write')), false)
})

test('local-copy upload preserves an existing unsaved remote draft and its conflict protection', async t => {
  let state = 'existing'
  const requests = []
  const ui = mountClient({ effectDependencies: true, fetch: async (url, options) => {
    const body = JSON.parse(options.body || '{}'); requests.push({ url: String(url), body })
    if (String(url).endsWith('/local-copy/read')) return response({ content: 'LOCAL_ARTIFACT', localRevision: 'local-v1' })
    if (String(url).endsWith('/local-copy/publish')) { state = 'published'; return response({ ok: true }) }
    if (state === 'missing') return missing()
    return response({ content: state === 'existing' ? 'REMOTE_BASE' : 'LOCAL_ARTIFACT', revision: state === 'existing' ? 'remote-v1' : 'remote-v2', mtime: state === 'existing' ? 1 : 2 })
  } })
  t.after(() => ui.dispose())
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  editor(ui, tree).props.onChange({ target: { value: 'HUMAN_UNSAVED', selectionStart: 13 } })
  await ui.settleComponent(body, props('a'))
  state = 'missing'; tree = await ui.settleComponent(body, props('a', '/project/generated.html', 2))
  ui.button(tree, /^查看本地副本$/).el.props.onClick()
  await ui.tick(); tree = await ui.settleComponent(body, props('a', '/project/generated.html', 2))
  assert.equal(preview(ui, tree), 'LOCAL_ARTIFACT')
  assert.equal(editor(ui, tree), undefined, 'previewing the disk artifact never presents the old draft as uploaded')
  ui.button(tree, /^上传到远端并打开$/).el.props.onClick()
  await ui.tick(); tree = await ui.settleComponent(body, props('a', '/project/generated.html', 2))
  assert.equal(editor(ui, tree)?.props.value, 'HUMAN_UNSAVED', 'recovery must not erase the independently authored draft')
  assert.equal(ui.button(tree, /^保存到远程$/).disabled, true, 'the draft retains its old remote revision guard')
  assert.match(ui.textOf(tree), /远端文件已变化，草稿已保留/)
  assert.equal(requests.some(request => request.url.endsWith('/write')), false)
  assert.deepEqual(requests.find(request => request.url.endsWith('/local-copy/publish')).body, { sessionId: 'a', path: '/project/generated.html', expectedLocalRevision: 'local-v1' })
})

test('an older refresh reporting a missing file cannot erase newer same-path remote content', async t => {
  const pending = deferred(), requests = []
  let reads = 0
  const ui = mountClient({ effectDependencies: true, fetch: async (url, options) => {
    requests.push(String(url))
    if (String(url).endsWith('/dsh-remote/read')) {
      reads++
      if (reads === 2) return pending.promise
      return response({ content: reads === 1 ? 'REMOTE_BASE' : 'NEW_REMOTE_ARTIFACT', revision: 'remote-' + reads, mtime: reads })
    }
    return response({ ok: true })
  } })
  t.after(() => ui.dispose())
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  const refresh = ui.components(tree).find(component => component.type.name === 'WorkbenchAction' && component.props.label === '刷新')
  assert.ok(refresh)
  refresh.props.onClick()
  await ui.tick()
  // A new chat/Agent navigation to the already-open file revalidates it while
  // the user's previous refresh is still waiting for its remote response.
  tree = await ui.settleComponent(body, props('a', '/project/generated.html', 2))
  assert.equal(reads, 3)
  assert.equal(editor(ui, tree)?.props.value, 'NEW_REMOTE_ARTIFACT')
  pending.resolve(missing())
  await ui.tick(); tree = await ui.settleComponent(body, props('a', '/project/generated.html', 2))
  assert.equal(editor(ui, tree)?.props.value, 'NEW_REMOTE_ARTIFACT', 'the latest remote read owns the editor baseline')
  assert.equal(ui.elements(tree).some(element => element.props['data-rw-local-copy-recovery'] !== undefined), false, 'stale ENOENT cannot offer local recovery for an existing remote file')
  assert.equal(requests.some(url => url.includes('/local-copy/') || url.endsWith('/write')), false)
})

test('large local text remains a complete read-only preview without thousands of rendered code rows', async t => {
  const content = 'generated line\n'.repeat(12000)
  const ui = mountClient({ effectDependencies: true, fetch: async url => String(url).endsWith('/local-copy/read')
    ? response({ content, localRevision: 'large-copy' }) : missing() })
  t.after(() => ui.dispose())
  const body = ui.body('dsh-remote/file')
  let tree = await ui.settleComponent(body, props('a'))
  ui.button(tree, /^查看本地副本$/).el.props.onClick()
  await ui.tick(); tree = await ui.settleComponent(body, props('a'))
  const plain = ui.elements(tree).find(e => e.props['data-rw-local-copy-large'] !== undefined)
  assert.ok(plain)
  assert.equal(ui.textOf(plain), content)
  assert.equal(ui.components(tree).some(c => ['CodeView', 'HighlightedEditor'].includes(c.type.name)), false)
  assert.ok(ui.button(tree, /^上传到远端并打开$/))
})
