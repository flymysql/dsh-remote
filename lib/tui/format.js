// dsh-remote TUI — 纯函数工具（URI 编解码 / target 构造 / 表单校验 / 文案）。
//
// 这里**只放纯计算**：不读写文件、不连网、不 import cordis。provider / scene /
// 测试共用这些函数，因此它们必须能在没有 TUI、没有 DSH 进程的环境里直接调用。
//
// 远程路径同时支持 POSIX（`/home/u/proj`）与 Windows（`C:\work`、`D:\`、
// `\\server\share`）两种形态；具体归一化复用 lib/paths.js（已被 issue #58/#60
// 等测试覆盖），避免 TUI 侧再造一套分隔符逻辑。

import { normalizeRemotePath, remoteWorkspaceTitle } from '../paths.js'
import { createI18n } from './i18n.js'

/** 本 provider 拥有的 URI scheme（不带冒号）。 */
export const URI_SCHEME = 'dshremote'

/** 表单支持的认证方式。 */
export const AUTH_MODES = ['password', 'key', 'agent']

/** 默认的 zh 文案渲染器（statusLine / validateMachineForm 的默认 t）。 */
const defaultT = createI18n('zh').t

/**
 * 组合一个 provider URI：`dshremote://<编码后的机器 id>/<编码后的远程绝对路径>`。
 *
 * 机器段与路径段都整体 encodeURIComponent（路径里的 `/`、`\`、`:`、空格、中文
 * 全部转义），因此 URI 里**不会出现裸斜杠**，解析时不存在歧义。
 *
 * @param {string} machineId - 机器 id（provider 内部身份，也接受机器名）。
 * @param {string} remotePath - 远程绝对路径（POSIX 或 Windows）。
 * @returns {string} 可粘贴、可持久化的 URI。
 */
export function buildUri(machineId, remotePath) {
  const id = encodeURIComponent(String(machineId === undefined || machineId === null ? '' : machineId).trim())
  const path = encodeURIComponent(String(remotePath === undefined || remotePath === null ? '' : remotePath))
  return `${URI_SCHEME}://${id}/${path}`
}

/**
 * 解析 provider URI（scheme 大小写不敏感；两段都做 URL 解码）。
 *
 * Windows 盘符路径（`C:\work`）编码后是 `C%3A%5Cwork`，解码回来仍是
 * `C:\work`；机器段可以是 id 也可以是机器名，解析层不区分。
 *
 * @param {string} uri - 形如 `dshremote://m1/%2Fhome%2Fu%2Fproj`。
 * @returns {{ machineId: string, remotePath: string } | undefined} 解析失败返回
 *   undefined（不抛错：URI 来自用户输入，不能让它炸掉渲染）。
 */
export function parseUri(uri) {
  const raw = String(uri === undefined || uri === null ? '' : uri).trim()
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)\/(.*)$/s.exec(raw)
  if (!match) return undefined
  if (match[1].toLowerCase() !== URI_SCHEME) return undefined
  let machineId
  let remotePath
  try {
    machineId = decodeURIComponent(match[2])
    remotePath = decodeURIComponent(match[3])
  } catch {
    return undefined
  }
  if (!machineId.trim() || !remotePath.trim()) return undefined
  return { machineId: machineId.trim(), remotePath }
}

/**
 * 把机器名压成列表里的紧凑 badge：最多 12 个字符（按码点计，中文算 1 个），
 * 超长用 `…` 截断。空名回落 `remote`，保证 badge 非空。
 *
 * @param {string} name - 机器显示名。
 * @returns {string} ≤12 个字符的 badge 文本。
 */
export function dbadge(name) {
  const chars = Array.from(String(name === undefined || name === null ? '' : name).trim())
  if (chars.length === 0) return 'remote'
  if (chars.length <= 12) return chars.join('')
  return chars.slice(0, 11).join('') + '…'
}

/**
 * 远程路径的 basename（POSIX 与 Windows 盘符都处理）。
 *
 * 根路径没有 basename：POSIX `/` 与 Windows `D:\` 分别返回 `/` 与 `D:`，
 * 保证调用方拿到的是非空字符串（workspace label 需要它）。
 *
 * @param {string} remotePath - 远程路径。
 * @returns {string} 最后一段（或根标记）。
 */
export function basenameRemote(remotePath) {
  const normalized = normalizeRemotePath(String(remotePath === undefined || remotePath === null ? '' : remotePath))
  const trimmed = normalized.replace(/[\\/]+$/, '')
  if (!trimmed) return '/'
  const parts = trimmed.split(/[\\/]+/)
  return parts[parts.length - 1] || trimmed
}

/**
 * 把相对路径解析到远程绝对路径上；绝对路径（POSIX `/…`、Windows `C:\…`、
 * UNC `\\server\share`）原样归一化后返回。
 *
 * 相对段允许 `..` / `.`，`normalizeRemotePath` 会折叠它们；分隔符跟随 base
 * 的风格（base 是 Windows 路径时用 `\`，否则用 `/`）。
 *
 * @param {string} remotePath - 远程 base 绝对路径。
 * @param {string} relative - 相对路径，或另一个绝对远程路径。
 * @returns {string} 归一化后的远程绝对路径。
 */
export function joinRemote(remotePath, relative) {
  const base = normalizeRemotePath(String(remotePath === undefined || remotePath === null ? '' : remotePath))
  const rel = String(relative === undefined || relative === null ? '' : relative).trim()
  if (!rel || rel === '.') return base
  // 绝对路径：POSIX 根、Windows 盘符、UNC、以及 `C:` 形式。
  if (/^[\\/]/.test(rel) || /^[A-Za-z]:([\\/]|$)/.test(rel)) return normalizeRemotePath(rel)
  const sep = base.includes('\\') ? '\\' : '/'
  const joined = base.endsWith(sep) ? base + rel : base + sep + rel
  return normalizeRemotePath(joined)
}

/**
 * 由「机器 + 本地镜像 + 远程路径」构造 `TuiWorkspaceTarget`。
 *
 * `cwd` 必须是本地真实存在的镜像目录（会话身份由 session header.cwd 落在哪个
 * 镜像决定）；`uri` 表达远程身份；`description` 显示 `user@host:remote/path`；
 * `badge` 是宿主不解释的紧凑机器名。
 *
 * @param {{ machine?: object, localMirror?: string, remotePath?: string, title?: string }} input
 * @returns {{ uri: string, cwd: string, label: string, description: string,
 *   kind: 'provider', badge: string } | undefined} 缺机器身份或本地镜像时 undefined。
 */
export function targetFromWorkspace(input) {
  const source = input || {}
  const machine = source.machine || {}
  const remotePath = normalizeRemotePath(String(source.remotePath || ''))
  const localMirror = String(source.localMirror || '')
  const id = String(machine.id || machine.alias || machine.host || '').trim()
  if (!id || !localMirror) return undefined
  const host = String(machine.host || '').trim()
  const user = String(machine.username || '').trim()
  const target = user ? `${user}@${host}:${remotePath}` : `${host}:${remotePath}`
  const title = String(source.title || '').trim()
  return {
    uri: buildUri(id, remotePath),
    cwd: localMirror,
    label: title || remoteWorkspaceTitle(remotePath, machine) || basenameRemote(remotePath),
    description: target,
    kind: 'provider',
    badge: dbadge(machine.name || machine.host || id),
  }
}

/** hostname / IPv4 / IPv6（可带方括号）的宽松字符校验。 */
const HOST_TOKEN_RE = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._:-]+)$/
/** ~/.ssh/config 的 Host alias（字母数字与 `._-`；允许 `*`/`?` 通配符）。 */
const ALIAS_TOKEN_RE = /^[A-Za-z0-9._*?-]+$/
/** 端口：1–5 位数字，范围另判。 */
const PORT_RE = /^\d{1,5}$/

/**
 * 校验机器表单，返回 `{ errors, patch }`。
 *
 * - `errors` 是**文案 key**（调用方用 i18n 渲染；测试可直接断言 key），也可传
 *   入 `t` 让函数自己翻译成人类可读的错误串。
 * - `patch` 直接可作为 `api.upsertMachine()` 的参数（MachinePatch）；密码 /
 *   passphrase 为空时**不写进 patch**（“留空表示不修改”），从不回显。
 * - `useSshConfig === true` 时 `host` 是 `~/.ssh/config` 的 Host alias：仍必填，
 *   但按 alias 字符集校验（不要求是 hostname/IP）；用户名/端口可留空（连接时
 *   由 ssh 配置解析）。
 *
 * @param {object} form - 表单字段（name/host/port/username/auth/password/
 *   privateKeyPath/passphrase/group/useSshConfig/id）。
 * @param {(key: string) => string} [t] - 可选的文案渲染器，省略时 errors 保留 key。
 * @returns {{ errors: string[], patch: object }}
 */
export function validateMachineForm(form, t) {
  const tr = typeof t === 'function' ? t : (key) => key
  const input = form || {}
  const useSshConfig = input.useSshConfig === true
  const errors = []

  const host = String(input.host === undefined || input.host === null ? '' : input.host).trim()
  if (!host) {
    errors.push(tr('form.errHostRequired'))
  } else if (useSshConfig) {
    if (!ALIAS_TOKEN_RE.test(host)) errors.push(tr('form.errAliasInvalid'))
  } else if (!HOST_TOKEN_RE.test(host)) {
    errors.push(tr('form.errHostInvalid'))
  }

  let port = 22
  const rawPort = String(input.port === undefined || input.port === null ? '' : input.port).trim()
  if (rawPort) {
    const numeric = Number(rawPort)
    if (!PORT_RE.test(rawPort) || !Number.isInteger(numeric) || numeric < 1 || numeric > 65535) {
      errors.push(tr('form.errPortRange'))
    } else {
      port = numeric
    }
  }

  const auth = String(input.auth === undefined || input.auth === null ? '' : input.auth).trim()
  if (auth && !AUTH_MODES.includes(auth)) errors.push(tr('form.errAuth'))
  const resolvedAuth = AUTH_MODES.includes(auth) ? auth : 'password'

  const privateKeyPath = String(
    input.privateKeyPath === undefined || input.privateKeyPath === null ? '' : input.privateKeyPath,
  ).trim()
  if (resolvedAuth === 'key' && !privateKeyPath) errors.push(tr('form.errKeyPath'))

  const username = String(input.username === undefined || input.username === null ? '' : input.username).trim()
  const group = String(input.group === undefined || input.group === null ? '' : input.group).trim()

  const patch = {
    name: String(input.name === undefined || input.name === null ? '' : input.name).trim() || host,
    host,
    port,
    username: username || 'root',
    useSshConfig,
    useAgent: resolvedAuth === 'agent',
    privateKeyPath,
    group,
  }
  // 表单没有编辑、但宿主 upsert 会用默认值覆盖的机器级字段：编辑时从 MachineView
  // 原样带回（formFromMachine 写入隐藏字段），否则一次 TUI 编辑会把 backend 重置成
  // native、清空 workspace / hostKeyMode / sshBinary。调用方没给这些键时不写入
  // patch，保持“省略=保留旧值”的契约。
  if (input.workspace !== undefined && input.workspace !== null) patch.workspace = String(input.workspace).trim()
  if (input.hostKeyMode !== undefined && input.hostKeyMode !== null) patch.hostKeyMode = String(input.hostKeyMode).trim()
  if (input.backend !== undefined && input.backend !== null) {
    patch.backend = String(input.backend) === 'openssh' ? 'openssh' : 'native'
  }
  if (input.sshBinary !== undefined && input.sshBinary !== null) patch.sshBinary = String(input.sshBinary).trim()
  if (input.keyboardInteractive !== undefined && input.keyboardInteractive !== null) {
    patch.keyboardInteractive = input.keyboardInteractive === true
  }
  if (input.id !== undefined && input.id !== null && String(input.id).trim()) patch.id = String(input.id).trim()
  // 密码 / 口令只写不读：表单留空 = 保持原值，绝不把空串写进 patch。
  const password = input.password === undefined || input.password === null ? '' : String(input.password)
  if (password) patch.password = password
  const passphrase = input.passphrase === undefined || input.passphrase === null ? '' : String(input.passphrase)
  if (passphrase) patch.passphrase = passphrase

  return { errors, patch }
}

/**
 * MachineView → 可编辑表单的初值。
 *
 * 密码与私钥口令**永远不预填**（`''` 表示“不修改”）；认证方式由 `useAgent` /
 * `privateKeyPath` 反推。
 *
 * @param {object} machine - MachineView（来自宿主 api，绝无 secret）。
 * @returns {object} 表单对象。
 */
export function formFromMachine(machine) {
  const source = machine || {}
  const auth = source.useAgent ? 'agent' : source.privateKeyPath ? 'key' : 'password'
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
    host: String(source.host || ''),
    port: String(Number(source.port) || 22),
    username: String(source.username || ''),
    useSshConfig: source.useSshConfig === true,
    auth,
    password: '',
    privateKeyPath: String(source.privateKeyPath || ''),
    passphrase: '',
    group: String(source.group || ''),
    // 不在 TUI 表单里编辑、但保存时必须原样带回去的机器级字段（见
    // validateMachineForm 的同一段说明）：否则一次编辑会重置 backend 等设置。
    workspace: String(source.workspace || ''),
    hostKeyMode: String(source.hostKeyMode || ''),
    backend: String(source.backend || '') === 'openssh' ? 'openssh' : 'native',
    sshBinary: String(source.sshBinary || ''),
    keyboardInteractive: source.keyboardInteractive === true,
  }
}

/** 新增机器的空表单（端口默认 22、认证方式默认 password）。 */
export function emptyMachineForm() {
  return {
    id: '',
    name: '',
    host: '',
    port: '22',
    username: '',
    useSshConfig: false,
    auth: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    group: '',
    workspace: '',
    hostKeyMode: '',
    backend: 'native',
    sshBinary: '',
    keyboardInteractive: false,
  }
}

/**
 * 顶部状态行文案（`user@host` + 连接状态）。
 *
 * @param {object} status - 宿主 `status()` 返回值。
 * @param {(key: string, params?: object) => string} [t] - 文案渲染器（默认中文）。
 * @returns {string} 例如 `已连接 root@10.0.0.2`。
 */
export function statusLine(status, t) {
  const tr = typeof t === 'function' ? t : defaultT
  if (!status || (!status.host && !status.connected)) return tr('status.none')
  const host = String(status.host || '')
  const user = String(status.username || '')
  const target = user ? `${user}@${host}` : host
  return tr(status.connected ? 'status.connected' : 'status.disconnected', { target })
}

/** Human byte size for the cleanup page (binary units, one decimal).
 *
 * @param {number} value - byte count.
 * @returns {string} e.g. `0 B`, `943 B`, `12.4 KB`, `1.8 MB`.
 */
export function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = bytes / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`
}

/** 东亚宽字符 / emoji 占两个终端单元格，其余一个（粗略但够用的 wcwidth 子集）。 */
function charCells(codePoint) {
  if (codePoint === 0) return 0
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x231a && codePoint <= 0x231b)
    || (codePoint >= 0x23e9 && codePoint <= 0x23f3)
    || (codePoint >= 0x25fd && codePoint <= 0x25fe)
    || (codePoint >= 0x2600 && codePoint <= 0x27bf)
    || (codePoint >= 0x2b00 && codePoint <= 0x2bff)
    || (codePoint >= 0x1f000 && codePoint <= 0x1f2ff)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) return 2
  return 1
}

/** 字符串在终端里占用的单元格数（CJK / emoji 记 2）。 */
export function displayWidth(text) {
  let cells = 0
  for (const char of String(text == null ? '' : text)) cells += charCells(char.codePointAt(0))
  return cells
}

/** 按终端单元格截断，超宽时以 `…` 结尾（不再额外超宽）。 */
export function clipCells(text, maxCells) {
  const value = String(text == null ? '' : text)
  const limit = Math.max(1, Math.floor(Number(maxCells) || 0))
  if (displayWidth(value) <= limit) return value
  let out = ''
  let used = 0
  for (const char of value) {
    const cells = charCells(char.codePointAt(0))
    if (used + cells > limit - 1) break
    out += char
    used += cells
  }
  return `${out}…`
}
