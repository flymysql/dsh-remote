// `rw_connect`'s success sentence must describe the MACHINE, not the argv.
//
// The reported symptom: a working report read "Connected to mybox as ." —
// because on the system-OpenSSH backend an ssh-config alias is dialed VERBATIM
// (no -l/-p, which is exactly what keeps the Host block matching), so the dial
// identity has no user and the fallback port 22 while ~/.ssh/config supplies
// both. That sentence looks like a missing-username misconfiguration for a
// machine that connects fine.
//
// Values here are RFC 5737 / reserved placeholders on purpose: this file is the
// public regression contract, not a record of anybody's inventory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeConnect } from '../lib/connect-summary.js'

/** The reported shape: alias machine, system-OpenSSH backend. */
const aliasNativeInput = {
  alias: 'mybox',
  aliasNative: true,
  resolved: { host: '203.0.113.10', port: 2222, username: 'alice' },
  // What applyActiveMachine leaves in the shared config for an alias dial:
  // host = alias, username = '', port = 22 (no -l/-p emitted).
  dialHost: 'mybox',
  dialUser: '',
  dialPort: 22,
}

test('an alias-native connect names the alias and its resolved user, never "as ."', () => {
  const text = describeConnect(aliasNativeInput)
  assert.equal(text.split('\n')[0], 'Connected to mybox as alice.')
  assert.match(text, /ssh-config alias "mybox" → alice@203\.0\.113\.10:2222/)
  assert.doesNotMatch(text, /as \./, 'an empty dial user must not be printed')
})

test('the alias note keeps showing the resolved endpoint when only Port differs', () => {
  const text = describeConnect({ ...aliasNativeInput, resolved: { host: '203.0.113.10', port: 2222, username: 'alice' } })
  assert.match(text, /alice@203\.0\.113\.10:2222/, 'Port from ~/.ssh/config, not the 22 fallback')
})

test('a native alias machine keeps its resolved dial identity (no regression)', () => {
  // On the native backend the plugin dials the RESOLVED host/user itself.
  const text = describeConnect({
    alias: 'mybox',
    aliasNative: false,
    resolved: { host: '203.0.113.10', port: 2222, username: 'alice' },
    dialHost: '203.0.113.10',
    dialUser: 'alice',
    dialPort: 2222,
  })
  assert.equal(text.split('\n')[0], 'Connected to 203.0.113.10 as alice.')
  assert.match(text, /ssh-config alias "mybox" → alice@203\.0\.113\.10:2222/)
})

test('a literal machine has no alias note and reads exactly as before', () => {
  const text = describeConnect({ dialHost: '198.51.100.5', dialUser: 'root', dialPort: 22 })
  assert.equal(text, 'Connected to 198.51.100.5 as root.')
})

test('a machine with no user anywhere drops the dangling "as"', () => {
  const text = describeConnect({ dialHost: '198.51.100.5', dialUser: '', dialPort: 22 })
  assert.equal(text, 'Connected to 198.51.100.5.')
})

test('an alias whose Host block no longer resolves still avoids "as ."', () => {
  const text = describeConnect({ alias: 'mybox', aliasNative: true, resolved: null, dialHost: 'mybox', dialUser: '', dialPort: 22 })
  assert.equal(text.split('\n')[0], 'Connected to mybox.')
  assert.match(text, /ssh-config alias "mybox" → mybox:22/)
})

test('~/.ssh/config directives the plugin could not honour ride along in the note', () => {
  const text = describeConnect({ ...aliasNativeInput, warnings: ['ProxyJump with a port is ignored'] })
  assert.match(text, /; ProxyJump with a port is ignored\)/)
})
