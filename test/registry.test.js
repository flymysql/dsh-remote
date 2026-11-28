// Registry semantics for issue #13: "Saved Connections != Active Remote
// Context". A saved machine must never silently become the active remote
// context; `currentId` is an explicit user choice and nothing else.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadMachines, saveMachines, sanitizeMachine, applyMachine, machineId } from '../lib/registry.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'dsh-remote-reg-'))
const file = (dir) => path.join(dir, 'machines.json')
const machine = (id, host) => ({ id, name: host, host, port: 22, username: 'root', password: 'secret', workspace: '/home/root/proj', proxy: { host: 'jump', password: 'pp' } })

test('loadMachines: empty / missing file → { list: [], currentId: null }', () => {
  const d = tmp()
  assert.deepEqual(loadMachines(file(d)), { list: [], currentId: null, explicitNone: false })
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: currentId NEVER falls back to the first saved machine (issue #13)', () => {
  const d = tmp()
  // Old behavior: `currentId || list[0].id` made the first saved machine the
  // active remote context. Saving a machine must stay a pure standby.
  writeFileSync(file(d), JSON.stringify({ list: [machine('a', 'h1'), machine('b', 'h2')] }))
  const { list, currentId, explicitNone } = loadMachines(file(d))
  assert.equal(list.length, 2)
  assert.equal(currentId, null)
  assert.equal(explicitNone, false) // no currentId key at all → not an explicit "none"
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: explicit currentId survives', () => {
  const d = tmp()
  writeFileSync(file(d), JSON.stringify({ list: [machine('a', 'h1'), machine('b', 'h2')], currentId: 'b' }))
  assert.equal(loadMachines(file(d)).currentId, 'b')
  assert.equal(loadMachines(file(d)).explicitNone, false)
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: stale currentId (deleted machine) resolves to null — no auto-promotion of a sibling (issue #13)', () => {
  const d = tmp()
  writeFileSync(file(d), JSON.stringify({ list: [machine('b', 'h2')], currentId: 'a' }))
  const { list, currentId } = loadMachines(file(d))
  assert.equal(list.length, 1)
  assert.equal(currentId, null)
  rmSync(d, { recursive: true, force: true })
})

test('loadMachines: persisted currentId:null is an explicit "active remote = none" (issue #13)', () => {
  const d = tmp()
  // After the user clears the current machine the registry persists
  // `currentId: null`. On restart this MUST stay inert — a config-level default
  // host must not silently reactivate a context the user turned off.
  writeFileSync(file(d), JSON.stringify({ list: [machine('a', 'h1')], currentId: null }))
  const { currentId, explicitNone } = loadMachines(file(d))
  assert.equal(currentId, null)
  assert.equal(explicitNone, true)
  rmSync(d, { recursive: true, force: true })
})

test('saveMachines(…, null) persists an explicit "active remote = none"', () => {
  const d = tmp()
  saveMachines(file(d), [machine('a', 'h1')], null)
  const j = JSON.parse(readFileSync(file(d), 'utf8'))
  assert.equal(j.currentId, null)
  assert.equal(j.list.length, 1)
  rmSync(d, { recursive: true, force: true })
})

test('saveMachines keepCurrentKey:false leaves currentId untouched (add/update must not flip explicitNone)', () => {
  const d = tmp()
  // Registry that has never had a currentId: adding a machine must NOT write
  // `currentId: null` (which would read back as an explicit "none" and block
  // the config-default bootstrap). The key simply stays absent.
  saveMachines(file(d), [machine('a', 'h1')], null, false)
  let j = JSON.parse(readFileSync(file(d), 'utf8'))
  assert.equal('currentId' in j, false)
  assert.equal(loadMachines(file(d)).explicitNone, false)
  // Registry where the user explicitly cleared current: adding another machine
  // must preserve the explicit-none state (still an explicit choice).
  saveMachines(file(d), [machine('a', 'h1')], null, true)
  saveMachines(file(d), [machine('a', 'h1'), machine('b', 'h2')], null, false)
  j = JSON.parse(readFileSync(file(d), 'utf8'))
  assert.equal(j.currentId, null)
  assert.equal(loadMachines(file(d)).explicitNone, true)
  rmSync(d, { recursive: true, force: true })
})

test('sanitizeMachine strips passwords but reports passwordSet', () => {
  const s = sanitizeMachine(machine('a', 'h1'))
  assert.equal(s.password, undefined)
  assert.equal(s.passwordSet, true)
  // proxy password is blanked ('' — matches the pre-existing sanitize contract)
  assert.equal(s.proxy.password, '')
  assert.equal(s.proxy.passwordSet, true)
  assert.equal(s.host, 'h1')
})

test('applyMachine overrides the live config fields', () => {
  const cfg = { host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '', workspace: '', hostKeyMode: '', useAgent: false, keyboardInteractive: false, proxy: undefined }
  applyMachine(cfg, machine('a', 'h1'))
  assert.equal(cfg.host, 'h1')
  assert.equal(cfg.username, 'root')
  assert.equal(cfg.workspace, '/home/root/proj')
  assert.equal(cfg.proxy.host, 'jump')
})

test('applyMachine keeps existing workspace when machine has none', () => {
  const cfg = { host: '', workspace: '/keep' }
  applyMachine(cfg, { host: 'h1', username: 'u', port: 22, password: '' })
  assert.equal(cfg.workspace, '/keep')
})

test('machineId mints unique ids', () => {
  const a = machineId()
  const b = machineId()
  assert.match(a, /^m-/)
  assert.notEqual(a, b)
})

test('saveMachines keeps machines.json user-private (0600) — it can carry passwords (issue #169)', { skip: process.platform === 'win32' ? 'POSIX mode bits do not exist on Windows; the user-private parent dir is the privacy boundary there' : false }, () => {
  const d = tmp()
  try {
    saveMachines(file(d), [machine('a', 'h1')], 'a')
    assert.equal(statSync(file(d)).mode & 0o777, 0o600)
    // Re-saving through the same path must not loosen it.
    saveMachines(file(d), [machine('a', 'h1'), machine('b', 'h2')], 'b')
    assert.equal(statSync(file(d)).mode & 0o777, 0o600)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

// ── registry durability, continuing the #171 machines.json hardening ────────
// #171 (e12b0db — the 0600 test above) keeps the file user-private, but the
// write itself was still a bare writeFileSync() IN PLACE: open+truncate the
// live registry, then write the new bytes. A crash mid-write (power loss,
// kill -9, ENOSPC) left a torn JSON, and loadMachines() then silently returned
// an EMPTY registry — every saved machine vanished with no error, and the next
// save overwrote the only evidence. Two rules close that hole: saves must be
// atomic (temp file + rename in the same directory), and a corrupt file must
// be quarantined aside instead of being read as "no machines".

test('loadMachines quarantines a corrupt machines.json and fails safe — the torn bytes survive (continues #171)', () => {
  const d = tmp()
  try {
    // Exactly what a crash mid-write leaves behind: truncated mid-object.
    const torn = '{"list":[{"id":"m-a","name":"h1","host":"h1","port":22,"user'
    writeFileSync(file(d), torn)
    // Fail-safe empty registry — never a half-parsed machine list.
    assert.deepEqual(loadMachines(file(d)), { list: [], currentId: null, explicitNone: false })
    // The corrupt file must be MOVED ASIDE so a later save cannot erase it.
    assert.equal(existsSync(file(d)), false, 'corrupt machines.json must not stay at the registry path')
    const aside = readdirSync(d).filter((f) => f.startsWith('machines.json.corrupt-'))
    assert.equal(aside.length, 1, 'expected one quarantine file, found: ' + aside.join(', '))
    assert.equal(readFileSync(path.join(d, aside[0]), 'utf8'), torn, 'the quarantine file must keep the ORIGINAL corrupt bytes')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('a corrupt registry recovers: load fails safe, save rebuilds, the torn original survives (continues #171)', () => {
  const d = tmp()
  try {
    saveMachines(file(d), [machine('a', 'h1')], 'a')
    const healthy = loadMachines(file(d))
    assert.equal(healthy.list.length, 1)
    assert.equal(healthy.currentId, 'a')
    assert.deepEqual(readdirSync(d), ['machines.json'], 'a healthy save leaves exactly the registry file')
    // Crash artifact lands; the next boot reads empty and moves it aside…
    writeFileSync(file(d), '{"list":[{"id":"m-a","na')
    assert.deepEqual(loadMachines(file(d)), { list: [], currentId: null, explicitNone: false })
    // …and the next save rebuilds a VALID registry from scratch.
    saveMachines(file(d), [machine('a', 'h1')], 'a')
    const recovered = loadMachines(file(d))
    assert.equal(recovered.list.length, 1)
    assert.equal(recovered.currentId, 'a')
    assert.equal(recovered.explicitNone, false)
    const kept = readdirSync(d).filter((f) => f.startsWith('machines.json.corrupt-'))
    assert.equal(kept.length, 1, 'the recovery save must not erase the quarantined crash evidence')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('a missing machines.json is a fresh install, not corruption — nothing is quarantined', () => {
  const d = tmp()
  try {
    assert.deepEqual(loadMachines(file(d)), { list: [], currentId: null, explicitNone: false })
    assert.deepEqual(readdirSync(d), [], 'no quarantine file may appear for a registry that never existed')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('saveMachines replaces the registry atomically (tmp + rename) and keeps it 0600 — no half-written file, no debris (continues #171)', { skip: process.platform === 'win32' ? 'POSIX mode bits and inode replacement semantics do not exist on Windows; the user-private parent dir is the privacy boundary there' : false }, () => {
  const d = tmp()
  try {
    saveMachines(file(d), [machine('a', 'h1')], 'a')
    const first = statSync(file(d))
    saveMachines(file(d), [machine('a', 'h1'), machine('b', 'h2')], 'b')
    const second = statSync(file(d))
    // The old crash window was open+truncate-then-write on the LIVE file. A
    // rename() swap puts the new bytes at the path in ONE step, so no reader
    // and no crash can ever observe a half-written registry; a different inode
    // proves the file was REPLACED, not truncated and refilled in place.
    assert.notEqual(second.ino, first.ino, 'saveMachines must replace the file (rename), not rewrite it in place')
    // #171's user-private rule survives the new write path.
    assert.equal(second.mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(d), ['machines.json'], 'a completed save must leave no tmp or quarantine files behind')
    const j = JSON.parse(readFileSync(file(d), 'utf8'))
    assert.equal(j.list.length, 2)
    assert.equal(j.currentId, 'b')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
