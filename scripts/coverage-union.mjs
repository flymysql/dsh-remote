// Trustworthy coverage for THIS suite.
//
// `node --test --experimental-test-coverage` aggregates V8 scripts by their URL,
// and this suite deliberately imports `lib/index.js` with a cache-busting query
// (`?host=…`, `?fs=…`) so every test gets a fresh module instance (the plugin keeps
// machines/pool state at module level — sharing one instance would leak state between
// tests). V8 then reports ONE SCRIPT PER INSTANCE, so a line covered in instance A
// and not in instance B averages to 50%: the aggregate said 35% for a file whose
// every route is exercised, and got WORSE as tests were added. That is a measurement
// artifact, not a regression.
//
// This script runs the suite with NODE_V8_COVERAGE and unions the ranges per SOURCE
// FILE (query string stripped), which is the number a human means by "coverage".
//
//   node scripts/coverage-union.mjs                 # report
//   node scripts/coverage-union.mjs --gate 70       # exit 1 below 70% line coverage
//
// Limits, stated honestly: `lib/client.js` is evaluated from a string via
// `new Function`, so V8 attributes it to the test file that ran it — it is reported
// separately as "not measurable here" rather than silently as 0%.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.dirname(here)
const args = process.argv.slice(2)
const gateIndex = args.indexOf('--gate')
const gate = gateIndex >= 0 ? Number(args[gateIndex + 1]) : null

const covDir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-cov-'))
const started = Date.now()
const run = spawnSync(
  process.execPath,
  ['--import', './test/setup-telemetry-off.mjs', '--import', './test/setup-coverage.mjs', '--test', '--test-timeout=40000', '--test-force-exit'],
  { cwd: repo, env: { ...process.env, NODE_V8_COVERAGE: covDir }, stdio: 'pipe', encoding: 'utf8' },
)
const seconds = ((Date.now() - started) / 1000).toFixed(0)
if (run.status !== 0) {
  console.error('the test suite failed — fix it before reading coverage:')
  console.error((run.stdout || '').split('\n').filter((l) => /^✖|^ℹ (tests|pass|fail)/.test(l)).join('\n'))
  rmSync(covDir, { recursive: true, force: true })
  process.exit(run.status || 1)
}

/** Union of covered offsets per source file (query string stripped). */
const sources = new Map()
for (const name of readdirSync(covDir)) {
  if (!name.endsWith('.json')) continue
  let data
  try { data = JSON.parse(readFileSync(path.join(covDir, name), 'utf8')) } catch { continue }
  for (const script of data.result || []) {
    const url = String(script.url || '')
    if (!url.startsWith('file://')) continue
    // fileURLToPath, not string surgery: on Windows the URL pathname is
    // `/C:/…`, which is not a readable path — the first version of this script
    // silently skipped every file because of exactly that.
    let file = ''
    try { file = fileURLToPath(url.replace(/\?.*$/, '')) } catch { continue }
    if (!/[\\/]lib[\\/]/.test(file)) continue
    if (/[\\/]node_modules[\\/]/.test(file)) continue
    if (!sources.has(file)) sources.set(file, { ranges: new Map(), functions: new Map() })
    const entry = sources.get(file)
    for (const fn of script.functions || []) {
      for (const range of fn.ranges || []) {
        // Same source range can appear in EVERY cache-busted instance, with a
        // different count. Union the counts per exact range, otherwise an instance
        // that never ran a block wins the innermost-range race and hides the
        // instance that did.
        const key = range.startOffset + ':' + range.endOffset
        entry.ranges.set(key, (entry.ranges.get(key) || 0) || (range.count > 0 ? 1 : 0))
      }
      const key = `${fn.functionName || '(anonymous)'}@${fn.ranges && fn.ranges[0] ? fn.ranges[0].startOffset : 0}`
      const prev = entry.functions.get(key)
      entry.functions.set(key, !!prev || (fn.ranges || []).some((r) => r.count > 0))
    }
  }
}
rmSync(covDir, { recursive: true, force: true })

/**
 * Is this offset executed? V8 reports NESTED ranges (a module-level range with
 * count>0 spans the whole file), so "any covered range contains it" is always true.
 * The correct rule is INNERMOST RANGE WINS: the smallest enclosing range decides.
 */
function coveredAt(ranges, offset) {
  let best = null
  for (const [key, count] of ranges) {
    const [start, end] = key.split(':').map(Number)
    if (offset < start || offset >= end) continue
    const span = end - start
    if (!best || span < best.span) best = { span, count }
  }
  return !!best && best.count > 0
}

const rows = []
for (const [file, entry] of sources) {
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { continue }
  // Line offsets → covered line count (a line counts when its first non-space
  // character is inside a covered range).
  const lines = text.split('\n')
  let offset = 0
  let total = 0
  let hit = 0
  for (const line of lines) {
    const firstNonSpace = line.search(/\S/)
    if (firstNonSpace >= 0 && !/^\s*(\/\/|\*|\/\*)/.test(line)) {
      total += 1
      if (coveredAt(entry.ranges, offset + firstNonSpace)) hit += 1
    }
    offset += line.length + 1
  }
  const fns = [...entry.functions.values()]
  rows.push({
    file: path.relative(repo, file),
    lines: total ? (hit / total) * 100 : 100,
    functions: fns.length ? (fns.filter(Boolean).length / fns.length) * 100 : 100,
    size: text.length,
  })
}
rows.sort((a, b) => a.lines - b.lines)

const measurable = rows.filter((r) => r.size > 0)
const totalBytes = measurable.reduce((n, r) => n + r.size, 0)
const weighted = measurable.reduce((n, r) => n + (r.lines * r.size), 0) / (totalBytes || 1)

console.log(`\nUnion coverage over ${measurable.length} lib/*.js files (suite ran in ${seconds}s)\n`)
console.log('file'.padEnd(28) + 'lines'.padStart(8) + 'funcs'.padStart(8))
for (const r of rows) {
  console.log(r.file.padEnd(28) + r.lines.toFixed(1).padStart(7) + '%' + r.functions.toFixed(1).padStart(7) + '%')
}
console.log(`\nweighted line coverage: ${weighted.toFixed(1)}%`)
console.log('lib/client.js: not measurable with V8 coverage (evaluated from a string) — covered by test/ui-panels.test.js + test/settings-credentials-ui.test.js at the render level.')

if (gate !== null) {
  if (weighted < gate) {
    console.error(`\n✖ coverage gate: ${weighted.toFixed(1)}% < ${gate}%`)
    process.exit(1)
  }
  console.log(`\n✔ coverage gate: ${weighted.toFixed(1)}% >= ${gate}%`)
}
