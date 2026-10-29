// Machine-registry pure logic for dsh-remote.
//
// Issue #13: a SAVED machine is only a standby connection — it must never
// silently become the "active remote context" of every session. The registry
// therefore keeps `currentId` as an EXPLICIT user choice:
//   • loadMachines never falls back to the first saved machine,
//   • a stale currentId (machine deleted meanwhile) resolves to null,
//   • add/update never auto-activate; only an explicit "set current" does,
//   • deleting the current machine leaves NO current (no auto-promotion).
// Keeping this logic in one module makes the guarantee unit-testable and
// shared between the HTTP routes and the tools (rw_connect).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

/** Load { list, currentId, explicitNone } from the registry file. */
export function loadMachines(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(j.list)) {
      const list = j.list
      // Explicit choice only — no fallback to the first machine, no activation
      // of a stale/deleted id (issue #13).
      const currentId = j.currentId && list.some((m) => m.id === j.currentId) ? j.currentId : null
      // A persisted `currentId: null` is a deliberate "active remote = none"
      // (the user cleared the current machine). It must survive restarts so a
      // config-level default host cannot silently reactivate a context the user
      // explicitly turned off. `explicitNone` is true when the file carries an
      // explicit null (vs. a fresh file where currentId is simply absent).
      const explicitNone = Object.prototype.hasOwnProperty.call(j, 'currentId') && j.currentId == null
      return { list, currentId, explicitNone }
    }
  } catch {}
  return { list: [], currentId: null, explicitNone: false }
}

/** Persist { list, currentId }. `currentId` may be null → active remote = none.
 *  Pass `keepCurrentKey: false` (add/update a machine without touching the
 *  current selection) to PRESERVE whatever `currentId` the file already holds
 *  — so merely saving a machine never flips a fresh registry into "explicit
 *  none", nor clears an explicit choice. When no previous file exists the
 *  `currentId` key is omitted entirely (fresh registry = "no choice yet"). */
export function saveMachines(file, list, currentId, keepCurrentKey = true) {
  try { mkdirSync(path.dirname(file), { recursive: true }) } catch {}
  let stored = currentId
  let hasStored = keepCurrentKey
  if (!keepCurrentKey) {
    try {
      const prev = JSON.parse(readFileSync(file, 'utf8'))
      if (prev && Object.prototype.hasOwnProperty.call(prev, 'currentId')) {
        stored = prev.currentId
        hasStored = true
      }
    } catch { /* no previous file → omit the key */ }
  }
  const payload = { list }
  if (hasStored) payload.currentId = stored
  writeFileSync(file, JSON.stringify(payload, null, 2))
}

/**
 * Does this record actually HAVE a password the plugin can use?
 *
 * `passwordSet` used to be `!!m.password`, i.e. "a PLAINTEXT password exists in
 * machines.json". A machine whose password lives in the OS keychain stores
 * `password: ''` (by design — issue #30), so it reported `passwordSet: false`
 * and the settings page showed an empty password box with no indication that a
 * credential was saved. That is the difference between "the plugin forgot my
 * password" and "the plugin has it and will not echo it".
 *
 * `secretStored` is written by the save route from the keychain result, so new
 * records carry the truth. Records saved before that flag existed only carry the
 * backend name, which is the best evidence available for them (a non-plain
 * backend means a secret was meant to live in the OS store).
 *
 * @param {object} m - a registry record.
 * @returns {boolean}
 */
export function hasStoredPassword(m) {
  if (!m) return false
  if (m.password) return true
  if (m.secretStored === true) return true
  if (m.secretStored === undefined && m.credentialBackend && m.credentialBackend !== 'plain') return true
  return false
}

/** Strip secrets before sending a machine to the client.
 *
 *  Secrets never round-trip to the browser: a password is replaced by
 *  `passwordSet`, and the private-key `passphrase` — which IS stored in the
 *  record — is replaced by `passphraseSet`. Both flags exist so the settings form
 *  can say "已保存（••••••••），留空 = 不修改" instead of showing an empty box that
 *  looks like the plugin lost the value. */
export function sanitizeMachine(m) {
  if (!m) return m
  const { password, passphrase, proxy, ...rest } = m
  const out = {
    ...rest,
    passwordSet: hasStoredPassword(m),
    passphraseSet: !!(passphrase && String(passphrase).length),
  }
  if (proxy) {
    out.proxy = {
      ...proxy,
      password: proxy.password ? '' : undefined,
      passwordSet: !!(proxy.password && proxy.password.length),
    }
  }
  return out
}

/**
 * Resolve the credentials a TEST probe must dial with (issue: "编辑已连接机器 → 测试
 * 连接" always failed with `no credentials`).
 *
 * The settings form never receives stored secrets, so an edit-then-test posted an
 * EMPTY password while a real connect (which resolves the keychain/plain secret
 * through the pool's `passwordResolver`) worked fine. The probe therefore has to
 * be a MERGE: the form is an override layer, and anything it leaves blank falls
 * back to what is stored for that machine.
 *
 * Rules, deliberately one-way (a form value never gets discarded):
 *   · a non-empty form string wins;
 *   · an empty/absent form string keeps the stored value;
 *   · booleans (`useAgent`, `keyboardInteractive`) are taken from the form when
 *     the form actually supplied a boolean, otherwise from the record — the
 *     probe must exercise the SAME auth method the machine will use;
 *   · a jump-host (`proxy`) password the form did not re-supply is carried over
 *     from the stored proxy, otherwise a bastion-protected machine "fails to
 *     test" for a reason that has nothing to do with the target.
 *
 * @param {object} body - the probe request body (form values).
 * @param {object|null} rec - the saved machine record, if any.
 * @param {string} [storedPassword] - the record's resolvable password (may come
 *   from the OS keychain, hence the separate argument).
 * @returns {{password:string,passphrase:string,privateKeyPath:string,useAgent:boolean,
 *   keyboardInteractive:boolean,hostKeyMode:string,sshBinary:string,backend:string,
 *   proxy:object|undefined,usedSavedCredential:boolean}}
 */
export function resolveProbeCredentials(body = {}, rec = null, storedPassword = '') {
  const form = body || {}
  const saved = rec || {}
  const str = (v) => (v === undefined || v === null ? '' : String(v))
  const pick = (formVal, storedVal) => {
    const f = str(formVal).trim()
    return f !== '' ? str(formVal) : str(storedVal)
  }
  const pickBool = (formVal, storedVal) => (typeof formVal === 'boolean' ? formVal : !!storedVal)

  const formPassword = str(form.password)
  const password = formPassword !== '' ? formPassword : str(storedPassword)
  const formProxy = form.proxy && form.proxy.host ? form.proxy : null
  const savedProxy = saved.proxy && saved.proxy.host ? saved.proxy : null
  const baseProxy = formProxy || savedProxy
  const proxy = baseProxy
    ? {
        host: String(baseProxy.host),
        port: Number(baseProxy.port) || 22,
        username: str(baseProxy.username),
        password: formProxy && str(formProxy.password) !== ''
          ? str(formProxy.password)
          : str(savedProxy && savedProxy.password),
        privateKeyPath: str(baseProxy.privateKeyPath),
      }
    : undefined

  return {
    password,
    passphrase: pick(form.passphrase, saved.passphrase),
    privateKeyPath: pick(form.privateKeyPath, saved.privateKeyPath),
    useAgent: pickBool(form.useAgent, saved.useAgent),
    keyboardInteractive: pickBool(form.keyboardInteractive, saved.keyboardInteractive),
    hostKeyMode: pick(form.hostKeyMode, saved.hostKeyMode),
    sshBinary: pick(form.sshBinary, saved.sshBinary),
    backend: pick(form.backend, saved.backend) || 'native',
    proxy,
    // True when the form could not supply the credential and the stored one had
    // to be used — the UI says so, because "测试成功" with an empty password box
    // is otherwise indistinguishable from a form-only probe.
    usedSavedCredential: formPassword === '' && password !== '',
  }
}

/** Machine grouping metadata (host organisation).
 *
 *  A flat list does not survive contact with reality: once a user has a dozen
 *  machines (prod/staging/GPU boxes/laptops) "pick the right one" becomes the
 *  dominant failure mode, and picking the WRONG one on a destructive tool is
 *  how accidents happen. These four fields are pure LABELS — they change no
 *  connection behaviour — so they live beside it and can be edited freely.
 *
 *  Normalization is deliberately conservative: a bad value is dropped (not
 *  coerced into something surprising), and every field is optional so existing
 *  registries keep loading byte-for-byte.
 *
 *  @param {object} raw - a (possibly partial) group patch.
 *  @returns {{environment?: string, location?: string, description?: string, tags?: string[]}}
 */
export function normalizeMachineGroup(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  const str = (v, max) => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s ? s.slice(0, max) : ''
  }
  const env = str(raw.environment, 40)
  if (env) out.environment = env
  const loc = str(raw.location, 40)
  if (loc) out.location = loc
  const desc = str(raw.description, 200)
  if (desc) out.description = desc
  // Tags: accept an array or a comma/space separated string (what a UI text box
  // naturally produces), then de-duplicate case-insensitively while KEEPING the
  // first spelling so the display stays stable.
  let tags = raw.tags
  if (typeof tags === 'string') tags = tags.split(/[,\s]+/)
  if (Array.isArray(tags)) {
    const seen = new Set()
    const kept = []
    for (const t of tags) {
      const s = str(t, 32)
      if (!s) continue
      const k = s.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      kept.push(s)
      if (kept.length >= 12) break // a dozen labels is already too many to scan
    }
    if (kept.length) out.tags = kept
  }
  return out
}

/**
 * Select machines by group metadata — the predicate behind "run this on every
 * staging box". All supplied filters must match (AND); tags are OR within
 * themselves (any requested tag qualifies) which is how people read a tag row.
 *
 * @param {Array<object>} machines
 * @param {{environment?: string, location?: string, tags?: string[]|string, query?: string}} filter
 * @returns {Array<object>}
 */
export function filterMachinesByGroup(machines, filter = {}) {
  const list = Array.isArray(machines) ? machines : []
  const env = typeof filter.environment === 'string' ? filter.environment.trim().toLowerCase() : ''
  const loc = typeof filter.location === 'string' ? filter.location.trim().toLowerCase() : ''
  let wantTags = filter.tags
  if (typeof wantTags === 'string') wantTags = wantTags.split(/[,\s]+/)
  wantTags = (Array.isArray(wantTags) ? wantTags : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)
  const query = typeof filter.query === 'string' ? filter.query.trim().toLowerCase() : ''
  return list.filter((m) => {
    if (!m) return false
    if (env && String(m.environment || '').toLowerCase() !== env) return false
    if (loc && String(m.location || '').toLowerCase() !== loc) return false
    if (wantTags.length) {
      const have = (Array.isArray(m.tags) ? m.tags : []).map((t) => String(t).toLowerCase())
      if (!wantTags.some((t) => have.includes(t))) return false
    }
    if (query) {
      const hay = [m.name, m.host, m.username, m.environment, m.location, m.description, ...(Array.isArray(m.tags) ? m.tags : [])]
        .filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(query)) return false
    }
    return true
  })
}

/** Apply a machine's fields onto the live config object (pool + tools read it). */
export function applyMachine(config, m) {
  if (!m) return
  config.host = m.host
  config.port = Number(m.port) || 22
  config.username = m.username || ''
  config.password = m.password || ''
  config.privateKeyPath = m.privateKeyPath || ''
  config.passphrase = m.passphrase || ''
  config.workspace = m.workspace || (config.workspace || '')
  if (m.hostKeyMode) config.hostKeyMode = m.hostKeyMode
  if (typeof m.useAgent === 'boolean') config.useAgent = m.useAgent
  if (typeof m.keyboardInteractive === 'boolean') config.keyboardInteractive = m.keyboardInteractive
  // Issue #51: the transport backend is PER MACHINE. An enterprise box that only
  // accepts Kerberos must go through the system OpenSSH backend while every
  // other machine can stay on the native one, so this cannot be a purely global
  // default.
  if (m.backend) config.backend = m.backend
  if (typeof m.sshBinary === 'string') config.sshBinary = m.sshBinary
  config.proxy = m.proxy && m.proxy.host ? m.proxy : undefined
}

/** Mint a fresh machine id. */
export function machineId() {
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
}
