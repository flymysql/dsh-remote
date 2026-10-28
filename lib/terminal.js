// dsh-remote — embedded interactive terminal sessions.
//
// Why polling and not a WebSocket: the plugin registers plain HTTP routes on
// `webServer`, and the browser half is a DSH client UI that must not depend on a
// socket upgrade path the host may or may not expose. A long-lived SSH channel
// owned by the HOST, with the browser polling for output deltas, keeps the
// transport boring (any HTTP stack works, no upgrade negotiation, no proxy
// surprises) while the expensive part — the PTY session — stays open exactly
// like a real ssh session.
//
// The trade is latency, and it is bounded by the poll interval the client
// chooses (the UI uses ~120ms idle, which is below the threshold where typing
// feels laggy). Keystrokes are written immediately on their own request, so
// input never waits for the poll cadence; only OUTPUT is batched.
//
// Sessions are host-owned and per-MACHINE: closing the browser does not kill the
// remote shell (a half-finished `vim` survives a page reload), but every session
// is bounded by an idle timeout and by the plugin's own disposal, so nothing
// leaks past an unload.

import { randomUUID } from 'node:crypto'

/** Output retained per session (bytes). A terminal is a stream, not a file:
 *  past this the oldest bytes drop and the reader is told it went lossy. */
export const TERMINAL_RING_BYTES = 256 * 1024

/** A session with no attach/poll/write for this long is closed. */
export const TERMINAL_IDLE_MS = 30 * 60 * 1000

/** Hard cap on concurrent sessions per process (protects the remote host's
 *  MaxSessions as much as our own memory). */
export const TERMINAL_MAX_SESSIONS = 8

/**
 * One PTY-backed remote shell plus its output ring.
 *
 * The ring keeps a monotonic byte counter (`total`) so a poller can ask for
 * "everything after offset N" without the server tracking per-client cursors —
 * that is what lets one session be observed by a reloaded page, or by two tabs.
 */
class TerminalSession {
  constructor({ id, stream, machine, cols, rows }) {
    this.id = id
    this.stream = stream
    this.machine = machine
    this.cols = cols
    this.rows = rows
    this.createdAt = Date.now()
    this.lastSeen = Date.now()
    this.total = 0            // bytes ever produced
    this.chunks = []          // [{ at, text }] within the retained window
    this.retained = 0
    this.closed = false
    this.exitNote = ''
    stream.on('data', (d) => this._push(d.toString('utf8')))
    stream.stderr && stream.stderr.on('data', (d) => this._push(d.toString('utf8')))
    stream.on('close', () => this._close('session closed'))
    stream.on('error', (e) => this._close('session error: ' + ((e && e.message) || e)))
  }

  _push(text) {
    if (!text) return
    this.chunks.push({ at: this.total, text })
    this.total += Buffer.byteLength(text, 'utf8')
    this.retained += text.length
    // Drop from the head until back inside the budget. A single huge chunk is
    // kept whole (truncating a UTF-8 string mid-chunk would corrupt it); the
    // lossy flag already tells the reader bytes are missing.
    while (this.retained > TERMINAL_RING_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      this.retained -= dropped.text.length
    }
  }

  _close(note) {
    if (this.closed) return
    this.closed = true
    this.exitNote = note || 'session closed'
  }

  /**
   * Everything produced after `from` (a byte offset from a previous read).
   * @param {number} from
   * @returns {{chunks: string[], next: number, lossy: boolean, closed: boolean, note: string}}
   */
  readFrom(from) {
    const start = Number(from) || 0
    const oldest = this.chunks.length ? this.chunks[0].at : this.total
    const lossy = start < oldest
    const chunks = this.chunks.filter((c) => c.at + Buffer.byteLength(c.text, 'utf8') > start).map((c) => c.text)
    return { chunks, next: this.total, lossy, closed: this.closed, note: this.exitNote }
  }

  write(data) {
    if (this.closed) return false
    try { this.stream.write(data) } catch { return false }
    return true
  }

  resize(cols, rows) {
    this.cols = Math.max(2, Math.min(Number(cols) || this.cols, 1000))
    this.rows = Math.max(2, Math.min(Number(rows) || this.rows, 1000))
    try { this.stream.setWindow(this.rows, this.cols, 0, 0) } catch { /* channel gone */ }
  }

  end() {
    this._close('closed by request')
    try { this.stream.end() } catch { /* already gone */ }
    try { this.stream.close() } catch { /* already gone */ }
  }
}

/**
 * Owns every terminal session in this process.
 *
 * Per-machine keying matters: a session belongs to a MACHINE identity, so a
 * session bound to one host can never be attached from a request that resolves
 * to a different one (the same isolation rule the file tools follow).
 */
export function createTerminalManager() {
  /** @type {Map<string, TerminalSession>} */
  const sessions = new Map()
  let sweeper = null

  const startSweeper = () => {
    if (sweeper) return
    // One timer for the whole manager; unref'd so it never holds the process
    // open on its own.
    sweeper = setInterval(() => {
      const now = Date.now()
      for (const [id, s] of sessions) {
        if (now - s.lastSeen > TERMINAL_IDLE_MS) {
          try { s.end() } catch { /* already gone */ }
          sessions.delete(id)
        }
      }
    }, 60 * 1000)
    if (typeof sweeper.unref === 'function') sweeper.unref()
  }

  /**
   * Open a new terminal session on a machine.
   * @param {object} arg
   * @param {object} arg.pool - the machine's SshPool (must expose shell()).
   * @param {string} arg.machine - a stable identity string for the machine.
   * @param {number} [arg.cols]
   * @param {number} [arg.rows]
   * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
   */
  const open = async ({ pool, machine, cols, rows }) => {
    if (sessions.size >= TERMINAL_MAX_SESSIONS) {
      return { ok: false, error: `too many terminal sessions (max ${TERMINAL_MAX_SESSIONS}) — close one first` }
    }
    if (!pool || typeof pool.shell !== 'function') {
      return { ok: false, error: 'this machine cannot open an interactive shell (no shell() on its pool)' }
    }
    let stream
    try {
      stream = await pool.shell({ cols, rows })
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
    const id = randomUUID()
    sessions.set(id, new TerminalSession({ id, stream, machine: String(machine || ''), cols: Number(cols) || 80, rows: Number(rows) || 24 }))
    startSweeper()
    return { ok: true, id }
  }

  /**
   * Look up a session, enforcing the machine boundary.
   * @param {string} id
   * @param {string} machine
   * @returns {{session?: TerminalSession, error?: string}}
   */
  const owned = (id, machine) => {
    const s = sessions.get(String(id || ''))
    if (!s) return { error: 'no such terminal session (it may have exited or timed out)' }
    if (String(machine || '') !== s.machine) return { error: 'this terminal belongs to a different machine' }
    s.lastSeen = Date.now()
    return { session: s }
  }

  return {
    open,
    owned,
    has: (id) => sessions.has(String(id || '')),
    list: () => [...sessions.values()].map((s) => ({
      id: s.id, machine: s.machine, cols: s.cols, rows: s.rows, createdAt: s.createdAt, closed: s.closed,
    })),
    close: (id, machine) => {
      const { session, error } = owned(id, machine)
      if (error) return { ok: false, error }
      session.end()
      sessions.delete(session.id)
      return { ok: true }
    },
    /** Close everything (plugin unload). */
    dispose: () => {
      for (const s of sessions.values()) { try { s.end() } catch { /* already gone */ } }
      sessions.clear()
      if (sweeper) { try { clearInterval(sweeper) } catch { /* gone */ } sweeper = null }
    },
    size: () => sessions.size,
  }
}
