// Unit tests for the heartbeat worker. Pure logic (validation, day buckets,
// gap fill) runs bare; the router runs against a fake D1 that answers by exact
// SQL string — the SQL itself gets its real proof at deploy-smoke time against
// live D1 (documented in README.md), since node:sqlite needs flags on CI's
// Node 22.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import worker, { TZ, dayInTz, fillDaily, shiftDay, validatePing } from './worker.js'

// ── pure helpers ────────────────────────────────────────────────────────────

test('day buckets land on Asia/Shanghai calendar days (UTC evening belongs to tomorrow)', () => {
  // 2026-11-10T16:30:00Z is 2026-11-11 00:30 in Shanghai.
  assert.equal(dayInTz(new Date('2026-11-10T16:30:00Z')), '2026-11-11')
  assert.equal(dayInTz(new Date('2026-11-10T15:59:59Z')), '2026-11-10')
  assert.equal(dayInTz(new Date('2026-11-10T12:00:00Z')), '2026-11-10')
  assert.equal(TZ, 'Asia/Shanghai')
})

test('shiftDay walks calendar days, month ends included', () => {
  assert.equal(shiftDay('2026-11-01', -1), '2026-10-31')
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDay('2024-02-28', 1), '2024-02-29', 'leap day')
})

test('validatePing whitelists and shape-checks (no raw UUIDs, no junk fields)', () => {
  const good = validatePing({ idHash: 'a'.repeat(32), version: '0.8.84', platform: 'win32', arch: 'x64', node: '24.1.0', evil: 'drop-me' })
  assert.equal(good.ok, true)
  assert.deepEqual(Object.keys(good.ping).sort(), ['arch', 'idHash', 'node', 'platform', 'version'])

  assert.equal(validatePing({}).ok, false, 'missing idHash')
  assert.equal(validatePing({ idHash: 'not-hex' }).ok, false)
  assert.equal(validatePing({ idHash: 'A'.repeat(32) }).ok, false, 'uppercase is not the pseudonym format')
  assert.equal(validatePing({ idHash: '550e8400-e29b-41d4-a716-446655440000' }).ok, false, 'a raw UUID must not be stored')
  assert.equal(validatePing('string').ok, false)

  const odd = validatePing({ idHash: 'b'.repeat(32), version: '0.1<script>', platform: 'win 32' })
  assert.equal(odd.ok, true)
  assert.equal(odd.ping.version, '', 'illegal chars void the OPTIONAL field instead of poisoning a row')
  assert.equal(odd.ping.platform, '')
})

test('fillDaily emits every day in the window, zero-filled', () => {
  const out = fillDaily('2026-11-08', '2026-11-10', [{ day: '2026-11-09', dau: 5 }])
  assert.deepEqual(out, [
    { day: '2026-11-08', dau: 0 },
    { day: '2026-11-09', dau: 5 },
    { day: '2026-11-10', dau: 0 },
  ])
})

// ── router with a fake D1 ───────────────────────────────────────────────────

/** Fake D1: prepare(sql) → {bind(...args)} → runner; runner/direct {all,first,run} from the SQL→answer map. */
function fakeDb(answers, calls = []) {
  const produce = (sql, args) => {
    const answer = answers[sql]
    if (!answer) throw new Error('unexpected SQL: ' + sql)
    calls.push({ sql, args })
    return answer
  }
  const toRunner = (sql, args) => {
    const a = produce(sql, args)
    return { all: a.all, first: a.first, run: a.run }
  }
  return {
    calls,
    prepare(sql) {
      return {
        bind: (...args) => toRunner(sql, args),
        all: () => toRunner(sql, []).all(),
        first: () => toRunner(sql, []).first(),
        run: () => toRunner(sql, []).run(),
      }
    },
  }
}

const SECRET = 'test-stats-key'

function req(method, path, body) {
  return new Request('https://w.test' + path, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
}

test('heartbeat accepts a valid ping and dedupes by (day, pseudonym) via INSERT OR IGNORE', async () => {
  let ran = null
  const db = fakeDb({
    'INSERT OR IGNORE INTO pings (day, id_hash, version, platform, arch, node) VALUES (?1, ?2, ?3, ?4, ?5, ?6)': {
      run: async () => ({ meta: { changes: 1 } }),
    },
  })
  // capture bind args
  const origPrepare = db.prepare.bind(db)
  db.prepare = (sql) => ({ bind: (...args) => { ran = { sql, args }; return { run: async () => ({}) } }, _: origPrepare(sql) })

  const res = await worker.fetch(req('POST', '/dsh-hb/heartbeat', { idHash: 'c'.repeat(32), version: '0.8.84', platform: 'darwin', arch: 'arm64', node: '24.0.0' }), { DB: db, STATS_KEY: SECRET })
  assert.equal(res.status, 204)
  assert.equal(ran.args[1], 'c'.repeat(32))
  assert.match(ran.sql, /INSERT OR IGNORE/, 'retries must not inflate the day count')
  assert.match(ran.sql, /pings \(day, id_hash, version, platform, arch, node\)/)
  assert.equal(ran.args[2], '0.8.84')
})

test('heartbeat rejects junk without touching the database', async () => {
  const db = fakeDb({})
  for (const bad of [
    req('POST', '/dsh-hb/heartbeat', { idHash: 'nope' }),
    req('POST', '/dsh-hb/heartbeat', {}),
    req('PUT', '/dsh-hb/heartbeat', { idHash: 'c'.repeat(32) }),
  ]) {
    const res = await worker.fetch(bad, { DB: db, STATS_KEY: SECRET })
    assert.ok(res.status === 400 || res.status === 405, `got ${res.status}`)
  }
  assert.equal(db.calls.length, 0)
})

test('stats demands the key, then returns the exact shape the dashboard consumes', async () => {
  const dailySql = 'SELECT day, COUNT(*) AS dau FROM pings WHERE day BETWEEN ?1 AND ?2 GROUP BY day ORDER BY day'
  const wauSql = 'SELECT COUNT(DISTINCT id_hash) AS n FROM pings WHERE day BETWEEN ?1 AND ?2'
  const installsSql = 'SELECT COUNT(DISTINCT id_hash) AS n FROM pings'
  const byVerSql = 'SELECT version, COUNT(DISTINCT id_hash) AS n FROM pings WHERE day BETWEEN ?1 AND ?2 AND version <> \'\' GROUP BY version ORDER BY n DESC, version ASC LIMIT 12'
  const byPlatSql = 'SELECT platform, COUNT(DISTINCT id_hash) AS n FROM pings WHERE day BETWEEN ?1 AND ?2 AND platform <> \'\' GROUP BY platform ORDER BY n DESC, platform ASC LIMIT 12'
  const db = fakeDb({
    [dailySql]: { all: async () => ({ results: [{ day: dayInTz(), dau: 7 }] }) },
    [wauSql]: { first: async () => ({ n: 11 }) },
    [installsSql]: { first: async () => ({ n: 42 }) },
    [byVerSql]: { all: async () => ({ results: [{ version: '0.8.83', n: 9 }] }) },
    [byPlatSql]: { all: async () => ({ results: [{ platform: 'win32', n: 6 }] }) },
  })

  const denied = await worker.fetch(req('GET', '/dsh-hb/stats'), { DB: db, STATS_KEY: SECRET })
  assert.equal(denied.status, 401)
  const wrongKey = await worker.fetch(req('GET', '/dsh-hb/stats?key=nope'), { DB: db, STATS_KEY: SECRET })
  assert.equal(wrongKey.status, 401)

  const res = await worker.fetch(req('GET', '/dsh-hb/stats?days=30&key=' + SECRET), { DB: db, STATS_KEY: SECRET })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.tz, 'Asia/Shanghai')
  assert.equal(body.wau, 11)
  assert.equal(body.mau, 11, 'wauSql/mauSql share the text; both get the same fake answer')
  assert.equal(body.installs, 42)
  assert.equal(body.daily.length, 30, 'the window is always exactly N days, gaps filled')
  assert.equal(body.daily[body.daily.length - 1].dau, 7)
  assert.deepEqual(body.byVersion, [{ version: '0.8.83', n: 9 }])
  assert.deepEqual(body.byPlatform, [{ platform: 'win32', n: 6 }])
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

test('health and unknown paths answer without any database access', async () => {
  const db = fakeDb({})
  assert.equal((await worker.fetch(req('GET', '/dsh-hb/health'), { DB: db, STATS_KEY: SECRET })).status, 200)
  assert.equal((await worker.fetch(req('GET', '/nope'), { DB: db, STATS_KEY: SECRET })).status, 404)
  assert.equal(db.calls.length, 0)
})
