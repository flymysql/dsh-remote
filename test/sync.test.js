import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, utimesSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncTree, pushTree, loadSyncState, saveSyncState, pushOneFile } from '../lib/sync.js'
import { MemFs, makeSftp, seed } from './helpers.js'

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'dsh-sync-'))
}

const noIgnore = () => false

test('first sync downloads everything and writes a state snapshot', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/README.md': '# hi', 'proj/src/main.ts': 'export const a = 1', 'proj/src/deep/x.ts': 'x' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {} })
  assert.equal(r.stats.files, 3)
  assert.equal(r.stats.conflicts.length, 0)
  assert.equal(readFileSync(path.join(local, 'src', 'main.ts'), 'utf8'), 'export const a = 1')
  assert.equal(r.nextState['README.md'].size, 4)
  // Second run: everything unchanged → skipped.
  const r2 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r.nextState })
  assert.equal(r2.stats.skippedUnchanged, 3)
  assert.equal(r2.stats.files, 0)
  rmSync(local, { recursive: true, force: true })
})

test('remote change is pulled; local-only change becomes a conflict', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'v1' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r1 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {} })
  assert.equal(r1.stats.files, 1)

  // Remote changed → pull it.
  fs.writeFileSync('/proj/a.txt', 'v2-remote')
  const r2 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r1.nextState })
  assert.equal(r2.stats.files, 1)
  assert.equal(readFileSync(path.join(local, 'a.txt'), 'utf8'), 'v2-remote')

  // Local changed after sync, remote untouched → conflict (would clobber local).
  writeFileSync(path.join(local, 'a.txt'), 'v3-local')
  const r3 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r2.nextState })
  assert.equal(r3.stats.files, 0)
  assert.equal(r3.stats.conflicts.length, 1)
  assert.match(r3.stats.conflicts[0].reason, /local-modified/)
  assert.equal(readFileSync(path.join(local, 'a.txt'), 'utf8'), 'v3-local') // untouched
  // force=true downgrades the conflict to a plain download.
  const r4 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r2.nextState, force: true })
  assert.equal(r4.stats.files, 1)
  assert.equal(readFileSync(path.join(local, 'a.txt'), 'utf8'), 'v2-remote')
  rmSync(local, { recursive: true, force: true })
})

test('both-modified is a hard conflict, never silently overwritten', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'base' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r1 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {} })
  // Both sides change.
  fs.writeFileSync('/proj/a.txt', 'remote-edit')
  writeFileSync(path.join(local, 'a.txt'), 'local-edit')
  const r2 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r1.nextState })
  assert.equal(r2.stats.conflicts.length, 1)
  assert.match(r2.stats.conflicts[0].reason, /both-modified/)
  assert.equal(readFileSync(path.join(local, 'a.txt'), 'utf8'), 'local-edit')
  rmSync(local, { recursive: true, force: true })
})

test('ignore rules keep node_modules out of the mirror', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/package.json': '{}', 'proj/node_modules/x/index.js': 'x' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const isIgnored = (rel) => rel === 'node_modules' || rel.startsWith('node_modules/')
  const r = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored, state: {} })
  assert.equal(r.stats.files, 1)
  assert.equal(existsSync(path.join(local, 'node_modules')), false)
  rmSync(local, { recursive: true, force: true })
})

test('dryRun writes nothing locally', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'v1' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {}, dryRun: true })
  assert.equal(r.stats.files, 1)
  assert.equal(existsSync(path.join(local, 'a.txt')), false)
  rmSync(local, { recursive: true, force: true })
})

test('push: local edit uploads; remote edit + local untouched is a conflict', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'base' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r1 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {} })

  // Local edit → push uploads it.
  writeFileSync(path.join(local, 'a.txt'), 'local-new')
  const p1 = await pushTree(sftp, local, '/proj', { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: r1.nextState })
  assert.equal(p1.stats.files, 1)
  assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'local-new')
  // Remote mtime aligned → next pull skips.
  const r2 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: p1.nextState })
  assert.equal(r2.stats.skippedUnchanged, 1)

  // Remote edit after push, local untouched → push conflict (would clobber).
  fs.writeFileSync('/proj/a.txt', 'remote-new')
  const p2 = await pushTree(sftp, local, '/proj', { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: p1.nextState })
  assert.equal(p2.stats.conflicts.length, 1)
  assert.match(p2.stats.conflicts[0].reason, /remote-modified/)
  assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'remote-new') // remote untouched
  rmSync(local, { recursive: true, force: true })
})

test('state file round-trips via load/save', async () => {
  const local = tmpDir()
  saveSyncState(local, { 'a.txt': { size: 3, mtime: 123 } })
  assert.deepEqual(loadSyncState(local), { 'a.txt': { size: 3, mtime: 123 } })
  rmSync(local, { recursive: true, force: true })
})

test('pushOneFile: pushes a local edit, never clobbers a remote change', async () => {
  const fs = new MemFs()
  seed(fs, { 'proj/a.txt': 'base' })
  const sftp = makeSftp(fs)
  const local = tmpDir()
  const r1 = await syncTree(sftp, '/proj', local, { maxFiles: 100, maxFileBytes: 0, isIgnored: noIgnore, state: {} })

  // local edit → pushed
  writeFileSync(path.join(local, 'a.txt'), 'local-new')
  const p1 = await pushOneFile(sftp, local, '/proj', 'a.txt', { state: r1.nextState })
  assert.equal(p1.status, 'pushed')
  assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'local-new')

  // remote edit, local untouched → conflict, remote preserved
  fs.writeFileSync('/proj/a.txt', 'remote-new')
  const p2 = await pushOneFile(sftp, local, '/proj', 'a.txt', { state: p1.state })
  assert.equal(p2.status, 'conflict')
  assert.equal(fs.readFileSync('/proj/a.txt').toString(), 'remote-new')
  rmSync(local, { recursive: true, force: true })
})
