// Issue #120: end-to-end through the real plugin pool and in-memory sshd.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

const BEFORE = `---\nname: alpha\ndescription: Before\n---\nold remote body`
const AFTER = `---\nname: alpha\ndescription: After\n---\nnew remote body`
const BETA = `---\nname: beta\ndescription: Agents beta\n---\nagents body`

async function setup(t, backend = 'native') {
  const server = await startFakeSsh({
    users: { root: { password: 'pw' } },
    fs: {
      '/srv/app/.dsh/skills/alpha/SKILL.md': BEFORE,
      '/srv/app/.agents/skills/beta.md': BETA,
    },
  })
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  let invalidations = 0
  const originalInvalidate = registry.invalidateCache.bind(registry)
  registry.invalidateCache = () => { invalidations++; originalInvalidate() }
  const rec = machine({ id: 'm-test', host: '127.0.0.1', port: server.port, password: 'pw', workspace: '/srv/app', backend })
  const host = await createHost({
    machines: [rec], currentId: rec.id,
    config: { host: '127.0.0.1', port: server.port, username: 'root', password: 'pw', workspace: '/srv/app', hostKeyMode: 'off', backend },
    services: { skills: registry },
  })
  const mirror = path.join(host.root, `127.0.0.1-root-${server.port}`, 'app')
  mkdirSync(mirror, { recursive: true })
  writeFileSync(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify({
    host: '127.0.0.1', port: server.port, username: 'root', remotePath: '/srv/app',
  }))
  t.after(async () => {
    await host.dispose()
    await ctx.fiber.dispose()
    await server.close()
  })
  return { host, registry, mirror, invalidations: () => invalidations }
}

test('REAL SshPool + fake sshd discovers remote skills; HTTP write invalidates the catalog', async (t) => {
  const { host, registry, mirror, invalidations } = await setup(t)
  const first = await registry.snapshot({ cwd: mirror })
  assert.equal(first.complete, true)
  assert.deepEqual(first.skills.map((s) => s.name), ['alpha', 'beta'])
  assert.equal(first.skills[0].description, 'Before')
  assert.equal((await registry.get('alpha', { cwd: mirror })).content, 'old remote body')
  assert.equal((await registry.get('beta', { cwd: mirror })).content, 'agents body')

  const response = await host.call('/dsh-remote/write', {
    method: 'POST',
    body: { path: '/srv/app/.dsh/skills/alpha/SKILL.md', content: AFTER },
  })
  assert.equal(response.status, 200, response.raw)
  assert.ok(invalidations() >= 1, 'the HTTP mutation reached provider control.invalidate')
  const next = await registry.snapshot({ cwd: mirror })
  assert.equal(next.skills[0].description, 'After')
  assert.equal((await registry.get('alpha', { cwd: mirror })).content, 'new remote body')
})

test('system-OpenSSH backend discovers the same remote skills over the shared surface', async (t) => {
  const { registry, mirror } = await setup(t, 'openssh')
  const snapshot = await registry.snapshot({ cwd: mirror })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.skills.map((s) => s.name), ['alpha', 'beta'])
  assert.equal((await registry.get('alpha', { cwd: mirror })).content, 'old remote body')
  assert.equal((await registry.get('beta', { cwd: mirror })).content, 'agents body')
})

test('rw_push invalidates only after actual completion; dryRun and read-only results do not', async (t) => {
  const { host, registry, mirror, invalidations } = await setup(t)
  await registry.snapshot({ cwd: mirror })
  const exec = { agent: { id: 's-1', session: { id: 's-1', header: { cwd: mirror } } } }
  const push = host.tool('rw_push')

  const dryBaseline = invalidations() // provider registration itself bumps the registry revision
  await push.execute({ dryRun: true }, exec)
  assert.equal(invalidations(), dryBaseline, 'dryRun is not a remote mutation')
  mkdirSync(path.join(mirror, '.dsh', 'skills', 'alpha'), { recursive: true })
  writeFileSync(path.join(mirror, '.dsh', 'skills', 'alpha', 'SKILL.md'), AFTER)
  await push.execute({ dryRun: false }, exec)
  assert.ok(invalidations() > dryBaseline, 'runPush invalidates inside its actual settlement path')
  assert.equal((await registry.get('alpha', { cwd: mirror })).content, 'new remote body')

  const listeners = host.listeners.get('tools/result') || []
  const beforeExec = invalidations()
  for (const fn of listeners) await fn({ name: 'rw_read_file' }, { name: 'rw_read_file' })
  assert.equal(invalidations(), beforeExec, 'read-only tools do not invalidate')
  for (const fn of listeners) await fn({ name: 'rw_exec' }, { name: 'rw_exec' })
  assert.ok(invalidations() > beforeExec, 'successful rw_exec conservatively invalidates')
})
