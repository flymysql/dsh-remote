// dsh-remote — remote sandbox semantics (issue: parity with local sandbox).
//
// The gap this closes: a local agent session runs under `ctx.sandboxPolicy`
// (read-only / workspace-write / danger-full-access), but every rw_* tool ran
// remote commands with NO policy at all. A confined session could therefore
// reach a remote host and mutate anything — the sandbox was not bypassed by a
// flaw in its enforcement, it simply had no say over a different machine.
//
// Why this is a TOOL-LAYER fence rather than `ctx.sandbox.confine()`: the core
// sandbox service wraps argv for a LOCAL spawn (`confine(argv, policy)` returns
// argv to spawn on THIS host). A remote host has no sandbox runner, so wrapping
// local argv cannot constrain a process on the other end of an SSH channel. The
// core's own docs say exactly this — "Containers, microVMs, and remote
// execution replace the surrounding capability seam instead". So the honest
// enforcement point is here: decide, per operation, whether this session's mode
// permits that remote path/command, and refuse with the OFFICIAL denial shape
// so the model's escalation affordances keep working.
//
// Threat model (stated plainly, matching the official dsh-fs-sandbox header):
// this is CONTAINMENT, not a security boundary. Paths are compared lexically, so
// symlinks and TOCTOU races inside the remote host can escape; a remote command
// can `cd` anywhere once bash runs with the user's own privileges. What it does
// buy, and what the issue asked for: a confined session can no longer mutate a
// remote tree outside its workspace BY ACCIDENT through the file tools, and
// `rw_exec` refuses outright under read-only instead of silently running
// anything. Deployments needing a hard boundary must confine on the REMOTE side
// (containers, per-user accounts, filesystem ACLs).

import path from 'node:path'
import { normalizeRemotePath, relPathUnder } from './paths.js'

/** The three file-effect modes, mirroring `@deepseek-ai/dsh-sandbox`. */
export const REMOTE_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/** Denial marker prefix, matching the official `sandboxDenialMarker` shape. */
const DENIAL_PREFIX = '[sandbox: '

/**
 * Whether `target` lies inside `root` using lexical, separator-aware
 * comparison. Mirrors the official `isPathInsideWorkspace`: both sides are
 * normalized so `..` cannot escape, and `/tmp/foo` does not contain
 * `/tmp/foobar`.
 *
 * A root of `/` contains everything (the whole filesystem is the workspace),
 * which is what makes "workspace = filesystem root" a legal, permissive setup
 * (issue #60) rather than a denial of everything.
 *
 * @param {string} target - the remote path being touched.
 * @param {string} root - the remote workspace root.
 * @returns {boolean}
 */
export function isInsideRemote(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string') return false
  // POSIX-absolute only. `normalizeRemotePath` deliberately coerces a relative
  // input to an absolute one (`tmp/foo` → `/tmp/foo`, `../foo` → `/foo`), which
  // is right for a user-supplied path but WRONG for a fence: it would turn an
  // unprovable root into a confident one. A root that is not absolute proves
  // nothing, so refuse before normalizing.
  if (!isPosixAbsolute(root)) return false
  const t = normalizeRemotePath(target)
  let r = normalizeRemotePath(root)
  if (r === '/' || r === '') return true
  r = r.replace(/\/+$/, '')
  if (t === r) return true
  return t.startsWith(r + '/')
}

/**
 * Whether a path is an absolute POSIX or Windows-Drive path, WITHOUT the
 * coercing normalization `normalizeRemotePath` performs.
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isPosixAbsolute(p) {
  const s = String(p || '')
  if (!s) return false
  if (s.startsWith('/')) return true            // POSIX
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true    // Windows drive
  if (/^\\\\[^\\]+/.test(s)) return true        // Windows UNC
  return false
}

/**
 * Decide whether one remote operation is permitted under a mode.
 *
 * `operation` is the coarse kind the tools act with:
 *   - `read`   — reading remote data (never denied: read-only still reads)
 *   - `write`  — creating/replacing/removing a REMOTE PATH (path fence)
 *   - `exec`   — running an arbitrary remote command
 *   - `tunnel` — opening a port forward
 *   - `connect`— dialing/authenticating a machine (never denied: without it
 *                nothing else could work, and it changes no remote state)
 *
 * @param {object} arg
 * @param {string} arg.mode - the resolved sandbox mode.
 * @param {string} arg.operation - see above.
 * @param {string} [arg.path] - the remote path a `write` targets.
 * @param {string} arg.workspaceRoot - the remote workspace root.
 * @returns {{allowed: boolean, reason?: string, mode: string, subject?: string}}
 */
export function checkRemoteSandbox({ mode, operation, path: target, workspaceRoot }) {
  const m = REMOTE_SANDBOX_MODES.includes(mode) ? mode : 'read-only'
  // Fail closed on an unknown mode, exactly like the official renderPolicyContext.
  const effective = m

  if (operation === 'read' || operation === 'connect') return { allowed: true, mode: effective }

  if (effective === 'danger-full-access') return { allowed: true, mode: effective }

  if (effective === 'read-only') {
    // read-only refuses every state-changing remote operation. This is the
    // strict reading of the official mode ("`read-only` permits only required
    // sinks such as /dev/null") and the one that keeps a confined session
    // honest on a machine whose filesystem it cannot police.
    return {
      allowed: false,
      mode: effective,
      subject: operation === 'exec' ? 'command' : operation === 'tunnel' ? 'tunnel' : 'operation',
      reason:
        operation === 'exec'
          ? 'read-only sessions may not run commands on a remote host'
          : operation === 'tunnel'
            ? 'read-only sessions may not open remote port forwards'
            : 'read-only sessions may not modify a remote host',
    }
  }

  // workspace-write: writes must stay inside the workspace; exec and tunnel are
  // allowed because a command's effects cannot be bounded lexically (and the
  // official bash tool under workspace-write DOES run commands, confining them
  // via the OS). Refusing exec here would make workspace-write useless for the
  // primary remote use case (builds, tests), while pretending to confine it
  // would be worse than saying we do not.
  if (operation === 'exec' || operation === 'tunnel') return { allowed: true, mode: effective }

  // A write with no resolvable workspace root cannot be proven inside it.
  if (!workspaceRoot) {
    return {
      allowed: false,
      mode: effective,
      subject: 'operation',
      reason: 'workspace-write needs a remote workspace root to fence writes; none is set',
    }
  }
  if (isInsideRemote(target, workspaceRoot)) return { allowed: true, mode: effective }
  return {
    allowed: false,
    mode: effective,
    subject: 'operation',
    reason: `workspace-write only permits changes inside ${workspaceRoot}`,
  }
}

/**
 * Render a denial into the official error shape so the model sees the same
 * thing it would from a local sandbox denial (and can use the same escalation
 * affordances when the composition advertises them).
 *
 * @param {{mode: string, reason?: string, subject?: string}} denial
 * @returns {Error}
 */
export function remoteSandboxDenial(denial) {
  const mode = (denial && denial.mode) || 'read-only'
  const subject = (denial && denial.subject) || 'operation'
  const hint = `[escalation: raise sandbox mode to retry the ${subject} once]`
  const err = new Error(`${DENIAL_PREFIX}${mode}]\n${denial && denial.reason ? denial.reason + '\n' : ''}${hint}`)
  err.code = 'FS_SANDBOX_DENIED'
  err.remoteSandbox = { mode, subject }
  return err
}

/**
 * Relative path of a remote target under the workspace root, for diagnostics.
 * Returns null when the target is outside it.
 * @param {string} target
 * @param {string} root
 * @returns {string|null}
 */
export function remoteRelUnder(target, root) {
  const rel = relPathUnder(root, target)
  return rel === null ? null : rel
}
