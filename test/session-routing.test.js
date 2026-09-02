// End-to-end session routing through the REAL apply() (issue #25).
//
// test/binding.test.js pins the reverse-lookup in isolation. This file pins the
// property that actually matters: when two concurrent sessions are bound to
// DIFFERENT machines, the registered rw_* tools connect to each session's own
// host — no matter which machine is "active" and no matter what another session
// did in between.
//
// The SSH layer is not mocked at the module level. Instead each pool is allowed
// to fail its connect (no such host), and the assertions read the host each
// attempt was made against: an attempt against the wrong host is exactly the
// bug, so a wrong-host connect must be observable rather than swallowed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Build an isolated DSH_HOME with a machine registry and two mirrors. */
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-route-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })

  const machines = [
    { id: 'm-linux', name: 'linuxbox', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw-linux' },
    { id: 'm-win', name: 'winbox', host: '127.0.0.22', port: 1, username: 'Administrator', password: 'pw-win' },
  ]
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: machines, currentId: 'm-win' }))

  const mirror = (host, user, port, base, remotePath) => {
    const dir = path.join(root, `${host}-${user}-${port}`, base)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({ host, port, username: user, remotePath }))
    return dir
  }
  return {
    home,
    linuxCwd: mirror('127.0.0.11', 'lucas', 1, 'proj', '/home/lucas/proj'),
    winCwd: mirror('127.0.0.22', 'Administrator', 1, 'tool', 'C:\\work\\tool'),
  }
}

/** Minimal ctx: apply() needs effect/get/tools/systemPrompt; webServer and
 *  commands are optional and left absent so no ports are opened. */
function makeCtx(sessions) {
  const tools = new Map()
  return {
    ctx: {
      effect: () => {},
      get: (k) => (k === 'sessions' ? sessions : undefined),
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => {} },
    },
    tools,
  }
}

/** A tool-execution context carrying one session's cwd, as the agent loop passes. */
const execFor = (cwd) => ({ agent: { session: { header: { cwd } } } })

/** Load apply() with DSH_HOME pointed at an isolated home. */
async function loadPlugin(home) {
  process.env.DSH_HOME = home
  // Cache-bust so each test observes a fresh module-level state.
  const mod = await import(`../lib/index.js?route=${Math.random()}`)
  return mod
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

test('two sessions on different machines each act on THEIR OWN host', async () => {
  const { home, linuxCwd, winCwd } = makeHome()
  try {
    const { apply } = await loadPlugin(home)
    const { ctx, tools } = makeCtx({ get: () => null, list: () => [] })
    await apply(ctx, { ...CONFIG })

    const exec = tools.get('rw_exec')
    assert.ok(exec, 'rw_exec must be registered')

    // Both sessions run the same command. Each connect fails (the hosts are
    // reserved documentation addresses), but the FAILURE NAMES THE HOST it was
    // attempted against — which is precisely what must differ per session.
    const linuxErr = await exec.execute({ command: 'hostname' }, execFor(linuxCwd)).then(() => null, (e) => String(e.message))
    const winErr = await exec.execute({ command: 'hostname' }, execFor(winCwd)).then(() => null, (e) => String(e.message))

    assert.ok(linuxErr, 'unreachable host must surface an error, not a silent success')
    assert.ok(winErr)
    assert.match(linuxErr, /127\.0\.0\.11/, `linux session must target its own host, got: ${linuxErr}`)
    assert.ok(!linuxErr.includes('127.0.0.22'), 'linux session must NOT touch the other machine')
    assert.match(winErr, /127\.0\.0\.22/, `windows session must target its own host, got: ${winErr}`)
    assert.ok(!winErr.includes('127.0.0.11'), 'windows session must NOT touch the other machine')
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('interleaving sessions does not redirect either one (the wrong-host regression)', async () => {
  const { home, linuxCwd, winCwd } = makeHome()
  try {
    const { apply } = await loadPlugin(home)
    const { ctx, tools } = makeCtx({ get: () => null, list: () => [] })
    await apply(ctx, { ...CONFIG })
    const exec = tools.get('rw_exec')

    // Alternate A/B/A/B, the pattern that produced the wrong-host audit entry.
    const seen = []
    for (const cwd of [linuxCwd, winCwd, linuxCwd, winCwd, linuxCwd]) {
      const err = await exec.execute({ command: 'hostname' }, execFor(cwd)).then(() => '', (e) => String(e.message))
      seen.push({ cwd, err })
    }
    for (const { cwd, err } of seen) {
      const own = cwd === linuxCwd ? '127.0.0.11' : '127.0.0.22'
      const other = cwd === linuxCwd ? '127.0.0.22' : '127.0.0.11'
      assert.ok(err.includes(own), `every call must stay on its own host; got: ${err}`)
      assert.ok(!err.includes(other), `a session was redirected to ${other}: ${err}`)
    }
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('a session-bound tool uses the mirror workspace, not the active machine workspace', async () => {
  const { home, linuxCwd } = makeHome()
  try {
    const { apply } = await loadPlugin(home)
    const { ctx, tools } = makeCtx({ get: () => null, list: () => [] })
    // The active machine (currentId m-win) carries a DIFFERENT workspace.
    await apply(ctx, { ...CONFIG, host: '127.0.0.22', username: 'Administrator', workspace: 'C:\\work\\tool' })

    const err = await tools.get('rw_exec').execute({ command: 'pwd' }, execFor(linuxCwd)).then(() => '', (e) => String(e.message))
    // The command must be routed to the linux machine despite the active one
    // being the windows box with its own workspace.
    assert.match(err, /127\.0\.0\.11/, `expected the session's own machine, got: ${err}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('a LOCAL session refuses instead of falling back to the active machine', async () => {
  const { home } = makeHome()
  try {
    const { apply } = await loadPlugin(home)
    const { ctx, tools } = makeCtx({ get: () => null, list: () => [] })
    await apply(ctx, { ...CONFIG })

    // A cwd outside every mirror: silently borrowing the active machine here is
    // how a command reached an unintended host, so this must refuse.
    const err = await tools.get('rw_exec')
      .execute({ command: 'rm -rf /tmp/x' }, execFor('/root/some/local/repo'))
      .then(() => null, (e) => String(e.message))

    assert.ok(err, 'a local session must not silently execute against a remote')
    assert.match(err, /this session is LOCAL/)
    // The refusal must not have attempted any host.
    assert.ok(!/127\.0\.0\.(11|22)/.test(err), `refusal must not touch a machine: ${err}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('a LOCAL session is refused even when the ACTIVE machine has a workspace', async () => {
  const { home } = makeHome()
  try {
    const { apply } = await loadPlugin(home)
    const { ctx, tools } = makeCtx({ get: () => null, list: () => [] })
    // The regression: the active machine carries a non-empty workspace, so a
    // guard that only checks "is there a workspace?" passes and the local
    // session inherits another session's machine. Every session-scoped tool
    // must refuse on the SESSION's own binding instead.
    await apply(ctx, { ...CONFIG, host: '127.0.0.22', username: 'Administrator', workspace: 'C:\\work\\tool' })

    const localCwd = '/root/some/local/repo'
    const cases = [
      ['rw_exec', { command: 'hostname' }],
      ['rw_write_file', { path: '/tmp/evil', content: 'x' }],
      ['rw_remove', { path: '/tmp/victim' }],
      ['rw_move', { path: '/tmp/a', dest: '/tmp/b' }],
      ['rw_read_file', { path: '/etc/hostname' }],
      ['rw_list_dir', {}],
    ]
    for (const [name, args] of cases) {
      const err = await tools.get(name).execute(args, execFor(localCwd)).then(() => null, (e) => String(e.message))
      assert.ok(err, `${name} must refuse a local session`)
      assert.match(err, /this session is LOCAL/, `${name} gave: ${err}`)
      assert.ok(!/ECONNREFUSED|ETIMEDOUT|handshake/i.test(err), `${name} must refuse BEFORE connecting: ${err}`)
    }
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('sessions on the SAME machine share one pool (connection reuse is preserved)', async () => {
  const { home } = makeHome()
  try {
    const root = path.join(home, 'remote-workspaces')
    // Two workspaces on ONE machine → two sessions that must share a connection.
    const mk = (base, remotePath) => {
      const dir = path.join(root, '127.0.0.11-lucas-1', base)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({ host: '127.0.0.11', port: 1, username: 'lucas', remotePath }))
      return dir
    }
    const a = mk('svc-a', '/srv/a')
    const b = mk('svc-b', '/srv/b')

    const { poolKey } = await import('../lib/binding.js')
    const { resolveMirror } = await import('../lib/binding.js')
    const ka = poolKey(resolveMirror(a, root).machine)
    const kb = poolKey(resolveMirror(b, root).machine)
    assert.equal(ka, kb, 'same machine must map to one pool key')
    // …while their workspace roots stay independent.
    assert.notEqual(resolveMirror(a, root).remotePath, resolveMirror(b, root).remotePath)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
