# dsh-remote：给 DeepSeek Harness 装上「远程工作区」

> 在 DSH 的 Web UI 里，直接管理多台 SSH 机器、选择远程工作区、并让 Agent 在远端读写文件 / 跑命令 —— 全程不离开 harness，也不改核心。

## 为什么需要它

DeepSeek Harness 的 Web UI 刻意只绑定 `127.0.0.1`（CLI 会拒绝 `--host 0.0.0.0`，这是官方安全设计：GUI 绝不暴露到网络）。这很棒，但副作用是：**Agent 只能操作本机文件系统**。

现实里我们的代码、构建环境、数据集常常在另一台机器上。于是要么来回同步，要么把整个 GUI 暴露出去（危险）。

`dsh-remote` 走的是另一条路：**你向外连接你自己维护的机器**。Web UI 仍然只在本机，插件在内部建立 SSH 会话 —— 就像 IDE 的 Remote-SSH，只是这次连的是 Agent。

## 它能做什么

安装后你会得到一组 `rw_*` 工具，以及一个接管原生「添加工作区」流程的选择器：

| 能力 | 说明 |
|---|---|
| `rw_connect` | SSH 连接（密码或私钥，支持自定义端口/用户名） |
| `rw_pick_workspace` / `rw_list_dir` | 选择/浏览远程工作区目录 |
| `rw_read_file` / `rw_write_file` | 读写远端文本文件（带行号分页） |
| `rw_exec` | 在远端执行任意命令（构建、测试、grep…） |
| `rw_sync` / `rw_push` | 把远程目录镜像成本地真实工作区 / 上传本地改动回远端 |
| `rw_info` / `rw_disconnect` | 连接状态 / 断开 |

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

## 链接

- 仓库：https://github.com/flymysql/dsh-remote
- npm：https://www.npmjs.com/package/dsh-remote
- 变更记录：https://github.com/flymysql/dsh-remote/blob/main/CHANGELOG.md

---

*反馈 / issue / PR 都欢迎。如果你也在做 DSH 插件，欢迎交流。*
