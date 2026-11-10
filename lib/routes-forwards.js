// Port-forward routes: /forwards.
//
// Extracted from lib/index.js (issue #82: the god-file split). Handler bodies
// moved VERBATIM; the mechanism lives in ./forwards.js (ForwardManager), this
// file only adapts the HTTP surface to it. Dependencies that belong to the
// plugin entry (the manager instance, the registry store for the owning
// machine id) arrive as `deps`.
/**
 * @param {object} deps
 * @param {(res: object, status: number, body: object) => void} deps.sendJson
 * @param {(req: object) => Promise<string>} deps.readBody
 * @param {object} deps.forwards - the ForwardManager instance.
 * @param {object} deps.store - machine-registry store (`currentId` tags new definitions).
 * @returns {Array<object>} route descriptors for registerHttpTransports.
 */
export function createForwardRoutes({ sendJson, readBody, forwards, store }) {
  return [
    {
      kind: 'exact',
      path: '/dsh-remote/forwards',
      handler: async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, { forwards: forwards.list() })
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const action = String(body.action || '')
          if (action === 'define') {
            // Validate the port HERE, not at start time: `listen(0)` would silently
            // pick an ephemeral port and the user would be looking at a forward
            // that listens nowhere they asked for. The settings UI cannot produce
            // this, but the HTTP API (and therefore an agent) can.
            const listenPort = Number(body.listenPort)
            if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
              return sendJson(res, 400, { ok: false, error: 'listenPort 必须是 1–65535 的整数' })
            }
            const targetPort = Number(body.targetPort) || listenPort
            if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
              return sendJson(res, 400, { ok: false, error: 'targetPort 必须是 1–65535 的整数' })
            }
            const d = forwards.define({
              direction: body.direction === 'reverse' ? 'reverse' : 'local',
              listenPort,
              targetHost: body.targetHost || '127.0.0.1',
              targetPort,
              autoStart: !!body.autoStart,
              machineId: store.currentId,
            })
            return sendJson(res, 200, { ok: true, forward: d, forwards: forwards.list() })
          }
          if (action === 'start' || action === 'stop') {
            const d = forwards.list().find((f) => f.id === body.id)
            if (!d) return sendJson(res, 404, { ok: false, error: 'forward not found' })
            if (action === 'start') {
              const r = await forwards.start(d)
              if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error })
            } else {
              forwards.stop(d.id)
            }
            return sendJson(res, 200, { ok: true, forwards: forwards.list() })
          }
          if (action === 'remove') {
            forwards.remove(String(body.id || ''))
            return sendJson(res, 200, { ok: true, forwards: forwards.list() })
          }
          return sendJson(res, 400, { ok: false, error: 'unknown action' })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]
}
