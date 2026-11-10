# 排查手册（dsh-remote）

> 从 README 搬来的完整版：每一条「已修」背后都有根因故事与设计权衡，读它们能少走很多弯路。
> 只想快速自救请看 [README 的常见问题速查](../README.md#常见问题--排查)。

**`@` 能列出远程文件，但内置读文件工具打不开** —— harness 自带工具看到的是**本地镜像**，要等 `rw_sync` 下载后才有内容。读远程文件请用 `rw_read_file` 或侧栏远程文件 tab。

**远程会话里的文件链接打不开**（issue #55）—— 已修。链接被点开时 harness 会把它变成
`dsh-resource://file/session/<会话>/<路径>`，然后交给内置的文本预览去读；而那个预览读的是**本机**
文件系统，远程会话的 cwd 是**本地镜像目录**（`rw_sync` 之前是空的），所以打开只会失败。
插件现在注册了一个更高优先级的地址处理器，把这个地址按远程主机解析后用 SFTP 打开（和侧栏「远程文件」同一个编辑器）。
安全边界是保守的：只有当该会话的 cwd **确实落在某个镜像目录里**、且镜像表已加载时才接管，
本地会话与页面刚加载的那一瞬间仍然走内置预览 —— 不会把本地文件误当成远程文件。
两个仍然开不了的情况会给出明确提示而不是空白页：链接指向的是**绝对**远端路径之外无法映射的地址，
或该会话的工作区不是一个远程镜像目录。
远程会话里的 `.md`/`.markdown` 同样走这条 SFTP 链路并在标签里预览（issue #74）。以前为了保住内置 Markdown 渲染把它们交回去（issue #64），但那个预览读的是本地镜像，文件还没 `rw_sync` 时就是 `ENOENT`。现在预览的是远端内容，用宿主自带的 Markdown 渲染；宿主没有该组件时才显示源码。本地会话仍然走内置预览。图片在侧栏远程文件树里直接内联显示 png/jpg/gif/webp/svg/bmp（issue #66，>2MB 退回下载按钮）。

**SFTP 操作一旦超时就永远卡死**（issue #65）—— 已修（0.8.52+）。旧版里一次撞满 20s 超时的 SFTP 操作会把
该机器在本进程内的全部 SFTP 工具拖到永久超时（`rw_exec` 却正常），只能断连重连。现在超时即置死该通道、
后续请求立即失败；native 后端连续两次超时会废弃整条连接重新握手，openssh 后端会重建 sftp 子进程——
一次网络抖动不再需要用「断开重连」来收场。顺带，`rw_edit` 改成了「临时文件 + rename」原子写，
写一半超时不会再把远端文件截成 0 字节，原文件的权限位也会保留。

**远程操作受不受本机 sandbox 约束？**（0.8.54+）—— 受。以前不受：本机会话有 `ctx.sandboxPolicy`
（read-only / workspace-write / danger-full-access），而 `rw_*` 工具在远端执行**完全没有策略**，
于是一个 read-only 会话照样能改任意一台可达机器上的任意文件——沙箱没有被绕过，它对另一台机器根本
没有发言权。现在插件在**工具边界**套用同一套已解析的模式：

- `read-only`：拒绝远端写入、拒绝跑命令、拒绝开端口转发（读和连接仍可用，否则连机器都看不了）；
- `workspace-write`：远端写入必须落在工作区根之内（按路径围栏），命令与转发放行；
- `danger-full-access`：全放行。

为什么是工具层围栏而不是 `ctx.sandbox.confine()`：后者的语义是「把 argv 包起来在**本机** spawn」，
而我们的进程跑在 SSH 通道的另一端——核心文档自己也写明「远端执行会**替换**周边 capability seam」。
所以拒绝时抛出的是**官方同形状**的 `FS_SANDBOX_DENIED`（带 `[sandbox: …]` 与升级提示），模型的
升级重试路径不受影响。

**威胁模型要讲清楚**：这是**遏制，不是安全边界**（与官方 `dsh-fs-sandbox` 文件头的口径一致）。
路径按字典比较，远端机上的符号链接与 TOCTOU 可以绕过；一旦 bash 跑起来，它用的是该用户自己的权限。
它真正买到的，是「受限会话不会**误**改工作区外的远端文件，且 read-only 会话不会偷偷跑命令」。
需要硬边界的部署，请在**远端那一侧**做（容器、按用户隔离、文件系统 ACL）。
不想用可设 `remoteSandbox: 'off'`（或 `'inherit'` 之外的值显式指定某一模式）。

**密钥库写不进去时，密码会明文落盘吗？**（0.8.54+）—— 默认**不会**。以前系统密钥库失败
（keychain 锁着 / 缺 secret-tool / Windows DPAPI 缺程序集）会**回退明文**写进 `machines.json` 并
给个警告——你本来要的是加密，结果反而更不安全，而「密钥库正好坏了」恰恰是最不容易注意到的时候。
现在默认 `credentialFallback: 'refuse'`：**不保存**该密码，机器照常保存但没有凭据，界面明确报出
密钥库失败原因。想要旧行为（宁可明文也要能连）就设 `credentialFallback: 'plain'`。
主动关掉加密（`backend: 'plain'`）不受影响，那本来就是明文。

**机器多了怎么不选错？**（0.8.54+）—— 给机器打**分组标签**：`environment`（prod/staging…）、
`location`（shanghai/gpu-lab…）、`description`、`tags`（一组自由标签）。它们纯粹是标签，不改变任何
连接行为。`rw_machines` 支持按这些维度筛选（维度之间 AND，标签之间 OR）：
`rw_machines(environment="prod", tags="gpu")`。筛不到时会列出**当前有哪些分组**，省得你猜标签拼法。
设置页同样可以编辑。机器一多，「选对机器」就从记性变成了筛选。

**多级跳板机怎么办？**（0.8.54+）—— 支持**多跳链路**（等价 OpenSSH 的 `ProxyJump a,b,c`）：
跳板机自己也可以带 `proxy`，链路从**最远一跳**往里建，每一跳都通过上一跳已建立的连接拨号。
两个关键约束：**凭据不跨跳继承**（绝不把目标机的私钥递给中间机——既通常没被授权，也等于把不该给的
秘密给了它）；链路深度超过 8 跳会明确报错，用来把**配置成环**变成一条清晰的错误，而不是无限递归。
每一跳可以自带 `privateKeyPath` / `useAgent` / `hostKeyMode`，没写就沿用操作者自己的 ssh 环境。

**能在 DSH 里直接开一个远端终端吗？**（0.8.54+）—— 能，**内嵌 PTY 终端**。`rw_exec` 是「跑一条命令
就关」，没有 PTY、stdin 也回不去，所以 `vim`、`top`、`sudo` 提示符、全屏 TUI 都用不了。
现在 `pool.shell()` 打开一条**持久的 PTY 通道**，终端会话归宿主所有：关掉浏览器不会杀掉远端 shell
（写了一半的 vim 能活过刷新），每个会话有 30 分钟空闲回收、进程内最多 8 个（免得打爆远端
`MaxSessions`），插件卸载时全部挂断。

传输方式刻意做得很朴素：远端会话在**宿主**，浏览器**轮询**输出增量（输入是单独请求、立即写入，
所以打字从不排队等轮询）。这样不依赖宿主是否暴露 WebSocket 升级路径。路由是
`/dsh-remote/term/{open,input,output,resize,close,list}`，每个都先按**会话**解析绑定——
开在 A 机的终端，绑到 B 机的请求既看不到也驱动不了。

**机器换了 IP / 用户名，工作区要全部重建吗？**（issue #67）—— 不用（0.8.52+）。在设置页编辑该机器的新
地址并保存，或 `rw_connect(machineId=…, host=…, username=…, port=…)` 同传新地址：该机器名下所有工作区
镜像会**原地重绑**（改写镜像的 `.dsh-remote-meta.json`），本地内容保留、无需重新同步，保存后会提示重绑了
几个镜像。镜像目录名不会跟着改（活 session 的 cwd 在其中），目录名只是显示标签、不影响连接。

**远程会话看不到工作区的 AGENTS.md**（issue #68）—— 已修（0.8.52+）。核心的指令加载只认本地文件系统，
而远程会话的 cwd 是本地镜像，远端仓库的 AGENTS.md 以前永远进不了模型上下文。现在 `rw_pick_workspace`
成功时会对远程工作区做浅扫（根 + 向下 ≤2 层，只匹配 `AGENTS.md`/`CLAUDE.md`），把命中的文件按三向安全
规则同步进本地镜像（根级文件由此进入核心自己的注入链路，与本地会话一致），并把路径+标题索引渲染进
system prompt，提示模型编辑前用 `rw_read_file` 阅读嵌套层的指令。全树递归扫描与插件侧全文注入都**刻意
不做**（前者会扫穿多项目根目录，后者会与核心的注入管线并行打架）。

**读了远程子目录的文件，子目录里的 AGENTS.md 会自动进上下文吗？**（issue #71）—— 会（0.8.53+）。
#68 只修了静态部分（工作区浅扫 + 索引行）；动态部分当时还断着，原因是核心的增量注入只认
`read`/`write`/`edit` 且只认 `file_path` 参数，而 `rw_read_file` 名字和参数都对不上，且它做作用域
扩展时用的是**本地**路径——远程绝对路径映射不到镜像 cwd，三个断点任一都足以让注入永不发生。
现在插件自己在 `tools/result` 里接 `rw_*` 文件触碰，取「被访问目录 → 工作区根」的**整条目录链**
（不是最近一层，与本地会话一致：读 `a/b/c.ts` 会同时收 `a/AGENTS.md` 和 `a/b/AGENTS.md`），逐层
`stat` 后把当前内容合成**一条** user message 注入。几个关键边界：cwd 自己那层不重扫（核心 baseline
已覆盖，所以读工作区根下的文件不触发任何额外扫描）；按内容摘要 per-session 去重，同内容只注入一次；
远端修改后下次触碰即重新注入；注入过的文件被删除会发一条「已移除」提示；单次注入有 16 KB 预算；
机器离线时整条链路静默降级，既不挂工具调用也不挂 prompt 组装。注入消息用插件自己的
`source.kind`（`dsh-remote-instructions`），核心的状态机只认领它自己的 `agent-instructions`，两条
注入路径不会互相打架。

**`rw_exec` 能像内置 shell 那样自定义超时/取消/转后台吗？**（issue #70）—— 能（0.8.53+）。
底层 `pool.exec` 本来就支持 `timeoutMs` 与 `AbortSignal`，缺的是接线，现在补齐三件事：
① `timeoutMs` 参数（clamp 到 1000–600000，缺省仍用 `commandTimeoutMs`，超时文案打印**实际生效**的值，
不会印错成配置值）；② `exec.signal` 透传给 `pool.exec`——点「停止」会真的 SIGTERM 掉远端进程并立即
返回，不用再等满超时；③ `run_in_background: true` 立即返回 job id（用现成的 `job_output` 读、
`job_kill` 停），以及超时**转后台**而非直接杀（`promoteOnTimeout`，默认开）。后台/转后台依赖核心的
`jobs` 服务；没有该服务的组合（最小嵌入、测试替身）自动退化为只有前台执行——即 0.8.52 的行为，
不会因此加载失败。

**远程会话里的终端还是本机的**（issue #55）—— 已解决（0.8.75+），什么都不用点。
侧栏终端的 shell 菜单里一直有插件贡献的 **remote ssh**：那是一个按 cwd 智能路由的启动器——
会话落在远程镜像里就 `ssh` 进远端工作目录，否则自动回落成本地 shell。0.8.75 起它进一步成为
**默认 shell**：只要宿主没另外配置默认终端、你也没在 shell 菜单里手动选过别的，点「打开终端」
在远程会话里就直接落进远端（本地会话照旧开本地终端，启动器会替你分流）。两个保险：菜单里手动
选过其他 shell 的话你的选择永远优先；想回到纯手动就在配置里设 `remoteTerminalDefault: false`
（remote ssh 仍会留在菜单里）。想要更重度的方案还有**「远程 DSH 界面」**（见上文）：本机浏览器里
打开**远端机器自己**的 DSH，那里的终端原生跑在远端。只想偶尔跑一条远程命令用 `rw_exec`
（要交互式 PTY 就加 `pty: true`）。

**侧边栏「文件」面板显示的怎么是本地目录？** —— 那不是 bug，是镜像工作模型的地基：远程会话的
cwd 就是 `$DSH_HOME/remote-workspaces/…` 的本地镜像（编辑与 `rw_*` 工具都在这份副本上干活，再同步回
远端）。要看远端实时目录树，用「远程文件」页签——0.8.82 起，进入远程会话时它会**自动展开**
（better-sidebar 与宿主原生右栏两个世界都生效；设置页可关）。若它没出现，手动点右栏引导卡里的
「远程文件」即可。

**远程终端还要输密码吗？** —— 不用（0.8.81+）。只要你在这台机器的设置里存过密码（明文注册表或
操作系统钥匙串都行），终端里 ssh 的密码提示会由本机凭据桥自动应答；用私钥 / agent / `~/.ssh/config`
别名的机器本来就不问。动态码（OTP）机器仍需每次输入——那是一次性码，没法替你存。

**主机指纹变了** —— `/remote forget-key`（或设置页 → 机器 → 重新信任）。

**连接报「认证失败」** —— 检查用户名/密码/私钥路径；加密私钥要填 Passphrase；需要动态码时勾选 keyboard-interactive。

**连不上内网机器** —— 填「跳板机」主机（也可先把跳板机本身配成一台机器）。

**能不能拿远程主机上的 docker 容器当工作空间？**（issue #56）—— 能，**不需要改插件**；
插件对容器没有任何专门代码，但下面两条既有配置已经完整覆盖这个需求。请按容器**有没有对外暴露端口**二选一：

- **A：容器把 sshd 端口映射出来了**（例如 `docker run -p 127.0.0.1:2222:22 …`）—— 纯「跳板机」配置：
  Host 填 `127.0.0.1`、Port 填 `2222`、用户/私钥填容器里的，再把「跳板机」主机填**那台远程主机**。
  为什么这样文件就能落到容器里：`proxy` 的语义是「**在跳板机上**连 `<host>:<port>`」
  （`lib/pool.js` 的 `pclient.forwardOut(...this.config.host, this.config.port...)`），
  拿到的通道会被当成主连接自己的 transport（`opts.sock`），于是 SFTP 走的是**容器自己的 sshd** ⇒
  `rw_list_dir`/`rw_read_file`/`rw_write_file`/`rw_sync` 全部读写的都是容器内的文件。
  命令行等价写法：`rw_connect(host="127.0.0.1", port=2222, username="<容器用户>", privateKeyPath="<私钥>")`。
  要求：远程主机的 sshd 允许转发（`AllowTcpForwarding yes`，默认就是）。
- **B：容器没有暴露端口** —— 纯 `~/.ssh/config` + 系统 OpenSSH 后端，在**本机** `~/.ssh/config` 写：

```sshconfig
Host devbox
    HostName devbox.invalid
    User dev
    IdentityFile ~/.ssh/id_ed25519
    ProxyCommand ssh <远程主机> docker exec -i <容器名> sh -c 'exec socat - TCP:127.0.0.1:22'
```

  然后 `rw_connect(host="devbox", useSshConfig=true, backend="openssh")`。
  为什么 `exec` 和文件操作**都会**进容器：`openssh` 后端把别名原样交给 `ssh`，
  自己**从不**生成 `ProxyCommand`（`lib/openssh.js` 明确不传，就是为了让 `~/.ssh/config` 说了算），
  而 `ssh -s <目标> sftp` 与 `ssh -- <目标> <命令>` 走的是同一条流 ⇒ 两者都穿过这个 ProxyCommand。
  要求：容器里有 sshd，且有 `socat`（或用支持 stdio 的 `nc`）。
  ⚠️ **Windows 上有个坑**：POSIX OpenSSH 会把 `ProxyCommand` 交给 shell 展开，**Windows 自带的 OpenSSH 9.5 不会**
  （实测它把整串按字面当成 argv）。所以在 Windows 跑本插件时，要么把 `ProxyCommand` 写成
  不含 shell 元字符的单条命令，要么把「ssh 路径」指向 Git Bash 的 `ssh.exe`。
  （另：`docker exec -i` 传二进制是否逐字节无损，我这边没有 docker 环境验证过，B 方案建议先用小文件试。）

**企业机器只允许 GSSAPI/Kerberos（`kinit` 后 `ssh` 能进，插件进不去）** —— 在设置 → 远程工作区 → 高级配置里把「连接后端」改成 **`openssh`**（调用本机 `ssh`），并勾选「使用 ssh_config 别名」，Host 填 `~/.ssh/config` 里那个**别名**（不是 IP）。这样登录由本机 ssh 用你的 Kerberos 票据完成，且 `ProxyCommand`、`GSSAPIAuthentication` 等全部照 `~/.ssh/config` 生效 —— **配置只有 `~/.ssh/config` 一个来源**（issue #50/#51）。命令行等价写法：`rw_connect(host="<别名>", useSshConfig=true, backend="openssh")`。

**`rw_sync`/`rw_push` 报冲突** —— 两边都改过的文件会被跳过并列出（绝不静默覆盖）；手动合并后重试，或用 `force=true` 以一边为准。

**Windows 远程** —— 全部走 SFTP，不依赖 POSIX shell；中文文件用 `encoding=gbk`。

**镜像里缺目录** —— 默认 ignore 会跳过 `.git`/`node_modules` 等；在 `$DSH_HOME/remote-workspaces/.dsh-remote-ignore` 调整（gitignore 语法）。

**保存远程文件报 409** —— 打开后远端已被改动，重新读取再编辑。

**密码怎么加密保存** —— 勾选「加密保存密码」：macOS 钥匙串 / Windows DPAPI / Linux secret-tool（libsecret）；后端不可用时回退明文。

**密码框为什么是空的（星号在哪）** —— 出于安全，**任何密码都不会回传到浏览器**，所以输入框永远是空的；已经保存过密码时，输入框的占位符会显示
`••••••••（已保存，留空 = 不修改）`，下方还有一行绿字说明。留空保存 = 沿用已保存的密码，填新值 = 覆盖。passphrase 与跳板机密码同理。
机器列表里的「密码」标签也是这个含义（钥匙串里的密码同样算已保存）。

**「测试连接」用哪个密码** —— 用你眼前这份表单，但**留空的密码/私钥/passphrase 会自动沿用该机器已保存的值**，所以「编辑一台已经连上的机器 → 直接点测试」是能过的
（成功提示会注明「本次测试使用了已保存的密码」）。保存之后表单会**留在该机器上**，可以立刻点测试验证；想清空重来点「取消编辑」。

**报「缺少凭据」但你确信填过** —— 说明保存时密码没有真正落盘：勾了「加密保存密码」而系统钥匙库不可用时，插件会**拒绝**把密码写成明文并给出警告
（`credentialFallback` 默认 `refuse`）。看保存后有没有红色警告，按提示修好钥匙库再存一次，或用「测试连接」当场验证。机器没有密码/私钥/agent 时，编辑表单里会直接标黄提醒。

**报「SSH agent 不可用」** —— 该机器勾了「使用 SSH agent」，但 DSH 宿主进程里没有 `SSH_AUTH_SOCK`（Windows 默认没有 agent 服务）。启动 DSH 之前把 agent 跑起来并导出
`SSH_AUTH_SOCK`（或用 Pageant），或者取消勾选、改用密码/私钥。

**升级后插件整个不见了** —— DSH 兼容性判定丢弃了 bundle，升到 **0.8.29+** 即可（见上文「DSH 版本兼容性」）。

**「远程 DSH 界面」连不上/一直转圈** —— 先确认那台机器上的 `dsh web` **本身**能起来。
两个已知坑（插件会在报错里直接点出来）：
① **dsh 0.1.0-rc.6 在 Linux 上无法启动 web**——它依赖的 `node-pty@1.1.0` 只带了
macOS/Windows 的预编译产物，**没有 `linux-x64`**，会报 `Failed to load native module: pty.node`。
升到 0.1.5-rc.2+ 即可（其 `node-pty@1.2.0-beta.15` 带 Linux 预编译）。
② **dsh 0.1.0-rc.6 不认识 `--no-open`**（该 flag 是后加的）；插件会自动去掉它重试一次，无需你处理。
如果远端 `dsh` 不在 SSH 登录 PATH 里（例如装在私有前缀），用 `webAttachCommand` 指向它的绝对路径。


---

## 「远程 DSH 界面」连不上

**连不上大多不是插件的问题，而是远端 dsh 的版本或环境不对。** 最典型的一种：dsh 0.1.0-rc.6
依赖 `node-pty@1.1.0`，而**那个版本发布的包里没有 `linux-x64` 预编译产物** ⇒ `dsh web`
在 Linux 上根本起不来。这种情况以前只能看到「没拿到启动令牌」，无从判断。

远端如果没有可用的 `dsh`，需要你自己先装好（插件不再代装）：把 `webAttachCommand`
指向它的绝对路径即可（设置 → 远程工作区 → 机器行「编辑」→ 高级配置 → 远端 dsh 命令，
或全局 `webAttachCommand`）。

