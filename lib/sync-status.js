// Observations of completed/in-flight sync operations, never a claim that every
// local/remote byte is equal. Unknown stays unknown until an actual operation.
export function createSyncActivity() {
  const entries = new Map()
  const read = (local) => {
    const value = entries.get(local)
    if (!value) return { phase: 'unknown' }
    const { token, ...publicValue } = value
    return publicValue
  }
  const run = async (local, operation, fn, dryRun = false) => {
    if (dryRun) return fn(() => {})
    const token = {}
    const current = () => entries.get(local)?.token === token
    let stats = {}
    entries.set(local, { token, phase: 'running', operation, updatedAt: new Date().toISOString() })
    try {
      const result = await fn((next) => { stats = next || {} })
      if (current()) {
        const conflicts = Array.isArray(stats.conflicts) ? stats.conflicts.map((c) => ({ path: c.path, reason: c.reason })) : []
        const partial = !!(stats.failed || stats.abortedError || stats.truncated || stats.skippedLarge)
        entries.set(local, { token, phase: conflicts.length ? 'conflicts' : partial ? 'partial' : 'completed', operation, updatedAt: new Date().toISOString(), files: stats.files || 0, conflicts, error: stats.abortedError || '' })
      }
      return result
    } catch (err) {
      if (current()) entries.set(local, { token, phase: 'failed', operation, updatedAt: new Date().toISOString(), error: String(err.message || err) })
      throw err
    }
  }
  return { read, run }
}
