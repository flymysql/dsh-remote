// Helpers for the REAL-MACHINE integration suites (test/it-*.test.js).
//
// These suites are the answer to "we can only test this with a real host": the
// system-OpenSSH backend needs a real `ssh`, the keychain backends need a real OS
// store, and the remote Web UI tunnel needs a real `dsh web` on the far side.
//
// They are ENV-GATED on purpose:
//   · no env → the suite SKIPS with a message naming the variables (never silently
//     passes, never fails CI);
//   · credentials are never written to the repo — they come from the environment;
//   · every suite cleans up what it created (keychain entries, tunnels, remote
//     processes) because it runs against a machine someone is using.
//
// Variables (all optional, each suite names the subset it needs):
//   IT_SSH_HOST, IT_SSH_PORT, IT_SSH_USER       — the real host to dial
//   IT_SSH_PASSWORD                             — password auth (askpass)
//   IT_SSH_KEY                                  — private key path (key auth)
//   IT_SSH_ALIAS                                — a ~/.ssh/config Host alias to use
//   IT_SSH_GSSAPI=1                             — the alias needs GSSAPI/Kerberos
//   IT_WEB_* (same as IT_SSH_*)                 — the host that runs `dsh web`
//   IT_WEB_DSH_COMMAND                          — the remote dsh command (default: dsh)
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Read a real-host target from the environment, or null when it is not configured. */
export function realTarget(prefix = 'IT_SSH') {
  const alias = String(process.env[`${prefix}_ALIAS`] || '').trim()
  const host = String(process.env[`${prefix}_HOST`] || '').trim() || alias
  if (!host) return null
  return {
    // An alias-only setup is legitimate: host/user/port/key all come from the
    // user's ~/.ssh/config, which is the point of the alias case.
    host,
    port: Number(process.env[`${prefix}_PORT`] || 22),
    username: String(process.env[`${prefix}_USER`] || '').trim() || undefined,
    password: process.env[`${prefix}_PASSWORD`] || '',
    privateKeyPath: process.env[`${prefix}_KEY`] || '',
    alias,
    gssapi: process.env[`${prefix}_GSSAPI`] === '1',
    dshCommand: process.env[`${prefix}_DSH_COMMAND`] || '',
  }
}

/** The skip message a suite prints when it has nothing to dial. */
export function skipMessage(prefix = 'IT_SSH', needed = [`${prefix}_HOST`]) {
  return `real-machine integration suite skipped — set ${needed.join(', ')} to run it`
}

/** Is a runnable `ssh` on PATH? (The OpenSSH backend needs one.) */
export function localSshAvailable() {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ssh'], { stdio: 'pipe' })
    return true
  } catch { return false }
}

/** A pool config for a real target (the shape lib/pool.js and lib/openssh.js expect). */
export function poolConfigFor(target, overrides = {}) {
  return {
    host: target.host,
    port: target.port,
    username: target.username || 'root',
    password: target.password || '',
    privateKeyPath: target.privateKeyPath || '',
    passphrase: '',
    workspace: '',
    shell: '',
    commandTimeoutMs: 30000,
    connectTimeoutMs: 25000,
    maxOutputChars: 200000,
    maxFileBytes: 1000000,
    hostKeyMode: 'accept-new',
    useAgent: false,
    keyboardInteractive: false,
    autoPush: false,
    auditLog: false,
    encoding: 'utf-8',
    updateMode: 'off',
    updateCheckIntervalMs: 0,
    backend: 'native',
    sshBinary: '',
    ...overrides,
  }
}

/** A machine record for the host harness pointing at the real target. */
export function realMachine(target, overrides = {}) {
  return {
    id: overrides.id || 'm-it-real',
    name: overrides.name || `it-${target.host}`,
    host: target.host,
    port: target.port,
    username: target.username || 'root',
    password: target.password || '',
    privateKeyPath: target.privateKeyPath || '',
    passphrase: '',
    workspace: '',
    hostKeyMode: 'accept-new',
    useAgent: false,
    keyboardInteractive: false,
    backend: 'native',
    sshBinary: '',
    credentialBackend: 'plain',
    recentWorkspaces: [],
    lastConnectedAt: null,
    latencyMs: null,
    ...overrides,
  }
}

/** True when a local path exists (used to skip on a missing key file). */
export const exists = (p) => !!p && existsSync(p)
