# Publish Guide — dsh-remote

## 1. Create the GitHub repository

https://github.com/new → name **`dsh-remote`**, Public, description:

> Remote-access assistant for DeepSeek Harness: /remote command and a settings page that print the exact SSH tunnel / reverse-tunnel / reverse-proxy commands (harness intentionally binds loopback only).

Add topic **`dsh-plugin`** (plus `deepseek-harness`, `remote`, `ssh`).

## 2. Push

```bash
cd dsh-remote
git init -b main && git add -A
git commit -m "feat: dsh-remote — remote-access assistant for DeepSeek Harness

- /remote slash command printing exact tunnel commands
- Settings page (远程访问) with live port, LAN IPs, copy buttons
- local-forward / autossh / reverse-tunnel / reverse-proxy guidance
- respects the harness safety design (loopback-only, no 0.0.0.0 hack)"
git branch -M main
git remote add origin https://github.com/flymysql/dsh-remote.git
git push -u origin main
```

## 3. Publish to npm

```bash
npm publish    # needs a Granular Access Token with Bypass-2FA (npm 2026 policy)
```

## 4. Community submissions

Open issues in the awesome lists with this template (see the dsh-memory run: https://github.com/flymysql/dsh-memory):

```markdown
## dsh-remote

Remote-access assistant for DeepSeek Harness: the harness web GUI intentionally
binds loopback only (--host 0.0.0.0 is rejected for safety), so remote access is a
tunneling workflow. This plugin makes it copy-paste easy.

- **Repo**: https://github.com/flymysql/dsh-remote
- **npm**: https://www.npmjs.com/package/dsh-remote
- **Topic**: dsh-plugin
- **Category**: productivity / remote

### What it does
`/remote [user@host]` prints the exact commands: SSH local forward, autossh
keepalive, reverse tunnel (NAT-friendly), reverse-proxy with --trusted-host.
Settings → 远程访问 shows the live port, LAN IPs, trusted hosts and one-click
copy. Respects the official safety design — no 0.0.0.0 hack.

### Install
npm install dsh-remote, then add `{ id: dsh-remote, name: dsh-remote }` to cordis.yml.
```
