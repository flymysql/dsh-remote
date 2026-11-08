// dsh-remote TUI 接入层入口：命令 / 全屏场景 / 工作区 provider / 状态行。
//
// 设计要点（见 docs/tui.md §4 与 .cache/recon/tui-seams.md）：
//   · 所有 TUI 服务用 `ctx.get(name, false)` **软探测**；Web profile / headless
//     profile 里这些服务永远不存在，插件必须静默降级、不注册任何东西。
//   · cordis 各行并发激活，`ctx.get` 在 apply 执行时可能还没就位；而 `ctx.inject`
//     会让整段 fiber 永久 pending。因此统一用 `whenService()`：服务已在则立即
//     执行，否则监听 `internal/service` 事件，到位后一次性执行。
//   · `installTui` 同步返回、不 await、绝不抛错：内部 try/catch + logger.warn。
//   · 每个注册返回的 disposer 都用 `ctx.effect(() => () => dispose())` 绑定生命周期。

import os from 'node:os'
import path from 'node:path'
import { resolveMirror } from '../binding.js'
import { createI18n } from './i18n.js'
import { clipCells } from './format.js'
import { createWorkspaceProvider, matchMachineForMirror } from './provider.js'
import { createSceneComponent } from './scene.js'
import { runDialogFlow } from './flow.js'

/** 场景 id（kebab-case，全局唯一）。 */
export const SCENE_ID = 'dsh-remote'
/** slash 命令名（dsh-commands 要求 /^[a-z][a-z0-9_-]*$/）。 */
export const COMMAND_NAME = 'dsh-remote'
/** 状态行字段 key。 */
const STATUS_KEY = 'dsh-remote'
/** 状态行字段的固定外观（docs/tui.md §4.4）。 */
const STATUS_OPTIONS = { slot: 'right-head', tone: 'accent', maxCells: 22 }

/** `ctx.get` 的软封装：ctx 缺失、服务缺失、代理抛错一律当“不存在”。 */
function getService(ctx, name) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return undefined
    const service = ctx.get(name, false)
    return service === null ? undefined : service
  } catch {
    return undefined
  }
}

/** logger.warn 的软封装（logging 失败绝不影响注册流程）。 */
function warn(ctx, message, error) {
  try {
    const logger = getService(ctx, 'logger')
    if (!logger || typeof logger.warn !== 'function') return
    const detail = error && (error.message || error)
    logger.warn(`[dsh-remote] tui: ${message}${detail ? ': ' + detail : ''}`)
  } catch { /* logging is best-effort */ }
}

/** 把 disposer 绑到当前 context 的生命周期上（ctx.effect 缺失时静默跳过）。 */
function bindEffect(ctx, dispose) {
  if (typeof dispose !== 'function') return
  try {
    if (!ctx || typeof ctx.effect !== 'function') return
    ctx.effect(() => () => {
      try { dispose() } catch { /* teardown is best-effort */ }
    })
  } catch (error) {
    warn(ctx, 'effect binding failed', error)
  }
}

/**
 * 服务到位后再执行回调（只执行一次）。
 *
 * cordis 的 `internal/service` 事件在服务变化时同步发出（见
 * @deepseek-ai/cordis lib/index.js 的 notify()）。若服务在 apply 时已经就位，
 * 直接同步执行；否则等事件。回调异常被吞掉并 warn —— 一个 TUI 接缝注册失败
 * 不能让插件（以及整个宿主）崩掉。
 *
 * @param {object} ctx - cordis context。
 * @param {string} name - 服务名（`tuiScenes` / `commands` / …）。
 * @param {(service: object) => void} callback - 服务到位时执行一次。
 */
export function whenService(ctx, name, callback) {
  const existing = getService(ctx, name)
  if (existing !== undefined) {
    try { callback(existing) } catch (error) { warn(ctx, `${name} 初始化失败`, error) }
    return
  }
  if (!ctx || typeof ctx.on !== 'function') return
  let off
  const listener = (serviceName, value) => {
    if (serviceName !== name) return
    // 事件里拿到的是**裸** service 实例；经 ctx.get 再取一次才能得到 cordis 的
    // traceable 代理（把 this.ctx 指向本插件 activation）。TUI 的
    // tuiWorkspaces.register / tuiScenes.register 会校验调用方身份，直接用裸
    // 实例会把归属记到服务自己的 fiber 上，所以优先用代理。
    const traced = getService(ctx, name)
    if (traced === undefined && !value) return
    try { if (typeof off === 'function') off() } catch { /* already removed */ }
    off = undefined
    const service = traced === undefined ? value : traced
    if (!service) return
    try { callback(service) } catch (error) { warn(ctx, `${name} 初始化失败`, error) }
  }
  try {
    off = ctx.on('internal/service', listener)
  } catch (error) {
    warn(ctx, `无法监听 ${name} 服务`, error)
    return
  }
  bindEffect(ctx, () => { if (typeof off === 'function') off() })
}

/**
 * 安装 TUI 适配层。
 *
 * @param {object} ctx - 插件自己的 cordis context。
 * @param {object} api - 宿主进程内 API（`ctx.dshRemote`，apiVersion 1）。
 * @param {object} [config] - 行 config（tui / tuiProviderListRecent /
 *   tuiProviderRecentLimit / tuiAutoSwitchWorkspace / tuiLang）。
 * @returns {void} 同步返回，永不 reject / throw。
 */
export function installTui(ctx, api, config) {
  try {
    if (config && config.tui === false) return
    if (!api || api.apiVersion !== 1) return
    if (!ctx || typeof ctx.get !== 'function') return

    const i18n = createI18n(config && (config.tuiLang || config.lang))
    const sceneComponent = createSceneComponent({
      api,
      config: config || {},
      i18n,
      notify: (text, options) => {
        const toast = getService(ctx, 'tuiToast')
        if (toast && typeof toast.show === 'function') {
          try { toast.show(text, options); return } catch { /* fall through */ }
        }
        warn(ctx, String(text))
      },
    })

    // ── 内部可变状态（全是本插件生命周期内的单例） ────────────────────────
    let provider = null
    let workspacesSeen = false
    let commandsSeen = null
    let commandWanted = false
    let commandRegistered = false
    let tuiActive = false
    let statusService = null
    let statusFieldDispose = null
    let statusRefreshToken = 0
    /** 最近进入 store 的会话 / 最近收到用户输入的会话（见 activeSessionCwd）。 */
    let activeSessionId = null
    let lastUserSessionId = null
    /** 宿主每次会话切换都会用新 cwd 调 provider.describe()：那是“当前会话”的
     *  可靠提示（sessions 事件覆盖不到 live 会话切换）。见 noteHostSessionCwd。 */
    let hostSessionCwd = ''
    /** 插件卸载后，仍在 await 的刷新不得再写底栏。 */
    let disposed = false
    /** 上一次写入的 text/detail：相同值不重复 setField（宿主会无条件 emit 并记账）。 */
    let lastStatusWrite = null
    bindEffect(ctx, () => { disposed = true })

    const ensureProvider = () => {
      if (!provider) {
        provider = createWorkspaceProvider({
          api,
          config: config || {},
          logger: getService(ctx, 'logger'),
          onDescribe: noteHostSessionCwd,
        })
      }
      return provider
    }

    /** 注册 `/dsh-remote`（只会注册一次；失败时允许后续重试）。 */
    const registerCommand = (commands) => {
      if (commandRegistered || !commands || typeof commands.register !== 'function') return
      commandRegistered = true
      let dispose
      try {
        dispose = commands.register({
          name: COMMAND_NAME,
          description: i18n.t('cmd.description'),
          handler: async (invocation) => {
            try {
              const scenes = getService(ctx, 'tuiScenes')
              if (scenes && typeof scenes.open === 'function') {
                let opened = false
                try { opened = scenes.open(SCENE_ID) === true } catch (error) { warn(ctx, '场景打开失败', error) }
                if (opened) return { kind: 'success' }
              }
              const dialogs = getService(ctx, 'tuiDialogs')
              if (dialogs) {
                const result = await runDialogFlow({
                  api,
                  dialogs,
                  i18n,
                  channel: invocation && invocation.channel,
                })
                // `runDialogFlow` returns undefined ONLY when the dialog seam
                // lacks select/input/confirm (cancellation returns a success
                // result) — reporting that as success would look like a no-op.
                return result || { kind: 'error', text: i18n.t('cmd.unavailable') }
              }
              return { kind: 'error', text: i18n.t('cmd.unavailable') }
            } catch (error) {
              return { kind: 'error', text: i18n.t('cmd.failed', { err: String((error && error.message) || error) }) }
            }
          },
        })
      } catch (error) {
        commandRegistered = false
        warn(ctx, '命令注册失败', error)
        return
      }
      bindEffect(ctx, dispose)
    }

    /** 有任意 TUI UI 接缝时才开始“激活”（命令注册 / api 订阅 / 状态行）。 */
    const ensureCommand = () => {
      commandWanted = true
      if (commandsSeen) registerCommand(commandsSeen)
    }

    /** 状态行字段：只在服务形状符合契约时写入，否则整段跳过（不猜 API）。
     *  `detail` 是鼠标悬停时补在空闲提示行上的说明（宿主按 `inactiveShimmer`
     *  渲染，单行、上限 160 cells，与其它底栏字段的 hover 效果一致）。
     *  宿主对 detail 只按 160 cells 截断、不做“适配当前宽度”的 truncate，超宽会
     *  wrap 进看不见的第二行；所以按终端宽度自己裁：状态行内宽是 columns-2
     *  （宿主 paddingX=1），再给右侧 MiniWake/activity 预留 16 格，下限 8。 */
    const applyStatusField = (text, detail) => {
      if (disposed) return
      if (!statusService || typeof statusService.setField !== 'function') return
      try {
        const columns = Number(process.stdout && process.stdout.columns) || 80
        const clipped = detail ? clipCells(detail, Math.max(8, columns - 18)) : ''
        // 相同值不重复写：宿主 store 会对同 text 的 setField 也 emit，并往
        // append-only 的 effect-ledger 记一笔。从未写过时也不要发“空清除”。
        const previous = lastStatusWrite
        if (previous && previous.text === text && previous.detail === clipped) return
        if (!previous && text === undefined && !clipped) return
        lastStatusWrite = { text, detail: clipped }
        const options = clipped ? { ...STATUS_OPTIONS, detail: clipped } : STATUS_OPTIONS
        // 第 4 个参数是插件自己的 ctx（只用于 effect ledger 归属，可省略）。
        const next = statusService.setField(STATUS_KEY, text, options, ctx)
        if (statusFieldDispose) {
          const previous = statusFieldDispose
          statusFieldDispose = null
          try { previous() } catch { /* already cleared */ }
        }
        if (typeof next === 'function') statusFieldDispose = next
      } catch (error) {
        warn(ctx, '状态行更新失败', error)
      }
    }

    /** 子代理会话也会进 store、也会发 `user/message`，但它不是用户在看的会话。 */
    const isSubagentSession = (session) => {
      const origin = session && session.header && session.header.origin
      return origin === 'subagent'
    }

    /** 本进程的 live 会话（不含子代理）。`null` = 宿主没有 sessions 服务（旧组合），
     *  `[]` = 服务在但读不到/读抛错 → 调用方按“没有远程会话”处理。 */
    const liveSessions = () => {
      const sessions = getService(ctx, 'sessions')
      if (!sessions || typeof sessions.list !== 'function') return null
      try {
        const list = sessions.list()
        if (!Array.isArray(list)) return []
        return list.filter((one) => one && one.header && one.header.cwd && !isSubagentSession(one))
      } catch (error) {
        warn(ctx, '会话列表读取失败', error)
        return []
      }
    }

    /** 当前 TUI 会话的 cwd。
     *
     * TUI 进程里可以同时有多个 live session（挂载中的会话 + parked 后台会话），
     * 而“切到已挂载会话”不会发 session/* 事件。插件拿不到宿主 channel，按可靠性
     * 依次采信：① 宿主切换会话时传入 provider.describe() 的 cwd（只在这种情况下
     * 才算数，并交叉校验它确实属于某个 live 会话）；② 最近进入/用户说过话的
     * 会话；③ store 里最后进入的会话。 */
    const activeSessionCwd = () => {
      const list = liveSessions()
      if (list === null) return { supported: false, cwd: '' }
      const cwds = new Set(list.map((one) => String(one.header.cwd)))
      if (hostSessionCwd && cwds.has(hostSessionCwd)) return { supported: true, cwd: hostSessionCwd }
      const cwdOf = (id) => {
        if (!id) return ''
        const one = list.find((candidate) => String(candidate.id) === String(id))
        return one ? String(one.header.cwd) : ''
      }
      let cwd = cwdOf(activeSessionId) || cwdOf(lastUserSessionId)
      if (!cwd && list.length > 0) cwd = String(list[list.length - 1].header.cwd)
      return { supported: true, cwd }
    }

    /** 宿主在会话切换/工作区描述时把当前 cwd 交给 provider.describe()；记下来，
     *  由 activeSessionCwd 交叉校验后使用。 */
    const noteHostSessionCwd = (cwd) => {
      const value = String(cwd || '')
      if (!value || value === hostSessionCwd) return
      hostSessionCwd = value
      void refreshStatusField()
    }

    /** `$DSH_HOME`：宿主的 `dshHomePath` 服务是**函数**（`(...segments) => path`），
     *  老版本/测试里也可能是字符串或 `{path}`；都没有时退回环境变量/`~/.dsh`。 */
    const dshHomePath = () => {
      const service = getService(ctx, 'dshHomePath')
      if (typeof service === 'function') {
        try {
          const home = service()
          if (typeof home === 'string' && home) return home
        } catch { /* fall through to the string forms */ }
      }
      if (typeof service === 'string' && service) return service
      if (service && typeof service.path === 'string' && service.path) return service.path
      return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    }

    /** 会话在远程镜像里 → `{label, detail}`；本地会话 / 无会话 → ''。
     *  `detail` 供底栏 hover 使用：完整机器名 + `user@host:port` + 远端路径。
     *  `null` 表示宿主没有 sessions 服务（旧组合），调用方退回旧行为。 */
    const remoteSessionLabel = (machines) => {
      const { supported, cwd } = activeSessionCwd()
      if (!supported) return null
      if (!cwd) return ''
      let resolved
      try {
        resolved = resolveMirror(cwd, path.join(dshHomePath(), 'remote-workspaces'))
      } catch {
        return ''
      }
      const machine = resolved && resolved.machine
      if (!machine || !resolved.remotePath) return ''
      // 与 provider 的机器匹配共用一套规则：ssh-config 别名机按 alias 命中，
      // 字面机按 host/port/username 命中。
      const match = matchMachineForMirror(machines, machine)
      const label = String(((match && (match.name || match.host)) || machine.alias || machine.host || '')).trim()
      const parts = []
      if (label) parts.push(i18n.t('status.detailMachine', { name: label }))
      parts.push(i18n.t('status.detailTarget', {
        user: machine.username || '',
        host: machine.host || '',
        port: Number(machine.port) || 22,
      }))
      parts.push(i18n.t('status.detailRemote', { path: resolved.remotePath }))
      return { label, detail: parts.filter(Boolean).join(' · ') }
    }

    /** 读当前机器名并写状态行；旧结果（token 过期）直接丢弃。
     *
     * 只在**当前会话的 cwd 落在远程镜像里**时显示（用户报告的“本地目录也显示
     * 服务器名”就是待机机器被无条件写进底栏）。没有 sessions 服务的旧组合
     * 退回旧行为，不猜。 */
    const refreshStatusField = async () => {
      if (!statusService || typeof statusService.setField !== 'function') return
      if (typeof api.listMachines !== 'function') return
      const token = ++statusRefreshToken
      let machines = []
      let currentId = null
      try {
        const result = await api.listMachines()
        machines = Array.isArray(result && result.machines) ? result.machines : []
        currentId = result && result.currentId !== undefined ? result.currentId : null
      } catch (error) {
        warn(ctx, '状态行读取机器列表失败', error)
        // 读不到机器列表时不要留下旧机器名（那正是“待机机器占底栏”的观感来源）。
        applyStatusField(undefined)
        return
      }
      if (token !== statusRefreshToken || disposed) return
      const current = machines.find((machine) => machine && machine.id === currentId)
      const remote = remoteSessionLabel(machines)
      const label = remote === null
        ? (current ? String(current.name || current.host || '').trim() : '')
        : remote.label
      applyStatusField(label || undefined, remote && remote.detail)
    }

    /** 会话事件合并刷新：会话进入/结束、用户在哪说话都会改变“当前会话”。
     *  500ms 合并避免连续事件重复跑 listMachines。 */
    const SESSION_REFRESH_MS = 500
    let sessionRefreshTimer = null
    const scheduleStatusRefresh = () => {
      if (sessionRefreshTimer) return
      sessionRefreshTimer = setTimeout(() => {
        sessionRefreshTimer = null
        void refreshStatusField()
      }, SESSION_REFRESH_MS)
      if (typeof sessionRefreshTimer.unref === 'function') sessionRefreshTimer.unref()
    }

    /** 任意 TUI 接缝出现后：订阅宿主变更（刷新 provider 缓存 + 状态行）。 */
    const markTuiActive = () => {
      if (tuiActive) return
      tuiActive = true
      if (typeof api.subscribe === 'function') {
        let dispose
        try {
          dispose = api.subscribe(() => {
            if (workspacesSeen && provider) {
              try { void provider.refresh() } catch (error) { warn(ctx, 'provider 刷新失败', error) }
            }
            void refreshStatusField()
          })
        } catch (error) {
          warn(ctx, 'api.subscribe 失败', error)
        }
        bindEffect(ctx, dispose)
      }
      // 会话进入/结束、用户发消息都会改变“当前会话”，据此刷新底栏字段。
      if (typeof ctx.on === 'function') {
        const disposers = []
        const subscribe = (event, listener) => {
          try {
            const dispose = ctx.on(event, listener)
            if (typeof dispose === 'function') disposers.push(dispose)
          } catch (error) {
            warn(ctx, `会话事件订阅失败（${event}）`, error)
          }
        }
        subscribe('session/created', (session) => {
          if (!session || session.id == null || isSubagentSession(session)) return
          activeSessionId = String(session.id)
          scheduleStatusRefresh()
        })
        subscribe('session/disposed', (session) => {
          if (!session || session.id == null || isSubagentSession(session)) return
          const id = String(session.id)
          if (id === activeSessionId) {
            activeSessionId = lastUserSessionId && lastUserSessionId !== id ? lastUserSessionId : null
          }
          if (id === lastUserSessionId) lastUserSessionId = null
          if (hostSessionCwd && !activeSessionId) hostSessionCwd = ''
          scheduleStatusRefresh()
        })
        subscribe('session/event', (session, event) => {
          if (!event || event.type !== 'user/message' || isSubagentSession(session)) return
          if (!session || session.id == null) return
          lastUserSessionId = String(session.id)
          activeSessionId = String(session.id)
          scheduleStatusRefresh()
        })
        bindEffect(ctx, () => {
          if (sessionRefreshTimer) {
            clearTimeout(sessionRefreshTimer)
            sessionRefreshTimer = null
          }
          for (const dispose of disposers) {
            try { dispose() } catch { /* teardown is best-effort */ }
          }
        })
      }
      // 终端变窄/变宽后详情要重新裁：否则旧字符串会 wrap 进看不见的第二行。
      if (process.stdout && typeof process.stdout.on === 'function') {
        const onResize = () => scheduleStatusRefresh()
        try {
          process.stdout.on('resize', onResize)
          bindEffect(ctx, () => process.stdout.removeListener('resize', onResize))
        } catch (error) {
          warn(ctx, '终端 resize 订阅失败', error)
        }
      }
      void refreshStatusField()
    }

    // ── 服务到位后注册（顺序无关；命令只在 TUI 接缝出现后注册） ───────────
    whenService(ctx, 'commands', (commands) => {
      commandsSeen = commands
      if (commandWanted) registerCommand(commands)
    })

    whenService(ctx, 'tuiScenes', (scenes) => {
      if (!scenes || typeof scenes.register !== 'function') return
      ensureCommand()
      markTuiActive()
      let dispose
      try {
        dispose = scenes.register({ id: SCENE_ID, title: 'Remote', component: sceneComponent }, ctx)
      } catch (error) {
        warn(ctx, '场景注册失败', error)
        return
      }
      bindEffect(ctx, dispose)
    })

    whenService(ctx, 'tuiDialogs', (dialogs) => {
      if (!dialogs) return
      ensureCommand()
      markTuiActive()
    })

    whenService(ctx, 'tuiWorkspaces', (workspaces) => {
      if (!workspaces || typeof workspaces.register !== 'function') return
      workspacesSeen = true
      markTuiActive()
      const instance = ensureProvider()
      let dispose
      try {
        // register 在无 live activation 时会**同步抛错**，必须包 try/catch。
        dispose = workspaces.register(instance)
      } catch (error) {
        warn(ctx, '工作区 provider 注册失败', error)
        return
      }
      bindEffect(ctx, dispose)
      // 后台预热，绝不阻塞 apply / 首个 UI 帧。
      try {
        queueMicrotask(() => { void instance.refresh() })
      } catch (error) {
        warn(ctx, 'provider 预热失败', error)
      }
    })

    whenService(ctx, 'tuiStatus', (status) => {
      if (!status || typeof status.setField !== 'function') return
      statusService = status
      markTuiActive()
      bindEffect(ctx, () => {
        if (!statusFieldDispose) return
        const dispose = statusFieldDispose
        statusFieldDispose = null
        dispose()
      })
      void refreshStatusField()
    })
  } catch (error) {
    warn(ctx, 'installTui 初始化失败', error)
  }
}

export default installTui
