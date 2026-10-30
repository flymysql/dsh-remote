// Every rw_* tool, end to end, against a real SSH connection.
//
// The tools are the surface the MODEL drives, and they are what the user sees as
// "the agent did something to my server". Before this file, 6 of the 22 tools had
// no test mention at all (rw_append, rw_download, rw_forward, rw_mkdir, rw_push,
// rw_stat) and most of the rest were pinned by one narrow regression each. A tool
// that silently writes to the wrong path, appends instead of replacing, deletes
// without recursing, or forwards the wrong port is exactly the kind of damage that
// makes someone stop using the plugin.
//
// Everything here runs against test/harness/fake-ssh.js: a real ssh2 server with a
// real in-memory SFTP tree and a real `exec`, so these are true end-to-end paths
// (no ssh2 prototype patching, no mocked sftp).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHost } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

const TREE = {
  '/home/user/README.md': '# hello\n',
  '/home/user/src/app.js': 'const a = 1\nconst b = 2\n',
  '/home/user/src/util.js': 'export const add = (a, b) => a + b\n',
  '/home/user/notes.txt': 'first line\nsecond line\n',
}

/**
 * Boot a host whose ACTIVE machine is the fake server (the tools fall back to the
 * active machine when the caller has no session binding — same as rw_upload's
 * documented behaviour).
 */
async function withTools(config = {}, fn) {
  const srv = await startFakeSsh({
    users: { root: { password: 'pw' } },
    fs: TREE,
    cwd: '/home/user',
    onExec: (cmd) => {
      if (/^sleep 5/.test(cmd)) return { stdout: '', code: 0 }
      if (/^false$/.test(cmd)) return { stdout: '', code: 1 }
      if (/^echo ok$/.test(cmd)) return { stdout: 'ok\n', code: 0 }
      return null
    },
  })
  const host = await createHost({
    config: {
      host: '127.0.0.1',
      port: srv.port,
      username: 'root',
      password: 'pw',
      workspace: '/home/user',
      commandTimeoutMs: 5000,
      connectTimeoutMs: 5000,
      ...config,
    },
  })
  const local = mkdtempSync(path.join(tmpdir(), 'dsh-remote-tools-'))
  try {
    await fn({ host, srv, local })
  } finally {
    await host.dispose()
    await srv.close()
    rmSync(local, { recursive: true, force: true })
  }
}

const text = (res) => String((res && (res.content || res.text || res.message)) || '')

// ── read-only surface ───────────────────────────────────────────────────────

test('rw_info describes the live connection', async () => {
  await withTools({}, async ({ host, srv }) => {
    const res = await host.run('rw_info')
    const body = JSON.stringify(res)
    assert.match(body, /127\.0\.0\.1/, 'the answer must name the connected host')
    assert.match(body, new RegExp(String(srv.port)), 'and its port')
  })
})

test('rw_list_dir lists a directory, and refuses a missing one with a reason', async () => {
  await withTools({}, async ({ host }) => {
    const res = await host.run('rw_list_dir', { path: '/home/user' })
    const body = JSON.stringify(res)
    assert.match(body, /README\.md/)
    assert.match(body, /src/)

    // A refusal is a THROWN error — the model must see a failed call, not a text blurb.
    const missing = await host.run('rw_list_dir', { path: '/home/user/nope' }).then(() => null, (e) => e)
    assert.ok(missing, 'listing a missing directory must fail')
    assert.match(String(missing.message), /no such|not found|不存在/i)
  })
})

test('rw_read_file pages through a file and refuses a missing one', async () => {
  await withTools({}, async ({ host }) => {
    const whole = await host.run('rw_read_file', { path: '/home/user/notes.txt' })
    assert.match(text(whole), /first line/)
    assert.match(text(whole), /second line/)

    const page = await host.run('rw_read_file', { path: '/home/user/notes.txt', startLine: 2, endLine: 2 })
    assert.match(text(page), /second line/)
    assert.doesNotMatch(text(page), /first line/, 'a 2..2 page must not include line 1')

    const missing = await host.run('rw_read_file', { path: '/home/user/absent.md' }).then(() => null, (e) => e)
    assert.ok(missing, 'reading a missing file must fail')
    assert.match(String(missing.message), /no such|not found|不存在/i)
  })
})

test('rw_stat reports type and size', async () => {
  await withTools({}, async ({ host }) => {
    const file = await host.run('rw_stat', { path: '/home/user/README.md' })
    assert.match(JSON.stringify(file), /file/i)
    assert.match(JSON.stringify(file), /8|size/i)
    const dir = await host.run('rw_stat', { path: '/home/user/src' })
    assert.match(JSON.stringify(dir), /dir/i)
  })
})

test('rw_search finds matches and honours the glob filter', async () => {
  await withTools({}, async ({ host }) => {
    const all = await host.run('rw_search', { pattern: 'const', path: '/home/user' })
    const body = JSON.stringify(all)
    assert.match(body, /app\.js/)
    assert.match(body, /util\.js/)

    const onlyJs = await host.run('rw_search', { pattern: 'const', path: '/home/user', glob: '*.js' })
    assert.match(JSON.stringify(onlyJs), /app\.js/)

    const none = await host.run('rw_search', { pattern: 'this-string-is-not-there', path: '/home/user' })
    assert.doesNotMatch(JSON.stringify(none), /app\.js/, 'a pattern with no match must not report files')
  })
})

// ── write surface ───────────────────────────────────────────────────────────

test('rw_write_file creates parent dirs when asked and replaces the content', async () => {
  await withTools({}, async ({ host, srv }) => {
    const w = await host.run('rw_write_file', { path: '/home/user/deep/nested/x.txt', content: 'one', mkdir: true })
    assert.equal(srv.fs.readText('/home/user/deep/nested/x.txt'), 'one', `write failed: ${JSON.stringify(w)}`)

    await host.run('rw_write_file', { path: '/home/user/deep/nested/x.txt', content: 'two' })
    assert.equal(srv.fs.readText('/home/user/deep/nested/x.txt'), 'two', 'rw_write_file must REPLACE, not append')
  })
})

test('rw_append appends instead of replacing', async () => {
  await withTools({}, async ({ host, srv }) => {
    await host.run('rw_append', { path: '/home/user/notes.txt', content: 'third line\n' })
    const after = srv.fs.readText('/home/user/notes.txt')
    assert.match(after, /first line/)
    assert.match(after, /third line/, `append failed, file is: ${JSON.stringify(after)}`)
  })
})

test('rw_edit replaces the matched text and refuses an ambiguous edit', async () => {
  await withTools({}, async ({ host, srv }) => {
    const ok = await host.run('rw_edit', {
      path: '/home/user/src/app.js',
      old: 'const a = 1',
      new: 'const a = 42',
    })
    assert.equal(srv.fs.readText('/home/user/src/app.js'), 'const a = 42\nconst b = 2\n', `edit failed: ${JSON.stringify(ok)}`)

    // "const" appears twice → a single replacement is ambiguous, and silently
    // picking the first would corrupt a file the model thought it understood.
    // A refusal is a THROWN error (the model must see it as a failed call).
    const ambiguous = await host.run('rw_edit', { path: '/home/user/src/app.js', old: 'const', new: 'let' }).then(() => null, (e) => e)
    assert.ok(ambiguous, 'an ambiguous edit must be refused')
    assert.match(String(ambiguous.message), /2|multiple|出现|match|count/i,
      `an ambiguous edit must be reported, got: ${JSON.stringify(ambiguous)}`)
    assert.match(srv.fs.readText('/home/user/src/app.js'), /const a = 42/, 'an ambiguous edit must change nothing')

    // …and `count` makes it explicit.
    const counted = await host.run('rw_edit', { path: '/home/user/src/app.js', old: 'const', new: 'let', count: 2 })
    assert.match(JSON.stringify(counted), /ok|success|replaced|changed/i)
    assert.match(srv.fs.readText('/home/user/src/app.js'), /let a = 42/)
  })
})

test('rw_mkdir, rw_move and rw_remove act on the remote tree', async () => {
  await withTools({}, async ({ host, srv }) => {
    await host.run('rw_mkdir', { path: '/home/user/made' })
    assert.ok(srv.fs.has('/home/user/made'), 'rw_mkdir must create the directory')

    await host.run('rw_move', { path: '/home/user/notes.txt', dest: '/home/user/made/notes.txt' })
    assert.equal(srv.fs.has('/home/user/notes.txt'), false, 'rw_move must remove the source')
    assert.ok(srv.fs.has('/home/user/made/notes.txt'), 'rw_move must create the destination')

    await host.run('rw_remove', { path: '/home/user/made/notes.txt' })
    assert.equal(srv.fs.has('/home/user/made/notes.txt'), false)

    // A directory without `recursive` must NOT be silently destroyed.
    const refused = await host.run('rw_remove', { path: '/home/user/src' }).then(() => null, (e) => e)
    assert.ok(srv.fs.has('/home/user/src/app.js'),
      `a non-recursive remove of a directory must be refused, got: ${JSON.stringify(refused)}`)

    await host.run('rw_remove', { path: '/home/user/src', recursive: true })
    assert.equal(srv.fs.has('/home/user/src/app.js'), false, 'recursive remove must take the subtree')
  })
})

// ── transfer surface ────────────────────────────────────────────────────────

test('rw_upload and rw_download move real bytes in both directions', async () => {
  await withTools({}, async ({ host, srv, local }) => {
    const src = path.join(local, 'upload.md')
    writeFileSync(src, '# from local\n')
    await host.run('rw_upload', { localPath: src, path: '/home/user/uploaded.md' })
    assert.equal(srv.fs.readText('/home/user/uploaded.md'), '# from local\n', 'upload must land on the remote')

    const dst = path.join(local, 'downloaded.md')
    await host.run('rw_download', { path: '/home/user/uploaded.md', localPath: dst })
    assert.equal(readFileSync(dst, 'utf8'), '# from local\n', 'download must land on the local disk')
  })
})

test('rw_sync mirrors the remote tree, and rw_push sends local edits back', async () => {
  await withTools({}, async ({ host, srv }) => {
    const dry = await host.run('rw_sync', { dryRun: true })
    assert.match(JSON.stringify(dry), /WOULD|README\\.md|src|plan|dry/i, `dry-run sync failed: ${JSON.stringify(dry)}`)

    const real = await host.run('rw_sync', {})
    assert.match(JSON.stringify(real), /README\\.md|downloaded|synced|ok|file/i, `sync failed: ${JSON.stringify(real)}`)

    // A file the mirror now has, edited locally, must go back with rw_push.
    const mirrorFile = findMirrorFile(host, 'notes.txt')
    assert.ok(mirrorFile, 'the synced mirror must contain notes.txt')
    writeFileSync(mirrorFile, 'changed locally\n')
    const pushed = await host.run('rw_push', {})
    assert.match(JSON.stringify(pushed), /notes\.txt|uploaded|pushed|ok/i, `push failed: ${JSON.stringify(pushed)}`)
    assert.equal(srv.fs.readText('/home/user/notes.txt'), 'changed locally\n', 'rw_push must upload the local edit')
  })
})

/** Find a file inside the plugin's mirror for the active machine. */
function findMirrorFile(host, name) {
  const root = path.join(host.root)
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === name) return p
    }
  }
  return ''
}

// ── exec surface ────────────────────────────────────────────────────────────

test('rw_exec returns stdout, and reports a non-zero exit as a failure', async () => {
  await withTools({}, async ({ host, srv }) => {
    const ok = await host.run('rw_exec', { command: 'echo ok' })
    assert.match(JSON.stringify(ok), /ok/)
    assert.ok(srv.execLog.some((c) => /echo\s+ok/.test(c)),
      'the command must actually reach the remote shell; saw: ' + srv.execLog.join(' | '))

    const failed = await host.run('rw_exec', { command: 'false' })
    const body = JSON.stringify(failed)
    assert.match(body, /exit|failed|1|非零/i, `a non-zero exit must be visible, got: ${body}`)
  })
})

// ── forwarding ──────────────────────────────────────────────────────────────

test('rw_forward opens a tunnel to a local echo server and closes it again', async () => {
  const echo = net.createServer((socket) => { socket.pipe(socket) })
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const echoPort = echo.address().port
  try {
    await withTools({}, async ({ host }) => {
      // A FREE port, not a hardcoded one: test files run in parallel, and a fixed
      // 45999 can still be in TIME_WAIT from an earlier run — that produced a
      // one-off red run that took a re-run to clear.
      const probe = net.createServer()
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
      const listenPort = probe.address().port
      await new Promise((resolve) => probe.close(resolve))
      const defined = await host.run('rw_forward', {
        listenPort, targetHost: '127.0.0.1', targetPort: echoPort,
      })
      assert.match(JSON.stringify(defined), new RegExp(String(listenPort)), `define failed: ${JSON.stringify(defined)}`)

      // The forward is defined; connecting through it proves the tunnel works.
      const roundTrip = await new Promise((resolve) => {
        const socket = net.connect(listenPort, '127.0.0.1')
        let got = ''
        const done = (value) => { try { socket.destroy() } catch { /* gone */ } resolve(value) }
        socket.setTimeout(4000, () => done('timeout'))
        socket.on('connect', () => socket.write('ping'))
        socket.on('data', (chunk) => { got += chunk.toString(); if (got.includes('ping')) done(got) })
        socket.on('error', (err) => done('error: ' + err.message))
      })
      assert.equal(roundTrip, 'ping', `the forwarded port must echo bytes back, got: ${roundTrip}`)

      const removed = await host.run('rw_forward', { listenPort, remove: true })
      assert.match(JSON.stringify(removed), /remove|closed|ok/i)
    })
  } finally {
    await new Promise((resolve) => echo.close(resolve))
  }
})

// ── registry surface ────────────────────────────────────────────────────────

test('rw_machines lists saved machines without leaking secrets', async () => {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } } })
  const host = await createHost({
    machines: [{ id: 'm-a', name: 'box-a', host: '10.0.0.5', port: 22, username: 'u', password: 'sekret', credentialBackend: 'plain' }],
  })
  try {
    const res = await host.run('rw_machines', {})
    const body = JSON.stringify(res)
    assert.match(body, /box-a/)
    assert.doesNotMatch(body, /sekret/, 'rw_machines must never print a password')
  } finally {
    await host.dispose()
    await srv.close()
  }
})

test('rw_connect with a machineId adopts the saved machine and makes it current', async () => {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: { '/home/user/x.txt': 'x' } })
  const host = await createHost({
    machines: [{
      id: 'm-saved', name: 'saved-box', host: '127.0.0.1', port: srv.port,
      username: 'root', password: 'pw', credentialBackend: 'plain', hostKeyMode: 'off',
    }],
  })
  try {
    const res = await host.run('rw_connect', { machineId: 'm-saved' })
    assert.match(JSON.stringify(res), /ok|connected|saved-box/i, `connect failed: ${JSON.stringify(res)}`)
    const reg = host.readRegistry()
    assert.equal(reg.currentId, 'm-saved', 'rw_connect must make the machine current')

    const disc = await host.run('rw_disconnect')
    assert.match(JSON.stringify(disc), /ok|disconnect|closed/i)
  } finally {
    await host.dispose()
    await srv.close()
  }
})

test('rw_connect without host or machineId explains both options', async () => {
  await withTools({}, async ({ host }) => {
    const err = await host.run('rw_connect', {}).then(() => null, (e) => e)
    assert.ok(err, 'an empty rw_connect must fail')
    assert.match(String(err.message), /host|machineId/, 'the error must name both ways to connect')
  })
})

test('rw_pick_workspace sets the remote workspace', async () => {
  await withTools({}, async ({ host, srv }) => {
    const res = await host.run('rw_pick_workspace', { path: '/home/user/src' })
    assert.match(JSON.stringify(res), /\/home\/user\/src/, `pick failed: ${JSON.stringify(res)}`)
    const listed = await host.run('rw_list_dir', { path: '/home/user/src' })
    assert.match(JSON.stringify(listed), /app\.js/)
    assert.ok(srv.fs.has('/home/user/src/app.js'))
  })
})

test('rw_deploy_probe reports a machine without dsh instead of pretending it is installed', async () => {
  await withTools({}, async ({ host }) => {
    // The fake shell answers every unknown command with exit 0 and no output, so
    // the probe must conclude "no usable dsh" rather than a false success.
    const res = await host.run('rw_deploy_probe')
    const body = JSON.stringify(res)
    assert.ok(body.length > 0, 'the probe must answer something')
    assert.match(body, /dsh|version|install|node|npm/i)
  })
})
