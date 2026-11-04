// dsh-remote TUI — 纯函数层（lib/tui/format.js + lib/tui/i18n.js）单测。
//
// 重点：
//   · provider URI 必须能无损承载「机器 id + 任意远程绝对路径」（POSIX / Windows
//     盘符 / UNC / 中文 / 空格），否则 /workspace open 与启动参数会丢字符；
//   · 表单校验必须拦住会让后端保存失败的输入，同时 alias 模式不按 hostname 校验；
//   · 文案两侧字典键集一致（漏翻会静默显示 key 本身）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTH_MODES,
  URI_SCHEME,
  basenameRemote,
  buildUri,
  dbadge,
  emptyMachineForm,
  formFromMachine,
  joinRemote,
  parseUri,
  statusLine,
  targetFromWorkspace,
  validateMachineForm,
} from '../lib/tui/format.js'
import { createI18n, normalizeLang, TRANSLATIONS } from '../lib/tui/i18n.js'

// ── i18n ──────────────────────────────────────────────────────────────────

test('i18n: zh / en 字典键集完全一致且非空', () => {
  const zhKeys = Object.keys(TRANSLATIONS.zh).sort()
  const enKeys = Object.keys(TRANSLATIONS.en).sort()
  assert.deepEqual(enKeys, zhKeys, '英文缺失的 key 会静默回落到 key 本身')
  for (const lang of ['zh', 'en']) {
    for (const [key, value] of Object.entries(TRANSLATIONS[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key} 必须是字符串`)
      assert.ok(value.trim().length > 0, `${lang}.${key} 不能为空`)
    }
  }
})

test('i18n: 默认中文，显式 en / DSH_TUI_LANG=en 时英文，未知值回落中文', () => {
  assert.equal(createI18n().lang, 'zh')
  assert.equal(createI18n('en').t('title'), 'dsh-remote · remote servers')
  assert.equal(createI18n('en-US').lang, 'en')
  assert.equal(createI18n('zh-CN').lang, 'zh')
  assert.equal(createI18n('fr').lang, 'zh')
  const previous = process.env.DSH_TUI_LANG
  try {
    process.env.DSH_TUI_LANG = 'en'
    assert.equal(createI18n().lang, 'en')
    process.env.DSH_TUI_LANG = 'zh'
    assert.equal(createI18n().lang, 'zh')
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_LANG
    else process.env.DSH_TUI_LANG = previous
  }
  assert.equal(normalizeLang('EN_us'), 'en')
  assert.equal(normalizeLang(''), undefined)
})

test('i18n: 插值替换 {name}，缺失 key 回落到 key 本身', () => {
  const { t } = createI18n('en')
  assert.equal(t('status.connected', { target: 'root@box' }), 'connected · root@box')
  assert.equal(t('menu.unknown-action'), 'menu.unknown-action')
  assert.equal(t('title', { unused: 'x' }), 'dsh-remote · remote servers')
})

// ── URI 编解码 ────────────────────────────────────────────────────────────

test('URI: POSIX / 中文 / 空格路径往返无损', () => {
  const cases = [
    ['m1', '/home/root/project'],
    ['机器-一', '/srv/数据 目录/项目'],
    ['machine id with spaces', '/tmp/a b/c'],
    ['m/1', '/weird/../path'],
  ]
  for (const [machineId, remotePath] of cases) {
    const uri = buildUri(machineId, remotePath)
    assert.ok(uri.startsWith(`${URI_SCHEME}://`), uri)
    // 路径整体编码：URI 里不应出现裸路径分隔符之外的歧义斜杠
    assert.equal(uri.slice(`${URI_SCHEME}://`.length).split('/').length, 2, `${uri} 必须只有机器段和一个路径段`)
    assert.deepEqual(parseUri(uri), { machineId, remotePath })
  }
})

test('URI: Windows 盘符 / UNC 路径往返无损', () => {
  for (const remotePath of ['C:\\work\\proj', 'D:\\Data\\项目', '\\\\server\\share\\x']) {
    const uri = buildUri('win-box', remotePath)
    assert.deepEqual(parseUri(uri), { machineId: 'win-box', remotePath })
  }
  // 手工写出的未编码路径也要能解析（用户从命令行粘贴 dshremote://box/C:\work）
  const parsed = parseUri('dshremote://box/C:\\work')
  assert.equal(parsed.machineId, 'box')
  assert.equal(parsed.remotePath, 'C:\\work')
})

test('URI: 非本 provider / 非法 / 缺路径的 URI 一律 undefined（不抛错）', () => {
  assert.equal(parseUri(''), undefined)
  assert.equal(parseUri('ssh://host/path'), undefined)
  assert.equal(parseUri('dshremote://machine'), undefined)
  assert.equal(parseUri('dshremote:///path'), undefined)
  assert.equal(parseUri('dshremote://machine/'), undefined)
  assert.equal(parseUri('dshremote://m1/%E0%A4%A'), undefined) // 非法 percent-encoding
  assert.equal(parseUri(undefined), undefined)
  assert.deepEqual(parseUri('  DSHREMOTE://m1/%2Fhome  '), { machineId: 'm1', remotePath: '/home' })
})

// ── badge / basename / join ───────────────────────────────────────────────

test('dbadge: 至多 12 个字符（按码点），超长用 … 截断，空名回落 remote', () => {
  assert.equal(dbadge('dev-box'), 'dev-box')
  assert.equal(dbadge(''), 'remote')
  assert.equal(dbadge(undefined), 'remote')
  const long = Array.from('远程服务器开发测试机器名称示例').slice(0, 12).join('')
  assert.equal(Array.from(long).length, 12)
  assert.equal(dbadge(long), long)
  const longer = Array.from(dbadge('abcdefghijklmnop'))
  assert.equal(longer.length, 12)
  assert.equal(longer[11], '…')
  assert.equal(dbadge('中文名').length, 3)
})

test('basenameRemote: POSIX / 尾斜杠 / Windows 盘符 / 根路径', () => {
  assert.equal(basenameRemote('/home/root/proj'), 'proj')
  assert.equal(basenameRemote('/home/root/proj/'), 'proj')
  assert.equal(basenameRemote('C:\\work\\tool'), 'tool')
  assert.equal(basenameRemote('D:/data/x'), 'x')
  assert.equal(basenameRemote('/'), '/')
  assert.equal(basenameRemote(''), '/')
})

test('joinRemote: POSIX 相对 / 上级 / 绝对路径', () => {
  assert.equal(joinRemote('/home/root/proj', 'src'), '/home/root/proj/src')
  assert.equal(joinRemote('/home/root/proj', 'src/deep/../lib'), '/home/root/proj/src/lib')
  assert.equal(joinRemote('/home/root/proj', '..'), '/home/root')
  assert.equal(joinRemote('/home/root/proj/', './x'), '/home/root/proj/x')
  assert.equal(joinRemote('/home/root/proj', '/srv/other'), '/srv/other')
  assert.equal(joinRemote('/', 'srv'), '/srv')
})

test('joinRemote: Windows 盘符相对 / 上级 / 绝对路径', () => {
  assert.equal(joinRemote('C:\\work\\proj', 'src'), 'C:\\work\\proj\\src')
  assert.equal(joinRemote('C:\\work\\proj', 'src\\..\\lib'), 'C:\\work\\proj\\lib')
  assert.equal(joinRemote('C:\\work\\proj', '..'), 'C:\\work')
  assert.equal(joinRemote('C:\\', 'work'), 'C:\\work')
  assert.equal(joinRemote('C:\\work', 'D:\\other'), 'D:\\other')
  assert.equal(joinRemote('\\\\server\\share\\a', 'b'), '\\\\server\\share\\a\\b')
})

// ── target 构造 ───────────────────────────────────────────────────────────

test('targetFromWorkspace: uri / cwd / label / description / kind / badge', () => {
  const target = targetFromWorkspace({
    machine: { id: 'm1', name: 'dev-box', host: '10.0.0.2', port: 22, username: 'root' },
    localMirror: '/home/me/.dsh/remote-workspaces/10.0.0.2-root-22/proj',
    remotePath: '/home/root/proj',
  })
  assert.equal(target.uri, buildUri('m1', '/home/root/proj'))
  assert.equal(target.cwd, '/home/me/.dsh/remote-workspaces/10.0.0.2-root-22/proj')
  assert.equal(target.kind, 'provider')
  assert.equal(target.badge, 'dev-box')
  assert.equal(target.description, 'root@10.0.0.2:/home/root/proj')
  assert.equal(target.label, 'dev-box-proj')
  // 显式 title 优先（ensureRemoteWorkspace 返回的已限定标题）
  assert.equal(targetFromWorkspace({
    machine: { id: 'm1', name: 'dev-box', host: 'h', username: 'u' },
    localMirror: '/mirror',
    remotePath: '/home/u/proj',
    title: 'custom-title',
  }).label, 'custom-title')
  // 无用户名时 description 不带 '@'
  assert.equal(targetFromWorkspace({
    machine: { id: 'm1', host: 'h' }, localMirror: '/mirror', remotePath: '/x',
  }).description, 'h:/x')
  // 缺机器身份 / 缺本地镜像 → undefined（绝不生成不可用 target）
  assert.equal(targetFromWorkspace({ machine: {}, localMirror: '/mirror', remotePath: '/x' }), undefined)
  assert.equal(targetFromWorkspace({ machine: { id: 'm1', host: 'h' }, localMirror: '', remotePath: '/x' }), undefined)
})

// ── 表单校验 ──────────────────────────────────────────────────────────────

function form(overrides = {}) {
  return {
    name: 'dev-box',
    host: '10.0.0.2',
    port: '22',
    username: 'root',
    useSshConfig: false,
    auth: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    group: '',
    ...overrides,
  }
}

test('validateMachineForm: 合法表单无错误，patch 字段齐全', () => {
  const { errors, patch } = validateMachineForm(form({ password: 'pw-abc-123', group: 'lab' }))
  assert.deepEqual(errors, [])
  assert.equal(patch.name, 'dev-box')
  assert.equal(patch.host, '10.0.0.2')
  assert.equal(patch.port, 22)
  assert.equal(patch.username, 'root')
  assert.equal(patch.useSshConfig, false)
  assert.equal(patch.useAgent, false)
  assert.equal(patch.privateKeyPath, '')
  assert.equal(patch.group, 'lab')
  assert.equal(patch.password, 'pw-abc-123')
  assert.equal(patch.passphrase, undefined)
})

test('validateMachineForm: 缺 host / 非法 host / 非法端口', () => {
  assert.deepEqual(validateMachineForm(form({ host: '   ' })).errors, ['form.errHostRequired'])
  assert.deepEqual(validateMachineForm(form({ host: 'bad host' })).errors, ['form.errHostInvalid'])
  assert.deepEqual(validateMachineForm(form({ host: 'ssh://x' })).errors, ['form.errHostInvalid'])
  assert.deepEqual(validateMachineForm(form({ host: 'user@host' })).errors, ['form.errHostInvalid'])
  for (const port of ['0', '65536', '-1', '22a', '1.5']) {
    assert.deepEqual(validateMachineForm(form({ port })).errors, ['form.errPortRange'], `port=${port}`)
  }
  // 空端口 = 默认 22（不是错误）
  assert.deepEqual(validateMachineForm(form({ port: '' })).errors, [])
  assert.equal(validateMachineForm(form({ port: '' })).patch.port, 22)
  assert.equal(validateMachineForm(form({ port: 2202 })).patch.port, 2202)
})

test('validateMachineForm: useSshConfig 模式按 alias 校验、不要求 hostname 形状', () => {
  // alias 可以是带 * 的 ssh 配置模式，hostname 校验会拒绝它
  const alias = validateMachineForm(form({ host: 'lab-*', useSshConfig: true }))
  assert.deepEqual(alias.errors, [])
  assert.equal(alias.patch.useSshConfig, true)
  // 但 alias 仍然是必填的（它是 ~/.ssh/config 的 Host 行）
  assert.deepEqual(validateMachineForm(form({ host: '', useSshConfig: true })).errors, ['form.errHostRequired'])
  // 带空格的 alias 非法
  assert.deepEqual(validateMachineForm(form({ host: 'my alias', useSshConfig: true })).errors, ['form.errAliasInvalid'])
})

test('validateMachineForm: 私钥认证必须有私钥路径；agent 模式置 useAgent', () => {
  assert.deepEqual(
    validateMachineForm(form({ auth: 'key', privateKeyPath: '' })).errors,
    ['form.errKeyPath'],
  )
  const key = validateMachineForm(form({ auth: 'key', privateKeyPath: '/home/me/.ssh/id_ed25519' }))
  assert.deepEqual(key.errors, [])
  assert.equal(key.patch.privateKeyPath, '/home/me/.ssh/id_ed25519')
  assert.equal(key.patch.useAgent, false)
  const agent = validateMachineForm(form({ auth: 'agent', useAgent: true }))
  assert.deepEqual(agent.errors, [])
  assert.equal(agent.patch.useAgent, true)
  assert.deepEqual(validateMachineForm(form({ auth: 'bogus' })).errors, ['form.errAuth'])
})

test('validateMachineForm: name 缺省回落 host、username 缺省 root、id 透传', () => {
  const { errors, patch } = validateMachineForm(form({ name: '   ', username: '', id: 'm-7' }))
  assert.deepEqual(errors, [])
  assert.equal(patch.name, '10.0.0.2')
  assert.equal(patch.username, 'root')
  assert.equal(patch.id, 'm-7')
  // 新增机器不伪造 id
  assert.equal(Object.prototype.hasOwnProperty.call(validateMachineForm(form()).patch, 'id'), false)
})

test('validateMachineForm: password / passphrase 留空不写进 patch（不覆盖已存值）', () => {
  for (const key of ['password', 'passphrase']) {
    const blank = validateMachineForm(form({ id: 'm1', [key]: '' })).patch
    assert.equal(Object.prototype.hasOwnProperty.call(blank, key), false, `${key} 为空时不能写 patch`)
    const filled = validateMachineForm(form({ id: 'm1', [key]: 'x' })).patch
    assert.equal(filled[key], 'x')
  }
})

test('validateMachineForm: 可传入 t 把错误渲染成人类可读文案', () => {
  const { t } = createI18n('en')
  assert.deepEqual(validateMachineForm(form({ host: '' }), t).errors, ['host is required'])
  assert.deepEqual(validateMachineForm(form({ port: 'x' }), t).errors, ['port must be an integer between 1 and 65535'])
})

test('formFromMachine: 认证方式反推、secret 永不预填、端口字符串化', () => {
  const base = { id: 'm1', name: 'dev', host: 'h', port: 2222, username: 'u', password: 'p', passphrase: 'pp' }
  assert.equal(formFromMachine(base).auth, 'password')
  assert.equal(formFromMachine(base).password, '')
  assert.equal(formFromMachine(base).passphrase, '')
  assert.equal(formFromMachine(base).port, '2222')
  assert.equal(formFromMachine({ ...base, useAgent: true }).auth, 'agent')
  assert.equal(formFromMachine({ ...base, privateKeyPath: '/k' }).auth, 'key')
  assert.equal(formFromMachine({}).useSshConfig, false)
  assert.deepEqual(emptyMachineForm(), {
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
  })
})

test('formFromMachine / validateMachineForm: 表单未编辑的机器级字段编辑时原样带回', () => {
  const view = {
    id: 'm1',
    name: 'dev',
    host: '10.0.0.2',
    port: 22,
    username: 'root',
    workspace: '/srv/proj',
    hostKeyMode: 'strict',
    backend: 'openssh',
    sshBinary: '/usr/local/bin/ssh',
    keyboardInteractive: true,
    useSshConfig: false,
  }
  const form = formFromMachine(view)
  assert.equal(form.workspace, '/srv/proj')
  assert.equal(form.hostKeyMode, 'strict')
  assert.equal(form.backend, 'openssh')
  assert.equal(form.sshBinary, '/usr/local/bin/ssh')
  assert.equal(form.keyboardInteractive, true)

  const { errors, patch } = validateMachineForm(form)
  assert.deepEqual(errors, [])
  assert.equal(patch.workspace, '/srv/proj')
  assert.equal(patch.hostKeyMode, 'strict')
  assert.equal(patch.backend, 'openssh')
  assert.equal(patch.sshBinary, '/usr/local/bin/ssh')
  assert.equal(patch.keyboardInteractive, true)

  // 调用方没提供这些键时（例如对话框降级流程），patch 不写它们 → 宿主“省略=保留”。
  const minimal = validateMachineForm({ host: 'h', auth: 'password' }).patch
  for (const key of ['workspace', 'hostKeyMode', 'backend', 'sshBinary', 'keyboardInteractive']) {
    assert.equal(Object.prototype.hasOwnProperty.call(minimal, key), false, `${key} 不应写入最小 patch`)
  }
})

test('AUTH_MODES: 与认证方式文案键一一对应', () => {
  for (const mode of AUTH_MODES) {
    assert.ok(TRANSLATIONS.zh[`auth.${mode}`], `缺少 auth.${mode} 文案`)
  }
  assert.deepEqual([...AUTH_MODES], ['password', 'key', 'agent'])
})

// ── 状态行 ────────────────────────────────────────────────────────────────

test('statusLine: 已连接 / 未连接 / 无状态', () => {
  const { t } = createI18n('zh')
  assert.equal(
    statusLine({ host: '10.0.0.2', username: 'root', connected: true }, t),
    '已连接 root@10.0.0.2',
  )
  assert.equal(
    statusLine({ host: '10.0.0.2', username: 'root', connected: false }, t),
    '未连接 · root@10.0.0.2',
  )
  assert.equal(statusLine(null, t), '未连接远程机')
  assert.equal(statusLine({ connected: false }, t), '未连接远程机')
  // 默认渲染器为中文
  assert.equal(statusLine({ host: 'h', connected: true }), '已连接 h')
})
