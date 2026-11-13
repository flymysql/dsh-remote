# 测试体系（评估 / 分层 / 怎么写新测试）

> 起因：0.8.54 上线后用户报「编辑一台已经连上的机器 → 点测试连接 → 缺少凭据」「密码框是空白」
> 「点保存后不能点测试」。三个都是**功能不可用级**的问题，而当时 `npm test` 是**全绿 803 条**。
> 这份文档记录那次评估的结论、现在的分层、以及新增功能时必须补哪种测试。

## 1. 结论：全绿不等于能用

评估时（0.8.54，803 条测试 / 77 个测试文件）的真实分布：

| 层次 | 代表模块 | 行覆盖 | 说明 |
|---|---|---|---|
| 纯逻辑 | `registry.js` `errors.js` `paths.js` `ignore.js` `search.js` `sshconfig.js` | 95–100% | 好，且大多是真正的断言 |
| 传输/系统相关 | `pool.js` `openssh.js` `credential.js` `hostkey.js` `forwards.js` | 58–75% | 只覆盖了「连不上」的分支，**成功路径**几乎没测 |
| **插件主体** | **`lib/index.js`**（34 条路由 + 21 个工具 + 启动/恢复） | **38% 行 / 16% 函数** | 用户点的就是这里 |
| **浏览器端** | **`lib/client.js`**（3830 行 UI） | **测不到** | 覆盖率工具看不见（字符串 eval），且只有 1 个渲染测试 |

三个缺陷全部落在最后两行：`test-connect` 不合并已保存凭据、`passwordSet` 只认明文、保存后
`clearForm()` 清掉 `host`。它们的共同点是——**不是纯函数**，而是「路由 + 表单状态」的连线，
而那条连线当时没有任何测试。

**根因不是「测试写少了」，而是缺两层脚手架**：没有可复用的宿主测试台（11 个文件各自手搓
fake ctx/temp home），也没有真正的 SSH 服务端（于是所有成功路径只能靠「连到关闭的端口」间接证明）。
没有这两样，写测试的成本高到没人写，写出来也只能测到错误分支。

## 2. 现在的分层

| 层 | 脚手架 | 覆盖什么 | 例子 |
|---|---|---|---|
| L1 纯函数 | 无 | 解析/决策/格式化 | `registry.test.js` `errors.test.js` |
| L2 模块 | 注入依赖 | 一个模块的全部分支 | `sync.test.js` `update.test.js` |
| L3 路由 | `test/harness/plugin-host.js` | 真实注册的 handler（fake webServer + 隔离 DSH_HOME） | `routes-matrix.test.js` `routes-e2e.test.js` |
| L4 工具 | 同上 + `fake-ssh.js` | 21 个 `rw_*` 端到端（真 SSH、真 SFTP、真 exec） | `tools-matrix.test.js` |
| L5 界面 | `test/harness/render.js` | 真 React 渲染 + 真点击（按钮禁用态、placeholder、提示文案） | `ui-panels.test.js` `settings-credentials-ui.test.js` |
| L6 不变量 | 上述组合 | 「这类 bug 不许再出现」的通用断言 | 见 §4 |

### `test/harness/fake-ssh.js`——最关键的一块

进程内 ssh2 **服务端**：密码/公钥/keyboard-interactive 认证、`exec`（含 `cmd /c ver`/`uname -s`
的平台探测语义）、PTY shell、**内存 SFTP 文件系统**、`direct-tcpip`（端口转发）。于是：

```js
const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: { '/home/user/a.txt': 'hello' } })
const host = await createHost({ config: { host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw' } })
await host.run('rw_write_file', { path: '/home/user/b.txt', content: 'x' })
assert.equal(srv.fs.readText('/home/user/b.txt'), 'x')   // 真落盘
```

踩过的坑（写进代码注释了，别再踩）：
- READDIR 必须**两轮**：先 `name()`，下一次同 handle 的 READDIR 再 `status(EOF)`；一次回两个
  响应会被 ssh2 丢掉 EOF，客户端无限重发（表现为 `sftp operation timed out`）。
- 未知命令要回 **exit 127**，不能回 0 + 空输出：`searchRemote` 先用 `grep` 走 shell，看到
  干净退出就当「没匹配」，于是 SFTP 兜底永远不跑 —— 假服务器太宽容会让测试**什么都没测**。
- `echo ~` 要展开成 home，否则 `/dsh-remote/home` 测不到真路径。

## 3. 量化（union 覆盖，`npm run test:coverage`）

`--experimental-test-coverage` 对本仓库**不可用**：测试刻意用 `?host=…` 缓存破坏导入
`lib/index.js`（插件状态在模块级，共享实例会串味），V8 按 URL 聚合 → 同一源文件被算成 N 份脚本，
**加测试反而掉百分比**（实测 38%→35%）。`scripts/coverage-union.mjs` 用 `NODE_V8_COVERAGE` +
`v8.takeCoverage()`（能活过 `--test-force-exit`）按源文件取并集：

```
weighted line coverage: 80.3%   （全部 33 个 lib 文件加权；870+ 条测试，约 50s）
```

加这套脚手架之前同一指标是 **41.3%**。最弱处（都是「需要真机/真 OS」的分支）：
`openssh.js` 56%（需要本机 `ssh`，真机夜跑见 nightly.yml）、`binding.js` 66%、
`hostkey.js` 68%、`forwards.js` 69%、`client.js` 72%、`pool.js` 72%。门禁是双层的：
`--gate 70` 管加权均值，`--file-gate 60` 管每一个文件的下限（例外在脚本 `FILE_FLOORS`
里逐条注明原因——当前无例外；若新增例外且之后不再必要，会被 stale 检查点名要求删除）。

`lib/client.js` 是浏览器代码，测试从字符串求值——所有求值点都带
`sourceURL`/`filename: 'lib/client.js'`，V8 覆盖率因此**能归源**，实测 **71.7% 且逐位稳定**。
这个数字的稳定来之不易，值得记录两层根因：

1. **定时器**：真实 `setTimeout` 让 2s/5s/220ms 回调只在"worker 活得够久"时触发，
   负载决定覆盖。现在全部 sandbox 用 `test/harness/fake-timers.js`（0ms →
   queueMicrotask，长延时排队等 `flush(ms)`），行为逐位确定。
2. **合并算法（更隐蔽）**：union 最初把所有求值实例的 range 混在一个池子里做
   「最内层 range 决胜」——实例 A 的已覆盖大 range 会被实例 B 的未覆盖小 range 顶掉，
   行覆盖在 42.7–55.1% 间漂移（而按单调并集算的函数覆盖恒为 44.2%，正是这个反差
   暴露了合并侧假象）。改成**每个实例各自决胜、再在裁决层并集**后，行覆盖成为
   真正的"有任一实例执行过该行"，数值稳定。

## 4. 不变量：把「这类 bug」变成测试

比单个用例更值钱的是这些通用断言（都在 `routes-matrix.test.js` / `ui-panels.test.js`）：

- **任何 handler 都不许 reject**（reject 在真服务器上就是「空 400」，issue #30）。
- **错误方法 → 405 + JSON**；**畸形 body → 可读 JSON 原因**；两者都不许是空响应。
- **`ok:true` 不许同时带 `error`**（`/home` 曾经如此：客户端信 `ok` 就当成功）。
- **没有活动机器时，报「没有活动远程机」，不许报「缺少凭据」**（把用户骗去改密码）。
- **密钥永不回传浏览器**：`passwordSet`/`passphraseSet`/`proxy.passwordSet` 代替明文。
- **灰按钮必须带 `title` 说明为什么不能点**（「点了没反应」是独立一类 bug 报告）。
- **每个 slot 组件都能渲染，且不漏出裸 i18n key**。
- **注册清单必须诚实**：路由/工具清单在测试里显式列出，多一条少一条都会失败
  （新路由没进清单 = 直接红，避免「新功能没人管」）。

## 5. 测试不得有外部副作用（`test/setup-telemetry-off.mjs`）

三条线，都是踩过事故后加的：

1. **心跳**：`apply()` 里 `void sendHeartbeat(...)`，跑一次 `npm test` 就真的往生产统计灌假机器。
2. **`~/.ssh/config`**：保存机器会 upsert `# dsh-remote: managed` Host 块 —— 测试里「保存一台假机器」
   真的改过开发机的 ssh 配置，留下 `Host 127.0.0.1 / Port 1`、`Host 10.9.9.6..9`，而
   `Host 127.0.0.1` 又**反过来劫持**后续要连 127.0.0.1 的测试。现在整轮测试指向临时文件
   （`DSH_REMOTE_SSH_CONFIG`）；按 HOME 隔离的测试（`sshconfig-alias.test.js` 等）显式清掉该变量。
3. **本机目录选择器对话框**：`/dsh-remote/local-pick` 会 spawn 真的 `FolderBrowserDialog` 并**等人点**，
   测试/CI 碰到就是挂死。`DSH_REMOTE_NO_NATIVE_DIALOG=1` 关掉（产品侧也是无桌面宿主的逃生口）。

## 6. 新增功能时补哪种测试（recipe）

**加一条路由** → ① 在 `routes-matrix.test.js` 的 `ROUTES` 里登记（否则清单测试直接红）；
② 在 `routes-e2e.test.js` 里给一条「成功 + 一条拒绝」；③ 用 `host.call(path, { body })`。

**加一个 `rw_*` 工具** → `tools-matrix.test.js` 加两条：happy path（断言**远端真的变了**，
用 `srv.fs.readText(...)`）和一条拒绝分支（断言**抛错**且消息可执行，不是静默成功）。

**加一个面板/按钮** → `ui-panels.test.js` 加：渲染不抛、关键控件存在、禁用态正确、
禁用时 `title` 非空；涉及输入框的，断言 placeholder 说实话（「已保存 = 星号」）。

**加一条凭据/秘密路径** → 用 `saved-credentials.test.js` 的模式：表单**留空**跑一遍
（证明沿用已保存值），再断言响应里**没有**秘密原文。

## 6.5 真机集成测试（	est/it-*.test.js）

上面所有用假服务器做的测试都证明不了「真机上行不行」。这三套跑在**真机器**上，按环境变量启用（没配就 skip，CI 不红）：

| 文件 | 真机验证了什么 | 需要 |
|---|---|---|
| it-openssh-real.test.js | 系统 OpenSSH 后端：真 ssh 连接 + exec + SFTP + 平台探测；**密码走 askpass**、**私钥 -i**、**~/.ssh/config 别名**三种认证；错密码在有限时间内报认证失败；close 后可重连 | IT_SSH_HOST + IT_SSH_PASSWORD 或 IT_SSH_KEY 或 IT_SSH_ALIAS |
| it-keychain-real.test.js | 当前平台**真的**系统钥匙库：存入/读回/删除、含 shell 元字符的秘密不被破坏、DPAPI 落盘是密文、无钥匙库时 persistPassword 必须
efused 且不落明文 | 无（用当前平台） |
| it-webattach-real.test.js | 真远端 dsh web：隧道打开到 loopback、**token URL 换 cookie（303 + Set-Cookie）**、带 cookie 的 / 返回 HTML、无 token 仍 401、close 释放端口、stopRemote 停掉它启动的远端进程 | IT_WEB_HOST + IT_WEB_PASSWORD/IT_WEB_KEY |

**真机跑出来的两个结论**（假服务器永远测不到）：

1. **Linux 钥匙库后端是完全坏的**：secret-tool store 通过 xecFile({input}) 拿不到 EOF，一直阻塞到 8s 超时被杀，
   报错还是空的 Command failed: … —— 也就是说「勾选加密保存密码」在 Linux 上**必然失败**。改成 spawn + 显式 stdin.end() 后
   同一个真机 20ms 完成、读写回环正常（lib/credential.js）。
2. **隧道是好的，但测试必须自己做 token 交换**：DSH 的 token URL 是 303 + Set-Cookie，Node 的 fetch 不存 cookie，
   直接 follow 会落到 401 —— 这不是产品 bug，是测试写法。现在测的是真链路（换 cookie → 200 → HTML）。

## 7. 还没覆盖的（诚实清单）

- **GSSAPI/Kerberos**：手边没有只接受 Kerberos 的机器。`it-openssh-real.test.js` 里那条用例留着
  （`IT_SSH_GSSAPI=1` + 一个别名），在能 `kinit` 的环境里直接可跑；nightly.yml 已留好 secrets 门控的入口。
- **macOS 钥匙库**（`security`）：✅ 已由 CI 的 `test-macos` leg 覆盖（每次 push 实跑真钥匙串读写）。
- **从零 npm 安装远端 dsh**：0.8.66 起插件不再代装。真远端只验证了
  「已装好的 dsh 能起 web」（106.52.92.20 上是 0.1.5-rc.2），没有再从零 `npm install` 一遍。
- **目录选择器的渲染级点击链**：✅ 已补（`issue52-picker-dialog.test.js` 的 "click chain" 用例：
  输入 → 220ms 防抖（假定时器确定性触发）→ 建议列表 → 选中 → 提交 →
  `/current` 先于 `/mirror` 的身份契约 + `onPicked(localMirror, remotePath)`）。

已补齐：终端 PTY 全链路、`forwards` 失败/回收分支、`binding` 跨机围栏矩阵、
秘密不回传扫描、目录建镜像链路 —— 见 `terminal-e2e.test.js` /
`forwards-lifecycle.test.js` / `binding-fence.test.js` /
`invariants-secrets.test.js`；真机部分见 §6.5。
远端 dsh 的「体检 / 一键部署」已在 0.8.66 删除（`rw_deploy_probe`、`web-deploy.js`、
`ui-deploy-flow.test.js` 都不在了）。

~~已知偶发：docs-images 边缘截断检查在全量并行下抖动~~ ✅ 已修：一个 Python 进程扫全部图
（原来每图一个进程，spawn 开销 ×3 即全部负载敏感性）+ 进程级失败重试一次 + 执行用探测到的
解释器（原来探测认 python3、执行却写死 'python'，只有 python3 的机器必炸）。

下一步优先级：GSSAPI 用例在有 Kerberos 的环境跑一遍 → 目录选择器的渲染级点击链。


## 7. Agent 远程任务与编译输出验收

工具 handler 测试、人的文件栏操作、真实 Agent 循环和真实模型自主决策是不同层次，不能用其中一层的通过代替其他层。

`test/it-agent-workspace.test.js` 使用真实 DSH 0.2.0-rc.2 的 Cordis、AgentLoop、ToolRuntime、会话日志和 SSH/SFTP 连接。模型决策由 `test/harness/agent-build-model.js` 确定性生成，每一步校验模型收到的上一工具结果；它不调用外部模型。`test/harness/disk-workspace.js` 让 SFTP 和真实 shell 子进程使用同一个临时磁盘目录，GCC 报错、生成的二进制和运行输出都来自实际进程，没有预制编译结果。

前提：Linux/POSIX、Node.js ≥22、GCC，以及独立安装的 DSH 0.2.0-rc.2。默认 CI 没有完整 DSH 宿主时明确跳过：

```sh
IT_DSH_MODULES=/path/to/dsh-host/node_modules \
  node --import ./test/setup-telemetry-off.mjs --test --test-timeout=40000 test/it-agent-workspace.test.js
```

这两项回归检查：

- Agent 收到远程工作区提示和工具声明，读取远端源码，实际编译失败后看到文件/行号、stderr 和非零退出码，修改远程文件，重新编译并运行，最后将结果写入会话记录。
- 本地镜像中放置不同的哨兵内容；确认它没有被编辑、没有生成二进制，防止“实际在本地执行却宣称远程成功”。
- 命令已经在远端启动后停止 Agent，确认它没有继续写文件、没有继续请求模型；同一会话的新任务仍能执行。

真实浏览器验收使用 `scripts/manual/agent-web-e2e.mjs`。需在独立宿主的 node_modules 中安装当前 checkout 的 dsh-remote，并另行准备 playwright-core 和 Chromium：

```sh
IT_DSH_MODULES=/path/to/dsh-host/node_modules \
IT_BROWSER_MODULES=/path/to/browser-tools/node_modules \
CHROMIUM_PATH=/usr/bin/chromium \
IT_AGENT_ARTIFACTS=/tmp/dsh-agent-artifacts \
  node scripts/manual/agent-web-e2e.mjs
```

脚本启动独立 DSH_HOME、loopback SSH 服务和 Web 宿主，通过正式 SessionController 创建会话、选择测试模型并提交任务；校验最终回复、展开后的编译诊断和退出码，以及文件侧栏读到的 Agent 修改结果。保存会话事件和截图，退出时清理临时 profile、文件和进程；默认使用本机 50602 端口，可用 `IT_AGENT_PORT` 调整。测试用路由仅在显式 E2E 环境变量和随机 nonce 下启用，不修改正式 profile。

`IT_AGENT_PTC=1` 使用宿主正式 `ptc` preset，要求文件沙箱后端可工作。在嵌套 bubblewrap 的云执行器里，可在获准的外层执行相同测试；DSH 仍使用工作区沙箱，不改成无约束模式。新旧宿主分别使用自身支持的工具执行器 API，不能假设 `tools.presentAs()` 在新版仍存在。

真实模型使用 `IT_AGENT_REAL_MODEL=1`，从环境设置注入 `DEEPSEEK_API_KEY`，默认模型 `deepseek-chat`；可用 `IT_AGENT_MODEL` 选择兼容模型。脚本断言远端真实源码和二进制、最终任务回复、可点击 GCC 诊断与侧栏文件结果；不会把只获得模型回复或 HTTP 200 当作通过。模型有时会在 GCC 后追加 `echo`，此时 shell 的真实退出码可以为 0；卡片保留该退出码，同时突出并自动展开编译错误，不能把 stdout 中的字符串冒充进程事实。

本次真实模型通过记录与脚本原生/PTC 记录分开，范围见 [1.0 发布验收](release/1.0.0.md)。公网主机测试按用户指示停止，没有计入通过。

## 8. 介绍页与配图

```sh
IT_BROWSER_MODULES=/path/to/browser-tools/node_modules \
  node scripts/manual/site-e2e.mjs
```

脚本检查中英文、1440px 与 390px 布局、图片加载、键盘切图、安装命令复制和语言持久化；从真实 HTML 重渲染 `docs/cover.png` 与 `docs/shots/features.png`。工作区配图来自实际 DSH 会话，不能用概念图代替实测截图。默认产物在 `/tmp/dsh-site-artifacts`，可用 `IT_SITE_ARTIFACTS` 调整。


## 8. 主机设置与独立工作区

设置页只管理主机、凭据和连接配置。进入页面自动对已保存主机和 SSH 配置条目检测连通性，最多三个并行；离开时取消排队和晚到结果。刷新可重新检测，注册表轮询不重复连接；检测不调用 `/current`、`/mirror` 或打开工作区。显示的毫秒数是 SSH 建连与命令探测总耗时，不是 ICMP ping。目录选择只属于新建远程工作区，各工作区独立绑定主机。

`issue73-connect-flow.test.js` 验证自动检测、隔离、延时、失败、并发上限与取消；`settings-workbench.test.js` 验证草稿、标签切换、保存及晚到编辑探测。真实浏览器验收（独立 DSH_HOME 和回环 SSH，不读取用户配置）：

```sh
IT_DSH_MODULES=/path/to/host/node_modules \
IT_BROWSER_MODULES=/path/to/playwright/node_modules \
CHROMIUM_PATH=/path/to/chromium \
IT_SETTINGS_ARTIFACTS=/tmp/dsh-settings-artifacts \
node scripts/manual/settings-web-e2e.mjs
```

检查主机结果列与编辑表单对齐、远程主机图标、键盘标签导航、菜单关闭、草稿、测试与保存，以及 1440px / 390px 布局。此项接入最新宿主的原生 Agent CI，并上传截图。


## 9. 1.0.1 升级与原生入口回归

`client-lifecycle.test.js` 在已有旧样式节点时挂载新客户端，验证原节点被更新且不重复注入；设置浏览器脚本通过 `IT_SETTINGS_LEGACY_CSS=1` 预置旧 CSS，检查页面无需手动刷新即可恢复网格布局。该脚本还实际读写临时 SSH 配置、验证外部编辑冲突和窄屏工具按钮。

`ssh-config-editor.test.js` 验证显式读配置、原文保存、版本冲突、输入限制与符号链接保留；`settings-ssh-editor.test.js` 验证内置编辑器、草稿、快捷键和重新载入确认。

Agent 浏览器验收新增原生“工作区文件”点击：在任务完成后创建只存在于远端、没有本地镜像副本的文件，通过原生入口列出并打开它。客户端路由测试还验证两个远程会话、本地会话、异步到达和插件卸载隔离。CI 覆盖 DSH 0.2.0、0.2.1-rc.5、0.2.2 三条宿主的 native/PTC 路径。

- `test/auto-update.test.js` 和 `test/update-routes.test.js` 验证运行中启停、并发去重、失败退避、落盘未切换、卸载保护与无 registry 请求的状态轮询。`scripts/manual/auto-update-web-e2e.mjs` 在隔离的真实 DSH 进程中开启自动模式，用实际候选 tgz 完成下载和 Loader 热切换，整个过程不请求手动更新。Agent CI 的三个宿主原生路径均执行此验收。


## 10. 日常开发与 IDE 布局

下列脚本默认验证 `IT_DSH_MODULES` 中实际安装的候选包，使用独立临时 profile 和 loopback SSH，不读写用户项目。`IT_BROWSER_MODULES` 指向 Playwright，`CHROMIUM_PATH` 指向 Chromium；各脚本退出时回收其宿主及 SSH 服务。

| 脚本 | 验收内容 | 截图目录变量 |
| --- | --- | --- |
| `scripts/manual/directory-picker-web-e2e.mjs` | 桌面、低高度、手机的列表可见行数、键盘选择和路径确认 | `IT_PICKER_ARTIFACTS` |
| `scripts/manual/search-web-e2e.mjs` | 未展开目录内的文件/目录、实际扫描进度、内容行跳转、停止、空结果、手机布局 | `IT_SEARCH_ARTIFACTS` |
| `scripts/manual/git-web-e2e.mjs` | 真实远端仓库、工作区与暂存区差异、行号打开真实远端文件 | `IT_GIT_ARTIFACTS` |
| `scripts/manual/ide-web-e2e.mjs` | 三栏位置、原生节点与未保存草稿保留、运行中 GCC 任务、列宽、窄屏和多会话隔离 | `IT_IDE_ARTIFACTS` |
| `scripts/manual/terminal-web-e2e.mjs` | 原生终端、像素鱼、真实 OpenSSH/PTY 输入输出及仅远端落盘 | `IT_TERMINAL_ARTIFACTS` |

开发源码覆盖模式需显式设置相应 `IT_SEARCH_SOURCE=1`、`IT_GIT_SOURCE=1`、`IT_IDE_SOURCE=1` 或 `IT_TERMINAL_SOURCE=1`；正式候选验收不设置这些开关。不能将源码测试作为发布包已通过的证据。

`workspace-search.test.js` 覆盖任务归属、边界、增量结果、取消与真实 SFTP 操作并发；`workspace-search-ui.test.js` 覆盖迟到响应和范围、会话切换隔离。取消不释放尚未结束的真实操作槽位，不关闭共享连接。

`file-save-integrity.test.js`、`remote-write.test.js`、`editor-save-lifecycle.test.js` 验证同秒同大小外部修改、CRLF、符号链接/权限、写失败、保存期间继续输入与恢复原文。`file-change-tools.test.js` 和 Agent 集成测试核对实际应用差异元数据，模型可见结果仍保持简洁。

`IT_AGENT_APPLIED_DIFF=1` 的 Agent 浏览器验收完整执行 7 步：读取 → 实际编译失败 → 拒绝不匹配编辑 → 成功编辑 → 编译 → 运行 → 汇报。DSH 0.2.0-rc.2 的工具运行器仅对顶层调用生成 `presentationMeta`，且不将其写入 `tool/ptc-dispatch`；这同时影响 PTC 的编辑和命令展示元数据。脚本按实际安装的 `@deepseek-ai/dsh-tools` 版本，仅对 **0.2.0-rc.2 + PTC** 验证真实执行结果、请求的前后替换片段、失败状态、没有虚假“已应用”标记以及模型消息不含 diff 元数据，并明确打印宿主限制；不跳过任务、不修补宿主、不把展示信息塞入模型输出。0.2.0 原生调用及已验收的 0.2.1-rc.5 / 0.2.2-rc.1 原生和 PTC 调用仍严格要求持久化的真实 diff、上下文和增删行数。没有元数据的记录只能回退为替换片段，不能据此推断完整已应用差异。

`ide-mode.test.js` 验证列宽夹持、偏好持久化、可选宿主服务以及停靠后原始属性、inert 与 CSS 变量的完整恢复。IDE 通过兼容适配原生宿主面板，不复制会话 React 树；未来宿主标记变化可能需要更新适配。

jsdiff 的最小源码集合保留原 BSD-3-Clause 许可；`node scripts/vendor-diff.mjs` 可从锁定的开发依赖重建，CI 比较结果。覆盖率门禁统计第一方代码，第三方源码不计入；整体与逐文件阈值保持不变。
