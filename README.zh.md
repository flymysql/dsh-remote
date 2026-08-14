# dsh-remote

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的**远程接入助手**插件。

Harness 的 Web GUI **刻意只监听 `127.0.0.1`**——CLI 直接拒绝 `--host 0.0.0.0`（安全设计：GUI 无鉴权、Agent 能执行代码，绑全网等于把远程代码执行暴露给网络）。所以远程访问本质上是个**隧道工作流**，这个插件把它变成"复制粘贴"：

- **`/remote` 斜杠命令** —— 直接打印本实例的精确隧道命令
- **设置 → 远程访问** —— 实时端口、局域网 IP、trusted hosts 与带一键复制的命令块
- 覆盖三条官方支持的路径：SSH 本地转发（`ssh -L`）、保活（`autossh`）、反向隧道（`ssh -R`，NAT 友好）、反向代理直达（`--trusted-host`）

## 安装

```bash
npm install dsh-remote
```

在你的 profile `cordis.yml`（或 `cordis.patch.yml`）里加一行：

```yaml
- id: dsh-remote
  name: dsh-remote
```

## 用法

### 聊天里

输入 `/remote`（可选带 `/remote user@host`）：

```
/remote root@9.134.186.191
```

输出：

```
## dsh-remote — remote access

Web GUI: http://127.0.0.1:3080

### Tunnel from your PC (recommended — harness stays loopback)
ssh -N -L 18080:127.0.0.1:3080 root@9.134.186.191
autossh -M 0 -N -L 18080:127.0.0.1:3080 root@9.134.186.191

### Reverse tunnel (remote pushes out; NAT-friendly)
ssh -N -R 3080:127.0.0.1:3080 root@9.134.186.191

### Direct web access behind a reverse proxy (add auth yourself!)
dsh --profile web --port 3080 --trusted-host <your-public-host>
```

在你 PC 上跑 `ssh -N -L ...` 那行，然后浏览器打开 **http://127.0.0.1:18080**。因为浏览器源仍是 loopback，harness 的 `/api` 信任围栏直接放行、无需任何额外参数——且连接走 SSH 加密认证。

### 设置页

设置 → 远程访问：同样的信息 + 本机局域网 IP，每个命令一键复制；输入 `user@host` 可按目标重新生成命令。

## 配置

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `localPort` | int | 18080 | 生成的 `ssh -L` / `autossh` 命令里的本机端口（PC 侧） |

```yaml
- id: dsh-remote
  name: dsh-remote
  config:
    localPort: 20080
```

## 为什么不能直接绑 0.0.0.0？

Harness 刻意拒绝 `--host 0.0.0.0`（报错原文：`intentionally not supported yet for safety: it would expose remote code execution to the network`）。GUI 没有登录鉴权，而 Agent 能在沙箱里执行代码——绑全网 = 把远程代码执行交给网段里任何人。隧道（SSH 或带鉴权的反向代理）才是官方支持的方式，这正是本插件自动化的东西。

## 浏览器页面

设置 → 远程访问。页面通过 harness 官方 `webServer` 服务拉取 `GET /dsh-remote/info`（同源 JSON 路由）。

## License

MIT
