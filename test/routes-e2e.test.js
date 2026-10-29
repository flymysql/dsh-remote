// End-to-end route tests against a REAL SSH connection (in-process fake server).
//
// Before this file, the fs surface — /ls, /read, /write, /fs (mkdir/rename/remove/
// append/download) — was exercised only through pure-logic helpers or not at all,
// because a real remote was required. Those routes are what the file explorer, the
// editor tab and the workspace picker call, so "it compiled" was the only evidence
// they worked.
//
// Every assertion below is about user-visible behaviour: what the explorer lists,
// what the editor sees, whether a conflicting save is refused, whether a delete
// really removes a tree, whether the downloaded file lands in the mirror.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

const TREE = {
  '/home/user/README.md': '# hello\n',
  '/home/user/src/index.js': 'export const x = 1\n',
  '/home/user/big.txt': 'x'.repeat(5000),
  '/home/user/bin.dat': Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]),
  '/home/user/docs/a.txt': 'a\n',
  '/home/user/docs/nested/b.txt': 'b\n',
}

/** Boot a host bound to a fake remote that has TREE, and make it the current machine. */
async function withRemote(config = {}, fn) {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: TREE, cwd: '/home/user' })
  const rec = machine({ host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: '/home/user' })
  const host = await createHost({ machines: [rec], config })
  try {
    const cur = await host.call('/dsh-remote/current', { body: { id: rec.id } })
    assert.equal(cur.json.ok, true, 'binding the machine must succeed')
    await fn({ host, srv, rec })
  } finally {
    await host.dispose()
    await srv.close()
  }
}

const q = (p) => '?path=' + encodeURIComponent(p)

test('/status reports the bound machine and its workspace', async () => {
  await withRemote({}, async ({ host, srv }) => {
    const r = await host.call('/dsh-remote/status', { method: 'GET' })
    assert.equal(r.status, 200)
    assert.equal(r.json.host, '127.0.0.1')
    assert.equal(r.json.port, srv.port)
    assert.equal(r.json.username, 'root')
    assert.equal(r.json.workspace, '/home/user')
    assert.equal(r.json.activeSource, 'machine')
  })
})

test('/ls lists a directory with types and sizes, and reports a missing dir instead of failing', async () => {
  await withRemote({}, async ({ host }) => {
    const ok = await host.call('/dsh-remote/ls' + q('/home/user'), { method: 'GET' })
    assert.equal(ok.status, 200)
    const names = ok.json.items.map((i) => i.name).sort()
    assert.deepEqual(names, ['README.md', 'big.txt', 'bin.dat', 'docs', 'src'])
    const dir = ok.json.items.find((i) => i.name === 'docs')
    assert.equal(dir.type, 'dir')
    const file = ok.json.items.find((i) => i.name === 'README.md')
    assert.equal(file.type, 'file')
    assert.equal(file.size, 8)
    assert.equal(file.path, '/home/user/README.md', 'each item carries its full path for the UI')
    assert.equal(ok.json.missing, false)
    assert.equal(ok.json.platform, 'posix')

    const missing = await host.call('/dsh-remote/ls' + q('/home/user/nope'), { method: 'GET' })
    assert.equal(missing.status, 200, 'a missing directory is a normal answer, not a 500')
    assert.equal(missing.json.missing, true)
    assert.deepEqual(missing.json.items, [])
  })
})

test('/read returns text, flags truncation and binary content, and errors on a missing file', async () => {
  await withRemote({}, async ({ host }) => {
    const txt = await host.call('/dsh-remote/read' + q('/home/user/README.md'), { method: 'GET' })
    assert.equal(txt.json.ok, true)
    assert.equal(txt.json.content, '# hello\n')
    assert.equal(txt.json.binary, false)
    assert.equal(txt.json.truncated, false)

    const cut = await host.call('/dsh-remote/read' + q('/home/user/big.txt') + '&maxBytes=100', { method: 'GET' })
    assert.equal(cut.json.truncated, true, 'a capped read must say it was truncated')
    // The route clamps maxBytes to a 1 KiB floor (a 100-byte cap is useless) and
    // appends a "…[truncated: N more bytes]" marker, so the guarantee is: the
    // content is the first ~1 KiB plus that marker, never the whole 5000 bytes.
    assert.ok(cut.json.content.length < 5000, `truncated content must be shorter than the file, got ${cut.json.content.length}`)
    assert.ok(cut.json.content.length <= 1024 + 120, `the read must respect the 1 KiB floor, got ${cut.json.content.length}`)
    assert.match(cut.json.content, /truncated: \d+ more bytes/, 'the truncation must be visible IN the content the editor shows')

    const bin = await host.call('/dsh-remote/read' + q('/home/user/bin.dat'), { method: 'GET' })
    assert.equal(bin.json.binary, true, 'a NUL-containing file must be reported as binary, not rendered')

    const gone = await host.call('/dsh-remote/read' + q('/home/user/absent.txt'), { method: 'GET' })
    assert.equal(gone.status, 500)
    assert.equal(gone.json.ok, false)
    assert.ok(gone.json.error && gone.json.error.length > 0)
  })
})

test('/write creates the file (and its parent dirs), and refuses a stale save with 409', async () => {
  await withRemote({}, async ({ host, srv }) => {
    const w = await host.call('/dsh-remote/write', {
      body: { path: '/home/user/new/deep/file.txt', content: 'written by the test' },
    })
    assert.equal(w.json.ok, true, `write failed: ${w.json.error}`)
    assert.equal(w.json.bytes, 19)
    assert.equal(srv.fs.readText('/home/user/new/deep/file.txt'), 'written by the test',
      'the write must land on the remote, and parent directories must be created')

    // A stale editor buffer (mtime mismatch) must NOT overwrite.
    const conflict = await host.call('/dsh-remote/write', {
      body: { path: '/home/user/new/deep/file.txt', content: 'stale', expectedMtime: 1 },
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.ok, false)
    assert.match(String(conflict.json.error), /已变化|重新读取/)
    assert.equal(srv.fs.readText('/home/user/new/deep/file.txt'), 'written by the test', 'the stale write must be refused')
  })
})

test('/fs mkdir, rename, append and remove all act on the remote tree', async () => {
  await withRemote({}, async ({ host, srv }) => {
    const mk = await host.call('/dsh-remote/fs', { body: { op: 'mkdir', path: '/home/user/created' } })
    assert.equal(mk.json.ok, true, `mkdir failed: ${mk.json.error}`)
    assert.ok(srv.fs.has('/home/user/created'))

    const rn = await host.call('/dsh-remote/fs', {
      body: { op: 'rename', path: '/home/user/created', dest: '/home/user/renamed' },
    })
    assert.equal(rn.json.ok, true, `rename failed: ${rn.json.error}`)
    assert.equal(srv.fs.has('/home/user/created'), false)
    assert.ok(srv.fs.has('/home/user/renamed'))

    const ap = await host.call('/dsh-remote/fs', { body: { op: 'append', path: '/home/user/README.md', content: 'more\n' } })
    assert.equal(ap.json.ok, true, `append failed: ${ap.json.error}`)
    assert.equal(srv.fs.readText('/home/user/README.md'), '# hello\nmore\n')

    const wr = await host.call('/dsh-remote/fs', { body: { op: 'write', path: '/home/user/docs/a.txt', content: 'A' } })
    assert.equal(wr.json.ok, true)
    assert.equal(srv.fs.readText('/home/user/docs/a.txt'), 'A', 'op=write replaces, it does not append')

    // Removing a DIRECTORY must take its subtree with it.
    const rm = await host.call('/dsh-remote/fs', { body: { op: 'remove', path: '/home/user/docs' } })
    assert.equal(rm.json.ok, true, `remove failed: ${rm.json.error}`)
    assert.equal(srv.fs.has('/home/user/docs'), false)
    assert.equal(srv.fs.has('/home/user/docs/nested/b.txt'), false, 'the whole tree must be gone')

    const missing = await host.call('/dsh-remote/fs', { body: { op: 'remove', path: '/home/user/nope' } })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.ok, false)

    const unknown = await host.call('/dsh-remote/fs', { body: { op: 'nonsense' } })
    assert.equal(unknown.status, 400)
    assert.match(String(unknown.json.error), /unknown op/)
  })
})

test('/fs download puts the file into the machine mirror', async () => {
  await withRemote({}, async ({ host }) => {
    const d = await host.call('/dsh-remote/fs', { body: { op: 'download', path: '/home/user/src/index.js' } })
    assert.equal(d.json.ok, true, `download failed: ${d.json.error}`)
    assert.ok(d.json.local, 'the answer names the local path it wrote')
    assert.equal(readFileSync(d.json.local, 'utf8'), 'export const x = 1\n')
    assert.ok(d.json.local.includes('remote-workspaces'), 'the file belongs in the plugin mirror, not anywhere else')
  })
})

test('/home resolves the remote home directory through the shell', async () => {
  await withRemote({}, async ({ host, srv }) => {
    const r = await host.call('/dsh-remote/home', { body: {} })
    assert.equal(r.json.ok, true, `home failed: ${r.json.error}`)
    assert.equal(r.json.home, '/home/user', '`echo ~` is answered by the remote shell')
    assert.ok(srv.execLog.some((c) => /echo ~/.test(c)), 'the route must ask the remote, not guess')
  })
})

test('/workspace switches the bound workspace, and /status follows', async () => {
  await withRemote({}, async ({ host }) => {
    const w = await host.call('/dsh-remote/workspace', { body: { path: '/home/user/src' } })
    assert.equal(w.status, 200)
    const st = await host.call('/dsh-remote/status', { method: 'GET' })
    assert.equal(st.json.workspace, '/home/user/src')
  })
})

test('auditLog records file operations, and /audit returns them', async () => {
  await withRemote({ auditLog: true }, async ({ host }) => {
    await host.call('/dsh-remote/write', { body: { path: '/home/user/audited.txt', content: 'x' } })
    const a = await host.call('/dsh-remote/audit?limit=50', { method: 'GET' })
    assert.equal(a.json.ok, true)
    assert.equal(a.json.auditEnabled, true)
    assert.ok(a.json.lines.length > 0, 'a write with auditLog on must produce an audit line')
    assert.ok(a.json.lines.some((l) => /audited\.txt/.test(l)), `audit lines: ${JSON.stringify(a.json.lines).slice(0, 200)}`)
  })
})

test('/ssh-config lists the Host blocks of the configured ssh config file', async () => {
  // The suite points DSH_REMOTE_SSH_CONFIG at a temp file (test/setup-telemetry-off.mjs),
  // so this asserts both the parser AND the isolation: the REAL ~/.ssh/config is
  // never read or written by a test run.
  const cfgPath = process.env.DSH_REMOTE_SSH_CONFIG
  assert.ok(cfgPath, 'the suite must isolate the ssh config file')
  mkdirSync(path.dirname(cfgPath), { recursive: true })
  writeFileSync(cfgPath, 'Host mybox\n  HostName 10.1.2.3\n  User someone\n  Port 2200\n', 'utf8')
  const host = await createHost()
  try {
    const r = await host.call('/dsh-remote/ssh-config', { method: 'GET' })
    assert.equal(r.json.ok, true)
    assert.equal(r.json.present, true)
    assert.equal(r.json.file, cfgPath, 'the route must read the file the suite isolated')
    const entry = r.json.entries.find((e) => e.host === 'mybox')
    assert.ok(entry, `entries: ${JSON.stringify(r.json.entries)}`)
    assert.equal(entry.hostName, '10.1.2.3')
    assert.equal(entry.port, 2200)
  } finally {
    await host.dispose()
    if (existsSync(cfgPath)) writeFileSync(cfgPath, '', 'utf8')
  }
})
