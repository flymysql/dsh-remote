// Persistent SSH/SFTP connection pool (one identity → one live client).
import ssh2 from 'ssh2'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { truncate } from './paths.js'
import { createHostKeyGuard } from './hostkey.js'
import { buildSftpSurface } from './sftp-surface.js'
import { SystemOpenSshPool, isSystemOpenSshBackend } from './openssh.js'

const { Client } = ssh2

/**
 * Build the pool for a config.
 *
 * Two backends exist (issue #51): the native one below, which speaks SSH itself
 * via ssh2, and the "system OpenSSH" one (lib/openssh.js), which delegates to
 * the local `ssh` executable so GSSAPI/Kerberos and the rest of the user's
 * `~/.ssh/config` are honoured. Both expose one identical surface, so every
 * caller can keep using `new SshPool(...)`-shaped code — this factory only has
 * to decide which class to instantiate.
 */
export function createPool(config, opts) {
  return isSystemOpenSshBackend(config)
    ? new SystemOpenSshPool(config, opts)
    : new SshPool(config, opts)
}

/**
 * Run one `forwardOut` and resolve with the resulting channel.
 *
 * ssh2 reports a dead connection by THROWING synchronously —
 * `if (!this._sock || !isWritable(this._sock)) throw new Error('Not connected')`
 * (ssh2 >= 1.16, `Client.forwardOut`) — and never calls the callback, so a
 * callback-only error path cannot guard this call (issue #54). Two further
 * consequences justify a shared helper rather than an inline try/catch:
 *
 *   • inside a `new Promise(executor)` a bare throw rejects nothing: it becomes
 *     an unhandled REJECTION and leaves the promise pending forever;
 *   • called from a `net.Server` connection handler the throw escapes to the
 *     process top level and kills the host.
 *
 * This guards the CALLER's side of the contract rather than assuming one
 * backend's behaviour: the system-OpenSSH backend (lib/openssh.js `forwardOut`)
 * already converts its own spawn failure into a callback error, so for it the
 * try/catch below is dead code — but a backend is free to throw, and the one
 * that does must not be able to take the process down.
 *
 * @param {object} client - an ssh2 Client or OpenSshConnection.
 * @param {object} spec - `srcHost`/`srcPort`/`dstHost`/`dstPort`.
 * @returns {Promise<object>} the forwarded channel / duplex stream.
 */
export function forwardOutChannel(client, { srcHost = '127.0.0.1', srcPort = 0, dstHost, dstPort }) {
  return new Promise((resolve, reject) => {
    // `reject` is called at most once: a callback that fires after a successful
    // throw-path rejection would be a no-op, which Promise guarantees.
    try {
      client.forwardOut(srcHost, srcPort, dstHost, dstPort, (err, channel) => (err ? reject(err) : resolve(channel)))
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * The ACTIVE pool: one long-lived object whose concrete implementation can be
 * swapped when the current machine's transport backend changes.
 *
 * Why a delegating facade instead of just constructing the right class once:
 * `backend` is a PER-MACHINE field (an enterprise Kerberos host needs
 * `openssh` while every other machine stays on `native`), but the plugin keeps
 * exactly one active pool for its whole lifetime and hangs `passwordResolver` /
 * `onReady` / `onCloseHook` off it once at startup. Replacing the object
 * wholesale on every machine switch would silently drop those hooks — the port
 * forwards and keychain passwords would stop working after the first switch.
 *
 * So the facade owns the hooks and the shared `config` object, and forwards
 * them to whichever concrete pool is right for the current config. Everything
 * else is a straight delegation, which is why callers cannot tell the
 * difference (and why the class is deliberately not part of the public story).
 */
export class ActivePool {
  constructor(config, opts = {}) {
    this.config = config
    this.opts = opts
    // The hooks are assigned by the plugin AFTER construction, so they are
    // stored here and re-applied to every delegate this facade ever creates.
    this._passwordResolver = null
    this._onReady = null
    this._onCloseHook = null
    this._delegate = null
    this._sync()
  }

  /** Which concrete class the current config asks for. */
  _wantsSystemOpenSsh() {
    return isSystemOpenSshBackend(this.config)
  }

  _delegateIsCurrent() {
    if (!this._delegate) return false
    const isOpenssh = this._delegate instanceof SystemOpenSshPool
    return isOpenssh === this._wantsSystemOpenSsh()
  }

  /** Create (or replace) the delegate so it matches the current config. */
  _sync() {
    if (this._delegateIsCurrent()) return this._delegate
    const previous = this._delegate
    const next = createPool(this.config, this.opts)
    next.passwordResolver = this._passwordResolver
    next.onReady = this._onReady
    next.onCloseHook = this._onCloseHook
    this._delegate = next
    // Tear the old backend down LAST, and never let a teardown error mask the
    // new pool: the connection it was holding belongs to the old host anyway.
    if (previous) { try { previous.close() } catch { /* already gone */ } }
    return next
  }

  get delegate() { return this._sync() }

  // ── hooks: stored here, mirrored onto every delegate ──────────────────────
  get passwordResolver() { return this._passwordResolver }
  set passwordResolver(fn) {
    this._passwordResolver = fn
    if (this._delegate) this._delegate.passwordResolver = fn
  }
  get onReady() { return this._onReady }
  set onReady(fn) {
    this._onReady = fn
    if (this._delegate) this._delegate.onReady = fn
  }
  get onCloseHook() { return this._onCloseHook }
  set onCloseHook(fn) {
    this._onCloseHook = fn
    if (this._delegate) this._delegate.onCloseHook = fn
  }

  // ── pass-through state the plugin reads directly ──────────────────────────
  get client() { return this._delegate ? this._delegate.client : null }
  // Assignable because the plugin's own tests arm a fake live connection on the
  // active pool; a getter-only facade would make that assignment a silent
  // no-op in sloppy mode and a TypeError in the strict-mode ESM tests.
  set client(v) { if (this._sync()) this._delegate.client = v }
  get connecting() { return this._delegate ? this._delegate.connecting : null }
  get proxyPool() { return this._delegate ? this._delegate.proxyPool : null }
  get epoch() { return this._delegate ? this._delegate.epoch : 0 }
  get platform() { return this._delegate ? this._delegate.platform : 'unknown' }
  set platform(v) { if (this._sync()) this._delegate.platform = v }
  get gitBashPath() { return this._delegate ? this._delegate.gitBashPath : '' }
  set gitBashPath(v) { if (this._sync()) this._delegate.gitBashPath = v }
  get shellMode() { return this._delegate ? this._delegate.shellMode : 'native' }
  set shellMode(v) { if (this._sync()) this._delegate.shellMode = v }

  // ── delegated operations ──────────────────────────────────────────────────
  /** Re-point at a new target, switching backend first if the machine asks. */
  setTarget(fields, previous) {
    // The backend may have changed with the machine, so apply that part of the
    // request to `config` BEFORE picking the delegate: _sync() chooses the class
    // from config.backend, and the old backend must not be handed a host it can
    // no longer reach. The delegate then receives the whole request as usual.
    if (fields && fields.backend !== undefined) this.config.backend = String(fields.backend)
    if (fields && fields.sshBinary !== undefined) this.config.sshBinary = String(fields.sshBinary)
    const d = this._sync()
    return d.setTarget(fields, previous)
  }
  connect() { return this.delegate.connect() }
  exec(cmd, opts) { return this.delegate.exec(cmd, opts) }
  sftp() { return this.delegate.sftp() }
  detect() { return this.delegate.detect() }
  invalidate() { return this.delegate.invalidate() }
  close() { return this.delegate.close() }
}

export class SshPool {
  constructor(config, opts = {}) {
    this.config = config
    this._knownHostsFile = opts.knownHostsFile
    this.client = null
    this.connecting = null
    this.proxyPool = null
    // Generational token: bumped on every target change / close so a stale
    // in-flight connect can never hand this pool a connection to an old host.
    this.epoch = 0
    /** Auto-detected remote platform: unknown | windows | posix (per target). */
    this.platform = 'unknown'
    /** Resolved Git Bash bash.exe path on Windows remotes ('' when none). */
    this.gitBashPath = ''
    /** Resolved terminal strategy: native | git-bash. */
    this.shellMode = 'native'
    /** In-flight platform detection promise (cached). */
    this._detecting = null
    /** Optional async resolver for a machine-stored (keychain) password. */
    this.passwordResolver = null
    /** Optional hook called with the live client after a successful connect. */
    this.onReady = null
    /** Optional hook called when the pool closes. */
    this.onCloseHook = null
    /** Consecutive SFTP subchannel-open timeouts (issue #65). */
    this._sftpTimeouts = 0
  }

  resolveKeyPath() {
    const p = this.config.privateKeyPath
    if (!p) return ''
    if (p.startsWith('~/') || p === '~') return path.join(homedir(), p.slice(1))
    return p
  }

  setTarget({ host, port, username, password, privateKeyPath, passphrase, workspace, useAgent, keyboardInteractive, proxy, hostKeyMode, backend, sshBinary }, previous) {
    // Collect the requested changes first: an UNCHANGED target is a no-op. The
    // old behavior closed the live connection and re-ran platform detection
    // even for an identical target, so every picker keystroke
    // (POST /current → applyActiveMachine → setTarget) paid a full SSH
    // reconnect + re-detect — the "slow remote path autocomplete" bug.
    //
    // `previous` is the diff BASELINE. Callers whose shared config was already
    // mutated BEFORE this call (applyActiveMachine: applyMachine rewrites the
    // live config IN PLACE, and pool.config IS that config object) pass a
    // pre-mutation snapshot — otherwise the comparison runs the new values
    // against themselves, is always equal and never closes even for a machine
    // switch (the wrong-host hazard of issue #25). Defaults to the current
    // config for callers that pass fresh values read independently of it.
    const base = previous || this.config
    const wanted = []
    if (host !== undefined) wanted.push(['host', String(host)])
    if (port !== undefined && Number(port)) wanted.push(['port', Number(port)])
    if (username !== undefined) wanted.push(['username', String(username)])
    if (password !== undefined && password !== null) wanted.push(['password', String(password)])
    if (privateKeyPath !== undefined) wanted.push(['privateKeyPath', String(privateKeyPath)])
    if (passphrase !== undefined) wanted.push(['passphrase', String(passphrase)])
    if (workspace !== undefined) wanted.push(['workspace', String(workspace)])
    if (useAgent !== undefined) wanted.push(['useAgent', !!useAgent])
    if (keyboardInteractive !== undefined) wanted.push(['keyboardInteractive', !!keyboardInteractive])
    if (proxy !== undefined) wanted.push(['proxy', proxy])
    if (hostKeyMode !== undefined) wanted.push(['hostKeyMode', String(hostKeyMode)])
    // Issue #51: the transport backend is part of the target identity — changing
    // it must close the live connection exactly like changing the host does.
    if (backend !== undefined) wanted.push(['backend', String(backend)])
    if (sshBinary !== undefined) wanted.push(['sshBinary', String(sshBinary)])
    const differs = ([k, v]) => (k === 'proxy'
      ? JSON.stringify(base[k] ?? null) !== JSON.stringify(v ?? null)
      : base[k] !== v)
    // Something actually changed → apply it and force a fresh connection.
    // (A caller that WANTS a reconnect for an identical target uses
    // invalidate(); setTarget semantics stay "re-point when moved".)
    if (wanted.some(differs)) {
      for (const [k, v] of wanted) this.config[k] = v
      // the new target may be a different OS — re-detect on the next command
      this.platform = 'unknown'
      this.gitBashPath = ''
      this.shellMode = 'native'
      this._detecting = null
      this.close()
    }
    return this
  }

  connect() {
    if (this.client) return Promise.resolve(this.client)
    if (this.connecting) return this.connecting
    const epoch = this.epoch
    const pending = this._doConnect(epoch)
    this.connecting = pending
    const clear = () => {
      if (this.epoch === epoch && this.connecting === pending) this.connecting = null
    }
    pending.then(clear, clear)
    return pending
  }

  async _doConnect(epoch) {
    const isCurrent = () => this.epoch === epoch
    const knownHostsFile = typeof this._knownHostsFile === 'function' ? this._knownHostsFile() : this._knownHostsFile
    const guard = createHostKeyGuard(this.config, knownHostsFile)
    const client = new Client()
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      if (isCurrent() && this.client === client) this.client = null
      throw guard.lastError ? new Error(guard.lastError) : err
    }

    // Proxy jump: SSH to the bastion first, then tunnel to the target through it.
    let sock = null
    const proxyCfg = this.config.proxy
    if (proxyCfg && proxyCfg.host) {
      try {
        this.proxyPool = new SshPool({
          ...this.config,
          host: proxyCfg.host,
          port: Number(proxyCfg.port) || 22,
          username: proxyCfg.username || this.config.username || 'root',
          password: proxyCfg.password || '',
          privateKeyPath: proxyCfg.privateKeyPath || '',
          passphrase: proxyCfg.passphrase || '',
          proxy: undefined,
        }, { knownHostsFile: this._knownHostsFile })
        const pclient = await this.proxyPool.connect()
        if (!isCurrent()) throw new Error('ssh target changed during proxy connect')
        try {
          sock = await forwardOutChannel(pclient, { dstHost: this.config.host, dstPort: this.config.port })
        } catch (e) {
          throw new Error('proxy forward to target failed: ' + ((e && e.message) || e))
        }
      } catch (err) {
        return fail(err)
      }
    }

    return new Promise((resolve, reject) => {
      const rejectOnce = (err) => {
        if (settled) return
        settled = true
        if (isCurrent() && this.client === client) this.client = null
        reject(guard.lastError ? new Error(guard.lastError) : err)
      }
      client.on('ready', () => {
        if (settled) return
        settled = true
        if (!isCurrent()) {
          try { client.end() } catch {}
          reject(new Error('ssh target changed during connect'))
          return
        }
        this.client = client
        this._sftpTimeouts = 0
        resolve(client)
        if (this.onReady) { try { this.onReady(client) } catch {} }
      })
      client.on('error', (e) => rejectOnce(e))
      client.on('close', () => {
        if (isCurrent() && this.client === client) this.client = null
        rejectOnce(new Error('ssh connection closed'))
      })

      const buildOpts = async () => {
        const opts = {
          host: this.config.host,
          port: this.config.port,
          username: this.config.username,
          readyTimeout: this.config.connectTimeoutMs,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          hostVerifier: (key) => guard.verifier(key),
        }
        if (sock) opts.sock = sock
        if (this.config.useAgent) {
          const sockPath = process.env.SSH_AUTH_SOCK
          if (sockPath) opts.agent = sockPath
        }
        let password = this.config.password || ''
        if (!password && this.passwordResolver) {
          try { password = (await this.passwordResolver()) || '' } catch {}
        }
        if (password) {
          opts.password = password
          opts.tryKeyboard = true
        } else if (this.config.keyboardInteractive && !this.config.privateKeyPath) {
          opts.tryKeyboard = true
        }
        if (this.config.privateKeyPath) {
          const keyPath = this.resolveKeyPath()
          if (!keyPath) {
            throw new Error('no credentials: set a password or a privateKeyPath to connect')
          }
          let key
          try {
            key = readFileSync(keyPath)
          } catch (err) {
            throw new Error(`cannot read private key "${keyPath}": ${err && err.message}`)
          }
          opts.privateKey = key
          opts.passphrase = this.config.passphrase || undefined
        } else if (!password && !opts.agent) {
          throw new Error('no credentials: set a password, a privateKeyPath, or enable useAgent to connect')
        }
        return opts
      }

      buildOpts().then(
        (opts) => {
          if (opts.tryKeyboard) {
            client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
              finish(prompts.map(() => this.config.password || ''))
            })
          }
          // ssh2 parses the private key SYNCHRONOUSLY inside connect() and
          // throws on an unparseable key (the classic case: an encrypted
          // OpenSSH key without a passphrase). Left uncaught, that throw
          // rejects this orphaned .then chain — an unhandled rejection that
          // crashes the whole host process (issue #48: "dsh: fatal load
          // failure" on every boot, because boot-restore re-dials the bad
          // machine). It also leaves the outer promise pending forever.
          // Convert it into a normal rejection so every caller's try/catch —
          // boot restore, test-connect, rw_connect — sees a regular failure.
          try {
            client.connect(opts)
          } catch (err) {
            rejectOnce(err)
          }
        },
        (err) => rejectOnce(err),
      )
    })
  }

  /** Detect the remote platform + locate Git Bash once; cached per target. */
  detect() {
    if (this.platform !== 'unknown') return Promise.resolve()
    if (this._detecting) return this._detecting
    this._detecting = this._detect().finally(() => {
      this._detecting = null
    })
    return this._detecting
  }

  async _detect() {
    let res
    try {
      // `cmd /c ver` works under cmd.exe, PowerShell AND Git Bash (all print
      // "Microsoft Windows …"); on POSIX hosts `cmd` simply doesn't exist.
      res = await this._execRaw('cmd /c ver', { timeoutMs: Math.min(this.config.commandTimeoutMs, 8000) })
    } catch (err) {
      this.platform = 'unknown'
      this.shellMode = 'native'
      return
    }
    const out = String(res.stdout || '') + '\n' + String(res.stderr || '')
    if (res.code === 0 && /microsoft windows/i.test(out)) {
      this.platform = 'windows'
      await this._resolveGitBash()
      return
    }
    // inconclusive — probe for a Git-Bash/MSYS remote (uname prints MINGW64_NT…)
    try {
      const u = await this._execRaw('uname -s', { timeoutMs: Math.min(this.config.commandTimeoutMs, 8000) })
      if (/mingw|msys|cygwin/i.test(String(u.stdout || ''))) {
        this.platform = 'windows'
        await this._resolveGitBash()
        return
      }
    } catch {}
    this.platform = 'posix'
    this.shellMode = 'native'
    this.gitBashPath = ''
  }

  /** On a Windows remote, locate Git Bash (config path → PATH → common installs). */
  async _resolveGitBash() {
    const cfg = String(this.config.shell || '').trim()
    if (cfg && cfg !== 'git-bash' && cfg !== 'native') {
      if (await this._cmdExists(cfg)) {
        this.gitBashPath = cfg
        this.shellMode = 'git-bash'
        return
      }
    }
    if (cfg === 'native') {
      this.shellMode = 'native'
      this.gitBashPath = ''
      return
    }
    try {
      const r = await this._execRaw('cmd /c where bash', { timeoutMs: 8000 })
      const first = String(r.stdout || '').trim().split(/\r?\n/)[0].trim()
      if (first) {
        this.gitBashPath = first
        this.shellMode = 'git-bash'
        return
      }
    } catch {}
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      ...(process.env.LOCALAPPDATA ? [process.env.LOCALAPPDATA + '\\Programs\\Git\\bin\\bash.exe'] : []),
      '%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe',
    ]
    for (const c of candidates) {
      if (await this._cmdExists(c)) {
        this.gitBashPath = c
        this.shellMode = 'git-bash'
        return
      }
    }
    this.shellMode = 'git-bash' // wanted but not found — commands fall back to raw
    this.gitBashPath = ''
  }

  async _cmdExists(p) {
    try {
      const r = await this._execRaw(`cmd /c if exist "${p}" (echo Y) else (echo N)`, { timeoutMs: 8000 })
      return /Y/.test(String(r.stdout || ''))
    } catch {
      return false
    }
  }

  /** Run one remote command; resolves { code, signal, stdout, stderr }.
   * On Windows remotes with Git Bash the script is piped to `bash -s` over the
   * exec-channel stdin — no shell quoting round-trip, so any content (quotes,
   * backslashes, newlines) survives verbatim. */
  exec(command, timeoutMsOrOpts) {
    const opts = timeoutMsOrOpts && typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : { timeoutMs: timeoutMsOrOpts }
    return this.detect().then(() => {
      if (this.platform === 'windows' && this.gitBashPath) {
        const script = String(command)
        return this._execRaw(`"${this.gitBashPath}" -s`, { ...opts, timeoutMs: opts.timeoutMs || this.config.commandTimeoutMs }, (stream) => {
          try { stream.end(script) } catch {}
        })
      }
      return this._execRaw(command, opts)
    })
  }

  /** Raw exec (no detection / no wrapper). Optional stdinWriter(stream) feeds
   * the remote process stdin (used by the Git Bash `-s` mode). */
  _execRaw(command, opts, stdinWriter) {
    const timeoutMs = (opts && opts.timeoutMs) || this.config.commandTimeoutMs
    const signal = opts && opts.signal
    // Streaming tap for background jobs (issue #70): a promoted command's value
    // is its LIVE output, which the job ring must receive as it arrives rather
    // than only as a return value the caller already abandoned. Called with
    // ('stdout'|'stderr', chunk); failures inside the tap must never break the
    // command itself, so every call site guards it.
    const onData = opts && typeof opts.onData === 'function' ? opts.onData : null
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          let retried = false
          // Caller cancellation (issue #44): a tool that hands us exec.signal
          // expects the remote command to stop when the turn is cancelled.
          // Resolve the same shape as a timeout so callers need no new branch.
          let onAbort = null
          const cleanupAbort = () => { if (signal && onAbort) signal.removeEventListener('abort', onAbort) }
          const runOn = (c) => {
            const execOpts = {}
            if (opts && opts.pty) execOpts.pty = true
            if (opts && opts.env && typeof opts.env === 'object') execOpts.env = opts.env
            c.exec(command, execOpts, (err, stream) => {
              if (err) {
                // Channel-open failure — or a session termination — usually
                // means the pooled connection died server-side (idle timeout /
                // network reset) while keepalive hadn't noticed. Drop it and
                // retry ONCE on a fresh connection.
                if (!retried && /channel open failure|open failed|unexpected .* session termination|session termination|disconnect/i.test(String((err && err.message) || err))) {
                  retried = true
                  this.invalidate()
                  return this.connect().then(
                    (fresh) => runOn(fresh),
                    (e2) => reject(new Error('ssh exec failed (reconnect): ' + ((e2 && e2.message) || e2))),
                  )
                }
                return reject(new Error('ssh exec failed: ' + ((err && err.message) || err)))
              }
              let stdout = ''
              let stderr = ''
              let settled = false
              let exitCode = null
              let exitSignal = null
              const hardCap = Math.max(this.config.maxOutputChars * 4, 1024 * 1024)
              const settle = () => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                cleanupAbort()
                resolve({
                  code: exitCode,
                  signal: exitSignal,
                  stdout: truncate(stdout, this.config.maxOutputChars),
                  stderr: truncate(stderr, this.config.maxOutputChars),
                })
              }
              const timer = setTimeout(() => {
                if (settled) return
                exitCode = -1
                exitSignal = 'TIMEOUT'
                // Kill the remote command (SIGTERM) rather than just dropping the
                // channel, so a runaway process cannot keep running and holding
                // the SSH connection after we've given up on its output.
                try {
                  if (typeof stream.signal === 'function') stream.signal('SIGTERM')
                } catch {}
                const hardClose = setTimeout(() => {
                  try { stream.close() } catch {}
                }, 800)
                if (typeof hardClose.unref === 'function') hardClose.unref()
                settle()
              }, timeoutMs)
              if (signal) {
                if (signal.aborted) {
                  try { if (typeof stream.signal === 'function') stream.signal('SIGTERM') } catch {}
                  try { stream.close() } catch {}
                  exitCode = -1
                  exitSignal = 'ABORTED'
                  return settle()
                }
                onAbort = () => {
                  if (settled) return
                  exitCode = -1
                  exitSignal = 'ABORTED'
                  try { if (typeof stream.signal === 'function') stream.signal('SIGTERM') } catch {}
                  const hardClose = setTimeout(() => { try { stream.close() } catch {} }, 500)
                  if (typeof hardClose.unref === 'function') hardClose.unref()
                  settle()
                }
                signal.addEventListener('abort', onAbort, { once: true })
              }
              stream.on('close', (code, sigName) => {
                if (settled) return
                exitCode = code
                // `sigName` is the signal NAME that killed the remote process
                // (e.g. 'SIGTERM'), not the caller's AbortSignal. The rename
                // matters: `signal` in this scope is the AbortSignal, and
                // assigning it here would leak an object into the result.
                exitSignal = sigName
                settle()
              })
              stream.on('data', (d) => {
                if (stdout.length < hardCap) stdout += d
                if (onData) { try { onData('stdout', d) } catch { /* tap errors are not command errors */ } }
              })
              stream.stderr.on('data', (d) => {
                if (stderr.length < hardCap) stderr += d
                if (onData) { try { onData('stderr', d) } catch { /* tap errors are not command errors */ } }
              })
              stream.on('error', (e) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                cleanupAbort()
                reject(new Error('ssh stream error: ' + ((e && e.message) || e)))
              })
              if (stdinWriter) {
                try { stdinWriter(stream) } catch {}
              }
            })
          }
          runOn(client)
        }),
    )
  }

  /** Resolve a promisified SFTP client. All paths normalized via toSftpPath(). */
  sftp() {
    return this.connect().then(
      (client) =>
        new Promise((resolve, reject) => {
          let retried = false
          const runOn = (c) => {
            // Bound the subchannel open itself, per attempt. Without this, a
            // remote whose sftp subsystem is unresponsive (overloaded sshd,
            // exceeded MaxSessions, half-open TCP) leaves `c.sftp(cb)` parked
            // forever with no callback — issue #44 point 3. ssh2 only calls back
            // on success or on a channel error, and a wedged peer produces
            // neither.
            //
            // The timer must be created per attempt, not once outside: the
            // callback clears it, so a single outer timer would leave the retry
            // (below) with no timeout at all.
            let timedOut = false
            const attemptTimer = setTimeout(() => {
              timedOut = true
              reject(new Error(`ssh sftp open timed out after ${this.config.commandTimeoutMs}ms`))
            }, this.config.commandTimeoutMs)
            // ★ 这里**不能 unref**。
            //
            // 这个定时器是"本次 await 的 sftp 打开"的**唯一结算者**：要么它超时 reject，
            // 要么 ssh2 回调 resolve。若把它 unref，而进程此刻没有别的 pending 句柄，
            // Node 会认为无事可做而**直接退出**，调用方永远等不到结果。
            // 实测症状：CI 上该用例之后的 4 个用例被标记 `cancelledByParent`
            // （同文件子进程提前退出），而本地因运行器恰好持着句柄而侥幸通过。
            // 注意与上面 exec() 的超时定时器保持一致 —— 那个本来就没有 unref。
            // 下面的 hardClose 仍然 unref，因为它只做清理、不负责结算。
            const clearAttempt = () => { clearTimeout(attemptTimer) }
            try {
              c.sftp((err, sftp) => {
                clearAttempt()
                if (timedOut) return
                if (err) {
                  // Same dead-connection recovery as exec(): a channel open
                  // failure — or a session termination (remote closed the
                  // SFTP subchannel, e.g. transient network blip / sshd idle
                  // drop) — means the pooled connection is stale: drop it and
                  // retry ONCE on a fresh connection.
                  if (!retried && /channel open failure|open failed|unexpected sftp session termination|session termination|disconnect/i.test(String((err && err.message) || err))) {
                    retried = true
                    this.invalidate()
                    return this.connect().then(
                      (fresh) => runOn(fresh),
                      (e2) => reject(new Error('ssh sftp failed (reconnect): ' + ((e2 && e2.message) || e2))),
                    )
                  }
                  return reject(new Error('ssh sftp failed: ' + ((err && err.message) || err)))
                }
                // A successful open proves the connection healthy: the strike
                // counter counts CONSECUTIVE timeouts, so it resets here —
                // two unrelated transient blips hours apart must not tear down
                // a fine connection.
                this._sftpTimeouts = 0
                // The promisified surface (timeouts, dead-channel fail-fast,
                // range reads) is shared verbatim with the system-OpenSSH
                // backend — see lib/sftp-surface.js for the rules it encodes.
                resolve(buildSftpSurface(sftp, {
                  commandTimeoutMs: this.config.commandTimeoutMs,
                  onTimeout: () => {
                    // A timed-out SFTP subchannel is dead: close it so the next
                    // operation does not queue behind the wedged one, and count
                    // the strike so a second consecutive timeout tears down the
                    // whole pooled connection (issue #65).
                    try { sftp.end() } catch { /* already gone */ }
                    this._noteSftpTimeout()
                  },
                }))
              })
            } catch (e) {
              clearAttempt()
              reject(new Error('ssh sftp failed: ' + ((e && e.message) || e)))
            }
          }
          runOn(client)
        }),
    )
  }

  /**
   * Count a timed-out SFTP subchannel open. A second consecutive timeout means
   * the pooled connection itself is wedged (issue #65): tear it down so the
   * next sftp() call re-handshakes instead of queueing behind the dead one.
   */
  _noteSftpTimeout() {
    this._sftpTimeouts = (this._sftpTimeouts || 0) + 1
    if (this._sftpTimeouts >= 2) this.invalidate()
  }

  /**
   * Drop the cached client and force a fresh connection on the next call.
   * Called when a channel open fails (e.g. "Channel open failure: open
   * failed") — the pooled SSH connection is usually dead server-side while
   * keepalive has not yet noticed, and reusing it keeps failing. The epoch
   * bump orphans any in-flight connect; the client is ended so ssh2 frees
   * its sockets.
   */
  invalidate() {
    this.epoch++
    const client = this.client
    this.client = null
    const pending = this.connecting
    this.connecting = null
    if (pending && typeof pending.catch === 'function') {
      try { pending.catch(() => {}) } catch {}
    }
    if (this.proxyPool) {
      try { this.proxyPool.close() } catch {}
      this.proxyPool = null
    }
    if (client) {
      try { client.end() } catch {}
    }
    // Same teardown as close(): the forwards manager must detach from the
    // dying client, or its stale `close -> stopAll()` listener later tears
    // down forwards that were re-attached to the NEW client (onReady does
    // the re-attach on the next successful connect).
    if (this.onCloseHook) {
      try { this.onCloseHook() } catch {}
    }
  }

  close() {
    this.epoch++
    const client = this.client
    this.client = null
    const pending = this.connecting
    this.connecting = null
    if (pending && typeof pending.catch === 'function') {
      try { pending.catch(() => {}) } catch {}
    }
    if (this.proxyPool) {
      try { this.proxyPool.close() } catch {}
      this.proxyPool = null
    }
    if (client) {
      try {
        client.end()
      } catch {}
    }
    if (this.onCloseHook) {
      try { this.onCloseHook() } catch {}
    }
  }
}
