# dsh-remote

Remote-work assistant for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Connect an SSH host, pick a **remote workspace** directory, and let the agent operate on it — list dirs, read files, run commands — without leaving the harness.

The harness Web UI intentionally binds `127.0.0.1` (the CLI rejects `--host 0.0.0.0` for safety). This plugin goes the other way: **you connect out** to a remote host over SSH and work in a remote directory.

## What it gives you

- **Connect** a remote host with **password or SSH key** (SSH/SFTP via `ssh2`).
- **Pick a remote workspace** — a remote directory the active session treats as its project root.
- **Model tools** — `rw_info`, `rw_connect`, `rw_pick_workspace`, `rw_list_dir`, `rw_read_file`, `rw_exec`, `rw_sync`.
- **Local mirror** — picking a remote workspace also creates a **real local directory** (`~/.dsh/remote-workspaces/<host>/<base>-<hash>`) that mirrors it over SFTP. Because that path passes `fs.realpath`, the DSH **native workspace selector** can pick it and `createWorkspace({ path })` adopts it — so the browser/Session workspace sees the remote project as a normal local workspace, while dsh-remote keeps it in sync with the remote.
- **Settings → 远程工作区** — enter host/login, connect, browse the remote filesystem, set the workspace, all from the UI.
- The current remote workspace (`user@host:/path`) is injected into every system prompt so the agent knows the working root.

## Install

```bash
dsh plugin --profile web add dsh-remote
```

(adds the bundle; the row is `id: dsh-remote`, `name: dsh-remote`).

## Usage

### 1. Configure a default host (optional)

In `cordis.patch.yml`:

```yaml
- id: dsh-remote
  name: dsh-remote
  config:
    host: 10.0.0.8
    port: 22
    username: dev
    privateKeyPath: C:/Users/you/.ssh/id_rsa
    # OR use password login:
    # password: '…'
    workspace: /home/dev/project
```

If `host` is empty the plugin starts disconnected and you connect at runtime.

### 2. Connect + pick a workspace

- **From the UI**: Settings → 远程工作区 → enter host/port/user + (password or key path) → **连接远程** → type a remote path and **设为远程工作区** (or **列目录** to browse).
- **From the agent**: ask it to `rw_connect(host)`, then `rw_pick_workspace(path=/…/project)`. You can also use `/remote` to see the current status.

### 3. Work in the remote workspace

The agent uses:

```
rw_list_dir(path?)      # list a remote dir (defaults to the workspace)
rw_read_file(path=-…)   # read a remote file (paged)
rw_exec(command=…)      # run any shell command on the remote
```

Because the workspace path is in the system prompt, the agent treats it as the working root and combines these tools to inspect/build/test the remote project.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `host` | string | `''` | Remote SSH host (empty = start disconnected) |
| `port` | int | `22` | Remote SSH port |
| `username` | string | `''` | SSH login user |
| `password` | string | `''` | SSH password (overrides the key when non-empty) |
| `privateKeyPath` | string | `''` | Absolute key path; empty → `~/.ssh/id_rsa` |
| `passphrase` | string | `''` | Key passphrase if encrypted |
| `workspace` | string | `''` | Initial remote workspace dir |
| `commandTimeoutMs` | int | 20000 | Per remote command timeout |
| `connectTimeoutMs` | int | 15000 | SSH connect timeout |

## Browser page

Settings → 远程工作区: connect form (host/port/user/password|key), directory browse (`/dsh-remote/ls`), and "设为远程工作区" (`/dsh-remote/workspace`). All same-origin JSON routes on the harness `webServer`; the SSH pool lives in the host half, so credentials are only posted to loopback.

**Safety note**: giving the plugin remote credentials lets the agent run shell commands on that host **as your user**. Grant only on hosts you trust.

## License

MIT