// Issue #207: "download to local mirror" was invisible. The explorer's doFs
// DISCARDED the download response (no feedback at all), and the file tab's
// note was transient — the reporter expected a Windows path picker, but by
// design the file lands in the local mirror, and nothing told them where.
//
// The fix: the download response's `local` path is now surfaced with a
// "show in folder" action, backed by a new fenced `revealLocal` fs op
// (openLocalPath with 'reveal', restricted to the plugin's own mirror tree —
// not a file launcher). These tests pin the op's fence and the UI wiring.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

// Never let the reveal op actually spawn a file-manager window from a test:
// this env makes openLocalPath answer 501 instead (the same headless-host
// answer real servers get), while still proving the fence let the path through.
process.env.DSH_REMOTE_NO_NATIVE_DIALOG = '1'

const TREE = { '/home/user/src/index.js': 'export const x = 1\n' }

async function withRemote(fn) {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: TREE, cwd: '/home/user' })
  const rec = machine({ host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: '/home/user' })
  const host = await createHost({ machines: [rec] })
  try {
    await host.call('/dsh-remote/current', { body: { id: rec.id } })
    await fn({ host, srv })
  } finally {
    await host.dispose()
    await srv.close()
  }
}

test('#207: download answers the local path, and revealLocal accepts exactly that path', async () => {
  await withRemote(async ({ host }) => {
    const d = await host.call('/dsh-remote/fs', { body: { op: 'download', path: '/home/user/src/index.js' } })
    assert.equal(d.json.ok, true, `download failed: ${d.json.error}`)
    assert.ok(d.json.local, 'the answer names the local path')

    // The fenced reveal: the downloaded path passes the mirror-tree fence and
    // reaches openLocalPath, which (headless test env) answers 501 WITH the
    // path — proving the request got past the fence without spawning anything.
    const reveal = await host.call('/dsh-remote/fs', { body: { op: 'revealLocal', path: d.json.local } })
    assert.equal(reveal.status, 501, 'DSH_REMOTE_NO_NATIVE_DIALOG turns the launch into 501')
    assert.equal(reveal.json.ok, false)
    assert.equal(reveal.json.path, d.json.local, 'the fenced path is echoed back for the UI to show')
  })
})

test('#207: revealLocal refuses paths outside the mirror tree and missing files inside it', async () => {
  await withRemote(async ({ host }) => {
    const outside = await host.call('/dsh-remote/fs', { body: { op: 'revealLocal', path: 'C:/Windows/system.ini' } })
    assert.equal(outside.status, 400, 'an arbitrary local path must be refused')
    assert.match(String(outside.json.error), /mirror tree/)

    // A path that passes the prefix check but does not exist → 404, not a launch.
    const missing = await host.call('/dsh-remote/fs', { body: { op: 'revealLocal', path: String(outside.json.error).length + '' } })
    // (re-run with a real mirror-tree-shaped but absent path)
    const d = await host.call('/dsh-remote/fs', { body: { op: 'download', path: '/home/user/src/index.js' } })
    const absent = d.json.local.replace('index.js', 'not-there.js')
    const miss = await host.call('/dsh-remote/fs', { body: { op: 'revealLocal', path: absent } })
    assert.equal(miss.status, 404, 'a missing file inside the tree is a 404')
    assert.equal(miss.json.ok, false)
  })
})

test('#207: the explorer no longer discards the download response, and both UIs offer show-in-folder', async () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The explorer's doFs captures r.local…
  assert.ok(src.includes("if (op === 'download' && r && r.local) setDlNote({ path: String(r.local) })"),
    'the explorer tree must surface the downloaded local path (#207: the response used to be discarded)')
  // …and renders the action.
  assert.ok(/'explorer\.showInFolder'/.test(src), 'the show-in-folder action is rendered')
  assert.ok(src.includes("setDlLocal(r && r.local ? String(r.local) : '')"),
    'the file tab keeps the downloaded path actionable too')
  assert.ok(src.includes("op: 'revealLocal'"), 'both surfaces dial the fenced revealLocal op')
})

test('#207: the i18n tables carry the new keys in both locales', async () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes("'explorer.downloadedNote': '已下载到本地镜像：{path}'"), 'zh note string present')
  assert.ok(src.includes("'explorer.downloadedNote': 'Downloaded to the local mirror: {path}'"), 'en note string present')
})
