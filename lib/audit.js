// dsh-remote — audit log domain: the pure parts (formatting + reading).
//
// Extracted from lib/index.js (issue #82): the god-file keeps only the thin
// wiring (config gate + file path); everything testable without a mounted
// plugin lives here. Behaviour is byte-identical to the inlined version —
// `audit-open-and-no-deploy.test.js` pins it end to end.

/**
 * Build one audit line (without the trailing newline handling of the caller).
 * `cmd` is flattened to a single line and capped at 400 chars.
 *
 * @param {object} p
 * @param {string} p.op - operation name.
 * @param {string} p.cmd - command text or path detail.
 * @param {number|null} p.code - exit code, or null when not applicable.
 * @param {string} [p.user]
 * @param {string} [p.host]
 * @param {number} [p.port]
 * @param {Date} [p.now] - clock injection for tests.
 * @returns {string} the line INCLUDING the trailing newline.
 */
export function formatAuditLine({ op, cmd, code, user, host, port, now }) {
  const iso = (now || new Date()).toISOString()
  const flat = String(cmd || '').replace(/\s+/g, ' ').slice(0, 400)
  return [iso, `${user || '?'}@${host || '?'}:${port}`, op, code == null ? '-' : String(code), flat].join(' | ') + '\n'
}

/**
 * Read the last `limit` audit lines from a file (clamped to [1, 500]).
 * A missing/corrupt file degrades to [] — the audit viewer must never throw.
 *
 * @param {(file: string, enc: string) => string} readFile - fs.readFileSync-compatible.
 * @param {string} file
 * @param {number|string} [limit]
 * @returns {string[]}
 */
export function readAuditLines(readFile, file, limit) {
  try {
    const text = readFile(file, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    return lines.slice(-Math.max(1, Math.min(Number(limit) || 50, 500)))
  } catch {
    return []
  }
}
