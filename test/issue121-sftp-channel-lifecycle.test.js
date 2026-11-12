// Issue #121 — successful native SFTP calls must not accumulate SSH channels.
// These tests pin both the real ssh2 behaviour and the pool's cache lifecycle.
// Several assertions are deliberate negative controls: the old pool fails them
// by opening another channel, retaining a late channel, or caching a dead one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { SshPool } from '../lib/pool.js'
import { startFakeSsh } from './harness/fake-ssh.js'

const config = (over = {}) => ({
  host: 'example.internal',
  port: 22,
  username: 'root',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  hostKeyMode: 'off',
  commandTimeoutMs: 50,
  connectTimeoutMs: 1000,
  maxOutputChars: 10000,
  ...over,
})

function fakeClient({ openDelay = 0, openError = '' } = {}) {
  const client = new EventEmitter()
  client.openCalls = 0
  client.endCalls = 0
  client.raws = []
  client.openDelay = openDelay
  client.openError = openError
  client.wedgeStat = false
  client.sftp = (cb) => {
    client.openCalls++
    setTimeout(() => {
      if (client.openError) return cb(new Error(client.openError))
      const raw = new EventEmitter()
      raw.endCalls = 0
      raw.statCalls = []
      raw.stat = (p, statCb) => {
        raw.statCalls.push(p)
        if (client.wedgeStat) return
        statCb(null, { size: p.length, path: p })
      }
      raw.end = () => {
        raw.endCalls++
        raw.emit('close')
      }
      client.raws.push(raw)
      cb(null, raw)
    }, client.openDelay)
  }
  client.end = () => {
    client.endCalls++
    for (const raw of client.raws) raw.emit('close')
  }
  return client
}

function fakePool(clients, over = {}) {
  const pool = new SshPool(config(over))
  let connects = 0
  pool.connect = async () => {
    if (pool.client) return pool.client
    assert.ok(connects < clients.length, 'no unexpected extra reconnect')
    const client = clients[connects++]
    pool.client = client
    return client
  }
  return { pool, connects: () => connects }
}

test('#121: real ssh2 keeps one channel across 12 sequential and 20 concurrent calls', async (t) => {
  const tree = { '/home/user/a.txt': 'hello' }
  for (let i = 0; i < 20; i++) tree[`/home/user/${i}`] = 'x'.repeat(i + 1)
  const srv = await startFakeSsh({ fs: tree, silent: true })
  const pool = new SshPool(config({ host: '127.0.0.1', port: srv.port, password: 'pw', commandTimeoutMs: 3000 }))
  t.after(async () => { pool.close(); await srv.close() })

  const client = await pool.connect()
  const surfaces = []
  for (let i = 0; i < 12; i++) {
    const surface = await pool.sftp()
    surfaces.push(surface)
    assert.equal((await surface.stat('/home/user/a.txt')).size, 5)
    // NEGATIVE CONTROL: the old pool reports i + 1 here.
    assert.equal(client._chanMgr._count, 1, `call ${i + 1} must reuse the channel`)
    assert.equal(pool.epoch, 0, 'no reconnect/invalidation may hide the leak')
  }
  assert.ok(surfaces.every((s) => s === surfaces[0]), 'all callers receive the cached surface')

  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    surfaces[0].stat(`/home/user/${i}`)))
  assert.deepEqual(results.map((s) => s.size), Array.from({ length: 20 }, (_, i) => i + 1))
  assert.equal(client._chanMgr._count, 1, 'concurrent requests share without opening more channels')
  assert.strictEqual(pool.client, client)
  assert.equal(pool.epoch, 0)
})

test('#121: concurrent opens share a promise; close reopens and stale close cannot evict it', async (t) => {
  const client = fakeClient()
  const { pool } = fakePool([client])
  t.after(() => pool.close())

  const [first, concurrent] = await Promise.all([pool.sftp(), pool.sftp()])
  assert.strictEqual(first, concurrent)
  assert.strictEqual(await pool.sftp(), first)
  assert.equal(client.openCalls, 1)

  const firstRaw = client.raws[0]
  firstRaw.emit('close')
  const second = await pool.sftp()
  const secondRaw = client.raws[1]
  assert.notStrictEqual(second, first)
  assert.equal(client.openCalls, 2)
  assert.strictEqual(pool._sftpRaw, secondRaw)

  firstRaw.emit('close')
  assert.strictEqual(pool._sftpRaw, secondRaw)
  assert.strictEqual(await pool.sftp(), second)
})

test('#121: an operation timeout closes and forgets the cached channel', async (t) => {
  const client = fakeClient()
  const { pool } = fakePool([client], { commandTimeoutMs: 20 })
  t.after(() => pool.close())

  client.wedgeStat = true
  const first = await pool.sftp()
  const firstRaw = client.raws[0]
  await assert.rejects(() => first.stat('/wedged'), /sftp operation timed out/)
  assert.equal(firstRaw.endCalls, 1)
  assert.equal(pool._sftpSession, null)
  assert.equal(pool._sftpRaw, null)

  client.wedgeStat = false
  const second = await pool.sftp()
  assert.notStrictEqual(second, first)
  assert.equal(client.openCalls, 2)
  assert.equal((await second.stat('/ok')).path, '/ok')
  assert.equal(pool._sftpTimeouts, 0, 'a healthy reopen resets the strike counter')
})

test('#121: invalidate and close end their own raw channel and clear all cache state', async (t) => {
  const firstClient = fakeClient()
  const secondClient = fakeClient()
  const { pool } = fakePool([firstClient, secondClient])
  t.after(() => pool.close())

  const first = await pool.sftp()
  const firstRaw = firstClient.raws[0]
  pool.invalidate()
  assert.equal(pool.epoch, 1)
  assert.equal(firstRaw.endCalls, 1)
  assert.equal(firstClient.endCalls, 1)
  assert.equal(pool._sftpSession, null)
  assert.equal(pool._sftpRaw, null)
  assert.equal(pool._sftpClient, null)

  const second = await pool.sftp()
  const secondRaw = secondClient.raws[0]
  assert.notStrictEqual(second, first)
  firstRaw.emit('close')
  assert.strictEqual(pool._sftpRaw, secondRaw)
  assert.strictEqual(pool._sftpClient, secondClient)

  pool.close()
  assert.equal(pool.epoch, 2)
  assert.equal(secondRaw.endCalls, 1)
  assert.equal(secondClient.endCalls, 1)
  assert.equal(pool._sftpSession, null)
  assert.equal(pool._sftpRaw, null)
  assert.equal(pool._sftpClient, null)
})

test('#121: a late successful open after the watchdog is closed and never cached', async (t) => {
  const client = fakeClient({ openDelay: 50 })
  const { pool } = fakePool([client], { commandTimeoutMs: 20 })
  t.after(() => pool.close())

  await assert.rejects(() => pool.sftp(), /ssh sftp open timed out/)
  await new Promise((resolve) => setTimeout(resolve, 70))
  assert.equal(client.openCalls, 1)
  assert.equal(client.raws.length, 1)
  // NEGATIVE CONTROL: the old `if (timedOut) return` leaves endCalls === 0.
  assert.equal(client.raws[0].endCalls, 1)
  assert.equal(pool._sftpSession, null)
  assert.equal(pool._sftpRaw, null)
  assert.equal(pool._sftpClient, null)
})

test('#121: channel-open failure reconnects exactly once and caches only the fresh client', async (t) => {
  const stale = fakeClient({ openError: 'Channel open failure: open failed' })
  const fresh = fakeClient()
  const { pool, connects } = fakePool([stale, fresh])
  t.after(() => pool.close())

  const surface = await pool.sftp()
  assert.equal(connects(), 2)
  assert.equal(stale.endCalls, 1)
  assert.equal(fresh.openCalls, 1)
  assert.equal(pool.epoch, 1)
  assert.strictEqual(pool._sftpClient, fresh)
  assert.strictEqual(pool._sftpRaw, fresh.raws[0])
  assert.strictEqual(await pool.sftp(), surface)
})

test('#121: a second channel-open failure rejects instead of reconnecting forever', async (t) => {
  const stale = fakeClient({ openError: 'Channel open failure: open failed' })
  const alsoStale = fakeClient({ openError: 'Channel open failure: open failed' })
  const { pool, connects } = fakePool([stale, alsoStale])
  t.after(() => pool.close())

  await assert.rejects(() => pool.sftp(), /ssh sftp failed: Channel open failure/)
  assert.equal(connects(), 2)
  assert.equal(pool.epoch, 1)
  assert.equal(pool._sftpSession, null)
  assert.equal(pool._sftpRaw, null)
})

test('#121: a reconnect-stage failure retains its error context and settles the cache', async (t) => {
  const stale = fakeClient({ openError: 'Channel open failure: open failed' })
  const pool = new SshPool(config())
  let connects = 0
  pool.connect = async () => {
    connects++
    if (connects === 1) {
      pool.client = stale
      return stale
    }
    throw new Error('dial failed')
  }
  t.after(() => pool.close())

  await assert.rejects(() => pool.sftp(), /ssh sftp failed \(reconnect\): dial failed/)
  assert.equal(connects, 2)
  assert.equal(pool.epoch, 1)
  assert.equal(pool._sftpSession, null)
  assert.equal(pool._sftpRaw, null)
  assert.equal(pool._sftpClient, null)
})

test('#121: a rejected open is not cached and an invalidated pending open cannot be adopted', async (t) => {
  await t.test('ordinary rejection permits a later successful open', async () => {
    const client = fakeClient({ openError: 'permission denied' })
    const { pool } = fakePool([client])
    t.after(() => pool.close())
    await assert.rejects(() => pool.sftp(), /permission denied/)
    assert.equal(pool._sftpSession, null)
    client.openError = ''
    const surface = await pool.sftp()
    assert.ok(surface)
    assert.equal(client.openCalls, 2)
    assert.equal(pool.epoch, 0)
  })

  await t.test('invalidating during open closes the stale late success', async () => {
    const client = fakeClient({ openDelay: 30 })
    const { pool } = fakePool([client], { commandTimeoutMs: 100 })
    t.after(() => pool.close())
    const opening = pool.sftp()
    pool.invalidate()
    await assert.rejects(() => opening, /ssh target changed while opening sftp/)
    assert.equal(client.raws[0].endCalls, 1)
    assert.equal(pool._sftpSession, null)
    assert.equal(pool._sftpRaw, null)
    assert.equal(pool._sftpClient, null)
  })
})
