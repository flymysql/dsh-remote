// GitHub Pages 站点的中文优先与事实一致性闸门。
//
// 为什么需要：
//   1) 需求是"Pages 优先显示中文"。这件事必须在**页面骨架**里成立（无脚本、
//      无 localStorage 时首屏就是中文），而不是靠脚本注入——否则会闪英文。
//      我实现时踩过一个真缺陷：applyLang 对含子 data-zh 的容器也整体写 innerHTML，
//      把子 span 连属性一起抹掉，表现为"切一次语言后标题永久卡住"。
//   2) 站点是面向用户的文档，等于第二份"产品说明"，会和代码漂移。实测已经漂移过：
//      工具名写了 4 个不存在的（rw_workspace/rw_list/rw_read/rw_write），
//      auditLog 的默认值写成 false（真源是 true）。这些正是用户照着做的内容。
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { DEFAULT_EXCLUDED_DIRECTORIES } from '../lib/file-reference.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

const PAGES = ['docs/index.html', 'docs/stats/index.html']

/** 去掉 <script>/<style>，只留页面骨架（脚本注入的内容不算"骨架是中文"）。 */
const skeleton = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')

/** 取所有 data-zh="..." 的值。 */
const zhAttrs = (html) => [...html.matchAll(/data-zh="((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
const enAttrs = (html) => [...html.matchAll(/data-en="((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])

test('every page declares Chinese as its document language', () => {
  for (const p of PAGES) {
    const html = read(p)
    assert.match(html, /<html lang="zh-CN">/, `${p} must declare lang="zh-CN" (Chinese is the priority)`)
  }
})

test('the page skeleton is already Chinese, not injected by script', () => {
  // 关键的"优先中文"判据：把 <script> 全部去掉后，骨架里必须有足量中文。
  // 如果中文只存在于 data-zh 属性里、正文是英文，那么禁用 JS 或首帧就会闪英文。
  for (const p of PAGES) {
    const body = skeleton(read(p))
    const zh = (body.match(/[\u4e00-\u9fa5]/g) || []).length
    assert.ok(zh > 300, `${p}: skeleton should already be Chinese (found ${zh} CJK chars)`)
  }
})

test('every data-zh has a matching data-en and vice versa', () => {
  for (const p of PAGES) {
    const html = read(p)
    const zh = zhAttrs(html)
    const en = enAttrs(html)
    assert.equal(zh.length, en.length, `${p}: ${zh.length} data-zh vs ${en.length} data-en`)
    // 顺序也必须一一对应，否则切换语言会把句子配错
    const zhSeq = [...html.matchAll(/data-(zh|en)="/g)].map((m) => m[1])
    for (let i = 0; i < zhSeq.length; i += 2) {
      assert.equal(zhSeq[i], 'zh', `${p}: expected data-zh at pair ${i / 2}, got ${zhSeq[i]}`)
      assert.equal(zhSeq[i + 1], 'en', `${p}: expected data-en at pair ${i / 2}, got ${zhSeq[i + 1]}`)
    }
  }
})

test('the language switcher only rewrites leaf nodes', () => {
  // 回归：容器（内部还含 data-zh 子元素）若被整体写 innerHTML，会连子元素与其
  // data-* 属性一起抹掉 —— 实测表现为"点一次 EN 后标题永久卡在英文"。
  for (const p of PAGES) {
    const html = read(p)
    const fn = html.slice(html.indexOf(p === 'docs/index.html' ? 'function setLang' : 'function applyLang'))
    assert.match(fn, /if\s*\(el\.querySelector\('\[data-zh\]\[data-en\]'\)\)\s*continue/,
      `${p}: applyLang must skip containers that hold their own data-zh children`)
  }
})

test('Chinese is the default when there is no stored preference', () => {
  for (const p of PAGES) {
    const html = read(p)
    // 默认值必须是 'zh'：只有显式存过 'en' 才用英文
    assert.match(html, /let (?:LANG|lang)\s*=\s*'zh'/, `${p}: the default language variable must be 'zh'`)
    assert.match(html, /===\s*'en'\s*\?\s*'en'\s*:\s*'zh'/, `${p}: only an explicit stored 'en' may switch to English`)
  }
})

test('documented rw_* tool names all exist in the plugin', () => {
  // 实测漂移过：站点列了 rw_workspace / rw_list / rw_read / rw_write（都不存在，
  // 真名是 rw_pick_workspace / rw_list_dir / rw_read_file / rw_write_file）。
  const indexSrc = read('lib/index.js')
  const real = new Set([...indexSrc.matchAll(/name:\s*'(rw_[a-z_]+)'/g)].map((m) => m[1]))

  const documented = new Set()
  for (const p of [...PAGES, 'README.md', 'README.en.md', 'docs/reference.zh.md', 'docs/reference.en.md']) {
    for (const m of read(p).matchAll(/(?:<code>|`)(rw_[a-z_]+)(?:<\/code>|`)/g)) documented.add(m[1])
    // 正文里的 `N 个 rw_* 工具` / `N rw_* tools` 也是要维护的断言，而且比工具
    // 列表更容易漏改（列了工具却没改数字，读者会以为少了工具）。所以把页面里
    // 出现的每个计数都拿来跟真实数量比对，而不是在这里硬编码一个数字 ——
    // 硬编码的数字只能证明"作者当时改过测试"，证明不了文档是对的。
    for (const m of read(p).matchAll(/(\d+)\s*(?:个\s*<code>rw_|<code>rw_|个 rw_| rw_)/g)) {
      const claimed = Number(m[1])
      // 只认显然是在说 rw_* 数量的那些数字（避免把别的计数误判）。
      if (claimed >= 5 && claimed <= 200) {
        assert.equal(claimed, real.size,
          `${p}: 页面声称 ${claimed} 个 rw_* 工具，实际 ${real.size} 个`)
      }
    }
  }
  const ghosts = [...documented].filter((n) => !real.has(n))
  assert.deepEqual(ghosts, [], `pages document rw_* tools that do not exist: ${ghosts.join(', ')}`)

  // 反过来：每个真实工具都应该被站点列出来（漏列等于少一个卖点）。
  const missing = [...real].filter((n) => !documented.has(n))
  assert.deepEqual(missing, [], `pages omit real rw_* tools: ${missing.join(', ')}`)
})

test('dashboard shows current-day reports, including a real zero, without borrowing old nonzero data', () => {
  const html = read('docs/stats/index.html')
  const expression = html.match(/const shown = ([^\n]+)/)?.[1]
  assert.ok(expression, 'DAU selection must exist')
  const select = (daily) => runInNewContext(expression, { daily, todayKey: '2026-11-14' })
  assert.equal(select([{ day: '2026-11-13', dau: 50 }, { day: '2026-11-14', dau: 0 }]).dau, 0)
  assert.equal(select([{ day: '2026-11-14', dau: 12 }]).dau, 12)
  assert.equal(select([{ day: '2026-11-12', dau: 50 }, { day: '2026-11-13', dau: 0 }]).day, '2026-11-13')
  assert.equal(select([]), undefined)
  assert.match(html, /进行中/, 'dashboard must label an in-progress day')
})

test('the homepage reads live numbers from the snapshot first', () => {
  // registry.npmjs.org 在浏览器里可能被拦（实测 Failed to fetch，版本号显示 "—"）。
  // 因此同源快照必须是主路径，直连只能是兜底。
  const home = read('docs/index.html')
  const snapAt = home.indexOf("fetch('./data/stats.json')")
  const regAt = home.indexOf("fetch('https://registry.npmjs.org/dsh-remote/latest')")
  assert.ok(snapAt > -1, 'homepage must read the same-origin snapshot')
  assert.ok(regAt > snapAt, 'registry refresh follows the snapshot and may not delay the initial value')
  assert.match(home, /if\(snapshot\.npm\?\.latest\)version\.textContent=snapshot\.npm\.latest/)

})

test('the snapshot generator records npm.latest', () => {
  // 页面依赖这个字段把版本徽章填上；脚本不写它，兜底分支就永远不会生效。
  const gen = read('scripts/snapshot-stats.mjs')
  assert.match(gen, /out\.latest\s*=/, 'snapshot must record npm.latest for the pages to read')
})

test('config defaults shown on the site match the schema', () => {
  // 站点上的默认值是用户照着配的依据，必须与 lib/index.js 的 Config schema 一致。
  // 实测漂移过：auditLog 写成 false（真源 true）。
  const schema = read('lib/index.js')
  const block = schema.slice(schema.indexOf('export const Config'), schema.indexOf('\n})', schema.indexOf('export const Config')))
  const declared = {}
  for (const m of block.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*z\.[\s\S]*?\.default\(([^)]*)\)/gm)) {
    declared[m[1]] = m[2].trim()
  }

  const home = read('docs/reference.zh.md')
  const rows = [...home.matchAll(/^\| `([a-zA-Z][a-zA-Z0-9]*)` \| [^|]+ \| (?:`([^`]+)`|([^|]+)) \|/gm)]
    .map((m) => [m[1], (m[2] ?? m[3]).trim().replace(/（[^）]*）/g, '')])

  assert.ok(rows.length >= 5, `expected the reference config table to have rows, found ${rows.length}`)

  // 有些默认值是常量引用（updateMode → DEFAULT_UPDATE_MODE），要解析到真实值，
  // 否则测试会误报"文档写了 auto 而 schema 是 DEFAULT_UPDATE_MODE"。
  const consts = {}
  for (const m of schema.matchAll(/export const ([A-Z_]+) = '([^']*)'/g)) consts[m[1]] = m[2]

  for (const [key, shown] of rows) {
    if (shown === '—') continue // no scalar default (for example the proxy object)
    if (!(key in declared)) continue // 只校验确实存在于 schema 的键
    const norm = (s) => String(s).replace(/['"]/g, '').trim()
    const raw = norm(declared[key])
    const resolved = raw === "[...DEFAULT_EXCLUDED_DIRECTORIES]" ? "[" + DEFAULT_EXCLUDED_DIRECTORIES.join(", ") + "]" : consts[raw] ?? raw
    // 站点对 6h / 200000 这类做了人类可读化，允许这两种等价写法
    const equivalents = { '6 * 3600 * 1000': '21600000', '200000': '200000' }
    const expected = equivalents[resolved] ?? resolved
    assert.equal(norm(shown), expected,
      `docs/index.html shows ${key}=${shown} but the schema default resolves to ${expected}`)
  }
})
