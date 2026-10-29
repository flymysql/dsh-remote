// dsh-remote — optional OS-keychain password storage.
// Machines keep their password in the OS credential store instead of the
// plaintext machines.json when the user enables "加密保存密码" per machine.
// Every backend is best-effort: any failure resolves to {ok:false} and the
// caller (persistPassword) falls back to plaintext + a user-visible warning
// (the feature must never block connecting, and must never silently drop the
// credential — issue #30).
//
// Backends:
//   darwin  → `security` (login keychain, generic password)
//   win32   → DPAPI via PowerShell (CurrentUser scope), files under
//             $DSH_HOME/remote-workspaces/.secrets/
//   linux   → `secret-tool` (libsecret / gnome-keyring), optional
//   else    → unsupported (plain)
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join as joinPath } from 'node:path'

const SERVICE = 'dsh-remote'
const TIMEOUT = 8000

// Windows PowerShell 5.1 does not preload System.Security, so
// [System.Security.Cryptography.ProtectedData] is "not found" until the assembly
// is added (issue #30: without this the whole DPAPI call failed and the caller
// silently lost the password). `-ErrorAction SilentlyContinue` keeps the line
// harmless on PowerShell 7, where the type is already available.
const PS_SECURITY_ASSEMBLY = 'Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue;'

/**
 * Run a helper and resolve with its trimmed stdout.
 *
 * WHY `spawn` and not `execFile(..., { input })`: measured on a real Ubuntu box
 * with a real gnome-keyring, `secret-tool store` given its password through
 * `execFile`'s `input` option **never saw EOF**, blocked on the read, and was
 * killed by this timeout — so on Linux "encrypt the password" always failed after
 * 8 seconds with the useless message "Command failed: secret-tool store …" (empty
 * stderr) and the credential was dropped. The same command with an explicitly
 * ended stdin (`spawn` + `stdin.end()`, or `sh -c '… < file'`) finishes in ~20ms.
 * Nothing in this module needs the extra `execFile` machinery, so stdin is now
 * always closed explicitly and the child's stderr is carried on the error (the old
 * path dropped it, which is why the failure had no reason attached).
 */
function run(bin, args, input) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }
    let out = ''
    let errOut = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      const err = new Error(`${bin} timed out after ${TIMEOUT}ms`)
      err.stderr = errOut
      err.code = 'ETIMEDOUT'
      reject(err)
    }, TIMEOUT)
    const done = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err); else resolve(value)
    }
    child.on('error', (err) => done(err))
    child.on('close', (code) => {
      if (code === 0) return done(null, out.trim())
      const err = new Error(`${bin} exited with ${code}${errOut.trim() ? ': ' + errOut.trim().slice(0, 300) : ''}`)
      err.code = code
      err.stderr = errOut
      done(err)
    })
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { errOut += d })
    // Always end stdin: a helper that reads a secret from stdin needs EOF, and one
    // that does not must not inherit an open pipe.
    try { child.stdin.end(input == null ? '' : String(input)) } catch { /* closed early */ }
  })
}

export function platformBackend() {
  if (process.platform === 'darwin') return 'keychain'
  if (process.platform === 'win32') return 'windows'
  return 'secret' // linux (secret-tool may be absent → falls back)
}

function account(machineId) {
  // Only machine ids are stored; sanitize just in case.
  return String(machineId || '').replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** Redact a failed command's diagnostics: execFile puts the FULL command line
 * (which carries the password as an argv) into `err.message`, and this string is
 * shown in the settings UI — so the secret must never survive it. */
function safeReason(err, password) {
  const raw = [err && err.stderr, err && err.message, err && err.code]
    .filter(Boolean).map(String).join(' ')
  const secret = String(password == null ? '' : password)
  const scrubbed = secret ? raw.split(secret).join('***') : raw
  return scrubbed.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** PowerShell one-liner that DPAPI-protects a password (CurrentUser scope).
 *  Exported because the issue #30 fix (the mandatory Add-Type preamble) is only
 *  observable here — a Windows host cannot be exercised from the test suite. */
export function dpapiProtectScript(password) {
  return PS_SECURITY_ASSEMBLY +
    `$p='${String(password).replace(/'/g, "''")}';` +
    `$s=[System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($p),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    `[Convert]::ToBase64String($s)`
}

/** PowerShell one-liner that reverses dpapiProtectScript(). */
export function dpapiUnprotectScript(b64) {
  return PS_SECURITY_ASSEMBLY +
    `$s=[Convert]::FromBase64String('${String(b64).replace(/'/g, "''")}');` +
    `[Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($s,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))`
}

/** Save a password to the OS store. Resolves {ok, backend, error} — ok:false on
 * any failure (caller falls back to plaintext). `error` is a password-free
 * diagnostic for the UI. */
export async function saveSecret(machineId, password, secretsDir) {
  const acc = account(machineId)
  try {
    if (process.platform === 'darwin') {
      await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', acc, '-w', String(password)])
      return { ok: true, backend: 'keychain', error: '' }
    }
    if (process.platform === 'win32') {
      // DPAPI-encrypt and store under the harness home.
      const script = dpapiProtectScript(password)
      const b64 = await run('powershell', ['-NoProfile', '-STA', '-Command', script])
      if (!b64) return { ok: false, backend: 'windows', error: 'DPAPI returned no ciphertext' }
      mkdirSync(secretsDir || '.', { recursive: true })
      writeFileSync(joinPath(secretsDir || '.', acc + '.bin'), b64, 'utf8')
      return { ok: true, backend: 'windows', error: '' }
    }
    if (process.platform === 'linux') {
      await run('secret-tool', ['store', '--label=' + SERVICE, 'service', SERVICE, 'account', acc], String(password) + '\n')
      return { ok: true, backend: 'secret', error: '' }
    }
  } catch (err) {
    return { ok: false, backend: platformBackend(), error: safeReason(err, password) || 'secret store write failed' }
  }
  return { ok: false, backend: platformBackend(), error: `unsupported platform: ${process.platform}` }
}

/** Decide where a machine password is persisted (issue #30).
 *
 * The contract the settings UI relies on: a password is NEVER silently dropped.
 * Historically that guarantee was upheld by falling back to PLAINTEXT in
 * machines.json, which is a bad trade in one specific way: the user asked for
 * encryption, the store failed, and the secret ended up less protected than if
 * they had never asked. Worse, a locked keychain / missing secret-tool is
 * exactly the moment when quietly writing a password to a world-readable file
 * on disk is most likely to go unnoticed.
 *
 * So the fallback is a POLICY, not a fixed behaviour (`onStoreFailure`):
 *
 *   `refuse`  (default) — do not store the password at all. The machine is
 *             saved WITHOUT a credential and the caller reports how to fix the
 *             store; the user retypes (or connects) and nothing lands in
 *             plaintext by accident. `stored: 'none'` makes that explicit.
 *   `plain`   — the legacy behaviour: write it to machines.json and raise
 *             `warning: 'secret-store-failed'`. Opt-in only, for users who
 *             genuinely prefer a working machine over the storage guarantee.
 *
 * An explicit `backend: 'plain'` still means plain by REQUEST (the user turned
 * encryption off), and is unaffected by this policy.
 *
 * `save` is injectable so both paths are unit-testable on any platform.
 *
 * @param {object} arg
 * @param {string} arg.backend - the platform backend name ('keychain'|'windows'|'secret'|'plain').
 * @param {string} arg.machineId
 * @param {string} arg.password
 * @param {string} [arg.secretsDir]
 * @param {'refuse'|'plain'} [arg.onStoreFailure] - see above.
 * @param {Function} [arg.save] - injectable secure-store writer.
 * @returns {Promise<{stored:'secret'|'plain'|'none', credentialBackend:string, password:string, warning:string, error:string}>}
 */
export async function persistPassword({
  backend, machineId, password, secretsDir,
  onStoreFailure = 'refuse',
  save = saveSecret,
}) {
  const pw = password == null ? '' : String(password)
  const want = backend && backend !== 'plain' ? backend : 'plain'
  if (!pw) return { stored: 'none', credentialBackend: want, password: '', warning: '', error: '' }
  if (want === 'plain') return { stored: 'plain', credentialBackend: 'plain', password: pw, warning: '', error: '' }
  let res
  try {
    res = await save(machineId, pw, secretsDir)
  } catch (err) {
    res = { ok: false, error: safeReason(err, pw) }
  }
  if (res && res.ok) {
    return { stored: 'secret', credentialBackend: res.backend || want, password: '', warning: '', error: '' }
  }
  const error = String((res && res.error) || '') || 'secret store write failed'
  if (onStoreFailure === 'plain') {
    return {
      stored: 'plain',
      credentialBackend: 'plain',
      password: pw,
      warning: 'secret-store-failed',
      error,
    }
  }
  // Default: refuse. Nothing is written, and the caller surfaces the store
  // failure plus the platform-specific repair hint instead of a silent downgrade.
  return {
    stored: 'none',
    credentialBackend: want,
    password: '',
    warning: 'secret-store-refused',
    error,
  }
}

/** Fetch a stored password. Resolves string|null. */
export async function getSecret(machineId, secretsDir) {
  const acc = account(machineId)
  try {
    if (process.platform === 'darwin') {
      return await run('security', ['find-generic-password', '-s', SERVICE, '-a', acc, '-w'])
    }
    if (process.platform === 'win32') {
      const b64 = readFileSync(joinPath(secretsDir || '.', acc + '.bin'), 'utf8').trim()
      if (!b64) return null
      const script = dpapiUnprotectScript(b64)
      return await run('powershell', ['-NoProfile', '-STA', '-Command', script])
    }
    if (process.platform === 'linux') {
      return await run('secret-tool', ['lookup', 'service', SERVICE, 'account', acc])
    }
  } catch { /* fall through */ }
  return null
}

/** Delete a stored password (idempotent). */
export async function deleteSecret(machineId, secretsDir) {
  const acc = account(machineId)
  try {
    if (process.platform === 'darwin') {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', acc]).catch(() => {})
      return
    }
    if (process.platform === 'win32') {
      try { unlinkSync(joinPath(secretsDir || '.', acc + '.bin')) } catch { /* absent */ }
      return
    }
    if (process.platform === 'linux') {
      await run('secret-tool', ['clear', 'service', SERVICE, 'account', acc]).catch(() => {})
    }
  } catch { /* best effort */ }
}
