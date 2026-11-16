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
// SSH connection is up (auto-restart on connect when `autoStart: true`), and
// every tunnel is torn down when the pool disconnects — reverse tunnels are
// never auto-restarted (they would re-expose a local port without asking).
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
    this.servers = new Map() // id → { server | remoteListen, sockets:Set, client }
    this.starting = new Map() // id → in-flight start promise (see start())
    /** Id of the machine the live client belongs to (null when unknown). */
    this.currentMachine = typeof currentMachine === 'function' ? currentMachine : () => null
    this.connectedMachineId = null
    /**
     * machineId → ids of the autoStart forwards that were RUNNING when that
     * machine's connection dropped. `attach()` restores only these; see the
     * comment there for why "all autoStart defs" was wrong.
     */
    this.restoreByMachine = new Map()
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

  _save() {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ defs: this.defs }, null, 2))
    } catch {}
  }

  /**
   * Called by the pool after a successful connect: restore the tunnels that
   * were already running before the connection dropped.
   *
   * `autoStart` is labelled 自动重连 — RESTORE, not "start every checked
   * definition on any connect". The old loop started them all, so on a fresh
   * session clicking one forward established the connection and silently lit
   * up every other autoStart row; and because it ignored `machineId`, a
   * connection to machine B could even start machine A's forwards through B.
   *
   * Only definitions that (a) are local + autoStart, (b) belong to the machine
   * that just connected, and (c) were active when that machine's previous
   * connection went away are restarted.
   *
   * @param {object} client - the live ssh2 client / OpenSshConnection.
   * @param {string} [machineId] - machine the client belongs to; defaults to
   *   the manager's `currentMachine()` provider.
   */
  attach(client, machineId) {
    if (this.client === client) return
    const mid = machineId !== undefined ? (machineId || null) : (this.currentMachine() || null)
    this.client = client
    this.connectedMachineId = mid
    this.onTcpip = (info, accept, reject) => this._handleTcpip(info, accept, reject)
    client.on('tcpip', this.onTcpip)
    this.onClose = () => this.stopAll()
    client.on('close', this.onClose)
    const restore = this.restoreByMachine.get(mid)
    if (!restore || !restore.size) return
    this.restoreByMachine.delete(mid)
    for (const d of this.defs) {
      if (!d.autoStart || d.direction !== 'local') continue
      if ((d.machineId || null) !== mid) continue
      if (!restore.has(d.id) || this.servers.has(d.id)) continue
      this.start(d).catch(() => {})
    }
  }

  detach() {
    // Remember what was RUNNING (autoStart only — those are the ones allowed to
    // come back) before stopAll() empties `servers`. Keyed by machine so a
    // switch to another host cannot restore this host's forwards.
    const mid = this.connectedMachineId
    const restore = new Set()
    for (const id of this.servers.keys()) {
      const d = this.defs.find((x) => x.id === id)
      if (d && d.autoStart && d.direction === 'local' && (d.machineId || null) === mid) restore.add(id)
    }
    if (restore.size) this.restoreByMachine.set(mid, restore)
    else this.restoreByMachine.delete(mid)
    this.stopAll()
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
      machineId: machineId || null,
    }
    this.defs.push(d)
    this._save()
    return d
  }

  remove(id) {
    this.stop(id)
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
  start(def) {
    const d = this.defs.find((x) => x.id === def.id) || def
    if (this.servers.has(d.id)) return Promise.resolve({ ok: true, active: true })
    const inflight = this.starting.get(d.id)
    if (inflight) return inflight
    const attempt = this._startOnce(d).finally(() => {
      if (this.starting.get(d.id) === attempt) this.starting.delete(d.id)
    })
    this.starting.set(d.id, attempt)
    return attempt
  }

  /** The body of one start attempt; see start() for the concurrency contract. */
  async _startOnce(d) {
    let client = await this.pool.connect()
    if (!this.client) this.attach(client)
    if (this.client !== client) {
      // The pool reconnected while we were connecting — retry on the live client.
      client = this.client
    }
    try {
      if (d.direction === 'reverse') {
        await this._startReverse(d, client)
      } else {
        await this._startLocal(d, client)
      }
      return { ok: true, active: true }
    } catch (err) {
      // A concurrent starter may have won the port between our last check and
      // the bind (attach() starts autoStart defs inside pool.connect()). If the
      // server exists now the forward is up, so this attempt is not a failure.
      if (this.servers.has(d.id)) return { ok: true, active: true }
      return { ok: false, error: String((err && err.message) || err) }
    }
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
        this.servers.set(d.id, { kind: 'local', server, sockets: new Set(), client })
        resolve()
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
        this.servers.set(d.id, { kind: 'reverse-cli', handle, client })
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
        this.servers.set(d.id, { kind: 'reverse', sockets: new Set(), client })
        resolve()
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

  stop(id) {
    const entry = this.servers.get(id)
    if (!entry) return
    try {
      if (entry.kind === 'local') {
        entry.server.close()
        for (const s of entry.sockets) { try { s.destroy() } catch {} }
      } else if (entry.kind === 'reverse-cli') {
        // The `ssh -R` child IS the tunnel: killing it closes the remote listener.
        if (entry.handle && typeof entry.handle.close === 'function') entry.handle.close()
      } else if (entry.client && typeof entry.client.unforwardIn === 'function') {
        const d = this._defFor(entry)
        entry.client.unforwardIn('127.0.0.1', d.listenPort, () => {})
      }
    } catch {}
    this.servers.delete(id)
  }

  stopAll() {
    for (const id of [...this.servers.keys()]) this.stop(id)
  }
}
