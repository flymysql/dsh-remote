// Issue #125 — reuse an already-running remote `dsh web` before spawning one.
//
// The feature has two independent safety requirements:
//   • discovery is BEST-EFFORT: a printed URL adopts the resident instance only
//     after a real HTTP probe; empty output, command failure, timeout and a dead
//     URL all fall back to the existing launch path;
//   • a discovered URL carries a LIVE login token. Discovery results and audit
//     lines therefore carry only a status, never the command's raw output.
//
// The first half drives WebAttach with deterministic doubles. The second half
// uses the real SshPool against fake-ssh (including a real forwarded HTTP probe)
// and the real route/registry/audit wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  parseDiscoveredUrl, WebAttach, TAIL_MARKER,
} from '../lib/web-attach.js'
import { SshPool } from '../lib/pool.js'
import { startFakeSsh } from './harness/fake-ssh.js'
import { createHost, machine } from './harness/plugin-host.js'

const DISCOVER = 'cat /tmp/dsh-web-url'
const READY = (port = 43129, token = 'spawnSecret') =>
  `__DSH_PID__=999\ndsh web: http://127.0.0.1:${port}/?token=${token}\n${TAIL_MARKER}\n`

// ── URL parsing ─────────────────────────────────────────────────────────────

test('parseDiscoveredUrl takes the last VALID URL amid command noise', () => {
  const parsed = parseDiscoveredUrl([
    'resident dsh status follows',
    'http://127.0.0.1:3111/?token=older',
    'https://127.0.0.1:3222/?token=newer',
    'documentation: http://127.0.0.1:3333/ (no token, so not an instance)',
  ].join('\n'))
  assert.deepEqual(parsed, { url: 'https://127.0.0.1:3222/?token=newer', port: 3222, token: 'newer' })
})

test('parseDiscoveredUrl tolerates quotes but requires a real port and token', () => {
  assert.equal(parseDiscoveredUrl('URL="http://127.0.0.1:3999/?token=quoted"').token, 'quoted')
  for (const value of [
    '', null, undefined, 'no instance', 'http://127.0.0.1:3999/',
    'http://127.0.0.1:0/?token=x', 'not-a-url/?token=x',
    'http://10.0.0.5:3999/?token=nonLoopback',
  ]) assert.equal(parseDiscoveredUrl(value), null, `must reject ${JSON.stringify(value)}`)
})

// ── deterministic WebAttach doubles ────────────────────────────────────────

function fakeNet() {
  return {
    createServer() {
      const server = new EventEmitter()
      server.listen = (port, host) => {
        assert.equal(host, '127.0.0.1')
        server.port = port
        setImmediate(() => server.emit('listening'))
      }
      server.close = (cb) => setImmediate(() => cb && cb())
      return server
    },
  }
}

/**
 * A pool double. Discovery is matched by its exact raw command, proving it is
 * NOT rewritten through `sh -c`; launch commands contain `--port 0`.
 */
function fakePool({ discover = { code: 0, stdout: '' }, launch = READY(), probe = 'http' } = {}) {
  const calls = []
  const probes = []
  const client = {
    forwardOut(_srcHost, _srcPort, host, port, cb) {
      probes.push([host, port])
      if (probe === 'refused') return cb(new Error('connect ECONNREFUSED'))
      const channel = new EventEmitter()
      channel.close = () => {}
      channel.destroy = () => {}
      channel.write = () => {
        if (probe === 'http') setImmediate(() => channel.emit('data', Buffer.from('HTTP/1.1 401 Unauthorized\r\n\r\n')))
        if (probe === 'junk') setImmediate(() => channel.emit('data', Buffer.from('not an HTTP server')))
        // 'silent' never answers, exercising the probe deadline.
      }
      setImmediate(() => cb(null, channel))
    },
  }
  return {
    calls,
    probes,
    async connect() { return client },
    async exec(cmd, opts) {
      calls.push({ cmd, opts })
      if (cmd === DISCOVER) {
        if (discover instanceof Error) throw discover
        return typeof discover === 'function' ? discover() : discover
      }
      if (cmd.includes('--port 0')) return { code: 0, stdout: launch, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

function unitAttach() {
  return new WebAttach({
    net: fakeNet(), localPortStart: 3088, trackPool: false,
    discoverTimeoutMs: 30, probeTimeoutMs: 30,
  })
}

const launches = (pool) => pool.calls.filter((c) => c.cmd.includes('--port 0'))

test('a discovered and HEALTHY instance is adopted without launching a twin', async () => {
  const pool = fakePool({ discover: { code: 0, stdout: 'noise\nhttp://127.0.0.1:42080/?token=residentSecret\n' } })
  const attach = unitAttach()
  const info = await attach.open({ pool, machineId: 'm-hit', discoverCommand: DISCOVER })
  assert.equal(info.discovery, 'hit')
  assert.equal(info.remotePort, 42080)
  assert.equal(info.token, 'residentSecret')
  assert.equal(info.managed, false, 'a resident process is never ours to stop')
  assert.equal(attach.remotePid, 0)
  assert.equal(attach.logPath, '', 'adopting an instance creates no launch log')
  assert.equal(pool.calls.length, 1, 'only the discover command ran')
  assert.equal(pool.calls[0].cmd, DISCOVER, 'the user command keeps its login-shell semantics')
  assert.deepEqual(pool.probes, [['127.0.0.1', 42080]])
})

test('a Windows Git-Bash pool uses its raw login-shell exec for PowerShell discovery', async () => {
  const pool = fakePool()
  pool.platform = 'windows'
  pool.gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
  pool.detect = async () => {}
  const raw = []
  pool._execRaw = async (cmd, opts) => {
    raw.push({ cmd, opts })
    return { code: 0, stdout: 'http://127.0.0.1:42084/?token=windowsResident' }
  }
  const attach = unitAttach()
  const info = await attach.open({ pool, discoverCommand: 'powershell -NoProfile -Command "Get-Content $env:USERPROFILE\\.dsh-web-url"' })
  assert.equal(info.discovery, 'hit')
  assert.equal(info.token, 'windowsResident')
  assert.equal(raw.length, 1)
  assert.match(raw[0].cmd, /^powershell /, 'the PowerShell command must not be piped into Git Bash')
  assert.equal(pool.calls.length, 0, 'the wrapped pool.exec is bypassed for this one command')
})

test('empty discovery output falls back to spawning and reports miss', async () => {
  const pool = fakePool({ discover: { code: 0, stdout: '' } })
  const attach = unitAttach()
  const info = await attach.open({ pool, discoverCommand: DISCOVER })
  assert.equal(info.discovery, 'miss')
  assert.equal(info.managed, true)
  assert.equal(info.remotePort, 43129)
  assert.equal(launches(pool).length, 1)
})

test('a normal not-found exit (grep/pgrep = 1) is a miss, not a command error', async () => {
  const pool = fakePool({ discover: { code: 1, stdout: '' } })
  const attach = unitAttach()
  const info = await attach.open({ pool, discoverCommand: DISCOVER })
  assert.equal(info.discovery, 'miss')
  assert.equal(launches(pool).length, 1)
})

for (const [name, discover, expected] of [
  ['a TIMEOUT result', { code: -1, signal: 'TIMEOUT', stdout: '' }, 'timeout'],
  ['an ABORTED result', { code: -1, signal: 'ABORTED', stdout: '' }, 'timeout'],
  ['an exec rejection', new Error('channel exploded'), 'error'],
  ['a command-not-found exit', { code: 127, stdout: '', stderr: 'not found' }, 'error'],
  ['a not-executable exit', { code: 126, stdout: '' }, 'error'],
]) {
  test(`${name} falls back to spawning with the ${expected} diagnostic`, async () => {
    const pool = fakePool({ discover })
    const attach = unitAttach()
    const info = await attach.open({ pool, discoverCommand: DISCOVER })
    assert.equal(info.discovery, expected)
    assert.equal(launches(pool).length, 1)
    assert.equal(info.managed, true)
  })
}

test('a discovered URL that refuses the probe is not attached to', async () => {
  const pool = fakePool({
    discover: { code: 0, stdout: 'http://127.0.0.1:42081/?token=staleSecret' },
    probe: 'refused',
  })
  const attach = unitAttach()
  const info = await attach.open({ pool, discoverCommand: DISCOVER })
  assert.equal(info.discovery, 'probe-failed')
  assert.equal(info.remotePort, 43129, 'the fresh launch, not the stale URL, wins')
  assert.equal(info.token, 'spawnSecret')
  assert.equal(launches(pool).length, 1)
})

test('a discovered URL that hangs past the probe deadline falls back too', async () => {
  const pool = fakePool({
    discover: { code: 0, stdout: 'http://127.0.0.1:42082/?token=hungSecret' },
    probe: 'silent',
  })
  const attach = unitAttach()
  const info = await attach.open({ pool, discoverCommand: DISCOVER })
  assert.equal(info.discovery, 'probe-failed')
  assert.equal(launches(pool).length, 1)
})

test('a non-HTTP answer is not evidence of a live DSH', async () => {
  const pool = fakePool({
    discover: { code: 0, stdout: 'http://127.0.0.1:42083/?token=junkSecret' },
    probe: 'junk',
  })
  const attach = unitAttach()
  const info = await attach.open({ pool, discoverCommand: DISCOVER })
  assert.equal(info.discovery, 'probe-failed')
  assert.equal(launches(pool).length, 1)
})

test('an explicit existingUrl bypasses discovery, preserving the old manual path', async () => {
  const pool = fakePool({ discover: { code: 0, stdout: 'http://127.0.0.1:42080/?token=mustNotRun' } })
  const attach = unitAttach()
  const info = await attach.open({
    pool, existingUrl: 'http://127.0.0.1:42090/?token=manual', discoverCommand: DISCOVER,
  })
  assert.equal(info.discovery, '')
  assert.equal(info.remotePort, 42090)
  assert.equal(pool.calls.length, 0)
})

test('no configured discover command keeps the historical always-spawn behaviour', async () => {
  const pool = fakePool()
  const attach = unitAttach()
  const info = await attach.open({ pool })
  assert.equal(info.discovery, '')
  assert.equal(pool.calls.length, 1)
  assert.equal(launches(pool).length, 1)
})

test('closing a discovered session with stopRemote never signals the resident PID', async () => {
  const pool = fakePool({ discover: { code: 0, stdout: 'http://127.0.0.1:42080/?token=residentSecret' } })
  const attach = unitAttach()
  await attach.open({ pool, discoverCommand: DISCOVER })
  await attach.close({ stopRemote: true, exec: pool.exec })
  assert.equal(attach.remotePid, 0)
  assert.equal(pool.calls.some((c) => /kill|\/proc\//.test(c.cmd)), false)
})

test('discovery results never retain raw stdout or the discovered token', async () => {
  const attach = unitAttach()
  const result = await attach._discoverRunning(async () => ({
    code: 0, stdout: 'http://127.0.0.1:42080/?token=verySensitive', stderr: 'secret noise',
  }), DISCOVER)
  assert.equal(result.status, 'hit')
  assert.deepEqual(Object.keys(result), ['status', 'parsed'])
  assert.equal(result.stdout, undefined)
  assert.equal(result.stderr, undefined)
  assert.equal(JSON.stringify(result).includes('secret noise'), false)
  // The parsed token is the one credential the attach itself needs; no extra
  // copy of the command output travels with the diagnostic.
  assert.equal(result.parsed.token, 'verySensitive')
})

// ── real SSH pool + fake sshd ────────────────────────────────────────────────

const POOL_CONFIG = {
  host: '127.0.0.1', port: 22, username: 'root', password: 'pw', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 2000, connectTimeoutMs: 2000,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

const localPort = () => 24000 + Math.floor(Math.random() * 20000)

test('fake SSH + real pool: discovery miss runs the raw command then the launch', async (t) => {
  const srv = await startFakeSsh({
    users: { root: { password: 'pw' } },
    onExec(cmd) {
      if (cmd === DISCOVER) return { code: 0, stdout: '' }
      if (cmd.includes('--port 0')) return { code: 0, stdout: READY(43130, 'missSpawn') }
      return null
    },
  })
  const pool = new SshPool({ ...POOL_CONFIG, port: srv.port })
  const attach = new WebAttach({ localPortStart: localPort(), discoverTimeoutMs: 100, probeTimeoutMs: 100 })
  t.after(async () => { await attach.close(); pool.close(); await srv.close() })
  const info = await attach.open({ pool, discoverCommand: DISCOVER })
  assert.equal(info.discovery, 'miss')
  assert.equal(info.remotePort, 43130)
  assert.equal(info.token, 'missSpawn')
  assert.ok(srv.execLog.includes(DISCOVER), 'the exact user command reached the fake sshd')
  assert.equal(srv.execLog.filter((c) => c.includes('--port 0')).length, 1)
})

test('fake SSH + real pool: a real client-side TIMEOUT falls back to launch', async (t) => {
  const srv = await startFakeSsh({
    users: { root: { password: 'pw' } },
    onExec(cmd) {
      if (cmd === DISCOVER) return { code: 0, stdout: 'http://127.0.0.1:4999/?token=tooLate', delayMs: 250 }
      if (cmd.includes('--port 0')) return { code: 0, stdout: READY(43131, 'timeoutSpawn') }
      return null
    },
  })
  const pool = new SshPool({ ...POOL_CONFIG, port: srv.port })
  const attach = new WebAttach({ localPortStart: localPort(), discoverTimeoutMs: 30, probeTimeoutMs: 30 })
  t.after(async () => { await attach.close(); pool.close(); await srv.close() })
  const info = await attach.open({ pool, discoverCommand: DISCOVER })
  assert.equal(info.discovery, 'timeout')
  assert.equal(info.remotePort, 43131)
  assert.equal(info.token, 'timeoutSpawn', 'the late discover answer must not overwrite the fresh launch')
  assert.equal(srv.execLog.filter((c) => c.includes('--port 0')).length, 1)
})

test('real route + fake SSH + forwarded HTTP probe: hit is audited without its token', async (t) => {
  const requests = []
  const resident = http.createServer((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('resident dsh')
  })
  await new Promise((resolve) => resident.listen(0, '127.0.0.1', resolve))
  const residentPort = resident.address().port
  const residentToken = 'residentTokenMustNotEnterAudit'
  const srv = await startFakeSsh({
    users: { root: { password: 'pw' } },
    onExec(cmd) {
      if (cmd === DISCOVER) return { code: 0, stdout: `banner\nhttp://127.0.0.1:${residentPort}/?token=${residentToken}\n` }
      if (cmd.includes('--port 0')) return { code: 0, stdout: READY(43132, 'mustNotSpawn') }
      return null
    },
  })
  const host = await createHost({
    machines: [machine({
      id: 'm125', host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw',
      hostKeyMode: 'off', webAttachDiscoverCommand: DISCOVER,
    })],
    config: { auditLog: true, webAttachPortStart: localPort(), commandTimeoutMs: 2000, connectTimeoutMs: 2000 },
  })
  t.after(async () => {
    await host.dispose()
    await srv.close()
    await new Promise((resolve) => resident.close(resolve))
  })

  const opened = await host.call('/dsh-remote/web-attach', { body: { action: 'open', machineId: 'm125' } })
  assert.equal(opened.status, 200, opened.raw)
  assert.equal(opened.json.attach.discovery, 'hit')
  assert.equal(opened.json.attach.remotePort, residentPort)
  assert.equal(opened.json.attach.managed, false)
  assert.equal(srv.execLog.filter((c) => c.includes('--port 0')).length, 0, 'a resident hit must not spawn')
  assert.deepEqual(requests, ['/'], 'the probe is a token-less GET /')

  const audit = readFileSync(path.join(host.root, 'audit.log'), 'utf8')
  assert.match(audit, /discover: hit/)
  assert.ok(!audit.includes(residentToken), 'the discovered login token must never reach audit.log')
  assert.ok(!audit.includes(DISCOVER), 'the discover command line itself is not needed in the audit entry')

  const closed = await host.call('/dsh-remote/web-attach', { body: { action: 'close', machineId: 'm125', stopRemote: true } })
  assert.equal(closed.json.stoppedRemote, false, 'a discovered instance is deliberately unmanaged')
})
