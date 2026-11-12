#!/usr/bin/env node
// verify-self-update.mjs — prove that THE PREVIOUS RELEASE'S UPDATER can bring
// an install forward to the CURRENT candidate without losing a single file.
//
// Why this gate exists (issue #126): the updater shipped in ≤0.8.91 installed
// only top-level `lib/*.js`. When 0.8.92 added `lib/posix-shell.cjs` and the
// `lib/tui/` directory, every auto-update to it produced a half-updated tree
// whose next boot died with ERR_MODULE_NOT_FOUND — and since the updater lives
// inside the plugin, those installs could never heal themselves. Running the
// REAL previous updater against the REAL candidate tarball exercises exactly
// that path, so a structurally incompatible release fails here, loudly,
// before publish — not on every user's machine.
//
// Usage:
//   node scripts/verify-self-update.mjs [--from <version>] [--tarball <file>]
//
// Defaults: --from = npm `latest` dist-tag (what users updating today run);
// the candidate is packed from the working tree with `npm pack`.
//
// Exit code 0 = the previous updater laid the candidate down completely and
// every relative import inside it resolves to a file that exists.
//
// The audit proper is exported (auditAppliedTree) so its negative cases are
// unit-tested offline in test/verify-self-update.test.js — a gate that can
// never fail is worse than no gate.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function fail(msg) {
  console.error(`SELF-UPDATE GATE: FAIL — ${msg}`)
  process.exit(1)
}

/**
 * Run npm cross-platform. Plain execFileSync('npm'|'npm.cmd') breaks twice on
 * Windows: the bare name misses the .cmd shim (ENOENT), and Node ≥18.20 refuses
 * to spawn .cmd without a shell (EINVAL, CVE-2024-27980). Going through
 * `cmd /d /s /c` with quoted args sidesteps both.
 */
function runNpm(args, opts) {
  const quoted = args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...quoted], opts)
  }
  return execFileSync('npm', args, opts)
}

/** List regular files under dir, recursively, as POSIX-style relative paths. */
export function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

/** Relative specifiers referenced by a JS/CJS/MJS source (static + dynamic). */
export function relativeRefs(source) {
  const refs = new Set()
  for (const m of source.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    refs.add(m[1])
  }
  return [...refs]
}

/** Text comparison basis: CRLF (a Windows checkout) and LF (the registry
 *  tarball) are the same payload; the gate hunts absence/material change. */
const norm = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n')

/**
 * Audit what an updater run actually achieved.
 * @param candidatePkgDir - extracted candidate `package/` dir (the truth).
 * @param installDir - the install the updater wrote to (the reality).
 * @param shippedFiles - relpaths (from candidatePkgDir) that had to land.
 * @returns {{missing: string[], mismatched: string[], unresolved: string[]}}
 *   missing     — files the updater never installed (the #126 signature);
 *   mismatched  — files present but materially different afterwards;
 *   unresolved  — relative imports in shipped sources whose target is absent.
 */
export function auditAppliedTree(candidatePkgDir, installDir, shippedFiles) {
  const missing = []
  const mismatched = []
  const unresolved = []
  for (const rel of shippedFiles) {
    const dest = path.join(installDir, rel)
    if (!existsSync(dest)) { missing.push(rel); continue }
    if (norm(readFileSync(path.join(candidatePkgDir, rel))) !== norm(readFileSync(dest))) mismatched.push(rel)
  }
  for (const rel of shippedFiles.filter((f) => /\.(js|cjs|mjs)$/.test(f))) {
    if (missing.includes(rel)) continue
    const src = readFileSync(path.join(installDir, rel), 'utf8')
    for (const ref of relativeRefs(src)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref))
      if (!existsSync(path.join(installDir, target))) unresolved.push(`${rel} -> ${ref}`)
    }
  }
  return { missing, mismatched, unresolved }
}

async function main() {
  const candidateVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  console.log(`candidate version: ${candidateVersion}`)

  // ── 1. resolve the "previous" version users would be updating FROM ──────
  let fromVersion = arg('from')
  if (!fromVersion) {
    const res = await fetch('https://registry.npmjs.org/dsh-remote/latest', { headers: { accept: 'application/json' } })
    if (!res.ok) fail(`could not read the npm latest dist-tag (HTTP ${res.status})`)
    fromVersion = (await res.json()).version
  }
  if (fromVersion === candidateVersion) {
    console.log(`SELF-UPDATE GATE: SKIP — candidate ${candidateVersion} is already the published latest; nothing newer is being shipped`)
    return
  }
  console.log(`updating from:   ${fromVersion} (npm latest)`)

  // ── 2. pack the candidate exactly as publish would ──────────────────────
  let tgz = arg('tarball')
  const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-selfupdate-gate-'))
  try {
    if (!tgz) {
      const out = runNpm(['pack', '--ignore-scripts', '--pack-destination', scratch], { cwd: root, encoding: 'utf8' })
      tgz = path.join(scratch, out.trim().split('\n').pop())
    }
    console.log(`candidate pack:  ${path.basename(tgz)}`)

    // Extract the candidate so we know the exact set of files that MUST land.
    const candDir = path.join(scratch, 'candidate')
    mkdirSync(candDir, { recursive: true })
    execFileSync('tar', ['-xzf', tgz, '-C', candDir])
    const candPkg = path.join(candDir, 'package')
    const candFiles = listFiles(candPkg).filter((rel) =>
      rel === 'package.json' || rel === 'cordis.patch.yml' || rel.startsWith('lib/'))

    // ── 3. perform a REAL install of the previous release ─────────────────
    const prevHome = path.join(scratch, 'prev')
    mkdirSync(prevHome, { recursive: true })
    writeFileSync(path.join(prevHome, 'package.json'), JSON.stringify({ name: 'gate-sandbox', private: true }))
    runNpm(['install', `dsh-remote@${fromVersion}`, '--legacy-peer-deps', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: prevHome, stdio: 'pipe' })
    const prevDir = path.join(prevHome, 'node_modules', 'dsh-remote')
    if (!existsSync(path.join(prevDir, 'lib', 'update.js'))) fail(`previous install at ${prevDir} has no lib/update.js`)
    console.log(`previous copy:   installed at ${prevDir}`)

    // ── 4. drive the PREVIOUS release's own updater onto the candidate ────
    // Feed the local candidate tarball by patching global fetch BEFORE the old
    // updater module is imported: its `options.fetchImpl || fetch` resolves the
    // global binding at call time, so this reaches even releases that predate
    // the fetchImpl seam.
    const tgzBuf = readFileSync(tgz)
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('.tgz')) {
        return new Response(tgzBuf, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
      }
      return realFetch(url, init)
    }
    const oldUpdater = await import(pathToFileURL(path.join(prevDir, 'lib', 'update.js')).href)
    if (typeof oldUpdater.applyUpdate !== 'function') fail('previous updater exposes no applyUpdate()')
    const result = await oldUpdater.applyUpdate(candidateVersion)
    console.log(`updater says:    ok=${result?.ok} changed=${result?.changed?.length ?? '?'} file(s)`)

    // ── 5. audit the resulting tree ───────────────────────────────────────
    const { missing, mismatched, unresolved } = auditAppliedTree(candPkg, prevDir, candFiles)
    if (missing.length) fail(`the previous updater NEVER INSTALLED ${missing.length} file(s):\n  - ${missing.join('\n  - ')}\n(this is exactly the #126 half-updated tree)`)
    if (mismatched.length) fail(`content mismatch after update:\n  - ${mismatched.join('\n  - ')}`)
    if (unresolved.length) fail(`imports pointing at files the update did not install:\n  - ${unresolved.join('\n  - ')}`)

    console.log(`checked ${candFiles.length} shipped files, all present and consistent; all relative imports resolve`)
    console.log('SELF-UPDATE GATE: PASS')
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }) } catch {}
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  main().catch((err) => {
    console.error(`SELF-UPDATE GATE: ERROR — ${(err && err.message) || err}`)
    process.exit(1)
  })
}
