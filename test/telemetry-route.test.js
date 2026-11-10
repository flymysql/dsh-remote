// Latent-bug pin (found during the issue #82 split): GET /dsh-remote/telemetry
// called heartbeatEnabled(), which was never imported — every GET threw a
// ReferenceError, the webserver turned the rejected handler into an empty 400,
// and the whole suite stayed green because nobody actually GET'ed the route
// (the matrix only probes its 405 and malformed-POST branches).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHost } from './harness/plugin-host.js'

test('GET /dsh-remote/telemetry answers the effective value, not a ReferenceError', async () => {
  const host = await createHost({ machines: [] })
  try {
    const r = await host.call('/dsh-remote/telemetry', { method: 'GET' })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(typeof r.json.enabled, 'boolean')
    assert.equal(typeof r.json.configurable, 'boolean')
  } finally {
    await host.dispose()
  }
})
