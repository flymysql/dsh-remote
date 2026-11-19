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
export function createForwardRoutes({ sendJson, readBody, forwards, store, activeMachineId }) {
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
            // Which host the tunnel belongs to. The settings form names it
            // explicitly (`machineId`): a forward can be DEFINED for a host that
            // is not connected right now — it simply cannot start until that host
            // is. Omitting the field keeps the historical behaviour: tag what the
            // ACTIVE POOL is actually on (ephemeral included), not the registry's
            // currentId, because rw_connect(save:false) keeps currentId on the old
            // machine while the pool talks to the new one.
            //
            // An explicit id must be a real registry record: persisting a typo
            // would create a forward that no machine can ever start and that no
            // UI row can explain.
            let machineId = typeof activeMachineId === 'function' ? activeMachineId() : store.currentId
            if (Object.prototype.hasOwnProperty.call(body, 'machineId') && body.machineId !== null && body.machineId !== '') {
              const wanted = String(body.machineId)
              const known = Array.isArray(store.list) && store.list.some((m) => m && m.id === wanted)
              if (!known) return sendJson(res, 404, { ok: false, error: 'machine not found', forwards: forwards.list() })
              machineId = wanted
            }
            const d = forwards.define({
              direction: body.direction === 'reverse' ? 'reverse' : 'local',
              listenPort,
              targetHost: body.targetHost || '127.0.0.1',
              targetPort,
              autoStart: !!body.autoStart,
              machineId,
            })
            return sendJson(res, 200, { ok: true, forward: d, forwards: forwards.list() })
          }
          if (action === 'update') {
            // Partial patch: the row's 自动重连 checkbox sends only `autoStart`,
            // the edit form sends the whole definition. Every field that IS
            // present is validated; a missing field is left untouched (it must
            // not silently reset anything). `autoStart`, when present, still has
            // to be a real boolean.
            const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
            const id = String(body.id || '')
            const current = forwards.list().find((f) => f.id === id)
            if (!current) return sendJson(res, 404, { ok: false, error: 'forward not found', forwards: forwards.list() })
            const patch = {}
            if (has('autoStart')) {
              if (typeof body.autoStart !== 'boolean') {
                return sendJson(res, 400, { ok: false, error: 'autoStart 必须是布尔值' })
              }
              patch.autoStart = body.autoStart
            }
            if (has('direction')) {
              if (body.direction !== 'local' && body.direction !== 'reverse') {
                return sendJson(res, 400, { ok: false, error: 'direction 只能是 local 或 reverse' })
              }
              patch.direction = body.direction
            }
            if (has('listenPort')) {
              const p = Number(body.listenPort)
              if (!Number.isInteger(p) || p < 1 || p > 65535) {
                return sendJson(res, 400, { ok: false, error: 'listenPort 必须是 1–65535 的整数' })
              }
              patch.listenPort = p
            }
            if (has('targetPort')) {
              // An empty target port means "same as the listen port", exactly
              // like the add form.
              const p = body.targetPort === '' || body.targetPort == null
                ? (patch.listenPort !== undefined ? patch.listenPort : current.listenPort)
                : Number(body.targetPort)
              if (!Number.isInteger(p) || p < 1 || p > 65535) {
                return sendJson(res, 400, { ok: false, error: 'targetPort 必须是 1–65535 的整数' })
              }
              patch.targetPort = p
            }
            if (has('targetHost')) {
              const host = String(body.targetHost || '').trim() || '127.0.0.1'
              patch.targetHost = host
            }
            if (has('machineId')) {
              if (body.machineId === null || body.machineId === '') {
                patch.machineId = null
              } else {
                const wanted = String(body.machineId)
                const known = Array.isArray(store.list) && store.list.some((m) => m && m.id === wanted)
                if (!known) return sendJson(res, 404, { ok: false, error: 'machine not found', forwards: forwards.list() })
                patch.machineId = wanted
              }
            }
            // A live tunnel keeps its OLD bind until it is torn down; editing it
            // in place would show one port while the socket listens on another.
            // Only the bind matters — 自动重连 may still be toggled while running.
            const bindChanged = ['direction', 'listenPort', 'targetHost', 'targetPort', 'machineId']
              .some((k) => k in patch && patch[k] !== (current[k] === undefined ? null : current[k]))
            if (current.active && bindChanged) {
              return sendJson(res, 409, { ok: false, error: '先停止这条转发再修改监听/目标/主机', forwards: forwards.list() })
            }
            const d = forwards.update(id, patch)
            if (!d) return sendJson(res, 404, { ok: false, error: 'forward not found', forwards: forwards.list() })
            return sendJson(res, 200, { ok: true, forward: d, forwards: forwards.list() })
          }
          if (action === 'start' || action === 'stop') {
            const d = forwards.list().find((f) => f.id === body.id)
            if (!d) return sendJson(res, 404, { ok: false, error: 'forward not found' })
            if (action === 'start') {
              const r = await forwards.start(d)
              // Always return the CURRENT list, even on failure: a start that
              // lost a race but found the tunnel already listening (see
              // ForwardManager.start) must let the UI leave 启动 instead of
              // staying on a stale row until the next click.
              if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error, forwards: forwards.list() })
            } else {
              // A user stop is intentional: clear the persisted "was running"
              // flag so 自动重连 does not bring it back on the next connect.
              forwards.stop(d.id, { forget: true })
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
