import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { searchTree, matchGlob, searchViaShell } from '../lib/search.js'
import { DEFAULT_SEARCH_IGNORE } from '../lib/ignore.js'
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

// ── the POSIX fast path: exercise the REAL command, not only a fixture ───────
//
// The fixture above feeds ready-made `path:line:text` rows, so it can never
// notice what the tools actually print. Both defects pinned below were invisible
// to it: rg was handed `-I` (there `--no-filename`, so rg printed bare
// `1:text` rows and every match was dropped), and the search ignore rules
// never reached the command at all.

/** True when the local POSIX shell resolves `name` (the fast path's own probe). */
function hasShellTool(name) {
  return spawnSync('sh', ['-c', 'command -v ' + name + ' >/dev/null 2>&1'], { encoding: 'utf8' }).status === 0
}

/** Execute the generated script for real, shaped like pool.exec's answer. */
function runShell(script, env) {
  const r = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: env ? { ...process.env, ...env } : undefined })
  return { code: r.status, signal: null, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** PATH with every directory holding `tool` removed (to force the grep branch). */
function pathWithout(tool) {
  return String(process.env.PATH || '').split(path.delimiter)
    .filter((dir) => dir && !existsSync(path.join(dir, tool)))
    .join(path.delimiter)
}

/** Materialize a { 'rel/path': 'content' } tree in a fresh temp dir. */
function writeTempTree(tree) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-search-shell-'))
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

test('searchViaShell runs the real rg/grep command and keeps a path on every hit', async (t) => {
  // ★ Regression (fatal): `-I` was passed to BOTH tools. In ripgrep `-I` means
  // --no-filename, so rg printed `1:text`; parseGrepLines needs
  // `path:line:text` and dropped every row. Result: on any POSIX host with
  // ripgrep installed rw_search returned ZERO matches for everything — and it
  // looked like a successful fast-path search, so searchRemote never fell back to
  // the SFTP walk. Only running the real command can catch that.
  if (process.platform === 'win32') return t.skip('POSIX shell fast path only')
  if (!hasShellTool('rg') && !hasShellTool('grep')) return t.skip('neither rg nor grep is installed')

  const root = writeTempTree({
    'src/a.ts': 'const NEEDLE = 2\n',
    'src/b.ts': 'NEEDLE one\nNEEDLE two\n',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pool = { platform: 'posix', exec: async (script) => runShell(script) }
  const r = await searchViaShell(pool, root, { pattern: 'NEEDLE', maxMatches: 50 })

  assert.equal(r.matches.length, 3, 'every hit must keep its file path, got: ' + JSON.stringify(r.matches))
  const paths = [...new Set(r.matches.map((m) => m.path))].sort()
  assert.deepEqual(paths, [path.join(root, 'src/a.ts'), path.join(root, 'src/b.ts')],
    'paths must be the absolute remote paths the tool prints')
  assert.equal(r.scanned, 2, 'scanned counts the DISTINCT files with hits, not the rows')
  const hit = r.matches.find((m) => m.path === path.join(root, 'src/a.ts'))
  assert.equal(hit.line, 1)
  assert.match(hit.text, /NEEDLE/)
})

test('searchViaShell maps the search ignore rules onto per-tool flags', async () => {
  // ★ Regression: the fast path ignored the ignore rules entirely (no
  // DEFAULT_SEARCH_IGNORE, no user .dsh-remote-ignore) while the SFTP walk
  // applied them, so results and cost differed by platform. The patterns must
  // come from the same source the walk uses (lib/ignore.js via lib/main.js).
  let script = ''
  const pool = {
    platform: 'linux',
    exec: async (s) => { script = s; return { code: 1, stdout: '', stderr: '', signal: null } },
  }
  await searchViaShell(pool, '/proj', {
    pattern: 'TODO',
    glob: '*.ts',
    ignorePatterns: DEFAULT_SEARCH_IGNORE.concat(['secret-dir/', '*.snap']),
  })

  const rgSeg = /if command -v rg >\/dev\/null 2>&1; then (.*?); elif /.exec(script)
  const grepSeg = /elif command -v grep >\/dev\/null 2>&1; then (.*?); else /.exec(script)
  assert.ok(rgSeg, 'the rg branch must exist, script was: ' + script)
  assert.ok(grepSeg, 'the grep branch must exist, script was: ' + script)
  const rgCmd = rgSeg[1]
  const grepCmd = grepSeg[1]

  // rg: `--glob=!` excludes, relative to the search root … and NEVER -I.
  assert.doesNotMatch(rgCmd, /(?:^|\s)-I(?=\s|$)/, 'rg must not receive -I: there it means --no-filename')
  assert.match(rgCmd, /--glob='!node_modules\/'/)
  assert.match(rgCmd, /--glob='!\*\.log'/)
  assert.match(rgCmd, /--glob='!\.DS_Store'/)
  assert.match(rgCmd, /--glob='!secret-dir\/'/)
  assert.match(rgCmd, /--glob='!\*\.snap'/)
  assert.match(rgCmd, /--glob='!Library\/Caches\/'/, 'anchored rules go to rg')
  assert.match(rgCmd, /--glob='\*\.ts'/, 'the glob filter still applies')
  assert.match(rgCmd, / -- 'TODO' \.$/, 'the tools run from the search root, so globs anchor there')

  // grep: -I is "skip binary files" and must stay; excludes are basename-only.
  assert.match(grepCmd, /(?:^|\s)-I(?=\s|$)/)
  assert.match(grepCmd, /--exclude-dir='node_modules'/)
  assert.match(grepCmd, /--exclude='\*\.log'/)
  assert.match(grepCmd, /--exclude='\.DS_Store'/)
  assert.match(grepCmd, /--exclude-dir='secret-dir'/)
  assert.match(grepCmd, /--exclude='\*\.snap'/)
  assert.match(grepCmd, /--include='\*\.ts'/)
  // Anchored rules are not expressible in grep (`--exclude*` match BASENAMES); they
  // are passed to rg only — documented in lib/search.js, not pretended parity.
  assert.doesNotMatch(grepCmd, /Library\/Caches/)

  assert.match(script, /^cd '\/proj' \|\| exit 2; /, 'both tools run inside the search root')
})

test('searchViaShell honours the search ignore rules on a real tree', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX shell fast path only')
  if (!hasShellTool('rg') && !hasShellTool('grep')) return t.skip('neither rg nor grep is installed')

  const root = writeTempTree({
    'src/a.ts': 'const NEEDLE = 2\nconst NEEDLE_ALSO = 3\n',
    'node_modules/pkg/x.ts': 'NEEDLE in node_modules\n',
    'logs/a.log': 'NEEDLE in a log\n',
    'cache/secret.txt': 'NEEDLE in the user cache\n',
    'Library/Caches/top.txt': 'NEEDLE in a root-anchored cache\n',
    'sub/Library/Caches/nested.txt': 'NEEDLE in a nested cache\n',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pool = { platform: 'posix', exec: async (script) => runShell(script) }
  const r = await searchViaShell(pool, root, {
    pattern: 'NEEDLE',
    ignorePatterns: ['node_modules/', '*.log', 'cache/', 'Library/Caches/'],
  })

  const files = [...new Set(r.matches.map((m) => m.path))]
  assert.ok(files.includes(path.join(root, 'src/a.ts')), 'real content must still be found, got: ' + JSON.stringify(files))
  assert.ok(!files.some((p) => p.includes('node_modules')), 'node_modules/ must be excluded')
  assert.ok(!files.some((p) => p.endsWith('.log')), '*.log must be excluded')
  assert.ok(!files.some((p) => p.includes('/cache/')), 'cache/ must be excluded')
  assert.ok(files.includes(path.join(root, 'sub/Library/Caches/nested.txt')),
    'an anchored rule must stay root-relative and not swallow nested directories')
  if (hasShellTool('rg')) {
    assert.ok(!files.includes(path.join(root, 'Library/Caches/top.txt')),
      'rg must honour the anchored Library/Caches/ rule (globs are root-relative)')
  }
  assert.equal(r.scanned, files.length, 'scanned counts distinct files with hits, not rows')
  assert.equal(r.matches.length, files.length + 1, 'two hits in one file are two rows but one file')

  // The grep fallback is a different command line, so run it for real too by
  // hiding rg from PATH. grep's --exclude* match BASENAMES only: the anchored
  // Library/Caches/ rule is the documented difference, not an accident.
  const grepOnlyPath = pathWithout('rg')
  const grepReachable = grepOnlyPath && spawnSync('sh', ['-c', 'command -v grep >/dev/null 2>&1'],
    { encoding: 'utf8', env: { ...process.env, PATH: grepOnlyPath } }).status === 0
  if (grepReachable) {
    const grepOnly = { platform: 'posix', exec: async (script) => runShell(script, { PATH: grepOnlyPath }) }
    const g = await searchViaShell(grepOnly, root, {
      pattern: 'NEEDLE',
      ignorePatterns: ['node_modules/', '*.log', 'cache/', 'Library/Caches/'],
    })
    const gFiles = [...new Set(g.matches.map((m) => m.path))]
    assert.ok(gFiles.includes(path.join(root, 'src/a.ts')), 'grep must find real content too, got: ' + JSON.stringify(gFiles))
    assert.ok(!gFiles.some((p) => p.includes('node_modules')), 'grep --exclude-dir must apply')
    assert.ok(!gFiles.some((p) => p.endsWith('.log')), 'grep --exclude must apply')
    assert.ok(gFiles.includes(path.join(root, 'sub/Library/Caches/nested.txt')), 'grep must not lose nested content')
    assert.ok(gFiles.includes(path.join(root, 'Library/Caches/top.txt')),
      'grep cannot express an anchored rule (documented limitation)')
  }
})

test('searchViaShell reports scanned as distinct files with hits', async () => {
  // The shell path cannot know how many files the tool opened, so `scanned` must
  // not be the number of match ROWS (it used to be exactly that).
  const pool = {
    platform: 'linux',
    exec: async () => ({ code: 0, stdout: '/p/a.ts:1:x\n/p/a.ts:9:y\n/p/b.ts:2:z\n', stderr: '', signal: null }),
  }
  const r = await searchViaShell(pool, '/p', { pattern: 'x' })
  assert.equal(r.matches.length, 3)
  assert.equal(r.scanned, 2, 'two rows in a.ts plus one in b.ts = TWO files with hits')
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
