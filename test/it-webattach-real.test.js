// REAL-MACHINE integration: attach to a remote machine's real `dsh web` UI.
//
// This is the flow the deploy panel and 远程 DSH 界面 exist for, and it is the one
// part of the plugin that starts a PROCESS on the far side and then tunnels HTTP to
// it. A fake SSH server cannot prove it: the remote needs a real `dsh` binary, a
// real `dsh web` startup, a real token URL and a real forward.
//
// Gated by IT_WEB_HOST (or IT_SSH_HOST) + IT_WEB_PASSWORD / IT_WEB_KEY. The remote
// must have dsh installed (IT_WEB_DSH_COMMAND, default `dsh`).
//
// Cleanup matters: this suite always closes the tunnel and, when the plugin started
// the remote process itself, stops it — a leaked `dsh web` on someone's server is
// exactly the kind of mess an integration test must not leave behind.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './harness/plugin-host.js'
import { realTarget, skipMessage, realMachine, exists } from './harness/real-host.js'

const target = realTarget('IT_WEB') || realTarget('IT_SSH')
const canRun = !!target && (!!target.password || exists(target.privateKeyPath))
const why = !target
  ? skipMessage('IT_WEB', ['IT_WEB_HOST', 'IT_WEB_PASSWORD (or IT_WEB_KEY)'])
  : 'set IT_WEB_PASSWORD or IT_WEB_KEY'

async function withRealMachine(fn) {
  const rec = realMachine(target, {
    id: 'm-it-web',
    name: 'it-web',
    // The remote dsh command: a private-prefix install is the normal case.
    webAttachCommand: target.dshCommand || '',
  })
  const host = await createHost({ machines: [rec] })
  try {
    await host.call('/dsh-remote/current', { body: { id: rec.id } })
    await fn({ host, rec })
  } finally {
    await host.dispose()
  }
}


test('a real tunnel to the remote dsh web serves the UI over loopback', { skip: canRun ? false : why }, async () => {
  await withRealMachine(async ({ host, rec }) => {
    const opened = await host.call('/dsh-remote/web-attach', { body: { action: 'open', machineId: rec.id } })
    assert.equal(opened.json.ok, true, `open failed: ${opened.raw.slice(0, 500)}`)
    const attach = opened.json.attach || {}
    // `cleanUrl` is what the address bar shows; the TOKEN-bearing `url` is what the
    // browser follows once. Both must stay on loopback.
    assert.match(String(attach.cleanUrl), /^http:\/\/127\.0\.0\.1:\d+\/$/, `the tunnel must be a loopback URL, got: ${attach.cleanUrl}`)
    assert.doesNotMatch(String(attach.cleanUrl), /token=/, 'the displayable URL must NOT carry the token')
    assert.match(String(attach.url), /token=/, 'the one-time URL must carry it')
    assert.ok(attach.remotePort, 'the remote port must be reported')
    const url = attach.url

    // Really fetch it: this is the assertion a mock cannot make. The token URL is
    // NOT the page — DSH exchanges it for a signed cookie and 303s to `/`, so the
    // test has to do the exchange itself (Node's fetch keeps no cookie jar, which
    // is why following the redirect blindly lands on a 401 and looks like a bug).
    let exchange = null
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const res = await fetch(url, { redirect: 'manual' })
        exchange = res
        break
      } catch { /* the tunnel may still be warming up */ }
      await new Promise((r) => setTimeout(r, 1000))
    }
    assert.ok(exchange, 'the tunnel must answer at all')
    assert.equal(exchange.status, 303, `the token URL must redirect after the exchange, got ${exchange.status}`)
    assert.equal(exchange.headers.get('location'), '/', 'and redirect to the clean root')
    const setCookies = typeof exchange.headers.getSetCookie === 'function'
      ? exchange.headers.getSetCookie()
      : [exchange.headers.get('set-cookie')].filter(Boolean)
    const cookie = setCookies.filter(Boolean).map((c) => String(c).split(';')[0]).join('; ')
    assert.ok(cookie, 'the exchange must hand out a session cookie')

    const page = await fetch(attach.cleanUrl, { headers: { cookie }, redirect: 'manual' })
    const html = await page.text()
    assert.equal(page.status, 200, `with the cookie the UI must serve 200, got ${page.status}`)
    assert.ok(html.length > 200, `the UI must return a real page, got ${html.length} bytes`)
    assert.match(html, /<html|<!doctype/i, 'the response must be an HTML document')

    // …and the remote dsh still enforces auth THROUGH the tunnel.
    const noToken = await fetch(attach.cleanUrl, { redirect: 'manual' }).then((r) => r.status, () => 0)
    assert.equal(noToken, 401, `the remote dsh must reject a token-less request, got ${noToken}`)

    const closed = await host.call('/dsh-remote/web-attach', { body: { action: 'close', machineId: rec.id } })
    assert.equal(closed.json.ok, true, `close failed: ${closed.raw}`)
    // The loopback port must be free again: a leaked listener breaks the next open.
    const after = await fetch(url).then(() => 'still-serving', () => 'closed')
    assert.equal(after, 'closed', 'closing the tunnel must release the loopback port')
  })
})

test('the remote process the tunnel started is stopped on close(stopRemote)', { skip: canRun ? false : why }, async () => {
  await withRealMachine(async ({ host, rec }) => {
    const opened = await host.call('/dsh-remote/web-attach', { body: { action: 'open', machineId: rec.id } })
    if (opened.json.ok !== true) return // covered above
    const attach = opened.json.attach || {}
    if (!attach.managed) {
      // The plugin only records a PID when IT started the remote process. A tunnel
      // onto the user's own instance is deliberately hands-off.
      await host.call('/dsh-remote/web-attach', { body: { action: 'close', machineId: rec.id } })
      return
    }
    const closed = await host.call('/dsh-remote/web-attach', { body: { action: 'close', machineId: rec.id, stopRemote: true } })
    assert.equal(closed.json.ok, true)
    assert.equal(closed.json.stoppedRemote, true, 'the remote process we started must be stopped')
  })
})