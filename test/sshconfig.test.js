import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSshConfig, importableEntries } from '../lib/sshconfig.js'

const SAMPLE = `
# comment
Host build
  HostName 9.134.186.191
  User mmdev
  Port 36000
  IdentityFile ~/.ssh/build_key
  ProxyJump jump.example.com

Host prod-*
  HostName 10.0.0.1

Host deploy
  HostName 10.0.0.2
  User ops
`

test('parseSshConfig extracts blocks', () => {
  const entries = parseSshConfig(SAMPLE)
  assert.equal(entries.length, 3)
  const build = entries[0]
  assert.equal(build.host, 'build')
  assert.equal(build.hostName, '9.134.186.191')
  assert.equal(build.user, 'mmdev')
  assert.equal(build.port, 36000)
  assert.equal(build.identityFile, '~/.ssh/build_key')
  assert.equal(build.proxyJump, 'jump.example.com')
})

test('importableEntries skips wildcards and empty blocks', () => {
  const entries = importableEntries(SAMPLE)
  const names = entries.map((e) => e.host)
  assert.ok(names.includes('build'))
  assert.ok(names.includes('deploy'))
  assert.ok(!names.includes('prod-*'))
})

test('empty / missing text yields no entries', () => {
  assert.deepEqual(parseSshConfig(''), [])
  assert.deepEqual(importableEntries('# only a comment\n'), [])
})
