// Drive the actual tools through SSH/SFTP; don't infer an applied change from args.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

async function fixture(t) {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, cwd: '/project', fs: { '/project/main.js': 'first\nold\nlast\n', '/project/large.txt': 'x'.repeat(100000) } })
  let host
  try {
    host = await createHost({ config: { host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: '/project', commandTimeoutMs: 4000, connectTimeoutMs: 4000 } })
  } catch (error) { await srv.close(); throw error }
  t.after(async () => { await host.dispose(); await srv.close() })
  return { srv, host }
}

function presented(host, name, args, value) {
  const tool = host.tool(name)
  const meta = tool.output.presentationMeta(args, value)
  return { meta, card: tool.presentResult(args, { meta, isError: false }) }
}

test('edit, append and create produce native diff presentations only after actual remote writes', async t => {
  const { host, srv } = await fixture(t)
  const editArgs = { path: '/project/main.js', old: 'old', new: 'new' }
  const edit = await host.run('rw_edit', editArgs)
  assert.equal(srv.fs.readText('/project/main.js'), 'first\nnew\nlast\n')
  const changed = presented(host, 'rw_edit', editArgs, edit)
  assert.equal(changed.meta.applied, true); assert.equal(changed.meta.operation, 'edit')
  assert.equal(changed.card.card, 'diff'); assert.match(changed.card.diffs[0].oldText, /old/)
  assert.match(changed.card.diffs[0].newText, /new/)
  assert.doesNotMatch(JSON.stringify(host.tool('rw_edit').output.render(editArgs, edit)), /diffs|oldText/, 'presentation metadata must not inflate model-facing text')

  const appendArgs = { path: '/project/main.js', content: 'tail\n' }
  const append = await host.run('rw_append', appendArgs)
  const appended = presented(host, 'rw_append', appendArgs, append)
  assert.equal(appended.meta.additions, 1); assert.equal(appended.meta.deletions, 0)
  assert.equal(srv.fs.readText('/project/main.js'), 'first\nnew\nlast\ntail\n')

  const createArgs = { path: '/project/nested/new.js', content: 'created\n' }
  const create = await host.run('rw_write_file', createArgs)
  const created = presented(host, 'rw_write_file', createArgs, create)
  assert.equal(created.card.diffs[0].oldText, null)
  assert.equal(srv.fs.readText('/project/nested/new.js'), 'created\n')
})

test('overwriting a large baseline reports an unavailable diff rather than pretending the file is new', async t => {
  const { host, srv } = await fixture(t)
  const args = { path: '/project/large.txt', content: 'replacement\n' }
  const value = await host.run('rw_write_file', args)
  assert.equal(srv.fs.readText('/project/large.txt'), 'replacement\n')
  const result = presented(host, 'rw_write_file', args, value)
  assert.equal(result.meta.truncated, true); assert.equal(result.meta.reason, 'baseline-unavailable')
  assert.deepEqual(result.meta.diffs, []); assert.equal(result.card, undefined)
})
