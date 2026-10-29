// Coverage-only setup: flush V8 coverage on process exit.
//
// `node --test --test-force-exit` kills the test workers, and a force-killed worker
// never flushes `NODE_V8_COVERAGE` — the directory stays empty and a coverage run
// silently reports nothing. `v8.takeCoverage()` inside an `exit` handler runs even
// on `process.exit()`, so it survives the force-exit.
//
// Loaded only by scripts/coverage-union.mjs (`--import ./test/setup-coverage.mjs`),
// never by `npm test`.
import v8 from 'node:v8'

process.on('exit', () => {
  try { v8.takeCoverage() } catch { /* coverage not enabled — nothing to flush */ }
})
