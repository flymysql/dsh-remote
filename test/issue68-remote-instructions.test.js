// Issue #68 — "remote sessions never see the workspace AGENTS.md".
//
// The core instruction loader walks the LOCAL filesystem (user-global roots +
// projectRoot→cwd ancestors). A remote session's cwd is the mirror directory,
// which stays empty until rw_sync — so the remote repo's AGENTS.md never
// enters the model's context while the same file is injected locally. The fix
// (plugin side, per the issue's two cheap options):
//
//   1. a shallow scan (root + ≤2 levels, AGENTS.md / CLAUDE.md only) feeds an
//      INDEX line in the dsh-remote prompt section — the model learns the
//      files exist and to read them with rw_read_file;
//   2. the found files are mirrored into the local mirror three-way safely,
//      so a root-level AGENTS.md lands exactly where the CORE loader looks —
//      the plugin injects NO full text itself (the issue's "请不要做").
//
// These tests pin the scanner's bounds, the three-way mirror write, the
// negative-caching index, and the offline-machine prompt-section behaviour.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  scanInstructionFiles, syncInstructionsToMirror, formatInstructionIndex,
  extractHeadings, createInstructionIndex, isInstructionName,
} from '../lib/instructions.js'
import { loadSyncState } from '../lib/sync.js'
import { MemFs, makeSftp, seed } from './helpers.js'

const AGENTS = '# 项目约定\n\n## 沟通风格\n\n## 环境\n\n## 交付\n\n正文。\n'

// ── scanner ────────────────────────────────────────────────────────────────

test('scanInstructionFiles finds root + ≤2 levels and skips deeper / junk dirs', async () => {
  const fs = new MemFs()
  seed(fs, {
    'proj/AGENTS.md': AGENTS,
    'proj/docs/CLAUDE.md': '# Docs rules\n',
    'proj/docs/api/AGENTS.md': '# API rules\n',
    // depth 3 — beyond the ≤2-level budget, must NOT be found
    'proj/docs/api/v2/AGENTS.md': '# too deep\n',
    // junk dirs are never entered
    'proj/node_modules/dep/AGENTS.md': '# dep\n',
    'proj/.git/AGENTS.md': '# git\n',
    'proj/.hidden/AGENTS.md': '# hidden\n',
    'proj/README.md': '# not an instruction file\n',
  })
  const files = await scanInstructionFiles(makeSftp(fs), '/proj')
  const rels = files.map((f) => f.rel).sort()
  assert.deepEqual(rels, ['AGENTS.md', 'docs/CLAUDE.md', 'docs/api/AGENTS.md'])
  const root = files.find((f) => f.rel === 'AGENTS.md')
  assert.equal(root.remote, '/proj/AGENTS.md')
  assert.deepEqual(root.headings, ['项目约定', '沟通风格', '环境', '交付'])
  assert.ok(root.content.length > 0)
})

test('scanInstructionFiles is bounded by maxFiles and maxDirs', async () => {
  const fs = new MemFs()
  const tree = {}
  for (let i = 0; i < 10; i++) tree[`proj/d${i}/AGENTS.md`] = `# rules ${i}\n`
  seed(fs, tree)
  const files = await scanInstructionFiles(makeSftp(fs), '/proj', { maxFiles: 3 })
  assert.equal(files.length, 3, 'the file cap must hold even with more matches on disk')
})

test('scanInstructionFiles indexes an oversized file without reading it', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/AGENTS.md': 'x'.repeat(300 * 1024) })
  const files = await scanInstructionFiles(makeSftp(fs), '/proj')
  assert.equal(files.length, 1)
  assert.equal(files[0].content, null, 'no 300KB read for an index line')
  assert.equal(files[0].size, 300 * 1024)
  assert.deepEqual(files[0].headings, [])
})

test('scanInstructionFiles does not follow symlinked directories', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/real/AGENTS.md': '# real\n' })
  const sftp = makeSftp(fs)
  const orig = sftp.readdir
  sftp.readdir = (d) => orig(d).then((list) =>
    d === '/proj'
      ? [...list, { filename: 'loop', attrs: { size: 0, mtime: 1, isDirectory: () => true, isSymbolicLink: () => true } }]
      : list)
  const files = await scanInstructionFiles(sftp, '/proj')
  assert.deepEqual(files.map((f) => f.rel), ['real/AGENTS.md'], 'the symlinked dir must not be entered')
})

test('extractHeadings + isInstructionName', () => {
  assert.deepEqual(extractHeadings('# A\n\ntext\n## B ###\n#### too deep\n### C\n'), ['A', 'B', 'C'])
  assert.equal(isInstructionName('AGENTS.md'), true)
  assert.equal(isInstructionName('claude.MD'), true)
  assert.equal(isInstructionName('AGENTS.txt'), false)
})

// ── three-way mirror write ─────────────────────────────────────────────────

function makeMirror() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-instr-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function scanFrom(tree) {
  const fs = new MemFs()
  seed(fs, tree)
  return scanInstructionFiles(makeSftp(fs), '/proj')
}

test('syncInstructionsToMirror writes files, records state, and is idempotent', async () => {
  const { dir, cleanup } = makeMirror()
  try {
    const files = await scanFrom({ 'proj/AGENTS.md': AGENTS, 'proj/docs/CLAUDE.md': '# Docs\n' })
    const r1 = syncInstructionsToMirror(files, dir)
    assert.deepEqual(r1.written.sort(), ['AGENTS.md', 'docs/CLAUDE.md'])
    assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), AGENTS)
    assert.equal(readFileSync(path.join(dir, 'docs', 'CLAUDE.md'), 'utf8'), '# Docs\n')
    // The sync-state snapshot must know the files, or the next rw_sync would
    // see a phantom "local modified" conflict.
    const st = loadSyncState(dir)
    assert.ok(st['AGENTS.md'], 'state recorded for AGENTS.md')
    assert.ok(st['docs/CLAUDE.md'], 'state recorded for docs/CLAUDE.md')
    // Second run: nothing to do.
    const r2 = syncInstructionsToMirror(files, dir)
    assert.deepEqual(r2.written, [], 'an unchanged scan must not rewrite')
    assert.equal(r2.present.size, 2)
  } finally { cleanup() }
})

test('syncInstructionsToMirror never clobbers a local edit, but pulls a remote change', async () => {
  const { dir, cleanup } = makeMirror()
  try {
    const fs = new MemFs()
    seed(fs, { 'proj/AGENTS.md': '# v1\n' })
    const sftp = makeSftp(fs)
    syncInstructionsToMirror(await scanInstructionFiles(sftp, '/proj'), dir)

    // Local edit, remote untouched → skip (rw_sync will surface the conflict).
    writeFileSync(path.join(dir, 'AGENTS.md'), '# local edit\n')
    const r1 = syncInstructionsToMirror(await scanInstructionFiles(sftp, '/proj'), dir)
    assert.deepEqual(r1.written, [])
    assert.equal(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# local edit\n', 'local edit preserved')

    // Remote change, local untouched → plain pull.
    const fs2 = new MemFs()
    seed(fs2, { 'proj/AGENTS.md': '# v2 remote\n' })
    const { dir: dir2, cleanup: c2 } = makeMirror()
    try {
      const s2 = makeSftp(fs2)
      syncInstructionsToMirror(await scanInstructionFiles(s2, '/proj'), dir2)
      fs2.writeFileSync('/proj/AGENTS.md', '# v3 remote\n')
      const r2 = syncInstructionsToMirror(await scanInstructionFiles(s2, '/proj'), dir2)
      assert.deepEqual(r2.written, ['AGENTS.md'])
      assert.equal(readFileSync(path.join(dir2, 'AGENTS.md'), 'utf8'), '# v3 remote\n')
    } finally { c2() }

    // Unknown local content (no sync state) must not be clobbered either.
    const { dir: dir3, cleanup: c3 } = makeMirror()
    try {
      writeFileSync(path.join(dir3, 'AGENTS.md'), '# pre-existing local file\n')
      const fs3 = new MemFs()
      seed(fs3, { 'proj/AGENTS.md': '# remote\n' })
      const r3 = syncInstructionsToMirror(await scanInstructionFiles(makeSftp(fs3), '/proj'), dir3)
      assert.deepEqual(r3.written, [])
      assert.equal(readFileSync(path.join(dir3, 'AGENTS.md'), 'utf8'), '# pre-existing local file\n')
    } finally { c3() }
  } finally { cleanup() }
})

// ── prompt index ───────────────────────────────────────────────────────────

test('formatInstructionIndex lists paths with headings, not full text', () => {
  const out = formatInstructionIndex([
    { rel: 'AGENTS.md', remote: '/srv/repo/AGENTS.md', size: 20480, headings: ['沟通风格', '环境', '交付'], mirrored: true },
    { rel: 'docs/CLAUDE.md', remote: '/srv/repo/docs/CLAUDE.md', size: 100, headings: [], mirrored: false },
  ])
  assert.match(out, /\/srv\/repo\/AGENTS\.md \(headings: 沟通风格 \/ 环境 \/ 交付\)/)
  assert.match(out, /\/srv\/repo\/docs\/CLAUDE\.md/)
  assert.match(out, /rw_read_file/)
  assert.doesNotMatch(out, /正文/, 'the index must never carry file content')
})

test('createInstructionIndex caches scans, dedups in-flight, negative-caches failures', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/AGENTS.md': AGENTS })
  let sftpCalls = 0
  const pool = {
    sftp: async () => { sftpCalls++; await new Promise((r) => setTimeout(r, 20)); return makeSftp(fs) },
  }
  const { dir, cleanup } = makeMirror()
  try {
    const index = createInstructionIndex()
    // Concurrent refreshes share ONE scan.
    const [a, b] = await Promise.all([
      index.refresh({ pool, ws: '/proj', mirrorDir: dir }),
      index.refresh({ pool, ws: '/proj', mirrorDir: dir }),
    ])
    assert.equal(sftpCalls, 1, 'in-flight dedup: two refreshes, one sftp session')
    assert.equal(a.files.length, 1)
    assert.equal(a.files[0].mirrored, true, 'the file was synced into the mirror')
    assert.ok(existsSync(path.join(dir, 'AGENTS.md')))
    assert.equal(a, b, 'same cached entry object')
    // Cached: further refreshes and note() touch nothing.
    await index.refresh({ pool, ws: '/proj', mirrorDir: dir })
    index.note({ pool, ws: '/proj', mirrorDir: dir })
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(sftpCalls, 1)

    // Failure path: an unreachable machine is negative-cached — one failed
    // attempt, then silence (prompt assembly must not become a connect loop).
    let failCalls = 0
    const badPool = { sftp: async () => { failCalls++; throw new Error('unreachable') } }
    const { dir: dir2, cleanup: c2 } = makeMirror()
    try {
      assert.equal(await index.refresh({ pool: badPool, ws: '/proj', mirrorDir: dir2 }), null)
      assert.equal(await index.refresh({ pool: badPool, ws: '/proj', mirrorDir: dir2 }), null)
      index.note({ pool: badPool, ws: '/proj', mirrorDir: dir2 })
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(failCalls, 1, 'the failure is cached — no retry storm')
      assert.equal(index.get(dir2), null)
    } finally { c2() }
  } finally { cleanup() }
})

// ── prompt-section wiring (offline machine: must stay quiet, never hang) ───

function makeHomeWithMirror() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-instr68-'))
  const root = path.join(home, 'remote-workspaces')
  const mirrorDir = path.join(root, '127.0.0.11-lucas-1', 'proj')
  mkdirSync(mirrorDir, { recursive: true })
  writeFileSync(path.join(mirrorDir, '.dsh-remote-meta.json'), JSON.stringify({
    host: '127.0.0.11', port: 1, username: 'lucas', remotePath: '/proj', createdAt: '2026-01-01T00:00:00Z',
  }))
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({
    list: [{ id: 'm1', name: 'one', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw1' }],
    currentId: 'm1',
  }))
  return { home, mirrorDir, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

const CONFIG68 = {
  host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw1', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 800, connectTimeoutMs: 600,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

test('the prompt section survives an offline machine and simply omits the index', async () => {
  const { home, mirrorDir, cleanup } = makeHomeWithMirror()
  process.env.DSH_HOME = home
  try {
    const mod = await import(`../lib/index.js?issue68=${Math.random()}`)
    const sections = []
    const ctx = {
      effect: () => {},
      inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
      get: (k) => (k === 'webServer' ? { register: () => () => {} } : undefined),
      tools: { register: () => {} },
      systemPrompt: { section: (s) => sections.push(s) },
    }
    await mod.apply(ctx, { ...CONFIG68 })
    const section = sections.find((s) => s.name === 'dsh-remote')
    assert.ok(section, 'the dsh-remote section must be registered')
    const agent = { session: { header: { cwd: mirrorDir } } }
    const t0 = Date.now()
    const text1 = section.text({ agent })
    assert.ok(Date.now() - t0 < 500, 'assembly must not block on the SSH probe')
    assert.match(text1, /## Remote workspace/)
    assert.match(text1, /lucas@127\.0\.0\.11/)
    assert.ok(text1.includes(mirrorDir), 'prompt section should name the local mirror directory so the model recognizes its cwd')
    assert.match(text1, /rw_download/, 'prompt section should mention rw_download for fetching individual remote files')
    assert.doesNotMatch(text1, /Remote instruction files/, 'no index while the scan has not completed')
    // Give the (failing) background scan a moment, then re-assemble: still no
    // index, and the negative cache keeps it fast and quiet.
    await new Promise((r) => setTimeout(r, 400))
    const t1 = Date.now()
    const text2 = section.text({ agent })
    assert.ok(Date.now() - t1 < 200, 'the negative-cached failure must not retry per assembly')
    assert.doesNotMatch(text2, /Remote instruction files/)
  } finally {
    delete process.env.DSH_HOME
    cleanup()
  }
})
