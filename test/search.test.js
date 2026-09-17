import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchTree, matchGlob, searchViaShell } from '../lib/search.js'
import { MemFs, makeSftp, seed } from './helpers.js'

const noIgnore = () => false

test('matchGlob matches basenames', () => {
  assert.equal(matchGlob('a.ts', '*.ts'), true)
  assert.equal(matchGlob('a.js', '*.ts'), false)
  assert.equal(matchGlob('x', '?'), true)
  assert.equal(matchGlob('xy', '?'), false)
})

test('searchTree finds matches with line numbers', async () => {
  const fs = new MemFs()
  seed(fs, {
    'proj/src/a.ts': 'const x = 1\n// TODO fix me\nconst y = 2',
    'proj/src/b.ts': 'const z = 3\n// TODO later',
    'proj/readme.md': 'no match here',
    'proj/node_modules/lib/c.ts': 'TODO hidden',
  })
  const sftp = makeSftp(fs)
  const { matches, scanned } = await searchTree(sftp, '/proj', {
    regex: /TODO/i,
    maxScanBytes: 1024,
    isIgnored: (name) => name === 'node_modules',
  })
  assert.equal(matches.length, 2)
  assert.equal(matches[0].path, '/proj/src/a.ts')
  assert.equal(matches[0].line, 2)
  assert.match(matches[0].text, /TODO fix me/)
  assert.ok(scanned >= 3)
})

test('searchTree honors ignore + glob + contextLines + caps', async () => {
  const fs = new MemFs()
  seed(fs, {
    'proj/node_modules/x.ts': 'TODO in node_modules',
    'proj/src/a.ts': 'line1\nTODO hit\nline3',
    'proj/src/b.js': 'TODO js',
  })
  const sftp = makeSftp(fs)
  // node_modules ignored via basename.
  const r1 = await searchTree(sftp, '/proj', { regex: /TODO/, isIgnored: (name) => name === 'node_modules', maxScanBytes: 1024 })
  const paths1 = r1.matches.map((m) => m.path)
  assert.ok(!paths1.some((p) => p.includes('node_modules')))

  // glob filters to *.ts only.
  const r2 = await searchTree(sftp, '/proj', { regex: /TODO/, glob: '*.ts', isIgnored: noIgnore, maxScanBytes: 1024 })
  assert.ok(r2.matches.every((m) => m.path.endsWith('.ts')))

  // contextLines returns the neighbours too.
  const r3 = await searchTree(sftp, '/proj/src', { regex: /TODO/, contextLines: 1, isIgnored: noIgnore, maxScanBytes: 1024 })
  const lines = r3.matches.map((m) => m.line)
  assert.ok(lines.includes(2) && (lines.includes(1) || lines.includes(3)))

  // maxMatches caps the output and sets truncated.
  const fs2 = new MemFs()
  const seed2 = {}
  for (let i = 0; i < 10; i++) seed2['proj/f' + i + '.txt'] = 'hit line ' + i
  seed(fs2, seed2)
  const sftp2 = makeSftp(fs2)
  const r4 = await searchTree(sftp2, '/proj', { regex: /hit/, maxMatches: 3, isIgnored: noIgnore, maxScanBytes: 1024 })
  assert.equal(r4.matches.length, 3)
})

test('searchViaShell parses rg/grep -n output and honors maxMatches', async () => {
  const stdout = '/proj/a.ts:2:TODO fix me\n/proj/b.ts:1:TODO later\n/proj/c.ts:4:TODO more\n'
  const pool = {
    platform: 'posix',
    exec: async () => ({ code: 0, stdout, stderr: '', signal: null }),
  }
  const r = await searchViaShell(pool, '/proj', { pattern: 'TODO', maxMatches: 2 })
  assert.equal(r.matches.length, 2)
  assert.equal(r.truncated, true)
  assert.equal(r.matches[0].path, '/proj/a.ts')
  assert.equal(r.matches[0].line, 2)
})

test('searchRemote falls back to SFTP when shell search is unavailable', async () => {
  const { searchRemote } = await import('../lib/search.js')
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'hit me' })
  const sftp = makeSftp(fs)
  const pool = {
    platform: 'posix',
    exec: async () => ({ code: 127, stdout: '', stderr: 'no rg', signal: null }),
    sftp: async () => sftp,
  }
  const r = await searchRemote(pool, '/proj', { regex: /hit/, pattern: 'hit', maxScanBytes: 1024, isIgnored: () => false })
  assert.equal(r.matches.length, 1)
  assert.equal(r.matches[0].path, '/proj/a.txt')
})
