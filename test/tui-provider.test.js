// dsh-remote TUI — 工作区 provider（lib/tui/provider.js）单测。
//
// 用 fake api（可控返回值 + 记录调用）驱动 provider：
//   · list() 只读缓存、缓存空时返回 [] 且不抛（宿主有 2s 预算）
//   · refresh() 从「已存在镜像 + 当前机工作区 + 每机最近 N 个」装配 target
//   · resolve(uri) / resolvePath(path, cwd) 走 ensureRemoteWorkspace({register:true})
//   · describe(cwd) 同步解析真实临时镜像目录（不建目录、不连网）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createWorkspaceProvider } from '../lib/tui/provider.js'
import { buildUri } from '../lib/tui/format.js'

const MACHINE = {
  id: 'm1',
  name: 'dev-box',
  host: '10.0.0.2',
  port: 22,
  username: 'root',
  useSshConfig: false,
  group: '',
  workspace: '',
  privateKeyPath: '',
  useAgent: false,
  recentWorkspaces: [],
}

const WIN_MACHINE = {
  id: 'm2',
  name: 'win-box',
  host: '10.0.0.3',
  port: 22,
  username: 'admin',
  useSshConfig: false,
  group: '',
  workspace: '',
  privateKeyPath: '',
  useAgent: false,
  recentWorkspaces: [],
}

/** fake api：记录调用，可注入失败。 */
function createFakeApi(options = {}) {
  const calls = []
  const api = {
    apiVersion: 1,
    calls,
    async listMachines() {
      calls.push({ method: 'listMachines' })
      if (options.failListMachines) throw options.failListMachines
      return {
        machines: options.machines === undefined ? [MACHINE, WIN_MACHINE] : options.machines,
        currentId: options.currentId === undefined ? null : options.currentId,
      }
    },
    async listRemoteProjects() {
      calls.push({ method: 'listRemoteProjects' })
      if (options.failListRemoteProjects) throw options.failListRemoteProjects
      return options.projects || []
    },
    async ensureRemoteWorkspace(input) {
      calls.push({ method: 'ensure', options: input })
      if (options.failEnsure) throw options.failEnsure
      if (typeof options.ensure === 'function') return options.ensure(input)
      return {
        machineId: input.machineId,
        remotePath: input.remotePath,
        localMirror: path.join(tmpdir(), 'dsh-remote-provider-mirrors', encodeURIComponent(String(input.remotePath))),
        title: 'ensured-title',
      }
    },
  }
  return api
}

/** 在临时目录里造一个真实镜像（目录 + .dsh-remote-meta.json）。 */
function makeMirror(root, { host, username, port = 22, remotePath, base, alias }) {
  const hostDir = path.join(root, `${host}-${username}-${port}`.replace(/[^A-Za-z0-9._-]/g, '_'))
  const dir = path.join(hostDir, base)
  mkdirSync(dir, { recursive: true })
  const meta = { host, port, username, remotePath, createdAt: new Date().toISOString() }
  if (alias) meta.alias = alias
  writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify(meta, null, 2))
  return dir
}

/** 每个测试独立的 DSH_HOME 风格根目录。 */
function workspaceFixture() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-tui-provider-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  return { home, root, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/** 一个项目镜像 + 对应的 listRemoteProjects 行。 */
function projectFor(root, { machineId, host, username, port = 22, remotePath, base, alias = '' }) {
  const dir = makeMirror(root, { host, username, port, remotePath, base, alias })
  return {
    dir,
    host,
    port,
    username,
    remotePath,
    alias,
    name: '',
    machineId,
  }
}

const ensureCalls = (api) => api.calls.filter((call) => call.method === 'ensure')

// ── list / refresh ────────────────────────────────────────────────────────

test('list: 只读缓存、返回副本、刷新后不再调用 api', async () => {
  const fixture = workspaceFixture()
  try {
    const project = projectFor(fixture.root, {
      machineId: 'm1', host: '10.0.0.2', username: 'root', remotePath: '/home/root/proj', base: 'proj',
    })
    const api = createFakeApi({ projects: [project] })
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false }, root: fixture.root })

    // 首次 list 触发后台预热（不 await 网络），返回 [] 而不是 throw
    assert.deepEqual(provider.list(), [])
    await provider.refresh()

    const targets = provider.list()
    assert.equal(Array.isArray(targets), true)
    assert.equal(targets.length, 1)
    const [target] = targets
    assert.deepEqual(Object.keys(target).sort(), ['badge', 'cwd', 'description', 'kind', 'label', 'uri'].sort())
    assert.equal(target.uri, buildUri('m1', '/home/root/proj'))
    assert.equal(target.cwd, project.dir)
    assert.equal(target.kind, 'provider')
    assert.equal(target.badge, 'dev-box')
    assert.equal(target.description, 'root@10.0.0.2:/home/root/proj')
    assert.equal(target.label, 'dev-box-proj')

    // 返回的是副本：改动不影响缓存
    targets.pop()
    assert.equal(provider.list().length, 1)

    // 缓存已就绪：list 不再打 api
    const before = api.calls.length
    provider.list()
    assert.equal(api.calls.length, before)
  } finally {
    fixture.cleanup()
  }
})

test('list: api 失败时返回 [] 且绝不 throw（refresh 内部吞错）', async () => {
  const fixture = workspaceFixture()
  try {
    const api = createFakeApi({ failListMachines: new Error('network down') })
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false }, root: fixture.root })
    await provider.refresh()
    assert.deepEqual(provider.list(), [])
    // signal 已 abort 时也安全返回 []
    const controller = new AbortController()
    controller.abort()
    assert.deepEqual(provider.list(controller.signal), [])
  } finally {
    fixture.cleanup()
  }
})

test('refresh: 每机最近工作区取前 N 条（默认 5），逐条 ensure 但 register:false（不污染台账）', async () => {
  const fixture = workspaceFixture()
  try {
    const recent = ['/home/root/a', '/home/root/b', '/home/root/c', '/home/root/d', '/home/root/e', '/home/root/f']
    const machine = { ...MACHINE, recentWorkspaces: recent }
    const api = createFakeApi({ machines: [machine] })
    const provider = createWorkspaceProvider({ api, config: {}, root: fixture.root })
    await provider.refresh()

    const ensures = ensureCalls(api)
    assert.equal(ensures.length, 5, '默认只取前 5 条')
    assert.deepEqual(ensures.map((call) => call.options.remotePath), recent.slice(0, 5))
    for (const call of ensures) {
      assert.equal(call.options.machineId, 'm1')
      // 只是打开选择器不能把最近列表登记进用户的全局工作区台账；
      // 登记发生在 resolve()/resolvePath()——用户真正选中的时候。
      assert.equal(call.options.register, false)
    }
    assert.equal(provider.list().length, 5)
    assert.ok(provider.list().every((target) => target.kind === 'provider'))
  } finally {
    fixture.cleanup()
  }
})

test('refresh: tuiProviderListRecent=false 不列 recent；limit 可配置并夹到 1..20', async () => {
  const fixture = workspaceFixture()
  try {
    const recent = Array.from({ length: 8 }, (_, index) => `/home/root/p${index}`)
    const machine = { ...MACHINE, recentWorkspaces: recent }

    const offApi = createFakeApi({ machines: [machine] })
    const offProvider = createWorkspaceProvider({ api: offApi, config: { tuiProviderListRecent: false }, root: fixture.root })
    await offProvider.refresh()
    assert.deepEqual(ensureCalls(offApi), [])
    assert.deepEqual(offProvider.list(), [])

    const twoApi = createFakeApi({ machines: [machine] })
    const twoProvider = createWorkspaceProvider({
      api: twoApi,
      config: { tuiProviderListRecent: true, tuiProviderRecentLimit: 2 },
      root: fixture.root,
    })
    await twoProvider.refresh()
    assert.equal(ensureCalls(twoApi).length, 2)

    const hugeApi = createFakeApi({ machines: [machine] })
    const hugeProvider = createWorkspaceProvider({ api: hugeApi, config: { tuiProviderRecentLimit: 99 }, root: fixture.root })
    await hugeProvider.refresh()
    assert.equal(ensureCalls(hugeApi).length, 8, '8 条全取（上限 20 只夹配置值，不超数据量）')
  } finally {
    fixture.cleanup()
  }
})

test('refresh: 已存在镜像与 recent 去重（同一 uri 只出现一次、不重复 ensure）', async () => {
  const fixture = workspaceFixture()
  try {
    const project = projectFor(fixture.root, {
      machineId: 'm1', host: '10.0.0.2', username: 'root', remotePath: '/home/root/proj', base: 'proj',
    })
    const machine = { ...MACHINE, recentWorkspaces: ['/home/root/proj', '/home/root/other'] }
    const api = createFakeApi({ machines: [machine], projects: [project] })
    const provider = createWorkspaceProvider({ api, config: {}, root: fixture.root })
    await provider.refresh()

    const ensures = ensureCalls(api)
    assert.deepEqual(ensures.map((call) => call.options.remotePath), ['/home/root/other'])
    const uris = provider.list().map((target) => target.uri)
    assert.equal(new Set(uris).size, uris.length)
    assert.equal(uris.length, 2)
  } finally {
    fixture.cleanup()
  }
})

test('refresh: 当前机已记录 workspace 也进入列表', async () => {
  const fixture = workspaceFixture()
  try {
    const machine = { ...MACHINE, workspace: '/home/root/current-project' }
    const api = createFakeApi({ machines: [machine], currentId: 'm1' })
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false }, root: fixture.root })
    await provider.refresh()
    const ensures = ensureCalls(api)
    assert.equal(ensures.length, 1)
    assert.deepEqual(ensures[0].options, { machineId: 'm1', remotePath: '/home/root/current-project', register: false })
    assert.equal(provider.list()[0].uri, buildUri('m1', '/home/root/current-project'))
  } finally {
    fixture.cleanup()
  }
})

test('refresh: 没有映射到已保存机器的孤立镜像被跳过（不会生成不可 resolve 的条目）', async () => {
  const fixture = workspaceFixture()
  try {
    const orphan = projectFor(fixture.root, {
      machineId: null, host: '10.9.9.9', username: 'ghost', remotePath: '/srv/orphan', base: 'orphan',
    })
    const api = createFakeApi({ projects: [orphan] })
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false }, root: fixture.root })
    await provider.refresh()
    assert.deepEqual(provider.list(), [])
  } finally {
    fixture.cleanup()
  }
})

// ── describe ──────────────────────────────────────────────────────────────

test('describe: 真实镜像目录同步返回 target；非镜像路径返回 undefined；不创建目录', async () => {
  const fixture = workspaceFixture()
  try {
    const project = projectFor(fixture.root, {
      machineId: 'm1', host: '10.0.0.2', username: 'root', remotePath: '/home/root/proj', base: 'proj',
    })
    const api = createFakeApi({ projects: [project] })
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false }, root: fixture.root })
    await provider.refresh()
    const apiCalls = api.calls.length

    const target = provider.describe(project.dir)
    assert.equal(target.cwd, project.dir)
    assert.equal(target.uri, buildUri('m1', '/home/root/proj'))
    assert.equal(target.kind, 'provider')
    assert.equal(target.description, 'root@10.0.0.2:/home/root/proj')
    // 镜像内嵌套路径也认领（会话 cwd 可能是子目录）
    const nested = provider.describe(path.join(project.dir, 'src', 'deep'))
    assert.equal(nested.cwd, project.dir)
    // 非镜像路径
    assert.equal(provider.describe(path.join(fixture.home, 'somewhere')), undefined)
    assert.equal(provider.describe(''), undefined)
    // describe 是同步只读：不调 api、不建目录
    assert.equal(api.calls.length, apiCalls)
    assert.equal(provider.describe(path.join(project.dir, 'brand-new-subdir')).uri, buildUri('m1', '/home/root/proj'))
  } finally {
    fixture.cleanup()
  }
})

test('describe: 未 refresh 且未传 root 时从 cwd 布局推导镜像根（同步兜底）', () => {
  const fixture = workspaceFixture()
  try {
    const project = projectFor(fixture.root, {
      machineId: 'm1', host: '10.0.0.2', username: 'root', remotePath: '/home/root/proj', base: 'proj',
    })
    const api = createFakeApi({ projects: [] })
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false } })
    // 机器缓存为空：仍按 meta 提供只读身份（badge 回落 host）
    const target = provider.describe(project.dir)
    assert.ok(target, 'describe 必须能从 layout 推导 root 并返回 target')
    assert.equal(target.cwd, project.dir)
    assert.equal(target.badge, '10.0.0.2')
  } finally {
    fixture.cleanup()
  }
})

test('describe: Windows 远程路径（C:\\…）也能解析', async () => {
  const fixture = workspaceFixture()
  try {
    const project = projectFor(fixture.root, {
      machineId: 'm2', host: '10.0.0.3', username: 'admin', remotePath: 'C:\\work\\tool', base: 'tool',
    })
    const api = createFakeApi({ projects: [project] })
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false }, root: fixture.root })
    await provider.refresh()
    const target = provider.describe(project.dir)
    assert.equal(target.uri, buildUri('m2', 'C:\\work\\tool'))
    assert.equal(target.badge, 'win-box')
    assert.equal(target.description, 'admin@10.0.0.3:C:\\work\\tool')
  } finally {
    fixture.cleanup()
  }
})

// ── resolve ───────────────────────────────────────────────────────────────

test('resolve: dshremote://<id>/<path> → ensureRemoteWorkspace(register:true) → target', async () => {
  const fixture = workspaceFixture()
  try {
    const api = createFakeApi({})
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false }, root: fixture.root })
    const target = await provider.resolve(buildUri('m1', '/home/root/proj'))

    assert.ok(target)
    const ensures = ensureCalls(api)
    assert.equal(ensures.length, 1)
    assert.deepEqual(ensures[0].options, { machineId: 'm1', remotePath: '/home/root/proj', register: true })
    assert.equal(target.uri, buildUri('m1', '/home/root/proj'))
    assert.equal(target.kind, 'provider')
    assert.equal(target.badge, 'dev-box')
    // resolve 出来的 target 进入缓存，后续 list 能看到
    assert.ok(provider.list().some((entry) => entry.uri === target.uri))
  } finally {
    fixture.cleanup()
  }
})

test('resolve: 机器段支持机器名；Windows 路径原样传给 ensure', async () => {
  const fixture = workspaceFixture()
  try {
    const api = createFakeApi({})
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false }, root: fixture.root })
    const target = await provider.resolve(buildUri('win-box', 'C:\\work\\tool'))
    assert.ok(target)
    assert.deepEqual(ensureCalls(api)[0].options, { machineId: 'm2', remotePath: 'C:\\work\\tool', register: true })
  } finally {
    fixture.cleanup()
  }
})

test('resolve: 未知机器 / 非法 URI / ensure 抛错 → undefined（不 throw）', async () => {
  const fixture = workspaceFixture()
  try {
    const okApi = createFakeApi({})
    const okProvider = createWorkspaceProvider({ api: okApi, config: { tuiProviderListRecent: false }, root: fixture.root })
    assert.equal(await okProvider.resolve('ssh://host/path'), undefined)
    assert.equal(await okProvider.resolve('not-a-uri'), undefined)
    assert.equal(await okProvider.resolve(buildUri('nope', '/x')), undefined)

    const failingApi = createFakeApi({ failEnsure: new Error('SSH auth failed') })
    const failingProvider = createWorkspaceProvider({ api: failingApi, config: { tuiProviderListRecent: false }, root: fixture.root })
    assert.equal(await failingProvider.resolve(buildUri('m1', '/home/root/proj')), undefined)

    const controller = new AbortController()
    controller.abort()
    assert.equal(await okProvider.resolve(buildUri('m1', '/home/root/proj'), controller.signal), undefined)
  } finally {
    fixture.cleanup()
  }
})

// ── resolvePath ───────────────────────────────────────────────────────────

test('resolvePath: 相对 / 上级 / 绝对路径按镜像 remotePath 解析', async () => {
  const fixture = workspaceFixture()
  try {
    const project = projectFor(fixture.root, {
      machineId: 'm1', host: '10.0.0.2', username: 'root', remotePath: '/home/root/proj', base: 'proj',
    })
    const api = createFakeApi({ projects: [project] })
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false }, root: fixture.root })
    await provider.refresh()

    const relative = await provider.resolvePath('src/lib', project.dir)
    assert.ok(relative)
    assert.deepEqual(ensureCalls(api).at(-1).options, {
      machineId: 'm1', remotePath: '/home/root/proj/src/lib', register: true,
    })

    await provider.resolvePath('../other', project.dir)
    assert.equal(ensureCalls(api).at(-1).options.remotePath, '/home/root/other')

    await provider.resolvePath('/srv/elsewhere', project.dir)
    assert.equal(ensureCalls(api).at(-1).options.remotePath, '/srv/elsewhere')

    // 非镜像 cwd 不认领
    assert.equal(await provider.resolvePath('src', path.join(fixture.home, 'local-dir')), undefined)
  } finally {
    fixture.cleanup()
  }
})

test('resolvePath: Windows 镜像用反斜杠解析相对路径', async () => {
  const fixture = workspaceFixture()
  try {
    const project = projectFor(fixture.root, {
      machineId: 'm2', host: '10.0.0.3', username: 'admin', remotePath: 'C:\\work\\tool', base: 'tool',
    })
    const api = createFakeApi({ projects: [project] })
    const provider = createWorkspaceProvider({ api, config: { tuiProviderListRecent: false }, root: fixture.root })
    await provider.refresh()
    const target = await provider.resolvePath('bin', project.dir)
    assert.ok(target)
    assert.equal(ensureCalls(api).at(-1).options.remotePath, 'C:\\work\\tool\\bin')
  } finally {
    fixture.cleanup()
  }
})

test('provider 契约形状：schemes 只声明 dshremote，不提供 rename（宿主回落台账重命名）', () => {
  const provider = createWorkspaceProvider({ api: createFakeApi({}), config: {} })
  assert.deepEqual([...provider.schemes], ['dshremote'])
  assert.equal(provider.rename, undefined)
  assert.equal(typeof provider.list, 'function')
  assert.equal(typeof provider.resolve, 'function')
  assert.equal(typeof provider.resolvePath, 'function')
  assert.equal(typeof provider.describe, 'function')
})
