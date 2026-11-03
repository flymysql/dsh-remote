#!/usr/bin/env node
// dsh-remote 日活统计查询（只读）。
//
// 用途：不用记 tcb/云函数细节，一条命令拿到「日活 + 装机量 + 版本分布 + 平台分布」。
//
// 用法：
//   node scripts/stats.mjs                   # 近 14 天
//   node scripts/stats.mjs --days 30
//   node scripts/stats.mjs --key <STATS_KEY> # 或设 DSH_HB_STATS_KEY
//   node scripts/stats.mjs --json            # 原始 JSON（喂给别的脚本）
//
// 口令来源优先级：--key > 环境变量 DSH_HB_STATS_KEY > 同目录 .stats-key 文件。
// 该口令只用于读统计（云端 /stats 校验），不含任何身份信息。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const STATS_URL = 'https://slippery-iguana-d1fhb1xmd469ee8c-1256429518.ap-shanghai.app.tcloudbase.com/dsh-hb/stats'
const here = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function loadKey() {
  const fromArg = arg('key', '')
  if (fromArg) return fromArg
  if (process.env.DSH_HB_STATS_KEY) return process.env.DSH_HB_STATS_KEY
  for (const p of [path.join(here, '..', '.stats-key'), path.join(here, '..', '..', 'dsh-remote-heartbeat', '.stats-key')]) {
    try {
      const v = readFileSync(p, 'utf8').trim()
      if (v) return v
    } catch { /* try next */ }
  }
  return ''
}

/** 极简单的表格渲染（不引依赖，插件仓库保持零构建）。 */
function table(rows, headers) {
  if (!rows.length) return '  (无数据)'
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)))
  const line = (cells) => '  ' + cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ')
  return [line(headers), '  ' + widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n')
}

async function main() {
  const days = Math.min(Math.max(Number(arg('days', 14)) || 14, 1), 90)
  const key = loadKey()
  if (!key) {
    console.error('缺少统计口令。用 --key <STATS_KEY>，或设 DSH_HB_STATS_KEY，或把口令写入 .stats-key。')
    process.exit(2)
  }

  const url = `${STATS_URL}?days=${days}&key=${encodeURIComponent(key)}`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  } catch (e) {
    console.error(`无法连接统计端点: ${e?.message || e}`)
    process.exit(1)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok || !body || !body.ok) {
    console.error(`查询失败: HTTP ${res.status} ${body ? JSON.stringify(body) : ''}`)
    process.exit(1)
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(body, null, 2))
    return
  }

  const daily = body.daily || []
  // 今天的数据仍在累积，单独标注，避免把"今天还没过完"读成"掉了"
  const today = body.generatedAt ? new Intl.DateTimeFormat('en-CA', { timeZone: body.tz }).format(new Date(body.generatedAt)) : ''
  const rows = daily.map((d) => [
    d.day + (d.day === today ? '  (今天·未完整)' : ''),
    d.dau,
  ])
  const peak = daily.reduce((m, d) => Math.max(m, d.dau || 0), 0)
  const active = daily.filter((d) => (d.dau || 0) > 0).length

  console.log(`\n=== dsh-remote 日活（近 ${days} 天，时区 ${body.tz}）===`)
  console.log(table(rows, ['日期', '日活(去重装机)']))
  console.log(`\n  峰值 ${peak}   有数据天数 ${active}/${daily.length}   累计装机 ${body.installs ?? '?'}`)
  console.log(`\n=== 在用版本分布（按最近一次上报）===`)
  console.log(table((body.byVersion || []).map((v) => [v.version, v.n]), ['版本', '装机数']))
  console.log(`\n=== 平台分布 ===`)
  console.log(table((body.byPlatform || []).map((v) => [v.platform, v.n]), ['平台', '装机数']))
  console.log('\n口径提醒：')
  console.log('  · 只有装了「含心跳版本」的安装会上报 ⇒ 首次发布后的前几周，日活会被系统性低估，')
  console.log('    它衡量的是"已升级用户"，不是全部用户。用 npm 下载/GitHub clone 做总量校准。')
  console.log('  · 日活 = 当天去重装机数；同一天重复启动只算一次。')
  console.log('  · 身份是 HMAC 伪名，删掉 <DSH_HOME>/.dsh-remote-install-id 会被算成新装机。\n')
}

main()
