// Issue #111: WebAttach generates POSIX scripts, but sshd hands commands to the
// user's login shell (which may be fish/csh). Every internal exec boundary must
// therefore cross through exactly one safely quoted `sh -c` invocation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WebAttach, TAIL_MARKER } from '../lib/web-attach.js'

const READY = (port = 43129, token = 'tok123', pid = 999) =>
  `__DSH_PID__=${pid}\n dsh web: http://127.0.0.1:${port}/?token=${token}\n${TAIL_MARKER}\n`

function assertShWrapped(command) {
  assert.equal(typeof command, 'string')
  assert.match(command, /^sh -c '/, 'the login shell only sees an explicit sh invocation')
  assert.ok(command.endsWith("'"), 'the outer POSIX quote is closed')
  assert.equal([...command.matchAll(/sh -c /g)].length, 1, 'exactly one wrapper, never double wrapping')
}

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

function fakePool(output, commands) {
  return {
    async connect() { return new EventEmitter() },
    async exec(cmd, opts) {
      commands.push({ cmd, opts })
      return { code: 0, stdout: typeof output === 'function' ? output(cmd) : output, stderr: '' }
    },
  }
}

test('open launch and close(stopRemote) both use the POSIX sh boundary', async () => {
  const commands = []
  const attach = new WebAttach({ net: fakeNet() })
  await attach.open({ pool: fakePool(READY(), commands), machineId: 'm-111' })
  assert.equal(commands.length, 1)
  assertShWrapped(commands[0].cmd)
  assert.ok(commands[0].cmd.includes('nohup'), 'the real launch script is inside the wrapper')

  const stop = []
  await attach.close({ stopRemote: true, exec: async (cmd) => { stop.push(cmd) } })
  assert.equal(stop.length, 1)
  assertShWrapped(stop[0])
  assert.ok(stop[0].includes('kill --'), 'the real stop script is inside the wrapper')
})

test('a timed-out open wraps both its launch and its cleanup stop', async () => {
  const commands = []
  const pool = fakePool('', [])
  const attach = new WebAttach({ net: { createServer: () => { throw new Error('listener must not be reached') } } })
  await assert.rejects(attach.open({
    pool, machineId: 'm-timeout', waitSeconds: 1,
    exec: async (cmd, opts) => {
      commands.push({ cmd, opts })
      const stdout = cmd.includes('nohup')
        ? '__DSH_PID__=4242\n__DSH_TAIL__\nstill booting'
        : ''
      return { code: 0, stdout, stderr: '' }
    },
  }), /did not report a startup token/)
  assert.equal(commands.length, 2, 'one launch plus the recorded-PID cleanup')
  commands.forEach(({ cmd }) => assertShWrapped(cmd))
  assert.ok(commands[1].cmd.includes('4242'), 'cleanup still targets the PID reported by the launch')
})

test('a live reconnect wraps log, process and listener probes', async () => {
  const attach = new WebAttach({})
  attach.remotePid = 999
  attach.logPath = '.log-reconnect'
  attach.remotePort = 43129
  attach.token = 'old'
  const commands = []
  const exec = async (cmd) => {
    commands.push(cmd)
    if (cmd.includes('if [ -d /proc ]')) return { code: 0, stdout: 'ALIVE\n' }
    if (cmd.includes('cat "$HOME/.log-reconnect"')) {
      return { code: 0, stdout: 'dsh web: http://127.0.0.1:43129/?token=reconnect\n' }
    }
    if (cmd.includes('ls -l /proc/999/fd')) return { code: 0, stdout: '1234 \n' }
    if (cmd.includes('cat /proc/net/tcp ')) {
      return {
        code: 0,
        stdout: '  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
          + '  0: 0100007F:A879 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 1234 1 0 100 0 0 10 0\n',
      }
    }
    assert.fail(`unexpected exec: ${cmd}`)
  }
  const match = await attach._resolveRemotePort(exec)
  assert.deepEqual(match, { port: 43129, token: 'reconnect', restarted: false })
  assert.equal(commands.length, 4, 'alive + log + fd-inode + /proc/net/tcp; tcp6 is unnecessary after a match')
  commands.forEach(assertShWrapped)
})

test('a dead process restart wraps the liveness probe and the relaunch', async () => {
  const attach = new WebAttach({})
  attach.remotePid = 999
  attach.logPath = '.log-restart'
  attach.command = 'dsh'
  attach.waitSeconds = 1
  const commands = []
  const exec = async (cmd) => {
    commands.push(cmd)
    if (cmd.includes('if [ -d /proc ]')) return { code: 0, stdout: 'GONE\n' }
    if (cmd.includes('nohup')) return { code: 0, stdout: READY(43210, 'restarted', 1000) }
    assert.fail(`unexpected exec: ${cmd}`)
  }
  const match = await attach._resolveRemotePort(exec)
  assert.deepEqual(match, { port: 43210, token: 'restarted', restarted: true })
  assert.equal(attach.remotePid, 1000)
  assert.equal(commands.length, 2)
  commands.forEach(assertShWrapped)
})
