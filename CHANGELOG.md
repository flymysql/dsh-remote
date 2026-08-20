# Changelog

All notable changes to **dsh-remote**.

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