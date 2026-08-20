import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskManager } from '../lib/tasks.js'

test('task runs to done and exposes its result', async () => {
  const tm = new TaskManager()
  const t = tm.start('sync', 'sync /x', async (ctx) => {
    ctx.progress({ files: 1 })
    await new Promise((r) => setTimeout(r, 5))
    return { text: 'done' }
  })
  // start() pumps synchronously up to the first await → the task is running.
  assert.equal(t.status, 'running')
  await new Promise((r) => setTimeout(r, 50))
  const done = tm.get(t.id)
  assert.equal(done.status, 'done')
  assert.deepEqual(done.result, { text: 'done' })
  assert.deepEqual(done.progress, { files: 1 })
})

test('tasks run one at a time (single flight)', async () => {
  const tm = new TaskManager()
  const order = []
  const t1 = tm.start('a', 'a', async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 30)); order.push('a-end') })
  const t2 = tm.start('b', 'b', async () => { order.push('b-start'); order.push('b-end') })
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
  assert.equal(tm.get(t2.id).status, 'done')
})

test('failed task records the error', async () => {
  const tm = new TaskManager()
  const t = tm.start('x', 'x', async () => { throw new Error('boom') })
  await new Promise((r) => setTimeout(r, 20))
  const done = tm.get(t.id)
  assert.equal(done.status, 'failed')
  assert.match(done.error, /boom/)
})

test('queued + running tasks can be cancelled', async () => {
  const tm = new TaskManager()
  const t1 = tm.start('slow', 'slow', async (ctx) => {
    await new Promise((r) => setTimeout(r, 50))
    if (ctx.cancelled) throw new Error('cancelled')
    return { ok: true }
  })
  const t2 = tm.start('queued', 'queued', async () => ({ ok: true }))
  assert.equal(tm.cancel(t2.id), true) // queued → immediate cancel
  assert.equal(tm.cancel(t1.id), true) // running → cooperative flag
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(tm.get(t1.id).status, 'cancelled')
  assert.equal(tm.get(t2.id).status, 'cancelled')
})
