# dsh 插件开发规范（固化版）

> 依据：2026-08-19 事故 —— v0.6.1 把 slash 命令命名为 `remote.forget-key`（带点号），
> 违反 dsh-commands 框架硬校验，导致插件树加载失败、**整个 DSH Desktop 无法启动**，
> 靠人工修复才恢复。以下规范必须遵守，防止"自己把自己搞崩"。

## 0. 铁律：日常开发用沙箱模式，禁止直接改产品 profile

- **默认迭代方式**：改源码 → `scripts/dev-run.sh`（沙箱）验证 → 页面刷新
  （client 半）或 `--restart`（host 半）→ 全绿后才谈部署。
- **禁止** `cp` 进产品 `profiles/web/node_modules/dsh-remote` 当常规手段：
  产品 package.json 把 `dsh-remote` 声明为 `^0.5.10`，任何 npm / `dsh plugin`
  重装都会把手改的文件覆盖回发行版。实证：v0.6.4 部署后 4 小时（8-19 20:48）
  被重装回 0.5.10 顶掉，本机目录选择器 bug 复发。
- 产品发布=受控动作：先 git 提交干净基线、跑 `check.mjs` + `boot-smoke.sh`，
  再 `./sync.sh`，并提醒用户重启桌面后**复查**是否又被重装（若被顶掉，说明
  触发了一次 plugin 同步，需改产品 profile 依赖声明——属产品模式，先问用户）。
- 沙箱布局：`dev-harness/harness`（隔离 DSH_HOME）+ 硬链接 profile +
  `node_modules/dsh-remote` symlink 指向源码目录；数据种子 machines.json /
  known_hosts.json 从产品拷入一次，之后独立。

## 1. 铁律：框架注册约束，先验证、再写、再守

任何注册到 DSH 框架的名字/结构，**动手前先读安装框架的源码/文档确认合法**，不要猜。

当前已确认的约束（依据桌面版捆绑的 `@deepseek-ai/dsh-commands` 等源码）：

| 注册对象 | 约束 | 违反后果 |
|---|---|---|
| `commands.register({name})` | 匹配 `/^[a-z][a-z0-9_-]*$/u`（**无点号/大写/空格/中文**）；`description` 非空字符串；`handler` 返回 `{kind:'success'|'error', text}` | 插件树加载失败 → **桌面无法启动** |
| Config schema | 用 `@deepseek-ai/schemastery`（非 zod）；叶子避免 `required` 数组（v0.5.7 坑） | 校验/启动异常 |
| **可选服务访问** | **只准 `ctx.get('serviceName')`**；**禁止 `ctx.<serviceName>` 属性形式**——cordis 要求属性形式必须在插件 `inject` 列表里声明，未声明即抛 `cannot get property "..." without inject`（**与服务是否注册无关**） | 运行时 500 / 功能崩溃（v0.6.4 坑：`ctx.directoryPicker`） |
| **可选服务可能压根不注册** | `ctx.get('svc')` 只告诉"现在有没有"，**不保证框架服务会挂载**；关键 UX 功能必须自带兜底实现（v0.6.6 实测 `directoryPicker` 在桌面启动路径不注册——web-app 的 `-auto` 行不物化成 loader 条目，即便 `loader.create` 手动挂载服务也不出现） | 功能静默不可用（本机选择器打不开，`ctx.get` 返回 null） |
| **三方库回调契约以真实运行为准** | 别只信单元测试 mock——mock 会掩盖真实契约漂移（v0.6.1 TOFU 按 ssh2 旧版 `{algo,hash}` 写 hostVerifier，v1.17 实际传**裸 Buffer**，`update(undefined)` 每次连接必崩；测试用 mock 对象全绿）。改依赖/写回调后跑一次真实集成验证 | 功能全挂（v0.6.7：远程浏览 + TOFU 一起救活） |
| `ctx.get(...)` 依赖 | 按 `inject` 声明白名单，`undefined` 时优雅降级 | 启动崩 |
| webServer 路由 | 路径注册用框架 API，body 读取有大小上限 | 行为错误/内存 |

**两条 cordis 教训**：命令名不允许点号（v0.6.1，桌面起不来）；可选服务只能
`ctx.get()` 不能属性直取（v0.6.4，本机目录选择器 500）。`check.mjs` 会静态拦住
命令名（见 §3）；服务访问靠人工遵守本表。

## 2. 启动期代码必须"fail-safe"

- `apply()` 里所有注册类操作（`commands.register` / `webServer.register`）的输入
  都要满足框架约束，且能容忍 `ctx.get('commands'/'webServer') === undefined`。
- 新增任何命令/路由/service 前：先读框架对应 `lib/index.js` 的
  `normalizeDefinition` / 注册校验逻辑，确认字段、返回值结构、命名规则。
- 不确定的注册，宁可先 `node --check` + 启动冒烟验证，也不要"先部署试试"。

## 3. 发布流程（宿主半改动必走）

```
编辑源码
  → node --check lib/index.js                  （语法）
  → node check.mjs                             （框架约束静态闸门，已接入 sync.sh）
  → 涉及行为改动：test/ 下单测（源码提取函数体 + mock，防漂移）
  → ./sync.sh                                  （拷贝前自动跑 check.mjs；拷贝后自动跑启动冒烟）
      · 部署后自检 lib 与源码逐字节一致
      · scripts/boot-smoke.sh：隔离 DSH_HOME + 硬链接拷贝 profile，
        起桌面 harness 验证"插件树能加载、无 DSH entry failed"
  → 重启 DSH Desktop，验证功能生效
```

**关键**：改完宿主半后，**必须**跑 `scripts/boot-smoke.sh`（sync.sh 会自动跑）。
启动冒烟是最后一道防线——它能在不重启你正在用的桌面实例的前提下，证明改动
不会让桌面起不来。

## 4. 回滚与备份

- 每次发布前 git commit 一个干净基线；出问题立即 `git checkout` 上一版再 `./sync.sh`。
- 保持"上一版可启动"始终可用：不要连续多次破坏性改动不验证。

## 5. 记住

- **部署 ≠ 生效**：宿主半要重启桌面才生效；`boot-smoke` 测的是"能加载"，不等于"功能对"。
- **别猜框架**：`commands.register` 的命令名不允许点号——这是用桌面起不来的代价换来的教训。
