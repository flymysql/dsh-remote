/** Deterministic timers for sandboxed client code (lib/client.js).
 *
 *  Why this exists: the sandboxes used to receive the REAL setTimeout, so
 *  long-delay callbacks (2s update check, 5s status poll, 220ms picker
 *  debounce, 60s mirror refresh) fired only when the worker process happened
 *  to live long enough — under parallel load, sometimes yes, sometimes no.
 *  That made lib/client.js coverage wobble ±3% run-to-run, which forced the
 *  per-file floor to carry slack instead of hugging the measured value.
 *
 *  Semantics:
 *   · setTimeout(fn, 0)  → queueMicrotask: "after the current sync block",
 *     no wall-clock. This is what 0-delay timers actually mean in the bundle.
 *   · setTimeout(fn, ms>0) / setInterval → queued, NEVER self-fire; tests run
 *     them explicitly with flush(ms). Deterministic on every machine.
 *   · clearTimeout/clearInterval remove from the queue.
 *
 *  Attach the same instance to BOTH the bare sandbox global and
 *  window.setTimeout — the bundle uses both spellings, and before this module
 *  some sandboxes didn't even have window.setTimeout (latent crash path).
 */
export function fakeTimers() {
  let seq = 0
  const timers = new Map() // id → { fn, args, at, interval }

  const setTimeoutFn = (fn, ms = 0, ...args) => {
    if (typeof fn !== 'function') return 0
    if (!ms || ms <= 0) {
      queueMicrotask(() => fn(...args))
      return 0
    }
    const id = ++seq
    timers.set(id, { fn, args, at: ms, interval: 0 })
    return id
  }
  const setIntervalFn = (fn, ms = 0, ...args) => {
    if (typeof fn !== 'function') return 0
    const id = ++seq
    timers.set(id, { fn, args, at: ms, interval: ms || 1 })
    return id
  }
  const clear = (id) => { timers.delete(id) }

  /** Advance virtual time by `ms`; run due callbacks in schedule order.
   *  Intervals reschedule themselves. Returns how many callbacks ran. */
  const flush = (ms = Number.POSITIVE_INFINITY) => {
    let ran = 0
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > ms) continue
      if (t.interval) t.at += t.interval
      else timers.delete(id)
      t.fn(...t.args)
      ran++
    }
    return ran
  }

  return {
    setTimeout: setTimeoutFn,
    clearTimeout: clear,
    setInterval: setIntervalFn,
    clearInterval: clear,
    flush,
    pending: () => timers.size,
  }
}
