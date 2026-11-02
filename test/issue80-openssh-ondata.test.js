// Issue #80 — the system-OpenSSH backend silently dropped every byte of
// `rw_exec` output once #70 made "register as a job, read back from the ring"
// the default path. The ring's only input is the `pool.exec` onData tap, and
// that tap existed ONLY on the native ssh2 backend: openssh accumulated the
// output into a return value the job layer then discarded, so the model saw
// `(no output)` for commands that had printed plenty — and for promoted/
// background jobs the output was gone permanently.
//
// Pins, in increasing order of realism:
//   1. exec() forwards opts.onData to _runSsh on BOTH branches (direct and
//      the Git-Bash stdin pipe) — the seam where the option was dropped.
//   2. _runSsh really taps a child process's stdout/stderr as it arrives,
//      proven against the REAL `ssh` CLI talking to the in-process fake sshd
//      (test/harness/fake-ssh.js) so the assertion covers the spawn wiring,
//      not a stub. The loopback host key is kept OUT of the user's real
//      known_hosts through opts.knownHostsFile — the field the constructor
//      accepted but never applied (ssh ignores $HOME on some platforms, so
//      env redirection is not enough).
//   3. startExecJob's settle-time flush: a backend whose exec returns output
//      it never streamed must STILL leave that output in the ring (the exact
//      failure the issue reported), and a backend that DID stream must not
//      see its output duplicated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { SystemOpenSshPool, sshBinaryAvailable } from '../lib/openssh.js'
import { startExecJob, execWithOptionalPromotion, formatExecResult } from '../lib/exec-job.js'
import { startFakeSsh } from './harness/fake-ssh.js'

const baseConfig = (over = {}) => ({
  host: 'example.internal',
  port: 22,
  username: 'root',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  workspace: '',
  useAgent: false,
  keyboardInteractive: false,
  hostKeyMode: 'accept-new',
  connectTimeoutMs: 15000,
  commandTimeoutMs: 20000,
  maxOutputChars: 200000,
  backend: 'openssh',
  ...over,
})

// ── 1. the option must survive exec() → _runSsh ─────────────────────────────

test('#80: exec() forwards onData to _runSsh (posix branch)', async () => {
  const pool = new SystemOpenSshPool(baseConfig())
  pool.platform = 'posix'
  const seen = []
  pool._runSsh = async (args, opts) => { seen.push(opts); return { code: 0, stdout: '', stderr: '' } }
  const tap = () => {}
  await pool.exec('echo hi', { onData: tap })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].onData, tap, 'the streaming tap must reach _runSsh, or the job ring stays empty')
})

test('#80: exec() forwards onData on the Git-Bash stdin branch too', async () => {
  const pool = new SystemOpenSshPool(baseConfig())
  pool.platform = 'windows'
  pool.gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const seen = []
  pool._runSsh = async (args, opts) => { seen.push(opts); return { code: 0, stdout: '', stderr: '' } }
  const tap = () => {}
  await pool.exec('echo hi', { onData: tap })
  assert.equal(seen[0].onData, tap, 'the wrapper branch must not drop the tap either')
  assert.equal(seen[0].stdin, 'echo hi', 'the script still travels on stdin')
})

// ── 2. real ssh CLI → in-process fake sshd: the tap fires on live data ──────

test('#80: the REAL ssh binary streams stdout/stderr through onData', {
  skip: sshBinaryAvailable('ssh') ? false : 'no `ssh` on PATH — the openssh backend cannot run here',
}, async (t) => {
  const srv = await startFakeSsh({
    users: {}, // none-auth: no credentials needed, nothing to leak
    silent: true,
    onExec: (cmd) => ({ stdout: `OUT:${cmd}\n`, stderr: 'ERR:warn\n', code: 0 }),
  })
  // Keep the loopback host key out of the developer's real known_hosts.
  const khDir = mkdtempSync(path.join(tmpdir(), 'dsh-issue80-'))
  const knownHostsFile = path.join(khDir, 'known_hosts')
  const pool = new SystemOpenSshPool(
    baseConfig({ host: '127.0.0.1', port: srv.port, hostKeyMode: 'off', connectTimeoutMs: 10000, commandTimeoutMs: 10000 }),
    { knownHostsFile },
  )
  t.after(async () => { pool.close(); await srv.close() })
  pool.platform = 'posix' // skip detect(); this test is about the data path

  let resolved = false
  const taps = []
  const res = await pool.exec('echo hello', {
    onData: (channel, chunk) => {
      assert.equal(resolved, false, 'the tap must fire BEFORE the result resolves (live, not at settle)')
      taps.push([channel, String(chunk)])
    },
  })
  resolved = true

  assert.equal(res.code, 0)
  assert.match(String(res.stdout), /OUT:echo hello/, 'the return value keeps working (direct callers use it)')
  const outTap = taps.find(([ch, text]) => ch === 'stdout' && text.includes('OUT:echo hello'))
  const errTap = taps.find(([ch, text]) => ch === 'stderr' && text.includes('ERR:warn'))
  assert.ok(outTap, `stdout must reach the tap, got ${JSON.stringify(taps)}`)
  assert.ok(errTap, `stderr must reach the tap, got ${JSON.stringify(taps)}`)

  // The host key went to the throwaway file, not the developer's real one.
  const kh = readFileSync(knownHostsFile, 'utf8')
  assert.match(kh, /\[127\.0\.0\.1\]:\d+ ssh-ed25519/, 'the loopback key must land in the redirected known_hosts')
})

test('#80: opts.knownHostsFile accepts a function, resolved per use (native parity)', async () => {
  const { baseSshArgs } = await import('../lib/openssh.js')
  const pool = new SystemOpenSshPool(baseConfig(), { knownHostsFile: () => '/tmp/kh-from-fn' })
  const args = baseSshArgs(pool._argConfig())
  assert.ok(args.join(' ').includes('UserKnownHostsFile=/tmp/kh-from-fn'), 'a function value must resolve per call')
  const plain = new SystemOpenSshPool(baseConfig())
  assert.ok(!baseSshArgs(plain._argConfig()).join(' ').includes('UserKnownHostsFile'),
    'no override ⇒ no flag: default behaviour must not change for anybody')
})

// ── 3. the job ring must heal a backend that never streamed ─────────────────

// A fake jobs registry mirroring the core contract (same shape as #70's).
function fakeRegistry() {
  const jobs = new Map()
  let n = 0
  return {
    start(spec) {
      const id = `${spec.kind}-${++n}`
      const chunks = []
      const job = { id, append(text, opts = {}) { chunks.push({ text, channel: opts.channel }) }, updateProgress() {} }
      const hooks = spec.run(job)
      jobs.set(id, { spec, chunks, hooks, settled: null })
      hooks.done.then((outcome) => { jobs.get(id).settled = outcome }).catch(() => {})
      return id
    },
    async wait(id, timeoutMs) {
      const rec = jobs.get(id)
      if (!rec) throw new Error('unknown job ' + id)
      const deadline = new Promise((r) => setTimeout(() => r(null), Math.min(timeoutMs, 50)))
      const settled = await Promise.race([rec.settled ? Promise.resolve(rec.settled) : rec.hooks.done, deadline])
      if (!settled) return { id, status: 'running' }
      return { id, status: settled.status, detail: settled.detail }
    },
    read(id) {
      const rec = jobs.get(id)
      if (!rec) throw new Error('unknown job ' + id)
      return { chunks: rec.chunks, result: undefined }
    },
    kill(id, _caller, reason) { jobs.get(id).hooks.cancel(reason); return 'requested' },
    remove(id) { jobs.delete(id) },
    _rec: (id) => jobs.get(id),
  }
}

test('#80: a backend that never calls onData still leaves its output in the ring', async () => {
  const registry = fakeRegistry()
  // Exactly what openssh did before this fix: output only in the return value.
  const silentPool = { exec: async (_cmd, opts) => {
    assert.equal(typeof opts.onData, 'function', 'the tap is still offered; this backend just never fires it')
    return { code: 0, signal: null, stdout: 'hello\n', stderr: 'warn\n' }
  } }
  const job = startExecJob(registry, { pool: silentPool, command: 'echo hello' })
  await new Promise((r) => setTimeout(r, 20))
  const rec = registry._rec(job.id)
  assert.equal(rec.settled.status, 'completed')
  assert.deepEqual(rec.chunks.map((c) => c.text), ['hello\n', 'warn\n'],
    'the settle-time flush must land the returned output in the ring')
  assert.deepEqual(rec.chunks.map((c) => c.channel), ['stdout', 'stderr'])
})

test('#80: a backend that streamed does NOT get its output duplicated at settle', async () => {
  const registry = fakeRegistry()
  const streamingPool = { exec: async (_cmd, opts) => {
    opts.onData('stdout', Buffer.from('line-1\n'))
    opts.onData('stderr', Buffer.from('warn\n'))
    return { code: 0, signal: null, stdout: 'line-1\n', stderr: 'warn\n' }
  } }
  const job = startExecJob(registry, { pool: streamingPool, command: 'echo line-1' })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(registry._rec(job.id).chunks.map((c) => c.text), ['line-1\n', 'warn\n'],
    'streamed output must appear exactly once')
})

test('#80: a command with genuinely no output keeps the empty ring (no phantom chunks)', async () => {
  const registry = fakeRegistry()
  const quietPool = { exec: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }) }
  const job = startExecJob(registry, { pool: quietPool, command: 'true' })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(registry._rec(job.id).chunks, [])
})

// ── the user-facing symptom: foreground rw_exec output on a silent backend ──

test('#80: foreground rw_exec shows the output instead of "(no output)" (the reported bug)', async () => {
  const registry = fakeRegistry()
  const silentPool = { exec: async () => ({ code: 0, signal: null, stdout: 'hello\n', stderr: '' }) }
  const r = await execWithOptionalPromotion({
    registry, pool: silentPool, command: 'echo hello', timeoutMs: 5000, formatResult: formatExecResult,
  })
  assert.equal(r.promoted, false)
  assert.match(r.text, /hello/, 'the ring read-back must contain what the command printed')
  assert.doesNotMatch(r.text, /\(no output\)/, 'the exact lie the issue reported')
})
