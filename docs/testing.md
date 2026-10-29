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
| **插件主体** | **`lib/index.js`**（34 条路由 + 22 个工具 + 启动/恢复） | **38% 行 / 16% 函数** | 用户点的就是这里 |
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
| L4 工具 | 同上 + `fake-ssh.js` | 22 个 `rw_*` 端到端（真 SSH、真 SFTP、真 exec） | `tools-matrix.test.js` |
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
weighted line coverage: 73.9%   （34 个 lib/*.js，855 条测试，13s）
```

加这套脚手架之前同一指标是 **41.3%**。最弱处（都是「需要真机/真 OS」的分支）：
`openssh.js` 48%（需要本机 `ssh`）、`credential.js` 50%（OS 钥匙串）、`index.js` 56%、
`routes-term.js` 61%、`pool.js` 63%、`forwards.js` 64%、`binding.js` 66%、`hostkey.js` 68%。

`lib/client.js` 用 V8 覆盖率**测不到**（`new Function` 求值），只能靠 L5 渲染测试——这就是为什么
UI 必须有 `test/harness/render.js`。

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

## 7. 还没覆盖的（诚实清单）

- `openssh.js` 的真实 `ssh` 进程路径、GSSAPI/Kerberos（需要企业机器）。
- `credential.js` 的三套 OS 钥匙串后端（macOS `security` / Windows DPAPI / Linux `secret-tool`）——
  只有 `persistPassword` 的**决策逻辑**被测，后端本身不可在 CI 覆盖。
- 远程部署的**真实安装**（`web-deploy.js` 的 `install` 命令序列）只在假 shell 里跑过，没在真远端装一遍。
- `web-attach.js` 的隧道在真机上的行为（假 SSH 支持 `direct-tcpip`，但远端 `dsh web` 不在测试里）。
- `client.js` 里目录选择器「提交工作区 → 建镜像」的完整链路（`/dsh-remote/mirror`）只有首屏断言。

已补齐（原清单上的前几项）：终端 PTY 全链路、`forwards` 失败/回收分支、`binding` 跨机围栏矩阵、部署面板点击流 ——
见 `terminal-e2e.test.js` / `forwards-lifecycle.test.js` / `binding-fence.test.js` / `ui-deploy-flow.test.js`。

下一步优先级：目录选择器建镜像链路 → `web-deploy` 的安装命令序列（用假 shell 校验命令顺序与失败中断）→
`openssh` 后端用本机 `ssh` 跑一次真实连接（CI 可跳过）。
