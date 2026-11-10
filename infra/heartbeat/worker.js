// dsh-remote heartbeat backend — Cloudflare Worker + D1 (free tier).
//
// Replaces the CloudBase functions that kept dying on balance suspensions
// (three outages by 2026-11; the trial point bundle burned in a week).
// Free-tier arithmetic at our scale: ~DAU writes/day against D1's free
// 100k writes/day and 5M reads/day — two orders of magnitude of headroom.
//
// Routes (paths kept identical to the CloudBase era on purpose):
//   POST /dsh-hb/heartbeat   — one minimal install ping; 204, body ignored
//   GET  /dsh-hb/stats?days=&key= — aggregated counters; 401 without the key
//   GET  /dsh-hb/health      — liveness only, reveals nothing
//
// Privacy invariants (the plugin's telemetry.js promises these; this worker
// enforces them server-side):
//   · field whitelist {idHash, version, platform, arch, node}, everything
//     else dropped before storage;
//   · idHash must be the 32-hex HMAC pseudonym — a raw UUID or anything else
//     is rejected rather than stored;
//   · no IP, no User-Agent, no timestamps beyond the day bucket are stored;
//   · no logs carry request bodies.

export const TZ = 'Asia/Shanghai'

/** Day bucket (YYYY-MM-DD) in the reporting timezone. */
export function dayInTz(now = new Date(), tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
}

/** Shift a YYYY-MM-DD by whole days (UTC arithmetic — calendar math only). */
export function shiftDay(day, delta) {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

const HEX32 = /^[0-9a-f]{32}$/

/** Trim to length and printable ASCII (storage is a counter, not a diary). */
function field(value, maxLen, re) {
  const s = String(value === undefined || value === null ? '' : value).slice(0, maxLen)
  if (re && !re.test(s)) return ''
  return s
}

/**
 * Validate + whitelist a heartbeat body. Returns { ok, ping | error }.
 * The pseudonym is mandatory AND shape-checked: storing anything else would
 * let junk (or worse, a correlation-capable id) into the counter table.
 */
export function validatePing(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'object body required' }
  const idHash = String(input.idHash || '')
  if (!HEX32.test(idHash)) return { ok: false, error: 'idHash must be 32 lowercase hex chars' }
  return {
    ok: true,
    ping: {
      idHash,
      version: field(input.version, 32, /^[0-9A-Za-z.+-]*$/),
      platform: field(input.platform, 16, /^[a-z0-9]*$/i),
      arch: field(input.arch, 16, /^[a-z0-9_-]*$/i),
      node: field(input.node, 24, /^[0-9A-Za-z.+-]*$/),
    },
  }
}

/** Fill gaps so the chart never pretends a missing day did not happen. */
export function fillDaily(startDay, endDay, rows) {
  const byDay = new Map()
  for (const r of rows || []) byDay.set(String(r.day), Number(r.dau) || 0)
  const out = []
  for (let d = startDay; d <= endDay; d = shiftDay(d, 1)) {
    out.push({ day: d, dau: byDay.get(d) || 0 })
  }
  return out
}

/** Constant-time-ish secret comparison (hash both sides, XOR the digests). */
async function keyMatches(presented, expected) {
  if (!presented || !expected) return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(presented))),
    crypto.subtle.digest('SHA-256', enc.encode(String(expected))),
  ])
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i]
  return diff === 0
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

async function recordPing(db, request) {
  const len = Number(request.headers.get('content-length') || 0)
  if (len > 4096) return json({ ok: false, error: 'body too large' }, 413)
  let raw
  try { raw = await request.json() } catch { return json({ ok: false, error: 'invalid JSON' }, 400) }
  const verdict = validatePing(raw)
  if (!verdict.ok) return json({ ok: false, error: verdict.error }, 400)
  const p = verdict.ping
  await db.prepare(
    'INSERT OR IGNORE INTO pings (day, id_hash, version, platform, arch, node) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  ).bind(dayInTz(), p.idHash, p.version, p.platform, p.arch, p.node).run()
  return new Response(null, { status: 204 })
}

async function stats(db, url, env) {
  if (!(await keyMatches(url.searchParams.get('key') || '', env.STATS_KEY || ''))) {
    return json({ ok: false, error: 'unauthorized' }, 401)
  }
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 30))
  const today = dayInTz()
  const oldest = shiftDay(today, -(days - 1))
  const weekAgo = shiftDay(today, -6)

  const dailyRows = await db.prepare(
    'SELECT day, COUNT(*) AS dau FROM pings WHERE day BETWEEN ?1 AND ?2 GROUP BY day ORDER BY day',
  ).bind(oldest, today).all()
  const wau = await db.prepare(
    'SELECT COUNT(DISTINCT id_hash) AS n FROM pings WHERE day BETWEEN ?1 AND ?2',
  ).bind(weekAgo, today).first()
  const mau = await db.prepare(
    'SELECT COUNT(DISTINCT id_hash) AS n FROM pings WHERE day BETWEEN ?1 AND ?2',
  ).bind(oldest, today).first()
  const installs = await db.prepare(
    'SELECT COUNT(DISTINCT id_hash) AS n FROM pings',
  ).first()
  const byVersion = await db.prepare(
    'SELECT version, COUNT(DISTINCT id_hash) AS n FROM pings WHERE day BETWEEN ?1 AND ?2 AND version <> \'\' GROUP BY version ORDER BY n DESC, version ASC LIMIT 12',
  ).bind(oldest, today).all()
  const byPlatform = await db.prepare(
    'SELECT platform, COUNT(DISTINCT id_hash) AS n FROM pings WHERE day BETWEEN ?1 AND ?2 AND platform <> \'\' GROUP BY platform ORDER BY n DESC, platform ASC LIMIT 12',
  ).bind(oldest, today).all()

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    tz: TZ,
    daily: fillDaily(oldest, today, (dailyRows && dailyRows.results) || []),
    wau: Number((wau && wau.n) || 0),
    mau: Number((mau && mau.n) || 0),
    installs: Number((installs && installs.n) || 0),
    byVersion: ((byVersion && byVersion.results) || []).map((r) => ({ version: String(r.version), n: Number(r.n) })),
    byPlatform: ((byPlatform && byPlatform.results) || []).map((r) => ({ platform: String(r.platform), n: Number(r.n) })),
  })
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/dsh-hb/health') return json({ ok: true })
      if (url.pathname === '/dsh-hb/heartbeat') {
        if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
        return await recordPing(env.DB, request)
      }
      if (url.pathname === '/dsh-hb/stats') {
        if (request.method !== 'GET') return json({ ok: false, error: 'method not allowed' }, 405)
        return await stats(env.DB, url, env)
      }
      return json({ ok: false, error: 'not found' }, 404)
    } catch (err) {
      // Never leak internals; a 500 here only means "try the next snapshot".
      return json({ ok: false, error: 'internal error' }, 500)
    }
  },
}
