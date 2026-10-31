# dsh-remote：给 DeepSeek Harness 装上「远程工作区」

> 在 DSH 的 Web UI 里，直接管理多台 SSH 机器、选择远程工作区、并让 Agent 在远端读写文件 / 跑命令 —— 全程不离开 harness，也不改核心。

## 为什么需要它

DeepSeek Harness 的 Web UI 刻意只绑定 `127.0.0.1`（CLI 会拒绝 `--host 0.0.0.0`，这是官方安全设计：GUI 绝不暴露到网络）。这很棒，但副作用是：**Agent 只能操作本机文件系统**。

现实里我们的代码、构建环境、数据集常常在另一台机器上。于是要么来回同步，要么把整个 GUI 暴露出去（危险）。

`dsh-remote` 走的是另一条路：**你向外连接你自己维护的机器**。Web UI 仍然只在本机，插件在内部建立 SSH 会话 —— 就像 IDE 的 Remote-SSH，只是这次连的是 Agent。

## 它能做什么

安装后你会得到一组 `rw_*` 工具，以及一个接管原生「添加工作区」流程的选择器：

21 个工具，按用途分组：

| 用途 | 工具 |
|---|---|
| 连接与机器 | `rw_connect`、`rw_machines`（可用 `environment`/`location`/`tags` 分组筛选）、`rw_info`、`rw_disconnect` |
| 工作区 | `rw_pick_workspace`、`rw_list_dir`、`rw_stat` |
| 文件读写 | `rw_read_file`、`rw_write_file`、`rw_edit`（原子写 + mtime 乐观锁）、`rw_append`、`rw_mkdir`、`rw_remove`、`rw_move` |
| 执行与搜索 | `rw_exec`（单次超时 / 真取消 / 超时可转后台）、`rw_search` |
| 同步 | `rw_sync`、`rw_push`（三路冲突感知） |
| 传输与隧道 | `rw_download`、`rw_upload`、`rw_forward`（本地与反向端口转发） |

### 工作区选择器（原生「添加工作区」弹窗）

- **居中弹窗**，不再被窄侧边栏挤压；
- 默认落在 **本机** 页签（系统文件夹选择器 / 直接输入本地路径）；
- 切到 **远程**：机器下拉 → 路径框**自动预填 `/`**，输入时**逐级实时补全目录**（选中一级立即列出下一级，像系统/VSCode 选目录）；
- **浏览…** 浮窗可浏览远端目录树，选中只回填到输入框，你复核后再提交；
- 提交后插件把远程目录**镜像成真实本地工作区对象**，普通 workspace + agent 文件流程直接可用。

真实截图（主机已打码）：

<img src="https://cdn.jsdelivr.net/gh/flymysql/dsh-remote@main/docs/ui-picker-panel.png" alt="dsh-remote 工作区选择器真实截图" width="720"/>

设置页（浅色主题，白底真实截图，主机已打码）：

<img src="https://cdn.jsdelivr.net/gh/flymysql/dsh-remote@main/docs/ui-settings-panel.png" alt="dsh-remote 设置页真实截图" width="720"/>

### 近期重要演进（0.8.50 → 0.8.54）

插件迭代很快，几项能力值得单独说明：

- **远端 sandbox（0.8.54）** —— 以前远端命令**不受任何策略约束**：本机会话有 read-only / workspace-write，而 `rw_*` 打出去的命令完全绕过它。现在套用同一套已解析模式，拒绝时给出与本地同形状的沙箱错误与升级提示。要说清楚的是：这是**遏制，不是安全边界**（路径按字典比较，远端符号链接可绕），硬边界请在远端一侧做。
- **内嵌 PTY 终端（0.8.54）** —— `rw_exec` 跑一条命令就关，没有 PTY，所以 `vim`/`top`/`sudo` 提示符都用不了。新增持久 PTY 通道，会话归宿主所有：关掉浏览器不会杀远端 shell，空闲 30 分钟回收。
- **凭据不再静默降级明文（0.8.54）** —— 系统钥匙串写入失败时，以前会「回退成明文写进 machines.json」。现在默认**不保存**该密码并明确报错，想要旧行为可显式设 `credentialFallback: plain`。
- **主机分组 + 多跳跳板机（0.8.54）** —— 给机器打 `environment`/`location`/`tags` 标签并按组筛选；跳板机支持等价 `ProxyJump a,b,c` 的多跳链路，且**凭据不跨跳继承**。
- **指令文件自动进上下文（0.8.52–0.8.53）** —— 远程工作区的 `AGENTS.md` 会被发现、镜像并索引；读子目录文件时，**整条目录链**上的指令文件自动注入，行为与本地会话对齐。
- **SFTP 超时自愈（0.8.52）** —— 以前一次 20 秒超时会让该机器的 SFTP 永久卡死（跨会话传染，只能重连）。现在超时即作废通道，连续两次超时重建连接；`rw_edit` 也改成了原子写，写一半中断不会再截断远端文件。

## 安装

```sh
dsh plugin add dsh-remote
```

安装后：打开 DSH Web GUI → 设置 → 「远程工作区」添加机器（host/port/user + 密码或私钥路径）→ 点「+ 添加工作区」→ 切「远程」→ 选机器、选目录、提交。

> 私钥路径仅在显式提供时使用；不提供私钥则必须填密码。凭据保存在本机，界面不回显。

## 安全性

- **不改 dsh-workspace 核心** —— 插件在 priority −100 填充原生目录流程的插槽；
- Web GUI 仍只绑定 `127.0.0.1`；插件只**向外**连接你配置的机器；
- 密码本地保存、永不回显；`privateKeyPath` 不再隐式读取 `~/.ssh/id_rsa`（v0.5.5 起，凭据必须显式给出）；
- 把机器凭据交给插件 = 允许 Agent 以你的用户身份在远端执行命令 —— **只添加你信任的机器**。
- 远端操作受会话 sandbox 约束（0.8.54+）：read-only 会话不能写远端、不能跑命令；workspace-write 把写入围在工作区内。但这是**遏制而非安全边界**，真正的隔离请在远端做（容器 / 独立账号 / ACL）。
- 凭据写入系统钥匙串失败时默认**不落盘**（0.8.54+），不会静默降级成明文。

## 链接

- 仓库：https://github.com/flymysql/dsh-remote
- npm：https://www.npmjs.com/package/dsh-remote
- 变更记录：https://github.com/flymysql/dsh-remote/blob/main/CHANGELOG.md

---

*反馈 / issue / PR 都欢迎。如果你也在做 DSH 插件，欢迎交流。*
