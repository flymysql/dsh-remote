// POSIX syntax gate for the shell command builders.
//
// `buildLaunchCommand` joins statements with '; ', and the `do` keyword must be
// glued to the first command of its loop body — emitted as its own element it
// produced a literal `do;`, a POSIX syntax error. Unit tests that only assert on
// the string were perfectly happy with it; the equivalent hand-written script
// worked, so nothing looked wrong until the first real run of the feature, where
// EVERY attach failed with "syntax error near unexpected token `;'".
//
// Node cannot parse shell, so this shells out to a real POSIX `sh -n` (syntax
// check only, never executed). It is skipped with an explicit reason when no
// `sh` is available, rather than silently passing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { buildLaunchCommand, buildStopCommand } from '../lib/web-attach.js'
import { launcherSource, writeTermSecretHelpers } from '../lib/remote-shell.js'
import remoteShellChild from '../lib/remote-shell-child.cjs'
import posixShell from '../lib/posix-shell.cjs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { posixViaSh } = posixShell

/** A `sh` we can ask to syntax-check, or null when the host has none. */
function findSh() {
  for (const candidate of ['/bin/sh', 'sh', 'bash', '/bin/bash']) {
    try {
      execFileSync(candidate, ['-n'], { input: 'true', stdio: ['pipe', 'pipe', 'pipe'] })
      return candidate
    } catch { /* try the next one */ }
  }
  return null
}

const sh = findSh()

/**
 * Syntax-check a command with the real shell. Returns null when OK.
 *
 * Fed on STDIN rather than `-c`: on Windows, argv containing embedded double
 * quotes is mangled on the way to bash.exe, so a valid script can report
 * `unexpected EOF while looking for matching '"'`. Verified that stdin accepts
 * the valid form while still rejecting both an unterminated quote and the
 * original `do;` defect, so it is both faithful and able to fail.
 */
function syntaxError(shBin, command) {
  try {
    // `-n` reads but does not execute: safe for the destructive stop command.
    execFileSync(shBin, ['-n'], { input: command, stdio: ['pipe', 'pipe', 'pipe'] })
    return null
  } catch (err) {
    return String((err && (err.stderr || err.message)) || err).trim()
  }
}

test('buildLaunchCommand emits POSIX-valid shell', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot syntax-check the remote command')
  const cases = [
    { command: 'dsh', profile: 'web', logPath: '.log-a' },
    { command: '/tmp/private prefix/dsh', profile: 'web', logPath: '.log-b', dshHome: '/tmp/home' },
    { command: 'dsh', profile: 'web', logPath: '.log-c', remotePort: 42080, waitSeconds: 5 },
    { command: 'dsh', profile: 'web', logPath: '.log-d', waitSeconds: 300 },
  ]
  for (const spec of cases) {
    const err = syntaxError(sh, buildLaunchCommand(spec))
    assert.equal(err, null, `invalid shell for ${JSON.stringify(spec)}:\n${err}`)
  }
})

test('buildStopCommand emits POSIX-valid shell', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot syntax-check the remote command')
  for (const cmd of [buildStopCommand(1234), buildStopCommand(1234, '.dsh-remote-web-x.log'), buildStopCommand(0)]) {
    const err = syntaxError(sh, cmd)
    assert.equal(err, null, `invalid shell: ${cmd}\n${err}`)
  }
})

// Issue #111: the login shell may be fish/csh, so the FINAL sh -c wrapper (not
// only the inner builders) is what must survive a real parser. Quote-hostile
// paths exercise the nested close/escape/reopen quoting boundary.
test('issue #111: final sh -c commands are POSIX-valid, including quoted paths', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot syntax-check the sh -c boundary')
  const launch = buildLaunchCommand({
    command: '/tmp/private prefix/dsh', profile: 'web', logPath: '.log-issue111', dshHome: '/tmp/home',
  })
  const commands = [
    posixViaSh(launch),
    posixViaSh(buildStopCommand(1234, '.dsh-remote-web-issue111.log')),
    ...['', '~/my proj', '/srv/my proj', "/srv/it's", '/srv/$dollar/`backtick`/"double"'].map((p) => remoteShellChild.remoteCommand(p)),
  ]
  for (const cmd of commands) {
    assert.match(cmd, /^sh -c '/, 'the generated command must cross through one explicit sh')
    const err = syntaxError(sh, cmd)
    assert.equal(err, null, `invalid sh -c command: ${cmd}\n${err}`)
  }
})

// The generated `remote ssh` launcher is also a shell script handed to a real
// terminal; quote-hostile paths must survive `sh -n`, not just regexes.
test('the POSIX remote-ssh launcher is POSIX-valid shell', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot syntax-check the launcher')
  const cases = [
    { childPath: '/pkg/child.cjs', machinesFile: '/root/m.json', nodePath: '/usr/bin/node' },
    { childPath: "/pkg/it's/child.cjs", machinesFile: '/tmp/my machines.json', nodePath: '' },
    { childPath: '/pkg/child.cjs', machinesFile: '/root/m.json', nodePath: '/opt/my node/bin/node' },
  ]
  for (const spec of cases) {
    const err = syntaxError(sh, launcherSource({ platform: 'linux', ...spec }))
    assert.equal(err, null, `invalid launcher shell for ${JSON.stringify(spec)}:\n${err}`)
  }
})

// The askpass wrapper the credential bridge installs is likewise generated shell.
test('the POSIX askpass wrapper is POSIX-valid shell', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot syntax-check the askpass wrapper')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-askpass-'))
  try {
    for (const nodePath of ['/usr/bin/node', "/opt/it's here/bin/node"]) {
      writeTermSecretHelpers({ dir, platform: 'linux', nodePath })
      const wrapper = readFileSync(path.join(dir, 'term-askpass'), 'utf8')
      const err = syntaxError(sh, wrapper)
      assert.equal(err, null, `invalid askpass wrapper for nodePath=${nodePath}:\n${err}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The gate must be able to fail: prove it rejects the exact defect that shipped.
test('the syntax gate actually rejects the do; defect it exists for', (t) => {
  if (!sh) return t.skip('no POSIX sh on this host; cannot prove the gate fails')
  const broken = 'i=0; while [ $i -lt 3 ]; do; sleep 1; i=$((i+1)); done'
  assert.notEqual(syntaxError(sh, broken), null, '`do;` must be reported as a syntax error')
  const fixed = 'i=0; while [ $i -lt 3 ]; do sleep 1; i=$((i+1)); done'
  assert.equal(syntaxError(sh, fixed), null, 'the glued form must be accepted')
  // The new sh -c boundary needs its own negative control too: a gate that only
  // ever sees valid wrappers cannot prove it notices a broken outer quote.
  assert.notEqual(syntaxError(sh, "sh -c 'unterminated"), null, 'an unterminated sh -c quote must be rejected')
})

// A gate that silently skips reports GREEN while an entire class of defect goes
// unchecked. A host without sh must therefore be an explicit decision, not an
// accident that quietly reduces this file to nothing.
test('the shell gate did not silently disappear', (t) => {
  if (process.env.DSH_REMOTE_ALLOW_NO_SH === '1') {
    return t.skip('DSH_REMOTE_ALLOW_NO_SH=1: the caller accepted running without a shell gate')
  }
  assert.ok(sh, 'no POSIX sh was found, so the syntax gate could not run. '
    + 'Install sh/bash, or set DSH_REMOTE_ALLOW_NO_SH=1 to accept that invalid '
    + 'generated shell is unchecked on this host.')
})
