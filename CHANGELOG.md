# Changelog

All notable changes to **dsh-remote**.

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