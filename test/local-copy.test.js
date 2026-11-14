import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { localCopyInfo, readLocalCopy, publishLocalCopy } from '../lib/local-copy.js'
import { remoteLocalMutationDecision } from '../lib/local-mutation.js'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-local-copy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const mirror = path.join(root, 'mirror'); mkdirSync(mirror)
  writeFileSync(path.join(mirror, 'page.html'), '<h1>中文鱼</h1>\r\n')
  const files = new Map()
  const absent = () => Object.assign(new Error('no such file'), { code: 2 })
  const sftp = {
    lstat: async name => name === '/project' ? { isDirectory: () => true, isSymbolicLink: () => false } : files.has(name) ? { isDirectory: () => false } : Promise.reject(absent()),
    mkdir: async () => {},
    createFileExclusive: async (name, bytes) => {
      if (files.has(name)) throw Object.assign(new Error('exists'), { code: 4, exclusiveOpenFailed: true })
      files.set(name, Buffer.from(bytes))
    },
  }
  const binding = { bound: true, ws: '/project', mirrorDir: mirror, host: 'bound-host', username: 'user', port: 22, pool: { sftp: async () => sftp } }
  return { root, mirror, binding, files, sftp }
}

test('local preview is explicit, read-only, complete UTF-8 text with a raw-byte revision', async t => {
  const f = fixture(t), target = '/project/page.html'
  const info = await localCopyInfo(f.binding, target)
  assert.equal(info.relativePath, 'page.html'); assert.equal(info.source, 'local-mirror')
  assert.equal(info.content, undefined)
  const { preview, bytes } = await readLocalCopy(f.binding, target)
  assert.equal(preview.source, 'local-mirror'); assert.equal(preview.readOnly, true)
  assert.equal(preview.content, '<h1>中文鱼</h1>\n'); assert.match(preview.localRevision, /^[a-f0-9]{64}$/)
  assert.equal(preview.binary, false); assert.equal(preview.image, false); assert.equal(preview.truncated, false)
  assert.ok(bytes.toString().endsWith('\r\n'))
  const published = await publishLocalCopy(f.binding, target, preview.localRevision)
  assert.equal(published.source, 'remote'); assert.deepEqual(f.files.get(target), bytes)
  await assert.rejects(publishLocalCopy(f.binding, target, preview.localRevision), error => error.code === 'REMOTE_FILE_EXISTS')
})

test('local recovery rejects links, boundaries, metadata, unsafe filenames and non-session requests', async t => {
  const f = fixture(t)
  writeFileSync(path.join(f.root, 'outside'), 'SECRET')
  symlinkSync(path.join(f.root, 'outside'), path.join(f.mirror, 'link'))
  for (const target of ['/project/link', '/project-other/outside', '/project/../outside', '/project/.dsh-remote-meta.json']) {
    assert.equal(await localCopyInfo(f.binding, target), null)
    await assert.rejects(readLocalCopy(f.binding, target))
  }
  await assert.rejects(readLocalCopy({ ...f.binding, bound: false }, '/project/page.html'), error => error.httpStatus === 403)
  assert.equal(readFileSync(path.join(f.root, 'outside'), 'utf8'), 'SECRET')
})

test('binary/image/non-UTF8 and oversized copies never become successful text previews', async t => {
  const f = fixture(t)
  for (const [name, bytes] of [['data.bin', Buffer.from([0, 1])], ['bad.txt', Buffer.from([0xff])], ['image.png', Buffer.from('not even an image')]]) {
    writeFileSync(path.join(f.mirror, name), bytes)
    await assert.rejects(readLocalCopy(f.binding, '/project/' + name), error => error.httpStatus === 415 && error.code === 'LOCAL_COPY_UNSUPPORTED')
  }
  await assert.rejects(readLocalCopy(f.binding, '/project/page.html', { maxFileBytes: 2 }), error => error.httpStatus === 413)
})

test('publish requires the preview revision and never overwrites raced or pre-existing remote files', async t => {
  const f = fixture(t), target = '/project/page.html'
  const { preview } = await readLocalCopy(f.binding, target)
  await assert.rejects(publishLocalCopy(f.binding, target), error => error.httpStatus === 400)
  writeFileSync(path.join(f.mirror, 'page.html'), 'changed')
  await assert.rejects(publishLocalCopy(f.binding, target, preview.localRevision), error => error.code === 'LOCAL_COPY_CHANGED')
  const current = (await readLocalCopy(f.binding, target)).preview.localRevision
  const exclusive = f.sftp.createFileExclusive
  f.sftp.createFileExclusive = async (...args) => { f.files.set(target, Buffer.from('RACED_REMOTE')); return exclusive(...args) }
  await assert.rejects(publishLocalCopy(f.binding, target, current), error => error.code === 'REMOTE_FILE_EXISTS')
  assert.equal(f.files.get(target).toString(), 'RACED_REMOTE')
})

test('permissions and incomplete uploads remain errors; remote symlink parents are refused', async t => {
  const f = fixture(t), target = '/project/page.html'
  const { preview } = await readLocalCopy(f.binding, target)
  f.sftp.createFileExclusive = async () => { throw Object.assign(new Error('permission denied'), { code: 3, exclusiveOpenFailed: true }) }
  await assert.rejects(publishLocalCopy(f.binding, target, preview.localRevision), /permission denied/)
  f.sftp.createFileExclusive = async () => { throw Object.assign(new Error('disk full'), { exclusiveFileCreated: true }) }
  await assert.rejects(publishLocalCopy(f.binding, target, preview.localRevision), error => error.code === 'LOCAL_COPY_UPLOAD_INCOMPLETE')
  const lstat = f.sftp.lstat
  f.sftp.lstat = async name => name === '/project' ? { isDirectory: () => true, isSymbolicLink: () => true } : lstat(name)
  await assert.rejects(publishLocalCopy(f.binding, target, preview.localRevision), error => error.code === 'LOCAL_COPY_UNSAFE_REMOTE_PATH')
})

test('native and nested mutation gates leave local sessions, view and run_code untouched', () => {
  for (const name of ['write', 'edit', 'str_replace_editor']) {
    assert.equal(remoteLocalMutationDecision({ name }, { bound: false }), null)
    for (const parent of [undefined, {}]) {
      const decision = remoteLocalMutationDecision({ name, parent, arguments: { command: 'create' } }, { bound: true })
      assert.equal(decision.kind, 'deny'); assert.match(decision.reason, /rw_write_file.*rw_edit/)
    }
  }
  assert.equal(remoteLocalMutationDecision({ name: 'str_replace_editor', arguments: { command: 'view' } }, { bound: true }), null)
  for (const name of ['run_code', 'bash', 'rw_write_file', 'read']) assert.equal(remoteLocalMutationDecision({ name }, { bound: true }), null)
})

test('a deleted registry machine does not make its recorded mirror a local write target', async () => {
  const host = await createHost()
  try {
    const mirror = path.join(host.root, 'deleted-machine', 'project'); mkdirSync(mirror, { recursive: true })
    writeFileSync(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify({ host: '127.0.0.1', port: 1, username: 'deleted', remotePath: '/project' }))
    const gate = host.listeners.get('tools/pre-execute')[0]
    let dispatched = false
    const result = await gate({ name: 'write', arguments: { file_path: 'page.html' }, agent: { session: { header: { cwd: mirror } } } }, async () => { dispatched = true; return { kind: 'allow' } })
    assert.equal(result.kind, 'deny'); assert.equal(dispatched, false)
  } finally { await host.dispose() }
})

test('real SSH routes report missing local copies explicitly; EXCL lets exactly one concurrent publish win and fences sessions', async t => {
  const server = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/project', fs: { '/project/exists': 'REMOTE' } })
  let host
  try {
    const record = machine({ host: '127.0.0.1', port: server.port, username: 'root', password: 'pw', workspace: '/project' })
    const sessions = new Map()
    let sandboxMode = 'workspace-write'
    host = await createHost({ machines: [record], currentId: record.id, services: { sessions: { get: id => sessions.get(id) }, sandboxPolicy: { resolve: () => ({ mode: sandboxMode }) } } })
    const mirror = path.join(host.root, 'own-host', 'project'); mkdirSync(mirror, { recursive: true })
    writeFileSync(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify({ host: record.host, port: record.port, username: record.username, remotePath: '/project' }))
    sessions.set('own', { header: { cwd: mirror } })
    writeFileSync(path.join(mirror, 'page.html'), '<h1>LOCAL_ONLY</h1>\r\n')
    const body = { sessionId: 'own', path: '/project/page.html' }
    const missing = await host.call('/dsh-remote/read', { body })
    assert.equal(missing.status, 404); assert.equal(missing.json.code, 'REMOTE_FILE_MISSING_LOCAL_COPY')
    assert.equal(missing.json.source, 'remote'); assert.equal(missing.json.content, undefined)
    assert.equal(missing.json.localCopy.relativePath, 'page.html')
    const preview = await host.call('/dsh-remote/local-copy/read', { body })
    assert.equal(preview.status, 200); assert.equal(preview.json.source, 'local-mirror')
    const result = await Promise.all([1, 2].map(() => host.call('/dsh-remote/local-copy/publish', { body: { ...body, expectedLocalRevision: preview.json.localRevision } })))
    assert.deepEqual(result.map(r => r.status).sort(), [200, 409])
    assert.equal(server.fs.readText('/project/page.html'), '<h1>LOCAL_ONLY</h1>\r\n')
    assert.equal((await host.call('/dsh-remote/read', { body })).json.content, '<h1>LOCAL_ONLY</h1>\n')
    for (const route of ['/dsh-remote/read', '/dsh-remote/local-copy/read', '/dsh-remote/local-copy/publish']) {
      assert.equal((await host.call(route, { body: { ...body, sessionId: 'expired' } })).status, 403)
      assert.equal((await host.call(route, { body: { ...body, local: path.join(host.root, 'other') } })).status, 403)
    }
    assert.equal((await host.call('/dsh-remote/local-copy/read', { body: { path: body.path } })).status, 403)
    writeFileSync(path.join(mirror, 'empty.txt'), '')
    const empty = await host.call('/dsh-remote/local-copy/read', { body: { ...body, path: '/project/empty.txt' } })
    const uploaded = await host.call('/dsh-remote/local-copy/publish', { body: { ...body, path: '/project/empty.txt', expectedLocalRevision: empty.json.localRevision } })
    assert.equal(uploaded.status, 200, uploaded.raw); assert.equal(server.fs.readText('/project/empty.txt'), '')
    // The sandbox and tool body must resolve paths into the same execution
    // world, including a native tool's local-mirror spelling after correction.
    const exec = { agent: { session: { header: { cwd: mirror } } } }
    const write = host.tool('rw_write_file')
    await write.execute({ path: 'sandbox-relative.html', content: 'RELATIVE_REMOTE' }, exec)
    await write.execute({ path: path.join(mirror, 'sandbox-mapped.html'), content: 'MAPPED_REMOTE' }, exec)
    assert.equal(server.fs.readText('/project/sandbox-relative.html'), 'RELATIVE_REMOTE')
    assert.equal(server.fs.readText('/project/sandbox-mapped.html'), 'MAPPED_REMOTE')
    for (const outside of ['../outside.html', '/outside.html']) await assert.rejects(write.execute({ path: outside, content: 'MUST_NOT_WRITE' }, exec), /workspace-write/)
    sandboxMode = 'read-only'
    await assert.rejects(write.execute({ path: 'read-only.html', content: 'MUST_NOT_WRITE' }, exec), /read-only/)
    assert.equal(server.fs.has('/outside.html'), false); assert.equal(server.fs.has('/project/read-only.html'), false)
  } finally { await host?.dispose(); await server.close() }
})
