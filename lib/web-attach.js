// dsh-remote — "remote DSH web UI" attach sessions (issue #46).
//
// The user's intent behind that issue is "use the local DSH as a CLIENT for a
// DSH running on another machine": they do NOT want the remote to expose an
// inbound listener. DSH makes that impossible anyway — `dsh-web-app` hard-
// rejects `--host 0.0.0.0` (startup.js) because it would put remote code
// execution on the network, and `dsh-host-webserver` only accepts the
// 127.0.0.1/0.0.0.0 literals.
//
// So this module inverts the direction, exactly like the rest of the plugin:
// we SSH OUT, start (or reuse) a loopback-bound `dsh web` on the remote, and
// carry its socket back over our own SSH connection with a local TCP forward.
// The browser then talks to 127.0.0.1:<localPort> on this machine.
//
// Verified end-to-end on a real Linux host (dsh 0.1.5-rc.2): a bare TCP forward
// is sufficient — the SPA, its assets, AND the `/api/remote.mux` WebSocket
// upgrade all transit it (HTTP/1.1 101), with no reverse proxy and no host
// rewriting. That works because DSH binds its auth cookie to the request
// authority, so a cookie minted against `127.0.0.1:<localPort>` is exactly what
// the browser then sends back to that same authority.
//
// Three details drive the design and are worth stating once:
//
//  1. The launch token CANNOT be read from anywhere but stdout. It is a
//     `randomBytes` value held in a process-local WeakMap and printed on one
//     line (`dsh web: http://127.0.0.1:<port>/?token=…`). No file, no env var.
//     Therefore the token is captured by redirecting the remote process's
//     output to a log file and parsing that line out of it.
//  2. `--port 0` lets the remote OS pick a free port, and the same printed line
//     reports which port it chose — so we never have to guess or probe for a
//     free port on the remote.
//  3. The pairing that must survive is (token, port) from ONE launch. Reading
//     them from one line is what keeps them consistent.
//
// Everything here is read-only with respect to the remote filesystem except
// the log file it creates under the remote `$HOME`.
import net from 'node:net'
import posixShell from './posix-shell.cjs'

const { posixViaSh } = posixShell

/** Execute an INTERNAL POSIX script without depending on the login shell. */
function execPosix(exec, command, opts) {
  return exec(posixViaSh(command), opts)
}

/** Remote log file per attach session; `$HOME` is expanded by the remote shell. */
const LOG_NAME = '.dsh-remote-web'

/**
 * Parse the `dsh web:` startup line out of a remote log.
 *
 * The line looks like:
 *   dsh web: http://127.0.0.1:43129/?token=Iy7FKuPSI5qJKJUFDyah4B6i8Ul6_hvspiJhiWufYt8
 * and may be followed by a LAN suffix when the remote bound 0.0.0.0 (it never
 * will here — we never pass `--host` — but tolerate it rather than break).
 *
 * @param {string} text - the remote log contents.
 * @returns {{url: string, port: number, token: string}|null} parsed facts, or
 *   null when the line has not appeared yet (still booting) or is malformed.
 */
export function parseWebStart(text) {
  if (typeof text !== 'string' || text === '') return null
  // Take the LAST match: a reused log file may hold an earlier session's line,
  // and the newest one is the one this launch produced.
  const matches = [...text.matchAll(/dsh web:\s*(http:\/\/[^\s]+)/g)]
  if (matches.length === 0) return null
  const url = matches[matches.length - 1][1]
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const port = Number(parsed.port)
  const token = parsed.searchParams.get('token') || ''
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!token) return null
  return { url, port, token }
}

/** True when the log proves the remote process died instead of booting. */
export function launchFailed(text) {
  return typeof text === 'string' && text.includes(DEAD_MARKER)
}

/** Marker the remote launcher echoes when the process exits before printing. */
const DEAD_MARKER = '__DSH_REMOTE_DIED__'
/** Marker separating the parsed line from the raw log tail for diagnostics. */
export const TAIL_MARKER = '__DSH_TAIL__'
/** Marker carrying the remote PID so the session can stop its own process. */
export const PID_MARKER = '__DSH_PID__='

/**
 * Budget for the issue #125 discovery step. Asking "is one already running?"
 * must never delay a spawn by more than a few seconds, so the default sits
 * well under the launch wait; a slower answer is treated as "no answer".
 */
export const DISCOVER_TIMEOUT_MS = 8000
/** Budget for the post-discovery liveness probe (see _probeRemoteWeb). */
export const PROBE_TIMEOUT_MS = 4000

/**
 * Parse the URL a discover command printed (issue #125).
 *
 * The discovery contract is deliberately lenient — the command is user-written
 * glue (a systemd status scrape, a saved URL file, a PowerShell one-liner) and
 * may print banner noise around the answer. Scan for `http(s)://` lines from
 * the END backwards and take the first one that pins a real port AND a token —
 * the same two facts a launch line provides. Walking past invalid matches (a
 * trailing "see https://…" trailer) is what keeps noise from defeating an
 * otherwise correct command. Anything less than a port+token pair is not a
 * discoverable instance and degrades to "miss", so the caller falls back to
 * spawning.
 *
 * @param {string} text - the discover command's stdout.
 * @returns {{url: string, port: number, token: string}|null}
 */
export function parseDiscoveredUrl(text) {
  if (typeof text !== 'string' || text === '') return null
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /https?:\/\/[^\s"']+/.exec(lines[i])
    if (!m) continue
    let parsed
    try {
      parsed = new URL(m[0])
    } catch {
      continue
    }
    const port = Number(parsed.port)
    const token = parsed.searchParams.get('token') || ''
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    if (!token) continue
    // The tunnel always targets the remote LOOPBACK. Refuse a non-loopback
    // claim rather than sending its token to an unrelated local port that may
    // happen to answer HTTP (the launch/existingUrl contract is loopback too).
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '[::1]') continue
    return { url: m[0], port, token }
  }
  return null
}
/** Random ASCII tag so two attach sessions never share a remote log file. */
function randomTag() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)
}

/**
 * Build the one-shot remote command that launches `dsh web` detached and waits
 * for its startup line.
 *
 * `setsid` + `nohup` + redirected stdio are all required: the SSH channel closes
 * as soon as this shell exits, and without detaching the SIGHUP would kill the
 * server we just started. The loop is bounded so a wedged remote cannot hang the
 * call past the caller's own timeout, and it reports either the parsed line or
 * the log tail — never silence.
 *
 * @param {object} spec - launch parameters.
 * @param {boolean} [spec.omitNoOpen] - drop `--no-open`. Older DSH (measured on
 *   0.1.0-rc.6) has no such flag and exits with "unknown option '--no-open'";
 *   the caller retries with this set rather than assuming a flag exists.
 * @returns {string} a POSIX shell command line (no newlines, ASCII only).
 */
export function buildLaunchCommand({ command, profile, logPath, remotePort = 0, dshHome = '', waitSeconds = 45, omitNoOpen = false }) {
  const env = dshHome ? `DSH_HOME="${dshHome}" ` : ''
  const noOpen = omitNoOpen ? '' : ' --no-open'
  const args = `--profile ${profile} --port ${Number(remotePort) || 0}${noOpen}`
  const limit = Number(waitSeconds) || 45
  // The loop is ONE shell element: `do` is a keyword and `do;` is a syntax error
  // in POSIX sh, so it must be glued to the first command of the body rather
  // than separated like the other statements.
  const loop = `while [ $i -lt ${limit} ]; do grep -q 'token=' "$LOG" 2>/dev/null && break`
    + `; kill -0 $P 2>/dev/null || { echo ${DEAD_MARKER}; break; }`
    + `; sleep 1; i=$((i+1)); done`
  return [
    `LOG="$HOME/${logPath}"`,
    `: > "$LOG"`,
    // `command -v setsid` guards hosts without util-linux (macOS); plain nohup
    // still detaches from the channel's HUP there.
    `command -v setsid >/dev/null 2>&1 && SET=setsid || SET=`,
    `${env}$SET nohup ${command} ${args} >"$LOG" 2>&1 </dev/null & P=$!`,
    `i=0`,
    loop,
    `echo "${PID_MARKER}$P"`,
    `grep -m1 'dsh web:' "$LOG" 2>/dev/null`,
    `echo ${TAIL_MARKER}`,
    `tail -20 "$LOG" 2>/dev/null`,
  ].join('; ')
}

/** Extract the remote PID from launcher output (0 when absent). */
export function parseRemotePid(output) {
  const m = /__DSH_PID__=(\d+)/.exec(String(output || ''))
  return m ? Number(m[1]) : 0
}

/**
 * Recognize a known remote-side reason the web surface could not start, and
 * return an actionable sentence for it.
 *
 * The point is to keep an operator from reading "the remote DSH did not report a
 * startup token" and concluding the *plugin* is broken. Measured cause: dsh
 * ≤ 0.1.0-rc.6 depends on `node-pty@1.1.0`, whose published tarball ships
 * darwin/win32 prebuilds but **no `linux-x64`**, so `dsh web` cannot boot on
 * Linux at all — it dies loading the native module. 0.1.5-rc.2 moved to
 * `node-pty@1.2.0-beta.15`, which does ship Linux builds.
 *
 * @param {string} output - the remote log tail.
 * @returns {string} a hint, or '' when nothing is recognized.
 */
export function explainLaunchFailure(output) {
  const text = String(output || '')
  if (/pty\.node|Failed to load native module/i.test(text)) {
    return ' The remote could not load node-pty\'s native module. Known cause: dsh <= 0.1.0-rc.6'
      + ' depends on node-pty@1.1.0, which publishes no linux-x64 prebuild, so `dsh web` cannot start'
      + ' on Linux at all. Upgrade the remote dsh to 0.1.5-rc.2 or newer (node-pty@1.2.0-beta.15 ships'
      + ' the Linux build), or point `webAttachCommand` at a newer dsh installed elsewhere.'
  }
  if (/is intentionally not supported|--host 0\.0\.0\.0/i.test(text)) {
    return ' The remote dsh refused an all-interfaces bind. Attach deliberately never passes `--host`;'
      + ' check `webAttachCommand` does not add one.'
  }
  if (/command not found|No such file or directory|not found/i.test(text)) {
    return ' The remote shell could not run the dsh command. If the remote dsh is not on the SSH login'
      + ' PATH (a version manager or private prefix), set `webAttachCommand` to its absolute path.'
  }
  return ''
}

/**
 * Build the command that stops the remote process THIS session started.
 *
 * Two things make this less obvious than it looks, both found by running it
 * against a real host:
 *   1. The log path cannot identify the process — it appears only as a shell
 *      redirect, so it is absent from argv and `pkill -f <logfile>` matches
 *      nothing (the process survived, verified live).
 *   2. The PORT cannot identify it either, because we deliberately launch with
 *      `--port 0` (the remote picks a free port, and the chosen number is only
 *      known afterwards). A `--port 0` substring match therefore never fires.
 *
 * So the recorded PID is the handle, and the kill targets its process GROUP
 * (`kill -- -PID`): the launch goes through `setsid`, making the child a
 * session/group leader whose PGID equals its PID, so the group contains exactly
 * the process tree we started — never a sibling attach session and never the
 * user's own DSH. Before signalling, the command re-verifies that the PID still
 * exists and still looks like a `dsh` process, so a recycled PID belonging to an
 * unrelated program is not killed.
 *
 * @param {number} pid - the PID reported by the launch.
 * @param {string} [logPath] - this session's log file, removed after the kill so
 *   repeated attaches do not accumulate files in the remote home.
 * @returns {string} a POSIX shell command (always exits 0, never throws).
 */
export function buildStopCommand(pid, logPath = '') {
  const p = Number(pid) || 0
  const cleanup = logPath ? `; rm -f "$HOME/${logPath}" 2>/dev/null` : ''
  if (p < 1) return `true${cleanup}`
  return `P=${p}`
    + `; if [ -d "/proc/$P" ]; then`
    + ` C=$(tr '\\0' ' ' < "/proc/$P/cmdline" 2>/dev/null);`
    + ` case "$C" in *dsh*) kill -- -"$P" 2>/dev/null || kill "$P" 2>/dev/null;; esac;`
    + ` fi${cleanup}; true`
}

/**
 * One attached remote DSH Web UI: a local listener whose sockets are carried
 * over SSH to the remote's loopback web port.
 *
 * The listener is a plain `net.Server` + `client.forwardOut` pair — the same
 * mechanism `ForwardManager` uses for user-defined forwards. It is implemented
 * here rather than through that manager because this tunnel is bound to a
 * CHOSEN pool (the machine the user picked), whereas `ForwardManager` is wired
 * to the single "active machine" pool; routing an attach through it would send
 * the tunnel to whichever machine happened to be active.
 */
export class WebAttach {
  /**
   * @param {object} opts - injected collaborators (all optional in production).
   * @param {object} [opts.net] - a `node:net`-compatible module (tests).
   * @param {number} [opts.localPortStart] - first local port to try.
   * @param {number} [opts.localPortMax] - how many ports to try before failing.
   * @param {boolean} [opts.trackPool] - follow the pool across reconnects so a
   *   dropped SSH connection degrades to "disconnected" and then SELF-HEALS
   *   instead of being a permanent dead end (issue #54). `true` in production.
   */
  constructor(opts = {}) {
    this.net = opts.net || net
    // `??`, not `||`: port 0 is a MEANINGFUL value here (let the OS pick), and
    // `0 || 3088` silently turned "let the OS choose" into a bind on a fixed
    // port. An explicit 0 now survives, which is also what lets a test ask for a
    // port without risking a collision with something really listening.
    this.localPortStart = opts.localPortStart ?? 3088
    this.localPortMax = opts.localPortMax ?? 50
    /** Whether the pool's lifecycle hooks are ours to install. */
    this.trackPool = opts.trackPool !== false
    /** Issue #125 discovery budgets (injectable so tests need not wait 8s). */
    this.discoverTimeoutMs = opts.discoverTimeoutMs ?? DISCOVER_TIMEOUT_MS
    this.probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    /** @type {import('node:net').Server|null} */ this.server = null
    /** @type {Set<import('node:net').Socket>} */ this.sockets = new Set()
    /** @type {object|null} */ this.client = null
    /** The pool this session borrowed its connection from (may be null). */
    this.pool = null
    /** Pool hooks we installed, so close() can hand them back untouched. */
    this.prevOnReady = null
    this.prevOnCloseHook = null
    this.hookedPool = null
    this._installedOnReady = null
    this._installedOnClose = null
    this.attachedClient = null
    /** Bound listener, kept so it can be removed from the client. */
    this.onClientClose = null
    this.localPort = 0
    this.remotePort = 0
    this.token = ''
    this.tag = ''
    this.logPath = ''
    this.remotePid = 0
    this.machineId = ''
    this.command = ''
    this.startedAt = 0
    /**
     * Issue #125 outcome of the discovery step: '' when no discover command
     * was configured (or an explicit existingUrl bypassed it); otherwise
     * 'hit' (a live resident instance was adopted), 'miss', 'timeout',
     * 'error', or 'probe-failed' — the last four all mean "fell back to
     * spawning" and differ only in WHY, which the UI relays to the user.
     */
    this.discovery = ''
    /** Launch knobs remembered so a restart after a drop uses the same ones. */
    this.waitSeconds = 0
    this.omittedNoOpen = false
    /** True while a reconnect-triggered re-resolve is in flight. */
    this._resolving = false
    /** True once the borrowed connection has been lost (drives recovery). */
    this.connectionLost = false
    /** undefined = "not asked yet"; false = the remote process is provably gone. */
    this._remoteAlive = undefined
    /** Set by close(): nothing may re-arm the tunnel afterwards. */
    this.closed = false
    /** Set once the borrowed connection has gone away (see _clientLost). */
    this.lastError = ''
    /**
     * A listener that throws EARNS an 'error' event on the emitting object, and
     * an 'error' with no listener is itself fatal — the very crash this module
     * exists to prevent. Nothing here is expected to throw, but a lifecycle
     * callback running on someone else's event loop must never be the reason
     * the host process dies, so both hooks are wrapped.
     */
    this._onReady = (client) => { try { this._attach(client) } catch { /* never fatal */ } }
    this._onPoolClose = () => { try { this._clientLost('ssh connection closed') } catch { /* never fatal */ } }
  }

  /** Whether the tunnel is currently listening. */
  get active() {
    return this.server !== null
  }

  /**
   * Attach to a remote DSH Web UI.
   *
   * @param {object} spec - the attach request.
   * @param {object} spec.pool - the SshPool for the chosen machine.
   * @param {string} spec.machineId - machine id, for bookkeeping.
   * @param {string} [spec.command] - remote dsh executable (default `dsh`).
   * @param {string} [spec.profile] - DSH profile to boot (default `web`).
   * @param {string} [spec.existingUrl] - attach to an ALREADY running remote
   *   web UI instead of starting one: its `http://127.0.0.1:<port>/?token=…`.
   * @param {string} [spec.discoverCommand] - issue #125: run this on the remote
   *   FIRST; when it prints the URL of an already-running instance (and that
   *   instance answers a probe), attach to it instead of spawning. Every
   *   failure shape (no output, non-zero exit, timeout, dead instance) falls
   *   back to the normal launch, with `this.discovery` saying which happened.
   * @param {(cmd: string, opts?: object) => Promise<{stdout: string, code: number}>} [spec.exec]
   *   - remote exec, defaulting to `pool.exec`.
   * @returns {Promise<{url: string, localPort: number, remotePort: number}>}
   */
  async open(spec) {
    const {
      pool, machineId = '', command = 'dsh', profile = 'web',
      existingUrl = '', dshHome = '', waitSeconds = 45,
      discoverCommand = '',
    } = spec || {}
    if (!pool) throw new Error('web-attach: a machine pool is required')
    this.machineId = String(machineId || '')
    this.command = command
    this.waitSeconds = Number(waitSeconds) || 45

    const exec = spec.exec || ((cmd, opts) => pool.exec(cmd, opts))
    // Connecting first also surfaces credential/host-key problems BEFORE we
    // start a remote process we would then have to clean up. `_attach` (rather
    // than a bare assignment) is what subscribes to the connection's 'close',
    // so the loss is noticed the moment it happens instead of on the next
    // request — which is when the old code let ssh2 throw 'Not connected' from
    // inside a socket callback and take the host process with it (issue #54).
    this._attach(await pool.connect())
    this._followPool(pool)

    if (existingUrl) {
      const parsed = parseWebStart(`dsh web: ${existingUrl}`)
      if (!parsed) {
        throw new Error('web-attach: existing URL must look like http://127.0.0.1:<port>/?token=<token>')
      }
      this.remotePort = parsed.port
      this.token = parsed.token
    } else {
      // Issue #125: with a discover command configured, ask the remote whether
      // a resident instance already runs BEFORE spawning a twin that would
      // share its DSH_HOME. A hit adopts the existing-instance posture
      // (hands-off: no PID of ours, nothing to stop on close); every other
      // outcome falls through to the normal launch.
      if (String(discoverCommand || '').trim()) {
        // pool.exec normally pipes commands through Git Bash on a Windows
        // remote that has it. That is right for the plugin's POSIX scripts but
        // wrong for a USER discover command, whose whole point is that it may
        // be PowerShell. Use the pool's unwrapped exec for this one command.
        const discoverExec = spec.exec || await this._loginShellExec(pool, exec)
        await this._discoverFirst(discoverExec, String(discoverCommand).trim())
      }
      if (this.discovery !== 'hit') {
        this.tag = randomTag()
        const logPath = `${LOG_NAME}-${this.tag}.log`
        this.logPath = logPath
        const timeoutMs = Math.max(30000, (waitSeconds + 20) * 1000)
        let out = String(await this._launch(exec, { command, profile, logPath, dshHome, waitSeconds, timeoutMs }, false))
        // Older DSH (0.1.0-rc.6) has no `--no-open` and exits on the unknown flag
        // before doing anything. Retry once without it: `--no-open` is a nicety
        // (it stops the REMOTE from opening its own browser), not a requirement,
        // and a bounded single retry is safe because the first attempt provably
        // never started a server.
        if (launchFailed(out) && /unknown option/i.test(out) && /--no-open/.test(out)) {
          out = String(await this._launch(exec, { command, profile, logPath, dshHome, waitSeconds, timeoutMs }, true))
          this.omittedNoOpen = true
        }
        this.remotePid = parseRemotePid(out)
        const tail = out.split(TAIL_MARKER).slice(1).join(TAIL_MARKER).trim()
        // Both failure shapes carry the same diagnostics: the process either died
        // (its output is the whole story) or is still booting after the deadline.
        if (launchFailed(out)) {
          // The remote process is already gone — nothing to clean up.
          throw new Error('web-attach: the remote DSH exited during startup.'
            + explainLaunchFailure(tail || out)
            + ` ${tail || 'no output'}`)
        }
        const parsed = parseWebStart(out)
        if (!parsed) {
          // A timed-out launch may STILL be booting: the deadline expiring is not
          // evidence the process died. Kill it before throwing, or every retry
          // leaks another remote server (measured: three leftover `dsh --port 0`
          // processes after three failed attaches). A PID of 0 means the launcher
          // could not report one — nothing to target.
          if (this.remotePid > 0) {
            try {
              await execPosix(exec, buildStopCommand(this.remotePid, logPath), { timeoutMs: 20000 })
              this.remotePid = 0
            } catch { /* the process may already be gone; a leftover is worse than a failed kill attempt only if it repeats, and the next attach replaces this session */ }
          }
          throw new Error(
            `web-attach: the remote DSH did not report a startup token within ${waitSeconds}s.`
            + ` Check that \`${command}\` exists on the remote and can boot a web profile.`
            + explainLaunchFailure(tail || out)
            + (tail ? ` Remote output: ${tail}` : ''),
          )
        }
        this.remotePort = parsed.port
        this.token = parsed.token
      }
    }

    await this._listen()
    this.startedAt = Date.now()
    return this.describe()
  }

  /**
   * Run one launch attempt and return its raw output.
   *
   * @param {(cmd: string, opts?: object) => Promise<{stdout: string}>} exec - remote exec.
   * @param {object} d - launch parameters plus the exec timeout.
   * @param {boolean} omitNoOpen - drop `--no-open` for old DSH.
   * @returns {Promise<string>} the launcher's stdout.
   */
  async _launch(exec, d, omitNoOpen) {
    const cmd = buildLaunchCommand({ ...d, omitNoOpen })
    const res = await execPosix(exec, cmd, { timeoutMs: d.timeoutMs })
    return String(res && res.stdout ? res.stdout : '')
  }

  /**
   * Resolve an exec that preserves the remote LOGIN shell for a user command.
   *
   * SshPool.exec transparently pipes every command to Git Bash when a Windows
   * remote has it (so the plugin's own POSIX scripts work there). Discovery is
   * different: the operator supplies the command specifically for that host's
   * shell, e.g. `powershell -NoProfile …`. `_execRaw` is the pool's documented
   * no-detection/no-wrapper path. A test-injected exec is left untouched.
   *
   * @param {object} pool - the selected machine's pool.
   * @param {(cmd: string, opts?: object) => Promise<object>} fallback - pool.exec.
   */
  async _loginShellExec(pool, fallback) {
    if (!pool || typeof pool.detect !== 'function' || typeof pool._execRaw !== 'function') return fallback
    try { await pool.detect() } catch { return fallback }
    if (pool.platform === 'windows' && pool.gitBashPath) {
      return (cmd, opts) => pool._execRaw(cmd, opts)
    }
    return fallback
  }

  /**
   * The issue #125 discovery step: adopt a resident instance when one answers,
   * otherwise record WHY not and let open() fall back to launching.
   *
   * A printed URL is a CLAIM, not evidence — the instance may have died after
   * the discover command's source learned the address (a stale URL file, a
   * crashed-but-never-cleaned supervisor record). Attaching to that corpse
   * would hand the user a dead tab, so the hit only stands when the address
   * also answers a cheap HTTP probe; a failed probe demotes to
   * 'probe-failed', which is a spawn outcome.
   *
   * @param {(cmd: string, opts?: object) => Promise<{stdout: string}>} exec
   * @param {string} command - the user-supplied discover command.
   */
  async _discoverFirst(exec, command) {
    const found = await this._discoverRunning(exec, command)
    this.discovery = found.status
    if (!found.parsed) return
    if (await this._probeRemoteWeb(found.parsed.port)) {
      this.remotePort = found.parsed.port
      this.token = found.parsed.token
      this.discovery = 'hit'
    } else {
      this.discovery = 'probe-failed'
    }
  }

  /**
   * Run the user-supplied discover command and classify what came back.
   *
   * The command goes through the pool's RAW exec — NOT {@link execPosix}: it is
   * written for the remote's OWN shell (that is exactly what makes PowerShell
   * one-liners on Windows remotes usable), with the same semantics as an
   * rw_exec line. Three deliberate properties:
   *   • bounded — the exec carries a hard timeout (default 8s): discovery may
   *     delay a spawn by seconds, never hang it;
   *   • quiet — every failure shape resolves to a status string; nothing here
   *     throws, because "no resident instance" is a normal answer, not an
   *     exceptional one;
   *   • hygienic — the result NEVER carries stdout/stderr: a discovered URL
   *     bears a live login token, and this outcome travels onwards as the
   *     `discovery` diagnostic (responses, audit context). Only the parsed
   *     (port, token) facts survive.
   *
   * @returns {Promise<{status: 'hit'|'miss'|'timeout'|'error', parsed?: object, reason?: string}>}
   */
  async _discoverRunning(exec, command) {
    let res
    try {
      res = await exec(command, { timeoutMs: this.discoverTimeoutMs })
    } catch (err) {
      return { status: 'error', reason: String((err && err.message) || err) }
    }
    // pool.exec RESOLVES deadlines and caller aborts (code -1 + signal name)
    // instead of rejecting — both mean "no answer within the budget".
    if (res && (res.signal === 'TIMEOUT' || res.signal === 'ABORTED')) return { status: 'timeout' }
    const parsed = parseDiscoveredUrl(res && res.stdout)
    if (parsed) return { status: 'hit', parsed }
    // No URL printed. A non-zero exit here is usually a "nothing found" answer
    // (pgrep/test/grep all exit 1 on absence) — a MISS. Only the shell's own
    // "cannot run this" codes (126 not-executable / 127 not-found) say the
    // command itself is broken, which the operator should see as an error
    // rather than as "no resident instance".
    const code = res && typeof res.code === 'number' ? res.code : 0
    if (code === 126 || code === 127) return { status: 'error', reason: `the discover command itself failed (exit ${code})` }
    return { status: 'miss' }
  }

  /**
   * Speak one minimal HTTP request to the claimed remote port — through the
   * SAME forwardOut path real traffic will use — and accept any HTTP status
   * line as "alive": 200, a redirect, even a 401 all prove a listening server,
   * while a refused, hung or non-HTTP socket proves none. The token is NOT
   * sent: liveness does not need it, and keeping it out of the probe keeps it
   * out of the remote server's request log.
   *
   * @param {number} port - the claimed remote loopback port.
   * @returns {Promise<boolean>}
   */
  _probeRemoteWeb(port) {
    return new Promise((resolve) => {
      let settled = false
      let channel = null
      let timer = null
      const finish = (ok) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (channel) {
          try { if (typeof channel.close === 'function') channel.close() } catch { /* already gone */ }
          try { if (typeof channel.destroy === 'function') channel.destroy() } catch { /* already gone */ }
        }
        resolve(ok)
      }
      timer = setTimeout(() => finish(false), this.probeTimeoutMs)
      const client = this.client
      if (!client || typeof client.forwardOut !== 'function') return finish(false)
      try {
        // ssh2 throws SYNCHRONOUSLY on a dead connection instead of calling
        // back (see _pipe), so this call itself sits inside the try.
        client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (err, ch) => {
          if (err || !ch) return finish(false)
          channel = ch
          ch.on('error', () => finish(false))
          // A close before any answer means the server spoke nothing HTTP.
          ch.on('close', () => finish(false))
          ch.on('data', (buf) => finish(/^HTTP\/1\.[01] \d{3}/.test(String(buf))))
          try {
            ch.write(`GET / HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\nUser-Agent: dsh-remote-discover\r\n\r\n`)
          } catch { finish(false) }
        })
      } catch { finish(false) }
    })
  }

  /** Bind the local listener, advancing past ports already in use. */
  async _listen() {
    let lastError = null
    for (let i = 0; i < this.localPortMax; i++) {
      const port = this.localPortStart + i
      try {
        await this._listenOn(port)
        this.localPort = port
        return
      } catch (err) {
        lastError = err
        // Only a taken port is worth retrying; anything else (permissions,
        // an unusable interface) will not be fixed by the next number.
        if (err && err.code !== 'EADDRINUSE') break
      }
    }
    throw new Error(
      `web-attach: no free local port in ${this.localPortStart}..${this.localPortStart + this.localPortMax - 1}`
      + (lastError ? ` (${lastError.code || lastError.message})` : ''),
    )
  }

  _listenOn(port) {
    return new Promise((resolve, reject) => {
      const server = this.net.createServer((socket) => this._pipe(socket))
      const onError = (err) => {
        server.removeListener('listening', onListening)
        try { server.close() } catch { /* never listened */ }
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        // A post-bind error must not crash the host process: report and drop
        // the tunnel so the UI can show "disconnected" instead of dying.
        server.on('error', (err) => {
          this.server = null
          this.lastError = String((err && err.message) || err)
        })
        this.server = server
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // Loopback only: this endpoint reaches a full remote harness, so it must
      // never be reachable from the network even on a LAN-facing machine.
      server.listen(port, '127.0.0.1')
    })
  }

  /**
   * Borrow the given connection AND subscribe to its lifecycle.
   *
   * Idempotent for the same client (open() calls it once, the pool's `onReady`
   * calls it again on every reconnect), and it always drops the previous
   * client's listener first, so one session never accumulates listeners.
   *
   * @param {object|null} client - the live ssh2 client / OpenSshConnection.
   */
  _attach(client) {
    if (!client) return
    if (this.attachedClient && this.attachedClient !== client && this.onClientClose) {
      // A different client replaced the one we borrowed (pool reconnect). Stop
      // listening to the old one; its own 'close' has either fired already or
      // belongs to a connection nobody uses any more.
      try { this.attachedClient.removeListener('close', this.onClientClose) } catch { /* already gone */ }
    }
    this.client = client
    if (this.attachedClient === client) return
    this.attachedClient = client
    this.onClientClose = () => { this._clientLost('ssh connection closed') }
    // Without this, the object keeps handing out a connection that is already
    // closed, and `forwardOut` then throws SYNCHRONOUSLY (issue #54).
    try { client.on('close', this.onClientClose) } catch { /* not an emitter: nothing to watch */ }
  }

  /** The borrowed connection is gone: keep the session, drop the dead handle. */
  _clientLost(reason) {
    this.client = null
    this.connectionLost = true
    this.lastError = String(reason || 'ssh connection closed')
  }

  /**
   * Register lifecycle hooks on the chosen pool so this tunnel follows it.
   *
   * The pool is the one place that both NOTICES a dead connection and later
   * obtains a fresh one, and it exposes exactly two hooks for that:
   *   • `onCloseHook` — fires from `close()` and `invalidate()` (the latter is
   *     the "channel open failed, the pooled connection died server-side"
   *     self-heal path, which is the likeliest trigger);
   *   • `onReady` — fires after a successful (re)connect.
   *
   * Both are SINGLE-SLOT properties that the plugin already uses for
   * `ForwardManager` (index.js), so this session CHAINS them rather than
   * clobbering the forwards manager, and `_detachPool()` restores exactly what
   * was there — the plugin may legitimately have none, one, or both.
   *
   * A real reconnect is the only way the remote port can move, so once the pool
   * reports a new connection we must re-resolve (token, port) from the remote
   * log. `onReady` itself cannot await: the pool fires it with the client in
   * hand, so the re-resolve is kicked off and its failure is recorded rather
   * than thrown into the pool's callback.
   *
   * @param {object} pool - the pool this session attached through.
   */
  _followPool(pool) {
    if (!this.trackPool || this.closed || !pool || this.hookedPool === pool) return
    this._detachPool()
    this.pool = pool
    this.hookedPool = pool
    const prevReady = typeof pool.onReady === 'function' ? pool.onReady : null
    const prevClose = typeof pool.onCloseHook === 'function' ? pool.onCloseHook : null
    this.prevOnReady = prevReady
    this.prevOnCloseHook = prevClose
    const installedReady = (client) => {
      this._attach(client)
      if (prevReady) { try { prevReady(client) } catch { /* the forwards manager's problem, not ours */ } }
      // A reconnect lands on a NEW remote process only if the old one died with
      // the machine; re-read the log to find out which. The re-resolve runs off
      // the event loop because the pool cannot await it — a hook that throws
      // would earn an 'error' event on the pool, and an unhandled rejection
      // would be fatal.
      if (!this.closed && this.remotePort && !this._resolving) {
        this._resolving = true
        Promise.resolve()
          .then(() => this._refreshRemotePort())
          .catch((err) => { this.lastError = String((err && err.message) || err) })
          .then(() => { this._resolving = false })
      }
    }
    const installedClose = () => {
      this._clientLost('ssh connection closed')
      if (prevClose) { try { prevClose() } catch { /* never mask our own report */ } }
    }
    this._installedOnReady = installedReady
    this._installedOnClose = installedClose
    pool.onReady = installedReady
    pool.onCloseHook = installedClose
  }

  /**
   * Hand the pool's hooks back.
   *
   * Each slot is restored ONLY when it still holds the wrapper this session
   * installed. The pool's hooks are single-slot, so if something else has taken
   * the slot over in the meantime, putting a stale callback back would be worse
   * than leaving it alone — it would silently disconnect a newer owner.
   */
  _detachPool() {
    const pool = this.hookedPool
    const mineReady = this._installedOnReady
    const mineClose = this._installedOnClose
    this.hookedPool = null
    this._installedOnReady = null
    this._installedOnClose = null
    if (!pool) return
    if (mineReady && pool.onReady === mineReady) pool.onReady = this.prevOnReady
    if (mineClose && pool.onCloseHook === mineClose) pool.onCloseHook = this.prevOnCloseHook
    this.prevOnReady = null
    this.prevOnCloseHook = null
  }

  /**
   * True when the borrowed connection was LOST and this is a session we can
   * recover: we launched the remote process ourselves (so we hold its PID and
   * log) and the tunnel is listening (so clients can actually be served).
   *
   * The `connectionLost` flag is deliberately separate from `this.client`: the
   * pool's `onReady` re-attaches the new client BEFORE the re-resolve runs, so a
   * check on `!this.client` would be false by then and recovery would never
   * happen.
   */
  get _needsReResolve() {
    return !!(this.connectionLost && !this.closed && this.logPath && this.remotePid && this.localPort)
  }

  /**
   * Re-resolve the remote port after a reconnect, restarting the remote `dsh web`
   * when it did not survive.
   *
   * Reaching a remote process needs a live SSH connection, so this reconnects
   * through the pool first — the pool reports `onReady` for that same client in
   * production, and in a test double the callback simply never fires.
   */
  async _refreshRemotePort() {
    if (!this._needsReResolve) return
    const pool = this.pool
    if (!pool || (typeof pool.connect !== 'function' && typeof pool.exec !== 'function')) return
    const exec = (cmd, opts) => (typeof pool.exec === 'function'
      ? pool.exec(cmd, opts)
      : Promise.reject(new Error('web-attach: the pool cannot run commands')))
    if (!this.client) await pool.connect()
    const match = await this._resolveRemotePort(exec)
    this.remotePort = match.port
    if (match.token) this.token = match.token
    this.connectionLost = false
    this.lastError = ''
  }

  /**
   * Read this session's remote log and decide which port is live.
   *
   * The startup line is the ONLY source of the port (the launch deliberately
   * uses `--port 0`), so after the remote process died and was restarted the log
   * holds BOTH lines — the dead one and the new one — and neither position
   * identifies the live one. Evidence decides:
   *   • a process that is still alive on the remote is probed first, and when
   *     the port it is LISTENING on is one of the logged ports, that is the
   *     answer (the `dsh web: …` line names its own port, so this is a
   *     confirmation rather than a second guess);
   *   • otherwise the newest logged port wins, which is right in every
   *     single-process case and is the best available answer while the remote is
   *     still booting (the next reconnect retries).
   *
   * @param {(cmd: string, opts?: object) => Promise<{stdout: string}>} exec - remote exec.
   * @returns {Promise<{port: number, token: string, restarted: boolean}>}
   */
  async _resolveRemotePort(exec) {
    this._remoteAlive = await this._remoteProcessAlive(exec)
    if (!this._remoteAlive) return this._restartRemote(exec)

    let out = ''
    try {
      const res = await execPosix(exec, `cat "$HOME/${this.logPath}" 2>/dev/null`, { timeoutMs: 15000 })
      out = String((res && res.stdout) || '')
    } catch { /* an unreadable log: the listening probe below is the fallback */ }
    const lines = [...out.matchAll(/dsh web:\s*(http:\/\/[^\s]+)/g)]
      .map((m) => parseWebStart(`dsh web: ${m[1]}`))
      .filter(Boolean)

    // What the recorded process actually listens on beats any guess from the
    // log, because a killed-and-restarted remote leaves BOTH startup lines in
    // the log and neither position says which one is live.
    const listening = await this._listeningRemotePort(exec)
    if (listening) {
      const match = lines.find((l) => l.port === listening)
      return { port: listening, token: (match && match.token) || this.token, restarted: false }
    }
    if (lines.length) {
      const newest = lines[lines.length - 1]
      return { port: newest.port, token: newest.token, restarted: false }
    }
    // Alive but silent and not listening yet: the remote is booting. Keep the
    // last known port and let the next reconnect re-resolve.
    return { port: this.remotePort, token: this.token, restarted: false }
  }

  /**
   * Whether the remote process THIS session started still exists.
   *
   * Verified through `/proc`, which is Linux-only; a host that cannot answer (or
   * a failed probe) is treated as ALIVE on purpose. Restarting a server that was
   * never dead would spawn a second one and leak a port, whereas assuming life
   * merely retries a port that turns out to be stale.
   *
   * @param {(cmd: string, opts?: object) => Promise<{stdout: string}>} exec - remote exec.
   * @returns {Promise<boolean>}
   */
  async _remoteProcessAlive(exec) {
    const pid = Number(this.remotePid) || 0
    if (pid < 1) return true
    try {
      const res = await execPosix(
        exec,
        `if [ -d /proc ]; then { [ -d /proc/${pid} ] && echo ALIVE; } || echo GONE; else echo ALIVE; fi`,
        { timeoutMs: 15000 },
      )
      return !/GONE/.test(String((res && res.stdout) || ''))
    } catch { return true }
  }

  /**
   * Ask the remote which loopback port the recorded PID listens on (0 = none).
   *
   * Two `/proc` reads are needed because a TCP listener appears in a socket
   * table (`/proc/net/tcp{,6}`), not in that process's link list: the fd
   * symlinks give the socket INODE, and the table maps that inode to a port.
   * Matching on the inode rather than the port is what makes this an
   * observation instead of a second guess.
   */
  async _listeningRemotePort(exec) {
    const pid = Number(this.remotePid) || 0
    if (pid < 1) return 0
    let inodes = ''
    try {
      // `ls -l` on a process's own fds needs no privileges for the same uid.
      const res = await execPosix(
        exec,
        `ls -l /proc/${pid}/fd 2>/dev/null | sed -n 's/.*socket:\\[\\([0-9]*\\)\\].*/\\1/p' | sort -u | tr '\\n' ' '`,
        { timeoutMs: 15000 },
      )
      inodes = String((res && res.stdout) || '').trim()
    } catch { return 0 }
    if (!inodes) return 0
    const want = new Set(inodes.split(/\s+/).filter(Boolean))
    // `/proc/net/tcp` addresses are little-endian hex, so loopback is
    // `0100007F` (v4) and `00000000000000000000000001000000` (v6 `::1`).
    const LOOPBACK = new Set(['0100007F', '00000000000000000000000001000000'])
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let text = ''
      try {
        const res = await execPosix(exec, `cat ${file} 2>/dev/null`, { timeoutMs: 15000 })
        text = String((res && res.stdout) || '')
      } catch { continue }
      for (const line of text.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/)
        // sl local_address rem_address st tx:rx tr:tm->when retrnsmt uid timeout inode
        if (cols.length < 10) continue
        if (cols[3] !== '0A') continue // TCP_LISTEN
        if (!want.has(cols[9])) continue
        const [addr, portHex] = String(cols[1]).split(':')
        if (!LOOPBACK.has(String(addr).toUpperCase())) continue
        const port = parseInt(portHex, 16)
        if (Number.isInteger(port) && port > 0 && port < 65536) return port
      }
    }
    return 0
  }

  /**
   * Relaunch the remote `dsh web` because the previous process is gone.
   *
   * A restart CANNOT change the listening port locally, and a caller holding a
   * stale port silently talks to the wrong place at worst and hangs at best, so
   * the two facts the caller needs are checked: this is a session that launched
   * its own process (an attach onto someone else's DSH stays hands-off and can
   * never restart it), and recovery is possible at all (`_refreshRemotePort`
   * has already returned early when it is not).
   */
  async _restartRemote(exec) {
    const command = this.command || 'dsh'
    const waitSeconds = this.waitSeconds || 45
    const timeoutMs = Math.max(30000, (waitSeconds + 20) * 1000)
    let out = String(await this._launch(exec, { command, profile: 'web', logPath: this.logPath, waitSeconds, timeoutMs }, this.omittedNoOpen === true))
    if (launchFailed(out) && /unknown option/i.test(out) && /--no-open/.test(out)) {
      out = String(await this._launch(exec, { command, profile: 'web', logPath: this.logPath, waitSeconds, timeoutMs }, true))
      this.omittedNoOpen = true
    }
    this.remotePid = parseRemotePid(out) || this.remotePid
    const parsed = parseWebStart(out)
    if (!parsed) {
      const tail = out.split(TAIL_MARKER).slice(1).join(TAIL_MARKER).trim()
      throw new Error('web-attach: the remote DSH could not be restarted after the SSH'
        + ' connection dropped.' + explainLaunchFailure(tail || out) + (tail ? ` Remote output: ${tail}` : ''))
    }
    return { port: parsed.port, token: parsed.token, restarted: true }
  }

  /** Carry one local socket to the remote web port over SSH. */
  _pipe(socket) {
    if (!this.client) { try { socket.destroy() } catch { /* already gone */ } return }
    // ssh2's forwardOut does NOT report a dead connection through its callback:
    // when the socket is gone it THROWS 'Not connected' synchronously
    // (ssh2/lib/client.js: `if (!this._sock || !isWritable(this._sock)) throw`)
    // and the callback below is never reached — so `if (err)` cannot guard this
    // path. Uncaught, that throw travels net.Server → TCP.onconnection and kills
    // the whole host process (issue #54: every page refresh after the pooled
    // connection dropped took the session, the browser and the remote orphan
    // down with it). A dead tunnel is a UI state, not a reason to exit.
    try {
      this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', this.remotePort, (err, channel) => {
        if (err) { try { socket.destroy() } catch { /* already gone */ } return }
        this.sockets.add(socket)
        socket.pipe(channel)
        channel.pipe(socket)
        const kill = () => {
          try { socket.destroy() } catch { /* already gone */ }
          try { channel.close() } catch { /* already closed */ }
          this.sockets.delete(socket)
        }
        socket.on('error', kill)
        channel.on('error', kill)
        socket.on('close', kill)
        channel.on('close', kill)
      })
    } catch (err) {
      this._clientLost(String((err && err.message) || err))
      try { socket.destroy() } catch { /* already gone */ }
    }
  }

  /**
   * The URL to open, carrying the one-time launch token.
   *
   * The token is a credential, so it stays on loopback and is never sent
   * anywhere; DSH exchanges it for a 30-day signed cookie on the first request
   * and redirects to a clean `/`.
   */
  get url() {
    return `http://127.0.0.1:${this.localPort}/?token=${this.token}`
  }

  /** The clean URL (no token) — what the address bar shows after the exchange. */
  get cleanUrl() {
    return `http://127.0.0.1:${this.localPort}/`
  }

  /** Serializable status for the settings UI. */
  describe() {
    return {
      machineId: this.machineId,
      url: this.url,
      cleanUrl: this.cleanUrl,
      token: this.token,
      localPort: this.localPort,
      remotePort: this.remotePort,
      active: this.active,
      startedAt: this.startedAt,
      // Only a process we launched can be stopped by us; an attach onto the
      // user's own running instance is deliberately hands-off.
      managed: this.remotePid > 0,
      // Issue #125: '' = discovery not attempted; otherwise the outcome the
      // UI relays ("未发现常驻实例，已新起一个" / "复用了常驻实例").
      discovery: this.discovery || '',
      error: this.lastError || '',
    }
  }

  /**
   * Tear the tunnel down. The remote process is left running by default: the
   * user may be using that DSH elsewhere, and silently killing a process we did
   * not start is worse than a leftover one. `stopRemote` opts in.
   *
   * @param {object} [opts] - close options.
   * @param {boolean} [opts.stopRemote] - also terminate the remote process.
   * @param {(cmd: string) => Promise<unknown>} [opts.exec] - remote exec.
   */
  async close({ stopRemote = false, exec } = {}) {
    // Stop following the pool BEFORE any await: a reconnect landing mid-teardown
    // must not re-arm the tunnel this call is in the middle of closing.
    this._detachPool()
    if (this.attachedClient && this.onClientClose) {
      try { this.attachedClient.removeListener('close', this.onClientClose) } catch { /* already gone */ }
    }
    this.attachedClient = null
    this.onClientClose = null
    this.pool = null
    for (const socket of [...this.sockets]) {
      try { socket.destroy() } catch { /* already gone */ }
    }
    this.sockets.clear()
    const server = this.server
    this.server = null
    if (server) await new Promise((resolve) => server.close(() => resolve()))
    // Only a process we started has a recorded PID; an attach to the user's own
    // running instance must never signal anything.
    if (stopRemote && exec && this.remotePid) {
      await Promise.resolve(execPosix(exec, buildStopCommand(this.remotePid, this.logPath))).catch(() => {})
    }
    this.client = null
    // The recorded PID and log path are FACTS about this session (the UI shows
    // them, and `stopRemote` addresses them), so they survive; `closed` is what
    // stops recovery work from being re-armed after teardown.
    this.closed = true
  }
}
