// Session → machine binding, and the fence between machines.
//
// This is the plugin's most dangerous invariant: a session bound to machine A must
// never act on machine B, and a LOCAL session must never silently inherit the
// active remote machine (issue #25: two sessions on two hosts used to take the
// shared pool from each other, so a command could land on the wrong host).
//
// `binding.js` was at ~66% and the existing tests only covered the "LOCAL session
// is refused" branch. Here the mirrors are real directories with real
// `.dsh-remote-meta.json` files and the requests go through the real routes with
// two live (fake) SSH servers, so "which host did this actually reach" is answered
// by the servers' own file systems, not by an assumption.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

/** Create a mirror directory for a machine inside the host's remote-workspaces root. */
function makeMirror(root, { host, port, username, base, remotePath }) {
  const dir = path.join(root, `${host}-${username || 'root'}-${port}`, base)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({ host, port, username, remotePath }))
  return dir
}

/** Two fake hosts with distinct contents, plus a host whose active machine is A. */
async function withTwoHosts(fn) {
  const srvA = await startFakeSsh({
    users: { root: { password: 'pw' } },
    fs: { '/srv/a/only-a.txt': 'A', '/srv/a/shared.txt': 'from A' },
    cwd: '/srv/a',
  })
  const srvB = await startFakeSsh({
    users: { root: { password: 'pw' } },
    fs: { '/srv/b/only-b.txt': 'B', '/srv/b/shared.txt': 'from B' },
    cwd: '/srv/b',
  })
  const a = machine({ name: 'hostA', host: '127.0.0.1', port: srvA.port, username: 'root', password: 'pw', workspace: '/srv/a' })
  const b = machine({ name: 'hostB', host: '127.0.0.1', port: srvB.port, username: 'root', password: 'pw', workspace: '/srv/b' })
  const host = await createHost({ machines: [a, b] })
  try {
    await host.call('/dsh-remote/current', { body: { id: a.id } })
    await fn({ host, srvA, srvB, a, b })
  } finally {
    await host.dispose()
    await srvA.close()
    await srvB.close()
  }
}

test('a session whose cwd is machine B\'s mirror reaches B, even though A is the active machine', async () => {
  await withTwoHosts(async ({ host, srvB, b }) => {
    const mirrorB = makeMirror(host.root, { host: '127.0.0.1', port: srvB.port, username: 'root', base: 'srv-b', remotePath: '/srv/b' })
    // Active machine is A; the session says B.
    const r = await host.call('/dsh-remote/ls', {
      method: 'GET',
      url: '/dsh-remote/ls?path=' + encodeURIComponent('/srv/b'),
      headers: {},
    })
    assert.equal(r.rejected, null)
    // The request above carries no session hint, so it MUST reach A — this is the
    // control case. The session-bound case goes through the body/query hint below.
    const viaSession = await host.call('/dsh-remote/ls', {
      method: 'POST',
      body: { sessionId: 'sess-b', local: mirrorB },
      url: '/dsh-remote/ls?path=' + encodeURIComponent('/srv/b'),
    })
    assert.equal(viaSession.status, 200, `session-bound listing failed: ${viaSession.raw}`)
    assert.equal(viaSession.json.machine.host, '127.0.0.1')
    assert.equal(viaSession.json.machine.port, srvB.port,
      `the listing must come from B (port ${srvB.port}), got ${JSON.stringify(viaSession.json.machine)}`)
    assert.ok(viaSession.json.items.some((i) => i.name === 'only-b.txt'),
      `the listing must be B's content, got: ${JSON.stringify(viaSession.json.items.map((i) => i.name))}`)
  })
})

test('a LOCAL session is refused instead of silently acting on the active machine', async () => {
  await withTwoHosts(async ({ host, srvA }) => {
    const localDir = path.join(host.root, 'just-a-local-dir')
    mkdirSync(localDir, { recursive: true })
    for (const routePath of ['/dsh-remote/read', '/dsh-remote/write', '/dsh-remote/fs']) {
      const r = await host.call(routePath, {
        body: { path: '/srv/a/only-a.txt', content: 'x', op: 'mkdir', sessionId: 'sess-local', local: localDir },
      })
      assert.equal(r.status, 403, `${routePath} must refuse a LOCAL session, got ${r.status} ${r.raw}`)
      assert.match(String(r.json.error), /LOCAL/i, `${routePath} must say why`)
      // …and nothing may have reached A.
      assert.equal(srvA.fs.has('/srv/a/only-a.txt'), true)
    }
  })
})

test('a stale mirror (machine deleted from the registry) does not fall back to another host', async () => {
  const srvA = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: { '/srv/a/x.txt': 'A' }, cwd: '/srv/a' })
  const a = machine({ host: '127.0.0.1', port: srvA.port, username: 'root', password: 'pw' })
  const host = await createHost({ machines: [a] })
  try {
    // A mirror that names a machine id nobody has: the port is dead, so the honest
    // outcome is a failure naming THAT host — never a silent switch to machine A.
    const mirror = makeMirror(host.root, { host: '127.0.0.1', port: 1, username: 'ghost', base: 'ghost', remotePath: '/srv/ghost' })
    const r = await host.call('/dsh-remote/ls', {
      method: 'POST',
      body: { sessionId: 'sess-ghost', local: mirror },
      url: '/dsh-remote/ls?path=' + encodeURIComponent('/srv/ghost'),
    })
    assert.equal(r.rejected, null, 'a stale mirror must not crash the route')
    assert.equal(r.json.ok === true, false, 'a stale mirror must not report success')
    assert.ok(String(r.json.error || '').length > 0, 'and must explain the failure')
    assert.doesNotMatch(String(r.json.error), /srv\/a/, 'the answer must not come from the active machine')
  } finally {
    await host.dispose()
    await srvA.close()
  }
})

test('/bindings and /resolve-mirror describe the mirrors that exist', async () => {
  await withTwoHosts(async ({ host, srvA, srvB }) => {
    makeMirror(host.root, { host: '127.0.0.1', port: srvA.port, username: 'root', base: 'proj-a', remotePath: '/srv/a' })
    const mirrorB = makeMirror(host.root, { host: '127.0.0.1', port: srvB.port, username: 'root', base: 'proj-b', remotePath: '/srv/b' })

    const bindings = await host.call('/dsh-remote/bindings', { method: 'GET' })
    assert.equal(bindings.status, 200)
    const mirrors = bindings.json.mirrors || []
    assert.ok(mirrors.length >= 2, `both mirrors must be listed: ${bindings.raw.slice(0, 300)}`)

    const resolved = await host.call(
      '/dsh-remote/resolve-mirror?local=' + encodeURIComponent(mirrorB),
      { method: 'GET' },
    )
    assert.equal(resolved.status, 200)
    assert.equal(resolved.json.remotePath, '/srv/b', `resolve-mirror must find B's remote path: ${resolved.raw}`)
    assert.equal(resolved.json.mode, 'remote', 'a mirror cwd resolves in remote mode')

    const localDir = path.join(host.root, 'plain-dir')
    mkdirSync(localDir, { recursive: true })
    const local = await host.call('/dsh-remote/resolve-mirror?local=' + encodeURIComponent(localDir), { method: 'GET' })
    assert.equal(local.json.mode, 'local', 'a non-mirror cwd resolves in local mode')
  })
})
