// Desktop native file-tab contract: session-scoped addresses + save/reload/409.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { createFsRoutes } from '../lib/routes-fs.js'
import { MemFs, makeSftp, seed } from './helpers.js'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function sendJson(res, status, body) {
  res.statusCode = status
  res.payload = JSON.stringify(body)
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

async function call(route, { method = 'POST', url, body }) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from([Buffer.from(payload)])
  req.method = method
  req.url = url || route.path
  const res = { statusCode: 0, payload: '', setHeader() {}, end(chunk) { this.payload += chunk == null ? '' : String(chunk) } }
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.payload || 'null') }
}

function routesFor(sftp, binding) {
  const pool = {
    platform: 'posix',
    config: { commandTimeoutMs: 5000, encoding: 'utf-8' },
    detect: async () => {},
    sftp: async () => sftp,
  }
  const list = createFsRoutes({
    sendJson,
    readBody,
    resolveRequestBinding: async () => ({ ...binding, pool }),
    decodeBuf: (buf) => buf.toString('utf8'),
    encodeText: (s) => Buffer.from(String(s), 'utf8'),
    audit: () => {},
    config: { encoding: 'utf-8', maxFileBytes: 0 },
    mirrorDirFor: () => '/tmp/mirror',
  })
  return Object.fromEntries(list.map((r) => [r.path, r]))
}

test('native resource addresses are session-scoped', () => {
  assert.match(src, /dsh-resource:\/\/dsh-remote\/' \+ encodeURIComponent\(sessionId\)/)
  assert.match(src, /withSessionBody\(\{ path, content: draft/)
  assert.match(src, /expectedMtime: data && data.mtime/)
  assert.match(src, /withSessionQuery\('\/dsh-remote\/ls\?path='/)
  assert.match(src, /withSessionQuery\('\/dsh-remote\/status'/)
  assert.match(src, /scope: \{ sessionId: props\.sessionId \}/)
})

test('sidebar write 409 on mtime mismatch, then save after re-read (Desktop edit path)', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'v1' })
  const sftp = makeSftp(fs)
  const binding = { ws: '/proj', host: '10.0.0.1', username: 'dev', port: 22, bound: true, mirrorDir: '/tmp/m' }
  const routes = routesFor(sftp, binding)

  const first = await call(routes['/dsh-remote/read'], { body: { path: '/proj/a.txt', sessionId: 's1' } })
  assert.equal(first.status, 200)
  assert.equal(first.json.content, 'v1')
  const mtime = first.json.mtime

  fs.writeFileSync('/proj/a.txt', 'v2-remote')
  const conflict = await call(routes['/dsh-remote/write'], {
    body: { path: '/proj/a.txt', content: 'v1-edited', expectedMtime: mtime, sessionId: 's1' },
  })
  assert.equal(conflict.status, 409)
  assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'v2-remote')

  const reread = await call(routes['/dsh-remote/read'], { body: { path: '/proj/a.txt', sessionId: 's1' } })
  const saved = await call(routes['/dsh-remote/write'], {
    body: { path: '/proj/a.txt', content: 'merged', expectedMtime: reread.json.mtime, sessionId: 's1' },
  })
  assert.equal(saved.status, 200)
  assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'merged')
})

test('sidebar /ls returns session-bound listing from the resolved pool', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/src/a.ts': 'x' })
  fs.mkdirSync('/proj')
  fs.mkdirSync('/proj/src')
  const sftp = makeSftp(fs)
  const routes = routesFor(sftp, { ws: '/proj', host: '10.0.0.1', username: 'dev', port: 22, bound: true })
  const r = await call(routes['/dsh-remote/ls'], { method: 'GET', url: '/dsh-remote/ls?path=/proj&sessionId=s1' })
  assert.equal(r.status, 200)
  assert.equal(r.json.bound, true)
  assert.ok(r.json.items.some((it) => it.name === 'src'))
})
