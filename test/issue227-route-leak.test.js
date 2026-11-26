// Issue #227 — webServer route registration leaked on a mid-list failure:
//
//   const disposers = guarded.map((route) => webServer.register(route))
//   inner.effect(() => () => disposers.forEach((dispose) => dispose()))
//
// webServer.register THROWS on a duplicate. With route k failing, the map
// aborts BEFORE the effect line ever runs, so routes 1..k-1 keep serving
// from an unloaded plugin (401, not 404), and a re-enable then collides
// with those leftovers until the host restarts. The fix registers one
// route per inner.effect(), so every successful registration is disposed
// together with the child fiber.
//
// The test drives the REAL registerHttpTransports with a webServer double
// that throws on the k-th route, then simulates the loader's behavior
// when the inject callback throws: dispose every effect that ran.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHttpTransports } from '../lib/http-transport.js'

function makeCtx({ failAt = 0 } = {}) {
  const active = []
  const disposed = []
  const injected = []
  let callCount = 0
  const webServer = {
    register(route) {
      callCount += 1
      if (callCount === failAt) throw new Error(`duplicate exact route "${route.path}"`)
      const record = { route, disposed: false }
      active.push(record)
      return () => { record.disposed = true; disposed.push(record.route.path) }
    },
  }
  const ctx = {
    inject(deps, fn) {
      if (!deps.includes('webServer')) return // this test is about the webServer branch
      const inner = {
        get: (name) => (name === 'webServer' ? webServer : undefined),
        effect(f) {
          // cordis runs the effect factory synchronously and registers its
          // disposer; a throw here means this route's registration is rolled
          // back by the fiber (NO disposer is added to the teardown list),
          // and the throw aborts the rest of the inject callback.
          const disposer = f()
          injected.push(disposer)
        },
      }
      // ctx.inject runs the callback; a throw propagates to the loader.
      fn(inner)
    },
    get() { return undefined },
  }
  return { ctx, active, disposed, injected }
}

const ROUTES = [
  { path: '/a', handler: () => {} },
  { path: '/b', handler: () => {} },
  { path: '/c', handler: () => {} },
]

test('#227: a duplicate on the k-th route disposes the k-1 routes already registered', () => {
  const { ctx, active, disposed, injected } = makeCtx({ failAt: 2 })
  // The failing route is caught per-route (the loader still gets a warn),
  // so the effect line IS reached and every registration made so far is
  // handed to the child fiber — unlike the old map() which threw before
  // reaching the effect line and leaked the earlier routes.
  registerHttpTransports(ctx, ROUTES)
  for (const disposer of injected) { if (typeof disposer === 'function') disposer() }
  assert.deepEqual(disposed.sort(), ['/a', '/c'], 'every route actually registered is disposed along with the failed child fiber')
  assert.equal(active.filter((r) => !r.disposed).length, 0, 'nothing is left answering on the old instance')
})

test('#227: a failure on the LAST route disposes every earlier route (k = 3 of 3)', () => {
  const { ctx, disposed, injected } = makeCtx({ failAt: 3 })
  try { registerHttpTransports(ctx, ROUTES) } catch { /* expected */ }
  for (const disposer of injected) { if (typeof disposer === 'function') disposer() }
  assert.deepEqual(disposed.sort(), ['/a', '/b'], 'both earlier routes are cleaned up')
})

test('#227: a clean registration still disposes everything on normal teardown', () => {
  const { ctx, disposed, injected } = makeCtx()
  registerHttpTransports(ctx, ROUTES)
  for (const disposer of injected) { if (typeof disposer === 'function') disposer() }
  assert.deepEqual(disposed.sort(), ['/a', '/b', '/c'], 'no behavior change on the happy path')
})
