// lib/audit.js — the audit domain's pure core, unit-tested directly.
// The end-to-end wiring (config gate, file path, routes) is pinned by
// audit-open-and-no-deploy.test.js; this file pins the formatting and the
// reader's edge cases without mounting a plugin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatAuditLine, readAuditLines } from '../lib/audit.js'

test('formatAuditLine: shape, defaults, flattening, cap', () => {
  const line = formatAuditLine({ op: 'exec', cmd: 'ls -la', code: 0, user: 'root', host: 'h1', port: 22, now: new Date('2026-11-03T00:00:00Z') })
  assert.equal(line, '2026-11-03T00:00:00.000Z | root@h1:22 | exec | 0 | ls -la\n')

  // null code renders '-'; missing identity renders '?@?'
  const bare = formatAuditLine({ op: 'read', cmd: '/x', code: null })
  assert.match(bare, /\| \?@\?:undefined \| read \| - \|/)
})

test('formatAuditLine: multi-line commands flatten and cap at 400 chars', () => {
  const long = ('a\nb\tc  d ' + 'x'.repeat(500))
  const line = formatAuditLine({ op: 'exec', cmd: long, code: 1, user: 'u', host: 'h', port: 1 })
  const body = line.replace(/\n$/, '') // the entry's own trailing newline
  const cmdField = body.split(' | ').at(-1)
  assert.equal(cmdField.includes('\n'), false, 'no embedded newline may survive (one line per entry)')
  assert.equal(cmdField.length, 400)
})

test('readAuditLines: clamps the window and degrades on a missing file', () => {
  const lines = Array.from({ length: 600 }, (_, i) => `line-${i}`)
  const read = () => lines.join('\n') + '\n'
  assert.deepEqual(readAuditLines(read, 'f', 3), ['line-597', 'line-598', 'line-599'])
  assert.equal(readAuditLines(read, 'f', 99999).length, 500, 'hard ceiling 500')
  assert.equal(readAuditLines(read, 'f', 0).length, 50, 'a falsy limit falls back to the 50 default (preserved wire behaviour)')
  assert.deepEqual(readAuditLines(() => { throw new Error('ENOENT') }, 'f', 50), [], 'missing file → empty, never throw')
})
