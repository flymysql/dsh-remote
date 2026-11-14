// dsh-remote — 安装级心跳（日活统计）。
//
// 目的：npm 下载量只能证明"有人下载"，GitHub clone 里混着 CI 与爬虫，
// 都无法回答"多少人真的在用、用的是哪一版、留在哪个平台"。这里上报一个
// **最小字段的心跳**，让作者能算出去重日活 / 版本分布 / 平台分布 / 留存。
//
// ── 隐私边界（改这个文件前先读）──────────────────────────────────────────
// 1) 上报的是伪名：`idHash = HMAC-SHA256(SALT, installId)[:32]`。
//    原始 installId **绝不出机器**，服务端拿到的是本插件专属伪名，
//    无法与其他数据交叉关联（installId 本身是随机 UUID，不含任何机器信息）。
// 2) installId 存在 `<DSH_HOME>/.dsh-remote-install-id`，**不在插件目录**：
//    插件目录会被 pnpm 重装覆盖，放在那里会让同一台机器每次升级都换身份，
//    把 1 个人算成 N 个。DSH_HOME 跨重装稳定。
// 3) 字段白名单固定为 {idHash, version, platform, arch, node}。
//    本插件能拿到 SSH 主机、路径、机器列表——**这些一律不上报**。
//
// ── 失败策略 ─────────────────────────────────────────────────────────────
// 全程静默：任何异常（网络不可达、磁盘只读、端点变更）都只吞掉，
// 绝不阻塞加载、绝不写日志噪音、绝不重试轰炸。心跳是"尽力而为"，
// 它失败不能影响用户任何真实功能。

import { createHmac, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** 上报端点（Cloudflare Worker）。改域名只需改这一行。
 *  可用 `DSH_REMOTE_HEARTBEAT_URL` 覆盖——存在的理由不是"让用户改"
 *  （默认行为不该需要配置），而是：① 测试必须能把它重定向掉，
 *  否则跑一次 npm test 就会往生产统计里灌假装机（发生过）；
 *  ② 作者换端点/灰度时不必为了改一行字符串发一次版。 */
const DEFAULT_HEARTBEAT_URL = 'https://dsh-remote-heartbeat.flymysql.workers.dev/dsh-hb/heartbeat'

/** 解析实际使用的端点（env 覆盖优先，仅接受 https，避免被降级到明文）。 */
export function heartbeatUrl() {
  const override = process.env.DSH_REMOTE_HEARTBEAT_URL
  if (override && /^https:\/\//i.test(override)) return override
  return DEFAULT_HEARTBEAT_URL
}
/** 伪名盐：服务端无法反推身份，且换盐即可切断历史关联。 */
const SALT = 'dsh-remote/telemetry/v1'
const ID_FILE = '.dsh-remote-install-id'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 上报超时：心跳是旁路，不能拖慢启动；但也不能太短 —— 实测端点本身
 *  250~520ms，而 **DSH 启动瞬间的并发初始化会把首帧 fetch 饿到 5s 以上**
 *  （曾以 5s 超时稳定失败在首启，靠下次启动才补上，等于丢掉当天最早的那批用户）。
 *  15s 覆盖启动抖动，且因为不 await，慢也不会影响加载。 */
const TIMEOUT_MS = 15000
/** 启动后延迟多久再发：避开启动高峰（插件树/路由/服务都在抢事件循环）。
 *  仍不 await——延迟是为了让心跳真的成功，不是为了让用户等待。 */
const STARTUP_DELAY_MS = 3000
/** 每 15 分钟检查是否跨日或需要重试；成功后当天不再发送。 */
const CHECK_INTERVAL_MS = 15 * 60 * 1000

/** 安装身份的进程内缓存，**按身份文件路径分键**。
 *  ★ 不能只用一个全局变量：同一进程内出现第二个 DSH_HOME（隔离沙箱、
 *  测试夹具、desktop 与 cli 并存）时会串号，把 A 的 id 当成 B 的，
 *  日活与装机量一起失真。DSH 官方的 anonymous-user-id 同样是按路径 memo。 */
const idCache = new Map()

/**
 * 读取或创建本安装的随机身份（稳定 UUID，存 DSH_HOME）。
 * 磁盘只读等异常时返回内存生成的临时身份：日活会多算一次，但绝不报错。
 * @param home - DSH_HOME 绝对路径。
 */
export function installId(home) {
  const file = path.join(home, ID_FILE)
  const cached = idCache.get(file)
  if (cached) return cached

  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (UUID_RE.test(existing)) {
      idCache.set(file, existing)
      return existing
    }
  } catch { /* 不存在或不可读 → 下面创建 */ }
  const created = randomUUID()
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(file, `${created}\n`, 'utf8')
  } catch { /* 只读也不影响本次运行 */ }
  idCache.set(file, created)
  return created
}

/** 稳定的匿名伪名（32 位 hex）。原始 id 不离开本进程。 */
export function pseudonym(home) {
  return createHmac('sha256', SALT).update(installId(home)).digest('hex').slice(0, 32)
}

/** 与服务端一致，按北京时间分日；隔离不同 DSH_HOME 的节流和并发状态。 */
const reports = new Map()
function heartbeatDay() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 是否处于测试进程。
 *
 *  ★ 这是一道**代码级**兜底，不是便利设施。事故背景：光靠 package.json 里的
 *  `--import ./test/setup-telemetry-off.mjs` 前置不够——它只覆盖 `npm test`，
 *  任何人直接 `node --test test/upload.test.js` 就会绕过它，而 upload.test.js
 *  会调用真实 apply()，于是**线上日活表被写进来自测试的假装机**
 *  （实测：直接跑一次，云端立刻多一行；曾出现"只用过 Windows 的机器冒出 Linux 装机"）。
 *
 *  Node 的测试运行器会在**子进程**里设 `NODE_TEST_CONTEXT`（如 child-v8），
 *  父进程可能没有，所以同时看父进程的 `--test` 参数。判定为真时直接不发。
 *  代价：测试里也就无法验证"真的发出去了"——那正是本函数要保证的，
 *  真机端到端请用隔离沙箱启动真实 DSH（README 有说明）。
 */
export function inTestProcess() {
  if (process.env.NODE_TEST_CONTEXT) return true
  const execArgv = process.execArgv || []
  if (execArgv.some((a) => a === '--test' || String(a).startsWith('--test-'))) return true
  return false
}

/**
 * 真正执行发送（不含"是否处于测试进程"的守卫）。
 *
 * 拆出来的原因：守卫本身必须可测，而"能测"又不能变成生产代码的后门——
 * 所以守卫只存在于 {@link sendHeartbeat} 里，本函数只被它与测试直接调用，
 * 且**不导出给业务代码**（导出名带下划线前缀，见文件末尾）。
 */
async function deliver(home, version, options = {}) {
  const key = path.resolve(home)
  const previous = reports.get(key)
  if (previous?.pending || previous?.day === heartbeatDay()) return false
  const allowed = () => !options.signal?.aborted && (!options.allowed || options.allowed())
  const state = { pending: true }
  reports.set(key, state)
  try {
    if (!allowed()) return false
    const delayMs = options.delayMs === undefined ? STARTUP_DELAY_MS : Math.max(0, options.delayMs)
    // 短启动延迟保活，卸载时可取消；周期检查本身不保持进程存活。
    if (delayMs) await delay(delayMs, undefined, { signal: options.signal })
    // 延迟期间用户可能已关闭统计或卸载插件，外呼前重新检查。
    if (!allowed()) return false
    const day = heartbeatDay()
    const body = JSON.stringify({
      idHash: pseudonym(home),
      version: String(version || '0.0.0'),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(heartbeatUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      })
      if (!response.ok) return false
      state.day = day
    } finally {
      clearTimeout(timer)
    }
    return true
  } catch {
    // 网络不可达 / 端点变更 / 被拦截：一律忽略。
    return false
  } finally {
    state.pending = false
    // 只有服务端确认成功才占用当天额度；失败由周期检查低频重试。
    if (!state.day && reports.get(key) === state) reports.delete(key)
  }
}

/**
 * 发送一次心跳。**永不抛出**，也永不返回可导致分支的失败态：
 * 调用方不需要 try/catch，心跳成功与否都不应改变任何行为。
 * @param home - DSH_HOME 绝对路径。
 * @param version - 运行中的插件版本（用 LOADED_VERSION，即真正在跑的代码版本）。
 * @param options.delayMs - 发送前延迟（默认 {@link STARTUP_DELAY_MS}）；
 *   避开启动高峰。测试可传 0。
 * @returns 是否收到成功响应（仅用于测试与自检）。
 */
export async function sendHeartbeat(home, version, options = {}) {
  // 测试进程一律不外呼：统计数据的可信度比"测试里能验证外呼"重要得多。
  if (inTestProcess()) return false
  return deliver(home, version, options)
}

/** 注册启动和运行期间的安装心跳；返回卸载清理函数。后台运行也属于本口径。 */
function heartbeatLoop(home, version, { allowed = () => true, send = sendHeartbeat } = {}) {
  const controller = new AbortController()
  let stopped = false
  const tick = async (startup = false) => {
    try {
      if (stopped || !allowed()) return
      await send(home, version, {
        delayMs: startup ? STARTUP_DELAY_MS : 0,
        allowed: () => !stopped && allowed(),
        signal: controller.signal,
      })
    } catch { /* 旁路故障永不影响宿主，也不产生未处理的 rejection。 */ }
  }
  void tick(true)
  const timer = setInterval(() => { void tick() }, CHECK_INTERVAL_MS)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
    controller.abort()
  }
}

export function startHeartbeat(home, version, options) {
  if (inTestProcess()) return () => {}
  return heartbeatLoop(home, version, options)
}

/** 清空节流与缓存（仅测试用）。 */
export function _resetForTest() {
  reports.clear()
  idCache.clear()
}

/** 心跳是否已配置（供设置页显示；不含端点本身）。 */
export function heartbeatEnabled() {
  return heartbeatUrl().startsWith('https://')
}

// ── 用户开关（0.8.78+）────────────────────────────────────────────────────
// 双层：profile 配置 `telemetry: false` 是管理员路径；设置页复选框写
// `$DSH_HOME/.dsh-remote-telemetry`（'0'/'1'）是用户路径。与 updateMode 同一
// 约定：用户覆盖优先于配置默认。文件放 DSH_HOME 而非插件目录——升级覆写插件
// 目录时用户的选择不丢。
const OPT_FILE = '.dsh-remote-telemetry'

/** 读取用户持久化的开关：'1'/'0'/null（未设置或不可读）。 */
export function readTelemetryOpt(home) {
  try {
    const v = readFileSync(path.join(home, OPT_FILE), 'utf8').trim()
    return v === '1' || v === '0' ? v : null
  } catch {
    return null
  }
}

/** 持久化用户选择；返回是否写成功（只读 HOME 时静默 false）。 */
export function persistTelemetryOpt(home, enabled) {
  try {
    writeFileSync(path.join(home, OPT_FILE), enabled ? '1' : '0')
    return true
  } catch {
    return false
  }
}

/** 当前生效值：用户覆盖 > 配置值（默认 true）。 */
export function telemetryAllowed(home, configValue) {
  const opt = readTelemetryOpt(home)
  if (opt !== null) return opt === '1'
  return configValue !== false
}

/** 身份文件是否已存在（自检用，不创建）。 */
export function hasPersistedId(home) {
  try {
    return UUID_RE.test(readFileSync(path.join(home, ID_FILE), 'utf8').trim())
  } catch {
    return false
  }
}

/** 供自检：确认 installId 落盘位置（不创建）。 */
export function installIdPath(home) {
  return path.join(home, ID_FILE)
}

/**
 * 测试专用入口：绕过"测试进程不外呼"的守卫，用来验证发送逻辑本身
 * （字段白名单、节流、失败回滚、延迟）。
 *
 * 之所以必须存在：守卫让 sendHeartbeat 在测试里恒返回 false，于是发送逻辑
 * 就完全测不到了。真正的安全来自**端点可覆盖**（测试把 URL 指向本地不可达地址）
 * 而不是来自这个函数——它只是把守卫那道门打开给测试用。
 */
export const _deliverForTest = deliver

// 测试注入发送函数，验证生命周期时不访问生产端点。
export const _startHeartbeatLoopForTest = heartbeatLoop
