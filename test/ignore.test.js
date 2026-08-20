import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileIgnore, DEFAULT_IGNORE, loadIgnore } from '../lib/ignore.js'

test('defaults ignore common build/vcs dirs', () => {
  const isIgnored = compileIgnore(DEFAULT_IGNORE)
  assert.equal(isIgnored('node_modules', true), true)
  assert.equal(isIgnored('src/node_modules', true), true)
  assert.equal(isIgnored('.git', true), true)
  assert.equal(isIgnored('target', true), true)
  assert.equal(isIgnored('build', true), true)
  assert.equal(isIgnored('src/main.ts', false), false)
  assert.equal(isIgnored('app.log', false), true)
  assert.equal(isIgnored('dist', true), true)
})

test('basename patterns match at any depth; dir patterns cover children', () => {
  const isIgnored = compileIgnore(['vendor/'])
  assert.equal(isIgnored('vendor', true), true)
  assert.equal(isIgnored('a/b/vendor', true), true)
  assert.equal(isIgnored('a/vendor/x/y', true), true) // child of ignored dir
  assert.equal(isIgnored('vendor/x', true), true)
  assert.equal(isIgnored('src/main.ts', false), false)
})

test('anchored patterns only match at the root', () => {
  const isIgnored = compileIgnore(['/build/'])
  assert.equal(isIgnored('build', true), true)
  assert.equal(isIgnored('a/build', true), false)
})

test('glob * ? ** semantics', () => {
  const isIgnored = compileIgnore(['*.tmp'])
  assert.equal(isIgnored('x.tmp', false), true)
  assert.equal(isIgnored('a/b/x.tmp', false), true)
  assert.equal(isIgnored('x.txt', false), false)

  const deep = compileIgnore(['**/node_modules/'])
  assert.equal(deep('node_modules', true), true)
  assert.equal(deep('a/node_modules', true), true)
  assert.equal(deep('a/b/node_modules', true), true)
})

test('comments and blank lines are skipped', () => {
  const isIgnored = compileIgnore(['# comment', '', '*.log'])
  assert.equal(isIgnored('x.log', false), true)
  assert.equal(isIgnored('x.txt', false), false)
})

test('file patterns do not match directories of the same name', () => {
  const isIgnored = compileIgnore(['*.o'])
  assert.equal(isIgnored('foo.o', false), true)
  // dir-only matching for trailing-slash rules is checked above
})

test('loadIgnore merges defaults with a user file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ignore-'))
  writeFileSync(path.join(dir, '.dsh-remote-ignore'), '# custom\nsecret/\n*.secret', 'utf8')
  const { patterns, fromFile, matcher } = loadIgnore(path.join(dir, '.dsh-remote-ignore'))
  assert.deepEqual(fromFile, ['secret/', '*.secret'])
  assert.equal(patterns.length > DEFAULT_IGNORE.length, true)
  assert.equal(matcher('secret', true), true)
  assert.equal(matcher('x.secret', false), true)
  assert.equal(matcher('node_modules', true), true) // defaults still merged
  // No user file → defaults only.
  const plain = loadIgnore(null)
  assert.equal(plain.matcher('node_modules', true), true)
})
