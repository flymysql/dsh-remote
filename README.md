# dsh-remote

**Remote-work assistant for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).**

Manage several SSH machines, then pick a **remote workspace** (or a **local** one) and let the agent operate right there without leaving the harness — listing files, reading code, running builds & commands over the remote host, and keeping that remote directory mirrored into a real local workspace object.

The harness Web UI intentionally binds `127.0.0.1` (the CLI rejects `--host 0.0.0.0` for safety). This plugin goes the other way: **you connect out** to the machines you maintain, pick a workspace, and work in it through the normal DSH workspace + agent fs flows — no changes to `dsh-workspace` or the harness core.

## Screen previews

Settings → **远程工作区** — a multi-machine SSH registry (add / edit / delete / set-current, password stored locally):

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/ui-settings.svg" alt="dsh-remote settings — multi-machine registry" width="720"/>

The native **"Add workspace" / "Select workspace"** flow — one dialog, two tabs (本地 local / 远程 remote):

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/ui-picker.svg" alt="dsh-remote workspace picker — 本机 (native OS folder) + 远程 (machine → directory)" width="720"/>

---

## Features

- **Multi-machine SSH** — save any number of hosts (`host`/`port`/`user` + **private key** or **password**). Passwords are stored locally and never shown back in the UI. Switch with one click in Settings.
- **Two-tab workspace picker** (fills the native "Add workspace" flow):
  - **本机 / Local** — opens the **native OS folder chooser** over the host, or lets you type a local path → adopted directly as a normal DSH local workspace (local workspaces fully coexist).
  - **远程 / Remote** — pick a **machine**, then browse its directories (or type a path) 🡺 on confirm it creates a **real local mirror** (`~/.dsh/remote-workspaces/<host>/<base>-<hash>`) that passes `fs.realpath` → the harness adopts it as a real workspace while dsh-remote keeps it synced over SFTP.
- **Bidirectional SFTP sync** — `rw_sync` (remote → mirror) and `rw_push` (mirror → remote) round-trip your local-mirror edits back to the machine.
- **Model tools** — `rw_info`, `rw_connect`, `rw_pick_workspace`, `rw_list_dir`, `rw_read_file`, `rw_exec`, `rw_sync`, `rw_push`.
- The active `user@host:/path` is injected into every system prompt so the agent knows its working root.
- **No official `dsh-workspace` core is modified** — everything is delivered as a normal plugin (directory-flow holes filled by the client half at `priority -100`).

## Install

```bash
dsh plugin add dsh-remote            # add the bundle
```

(or `npm install dsh-remote` + add `- id: dsh-remote / name: dsh-remote` in `cordis.patch.yml`).

## Quick start

1. **Add a machine** — Settings → 远程工作区 → add host/port/user + key or password → (optional) set it current.
2. **Open a workspace** — click **Add workspace** in the sidebar / conversation:
   - **本机** → system folder chooser (or type a local path) → local workspace.
   - **远程** → choose the machine → browse to a remote directory (or type `/path`) → "设为远程工作区" ⇒ a local mirror workspace is created and adopted.
3. **Work with the agent** — treat it like any workspace:
   - `rw_list_dir(path?)`/`rw_read_file` — inspect remote files
   - `rw_exec(command)` — run remote shell commands
   - `rw_sync` / `rw_push` — pull/push the local mirror to and from the remote

## CLI defaults (optional)

Provide a default machine in `cordis.patch.yml`:

```yaml
# Example only — use values for your own machine.
- id: dsh-remote
  name: dsh-remote
  config:
    host: 203.0.113.10   # or your real host / hostname
    port: 22
    username: dev
    privateKeyPath: ~/.ssh/id_rsa
    # or password: '…'
    workspace: ~/project
```

If `host` is empty the plugin starts disconnected and you configure machines in the UI.

## CLI quick reference

Installing and driving DSH may live in different shells, so both the `dsh` binary and the `npx` form are shown. Always tell DSH **which profile** to use with `--profile <name>` (usually `web`).

```bash
# install the bundle into a profile (npm is pulled by pnpm; recommended)
dsh plugin --profile web add dsh-remote
# same but when `dsh` is not on PATH (e.g. Windows PowerShell inside a repo)
npx --yes @deepseek-ai/dsh plugin --profile web add dsh-remote

# confirm it is installed wire
dsh plugin --profile web list
npx --yes @deepseek-ai/dsh plugin --profile web list

# start the web surface (reload profile; the plugin activates on boot)
dsh --profile web
npx --yes @deepseek-ai/dsh --profile web   # http://127.0.0.1:3080

# use a local checkout instead of the npm version (dev iteration)
npx --yes @deepseek-ai/dsh plugin --profile web add /path/to/dsh-remote
npx --yes @deepseek-ai/dsh plugin --profile web remove dsh-remote   # back to release
```

After a successful start, `Settings → 远程工作区` appears and the "Add workspace" flow gains the 本机 / 远程 tabs (screenshots above).

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `host` | string | `''` | default SSH host (else start disconnected) |
| `port` | int | `22` | default SSH port |
| `username` | string | `''` | default SSH user |
| `password` | string | `''` | default SSH password (non-empty overrides key) |
| `privateKeyPath` | string | `''` | private key path (`~/.ssh/id_rsa` when empty) |
| `workspace` | string | `''` | default remote workspace path |
| `commandTimeoutMs` | int | 20000 | per remote command timeout |
| `connectTimeoutMs` | int | 15000 | SSH connect timeout |

## Safety

Giving the plugin a machine's credentials lets the agent run **shell commands as your user** on that host. Only add machines you trust. Passwords are saved on the local machine file; treat it as sensitive (you may lock file ACLs).

## License

MIT