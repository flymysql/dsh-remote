// Misc singleton routes: /telemetry, /term-secret, /workspace-mirrors,
// /workspace-cleanup — small surfaces grouped so no one-route file accretes.
//
// Extracted from lib/index.js (issue #82: the god-file split). Handler bodies
// moved VERBATIM; the mechanisms live in ./telemetry.js, ./workspace-cleanup.js
// and the entry's term-secret closures — this file only adapts the HTTP
// surface to them. Entry-owned state (machines, the secret payload writers,
// the late-assembled in-process API) arrives as `deps`.
//
// `heartbeatEnabled` for the GET /telemetry branch is imported above from
// ./telemetry.js: in the god-file it was an UNBOUND name (a latent
// ReferenceError on every GET, masked because no test drove a real GET). Fixed
// upstream as v0.8.89; this file's import converges with that repair — after
// the rebase onto main the new GET route test passes against the moved handler.
import { existsSync } from 'node:fs'
import { heartbeatEnabled, telemetryAllowed, persistTelemetryOpt } from './telemetry.js'

/**
 * @param {object} deps
 * @param {(res: object, status: number, body: object) => void} deps.sendJson
 * @param {(req: object) => Promise<string>} deps.readBody
 * @param {object} deps.config - validated plugin Config.
 * @param {() => string} deps.dshBase - $DSH_HOME of the RUNNING host.
 * @param {object} deps.ctx - the plugin context (term-secret republish reads webServer).
 * @param {() => string} deps.termSecretFile - path of the bearer payload file.
 * @param {(origin: string) => boolean} deps.writeTermSecretPayload
 * @param {(presented: string) => boolean} deps.termSecretOk - timing-safe token check.
 * @param {Array<object>} deps.machines - the LIVE registry array (shared reference).
 * @param {(m: object) => Promise<string|undefined>} deps.machinePassword - credential chain.
 * @param {() => object} deps.getHostApi - LATE-BOUND: the in-process API is
 *   assembled AFTER route registration, so handlers resolve it per request.
 * @returns {Array<object>} route descriptors for registerHttpTransports.
 */
export function createMiscRoutes({ sendJson, readBody, config, dshBase, ctx, termSecretFile, writeTermSecretPayload, termSecretOk, machines, machinePassword, getHostApi }) {
  return [
    {
      kind: 'exact',
      path: '/dsh-remote/telemetry',
      handler: async (req, res) => {
        // The anonymous-heartbeat toggle (settings page). GET reads the
        // EFFECTIVE value (user override > profile config > default true);
        // POST persists the user's choice under $DSH_HOME so it survives
        // plugin upgrades (the install dir gets overwritten).
        if (req.method === 'GET') {
          return sendJson(res, 200, { ok: true, enabled: telemetryAllowed(dshBase(), config.telemetry), configurable: heartbeatEnabled() })
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          if (typeof body.enabled !== 'boolean') return sendJson(res, 400, { ok: false, error: 'enabled must be boolean' })
          if (!persistTelemetryOpt(dshBase(), body.enabled)) return sendJson(res, 500, { ok: false, error: 'cannot persist the setting (read-only home?)' })
          return sendJson(res, 200, { ok: true, enabled: telemetryAllowed(dshBase(), config.telemetry) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/term-secret',
      // Owns its bearer token (per boot, 0600 file): the caller is a local
      // PROCESS (the askpass helper), not a browser, so the Connection cookie
      // fence would 401 it. The fallback fence still locks out cross-site pages
      // (they cannot read the token file).
      fence: 'bearer',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // Self-heal: a caller exists but the payload was never published (the
        // origin arrived after the first write attempts).
        if (!existsSync(termSecretFile())) {
          try {
            const ws = ctx.get('webServer')
            if (ws && typeof ws.getOrigin === 'function') writeTermSecretPayload(ws.getOrigin())
          } catch { /* still no listener: the 403 below answers honestly */ }
        }
        // Malformed bodies are a 400 with a reason even before the token check
        // (the routes matrix pins that readability contract for every POST).
        let body = {}
        try { body = JSON.parse((await readBody(req)) || '{}') } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }) }
        const presented = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '')
        if (!presented || !termSecretOk(presented)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
        const alias = String(body.alias || '')
        let m = null
        if (alias) m = machines.find((x) => x && x.useSshConfig && String(x.host) === alias) || null
        if (!m) {
          const host = String(body.host || '')
          const port = Number(body.port) || 22
          const user = String(body.username || '')
          m = machines.find((x) => x && !x.useSshConfig && String(x.host) === host && (Number(x.port) || 22) === port && String(x.username || '') === user) || null
        }
        if (!m) return sendJson(res, 404, { ok: false, error: 'unknown machine' })
        const password = await machinePassword(m)
        return sendJson(res, 200, { ok: true, password })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/workspace-mirrors',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // Late-bound: the in-process API is assembled after route registration.
        const hostApi = getHostApi()
        // The settings page's cleanup section: every local mirror with its
        // sessions, sizes and occupancy, straight off the in-process API (same
        // object the TUI consumes — one implementation, two faces).
        if (!hostApi) return sendJson(res, 503, { ok: false, error: 'in-process API unavailable' })
        try {
          return sendJson(res, 200, { ok: true, mirrors: await hostApi.listWorkspaceMirrors({}) })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/workspace-cleanup',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // Late-bound: the in-process API is assembled after route registration.
        const hostApi = getHostApi()
        if (!hostApi) return sendJson(res, 503, { ok: false, error: 'in-process API unavailable' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const localMirror = String(body.localMirror || '')
          const mode = String(body.mode || '')
          if (!localMirror) return sendJson(res, 400, { ok: false, error: 'localMirror is required' })
          let result
          if (mode === 'all') {
            result = await hostApi.deleteRemoteWorkspace({ localMirror, force: body.force === true })
          } else if (mode === 'sessions') {
            result = await hostApi.deleteWorkspaceSessions({ localMirror, force: body.force === true })
          } else if (mode === 'recent') {
            result = await hostApi.forgetWorkspaceRecent({ localMirror })
          } else {
            return sendJson(res, 400, { ok: false, error: 'mode must be all | sessions | recent' })
          }
          return sendJson(res, 200, { ok: true, ...result })
        } catch (err) {
          // Coded errors carry user-facing messages; WORKSPACE_BUSY must reach
          // the UI as 409 so the page can say WHICH sessions hold the workspace.
          const status = (err && err.code === 'WORKSPACE_BUSY') ? 409 : (err && err.code === 'VALIDATION') ? 400 : 500
          const out = { ok: false, error: String((err && err.message) || err) }
          if (err && err.code) out.code = err.code
          if (err && Array.isArray(err.liveSessions)) out.liveSessions = err.liveSessions
          return sendJson(res, status, out)
        }
      },
    },
  ]
}
