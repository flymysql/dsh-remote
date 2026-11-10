# dsh-remote 的 TUI 适配（dsh-tui）

> 目标：插件仓库本体内新增 TUI 接入层，**不修改 dsh-tui 本体**。
> 形态：同一 npm 包（`dsh-remote`）内新增 `lib/tui/` 与宿主进程内服务
> `ctx.dshRemote`；装进 TUI profile 后自动生效，Web profile 下静默降级。

## 1. 交付物

| 能力 | 用户入口 |
| --- | --- |
| 远程服务器管理页（增 / 改 / 删 / 连接 / 探测 / 浏览目录） | `/dsh-remote`（全屏场景） |
| 新建工作区时直接选远程项目目录 | `/workspace open dshremote://<机器>/<远程路径>`、`/workspace` 选择器、`dst dshremote://…` 启动参数 |
| 远程项目进入工作区台账 | 选中即写 `ctx.workspaceRegistry`，标题形如 `机器名-目录名` |

宿主侧（SSH 池、`rw_*` 工具、镜像同步、竖井 sandbox）全部沿用现有实现，TUI 层只做
「进程内 API + UI 注册」，不复刻 SSH 逻辑。

## 2. 分层

```
dsh-tui 进程（TUI 与 DSH 内核同进程）
├─ dsh-tui 本体（diff 为零，不改）
│   ├─ ctx.tuiScenes        全屏场景注册/打开
│   ├─ ctx.tuiWorkspaces    工作区 provider 注册
│   ├─ ctx.tuiDialogs       托管对话框（降级路径用）
│   ├─ ctx.commands         slash 命令（TUI 合并进补全 + 执行）
│   └─ ctx.workspaceRegistry 工作区台账
└─ dsh-remote 插件
    ├─ apply()（既有，4.5k 行闭包：config/pool/machines/…）
    │   └─ ctx.provide('dshRemote', hostApi)   ← 新增，约 100 行
    └─ lib/tui/（新增）
        ├─ index.js    installTui(ctx, api, config)：注册命令/场景/provider
        ├─ scene.js    全屏「远程服务器」管理页（React.createElement，无 JSX）
        ├─ provider.js 工作区 provider（scheme: dshremote）
        ├─ flow.js     无场景接缝时的对话框降级流程
        ├─ format.js   纯函数：URI 编解码、标签、表单校验
        └─ i18n.js     中英文案
```

**为什么必须走进程内服务**：`apply()` 的全部可变状态（`config`/`pool`/`machines`/
`currentId`/`machinePools`/forwards/terminals）都关在一个闭包里。TUI 侧若自行读
`machines.json`、自建 SSH 池，会双连接、双写覆盖、且看不到运行期状态变化。

## 3. 宿主 API 契约（`ctx.dshRemote`，apiVersion 1）

```ts
interface DshRemoteHostApi {
  readonly apiVersion: 1

  /** 已保存机器（**不含任何 secret**）+ 当前机 id。只读，不连网。 */
  listMachines(): Promise<{ machines: MachineView[]; currentId: string | null }>

  /** 新增（无 id）或更新（有 id）。省略字段=保留旧值；password/passphrase 只写不读。 */
  upsertMachine(patch: MachinePatch): Promise<{
    machine: MachineView
    machines: MachineView[]
    currentId: string | null
    warnings: string[]
  }>

  removeMachine(id: string): Promise<{ machines: MachineView[]; currentId: string | null }>

  /** 当前机持久化切换；null = 明确无当前机。 */
  setCurrent(id: string | null): Promise<Status>

  /** 连接并探测（`echo ok`）。persist:false 走临时连接。 */
  connect(opts?: { machineId?: string; persist?: boolean }): Promise<Status>

  /** 只探测连通性（不切换当前机、不保存表单里的新凭据）。成功会顺手把
   *  `lastConnectedAt` / `latencyMs` 写回该机器记录（与 Web 的「测试连接」一致）。 */
  probeMachine(patch: MachinePatch): Promise<ProbeResult>

  status(): Promise<Status>

  /** 列远端目录。寻址优先级：**machineId 的专属池 > 活动机**（本 API 不接
   *  sessionId/local —— 会话绑定是 Web 路由那一层的参数，TUI 不需要）。 */
  listDir(opts: { machineId?: string; path?: string }): Promise<DirListing>

  /** 已存在的远程项目镜像（只读本地文件系统，不连网）。 */
  listRemoteProjects(): Promise<RemoteProject[]>

  /** 在系统文件管理器里打开本机镜像根目录 `$DSH_HOME/remote-workspaces`。
   *  目录不存在时抛 `VALIDATION`；不创建任何东西。 */
  revealMirrorFolder(): Promise<{ path: string }>

  /**
   * 采用一个远程目录：建/复用本地镜像（mkdir + .dsh-remote-meta.json），
   * 可选注册成 DSH Workspace（host 限定标题）。**不做 SSH 校验**，快。
   */
  ensureRemoteWorkspace(opts: {
    machineId?: string
    remotePath: string
    register?: boolean
  }): Promise<RemoteWorkspace>

  /**
   * 用户显式「用作工作区」：SSH 校验是目录 → ensureRemoteWorkspace(register:true)。
   * 慢（秒级），只给场景里的显式动作调用。
   */
  pickRemoteWorkspace(opts: {
    machineId?: string
    remotePath: string
    registerWorkspace?: boolean
  }): Promise<RemoteWorkspace & { status: Status }>

  /**
   * 本地镜像工作区清单（只读本地文件系统，不连网）：每个镜像的远端路径、
   * 对话数、占用中会话数、镜像字节数，以及是否在台账 / 最近列表里。
   * `live` 只用进程内 sessions 服务（不做 lsof），供列表即时显示。
   */
  listWorkspaceMirrors(opts?: { machineId?: string }): Promise<WorkspaceMirror[]>

  /** 删除一个镜像工作区下的对话，保留镜像与台账；占用中的会话跳过并回报。 */
  deleteWorkspaceSessions(opts: {
    localMirror: string
    force?: boolean
  }): Promise<CleanupReport>

  /**
   * **彻底删除**一个远程工作区：对话 + 台账登记 + 每台机器的最近列表项
   * （防止 provider 下次启动重建）+ 本地镜像目录。
   * 有会话仍被占用时拒绝（`WORKSPACE_BUSY`）除非 `force: true`。
   */
  deleteRemoteWorkspace(opts: {
    localMirror: string
    deleteSessions?: boolean
    force?: boolean
  }): Promise<CleanupReport & { removedMirror: boolean; removedRegistration: boolean; removedRecents: number; clearedMachineWorkspace: number }>

  /** 只把远端路径从每台机器的最近列表 / 当前工作区里摘掉；镜像与台账保留。 */
  forgetWorkspaceRecent(opts: { localMirror: string }): Promise<{
    localMirror: string
    remotePath: string
    removedRecents: number
    clearedMachineWorkspace: number
  }>

  /** 机器/连接状态变化；简化版（api 自身变更时触发）。 */
  subscribe(listener: (event: { type: 'machines' | 'status' }) => void): () => void
}
```

支撑类型（全部纯数据）：

```ts
interface MachineView {
  id: string; name: string; host: string; port: number; username: string
  useSshConfig: boolean; workspace: string
  /** 分组标签。宿主注册表没有 group 列：它就是 `environment` 字段的投影
   *  （见 §3.1），TUI 表单的一个「分组」输入框写回 `environment`。 */
  group: string
  privateKeyPath: string; credentialBackend: string
  hostKeyMode: string; useAgent: boolean; keyboardInteractive: boolean
  backend: 'native' | 'openssh'; sshBinary: string; webAttachCommand: string
  recentWorkspaces: string[]
  lastConnectedAt?: string; latencyMs?: number
}

interface MachinePatch extends Partial<Omit<MachineView, 'id'>> {
  id?: string
  /** **每次调用都必填**，更新时也一样（宿主路由的历史约束）；
   *  `useSshConfig` 时填 ~/.ssh/config 的 Host alias。 */
  host?: string
  /** 只写：不落进 MachineView。 */
  password?: string
  passphrase?: string
}

interface Status {
  machineId: string | null
  host: string; username: string; port: number
  connected: boolean
  workspace: string          // 远程路径（显示用）
  activeSource: string
  hostKeyKnown: boolean; hostKeyMode: string
  forwards: Array<{ direction: string; listenPort: number; targetHost: string; targetPort: number; active: boolean }>
}

interface ProbeResult {
  ok: true; host: string; user: string; latencyMs: number
  platform: 'posix' | 'windows' | 'unknown'
  shell: string; usedSavedCredential: boolean
}

interface DirListing {
  path: string
  parent: string | null
  platform: 'posix' | 'windows'
  items: Array<{ name: string; path: string; type: 'dir' | 'file' | 'link' | 'other'; size: number; mtime: number }>
  machine: { id: string; name: string; host: string; port: number; username: string }
}

interface RemoteProject {
  dir: string               // 本地镜像绝对路径（可直接作为 session cwd）
  host: string; port: number; username: string
  remotePath: string; alias: string
  name: string              // 匹配到的机器名，'' = 未匹配
  machineId: string | null
}

interface RemoteWorkspace {
  machineId: string
  remotePath: string
  localMirror: string
  title: string             // 机器名-目录名
  workspace?: { id: string; title: string }
}

interface WorkspaceMirror {
  localMirror: string; remotePath: string
  host: string; port: number; username: string; alias: string
  machineId: string | null; machineName: string
  title: string
  registered: boolean       // 在 DSH 工作区台账里
  recent: boolean           // 在该机器的 recentWorkspaces 里
  sessions: Array<{ id: string; modifiedAt: number; live: boolean }>
  sessionCount: number; liveSessionCount: number
  mirrorBytes: number; mirrorSizeTruncated: boolean
}

interface CleanupReport {
  localMirror: string; remotePath: string
  removedSessions: number; removedSessionIds: string[]
  skippedLiveSessions?: string[]   // deleteWorkspaceSessions 才有
}
```

错误语义：失败一律 `throw Error`，`error.code` ∈
`MACHINE_NOT_FOUND | NO_ACTIVE_MACHINE | NOT_A_DIRECTORY | AUTH | CREDENTIALS |
HOSTKEY | NETWORK | TIMEOUT | SFTP | UNSUPPORTED | LOCAL_SESSION | VALIDATION |
WORKSPACE_BUSY | INTERNAL`（`VALIDATION` = 调用方输入不可用，如缺 host 或路径不是合法镜像；
`WORKSPACE_BUSY` = 该工作区还有会话在使用，`error.liveSessions` 列出会话 id；
`INTERNAL` = 缺陷或未分类故障），
`error.message` 已是面向用户的中文（复用 `friendlyMessage`）。

### 3.1 `group` 与宿主注册表

宿主的机器记录用 `normalizeMachineGroup()` 存 `environment` / `location` /
`description` / `tags` 四个分组字段（Web 设置页把 `environment` 当主机「分组」编辑），
并没有 `group` 列。契约里的 `group` 就是 `environment` 的投影：读（`listMachines` /
`upsertMachine` 的返回）与写（`upsertMachine({ group })` → `environment`）都做映射，
所以 TUI 表单的「分组」输入是真正落盘的。

## 4. TUI 侧注册（`installTui`）

全部走 `ctx.get(name, false)` 软探测，缺席即静默降级；`installTui` 同步返回、不
`await`、不抛错（内部 try/catch + 日志）。注册顺序：

1. **命令**：仅当 `tuiScenes` 或 `tuiDialogs` 存在时注册 `/dsh-remote`
   （避免在 Web profile 里凭空多出一条命令）。
   handler：`tuiScenes.open('dsh-remote')` 成功 → `{ kind: 'success' }`（静默）；
   失败 → `{ kind: 'error', text }`。
2. **场景** `dsh-remote`：`ctx.tuiScenes.register({ id, title, component }, ctx)`。
   - 组件只用 props 注入的 `React` 与 `ui`；元素一律 `React.createElement`，不用 JSX。
   - 键盘：`↑/↓` 移动、`Enter` 确认、`a` 新增、`e` 编辑、`d` 删除、`t` 探测、
     `c` 连接、`b` 浏览远程目录（浏览里按 `w` 设为工作区）、`o` 用系统文件管理器
     打开本机镜像根目录、动作菜单里 `m` 工作区管理（删除/清理）、`Esc`/`q` 关闭。
     该根目录同时存放 `machines.json` / `audit.log` 等插件数据；`credentialFallback:
     plain` 时 `machines.json` 可能含明文密码——打开前请知悉（只在本机文件管理器里可见）。
   - 渲染期不做同步 I/O；异步全部进 `useEffect`，组件卸载后丢弃结果。
3. **工作区 provider**：`ctx.tuiWorkspaces.register(provider)`（scheme `dshremote`）。
   - `list(signal)`：**只读缓存**（启动后台预热 + 变更后刷新），保证 2s 预算内返回。
     条目 = 已存在镜像 + 当前机工作区 +（可配置）每机最近 N 个工作区。
   - `resolve(uri)`：`dshremote://<机器 id|名称>/<URL 编码的远程绝对路径>` →
     `api.ensureRemoteWorkspace({ register: true })`。
   - `resolvePath(path, cwd)`：cwd 属于镜像时，相对该镜像的远程路径解析。
   - `describe(cwd)`：**同步只读本地文件系统**（扫镜像目录里的
     `.dsh-remote-meta.json`，无网络、无 SSH）；用 `lib/binding.js#resolveMirror` 得到
     `{ host, port, username, remotePath }`，再补机器名。**不创建任何目录**。
   - `rename` 不提供（宿主回落台账重命名）。
4. **状态行**（可选）：`ctx.tuiStatus.setField('dsh-remote', …)` 显示当前远程机，
   **只在当前会话的 cwd 落在远程镜像里时显示**：仅仅被保存成 current 的机器属于
   待机状态，本地会话里不占底栏。TUI 进程可同时挂载多个会话，判定顺序：
   ① 宿主切换会话后传给 `provider.describe()` 的 cwd（只采信确实属于某个 live
   会话的那个，见 §4 的 provider）；② 最近进入 store / 最近发过 `user/message`
   的会话（`origin: 'subagent'` 的子代理会话一律排除）；③ store 里最后进入的
   会话。`session/created` / `session/disposed` / `user/message` / 终端 resize
   触发 500ms 合并刷新；宿主没有 `sessions` 服务时退回旧行为，有服务但读失败时
   **隐藏**（不猜），缺 `tuiStatus` 时跳过。
   鼠标悬停显示详情（与其它底栏字段同一效果）：完整机器名 · `user@host:port`
   · 远端路径。宿主先按 160 cells 截断 detail、再按可用宽度 wrap（不 truncate），
   所以插件自己裁到 `process.stdout.columns - 18`（状态行内宽 `columns-2`，再给
   右侧 MiniWake/activity 预留），CJK / emoji 记 2 格，超宽以 `…` 结尾。
5. 所有 dispose 用 `ctx.effect(() => () => dispose())` 绑定生命周期。

### 工作区 cwd 语义（关键）

会话的远程身份由 **`session header.cwd` 落在哪个本地镜像目录**决定
（`lib/binding.js`）。因此：

- `TuiWorkspaceTarget.cwd` **必须是本地真实存在的镜像目录**
  （`$DSH_HOME/remote-workspaces/<host>-<user>-<port>/<basename>`）。
- `uri` 用 `dshremote://…` 表达远程身份；`description` 显示
  `user@host:/remote/path`；`badge` 显示机器名。
- 传远程路径当 cwd 会让工作区台账 `realpathNormalize` 抛 ENOENT（被 TUI 兜成
  toast），会话照开但侧栏看不到 —— 因此列表/解析阶段必须先 `ensureMirror`。

### 工作区清理（删除镜像 / 删除对话 / 移出最近列表）

`/dsh-remote` → 机器动作菜单 `m`（工作区管理）列出该机器全部本地镜像，键位：

- `d`：**彻底删除工作区** —— 顺序固定为「对话 → 台账登记 → 最近列表项 → 镜像目录」。
  先删对话再清登记，最后删镜像：任何一步失败时，前面的步骤已经完成，重试是幂等的。
  最近列表项必须一起删，否则 provider 下次启动会按 `recentWorkspaces` 把镜像重建
  回来（这正是「删了又出现」的根因）。
- `x`：只删该工作区下的对话，保留镜像与台账；被占用的会话跳过并在 toast 里报数。
- `r`：只把远端路径从「最近列表 / 当前工作区」摘掉（不删镜像、不删对话），
  用来止住 provider 的自动重建。
- `←`/`Esc`：返回机器列表；确认页 `y`/`→`/`Enter` 确认、`n`/`←`/`Esc` 取消。

安全边界（`lib/workspace-cleanup.js`）：

- 目标必须是 `$DSH_HOME/remote-workspaces/<host>-<user>-<port>/<name>` **恰好两层**、
  且目录内有合法的 `.dsh-remote-meta.json`；realpath 之后仍必须落在根目录内。
  其他路径（含更深的子目录、根目录本身、软链出去的目标）一律 `VALIDATION` 拒绝。
- 会话目录按 DSH 自己的布局定位：`$DSH_HOME/sessions/--<cwd 转义>--/<encodeSegment(id)>`，
  两个编码器与 `@deepseek-ai/dsh-session-persistence-jsonl` 逐字符一致（有单测钉住）。
  同时用 realpath 与调用方给的镜像路径两种拼写查目录（`DSH_HOME` 本身是软链时两者不同）。
- 「占用」判定：先问进程内 `sessions` 服务（能看见本 TUI 的 parked 会话），
  再在该会话目录有 `session.lock` 时用 `lsof -t` 探测内核 flock（POSIX）；
  Windows 没有 lsof，只能依赖进程内检查，删除前会给出相同提示。

## 5. 配置（行 config，`cordis.patch.yml` 同一行）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `tui` | `true` | 总开关；false 时 `installTui` 直接返回 |
| `tuiProviderListRecent` | `true` | 工作区选择器里是否列出各机最近工作区 |
| `tuiProviderRecentLimit` | `5` | 每机列出的最近工作区上限（1–20） |
| `tuiAutoSwitchWorkspace` | `true` | 浏览目录里按 `w` 设为工作区后是否立即切会话 |
| `tuiLang` | `''` | TUI 层文案语言：`''`=自动（中文；`DSH_TUI_LANG=en` 时英文），`zh`/`en` 固定 |

## 6. 安装

```bash
# 一次性：把 dsh-remote 装进 TUI profile（profile 已存在时跳过第一条）
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@<版本>
dsh plugin --profile dsh-tui add dsh-remote          # 或本地路径 /abs/path/to/dsh-remote
# 重启 dsh-tui 后生效
```

沙箱验证（不污染现有 profile；`~/.dsh-tui` 只能靠 `HOME` 隔离）：

```bash
export HOME=/tmp/dsh-remote-sandbox/home
export DSH_HOME=/tmp/dsh-remote-sandbox/dsh
# ① 用 dsh-tui 启动器自举 profile（或 `dsh plugin --profile tuidev add …`）
# ② 装本地插件：pnpm 需要读写自己的 store，沙箱下通常要显式指定
dsh plugin --profile tuidev add /path/to/dsh-remote
dsh --profile tuidev --dump-config | grep -A2 'id: dsh-remote'
```

两条环境坑（本机实测）：

- `dsh plugin add` 走 pnpm；若 profile 的 `node_modules` 来自另一个 store，
  pnpm 会报 `ERR_PNPM_UNEXPECTED_STORE`。此时用 `pnpm config set store-dir <原 store>`
  或直接在 profile 里手工 `symlink` 插件目录（仅用于本地调试）。
- 全局安装的 `@deepseek-harness-tui/dsh-tui` 会先于 profile 里的副本被
  `resolveBundleDir` 解析（`dsh-app-boot` 先看安装锚点）。全局副本过旧时
  `--dump-config` 会打印 “skipping profile bundle”，需按提示
  `dsh plugin allow-version … --accept-risk` 或用与运行时匹配的版本。

## 7. 验证

- 单测：`npm test` —— 覆盖宿主 API 合同（含工作区清理）、provider / URI /
  表单纯函数、`installTui` 注册矩阵（含 fake-React 的场景渲染测试）；
  当前 1067 例（1058 通过 / 9 skip）。
- 静态闸门：`node check.mjs`（命令名 / 场景 id / 工具名 / 路由前缀约束）。
- 组合：`dsh --profile <sandbox> --dump-config` 中能看到 `id: dsh-remote` 行，
  且 `@deepseek-harness-tui/dsh-tui` 的补丁层正常应用。
- 真接缝注册（开发期一次性验证，**不在** `npm test` 里）：用真实 cordis + 真实
  dsh-tui seam 模块起一个「先 apply 插件、后挂 tui* 服务」的组合，验证
  `whenService` 的补注册路径、`handler → tuiScenes.open()` 返回 `success`、
  `tuiScenes.active.id === 'dsh-remote'`、dispose 后注册全部释放。
- 交互式冒烟（需要 PTY）：`dsh --profile <sandbox>` 后输入 `/dsh-remote` →
  添加机器 → 连接 → 浏览目录 → `w` 设为工作区 → `/workspace` 里出现条目 →
  菜单 `m` → `d` 删除一个临时镜像，确认镜像目录消失、最近列表项被摘掉。
  开发机上已用 pyte PTY 驱动跑通上述路径（含 Esc/←/→ 层级导航）。

## 8. 已知限制

- `ctx.tuiWorkspaces` 未列入 dsh-tui 的 14 个「冻结接缝」，属实验面：dsh-tui
  升级可能改变形状；`provider` 不可用时，`/dsh-remote` 场景与工作区台账仍可用，
  只是选择器里不出现远程条目。
- 远程目录浏览依赖 SSH 连接，慢于本地；场景内显示加载态，等待期间 `Esc` 只会退出
  当前子视图（**不会**中断已经在飞的 SSH 请求；结果回来时若已切到更新的浏览请求，
  旧结果会被丢弃，避免乱序覆盖）。
- 工作区 provider 的 `list()` 有 2s 预算（宿主强制），故只读缓存，不做即时 SSH。
- `list()` 的缓存来自「已存在的镜像 + 当前机工作区 + 每机最近 N 个（可关）」；
  刷新会对被列出的路径调用 `ensureRemoteWorkspace({ register: true })`，
  即在台账里预登记这些远程项目（标题带机器名）。机器被删掉但镜像还在的条目
  只出现在 `describe()`（状态行展示），不再进选择器。
- 工作区清理只删**本地**镜像与会话日志；远端目录不会被连带删除（那需要 SSH 与
  二次确认，属于另一条危险路径）。删除工作区登记时不会回写台账里的 `sessionIds`
  （DSH 的 workspace registry 没有 detach API）；残留的 id 不会被列出，因为会话列表
  以磁盘日志为准。
- 删除失败可能只完成了一部分（例如对话已删、镜像被占用）：各步骤按「对话 → 登记 →
  最近项 → 镜像」排列，重复执行是安全的。
- 表单的密码 / passphrase 只写不回显；对话框降级路径（无全屏场景时）**不收集**
  凭据，需要密码认证请用全屏场景；降级路径缺少 `select`/`input`/`confirm` 时
  命令返回错误而不是静默成功。
- 相对路径：`/workspace open` 的非 URI 参数按宿主的本地路径语义处理；本 provider
  另外实现 `resolvePath`，所以**当前会话 cwd 已在某个镜像里**时可以相对它输入目录，
  此外的远程目录请用 `dshremote://` 完整 URI 或 `/dsh-remote` 页面浏览。
- `connect()` 失败时**可能已经把该机写成当前机**（与 `rw_connect` 的持久化语义一致）：
  选择器会显示它；底栏只在当前会话确实是远程镜像时出现，重试即可。

---

## 8. 使用速查（从 README 搬来）

### `/dsh-remote` 页面的按键

- `↑/↓` 选机器，`Enter` 打开动作菜单；`a` 新增、`e` 编辑、`d` 删除、`t` 测试连接、
  `c` 连接、`b` 浏览远端目录、`o` 打开本机镜像目录、`Esc`/`q` 关闭
  （子视图里先返回列表；动作菜单里按 `m` 管理工作区）。
- 新增/编辑：名称、主机、端口、用户名、认证方式（密码 / 私钥 / SSH agent）、密码或私钥路径、
  分组。密码**只写不回显**，编辑时留空表示不修改。
- `b` 浏览远端目录，按 `w` 把当前目录**设为工作区**：自动建本地镜像、注册成 DSH 工作区
  （标题形如 `机器名-目录名`），并按配置切换过去。
- `o` 用系统默认文件管理器打开本机镜像根目录 `$DSH_HOME/remote-workspaces`
  （每台机器的镜像按 `<host>-<user>-<port>` 分目录存放；该目录也含 `machines.json`
  等插件数据，`credentialFallback: plain` 时可能含明文密码，仅在本机可见）。
- 底栏状态行显示当前远程机器名（**仅当**会话 cwd 落在远程镜像里，本地会话不显示）；
  悬停可见完整机器名 · `user@host:port` · 远端路径（0.8.80+）。

### 新建工作区时直接选远程目录

- `/workspace` 的选择器里除了本地目录，还会列出每台机器的最近远程项目（徽标是机器名，
  说明是 `user@host:/远端路径`）。选中即在新会话里打开该远程工作区。
- 也可以直接给 URI：`/workspace open dshremote://<机器名或 id>/<URL 编码的远端绝对路径>`。
- 启动参数同样支持：`dst dshremote://<机器>/<远端路径>`。

### 工作区清理（三档）

`/dsh-remote` → 选中机器 → `m`（工作区管理）：

- `d`：彻底删除该工作区（对话 → 工作区登记 → 每台机器的「最近/当前」→ 本地镜像目录）；
- `x`：只删该工作区下的对话（保留镜像与登记）；
- `r`：只把远端路径移出最近列表（止住 provider 自动重建）；
- 仍有会话在使用时 `d` 会被拒绝（先 `Ctrl+X` 停止后台会话，或退出对应终端）；
  删除不可恢复，且**不会**动远端目录。
