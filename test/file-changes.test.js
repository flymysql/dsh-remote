import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileChange, presentFileChange } from '../lib/file-changes.js'

test('applied edit metadata carries actual surrounding context and all scattered occurrences', () => {
  const before = Array.from({ length: 30 }, (_, i) => i === 2 || i === 25 ? 'old' : 'line ' + i).join('\n')
  const change = fileChange('/project/main.c', 'edit', before, before.replaceAll('old', 'new'))
  assert.equal(change.applied, true); assert.equal(change.additions, 2); assert.equal(change.deletions, 2)
  assert.equal(change.diffs.length, 2); assert.match(change.diffs[0].oldText, /line 1\nold\nline 3/)
  assert.match(change.diffs[1].newText, /line 24\nnew\nline 26/)
  assert.equal(presentFileChange({}, { meta: change }).card, 'diff')
  assert.equal(presentFileChange({}, { meta: change, isError: true }), undefined)
})

test('creation, append and unchanged writes have truthful before/after metadata', () => {
  assert.equal(fileChange('/new', 'write', null, 'hello\n').diffs[0].oldText, null)
  const append = fileChange('/file', 'append', 'before\n', 'before\nafter\n')
  assert.equal(append.additions, 1); assert.equal(append.deletions, 0)
  assert.equal(fileChange('/file', 'write', 'same', 'same').unchanged, true)
  assert.equal(presentFileChange({}, { meta: { diffs: [{ path: '/fake', oldText: null, newText: 'unverified' }] } }), undefined)
})

test('unknown baselines, binary and large changes never fabricate a create diff or unbounded transcript', () => {
  for (const result of [fileChange('/large','write',undefined,'new'),fileChange('/binary','edit','a\0b','c'),fileChange('/large','write','x'.repeat(200000),'new')]) {
    assert.equal(result.truncated,true);assert.deepEqual(result.diffs,[])
    assert.ok(JSON.stringify(result).length<1000)
  }
})

test('line-ending-only writes are changes, not an empty successful diff', () => {
  const change = fileChange('/script', 'write', 'first\r\nsecond\r\n', 'first\nsecond\n')
  assert.equal(change.unchanged, false); assert.ok(change.diffs.length > 0)
  assert.equal(change.additions, 2); assert.equal(change.deletions, 2)
  assert.match(change.diffs[0].oldText, /\r/)
  assert.doesNotMatch(change.diffs[0].newText, /\r/)
})
