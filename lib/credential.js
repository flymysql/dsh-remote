// dsh-remote — optional OS-keychain password storage.
// Machines keep their password in the OS credential store instead of the
// plaintext machines.json when the user enables "加密保存密码" per machine.
// Every backend is best-effort: any failure resolves to {ok:false} and the
// caller falls back to plaintext (the feature must never block connecting).
//
// Backends:
//   darwin  → `security` (login keychain, generic password)
//   win32   → DPAPI via PowerShell (CurrentUser scope), files under
//             $DSH_HOME/remote-workspaces/.secrets/
//   linux   → `secret-tool` (libsecret / gnome-keyring), optional
//   else    → unsupported (plain)
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join as joinPath } from 'node:path'

const SERVICE = 'dsh-remote'
const TIMEOUT = 8000

function run(bin, args, input) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: TIMEOUT, maxBuffer: 1 << 20, ...(input != null ? { input } : {}) }, (err, stdout, stderr) => {
      if (err) return reject(err)
      resolve(String(stdout || '').trim())
    })
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

/** Save a password to the OS store. Resolves {ok, backend} — ok:false on any
 * failure (caller falls back to plaintext). */
export async function saveSecret(machineId, password, secretsDir) {
  const acc = account(machineId)
  try {
    if (process.platform === 'darwin') {
      await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', acc, '-w', String(password)])
      return { ok: true, backend: 'keychain' }
    }
    if (process.platform === 'win32') {
      // DPAPI-encrypt and store under the harness home.
      const script =
        `$p='${String(password).replace(/'/g, "''")}';` +
        `$s=[System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($p),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
        `[Convert]::ToBase64String($s)`
      const b64 = await run('powershell', ['-NoProfile', '-STA', '-Command', script])
      if (!b64) return { ok: false, backend: 'windows' }
      mkdirSync(secretsDir || '.', { recursive: true })
      writeFileSync(joinPath(secretsDir || '.', acc + '.bin'), b64, 'utf8')
      return { ok: true, backend: 'windows' }
    }
    if (process.platform === 'linux') {
      await run('secret-tool', ['store', '--label=' + SERVICE, 'service', SERVICE, 'account', acc], String(password) + '\n')
      return { ok: true, backend: 'secret' }
    }
  } catch { /* fall through */ }
  return { ok: false, backend: platformBackend() }
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
      const script =
        `$s=[Convert]::FromBase64String('${b64}');` +
        `[Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($s,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))`
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
