import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

test('mode route persists before notifying the live updater; status polling never queries npm', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-update-route-'))
  const dir = path.join(root, 'node_modules/dsh-remote')
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.1' }))
  for (const name of ['update.js', 'routes-update.js']) copyFileSync(new URL('../lib/' + name, import.meta.url), path.join(dir, 'lib', name))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { createUpdateRoutes } = await import(pathToFileURL(path.join(dir, 'lib/routes-update.js')))
  let notified = [], answered = false
  const state = { phase: 'error', error: 'offline', nextCheckAt: 12345 }
  const routes = createUpdateRoutes({
    sendJson: (res, status, body) => { res.status = status; res.body = body; answered = true },
    readBody: async (req) => JSON.stringify(req.body), config: {}, defaultUpdateMode: 'auto',
    autoUpdateState: () => state,
    onUpdateModeChange: (mode) => { assert.ok(answered); assert.equal(readFileSync(path.join(dir, 'update-mode'), 'utf8'), mode); notified.push(mode) },
  })
  const call = async (route, method, body) => { const res = {}; await routes.find(r => r.path === route).handler({ method, body, url: route + '?statusOnly=1' }, res); await Promise.resolve(); return res }
  for (const mode of ['manual', 'auto', 'off']) {
    answered = false
    assert.equal((await call('/dsh-remote/update-mode', 'POST', { mode })).status, 200)
  }
  assert.deepEqual(notified, ['manual', 'auto', 'off'])
  assert.equal((await call('/dsh-remote/update-mode', 'POST', { mode: 'invalid' })).status, 400)
  assert.equal(notified.length, 3)
  const prev = globalThis.fetch
  globalThis.fetch = () => { throw new Error('status polling must not request the registry') }
  try {
    const res = await call('/dsh-remote/update-check', 'GET')
    assert.equal(res.status, 200); assert.equal(res.body.updateMode, 'off')
    assert.deepEqual(res.body.autoUpdate, state); assert.equal(res.body.registryError, undefined)
  } finally { globalThis.fetch = prev }
})
