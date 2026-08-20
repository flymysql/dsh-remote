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
//     atomically copy over the installed files. A `.dsh-remote-updated` marker
//     is written so the UI can tell the user to reload.
//
// Every failure aborts without touching the installed files (a bad download or
// a version mismatch must never break the running plugin).

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** Read the installed package.json version; "0.0.0" when unreadable. */
export function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(selfDir(), 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
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

/** Query the npm registry for the latest release; resolves null on any failure. */
export async function fetchLatestVersion(timeoutMs = 8000) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(REGISTRY_URL, { signal: controller.signal, headers: { accept: 'application/json' } })
      if (!res.ok) return null
      const data = await res.json()
      return typeof data?.version === 'string' && data.version ? data.version : null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
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
export async function applyUpdate(targetVersion) {
  const tarballUrl = `https://registry.npmjs.org/${NPM_PACKAGE}/-/${NPM_PACKAGE}-${targetVersion}.tgz`
  const dir = selfDir()
  const tmpRoot = path.join(dir, `.dsh-remote-update-${Date.now()}`)
  const tmpPkg = path.join(tmpRoot, 'package')
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    let res
    try {
      res = await fetch(tarballUrl, { signal: controller.signal })
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
    // Atomically swap: copy fresh files over the installed ones.
    const installLib = path.join(dir, 'lib')
    const tmpLib = path.join(tmpPkg, 'lib')
    for (const name of readdirSafe(tmpLib)) {
      if (!name.endsWith('.js')) continue
      const src = path.join(tmpLib, name)
      if (existsSync(src)) copyFileSync(src, path.join(installLib, name))
    }
    for (const rel of ['package.json', 'cordis.patch.yml']) {
      const src = path.join(tmpPkg, rel)
      if (existsSync(src)) copyFileSync(src, path.join(dir, rel))
    }
    writeFileSync(path.join(dir, '.dsh-remote-updated'), String(targetVersion))
    return { ok: true, to: targetVersion }
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

/** readdir helper that returns [] on failure. */
function readdirSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
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
