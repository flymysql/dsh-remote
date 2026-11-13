import { test } from 'node:test'
import assert from 'node:assert/strict'
import { previewRemoteFile } from '../lib/remote-fs.js'
import { MemFs, makeSftp, seed } from './helpers.js'

test('previewRemoteFile uses readPartial for oversized files (never full readFile)', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/big.bin': 'x'.repeat(20000) })
  const sftp = makeSftp(fs)
  let readFileCalls = 0
  let partialCalls = 0
  const origRead = sftp.readFile
  sftp.readFile = (...args) => { readFileCalls++; return origRead(...args) }
  const origPartial = sftp.readPartial
  sftp.readPartial = (...args) => { partialCalls++; return origPartial(...args) }

  const r = await previewRemoteFile(sftp, '/proj/big.bin', { maxBytes: 1024 })
  assert.equal(r.ok, true)
  assert.equal(r.truncated, true)
  assert.equal(r.size, 20000)
  assert.ok(r.content.includes('truncated'))
  assert.equal(partialCalls, 1)
  assert.equal(readFileCalls, 0)
})

test('previewRemoteFile reports mtime for optimistic locks', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'hello' })
  const sftp = makeSftp(fs)
  const r = await previewRemoteFile(sftp, '/proj/a.txt', { maxBytes: 1024 })
  assert.equal(r.binary, false)
  assert.equal(r.content, 'hello')
  assert.equal(typeof r.mtime, 'number')
  assert.ok(r.mtime > 0)
})

test('previewRemoteFile renders images inline as base64, not as a binary stub (issue #66)', async () => {
  const fs = new MemFs()
  // A minimal PNG header contains NUL bytes, so looksBinary() must fire — the
  // image branch is what rescues it from the binary stub.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)])
  fs.writeFileSync('/proj/pic.png', png)
  const sftp = makeSftp(fs)
  const r = await previewRemoteFile(sftp, '/proj/pic.png', { maxBytes: 1024 })
  assert.equal(r.ok, true)
  assert.equal(r.binary, false, 'an image must not degrade to the download hint')
  assert.equal(r.image, true)
  assert.equal(r.mime, 'image/png')
  assert.equal(Buffer.from(r.content, 'base64').equals(png), true, 'the FULL file must come back, not the 4KB head')
})

test('previewRemoteFile keeps non-image binaries on the download-hint path', async () => {
  const fs = new MemFs()
  fs.writeFileSync('/proj/app.bin', Buffer.concat([Buffer.alloc(16, 0), Buffer.from('binary')]))
  const sftp = makeSftp(fs)
  const r = await previewRemoteFile(sftp, '/proj/app.bin', { maxBytes: 1024 })
  assert.equal(r.binary, true)
  assert.equal(r.image, undefined)
  assert.equal(typeof r.head, 'string')
})

test('previewRemoteFile reads an image whole past the text cap (issue #66), and degrades a >2MB one to the stub', async () => {
  const fs = new MemFs()
  // 5KB — over the caller's 1KB text cap. A prefix would be a broken render,
  // so the image branch must ignore that cap and return the file whole.
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), Buffer.alloc(5000, 3)])
  fs.writeFileSync('/proj/photo.jpg', jpg)
  const sftp = makeSftp(fs)
  const r = await previewRemoteFile(sftp, '/proj/photo.jpg', { maxBytes: 1024 })
  assert.equal(r.image, true)
  assert.equal(r.mime, 'image/jpeg')
  assert.equal(r.truncated, false)
  assert.equal(Buffer.from(r.content, 'base64').equals(jpg), true)

  // Past the hard 2MB ceiling a truncated image can only render broken — the
  // honest answer is the download-hint stub.
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), Buffer.alloc(2 * 1024 * 1024 + 10, 1)])
  fs.writeFileSync('/proj/huge.png', big)
  const r2 = await previewRemoteFile(sftp, '/proj/huge.png', { maxBytes: 1024 })
  assert.equal(r2.binary, true)
  assert.equal(r2.image, undefined)
  assert.equal(r2.truncated, true)
})

test('complete text previews report original EOL style while exposing normalized editor text', async () => {
  const fs = new MemFs(), sftp = makeSftp(fs)
  for (const [content, expected] of [
    ['first\r\nsecond\r\n', 'crlf'], ['first\nsecond\n', 'lf'],
    ['first\r\nsecond\n', 'mixed'], ['first\rsecond\r', 'mixed'],
    ['no newline', 'lf'], ['', 'lf'],
  ]) {
    fs.writeFileSync('/proj/eol.txt', Buffer.from(content))
    const result = await previewRemoteFile(sftp, '/proj/eol.txt')
    assert.equal(result.eol, expected, JSON.stringify(content))
    assert.equal(result.content, content.replace(/\r\n/g, '\n'))
  }
})

test('partial previews never infer whole-file EOL style from the visible prefix', async () => {
  const fs = new MemFs(), sftp = makeSftp(fs)
  fs.writeFileSync('/proj/mixed.txt', Buffer.from('first\r\n' + 'a'.repeat(1500) + '\nlast\n'))
  const result = await previewRemoteFile(sftp, '/proj/mixed.txt', { maxBytes: 1024 })
  assert.equal(result.truncated, true); assert.equal(result.eol, undefined); assert.equal(result.revision, undefined)
})
