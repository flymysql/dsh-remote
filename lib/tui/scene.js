// dsh-remote TUI — `/dsh-remote` 全屏「远程服务器」管理页。
//
// 硬约束（dsh-tui 场景契约，见 dsh-adapter/scenes.d.ts）：
//   · hooks 只能用 props 注入的 React；元素只能 React.createElement（仓库没有
//     JSX 编译器，也没有构建步骤）
//   · 渲染期禁止同步 I/O / 网络：机器列表、状态、目录全部在 useEffect 或按键
//     回调里异步取；组件卸载后（alive ref = false）丢弃结果
//   · 密码 / passphrase 永不回显：编辑时输入框恒为空，留空 = 不修改
//
// 视图状态机：list → menu / form / browse / confirm。
// Esc / q：子视图先回列表，列表根视图关闭场景。

import {
  AUTH_MODES,
  basenameRemote,
  emptyMachineForm,
  formatBytes,
  formFromMachine,
  statusLine,
  targetFromWorkspace,
  validateMachineForm,
} from './format.js'

/** 动作菜单项（顺序即渲染顺序）。 */
const MENU_ACTIONS = ['connect', 'workspaces', 'edit', 'delete', 'probe', 'browse']
/** 表单里永远出现的字段。 */
const BASE_FORM_FIELDS = ['name', 'host', 'useSshConfig', 'port', 'username', 'auth']

/** 取错误对象里面向用户的一句话。 */
function messageOf(error) {
  if (!error) return ''
  return String((error && error.message) || error)
}

/** 按**码点**截断（不是 UTF-16 码元），避免切出孤立代理对（emoji、CJK 扩展 B）。 */
function clip(text, max) {
  const value = String(text === undefined || text === null ? '' : text)
  const limit = Math.max(0, Number(max) || 0)
  if (!limit) return value
  const points = Array.from(value)
  if (points.length <= limit) return value
  return points.slice(0, Math.max(0, limit - 1)).join('') + '…'
}

/** 掩码显示：只体现“有值”，永远不回显内容本身。 */
function maskValue(value) {
  const length = String(value === undefined || value === null ? '' : value).length
  return length ? '•'.repeat(Math.min(length, 20)) : ''
}

/** 机器显示名：name → host → id。 */
function machineName(machine) {
  if (!machine) return ''
  const name = String(machine.name || '').trim()
  return name || String(machine.host || machine.id || '')
}

/** `user@host:port` 单行身份。 */
function machineAddress(machine) {
  if (!machine) return ''
  const host = String(machine.host || '')
  const user = String(machine.username || '')
  const port = Number(machine.port) || 22
  return `${user ? user + '@' : ''}${host}:${port}`
}

/** 认证方式循环切换。 */
function nextAuth(current, step) {
  const index = Math.max(0, AUTH_MODES.indexOf(current))
  const next = (index + (step || 1) + AUTH_MODES.length) % AUTH_MODES.length
  return AUTH_MODES[next]
}

/** 表单可见字段（认证方式决定密码 / 私钥组是否出现）。 */
function fieldsFor(form) {
  const fields = [...BASE_FORM_FIELDS]
  if (!form || form.auth === 'password') fields.push('password')
  else if (form.auth === 'key') fields.push('privateKeyPath', 'passphrase')
  fields.push('group')
  return fields
}

/** 以 selected 为中心切出可视窗口（只用状态派生，不存滚动偏移）。 */
function windowSlice(items, selected, height) {
  const list = Array.isArray(items) ? items : []
  const size = Math.max(1, Number(height) || 1)
  if (list.length <= size) return { offset: 0, items: list }
  let offset = Math.max(0, Math.min(Number(selected) || 0, list.length - 1) - Math.floor(size / 2))
  offset = Math.min(offset, list.length - size)
  return { offset, items: list.slice(offset, offset + size) }
}

/**
 * 创建全屏场景组件。
 *
 * @param {object} deps
 * @param {object} deps.api - 宿主进程内 API（apiVersion 1）。
 * @param {object} [deps.config] - 行 config（tuiAutoSwitchWorkspace 等）。
 * @param {object} [deps.i18n] - createI18n 的返回值。
 * @param {(text: string, options?: object) => void} [deps.notify] - 无 channel 时的提示通道。
 * @returns {Function} React 组件（props: { React, ui, channel, close }）。
 */
export function createSceneComponent({ api, config, i18n, notify } = {}) {
  const t = i18n && typeof i18n.t === 'function' ? i18n.t : (key) => String(key)
  const autoSwitch = !config || config.tuiAutoSwitchWorkspace !== false

  /** Host kit is mandatory; the guard lives OUTSIDE the hooking component so the
   *  hook count never depends on props (React requires a constant hook order). */
  return function DshRemoteScene(props) {
    const React = props && props.React
    if (!React || !props.ui) return null
    return React.createElement(DshRemoteSceneBody, props)
  }

  /** The real scene: every hook runs here, unconditionally. */
  function DshRemoteSceneBody(props) {
    const React = props.React
    const ui = props.ui
    const channel = props && props.channel
    const close = props && props.close

    const { useCallback, useEffect, useRef, useState } = React
    const { Box, Text, useInput, useTerminalSize } = ui
    const h = React.createElement

    // ── 状态 ──────────────────────────────────────────────────────────────
    const [machines, setMachines] = useState([])
    const [currentId, setCurrentId] = useState(null)
    const [status, setStatus] = useState(null)
    const [selected, setSelected] = useState(0)
    const [view, setView] = useState('list')
    const [menuIndex, setMenuIndex] = useState(0)
    const [form, setForm] = useState(null)
    const [formField, setFormField] = useState(0)
    const [formErrors, setFormErrors] = useState([])
    const [browse, setBrowse] = useState(null)
    const [confirmMachine, setConfirmMachine] = useState(null)
    const [workspaces, setWorkspaces] = useState(null)
    const [wsIndex, setWsIndex] = useState(0)
    const [wsMachine, setWsMachine] = useState(null)
    const [wsConfirm, setWsConfirm] = useState(null)
    const [busy, setBusy] = useState('')
    const [error, setError] = useState('')
    const alive = useRef(true)
    const terminal = useTerminalSize()
    const columns = Math.max(24, Number(terminal && terminal.columns) || 80)
    const rows = Math.max(10, Number(terminal && terminal.rows) || 24)
    /** 列表 / 表单 / 浏览共用的内容高度（头部 2 行 + 页脚 2 行）。 */
    const bodyHeight = Math.max(4, rows - 6)

    // ── 生命周期：挂载标记 + 首次加载 + 宿主变更订阅 ─────────────────────
    useEffect(() => {
      alive.current = true
      return () => { alive.current = false }
    }, [])

    useEffect(() => {
      void reload()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api])

    useEffect(() => {
      if (!api || typeof api.subscribe !== 'function') return undefined
      let off
      try {
        off = api.subscribe(() => { void reload() })
      } catch {
        off = undefined
      }
      return () => {
        if (typeof off !== 'function') return
        try { off() } catch { /* teardown is best-effort */ }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api])

    // ── 数据加载 ──────────────────────────────────────────────────────────
    async function reload() {
      if (!api || typeof api.listMachines !== 'function') {
        if (alive.current) setError(t('error.noApi'))
        return
      }
      try {
        const result = await api.listMachines()
        if (!alive.current) return
        const list = Array.isArray(result && result.machines) ? result.machines : []
        setMachines(list)
        setCurrentId(result && result.currentId !== undefined ? result.currentId : null)
        setSelected((previous) => Math.min(previous, Math.max(0, list.length - 1)))
        let nextStatus
        try {
          nextStatus = await api.status()
        } catch {
          nextStatus = undefined
        }
        if (alive.current && nextStatus) setStatus(nextStatus)
      } catch (failure) {
        if (alive.current) setError(messageOf(failure))
      }
    }

    /** Monotonic token: only the newest directory listing may paint. */
    const dirToken = useRef(0)
    /** Same guard for the workspace-cleanup list. */
    const wsToken = useRef(0)
    async function loadDir(machine, dirPath) {
      if (!api || typeof api.listDir !== 'function' || !machine) return
      const token = ++dirToken.current
      setBusy(t('busy.listing'))
      setError('')
      try {
        const listing = await api.listDir({ machineId: machine.id, path: dirPath })
        if (!alive.current || token !== dirToken.current) return
        setBrowse({
          machine,
          path: String((listing && listing.path) || dirPath || ''),
          parent: listing && listing.parent !== undefined ? listing.parent : null,
          items: Array.isArray(listing && listing.items) ? listing.items : [],
          selected: 0,
        })
      } catch (failure) {
        if (alive.current && token === dirToken.current) setError(messageOf(failure))
      } finally {
        if (alive.current && token === dirToken.current) setBusy('')
      }
    }

    /** 统一异步动作包装：设置加载态、把失败写到页脚、卸载后丢弃。 */
    const runOp = useCallback(async (what, action) => {
      setBusy(what)
      setError('')
      try {
        return await action()
      } catch (failure) {
        if (alive.current) setError(messageOf(failure))
        return undefined
      } finally {
        if (alive.current) setBusy('')
      }
    }, [])

    /** 提示：优先用活会话 channel.notify，其次注入的 notify（宿主 toast）。 */
    const toast = useCallback((text, options) => {
      const message = String(text)
      try {
        if (channel && typeof channel.notify === 'function') {
          channel.notify(message, options)
          return
        }
      } catch { /* fall through to the injected channel */ }
      try {
        if (typeof notify === 'function') notify(message, options)
      } catch { /* notifications are best-effort */ }
    }, [channel, notify])

    /** 切换工作区（宿主拒绝 / 异常只提示，不改场景状态）。 */
    async function switchWorkspace(target) {
      if (!autoSwitch || !target) return
      try {
        if (!channel || typeof channel.switchWorkspace !== 'function') return
        const switched = await channel.switchWorkspace(target)
        if (switched === false) toast(t('notify.switchRefused', { label: target.label }), { color: 'warning' })
      } catch (failure) {
        toast(t('notify.switchFailed', { err: messageOf(failure) }), { color: 'warning' })
      }
    }

    /** 把 ensure/pick 的结果转成 target，并提示 + 可选切换。 */
    async function adoptWorkspace(machine, workspace, remotePath) {
      const target = targetFromWorkspace({
        machine,
        localMirror: workspace && workspace.localMirror,
        remotePath: (workspace && workspace.remotePath) || remotePath,
        title: workspace && workspace.title,
      })
      if (!target) {
        setError(t('error.badWorkspace'))
        return
      }
      toast(t('notify.workspaceSet', { label: target.label }), { color: 'success' })
      await switchWorkspace(target)
    }

    // ── 动作 ──────────────────────────────────────────────────────────────
    async function connectMachine(machine) {
      if (!machine) return
      const result = await runOp(t('busy.connecting'), () => api.connect({ machineId: machine.id, persist: true }))
      if (!result) return
      if (result.connected === false) {
        setError(t('notify.probeFailed', { err: result.activeSource || t('error.generic') }))
        return
      }
      toast(t('notify.connected', { target: machineAddress(machine) }), { color: 'success' })
      await reload()
    }

    /** 在系统文件管理器里打开本机 dsh-remote 的镜像根目录（remote-workspaces）。 */
    async function revealMirrorFolder() {
      if (typeof api.revealMirrorFolder !== 'function') return
      const result = await runOp(t('busy.revealFolder'), () => api.revealMirrorFolder())
      if (!result) return
      toast(t('notify.revealed', { path: result.path }), { color: 'success' })
    }

    async function probeMachine(machine) {
      if (!machine || typeof api.probeMachine !== 'function') return
      const patch = {
        id: machine.id,
        host: machine.host,
        port: Number(machine.port) || 22,
        username: machine.username,
        useSshConfig: machine.useSshConfig === true,
        privateKeyPath: machine.privateKeyPath || '',
        useAgent: machine.useAgent === true,
        backend: machine.backend || 'native',
        sshBinary: machine.sshBinary || '',
        keyboardInteractive: machine.keyboardInteractive === true,
      }
      const probe = await runOp(t('busy.probing'), () => api.probeMachine(patch))
      if (!probe) return
      if (probe.ok === false) {
        const message = probe.error || t('error.generic')
        setError(messageOf(message))
        toast(t('notify.probeFailed', { err: messageOf(message) }), { color: 'error' })
        return
      }
      const target = `${probe.user || machine.username || ''}@${probe.host || machine.host || ''}`
      const latency = typeof probe.latencyMs === 'number' ? Math.round(probe.latencyMs) : '-'
      toast(t('notify.probeOk', { target, latency }), { color: 'success' })
    }

    async function deleteMachine(machine) {
      if (!machine || typeof api.removeMachine !== 'function') return
      const result = await runOp(t('busy.deleting'), () => api.removeMachine(machine.id))
      if (!result || !alive.current) return
      toast(t('notify.deleted', { name: machineName(machine) }), { color: 'success' })
      setView('list')
      await reload()
    }

    async function pickBrowseWorkspace() {
      const current = browse
      if (!current) return
      if (!current.path) {
        toast(t('browse.noSelection'), { color: 'warning' })
        return
      }
      setBusy(t('busy.settingWorkspace'))
      setError('')
      try {
        const workspace = await api.pickRemoteWorkspace({
          machineId: current.machine.id,
          remotePath: current.path,
          registerWorkspace: true,
        })
        if (!alive.current) return
        await adoptWorkspace(current.machine, workspace, current.path)
      } catch (failure) {
        if (alive.current) {
          setError(messageOf(failure))
          toast(t('notify.pickFailed', { err: messageOf(failure) }), { color: 'warning' })
        }
      } finally {
        if (alive.current) setBusy('')
      }
    }

    async function saveForm() {
      if (!form) return
      const { errors, patch } = validateMachineForm(form, t)
      if (errors.length) {
        setFormErrors(errors)
        return
      }
      setFormErrors([])
      const result = await runOp(t('busy.saving'), () => api.upsertMachine(patch))
      if (!result || !alive.current) return
      const name = (result.machine && result.machine.name) || patch.name || patch.host
      toast(t('notify.saved', { name }), { color: 'success' })
      if (Array.isArray(result.warnings) && result.warnings.length) {
        toast(t('notify.warnings', { text: result.warnings.join('; ') }), { color: 'warning', timeoutMs: 8000 })
      }
      setView('list')
      await reload()
    }

    // ── 视图切换 ──────────────────────────────────────────────────────────
    const backToList = () => {
      setView('list')
      setFormErrors([])
      setError('')
    }

    function openMenu(machine) {
      if (!machine) return
      setMenuIndex(0)
      setView('menu')
    }

    function openForm(machine) {
      setForm(machine ? formFromMachine(machine) : emptyMachineForm())
      setFormField(0)
      setFormErrors([])
      setError('')
      setView('form')
    }

    function openBrowse(machine) {
      if (!machine) return
      setBrowse({ machine, path: '', parent: null, items: [], selected: 0 })
      setError('')
      setView('browse')
      // Start at the machine's recorded remote workspace when there is one,
      // instead of whatever the host considers its current directory.
      void loadDir(machine, machine.workspace || undefined)
    }

    // ── 工作区清理（删除镜像 / 删除对话 / 移出最近列表） ──────────────────
    function selectedWorkspace() {
      const list = workspaces || []
      if (!list.length) return undefined
      return list[Math.max(0, Math.min(wsIndex, list.length - 1))]
    }

    async function loadWorkspaces(machine) {
      if (!api || typeof api.listWorkspaceMirrors !== 'function') {
        setError(t('ws.noApi'))
        return
      }
      if (!machine) return
      const token = ++wsToken.current
      setBusy(t('busy.loadingMirrors'))
      setError('')
      try {
        const list = await api.listWorkspaceMirrors({ machineId: machine.id })
        if (!alive.current || token !== wsToken.current) return
        const items = Array.isArray(list) ? list : []
        setWorkspaces(items)
        setWsIndex((previous) => Math.min(previous, Math.max(0, items.length - 1)))
      } catch (failure) {
        if (alive.current && token === wsToken.current) setError(messageOf(failure))
      } finally {
        if (alive.current && token === wsToken.current) setBusy('')
      }
    }

    function openWorkspaces(machine) {
      if (!machine) return
      setWsMachine(machine)
      setWorkspaces(null)
      setWsIndex(0)
      setWsConfirm(null)
      setError('')
      setView('workspaces')
      void loadWorkspaces(machine)
    }

    function openWsConfirm(action) {
      const item = selectedWorkspace()
      if (!item) {
        toast(t('ws.empty'), { color: 'warning' })
        return
      }
      setWsConfirm({ action, item })
      setError('')
      setView('wsconfirm')
    }

    async function runWsConfirm() {
      const pending = wsConfirm
      if (!pending) return
      const { action, item } = pending
      const label = item.title || basenameRemote(item.remotePath)
      const what = action === 'delete' ? t('ws.busyDelete')
        : action === 'sessions' ? t('ws.busySessions') : t('ws.busyRecent')
      setBusy(what)
      setError('')
      try {
        if (action === 'delete') {
          if (typeof api.deleteRemoteWorkspace !== 'function') throw new Error(t('ws.noApi'))
          const result = await api.deleteRemoteWorkspace({ localMirror: item.localMirror, deleteSessions: true })
          if (!alive.current) return
          toast(t('ws.deleted', { name: label, sessions: String(Number(result && result.removedSessions) || 0) }), { color: 'success' })
        } else if (action === 'sessions') {
          if (typeof api.deleteWorkspaceSessions !== 'function') throw new Error(t('ws.noApi'))
          const result = await api.deleteWorkspaceSessions({ localMirror: item.localMirror })
          if (!alive.current) return
          const removed = Number(result && result.removedSessions) || 0
          const skipped = Array.isArray(result && result.skippedLiveSessions) ? result.skippedLiveSessions.length : 0
          toast(skipped
            ? t('ws.sessionsPartial', { n: String(removed), live: String(skipped) })
            : t('ws.sessionsDeleted', { n: String(removed) }), { color: skipped ? 'warning' : 'success' })
        } else {
          if (typeof api.forgetWorkspaceRecent !== 'function') throw new Error(t('ws.noApi'))
          await api.forgetWorkspaceRecent({ localMirror: item.localMirror })
          if (!alive.current) return
          toast(t('ws.recentForgotten', { name: label }), { color: 'success' })
        }
        if (!alive.current) return
        setWsConfirm(null)
        setView('workspaces')
        await loadWorkspaces(wsMachine)
      } catch (failure) {
        if (!alive.current) return
        // A refused deletion is not a dead end: return to the list (the footer
        // explains what must stop) so the person can retry after Ctrl+X.
        setWsConfirm(null)
        setView('workspaces')
        const live = failure && Array.isArray(failure.liveSessions) ? failure.liveSessions.length : 0
        setError(live ? t('ws.busyError', { n: String(live) }) : messageOf(failure))
      } finally {
        if (alive.current) setBusy('')
      }
    }

    function openConfirm(machine) {
      if (!machine) return
      setConfirmMachine(machine)
      setView('confirm')
    }

    /** 执行动作菜单 / 快捷键对应的动作。 */
    function executeAction(action, machine) {
      if (!machine) return
      switch (action) {
        case 'connect': void connectMachine(machine); break
        case 'workspaces': openWorkspaces(machine); break
        case 'edit': openForm(machine); break
        case 'delete': openConfirm(machine); break
        case 'probe': void probeMachine(machine); break
        case 'browse': openBrowse(machine); break
        default: break
      }
    }

    // ── 键盘 ──────────────────────────────────────────────────────────────
    const selectedMachine = machines.length
      ? machines[Math.max(0, Math.min(selected, machines.length - 1))]
      : undefined

    function handleListKey(input, key) {
      // Escape FIRST: a lone Esc carries `meta: true` in this TUI, so any
      // modifier guard before it swallows every Esc press.
      if (key.escape || input === 'q') {
        if (typeof close === 'function') close()
        return
      }
      if (key.ctrl || key.meta) return
      if (key.leftArrow) {
        if (typeof close === 'function') close()
        return
      }
      if (key.rightArrow) {
        openMenu(selectedMachine)
        return
      }
      if (key.upArrow || input === 'k') {
        setSelected((previous) => Math.max(0, previous - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        setSelected((previous) => Math.min(Math.max(0, machines.length - 1), previous + 1))
        return
      }
      if (key.return) {
        openMenu(selectedMachine)
        return
      }
      switch (input) {
        case 'a': openForm(undefined); break
        case 'c': void connectMachine(selectedMachine); break
        case 'e': openForm(selectedMachine); break
        case 'd': openConfirm(selectedMachine); break
        case 't': void probeMachine(selectedMachine); break
        case 'b': openBrowse(selectedMachine); break
        case 'o': void revealMirrorFolder(); break
        default: break
      }
    }

    function handleMenuKey(input, key) {
      if (key.escape || input === 'q' || key.leftArrow) {
        backToList()
        return
      }
      if (key.ctrl || key.meta) return
      if (key.upArrow || input === 'k') {
        setMenuIndex((previous) => Math.max(0, previous - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        setMenuIndex((previous) => Math.min(MENU_ACTIONS.length - 1, previous + 1))
        return
      }
      if (key.return || key.rightArrow) {
        const action = MENU_ACTIONS[Math.max(0, Math.min(menuIndex, MENU_ACTIONS.length - 1))]
        executeAction(action, selectedMachine)
        return
      }
      if (input === 'c') executeAction('connect', selectedMachine)
      else if (input === 'e') executeAction('edit', selectedMachine)
      else if (input === 'd') executeAction('delete', selectedMachine)
      else if (input === 't') executeAction('probe', selectedMachine)
      else if (input === 'b') executeAction('browse', selectedMachine)
      else if (input === 'm') executeAction('workspaces', selectedMachine)
    }

    function handleConfirmKey(input, key) {
      if (key.escape || input === 'n' || input === 'q' || key.leftArrow) {
        backToList()
        return
      }
      if (key.ctrl || key.meta) return
      if (key.return || key.rightArrow || input === 'y') {
        const target = confirmMachine
        setConfirmMachine(null)
        void deleteMachine(target)
      }
    }

    function handleFormKey(input, key) {
      if (!form) {
        backToList()
        return
      }
      const fields = fieldsFor(form)
      const bounded = Math.max(0, Math.min(formField, fields.length - 1))
      if (key.escape) {
        backToList()
        return
      }
      if (key.ctrl || key.meta) return
      if (key.tab) {
        const next = key.shift ? bounded - 1 : bounded + 1
        setFormField(Math.max(0, Math.min(fields.length - 1, next)))
        return
      }
      if (key.upArrow) {
        setFormField(Math.max(0, bounded - 1))
        return
      }
      if (key.downArrow) {
        setFormField(Math.min(fields.length - 1, bounded + 1))
        return
      }
      if (key.return) {
        void saveForm()
        return
      }
      const field = fields[bounded]
      if (!field) return
      if (field === 'useSshConfig') {
        if (input === ' ' || key.leftArrow || key.rightArrow) {
          setForm((previous) => ({ ...previous, useSshConfig: !(previous && previous.useSshConfig) }))
        }
        return
      }
      if (field === 'auth') {
        if (input === ' ' || key.leftArrow || key.rightArrow) {
          const auth = nextAuth(form.auth, key.leftArrow ? -1 : 1)
          setForm({ ...form, auth })
          setFormField((index) => Math.min(index, fieldsFor({ auth }).length - 1))
        }
        return
      }
      if (key.backspace || key.delete) {
        setForm((previous) => {
          const value = String((previous && previous[field]) || '')
          return { ...previous, [field]: value.slice(0, -1) }
        })
        return
      }
      if (!input || /[\u0000-\u001f\u007f]/.test(input)) return
      const chunk = input.replace(/[\r\n]+/g, '')
      if (!chunk) return
      setForm((previous) => {
        const value = String((previous && previous[field]) || '') + chunk
        const next = field === 'port' ? value.replace(/[^\d]/g, '').slice(0, 5) : value
        return { ...previous, [field]: next }
      })
    }

    function handleBrowseKey(input, key) {
      if (key.escape || input === 'q') {
        backToList()
        return
      }
      if (key.ctrl || key.meta) return
      const current = browse
      const dirs = current ? current.items.filter((item) => item && item.type === 'dir') : []
      const bounded = current ? Math.max(0, Math.min(current.selected, dirs.length - 1)) : 0
      if (key.upArrow || input === 'k') {
        setBrowse((previous) => previous
          ? { ...previous, selected: Math.max(0, Math.min(previous.selected, dirs.length - 1) - 1) }
          : previous)
        return
      }
      if (key.downArrow || input === 'j') {
        setBrowse((previous) => previous
          ? { ...previous, selected: Math.min(Math.max(0, dirs.length - 1), previous.selected + 1) }
          : previous)
        return
      }
      if (key.return || key.rightArrow) {
        const dir = dirs[bounded]
        if (dir && current) void loadDir(current.machine, dir.path)
        else toast(t('browse.noSelection'), { color: 'warning' })
        return
      }
      if (key.leftArrow || key.backspace || key.delete) {
        // ← = one DIRECTORY level up (same as Backspace); at the root it leaves
        // the browse view instead of doing nothing.
        if (current && current.parent) void loadDir(current.machine, current.parent)
        else backToList()
        return
      }
      if (input === 'w') void pickBrowseWorkspace()
    }

    function handleWorkspacesKey(input, key) {
      if (key.escape || input === 'q' || key.leftArrow) {
        backToList()
        return
      }
      if (key.ctrl || key.meta) return
      const list = workspaces || []
      if (key.upArrow || input === 'k') {
        setWsIndex((previous) => Math.max(0, previous - 1))
        return
      }
      if (key.downArrow || input === 'j') {
        setWsIndex((previous) => Math.min(Math.max(0, list.length - 1), previous + 1))
        return
      }
      if (input === 'd') { openWsConfirm('delete'); return }
      if (input === 'x') { openWsConfirm('sessions'); return }
      if (input === 'r') { openWsConfirm('recent'); return }
    }

    function handleWsConfirmKey(input, key) {
      if (key.escape || input === 'n' || input === 'q' || key.leftArrow) {
        setWsConfirm(null)
        setView('workspaces')
        return
      }
      if (key.ctrl || key.meta) return
      if (key.return || key.rightArrow || input === 'y') void runWsConfirm()
    }

    useInput((input, key) => {
      const pressed = key || {}
      if (view === 'list') handleListKey(input, pressed)
      else if (view === 'menu') handleMenuKey(input, pressed)
      else if (view === 'form') handleFormKey(input, pressed)
      else if (view === 'browse') handleBrowseKey(input, pressed)
      else if (view === 'workspaces') handleWorkspacesKey(input, pressed)
      else if (view === 'wsconfirm') handleWsConfirmKey(input, pressed)
      else if (view === 'confirm') handleConfirmKey(input, pressed)
    })

    // ── 渲染 ──────────────────────────────────────────────────────────────
    function renderHeader() {
      const connected = status && status.connected === true
      return h(Box, { key: 'header', flexDirection: 'row', width: '100%', paddingX: 1 },
        h(Text, { bold: true, color: 'accent' }, t('title')),
        h(Box, { flexGrow: 1 }),
        h(Text, { color: connected ? 'success' : 'subtle' }, status ? statusLine(status, t) : t('status.loading')),
      )
    }

    function renderList() {
      const children = []
      if (!machines.length) {
        children.push(h(Text, { key: 'empty', color: 'subtle' }, t('list.empty')))
      } else {
        const slicing = windowSlice(machines, selected, bodyHeight - 1)
        slicing.items.forEach((machine, index) => {
          const absolute = slicing.offset + index
          const focused = absolute === selected
          const current = machine.id === currentId
          children.push(h(Box, { key: machine.id || `machine-${absolute}`, flexDirection: 'row', width: '100%' },
            h(Text, { color: focused ? 'accent' : undefined, inverse: focused }, focused ? '› ' : '  '),
            h(Text, { color: current ? 'success' : 'subtle' }, current ? '● ' : '○ '),
            h(Text, { bold: focused || current }, clip(machineName(machine), Math.max(8, Math.floor(columns * 0.32)))),
            h(Text, { dimColor: true }, clip(`  ${machineAddress(machine)}`, Math.max(10, Math.floor(columns * 0.3)))),
            machine.group ? h(Text, { color: 'subtle' }, clip(`  [${machine.group}]`, 16)) : null,
            machine.useSshConfig ? h(Text, { color: 'subtle' }, '  ssh-config') : null,
            h(Box, { flexGrow: 1 }),
            h(Text, { color: 'subtle' }, machine.workspace ? clip(basenameRemote(machine.workspace), 18) : ''),
          ))
        })
      }
      return h(Box, { key: 'body', flexDirection: 'column', width: '100%', paddingX: 1 }, ...children)
    }

    function renderMenu() {
      const machine = selectedMachine
      if (!machine) return h(Box, { key: 'body', flexDirection: 'column', width: '100%', paddingX: 1 },
        h(Text, { color: 'subtle' }, t('list.empty')))
      const children = [
        h(Text, { key: 'title', bold: true, color: 'accent' }, t('menu.title', { name: machineName(machine) })),
        h(Text, { key: 'addr', color: 'subtle' }, `${machineAddress(machine)}${machine.workspace ? '  ·  ' + clip(machine.workspace, 48) : ''}`),
      ]
      MENU_ACTIONS.forEach((action, index) => {
        const focused = index === menuIndex
        children.push(h(Text, { key: action, color: focused ? 'accent' : undefined, inverse: focused },
          `${focused ? '› ' : '  '}${index + 1}. ${t('menu.' + action)}`))
      })
      return h(Box, { key: 'body', flexDirection: 'column', width: '100%', paddingX: 1 }, ...children)
    }

    function formValueText(field) {
      if (!form) return ''
      if (field === 'useSshConfig') return form.useSshConfig ? '[x]' : '[ ]'
      if (field === 'auth') return `◂ ${t('auth.' + form.auth)} ▸`
      if (field === 'password') {
        const masked = maskValue(form.password)
        if (masked) return masked
        return form.id ? t('form.passwordUnchanged') : t('form.passwordPlaceholder')
      }
      if (field === 'passphrase') {
        const masked = maskValue(form.passphrase)
        if (masked) return masked
        return form.id ? t('form.passwordUnchanged') : t('form.passphrasePlaceholder')
      }
      if (field === 'privateKeyPath') return String(form.privateKeyPath || '') || t('form.optional')
      return String(form[field] === undefined || form[field] === null ? '' : form[field])
    }

    function renderForm() {
      if (!form) return h(Box, { key: 'body', flexDirection: 'column', width: '100%', paddingX: 1 })
      const fields = fieldsFor(form)
      const bounded = Math.max(0, Math.min(formField, fields.length - 1))
      const children = [
        h(Text, { key: 'title', bold: true, color: 'accent' },
          form.id ? t('form.titleEdit', { name: machineName(form) || form.host }) : t('form.titleNew')),
      ]
      const slicing = windowSlice(fields, bounded, bodyHeight - 2)
      slicing.items.forEach((field, index) => {
        const absolute = slicing.offset + index
        const focused = absolute === bounded
        const label = t('form.' + field)
        const value = formValueText(field)
        children.push(h(Box, { key: field, flexDirection: 'row', width: '100%' },
          h(Text, { color: focused ? 'accent' : 'subtle', bold: focused }, `${focused ? '› ' : '  '}${label}: `),
          h(Text, { inverse: focused, color: focused ? 'accent' : undefined },
            clip(value + (focused && field !== 'useSshConfig' && field !== 'auth' ? '▌' : ''), Math.max(8, columns - 18))),
        ))
      })
      return h(Box, { key: 'body', flexDirection: 'column', width: '100%', paddingX: 1 }, ...children)
    }

    function renderBrowse() {
      const current = browse
      if (!current) {
        return h(Box, { key: 'body', flexDirection: 'column', width: '100%', paddingX: 1 },
          h(Text, { color: 'subtle' }, t('browse.loading')))
      }
      const dirs = current.items.filter((item) => item && item.type === 'dir')
      const files = current.items.filter((item) => item && item.type !== 'dir')
      const combined = [...dirs, ...files]
      const selection = dirs.length ? Math.max(0, Math.min(current.selected, dirs.length - 1)) : 0
      const children = [
        h(Text, { key: 'title', bold: true, color: 'accent' }, t('browse.title', { path: clip(current.path || '/', Math.max(8, columns - 20)) })),
        h(Text, { key: 'machine', color: 'subtle' }, `${machineName(current.machine)} · ${machineAddress(current.machine)}`),
      ]
      if (!combined.length) {
        children.push(h(Text, { key: 'empty', color: 'subtle' }, busy ? t('browse.loading') : t('browse.empty')))
      } else {
        const slicing = windowSlice(combined, selection, Math.max(1, bodyHeight - 3))
        slicing.items.forEach((item, index) => {
          const absolute = slicing.offset + index
          const isDir = item.type === 'dir'
          const focused = isDir && absolute === selection
          const icon = isDir ? '▸' : '·'
          const suffix = isDir ? '/' : ''
          children.push(h(Text, {
            key: `${item.path || item.name || index}`,
            color: focused ? 'accent' : isDir ? undefined : 'subtle',
            dimColor: !isDir,
            inverse: focused,
          }, `${focused ? '› ' : '  '}${icon} ${clip(String(item.name || ''), Math.max(8, columns - 8))}${suffix}`))
        })
      }
      return h(Box, { key: 'body', flexDirection: 'column', width: '100%', paddingX: 1 }, ...children)
    }

    function renderConfirm() {
      const machine = confirmMachine
      const children = [
        h(Text, { key: 'title', bold: true, color: 'warning' }, t('confirm.deleteTitle')),
        h(Text, { key: 'message' }, t('confirm.delete', { name: machineName(machine) })),
        h(Text, { key: 'addr', color: 'subtle' }, machineAddress(machine)),
      ]
      return h(Box, { key: 'body', flexDirection: 'column', width: '100%', paddingX: 1 }, ...children)
    }

    function renderWorkspaces() {
      const machine = wsMachine
      const list = workspaces || []
      const children = [
        h(Text, { key: 'title', bold: true, color: 'accent' }, t('ws.title', { name: machine ? machineName(machine) : '' })),
        h(Text, { key: 'addr', color: 'subtle' }, machine ? machineAddress(machine) : ''),
      ]
      if (workspaces === null) {
        children.push(h(Text, { key: 'loading', color: 'subtle' }, busy || t('busy.loading')))
      } else if (!list.length) {
        children.push(h(Text, { key: 'empty', color: 'subtle' }, t('ws.empty')))
      } else {
        const slicing = windowSlice(list, Math.max(0, Math.min(wsIndex, list.length - 1)), Math.max(2, Math.floor((bodyHeight - 2) / 2)))
        slicing.items.forEach((item, index) => {
          const absolute = slicing.offset + index
          const focused = absolute === wsIndex
          const tags = []
          if (item.registered) tags.push(t('ws.registered'))
          if (item.recent) tags.push(t('ws.recent'))
          const live = Number(item.liveSessionCount) || 0
          children.push(h(Box, { key: `ws-${item.localMirror || absolute}`, flexDirection: 'row', width: '100%' },
            h(Text, { color: focused ? 'accent' : undefined, inverse: focused }, focused ? '› ' : '  '),
            h(Text, { bold: focused }, clip(item.title || basenameRemote(item.remotePath), Math.max(12, Math.floor(columns * 0.34)))),
            h(Text, { color: 'subtle' }, `  ${t('ws.sessions', { n: String(Number(item.sessionCount) || 0) })}`),
            live ? h(Text, { color: 'warning' }, `  ${t('ws.live', { n: String(live) })}`) : null,
            h(Text, { dimColor: true }, `  ${t('ws.size', { size: formatBytes(item.mirrorBytes) })}`),
            tags.length ? h(Text, { color: 'subtle' }, `  [${tags.join(' · ')}]`) : null,
          ))
          children.push(h(Text, { key: `ws-path-${item.localMirror || absolute}`, color: 'subtle', dimColor: true },
            clip(`    ${item.username ? item.username + '@' : ''}${item.host}:${item.remotePath}`, Math.max(20, columns - 3))))
        })
      }
      return h(Box, { key: 'body', flexDirection: 'column', width: '100%', paddingX: 1 }, ...children)
    }

    function renderWsConfirm() {
      const pending = wsConfirm
      const item = pending && pending.item
      const action = pending && pending.action
      const titleKey = action === 'delete' ? 'ws.confirmTitleDelete'
        : action === 'sessions' ? 'ws.confirmTitleSessions' : 'ws.confirmTitleRecent'
      const bodyKey = action === 'delete' ? 'ws.confirmDelete'
        : action === 'sessions' ? 'ws.confirmSessions' : 'ws.confirmRecent'
      const name = item ? (item.title || basenameRemote(item.remotePath)) : ''
      const sessions = item ? Number(item.sessionCount) || 0 : 0
      return h(Box, { key: 'body', flexDirection: 'column', width: '100%', paddingX: 1 },
        h(Text, { key: 'title', bold: true, color: 'warning' }, t(titleKey, { name })),
        h(Text, { key: 'message' }, clip(t(bodyKey, { n: String(sessions), name }), Math.max(20, columns - 4))),
        h(Text, { key: 'path', color: 'subtle' }, clip(item ? `${item.username ? item.username + '@' : ''}${item.host}:${item.remotePath}` : '', Math.max(20, columns - 4))),
        h(Text, { key: 'mirror', color: 'subtle' }, clip(item ? item.localMirror : '', Math.max(20, columns - 4))),
      )
    }

    function hintForView() {
      if (view === 'menu') return t('menu.hints')
      if (view === 'form') return t('form.hints')
      if (view === 'browse') return t('browse.hints')
      if (view === 'workspaces') return t('ws.hints')
      if (view === 'wsconfirm') return t('ws.confirmHints')
      if (view === 'confirm') return t('confirm.hints')
      return t('list.hints')
    }

    function renderFooter() {
      const children = []
      if (busy) children.push(h(Text, { key: 'busy', color: 'accent' }, t('busy.line', { what: busy })))
      const failure = view === 'form' && formErrors.length ? formErrors.join(' · ') : error
      if (failure) children.push(h(Text, { key: 'error', color: 'error' }, t('footer.error', { err: failure })))
      children.push(h(Text, { key: 'hint', color: 'subtle' }, clip(hintForView(), Math.max(20, columns - 2))))
      return h(Box, { key: 'footer', flexDirection: 'column', width: '100%', paddingX: 1 }, ...children)
    }

    function renderBody() {
      if (view === 'menu') return renderMenu()
      if (view === 'form') return renderForm()
      if (view === 'browse') return renderBrowse()
      if (view === 'workspaces') return renderWorkspaces()
      if (view === 'wsconfirm') return renderWsConfirm()
      if (view === 'confirm') return renderConfirm()
      return renderList()
    }

    return h(Box, { flexDirection: 'column', width: '100%', flexGrow: 1, paddingY: 0 },
      renderHeader(),
      renderBody(),
      renderFooter(),
    )
  }
}
