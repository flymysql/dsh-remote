// Issue #118 comment — native's known_hosts.json is a fingerprint registry,
// not an OpenSSH known_hosts file. ActivePool must give each backend its own
// format while preserving the old direct-construction fallback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ActivePool } from '../lib/pool.js'
import { SystemOpenSshPool, sshBinaryAvailable } from '../lib/openssh.js'
import { loadKnownHosts } from '../lib/hostkey.js'
import { startFakeSsh } from './harness/fake-ssh.js'

const baseConfig = (over = {}) => ({
  host: 'example.internal',
  port: 22,
  username: 'root',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  useAgent: false,
  keyboardInteractive: false,
  hostKeyMode: 'accept-new',
  connectTimeoutMs: 10000,
  commandTimeoutMs: 5000,
  maxOutputChars: 10000,
  backend: 'openssh',
  ...over,
})

test('OpenSSH prefers its plain-text path; native keeps the JSON registry and legacy fallback stays compatible', () => {
  const knownHostsFile = () => '/registry/known_hosts.json'
  const opensshKnownHostsFile = () => '/registry/known_hosts'
  const openssh = new ActivePool(baseConfig(), { knownHostsFile, opensshKnownHostsFile })
  assert.equal(openssh.delegate._argConfig().knownHostsFile, '/registry/known_hosts')
  openssh.close()

  const native = new ActivePool(baseConfig({ backend: 'native' }), { knownHostsFile, opensshKnownHostsFile })
  assert.strictEqual(native.delegate._knownHostsFile, knownHostsFile)
  native.close()

  const legacy = new SystemOpenSshPool(baseConfig(), { knownHostsFile })
  assert.equal(legacy._argConfig().knownHostsFile, '/registry/known_hosts.json')
  legacy.close()
})

test('OpenSSH accept-new appends plain text without corrupting the JSON registry', {
  skip: sshBinaryAvailable('ssh') ? false : 'no `ssh` on PATH — the openssh backend cannot run here',
}, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-openssh-known-hosts-'))
  const srv = await startFakeSsh({ users: {}, silent: true })
  const protectedFile = path.join(dir, 'protected.json')
  const legacyFile = path.join(dir, 'legacy.json')
  const plainFile = path.join(dir, 'known_hosts')
  const registry = { sentinel: { fingerprint: 'keep-this-json-intact' } }
  writeFileSync(protectedFile, JSON.stringify(registry, null, 2))
  writeFileSync(legacyFile, JSON.stringify(registry, null, 2))
  const protectedBefore = readFileSync(protectedFile, 'utf8')

  const pool = new ActivePool(baseConfig({ host: '127.0.0.1', port: srv.port }), {
    knownHostsFile: () => protectedFile,
    opensshKnownHostsFile: () => plainFile,
  })
  const legacy = new SystemOpenSshPool(baseConfig({ host: '127.0.0.1', port: srv.port }), {
    knownHostsFile: () => legacyFile,
  })
  t.after(async () => {
    pool.close()
    legacy.close()
    await srv.close()
    rmSync(dir, { recursive: true, force: true })
  })

  assert.equal((await pool.exec('echo split-path')).code, 0)
  assert.equal(readFileSync(protectedFile, 'utf8'), protectedBefore,
    'OpenSSH must not append bare known_hosts text to the native JSON registry')
  assert.match(readFileSync(plainFile, 'utf8'), /ssh-ed25519/,
    'the real ssh CLI writes the loopback host key to the dedicated plain-text file')

  // NEGATIVE CONTROL on a throwaway file: the compatibility fallback retains
  // the old behavior, proving this test really exercises OpenSSH's append path.
  assert.equal((await legacy.exec('echo legacy-control')).code, 0)
  assert.notEqual(readFileSync(legacyFile, 'utf8'), protectedBefore)
  assert.deepEqual(loadKnownHosts(legacyFile), {},
    'bare appended text invalidates the old JSON-only path; repair is out of scope')
})
