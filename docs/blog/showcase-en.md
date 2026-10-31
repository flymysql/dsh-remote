# dsh-remote: a remote workspace for DeepSeek Harness

> Manage several SSH machines, pick a remote workspace right inside the harness Web UI, and let the agent read/write files and run commands on the remote host — without leaving DSH or touching its core.

## Why

The DSH Web GUI intentionally binds `127.0.0.1` (the CLI rejects `--host 0.0.0.0` for safety). Great security, but it means the agent can only touch local files. Real code, build envs, and datasets often live on another box.

`dsh-remote` flips the model: **you connect out** to machines you maintain. The GUI stays loopback-only; the plugin opens SSH sessions internally — think IDE Remote-SSH, but for the agent.

## What it does

After install you get `rw_*` tools plus a picker that takes over the native **Add workspace** flow:

21 tools, grouped by purpose:

| Purpose | Tools |
|---|---|
| Connect & machines | `rw_connect`, `rw_machines` (filter by `environment`/`location`/`tags`), `rw_info`, `rw_disconnect` |
| Workspace | `rw_pick_workspace`, `rw_list_dir`, `rw_stat` |
| Files | `rw_read_file`, `rw_write_file`, `rw_edit` (atomic write + mtime optimistic lock), `rw_append`, `rw_mkdir`, `rw_remove`, `rw_move` |
| Run & search | `rw_exec` (per-call timeout, real cancellation, promote-to-background), `rw_search` |
| Sync | `rw_sync`, `rw_push` (conflict-aware, three-way) |
| Transfer & tunnels | `rw_download`, `rw_upload`, `rw_forward` (local and reverse port forwarding) |

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

### Recent milestones (0.8.50 → 0.8.54)

The plugin moves fast; a few capabilities deserve calling out:

- **Remote sandbox (0.8.54)** — remote commands used to run under **no policy at all**: a local session has read-only / workspace-write, but every `rw_*` call bypassed it entirely. The plugin now applies the same resolved mode, and a denial carries the same sandbox error and escalation hint a local one does. To be explicit: this is **containment, not a security boundary** (paths are compared lexically, so remote symlinks can escape) — deploy hard boundaries on the remote side.
- **Embedded PTY terminal (0.8.54)** — `rw_exec` runs one command and closes, with no PTY, so `vim`, `top` and `sudo` prompts were impossible. A persistent PTY channel changes that; sessions are host-owned, so closing the browser does not kill the remote shell, and they are reclaimed after 30 idle minutes.
- **No silent plaintext downgrade (0.8.54)** — when the OS keychain refused a password, the plugin used to fall back to writing it in **plaintext** into `machines.json`. It now saves nothing and says why; set `credentialFallback: plain` for the old behaviour.
- **Host grouping + multi-hop bastions (0.8.54)** — label machines with `environment`/`location`/`tags` and filter by group; a bastion may carry its own `proxy`, giving `ProxyJump a,b,c` chains where credentials **do not inherit across hops**.
- **Instruction files reach the context (0.8.52–0.8.53)** — a remote workspace `AGENTS.md` is discovered, mirrored and indexed; reading a nested file injects the **whole ancestor chain** of instruction files, matching local-session behaviour.
- **SFTP timeout self-healing (0.8.52)** — one 20s timeout used to wedge that machine's SFTP permanently (leaking across sessions until a reconnect). A timeout now invalidates the channel and two consecutive ones rebuild the connection; `rw_edit` also writes atomically, so an interrupted write cannot truncate the remote file.

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
