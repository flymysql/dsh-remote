# Changelog

All notable changes to **dsh-remote**.

## 0.8.43 — 2026-10-11
### 会话列表里一眼看出「这是远程会话，连的是哪台机」（issue #49）

以前侧栏的会话行长得都一样：**分不清一个会话是本机的还是远程的，更不知道它连的是哪台机**。
现在远程会话多了一个绿点，悬停能看到主机与远端路径，当前会话的标题栏还会常显一个主机标签。

- **会话行前导位（16px 单元格）一个绿点** —— 与 DSH 自带的「定时任务」时钟标记共用同一个座位：
  行处于空闲态时显示绿点；正在跑/待授权时该座位仍归状态点，这时**悬停卡片**里也能看到主机。
- **悬停卡片新增一行**：`user@host:port`（端口为 22 时省略）+ 远端路径，例如
  `root@9.134.186.191:36000` / `/home/jimmycppliu/QQMail/blocksvr`。机器在设置页有名字时，标签里补上名字。
- **当前会话标题栏的主机标签** —— 行内 16px 格子放不下地址，所以打开会话后标题右侧常显
  `● root@106.52.92.20`（本地会话不显示）。
- **判定口径与 issue #13 一致**：只有 cwd 落在 `$DSH_HOME/remote-workspaces/<host-user-port>/…`
  镜像里的会话才算远程；**仅仅是「保存过/设为当前」的机器不会给本地会话打标**。没有镜像 → 不打标
  （宁可不显示，也不猜一个主机）。
- **一次请求**：宿主新增 `GET /dsh-remote/bindings` 返回整张镜像登记表，浏览器半只发这一发，
  再用每个会话自己的 cwd 本地匹配；不是每行一个请求。
- 三个座位都用 `slots.inject(...)` 注入（而不是假定存在），所以换掉侧栏的组合里不会崩，只是没有标记。

验证：隔离实例（独立 `DSH_HOME` + 独立 Chrome）上对着真实数据端到端跑通 **12/12** —
绿点只出现在远程行、本地行没有；每个绿点的无障碍标签都指向登记表里真实存在的主机；悬停出主机+路径；
打开远程会话标题栏出现主机标签、打开本地会话不出现、切回远程又出现。新增 19 个单测（宿主 5 + 浏览器 14），全量单测 **476 pass / 0 fail**。

## 0.8.42 — 2026-10-09
### 部署高可用：窗口关了，进度不丢

### 部署改为宿主侧后台任务

`install` 原来是**一条长 HTTP 请求**，而 npm 合理地可能跑几分钟。部署过程中窗口一关，响应没了、
进度全丢——用户无法知道装没装成功，再点一次按钮还会对同一个目录**并发跑第二个 npm**（会损坏
依赖树）。现在部署跑在**宿主侧**，与任何请求的生命周期解耦：

- **请求 4ms 返回任务句柄**（实测），npm 在后台继续；
- **每一步的结果实时记录**（含正在执行的步骤名），失败时连结构化详情（步骤列表、提示）一起保留；
- **重新打开窗口即可续看**：`GET /dsh-remote/web-attach` 现在携带部署任务状态，页面轮询第一拍就能捡回进行中的部署；点「部署并验证」也会**恢复**而不是重启；
- **一机一次**：同一台机器部署中再点一次，返回同一个任务（实测双击并发：第二个 `resumed:true`、同一个 taskId）；不同机器的部署**并行**（刻意不走全局单飞的 TaskManager）；
- 完成时结果照常落库（`webAttachCommand` 记到机器上），**没有任何人在看也一样**；
- 「部署任务」卡片实时渲染：状态、当前步骤 ▶、逐步 ✓/✗、n/m 计数、取消按钮；完成即出现「继续」入口（连接并打开）。

### 真实断连验证（E2E，全部通过）

在独立实例 + 真实远端上按用户场景跑：**发起部署 → 30 秒完全无人观测（= 窗口关闭）→ 重新打开** →
任务在宿主侧照常跑完（5/5 步全绿）、完整结果与最终命令可读、可再次部署。另外实测双击并发恢复
（`sameId:true`）。

### 顺带

- 新增 `install-status` / `install-cancel` 动作；`lib/deploy-tasks.js` + 7 个单测
  （恢复不重启、并发防护、失败详情存活、协作取消、跨机并行）。

## 0.8.41 — 2026-10-09
### 工作区备份能力整体下线

应用户要求，把 0.8.38 引入、0.8.40 简化的「工作区压缩备份 / 恢复」**整个能力移除**：

- 工具：`rw_backup` / `rw_backup_list` / `rw_restore` 不再注册（25 → **22** 个 `rw_*` 工具）。
- 设置页「工作区备份」卡片删除；相关 i18n 键（中英各 26 个）全部移除。
- 路由 `/dsh-remote/backup` 与 `lib/archive.js`、`lib/backup.js`、`lib/routes-backup.js` 三个模块删除。
- 配置项 `backupDir` / `backupExcludes` / `maxBackupTransferBytes` 从 schema 移除（profile 里残留的这几个键会被 schemastery 忽略，无需清理）。
- 测试：备份相关 4 个测试文件删除；`settings-render` 改为**断言备份 UI 不再出现**（展开所有折叠区后仍无残留），防止能力回潮。

保留：**远程 dsh 体检/部署**（0.8.40 起部署按钮不再需要先体检）与「远程 DSH 界面挂到本机」。

### 修复：远程 dsh 部署链路上两个真实缺陷（E2E 实测发现）

把「部署 → 在本机窗口打开」在真实远端跑通时抓到两个 bug，均已修复并带回归测试：

1. **`truncate()` 遇到缺失上限会摧毁整个输出**。裸 `new SshPool({...})`（没传 `maxOutputChars`，生产 `apply()` 路径有 schema 默认值所以不触发，但所有直接建池的调用方都中招）时：`'x'.length <= undefined` 恒为 `false` ⇒ 永远走截断分支 ⇒ `s.length - undefined` 打出 `NaN` ⇒ **每一条远程命令的 stdout 都被毁成 29 个字符的截断标记**。后果链条：probe 的 facts 全空 → 装到 `/tmp` 而非 `$HOME` → web-attach 的启动 token 解析不出来 →「90 秒内未报告 token」。修法：非法上限（undefined/NaN/≤0）直接**不截断**返回原串。
2. **attach 超时路径泄漏远程进程**。等 token 超时抛错时，PID 已解析但清理发生在抛错**之后**且实际不会执行 ⇒ 每次失败重试都在远端多漏一个 `dsh --port 0`（实测连挂三次漏了三个）。修法：抛错**前**先 kill 已记录的 PID（进程自己死掉的场景不 kill，避免无谓指令）。

### 验证

真实远端（Linux）端到端全绿：**体检 → 部署到 `$HOME/.dsh-remote/dsh`（5 步全过）→ 启动远程 `dsh web` → SSH 隧道拉回本机 → 真实 HTTP 303 token 交换 → 真实 WebSocket 升级 `/api/remote.mux` 成功 → 干净关闭（远程进程停止、无残留）**。这就是「远程的 dsh 在本机窗口打开」的完整证明。全量单测 **448 pass / 0 fail**。

## 0.8.40 — 2026-10-08
### 备份简化成两个按钮 + 远程 dsh 部署不再只给体检

### 备份：只剩「备份」和「恢复」两个按钮

0.8.38 的备份面板把「留个底」做成了配置题：排除项文本框、存放位置（远端/本机/两边）、
恢复模式（替换/合并），外加每个归档一行的校验/下载/传回/删除。实际用法只有一件事——
**留个底，需要时再回来**。现在：

- **「备份」** —— 一键把**侧边栏里的所有远程工作区**打包成**一个** `.tar.gz`。
- **「恢复」** —— 从下拉里选一个备份时间点，一键把**全部**工作区还原。
- 依赖/构建目录（`node_modules`、`.git`、`dist`、`build`、`target`、`__pycache__`、`.venv`…）
  **顶层与嵌套都自动排除**，不需要用户决定。校验/下载/删除仍在，但只在选中某个备份后才出现。

**归档是自描述的**：里面带 `dsh-remote-backup.json/manifest.json`（机器、时间、工作区清单、
排除项、sha256）和一份 `paths.tsv`（归档成员 ↔ 绝对路径）。恢复端**不需要 JSON 解析器**就能
知道每个工作区该放回哪里；原来的绝对路径建不出来时（例如把另一台机器的归档恢复过来）会退到
`/tmp/<名字>`，而不是整批失败。

**安全属性没有让步**（都带实测用例）：

- 归档**先校验再动手**：损坏/截断 ⇒ 拒绝，目标**一个字节都不动**。
- 每个工作区是「旧目录先移到一旁 → 换入新的 → 最后才删旧的」，换入失败会把原目录**移回去**。
- 归档先写 staging 再 `mv`，**绝不发布截断的归档**；且**先检查所有工作区都存在**，
  缺一个就整体拒绝——否则「我备份过了」会变成假话。
- 备份目录在某个工作区里时，会自动排除自己，避免每次备份把上一次的增长进去。
- 生成脚本里**永不出现 `-P`/`--absolute-names`**（否则越界成员能写出目标之外）。

**这里由真实 shell 抓出三个 bug**（字符串断言全都通过）：

1. `paths.tsv` 注入在 `tar` **之后**，于是 tar 报 `Cannot stat` → 改为两个 manifest 文件都在
   tar 之前由构造器写出。
2. 存在性检查用了**归档成员名**（`allws/w1`）而不是**真实路径**（`/tmp/allws/w1`）→ 每次
   `these workspaces do not exist`。
3. manifest 文件写在了 staging 目录根下，而 tar 是以 `dsh-remote-backup.json/` 这个**目录**
   为成员去加的 → 改为先 `mkdir` 这个子目录。

另外修掉一个**不可见的**缺陷：手写的 `*/` 前缀模式里混进了一个零宽空格（U+200B），
在 diff 里完全看不出来但让模式**匹配不到任何东西**。现在这类模式由裸目录名**派生**，
并用用例断言全部是可打印 ASCII。

### 远程 dsh 部署：按钮不再被体检门控

「部署并验证」以前只在**先跑过体检、且体检判定有毛病**时才出现
（`deploy.verdict.canAutoInstall && !deploy.verdict.ok`）。于是只看到体检按钮的用户
**永远点不到真正干活的按钮**——它在等一次你没有理由去做的检查。宿主侧的 install 动作
本来就会自己重新体检，所以现在**按钮始终可用**，点击即显式同意。

### 顺带

- 设置页 i18n 清掉 17 个随面板一起作废的键（中英同步，用例保证两边键集一致）。
- README ×2 的备份说明与配置表按新行为更新。

## 0.8.39 — 2026-10-08
### 热更新不再丢掉设置页

DSH 0.2 在插件 fiber 被卸载时会把该行写成 `disabled: true` 并写回配置。客户端扫描会跳过禁用行，所以热切换之后宿主还在、设置页的 client 不再下发。`reloadSelf` 现在只清掉卸载期间新打上的禁用标记，再重新挂上；用户本来就禁用的行保持禁用。

## 0.8.38 — 2026-10-06
### 工作区压缩备份 / 恢复（`rw_backup` / `rw_backup_list` / `rw_restore`）

**新增**

- **`rw_backup`** —— 把远程工作区（或其子目录）打成 `.tar.gz`，可选拉到本机或**两边都留**。
  归档默认落在远端 `$HOME/.dsh-remote/backups/<工作区><哈希>/`，每个归档配一个
  `.meta.json` sidecar（工作区路径、条目数、sha256、排除项、时间）。
- **`rw_backup_list`** —— 列出远端与本机两侧的归档（大小/条目数/时间/校验值）。
- **`rw_restore`** —— 从某个归档恢复工作区；`mode=replace`（默认）整树替换、
  `mode=merge` 只覆盖不删除；`where=local` 可从本机副本恢复（先自动传回远端）。
- **设置页新增「工作区备份」卡片** —— 新建 / 校验 / 下载 / 传回远端 / 恢复 / 删除，
  含排除项文本框与「整树替换 / 合并」模式选择。
- **三个新配置项**：`backupDir`、`backupExcludes`（**默认空**）、`maxBackupTransferBytes`。

### 设计取舍（都写在代码注释里，这里给结论）

- **默认全量收录。** 排除项默认为空：备份**静默少打包目录**正是「恢复时静默丢数据」的
  成因，所以宁可归档大一点，也要让「我备份过」这句话成立。要小归档时显式传 `excludes`
  （或配 `backupExcludes`）。
- **归档不可信 ⇒ 恢复前先自证。** 恢复脚本**先** `tar -tzf` 校验归档完整性，归档损坏或
  被截断就**直接拒绝、目标目录一个字节都不动**。这条有专门的实测用例（往好归档后面追加
  垃圾字节 ⇒ `ARCH_VERIFY=bad` ⇒ 目标里的 `precious.txt` 仍在）。
- **替换是「分阶段 → 换入 → 再删旧」而非原地覆盖。** 先解到**兄弟**暂存目录（同一文件系统，
  所以 `mv` 是原子的），再把旧目录挪到一边、把暂存目录换进目标位，最后才删旧目录；
  换入失败会把原目录**移回去**。⇒ 一次失败的恢复不会把工作区变成两不像。
- **备份目录绝不会被自己打进归档。** 若备份目录恰好在工作区内，该子树会被自动排除，
  否则每次备份都会把上一次的归档再打进去、越滚越大。
- **文件名安全是一等的。** 所有接受 `file` 参数的动作（列出/校验/恢复/删除/下载）都先过
  `isSafeArchiveName`：只接受纯 `.tar.gz` 基名，`../`、绝对路径、`a/b`、`; rm -rf /` 一律拒绝。
  `excludes` 里的 `..` 与绝对路径同样拒绝（**改写会排除得比用户要的更多**，所以是拒绝而非纠正）。
- **`--exclude` 的语义坑（实测）**：GNU tar 把模式与**归档成员名**匹配，而我们的成员是
  `./x/y`。实测 `--exclude=src/dist` 能命中任意深度，但 `--exclude=/src/dist` **一条都不排**
  （静默失效）、`--exclude=./src/dist` 只锚定根。所以用户写的 `/build/`、`./node_modules`
  都先被规范化成裸模式，且**构建命令前会断言不变量**（传进去就抛错）。
- **`-P` / `--absolute-names` 永不出现。** 没有它，tar 默认会拒绝 `../` 成员、剥掉绝对路径前缀，
  归档里的越界路径写不到目标之外。代码里有断言 + 用例。

### 验证

- 新增 **4 个测试文件 / 72 个用例**（`archive` 17、`backup` 31、`backup-routes` 20、
  `backup-shell-syntax` 4），全绿；`npm test` 与 `check.mjs` 通过。
- **生成的 shell 过真实 `sh -n`**：4 类构造器 × 路径/引号/`$(...)`/反引号/空格的对抗性输入矩阵，
  并带**负对照**（`do;`、未闭合 `if`、未闭合引号必须被拒），以及「通配/命令替换必须原样作为
  **单个**参数传递」的实测断言。
- **在真实 Linux 主机上跑通全链路**（不是 mock）：`create → list → verify → restore(replace) →
  restore(merge) → delete → pull → push`；含**字节级往返一致**（递归 `diff -r` 干净、二进制
  NUL 字节保留）、**损坏归档不破坏目标**、**同名归档不互相覆盖**、**路径含空格**、
  **文件名以 `-` 开头**、以及跨机往返后 **sha256 不变**。

### 坏配置让整机崩溃 + Agent 连不上已配好的机器（issue #48）

**症状**（issue #48 三连）：①机器用**加密私钥**但没填 passphrase 时，整个 DSH 进程直接
`fatal load failure: Cannot parse privateKey: Encrypted private OpenSSH key detected, but no
passphrase given`，且**每次重启都再崩一次**（启动恢复会重拨保存的当前机器）；②Agent 侧
`rw_connect` 只能填 host/username/port/password/privateKeyPath——passphrase / useAgent /
keyboardInteractive / hostKeyMode 全都给不了，需要这些字段的机器对 Agent 来说**根本连不上**；
③也没法让 Agent 复用界面上**已经配好**的机器，只能把整张配置重新敲一遍。

**崩溃根因**：ssh2 在 `Client.connect()` 里**同步**解析私钥，解析失败**同步 throw**。这个
throw 落在 `buildOpts().then(onFulfilled)` 的回调里，而那条 promise 链没人接管 ⇒ 变成
**unhandled rejection**（Node 默认行为 = 杀进程），同时外层连接 promise **永远挂起**。
启动恢复那段 `try/catch` 本来写明了"失败要吞掉"，但它 await 的是挂起的外层 promise，
对孤儿链上的崩溃**完全无效**——所以坏配置才会每次都把整机带走。

**修法**：
1. **pool.js**：`client.connect(opts)` 包 try/catch，同步 throw 转成正常的 promise 拒绝。
   一处改动同时治好三件事：不再崩溃、不再挂起、所有调用点（启动恢复 / test-connect /
   rw_connect）的 try/catch 恢复生效——坏配置现在就是一条普通错误提示；
2. **rw_connect 补全字段**：新增 `passphrase` / `useAgent` / `keyboardInteractive` /
   `hostKeyMode` / `name`；upsert 时**未提供的 secret 保留原值**（以前只保 password，
   passphrase 会被默认空串抹掉）；
3. **复用已存机器**：`rw_connect(machineId=...)` 直接用注册表里的整条记录（含钥匙串密码、
   已存 passphrase、跳板机、ssh-config 别名）并设为当前机器；新增 **`rw_machines`** 工具
   列出已存机器（id / 地址 / 认证方式旗标 / 别名解析 / 当前标记，**只给旗标不给秘密值**）；
4. **errors.js**：`Cannot parse privateKey / no passphrase given` 归类为 credentials，提示
   「私钥已加密但未提供 passphrase」。

测试 +13（`test/issue48.test.js`）：崩溃组带**负对照**——回退 pool 修复后 A1/A4/B3 准时变红
（连接 promise 挂起 + 捕获到 unhandledRejection），恢复修复后全绿；其余覆盖字段透传、
passphrase 保留、machineId 连接、rw_machines 脱敏。

顺带修一处**测试隔离缺陷**（本机全量套件因此永挂）：`search-cancel.test.js` 的预算用例
用 schema 默认值挂载真实插件，而默认 `updateMode=auto`（发起真实 registry 检查）、真实
`DSH_HOME` 注册表里又存着「当前机器」⇒ 启动恢复**真的 SSH 拨号**（keepalive 长连接），
用例全绿后进程仍存活 10 分钟以上。现钉 `updateMode:'off'` + 隔离 HOME/DSH_HOME；
`update-default.test.js` 的挂载门禁同步补上**动态 import** 形态（它原先只认静态
`from '../lib/index.js'`，这个文件正是从缺口溜出去的）。

## 0.8.37 — 2026-10-05
### 修复自动更新：热切换从未真正执行过（卸载钩子用了 cordis Entry 不存在的名字）

**症状**：自动更新和「立即更新」都不生效。面板一直停在「磁盘已是 v0.8.36，运行中的仍是
v0.8.35」—— 新版本已经落盘，但运行中的代码永远换不过去。更糟的是它**静默失败**：
接口如实返回 `scheduled: true`，所以看上去只是「还没重启」。

**根因**：`reloadSelf` 用来卸载运行中插件的那两个名字，cordis 的 `Entry` **一个都没有**：

```js
if (typeof entry._dispose === 'function') await entry._dispose()            // undefined
else if (typeof entry.dispose === 'function') await entry.dispose()          // undefined
else return { ok: false, reason: 'entry exposes no dispose hook' }            // ← 每次都走这里
```

0.2.0 实测 `Entry` 的方法集是 `constructor / disabledOf / evaluate / _patchContext /
refresh / update / _commitVolatile / init / _init`，真正的卸载在 `Entry.update()` 里：
`this.fiber?.dispose()`。所以每次热切换都在**做任何事之前**就返回失败了，而
`scheduleSelfReload` 里的 `.catch(() => {})` 把它彻底吞掉。`entry.refresh()` 也**不能**替代
—— 它是 `if (this.fiber) return; await this.init()`，fiber 还活着时直接返回，等于没重启。

**修法三处**：
1. 卸载回退到 **`entry.fiber.dispose()`**（宿主若真提供 `_dispose`/`dispose` 仍优先用它）；
2. **不再吞掉失败** —— 新增 `lastSelfReload()`，`/dsh-remote/update-check` 返回 `lastReload`，
   失败时打一条日志。会静默失败的自动更新是最糟的一种，这次就是它把缺陷藏了整整两个版本；
3. 补 3 条回归测试，专门覆盖**真实 Entry 形态**。

**为什么原有测试没抓到**：测试桩 `makeEntryLoader` **总是**提供 `_dispose`，于是永远走第一条
分支，从未测过真实形态。新测试刻意构造「只有 fiber、没有任何 dispose 钩子」的 entry。

**验证（干净 A/B，唯一变量 = 被测的 update.js）**：用真实安装副本（依赖可解析、`selfDir()`
正确）对真实 cordis Loader 跑：

| | `reloadSelf` 返回 | 热切换后 apply 记录 |
|---|---|---|
| 原版 | `{ok:false, reason:'entry exposes no dispose hook'}` | `["0.8.35"]` ❌ 未切换 |
| 修复版 | `{ok:true, cleared:2}` | `["0.8.35","0.8.36"]` ✅ 新代码生效 |

### README 移除遥测章节

按用户要求，从 `README.md` 与 `README.en.md` 里删掉「数据采集 / 遥测」整节（含字段表、
隐私段落与看板链接）。npm 页面渲染的是 `README.md`，所以 npm 介绍同步生效；`package.json`
的 `description` / `keywords` 从未提及遥测，无需改动。

**心跳实现未动**，隐私边界仍在 `lib/telemetry.js` 顶部注释里（改动者该看的地方）。
`CONTRIBUTING.md` 中「不接受新增遥测」的贡献政策也保留。

`test/readme-parity.test.js` 的守卫**反转**为「不得再有遥测节」，并能同时抓回潮与
「删了标题忘删字段表」的残留。

### 顺带

- README 与站点补上「远端 DSH 界面 + 一键体检部署」的能力说明，并重做配图
- `PUBLISH.md` 固化两件事：Release notes 从 CHANGELOG **机械提取**（防漂移），
  以及「刚发布时 tarball 404 / `ETARGET` 不是失败」的判据

## 0.8.36 — 2026-10-03
### 自动部署远端 dsh 并验证（体检 → 一键装 → 交给 AI 兜底）+ 新增 `rw_deploy_probe`

接着上面的「远程 DSH 界面」：**连不上大多不是插件的问题，而是远端 dsh 版本或环境不对。**
最典型的一种是这次真机踩到的——dsh 0.1.0-rc.6 依赖 `node-pty@1.1.0`，而**那个版本发布的包里
没有 `linux-x64` 预编译产物**，于是 `dsh web` 在 Linux 上**根本起不来**
（`Failed to load native module: pty.node`）。以前用户只会看到「没拿到启动令牌」，无从判断。
现在分三层解决。

**1）`体检（只读）`** —— 探测远端平台/架构、node/npm、现有 dsh 及版本、
**原生模块能否启动**、是否认识 `--no-open`、代理变量、npm 源，并给出结论与修复建议。
分级是 blocker/warn/info/ok，UI 原样渲染、不做二次判定。**严格只读**：不写、不装、不改，
所以可以在用户还没同意任何事之前随便跑。刻意不用 `; ` 拼接语句（launch 命令被 `do;` 坑过一次），
并由**真实 `sh -n` 的语法闸门**兜底 —— 这道闸门当场抓出了一个我自己写的 `||` 续行语法错。

**2）`部署并验证`** —— 只在体检判定「需要且可以自动装」时出现，点击时明确告知会装到
**私有目录**（默认 `$HOME/.dsh-remote/dsh`）：**不写系统目录、不改 PATH、不覆盖用户在用的版本**，
删掉目录即完全回滚。装完**逐步校验**（二进制 / 原生模块 / `web` 子命令），成功后**按机器**
记住这条 dsh 路径，之后连接自动使用。默认**不覆盖**远端 npm 源，所以内网镜像仍然生效。

**3）`让 AI 排查`** —— 只在失败后出现，且**只有点击才创建会话**（会消耗模型额度，绝不自动）。
它把体检结论、原始事实、真实报错**原样**交给内置的 `dsh-remote-deploy` 技能，覆盖确定性流程
表达不了的长尾：没有 npm、要 sudo、代理、内网镜像源、Windows 远端、报错不匹配任何已知签名。
技能正文把这次实测的坑写在最前面——`pty.node` 与 `--no-open` 两个失败签名、
哪些报错**不是**部署问题（`NO_ADAPTER`/`no API key`/`QUOTA`）、以及一个会误导判断的
符号链接陷阱：`dirname(dirname(realpath(.bin/dsh)))` 落在包**内部**、那里没有兄弟 `node-pty`，
**好安装会被判成缺 pty**（这个 bug 就是我在真机上撞到并修的）。

其余覆盖面：Windows 远端**有 Git Bash 即可部署**（`pool.exec` 会经 `bash -s` 执行，之前一律判不支持）；
代理与自定义 registry 只**报告**不改；版本可配置（默认 `0.1.5-rc.2`，第一个 Linux 上能起 web 的版本）。

新增配置：`webInstallPrefix` / `webInstallVersion` / `webInstallRegistry`。
新增工具 **`rw_deploy_probe`**（只读环境体检，输出结论 + 原始事实 + 修复建议）——
AI 排查时可以先拿到结构化结果，而不是自己拼命令猜。

真机验证（编译机 9.134.186.191，从「坏的」状态开始）：体检精确复现手工定位的结论
（0.1.0-rc.6 + pty=no ⇒ blocker 且给出修复版本）→ 安装 5/5 步通过 → 重新体检转为 ok 且选中新装命令
→ **用自动装出来的 dsh 端到端起 web**（token 换取 303、SPA 200 且含 `__DSH_BOOT__`）。
真实 GUI 里点「体检（只读）」也复现了同样的结论卡片与「部署并验证」按钮。

**默认安装前缀必须由远端解析。** 修一个只有真机能发现的 bug：调用方在探测前用
`resolvePrefix({home:''})` 猜了个 `/tmp/...`，于是报告的是**与真实安装位置无关**的目录可写性
（那台机器的 `$HOME` 还是指向 `/data/...` 的符号链接）。现在默认前缀由远端 `$HOME` 解析并回报，
只有用户显式配置 `webInstallPrefix` 才在本地拼绝对路径。

测试：423 通过（原 316）。新增两处**平台无关但必要**的测试基建：
`sh -n` 真实语法闸门（用 stdin 投喂——Windows 下 `bash -c` 会破坏内嵌双引号、把合法脚本
误报成 EOF），以及 i18n 静态守卫（不允许「声明了却从未渲染」的字符串，
这正是之前 token 警告文案悄悄没显示的原因）。

### 安全修复 + 新能力：把远程机器的 DSH 网页界面挂到本机（issue #46）

**issue #46 问的是「能连接远程的 dsh-web 吗？」，补一句「只当客户端用」—— 这句话决定了方向。**
它排除"让远端把界面暴露出来给人连"，指向"让本地这个 DSH 主动连出去，把远端那个 `dsh web`
当目标"。这与插件既有定位完全同构（本来就是把远程机器变成工作区），所以本次把「远程工作区」
扩展成「远程界面」。

**顺带发现并修掉一个真实安全缺陷（本身独立成立，且是新端点的前置条件）。**
插件自己注册的 `/dsh-remote/*` 路由**完全没有 DSH 的 Host/Origin 栅栏，也没有浏览器认证** ——
DSH 的 `requestRejection` 只挂在 `/api` 前缀与 `/api/remote.mux` 升级路由上。在 0.8.35 的实机
（127.0.0.1:3080）实测：

- `POST /dsh-remote/forwards` 带 `Origin: https://evil.example.com`（且用 `text/plain`，
  浏览器**不会**发 preflight）返回 **200**，而且那个转发定义**真的落进了 `forwards.json`**；
- `Host: evil.com` 也返回 200（DNS rebinding 根本不需要 Origin）；
- `GET /dsh-remote/machines` 直接吐出 host/user/port/workspace。

同样的请求打 DSH 自家的 `/api` 是 403。**能触发就能作恶**：任何用户访问过的网页都可以借此
建隧道、改机器清单、甚至触发 `update-apply`（装包 + 重载插件）。

修法是复用 DSH 的权威判定而不是另写一套：`lib/http-transport.js` 现在用 `guardRoute()`
包住每一个 `webServer` 路由，优先问 `connection.requestRejection`，没有该服务时退回到
**fail-closed** 的兜底（跨站 / Origin 与 Host 不符 / 非 loopback Host 一律拒绝）。
非浏览器调用方（curl、脚本）与进程内调用方不受影响 —— 与 DSH 自己的语义一致；
`/api` 那条孪生路由**刻意不重复包一层**。

**新能力：`lib/web-attach.js`。** SSH 连出去，在选定机器上启动（或复用）一个**只监听
127.0.0.1** 的 `dsh web`，再把它的端口经 SSH 隧道搬到本机的 loopback 端口。在一台真实
Linux 主机上验证：**一个纯 TCP 转发就够了** —— SPA、静态资源、以及 `/api/remote.mux` 的
WebSocket 升级（HTTP/1.1 101）全部正常通过，不需要反代、不需要改写 host。原因是 DSH 把
认证 cookie 绑定在请求 authority 上，所以按 `127.0.0.1:<本地端口>` 签发的 cookie 正好就是
浏览器随后发回同一 authority 的那一个。

启动令牌**只存在于 stdout**（进程内 `randomBytes`，不落盘、无环境变量入口），所以解析
`dsh web: http://127.0.0.1:<port>/?token=…` 这一行拿到它；`--port 0` 让远端自己挑端口，
而同一行会把挑到的端口报回来，两者从同一行读出因而必然一致。默认**不会**杀远端进程，
要用「断开并停止远端」，且只作用于本次由插件启动的进程。

设置页新增「远程 DSH 界面」卡片：选机器 → 连接并打开 / 打开 / 断开 / 断开并停止远端，
也可以粘贴远端已在运行的 `http://127.0.0.1:<端口>/?token=…` 直接接上（不会再启第二个）。

**三个只有真机才能发现的缺陷**（单测全都"通过"了，实机第一次跑就露出来，各补了一条回归）：

1. 语句用 `; ` 连接，而 `while …; do` 被当成独立元素 ⇒ 生成出 `do;`，POSIX 语法错误。
   每次 attach 都失败在 `syntax error near unexpected token ';'`，而等价的手写脚本却是好的。
   （`sh -c` 正是 sshd 执行命令的方式，所以必须是合法 POSIX sh。）
2. `stopRemote` 实际什么都没做：它 `pkill -f` 会话日志路径，而那个路径只作为**重定向**出现、
   从不进入 argv，所以匹配不到任何进程 —— 实机观察到远端 DSH 仍在监听。
3. 给 (2) 打的第一版补丁改成匹配 argv 里的**端口**，同样永远不会命中：启动刻意用
   `--port 0`，真实端口是事后才从启动行读到的。

现在改为向记录的 PID 的**进程组**发信号（启动走 `setsid`，子进程即组长，组内正好是我们
启动的那棵树 —— 不会误伤用户自己的 DSH，也不会误伤另一个 attach 会话），发信号前先用
`/proc/<pid>/cmdline` 复核它仍然像个 `dsh` 进程，避免 PID 复用误杀；顺带清掉本次的日志文件。

**测试**：346 通过（原 316）。新增 `test/route-fence.test.js`（12 例）做了负对照 ——
把栅栏去掉后其中 7 例立刻变红，而 5 例"必须仍然可用"的对照保持绿色。
`scripts/integration-web-attach.mjs`（10 项断言）与
`scripts/integration-route-web-attach.mjs`（13 项断言）打真实主机，全绿。

## 0.8.35 — 2026-10-02
### 修 issue #44：`rw_search` 大目录搜索会把会话永久卡死；并入 PR #45 的 `rw_edit` 别名

**issue #44 是真缺陷，报告人的根因分析逐条成立**，且比"跑得慢"更严重：不是慢，
而是**逐条目等满超时定时器**，等效永久卡死。实测复现：SFTP 通道死掉后，每次
`stat` 都要等满 `commandTimeoutMs`（默认 20s）才失败 —— 一条 `stat`+`readFile`
就是 40s，数万条目 ≈ 天级，而 `session/cancel`、steer、timeout-policy 全部无效
（DSH 的工具取消是**协作式**的：工具不响应 `exec.signal`，谁也叫不停它）。

四处修复（对应报告的四点建议）：

- **搜索可取消**（`lib/search.js`）：`searchTree` / `searchViaShell` 接收
  `exec.signal`，在每个目录、每个条目检查；取消时**返回已扫到的部分结果**
  并标 `CANCELLED`，而不是抛错丢掉进度。
- **通道死了要立即失败**（`lib/pool.js`）：ssh2 的 SFTP 通道 EOF 时只清理
  "当时挂起"的请求，之后新发的请求永远没有回调 —— 现在在 `end`/`close`/`error`
  上标记通道已死，后续操作立刻以 `sftp channel closed` 拒绝。
  另给 `c.sftp(cb)` 打开子通道本身加了超时（此前远端无响应会永久挂起）。
- **搜索有预算上限**：新增配置 `searchTimeoutMs`（默认 60s）、
  `searchMaxEntries`（默认 50000），也可用工具参数 `maxDurationMs`/`maxEntries`
  覆盖；超限返回部分结果并标 `TRUNCATED`。
- **工具声明 `timeoutMs`**：`rw_search` 现在把预算作为 `timeoutMs` 交给
  `@deepseek-ai/dsh-tool-call-timeout-policy`，配合上面的取消支持才会真正生效
  （该策略只能"请求"工具停止，工具不配合就等于没有）。
- **默认跳过机器级缓存树**：搜索默认忽略 `~/.npm`、`~/.cache`、`~/.cargo` 等
  （报告里点名的 `~/.npm/_cacache` 正是元凶）。**镜像同步的忽略集刻意不变** ——
  静默把缓存目录移出同步会丢数据；显式传 `path` 仍可搜索任何位置。

**防回归**：`test/search-cancel.test.js`（8 例）覆盖时间预算、abort 中途停止、
已 abort 不产生任何 IO、取消后不回退到慢路径、死通道立即失败、打开子通道超时、
以及"搜索忽略缓存但同步不忽略"。每条都做了**负对照**：去掉对应修复即变红
（取消类 3 例失败且耗时升到 5-8s，正是失控遍历的特征）。

### PR #45（@moesnow）已并入并扩展

`rw_edit` 现在同时接受 `old`/`new` 与 `old_string`/`new_string` 两种拼写。
PR 的论证经核实成立：宿主原生 `edit` 工具（`dsh-tool-fs`）声明的正是
`file_path`/`old_string`/`new_string`，模型照抄这个习惯时会被
`invalid arguments: missing required property "old"` 拒掉。

并入时发现并补了两个缺口：

- **补上 `file_path` 别名**。PR 只做了 `old_string`/`new_string`，但 `path` 仍
  在 schema 里 `required` —— 于是模型若一并照抄原生拼写（`file_path`），依然被拒。
  三个参数的 `required` 都从 schema 移到 resolver，别名才真正生效。
- **修一个因放宽 schema 引入的回归**：`resolveRemoteArg` 对空路径会回退到
  工作区根，所以仅去掉 `required` 会让"没给路径"的 `rw_edit` 静默改写工作区根。
  现在先校验**原始参数**是否存在，再解析。

**同时修了我上一轮引入的一个缺陷**：`test/docs-images.test.js` 依赖 Python +
Pillow 做像素级检测，在没有 PIL 的环境（PR 作者的环境）会**误报失败**。
现在探测不到 PIL 就 **skip** 并说明原因，有 PIL 时照常实跑。

---

## 0.8.34 — 2026-09-30
### 主页也修同一类问题：DAU 不再显示 0，版本号不再显示「—」

0.8.33 只修了看板，**主页漏了** —— 渲染线上主页时发现同样的两类问题：

- **主页的 DAU 仍固定取"最近一个完整日"**，于是所有心跳都在今天时显示 `0`，
  与同屏的累计装机自相矛盾。现已改为与看板一致的规则：取**最近一个有数据**的日。
- **版本号显示 `—`**：主页直接请求 `registry.npmjs.org`，而该请求在浏览器里失败
  （实测 `Failed to fetch`）。现在改为**优先读同源快照**（CI 已从 npm 拉到并落盘），
  直连只在快照缺该字段时兜底 —— 这样 registry 被拦也不会留下空徽章。
- `scripts/snapshot-stats.mjs` 增补 `npm.latest` 字段。注意它在 registry 不可达时为
  `null`：本机因频繁查询撞到 **HTTP 429**（环境限流，非脚本问题 —— npm CLI 仍能取到）。
  页面有"字段存在才写"的守卫，`null` 不会渲染成假版本；CI 的出口 IP 未被限流。
- 提交前**还原了本机生成的快照**：我的限流运行把 `latest=null` 写进了数据文件，
  而那份数据应由 CI 产出。

## 0.8.33 — 2026-09-30
### 用量看板：DAU 不再显示 0，npm 摘要不再粘连

跑上线后的页面时实测发现两个真缺陷：

- **DAU 显示 `0`，而同一屏的累计装机显示 `53`** —— 自相矛盾且误导。
  根因：早先为了避免把"今天只过了一半"读成暴跌，DAU 卡片固定取**最近一个完整日**；
  但当所有数据都落在今天时（新项目很常见），那一天的 0 就成了唯一可见的数字。
  现在改为显示**最近一个有数据的日**，并且当它就是今天时明确标注
  **「（进行中）」** —— 既不隐瞒也不假装是终值。
- **npm 摘要三项糊成一片**：渲染成 `近一周 1,814近一月 8,2414 天为 npm 上报缺口`。
  已拆成独立项并加分隔线。

- 验证方式：本地起静态服务器用**真实 GitHub Pages 数据**渲染（`file://` 下
  fetch 取不到同源 JSON，会显示 "—"，那是测试环境限制而非页面问题），
  确认 DAU=53 且标注「进行中」、摘要为三个独立项、切 EN 后标注与表头同步切换。
- 全量 `npm test` 269/269；`node check.mjs` 通过。

## 0.8.32 — 2026-09-30
### GitHub Pages 站点改为中文优先，并修掉站点里与代码不符的事实错误

**中文优先**（与仓库首页切换为中文化的口径一致）：
- 两个页面（插件主页 `/` 与用量看板 `/stats/`）现在**默认中文**。
  中文写在 HTML 骨架里，不是靠脚本注入 —— 因此**禁用 JS 或首屏那一刻就是中文**，
  不会闪英文（`<html lang="zh-CN">`）。
- 右上角提供 **中文 / EN** 切换，选择存 `localStorage`；只有显式选过 EN 才用英文。
- 图表内嵌文案（柱图 tooltip、分布表头、空态提示）也随语言切换重绘。

**修掉两处站点的真错误**（站点等于第二份产品说明，会和代码漂移）：
- **4 个工具名写错**：站点列的是 `rw_workspace` / `rw_list` / `rw_read` / `rw_write`，
  而真实名字是 `rw_pick_workspace` / `rw_list_dir` / `rw_read_file` / `rw_write_file`
  （以 `lib/index.js` 的 `defineTool` 为准）。用户照抄会直接失败。
- **默认值写错**：站点写 `auditLog` 默认 `false`，真源是 `true`。
  同时补上 `maxOutputChars`，并改为只列常用项 + 指回 README 的完整表（26 项）。

**修复过程中撞出并修掉的一个真缺陷**：语言切换原本对**容器**也整体写
`innerHTML`，把内部的 `data-zh` 子元素连同属性一起抹掉 —— 表现为"点一次 EN 后
标题永久卡在英文，切不回来"。现在只重写**叶子节点**（内部不再含 `data-zh` 的
元素），并顺带修好 `<h1>` 里 `<br>` 两侧文案粘连（"变成真正的DSH 工作区"）。

- **新增 `test/docs-i18n.test.js`（7 例）**，把"中文优先"与"站点不得与代码矛盾"
  变成机器判据：
  1. 两个页面都声明 `lang="zh-CN"`；
  2. 去掉 `<script>`/`<style>` 后**骨架本身**必须有足量中文（防"靠脚本注入中文"）；
  3. `data-zh` / `data-en` 数量相等且**按序成对**（防切语言时配错句）；
  4. `applyLang` 必须跳过含子 `data-zh` 的容器（守住上面那个真缺陷）；
  5. 默认语言变量必须是 `'zh'`，只有显式存过 `'en'` 才切英文；
  6. 站点文档里出现的每个 `rw_*` 都必须真实存在，且总数恰为 20；
  7. 站点配置表里的默认值必须与 `Config` schema 一致（含常量解析，
     如 `updateMode` → `DEFAULT_UPDATE_MODE` → `auto`）。
  已用**负对照**验证：把 `rw_list_dir` 改回错名 ⇒ 立即变红；把默认语言改成 `en`
  ⇒ 立即变红；恢复后全绿。

- **测试**：全量 `npm test` **269/269**；`node check.mjs` 通过。

## 0.8.31 — 2026-09-30
### 补齐缺失的 GitHub Release，并加发布完整性检查

- **补齐 7 个缺失的 Release**：`v0.8.24` ~ `v0.8.30` 此前只有 tag、没有 Release 页
  （最早从 0.8.19 之后就断档，一直到这轮才发现）。每个 Release 都包含：
  - 该版定位与**是否值得升级**的说明；
  - **是否需要重启才生效**（0.8.24 之前不能热切换）；
  - 升级命令、npm 版本页与完整变更记录链接；
  - 行为变更与关键修复的显著标注（0.8.27 的默认值变更、0.8.29 的"插件整个消失"）。
  `Latest` 标记已正确落到 `v0.8.30`。
- **说明原因**：tag 与 Release 是两件事。用户从 Release 页判断"要不要升级"，
  而 npm 上的版本、GitHub 上的 Release、代码里的 tag 会各自漂移——这次就是
  tag 一直在打、Release 一直没建。
- **新增 `scripts/check-releases.mjs`**：一条命令核对每个 tag 是否**同时**
  有 GitHub Release 与可下载的 npm tarball，缺失即非零退出（可挂 CI）。
  支持 `--all`（全量，默认只看最近 15 个）与 `--json`。
  实测：41 个 tag 全部齐全；并用"查询不存在的版本"做负对照，确认它真的能报缺失。

## 0.8.30 — 2026-09-30
### README 更新，并把仓库首页切换为中文

- **主 README 改为中文**：`README.md` = 中文（仓库首页），`README.en.md` = 英文。
  GitHub 只把 `README.md` 当首页，所以"主语言"就是文件名本身。
  用 `git mv` 重命名，历史保留；`README.zh.md` 留成**跳转占位**，
  让 npm 页、博客、镜像等既有外链不至于 404（此前 npm 的 `readmeFilename`
  恰好解析成 `README.zh.md`，也在 `package.json` 里显式钉为 `README.md`）。
- **补两版缺失的内容**（对齐 `lib/index.js` 的 `Config` schema 与真实实现）：
  - 配置表补 `passphrase`、`maxOutputChars`(200000)、
    `updateMode`(`auto`)、`updateCheckIntervalMs`(6h)、`updateAutoReload`(true)；
    并按 schema 补上 `useAgent` / `keyboardInteractive` / `proxy` / `autoPush` / `encoding`；
  - 中文版补回原先缺失的「常见问题 / 排查」整节（英文版一直有）；
  - 两版补「DSH 版本兼容性」小节，说明 0.8.29 为何把 peer 改成跨线区间、
    以及"升级 DSH 后插件整个消失"这一现象的原因与修法。
- **修正与代码不符的描述**：`rw_search` 实际是 **`rg` → `grep -R -E` → SFTP 遍历回退**
  （英文版原写"SFTP tree walk"，中文版写"POSIX 优先"，只有后者对）；
  `rw_edit`/`rw_remove`/`rw_forward`/`rw_download` 等条目补上真实行为与上限。
- **删掉英文 README 里的一整段中文重复内容**：0.8.25 加遥测章节时误把中文版
  也插进了 `README.md`（用 `<!--中文-->` 分隔），英文读者会看到重复段落、
  两版也更容易漂移。现在每种语言只有一份、只在自己的文件里。
- **贡献者名单补上 #43 的 @zhz1667**（该 PR 虽未直接合并，但它定位到
  `evaluatePluginCompatibility()`，0.8.29 的修复建立在它之上）。

- **新增 `test/readme-parity.test.js`（9 例）**：把两版必须一致的部分交给机器守，
  不再靠人工同步。检查项：
  1. 两版互指的语言切换行存在且不指向旧文件名；
  2. `README.zh.md` 只能是跳转占位（防止它又长成第二份全文）；
  3. 章节**按位置显式配对**（只比数量不够——把某节内容搬走仍会"各 14 节"）；
  4. 两版配置表的键集合完全相同；
  5. 配置表的每个键都**真实存在于 `Config` schema**（防文档发明配置项或留下幽灵行）；
  6. 两版列出的 `rw_*` 工具集合相同且为 20 个；
  7. 兼容性小节双语都在且都提到 0.8.29；
  8. 遥测政策每种语言只出现一次（守住上面那个回归）。
  已用负对照验证：故意让英文版漏掉一个配置键 ⇒ 测试立即变红。

- **测试**：全量 `npm test` **262/262**；`node check.mjs` 通过。

## 0.8.29 — 2026-09-30
### 兼容 DSH 0.2.0-rc.2：peer 范围改为**同时**相容 0.1 与 0.2 两条线

**问题（真实故障）**：DSH 在 profile 导入插件前会校验 `peerDependencies` 中所有
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 声明，**任一条不匹配就在 boot 时整包丢弃**
（没有设置页、没有 `rw_*` 工具）。判定谓词（已从 `@deepseek-ai/dsh-app-boot@0.2.0-rc.2`
的实际代码与原样切出的判定函数验证）：

```js
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

而 npm 上 `@deepseek-ai/dsh` 的 **`latest` 已经是 `0.2.0-rc.2`**，插件原先声明的
`^0.1.0-rc.6` / `^0.1.2-rc.1` 在 0.x 上被 caret 锁死在 `<0.2.0` ⇒ **在 DSH 主线上一装就被丢弃**。
感谢 @zhz1667 在 PR #43 报告并定位到 `evaluatePluginCompatibility()`。

**为什么没有直接采用 PR #43 的改法**：它把 peer 全部提升到 `^0.2.0-rc.1`，
这**只是把故障从 0.2 线挪到了 0.1 线**——`^0.2.x` 同样被 caret 锁死在 `[0.2.0, 0.3.0)`，
于是所有仍在 0.1 线的安装（含作者本机 `0.1.5-rc.2`）会反过来被判不兼容、整包丢弃。
用官方判定函数实测的对照：

| 清单 | dsh 0.1.2-rc.1 | dsh 0.1.5-rc.2 | dsh 0.2.0-rc.1 | dsh 0.2.0-rc.2 |
|---|---|---|---|---|
| 改动前（`^0.1`） | ✅ | ✅ | ❌ 丢弃 | ❌ 丢弃 |
| PR #43（`^0.2`） | ❌ 丢弃 | ❌ 丢弃 | ✅ | ✅ |
| **本次（跨线区间）** | ✅ | ✅ | ✅ | ✅ |

**本 PR 的改法**：peer 范围改为**跨线开区间** `>=0.1.0-rc.6 <0.3.0`
（client 侧三条按各自原有下界为 `>=0.1.2-rc.1 <0.3.0`），同时容纳两条线，
并在 `dsh.engines.dsh` 写上同样的边界（仅供人阅读——官方 README 明确
"These checks use peer declarations, not `engines.dsh`"，它**不参与**判定）。

- 保留全部原有下界：扩展下界时**不抬高**任何既有门槛，0.1 线用户不受影响。
- 上界止于 0.3：0.3 未知，不盲目承诺（当前 `0.3.0-rc.1` 仍会被区间容纳，
  这是 semver 预发布比较的既有语义，非本次承诺；有测试覆盖上界有效）。
- `@deepseek-ai/cordis` 不是 `@deepseek-ai/dsh-*`，**不参与**该校验，保持 caret。
- **`lib/` 一行未改**——本次只用 0.1 与 0.2 都存在的 API，无需适配。
- 新增 `test/compat.test.js`（7 例）：范围不得使用 caret（0.x 上必然锁死一条线）、
  必须同时有下界与上界、必须容纳两条线、原始下界必须仍在范围内、
  上界必须拦住 0.3、`engines.dsh` 与 peer 一致、cordis 保持 caret。

- **测试**：全量 `npm test` **253/253**；`node check.mjs` 通过。
- 新增 devDependency `semver`（仅为复现 DSH 自己的判定谓词）。

## 0.8.28 — 2026-09-30
### 修 `isInstalledCopy` 的跨平台路径判断（0.8.27 CI 红）

0.8.27 的"拒绝对非安装副本自更新"逻辑在 Linux CI 上误判：`isInstalledCopy`
只按 `path.sep` 切分路径，于是在 Linux 上判断 Windows 风格路径时
（`C:\...\node_modules\dsh-remote`）切不开，被判为"非安装副本"——本机 Windows
全绿、CI 直接红（246 例 fail 1）。现在同时把 `\` 与 `/` 归一化，两种平台的
路径都给出正确答案。

- 教训同 `os.homedir()` 那一类：**跨平台判断不能依赖本机的 `path.sep`**，
  这类缺陷只在另一种平台上暴露，必须让判定函数自身与分隔符无关。
- 测试补充了 5 条路径用例（Windows/POSIX × 安装副本/源码检出 + CI 检出路径）。

## 0.8.27 — 2026-09-30
### 更新模式默认改为 `auto`（自动更新）

**为什么现在才敢改默认**：`auto` 在 0.8.24 之前不可能是安全的默认值——那时更新只把文件写到磁盘、必须重启才生效，用户会处在"浏览器半是新版、宿主半是旧版"的错位状态且毫无提示。0.8.24 补上了宿主半热切换（以及关闭时的 `pendingReload` 提示），自动更新现在才真正落地生效。

- **默认值**：`updateMode` 从 `manual` 改为 **`auto`**（加载时 + 每 6 小时检查并自动应用，随后热切换宿主半）。
  三层优先级不变：**设置页持久化的 `update-mode` 文件 > profile 配置 > 默认值**。
  想保持手动的人不受影响（设置页选一次 `manual` 即持久化），需要彻底关掉可设 `off`。
- **默认值收敛到单一常量 `DEFAULT_UPDATE_MODE`**：`manual` 这个字面量原先散落在
  三处（schema 默认、`/update-check` 响应、auto 开关判断）。改默认时漏掉任何一处
  就会出现"schema 说 auto、实际行为还是 manual"的不一致——第一版改动就是这样漏了
  两个 `|| 'manual'` 兜底。现在改默认只需改一行，并有测试钉住不得回退成字面量。
- **新增防护：拒绝对非安装副本自更新**。实测依据：`selfDir()` 基于
  `import.meta.url`，而 **Node 的 ESM 解析会对符号链接做 realpath**（已实测：经
  symlink 导入时 `import.meta.url` 报的是 realpath）。于是以 `link:`/开发模式安装时
  `selfDir()` 指向**用户的源码仓库**，`auto` 一旦落地就会用 npm 包覆盖源码
  （丢改动、脏工作树）。现在 `applyUpdate` 在目录不在 `node_modules` 下时直接拒绝，
  设置页也会明确提示原因。默认改成 `auto` 正是把这个风险从"手点才触发"放大成
  "自动发生"，所以必须同时补上。
- **修掉一个进程挂起**：`fetchLatestVersion` 的 8s 看门狗定时器没有 `unref`，
  于是任何"挂载后即空闲"的进程都会被它拖住。实测表现：`upload.test.js` 因默认变
  `auto` 而启动更新定时器，该测试的 `effect` 桩不保存 disposer 故定时器无法清理，
  **`npm test` 直接超时 420s**。现在看门狗 `unref`，且所有调用真实 `apply()` 的测试
  必须显式钉住 `updateMode`（有测试强制这一点）。

- **测试**：新增 `test/update-default.test.js`（7 例：常量即默认、schema 用常量而非字面量、
  无 `manual` 硬编码兜底、auto 开关读同一常量、设置页初始态、看门狗 unref、
  所有挂载插件的测试都钉住 updateMode）+ 2 例安装副本判定与拒绝自更新。
  全量 `npm test` **244/244**（6.8s，恢复正常）。
- **验证**：真实沙箱启动后 `/dsh-remote/update-check` 返回
  `updateMode:"auto"` 且 `selfUpdateAllowed:true`；并用同版本源实测 auto 的判定链与落地
  （`auto would update? true` → 文件被替换 → 磁盘版本推进）。

## 0.8.26 — 2026-09-30
### 插件主页 + 实时用量看板（GitHub Pages）；修掉会污染统计的两处缺陷

**Pages 站点**（`https://flymysql.github.io/dsh-remote/`，源目录切到 `/docs`）：
- `docs/index.html` **插件主页**：hero + 实时计数（版本 / 周下载 / star / 日活）、能力卡片、
  20 个 `rw_*` 工具面、界面截图、安装块（含"0.8.24 之前首次升级需重启一次"的提示）、
  以及遥测与隐私表格。
- `docs/stats/index.html` **用量看板**：DAU / WAU / MAU / 累计装机 KPI、逐日日活柱图、
  npm 下载对照图、版本与平台分布。
- 图表是**手写 SVG**：本仓库刻意零构建，为了一个看板引入图表库不划算。

**架构上的硬约束（决定了不能"前端直连云端"）**：
- GitHub Pages 是**完全公开**静态站 ⇒ 统计口令**绝不能进前端**；
- CloudBase 的 HTTP 访问服务**不返回 CORS 头**，浏览器本来也直连不了 `/stats`。
- 因此由 `scripts/snapshot-stats.mjs` 在 CI 里拉数据（口令放 GitHub Secrets），
  写成同源的 `docs/data/{stats,history}.json` 给页面读；`.github/workflows/pages-data.yml`
  每 6 小时刷新一次，且**只在数据真的变化时才 commit**（避免空提交噪声）。

**顺手修掉两个会污染统计的真缺陷**（都是端到端验证时发现的）：
1. **测试会往生产统计灌数据**：`upload.test.js` 调用真实 `apply()`，而 `apply()` 里有
   `void sendHeartbeat(...)` ⇒ 跑一次 `npm test` 就在线上日活表写下假装机
   （实测表现为"一台只跑过 Windows 的机器冒出两个 Linux 装机"）。现在端点可用
   `DSH_REMOTE_HEARTBEAT_URL` 覆盖（仅接受 https），并由 `test/setup-telemetry-off.mjs`
   通过 `--import` 在**任何业务代码加载前**重定向整个测试进程；另加一条断言，
   一旦 URL 指回生产就失败。
2. **延迟发送可能永远发不出去**：启动延迟定时器被 `unref()`，而 await 一个已 unref 的
   定时器不会让事件循环保活 ⇒ 进程若无其他 pending 句柄会**直接退出**，心跳一次都发不出
   （CI 每轮必现，本地因其它测试占着句柄而侥幸变绿）。延迟的目的是让发送成功，就必须留住进程。

**看板刻意"暴露"而不是隐藏的数据质量问题**：
- npm 的零值日画成灰色并标注为**上报缺口**（对照包零值日完全一致 ⇒ 管线缺口，非真实零使用）；
- 今天的柱**压暗**表示"未完整"，且 DAU 卡片显示的是**最近一个完整日**，避免把半天读成暴跌；
- 页面明确写出**版本覆盖偏差**（只有升级到含心跳版本的安装会上报 ⇒ 这些数字是下限，不是全部用户）。

- **测试**：`npm test` 236/236；`node check.mjs` 通过。

## 0.8.25 — 2026-09-30
### 安装心跳：可测的真实日活（去重装机 / 在跑版本 / 平台分布）

**背景**：到 0.8.24 为止，"有多少人在用"只能靠代理指标，而且都不成立——
npm 下载量由**发版**驱动（活跃版本占近周 1955/2078、旧版本地板 ≤21），且日粒度存在
**上报缺口**（dsh-remote 2026-09 的零值日为 09-03/07/08/15/29/30；用 dsh-better-sidebar
与 dsh-vision-router 对照，**零值日完全相同** ⇒ 是 npm 管线缺口，不是真实零使用）；
GitHub clone 里混着 CI 与爬虫。这些都无法回答"多少人真的在用、用的哪一版、在哪个平台"。

- **新增每次启动一次的匿名心跳**（同安装最少间隔 6 小时），落库到 CloudBase：
  `dsh_remote_hb_daily`（`_id = day:idHash`，每天每装机一条）+ `dsh_remote_hb_install`
  （`_id = idHash`，装机量/留存）。**日活 = 当天文档数**，靠确定性 `_id` 天然幂等去重，
  不用唯一索引以避免竞态。
- **隐私边界（硬约束，写进 `lib/telemetry.js` 顶部注释与 README）**：
  上报字段严格白名单 `{idHash, version, platform, arch, node}`；`idHash` 是
  `HMAC-SHA256('dsh-remote/telemetry/v1', installId)[:32]`，**原始 installId 不离开本机**，
  服务端无法与其他数据交叉关联。本插件能拿到 SSH 主机/路径/机器列表，这些**一律不上报**。
  测试里有一条断言专门守"请求体不得包含原始 installId"。
- **身份存放位置是刻意的**：`<DSH_HOME>/.dsh-remote-install-id`（**不是**插件目录）。
  插件目录每次 pnpm 重装都被覆盖，放那里会让同一台机器每次升级都换身份，
  把 1 个用户算成 N 个。进程内缓存**按身份文件路径分键**（同一进程出现第二个
  DSH_HOME 时不会串号）——这条是测试抓出来的真 bug。
- **心跳是尽力而为的旁路**：`void sendHeartbeat(...)`，不 await、不阻塞加载、
  失败静默；失败时**回滚节流**，避免一次网络抖动让该身份静默 6 小时，
  把"网络不可达"错记成"用户当天没来"。
- **避开启动高峰**：首帧 fetch 会因 DSH 启动期并发初始化被饿死
  （实测 5s 超时下稳定 `This operation was aborted`，只剩 250~520ms 的端点却发不出去），
  故超时放宽到 15s 且首次发送延迟 3s —— 延迟是为了**让它成功**，不是为了让人等。
- **新增 `scripts/stats.mjs`**：一条命令读出「逐日日活 + 累计装机 + 版本分布 + 平台分布」，
  并在输出里直接写明口径提醒（只有装了含心跳版本的安装会上报 ⇒ 首发后前几周
  日活会被系统性低估，应配合 npm/GitHub 做总量校准）。
- **配置**：无开关，默认开启（按作者要求）。`updateAutoReload` 等既有配置不变。

- **测试**：新增 `test/telemetry.test.js`（10 例：身份跨进程稳定/坏文件自愈/伪名不等于原始 id/
  两安装伪名不同/字段白名单/失败静默且可重试/节流/启动延迟）。全量 `npm test` 234/234。
  **真机端到端**：隔离沙箱启动真实 DSH → 云端出现该装机的行，且
  `HMAC(salt, 本地 id)` 与云端 `idHash` **逐字节吻合**（证明上限就是伪名）。

## 0.8.24 — 2026-09-30
### 更新落地即生效：宿主半在线热切换 + 原子落盘 + 「已应用 vs 已加载」版本区分

**背景**：`auto`/手动更新此前只把新文件写到磁盘，宿主半（`lib/index.js`：`rw_*` 工具、
`/dsh-remote/*` 路由、SSH 池）要等下次启动 Harness 才生效 —— 而浏览器半（`lib/client.js`）
会被 DSH 的 `client-hmr` 自动热替换。于是更新后 UI 是新版、工具还是旧版，两者长期错位。

- **宿主半在线热切换（新增 `POST /dsh-remote/update-reload`，更新后默认自动执行）**：
  `lib/update.js` 的 `reloadSelf()` 先清掉本包自身模块的 Node 缓存
  （ESM `loadCache` + CJS `require.cache`），再 `_dispose()` 我们自己的 loader entry
  （工具、路由、SSH 池随 fiber 一起回收），最后 `init()` 重新 import 磁盘上的新代码。
  - **为什么必须自己清缓存**：ESM 按 URL 缓存模块，只用 `_dispose()+init()` 会拿到**旧模块对象**，
    看起来"热更新成功"实际一行没换。已用真实 cordis Loader 的进程内 E2E 证明
    （`scripts/hotswap-e2e.mjs`，9/9：改写磁盘模块 → 切换 → 运行中的代码确实变成新版本）。
  - **Node 24 细节**：`loader.internal.loadCache` 是 `LoadCache extends SafeMap`，
    `instanceof Map` 为 **false**，但 `Map.prototype.has/delete.call(loadCache, url)` 实测有效
    （已实证），故用显式 `Map.prototype` 调用而不是 `loadCache.delete()`。
  - **失败不致命**：切到坏模块会像启动失败一样**响亮报错**并保持进程存活；此时旧代码已 dispose，
    需修好文件后重启（与"boot 到坏文件"同样的结局，不会静默跑半个插件）。
- **原子落盘**：`applyUpdate` 从 `copyFileSync` 改为**临时文件 + `rename`**。
  这不是洁癖 —— client 半每 500ms 被 `dsh-client-hmr` stat-poll 并按**内容哈希**重算 rev，
  一次撕裂写会被当场 re-hash 并推给浏览器；且写一半的 `lib/index.js` 会让下次启动直接崩。
  另：**逐文件跳过字节相同的文件**，所以重复 apply 同一版本不再无谓搅动 mtime。
- **修正 `auto` 模式会反复重下同一个包**：`currentVersion` 原先在定时器闭包外只取一次，
  成功更新后它仍停在旧版 ⇒ 每个 `updateCheckIntervalMs` 都重新下载并覆盖写一遍全部 lib 文件。
  改为每轮取「磁盘版本 / 已加载版本」中较新者。
- **`loaded` vs `disk` 版本区分**：新增 `LOADED_VERSION`（import 时快照）与 `diskVersion()`。
  `/dsh-remote/update-check` 现在返回 `loaded` / `disk` / `pendingReload`，
  `current` 保持为**运行中**版本（UI 兼容）。`readVersion()` 读的是磁盘，更新后它立刻显示新版，
  此前会让设置页在成功后仍报"有新版本"。
- **修正 `/dsh-remote/update-apply` 的 `from` 字段**：原先在 `applyUpdate()` **之后**取版本，
  于是 `from === to`（永远显示 `0.8.24 → 0.8.24`）。现在 apply 前取。
- **新增配置 `updateAutoReload`（默认 `true`）**：设为 `false` 时只落盘不热切，
  由 `pendingReload` 提示用户重启。
- **UI**：更新成功后延迟 2s 再复查（宿主半约 300ms 后才切换，立即复查会问到旧 fiber 而误报"仍有新版本"）；
  新增 `pendingReload` 提示条；确认框与成功文案改为"在线热切换（不重启 Harness）"。

- **测试**：新增 `test/update.test.js`（15 例：tarball 安装/版本不匹配拒绝/失败不落地/
  原子写/幂等跳过/缓存清理/entry 重挂/失败降级）+ `scripts/hotswap-e2e.mjs`（真实 Loader 端到端）。
  全量 `npm test` 224/224。

## 0.8.23 — 2026-09-28
### 性能修复：远程路径自动补全逐字符卡顿（issue #41，PR #42 by @GDWhisper）+ 机器身份硬化

**issue #41 —— 在工作目录选择器里输入远程路径，每敲一个字符都重连一次 SSH**

- **现象**：远程 tab 的路径输入框里补全每敲一个字符卡 0.5–2 秒，打字快了请求还会排队、
  越打越慢；与目录条目多少关系不大，链路稍有延迟就非常明显。
- **根因**：输入时每敲一个字符都会 `POST /dsh-remote/current`，而该路由会经
  `applyActiveMachine → pool.setTarget` **无条件关闭 SSH 连接**并清空平台检测缓存
  （`setTarget` 里 `this.close()` 是唯一的收尾分支）。于是每次按键的真实成本是
  「重连 + 重新探测平台 + 重列同一目录」，而不是单纯查目录。
- **修复（PR #42，@GDWhisper）**：三层，缺一不可。
  1. **`SshPool.setTarget` 目标未变即空操作**：不再关闭活连接、不再清平台缓存。
     调用方若因共享 config 已被就地改写而无法与自身比较，可传入**改动前的快照**
     作为 diff 基线（`previous` 参数）—— 这是"切换机器必须断开旧连接"（issue #25
     的错主机隐患）得以保留的关键。
  2. **`setCurrent` 幂等**：同一台机器且已生效时，不重写注册表、不重读凭据、不重设池。
     指纹在 `applyActiveMachine` 内部维护，因此开机恢复、`rw_connect save:true`、
     `POST /current` 三条路径都不会漂移。
  3. **选择器客户端缓存**：`POST /current` 只在**切换机器**时发（`ensureCurrent`，
     并发调用共享同一个 in-flight promise，失败则 reject 而不是污染缓存）；
     目录列表按 `(机器, 目录)` 做 30s TTL 缓存 + 同键并发合并（`fetchDirList`）；
     过期的补全响应按序号丢弃，不会覆盖新输入；重新打开选择器整体重置。
- **实测（真机 9.134.186.191:36000，真实 SSH/SFTP + 从 `lib/client.js` 提取的真实
  选择器逻辑，非 mock）**：预热后**单字符补全 1099ms → 31ms**（**35 倍**），
  每字符主机请求 **2 → 0**；重打同一路径 1146ms → 31ms、0 次请求。首次按键
  （必然冷拨号）仍约 1.1s，之后同一目录内连续输入基本秒出。
- **顺手修掉的两个正确性缺陷（同一 PR 自审）**：切换机器时 `applyMachine` 会**就地
  改写共享 config**（`pool.config` 就是这个 config），于是与自身比较恒等、空操作恒成立、
  机器切换后仍复用旧 SSH 客户端（错主机）；映射改为显式传改动前快照。另外
  `invalidate()` 现在与 `close()` 一样触发 `onCloseHook`，避免转发管理器挂在已死客户端
  上的 `close → stopAll()` 监听器把重新挂到新客户端的转发拆掉。
- **机器身份硬化（0.8.23 补丁，合并后追加）**：PR #42 删掉了**每次按键**的
  `POST /current`，而那正是「让 active pool 钉在选择器机器上」的机制；配合新的客户端
  缓存，**缓存命中的重打字是零主机请求**，于是 commit 前没有任何东西重新应用选择器
  机器，而 `/mirror` 不携带机器身份 ⇒ 会用**当时 active 的机器**建镜像。`/ls` 的
  identity 回显挡不住这一点：缓存按 machine id 键控，命中时不校验任何东西。
  真机复现：选择器显示 A 的目录树，外部「设为当前」切到 B 后提交，镜像 identity
  变成 B。pre-0.8.23 因 commit 前总会重发 `/current` 而偶然掩盖。修法：`/mirror` 与
  `/home` 接受**可选 `machineId`** 命名调用方所展示的机器，host 在**目录探测之前**
  重新断言该机器；**未知 id 返回 404 拒绝**（静默回退到 active 本身就是危险）；
  缺省 id 保持原语义，老客户端与设置页的 workspace 流程完全不受影响。
  新增 `test/mirror-machine-identity.test.js`（4 种路由层顺序 + 客户端调用形状）。

## 0.8.22 — 2026-09-23
### 新功能：远程会话里的 `@` 文件补全（issue #39）+ `~/.ssh/config` 别名实时解析（issue #38）

**issue #39 —— 在 dsh 中使用 `@` 无法检索到远程目录中的文件**

- **现象**：本地工作区里输入 `@` 会列出目录下的文件；用插件选了**远程**工作区后，
  `@` 什么都搜不到。
- **根因**：harness 的 `@` 候选来自 `ctx.fileReferences`，其唯一随包提供的 provider
  （`@deepseek-ai/dsh-file-reference-local`）索引的是**该 agent 会话 cwd 的本地文件系统**。
  而远程会话的 cwd 是**本地镜像目录** —— `ensureMirror()` 只创建目录和
  `.dsh-remote-meta.json`，**内容要等用户 `rw_sync` 才出现**（实测目录里除 meta 外为空），
  于是 `@` 列出 0 项。seam 的官方文档恰好点名了这个缺口：
  "other namespaces (remote or virtual filesystems) need a provider whose discovery
  matches the effective tools"。
- **修复**：新增 `lib/file-reference.js`。`ctx.fileReferences` 是单属主服务，不能再挂一个
  provider，因此**包装 `fileReferences.list`**：agent 的 cwd 落在某个镜像里 → 改从**远端**
  经 SFTP 列目录/建索引；**其余调用一律原样委派**给原实现（本地会话完全不受影响）。
- **语义与本地一致**：候选是**相对远程工作区根**的路径（`@src/main.c`），目录逐级下钻；
  无斜杠的查询在整棵远端树上模糊匹配（排序与本地 provider 同源）；隐藏项只有在查询以 `.`
  开头时出现；`.git`/`node_modules` 等默认跳过；`..` 段永远不能逃出工作区根。
- **成本控制**：条目上限 3000、目录上限 300、墙钟预算 4s、索引缓存 10s
  （过期时旧索引先答、新遍历在背后重建）、失败的远端在 30s 内**熔断**直接回退本地镜像 ——
  否则一个连不上的主机能让每次按键都等一次 SSH 超时。
- **口径对齐**：`rw_*` 工具现在接受**工作区相对路径**（新增 `resolveRemoteArg`，绝对路径
  行为不变），所以 `@` 提示出的相对路径可以直接喂给 `rw_read_file`；系统提示的
  `## Remote workspace` 段落也明确写了「`@path` 是相对**远端**根的路径、harness 内置
  read 工具只看得到本地镜像」。
- **实测（真机，非 mock）**：`scripts/integration-real.mjs` 新增第 18 节，对
  `jimmycppliu@9.134.186.191:36000` 的真机 + 真 SFTP 断言：`@` 列出的是**远端**条目
  （工作区根 + 下钻 + 模糊查询都命中远端真实文件）、候选是相对路径、本地会话仍拿到原
  provider 的答案、dispose 后 `fileReferences.list` 被还原。**56 项通过 / 0 失败**
  （唯一 skip 项是本机 `/root` 无权限读取属环境所致，已改成跳过而非误报失败）。

**issue #38 —— 支持从 `~/.ssh/config` 解析读取配置（插件自己不存副本）**

- **诉求**：像 VSCode Remote-SSH 那样把 `~/.ssh/config` 当**唯一事实来源**；插件只做解析，
  不再自己复制一份配置。
- **实现**：机器可以按**别名**保存（`useSshConfig: true`，`host` 就是 `Host` 名字）。
  注册表里**不存** HostName/用户/端口/私钥/跳板机 —— 每次连接**实时解析**，改
  `~/.ssh/config` 立刻生效，不需要重新导入（配置文本 memo 2s，避免一次请求里多台机器
  反复读盘）。设置页「从 ~/.ssh/config 导入」里点别名即按别名保存，另有「复制字段」
  按钮保留旧的"填表单"路径；机器行/表单会显示 **别名 → 解析到 user@host:port**。
- **OpenSSH 语义**（不是"读取几个字段"那么简单，全部有单测）：
  `Host a b` 多别名、`*`/`?` 通配、`!` 取反、`Include`（通配展开、相对路径按 ssh_config(5)
  先相对 `~/.ssh`、含深度与环检测）、行尾 `\` 续行、参数名/主机名大小写不敏感、引号值，
  以及最容易被忽略的一条：**ssh_config(5) 的"首个取值优先"是跨 block 的**（后面的
  `Host x` 不会覆盖前面已设过的参数；`Host *` 放在文件开头会赢得它设的参数）。
- **跳板机**：`ProxyJump` 的**单跳**会映射到插件的 `proxy`，并**递归解析跳板机自己的
  配置**（host/user/port/IdentityFile）。多跳链、`ProxyCommand` 插件无法照做 ——
  于是**显式告警**（设置页黄字 + `rw_connect` 返回文本 + 服务端 logger），绝不静默降级。
- **不跨机器串味**：镜像 meta 记录创建时的别名（`alias`），`machineRecordFor` 先按别名、
  再按**解析后的身份**（host/port/user）匹配 —— 于是别名的主机名/端口在
  `~/.ssh/config` 里改过之后，老镜像仍然能找回自己的机器与凭据。
- **默认关闭**：没有 `useSshConfig` 的机器行为**完全不变**（单测断言：同名 `build` 在未开
  别名时仍然连 `build:22`，不会被 `~/.ssh/config` 偷偷改道）。
- **实测**：新增 `test/sshconfig-alias.test.js`（25 项）。其中最关键的一条复现了 issue 的
  完整工作流：把 `HOME` 指向带 `~/.ssh/config` 的临时目录 → 保存别名机器 → **改写
  配置文件** → 同一条 `/dsh-remote/machines` 响应里的解析结果变成新主机/新用户/新端口，
  而 `machines.json` **一个字节都没动**（断言里不含 `127.0.0.1`/`mmdev`）。另外用真实
  `~/.ssh/config` 跑了一次解析：`9.134.186.191` → `jimmycppliu@…:36000` +
  `IdentityFile ~/.ssh/id_rsa` —— 与"只有 id_rsa 能过 ssh2 认证"的实测结论一致。

**其它**

- `scripts/integration-real.mjs`：支持 `DSH_IT_KEY`（用私钥跑真机集成；本次实测发现
  9.134.186.191 对 ssh2 **只认 id_rsa，不认 id_ed25519**）；启动前把机器写进隔离
  registry（否则会话绑定的池拿不到凭据）；收集插件 logger 警告；修正一个**早就失效**的
  断言（系统提示段落是会话级的，之前用 `text()` 无参调用恒为空 → 现在用真实镜像 cwd
  断言，并补上"本地会话不该有远程段落"）；`/root` 不可读时 sync 断言改为 skip 而非误报。
- 测试：`npm test` **179 项全绿**（原 128 + file-reference 26 + sshconfig-alias 25）；
  `node check.mjs` 通过。

## 0.8.21 — 2026-09-18
### 修复：主色按钮/分段页签的文字用了「填充 token」，导致对比度不足甚至不可见

**现象**：0.8.20 的分段页签（本机/远程）与主按钮，文字发灰、糊在黑底上；禁用的主按钮几乎看不清字。

- **根因**：0.8.20 把 `--dsw-alias-button-contrast-fill` 当成了"亮底上的文字色"。它是一个
  **填充（fill）token** —— 宿主自己拿它做 `background`，而非前景色。宿主主按钮的正确配对是：

  ```css
  ._primary { background: var(--dsw-alias-button-primary-fill);
              color:      var(--dsw-alias-label-primary-foreground) }
  ```

- **实测对比度**（浅色主题，浏览器内实测）：

  | 配对 | 背景 | 文字 | 对比度 |
  |---|---|---|---|
  | 0.8.20（错误） | `#0f1115` | `#61666b` | **3.26:1** ❌ |
  | 0.8.21（修复） | `#0f1115` | `#ffffff` | **18.90:1** ✅ |

  分段页签这种**正常尺寸的文字需要 ≥4.5:1**，3.26:1 明显不达标。
  更糟的是 `.dsh-rw-btn:disabled{opacity:.45}` 会把整颗按钮一起压淡：文字 `#61666b`
  与底色 `#0f1115` 一起被冲淡成 `#B8BABC` on `#939495`，只剩 **1.56:1** —— 基本读不出字。
  深色主题下两个 token 同为 `#f9fafb`，等于**白底白字，完全不可见**。

- **修复**：文字改用 `--dsw-alias-label-primary-foreground`（宿主的官方配对），两处：
  `T.onPrimary` 与 `.dsh-rw-tab.is-active` 的 `color`。

- **修复（禁用态）**：填充型主色按钮**禁用时保持纯黑实底**，不再整颗压淡。原来的
  `.dsh-rw-btn:disabled{opacity:.45}` 会让近黑的主色底褪成灰 `#939495`，白色文字再叠上去
  只剩 3:1。现改为：

  ```css
  .dsh-rw-btn:disabled{cursor:not-allowed}
  .dsh-rw-btn:disabled:not(.dsh-rw-primary){opacity:.45}   /* 次要按钮仍然淡化 */
  ```

  实测：主色按钮 **启用/禁用均为 `#0f1115` 纯黑底 + 白字 = 18.90:1**；禁用态由
  `cursor:not-allowed` 表达。次要按钮的淡化行为不变。

- **回归闸门**：`check.mjs` 新增第 6 条静态检查 `theme-token lint` —— 禁止把任何
  `--dsw-alias-*-fill` 用作文字色（`color:` / `onPrimary:`）。用 0.8.20 的代码验证该规则会
  命中 **2 处**并拦下发布；修复后为 0。

**验证**：`npm test` 128/128；`node check.mjs`（含新 lint）通过；隔离实例（独立 `DSH_HOME`，
端口 7391）装入修复后的 bundle，浏览器内用 CDP 对**实际下发的 CSS** 建按钮实测：主色按钮
启用/禁用都比对 18.90:1 且为纯黑底，并设「禁用次要按钮仍为 0.45」的对照样本来确认规则集
真的生效（避免注入失败导致的假阳性）。

## 0.8.20 — 2026-09-17
### 界面与操作：主题跟随、主按钮、键盘与内联对话框

- 设置页：机器行 hover / 状态胶囊（当前、密码、钥匙串、跳板）替代 emoji 堆叠；标签列加宽；**保存 / 设为当前 / 添加转发 / 立即更新** 使用主色按钮。
- 端口转发与审计日志可折叠；审计增加「刷新日志」，默认收起减少一屏噪音。
- 工作区选择器：分段式 本机/远程 tab；路径框 **Enter** 确认、**Esc** 关闭、**Ctrl/⌘+Enter** 设为工作区；列表 hover；主操作高亮。
- 远程文件树：新建目录 / 重命名改为主题内联对话框（不再 `window.prompt`）；右键菜单跟随 light/dark token。
- 文件 tab：编辑器文字色跟主题（不再写死深色 `#e4e4e7`）；未保存标记；**Ctrl/⌘+S** 保存、**Esc** 取消。
- 注入 `.dsh-rw-*` 焦点/hover CSS（无 `document` 的测试环境自动跳过）。hover 用中性半透明灰而不是
  `--dsw-alias-interactive-bg-hover`：宿主该 token 只有 6% 浓度，在设置页背景上几乎看不见；
  主按钮 hover 用 `opacity`，因为宿主的 primary fill 在浅色主题下本就接近纯黑，`brightness` 无效。

**验证**：`npm test`；另起一个 DSH web 实例（独立 `DSH_HOME`，端口 7391）安装 0.8.20 tarball 实测：
插件路由 200、设置页机器行/胶囊/折叠区、选择器分段 tab 与 Enter/Esc 均正常。

## 0.8.19 — 2026-09-17
### 侧栏文件接口按会话绑定机器（Desktop 多机阻断项）

- `/dsh-remote/ls`、`/read`、`/write`、`/fs` 接受 `sessionId`（或 `local=` 镜像路径），走与 `rw_*` 相同的 mirror binding；本地会话返回 403，不再落到「当前机器」连接池。
- 工作区选择器仍不带 `sessionId`，继续使用当前机器（设为当前后再浏览）。
- 客户端 explorer / 文件 tab / 原生右侧栏都会把 `sessionId` 附在请求上；保存使用 `expectedMtime` 乐观锁。
- 大文件预览改为 SFTP `readPartial` 范围读，不再整文件 `fastGet` 到可预测的临时路径。
- 同步默认 `depth=8` / `maxFiles=2000`，结果带明确 `TRUNCATED`；POSIX 远端 `rw_search` 优先 `rg`/`grep -R`，失败再 SFTP walk。
- 拆出 `lib/pool.js`、`lib/routes-fs.js`、`lib/remote-fs.js`；host-key TOFU 守卫进 `lib/hostkey.js`。
- 文档：中英文 README / `package.json` 工具数（20）/ `PUBLISH.md` 对齐当前功能。

**验证**：`npm test`；新增 session-fs / desktop-fs / remote-fs 回归。Desktop 完整 GUI 仍标实验性，但侧栏选机阻断项已修。

## 0.8.18 — 2026-09-16
### 变更：解除 dsh-better-sidebar 硬绑定

- README 首图换成由 `docs/cover.html` 渲染的 1280×640 产品封面。
- 从 `dependencies` 删除 `dsh-better-sidebar`。
- bundle patch 不再自动插入 `dsh-remote-sidebar`；安装 `dsh-remote` 现在只挂载
  `dsh-remote` 自身，避免侧边栏版本/API 变化拖垮整个插件树。
- 保留可选集成：用户单独安装 `dsh-better-sidebar` 后，client 仍会动态发现
  `betterSidebar` service 并注册远程文件浏览/编辑 tab。
- 官方 Desktop 的原生右侧栏集成不受影响；不安装 sidebar 时，`rw_*` 工具、设置页、
  同步、审计日志与端口转发均照常工作。
- README 更新为显式的双插件安装方式，并补回归测试确保 bundle 不再硬挂 sidebar。

## 0.8.17 — 2026-09-16
### 文档：README 截图改用仓库内相对路径（PR #33）

- README 截图不再走 jsDelivr CDN，改为**仓库内相对路径**（`docs/cover.png`、`docs/*.png`），
  这样 GitHub 才能把它选为 [dsh-plugin topic](https://github.com/topics/dsh-plugin)
  的卡片图；新增 1280×640 的 `docs/cover.png`（工作区选择器裁剪）作为 README 首图。

### 修复：Windows 上远程工作区路径被按盘符根解析 → `D:\home\...` ENOENT（issue #32）

**现象**（仅 Windows 触发）：连接 Linux 远端、选定远程工作区（如 `/home/os/IsaacLab`）后，
锚点与 `.dsh-remote-meta.json` 都正常，但打开该工作区立刻报：

```
cannot resolve target "D:\home\os\IsaacLab": ENOENT: no such file or directory,
realpath 'D:\home\os\IsaacLab'
```

聊天里的 `rw_*` 工具一切正常（走 SSH），只有侧边栏文件面板受影响。

- **根因**：侧边栏的**目录展开集合（`expanded`）是按会话共享的**，内核自带的本地文件树
  会把其中每一项当作**本地目录**，经 `/sidebar/api fs.tree` 交给
  `dsh-better-sidebar` 的 `path-security` 做本地 `fs.realpath()` 与工作区围栏校验。
  远程树此前通过同一个 `onToggleDir` 记录展开状态，于是**远端路径 `/home/...` 被写进了
  这个共享集合**。在 win32 上 `/home/...` 被 Node 判定为“绝对路径”（相对当前盘符），
  于是被补全成 `D:\home\os\IsaacLab` 而真实不存在 → ENOENT。
  macOS/Linux 上 `/home/...` 本身就是合法本地路径，所以该缺陷只在 Windows 暴露。
- **修复（治本）**：远程树的展开状态改为**由它自己持有**并持久化在**该 tab 的 `meta`**
  （`remoteExpanded`）里，绝不再写进会话共享集合。外观与交互不变。
- **修复（照顾已受影响用户）**：那个共享集合是**持久化在 localStorage 的**
  （`dsh-sidebar:v1:<sessionId>`），不清就一直失败。因此插件激活时先做一次**幂等迁移**，
  在本地文件树读取之前清掉其中的远端残留；tab 侧也会在解析出远程根目录后兜底再清一次。
- **删除范围刻意收窄**：只删“在本机不可能成为合法本地路径”的条目 —— 即 Windows 上的
  POSIX 绝对路径（`/home/...`）。真实 Windows 路径（`C:\...`、`D:\...`）与**本地镜像路径**
  （`$DSH_HOME/remote-workspaces/...`）一律保留；非 Windows 宿主不做这项广泛清理
  （那里的 `/home/...` 本身合法），只按当前远程根目录范围清理。
  面板几何、已开 tab、tab meta、底部面板等其余状态均原样保留。

**验证**：`npm test` 117/117（client-lifecycle 新增 3 例：共享集合不再被当作树状态 /
Windows 全量清扫 / 启动期迁移；并断言非 Windows 不误删、无关键与不可解析值保持原样）；
`check.mjs` 通过。真机（隔离 profile + 新端口）实测：注入污染状态后刷新，
远程路径的 `fs.tree` 请求由 **2 次（均 400）降为 0**，持久化集合被清空，
正常加载与本地会话无回归。

## 0.8.16 — 2026-09-15
### 新增（实验性）：官方 Desktop 传输 + 原生右栏远程文件（PR #31），并就评审发现加固 4 处

**PR #31（@dahaipeng）—— 官方 DeepSeek Harness Desktop 兼容路径**

官方 Desktop 组合会禁用旧的 `webServer` / `webRuntime` row，而 0.8.15 的硬
`webServer` 注入 + 内置旧侧栏会让该组合起不来。本版加一条兼容路径（**实验性**，
不含新监听端口、不代理、不伪造 WebServer 服务、不改核心）：

- Web 传输改为**响应式/可选**：`inject` 从 `['tools','systemPrompt','webServer']`
  收敛为 `['tools','systemPrompt']`，两种 UI 传输在 `registerHttpTransports()` 里
  各自 `ctx.inject` 挂载。服务晚到也能注册上（已用真 cordis 实测：插件先 apply、
  `webServer` 后提供，25 条路由全部注册）。
- 新增 Connection Fetch 路由（`lib/http-transport.js`），把同一批有界 JSON
  handler 同时挂到 `/api/dsh-remote/*`，供无端口的 `dsh-app:` carrier 使用；
  旧 `/dsh-remote/*` 路由原样保留。鉴权仍归 carrier 负责。
- 派发**之前**强制 1 MiB 请求体上限（超限回 413，绝不退化成空对象触发默认动作）；
  跨 IPC chunk 传一个整体 buffer，避免 UTF-8 被切断。路由前缀在发送前选定，
  **不重试** POST。
- 核心 Web-server row 被**显式禁用**时（官方 Desktop 组合），内置
  `dsh-better-sidebar` row 保持禁用；独立侧栏 / 顺序无关的去重守卫照旧保留。
- 新增原生 `sidebarRightTabs` / `sidebar.right.pane.tab` 注册，复用现有远程
  资源管理器与文件编辑器，并给远程文件独立的、按会话隔离的
  `dsh-resource://dsh-remote/<sessionId>/<path>` 地址（不再把远程路径当本地
  Files 路径）。
- 回归测试 + 中英文文档。

**评审后加固（对 Web 行为零改变，113/113 通过）**

- `connectionRoute()` 删掉 `route.kind === 'exact'` 要求。`kind`
  （`WebRouteKind`）是 `dsh-host-webserver` 的概念；Connection 的
  `ConnectionFetchRoute` **没有**这个字段，真实的 `assertFetchRoute()` 只校验
  路径形状与 methods。要求一个 API 从未定义的字段，会让将来漏写 `kind` 的路由
  直接抛错。已对真实 `dsh-client-connection` 0.1.5-rc.2 registry 实测。
- Connection Fetch 路由改为**逐个注册**。原单个 `.map()` 在遇到第一条坏路由时
  会中断，**静默丢掉其后所有路由**，同时泄漏前面已注册路由的 disposer；而这段
  代码跑在 `ctx.inject` 子 fiber 里，loader 只 log 不 rethrow，父插件仍是 ACTIVE，
  所以这种「部分注册」完全不可见。现在部分失败会经 `console.warn` 报出来。
- CI 语法检查改为 glob `lib/*.js`，不再用手工清单——原清单**已漏 4 个文件**
  （`binding.js`、`registry.js`、`update.js` 以及本次的 `http-transport.js`），
  新文件里的语法错误可以一路进 main。
- 补 `@deepseek-ai/dsh-client-connection` 为 optional peer，并把
  `@deepseek-ai/dsh-host-webserver` 的 peer 标为 optional：Desktop 组合会禁用
  该 row，插件已不再硬依赖它。

**仍是发布闸门（未在本版解决，见 README 兼容性说明）**

- 原生右栏的文件打开/编辑/同步端到端验收（当前原生 slot/resource/生命周期测试
  用的是组件替身）。
- **侧栏文件操作绑定到「本会话的那台机器」**，并测两台不同主机的并发会话。
  现有 `/ls`、`/read`、`/write` 等仍走 active-machine 池，**仅靠按会话隔离的
  资源地址并不能修好这个后端行为** —— 这是多机场景的发布阻断项。
- 在受支持的 Web 版本上跑完整旧 Web UI 回归。
- 非 macOS 远端/宿主，以及失败/取消的交互。

> 版本号与 npm 发布仅代表代码状态：**Desktop 支持仍属实验性**，不构成本版本
> 对多机 Desktop 生产可用的承诺。

## 0.8.15 — 2026-09-12
### 修复：连接失败永远只显示空 HTTP 400（issue #30）+ 依赖改为 dsh-better-sidebar 0.18（issue #29）

**issue #30 —— 失败路径自己先崩了，真正的错误永远发不出去**

- **根因 1（主因）**：`/dsh-remote/test-connect` 与 `/dsh-remote/connect` 的
  `const body/payload = JSON.parse(...)` 声明在 `try` 块**内部**，而 `catch` 里又读了
  它 —— `try` 内的 `const` 在 `catch` 中不可见，所以只要连接失败，`catch` 自己先抛
  `ReferenceError: body is not defined`，本该发出的
  `{ok:false, error:"认证失败 / 端口不通 / …"}` 永远发不出去；harness 的
  `dsh-host-webserver` 对 rejected handler 统一回空 body 的 400，前端只能显示
  「HTTP 400」。密码错误、缺凭据、DNS 失败、非法 JSON 全都长一个样。
  修复：`body`/`payload` 提到 `try` 之前用 `let` 声明并初始化为 `{}`，两个路由的
  handler 现在**永不 reject**（test-connect → 200 + `{ok:false,error}`；
  connect → 500 + 同结构；请求体非法 → 400 + 同结构，新增 `parseJsonObject()`）。
- **根因 2**：`POST /dsh-remote/machines` 丢弃了 `saveSecret()` 的返回值 ——
  Windows 上 DPAPI 脚本缺 `Add-Type -AssemblyName System.Security`
  （PowerShell 5.1 不预加载），`ProtectedData` 直接「找不到类型」，密码被静默丢掉，
  只留下 `credentialBackend:"windows"` 的空壳，之后每次连接必然失败。
  修复：`credential.js` 两个 DPAPI 脚本都补上 `Add-Type`；新增
  `persistPassword()` 统一凭据落盘决策 —— 密钥库失败时**回退明文**（`credentialBackend`
  改回 `plain`）、经 `warning`/`warningDetail` 回传，设置页用
  `settings.secretStoreFailed` 明确告知，不再静默保存一台没有凭据的机器。
  诊断文本会剥离密码（`execFile` 的 error message 含完整命令行 argv）。
- **验证**：新增 `test/route-errors.test.js`（10 个用例）直接驱动真实注册的路由
  handler：失败探测 → 200 + JSON + 命中主机名、非法 JSON → 200/400 + JSON、
  明文保存 → 落盘且有 `passwordSet` 且不回显密码、`persistPassword` 四条分支
  （失败回退 / 成功不入库 / 抛出时脱敏 / plain 不碰密钥库）。
  该文件在修复前 4/10 失败（正是 ReferenceError 路径），修复后全绿；
  全量 `npm test` 97/97、`node --check` + `check.mjs` OK、
  `npm ci --legacy-peer-deps` 用新 lockfile 可用。

**issue #29 —— 依赖范围把自己锁在了会崩的旧版侧边栏上**

- `@deepseek-ai/dsh-settings` 在 0.1.2-alpha.2 起移除了 `settingsNamespace` 导出
  （改为私有的 `parseSettingsNamespace`），而 `dsh-better-sidebar` 直到 0.18.0
  才适配：0.14.0 ~ 0.17.1 的 `lib/index.js` 仍然
  `import { SettingsConflictError, settingsNamespace } from "@deepseek-ai/dsh-settings"`，
  静态导入失败 → 整个插件树加载失败。dsh-remote 却把范围写成 `^0.14.0`
  （只允许 <0.15.0），装不上已修复的版本。
- **修复**：`dsh-better-sidebar` 依赖改为 `^0.18.1`（与 dsh-remote 自身
  `^0.1.2-rc.1` 的 harness peer 线一致），并同步 `package-lock.json`。
  集成面已核对 0.18.1 未变：服务名仍是 `ctx.provide('betterSidebar')`，
  `registerTab` / `openTab(seed, scope)` / `getSnapshot` / `subscribeState`、
  `single` / `dedupeKey` 语义一致，`dsh.bundle.patch` 与 client 入口名不变。
  （在 dsh 0.1.5-rc.1+ 上可再评估 0.19.x。）
- **⚠ 兼容性变化（新端口隔离实例实测）**：因为 0.18.x 会
  `import { SessionLogOffset } from "@deepseek-ai/dsh-session"`（该导出从 dsh 0.1.2-rc.1 才有），
  **0.8.15 起要求 `dsh ≥ 0.1.2-rc.1`**。实测四组组合：
  | harness | 插件 | 结果 |
  |---|---|---|
  | 0.1.2-rc.1 | dsh-remote 0.8.15 + sidebar 0.18.1 | ✅ 启动，0 加载错误，路由全部正常 |
  | 0.1.0-rc.8 | dsh-remote 0.8.14 + sidebar 0.14.0（改动前基线） | ✅ 启动 |
  | 0.1.0-rc.8 | dsh-remote 0.8.15 + sidebar 0.18.1 | ❌ 启动失败（整个插件树，dsh 起不来） |
  | 0.1.0-rc.8 | dsh-remote 0.8.15 + 关闭内嵌侧边栏行 | ✅ 启动，#30 的修复照常生效 |
  老 harness 用户请留在 **0.8.14**，或按 README 关闭内嵌侧边栏行（`- id: dsh-remote-sidebar / disabled: true`）。

## 0.8.14 — 2026-09-09
### 修复：dsh 0.1.2-rc.1 上 Settings → 远程工作区 页面缺失（PR #28，issue #26 后续）

- **现象**：dsh 0.1.2-rc.1 / 使用替换 workspace/sidebar 组件的 profile 上，Settings 里
  看不到「远程工作区」页面；0.8.13 虽已消除启动报错，但 `apply()` 里
  `if (slots === undefined) return` 的早退让注册永远不执行。
- **根因**：
  1. client 插件未声明硬依赖：`apply()` 需要 `slots`/`locale` 服务，但既没放进
     `exports.inject` 也没等待，服务未就绪时注册被跳过；
  2. `settings.section` 注册用了 `priority: 40`——rc.1 的 slot 列表按 **`order`** 排序
     （`priority` 是死字段，缺省当 0），导致条目被排到最前/不生效；
  3. 两个 directoryFlow 席位（`conversation.hero.workspace.directoryFlow` +
     `sidebar.workspaces.directoryFlow`）嵌套在一个 `slots.inject` 里，任一席位缺失
     会连带阻塞另一个；原生 `ui-workspace` 被替换时 `settings` 也受影响；
  4. `WORKSPACES` 是纯死代码（只赋值从不读取）。
- **修复**（来自贡献者 YiHui-Liu，PR #28）：
  - `exports.inject = ['slots', 'locale']`：硬依赖声明，服务就绪才 apply；
  - `settings.section` 改 `order: 40`（置于 dsh-remote-debug 之前、内置页之后）；
  - 两个 directoryFlow 各自独立 `slots.inject`，互不阻塞；
  - `sessions`/`betterSidebar` 用 `ctx.inject` 可选生命周期化，provider 卸载时清理
    过期 sessions 引用；
  - 删除 `WORKSPACES` 死代码与 `if (slots === undefined) return` 早退；
  - client 清单 peer 从已废弃的 `dsh-client-runtime`/`dsh-client-ui-workspace` 换成
    rc.1 实际提供的 `dsh-client-ui-renderer`/`dsh-client-locale` @0.1.2-rc.1；
  - 新增 `test/client-lifecycle.test.js`：8 个 VM 全包回归测试（延迟注册、provider
    移除/重加、dispose）。
- **CI 修复**：main 自 0.8.10（bd61cc4b）起 CI 就红——`upload.test.js`/
  `session-routing.test.js` 顶层 import `lib/index.js` → 静态 import
  `@deepseek-ai/dsh-tools`（仅 peerDependency，`npm ci --legacy-peer-deps` 不装）→
  `ERR_MODULE_NOT_FOUND`；其模块图还加载 `cordis`/`dsh-scope`/`dsh-llm`/
  `dsh-session`/`dsh-timeout`。修复：这套 import-time 闭包声明为 devDependencies
  （`files` 仅 lib+cordis.patch.yml，永不发布；生产仍由 dsh host 提供 peer）。
- **验证**：干净 LF 检出 `npm ci --legacy-peer-deps` + `node --check` + `check.mjs` +
  `npm test` 87/87 全绿（真实 GitHub Actions 亦绿）。

## 0.8.13 — 2026-09-04
### 修复：dsh 0.1.2-rc.1 上安装后启动报 "cannot get property \"workspaces\" without inject"（issue #26）

- **现象**：`dsh 0.1.2-rc.1 + dsh-better-sidebar 0.18.0 + dsh-remote 0.8.12`，启动 dsh web
  报 `Failed to load plugins — dsh-remote — failed to apply loader entry … (dsh-remote):
  cannot get property "workspaces" without inject`，整个 client 半加载失败。
- **根因**：`lib/client.js` 的 `apply()` 里
  `WORKSPACES = (ctx.get && ctx.get('workspaces')) || ctx.workspaces` —— `ctx.get(name)` 是
  可选查找（服务不在时返回 `undefined`），但第二段的 `|| ctx.workspaces` 是**裸属性读**。
  dsh 0.1.2-rc.1 的 cordis 上下文代理对未声明/不可用服务的任何属性访问直接抛
  `cannot get property "workspaces" without inject`（rc.8 及更早只是返回 undefined）。
  该兜底本身还是死代码：`WORKSPACES` 全文件只有赋值、从无读取；`SESSIONS` 的读取点
  （better-sidebar session cwd）已有 host 侧 `/dsh-remote/resolve-mirror?sessionId=` 兜底。
- **修复**：删掉 `|| ctx.workspaces` 裸读兜底，`WORKSPACES/SESSIONS` 一律只走
  `ctx.get`（可选、不抛），取不到就是 `null`。对 dsh 全版本兼容：rc.8 前行为不变，
  0.1.2-rc.1+ 不再触发严格代理报错。
- **验证**：独立 DSH_HOME + 0.1.2-rc.1 CLI + 新端口实例复现（页面报错与 issue 截图一致）
  → 真包应用补丁后刷新，插件树干净加载（无 Failed banner、console 无异常、
  `/dsh-remote/{machines,status,update-check}` 全部 200）→ `npm test` 79/79、
  `check.mjs` OK。

## 0.8.12 — 2026-09-03
### 修复：多远端会话互相抢占同一个 SSH 连接 —— 命令会被静默发往错误的主机（issue #25）

- **根因**：SSH 连接与远程工作区都是**进程级单例**。插件经 `cordis.patch.yml` 挂进
  host composition（非 preset `isolate` realm），整个进程只 `apply()` 一次，于是
  `const pool = new SshPool(config)` 与 `wsPath() = config.workspace` 被所有会话共享。
  任一会话切换机器时 `setTarget()` 改写共享的 `config` 身份**并调用 `this.close()`**
  掐断另一会话正在用的连接。而 18 个 `rw_*` 工具全部写作 `execute(args)`，从不接 DSH
  传入的第二个参数 `exec: ToolRunContext`，因此拿不到 `exec.agent.session` —— 只能认
  pool 的当下状态。后果不是"连接被反复重建"这类性能问题，而是**命令静默发往错误主机**：
  连接本身健康，只是连错了机器，所以没有任何报错。
- **issue #13 只修了「读」的一半**：`sessionRemotePath()` / systemPrompt / resolve-mirror
  端点确实按 `session.header.cwd` 反查镜像，所以*提示词*是对的；但*执行路径*一行未动。
  读写不对称正是本问题的根因。
- **修复**：
  - 新增 `lib/binding.js`：`resolveMirror(local, root)` 从会话 cwd 反查其所属镜像的
    `.dsh-remote-meta.json`，返回该镜像记录的 `host/port/username` 与 `remotePath`；
    `poolKey(m)` 给出规范化的 `user@host:port` 连接键。
  - **per-machine 连接池**：`machinePools: Map<poolKey, SshPool>` 取代单例。同一台机器
    的多个会话仍共享一条连接（保留 keepalive / 断线重连模型），不同机器的会话彼此独立。
  - **工具按会话绑定**：会话相关的 `rw_*` 接 `exec` 参数，经 `bindingFor(exec)` 解析出
    「该用哪台机器 + 哪个工作区根」，不再读共享的 `config.host` / `wsPath()`。无法解析时
    **明确报错而不回退到当前机器**（静默回退正是错投的来源）。
  - `rw_connect` 保持"切换当前机器"语义；`rw_disconnect` 改为关闭**本会话自己**那条连接
    （原先关的是当前机器的连接，对已绑定会话形同空操作）。
  - **审计日志按真实目标机器归属**：`audit()` 新增 `target` 参数。原先记录的是*当前机器*
    身份，会把操作错记到别的主机名下。
  - **auto-push 按被监视镜像解析目标**：原先以"当前机器"为条件，另一会话切换后 watcher
    会静默停止回传。
  - **systemPrompt 身份错配**：原先把本会话的 remotePath 与*当前机器*的
    `config.username@config.host` 拼在一起，可能给出一个并不存在的 host:path 组合。
  - **Windows/Git Bash 次生竞态**：0.8.11 把 `platform` / `gitBashPath` / `shellMode`
    挂在单例 pool 上并在 `setTarget()` 重置，Windows 与 Linux 会话会互相重置对方的 shell
    探测结果。改为随各自的 per-machine pool 走，并在 `rw_exec` 决定 cwd 形式前先
    `await detect()`（新建的池初始为 `unknown`，否则首条命令会漏掉 Git Bash 路径改写）。
  - **凭据刷新**：复用已有池时从注册表重读密码/密钥/策略，使设置页的修改能到达早先创建的池。
- **回归测试**：
  - `test/binding.test.js`（9 项）—— 两台机器各自解析到自己的 remotePath 且 pool 键不相等、
    嵌套路径归属、basename 冲突（`-<hash>` 后缀）区分、同名前缀兄弟目录不误判、纯本地 cwd
    无绑定、meta 损坏或缺 host 时跳过而不猜测、poolKey 按 host/user/port 分裂且默认端口归一。
  - `test/session-routing.test.js`（5 项）—— 走**真实 `apply()`** 注册出的 `rw_*` 工具，
    用隔离 `DSH_HOME` + 两个镜像验证端到端路由：两会话各打到自己的主机、A/B/A/B 交替
    互不改道、绑定会话用镜像工作区而非当前机器工作区、纯本地会话明确拒绝而不回退、
    同机器两工作区共享一个 pool 键但工作区根独立。
    这 5 项**在修复前的 0.8.11 上有 4 项失败**（断言输出显示绑定到 `.11` 的会话把命令
    发到了 `.22`，即错投本身），修复后全部通过 —— 这是该修复的判别性证据。
  - **维护补充**：`machineRecordFor()` 同时把 `rw_connect save:false` 的**临时连接**
    （ephemeral）视为凭据来源 —— 否则在临时连接上 `rw_pick_workspace` 建立镜像后，
    后续会话解析同一身份会得到空凭据的池而无法连接。凭据刷新逻辑保持一致。

## 0.8.11 — 2026-08-31
### 新增：Web UI 国际化（i18n）—— zh / en 双语文案 + 英文回退（issue #14）

- **词典**：`lib/client.js` 内置 `L.zh` / `L.en` 两套键集完全一致的文案词典
  （设置页、目录选择器、远程文件侧边栏、文件查看/编辑等全部用户可见字符串）。
- **跟随宿主语言**：通过 DSH 原生 client `locale` 服务（`ctx.locale.register`
  注册 `dsh-remote` 命名空间 + `bind` 翻译函数），活动语言切换时文案实时更新；
  宿主 locale 不可用时回退到浏览器语言（`navigator.languages`），再不行默认英文。
- **英文回退链**：查找顺序 活动语言 → `en` → 原始 key（缺失文案保持可见，绝不空白）。
- **宿主错误信息本地化**：`lib/index.js` 返回的已知中文错误（目录选择超时、选择器
  程序缺失、Windows 无 `~` 解析、npm registry 不可达等）在客户端 `api()` / `apiRaw()`
  层按词典翻译，非 zh 界面不再出现中文报错。
- **回归测试**：新增 `test/i18n.test.js`（4 项）—— zh/en 键集一致、`tr()` 引用的
  key 全部存在、无空翻译、zh/en 插值占位符集合一致。

## 0.8.10 — 2026-08-31
### 修复：`rw_upload` 自引入即坏 —— `sftp.fastPut` 参数顺序颠倒（ssh2 契约为 `fastPut(本地, 远程)`）

- **根因**：`rw_upload` 调用的是 `sftp.fastPut(rp, lp)`，把**远程路径当本地路径**传给了
  ssh2。ssh2 的真实签名是 `fastPut(localPath, remotePath)`（与
  `fastGet(remotePath, localPath)` 恰好相反），于是 ssh2 尝试把远程路径当本地文件打开：
  Windows 上 `/home/…` 按当前盘解析为
  `C:\home\…` → `ENOENT: no such file or directory, open 'C:\home\…'`。即使传入
  完全正确的 `localPath`（如 `D:/…`）也必然失败 —— 该工具自
  0.6.x 引入以来从未成功过。`rw_push` / `rw_sync` / `rw_download` 走 `writeFile` /
  `fastGet`，参数顺序本来就正确，不受影响。
- **修复**：改为 `sftp.fastPut(lp, rp)`（本地在前）；SFTP wrapper 的参数名同步改为
  `(lp, p)` 并注明 ssh2 契约，防止回归。
- **回归测试**：新增 `test/upload.test.js` —— 原型替换 `ssh2.Client`（完全离线），
  驱动真实 `apply()` + 连接池 + SFTP wrapper，断言 `fastPut` 收到 `(本地, 远程)` 顺序；
  该测试对旧顺序如约失败。
- **连带纠正**：`test/helpers.js` 的 `MemFs.fastPut` mock 此前也编码了颠倒的顺序
  （潜在坑：任何基于它的测试都无法发现这类 bug），已纠正为真实契约。

## 0.8.9 — 2026-08-29
### 新增：Git Bash 默认终端（Windows 主机）+ 「此电脑」多盘根视图 + Windows 路径自动改写；修复浏览浮层「回上一级」与路径栏残留上次选择

- **Git Bash 默认终端** —— 连接后自动探测远程平台（`cmd /c ver`，附 `uname -s` 的
  MINGW/MSYS 兜底）；Windows 机器自动定位 Git Bash（`config.shell` 可显式指定 bash.exe
  路径、`'git-bash'` 或 `'native'` 关闭），所有命令经 `bash -s` 从 exec 通道 stdin 管道
  执行 —— 不经过 cmd/PowerShell 解析，引号/反斜杠/换行内容原样执行。`rw_exec` 的 cwd
  在 Git Bash 模式下自动改写为 `/c/Users/…` 挂载形式。`/dsh-remote/status`、`rw_info`、
  设置页「测试连接」均报告检测到的 `platform` / `shell` / `gitBash`。
- **「此电脑」多盘根视图** —— 远程选择器在 Windows 主机根级显示驱动器列表
  （`C:\` `D:\` `E:\`…，经 `cmd /c fsutil fsinfo drives`，回退 `ls -d /[a-z]`），不再
  显示 Git Bash 的 MSYS 根目录；平台探测未决时也尝试枚举（POSIX 主机自然回落）。
- **Windows 路径自动改写** —— 输入 `C:\Users\…` / `C:/…` / `/c/…` / `/C:/…` 统一规范为
  Git Bash 形式 `/c/Users/…` 供 shell 命令执行，工作区存储与展示为 Windows 形式
  `C:\Users\…`；`/dsh-remote/ls` 条目携带完整展示形路径，客户端不再自行拼接路径。
  `paths.js` 新增纯函数 `toShellPath` / `toDisplayPath`（含单测）。
- **浏览浮层修复** —— 「回上一级」在任意深度可用：浮层直接打开在路径栏当前路径
  （levels 仅一层）时，向上导航会加载父目录而非置灰；浏览弹层打开时与路径栏同步。
- **路径栏修复** —— 选择器每次打开/切换 tab/切换机器时重置路径栏，不再残留上一次
  在 DSH 页面选择的路径；面包屑 Windows 化（`此电脑 / C:\ / Users / dev` 可点击跳级）。
- 新增配置项 `shell`；文档（README / README.zh / CHANGELOG）同步更新。

## 0.8.8 — 2026-08-24
### 修复：Remote context 改为 session 级隔离，保存的机器不再自动成为全局 Agent 上下文（issue #13）

**核心语义变化：`Saved Connections ≠ Active Remote Context`。** 保存 SSH 机器只是备用连接；
只有用户显式「设为当前」（或调用 `rw_connect`）才会激活 remote context。普通本地 session
不再被任何已保存/当前机器拖入远程上下文。

- **问题 1 — 没有「当前无远程上下文」状态**：旧逻辑 `currentId` 为空时 fallback 到第一台
  机器、添加第一台机器自动设为 current、删除当前机器后自动换到另一台，导致「保存了一台
  SSH 机器」几乎等价于「Agent 永远有一个 remote context」。
  - **修复**：`loadMachines` 不再 fallback；add/update 不再自动设 current（保留原有
    `currentId` 字段）；删除当前机器后 `currentId` 置 null（不自动换机）；`/dsh-remote/
    current` 支持 `{ id: '' }` 显式「active remote = none」；设置页新增「取消设为当前」
    按钮。`currentId: null` 会持久化（`explicitNone`），重启后配置级默认 host 也不会
    静默重新激活被用户取消的上下文。
- **问题 2 — 切换/删除远程 workspace 后侧边栏仍显示旧远程目录**：`resolve-mirror` 对
  非 mirror 的 session cwd fallback 到 `machine.workspace`，把别台机器记住的默认目录
  显示到本地 session 的「远程文件」tab。
  - **修复**：`resolve-mirror` 不再 fallback —— 非 mirror session 返回
    `remotePath: ''`、`mode: 'local'`；侧边栏 `RemoteExplorerTab` 也不再回退到
    `status().workspace`，本地 session 显示「当前会话未使用远程工作区」；新 session 的
    「远程文件」tab 只在 session 确为远程时自动打开。
- **问题 3 — 本地 session 突然自动分析远程项目**：system prompt 只要有 `config.host +
  workspace` 就注入「Current remote workspace: user@host:/path … Treat this directory as
  the working root」，完全不看当前 session 是否真的选择了该 remote workspace。
  - **修复**：prompt 注入改为 session-aware —— section 的 `text()` 按本次 assembly 的
    `context.agent.session.header.cwd` 判断，只有 cwd 能映射到 dsh-remote mirror（即用户
    确实把远程 mirror 选为 session 工作区）时才注入；普通本地 session 不注入 remote
    段落，模型自然也不会被引导去调用 `rw_*`。
- **配套**：`/dsh-remote/status` 新增 `sessionMode` / `sessionRemotePath`（支持
  `?sessionId=` 按 session 查询）；`rw_info` 输出增加「Session remote context」行并说明
  session-scoped 语义；机器注册表纯逻辑抽到 `lib/registry.js` 并新增 `test/registry.test.js`
  （56 项测试全绿，覆盖：不 fallback、不自动激活、删除不换机、explicitNone 持久化、
  keepCurrentKey 保留语义）。

## 0.8.7 — 2026-08-21
### 修复：内嵌侧边栏 guard 与 bundle 顺序无关（issue #12）+ 本机目录选择器支持 browse 后端（issue #11）
- **issue #12 — 自动挂载 better-sidebar 的守卫失效导致启动崩溃**：当 profile 显式装有
  独立 `dsh-better-sidebar` 且排在 `dsh-remote` **之后**时，两个 better-sidebar 实例同时
  启用，第二个注册 `/sidebar/api` 报 `duplicate prefix route`，整个插件树启动失败。
  - **根因**：loader 按 bundle 顺序创建条目，每行的 `!!js` disabled 表达式在创建时求值，
    只能看到**排在自己前面**的行。`dsh-remote-sidebar` 的 guard 查不到后面的独立
    better-sidebar，两边都认为自己没有对手 → 双挂载。
  - **修复**：guard 不再依赖 `ctx.loader.entries()` 的创建顺序，改为扫描**已合成的 patch
    栈**（`include.subtree.config.patches`，即所有 bundle 层 + profile/home/overlay 层的
    全部插入行）——该数据在任意行 guard 求值前已完整物化，因此无论独立 better-sidebar
    排在 bundle 列表的什么位置结果都一致。纯数据访问、不读其它行的 `disabled`，无递归。
    原 `entries()` 检查保留作兜底（覆盖运行时注入的行）。
  - **验证**：`bundles: [..., "dsh-remote", "dsh-better-sidebar"]`（复现原崩溃）与
    `[..., "dsh-better-sidebar", "dsh-remote"]` 均正常启动、侧边栏仅挂载一份。
- **issue #11 — 本机目录选择器在 DSH Desktop（browse 后端）不可用**：桌面版启动器在
  win32 故意挂载 browse 后端（native 后端的 Win32 对话框 worker 在 Electron 壳里
  无法运行），但插件只认 `kind === 'native'`，导致 browse 能力被完全忽略。
  - **修复**（合入 PR #10）：`local-pick` 按能力分支 native → 自持 OS 对话框
    （PowerShell/osascript/zenity-kdialog）→ browse 兜底；新增 `GET /dsh-remote/local-list`
    与 `POST /dsh-remote/local-mkdir` 代理 browse 后端，客户端新增本机目录浏览浮层
    （面包屑 / 盘符切换 / 新建目录 / 选择回填），无显示器宿主也能选目录。
  - **验证**：DSH Desktop（win32）本机 tab 正常弹出系统文件夹选择器；无 zenity/kdialog
    的 Linux 宿主走应用内目录浏览器。

## 0.8.6 — 2026-08-21
### 修复：设置页底部版本号硬编码为 v0.8.3
- **现象**：设置页底部「dsh-remote v0.8.3」永远显示 0.8.3，即使安装的是更新版本。
- **根因**：版本号字符串硬编码在 client.js，没有跟随实际安装版本。
- **修复**：改用 `/dsh-remote/update-check` 返回的 `current` 版本（页面加载时已静默获取），
  取不到时显示 `?.?.?` 兜底。

## 0.8.5 — 2026-08-21
### 新功能：侧边栏远程文件树跟随会话工作区 + 目录选择器补全体验
- **远程文件 tab 跟随会话工作区**：每个会话的「远程文件」侧边栏目录不再固定显示
  机器级默认 workspace，而是跟随会话自身 cwd。新增 host 端点
  `GET /dsh-remote/resolve-mirror?local=<abs>|?sessionId=<id>`：遍历
  `$DSH_HOME/remote-workspaces/` 下各镜像目录的 `.dsh-remote-meta.json`，把会话 cwd
  （镜像目录）映射回真实远程路径；`?sessionId=` 时优先读 host sessions 服务的
  `header.cwd`，活跃会话查不到（历史会话）时走会话日志兜底——按 sessionId 定位
  `$DSH_HOME/sessions/**/<sessionId>/session.jsonl.zstd`（或 .jsonl/.gz），解第一帧
  zstd 读 header.cwd。无匹配回退机器 workspace。
- **侧边栏远程文件树形展开**：RemoteExplorerTab 从「面包屑 + 单级列表」重写为树形
  文件树，与 better-sidebar 内置本地文件树交互一致——目录点击展开/收起（📂/📁，
  黑色 SVG 图标）、子目录递归、缩进、右键菜单（打开/下载到本地镜像/重命名/删除）；
  根目录默认展开显示第一级；行 hover 高亮。数据走 `/dsh-remote/ls`，条目用
  joinRemote 补绝对路径。展开状态复用框架 `expanded`/`onToggleDir`，与本地树
  互不干扰。
- **新会话自动打开远程文件 tab**：auto-open 的集成级单例 flag 改为按 sessionId
  记忆（`autoOpenedFor` Set），每个会话独立 auto-open 一次，修复「新会话没有
  远程文件页签、旧会话才有」的问题。
- **会话 cwd 时序修复**：RemoteExplorerTab 的 `refreshStatus` 依赖改为
  `[scopeCwd, sessionId]`——better-sidebar 的 scope.cwd 可能异步到达（fetchedCwd
  经 `api.sessionCwd` 拉取），原先空依赖只在挂载时解析一次，cwd 落地后不重新解析，
  导致所有会话都显示机器 workspace；现在切换会话 / cwd 落地都会自动重新
  resolve-mirror，A 工作区会话显示 A、B 工作区会话显示 B。
- **目录选择器补全体验**：选择子目录后路径自动补全尾部 `/`（或 Windows `\`），
  可继续输入下一级；选择子目录后弹出的下一级候选不再只列目录（原来过滤掉文件，
  看起来列表不齐），改为目录+文件全部显示，与输入时的补全一致。
- **UI 视觉**：树行文字改为跟随主题的正文字色（去掉绿色强调），文件图标统一为
  黑色 SVG。

## 0.8.4 — 2026-08-21
### 修复：dsh 0.1.0-rc.8 安装 0.8.3 启动崩溃（issue #9）
- **现象**：`dsh web` 启动报 `unsupported JSON schema: parameters.env.additionalProperties
  must be explicitly true or false`，插件树加载失败、整个 Harness 无法启动。
- **根因**：`rw_exec` 工具的 `env` 参数 schema 是 `{ type: 'object' }`，没有显式
  `additionalProperties`。dsh 0.1.0-rc.8 内嵌的 dsh-tools（0.1.0-rc.8）schema 编译器
  强制 `type:'object'` 必须显式声明 `additionalProperties: true|false`，缺失即抛
  `JsonSchemaError`（0.7.1/0.6.7 能启动是因为它们自带/解析到宽松的 dsh-tools 版本）。
- **修复**：`rw_exec.env` 补上 `additionalProperties: true`（env 是任意 key 的环境变量
  映射，语义上就是 open map）。
- **回归防护**：`check.mjs` 新增「defineTool 参数里 `type:'object'` 必须显式
  `additionalProperties`」静态检查，部署前闸门会拦截同类问题。

## 0.8.3 — 2026-08-21
### 新功能：添加机器表单折叠高级配置
- 基础字段（名称 / 主机 / 端口 / 用户 / 密码）始终可见，覆盖最常见的
  IP + 用户名 + 密码场景。
- 私钥 / Passphrase / 默认工作区 / HostKey 模式 / agent·OTP·钥匙串开关 /
  跳板机全部收进「▼ 高级配置」折叠区，展开后与原布局一致。
- 编辑使用了高级配置的机器时自动展开；清空/取消时自动收起。

## 0.8.2 — 2026-08-21
### 修复：设置页 UI 拥挤 + updateMode schema 兼容
- **设置页排版优化**：表单行增加上下间距（row 统一 marginBottom 8）；跳板
  「端口/用户/密码」拆成两行并 flex-wrap，不再溢出；跳板私钥独立一行；
  checkbox 行与底部操作按钮行补间距 + 自动换行；机器列表「设为当前」按钮
  nowrap；工作区弹窗路径行 flex-wrap。
- **兼容修复**：`updateMode` 改用 `z.string()`（schemastery 3.18 无 `.enum`），
  在读取处以 manual/auto/off 白名单校验，避免插件树加载失败。

## 0.8.1 — 2026-08-21
### 新功能：版本更新提示 + 手动/自动更新模式
- **设置页新增「更新」区块**：显示当前版本 / 最新版本（自动查询 npm registry）、
  「检查更新」按钮、发现新版本时「立即更新」按钮。
- **更新模式可选**：`手动`（默认，仅点检查时查询）、`自动`（加载时 + 每 6 小时
  静默应用新版本）、`关闭`。模式写入安装目录 `update-mode` 文件，重启后保留。
- **更新机制**：零构建插件 = 下载 npm tarball → 内置 tar 解析（zlib gunzip +
  迷你 ustar reader，见 lib/update.js）→ 校验版本 → 原子替换 lib/*.js +
  cordis.patch.yml + package.json，写 `.dsh-remote-updated` 标记；host 半重启、
  client 半刷新后生效。
- 失败安全：下载/解析/校验任一步失败即中止，不动现有文件；auto 模式错误静默。
- 验证：tar 解析器对真实 tarball 解出 package/lib 正确；fetchLatestVersion 真实
  查询 npm 返回最新版；check.mjs 通过。

## 0.8.0 — 2026-08-21
### 大版本：远程 = 一等公民（设计文档全量落地）
按「状态一致性 → 工具完备 → 同步安全 → 企业网络 → 打磨」五条主线实施：

**状态一致性与正确性（P0）**
- 单一状态源：`rw_connect` 默认 `save:true` 把机器 upsert 进注册表并设为当前，
  工具/UI/系统提示三者的"当前机器"永远一致；`rw_pick_workspace` 把工作区持久化到
  **实际连接**的机器（修复旧 bug：工具连 A 机却把 workspace 存到注册表当前 B 机）。
  新增 `activeSource: machine|ephemeral|config` 状态字段。
- 设置页表单补全：passphrase / 默认工作区 / hostKeyMode / SSH agent /
  keyboard-interactive / 跳板机 / 加密保存密码；机器行显示最近测试延迟。
- Windows 宿主本机目录选择器（PowerShell FolderBrowserDialog）。
- 大文件保护：`rw_read_file` 先 stat 超限即拒绝；`rw_download`/`rw_upload` 走
  fastGet/fastPut 流式落盘；侧边栏 `/dsh-remote/read` 大文件只预览头部。

**Agent 工具完备（P1）**
- 新增 6 个工具：`rw_stat` / `rw_edit`（字面替换 + mtime 乐观锁）/
  `rw_append` / `rw_mkdir` / `rw_remove`（recursive 有界）/ `rw_move`。
- `rw_search` 重写为 **SFTP 遍历搜索**（lib/search.js）：Windows 远程可用、
  忽略规则生效、支持 glob/contextLines/maxMatches，不再依赖 POSIX find+grep。
- `rw_exec` 支持 `pty` / `env`；错误统一走分类提示（auth/network/hostkey/timeout）。

**同步安全（P1）**
- `rw_sync`/`rw_push` 升级为**三方冲突检测**（lib/sync.js：远端 vs 本地 vs
  上次同步快照）：任一侧改过的文件不再被静默覆盖——报冲突 + 路径 + 原因，
  `force=true` 覆盖；`dryRun` 预演；`async:true` 后台任务（lib/tasks.js）。
- **gitignore 式忽略规则**（lib/ignore.js）：默认跳过 .git/node_modules/target/
  dist/build 等，用户文件 `$DSH_HOME/remote-workspaces/.dsh-remote-ignore`；
  新增 `/remote-ignore` 命令查看。
- 镜像同步状态快照 `.dsh-remote-sync-state.json`（原子写，pull 后对齐本地 mtime、
  push 后对齐远端 mtime，保证下次同步增量跳过）。

**企业网络（P2）**
- **端口转发**（lib/forwards.js + `rw_forward` + 设置页面板）：本地→远端 /
  远端→本地(reverse)，定义持久化、可自动重连、断连全部清理。
- **跳板机 ProxyJump**：机器可配置 proxy（经跳板 forwardOut 到目标），TOFU 双段
  校验；test-connect 支持带跳板探测。
- **认证扩展**：SSH agent（SSH_AUTH_SOCK）、keyboard-interactive（OTP）、
  从 ~/.ssh/config 导入（只引用私钥路径，绝不读密钥内容）。
- **OS 钥匙串密码**（lib/credential.js）：macOS Keychain / Windows DPAPI /
  Linux secret-tool，可选、失败自动回退明文。

**打磨（P3）**
- **侧边栏远程文件可编辑**：编辑 → 保存到远程（`POST /dsh-remote/write` +
  mtime 乐观锁，409 提示重读）；explorer 右键菜单（下载到镜像/重命名/删除/
  新建目录）；行内显示文件大小、目录优先排序。
- **命令审计日志** audit.log（时间|user@host|op|exit|command），设置页展示最近 30 条。
- **编码支持**：rw_read_file/rw_write_file/read/write 路由支持 `gbk` 等（iconv-lite）。
- **书签/快捷**：每机最近工作区（picker 内"最近"一键进入 + 设置页快速切换）、
  `~` 主目录快捷、浏览弹层"新建目录"。
- **测试与 CI**：`test/` 45 项单测（node:test：路径/忽略规则/错误分类/ssh config/
  三方同步冲突/TOFU 指纹回归/SFTP 搜索/任务管理/单文件推送，mock SFTP + 真实本地
  目录）；`scripts/integration-real.mjs` 真实主机集成实测（mock ctx 驱动 apply +
  真实 SSH，覆盖 status/test-connect/ls/read/write+乐观锁/fs/search/sync/forward/
  audit/forget-key）；check.mjs 扩展（工具名 rw_ 前缀、路由 /dsh-remote/ 前缀扫描）；
  `.github/workflows/ci.yml`。
- 配置新增：`useAgent` / `keyboardInteractive` / `proxy` / `autoPush` / `auditLog` /
  `encoding` / `passphrase`。
- 依赖新增：`iconv-lite`；随 0.7.2 已内嵌 `dsh-better-sidebar`。
- 健壮性：移植 0.7.3 的 stale-connection 恢复（channel open failure 时
  `invalidate()` + 新连接重试一次，exec/sftp 双路径）；迁移旧数据仅在本机默认
  DSH_HOME 时执行（显式 DSH_HOME 指向他处时不再搬走该目录下的真实数据）。
- 真实主机实测（root@9.134.186.191:36000，45/45 通过）发现并修复 3 个问题：
  Config 的 `z.object(...).optional()` 在 schemastery 3.18.1（部署同版本）不存在
  （会导致插件加载失败，改为全字段默认值）；`mkdirRemoteDirs` 不建目标目录
  （rw_mkdir/fs mkdir 无效，改为真 mkdir -p，文件类调用点传父目录）；反向转发
  误用 `openssh_forwardIn`（ssh2 ≥1.16 为 stream-local，改回 `forwardIn`）。

## 0.7.4 — 2026-08-21
### 新功能：设置页 / 工作区弹窗角落引导链接
- **设置页底部**：新增「⭐ 去 GitHub 点个 Star · 💬 反馈建议 / 提 issue」引导行
  （含版本号），低调置底、不影响任何表单操作。
- **选择工作目录弹窗底部**：新增居中角落「⭐ Star dsh-remote · 提建议 / 报问题」
  链接，同样不遮挡确认按钮。
- 目的：把 star / issue 回流入口放到用户高频路径上，提升社区活跃度。
- 验证：语法 + check.mjs 通过；链接 `target=_blank` + `rel=noopener`，弹窗内
  点击不会触发 backdrop 关闭。

## 0.7.3 — 2026-08-21
### 修复：远程目录读取间歇性失败（"Channel open failure: open failed"）
- **现象**：浏览远程目录（远程文件侧边栏 / `rw_list_dir` / `rw_sync`）偶发
  `browse failed: ssh sftp failed: (SSH) Channel open failure: open failed`。
- **根因**：连接池持有"僵尸连接"——SSH 连接在服务器端已死（空闲超时 / 网络
  重置），但 keepalive 尚未触发 close 事件，池里的 `client` 仍被复用；对死连接
  调 `client.sftp()` / `client.exec()` 打开新通道时服务器拒绝，报 channel open
  failure，且旧连接永远不被清理，故障持续。
- **修复**：新增 `SshPool.invalidate()`——当 `sftp()` / `exec()` 通道打开失败
  且错误匹配 `channel open failure|open failed` 时，丢弃缓存 client（end + epoch
  失效）并在**全新连接上重试一次**；持续性错误仍正常报错。exec 的流处理提取为
  `runStream()`，SFTP 包装提取为 `wrapSftp()`，避免重连路径重复代码。
- 验证：单元测试（僵尸连接 → invalidate → 新连接重试成功 ✅）+ 真实 SSH 集成
  测试（readdir 87 entries ✅）。

## 0.7.2 — 2026-08-20
### 新功能：内嵌 dsh-better-sidebar，一条命令装齐
- **`dsh plugin add dsh-remote` 自动带出侧边栏**：`dsh-better-sidebar` 从可选
  集成升级为**硬依赖**（`dependencies`），安装 dsh-remote 时自动装上；`cordis.patch.yml`
  同时挂载两个插件（`dsh-remote` + `dsh-remote-sidebar`），无需再单独
  `dsh plugin add dsh-better-sidebar`。
- **防重复挂载**：内嵌侧边栏行使用独立 id `dsh-remote-sidebar` 并带 guard——
  若已存在其他 enabled 的 `dsh-better-sidebar` 条目（用户单独装过、或聚合 bundle
  已提供），内嵌行自动禁用，避免两个实例同时注册 `/sidebar/api` 导致整个插件树
  启动失败。
- 说明：若你已单独安装侧边栏，升级后无需卸载——guard 保证只挂载一份。
- **要求 `nodeLinker: hoisted`**：loader 从 profile 根解析插件包，内嵌侧边栏
  必须能在顶层 `node_modules` 解析到。这是 DSH profile 的默认 linker；若
  `pnpm-workspace.yaml` 被重写丢失该行，需补回 `nodeLinker: hoisted` 并
  `pnpm install` 一次（否则报 `Cannot find package 'dsh-better-sidebar'`）。
- 验证（verify9）：全新 profile `dsh plugin add dsh-remote`（nodeLinker:
  hoisted）→ pnpm 自动装 better-sidebar 并提升到顶层 → boot 成功、侧边栏
  「🌐 远程文件」tab 可用；已单独装侧边栏的 profile 升级后无重复挂载。

## 0.7.1 — 2026-08-20
### 修复：侧边栏显示本地镜像而非远程文件（issue #8 反馈）
- **现象**：安装 dsh-better-sidebar 后，侧边栏（better-sidebar 右侧面板）默认
  打开的是内置「文件」tab，显示**本地镜像目录**，而不是远程主机的文件。
- **修复**（纯客户端）：
  1. **有远程工作区时自动打开「🌐远程文件」tab** —— 注册 explorer 后监听
     better-sidebar snapshot，一旦有活动 session 且已配置远程工作区，就用
     `openTab`（带 path seed）把远程文件树打开到右侧面板并**激活**（内置
     `openTabInActivePane` 会把新 tab 设为 active），用户打开侧边栏直接看到
     远程文件，无需再点底部面板的卡片。
  2. **explorer 打开时自动加载目录** —— `refreshStatus` 首次设 levels 时立即
     `loadDir(workspace, 0)`，修复之前打开 explorer 显示「（空目录）」直到
     手动点 ↻ 的问题。
- 验证（verify8：dsh-better-sidebar@0.14.0 + dsh-remote 0.7.1）：
  - 右侧面板 tab 条：`Files 🌐远程文件`，远程文件激活显示
  - 内容：`远程工作区: /home/mmdev (root@9.134.186.191)` + 远程目录（gcc7）
  - 点击 gcc7 进入显示其子目录（lib64/libexec/bin/lib/include/share）

## 0.7.0 — 2026-08-20
### 新功能：dsh-better-sidebar 远程文件浏览（issue #8）
- **解决 issue #8「是否支持在 dsh-better-sidebar 中显示 ssh 远程主机的文件」**：
  之前 dsh-better-sidebar 的文件列表显示的是**本地 SFTP 镜像目录**，现在
  dsh-remote 注册两个侧边栏 tab，实时显示**远程主机**的文件：
- **`dsh-remote:explorer`（远程文件 🌐 tab）**：实时远程文件树——目录展开走
  `/dsh-remote/ls`（SSH 直连，不是本地镜像）；顶部显示当前远程工作区与
  主机；「…」按钮可打开目录选择器切换工作区；面包屑跳转上级目录。
- **`dsh-remote:file`（远程文件 tab）**：explorer 点文件打开，通过
  `/dsh-remote/read`（SFTP 实时读）渲染文本（UTF-8/CRLF→LF，256KB 截断），
  二进制文件显示大小与提示。**只读**——侧边栏编辑器保存会写本地 fs，
  远程文件若可编辑会静默存进镜像，所以编辑保持在 rw_* 工具/镜像工作流。
- **设计取舍**：不注册 file viewer（better-sidebar 的 viewer 匹配按扩展名/
  优先级，无法区分远程/本地路径，catch-all 会劫持所有本地文件打开）；
  改为专用 tab，只从 explorer 打开。
- dsh-better-sidebar 未安装时优雅跳过（`ctx.get('betterSidebar')` 守卫），
  现有功能零回归。
- 依赖：dsh-better-sidebar **v0.4.0+**（`registerTab` API；issue 报告者用的
  v0.14.0 验证通过）。

## 0.6.9 — 2026-08-20
### 修复 issue #4「选择目录时，如果有子目录时，选择框会遮挡确定菜单」
- **现象**：远程目录自动补全下拉从路径输入框向下绝对定位展开（`top: 100%`），
  展开后漂浮覆盖弹窗右下角的「设为远程工作区」确认按钮，用户无法点击确认。
- **根因**：补全下拉不参与文档流（`position: absolute`），且弹窗底部空间不足
  （`maxHeight: min(620px, 90vh)`），列表展开必然压住确认按钮；弹窗本身
  `overflow: hidden`，也没有滚动兜底。
- **修复**（纯客户端，刷新即生效）：
  - 自动补全下拉改为**流式展开**（参与文档流），展开时把确认按钮**推到下方**
    而不是覆盖，与目录浏览面板（`renderDirPopup`）既有的内联处理一致。
  - 远程 tab 容器 `overflow: hidden` → `overflowY: auto`：补全列表/浏览面板
    展开后弹窗内容超高时可滚动，确认按钮始终可达。
- 视觉验证：headless Chrome 渲染修复前后对比 —— before 中确认按钮被补全列表
  完全遮挡，after 中按钮完整可见、可点。

## 0.6.8 — 2026-08-20
### Windows 远程（cmd.exe / PowerShell）兼容
- **修复 issue #5「不兼容 Windows SSH 连接」**：远程机器为 Windows 时输入
  `D:\Code` 报 `not a directory (or unreachable): /D:\Code`。
- **根因**：`normalizeRemotePath` 按 POSIX 处理路径，把 `D:\Code` 破坏成
  `/D:\Code`；目录校验用 `if [ -d ]`（POSIX shell 语法），Windows 默认
  cmd.exe 下不可用。
- **路径层**：`normalizeRemotePath` 现支持 Windows 盘符（`D:\`、`C:/`）与
  UNC（`\\server\share`）路径，保留盘符与反斜杠分隔；`remoteDirname` /
  `remotePathBase` / `joinRemotePath` 同步支持两种分隔符。
- **SFTP 层**：新增 `toSftpPath`（`D:\Code` → `/D:/Code`，Win32-OpenSSH
  sftp-server 的 POSIX 风格）；`pool.sftp()` 所有方法自动转换路径并加
  超时保护（避免卡死的服务器挂住工具调用）。
- **浏览/校验**：`listDirStructured` 与 `rw_list_dir` 改用 **SFTP readdir**
  （协议级，不再依赖远程 `ls`）；目录存在性校验 `isRemoteDir` 用 SFTP
  stat 替代 `if [ -d ]`（rw_pick_workspace / workspace 路由 / mirror 路由）。
- **读写**：`rw_read_file` 从 `sed -n` 改为 SFTP readFile（分页不变）；
  `rw_write_file` / `rw_upload` 的 mkdir -p 用共享 `mkdirRemoteDirs`（支持
  `D:\a\b` 逐级创建）；`rw_search` 对 Windows 路径给出 PowerShell 提示。
- **连接探针**：`rw_info` / `rw_connect` 的 `echo ok; hostname; pwd` 改为
  `echo ok`（`;` 分隔在 cmd.exe 不可用）。
- 客户端 `lib/client.js`：远程目录浏览的路径拼接/补全支持反斜杠分隔符。
- POSIX 行为零回归（34 项单测通过：路径归一化 / dirname / SFTP 转换 /
  mkdir 链 / 回归）。

## 0.6.7 — 2026-08-20
### 远程目录浏览崩溃修复 + TOFU 主机指纹校验复活
- 修复「远程」目录选择器点浏览报 `The "data" argument must be of type string or
  an instance of Buffer, TypedArray, or DataView. Received undefined`。
- **根因**：ssh2 v1.17 的 `hostVerifier` 回调传入的是**裸 Buffer**（SSH
  host-key 二进制块，SSH wire 格式），而 v0.6.1 的 TOFU 实现按旧版
  `{ algo, hash }` 对象写的——`keyFingerprint` 对 `key.hash`（undefined）调
  `createHash().update()` 在**每次 SSH 连接**都抛错。ls/浏览走 SSH 连接 →
  每次必崩（单元测试用 mock 对象掩盖了契约漂移）。
- **修复**：`keyFingerprint` 兼容裸 Buffer（对整块 blob 做 SHA-256）与
  `{algo,hash}` 旧形态；算法名从 blob 头部解析（`blobAlgorithm`），known_hosts
  记录 `algo=ssh-ed25519`。
- 沙箱实测：ls 返回 myTower 真实目录列表（HTTP 200）；known_hosts 首次正确
  写入指纹；第二次连接指纹匹配；篡改指纹后新连接被**拒绝**（MITM 告警 +
  `/remote-forget-key` 重信任提示）。v0.6.1 的 TOFU 主机指纹校验首次在真实
  ssh2 下真正生效。

## 0.6.6 — 2026-08-20
### 本机目录选择器：真根因修复（DSH directoryPicker 服务实测缺失）
- 运行时诊断（沙箱临时路由）证实：`ctx.get('directoryPicker')` 实测为 **null**，
  `directoryPicker` 从未注册——web-app 的 `-auto` 行（`-auto` → native/browse
  后端）在桌面启动路径里不物化成 loader 条目（`loader.store` 只有 include+hmr；
  即便 `loader.create` 手动挂载 native 后端，服务也不出现）。之前"服务存在、
  只是 cordis 属性访问崩"的判断是错的，那只是 `without inject` 报错造成的误导。
- `/dsh-remote/local-pick` 改为**两级策略**：优先 `ctx.get('directoryPicker')`
  native 后端；服务缺位/非原生/抛错时**自持兜底**——插件自带原生选择器
  （macOS `osascript choose folder` / Linux `zenity→kdialog`，与 DSH native
  后端同一套调用约定），120s 超时 + 取消码识别。
- 沙箱端到端实测（真实对话框交互）：取消 → `{ok:true,cancelled:true,via:'own'}`；
  正选 → `{ok:true,path:"/Users/…",via:'own'}`，两分支均 HTTP 200。
- 客户端 `chooseLocal()` 无需改动（已兼容 path/cancelled/error 形状）。

## 0.6.5 — 2026-08-20
### 合并上游 0.5.8–0.5.10（客户端 UI 修复）
- 机器下拉从原生 `<select>` 改为自绘 dropdown（`ddRef` + 点击外部关闭），
  避免原生 select 的弹出层常驻遮挡下方按钮。
- 路径自动补全下拉支持点击外部空白处收起（`suggestRef` + `mousedown`）。
- 纯客户端改动：刷新页面即生效，无需重启。
### 开发模式
- 新增 `scripts/dev-run.sh`：**开发/沙箱模式**——在隔离的 DSH_HOME + 独立
  profile（硬链接拷贝产品 profile，`node_modules/dsh-remote` 换成指向源码的
  symlink）上启动桌面 harness，改源码即加载，**绝不触碰产品实例**。
  `--stop/--status/--refresh` 子命令见脚本头部。
- `scripts/dev-standards.md` 增加「沙箱优先」规则：日常迭代一律在沙箱验证；
  产品 profile 里的 `dsh-remote` 声明为 `^0.5.10`，任何 npm/plugin 重装都会
  覆盖手工部署的文件（v0.6.4 曾被重装回 0.5.10 顶掉，实证）。

## 0.6.4 — 2026-08-19
### Fixes（本机目录选择器崩溃）
- 修复「本机」目录选择器报错 `cannot get property "directoryPicker" without
  inject`：`/dsh-remote/local-pick` 路由取 picker 服务时用
  `ctx.directoryPicker` 属性访问作为兜底，但 cordis 规定**属性形式必须先在
  该插件的 `inject` 列表里声明**，未声明即抛错（与服务是否注册无关）。
  改为只用 `ctx.get('directoryPicker')`（按名解析、不要求 inject、缺失返回
  null）。修复后 DSH Desktop（macOS/loopback 绑定）下的**原生系统文件夹
  选择器可正常弹出**，不再需要退而手动填路径。
- 规范化补充：可选服务一律用 `ctx.get(name)`，禁用 `ctx.<name>` 属性形式
  （已并入 `scripts/dev-standards.md`，为第二条 cordis 约束教训）。

## 0.6.3 — 2026-08-19
### Fixes（启动崩溃）
- 修复 0.6.1 引入的**阻塞启动**回归：slash 命令原注册为 `remote.forget-key`，
  但 dsh-commands 框架要求命令名匹配 `/^[a-z][a-z0-9_-]*$/u`（不允许点号）。
  非法命令名导致**插件树加载失败、DSH Desktop 无法启动**。已改名为合法的
  `remote-forget-key`（帮助文案同步更新）。
### 开发流程硬化
- 新增 `check.mjs`（部署前闸门：校验所有 `commands.register()` 名符合框架约束）
  与 `scripts/boot-smoke.sh`（在隔离的 profile 拷贝上启动桌面 harness，证明
  插件树能加载）。`./sync.sh` 现在**拷贝前跑静态闸门、拷贝后跑启动冒烟**，
  阻塞启动的改动无法再被静默部署。
- 新增 `scripts/dev-standards.md`（dsh 插件开发规范，固化本次事故教训）。

## 0.6.2 — 2026-08-19
### Fixes
- **Remote directory picker**: structured listings now run `ls -1A -F` (classifies
  entries from readdir `d_type`, no per-entry `stat`) instead of a
  `for f in .[!.]* *` loop that stat'ed every entry. This fixes two real
  failure modes when browsing remote directories:
  - Directories with **no dotfiles** no longer fail with
    `zsh:1: no matches found: .[!.]*` (zsh `nomatch` aborts the old glob) —
    they now list normally.
  - Listing a directory that contains a **stuck FUSE/network mount** (e.g. an
    unresponsive s3fs/bucket mount) no longer hangs: the old loop's `[ -d ]`
    stat blocked in an uninterruptible kernel D-state (immune to SIGTERM),
    holding the SSH channel until the exec timeout. `ls -F` reads d_type
    without stat, so a dead mount can't stall the listing.
- Symlinked directories (`/bin@` …) remain enterable: symlink entries get one
  bounded `[ -d ]` follow-up (only symlinks are touched, never a stuck mount);
  if that stat is slow or fails the symlink degrades to a non-enterable file
  instead of failing the whole browse.

## 0.6.1 — 2026-08-18
### Security: host-key verification (TOFU)
- **New `hostKeyMode` config** (`accept-new` default · `verify` · `off`): the SSH host
  key is verified on every connect.
  - `accept-new` records a host's key on first connect and rejects any CHANGE
    afterwards (mirrors ssh's `StrictHostKeyChecking accept-new`) — closes the
    man-in-the-middle gap where ssh2 silently accepted any host key.
  - `verify` also rejects hosts never recorded before (strict).
  - `off` disables verification (not recommended).
- Trusted keys are stored at `$DSH_HOME/remote-workspaces/known_hosts.json`
  (SHA-256 base64 fingerprint per `host:port`), so they migrate with the data root.
- `rw_info` / `/remote` report host-key state; **`/remote forget-key`** and the
  `/dsh-remote/forget-key` endpoint drop a stale/mistrusted record so the next
  connect re-records it.
### Robustness
- `/dsh-remote/ls` parses `path` via URL search params (literal `+` decodes to space).
- POST request bodies are capped at 1 MiB.
- `/dsh-remote/mirror` now always verifies the directory over SSH (connecting if
  needed) instead of silently minting a mirror when disconnected.

## 0.6.0 — 2026-08-18
### Cross-platform & correctness fixes
- **Portable remote commands** — `rw_list_dir` and `rw_read_file` no longer use the
  GNU-only `ls --color=never` / `sed -n … --` forms, so macOS/BSD remotes work too.
- **Timeout now kills the remote process** — a timed-out `rw_exec`/`rw_read_file` sends
  `SIGTERM` to the remote command (then hard-closes the channel), instead of silently
  leaving it running and holding the SSH connection.
- **SSH connect race fixed** — `SshPool` gained a generational token; switching targets
  or closing mid-connect can no longer let a stale handshake claim the pool and point it
  at the old host. Dropped in-flight connects are swallowed, not unhandled rejections.
- **Mirror collision safety** — local mirrors are named `<host>-<user>-<port>/<base>`;
  when a different remote path already took that basename, a short path-hash suffix is
  appended so `/a/project` and `/b/project` never share a directory. First use keeps the
  clean basename label.
- **Persistent workspace** — picking a workspace (tool or UI) now saves it on the machine
  record, so it survives a restart.
- System-prompt injection text now says `rw_*` (matching the real tool names).
### Data location
- Machines + mirrors now follow `$DSH_HOME` (`remote-workspaces` under the harness home);
  pre-0.6 data under `~/.dsh/remote-workspaces` is migrated automatically on first run.
### Sync performance
- `rw_sync` / `rw_push` are **incremental** — files whose size+mtime match are skipped;
  local mtime is aligned on download so repeated syncs are cheap.
- New `maxFileBytes` cap (default 50 MiB) skips oversized files instead of yanking them
  into the mirror.
- Directory sweeps run with **bounded parallelism** (4-way) per level.
### New tools
- `rw_exec` accepts `cwd` and defaults to the current remote workspace.
- `rw_search(pattern, path?, glob?, ignoreCase?)` — portable recursive grep.
- `rw_download(path, localPath?)` / `rw_upload(localPath, path)` — single-file transfers.

## 0.5.7 — 2026-08-15
- **Fix boot crash (regression in 0.5.5/0.5.6):** tool schemas again use the DSH value-schema
  DSL form — `required: true` on leaf properties (the compiler derives the `required[]` array).
  The 0.5.5 "fix" moved `required` to a top-level array, which the DSL rejects
  (`schema.required is not supported by the value schema DSL`), making `dsh web` fail to boot
  with dsh-remote installed. Verified against the official `valueSchemaSpecToJsonSchema`
  compiler for both `parameters` and `output` schemas.

## 0.5.6 — 2026-08-15
- README previews now load from the jsDelivr CDN (`cdn.jsdelivr.net/gh/...`) instead of
  `raw.githubusercontent.com`, which is blocked/unstable in many networks. npm page README
  updated to match.

## 0.5.5 — 2026-08-15
- **Compliance fixes from the WhaleHarness audit** (https://github.com/flymysql/dsh-remote/issues/1):
  - Tool schemas no longer put `required: true` on leaf properties — required fields are now
    declared as a top-level `required: [ ... ]` array (the DSH-supported form).
  - Removed the implicit `~/.ssh/id_rsa` private-key default. `privateKeyPath` is now used
    **only when explicitly provided**; otherwise the plugin requires a password and fails with a
    clear message instead of silently reading a real key off disk.

## 0.5.4 — 2026-08-15

- **Publish metadata** — added `homepage` / `repository` / `author` / `bugs` so the
  npm page links back to the GitHub repo.

## 0.5.3 — 2026-08-15

### Workspace directory picker (fills the native “Add workspace” flow)
- The picker now renders as a **centered modal** (opaque panel + scrim), so it is
  never squeezed into the narrow sidebar.
- **Opens on the 本机 (local) tab** by default; the 远程 tab is one click away.
- **远程 / Remote**:
  - Path field **auto-prefills `/`** with a **live completion list** — selecting a
    directory immediately reveals its next level (OS/VSCode-style cascade).
  - A **浏览…** floating browser (opaque, height-capped, scrollable, follows symlinks)
    fills the field without committing; you review / edit, then **设为远程工作区**.
  - Fix: the modal no longer clips the native machine `<select>` dropdown.
- Real (desensitized, placeholder host) screenshot published in README.

## 0.5.2 — (baseline)
- Multi-machine SSH registry (add / edit / delete / set-current).
- `rw_info` `rw_connect` `rw_pick_workspace` `rw_list_dir` `rw_read_file`
  `rw_write_file` `rw_exec` `rw_sync` `rw_push` `rw_disconnect`.
- **测试连接** test-connection button. Password stored locally, never echoed.
- Directory-flow holes injected (client) at priority −100 — no `dsh-workspace`
  core is modified.
