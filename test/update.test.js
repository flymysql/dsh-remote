// Self-update + host-half hot swap.
//
// The pieces under test are the ones that can corrupt an install or lie to the
// UI: the atomic file replace (the browser half is hot-swapped and would serve a
// torn write), the byte-identical skip, the tarball version gate, the module
// cache clear, and the loader-entry re-init that makes a landed update actually
// run. Everything runs against a temp dir + a fabricated npm tarball, so no
// network and no real install are involved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

/** 仓库根目录：少数断言需要读源码本身（例如确认某条路由的分支结构）。 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

import {
  applyUpdate,
  clearSelfModuleCache,
  diskVersion,
  fetchLatestVersion,
  gtVersion,
  isInstalledCopy,
  LOADED_VERSION,
  reloadSelf,
  scheduleSelfReload,
  selfDir,
  writeFileAtomic,
} from '../lib/update.js'

// ── fabricated npm tarball (POSIX ustar, regular files only) ──────────────

/** One 512-byte ustar header for a regular file of `size` bytes. */
function tarHeader(name, size) {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('000644 \0', 100, 8, 'ascii') // mode
  h.write('000000 \0', 108, 8, 'ascii') // uid
  h.write('000000 \0', 116, 8, 'ascii') // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  h.write('00000000000\0', 136, 12, 'ascii') // mtime
  h.write('        ', 148, 8, 'ascii') // checksum placeholder
  h.write('0', 156, 1, 'ascii') // typeflag: regular file
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}

/** Build a gzipped tar whose entries live under `package/`. */
function makeTarball(files) {
  const chunks = []
  for (const [rel, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    chunks.push(tarHeader('package/' + rel, data.length), data)
    const pad = Math.ceil(data.length / 512) * 512 - data.length
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024)) // end-of-archive
  return gzipSync(Buffer.concat(chunks))
}

/** A fetch stand-in serving the registry endpoint + one tarball. */
function makeFetch({ version, tarball }) {
  return async (url) => {
    if (String(url).endsWith('/latest')) {
      return { ok: true, status: 200, json: async () => ({ version }) }
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
    }
  }
}

/** A temp install dir seeded with an older version of the package. */
function makeInstall({ index = 'OLD INDEX', client = 'OLD CLIENT', version = '0.1.0' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-update-'))
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  writeFileSync(path.join(dir, 'lib', 'index.js'), index)
  writeFileSync(path.join(dir, 'lib', 'client.js'), client)
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-remote', version }, null, 2))
  return dir
}

// The host half carries a sanity gate (>= 100 bytes) so a truncated download can
// never replace a working lib/index.js — the fixtures must clear it.
const NEW_INDEX = '// NEW INDEX\n' + 'x'.repeat(180) + '\n'
const NEW_FILES = {
  'lib/index.js': NEW_INDEX,
  'lib/client.js': '// NEW CLIENT\n' + 'y'.repeat(180) + '\n',
  'package.json': JSON.stringify({ name: 'dsh-remote', version: '0.2.0' }, null, 2),
}

// ── applyUpdate ──────────────────────────────────────────────────────────

test('applyUpdate installs the tarball and marks the version', async () => {
  const dir = makeInstall()
  try {
    const res = await applyUpdate('0.2.0', {
      dir,
      fetchImpl: makeFetch({ version: '0.2.0', tarball: makeTarball(NEW_FILES) }),
    })
    assert.equal(res.ok, true)
    assert.equal(res.to, '0.2.0')
    assert.equal(readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8'), NEW_INDEX)
    assert.equal(readFileSync(path.join(dir, 'lib', 'client.js'), 'utf8'), NEW_FILES['lib/client.js'])
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.2.0')
    // The marker is what tells the UI a swap is still owed.
    assert.equal(readFileSync(path.join(dir, '.dsh-remote-updated'), 'utf8'), '0.2.0')
    assert.deepEqual(res.changed.sort(), ['lib/client.js', 'lib/index.js', 'package.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyUpdate installs .cjs helpers and nested lib files', async () => {
  // ★ 回归：0.8.92 给 web-attach.js 加了 `import './posix-shell.cjs'`，而更新器
  // 只复制顶层 `lib/*.js` 且跳过子目录。自动更新落盘后，下次启动 import 就抛
  // ERR_MODULE_NOT_FOUND，整个插件一条 entry 都激活不了（0.8.92 实测）。
  const dir = makeInstall()
  const files = {
    ...NEW_FILES,
    'lib/posix-shell.cjs': 'module.exports = { posixViaSh: (command) => command }\n',
    'lib/tui/scene.js': 'export const scene = 1\n',
  }
  try {
    const res = await applyUpdate('0.2.0', {
      dir,
      fetchImpl: makeFetch({ version: '0.2.0', tarball: makeTarball(files) }),
    })
    assert.equal(readFileSync(path.join(dir, 'lib', 'posix-shell.cjs'), 'utf8'), files['lib/posix-shell.cjs'])
    assert.equal(readFileSync(path.join(dir, 'lib', 'tui', 'scene.js'), 'utf8'), files['lib/tui/scene.js'])
    assert.ok(res.changed.includes('lib/posix-shell.cjs'), res.changed.join(','))
    assert.ok(res.changed.includes('lib/tui/scene.js'), res.changed.join(','))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyUpdate leaves no temp files and skips byte-identical files', async () => {
  const dir = makeInstall()
  const fetchImpl = makeFetch({ version: '0.2.0', tarball: makeTarball(NEW_FILES) })
  try {
    await applyUpdate('0.2.0', { dir, fetchImpl })
    const first = statSync(path.join(dir, 'lib', 'index.js')).mtimeMs

    // Re-applying the same version must be a no-op on content: churning mtimes
    // would make the client-half HMR re-hash (and the host half reload) for
    // nothing.
    const again = await applyUpdate('0.2.0', { dir, fetchImpl })
    assert.deepEqual(again.changed, [])
    assert.equal(statSync(path.join(dir, 'lib', 'index.js')).mtimeMs, first)

    const leftovers = readdirSync(path.join(dir, 'lib')).filter((n) => n.includes('dsh-tmp'))
    assert.deepEqual(leftovers, [])
    assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.dsh-remote-update-')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyUpdate refuses a version mismatch without touching the install', async () => {
  const dir = makeInstall()
  try {
    // Tarball claims 0.3.0 while 0.2.0 was requested.
    const wrong = makeTarball({ ...NEW_FILES, 'package.json': JSON.stringify({ name: 'dsh-remote', version: '0.3.0' }, null, 2) })
    await assert.rejects(
      () => applyUpdate('0.2.0', { dir, fetchImpl: makeFetch({ version: '0.3.0', tarball: wrong }) }),
      /version mismatch/,
    )
    assert.equal(readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8'), 'OLD INDEX')
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.1.0')
    assert.equal(existsSync(path.join(dir, '.dsh-remote-updated')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyUpdate surfaces a failed download as update failed', async () => {
  const dir = makeInstall()
  try {
    await assert.rejects(
      () => applyUpdate('0.2.0', { dir, fetchImpl: async () => ({ ok: false, status: 500 }) }),
      /update failed: download failed \(HTTP 500\)/,
    )
    assert.equal(readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8'), 'OLD INDEX')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeFileAtomic replaces content and cleans up its temp file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-atomic-'))
  try {
    const dest = path.join(dir, 'client.js')
    writeFileSync(dest, 'v1')
    writeFileAtomic(dest, Buffer.from('v2'))
    assert.equal(readFileSync(dest, 'utf8'), 'v2')
    assert.deepEqual(readdirSync(dir), ['client.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── loaded vs on-disk version ────────────────────────────────────────────

test('LOADED_VERSION is the version of the code in this process', () => {
  // Import-time snapshot: readVersion() reads package.json off disk, so after an
  // update lands the two legitimately differ. `current` must never be the disk
  // value or the UI cannot tell "applied" from "active".
  assert.match(LOADED_VERSION, /^\d+\.\d+\.\d+/)
  assert.match(diskVersion(), /^\d+\.\d+\.\d+/)
})

test('gtVersion orders dotted versions', () => {
  assert.equal(gtVersion('0.8.10', '0.8.9'), true)
  assert.equal(gtVersion('0.8.9', '0.8.10'), false)
  assert.equal(gtVersion('0.8.9', '0.8.9'), false)
  assert.equal(gtVersion('1.0.0', '0.9.9'), true)
})

// ── registry probing must report WHY it failed ───────────────────────────
//
// 回归：fetchLatestVersion 原先把任何失败压成 null，调用方只能笼统报
// "无法连接 npm registry"。实测本机被 npm 限流（/latest 返回 429，而根路径 200、
// CI 从别的出口 IP 正常）却被显示成"连不上"，把"稍等即可"误导成"网络坏了"。

test('fetchLatestVersion returns the version on success', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ version: '9.9.9' }) })
    assert.deepEqual(await fetchLatestVersion(100), { version: '9.9.9' })
  } finally { globalThis.fetch = real }
})

test('fetchLatestVersion names rate limiting instead of a vague network error', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) })
    const r = await fetchLatestVersion(100)
    assert.equal(r.reason, 'rate-limited')
    assert.equal(r.status, 429)
    assert.match(r.error, /429/)
    // 这是关键：必须能区分"限流"与"连不上"，两者的处置不同
    assert.notEqual(r.error, '无法连接 npm registry')
  } finally { globalThis.fetch = real }
})

test('fetchLatestVersion distinguishes other HTTP failures from network ones', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
    const r = await fetchLatestVersion(100)
    assert.equal(r.reason, 'http')
    assert.match(r.error, /503/)
  } finally { globalThis.fetch = real }
})

test('fetchLatestVersion reports a timeout as a timeout', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
    const r = await fetchLatestVersion(100)
    assert.equal(r.reason, 'timeout')
    assert.match(r.error, /超时/)
  } finally { globalThis.fetch = real }
})

test('fetchLatestVersion reports a plain network failure', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error('ENOTFOUND') }
    const r = await fetchLatestVersion(100)
    assert.equal(r.reason, 'network')
  } finally { globalThis.fetch = real }
})

test('fetchLatestVersion rejects a malformed payload rather than returning junk', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
    const r = await fetchLatestVersion(100)
    assert.equal(r.reason, 'malformed')
    assert.equal(r.version, undefined)
  } finally { globalThis.fetch = real }
})

test('the update check still reports local state when the registry fails', () => {
  // 回归：registry 失败时若整条响应 ok:false，客户端就不会 setUpd，面板会永远停在
  // 「版本信息加载中…」——看起来像卡死，而本地版本/更新模式其实都已知。
  // The route lives in lib/routes-update.js since the issue #82 extraction;
  // the shape contract it pins is unchanged.
  const src = readFileSync(path.join(root, 'lib', 'routes-update.js'), 'utf8')
  const route = src.slice(src.indexOf("path: '/dsh-remote/update-check'"))
  const body = route.slice(0, route.indexOf('kind: \'exact\'', 10))
  assert.match(body, /if \(probe\.error\)/, 'the route must branch on a probe error')
  assert.match(body, /ok: true, \.\.\.base/, 'a registry failure must still return local state with ok:true')
  assert.match(body, /registryError:/, 'the failure reason must be surfaced separately')
})

// ── refusing to overwrite a source checkout ──────────────────────────────

test('isInstalledCopy distinguishes a node_modules install from a checkout', () => {
  // 实测依据：Node 的 ESM 解析会对符号链接做 realpath，所以以 link:/开发模式
  // 安装时 selfDir() 指向的是**源码仓库**。auto 默认开启后，一次自动更新就会
  // 用 npm 包覆盖它（丢改动、脏工作树）——所以必须能识别出来并拒绝。
  // 两条分支都要真被测到（用参数注入，而不是只测当前运行位置那一条）。
  assert.equal(isInstalledCopy('C:\\Users\\x\\.dsh\\profiles\\web\\node_modules\\dsh-remote'), true)
  assert.equal(isInstalledCopy('/home/x/.dsh/profiles/web/node_modules/dsh-remote'), true)
  assert.equal(isInstalledCopy('D:\\work\\dsh_work\\dsh-remote'), false, 'a checkout must not count as installed')
  assert.equal(isInstalledCopy('/home/x/src/dsh-remote'), false)
  // 本测试进程从仓库运行 ⇒ 走真实 selfDir() 也应是 false
  assert.equal(isInstalledCopy(), false)
})

test('applyUpdate refuses to touch a non-installed copy', async () => {
  // 不传 options.dir 时走真实 selfDir()（本仓库 = 非安装副本）⇒ 必须拒绝，
  // 且不得产生任何网络请求或文件改动。
  let fetched = false
  await assert.rejects(
    () => applyUpdate('0.2.0', { fetchImpl: async () => { fetched = true; return { ok: false, status: 500 } } }),
    /refusing to self-update/,
  )
  assert.equal(fetched, false, 'must refuse before downloading anything')
})

// ── host-half hot swap ───────────────────────────────────────────────────

/** A loader stub whose loadCache holds this package's own module URLs. */
function makeLoader() {
  const loadCache = new Map()
  for (const name of ['index.js', 'update.js']) {
    loadCache.set(pathToFileURL(path.join(selfDir(), 'lib', name)).href, { stub: true })
  }
  return { internal: { loadCache } }
}

test('clearSelfModuleCache drops this package own modules only', () => {
  const loader = makeLoader()
  const foreign = pathToFileURL(path.join(selfDir(), 'lib', 'not-a-module.js')).href
  loader.internal.loadCache.set(foreign, { stub: true })

  const cleared = clearSelfModuleCache(loader)
  assert.equal(cleared, 2)
  assert.equal(Map.prototype.has.call(loader.internal.loadCache, pathToFileURL(path.join(selfDir(), 'lib', 'index.js')).href), false)
  assert.equal(Map.prototype.has.call(loader.internal.loadCache, foreign), true)
})

test('clearSelfModuleCache tolerates a loader with no loadCache', () => {
  assert.equal(clearSelfModuleCache(undefined), 0)
  assert.equal(clearSelfModuleCache({}), 0)
})

test('clearSelfModuleCache honours an explicit package dir', () => {
  // The swap is exercised against a fixture install in the E2E script, so the
  // lib/ to evict must be overridable rather than pinned to selfDir().
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-clear-'))
  try {
    mkdirSync(path.join(dir, 'lib'), { recursive: true })
    writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const a = 1\n')
    const url = pathToFileURL(path.join(dir, 'lib', 'index.js')).href
    const loadCache = new Map([[url, { stub: true }]])
    assert.equal(clearSelfModuleCache({ internal: { loadCache } }, dir), 1)
    assert.equal(Map.prototype.has.call(loadCache, url), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clearSelfModuleCache evicts .cjs helpers and nested lib modules too', () => {
  // 同一个过滤缺陷的镜像问题：`.cjs` 通过 import() 载入时既进 ESM loadCache
  // 也进 require.cache，只清顶层 `.js` 会让热切换继续跑旧模块。
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-clear-cjs-'))
  try {
    mkdirSync(path.join(dir, 'lib', 'tui'), { recursive: true })
    writeFileSync(path.join(dir, 'lib', 'posix-shell.cjs'), 'module.exports = {}\n')
    writeFileSync(path.join(dir, 'lib', 'tui', 'scene.js'), 'export const scene = 1\n')
    const urls = [
      pathToFileURL(path.join(dir, 'lib', 'posix-shell.cjs')).href,
      pathToFileURL(path.join(dir, 'lib', 'tui', 'scene.js')).href,
    ]
    const loadCache = new Map(urls.map((url) => [url, { stub: true }]))
    assert.equal(clearSelfModuleCache({ internal: { loadCache } }, dir), 2)
    for (const url of urls) assert.equal(Map.prototype.has.call(loadCache, url), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reloadSelf clears the disabled flag DSH 0.2 writes when a fiber is disposed', async () => {
  // DSH 0.2 loader: disposing a fiber sets options.disabled and writes the
  // tree. The client scanner then skips that row, so a hot reload brings the
  // host back without the settings page. A reload is not an uninstall.
  const calls = []
  const entry = {
    options: { id: 'dsh-remote', name: 'dsh-remote' },
    parent: { tree: { write() { calls.push('write') } } },
    fiber: {
      dispose: async () => {
        calls.push('fiber.dispose')
        entry.options.disabled = true
      },
    },
    init: async () => { calls.push('init') },
  }
  const res = await reloadSelf({ internal: { loadCache: new Map() }, entries: () => [entry] })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(entry.options.disabled, undefined)
  assert.deepEqual(calls, ['fiber.dispose', 'write', 'init'])
})

test('reloadSelf restores the enabled flag through the new loader change journal and waits for startup', async () => {
  const calls = []
  const entry = {
    options: { id: 'dsh-remote', name: 'dsh-remote' },
    parent: { tree: { commit(change) {
      assert.equal(change.id, 'dsh-remote'); assert.equal(change.group, entry.parent)
      assert.equal(change.legacy.disabled, true); assert.equal(change.options.disabled, undefined)
      calls.push('commit')
    } } },
    fiber: { dispose: async () => { entry.options.disabled = true; calls.push('dispose') } },
    init: async () => { calls.push('init'); entry.fiber = { await: async () => { calls.push('ready') } } },
  }
  assert.equal((await reloadSelf({ entries: () => [entry] })).ok, true)
  assert.deepEqual(calls, ['dispose', 'commit', 'init', 'ready'])
})

test('reloadSelf leaves an entry that was already disabled disabled', async () => {
  let wrote = false
  const entry = {
    options: { id: 'dsh-remote', name: 'dsh-remote', disabled: true },
    parent: { tree: { write() { wrote = true } } },
    fiber: { dispose: async () => {} },
    init: async () => {},
  }
  const res = await reloadSelf({ internal: { loadCache: new Map() }, entries: () => [entry] })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(entry.options.disabled, true)
  assert.equal(wrote, false)
})

test('reloadSelf disposes via entry.fiber when the entry has no dispose hook', async () => {
  // ★ 回归：cordis 的 Entry **没有** dispose/_dispose（0.2.0 实测方法集：
  //   constructor/disabledOf/evaluate/_patchContext/refresh/update/_commitVolatile/
  //   init/_init），真实卸载入口是 entry.fiber.dispose()。
  //   原实现只探测 _dispose/dispose，于是每次都返回
  //   "entry exposes no dispose hook"，热切换从未执行 —— 用户看到的
  //   "磁盘 0.8.36 但运行的仍是 0.8.35" 就是这个。
  //
  //   为什么原有测试没抓到：makeEntryLoader 的桩**总是**带 _dispose，
  //   于是永远走第一条分支。这里刻意用真实形态（只有 fiber）来钉住。
  const calls = []
  const entry = {
    options: { id: 'dsh-remote', name: 'dsh-remote' },
    // 刻意不提供 _dispose / dispose —— 与真实 cordis Entry 一致
    fiber: { dispose: async () => { calls.push('fiber.dispose') } },
    init: async () => { calls.push('init') },
  }
  const loader = { internal: { loadCache: new Map() }, entries: () => [entry] }
  const res = await reloadSelf(loader)
  assert.equal(res.ok, true, `expected the fiber path to be used, got: ${JSON.stringify(res)}`)
  assert.deepEqual(calls, ['fiber.dispose', 'init'], 'must dispose the fiber, then re-init the entry')
})

test('an entry with no dispose path at all is still reported, not silently ignored', async () => {
  // 两面性：真的没有任何卸载入口时要如实报错（而不是假装成功）。
  const entry = { options: { id: 'dsh-remote' }, init: async () => {} }
  const res = await reloadSelf({ internal: { loadCache: new Map() }, entries: () => [entry] })
  assert.equal(res.ok, false)
  assert.match(res.reason, /no dispose hook/)
})

test('reloadSelf prefers an explicit hook over the fiber when both exist', async () => {
  // 宿主若提供扩展钩子，优先用它（fiber 作为后备）。
  const calls = []
  const entry = {
    options: { id: 'dsh-remote' },
    _dispose: async () => { calls.push('_dispose') },
    fiber: { dispose: async () => { calls.push('fiber.dispose') } },
    init: async () => { calls.push('init') },
  }
  const res = await reloadSelf({ internal: { loadCache: new Map() }, entries: () => [entry] })
  assert.equal(res.ok, true)
  assert.deepEqual(calls, ['_dispose', 'init'])
})

/** A loader stub exposing one dsh-remote entry, recording dispose/init calls. */
function makeEntryLoader(overrides = {}) {
  const calls = []
  const entry = {
    options: { id: 'dsh-remote', name: 'dsh-remote' },
    _dispose: async () => { calls.push('dispose') },
    init: async () => { calls.push('init') },
    ...overrides,
  }
  return { loader: { internal: { loadCache: new Map() }, entries: () => [entry] }, entry, calls }
}

test('reloadSelf disposes then re-inits our own entry', async () => {
  const { loader, calls } = makeEntryLoader()
  const res = await reloadSelf(loader)
  assert.equal(res.ok, true)
  assert.deepEqual(calls, ['dispose', 'init'])
})

test('reloadSelf reports a missing entry instead of throwing', async () => {
  const res = await reloadSelf({ internal: { loadCache: new Map() }, entries: () => [] })
  assert.equal(res.ok, false)
  assert.match(res.reason, /not found/)
})

test('reloadSelf does not init when dispose fails', async () => {
  const { loader, calls } = makeEntryLoader({
    _dispose: async () => { calls.push('dispose'); throw new Error('boom') },
  })
  const res = await reloadSelf(loader)
  assert.equal(res.ok, false)
  assert.match(res.reason, /boom/)
  assert.deepEqual(calls, ['dispose'])
})

test('reloadSelf reports a dispose-less entry', async () => {
  // 注意这里构造的是「连 fiber 也没有」的退化 entry —— 那才是真的无法卸载。
  // 真实 cordis Entry 属于「无 dispose 钩子、但有 fiber」的形态，
  // 上面那条 fiber 回归测试覆盖它，两者不要混淆。
  const { loader } = makeEntryLoader({ _dispose: undefined, dispose: undefined })
  const res = await reloadSelf(loader)
  assert.equal(res.ok, false)
  assert.match(res.reason, /dispose/)
})

test('scheduleSelfReload swaps after the grace period', async () => {
  const { loader, calls } = makeEntryLoader()
  assert.equal(scheduleSelfReload(loader, 0), true)
  assert.deepEqual(calls, []) // nothing may happen while the caller still answers
  await new Promise((r) => setTimeout(r, 25))
  assert.deepEqual(calls, ['dispose', 'init'])
})
