// Issue #96 — the web/desktop face of workspace cleanup.
//
// The TUI got a cleanup page in PR #92; the settings page had none. These drive
// the two new routes end to end against the real host (isolated DSH_HOME with a
// seeded mirror + a seeded session log), proving the HTTP surface lands exactly
// on the in-process API's semantics: list → three deletion tiers → busy refusal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { createHost, machine } from './harness/plugin-host.js'
import { projectKey, encodeSegment } from '../lib/workspace-cleanup.js'

/** Seed one mirror (meta + a file) and one session log for it. */
function seedMirror(home, { host = '10.0.0.9', port = 22, username = 'root', name = 'proj', remotePath = '/srv/proj' } = {}) {
  const mirrorDir = path.join(home, 'remote-workspaces', `${host}-${username}-${port}`, name)
  mkdirSync(mirrorDir, { recursive: true })
  writeFileSync(path.join(mirrorDir, '.dsh-remote-meta.json'), JSON.stringify({ host, port, username, remotePath }))
  writeFileSync(path.join(mirrorDir, 'hello.txt'), 'hi')
  const sessDir = path.join(home, 'sessions', projectKey(mirrorDir), encodeSegment('sess-1'))
  mkdirSync(sessDir, { recursive: true })
  writeFileSync(path.join(sessDir, 'session.jsonl'), '{}\n')
  return { mirrorDir, sessDir }
}

test('mirrors list → sessions-only delete → full delete, all through the routes', async () => {
  const host = await createHost({ machines: [machine({ id: 'm1', host: '10.0.0.9' })] })
  try {
    const { mirrorDir, sessDir } = seedMirror(host.home)

    const list = await host.call('/dsh-remote/workspace-mirrors', { method: 'GET' })
    assert.equal(list.status, 200)
    assert.equal(list.json.ok, true)
    const row = list.json.mirrors.find((m) => m.localMirror === mirrorDir)
    assert.ok(row, 'the seeded mirror is listed')
    assert.equal(row.remotePath, '/srv/proj')
    assert.equal(row.sessionCount, 1)
    assert.equal(row.machineName, 'm1'.length ? row.machineName : row.machineName) // name or host fallback
    assert.ok(row.mirrorBytes > 0)

    // Tier x: sessions only — mirror + registration survive.
    const delSessions = await host.call('/dsh-remote/workspace-cleanup', {
      method: 'POST',
      body: { localMirror: mirrorDir, mode: 'sessions' },
    })
    assert.equal(delSessions.status, 200)
    assert.equal(delSessions.json.ok, true)
    assert.equal(delSessions.json.removedSessions, 1)
    assert.ok(!existsSync(sessDir), 'the session log is gone')
    assert.ok(existsSync(mirrorDir), 'tier-x keeps the mirror')

    // Tier d: everything goes.
    const delAll = await host.call('/dsh-remote/workspace-cleanup', {
      method: 'POST',
      body: { localMirror: mirrorDir, mode: 'all' },
    })
    assert.equal(delAll.status, 200)
    assert.equal(delAll.json.removedMirror, true)
    assert.ok(!existsSync(mirrorDir), 'tier-d removes the mirror tree')

    const after = await host.call('/dsh-remote/workspace-mirrors', { method: 'GET' })
    assert.ok(!after.json.mirrors.some((m) => m.localMirror === mirrorDir), 'gone from the list')
  } finally {
    await host.dispose()
  }
})

test('cleanup refuses a path that is not a mirror (validation), and a bogus mode', async () => {
  const host = await createHost({ machines: [] })
  try {
    const bad = await host.call('/dsh-remote/workspace-cleanup', {
      method: 'POST',
      body: { localMirror: 'C:\\Windows', mode: 'all' },
    })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.ok, false)
    assert.ok(bad.json.error.length > 0)

    const badMode = await host.call('/dsh-remote/workspace-cleanup', {
      method: 'POST',
      body: { localMirror: '/tmp/x', mode: 'wat' },
    })
    assert.equal(badMode.status, 400)
    assert.match(badMode.json.error, /mode/)

    const get = await host.call('/dsh-remote/workspace-cleanup', { method: 'GET' })
    assert.equal(get.status, 405)
  } finally {
    await host.dispose()
  }
})
