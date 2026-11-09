// Host-side in-process API for OTHER plugins (the TUI layer), exposed as
// `ctx.dshRemote` from `apply()`.
//
// Why a service instead of a second implementation:
//   Every mutable piece of dsh-remote state (the active pool, the per-machine
//   pools, the in-memory `machines` snapshot, `currentId`, the workspace
//   mirror, forwards/terminals) lives inside `apply()`'s closure. A consumer
//   that re-read `machines.json` or dialled its own SSH pool would hold a stale
//   registry snapshot, open a second TCP connection per host, and race
//   `saveMachines()`'s whole-file rewrite against this one. `createHostApi()`
//   therefore takes those closure functions as `deps` and only reshapes their
//   results — it never imports cordis, never opens a pool and never touches
//   the registry file.
//
// Contract (docs/tui.md §3, `apiVersion: 1`):
//   · every method is async and returns PURE DATA (no pool / client / sftp
//     handles, no passwords, no passphrases);
//   · failures THROW one `Error` carrying a semantic `.code`; they never return
//     `{ok:false}` (a caller's `if (res.ok)` would swallow the reason);
//   · `error.message` is already the user-facing Chinese sentence
//     (`friendlyMessage` from lib/errors.js, idempotent);
//   · the API has its own tiny emitter: an event fires after THIS object's
//     mutations. It deliberately does not splice itself into the SSH pool's
//     single-slot `onReady`/`onCloseHook` (the forwards manager owns those).
import { classifyError, friendlyMessage } from './errors.js'
import { joinRemotePath, normalizeRemotePath, remoteDirname, toDisplayPath, remoteWorkspaceTitle } from './paths.js'
import { listDirStructured, listRemoteDrives } from './remote-fs.js'
import {
  deleteMirrorTree,
  deleteSessionsFor,
  dirSizeBytes,
  listMirrorEntries,
  listSessionDirs,
  validateMirror,
} from './workspace-cleanup.js'


/** Contract version. Consumers check `api.apiVersion === 1` before use. */
const API_VERSION = 1

/** Error codes the contract allows (`docs/tui.md` §3). */
const API_CODES = new Set([
  'MACHINE_NOT_FOUND',
  'NO_ACTIVE_MACHINE',
  'NOT_A_DIRECTORY',
  'AUTH',
  'CREDENTIALS',
  'HOSTKEY',
  'NETWORK',
  'TIMEOUT',
  'SFTP',
  'UNSUPPORTED',
  'LOCAL_SESSION',
  'VALIDATION',
  'WORKSPACE_BUSY',
  'INTERNAL',
])

/** One coded error. `extra` carries optional machine identity (`host`/`port`)
 *  so a UI can point at the failing row. */
function apiError(code, message, extra = {}) {
  const err = new Error(message)
  err.code = API_CODES.has(code) ? code : 'INTERNAL'
  if (extra && typeof extra === 'object') Object.assign(err, extra)
  return err
}

/** Map whatever a dep throws onto the contract's error vocabulary.
 *
 *  Coded errors thrown by lib/index.js deps (and by this module) pass through
 *  untouched; HTTP-layer codes (`httpStatus`) are translated, because the
 *  same closures answer the web routes; everything else is classified with
 *  lib/errors.js, which is what makes `AUTH` / `NETWORK` / `HOSTKEY` /
 *  `TIMEOUT` / `SFTP` / `CREDENTIALS` actionable instead of `INTERNAL`. */
function asApiError(err, opts = {}) {
  if (!err) return apiError('INTERNAL', 'unknown error')
  if (err.code && API_CODES.has(err.code)) return err
  const status = Number(err.httpStatus) || 0
  if (status === 400 || err.code === 'HOST_REQUIRED') {
    // The route layer throws English strings (`host required`); the contract
    // promises a user-facing Chinese sentence, so translate the known one and
    // prefix the rest rather than leaking raw English into the TUI footer.
    const raw = String(err.message || err)
    const message = err.code === 'HOST_REQUIRED' ? '缺少主机地址（host 必填）' : `请求参数不可用：${raw}`
    return apiError('VALIDATION', message)
  }
  if (status === 404) return apiError('MACHINE_NOT_FOUND', friendlyMessage(err, opts))
  if (status === 403) return apiError('LOCAL_SESSION', String(err.message || err))
  if (status === 409) return apiError('NO_ACTIVE_MACHINE', String(err.message || err))
  const category = classifyError(err, opts).category
  const map = {
    auth: 'AUTH',
    network: 'NETWORK',
    hostkey: 'HOSTKEY',
    timeout: 'TIMEOUT',
    sftp: 'SFTP',
    credentials: 'CREDENTIALS',
  }
  const code = map[category] || 'INTERNAL'
  const out = apiError(code, friendlyMessage(err, opts), {
    host: err.host != null ? err.host : opts.host,
    port: err.port != null ? err.port : opts.port,
    cause: err,
  })
  return out
}

/** Defensive secret strip for anything that leaves this module.
 *
 *  The deps hand back views the web settings page already receives
 *  (`sanitizeMachine` — password/passphrase replaced by booleans), so this is
 *  a belt-and-braces pass: a future field added to the record must not leak
 *  through the in-process API by accident. It also makes the promise
 *  "no secret ever leaves" testable by seeding a fake deps that returns the
 *  raw record.
 *
 *  @param {*} value - plain data from a dep.
 *  @returns {*} a deep copy with `password` / `passphrase` keys removed.
 */
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (k === 'password' || k === 'passphrase') continue
      out[k] = scrub(v)
    }
    return out
  }
  return value
}

/** The Status shape the TUI contract names (`machineId`), derived from the
 *  host's own snapshot (`currentId`). Pure data either way. */
function asStatus(snapshot) {
  const s = (snapshot && typeof snapshot === 'object') ? { ...snapshot } : {}
  return { ...scrub(s), machineId: s.currentId == null ? null : String(s.currentId) }
}

/** Map the SFTP entry types lib/remote-fs.js produces onto the contract's
 *  four-value vocabulary. */
function publicEntryType(type) {
  if (type === 'dir') return 'dir'
  if (type === 'symlink' || type === 'link') return 'link'
  if (type === 'file') return 'file'
  return 'other'
}

/** Parent directory for a DirListing, or null for a filesystem root. */
function parentOf(p, platform) {
  const norm = normalizeRemotePath(p)
  if (norm === '/' || /^[a-zA-Z]:\\?$/.test(norm) || /^\\\\[^\\]+\\[^\\]+$/.test(norm)) return null
  return toDisplayPath(remoteDirname(norm), platform)
}

/**
 * Build the host API object.
 *
 * @param {object} deps - closure functions supplied by lib/index.js. Required
 *   keys (all throw `INTERNAL` here when missing, never at require time):
 *   · `listMachinesView()` → `{machines, currentId}` (sanitized views);
 *   · `upsertMachineRecord(body)` → `{machine, machines, currentId, warning?,
 *      warningDetail?, sshConfigWarning?}`; throws HOST_REQUIRED / coded errors;
 *   · `removeMachineRecord(id)` → `{machines, currentId}`; throws
 *      MACHINE_NOT_FOUND;
 *   · `setCurrentForApi(id|null)`; throws MACHINE_NOT_FOUND;
 *   · `connectMachine({machineId, persist})` → Status (throws classified);
 *   · `probeMachineRecord(body)` → ProbeResult (throws classified);
 *   · `statusSnapshot()` → Status snapshot;
 *   · `resolveDirBinding({machineId, sessionId, local})` → `{pool, ws, bound,
 *      machine}` (throws MACHINE_NOT_FOUND / NO_ACTIVE_MACHINE);
 *   · `listRemoteProjects()` → mirror registry entries (+machineId);
 *   · `revealMirrorFolderRecord()` → `{path}` (opens `remote-workspaces` in the file manager);
 *   · `resolveMachine(machineId?)` → `{record, machineId, name, host, port,
 *      username, alias}` (resolved connect identity);
 *   · `ensureMirror(remotePath, host, username, port, extra)` → local dir;
 *   · `registerMirroredWorkspace(localDir, remotePath, record)`;
 *   · `checkRemoteDir(remotePath, machineId?)` → boolean (SSH stat).
 * @returns {object} the `ctx.dshRemote` value.
 */
export function createHostApi(deps = {}) {
  const listeners = new Set()

  const need = (name) => {
    const fn = deps[name]
    if (typeof fn !== 'function') {
      throw apiError('INTERNAL', `dshRemote: host dependency "${name}" is missing`)
    }
    return fn
  }

  /** Fire one lifecycle event. Listener failures are contained: a broken TUI
   *  subscriber must never break a machine save. */
  const emit = (type) => {
    for (const listener of [...listeners]) {
      try { listener({ type }) } catch { /* subscriber is on its own */ }
    }
  }

  const status = async () => {
    const snapshot = await need('statusSnapshot')()
    return asStatus(snapshot)
  }

  /** Project the record layer's grouping fields onto the contract's `group`.
   *
   *  The registry has no `group` column: `normalizeMachineGroup()` writes
   *  `environment` / `location` / `description` / `tags` (lib/registry.js),
   *  and the Web settings page edits `environment` as the host's group label.
   *  The TUI form exposes ONE text field, so the contract's `group` is that
   *  `environment` value — without this projection the form would save into a
   *  field the host never persists.
   *
   *  @param {object} machine - a sanitized record view.
   *  @returns {object} the same view plus a string `group`.
   */
  const withGroup = (machine) => {
    if (!machine || typeof machine !== 'object') return machine
    const group = machine.group !== undefined && machine.group !== null
      ? machine.group
      : machine.environment
    return { ...machine, group: group == null ? '' : String(group) }
  }
  /** Inverse of {@link withGroup} for a write patch. */
  const withGroupPatch = (patch) => {
    const body = { ...patch }
    if (body.group !== undefined && body.environment === undefined) body.environment = body.group
    delete body.group
    return body
  }

  const listMachines = async () => {
    const view = await need('listMachinesView')()
    return {
      machines: scrub(Array.isArray(view && view.machines) ? view.machines : []).map(withGroup),
      currentId: view && view.currentId != null ? String(view.currentId) : null,
    }
  }

  const upsertMachine = async (patch = {}) => {
    const body = withGroupPatch({ ...(patch && typeof patch === 'object' ? patch : {}) })
    let result
    try {
      result = await need('upsertMachineRecord')(body)
    } catch (err) {
      throw asApiError(err, { host: body.host, port: body.port })
    }
    emit('machines')
    // Non-fatal problems the save could not throw for: the OS secure store
    // refused the password, or ~/.ssh/config already names this host with a
    // user-owned block. They are collected into one string list per contract.
    const warnings = []
    if (result && result.warning) {
      warnings.push(String(result.warningDetail ? `${result.warning}: ${result.warningDetail}` : result.warning))
    }
    if (result && result.sshConfigWarning) warnings.push(String(result.sshConfigWarning))
    return {
      machine: withGroup(scrub(result && result.machine)),
      machines: scrub(Array.isArray(result && result.machines) ? result.machines : []).map(withGroup),
      currentId: result && result.currentId != null ? String(result.currentId) : null,
      warnings,
    }
  }

  const removeMachine = async (id) => {
    let result
    try {
      result = await need('removeMachineRecord')(String(id == null ? '' : id))
    } catch (err) {
      throw asApiError(err)
    }
    emit('machines')
    emit('status')
    return {
      machines: scrub(Array.isArray(result && result.machines) ? result.machines : []).map(withGroup),
      currentId: result && result.currentId != null ? String(result.currentId) : null,
    }
  }

  const setCurrent = async (id) => {
    const clean = id == null || String(id).trim() === '' ? null : String(id).trim()
    try {
      await need('setCurrentForApi')(clean)
    } catch (err) {
      throw asApiError(err)
    }
    emit('status')
    return status()
  }

  const connect = async (opts = {}) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    let snapshot
    try {
      snapshot = await need('connectMachine')({
        machineId: o.machineId == null ? undefined : String(o.machineId),
        persist: o.persist !== false,
      })
    } catch (err) {
      throw asApiError(err)
    }
    emit('status')
    return asStatus(snapshot)
  }

  const probeMachine = async (patch = {}) => {
    const body = { ...(patch && typeof patch === 'object' ? patch : {}) }
    try {
      return await need('probeMachineRecord')(body)
    } catch (err) {
      throw asApiError(err, { host: body.host, port: body.port })
    }
  }

  /** Resolve which remote pool a listing should run against.
   *  Addressing priority (contract): machineId > the active machine. */
  const bindingForDir = async (opts = {}) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    try {
      return await need('resolveDirBinding')({
        machineId: o.machineId == null ? undefined : String(o.machineId),
        sessionId: o.sessionId == null ? undefined : String(o.sessionId),
        local: o.local == null ? undefined : String(o.local),
      })
    } catch (err) {
      throw asApiError(err)
    }
  }

  const listDir = async (opts = {}) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    const binding = await bindingForDir(o)
    const pool = binding && binding.pool
    if (!pool || typeof pool.detect !== 'function') {
      throw apiError('INTERNAL', 'dshRemote.listDir: no remote pool resolved')
    }
    const machine = {
      id: (binding.machine && binding.machine.id) || '',
      name: (binding.machine && binding.machine.name) || '',
      host: (binding.machine && binding.machine.host) || '',
      port: Number(binding.machine && binding.machine.port) || 22,
      username: (binding.machine && binding.machine.username) || '',
    }
    try {
      await pool.detect()
      const win = pool.platform === 'windows'
      const requested = o.path != null && String(o.path).trim() !== '' ? String(o.path) : (binding.ws || '')
      const canon = normalizeRemotePath(requested)
      // A Windows remote's filesystem root is a drive list, exactly like /ls.
      if (canon === '/' || canon === '') {
        if (win || pool.platform !== 'posix') {
          const drives = await listRemoteDrives(pool)
          if (drives.length) {
            return {
              path: '',
              parent: null,
              platform: 'windows',
              items: drives.map((d) => ({
                name: String(d.name || ''),
                path: String(d.path || ''),
                type: 'dir',
                size: 0,
                mtime: 0,
              })),
              machine,
            }
          }
        }
        if (win) return { path: '', parent: null, platform: 'windows', items: [], machine }
      }
      const sftp = await pool.sftp()
      const out = await listDirStructured(sftp, canon)
      const platform = win ? 'windows' : 'posix'
      return {
        path: toDisplayPath(out.path, pool.platform),
        parent: parentOf(out.path, pool.platform),
        platform,
        items: out.items.map((it) => ({
          name: String(it.name),
          path: toDisplayPath(joinRemotePath(canon, it.name), pool.platform),
          type: publicEntryType(it.type),
          size: typeof it.size === 'number' ? it.size : 0,
          mtime: typeof it.mtime === 'number' ? it.mtime : 0,
        })),
        machine,
      }
    } catch (err) {
      throw asApiError(err, { host: machine.host, port: machine.port })
    }
  }

  const listRemoteProjects = async () => {
    const projects = await need('listRemoteProjects')()
    return (Array.isArray(projects) ? projects : []).map((p) => ({
      dir: String((p && p.dir) || ''),
      host: String((p && p.host) || ''),
      port: Number(p && p.port) || 22,
      username: String((p && p.username) || ''),
      remotePath: String((p && p.remotePath) || ''),
      alias: String((p && p.alias) || ''),
      name: String((p && p.name) || ''),
      machineId: p && p.machineId != null ? String(p.machineId) : null,
    }))
  }

  /** Shared body of ensureRemoteWorkspace / pickRemoteWorkspace.
   *  Deliberately NO SSH: it only touches the local mirror directory. */
  const ensureWorkspace = async (opts = {}) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    const raw = String(o.remotePath == null ? '' : o.remotePath).trim()
    if (!raw) throw apiError('NOT_A_DIRECTORY', '远程路径不能为空')
    const remotePath = normalizeRemotePath(raw)
    let machine
    try {
      machine = await need('resolveMachine')(o.machineId == null ? undefined : String(o.machineId))
    } catch (err) {
      throw asApiError(err)
    }
    const extra = machine.alias ? { alias: machine.alias } : {}
    let localMirror
    try {
      localMirror = await need('ensureMirror')(remotePath, machine.host, machine.username, machine.port, extra)
    } catch (err) {
      throw asApiError(err, { host: machine.host, port: machine.port })
    }
    const title = remoteWorkspaceTitle(remotePath, { name: machine.name, host: machine.host })
    let workspace
    if (o.register !== false) {
      try {
        const created = await need('registerMirroredWorkspace')(localMirror, remotePath, machine.record)
        if (created && created.id != null) {
          workspace = { id: String(created.id), title: String(created.title || title) }
        }
      } catch {
        // Registration is explicitly best-effort in the host (older harness
        // without ctx.workspaceRegistry must not fail the mirror); the mirror
        // and its meta are already on disk.
      }
    }
    return {
      machineId: machine.machineId == null ? '' : String(machine.machineId),
      remotePath,
      localMirror,
      title,
      ...(workspace ? { workspace } : {}),
    }
  }

  const ensureRemoteWorkspace = async (opts = {}) => {
    const result = await ensureWorkspace(opts)
    emit('status')
    return result
  }

  const pickRemoteWorkspace = async (opts = {}) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    const raw = String(o.remotePath == null ? '' : o.remotePath).trim()
    if (!raw) throw apiError('NOT_A_DIRECTORY', '远程路径不能为空')
    const remotePath = normalizeRemotePath(raw)
    let okDir = false
    try {
      okDir = await need('checkRemoteDir')(remotePath, o.machineId == null ? undefined : String(o.machineId))
    } catch (err) {
      throw asApiError(err)
    }
    if (!okDir) throw apiError('NOT_A_DIRECTORY', `远程路径不是目录（或无法访问）：${remotePath}`)
    const result = await ensureWorkspace({
      machineId: o.machineId,
      remotePath,
      register: o.registerWorkspace !== false,
    })
    emit('status')
    return { ...result, status: await status() }
  }

  /** The workspace registry, when the composition serves one. */
  const registryService = () => {
    try {
      const registry = need('workspaceRegistry')()
      return registry && typeof registry === 'object' ? registry : undefined
    } catch {
      return undefined
    }
  }

  /** Quick liveness probe: in-process only unless `deep` is requested. */
  const liveCheck = async (sessionId, dir, opts = {}) => {
    try {
      const fn = deps.isSessionLive
      if (typeof fn !== 'function') return false
      return await fn(String(sessionId), String(dir), opts) === true
    } catch {
      return false
    }
  }

  /**
   * Every local mirror (workspace) with its conversations — the read model the
   * TUI's cleanup page lists.
   *
   * Read-only: no SSH, no mkdir. `live` is the cheap in-process answer; the
   * deletion calls re-check with `{ deep: true }` (kernel lock file) before
   * removing anything.
   */
  const listWorkspaceMirrors = async (opts = {}) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    let root
    let sessionsRoot
    try {
      root = String(need('workspaceRoot')())
      sessionsRoot = String(need('sessionsRoot')())
    } catch (err) {
      throw asApiError(err)
    }
    const wantedMachine = o.machineId == null ? '' : String(o.machineId)
    const projects = await need('listRemoteProjects')()
    const view = await need('listMachinesView')()
    const machines = Array.isArray(view && view.machines) ? view.machines : []
    const registry = registryService()
    let registered = []
    try {
      registered = typeof registry?.list === 'function' ? [...registry.list()] : []
    } catch {
      registered = []
    }
    const byPath = new Map()
    for (const record of registered) {
      if (record && typeof record.path === 'string') byPath.set(String(record.path), record)
    }
    const out = []
    for (const project of projects) {
      if (!project || !project.dir) continue
      if (wantedMachine && String(project.machineId || '') !== wantedMachine) continue
      const machine = machines.find((m) => m && String(m.id) === String(project.machineId))
        || machines.find((m) => m && String(m.host) === String(project.host)
          && (Number(m.port) || 22) === (Number(project.port) || 22)
          && String(m.username || '') === String(project.username || ''))
      if (wantedMachine && !machine) continue
      let sessionList
      try {
        sessionList = listSessionDirs({ sessionsRoot, cwd: project.dir, cwds: [String(project.dir)] })
      } catch {
        sessionList = []
      }
      const sessions = []
      for (const session of sessionList) {
        sessions.push({
          id: String(session.id || ''),
          modifiedAt: Number(session.modifiedAt) || 0,
          live: await liveCheck(session.id, session.dir),
        })
      }
      let size
      try {
        size = dirSizeBytes(project.dir)
      } catch {
        size = { bytes: 0, truncated: false }
      }
      const recent = machine && Array.isArray(machine.recentWorkspaces)
        ? machine.recentWorkspaces.includes(project.remotePath)
        : false
      out.push({
        localMirror: String(project.dir),
        remotePath: String(project.remotePath || ''),
        host: String(project.host || ''),
        port: Number(project.port) || 22,
        username: String(project.username || ''),
        alias: String(project.alias || ''),
        machineId: project.machineId == null ? null : String(project.machineId),
        machineName: machine ? String(machine.name || machine.host || '') : String(project.name || ''),
        title: remoteWorkspaceTitle(String(project.remotePath || ''), {
          name: machine && machine.name,
          host: project.host,
        }),
        registered: byPath.has(String(project.dir)),
        recent,
        sessions,
        sessionCount: sessions.length,
        liveSessionCount: sessions.filter((s) => s.live).length,
        mirrorBytes: Number(size.bytes) || 0,
        mirrorSizeTruncated: size.truncated === true,
      })
    }
    out.sort((left, right) => {
      const byMachine = String(left.machineName).localeCompare(String(right.machineName))
      if (byMachine !== 0) return byMachine
      return String(left.remotePath).localeCompare(String(right.remotePath))
    })
    return out
  }

  /** Delete the sessions of one mirror (keeps the mirror + registration). */
  const deleteWorkspaceSessions = async (opts = {}) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    let root
    let sessionsRoot
    try {
      root = String(need('workspaceRoot')())
      sessionsRoot = String(need('sessionsRoot')())
    } catch (err) {
      throw asApiError(err)
    }
    let validated
    try {
      validated = validateMirror({ mirrorRoot: root, localMirror: o.localMirror })
    } catch (err) {
      throw asApiError(err)
    }
    const cwdAliases = [...new Set([validated.real, String(o.localMirror || '')].filter(Boolean))]
    const report = await deleteSessionsFor({
      sessionsRoot,
      cwd: validated.real,
      cwds: cwdAliases,
      isLive: (id, dir) => liveCheck(id, dir, { deep: true }),
      force: o.force === true,
    })
    emit('status')
    return {
      localMirror: validated.real,
      remotePath: validated.meta.remotePath,
      removedSessions: report.removed.length,
      removedSessionIds: report.removed,
      skippedLiveSessions: report.skippedLive,
    }
  }

  /**
   * Permanently delete one remote workspace: its conversations, its workspace
   * registration, its "recent" entry (so the provider cannot recreate it) and
   * the local mirror directory itself.
   *
   * Refuses while any of its sessions is still live unless `force: true`.
   */
  const deleteRemoteWorkspace = async (opts = {}) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    let root
    let sessionsRoot
    try {
      root = String(need('workspaceRoot')())
      sessionsRoot = String(need('sessionsRoot')())
    } catch (err) {
      throw asApiError(err)
    }
    let validated
    try {
      validated = validateMirror({ mirrorRoot: root, localMirror: o.localMirror })
    } catch (err) {
      throw asApiError(err)
    }
    const deleteSessions = o.deleteSessions !== false
    const force = o.force === true
    let pending = []
    if (deleteSessions) {
      try {
        pending = listSessionDirs({ sessionsRoot, cwd: validated.real, cwds: [String(o.localMirror || '')] })
      } catch {
        pending = []
      }
      if (!force && pending.length > 0) {
        const live = []
        for (const session of pending) {
          if (await liveCheck(session.id, session.dir, { deep: true })) live.push(session.id)
        }
        if (live.length > 0) {
          const error = apiError(
            'WORKSPACE_BUSY',
            `还有 ${live.length} 个会话正在使用该工作区，请先在会话管理里停止它们（或退出对应终端）再删除`,
          )
          error.liveSessions = live
          throw error
        }
      }
    }
    let sessionReport = { removed: [], skippedLive: [] }
    if (deleteSessions) {
      const cwdAliases = [...new Set([validated.real, String(o.localMirror || '')].filter(Boolean))]
      sessionReport = await deleteSessionsFor({
        sessionsRoot,
        cwd: validated.real,
        cwds: cwdAliases,
        isLive: (id, dir) => liveCheck(id, dir, { deep: true }),
        force,
      })
      if (!force && sessionReport.skippedLive.length > 0) {
        const error = apiError(
          'WORKSPACE_BUSY',
          `还有 ${sessionReport.skippedLive.length} 个会话正在使用该工作区，请先停止后再删除`,
        )
        error.liveSessions = sessionReport.skippedLive
        throw error
      }
    }
    let removedRegistration = false
    try {
      const registry = registryService()
      if (registry && typeof registry.delete === 'function') {
        let record
        if (typeof registry.resolveByPath === 'function') {
          try {
            record = await registry.resolveByPath(validated.real)
          } catch {
            record = undefined
          }
        }
        if (!record && typeof registry.list === 'function') {
          try {
            record = [...registry.list()].find((entry) => entry && String(entry.path) === validated.real)
          } catch {
            record = undefined
          }
        }
        if (record && record.id != null) {
          removedRegistration = await registry.delete(record.id) === true
        }
      }
    } catch {
      removedRegistration = false
    }
    let forgotten = { recents: 0, current: 0 }
    try {
      const result = await need('forgetRemotePath')(validated.meta.remotePath)
      if (result && typeof result === 'object') {
        forgotten = { recents: Number(result.recents) || 0, current: Number(result.current) || 0 }
      }
    } catch {
      forgotten = { recents: 0, current: 0 }
    }
    let removedMirror = false
    try {
      removedMirror = deleteMirrorTree({ mirrorRoot: root, localMirror: validated.real }) === true
    } catch (err) {
      throw asApiError(err)
    }
    emit('machines')
    emit('status')
    return {
      localMirror: validated.real,
      remotePath: validated.meta.remotePath,
      removedMirror,
      removedRegistration,
      removedSessions: sessionReport.removed.length,
      removedSessionIds: sessionReport.removed,
      removedRecents: forgotten.recents,
      clearedMachineWorkspace: forgotten.current,
    }
  }

  /** Drop a mirror from every machine's recent list / current workspace only. */
  const forgetWorkspaceRecent = async (opts = {}) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    let root
    try {
      root = String(need('workspaceRoot')())
    } catch (err) {
      throw asApiError(err)
    }
    let validated
    try {
      validated = validateMirror({ mirrorRoot: root, localMirror: o.localMirror })
    } catch (err) {
      throw asApiError(err)
    }
    try {
      const result = await need('forgetRemotePath')(validated.meta.remotePath)
      emit('machines')
      return {
        localMirror: validated.real,
        remotePath: validated.meta.remotePath,
        removedRecents: Number(result && result.recents) || 0,
        clearedMachineWorkspace: Number(result && result.current) || 0,
      }
    } catch (err) {
      throw asApiError(err)
    }
  }

  /** 在系统文件管理器里打开本机 dsh-remote 的镜像根目录（`remote-workspaces`）。 */
  const revealMirrorFolder = async () => {
    try {
      const result = await need('revealMirrorFolderRecord')()
      const dir = String((result && result.path) || '')
      if (!dir) throw apiError('INTERNAL', 'dshRemote.revealMirrorFolder: host returned no path')
      return { path: dir }
    } catch (err) {
      throw asApiError(err)
    }
  }

  const subscribe = (listener) => {
    if (typeof listener !== 'function') {
      throw apiError('INTERNAL', 'dshRemote.subscribe: listener must be a function')
    }
    listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(listener)
    }
  }

  return {
    apiVersion: API_VERSION,
    listMachines,
    upsertMachine,
    removeMachine,
    setCurrent,
    connect,
    probeMachine,
    status,
    listDir,
    listRemoteProjects,
    ensureRemoteWorkspace,
    pickRemoteWorkspace,
    listWorkspaceMirrors,
    deleteWorkspaceSessions,
    deleteRemoteWorkspace,
    forgetWorkspaceRecent,
    revealMirrorFolder,
    subscribe,
  }
}
