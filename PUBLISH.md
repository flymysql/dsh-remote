# Publish Guide — dsh-remote

Current product: a **remote-work assistant** for DeepSeek Harness (multi-machine
SSH, remote workspace picker, 22 `rw_*` tools, conflict-aware SFTP sync, port
forwarding, optional sidebar editor). This is **not** the early “print SSH
tunnel commands” plugin.

## 0. Automated release (preferred)

Push a tag whose name matches `package.json` (`vX.Y.Z`) and
`.github/workflows/release.yml` does the rest: full gates on a script-free
tree, `npm publish --provenance`, GitHub Release from the CHANGELOG section,
and a real install check of the published tarball.

One-time setup: repo secret `NPM_TOKEN` (Granular Access Token, Bypass-2FA,
publish on dsh-remote). The manual path below stays as the fallback and as the
documentation of what the pipeline does.

## 1. Version and changelog

Bump `package.json` `version`, add a section to `CHANGELOG.md`, keep
`README.md` (Chinese, the repository front page) and `README.en.md` (English)
in sync (tool list, config table, Desktop notes). `README.zh.md` is a redirect
stub kept only for old external links — do not put content in it.

## 2. Checks

```bash
for f in lib/*.js; do node --check "$f"; done
node check.mjs
npm test
# Proves the PREVIOUS release's updater can install this candidate completely
# (the #126 half-updated-tree class). Installs npm `latest` into a scratch dir
# and drives ITS updater against the packed candidate — run it BEFORE publish,
# while latest still names the version users would update FROM.
node scripts/verify-self-update.mjs
```

Optional: `scripts/boot-smoke.sh` if a desktop harness is installed.

## 3. Publish to npm

**0.8.47 起发布包带 `bundleDependencies`（ssh2 及其硬依赖闭包随 tarball 分发，
为绕开 pnpm 11 默认拦截依赖构建脚本导致的安装失败，issue #57）。**
bundled 依赖是从本地 `node_modules` 原样打进 tarball 的，所以发布前必须保证
本地依赖树是**没跑过 install 脚本**的干净状态，否则本机编出的 `.node` 原生
二进制会混进 tarball 分发给所有平台：

```bash
npm install --ignore-scripts   # 刷新依赖树但不构建任何原生产物
npm publish                    # Granular Access Token with Bypass-2FA (npm 2026 policy)
```

GitHub: tag `vX.Y.Z` and use the CHANGELOG section as the release notes — do not
retype it. Extract it mechanically so the Release and the CHANGELOG cannot drift:

```bash
node scripts/extract-release-notes.mjs 0.8.36 > /tmp/notes.md
gh release create v0.8.36 --title "0.8.36 — <short title>" --notes-file /tmp/notes.md
```

Then confirm all three places agree:

```bash
node scripts/check-releases.mjs      # tag <-> GitHub Release <-> npm tarball
```

**Do not treat a tarball 404 (or `npm view` failing) right after publishing as a
failure.** The registry packument can list the new version and move `latest`
while the CDN still 404s the tarball, which makes `npm install <pkg>@<ver>` report
`ETARGET: No matching version found`. Wait for the artifact, then verify for real:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/dsh-remote/-/dsh-remote-<ver>.tgz
npm install dsh-remote@<ver>   # in a scratch dir: the authoritative check
```

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
