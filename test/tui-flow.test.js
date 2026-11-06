// dsh-remote TUI — 对话框降级流程（lib/tui/flow.js）单测。
//
// flow.js 是纯 async 向导逻辑：每一步都来自 tuiDialogs 的 select/input/confirm
//（契约：永不抛错、Esc 解析为 undefined/false）。这里的假 dialogs 用答案队列
// 回放一次完整交互，队列为空时返回 undefined —— 等价于用户在那一幕按下 Esc。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runDialogFlow } from '../lib/tui/flow.js'
import { createI18n } from '../lib/tui/i18n.js'

const MACHINE = { id: 'm1', name: 'builder', host: '10.0.0.2', port: 22, username: 'root' }

/** 记录调用、按队列作答的假 tuiDialogs。 */
function fakeDialogs(script = {}) {
  const queues = {
    select: [...(script.select || [])],
    input: [...(script.input || [])],
    confirm: [...(script.confirm || [])],
  }
  const calls = { select: [], input: [], confirm: [] }
  return {
    calls,
    select: async (opts) => { calls.select.push(opts); return queues.select.length ? queues.select.shift() : undefined },
    input: async (opts) => { calls.input.push(opts); return queues.input.length ? queues.input.shift() : undefined },
    confirm: async (opts) => { calls.confirm.push(opts); return queues.confirm.length ? queues.confirm.shift() : undefined },
  }
}

/** 记录 connect/upsert 的假宿主 API。 */
function fakeApi(overrides = {}) {
  const calls = { connect: [], upsert: [] }
  return {
    calls,
    listMachines: overrides.listMachines || (async () => ({ machines: [MACHINE], currentId: null })),
    connect: async (opts) => { calls.connect.push(opts); return {} },
    upsertMachine: async (patch) => { calls.upsert.push(patch); return { machine: {}, machines: [], currentId: null, warnings: [] } },
  }
}

const i18n = createI18n('zh')

test('guards: 没有 api 或 dialogs 时什么都不做', async () => {
  assert.equal(await runDialogFlow({}), undefined)
  assert.equal(await runDialogFlow({ api: fakeApi() }), undefined)
  // 受管对话框契约要求 select+input+confirm 齐备，缺一即整体降级。
  assert.equal(await runDialogFlow({ api: fakeApi(), dialogs: { select: async () => undefined }, i18n }), undefined)
})

test('连接路径：选中机器 → 确认 → connect(persist)', async () => {
  const api = fakeApi()
  const dialogs = fakeDialogs({ select: ['m1'], confirm: [true] })
  const result = await runDialogFlow({ api, dialogs, i18n })
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(api.calls.connect, [{ machineId: 'm1', persist: true }])
  // 机器选项行里要能认出这台机器（名字与 user@host:port）。
  assert.match(dialogs.calls.select[0].options[0].label, /builder/)
  assert.match(dialogs.calls.select[0].options[0].label, /root@10\.0\.0\.2:22/)
})

test('Esc 掉机器选择是干净的取消，不发起连接', async () => {
  const api = fakeApi()
  const dialogs = fakeDialogs({ select: [undefined] })
  assert.deepEqual(await runDialogFlow({ api, dialogs, i18n }), { kind: 'success' })
  assert.deepEqual(api.calls.connect, [])
})

test('连接前确认被拒就不连接', async () => {
  const api = fakeApi()
  const dialogs = fakeDialogs({ select: ['m1'], confirm: [false] })
  assert.deepEqual(await runDialogFlow({ api, dialogs, i18n }), { kind: 'success' })
  assert.deepEqual(api.calls.connect, [])
})

test('选中了已经不存在的机器是错误而不是崩溃', async () => {
  const api = fakeApi()
  const dialogs = fakeDialogs({ select: ['ghost'] })
  const result = await runDialogFlow({ api, dialogs, i18n })
  assert.equal(result.kind, 'error')
  assert.ok(result.text)
})

test('listMachines 抛错被收成 error 结果（消息透出）', async () => {
  const api = fakeApi({ listMachines: async () => { throw new Error('registry locked') } })
  const dialogs = fakeDialogs()
  const result = await runDialogFlow({ api, dialogs, i18n })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /registry locked/)
})

/** 新增机器的完整答案序列（host → port → user → name → auth → [keypath] → group → confirm）。 */
function addScript(answers = {}) {
  return {
    select: ['__dsh_remote_add__', ...(answers.auth ? [answers.auth] : ['password'])],
    input: [
      answers.host === undefined ? '10.0.0.9' : answers.host,
      answers.port === undefined ? '2222' : answers.port,
      answers.user === undefined ? 'deploy' : answers.user,
      answers.name === undefined ? 'box' : answers.name,
      ...(answers.auth === 'key' ? [answers.keypath === undefined ? 'C:\\keys\\id_ed25519' : answers.keypath] : []),
      answers.group === undefined ? 'prod' : answers.group,
    ],
    confirm: [answers.confirmSave === undefined ? true : answers.confirmSave],
  }
}

test('新增机器（密码认证）：逐字段输入 → 校验 → 确认 → upsert', async () => {
  const api = fakeApi()
  const dialogs = fakeDialogs(addScript())
  assert.deepEqual(await runDialogFlow({ api, dialogs, i18n }), { kind: 'success' })
  assert.equal(api.calls.upsert.length, 1)
  const patch = api.calls.upsert[0]
  assert.equal(patch.host, '10.0.0.9')
  assert.equal(patch.port, 2222)
  assert.equal(patch.username, 'deploy')
  assert.equal(patch.name, 'box')
  assert.equal(patch.group, 'prod')
  assert.equal(patch.useAgent, false)
  // 降级路径绝不收集 secret：patch 里没有 password/passphrase。
  assert.ok(!('password' in patch))
  assert.ok(!('passphrase' in patch))
})

test('新增机器（私钥认证）：多问一步私钥路径并带进 patch', async () => {
  const api = fakeApi()
  const dialogs = fakeDialogs(addScript({ auth: 'key' }))
  assert.deepEqual(await runDialogFlow({ api, dialogs, i18n }), { kind: 'success' })
  assert.equal(api.calls.upsert[0].privateKeyPath, 'C:\\keys\\id_ed25519')
})

test('新增机器（agent 认证）：useAgent=true，不问私钥路径', async () => {
  const api = fakeApi()
  const dialogs = fakeDialogs(addScript({ auth: 'agent' }))
  assert.deepEqual(await runDialogFlow({ api, dialogs, i18n }), { kind: 'success' })
  assert.equal(api.calls.upsert[0].useAgent, true)
  // input 队列恰好消耗完：host/port/user/name/group 五个，没有第六个（keypath）。
  assert.equal(dialogs.calls.input.length, 5)
})

test('host 必填：空回答会被重问直到有值', async () => {
  const api = fakeApi()
  const script = addScript()
  script.input.unshift('', '  ') // 前两答皆空
  const dialogs = fakeDialogs(script)
  assert.deepEqual(await runDialogFlow({ api, dialogs, i18n }), { kind: 'success' })
  assert.equal(api.calls.upsert[0].host, '10.0.0.9')
  assert.ok(dialogs.calls.input.length >= 7, '两个空 host + 正常五问 + 无 keypath')
})

test('任一字段 Esc 即中止，不产生半截机器', async () => {
  const api = fakeApi()
  // host 答了，port 一幕 Esc。
  const dialogs = fakeDialogs({ select: ['__dsh_remote_add__'], input: ['10.0.0.9', undefined] })
  assert.deepEqual(await runDialogFlow({ api, dialogs, i18n }), { kind: 'success' })
  assert.deepEqual(api.calls.upsert, [])
})

test('端口非法是校验错误，不 upsert', async () => {
  const api = fakeApi()
  const dialogs = fakeDialogs(addScript({ port: 'abc' }))
  const result = await runDialogFlow({ api, dialogs, i18n })
  assert.equal(result.kind, 'error')
  assert.deepEqual(api.calls.upsert, [])
})

test('选了私钥认证却不给路径是校验错误，不 upsert', async () => {
  const api = fakeApi()
  const dialogs = fakeDialogs(addScript({ auth: 'key', keypath: '   ' }))
  const result = await runDialogFlow({ api, dialogs, i18n })
  assert.equal(result.kind, 'error')
  assert.deepEqual(api.calls.upsert, [])
})

test('保存确认被拒绝则不写注册表', async () => {
  const api = fakeApi()
  const dialogs = fakeDialogs(addScript({ confirmSave: false }))
  assert.deepEqual(await runDialogFlow({ api, dialogs, i18n }), { kind: 'success' })
  assert.deepEqual(api.calls.upsert, [])
})
