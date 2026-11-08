# A · 插件裸路由缺少浏览器围栏｜webServer plugin routes lack a built-in browser fence (Origin/Host/Sec-Fetch-Site)

- 状态 Status：DRAFT，2026-11-08，待终审后投递
- **投递渠道＝Discussions/Ideas（主仓 issues 关闭）**：`deepseek-ai/deepseek-harness` 为公开仓但 `has_issues=false`（`.github/ISSUE_TEMPLATE/config.yml` 亦 `blank_issues_enabled: false`，bug/feature/task 模板为残留物）；Discussions 开启；无 `.github/SECURITY.md`
- Target：`deepseek-ai/deepseek-harness` → npm `@deepseek-ai/dsh-host-webserver`
- Reporter project：[`flymysql/dsh-remote`](https://github.com/flymysql/dsh-remote)（背景：[issue #46](https://github.com/flymysql/dsh-remote/issues/46)）

---

## 现象｜Observed

**中文**：`@deepseek-ai/dsh-host-webserver` 的 `webServer.register()` 注册的插件路由，在请求分发路径上**不做任何 Origin / Host / Sec-Fetch-Site 校验**。宿主监听 127.0.0.1 时，用户浏览器里打开的**任意网站**都能对其发起跨站「简单请求」（如 `Content-Type: text/plain` 的 POST，不触发 CORS 预检）并触发副作用。即便插件自查 `Origin === Host` 也会被 **DNS rebinding** 击穿：攻击者域名解析到 127.0.0.1 后 Host 头不再是回环字面量，表面上"同源"。

**English**: Plugin routes registered via `webServer.register()` are dispatched with **zero Origin/Host/Sec-Fetch-Site validation**. With the listener on 127.0.0.1, any page the user has open can drive those routes with cross-site *simple requests* (no preflight). Even a hand-rolled `Origin === Host` check falls to **DNS rebinding** — an attacker name resolving to 127.0.0.1 makes the request look same-origin.

## 证据｜Evidence

宿主侧（`@deepseek-ai/dsh-host-webserver@0.2.1-rc.5`，dsh@0.2.1-rc.5 实装嵌套依赖，下同）：

- `lib/index.js:326-333` — `register(route)` 仅做 `(kind,path)` 查重后入 Map，无围栏参数/钩子。
- `lib/index.js:378-409` — 分发路径（`handle`/`listener`）命中即 `await route.handler(req,res)`，全程不读 `host`/`origin`/`sec-fetch-*`。
- `lib/index.js:432-465` — upgrade 分发同样零校验（姊妹篇 `websocket-upgrade-channel.md` 详述）。
- `lib/types/index.d.ts:60-88`（Config 仅 host/port/tls/compression）与 `:174`（register 签名）— 无任何围栏选项。
- 注：`:252-257` 拒绝 wildcard 绑定——"绑定面安全"本就在此包职责内，缺的只是**请求层面**的围栏。
- 对照组：宿主自己会做这道围栏。`@deepseek-ai/dsh-client-connection/lib/index.js:736-750`（`requestRejection()`/`admit()`：不信任→403、未认证→401）实现了完整 Host/Origin 围栏+浏览器认证，但只接线到 `/api` 与 `/api/remote.mux`（同文件 `:534`）；插件裸路由不在保护范围内。

dsh-remote 被迫自带的补丁（v0.8.78）：

- `lib/http-transport.js:93-117` — `fallbackRejection()`：拒 `sec-fetch-site: cross-site`、拒 `Origin≠Host`、拒非回环 `Host`（rebinding 拦截）；设计说明 `:70-92`。
- `lib/http-transport.js:140-157` — `guardRoute()`：请求时探测 Connection 的权威 `requestRejection`，缺席则 fail-closed 回退。
- `lib/http-transport.js:119-129` — 注释直述威胁模型："registered straight on `webServer`, which applies no Host/Origin check … any page the user visited could define a tunnel, rewrite the machine registry, or drive `update-apply`"。
- `lib/http-transport.js:159-168` — 注册点整体套壳。

## 影响｜Impact

**中文**：任何带变更型路由的插件，离被越权驱动只差"用户点开一个恶意页面"（隧道定义、注册表改写、自更新触发皆为免预检简单请求）。宿主不提供围栏 ⇒ 每个插件都得各自重新发现并正确重写同一段安全逻辑，现实里多数不会写——这是生态级潜伏洞。"只听回环就安全"是浏览器模型下的经典误区。

**English**: Every plugin with mutating routes is one hostile-page visit away from drive-by invocation. Because the host ships no fence, each plugin must independently rediscover and reimplement the same control; most never will — an ecosystem-wide latent hole. Loopback-only binding is not a trust boundary under the browser model.

## 诉求与建议方向｜Ask & suggested fix

1. `webServer.register(route, options?)` 增加内建围栏，如 `fence: 'same-origin-loopback' | 'none'`，语义对齐 Connection 的 `isTrusted/admit`；回环监听器上**默认开**、可显式关。／ Add a built-in fence option (semantics aligned with Connection's `isTrusted/admit`), default-on for loopback listeners with explicit opt-out.
2. 同一围栏覆盖 `registerUpgrade`（WS 握手同样带 Origin/Host）。／ Cover `registerUpgrade` too.
3. 退一步：至少在 webserver 层导出官方 `requestRejection` 风格中间件，并在 README 写明"裸路由不受保护"的现状。／ At minimum export an official middleware and document today's unprotected reality. 我们愿贡献实战中打磨的规则集。／ Happy to contribute the battle-tested rule set.

## 复现与佐证｜Repro & links

- 复现：任意外站控制台 `fetch('http://127.0.0.1:3080/dsh-remote/current',{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})`——未打补丁的插件路由即生效（dsh-remote 打补丁后 403）。
- 背景：<https://github.com/flymysql/dsh-remote/issues/46>（CLOSED，远程 dsh-web 诉求引出了这套 web 面，进而暴露围栏缺失）。
- 上游：<https://github.com/deepseek-ai/deepseek-harness>（Discussions 开启）；npm `@deepseek-ai/dsh-host-webserver@0.2.1-rc.5`。
