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
  async changes() { return 'core-changes' }
}

function harness({ service, sftp, binding } = {}) {
  const effects = []
  const ctx = {
    inject(names, cb) {
      assert.deepEqual(names, ['workspaceFiles'])
      cb({
        get: (name) => (name === 'workspaceFiles' ? service : undefined),
        effect: (fn) => { effects.push(fn); return () => {} },
      })
    },
  }
  const handle = installWorkspaceFilesRemote(ctx, {
    resolveBinding: (cwd) => (binding === undefined ? (cwd === MIRROR.mirrorDir ? MIRROR : { mirrorDir: null, remotePath: '', machine: null }) : binding(cwd)),
    poolForMachine: (machine) => {
      assert.equal(machine?.host, MIRROR.machine.host, 'must dial the mirror-recorded machine, never the active one')
      return { sftp: async () => sftp }
    },
  })
  return { handle, effects }
}

const mirrorScope = { sessionId: 's1', workspaceRoot: MIRROR.mirrorDir }
const localScope = { sessionId: 's2', workspaceRoot: 'C:\\plain\\local' }

test('wraps read/readBytes/stat/list and leaves changes to the core', () => {
  const service = new CoreService()
  const { handle } = harness({ service, sftp: fakeSftp() })
  try {
    for (const name of ['read', 'readBytes', 'stat', 'list']) {
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