// 审计日志必须能「打开日志文件」；同时钉住「远程 dsh 部署/体检」已被移除。
//
// Two requests from the user:
//   1. 去掉远程 dsh 部署和体检的能力 — the card, the rw_deploy_probe tool and the
//      web-attach probe/install/investigate actions must all be GONE, and asking for
//      them must fail loudly instead of half-working.
//   2. 审计日志要能打开日志文件 — the log lives on the machine running the DSH host, so
//      the BROWSER cannot open it: the host opens it and reports how that went, and the
//      path is always surfaced so a headless host still gives the user something.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHost, machine } from './harness/plugin-host.js'

/** The audit route opens files on the HOST; keep the test from launching real apps. */
async function withHost(fn, config = {}) {
  const saved = process.env.DSH_REMOTE_NO_NATIVE_DIALOG
  // '1' = "no desktop here": the route must then answer with the path, not crash.
  process.env.DSH_REMOTE_NO_NATIVE_DIALOG = '1'
  const host = await createHost({ machines: [machine({ id: 'm-1', name: 'box', host: '10.0.0.5' })], config })
  try {
    await fn({ host })
  } finally {
    await host.dispose()
    if (saved === undefined) delete process.env.DSH_REMOTE_NO_NATIVE_DIALOG
    else process.env.DSH_REMOTE_NO_NATIVE_DIALOG = saved
  }
}

// ── 1. 部署/体检能力确实不存在了 ──────────────────────────────────────────

test('the deploy/health-check tool is no longer registered', async () => {
  const host = await createHost()
  try {
    assert.equal(host.tools.has('rw_deploy_probe'), false, 'rw_deploy_probe must be gone')
    // 21 tools remain (the 22nd was the probe).
    assert.equal(host.tools.size, 21, `expected 21 rw_* tools, got ${host.tools.size}: ${[...host.tools.keys()].join(', ')}`)
  } finally {
    await host.dispose()
  }
})

test('the web-attach route refuses the deploy actions instead of half-working', async () => {
  const host = await createHost({ machines: [machine({ id: 'm-1' })] })
  try {
    for (const action of ['probe', 'install', 'investigate', 'install-status', 'install-cancel']) {
      const r = await host.call('/dsh-remote/web-attach', { body: { action, machineId: 'm-1' } })
      assert.equal(r.rejected, null, `${action} must not reject`)
      assert.equal(r.json.ok, false, `${action} must fail: the capability is gone`)
      assert.match(String(r.json.error), /open \| close/, `${action} must be told the valid actions`)
    }
    // The GET payload no longer carries deploy state either.
    const status = await host.call('/dsh-remote/web-attach', { method: 'GET' })
    assert.equal(status.json.deploys, undefined, 'no deploy list in the status payload')
    assert.equal(status.json.deploy, undefined, 'no per-machine deploy state')
    assert.ok('attaches' in status.json, 'but the tunnel list is still there')
  } finally {
    await host.dispose()
  }
})

// ── 2. 审计日志：能打开文件，且路径始终可见 ────────────────────────────────

test('POST /audit creates the log file if missing and reports the path it tried to open', async () => {
  await withHost(async ({ host }) => {
    const file = path.join(host.root, 'audit.log')
    assert.equal(existsSync(file), false, 'no log exists yet')
    const r = await host.call('/dsh-remote/audit', { body: { action: 'open' } })
    assert.equal(r.rejected, null, 'opening must never reject')
    assert.equal(existsSync(file), true, 'a missing log is created so the button always has a target')
    // Headless host (DSH_REMOTE_NO_NATIVE_DIALOG=1): the open is refused WITH a reason
    // and the path, so the user can still get at the file.
    assert.equal(r.json.ok, false)
    assert.equal(r.status, 501)
    assert.equal(r.json.file, file, 'the path must be reported even when the open fails')
    assert.match(String(r.json.error), /路径|path/)
  })
})

test('an unknown audit action is refused, and the reason names the valid ones', async () => {
  await withHost(async ({ host }) => {
    const r = await host.call('/dsh-remote/audit', { body: { action: 'delete' } })
    assert.equal(r.status, 400)
    assert.equal(r.json.ok, false)
    assert.match(String(r.json.error), /open \| reveal/)
  })
})

test('GET /audit still lists the log lines and the file path the panel shows', async () => {
  await withHost(async ({ host }) => {
    // Drive an audited operation: it fails at the network layer (nothing listens),
    // but the attempt is what the audit log records.
    await host.call('/dsh-remote/write', { body: { path: '/tmp/x', content: 'y' } })
    const r = await host.call('/dsh-remote/audit?limit=10', { method: 'GET' })
    assert.equal(r.status, 200)
    assert.ok(r.json.file, 'the panel needs the path to show it next to 打开日志文件')
    assert.equal(r.json.file, path.join(host.root, 'audit.log'))
    assert.ok(Array.isArray(r.json.lines))
  })
})

test('audit is only written when the auditLog config is on (the open button never fakes entries)', async () => {
  await withHost(async ({ host }) => {
    const off = await host.call('/dsh-remote/audit?limit=5', { method: 'GET' })
    assert.equal(off.json.auditEnabled, false)
    assert.deepEqual(off.json.lines, [], 'with auditLog off nothing may be recorded')
  })
  await withHost(async ({ host }) => {
    const on = await host.call('/dsh-remote/audit?limit=5', { method: 'GET' })
    assert.equal(on.json.auditEnabled, true)
  }, { auditLog: true })
})
