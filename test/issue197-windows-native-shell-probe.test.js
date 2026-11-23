// Issue #197 (Windows, native cmd.exe default shell) — the system-OpenSSH
// connect probe used a bare `true`, which cmd.exe — the default shell of a
// stock Windows OpenSSH server — does not provide. A healthy Windows host was
// therefore reported "unavailable" in the settings page, and because sshd's
// cmd.exe error text is GBK the message surfaced as mojibake.
//
// The probe must be a command every shell accepts: `echo ok` works under
// cmd.exe, PowerShell and POSIX sh/bash. This file pins both probe sites:
//   • SystemOpenSshPool._doConnect (the settings "test connection" latency probe)
//   • probeMachineRecord in lib/main.js (the registry probe behind the card)

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SystemOpenSshPool } from '../lib/openssh.js'

const baseConfig = (over = {}) => ({
  host: 'example.internal',
  port: 22,
  username: 'root',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  workspace: '',
  useAgent: false,
  keyboardInteractive: false,
  hostKeyMode: 'accept-new',
  connectTimeoutMs: 15000,
  commandTimeoutMs: 20000,
  maxOutputChars: 200000,
  backend: 'openssh',
  // `_runSsh` is stubbed in the test below, so the binary is never spawned; an
  // absolute, always-present executable keeps `sshBinaryAvailable()` honest.
  sshBinary: process.execPath,
  ...over,
})

test('#197: the system-OpenSSH connect probe is shell-portable, never bare `true`', async (t) => {
  const pool = new SystemOpenSshPool(baseConfig())
  t.after(() => pool.close())
  const calls = []
  pool._runSsh = async (extraArgs, opts) => {
    calls.push({ extraArgs, opts })
    return { code: 0, signal: null, stdout: 'ok', stderr: '' }
  }
  await pool.connect()
  assert.equal(calls.length, 1, 'one proven dial on the happy path')
  const argv = calls[0].extraArgs
  assert.equal(argv[argv.length - 1], 'echo ok',
    'cmd.exe, PowerShell and sh all accept `echo ok`; cmd.exe has no `true`')
  assert.ok(!argv.includes('true'), 'the probe must not be a bare `true`')
})

test('#197: probeMachineRecord also probes with `echo ok`, not bare `true`', () => {
  const main = readFileSync(new URL('../lib/main.js', import.meta.url), 'utf8')
  assert.doesNotMatch(main, /probe\.exec\(\s*['"]true['"]/,
    'probeMachineRecord must not exec a bare `true` (cmd.exe cannot run it)')
  assert.match(main, /probe\.exec\(\s*['"]echo ok['"]/,
    'probeMachineRecord should probe with `echo ok`')
})
