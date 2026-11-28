// dsh-remote — the "system OpenSSH" SSH backend (issue #51).
//
// ## Why this exists
//
// The default backend (lib/pool.js) speaks SSH itself through ssh2, so it can
// only use the authentication methods ssh2 implements: password, private key,
// ssh-agent and keyboard-interactive. Enterprise hosts that only allow
// GSSAPI/Kerberos are unreachable, even though `ssh <alias>` in the user's own
// terminal works — the local Kerberos ticket (kinit) is simply not something
// ssh2 knows how to present.
//
// This backend delegates the transport to the LOCAL `ssh` executable, so every
// `~/.ssh/config` feature the user already relies on applies: gssapi-with-mic,
// ProxyJump, ProxyCommand, ControlPath, Host aliases, IdentityFile,
// PKCS11Provider, Match blocks… Anything OpenSSH can do, this backend can do,
// because OpenSSH is the one doing it.
//
// ## How each primitive is implemented
//
//   exec        → `ssh <opts> -- <dest> <command>`        (one process per call)
//   sftp        → `ssh <opts> -s <dest> sftp` + ssh2's OWN SFTP protocol engine
//                 driven over the resulting raw byte stream
//   forwardOut  → `ssh <opts> -W <host>:<port> <dest>`    (one process per tunnel)
//   reverse     → `ssh <opts> -N -R <bind>:<port>:<h>:<p> <dest>`
//
// The SFTP one deserves a note, because it is the reason this backend did not
// have to reimplement file transfer: `ssh -s <dest> sftp` on stdio is a PLAIN
// SFTP v3 byte stream (verified against a real host — the subsystem replies
// with its VERSION packet and nothing else on stdout). ssh2 already ships a
// complete, battle-tested SFTP implementation that speaks exactly that protocol
// over a duplex stream, so this module gives it a minimal `_protocol` shim and
// hands it the child process's stdio. File transfer therefore has the same
// semantics — and the same large-packet optimisations — as the native backend.
//
// ## Trade-offs (documented, not hidden)
//
//   • spawn-per-operation: unlike the native pool there is no long-lived
//     connection multiplexed across commands, so each `exec`/`forwardOut` pays
//     a fresh SSH handshake. That is inherent to delegating to the `ssh` CLI:
//     Windows OpenSSH rejects ControlMaster ("getsockname failed: Not a
//     socket", measured), and a portable multiplexing layer would be a second
//     implementation of what the native backend already does. The SFTP path IS
//     kept persistent, because the workspace picker and the explorer hammer it.
//   • the passphrase/password prompt: OpenSSH asks for both through the same
//     askpass channel, so when a secret is configured this backend offers it
//     for whichever prompt appears (password first, then passphrase). A host
//     needing two DIFFERENT secrets is not representable here — use the native
//     backend for that.
//   • reverse forwards need their target up front (the CLI takes it as an
//     argument), so they are exposed as `reverseForward()` and ForwardManager
//     prefers it when present.
//   • host keys are checked by ssh itself against the user's own known_hosts,
//     not against the plugin's TOFU store: making `ssh` use a different trust
//     anchor per machine is exactly the kind of override that breaks the
//     enterprise setups this backend exists to serve. `hostKeyMode` maps onto
//     StrictHostKeyChecking instead.

import { spawn } from 'node:child_process'
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { buildSftpSurface } from './sftp-surface.js'
import { detectPlatform } from './detect-platform.js'
import { truncate } from './paths.js'

// The SFTP protocol engine lives at lib/protocol/SFTP.js inside ssh2 and is not
// part of its public API. Creating it through createRequire keeps this module
// ESM-clean while still reaching it; if a future ssh2 moves it, this fails with
// an actionable message instead of a bare MODULE_NOT_FOUND at connect time.
const require_ = createRequire(import.meta.url)
let SftpEngine = null
export function loadSftpEngine() {
  if (SftpEngine) return SftpEngine
  try {
    const entry = require_.resolve('ssh2')
    const sftpPath = entry.replace(/lib[\\/]index\.js$/, 'lib/protocol/SFTP.js')
    SftpEngine = require_(sftpPath).SFTP
  } catch (err) {
    throw new Error("system-OpenSSH backend could not load ssh2's SFTP engine: " + ((err && err.message) || err))
  }
  if (typeof SftpEngine !== 'function') {
    throw new Error("system-OpenSSH backend found no SFTP engine in this ssh2 install")
  }
  return SftpEngine
}

/** The `ssh` executable this backend drives (config override wins). */
export function resolveSshBinary(config = {}) {
  return String(config.sshBinary || '').trim() || 'ssh'
}

/**
 * Path of the user's own known_hosts. Exposed for the UI; the backend itself
 * never points ssh at a different file (see the header).
 */
export function defaultKnownHostsPath() {
  return path.join(homedir(), '.ssh', 'known_hosts')
}

/**
 * Translate `hostKeyMode` into OpenSSH's StrictHostKeyChecking.
 *
 * `accept-new` is ssh's own default on modern OpenSSH and matches the plugin's
 * TOFU default; `verify` refuses unknown hosts; `off` accepts anything.
 */
export function hostKeyArgs(config = {}) {
  const mode = config.hostKeyMode === 'verify' || config.hostKeyMode === 'off' ? config.hostKeyMode : 'accept-new'
  const strict = mode === 'verify' ? 'yes' : mode === 'off' ? 'no' : 'accept-new'
  return ['-o', `StrictHostKeyChecking=${strict}`]
}

/**
 * One private directory per process. Different DSH/Node processes must never
 * rewrite a helper while another process is executing it (Windows EBUSY).
 * The helper carries no secret; it reads the secret from its environment.
 */
let askpassDirectory = null
let readyAskpassHelper = null
export function askpassDir() {
  if (!askpassDirectory) {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-askpass-'))
    askpassDirectory = dir
    process.once('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* still in use */ } })
  }
  return askpassDirectory
}

/**
 * Ensure an askpass helper exists and return its path.
 *
 * The helper prints $DSH_REMOTE_SSH_SECRET. Passing the secret through the
 * environment (rather than as an argument or a file) keeps it out of `ps`,
 * argv and the filesystem. The Windows helper is a .cmd that invokes Node via
 * `process.execPath`, because `@echo %VAR%` would mangle secrets containing cmd
 * metacharacters (&, %, ^ …) and a bare `echo` is not a shell we control.
 */
export function ensureAskpassHelper() {
  if (readyAskpassHelper && existsSync(readyAskpassHelper)) return readyAskpassHelper
  const dir = askpassDir()
  try { mkdirSync(dir, { recursive: true }) } catch { /* already there */ }
  if (process.platform === 'win32') {
    const js = path.join(dir, 'askpass.js')
    const cmd = path.join(dir, 'askpass.cmd')
    try {
      writeFileSync(js, 'process.stdout.write((process.env.DSH_REMOTE_SSH_SECRET || "") + "\\n")\n')
      writeFileSync(cmd, '@echo off\r\n"' + process.execPath + '" "' + js + '"\r\n')
    } catch (err) {
      throw new Error('system-OpenSSH backend could not write its askpass helper: ' + ((err && err.message) || err))
    }
    readyAskpassHelper = cmd
    return cmd
  }
  const sh = path.join(dir, 'askpass.sh')
  try {
    writeFileSync(sh, '#!/bin/sh\nprintf \'%s\\n\' "$DSH_REMOTE_SSH_SECRET"\n')
    try { chmodSync(sh, 0o700) } catch { /* best effort on odd filesystems */ }
  } catch (err) {
    throw new Error('system-OpenSSH backend could not write its askpass helper: ' + ((err && err.message) || err))
  }
  readyAskpassHelper = sh
  return sh
}

/** Env that hands the secret to the askpass helper (never argv, never a file). */
export function askpassEnv(secret) {
  return {
    ...process.env,
    SSH_ASKPASS: ensureAskpassHelper(),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':0',
    DSH_REMOTE_SSH_SECRET: String(secret),
  }
}

/**
 * Keep an EPIPE on a child's stdin from becoming a process-wide crash.
 *
 * A child that stops reading — the remote side of `ssh -s sftp` dying mid-
 * transfer is the one that bites — makes the NEXT write to its stdin fail. Node
 * reports that asynchronously through the Writable's `'error'` event, so a
 * synchronous `try/catch` around `write()` never sees it; an unhandled
 * `'error'` on a stream is an uncaught exception, and the Host treats one of
 * those as fatal (issue #118: `dsh: fatal uncaught exception: Error: write
 * EPIPE` → the whole app's host process exits and every session is lost).
 *
 * Every `spawn` in this file therefore gets this hook: swallow the pipe error,
 * report it to `onError` when the caller has cleanup to do, and let the
 * existing `'close'`/`'error'` handling own the rest. A missing `ssh` binary
 * is a different signal — spawn reports it on the CHILD, not on its stdin — so
 * it still reaches the caller as a real error.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {(err: Error) => void} [onError] - e.g. drop the cached SFTP session.
 * @returns {import('node:child_process').ChildProcess} the same child.
 */
export function guardChildStdin(child, onError) {
  const stdin = child && child.stdin
  if (!stdin || typeof stdin.on !== 'function') return child
  // A listener is the difference between "this stream reported a problem" and
  // "this process died": without one Node re-throws the error as an uncaught
  // exception. There is nothing to retry here — the pipe is gone — so all that
  // is left is to let the caller drop whatever it cached for this child; the
  // child's own 'close'/'error' handling still reports the real failure.
  stdin.on('error', (err) => {
    if (typeof onError === 'function') { try { onError(err) } catch { /* best effort */ } }
  })
  return child
}

/** Is `ssh` runnable? Used to fail with an actionable message, not ENOENT. */
export function sshBinaryAvailable(binary) {
  if (binary.includes('/') || binary.includes('\\')) {
    try { accessSync(binary, fsConstants.X_OK); return true } catch { return false }
  }
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      try { accessSync(path.join(dir, binary + ext), fsConstants.X_OK); return true } catch { /* keep looking */ }
    }
  }
  return false
}

/** Backoff between the two connect attempts (issue #188).
 *
 * Short on purpose: the failure being retried is a dropped SYN / unanswered
 * dial, not a slow host, and a caller's read budget is usually far shorter than
 * the 15s connect timeout. A re-dial after this kind of failure was measured at
 * ~700ms, so 400ms of backoff is enough to land on a different path without
 * making the user wait twice for nothing.
 */
export const CONNECT_RETRY_DELAY_MS = 400


// Connect-stage failures that are DETERMINISTIC, so a second dial only doubles
// the wait the user stares at. Checked BEFORE the transient list: OpenSSH
// prefixes several of these with "Connection closed by ...", which would
// otherwise look retryable.
const NON_TRANSIENT_CONNECT_PATTERNS = [
  /permission denied/i,
  /too many authentication failures/i,
  /no supported authentication/i,
  /host key verification failed/i,
  /remote host identification has changed/i,
  /could not resolve hostname/i,
  /name or service not known/i,
  /connection refused/i,
  /no route to host/i,
  /network is unreachable/i,
  /no matching (?:key exchange|host key|ciphers|mac)/i,
]

// Connect-stage failures that are TRANSIENT: the dial or the pre-auth banner
// exchange was dropped, and the very next attempt usually succeeds.
const TRANSIENT_CONNECT_PATTERNS = [
  /connection timed out/i,
  /operation timed out/i,
  /connection reset by peer/i,
  // OpenSSH prints an address here, not the word "host":
  //   Connection closed by 10.0.0.1 port 22
  /connection closed by /i,
  /kex_exchange_identification/i,
  /connection lost/i,
]

/**
 * Was this failed connect probe a transient, worth-retrying dial failure?
 *
 * Issue #188: on a corporate link ~6% of fresh openssh connects died with
 * `Connection timed out` after the full 15s `ConnectTimeout`, and an immediate
 * re-dial succeeded in ~700ms every time. The native backend has retried the
 * equivalent case (`SSH_HANDSHAKE_CLOSED`) since #185; this is the same
 * contract for the `ssh` CLI backend.
 *
 * Only the CONNECT stage is classified here. The probe is a bare
 * `ssh -- <host> true`, so nothing authenticated is ever replayed, and host-key
 * / handshake policy is untouched — the retry spawns the identical argv.
 *
 * @param {{code: number|null, signal: string|null, stderr: string}} probe
 * @returns {boolean}
 */
export function transientConnectFailure(probe) {
  if (!probe) return false
  // Our own timer fired: the host never answered within the connect budget.
  if (probe.signal === 'TIMEOUT') return true
  const text = String(probe.stderr || '')
  if (!text) return false
  if (NON_TRANSIENT_CONNECT_PATTERNS.some((re) => re.test(text))) return false
  return TRANSIENT_CONNECT_PATTERNS.some((re) => re.test(text))
}

/**
 * Options shared by every `ssh` invocation for this target.
 *
 * Deliberately NOT passed: PreferredAuthentications / GSSAPIAuthentication /
 * PubkeyAcceptedKeyTypes / IdentitiesOnly-from-the-alias / ProxyJump-from-the-
 * alias. Those must come from the user's `~/.ssh/config` — overriding them is
 * precisely what would break the enterprise setups this backend exists for.
 *
 * @param {object} config - the pool config.
 * @param {object} [opts]
 * @param {boolean} [opts.forSecret] - true when a secret will be offered via
 *   askpass, which means BatchMode must be OFF (BatchMode forbids every
 *   interactive prompt, askpass included) and the prompt count bounded instead.
 */
export function baseSshArgs(config, { forSecret = false } = {}) {
  const args = []
  if (config.port && Number(config.port) !== 22) args.push('-p', String(Number(config.port)))
  if (config.username) args.push('-l', String(config.username))
  if (config.privateKeyPath) args.push('-i', String(config.privateKeyPath))
  // An explicit jump host — the same shape the native backend's `proxy` takes.
  // A jump host that comes from ~/.ssh/config needs nothing here.
  const proxy = config.proxy
  if (proxy && proxy.host) {
    const user = proxy.username ? `${proxy.username}@` : ''
    const port = proxy.port && Number(proxy.port) !== 22 ? `:${Number(proxy.port)}` : ''
    args.push('-J', `${user}${proxy.host}${port}`)
  }
  // An explicit known_hosts file (tests keep loopback keys OUT of the user's
  // real ~/.ssh/known_hosts with this; ssh ignores $HOME on some platforms).
  // Checking strength is unchanged — StrictHostKeyChecking below still applies.
  if (config.knownHostsFile) args.push('-o', `UserKnownHostsFile=${config.knownHostsFile}`)
  args.push(...hostKeyArgs(config))
  const connectSecs = Math.max(1, Math.round((Number(config.connectTimeoutMs) || 15000) / 1000))
  args.push('-o', `ConnectTimeout=${connectSecs}`, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3')
  // Without a configured secret we must not hang on an interactive prompt:
  // BatchMode makes ssh fail fast instead, and leaves key/agent/GSSAPI intact.
  if (!forSecret) args.push('-o', 'BatchMode=yes')
  else args.push('-o', 'NumberOfPasswordPrompts=1')
  return args
}

/**
 * One live system-OpenSSH connection.
 *
 * This deliberately mimics the ssh2 Client surface the rest of the plugin
 * consumes — `forwardOut` plus a reverse-forward capability — so
 * ForwardManager/WebAttach work unchanged. It is an EventEmitter because the
 * native pool's client is one and callers attach listeners to it.
 */
export class OpenSshConnection extends EventEmitter {
  constructor(pool, { sshBinary, secret }) {
    super()
    this.pool = pool
    this.sshBinary = sshBinary
    this.secret = secret
    this.closed = false
    /** Live child processes to reap on close. */
    this.children = new Set()
  }

  shortDescription() {
    return `${this.pool.destination()} via ${this.sshBinary}`
  }

  spawnSsh(extraArgs, { tty = false } = {}) {
    if (this.closed) throw new Error('ssh connection closed')
    const args = [
      ...baseSshArgs(this.pool._argConfig(), { forSecret: !!this.secret }),
      ...extraArgs,
    ]
    const child = spawn(this.sshBinary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.secret ? askpassEnv(this.secret) : undefined,
    })
    this.children.add(child)
    const reap = () => this.children.delete(child)
    // Every connection-level child goes through here (the `ssh -W` forward
    // channel and the `ssh -N` reverse forward), so the stdin guard for those
    // two paths belongs here rather than at each call site: a tunnel whose peer
    // vanished must end as a closed channel, not as a fatal EPIPE (issue #118).
    guardChildStdin(child)
    child.on('close', reap)
    child.on('error', reap)
    if (tty) { /* no pty support through the CLI without a tty helper */ }
    return child
  }

  /**
   * Local forward: carry bytes to <destHost>:<destPort> as seen FROM the
   * remote, through `ssh -W`.
   *
   * The channel is handed over as soon as the child is running — NOT when
   * `ssh -W` exits. See the body for why that distinction is load-bearing.
   *
   * @returns {boolean} true synchronously, so capability probes can be sync.
   */
  forwardOut(_srcHost, _srcPort, destHost, destPort, cb) {
    let child
    try {
      child = this.spawnSsh(['-W', `${destHost}:${destPort}`, '--', this.pool.destination()])
    } catch (err) {
      setImmediate(() => cb(err))
      return true
    }
    // `ssh -W` is the tunnel itself: for as long as the channel is usable the
    // child stays ALIVE and only exits when the peer or the caller closes it.
    // Waiting for 'close' to declare success therefore never resolves for a
    // healthy tunnel; the caller never writes the first byte and the peer times
    // out. Hand the channel over on the next tick instead — ssh buffers stdin
    // until the remote channel opens — and report failures by destroying it.
    //
    // The one-tick delay is load-bearing: a spawn error (bad binary, EACCES)
    // arrives in that same window, and the calling Promise only attaches its
    // handlers in the microtask after `cb`. Without the delay the error would
    // be emitted into the no-op listener and the caller would receive an
    // already-destroyed channel (the local socket would hang forever).
    let stderr = ''
    let handed = false
    let failed = false
    let closing = false
    let ended = false
    const channel = new Duplex({
      read() {},
      write(chunk, _enc, done) { try { child.stdin.write(chunk, done) } catch (e) { done(e) } },
      final(done) { try { child.stdin.end(done) } catch { done() } },
      destroy(err, done) { try { child.kill() } catch {} ; done(err) },
    })
    channel.close = () => { closing = true; try { child.kill() } catch {} }
    // Until the caller attaches its own 'error' handler (one microtask after
    // cb) a failure must not become an unhandled 'error' event.
    channel.on('error', () => { /* callers attach their own kill handler */ })
    const endReadable = () => {
      if (ended) return
      ended = true
      try { channel.push(null) } catch { /* already gone */ }
    }
    const fail = (err) => {
      if (failed) return
      failed = true
      if (handed) channel.destroy(err)
      else { handed = true; cb(err) }
    }
    child.stderr.on('data', (d) => { stderr += d })
    child.stdout.on('data', (d) => channel.push(d))
    // stdout's EOF is deliberately NOT forwarded yet: a non-zero exit can
    // follow it (truncated response), and ending first would let the caller's
    // pipe close the socket as if the stream had finished cleanly. Only the
    // child's exit verdict decides: code 0 (or a caller close) means EOF.
    child.on('error', fail)
    child.on('close', (code) => {
      if (failed) return
      if (!handed) {
        // Exited before the deferred success handover: keep the old contract.
        if (code === 0) { handed = true; cb(null, channel); endReadable(); return }
        handed = true
        cb(new Error(`ssh -W to ${destHost}:${destPort} failed (exit ${code})${stderr ? ': ' + stderr.trim() : ''}`))
        return
      }
      if (closing) { endReadable(); return }
      if (code === 0) { endReadable(); return }
      channel.destroy(new Error(`ssh -W to ${destHost}:${destPort} failed (exit ${code})${stderr ? ': ' + stderr.trim() : ''}`))
    })
    setImmediate(() => {
      if (handed || failed) return
      handed = true
      cb(null, channel)
    })
    return true
  }

  /** Tells ForwardManager that the CLI-specific reverse path is available. */
  get supportsReverseForward() { return true }

  /**
   * Reverse forward: ask the REMOTE to listen on <bindHost>:<listenPort> and
   * carry connections to <targetHost>:<targetPort>. Unlike ssh2's two-phase
   * `forwardIn` + `tcpip`, the `ssh -R` CLI takes the final target as an
   * argument, so nothing has to be resolved lazily.
   *
   * @returns {Promise<{child: object, close: Function}>}
   */
  reverseForward({ bindHost = '127.0.0.1', listenPort, targetHost = '127.0.0.1', targetPort }) {
    return new Promise((resolve, reject) => {
      const spec = `${bindHost}:${listenPort}:${targetHost}:${targetPort}`
      let child
      try {
        child = this.spawnSsh(['-N', '-o', 'ExitOnForwardFailure=yes', '-R', spec, '--', this.pool.destination()])
      } catch (err) { return reject(err) }
      let stderr = ''
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { child.kill() } catch {}
        reject(err)
      }
      child.stderr.on('data', (d) => {
        stderr += d
        // Nothing prints on success; an error before the grace window is the
        // only signal `ssh -N` gives that the forward did not take.
        if (/warning|error|failed|refused|denied|cannot|not permitted|unable/i.test(String(d))) {
          fail(new Error(`reverse forward ${spec} failed: ${stderr.trim()}`))
        }
      })
      child.on('error', fail)
      // `ssh -N` stays in the foreground; a process that outlives the grace
      // window means the remote listener was accepted.
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ child, close: () => { try { child.kill() } catch {} } })
      }, 700)
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`reverse forward ${spec} exited early (${code})${stderr ? ': ' + stderr.trim() : ''}`))
      })
    })
  }

  /** Superseded by reverseForward() (the CLI needs the target up front). */
  forwardIn(_host, _port, cb) {
    setImmediate(() => cb(new Error(
      'the system-OpenSSH backend opens reverse forwards with `ssh -R`, which needs the target up front — use reverseForward()',
    )))
  }

  close() {
    this.closed = true
    for (const child of [...this.children]) {
      try { child.kill() } catch {}
    }
    this.children.clear()
  }
}

/**
 * A system-OpenSSH pool: the same public surface as lib/pool.js's SshPool,
 * backed by the local `ssh` CLI. Callers cannot tell the two apart — see
 * test/openssh-backend.test.js, which drives both through one shared contract.
 */
export class SystemOpenSshPool {
  constructor(config, opts = {}) {
    this.config = config
    // The native backend's JSON fingerprint registry is NOT an OpenSSH
    // known_hosts file. ActivePool supplies a dedicated plain-text path; the
    // fallback preserves direct-construction compatibility (issue #118).
    this._knownHostsFile = opts.opensshKnownHostsFile ?? opts.knownHostsFile
    this.client = null
    this.connecting = null
    this.proxyPool = null
    // Generational token, exactly as the native pool: a stale in-flight connect
    // must never hand this pool a connection to an old host.
    this.epoch = 0
    this.platform = 'unknown'
    this.gitBashPath = ''
    this.shellMode = 'native'
    this._detecting = null
    this.passwordResolver = null
    this.onReady = null
    this.onCloseHook = null
    /** The persistent `ssh -s ... sftp` session (kept across calls). */
    this._sftpSession = null
    this._sftpChild = null
    /** Memoized askpass secret for this target (null = not resolved yet). */
    this._secret = null
    this._secretPromise = null
  }

  /**
   * The config baseSshArgs should see. `opts.knownHostsFile` (a path, or a
   * function returning one, exactly like the native pool) used to be stored
   * and silently dropped — so a custom known_hosts never reached the CLI, and
   * tests had no way to keep loopback keys out of the user's real file.
   * Resolved per call so a function value is honored as late as the native
   * backend resolves it.
   */
  _argConfig() {
    const kh = typeof this._knownHostsFile === 'function' ? this._knownHostsFile() : this._knownHostsFile
    return kh ? { ...this.config, knownHostsFile: kh } : this.config
  }

  /** The destination OpenSSH should connect to (an alias passes through). */
  destination() {
    // A bare alias resolves through ~/.ssh/config inside ssh itself, so it is
    // handed over untouched; user/port ride on `-l`/`-p` when recorded.
    return String(this.config.host || '')
  }

  setTarget({ host, port, username, password, privateKeyPath, passphrase, workspace, useAgent, keyboardInteractive, proxy, hostKeyMode, backend, sshBinary, shell }, previous) {
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
    // Issue #51: kept in step with the native pool's setTarget — the two
    // backends share one contract (see test/issue51-openssh-backend.test.js), so
    // a field one of them diffs must not be silently ignored by the other.
    if (backend !== undefined) wanted.push(['backend', String(backend)])
    if (sshBinary !== undefined) wanted.push(['sshBinary', String(sshBinary)])
    // Issue #206: kept in step with the native pool's setTarget (same contract
    // as sshBinary above) — a shell change resets the cached detection.
    if (shell !== undefined) wanted.push(['shell', String(shell)])
    const differs = ([k, v]) => (k === 'proxy'
      ? JSON.stringify(base[k] ?? null) !== JSON.stringify(v ?? null)
      : base[k] !== v)
    if (wanted.some(differs)) {
      for (const [k, v] of wanted) this.config[k] = v
      this.platform = 'unknown'
      this.gitBashPath = ''
      this.shellMode = 'native'
      this._detecting = null
      this.close()
    }
    return this
  }

  /**
   * The secret to offer askpass, resolved once per target.
   *
   * `connect()` no longer has to run first: `exec`/`sftp` call this themselves,
   * so a pool that is only ever used for file listing still authenticates.
   */
  _resolveSecret() {
    if (this._secret !== null) return Promise.resolve(this._secret)
    if (this._secretPromise) return this._secretPromise
    const epoch = this.epoch
    this._secretPromise = (async () => {
      let secret = this.config.password || ''
      if (!secret && this.passwordResolver) {
        try { secret = (await this.passwordResolver()) || '' } catch { /* fall through */ }
      }
      if (!secret) secret = this.config.passphrase || ''
      // A target switch invalidates the answer; leave the memo for the new one.
      if (this.epoch === epoch) this._secret = String(secret || '')
      this._secretPromise = null
      return String(secret || '')
    })()
    return this._secretPromise
  }

  /** Validate the environment; there is no socket to hold open. */
  connect() {
    if (this.client) return Promise.resolve(this.client)
    if (this.connecting) return this.connecting
    const epoch = this.epoch
    const pending = this._connectWithRetry(epoch)
    this.connecting = pending
    const clear = () => { if (this.epoch === epoch && this.connecting === pending) this.connecting = null }
    pending.then(clear, clear)
    return pending
  }

  /**
   * Dial, and on a TRANSIENT connect failure dial ONCE more (issue #188).
   *
   * The retry is shared by every concurrent caller because `connect()` memoizes
   * this promise: N simultaneous reads of a dropped link cost exactly one extra
   * dial, not N. Nothing authenticated is replayed — `_doConnect` only runs the
   * `ssh -- <host> true` probe, and the retry spawns the identical argv, so the
   * host-key and handshake policy of the first attempt still applies.
   *
   * A deterministic failure (bad credentials, changed host key, DNS, refused,
   * unreachable) is NOT tagged transient by `transientConnectFailure`, so it
   * surfaces on the first attempt with no extra wait.
   */
  async _connectWithRetry(epoch) {
    const firstStarted = Date.now()
    try {
      return await this._doConnect(epoch)
    } catch (error) {
      if (!error || error.code !== 'SSH_CONNECT_TRANSIENT' || this.epoch !== epoch) throw error
      const firstMs = Date.now() - firstStarted
      await delay(CONNECT_RETRY_DELAY_MS)
      if (this.epoch !== epoch) throw new Error('ssh target changed during connect retry')
      const retryStarted = Date.now()
      try {
        return await this._doConnect(epoch)
      } catch (retryError) {
        const retryMs = Date.now() - retryStarted
        // Both dials failed. Say so explicitly, with BOTH durations: from a
        // single timeout "flaky link" and "host is down" are indistinguishable,
        // and the user's next move differs (retry later vs. check the host).
        const wrapped = new Error(
          String((retryError && retryError.message) || retryError)
          + ` (connect retried once: first attempt ${firstMs}ms, retry ${retryMs}ms)`,
        )
        wrapped.code = retryError && retryError.code
        wrapped.cause = retryError
        throw wrapped
      }
    }
  }

  async _doConnect(epoch) {
    const isCurrent = () => this.epoch === epoch
    const sshBinary = resolveSshBinary(this.config)
    if (!this.config.host) throw new Error('no host configured')
    if (!sshBinaryAvailable(sshBinary)) {
      throw new Error(
        `the system-OpenSSH backend needs a \`${sshBinary}\` executable on PATH`
        + ' — install OpenSSH, or set the backend back to "native"',
      )
    }
    const secret = await this._resolveSecret()
    if (!isCurrent()) throw new Error('ssh target changed during connect')
    // Native semantics are "connect() throws when the SSH connection fails", and
    // a probe also gives the settings page a real latency number. The CLI has no
    // socket to keep, so this is the only point where the target is proven.
    // `echo ok` rather than a bare `true`: cmd.exe (the default shell of a
    // stock Windows OpenSSH server) has no `true`, so the probe failed on
    // healthy Windows hosts. `echo ok` works under cmd.exe, PowerShell and POSIX shells.
    const probe = await this._runSsh(['--', this.destination(), 'echo ok'], { timeoutMs: this.config.connectTimeoutMs || 15000 })
    if (!isCurrent()) throw new Error('ssh target changed during connect')
    if (probe.code !== 0) {
      // dsh-remote-fix3: _runSsh reports its own timer as code -1 / signal
      // TIMEOUT with empty stderr, so the old message degraded to a bare
      // `ssh failed (exit -1)` and told the settings page nothing actionable.
      const stderrText = String(probe.stderr || '').trim()
      const failure = probe.signal === 'TIMEOUT'
        ? new Error(`ssh timed out after ${this.config.connectTimeoutMs || 15000}ms (no reply from the host — raise the connect timeout if this link is just slow)`)
        : new Error(`ssh failed (exit ${probe.code})${stderrText ? ': ' + stderrText : ''}`)
      // Issue #188: tag the retryable class HERE, where the probe result is
      // known, so the retry decision never has to sniff a message at a distance.
      if (transientConnectFailure(probe)) failure.code = 'SSH_CONNECT_TRANSIENT'
      throw failure
    }
    void secret
    const conn = new OpenSshConnection(this, { sshBinary, secret })
    this.client = conn
    if (this.onReady) { try { this.onReady(conn) } catch {} }
    return conn
  }

  /**
   * Run one `ssh` invocation and collect its result.
   *
   * @param {string[]} extraArgs - arguments appended after the shared base.
   * @param {object} [opts] - `timeoutMs`, `signal` (AbortSignal), `stdin`,
   *   `onData(channel, chunk)` — a streaming tap the native backend has had
   *   since issue #70. A background job's value is its LIVE output, which the
   *   job ring must receive as it arrives; a backend that only returns the
   *   accumulated text loses every byte the caller stopped waiting for
   *   (issue #80). Tap errors are not command errors, so the call is guarded.
   * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string}>}
   */
  async _runSsh(extraArgs, opts = {}) {
    if (!this.config.host) throw new Error('no host configured')
    const secret = await this._resolveSecret()
    const timeoutMs = opts.timeoutMs === 0 ? 0 : (opts.timeoutMs || this.config.commandTimeoutMs)
    const sshBinary = resolveSshBinary(this.config)
    const args = [...baseSshArgs(this._argConfig(), { forSecret: !!secret }), ...extraArgs]
    return new Promise((resolve) => {
      // A pre-aborted signal must stop BEFORE the ssh child exists: the old
      // order spawned first and killed after, so the command was already on
      // its way to the host when the cancellation was honoured.
      if (opts.signal?.aborted) {
        return resolve({ code: -1, signal: 'ABORTED', stdout: '', stderr: '' })
      }
      let child
      try {
        child = spawn(sshBinary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: secret ? askpassEnv(secret) : undefined })
      } catch (err) {
        return resolve({ code: -1, signal: 'SPAWN_FAILED', stdout: '', stderr: String((err && err.message) || err) })
      }
      // This path may stream a script into `bash -s` and can be written to
      // after the command already exited (Git Bash); a broken pipe there must
      // fail the call, not the process (issue #118).
      guardChildStdin(child)
      let stdout = ''
      let stderr = ''
      let settled = false
      let exitCode = null
      let exitSignal = null
      const cap = Math.max(this.config.maxOutputChars * 4, 1024 * 1024)
      const onData = typeof opts.onData === 'function' ? opts.onData : null
      const cleanupAbort = () => { if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort) }
      let onAbort = null
      const finish = () => {
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
      const killHard = () => { try { setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 800).unref?.() } catch {} }
      // No timer at all for an explicit no-deadline call (0) — see pool.js
      // _execRaw; arming one would fire at once or kill a promoted job (issue #95).
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (settled) return
        exitCode = -1
        exitSignal = 'TIMEOUT'
        try { child.kill() } catch {}
        killHard()
        finish()
      }, timeoutMs) : null
      if (opts.signal) {
        if (opts.signal.aborted) {
          try { child.kill() } catch {}
          exitCode = -1; exitSignal = 'ABORTED'
          return finish()
        }
        onAbort = () => {
          if (settled) return
          exitCode = -1; exitSignal = 'ABORTED'
          try { child.kill() } catch {}
          killHard()
          finish()
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
      // The tap fires even past the local cap, exactly like the native
      // backend's: a promoted job's ring has its own bounds and must keep
      // receiving output the truncated return value no longer holds.
      child.stdout.on('data', (d) => {
        if (stdout.length < cap) stdout += d
        if (onData) { try { onData('stdout', d) } catch { /* tap errors are not command errors */ } }
      })
      child.stderr.on('data', (d) => {
        if (stderr.length < cap) stderr += d
        if (onData) { try { onData('stderr', d) } catch { /* tap errors are not command errors */ } }
      })
      child.on('error', (e) => {
        if (settled) return
        stderr += String((e && e.message) || e)
        exitCode = -1
        finish()
      })
      child.on('close', (code, sig) => {
        if (settled) return
        exitCode = code
        exitSignal = sig || null
        finish()
      })
      try { child.stdin.end(opts.stdin === undefined || opts.stdin === null ? undefined : String(opts.stdin)) } catch {}
    })
  }

  /** Detect the remote platform + locate Git Bash once; cached per target. */
  detect() {
    if (this.platform !== 'unknown') return Promise.resolve()
    if (this._detecting) return this._detecting
    this._detecting = this._detect().finally(() => { this._detecting = null })
    return this._detecting
  }

  async _detect() {
    // The probes live in lib/detect-platform.js — the single implementation
    // shared with the native ssh2 backend (see the header comment there for
    // the issue #197 / #199 probe-order and quoting rules).
    const r = await detectPlatform(
      (cmd, timeoutMs) => this._runSsh(['--', this.destination(), cmd], { timeoutMs }),
      { commandTimeoutMs: this.config.commandTimeoutMs, shell: this.config.shell },
    )
    this.platform = r.platform
    this.shellMode = r.shellMode
    this.gitBashPath = r.gitBashPath
  }

  /** Run one remote command (Windows + Git Bash is wrapped exactly as native). */
  exec(command, timeoutMsOrOpts) {
    const opts = timeoutMsOrOpts && typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : { timeoutMs: timeoutMsOrOpts }
    return this.detect().then(() => {
      const timeoutMs = opts.timeoutMs === 0 ? 0 : (opts.timeoutMs || this.config.commandTimeoutMs)
      if (this.platform === 'windows' && this.gitBashPath) {
        // Pipe the script to `bash -s` over stdin: no quoting round-trip, so
        // quotes/backslashes/newlines survive verbatim (same as the native pool).
        return this._runSsh(['--', this.destination(), `"${this.gitBashPath}" -s`], { timeoutMs, signal: opts.signal, stdin: String(command), onData: opts.onData })
      }
      return this._runSsh(['--', this.destination(), String(command)], { timeoutMs, signal: opts.signal, onData: opts.onData })
    })
  }

  /** Open a fresh `ssh -s <dest> sftp` session and its ssh2 SFTP engine. */
  async _openSftpChannel() {
    const Sftp = loadSftpEngine()
    const secret = await this._resolveSecret()
    const sshBinary = resolveSshBinary(this.config)
    const args = [...baseSshArgs(this._argConfig(), { forSecret: !!secret }), '-s', this.destination(), 'sftp']
    const child = spawn(sshBinary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: secret ? askpassEnv(secret) : undefined })

    // ssh2's SFTP engine only reaches `_protocol` for channelData/channelClose,
    // and reads `_remoteIdentRaw` to pick its packet sizes.
    //
    // ## Flow control, the subtle part
    //
    // Over real SSH the engine's send window is topped up by CHANNEL_WINDOW_ADJUST
    // messages from the peer. On a raw `ssh -s sftp` pipe THERE ARE NO SUCH
    // MESSAGES — the local ssh owns the SSH-layer window and the server's grants,
    // and all we have is a byte pipe with OS-level backpressure. So the engine's
    // window has to be mapped onto the pipe's writability:
    //
    //   • a write the pipe accepts → more will fit;
    //   • the pipe fills (`stdin.write` returns false) → clamp the window so the
    //     engine buffers the remainder instead of queueing it all in memory;
    //   • the pipe drains → grant the window back and let the engine flush.
    //
    // The trap, and why the constants below are what they are: ssh2 arms its
    // flush callback (`_waitWindow` / `_chunkcb = drainBuffer`) ONLY from inside
    // its own subtraction, at the moment that subtraction takes the window to
    // exactly 0. So the window must be handed over in EXACT MULTIPLES of
    // packetSize and then left alone: the engine's own arithmetic then lands on 0
    // during normal operation and arms the flush callback we depend on.
    //
    // Do NOT "help" by clamping the window to 0 from inside channelData when the
    // pipe reports itself full. That sets the window to 0 AFTER the subtraction
    // has already happened, so the callback is never armed and the buffered
    // remainder is never flushed — the transfer deadlocks with a full window.
    // (Measured: a 4 MB upload stopped dead after 32 KB, with `_buffer.length`
    // stuck at 1 and no callback pending.) The pipe's own `drain` event is the
    // only place the window is refilled.
    //
    // Also tempting-but-wrong: adding each received packet's length to the
    // window. That happens to work for a DOWNLOAD (the peer's data is the
    // window) and deadlocks an upload, because a write's acknowledgements are
    // tiny status packets while each send consumes ~32 KB.
    //
    // See scripts/integration-openssh-large.mjs, which is what caught all of this.
    const PACKET = 32768
    const GRANT = PACKET * 8 // 256 KB per burst, and a multiple of packetSize
    const chan = { sftp: null }
    const fakeClient = {
      _protocol: {
        _remoteIdentRaw: Buffer.from('SSH-2.0-OpenSSH'),
        // Hand the bytes to the pipe and nothing else. Backpressure is expressed
        // through the engine's own window draining (see above); the OS pipe
        // buffer plus Node's write buffer absorb the in-flight remainder.
        channelData(_id, data) { try { child.stdin.write(data) } catch { /* close handles it */ } },
        channelClose() { try { child.stdin.end() } catch {} },
      },
    }
    const chanInfo = {
      type: 'sftp',
      incoming: { id: 0, window: GRANT, packetSize: PACKET, state: 'open' },
      outgoing: { id: 0, window: GRANT, packetSize: PACKET, state: 'open' },
    }
    // The stdin pipe can die underneath the engine at any moment (the remote
    // side of the sftp subsystem exits, the link drops — issue #118). Each write
    // after that fails, and without an 'error' listener the failure is an
    // uncaught exception that takes the whole Host down. Registering the guard
    // here, next to the only two places that write to this pipe, keeps the
    // blast radius at "this session is gone": 'close' fires as usual and the
    // cached session is dropped by sftp()'s own handler.
    guardChildStdin(child, () => { try { child.kill() } catch { /* already gone */ } })
    const sftp = new Sftp(fakeClient, chanInfo, {})
    chan.sftp = sftp

    // The pipe has room again: grant the window back and let the engine flush
    // whatever it buffered while the pipe was full.
    const onStdinDrain = () => {
      if (!chan.sftp) return
      chan.sftp.outgoing.window = GRANT
      if (chan.sftp._waitWindow) {
        chan.sftp._waitWindow = false
        const cb = chan.sftp._chunkcb
        chan.sftp._chunkcb = undefined
        if (typeof cb === 'function') cb.call(chan.sftp)
      }
    }
    child.stdin.on('drain', onStdinDrain)
    // A dead SSH process reports stdin EPIPE asynchronously. Without a stream
    // error listener Node crashes the host before close/drop can reset the
    // cached session (issue #118); kill it so that existing recovery runs.
    child.stdin.on('error', () => { try { child.kill() } catch {} })

    return new Promise((resolve, reject) => {
      let stderr = ''
      let settled = false
      const done = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) { try { child.kill() } catch {} ; reject(err) } else resolve({ child, sftp })
      }
      const timer = setTimeout(() => {
        done(new Error(`sftp session to ${this.destination()} timed out${stderr ? ': ' + stderr.trim() : ''}`))
      }, this.config.commandTimeoutMs)
      child.stderr.on('data', (d) => { stderr += d })
      sftp.on('error', (e) => done(new Error('sftp session failed: ' + ((e && e.message) || e))))
      sftp.on('ready', () => done(null))
      child.on('error', (e) => done(e))
      child.on('close', (code) => done(new Error(`ssh sftp exited (${code})${stderr ? ': ' + stderr.trim() : ''}`)))
      // Inbound is simpler: the local ssh already did the SSH-level window
      // accounting before handing us these bytes, so they just go straight in.
      child.stdout.on('data', (d) => { sftp.push(d) })
      child.stdout.on('end', () => { try { sftp.push(null) } catch { /* already gone */ } })
      sftp._init()
    })
  }

  /**
   * A persistent SFTP session, kept across calls: the picker and the explorer
   * issue one listing per interaction, and re-handshaking each time would be
   * visibly slow. A session that dies is dropped so the next call reconnects.
   */
  sftp() {
    if (this._sftpSession) return this._sftpSession
    const epoch = this.epoch
    const session = this._openSftpChannel().then(({ child, sftp }) => {
      const drop = () => {
        if (this._sftpSession === session) this._sftpSession = null
        if (this._sftpChild === child) this._sftpChild = null
      }
      child.on('close', drop)
      sftp.on('end', drop)
      sftp.on('error', drop)
      // A target switch during the handshake must not adopt the old host's
      // session (the same generational guard connect() uses).
      if (this.epoch !== epoch) {
        try { child.kill() } catch {}
        throw new Error('ssh target changed while opening sftp')
      }
      this._sftpChild = child
      return buildSftpSurface(sftp, {
        commandTimeoutMs: this.config.commandTimeoutMs,
        onTimeout: () => {
          // A timed-out SFTP session is dead: kill the child and drop the cached
          // session so the next call re-handshakes instead of queueing behind the
          // wedged one (issue #65).
          try { child.kill() } catch { /* already gone */ }
          drop()
        },
      })
    })
    // Never cache a rejected open: the next call must retry rather than get the
    // same error back forever (a failed handshake is usually transient).
    session.catch(() => { if (this._sftpSession === session) this._sftpSession = null })
    this._sftpSession = session
    return session
  }

  invalidate() {
    this.epoch++
    const client = this.client
    this.client = null
    this.connecting = null
    this._secret = null
    this._secretPromise = null
    if (client) { try { client.close() } catch {} }
    this._dropSftpSession()
    if (this.proxyPool) { try { this.proxyPool.close() } catch {} ; this.proxyPool = null }
    if (this.onCloseHook) { try { this.onCloseHook() } catch {} }
  }

  _dropSftpSession() {
    const session = this._sftpSession
    this._sftpSession = null
    if (this._sftpChild) {
      try { this._sftpChild.kill() } catch {}
      this._sftpChild = null
    }
    // Swallow the rejection: nobody awaits a session we are tearing down.
    if (session && typeof session.catch === 'function') session.catch(() => {})
  }

  close() {
    this.epoch++
    const client = this.client
    this.client = null
    this.connecting = null
    this._secret = null
    this._secretPromise = null
    if (client) { try { client.close() } catch {} }
    this._dropSftpSession()
    if (this.proxyPool) { try { this.proxyPool.close() } catch {} ; this.proxyPool = null }
    if (this.onCloseHook) { try { this.onCloseHook() } catch {} }
  }
}

/** Pick the pool class for a config: 'openssh' backend, else the native pool. */
export function isSystemOpenSshBackend(config = {}) {
  return String(config.backend || '').toLowerCase() === 'openssh'
}
