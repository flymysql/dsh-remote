import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { SshPool } from '../lib/pool.js'
import { startFakeSsh } from './harness/fake-ssh.js'

async function front(t, handler) {
  const sockets = new Set()
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); handler(socket, sockets) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  return server.address().port
}
const config = port => ({ host: '127.0.0.1', port, username: 'root', password: 'test', hostKeyMode: 'off', connectTimeoutMs: 1500, commandTimeoutMs: 1500 })

test('a server that drops the first pre-auth connection recovers once; concurrent callers share the retry', async t => {
  const ssh = await startFakeSsh({ users: {}, silent: true }); t.after(() => ssh.close())
  let connections = 0
  const port = await front(t, (socket, sockets) => {
    if (++connections === 1) { socket.destroy(); return }
    const upstream = net.connect(ssh.port, '127.0.0.1'); sockets.add(upstream)
    upstream.on('error', () => socket.destroy()); upstream.on('close', () => sockets.delete(upstream)); socket.on('close', () => upstream.destroy())
    socket.pipe(upstream).pipe(socket)
  })
  const pool = new SshPool(config(port)); t.after(() => pool.close())
  const [a, b] = await Promise.all([pool.connect(), pool.connect()])
  assert.equal(a, b); assert.equal(connections, 2)
  assert.equal(await pool.connect(), a); assert.equal(connections, 2)
})

test('persistent pre-auth drops stop after two attempts instead of retrying indefinitely', async t => {
  let connections = 0
  const port = await front(t, socket => { connections++; socket.destroy() })
  const pool = new SshPool(config(port)); t.after(() => pool.close())
  await assert.rejects(pool.connect(), e => e.code === 'SSH_HANDSHAKE_CLOSED' && /Connection lost before handshake|ssh connection closed|read ECONNRESET/i.test(e.cause?.message || ''))
  assert.equal(connections, 2); assert.equal(pool.connecting, null); assert.equal(pool._connectingClient, null)
})

test('closing the pool during backoff cancels redial', async t => {
  let connections = 0, pool
  const port = await front(t, socket => { connections++; socket.destroy(); setTimeout(() => pool.close(), 50) })
  pool = new SshPool(config(port)); t.after(() => pool.close())
  await assert.rejects(pool.connect(), /target changed|connection|握手/i)
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(connections, 1)
})

test('bad authentication does not retry or open a second connection', async t => {
  const ssh = await startFakeSsh({ users: { root: 'correct' }, silent: true }); t.after(() => ssh.close())
  let attempts = 0
  const pool = new SshPool({ ...config(ssh.port), password: 'wrong' }); t.after(() => pool.close())
  const original = pool._doConnect.bind(pool)
  pool._doConnect = epoch => { attempts++; return original(epoch) }
  await assert.rejects(pool.connect(), /认证失败|authentication/i)
  assert.equal(attempts, 1)
})

test('algorithm and host-key failures do not trigger pre-auth retries', async t => {
  for (const message of ['Handshake failed: no matching key exchange algorithm', 'host key fingerprint mismatch']) {
    const pool = new SshPool(config(22)); let attempts = 0; t.after(() => pool.close())
    pool._doConnect = async () => { attempts++; throw new Error(message) }
    await assert.rejects(pool.connect(), message.includes('Handshake') ? /Handshake/ : /host key/)
    assert.equal(attempts, 1)
  }
})
