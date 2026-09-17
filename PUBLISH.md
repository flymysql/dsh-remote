# Publish Guide — dsh-remote

Current product: a **remote-work assistant** for DeepSeek Harness (multi-machine
SSH, remote workspace picker, 20 `rw_*` tools, conflict-aware SFTP sync, port
forwarding, optional sidebar editor). This is **not** the early “print SSH
tunnel commands” plugin.

## 1. Version and changelog

Bump `package.json` `version`, add a section to `CHANGELOG.md`, keep
`README.md` / `README.zh.md` in sync (tool list, Desktop notes).

## 2. Checks

```bash
for f in lib/*.js; do node --check "$f"; done
node check.mjs
npm test
```

Optional: `scripts/boot-smoke.sh` if a desktop harness is installed.

## 3. Publish to npm

```bash
npm publish    # Granular Access Token with Bypass-2FA (npm 2026 policy)
```

GitHub: tag `vX.Y.Z` and paste the CHANGELOG section into the release notes.

## 4. Topics / discovery

Repo **About → Topics**:

```
dsh-plugin  deepseek-harness  remote  ssh  tunnel  plugin
```

README must reference `docs/cover.png` with a **relative** path so GitHub Topics
can show a card image.

## 5. Install blurb (awesome lists)

```markdown
## dsh-remote

Remote-work assistant for DeepSeek Harness: connect to SSH machines, pick a
remote workspace, and let the agent operate there (list/read/edit/exec/sync)
without exposing the harness on `0.0.0.0`.

- **Repo**: https://github.com/flymysql/dsh-remote
- **npm**: https://www.npmjs.com/package/dsh-remote
- **Install**: `dsh plugin add dsh-remote`
```
