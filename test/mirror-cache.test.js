// Mirror registry freshness: an optimistic new mirror must never be replaced by
// an older /bindings response, and a partial registry is not a healthy one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function section(start, end) {
  const a = src.indexOf(start)
  assert.ok(a >= 0, `missing source marker: ${start}`)
  const b = src.indexOf(end, a)
  assert.ok(b > a, `missing source marker: ${end}`)
  return src.slice(a, b)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeMirrorHarness(apiImpl) {
  const timers = [], picked = []
  const body = section('    const MIRRORS = { list: [], loaded: false, error: \'\' }', '    // Server identity colors')
    + section('      const commitPath = (p, selectedMachineId = machineId) => {', '      const acceptBrowserPick = (p) => {')
    + section('    function localWorkspaceSession(sessionId) {', '    function workspaceText')
    + '\nreturn { MIRRORS, ensureMirrors, refreshMirrors, mirrorForCwd, sameMirrorDir, commitPath, localWorkspaceSession, getMirrorLoad: () => mirrorLoad }'
  const factory = new Function(
    'api', 'machineId', 'busy', 'setPopOpen', 'killSuggestions', 'runPickerOperation',
    'ensureCurrent', 'tr', 'onPicked', 'registerWorkspace', 'setTimeout', 'sessionCwdFor', body,
  )
  const out = factory(
    apiImpl, 'm1', false, () => {}, () => {},
    async (_phase, task) => task(undefined, () => true),
    async () => {}, (key) => key,
    (...args) => { picked.push(args) }, true,
    (fn, ms) => { timers.push({ fn, ms }); return 0 },
    (id) => id === 'new' ? '/tmp/new' : '/outside',
  )
  return { ...out, timers, picked }
}

const mirrorResponse = (dir = '/tmp/new') => ({
  localMirror: dir, path: '/srv/new', machine: { host: 'host-a', port: 22, username: 'root' },
})
const row = (dir) => ({ dir, host: 'host-a', port: 22, username: 'root', remotePath: '/srv/new' })

test('a pre-commit bindings response cannot overwrite the optimistic mirror', async () => {
  const pending = deferred()
  const h = makeMirrorHarness((method, path) => {
    if (method === 'GET' && path === '/dsh-remote/bindings') return pending.promise
    if (path === '/dsh-remote/mirror') return Promise.resolve(mirrorResponse())
    throw new Error('unexpected request: ' + method + ' ' + path)
  })
  const initial = h.ensureMirrors()
  await h.commitPath('/srv/new', 'm1')
  assert.deepEqual(h.MIRRORS.list.map((m) => m.dir), ['/tmp/new'])
  pending.resolve({ mirrors: [] })
  await initial
  assert.deepEqual(h.MIRRORS.list.map((m) => m.dir), ['/tmp/new'], 'stale empty snapshot must not remove the new mirror')
  assert.equal(h.MIRRORS.loaded, false, 'a stale response must not mark the registry loaded')
  assert.equal(h.MIRRORS.error, '')
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0].ms, 2000)
})

test('refresh forces a new request and an old finally cannot clear its pointer', async () => {
  const calls = []
  const oldRequest = deferred(), freshRequest = deferred()
  const h = makeMirrorHarness((method, path) => {
    if (method === 'GET' && path === '/dsh-remote/bindings') {
      calls.push(path)
      return calls.length === 1 ? oldRequest.promise : freshRequest.promise
    }
    if (path === '/dsh-remote/mirror') return Promise.resolve(mirrorResponse())
    throw new Error('unexpected request: ' + method + ' ' + path)
  })
  const initial = h.ensureMirrors()
  await h.commitPath('/srv/new', 'm1')
  h.timers[0].fn()
  const refreshing = h.getMirrorLoad().promise
  assert.equal(calls.length, 2, 'refresh must not reuse the pre-commit request')
  oldRequest.resolve({ mirrors: [] })
  await initial
  const reused = h.ensureMirrors()
  assert.strictEqual(reused, refreshing, 'the current refresh promise must stay installed after the old finally')
  assert.equal(calls.length, 2, 'a stale pointer must not trigger a third request')
  freshRequest.resolve({ mirrors: [row('/tmp/new')] })
  await refreshing
  assert.equal(h.MIRRORS.loaded, true)
  assert.deepEqual(h.MIRRORS.list.map((m) => m.dir), ['/tmp/new'])
  assert.equal(h.getMirrorLoad(), null)
})

test('a failed authoritative registry stays distinguishable from an optimistic entry', async () => {
  const first = deferred(), refreshed = deferred()
  let bindingCalls = 0
  const h = makeMirrorHarness((method, path) => {
    if (method === 'GET' && path === '/dsh-remote/bindings') {
      bindingCalls += 1
      return bindingCalls === 1 ? first.promise : refreshed.promise
    }
    if (path === '/dsh-remote/mirror') return Promise.resolve(mirrorResponse())
    throw new Error('unexpected request: ' + method + ' ' + path)
  })
  const initial = h.ensureMirrors()
  first.reject(new Error('registry unavailable'))
  await initial
  assert.equal(h.MIRRORS.error, 'registry unavailable')
  await h.commitPath('/srv/new', 'm1')
  assert.equal(h.MIRRORS.error, 'registry unavailable', 'an optimistic entry must not fake a healthy full snapshot')
  assert.equal(h.localWorkspaceSession('unknown'), false, 'an unknown cwd must not become local while the registry is unhealthy')
  assert.ok(h.mirrorForCwd('/tmp/new', h.MIRRORS.list), 'the confirmed new mirror is still recognizable')

  const after = h.refreshMirrors()
  refreshed.resolve({ mirrors: [row('/tmp/new')] })
  await after
  assert.equal(h.MIRRORS.error, '')
  assert.equal(h.MIRRORS.loaded, true)
})

test('mirror path grammar preserves POSIX case and Windows case/separator semantics', () => {
  const h = makeMirrorHarness(() => { throw new Error('no requests expected') })
  assert.equal(h.sameMirrorDir('/Root/Proj', '/root/proj'), false, 'POSIX is case-sensitive')
  assert.equal(h.sameMirrorDir('C:\\Root\\Proj', 'c:/root/proj'), true, 'Windows folds case and separators')
  assert.equal(h.sameMirrorDir('/Root/Proj', 'c:/root/proj'), false, 'different path grammars never merge')
  assert.equal(h.sameMirrorDir('D', 'd'), false, 'a single-letter POSIX name is not a Windows drive')
  const windows = row('C:\\Root\\Proj')
  assert.strictEqual(h.mirrorForCwd('c:/root/proj/sub', [windows]), windows, 'Windows forward-slash child matches')
  const parent = row('/a/mirror')
  assert.equal(h.mirrorForCwd('/a/mirror-2', [parent]), null, 'sibling prefix is not containment')
  assert.equal(h.mirrorForCwd('/Root/Proj/sub', [row('/root/proj')]), null, 'POSIX case mismatch is not containment')
  const shallow = row('/a')
  const deep = row('/a/mirror')
  assert.strictEqual(h.mirrorForCwd('/a/mirror/sub', [shallow, deep]), deep, 'deepest mirror wins')
  const posixRoot = row('/')
  assert.strictEqual(h.mirrorForCwd('/etc', [posixRoot]), posixRoot, 'POSIX root contains absolute children')
  assert.strictEqual(h.mirrorForCwd('/', [posixRoot]), posixRoot, 'POSIX root matches itself')
  const driveRoot = row('D:\\')
  assert.strictEqual(h.mirrorForCwd('d:/work', [driveRoot]), driveRoot, 'Windows drive root contains children')
  assert.strictEqual(h.mirrorForCwd('D:\\', [driveRoot]), driveRoot, 'Windows drive root matches itself')
  const bareDriveRoot = row('D:')
  assert.strictEqual(h.mirrorForCwd('D:', [bareDriveRoot]), bareDriveRoot, 'bare drive root matches itself')
  assert.strictEqual(h.mirrorForCwd('D:/work', [bareDriveRoot]), bareDriveRoot, 'bare drive root contains children')
  const uncRoot = row('\\\\server\\share')
  assert.strictEqual(h.mirrorForCwd('//server/share/docs', [uncRoot]), uncRoot, 'UNC root contains children')
  assert.equal(h.sameMirrorDir('C:\\', 'c:/'), true, 'Windows root dedupes case/separator variants')
})
