// rw_edit argument aliases (old/new vs old_string/new_string).
//
// Models habitually write old_string/new_string (matching the host's native
// edit tool), which used to fail BEFORE execute with
//   `invalid arguments: missing required property "old"; missing required property "new"`
// because defineTool() validates args against the compiled schema first.
// This file pins the fix: the schema declares both spellings and execute
// resolves either one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Build an isolated DSH_HOME with a machine registry and one mirror. */
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-edit-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })

  const machines = [
    { id: 'm-1', name: 'linuxbox', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw' },
  ]
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: machines, currentId: 'm-1' }))

  const cwd = path.join(root, '127.0.0.11-lucas-1', 'proj')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(path.join(cwd, '.dsh-remote-meta.json'), JSON.stringify({ host: '127.0.0.11', port: 1, username: 'lucas', remotePath: '/home/lucas/proj' }))
  return { home, cwd }
}

function makeCtx() {
  const tools = new Map()
  return {
    ctx: {
      effect: () => {},
      inject: () => {},
      get: () => undefined,
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => {} },
    },
    tools,
  }
}

const execFor = (cwd) => ({ agent: { session: { header: { cwd } } } })

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

async function loadTools(home) {
  process.env.DSH_HOME = home
  const { apply } = await import(`../lib/index.js?edit=${Math.random()}`)
  const { ctx, tools } = makeCtx()
  await apply(ctx, { ...CONFIG })
  return tools
}

test('rw_edit accepts old_string/new_string aliases without an INVALID_ARGS failure', async () => {
  const { home, cwd } = makeHome()
  try {
    const tools = await loadTools(home)
    const edit = tools.get('rw_edit')
    assert.ok(edit, 'rw_edit must be registered')

    const err = await edit.execute({ path: '/home/lucas/proj/a.txt', old_string: 'x', new_string: 'y' }, execFor(cwd))
      .then(() => null, (e) => String(e.message))
    assert.ok(err, 'unreachable host must surface an error')
    assert.ok(!/invalid arguments/.test(err), `aliases must pass arg validation, got: ${err}`)
    assert.match(err, /127\.0\.0\.11/, `must proceed to the SSH stage, got: ${err}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('rw_edit still accepts the original old/new names', async () => {
  const { home, cwd } = makeHome()
  try {
    const tools = await loadTools(home)
    const edit = tools.get('rw_edit')

    const err = await edit.execute({ path: '/home/lucas/proj/a.txt', old: 'x', new: 'y' }, execFor(cwd))
      .then(() => null, (e) => String(e.message))
    assert.ok(err, 'unreachable host must surface an error')
    assert.ok(!/invalid arguments/.test(err), `old/new must still pass arg validation, got: ${err}`)
    assert.match(err, /127\.0\.0\.11/, `must proceed to the SSH stage, got: ${err}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('rw_edit names the missing argument clearly when neither spelling is given', async () => {
  const { home, cwd } = makeHome()
  try {
    const tools = await loadTools(home)
    const edit = tools.get('rw_edit')

    const noOld = await edit.execute({ path: '/home/lucas/proj/a.txt', new: 'y' }, execFor(cwd))
      .then(() => null, (e) => String(e.message))
    assert.match(noOld, /old text is required.*old_string/, `got: ${noOld}`)

    const noNew = await edit.execute({ path: '/home/lucas/proj/a.txt', old: 'x' }, execFor(cwd))
      .then(() => null, (e) => String(e.message))
    assert.match(noNew, /replacement text is required.*new_string/, `got: ${noNew}`)

    // Both spellings may be present; primary names win.
    const both = await edit.execute({ path: '/home/lucas/proj/a.txt', old: 'x', old_string: 'y' }, execFor(cwd))
      .then(() => null, (e) => String(e.message))
    assert.match(both, /replacement text is required/, `got: ${both}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('rw_edit schema declares both spellings', async () => {
  const { home } = makeHome()
  try {
    const tools = await loadTools(home)
    const props = tools.get('rw_edit').parameters.properties
    for (const key of ['old', 'new', 'old_string', 'new_string']) {
      assert.ok(props[key], `parameters must declare ${key}`)
    }
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})
