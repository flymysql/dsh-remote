# dsh-remote

Remote-access assistant for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

The harness Web GUI intentionally listens on `127.0.0.1` only — the CLI rejects `--host 0.0.0.0` for safety (the GUI has no auth and the agent executes code). That means remote access is a **tunneling workflow**, and this plugin makes it copy-paste easy:

- **`/remote` slash command** — prints the exact commands for this instance
- **Settings → 远程访问 (Remote Access)** — live port, LAN IPs, trusted hosts and command blocks with copy buttons
- Covers the three supported paths: SSH local forward (`ssh -L`), keepalive (`autossh`), reverse tunnel (`ssh -R`, NAT-friendly), and reverse-proxy access with `--trusted-host`

## Install

```bash
npm install dsh-remote
```

Add a row to your profile `cordis.yml` (or `cordis.patch.yml`):

```yaml
- id: dsh-remote
  name: dsh-remote
```

## Usage

### From the chat

Type `/remote` (optionally `/remote user@host`):

```
/remote root@9.134.186.191
```

Output:

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

Run the `ssh -N -L ...` line on your PC, then open **http://127.0.0.1:18080** in the browser. Because the browser origin stays loopback, the harness `/api` trust fence accepts it with no extra flags — and the connection is SSH-encrypted and authenticated.

### From the settings page

Settings → 远程访问 shows the same information, plus the machine's LAN IPs, with one-click copy per command. Entering `user@host` regenerates the commands with that target.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `localPort` | int | 18080 | Local port used by the generated `ssh -L` / `autossh` commands (the PC side) |

```yaml
- id: dsh-remote
  name: dsh-remote
  config:
    localPort: 20080
```

## Why not just bind 0.0.0.0?

The harness deliberately refuses `--host 0.0.0.0` (`error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network`). The GUI has no authentication, and the agent can execute code in the sandbox — binding every interface would hand remote code execution to anyone on the network. Tunnels (SSH or an authenticated reverse proxy) are the supported way, and that is what this plugin automates.

## Browser page

Settings → 远程访问 (Remote Access). The page fetches `GET /dsh-remote/info` from the harness `webServer` service (same-origin JSON route).

## License

MIT
