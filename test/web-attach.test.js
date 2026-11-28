// Issue #46 — "can I connect to a remote dsh-web?" Answer: yes, by inverting the
// direction. We SSH out, boot (or reuse) a loopback-bound `dsh web` on the
// remote, and carry its socket back with a local TCP forward.
//
// These tests pin the parts that are easy to get subtly wrong and expensive to
// find live:
//   • the startup line is the ONLY source of the token (process-local
//     randomBytes, never a file), and it must be parsed together with the port
//     so the pair stays consistent;
//   • a remote that dies during boot must be reported with its output, not
//     turned into a silent timeout;
//   • the listener is loopback-only and moves past ports already in use;
//   • closing never kills a remote process we did not start unless asked.
//
// Everything is driven through injected doubles (`net`, `exec`), so no SSH or
// real socket is involved; the end-to-end case against a real Linux host lives
// in the integration script.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  parseWebStart, launchFailed, buildLaunchCommand, parseRemotePid, buildStopCommand,
  explainLaunchFailure, WebAttach, TAIL_MARKER, PID_MARKER,
} from '../lib/web-attach.js'

// ── startup-line parsing ────────────────────────────────────────────────────

test('parses the launch line into a consistent (token, port) pair', () => {
  const parsed = parseWebStart('dsh web: http://127.0.0.1:43129/?token=Iy7FKuPSI5qJKJUFDyah4B6i8Ul6_hvspiJhiWufYt8\n')
  assert.equal(parsed.port, 43129)
  assert.equal(parsed.token, 'Iy7FKuPSI5qJKJUFDyah4B6i8Ul6_hvspiJhiWufYt8')
})

test('tolerates a LAN suffix and surrounding log noise', () => {
  const log = [
    'some earlier boot noise',
    'dsh web: http://127.0.0.1:3080/?token=abcDEF123 (LAN: http://10.0.0.5:3080/?token=abcDEF123)',
    'dsh web: opening the default browser',
  ].join('\n')
  const parsed = parseWebStart(log)
  assert.equal(parsed.port, 3080)
  assert.equal(parsed.token, 'abcDEF123')
})

test('takes the LAST launch line, because a reused log may hold an earlier one', () => {
  const log = 'dsh web: http://127.0.0.1:1111/?token=OLD\ndsh web: http://127.0.0.1:2222/?token=NEW\n'
  const parsed = parseWebStart(log)
  assert.equal(parsed.port, 2222, 'a stale line must never win over the newest')
  assert.equal(parsed.token, 'NEW')
})

test('reports "not ready" rather than guessing', () => {
  for (const input of ['', null, undefined, 'booting...', 'dsh web: not-a-url',
    'dsh web: http://127.0.0.1:3080', // no token yet
    'dsh web: http://127.0.0.1:0/?token=x']) {
    assert.equal(parseWebStart(input), null, `must not parse ${JSON.stringify(input)}`)
  }
})

test('detects a remote that died instead of booting', () => {
  assert.equal(launchFailed('__DSH_REMOTE_DIED__\n...stack...'), true)
  assert.equal(launchFailed('dsh web: http://127.0.0.1:1/?token=x'), false)
})

test('extracts the remote pid so the session can stop its own process', () => {
  assert.equal(parseRemotePid(`noise\n${PID_MARKER}4211\ndsh web: ...`), 4211)
  assert.equal(parseRemotePid('no pid here'), 0)
})

// ── launch command ──────────────────────────────────────────────────────────

test('the launch command detaches, bounds its wait, and reports failure', () => {
  const cmd = buildLaunchCommand({ command: 'dsh', profile: 'web', logPath: '.log-x', waitSeconds: 30 })
  assert.match(cmd, /setsid/, 'must detach, or the channel close SIGHUPs the server')
  assert.match(cmd, /nohup/)
  assert.match(cmd, /--profile web/)
  assert.match(cmd, /--port 0/, 'port 0 lets the remote pick, and the line reports it')
  assert.match(cmd, /--no-open/)
  assert.match(cmd, /i -lt 30/, 'the wait must be bounded')
  assert.match(cmd, /__DSH_REMOTE_DIED__/, 'a dead process must be distinguishable from a slow one')
  assert.match(cmd, new RegExp(TAIL_MARKER), 'the log tail must come back for diagnostics')
  assert.ok(!cmd.includes('\n'), 'must stay a single line for ssh exec')
})

test('the launch command honours a custom executable, port, and DSH_HOME', () => {
  const cmd = buildLaunchCommand({
    command: '/tmp/dshprefix/node_modules/.bin/dsh', profile: 'web',
    logPath: '.log-y', remotePort: 42080, dshHome: '/tmp/home',
  })
  assert.match(cmd, /\/tmp\/dshprefix\/node_modules\/\.bin\/dsh/)
  assert.match(cmd, /--port 42080/)
  assert.match(cmd, /DSH_HOME="\/tmp\/home"/, 'an isolated remote home must be honoured')
})

// Regression (caught only by running against a real host): the statements are
// joined with `; `, so emitting `while …; do` as its own element produced the
// literal `do;` — a POSIX syntax error that made every attach fail with
// "syntax error near unexpected token `;'" while the equivalent script worked.
test('the shell loop keyword `do` is never emitted as its own `; `-separated statement', () => {
  const cmd = buildLaunchCommand({ command: 'dsh', profile: 'web', logPath: '.log-z' })
  assert.doesNotMatch(cmd, /;\s*do\s*;/, '`do;` is a syntax error in POSIX sh')
  assert.match(cmd, /;\s*do\s+\S/, '`do` must be glued to its first command')
  // `sh -c` is what sshd runs, so the command must be valid sh even though the
  // host half often executes through bash.
  assert.match(cmd, /done$|done;/, 'the loop must be closed')
})

test('an empty DSH_HOME does not emit an empty assignment', () => {
  const cmd = buildLaunchCommand({ command: 'dsh', profile: 'web', logPath: '.l' })
  assert.doesNotMatch(cmd, /DSH_HOME=""/)
})

// ── listener behaviour ──────────────────────────────────────────────────────

/** A `net` double: servers bind unless the port is listed as taken. */
function fakeNet({ taken = [] } = {}) {
  const bound = []
  return {
    bound,
    createServer(onConnection) {
      const server = new EventEmitter()
      const sockets = []
      server.listen = (port, host) => {
        assert.equal(host, '127.0.0.1', 'the tunnel must be loopback-only')
        if (taken.includes(port)) {
          const err = new Error('in use')
          err.code = 'EADDRINUSE'
          setImmediate(() => server.emit('error', err))
          return
        }
        bound.push(port)
        server.port = port
        setImmediate(() => server.emit('listening'))
      }
      server.close = (cb) => { server.closed = true; setImmediate(() => cb && cb()) }
      server._onConnection = onConnection
      server._sockets = sockets
      return server
    },
  }
}

/** A pool double whose exec replies with scripted output. */
function fakePool(output, { onExec } = {}) {
  return {
    execCalls: [],
    async connect() {
      return {
        forwardOut(_a, _b, host, port, cb) {
          if (onExec) onExec(host, port)
          const channel = new EventEmitter()
          channel.close = () => {}
          channel.pipe = () => channel
          setImmediate(() => cb(null, channel))
        },
      }
    },
    async exec(cmd, opts) {
      this.execCalls.push({ cmd, opts })
      return { code: 0, stdout: typeof output === 'function' ? output(cmd) : output, stderr: '' }
    },
  }
}

const READY = (port = 43129, token = 'tok123') =>
  `__DSH_PID__=999\n dsh web: http://127.0.0.1:${port}/?token=${token}\n${TAIL_MARKER}\n`

test('open() binds loopback, records the parsed port/token, and exposes a URL', async () => {
  const netDouble = fakeNet()
  const attach = new WebAttach({ net: netDouble, localPortStart: 3088 })
  const pool = fakePool(READY(43129, 'abc'))
  const info = await attach.open({ pool, machineId: 'm-1' })
  assert.deepEqual(netDouble.bound, [3088])
  assert.equal(info.remotePort, 43129)
  assert.equal(info.localPort, 3088)
  assert.equal(info.url, 'http://127.0.0.1:3088/?token=abc')
  assert.equal(info.machineId, 'm-1')
  assert.equal(attach.active, true)
})

test('open() skips local ports already in use', async () => {
  const netDouble = fakeNet({ taken: [3088, 3089] })
  const attach = new WebAttach({ net: netDouble, localPortStart: 3088 })
  await attach.open({ pool: fakePool(READY()) })
  assert.equal(attach.localPort, 3090, 'must advance past EADDRINUSE')
})

test('open() fails loudly when every candidate port is taken', async () => {
  const netDouble = fakeNet({ taken: [3088, 3089] })
  const attach = new WebAttach({ net: netDouble, localPortStart: 3088, localPortMax: 2 })
  await assert.rejects(attach.open({ pool: fakePool(READY()) }), /no free local port/)
})

test('a remote that dies during boot reports its output, not a bare timeout', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  const out = `__DSH_REMOTE_DIED__\n${TAIL_MARKER}\nError: Cannot find module 'pty.node'`
  await assert.rejects(
    attach.open({ pool: fakePool(out) }),
    (err) => {
      assert.match(err.message, /exited during startup/)
      assert.match(err.message, /pty\.node/, 'the remote error must reach the operator')
      return true
    },
  )
})

test('a remote that never reports a token explains what to check', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  await assert.rejects(
    attach.open({ pool: fakePool(`noise\n${TAIL_MARKER}\nstill booting`) }),
    /did not report a startup token/,
  )
})

// Measured on a real Linux host: dsh 0.1.0-rc.6 depends on node-pty@1.1.0, whose
// published tarball ships darwin/win32 prebuilds but NO linux-x64, so `dsh web`
// cannot start there. Without this the operator only sees "no startup token" and
// reasonably blames the plugin.
test('the node-pty Linux failure is explained with the known cause and the fix', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  const out = `__DSH_REMOTE_DIED__\n${TAIL_MARKER}\nFailed to load native module: pty.node, checked: build/Release`
  await assert.rejects(attach.open({ pool: fakePool(out) }), (err) => {
    assert.match(err.message, /node-pty/)
    assert.match(err.message, /0\.1\.0-rc\.6/, 'must name the affected version range')
    assert.match(err.message, /0\.1\.5-rc\.2/, 'must name a working version')
    assert.match(err.message, /linux-x64/)
    return true
  })
})

test('a missing dsh binary points at webAttachCommand', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  const out = `__DSH_REMOTE_DIED__\n${TAIL_MARKER}\nsh: dsh: command not found`
  await assert.rejects(attach.open({ pool: fakePool(out) }), /webAttachCommand/)
})

test('an unrecognized failure adds no misleading hint', () => {
  assert.equal(explainLaunchFailure('some novel explosion'), '')
  assert.equal(explainLaunchFailure(''), '')
})

// Measured on a real Linux host: dsh 0.1.0-rc.6 has no `--no-open` flag and
// exits "unknown option '--no-open'" before doing anything. Retrying once
// without that flag is safe precisely because the first attempt provably never
// started a server.
test('an old dsh without --no-open is retried once, without it', async () => {
  const seen = []
  const pool = {
    async connect() { return { forwardOut: (_a, _b, _h, _p, cb) => { const c = new EventEmitter(); c.close = () => {}; c.pipe = () => c; setImmediate(() => cb(null, c)) } } },
    async exec(cmd) {
      seen.push(cmd)
      // First attempt: the old CLI rejects the flag and dies. Second: it works.
      if (/--no-open/.test(cmd)) return { code: 0, stdout: `error: unknown option '--no-open'\n__DSH_REMOTE_DIED__`, stderr: '' }
      return { code: 0, stdout: READY(43210, 'tokAfterRetry'), stderr: '' }
    },
  }
  const netDouble = fakeNet()
  const attach = new WebAttach({ net: netDouble })
  const info = await attach.open({ pool, machineId: 'm-old' })
  assert.equal(seen.length, 2, 'exactly one retry')
  assert.match(seen[0], /--no-open/, 'the first attempt uses the preferred form')
  assert.doesNotMatch(seen[1], /--no-open/, 'the retry drops the unsupported flag')
  assert.equal(info.remotePort, 43210)
  assert.equal(attach.omittedNoOpen, true, 'the session records that it had to omit the flag')
})

test('an unrelated unknown-option failure is NOT retried', async () => {
  let calls = 0
  const pool = {
    async connect() { return { forwardOut: (_a, _b, _h, _p, cb) => { const c = new EventEmitter(); c.close = () => {}; c.pipe = () => c; setImmediate(() => cb(null, c)) } } },
    async exec() { calls++; return { code: 0, stdout: `error: unknown option '--wat'\n__DSH_REMOTE_DIED__`, stderr: '' } },
  }
  const attach = new WebAttach({ net: fakeNet() })
  await assert.rejects(attach.open({ pool }), /exited during startup/)
  assert.equal(calls, 1, 'only the known --no-open incompatibility is worth a retry')
})

test('buildLaunchCommand can omit --no-open on request', () => {
  const withFlag = buildLaunchCommand({ command: 'dsh', profile: 'web', logPath: '.l' })
  const without = buildLaunchCommand({ command: 'dsh', profile: 'web', logPath: '.l', omitNoOpen: true })
  assert.match(withFlag, /--no-open/)
  assert.doesNotMatch(without, /--no-open/)
  // Everything else must be untouched by the omission.
  assert.match(without, /--profile web/)
  assert.match(without, /--port 0/)
})

test('an existing remote URL attaches without launching anything', async () => {
  const pool = fakePool('unused')
  const attach = new WebAttach({ net: fakeNet(), localPortStart: 3088 })
  const info = await attach.open({
    pool, machineId: 'm-2',
    existingUrl: 'http://127.0.0.1:42080/?token=presetToken',
  })
  assert.equal(pool.execCalls.length, 0, 'reusing a running instance must not start another')
  assert.equal(info.remotePort, 42080)
  assert.equal(info.url, 'http://127.0.0.1:3088/?token=presetToken')
})

test('a malformed existing URL is rejected before any connection work', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  await assert.rejects(
    attach.open({ pool: fakePool(READY()), existingUrl: 'http://127.0.0.1:42080/' }),
    /must look like/,
  )
})

test('open() requires a machine', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  await assert.rejects(attach.open({}), /machine pool is required/)
})

// ── proxying ────────────────────────────────────────────────────────────────

test('a local connection is carried to the remote web port over SSH', async () => {
  const seen = []
  const netDouble = fakeNet()
  const attach = new WebAttach({ net: netDouble })
  await attach.open({
    pool: fakePool(READY(43129), { onExec: (host, port) => seen.push([host, port]) }),
  })
  // Simulate the browser connecting to the local listener.
  const socket = new EventEmitter()
  socket.destroy = () => { socket.destroyed = true }
  socket.pipe = () => socket
  netDouble.createServer(() => {})
  attach._pipe(socket)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(seen, [['127.0.0.1', 43129]], 'must target the parsed remote port')
})

test('a socket with no live client is dropped, not leaked', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  let destroyed = false
  const socket = { destroy() { destroyed = true }, pipe() {} }
  attach._pipe(socket)
  assert.equal(destroyed, true)
})

// ── teardown ────────────────────────────────────────────────────────────────

test('close() stops the listener and drops sockets', async () => {
  const netDouble = fakeNet()
  const attach = new WebAttach({ net: netDouble })
  await attach.open({ pool: fakePool(READY()) })
  const server = attach.server
  let socketDestroyed = false
  attach.sockets.add({ destroy() { socketDestroyed = true } })
  await attach.close()
  assert.equal(server.closed, true, 'the listener must be closed')
  assert.equal(socketDestroyed, true, 'live sockets must be destroyed')
  assert.equal(attach.active, false)
})

test('close() does NOT kill the remote process by default', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool: fakePool(READY()) })
  const calls = []
  await attach.close({ exec: async (cmd) => { calls.push(cmd) } })
  assert.deepEqual(calls, [], 'a DSH we did not start, or the user still needs, must survive')
})

test('close({stopRemote}) signals the PID this session recorded, not a name pattern', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool: fakePool(READY()) })
  const calls = []
  await attach.close({ stopRemote: true, exec: async (cmd) => { calls.push(cmd) } })
  assert.equal(calls.length, 1)
  assert.equal(attach.remotePid, 999, 'the launch reported a PID')
  assert.match(calls[0], /P=999/, 'must signal the recorded PID')
  assert.match(calls[0], /\/proc\/\$P\/cmdline/, 'must re-verify before signalling')
  assert.doesNotMatch(calls[0], /pkill/, 'pkill -f cannot match: the log path is not in argv')
})

// Regression (caught only by running against a real host): stopRemote used to
// `pkill -f` the session log path, but that path exists only as a shell redirect
// and never appears in the process argv, so nothing matched and the remote DSH
// was leaked. Verified live: the process stayed listening.
//
// The first fix then matched the PORT in argv — which also never fires, because
// the launch deliberately uses `--port 0` and only learns the real port from the
// startup line. Both traps are pinned here.
test('the stop command refuses to signal a PID that is not our dsh', () => {
  const cmd = buildStopCommand(1234)
  assert.match(cmd, /P=1234/)
  assert.match(cmd, /-d "\/proc\/\$P"/, 'a vanished process must be a no-op')
  assert.match(cmd, /\*dsh\*/, 'the target must still look like a dsh process')
  assert.match(cmd, /true$/, 'must always exit 0 so teardown cannot fail the caller')
})

test('the stop command kills the process GROUP, so --port 0 cannot defeat it', () => {
  const cmd = buildStopCommand(1234)
  assert.match(cmd, /kill -- -"\$P"/, 'setsid makes the child a group leader; kill its group')
  assert.match(cmd, /kill "\$P"/, 'fall back to the single PID when setsid was unavailable')
  assert.doesNotMatch(cmd, /--port/, 'never rely on the port: we launch with --port 0')
})

test('the stop command is a no-op without a recorded PID', () => {
  assert.equal(buildStopCommand(0), 'true')
  assert.equal(buildStopCommand(undefined), 'true')
})

test('the stop command also removes this session\'s log, so attaches do not accumulate files', () => {
  const cmd = buildStopCommand(1234, '.dsh-remote-web-abc.log')
  assert.match(cmd, /rm -f "\$HOME\/\.dsh-remote-web-abc\.log"/)
  // A no-op stop must still clean up its own log.
  assert.match(buildStopCommand(0, '.log-x'), /rm -f "\$HOME\/\.log-x"/)
  assert.doesNotMatch(buildStopCommand(0), /rm -f/, 'no log path means nothing to remove')
})

// The stop command must REPORT what it achieved. It ended in `; true` (always
// exit 0), its case-match deliberately refuses argvs without a dsh substring
// (custom webAttachCommand binaries), remotes without /proc (macOS) skip the
// kill entirely, and an exec failure was swallowed — while the route answered
// `stoppedRemote: true` from the request flag alone. Three failure shapes
// therefore all read as success, the same dishonest-reporting class the
// maintainer fixed for recursive remove (#271/#272). The markers below are what
// close() parses into that claim.
test('the stop command reports a surviving process, a refusal, and an unverifiable remote', () => {
  const cmd = buildStopCommand(1234)
  assert.match(cmd, /__DSH_REMOTE_STOP_FAILED__/, 'a process that survives the signal must be distinguishable from a dead one')
  assert.match(cmd, /\[ -d "\/proc\/\$P" \] && echo __DSH_REMOTE_STOP_FAILED__/, 'the probe runs after the kill')
  assert.match(cmd, /while \[ -d "\/proc\/\$P" \] && \[ "\$i" -lt 3 \]; do sleep 1/, 'the probe waits briefly: SIGTERM needs a scheduler turn before /proc shows the death')
  assert.match(cmd, /__DSH_REMOTE_STOP_REFUSED__/, 'the never-kill-a-stranger refusal must be visible, not silent')
  assert.match(cmd, /__DSH_REMOTE_STOP_UNVERIFIED__/, 'a remote without /proc must say so instead of printing nothing')
  assert.match(cmd, /elif \[ ! -d \/proc \]/, 'the unverified shape is exactly the macOS/other-Unix case')
  assert.ok(!cmd.includes('\n'), 'must stay a single line for ssh exec')
})

test('reporting never weakens the stop command\'s contracts', () => {
  const cmd = buildStopCommand(1234, '.log-r')
  // The cleanup stays unconditional and outside the kill branches.
  assert.ok(cmd.indexOf('rm -f') > cmd.indexOf('esac'), 'the log is removed whether or not the kill fired')
  assert.match(cmd, /kill -- -"\$P"/, 'the group kill is unchanged')
  assert.match(cmd, /\*dsh\*/, 'the argv re-verification is unchanged')
  assert.match(cmd, /true$/, 'must still always exit 0 so teardown cannot fail the caller')
})

test('close() passes this session\'s log path to the stop command', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool: fakePool(READY()) })
  assert.match(attach.logPath, /^\.dsh-remote-web-.+\.log$/, 'the session records its log file')
  const calls = []
  await attach.close({ stopRemote: true, exec: async (cmd) => { calls.push(cmd) } })
  assert.match(calls[0], new RegExp(attach.logPath.replace(/\./g, '\\.')))
})

// close() returns what the stop PROVED so the route can claim only that
// (#271/#272 honest-reporting line). The route used to read the request flag
// back as the result; these tests fail until close() classifies the stop
// command's markers into the outcome the route consumes.
test('close() returns what the stop command proved, so the route can claim only that', async () => {
  const byOutcome = [
    ['__DSH_REMOTE_STOP_FAILED__\n', 'failed'],
    ['__DSH_REMOTE_STOP_REFUSED__\n', 'refused'],
    ['__DSH_REMOTE_STOP_UNVERIFIED__\n', 'unverified'],
    ['', 'verified'],
  ]
  for (const [stdout, outcome] of byOutcome) {
    const attach = new WebAttach({ net: fakeNet() })
    await attach.open({ pool: fakePool(READY()) })
    const report = await attach.close({ stopRemote: true, exec: async () => ({ code: 0, stdout, stderr: '' }) })
    assert.equal(report.stopOutcome, outcome, `stdout ${JSON.stringify(stdout)} must classify as ${outcome}`)
  }
})

test('a stop command that exits non-zero without markers is unverified, never verified', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool: fakePool(READY()) })
  const report = await attach.close({ stopRemote: true, exec: async () => ({ code: 127, stdout: '', stderr: 'sh: not found' }) })
  assert.equal(report.stopOutcome, 'unverified', 'a command that never really ran proves nothing')
})

test('close() reports "error" when the stop exec itself fails, instead of swallowing it', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool: fakePool(READY()) })
  // The old .catch(() => {}) turned exactly this shape into a silent success.
  const report = await attach.close({ stopRemote: true, exec: async () => { throw new Error('channel closed') } })
  assert.equal(report.stopOutcome, 'error')
})

test('close() is safe to call twice', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool: fakePool(READY()) })
  await attach.close()
  await attach.close()
  assert.equal(attach.active, false)
})

test('describe() reports the full status for the settings UI', async () => {
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool: fakePool(READY(43129, 'tok')), machineId: 'm-9' })
  const d = attach.describe()
  assert.equal(d.machineId, 'm-9')
  assert.equal(d.localPort, 3088)
  assert.equal(d.remotePort, 43129)
  assert.equal(d.active, true)
  assert.match(d.url, /\?token=tok$/, 'the token rides only on the loopback URL')
  assert.equal(d.cleanUrl, 'http://127.0.0.1:3088/')
})
