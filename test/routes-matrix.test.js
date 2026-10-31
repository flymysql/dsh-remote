// Route-layer contract tests: the branches EVERY route must get right.
//
// The suite used to test routes one issue at a time (and 14 of the 34 routes were
// never driven at all). Issue #30 was the wake-up: a handler whose `body` was
// scoped inside `try` threw a ReferenceError from its own catch, dsh-host-webserver
// turned the rejected handler into an EMPTY HTTP 400, and the UI could only print
// "HTTP 400" for every possible failure. Nothing in the suite noticed, because no
// test asserted the SHAPE of a failure — only that one specific happy path worked.
//
// So these tests are deliberately generic: they walk a declared inventory of every
// registered route and assert the properties that must hold for all of them:
//   · it exists at all (a route that silently stops registering is a dead feature);
//   · a wrong HTTP method answers 405 + JSON, not an empty body;
//   · a malformed JSON body answers a readable JSON reason;
//   · the handler never REJECTS (a rejection is an empty 400 to the user);
//   · asking for a file/dir with no machine bound answers a JSON explanation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './harness/plugin-host.js'

/** Every route the plugin is expected to register, with the methods it serves. */
const ROUTES = [
  { path: '/dsh-remote/status', allow: ['GET'] },
  { path: '/dsh-remote/resolve-mirror', allow: ['GET'] },
  { path: '/dsh-remote/bindings', allow: ['GET'] },
  { path: '/dsh-remote/connect', allow: ['POST'], body: true },
  { path: '/dsh-remote/workspace', allow: ['POST'], body: true },
  { path: '/dsh-remote/mirror', allow: ['POST'], body: true },
  { path: '/dsh-remote/local-pick', allow: ['POST'], body: true, interactive: true },
  { path: '/dsh-remote/local-list', allow: ['GET'] },
  { path: '/dsh-remote/local-mkdir', allow: ['POST'], body: true },
  { path: '/dsh-remote/machines', allow: ['GET', 'POST'], body: true },
  { path: '/dsh-remote/test-connect', allow: ['POST'], body: true, softFail: true },
  { path: '/dsh-remote/current', allow: ['POST'], body: true },
  { path: '/dsh-remote/forget-key', allow: ['POST'] },
  { path: '/dsh-remote/forwards', allow: ['GET', 'POST'], body: true },
  { path: '/dsh-remote/task', allow: ['GET', 'POST'], body: true },
  { path: '/dsh-remote/tasks', allow: ['GET'] },
  // audit now serves POST too (it opens the log file on the host), so the
  // wrong-method probe uses DELETE and the 405 branch still has to answer.
  { path: '/dsh-remote/audit', allow: ['GET', 'POST'], body: true },
  // ssh-config serves POST too (open/reveal the file on the host). A body path
  // is ignored; the wrong-method probe uses DELETE so the 405 branch still runs.
  { path: '/dsh-remote/ssh-config', allow: ['GET', 'POST'], body: true },
  // web-attach dispatches on `req.method === 'GET'` and treats anything else as an
  // action POST, so there is no 405 branch to assert.
  { path: '/dsh-remote/web-attach', allow: ['GET', 'POST'], body: true, noMethodGuard: true },
  { path: '/dsh-remote/home', allow: ['POST'], body: true, softFail: true },
  { path: '/dsh-remote/update-check', allow: ['GET'] },
  { path: '/dsh-remote/update-apply', allow: ['POST'], body: true },
  { path: '/dsh-remote/update-reload', allow: ['POST'] },
  { path: '/dsh-remote/update-mode', allow: ['POST'], body: true },
  // fs surface (lib/routes-fs.js)
  { path: '/dsh-remote/ls', allow: ['GET', 'POST'], noMethodGuard: true },
  { path: '/dsh-remote/read', allow: ['GET', 'POST'], body: true },
  { path: '/dsh-remote/write', allow: ['POST'], body: true },
  { path: '/dsh-remote/fs', allow: ['POST'], body: true },
  // embedded terminal (lib/routes-term.js)
  { path: '/dsh-remote/term/open', allow: ['POST'], body: true },
  { path: '/dsh-remote/term/input', allow: ['POST'], body: true },
  { path: '/dsh-remote/term/output', allow: ['GET', 'POST'], body: true },
  { path: '/dsh-remote/term/resize', allow: ['POST'], body: true },
  { path: '/dsh-remote/term/close', allow: ['POST'], body: true },
  { path: '/dsh-remote/term/list', allow: ['GET'] },
]

const WRONG_METHOD = { GET: 'POST', POST: 'GET' }

/** A method the route does NOT serve (GET+POST routes get DELETE). */
function wrongMethodFor(route) {
  if (route.allow.includes('GET') && route.allow.includes('POST')) return 'DELETE'
  return WRONG_METHOD[route.allow[0]]
}

test('every documented route is registered, and nothing else silently disappears', async () => {
  const host = await createHost()
  try {
    const missing = ROUTES.filter((r) => !host.routes.has(r.path)).map((r) => r.path)
    assert.deepEqual(missing, [], `routes not registered: ${missing.join(', ')}`)
    // The inventory must also stay honest the other way round: a new route that
    // nobody added here would otherwise never be covered by the checks below.
    const extra = [...host.routes.keys()].filter((p) => !ROUTES.some((r) => r.path === p))
    assert.deepEqual(extra, [], `new route(s) not in the test inventory: ${extra.join(', ')} — add them to ROUTES`)
  } finally {
    await host.dispose()
  }
})

test('a wrong HTTP method answers 405 with a JSON reason, never an empty body', async () => {
  const host = await createHost()
  try {
    for (const route of ROUTES) {
      if (route.noMethodGuard) continue
      const wrong = wrongMethodFor(route)
      const r = await host.call(route.path, { method: wrong, body: {} })
      assert.equal(r.rejected, null, `${route.path} (${wrong}) rejected instead of answering`)
      assert.equal(r.status, 405, `${route.path} (${wrong}) answered ${r.status}, expected 405 — body: ${r.raw.slice(0, 120)}`)
      assert.ok(r.json, `${route.path} (${wrong}) answered non-JSON: ${r.raw.slice(0, 120)}`)
      assert.match(String(r.json.error || ''), /method not allowed/i, `${route.path}: missing "method not allowed" reason`)
    }
  } finally {
    await host.dispose()
  }
})

test('a malformed JSON body is reported in JSON, never swallowed into an empty 400', async () => {
  const host = await createHost()
  try {
    for (const route of ROUTES) {
      // `local-pick` takes no body and would wait for a human in an OS dialog;
      // the suite disables that dialog (DSH_REMOTE_NO_NATIVE_DIALOG), but the route
      // still has no body contract to check.
      if (!route.body || route.interactive) continue
      const r = await host.call(route.path, { method: 'POST', body: '{"host": ', raw: true })
      assert.equal(r.rejected, null, `${route.path} rejected on a malformed body (issue #30 shape)`)
      assert.ok(r.json, `${route.path} answered non-JSON: ${r.raw.slice(0, 160)}`)
      // A probe route answers 200 with {ok:false} on EVERY outcome (its documented
      // contract); everything else must use a 4xx/5xx.
      const okStatuses = route.softFail ? [200, 400, 500] : [400, 500]
      assert.ok(okStatuses.includes(r.status), `${route.path} answered ${r.status} for a malformed body`)
      assert.ok(String(r.json.error || r.json.message || '').length > 0,
        `${route.path} gave no readable reason for a malformed body: ${r.raw.slice(0, 160)}`)
      // …and it must not CLAIM SUCCESS while reporting an error.
      assert.notEqual(r.json.ok, true, `${route.path} answered ok:true together with an error`)
    }
  } finally {
    await host.dispose()
  }
})

test('with no machine bound, file operations answer a JSON explanation instead of throwing', async () => {
  const host = await createHost()
  try {
    const fsCalls = [
      { path: '/dsh-remote/ls', body: { path: '/' } },
      { path: '/dsh-remote/read', body: { path: '/etc/hostname' } },
      { path: '/dsh-remote/write', body: { path: '/tmp/a', content: 'x' } },
      { path: '/dsh-remote/fs', body: { op: 'list', path: '/' } },
    ]
    for (const call of fsCalls) {
      const r = await host.call(call.path, { body: call.body })
      assert.equal(r.rejected, null, `${call.path} rejected with no machine bound`)
      assert.ok(r.json, `${call.path} answered non-JSON: ${r.raw.slice(0, 160)}`)
      assert.notEqual(r.json.ok, true, `${call.path} must not claim success without a machine`)
      const reason = String(r.json.error || r.json.message || '')
      assert.ok(reason.length > 0, `${call.path} gave no reason`)
      // The reason must name the REAL problem (no machine selected), not a
      // credential — "缺少凭据" here sends the user to the wrong settings page.
      assert.match(reason, /没有活动远程机|no active remote machine|机器|machine/i,
        `${call.path} must explain that no machine is active, got: ${reason}`)
      assert.doesNotMatch(reason, /no credentials|缺少凭据/i,
        `${call.path} blamed the credentials for a missing machine selection: ${reason}`)
    }
  } finally {
    await host.dispose()
  }
})

test('unknown ids are refused with 404/ok:false, not a crash or a silent success', async () => {
  const host = await createHost()
  try {
    const cur = await host.call('/dsh-remote/current', { body: { id: 'm-does-not-exist' } })
    assert.equal(cur.rejected, null)
    assert.equal(cur.status, 404)
    assert.equal(cur.json.ok, false)

    const task = await host.call('/dsh-remote/task?id=nope', { method: 'GET' })
    assert.equal(task.rejected, null)
    assert.ok(task.json, 'the task route must answer JSON for an unknown id')
    assert.equal(task.json.ok === true, false, 'an unknown task id must not report success')

    const del = await host.call('/dsh-remote/machines', { body: { action: 'delete', id: 'm-nope' } })
    assert.equal(del.status, 404)
    assert.equal(del.json.ok, false)

    const badAction = await host.call('/dsh-remote/machines', { body: { action: 'explode' } })
    assert.equal(badAction.status, 400)
    assert.match(String(badAction.json.error), /unknown action/)
  } finally {
    await host.dispose()
  }
})
