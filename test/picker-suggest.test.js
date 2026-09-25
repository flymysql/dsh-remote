// Remote path autocomplete in the workspace picker (DirPicker in
// lib/client.js) — regression coverage for the review findings against the
// 5246082 caching fix:
//   B1 ensureCurrent: one shared in-flight POST /current per machine; a failed
//      switch REJECTS so the fetch chain aborts WITHOUT caching a listing;
//      commitPath/pickHome surface the error instead of mirroring blindly.
//   B2 external-switch defense: /ls echoes the machine identity it was answered
//      for (lib/routes-fs.js); a mismatch busts the memo, forces one re-switch
//      and retries ONCE — a mismatched listing is never cached.
//   B3 reopen reset: a stale response from a previous open cannot repopulate
//      the cache or reopen the dropdown.
//   B4 fresh-fetch fencing: a superseded fetch must not overwrite the cache.
//   B5/B6 the shared suggest pipeline keeps the seq guard; continueSuggest is a
//      navigation step and fetches FRESH instead of serving cached entries.
//
// The functions are extracted from the shipped source (the repo's
// source-extraction + mock pattern, see test/i18n.test.js) and executed
// against a mocked api(), so these tests run the real shipped logic instead of
// a copy of it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createFsRoutes } from '../lib/routes-fs.js'
import { MemFs, makeSftp, seed } from './helpers.js'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Extract `const NAME = …` up to its balanced closing brace (strings and
 *  comments skipped). Fails loudly when the shipped source drifts. */
function extractConst(name) {
  const marker = 'const ' + name + ' = '
  const start = src.indexOf(marker)
  assert.ok(start >= 0, `lib/client.js must define ${marker.trim()}`)
  const open = src.indexOf('{', start)
  assert.ok(open >= 0, `const ${name} must have a brace body`)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    const c = src[j]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      for (j++; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue }
        if (src[j] === quote) break
      }
      continue
    }
    if (c === '/' && src[j + 1] === '/') {
      const nl = src.indexOf('\n', j)
      if (nl < 0) break
      j = nl
      continue
    }
    if (c === '/' && src[j + 1] === '*') {
      const end = src.indexOf('*/', j)
      if (end < 0) break
      j = end + 1
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(start, j + 1)
    }
  }
  assert.fail(`const ${name}: closing brace not found`)
}

const LS_TTL = (src.match(/const LS_TTL_MS = \d+/) || [])[0]
assert.ok(LS_TTL, 'lib/client.js must define LS_TTL_MS')

// The extraction contract: these names exist in DirPicker and are evaluated
// together (they call each other). Anything else they touch is passed in as a
// mocked dependency below.
const FN_NAMES = [
  'sortItems', 'joinDisplay', 'echoMatches', 'ensureCurrent', 'fetchDirList',
  'resetPickerFetchState', 'killSuggestions', 'suggestFrom',
  'loadSuggestions', 'continueSuggest', 'commitPath', 'pickHome',
]
const FACTORY_PARAMS = [
  'api', 'machines', 'parseLs', 'postedCurrentRef', 'currentPromiseRef',
  'lsCacheRef', 'lsInflightRef', 'lsGenRef', 'fetchSeqRef', 'suggestSeqRef',
  'setSuggest', 'setSuggestOpen', 'setPath', 'setErr', 'setPopOpen',
  'onPicked', 'tr', 'machineId', 'busy',
]

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function mockApi(fn) {
  const calls = []
  const api = (method, path, body) => {
    calls.push({ method, path, body })
    return fn(method, path, body)
  }
  return {
    api,
    calls,
    posts: () => calls.filter((c) => c.method === 'POST'),
    gets: () => calls.filter((c) => c.method === 'GET'),
  }
}

/** A /dsh-remote/ls response body. `names` ending in "/" are directories. */
function listing(names, { machine, path = '/proj' } = {}) {
  return {
    path,
    platform: 'posix',
    machine,
    items: names.map((n) => {
      const isDir = n.endsWith('/')
      const name = isDir ? n.slice(0, -1) : n
      return { type: isDir ? 'dir' : 'file', name, size: 1, mtime: 1, path: path + '/' + name }
    }),
  }
}

const M1_ECHO = { host: '10.0.0.1', port: 22, username: 'dev' }
const MACHINES = [
  { id: 'm1', host: '10.0.0.1', port: 22, username: 'dev' },
  { id: 'm2', host: '10.0.0.2', port: 22, username: 'root' },
  // alias machine: the pool target is the ~/.ssh/config RESOLVED identity
  { id: 'm3', host: 'alias-x', port: 22, username: 'root', useSshConfig: true,
    sshConfigResolved: { host: '10.0.0.7', port: 2222, username: 'lucas' } },
]

/** Evaluate the extracted shipped functions against mocked dependencies. */
function makePicker(api, { machines = MACHINES, machineId = 'm1' } = {}) {
  const ui = { suggest: [], suggestOpen: false, path: '', err: '', popOpen: true, picked: [] }
  const refs = {
    postedCurrentRef: { current: '' },
    currentPromiseRef: { current: null },
    lsCacheRef: { current: new Map() },
    lsInflightRef: { current: new Map() },
    lsGenRef: { current: new Map() },
    fetchSeqRef: { current: 0 },
    suggestSeqRef: { current: 0 },
  }
  const body = [LS_TTL, ...FN_NAMES.map(extractConst)].join('\n')
    + `\nreturn { ${FN_NAMES.filter((n) => n !== 'sortItems' && n !== 'joinDisplay' && n !== 'echoMatches').join(', ')} }`
  const factory = new Function(...FACTORY_PARAMS, body)
  const out = factory(
    api, machines, () => [],
    refs.postedCurrentRef, refs.currentPromiseRef, refs.lsCacheRef,
    refs.lsInflightRef, refs.lsGenRef, refs.fetchSeqRef, refs.suggestSeqRef,
    (s) => { ui.suggest = s },
    (b) => { ui.suggestOpen = b },
    (p) => { ui.path = p },
    (e) => { ui.err = String(e) },
    (b) => { ui.popOpen = !!b },
    (p) => { ui.picked.push(p) },
    (k) => k,
    machineId,
    false,
  )
  return { ...out, ...refs, ui }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// ── B1: ensureCurrent failure semantics ────────────────────────────────────

test('B1: a failed switch rejects, keeps the memo clear and caches nothing', async () => {
  let fail = true
  const mock = mockApi((method) => {
    if (method === 'POST') return fail ? Promise.reject(new Error('switch failed')) : Promise.resolve({ ok: true })
    return Promise.resolve(listing(['proj2/'], { machine: M1_ECHO }))
  })
  const picker = makePicker(mock.api)

  await assert.rejects(picker.fetchDirList('m1', '/proj'), /switch failed/)
  assert.equal(mock.gets().length, 0, '/ls must not run after a failed switch')
  assert.equal(picker.lsCacheRef.current.size, 0, 'a listing fetched under a failed switch must never be cached')
  assert.equal(picker.postedCurrentRef.current, '', 'the memo must not record a failed switch')

  // The failure must not suppress the switch retry (the old memo kept the
  // wrong machine "current" for the whole cache TTL).
  fail = false
  const node = await picker.fetchDirList('m1', '/proj')
  assert.deepEqual(node.all.map((x) => x.name), ['proj2'])
  assert.equal(mock.posts().length, 2, 'the next call must retry the switch POST')
  assert.equal(picker.lsCacheRef.current.size, 1, 'the successful retry may cache')
})

test('B1: concurrent callers share ONE in-flight switch and never overtake it', async () => {
  const gate = deferred()
  const mock = mockApi((method) => {
    if (method === 'POST') return gate.promise.then(() => ({ ok: true }))
    return Promise.resolve(listing([], { machine: M1_ECHO }))
  })
  const picker = makePicker(mock.api)

  const a = picker.fetchDirList('m1', '/proj')
  const b = picker.fetchDirList('m1', '/etc')
  const e1 = picker.ensureCurrent('m1')
  const e2 = picker.ensureCurrent('m1')
  assert.strictEqual(e1, e2, 'concurrent callers must share one in-flight promise')
  await tick()
  assert.equal(mock.posts().length, 1, 'concurrent requests must share ONE switch POST')
  assert.equal(mock.gets().length, 0, 'no /ls may run before the pending switch lands')

  gate.resolve()
  await Promise.all([a, b])
  assert.equal(mock.gets().length, 2, 'both listings load after the switch')
})

// ── B4: fresh-fetch fencing ────────────────────────────────────────────────

test('B4: a superseded fetch must not overwrite the cache', async () => {
  const gets = []
  const mock = mockApi((method) => {
    if (method === 'POST') return Promise.resolve({ ok: true })
    const d = deferred()
    gets.push(d)
    return d.promise
  })
  const picker = makePicker(mock.api)

  const stale = picker.fetchDirList('m1', '/proj') // pre-mkdir scan
  const fresh = picker.fetchDirList('m1', '/proj', true) // post-mkdir refresh
  await tick()
  gets[1].resolve(listing(['newdir/'], { machine: M1_ECHO })) // fresh lands first
  await fresh
  gets[0].resolve(listing([], { machine: M1_ECHO })) // pre-mkdir lands late
  const staleNode = await stale
  assert.deepEqual(staleNode.all.map((x) => x.name), [], 'a superseded fetch still resolves its own callers')

  const hit = picker.lsCacheRef.current.values().next().value
  assert.deepEqual(hit.node.all.map((x) => x.name), ['newdir'], 'the late pre-mkdir listing must not poison the cache')
  const again = await picker.fetchDirList('m1', '/proj')
  assert.deepEqual(again.all.map((x) => x.name), ['newdir'], 'follow-up reads see the post-mkdir listing')
  assert.equal(gets.length, 2, 'the follow-up must be served from the cache')
})

// ── B3: picker reopen reset ────────────────────────────────────────────────

test('B3: stale responses from a previous open cannot repopulate cache or dropdown', async () => {
  const gets = []
  const mock = mockApi((method) => {
    if (method === 'POST') return Promise.resolve({ ok: true })
    const d = deferred()
    gets.push(d)
    return d.promise
  })
  const picker = makePicker(mock.api)

  const stale = picker.fetchDirList('m1', '/proj')
  await tick() // let the mocked switch land so the /ls request is in flight
  picker.resetPickerFetchState() // the open-effect's reset
  gets[0].resolve(listing(['old/'], { machine: M1_ECHO }))
  await stale
  assert.equal(picker.lsCacheRef.current.size, 0, 'a stale response must not repopulate the cache after reopen')

  const sug = picker.suggestFrom('m1', '/proj', (n) => n.all.map((x) => x.path))
  await tick()
  picker.resetPickerFetchState()
  gets[1].resolve(listing(['x/'], { machine: M1_ECHO }))
  await sug
  assert.deepEqual(picker.ui.suggest, [], 'a stale suggestion response must not refill the dropdown')
  assert.equal(picker.ui.suggestOpen, false)

  // The reset must not break the live session that follows it.
  const ok = picker.fetchDirList('m1', '/proj')
  await tick()
  gets[2].resolve(listing(['live/'], { machine: M1_ECHO }))
  const node = await ok
  assert.deepEqual(node.all.map((x) => x.name), ['live'])
  assert.equal(picker.lsCacheRef.current.size, 1, 'post-reset fetches cache normally')
})

// ── B2: identity echo / external-switch defense ────────────────────────────

test('B2: an identity-echo mismatch busts the memo, re-switches and retries ONCE', async () => {
  const wrong = { host: '10.0.0.9', port: 22, username: 'dev' }
  let gets = 0
  const mock = mockApi((method) => {
    if (method === 'POST') return Promise.resolve({ ok: true })
    gets++
    return Promise.resolve(gets === 1
      ? listing(['from-wrong-machine/'], { machine: wrong })
      : listing(['right/'], { machine: M1_ECHO }))
  })
  const picker = makePicker(mock.api)

  const node = await picker.fetchDirList('m1', '/proj')
  assert.deepEqual(node.all.map((x) => x.name), ['right'], 'the re-switched retry must win')
  assert.equal(mock.posts().length, 2, 'a mismatch must force exactly one re-switch')
  assert.equal(gets, 2, 'exactly one retry — never a loop')
  const hit = picker.lsCacheRef.current.values().next().value
  assert.deepEqual(hit.node.all.map((x) => x.name), ['right'], 'only the matching listing is cached')
})

test('B2: a listing that mismatches on every attempt is returned but never cached', async () => {
  const wrong = { host: '10.0.0.9', port: 22, username: 'dev' }
  const mock = mockApi((method) => {
    if (method === 'POST') return Promise.resolve({ ok: true })
    return Promise.resolve(listing(['x/'], { machine: wrong }))
  })
  const picker = makePicker(mock.api)

  const node = await picker.fetchDirList('m1', '/proj')
  assert.deepEqual(node.all.map((x) => x.name), ['x'], 'callers still resolve their own result')
  assert.equal(mock.posts().length, 2, 'retry ONCE only')
  assert.equal(picker.lsCacheRef.current.size, 0, 'a mismatched listing must never be cached')
})

test('B2: an alias machine matches on its resolved identity (no false mismatch)', async () => {
  const resolvedEcho = { host: '10.0.0.7', port: 2222, username: 'lucas' }
  const mock = mockApi((method) => {
    if (method === 'POST') return Promise.resolve({ ok: true })
    return Promise.resolve(listing(['home/'], { machine: resolvedEcho }))
  })
  const picker = makePicker(mock.api)

  await picker.fetchDirList('m3', '/proj')
  assert.equal(mock.posts().length, 1, 'the resolved identity must count as a match (no re-switch)')
  assert.equal(picker.lsCacheRef.current.size, 1, 'a matching listing is cached')
})

// ── B5/B6: shared suggest pipeline, seq guard, fresh navigation ────────────

test('B5: stale suggestion responses are dropped (seq guard in the shared pipeline)', async () => {
  const gets = []
  const mock = mockApi((method) => {
    if (method === 'POST') return Promise.resolve({ ok: true })
    const d = deferred()
    gets.push(d)
    return d.promise
  })
  const picker = makePicker(mock.api)
  const pick = (n) => n.all.map((x) => x.path)

  // older keystroke resolves AFTER the newer one — must be dropped
  const older = picker.suggestFrom('m1', '/aaa', pick)
  const newer = picker.suggestFrom('m1', '/bbb', pick)
  await tick() // both /ls requests are now in flight
  gets[1].resolve(listing(['newer/'], { machine: M1_ECHO, path: '/bbb' }))
  await newer
  assert.deepEqual(picker.ui.suggest, ['/bbb/newer'])
  gets[0].resolve(listing(['older/'], { machine: M1_ECHO, path: '/aaa' }))
  await older
  assert.deepEqual(picker.ui.suggest, ['/bbb/newer'], 'the stale response must not overwrite the dropdown')

  // a response older than killSuggestions must leave the dropdown closed
  const killed = picker.suggestFrom('m1', '/ccc', pick)
  await tick()
  picker.killSuggestions() // e.g. the user closes the dropdown meanwhile
  gets[2].resolve(listing(['zombie/'], { machine: M1_ECHO, path: '/ccc' }))
  await killed
  assert.deepEqual(picker.ui.suggest, [], 'killSuggestions must drop the pending response')
  assert.equal(picker.ui.suggestOpen, false)
})

test('B5: loadSuggestions filters dirs by prefix through the shared pipeline', async () => {
  const mock = mockApi((method) => (method === 'POST'
    ? Promise.resolve({ ok: true })
    : Promise.resolve(listing(['foo/', 'food/', 'bar'], { machine: M1_ECHO }))))
  const picker = makePicker(mock.api)

  picker.loadSuggestions('/proj/fo', 'm1')
  await tick()
  assert.deepEqual(picker.ui.suggest, ['/proj/foo', '/proj/food'], 'dirs matching the typed prefix')
  assert.equal(picker.ui.suggestOpen, true)
})

test('B6: continueSuggest is a navigation step — fresh fetch, all entries', async () => {
  const gets = []
  const mock = mockApi((method) => {
    if (method === 'POST') return Promise.resolve({ ok: true })
    const d = deferred()
    gets.push(d)
    return d.promise
  })
  const picker = makePicker(mock.api)

  // prime the cache for /proj/src with a listing that is about to go stale
  const prime = picker.fetchDirList('m1', '/proj/src', false)
  await tick()
  gets[0].resolve(listing(['stale/'], { machine: M1_ECHO, path: '/proj/src' }))
  await prime

  picker.continueSuggest('/proj/src/')
  await tick()
  assert.equal(gets.length, 2, 'continueSuggest must not serve the cached (30s-stale) listing')
  gets[1].resolve(listing(['fresh/', 'file.txt'], { machine: M1_ECHO, path: '/proj/src' }))
  await tick()
  assert.deepEqual(picker.ui.suggest, ['/proj/src/fresh', '/proj/src/file.txt'], 'all entries of the expanded dir')
  assert.equal(picker.ui.suggestOpen, true)
})

// ── B1: error surfacing at the action call sites ───────────────────────────

test('B1: commitPath and pickHome surface a failed switch and do not act', async () => {
  const mock = mockApi((method, path) => {
    if (path === '/dsh-remote/current') return Promise.reject(new Error('switch failed'))
    return Promise.resolve({ localMirror: '/local/m', home: '/home/dev' })
  })
  const picker = makePicker(mock.api)

  picker.commitPath('/proj')
  await tick()
  assert.match(picker.ui.err, /switch failed/, 'commitPath must surface the switch error')
  assert.deepEqual(picker.ui.picked, [], 'no mirror may be built under the wrong machine')

  picker.pickHome()
  await tick()
  assert.match(picker.ui.err, /switch failed/, 'pickHome must surface the switch error')
  assert.deepEqual(mock.calls.map((c) => c.path).filter((p) => p !== '/dsh-remote/current'), [],
    'neither /mirror nor /home may run under the wrong machine')
})

// ── B2: the /ls identity echo (lib/routes-fs.js) ───────────────────────────

function sendJson(res, status, body) {
  res.statusCode = status
  res.payload = JSON.stringify(body)
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}
async function call(route, { method = 'GET', url, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from([Buffer.from(payload)])
  req.method = method
  req.url = url || route.path
  const res = { statusCode: 0, payload: '', setHeader() {}, end(chunk) { this.payload += chunk == null ? '' : String(chunk) } }
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.payload || 'null') }
}

function lsRouteFor(poolConfig) {
  const fs = new MemFs()
  seed(fs, { 'proj/src/a.ts': 'x' })
  const pool = {
    platform: 'posix',
    config: poolConfig,
    detect: async () => {},
    sftp: async () => makeSftp(fs),
  }
  const list = createFsRoutes({
    sendJson,
    readBody,
    resolveRequestBinding: async () => ({ ws: '/proj', host: poolConfig.host, username: poolConfig.username, port: poolConfig.port, bound: false, pool }),
    decodeBuf: (buf) => buf.toString('utf8'),
    encodeText: (s) => Buffer.from(String(s), 'utf8'),
    audit: () => {},
    config: { encoding: 'utf-8', maxFileBytes: 0 },
    mirrorDirFor: () => '/tmp/mirror',
  })
  return Object.fromEntries(list.map((r) => [r.path, r]))
}

test('B2: /ls echoes the machine identity it was answered for (pool target)', async () => {
  const routes = lsRouteFor({ host: '10.0.0.1', port: 2222, username: 'dev', commandTimeoutMs: 5000, encoding: 'utf-8' })
  const r = await call(routes['/dsh-remote/ls'], { url: '/dsh-remote/ls?path=/proj' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.machine, { host: '10.0.0.1', port: 2222, username: 'dev' },
    'the picker validates this echo against the machine it intended')
  assert.ok(r.json.items.some((it) => it.name === 'src'), 'listing still intact')
})
