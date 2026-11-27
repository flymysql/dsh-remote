import { test } from 'node:test'
import assert from 'node:assert/strict'
import { removeRemoteTree } from '../lib/remote-fs.js'
import { createFsRoutes } from '../lib/routes-fs.js'
import { FakeFs, startFakeSsh } from './harness/fake-ssh.js'
import { createHost } from './harness/plugin-host.js'
import { mountClient } from './harness/render.js'

const dir = '/project/tree'

function inMemorySftp(files, failures = {}) {
  const fs = new FakeFs(files)
  const calls = []
  const attrs = entry => ({ isDirectory: () => entry.type === 'dir' })
  const operation = (op, act) => async path => {
    calls.push([op, path])
    if (failures[path] === op) throw new Error('permission denied')
    return act(path)
  }
  const sftp = {
    lstat: operation('lstat', path => {
      const entry = fs.get(path)
      if (!entry) throw Object.assign(new Error('no such file'), { code: 2 })
      return attrs(entry)
    }),
    readdir: operation('readdir', path => fs.list(path).map(({ filename, entry }) => ({ filename, attrs: attrs(entry) }))),
    rmdir: operation('rmdir', path => fs.rmdir(path)),
    unlink: operation('unlink', path => fs.remove(path)),
  }
  return { fs, sftp, calls }
}

function httpRemove(sftp) {
  const binding = { pool: { sftp: async () => sftp } }
  const audit = []
  let mutations = 0
  const route = createFsRoutes({
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async req => JSON.stringify(req.body),
    resolveRequestBinding: async () => binding,
    audit: (...args) => audit.push(args),
    onRemoteMutation: () => { mutations++ },
  }).find(route => route.path === '/dsh-remote/fs')
  return {
    audit,
    binding,
    get mutations() { return mutations },
    async remove(path) {
      const res = {}
      await route.handler({ method: 'POST', body: { op: 'remove', path } }, res)
      return res
    },
  }
}

test('recursive remove completes at the exact entry limit, including nested directories and the root', async () => {
  const { fs, sftp, calls } = inMemorySftp({ '/project/tree/nested/file.txt': 'contents' })
  assert.deepEqual(await removeRemoteTree(sftp, dir, 3), { removed: 3, failed: 0, limited: false, error: null })
  assert.deepEqual(calls, [
    ['readdir', dir], ['readdir', dir + '/nested'], ['unlink', dir + '/nested/file.txt'],
    ['rmdir', dir + '/nested'], ['rmdir', dir],
  ])
  assert.equal(fs.has(dir), false)
})

test('recursive remove skips unfinished directories and siblings at the limit without counting failures', async () => {
  const { fs, sftp, calls } = inMemorySftp({
    '/project/tree/nested/first.txt': 'first',
    '/project/tree/nested/second.txt': 'second',
    '/project/tree/later.txt': 'later',
  })
  const result = await removeRemoteTree(sftp, dir, 3)
  assert.deepEqual(result, {
    removed: 1, failed: 0, limited: true,
    error: 'incomplete removal of /project/tree after removing 1 entry. reached the 3-entry limit',
  })
  assert.deepEqual(calls, [['readdir', dir], ['readdir', dir + '/nested'], ['unlink', dir + '/nested/first.txt']])
  assert.equal(fs.has(dir + '/nested/first.txt'), false)
  assert.equal(fs.has(dir + '/nested/second.txt'), true)
  assert.equal(fs.has(dir + '/later.txt'), true)
})

test('recursive remove counts SFTP failures once and still removes independent entries', async () => {
  const { fs, sftp, calls } = inMemorySftp({
    '/project/tree/blocked/file.txt': 'unreadable',
    '/project/tree/locked.txt': 'locked',
    '/project/tree/retained/file.txt': 'removable',
    '/project/tree/healthy.txt': 'removable',
  }, { '/project/tree/blocked': 'readdir', '/project/tree/locked.txt': 'unlink', '/project/tree/retained': 'rmdir' })
  const result = await removeRemoteTree(sftp, dir)
  assert.equal(result.removed, 2)
  assert.equal(result.failed, 3)
  assert.equal(result.limited, false)
  assert.match(result.error, /3 SFTP operation.*readdir.*permission denied/)
  assert.deepEqual(calls.filter(([op]) => op === 'rmdir'), [['rmdir', dir + '/retained']])
  assert.equal(fs.has(dir + '/healthy.txt'), false)
  assert.equal(fs.has(dir + '/retained'), true)
})

test('/fs reports and audits an incomplete remote removal, and signals partial mutations', async () => {
  const { sftp, fs, calls } = inMemorySftp({
    '/project/tree/locked.txt': 'locked', '/project/tree/healthy.txt': 'removable',
  }, { '/project/tree/locked.txt': 'unlink' })
  const f = httpRemove(sftp)
  const { status, body } = await f.remove(dir)
  assert.equal(status, 500)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'REMOTE_REMOVE_INCOMPLETE')
  assert.equal(body.removed, 1)
  assert.equal(body.failed, 1)
  assert.equal(body.limited, false)
  assert.match(body.error, /incomplete removal.*locked.txt.*permission denied/)
  assert.deepEqual(f.audit, [['remove', body.error, 1, f.binding]])
  assert.equal(f.mutations, 1)
  assert.deepEqual(calls[0], ['lstat', dir])
  assert.equal(fs.has(dir + '/locked.txt'), true)
  assert.equal(fs.has(dir + '/healthy.txt'), false)
})

test('/fs stops a remote removal at the production entry cap', async () => {
  const files = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [dir + '/file-' + i, 'contents']))
  const { sftp, fs, calls } = inMemorySftp(files)
  const f = httpRemove(sftp)
  const { status, body } = await f.remove(dir)
  assert.equal(status, 409)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'REMOTE_REMOVE_INCOMPLETE')
  assert.equal(body.removed, 1999)
  assert.equal(body.failed, 0)
  assert.equal(body.limited, true)
  assert.match(body.error, /2000-entry limit/)
  assert.deepEqual(f.audit, [['remove', body.error, 1, f.binding]])
  assert.equal(f.mutations, 1)
  assert.equal(calls.filter(([op]) => op === 'unlink' || op === 'rmdir').length, 1999)
  assert.deepEqual(fs.list(dir).map(entry => entry.filename), ['file-1999'])

  const retry = await f.remove(dir)
  assert.deepEqual(retry, { status: 200, body: { ok: true } })
  assert.deepEqual(f.audit[1], ['remove', 'remove ' + dir, 0, f.binding])
  assert.equal(fs.has(dir), false)
})

test('the explorer refreshes an expanded directory and keeps the incomplete removal message visible', async t => {
  const { sftp, fs } = inMemorySftp({
    '/project/tree/locked.txt': 'locked', '/project/tree/healthy.txt': 'removable',
  }, { '/project/tree/locked.txt': 'unlink' })
  const f = httpRemove(sftp)
  const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
  const ui = mountClient({ withHostChrome: true, fetch: async (url, opts) => {
    const { pathname, searchParams } = new URL(url, 'http://localhost')
    if (pathname === '/dsh-remote/resolve-mirror') return reply({ remotePath: '/project' })
    if (pathname === '/dsh-remote/status') return reply({ connected: true })
    if (pathname === '/dsh-remote/fs') {
      const { status, body } = await f.remove(JSON.parse(opts.body).path)
      return reply(body, status)
    }
    if (pathname === '/dsh-remote/ls') {
      const path = searchParams.get('path')
      const items = fs.list(path).map(({ filename, entry }) => ({ name: filename, type: entry.type }))
      return reply({ path, items })
    }
    return reply({})
  } })
  t.after(() => ui.dispose())
  const explorer = ui.body('dsh-remote/explorer')
  const props = { sessionId: 'remove', useTabInfo: () => ({ tab: { visible: true, actions: {} } }) }
  const wrapper = await ui.settleComponent(p => ui.React.createElement('div', null, explorer(p)), props)
  const panel = ui.components(wrapper).find(c => c.type.name === 'RemoteExplorerTab')
  ui.resetState()
  const render = () => ui.settleComponent(panel.type, { ...panel.props, expanded: [dir] })
  let tree = await render()
  assert.match(ui.textOf(tree), /healthy\.txt/)
  const row = ui.elements(tree).find(e => e.props['data-rw-tree-row'] === dir)
  row.props.onContextMenu({ clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} })
  tree = await render()
  ui.elements(tree).find(e => typeof e.props.getAnchorRect === 'function').props.onSelect('delete')
  tree = await render()
  ui.components(tree).find(c => c.type.name === 'ConfirmDialog').props.onAnswer(true)
  await ui.tick()
  tree = await render()
  assert.match(ui.textOf(tree), /incomplete removal.*after removing 1 entry/)
  assert.match(ui.textOf(tree), /locked\.txt/)
  assert.doesNotMatch(ui.textOf(tree), /healthy\.txt/)
})

test('rw_remove reports and audits failed removal and successful retry separately', async t => {
  const fs = new FakeFs({ '/project/tree/nested/file.txt': 'removable' })
  const rmdir = fs.rmdir.bind(fs)
  fs.rmdir = path => {
    if (path === dir + '/nested') throw new Error('permission denied')
    return rmdir(path)
  }
  const srv = await startFakeSsh({ filesystem: fs, cwd: '/project' })
  t.after(() => srv.close())
  const host = await createHost({ config: { ...srv.machine({ workspace: '/project' }), auditLog: true } })
  t.after(() => host.dispose())
  const args = { path: dir, recursive: true }
  const result = await host.run('rw_remove', args)
  assert.equal(result.ok, false)
  assert.match(result.text, /incomplete removal.*after removing 1 entry.*rmdir.*nested/)
  assert.equal(fs.has(dir + '/nested/file.txt'), false)
  assert.equal(fs.has(dir + '/nested'), true)

  fs.rmdir = rmdir
  assert.deepEqual(await host.run('rw_remove', args), { ok: true, text: 'removed 2 entries under ' + dir })
  assert.equal(fs.has(dir), false)
  const audit = await host.call('/dsh-remote/audit', { method: 'GET' })
  const removal = audit.json.lines.filter(line => line.includes(' | remove | '))
  assert.deepEqual(removal.map(line => line.split(' | ').slice(2)), [
    ['remove', '1', result.text], ['remove', '0', 'remove -r ' + dir],
  ])
})
