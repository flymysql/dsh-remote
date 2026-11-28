// Web-attach stop reporting — the honest-reporting class of #271/#272
// (recursive remove must report incompleteness) applied to `stopRemote`.
//
// Three failure shapes used to reach the caller as `stoppedRemote: true` while
// nothing was killed: the stop command's case-match refuses argvs without a
// dsh substring (custom webAttachCommand binaries), a process can survive the
// signal, and remotes without /proc (macOS) never attempt the kill at all — on
// top of an exec failure that .catch(() => {}) swallowed. The stop command now
// prints markers for what it could prove, close() classifies them, and the
// route claims `stoppedRemote` only from that evidence, keeping the old
// boolean on /proc-less remotes but labelling it unverified.
//
// Layered with the existing files: web-attach.test.js pins the command text
// and close()'s classification, web-attach-routes.test.js pins the route's
// response and audit per outcome; this file pins the two classification helpers
// themselves and the whole chain (real WebAttach → route) end to end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  WebAttach, buildStopCommand, parseStopOutcome, stopRemoteReport,
  STOP_FAILED_MARKER, STOP_REFUSED_MARKER, STOP_UNVERIFIED_MARKER,
} from '../lib/web-attach.js'
import { createWebAttachRoutes } from '../lib/routes-web-attach.js'
import posixShell from '../lib/posix-shell.cjs'

const { posixViaSh } = posixShell

// ── classification helpers ──────────────────────────────────────────────────

test('parseStopOutcome reads the stop markers out of an exec result', () => {
  const cases = [
    [STOP_FAILED_MARKER, 'failed'],
    [STOP_REFUSED_MARKER, 'refused'],
    [STOP_UNVERIFIED_MARKER, 'unverified'],
  ]
  for (const [marker, outcome] of cases) {
    // Banner noise around the marker is tolerated for the same reason the
    // launch parser tolerates it: the remote shell may echo its own preamble.
    assert.equal(parseStopOutcome({ code: 0, stdout: `noise\n${marker}\n`, stderr: '' }), outcome)
    assert.equal(parseStopOutcome(marker), outcome, 'a bare stdout string is accepted too')
  }
  assert.equal(parseStopOutcome({ code: 0, stdout: '', stderr: '' }), 'verified',
    'no marker and exit 0 = the PID was observed gone')
})

test('a stop that never really ran is unverified, never verified', () => {
  assert.equal(parseStopOutcome({ code: 127, stdout: '', stderr: 'sh: not found' }), 'unverified')
  assert.equal(parseStopOutcome({ code: null, stdout: '', stderr: '' }), 'unverified',
    'a signalled/timed-out command proves nothing either way')
  assert.equal(parseStopOutcome(undefined), 'unverified', 'no result at all is not evidence of a kill')
  assert.equal(parseStopOutcome(''), 'unverified', 'a string result carries no exit evidence')
})

test('stopRemoteReport maps every outcome to the fields the route may claim', () => {
  assert.deepEqual(stopRemoteReport('verified'), { stoppedRemote: true, note: '' },
    'a clean claim adds no field to the wire shape')
  assert.equal(stopRemoteReport('unverified').stoppedRemote, true,
    'wire compatibility: the /proc-less (macOS) shape keeps the old boolean')
  assert.match(stopRemoteReport('unverified').note, /unverified/)
  for (const outcome of ['failed', 'refused', 'error']) {
    assert.equal(stopRemoteReport(outcome).stoppedRemote, false, `${outcome} must not be claimed`)
    assert.ok(stopRemoteReport(outcome).note, `${outcome} must carry a reason`)
  }
  assert.equal(stopRemoteReport(null).stoppedRemote, false, 'no evidence → no claim')
  assert.match(stopRemoteReport(null).note, /not confirmed/)
})

// ── the stop command itself ──────────────────────────────────────────────────

test('the reporting stop command still crosses the POSIX sh boundary as one line', () => {
  const wrapped = posixViaSh(buildStopCommand(4242, '.dsh-remote-web-stop-report.log'))
  assert.match(wrapped, /^sh -c '/, 'the login shell only parses one simple invocation')
  assert.ok(!wrapped.includes('\n'), 'ssh exec takes a single line')
  // The probe must survive the close/reopen quoting, not just exist in the raw
  // command — shell-syntax.test.js parses this form with a real sh.
  assert.ok(wrapped.includes('echo __DSH_REMOTE_STOP_FAILED__'))
})

// ── the full chain: a real WebAttach, a scripted pool, the real route ────────
//
// Miniature copies of the doubles in web-attach.test.js, kept local so the
// helpers and the chain they serve travel in one self-contained file.

/** A `net` double: the listener binds whatever port it is asked for. */
function fakeNet() {
  return {
    createServer(onConnection) {
      const server = new EventEmitter()
      server.listen = (port, host) => {
        assert.equal(host, '127.0.0.1', 'the tunnel must stay loopback-only')
        server.port = port
        setImmediate(() => server.emit('listening'))
      }
      server.close = (cb) => { server.closed = true; setImmediate(() => cb && cb()) }
      server._onConnection = onConnection
      return server
    },
  }
}

/** A pool double whose exec answers the launch with a PID + startup line. */
function launchPool(stdout) {
  return {
    async connect() {
      return {
        forwardOut(_a, _b, _host, _port, cb) {
          const channel = new EventEmitter()
          channel.close = () => {}
          channel.pipe = () => channel
          setImmediate(() => cb(null, channel))
        },
      }
    },
    async exec() { return { code: 0, stdout, stderr: '' } },
  }
}

const READY = () => '__DSH_PID__=999\n dsh web: http://127.0.0.1:43129/?token=tok123\n__DSH_TAIL__\n'

/** Mount the real route factory around a scripted machine neighbourhood. */
function makeRouteWorld(stopExecResult) {
  const sent = []
  const audits = []
  const webAttaches = new Map()
  const stopPool = {
    calls: [],
    async exec(cmd, opts) {
      this.calls.push({ cmd, opts })
      return stopExecResult
    },
  }
  const routes = createWebAttachRoutes({
    sendJson: (res, status, body) => { sent.push({ status, body }) },
    readBody: async () => JSON.stringify({ action: 'close', machineId: 'm1', stopRemote: true }),
    parseJsonObject: (raw) => JSON.parse(raw || '{}'),
    config: { webAttachPortStart: 24488, webAttachDshHome: '', webAttachWaitSeconds: 5 },
    webAttaches,
    store: { currentId: 'm1' },
    machines: [{ id: 'm1', host: 'box.example.com', port: 22, username: 'u' }],
    poolForMachine: () => stopPool,
    identityOf: (m) => ({ host: m.host, port: Number(m.port) || 22, username: m.username || '' }),
    webAttachCommandFor: () => 'dsh',
    audit: (...args) => audits.push(args),
  })
  return { route: routes[0], sent, audits, webAttaches, stopPool }
}

/** Open a REAL managed attach and register it, ready for a close request. */
async function openManagedAttach(world) {
  const attach = new WebAttach({ net: fakeNet(), localPortStart: 24488 })
  await attach.open({ pool: launchPool(READY()), machineId: 'm1' })
  assert.equal(attach.remotePid, 999, 'the launch reported a PID, so the stop path is live')
  world.webAttaches.set('m1', attach)
  return attach
}

/** Fire the close request and return the single response it sent. */
async function requestClose(world) {
  await world.route.handler({ method: 'POST', url: '/dsh-remote/web-attach', headers: {} }, {})
  assert.equal(world.sent.length, 1, 'the handler must answer exactly once')
  return world.sent[0]
}

test('close end-to-end: a surviving process is reported as NOT stopped', async (t) => {
  const world = makeRouteWorld({ code: 0, stdout: `${STOP_FAILED_MARKER}\n`, stderr: '' })
  const attach = await openManagedAttach(world)
  t.after(async () => { try { await attach.close() } catch { /* already closed */ } })
  const r = await requestClose(world)
  // The stop the route ran is the POSIX-wrapped command for OUR pid.
  assert.equal(world.stopPool.calls.length, 1)
  assert.match(world.stopPool.calls[0].cmd, /^sh -c /)
  assert.match(world.stopPool.calls[0].cmd, /P=999/)
  assert.equal(r.status, 200)
  assert.equal(r.body.closed, true)
  assert.equal(r.body.stoppedRemote, false, 'the process answered the probe: it is alive')
  assert.match(String(r.body.stoppedRemoteNote), /still running/)
  assert.equal(world.audits.length, 1)
  assert.equal(world.audits[0][2], 1, 'an honestly-failed stop is a failure audit line')
})

test('close end-to-end: a verified kill keeps the historical success shape', async (t) => {
  const world = makeRouteWorld({ code: 0, stdout: '', stderr: '' })
  const attach = await openManagedAttach(world)
  t.after(async () => { try { await attach.close() } catch { /* already closed */ } })
  const r = await requestClose(world)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true, closed: true, stoppedRemote: true })
  assert.equal(world.audits[0][2], 0)
  assert.match(String(world.audits[0][1]), /\(remote stopped\)/)
})

test('close end-to-end: a refused kill (non-dsh argv) is reported as NOT stopped', async (t) => {
  const world = makeRouteWorld({ code: 0, stdout: `${STOP_REFUSED_MARKER}\n`, stderr: '' })
  const attach = await openManagedAttach(world)
  t.after(async () => { try { await attach.close() } catch { /* already closed */ } })
  const r = await requestClose(world)
  assert.equal(r.body.stoppedRemote, false, 'the argv no longer looks like our dsh; nothing was signalled')
  assert.match(String(r.body.stoppedRemoteNote), /refused/)
})

test('close end-to-end: a /proc-less remote is reported as unverified, not verified', async (t) => {
  const world = makeRouteWorld({ code: 0, stdout: `${STOP_UNVERIFIED_MARKER}\n`, stderr: '' })
  const attach = await openManagedAttach(world)
  t.after(async () => { try { await attach.close() } catch { /* already closed */ } })
  const r = await requestClose(world)
  assert.equal(r.body.stoppedRemote, true, 'the legacy boolean survives for wire compatibility')
  assert.match(String(r.body.stoppedRemoteNote), /unverified/, '…but it is labelled, not silent')
})
