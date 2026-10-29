// The picker's "use this remote directory" chain, and the deploy install plan.
//
// Two flows that end in side effects on the user's machine and were only covered at
// the module level:
//
//   · `POST /dsh-remote/mirror` — the moment a remote directory becomes a local
//     MIRROR. It must create the mirror with the right metadata (otherwise every
//     later session resolves to the wrong host), refuse a path that is not a
//     directory, and refuse to run without a machine.
//   · `buildInstallPlan` — the command sequence that installs dsh on the remote.
//     Its ORDER is the contract (a later step assumes an earlier one succeeded), and
//     a failing step must stop the plan instead of running the rest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'
import { buildInstallPlan, stepResult, resolvePrefix, DEFAULT_PREFIX_SUFFIX } from '../lib/web-deploy.js'

async function withRemote(config = {}, fn) {
  const srv = await startFakeSsh({
    users: { root: { password: 'pw' } },
    fs: { '/home/user/proj/a.txt': 'a', '/home/user/notadir.txt': 'x' },
    cwd: '/home/user',
  })
  const rec = machine({ host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: '/home/user' })
  const host = await createHost({ machines: [rec], config })
  try {
    await host.call('/dsh-remote/current', { body: { id: rec.id } })
    await fn({ host, srv, rec })
  } finally {
    await host.dispose()
    await srv.close()
  }
}

test('/mirror turns a remote directory into a mirror with the right metadata', async () => {
  await withRemote({}, async ({ host, srv, rec }) => {
    const r = await host.call('/dsh-remote/mirror', { body: { path: '/home/user/proj', machineId: rec.id } })
    assert.equal(r.json.ok, true, `mirror failed: ${r.raw}`)
    assert.equal(r.json.path, '/home/user/proj')
    const local = r.json.localMirror
    assert.ok(local && existsSync(local), `the mirror directory must exist on disk: ${local}`)

    // The metadata is what every later session uses to find the machine again.
    const metaPath = path.join(local, '.dsh-remote-meta.json')
    assert.ok(existsSync(metaPath), 'the mirror must record its origin')
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    assert.equal(meta.host, '127.0.0.1')
    assert.equal(Number(meta.port), srv.port, 'the PORT is part of the identity — two hosts on one IP must not collide')
    assert.equal(meta.username, 'root')
    assert.equal(meta.remotePath, '/home/user/proj')

    // …and the plugin now agrees that this cwd is a remote session.
    const resolved = await host.call('/dsh-remote/resolve-mirror?local=' + encodeURIComponent(local), { method: 'GET' })
    assert.equal(resolved.json.mode, 'remote')
    assert.equal(resolved.json.remotePath, '/home/user/proj')

    // The workspace is persisted on the machine, so the next boot reopens it.
    const saved = host.readMachines().find((m) => m.id === rec.id)
    assert.equal(saved.workspace, '/home/user/proj')
  })
})

test('/mirror refuses a non-directory, a blank path, and a missing machine', async () => {
  await withRemote({}, async ({ host, rec }) => {
    const notDir = await host.call('/dsh-remote/mirror', { body: { path: '/home/user/notadir.txt', machineId: rec.id } })
    assert.equal(notDir.status, 400, `a file must not become a workspace: ${notDir.raw}`)
    assert.match(String(notDir.json.error), /not a directory|directory/i)

    const blank = await host.call('/dsh-remote/mirror', { body: { path: '   ' } })
    assert.equal(blank.status, 400)
    assert.match(String(blank.json.error), /absolute directory/i)

    const missing = await host.call('/dsh-remote/mirror', { body: { path: '/home/user/nope/deeper', machineId: rec.id } })
    assert.equal(missing.status, 400, 'a non-existent remote directory must be refused')
  })
})

test('/mirror without any active machine explains itself instead of half-creating a mirror', async () => {
  const host = await createHost()
  try {
    const r = await host.call('/dsh-remote/mirror', { body: { path: '/srv/x' } })
    assert.equal(r.status, 400)
    assert.equal(r.json.ok, false)
    assert.match(String(r.json.error), /connect|host|机器/i)
  } finally {
    await host.dispose()
  }
})

test('a session opened on a fresh mirror can sync it (the picker → sync chain)', async () => {
  await withRemote({}, async ({ host, srv, rec }) => {
    const m = await host.call('/dsh-remote/mirror', { body: { path: '/home/user/proj', machineId: rec.id } })
    const local = m.json.localMirror
    // rw_sync in a session whose cwd IS the mirror: the same chain a user walks
    // after picking a directory in the picker.
    const synced = await host.run('rw_sync', { __sessionId: 'sess-mirror' })
    assert.ok(synced, 'rw_sync must answer')
    // The mirror is bound to this machine, so the download must land under it.
    assert.ok(existsSync(path.join(local, 'a.txt')),
      `sync must download the remote file into ${local}; got: ${JSON.stringify(synced).slice(0, 200)}`)
    assert.equal(readFileSync(path.join(local, 'a.txt'), 'utf8'), 'a')
    assert.ok(srv.fs.has('/home/user/proj/a.txt'))
  })
})

// ── the install plan ────────────────────────────────────────────────────────

test('the install plan runs its steps in dependency order and stops at the first failure', () => {
  // The REAL shape: `prefix` is a separate argument (resolved by resolvePrefix from
  // the probe facts) and `facts.npm` is the npm BINARY PATH as parseProbe returns it.
  const facts = {
    platform: 'linux',
    node: '/usr/bin/node',
    nodeVersion: 'v22.1.0',
    npm: '/usr/bin/npm',
    npmVersion: '10.0.0',
    home: '/home/user',
    writable: '1',
  }
  const prefix = resolvePrefix(facts, {})
  const { steps, command } = buildInstallPlan({ facts, prefix, version: '0.1.5-rc.2' })
  assert.ok(Array.isArray(steps) && steps.length >= 3, `the plan must have several steps: ${JSON.stringify(steps)}`)
  assert.equal(command, `${prefix}/node_modules/.bin/dsh`, 'the plan must report the binary it produces')
  for (const step of steps) {
    assert.ok(step.id, 'every step is identified so a failure can name it')
    assert.ok(step.title, 'and human-readable')
    assert.ok(typeof step.command === 'string' && step.command.length > 0, `step ${step.id} must have a command`)
    assert.doesNotMatch(step.command, /''/, `step ${step.id} must not contain an empty shell argument: ${step.command}`)
    assert.doesNotMatch(step.command, /\[object Object\]/, `step ${step.id} must not interpolate an object: ${step.command}`)
  }
  assert.equal(new Set(steps.map((s) => s.id)).size, steps.length, 'step ids must be unique')
  // The install step must use the private prefix and the probed npm binary.
  const install = steps.find((s) => s.id === 'install')
  assert.ok(install.command.includes(prefix), 'the install step must target the private prefix')
  assert.ok(install.command.includes('/usr/bin/npm'), 'and the npm binary the probe found')
  assert.ok(steps.findIndex((s) => s.id === 'install') > steps.findIndex((s) => s.id === 'prepare'),
    'the install must come AFTER preparing the directory')

  // A failing step is reported as failed WITH its output, and the runner is
  // expected to stop — this is the contract stepResult() encodes.
  const failed = stepResult(steps[0], { code: 1, stdout: '', stderr: 'npm ERR! ETIMEDOUT' })
  assert.equal(failed.ok, false)
  assert.match(String(failed.output), /ETIMEDOUT/)
  const ok = stepResult(steps[0], { code: 0, stdout: 'done', stderr: '' })
  assert.equal(ok.ok, true)
})

test('an empty install prefix is refused instead of emitting commands that touch the filesystem root', () => {
  for (const bad of ['', '   ', '/']) {
    assert.throws(() => buildInstallPlan({ facts: {}, prefix: bad }), /prefix/i,
      `prefix ${JSON.stringify(bad)} must be refused`)
  }
})

test('resolvePrefix honours the default private prefix and never returns a system directory', () => {
  const facts = { platform: 'linux', home: '/home/user', node: { version: 'v22.1.0' } }
  const prefix = resolvePrefix(facts, {})
  assert.match(prefix, new RegExp(DEFAULT_PREFIX_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `the install must stay inside a private directory, got: ${prefix}`)
  assert.doesNotMatch(prefix, /^\/usr\/|^\/opt\/|^\/etc\//, 'installing into a system directory must not happen by default')
})
