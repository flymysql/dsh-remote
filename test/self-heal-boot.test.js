// Startup self-repair (lib/self-heal.js + lib/boot.js).
//
// Regression guard for issue #126 taken one step further: #127 taught the
// updater to install EVERYTHING the tarball ships, but installs already
// damaged by the old updater can never load far enough to run that updater.
// The boot shell therefore catches "missing own file" crashes, re-lays the
// current version from npm, and retries once. These tests exercise that whole
// arc against temp dirs + fabricated tarballs — no network, no real install.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { isMissingOwnModuleError, importWithSelfHeal, repairInstall } from '../lib/self-heal.js'

// ── fixtures (mirrors test/update.test.js helpers, trimmed) ───────────────

function tarHeader(name, size) {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('000644 \0', 100, 8, 'ascii')
  h.write('000000 \0', 108, 8, 'ascii')
  h.write('000000 \0', 116, 8, 'ascii')
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  h.write('00000000000\0', 136, 12, 'ascii')
  h.write('        ', 148, 8, 'ascii')
  h.write('0', 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}

function makeTarball(files) {
  const chunks = []
  for (const [rel, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    chunks.push(tarHeader('package/' + rel, data.length), data)
    const pad = Math.ceil(data.length / 512) * 512 - data.length
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

function tarballFetch(tarball) {
  return async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
  })
}

/**
 * A half-updated install shaped like the 0.8.92 incident: package.json and
 * lib/main.js are already the NEW version, but lib/helper.js (a sibling the
 * main file imports) never landed. Lives UNDER a node_modules-looking path so
 * isInstalledCopy() would agree — although these tests always pass an explicit
 * dir (the documented opt-out), keeping the layout realistic.
 */
function makeHalfUpdatedInstall() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-heal-'))
  const pkgDir = path.join(dir, 'node_modules', 'dsh-remote')
  mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-remote', version: '0.2.0' }))
  // main.js statically imports ./helper.js — which is MISSING. Importing it
  // fails with ERR_MODULE_NOT_FOUND exactly like web-attach.js → posix-shell.cjs.
  writeFileSync(path.join(pkgDir, 'lib', 'main.js'), "export { answer } from './helper.js'\n")
  return pkgDir
}

const HELPER_SOURCE = "export const answer = 42\n// " + 'x'.repeat(120) + '\n'

function goodTarball() {
  return makeTarball({
    'lib/main.js': "export { answer } from './helper.js'\n// " + 'y'.repeat(120) + '\n',
    'lib/helper.js': HELPER_SOURCE,
    'lib/index.js': '// entry\n' + 'z'.repeat(120) + '\n', // clears the >=100B sanity gate
    'package.json': JSON.stringify({ name: 'dsh-remote', version: '0.2.0' }),
  })
}

/** import() a fixture file with a cache-busting query so retries truly re-read disk. */
function importFresh(file) {
  const base = pathToFileURL(file).href
  return () => import(`${base}?t=${Math.random()}`)
}

// ── isMissingOwnModuleError ────────────────────────────────────────────────

test('isMissingOwnModuleError: accepts missing-module crashes, rejects missing packages and other codes', () => {
  assert.equal(isMissingOwnModuleError(Object.assign(new Error("Cannot find module './posix-shell.cjs'"), { code: 'ERR_MODULE_NOT_FOUND' })), true)
  assert.equal(isMissingOwnModuleError(Object.assign(new Error("Cannot find module '/abs/path/lib/tui/scene.js'"), { code: 'ERR_MODULE_NOT_FOUND' })), true)
  // An EXTERNAL package being absent is a host-environment problem; a tarball
  // re-lay cannot fix it, so we must refuse (no pointless download).
  assert.equal(isMissingOwnModuleError(Object.assign(new Error("Cannot find package '@deepseek-ai/cordis'"), { code: 'ERR_MODULE_NOT_FOUND' })), false)
  assert.equal(isMissingOwnModuleError(new SyntaxError('Unexpected token')), false)
  assert.equal(isMissingOwnModuleError(null), false)
})

// ── importWithSelfHeal ────────────────────────────────────────────────────

test('healthy import passes through untouched (no repair, no fetch)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-heal-'))
  const file = path.join(dir, 'fine.js')
  writeFileSync(file, 'export const ok = 1\n')
  let fetches = 0
  const spyFetch = async () => { fetches++; throw new Error('must not be called') }
  const res = await importWithSelfHeal(importFresh(file), { dir, fetchImpl: spyFetch, log: () => {} })
  assert.equal(res.repaired, false)
  assert.equal(res.module.ok, 1)
  assert.equal(fetches, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('a half-updated install heals itself: re-lays the tarball, then imports cleanly', async () => {
  const pkgDir = makeHalfUpdatedInstall()
  assert.equal(existsSync(path.join(pkgDir, 'lib', 'helper.js')), false, 'precondition: helper is missing')
  let logs = 0
  const res = await importWithSelfHeal(importFresh(path.join(pkgDir, 'lib', 'main.js')), {
    dir: pkgDir,
    fetchImpl: tarballFetch(goodTarball()),
    log: () => { logs++ },
  })
  assert.equal(res.repaired, true)
  assert.equal(res.module.answer, 42)
  assert.equal(readFileSync(path.join(pkgDir, 'lib', 'helper.js'), 'utf8'), HELPER_SOURCE)
  // The repair goes through applyUpdate, which stamps the marker — the host
  // clears it once that version is what actually runs.
  assert.equal(readFileSync(path.join(pkgDir, '.dsh-remote-updated'), 'utf8'), '0.2.0')
  assert.ok(logs >= 2, 'the user must SEE that a repair happened')
  rmSync(path.join(pkgDir, '..', '..'), { recursive: true, force: true })
})

test('repair is refused for non-installed copies (source checkouts stay untouched)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-src-')) // NOT under node_modules
  mkdirSync(path.join(dir, 'lib'), { recursive: true })
  writeFileSync(path.join(dir, 'lib', 'main.js'), "export { answer } from './helper.js'\n")
  let fetches = 0
  const spyFetch = async () => { fetches++; throw new Error('must not be called') }
  await assert.rejects(
    () => importWithSelfHeal(importFresh(path.join(dir, 'lib', 'main.js')), { fetchImpl: spyFetch, log: () => {} }),
    (err) => err.code === 'ERR_MODULE_NOT_FOUND', // the ORIGINAL error, unwrapped
  )
  assert.equal(fetches, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('a missing EXTERNAL package never triggers a repair download', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-heal-'))
  const file = path.join(dir, 'uses-ext.js')
  writeFileSync(file, "import 'definitely-not-installed-pkg-xyz'\nexport const ok = 1\n")
  let fetches = 0
  const spyFetch = async () => { fetches++; throw new Error('must not be called') }
  await assert.rejects(
    () => importWithSelfHeal(importFresh(file), { dir, fetchImpl: spyFetch, log: () => {} }),
    /Cannot find package/,
  )
  assert.equal(fetches, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('when the re-laid tree STILL lacks the file, the combined error tells the user to reinstall', async () => {
  const pkgDir = makeHalfUpdatedInstall()
  const useless = makeTarball({
    'lib/main.js': "export { answer } from './helper.js'\n// " + 'y'.repeat(120) + '\n',
    // helper.js is STILL absent — repair cannot conjure what the release lacks
    'lib/index.js': '// entry\n' + 'z'.repeat(120) + '\n',
    'package.json': JSON.stringify({ name: 'dsh-remote', version: '0.2.0' }),
  })
  await assert.rejects(
    () => importWithSelfHeal(importFresh(path.join(pkgDir, 'lib', 'main.js')), {
      dir: pkgDir, fetchImpl: tarballFetch(useless), log: () => {},
    }),
    (err) => {
      assert.match(err.message, /re-laid from npm but loading still fails/)
      assert.match(err.message, /reinstall the plugin/)
      assert.equal(err.cause?.code, 'ERR_MODULE_NOT_FOUND')
      return true
    },
  )
  rmSync(path.join(pkgDir, '..', '..'), { recursive: true, force: true })
})

test('a failed DOWNLOAD surfaces both causes and keeps the reinstall advice', async () => {
  const pkgDir = makeHalfUpdatedInstall()
  const deadFetch = async () => { throw new Error('offline') }
  await assert.rejects(
    () => importWithSelfHeal(importFresh(path.join(pkgDir, 'lib', 'main.js')), {
      dir: pkgDir, fetchImpl: deadFetch, log: () => {},
    }),
    (err) => {
      assert.match(err.message, /automatic startup repair FAILED/)
      assert.match(err.message, /offline/)
      assert.match(err.message, /reinstall the plugin/)
      return true
    },
  )
  rmSync(path.join(pkgDir, '..', '..'), { recursive: true, force: true })
})

test('non-import crashes (genuine bugs) are rethrown untouched, never masked by a download', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-heal-'))
  const file = path.join(dir, 'buggy.js')
  writeFileSync(file, 'throw new ReferenceError("a real bug")\n')
  let fetches = 0
  const spyFetch = async () => { fetches++; throw new Error('must not be called') }
  await assert.rejects(
    () => importWithSelfHeal(importFresh(file), { dir, fetchImpl: spyFetch, log: () => {} }),
    (err) => err instanceof ReferenceError && /a real bug/.test(err.message),
  )
  assert.equal(fetches, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('repairInstall refuses an unusable on-disk version instead of guessing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-heal-'))
  writeFileSync(path.join(dir, 'package.json'), '{"name":"dsh-remote"}') // no version
  await assert.rejects(() => repairInstall({ dir }), /version is unusable/)
  rmSync(dir, { recursive: true, force: true })
})

// ── boot shell surface ─────────────────────────────────────────────────────

test('lib/boot.js re-exports exactly the public surface of lib/index.js', async () => {
  // Pin the key set BOTH ways: a new export added to index.js without touching
  // boot.js (silent loss for consumers going through the package entry), or a
  // stale name lingering in boot.js after removal, must fail loudly here.
  const boot = await import('../lib/boot.js?surface=boot')
  const index = await import('../lib/index.js?surface=index')
  assert.deepEqual(Object.keys(boot).sort(), Object.keys(index).sort())
})

test('the package entry point resolves to lib/boot.js', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.main, 'lib/boot.js')
  assert.equal(pkg.exports['.'], './lib/boot.js')
  // The guard chain must stay shallow: boot → self-heal → update. Assert it
  // statically so nobody accidentally fattens boot.js into a second god file.
  const bootSrc = readFileSync(new URL('../lib/boot.js', import.meta.url), 'utf8')
  const staticImports = [...bootSrc.matchAll(/^import .* from '(\.[^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(staticImports, ['./self-heal.js'])
  const healSrc = readFileSync(new URL('../lib/self-heal.js', import.meta.url), 'utf8')
  const healImports = [...healSrc.matchAll(/^import .* from '(\.[^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(healImports, ['./update.js'])
})

