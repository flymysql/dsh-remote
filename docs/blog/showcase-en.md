# dsh-remote: a remote workspace for DeepSeek Harness

> Manage several SSH machines, pick a remote workspace right inside the harness Web UI, and let the agent read/write files and run commands on the remote host — without leaving DSH or touching its core.

## Why

The DSH Web GUI intentionally binds `127.0.0.1` (the CLI rejects `--host 0.0.0.0` for safety). Great security, but it means the agent can only touch local files. Real code, build envs, and datasets often live on another box.

`dsh-remote` flips the model: **you connect out** to machines you maintain. The GUI stays loopback-only; the plugin opens SSH sessions internally — think IDE Remote-SSH, but for the agent.

## What it does

After install you get `rw_*` tools plus a picker that takes over the native **Add workspace** flow:

| Tool | Purpose |
|---|---|
| `rw_connect` | SSH connect (password or private key, custom port/user) |
| `rw_pick_workspace` / `rw_list_dir` | Choose / browse the remote workspace dir |
| `rw_read_file` / `rw_write_file` | Read/write remote text files (line-numbered, paged) |
| `rw_exec` | Run any command on the remote host (build, test, grep…) |
| `rw_sync` / `rw_push` | Mirror the remote dir to a real local workspace / push local changes back |
| `rw_info` / `rw_disconnect` | Connection status / disconnect |

### The workspace picker (native Add-workspace dialog)

- **Centered modal** — never squeezed into the narrow sidebar.
- Defaults to the **本机 (local)** tab (system folder chooser / typed local path).
- Switch to **远程 (remote)**: machine `<select>` → path field **auto-fills `/`** with **live per-level directory autocomplete** (pick one level, the next appears — OS/VSCode-style).
- **浏览…** floating browser for the remote tree; a pick only fills the input for review, then you commit.
- On commit, the plugin mirrors the remote dir into a **real local workspace object**, so normal workspace + agent-fs flows just work.

Real capture (host scrubbed):

<img src="https://cdn.jsdelivr.net/gh/flymysql/dsh-remote@main/docs/ui-picker-panel.png" alt="dsh-remote workspace picker, real screenshot" width="720"/>

Settings pane (light theme, real capture, host scrubbed):

<img src="https://cdn.jsdelivr.net/gh/flymysql/dsh-remote@main/docs/ui-settings-panel.png" alt="dsh-remote settings, real screenshot" width="720"/>

## Install

```sh
dsh plugin add dsh-remote
```

Then: DSH Web GUI → Settings → 远程工作区 → add a machine (host/port/user + password or key path) → **+ Add workspace** → **远程** tab → pick machine, pick dir, commit.

> `privateKeyPath` is used only when explicitly provided; otherwise a password is required. Credentials stay on the local machine and are never echoed in the UI.

## Safety

- **No changes to `dsh-workspace` core** — the plugin fills the native directory-flow slots at priority −100.
- Web GUI stays loopback-only; the plugin only connects **out** to machines you configured.
- Passwords are stored locally, never shown back. Since v0.5.5 the implicit `~/.ssh/id_rsa` default is gone — credentials must be explicit.
- Granting the plugin machine credentials means the agent can run shell commands as your user on that host — **only add machines you trust.**

## Links

- Repo: https://github.com/flymysql/dsh-remote
- npm: https://www.npmjs.com/package/dsh-remote
- Changelog: https://github.com/flymysql/dsh-remote/blob/main/CHANGELOG.md

---

*Feedback, issues, and PRs welcome. If you build DSH plugins too, say hi.*
