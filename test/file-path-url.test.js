// URLSearchParams decodes percent escapes once. A second decode changes a real
// filename such as "%2F" into a separator or throws on an ordinary "%".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

for (const platform of ['posix', 'windows']) {
  test(`real SSH file reads and directory listings retain literal percent names on ${platform} paths`, async t => {
    const base = platform === 'windows' ? '/C:/project' : '/project'
    const display = platform === 'windows' ? 'C:\\project' : base
    const separator = platform === 'windows' ? '\\' : '/'
    const names = ['%', '%2F', '中文%名字']
    const tree = {}
    for (const name of names) {
      tree[base + '/files/' + name] = 'file contents: ' + name
      tree[base + '/dirs/' + name + '/inside.txt'] = 'directory contents: ' + name
    }
    const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, platform, cwd: base, fs: tree })
    let host
    try {
      host = await createHost({ config: {
        host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: display,
        shell: 'native', commandTimeoutMs: 4000, connectTimeoutMs: 4000,
      } })
    } catch (error) { await srv.close(); throw error }
    t.after(async () => { await host.dispose(); await srv.close() })
    for (const name of names) {
      // Match the production client's encodeURIComponent query construction.
      const file = display + separator + 'files' + separator + name
      const read = await host.call('/dsh-remote/read?path=' + encodeURIComponent(file), { method: 'GET' })
      assert.equal(read.status, 200, `${file}: ${read.raw}`)
      assert.equal(read.json.content, 'file contents: ' + name)
      const directory = display + separator + 'dirs' + separator + name
      const listed = await host.call('/dsh-remote/ls?path=' + encodeURIComponent(directory), { method: 'GET' })
      assert.equal(listed.status, 200, `${directory}: ${listed.raw}`)
      assert.equal(listed.json.path, directory)
      assert.deepEqual(listed.json.items.map(item => item.name), ['inside.txt'])
      // JSON body paths are already decoded and remain unchanged as well.
      const posted = await host.call('/dsh-remote/read', { body: { path: file } })
      assert.equal(posted.json.content, 'file contents: ' + name)
    }
    if (platform === 'windows') {
      const forwardSlashes = 'C:/project/files/%2F'
      const result = await host.call('/dsh-remote/read?path=' + encodeURIComponent(forwardSlashes), { method: 'GET' })
      assert.equal(result.status, 200); assert.equal(result.json.content, 'file contents: %2F')
    }
  })
}
