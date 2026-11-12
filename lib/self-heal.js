// dsh-remote — startup self-repair for an incompletely applied update.
//
// The failure this wards off (0.8.92, issue #126): the updater at the time
// installed only top-level `lib/*.js`, so a release that added `.cjs` helpers
// or `lib/` subdirectories produced a half-updated tree. The next boot died at
// import time with ERR_MODULE_NOT_FOUND — and because the updater lives INSIDE
// the plugin, a plugin that cannot be imported can never repair itself. Every
// rw_* tool, the terminal, web attach and forwarding simply vanished, for good.
//
// This module is the outermost line of defence: lib/boot.js (the package
// entry) runs it BEFORE loading the real plugin body, detects the
// "missing own file" crash, re-downloads the CURRENT version's tarball from
// npm and lays the full file tree down, then retries the import exactly once.
//
// ★ HARD CONSTRAINT — this module must stay self-contained within the package:
// it may only import node builtins and lib/update.js (which is likewise
// self-contained). Any richer import could itself be the file that is missing,
// and then the guard dies together with the guarded.

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { applyUpdate, isInstalledCopy, diskVersion } from './update.js'

/**
 * Whether `err` is the specific crash a half-applied update produces: Node
 * could not find a file belonging to THIS package.
 *
 * Deliberately narrower than "any load failure":
 *  - `Cannot find package '…'` names an external dependency — a tarball re-lay
 *    cannot fix the host environment, so we do not even try;
 *  - `Cannot find module '…'` (relative specifier or absolute path) is the
 *    signature of our own file being absent — repairable;
 *  - an ERR_MODULE_NOT_FOUND whose message matches neither is treated as
 *    repairable too: the worst case is one doomed download followed by an
 *    honest combined error, while missing a repairable case strands the user.
 * @param err - anything thrown by a failed dynamic import().
 */
export function isMissingOwnModuleError(err) {
  if (!err || typeof err !== 'object') return false
  if (err.code !== 'ERR_MODULE_NOT_FOUND') return false
  const msg = String(err.message || '')
  if (/Cannot find package/.test(msg)) return false
  return true
}

/**
 * Re-lay the CURRENTLY INSTALLED version's full file tree from npm, healing a
 * half-applied update in place. Uses the version from the on-disk package.json
 * (in a half-updated tree that file HAS landed, so it names exactly the
 * version whose lib/ got mangled). Thin wrapper over applyUpdate(); the same
 * refusal rules apply (non-installed copies must be passed an explicit dir).
 * @param options - forwarded to applyUpdate ({dir, fetchImpl} for tests);
 *   when options.dir is set, the version is read from THAT directory's
 *   package.json rather than this package's own install dir.
 */
export async function repairInstall(options = {}) {
  let version = diskVersion()
  if (options.dir) {
    try {
      version = String(JSON.parse(readFileSync(path.join(options.dir, 'package.json'), 'utf8')).version || '')
    } catch {
      version = ''
    }
  }
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`cannot self-repair: on-disk package.json version is unusable (${JSON.stringify(version)})`)
  }
  return applyUpdate(version, options)
}

/** Actionable suffix attached to every failure we hand back to the user. */
const REINSTALL_HINT = 'please reinstall the plugin once (e.g. `dsh plugin --profile <profile> add dsh-remote@latest`) — a damaged install cannot always heal itself'

/**
 * Import the plugin body, repairing the install in between when the first
 * attempt dies from a missing own-file.
 *
 * Order of operations (every exit path is deliberate):
 *   1. `await importer()` succeeds → `{ module, repaired: false }`;
 *   2. failure that is NOT a missing-own-module crash → rethrow untouched
 *      (a genuine code bug must not be masked by a pointless download);
 *   3. missing-own-module but this copy is not an installed one → rethrow
 *      (never touch a source checkout; same contract as applyUpdate, where an
 *      explicit options.dir opts out for tests);
 *   4. otherwise repairInstall() → retry the import ONCE → success becomes
 *      `{ module, repaired: true }`; a second failure throws a combined error
 *      naming BOTH the original crash and the repair outcome plus the
 *      reinstall hint, with `cause` chaining the second import error.
 *
 * @param importer - zero-arg function performing `import('<the real entry>')`.
 * @param options - `{ log?, dir?, fetchImpl? }` — dir/fetchImpl are test seams
 *   forwarded to applyUpdate; log defaults to console.warn.
 */
export async function importWithSelfHeal(importer, options = {}) {
  const { log = console.warn, ...repairOpts } = options || {}
  let firstErr
  try {
    return { module: await importer(), repaired: false }
  } catch (err) {
    firstErr = err
  }
  if (!isMissingOwnModuleError(firstErr)) throw firstErr
  if (!repairOpts.dir && !isInstalledCopy()) throw firstErr

  const version = repairOpts.dir ? '(test dir)' : `v${diskVersion()}`
  log(`[dsh-remote] startup crashed on a missing package file (${firstErr.message.split('\n')[0]}) — the last self-update looks incomplete; re-downloading ${version} from npm to repair the install`)

  let repairOutcome
  try {
    repairOutcome = await repairInstall(repairOpts)
  } catch (repairErr) {
    const wrapped = new Error(
      `[dsh-remote] automatic startup repair FAILED (${(repairErr && repairErr.message) || repairErr}); original error: ${firstErr.message.split('\n')[0]}. ${REINSTALL_HINT}`,
    )
    wrapped.cause = repairErr
    throw wrapped
  }
  log(`[dsh-remote] startup repair applied ${repairOutcome.changed?.length ?? 0} file(s); retrying the load`)

  try {
    return { module: await importer(), repaired: true }
  } catch (secondErr) {
    const wrapped = new Error(
      `[dsh-remote] the install was re-laid from npm but loading still fails: ${(secondErr && secondErr.message) || secondErr}. ${REINSTALL_HINT}`,
    )
    wrapped.cause = secondErr
    throw wrapped
  }
}
