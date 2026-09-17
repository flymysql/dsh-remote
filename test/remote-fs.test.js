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
