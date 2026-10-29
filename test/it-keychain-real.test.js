// REAL-MACHINE integration: the OS keychain backends.
//
// `lib/credential.js` picks a different store per platform (macOS `security`,
// Windows DPAPI via PowerShell, Linux `secret-tool`) and every one of them is a
// subprocess talking to an OS service. A unit test can only prove the DECISION
// logic; whether a secret actually round-trips, and what happens on a machine with
// NO store at all, needs the real platform.
//
// The contract under test is the one issue #30 established: a password must never
// silently end up as plaintext because the store failed — the machine is saved
// without a credential and the failure is reported.
//
// Always runs (it uses the CURRENT platform's real backend). No env needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { saveSecret, getSecret, deleteSecret, platformBackend, persistPassword } from '../lib/credential.js'

const SECRET = 'it-keychain-Sup3r-Secret!&%^'
const ID = `m-it-${process.pid}-${Date.now()}`

function secretsDir() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-remote-it-keychain-'))
}

test('the current platform\'s keychain really stores, returns and deletes a secret', async () => {
  const dir = secretsDir()
  try {
    const saved = await saveSecret(ID, SECRET, dir)
    if (!saved.ok) {
      // A machine with no usable store (headless Linux without secret-tool, a
      // locked keychain) is a legitimate outcome — what matters is that it says so
      // and that nothing was written.
      assert.ok(String(saved.error || '').length > 0, 'a failed store must explain itself')
      assert.equal(await getSecret(ID, dir), null, 'and must not leave a retrievable secret behind')
      return
    }
    const back = await getSecret(ID, dir)
    assert.equal(back, SECRET, `the secret must round-trip through the ${saved.backend} backend verbatim`)
    await deleteSecret(ID, dir)
    assert.equal(await getSecret(ID, dir), null, 'delete must actually remove it')
  } finally {
    await deleteSecret(ID, dir).catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a secret with shell metacharacters survives the store unchanged', async () => {
  // DPAPI goes through PowerShell and `secret-tool` goes through argv, so quotes,
  // ampersands and percent signs are exactly where an escaping bug hides.
  const dir = secretsDir()
  const tricky = `p@ss "with" 'quotes' & $dollar %PERCENT% ^caret`
  try {
    const saved = await saveSecret(ID, tricky, dir)
    if (!saved.ok) return // no store on this machine; covered above
    assert.equal(await getSecret(ID, dir), tricky, 'metacharacters must not be mangled or interpreted')
  } finally {
    await deleteSecret(ID, dir).catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('persistPassword keeps the plaintext OUT of the registry when the store works', async () => {
  const dir = secretsDir()
  try {
    const res = await persistPassword({ backend: platformBackend(), machineId: ID, password: SECRET, secretsDir: dir })
    if (res.stored === 'secret') {
      assert.equal(res.password, '', 'a stored secret must never be handed back for plaintext persistence')
      assert.equal(res.warning, '')
      assert.ok(res.credentialBackend && res.credentialBackend !== 'plain')
    } else {
      // No store → the documented refusal (issue #30), never a silent downgrade.
      assert.equal(res.stored, 'none')
      assert.equal(res.warning, 'secret-store-refused')
      assert.equal(res.password, '', 'the refusal must not fall back to plaintext')
      assert.ok(String(res.error || '').length > 0, 'the refusal must name the store failure')
    }
  } finally {
    await deleteSecret(ID, dir).catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the backend name matches the platform it is running on', () => {
  const backend = platformBackend()
  const expected = process.platform === 'darwin' ? 'keychain' : process.platform === 'win32' ? 'windows' : 'secret'
  assert.equal(backend, expected, `platform ${process.platform} must map to ${expected}`)
})

test('on Windows the secret lands in the DPAPI store, not in a plaintext file', async () => {
  if (process.platform !== 'win32') return
  const dir = secretsDir()
  try {
    const saved = await saveSecret(ID, SECRET, dir)
    assert.equal(saved.ok, true, `DPAPI must work on a normal Windows host: ${saved.error}`)
    const file = path.join(dir, `${ID}.bin`)
    assert.ok(existsSync(file), 'the DPAPI ciphertext file must exist')
    const raw = await import('node:fs').then((fs) => fs.readFileSync(file, 'utf8'))
    assert.equal(raw.includes(SECRET), false, 'the on-disk form must be ciphertext, not the password')
    assert.equal(await getSecret(ID, dir), SECRET, 'and it must decrypt back')
  } finally {
    await deleteSecret(ID, dir).catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
