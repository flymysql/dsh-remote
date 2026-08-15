# Promotion kit (author notes) — dsh-remote

Copy-paste helpers for publishing and sharing `dsh-remote` on GitHub / npm.
This file is for the author; nothing here is shown in the README install flow.

---

## 0. GitHub repo — set Topics

`github.com/flymysql/dsh-remote` → repo **About** (gear top-right) → **Topics**, add:

```
dsh-plugin  deepseek-harness  remote  ssh  tunnel  plugin
```

This makes the repo appear on `https://github.com/topics/dsh-plugin` (the official
CONTRIBUTING.md discovery channel).

---

## 1. GitHub Release — `v0.5.4` (paste into "Releases → Draft a new release")

Tag: `v0.5.4` · Title: `v0.5.4 — publish metadata`

```markdown
## Highlights since 0.5.2

- **Workspace picker is now a centered modal** — no longer squeezed into a narrow sidebar.
- **Opens on the 本机 (local) tab**; 远程 (remote) is one click away.
- **远程 / Remote** workflow:
  - Path field **auto-prefills `/`** and **live-completes** directories; selecting a directory
    immediately reveals its next level (OS/VSCode-style cascade).
  - **浏览…** floating browser (opaque, height-capped, scrollable, follows symlinks) fills
    the field without committing — you review, edit, then 设为远程工作区.
  - Machine `<select>` dropdown is no longer clipped by the dialog.
- Real desensitized screenshot (placeholder host) in the README.
- npm manifest now carries `homepage` / `repository` / `author` for discoverability.

## Install
dsh plugin add dsh-remote
```

---

## 2. DeepSeek Harness Discussions — showcase post

Post to: `https://github.com/deepseek-ai/deepseek-harness/discussions`

### English

```markdown
## Showcase: dsh-remote — a remote-work assistant plugin

Hi team & community 👋

[dsh-remote](https://github.com/flymysql/dsh-remote) lets the agent work on machines outside the
harness: manage several SSH hosts right in Settings, pick a **remote workspace** in the native
"Add workspace" dialog (machine → directory, with a path field that auto-fills `/` and
live-completes directories OS/VSCode-style), and operate there with tools
(`rw_connect`, `rw_list_dir`, `rw_read_file`, `rw_write_file`, `rw_exec`, `rw_sync`/`rw_push`,
`rw_disconnect`). The remote directory is mirrored to a real local workspace object, so the
normal workspace + agent-fs flows just work.

It deliberately follows the harness safety design — the web GUI stays loopback-only; this plugin
opens **out** to machines *you* maintain, and does not patch `dsh-workspace` core (it fills the
directory-flow holes at priority −100).

- Repo: https://github.com/flymysql/dsh-remote
- npm: https://www.npmjs.com/package/dsh-remote
- Install: `dsh plugin add dsh-remote`

Happy to take feedback, issues, or PRs. Thanks!
```

### 中文

```markdown
- Showcase：dsh-remote —— 让 Agent 直达远程机器工作

给 DeepSeek Harness 加一个远程工作助手：在 Settings 维护多台 SSH 主机，在原生
「添加工作区」弹窗里（默认本地 tab；切「远程」后可输入远程路径、路径框自动预填 `/`
并逐级自动补全目录），用 `rw_list_dir` / `rw_read_file` / `rw_write_file` / `rw_exec` /
`rw_sync` / `rw_push` / `rw_disconnect` 直接操作远端。远程目录会被镜像成真实本地工作区，
普通 workspace / agent 流程即可直接使用。

它遵循 harness 的安全设计：Web UI 仍只绑定 loopback，插件是“向外连你自己维护的机器”，
不修改 dsh-workspace 核心（在 priority −100 填充目录流程插槽）。

- 仓库：https://github.com/flymysql/dsh-remote
- npm：https://www.npmjs.com/package/dsh-remote
- 安装：`dsh plugin add dsh-remote`
```

---

## 3. npm page metadata (now live)

`homepage` / `repository` / `author` / `bugs` → npm page links to the repo. ✅ published in 0.5.4.