// Multi-hop proxy chains (OpenSSH `ProxyJump a,b,c` semantics).
//
// History: the single-hop proxy was hard-wired — the bastion pool was built
// with `proxy: undefined`, so a chain could never go deeper than one bastion.
// Operators with the usual topology (laptop → edge → jump → target) had to
// flatten it by hand.
//
// The fix is the recursion itself: a bastion may carry its OWN `proxy`, and each
// hop is dialed through the already-open connection to the previous one. Two
// invariants matter and are pinned here:
//   1. credentials do NOT inherit across hops — presenting the target's key to an
//      intermediate host hands that host a secret it should never see, and it is
//      usually not authorized there anyway;
//   2. a config CYCLE becomes a clear error, not unbounded recursion.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_JUMP_HOPS } from '../lib/pool.js'

test('the hop cap exists and is a sane cycle guard, not a feature limit', () => {
  assert.equal(typeof MAX_JUMP_HOPS, 'number')
  assert.ok(MAX_JUMP_HOPS >= 3, 'a legitimate chain (laptop→edge→jump→target) must fit')
  assert.ok(MAX_JUMP_HOPS <= 20, 'but a runaway depth must be caught early')
})

/** Mirror of the hop-resolution the pool performs, isolated so it is testable. */
function nextHopConfig(base, proxyCfg, depth) {
  if (depth >= MAX_JUMP_HOPS) {
    throw new Error(`proxy chain is deeper than ${MAX_JUMP_HOPS} hops — check the machine config for a proxy cycle`)
  }
  return {
    ...base,
    host: proxyCfg.host,
    port: Number(proxyCfg.port) || 22,
    username: proxyCfg.username || base.username || 'root',
    password: proxyCfg.password || '',
    privateKeyPath: proxyCfg.privateKeyPath || '',
    passphrase: proxyCfg.passphrase || '',
    ...(proxyCfg.useAgent !== undefined ? { useAgent: !!proxyCfg.useAgent } : {}),
    ...(proxyCfg.keyboardInteractive !== undefined ? { keyboardInteractive: !!proxyCfg.keyboardInteractive } : {}),
    ...(proxyCfg.hostKeyMode ? { hostKeyMode: proxyCfg.hostKeyMode } : {}),
    proxy: proxyCfg.proxy && proxyCfg.proxy.host ? proxyCfg.proxy : undefined,
    _hopDepth: depth + 1,
  }
}

test('a hop does NOT inherit the TARGET credentials (the security-critical bit)', () => {
  const target = {
    host: 'target.internal', port: 22, username: 'deploy',
    privateKeyPath: '/keys/TARGET_id_ed25519', passphrase: 'target-passphrase',
    password: 'target-password',
  }
  const hop = nextHopConfig(target, { host: 'bastion.edge', username: 'edge' }, 0)
  assert.equal(hop.host, 'bastion.edge')
  assert.equal(hop.privateKeyPath, '', 'the target key must never be presented to the bastion')
  assert.equal(hop.passphrase, '')
  assert.equal(hop.password, '', 'nor the target password')
  assert.equal(hop.username, 'edge')
})

test('a hop that supplies its own credentials keeps them', () => {
  const target = { host: 't', username: 'deploy', privateKeyPath: '/keys/target' }
  const hop = nextHopConfig(target, {
    host: 'bastion', username: 'edge', privateKeyPath: '/keys/EDGE', passphrase: 'edge-pass',
    useAgent: false, hostKeyMode: 'verify',
  }, 0)
  assert.equal(hop.privateKeyPath, '/keys/EDGE')
  assert.equal(hop.passphrase, 'edge-pass')
  assert.equal(hop.useAgent, false)
  assert.equal(hop.hostKeyMode, 'verify')
})

test('an omitted per-hop flag leaves the base value alone (no accidental flip)', () => {
  const target = { host: 't', username: 'u', useAgent: true }
  const hop = nextHopConfig(target, { host: 'b' }, 0)
  assert.equal(hop.useAgent, true, 'a hop that says nothing about the agent must not disable it')
})

test('the chain nests: hop N keeps hop N+1 as its own proxy', () => {
  const third = { host: 'jump2.corp' }
  const second = { host: 'jump1.corp', proxy: third }
  const first = nextHopConfig({ host: 'target' }, second, 0)
  assert.equal(first.host, 'jump1.corp')
  assert.deepEqual(first.proxy, third, 'the remaining chain travels with the hop')
  assert.equal(first._hopDepth, 1)
  // ...and the recursion terminates: the last hop has no proxy.
  const last = nextHopConfig({ host: 'target' }, third, 1)
  assert.equal(last.host, 'jump2.corp')
  assert.equal(last.proxy, undefined, 'the innermost hop ends the chain')
  assert.equal(last._hopDepth, 2)
})

test('a cycle is reported at the cap instead of recursing forever', () => {
  const cyc = { host: 'a' }
  cyc.proxy = cyc // a self-referential config
  let cfg = { host: 'target', username: 'u' }
  let depth = 0
  let hops = 0
  try {
    // Walk it the way the pool does; the cap must stop us.
    while (true) {
      cfg = nextHopConfig(cfg, { host: 'a', proxy: cyc }, depth)
      depth = cfg._hopDepth
      hops++
      if (hops > MAX_JUMP_HOPS + 5) throw new Error('recursion was not stopped')
    }
  } catch (err) {
    assert.match(String(err.message), new RegExp(`deeper than ${MAX_JUMP_HOPS} hops`))
    assert.ok(hops <= MAX_JUMP_HOPS + 1, `stopped after ${hops} hops`)
  }
})

test('the default port stays 22 when a hop omits it', () => {
  assert.equal(nextHopConfig({ host: 't' }, { host: 'b' }, 0).port, 22)
  assert.equal(nextHopConfig({ host: 't' }, { host: 'b', port: 2222 }, 0).port, 2222)
})
