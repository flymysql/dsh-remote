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
//   node scripts/coverage-union.mjs --gate 70       # exit 1 below 70% weighted line coverage
//   node scripts/coverage-union.mjs --file-gate 60  # exit 1 if ANY file is below its per-file floor
//
// `lib/client.js` is browser code that tests evaluate from a string; every
// evaluation site tags the source with `sourceURL`/`filename: 'lib/client.js'`,
// and V8 honours that as the coverage script url (offsets stay relative to the
// passed source — verified by probe), so it unions like any other file via the
// bare-name branch below.
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
const fileGateIndex = args.indexOf('--file-gate')
const fileGate = fileGateIndex >= 0 ? Number(args[fileGateIndex + 1]) : null

// Per-file floors BELOW the global --file-gate, each with the reason it exists.
// An exception is a deliberate, visible act — and the stale check at the bottom
// tells you to delete it the day the file rises above the global gate.
const FILE_FLOORS = new Map([
  ['lib/openssh.js', 55], // drives the LOCAL ssh binary; its real proof is it-openssh-real against a live host, which CI does not have
  ['lib/index.js', 59], // 252KB host-side god-file; the floor ratchets up as routes get extracted into their own modules
  ['lib/client.js', 45], // browser code at render-level vm coverage; measured 47–50% run-to-run (real-timer stubs in the render harness fire nondeterministically) — floor carries margin until the harness is de-flaked; tightening WITHOUT fixing that is how you get a flaky gate
])

// Files counted per-file but EXCLUDED from the weighted average: client.js is
// a 265KB browser bundle at a structurally lower ceiling — letting it into the
// weighted number would anchor every host-side improvement to one file that can
// only move with a browser e2e. The weighted metric stays the host-side signal;
// client.js is watched by its per-file floor above.
const WEIGHTED_EXCLUDE = new Set(['lib/client.js'])

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
    let file = ''
    if (url.startsWith('file://')) {
      // fileURLToPath, not string surgery: on Windows the URL pathname is
      // `/C:/…`, which is not a readable path — the first version of this script
      // silently skipped every file because of exactly that.
      try { file = fileURLToPath(url.replace(/\?.*$/, '')) } catch { continue }
    } else if (/^lib[\\/][^?]+\.(js|cjs|mjs)$/.test(url)) {
      // vm { filename } / `new Function` + sourceURL surface as a bare
      // repo-relative name (this is how lib/client.js becomes measurable).
      file = path.join(repo, url)
    } else continue
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
const weightedRows = measurable.filter((r) => !WEIGHTED_EXCLUDE.has(r.file.replace(/\\/g, '/')))
const totalBytes = weightedRows.reduce((n, r) => n + r.size, 0)
const weighted = weightedRows.reduce((n, r) => n + (r.lines * r.size), 0) / (totalBytes || 1)

console.log(`\nUnion coverage over ${measurable.length} lib/*.js files (suite ran in ${seconds}s)\n`)
console.log('file'.padEnd(28) + 'lines'.padStart(8) + 'funcs'.padStart(8))
for (const r of rows) {
  console.log(r.file.padEnd(28) + r.lines.toFixed(1).padStart(7) + '%' + r.functions.toFixed(1).padStart(7) + '%')
}
console.log(`\nweighted line coverage: ${weighted.toFixed(1)}%${WEIGHTED_EXCLUDE.size ? ` (excluding ${[...WEIGHTED_EXCLUDE].join(', ')} — watched by its own floor)` : ''}`)
if (FILE_FLOORS.size) {
  console.log('documented per-file exceptions: ' + [...FILE_FLOORS.entries()].map(([f, v]) => `${f} ≥ ${v}%`).join(', '))
}

if (gate !== null) {
  if (weighted < gate) {
    console.error(`\n✖ coverage gate: ${weighted.toFixed(1)}% < ${gate}%`)
    process.exit(1)
  }
  console.log(`\n✔ coverage gate: ${weighted.toFixed(1)}% >= ${gate}%`)
}

if (fileGate !== null) {
  const breaches = []
  for (const r of measurable) {
    const floor = FILE_FLOORS.get(r.file.replace(/\\/g, '/')) ?? fileGate
    if (r.lines < floor - 1e-9) breaches.push(`${r.file}: ${r.lines.toFixed(1)}% < floor ${floor}%`)
  }
  // A gate that never tells you to remove exceptions rots: once a file climbs
  // above the global gate its allowance is dead weight and must go.
  for (const [f] of FILE_FLOORS) {
    const row = measurable.find((r) => r.file.replace(/\\/g, '/') === f)
    if (row && row.lines >= fileGate) {
      console.log(`note: ${f} measures ${row.lines.toFixed(1)}% ≥ ${fileGate}% — its FILE_FLOORS exception is stale, delete it`)
    }
  }
  if (breaches.length) {
    console.error(`\n✖ per-file coverage floor breached:\n  ${breaches.join('\n  ')}`)
    process.exit(1)
  }
  console.log(`\n✔ per-file coverage floor: every file ≥ its floor (global ${fileGate}%, ${FILE_FLOORS.size} documented exception(s))`)
}
