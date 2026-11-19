// dsh-remote — SSH port forwarding manager (local & reverse tunnels).
//
// Local forward: listen on 127.0.0.1:<listenPort> → every connection is
// piped through the SSH channel to <targetHost>:<targetPort> on the remote.
// Reverse forward: ask the remote to listen on 127.0.0.1:<listenPort> and pipe
// incoming connections back to <targetHost>:<targetPort> on the LOCAL side
// (ssh2 `forwardIn` + the client `tcpip` event; requires AllowTcpForwarding on
// the remote sshd).
//
// Definitions persist in forwards.json; forwards become active only while the
// SSH connection is up, and definitions marked autoStart + lastActive are
// restored when their machine reconnects. Reverse tunnels are restored too,
// but the UI warns before the flag can be set for one: an auto-restored reverse
// tunnel re-opens a listening port on the REMOTE without a fresh click.
import net from 'node:net'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { forwardOutChannel } from './pool.js'

export class ForwardManager {
  /** @param {object} pool SshPool (needs .connect() returning the ssh2 client).
   *  @param {object} [opts] - `file` (persistence), `net` (a `node:net`
   *    compatible module, so the listener's connection handler — the path the
   *    issue #54 crash travelled — can be driven from a unit test without
   *    binding a real port), and `currentMachine` (returns the id of the
   *    machine the pool is connected to; used to scope `autoStart` restores).
   */
  constructor(pool, { file, net: netModule, currentMachine } = {}) {
    this.pool = pool
    this.net = netModule || net
    this.file = file || null
    this.defs = this._load()
    this._migrateLegacy()
    this.servers = new Map() // id → { server | remoteListen, sockets:Set, client }
    this.starting = new Map() // id → in-flight start promise (see start())
    /** id → attempt counter; bumping it invalidates a late start result. */
    this.startGeneration = new Map()
    /** Bumped whenever the live client changes; a start binds to one client. */
    this.connGeneration = 0
    /** Id of the machine the live client belongs to (null when unknown). */
    this.currentMachine = typeof currentMachine === 'function' ? currentMachine : () => null
    this.connectedMachineId = null
    this.client = null
    this.onTcpip = null
    this.onClose = null
    this.attach = this.attach.bind(this)
  }

  _load() {
    if (!this.file) return []
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'))
      if (Array.isArray(j.defs)) return j.defs
    } catch {}
    return []
  }

  /**
   * Upgrade older forwards.json files. Before auto-reconnect persisted a
   * "was running" flag, `autoStart: true` meant "start it on every connect".
   * Silently re-interpreting that as "restore only if it was running" would
   * stop previously-working tunnels without telling anyone — and an old
   * reverse entry never saw the remote-listener warning. Disable both, mark
   * them for re-consent, and let the row badge ask the user to opt in again.
   */
  _migrateLegacy() {
    let changed = false
    for (const d of this.defs) {
      if (Object.prototype.hasOwnProperty.call(d, 'lastActive')) continue
      changed = true
      d.lastActive = false
      if (d.autoStart) {
        d.autoStart = false
        d.needsReconsent = true
      }
    }
    if (changed) this._save()
  }

  _save() {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ defs: this.defs }, null, 2))
    } catch {}
  }

  /**
   * Called by the pool after a successful connect: restore the tunnels that
   * were already running the last time this machine was connected.
   *
   * `autoStart` is labelled 自动重连 — RESTORE, not "start every checked
   * definition on any connect". The old loop started them all, so on a fresh
   * session clicking one forward established the connection and silently lit
   * up every other autoStart row; and because it ignored `machineId`, a
   * connection to machine B could even start machine A's forwards through B.
   *
   * The flag that remembers "was running" is `lastActive`, persisted in
   * forwards.json, so the restore also survives a dsh-web restart. The plugin's
   * boot-time reconnect of the current machine (index.js) is what makes that
   * happen without the user clicking anything.
   *
   * @param {object} client - the live ssh2 client / OpenSshConnection.
   * @param {string} [machineId] - machine the client belongs to; defaults to
   *   the manager's `currentMachine()` provider.
   */
  attach(client, machineId) {
    if (this.client === client) return
    const mid = machineId !== undefined ? (machineId || null) : (this.currentMachine() || null)
    this.connGeneration += 1
    this.client = client
    this.connectedMachineId = mid
    this.onTcpip = (info, accept, reject) => this._handleTcpip(info, accept, reject)
    client.on('tcpip', this.onTcpip)
    // A socket can die WITHOUT the pool calling detach() first (network drop,
    // keepalive timeout): drop the dead handle so the next start() attaches the
    // NEW client instead of reusing this one. `lastActive` already persisted,
    // so the next attach() still knows what to restore.
    this.onClose = () => {
      this._cancelAllStarts()
      this.stopAll()
      this.connGeneration += 1
      this.client = null
      this.connectedMachineId = null
      this.onTcpip = null
      this.onClose = null
    }
    client.on('close', this.onClose)
    // Unknown identity is fail-closed: a null provider must never match a
    // definition whose machineId is also null (that would restore machine A's
    // tunnel after an ephemeral switch to B).
    if (mid == null) return
    for (const d of this.defs) {
      // Both directions: a reverse tunnel is only restored when the user
      // explicitly set autoStart (the UI shows the remote-listener warning
      // before that flag can be enabled), plus it was running lastActive.
      if (!d.autoStart || !d.lastActive) continue
      if (!d.machineId || d.machineId !== mid || this.servers.has(d.id)) continue
      this.start(d).catch(() => {})
    }
  }

  /** Persist "this forward was running" so a later attach() (or a restart) can restore it. */
  _setLastActive(d, value) {
    if (!d || d.lastActive === value) return
    d.lastActive = value
    this._save()
  }

  /** True when the given/current machine has a persisted forward to restore on connect. */
  hasPendingRestore(machineId) {
    const mid = machineId !== undefined ? (machineId || null) : (this.currentMachine() || null)
    if (mid == null) return false
    return this.defs.some((d) => d.autoStart && d.lastActive && d.machineId && d.machineId === mid)
  }

  detach() {
    this._cancelAllStarts()
    this.stopAll()
    this.connGeneration += 1
    if (this.client) {
      if (this.onTcpip) this.client.removeListener('tcpip', this.onTcpip)
      if (this.onClose) this.client.removeListener('close', this.onClose)
    }
    this.client = null
    this.connectedMachineId = null
    this.onTcpip = null
    this.onClose = null
  }

  list() {
    return this.defs.map((d) => ({
      id: d.id,
      direction: d.direction,
      listenPort: d.listenPort,
      targetHost: d.targetHost,
      targetPort: d.targetPort,
      machineId: d.machineId || null,
      autoStart: !!d.autoStart,
      lastActive: !!d.lastActive,
      needsReconsent: !!d.needsReconsent,
      active: this.servers.has(d.id),
    }))
  }

  _defId() {
    return 'fwd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  }

  /** Create a forward definition (persisted). Does NOT start it. */
  define({ direction = 'local', listenPort, targetHost, targetPort, autoStart = false, machineId } = {}) {
    const d = {
      id: this._defId(),
      direction: direction === 'reverse' ? 'reverse' : 'local',
      listenPort: Number(listenPort),
      targetHost: String(targetHost || '127.0.0.1'),
      targetPort: Number(targetPort),
      autoStart: !!autoStart,
      // Persisted across process restarts: attach() restores autoStart defs
      // that were running the last time their machine was connected.
      lastActive: false,
      machineId: machineId || null,
    }
    this.defs.push(d)
    this._save()
    return d
  }

  /**
   * Patch an existing definition's mutable fields and persist it.
   *
   * Two callers share this: the row's 自动重连 checkbox patches only
   * `autoStart`; the edit form sends the whole definition (direction, ports,
   * target host, owning machine). Fields that are absent stay untouched — the
   * route validates them first, so a typo never reaches this merge.
   *
   * It does NOT start or stop the tunnel. Changing a BIND of a running forward
   * is refused by the route (the live socket would keep the old bind); toggling
   * `autoStart` on a running forward is fine.
   *
   * @param {string} id
   * @param {{autoStart?: boolean, direction?: 'local'|'reverse', listenPort?: number,
   *          targetHost?: string, targetPort?: number, machineId?: string|null}} patch
   * @returns {object|null} the updated definition, or null when the id is unknown.
   */
  update(id, { autoStart, direction, listenPort, targetHost, targetPort, machineId } = {}) {
    const d = this.defs.find((x) => x.id === id)
    if (!d) return null
    if (typeof autoStart === 'boolean') {
      d.autoStart = autoStart
      delete d.needsReconsent
    }
    if (direction === 'local' || direction === 'reverse') d.direction = direction
    if (Number.isInteger(listenPort)) d.listenPort = listenPort
    if (typeof targetHost === 'string' && targetHost) d.targetHost = targetHost
    if (Number.isInteger(targetPort)) d.targetPort = targetPort
    if (machineId !== undefined) d.machineId = machineId || null
    this._save()
    return d
  }

  remove(id) {
    this._bumpStart(id)
    this._teardown(id)
    const i = this.defs.findIndex((d) => d.id === id)
    if (i >= 0) { this.defs.splice(i, 1); this._save(); return true }
    return false
  }

  /**
   * Start one forward.
   *
   * Concurrent callers share ONE attempt. That is not a nicety: `attach()`
   * restarts autoStart definitions from inside `pool.connect()`, so a manual
   * "启动" on such a forward used to race its own auto-start pass for the same
   * listen port. The auto pass bound the port, the manual call reported
   * EADDRINUSE, and the UI — which only refreshes on success — left the row on
   * 启动 although the tunnel was up (the second click then short-circuited on
   * `servers.has` and looked like the fix). One attempt per definition removes
   * the race at the source.
   *
   * @param {object} def - a definition or a `list()` row (same `id`).
   * @returns {Promise<{ok: boolean, active?: boolean, error?: string}>}
   */
  /** Invalidate any in-flight attempt for `id` (Stop/Remove/Detach/Disconnect). */
  _bumpStart(id) {
    const next = (this.startGeneration.get(id) || 0) + 1
    this.startGeneration.set(id, next)
    this.starting.delete(id)
    return next
  }

  _cancelAllStarts() {
    for (const d of this.defs) this._bumpStart(d.id)
  }

  _isAttemptCurrent(d, seq) {
    return this.startGeneration.get(d.id) === seq && this.defs.includes(d)
  }

  start(def) {
    const d = this.defs.find((x) => x.id === def.id) || def
    // Manual start must respect identity too: starting A's forward while an
    // ephemeral B is connected would tunnel through B. Unknown identity is
    // fail-closed; definitions without a machineId stay startable (legacy).
    // While attached, trust the identity the client was attached with (an
    // explicit attach() argument is more precise than the provider); with no
    // client, fall back to the applied identity. Either way unknown is
    // fail-closed for definitions that carry a machineId.
    const mid = this.client ? this.connectedMachineId : this.currentMachine()
    if (d.machineId && (mid == null || d.machineId !== mid)) {
      return Promise.resolve({ ok: false, error: '该转发属于另一台机器（或当前机器身份未知），请先切换到对应机器' })
    }
    const existing = this.servers.get(d.id)
    if (existing) {
      if (!this.client || existing.client === this.client) return Promise.resolve({ ok: true, active: true })
      // The entry belongs to an old/dead client: never report it as healthy.
      this._teardown(d.id)
    }
    const inflight = this.starting.get(d.id)
    if (inflight) return inflight
    const seq = this._bumpStart(d.id)
    // Publish the shared attempt BEFORE running it: pool.connect() may call
    // attach() synchronously (fake pools, and the OpenSSH backend's onReady),
    // and attach()'s restore pass calls start() again. Without a placeholder in
    // the map that nested call bumps the generation and cancels the outer one.
    let resolveAttempt
    const attempt = new Promise((resolve) => { resolveAttempt = resolve })
    this.starting.set(d.id, attempt)
    this._startOnce(d, seq).then(
      (r) => {
        if (r && r.ok && this._isAttemptCurrent(d, seq)) this._setLastActive(d, true)
        resolveAttempt(r)
      },
      (err) => resolveAttempt({ ok: false, error: String((err && err.message) || err) }),
    ).finally(() => {
      if (this.starting.get(d.id) === attempt) this.starting.delete(d.id)
    })
    return attempt
  }

  /** The body of one start attempt; see start() for the concurrency contract. */
  async _startOnce(d, seq) {
    let client
    try {
      client = await this.pool.connect()
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
    // No resource has been created yet. In particular, do NOT teardown by id:
    // a newer attempt may already own the registered listener.
    if (!this._isAttemptCurrent(d, seq)) return { ok: false, error: '已取消' }
    if (this.client && this.client !== client) return { ok: false, error: '启动期间连接已变化' }
    if (!this.client) this.attach(client)
    if (this.client !== client) return { ok: false, error: '启动期间连接已变化' }
    const connSeq = this.connGeneration
    let entry
    try {
      // Resource creation and registration are deliberately separate. Each
      // attempt gets its own entry, so a late stale callback cannot delete a
      // newer attempt's listener merely because both share the definition id.
      entry = d.direction === 'reverse'
        ? await this._startReverse(d, client)
        : await this._startLocal(d, client)
    } catch (err) {
      // A late error from an obsolete attempt is just its own cancellation;
      // it must never tear down a listener installed by a newer attempt.
      if (!this._isAttemptCurrent(d, seq)) return { ok: false, error: '已取消' }
      // A concurrent starter may have won the port between our last check and
      // the bind (attach() starts autoStart defs inside pool.connect()). Only
      // trust that when the same live client/connection owns it.
      if (this.servers.has(d.id) && this.client === client && this.connGeneration === connSeq) {
        return { ok: true, active: true }
      }
      return { ok: false, error: String((err && err.message) || err) }
    }
    if (!this._isAttemptCurrent(d, seq) || this.connGeneration !== connSeq || this.client !== client) {
      // Stop/Remove/disconnect won the race while listen()/forwardIn() was in
      // flight: close ONLY this attempt's late entry, never the current one.
      this._teardownEntry(d, entry)
      return { ok: false, error: this._isAttemptCurrent(d, seq) ? '启动期间连接已变化' : '已取消' }
    }
    this.servers.set(d.id, entry)
    return { ok: true, active: true }
  }

  _startLocal(d, client) {
    return new Promise((resolve, reject) => {
      const server = this.net.createServer((socket) => {
        // ssh2's forwardOut reports a dead connection by THROWING
        // (`if (!this._sock || !isWritable(this._sock)) throw new Error('Not
        // connected')`) and never calls the callback, so a callback-only error
        // path cannot guard this call. Uncaught, the throw escapes net.Server's
        // connection handler and kills the whole host process — the exact fatal
        // stack of issue #54, found in WebAttach and reachable here too for a
        // user-defined local forward. `attach()` does register a `close`
        // listener that calls stopAll(), but a request can arrive in the window
        // between the connection dying and that event.
        forwardOutChannel(client, { dstHost: d.targetHost, dstPort: d.targetPort }).then((channel) => {
          socket.pipe(channel)
          channel.pipe(socket)
          const kill = () => { try { socket.destroy() } catch {}; try { channel.close() } catch {} }
          socket.on('error', kill)
          channel.on('error', kill)
          socket.on('close', kill)
          channel.on('close', kill)
        }).catch(() => {
          // A dead tunnel is a UI state, not a reason to exit.
          try { socket.destroy() } catch { /* already gone */ }
        })
      })
      server.on('error', (e) => reject(new Error(`本地转发 ${d.listenPort} 启动失败: ${e.message}`)))
      server.listen(d.listenPort, '127.0.0.1', () => {
        resolve({ kind: 'local', server, sockets: new Set(), client })
      })
    })
  }

  _startReverse(d, client) {
    // The system-OpenSSH backend (issue #51) cannot do ssh2's two-phase
    // `forwardIn` + `tcpip`: the `ssh -R` CLI needs the final target as an
    // argument, so it exposes `reverseForward()` instead. Prefer it when
    // present — otherwise every reverse tunnel would fail on that backend.
    if (typeof client.reverseForward === 'function') {
      return client.reverseForward({
        bindHost: '127.0.0.1',
        listenPort: d.listenPort,
        targetHost: d.targetHost,
        targetPort: d.targetPort,
      }).then((handle) => {
        const entry = { kind: 'reverse-cli', handle, client }
        // The `ssh -R` child can die on its own (remote sshd restarts, network
        // drop). Drop only the entry that still belongs to this handle.
        const child = handle && handle.child
        if (child && typeof child.on === 'function') {
          child.once('close', () => {
            if (this.servers.get(d.id) === entry) this.servers.delete(d.id)
          })
        }
        return entry
      }).catch((err) => {
        throw new Error(`远端监听 ${d.listenPort} 失败: ${(err && err.message) || err}`)
      })
    }
    return new Promise((resolve, reject) => {
      // ssh2 calls the remote TCP listen API `forwardIn` (NOT openssh_forwardIn,
      // which in ssh2 >= 1.16 is stream-local only).
      if (typeof client.forwardIn !== 'function') {
        return reject(new Error('此 ssh2 版本不支持反向转发 (forwardIn)'))
      }
      client.forwardIn('127.0.0.1', d.listenPort, (err) => {
        if (err) return reject(new Error(`远端监听 ${d.listenPort} 失败: ${(err && err.message) || err}`))
        resolve({ kind: 'reverse', sockets: new Set(), client })
      })
    })
  }

  _handleTcpip(info, accept, reject) {
    // Only the ssh2 backend reaches here: `ssh -R` handles the remote listener
    // and its targets entirely inside the CLI, so a 'reverse-cli' entry never
    // produces a 'tcpip' event.
    for (const entry of this.servers.values()) {
      if (entry.kind === 'reverse' && Number(info.destPort) === Number(this._defFor(entry).listenPort)) {
        const channel = accept()
        const socket = this.net.connect({ host: this._defFor(entry).targetHost, port: this._defFor(entry).targetPort })
        socket.pipe(channel)
        channel.pipe(socket)
        entry.sockets.add(socket)
        const kill = () => {
          try { socket.destroy() } catch {}
          try { channel.close() } catch {}
          entry.sockets.delete(socket)
        }
        socket.on('error', kill)
        channel.on('error', kill)
        socket.on('close', kill)
        return
      }
    }
    reject()
  }

  _defFor(entry) {
    for (const d of this.defs) {
      if (this.servers.has(d.id) && this.servers.get(d.id) === entry) return d
    }
    return { listenPort: 0, targetHost: '127.0.0.1', targetPort: 0 }
  }

  /**
   * Stop one listener. `forget` is for the user-initiated stop in the route:
   * it clears the persisted `lastActive`, so 自动重连 will not bring the tunnel
   * back on the next connect. Teardown paths (stopAll/detach/remove) call it
   * without `forget` — a dropped connection is exactly what must be restored.
   */
  stop(id, { forget = false } = {}) {
    this._bumpStart(id)
    if (forget) this._setLastActive(this.defs.find((x) => x.id === id), false)
    this._teardown(id)
  }

  /** Close one registered listener/handle. Does not touch lastActive or attempts. */
  _teardown(id) {
    const entry = this.servers.get(id)
    if (!entry) return
    this._teardownEntry(this.defs.find((d) => d.id === id) || this._defFor(entry), entry)
  }

  /**
   * Close a specific attempt's entry. Removing it from `servers` is conditional
   * on identity: a stale attempt may close its own unregistered resource, but
   * it can never delete a newer attempt's entry with the same definition id.
   */
  _teardownEntry(d, entry) {
    if (!entry) return
    try {
      if (entry.kind === 'local') {
        entry.server.close()
        for (const s of entry.sockets) { try { s.destroy() } catch {} }
      } else if (entry.kind === 'reverse-cli') {
        // The `ssh -R` child IS the tunnel: killing it closes the remote listener.
        if (entry.handle && typeof entry.handle.close === 'function') entry.handle.close()
      } else if (entry.client && typeof entry.client.unforwardIn === 'function') {
        const current = this.servers.get(d.id)
        // ssh2 unforwardIn is keyed by client + port, NOT by our entry. If a
        // newer attempt already owns that same remote listener on this client,
        // a stale attempt must not close it. Normal Stop sees current===entry
        // and still unforwards; with no replacement, stale cleanup can proceed.
        if (!current || current === entry || current.client !== entry.client) {
          entry.client.unforwardIn('127.0.0.1', d.listenPort, () => {})
        }
      }
    } catch {}
    if (this.servers.get(d.id) === entry) this.servers.delete(d.id)
  }

  stopAll() {
    for (const id of [...this.servers.keys()]) this.stop(id)
  }
}
