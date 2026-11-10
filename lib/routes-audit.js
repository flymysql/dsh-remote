// Audit-log routes: /audit.
//
// Extracted from lib/index.js (issue #82: the god-file split). Handler bodies
// moved VERBATIM; the mechanism lives in ./audit.js, this file only adapts the
// HTTP surface to it. Dependencies that belong to the plugin entry (config,
// the audit-file locator, the JSON body helpers, the OS file opener) arrive
// as `deps`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * @param {object} deps
 * @param {(res: object, status: number, body: object) => void} deps.sendJson
 * @param {(req: object) => Promise<string>} deps.readBody
 * @param {object} deps.config - validated plugin Config.
 * @param {() => string} deps.auditFile - absolute path of the audit log file.
 * @param {(limit: string|null) => string[]} deps.readAudit - parsed tail of the log.
 * @param {(raw: string) => object} deps.parseJsonObject - 400-throwing object parser.
 * @param {(target: string, action?: 'open'|'reveal') => Promise<object>} deps.openLocalPath
 * @returns {Array<object>} route descriptors for registerHttpTransports.
 */
export function createAuditRoutes({ sendJson, readBody, config, auditFile, readAudit, parseJsonObject, openLocalPath }) {
  return [
    {
      kind: 'exact',
      path: '/dsh-remote/audit',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const q = new URL(req.url, 'http://localhost').searchParams
          return sendJson(res, 200, { ok: true, auditEnabled: !!config.auditLog, file: auditFile(), lines: readAudit(q.get('limit')) })
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // Open the audit FILE itself in the user's own viewer. The browser cannot do
        // this — the log lives on the machine running the DSH host — so the host
        // performs the open and reports what it did:
        //   action 'reveal' → highlight the file in the OS file manager
        //   action 'open'   → open it with the OS default application (a text editor)
        // A missing file is created first: "no log yet" would otherwise be
        // indistinguishable from a broken button.
        try {
          const body = parseJsonObject(await readBody(req))
          const action = String(body.action || 'open')
          if (action !== 'open' && action !== 'reveal') {
            return sendJson(res, 400, { ok: false, error: 'action must be open | reveal' })
          }
          const file = auditFile()
          mkdirSync(path.dirname(file), { recursive: true })
          if (!existsSync(file)) writeFileSync(file, '', 'utf8')
          const r = await openLocalPath(file, action)
          if (!r.ok) return sendJson(res, r.httpStatus || 500, { ok: false, error: r.error, file })
          return sendJson(res, 200, { ok: true, action, file, how: r.how })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]
}
