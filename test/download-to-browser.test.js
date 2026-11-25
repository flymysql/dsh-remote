// GET /dsh-remote/download — a file for the machine running the BROWSER.
//
// The explorer's "download" so far only ran `fs op=download`, which writes into
// the DSH host's local mirror. That is the wrong machine whenever the page is
// opened from another desktop: the bytes stay next to the harness and the user
// is handed a path they cannot open. This route answers the bytes themselves.
//
// The assertions below are about what a browser receives — the attachment name
// (ASCII + RFC 5987 for a non-ASCII one), the exact bytes, the size cap — and
// about the fence staying in place for a local workspace (a sibling project must
// not become downloadable just because it is a local path).
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Writable } from 'node:stream'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

const TREE = {
  '/home/user/README.md': '# hello\n',
  '/home/user/bin.dat': Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]),
  '/home/user/报告 2026.txt': '中文文件名\n',
  '/home/user/docs/a.txt': 'a\n',
}

/**
 * A response stand-in that behaves like `http.ServerResponse` for a stream:
 * header setters plus a real Writable, so backpressure and `end()` work.
 */
function browserResponse() {
  const chunks = []
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb() },
  })
  res.statusCode = 0
  res.headers = {}
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = String(v) }
  res.body = () => Buffer.concat(chunks)
  return res
}

/** Drive one route the way the webserver does, with a response we can read. */
async function download(host, { url, method = 'GET' }) {
  const route = host.routes.get('/dsh-remote/download')
  assert.ok(route, 'the plugin must register /dsh-remote/download')
  const { Readable } = await import('node:stream')
  const req = Readable.from([])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080' }
  const res = browserResponse()
  const finished = once(res, 'finish')
  await route.handler(req, res)
  await finished
  return res
}

async function withRemote(config, fn) {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: TREE, cwd: '/home/user' })
  const rec = machine({ host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: '/home/user' })
  const host = await createHost({ machines: [rec], config })
  try {
    const cur = await host.call('/dsh-remote/current', { body: { id: rec.id } })
    assert.equal(cur.json.ok, true, 'binding the machine must succeed')
    await fn({ host, srv, rec })
  } finally {
    await host.dispose()
    await srv.close()
  }
}

const q = (p) => '?path=' + encodeURIComponent(p)

test('streams a remote file to the browser with an attachment name and its real bytes', async () => {
  await withRemote({}, async ({ host }) => {
    const res = await download(host, { url: '/dsh-remote/download' + q('/home/user/README.md') })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'application/octet-stream')
    assert.equal(res.headers['content-disposition'], 'attachment; filename="README.md"; filename*=UTF-8\'\'README.md')
    assert.equal(res.headers['content-length'], '8')
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['x-dsh-download-name'], 'README.md')
    assert.equal(res.body().toString(), '# hello\n', 'the browser must receive the file, not a JSON path')
  })
})

test('binary content arrives byte-for-byte (no encoding pass)', async () => {
  await withRemote({}, async ({ host }) => {
    const res = await download(host, { url: '/dsh-remote/download' + q('/home/user/bin.dat') })
    assert.equal(res.statusCode, 200)
    assert.deepEqual([...res.body()], [0x00, 0x01, 0x02, 0xff, 0x00])
  })
})

test('a non-ASCII name survives in filename* and in X-Dsh-Download-Name', async () => {
  await withRemote({}, async ({ host }) => {
    const res = await download(host, { url: '/dsh-remote/download' + q('/home/user/报告 2026.txt') })
    assert.equal(res.statusCode, 200)
    const disposition = res.headers['content-disposition']
    assert.match(disposition, /^attachment; filename="[^"]+"/, 'an ASCII fallback is always present')
    assert.match(disposition, /filename\*=UTF-8''/, 'RFC 5987 carries the real name')
    assert.match(disposition, /%E6%8A%A5%E5%91%8A%202026\.txt$/, 'the UTF-8 name is percent-encoded')
    assert.equal(decodeURIComponent(res.headers['x-dsh-download-name']), '报告 2026.txt')
    assert.equal(res.body().toString(), '中文文件名\n')
  })
})

test('a folder, a missing file and an oversized file are refused in JSON, not as empty downloads', async () => {
  await withRemote({ maxFileBytes: 4 }, async ({ host }) => {
    const dir = await download(host, { url: '/dsh-remote/download' + q('/home/user/docs') })
    assert.equal(dir.statusCode, 400)
    assert.match(String(dir.body().toString()), /download requires a file/)

    const missing = await download(host, { url: '/dsh-remote/download' + q('/home/user/nope.txt') })
    assert.equal(missing.statusCode, 404)
    assert.match(String(missing.body()), /not found/)

    const big = await download(host, { url: '/dsh-remote/download' + q('/home/user/README.md') })
    assert.equal(big.statusCode, 400, 'maxFileBytes must be enforced here too, not only on the mirror path')
    assert.match(String(big.body()), /over 4 cap/)
  })
})

test('a missing path is a 400 and anything but GET is a 405', async () => {
  await withRemote({}, async ({ host }) => {
    const empty = await download(host, { url: '/dsh-remote/download' })
    assert.equal(empty.statusCode, 400)
    assert.match(String(empty.body()), /path is required/)

    const posted = await download(host, { url: '/dsh-remote/download' + q('/home/user/README.md'), method: 'POST' })
    assert.equal(posted.statusCode, 405)
    assert.match(String(posted.body()), /method not allowed/)
  })
})

test('with no machine bound the download explains the missing machine instead of failing silently', async () => {
  const host = await createHost()
  try {
    const res = await download(host, { url: '/dsh-remote/download' + q('/etc/hostname') })
    assert.notEqual(res.statusCode, 200)
    assert.ok(res.headers['content-type'].startsWith('application/json'), 'the failure must stay JSON')
    assert.match(String(res.body()), /没有活动远程机|machine/i)
  } finally {
    await host.dispose()
  }
})

test('a local workspace downloads its own files and refuses a sibling project', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-download-local-'))
  const mine = path.join(root, 'mine')
  const other = path.join(root, 'other')
  await fs.mkdir(mine)
  await fs.mkdir(other)
  await fs.writeFile(path.join(mine, 'main.js'), 'module.exports = 1\n')
  await fs.writeFile(path.join(other, 'secret.txt'), 'not yours')
  const sessions = { get: (id) => ({ a: { header: { cwd: mine } } })[id] }
  const host = await createHost({ services: { sessions } })
  try {
    const local = (p) => '/dsh-remote/download?' + new URLSearchParams({ path: p, sessionId: 'a', workspace: 'local' }).toString()
    const own = await download(host, { url: local(path.join(mine, 'main.js')) })
    assert.equal(own.statusCode, 200)
    assert.equal(own.body().toString(), 'module.exports = 1\n')
    assert.equal(own.headers['content-disposition'], 'attachment; filename="main.js"; filename*=UTF-8\'\'main.js')

    const sibling = await download(host, { url: local(path.join(other, 'secret.txt')) })
    assert.notEqual(sibling.statusCode, 200, 'the local-workspace fence must cover this route as well')
    assert.ok(!String(sibling.body()).includes('not yours'))
  } finally {
    await host.dispose()
    await fs.rm(root, { recursive: true, force: true })
  }
})
