import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { SshPool } from '../lib/pool.js'
import { loadSyncState, saveSyncState, syncTree, pushTree } from '../lib/sync.js'
import { MemFs, makeSftp, seed } from './helpers.js'
import { createHost } from './harness/plugin-host.js'

for (const tool of ['rw_sync', 'rw_push']) {
  test(tool + ' cancellation settles only started transfers and preserves their state', async (t) => {
    const pulling = tool === 'rw_sync'
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']
    const fs = new MemFs()
    seed(fs, Object.fromEntries(files.map((f) => ['/proj/' + f, 'remote'])))
    if (pulling) seed(fs, { '/proj/subdir/nested.txt': 'nested' })
    const base = makeSftp(fs)
    const transfer = pulling ? 'readFile' : 'writeFile'
    const preflightsStarted = Promise.withResolvers()
    const transferStarted = Promise.withResolvers()
    const finishPreflights = Promise.withResolvers()
    const finishTransfer = Promise.withResolvers()
    const statPaths = []
    const afterCancel = []
    let cancelRequested = false
    const sftp = { ...base }
    sftp.stat = async (p) => {
      if (cancelRequested) afterCancel.push(['stat', p])
      else {
        statPaths.push(p)
        if (statPaths.length === 4) preflightsStarted.resolve()
        if (statPaths.length > 1) await finishPreflights.promise
      }
      return base.stat(p)
    }
    sftp[transfer] = async (p, ...args) => {
      if (cancelRequested) afterCancel.push([transfer, p])
      else {
        transferStarted.resolve(p)
        await finishTransfer.promise
      }
      return base[transfer](p, ...args)
    }
    sftp.readdir = async (p) => {
      if (cancelRequested) afterCancel.push(['readdir', p])
      return base.readdir(p)
    }
    t.mock.method(SshPool.prototype, 'sftp', async () => {
      if (cancelRequested) afterCancel.push(['sftp'])
      return sftp
    })
    const host = await createHost({ config: { host: '127.0.0.1', username: 'root', workspace: '/proj' } })
    t.after(() => host.dispose())
    const status = async () => (await host.call('/dsh-remote/status', { method: 'GET' })).json
    const mirror = (await status()).localMirror
    mkdirSync(mirror, { recursive: true })
    writeFileSync(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify({
      host: '127.0.0.1', port: 22, username: 'root', remotePath: '/proj',
    }))
    if (!pulling) for (const name of files) writeFileSync(path.join(mirror, name), 'local content')
    const prior = { 'prior.txt': { size: 4, mtime: 123 } }
    saveSyncState(mirror, prior)

    const start = await host.run(tool, { async: true })
    const id = /taskId=(task-\d+)/.exec(start.text)?.[1]
    assert.ok(id, start.text)
    const [startedPath] = await Promise.all([transferStarted.promise, preflightsStarted.promise])
    try {
      const response = await host.call('/dsh-remote/task', { body: { id, action: 'cancel' } })
      assert.equal(response.json.ok, true, response.raw)
      assert.equal(response.json.task.status, 'running', 'the started transfer still needs to settle')
      cancelRequested = true
    } finally {
      finishPreflights.resolve()
      finishTransfer.resolve()
    }
    await setImmediate()
    const { json: { task } } = await host.call('/dsh-remote/task?id=' + id, { method: 'GET' })
    assert.equal(task.status, 'cancelled')
    assert.match(task.result.text, /^(Downloaded|Uploaded) 1 file/)
    assert.match(task.result.text, /CANCELLED/)
    assert.deepEqual(afterCancel, pulling ? [] : [['stat', startedPath]], 'only a started upload may read back its final mtime')
    const observed = (await status()).sync
    assert.equal(observed.phase, 'partial')
    assert.equal(observed.cancelled, true)
    assert.equal(observed.files, 1)
    const completedFile = path.posix.basename(startedPath)
    for (const name of files) {
      if (pulling) assert.equal(existsSync(path.join(mirror, name)), name === completedFile, name)
      else assert.equal(fs.readFileSync('/proj/' + name).toString(), name === completedFile ? 'local content' : 'remote', name)
    }
    if (pulling) assert.equal(readFileSync(path.join(mirror, completedFile), 'utf8'), 'remote')
    const { size, mtime } = fs.statSync(startedPath)
    assert.deepEqual(loadSyncState(mirror), { ...prior, [completedFile]: { size, mtime } })

    const resumed = await host.run(tool, {})
    assert.match(resumed.text, pulling ? /^Downloaded 5 file/ : /^Uploaded 4 file/)
    assert.match(resumed.text, /1 unchanged/)
  })
}

test('rw_sync cancellation during SFTP reconnect prevents retrying a stalled directory read', async () => {
  const reconnect = Promise.withResolvers()
  const reconnectStarted = Promise.withResolvers()
  let cancelled = false
  let retries = 0
  const first = { readdir: async () => { throw new Error('sftp channel closed') } }
  const result = syncTree(first, '/proj', '/unused-mirror', {
    dryRun: true,
    isCancelled: () => cancelled,
    getSftp: () => {
      reconnectStarted.resolve()
      return reconnect.promise
    },
  })
  await reconnectStarted.promise
  cancelled = true
  reconnect.resolve({ readdir: async () => { retries++; return [] } })
  const { stats, nextState } = await result
  assert.equal(retries, 0)
  assert.equal(stats.cancelled, true)
  assert.deepEqual(nextState, {})
})

test('rw_push cancellation during mkdir skips its contents and sibling entries', async (t) => {
  const local = mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-cancel-'))
  t.after(() => rmSync(local, { recursive: true, force: true }))
  for (const name of ['a', 'b']) {
    mkdirSync(path.join(local, name))
    writeFileSync(path.join(local, name, 'nested.txt'), 'nested')
  }
  writeFileSync(path.join(local, 'root.txt'), 'root')
  const mkdirStarted = Promise.withResolvers()
  const finishMkdir = Promise.withResolvers()
  let cancelled = false
  const calls = []
  const sftp = {
    async mkdir(p) {
      calls.push(['mkdir', p])
      mkdirStarted.resolve()
      await finishMkdir.promise
    },
    async stat(p) { calls.push(['stat', p]) },
    async writeFile(p) { calls.push(['writeFile', p]) },
  }
  const result = pushTree(sftp, local, '/proj', { isCancelled: () => cancelled })
  await mkdirStarted.promise
  cancelled = true
  finishMkdir.resolve()
  const { stats, nextState } = await result
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'mkdir')
  assert.equal(stats.cancelled, true)
  assert.equal(stats.files, 0)
  assert.deepEqual(nextState, {})
})
