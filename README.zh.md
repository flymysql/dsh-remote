# dsh-remote

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的远程工作助手。

连接一台 SSH 主机，选取一个**远程工作区**目录，让 Agent 在不离开 harness 的情况下直接对它操作——列目录、读文件、跑命令。

DSH Web 界面刻意只监听 `127.0.0.1`（`--host 0.0.0.0` 被安全地拒绝）。这个插件的思路相反：**由你主动向外连**到远程主机，在远程目录里工作。

## 能力

- **连接远程**：支持**密码或 SSH key**（基于 `ssh2`）。
- **选取远程工作区**：把远程某个目录当作本会话的项目根。
- **模型工具**：`rw_info`、`rw_connect`、`rw_pick_workspace`、`rw_list_dir`、`rw_read_file`、`rw_exec`、`rw_sync`。
- **本地镜像**：选远程工作区时会在本地 `~/.dsh/remote-workspaces/<host>/<base>-<hash>` 生成一个**真实本地目录**并经 SFTP 镜像。该路径通过 `fs.realpath`，因此 DSH 原生工作区选择器能选中它、`createWorkspace({path})` 能把它收养——浏览器/会话里的工作区把它当普通本地工作区，同时 dsh-remote 与远程保持同步。
- **设置 → 远程工作区**：输入主机与登录方式→连接→浏览远程文件系统→设为工作区。
- 当前远程工作区（`user@host:/path`）会注入每次系统提示，让 Agent 明确知道工作根目录。

## 安装

```bash
dsh plugin --profile web add dsh-remote
```

（bundle 安装；行内容是 `id: dsh-remote`、`name: dsh-remote`。）

## 使用

### 1. 可选：在配置里设默认主机

`cordis.patch.yml`：

```yaml
- id: dsh-remote
  name: dsh-remote
  config:
    host: 10.0.0.8
    port: 22
    username: dev
    privateKeyPath: C:/Users/you/.ssh/id_rsa
    # 或用密码登录：
    # password: '…'
    workspace: /home/dev/project
```

若 `host` 为空，插件启动时处于断开状态，可在运行时连接。

### 2. 连接并选工作区

- **UI**：设置 → 远程工作区 → 填 host/port/user +（密码或 key 路径）→ **连接远程** → 输入远程路径并按 **设为远程工作区**（或用 **列目录** 浏览）。
- **让 Agent 做**：`rw_connect(host)` 之后 `rw_pick_workspace(path=/…/project)`；随时可用 `/remote` 看状态。

### 3. 在远程工作区里工作

Agent 使用：
```
rw_list_dir(path?)
rw_read_file(path=…)
rw_exec(command=…)
```
由于工作区路径在系统提示里，Agent 会把它当作工作根，组合这些工具对远程项目做查看/构建/测试。

## 配置

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | string | `''` | 远程 SSH 主机（空=断开） |
| `port` | int | `22` | 远程 SSH 端口 |
| `username` | string | `''` | 登录用户 |
| `password` | string | `''` | SSH 密码（非空则覆盖 key） |
| `privateKeyPath` | string | `''` | 私钥绝对路径；空=`~/.ssh/id_rsa` |
| `passphrase` | string | `''` | 私钥口令（若加密） |
| `workspace` | string | `''` | 初始远程工作区目录 |
| `commandTimeoutMs` | int | 20000 | 单条命令超时 |
| `connectTimeoutMs` | int | 15000 | SSH 连接超时 |

## 浏览器页

设置 → 远程工作区：连接表单（host/port/user/密码|key）、目录浏览（`/dsh-remote/ls`）、「设为远程工作区」（`/dsh-remote/workspace`）。全部走 harness `webServer` 的同源 JSON 路由；SSH 池在 host 端，凭据只在本地回环上提交。

**安全提醒**：把远程凭据交给插件，等于允许 Agent 以你的用户身份在该主机上执行 shell 命令。只对可信主机开放。

## License

MIT