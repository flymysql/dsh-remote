**English** · [中文](https://github.com/flymysql/dsh-remote/blob/main/README.md)

# dsh-remote

[![npm](https://img.shields.io/npm/v/dsh-remote)](https://www.npmjs.com/package/dsh-remote) [![MIT](https://img.shields.io/github/license/flymysql/dsh-remote)](https://github.com/flymysql/dsh-remote/blob/main/LICENSE)

Turn SSH hosts into everyday development workspaces in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): browse remote files, edit code, run terminals and let the agent work on the same remote project. Multiple workspaces can use different hosts in parallel.

**IDE mode: files on the left, editor in the center, native agent conversation on the right.** Resize columns or switch panes on narrow screens. Returning to the normal layout keeps tasks and unsaved edits.

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workbench-ide.png" alt="DSH remote IDE with file tree, native code editor and agent conversation" width="1200"/>

## Install

```bash
dsh plugin --profile web add dsh-remote
```

After installation or an upgrade, restart DSH Web and refresh the page. Check automatic-update status under Settings → Remote workspaces → Preferences.

## Start in 3 steps

1. **Configure a host**: open Settings → Remote workspaces to edit SSH configuration or save credentials. Connectivity checks run automatically; no manual connection step is required.
2. **Create a workspace**: Add workspace → Remote, then choose a host and folder. Each workspace binds its own host; settings have no folder selection or global active host.
3. **Develop remotely**: open workspace files or enter IDE mode to edit, search, run commands and collaborate with the agent.

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workspace-picker-browse.png" alt="Remote folder picker with fixed path and confirmation controls and a large directory list" width="720"/>

## Everyday development

### Search remote names and contents

Find files, directories or content recursively without expanding folders or syncing a mirror first. The default view keeps scope and progress compact; expand search options or scan details when needed. Case sensitivity, ignored directories, stop and retry remain available. Results reveal a directory or open the matching file line.

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workbench-search-results.png" alt="Compact remote recursive search results with a nested directory and file" width="675"/>

### Inspect remote Git changes

Switch between working-tree and staged diffs, filter files and jump from a changed line to source. The panel is read-only; it does not commit or change the index.

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workbench-git.png" alt="Remote Git working-tree and staged changes with file list and source diff" width="675"/>

### Run a remote terminal

The terminal starts in the session's remote directory. A pixel fish welcomes you before the real SSH shell; saved credentials can answer authentication automatically, and multiple terminals can run together.

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workbench-terminal.png" alt="Native remote terminal with pixel fish and actual SSH command output" width="1000"/>

### Edit and build with the agent

Tool cards show applied changes, actual exit codes and build output, with compiler diagnostics linking to source. Saving detects remote conflicts, preserves CRLF and protects newer input typed during the save.

<img src="https://raw.githubusercontent.com/flymysql/dsh-remote/main/docs/shots/workbench-applied-diff.png" alt="Applied remote agent edit with diff, file path and added/deleted line counts" width="485"/>

## Compatibility and limits

- Primarily targets **DSH Web 0.2.x**; 0.2.2 needs **Node.js ≥24.9**. See the [compatibility reference](https://github.com/flymysql/dsh-remote/blob/main/docs/reference.en.md#dsh-version-compatibility) for older-host fallbacks, Desktop/TUI and agent-diff differences.
- Files access the remote host directly; mirrors sync on demand. Drafts live in page memory and can be lost after a crash or forced exit.
- No remote language server, extension host or debugger. The agent runs commands as your configured SSH user; configure trusted hosts only.

## Documentation and community

[Full tool and configuration reference](https://github.com/flymysql/dsh-remote/blob/main/docs/reference.en.md) · [Troubleshooting](https://github.com/flymysql/dsh-remote/blob/main/docs/troubleshooting.md) · [Upgrade guide](https://github.com/flymysql/dsh-remote/blob/main/docs/migration-1.0.md) · [Changelog](https://github.com/flymysql/dsh-remote/blob/main/CHANGELOG.md)

[Homepage](https://flymysql.github.io/dsh-remote/) · [Discussions](https://github.com/flymysql/dsh-remote/discussions) · [Report an issue](https://github.com/flymysql/dsh-remote/issues) · [Contributing](https://github.com/flymysql/dsh-remote/blob/main/CONTRIBUTING.md) · [Contributors and credits](https://github.com/flymysql/dsh-remote/blob/main/docs/reference.en.md#contributing--credits)

Maintained by [@flymysql](https://github.com/flymysql) and the community · [MIT](https://github.com/flymysql/dsh-remote/blob/main/LICENSE)
