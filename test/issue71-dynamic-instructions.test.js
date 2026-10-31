// Issue #71 — the DYNAMIC half of #68: a remote session must get instruction
// files injected the way a local session does.
//
// Three gaps made the core's own path unable to do it (all plugin-side
// fixable): (1) the core's incremental trigger only knows read/write/edit with
// a `file_path` argument, while `rw_read_file` takes `path`; (2) it expands
// scopes with LOCAL paths, so a remote absolute path maps onto nothing; (3) the
// mirrored copies never refreshed. These tests pin the replacement path:
//
//   • descendantDirs yields the WHOLE ancestor chain below the root (the
//     core's `ancestorChain(cwd, dir).slice(1)` shape), root excluded — which
//     is what makes "read a file in the root → no extra scan" true;
//   • refreshTouched pulls each chain level's AGENTS.md/CLAUDE.md, mirrors it,
//     and reports only content that has not been delivered yet;
//   • per-session dedup by content digest, plus removal notices;
//   • the injected message is ONE user message with our OWN source kind, so the
//     core's `agent-instructions` reconcile never claims it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  descendantDirs, instructionCandidates, contentDigest, createInjectionTracker,
  refreshTouched, buildInstructionMessage, REMOTE_INSTRUCTIONS_KIND,
  INSTRUCTION_MESSAGE_MAX_BYTES, REFRESH_THROTTLE_MS,
  pickUserMessageFactory, loadBundledUserMessageFactory,
} from '../lib/instructions-dynamic.js'
import { MemFs, makeSftp, seed } from './helpers.js'

// ── the ancestor chain ─────────────────────────────────────────────────────

test('descendantDirs returns the whole chain BELOW the root, root excluded', () => {
  // The issue's acceptance #1: reading FLAB-ONE/xxx.md must put both
  // flab-business/ and flab-business/FLAB-ONE/ in scope.
  assert.deepEqual(
    descendantDirs('/root', '/root/flab-business/FLAB-ONE/xxx.md'),
    ['flab-business', 'flab-business/FLAB-ONE'],
  )
  // Acceptance #2: a file directly in the root has NO chain, so nothing scans.
  assert.deepEqual(descendantDirs('/root', '/root/notes.md'), [])
  // Trailing separators and the root itself are the same answer.
  assert.deepEqual(descendantDirs('/root', '/root'), [])
  assert.deepEqual(descendantDirs('/root/', '/root/a/b.txt'), ['a'])
  // Outside the root: no chain at all (never guess a neighbouring tree).
  assert.deepEqual(descendantDirs('/root', '/etc/passwd'), [])
})

test('instructionCandidates covers both names at every chain level', () => {
  const c = instructionCandidates('/root', '/root/a/b/c.ts')
  assert.deepEqual(c, ['a/AGENTS.md', 'a/CLAUDE.md', 'a/b/AGENTS.md', 'a/b/CLAUDE.md'])
})

test('instructionCandidates can bound the chain depth', () => {
  assert.deepEqual(instructionCandidates('/root', '/root/a/b/c.ts', 1), ['a/b/AGENTS.md', 'a/b/CLAUDE.md'])
  assert.deepEqual(instructionCandidates('/root', '/root/a/b/c.ts', 0), [])
})

// ── digests / dedup ────────────────────────────────────────────────────────

test('contentDigest distinguishes same-size edits', () => {
  assert.notEqual(contentDigest('abcdef'), contentDigest('abcdeg'), 'a same-size edit must change the digest')
  assert.equal(contentDigest('abcdef'), contentDigest(Buffer.from('abcdef')))
})

test('the tracker delivers each content once and can report removals', () => {
  const tracker = createInjectionTracker({ throttleMs: 0 })
  const d1 = contentDigest('v1')
  const d2 = contentDigest('v2')
  assert.equal(tracker.shouldInject('s1', 'a/AGENTS.md', d1), true)
  tracker.markInjected('s1', 'a/AGENTS.md', d1)
  assert.equal(tracker.shouldInject('s1', 'a/AGENTS.md', d1), false, 'same content is never re-injected')
  assert.equal(tracker.shouldInject('s1', 'a/AGENTS.md', d2), true, 'changed content IS injected')
  // Removal: the file vanished from the current scan.
  assert.deepEqual(tracker.removed('s1', new Set()), ['a/AGENTS.md'])
  assert.equal(tracker.shouldInject('s1', 'a/AGENTS.md', d1), true, 'after a removal notice it counts as fresh')
  // A different session starts clean.
  assert.equal(tracker.shouldInject('s2', 'a/AGENTS.md', d1), true)
})

test('the throttle gates sweeps without blocking the first one', () => {
  const tracker = createInjectionTracker({ throttleMs: 1000 })
  assert.equal(tracker.throttled('s1', 1000), false, 'the first sweep always runs')
  tracker.swept('s1', 1000)
  assert.equal(tracker.throttled('s1', 1500), true)
  assert.equal(tracker.throttled('s1', 2500), false)
  assert.equal(REFRESH_THROTTLE_MS, 30 * 1000, 'the documented default is 30s')
})

// ── the sweep ──────────────────────────────────────────────────────────────

function mirror() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-71-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('refreshTouched pulls the WHOLE chain and mirrors it (acceptance #1)', async () => {
  const fs = new MemFs()
  seed(fs, {
    'root/flab-business/AGENTS.md': '# business rules\n',
    'root/flab-business/FLAB-ONE/AGENTS.md': '# FLAB-ONE rules\n',
    'root/flab-business/FLAB-ONE/src/x.ts': 'export {}\n',
    'root/AGENTS.md': '# root rules\n',
  })
  const { dir, cleanup } = mirror()
  try {
    const tracker = createInjectionTracker({ throttleMs: 0 })
    const { items, removed } = await refreshTouched({
      sftp: makeSftp(fs), remoteRoot: '/root', touched: '/root/flab-business/FLAB-ONE/src/x.ts',
      mirrorDir: dir, tracker, sessionId: 's1',
    })
    assert.deepEqual(items.map((i) => i.rel).sort(), [
      'flab-business/AGENTS.md',
      'flab-business/FLAB-ONE/AGENTS.md',
    ], 'both chain levels come in — and the root copy is NOT part of the chain')
    assert.deepEqual(removed, [])
    // Mirrored locally where the core's own loader would look.
    assert.equal(readFileSync(path.join(dir, 'flab-business', 'AGENTS.md'), 'utf8'), '# business rules\n')
    assert.equal(readFileSync(path.join(dir, 'flab-business', 'FLAB-ONE', 'AGENTS.md'), 'utf8'), '# FLAB-ONE rules\n')
  } finally { cleanup() }
})

test('a file directly in the root triggers no scan (acceptance #2)', async () => {
  const fs = new MemFs()
  seed(fs, { 'root/notes.md': 'x\n', 'root/AGENTS.md': '# root\n' })
  const { dir, cleanup } = mirror()
  try {
    const tracker = createInjectionTracker({ throttleMs: 0 })
    const r = await refreshTouched({
      sftp: makeSftp(fs), remoteRoot: '/root', touched: '/root/notes.md',
      mirrorDir: dir, tracker, sessionId: 's1',
    })
    assert.deepEqual(r.items, [], 'the root layer is the core baseline — never re-injected here')
    assert.ok(!existsSync(path.join(dir, 'AGENTS.md')), 'and nothing was mirrored as a side effect')
  } finally { cleanup() }
})

test('re-reading the same tree injects nothing new (acceptance #3)', async () => {
  const fs = new MemFs()
  seed(fs, { 'root/a/AGENTS.md': '# a\n', 'root/a/b/AGENTS.md': '# b\n', 'root/a/b/c.ts': 'x\n' })
  const { dir, cleanup } = mirror()
  try {
    const tracker = createInjectionTracker({ throttleMs: 0 })
    const args = { sftp: makeSftp(fs), remoteRoot: '/root', mirrorDir: dir, tracker, sessionId: 's1' }
    const first = await refreshTouched({ ...args, touched: '/root/a/b/c.ts' })
    assert.equal(first.items.length, 2)
    const second = await refreshTouched({ ...args, touched: '/root/a/b/c.ts' })
    assert.deepEqual(second.items, [], 'same content, same session → no repeat injection')
    // A sibling file in an ALREADY covered directory adds nothing either.
    seed(fs, { 'root/a/b/d.ts': 'y\n' })
    const third = await refreshTouched({ ...args, touched: '/root/a/b/d.ts' })
    assert.deepEqual(third.items, [])
  } finally { cleanup() }
})

test('a remote edit is picked up on the next touch (acceptance #4)', async () => {
  const fs = new MemFs()
  seed(fs, { 'root/a/AGENTS.md': '# v1\n', 'root/a/x.ts': 'x\n' })
  const { dir, cleanup } = mirror()
  try {
    const tracker = createInjectionTracker({ throttleMs: 0 })
    const args = { sftp: makeSftp(fs), remoteRoot: '/root', mirrorDir: dir, tracker, sessionId: 's1' }
    const first = await refreshTouched({ ...args, touched: '/root/a/x.ts' })
    assert.equal(first.items[0].content, '# v1\n')
    fs.writeFileSync('/root/a/AGENTS.md', '# v2 changed\n')
    const second = await refreshTouched({ ...args, touched: '/root/a/x.ts' })
    assert.equal(second.items.length, 1, 'changed content is re-delivered')
    assert.match(second.items[0].content, /v2 changed/)
    assert.match(readFileSync(path.join(dir, 'a', 'AGENTS.md'), 'utf8'), /v2 changed/, 'and the mirror refreshed')
  } finally { cleanup() }
})

test('a deleted instruction produces a removal notice scoped to the touched chain', async () => {
  const fs = new MemFs()
  seed(fs, { 'root/a/AGENTS.md': '# a\n', 'root/a/b/AGENTS.md': '# b\n', 'root/a/b/c.ts': 'x\n', 'root/z/AGENTS.md': '# z\n' })
  const { dir, cleanup } = mirror()
  try {
    const tracker = createInjectionTracker({ throttleMs: 0 })
    const args = { sftp: makeSftp(fs), remoteRoot: '/root', mirrorDir: dir, tracker, sessionId: 's1' }
    await refreshTouched({ ...args, touched: '/root/a/b/c.ts' })
    await refreshTouched({ ...args, touched: '/root/z/q.ts' }) // unrelated subtree
    fs.root.delete('/root/a/AGENTS.md')
    const after = await refreshTouched({ ...args, touched: '/root/a/b/c.ts' })
    assert.deepEqual(after.removed, ['a/AGENTS.md'], 'the model must be told the rule is gone')
    assert.deepEqual(after.items, [], 'the surviving sibling is unchanged')
  } finally { cleanup() }
})

test('an offline machine yields no injection instead of throwing', async () => {
  const tracker = createInjectionTracker({ throttleMs: 0 })
  const deadSftp = { stat: async () => { throw new Error('offline') }, readFile: async () => { throw new Error('offline') } }
  const r = await refreshTouched({
    sftp: deadSftp, remoteRoot: '/root', touched: '/root/a/b.ts', mirrorDir: '/nonexistent', tracker, sessionId: 's1',
  })
  assert.deepEqual(r.items, [])
  assert.deepEqual(r.removed, [])
})

test('an oversized instruction is announced rather than injected whole', async () => {
  const fs = new MemFs()
  seed(fs, { 'root/a/AGENTS.md': 'x'.repeat(300 * 1024), 'root/a/x.ts': 'x\n' })
  const { dir, cleanup } = mirror()
  try {
    const tracker = createInjectionTracker({ throttleMs: 0 })
    const r = await refreshTouched({
      sftp: makeSftp(fs), remoteRoot: '/root', touched: '/root/a/x.ts', mirrorDir: dir, tracker, sessionId: 's1',
    })
    assert.equal(r.items.length, 1)
    assert.equal(r.items[0].content, '')
    assert.equal(r.items[0].oversizeBytes, 300 * 1024)
  } finally { cleanup() }
})

// ── the message ────────────────────────────────────────────────────────────

const item = (rel, content) => ({ rel, remote: `/root/${rel}`, content, digest: contentDigest(content) })

test('the message is ONE user message with a plugin-owned source kind', () => {
  const msg = buildInstructionMessage(
    [item('a/AGENTS.md', '# a rules'), item('a/b/AGENTS.md', '# b rules')],
    [],
  )
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, REMOTE_INSTRUCTIONS_KIND)
  assert.notEqual(msg.source.kind, 'agent-instructions', 'the core must not claim it')
  assert.equal(msg.source.form, 'instructions')
  assert.equal(msg.content.length, 1)
  const text = msg.content[0].text
  assert.match(text, /<system-reminder>/)
  assert.match(text, /a\/AGENTS\.md[\s\S]*# a rules/)
  assert.match(text, /a\/b\/AGENTS\.md[\s\S]*# b rules/)
  // Both files in the SAME message (acceptance #1: "in the same incremental message").
  assert.equal((text.match(/system-reminder>/g) || []).length, 2, 'one opening and one closing frame')
})

test('the message respects its byte budget and says what it dropped', () => {
  const big = (n) => item(`${n}/AGENTS.md`, 'y'.repeat(INSTRUCTION_MESSAGE_MAX_BYTES))
  const msg = buildInstructionMessage([big('a'), big('b')], [])
  const text = msg.content[0].text
  assert.match(text, /Workspace instruction budget \d+ bytes: truncated/)
  assert.ok(Buffer.byteLength(text, 'utf8') < INSTRUCTION_MESSAGE_MAX_BYTES * 2, 'the budget actually bounds the batch')
})

test('removals get their own line; nothing to say returns null', () => {
  assert.equal(buildInstructionMessage([], []), null)
  const msg = buildInstructionMessage([], ['a/AGENTS.md'])
  assert.match(msg.content[0].text, /Removed on the remote host.*a\/AGENTS\.md/)
})

test('a supplied message factory is used when the composition has one', () => {
  let seen = null
  const msg = buildInstructionMessage([item('a/AGENTS.md', '# x')], [], {
    createUserMessage: (input) => { seen = input; return { role: 'user', ...input, made: true, id: 'kept' } },
  })
  assert.equal(msg.made, true)
  assert.equal(msg.id, 'kept')
  assert.ok(seen.source.kind === REMOTE_INSTRUCTIONS_KIND)
})

test('a message built WITHOUT a factory still carries an id (issue #75: session restore rejects id-less messages)', () => {
  // The core validates every stored message at restore time
  // (dsh-session/lib/types/index.js assertMessageEventShape: message.id must be a
  // non-empty string) and rejects the WHOLE log on the first offender — a remote
  // instruction injected without an id made a 130+-turn session fail to reopen.
  // The fallback object (factory absent, as in a composition where ctx.get('llm')
  // has no createUserMessage) must therefore carry its own identity.
  const msg = buildInstructionMessage([item('a/AGENTS.md', '# a rules')], [])
  assert.ok(typeof msg.id === 'string' && msg.id.length > 0,
    `the fallback message must carry an id, got: ${JSON.stringify(msg).slice(0, 200)}`)
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, REMOTE_INSTRUCTIONS_KIND)
})

test('a factory that omits id is repaired instead of stored bare', () => {
  const msg = buildInstructionMessage([item('a/AGENTS.md', '# x')], [], {
    createUserMessage: (input) => ({ role: 'user', ...input }),
  })
  assert.equal(typeof msg.id, 'string')
  assert.ok(msg.id.length > 0)
  assert.equal(msg.role, 'user')
})

test('pickUserMessageFactory only trusts a real createUserMessage method', () => {
  assert.equal(pickUserMessageFactory(null), null)
  assert.equal(pickUserMessageFactory({ name: 'llm' }), null)
  const make = pickUserMessageFactory({
    createUserMessage: (input) => ({ ...input, role: 'user', id: 'from-service' }),
  })
  assert.equal(make({ content: [], source: { kind: 'x' } }).id, 'from-service')
  const nested = pickUserMessageFactory({
    default: { createUserMessage: (input) => ({ ...input, role: 'user', id: 'from-default' }) },
  })
  assert.equal(nested({ content: [], source: { kind: 'x' } }).id, 'from-default')
})

test('the bundled dsh-llm factory stamps an id when the package resolves', () => {
  const make = loadBundledUserMessageFactory()
  if (!make) return
  const msg = make({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: REMOTE_INSTRUCTIONS_KIND },
  })
  assert.equal(msg.role, 'user')
  assert.equal(typeof msg.id, 'string')
  assert.ok(msg.id.length > 0)
})
