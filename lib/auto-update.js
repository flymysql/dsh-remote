// Automatic-update orchestration. Package replacement and loader reload remain
// in update.js; this owner controls mode changes, overlap and retry timing.
export function createAutoUpdater({ mode, isInstalled, probe, apply, diskVersion, loadedVersion, gtVersion, reload, autoReload = () => true, intervalMs, now = Date.now, setTimer = setInterval, clearTimer = clearInterval }) {
  const interval = Math.max(Number(intervalMs) || 1800000, 60000)
  let stopped = false, timer = null, running = null, generation = 0, failures = 0, nextCheckAt = 0
  let state = { phase: 'idle', checkedAt: null, error: '', latest: null }
  const active = () => !stopped && mode() === 'auto' && isInstalled()
  const snapshot = () => ({ ...state, mode: mode(), intervalMs: interval, nextCheckAt: nextCheckAt || null })
  const check = ({ force = false } = {}) => {
    if (running) return running
    if (!active()) { state = { ...state, phase: isInstalled() ? 'paused' : 'unsupported' }; return Promise.resolve(snapshot()) }
    if (!force && now() < nextCheckAt) return Promise.resolve(snapshot())
    const ticket = generation
    const current = () => active() && ticket === generation
    const job = Promise.resolve().then(async () => {
      if (!current()) return
      state = { ...state, phase: 'checking', checkedAt: now(), error: '' }
      nextCheckAt = now() + interval
      try {
        // A package installed by the CLI can already be on disk. It still
        // needs a loader swap, even when npm has no version newer than disk.
        if (gtVersion(diskVersion(), loadedVersion)) {
          if (autoReload()) { reload(); state = { ...state, phase: 'reloading' } }
          else state = { ...state, phase: 'restart-required' }
          return
        }
        const result = await probe()
        if (!current()) return
        if (result.error) throw new Error(result.error)
        state = { ...state, latest: result.version }
        if (!gtVersion(result.version, diskVersion()) && !gtVersion(result.version, loadedVersion)) {
          failures = 0
          state = { ...state, phase: 'current' }; return
        }
        state = { ...state, phase: 'downloading' }
        await apply(result.version)
        if (!current()) return
        failures = 0
        if (autoReload()) { reload(); state = { ...state, phase: 'reloading' } }
        else state = { ...state, phase: 'restart-required' }
      } catch (error) {
        if (!current()) return
        failures++
        nextCheckAt = now() + Math.min(60000 * 2 ** Math.min(failures - 1, 5), 1800000)
        state = { ...state, phase: 'error', error: String(error.message || error) }
      }
    }).finally(() => { if (running === job) running = null })
    running = job
    return job.then(snapshot)
  }
  return {
    snapshot,
    check,
    start() {
      if (timer != null || stopped || !isInstalled()) return check()
      // Cheap minute ticks allow bounded retry backoff without turning the
      // configured successful-check interval into repeated network traffic.
      timer = setTimer(() => { void check() }, Math.min(interval, 60000))
      timer?.unref?.()
      return check()
    },
    modeChanged() {
      generation++; failures = 0; nextCheckAt = 0
      if (mode() !== 'auto') { state = { ...state, phase: 'paused' }; return Promise.resolve(snapshot()) }
      const previous = running
      return previous ? previous.then(() => check({ force: true })) : check({ force: true })
    },
    stop() { stopped = true; generation++; if (timer != null) clearTimer(timer); timer = null },
  }
}
