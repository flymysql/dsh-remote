// dsh-remote — HTTP routes for the embedded terminal.
//
// Four small endpoints around one host-owned PTY session (see lib/terminal.js
// for why polling instead of a WebSocket):
//
//   POST /dsh-remote/term/open    {cols, rows}            → {id}
//   POST /dsh-remote/term/input   {id, data}              → {ok}
//   GET  /dsh-remote/term/output  ?id&from=N              → {chunks, next, lossy, closed}
//   POST /dsh-remote/term/resize  {id, cols, rows}        → {ok}
//   POST /dsh-remote/term/close   {id}                    → {ok}
//
// Every route resolves the binding from the SESSION first (the same
// `resolveRequestBinding` the file routes use), so a terminal can only ever be
// opened on — and attached to — the machine that session is actually bound to.
// That is the same isolation rule that keeps one session from acting on
// another's host, applied to an interactive channel where a mistake would be
// even more visible.

/**
 * Build the terminal routes.
 *
 * @param {object} deps
 * @param {Function} deps.sendJson
 * @param {Function} deps.readBody
 * @param {Function} deps.resolveRequestBinding - session-aware binding resolver.
 * @param {object} deps.terminals - the manager from createTerminalManager().
 * @param {Function} deps.machineKey - (binding) → a stable machine identity.
 * @returns {Array<object>} route descriptors for webServer.register().
 */
export function createTerminalRoutes({ sendJson, readBody, resolveRequestBinding, terminals, machineKey }) {
  /** Resolve the binding and derive the machine identity, or reply and return null. */
  const bind = async (req, res, body = {}) => {
    let b
    try {
      b = await resolveRequestBinding(req, body)
    } catch (err) {
      sendJson(res, (err && err.httpStatus) || 500, { ok: false, error: String((err && err.message) || err) })
      return null
    }
    if (!b) return null
    return { b, machine: machineKey(b) }
  }

  return [
    {
      kind: 'exact',
      path: '/dsh-remote/term/open',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const bound = await bind(req, res, body)
          if (!bound) return
          const r = await terminals.open({
            pool: bound.b.pool,
            machine: bound.machine,
            cols: Number(body.cols) || 80,
            rows: Number(body.rows) || 24,
          })
          if (!r.ok) return sendJson(res, 503, { ok: false, error: r.error })
          return sendJson(res, 200, { ok: true, id: r.id })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },

    {
      kind: 'exact',
      path: '/dsh-remote/term/input',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const bound = await bind(req, res, body)
          if (!bound) return
          const { session, error } = terminals.owned(body.id, bound.machine)
          if (error) return sendJson(res, 404, { ok: false, error })
          const data = typeof body.data === 'string' ? body.data : ''
          if (!data) return sendJson(res, 400, { ok: false, error: 'data is required' })
          if (!session.write(data)) return sendJson(res, 409, { ok: false, error: 'session is closed' })
          return sendJson(res, 200, { ok: true })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },

    {
      kind: 'exact',
      path: '/dsh-remote/term/output',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          let body = {}
          if (req.method === 'POST') body = JSON.parse((await readBody(req)) || '{}')
          const bound = await bind(req, res, body)
          if (!bound) return
          const id = body.id || q.get('id') || ''
          const from = Number(body.from != null ? body.from : q.get('from')) || 0
          const { session, error } = terminals.owned(id, bound.machine)
          if (error) return sendJson(res, 404, { ok: false, error })
          const out = session.readFrom(from)
          return sendJson(res, 200, { ok: true, ...out })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },

    {
      kind: 'exact',
      path: '/dsh-remote/term/resize',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const bound = await bind(req, res, body)
          if (!bound) return
          const { session, error } = terminals.owned(body.id, bound.machine)
          if (error) return sendJson(res, 404, { ok: false, error })
          session.resize(body.cols, body.rows)
          return sendJson(res, 200, { ok: true, cols: session.cols, rows: session.rows })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },

    {
      kind: 'exact',
      path: '/dsh-remote/term/close',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const bound = await bind(req, res, body)
          if (!bound) return
          const r = terminals.close(body.id, bound.machine)
          if (!r.ok) return sendJson(res, 404, { ok: false, error: r.error })
          return sendJson(res, 200, { ok: true })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },

    {
      kind: 'exact',
      path: '/dsh-remote/term/list',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const bound = await bind(req, res, {})
          if (!bound) return
          // Only THIS machine's sessions: a listing that leaks other hosts'
          // session ids would let a caller probe them (ids are guessable UUIDs
          // only in the sense that they are opaque; the machine fence is the
          // real boundary).
          const mine = terminals.list().filter((s) => s.machine === bound.machine)
          return sendJson(res, 200, { ok: true, sessions: mine })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]
}
