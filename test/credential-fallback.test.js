// Credential fallback policy — asking for encryption must never end in
// plaintext without an explicit choice.
//
// History: issue #30 made a failed OS-store write fall back to plaintext in
// machines.json with a warning, because throwing the result away had silently
// produced credential-less machines. The fix traded one accident for another:
// a locked keychain / missing secret-tool is exactly when writing a password to
// a world-readable file is least likely to be noticed, and the user had asked
// for encryption in the first place.
//
// The policy now: `refuse` (default) stores NOTHING when the secure store
// fails; `plain` restores the legacy behaviour for users who want it. An
// explicit `backend: 'plain'` (encryption turned off by request) is unaffected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { persistPassword } from '../lib/credential.js'

const failingSave = async () => ({ ok: false, error: 'keychain is locked' })
const okSave = async (_id, _pw, _dir) => ({ ok: true, backend: 'keychain' })

test('a working secure store keeps the password out of the record', async () => {
  const r = await persistPassword({
    backend: 'keychain', machineId: 'm1', password: 'hunter2', save: okSave,
  })
  assert.equal(r.stored, 'secret')
  assert.equal(r.password, '', 'the plaintext must not travel back into machines.json')
  assert.equal(r.warning, '')
})

test('a FAILED store refuses by default: nothing is written, and it says why', async () => {
  const r = await persistPassword({
    backend: 'keychain', machineId: 'm1', password: 'hunter2', save: failingSave,
  })
  assert.equal(r.stored, 'none', 'the default must NOT downgrade to plaintext')
  assert.equal(r.password, '', 'no plaintext may be returned for persistence')
  assert.equal(r.warning, 'secret-store-refused')
  assert.match(r.error, /locked/)
  assert.equal(r.credentialBackend, 'keychain', 'the record keeps the intended backend for diagnostics')
})

test('onStoreFailure=plain restores the legacy fallback, explicitly', async () => {
  const r = await persistPassword({
    backend: 'keychain', machineId: 'm1', password: 'hunter2', save: failingSave,
    onStoreFailure: 'plain',
  })
  assert.equal(r.stored, 'plain')
  assert.equal(r.password, 'hunter2')
  assert.equal(r.warning, 'secret-store-failed', 'the old warning name is preserved for existing UI/tests')
  assert.equal(r.credentialBackend, 'plain')
})

test('turning encryption OFF (backend plain) is still plaintext by request', async () => {
  const r = await persistPassword({ backend: 'plain', machineId: 'm1', password: 'hunter2', save: failingSave })
  assert.equal(r.stored, 'plain')
  assert.equal(r.password, 'hunter2')
  assert.equal(r.warning, '', 'a deliberate choice is not a warning')
})

test('an empty password stores nothing and raises nothing', async () => {
  const r = await persistPassword({ backend: 'keychain', machineId: 'm1', password: '' })
  assert.equal(r.stored, 'none')
  assert.equal(r.warning, '')
})

test('a THROWN store error is treated as a store failure, not a crash', async () => {
  const r = await persistPassword({
    backend: 'windows', machineId: 'm1', password: 'hunter2',
    save: async () => { throw new Error('DPAPI assembly missing') },
  })
  assert.equal(r.stored, 'none', 'the default still refuses')
  assert.equal(r.warning, 'secret-store-refused')
  assert.match(r.error, /DPAPI/)
})

test('a thrown error never leaks the password into the reported reason', async () => {
  const secret = 'sup3r-s3cret-pw'
  const r = await persistPassword({
    backend: 'secret', machineId: 'm1', password: secret,
    // A realistic failure: execFile puts the full argv (with the password) into
    // the message. safeReason must scrub it.
    save: async () => { throw new Error(`Command failed: secret-tool store --label=${secret}`) },
  })
  assert.equal(r.stored, 'none')
  assert.doesNotMatch(r.error, new RegExp(secret), 'the secret must be scrubbed from the diagnostic')
  assert.match(r.error, /\*\*\*/)
})
