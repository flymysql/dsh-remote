// Continuing issue #206: applyMachine must fully own the per-machine policy
// fields it copies onto the shared config. The #206 fix taught it to COPY
// `shell` (and its #51 siblings `backend` / `sshBinary`, plus `hostKeyMode`),
// but every assign still ran only when the record carried the field — the
// inverse bug. A bare record (rw_connect's minimal {host, port} upsert, or a
// machines.json row saved before a field existed) therefore left the PREVIOUS
// machine's values in place: after machine A (backend openssh + hostKeyMode
// off) the next machine silently inherited A's backend and its DISABLED
// host-key verification, when the schema defaults (lib/main.js Config) are
// native / accept-new / '' / ''.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMachine } from '../lib/registry.js'

// The schema defaults applyMachine resets to (lib/main.js Config).
const defaults = () => ({
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', hostKeyMode: 'accept-new', backend: 'native', shell: '', sshBinary: '',
})

test('#206 follow-up: a bare record resets the per-machine policy fields to the schema defaults', () => {
  const config = defaults()
  // Machine A: the enterprise box that needs the OpenSSH backend and has host
  // key verification turned off — every policy field explicitly set.
  applyMachine(config, {
    host: 'a.example', port: 22, username: 'root', password: 'pw',
    backend: 'openssh', hostKeyMode: 'off', shell: 'D:/wrap/bash.exe', sshBinary: '/opt/ssh/bin/ssh',
  })
  assert.equal(config.backend, 'openssh')
  assert.equal(config.hostKeyMode, 'off')
  assert.equal(config.shell, 'D:/wrap/bash.exe')
  assert.equal(config.sshBinary, '/opt/ssh/bin/ssh')

  // Machine B: the bare {host, port} record rw_connect builds when the caller
  // passes nothing else. It must NOT inherit machine A's policy fields —
  // least of all the disabled host-key verification.
  applyMachine(config, { host: 'b.example', port: 22 })
  assert.equal(config.host, 'b.example')
  assert.equal(config.port, 22)
  assert.equal(config.hostKeyMode, 'accept-new', 'host-key verification must not stay disabled')
  assert.equal(config.backend, 'native', 'the next machine must not inherit the openssh backend')
  assert.equal(config.shell, '')
  assert.equal(config.sshBinary, '')
})

test('#206 follow-up: a record that HAS the fields still applies them', () => {
  const config = defaults()
  applyMachine(config, {
    host: 'c.example', port: 2222, username: 'root',
    backend: 'openssh', hostKeyMode: 'verify', shell: 'C:/git/bin/bash.exe', sshBinary: 'C:/tools/ssh.exe',
  })
  assert.equal(config.hostKeyMode, 'verify')
  assert.equal(config.backend, 'openssh')
  assert.equal(config.shell, 'C:/git/bin/bash.exe')
  assert.equal(config.sshBinary, 'C:/tools/ssh.exe')

  // An explicit empty shell/sshBinary still counts as "has the field" — the
  // #206 route contract: an explicit '' clears the stored value. The fields
  // this record OMITS reset, exactly like the bare record above.
  applyMachine(config, { host: 'd.example', port: 22, shell: '', sshBinary: '' })
  assert.equal(config.shell, '')
  assert.equal(config.sshBinary, '')
  assert.equal(config.hostKeyMode, 'accept-new')
  assert.equal(config.backend, 'native')
})

test('#206 follow-up: an empty stored hostKeyMode/backend resets too, never inherits', () => {
  // machines.json rows legitimately carry empty policy fields (the ssh-config
  // alias writer stores `hostKeyMode: ''`, and lib/hostkey.js already dials
  // '' as accept-new). applyMachine must agree: an unset policy falls back to
  // the schema default, never to whatever the previous machine left behind.
  const config = defaults()
  applyMachine(config, { host: 'a.example', port: 22, backend: 'openssh', hostKeyMode: 'off' })
  applyMachine(config, { host: 'e.example', port: 22, hostKeyMode: '', backend: '' })
  assert.equal(config.hostKeyMode, 'accept-new', "an empty hostKeyMode must not inherit 'off'")
  assert.equal(config.backend, 'native', "an empty backend must not inherit 'openssh'")
})
