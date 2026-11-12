// Issue #118 — an EPIPE on the OpenSSH backend's stdin killed the whole Host.
//
// The reported crash: a SFTP transfer is interrupted, the `ssh -s sftp` child
// stops reading, the ssh2 SFTP engine keeps writing to its stdin, and Node
// raises EPIPE on the stdin Writable. The write is asynchronous, so the
// synchronous try/catch around `child.stdin.write()` never sees it; with no
// 'error' listener registered the error is an uncaught exception, and the
// desktop Host treats that as fatal:
//
//   dsh: fatal uncaught exception: Error: write EPIPE
//       at Object.channelData (.../lib/openssh.js:748:52)
//
// Pins, in increasing order of realism:
//   1. guardChildStdin() gives a child's stdin an 'error' listener, so an EPIPE
//      is reported instead of re-thrown; the hook it takes runs exactly once.
//   2. the REAL failure shape — a child whose stdin reader is gone, written to
//      through the public export — does not reach 'uncaughtException'.
//   3. the SFTP wiring itself registers the guard: the fakeClient seam the
//      engine writes through has a listener on the spawned child's stdin, which
//      is the difference between the reported crash and a dropped session.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { guardChildStdin } from '../lib/openssh.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** A child whose stdin reader is already gone: writing to it EPIPEs. */
function childWithClosedStdin() {
  // `exec 0<&-` closes fd 0, so the pipe's read end disappears while the
  // process lives on — exactly the state an interrupted sftp subsystem leaves.
  return spawn('/bin/sh', ['-c', 'exec 0<&-; sleep 2'], { stdio: ['pipe', 'pipe', 'pipe'] })
}

/** Collect every 'uncaughtException'/'unhandledRejection' that fires. */
function trapUncaught() {
  const seen = []
  const onUncaught = (err) => seen.push(err)
  process.on('uncaughtException', onUncaught)
  return {
    seen,
    stop() { process.removeListener('uncaughtException', onUncaught) },
  }
}

// ── 1. the guard itself ─────────────────────────────────────────────────────

test('#118: guardChildStdin() installs an error listener and returns the child', () => {
  const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: ['pipe', 'pipe', 'pipe'] })
  assert.equal(child.stdin.listenerCount('error'), 0, 'plain spawn starts with no stdin error listener')

  const calls = []
  const guarded = guardChildStdin(child, (err) => calls.push(err))

  assert.equal(guarded, child, 'the same child is returned, so call sites can chain')
  assert.equal(child.stdin.listenerCount('error'), 1, 'the guard owns exactly one stdin error listener')

  // A stream with a listener reports the problem (no throw) and the hook runs.
  const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  child.stdin.emit('error', err)
  assert.equal(calls.length, 1, 'the cleanup hook runs once per pipe error')
  assert.equal(calls[0], err, 'the hook receives the original error')
})

test('#118: guardChildStdin() tolerates a child without a stdin stream', () => {
  // `spawn` with 'ignore' yields child.stdin === null; the guard must be a
  // no-op rather than a crash on a path that never writes.
  const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: ['ignore', 'ignore', 'ignore'] })
  assert.equal(child.stdin, null)
  assert.equal(guardChildStdin(child), child)
})

// ── 2. the real failure shape ───────────────────────────────────────────────

test('#118: an EPIPE from a dead stdin pipe does not become an uncaught exception', async () => {
  const uncaught = trapUncaught()
  let survivor = null
  try {
    survivor = guardChildStdin(childWithClosedStdin(), () => {})
    // Let the pipe's read end actually disappear before writing into it.
    await new Promise((r) => setTimeout(r, 250))
    // This is the exact call the SFTP engine makes through its protocol seam.
    survivor.stdin.write(Buffer.alloc(256 * 1024))
    // EPIPE is delivered on the next turn(s) of the event loop, not synchronously.
    await new Promise((r) => setTimeout(r, 300))
  } finally {
    uncaught.stop()
    try { survivor && survivor.kill() } catch { /* already gone */ }
  }

  assert.deepEqual(uncaught.seen, [],
    'a broken stdin pipe must be reported on the stream, never re-thrown to the process')
})

// ── 3. the wiring: the SFTP seam must register the guard ────────────────────

test('#118: the SFTP channel registers the stdin guard on the spawned child', () => {
  // The engine talks to the pipe through fakeClient._protocol.channelData, which
  // closes over the child spawned by _openSftpChannel(). Asserting the source of
  // that seam is the cheapest honest check that the guard is on the path that
  // actually crashed: a live end-to-end reproduction needs a real ssh server that
  // drops its sftp subsystem mid-transfer (see scripts/integration-openssh-large.mjs).
  const src = readFileSync(path.join(here, '..', 'lib', 'openssh.js'), 'utf8')
  const channelData = src.match(/channelData\(_id, data\)[^\n]*\n/)
  assert.ok(channelData, 'the SFTP protocol seam still writes to the child stdin')

  // Both writers (channelData and channelClose) live in that one object literal;
  // the guard must be registered before the engine is constructed, so no write
  // can happen without a listener.
  const guardAt = src.indexOf('guardChildStdin(child,')
  const sftpAt = src.indexOf('const sftp = new Sftp(fakeClient, chanInfo, {})')
  assert.ok(guardAt > -1, 'the SFTP path registers guardChildStdin')
  assert.ok(sftpAt > guardAt, 'the guard is registered BEFORE the engine that writes through it')

  // No spawn in this file may be left unguarded: every write target is one of
  // the three children below, and each must have the hook.
  const spawns = src.match(/child = spawn\(|const child = spawn\(/g) || []
  // Calls only — the `export function guardChildStdin` definition also matches
  // the bare name, hence the lookbehind.
  const guards = src.match(/(?<!function )guardChildStdin\(child/g) || []
  assert.ok(spawns.length > 0, 'the ssh children are still spawned through these two shapes')
  assert.equal(guards.length, spawns.length,
    `every spawned ssh child must be guarded (found ${spawns.length} spawns, ${guards.length} guards)`)
})
