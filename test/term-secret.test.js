// The terminal credential bridge: the generated `remote ssh` launcher spawns
// the OS ssh, which can authenticate with keys/agents but has no channel for a
// password the plugin saved (plaintext registry or OS keychain). The bridge is
// a per-boot bearer token in $DSH_HOME/remote-terminal/term-secret.json plus
// POST /dsh-remote/term-secret resolving through the same credential chain a
// real connect uses.
//
// These tests boot the real plugin host (isolated DSH_HOME), so the payload
// publish (via the harness webServer's getOrigin), the token check, the machine
// match and the credential read all run for real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { createHost, machine } from './harness/plugin-host.js'

/** Read the published bridge payload (waits one tick for the inject publish). */
async function readPayload(home) {
  const file = path.join(home, 'remote-terminal', 'term-secret.json')
  for (let i = 0; i < 20 && !existsSync(file); i += 1) await new Promise((r) => setTimeout(r, 25))
  assert.ok(existsSync(file), 'the host must publish the bridge payload next to the launcher')
  return JSON.parse(readFileSync(file, 'utf8'))
}

test('term-secret serves the saved password to the bearer, and only to it', async () => {
  const secret = 's3cret-' + Math.random().toString(36).slice(2)
  const host = await createHost({
    machines: [machine({ id: 'm1', host: '10.0.0.9', port: 22, username: 'root', password: secret, credentialBackend: 'plain' })],
  })
  try {
    const payload = await readPayload(host.home)
    assert.equal(payload.version, 1)
    assert.equal(payload.url, 'http://127.0.0.1:3080')
    assert.match(payload.token, /^[0-9a-f]{48}$/)

    const ask = (token, body) => host.call('/dsh-remote/term-secret', {
      method: 'POST',
      body: body || { host: '10.0.0.9', port: 22, username: 'root' },
      headers: token ? { authorization: 'Bearer ' + token } : {},
    })

    const noToken = await ask('', undefined)
    assert.equal(noToken.status, 403, 'no bearer → forbidden')
    const wrong = await ask('0'.repeat(48), undefined)
    assert.equal(wrong.status, 403, 'a wrong bearer → forbidden (and no timing oracle: hashes are compared)')

    const ok = await ask(payload.token, undefined)
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.equal(ok.json.password, secret, 'the plaintext-registry password resolves through the bridge')

    const unknown = await ask(payload.token, { host: '10.9.9.9', port: 22, username: 'root' })
    assert.equal(unknown.status, 404, 'an unmatched identity never invents a credential')

    const get = await host.call('/dsh-remote/term-secret', { method: 'GET' })
    assert.equal(get.status, 405, 'POST only')
  } finally {
    await host.dispose()
  }
})

// Note on scope: the boot-time wipe of a stale payload is two lines of
// defensive code (rmSync force before any publish); the full bridge path is
// proven by the test above. Seeding "a crashed previous boot's file" would need
// pre-apply access to the harness's temp home, which the harness does not
// expose — the wipe stays a code-reviewed invariant, not a simulated one.
