// i18n (issue #14) invariants:
//   • zh and en dictionaries share an identical key set (no missing translation
//     in either direction — the client's fallback chain is active → en → key);
//   • every tr('…') call in lib/client.js references a key that exists in the
//     dictionaries (a typo would silently render the raw key in the UI);
//   • interpolation placeholders {x} in a translation are covered by the keys
//     used with params at the call sites they appear in.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Extract the `const L = { zh: {...}, en: {...} }` object via a sandbox. */
function extractDicts() {
  // The file is a classic module-loader bundle; we only need the L literal.
  // Grab from "const L = {" up to the line that closes the dictionary block
  // (first line matching /^    }$/ after the "en:" section started).
  const start = src.indexOf('const L = {')
  assert.ok(start >= 0, 'dictionary block exists')
  const body = src.slice(start)
  const head = 'const __sandbox = { L: null }; '
  // Find the balanced closing brace: the dict closes at the first
  // "\n      },\n    }" (en dict close + L object close) after the "en: {" line.
  const enStart = body.indexOf('en: {')
  assert.ok(enStart >= 0, 'en dictionary present')
  const closeIdx = body.indexOf('\n      },\n    }', enStart)
  assert.ok(closeIdx >= 0, 'dictionary closing brace found')
  const literal = body.slice(0, closeIdx + '\n      },\n    }'.length)
  const sandbox = { L: null }
  vm.createContext(sandbox)
  vm.runInContext('L = ' + literal.replace(/^const L = /, ''), sandbox)
  return sandbox.L
}

const L = extractDicts()

test('zh and en dictionaries share an identical key set', () => {
  const zhKeys = Object.keys(L.zh).sort()
  const enKeys = Object.keys(L.en).sort()
  assert.deepEqual(enKeys, zhKeys, 'en key set must match zh key set (every key translated)')
})

test('every tr(...) call references a defined dictionary key', () => {
  const missing = new Set()
  for (const m of src.matchAll(/tr\(\s*'([^']+)'/g)) {
    const key = m[1]
    if (!(key in L.zh)) missing.add(key)
  }
  assert.deepEqual([...missing], [], 'all tr() keys must exist in the dictionaries')
})

test('dictionary entries are non-empty strings (no blank translations)', () => {
  const blanks = []
  for (const lang of ['zh', 'en']) {
    for (const [key, val] of Object.entries(L[lang])) {
      if (typeof val !== 'string' || !val.trim()) blanks.push(`${lang}:${key}`)
    }
  }
  assert.deepEqual(blanks, [], 'no empty translation values')
})

test('zh translations carry no untranslated placeholder drift vs en (param sets match)', () => {
  const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  const drift = []
  for (const key of Object.keys(L.zh)) {
    const a = placeholders(L.zh[key]).join(',')
    const b = placeholders(L.en[key]).join(',')
    if (a !== b) drift.push(`${key}: zh{${a}} en{${b}}`)
  }
  assert.deepEqual(drift, [], 'zh and en templates use identical param sets')
})
