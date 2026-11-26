// Issue #194: the core `workspaceFiles` Remote must serve mirror sessions from
// the REMOTE origin, and leave every other scope on the core implementation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installWorkspaceFilesRemote } from '../lib/workspace-files-remote.js'

const MIRROR = {
  mirrorDir: 'C:\\mirror\\proj',
  remotePath: '/srv/proj',
  machine: { host: '10.0.0.9', port: 2222, username: 'deploy' },
}

const attrsOf = (over = {}) => ({
  size: 0,
  mtime: 1700000000,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  ...over,
})

/**
 * A minimal SFTP surface: files keyed by absolute remote path with
 * { content, mtime?, dir?, link? }, listings keyed by directory with
 * [{ filename, dir?, link?, size? }]. lstat describes the entry itself,
 * stat follows links — the ssh2 contract the wrapper relies on.
 */
function fakeSftp({ files = {}, listings = {} } = {}) {
  const missing = () => Object.assign(new Error('No such file'), { code: 2 })
  const entryOf = (p) => {
    const f = files[p]
    if (!f) throw missing()
    return f
  }
  const statAttrs = (f) => attrsOf({
    size: f.dir ? 4096 : Buffer.byteLength(f.content ?? ''),
    mtime: f.mtime ?? 1700000000,
    isFile: () => !f.dir,
    isDirectory: () => !!f.dir,
  })
  return {
    calls: [],
    async lstat(p) {
      this.calls.push(['lstat', p])
      const f = entryOf(p)
      if (f.link) return attrsOf({ isFile: () => false, isSymbolicLink: () => true })
      return statAttrs(f)
    },
    async stat(p) {
      this.calls.push(['stat', p])
      return statAttrs(entryOf(p))
    },
    async readdir(p) {
      this.calls.push(['readdir', p])
      const list = listings[p]
      if (!list) throw missing()
      return list.map((e) => ({
        filename: e.name,
        attrs: attrsOf({
          isDirectory: () => !!e.dir,
          isFile: () => !e.dir && !e.link && !e.other,
          isSymbolicLink: () => !!e.link,
          size: e.size ?? 0,
        }),
      }))
    },
    async readPartial(p, offset, length) {
      this.calls.push(['readPartial', p, offset, length])
      const f = entryOf(p)
      const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content ?? ''))
      return buf.subarray(offset, offset + length)
    },
    async readFile(p) {
      this.calls.push(['readFile', p])
      const f = entryOf(p)
      return Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content ?? ''))
    },
  }
}

/** The core service as the Gateway sees it: methods on the PROTOTYPE. */
class CoreService {
  constructor(fail = new Error('core implementation must not be called for a mirror scope')) {
    this.fail = fail
    this.config = { maxBytes: 64, maxFileBytes: 256, maxLines: 10, maxEntries: 2 }
  }
  async read() { throw this.fail }
  async readBytes() { throw this.fail }
  async stat() { throw this.fail }
  async list() { throw this.fail }
  async search() { throw this.fail }
  async changes() { return 'core-changes' }
}

function harness({ service, sftp, binding, pool } = {}) {
  const effects = []
  const ctx = {
    inject(names, cb) {
      assert.deepEqual(names, ['workspaceFiles'])
      cb({
        get: (name) => (name === 'workspaceFiles' ? service : undefined),
        // cordis runs the effect body now and keeps whatever it returns as the
        // disposer, so the fake must do the same or the wrapping never lands.
        effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return () => {} },
      })
    },
  }
  const handle = installWorkspaceFilesRemote(ctx, {
    resolveBinding: (cwd) => (binding === undefined ? (cwd === MIRROR.mirrorDir ? MIRROR : { mirrorDir: null, remotePath: '', machine: null }) : binding(cwd)),
    poolForMachine: (machine) => {
      assert.equal(machine?.host, MIRROR.machine.host, 'must dial the mirror-recorded machine, never the active one')
      return pool ?? { sftp: async () => sftp }
    },
  })
  return { handle, effects }
}

const mirrorScope = { sessionId: 's1', workspaceRoot: MIRROR.mirrorDir }
const localScope = { sessionId: 's2', workspaceRoot: 'C:\\plain\\local' }

test('wraps read/readBytes/stat/list/search and leaves changes to the core', () => {
  const service = new CoreService()
  const { handle } = harness({ service, sftp: fakeSftp() })
  try {
    for (const name of ['read', 'readBytes', 'stat', 'list', 'search']) {
      assert.equal(typeof service[name], 'function')
      assert.notEqual(service[name], CoreService.prototype[name], `${name} wrapped`)
    }
    assert.equal(service.changes, CoreService.prototype.changes, 'changes stays the core watcher')
  } finally {
    handle.dispose()
  }
})

test('a non-mirror scope falls through to the core implementation', async () => {
  let coreCalls = 0
  const service = new CoreService()
  service.read = async () => { coreCalls++; return 'core' }
  const sftp = fakeSftp()
  const { handle } = harness({ service, sftp })
  try {
    assert.equal(await service.read(localScope, 'src/a.txt', {}), 'core')
    assert.equal(coreCalls, 1)
    assert.equal(sftp.calls.length, 0, 'no remote I/O for a local scope')
  } finally {
    handle.dispose()
  }
})

test('a scope whose mirror meta is unusable is not ours either', async () => {
  const service = new CoreService()
  service.stat = async () => 'core'
  const sftp = fakeSftp()
  const { handle } = harness({
    service,
    sftp,
    binding: () => ({ mirrorDir: null, remotePath: '', machine: null }),
  })
  try {
    assert.equal(await service.stat(localScope, 'a.txt'), 'core')
    assert.equal(sftp.calls.length, 0)
  } finally {
    handle.dispose()
  }
})

test('read serves a mirror session from the remote, page semantics intact', async () => {
  const content = 'one\ntwo\nthree\nfour\n'
  const service = new CoreService()
  const sftp = fakeSftp({ files: { '/srv/proj/src/notes.txt': { content } } })
  const { handle } = harness({ service, sftp })
  try {
    const page = await service.read(mirrorScope, 'src/notes.txt', { offset: 2, limit: 2 })
    assert.deepEqual(
      { text: page.text, lines: page.lines, offset: page.offset, eof: page.eof },
      { text: 'two\nthree', lines: 2, offset: 2, eof: false },
    )
    assert.equal(page.absolutePath, '/srv/proj/src/notes.txt')
    assert.equal(page.bytes, Buffer.byteLength(content))
    assert.equal(page.version, `sftp:1700000000:${Buffer.byteLength(content)}`)
  } finally {
    handle.dispose()
  }
})

test('read maps a local path inside the mirror onto the same remote file', async () => {
  const service = new CoreService()
  const sftp = fakeSftp({ files: { '/srv/proj/src/notes.txt': { content: 'x\n' } } })
  const { handle } = harness({ service, sftp })
  try {
    const page = await service.read(mirrorScope, 'C:\\mirror\\proj\\src\\notes.txt', {})
    assert.equal(page.absolutePath, '/srv/proj/src/notes.txt')
  } finally {
    handle.dispose()
  }
})

test('read refuses what the core refuses: directories, symlinks, missing files', async () => {
  const service = new CoreService()
  const sftp = fakeSftp({
    files: {
      '/srv/proj/dir': { content: '', dir: true },
      '/srv/proj/link': { content: 'x\n', link: true },
    },
  })
  const { handle } = harness({ service, sftp })
  try {
    await assert.rejects(service.read(mirrorScope, 'dir', {}), (e) => e.code === 'workspace-file/not-regular-file' && e.details.kind === 'directory')
    await assert.rejects(service.read(mirrorScope, 'link', {}), (e) => e.code === 'workspace-file/not-regular-file' && e.details.kind === 'symlink')
    await assert.rejects(service.read(mirrorScope, 'gone.txt', {}), (e) => e.code === 'workspace-file/not-found')
  } finally {
    handle.dispose()
  }
})

test('read enforces the deployment caps', async () => {
  const service = new CoreService() // maxLines 10, maxBytes 64, maxFileBytes 256
  const sftp = fakeSftp({ files: { '/srv/proj/big.txt': { content: ('x'.repeat(20) + '\n').repeat(50) } } })
  const { handle } = harness({ service, sftp })
  try {
    await assert.rejects(service.read(mirrorScope, 'big.txt', { limit: 11 }), (e) => e.code === 'gateway/bad-request')
    // 40 lines on one page ≈ 80 bytes > maxBytes 64
    await assert.rejects(service.read(mirrorScope, 'big.txt', { offset: 1, limit: 4 }), (e) => e.code === 'workspace-file/too-large')
    // Seeking a page past maxFileBytes scans too far
    await assert.rejects(service.read(mirrorScope, 'big.txt', { offset: 40, limit: 5 }), (e) => e.code === 'workspace-file/too-large')
  } finally {
    handle.dispose()
  }
})

test('read rejects non-UTF-8 and NUL content as not-text', async () => {
  const service = new CoreService()
  const sftp = fakeSftp({
    files: {
      '/srv/proj/bin.dat': { content: Buffer.from([0xff, 0xfe, 0x00, 0x01]) },
      '/srv/proj/nul.txt': { content: 'a' + String.fromCharCode(0) + '\nb\n' },
    },
  })
  const { handle } = harness({ service, sftp })
  try {
    await assert.rejects(service.read(mirrorScope, 'bin.dat', {}), (e) => e.code === 'workspace-file/not-text')
    await assert.rejects(service.read(mirrorScope, 'nul.txt', {}), (e) => e.code === 'workspace-file/not-text')
  } finally {
    handle.dispose()
  }
})

test('stat reports remote identity without content', async () => {
  const service = new CoreService()
  const sftp = fakeSftp({ files: { '/srv/proj/src/main.c': { content: 'int main(){}\n', mtime: 123 } } })
  const { handle } = harness({ service, sftp })
  try {
    const st = await service.stat(mirrorScope, 'src/main.c')
    assert.equal(st.absolutePath, '/srv/proj/src/main.c')
    assert.equal(st.bytes, 13)
    assert.equal(st.version, 'sftp:123:13')
    assert.ok(!('text' in st))
  } finally {
    handle.dispose()
  }
})

test('readBytes: window, full read, cap and baseFile resolution', async () => {
  const service = new CoreService() // maxBytes 64, maxFileBytes 256
  const sftp = fakeSftp({
    files: {
      '/srv/proj/blob.bin': { content: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]) },
      '/srv/proj/huge.bin': { content: Buffer.alloc(300) },
      '/srv/proj/docs/readme.md': { content: 'hi\n' },
    },
  })
  const { handle } = harness({ service, sftp })
  try {
    const win = await service.readBytes(mirrorScope, 'blob.bin', { range: { offset: 2, length: 3 } })
    assert.deepEqual([...win.data], [2, 3, 4])
    assert.equal(win.offset, 2)
    assert.equal(win.eof, false)
    assert.equal(win.bytes, 8)

    const full = await service.readBytes(mirrorScope, 'blob.bin', {})
    assert.deepEqual([...full.data], [0, 1, 2, 3, 4, 5, 6, 7])
    assert.equal(full.eof, true)

    await assert.rejects(service.readBytes(mirrorScope, 'huge.bin', {}), (e) => e.code === 'workspace-file/too-large')
    await assert.rejects(service.readBytes(mirrorScope, 'blob.bin', { range: { offset: 0, length: 65 } }), (e) => e.code === 'workspace-file/too-large')

    // baseFile: a relative target resolves against the base file's directory
    const rel = await service.readBytes(mirrorScope, '../blob.bin', { baseFile: 'docs/readme.md' })
    assert.equal(rel.absolutePath, '/srv/proj/blob.bin')
    // ... and an absolute target next to a baseFile is refused like the core
    await assert.rejects(
      service.readBytes(mirrorScope, '/srv/proj/blob.bin', { baseFile: 'docs/readme.md' }),
      (e) => e.code === 'gateway/bad-request',
    )
  } finally {
    handle.dispose()
  }
})

test('list: mapping, sort, cap, truncation and confinement', async () => {
  const service = new CoreService() // maxEntries 2
  const sftp = fakeSftp({
    files: { '/srv/proj/src': { content: '', dir: true }, '/srv/proj/src/alpha.c': { content: 'int a;\n' } },
    listings: {
      '/srv/proj/src': [
        { name: 'zeta.c', size: 10 },
        { name: 'alpha.c', size: 5 },
        { name: 'mid.c', size: 7 },
        { name: 'sub', dir: true },
        { name: 'dangling', link: true },
      ],
    },
  })
  const { handle } = harness({ service, sftp })
  try {
    const listing = await service.list(mirrorScope, 'src')
    assert.equal(listing.path, 'src')
    assert.equal(listing.truncated, true)
    assert.deepEqual(listing.entries.map((e) => e.name), ['alpha.c', 'dangling'])
    assert.deepEqual(listing.entries.map((e) => e.type), ['file', 'file'])
    assert.equal(listing.entries[0].size, 5)

    // A directory outside the remote workspace root stays confined.
    await assert.rejects(service.list(mirrorScope, '/etc'), (e) => e.code === 'workspace-file/outside-workspace')
    // A non-directory refuses like the core.
    await assert.rejects(service.list(mirrorScope, 'src/alpha.c'), (e) => e.code === 'workspace-file/not-directory')
    // Missing path.
    await assert.rejects(service.list(mirrorScope, 'gone'), (e) => e.code === 'workspace-file/not-found')
    // Empty path is a bad request, exactly like the core's inspect().
    await assert.rejects(service.list(mirrorScope, ''), (e) => e.code === 'gateway/bad-request')
  } finally {
    handle.dispose()
  }
})

test('an aborted signal fails before any remote I/O', async () => {
  const service = new CoreService()
  const sftp = fakeSftp({ files: { '/srv/proj/a.txt': { content: 'x\n' } } })
  const { handle } = harness({ service, sftp })
  try {
    const signal = AbortSignal.abort()
    await assert.rejects(service.read(mirrorScope, 'a.txt', {}, signal), (e) => e.name === 'AbortError')
    assert.equal(sftp.calls.length, 0)
  } finally {
    handle.dispose()
  }
})

test('dispose restores prototype methods and pre-existing own properties', async () => {
  const service = new CoreService()
  const ownOriginal = async () => 'own'
  service.stat = ownOriginal // a pre-existing OWN property must come back exactly
  const sftp = fakeSftp()
  const { handle } = harness({ service, sftp })
  handle.dispose()
  assert.equal(service.read, CoreService.prototype.read)
  assert.equal(service.list, CoreService.prototype.list)
  assert.equal(service.readBytes, CoreService.prototype.readBytes)
  assert.equal(service.search, CoreService.prototype.search)
  assert.equal(service.stat, ownOriginal)
  assert.equal(Object.hasOwn(service, 'read'), false)
  assert.equal(Object.hasOwn(service, 'stat'), true)
  // And the restored core serves local scopes again.
  service.read = async () => 'core-after-restore'
  assert.equal(await service.read(localScope, 'x', {}), 'core-after-restore')
})

test('effect-driven unload restores too (plugin lifetime ends)', async () => {
  const service = new CoreService()
  const sftp = fakeSftp()
  const { handle, effects } = harness({ service, sftp })
  assert.equal(effects.length, 1)
  effects[0]()
  assert.equal(service.read, CoreService.prototype.read)
  handle.dispose() // idempotent
  assert.equal(service.read, CoreService.prototype.read)
})

test('structural RemoteErrors carry the wire marker', async () => {
  const service = new CoreService()
  const sftp = fakeSftp({ files: {} })
  const { handle } = harness({ service, sftp })
  try {
    await assert.rejects(service.stat(mirrorScope, 'nothing.here'), (e) =>
      e.isDSHRemoteError === true && e.name === 'RemoteError' && e.code === 'workspace-file/not-found' && typeof e.message === 'string')
  } finally {
    handle.dispose()
  }
})

const searchRequest = (query, flags = {}) => ({ query, excludedPaths: [], includeHidden: false, respectGitignore: false, ...flags })
const fileMatch = path => ({ path, type: 'file' })
const dirMatch = path => ({ path, type: 'directory' })

test('search preserves the core receiver and arguments for non-mirror scopes', async t => {
  const service = new CoreService()
  const request = searchRequest('local-only')
  const signal = new AbortController().signal
  service.search = async function (...args) {
    assert.equal(this, service)
    assert.deepEqual(args, [localScope, request, signal])
    return { matches: [fileMatch('local-only')], truncated: false, incomplete: false }
  }
  const original = service.search
  const sftp = fakeSftp()
  const { handle } = harness({ service, sftp })
  t.after(() => handle.dispose())
  assert.deepEqual(await service.search(localScope, request, signal), await original.call(service, localScope, request, signal))
  assert.deepEqual(sftp.calls, [])
  handle.dispose()
  assert.equal(service.search, original)
})

test('SFTP search matches literal names and paths and infers only directories containing files', async t => {
  const service = new CoreService()
  const sftp = fakeSftp({
    files: { '/srv/proj': { dir: true } },
    listings: {
      '/srv/proj': [
        { name: 'tag-dir', dir: true }, { name: 'tag-empty', dir: true }, { name: 'tag-link', link: true },
        { name: 'tag-tty', other: true }, { name: 'Tag-ROOT' }, { name: '.tag-secret' }, { name: '.git', dir: true },
        { name: 'src', dir: true }, { name: 'test', dir: true },
      ],
      '/srv/proj/tag-dir': [{ name: 'child' }],
      '/srv/proj/tag-empty': [],
      '/srv/proj/src': [{ name: '[tag].JS' }, { name: 'tag.js' }, { name: 'tag[*]' }, { name: 'tag-exact', dir: true }],
      '/srv/proj/test': [{ name: 'tag[*]' }, { name: 'tag-exact', dir: true }],
      '/srv/proj/test/tag-exact': [{ name: 'child' }],
    },
  })
  const { handle } = harness({ service, sftp })
  t.after(() => handle.dispose())
  const flags = { excludedPaths: ['tag[*]', 'src/tag-exact'] }
  assert.deepEqual(await service.search(mirrorScope, searchRequest(' TAG ', flags)), {
    matches: [fileMatch('Tag-ROOT'), dirMatch('tag-dir'), fileMatch('src/[tag].JS'), fileMatch('src/tag.js'), dirMatch('test/tag-exact')],
    truncated: false,
    incomplete: false,
  })
  assert.deepEqual((await service.search(mirrorScope, searchRequest('src/[TAG]', flags))).matches, [fileMatch('src/[tag].JS')])
  assert.deepEqual((await service.search(mirrorScope, searchRequest('TAG-DIR/', flags))).matches, [fileMatch('tag-dir/child')])
  assert.deepEqual((await service.search(mirrorScope, searchRequest('.tag', { includeHidden: true }))).matches, [fileMatch('.tag-secret')])
  assert.ok(sftp.calls.every(([op, path]) => op === 'stat' || op === 'readdir' && !/\/\.(?:git|tag)|tag-link/.test(path)))
})

test('SFTP fallback applies workspace-local ignore rules and reports their limited coverage', async t => {
  const service = new CoreService()
  const sftp = fakeSftp({
    files: {
      '/srv/proj': { dir: true },
      '/srv/proj/.gitignore': { content: '*.tmp\ntag-out/\n' },
      '/srv/proj/src/.ignore': { content: '/tag-local\n' },
    },
    listings: {
      '/srv/proj': [{ name: '.gitignore' }, { name: 'tag.tmp' }, { name: 'tag-good' }, { name: 'tag-out', dir: true }, { name: 'src', dir: true }],
      '/srv/proj/tag-out': [{ name: 'tag-inner' }],
      '/srv/proj/src': [{ name: '.ignore' }, { name: 'tag-local' }, { name: 'tag-out' }],
    },
  })
  const { handle } = harness({ service, sftp })
  t.after(() => handle.dispose())
  assert.deepEqual(await service.search(mirrorScope, searchRequest('tag', { respectGitignore: true })), {
    matches: [fileMatch('tag-good'), fileMatch('src/tag-out')], truncated: false, incomplete: true,
  })
  assert.deepEqual(sftp.calls.filter(([op]) => op === 'readPartial').map(([, path]) => path), ['/srv/proj/.gitignore', '/srv/proj/src/.ignore'])
  sftp.calls.length = 0
  assert.deepEqual(await service.search(mirrorScope, searchRequest('tag')), {
    matches: [fileMatch('tag-good'), dirMatch('tag-out'), fileMatch('tag.tmp'), fileMatch('src/tag-local'), fileMatch('src/tag-out'), fileMatch('tag-out/tag-inner')],
    truncated: false,
    incomplete: false,
  })
  assert.ok(sftp.calls.every(([op]) => op !== 'readPartial'))
})

test('SFTP search honors a nested Windows session root and emits slash-joined paths', async t => {
  const service = new CoreService()
  const sftp = fakeSftp({
    files: { 'D:\\project\\src': { dir: true } },
    listings: { 'D:\\project\\src': [{ name: 'pkg', dir: true }], 'D:\\project\\src\\pkg': [{ name: 'Main.cs' }] },
  })
  const { handle } = harness({ service, sftp, binding: () => ({ ...MIRROR, remotePath: 'D:\\project' }) })
  t.after(() => handle.dispose())
  const scope = { ...mirrorScope, workspaceRoot: MIRROR.mirrorDir + '\\src' }
  assert.deepEqual(await service.search(scope, searchRequest('PKG/main')), {
    matches: [fileMatch('pkg/Main.cs')], truncated: false, incomplete: false,
  })
  assert.deepEqual(sftp.calls.map(([, dir]) => dir), ['D:\\project\\src', 'D:\\project\\src', 'D:\\project\\src\\pkg'])
})

test('search distinguishes a result cap, an exact file cap and incomplete discovery', async t => {
  const service = new CoreService()
  service.config.search = { maxResults: 1, maxEntries: 2 }
  const root = [{ name: 'z-tag' }, { name: 'a-tag' }]
  const sftp = fakeSftp({ files: { '/srv/proj': { dir: true } }, listings: { '/srv/proj': root } })
  const { handle } = harness({ service, sftp })
  t.after(() => handle.dispose())
  assert.deepEqual(await service.search(mirrorScope, searchRequest('tag')), {
    matches: [fileMatch('a-tag')], truncated: true, incomplete: false,
  })
  root.push({ name: 'm-tag' })
  assert.deepEqual(await service.search(mirrorScope, searchRequest('z-tag')), {
    matches: [], truncated: false, incomplete: true,
  })
  root.splice(2, 1, { name: 'private', dir: true })
  assert.deepEqual(await service.search(mirrorScope, searchRequest('tag')), {
    matches: [fileMatch('a-tag')], truncated: true, incomplete: true,
  })
})

test('POSIX search streams NUL delimited rg paths and preserves partial discovery', async t => {
  const service = new CoreService()
  const sftp = fakeSftp({ files: { '/srv/proj': { dir: true } } })
  const pool = {
    platform: 'posix',
    sftp: async () => sftp,
    async exec(script, { onData }) {
      assert.equal(script.startsWith("cd '/srv/proj' || exit 125; exec rg "), true)
      assert.ok(script.includes("'--no-config' '--files' '--sort=path' '--null' '--path-separator=/'"))
      assert.ok(script.includes("'--hidden'"))
      assert.ok(script.includes("'--glob=!/src/name'\\''s\\[x\\]'"))
      const output = Buffer.from('src/TAG-é\nfile\0tag.md\0')
      const split = output.indexOf(Buffer.from('é')) + 1
      onData('stdout', output.subarray(0, split))
      onData('stderr', Buffer.from('permission denied'))
      onData('stdout', output.subarray(split))
      return { code: 2, stdout: '…[truncated]', signal: null }
    },
  }
  const { handle } = harness({ service, pool })
  t.after(() => handle.dispose())
  assert.deepEqual(await service.search(mirrorScope, searchRequest('tag', { includeHidden: true, excludedPaths: ["src/name's[x]"] })), {
    matches: [fileMatch('tag.md'), fileMatch('src/TAG-é\nfile')], truncated: false, incomplete: true,
  })
  assert.deepEqual(sftp.calls, [['stat', '/srv/proj']])
})

test('rg search cancels its own stream at the first file past the cap', async t => {
  const service = new CoreService()
  service.config.search = { maxEntries: 1 }
  const sftp = fakeSftp({ files: { '/srv/proj': { dir: true } } })
  const pool = {
    platform: 'posix',
    sftp: async () => sftp,
    async exec(_script, { signal, onData }) {
      onData('stdout', Buffer.from('tag-a\0tag-b\0tag-c\0'))
      assert.equal(signal.aborted, true)
      return { code: -1, signal: 'ABORTED' }
    },
  }
  const { handle } = harness({ service, pool })
  t.after(() => handle.dispose())
  const signal = new AbortController().signal
  assert.deepEqual(await service.search(mirrorScope, searchRequest('tag'), signal), {
    matches: [fileMatch('tag-a')], truncated: false, incomplete: true,
  })
  assert.equal(signal.aborted, false)
  assert.deepEqual(sftp.calls, [['stat', '/srv/proj']])
})

test('search refuses invalid roots and rejects cancellation with the exact reason', async t => {
  const service = new CoreService()
  const sftp = fakeSftp({ files: {} })
  const { handle } = harness({ service, sftp })
  t.after(() => handle.dispose())
  await assert.rejects(service.search(mirrorScope, searchRequest(' ')), { code: 'gateway/bad-request' })
  const reason = new Error('steered away')
  await assert.rejects(service.search(mirrorScope, searchRequest('tag'), AbortSignal.abort(reason)), error => error === reason)
  assert.deepEqual(sftp.calls, [])
  await assert.rejects(service.search(mirrorScope, searchRequest('tag')), { code: 'workspace-file/not-found' })
  sftp.stat = async () => attrsOf()
  await assert.rejects(service.search(mirrorScope, searchRequest('tag')), { code: 'workspace-file/not-directory' })

  sftp.stat = async () => attrsOf({ isDirectory: () => true })
  const started = Promise.withResolvers()
  const stalled = Promise.withResolvers()
  t.after(() => stalled.resolve([]))
  sftp.readdir = () => { started.resolve(); return stalled.promise }
  const controller = new AbortController()
  const pending = service.search(mirrorScope, searchRequest('tag'), controller.signal)
  await started.promise
  controller.abort(reason)
  await assert.rejects(pending, error => error === reason)
  service.config.search = { timeoutMs: 20 }
  await assert.rejects(service.search(mirrorScope, searchRequest('tag')), { code: 'workspace-file/search-failed' })
})

test('registered workspaceFiles search sees new remote names and omits stale mirror names', async t => {
  const { createHost, machine } = await import('./harness/plugin-host.js')
  const { startFakeSsh } = await import('./harness/fake-ssh.js')
  const { writeFileSync, realpathSync } = await import('node:fs')
  const { join } = await import('node:path')
  const service = new CoreService()
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: { '/home/user/proj/initial': '' } })
  t.after(() => srv.close())
  const rec = machine(srv.machine({ workspace: '/home/user/proj' }))
  const host = await createHost({ machines: [rec], services: { workspaceFiles: service } })
  t.after(() => host.dispose())
  const mirror = await host.call('/dsh-remote/mirror', { body: { path: rec.workspace, machineId: rec.id } })
  assert.equal(mirror.json.ok, true, mirror.raw)
  // macOS spells its temp dir through /var, while the harness may record the
  // /private/var realpath (or the reverse). Bind through the same physical path
  // the plugin resolves, exactly as a real session's cwd would.
  const local = realpathSync(mirror.json.localMirror)
  writeFileSync(join(local, 'stale-tag.txt'), 'mirror only')
  srv.fs.write('/home/user/proj/new/tag.txt', 'remote only')
  assert.deepEqual(await service.search({ sessionId: 'mirror', workspaceRoot: local }, searchRequest('tag')), {
    matches: [fileMatch('new/tag.txt')], truncated: false, incomplete: false,
  })
})
