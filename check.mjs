// dsh-remote 部署前闸门（Pre-deploy gate）
//
// 在 ./sync.sh 部署前运行，拦截会"把自己搞崩"的源码问题。历史教训：
// v0.6.1 曾把 slash 命令命名为 `remote.forget-key`，而 dsh-commands 框架
// 硬校验命令名必须匹配 /^[a-z][a-z0-9_-]*$/u（不允许点号/大写/空格），
// 导致插件树加载失败、整个 DSH Desktop 无法启动，直到手工修复。
//
// 本脚本是纯文本静态检查（不 import 模块，无需依赖即可运行），只查那些
// 违反会让 boot 崩溃的"框架注册约束"。语法问题由 node --check 兜底，
// 真正的启动冒烟测试见 scripts/boot-smoke.sh。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'lib', 'index.js'), 'utf8').replace(/\r\n/g, '\n')
const file = path.relative(process.cwd(), path.join(here, 'lib', 'index.js'))

let fail = 0

// ── 1) slash 命令名必须匹配 dsh-commands 的约束 ───────────────────────────
// 依据：安装框架 @deepseek-ai/dsh-commands lib/index.js normalizeDefinition()
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u
const regRe = /commands\.register\(\s*\{[\s\S]*?\bname:\s*'([^']+)'/g
let m, total = 0
while ((m = regRe.exec(src))) {
  total++
  if (!COMMAND_NAME.test(m[1])) {
    fail++
    console.log(`  ✗ ${file}:${lineOf(src, m.index)}: command name '${m[1]}' must match ${COMMAND_NAME} (no dots/uppercase/spaces)`)
  }
}
console.log(`  command-name lint: ${total} register(s) checked`)

// ── 2) 常见 boot 崩溃点：禁止点号注册名（其它 register 也套同正则，防类名误用）──
const otherRe = /\.register\(\{\s*name:\s*'([^']*)'[\s\S]*?\b(?:route|event|service)\b/g
while ((m = otherRe.exec(src))) {
  if (!COMMAND_NAME.test(m[1])) {
    fail++
    console.log(`  ✗ ${file}:${lineOf(src, m.index)}: suspicious dotted/illegal registration name '${m[1]}'`)
  }
}

// ── 3) 工具名必须 rw_ 前缀（避免与内置工具命名空间冲突）──────────────────
const TOOL_NAME = /^rw_[a-z][a-z0-9_]*$/u
const toolRe = /defineTool\(\{\s*name:\s*'([^']+)'/g
let tTotal = 0
while ((m = toolRe.exec(src))) {
  tTotal++
  if (!TOOL_NAME.test(m[1])) {
    fail++
    console.log(`  ✗ ${file}:${lineOf(src, m.index)}: tool name '${m[1]}' must match ${TOOL_NAME}`)
  }
}
console.log(`  tool-name lint: ${tTotal} defineTool(s) checked`)

// ── 4) JSON 路由必须挂在 /dsh-remote/ 前缀下（防路由命名漂移）─────────────
const ROUTE_PREFIX = /^\/dsh-remote\//u
const routeRe = /path:\s*'(\/[^']*)'/g
let rTotal = 0
while ((m = routeRe.exec(src))) {
  rTotal++
  if (!ROUTE_PREFIX.test(m[1])) {
    fail++
    console.log(`  ✗ ${file}:${lineOf(src, m.index)}: route path '${m[1]}' must start with /dsh-remote/`)
  }
}
console.log(`  route-prefix lint: ${rTotal} route(s) checked`)

// ── 5) defineTool 参数里 type:'object' 必须显式 additionalProperties ──────
// 依据：@deepseek-ai/dsh-tools runSchemaCompiler() case "object"：
//   没有显式 boolean additionalProperties 直接 authorError，导致插件树加载失败
//   （用户 dsh 0.1.0-rc.8 启动崩溃，issue #9）。只在 defineTool({...}) 参数块内检查。
const toolBlocks = [...src.matchAll(/defineTool\(\{[\s\S]*?\n    \}\)/g)].map(m => m[0])
let sTotal = 0
for (const toolBlock of toolBlocks) {
  const paramsMatch = toolBlock.match(/parameters:\s*\{([\s\S]*?)\n      \},\n      output:/)
  if (!paramsMatch) continue
  const paramsBody = paramsMatch[1]
  for (const m of paramsBody.matchAll(/type:\s*'object'/g)) {
    sTotal++
    const lineNo = lineOf(src, m.index + src.indexOf(toolBlock))
    if (!/additionalProperties:\s*(?:true|false)/.test(paramsBody)) {
      fail++
      console.log(`  ✗ ${file}:${lineNo}: type:'object' param must declare additionalProperties: true|false`)
    }
  }
}
if (sTotal) console.log(`  object-schema lint: ${sTotal} type:'object' param(s) checked`)
else console.log('  object-schema lint: no type:\'object\' params found')

function lineOf(text, idx) {
  return text.slice(0, idx).split('\n').length
}

if (fail) {
  console.error(`\ncheck.mjs FAILED: ${fail} problem(s). 修复后再部署。`)
  process.exit(1)
}
console.log('check.mjs OK: no framework-constraint violations.')
