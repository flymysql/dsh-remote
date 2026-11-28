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

test('a trailing-slash rule matches directories only (isDir is honored)', () => {
  // Regression: the header promised "a trailing `/` matches directories only"
  // but the matcher never read its isDir argument, so a plain FILE named
  // `build` — or dist/target/venv/node_modules, any of the 12 directory-only
  // names in DEFAULT_IGNORE — was silently excluded from mirror sync and the
  // rw_search fallback walk even though the rule was written for directories.
  // Continues the ignore-contract line of issue #60 (commit 29584ab), which
  // taught rw_search to pass root-relative paths to this same matcher: every
  // caller already passes a real isDir (sync.js/search.js from readdir attrs;
  // pushOneFile passes false because the entry is a file being written) — the
  // matcher must finally honor it.
  const isIgnored = compileIgnore(['build/'])
  assert.equal(isIgnored('build', true), true) // the directory itself
  assert.equal(isIgnored('build', false), false) // a plain FILE named build syncs through
  assert.equal(isIgnored('build'), false) // isDir unknown → not ignored either
  // Nested paths behave the same at any depth.
  assert.equal(isIgnored('sub/build', true), true)
  assert.equal(isIgnored('sub/build', false), false)
  // ... and everything UNDER an ignored directory stays ignored even when the
  // entry itself is a file — root-workspace.test.js pins this for `proc/1/mem`.
  assert.equal(isIgnored('build/app.js', false), true)
  assert.equal(isIgnored('sub/build/app.js', false), true)
  // Anchored dir-only rules behave identically.
  const anchored = compileIgnore(['/out/'])
  assert.equal(anchored('out', true), true)
  assert.equal(anchored('out', false), false)
  assert.equal(anchored('out/x.js', false), true)
  assert.equal(anchored('a/out', true), false)
  // Rules without a trailing slash keep matching both files and directories.
  const both = compileIgnore(['vendor'])
  assert.equal(both('vendor', true), true)
  assert.equal(both('vendor', false), true)
  // Every default directory-only name: the directory is ignored, a
  // same-named plain file is not.
  const defaults = compileIgnore(DEFAULT_IGNORE)
  const dirOnlyNames = DEFAULT_IGNORE.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1))
  assert.equal(dirOnlyNames.length, 12)
  for (const name of dirOnlyNames) {
    assert.equal(defaults(name, true), true, `a directory named ${name} is ignored`)
    assert.equal(defaults(name, false), false, `a plain file named ${name} must sync through`)
  }
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
