// dsh-remote TUI 文案表（中 / 英）。
//
// TUI 侧所有用户可见字符串都从这里取：场景、对话框降级流程、命令描述、页脚
// 校验错误。默认中文；只有显式传了英文 lang 或环境变量 `DSH_TUI_LANG=en`
// 时才用英文（与 dsh-tui 自身的语言开关保持同一习惯）。
//
// 约束：zh / en 两个字典必须**键集完全一致**（tui-format.test.js 会断言），
// 否则漏翻的一侧会静默回落到 key 本身。

const DICT = {
  zh: {
    // ── 通用 / 命令 ────────────────────────────────────────────────────────
    title: 'dsh-remote · 远程服务器',
    'cmd.description': '打开 dsh-remote 远程服务器管理页（远程工作区）',
    'cmd.unavailable': '当前 profile 没有可用的 TUI 界面',
    'cmd.failed': 'dsh-remote 打开失败：{err}',
    'status.loading': '…',
    'status.none': '未连接远程机',
    'status.connected': '已连接 {target}',
    'status.disconnected': '未连接 · {target}',
    'status.detailMachine': '远程机 {name}',
    'status.detailTarget': '{user}@{host}:{port}',
    'status.detailRemote': '远端 {path}',

    // ── 机器列表 ──────────────────────────────────────────────────────────
    'list.hints': '↑↓ 选择 · →/Enter 动作菜单 · a 新增 · c 连接 · t 探测 · b 浏览 · e 编辑 · d 删除 · ←/Esc 关闭',
    'list.empty': '还没有保存的远程机 —— 按 a 添加一台',
    'list.count': '{count} 台机器',
    'list.current': '当前',
    'list.loading': '… 正在读取机器列表',

    // ── 动作菜单 ──────────────────────────────────────────────────────────
    'menu.title': '动作 · {name}',
    'menu.connect': '连接',
    'menu.workspace': '设为工作区',
    'menu.workspaces': '工作区管理（删除/清理）',
    'menu.edit': '编辑',
    'menu.delete': '删除',
    'menu.probe': '探测连接',
    'menu.browse': '浏览远程目录',
    'menu.hints': '↑↓ 选择 · →/Enter 执行 · ←/Esc 返回',

    // ── 表单 ──────────────────────────────────────────────────────────────
    'form.titleNew': '新增远程机',
    'form.titleEdit': '编辑远程机 · {name}',
    'form.name': '名称',
    'form.host': '主机 / 别名',
    'form.useSshConfig': '使用 ~/.ssh/config 别名',
    'form.port': '端口',
    'form.username': '用户名',
    'form.auth': '认证方式',
    'form.password': '密码',
    'form.privateKeyPath': '私钥路径',
    'form.passphrase': '私钥口令',
    'form.group': '分组',
    'form.passwordUnchanged': '（留空表示不修改）',
    'form.passwordPlaceholder': '（不保存密码）',
    'form.passphrasePlaceholder': '（无口令）',
    'form.hints': 'Tab/↓ 下一项 · Shift+Tab/↑ 上一项 · Space/←→ 切换 · Enter 保存 · Esc 取消',
    'form.required': '必填',
    'form.optional': '可选',
    'form.errHostRequired': '主机不能为空',
    'form.errHostInvalid': '主机格式不正确（不要包含空格、/ 或 @）',
    'form.errAliasInvalid': '~/.ssh/config 别名格式不正确',
    'form.errPortRange': '端口必须是 1-65535 的整数',
    'form.errAuth': '认证方式无效',
    'form.errKeyPath': '私钥认证需要填写私钥路径',

    // ── 认证方式 ──────────────────────────────────────────────────────────
    'auth.password': '密码',
    'auth.key': '私钥',
    'auth.agent': 'SSH Agent',

    // ── 删除确认 ──────────────────────────────────────────────────────────
    'confirm.deleteTitle': '删除远程机',
    'confirm.delete': '确定删除「{name}」？只删除本机保存的记录，不会改动远程文件。',
    'confirm.hints': 'y / → / Enter 确认 · n / ← / Esc 取消',

    // ── 远程目录浏览 ──────────────────────────────────────────────────────
    'browse.title': '远程目录 · {path}',
    'browse.loading': '… 正在读取目录',
    'browse.empty': '（空目录）',
    'browse.hints': '↑↓ 选择 · →/Enter 进入 · ←/Backspace 上级 · w 设为工作区 · Esc 返回',
    'browse.noSelection': '没有可进入的子目录',

    // ── 远程工作区清理 ────────────────────────────────────────────────────
    'ws.title': '工作区 · {name}',
    'ws.hints': '↑↓ 选择 · d 删除工作区（含镜像/对话）· x 仅删除对话 · r 移出最近列表 · ←/Esc 返回',
    'ws.empty': '这台机器还没有本地镜像工作区',
    'ws.sessions': '{n} 个对话',
    'ws.live': '{n} 个使用中',
    'ws.size': '镜像 {size}',
    'ws.registered': '已登记',
    'ws.recent': '最近',
    'ws.confirmTitleDelete': '删除工作区「{name}」？',
    'ws.confirmDelete': '将删除本地镜像目录、工作区登记和 {n} 个对话，并从最近列表移除该远端路径；不可恢复。',
    'ws.confirmTitleSessions': '删除「{name}」下的对话？',
    'ws.confirmSessions': '将删除 {n} 个对话，保留本地镜像目录与工作区登记；不可恢复。',
    'ws.confirmTitleRecent': '从最近列表移除「{name}」？',
    'ws.confirmRecent': '只从每台机器的「最近工作区」移除该远端路径（重启后不会再自动重建），本地镜像与台账保留。',
    'ws.confirmHints': 'y / → / Enter 确认 · n / ← / Esc 取消',
    'ws.busyDelete': '正在删除工作区',
    'ws.busySessions': '正在删除对话',
    'ws.busyRecent': '正在移出最近列表',
    'ws.deleted': '已删除工作区 {name}：{sessions} 个对话 + 本地镜像 + 登记',
    'ws.sessionsDeleted': '已删除 {n} 个对话（本地镜像保留）',
    'ws.sessionsPartial': '已删除 {n} 个对话；{live} 个正在使用，已跳过',
    'ws.recentForgotten': '已移出最近列表：{name}',
    'ws.busyError': '还有 {n} 个会话正在使用该工作区，请先停止它们',
    'ws.noApi': '当前 dshRemote 不支持工作区清理（插件版本过旧）',

    // ── 加载态 / 页脚 ─────────────────────────────────────────────────────
    'busy.line': '… {what}',
    'busy.connecting': '正在连接',
    'busy.probing': '正在探测',
    'busy.listing': '正在读取目录',
    'busy.saving': '正在保存',
    'busy.deleting': '正在删除',
    'busy.settingWorkspace': '正在建立工作区',
    'busy.loading': '正在加载',
    'busy.loadingMirrors': '正在读取本地镜像工作区',
    'footer.error': '错误：{err}',
    'error.generic': '操作失败',
    'error.noApi': '宿主 API 不可用',
    'error.badWorkspace': '无法构造工作区目标（本地镜像缺失）',

    // ── toast / notify ────────────────────────────────────────────────────
    'notify.connected': '已连接 {target}',
    'notify.probeOk': '连接正常 · {target} · {latency} ms',
    'notify.probeFailed': '探测失败：{err}',
    'notify.saved': '已保存 {name}',
    'notify.deleted': '已删除 {name}',
    'notify.workspaceSet': '已采用工作区 {label}',
    'notify.switchRefused': '宿主拒绝切换到 {label}',
    'notify.switchFailed': '切换工作区失败：{err}',
    'notify.pickFailed': '无法采用该目录：{err}',
    'notify.noWorkspace': '该机器还没有记录的工作区，正在打开目录浏览',
    'notify.warnings': '警告：{text}',

    // ── 无场景时的对话框降级流程 ──────────────────────────────────────────
    'flow.add': '＋ 新增远程机',
    'flow.addDescription': '输入主机、端口和用户名',
    'flow.selectTitle': '选择远程机',
    'flow.machineOption': '{name} · {target}',
    'flow.connectTitle': '连接到 {name}？',
    'flow.connect': '连接',
    'flow.cancel': '取消',
    'flow.machineMissing': '找不到该机器（列表已变化）',
    'flow.hostTitle': '主机（必填）',
    'flow.hostPlaceholder': 'example.com 或 ~/.ssh/config 别名',
    'flow.portTitle': '端口',
    'flow.portPlaceholder': '22',
    'flow.usernameTitle': '用户名',
    'flow.usernamePlaceholder': 'root',
    'flow.nameTitle': '显示名称',
    'flow.namePlaceholder': '留空则使用主机名',
    'flow.authTitle': '认证方式',
    'flow.keyPathTitle': '私钥路径',
    'flow.keyPathPlaceholder': '/home/me/.ssh/id_ed25519',
    'flow.groupTitle': '分组',
    'flow.groupPlaceholder': '留空表示不分组',
    'flow.saveConfirm': '保存这台远程机？',
    'flow.save': '保存',
  },
  en: {
    title: 'dsh-remote · remote servers',
    'cmd.description': 'Open the dsh-remote server manager (remote workspaces)',
    'cmd.unavailable': 'the dsh-remote TUI is not available in this profile',
    'cmd.failed': 'dsh-remote failed to open: {err}',
    'status.loading': '…',
    'status.none': 'no remote machine',
    'status.connected': 'connected · {target}',
    'status.disconnected': 'disconnected · {target}',
    'status.detailMachine': 'machine {name}',
    'status.detailTarget': '{user}@{host}:{port}',
    'status.detailRemote': 'remote {path}',

    'list.hints': '↑↓ select · →/Enter actions · a add · c connect · t probe · b browse · e edit · d delete · ←/Esc close',
    'list.empty': 'no saved machines yet — press a to add one',
    'list.count': '{count} machines',
    'list.current': 'current',
    'list.loading': '… loading machines',

    'menu.title': 'Actions · {name}',
    'menu.connect': 'Connect',
    'menu.workspace': 'Use as workspace',
    'menu.workspaces': 'Manage workspaces (delete)',
    'menu.edit': 'Edit',
    'menu.delete': 'Delete',
    'menu.probe': 'Probe connection',
    'menu.browse': 'Browse remote directory',
    'menu.hints': '↑↓ select · →/Enter run · ←/Esc back',

    'form.titleNew': 'Add remote machine',
    'form.titleEdit': 'Edit remote machine · {name}',
    'form.name': 'Name',
    'form.host': 'Host / alias',
    'form.useSshConfig': 'Use ~/.ssh/config alias',
    'form.port': 'Port',
    'form.username': 'Username',
    'form.auth': 'Authentication',
    'form.password': 'Password',
    'form.privateKeyPath': 'Private key path',
    'form.passphrase': 'Key passphrase',
    'form.group': 'Group',
    'form.passwordUnchanged': '(leave empty to keep)',
    'form.passwordPlaceholder': '(not saved)',
    'form.passphrasePlaceholder': '(no passphrase)',
    'form.hints': 'Tab/↓ next · Shift+Tab/↑ previous · Space/←→ toggle · Enter save · Esc cancel',
    'form.required': 'required',
    'form.optional': 'optional',
    'form.errHostRequired': 'host is required',
    'form.errHostInvalid': 'invalid host (no spaces, / or @)',
    'form.errAliasInvalid': 'invalid ~/.ssh/config alias',
    'form.errPortRange': 'port must be an integer between 1 and 65535',
    'form.errAuth': 'invalid authentication mode',
    'form.errKeyPath': 'key authentication needs a private key path',

    'auth.password': 'Password',
    'auth.key': 'Private key',
    'auth.agent': 'SSH Agent',

    'confirm.deleteTitle': 'Delete remote machine',
    'confirm.delete': 'Delete "{name}"? Only the local record is removed; remote files are untouched.',
    'confirm.hints': 'y / → / Enter confirm · n / ← / Esc cancel',

    'browse.title': 'Remote directory · {path}',
    'browse.loading': '… loading directory',
    'browse.empty': '(empty directory)',
    'browse.hints': '↑↓ select · →/Enter open · ←/Backspace up · w use as workspace · Esc back',
    'browse.noSelection': 'no subdirectory to open',
    'ws.title': 'Workspaces · {name}',
    'ws.hints': '↑↓ select · d delete workspace (mirror + chats) · x delete chats only · r forget recent · ←/Esc back',
    'ws.empty': 'no local mirror workspaces for this machine',
    'ws.sessions': '{n} chats',
    'ws.live': '{n} in use',
    'ws.size': 'mirror {size}',
    'ws.registered': 'registered',
    'ws.recent': 'recent',
    'ws.confirmTitleDelete': 'Delete workspace "{name}"?',
    'ws.confirmDelete': 'Deletes the local mirror directory, the workspace registration and {n} chats, and forgets the remote path; this cannot be undone.',
    'ws.confirmTitleSessions': 'Delete the chats under "{name}"?',
    'ws.confirmSessions': 'Deletes {n} chats and keeps the local mirror and registration; this cannot be undone.',
    'ws.confirmTitleRecent': 'Forget "{name}" from the recent list?',
    'ws.confirmRecent': 'Only removes the remote path from every machine\'s recent list (so a restart will not recreate it); the mirror and registration stay.',
    'ws.confirmHints': 'y / → / Enter confirm · n / ← / Esc cancel',
    'ws.busyDelete': 'deleting workspace',
    'ws.busySessions': 'deleting chats',
    'ws.busyRecent': 'forgetting recent entry',
    'ws.deleted': 'workspace {name} deleted: {sessions} chats + mirror + registration',
    'ws.sessionsDeleted': 'deleted {n} chats (mirror kept)',
    'ws.sessionsPartial': 'deleted {n} chats; {live} in use were skipped',
    'ws.recentForgotten': 'forgot recent entry: {name}',
    'ws.busyError': '{n} chats still in use — stop them first',
    'ws.noApi': 'this dshRemote build has no workspace cleanup (plugin too old)',


    'busy.line': '… {what}',
    'busy.connecting': 'connecting',
    'busy.probing': 'probing',
    'busy.listing': 'loading directory',
    'busy.saving': 'saving',
    'busy.deleting': 'deleting',
    'busy.settingWorkspace': 'creating workspace',
    'busy.loading': 'loading',
    'busy.loadingMirrors': 'loading local mirror workspaces',
    'footer.error': 'error: {err}',
    'error.generic': 'operation failed',
    'error.noApi': 'the host API is unavailable',
    'error.badWorkspace': 'cannot build the workspace target (local mirror missing)',

    'notify.connected': 'connected to {target}',
    'notify.probeOk': 'connection ok · {target} · {latency} ms',
    'notify.probeFailed': 'probe failed: {err}',
    'notify.saved': 'saved {name}',
    'notify.deleted': 'deleted {name}',
    'notify.workspaceSet': 'workspace adopted: {label}',
    'notify.switchRefused': 'the host refused to switch to {label}',
    'notify.switchFailed': 'workspace switch failed: {err}',
    'notify.pickFailed': 'cannot adopt this directory: {err}',
    'notify.noWorkspace': 'this machine has no recorded workspace yet — opening the directory browser',
    'notify.warnings': 'warning: {text}',

    'flow.add': '+ Add remote machine',
    'flow.addDescription': 'Enter host, port and username',
    'flow.selectTitle': 'Pick a remote machine',
    'flow.machineOption': '{name} · {target}',
    'flow.connectTitle': 'Connect to {name}?',
    'flow.connect': 'Connect',
    'flow.cancel': 'Cancel',
    'flow.machineMissing': 'machine not found (the list changed)',
    'flow.hostTitle': 'Host (required)',
    'flow.hostPlaceholder': 'example.com or a ~/.ssh/config alias',
    'flow.portTitle': 'Port',
    'flow.portPlaceholder': '22',
    'flow.usernameTitle': 'Username',
    'flow.usernamePlaceholder': 'root',
    'flow.nameTitle': 'Display name',
    'flow.namePlaceholder': 'empty uses the host',
    'flow.authTitle': 'Authentication',
    'flow.keyPathTitle': 'Private key path',
    'flow.keyPathPlaceholder': '/home/me/.ssh/id_ed25519',
    'flow.groupTitle': 'Group',
    'flow.groupPlaceholder': 'empty means ungrouped',
    'flow.saveConfirm': 'Save this remote machine?',
    'flow.save': 'Save',
  },
}

/** 规范化语言代码 → 'zh' | 'en'；无法识别时返回 undefined。 */
export function normalizeLang(lang) {
  const value = String(lang === undefined || lang === null ? '' : lang).trim().toLowerCase()
  if (!value) return undefined
  if (value === 'en' || value.startsWith('en-') || value.startsWith('en_')) return 'en'
  if (value === 'zh' || value.startsWith('zh-') || value.startsWith('zh_')) return 'zh'
  return undefined
}

/**
 * 创建文案渲染器。
 *
 * @param {string} [lang] - 'zh' / 'en'（或 zh-CN / en-US）。省略时读
 *   `DSH_TUI_LANG` 环境变量，仍无法判定则中文。
 * @returns {{ lang: 'zh'|'en', dict: Record<string, string>, t(key: string, params?: object): string }}
 */
export function createI18n(lang) {
  const fromArg = normalizeLang(lang)
  const envLang = typeof process === 'object' && process && process.env ? process.env.DSH_TUI_LANG : ''
  const resolved = fromArg || normalizeLang(envLang) || 'zh'
  const dict = DICT[resolved] || DICT.zh
  const fallback = DICT.zh

  /** 取文案并做 {name} 插值；缺 key 时回落中文，再缺则返回 key 本身。 */
  function t(key, params) {
    const name = String(key)
    let text = dict[name]
    if (text === undefined) text = fallback[name]
    if (text === undefined) return name
    if (!params) return text
    return text.replace(/\{(\w+)\}/g, (match, param) => {
      const value = params[param]
      return value === undefined || value === null ? match : String(value)
    })
  }

  return { lang: resolved, dict, t }
}

/** 暴露字典本身（测试校验两侧键集一致；运行时请用 createI18n）。 */
export const TRANSLATIONS = DICT
