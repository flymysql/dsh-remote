// Remote-Web-UI attach routes: /web-attach.
//
// Extracted from lib/index.js (issue #82: the god-file split). Handler bodies
// moved VERBATIM; the mechanism lives in ./web-attach.js (WebAttach), this
// file only adapts the HTTP surface to it. The state it drives belongs to the
// plugin entry and arrives as `deps`: the live-attach map, the machine
// registry array, the per-identity pool resolver, and the audit sink.
import { WebAttach } from './web-attach.js'

/**
 * @param {object} deps
 * @param {(res: object, status: number, body: object) => void} deps.sendJson
 * @param {(req: object) => Promise<string>} deps.readBody
 * @param {(raw: string) => object} deps.parseJsonObject - 400-throwing object parser.
 * @param {object} deps.config - validated plugin Config.
 * @param {Map<string, WebAttach>} deps.webAttaches - machineId → live attach session.
 * @param {object} deps.store - machine-registry store (`currentId` default target).
 * @param {Array<object>} deps.machines - the LIVE registry array (shared reference).
 * @param {(target: object) => object} deps.poolForMachine - per-identity pool resolver.
 * @param {(m: object) => {host: string, port: number, username: string}} deps.identityOf
 * @param {(machine: object) => string} deps.webAttachCommandFor - remote launch command.
 * @param {(op: string, cmd: string, code: number, target?: object) => void} deps.audit
 * @returns {Array<object>} route descriptors for registerHttpTransports.
 */
export function createWebAttachRoutes({ sendJson, readBody, parseJsonObject, config, webAttaches, store, machines, poolForMachine, identityOf, webAttachCommandFor, audit }) {
  return [
    {
      kind: 'exact',
      path: '/dsh-remote/web-attach',
      // Issue #46: open/reuse/close a tunnel to a remote machine's DSH Web UI.
      // Actions: status (GET) | open | close. `open` either starts a remote
      // `dsh web` (default) or attaches to one the user already runs by passing
      // its `http://127.0.0.1:<port>/?token=…` URL.
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const q = new URL(req.url, 'http://localhost').searchParams
            const id = q.get('machineId') || ''
            const attach = id ? webAttaches.get(id) : undefined
            return sendJson(res, 200, {
              ok: true,
              attach: attach ? attach.describe() : null,
              attaches: [...webAttaches.values()].map((a) => a.describe()),
            })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          const body = parseJsonObject(await readBody(req))
          const action = String(body.action || '')
          const machineId = String(body.machineId || store.currentId || '').trim()
          if (!machineId) return sendJson(res, 400, { ok: false, error: '选择一台机器后再操作（missing machineId）' })

          if (action === 'open') {
            // Reuse a live tunnel for this machine: re-opening would start a
            // second remote DSH and leak the first one's process.
            const live = webAttaches.get(machineId)
            if (live && live.active) return sendJson(res, 200, { ok: true, attach: live.describe(), reused: true })
            // A tunnel that is no longer listening still owns sockets and a log
            // path; release it before this machine gets a fresh session. Its
            // remote process is left alone — stopping it stays an explicit act.
            if (live) { try { await live.close() } catch { /* already torn down */ } }
            const machine = machines.find((m) => m.id === machineId)
            if (!machine) return sendJson(res, 404, { ok: false, error: `机器不存在：${machineId}` })
            const attachPool = poolForMachine(identityOf(machine))
            const attach = new WebAttach({
              localPortStart: config.webAttachPortStart,
              // Issue #54: follow the chosen pool's lifecycle so a dropped SSH
              // connection degrades to "disconnected" and then self-heals,
              // instead of leaving a dead client that crashes the host process.
              trackPool: true,
            })
            try {
              await attach.open({
                pool: attachPool,
                machineId,
                command: String(body.command || '').trim() || webAttachCommandFor(machine),
                profile: 'web',
                existingUrl: String(body.existingUrl || ''),
                dshHome: config.webAttachDshHome || '',
                waitSeconds: config.webAttachWaitSeconds,
              })
            } catch (err) {
              try { await attach.close() } catch { /* nothing was listening */ }
              const msg = String((err && err.message) || err)
              audit('web-attach', `open ${machine.host} failed: ${msg}`, 1, machine)
              return sendJson(res, 500, { ok: false, error: msg })
            }
            webAttaches.set(machineId, attach)
            audit('web-attach', `open ${machine.host} → 127.0.0.1:${attach.localPort}`, 0, machine)
            return sendJson(res, 200, { ok: true, attach: attach.describe() })
          }

          if (action === 'close') {
            const attach = webAttaches.get(machineId)
            if (!attach) return sendJson(res, 200, { ok: true, closed: false, error: '该机器没有活动的远程界面' })
            const stopRemote = body.stopRemote === true
            // `close()` refuses to signal anything without a recorded PID, so a
            // tunnel onto the user's own running instance stays hands-off.
            const exec = (cmd) => poolForMachine(identityOf(machines.find((m) => m.id === machineId) || {})).exec(cmd, { timeoutMs: 10000 })
            await attach.close({ stopRemote, exec })
            webAttaches.delete(machineId)
            audit('web-attach', `close ${attach.cleanUrl}${stopRemote ? ' (remote stopped)' : ''}`, 0)
            return sendJson(res, 200, { ok: true, closed: true, stoppedRemote: stopRemote && !!attach.remotePid })
          }

          return sendJson(res, 400, { ok: false, error: 'action must be open | close' })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]
}
