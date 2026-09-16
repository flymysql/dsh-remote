import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionRoute, registerHttpTransports } from '../lib/http-transport.js'
import { inject as required } from '../lib/index.js'
import { readFileSync } from 'node:fs'

const route = {
  kind: 'exact', path: '/dsh-remote/example',
  async handler(req, res) {
    let body = ''
    for await (const chunk of req) body += chunk
    res.statusCode = body === 'conflict' ? 409 : 200
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ method: req.method, url: req.url, body }))
  },
}

test('SSH host has no hard Web service prerequisite', () => {
  assert.deepEqual(required, ['tools', 'systemPrompt'])
})

test('Fetch transport preserves JSON bytes, query parameters, and conflict status', async () => {
  const adapted = connectionRoute(route)
  assert.equal(adapted.path, '/api/dsh-remote/example')
  assert.deepEqual(adapted.methods, ['GET', 'POST'])
  assert.equal(adapted.requestBody, 'buffered')
  const response = await adapted.fetch(new Request('dsh-app://app/api/dsh-remote/example?path=%2Ftmp%2F%E4%B8%AD%E6%96%87', {
    method: 'POST', body: 'conflict',
  }))
  assert.equal(response.status, 409)
  assert.equal(response.headers.get('Content-Type'), 'application/json')
  assert.deepEqual(await response.json(), {
    method: 'POST', url: '/dsh-remote/example?path=%2Ftmp%2F%E4%B8%AD%E6%96%87', body: 'conflict',
  })
})

test('GET with no body completes and POST preserves UTF-8 across chunks', async () => {
  const adapted = connectionRoute(route)
  const get = await adapted.fetch(new Request('dsh-app://app/api/dsh-remote/example'))
  assert.equal((await get.json()).body, '')
  const bytes = Buffer.from(JSON.stringify({ name: '开发目录' }))
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
  const post = await adapted.fetch(new Request('dsh-app://app/api/dsh-remote/example', { method: 'POST', body, duplex: 'half' }))
  assert.equal((await post.json()).body, bytes.toString())
})

test('oversized or already-aborted requests never execute the handler', async () => {
  const adapted = connectionRoute({ ...route, handler() { assert.fail('must not dispatch') } })
  const tooLarge = await adapted.fetch(new Request('dsh-app://app/api/dsh-remote/example', {
    method: 'POST', body: 'x'.repeat(1024 * 1024 + 1),
  }))
  assert.equal(tooLarge.status, 413)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(adapted.fetch(new Request('dsh-app://app/api/dsh-remote/example', { signal: controller.signal })), { name: 'AbortError' })
})

test('adapter only accepts plugin routes under the /dsh-remote/ prefix', () => {
  // `kind` is a dsh-host-webserver concept; Connection's ConnectionFetchRoute
  // has no such field, so a route without it must still adapt.
  assert.equal(connectionRoute({ ...route, kind: undefined }).path, '/api/dsh-remote/example')
  assert.throws(() => connectionRoute({ ...route, path: '/another-plugin' }))
})

test('one unregistrable route must not drop the routes after it', async () => {
  const pending = new Map()
  const routes = [
    { ...route, path: '/dsh-remote/first' },
    { ...route, path: '/not-ours' }, // rejected by connectionRoute()
    { ...route, path: '/dsh-remote/third' },
  ]
  registerHttpTransports({ inject(names, fn) { pending.set(names[0], fn) } }, routes)
  const seen = []
  const service = { register(r) { seen.push(r.path); return () => {} } }
  pending.get('connection')({ get: () => ({ fetch: service }), effect(fn) { fn() } })
  assert.deepEqual(seen, ['/api/dsh-remote/first', '/api/dsh-remote/third'],
    'the third route must survive the bad second one')
})

test('both transports can arrive late; each removes only its own routes', async () => {
  const pending = new Map()
  registerHttpTransports({ inject(names, fn) { pending.set(names[0], fn) } }, [route])
  assert.deepEqual([...pending.keys()], ['webServer', 'connection'])
  const routes = new Map()
  const cleanups = []
  const service = { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) } }
  const inner = (name, value) => ({ get: () => value, effect(fn) { cleanups.push(fn()) } })
  pending.get('connection')(inner('connection', { fetch: service }))
  pending.get('webServer')(inner('webServer', service))
  assert.deepEqual([...routes.keys()], ['/api/dsh-remote/example', '/dsh-remote/example'])
  assert.equal(routes.get('/dsh-remote/example'), route)
  await cleanups[0]()
  assert.deepEqual([...routes.keys()], ['/dsh-remote/example'])
  cleanups[1]()
  assert.equal(routes.size, 0)
  // A pre-Fetch Connection must not suppress the independent Web transport.
  pending.get('connection')({ get: () => ({}), effect() { assert.fail('no routes') } })
})

test('bundle mounts only dsh-remote and never hard-mounts better-sidebar', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id:\s*dsh-remote\s*\n\s*name:\s*['"]dsh-remote['"]/)
  assert.doesNotMatch(patch, /name:\s*['"]dsh-better-sidebar['"]/)
  assert.doesNotMatch(patch, /id:\s*dsh-remote-sidebar/)
})
