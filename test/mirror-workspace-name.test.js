// The remote workspace must be distinguishable from a LOCAL workspace of the
// same folder name.
//
// DSH derives a Workspace title from the basename of the directory it registers.
// A remote workspace is registered on its local MIRROR
// (`$DSH_HOME/remote-workspaces/<host>-<user>-<port>/<basename>`), whose last
// segment is still the remote basename — so a local /mnt/xdfs and a remote
// /mnt/xdfs both read "xdfs". The core Workspace Create API takes a path only,
// so the plugin's fix is to create the record itself, before the picker hands
// the mirror back to the core's `workspace.create({ path })`: that call resolves
// the canonical path to our record and reuses it, title included.
//
// These tests pin the contract of that pre-registration:
//   · the title is `<machine name>-<remote basename>`
//   · an existing workspace is never renamed (the user may have renamed it)
//   · a title already in use gets a numeric suffix
//   · callers that only pick a folder can opt out (no stray workspace)
//   · any registry failure is best-effort and never fails the mirror itself
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

/**
 * A minimal stand-in for `ctx.workspaceRegistry` (the Harness service).
 * Mirrors the two methods the plugin contract uses plus `list()` for title
 * uniqueness; records exactly what was created.
 */
function fakeWorkspaceRegistry(seed = []) {
  const rows = seed.map((row, i) => ({ workspaceId: `w-${i}`, ...row }))
  return {
    rows,
    creates: [],
    list() { return rows.map((row) => ({ ...row })) },
    async resolveByPath(p) { return rows.find((row) => row.path === p) },
    async create(path, title) {
      this.creates.push({ path, title })
      const row = { workspaceId: `w-created-${this.creates.length}`, path, title }
      rows.push(row)
      return row
    },
  }
}

/** Boot a host against a fake SSH server that has `/home/user/proj`. */
async function withRemote(registry, fn) {
  const srv = await startFakeSsh({
    users: { root: { password: 'pw' } },
    fs: { '/home/user/proj/a.txt': 'a' },
    cwd: '/home/user',
  })
  const rec = machine({ name: 'code-server', host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: '/home/user' })
  const host = await createHost({ machines: [rec], services: { workspaceRegistry: registry } })
  try {
    await host.call('/dsh-remote/current', { body: { id: rec.id } })
    await fn({ host, srv, rec })
  } finally {
    await host.dispose()
    await srv.close()
  }
}

test('/mirror pre-registers the workspace with a machine-qualified title', async () => {
  const registry = fakeWorkspaceRegistry()
  await withRemote(registry, async ({ host, rec }) => {
    const r = await host.call('/dsh-remote/mirror', { body: { path: '/home/user/proj', machineId: rec.id } })
    assert.equal(r.status, 200, r.raw)
    assert.equal(r.json.ok, true)

    assert.equal(registry.creates.length, 1, 'the picker path must create exactly one Workspace record')
    assert.equal(registry.creates[0].path, r.json.localMirror, 'the record must point at the local mirror the core will adopt')
    assert.equal(registry.creates[0].title, 'code-server-proj', 'local `proj` and remote `proj` must not share a title')
  })
})

test('/mirror never renames a workspace that already exists', async () => {
  const registry = fakeWorkspaceRegistry()
  await withRemote(registry, async ({ host, rec }) => {
    const body = { path: '/home/user/proj', machineId: rec.id }
    await host.call('/dsh-remote/mirror', { body })
    assert.equal(registry.creates.length, 1)

    // The user renames the workspace in the sidebar, then reopens the same
    // folder from the picker: the second commit must keep the chosen name.
    registry.rows[0].title = 'my-own-name'
    const again = await host.call('/dsh-remote/mirror', { body })
    assert.equal(again.json.ok, true)
    assert.equal(registry.creates.length, 1, 'an existing workspace must not be re-created')
    assert.equal(registry.rows[0].title, 'my-own-name', 'a user rename must survive a re-pick')
  })
})

test('/mirror does not create a workspace when the caller only picked a folder', async () => {
  const registry = fakeWorkspaceRegistry()
  await withRemote(registry, async ({ host, rec }) => {
    const r = await host.call('/dsh-remote/mirror', {
      body: { path: '/home/user/proj', machineId: rec.id, registerWorkspace: false },
    })
    assert.equal(r.json.ok, true, 'the mirror itself must still be created')
    assert.ok(existsSync(r.json.localMirror), 'the mirror directory must exist on disk')
    assert.equal(registry.creates.length, 0, 'settings / Remote Files must not grow a stray workspace')
  })
})

test('/mirror de-duplicates a title another workspace already owns', async () => {
  const registry = fakeWorkspaceRegistry([{ path: '/elsewhere/proj', title: 'code-server-proj' }])
  await withRemote(registry, async ({ host, rec }) => {
    const r = await host.call('/dsh-remote/mirror', { body: { path: '/home/user/proj', machineId: rec.id } })
    assert.equal(r.json.ok, true)
    assert.equal(registry.creates.length, 1)
    assert.equal(registry.creates[0].title, 'code-server-proj-2', 'duplicate titles must get a suffix')
  })
})

test('a failing workspace registry never fails the mirror', async () => {
  const registry = fakeWorkspaceRegistry()
  registry.create = async () => { throw new Error('workspace registry unavailable') }
  await withRemote(registry, async ({ host, rec }) => {
    const r = await host.call('/dsh-remote/mirror', { body: { path: '/home/user/proj', machineId: rec.id } })
    assert.equal(r.status, 200, 'naming is best-effort; the mirror the user picked must still succeed')
    assert.equal(r.json.ok, true)
    assert.ok(existsSync(r.json.localMirror))
  })
})
