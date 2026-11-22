import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { requestThroughProxy, updateProxyFor } from '../lib/update.js'
import { key, cert } from './fixtures/update-proxy-tls.js'

async function listen(t, server) {
  const sockets = new Set()
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)) })
  return server.address().port
}
test('update proxy selection honors environment precedence and domain/port NO_PROXY', () => {
  const env = { HTTPS_PROXY: 'http://proxy.invalid:8080', NO_PROXY: '.example.com,localhost:9443' }
  assert.equal(updateProxyFor('https://registry.npmjs.org', env), env.HTTPS_PROXY)
  assert.equal(updateProxyFor('https://sub.example.com', env), '')
  assert.equal(updateProxyFor('https://badexample.com', env), env.HTTPS_PROXY)
  assert.equal(updateProxyFor('https://localhost:9443', env), '')
  assert.equal(updateProxyFor('https://localhost:8443', env), env.HTTPS_PROXY)
  assert.equal(updateProxyFor('https://registry.npmjs.org', { ...env, no_proxy: '*' }), '')
  assert.equal(updateProxyFor('https://registry.npmjs.org', { https_proxy: 'http://lowercase.invalid', HTTPS_PROXY: 'http://uppercase.invalid' }), 'http://lowercase.invalid')
})
test('HTTPS proxy CONNECT keeps certificate verification and proxy credentials out of the origin request', async t => {
  let connectTarget, proxyAuth, originAuth
  const origin = https.createServer({ key, cert }, (req, res) => { originAuth = req.headers['proxy-authorization']; if (req.url === '/stall') { res.writeHead(200); res.write('{'); return }; res.setHeader('content-type', 'application/json'); res.end('{"version":"1.3.0"}') })
  const targetPort = await listen(t, origin)
  const proxy = http.createServer()
  proxy.on('connect', (req, socket, head) => {
    connectTarget = req.url; proxyAuth = req.headers['proxy-authorization']
    const upstream = net.connect(targetPort, '127.0.0.1')
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
    upstream.once('connect', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); socket.pipe(upstream).pipe(socket) })
  })
  const proxyPort = await listen(t, proxy)
  const response = await requestThroughProxy('https://localhost:' + targetPort + '/latest', { ca: cert, signal: AbortSignal.timeout(3000) }, 'http://test-user:test-secret@127.0.0.1:' + proxyPort)
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { version: '1.3.0' })
  assert.equal(connectTarget, 'localhost:' + targetPort); assert.equal(proxyAuth, 'Basic ' + Buffer.from('test-user:test-secret').toString('base64')); assert.equal(originAuth, undefined)
  await assert.rejects(requestThroughProxy('https://localhost:' + targetPort + '/stall', { ca: cert, signal: AbortSignal.timeout(40) }, 'http://127.0.0.1:' + proxyPort), e => e.name === 'AbortError')
  await assert.rejects(requestThroughProxy('https://localhost:' + targetPort, { signal: AbortSignal.timeout(3000) }, 'http://127.0.0.1:' + proxyPort), /self-signed|certificate/i)
})
test('proxy policy rejection and a stalled CONNECT remain bounded and readable', async t => {
  const denied = http.createServer(); denied.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'))
  const port = await listen(t, denied)
  await assert.rejects(requestThroughProxy('https://example.invalid', { signal: AbortSignal.timeout(1000) }, 'http://127.0.0.1:' + port), /CONNECT returned HTTP 403/)
  const stalled = http.createServer(); stalled.on('connect', () => {})
  const blocked = await listen(t, stalled)
  await assert.rejects(requestThroughProxy('https://example.invalid', { signal: AbortSignal.timeout(40) }, 'http://127.0.0.1:' + blocked), e => e.name === 'AbortError')
})
