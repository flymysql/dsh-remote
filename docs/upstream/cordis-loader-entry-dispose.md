# B · Loader Entry 无公开 dispose/reload 契约｜Cordis Loader `Entry` has no public dispose/reload contract

- 状态 Status：POSTED 2026-11-08 → https://github.com/deepseek-ai/deepseek-harness/discussions/12615
- **投递渠道＝Discussions/Ideas（主仓 issues 关闭）**：`deepseek-ai/deepseek-harness` `has_issues=false`；Discussions 开启
- Target：`deepseek-ai/deepseek-harness` → npm **`@deepseek-ai/cordis-plugin-loader`**（Entry 所在；非 cordis 本体）
- Reporter project：[`flymysql/dsh-remote`](https://github.com/flymysql/dsh-remote)

---

## 现象｜Observed

**中文**：插件自更新后要热切换自己的宿主半，需要对**自己在 Loader 里的 Entry**做"停了再起"。但 `@deepseek-ai/cordis-plugin-loader` 的 `Entry` 公开面只有 `init() / update() / refresh()`：`refresh()` 在 fiber 存活时是**空操作**；真正释放 fiber 的代码藏在 `update()` 的 disabled 分支里；外部没有任何"我就想停/重启"的入口。插件被逼着摸半内部形态：`entry.fiber.dispose()` + `entry.init()`，外加清 `loader.internal.loadCache` 才能让 re-import 真正读盘。

**English**: A self-updating plugin must stop and restart its own loader `Entry`, but the public surface is only `init()/update()/refresh()`; `refresh()` is a no-op on a live fiber, and the sole teardown path hides inside `update()`'s disabled branch. Plugins are driven to semi-internal shapes — `entry.fiber.dispose()` + `entry.init()` plus manual `loader.internal.loadCache` eviction.

补充两个实测暗坑｜Two empirically-found traps:

1. **disabled 写回**：DSH 0.2 的 loader 在 fiber 被外部卸载时把 `entry.options.disabled = true` **持久化写回配置树**，热切换后该插件在客户端扫描里"被禁用"。／ Externally unloading the fiber makes the loader persist `disabled:true`, hiding the entry from client scans.
2. **静默失败史**：早期实现探测的 `entry._dispose/entry.dispose` 根本不存在，每次都返回 `"entry exposes no dispose hook"` 又被外层吞掉——热切换从未发生，UI 却显示"已落盘"。／ Probe-then-swallow meant hot-swap silently never ran (0.8.35→0.8.36 incident).

## 证据｜Evidence

Loader 侧（`@deepseek-ai/cordis-plugin-loader@1.0.6`，dsh@0.2.1-rc.5 实装）：

- `lib/index.js:310-466` — `Entry` 全貌；实测方法集仅 `constructor/disabledOf/evaluate/_patchContext/refresh/update/_commitVolatile/init/_init`。
- `lib/index.js:361-365` — `refresh()`：`if (this.fiber) return;`。
- `lib/index.js:373-376` — 唯一 fiber 释放点：`update()` 的 `if (this.disabled) { this.fiber?.dispose(); return; }`。
- `lib/index.js:438-465` — `init()/_init()`：仅未运行时导入启动。
- `lib/types/config/entry.d.ts:21-58` — 类型面确认：公开成员 = `refresh/update/init` + 字段；**无** `dispose/unload/stop/restart/reload`；`fiber?: Fiber`（`:25`）虽被类型导出但属内部件。
- 关键对照：**`@deepseek-ai/cordis@4.0.5` 核心的 `Fiber.dispose` 是公开的**（`lib/types/fiber.d.ts:111-112`，"Dispose this fiber: unload the plugin…"）。缺的不是 Fiber 级而是 **Entry 级**生命周期契约——插件如今被迫越过 Entry 直接操作它持有的 Fiber。

dsh-remote 侧（v0.8.78）：

- `lib/update.js:342-364` — `clearSelfModuleCache()` 直捣 `loader.internal.loadCache`（Node 22/23 为普通 Map、24 为 `LoadCache extends Map`，需 `Map.prototype.has/delete.call`）+ `require.cache`。
- `lib/update.js:378-416` — `reloadSelf()`；`:383-401` 长注释记录全部死胡同（`_dispose/dispose` 不存在、`refresh()` 空转、真正卸载藏在 `update()` 内）；`:406` `"entry exposes no dispose hook"`。
- `lib/update.js:398-410` — 对 disabled 写回的防御：记住卸载前状态，只清 dispose 期间新打的禁用标记并 `tree.write()`。
- `lib/update.js:434-443` — `scheduleSelfReload()` 现强制记录结果，因为静默空转曾完全不可见。

## 影响｜Impact

**中文**：自更新/HMR 是宿主插件的普遍需求（第一方 `@deepseek-ai/dsh-hmr` 的存在证明官方也需要 reload 语义）。没有公开契约 ⇒ 每个插件复制同一份"摸私有字段+防副作用+清缓存"的脆弱代码；上游任何重构都会让它们**静默退化成"看似换了其实没换"**——最难察觉的失败形态。

**English**: Self-update/HMR is a generic host-plugin need (first-party `@deepseek-ai/dsh-hmr` proves upstream needs reload semantics too). Without a public contract every plugin replicates the same fragile internals dance, and any upstream refactor silently degrades them into "looks swapped, actually isn't" — the least detectable failure mode.

## 诉求与建议方向｜Ask & suggested fix

给 Loader Entry 一个公开、稳定（semver 承诺）的生命周期契约，任一形态皆可｜Any of:

1. `await entry.stop()` / `await entry.start()`（与 `init()` 对称、可反复）；／ symmetric start/stop;
2. `await entry.reload({ freshImport: true })`：fiber 释放+模块缓存失效+重新导入一步到位；／ one-step reload;
3. 或服务级 `loader.reloadEntry(id)`。／ a service-level entry point.

配套保证｜Guarantees：程序化 reload 不得触发 `options.disabled` 持久化写回（或提供显式开关）；提供受支持的模块缓存失效途径（替代 `loader.internal.loadCache`）；写入类型与文档。／ No persisted `disabled` flip on programmatic reload; a supported cache-invalidation path; typed + documented.

## 复现与佐证｜Repro & links

- 复现"无公开入口"：对运行中的 entry 依次试 `entry._dispose`/`entry.dispose`（皆 undefined）、`refresh()`（空转）、`update()` 传不变 options（早退）；唯一可行即 `entry.fiber.dispose()`（私有字段），随后还须清 disabled 写回。逐步实证记录于 `lib/update.js:383-401` 注释。
- 事故实证：dsh-remote 0.8.35→0.8.36 自更新"永不生效"，根因即上述静默吞错。
- 上游：<https://github.com/deepseek-ai/deepseek-harness>；npm `@deepseek-ai/cordis-plugin-loader@1.0.6`、`@deepseek-ai/cordis@4.0.5`。
