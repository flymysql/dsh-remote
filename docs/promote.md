# Community listing kit

Maintainer reference, updated 2026-11-14. Stable release: [1.1.2](https://github.com/flymysql/dsh-remote/releases/tag/v1.1.2), also available on [npm](https://www.npmjs.com/package/dsh-remote).

## Project links

- Source: https://github.com/flymysql/dsh-remote
- Homepage: https://flymysql.github.io/dsh-remote/
- Install: `dsh plugin --profile web add dsh-remote`
- License: MIT
- Runtime evidence: [`package.json`](../package.json), [`cordis.patch.yml`](../cordis.patch.yml), [`lib/index.js`](../lib/index.js), [testing and scope](testing.md).
- Screenshot feed: [`screenshots.json`](../screenshots.json). Images live in this repository; the original promotional cover stays first, followed by the actual IDE and workflow screenshots.

## Short descriptions

English:

> SSH remote workspaces with an optional three-column IDE, highlighted editing, recursive search, terminals, Git diffs, and Agent tools for remote edits and builds.

中文：

> SSH 远程开发工作区，支持可选三栏 IDE、高亮编辑、递归搜索、远程终端、Git 差异及 Agent 远程编辑与构建。

GitHub About draft:

> Remote SSH development for DeepSeek Harness (DSH): optional three-column IDE, editable files with syntax highlighting, recursive search, SSH terminals, Git diffs, and session-bound Agent tools for editing and building on remote hosts.

Use the project homepage as the About website. Keep the existing `dsh-plugin`, `deepseek-harness`, `dsh`, SSH/SFTP and remote topics; describe the actual integration without relying on a tool count that can become stale.

## Compatibility and claims

- The IDE layout targets DSH Web. Native and PTC flows are tested on DSH 0.2.1-rc.5 and 0.2.2-rc.1; see the reference for older-host limitations.
- Each workspace binds its own SSH host and directory. Agent operations use remote tools; ordinary shell/Python filesystem IO remains local unless explicitly executed remotely or uploaded.
- Do not claim a remote language server, VS Code extension host, debugger, or complete VS Code Remote architecture.
- Automated tests and author verification are evidence, not a directory maintainer's endorsement or security certification.

## Maintain the correct source

| Directory | Source to edit |
|---|---|
| awesome-dsh-plugin/awesome-dsh-plugin | Only `data/plugins/flymysql__dsh-remote.yml`; the default-branch workflow generates READMEs. |
| 0xsline/awesome-deepseek-harness | English `README.md` and Chinese `README.zh-CN.md`. |
| beancookie/awesome-dsh-plugin | Chinese `README.md` and English `README.en.md`; do not edit generated `docs/` or metrics. |
| bruc3van/awesome-dsh-plugin | Bilingual hand-maintained README entries and `data/featured.json`; market/feed outputs are generated on main. |
| fendouai/awesome-deepseek-harness | `data/plugins.json`, then the upstream README/docs generators. |
| imsai-sh/awesome-deepseek-harness-plugins | Only `catalog/plugins/flymysql--dsh-remote.json`; the store and directories sync after merge. |
| dshworks/awesome-dsh-plugins | `data/plugins.json`, then upstream validation and rendering. |
| fjzzwxp/awesome-dsh-plugins | YAML entry, then regenerate both READMEs. |
| diegosouzapw/awesome-omni-dsh-plugins | One pinned YAML entry; keep source commit, exact npm version, integrity and evidence consistent. |
| Alex-Yanggg/awesome-DSH-plugin | Existing [PR #86](https://github.com/Alex-Yanggg/awesome-DSH-plugin/pull/86): update the same branch, bilingual catalog and generated Chinese mirror. |

For other directories, read their current contribution policy before preparing an entry. Check existing entries and open PRs first. Generated feeds and historical audit snapshots must not be rewritten as promotional copy. A prepared patch, open PR and merged listing are different states; record the actual upstream outcome.

The old `alexchenzl/dsh-plugin-directory` submission endpoint currently returns 404. Do not treat the historical submission as a confirmed current listing. `dsh-external/hub` is not publicly accessible; do not resubmit to an assumed replacement.
