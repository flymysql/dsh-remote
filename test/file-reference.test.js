// Remote `@file` completion (issue #39).
//
// The bug: `@` in a dsh-remote session listed NOTHING. The harness's only
// file-reference provider indexes the agent session's LOCAL cwd, and a remote
// session's cwd is the local mirror — which `ensureMirror()` creates empty.
//
// These tests pin the replacement behaviour with a fake `listDir`, so they need
// no SSH server: relative candidate paths, drill-down, bounded fuzzy indexing,
// the failure circuit breaker, and the overlay's promise to leave LOCAL
// sessions (and a missing seam) completely alone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RemoteWorkspaceIndex, createRemoteFileReference, installFileReferenceOverlay,
  rankCandidates, isSafeRelativeDir,
  DEFAULT_EXCLUDED_DIRECTORIES,
} from '../lib/file-reference.js'

/** A fake remote tree: absolute POSIX path → 'dir' | 'file'. */
const TREE = {
  '/proj': 'dir',
  '/proj/README.md': 'file',
  '/proj/.env': 'file',
  '/proj/node_modules': 'dir',
  '/proj/node_modules/left-pad': 'dir',
  '/proj/node_modules/left-pad/index.js': 'file',
  '/proj/src': 'dir',
  '/proj/src/main.c': 'file',
  '/proj/src/util.c': 'file',
  '/proj/src/deep': 'dir',
  '/proj/src/deep/nested.c': 'file',
  '/proj/docs': 'dir',
  '/proj/docs/guide.md': 'file',
  '/proj/.config': 'dir',
  '/proj/.config/hidden.json': 'file',
}

/**
 * `listDir(relDir)` over TREE, with the same call shape index.js supplies.
 * @param {string} root
 * @param {{calls?: string[], failOn?: string}} [opts]
 */
function makeListDir(root, opts = {}) {
  const calls = opts.calls || []
  return async (rel) => {
    const dir = rel ? `${root}/${rel}` : root
    calls.push(rel)
    if (opts.failOn !== undefined && rel === opts.failOn) throw new Error('sftp unavailable')
    const prefix = dir === '/' ? '/' : `${dir}/`
    const seen = new Set()
    const out = []
    for (const [p, kind] of Object.entries(TREE)) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      if (!rest || rest.includes('/')) continue
      if (seen.has(rest)) continue
      seen.add(rest)
      out.push({ name: rest, kind: kind === 'dir' ? 'directory' : 'file' })
    }
    return out
  }
}

const makeIndex = (opts = {}) => new RemoteWorkspaceIndex({
  listDir: makeListDir('/proj', opts),
  ...opts,
})

test('list("") returns the workspace root, relative paths, directories first', async () => {
  const got = await makeIndex().list('')
  const paths = got.map((c) => c.path)
  assert.ok(paths.includes('src'))
  assert.ok(paths.includes('README.md'))
  // dot-entries stay hidden for a bare listing, and node_modules is excluded
  assert.ok(!paths.includes('.env'))
  assert.ok(!paths.includes('.config'))
  assert.ok(!paths.includes('node_modules'))
  assert.equal(got[0].kind, 'directory')
})

test('list("sr") drills like the local provider: "src/" continues one level', async () => {
  const dir = await makeIndex().list('src/')
  const paths = dir.map((c) => c.path).sort()
  assert.deepEqual(paths, ['src/deep', 'src/main.c', 'src/util.c'])
  assert.equal(dir.find((c) => c.path === 'src/deep').kind, 'directory')
})

test('list("src/mai") returns the matching file of that directory', async () => {
  const got = await makeIndex().list('src/mai')
  assert.deepEqual(got.map((c) => c.path), ['src/main.c'])
})

test('a bare query is fuzzy over the whole remote tree (and skips excluded dirs)', async () => {
  const got = await makeIndex().list('main')
  assert.deepEqual(got.map((c) => c.path), ['src/main.c'])
  const nested = await makeIndex().list('nested')
  assert.deepEqual(nested.map((c) => c.path), ['src/deep/nested.c'])
  // node_modules is never traversed, so its files can never be suggested
  assert.deepEqual(await makeIndex().list('left-pad'), [])
})

test('a dot-prefixed query exposes hidden entries explicitly', async () => {
  const got = await makeIndex().list('.env')
  assert.deepEqual(got.map((c) => c.path), ['.env'])
  const hiddenDir = await makeIndex().list('.config/')
  assert.deepEqual(hiddenDir.map((c) => c.path), ['.config/hidden.json'])
})

test('a ".." segment can never escape the remote workspace root', async () => {
  assert.equal(isSafeRelativeDir('..'), false)
  assert.equal(isSafeRelativeDir('src/../..'), false)
  assert.equal(isSafeRelativeDir('/etc'), false)
  assert.equal(isSafeRelativeDir('src/deep'), true)
  const calls = []
  const index = new RemoteWorkspaceIndex({ listDir: makeListDir('/proj', { calls }) })
  assert.deepEqual(await index.list('../etc/'), [])
  assert.deepEqual(calls, [])
})

test('the fuzzy index answers from a stale snapshot and rebuilds behind the caret', async () => {
  let clock = 0
  const calls = []
  const index = new RemoteWorkspaceIndex({
    listDir: makeListDir('/proj', { calls }),
    cacheTtlMs: 1000,
    now: () => clock,
  })
  assert.deepEqual((await index.list('main')).map((c) => c.path), ['src/main.c'])
  const afterFirst = calls.length
  // Within the TTL: no second traversal.
  clock = 500
  await index.list('main')
  assert.equal(calls.length, afterFirst)
  // Past the TTL: the stale entries answer immediately and a rebuild starts.
  clock = 2000
  await index.list('main')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(calls.length > afterFirst)
})

test('invalidate() forces the next bare query to rebuild', async () => {
  const calls = []
  const index = new RemoteWorkspaceIndex({ listDir: makeListDir('/proj', { calls }), now: () => 0 })
  await index.list('main')
  const afterFirst = calls.length
  index.invalidate()
  await index.list('main')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(calls.length > afterFirst)
})

test('indexing is bounded by the entry budget and reports truncation', async () => {
  const index = new RemoteWorkspaceIndex({ listDir: makeListDir('/proj'), maxEntries: 2 })
  const got = await index.list('c') // bare-ish fuzzy query over a tiny index
  assert.ok(got.length <= 2)
  assert.equal(index.truncated, true)
})

test('indexing is bounded by the wall-clock deadline', async () => {
  let clock = 0
  let dirs = 0
  const index = new RemoteWorkspaceIndex({
    listDir: async (rel) => { dirs += 1; clock += 1000; return makeListDir('/proj')(rel) },
    timeoutMs: 100,
    now: () => clock,
  })
  const got = await index.list('main')
  assert.equal(index.truncated, true)
  assert.ok(dirs < Object.keys(TREE).length)
  assert.deepEqual(got, [])
})

test('a directory listing failure inside the tree degrades to an empty subtree, not a crash', async () => {
  const errors = []
  const index = new RemoteWorkspaceIndex({
    listDir: async (rel) => {
      if (rel === 'docs') throw new Error('permission denied')
      return makeListDir('/proj')(rel)
    },
    onError: (err) => errors.push(String(err.message)),
  })
  const got = await index.list('guide')
  assert.deepEqual(got, [])
  assert.deepEqual(errors, ['permission denied'])
})

test('an unreachable root surfaces as a failure (the caller decides what to do)', async () => {
  const index = new RemoteWorkspaceIndex({ listDir: makeListDir('/proj', { failOn: '' }) })
  // Both a root listing and a bare (whole-tree) query must reach the root.
  await assert.rejects(() => index.list('main'), /sftp unavailable/)
  await assert.rejects(() => index.list(''), /sftp unavailable/)
})

test('an aborted query rejects instead of answering', async () => {
  const index = makeIndex()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => index.list('', controller.signal), /abort/i)
})

test('provider: reports null on failure and opens a cooldown, then recovers', async () => {
  let clock = 1000
  let failing = true
  const provider = createRemoteFileReference({
    listDir: async (rel) => {
      if (failing) throw new Error('ssh down')
      return makeListDir('/proj')(rel)
    },
    config: { failureCooldownMs: 5000 },
    onError: () => {},
    now: () => clock,
  })
  assert.equal(provider.ready(), true)
  assert.equal(await provider.list('', undefined), null) // null → overlay falls back to local
  provider.markDown()
  assert.equal(provider.ready(), false)
  clock += 5000
  assert.equal(provider.ready(), true)
  failing = false
  const got = await provider.list('src/')
  assert.ok(got.some((c) => c.path === 'src/main.c'))
  provider.dispose()
  assert.deepEqual(await provider.list('src/'), [])
})

test('provider: a successful directory listing never rejects', async () => {
  const provider = createRemoteFileReference({ listDir: makeListDir('/proj'), config: {} })
  const got = await provider.list('', undefined)
  assert.ok(Array.isArray(got) && got.length > 0)
})

// Continues the remote `@` completion line (issue #39, ff5042d / v0.8.22): the
// overlay's failure cooldown exists for flaky TRANSPORTS, so one bad path — a
// typo like `@nope/fi`, an EACCES directory — must answer only its own query
// (like scan() degrading an unreadable subtree), never open the breaker.
test('provider: a missing/unreadable directory answers that query empty without opening the breaker', async () => {
  let clock = 1000
  const provider = createRemoteFileReference({
    // ssh2 reports SFTP status codes NUMERICALLY (readdir on a missing path →
    // code 2 = SSH_FX_NO_SUCH_FILE), while main.js's listDir re-wraps an
    // unreadable one as `browse failed: Permission denied` (listDirStructured
    // keeps no code), so both real-world shapes are exercised here.
    listDir: async (rel) => {
      if (rel === 'nope') {
        const missing = new Error('No such file or directory')
        missing.code = 2
        throw missing
      }
      if (rel === 'locked') throw new Error('browse failed: Permission denied')
      return makeListDir('/proj')(rel)
    },
    config: { failureCooldownMs: 5000 },
    onError: () => {},
    now: () => clock,
  })
  // A bad completion query: an empty result for THAT query — not `null`,
  // which the overlay reads as "host down" and answers from the mirror.
  assert.deepEqual(await provider.list('nope/fi', undefined), [])
  assert.equal(provider.ready(), true)
  // An EACCES directory is per-path too: same degradation, breaker stays shut.
  assert.deepEqual(await provider.list('locked/ma', undefined), [])
  assert.equal(provider.ready(), true)
  // Legal queries keep resolving from the remote tree throughout.
  assert.deepEqual((await provider.list('src/ma', undefined)).map((c) => c.path), ['src/main.c'])
  assert.equal(provider.ready(), true)
  provider.dispose()
})

// ── the overlay over ctx.fileReferences ────────────────────────────────────

/** Wire installFileReferenceOverlay() to a fake service + fake cordis ctx. */
function harness({ resolve, listImpl } = {}) {
  const state = { injected: null, effects: [], disposed: false, remoteCalls: [] }
  const service = {
    list: listImpl || ((agent, query) => {
      state.remoteCalls.push({ kind: 'local', query })
      return Promise.resolve([{ path: 'mirror-only.txt', kind: 'file' }])
    }),
  }
  const ctx = { inject: (deps, cb) => { state.injected = { deps, cb }; return { dispose: () => { state.disposed = true } } } }
  const handle = installFileReferenceOverlay(ctx, { resolve, onError: () => {} })
  state.injected.cb({ fileReferences: service, effect: (fn) => state.effects.push(fn) })
  return { state, service, handle }
}

const remoteAgent = { session: { header: { cwd: '/home/u/proj' } } }
const localAgent = { session: { header: { cwd: '/home/u/local-repo' } } }

test('overlay: a remote agent is served from the remote tree', async () => {
  const provider = createRemoteFileReference({ listDir: makeListDir('/proj'), config: {} })
  const { state, service } = harness({
    resolve: (agent) => (agent === remoteAgent ? provider : null),
  })
  const got = await service.list(remoteAgent, 'src/')
  assert.ok(got.some((c) => c.path === 'src/main.c'))
  assert.equal(state.remoteCalls.length, 0)
})

test('overlay: a LOCAL agent is delegated to the original provider untouched', async () => {
  const { state, service } = harness({ resolve: () => null })
  const got = await service.list(localAgent, 'anything')
  assert.deepEqual(got, [{ path: 'mirror-only.txt', kind: 'file' }])
  assert.equal(state.remoteCalls.length, 1)
})

test('overlay: a null (failed) remote answer falls back to the local provider', async () => {
  let markedDown = 0
  const { service, state } = harness({
    resolve: () => ({ ready: () => true, markDown: () => { markedDown += 1 }, list: async () => null }),
  })
  const got = await service.list(remoteAgent, 'main')
  assert.deepEqual(got, [{ path: 'mirror-only.txt', kind: 'file' }])
  assert.equal(markedDown, 1)
  assert.equal(state.remoteCalls.length, 1)
})

test('overlay: a rejecting remote listing falls back and opens the breaker', async () => {
  let markedDown = 0
  const { service } = harness({
    resolve: () => ({ ready: () => true, markDown: () => { markedDown += 1 }, list: async () => { throw new Error('boom') } }),
  })
  assert.deepEqual(await service.list(remoteAgent, 'main'), [{ path: 'mirror-only.txt', kind: 'file' }])
  assert.equal(markedDown, 1)
})

// Same line as above (issue #39, ff5042d / v0.8.22), through the overlay: one
// bad `@` query must not exile the whole session to the stale local mirror
// for failureCooldownMs — a per-path failure answers its own query empty and
// leaves the provider ready, while a transport failure still trips the breaker
// with exactly the original cooldown semantics.
test('overlay: a per-path completion failure never marks the provider down; a transport failure still does', async () => {
  let clock = 1000
  let transport = false
  let transportMessage = ''
  const provider = createRemoteFileReference({
    listDir: async (rel) => {
      // A broken pool/connection raises transport-shaped errors (see lib/pool.js
      // `_sftp`), which must keep opening the breaker.
      if (transport) throw new Error(transportMessage || 'ssh sftp failed: connect ECONNREFUSED 10.0.0.1:22')
      if (rel === 'nope') {
        const missing = new Error('No such file or directory')
        missing.code = 2 // ssh2 SSH_FX_NO_SUCH_FILE (numeric status)
        throw missing
      }
      return makeListDir('/proj')(rel)
    },
    config: { failureCooldownMs: 5000 },
    onError: () => {},
    now: () => clock,
  })
  const { state, service } = harness({ resolve: () => provider })
  // One BAD query (`@nope/fi`): empty candidates for that query, the provider
  // stays ready, and the (empty until synced) local mirror is never consulted.
  assert.deepEqual(await service.list(remoteAgent, 'nope/fi'), [])
  assert.equal(provider.ready(), true)
  assert.equal(state.remoteCalls.length, 0)
  // Legal completions still resolve from the remote tree, right after the bad
  // query and later — no window where every keystroke hits the mirror instead.
  assert.ok((await service.list(remoteAgent, 'src/')).some((c) => c.path === 'src/main.c'))
  assert.equal(provider.ready(), true)
  assert.equal(state.remoteCalls.length, 0)
  // A TRANSPORT failure keeps the original semantics: fall back to the local
  // mirror and open the cooldown window for failureCooldownMs…
  transport = true
  assert.deepEqual(await service.list(remoteAgent, 'src/'), [{ path: 'mirror-only.txt', kind: 'file' }])
  assert.equal(state.remoteCalls.length, 1)
  assert.equal(provider.ready(), false)
  // …a legal query during the window still resolves, via the mirror…
  assert.deepEqual(await service.list(remoteAgent, 'docs/'), [{ path: 'mirror-only.txt', kind: 'file' }])
  assert.equal(state.remoteCalls.length, 2)
  // …and after the cooldown the remote tree answers again.
  transport = false
  clock += 5000
  assert.equal(provider.ready(), true)
  assert.ok((await service.list(remoteAgent, 'src/')).some((c) => c.path === 'src/main.c'))
  assert.equal(state.remoteCalls.length, 2)
  // The OpenSSH handshake-failure shape stays TRANSPORT even though it mentions
  // "Permission denied": classifying it per-path would let every keystroke pay
  // a full connect timeout without ever opening the breaker — the exact stall
  // the breaker exists to prevent.
  transport = true
  transportMessage = 'sftp session to build.example timed out: Permission denied (publickey)'
  assert.deepEqual(await service.list(remoteAgent, 'src/'), [{ path: 'mirror-only.txt', kind: 'file' }])
  assert.equal(provider.ready(), false)
  transportMessage = ''
  clock += 5000
  assert.equal(provider.ready(), true)
  provider.dispose()
})

test('overlay: a cooling-down provider is skipped entirely (no remote round trip)', async () => {
  let listCalls = 0
  const { service } = harness({
    resolve: () => ({ ready: () => false, markDown: () => {}, list: async () => { listCalls += 1; return [] } }),
  })
  await service.list(remoteAgent, 'main')
  assert.equal(listCalls, 0)
})

test('overlay: a throwing resolve() is contained and local behaviour survives', async () => {
  const { service } = harness({ resolve: () => { throw new Error('resolve exploded') } })
  assert.deepEqual(await service.list(remoteAgent, 'main'), [{ path: 'mirror-only.txt', kind: 'file' }])
})

test('overlay: dispose() restores the original list implementation', async () => {
  const { service, handle } = harness({ resolve: () => null })
  const patched = service.list
  handle.dispose()
  assert.notEqual(service.list, patched)
  assert.deepEqual(await service.list(remoteAgent, 'main'), [{ path: 'mirror-only.txt', kind: 'file' }])
})

test('overlay: dispose() never clobbers a later patch by someone else', async () => {
  const { service, handle } = harness({ resolve: () => null })
  const foreign = () => Promise.resolve([])
  service.list = foreign
  handle.dispose()
  assert.equal(service.list, foreign)
})

test('overlay: a missing (or older) ctx.inject is a no-op, not a crash', () => {
  assert.equal(installFileReferenceOverlay({}, { resolve: () => null }), undefined)
  assert.equal(installFileReferenceOverlay(undefined, { resolve: () => null }), undefined)
  assert.equal(installFileReferenceOverlay({ inject: () => {} }, {}), undefined)
})

test('rankCandidates: exact > prefix > shorter path, directories win ties, non-matches drop out', () => {
  const candidates = [
    { path: 'src/util.c', kind: 'file' },
    { path: 'main.c', kind: 'file' },
    { path: 'src/main', kind: 'directory' },
    { path: 'src/mainx.c', kind: 'file' },
  ]
  const got = rankCandidates(candidates, 'main', 10).map((c) => c.path)
  assert.deepEqual(got, ['src/main', 'main.c', 'src/mainx.c'])
})

test('default exclusions cover the usual dependency/build noise', () => {
  for (const name of ['.git', 'node_modules', 'dist', 'build', '__pycache__']) {
    assert.ok(DEFAULT_EXCLUDED_DIRECTORIES.includes(name))
  }
})
