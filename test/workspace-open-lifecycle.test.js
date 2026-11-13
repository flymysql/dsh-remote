import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createWorkspaceRoutes } from '../lib/routes-workspace.js'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

function fixture(prepareMirrorTarget) {
  const req = Object.assign(new EventEmitter(), { method: 'POST' })
  const res = new EventEmitter()
  const effects = []
  const selected = { id: 'a', host: 'host-a', username: 'user-a', port: 22 }
  const deps = {
    config: { host: 'host-a' }, readBody: async () => JSON.stringify({ path: '/project', machineId: 'a' }),
    sendJson: (_res, status, json) => effects.push(['reply', status, json]),
    applyRequestedMachine: async () => true,
    activeMachine: () => selected, machineForId: () => selected,
    aliasOf: () => '', prepareMirrorTarget,
    ensureMirror: (...args) => { effects.push(['mirror', ...args]); return '/local/project' },
    persistWorkspace: (...args) => effects.push(['persist', ...args]),
    startAutoPush: () => effects.push(['watch']), registerMirroredWorkspace: async () => effects.push(['register']), status: () => ({}),
  }
  const route = createWorkspaceRoutes(deps).find((r) => r.path === '/dsh-remote/mirror')
  return { req, res, effects, run: () => route.handler(req, res) }
}

test('closing the response aborts its preparation and does not create a mirror or workspace', async () => {
  let started
  const ready = new Promise((r) => { started = r })
  let aborted = false
  const f = fixture((_p, _machine, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')) }, { once: true })
    started()
  }))
  const running = f.run()
  await ready
  f.res.emit('close')
  await running
  assert.equal(aborted, true)
  assert.deepEqual(f.effects, [])
  assert.equal(f.res.listenerCount('close'), 0)
  assert.equal(f.req.listenerCount('aborted'), 0)
})

test('a late successful preparation cannot commit after cancellation', async () => {
  let finish, started
  const ready = new Promise((r) => { started = r })
  const f = fixture((_p, machine) => new Promise((r) => { finish = () => r({ ok: true, machine, identity: machine }); started() }))
  const running = f.run()
  await ready
  f.res.emit('close')
  finish()
  await running
  assert.deepEqual(f.effects, [])
})

test('concurrent mirror requests retain their own real SSH origins and recent projects', async () => {
  const a = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: { '/project/a.txt': 'A' } })
  const b = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: { '/project/b.txt': 'B' } })
  const ma = machine({ ...a.machine(), id: 'a' })
  const mb = machine({ ...b.machine(), id: 'b' })
  const host = await createHost({ machines: [ma, mb], currentId: 'a' })
  try {
    const results = await Promise.all([ma, mb].map((m) => host.call('/dsh-remote/mirror', { body: { machineId: m.id, path: '/project', registerWorkspace: false } })))
    for (const [i, r] of results.entries()) {
      assert.equal(r.status, 200, r.raw)
      const meta = JSON.parse(readFileSync(path.join(r.json.localMirror, '.dsh-remote-meta.json'), 'utf8'))
      assert.equal(meta.port, [a.port, b.port][i])
      assert.equal(r.json.machine.port, [a.port, b.port][i])
    }
    assert.notEqual(results[0].json.localMirror, results[1].json.localMirror)
    assert.deepEqual(host.readMachines().map((m) => m.recentWorkspaces), [['/project'], ['/project']])
    assert.ok(readdirSync(host.root).length > 0)
  } finally { await host.dispose(); await a.close(); await b.close() }
})
