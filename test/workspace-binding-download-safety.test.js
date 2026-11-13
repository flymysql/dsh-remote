import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { requestSessionHint } from '../lib/binding.js'
import { createFsRoutes, mirrorDownloadTarget } from '../lib/routes-fs.js'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

test('query session hints decode once and JSON hints retain literal percent sequences', () => {
  for (const value of ['100%repo', '%2F', '中文%名字', 'C:\\work\\100%repo']) {
    const expected = { sessionId: value, local: value }
    assert.deepEqual(requestSessionHint({ url: '/?sessionId=' + encodeURIComponent(value) + '&local=' + encodeURIComponent(value) }), expected)
    assert.deepEqual(requestSessionHint({ url: '/' }, expected), expected)
  }
})

test('download targets use remote and local path grammars with separator-aware boundaries', () => {
  assert.equal(mirrorDownloadTarget('/mirror', '/project', '/project/src/中文%文件.js', path.posix), '/mirror/src/中文%文件.js')
  assert.equal(mirrorDownloadTarget('C:\\mirror', '/project', '/project/src/file.js', path.win32), 'C:\\mirror\\src\\file.js')
  assert.equal(mirrorDownloadTarget('/mirror', 'D:\\project', 'D:\\project\\src\\file.js', path.posix), '/mirror/src/file.js')
  assert.equal(mirrorDownloadTarget('C:\\mirror', 'D:\\project', 'd:/project/src/file.js', path.win32), 'C:\\mirror\\src\\file.js')
  for (const remote of ['/project-other/file', '/project/../victim', '/elsewhere/file', '/project']) {
    assert.throws(() => mirrorDownloadTarget('/mirror', '/project', remote, path.posix), error => error.httpStatus === 403)
  }
  assert.throws(() => mirrorDownloadTarget('C:\\mirror', 'D:\\project', 'E:\\file', path.win32), error => error.httpStatus === 403)
})

test('Windows downloads reject remote names that could redirect or alias local files', () => {
  for (const name of ['..\\..\\victim', 'src\\file', 'file:stream', 'NUL', 'COM1.txt', 'file.', 'file ', 'a?b']) {
    assert.throws(() => mirrorDownloadTarget('C:\\Users\\owner\\mirror', '/project', '/project/' + name, path.win32), error => error.httpStatus === 403, name)
  }
  for (const localPath of [path.posix, path.win32]) {
    assert.throws(() => mirrorDownloadTarget(localPath.resolve('/mirror'), '/project', '/project/.dsh-remote-meta.json', localPath), error => error.httpStatus === 403)
  }
  assert.throws(() => mirrorDownloadTarget('C:\\mirror', '/project', '/project/.DSH-REMOTE-META.JSON', path.win32), error => error.httpStatus === 403)
})

function downloadFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-download-safe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const mirror = path.join(root, 'mirror')
  mkdirSync(mirror)
  let downloads = 0
  const sftp = {
    stat: async () => ({ size: 4, isDirectory: () => false }),
    fastGet: async (_remote, local) => { downloads++; writeFileSync(local, 'safe') },
  }
  const route = createFsRoutes({
    sendJson: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async req => JSON.stringify(req.body),
    resolveRequestBinding: async () => ({ bound: true, ws: '/project', mirrorDir: mirror, pool: { sftp: async () => sftp } }),
    audit: () => {}, config: { maxFileBytes: 1024 },
  }).find(route => route.path === '/dsh-remote/fs')
  const call = async remote => {
    const res = {}
    await route.handler({ method: 'POST', url: route.path, body: { op: 'download', path: remote } }, res)
    return res
  }
  return { root, mirror, sftp, call, downloads: () => downloads }
}

test('downloads reject existing local file and directory symlinks without touching their targets', async t => {
  const f = downloadFixture(t), outside = path.join(f.root, 'outside')
  mkdirSync(outside); writeFileSync(path.join(outside, 'victim'), 'original')
  symlinkSync(outside, path.join(f.mirror, 'link'), 'dir')
  symlinkSync(path.join(outside, 'victim'), path.join(f.mirror, 'file-link'))
  assert.equal((await f.call('/project/link/victim')).status, 403)
  assert.equal((await f.call('/project/file-link')).status, 403)
  assert.equal(f.downloads(), 0)
  assert.equal(readFileSync(path.join(outside, 'victim'), 'utf8'), 'original')
  const good = await f.call('/project/new/file')
  assert.equal(good.status, 200)
  assert.equal(readFileSync(path.join(f.mirror, 'new', 'file'), 'utf8'), 'safe')
})

test('downloads surface permission errors and distinguish missing files and directory requests', async t => {
  const f = downloadFixture(t)
  f.sftp.stat = async () => { throw Object.assign(new Error('permission denied'), { code: 3 }) }
  const denied = await f.call('/project/file')
  assert.equal(denied.status, 500); assert.match(denied.body.error, /permission denied/)
  f.sftp.stat = async () => { throw Object.assign(new Error('no such file'), { code: 2 }) }
  assert.equal((await f.call('/project/file')).status, 404)
  f.sftp.stat = async () => ({ size: 0, isDirectory: () => true })
  assert.equal((await f.call('/project/folder')).status, 400)
  assert.equal(f.downloads(), 0)
})

test('real SSH percent-named mirrors keep local-only requests on their own host for reads, listings, and writes', async t => {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/project', fs: { '/project/file': 'bound host' } })
  let host
  try {
    const own = machine({ host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: '/project' })
    // The active host deliberately cannot be contacted. Losing local context
    // must fail this test rather than accidentally using the same machine.
    const decoy = machine({ host: '127.0.0.2', port: 1, username: 'root', workspace: '/other' })
    host = await createHost({ machines: [own, decoy], currentId: decoy.id })
    const hostRoot = path.join(host.home, 'remote-workspaces', 'percent-host')
    for (const name of ['100%repo', '%2F', '中文%名字']) {
      const mirror = path.join(hostRoot, name)
      mkdirSync(mirror, { recursive: true })
      writeFileSync(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify({ host: own.host, port: own.port, username: own.username, remotePath: '/project' }))
      const local = '&local=' + encodeURIComponent(mirror)
      const read = await host.call('/dsh-remote/read?path=%2Fproject%2Ffile' + local, { method: 'GET' })
      assert.equal(read.status, 200, read.raw); assert.equal(read.json.content, srv.fs.readText('/project/file'))
      const ls = await host.call('/dsh-remote/ls?path=%2Fproject' + local, { method: 'GET' })
      assert.equal(ls.status, 200, ls.raw); assert.deepEqual(ls.json.items.map(item => item.name), ['file'])
      const content = 'saved from ' + name
      const write = await host.call('/dsh-remote/write?local=' + encodeURIComponent(mirror), { body: { path: '/project/file', content } })
      assert.equal(write.status, 200, write.raw); assert.equal(srv.fs.readText('/project/file'), content)
      const posted = await host.call('/dsh-remote/read', { body: { path: '/project/file', local: mirror } })
      assert.equal(posted.status, 200, posted.raw); assert.equal(posted.json.content, content)
    }
  } finally { await host?.dispose(); await srv.close() }
})
