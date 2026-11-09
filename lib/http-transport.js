// The routes in index.js are bounded JSON handlers, not arbitrary HTTP proxy
// handlers. Keep their implementation shared with legacy Web hosts while using
// Connection's authenticated, carrier-neutral channel on portless Desktop.
import { Readable } from 'node:stream'

const MAX_BODY_BYTES = 1024 * 1024

export function connectionRoute(route) {
  // Only the prefix is a real invariant here. `kind`/`exact` belongs to
  // dsh-host-webserver's registry (WebRouteKind); Connection's
  // ConnectionFetchRoute has no `kind` field and assertFetchRoute never reads
  // one, so requiring it would let a future route that omits it silently lose
  // itself and every route registered after it.
  if (!route.path.startsWith('/dsh-remote/')) {
    throw new Error('dsh-remote: expected a plugin route under /dsh-remote/')
  }
  return {
    path: '/api' + route.path,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const chunks = []
      let size = 0
      // Desktop's IPC carrier need not impose the Web carrier's JSON cap.
      // Enforce our own cap before dispatch: oversized input must never become
      // an empty object that could accidentally trigger a default operation.
      const reader = request.body?.getReader()
      try {
        if (reader) {
          while (true) {
            request.signal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_BODY_BYTES) {
              await reader.cancel()
              return Response.json({ ok: false, error: 'request body too large' }, { status: 413 })
            }
            chunks.push(Buffer.from(value))
          }
        }
      } finally {
        reader?.releaseLock()
      }
      request.signal.throwIfAborted()
      const url = new URL(request.url)
      // The legacy JSON reader joins chunks as strings. Supply one bounded
      // buffer so UTF-8 characters split by the IPC stream remain intact.
      const req = Readable.from(size ? [Buffer.concat(chunks, size)] : [])
      req.method = request.method
      req.url = route.path + url.search
      const headers = new Headers()
      let response
      const res = {
        statusCode: 200,
        setHeader(key, value) { headers.set(key, value) },
        end(body) { response = new Response(body, { status: this.statusCode, headers }) },
      }
      try {
        await route.handler(req, res)
        if (!response) throw new Error('JSON handler did not finish its response')
        return response
      } finally {
        req.destroy()
      }
    },
  }
}

/**
 * Reject a browser-shaped request that is not same-origin ours.
 *
 * This is the FALLBACK fence, used only when the Connection service (which owns
 * DSH's authoritative `requestRejection`) is absent — an old composition that
 * has a `webServer` but no browser-authentication owner. It is deliberately
 * fail-closed on the three browser vectors our own routes would otherwise
 * accept:
 *   • `sec-fetch-site: cross-site` — a page on any origin driving our API;
 *   • an `Origin` that is not our own authority — the same, with CORS markers;
 *   • a non-loopback `Host` — DNS rebinding, where a name the attacker controls
 *     resolves to 127.0.0.1 so even `Origin === Host` looks "same-origin".
 * Non-browser callers (curl, scripts) carry no `Sec-Fetch-*`/`Origin` and a
 * loopback `Host`, so they keep working; that is the same shape DSH's own fence
 * implements for `/api`.
 *
 * A request with no HTTP headers at all is not a browser request — it comes
 * from an in-process caller (tests, and the Desktop carrier's IPC path, which
 * authenticates before dispatch) — so there is no browser layer to defend.
 *
 * @param {import('node:http').IncomingMessage} req - the request under test.
 * @returns {number|undefined} 403 to reject, undefined to proceed.
 */
function fallbackRejection(req) {
  const headers = req && req.headers
  if (!headers || typeof headers !== 'object') return undefined
  const header = (name) => {
    const value = headers[name]
    return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
  }
  if (header('sec-fetch-site') === 'cross-site') return 403
  const host = header('host')
  const origin = header('origin')
  if (origin !== undefined && host !== undefined) {
    try {
      if (new URL(origin).host !== host) return 403
    } catch {
      return 403
    }
  }
  if (host !== undefined) {
    const hostname = host.replace(/:\d+$/, '').toLowerCase()
    const loopback = hostname === 'localhost' || hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    if (!loopback) return 403
  }
  return undefined
}

/**
 * Wrap one route so every request passes DSH's browser trust fence first.
 *
 * The legacy `/dsh-remote/*` routes are registered straight on `webServer`, which
 * applies no Host/Origin check and no browser authentication — `requestRejection`
 * lives on the Connection service and is only wired to `/api` and the
 * `/api/remote.mux` upgrade. Without this wrapper our mutating routes were
 * reachable cross-site as "simple requests" (no preflight: a `text/plain` POST
 * needs no CORS approval), so any page the user visited could define a tunnel,
 * rewrite the machine registry, or drive `update-apply`. The model tools were
 * never exposed that way; only these JSON routes were.
 *
 * The lookup is deferred to request time because `webServer` and `connection`
 * arrive independently: the fence must engage as soon as authentication exists,
 * and must not be baked in from whichever service happened to be present when
 * the route was registered.
 *
 * @param {object} route - a webServer route definition.
 * @param {() => object|undefined} connectionOf - resolves the live Connection service.
 * @returns {object} a route whose handler enforces the fence before dispatching.
 */
export function guardRoute(route, connectionOf) {
  const inner = route.handler
  return {
    ...route,
    handler: async (req, res) => {
      // `fence: 'bearer'` routes authenticate with their OWN credential (a
      // per-boot token from a 0600 file) and serve non-browser local processes
      // (the askpass helper) — the Connection fence would 401 them for lacking
      // the browser cookie. They still get the fail-closed fallback fence, so a
      // cross-site page (which cannot read the token file) stays locked out.
      const connection = route.fence === 'bearer' ? undefined : connectionOf()
      const rejection = typeof connection?.requestRejection === 'function'
        ? connection.requestRejection(req)
        : fallbackRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      return inner(req, res)
    },
  }
}

export function registerHttpTransports(ctx, routes) {
  // Reactive injection matters: either service can arrive after the plugin.
  // Neither optional transport is a hard prerequisite for the SSH tools.
  ctx.inject(['webServer'], (inner) => {
    // Apply DSH's own browser fence to every legacy route; the Connection
    // service is read per request so a late-arriving authenticator still counts.
    const guarded = routes.map((route) => guardRoute(route, () => ctx.get('connection')))
    const disposers = guarded.map((route) => inner.get('webServer').register(route))
    inner.effect(() => () => disposers.forEach((dispose) => dispose()), 'dsh-remote.web-routes')
  })
  ctx.inject(['connection'], (inner) => {
    const connection = inner.get('connection')
    // Older Web compositions may have Connection without exact Fetch routes.
    // dsh < 0.1.2-rc.1 is such a composition: the Desktop transport is simply
    // absent there, and the legacy /dsh-remote/* routes above still serve.
    if (typeof connection.fetch?.register !== 'function') return
    // Register one route at a time. A single failing route must not abort the
    // rest of the list (which would silently drop every later route) nor leak
    // the routes already registered, because this callback is a ctx.inject
    // child fiber: its throw is caught and logged by the loader, so the parent
    // plugin stays ACTIVE and the failure is easy to miss.
    const disposers = []
    const failed = []
    for (const route of routes) {
      try {
        disposers.push(connection.fetch.register(connectionRoute(route)))
      } catch (err) {
        failed.push(route.path + ': ' + String((err && err.message) || err))
      }
    }
    inner.effect(() => () => Promise.all(disposers.map((dispose) => dispose())), 'dsh-remote.fetch-routes')
    if (failed.length) {
      // Surface a partial registration instead of swallowing it; the Web
      // transport is unaffected, so this is a warning rather than a failure.
      console.warn('[dsh-remote] some Connection Fetch routes did not register:', failed.join('; '))
    }
  })
}
