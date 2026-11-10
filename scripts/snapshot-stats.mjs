#!/usr/bin/env node
// 生成 GitHub Pages 用的统计数据快照（docs/data/stats.json + history.json）。
//
// 为什么是"快照"而不是"前端直连云端"：
//   1) GitHub Pages 是**完全公开**的静态站，把 STATS_KEY 放进前端等于公开口令；
//   2) CloudBase 的 HTTP 访问服务不返回 CORS 头，浏览器本来也直连不了 /stats；
//   3) 页面读同源 JSON 没有跨域与限流问题，也不会每次访问都打云函数。
// 所以由 CI（口令在 GitHub Secrets）定时拉取并落盘，页面只读静态文件。
//
// 用法：
//   DSH_HB_STATS_KEY=<key> node scripts/snapshot-stats.mjs
// 输出：
//   docs/data/stats.json    最新一次快照（页面主数据源）
//   docs/data/history.json  历史 append（保留每日一行，用于画长期趋势）

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STATS_URL = process.env.DSH_HB_STATS_URL
  || 'https://dsh-remote-heartbeat.flymysql.workers.dev/dsh-hb/stats'
const NPM_PACKAGE = 'dsh-remote'
const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(here, '..', 'docs', 'data')

/** 拉一个 JSON 端点，失败返回 null（快照失败不能让 CI 红：旧快照仍有价值）。 */
async function getJson(url, timeoutMs = 25000, headers) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** npm 下载量（公开数据，无需口令）。 */
async function npmStats() {
  const out = { package: NPM_PACKAGE, checkedAt: new Date().toISOString() }
  const [latest, lastWeek, lastMonth, range] = await Promise.all([
    // 最新版本号也在这里取：页面直连 registry.npmjs.org 可能在部分浏览器/网络
    // 策略下被拦（实测 "Failed to fetch"，页面上版本号显示成 "—"），所以由 CI
    // 落进同源快照，页面优先读它、直连只作兜底。
    getJson(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`),
    getJson(`https://api.npmjs.org/downloads/point/last-week/${NPM_PACKAGE}`),
    getJson(`https://api.npmjs.org/downloads/point/last-month/${NPM_PACKAGE}`),
    getJson(`https://api.npmjs.org/downloads/range/last-month/${NPM_PACKAGE}`),
  ])
  out.latest = typeof latest?.version === 'string' ? latest.version : null
  out.lastWeek = lastWeek?.downloads ?? null
  out.lastMonth = lastMonth?.downloads ?? null
  if (range?.downloads) {
    // ★ npm 日粒度存在上报缺口：某些天整条管线返回 0（实测与对照包零值日
    //   完全一致）。直接把这些 0 当"没人下载"会低估约 20% 的天数，
    //   所以标注出来，让页面不要把它们读成真实零。
    out.daily = range.downloads.map((d) => ({ day: d.day, downloads: d.downloads }))
    out.zeroDays = range.downloads.filter((d) => d.downloads === 0).map((d) => d.day)
    out.note = 'npm daily counts have reporting gaps; zero-value days are flagged and are not real zero usage.'
  }
  return out
}

/** GitHub 仓库公开指标。
 *  未认证的 api.github.com 只有 60 次/小时且按出口 IP 共享，CI runner 很容易
 *  撞上 403 —— 传入 GITHUB_TOKEN 后限额提到 5000/小时。取不到就返回 null，
 *  页面会隐藏这一块而不是显示 0（把"拿不到"显示成 0 是误导）。 */
async function repoStats() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const headers = token
    ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
    : { accept: 'application/vnd.github+json' }
  const r = await getJson(`https://api.github.com/repos/flymysql/${NPM_PACKAGE}`, 25000, headers)
  if (!r) return null
  return {
    stars: r.stargazers_count ?? null,
    forks: r.forks_count ?? null,
    openIssues: r.open_issues_count ?? null,
    pushedAt: r.pushed_at ?? null,
  }
}

async function main() {
  const key = process.env.DSH_HB_STATS_KEY || ''
  mkdirSync(dataDir, { recursive: true })

  let stats = null
  let statsError = null
  if (!key) {
    statsError = 'DSH_HB_STATS_KEY not set; skipping heartbeat stats (npm/repo data still refreshed)'
  } else {
    stats = await getJson(`${STATS_URL}?days=30&key=${encodeURIComponent(key)}`)
    if (!stats || !stats.ok) statsError = `stats endpoint returned ${stats ? JSON.stringify(stats).slice(0, 160) : 'no response'}`
  }

  const [npm, repo] = await Promise.all([npmStats(), repoStats()])

  const snapshot = {
    generatedAt: new Date().toISOString(),
    heartbeat: stats || null,
    heartbeatError: statsError,
    npm,
    repo,
  }
  writeFileSync(path.join(dataDir, 'stats.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  console.log(`stats.json written (heartbeat=${stats ? 'ok' : 'unavailable'})`)

  // 历史：每个自然日保留最后一条，便于页面画长期趋势而不只显示"当前"
  const histPath = path.join(dataDir, 'history.json')
  let history = []
  if (existsSync(histPath)) {
    try {
      const parsed = JSON.parse(readFileSync(histPath, 'utf8'))
      if (Array.isArray(parsed)) history = parsed
    } catch { /* 损坏则重建 */ }
  }
  const day = (stats?.generatedAt || snapshot.generatedAt).slice(0, 10)
  const row = {
    day,
    at: snapshot.generatedAt,
    dau: stats?.daily?.length ? stats.daily[stats.daily.length - 1].dau : null,
    wau: stats?.wau ?? null,
    mau: stats?.mau ?? null,
    installs: stats?.installs ?? null,
    npmLastWeek: npm.lastWeek,
    stars: repo?.stars ?? null,
    forks: repo?.forks ?? null,
  }
  const idx = history.findIndex((h) => h.day === day)
  if (idx >= 0) history[idx] = row
  else history.push(row)
  history.sort((a, b) => String(a.day).localeCompare(String(b.day)))
  writeFileSync(histPath, `${JSON.stringify(history.slice(-400), null, 2)}\n`, 'utf8')
  console.log(`history.json written (${history.length} days)`)

  if (statsError) console.warn(`warning: ${statsError}`)
}

main().catch((e) => {
  console.error(`snapshot failed: ${e?.message || e}`)
  process.exit(1)
})
