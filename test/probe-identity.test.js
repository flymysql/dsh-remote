// Saved machines and discovered aliases have different identity semantics.
// Probe retries are bounded and driven by real timeout signals only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveMachineSshConfig, resolveLiteralSshConfig } from '../lib/sshconfig.js'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function section(start, end) {
  const a = src.indexOf(start)
  assert.ok(a >= 0, `missing marker: ${start}`)
  const b = src.indexOf(end, a)
  assert.ok(b > a, `missing marker: ${end}`)
  return src.slice(a, b)
}
const helperFactory = new Function(
  section('    const isProbeTimeout', '    // dsh-remote-fix4: the old discoveredProbeTargets')
  + '\nreturn { identityKeyOf, hostIdentityKey, machineIdentityKey, discoveredConfigKey, dedupeHostEntries, savedSshIdentitySets, dedupeDiscoveredForSaved, shouldProbeMachine, isProbeTimeout }',
)
const H = helperFactory()
const alias = (name, hostName = 'host-a', identityFile = '', proxyJump = '') => ({
  alias: name, hostName, user: 'root', port: 2222, identityFile, proxyJump, proxyCommand: '',
})

test('discovered aliases dedupe only on effective config and prefer the canonical name', () => {
  const short = alias('short')
  const canonical = alias('host-a')
  const otherKey = alias('other-key', 'host-a', '/different/key')
  const otherProxy = alias('other-proxy', 'host-a', '', 'jump.example')
  const rows = H.dedupeHostEntries([short, canonical, otherKey, otherProxy])
  assert.equal(rows.length, 3, 'only the fully identical aliases collapse')
  assert.deepEqual(rows.map((h) => h.alias).sort(), ['host-a', 'other-key', 'other-proxy'])
  assert.equal(rows.filter((h) => h.alias === 'host-a').length, 1, 'canonical HostName alias wins')
  assert.equal(H.dedupeHostEntries([alias('git', 'github.com')]).length, 0, 'git-only discovered hosts are hidden')
  assert.equal(H.shouldProbeMachine({ host: 'github.com' }), false, 'saved GitHub remains unprobed')
  assert.equal(H.shouldProbeMachine({ host: 'alias', sshConfigResolved: { host: 'github.com' } }), false, 'resolved GitHub is unprobed too')
  assert.equal(H.shouldProbeMachine({ host: 'example.com' }), true, 'ordinary saved hosts are probed')
})

test('saved suppression uses resolved identity or exact alias, never raw endpoint fallback', () => {
  assert.equal(H.dedupeDiscoveredForSaved([alias('box'), alias('host-a')], [{ id: 'saved', host: 'box', useSshConfig: true }]).length, 0,
    'unresolved saved alias suppresses its whole config group, including the canonical sibling')
  assert.equal(H.dedupeDiscoveredForSaved([alias('other', '10.0.0.7')], [{ id: 'literal', host: '10.0.0.7' }]).length, 1,
    'a literal saved host with no resolved metadata must not be guessed into the same identity')
  const savedResolved = [{ id: 'resolved', host: 'box', useSshConfig: true,
    sshConfigResolved: { matched: true, host: '10.0.0.7', port: 2222, username: 'root' } }]
  assert.equal(H.dedupeDiscoveredForSaved([alias('dg', '10.0.0.7'), alias('host-b', '10.0.0.7')], savedResolved).length, 0,
    'a resolved saved identity takes ownership of matching discovered aliases')
  const otherKeyConfig = [
    'Host box dg',
    '  HostName 10.0.0.7',
    '  User root',
    '  Port 2222',
    '  IdentityFile /saved/key',
    '  ProxyCommand ssh gateway',
    'Host other',
    '  HostName 10.0.0.7',
    '  User root',
    '  Port 2222',
    '  IdentityFile /other/key',
  ].join('\n')
  const savedOtherKey = [resolveMachineSshConfig({ host: 'box', useSshConfig: true }, { text: otherKeyConfig })]
  assert.equal(savedOtherKey[0].identityFile, '/saved/key', 'the real resolver preserves raw IdentityFile')
  assert.equal(savedOtherKey[0].proxyCommand, 'ssh gateway', 'the real resolver preserves ProxyCommand')
  assert.equal(H.dedupeDiscoveredForSaved([alias('dg', '10.0.0.7', '/other/key')], savedOtherKey).length, 1,
    'same endpoint with a different IdentityFile is not hidden by saved suppression')
  const literalResolved = resolveLiteralSshConfig({ host: 'box' }, { text: otherKeyConfig })
  assert.equal(literalResolved.identityFile, '/saved/key', 'literal resolver gets the same raw fields')
  assert.equal(H.dedupeDiscoveredForSaved([alias('dg', '10.0.0.7', '/other/key')], [literalResolved]).length, 1,
    'literal resolved config also respects key-specific identity')
})

function makeWorker(actions) {
  const calls = [], rows = {}
  const controller = { signal: { aborted: false } }
  const queue = [{ key: 'machine:m1', body: { id: 'm1' } }]
  const api = async (_method, _path, body) => {
    calls.push(body)
    const action = actions[calls.length - 1] || { value: { ok: false, error: 'unexpected extra attempt' } }
    if (action.abort) controller.signal.aborted = true
    if (action.throw) throw new Error(action.throw)
    return action.value
  }
  const workerFactory = new Function('queue', 'controller', 'api', 'isProbeTimeout', 'setRow', 'tr',
    section('        async function worker() {', '        Promise.all(Array.from') + '\nreturn worker')
  const worker = workerFactory(queue, controller, api, H.isProbeTimeout, (key, value) => { rows[key] = value }, (key) => key)
  return { calls, rows, controller, run: () => worker() }
}

function noOverride(calls) {
  for (const body of calls) assert.equal(Object.prototype.hasOwnProperty.call(body, 'connectTimeoutMs'), false,
    'the client must not override the server connectTimeoutMs')
}

test('throw timeout retries once and succeeds on the second attempt', async () => {
  const w = makeWorker([{ throw: 'ssh timed out after 15000ms' }, { value: { ok: true, latencyMs: 20 } }])
  await w.run()
  assert.equal(w.calls.length, 2)
  assert.equal(w.rows['machine:m1'].ok, true)
  noOverride(w.calls)
})

test('HTTP 200 ok:false timeout retries once and succeeds', async () => {
  const w = makeWorker([{ value: { ok: false, error: 'ETIMEDOUT' } }, { value: { ok: true } }])
  await w.run()
  assert.equal(w.calls.length, 2)
  assert.equal(w.rows['machine:m1'].ok, true)
  noOverride(w.calls)
})

test('throw timeout then ok:false timeout stops at two attempts', async () => {
  const w = makeWorker([{ throw: 'timeout' }, { value: { ok: false, error: 'still timed out' } }])
  await w.run()
  assert.equal(w.calls.length, 2, 'the mixed throw/payload path must not become three attempts')
  assert.equal(w.rows['machine:m1'].ok, false)
  noOverride(w.calls)
})

test('two timeouts report failure exactly twice', async () => {
  const w = makeWorker([{ throw: 'timed out' }, { throw: 'timed out again' }])
  await w.run()
  assert.equal(w.calls.length, 2)
  assert.equal(w.rows['machine:m1'].ok, false)
})

test('non-timeout errors and exit -1 never retry', async () => {
  const denied = makeWorker([{ value: { ok: false, error: 'Permission denied' } }])
  await denied.run()
  assert.equal(denied.calls.length, 1)
  const exit = makeWorker([{ throw: 'ssh failed (exit -1)' }])
  await exit.run()
  assert.equal(exit.calls.length, 1, 'exit -1 is not proof of a timeout')
})

test('timeout followed by a different error still stops at two attempts', async () => {
  const w = makeWorker([{ throw: 'timeout' }, { value: { ok: false, error: 'Permission denied' } }])
  await w.run()
  assert.equal(w.calls.length, 2)
  assert.equal(w.rows['machine:m1'].ok, false)
})

test('abort prevents both retry and row publication', async () => {
  const w = makeWorker([{ abort: true, value: { ok: false, error: 'timeout' } }])
  await w.run()
  assert.equal(w.calls.length, 1)
  assert.equal(w.rows['machine:m1'], undefined)
})
