// dsh-remote TUI — 工作区 provider（scheme: dshremote）。
//
// 契约见 dsh-tui `dsh-adapter/workspaces.d.ts` 的 TuiWorkspaceProvider：
//   · `list(signal)` 只读**内存缓存**（宿主强制 2s 预算，绝不在这里连网）
//   · `resolve(uri)` / `resolvePath(path, cwd)` 走宿主 api 的 ensureRemoteWorkspace
//   · `describe(cwd)` 同步、只读本地镜像 meta（lib/binding.js#resolveMirror），
//     不创建任何目录
//
// cwd 必须是本地真实存在的镜像目录：会话远程身份由 session header.cwd 落在哪个
// 镜像目录决定。provider 的 `uri` 表达远程身份，`cwd` 永远指向镜像。

import path from 'node:path'
import { resolveMirror } from '../binding.js'
import { buildUri, joinRemote, parseUri, targetFromWorkspace } from './format.js'

/** 每台机器默认列出的最近工作区条数（与 docs/tui.md §5 一致）。 */
const DEFAULT_RECENT_LIMIT = 5
/** tuiProviderRecentLimit 的合法上限。 */
const MAX_RECENT_LIMIT = 20

/** 把 1..20 的限制值夹紧；非法值回落默认 5。 */
function recentLimit(config) {
  if (!config || config.tuiProviderListRecent === false) return 0
  const raw = Number(config.tuiProviderRecentLimit)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RECENT_LIMIT
  return Math.min(MAX_RECENT_LIMIT, Math.max(1, Math.floor(raw)))
}

/** 本地镜像目录的 registry 根（`$DSH_HOME/remote-workspaces`）。
 *
 * 布局由 lib/index.js 的 mirrorRootFor/mirrorDirFor 固定为
 * `<root>/<host>-<user>-<port>/<basename>`，所以从任一镜像目录上溯两级即可得到
 * 根；`describe` 是同步方法，不能为了 root 去 await 网络。 */
function rootFromMirrorDir(localMirror) {
  if (!localMirror) return ''
  return path.dirname(path.dirname(path.resolve(String(localMirror))))
}

/** 从 cwd 路径本身认 root（layout 固定，字符串判断是纯同步的兜底）。 */
function rootFromCwd(cwd) {
  const resolved = path.resolve(String(cwd || ''))
  const marker = `${path.sep}remote-workspaces${path.sep}`
  const index = resolved.indexOf(marker)
  if (index < 0) return ''
  return resolved.slice(0, index + marker.length - 1)
}

/**
 * 创建远程工作区 provider。
 *
 * @param {object} deps
 * @param {object} deps.api - 宿主进程内 API（docs/tui.md §3，apiVersion 1）。
 * @param {object} [deps.config] - 行 config（tuiProviderListRecent / tuiProviderRecentLimit）。
 * @param {object} [deps.logger] - cordis logger（只用于 warn，失败一律降级）。
 * @param {string} [deps.root] - 镜像 registry 根；省略时从 listRemoteProjects 结果推导。
 * @returns {object} TuiWorkspaceProvider（附加 `refresh()`，供 installTui 预热/订阅刷新）。
 */
export function createWorkspaceProvider({ api, config, logger, root } = {}) {
  const state = {
    targets: [],
    machines: [],
    currentId: null,
    projects: [],
    root: typeof root === 'string' && root ? String(root) : '',
    ready: false,
  }
  let inflight = null

  /** 只记日志、绝不抛错：provider 的失败不能让宿主选择器崩。 */
  const warn = (message, error) => {
    try {
      if (!logger || typeof logger.warn !== 'function') return
      const detail = error && (error.message || error)
      logger.warn(`[dsh-remote] tui workspace provider: ${message}${detail ? ': ' + detail : ''}`)
    } catch { /* logging is best-effort */ }
  }

  /** 当前镜像根：显式 deps.root > 项目缓存 > cwd 字符串兜底。 */
  const mirrorRoot = (cwd) => {
    if (state.root) return state.root
    const project = state.projects.find((entry) => entry && typeof entry.dir === 'string' && entry.dir)
    if (project) {
      state.root = rootFromMirrorDir(project.dir)
      if (state.root) return state.root
    }
    if (cwd) {
      const derived = rootFromCwd(cwd)
      if (derived) return derived
    }
    return ''
  }

  /** 按 id / 名称 / host（含 ssh-config 别名）软匹配机器。 */
  const findMachine = (token) => {
    const needle = String(token === undefined || token === null ? '' : token).trim().toLowerCase()
    if (!needle) return undefined
    return state.machines.find((m) => String(m.id || '') === String(token))
      || state.machines.find((m) => String(m.name || '').toLowerCase() === needle)
      || state.machines.find((m) => String(m.host || '').toLowerCase() === needle)
  }

  /** RemoteProject（listRemoteProjects 的行）→ 保存的机器。 */
  const machineForProject = (project) => {
    if (!project) return undefined
    if (project.machineId) {
      const direct = state.machines.find((m) => String(m.id || '') === String(project.machineId))
      if (direct) return direct
    }
    const alias = String(project.alias || '')
    if (alias) {
      const byAlias = state.machines.find((m) => m.useSshConfig && String(m.host || '') === alias)
      if (byAlias) return byAlias
    }
    const host = String(project.host || '')
    const port = Number(project.port) || 22
    const user = String(project.username || '')
    return state.machines.find((m) => {
      if (m.useSshConfig) return false
      if (String(m.host || '') !== host) return false
      if ((Number(m.port) || 22) !== port) return false
      return !user || String(m.username || '') === user
    })
  }

  /** resolveMirror 的 machine 段（meta）→ 保存的机器。 */
  const machineForMirror = (mirrorMachine) => {
    if (!mirrorMachine) return undefined
    const alias = String(mirrorMachine.alias || '')
    if (alias) {
      const byAlias = state.machines.find((m) => m.useSshConfig && String(m.host || '') === alias)
      if (byAlias) return byAlias
    }
    const host = String(mirrorMachine.host || '')
    const port = Number(mirrorMachine.port) || 22
    const user = String(mirrorMachine.username || '')
    return state.machines.find((m) => {
      if (m.useSshConfig) return false
      if (String(m.host || '') !== host) return false
      if ((Number(m.port) || 22) !== port) return false
      return !user || String(m.username || '') === user
    })
  }

  /** 把一个 target 放进缓存（uri 去重，先到先得）。 */
  const remember = (map, target) => {
    if (!target || !target.uri || !target.cwd) return
    if (map.has(target.uri)) return
    map.set(target.uri, target)
  }

  /** 把 resolve 出来的新 target 并进缓存，供后续 list() 使用。 */
  const rememberInState = (target) => {
    if (!target || !target.uri || !target.cwd) return
    if (state.targets.some((entry) => entry.uri === target.uri)) return
    state.targets = [...state.targets, target]
  }

  /** 调宿主 ensureRemoteWorkspace 并转成 target；失败返回 undefined（不抛）。
   *
   *  `register` 控制是否写工作区台账：刷新（picker 的 list）必须为 false ——
   *  仅仅打开选择器就把每台机器的最近工作区登记进用户的全局台账，是没有点过
   *  「打开」的用户能看到的副作用；真正选中（resolve/resolvePath）才登记。 */
  const ensureTarget = async (machine, remotePath, register = true) => {
    if (!machine || !remotePath) return undefined
    try {
      const workspace = await api.ensureRemoteWorkspace({
        machineId: machine.id,
        remotePath,
        register,
      })
      if (!workspace || !workspace.localMirror) return undefined
      return targetFromWorkspace({
        machine,
        localMirror: workspace.localMirror,
        remotePath: workspace.remotePath || remotePath,
        title: workspace.title,
      })
    } catch (error) {
      warn(`ensureRemoteWorkspace failed for ${machine.id || machine.host}:${remotePath}`, error)
      return undefined
    }
  }

  /** 后台刷新缓存：机器列表 + 已存在镜像 +（可选）每机最近 N 个工作区。 */
  const refresh = () => {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const [machineResult, projectResult] = await Promise.all([
          Promise.resolve().then(() => api.listMachines()),
          Promise.resolve().then(() => api.listRemoteProjects()),
        ])
        const machines = Array.isArray(machineResult && machineResult.machines)
          ? machineResult.machines.filter((m) => m && m.id)
          : []
        const projects = Array.isArray(projectResult) ? projectResult.filter((p) => p && p.dir) : []
        const currentId = machineResult && machineResult.currentId !== undefined ? machineResult.currentId : null

        // 先把本轮的数据装进 state，使下面的机器匹配看到最新列表。
        state.machines = machines
        state.currentId = currentId
        state.projects = projects
        if (!state.root && projects.length) {
          const derived = rootFromMirrorDir(projects[0].dir)
          if (derived) state.root = derived
        }

        const targets = new Map()
        // 1) 已存在的镜像（listRemoteProjects 只读本地文件系统，不连网）。
        for (const project of projects) {
          const machine = machineForProject(project)
          if (!machine) continue
          remember(targets, targetFromWorkspace({
            machine,
            localMirror: project.dir,
            remotePath: project.remotePath,
          }))
        }
        // 2) 当前机的已记录工作区（只备镜像，不登记台账——见 ensureTarget）。
        const current = machines.find((m) => String(m.id) === String(currentId))
        if (current && current.workspace) {
          const target = await ensureTarget(current, current.workspace, false)
          remember(targets, target)
        }
        // 3) 每台机器最近的 N 个工作区（可在 config 里关掉；同样不登记台账）。
        const limit = recentLimit(config)
        if (limit > 0) {
          for (const machine of machines) {
            const recent = Array.isArray(machine.recentWorkspaces) ? machine.recentWorkspaces : []
            for (const remotePath of recent.slice(0, limit)) {
              if (!remotePath) continue
              if (targets.has(buildUri(machine.id, String(remotePath)))) continue
              const target = await ensureTarget(machine, String(remotePath), false)
              remember(targets, target)
            }
          }
        }

        state.targets = [...targets.values()]
        state.ready = true
      } catch (error) {
        warn('refresh failed', error)
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /** 缓存副本；缓存为空时也返回 `[]`（绝不 throw，也不在 list 里等网络）。 */
  const list = (signal) => {
    if (signal && signal.aborted) return []
    if (!state.ready && !inflight) void refresh()
    return state.targets.map((target) => ({ ...target }))
  }

  /** URI → target；scheme 不对 / 机器不存在 / ensure 失败都返回 undefined。 */
  const resolve = async (uri, signal) => {
    if (signal && signal.aborted) return undefined
    const parsed = parseUri(uri)
    if (!parsed) return undefined
    let machine = findMachine(parsed.machineId)
    if (!machine) {
      await refresh()
      machine = findMachine(parsed.machineId)
    }
    if (!machine) return undefined
    const target = await ensureTarget(machine, parsed.remotePath)
    if (target) rememberInState(target)
    return target
  }

  /** 只读同步的镜像解析：cwd 属于某个镜像 → target；否则 undefined。 */
  const describe = (cwd) => {
    if (!cwd) return undefined
    const root = mirrorRoot(String(cwd))
    if (!root) return undefined
    let mirror
    try {
      mirror = resolveMirror(String(cwd), root)
    } catch (error) {
      warn('describe failed', error)
      return undefined
    }
    if (!mirror || !mirror.mirrorDir || !mirror.machine || !mirror.machine.host) return undefined
    const machine = machineForMirror(mirror.machine) || {
      // 机器已被删除，但镜像还在：仍按 meta 提供只读身份（展示用），
      // resolvePath 会因为没有保存的机器而拒绝。
      id: mirror.machine.alias || mirror.machine.host,
      name: '',
      host: mirror.machine.host,
      port: mirror.machine.port,
      username: mirror.machine.username,
    }
    return targetFromWorkspace({
      machine,
      localMirror: mirror.mirrorDir,
      remotePath: mirror.remotePath,
    })
  }

  /** cwd 已属于本 provider 的镜像时，把 path 解析成该镜像的远程路径。 */
  const resolvePath = async (targetPath, cwd, signal) => {
    if (signal && signal.aborted) return undefined
    const described = describe(cwd)
    if (!described) return undefined
    const root = mirrorRoot(String(cwd))
    const mirror = resolveMirror(String(cwd), root)
    if (!mirror || !mirror.machine) return undefined
    const machine = machineForMirror(mirror.machine)
    if (!machine) return undefined
    const remotePath = joinRemote(mirror.remotePath, targetPath)
    const target = await ensureTarget(machine, remotePath)
    if (target) rememberInState(target)
    return target
  }

  return {
    schemes: ['dshremote'],
    list,
    resolve,
    resolvePath,
    describe,
    /** 后台预热 / 订阅刷新入口（不是 TuiWorkspaceProvider 的方法，宿主忽略）。 */
    refresh,
  }
}
