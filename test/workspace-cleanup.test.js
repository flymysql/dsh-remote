// lib/workspace-cleanup.js — path rules + deletion guards for the TUI's
// "彻底删除工作区 / 只删除对话" actions.
//
// The encoders are copies of DSH's own layout (`dsh-session-persistence-jsonl`:
// `projectKey()` / `encodeSegment()`), and these tests pin the exact strings on
// disk so a future layout change shows up here instead of silently deleting
// nothing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  MIRROR_META_FILE,
  decodeSegment,
  deleteMirrorTree,
  deleteSessionsFor,
  dirSizeBytes,
  encodeSegment,
  isUnder,
  listMirrorEntries,
  listSessionDirs,
  projectKey,
  readMirrorMeta,
  validateMirror,
} from '../lib/workspace-cleanup.js'

function tempHome() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-remote-cleanup-'))
}

function seedMirror(root, { host = '10.0.0.9', user = 'root', port = 22, name = 'proj', remotePath = '/srv/proj', bytes = 'hello' } = {}) {
  const dir = path.join(root, 'remote-workspaces', `${host}-${user}-${port}`, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, MIRROR_META_FILE), JSON.stringify({ host, port, username: user, remotePath }))
  if (bytes) writeFileSync(path.join(dir, 'file.txt'), bytes)
  return dir
}

// ── encoders (must match DSH's session layout) ─────────────────────────────

test('projectKey matches the directories DSH actually writes', () => {
  assert.equal(projectKey('/Users/dev/Documents/dsh'), '--Users-dev-Documents-dsh--')
  // Non-ASCII is escaped per UTF-16 code unit, uppercase hex, at least 4 digits.
  assert.equal(projectKey('/Users/dev/Documents/科研方法概论'),
    '--Users-dev-Documents-~79D1~7814~65B9~6CD5~6982~8BBA--')
  // Windows drive paths: both separators collapse into one dash.
  assert.equal(projectKey('C:\\Users\\dev\\proj'), '--C-Users-dev-proj--')
  // A leading separator is stripped so the key always starts with `--`.
  assert.equal(projectKey('/'), '--root--')
})

test('encodeSegment round-trips ids (including `~` and problematic units)', () => {
  for (const id of ['session-9e3c1f6b-ef3d-4a52-8ce3-ceeb9a7e582c', 'plain', 'a b', 'x~y', '../etc']) {
    const encoded = encodeSegment(id)
    assert.equal(encoded.includes('/'), false, `${id} must stay one path segment`)
    assert.equal(decodeSegment(encoded), id, `${id} must decode back`)
  }
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.throws(() => encodeSegment(''))
})

test('isUnder is separator-aware', () => {
  assert.equal(isUnder('/a/b', '/a/b/c'), true)
  assert.equal(isUnder('/a/b', '/a/b'), false)
  assert.equal(isUnder('/a/b', '/a/bc'), false)
  assert.equal(isUnder('/a/b', '/a/b/../c'), false)
})

// ── mirror validation / discovery ─────────────────────────────────────────

test('validateMirror accepts exactly a host/name mirror with a readable meta', () => {
  const home = tempHome()
  try {
    const root = path.join(home, 'remote-workspaces')
    const mirror = seedMirror(home)
    const result = validateMirror({ mirrorRoot: root, localMirror: mirror })
    assert.equal(result.real, realpathSync(mirror))
    assert.equal(result.meta.remotePath, '/srv/proj')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('validateMirror refuses foreign paths, wrong depth and missing meta', () => {
  const home = tempHome()
  try {
    const root = path.join(home, 'remote-workspaces')
    const mirror = seedMirror(home)
    const outside = path.join(home, 'elsewhere')
    mkdirSync(outside, { recursive: true })
    const deep = path.join(root, 'host-user-22', 'proj', 'nested')
    mkdirSync(deep, { recursive: true })
    const noMeta = path.join(root, 'host-user-22', 'no-meta')
    mkdirSync(noMeta, { recursive: true })

    for (const candidate of [outside, deep, noMeta, path.join(root, 'host-user-22'), root]) {
      assert.throws(
        () => validateMirror({ mirrorRoot: root, localMirror: candidate }),
        (err) => err.code === 'VALIDATION',
        `${candidate} must be refused`,
      )
    }
    assert.throws(() => validateMirror({ mirrorRoot: root, localMirror: 'relative/dir' }), (err) => err.code === 'VALIDATION')
    // The valid mirror still passes after all those refusals.
    assert.ok(validateMirror({ mirrorRoot: root, localMirror: mirror }).real)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('listMirrorEntries finds only mirrors (host dirs without meta are skipped)', () => {
  const home = tempHome()
  try {
    const root = path.join(home, 'remote-workspaces')
    const mirror = seedMirror(home)
    mkdirSync(path.join(root, 'host-user-22', 'not-a-mirror'), { recursive: true })
    const entries = listMirrorEntries(root)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].localMirror, mirror)
    assert.equal(entries[0].remotePath, '/srv/proj')
    assert.equal(readMirrorMeta(mirror).host, '10.0.0.9')
    assert.equal(readMirrorMeta(path.join(root, 'host-user-22', 'not-a-mirror')), undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('dirSizeBytes sums files and reports truncation at the cap', () => {
  const home = tempHome()
  try {
    const dir = path.join(home, 'tree')
    mkdirSync(path.join(dir, 'sub'), { recursive: true })
    writeFileSync(path.join(dir, 'a.txt'), 'aaaa')
    writeFileSync(path.join(dir, 'sub', 'b.txt'), 'bb')
    assert.equal(dirSizeBytes(dir).bytes, 6)
    const capped = dirSizeBytes(dir, 1)
    assert.equal(capped.truncated, true)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── sessions ──────────────────────────────────────────────────────────────

test('listSessionDirs finds the project directory and decodes session ids', () => {
  const home = tempHome()
  try {
    const cwd = '/mirrors/host-user-22/proj'
    const projectDir = path.join(home, 'sessions', projectKey(cwd))
    mkdirSync(path.join(projectDir, encodeSegment('session-abc')), { recursive: true })
    mkdirSync(path.join(projectDir, encodeSegment('session-xyz')), { recursive: true })
    writeFileSync(path.join(projectDir, 'not-a-dir.txt'), 'x')
    const found = listSessionDirs({ sessionsRoot: path.join(home, 'sessions'), cwd })
    assert.deepEqual(found.map((s) => s.id).sort(), ['session-abc', 'session-xyz'])
    assert.equal(listSessionDirs({ sessionsRoot: path.join(home, 'other'), cwd }).length, 0)
    assert.equal(listSessionDirs({ sessionsRoot: path.join(home, 'sessions'), cwd: '/elsewhere' }).length, 0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('listSessionDirs accepts cwd aliases (symlinked DSH_HOME spelling)', () => {
  const home = tempHome()
  try {
    const sessionsRoot = path.join(home, 'sessions')
    const resolved = '/mirrors/host-user-22/proj'
    const alias = '/private/mirrors/host-user-22/proj'
    mkdirSync(path.join(sessionsRoot, projectKey(resolved), encodeSegment('session-a')), { recursive: true })
    mkdirSync(path.join(sessionsRoot, projectKey(alias), encodeSegment('session-b')), { recursive: true })
    const found = listSessionDirs({ sessionsRoot, cwd: resolved, cwds: [alias] })
    assert.deepEqual(found.map((s) => s.id).sort(), ['session-a', 'session-b'])
    // Deduplication: the same spelling twice must not duplicate rows.
    const twice = listSessionDirs({ sessionsRoot, cwd: resolved, cwds: [resolved] })
    assert.equal(twice.length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('deleteSessionsFor skips live sessions unless forced', async () => {
  const home = tempHome()
  try {
    const cwd = '/mirrors/host-user-22/proj'
    const sessionsRoot = path.join(home, 'sessions')
    const projectDir = path.join(sessionsRoot, projectKey(cwd))
    const liveDir = path.join(projectDir, encodeSegment('session-live'))
    const deadDir = path.join(projectDir, encodeSegment('session-dead'))
    mkdirSync(liveDir, { recursive: true })
    mkdirSync(deadDir, { recursive: true })

    const skipped = await deleteSessionsFor({
      sessionsRoot,
      cwd,
      isLive: (id) => id === 'session-live',
    })
    assert.deepEqual(skipped.removed, ['session-dead'])
    assert.deepEqual(skipped.skippedLive, ['session-live'])
    assert.equal(existsSync(deadDir), false)
    assert.equal(existsSync(liveDir), true)

    const forced = await deleteSessionsFor({
      sessionsRoot,
      cwd,
      isLive: (id) => id === 'session-live',
      force: true,
    })
    assert.deepEqual(forced.removed, ['session-live'])
    assert.equal(existsSync(liveDir), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── mirror deletion ───────────────────────────────────────────────────────

test('deleteMirrorTree removes the mirror and its contents', () => {
  const home = tempHome()
  try {
    const root = path.join(home, 'remote-workspaces')
    const mirror = seedMirror(home)
    assert.equal(deleteMirrorTree({ mirrorRoot: root, localMirror: mirror }), true)
    assert.equal(existsSync(mirror), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('deleteMirrorTree never touches anything outside the mirror root', () => {
  const home = tempHome()
  try {
    const root = path.join(home, 'remote-workspaces')
    mkdirSync(root, { recursive: true })
    const outside = path.join(home, 'keep')
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, 'important.txt'), 'keep me')
    assert.throws(
      () => deleteMirrorTree({ mirrorRoot: root, localMirror: outside }),
      (err) => err.code === 'VALIDATION',
    )
    assert.equal(readFileSync(path.join(outside, 'important.txt'), 'utf8'), 'keep me')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
