// dsh-remote — host-key fingerprint helpers (TOFU). Pure functions split out
// of lib/index.js so the ssh2 hostVerifier contract (raw Buffer blob since
// ssh2 v1.17) is unit-tested against the REAL wire shape — the v0.6.7 bug
// class ("mock object hid a contract drift") must not regress.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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

// ── known_hosts trust store: durable writes, visible incidents ──────────────
//
// Continues the "never a half-written file" line lib/update.js writeFileAtomic
// established for installed files (0.8.24, 2d7d9de): createHostKeyGuard used a
// bare writeFileSync, so a crash mid-write could truncate the store, and
// loadKnownHosts swallowed ANY parse failure into {} — a truncated store then
// made isHostKeyKnown false for everything, and a DIFFERENT key (simulated
// MITM) was silently accepted via accept-new with no signal at all. The store
// is now written atomically, and an existing-but-unparseable store is an
// INCIDENT: moved aside as evidence and surfaced through guard.lastError +
// lastKnownHostsCorruption() + one console.warn (the same "an incident nothing
// can observe is indistinguishable from one that never happened" rule
// lib/update.js lastSelfReload enforces), while TOFU keeps accepting unknown
// hosts — the ssh2 hostVerifier boolean contract is unchanged.

/** Most recent known_hosts corruption incident, for diagnostics. */
let lastCorruptIncident = null

/** @returns the latest known_hosts corruption incident
 *  (`{ file, error, at, movedTo, moveError? }`, `movedTo` empty when the
 *  move-aside failed), or null when none occurred in this process. */
export function lastKnownHostsCorruption() {
  return lastCorruptIncident
}

/**
 * Move an unparseable known_hosts file aside (`<file>.corrupt-<UTC stamp>`) so
 * the evidence survives and the next write starts from a clean slate — never
 * deleted, never overwritten. Best-effort: when the move fails (read-only
 * directory, exotic filesystem) the file stays put and the incident is still
 * recorded; TOFU continues either way.
 */
function quarantineKnownHosts(file, reason) {
  const incident = { file, error: reason, at: new Date().toISOString(), movedTo: '' }
  try {
    const stamp = incident.at.replace(/[:.]/g, '-')
    let movedTo = `${file}.corrupt-${stamp}`
    for (let n = 1; existsSync(movedTo); n++) movedTo = `${file}.corrupt-${stamp}-${n}`
    renameSync(file, movedTo)
    incident.movedTo = movedTo
  } catch (error) {
    incident.moveError = String((error && error.message) || error)
  }
  lastCorruptIncident = incident
  // The next connect usually SUCCEEDS (TOFU restarts), so no failure path will
  // print this for us — say it once here, like scheduleSelfReload does.
  console.warn(
    `[dsh-remote] known_hosts trust store is corrupt (${reason}); ` +
    (incident.movedTo ? `moved aside to ${incident.movedTo}` : `could not move it aside: ${incident.moveError}`) +
    ' — stored host keys were lost; review the moved-aside file before trusting new keys',
  )
  return incident
}

/**
 * Read + parse the JSON trust store. A MISSING file is the normal TOFU start
 * (`{ hosts: {} }`); an EXISTING file that cannot be read or parsed as a plain
 * object is an incident — quarantined and reported through `incident` — while
 * `hosts` stays `{}` so every boolean caller (isHostKeyKnown, the ssh2
 * hostVerifier) keeps its exact contract.
 */
function readKnownHosts(file) {
  if (!file) return { hosts: {} }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { hosts: {} }
    return { hosts: {}, incident: quarantineKnownHosts(file, `unreadable (${(error && error.message) || error})`) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { hosts: {}, incident: quarantineKnownHosts(file, `invalid JSON (${(error && error.message) || error})`) }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { hosts: parsed }
  const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed
  return { hosts: {}, incident: quarantineKnownHosts(file, `not a JSON object (${shape})`) }
}

/** Best-effort known_hosts read: the host map only (corrupt stores are
 *  quarantined inside — see readKnownHosts). */
export function loadKnownHosts(file) {
  return readKnownHosts(file).hosts
}

export function isHostKeyKnown(file, host, port) {
  return Object.prototype.hasOwnProperty.call(loadKnownHosts(file), `${host}:${port}`)
}

/**
 * Write the trust store atomically: the bytes land in a sibling temp file and
 * are renamed over the target, so a crash mid-write leaves the previous store
 * intact — never a truncated file. Falls back to an in-place copy when the
 * platform refuses the rename, and never leaves the temp file behind.
 *
 * Deliberately NOT lib/update.js writeFileAtomic re-imported: this module is a
 * low-level helper on the SSH connect path, and importing the self-update
 * module (network/proxy machinery, an import-time LOADED_VERSION snapshot)
 * here would invert the dependency direction and couple every connect to the
 * updater.
 */
function writeKnownHostsAtomic(file, data) {
  const tmp = `${file}.dsh-tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, file)
  } catch {
    try {
      copyFileSync(tmp, file)
    } finally {
      try { rmSync(tmp, { force: true }) } catch {}
    }
  }
}

/** Build an ssh2 `hostVerifier` bound to the current config + known_hosts file. */
export function createHostKeyGuard(config, knownHostsFile) {
  const id = () => `${config.host}:${config.port}`
  const mode = config.hostKeyMode === 'verify' || config.hostKeyMode === 'off'
    ? config.hostKeyMode
    : 'accept-new'
  let incidentNote = ''
  const read = () => {
    const { hosts, incident } = readKnownHosts(knownHostsFile)
    incidentNote = incident
      ? `known_hosts trust store was corrupt (${incident.error}); ` +
        (incident.movedTo ? `moved aside to ${incident.movedTo}` : `move-aside failed (${incident.moveError})`) +
        ' — every stored host key was lost, so keys presented now are accepted as NEW (TOFU restart)'
      : ''
    // Surface the incident through the guard's existing reporting channel
    // (pool.js classifies guard.lastError on connect failure). The boolean
    // contract is untouched: TOFU still accepts the unknown host.
    if (incident) guard.lastError = incidentNote
    return hosts
  }
  const write = (kh) => {
    if (!knownHostsFile) return
    try { mkdirSync(path.dirname(knownHostsFile), { recursive: true }) } catch {}
    writeKnownHostsAtomic(knownHostsFile, JSON.stringify(kh, null, 2))
  }
  const guard = {
    mode,
    lastError: null,
    knownHosts: read,
    forgetHost() {
      const kh = read()
      delete kh[id()]
      write(kh)
    },
    verifier(key) {
      if (mode === 'off') return true
      const fp = keyFingerprint(key)
      const kh = read()
      const stored = kh[id()]
      if (stored) {
        if (stored.fingerprint === fp) return true
        guard.lastError =
          `host key for ${id()} CHANGED (stored ${stored.fingerprint}, received ${fp}) — ` +
          'possible man-in-the-middle; run /remote-forget-key to re-trust if this is expected'
        return false
      }
      if (mode === 'verify') {
        guard.lastError = `unknown host key for ${id()} (hostKeyMode=verify) — trust it first with accept-new` +
          (incidentNote ? `; note: ${incidentNote}` : '')
        return false
      }
      kh[id()] = { algo: blobAlgorithm(key) || (key && key.algo) || 'unknown', fingerprint: fp, firstSeen: new Date().toISOString() }
      write(kh)
      return true
    },
  }
  return guard
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
