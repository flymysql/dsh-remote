// Issue #228 — the core `workspaceFiles.search` enumerates the LOCAL MIRROR
// with ripgrep, so a remote file that has not been synced yet is invisible
// to the core workspace search even though the remote panel already lists
// it. The mirror-session seam from #194 now covers search too: enumerate
// with `rg --files` over the remote root, admit name/path matches exactly
// like the core (case-insensitive substring; with `/` the query matches the
// workspace-relative path), infer ancestor directories, and answer the
// core's { matches, truncated, incomplete } vocabulary with workspace-relative
// paths.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installWorkspaceFilesRemote } from '../lib/workspace-files-remote.js'

const MIRROR = {
  mirrorDir: 'C:\\mirror\\proj',
  remotePath: '/srv/proj',
  machine: { host: '10.0.0.9', port: 2222, username: 'deploy' },
}

/** The core service as the Gateway sees it (search added by the newer host). */
class CoreService {
  constructor() {
    this.config = { maxBytes: 64, maxFileBytes: 256, maxLines: 10, maxEntries: 2 }
    this.coreCalls = []
  }
  async read() { throw new Error('core must not serve a mirror scope') }
  async readBytes() { throw new Error('core must not serve a mirror scope') }
  async stat() { throw new Error('core must not serve a mirror scope') }
  async list() { throw new Error('core must not serve a mirror scope') }
  async search(scope, request) {
    this.coreCalls.push({ scope, request })
    return { matches: [{ path: 'core-local.txt', type: 'file' }], truncated: false, incomplete: false }
  }
  async changes() { return 'core-changes' }
}

const ROOT_ATTRS = { isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false }

function fakePool({ exec, sftp }) {
  return {
    sftp: async () => sftp,
    exec: async (script, opts) => {
      exec.calls.push({ script, opts })
      return exec.result(script)
    },
  }
}

function harness({ service, sftp, execResult }) {
  const exec = {
    calls: [],
    result: execResult,
  }
  const ctx = {
    inject(names, cb) {
      cb({
        get: (name) => (name === 'workspaceFiles' ? service : undefined),
        effect: () => {},
      })
    },
  }
  return installWorkspaceFilesRemote(ctx, {
    resolveBinding: (cwd) => (cwd === MIRROR.mirrorDir ? MIRROR : null),
    poolForMachine: () => fakePool({ exec, sftp }),
  })
}

const ROOT_LSTAT = { ...ROOT_ATTRS }
const rootSftp = {
  async lstat(p) {
    if (p === '/srv/proj') return ROOT_LSTAT
    throw Object.assign(new Error('No such file'), { code: 2 })
  },
  async stat(p) {
    if (p === '/srv/proj') return ROOT_LSTAT
    throw Object.assign(new Error('No such file'), { code: 2 })
  },
}

const LISTED = [
  '/srv/proj/README.md',
  '/srv/proj/src/app.js',
  '/srv/proj/src/util.js',
  '/srv/proj/dsh-search-probe.txt',
  '/srv/proj/docs/nested/notes.txt',
].join('\n')

test('#228: search is wrapped for mirror sessions (older hosts without it stay untouched)', () => {
  const service = new CoreService()
  const handle = harness({
    service,
    sftp: rootSftp,
    execResult: () => ({ code: 0, stdout: LISTED, stderr: '' }),
  })
  try {
    assert.equal(typeof service.search, 'function')
    assert.notEqual(service.search, CoreService.prototype.search, 'search is now routed through the mirror seam')
  } finally {
    handle.dispose()
  }
})

test('#228: a remote-only file (never synced) is found by the core workspace search', async () => {
  const service = new CoreService()
  const handle = harness({
    service,
    sftp: rootSftp,
    execResult: () => ({ code: 0, stdout: LISTED, stderr: '' }),
  })
  try {
    const result = await service.search({ sessionId: 's1', workspaceRoot: MIRROR.mirrorDir }, { query: 'dsh-search-probe', excludedPaths: [], includeHidden: false, respectGitignore: true })
    assert.ok(result.matches.some((m) => m.path === 'dsh-search-probe.txt' && m.type === 'file'),
      `the never-synced remote file must be found — got ${JSON.stringify(result)}`)
    assert.equal(service.coreCalls.length, 0, 'the mirror scope must NOT fall through to the local-mirror core search')
  } finally {
    handle.dispose()
  }
})

test('#228: ancestor directories are inferred and sorted shallow-first', async () => {
  const service = new CoreService()
  const handle = harness({
    service,
    sftp: rootSftp,
    execResult: () => ({ code: 0, stdout: LISTED, stderr: '' }),
  })
  try {
    const result = await service.search({ workspaceRoot: MIRROR.mirrorDir }, { query: 'nested' })
    const paths = result.matches.map((m) => m.path)
    // A name query matches entry NAMES: 'nested' appears in the directory
    // name, not in 'notes.txt' — so the file itself is NOT a match; its
    // ancestor directory is (and is therefore inferred). This is the core's
    // exact admit() rule.
    assert.ok(paths.includes('docs/nested'), 'the ancestor directory matches by name and is inferred')
    assert.ok(!paths.includes('docs/nested/notes.txt'), 'the file basename does not contain the needle — not a match')
    assert.ok(paths.every((p, i) => i === 0 || p.split('/').length >= paths[i - 1].split('/').length),
      'results are sorted shallow-first (fewer path segments first)')
  } finally {
    handle.dispose()
  }
})

test('#228: a query with / matches the workspace-relative path, not just the basename', async () => {
  const service = new CoreService()
  const handle = harness({
    service,
    sftp: rootSftp,
    execResult: () => ({ code: 0, stdout: LISTED, stderr: '' }),
  })
  try {
    const byName = await service.search({ workspaceRoot: MIRROR.mirrorDir }, { query: 'app' })
    assert.ok(byName.matches.some((m) => m.path === 'src/app.js'))
    const byPath = await service.search({ workspaceRoot: MIRROR.mirrorDir }, { query: 'src/app' })
    assert.ok(byPath.matches.some((m) => m.path === 'src/app.js'), 'path-form query matches the relative path')
  } finally {
    handle.dispose()
  }
})

test('#228: a non-mirror scope keeps the core search untouched', async () => {
  const service = new CoreService()
  const handle = harness({
    service,
    sftp: rootSftp,
    execResult: () => ({ code: 0, stdout: LISTED, stderr: '' }),
  })
  try {
    const result = await service.search({ workspaceRoot: 'C:\\plain\\local' }, { query: 'core-local' })
    assert.deepEqual(result.matches, [{ path: 'core-local.txt', type: 'file' }])
    assert.equal(service.coreCalls.length, 1, 'a plain local scope still uses the core implementation')
  } finally {
    handle.dispose()
  }
})

test('#228: an empty query is a gateway/bad-request', async () => {
  const service = new CoreService()
  const handle = harness({
    service,
    sftp: rootSftp,
    execResult: () => ({ code: 0, stdout: LISTED, stderr: '' }),
  })
  try {
    await assert.rejects(
      () => service.search({ workspaceRoot: MIRROR.mirrorDir }, { query: '   ' }),
      (err) => err && err.code === 'gateway/bad-request',
    )
  } finally {
    handle.dispose()
  }
})

/** A pool whose exec streams NUL records through onData, like both real backends. */
function streamingPool({ records, code = 0, stderr = '' }) {
  const calls = []
  return {
    calls,
    sftp: async () => rootSftp,
    async exec(script, opts = {}) {
      calls.push({ script, opts })
      for (const record of records) {
        opts.onData?.('stdout', record + '\u0000')
        if (opts.signal?.aborted) return { code: null, signal: 'ABORTED', stdout: '', stderr }
      }
      return { code, stdout: '', stderr }
    },
  }
}

test('#228: an empty directory is zero matches, not a failure (rg exits 1)', async () => {
  const service = new CoreService()
  const handle = harness({
    service,
    sftp: rootSftp,
    execResult: () => ({ code: 1, stdout: '', stderr: '' }),
  })
  try {
    const result = await service.search({ workspaceRoot: MIRROR.mirrorDir }, { query: 'anything' })
    assert.deepEqual(result, { matches: [], truncated: false, incomplete: false },
      'rg --files exits 1 when nothing matches; that is an empty result, not an error')
  } finally {
    handle.dispose()
  }
})

test('#228: streamed enumeration finds a file past maxOutputChars instead of truncating', async () => {
  const service = new CoreService()
  const records = []
  for (let i = 0; i < 6000; i += 1) records.push('/srv/proj/bulk/file-' + String(i).padStart(5, '0') + '-' + 'x'.repeat(40) + '.txt')
  records.push('/srv/proj/needle-at-the-end.txt')
  let body = ''
  for (const record of records) body += record + '\u0000'
  assert.ok(body.length > 200000, 'the fixture must exceed the default maxOutputChars')
  const pool = streamingPool({ records })
  const handle = installWorkspaceFilesRemote({
    inject(names, cb) { cb({ get: () => service, effect: () => {} }) },
  }, {
    resolveBinding: (cwd) => (cwd === MIRROR.mirrorDir ? MIRROR : null),
    poolForMachine: () => pool,
  })
  try {
    const result = await service.search({ workspaceRoot: MIRROR.mirrorDir }, { query: 'needle-at-the-end' })
    assert.deepEqual(result.matches, [{ path: 'needle-at-the-end.txt', type: 'file' }],
      'the last record must survive even though buffered stdout would have been cut at 200k')
    assert.equal(result.incomplete, false)
  } finally {
    handle.dispose()
  }
})

test('#228: exceeding maxEntries stops the stream and reports incomplete', async () => {
  const service = new CoreService()
  service.config.search = { maxEntries: 100, maxResults: 50 }
  const records = []
  for (let i = 0; i < 500; i += 1) records.push('/srv/proj/f' + i + '.txt')
  const pool = streamingPool({ records })
  const handle = installWorkspaceFilesRemote({
    inject(names, cb) { cb({ get: () => service, effect: () => {} }) },
  }, {
    resolveBinding: (cwd) => (cwd === MIRROR.mirrorDir ? MIRROR : null),
    poolForMachine: () => pool,
  })
  try {
    const result = await service.search({ workspaceRoot: MIRROR.mirrorDir }, { query: 'f4' })
    assert.equal(result.incomplete, true, 'a cap must be reported, not silently swallowed')
    assert.deepEqual(result.matches.map((m) => m.path), ['f4.txt', 'f40.txt', 'f41.txt', 'f42.txt', 'f43.txt', 'f44.txt', 'f45.txt', 'f46.txt', 'f47.txt', 'f48.txt', 'f49.txt'].filter((p) => Number(p.slice(1, -4)) < 100))
    assert.ok(pool.calls.at(-1).opts.signal.aborted, 'the stream is aborted once the cap is reached')
  } finally {
    handle.dispose()
  }
})

test('#228: the find fallback honours hidden and excluded filters and admits partial coverage', async () => {
  const service = new CoreService()
  const records = ['./keep.txt', './.hidden.txt', './src/.cache/y.txt', './draft/z.txt']
  const pool = streamingPool({ records, stderr: 'DSH_REMOTE_SEARCH_FALLBACK' })
  const handle = installWorkspaceFilesRemote({
    inject(names, cb) { cb({ get: () => service, effect: () => {} }) },
  }, {
    resolveBinding: (cwd) => (cwd === MIRROR.mirrorDir ? MIRROR : null),
    poolForMachine: () => pool,
  })
  try {
    const result = await service.search({ workspaceRoot: MIRROR.mirrorDir }, {
      query: '.txt', includeHidden: false, respectGitignore: true, excludedPaths: ['draft'],
    })
    assert.deepEqual(result.matches, [{ path: 'keep.txt', type: 'file' }],
      'hidden files and excluded subtrees must not leak through the fallback')
    assert.equal(result.incomplete, true, 'find cannot apply gitignore rules; say so')
  } finally {
    handle.dispose()
  }
})

test('#228: wrappers stay installed until the effect disposer runs', async () => {
  const service = new CoreService()
  let disposeEffect
  const handle = installWorkspaceFilesRemote({
    inject(names, cb) {
      cb({ get: () => service, effect: (fn) => { disposeEffect = fn() } })
    },
  }, { resolveBinding: (cwd) => (cwd === MIRROR.mirrorDir ? MIRROR : null), poolForMachine: () => fakePool({ exec: { calls: [], result: () => ({ code: 0, stdout: LISTED, stderr: '' }) }, sftp: rootSftp }) })
  assert.notEqual(service.search, CoreService.prototype.search, 'the seam must still be installed after inject() returns')
  disposeEffect()
  assert.equal(service.search, CoreService.prototype.search, 'teardown restores the core implementation')
  handle.dispose()
})
