import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSyncActivity } from '../lib/sync-status.js'

test('sync observations keep unknown, progress, conflicts and mirror identities distinct', async () => {
  const activity = createSyncActivity()
  assert.deepEqual(activity.read('A'), { phase: 'unknown' })
  let finish
  const running = activity.run('A', 'download', async (record) => {
    assert.equal(activity.read('A').phase, 'running')
    await new Promise((r) => { finish = r })
    record({ files: 2, conflicts: [{ path: 'a.txt', reason: 'both-modified' }] })
    return 'download-result'
  })
  assert.deepEqual(activity.read('B'), { phase: 'unknown' })
  finish()
  assert.equal(await running, 'download-result')
  assert.equal(activity.read('A').phase, 'conflicts')
  assert.deepEqual(activity.read('A').conflicts, [{ path: 'a.txt', reason: 'both-modified' }])
  assert.equal('token' in activity.read('A'), false)
})

test('partial/error outcomes are not reported as successful synchronization', async () => {
  const activity = createSyncActivity()
  await activity.run('A', 'upload', async (record) => record({ failed: 1, abortedError: 'disconnected' }))
  assert.equal(activity.read('A').phase, 'partial')
  assert.equal(activity.read('A').error, 'disconnected')
  await assert.rejects(activity.run('A', 'upload', async () => { throw new Error('denied') }), /denied/)
  assert.equal(activity.read('A').phase, 'failed')
  await activity.run('A', 'upload', async () => {})
  assert.equal(activity.read('A').phase, 'completed')
})

test('dry runs do not change the last observed write/download operation', async () => {
  const activity = createSyncActivity()
  await activity.run('A', 'upload', async (record) => record({ files: 1 }), true)
  assert.deepEqual(activity.read('A'), { phase: 'unknown' })
})

test('an older operation cannot overwrite a later operation outcome', async () => {
  const activity = createSyncActivity()
  let finish
  const first = activity.run('A', 'download', () => new Promise((r) => { finish = r }))
  await activity.run('A', 'upload', async () => {})
  finish()
  await first
  assert.equal(activity.read('A').operation, 'upload')
  assert.equal(activity.read('A').phase, 'completed')
})
