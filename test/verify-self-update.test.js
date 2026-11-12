// Offline unit tests for the release gate's audit logic
// (scripts/verify-self-update.mjs). The end-to-end rehearsal needs the network
// (it installs the previous release from npm), but the VERDICTS must be pinned
// offline — especially the negative ones. A gate that can only ever say PASS
// would be worse than no gate (it would pretend coverage).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { auditAppliedTree, relativeRefs } from '../scripts/verify-self-update.mjs'

/** Two synthetic trees: what the candidate ships vs what the install ended up with. */
function makeTrees(candidateFiles, installedFiles) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-gate-audit-'))
  const cand = path.join(dir, 'candidate')
  const inst = path.join(dir, 'install')
  for (const [base, files] of [[cand, candidateFiles], [inst, installedFiles]]) {
    for (const [rel, content] of Object.entries(files)) {
      const dest = path.join(base, rel)
      mkdirSync(path.dirname(dest), { recursive: true })
      writeFileSync(dest, content)
    }
  }
  return { dir, cand, inst }
}

const SHIPPED = ['lib/index.js', 'lib/util.js', 'lib/tui/scene.js', 'package.json']

const GOOD_CANDIDATE = {
  'lib/index.js': "export { util } from './util.js'\nexport { scene } from './tui/scene.js'\n",
  'lib/util.js': 'export const util = 1\n',
  'lib/tui/scene.js': "import { util } from '../util.js'\nexport const scene = 2\n",
  'package.json': '{"name":"dsh-remote","version":"9.9.9"}',
}

test('clean application: no findings', () => {
  const { dir, cand, inst } = makeTrees(GOOD_CANDIDATE, GOOD_CANDIDATE)
  assert.deepEqual(auditAppliedTree(cand, inst, SHIPPED), { missing: [], mismatched: [], unresolved: [] })
  rmSync(dir, { recursive: true, force: true })
})

test('#126 signature: files the old updater never installed are flagged missing', () => {
  const halfApplied = { ...GOOD_CANDIDATE }
  delete halfApplied['lib/tui/scene.js']
  const { dir, cand, inst } = makeTrees(GOOD_CANDIDATE, halfApplied)
  const r = auditAppliedTree(cand, inst, SHIPPED)
  assert.deepEqual(r.missing, ['lib/tui/scene.js'])
  // …and the dangling reference from index.js shows up in the SAME verdict
  assert.ok(r.unresolved.some((u) => u.includes("./tui/scene.js")), 'index.js -> ./tui/scene.js must be reported')
  rmSync(dir, { recursive: true, force: true })
})

test('materially different content is flagged (but CRLF-vs-LF is not material)', () => {
  const tampered = { ...GOOD_CANDIDATE, 'lib/util.js': 'export const util = 999\n' }
  const crlfOnly = { ...GOOD_CANDIDATE, 'lib/index.js': GOOD_CANDIDATE['lib/index.js'].replace(/\n/g, '\r\n') }
  const a = makeTrees(GOOD_CANDIDATE, tampered)
  assert.deepEqual(auditAppliedTree(a.cand, a.inst, SHIPPED).mismatched, ['lib/util.js'])
  rmSync(a.dir, { recursive: true, force: true })
  const b = makeTrees(GOOD_CANDIDATE, crlfOnly)
  assert.deepEqual(auditAppliedTree(b.cand, b.inst, SHIPPED).mismatched, [], 'line-ending noise must not trip the gate')
  rmSync(b.dir, { recursive: true, force: true })
})

test('relativeRefs picks up static, dynamic and require forms', () => {
  const src = [
    "import a from './a.js'",
    "export { b } from \"./b.cjs\"",
    "const c = await import('./c.mjs')",
    "const d = require('./d.js')",
    "import 'external-pkg'",
    "const e = import('@scope/pkg/lib/x.js')",
  ].join('\n')
  assert.deepEqual(relativeRefs(src).sort(), ['./a.js', './b.cjs', './c.mjs', './d.js'])
})
