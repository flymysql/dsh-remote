// dsh-remote — remote-work assistant for DeepSeek Harness.
//
// Host half. Turns "give me a remote host + login" into a usable REMOTE WORKSPACE:
//   • one persistent SSH/SFTP pool per configured remote (password OR private key,
//     SSH agent, keyboard-interactive, proxy jump),
//   • a "current remote workspace" — a remote directory the agent treats as the
//     active project root (user@host:/path) — injected into every system prompt,
//   • model tools `rw_*` (info/connect/workspace/list/read/write/edit/append/mkdir/
//     remove/move/stat/exec/search/download/upload/sync/push/forward/disconnect),
//   • JSON endpoints the client settings page + sidebar use over the harness
//     `webServer` (machines / ls / read / write / fs / forwards / task / audit /
//     ssh-config / local-pick / …),
//   • local mirror of the remote workspace (three-way conflict-aware SFTP sync),
//   • optional OS-keychain password storage, command audit log, TOFU host keys.
//
// The engine (path guard + shell quoting + ssh pool + exec) keeps the proven
// foundation; `ctx.fs` / the local workspace registry stay untouched — this is a
// REMOTE workspace presented as such to the model and UI.
//
// Plugin Config MUST be a schemastery schema (zod rejects the undefined row config).
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, copyFileSync, appendFileSync, watch, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'

import {
  shq, normalizeRemotePath, joinRemotePath, remoteDirname, mkdirRemoteDirs,
  toShellPath, toDisplayPath, remotePathBase, truncate, shortHash,
} from './paths.js'
import { createHostKeyGuard, isHostKeyKnown as _isHostKeyKnown } from './hostkey.js'
import { compileIgnore, DEFAULT_IGNORE, DEFAULT_SEARCH_IGNORE } from './ignore.js'
import { friendlyMessage } from './errors.js'
import { importableEntries, sshConfigPath, readSshConfigText, resolveMachineSshConfig } from './sshconfig.js'
import { createRemoteFileReference, installFileReferenceOverlay, DEFAULT_EXCLUDED_DIRECTORIES } from './file-reference.js'
import { getSecret, deleteSecret, platformBackend, persistPassword } from './credential.js'
import { syncTree, pushTree, loadSyncState, saveSyncState, pushOneFile } from './sync.js'
import { searchRemote } from './search.js'
import { resolveMirror, poolKey, lookupSessionCwd, encodeSegmentSafe, readSessionHeaderCwd, requestSessionHint } from './binding.js'
import { TaskManager } from './tasks.js'
import { DeployTasks } from './deploy-tasks.js'
import { ForwardManager } from './forwards.js'
import { WebAttach } from './web-attach.js'
import {
  buildProbeCommand, parseProbe, judgeProbe, buildInstallPlan,
  resolvePrefix, stepResult, DEFAULT_INSTALL_VERSION,
} from './web-deploy.js'
import { registerDeploySkill, buildInvestigatePrompt, SKILL_NAME } from './web-deploy-skill.js'
import { selfDir, diskVersion, LOADED_VERSION, gtVersion, fetchLatestVersion, applyUpdate, persistUpdateMode, readUpdateMode, reloadSelf, scheduleSelfReload, lastSelfReload, isInstalledCopy } from './update.js'
import { sendHeartbeat, pseudonym, heartbeatUrl, hasPersistedId, installIdPath } from './telemetry.js'
import { loadMachines as _loadMachines, saveMachines as _saveMachines, sanitizeMachine as _sanitizeMachine, applyMachine as _applyMachine, machineId as _machineId } from './registry.js'
import { registerHttpTransports } from './http-transport.js'
import { SshPool } from './pool.js'
import { createFsRoutes } from './routes-fs.js'
import { listDirStructured, removeRemoteTree } from './remote-fs.js'

export const name = 'dsh-remote'

/** Update mode used when neither the persisted `update-mode` file nor the
 *  profile config supplies one.
 *
 *  Kept as one exported constant on purpose: the value appears in the schema
 *  default, in the `/update-check` response and in the auto-update gate, and
 *  three hard-coded copies drift (the first version of this change left two
 *  `|| 'manual'` fallbacks that quietly disagreed with the new schema default).
 *  Changing the default must change exactly one place. */
export const DEFAULT_UPDATE_MODE = 'auto'

// Web and Desktop share the SSH tools; each optional UI transport is attached
// reactively below, so service startup order does not drop the JSON routes.
export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  /** Remote SSH host (empty → the plugin starts disconnected). */
  host: z.string().default(''),
  /** Remote SSH port (22 unless the machine uses a custom port). */
  port: z.number().step(1).min(1).max(65535).default(22),
  /** SSH login user. */
  username: z.string().default(''),
  /** Password login (only when the remote has no key. Override the fallback below). */
  password: z.string().default(''),
  /** Explicit SSH private-key path (optional; only used when supplied). Never auto-reads ~/.ssh. */
  privateKeyPath: z.string().default(''),
  /** Key passphrase when the key is encrypted. */
  passphrase: z.string().default(''),
  /** Initial remote workspace path (absolute dir the agent should treat as root). */
  workspace: z.string().default(''),
  /** Remote command terminal strategy. '' = auto-detect (Windows remotes look
   * for Git Bash and pipe every command through `bash -s`); 'git-bash' = prefer
   * Git Bash on Windows; 'native' = never wrap; any other value = explicit
   * bash.exe path (e.g. 'C:\\Program Files\\Git\\bin\\bash.exe'). Git Bash makes
   * a Windows remote behave like a POSIX host (/c/Users/... paths). */
  shell: z.string().default(''),
  /** Per-command timeout. */
  commandTimeoutMs: z.number().step(1).min(1000).default(20000),
  /** SSH connection establishment timeout. */
  connectTimeoutMs: z.number().step(1).min(1000).default(15000),
  /** Hard ceiling on collected remote output per call. */
  maxOutputChars: z.number().step(1).min(1024).default(200000),
  /** Skip mirroring files larger than this many bytes (0 = no cap). */
  maxFileBytes: z.number().step(1).min(0).default(52428800),
  /** Host-key policy: `accept-new` (default) records a host's key on first
   * connect and verifies it afterwards (mirrors ssh's StrictHostKeyChecking
   * accept-new); `verify` also rejects hosts never seen before; `off` skips
   * verification entirely (MITM-unsafe, not recommended). */
  hostKeyMode: z.string().default('accept-new'),
  /** Use the OpenSSH agent (SSH_AUTH_SOCK) when no password/key is configured. */
  useAgent: z.boolean().default(false),
  /** Allow keyboard-interactive auth (OTP/MFA chains) using the configured password. */
  keyboardInteractive: z.boolean().default(false),
  /** Jump host / bastion: connect through this machine first. All fields have
   * defaults so this works on schemastery versions without `.optional()`; an
   * empty `host` means "no jump host". */
  proxy: z.object({
    host: z.string().default(''),
    port: z.number().step(1).min(1).max(65535).default(22),
    username: z.string().default(''),
    password: z.string().default(''),
    privateKeyPath: z.string().default(''),
  }),
  /** Auto-push edited mirror files back to the remote (watcher, debounced). Default off. */
  autoPush: z.boolean().default(false),
  /** Append executed commands to the audit log under the harness home. */
  auditLog: z.boolean().default(true),
  /** Text encoding for remote file reads/writes (utf-8 default; gbk etc.). */
  encoding: z.string().default('utf-8'),
  /** Remote `@` completion (issue #39). When on, a session whose workspace is a
   * dsh-remote mirror lists the REMOTE tree for `@` (over SFTP, bounded) instead
   * of the local mirror — which `ensureMirror()` leaves empty until a sync, so
   * `@` used to find nothing at all. Sessions on a local workspace are
   * untouched, and a host that cannot be reached falls back to the mirror. */
  fileReference: z.boolean().default(true),
  /** Max `@` candidates rendered for one query (mirrors the local provider). */
  fileReferenceMaxResults: z.number().step(1).min(1).default(20),
  /** Max entries retained in the remote `@` index of one workspace. */
  fileReferenceMaxEntries: z.number().step(1).min(1).default(3000),
  /** Directory basenames the remote `@` traversal skips. */
  fileReferenceExcludedDirectories: z.array(z.string()).default([...DEFAULT_EXCLUDED_DIRECTORIES]),
  /** Wall-clock budget (ms) for one remote `@` index pass; on expiry the
   *  partial index answers rather than making the caret wait. */
  fileReferenceTimeoutMs: z.number().step(1).min(200).default(4000),
  /** Cooperative budget (ms) for `rw_search`; also declared as the tool's
   *  `timeoutMs` so @deepseek-ai/dsh-tool-call-timeout-policy can end a call
   *  that overruns. The search itself stops at this budget and returns partial
   *  results (issue #44: an unbounded walk over a home directory could never be
   *  stopped and left the turn `running` forever). */
  searchTimeoutMs: z.number().step(1).min(1000).default(60000),
  /** Max files `rw_search` will stat/read before returning partial results. */
  searchMaxEntries: z.number().step(1).min(1).default(50000),
  /** Update mode: `auto` (default) checks on load and periodically, applies a
   * newer npm release automatically, then hot-swaps the host half (see
   * `updateAutoReload`); `manual` only checks when the user asks; `off` disables
   * version checks entirely. (schemastery 3.18 has no .enum — keep string and
   * validate in code.)
   *
   * `auto` became the default in 0.8.27. It could not have been a safe default
   * before 0.8.24: an update only replaced files on disk and needed a restart,
   * which left users running a new browser half against an old host half with no
   * visible signal. 0.8.24 added the hot swap (and `pendingReload` when it is
   * turned off), so an unattended update now actually takes effect. */
  updateMode: z.string().default(DEFAULT_UPDATE_MODE),
  /** How often (ms) auto mode checks the npm registry for a newer release. */
  updateCheckIntervalMs: z.number().step(1).min(60000).default(6 * 3600 * 1000),
  /** Whether a landed update also hot-swaps the running host half (default
   *  true). With `false` an update only takes effect on the next process start
   *  and `/dsh-remote/update-check` reports `pendingReload: true` meanwhile. */
  updateAutoReload: z.boolean().default(true),
  /** First local port tried when attaching a remote DSH Web UI (issue #46).
   *  The listener is loopback-only; consecutive ports are tried when this one
   *  is taken. */
  webAttachPortStart: z.number().step(1).min(1).max(65535).default(3088),
  /** Remote command that starts a `dsh web` on the attached machine. Only needs
   *  changing when the remote's `dsh` is not on the SSH login PATH (e.g. a
   *  version installed into a private prefix). */
  webAttachCommand: z.string().default('dsh'),
  /** `DSH_HOME` to export on the remote when attaching. Empty reuses the
   *  remote user's own harness home; point it at a scratch directory to keep an
   *  attached instance out of the user's real sessions and settings. */
  webAttachDshHome: z.string().default(''),
  /** How long (seconds) to wait for a freshly started remote `dsh web` to print
   *  its startup token before giving up. */
  webAttachWaitSeconds: z.number().step(1).min(5).max(300).default(45),
  /** Where an automatic deployment installs dsh on the remote. Empty means
   *  `$HOME/.dsh-remote/dsh` (persistent, needs no write access to any system
   *  prefix, and never replaces a dsh the user already has). */
  webInstallPrefix: z.string().default(''),
  /** Version an automatic deployment installs. The default is the first release
   *  whose node-pty ships Linux prebuilds — older ones cannot boot `dsh web` on
   *  Linux at all. */
  webInstallVersion: z.string().default(DEFAULT_INSTALL_VERSION),
  /** npm registry to install from. Empty uses the remote's own npm config, which
   *  is what an internal mirror needs to stay in effect. */
  webInstallRegistry: z.string().default(''),
})

// ── shell / path helpers (pure implementations in lib/paths.js) ───────────

/** Harness home: respect `DSH_HOME` when set (the desktop app sets it to its
 * own `userData/harness`), otherwise fall back to `~/.dsh`. */
function dshBase() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim()) return path.resolve(String(env).trim())
  return path.join(homedir(), '.dsh')
}

/** Root holding every remote host's mirrors + the machine registry. */
function remoteWorkspacesRoot() {
  return path.join(dshBase(), 'remote-workspaces')
}

/** Local mirrors of one remote host. */
function mirrorRootFor(host, user, port) {
  const tag = [host, user, port].filter(Boolean).join('-').replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(remoteWorkspacesRoot(), tag)
}

/** Local mirror dir for a specific remote path (idempotent → returns same dir). */
function mirrorDirFor(remotePath, host, user, port) {
  const base = remotePathBase(remotePath)
  const root = mirrorRootFor(host, user, port)
  const plain = path.join(root, base)
  const norm = normalizeRemotePath(remotePath)
  // A pre-existing mirror for this exact remote origin → reuse it (idempotent).
  try {
    const meta = JSON.parse(readFileSync(path.join(plain, '.dsh-remote-meta.json'), 'utf8'))
    if (meta.remotePath === norm) return plain
  } catch {
    /* no mirror yet → fall through */
  }
  if (!existsSync(plain)) return plain
  return path.join(root, base + '-' + shortHash(norm))
}

/** Create the local mirror dir + a meta file describing its remote origin.
 *  `extra.alias` records the ~/.ssh/config alias a machine was saved as (issue
 *  #38), so the mirror keeps resolving to its machine even if the alias's
 *  HostName/user/port change in that file afterwards. */
function ensureMirror(remotePath, host, user, port, extra = {}) {
  const dir = mirrorDirFor(remotePath, host, user, port)
  mkdirSync(dir, { recursive: true })
  const meta = { host, port, username: user, remotePath: normalizeRemotePath(remotePath), createdAt: new Date().toISOString() }
  if (extra.alias) meta.alias = String(extra.alias)
  writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify(meta, null, 2))
  return dir
}

/** Recursive directory copy (EXDEV fallback for migrateLegacyData). */
function copyDirSync(from, to) {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name)
    const d = path.join(to, e.name)
    if (e.isDirectory()) copyDirSync(s, d)
    else try { copyFileSync(s, d) } catch { /* skip unreadable */ }
  }
}

/** One-time migration of pre-0.6 data (~/.dsh/remote-workspaces) into DSH_HOME.
 * Only runs when the harness is on its DEFAULT home: an explicitly-set DSH_HOME
 * pointing elsewhere means ~/.dsh belongs to another installation — migrating
 * would RENAME that other installation's live data out from under it. */
function migrateLegacyData() {
  const env = process.env.DSH_HOME
  if (env && String(env).trim() && path.resolve(String(env).trim()) !== path.join(homedir(), '.dsh')) return
  const legacy = path.join(homedir(), '.dsh', 'remote-workspaces')
  const target = remoteWorkspacesRoot()
  if (legacy === target || !existsSync(legacy) || existsSync(target)) return
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    try {
      renameSync(legacy, target)
    } catch (err) {
      if (err.code !== 'EXDEV') throw err
      copyDirSync(legacy, target)
    }
  } catch {
    // Migration is best-effort: a fresh registry is created on next save.
  }
}

// ── persistent multi-machine registry ─────────────────────────────────────
// Pure registry logic lives in lib/registry.js (unit-tested): saved machines
// are STANDBY connections; only an explicit "set current" activates one.
// (issue #13 — Saved Connections != Active Remote Context)
const MACHINES_FILE = 'machines.json'
const machinesFile = () => path.join(remoteWorkspacesRoot(), MACHINES_FILE)
const secretsDir = () => path.join(remoteWorkspacesRoot(), '.secrets')
const forwardsFile = () => path.join(remoteWorkspacesRoot(), 'forwards.json')
const auditFile = () => path.join(remoteWorkspacesRoot(), 'audit.log')
const ignoreFile = () => path.join(remoteWorkspacesRoot(), '.dsh-remote-ignore')

const loadMachines = () => _loadMachines(machinesFile())
const saveMachines = (list, currentId, keepCurrentKey) => _saveMachines(machinesFile(), list, currentId, keepCurrentKey)
const sanitizeMachine = _sanitizeMachine
const applyMachine = _applyMachine
const machineId = _machineId

// ── host-key registry (TOFU) ──────────────────────────────────────────────
const KNOWN_HOSTS_FILE = 'known_hosts.json'
const knownHostsFile = () => path.join(remoteWorkspacesRoot(), KNOWN_HOSTS_FILE)
const isHostKeyKnown = (host, port) => _isHostKeyKnown(knownHostsFile(), host, port)

// ── encoding helpers ───────────────────────────────────────────────────────

function decodeBuf(buf, enc) {
  const e = enc && !/^utf-?8$/i.test(String(enc)) ? String(enc).toLowerCase() : null
  return e ? iconv.decode(buf, e) : buf.toString('utf8')
}
function encodeText(s, enc) {
  const e = enc && !/^utf-?8$/i.test(String(enc)) ? String(enc).toLowerCase() : null
  return e ? iconv.encode(String(s), e) : Buffer.from(String(s), 'utf8')
}

// ── apply ─────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  const pool = new SshPool(config, { knownHostsFile })
  ctx.effect(() => () => pool.close(), 'dsh-remote.close')

  migrateLegacyData()

  // ── 安装心跳（日活统计）─────────────────────────────────────────────────
  // 旁路：不 await、不阻塞加载、失败静默（见 lib/telemetry.js 的隐私与失败策略）。
  // 无配置开关（按作者要求默认开启）；上报的是本插件专属 HMAC 伪名，
  // 原始安装 id 与任何机器信息都不离开本机。
  void sendHeartbeat(dshBase(), LOADED_VERSION)

  // The update marker means "a newer version landed on disk but is not the code
  // running yet". Reaching apply() with a marker naming the version we just
  // loaded means the swap already happened (or this is a plain boot into the
  // updated files) → clear it, so the UI's "restart to finish" hint stays true.
  try {
    const marker = path.join(selfDir(), '.dsh-remote-updated')
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === LOADED_VERSION) rmSync(marker, { force: true })
  } catch {}

  // ── machine registry (multi-host) ─────────────────────────────────────────
  const store = loadMachines()
  const machines = store.list
  const machineIndex = (id) => machines.findIndex((m) => m.id === id)

  // ── ssh-config aliases (issue #38) ────────────────────────────────────────
  //
  // A machine may be saved as an ALIAS (`useSshConfig: true`, `host` = the Host
  // line of ~/.ssh/config). The registry then holds NO HostName/user/port/key —
  // every connect resolves the alias against the config file as it is right now
  // (VSCode Remote-SSH behaviour). The text is memoised for a couple of seconds
  // so one request that resolves several machines reads the file once, while an
  // edit to ~/.ssh/config still lands almost immediately.
  let sshConfigCache = { text: '', at: 0 }
  const sshConfigText = () => {
    const now = Date.now()
    if (now - sshConfigCache.at > 2000) sshConfigCache = { text: readSshConfigText(), at: now }
    return sshConfigCache.text
  }

  /**
   * A machine's CONNECT identity: alias machines are resolved through
   * ~/.ssh/config; every other machine is returned untouched. The returned
   * record keeps the registry fields (id, password, credentialBackend, …) so
   * keychain lookups and the settings UI keep working.
   */
  const loggedSshWarnings = new Map()
  const withSshConfig = (m) => {
    // Short-circuit BEFORE reading ~/.ssh/config: a deployment with no alias
    // machine must never touch that file, and the 2s text memo must not be
    // primed by unrelated machines.
    if (!m || !m.useSshConfig) return m
    const resolved = resolveMachineSshConfig(m, { text: sshConfigText() })
    if (!resolved) return m
    // Warn once per distinct warning set: this runs on every tool call, and an
    // unmatched alias would otherwise fill the log with the same line.
    const signature = resolved.warnings.join(' | ')
    if (signature && loggedSshWarnings.get(resolved.alias) !== signature) {
      loggedSshWarnings.set(resolved.alias, signature)
      try {
        const logger = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`[dsh-remote] ssh-config alias "${resolved.alias}": ${resolved.warnings.join(' ')}`)
        }
      } catch { /* logging is best-effort */ }
    }
    return {
      ...m,
      sshAlias: resolved.alias,
      sshConfigMatched: resolved.matched,
      sshConfigWarnings: resolved.warnings,
      host: resolved.host,
      port: resolved.port,
      username: resolved.username || m.username,
      privateKeyPath: resolved.privateKeyPath || '',
      proxy: resolved.proxy,
    }
  }

  /** The alias a machine was saved as ('' for a machine with literal values). */
  const aliasOf = (m) => (m && m.sshAlias) || (m && m.useSshConfig ? String(m.host || '') : '')

  /** Machines as the settings UI sees them: secrets stripped, plus the
   *  ~/.ssh/config resolution of an alias machine so a row can show where the
   *  alias actually points without duplicating those values in the registry
   *  (issue #38). */
  const machinesForClient = () => machines.map((m) => ({
    ...sanitizeMachine(m),
    // Read ~/.ssh/config only when a machine actually uses an alias.
    sshConfigResolved: m.useSshConfig ? resolveMachineSshConfig(m, { text: sshConfigText() }) : null,
  }))

  /**
   * The `dsh` command to use for a machine's Web UI attach.
   *
   * Resolution order is deliberate: a PER-MACHINE value recorded by a completed
   * deployment wins, then the global config default. Without the per-machine
   * branch, deploying on one host would point every other host at a binary that
   * only exists on that one.
   *
   * @param {object} machine - a registry record (may be undefined).
   * @returns {string} the command to run on that machine.
   */
  const webAttachCommandFor = (machine) => {
    const perMachine = machine && typeof machine.webAttachCommand === 'string' ? machine.webAttachCommand.trim() : ''
    return perMachine || String(config.webAttachCommand || 'dsh')
  }

  /**
   * Record the dsh command a deployment produced, on that machine.
   *
   * Persisted through the same registry helper every other machine edit uses, so
   * the value survives a restart and appears in the settings UI like any other
   * field. `keepCurrentKey: false` preserves whichever machine is current —
   * deploying must never silently switch the user's active machine.
   *
   * @param {object} machine - the registry record to update.
   * @param {string} command - the working dsh command.
   */
  const persistWebAttachCommand = (machine, command) => {
    try {
      const i = machineIndex(machine.id)
      if (i < 0) return
      machines[i] = { ...machines[i], webAttachCommand: String(command || '') }
      saveMachines(machines, store.currentId, false)
    } catch { /* a failed persist only costs a re-deploy next time */ }
  }

  /** The machine the pool is currently bound to: an ephemeral tool connection
   * (rw_connect save:false) wins, then the stored current, then config default. */
  let ephemeral = null
  const activeMachine = () => {
    if (ephemeral) return withSshConfig(ephemeral)
    if (store.currentId) {
      const i = machineIndex(store.currentId)
      if (i >= 0) return withSshConfig(machines[i])
    }
    if (config.host) return withSshConfig({ id: machineId(), name: config.host, host: config.host, port: config.port, username: config.username, password: config.password, privateKeyPath: config.privateKeyPath, passphrase: config.passphrase })
    return null
  }
  const currentMachine = activeMachine

  /** Resolve a machine's effective password (keychain backend support). */
  const machinePassword = async (m) => {
    if (m && m.password) return m.password
    if (m && m.credentialBackend && m.credentialBackend !== 'plain') {
      const p = await getSecret(m.id, secretsDir())
      if (p) return p
    }
    return ''
  }

  // The pool resolves keychain-stored passwords lazily at connect time.
  pool.passwordResolver = async () => {
    const m = activeMachine()
    return machinePassword(m)
  }

  /** The identity fields pool.setTarget diffs. Used to snapshot the diff
   *  baseline BEFORE applyMachine mutates the shared config in place. */
  const targetFields = (c) => ({
    host: c.host, port: c.port, username: c.username,
    password: c.password, privateKeyPath: c.privateKeyPath,
    passphrase: c.passphrase, workspace: c.workspace,
    useAgent: c.useAgent, keyboardInteractive: c.keyboardInteractive,
    proxy: c.proxy, hostKeyMode: c.hostKeyMode,
  })

  /** Fingerprint of the machine record last applied to the shared pool config.
   * Re-applying an identical record is a no-op: the picker posts /current before
   * every /ls and used to rewrite the registry + re-read credentials + re-point
   * the pool on every autocomplete keystroke. A record change (settings edit)
   * changes the fingerprint, so the next /current re-applies it. The value is
   * maintained INSIDE applyActiveMachine / clearActiveMachine (not in
   * setCurrent) so every apply path — boot restore, rw_connect save:true,
   * POST /current — keeps the "fingerprint == applied" invariant without extra
   * bookkeeping. */
  let lastAppliedMachine = ''

  /** Fingerprint of the registry record the shared config is bound to ('' when
   *  the binding is ephemeral or no machine is current). */
  const appliedFingerprint = () => {
    if (ephemeral || !store.currentId) return ''
    const i = machineIndex(store.currentId)
    return i >= 0 ? JSON.stringify(machines[i]) : ''
  }

  const applyActiveMachine = async () => {
    const m = activeMachine()
    if (!m || !m.host) return
    const pw = await machinePassword(m)
    // Snapshot the diff baseline BEFORE applyMachine mutates the shared config
    // IN PLACE: pool.config IS this config object, so setTarget would otherwise
    // compare the new values against themselves, find them equal and keep the
    // OLD connection alive across a machine switch (issue #25 hazard).
    const previous = targetFields(config)
    applyMachine(config, { ...m, password: pw || m.password || '' })
    pool.setTarget(targetFields(config), previous)
    lastAppliedMachine = appliedFingerprint()
  }

  // ── per-machine SSH pools (session-bound) ─────────────────────────────────
  // The `pool` above stays the ACTIVE-machine pool: it backs the settings page,
  // the workspace picker routes, and `rw_connect`, whose semantics are "switch
  // the active machine". Session-bound tool calls must not go through it —
  // `setTarget()` rewrites the shared `config` identity and closes the live
  // connection, so two sessions on different machines would take the pool from
  // each other and commands would land on the wrong host (issue #25).
  //
  // Instead each machine gets its own pool, keyed by its stable identity. A
  // session resolves its machine from its own workspace mirror, so concurrent
  // sessions on different hosts never share a connection. Sessions on the SAME
  // machine still share one, preserving the single-connection + keepalive model.

  /** Deployment-varying tunables shared by every pool, owned by the live plugin
   *  Config so a settings change reaches existing pools. Identity, credential,
   *  and per-machine policy fields (`hostKeyMode`, `shell`, `proxy`) are
   *  deliberately excluded — those are pinned per pool from the machine record,
   *  and re-copying them from the shared config is exactly the bug this
   *  registry fixes. */
  const TUNABLE_KEYS = [
    'connectTimeoutMs', 'commandTimeoutMs', 'maxOutputChars', 'maxFileBytes', 'encoding',
  ]
  const syncTunables = (target) => {
    for (const k of TUNABLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(config, k)) target[k] = config[k]
    }
    return target
  }

  const machinePools = new Map()
  ctx.effect(() => () => {
    for (const p of machinePools.values()) {
      try { p.close() } catch { /* a pool already torn down by its own error path */ }
    }
    machinePools.clear()
  }, 'dsh-remote.machine-pools')

  /** Registry record for a resolved mirror origin, so a session-bound pool gets
   *  the machine's real credentials (key path, passphrase, agent, proxy) rather
   *  than only the host/user/port the mirror meta records.
   *
   *  An EPHEMERAL connection (rw_connect save:false) is not in the registry but
   *  is still a legitimate credential source for a pool the same process later
   *  resolves for that identity: without it a mirror picked on a temporary
   *  connection would resolve to an empty-credential pool and fail to connect.
   *
   *  An ssh-config ALIAS machine (issue #38) is matched through its RESOLVED
   *  identity, and directly by the alias the mirror recorded — so a mirror keeps
   *  resolving to its machine even after a HostName/port change in ~/.ssh/config,
   *  which is the whole point of not copying those values into the registry. */
  const identityOf = (m) => {
    const r = withSshConfig(m)
    return { host: r.host, port: Number(r.port) || 22, username: r.username || '' }
  }
  const identityMatches = (m, { host, port, username }) => {
    if (!m) return false
    const id = identityOf(m)
    return id.host === host && id.port === Number(port) && id.username === (username || '')
  }
  const machineRecordFor = ({ host, port, username, alias }) =>
    (identityMatches(ephemeral, { host, port, username }) ? ephemeral : null)
    || (alias ? machines.find((m) => aliasOf(m) === alias) : null)
    || machines.find((m) => identityMatches(m, { host, port, username }))
    || null

  /**
   * Get (or lazily create) the dedicated pool for one remote identity.
   * @param {{host: string, port: number, username: string}} target - the mirror-recorded origin.
   * @returns {SshPool} the pool pinned to that identity; never the active-machine pool.
   */
  const poolForMachine = (target) => {
    const key = poolKey(target)
    // `rec` is the registry record (raw); `eff` is its CONNECT identity, with an
    // ssh-config alias resolved (issue #38). For an alias whose HostName/USER/port
    // changed since the mirror was created, the RESOLVED identity wins over the
    // mirror-recorded one — that is what makes an edit to ~/.ssh/config take
    // effect for an existing session instead of dialing the stale address.
    const rec = machineRecordFor(target)
    const eff = rec ? withSshConfig(rec) : null
    const host = (eff && eff.host) || target.host
    const port = Number((eff && eff.port) || target.port) || 22
    const username = (eff && eff.username) || target.username || 'root'
    const existing = machinePools.get(key)
    if (existing) {
      syncTunables(existing.config)
      // Re-point a live pool whose resolved identity moved (setTarget closes the
      // connection, so only do it when something actually changed).
      if (existing.config.host !== host || Number(existing.config.port) !== port || (existing.config.username || '') !== username) {
        existing.setTarget({ host, port, username })
      }
      // Re-read credentials and per-machine policy from the registry: editing a
      // machine in the settings page must reach a pool created earlier, and a
      // pool holding a stale password would keep failing to reconnect.
      if (eff) {
        existing.config.password = eff.password || ''
        existing.config.privateKeyPath = eff.privateKeyPath || ''
        existing.config.passphrase = eff.passphrase || ''
        existing.config.useAgent = !!eff.useAgent
        existing.config.keyboardInteractive = !!eff.keyboardInteractive
        existing.config.proxy = eff.proxy || undefined
        existing.config.hostKeyMode = eff.hostKeyMode || config.hostKeyMode
      }
      return existing
    }
    const poolConfig = syncTunables({
      ...config,
      host,
      port,
      username,
      password: (eff && eff.password) || '',
      privateKeyPath: (eff && eff.privateKeyPath) || '',
      passphrase: (eff && eff.passphrase) || '',
      useAgent: eff ? !!eff.useAgent : !!config.useAgent,
      keyboardInteractive: eff ? !!eff.keyboardInteractive : !!config.keyboardInteractive,
      proxy: (eff && eff.proxy) || undefined,
      hostKeyMode: (eff && eff.hostKeyMode) || config.hostKeyMode,
      // Identity-pinned pools never carry the shared active workspace: a
      // session passes its own mirror-resolved remote path explicitly.
      workspace: '',
    })
    const created = new SshPool(poolConfig, { knownHostsFile })
    // Keychain-backed passwords resolve against THIS pool's machine record.
    created.passwordResolver = async () => machinePassword(eff || { id: '', password: poolConfig.password })
    machinePools.set(key, created)
    return created
  }

  /**
   * Re-assert the ACTIVE machine that a machine-scoped request names.
   *
   * The workspace picker (and the settings page's workspace flow) acts on the
   * shared active pool, but it remembers its own `machineId` locally. Nothing
   * on `/mirror` / `/home` / `/fs` used to carry that identity, so a switch
   * performed by ANOTHER actor between the picker's last fetch and its commit —
   * the settings page's "set as current", or an `rw_connect` in another agent
   * session — silently redirected the commit onto that other machine. Before
   * this PR the picker re-posted /current on every keystroke, which masked the
   * window; the per-keystroke reconnect fix removes that accident. Let the
   * request state its intent so the host can honour it atomically instead.
   *
   * An absent / empty `machineId` keeps the old behaviour (the caller is
   * machine-scoped through the active pool by design). An UNKNOWN id is
   * refused rather than ignored: quietly mirroring onto whichever machine
   * happens to be active is exactly the hazard this closes.
   *
   * @returns {Promise<boolean>} false when the request was already answered.
   */
  const applyRequestedMachine = async (body, res) => {
    const id = String((body && body.machineId) || '').trim()
    if (!id) return true
    if (await setCurrent(id)) return true
    sendJson(res, 404, { ok: false, error: `machine not found: ${id}` })
    return false
  }

  const setCurrent = async (id) => {
    if (!id) {
      // Explicit "active remote = none": saved machines stay in the registry
      // (issue #13) but nothing is bound to the pool anymore.
      store.currentId = null
      ephemeral = null
      saveMachines(machines, null)
      await clearActiveMachine()
      return true
    }
    const i = machineIndex(id)
    if (i < 0) return false
    // Idempotent: same machine, no ephemeral override, already applied → keep
    // the registry file, the credentials cache and the live pool untouched.
    // (The fingerprint is maintained by applyActiveMachine itself.)
    const fingerprint = JSON.stringify(machines[i])
    if (store.currentId === id && !ephemeral && config.host && lastAppliedMachine === fingerprint) return true
    store.currentId = id
    ephemeral = null
    saveMachines(machines, id)
    await applyActiveMachine()
    return true
  }

  /** Unbind the pool + live config from any machine: the plugin starts in a
   * pure "no remote context" state (issue #13). The host stays configured for
   * tool fallback, but no machine workspace leaks into this session. */
  const clearActiveMachine = async () => {
    ephemeral = null
    // Nothing is applied anymore — reset the applied-machine fingerprint too.
    lastAppliedMachine = ''
    if (!config.host) return
    // Snapshot the diff baseline BEFORE zeroing: pool.config IS this config
    // object, so setTarget would otherwise see an already-zeroed config and
    // keep the old connection alive ("active remote = none" must disconnect).
    const previous = targetFields(config)
    // Clear host + workspace directly (applyMachine keeps the old workspace
    // when the incoming value is empty — it must not be used for a full reset).
    config.host = ''
    config.port = 22
    config.username = ''
    config.password = ''
    config.workspace = ''
    pool.setTarget({ host: '', port: 22, username: '', workspace: '' }, previous)
    // Also stop any auto-push watcher bound to the old machine workspace.
    // (autoPushWatchers is declared later; read it lazily to avoid TDZ.)
    if (typeof autoPushWatchers !== 'undefined' && autoPushWatchers) {
      for (const [, entry] of autoPushWatchers) {
        if (!entry) continue
        try { entry.watcher && entry.watcher.close() } catch {}
        if (entry.timer) clearTimeout(entry.timer)
      }
      autoPushWatchers.clear()
    }
  }

  // If no stored current, adopt a CLI-provided default as the active machine —
  // UNLESS the user explicitly cleared the current machine (currentId: null in
  // the registry = "active remote = none", issue #13). A registry that exists
  // with currentId null must stay inert; only a fresh/absent registry lets the
  // config host serve as the bootstrap default.
  {
    const cur = currentMachine()
    const registryExplicitNone = store.explicitNone
    if (cur && cur.host && !store.currentId && !registryExplicitNone) applyMachine(config, cur)
  }

  // ── auto-restore the last active machine (best-effort) ───────────────────
  // When the harness (re)starts, bring back the machine that was "current"
  // last time: apply its config to the pool and probe a real SSH connection so
  // the sidebar shows connected instead of a disconnected 500-spamming state.
  // Failures are swallowed — an unreachable host must never break plugin boot
  // (the sidebar will show「未连接」and the user can reconnect or set current).
  if (store.currentId) {
    const i = machineIndex(store.currentId)
    if (i >= 0 && machines[i] && machines[i].host) {
      setImmediate(async () => {
        try {
          await applyActiveMachine()
          await pool.exec('echo dsh-remote-restore', { timeoutMs: Math.min(config.commandTimeoutMs || 20000, 15000) })
        } catch {
          // Offline / bad credentials: leave pool unconnected; UI falls back
          // to the "未连接" state and the user can reconnect manually.
        }
      })
    }
  }

  /** Persist the active workspace on the machine the pool is actually bound to
   * (fixes the old bug where a tool-connected machine saved its workspace onto
   * the registry's current machine instead). */
  const persistWorkspace = (p) => {
    config.workspace = p
    const m = activeMachine()
    if (m) {
      if (store.currentId && m.id === store.currentId && machineIndex(m.id) >= 0) {
        const rec = machines[machineIndex(m.id)]
        rec.workspace = p
        rec.recentWorkspaces = [p, ...(rec.recentWorkspaces || []).filter((x) => x !== p)].slice(0, 8)
        saveMachines(machines, store.currentId)
      } else if (ephemeral) {
        ephemeral.workspace = p
      }
    }
  }

  // ── audit log ─────────────────────────────────────────────────────────────
  /**
   * Append one audit line. `target` names the machine the operation really ran
   * on and must be passed by every session-bound caller: the shared `config`
   * identity belongs to the ACTIVE machine, which can be a different host than
   * the session that issued the command, so defaulting to it would
   * misattribute the operation.
   * @param {string} op - operation name.
   * @param {string} cmd - command text or path detail.
   * @param {number|null} code - exit code, or null when not applicable.
   * @param {{host?: string, username?: string, port?: number}} [target] - machine acted on; defaults to the active machine.
   */
  const audit = (op, cmd, code, target) => {
    if (!config.auditLog) return
    const host = (target && target.host) || config.host
    const user = (target && target.username) || config.username
    const port = (target && target.port) || config.port
    try {
      const line = [new Date().toISOString(), `${user || '?'}@${host || '?'}:${port}`, op, code == null ? '-' : String(code), String(cmd || '').replace(/\s+/g, ' ').slice(0, 400)].join(' | ') + '\n'
      appendFileSync(auditFile(), line, 'utf8')
    } catch {}
  }
  const readAudit = (limit) => {
    try {
      const text = readFileSync(auditFile(), 'utf8')
      const lines = text.split('\n').filter(Boolean)
      return lines.slice(-Math.max(1, Math.min(Number(limit) || 50, 500)))
    } catch {
      return []
    }
  }

  // ── ignore rules (defaults + user file) ───────────────────────────────────
  // NOTE: this matcher is shared by mirror sync (rw_sync/rw_push) and search.
  // Do NOT add search-only cache excludes here: widening it would silently stop
  // syncing directories a user may rely on. Search uses searchIgnoreMatcher().
  const ignoreMatcher = () => {
    try {
      const fromFile = readFileSync(ignoreFile(), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      return compileIgnore(DEFAULT_IGNORE.concat(fromFile))
    } catch {
      return compileIgnore(DEFAULT_IGNORE)
    }
  }
  /** Search-only matcher: same as ignoreMatcher() plus machine-local cache trees
   *  (`~/.npm`, `~/.cache`, …) that are huge, almost never what a human is
   *  looking for, and the main cause of the issue #44 hang. Mirror sync is
   *  deliberately unaffected. An explicit `path` still searches anywhere. */
  const searchIgnoreMatcher = () => {
    try {
      const fromFile = readFileSync(ignoreFile(), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      return compileIgnore(DEFAULT_SEARCH_IGNORE.concat(fromFile))
    } catch {
      return compileIgnore(DEFAULT_SEARCH_IGNORE)
    }
  }

  // ── task + forward managers ───────────────────────────────────────────────
  const tasks = new TaskManager()
  const forwards = new ForwardManager(pool, { file: forwardsFile() })
  pool.onReady = (client) => forwards.attach(client)
  pool.onCloseHook = () => forwards.detach()

  // ── remote DSH Web UI attach sessions (issue #46) ─────────────────────────
  // "Use this DSH as a CLIENT for a DSH on another machine". The remote never
  // opens an inbound port (DSH forbids `--host 0.0.0.0`); we SSH out, start or
  // reuse a loopback-bound `dsh web` there, and carry its socket back over our
  // own SSH connection to a loopback listener here. One session per machine —
  // attaching again to the same machine reuses the live tunnel instead of
  // starting a second remote server. Lifecycle is owned by the plugin fiber, so
  // unloading the plugin tears every tunnel down.
  const webAttaches = new Map() // machineId → WebAttach
  // Deploy tasks run on the HOST, detached from any request: closing the browser
  // window mid-install must not lose the progress, and a re-opened page must be
  // able to re-attach and see the live state (high-availability requirement).
  const deployTasks = new DeployTasks()
  ctx.effect(() => () => {
    for (const attach of webAttaches.values()) { try { attach.close() } catch { /* already gone */ } }
    webAttaches.clear()
  }, 'dsh-remote.web-attach')

  // ── auto-push watcher (config.autoPush, default off) ──────────────────────
  // Watches the local mirror; local edits are pushed back to the remote after a
  // 3s debounce, honoring ignore rules + the three-way conflict guard (a remote
  // change is never clobbered — it is recorded as a conflict in the audit log).
  const autoPushWatchers = new Map() // localDir → { watcher, pending:Set, timer }
  const flushAutoPush = async (localDir) => {
    const entry = autoPushWatchers.get(localDir)
    if (!entry || !entry.pending.size) return
    const rels = [...entry.pending]
    entry.pending.clear()
    // Resolve the destination from the WATCHED MIRROR, not from the active
    // machine: a watcher outlives any one session, so gating on the active
    // machine made it silently stop pushing (and, before per-machine pools,
    // risked pushing one host's mirror through another host's connection).
    const { remotePath: ws, machine } = resolveMirrorForLocal(localDir)
    if (!ws || !machine) return
    const target = poolForMachine(machine)
    let sftp
    try { sftp = await target.sftp() } catch { return }
    const matcher = ignoreMatcher()
    const state = loadSyncState(localDir)
    const next = { ...state }
    if (rels.includes('*')) {
      const r = await pushTree(sftp, localDir, ws, { maxFiles: 2000, maxFileBytes: config.maxFileBytes, isIgnored: matcher, state: next })
      Object.assign(next, r.nextState)
      for (const c of r.stats.conflicts) audit('auto-push-conflict', `push ${c.path}`, 1, machine)
    } else {
      for (const rel of rels) {
        const r = await pushOneFile(sftp, localDir, ws, rel, { maxFileBytes: config.maxFileBytes, isIgnored: matcher, state: next })
        if (r.status === 'pushed' && r.state) Object.assign(next, r.state)
        else if (r.status === 'conflict') audit('auto-push-conflict', `push ${rel}`, 1, machine)
      }
    }
    saveSyncState(localDir, next)
  }
  const startAutoPush = (localDir) => {
    if (!config.autoPush || autoPushWatchers.has(localDir)) return
    const entry = { pending: new Set(), timer: null, watcher: null }
    const schedule = () => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => flushAutoPush(localDir), 3000)
    }
    const onEvent = (eventType, filename) => {
      if (!filename) { entry.pending.add('*'); return schedule() }
      const rel = String(filename).replace(/\\/g, '/')
      if (rel === '.dsh-remote-meta.json' || rel === '.dsh-remote-sync-state.json' || rel.startsWith('.dsh-remote-sync-state.json.tmp')) return
      entry.pending.add(rel)
      schedule()
    }
    try {
      entry.watcher = watch(localDir, { recursive: true }, onEvent)
    } catch {
      try { entry.watcher = watch(localDir, onEvent) } catch { return }
    }
    autoPushWatchers.set(localDir, entry)
  }
  ctx.effect(() => () => {
    for (const e of autoPushWatchers.values()) {
      if (e.timer) clearTimeout(e.timer)
      try { e.watcher && e.watcher.close() } catch {}
    }
    autoPushWatchers.clear()
  }, 'dsh-remote.autopush')

  // Helpers shared by session-bound tools and the machine-scoped web routes take
  // the pool explicitly (`p`), defaulting to the active-machine pool so route
  // callers — which are machine-scoped by design — stay unchanged.
  const run = async (cmd, opts = {}, p = pool) => {
    const res = await p.exec(cmd, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {})
    const parts = []
    if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''))
    if (res.stderr) parts.push('-- stderr --\n' + res.stderr.replace(/\s+$/, ''))
    if (!parts.length) parts.push('(no output)')
    let text = parts.join('\n')
    if (res.signal === 'TIMEOUT') text += `\n[command timed out after ${opts.timeoutMs ?? config.commandTimeoutMs}ms]`
    else if (res.code !== 0) text += `\n[exit code: ${res.code}]`
    return text
  }

  const isRemoteDir = async (p, sshPool = pool) => {
    const target = normalizeRemotePath(p)
    try {
      const sftp = await sshPool.sftp()
      const st = await sftp.stat(target)
      return !!(st && st.isDirectory && st.isDirectory())
    } catch {
      return false
    }
  }

  // ── remote workspace state ────────────────────────────────────────────────
  const wsPath = () => (config.workspace || '').trim()
  /** Map a LOCAL path to the remote path its mirror represents ('' when the
   *  path is not inside any dsh-remote mirror). Shared by the resolve-mirror
   *  route, the session-aware system-prompt injection, and status().
   *
   *  `machine` carries the mirror's recorded origin (`host`/`port`/`username`
   *  from `.dsh-remote-meta.json`), or null when the path is not inside a
   *  mirror. That origin is what makes a session's remote target authoritative
   *  without consulting the mutable active-machine state, so a concurrent
   *  session switching machines cannot redirect this session's commands. */
  const resolveMirrorForLocal = (local) => resolveMirror(local, remoteWorkspacesRoot())

  /**
   * The whole local-mirror registry with each mirror's recorded remote origin
   * (issue #49).
   *
   * The sidebar's Session rows need to know, for EVERY visible row, whether that
   * session is a remote one and which host it is bound to. Asking
   * `/resolve-mirror` per row would issue one HTTP request per row and would
   * also depend on the host still knowing that session id; instead the client
   * already holds each row's cwd (the sessions snapshot) and matches it against
   * this directory list locally, so the whole sidebar costs ONE request.
   *
   * Mirrors whose meta is missing/unparsable (or has no `host`) are SKIPPED
   * rather than guessed at — the same rule `resolveMirror()` applies, and for
   * the same reason: labelling a session with a host it is not bound to is
   * worse than showing no badge at all.
   *
   * @returns {Array<{dir: string, host: string, port: number, username: string,
   *   remotePath: string, alias: string, name: string}>} one entry per mirror.
   */
  const mirrorRegistry = () => {
    const out = []
    const root = remoteWorkspacesRoot()
    if (!existsSync(root)) return out
    let hostDirs = []
    try { hostDirs = readdirSync(root) } catch { return out }
    for (const hostDir of hostDirs) {
      const hostPath = path.join(root, hostDir)
      if (!statSync(hostPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
      let entries = []
      try { entries = readdirSync(hostPath) } catch { continue }
      for (const entry of entries) {
        const dir = path.join(hostPath, entry)
        const metaPath = path.join(dir, '.dsh-remote-meta.json')
        if (!existsSync(metaPath)) continue
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
          if (!meta || !meta.host) continue
          const origin = {
            host: String(meta.host),
            port: Number(meta.port) || 22,
            username: String(meta.username || ''),
            alias: String(meta.alias || ''),
          }
          const rec = machineRecordFor(origin)
          out.push({
            dir: path.resolve(dir),
            host: origin.host,
            port: origin.port,
            username: origin.username,
            remotePath: String(meta.remotePath || ''),
            alias: origin.alias,
            // A saved machine's display name, when this mirror resolves to one:
            // the UI prefers the friendly name over the raw address in its
            // tooltip (the row itself shows the address, which is what the
            // reader asked for).
            name: rec && rec.name ? String(rec.name) : '',
          })
        } catch { /* unparsable meta → not a usable binding */ }
      }
    }
    return out
  }
  if (config.autoPush && wsPath()) {
    startAutoPush(mirrorDirFor(wsPath(), config.host, config.username, config.port))
  }
  /** The remote path one agent session is bound to, or '' when that session is
   *  a plain local one. Walks the mirror registry (host side copy of the
   *  resolve-mirror logic) so status / prompt / sidebar agree.
   *
   *  `sessionId` narrows to one session. WITHOUT it the first live session's cwd
   *  is used, which is only meaningful for the machine-scoped settings view:
   *  with several live sessions the "first" one is arbitrary and may belong to
   *  another machine. Tool calls must never route through this — they resolve
   *  their own session through `bindingFor()`, which is authoritative. */
  const sessionsSvc = () => (ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null)
  const sessionCwd = (sessionId) => {
    const sessions = sessionsSvc()
    if (sessionId) return lookupSessionCwd(sessionId, { sessions, dshHome: dshBase() })
    try {
      if (sessions && typeof sessions.list === 'function') {
        const s = sessions.list()[0]
        if (s && s.header && s.header.cwd) return String(s.header.cwd)
      }
    } catch { /* sessions service unavailable */ }
    return ''
  }
  const sessionRemotePath = (sessionId) => {
    const cwd = sessionCwd(sessionId)
    if (!cwd) return ''
    return resolveMirrorForLocal(cwd).remotePath
  }

  /**
   * HTTP binding for sidebar file routes. A sessionId/local hint is authoritative:
   * a local (non-mirror) session is refused rather than falling back to the
   * active machine. Requests with no hint keep the picker/settings active pool.
   */
  const resolveRequestBinding = async (req, body = {}) => {
    const hint = requestSessionHint(req, body)
    let cwd = hint.local
    if (!cwd && hint.sessionId) cwd = lookupSessionCwd(hint.sessionId, { sessions: sessionsSvc(), dshHome: dshBase() })
    if (cwd) {
      const { remotePath, machine, mirrorDir } = resolveMirrorForLocal(cwd)
      if (remotePath && machine) {
        return {
          pool: poolForMachine(machine),
          ws: remotePath,
          host: machine.host,
          username: machine.username,
          port: machine.port,
          alias: machine.alias || '',
          mirrorDir,
          bound: true,
          local: false,
        }
      }
      const err = new Error(
        'this session is LOCAL — its workspace is not a remote mirror, so there is no remote host to act on. '
        + 'Refusing rather than falling back to the active machine.',
      )
      err.httpStatus = 403
      throw err
    }
    return {
      pool,
      ws: wsPath(),
      host: config.host,
      username: config.username,
      port: config.port,
      mirrorDir: wsPath() ? mirrorDirFor(wsPath(), config.host, config.username, config.port) : null,
      bound: false,
      local: false,
    }
  }

  // ── session-bound remote binding (the authoritative tool path) ─────────────

  /**
   * Resolve the remote binding a tool call must act on, from the calling
   * session's own workspace cwd.
   *
   * This is what keeps concurrent sessions independent: the machine and the
   * workspace root both come from the session's mirror `.dsh-remote-meta.json`,
   * never from the mutable active-machine state, so another session switching
   * machines cannot redirect this call. Sessions on the same machine resolve to
   * the same key and share one pool.
   *
   * @param {object} [exec] - the tool's `ToolRunContext`; `exec.agent.session.header.cwd` identifies the caller.
   * @returns {{pool: SshPool, ws: string, host: string, username: string, port: number, mirrorDir: string|null, bound: boolean, local: boolean}}
   *   `bound` is true only for a session whose cwd resolves to a mirror. A
   *   caller with a cwd that is NOT a mirror is a local session: `local` is
   *   true and the active-machine values are returned for machine-scoped
   *   reporting (`rw_info`) — session-scoped tools must refuse it instead,
   *   which is what {@link requireBinding} enforces.
   */
  const bindingFor = (exec) => {
    const cwd = exec?.agent?.session?.header?.cwd
    if (cwd) {
      const { remotePath, machine, mirrorDir } = resolveMirrorForLocal(String(cwd))
      if (remotePath && machine) {
        return {
          pool: poolForMachine(machine),
          ws: remotePath,
          host: machine.host,
          username: machine.username,
          port: machine.port,
          alias: machine.alias || '',
          mirrorDir,
          bound: true,
          local: false,
        }
      }
    }
    return {
      pool,
      ws: wsPath(),
      host: config.host,
      username: config.username,
      port: config.port,
      mirrorDir: wsPath() ? mirrorDirFor(wsPath(), config.host, config.username, config.port) : null,
      bound: false,
      // A caller that identified itself with a cwd, yet resolved to no mirror,
      // is definitively a LOCAL session. Distinguish it from "no caller
      // context at all", where the active machine is still the right answer.
      local: !!cwd,
    }
  }

  /**
   * Binding for a tool that requires a remote workspace, with a diagnostic
   * refusal when none is resolvable. Failing loud here is the point: silently
   * falling back to the active machine is how a command reached the wrong host.
   * @param {object} exec - the tool's `ToolRunContext`.
   * @param {string} tool - tool name, used in the error message.
   * @returns {ReturnType<typeof bindingFor>} a binding with `bound: true`.
   */
  const requireBinding = (exec, tool) => {
    const b = bindingFor(exec)
    // A LOCAL session must be refused even when an active machine happens to
    // have a workspace: inheriting it is precisely how a command reaches a host
    // the caller never asked for. Checking only `!b.ws` missed this, because
    // the active machine's workspace is usually non-empty.
    if (b.local) {
      throw new Error(
        `${tool}: this session is LOCAL — its workspace is not a remote mirror, `
        + 'so there is no remote host to act on. Refusing rather than falling back to the active machine '
        + `(${config.username || '?'}@${config.host || '?'}), which belongs to a different session. `
        + 'Use rw_connect + rw_pick_workspace to bind a remote workspace, then open a session in its local mirror.',
      )
    }
    if (!b.ws) {
      throw new Error(
        `${tool}: no remote workspace set — call rw_connect then rw_pick_workspace first.`,
      )
    }
    if (!b.host) throw new Error(`${tool}: no remote host resolved for this session — run rw_connect first.`)
    return b
  }

  /**
   * Binding for a tool that takes an explicit absolute remote path: it needs a
   * resolvable MACHINE but not a workspace root. A local session is refused for
   * the same reason as {@link requireBinding} — the active machine belongs to
   * whoever set it, not to this caller.
   * @param {object} exec - the tool's `ToolRunContext`.
   * @param {string} tool - tool name, used in the error message.
   * @returns {ReturnType<typeof bindingFor>} a binding whose `host` is non-empty.
   */
  const requireMachine = (exec, tool) => {
    const b = bindingFor(exec)
    if (b.local) {
      throw new Error(
        `${tool}: this session is LOCAL — its workspace is not a remote mirror, `
        + 'so there is no remote host to act on. Refusing rather than falling back to the active machine '
        + `(${config.username || '?'}@${config.host || '?'}), which belongs to a different session.`,
      )
    }
    if (!b.host) throw new Error(`${tool}: no remote host for this session — run rw_connect first`)
    return b
  }
  const status = () => ({
    host: config.host,
    port: config.port,
    username: config.username,
    connected: !!pool.client,
    workspace: toDisplayPath(wsPath(), pool.platform),
    localMirror: wsPath() ? mirrorDirFor(wsPath(), config.host, config.username, config.port) : '',
    currentId: store.currentId || null,
    activeSource: ephemeral ? 'ephemeral' : (store.currentId ? 'machine' : (config.host ? 'config' : 'none')),
    // Issue #13: whether THIS session is in remote mode (cwd inside a mirror).
    // `none`/`local` means the plugin is present but no remote context is
    // active — saved machines stay standby-only.
    sessionMode: sessionRemotePath() ? 'remote' : (store.currentId ? 'standby' : 'local'),
    sessionRemotePath: sessionRemotePath(),
    machines: machinesForClient(),
    hostKeyMode: config.hostKeyMode === 'verify' || config.hostKeyMode === 'off' ? config.hostKeyMode : 'accept-new',
    hostKeyKnown: config.host ? isHostKeyKnown(config.host, config.port) : false,
    forwards: forwards.list(),
    auditEnabled: !!config.auditLog,
    backend: platformBackend(),
    platform: pool.platform,
    shell: pool.shellMode,
    gitBash: pool.gitBashPath || '',
  })

  // ── remote `@` completion (issue #39) ─────────────────────────────────────
  //
  // `@` candidates come from `ctx.fileReferences`, whose only shipped provider
  // indexes the agent session's LOCAL cwd. A remote session's cwd is the (empty
  // until synced) mirror, so `@` listed nothing. The seam is a single-owner
  // service, so lib/file-reference.js WRAPS `fileReferences.list` and answers
  // remote-bound sessions from the remote host over SFTP.
  //
  // Everything below is glue: which remote root an agent is bound to, and how a
  // workspace-relative directory is listed over the machine's own pool.

  /** Join a workspace-relative directory onto a remote root, segment by
   *  segment, so the root's separator style is preserved on Windows hosts. */
  const joinRemoteRel = (base, rel) => {
    let out = base
    for (const segment of String(rel || '').split('/')) {
      if (!segment || segment === '.') continue
      out = joinRemotePath(out, segment)
    }
    return out
  }

  const fileReferenceLog = (msg) => {
    try {
      const logger = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
      if (logger && typeof logger.warn === 'function') logger.warn('[dsh-remote] ' + msg)
    } catch { /* logging is best-effort */ }
  }

  /** Providers, one per (machine, remote root): the index cache is expensive to
   *  rebuild, so typing in the SAME workspace keeps reusing it. */
  const fileReferenceProviders = new Map()
  const FILE_REFERENCE_PROVIDER_CAP = 32

  /**
   * The remote discovery provider for one agent, or null when that agent is not
   * a remote session (or the feature is off) — in which case the original local
   * provider answers, unchanged.
   */
  const remoteFileReferenceFor = (agent) => {
    // `=== false` rather than falsy: a partially-specified config (a scripted
    // apply(), an older profile) must still get the remote listing, which is
    // what the schema default promises.
    if (config.fileReference === false) return null
    const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : ''
    if (!cwd) return null
    const { remotePath, machine } = resolveMirrorForLocal(String(cwd))
    if (!remotePath || !machine) return null
    const root = normalizeRemotePath(remotePath)
    const key = poolKey(machine) + '\u0000' + root
    const cached = fileReferenceProviders.get(key)
    if (cached) return cached
    const provider = createRemoteFileReference({
      root,
      // '' = the workspace root; every other value is a workspace-relative dir.
      listDir: async (rel) => {
        const p = poolForMachine(machine)
        const sftp = await p.sftp()
        const out = await listDirStructured(sftp, rel ? joinRemoteRel(root, rel) : root)
        return out.items.map((item) => ({
          name: item.name,
          kind: item.type === 'dir' ? 'directory' : 'file',
        }))
      },
      config: {
        root,
        maxResults: config.fileReferenceMaxResults,
        maxEntries: config.fileReferenceMaxEntries,
        excludedDirectories: config.fileReferenceExcludedDirectories,
        timeoutMs: config.fileReferenceTimeoutMs,
      },
      onError: (err) => fileReferenceLog(`@ listing failed for ${machine.host}:${root}: ${(err && err.message) || err}`),
    })
    if (fileReferenceProviders.size >= FILE_REFERENCE_PROVIDER_CAP) {
      const oldest = fileReferenceProviders.keys().next().value
      try { fileReferenceProviders.get(oldest)?.dispose() } catch { /* already disposed */ }
      fileReferenceProviders.delete(oldest)
    }
    fileReferenceProviders.set(key, provider)
    return provider
  }

  const fileReferenceOverlay = installFileReferenceOverlay(ctx, {
    resolve: remoteFileReferenceFor,
    onError: (err) => fileReferenceLog(`@ completion overlay: ${(err && err.message) || err}`),
  })
  ctx.effect(() => () => {
    try { fileReferenceOverlay?.dispose?.() } catch { /* already disposed */ }
    for (const provider of fileReferenceProviders.values()) {
      try { provider.dispose() } catch { /* already disposed */ }
    }
    fileReferenceProviders.clear()
  }, 'dsh-remote.file-reference')

  /**
   * Resolve a PATH ARGUMENT a tool received against the session's remote
   * workspace root when it is not already absolute (issue #39).
   *
   * An `@path` mention in a remote session is workspace-relative — the same
   * shape the local provider produces — so `rw_read_file("src/main.c")` must
   * mean `<remote workspace>/src/main.c`, not the filesystem root's `/src`.
   * Absolute POSIX (`/a/b`), Windows (`D:\a`, `/D:/a`) and UNC (`\\host\share`)
   * forms pass through normalizeRemotePath() unchanged, so behaviour for every
   * existing caller is preserved. `..` segments collapse inside the joined path
   * exactly as normalizeRemotePath() already did.
   *
   * @param {{ws: string}} b - the binding resolved for this call.
   * @param {unknown} raw - the raw argument value.
   * @returns {string} a normalized remote path.
   */
  const resolveRemoteArg = (b, raw) => {
    const s = String(raw ?? '').trim()
    const absolute = s.startsWith('/') || s.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(s)
    if (absolute) return normalizeRemotePath(s)
    const rel = s.replace(/^\.\//, '').replace(/^[\\/]+/, '')
    if (!rel) return normalizeRemotePath(b.ws || '')
    return normalizeRemotePath(b.ws ? joinRemoteRel(b.ws, rel.replace(/\\/g, '/')) : rel)
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  const textOut = {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_a, v) => [{ type: 'text', text: v.text }],
  }
  const okOut = {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, bytes: { type: 'integer' }, text: { type: 'string' } } },
    render: (_a, a) => [{ type: 'text', text: a.text || (a.ok ? 'ok' : 'failed') }],
  }

  const tools = [
    defineTool({
      name: 'rw_info',
      description:
        'Show the remote environment: host/user/port, connection health, current remote workspace path, active port forwards. Call this first to orient, or when an rw_* call fails to check connectivity. Note: remote context is session-scoped — a saved machine only becomes active when you explicitly rw_connect to it (issue #13).',
      parameters: {},
      output: textOut,
      async execute(_args, exec) {
        // Report THIS session's binding, not the globally active machine: the
        // two differ whenever another session is working on another host, and
        // reporting the active machine is what made this tool contradict itself.
        const b = bindingFor(exec)
        // rw_info is the orientation tool, so resolve the real platform rather
        // than reporting "detecting…" for a pool this session has not used yet.
        if (b.host) {
          try { await b.pool.detect() } catch { /* unreachable host → the ping below reports it */ }
        }
        const s = status()
        const lines = b.bound
          ? [
              `Remote host: ${b.username || '<user>'}@${b.host}:${b.port} (bound to this session's workspace)`,
              `Current remote workspace: ${toDisplayPath(b.ws, b.pool.platform)}`,
              `Local mirror: ${b.mirrorDir || '(none)'}`,
              `Connected: ${b.pool.client ? 'yes' : 'no'}`,
              `Remote shell: ${b.pool.platform === 'windows' ? (b.pool.gitBashPath ? 'Git Bash (' + b.pool.gitBashPath + ')' : 'Windows (Git Bash not found — set config.shell to a bash.exe path)') : (b.pool.platform === 'posix' ? 'native POSIX' : 'detecting…')}`,
              `Active forwards: ${s.forwards.filter((f) => f.active).length} / ${s.forwards.length} (forwards are machine-scoped)`,
              `Host key: ${isHostKeyKnown(b.host, b.port) ? 'trusted' : 'not yet trusted'} (mode=${s.hostKeyMode})`,
              '',
            ]
          : [
              `Remote host: ${s.username || '<user>'}@${s.host || '<host>'}:${s.port}${s.activeSource !== 'machine' ? ` (source: ${s.activeSource})` : ''}`,
              'Session remote context: (this session is LOCAL — no remote workspace bound)',
              `Active machine workspace: ${s.workspace || '(none — call rw_connect then rw_pick_workspace to set one)'}`,
              `Connected: ${s.connected ? 'yes' : 'no'}`,
              `Host key: ${s.hostKeyKnown ? 'trusted' : 'not yet trusted'} (mode=${s.hostKeyMode})`,
              '',
            ]
        if (b.host && b.ws) {
          try {
            const res = await b.pool.exec('echo ok', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
            if (res.signal === 'TIMEOUT') lines.push('Ping: timeout')
            else if (res.code === 0) lines.push('Ping: OK — ' + res.stdout.replace(/\s+/g, ' ').trim())
            else lines.push('Ping: FAILED — ' + (res.stderr || res.stdout || `exit ${res.code}`).trim())
          } catch (err) {
            lines.push('Ping: FAILED — ' + friendlyMessage(err, { host: b.host, port: b.port }))
          }
        } else {
          lines.push('No host + workspace configured — call rw_connect with a host to get started.')
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'rw_connect',
      description:
        'Connect SSH to a remote host for remote workspace work. Two ways (issue #48): (1) pass machineId to connect with a machine ALREADY SAVED in the registry (list them with rw_machines) — every stored setting applies: password/keychain password, privateKeyPath + passphrase, useAgent, keyboardInteractive, proxy, hostKeyMode, and ~/.ssh/config aliases; or (2) pass host plus any of username/port/password/privateKeyPath/passphrase/useAgent/keyboardInteractive/hostKeyMode/name. Defaults to saving the machine to the registry (save=false keeps it as a temporary connection). Once connected, call rw_pick_workspace to pick the workspace directory this session should work in. With useSshConfig=true, `host` is an ALIAS from ~/.ssh/config and every value (HostName/user/port/IdentityFile/ProxyJump) is read from that file at connect time. A failed connection is reported as an error message — it never takes the plugin down.',
      parameters: {
        host: { type: 'string', description: 'Remote host IP or hostname (or a ~/.ssh/config alias with useSshConfig=true). Required unless machineId is given.' },
        machineId: { type: 'string', description: 'Connect with a saved machine from the registry (see rw_machines): all its stored settings apply and it becomes the current machine. host/other fields are not needed.' },
        username: { type: 'string', description: 'SSH user (default from config or root)' },
        port: { type: 'integer', description: 'SSH port (default 22)' },
        password: { type: 'string', description: 'SSH password (prefer SSH key when possible)' },
        privateKeyPath: { type: 'string', description: 'Absolute private-key path' },
        passphrase: { type: 'string', description: 'Passphrase for an ENCRYPTED private key — required when the key is passphrase-protected, otherwise ssh2 cannot parse it (issue #48)' },
        useAgent: { type: 'boolean', description: 'Authenticate via the local SSH agent (SSH_AUTH_SOCK) instead of password/key' },
        keyboardInteractive: { type: 'boolean', description: 'Enable keyboard-interactive auth (OTP/动态码 prompts answered with the configured password)' },
        hostKeyMode: { type: 'string', description: 'Host-key policy for this machine: ask | strict | off (default from config)' },
        name: { type: 'string', description: 'Display name for a newly saved machine (default: the host)' },
        useSshConfig: { type: 'boolean', description: 'Treat `host` as a ~/.ssh/config Host alias; resolve host/user/port/key/proxy from that file (issue #38)' },
        save: { type: 'boolean', description: 'Save this machine to the registry and make it current (default true)' },
      },
      output: textOut,
      async execute(args) {
        const mid = String(args.machineId || '').trim()
        if (mid) {
          // Connect with an ALREADY SAVED machine (issue #48): the registry
          // record carries everything the tool schema could not re-supply —
          // keychain-backed passwords, stored passphrases, proxies, aliases.
          const i = machineIndex(mid)
          if (i < 0) throw new Error(`rw_connect: no saved machine "${mid}" — list saved machines with rw_machines`)
          store.currentId = machines[i].id
          ephemeral = null
          saveMachines(machines, store.currentId)
          // rw_connect means "connect now": force a fresh dial even for an
          // identical target (same reconnect-probe reasoning as below).
          pool.invalidate()
          await applyActiveMachine()
        } else {
          const host = String(args.host || '').trim()
          if (!host) throw new Error('rw_connect: host is required — or pass machineId to connect with a saved machine (list them with rw_machines)')
          const useSshConfig = !!args.useSshConfig
          const user = args.username || config.username || 'root'
          const port = Number(args.port) || undefined
          const rec = {
            host,
            port: port || 22,
            username: user,
            password: args.password !== undefined ? String(args.password) : '',
            privateKeyPath: args.privateKeyPath || '',
          }
          // Carry ONLY the fields the caller actually passed: the upsert below
          // merges rec over the stored record, and an always-present default
          // would clobber stored values (e.g. wiping a saved passphrase).
          if (args.passphrase !== undefined) rec.passphrase = String(args.passphrase)
          if (args.useAgent !== undefined) rec.useAgent = !!args.useAgent
          if (args.keyboardInteractive !== undefined) rec.keyboardInteractive = !!args.keyboardInteractive
          if (args.hostKeyMode) rec.hostKeyMode = String(args.hostKeyMode)
          if (args.name) rec.name = String(args.name)
          if (useSshConfig) rec.useSshConfig = true
          // An alias connection must dial the RESOLVED identity (~/.ssh/config),
          // while the registry keeps the alias itself.
          const eff = useSshConfig ? withSshConfig(rec) : rec
          if (args.save !== false) {
            // Upsert into the registry and make it the current machine so the
            // settings UI and the tools always agree on who is active.
            const i = machines.findIndex((m) => m.host === rec.host && m.username === rec.username && Number(m.port) === rec.port)
            if (i >= 0) {
              machines[i] = {
                ...machines[i], ...rec, useSshConfig, id: machines[i].id,
                // Secrets not re-supplied keep their stored values.
                password: rec.password || machines[i].password || '',
                passphrase: rec.passphrase !== undefined ? rec.passphrase : (machines[i].passphrase || ''),
              }
              store.currentId = machines[i].id
              saveMachines(machines, store.currentId)
            } else {
              const id = machineId()
              machines.push({ id, name: rec.name || host, ...rec })
              store.currentId = id
              saveMachines(machines, store.currentId)
            }
            ephemeral = null
            // rw_connect means "connect now": force a fresh dial even for an
            // identical target (setTarget alone would reuse a possibly half-open
            // cached client — same reconnect-probe reasoning as /connect).
            pool.invalidate()
            await applyActiveMachine()
          } else {
            ephemeral = { id: machineId(), name: rec.name || host, ...rec }
            // rw_connect means "connect now": force a fresh dial even for an
            // identical target (setTarget alone would reuse a possibly half-open
            // cached client — same reconnect-probe reasoning as /connect).
            pool.invalidate()
            pool.setTarget({
              host: eff.host, port: Number(eff.port) || port || 22, username: eff.username || user,
              password: rec.password, privateKeyPath: eff.privateKeyPath || '',
              // Explicit (non-undefined) values so a stale passphrase/agent flag
              // from a previous target cannot leak into this connection.
              passphrase: eff.passphrase || '',
              useAgent: !!rec.useAgent,
              keyboardInteractive: !!rec.keyboardInteractive,
              hostKeyMode: rec.hostKeyMode || config.hostKeyMode,
              proxy: eff.proxy,
              workspace: config.workspace,
            })
          }
        }
        // Shared probe tail: after either path the shared config holds the
        // effective dial identity (applyActiveMachine / setTarget wrote it).
        const effHost = config.host
        const effUser = config.username
        const effPort = Number(config.port) || 22
        try {
          const res = await pool.exec('echo ok', { timeoutMs: 8000 })
          if (res.code !== 0 && !res.stdout) {
            audit('connect', `connect ${effUser}@${effHost}:${effPort}`, res.code)
            return { text: 'connect failed: ' + (res.stderr || 'exit ' + res.code) }
          }
          audit('connect', `connect ${effUser}@${effHost}:${effPort}`, 0)
          const active = activeMachine()
          const via = active && active.sshAlias
            ? `\n(ssh-config alias "${active.sshAlias}" → ${effUser}@${effHost}:${effPort}` + (active.sshConfigWarnings && active.sshConfigWarnings.length ? `; ${active.sshConfigWarnings.join(' ')}` : '') + ')'
            : ''
          return { text: `Connected to ${effHost} as ${effUser}.${via}\n\npick a workspace with rw_pick_workspace (path=<abs>).` }
        } catch (err) {
          throw new Error(friendlyMessage(err, { host: effHost, port: effPort }))
        }
      },
    }),

    defineTool({
      name: 'rw_machines',
      description:
        'List the machines saved in the registry, secrets stripped: id, name, host/port/username, auth method flags (password / key + whether a passphrase is set / agent / keyboard-interactive), ssh-config alias resolution, workspace, and which one is current. Then pass rw_connect(machineId=<id>) to connect with a machine\'s full stored settings — the fix for "the agent cannot retype the whole config" (issue #48).',
      parameters: {},
      output: textOut,
      async execute() {
        if (!machines.length) {
          return { text: 'No saved machines yet — add one in Settings → 远程工作区, or connect with rw_connect(host=..., save defaults to true).' }
        }
        const lines = machines.map((m) => {
          const cur = store.currentId === m.id ? '  [CURRENT]' : ''
          const auth = []
          if (m.password || (m.credentialBackend && m.credentialBackend !== 'plain')) auth.push('password')
          if (m.privateKeyPath) auth.push(`key:${m.privateKeyPath}${m.passphrase ? ' (passphrase set)' : ''}`)
          if (m.useAgent) auth.push('agent')
          if (m.keyboardInteractive) auth.push('keyboard-interactive')
          let via = ''
          if (m.useSshConfig) {
            const eff = withSshConfig(m)
            via = `  alias→${eff.username || ''}@${eff.host}:${Number(eff.port) || 22}`
          }
          const ws = m.workspace ? `  workspace=${m.workspace}` : ''
          return `- ${m.id}  "${m.name || m.host}"  ${m.username || ''}@${m.host}:${Number(m.port) || 22}${via}${cur}\n    auth: ${auth.join(' + ') || 'NONE (connect will fail — add credentials)'}${ws}`
        })
        return { text: lines.join('\n') + '\n\nconnect with rw_connect(machineId=<id>) to reuse a machine\'s full stored settings.' }
      },
    }),

    defineTool({
      name: 'rw_pick_workspace',
      description:
        'Set the remote workspace directory this session should treat as its working root on the connected remote. Verifies it exists (a directory). Use rw_list_dir to browse first if unsure. Accepts POSIX (/home/dev/project) or Windows (C:\\Users\\dev\\project) paths.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote directory path, e.g. /home/dev/code/project or C:\\Users\\dev\\project' },
      },
      output: textOut,
      async execute(args, exec) {
        const p = normalizeRemotePath(String(args.path || ''))
        if (!p || p === '/') throw new Error('rw_pick_workspace: path must be an absolute directory')
        // Picking a workspace targets the machine this session is already bound
        // to when it has one. A LOCAL session deliberately falls back to the
        // active machine here: this is the setup flow that runs right after
        // rw_connect, before any mirror exists to bind to. It creates a mirror
        // rather than reading or writing remote data, so the refusal that
        // guards the other tools would make binding a first workspace
        // impossible.
        const b = bindingFor(exec)
        if (!b.host) throw new Error('rw_pick_workspace: no remote host — call rw_connect first')
        const ok = await isRemoteDir(p, b.pool)
        const shown = toDisplayPath(p, b.pool.platform)
        if (!ok) return { text: `not a directory (or missing) on ${shown}` }
        // A bound session's workspace lives in its own mirror meta, so the
        // shared active-machine workspace is only updated for the unbound flow.
        if (!b.bound) persistWorkspace(p)
        const local = ensureMirror(p, b.host, b.username, b.port, { alias: b.alias || "" })
        startAutoPush(local)
        return {
          text: `Remote workspace set to ${shown} on ${b.username}@${b.host}.\nLocal mirror (native workspace path): ${local}\n\nRun rw_sync to download its files into the local mirror.`,
        }
      },
    }),

    defineTool({
      name: 'rw_sync',
      description:
        'Download the current remote workspace into its local mirror directory over SFTP (bounded, three-way conflict-aware). Makes the remote files visible/editable locally so the DSH native workspace / fs tools can operate on them. Conflicts (both sides modified) are reported and never overwritten; use force=true to override.',
      parameters: {
        depth: { type: 'integer', description: 'Max directory depth to mirror (default 8)' },
        maxFiles: { type: 'integer', description: 'Max files to download (default 2000)' },
        dryRun: { type: 'boolean', description: 'Compute the plan without downloading (default false)' },
        force: { type: 'boolean', description: 'Overwrite conflicting files (default false)' },
        async: { type: 'boolean', description: 'Run in the background and return a task id (default false)' },
      },
      output: textOut,
      async execute(args, exec) {
        const b = requireBinding(exec, 'rw_sync')
        const p = b.ws
        const local = b.mirrorDir || mirrorDirFor(p, b.host, b.username, b.port)
        mkdirSync(local, { recursive: true })
        const depth = Math.min(Math.max(Number(args.depth) || 8, 1), 16)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 2000, 1), 20000)
        const isIgnored = ignoreMatcher()
        const body = { depth, maxFiles, dryRun: !!args.dryRun, force: !!args.force, isIgnored }
        const runSync = async () => {
          let sftp
          try {
            sftp = await b.pool.sftp()
          } catch (err) {
            throw new Error('sftp unavailable: ' + ((err && err.message) || err))
          }
          const state = loadSyncState(local)
          const { stats, nextState } = await syncTree(sftp, p, local, { ...body, state, maxFileBytes: config.maxFileBytes })
          if (!args.dryRun) saveSyncState(local, nextState)
          let text = `${args.dryRun ? 'WOULD download' : 'Downloaded'} ${stats.files} file(s) from ${p} → ${local}.`
          if (stats.truncated || stats.files >= maxFiles) text += ` TRUNCATED (hit depth=${depth} or maxFiles=${maxFiles} cap; raise maxFiles/depth and re-run).`
          if (stats.skippedUnchanged) text += ` ${stats.skippedUnchanged} unchanged.`
          if (stats.skippedLarge) text += ` ${stats.skippedLarge} too large (over ${config.maxFileBytes} bytes).`
          if (stats.staleRemote) text += ` ${stats.staleRemote} remote entries gone (kept locally; use rw_push to mirror deletions).`
          if (stats.conflicts.length) {
            text += `\n⚠ ${stats.conflicts.length} conflict(s), NOT overwritten:`
            for (const c of stats.conflicts.slice(0, 10)) text += `\n  ${c.path} — ${c.reason}`
            if (stats.conflicts.length > 10) text += `\n  … and ${stats.conflicts.length - 10} more`
            text += '\n(use force=true to override)'
          }
          return { text }
        }
        if (args.async) {
          const t = tasks.start('sync', `sync ${p}`, runSync)
          return { text: `sync started in background: taskId=${t.id} (GET /dsh-remote/task?id=${t.id} for progress)` }
        }
        return runSync()
      },
    }),

    defineTool({
      name: 'rw_push',
      description:
        'Upload the local mirror of the current remote workspace back to the remote host over SFTP (bounded, three-way conflict-aware). Use after editing files in the local mirror so the remote reflects your changes. Conflicts (both sides modified) are reported and never overwritten; use force=true to override.',
      parameters: {
        maxFiles: { type: 'integer', description: 'Max files to upload (default 2000)' },
        dryRun: { type: 'boolean', description: 'Compute the plan without uploading (default false)' },
        force: { type: 'boolean', description: 'Overwrite conflicting files (default false)' },
        async: { type: 'boolean', description: 'Run in the background and return a task id (default false)' },
      },
      output: textOut,
      async execute(args, exec) {
        const b = requireBinding(exec, 'rw_push')
        const p = b.ws
        const local = b.mirrorDir || mirrorDirFor(p, b.host, b.username, b.port)
        if (!existsSync(local)) throw new Error(`rw_push: local mirror does not exist — run rw_sync first (${local})`)
        const maxFiles = Math.min(Math.max(Number(args.maxFiles) || 2000, 1), 20000)
        const isIgnored = ignoreMatcher()
        const body = { maxFiles, dryRun: !!args.dryRun, force: !!args.force, isIgnored }
        const runPush = async () => {
          let sftp
          try {
            sftp = await b.pool.sftp()
          } catch (err) {
            throw new Error('sftp unavailable: ' + ((err && err.message) || err))
          }
          const state = loadSyncState(local)
          const { stats, nextState } = await pushTree(sftp, local, p, { ...body, state, maxFileBytes: config.maxFileBytes })
          if (!args.dryRun) saveSyncState(local, nextState)
          let text = `${args.dryRun ? 'WOULD upload' : 'Uploaded'} ${stats.files} file(s) from ${local} → ${p}.`
          if (stats.truncated || stats.files >= maxFiles) text += ` TRUNCATED (hit maxFiles=${maxFiles} cap; raise maxFiles and re-run).`
          if (stats.skippedUnchanged) text += ` ${stats.skippedUnchanged} unchanged.`
          if (stats.skippedLarge) text += ` ${stats.skippedLarge} too large (over ${config.maxFileBytes} bytes).`
          if (stats.staleLocal) text += ` ${stats.staleLocal} local entries gone remotely (kept remotely; use rw_remove to mirror deletions).`
          if (stats.conflicts.length) {
            text += `\n⚠ ${stats.conflicts.length} conflict(s), NOT overwritten:`
            for (const c of stats.conflicts.slice(0, 10)) text += `\n  ${c.path} — ${c.reason}`
            if (stats.conflicts.length > 10) text += `\n  … and ${stats.conflicts.length - 10} more`
            text += '\n(use force=true to override)'
          }
          return { text }
        }
        if (args.async) {
          const t = tasks.start('push', `push ${p}`, runPush)
          return { text: `push started in background: taskId=${t.id} (GET /dsh-remote/task?id=${t.id} for progress)` }
        }
        return runPush()
      },
    }),

    defineTool({
      name: 'rw_list_dir',
      description:
        'List a remote directory (or a single file) via SSH. Path is absolute; accepts Windows paths like C:\\Users\\dev\\project on Git Bash remotes. If omitted, lists the current remote workspace. Shows type, size, mtime.',
      parameters: {
        path: { type: 'string', description: 'Absolute remote path (default: current remote workspace)' },
      },
      output: textOut,
      async execute(args, exec) {
        const b = requireBinding(exec, 'rw_list_dir')
        const p = args.path ? resolveRemoteArg(b, args.path) : b.ws
        if (!p) throw new Error('rw_list_dir: no path and no remote workspace set')
        let list
        try {
          const sftp = await b.pool.sftp()
          list = await sftp.readdir(p)
        } catch (err) {
          throw new Error('rw_list_dir: ' + ((err && err.message) || err))
        }
        const fmtMtime = (t) => {
          if (!t) return '?'
          const d = new Date(t * 1000)
          const pad = (n) => String(n).padStart(2, '0')
          return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
        }
        const lines = list
          .filter((e) => String(e.filename) !== '.' && String(e.filename) !== '..')
          .map((e) => {
            const a = e.attrs || {}
            const type = a.isDirectory && a.isDirectory() ? 'd' : (a.isSymbolicLink && a.isSymbolicLink() ? 'l' : '-')
            const size = typeof a.size === 'number' ? String(a.size) : '?'
            return `${type} ${size.padStart(10)} ${fmtMtime(a.mtime).padEnd(17)} ${String(e.filename)}`
          })
        return { text: lines.length ? lines.join('\n') : '(empty directory)' }
      },
    }),

    defineTool({
      name: 'rw_stat',
      description:
        'Show detailed stat of a remote file or directory: type, size, mtime, mode (SFTP attrs). Use to verify a remote path exists or to compare files.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote path' },
      },
      output: textOut,
      async execute(args, exec) {
        const b = requireMachine(exec, 'rw_stat')
        const p = resolveRemoteArg(b, args.path)
        if (!p) throw new Error('rw_stat: path is required')
        const sftp = await b.pool.sftp()
        let st
        try {
          st = await sftp.stat(p)
        } catch (err) {
          throw new Error('rw_stat: not found or unreadable: ' + ((err && err.message) || err))
        }
        const type = st.isDirectory && st.isDirectory() ? 'directory' : (st.isSymbolicLink && st.isSymbolicLink() ? 'symlink' : 'file')
        const lines = [
          `path: ${p}`,
          `type: ${type}`,
          `size: ${st.size} bytes`,
          `mtime: ${new Date(st.mtime * 1000).toISOString()}`,
          `mode: ${typeof st.mode === 'number' ? st.mode.toString(8) : '?'}`,
        ]
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'rw_read_file',
      description:
        'Read a text file on the remote host with line numbers. Supports paging with startLine/endLine and an encoding param (utf-8 default, gbk etc). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        startLine: { type: 'integer', description: '1-based first line (default 1)' },
        endLine: { type: 'integer', description: '1-based last line (inclusive)' },
        maxLines: { type: 'integer', description: 'Max lines (default 2000)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: textOut,
      async execute(args, exec) {
        const b = requireMachine(exec, 'rw_read_file')
        const p = resolveRemoteArg(b, args.path)
        if (!p) throw new Error('rw_read_file: path is required')
        const maxLines = Math.min(Math.max(Number(args.maxLines) || 2000, 1), 10000)
        let from = Math.max(Number(args.startLine) || 1, 1)
        let to = Number(args.endLine) || 0
        if (!to || to - from + 1 > maxLines) to = from + maxLines - 1
        const sftp = await b.pool.sftp()
        let st
        try { st = await sftp.stat(p) } catch (err) { throw new Error('rw_read_file: ' + ((err && err.message) || err)) }
        if (config.maxFileBytes > 0 && st.size > config.maxFileBytes) {
          throw new Error(`rw_read_file: file is ${st.size} bytes (over ${config.maxFileBytes} cap); use rw_download or rw_exec to read it`)
        }
        let buf
        try {
          buf = await sftp.readFile(p)
        } catch (err) {
          throw new Error('rw_read_file: ' + ((err && err.message) || err))
        }
        const content = decodeBuf(buf, args.encoding || config.encoding).replace(/\r\n/g, '\n')
        const allLines = content.split('\n')
        const page = allLines.slice(from - 1, to)
        const numbered = page.map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n').replace(/\s+$/, '')
        let text = numbered === '' ? '(empty or out of range)' : numbered
        if (!args.endLine) text += '\n(shown up to ' + maxLines + ' lines; use startLine/endLine to page)'
        return { text }
      },
    }),

    defineTool({
      name: 'rw_write_file',
      description:
        'Write text to a file on the remote host (creating parent directories if needed). Path is absolute. Use this to create or overwrite a remote file directly, instead of round-tripping through a local mirror.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        content: { type: 'string', required: true, description: 'File content to write (overwrites existing file)' },
        mkdir: { type: 'boolean', description: 'Create missing parent directories (default true)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args, exec) {
        const b = requireMachine(exec, 'rw_write_file')
        const p = resolveRemoteArg(b, args.path)
        if (!p || p === '/') throw new Error('rw_write_file: a file path is required')
        const content = String(args.content == null ? '' : args.content)
        const sftp = await b.pool.sftp()
        if (args.mkdir !== false) await mkdirRemoteDirs(sftp, remoteDirname(p))
        const buf = encodeText(content, args.encoding || config.encoding)
        await sftp.writeFile(p, buf)
        const bytes = buf.byteLength
        audit('write_file', `write ${p} (${bytes}B)`, 0, b)
        return { ok: true, bytes, text: `wrote ${bytes} bytes to ${p}` }
      },
    }),

    defineTool({
      name: 'rw_edit',
      description:
        'Edit a remote text file by replacing literal text (read-modify-write with an mtime optimistic lock: aborts if the file changed on the remote between read and write). Path is absolute. Accepts the aliases old_string/new_string (and file_path for path), matching the host edit tool, so either spelling works.',
      parameters: {
        // `path`/`old`/`new` also accept the host edit tool's spellings
        // (file_path/old_string/new_string): models habitually use those, and a
        // schema-level `required` on only one spelling rejects the other before
        // execute() ever runs. So NONE of them is declared required here — the
        // resolver below enforces "path + old + new" and reports which spelling
        // to pass. Keep this in sync: adding `required: true` back to any of
        // these silently breaks its alias.
        path: { type: 'string', description: 'Absolute remote file path (alias: file_path)' },
        old: { type: 'string', description: 'Literal text to replace (must appear exactly once unless count is given). Alias: old_string' },
        new: { type: 'string', description: 'Replacement text; an empty string deletes the old text. Alias: new_string' },
        old_string: { type: 'string', description: 'Alias of old (same meaning)' },
        new_string: { type: 'string', description: 'Alias of new (same meaning)' },
        file_path: { type: 'string', description: 'Alias of path (same meaning)' },
        count: { type: 'integer', description: 'How many occurrences to replace (default: error if the text appears more than once)' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args, exec) {
        const b = requireMachine(exec, 'rw_edit')
        // Presence must be checked on the RAW argument, not on the resolved
        // path: resolveRemoteArg falls back to the workspace root for an empty
        // string, so `!p` would never fire and a pathless rw_edit would silently
        // target the workspace root. (That is why `path` cannot simply lose its
        // schema `required` without this check replacing it.)
        const rawPath = args.path ?? args.file_path
        if (rawPath == null || String(rawPath).trim() === '') {
          throw new Error('rw_edit: a file path is required — pass path (alias: file_path)')
        }
        const p = resolveRemoteArg(b, rawPath)
        if (!p || p === '/') throw new Error('rw_edit: a file path is required — pass path (alias: file_path)')
        const oldRaw = args.old ?? args.old_string
        const newRaw = args.new ?? args.new_string
        if (oldRaw == null) throw new Error('rw_edit: old text is required — pass old (alias: old_string)')
        if (newRaw == null) throw new Error('rw_edit: replacement text is required — pass new (alias: new_string); use an empty string to delete the old text')
        const oldS = String(oldRaw)
        const newS = String(newRaw)
        if (oldS === '') throw new Error('rw_edit: old text must not be empty')
        const sftp = await b.pool.sftp()
        const st0 = await sftp.stat(p)
        const buf = await sftp.readFile(p)
        const content = decodeBuf(buf, args.encoding || config.encoding)
        const count = args.count == null ? 0 : Math.max(Number(args.count) || 1, 1)
        const idxs = []
        let from = 0
        let hit
        while ((hit = content.indexOf(oldS, from)) !== -1) { idxs.push(hit); from = hit + oldS.length }
        if (!idxs.length) throw new Error(`rw_edit: old text not found in ${p}`)
        if (count === 0 && idxs.length > 1) {
          throw new Error(`rw_edit: "old" appears ${idxs.length} times in ${p} — pass count=<n> to pick how many to replace`)
        }
        const n = count === 0 ? 1 : Math.min(count, idxs.length)
        let out = content
        for (let i = n - 1; i >= 0; i--) {
          out = out.slice(0, idxs[i]) + newS + out.slice(idxs[i] + oldS.length)
        }
        // Optimistic lock: the remote must not have changed since we read it.
        const st1 = await sftp.stat(p)
        if (st1.size !== st0.size || st1.mtime !== st0.mtime) {
          throw new Error(`rw_edit: ${p} changed on the remote while editing (conflict) — re-read and retry`)
        }
        await sftp.writeFile(p, encodeText(out, args.encoding || config.encoding))
        audit('edit', `edit ${p} (${n} occurrence(s))`, 0, b)
        return { ok: true, bytes: Buffer.byteLength(out), text: `edited ${p}: replaced ${n} occurrence(s)` }
      },
    }),

    defineTool({
      name: 'rw_append',
      description:
        'Append text to a remote file (creates it when missing). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        content: { type: 'string', required: true, description: 'Text to append' },
        encoding: { type: 'string', description: 'Text encoding, e.g. utf-8 (default) or gbk' },
      },
      output: okOut,
      async execute(args, exec) {
        const b = requireMachine(exec, 'rw_append')
        const p = resolveRemoteArg(b, args.path)
        if (!p || p === '/') throw new Error('rw_append: a file path is required')
        const sftp = await b.pool.sftp()
        let existing = ''
        try { existing = decodeBuf(await sftp.readFile(p), args.encoding || config.encoding) } catch { /* new file */ }
        const content = existing + String(args.content ?? '')
        await sftp.writeFile(p, encodeText(content, args.encoding || config.encoding))
        const bytes = Buffer.byteLength(content)
        audit('append', `append ${p}`, 0, b)
        return { ok: true, bytes, text: `appended to ${p} (now ${bytes} bytes)` }
      },
    }),

    defineTool({
      name: 'rw_mkdir',
      description:
        'Create a remote directory (mkdir -p semantics, all levels). Path is absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote directory path' },
      },
      output: textOut,
      async execute(args, exec) {
        const b = requireMachine(exec, 'rw_mkdir')
        const p = resolveRemoteArg(b, args.path)
        if (!p || p === '/') throw new Error('rw_mkdir: a directory path is required')
        const sftp = await b.pool.sftp()
        await mkdirRemoteDirs(sftp, p)
        audit('mkdir', `mkdir ${p}`, 0, b)
        return { text: `created ${p}` }
      },
    }),

    defineTool({
      name: 'rw_remove',
      description:
        'Delete a remote file (or an empty directory). recursive=true removes a directory tree (bounded). Path is absolute. This is destructive — the agent should confirm intent before calling.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote path to delete' },
        recursive: { type: 'boolean', description: 'Recursively delete a directory (default false)' },
      },
      output: okOut,
      async execute(args, exec) {
        const b = requireMachine(exec, 'rw_remove')
        const p = resolveRemoteArg(b, args.path)
        if (!p || p === '/') throw new Error('rw_remove: a path is required')
        const sftp = await b.pool.sftp()
        const st = await sftp.stat(p).catch(() => null)
        if (!st) return { ok: false, text: `not found: ${p}` }
        if (st.isDirectory && st.isDirectory()) {
          if (!args.recursive) throw new Error(`rw_remove: ${p} is a directory — pass recursive=true to delete its tree`)
          const removed = await removeRemoteTree(sftp, p)
          audit('remove', `remove -r ${p}`, 0, b)
          return { ok: true, text: `removed ${removed} entries under ${p}` }
        }
        await sftp.unlink(p)
        audit('remove', `remove ${p}`, 0, b)
        return { ok: true, text: `removed ${p}` }
      },
    }),

    defineTool({
      name: 'rw_move',
      description:
        'Rename or move a remote file/directory (SFTP rename, same filesystem). Paths are absolute.',
      parameters: {
        path: { type: 'string', required: true, description: 'Current absolute remote path' },
        dest: { type: 'string', required: true, description: 'Destination absolute remote path' },
      },
      output: textOut,
      async execute(args, exec) {
        const b = requireMachine(exec, 'rw_move')
        const p = resolveRemoteArg(b, args.path)
        const d = resolveRemoteArg(b, args.dest)
        if (!p || !d || p === '/') throw new Error('rw_move: both path and dest are required')
        const sftp = await b.pool.sftp()
        await mkdirRemoteDirs(sftp, remoteDirname(d))
        await sftp.rename(p, d)
        audit('move', `move ${p} → ${d}`, 0, b)
        return { text: `moved ${p} → ${d}` }
      },
    }),

    defineTool({
      name: 'rw_exec',
      description:
        'Run a shell command on the remote host. Use for anything that is not reading a file (build, test, grep, etc). Output is capped. Runs in the current remote workspace by default; pass cwd to run elsewhere. pty=true helps interactive commands (sudo prompts, REPLs); env sets environment variables.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell command (run on the remote host)' },
        cwd: { type: 'string', description: 'Working directory for the command (default: the current remote workspace)' },
        pty: { type: 'boolean', description: 'Allocate a pseudo-terminal (interactive commands, default false)' },
        env: { type: 'object', additionalProperties: true, description: 'Extra environment variables (string values)' },
      },
      output: textOut,
      async execute(args, exec) {
        const b = requireBinding(exec, 'rw_exec')
        const cmd = String(args.command || '')
        if (!cmd) throw new Error('rw_exec: command is required')
        const ws = b.ws
        const cwd = args.cwd ? resolveRemoteArg(b, args.cwd) : (ws || '')
        let full = cmd
        if (cwd) {
          // Detect before choosing the cwd form: a per-machine pool starts
          // undetected, and reading `platform` first would skip the Git Bash
          // mount-path rewrite on the first command sent to a Windows host.
          // detect() is cached and idempotent, so this costs one probe per pool.
          try { await b.pool.detect() } catch { /* probe failed → fall through to the POSIX form */ }
          if (b.pool.platform === 'windows' && b.pool.gitBashPath) {
            // Git Bash terminal: cd in the /c/Users/… mount form
            full = `cd ${shq(toShellPath(cwd))} && ${cmd}`
          } else if (!cwd.includes('\\')) {
            full = `cd ${shq(cwd)} && ${cmd}`
          }
        }
        try {
          const res = await b.pool.exec(full, { timeoutMs: config.commandTimeoutMs, pty: !!args.pty, env: args.env })
          audit('exec', cmd, res.code, b)
          const parts = []
          if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''))
          if (res.stderr) parts.push('-- stderr --\n' + res.stderr.replace(/\s+$/, ''))
          if (!parts.length) parts.push('(no output)')
          let text = parts.join('\n')
          if (res.signal === 'TIMEOUT') text += `\n[command timed out after ${config.commandTimeoutMs}ms]`
          else if (res.signal === 'ABORTED') text += '\n[cancelled — the remote command was stopped]'
          else if (res.code !== 0) text += `\n[exit code: ${res.code}]`
          return { text }
        } catch (err) {
          throw new Error(friendlyMessage(err, { host: b.host, port: b.port }))
        }
      },
    }),

    defineTool({
      name: 'rw_search',
      description:
        'Search remote files for a pattern. POSIX remotes try `rg` then `grep -R` first; Windows and fallbacks use a portable SFTP walk. Honors ignore rules. Returns matching file:line rows; output is capped. Search is bounded (maxEntries/maxDurationMs) and can be cancelled: on a very large tree it returns partial results marked TRUNCATED instead of running indefinitely.',
      // A cooperative budget for @deepseek-ai/dsh-tool-call-timeout-policy.
      // Only useful together with the cancellation support below: the policy can
      // only *ask* a tool to stop, so a tool that ignores exec.signal would keep
      // the caller waiting (issue #44).
      timeoutMs: config.searchTimeoutMs,
      parameters: {
        pattern: { type: 'string', required: true, description: 'Pattern to search for (extended regex)' },
        path: { type: 'string', description: 'Directory to search (default: current remote workspace)' },
        glob: { type: 'string', description: 'Only files whose NAME matches this glob, e.g. *.ts (optional)' },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default true)' },
        contextLines: { type: 'integer', description: 'Lines of context around each match (default 0)' },
        maxMatches: { type: 'integer', description: 'Max matches to return (default 500)' },
        maxEntries: { type: 'integer', description: 'Stop after scanning this many files (default 50000)' },
        maxDurationMs: { type: 'integer', description: 'Stop after this many ms and return partial results (default 60000)' },
      },
      output: textOut,
      async execute(args, exec) {
        const b = requireBinding(exec, 'rw_search')
        const pattern = String(args.pattern || '')
        if (!pattern) throw new Error('rw_search: pattern is required')
        const ws = b.ws
        const dir = args.path ? resolveRemoteArg(b, args.path) : (ws || '')
        if (!dir) throw new Error('rw_search: no path and no remote workspace set')
        let regex
        try {
          regex = new RegExp(pattern, args.ignoreCase === false ? '' : 'i')
        } catch (err) {
          throw new Error('rw_search: bad pattern: ' + ((err && err.message) || err))
        }
        const maxMatches = Math.min(Math.max(Number(args.maxMatches) || 500, 1), 2000)
        // Budgets. The SFTP walk had NO entry/duration cap before, so a search
        // over a home directory could run for hours while the turn stayed
        // `running` and cancel/steer did nothing (issue #44).
        const maxFiles = Math.min(Math.max(Number(args.maxEntries) || config.searchMaxEntries, 1), 500000)
        const maxDurationMs = Math.min(Math.max(Number(args.maxDurationMs) || config.searchTimeoutMs, 1000), 600000)
        const matcher = searchIgnoreMatcher()
        const { matches, scanned, truncated, cancelled } = await searchRemote(b.pool, dir, {
          pattern,
          regex,
          glob: args.glob,
          ignoreCase: args.ignoreCase !== false,
          contextLines: Math.min(Math.max(Number(args.contextLines) || 0, 0), 10),
          maxMatches,
          maxFiles,
          maxDurationMs,
          signal: exec.signal,
          maxScanBytes: Math.min(config.maxFileBytes || 1024 * 1024, 1024 * 1024),
          isIgnored: (name, isDir) => matcher(name, isDir),
          timeoutMs: Math.min(config.commandTimeoutMs, maxDurationMs),
        })
        const note = cancelled
          ? `, CANCELLED after ${scanned} files scanned`
          : truncated
            ? ', TRUNCATED'
            : ''
        if (!matches.length) {
          return { text: `no matches for /${pattern}/ in ${dir} (${scanned} files scanned${note})` }
        }
        let text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n')
        text += `\n(${matches.length} match(es), ${scanned} files scanned${note})`
        return { text: truncate(text, config.maxOutputChars) }
      },
    }),

    defineTool({
      name: 'rw_download',
      description:
        'Download a single remote file over SFTP into the local mirror of the current workspace (or to an explicit local path). Use when you need the actual file content locally, not just its text. Streams to disk (fastGet).',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute remote file path' },
        localPath: { type: 'string', description: 'Local destination (default: the workspace mirror, preserving the relative path)' },
      },
      output: okOut,
      async execute(args, exec) {
        const b = requireMachine(exec, 'rw_download')
        const p = resolveRemoteArg(b, args.path)
        if (!p || p === '/') throw new Error('rw_download: a remote file path is required')
        const sftp = await b.pool.sftp()
        let local
        if (args.localPath) {
          local = path.resolve(String(args.localPath))
        } else {
          const ws = b.ws
          if (!ws) throw new Error('rw_download: no remote workspace set — pass localPath explicitly')
          const base = mirrorDirFor(ws, b.host, b.username, b.port)
          const rel = p.startsWith(ws) ? p.slice(ws.length).replace(/^\/+/, '') : p.slice(1)
          local = path.join(base, rel)
        }
        mkdirSync(path.dirname(local), { recursive: true })
        const st = await sftp.stat(p).catch(() => null)
        if (config.maxFileBytes > 0 && st && st.size > config.maxFileBytes) {
          throw new Error(`rw_download: file is ${st.size} bytes (over ${config.maxFileBytes} cap)`)
        }
        await sftp.fastGet(p, local)
        const bytes = existsSync(local) ? statSync(local).size : 0
        return { ok: true, bytes, text: `downloaded ${bytes} bytes from ${p} → ${local}` }
      },
    }),

    defineTool({
      name: 'rw_upload',
      description:
        'Upload a local file over SFTP to a path on the remote host (creating parent directories if needed). Use to push a local file directly, without a full rw_push of the whole mirror.',
      parameters: {
        localPath: { type: 'string', required: true, description: 'Absolute local file path' },
        path: { type: 'string', required: true, description: 'Absolute remote destination path' },
      },
      output: okOut,
      async execute(args, exec) {
        const b = requireMachine(exec, 'rw_upload')
        const rp = resolveRemoteArg(b, args.path)
        const lp = String(args.localPath || '')
        if (!rp || rp === '/' || !lp) throw new Error('rw_upload: both localPath and a remote path are required')
        if (!existsSync(lp)) throw new Error(`rw_upload: local file not found: ${lp}`)
        const sftp = await b.pool.sftp()
        await mkdirRemoteDirs(sftp, remoteDirname(rp))
        const st = statSync(lp)
        await sftp.fastPut(lp, rp)
        audit('upload', `upload ${lp} → ${rp}`, 0, b)
        return { ok: true, bytes: st.size, text: `uploaded ${st.size} bytes from ${lp} → ${rp}` }
      },
    }),

    defineTool({
      name: 'rw_deploy_probe',
      description:
        'READ-ONLY health check of the remote machine\'s DSH install: platform/arch, node/npm, the existing dsh and its version, whether its native module can load (the usual reason `dsh web` will not start, e.g. a node-pty build with no Linux prebuild), whether it knows --no-open, proxy and npm registry settings, and whether a private install prefix is writable. Writes nothing on the remote. Use it before troubleshooting a failed remote DSH Web UI connection. For an automatic install into a private prefix, use the settings UI ("Deploy & verify") — this tool never installs.',
      parameters: {},
      output: textOut,
      async execute(_args, exec) {
        // Use the BINDING (this session's own machine), like every other rw_*
        // tool. Reading the active machine instead would let a probe report on a
        // host this session never asked about.
        const b = requireBinding(exec, 'rw_deploy_probe')
        // The binding carries host/port/user but no id; match on the identity the
        // binding resolved, so a machine previously deployed to is still found
        // (its `webAttachCommand` is the per-machine record we want to report).
        const machine = machines.find((m) => m.host === b.host
          && Number(m.port || 22) === Number(b.port || 22)
          && (!b.username || m.username === b.username)) || null
        // Do NOT pre-resolve the prefix locally: `resolvePrefix({home:''})` falls
        // back to /tmp, which is not where an install would go. With no explicit
        // config the REMOTE resolves it from its own $HOME and reports back.
        const explicitPrefix = String(config.webInstallPrefix || '').trim()
        const installedCommand = String((machine && machine.webAttachCommand) || '').trim()
        const out = await b.pool.exec(
          buildProbeCommand({ prefix: explicitPrefix, installedCommand, defaultPrefixFor: explicitPrefix ? '' : 'home' }),
          { timeoutMs: 30000 },
        )
        const facts = parseProbe(out && out.stdout)
        const verdict = judgeProbe(facts, { installedCommand })
        // Rendered as a compact report: the model needs the FACTS and the
        // VERDICT, not a JSON blob it would have to re-interpret.
        const lines = [
          `remote: ${b.host}${b.username ? ' (' + b.username + ')' : ''}`,
          `verdict: ${verdict.severity}${verdict.ok ? ' (usable)' : ' (blocked)'}`,
          verdict.useCommand ? `dsh to use: ${verdict.useCommand}` : 'dsh to use: (none usable yet)',
          `can auto-install: ${verdict.canAutoInstall ? 'yes' : 'no'}`,
          '',
          'facts:',
          `  platform=${facts.platform || '?'} arch=${facts.arch || '?'} ${facts.windows ? '(windows)' : ''}`,
          `  node=${facts.node || '(none)'} ${facts.nodeVersion || ''}`,
          `  npm=${facts.npm || '(none)'}`,
          `  dsh=${facts.dsh || '(none)'} ${facts.dshVersion || ''}`,
          `  native-module (node-pty) prebuild: ${facts.ptyPrebuild || 'unknown'}`,
          `  knows --no-open: ${facts.noOpen || 'unknown'}`,
          facts.installed ? `  previously deployed command present: ${facts.installed} (pty=${facts.installedPty || '?'} web=${facts.installedWeb || '?'})` : '',
          `  git bash: ${facts.gitBash || '(none)'}${facts.windows && !facts.gitBash ? ' — required for a Windows remote' : ''}`,
          `  proxy: ${facts.proxyVar || '(none)'}  npm registry: ${facts.registry || '(default)'}`,
          `  install prefix ${facts.resolvedPrefix || explicitPrefix || '(unresolved)'} writable: ${facts.writable || 'unknown'}`,
          '',
          'findings:',
          ...verdict.findings.map((f) => `  [${f.severity}] ${f.summary}${f.detail ? ' — ' + f.detail : ''}${f.fix ? '\n        fix: ' + f.fix : ''}`),
        ].filter(Boolean)
        if (!verdict.ok) {
          lines.push('', 'This is read-only. To fix it, either use the settings UI card "Remote dsh health check & deploy" (it installs into a private prefix and verifies), or repair it yourself following the dsh-remote-deploy skill.')
        }
        return { text: lines.join('\n') }
      },
    }),

    defineTool({
      name: 'rw_forward',
      description:
        'Manage SSH port forwards. Direction "local" listens on 127.0.0.1:<listenPort> on THIS machine and forwards connections through SSH to <targetHost>:<targetPort> on the remote. Direction "reverse" asks the REMOTE to listen on 127.0.0.1:<listenPort> and pipes connections back to <targetHost>:<targetPort> on this machine. Call with a listenPort to create+start; with remove=true to delete.',
      parameters: {
        listenPort: { type: 'integer', required: true, description: 'Port to listen on (local for direction=local, remote for direction=reverse)' },
        targetHost: { type: 'string', description: 'Forward target host (default 127.0.0.1)' },
        targetPort: { type: 'integer', description: 'Forward target port (default: same as listenPort)' },
        direction: { type: 'string', description: 'local (default) or reverse' },
        autoStart: { type: 'boolean', description: 'Restart this forward automatically on future connects (default false)' },
        remove: { type: 'boolean', description: 'Remove an existing forward by listenPort (default false)' },
      },
      output: textOut,
      async execute(args) {
        const port = Number(args.listenPort)
        if (!port || port < 1 || port > 65535) throw new Error('rw_forward: a valid listenPort is required')
        const dir = args.direction === 'reverse' ? 'reverse' : 'local'
        const existing = forwards.list().find((f) => Number(f.listenPort) === port && f.direction === dir)
        if (args.remove) {
          if (!existing) return { text: `no forward on port ${port} to remove` }
          forwards.remove(existing.id)
          return { text: `removed ${existing.direction} forward on port ${port}` }
        }
        if (existing && existing.active) return { text: `already active: ${existing.direction} forward 127.0.0.1:${port} → ${existing.targetHost}:${existing.targetPort}` }
        const d = existing || forwards.define({
          direction: dir,
          listenPort: port,
          targetHost: args.targetHost || '127.0.0.1',
          targetPort: Number(args.targetPort) || port,
          autoStart: !!args.autoStart,
          machineId: store.currentId,
        })
        const r = await forwards.start(d)
        audit('forward', `${d.direction} forward ${port} → ${d.targetHost}:${d.targetPort}`, r.ok ? 0 : 1)
        if (!r.ok) throw new Error(r.error)
        return { text: `${d.direction} forward active: 127.0.0.1:${port} → ${d.targetHost}:${d.targetPort} (id=${d.id})` }
      },
    }),

    defineTool({
      name: 'rw_disconnect',
      description:
        "Close this session's SSH connection to its remote host, releasing the persistent pool. Useful to rotate a connection or after a long idle. Sessions bound to other machines keep their own connections.",
      parameters: {},
      output: okOut,
      async execute(_args, exec) {
        // Close the connection THIS session actually uses: closing the
        // active-machine pool instead would look like a no-op to a bound
        // session while disconnecting whichever machine happened to be active.
        const b = bindingFor(exec)
        b.pool.close()
        if (!b.bound) return { ok: true, text: 'disconnected the active machine (forwards stopped)' }
        return { ok: true, text: `disconnected ${b.username}@${b.host}:${b.port} for this session` }
      },
    }),

  ]

  for (const t of tools) {
    ctx.tools.register(t)
  }

  // ── system-prompt injection: session-aware remote workspace ──────────────
  // Issue #13: remote context must be SESSION-scoped, not machine-global.
  // The section text is evaluated per assembly with the current agent's
  // session; it is injected ONLY when that session's cwd actually maps to a
  // dsh-remote mirror (i.e. the user picked a remote workspace as the session
  // workspace). A plain local session gets no remote section — saved machines
  // never leak their workspace into an unrelated local session's prompt.
  // (resolveMirrorForLocal is defined above, next to wsPath.)
  ctx.systemPrompt.section({
    name: 'dsh-remote',
    order: 88,
    text: (promptContext) => {
      const agent = promptContext && promptContext.agent
      const session = agent && agent.session
      const cwd = session && session.header && session.header.cwd
      if (!cwd) return '' // no session cwd → nothing to map → stay quiet
      const { remotePath, machine } = resolveMirrorForLocal(cwd)
      if (!remotePath) return '' // this session is NOT a remote session (issue #13)
      // Name the machine the MIRROR records, not the active one: pairing this
      // session's remote path with whichever machine happens to be active
      // states a host/path combination that may not exist (issue #25).
      const who = machine
        ? `${machine.username || 'user'}@${machine.host}`
        : `${config.username || 'user'}@${config.host}`
      const platform = machine ? poolForMachine(machine).platform : pool.platform
      const shown = toDisplayPath(remotePath, platform)
      const fwd = forwards.list().filter((f) => f.active).map((f) => `${f.direction}:127.0.0.1:${f.listenPort}→${f.targetHost}:${f.targetPort}`)
      let extra = ''
      if (fwd.length) extra = `\nActive port forwards: ${fwd.join(', ')}`
      // Issue #39: `@` mentions are resolved from the REMOTE tree by
      // lib/file-reference.js, so the model must know they are remote-relative
      // and that the built-in read tool sees only the local mirror.
      return (
        '## Remote workspace\n' +
        `Current remote workspace: ${who}:${shown}\n` +
        'Use the rw_* tools (rw_list_dir / rw_read_file / rw_write_file / rw_edit / rw_exec / rw_search / rw_sync / rw_push) to inspect and act on files on the remote host. Treat this directory as the working root for this task.\n' +
        `\`@path\` mentions in this conversation name files under THAT remote root (\`@src/main.c\` = ${shown}/src/main.c). ` +
        'The rw_* tools take such paths as workspace-relative and resolve them against this root. ' +
        'The harness\'s built-in read/list tools only see the LOCAL mirror of this directory, which stays empty until rw_sync — use rw_read_file for remote files.' +
        extra
      )
    },
  })

  // ── slash commands ─────────────────────────────────────────────────────────
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'remote',
      description: 'Show the current remote workspace / connection status, active forwards, and how to use remote tools.',
      handler: (invocation) => {
        const s = status()
        const fwd = s.forwards.filter((f) => f.active)
        return {
          kind: 'success',
          text:
            `Remote host: ${s.username}@${s.host || '<none>'} (connected: ${s.connected}, source: ${s.activeSource})\n` +
            `Remote workspace: ${s.workspace || '(none)'}\n` +
            `Host key: ${s.hostKeyKnown ? 'trusted ✓' : 'not yet trusted'} (mode=${s.hostKeyMode})\n` +
            (s.hostKeyKnown ? `  — if the key changed / was mistrusted, run /remote-forget-key\n` : '') +
            (fwd.length ? `Active forwards:\n${fwd.map((f) => `  ${f.direction} 127.0.0.1:${f.listenPort} → ${f.targetHost}:${f.targetPort}`).join('\n')}\n` : '') +
            `\nUse tools: rw_list_dir / rw_read_file / rw_edit / rw_exec / rw_search / rw_forward.` +
            (s.workspace ? `\nCurrently working in ${s.workspace}.` : ''),
        }
      },
    })
    commands.register({
      name: 'remote-forget-key',
      description: 'Drop the trusted host-key record for the current machine so the next connect re-records it.',
      handler: () => {
        createHostKeyGuard(config, knownHostsFile()).forgetHost()
        return { kind: 'success', text: `forgot host key for ${config.host || '<none>'}:${config.port} — the next connect will re-record it.` }
      },
    })
    commands.register({
      name: 'remote-ignore',
      description: 'Show the mirror ignore rules file location and the current default patterns (gitignore syntax).',
      handler: () => {
        return {
          kind: 'success',
          text:
            `Ignore file: ${ignoreFile()}\n(defaults merged with the file; gitignore syntax, '#' comments)\n\nDefault patterns:\n${DEFAULT_IGNORE.map((p) => '  ' + p).join('\n')}`,
        }
      },
    })
  }

  // ── JSON endpoints for settings UI ─────────────────────────────────────────
  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  const MAX_BODY_BYTES = 1024 * 1024
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      let total = 0
      req.on('data', (c) => {
        total += c.length
        if (total > MAX_BODY_BYTES) {
          req.removeAllListeners('data')
          resolve('{}')
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(chunks.join('')))
    })

  /** Parse a JSON *object* request body.
   *
   * Throws an Error carrying `httpStatus: 400` when the body is not valid JSON
   * or not an object, so a route can answer `400 + {ok:false, error}` instead of
   * rejecting the handler — a rejected handler makes dsh-host-webserver reply
   * with an empty 400 that carries neither Content-Type nor a reason, which is
   * exactly the "everything is just HTTP 400" symptom of issue #30. */
  const parseJsonObject = (raw) => {
    let parsed
    try {
      parsed = JSON.parse(raw || '{}')
    } catch (e) {
      const err = new Error(`请求体不是合法 JSON：${String((e && e.message) || e)}`)
      err.httpStatus = 400
      throw err
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('请求体必须是一个 JSON 对象')
      err.httpStatus = 400
      throw err
    }
    return parsed
  }

  // ── 本机目录选择器：DSH directoryPicker 服务优先，缺位/非原生则自持兜底 ──
  const PICK_TIMEOUT_MS = 120000
  const runPick = (bin, args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: PICK_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (err) {
          const code = err.code
          const msg = String(stderr || '')
          if (code === 1 && /(?:user canceled|-128)/i.test(msg)) return resolve({ cancelled: true })
          if (err.signal || err.killed) return reject(new Error('目录选择已超时，请重试或直接在输入框填本地路径'))
          if (code === 'ENOENT') return reject(Object.assign(new Error('未找到目录选择器程序 ' + bin), { code }))
          return reject(new Error((msg.trim() || (err && err.message) || '无法打开系统文件夹选择器').split('\n')[0]))
        }
        const p = String(stdout || '').replace(/[\r\n]+$/, '').trim()
        resolve(p === 'CANCELED' ? { cancelled: true } : (p ? { path: p } : { cancelled: true }))
      })
    })
  const pickLocalNative = async () => {
    const platform = process.platform
    if (platform === 'darwin') {
      return runPick('osascript', ['-e', 'set selectedFolder to choose folder with prompt "Select Workspace Directory"', '-e', 'POSIX path of selectedFolder'])
    }
    if (platform === 'linux') {
      try {
        return await runPick('zenity', ['--file-selection', '--directory', '--title=Select Workspace Directory'])
      } catch (err) {
        if (err && err.code === 'ENOENT') return runPick('kdialog', ['--getexistingdirectory', '.', '--title', 'Select Workspace Directory'])
        throw err
      }
    }
    if (platform === 'win32') {
      const script =
        `Add-Type -AssemblyName System.Windows.Forms;` +
        `$f = New-Object System.Windows.Forms.FolderBrowserDialog;` +
        `$f.Description = 'Select Workspace Directory';` +
        `if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath } else { 'CANCELED' }`
      return runPick('powershell', ['-NoProfile', '-STA', '-Command', script])
    }
    throw new Error('当前系统不支持自动打开目录选择器，请在输入框直接填本地路径')
  }

  /** The ctx.directoryPicker capability object, or null when the service is
   * absent/unusable. Never throws — callers fall through to pickLocalNative. */
  const localPickCapability = async () => {
    const dp = (ctx && typeof ctx.get === 'function') ? (ctx.get('directoryPicker') || null) : null
    if (!dp || typeof dp.capability !== 'function') return null
    try {
      return await Promise.resolve(dp.capability())
    } catch {
      return null
    }
  }

  /** Windows has no single filesystem root — enumerate fixed/mapped drive
   * letters so the in-app browser can switch between them (the browse
   * backend's crumbs stop at the current drive's root). Empty on POSIX. */
  const listLocalDrives = () => {
    if (process.platform !== 'win32') return []
    const out = []
    for (let i = 67; i <= 90; i++) { // C..Z (A/B are legacy floppy — skip)
      const root = String.fromCharCode(i) + ':\\'
      try {
        statSync(root)
        out.push({ name: root.slice(0, -1), path: root })
      } catch {}
    }
    return out
  }

  // ── route helpers ─────────────────────────────────────────────────────────
  const routes = [
    {
      kind: 'exact',
      path: '/dsh-remote/status',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const q = new URL(req.url, 'http://localhost').searchParams
          const sessionId = q.get('sessionId') ? decodeURIComponent(q.get('sessionId')) : ''
          // Per-session remote context (issue #13): when a sessionId is given,
          // sessionMode reflects THAT session's cwd, not the machine default.
          if (!sessionId) return sendJson(res, 200, status())
          const cwd = sessionCwd(sessionId)
          const resolved = cwd ? resolveMirrorForLocal(cwd) : { remotePath: '', machine: null }
          const extra = {
            sessionMode: resolved.remotePath ? 'remote' : 'local',
            sessionRemotePath: resolved.remotePath || '',
            sessionBound: !!(resolved.machine && resolved.remotePath),
          }
          if (resolved.machine && resolved.remotePath) {
            const p = poolForMachine(resolved.machine)
            extra.host = resolved.machine.host
            extra.username = resolved.machine.username
            extra.port = resolved.machine.port
            extra.workspace = toDisplayPath(resolved.remotePath, p.platform)
            // Bound sessions are allowed to list/read even if this process has
            // not yet opened a socket — /ls connects on demand.
            extra.connected = true
          }
          return sendJson(res, 200, { ...status(), ...extra })
        }
        sendJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      // Map a LOCAL path (typically a session cwd that sits inside a remote
      // mirror dir) to the remote path it mirrors, by reading each mirror
      // dir's .dsh-remote-meta.json. NO machine-workspace fallback (issue #13):
      // a session whose cwd is not inside any mirror is a pure LOCAL session —
      // the sidebar must show "no remote workspace", never another machine's
      // remembered default.
      // Accepts either ?local=<abs path> or ?sessionId=<id> (resolved via
      // the host sessions service header.cwd).
      kind: 'exact',
      path: '/dsh-remote/resolve-mirror',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          let local = q.get('local') ? decodeURIComponent(q.get('local')) : ''
          const sessionId = q.get('sessionId') ? decodeURIComponent(q.get('sessionId')) : ''
          let resolvedVia = 'query'
          if (!local && sessionId) {
            // 1) Live in-memory session header (active sessions only).
            try {
              const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
              const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
              const header = session && session.header ? session.header : null
              if (header && header.cwd) {
                local = String(header.cwd)
                resolvedVia = 'session'
              }
            } catch { /* sessions service unavailable */ }
            // 2) Durable session log header (works for historical sessions too):
            //    walk $DSH_HOME/sessions/<projectKey>/<sessionId>/session.jsonl.zstd
            //    and read the header line (first zstd frame) for cwd.
            if (!local) {
              try {
                const sessionsRoot = path.join(dshBase(), 'sessions')
                if (existsSync(sessionsRoot)) {
                  const targetDir = encodeSegmentSafe(sessionId)
                  for (const projDir of readdirSync(sessionsRoot)) {
                    const projPath = path.join(sessionsRoot, projDir)
                    if (!statSync(projPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
                    const sessDir = path.join(projPath, targetDir)
                    if (!statSync(sessDir, { throwIfNoEntry: false })?.isDirectory?.()) continue
                    const logFile = ['session.jsonl.zstd', 'session.jsonl', 'session.jsonl.gz'].map((n) => path.join(sessDir, n)).find((p) => existsSync(p))
                    if (!logFile) continue
                    const cwd = readSessionHeaderCwd(logFile)
                    if (cwd) {
                      local = cwd
                      resolvedVia = 'session-log'
                      break
                    }
                  }
                }
              } catch { /* session log scan failed */ }
            }
          }
          const root = remoteWorkspacesRoot()
          const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '') || ''
          let matched = ''
          let matchedRemote = ''
          if (local && existsSync(root)) {
            const base = norm(local)
            for (const hostDir of readdirSync(root)) {
              const hostPath = path.join(root, hostDir)
              if (!statSync(hostPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
              for (const mirrorDir of readdirSync(hostPath)) {
                const metaPath = path.join(hostPath, mirrorDir, '.dsh-remote-meta.json')
                if (!existsSync(metaPath)) continue
                try {
                  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
                  const mirrorAbs = norm(path.join(hostPath, mirrorDir))
                  // Exact mirror dir match, or the local path is inside the mirror dir.
                  if (mirrorAbs === base || base.startsWith(mirrorAbs + path.sep) || base.startsWith(mirrorAbs + '/')) {
                    if (mirrorAbs.length > matched.length) {
                      matched = mirrorAbs
                      matchedRemote = String(meta.remotePath || '')
                    }
                  }
                } catch { /* skip unparsable meta */ }
              }
            }
          }
          // Issue #13: a non-mirror session is LOCAL — remotePath stays empty.
          const remotePath = matchedRemote || ''
          return sendJson(res, 200, {
            local, remotePath, mirrorDir: matched || null,
            // `fallback:true` now means "this session is NOT a remote session"
            // (used to mean "fell back to machine workspace").
            fallback: !matchedRemote,
            mode: matchedRemote ? 'remote' : 'local',
            resolvedVia,
          })
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      // Every local mirror with its recorded remote origin (issue #49).
      //
      // The sidebar paints a "this session is remote" mark on a Session row, so
      // it needs the same mapping for every visible row. One directory listing
      // answers all of them: the client matches each row's own cwd (which it
      // already has in the sessions snapshot) against these mirror dirs, and a
      // row whose cwd is inside a mirror is a remote session bound to that
      // mirror's host. Never consults the mutable active machine — a saved
      // machine that happens to be "current" must not label a local session.
      kind: 'exact',
      path: '/dsh-remote/bindings',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          return sendJson(res, 200, { mirrors: mirrorRegistry() })
        } catch (err) {
          return sendJson(res, 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        // Issue #30: `payload` is declared OUTSIDE the try block on purpose.
        // A `const payload` inside `try` is scoped to that block, so the catch
        // below used to throw `ReferenceError: payload is not defined` BEFORE
        // it could send anything — the webserver then turned the rejected
        // handler into an empty HTTP 400 and the real reason never reached the
        // UI. Hoisting it (and defaulting to {}) makes the failure path total:
        // this handler now always answers with JSON.
        let payload = {}
        try {
          payload = parseJsonObject(await readBody(req))
          // This route is a reconnect PROBE ("Connect" button): with the
          // unchanged-target no-op in setTarget, an identical target would
          // reuse a possibly half-open cached client and the probe could hang.
          // invalidate() is the design's forced-reconnect escape hatch — drop
          // the cached client so the `echo ok` below always re-dials.
          pool.invalidate()
          pool.setTarget({
            host: payload.host,
            port: payload.port,
            username: payload.username,
            password: payload.password !== undefined && payload.password !== '' ? payload.password : undefined,
            privateKeyPath: payload.privateKeyPath,
            workspace: payload.workspace,
          })
          await pool.exec('echo ok', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
          return sendJson(res, 200, { ok: true, ...status() })
        } catch (err) {
          return sendJson(res, (err && err.httpStatus) || 500, { ok: false, error: friendlyMessage(err, { host: payload.host, port: payload.port }) })
        }
      },
    },
    ...createFsRoutes({
      sendJson, readBody, resolveRequestBinding, decodeBuf, encodeText, audit, config, mirrorDirFor,
    }),

    {
      kind: 'exact',
      path: '/dsh-remote/workspace',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = normalizeRemotePath(String(payload.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { error: 'path must be an absolute directory' })
          const okDir = await isRemoteDir(p)
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory: ${p}` })
          persistWorkspace(p)
          const local = ensureMirror(p, config.host, config.username, config.port, { alias: aliasOf(activeMachine()) })
          startAutoPush(local)
          return sendJson(res, 200, { ok: true, workspace: p, localMirror: local, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/mirror',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = normalizeRemotePath(String(payload.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path must be an absolute directory' })
          if (!config.host) return sendJson(res, 400, { ok: false, error: 'no remote host configured/connected — connect first' })
          // The picker names the machine it was browsing. Re-assert it so a
          // switch made elsewhere between the listing and this commit cannot
          // mirror onto a machine the user never looked at (the picker sends
          // /current only once per machine now, so nothing else re-applies it).
          if (!(await applyRequestedMachine(payload, res))) return
          const okDir = await isRemoteDir(p)
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory (or unreachable): ${p}` })
          const local = ensureMirror(p, config.host, config.username, config.port, { alias: aliasOf(activeMachine()) })
          persistWorkspace(p)
          startAutoPush(local)
          return sendJson(res, 200, { ok: true, path: p, localMirror: local, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-pick',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          let outcome = null
          let via = 'service'
          const cap = await localPickCapability()
          if (cap && cap.kind === 'native' && typeof cap.pick === 'function') {
            try {
              const pickAbort = new AbortController()
              const p = await Promise.resolve(cap.pick(pickAbort.signal || null))
              pickAbort.abort()
              outcome = (typeof p === 'string' && p) ? { path: p } : { cancelled: true }
            } catch (err) {
              outcome = null
            }
          }
          // Prefer a REAL OS dialog over the browse backend: operators expect
          // an Explorer-style chooser, and the own spawn (PowerShell
          // FolderBrowserDialog / osascript / zenity-kdialog) works even where
          // the host mounted browse — DSH Desktop (Electron) deliberately
          // mounts browse on win32 because the native backend's koffi dialog
          // worker cannot run under Electron, but a plain child process can.
          if (!outcome) {
            via = 'own'
            try {
              outcome = await pickLocalNative()
            } catch (err) {
              // No usable OS dialog (headless host, missing chooser binary):
              // fall back to the host's browse capability — fs-only, works
              // display-less — served as an in-app browser by the client
              // (backed by /dsh-remote/local-list + /dsh-remote/local-mkdir).
              if (cap && cap.kind === 'browse' && typeof cap.list === 'function') {
                return sendJson(res, 200, { ok: true, kind: 'browse', via: 'browse' })
              }
              return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) + ' — 可直接在输入框填本地路径' })
            }
          }
          if (outcome.cancelled) return sendJson(res, 200, { ok: true, cancelled: true, via })
          return sendJson(res, 200, { ok: true, path: outcome.path, via })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-list',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const cap = await localPickCapability()
          if (!cap || cap.kind !== 'browse' || typeof cap.list !== 'function') return sendJson(res, 400, { ok: false, error: '当前目录选择器不是浏览后端，无法列出本机目录' })
          const m = (req.url || '').match(/path=([^&]*)/)
          const raw = m ? decodeURIComponent(m[1]) : ''
          // No path → the browse backend lists the host home directory.
          try {
            const out = await Promise.resolve(cap.list(raw ? raw : undefined))
            return sendJson(res, 200, { ok: true, ...out, drives: listLocalDrives() })
          } catch (listErr) {
            return sendJson(res, 400, { ok: false, error: String((listErr && listErr.message) || listErr), code: (listErr && listErr.code) || 'directory-unreadable' })
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-mkdir',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const cap = await localPickCapability()
          if (!cap || cap.kind !== 'browse' || typeof cap.createDirectory !== 'function') return sendJson(res, 400, { ok: false, error: '当前目录选择器不是浏览后端，无法新建文件夹' })
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = String(payload.path || '')
          const name = String(payload.name || '')
          if (!p.trim() || !name.trim()) return sendJson(res, 400, { ok: false, error: 'path and name required' })
          try {
            const created = await Promise.resolve(cap.createDirectory(p, name))
            return sendJson(res, 200, { ok: true, path: created })
          } catch (mkErr) {
            return sendJson(res, 400, { ok: false, error: String((mkErr && mkErr.message) || mkErr), code: (mkErr && mkErr.code) || 'directory-create-failed' })
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/machines',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          return sendJson(res, 200, { machines: machinesForClient(), currentId: store.currentId })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const action = body.action || 'add'
            let warning = ''
            let warningDetail = ''
            if (action === 'add' || action === 'update') {
              const host = String(body.host || '').trim()
              if (!host) return sendJson(res, 400, { ok: false, error: 'host required' })
              const id = body.id || machineId()
              const i = machineIndex(id)
              const prev = i >= 0 ? machines[i] : null
              const credBackend = body.credentialBackend === 'plain' ? 'plain'
                : (body.encryptPassword ? platformBackend() : (prev && prev.credentialBackend ? prev.credentialBackend : 'plain'))
              const rec = {
                id,
                name: String(body.name || '').trim() || host,
                host,
                // Issue #38: an ALIAS machine stores only the Host line of
                // ~/.ssh/config — HostName/user/port/key are resolved live at
                // every connect instead of being copied into the registry.
                useSshConfig: !!body.useSshConfig,
                port: Number(body.port) || 22,
                username: String(body.username || '').trim() || 'root',
                password: '',
                privateKeyPath: String(body.privateKeyPath || '').trim(),
                passphrase: body.passphrase || '',
                workspace: String(body.workspace || '').trim(),
                hostKeyMode: body.hostKeyMode || '',
                useAgent: !!body.useAgent,
                keyboardInteractive: !!body.keyboardInteractive,
                proxy: body.proxy && body.proxy.host ? {
                  host: String(body.proxy.host),
                  port: Number(body.proxy.port) || 22,
                  username: String(body.proxy.username || '').trim(),
                  password: String(body.proxy.password || ''),
                  privateKeyPath: String(body.proxy.privateKeyPath || '').trim(),
                } : undefined,
                credentialBackend: credBackend,
                recentWorkspaces: prev && prev.recentWorkspaces ? prev.recentWorkspaces : [],
                lastConnectedAt: prev && prev.lastConnectedAt ? prev.lastConnectedAt : null,
                latencyMs: prev && prev.latencyMs ? prev.latencyMs : null,
              }
              if (body.password) {
                // Issue #30: `saveSecret()` is best-effort — the old code threw
                // its result away and kept `password: ''`, so on Windows (DPAPI
                // missing the System.Security assembly) the machine was saved
                // WITHOUT any credential and every later connect failed with no
                // visible reason. Now a failed OS-store write falls back to
                // plaintext and is reported to the UI.
                const persisted = await persistPassword({
                  backend: credBackend,
                  machineId: id,
                  password: body.password,
                  secretsDir: secretsDir(),
                })
                rec.credentialBackend = persisted.credentialBackend
                rec.password = persisted.password
                if (persisted.warning) {
                  warning = persisted.warning
                  warningDetail = persisted.error
                }
              } else if (prev && prev.password) {
                rec.password = prev.password
              }
              if (i >= 0) machines[i] = rec; else machines.push(rec)
              // Issue #13: saving a machine must NOT make it the active
              // remote context. `currentId` stays untouched on add/update —
              // only an explicit "设为当前" (or rw_connect) activates one.
              // keepCurrentKey:false leaves the stored `currentId` byte-for-byte
              // alone, so a fresh registry stays "no choice yet" (not an
              // explicit none) and a previously-cleared registry stays cleared.
              saveMachines(machines, store.currentId, false)
              return sendJson(res, 200, {
                ok: true,
                machine: sanitizeMachine(rec),
                machines: machinesForClient(),
                currentId: store.currentId,
                ...(warning ? { warning, warningDetail } : {}),
              })
            }
            if (action === 'delete') {
              const i = machineIndex(String(body.id || ''))
              if (i < 0) return sendJson(res, 404, { ok: false, error: 'machine not found' })
              const m = machines[i]
              if (m.credentialBackend && m.credentialBackend !== 'plain') {
                await deleteSecret(m.id, secretsDir()).catch(() => {})
              }
              machines.splice(i, 1)
              const wasCurrent = store.currentId === m.id
              if (wasCurrent) {
                // Issue #13: deleting the current machine leaves NO active
                // remote context (never auto-promote a sibling — that would
                // make an unrelated machine leak into the session again).
                store.currentId = null
                saveMachines(machines, null)
                await clearActiveMachine()
              } else {
                saveMachines(machines, store.currentId)
              }
              return sendJson(res, 200, { ok: true, machines: machinesForClient(), currentId: store.currentId })
            }
            return sendJson(res, 400, { ok: false, error: 'unknown action' })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/test-connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // Issue #30: `body` lives OUTSIDE the try — a try-scoped `const` is
        // invisible in catch, so the old catch threw `ReferenceError: body is
        // not defined` and the probe result never reached the UI (the webserver
        // answered with an empty 400 for every kind of failure). This route is a
        // probe: every outcome is a 200 carrying {ok:false, error}.
        let body = {}
        try {
          body = parseJsonObject(await readBody(req))
          // Issue #38: "test" on an ssh-config ALIAS resolves the alias first —
          // the form holds the alias name, not the host it points at.
          const aliasTarget = body.useSshConfig
            ? resolveMachineSshConfig({
                host: String(body.host || ''),
                port: Number(body.port) || 22,
                username: String(body.username || ''),
                privateKeyPath: String(body.privateKeyPath || ''),
                proxy: body.proxy,
                useSshConfig: true,
              }, { text: sshConfigText() })
            : null
          const probe = new SshPool({
            ...config,
            host: aliasTarget ? aliasTarget.host : String(body.host || config.host),
            port: aliasTarget ? aliasTarget.port : (Number(body.port) || config.port),
            username: aliasTarget ? aliasTarget.username : String(body.username || config.username),
            password: String(body.password || ''),
            privateKeyPath: aliasTarget ? aliasTarget.privateKeyPath : String(body.privateKeyPath || config.privateKeyPath),
            passphrase: String(body.passphrase || ''),
            proxy: aliasTarget && aliasTarget.proxy ? aliasTarget.proxy : (body.proxy && body.proxy.host ? {
              host: String(body.proxy.host),
              port: Number(body.proxy.port) || 22,
              username: String(body.proxy.username || ''),
              password: String(body.proxy.password || ''),
              privateKeyPath: String(body.proxy.privateKeyPath || ''),
            } : undefined),
            connectTimeoutMs: Math.min(Math.max(Number(body.connectTimeoutMs) || config.connectTimeoutMs, 2000), 30000),
            commandTimeoutMs: 10000,
          }, { knownHostsFile })
          const started = Date.now()
          await probe.connect()
          await probe.exec('true', { timeoutMs: 10000 })
          probe.close()
          const latencyMs = Date.now() - started
          // Alias-aware: the probe connects to the RESOLVED host, while the
          // registry stores the alias, so matching must go through the identity.
          const mi = machines.findIndex((m) => identityMatches(m, { host: probe.config.host, port: probe.config.port, username: probe.config.username }))
          if (mi >= 0) {
            machines[mi].lastConnectedAt = new Date().toISOString()
            machines[mi].latencyMs = latencyMs
            saveMachines(machines, store.currentId)
          }
          return sendJson(res, 200, {
            ok: true,
            host: probe.config.host,
            user: probe.config.username,
            latencyMs,
            lastConnectedAt: new Date().toISOString(),
            platform: probe.platform,
            shell: probe.shellMode,
            gitBash: probe.gitBashPath || '',
            // Issue #38: tell the settings page where an alias resolved to (and
            // anything the plugin could not honour, e.g. a multi-hop ProxyJump).
            alias: aliasTarget ? { name: aliasTarget.alias, host: aliasTarget.host, port: aliasTarget.port, user: aliasTarget.username, warnings: aliasTarget.warnings } : null,
          })
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: friendlyMessage(err, { host: body.host, port: body.port }) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/current',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const id = String(body.id || '').trim()
          // Issue #13: an empty id is an explicit "active remote = none" —
          // saved machines stay in the registry but nothing is current.
          if (!id) {
            await setCurrent('')
            return sendJson(res, 200, { ok: true, currentId: null, ...status() })
          }
          const okSet = await setCurrent(id)
          if (!okSet) return sendJson(res, 404, { ok: false, error: 'machine not found' })
          return sendJson(res, 200, { ok: true, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/forget-key',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        createHostKeyGuard(config, knownHostsFile()).forgetHost()
        return sendJson(res, 200, { ok: true, ...status() })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/forwards',
      handler: async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { forwards: forwards.list() })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const action = String(body.action || '')
          if (action === 'define') {
            const d = forwards.define({
              direction: body.direction === 'reverse' ? 'reverse' : 'local',
              listenPort: Number(body.listenPort),
              targetHost: body.targetHost || '127.0.0.1',
              targetPort: Number(body.targetPort) || Number(body.listenPort),
              autoStart: !!body.autoStart,
              machineId: store.currentId,
            })
            return sendJson(res, 200, { ok: true, forward: d, forwards: forwards.list() })
          }
          if (action === 'start' || action === 'stop') {
            const d = forwards.list().find((f) => f.id === body.id)
            if (!d) return sendJson(res, 404, { ok: false, error: 'forward not found' })
            if (action === 'start') {
              const r = await forwards.start(d)
              if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error })
            } else {
              forwards.stop(d.id)
            }
            return sendJson(res, 200, { ok: true, forwards: forwards.list() })
          }
          if (action === 'remove') {
            forwards.remove(String(body.id || ''))
            return sendJson(res, 200, { ok: true, forwards: forwards.list() })
          }
          return sendJson(res, 400, { ok: false, error: 'unknown action' })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/task',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const q = new URL(req.url, 'http://localhost').searchParams
          const id = q.get('id') || ''
          const t = tasks.get(id)
          if (!t) return sendJson(res, 404, { ok: false, error: 'task not found' })
          return sendJson(res, 200, { ok: true, task: t })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const id = String(body.id || '')
            if (body.action === 'cancel') {
              const ok = tasks.cancel(id)
              return sendJson(res, 200, { ok, task: tasks.get(id) })
            }
            return sendJson(res, 400, { ok: false, error: 'unknown action' })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/tasks',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendJson(res, 200, { ok: true, tasks: tasks.list() })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/audit',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        const q = new URL(req.url, 'http://localhost').searchParams
        return sendJson(res, 200, { ok: true, auditEnabled: !!config.auditLog, file: auditFile(), lines: readAudit(q.get('limit')) })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/ssh-config',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const text = readSshConfigText()
          return sendJson(res, 200, { ok: true, file: sshConfigPath(), present: !!text, entries: importableEntries(text) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/web-attach',
      // Issue #46: open/reuse/close a tunnel to a remote machine's DSH Web UI.
      // Actions: status (GET) | open | close. `open` either starts a remote
      // `dsh web` (default) or attaches to one the user already runs by passing
      // its `http://127.0.0.1:<port>/?token=…` URL.
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const q = new URL(req.url, 'http://localhost').searchParams
            const id = q.get('machineId') || ''
            const attach = id ? webAttaches.get(id) : undefined
            // Deploy tasks ride along so a REOPENED window sees an in-flight
            // install immediately, without a separate poll's first tick.
            const deploy = id ? deployTasks.forMachine(id) : null
            return sendJson(res, 200, {
              ok: true,
              attach: attach ? attach.describe() : null,
              attaches: [...webAttaches.values()].map((a) => a.describe()),
              deploys: deployTasks.list(),
              deploy: deploy ? deployTasks.describe(deploy) : null,
            })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          const body = parseJsonObject(await readBody(req))
          const action = String(body.action || '')
          const machineId = String(body.machineId || store.currentId || '').trim()
          if (!machineId) return sendJson(res, 400, { ok: false, error: '选择一台机器后再操作（missing machineId）' })

          // ── deploy: probe (read-only) and install (private prefix) ─────────
          // Issue #46 follow-up. Detection and installation are deterministic, so
          // they are code rather than a model call: fast, free, unit-testable.
          // The AI path (a built-in skill) is offered only when this cannot cope.
          if (action === 'probe' || action === 'install') {
            const machine = machines.find((m) => m.id === machineId)
            if (!machine) return sendJson(res, 404, { ok: false, error: `机器不存在：${machineId}` })
            const target = poolForMachine(identityOf(machine))
            // The command that deployment produced FOR THIS MACHINE wins over any
            // global default — otherwise a deployment on one host would be
            // forgotten on the very next probe.
            const installedCommand = String(machine.webAttachCommand || '').trim()
            const prefix = resolvePrefix({ home: '' }, { prefix: config.webInstallPrefix || '' })

            if (action === 'probe') {
              // Strictly read-only: this runs before the user has agreed to any
              // change, and may be run on a machine they are merely looking at.
              const out = await target.exec(buildProbeCommand({ prefix, installedCommand, defaultPrefixFor: config.webInstallPrefix ? '' : 'home' }), { timeoutMs: 30000 })
              const facts = parseProbe(out && out.stdout)
              const verdict = judgeProbe(facts, { installedCommand })
              // The prefix we judged writability against was a guess (empty
              // $HOME); now that the probe reported the real home, re-resolve so
              // the prefix shown matches what an install would actually use.
              const realPrefix = facts.resolvedPrefix || resolvePrefix(facts, { prefix: config.webInstallPrefix || '' })
              audit('web-deploy', `probe ${machine.host}: ${verdict.severity}`, verdict.ok ? 0 : 1, machine)
              return sendJson(res, 200, {
                ok: true,
                facts,
                verdict,
                prefix: realPrefix,
                command: webAttachCommandFor(machine),
                installVersion: config.webInstallVersion || DEFAULT_INSTALL_VERSION,
                registry: config.webInstallRegistry || '',
              })
            }

            // install — runs as a HOST-SIDE BACKGROUND TASK.
            //
            // It used to be one long HTTP request; npm can legitimately take
            // minutes, and closing the tab mid-deploy lost the response AND
            // every trace of the progress — the user could not tell whether it
            // succeeded, and a second click started a CONCURRENT npm install
            // into the same prefix. Now the work runs detached from the request
            // lifecycle, every step's outcome is recorded as it happens, and
            // the UI re-attaches by polling install-status (or by clicking the
            // button again, which resumes rather than restarts).
            if (body.confirm !== true) {
              return sendJson(res, 400, { ok: false, error: '安装需要在请求里显式 confirm: true' })
            }
            // RESUME: a running/queued task for this machine is returned as-is.
            // One deploy per machine at a time — two concurrent `npm --prefix`
            // into the same directory corrupt the tree.
            const already = deployTasks.forMachine(machineId)
            if (already && (already.status === 'queued' || already.status === 'running') && body.force !== true) {
              return sendJson(res, 200, { ok: true, resumed: true, task: deployTasks.describe(already) })
            }
            if (already && body.force !== true && already.status !== 'done' && already.status !== 'failed' && already.status !== 'cancelled') {
              return sendJson(res, 200, { ok: true, resumed: true, task: deployTasks.describe(already) })
            }
            const { task } = deployTasks.start(machineId, `deploy ${machine.host}`, async (ctx) => {
              // Everything below is the SAME plan as before, but progress goes
              // to the task (visible while it runs) instead of one response.
              const pout = await target.exec(buildProbeCommand({ prefix, installedCommand, defaultPrefixFor: config.webInstallPrefix ? '' : 'home' }), { timeoutMs: 30000 })
              const facts = parseProbe(pout && pout.stdout)
              const verdict = judgeProbe(facts, { installedCommand })
              if (!verdict.canAutoInstall) {
                const why = verdict.findings.filter((x) => x.severity === 'blocker').map((x) => x.summary).join('；')
                audit('web-deploy', `install ${machine.host} refused: ${why}`, 1, machine)
                throw new Error(`无法自动安装：${why || '远端缺少前提条件'}`)
              }
              const installPrefix = facts.resolvedPrefix || resolvePrefix(facts, { prefix: config.webInstallPrefix || '' })
              // A registry the user set explicitly wins; otherwise the remote's
              // own npm config is left alone (internal mirrors keep working).
              const registry = String(body.registry || config.webInstallRegistry || '').trim()
              const env = body.proxy && typeof body.proxy === 'object'
                ? Object.fromEntries(Object.entries(body.proxy).filter(([, v]) => typeof v === 'string'))
                : undefined
              const plan = buildInstallPlan({
                facts,
                prefix: installPrefix,
                version: String(body.version || config.webInstallVersion || DEFAULT_INSTALL_VERSION),
                registry,
                env,
              })
              ctx.progress({ totalSteps: plan.steps.length, prefix: installPrefix })
              const results = []
              for (const step of plan.steps) {
                if (ctx.cancelled) break
                task.current = step.title
                ctx.progress({ doneSteps: results.length })
                let res2
                try {
                  res2 = await target.exec(step.command, {
                    timeoutMs: step.timeoutMs || 120000,
                    ...(step.env ? { env: step.env } : {}),
                  })
                } catch (err) {
                  results.push({ id: step.id, title: step.title, ok: false, code: -1, output: String((err && err.message) || err) })
                  break
                }
                const r = stepResult(step, res2)
                results.push(r)
                task.steps = [...results]
                if (!r.ok) break
              }
              task.steps = [...results]
              const ok = results.length === plan.steps.length && results.every((r) => r.ok)
              if (ok) {
                // Persist so the attach flow uses the working build from now on.
                persistWebAttachCommand(machine, plan.command)
                audit('web-deploy', `install ${machine.host} → ${plan.command}`, 0, machine)
                return { ok: true, steps: results, command: plan.command, prefix: installPrefix }
              }
              const failed = results.find((r) => !r.ok)
              audit('web-deploy', `install ${machine.host} failed at ${failed && failed.id}`, 1, machine)
              const looksNetworky = /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network|proxy|403|404/i.test(String(failed && failed.output))
              const err = new Error(`安装失败于「${failed ? failed.title : '未知步骤'}」`)
              err.detail = {
                steps: results,
                prefix: installPrefix,
                suggestInvestigate: true,
                ...(looksNetworky ? { hint: '看起来是网络或源的问题，可以让 AI 排查。' } : {}),
              }
              throw err
            })
            // Answer immediately: the task object IS the handle the UI polls.
            return sendJson(res, 200, { ok: true, started: true, task: deployTasks.describe(task) })
          }

          // install-status: re-attach to a deploy at ANY time (window reopened,
          // page refreshed). Also carried by GET /dsh-remote/web-attach.
          if (action === 'install-status') {
            const t = deployTasks.forMachine(machineId)
            if (!t) return sendJson(res, 200, { ok: true, task: null })
            return sendJson(res, 200, { ok: true, task: deployTasks.describe(t) })
          }

          // install-cancel: cooperative cancel between steps.
          if (action === 'install-cancel') {
            const t = deployTasks.forMachine(machineId)
            if (!t) return sendJson(res, 200, { ok: true, cancelled: false })
            const did = deployTasks.cancel(machineId)
            return sendJson(res, 200, { ok: true, cancelled: did, task: deployTasks.describe(t) })
          }

          if (action === 'open') {
            // Reuse a live tunnel for this machine: re-opening would start a
            // second remote DSH and leak the first one's process.
            const live = webAttaches.get(machineId)
            if (live && live.active) return sendJson(res, 200, { ok: true, attach: live.describe(), reused: true })
            // A tunnel that is no longer listening still owns sockets and a log
            // path; release it before this machine gets a fresh session. Its
            // remote process is left alone — stopping it stays an explicit act.
            if (live) { try { await live.close() } catch { /* already torn down */ } }
            const machine = machines.find((m) => m.id === machineId)
            if (!machine) return sendJson(res, 404, { ok: false, error: `机器不存在：${machineId}` })
            const attach = new WebAttach({
              localPortStart: config.webAttachPortStart,
            })
            try {
              await attach.open({
                pool: poolForMachine(identityOf(machine)),
                machineId,
                command: String(body.command || '').trim() || webAttachCommandFor(machine),
                profile: 'web',
                existingUrl: String(body.existingUrl || ''),
                dshHome: config.webAttachDshHome || '',
                waitSeconds: config.webAttachWaitSeconds,
              })
            } catch (err) {
              try { await attach.close() } catch { /* nothing was listening */ }
              const msg = String((err && err.message) || err)
              audit('web-attach', `open ${machine.host} failed: ${msg}`, 1, machine)
              return sendJson(res, 500, { ok: false, error: msg })
            }
            webAttaches.set(machineId, attach)
            audit('web-attach', `open ${machine.host} → 127.0.0.1:${attach.localPort}`, 0, machine)
            return sendJson(res, 200, { ok: true, attach: attach.describe() })
          }

          // ── investigate: hand the problem to an agent with the built-in skill ──
          // The AI escape hatch. Started ONLY when the user asks for it: it costs
          // a model call, so it is never automatic — the deterministic probe and
          // install are the default path.
          if (action === 'investigate') {
            const machine = machines.find((m) => m.id === machineId)
            if (!machine) return sendJson(res, 404, { ok: false, error: `机器不存在：${machineId}` })
            const controller = ctx.get('sessionController')
            if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
              return sendJson(res, 400, {
                ok: false,
                error: '当前组合没有会话服务（sessionController），无法让 AI 排查。'
                  + '请改用「部署并验证」，或把排查信息复制到对话里。',
              })
            }
            const sessionId = `dsh-remote-deploy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
            try {
              await controller.create({ sessionId, cwd: undefined })
            } catch (err) {
              // An id collision is the only tolerable failure here.
              if (!/conflict|exist/i.test(String((err && err.message) || err))) {
                return sendJson(res, 500, { ok: false, error: `创建排查会话失败：${String((err && err.message) || err)}` })
              }
            }
            const prompt = buildInvestigatePrompt({
              host: machine.host,
              user: machine.username,
              prefix: resolvePrefix({ home: '' }, { prefix: config.webInstallPrefix || '' }),
              findings: Array.isArray(body.findings) ? body.findings : [],
              facts: body.facts && typeof body.facts === 'object' ? body.facts : undefined,
              error: String(body.error || ''),
            })
            try {
              await controller.prompt({
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: prompt }],
              })
            } catch (err) {
              return sendJson(res, 500, { ok: false, error: `提交排查任务失败：${String((err && err.message) || err)}` })
            }
            audit('web-deploy', `investigate ${machine.host} → session ${sessionId}`, 0, machine)
            return sendJson(res, 200, { ok: true, sessionId, skill: SKILL_NAME })
          }

          if (action === 'close') {
            const attach = webAttaches.get(machineId)
            if (!attach) return sendJson(res, 200, { ok: true, closed: false, error: '该机器没有活动的远程界面' })
            const stopRemote = body.stopRemote === true
            // `close()` refuses to signal anything without a recorded PID, so a
            // tunnel onto the user's own running instance stays hands-off.
            const exec = (cmd) => poolForMachine(identityOf(machines.find((m) => m.id === machineId) || {})).exec(cmd, { timeoutMs: 10000 })
            await attach.close({ stopRemote, exec })
            webAttaches.delete(machineId)
            audit('web-attach', `close ${attach.cleanUrl}${stopRemote ? ' (remote stopped)' : ''}`, 0)
            return sendJson(res, 200, { ok: true, closed: true, stoppedRemote: stopRemote && !!attach.remotePid })
          }

          return sendJson(res, 400, { ok: false, error: 'action must be open | close' })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/home',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = parseJsonObject(await readBody(req))
          // The picker names the machine it is showing: re-assert it before
          // answering, so a switch made elsewhere cannot make /home describe a
          // different host than the tree the user is looking at.
          if (!(await applyRequestedMachine(body, res))) return
          const out = await pool.exec('echo ~', { timeoutMs: Math.min(config.commandTimeoutMs, 5000) })
          const home = String(out.stdout || '').replace(/\s+/g, '').trim()
          if (!home) return sendJson(res, 200, { ok: true, home: null, hint: 'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径' })
          return sendJson(res, 200, { ok: true, home })
        } catch (err) {
          return sendJson(res, 200, { ok: true, home: null, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-check',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // `loaded` is the code actually running; `disk` may already be newer.
        // They differ between an applied update and its hot swap (or a boot).
        const loaded = LOADED_VERSION
        const disk = diskVersion()
        // Three-layer precedence: the persisted `update-mode` override (settings
        // UI) beats the profile config, which beats DEFAULT_UPDATE_MODE. The
        // fallback must not hard-code a second default here, or this path would
        // silently disagree with the schema default.
        const rawMode = readUpdateMode() || config.updateMode || DEFAULT_UPDATE_MODE
        const base = {
          current: loaded,
          loaded,
          disk,
          pendingReload: gtVersion(disk, loaded),
          updateMode: ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : DEFAULT_UPDATE_MODE,
          updatedMarker: existsSync(path.join(selfDir(), '.dsh-remote-updated')),
          // Exposed so the settings page can explain why `auto` may not act:
          // a link:/dev install must not be overwritten by an npm publish.
          selfUpdateAllowed: isInstalledCopy(),
          // Outcome of the last hot-swap attempt (null if never tried). Without
          // this the swap could fail forever while the panel kept saying a
          // reload was merely pending — which is exactly what happened.
          lastReload: lastSelfReload(),
        }
        const probe = await fetchLatestVersion()
        // 即使查不到最新版，也把**本地状态**照常返回（ok:true），只把 registry
        // 的失败原因放在 registryError 里。
        //
        // 为什么：原先 registry 失败时整条响应 ok:false，客户端遇到 !ok 就只设错误
        // 文案、不 setUpd，于是面板永远停在「版本信息加载中…」——看起来像卡死，
        // 而实际上本地版本、更新模式、是否允许自更新都是已知的，完全可以展示。
        if (probe.error) {
          return sendJson(res, 200, { ok: true, ...base, latest: null, updateAvailable: false, registryError: probe.error, registryReason: probe.reason })
        }
        return sendJson(res, 200, {
          ok: true,
          ...base,
          latest: probe.version,
          updateAvailable: gtVersion(probe.version, loaded),
        })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-apply',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          // Capture the outgoing version BEFORE the swap: reading it afterwards
          // reports the version we just installed, not the one we replaced.
          const from = diskVersion()
          const loaded = LOADED_VERSION
          const body = JSON.parse((await readBody(req)) || '{}')
          const target = String(body.version || '')
          if (!target) return sendJson(res, 400, { ok: false, error: 'version is required' })
          const result = await applyUpdate(target)
          const wantReload = body.reload !== false && config.updateAutoReload !== false
          // Answer first, then swap: the swap disposes the fiber serving this
          // very request, so nothing may touch the plugin after it.
          if (wantReload) scheduleSelfReload(ctx.loader, 300)
          return sendJson(res, 200, {
            ok: true,
            from,
            loadedBefore: loaded,
            ...result,
            reloadScheduled: wantReload,
            // what the swap will land on, for a caller that wants to verify
            loadedAfterReload: wantReload ? result.to : loaded,
          })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-reload',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // Hot-swap the host half to whatever is on disk now. Answers first (with
        // what was loaded and what it is about to become), then swaps.
        const loaded = LOADED_VERSION
        const disk = diskVersion()
        scheduleSelfReload(ctx.loader, 300)
        return sendJson(res, 200, { ok: true, scheduled: true, loaded, disk, willReloadTo: disk })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-mode',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const mode = String(body.mode || '')
          if (!['manual', 'auto', 'off'].includes(mode)) return sendJson(res, 400, { ok: false, error: 'mode must be manual | auto | off' })
          if (!persistUpdateMode(mode)) return sendJson(res, 500, { ok: false, error: 'cannot persist mode' })
          return sendJson(res, 200, { ok: true, mode })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]

  registerHttpTransports(ctx, routes)

  // ── built-in deployment skill (issue #46 P3) ──────────────────────────────
  // Registered at runtime so the plugin stays a single self-contained package
  // (no writable $DSH_HOME/skills, no collision with the user's own skills).
  // Optional: a composition without `ctx.skills` keeps the deterministic deploy
  // path and merely loses the AI fallback.
  ctx.inject(['skills'], (skillCtx) => {
    registerDeploySkill(skillCtx)
  })

  // ── auto-update: check on load + on an interval; apply silently ───────────
  // Failures are swallowed (never break the plugin). The persisted override
  // (settings UI) wins over the profile-config default, which wins over
  // DEFAULT_UPDATE_MODE — the single source of truth for the fallback.
  const rawMode = readUpdateMode() || config.updateMode || DEFAULT_UPDATE_MODE
  const effectiveUpdateMode = ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : DEFAULT_UPDATE_MODE
  if (effectiveUpdateMode === 'auto') {
    // 限流/网络失败后的退避：命中后跳过接下来若干轮检查，避免在被 npm 限流
    // （HTTP 429）时反复重试把配额烧得更久。指数增长，上限 24 轮（配合默认
    // 6h 间隔即最多约 6 天，足以让限流窗口滑过且不会永久停摆）。
    let backoffRounds = 0
    const checkAndApply = async () => {
      if (backoffRounds > 0) { backoffRounds -= 1; return }
      const probe = await fetchLatestVersion()
      if (probe.error) {
        // 限流与网络故障都要退避；成功一次即重置。
        backoffRounds = Math.min(backoffRounds === 0 ? 1 : backoffRounds * 2, 24)
        return
      }
      backoffRounds = 0
      const latest = probe.version
      // The version in flight is whichever of "already on disk" / "already
      // loaded" is newer. Pinning it once outside this closure (as v0.8.23 did)
      // made every later interval re-download and re-apply the same tarball,
      // because the pinned value never moves past the version it installed.
      const disk = diskVersion()
      const current = gtVersion(disk, LOADED_VERSION) ? disk : LOADED_VERSION
      if (!gtVersion(latest, current)) return
      try {
        await applyUpdate(latest)
      } catch {
        // 常见且预期的失败：link:/开发模式安装时 applyUpdate 会拒绝
        // （避免覆盖源码仓库）。这不是异常，静默即可——那类用户在自己的
        // 仓库里更新。
        return
      }
      // Landed: swap the running host half too, otherwise the code being served
      // and the code being run stay one version apart until the next boot.
      if (config.updateAutoReload !== false) scheduleSelfReload(ctx.loader, 500)
    }
    void checkAndApply()
    const updateTimer = setInterval(checkAndApply, Math.max(config.updateCheckIntervalMs, 60000))
    if (typeof updateTimer.unref === 'function') updateTimer.unref()
    ctx.effect(() => () => clearInterval(updateTimer), 'dsh-remote.update-timer')
  }
}
