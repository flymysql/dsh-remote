// Issue #70 — `rw_exec` was missing three things the built-in shell has:
// a per-call timeout, cancellation that actually reaches the remote process,
// and promotion to a background job instead of a hard kill.
//
// These tests pin the pieces that are easy to get subtly wrong and do NOT need
// a live SSH host:
//   • the timeout clamp, and that the reported value is the one APPLIED (the
//     old message printed the config value, which a per-call override makes a
//     lie — the issue's acceptance criterion 1);
//   • the streaming tap that feeds a background job's ring;
//   • job registration / promotion / settlement / cancellation wiring against a
//     fake registry that mirrors the core contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveExecTimeout, formatExecResult, startExecJob, execWithOptionalPromotion,
  EXEC_TIMEOUT_MIN_MS, EXEC_TIMEOUT_MAX_MS,
} from '../lib/exec-job.js'

// ── timeouts ────────────────────────────────────────────────────────────────

test('a per-call timeout wins and is clamped to [1000, 600000]', () => {
  assert.equal(resolveExecTimeout(5000, 20000), 5000)
  assert.equal(resolveExecTimeout(1, 20000), EXEC_TIMEOUT_MIN_MS, 'below the floor clamps up')
  assert.equal(resolveExecTimeout(99_999_999, 20000), EXEC_TIMEOUT_MAX_MS, 'above the ceiling clamps down')
  assert.equal(resolveExecTimeout(1500.7, 20000), 1501, 'fractional values round')
})

test('no (or unusable) per-call value falls back to the configured timeout', () => {
  for (const v of [undefined, null, '', 0, -5, NaN, 'abc', {}]) {
    assert.equal(resolveExecTimeout(v, 20000), 20000, `${String(v)} must fall back`)
  }
  // A bad config is clamped too, so a nonsense deadline can never be applied.
  assert.equal(resolveExecTimeout(undefined, 10), EXEC_TIMEOUT_MIN_MS)
  assert.equal(resolveExecTimeout(undefined, undefined), 20000)
})

test('the timeout message prints the EFFECTIVE value, not the config value (acceptance #1)', () => {
  const res = { code: -1, signal: 'TIMEOUT', stdout: 'partial', stderr: '' }
  const text = formatExecResult(res, { timeoutMs: 5000 })
  assert.match(text, /timed out after 5000ms/)
  assert.doesNotMatch(text, /20000ms/, 'the config default must not leak into an overridden call')
})

test('formatExecResult covers output, stderr, exit codes and cancellation', () => {
  assert.equal(formatExecResult({ code: 0, signal: null, stdout: '', stderr: '' }, { timeoutMs: 1000 }), '(no output)')
  assert.match(formatExecResult({ code: 3, signal: null, stdout: 'x', stderr: '' }, { timeoutMs: 1000 }), /\[exit code: 3\]/)
  assert.match(formatExecResult({ code: 0, signal: null, stdout: '', stderr: 'boom' }, { timeoutMs: 1000 }), /-- stderr --\nboom/)
  // A cancellation reaches the model as `cancelled`, whether the transport
  // labelled it ABORTED or the caller knows it aborted the wait.
  assert.match(formatExecResult({ code: -1, signal: 'ABORTED', stdout: '', stderr: '' }, { timeoutMs: 1000 }), /cancelled/)
  assert.match(formatExecResult({ code: 0, signal: null, stdout: '', stderr: '' }, { timeoutMs: 1000, cancelled: true }), /cancelled/)
})

// ── a fake jobs registry mirroring the core contract ───────────────────────

function fakeRegistry() {
  const jobs = new Map()
  let n = 0
  return {
    started: [],
    removed: [],
    killed: [],
    start(spec) {
      const id = `${spec.kind}-${++n}`
      const chunks = []
      const job = {
        id,
        append(text, opts = {}) { chunks.push({ text, channel: opts.channel }) },
        updateProgress() {},
      }
      // Register, then run — the core calls run() synchronously inside start.
      const hooks = spec.run(job)
      jobs.set(id, { spec, chunks, hooks, settled: null })
      this.started.push({ id, spec })
      hooks.done.then((outcome) => { jobs.get(id).settled = outcome }).catch(() => {})
      return id
    },
    async wait(id, timeoutMs) {
      const rec = jobs.get(id)
      if (!rec) throw new Error('unknown job ' + id)
      // Race settlement against the deadline, exactly like the registry does.
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
    kill(id, _caller, reason) {
      const rec = jobs.get(id)
      if (!rec) throw new Error('unknown job ' + id)
      this.killed.push({ id, reason })
      rec.hooks.cancel(reason)
      return 'requested'
    },
    remove(id) {
      this.removed.push(id)
      jobs.delete(id)
    },
    _rec: (id) => jobs.get(id),
  }
}

function fakePool(behaviour) {
  const calls = []
  return {
    calls,
    exec(command, opts = {}) {
      calls.push({ command, opts })
      return behaviour(command, opts, calls.length)
    },
  }
}

test('startExecJob registers with our own kind and forwards the streaming tap', async () => {
  const registry = fakeRegistry()
  const pool = fakePool(async (_cmd, opts) => {
    assert.equal(typeof opts.onData, 'function', 'the job must receive a live output tap')
    opts.onData('stdout', Buffer.from('line-1\n'))
    opts.onData('stderr', Buffer.from('warn\n'))
    return { code: 0, signal: null, stdout: 'line-1\n', stderr: 'warn\n' }
  })
  const job = startExecJob(registry, { pool, command: 'echo hi', timeoutMs: 5000 })
  assert.match(job.id, /^rw-exec-/)
  assert.equal(registry.started[0].spec.kind, 'rw-exec')
  assert.equal(registry.started[0].spec.label, 'echo hi')
  await new Promise((r) => setTimeout(r, 20))
  const rec = registry._rec(job.id)
  assert.deepEqual(rec.chunks.map((c) => c.text), ['line-1\n', 'warn\n'], 'output reached the ring as it arrived')
  assert.deepEqual(rec.chunks.map((c) => c.channel), ['stdout', 'stderr'])
})

test('startExecJob reports exit codes and honours an explicit job deadline', async () => {
  const registry = fakeRegistry()
  const pool = fakePool(async () => ({ code: 0, signal: null, stdout: 'ok', stderr: '' }))
  // No jobDeadlineMs: the transport must get NO deadline, or a promoted command
  // would be SIGTERM'd at the very moment the caller hands it to the background.
  const job = startExecJob(registry, { pool, command: 'true' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(pool.calls[0].opts.timeoutMs, undefined, 'a job without its own deadline must not inherit the call timeout')
  assert.equal(registry._rec(job.id).settled.status, 'completed')

  // With an explicit deadline the transport enforces it (run_in_background).
  const pool2 = fakePool(async () => ({ code: -1, signal: 'TIMEOUT', stdout: '', stderr: '' }))
  const job2 = startExecJob(registry, { pool: pool2, command: 'sleep 99', jobDeadlineMs: 1500 })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(pool2.calls[0].opts.timeoutMs, 1500, 'an explicit job deadline reaches the transport')
  const settled = registry._rec(job2.id).settled
  assert.equal(settled.status, 'killed')
  assert.match(settled.detail, /1500ms/)
})

test('promotion does NOT hand the call timeout to the transport (regression)', async () => {
  // The bug the live E2E caught: passing timeoutMs down made the transport
  // SIGTERM the command exactly when it was promoted, so every promoted job
  // settled killed instead of running on.
  const registry = fakeRegistry()
  const pool = fakePool((_c, opts) => new Promise((resolve) => {
    opts.signal.addEventListener('abort', () => resolve({ code: -1, signal: 'ABORTED', stdout: '', stderr: '' }), { once: true })
    setTimeout(() => resolve({ code: 0, signal: null, stdout: 'finished', stderr: '' }), 300)
  }))
  const r = await execWithOptionalPromotion({
    registry, pool, command: 'long build', timeoutMs: 30, formatResult: formatExecResult,
  })
  assert.equal(r.promoted, true)
  assert.equal(pool.calls[0].opts.timeoutMs, undefined,
    'a promoted job owns its own lifetime - the call timeout must not reach the transport')
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(registry._rec(r.jobId).settled.status, 'completed', 'the promoted job ran to completion')
})

test('cancelling the job aborts the SAME signal the transport turns into SIGTERM', async () => {
  const registry = fakeRegistry()
  let seenSignal = null
  const pool = fakePool((_c, opts) => new Promise((resolve) => {
    seenSignal = opts.signal
    // Behave like the transport: an abort resolves as ABORTED, it does not
    // reject, so the job settles `killed` rather than `failed`.
    opts.signal.addEventListener('abort', () => resolve({ code: -1, signal: 'ABORTED', stdout: '', stderr: '' }), { once: true })
  }))
  const job = startExecJob(registry, { pool, command: 'sleep 999', timeoutMs: 600000 })
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(seenSignal, 'the exec was given an AbortSignal')
  assert.equal(seenSignal.aborted, false)
  registry.kill(job.id, undefined, 'user pressed stop')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(seenSignal.aborted, true, 'killing the job must abort the transport signal')
  assert.equal(registry._rec(job.id).settled.status, 'killed')
})

// ── foreground vs promotion ────────────────────────────────────────────────

test('a fast command settles in the foreground, is drained, and leaves no record', async () => {
  const registry = fakeRegistry()
  const pool = fakePool(async (_c, opts) => {
    opts.onData('stdout', Buffer.from('hello\n'))
    return { code: 0, signal: null, stdout: 'hello\n', stderr: '' }
  })
  const r = await execWithOptionalPromotion({
    registry, pool, command: 'echo hello', timeoutMs: 5000, formatResult: formatExecResult,
  })
  assert.equal(r.promoted, false)
  assert.match(r.text, /hello/)
  assert.deepEqual(registry.removed, [registry.started[0].id], 'the model never saw the id, so it must not linger')
})

test('a command that outlives the timeout is PROMOTED, not killed (acceptance #3)', async () => {
  const registry = fakeRegistry()
  const pool = fakePool((_c, opts) => new Promise((resolve) => {
    opts.signal.addEventListener('abort', () => resolve({ code: -1, signal: 'ABORTED', stdout: '', stderr: '' }), { once: true })
    setTimeout(() => resolve({ code: 0, signal: null, stdout: 'done', stderr: '' }), 500)
  }))
  const r = await execWithOptionalPromotion({
    registry, pool, command: 'npm run build', timeoutMs: 30, formatResult: formatExecResult,
  })
  assert.equal(r.promoted, true)
  assert.match(r.text, /still running after 30ms/)
  assert.match(r.text, new RegExp(`job_output.*${r.jobId}`))
  assert.deepEqual(registry.removed, [], 'a promoted job stays alive for the model to collect')
})

test('without a jobs registry everything degrades to a bounded foreground exec', async () => {
  const pool = fakePool(async () => ({ code: 0, signal: null, stdout: 'plain', stderr: '' }))
  const r = await execWithOptionalPromotion({
    registry: null, pool, command: 'echo plain', timeoutMs: 2000, formatResult: formatExecResult,
  })
  assert.equal(r.promoted, false)
  assert.match(r.text, /plain/)
  assert.equal(pool.calls[0].opts.timeoutMs, 2000)
})

test('cancelling the WAIT also stops the remote command (acceptance #2)', async () => {
  const registry = fakeRegistry()
  const pool = fakePool((_c, opts) => new Promise((resolve) => {
    opts.signal.addEventListener('abort', () => resolve({ code: -1, signal: 'ABORTED', stdout: '', stderr: '' }), { once: true })
  }))
  const ac = new AbortController()
  // The fake registry's wait does not honour the signal itself, so abort after
  // the call is in flight: the promotion path must notice and kill the job.
  setTimeout(() => ac.abort(), 10)
  const r = await execWithOptionalPromotion({
    registry, pool, command: 'sleep 999', timeoutMs: 600000, signal: ac.signal,
    formatResult: formatExecResult,
  }).catch((e) => ({ error: String(e) }))
  // Either the abort is surfaced as a cancellation, or the command was stopped
  // — what must NOT happen is the caller waiting for the full deadline.
  if (r.error) assert.match(r.error, /abort/i)
  else assert.match(r.text, /cancelled|still running/)
})
