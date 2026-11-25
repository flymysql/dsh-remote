// Issue #205: rw_pick_workspace's effect was misleading — models read the old
// description ("the working root this session should treat as its own") and
// the success text ("Remote workspace set to … Run rw_sync") as "subsequent
// rw_exec / relative paths now resolve against the new pick", while a session
// that is already bound to another mirror keeps ITS OWN workspace for path
// resolution, rw_exec's cwd and rw_sync until a session is opened inside the
// new mirror. The description now states the scope, and the success text says
// so explicitly when the pick differs from the session's binding.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickWorkspaceRebindNote, pickWorkspaceNextStep } from '../lib/main.js'

test('#205: pickWorkspaceRebindNote answers null for the no-op cases', () => {
  assert.equal(pickWorkspaceRebindNote('', '/new', (x) => x), null, 'an unbound session has nothing to warn about')
  assert.equal(pickWorkspaceRebindNote('/same', '/same', (x) => x), null, 'picking the session\'s own workspace is a no-op note')
})

test('#205: a bound session picking a DIFFERENT workspace is told the truth', () => {
  const note = pickWorkspaceRebindNote('/srv/app', '/srv/app-worktree-b', (x) => x)
  assert.ok(note, 'a differing pick must produce the rebind note')
  assert.match(note, /still bound to \/srv\/app/)
  assert.match(note, /rw_exec's working directory/, 'the note names the exact things that do NOT switch')
  assert.match(note, /open a session whose workspace is the local mirror path above/)
  assert.match(note, /worktree/i, 'the parallel-worktree flow is the documented answer')
})

test('#205: the description states the scope instead of implying a cwd switch', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/main.js', import.meta.url), 'utf8')
  const desc = (/name: 'rw_pick_workspace',\n\s+description:\n\s+'((?:[^'\\]|\\.)+)'/.exec(src)?.[1] ?? '').replace(/\\'/g, "'")
  assert.match(desc, /does NOT change the current session's working directory/, 'the non-rebinding scope is explicit')
  assert.match(desc, /keeps resolving relative paths/, 'what keeps resolving against the old workspace is named')
  assert.match(desc, /one session per mirror/, 'the worktree guidance is in the description')
})

test('#205: the LOCAL-session closing hint is untouched', () => {
  assert.equal(pickWorkspaceNextStep(false), 'Run rw_sync to download its files into the local mirror.')
  assert.match(pickWorkspaceNextStep(true), /this session is LOCAL/)
})
