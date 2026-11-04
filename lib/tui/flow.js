// dsh-remote TUI — 没有全屏场景接缝时的对话框降级流程。
//
// 只使用 dsh-tui 的受管对话框（ctx.tuiDialogs 的 select / input / confirm，
// 永不抛错、Esc 一律解析为 undefined/false），因此这里不需要任何 React。
// 返回纯数据（CommandResult 形状），由 `lib/tui/index.js` 的命令 handler 直接返回。
//
// 说明：dialog.input 没有掩码输入，所以这条降级路径**不收集密码 / passphrase**
// （绝不把明文密码显示在对话里）；需要填写凭据时请用 `/dsh-remote` 全屏场景，
// 或先保存机器再通过既有设置页补密码。

import { AUTH_MODES, validateMachineForm } from './format.js'

/** `select` 里“新增机器”选项的保留 id。 */
const ADD_ID = '__dsh_remote_add__'

/** 机器选项的一行文案。 */
function machineOption(t, machine) {
  const name = String((machine && machine.name) || (machine && machine.host) || (machine && machine.id) || '')
  const user = String((machine && machine.username) || '')
  const host = String((machine && machine.host) || '')
  const port = Number(machine && machine.port) || 22
  const target = `${user ? user + '@' : ''}${host}:${port}`
  return t('flow.machineOption', { name, target })
}

/**
 * 无场景时的交互降级：选机器 → 连接；或新增 → 逐字段输入 → 保存。
 *
 * @param {object} deps
 * @param {object} deps.api - 宿主进程内 API。
 * @param {object} deps.dialogs - `ctx.get('tuiDialogs', false)`；不存在返回 undefined。
 * @param {object} deps.i18n - createI18n 返回值。
 * @param {object} [deps.channel] - 活会话 channel（当前流程未使用，保留给后续扩展）。
 * @returns {Promise<{kind:'success'|'error', text?:string}|undefined>} 纯数据结果。
 */
export async function runDialogFlow({ api, dialogs, i18n, channel } = {}) {
  if (!api || !dialogs) return undefined
  const t = i18n && typeof i18n.t === 'function' ? i18n.t : (key) => String(key)
  if (typeof dialogs.select !== 'function' || typeof dialogs.input !== 'function' || typeof dialogs.confirm !== 'function') {
    return undefined
  }
  try {
    const state = await api.listMachines()
    const machines = Array.isArray(state && state.machines) ? state.machines : []
    const currentId = state && state.currentId !== undefined ? state.currentId : null
    const options = machines.map((machine) => ({
      id: machine.id,
      label: machineOption(t, machine),
      ...(machine.id === currentId ? { description: t('list.current') } : {}),
    }))
    options.push({ id: ADD_ID, label: t('flow.add'), description: t('flow.addDescription') })
    const picked = await dialogs.select({ title: t('flow.selectTitle'), options })
    if (picked === undefined) return { kind: 'success' }
    if (picked === ADD_ID) return await addMachine({ api, dialogs, t })

    const machine = machines.find((entry) => entry.id === picked)
    if (!machine) return { kind: 'error', text: t('flow.machineMissing') }
    const confirmed = await dialogs.confirm({
      title: t('flow.connectTitle', { name: machine.name || machine.host || machine.id }),
      message: machineOption(t, machine),
      confirmLabel: t('flow.connect'),
      cancelLabel: t('flow.cancel'),
    })
    if (!confirmed) return { kind: 'success' }
    await api.connect({ machineId: machine.id, persist: true })
    return { kind: 'success' }
  } catch (failure) {
    return { kind: 'error', text: String((failure && failure.message) || failure) }
  }
}

/** 逐字段输入一台新机器（不收集任何 secret，见文件头注释）。 */
async function addMachine({ api, dialogs, t }) {
  const ask = async (title, placeholder, initial) => dialogs.input({
    title,
    ...(placeholder ? { placeholder } : {}),
    ...(initial ? { initial } : {}),
  })

  let host = ''
  for (;;) {
    const answer = await ask(t('flow.hostTitle'), t('flow.hostPlaceholder'))
    if (answer === undefined) return { kind: 'success' }
    host = String(answer).trim()
    if (host) break
  }
  const portAnswer = await ask(t('flow.portTitle'), t('flow.portPlaceholder'), '22')
  if (portAnswer === undefined) return { kind: 'success' }
  const userAnswer = await ask(t('flow.usernameTitle'), t('flow.usernamePlaceholder'), 'root')
  if (userAnswer === undefined) return { kind: 'success' }
  const nameAnswer = await ask(t('flow.nameTitle'), t('flow.namePlaceholder'), host)
  if (nameAnswer === undefined) return { kind: 'success' }
  const authAnswer = await dialogs.select({
    title: t('flow.authTitle'),
    options: AUTH_MODES.map((mode) => ({ id: mode, label: t('auth.' + mode) })),
  })
  if (authAnswer === undefined) return { kind: 'success' }
  let privateKeyPath = ''
  if (authAnswer === 'key') {
    const keyAnswer = await ask(t('flow.keyPathTitle'), t('flow.keyPathPlaceholder'))
    if (keyAnswer === undefined) return { kind: 'success' }
    privateKeyPath = String(keyAnswer).trim()
  }
  const groupAnswer = await ask(t('flow.groupTitle'), t('flow.groupPlaceholder'))
  if (groupAnswer === undefined) return { kind: 'success' }

  const form = {
    name: String(nameAnswer).trim(),
    host,
    port: String(portAnswer).trim(),
    username: String(userAnswer).trim(),
    useSshConfig: false,
    auth: AUTH_MODES.includes(authAnswer) ? authAnswer : 'password',
    password: '',
    privateKeyPath,
    passphrase: '',
    group: String(groupAnswer).trim(),
  }
  const { errors, patch } = validateMachineForm(form, t)
  if (errors.length) return { kind: 'error', text: errors.join('; ') }
  const confirmed = await dialogs.confirm({
    title: t('flow.saveConfirm'),
    message: machineOption(t, { name: patch.name, username: patch.username, host: patch.host, port: patch.port }),
    confirmLabel: t('flow.save'),
    cancelLabel: t('flow.cancel'),
  })
  if (!confirmed) return { kind: 'success' }
  await api.upsertMachine(patch)
  return { kind: 'success' }
}
