// dsh-remote — self-update support.
//
// dsh-remote is a zero-build plugin: the host half (lib/index.js) is loaded
// straight from the installed package, so "updating" = replacing the package
// files with the newer npm tarball. This module owns the version check and the
// tarball apply:
//
//   • checkLatestVersion() — query the npm registry for the `latest` dist-tag;
//   • applyUpdate() — download the tarball, extract package/{lib,package.json,
//     cordis.patch.yml} with a minimal tar reader, verify the version, then
//     replace the installed files atomically (temp file + rename, never a
//     half-written lib/*.js). A `.dsh-remote-updated` marker records the version
//     that landed; the host half removes it once that version is the code it is
//     actually running (see LOADED_VERSION), so the marker means "restart still
//     required" rather than "an update once happened".
//   • reloadSelf() — swap the RUNNING host half to the code now on disk: drop
//     Node's module caches for this package's own files, then dispose + re-init
//     the loader entry so apply() runs again from the fresh module. Without it
//     an update only takes effect on the next process start, which is what left
//     the served client half newer than the loaded host half.
//
// Every failure aborts without touching the installed files (a bad download or
// a version mismatch must never break the running plugin).

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const NPM_PACKAGE = 'dsh-remote'
const REGISTRY_URL = 'https://registry.npmjs.org/' + NPM_PACKAGE + '/latest'

/** Absolute directory holding this plugin's installed files (lib/ + package.json). */
export function selfDir() {
  try {
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  } catch {
    return path.dirname(path.dirname(process.argv[1] || ''))
  }
}

/**
 * 本插件是否装在 `node_modules` 之下（即真正的"安装副本"）。
 *
 * ★ 为什么必须有这道判断（实测依据，不是防御性猜测）：
 *   `selfDir()` 基于 `import.meta.url`，而 **Node 的 ESM 解析会对符号链接做
 *   realpath**（已实测：经由 symlink 导入时 `import.meta.url` 报告的是
 *   `/real/mod.mjs` 而不是 `/link/mod.mjs`）。于是当插件以 `link:` / 开发模式
 *   安装时，`selfDir()` 指向的是**用户的源码仓库**，而不是安装副本。
 *   一旦 `auto` 更新落地，`applyUpdate` 就会拿 npm 包覆盖那份源码
 *   （丢改动、脏工作树）。默认改成 `auto` 之后这个风险从"手点才触发"
 *   变成"自动发生"，所以在此拦下：不在 node_modules 下就不自更新。
 *
 * 代价：少数把插件放在非标准路径的部署不会被自动更新——他们仍可手动更新。
 * 这个方向的取舍是正确的：宁可少更新，也不能悄悄毁掉源码。
 * @param dir - 要判定的目录（默认本插件的 selfDir()）。
 */
export function isInstalledCopy(dir = selfDir()) {
  // 同时认 `/` 与 `\`：本函数要对两种平台的路径都给出正确答案，而调用方
  // （尤其测试）会传另一种分隔符的路径。先前只按 path.sep 切分，导致
  // 在 Linux 上判断 Windows 风格路径时误判为"非安装副本"（CI 直接红了）。
  const normalized = String(dir).replace(/\\/g, '/').toLowerCase()
  return normalized.includes('/node_modules/')
}

/** Read the installed package.json version; "0.0.0" when unreadable. */
export function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(selfDir(), 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

/** Version of the code this process actually loaded (snapshot at import time).
 *  `readVersion()` reads package.json from disk, so after an update lands it
 *  reports the NEW version while the running module is still the old one —
 *  comparing the two is the only way to tell "applied" from "active". */
export const LOADED_VERSION = readVersion()

/** Package version currently on disk (may be newer than {@link LOADED_VERSION}). */
export function diskVersion() {
  return readVersion()
}

/** Compare dotted versions; returns true when a > b. */
export function gtVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da !== db) return da > db
  }
  return false
}

/**
 * 查询 npm registry 的最新版本。
 *
 * 返回 `{ version }` 或 `{ error }`（**不再把一切失败压成 null**）。
 *
 * 为什么要区分失败原因：原先任何失败都返回 `null`，调用方只能笼统报
 * "无法连接 npm registry"。实测踩过：本机被 npm 限流（`/latest` 返回 **429**，
 * 而同一时刻 registry 根路径是 200、CI 从另一个出口 IP 也能正常取到），
 * 却被显示成"连不上"——把"等一下就好"误导成"网络坏了"。429/超时/离线
 * 三者的处置完全不同，必须让用户看到真实原因。
 * @param timeoutMs - 超时（看门狗只负责中止，不影响进程存活）。
 */
export async function fetchLatestVersion(timeoutMs = 8000) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // 纯看门狗：调用方并不 await 它，所以必须 unref，否则这一段超时窗口
    // 会拖住事件循环、让本该退出的短命进程（脚本、测试）多挂数秒。
    if (typeof timer.unref === 'function') timer.unref()
    let res
    try {
      res = await fetch(REGISTRY_URL, { signal: controller.signal, headers: { accept: 'application/json' } })
    } finally {
      clearTimeout(timer)
    }
    if (res.status === 429) {
      return { error: 'npm registry 限流（HTTP 429）——请求过于频繁，稍后会自动恢复', reason: 'rate-limited', status: 429 }
    }
    if (!res.ok) {
      return { error: `npm registry 返回 HTTP ${res.status}`, reason: 'http', status: res.status }
    }
    const data = await res.json().catch(() => null)
    const version = typeof data?.version === 'string' && data.version ? data.version : null
    if (!version) return { error: 'npm registry 响应里没有可用的版本号', reason: 'malformed' }
    return { version }
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    return {
      error: aborted ? `连接 npm registry 超时（${timeoutMs}ms）` : '无法连接 npm registry',
      reason: aborted ? 'timeout' : 'network',
    }
  }
}

/** Minimal POSIX ustar reader (regular files only) — npm tarballs are gzipped tar. */
function parseTar(buf) {
  const files = []
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (!name) break
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    off += 512
    const data = type === '48' || type === '0' ? Buffer.from(buf.subarray(off, off + size)) : null
    if (data) files.push({ name, data })
    off += Math.ceil(size / 512) * 512
  }
  return files
}

/**
 * Download the given version's tarball and atomically replace the installed
 * package files (lib/*.js, cordis.patch.yml, package.json). On success writes
 * `.dsh-remote-updated` in the install dir; throws on any failure (leaves the
 * installed files untouched).
 * @param targetVersion - exact npm version to install (e.g. "0.8.0").
 */
export async function applyUpdate(targetVersion, options = {}) {
  // 拒绝对非安装副本自更新：`auto` 默认开启后，一次自动更新就会覆盖
  // `selfDir()` 指向的目录，而以 link:/开发模式安装时那正是用户的源码仓库
  // （见 isInstalledCopy 的实测说明）。测试用 options.dir 指向临时目录，
  // 因此不受此限（options.dir 存在即视为显式指定，跳过检查）。
  if (!options.dir && !isInstalledCopy()) {
    throw new Error('refusing to self-update: this copy is not under node_modules (link/dev install) — update it from its source repo instead')
  }
  const tarballUrl = `https://registry.npmjs.org/${NPM_PACKAGE}/-/${NPM_PACKAGE}-${targetVersion}.tgz`
  const dir = options.dir || selfDir()
  const doFetch = options.fetchImpl || fetch
  const tmpRoot = path.join(dir, `.dsh-remote-update-${Date.now()}`)
  const tmpPkg = path.join(tmpRoot, 'package')
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    let res
    try {
      res = await doFetch(tarballUrl, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    // npm tarballs are gzipped tar; extract the package/ directory.
    const { gunzipSync } = await import('node:zlib')
    const tar = gunzipSync(buf)
    const files = parseTar(tar)
    mkdirSync(tmpPkg, { recursive: true })
    let extracted = 0
    for (const f of files) {
      const rel = f.name.replace(/^package\//, '')
      if (!rel || rel === 'package/' || rel.endsWith('/')) continue
      if (rel !== 'package.json' && rel !== 'cordis.patch.yml' && !rel.startsWith('lib/')) continue
      const dest = path.join(tmpPkg, rel)
      mkdirSync(path.dirname(dest), { recursive: true })
      writeFileSync(dest, f.data)
      extracted++
    }
    if (extracted === 0) throw new Error('tarball contained no package files')
    // Verify the downloaded package.json matches the requested version.
    const newPkg = JSON.parse(readFileSync(path.join(tmpPkg, 'package.json'), 'utf8'))
    if (newPkg.version !== targetVersion) throw new Error(`tarball version mismatch: ${newPkg.version}`)
    // Sanity: the new host half must at least parse (a corrupt index.js would
    // break the next boot — check the file size and that it is not empty).
    const newIndex = path.join(tmpPkg, 'lib', 'index.js')
    if (!existsSync(newIndex) || statSize(newIndex) < 100) throw new Error('tarball missing lib/index.js')
    // Swap the installed files one at a time: atomic, and idempotent.
    //
    // Atomicity (temp file + rename) is not cosmetic here — since the browser
    // half is hot-swapped by dsh-client-hmr, which stat-polls lib/client.js
    // every 500 ms, a torn write would be re-hashed and served mid-copy.
    // Skipping byte-identical files keeps a re-apply of the same version from
    // churning mtimes (and the host half from reloading for nothing).
    const installLib = path.join(dir, 'lib')
    const tmpLib = path.join(tmpPkg, 'lib')
    const changed = []
    const install = (src, dest) => {
      const bytes = readFileSync(src)
      if (sameFileContent(dest, bytes)) return
      try { mkdirSync(path.dirname(dest), { recursive: true }) } catch {}
      writeFileAtomic(dest, bytes)
      changed.push(path.relative(dir, dest).split(path.sep).join('/'))
    }
    // Install *everything* the tarball ships under lib/, not just top-level
    // `.js`. A filter here is how 0.8.92 shipped a half-updated tree: the
    // updater skipped `.cjs` helpers and subdirectories such as `lib/tui/`, so
    // `lib/web-attach.js` ended up importing a `./posix-shell.cjs` that was
    // never written and the whole plugin failed to import on the next boot.
    for (const rel of listFilesRecursive(tmpLib)) {
      install(path.join(tmpLib, rel), path.join(installLib, rel))
    }
    for (const rel of ['package.json', 'cordis.patch.yml']) {
      const src = path.join(tmpPkg, rel)
      if (existsSync(src)) install(src, path.join(dir, rel))
    }
    writeFileSync(path.join(dir, '.dsh-remote-updated'), String(targetVersion))
    return { ok: true, to: targetVersion, changed }
  } catch (err) {
    throw new Error('update failed: ' + ((err && err.message) || err))
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  }
}

/** File size helper (missing/unreadable → 0). */
function statSize(p) {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/**
 * List the regular files under `dir`, recursively, as POSIX-style paths
 * relative to it. Used to install and to evict whatever the package ships
 * under `lib/` — both used to look only at top-level names, which missed
 * `.cjs` helpers and subdirectories such as `lib/tui/`.
 *
 * @param dir - directory to walk.
 * @param prefix - internal recursion state; callers omit it.
 * @returns relative paths, `[]` when the directory cannot be read.
 */
function listFilesRecursive(dir, prefix = '') {
  const out = []
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFilesRecursive(path.join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/**
 * Write `data` to `dest` atomically: the bytes land in a sibling temp file and
 * are then renamed over the target, so a concurrent reader (the client-half HMR
 * poll, or the next boot) never observes a truncated file. Falls back to an
 * in-place copy if the platform refuses the replace, and never leaves the temp
 * file behind.
 * @param dest - absolute destination path.
 * @param data - bytes to write.
 */
export function writeFileAtomic(dest, data) {
  const tmp = `${dest}.dsh-tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, dest)
    return
  } catch {
    try {
      copyFileSync(tmp, dest)
    } finally {
      try { rmSync(tmp, { force: true }) } catch {}
    }
  }
}

/** Whether the file at `p` already holds exactly `bytes` (missing/short → false). */
function sameFileContent(p, bytes) {
  try {
    return readFileSync(p).equals(bytes)
  } catch {
    return false
  }
}

// ── hot swap of the running host half ─────────────────────────────────────

/** Loader entry ids this package can own. */
const SELF_ENTRY_NAMES = ['dsh-remote']

/**
 * Find our own loader entry (by id, then by module specifier). Returns undefined
 * when the tree does not contain us (e.g. a test loader, or a renamed row).
 * @param loader - the cordis Loader service (`ctx.loader`).
 */
function findSelfEntry(loader) {
  let entries = []
  try {
    entries = [...(loader?.entries?.() ?? [])]
  } catch {
    return undefined
  }
  for (const want of SELF_ENTRY_NAMES) {
    const byId = entries.find((entry) => entry?.options?.id === want)
    if (byId) return byId
  }
  for (const want of SELF_ENTRY_NAMES) {
    const byName = entries.find((entry) => entry?.options?.name === want)
    if (byName) return byName
  }
  return undefined
}

/**
 * Drop Node's module caches for this package's own files, so the next import of
 * the plugin actually re-reads disk instead of handing back the cached module.
 * Both caches matter: the ESM `loadCache` (a plain Map on Node 22/23, a
 * `LoadCache extends Map` on Node 24 — hence the explicit `Map.prototype` calls)
 * and, for CJS modules pulled in through `import()`, `require.cache`.
 * @param loader - the cordis Loader service.
 * @param dir - package directory whose `lib/` to evict (defaults to this
 *   package's own install dir; overridable so the swap can be exercised against
 *   a fixture install).
 * @returns how many ESM entries were dropped.
 */
export function clearSelfModuleCache(loader, dir = selfDir()) {
  const libDir = path.join(dir, 'lib')
  const loadCache = loader?.internal?.loadCache
  const req = (() => {
    try { return createRequire(import.meta.url) } catch { return undefined }
  })()
  let cleared = 0
  for (const rel of listFilesRecursive(libDir)) {
    // `.cjs` matters as much as `.js` here: `posix-shell.cjs` is imported from
    // `web-attach.js` and would otherwise survive a hot swap in both caches.
    if (!/\.(js|cjs|mjs)$/.test(rel)) continue
    const url = pathToFileURL(path.join(libDir, rel)).href
    try {
      if (loadCache && Map.prototype.has.call(loadCache, url)) {
        Map.prototype.delete.call(loadCache, url)
        cleared += 1
      }
    } catch {}
    try {
      const file = fileURLToPath(url)
      if (req?.cache && req.cache[file]) delete req.cache[file]
    } catch {}
  }
  return cleared
}

/**
 * Swap the RUNNING host half to the code now on disk: clear the module caches
 * for our own files, dispose our loader entry (tools, JSON routes, SSH pools and
 * every `ctx.effect` disposer go with the fiber), then re-init it so `apply()`
 * runs again from the freshly imported module.
 *
 * Callers must not depend on this plugin after a successful reload — the fiber
 * that served the current request is gone. Schedule it (see
 * {@link scheduleSelfReload}) rather than awaiting it from a request handler.
 * @param loader - the cordis Loader service (`ctx.loader`).
 * @returns a small result object; never throws.
 */
export async function reloadSelf(loader) {
  const entry = findSelfEntry(loader)
  if (!entry) return { ok: false, reason: 'own loader entry not found' }
  try {
    const cleared = clearSelfModuleCache(loader)
    // ★ 卸载必须走 entry.fiber.dispose()。
    //
    // 原实现找 `entry._dispose` / `entry.dispose`，但 cordis 的 Entry **两个都没有**
    // （0.2.0 实测方法集只有 constructor/disabledOf/evaluate/_patchContext/refresh/
    // update/_commitVolatile/init/_init），所以这里每次都直接返回
    // "entry exposes no dispose hook" —— 热切换从未真正执行过，而
    // scheduleSelfReload 里的 `.catch(() => {})` 把它彻底吞掉，
    // UI 于是永远停在"已落盘但未切换"（用户报的 0.8.35 -> 0.8.36）。
    //
    // 也不能用 entry.refresh()：它是 `if (this.fiber) return; await this.init()`，
    // fiber 还活着时直接返回，等于没重启。真正卸载 fiber 的地方在 Entry.update()
    // 里（`this.fiber?.dispose()`），这里照它做。
    //
    // 保留对 _dispose/dispose 的探测：那是宿主可能提供的扩展钩子，有则优先用，
    // 没有就用 fiber.dispose()——两条路都必须能真正卸载，否则应如实报错。
    // DSH 0.2 的 loader 在 fiber 被卸载时把 entry.options.disabled 写成 true
    // 并写回配置树。客户端扫描会跳过禁用行，于是热切换之后宿主能起来、
    // 设置页的 client 不再下发。这里记下卸载前的状态：只有 loader 在
    // dispose 期间新打上的禁用才清掉。用户本来就禁用的行不要重新打开。
    const disabledBefore = entry.options?.disabled === true
    if (typeof entry._dispose === 'function') await entry._dispose()
    else if (typeof entry.dispose === 'function') await entry.dispose()
    else if (entry.fiber && typeof entry.fiber.dispose === 'function') await entry.fiber.dispose()
    else return { ok: false, reason: 'entry exposes no dispose hook' }
    if (!disabledBefore && entry.options?.disabled === true) {
      delete entry.options.disabled
      entry.parent?.tree?.write?.()
    }
    await entry.init()
    return { ok: true, cleared }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

/**
 * Fire-and-forget {@link reloadSelf} after a short delay, so the caller can
 * finish answering an HTTP request (or an update check) before its own module is
 * torn down. A failed swap leaves the running code in place, which is the
 * pre-hot-update behaviour, not a crash — so we do not throw.
 *
 * We DO record the outcome, though. Silently discarding it is precisely how the
 * "entry exposes no dispose hook" defect stayed invisible: the panel reported a
 * scheduled swap, the swap never ran, and nothing anywhere said so.
 * {@link lastSelfReload} exposes the result for diagnostics (the settings panel
 * and `/dsh-remote/update-check` surface it), and a non-ok result is logged once.
 *
 * @param loader - the cordis Loader service.
 * @param delayMs - grace period before the swap (default 300 ms).
 * @returns true when the swap was scheduled.
 */
export function scheduleSelfReload(loader, delayMs = 300) {
  const timer = setTimeout(() => {
    void reloadSelf(loader).then(
      (res) => { lastReloadResult = res; if (res && res.ok === false) console.warn('[dsh-remote] self-update swap failed:', res.reason) },
      (err) => { lastReloadResult = { ok: false, reason: String((err && err.message) || err) }; console.warn('[dsh-remote] self-update swap threw:', lastReloadResult.reason) },
    )
  }, Math.max(0, delayMs))
  if (typeof timer.unref === 'function') timer.unref()
  return true
}

/** Result of the most recent {@link scheduleSelfReload} attempt, for diagnostics. */
let lastReloadResult = null

/** @returns the last self-reload outcome (`{ok,reason?}`, or null if never attempted). */
export function lastSelfReload() {
  return lastReloadResult
}

/** Write the persisted update-mode override (settings UI). */
export function persistUpdateMode(mode) {
  if (!['manual', 'auto', 'off'].includes(mode)) return false
  try {
    writeFileSync(path.join(selfDir(), 'update-mode'), mode)
    return true
  } catch {
    return false
  }
}

/** Read a persisted update-mode override, or null when absent/invalid. */
export function readUpdateMode() {
  try {
    const m = readFileSync(path.join(selfDir(), 'update-mode'), 'utf8').trim()
    return ['manual', 'auto', 'off'].includes(m) ? m : null
  } catch {
    return null
  }
}
