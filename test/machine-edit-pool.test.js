// Regression: editing the machine the pool is CURRENTLY bound to must re-point
// the live pool, not just the registry file.
//
// The pool keeps the target it was APPLIED with, and forwards.start() / every
// rw_* call dials through it. The settings save path only wrote the registry and
// rebound mirrors, so after changing a machine's host the settings page showed
// the new address while 启动 still connected to the old one — exactly the
// "modified the host, saved, but 启动 says ssh: connect to host <old>: Host is
// down" report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost, machine } from './harness/plugin-host.js'

const addressOf = async (host) => (await host.call('/dsh-remote/status', { method: 'GET' })).json

test('editing the ACTIVE machine re-points the live pool at the new host', async () => {
  const rec = machine({ host: 'alias-old', useSshConfig: true, backend: 'openssh', username: 'kali' })
  const host = await createHost({ machines: [rec], currentId: rec.id })
  try {
    const cur = await host.call('/dsh-remote/current', { body: { id: rec.id } })
    assert.equal(cur.json.ok, true, cur.raw)
    assert.equal((await addressOf(host)).host, 'alias-old', 'the pool starts on the saved address')

    const saved = await host.call('/dsh-remote/machines', {
      body: {
        action: 'update', id: rec.id, name: 'kali', host: 'alias-new',
        port: 22, username: 'kali', useSshConfig: true, backend: 'openssh',
      },
    })
    assert.equal(saved.status, 200, saved.raw)
    assert.equal(saved.json.poolWarning, undefined, 're-pointing must not fail silently')

    // Immediately, before any /current or reconnect: the pool dials the new host.
    const st = await addressOf(host)
    assert.equal(st.host, 'alias-new', 'the live pool must use the edited address, not the one it was applied with')
    assert.equal(st.currentId, rec.id)
  } finally { await host.dispose() }
})

test('editing a machine that is NOT active leaves the active pool untouched', async () => {
  const active = machine({ host: 'alias-active', useSshConfig: true, backend: 'openssh' })
  const other = machine({ host: 'alias-other', useSshConfig: true, backend: 'openssh' })
  const host = await createHost({ machines: [active, other], currentId: active.id })
  try {
    await host.call('/dsh-remote/current', { body: { id: active.id } })
    const saved = await host.call('/dsh-remote/machines', {
      body: {
        action: 'update', id: other.id, host: 'alias-other-2',
        port: 22, username: 'kali', useSshConfig: true, backend: 'openssh',
      },
    })
    assert.equal(saved.status, 200, saved.raw)
    assert.equal((await addressOf(host)).host, 'alias-active',
      'saving a standby machine must not hijack the active connection')
  } finally { await host.dispose() }
})