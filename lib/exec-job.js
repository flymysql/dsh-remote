// dsh-remote — remote command execution: per-call timeout, real cancellation,
// and background jobs (issue #70).
//
// The transport (`SshPool.exec`) already supported `opts.timeoutMs` and
// `opts.signal` — #70 was pure wiring on top of it:
//
//   1. `rw_exec` had no per-call `timeoutMs`, so a 10-minute build meant editing
//      the machine-wide `commandTimeoutMs` config and editing it back.
//   2. `exec.signal` was never forwarded, so pressing "stop" left the tool
//      running until the full timeout elapsed (rw_search already forwarded it).
//   3. A timeout always SIGTERM'd the command. There was no way to hand a long
//      build to the background and collect it later, unlike the built-in shell.
//
// This module owns the pieces that are easy to get subtly wrong:
//   • the timeout clamp and the "effective value" reported in the message (the
//     old code printed the CONFIG value, which becomes a lie the moment a
//     per-call override exists);
//   • streaming taps, so a background job's output reaches its ring instead of
//     only the return value;
//   • the job lifecycle: register → wait → settle/remove, with cancellation
//     flowing through the SAME AbortSignal the transport honors, so a kill
//     actually stops the remote process rather than just abandoning the call.
//
// The core `jobs` service is optional. Without it (a minimal embedding, a test
// double) everything degrades to foreground-only execution — the tool still
// works, it just cannot be promoted.

/** Per-call timeout bounds, matching the built-in shell tool's shape. */
export const EXEC_TIMEOUT_MIN_MS = 1000
export const EXEC_TIMEOUT_MAX_MS = 600000

/**
 * Resolve the effective timeout for one `rw_exec` call.
 *
 * A supplied value is clamped into [MIN, MAX]; an absent/invalid one falls back
 * to the machine-wide `commandTimeoutMs` (itself clamped, so a bad config can
 * never produce a nonsensical deadline).
 *
 * @param {unknown} value - the call's `timeoutMs` argument.
 * @param {number} fallback - `config.commandTimeoutMs`.
 * @returns {number} milliseconds to actually apply.
 */
export function resolveExecTimeout(value, fallback) {
  const clamp = (n) => Math.min(Math.max(Math.round(n), EXEC_TIMEOUT_MIN_MS), EXEC_TIMEOUT_MAX_MS)
  const n = Number(value)
  if (Number.isFinite(n) && n > 0) return clamp(n)
  const f = Number(fallback)
  if (Number.isFinite(f) && f > 0) return clamp(f)
  return clamp(20000)
}

/**
 * Render a finished command into the tool's text form. Kept next to the timeout
 * resolution so the "timed out after Nms" line can NEVER disagree with the
 * deadline that was actually applied (issue #70 acceptance criterion 1).
 *
 * @param {{code: number|null, signal: string|null, stdout: string, stderr: string}} res
 * @param {{timeoutMs: number, cancelled?: boolean}} opts
 * @returns {string}
 */
export function formatExecResult(res, { timeoutMs, cancelled = false } = {}) {
  const parts = []
  if (res.stdout) parts.push(String(res.stdout).replace(/\s+$/, ''))
  if (res.stderr) parts.push('-- stderr --\n' + String(res.stderr).replace(/\s+$/, ''))
  if (!parts.length) parts.push('(no output)')
  let text = parts.join('\n')
  if (res.signal === 'TIMEOUT') text += `\n[command timed out after ${timeoutMs}ms]`
  else if (cancelled || res.signal === 'ABORTED') text += '\n[cancelled — the remote command was stopped]'
  else if (res.code !== 0) text += `\n[exit code: ${res.code}]`
  return text
}

/**
 * Register one remote command as a core background job.
 *
 * The producer owns execution: the command starts inside `run()` (so a
 * preflight rejection leaves no SSH channel behind), its output is pushed into
 * the job ring as it arrives, and `cancel` aborts the SAME AbortSignal the
 * transport turns into a SIGTERM on the remote process. That last point is what
 * makes `job_kill` real rather than cosmetic.
 *
 * Timeout ownership is subtle and got this wrong once: a JOB's deadline must
 * not be enforced by the transport, because the whole point of a background
 * job is to OUTLIVE the tool call that started it. Passing `timeoutMs` down
 * would make the transport SIGTERM the command at the very moment the caller
 * promotes it. So the transport gets a deadline only when this job is meant to
 * be bounded on its own (`jobDeadlineMs`); the foreground/promotion decision is
 * made by the CALLER's wait, not by the exec.
 *
 * @param {object} registry - the core `jobs` service (`ctx.jobs`).
 * @param {object} spec
 * @param {object} spec.pool - the machine's SshPool.
 * @param {string} spec.command - the full command line to run.
 * @param {string} [spec.label] - one-line model-facing label (defaults to command).
 * @param {any} [spec.owner] - owning session id, when the caller has one.
 * @param {number} [spec.jobDeadlineMs] - optional deadline enforced ON THE
 *   COMMAND itself (omitted ⇒ the job runs until it finishes or is killed).
 * @param {boolean} [spec.pty]
 * @param {object} [spec.env]
 * @returns {{id: string, cancel: Function}}
 */
export function startExecJob(registry, { pool, command, label, owner, jobDeadlineMs, pty, env }) {
  let abort = null
  let cancelled = null
  const id = registry.start({
    kind: 'rw-exec',
    label: String(label || command || 'rw_exec'),
    ...(owner ? { owner } : {}),
    run: (job) => {
      const ac = new AbortController()
      abort = ac
      const done = (async () => {
        let res
        try {
          res = await pool.exec(command, {
            // 0/undefined ⇒ no transport deadline: the job outlives the call.
            ...(jobDeadlineMs ? { timeoutMs: jobDeadlineMs } : {}),
            pty: !!pty,
            env,
            signal: ac.signal,
            // Stream into the ring: a background job's value is its output, and
            // the model reads it later through job_output, not from a return
            // value it already lost.
            onData: (channel, chunk) => {
              const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
              if (!text) return
              try { job.append(text, { channel }) } catch { /* settled: ring closed */ }
            },
          })
        } catch (err) {
          return { status: 'failed', detail: String((err && err.message) || err) }
        }
        if (res.signal === 'ABORTED' || cancelled) return { status: 'killed', detail: cancelled || 'cancelled' }
        if (res.signal === 'TIMEOUT') return { status: 'killed', detail: `timed out after ${jobDeadlineMs}ms` }
        const code = res.code
        return {
          status: code === 0 ? 'completed' : 'failed',
          detail: code === 0 ? 'exit code: 0' : `exit code: ${code}`,
        }
      })()
      return {
        done,
        // Synchronous, idempotent, and it reaches the remote process: the
        // transport turns this abort into `stream.signal('SIGTERM')`.
        cancel: (reason) => {
          if (cancelled === null) cancelled = String(reason || 'cancelled')
          try { ac.abort() } catch { /* already aborted */ }
        },
      }
    },
  })
  return {
    id,
    cancel: (reason) => {
      if (cancelled === null) cancelled = String(reason || 'cancelled')
      try { abort && abort.abort() } catch { /* not started yet */ }
    },
  }
}

/**
 * Run one remote command in the FOREGROUND, optionally promoting it to the
 * background when it outlives `timeoutMs`.
 *
 * Without a job registry this is a plain bounded exec. With one, the command is
 * registered first so the caller can be handed a live id the moment it stops
 * waiting — the built-in shell's "promote on timeout" contract.
 *
 * @returns {Promise<{promoted: boolean, jobId?: string, text: string}>}
 */
export async function execWithOptionalPromotion({
  registry, pool, command, label, owner, timeoutMs, pty, env, signal,
  formatResult,
}) {
  if (!registry) {
    // No registry: no promotion is possible, so the timeout is the transport's
    // job (bounded foreground execution, the pre-#70 behaviour).
    const res = await pool.exec(command, { timeoutMs, pty: !!pty, env, signal })
    return { promoted: false, text: formatResult(res, { timeoutMs }) }
  }
  // The transport gets NO deadline here on purpose: this command is registered
  // as a job from the start, and the ONLY thing `timeoutMs` bounds is how long
  // THIS CALL waits before handing it to the background. Giving the exec the
  // same deadline would SIGTERM the command at the moment of promotion — the
  // exact bug the issue #70 live E2E caught.
  const job = startExecJob(registry, { pool, command, label, owner, pty, env })
  let view
  try {
    view = await registry.wait(job.id, timeoutMs, owner, signal)
  } catch {
    // The WAIT was cancelled (the caller pressed stop), not necessarily the
    // job: stop the job too, or the remote command keeps running behind a dead
    // tool call.
    try { registry.kill(job.id, owner, 'tool call aborted') } catch { /* already settled */ }
    job.cancel('tool call aborted')
    try { registry.remove(job.id, owner) } catch { /* settlement pending */ }
    const aborted = { code: -1, signal: 'ABORTED', stdout: '', stderr: '' }
    return { promoted: false, text: formatResult(aborted, { timeoutMs, cancelled: true }) }
  }
  if (view && (view.status === 'running' || view.status === 'stopping')) {
    // Promotion: the command keeps running under the registry, the caller gets
    // an id it can drain with job_output and stop with job_kill.
    return {
      promoted: true,
      jobId: job.id,
      text: `[still running after ${timeoutMs}ms; moved to background job ${job.id}]\n`
        + `Read its output with job_output (job_id="${job.id}") and stop it with job_kill.`,
    }
  }
  // Settled inside the deadline: collect the ring (the registry's own cursor)
  // and drop the record — the model never saw the id, so it must not linger.
  let text = ''
  try {
    const read = registry.read(job.id, owner)
    text = (read.chunks || []).map((c) => c.text).join('')
    if (read.result) text = text ? text + '\n' + read.result : read.result
  } catch { /* fall through with an empty body */ }
  try { registry.remove(job.id, owner) } catch { /* settlement pending */ }
  const detail = (view && view.detail) || ''
  return { promoted: false, text: formatResult({ code: 0, signal: null, stdout: text, stderr: '' }, { timeoutMs }) + (detail ? `\n[${detail}]` : '') }
}
