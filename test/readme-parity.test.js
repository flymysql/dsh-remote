// README 双语一致性闸门。
//
// 为什么需要它：README.md（中文）与 README.en.md（英文）是**面向不同读者的同一份
// 承诺**，但它们历史上已经漂移过——英文版缺 `passphrase`/`maxOutputChars`，
// 两版对 `rw_search` 的实现描述互相矛盾（一个说"SFTP 遍历"，真源是
// "rg → grep -R → SFTP 回退"），中文版还缺整张配置表的部分行。
// 人工同步会持续腐坏，所以把"必须一致"的部分交给机器检查。
//
// 需要一致的三类东西：
//   1) 章节骨架（`##` 标题的**数量**与顺序位置）——防止一边漏了一整节；
//   2) 配置表的键集合——两个表的行数/键必须完全相同；
//   3) 工具清单——`rw_*` 名字集合必须相同。
// 刻意**不**检查正文措辞（中英表达本就不同），那会逼出为了过测而写的僵硬文案。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const zh = readFileSync(path.join(root, 'README.md'), 'utf8')
const en = readFileSync(path.join(root, 'README.en.md'), 'utf8')

/** 提取所有二级标题的文本（去掉尾部空白）。 */
const h2 = (src) => src.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.trim())

/** 提取 markdown 表格第一列的反引号键（`key`），只取配置表那一段。 */
function tableKeys(src) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => /^\|\s*(键|Key)\s*\|/.test(l))
  if (start < 0) return []
  const keys = []
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('|')) break
    const m = line.match(/^\|\s*`([^`]+)`\s*\|/)
    if (m) keys.push(m[1])
  }
  return keys
}

/** 正文里出现的全部 `rw_*` 工具名。 */
const tools = (src) => {
  const found = new Set()
  for (const m of src.matchAll(/`(rw_[a-z_]+)/g)) found.add(m[1])
  return [...found].sort()
}

test('both READMEs exist with the expected bilingual pairing', () => {
  // 语言切换行必须互指，且指向真实存在的文件
  assert.match(zh, /\[English\]\(\.\/README\.en\.md\)/, 'Chinese README must link to README.en.md')
  assert.match(en, /\[中文\]\(\.\/README\.md\)/, 'English README must link to README.md')
  // 防止有人把语言切回旧文件名
  assert.doesNotMatch(zh, /\(\.\/README\.zh\.md\)/)
})

test('README.zh.md is only a redirect stub', () => {
  const stub = readFileSync(path.join(root, 'README.zh.md'), 'utf8')
  assert.ok(stub.length < 1200, 'the zh stub must not grow back into a full README')
  assert.match(stub, /\.\/README\.md/, 'the stub must point readers at the main README')
})

test('section skeletons match in count and order', () => {
  const a = h2(zh)
  const b = h2(en)
  assert.equal(a.length, b.length, `section count differs:\n  zh: ${a.length}\n  en: ${b.length}`)
})

test('each section is paired by position, not merely equal in count', () => {
  // 只用数量相等是不够的：把某个小节的内容整体搬到另一节，两个文件仍然"各 14 节"，
  // 读者却会看到中英结构错位。这里按位置显式声明配对，任何新增/删除/换序都要
  // 在这里同步更新，从而无法悄悄漂移。
  const PAIRS = [
    ['界面预览', 'Screen previews'],
    ['功能', 'Features'],
    ['安装', 'Install'],
    ['快速上手', 'Quick start'],
    ['在本地打开远程机器上的 DSH 界面', 'Open a remote machine\'s DSH Web UI locally'],
    ['可选：CLI 默认机', 'CLI defaults (optional)'],
    ['常用命令（安装 / 查看 / 启动）', 'CLI quick reference'],
    ['开发（沙箱优先，勿改产品）', 'Development (sandbox, not product)'],
    ['配置', 'Configuration'],
    ['常见问题 / 排查', 'FAQ / troubleshooting'],
    ['安全提醒', 'Safety'],
    ['License', 'License'],
    ['参与贡献', 'Contributing'],
    ['变更记录', 'Changelog'],
  ]
  const a = h2(zh).map((s) => s.replace(/^##\s+/, ''))
  const b = h2(en).map((s) => s.replace(/^##\s+/, ''))
  assert.deepEqual(a, PAIRS.map((p) => p[0]), 'Chinese section order changed — update PAIRS deliberately')
  assert.deepEqual(b, PAIRS.map((p) => p[1]), 'English section order changed — update PAIRS deliberately')
})

test('the configuration tables declare the same keys', () => {
  const a = tableKeys(zh)
  const b = tableKeys(en)
  assert.ok(a.length > 20, `config table looks empty (zh=${a.length})`)
  assert.deepEqual(a, b, 'config keys must match between README.md and README.en.md')
})

test('every config key documented in the table exists in the schema', () => {
  // 反向核对：文档不能发明配置项，也不能在被删除后留下幽灵行。
  const schema = readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
  const start = schema.indexOf('export const Config')
  const block = schema.slice(start, schema.indexOf('\n})', start))
  const declared = new Set([...block.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map((m) => m[1]))
  const documented = new Set(tableKeys(zh))
  const ghosts = [...documented].filter((k) => !declared.has(k))
  assert.deepEqual(ghosts, [], `documented but not in the Config schema: ${ghosts.join(', ')}`)
})

test('both READMEs list the same rw_* tools', () => {
  assert.deepEqual(tools(zh), tools(en), 'tool lists must agree')
  // Compare against the PLUGIN, not a hardcoded number. A literal here only
  // proves the author updated the test when it bothered them; comparing to the
  // registered tools proves the docs are actually right.
  const src = readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
  const real = [...new Set([...src.matchAll(/name:\s*'(rw_[a-z_]+)'/g)].map((m) => m[1]))].sort()
  assert.deepEqual([...tools(zh)].sort(), real,
    'the README tool list must match the tools the plugin registers')
})

test('the DSH compatibility section is present in both', () => {
  // 0.8.29 修的正是"整包被丢弃"，这是用户最容易困惑的故障，必须双语都有。
  assert.match(zh, /DSH 版本兼容性/)
  assert.match(en, /DSH version compatibility/)
  assert.match(zh, /0\.8\.29/)
  assert.match(en, /0\.8\.29/)
})

test('the READMEs carry no telemetry section', () => {
  // 用户要求从 README 与 npm 介绍里移除遥测说明（npm 页面渲染的就是 README.md）。
  // 这条守卫把"移除"钉住，防止它被重新加回来——历史上一度有两份（英文版还被
  // 误插过整段中文），正是那种漂移让这节越来越长。
  //
  // 注意：这**不是**在否认遥测存在。插件仍会发送匿名心跳，实现与隐私边界在
  // lib/telemetry.js 的顶部注释里（那里才是改动者该读的地方）。
  for (const [name, src] of [['README.md', zh], ['README.en.md', en]]) {
    assert.doesNotMatch(src, /^##\s*数据采集\s*\/\s*遥测\s*$/m, `${name} must not carry a telemetry section`)
    assert.doesNotMatch(src, /^##\s*Data collection\s*\/\s*telemetry\s*$/m, `${name} must not carry a telemetry section`)
    // 也不应留下孤立的字段表/短语文案（删了标题忘了正文的典型残留）
    assert.doesNotMatch(src, /HMAC-SHA256\('dsh-remote\/telemetry\/v1'/, `${name} must not keep the telemetry field table`)
    assert.doesNotMatch(src, /<!--中文-->/, `${name} must not carry a leftover language-duplicate marker`)
  }
})

test('the English README has no untranslated Chinese prose', () => {
  // 回归：上一轮精简时，英文版「FAQ / troubleshooting」的**正文**整段还是中文
  // （标题已英文化，所以只查标题的守卫抓不到）。这条按行扫描正文，
  // 超过阈值的中文即视为漏译。
  //
  // 允许保留的例外：
  //   · 界面里真实存在的中文标签（翻译掉反而误导用户）；
  //   · 页眉里指向中文 README 的语言切换链接文字（"中文说明"）——它本就是在
  //     告诉英文读者"中文版在那边"，翻成英文反而失去意义。
  const ALLOWED_UI_LABELS = ['远程工作区', '设为远程工作区', '保存到远程', '测试连接', '浏览', '本机', '远程', '此电脑', '回上一级', '新建目录', '加密保存密码', '中文说明', '手动添加', '打开日志文件', '在文件夹中显示']
  const CJK_RUN = /[\u4e00-\u9fa5]{4,}/g

  const offenders = []
  en.split('\n').forEach((line, i) => {
    // 跳过代码块里的中文（示例命令、配置注释）与纯链接
    if (/^\s*[`|]/.test(line)) return
    for (const m of line.match(CJK_RUN) || []) {
      if (ALLOWED_UI_LABELS.some((label) => m.includes(label))) continue
      offenders.push(`L${i + 1}: ${m}`)
    }
  })
  assert.deepEqual(offenders, [],
    `untranslated Chinese prose in README.en.md (translate it, or add the label to ALLOWED_UI_LABELS if it is a real UI string):\n  ${offenders.join('\n  ')}`)
})
