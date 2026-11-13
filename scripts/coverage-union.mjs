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
const FILE_FLOORS = new Map()

// (There used to be a WEIGHTED_EXCLUDE keeping client.js out of the weighted
// average: at ~50% it would have anchored the host-side signal. The
// verdict-level merge fixed the undercount — client.js now measures 71.7%
// deterministically, above the global floor, so the weighted metric is one
// honest number over ALL of lib/.)

const covDir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-cov-'))
const started = Date.now()
const run = spawnSync(
  process.execPath,
  // NO --test-force-exit here (npm test keeps it): force-exit cuts whatever
  // fire-and-forget promise chains are pending when a file's last test
  // completes, and the cut point is wall-clock dependent — that was the
  // client.js statement-coverage wobble (42.7…55.1% on identical code).
  // Serial + natural exit makes every chain land identically every run; the
  // 40s per-test timeout is still the watchdog against a genuinely hung file.
  ['--import', './test/setup-telemetry-off.mjs', '--import', './test/setup-coverage.mjs', '--test', '--test-timeout=40000', '--test-concurrency=1'],
  { cwd: repo, env: { ...process.env, NODE_V8_COVERAGE: covDir }, stdio: 'pipe', encoding: 'utf8', timeout: 600000 },
)
const seconds = ((Date.now() - started) / 1000).toFixed(0)
if (run.status !== 0) {
  console.error('the test suite failed — fix it before reading coverage:')
  console.error((run.stdout || '').split('\n').filter((l) => /^✖|^ℹ (tests|pass|fail)/.test(l)).join('\n'))
  rmSync(covDir, { recursive: true, force: true })
  process.exit(run.status || 1)
}

/** Union of covered offsets per source file (query string stripped).
 *  Ranges stay grouped PER EVALUATION INSTANCE: mixing all instances' ranges
 *  into one pool and then applying "innermost wins" lets one instance's small
 *  uncovered range outrank another instance's bigger covered range at the same
 *  offset — a merge artifact that made client.js line coverage wobble
 *  (42.7…55.1% on identical code) while the plainly-unioned function coverage
 *  stayed pinned at 44.2%. The union over instances happens at the VERDICT
 *  level below: a line is covered if ANY instance covers it at ITS innermost
 *  level. */
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
    if (!sources.has(file)) sources.set(file, { instances: [], functions: new Map() })
    const entry = sources.get(file)
    const instance = new Map() // "start:end" → covered?
    for (const fn of script.functions || []) {
      for (const range of fn.ranges || []) {
        // Within ONE instance the same range can repeat (cache-busted re-entry
        // into the module): union, so a copy that ran beats one that didn't.
        const key = range.startOffset + ':' + range.endOffset
        instance.set(key, (instance.get(key) || 0) || (range.count > 0 ? 1 : 0))
      }
      const key = `${fn.functionName || '(anonymous)'}@${fn.ranges && fn.ranges[0] ? fn.ranges[0].startOffset : 0}`
      const prev = entry.functions.get(key)
      entry.functions.set(key, !!prev || (fn.ranges || []).some((r) => r.count > 0))
    }
    entry.instances.push(instance)
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

/** Verdict-level union: covered if ANY evaluation instance covers it at its
 *  own innermost range (see the big comment at the collection site). */
function coveredByAnyInstance(instances, offset) {
  for (const inst of instances) {
    if (coveredAt(inst, offset)) return true
  }
  return false
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
      if (coveredByAnyInstance(entry.instances, offset + firstNonSpace)) hit += 1
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
