// Regression test for rw_upload (0.8.10).
//
// Root cause of the reported bug ("ENOENT ... open 'C:\home\…'"): the
// tool called sftp.fastPut(remotePath, localPath) — swapped vs ssh2's real
// contract fastPut(LOCAL path, REMOTE path) — so ssh2 opened the REMOTE path
// as a Windows local file (resolving /home/… against the C: drive), even when
// localPath was perfectly valid.
//
// Hermetic: ssh2.Client is prototype-patched (connect/sftp/end), so the real
// plugin apply() + pool + SFTP wrapper run end-to-end without any network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import ssh2 from 'ssh2'
import { apply } from '../lib/index.js'

const recorded = { fastPut: [], mkdir: [] }

// Fake Client surface. Argument ORDER matters: this fake encodes ssh2's real
// contract — fastPut(localPath, remotePath).
ssh2.Client.prototype.connect = function () {
  const self = this
  setImmediate(() => self.emit('ready'))
}
ssh2.Client.prototype.end = function () {}
ssh2.Client.prototype.sftp = function (cb) {
  const sftp = {
    mkdir: (p, cb2) => { recorded.mkdir.push(p); cb2(null) },
    fastPut: (lp, p, cb2) => { recorded.fastPut.push([lp, p]); cb2(null) },
  }
  setImmediate(() => cb(null, sftp))
}

/** Boot the real plugin against a throwaway DSH_HOME and return rw_upload. */
async function setup(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-upload-test-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home
  const tools = {}
  await apply(
    {
      effect: () => {},
      get: () => undefined,
      systemPrompt: { section: () => {} },
      tools: { register: (tool) => { tools[tool.name] = tool } },
    },
    {
      host: '203.0.113.10', port: 22, username: 'tester', password: 'x',
      commandTimeoutMs: 5000, connectTimeoutMs: 5000,
    },
  )
  const upload = tools['rw_upload']
  assert.ok(upload, 'rw_upload is registered')
  recorded.fastPut.length = 0
  recorded.mkdir.length = 0
  return { upload }
}

test('rw_upload passes (localPath, remotePath) to fastPut — the C:\\home\\… ENOENT regression', async (t) => {
  const { upload } = await setup(t)
  const localFile = path.join(tmpdir(), `dsh-upload-src-${process.pid}.md`)
  writeFileSync(localFile, '# real local file')
  t.after(() => rmSync(localFile, { force: true }))
  recorded.fastPut.length = 0
  recorded.mkdir.length = 0

  const ws = '/home/user/data'
  const res = await upload.execute(
    { localPath: localFile, path: `${ws}/document.md` },
    {},
  )
  assert.equal(res.ok, true, 'upload succeeds')
  assert.equal(recorded.fastPut.length, 1, 'exactly one fastPut')
  const [argLocal, argRemote] = recorded.fastPut[0]
  assert.equal(argLocal, localFile, 'fastPut arg1 is the LOCAL file (was swapped → ENOENT)')
  assert.equal(argRemote, `${ws}/document.md`, 'fastPut arg2 is the REMOTE path')
  assert.ok(recorded.mkdir.includes(ws), 'remote parent dir created (not the file path)')
})

test('rw_upload still rejects a missing local file with the original error', async (t) => {
  const { upload } = await setup(t)
  const missing = path.join(tmpdir(), `dsh-upload-missing-${process.pid}.txt`)
  await assert.rejects(
    () => upload.execute({ localPath: missing, path: '/out/x.txt' }, {}),
    (err) => {
      assert.match(err.message, /local file not found/)
      assert.ok(err.message.includes(missing), 'error names the local path')
      return true
    },
  )
  assert.equal(recorded.fastPut.length, 0, 'no SFTP write attempted')
})
