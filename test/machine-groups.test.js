// Host grouping (environment / location / tags / description).
//
// A flat machine list stops being usable past ~a dozen entries: prod boxes sit
// next to laptops, and "pick the right host" becomes the dominant failure mode —
// which on a destructive tool is how accidents happen. These four fields are
// pure LABELS (they change no connection behaviour), so they are cheap to add
// and safe to edit.
//
// The invariants worth pinning: existing registries keep loading unchanged, a
// bad value is dropped rather than coerced, partial updates never wipe stored
// labels, and filters compose the way people read them (AND across dimensions,
// OR within a tag list).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMachineGroup, filterMachinesByGroup, sanitizeMachine } from '../lib/registry.js'

// ── normalization ──────────────────────────────────────────────────────────

test('normalizeMachineGroup keeps valid labels and trims them', () => {
  const g = normalizeMachineGroup({
    environment: '  prod  ', location: ' shanghai ', description: ' main api box ',
  })
  assert.deepEqual(g, { environment: 'prod', location: 'shanghai', description: 'main api box' })
})

test('normalizeMachineGroup accepts tags as an array OR a comma/space string', () => {
  assert.deepEqual(normalizeMachineGroup({ tags: ['gpu', 'big'] }).tags, ['gpu', 'big'])
  assert.deepEqual(normalizeMachineGroup({ tags: 'gpu, big  staging' }).tags, ['gpu', 'big', 'staging'])
})

test('tags de-duplicate case-insensitively but keep the FIRST spelling', () => {
  const g = normalizeMachineGroup({ tags: ['GPU', 'gpu', 'Gpu', 'big'] })
  assert.deepEqual(g.tags, ['GPU', 'big'], 'display stays stable, no duplicate noise')
})

test('bad values are dropped, never coerced into something surprising', () => {
  assert.deepEqual(normalizeMachineGroup({}), {})
  assert.deepEqual(normalizeMachineGroup(null), {})
  assert.deepEqual(normalizeMachineGroup({ environment: 42, tags: { a: 1 } }), {})
  assert.deepEqual(normalizeMachineGroup({ environment: '   ' }), {}, 'whitespace-only is not a label')
})

test('over-long labels are truncated, and the tag count is capped', () => {
  const g = normalizeMachineGroup({ environment: 'x'.repeat(200) })
  assert.equal(g.environment.length, 40)
  const many = normalizeMachineGroup({ tags: Array.from({ length: 30 }, (_, i) => 't' + i) })
  assert.equal(many.tags.length, 12, 'a dozen labels is already too many to scan')
})

test('group labels never leak into or interfere with secret sanitizing', () => {
  const m = sanitizeMachine({
    id: 'm1', host: 'h', password: 'secret', environment: 'prod', tags: ['gpu'],
  })
  assert.equal(m.password, undefined, 'the password still never reaches the client')
  assert.equal(m.environment, 'prod', 'group labels survive sanitizing')
  assert.deepEqual(m.tags, ['gpu'])
  assert.equal(m.passwordSet, true)
})

// ── filtering ──────────────────────────────────────────────────────────────

const MACHINES = [
  { id: 'a', name: 'api', host: 'api.prod', username: 'deploy', environment: 'prod', location: 'shanghai', tags: ['gpu', 'api'], description: 'primary api' },
  { id: 'b', name: 'worker', host: 'wk.prod', username: 'deploy', environment: 'prod', location: 'shanghai', tags: ['gpu'] },
  { id: 'c', name: 'stage', host: 'st.vm', username: 'dev', environment: 'staging', location: 'beijing', tags: ['web'] },
  { id: 'd', name: 'laptop', host: '127.0.0.1', username: 'me' },
]

test('filtering by environment / location is exact and case-insensitive', () => {
  assert.deepEqual(filterMachinesByGroup(MACHINES, { environment: 'PROD' }).map((m) => m.id), ['a', 'b'])
  assert.deepEqual(filterMachinesByGroup(MACHINES, { location: 'beijing' }).map((m) => m.id), ['c'])
  assert.deepEqual(filterMachinesByGroup(MACHINES, { environment: 'prod', location: 'beijing' }), [], 'dimensions AND together')
})

test('tags match ANY of the requested tags', () => {
  assert.deepEqual(filterMachinesByGroup(MACHINES, { tags: 'web' }).map((m) => m.id), ['c'])
  assert.deepEqual(filterMachinesByGroup(MACHINES, { tags: ['gpu'] }).map((m) => m.id), ['a', 'b'])
  assert.deepEqual(filterMachinesByGroup(MACHINES, { tags: 'web,gpu' }).map((m) => m.id), ['a', 'b', 'c'])
  assert.deepEqual(filterMachinesByGroup(MACHINES, { tags: 'nonexistent' }), [])
})

test('free-text query spans name/host/user/env/location/description/tags', () => {
  assert.deepEqual(filterMachinesByGroup(MACHINES, { query: 'api' }).map((m) => m.id), ['a'], 'name + description')
  assert.deepEqual(filterMachinesByGroup(MACHINES, { query: 'deploy' }).map((m) => m.id), ['a', 'b'], 'username')
  assert.deepEqual(filterMachinesByGroup(MACHINES, { query: '127.0' }).map((m) => m.id), ['d'], 'host')
  assert.deepEqual(filterMachinesByGroup(MACHINES, { query: 'gpu' }).map((m) => m.id), ['a', 'b'], 'tag')
})

test('an empty filter returns every machine (and unlabelled ones too)', () => {
  assert.equal(filterMachinesByGroup(MACHINES, {}).length, 4)
  assert.deepEqual(filterMachinesByGroup([], { environment: 'prod' }), [])
  assert.deepEqual(filterMachinesByGroup(null, {}), [])
})

test('a machine with no labels is never matched by a label filter', () => {
  const only = filterMachinesByGroup(MACHINES, { environment: 'prod' })
  assert.ok(!only.some((m) => m.id === 'd'))
})
