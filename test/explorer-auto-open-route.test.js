// Issue #119: the auto-open preference belongs to DSH_HOME, not to one
// browser origin. Drive the real route and inspect the real persisted file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createHost } from './harness/plugin-host.js'

test('explorer auto-open GET/POST shares an explicit DSH_HOME preference', async () => {
  const host = await createHost({ machines: [] })
  try {
    const initial = await host.call('/dsh-remote/explorer-auto-open', { method: 'GET' })
    assert.equal(initial.status, 200)
    assert.deepEqual(initial.json, { ok: true, enabled: true, persisted: false }, 'default ON is not an explicit host preference')

    const off = await host.call('/dsh-remote/explorer-auto-open', { method: 'POST', body: { enabled: false } })
    assert.equal(off.status, 200)
    assert.deepEqual(off.json, { ok: true, enabled: false, persisted: true })
    assert.equal(readFileSync(path.join(host.home, '.dsh-remote-explorer-auto-open'), 'utf8'), '0')

    const reread = await host.call('/dsh-remote/explorer-auto-open', { method: 'GET' })
    assert.deepEqual(reread.json, { ok: true, enabled: false, persisted: true })

    const invalid = await host.call('/dsh-remote/explorer-auto-open', { method: 'POST', body: { enabled: '0' } })
    assert.equal(invalid.status, 400)
    assert.match(invalid.json.error, /enabled must be boolean/)
  } finally {
    await host.dispose()
  }
})
