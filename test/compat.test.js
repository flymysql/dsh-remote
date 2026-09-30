// DSH peer-range compatibility gate.
//
// Before a profile imports a plugin, DSH compares every `peerDependencies` entry
// named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` against the single runtime
// version returned by `getDshRuntimeVersion()`:
//
//     semver.satisfies(runtimeVersion, range, { includePrerelease: true })
//
// (implementation: `evaluatePluginCompatibility()` in `@deepseek-ai/dsh-app-boot`).
// The check reads peer declarations only — `engines.dsh` is NOT consulted.
//
// 0.8.23 declared `^0.1.0-rc.6` / `^0.1.2-rc.1`. A caret range on a 0.x version
// is locked to that minor line, so it can never admit 0.2.0-rc.2 and DSH skips
// the whole bundle:
//
//     dsh: skipping profile bundle "dsh-remote": Error: Plugin dsh-remote@…
//     is incompatible with dsh 0.2.0-rc.2: peerDependencies {…}
//
// This test pins the fix with the same predicate DSH uses, so a range falling
// back onto the 0.1 line fails here instead of silently disabling the plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import semver from 'semver'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** True for the peer names DSH's compatibility check actually inspects. */
function isDshPeer(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/**
 * The DSH runtime version the installed host packages were built for. A full
 * profile checkout ships `@deepseek-ai/dsh` itself; a plain `npm ci` in this
 * repo only has the split `@deepseek-ai/dsh-*` packages, which are released in
 * lockstep with the runtime, so either source yields the same version.
 */
function dshRuntimeVersion() {
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-tools']) {
    try {
      const url = new URL(`../node_modules/${name}/package.json`, import.meta.url)
      const version = JSON.parse(readFileSync(url, 'utf8')).version
      if (typeof version === 'string' && semver.valid(version)) return version
    } catch { /* try the next candidate */ }
  }
  return undefined
}

test('every DSH peer range admits the installed DSH runtime version', () => {
  const runtimeVersion = dshRuntimeVersion()
  assert.ok(runtimeVersion, 'a DSH runtime version must be resolvable from node_modules — run `npm ci` first')

  const dshPeers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => isDshPeer(name))
  assert.ok(dshPeers.length > 0, 'dsh-remote declares at least one @deepseek-ai/dsh-* peer')

  const incompatible = dshPeers
    .filter(([, range]) => !semver.satisfies(runtimeVersion, range, { includePrerelease: true }))
    .map(([name, range]) => `${name}: ${range} does not admit ${runtimeVersion}`)

  assert.deepEqual(
    incompatible,
    [],
    `DSH would skip this bundle — peer ranges must admit dsh ${runtimeVersion}:\n  ${incompatible.join('\n  ')}`,
  )
})

test('DSH peers declare no 0.1-line caret range', () => {
  // Regression guard for the exact shape that broke 0.8.23: `^0.1.x` can never
  // admit a 0.2.x runtime, however many 0.1 pre-releases exist.
  const stale = Object.entries(pkg.peerDependencies ?? {})
    .filter(([name, range]) => isDshPeer(name) && String(range).includes('0.1.'))
    .map(([name, range]) => `${name}: ${range}`)

  assert.deepEqual(stale, [], `DSH peer ranges must not stay on the 0.1 line:\n  ${stale.join('\n  ')}`)
})
