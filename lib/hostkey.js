// dsh-remote — host-key fingerprint helpers (TOFU). Pure functions split out
// of lib/index.js so the ssh2 hostVerifier contract (raw Buffer blob since
// ssh2 v1.17) is unit-tested against the REAL wire shape — the v0.6.7 bug
// class ("mock object hid a contract drift") must not regress.
import { createHash } from 'node:crypto'

/**
 * Extract the SSH host-key algorithm name from a raw SSH host-key blob
 * (SSH wire format: `uint32 len` + algorithm string + key data).
 */
export function blobAlgorithm(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 4) return ''
  try {
    const len = blob.readUInt32BE(0)
    return blob.toString('utf8', 4, 4 + len)
  } catch {
    return ''
  }
}

/**
 * SHA-256 fingerprint (base64) of an ssh2 host-key blob, like `SHA256:…`
 * in a known_hosts file (without the `SHA256:` prefix).
 *
 * ssh2 v1.17 passes hostVerifier the RAW host-key blob Buffer (the SSH
 * wire-format `string(algo) string(keydata)`), NOT the old `{ algo, hash }`
 * object. Fingerprinting `key.hash` on a raw Buffer crashed with "The 'data'
 * argument must be of type string or an instance of Buffer…" on EVERY connect
 * (v0.6.6 bug). Accept both shapes defensively.
 */
export function keyFingerprint(key) {
  const blob = Buffer.isBuffer(key) ? key : (key && key.hash)
  if (!blob) throw new Error('host key missing (hostVerifier received no key blob)')
  return createHash('sha256').update(blob).digest('base64')
}

/** Build a fake-but-wire-shaped host-key blob for tests:
 * `string(algo) string(32 bytes)`. */
export function makeKeyBlob(algo, seed) {
  const algoBuf = Buffer.from(algo, 'utf8')
  const data = Buffer.alloc(32, seed || 1)
  const blob = Buffer.alloc(4 + algoBuf.length + 4 + data.length)
  blob.writeUInt32BE(algoBuf.length, 0)
  algoBuf.copy(blob, 4)
  blob.writeUInt32BE(data.length, 4 + algoBuf.length)
  data.copy(blob, 8 + algoBuf.length)
  return blob
}
