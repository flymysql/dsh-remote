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

import { createI18n } from './i18n.js'
import { createWorkspaceProvider } from './provider.js'
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

    const ensureProvider = () => {
      if (!provider) provider = createWorkspaceProvider({ api, config: config || {}, logger: getService(ctx, 'logger') })
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

    /** 状态行字段：只在服务形状符合契约时写入，否则整段跳过（不猜 API）。 */
    const applyStatusField = (text) => {
      if (!statusService || typeof statusService.setField !== 'function') return
      try {
        // 第 4 个参数是插件自己的 ctx（只用于 effect ledger 归属，可省略）。
        const next = statusService.setField(STATUS_KEY, text, STATUS_OPTIONS, ctx)
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

    /** 读当前机器名并写状态行；旧结果（token 过期）直接丢弃。 */
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
        return
      }
      if (token !== statusRefreshToken) return
      const current = machines.find((machine) => machine && machine.id === currentId)
      const label = current ? String(current.name || current.host || '').trim() : ''
      applyStatusField(label || undefined)
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
