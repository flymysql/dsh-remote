// 更新模式默认值的契约。
//
// 为什么值得单独一条测试：默认值出现在**三个**地方（schema 默认、/update-check
// 响应、auto 更新的开关判断），第一版改动就漏了两个 `|| 'manual'` 兜底——
// 结果是"schema 说 auto、实际行为还是 manual"这种最难查的不一致。
// 这里把"默认必须是 auto"和"三层优先级"都钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const indexSrc = readFileSync(path.join(root, 'lib', 'main.js'), 'utf8')
const clientSrc = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

test('the update default is a single exported constant set to auto', () => {
  assert.match(indexSrc, /export const DEFAULT_UPDATE_MODE = 'auto'/)
})

test('the schema default uses the constant, not a literal', () => {
  // A literal here is how the drift started.
  assert.match(indexSrc, /updateMode: z\.string\(\)\.default\(DEFAULT_UPDATE_MODE\)/)
  assert.doesNotMatch(indexSrc, /updateMode: z\.string\(\)\.default\('(?!DEFAULT)/)
})

test('no code path falls back to a hard-coded manual', () => {
  // `|| 'manual'` / `: 'manual'` after the default moved to auto would make the
  // behaviour contradict the schema — exactly the bug this guards.
  const offenders = indexSrc
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\|\|\s*'manual'/.test(line) || /:\s*'manual'/.test(line))
    .filter(({ line }) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  assert.deepEqual(offenders, [], `hard-coded manual fallback at line(s): ${offenders.map(o => o.n).join(', ')}`)
})

test('the auto-update gate reads the shared default', () => {
  // The gate decides whether the interval runs at all; if it kept its own
  // default it would never enable auto for a profile that omits updateMode.
  assert.match(indexSrc, /const rawMode = readUpdateMode\(\) \|\| config\.updateMode \|\| DEFAULT_UPDATE_MODE/)
  assert.match(indexSrc, /includes\(rawMode\) \? rawMode : DEFAULT_UPDATE_MODE/)
})

test('the settings panel starts from auto so it cannot flash manual', () => {
  assert.match(clientSrc, /useState\('auto'\)/)
})

test('the registry-check watchdog timer is unref-ed', () => {
  // 回归：fetchLatestVersion 的 8s 超时定时器一开始没有 unref，于是任何"挂载后
  // 就空闲"的进程都会被它拖住——实测表现为 upload.test.js 永久挂起
  // （npm test 超时 420s）。看门狗计时器不该决定进程寿命。
  const updateSrc = readFileSync(path.join(root, 'lib', 'update.js'), 'utf8')
  for (const name of ['async function fetchNpmLatestVersion', 'export async function fetchRelease']) {
    const fn = updateSrc.slice(updateSrc.indexOf(name))
    const body = fn.slice(0, fn.indexOf('\n}'))
    assert.match(body, /setTimeout\(\(\) => controller\.abort\(/, 'the source query must remain time-bounded')
    assert.match(body, /timer\.unref(?:\?\.)?\(/, 'query watchdogs must not keep the event loop alive')
  }
})

test('every test that mounts the real plugin pins the update mode', () => {
  // 回归：默认改成 auto 后，任何调用 apply() 却不指定 updateMode 的测试都会启动
  // 更新定时器与一次真实网络检查。测试必须显式声明它要的模式。
  const dir = path.join(root, 'test')
  const offenders = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.test.js')) continue
    const s = readFileSync(path.join(dir, f), 'utf8')
    // only flag files that import the host half (and can therefore run apply) —
    // static AND dynamic import (search-cancel.test.js mounts via a cache-busting
    // dynamic import and used to slip past the static-only pattern, dialing the
    // real saved machine on the developer's box).
    if (!/from '\.\.\/lib\/index\.js'/.test(s) && !/import\(\s*['"]\.\.\/lib\/index\.js/.test(s)) continue
    if (!/\bapply\s*\(/.test(s)) continue
    if (!/updateMode/.test(s)) offenders.push(f)
  }
  assert.deepEqual(offenders, [], `these tests mount the plugin without pinning updateMode: ${offenders.join(', ')}`)
})
