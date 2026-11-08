# C · 插件路由的长连接升级通道需要扶正｜A sanctioned WebSocket/upgrade channel for plugin routes

- 状态 Status：DRAFT，2026-11-08，待终审后投递
- **投递渠道＝Discussions/Ideas（主仓 issues 关闭）**：`deepseek-ai/deepseek-harness` `has_issues=false`；Discussions 开启
- Target：`deepseek-ai/deepseek-harness` → npm `@deepseek-ai/dsh-host-webserver`（兼涉 `@deepseek-ai/dsh-client-connection`）
- Reporter project：[`flymysql/dsh-remote`](https://github.com/flymysql/dsh-remote)

---

## 现象｜Observed

**中文**：dsh-remote 的内嵌远程终端至今只能 **HTTP 轮询**——当初写死轮询的原因是"插件只在 `webServer` 上注册普通路由，不能假设宿主一定暴露 socket 升级通路"（见下证）。**现状核查（本草稿相对最初设想的修正）**：`webServer.registerUpgrade` 其实**一直存在**（至少 0.1.2-rc.1 起），第一方也在用——但它目前是个"灰色地带 API"：(1) upgrade 分发与普通路由一样**没有任何 Host/Origin 围栏**（WS 跨站劫持面与草稿 A 同款）；(2) **Desktop/Electron composition 根本没有 webServer**（file://+IPC 载体），插件想要全载体可用的长连接依旧没有着落；(3) 唯一带围栏+认证的 socket 是 Connection 的 `/api/remote.mux`，但它保留自用（单 Owner、409 排他）且无插件复用 API。

**English**: dsh-remote's embedded terminal still **polls over HTTP**, originally because a plugin could not assume any socket-upgrade path existed. Correction established by this draft's recon: `webServer.registerUpgrade` has existed since at least 0.1.2-rc.1 and first-party packages use it — yet it remains a gray-area API: (1) the upgrade dispatch has **no Host/Origin fence** (same hijack surface as draft A); (2) **Desktop/Electron compositions have no webServer at all** (file://+IPC), so a cross-carrier long-lived channel still doesn't exist for plugins; (3) the only fenced+authenticated socket, Connection's `/api/remote.mux`, is reserved (single owner, 409 on contention) with no plugin-facing multiplex API.

## 证据｜Evidence

- 当年弃用 WS 的理由（`flymysql/dsh-remote@0.8.78`）：`lib/terminal.js:1-14` 头部注释——"the browser half is a DSH client UI that must not depend on a socket upgrade path the host may or may not expose … keeps the transport boring"；轮询代价（延迟上限≈轮询间隔 ~120ms）同段注明。
- upgrade 钩子**早已存在**：
  - `@deepseek-ai/dsh-host-webserver@0.1.2-rc.1`（npm pack 历史版实测）`lib/index.js:190` `registerUpgrade(route)`。
  - `@0.2.1-rc.5`：`lib/index.js:340-346`（registerUpgrade）、`:432-465`（`server.on('upgrade')` 分发）、`lib/types/index.d.ts:41-47`（`WebUpgradeRoute` 公开导出）与 `:181`。
  - 第一方使用方：`@deepseek-ai/dsh-api-gateway`、`@deepseek-ai/dsh-experimental-inspector`（全依赖树 grep 命中）。
- 但围栏缺席：`@0.2.1-rc.5 lib/index.js:432-465` 的 upgrade 处理器不查 `host/origin/sec-fetch-*`——与普通路由同病（草稿 A）；WS 握手天然携带 Origin，正是该查的地方。
- 桌面端缺口：`lib/types/index.d.ts:4-6`（包自述）"Electron uses file:// plus IPC instead"——此时 `webServer` 服务整体不在场，`registerUpgrade` 无从谈起。
- 受保护的替代品不开放：`@deepseek-ai/dsh-client-connection/lib/index.js:534`（`/api/remote.mux` 跳转落点）、`:736-750`（`requestRejection/admit`：Host/Origin 围栏+cookie/API 认证）、`:756-765`（`admitConnection` 单 socket Owner，冲突 409）——没有任何"插件在其上复用/多路复用自己协议"的接口。

## 影响｜Impact

**中文**：① 一切流式交互 UX（终端、日志 tail、进度推送）被迫付出轮询的延迟与 CPU/流量成本；② 今天直接去用 `registerUpgrade` 的插件会继承草稿 A 的同源围栏缺口——浏览器 WS 握手带 Origin 而宿主不查，即典型 WebSocket 劫持；③ 跨载体（Web vs Desktop）故事不明，插件要么分裂两套传输、要么保守地全员轮询。

**English**: ① Streaming UXs pay polling latency/CPU forever. ② Plugins adopting raw `registerUpgrade` today inherit draft A's fence hole — browsers send Origin on the WS handshake and nobody checks it (classic WebSocket hijacking). ③ No cross-carrier story: split transports, or conservative polling everywhere.

## 诉求与建议方向｜Ask & suggested fix

任选其一并明示｜Pick one and say so:

1. **扶正 `registerUpgrade`**：宣布其为稳定的插件 API（semver 承诺 + 文档 + 版本下限说明），并加装草稿 A 的同款围栏选项（upgrade 注册亦可 `fence:`）。／ Bless it as stable plugin API, document the version floor, add the same fence option as draft A.
2. **或提供 Connection 层的插件复用通道**：在已围栏+已认证的 mux 上给插件开子协议/通道注册（类似 `connection.fetch.register` 的 upgrade 版）。／ A plugin-facing channel registry atop the fenced, authenticated mux.
3. **或明确答复"不支持"**：那我们就在文档里把"插件流式传输一律轮询"定为约定，不再观望。／ Or an explicit "won't support" so polling becomes the documented convention.

附问｜Side question：Desktop/Electron 载体上插件长连接的官方答案是什么？（draft 期待一句明确说法。）／ What is the sanctioned story for plugin long-lived channels on the Desktop carrier?

## 复现与佐证｜Repro & links

- 现状一行验证：`ctx.webServer.registerUpgrade({path:'/x',handler})` 在 0.1.2-rc.1～0.2.1-rc.5 均可注册且分发零校验；外站页面 `new WebSocket('ws://127.0.0.1:<port>/x')` 握手直达 handler。
- 轮询实现的代价与设计权衡：`flymysql/dsh-remote` `lib/terminal.js:1-14`（以及全文件 205 行的会话/环形缓冲基建——本可由一条 WS 替代大半）。
- 上游：<https://github.com/deepseek-ai/deepseek-harness>（Discussions 开启）；npm `@deepseek-ai/dsh-host-webserver@0.2.1-rc.5`、`@deepseek-ai/dsh-client-connection`。
