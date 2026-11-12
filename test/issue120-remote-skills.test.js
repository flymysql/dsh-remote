// Issue #120: remote project skills must reach the REAL SkillRegistry without
// first syncing the mirror. Local sessions and other providers stay untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import {
  createRemoteSkillProvider, parseRemoteSkill, registerRemoteSkills, REMOTE_SKILL_PROVIDER,
} from '../lib/remote-skills.js'

const SKILL_A = `---\nname: alpha\ndescription: Remote alpha\nwhenToUse: Use on A\nmetadata:\n  owner: remote\ndisable-model-invocation: true\nuser-invocable: false\n---\n# Alpha\n\nUse the REMOTE body.\n`
const SKILL_B = `---\nname: beta\ndescription: Remote beta\n---\n## Beta body\n`
const MIRROR_A = { remotePath: '/srv/app', machine: { id: 'A', host: '10.0.0.1' }, mirrorDir: 'C:\\mirror-a' }
const MIRROR_B = { remotePath: '/srv/other', machine: { id: 'B', host: '10.0.0.2' }, mirrorDir: 'C:\\mirror-b' }

const dir = (name) => ({ filename: name, attrs: { isDirectory: () => true, isSymbolicLink: () => false } })
const file = (name) => ({ filename: name, attrs: { isDirectory: () => false, isSymbolicLink: () => false } })
const link = (name) => ({ filename: name, attrs: { isDirectory: () => false, isSymbolicLink: () => true } })
const missing = () => Object.assign(new Error('no such file'), { code: 'ENOENT' })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakePool(files, listings, faults = {}) {
  let sftpCalls = 0
  let statCalls = 0
  const surface = {
    async readdir(target) {
      sftpCalls++
      if (faults.readdir) throw faults.readdir(target)
      const value = listings[target]
      if (!value) throw missing()
      return value
    },
    async stat(target) {
      statCalls++
      if (!Object.hasOwn(files, target)) throw missing()
      return { size: Buffer.byteLength(files[target]) }
    },
    async readFile(target) {
      if (!Object.hasOwn(files, target)) throw missing()
      return Buffer.from(files[target])
    },
  }
  return {
    async sftp() { return surface },
    get sftpCalls() { return sftpCalls },
    get statCalls() { return statCalls },
  }
}

function dependencies(pool, extra = {}) {
  return {
    resolveBinding(cwd) {
      if (cwd === 'remote-A') return MIRROR_A
      if (cwd === 'remote-B') return MIRROR_B
      return { remotePath: '', machine: null, mirrorDir: null }
    },
    poolForMachine(machine) {
      if (machine.id !== 'A' && machine.id !== 'B') throw new Error('must never use the active/fallback machine')
      return pool
    },
    logger: { warn() {} },
    ...extra,
  }
}

function realRegistry(t) {
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  // Service construction already provides `skills` on this context.
  t.after(() => ctx.fiber.dispose())
  return { ctx, registry }
}

test('frontmatter follows canonical invocation, metadata and CRLF rules', () => {
  const parsed = parseRemoteSkill(SKILL_A.replace(/\n/g, '\r\n'))
  assert.equal(parsed.name, 'alpha')
  assert.deepEqual(parsed.invocation, { modelInvocable: false, userInvocable: false })
  assert.deepEqual(parsed.metadata, { owner: 'remote' })
  assert.equal(parsed.whenToUse, 'Use on A')
  assert.equal(parsed.content, '# Alpha\r\n\r\nUse the REMOTE body.')
  for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    assert.throws(() => parseRemoteSkill(`---\nname: a\ndescription: A\n${key}: true\n---\nbody`), /unsupported/)
  }
  assert.equal(parseRemoteSkill('name: no-frontmatter'), undefined)
  assert.equal(parseRemoteSkill('---\nname: missing-description\n---\nbody'), undefined)
})

test('REAL registry discovers remote bundle + flat skills and loads full content', async (t) => {
  const { ctx, registry } = realRegistry(t)
  const pool = fakePool({
    '/srv/app/.dsh/skills/alpha/SKILL.md': SKILL_A,
    '/srv/app/.agents/skills/beta.md': SKILL_B,
  }, {
    '/srv/app/.dsh/skills': [dir('alpha'), file('notes.txt'), link('outside')],
    '/srv/app/.agents/skills': [file('beta.md'), file('nested')],
  })
  const handle = registerRemoteSkills(ctx, dependencies(pool))
  t.after(() => handle.dispose())
  const snapshot = await registry.snapshot({ cwd: 'remote-A' })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.skills.map((s) => s.name), ['alpha', 'beta'])
  const alpha = snapshot.skills[0]
  assert.equal(alpha.provider, REMOTE_SKILL_PROVIDER)
  assert.equal(alpha.source, 'project-dsh')
  assert.deepEqual(alpha.invocation, { modelInvocable: false, userInvocable: false })
  assert.equal(alpha.resourceBase.kind, 'opaque')
  assert.match(alpha.resourceBase.description, /\/srv\/app\/\.dsh\/skills\/alpha/)
  assert.match(alpha.resourceBase.description, /rw_read_file/)
  assert.equal(Object.hasOwn(alpha.resourceBase, 'path'), false)
  const loaded = await registry.get('alpha', { cwd: 'remote-A' })
  assert.equal(loaded.content, '# Alpha\n\nUse the REMOTE body.')
  assert.deepEqual(loaded.invocation, alpha.invocation)
  const beta = await registry.get('beta', { cwd: 'remote-A' })
  assert.equal(beta.content, '## Beta body')
})

test('remote authority wins an old local mirror duplicate deterministically', async (t) => {
  const { ctx, registry } = realRegistry(t)
  const localCandidate = {
    name: 'alpha', description: 'STALE mirror', invocation: { modelInvocable: true, userInvocable: true },
    provider: 'filesystem', source: 'project-dsh', rank: 100, locator: {},
  }
  registry.registerProvider(() => ({
    name: 'filesystem',
    async list() { return [localCandidate] },
    async get() { return { ...localCandidate, content: 'STALE LOCAL BODY' } },
  }))
  const pool = fakePool({
    '/srv/app/.dsh/skills/alpha/SKILL.md': SKILL_A,
    '/srv/app/.agents/skills/alpha.md': '---\nname: alpha\ndescription: Agents duplicate\n---\nagents body',
  }, {
    '/srv/app/.dsh/skills': [dir('alpha')],
    '/srv/app/.agents/skills': [file('alpha.md')],
  })
  const handle = registerRemoteSkills(ctx, dependencies(pool))
  t.after(() => handle.dispose())
  const snapshot = await registry.snapshot({ cwd: 'remote-A' })
  assert.equal(snapshot.skills.length, 1)
  assert.equal(snapshot.skills[0].description, 'Remote alpha')
  assert.equal((await registry.get('alpha', { cwd: 'remote-A' })).content.includes('REMOTE body'), true)
  // The same name is also present under .agents: .dsh wins by rank, not source spelling.
  assert.equal(snapshot.skills[0].source, 'project-dsh')
})

test('LOCAL and missing cwd never touch SSH or the active machine', async (t) => {
  const { ctx } = realRegistry(t)
  let called = 0
  const handle = registerRemoteSkills(ctx, {
    resolveBinding: () => ({ remotePath: '', machine: null }),
    poolForMachine: () => { called++; throw new Error('must not connect') },
  })
  t.after(() => handle.dispose())
  assert.deepEqual(await handle.provider.list({}), [])
  assert.deepEqual(await handle.provider.list({ cwd: 'plain-local' }), [])
  assert.equal(called, 0)
})

test('an I/O failure is incomplete, never a cached empty catalog; recovery works', async (t) => {
  const { ctx, registry } = realRegistry(t)
  const fault = { readdir: () => new Error('permission denied') }
  const pool = fakePool({ '/srv/app/.dsh/skills/alpha/SKILL.md': SKILL_A }, {
    '/srv/app/.dsh/skills': [dir('alpha')],
  }, fault)
  const handle = registerRemoteSkills(ctx, dependencies(pool))
  t.after(() => handle.dispose())
  const failed = await registry.snapshot({ cwd: 'remote-A' })
  assert.equal(failed.complete, false)
  assert.deepEqual(failed.skills, [])
  delete fault.readdir
  const recovered = await registry.snapshot({ cwd: 'remote-A' })
  assert.equal(recovered.complete, true)
  assert.deepEqual(recovered.skills.map((s) => s.name), ['alpha'])
})

test('missing roots are a complete empty state and invalid files do not poison candidates', async (t) => {
  const { ctx, registry } = realRegistry(t)
  const pool = fakePool({ '/srv/app/.dsh/skills/bad/SKILL.md': 'not a skill' }, {
    '/srv/app/.dsh/skills': [dir('bad'), dir('missing')],
  })
  const handle = registerRemoteSkills(ctx, dependencies(pool))
  t.after(() => handle.dispose())
  const snapshot = await registry.snapshot({ cwd: 'remote-A' })
  assert.equal(snapshot.complete, true)
  assert.deepEqual(snapshot.skills, [])
})

test('entry/byte limits return bounded incomplete observations, not silent complete data', async () => {
  const pool = fakePool({ '/srv/app/.dsh/skills/alpha/SKILL.md': SKILL_A }, {
    '/srv/app/.dsh/skills': [dir('alpha'), file('second.md')],
  })
  const control = { invalidate() {}, signal: new AbortController().signal }
  const provider = createRemoteSkillProvider(control, dependencies(pool, { maxEntriesPerRoot: 1, maxSkillBytes: 10 }))
  const result = await provider.list({ cwd: 'remote-A' })
  assert.equal(result.complete, false)
  assert.equal(result.candidates.length, 0)
})

test('two mirrors keep their own machine and get() uses the candidate locator', async () => {
  const pools = {
    A: fakePool({ '/srv/app/.dsh/skills/alpha/SKILL.md': SKILL_A }, { '/srv/app/.dsh/skills': [dir('alpha')] }),
    B: fakePool({ '/srv/other/.dsh/skills/beta/SKILL.md': SKILL_B }, { '/srv/other/.dsh/skills': [dir('beta')] }),
  }
  const provider = createRemoteSkillProvider({ invalidate() {}, signal: new AbortController().signal }, {
    resolveBinding: (cwd) => cwd === 'remote-A' ? MIRROR_A : MIRROR_B,
    poolForMachine: (machine) => pools[machine.id],
  })
  const [a] = (await provider.list({ cwd: 'remote-A' }))
  const [b] = (await provider.list({ cwd: 'remote-B' }))
  assert.equal((await provider.get(a, { cwd: 'remote-B' })).content.includes('REMOTE body'), true)
  assert.equal((await provider.get(b, { cwd: 'remote-A' })).content, '## Beta body')
  assert.equal(pools.A.sftpCalls > 0 && pools.B.sftpCalls > 0, true)
})

test('Windows remote roots keep backslash-separated skill locators', async () => {
  const winMirror = { remotePath: 'C:\\srv\\app', machine: { id: 'A', host: 'win' }, mirrorDir: 'C:\\mirror-win' }
  const root = 'C:\\srv\\app\\.dsh\\skills'
  const skillPath = 'C:\\srv\\app\\.dsh\\skills\\alpha\\SKILL.md'
  const pool = fakePool({ [skillPath]: SKILL_A }, { [root]: [dir('alpha')] })
  const provider = createRemoteSkillProvider({ invalidate() {}, signal: new AbortController().signal }, {
    resolveBinding: () => winMirror,
    poolForMachine: () => pool,
  })
  const [candidate] = await provider.list({ cwd: 'remote-windows' })
  assert.equal(candidate.locator.path, skillPath)
  assert.match(candidate.resourceBase.description, /C:\\srv\\app\\\.dsh\\skills\\alpha/)
  assert.equal((await provider.get(candidate)).content.includes('REMOTE body'), true)
})

test('a pre-aborted lookup performs no new SFTP work', async () => {
  const pool = fakePool({}, {})
  const provider = createRemoteSkillProvider({ invalidate() {}, signal: new AbortController().signal }, dependencies(pool))
  const controller = new AbortController()
  controller.abort(new Error('cancelled by caller'))
  await assert.rejects(provider.list({ cwd: 'remote-A', signal: controller.signal }), /cancelled by caller/)
  assert.equal(pool.sftpCalls, 0)
})

test('provider abort blocks late work; plain dispose is quiet and performs no SFTP', async () => {
  const pool = fakePool({}, {})
  const controller = new AbortController()
  const provider = createRemoteSkillProvider({ invalidate() {}, signal: controller.signal }, dependencies(pool))
  controller.abort(new Error('provider unloaded'))
  await assert.rejects(provider.list({ cwd: 'remote-A' }), /provider unloaded/)
  await assert.rejects(provider.get({ locator: { path: '/x', machine: MIRROR_A.machine } }), /provider unloaded/)
  const quiet = createRemoteSkillProvider({ invalidate() {}, signal: new AbortController().signal }, dependencies(pool))
  quiet.dispose()
  assert.deepEqual(await quiet.list({ cwd: 'remote-A' }), [])
  assert.equal(await quiet.get({ locator: { path: '/x', machine: MIRROR_A.machine } }), undefined)
  assert.equal(pool.sftpCalls, 0)
})

test('low-frequency refresh only invalidates; dispose stops late ticks', async () => {
  let invalidations = 0
  const pool = fakePool({}, {})
  const provider = createRemoteSkillProvider({ invalidate: () => { invalidations++ }, signal: new AbortController().signal }, dependencies(pool, { refreshMs: 15 }))
  await provider.list({ cwd: 'remote-A' })
  const before = pool.sftpCalls
  await sleep(45)
  assert.ok(invalidations >= 1)
  assert.equal(pool.sftpCalls, before, 'timer ticks must not perform SFTP reads')
  provider.dispose()
  const settled = invalidations
  await sleep(35)
  assert.equal(invalidations, settled)
  provider.dispose() // idempotent
})

test('registration disposal removes remote candidates and permits clean re-register', async (t) => {
  const { ctx, registry } = realRegistry(t)
  const pool = fakePool({ '/srv/app/.dsh/skills/alpha/SKILL.md': SKILL_A }, { '/srv/app/.dsh/skills': [dir('alpha')] })
  const first = registerRemoteSkills(ctx, dependencies(pool))
  assert.equal((await registry.snapshot({ cwd: 'remote-A' })).skills.length, 1)
  first.dispose()
  first.dispose()
  assert.equal((await registry.snapshot({ cwd: 'remote-A' })).skills.length, 0)
  const second = registerRemoteSkills(ctx, dependencies(pool))
  t.after(() => second.dispose())
  assert.equal((await registry.snapshot({ cwd: 'remote-A' })).skills.length, 1)
})
