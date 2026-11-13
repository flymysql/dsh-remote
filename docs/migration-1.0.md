# 1.0 工作区升级指南 / Upgrade guide

1.0 继续使用现有 SSH 主机、镜像目录和工作区记录，不需要重新创建远程项目。发布状态和安装版本以 [npm](https://www.npmjs.com/package/dsh-remote) 与 [Releases](https://github.com/flymysql/dsh-remote/releases) 为准；候选版不覆盖 `latest`。

## 升级前

- 保存正在编辑的文件。页面内未保存草稿不会抵御浏览器崩溃、强制退出或升级时重新加载客户端。
- 记录当前插件/DSH 版本与实际使用的 profile。备份你自己的 `$DSH_HOME/remote-workspaces` 配置；其中可能有敏感信息，请妥善存放。
- DSH 0.2.2 要求 Node.js ≥24.9。新界面主要针对 DSH Web 0.2.x；Desktop GUI 和旧宿主的能力范围见 README。

## 安装与升级

使用 DSH 的插件管理器或已有的插件更新入口。Web profile 示例：

```sh
dsh plugin --profile web add dsh-remote
```

本机全局 `npm install` 不会自动替你配置另一个 DSH profile。升级后如果仍显示旧界面，先保存工作再刷新客户端；需要时重启当前 DSH profile。不要为了修复界面删除远程项目或镜像目录。

## 行为变化

- 远程入口先帮助你查找最近项目和主机。取消打开会停止本次准备过程，不关闭其他会话共享连接。
- 文件与终端以宿主标签页打开，避免默认分栏挤窄内容；分屏与全屏仍由宿主控制。
- 命令结果区分成功、失败、停止、超时和后台执行。旧会话若没有可靠退出状态，显示“结果待确认”。
- 编译诊断可以打开远程文件行。再次打开同一文件会读取远端最新内容；若已有未保存草稿，保留草稿并检查冲突。
- 文件栏直接读写远端，本地镜像仍通过 `rw_sync` / `rw_push` 或显式启用 autoPush 更新。同步状态不代表持续一致。

## 出现问题时

先保存脱敏的错误、退出码、版本和复现步骤，查看 [troubleshooting](troubleshooting.md) 或 [SUPPORT](../SUPPORT.md)。需要回滚时，使用相同 profile 的插件管理器安装先前已知可用版本；不要删除 `$DSH_HOME`。本次发布门禁会实演旧更新器升级和候选更新器回滚，并检查完整文件树及引用。

## English

Existing hosts, mirrors and workspace records are retained. Save edits before updating: unsaved drafts are page-memory only. Use the plugin manager in the same profile; DSH 0.2.2 requires Node.js ≥24.9. Files and terminals now use native tabs, command cards show actual outcomes, compiler diagnostics navigate to remote source, and reopening a file revalidates agent changes while preserving conflicting drafts. Local mirrors remain distinct from direct remote file access. For rollback, reinstall a known-good version in the same profile without deleting DSH_HOME. Report redacted versions, steps and execution mode through [SUPPORT](../SUPPORT.md).
