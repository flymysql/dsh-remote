// The editor HTTP surface must protect the original, not merely report success.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFsRoutes } from '../lib/routes-fs.js'
import { captureRemoteFile, atomicRemoteWrite, remoteRevision } from '../lib/remote-write.js'

function fixture() {
  const files = new Map([['/project/main.js', Buffer.from('original')]])
  const links = new Map(), modes = new Map([['/project/main.js', 0o755]])
  const resolve = path => links.get(path) || path
  const missing = () => Object.assign(new Error('no such file'), { code: 2 })
  const sftp = {
    stat: async path => { const p = resolve(path); if (!files.has(p)) throw missing(); return { size: files.get(p).length, mtime: 10, mode: modes.get(p) ?? 0o644, isDirectory: () => false } },
    realpath: async path => resolve(path),
    readFile: async path => { const p = resolve(path); if (!files.has(p)) throw missing(); return Buffer.from(files.get(p)) },
    writeFile: async (path, value, opts) => { files.set(path, Buffer.from(value)); modes.set(path, opts?.mode ?? 0o644) },
    setstat: async (path, attrs) => modes.set(path, attrs.mode),
    renameOverwrite: async (from, to) => { files.set(to, files.get(from)); modes.set(to, modes.get(from)); files.delete(from); modes.delete(from) },
    rename: async (from, to) => { if (files.has(to) || links.has(to)) throw new Error('destination exists'); await sftp.renameOverwrite(from, to) },
    unlink: async path => { files.delete(path); modes.delete(path) },
  }
  const routes = createFsRoutes({
    sendJson: (res, status, body) => { res.status = status; res.body = body },
    readBody: async req => JSON.stringify(req.body || {}),
    resolveRequestBinding: async () => ({ pool: { sftp: async () => sftp }, ws: '/project', bound: true }),
    decodeBuf: value => value.toString('utf8'), encodeText: value => Buffer.from(value),
    audit: () => {}, config: { encoding: 'utf8', maxFileBytes: 1024 * 1024 }, mirrorDirFor: () => '/unused',
  })
  const call = async (route, body, method = 'POST') => {
    const res = {}, url = route.includes('?') ? route : route
    await routes.find(r => r.path === route.split('?')[0]).handler({ method, url, body }, res)
    return res
  }
  return { files, links, modes, sftp, call }
}

const read = f => f.call('/dsh-remote/read?path=%2Fproject%2Fmain.js', undefined, 'GET')

test('complete previews return raw-byte revisions; successful editor saves return the next revision', async () => {
  const f = fixture()
  f.files.set('/project/main.js', Buffer.from('first\r\nsecond\r\n'))
  const before = await read(f)
  assert.equal(before.status, 200); assert.equal(before.body.content, 'first\nsecond\n')
  assert.equal(before.body.revision, remoteRevision(Buffer.from('first\r\nsecond\r\n')))
  const result = await f.call('/dsh-remote/write', { path: '/project/main.js', content: 'changed\n', expectedRevision: before.body.revision, expectedMtime: before.body.mtime })
  assert.equal(result.status, 200); assert.equal(result.body.revision, remoteRevision(Buffer.from('changed\n')))
  assert.equal(f.files.get('/project/main.js').toString(), 'changed\n')
  assert.equal(f.modes.get('/project/main.js'), 0o755)
  assert.equal(f.files.size, 1)
})

test('same-size same-second external changes and deleted originals return 409 without replacing remote content', async () => {
  const f = fixture(), before = await read(f)
  f.files.set('/project/main.js', Buffer.from('external'))
  const conflict = await f.call('/dsh-remote/write', { path: '/project/main.js', content: 'mine', expectedRevision: before.body.revision, expectedMtime: before.body.mtime })
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'REMOTE_FILE_CONFLICT')
  assert.equal(f.files.get('/project/main.js').toString(), 'external')
  f.files.delete('/project/main.js')
  const missing = await f.call('/dsh-remote/write', { path: '/project/main.js', content: 'mine', expectedRevision: before.body.revision })
  assert.equal(missing.status, 409); assert.equal(f.files.has('/project/main.js'), false)
})

test('malformed baseline revisions are rejected and partial previews never offer a complete revision', async () => {
  const f = fixture()
  assert.equal((await f.call('/dsh-remote/write', { path: '/project/main.js', content: 'mine', expectedRevision: 'not-a-hash' })).status, 400)
  f.files.set('/project/main.js', Buffer.alloc(4096, 'a'))
  const result = await f.call('/dsh-remote/read?path=%2Fproject%2Fmain.js&maxBytes=1024', undefined, 'GET')
  assert.equal(result.body.truncated, true); assert.equal(result.body.revision, undefined)
})

test('editor and fs writes preserve the original on upload failure and refuse same-second races after staging', async () => {
  const f = fixture(), before = await read(f)
  const write = f.sftp.writeFile
  f.sftp.writeFile = async (path, bytes, options) => { await write(path, bytes.subarray(0, 2), options); throw new Error('upload interrupted') }
  const failed = await f.call('/dsh-remote/write', { path: '/project/main.js', content: 'changed', expectedRevision: before.body.revision })
  assert.equal(failed.status, 500); assert.equal(f.files.get('/project/main.js').toString(), 'original'); assert.equal(f.files.size, 1)
  f.sftp.writeFile = async (...args) => { await write(...args); f.files.set('/project/main.js', Buffer.from('external')) }
  const raced = await f.call('/dsh-remote/fs', { op: 'append', path: '/project/main.js', content: 'more' })
  assert.equal(raced.status, 409); assert.equal(f.files.get('/project/main.js').toString(), 'external'); assert.equal(f.files.size, 1)
})

test('append never interprets a permission failure as an absent file', async () => {
  const f = fixture(); let writes = 0
  f.sftp.stat = async () => { throw Object.assign(new Error('permission denied'), { code: 3 }) }
  f.sftp.writeFile = async () => { writes++ }
  const result = await f.call('/dsh-remote/fs', { op: 'append', path: '/project/main.js', content: 'mine' })
  assert.equal(result.status, 500); assert.match(result.body.error, /permission denied/)
  assert.equal(writes, 0); assert.equal(f.files.get('/project/main.js').toString(), 'original')
})

test('atomic saves retain symbolic links and reject retargeting during upload', async () => {
  const f = fixture(); f.links.set('/project/link.js', '/project/main.js')
  const snapshot = await captureRemoteFile(f.sftp, '/project/link.js')
  await atomicRemoteWrite(f.sftp, snapshot, Buffer.from('changed'))
  assert.equal(f.links.get('/project/link.js'), '/project/main.js')
  assert.equal(f.files.get('/project/main.js').toString(), 'changed'); assert.equal(f.files.has('/project/link.js'), false)
  f.files.set('/project/other.js', Buffer.from('changed'))
  const before = await captureRemoteFile(f.sftp, '/project/link.js')
  const write = f.sftp.writeFile
  f.sftp.writeFile = async (...args) => { await write(...args); f.links.set('/project/link.js', '/project/other.js') }
  await assert.rejects(atomicRemoteWrite(f.sftp, before, Buffer.from('mine')), error => error.code === 'REMOTE_FILE_CONFLICT')
  assert.equal(f.files.get('/project/main.js').toString(), 'changed'); assert.equal(f.files.get('/project/other.js').toString(), 'changed')
})

test('editing limits are checked before reading oversized content', async () => {
  const f = fixture(); let reads = 0
  f.sftp.stat = async () => ({ size: 9000000, mtime: 1 })
  f.sftp.readFile = async () => { reads++; return Buffer.alloc(9000000) }
  await assert.rejects(captureRemoteFile(f.sftp, '/project/main.js', { read: true, maxReadBytes: 1000 }), /size limit/)
  assert.equal(reads, 0)
})

test('capture uses a bounded range read and detects growth before staging a replacement', async () => {
  const f = fixture(); let fullReads = 0, requested = 0
  f.sftp.readFile = async () => { fullReads++; throw new Error('unbounded read is forbidden') }
  f.sftp.readPartial = async (_path, offset, length) => { assert.equal(offset, 0); requested = length; return Buffer.from('grew data') }
  await assert.rejects(captureRemoteFile(f.sftp, '/project/main.js', { read: true, maxReadBytes: 1024 }), error => error.code === 'REMOTE_FILE_CONFLICT')
  assert.equal(requested, Buffer.byteLength('original') + 1); assert.equal(fullReads, 0)
  assert.equal(f.files.get('/project/main.js').toString(), 'original')
})

test('commit rechecks captured bytes with a bounded read and rejects a same-size mutation', async () => {
  const f = fixture(), reads = []
  f.sftp.readFile = async () => { throw new Error('unbounded read is forbidden') }
  f.sftp.readPartial = async (path, offset, length) => { reads.push(length); return Buffer.from(f.files.get(path).subarray(offset, offset + length)) }
  const before = await captureRemoteFile(f.sftp, '/project/main.js', { read: true, maxReadBytes: 1024 })
  const write = f.sftp.writeFile
  f.sftp.writeFile = async (...args) => { await write(...args); f.files.set('/project/main.js', Buffer.from('external')) }
  await assert.rejects(atomicRemoteWrite(f.sftp, before, Buffer.from('mine')), error => error.code === 'REMOTE_FILE_CONFLICT')
  assert.deepEqual(reads, [9, 9]); assert.equal(f.files.get('/project/main.js').toString(), 'external'); assert.equal(f.files.size, 1)
})

test('a UTF-8 CRLF preview and save preserve raw bytes and compute the correct next revision', async () => {
  const f = fixture(), original = Buffer.from('第一行\r\nconst 名称 = "鱼";\r\n')
  f.files.set('/project/main.js', original)
  const before = await read(f)
  assert.equal(before.body.eol, 'crlf')
  assert.equal(before.body.revision, remoteRevision(original))
  assert.equal(before.body.content, '第一行\nconst 名称 = "鱼";\n')
  // The client owns restoring CRLF from the advertised style; the server
  // accepts the supplied content unchanged, including non-ASCII UTF-8 bytes.
  const submitted = before.body.content.replace('鱼', '大鱼').replace(/\r?\n/g, '\r\n')
  const saved = await f.call('/dsh-remote/write', { path: '/project/main.js', content: submitted, expectedRevision: before.body.revision })
  assert.equal(saved.status, 200)
  assert.deepEqual(f.files.get('/project/main.js'), Buffer.from('第一行\r\nconst 名称 = "大鱼";\r\n'))
  assert.equal(saved.body.revision, remoteRevision(Buffer.from(submitted)))
  const reopened = await read(f)
  assert.equal(reopened.body.eol, 'crlf'); assert.equal(reopened.body.revision, saved.body.revision)
})

test('the save endpoint never imposes a newline conversion on mixed or explicitly supplied text', async () => {
  const f = fixture(), submitted = 'first\r\nsecond\nthird\r'
  const saved = await f.call('/dsh-remote/write', { path: '/project/main.js', content: submitted })
  assert.equal(saved.status, 200); assert.equal(f.files.get('/project/main.js').toString(), submitted)
  assert.equal((await read(f)).body.eol, 'mixed')
})
