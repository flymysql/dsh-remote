// dsh-remote TUI — 接入层（lib/tui/index.js）单测。
//
// 不启动真实 dsh-tui：fake ctx 按 cordis 的形状提供 get / on / effect，
//   · get(name, false) 软探测 → 无 TUI 服务时零注册（Web / headless profile 不能多出命令）
//   · on('internal/service') → 覆盖「先 apply、服务后到位」的 boot-order 竞态
//   · effect(fn) → 记录 disposer，断言注册随插件生命周期释放
//   · installTui 同步返回、不 await、绝不抛错（抛错的接缝只 warn）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { installTui, whenService, COMMAND_NAME, SCENE_ID } from '../lib/tui/index.js'
import { createSceneComponent } from '../lib/tui/scene.js'
import { createI18n } from '../lib/tui/i18n.js'

// ── fake ctx / 服务 ───────────────────────────────────────────────────────

/** cordis 形状的最小 fake ctx。 */
function createFakeCtx(services = {}) {
  const listeners = new Map()
  const effects = []
  const ctx = {
    services,
    listeners,
    effects,
    get(name, strict) {
      void strict
      return services[name]
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => {
        const list = listeners.get(event)
        if (!list) return false
        const index = list.indexOf(listener)
        if (index >= 0) list.splice(index, 1)
        return index >= 0
      }
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
  }
  return ctx
}

/** 记录注册行为与 disposer 的 TUI 接缝集合。 */
function createServices(options = {}) {
  const state = {
    commands: [],
    scenes: [],
    workspaces: [],
    statusFields: [],
    opened: [],
    disposals: [],
    warnings: [],
  }
  const logger = {
    warnings: state.warnings,
    warn(message) { state.warnings.push(String(message)) },
    info() {},
    error() {},
    debug() {},
  }
  const services = { logger }

  if (options.commands !== false) {
    services.commands = {
      register(definition) {
        if (options.commandRegisterThrows) throw new Error('command register boom')
        state.commands.push(definition)
        return () => state.disposals.push('command')
      },
    }
  }
  if (options.scenes !== false) {
    services.tuiScenes = {
      register(descriptor, identity) {
        if (options.sceneRegisterThrows) throw new Error('scene register boom')
        state.scenes.push({ descriptor, identity })
        return () => state.disposals.push('scene')
      },
      open(id) {
        state.opened.push(id)
        if (options.sceneOpenThrows) throw new Error('scene open boom')
        return options.openScene !== false
      },
    }
  }
  if (options.workspaces !== false) {
    services.tuiWorkspaces = {
      register(provider) {
        if (options.workspaceRegisterThrows) throw new Error('workspace register boom')
        state.workspaces.push({ provider })
        return () => state.disposals.push('workspace')
      },
    }
  }
  if (options.status !== false) {
    services.tuiStatus = {
      setField(key, text, fieldOptions) {
        if (options.statusSetFieldThrows) throw new Error('status boom')
        state.statusFields.push({ key, text, options: fieldOptions })
        return () => state.disposals.push(`status:${key}`)
      },
    }
  }
  if (options.dialogs) services.tuiDialogs = options.dialogs
  if (options.sessions) services.sessions = options.sessions
  if (options.dshHomePath) services.dshHomePath = options.dshHomePath
  return { state, services }
}

/** fake 宿主 api，记录调用次数。 */
function createFakeApi(options = {}) {
  const counters = { listMachines: 0, listRemoteProjects: 0, subscribe: 0, unsubscribed: false, listener: null }
  const api = {
    apiVersion: 1,
    counters,
    async listMachines() {
      counters.listMachines++
      if (options.failListMachines) throw new Error('listMachines failed')
      if (options.machines !== undefined) return options.machines
      return {
        machines: [{ id: 'm1', name: 'dev-box', host: '10.0.0.2', port: 22, username: 'root' }],
        currentId: 'm1',
      }
    },
    async listRemoteProjects() {
      counters.listRemoteProjects++
      return options.projects || []
    },
    async ensureRemoteWorkspace(input) {
      return {
        machineId: input.machineId,
        remotePath: input.remotePath,
        localMirror: `/tmp/dsh-remote-mirror-${counters.listMachines}`,
        title: 'dev-box-proj',
      }
    },
    subscribe(listener) {
      counters.subscribe++
      counters.listener = listener
      return () => { counters.unsubscribed = true }
    },
  }
  return api
}

/** 触发一次 internal/service 事件（模拟晚挂载的服务）。 */
function fireService(ctx, name, value) {
  const snapshot = [...(ctx.listeners.get('internal/service') || [])]
  for (const listener of snapshot) listener(name, value)
}

/** 跑到所有微任务与 setImmediate 之后（installation 的异步刷新）。 */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/** 只读会话服务的测试替身：list() 按挂载顺序，get() 按 id。 */
function fakeSessions(initial) {
  const sessions = [...initial]
  const shape = (one) => ({
    id: one.id,
    header: { cwd: one.cwd, ...(one.origin ? { origin: one.origin } : {}) },
  })
  return {
    list: () => sessions.map(shape),
    get: (id) => {
      const found = sessions.find((one) => one.id === id)
      return found ? shape(found) : undefined
    },
    /** 模拟 session/disposed 后 store 里真的没有它了。 */
    remove: (id) => {
      const index = sessions.findIndex((one) => one.id === id)
      if (index >= 0) sessions.splice(index, 1)
    },
  }
}

/** 触发一次会话事件（listen 注册在 fake ctx 的 listeners 里）。 */
function emitSession(ctx, event, ...args) {
  for (const listener of ctx.listeners.get(event) || []) listener(...args)
}

/** 等过合并窗口。 */
function waitFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 在临时 DSH_HOME 里造一个合法远程镜像目录。 */
function seedMirror(home, { host = '10.0.0.2', username = 'root', port = 22, remotePath = '/srv/proj', name = 'proj', alias = '' } = {}) {
  const dir = path.join(home, 'remote-workspaces', `${host}-${username}-${port}`, name)
  mkdirSync(dir, { recursive: true })
  const meta = { host, port, username, remotePath, ...(alias ? { alias } : {}) }
  writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify(meta))
  return dir
}

/** 宿主 `dshHomePath` 的真实形状：(...segments) => path。 */
function functionHome(home) {
  return (...segments) => path.join(home, ...segments)
}

/** 运行 ctx.effect 收集到的全部 disposer。 */
function disposeAll(ctx) {
  for (const dispose of [...ctx.effects]) {
    try { dispose() } catch { /* ignore */ }
  }
}

// ── 降级：没有 TUI 服务时零注册 ───────────────────────────────────────────

test('installTui: 无 TUI 服务（Web / headless profile）时零注册、零抛错', async () => {
  const { state, services } = createServices()
  // Web profile 只有 commands / logger，没有任何 tui* 接缝。
  const ctx = createFakeCtx({ logger: services.logger, commands: services.commands })
  const api = createFakeApi()
  assert.equal(installTui(ctx, api, {}), undefined, 'installTui 必须同步返回 void')
  await flush()

  assert.equal(state.commands.length, 0, 'Web profile 不能凭空多出 /dsh-remote')
  assert.equal(state.scenes.length, 0)
  assert.equal(state.workspaces.length, 0)
  assert.equal(state.statusFields.length, 0)
  assert.equal(api.counters.listMachines, 0, '没有 TUI 接缝时不该预热任何数据')
  assert.equal(api.counters.subscribe, 0)
  // 但确实在等晚挂载的服务
  assert.ok((ctx.listeners.get('internal/service') || []).length >= 1)
})

test('installTui: api 缺失 / apiVersion 不符 / config.tui=false 时静默返回', () => {
  const { state } = createServices()
  const ctx = createFakeCtx({ logger: { warn() {} } })
  installTui(ctx, undefined, {})
  installTui(ctx, { apiVersion: 2 }, {})
  installTui(ctx, { apiVersion: 1 }, { tui: false })
  assert.equal(state.commands.length, 0)
  assert.equal(state.scenes.length, 0)
  assert.equal(ctx.listeners.size, 0, '提前返回不应留下监听器')
  assert.equal(ctx.effects.length, 0)
})

test('installTui: 所有服务已就位时注册 command + scene + provider + 状态行', async () => {
  const { state, services } = createServices()
  const ctx = createFakeCtx(services)
  const api = createFakeApi()
  installTui(ctx, api, {})
  await flush()

  // 命令
  assert.equal(state.commands.length, 1)
  assert.equal(state.commands[0].name, COMMAND_NAME)
  assert.equal(state.commands[0].name, 'dsh-remote')
  assert.equal(typeof state.commands[0].handler, 'function')
  assert.ok(state.commands[0].description.length > 0)

  // 场景：id 固定、component 是函数、identity 是本 ctx
  assert.equal(state.scenes.length, 1)
  assert.equal(state.scenes[0].descriptor.id, SCENE_ID)
  assert.equal(state.scenes[0].descriptor.id, 'dsh-remote')
  assert.equal(typeof state.scenes[0].descriptor.component, 'function')
  assert.equal(state.scenes[0].identity, ctx)

  // 工作区 provider
  assert.equal(state.workspaces.length, 1)
  assert.deepEqual([...state.workspaces[0].provider.schemes], ['dshremote'])

  // 状态行：字段 key / 文案 / 固定外观
  assert.ok(state.statusFields.length >= 1)
  const field = state.statusFields.at(-1)
  assert.equal(field.key, 'dsh-remote')
  assert.equal(field.text, 'dev-box')
  assert.deepEqual(field.options, { slot: 'right-head', tone: 'accent', maxCells: 22 })

  // 预热：provider.refresh 调用了 listMachines / listRemoteProjects
  assert.ok(api.counters.listMachines >= 1)
  assert.ok(api.counters.listRemoteProjects >= 1)
})

test('installTui: 命令 handler 打开场景并返回 success；场景拒绝时返回 error', async () => {
  const ready = createServices()
  const ctx = createFakeCtx(ready.services)
  installTui(ctx, createFakeApi(), {})
  await flush()

  const handler = ready.state.commands[0].handler
  const result = await handler({})
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(ready.state.opened, ['dsh-remote'])

  // 场景 open 返回 false 且没有 dialogs → error（不是静默无反应）
  const rejected = createServices({ openScene: false })
  const rejectedCtx = createFakeCtx(rejected.services)
  installTui(rejectedCtx, createFakeApi(), {})
  await flush()
  const failure = await rejected.state.commands[0].handler({})
  assert.equal(failure.kind, 'error')
  assert.equal(typeof failure.text, 'string')
  assert.ok(failure.text.length > 0)
})

test('installTui: 场景 open 抛异常时 handler 仍返回纯数据 error（不 reject）', async () => {
  const { state, services } = createServices({ sceneOpenThrows: true })
  const ctx = createFakeCtx(services)
  installTui(ctx, createFakeApi(), {})
  await flush()
  const result = await state.commands[0].handler({})
  assert.equal(result.kind, 'error')
  assert.ok(state.warnings.some((line) => line.includes('场景打开失败')))
})

test('installTui: 只有 dialogs 接缝时命令走对话框降级流程', async () => {
  const selects = []
  const dialogs = {
    async select(request) { selects.push(request); return undefined },
    async input() { return undefined },
    async confirm() { return false },
  }
  const { state, services } = createServices({ scenes: false, workspaces: false, status: false, dialogs })
  const ctx = createFakeCtx(services)
  const api = createFakeApi()
  installTui(ctx, api, {})
  await flush()

  assert.equal(state.commands.length, 1, '有 dialogs 也要注册命令')
  assert.equal(state.scenes.length, 0)
  const result = await state.commands[0].handler({})
  assert.deepEqual(result, { kind: 'success' })
  assert.equal(selects.length, 1)
  assert.ok(selects[0].options.some((option) => option.id === '__dsh_remote_add__'))
})

// ── boot-order：先 apply、服务后到位 ──────────────────────────────────────

test('installTui: 先 apply 后服务到位时补注册；命令只注册一次', async () => {
  const { state, services } = createServices()
  const ctx = createFakeCtx({ logger: services.logger, commands: services.commands })
  const api = createFakeApi()
  installTui(ctx, api, {})
  await flush()
  assert.equal(state.commands.length, 0, '服务没到位前不该注册任何东西')
  assert.equal(state.scenes.length, 0)

  // dialogs 先到：命令应立刻注册（场景仍缺）
  const dialogs = { select: async () => undefined, input: async () => undefined, confirm: async () => false }
  fireService(ctx, 'tuiDialogs', dialogs)
  assert.equal(state.commands.length, 1, 'dialogs 到位后注册命令')
  assert.equal(state.scenes.length, 0)

  // commands 后到：命令已经注册过，不能重复
  fireService(ctx, 'commands', services.commands)
  assert.equal(state.commands.length, 1, '命令只能注册一次')

  // 场景 / provider / 状态行随后到位
  fireService(ctx, 'tuiScenes', services.tuiScenes)
  fireService(ctx, 'tuiWorkspaces', services.tuiWorkspaces)
  fireService(ctx, 'tuiStatus', services.tuiStatus)
  await flush()
  assert.equal(state.scenes.length, 1)
  assert.equal(state.workspaces.length, 1)
  assert.ok(state.statusFields.length >= 1)

  // 每条 internal/service 监听都是一次性的：触发后自行移除
  assert.equal((ctx.listeners.get('internal/service') || []).length, 0)
})

test('installTui: commands 先到位、TUI 接缝后到位时也能注册命令', async () => {
  const { state, services } = createServices()
  const ctx = createFakeCtx({ logger: services.logger, commands: services.commands })
  installTui(ctx, createFakeApi(), {})
  fireService(ctx, 'commands', services.commands)
  assert.equal(state.commands.length, 0, '没有 TUI 接缝时不能注册命令')
  fireService(ctx, 'tuiScenes', services.tuiScenes)
  assert.equal(state.commands.length, 1, 'TUI 接缝到位后补注册命令')
})

// ── dispose 绑定 / 异常韧性 ───────────────────────────────────────────────

test('installTui: 所有注册的 disposer 都被 ctx.effect 捕获，dispose 时释放', async () => {
  const { state, services } = createServices()
  const ctx = createFakeCtx(services)
  installTui(ctx, createFakeApi(), {})
  await flush()

  assert.ok(ctx.effects.length >= 3, '命令 / 场景 / provider / 状态行都应绑定 disposer')
  disposeAll(ctx)
  for (const kind of ['command', 'scene', 'workspace']) {
    assert.ok(state.disposals.includes(kind), `${kind} 未被释放`)
  }
  assert.ok(state.disposals.some((entry) => entry.startsWith('status:dsh-remote')))
})

test('installTui: 晚到的服务在 dispose 后不再注册', async () => {
  const { state, services } = createServices()
  const ctx = createFakeCtx({})
  installTui(ctx, createFakeApi(), {})
  disposeAll(ctx)
  fireService(ctx, 'tuiScenes', services.tuiScenes)
  fireService(ctx, 'tuiWorkspaces', services.tuiWorkspaces)
  assert.equal(state.scenes.length, 0)
  assert.equal(state.workspaces.length, 0)
})

test('installTui: 接缝注册抛错时只 warn、不炸掉插件', async () => {
  const { state, services } = createServices({
    commandRegisterThrows: true,
    sceneRegisterThrows: true,
    workspaceRegisterThrows: true,
    statusSetFieldThrows: true,
  })
  const ctx = createFakeCtx(services)
  assert.doesNotThrow(() => installTui(ctx, createFakeApi(), {}))
  await flush()
  assert.equal(state.commands.length, 0)
  assert.equal(state.scenes.length, 0)
  assert.equal(state.workspaces.length, 0)
  assert.ok(state.warnings.length >= 3, `应记录多次 warn，实际：${JSON.stringify(state.warnings)}`)
})

test('installTui: listMachines 抛错时状态行与预热都安全降级', async () => {
  const { state, services } = createServices()
  const ctx = createFakeCtx(services)
  installTui(ctx, createFakeApi({ failListMachines: true }), {})
  await flush()
  // 注册仍然完成（失败只影响数据）
  assert.equal(state.commands.length, 1)
  assert.equal(state.scenes.length, 1)
  assert.equal(state.workspaces.length, 1)
  assert.equal(state.statusFields.length, 0, '读不到机器列表就不该写状态行')
})

test('installTui: tuiStatus 形状不符时整段跳过（不猜 API）', async () => {
  const { state, services } = createServices({ status: false })
  services.tuiStatus = { someOtherMethod() {} } // 没有 setField
  const ctx = createFakeCtx(services)
  assert.doesNotThrow(() => installTui(ctx, createFakeApi(), {}))
  await flush()
  assert.equal(state.statusFields.length, 0)
  assert.equal(state.commands.length, 1, '其它接缝不受影响')
})

test('installTui: api.subscribe 触发 provider 刷新与状态行更新', async () => {
  const { state, services } = createServices()
  const ctx = createFakeCtx(services)
  const api = createFakeApi()
  installTui(ctx, api, {})
  await flush()
  assert.equal(api.counters.subscribe, 1)
  const before = api.counters.listMachines

  api.counters.listener({ type: 'machines' })
  await flush()
  assert.ok(api.counters.listMachines > before, 'subscribe 事件应触发 provider.refresh')
  assert.ok(state.statusFields.length >= 1)

  disposeAll(ctx)
  assert.equal(api.counters.unsubscribed, true, 'dispose 时必须退订')
})

test('installTui: 无 sessions 服务（旧组合）时退回旧行为；无当前机则清空字段', async () => {
  const { state, services } = createServices()
  const noCurrent = createFakeApi({
    machines: { machines: [{ id: 'm1', name: 'dev-box', host: '10.0.0.2', port: 22, username: 'root' }], currentId: null },
  })
  const ctx = createFakeCtx(services)
  installTui(ctx, noCurrent, {})
  await flush()
  assert.equal(state.statusFields.at(-1)?.text, undefined)
})

test('installTui: 本地会话（cwd 不在远程镜像）不写机器名', async () => {
  const { state, services } = createServices({ sessions: fakeSessions([{ id: 's1', cwd: '/tmp' }]) })
  const api = createFakeApi()
  const ctx = createFakeCtx(services)
  installTui(ctx, api, {})
  await flush()
  assert.equal(state.statusFields.at(-1)?.text, undefined, '本地会话不该占底栏')
})

test('installTui: 远程镜像会话显示该镜像所属机器名', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-status-'))
  try {
    const mirror = seedMirror(home, { host: '10.0.0.2', username: 'root', port: 22, remotePath: '/srv/proj' })
    const { state, services } = createServices({
      sessions: fakeSessions([{ id: 's1', cwd: mirror }]),
      dshHomePath: functionHome(home),
    })
    const ctx = createFakeCtx(services)
    installTui(ctx, createFakeApi(), {})
    await flush()
    const field = state.statusFields.at(-1)
    assert.equal(field.text, 'dev-box')
    // hover 详情：完整机器名 + user@host:port + 远端路径，与其它底栏字段同一效果
    assert.equal(field.options.detail, '远程机 dev-box · root@10.0.0.2:22 · 远端 /srv/proj')
    assert.equal(field.options.slot, 'right-head')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('installTui: 会话切换跟随 user/message；会话结束后回到本地隐藏', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-status-'))
  try {
    const mirror = seedMirror(home, { host: '10.0.0.2', username: 'root', port: 22, remotePath: '/srv/proj' })
    const sessions = fakeSessions([{ id: 's-local', cwd: '/tmp' }, { id: 's-remote', cwd: mirror }])
    const { state, services } = createServices({ sessions, dshHomePath: functionHome(home) })
    const ctx = createFakeCtx(services)
    installTui(ctx, createFakeApi(), {})
    await flush()
    // 刚启动时取 store 最后进入的会话（远程）→ 显示
    assert.equal(state.statusFields.at(-1).text, 'dev-box')

    // 用户回到本地会话说话 → 隐藏
    emitSession(ctx, 'session/event', sessions.get('s-local'), { type: 'user/message' })
    await waitFor(700)
    assert.equal(state.statusFields.at(-1)?.text, undefined)

    // 再回远程会话说话 → 重新显示
    emitSession(ctx, 'session/event', sessions.get('s-remote'), { type: 'user/message' })
    await waitFor(700)
    assert.equal(state.statusFields.at(-1).text, 'dev-box')

    // 远程会话结束 → 回退到本地会话 → 隐藏
    const ended = sessions.get('s-remote')
    sessions.remove('s-remote')
    emitSession(ctx, 'session/disposed', ended)
    await waitFor(700)
    assert.equal(state.statusFields.at(-1)?.text, undefined)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('installTui: 子代理会话（origin=subagent）不抢“当前会话”', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-status-'))
  try {
    const mirror = seedMirror(home, { host: '10.0.0.2', username: 'root', port: 22, remotePath: '/srv/proj' })
    // store 末尾是本地会话 → 隐藏；随后子代理在镜像 cwd 里创建/说话，都不能把它翻出来
    const sessions = fakeSessions([{ id: 's-remote', cwd: mirror }, { id: 's-local', cwd: '/tmp' }])
    const { state, services } = createServices({ sessions, dshHomePath: functionHome(home) })
    const ctx = createFakeCtx(services)
    installTui(ctx, createFakeApi(), {})
    await flush()
    assert.equal(state.statusFields.at(-1)?.text, undefined)

    emitSession(ctx, 'session/created', { id: 's-agent', header: { cwd: mirror, origin: 'subagent' } })
    emitSession(ctx, 'session/event', { id: 's-agent', header: { cwd: mirror, origin: 'subagent' } }, { type: 'user/message' })
    await waitFor(700)
    assert.equal(state.statusFields.at(-1)?.text, undefined, '子代理不能把底栏翻成远程')

    // 反向：正在看远程会话时，本地子代理出现/说话也不能把它藏掉
    emitSession(ctx, 'session/event', sessions.get('s-remote'), { type: 'user/message' })
    await waitFor(700)
    assert.equal(state.statusFields.at(-1).text, 'dev-box')
    emitSession(ctx, 'session/created', { id: 's-agent2', header: { cwd: '/tmp', origin: 'subagent' } })
    await waitFor(700)
    assert.equal(state.statusFields.at(-1).text, 'dev-box')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('installTui: 切到已挂载会话（无 session 事件）时用宿主 describe(cwd) 提示纠正', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-status-'))
  try {
    const mirror = seedMirror(home, { host: '10.0.0.2', username: 'root', port: 22, remotePath: '/srv/proj' })
    const sessions = fakeSessions([{ id: 's-remote', cwd: mirror }, { id: 's-local', cwd: '/tmp' }])
    const { state, services } = createServices({ sessions, dshHomePath: functionHome(home) })
    const ctx = createFakeCtx(services)
    installTui(ctx, createFakeApi(), {})
    await flush()
    // store 末尾是本地会话 → 隐藏
    assert.equal(state.statusFields.at(-1)?.text, undefined)

    // 宿主切换到一个已挂载的远程会话：只调 provider.describe(新 cwd)，不发 session 事件
    const provider = state.workspaces[0].provider
    assert.ok(provider.describe(mirror), 'describe 应正常返回 target')
    await waitFor(200)
    assert.equal(state.statusFields.at(-1).text, 'dev-box', 'describe 提示应让底栏跟上')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('installTui: sessions.list() 抛错时隐藏（不退回“显示 current 机器”）', async () => {
  const { state, services } = createServices({
    sessions: { list() { throw new Error('sessions boom') } },
  })
  const ctx = createFakeCtx(services)
  installTui(ctx, createFakeApi(), {})
  await flush()
  assert.equal(state.statusFields.at(-1)?.text, undefined)
})

test('installTui: ssh-config 别名机按 alias 命中并显示保存的名字', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-status-'))
  try {
    const mirror = seedMirror(home, {
      host: '10.0.0.2', username: 'root', port: 22, remotePath: '/srv/proj', alias: 'dev-alias',
    })
    const api = createFakeApi({
      machines: {
        machines: [{ id: 'm1', name: 'alias-box', host: 'dev-alias', port: 22, username: '', useSshConfig: true }],
        currentId: 'm1',
      },
    })
    const { state, services } = createServices({
      sessions: fakeSessions([{ id: 's1', cwd: mirror }]),
      dshHomePath: functionHome(home),
    })
    const ctx = createFakeCtx(services)
    installTui(ctx, api, {})
    await flush()
    assert.equal(state.statusFields.at(-1).text, 'alias-box')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('installTui: 相同 text/detail 不重复 setField（宿主会无条件 emit 并记账）', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-status-'))
  try {
    const mirror = seedMirror(home, { host: '10.0.0.2', username: 'root', port: 22, remotePath: '/srv/proj' })
    const { state, services } = createServices({
      sessions: fakeSessions([{ id: 's1', cwd: mirror }]),
      dshHomePath: functionHome(home),
    })
    const ctx = createFakeCtx(services)
    const api = createFakeApi()
    installTui(ctx, api, {})
    await flush()
    assert.equal(state.statusFields.length, 1)
    api.counters.listener({ type: 'machines' })
    await flush()
    assert.equal(state.statusFields.length, 1, '值没变就不该再写一次')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ── whenService 本体 ─────────────────────────────────────────────────────

test('whenService: 服务已存在时同步回调；不存在时等 internal/service', () => {
  const calls = []
  const existing = createFakeCtx({ demoSvc: { id: 1 } })
  whenService(existing, 'demoSvc', (service) => calls.push(['existing', service.id]))
  assert.deepEqual(calls, [['existing', 1]])

  const waiting = createFakeCtx({})
  whenService(waiting, 'demoSvc', (service) => calls.push(['late', service.id]))
  assert.deepEqual(calls, [['existing', 1]])
  fireService(waiting, 'otherSvc', { id: 2 })
  fireService(waiting, 'demoSvc', null)
  assert.deepEqual(calls, [['existing', 1]], '名不符 / 空值不触发')
  fireService(waiting, 'demoSvc', { id: 3 })
  assert.deepEqual(calls, [['existing', 1], ['late', 3]])
})

test('whenService: 事件回调优先使用 ctx.get 取的 traceable 代理（插件归属正确）', () => {
  const calls = []
  const ctx = createFakeCtx({})
  const traced = { id: 'traced' }
  whenService(ctx, 'demoSvc', (service) => calls.push(service))
  // 服务已经进入 ctx 注册表；事件里传的是裸实例
  ctx.services.demoSvc = traced
  fireService(ctx, 'demoSvc', { id: 'raw' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0], traced, '必须用 ctx.get 的代理，否则 TUI 会把注册归属记错 fiber')
})

test('whenService: 回调抛错被吞掉；ctx.on 缺失时静默降级', () => {
  const ctxNoOn = { get: () => undefined, effect: () => {} }
  assert.doesNotThrow(() => whenService(ctxNoOn, 'demoSvc', () => { throw new Error('callback boom') }))
  const ctx = createFakeCtx({ demoSvc: {} })
  assert.doesNotThrow(() => whenService(ctx, 'demoSvc', () => { throw new Error('callback boom') }))
})

// ═══════════════════════════════════════════════════════════════════════════
// 场景组件（lib/tui/scene.js）：fake React 渲染冒烟
//
// 宿主只把 React/ui 作为 props 注入，场景模块本身不 import react（仓库无 JSX、
// 无构建步骤）。因此一个极小的 fake React 就能真正渲染场景：hooks 由数组支撑、
// setState 触发重渲染、useInput 收集键盘回调。它验证的是组件契约与视图状态机，
// 不是 Ink 的排版效果。
// ═══════════════════════════════════════════════════════════════════════════

/** 两次 setImmediate：足够让组件里的异步 action（listMachines / listDir…）落地并重渲染。 */
async function sceneFlush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

function sameDeps(left, right) {
  if (!left || !right || left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

/** 极简 fake-React：只实现场景用到的 5 个 hook + createElement。 */
function createSceneHarness({ api, i18n, channel, close }) {
  const hooks = []
  let cursor = 0
  let scheduled = false
  let component = null
  let tree = null
  let inputHandler = null

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; renderNow() })
  }

  const effects = []
  const runEffects = () => {
    for (const entry of effects.splice(0)) {
      try {
        if (typeof entry.cleanup === 'function') entry.cleanup()
        const cleanup = entry.fn()
        entry.cleanup = typeof cleanup === 'function' ? cleanup : null
      } catch (error) {
        throw new Error(`fake-react effect failed: ${error && error.message}`)
      }
    }
  }

  const React = {
    createElement(type, config, ...children) {
      return { type, props: { ...(config || {}), children: children.length === 1 ? children[0] : children } }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const setValue = (value) => {
        hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
        schedule()
      }
      return [hooks[index], setValue]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(fn, deps) {
      const index = cursor++
      const previous = hooks[index]
      if (previous && sameDeps(previous.deps, deps)) return
      const entry = { fn, deps, cleanup: previous ? previous.cleanup : null }
      hooks[index] = entry
      effects.push(entry)
    },
    useCallback(fn) { cursor++; return fn },
  }

  const ui = {
    Box: 'Box',
    Text: 'Text',
    useInput(handler) { inputHandler = handler },
    useTerminalSize() { return { columns: 100, rows: 26 } },
  }

  const renderNow = () => {
    cursor = 0
    // The scene returns a thin props-guard wrapper element (React.createElement)
    // around the hooking body; render through functional elements the way a
    // reconciler would, so the fake only has to understand one shape.
    let element = component({ React, ui, channel, close })
    for (let depth = 0; element && typeof element.type === 'function' && depth < 8; depth += 1) {
      element = element.type(element.props)
    }
    tree = element
    runEffects()
  }

  const press = async (input, flags = {}) => {
    const key = {
      upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
      pageDown: false, pageUp: false, wheelUp: false, wheelDown: false,
      wheelLeft: false, wheelRight: false, home: false, end: false,
      return: false, escape: false, ctrl: false, shift: false, fn: false,
      tab: false, backspace: false, delete: false, meta: false, super: false,
      ...flags,
    }
    if (!inputHandler) throw new Error('场景没有注册 useInput')
    inputHandler(input, key, {})
    await sceneFlush()
  }

  const text = () => {
    const lines = []
    const walk = (node) => {
      if (node === null || node === undefined || node === false) return
      if (typeof node === 'string' || typeof node === 'number') { lines.push(String(node)); return }
      if (Array.isArray(node)) { for (const child of node) walk(child); return }
      if (node.props) walk(node.props.children)
    }
    walk(tree)
    return lines.join('')
  }

  return {
    setComponent(fn) { component = fn },
    async start() { renderNow(); await sceneFlush() },
    press,
    text,
  }
}

/** 场景测试用的 fake api（覆盖 listMachines / status / listDir / pick / connect…）。 */
function createSceneApi(options = {}) {
  const calls = []
  const machines = options.machines || [{
    id: 'm1',
    name: 'dev-box',
    host: '10.0.0.2',
    port: 22,
    username: 'root',
    useSshConfig: false,
    workspace: '',
    recentWorkspaces: [],
  }]
  const api = {
    apiVersion: 1,
    calls,
    async listMachines() {
      calls.push({ method: 'listMachines' })
      return { machines, currentId: options.currentId === undefined ? 'm1' : options.currentId }
    },
    async status() { return { connected: true, host: '10.0.0.2', username: 'root' } },
    async listDir(input) {
      calls.push({ method: 'listDir', input })
      const base = input.path || '/home/root'
      return {
        path: base,
        parent: base === '/' ? null : '/',
        platform: 'posix',
        items: [
          { name: 'proj', path: `${base}/proj`, type: 'dir', size: 0, mtime: 0 },
          { name: 'readme.txt', path: `${base}/readme.txt`, type: 'file', size: 1, mtime: 0 },
        ],
        machine: { id: 'm1', name: 'dev-box', host: '10.0.0.2', port: 22, username: 'root' },
      }
    },
    async pickRemoteWorkspace(input) {
      calls.push({ method: 'pickRemoteWorkspace', input })
      return { machineId: 'm1', remotePath: input.remotePath, localMirror: '/tmp/mirror', title: 'dev-box-proj' }
    },
    async connect(input) {
      calls.push({ method: 'connect', input })
      return { connected: true, machineId: 'm1', host: '10.0.0.2', username: 'root', port: 22, workspace: '', activeSource: 'manual', forwards: [] }
    },
    async probeMachine(input) {
      calls.push({ method: 'probeMachine', input })
      return { ok: true, host: '10.0.0.2', user: 'root', latencyMs: 12, platform: 'posix', shell: 'bash', usedSavedCredential: false }
    },
    async removeMachine(id) {
      calls.push({ method: 'removeMachine', input: id })
      return { machines: [], currentId: null }
    },
    async upsertMachine(input) {
      calls.push({ method: 'upsertMachine', input })
      return { machine: { ...input, id: input.id || 'm-new' }, machines, currentId: 'm1', warnings: [] }
    },
    async ensureRemoteWorkspace(input) {
      calls.push({ method: 'ensureRemoteWorkspace', input })
      return { machineId: input.machineId, remotePath: input.remotePath, localMirror: '/tmp/mirror', title: 'dev-box-proj' }
    },
    async listWorkspaceMirrors(input) {
      calls.push({ method: 'listWorkspaceMirrors', input })
      if (options.listWorkspacesError) {
        throw new Error(options.listWorkspacesError)
      }
      return options.workspaces || [{
        localMirror: '/mirrors/10.0.0.2-root-22/proj',
        remotePath: '/srv/proj',
        host: '10.0.0.2', port: 22, username: 'root',
        machineId: 'm1', machineName: 'dev-box', title: 'dev-box-proj',
        registered: true, recent: true,
        sessions: [{ id: 'session-a', modifiedAt: 1, live: false }, { id: 'session-b', modifiedAt: 2, live: true }],
        sessionCount: 2, liveSessionCount: 1, mirrorBytes: 2048, mirrorSizeTruncated: false,
      }]
    },
    async deleteRemoteWorkspace(input) {
      calls.push({ method: 'deleteRemoteWorkspace', input })
      if (options.deleteWorkspaceError) {
        const error = new Error(options.deleteWorkspaceError.message || 'busy')
        if (options.deleteWorkspaceError.liveSessions) error.liveSessions = options.deleteWorkspaceError.liveSessions
        throw error
      }
      return {
        localMirror: input.localMirror, remotePath: '/srv/proj',
        removedMirror: true, removedRegistration: true, removedSessions: 2, removedRecents: 1,
      }
    },
    async deleteWorkspaceSessions(input) {
      calls.push({ method: 'deleteWorkspaceSessions', input })
      return { removedSessions: 1, skippedLiveSessions: ['session-b'] }
    },
    async forgetWorkspaceRecent(input) {
      calls.push({ method: 'forgetWorkspaceRecent', input })
      return { removedRecents: 1, clearedMachineWorkspace: 0 }
    },
    subscribe() { return () => {} },
  }
  return api
}

/** 挂载场景并返回操作句柄。 */
async function mountScene(options = {}) {
  const api = options.api || createSceneApi()
  const notifications = []
  const switches = []
  const closeState = { count: 0 }
  const channel = options.channel || {
    notify(text, notifyOptions) { notifications.push({ text, options: notifyOptions }); return () => {} },
    async switchWorkspace(target) { switches.push(target); return true },
  }
  const i18n = createI18n('zh')
  const harness = createSceneHarness({
    api,
    i18n,
    channel,
    close: () => { closeState.count++ },
  })
  harness.setComponent(createSceneComponent({
    api,
    config: options.config || {},
    i18n,
    notify: (text, notifyOptions) => notifications.push({ text, options: notifyOptions }),
  }))
  await harness.start()
  return { api, notifications, switches, closeState, press: harness.press, text: harness.text }
}

test('scene: 列表 → 动作菜单 → 返回列表 → q 关闭', async () => {
  const scene = await mountScene()
  const initial = scene.text()
  assert.match(initial, /dsh-remote · 远程服务器/)
  assert.match(initial, /dev-box/)
  assert.match(initial, /root@10\.0\.0\.2:22/)
  assert.match(initial, /↑↓ 选择/)

  await scene.press('', { return: true })
  const menu = scene.text()
  assert.match(menu, /动作 · dev-box/)
  for (const label of ['连接', '设为工作区', '编辑', '删除', '探测连接', '浏览远程目录']) {
    assert.match(menu, new RegExp(label))
  }

  await scene.press('', { escape: true })
  assert.doesNotMatch(scene.text(), /动作 · dev-box/)
  await scene.press('q')
  assert.equal(scene.closeState.count, 1, '列表根视图 q 应关闭场景')
})

test('scene: 新增表单校验失败留在表单页；修正后 Enter 保存', async () => {
  const scene = await mountScene()
  await scene.press('a')
  assert.match(scene.text(), /新增远程机/)

  // 空 host 直接保存 → 页脚错误，不调用 api
  await scene.press('', { return: true })
  assert.match(scene.text(), /主机不能为空/)
  assert.equal(scene.api.calls.some((call) => call.method === 'upsertMachine'), false)

  // Tab 到 host 字段（name → host），输入后保存
  await scene.press('', { tab: true })
  for (const char of '10.0.0.9') await scene.press(char)
  await scene.press('', { return: true })

  const upsert = scene.api.calls.find((call) => call.method === 'upsertMachine')
  assert.ok(upsert, '合法表单应调用 upsertMachine')
  assert.equal(upsert.input.host, '10.0.0.9')
  assert.equal(upsert.input.name, '10.0.0.9', 'name 留空回落 host')
  assert.equal(upsert.input.username, 'root')
  assert.equal(upsert.input.port, 22)
  assert.ok(scene.notifications.some((entry) => /已保存/.test(entry.text)))
  assert.match(scene.text(), /dev-box/, '保存后回到列表')
})

test('scene: 密码字段掩码显示、永不回显明文', async () => {
  const scene = await mountScene()
  await scene.press('a')
  // name → host → useSshConfig → port → username → auth → password
  for (let index = 0; index < 6; index++) await scene.press('', { tab: true })
  for (const char of 'hunter2') await scene.press(char)
  const rendered = scene.text()
  assert.equal(rendered.includes('hunter2'), false, '密码明文不能出现在渲染树里')
  assert.match(rendered, /•••••••/)
})

test('scene: 编辑并保存时保留表单未包含的机器级设置（backend/workspace/hostKeyMode…）', async () => {
  const machine = {
    id: 'm1',
    name: 'dev-box',
    host: '10.0.0.2',
    port: 22,
    username: 'root',
    useSshConfig: false,
    workspace: '/srv/proj',
    hostKeyMode: 'strict',
    backend: 'openssh',
    sshBinary: '/usr/local/bin/ssh',
    keyboardInteractive: true,
    recentWorkspaces: [],
  }
  const scene = await mountScene({ api: createSceneApi({ machines: [machine] }) })
  await scene.press('e')
  assert.match(scene.text(), /编辑远程机 · dev-box/)
  await scene.press('', { return: true })

  const upsert = scene.api.calls.find((call) => call.method === 'upsertMachine')
  assert.ok(upsert, '表单合法应直接保存')
  assert.equal(upsert.input.id, 'm1')
  assert.equal(upsert.input.backend, 'openssh', 'backend 不能被重置成 native')
  assert.equal(upsert.input.workspace, '/srv/proj', 'workspace 不能被清空')
  assert.equal(upsert.input.hostKeyMode, 'strict')
  assert.equal(upsert.input.sshBinary, '/usr/local/bin/ssh')
  assert.equal(upsert.input.keyboardInteractive, true)
})

test('scene: 浏览远程目录 → 进入子目录 → w 采用并切换工作区', async () => {
  const scene = await mountScene()
  await scene.press('b')

  const firstList = scene.api.calls.find((call) => call.method === 'listDir')
  assert.ok(firstList)
  assert.equal(firstList.input.path, undefined, '首次浏览不指定路径（宿主回落远程 home）')
  assert.match(scene.text(), /远程目录 · \/home\/root/)
  assert.match(scene.text(), /proj\//)
  assert.match(scene.text(), /readme\.txt/)

  await scene.press('', { return: true })
  assert.equal(scene.api.calls.filter((call) => call.method === 'listDir').at(-1).input.path, '/home/root/proj')

  await scene.press('w')
  const pick = scene.api.calls.find((call) => call.method === 'pickRemoteWorkspace')
  assert.ok(pick)
  assert.equal(pick.input.remotePath, '/home/root/proj')
  assert.equal(pick.input.registerWorkspace, true)
  assert.equal(scene.switches.length, 1, 'tuiAutoSwitchWorkspace 默认开启')
  assert.equal(scene.switches[0].kind, 'provider')
  assert.equal(scene.switches[0].uri, 'dshremote://m1/%2Fhome%2Froot%2Fproj')
  assert.ok(scene.notifications.some((entry) => /已采用工作区/.test(entry.text)))

  await scene.press('', { escape: true })
  assert.ok(scene.api.calls.some((call) => call.method === 'listMachines'), 'Esc 回到列表')
})

test('scene: tuiAutoSwitchWorkspace=false 时只采用工作区、不切会话', async () => {
  const scene = await mountScene({ config: { tuiAutoSwitchWorkspace: false } })
  await scene.press('b')
  await scene.press('w')
  assert.ok(scene.api.calls.some((call) => call.method === 'pickRemoteWorkspace'))
  assert.equal(scene.switches.length, 0)
  assert.ok(scene.notifications.some((entry) => /已采用工作区/.test(entry.text)))
})

test('scene: 删除需要二次确认；探测 / 连接走 api 并提示', async () => {
  const scene = await mountScene()

  await scene.press('d')
  assert.match(scene.text(), /确定删除「dev-box」？/)
  await scene.press('y')
  assert.deepEqual(
    scene.api.calls.filter((call) => call.method === 'removeMachine').map((call) => call.input),
    ['m1'],
  )

  await scene.press('t')
  assert.ok(scene.api.calls.some((call) => call.method === 'probeMachine'))
  assert.ok(scene.notifications.some((entry) => /连接正常/.test(entry.text)))

  await scene.press('c')
  const connect = scene.api.calls.find((call) => call.method === 'connect')
  assert.ok(connect)
  assert.deepEqual(connect.input, { machineId: 'm1', persist: true })
})

test('scene: 超长机器列表只渲染可视窗口（自己算 offset）', async () => {
  const machines = Array.from({ length: 40 }, (_, index) => ({
    id: `m${index}`,
    name: `示例-${index}`,
    host: '10.0.0.2',
    port: 22,
    username: 'root',
    useSshConfig: false,
    workspace: '',
    recentWorkspaces: [],
  }))
  const scene = await mountScene({ api: createSceneApi({ machines }) })
  const firstPaint = scene.text()
  assert.match(firstPaint, /示例-0/)
  assert.doesNotMatch(firstPaint, /示例-39/)
  const painted = firstPaint.match(/示例-\d+/g) || []
  assert.ok(painted.length <= 21, `只渲染一屏（bodyHeight=20），实际 ${painted.length} 行`)

  for (let index = 0; index < 25; index++) await scene.press('', { downArrow: true })
  const scrolled = scene.text()
  assert.doesNotMatch(scrolled, /示例-0/)
  assert.match(scrolled, /示例-25/)
})

// ── 定向复审补充：降级路径与语言开关 ─────────────────────────────────────

test('installTui: dialogs 缺少 select/input/confirm 时命令返回 error，而不是静默成功', async () => {
  // Only `select` exists: the fallback flow cannot run, and a silent success
  // would look like "the dialog opened and did nothing".
  const dialogs = { async select() { return undefined } }
  const { state, services } = createServices({ scenes: false, workspaces: false, status: false, dialogs })
  const ctx = createFakeCtx(services)
  installTui(ctx, createFakeApi(), {})
  await flush()

  assert.equal(state.commands.length, 1)
  const result = await state.commands[0].handler({})
  assert.equal(result.kind, 'error')
  assert.ok(result.text, 'the error carries a user-facing reason')
})

test('installTui: tuiLang 决定 /dsh-remote 的命令描述语言', async () => {
  const zh = createServices()
  installTui(createFakeCtx(zh.services), createFakeApi(), {})
  await flush()
  const en = createServices()
  installTui(createFakeCtx(en.services), createFakeApi(), { tuiLang: 'en' })
  await flush()

  assert.equal(zh.state.commands[0].description, createI18n().t('cmd.description'))
  assert.equal(en.state.commands[0].description, createI18n('en').t('cmd.description'))
  assert.notEqual(zh.state.commands[0].description, en.state.commands[0].description)
})

// ── 回归：Esc 被 meta 标记（dsh-tui 的 Ink 兼容行为）──

test('scene: 单独 Esc 带 meta:true 时仍能逐级返回（列表/菜单/浏览）', async () => {
  // dsh-tui 的 InputEvent 把孤独的 Escape 标成 { escape:true, meta:true }
  // （lib/types/ink/events/input-event.js），历史实现把它当 Alt 组合吞掉了。
  const scene = await mountScene()

  // 菜单 → Esc(meta) → 列表
  await scene.press('', { return: true })
  assert.match(scene.text(), /动作 · dev-box/)
  await scene.press('', { escape: true, meta: true })
  assert.doesNotMatch(scene.text(), /动作 · dev-box/)
  assert.match(scene.text(), /dsh-remote · 远程服务器/)

  // 浏览 → Esc(meta) → 列表（用户报的正是这一条）
  await scene.press('b')
  assert.match(scene.text(), /远程目录/)
  await scene.press('', { escape: true, meta: true })
  assert.doesNotMatch(scene.text(), /远程目录/)
  assert.match(scene.text(), /dsh-remote · 远程服务器/)

  // 列表根 → Esc(meta) → 关闭
  await scene.press('', { escape: true, meta: true })
  assert.equal(scene.closeState.count, 1)
})

test('scene: 浏览从该机器已记录的远程工作区开始', async () => {
  const scene = await mountScene({
    api: createSceneApi({ machines: [{ id: 'm1', name: 'dev-box', host: '10.0.0.2', port: 22, username: 'root', workspace: '/srv/app', recentWorkspaces: [] }] }),
  })
  await scene.press('b')
  const first = scene.api.calls.filter((call) => call.method === 'listDir').at(-1)
  assert.equal(first.input.path, '/srv/app', 'b 浏览应从 machine.workspace 开始')
})

test('scene: 左右方向键做层级导航（→ 进入 / ← 返回上级）', async () => {
  const scene = await mountScene()
  // 列表 → → → 动作菜单
  await scene.press('', { rightArrow: true })
  assert.match(scene.text(), /动作 · dev-box/)
  // 菜单 ← → 列表
  await scene.press('', { leftArrow: true })
  assert.doesNotMatch(scene.text(), /动作 · dev-box/)

  // 列表 → b 浏览 → → 进入 proj 子目录 → ← 逐级返回 → 根目录再 ← 退出浏览
  await scene.press('b')
  assert.match(scene.text(), /远程目录/)
  await scene.press('', { rightArrow: true })
  const entered = scene.api.calls.filter((call) => call.method === 'listDir').at(-1)
  assert.equal(entered.input.path, '/home/root/proj', '→ 应进入选中的目录')
  await scene.press('', { leftArrow: true })
  const upOne = scene.api.calls.filter((call) => call.method === 'listDir').at(-1)
  assert.equal(upOne.input.path, '/', '← 应回到上级目录（fake 的 proj 上级是 /）')
  assert.match(scene.text(), /远程目录/)
  await scene.press('', { leftArrow: true })
  assert.doesNotMatch(scene.text(), /远程目录/, '根目录再 ← 退出浏览视图')
  // 列表根视图 ← 关闭场景
  await scene.press('', { leftArrow: true })
  assert.equal(scene.closeState.count, 1, '列表根视图 ← 关闭场景')
})

// ── 工作区清理页（删除镜像 / 删除对话 / 移出最近列表） ─────────────────────

test('scene: 工作区管理列出本地镜像、对话数与占用状态，Esc 返回列表', async () => {
  const scene = await mountScene()
  await scene.press('', { return: true })
  assert.match(scene.text(), /动作 · dev-box/)
  await scene.press('m')
  await scene.press('', { tick: true })
  const text = scene.text()
  assert.match(text, /工作区 · dev-box/)
  assert.match(text, /dev-box-proj/)
  assert.match(text, /2 个对话/)
  assert.match(text, /1 个使用中/)
  assert.match(text, /镜像 2\.0 KB/)
  assert.match(text, /已登记/)
  assert.match(text, /最近/)
  assert.match(text, /root@10\.0\.0\.2:\/srv\/proj/)
  assert.match(text, /d 删除工作区/)
  const listCall = scene.api.calls.find((call) => call.method === 'listWorkspaceMirrors')
  assert.ok(listCall)
  assert.equal(listCall.input.machineId, 'm1')

  await scene.press('', { escape: true })
  assert.match(scene.text(), /dsh-remote · 远程服务器/, 'Esc 回到机器列表')
})

test('scene: d 打开删除确认，y 调 deleteRemoteWorkspace 并提示结果', async () => {
  const scene = await mountScene()
  await scene.press('', { return: true })
  await scene.press('m')
  await scene.press('', { tick: true })
  await scene.press('d')
  const confirm = scene.text()
  assert.match(confirm, /删除工作区「dev-box-proj」？/)
  assert.match(confirm, /将删除本地镜像目录、工作区登记和 2 个对话/)
  assert.match(confirm, /不可恢复/)
  assert.match(confirm, /y \/ → \/ Enter 确认/)

  await scene.press('y')
  await scene.press('', { tick: true })
  const call = scene.api.calls.find((entry) => entry.method === 'deleteRemoteWorkspace')
  assert.ok(call)
  assert.equal(call.input.localMirror, '/mirrors/10.0.0.2-root-22/proj')
  assert.equal(call.input.deleteSessions, true)
  assert.ok(scene.notifications.some((entry) => /已删除工作区 dev-box-proj/.test(entry.text)))
  assert.ok(scene.api.calls.filter((entry) => entry.method === 'listWorkspaceMirrors').length >= 2, '删除后刷新列表')
})

test('scene: x 仅删除对话，跳过使用中的会话并提示', async () => {
  const scene = await mountScene()
  await scene.press('', { return: true })
  await scene.press('m')
  await scene.press('', { tick: true })
  await scene.press('x')
  assert.match(scene.text(), /删除「dev-box-proj」下的对话？/)
  assert.match(scene.text(), /保留本地镜像目录与工作区登记/)
  await scene.press('', { return: true })
  await scene.press('', { tick: true })
  const call = scene.api.calls.find((entry) => entry.method === 'deleteWorkspaceSessions')
  assert.ok(call)
  assert.equal(call.input.localMirror, '/mirrors/10.0.0.2-root-22/proj')
  assert.ok(scene.notifications.some((entry) => /已删除 1 个对话；1 个正在使用，已跳过/.test(entry.text)))
})

test('scene: r 从最近列表移除，不删镜像与对话', async () => {
  const scene = await mountScene()
  await scene.press('', { return: true })
  await scene.press('m')
  await scene.press('', { tick: true })
  await scene.press('r')
  assert.match(scene.text(), /从最近列表移除「dev-box-proj」？/)
  await scene.press('', { return: true })
  await scene.press('', { tick: true })
  assert.ok(scene.api.calls.some((entry) => entry.method === 'forgetWorkspaceRecent'))
  assert.equal(scene.api.calls.some((entry) => entry.method === 'deleteRemoteWorkspace'), false)
  assert.ok(scene.notifications.some((entry) => /已移出最近列表/.test(entry.text)))
})

test('scene: 会话仍被占用时删除被拒绝，页脚给出停止提示', async () => {
  const scene = await mountScene({
    api: createSceneApi({
      deleteWorkspaceError: { message: 'WORKSPACE_BUSY', liveSessions: ['session-b'] },
    }),
  })
  await scene.press('', { return: true })
  await scene.press('m')
  await scene.press('', { tick: true })
  await scene.press('d')
  await scene.press('y')
  await scene.press('', { tick: true })
  assert.match(scene.text(), /还有 1 个会话正在使用该工作区，请先停止它们/)
  assert.match(scene.text(), /工作区 · dev-box/, '删除失败仍留在工作区页')
})

test('scene: 确认页 Esc / ← 取消，不会调用删除', async () => {
  const scene = await mountScene()
  await scene.press('', { return: true })
  await scene.press('m')
  await scene.press('', { tick: true })
  await scene.press('d')
  await scene.press('', { escape: true })
  assert.equal(scene.api.calls.some((entry) => entry.method === 'deleteRemoteWorkspace'), false)
  assert.match(scene.text(), /工作区 · dev-box/)
  await scene.press('d')
  await scene.press('', { leftArrow: true })
  assert.equal(scene.api.calls.some((entry) => entry.method === 'deleteRemoteWorkspace'), false)
  // 工作区页 ← 回到机器列表
  await scene.press('', { leftArrow: true })
  assert.match(scene.text(), /dsh-remote · 远程服务器/)
})
