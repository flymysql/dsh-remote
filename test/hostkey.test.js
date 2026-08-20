import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyFingerprint, blobAlgorithm, makeKeyBlob } from '../lib/hostkey.js'

// Regression guard for v0.6.7: ssh2 v1.17 passes hostVerifier the RAW host-key
// blob Buffer (SSH wire format), NOT { algo, hash }. keyFingerprint must accept
// the real Buffer shape and never crash with update(undefined).
test('keyFingerprint accepts the raw wire-format Buffer (ssh2 v1.17 shape)', () => {
  const blob = makeKeyBlob('ssh-ed25519', 7)
  assert.ok(Buffer.isBuffer(blob))
  const fp = keyFingerprint(blob)
  assert.equal(typeof fp, 'string')
  assert.ok(fp.length >= 40)
  // Deterministic: same key → same fingerprint.
  assert.equal(keyFingerprint(makeKeyBlob('ssh-ed25519', 7)), fp)
  // Different key → different fingerprint.
  assert.notEqual(keyFingerprint(makeKeyBlob('ssh-ed25519', 8)), fp)
})

test('keyFingerprint still accepts the legacy { algo, hash } shape', () => {
  const hash = Buffer.from('x'.repeat(32), 'utf8')
  assert.equal(keyFingerprint({ algo: 'ssh-rsa', hash }), keyFingerprint(hash))
})

test('keyFingerprint throws when no key is present', () => {
  assert.throws(() => keyFingerprint(undefined), /host key missing/)
})

test('blobAlgorithm extracts the algorithm name from the blob head', () => {
  assert.equal(blobAlgorithm(makeKeyBlob('ssh-ed25519', 1)), 'ssh-ed25519')
  assert.equal(blobAlgorithm(makeKeyBlob('ssh-rsa', 2)), 'ssh-rsa')
  assert.equal(blobAlgorithm(Buffer.alloc(2)), '')
  assert.equal(blobAlgorithm(null), '')
})
