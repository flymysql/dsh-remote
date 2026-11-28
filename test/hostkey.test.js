import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { blobAlgorithm, createHostKeyGuard, isHostKeyKnown, keyFingerprint, loadKnownHosts, makeKeyBlob } from '../lib/hostkey.js'
// Namespace access (not a named import) for lastKnownHostsCorruption: that
// export arrives with the fix, and a missing NAMED export would fail the whole
// file at import time — the regression must run RED against the unfixed lib,
// not die before its first assertion.
import * as hostkeyModule from '../lib/hostkey.js'

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

// ── TOFU trust-store durability ─────────────────────────────────────────────
//
// Continues the fix line this file opened with (the v0.6.7 hostVerifier
// contract guard) plus the "never a half-written file" line lib/update.js
// writeFileAtomic established for installed files (0.8.24): createHostKeyGuard
// wrote known_hosts with a bare writeFileSync — a crash mid-write left a
// truncated JSON store — and loadKnownHosts answered ANY parse failure with {},
// so the truncated store made every host look unknown and a DIFFERENT key
// (simulated MITM) was silently trusted via accept-new with no signal at all.
// Now the store is written atomically, and an existing-but-unparseable store is
// quarantined (moved aside as evidence) and surfaced through guard.lastError /
// lastKnownHostsCorruption(), while TOFU keeps accepting unknown hosts.

/** A guard-written valid store, then truncated the way a crash mid-write
 *  would leave it (the exact artifact the atomic write eliminates). */
const corruptedStore = (seed = 1) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-hostkey-corrupt-'))
  const file = path.join(dir, 'known_hosts.json')
  const config = { host: 'mitm-test', port: 2222, hostKeyMode: 'accept-new' }
  assert.equal(createHostKeyGuard(config, file).verifier(makeKeyBlob('ssh-ed25519', seed)), true)
  const raw = readFileSync(file, 'utf8')
  writeFileSync(file, raw.slice(0, Math.floor(raw.length / 2)))
  return { dir, file, config, corruptBytes: readFileSync(file, 'utf8') }
}

test('regression: a different key after a corrupt store is accept-new, but the incident is observable', () => {
  const { dir, file, config, corruptBytes } = corruptedStore()
  try {
    const guard = createHostKeyGuard(config, file)
    // TOFU still continues for unknown hosts: the truncated store lost every
    // stored fingerprint, so the DIFFERENT key (simulated MITM) is accepted
    // as new — the boolean verifier contract is unchanged.
    assert.equal(guard.verifier(makeKeyBlob('ssh-ed25519', 2)), true,
      'accept-new must keep accepting unknown hosts after a corrupt store')
    // The unfixed code accepted that key with NO signal at all (lastError
    // stayed null, no evidence file) — that silence is the regression.
    assert.ok(guard.lastError, 'guard.lastError must surface the corrupt-store incident')
    assert.match(guard.lastError, /corrupt/i)
    // Evidence survives: the corrupt bytes were moved aside, not overwritten.
    const aside = readdirSync(dir).filter((name) => name.includes('.corrupt-'))
    assert.equal(aside.length, 1, `expected exactly one moved-aside evidence file, got: ${aside.join(', ')}`)
    assert.equal(readFileSync(path.join(dir, aside[0]), 'utf8'), corruptBytes,
      'the moved-aside file must preserve the corrupt bytes verbatim')
    // The live store restarted clean: only the newly trusted key is in it.
    const kh = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(kh), ['mitm-test:2222'])
    assert.equal(kh['mitm-test:2222'].fingerprint, keyFingerprint(makeKeyBlob('ssh-ed25519', 2)))
    // Equivalent observable for readers that never touch a guard (status
    // displays, diagnostics).
    const incident = hostkeyModule.lastKnownHostsCorruption?.()
    assert.ok(incident, 'lastKnownHostsCorruption() must record the incident')
    assert.equal(incident.file, file)
    assert.ok(incident.movedTo && incident.movedTo.includes('.corrupt-'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt known_hosts is quarantined by plain readers; isHostKeyKnown keeps its boolean contract', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-hostkey-quarantine-'))
  const file = path.join(dir, 'known_hosts.json')
  try {
    writeFileSync(file, '{"mitm-test:2222": {"fingerprint": "SHA')
    assert.equal(isHostKeyKnown(file, 'mitm-test', 2222), false,
      'a corrupt store must still answer false — never throw, never silently "known"')
    assert.deepEqual(loadKnownHosts(file), {})
    assert.ok(readdirSync(dir).some((name) => name.includes('.corrupt-')),
      'the corrupt bytes must be moved aside as evidence, not left as a landmine')
    assert.equal(existsSync(file), false, 'the live path is gone; the next write starts clean')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hostKeyMode=verify on a corrupt store still fails closed, with the incident observable', () => {
  const { dir, file } = corruptedStore(4)
  try {
    const guard = createHostKeyGuard({ host: 'mitm-test', port: 2222, hostKeyMode: 'verify' }, file)
    assert.equal(guard.verifier(makeKeyBlob('ssh-ed25519', 5)), false,
      'verify mode must still reject an unknown host (boolean contract)')
    assert.match(String(guard.lastError), /verify/i)
    assert.ok(readdirSync(dir).some((name) => name.includes('.corrupt-')),
      'the corrupt store must still be moved aside in verify mode')
    const incident = hostkeyModule.lastKnownHostsCorruption?.()
    assert.ok(incident, 'the corruption incident must be recorded even when the connect fails anyway')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('guard writes round-trip and never leave temp-file litter behind', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-hostkey-atomic-'))
  const file = path.join(dir, 'known_hosts.json')
  try {
    const guard = createHostKeyGuard({ host: 'litter-test', port: 22 }, file)
    assert.equal(guard.verifier(makeKeyBlob('ssh-ed25519', 3)), true)
    guard.forgetHost()
    assert.deepEqual(loadKnownHosts(file), {})
    assert.equal(guard.verifier(makeKeyBlob('ssh-ed25519', 3)), true)
    assert.equal(guard.verifier(makeKeyBlob('ssh-ed25519', 3)), true, 'same key stays trusted')
    assert.ok(readdirSync(dir).every((name) => !name.includes('.dsh-tmp-')),
      'atomic writes must not leave .dsh-tmp-* litter in the store directory')
    assert.equal(guard.lastError, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a valid store is never quarantined (no false-positive incidents)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-hostkey-valid-'))
  const file = path.join(dir, 'known_hosts.json')
  try {
    writeFileSync(file, JSON.stringify({
      'a:1': { algo: 'ssh-ed25519', fingerprint: keyFingerprint(makeKeyBlob('ssh-ed25519', 9)) },
    }, null, 2))
    const guard = createHostKeyGuard({ host: 'a', port: 1, hostKeyMode: 'verify' }, file)
    assert.equal(guard.verifier(makeKeyBlob('ssh-ed25519', 9)), true,
      'a matching key must still pass verify mode untouched by the hardening')
    assert.equal(guard.lastError, null)
    assert.ok(readdirSync(dir).every((name) => !name.includes('.corrupt-')),
      'a healthy store must not be moved aside')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
