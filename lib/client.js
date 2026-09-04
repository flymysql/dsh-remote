// dsh-remote — client half.
// Settings → 远程工作区: a multi-machine SSH registry (add/edit/select current;
// passphrase / host-key mode / proxy jump / agent / keychain password; password
// stored host-side and kept private). Plus a port-forward panel, the command
// audit log view, quick workspace switching, and an ~/.ssh/config importer.
//
// A unified workspace directory picker fills ui-workspace's two directory-flow
// holes (sidebar + conversation hero):
//   • 本机 tab → opens the NATIVE OS folder chooser (ctx.workspaces.pickDirectory)
//     and returns the picked local path (works with local workspaces).
//   • 远程 tab → pick a machine (dropdown), list its directories over
//     /dsh-remote/ls, choose or type a remote path → /dsh-remote/mirror builds a
//     real LOCAL mirror → onPicked(localMirror) so host adopts it as a workspace.
//
// better-sidebar integration (optional): a live remote file explorer tab and a
// read-only-by-default remote file tab with an explicit「编辑 → 保存到远程」flow
// (mtime optimistic lock via POST /dsh-remote/write).
//
// Client entries must be classic scripts registered via window.__ModuleLoader__.load
// ({ id, factory }); the factory receives a synchronous `require`.
window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const name = 'dsh-remote'

    // ── i18n (issue #14) ────────────────────────────────────────────────────
    // Dictionaries are keyed by stable ids, zh + en share the same key set.
    // Lookup order: active locale → en fallback → the key itself (so a missing
    // translation stays visible instead of blanking the UI).
    const NS = 'dsh-remote'
    const L = {
      zh: {
        'settings.title': '远程工作区（dsh-remote）',
        'settings.intro': '维护多台 SSH 机器（密码/私钥/agent/跳板机/钥匙串）。路径在新建/选择工作区时选：「本机」走系统文件夹对话框；「远程」选一台机器在远程目录中选择。',
        'settings.machines': '已配置的机器',
        'settings.noMachines': '还没有机器。在下方添加。',
        'settings.current': '当前',
        'settings.edit': '编辑',
        'settings.delete': '删除',
        'settings.setCurrent': '设为当前',
        'settings.currentMachine': '当前远程机：{name}',
        'settings.clearCurrent': '取消设为当前（active remote = none）',
        'settings.noActive': '当前没有活动远程机：保存的机器只是备用连接，不会自动进入会话上下文（本地会话不受影响）。',
        'settings.addMachine': '添加机器',
        'settings.editMachine': '编辑机器',
        'settings.sshImport': '从 ~/.ssh/config 导入',
        'settings.sshCollapse': '收起',
        'settings.sshNoEntries': '~/.ssh/config 里没有可导入的 Host 条目',
        'settings.name': '名称',
        'settings.host': '主机',
        'settings.port': '端口',
        'settings.user': '用户',
        'settings.password': '密码',
        'settings.advCollapse': '▲ 收起高级配置',
        'settings.advExpand': '▼ 高级配置（私钥 / 跳板机 / agent 等）',
        'settings.privateKey': '私钥路径',
        'settings.passphrase': 'Passphrase',
        'settings.workspace': '默认工作区',
        'settings.hostKeyMode': 'HostKey 模式',
        'settings.hkDefault': '（默认 accept-new）',
        'settings.hkAccept': 'accept-new（信任首次，之后校验）',
        'settings.hkVerify': 'verify（严格：拒绝陌生主机）',
        'settings.hkOff': 'off（不校验，不推荐）',
        'settings.agent': 'SSH agent（SSH_AUTH_SOCK）',
        'settings.keyboardInteractive': 'keyboard-interactive（OTP/动态码）',
        'settings.encryptPassword': '加密保存密码（系统钥匙串）',
        'settings.proxyHost': '跳板机',
        'settings.proxyPortUser': '端口/用户',
        'settings.proxyKey': '跳板私钥',
        'settings.cancelEdit': '取消编辑',
        'settings.clear': '清空',
        'settings.testing': '连接中…',
        'settings.testOk': '✓ 连接成功',
        'settings.testConn': '测试连接',
        'settings.saving': '保存中…',
        'settings.save': '保存',
        'settings.recentWorkspaces': '当前机器最近工作区（一键切换）',
        'settings.switch': '切换',
        'settings.forwards': '端口转发（SSH 隧道）',
        'settings.fwdStop': '停止',
        'settings.fwdStart': '启动',
        'settings.fwdRemove': '删除',
        'settings.fwdDirLocal': '本地→远端',
        'settings.fwdDirReverse': '远端→本地',
        'settings.fwdListen': '监听端口',
        'settings.fwdTargetHost': '目标主机',
        'settings.fwdTargetPort': '目标端口',
        'settings.fwdAuto': '自动重连',
        'settings.fwdAdd': '添加转发',
        'settings.audit': '最近执行的远程命令（审计日志）',
        'settings.auditEmpty': '暂无记录（在远端执行的命令会记录到 $DSH_HOME/remote-workspaces/audit.log）',
        'settings.update': '更新',
        'settings.updateChecking': '版本信息加载中…',
        'settings.checking': '检查中…',
        'settings.checkUpdate': '检查更新',
        'settings.updateNow': '立即更新',
        'settings.updateMode': '更新模式：',
        'settings.updateManual': '手动',
        'settings.updateAuto': '自动',
        'settings.updateOff': '关闭',
        'settings.like': '觉得好用？',
        'settings.star': '⭐ 去 GitHub 点个 Star',
        'settings.feedback': '💬 反馈建议 / 提 issue',
        'settings.deleted': '已删除',
        'settings.saved': '已保存更新',
        'settings.added': '已添加 — 可设为当前',
        'settings.switched': '已切换为当前远程机',
        'settings.cleared': '已取消当前远程机 — 本地会话不再自动使用远程上下文',
        'settings.filledSsh': '已从 ~/.ssh/config 填入（仅引用私钥路径，不读取内容）',
        'settings.workspaceSwitched': '已切换到工作区 {path}',
        'settings.connOk': '连接成功',
        'settings.connOkWith': '连接成功（{user}@{host}，{latency}ms）{shell}',
        'settings.connFail': '连接失败',
        'settings.shellWin': '（Windows · Git Bash）',
        'settings.shellWinNoGit': '（Windows · 未找到 Git Bash）',
        'settings.shellPosix': '（POSIX）',
        'settings.updateFail': '检查更新失败',
        'settings.updateAvailable': '发现新版本 v{version}',
        'settings.updateLatest': '已是最新版本（v{version}）',
        'settings.updateConfirm': '将更新 dsh-remote 到 v{version}，替换本机插件文件。更新后需重启 Harness 生效。继续？',
        'settings.updateApplied': '✅ 已更新到 v{to}（{from} → {to}）。重启 Harness 生效。',
        'settings.updateFailed': '更新失败',
        'settings.updateFailedMsg': '更新失败: {msg}',
        'settings.registryUnreachable': '无法连接 npm registry',
        'settings.updateModeSet': '更新模式已设为「{mode}」',
        'settings.updateModeSaveFail': '模式保存失败: {msg}',
        'settings.deleteConfirm': '确定删除这台机器？',
        'settings.sshReadFail': '读取 ~/.ssh/config 失败: {msg}',
        'settings.delFail': '删除失败: {msg}',
        'settings.addFail': '保存失败: {msg}',
        'settings.modeAuto': '自动',
        'settings.modeOff': '关闭',
        'settings.modeManual': '手动',
        'picker.title': '选择工作目录',
        'picker.close': '关闭 ✕',
        'picker.tabLocal': '本机',
        'picker.tabRemote': '远程',
        'picker.localIntro': '弹出系统文件夹对话框选择；不可用时用内置目录浏览，也可直接输入本机目录。',
        'picker.localPlaceholder': '本机目录，如 C:\\Users\\you\\project',
        'picker.useLocalPath': '选用此本地路径',
        'picker.openSysPicker': '打开系统文件夹选择器',
        'picker.opening': '打开中…',
        'picker.remoteMachine': '远程机器:',
        'picker.chooseMachine': '— 选择机器 —',
        'picker.noMachines': '还没有机器，请先在设置里添加',
        'picker.recent': '最近:',
        'picker.pathPlaceholder': '输入远程路径（自动补全）',
        'picker.pathPlaceholderWin': '输入远程路径，如 C:\\Users\\…（自动补全）',
        'picker.chooseMachineFirst': '先选远程机器',
        'picker.browse': '浏览…',
        'picker.home': '~ 主目录',
        'picker.setRemoteWs': '设为远程工作区',
        'picker.mirroring': '镜像中…',
        'picker.cancel': '取消',
        'picker.selectDir': '选择工作目录',
        'picker.selected': '所选: {path}',
        'picker.driveRoot': '（驱动器根）',
        'picker.emptyDir': '（空目录）',
        'picker.loading': '加载中…',
        'picker.readingRoot': '正在读取根目录…',
        'picker.back': '回上一级 ▴',
        'picker.closeBtn': '关闭 ✕',
        'picker.newDir': '新建目录',
        'picker.newFolder': '新建文件夹',
        'picker.create': '新建',
        'picker.chooseThis': '选用此路径',
        'picker.enterDir': '进入 {name}',
        'picker.enterDrive': '进入驱动器 {name}',
        'picker.fileAt': '文件: {name}',
        'picker.cancelled': '已取消选择',
        'picker.noSysPicker': '无法打开系统文件夹选择器，可直接在输入框填本地路径',
        'picker.timeout': '目录选择已超时，请重试或直接在输入框填本地路径',
        'picker.pickerBinNotFound': '未找到目录选择器程序',
        'picker.noSysPickerHost': '当前系统不支持自动打开目录选择器，请在输入框直接填本地路径',
        'picker.noHomeWin': 'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径',
        'picker.typePath': ' — 可直接在输入框填本地路径',
        'picker.noHome': '无法解析主目录',
        'picker.newDirName': '新建目录名（在 {path} 下）',
        'picker.noSubdir': '（没有子目录 — 可直接选用当前目录）',
        'picker.truncated': '（条目过多已截断）',
        'picker.thisPc': '此电脑',
        'picker.chooseDrive': ' 选择驱动器',
        'picker.homeBtn': '🏠',
        'picker.goHome': '回家目录',
        'explorer.refresh': '刷新',
        'explorer.newDir': '新建目录',
        'explorer.more': '…',
        'explorer.remoteWs': '远程工作区: {path}{host}',
        'explorer.hostTag': '  ({user}@{host})',
        'explorer.noRemoteWs': '未设置远程工作区',
        'explorer.sessionLocal': '当前会话未使用远程工作区',
        'explorer.localSession': '当前会话是本地工作区，未使用远程文件。\n\n如需访问远程，可在设置页将某台机器「设为当前」，再用上方「…」选择远程工作区。',
        'explorer.loading': '加载中…',
        'explorer.dirMissing': '目录不存在或已被删除',
        'explorer.notConnected': '未连接远程主机（重启后需在设置中将机器「设为当前」，或刷新右侧列）',
        'explorer.softError': '⚠ {msg}（显示缓存，可点 ↻ 刷新）',
        'explorer.busy': '处理中… ',
        'explorer.menuExpand': '📂 展开/收起',
        'explorer.menuOpen': '📄 打开文件',
        'explorer.menuDownload': '⬇ 下载到本地镜像',
        'explorer.menuCopyRel': '📋 复制相对地址',
        'explorer.menuCopyAbs': '📋 复制绝对地址',
        'explorer.menuRename': '✏ 重命名',
        'explorer.menuDelete': '🗑 删除',
        'explorer.menuDeleteDir': '🗑 删除（含子目录）',
        'explorer.renamePrompt': '重命名为（新名字）',
        'explorer.deleteConfirm': '确认删除 {path}？',
        'explorer.copied': '已复制',
        'explorer.tabTitle': '远程文件',
        'file.readonly': '只读',
        'file.editing': '编辑中',
        'file.saveToRemote': '保存到远程',
        'file.saving': '保存中…',
        'file.cancel': '取消',
        'file.edit': '编辑',
        'file.download': '下载',
        'file.loading': '加载中…',
        'file.binary': '二进制文件 ({size}) — 请用「下载」或 rw_download / 本地镜像查看。',
        'file.unknownSize': '未知大小',
        'file.empty': '（空文件）',
        'file.truncated': '… 内容已截断（只读远程查看，完整文件请用 rw_read_file / 下载）',
        'file.conflict': '远端文件已变化，请重新读取',
        'file.downloaded': '已下载到本地镜像{local}',
        'file.downloadedAt': ': {path}',
        'file.readFail': '远程读取失败: {msg}',
        'file.listFail': '远程目录读取失败: {msg}',
        'common.refresh': '刷新',
        'common.close': '关闭',
        'common.confirm': '确认',
      },
      en: {
        'settings.title': 'Remote workspace (dsh-remote)',
        'settings.intro': 'Manage multiple SSH machines (password / private key / agent / proxy jump / keychain). Pick a path when creating/selecting a workspace: "Local" opens the system folder dialog; "Remote" picks a machine and a directory on it.',
        'settings.machines': 'Configured machines',
        'settings.noMachines': 'No machines yet. Add one below.',
        'settings.current': 'current',
        'settings.edit': 'Edit',
        'settings.delete': 'Delete',
        'settings.setCurrent': 'Set as current',
        'settings.currentMachine': 'Current remote: {name}',
        'settings.clearCurrent': 'Clear current (active remote = none)',
        'settings.noActive': 'No active remote machine: saved machines are standby connections and never enter a session context automatically (local sessions are unaffected).',
        'settings.addMachine': 'Add machine',
        'settings.editMachine': 'Edit machine',
        'settings.sshImport': 'Import from ~/.ssh/config',
        'settings.sshCollapse': 'Collapse',
        'settings.sshNoEntries': 'No importable Host entries in ~/.ssh/config',
        'settings.name': 'Name',
        'settings.host': 'Host',
        'settings.port': 'Port',
        'settings.user': 'User',
        'settings.password': 'Password',
        'settings.advCollapse': '▲ Collapse advanced config',
        'settings.advExpand': '▼ Advanced (private key / proxy jump / agent, etc.)',
        'settings.privateKey': 'Private key path',
        'settings.passphrase': 'Passphrase',
        'settings.workspace': 'Default workspace',
        'settings.hostKeyMode': 'HostKey mode',
        'settings.hkDefault': '（default accept-new）',
        'settings.hkAccept': 'accept-new (trust first, verify later)',
        'settings.hkVerify': 'verify (strict: reject unknown hosts)',
        'settings.hkOff': 'off (no verification, not recommended)',
        'settings.agent': 'SSH agent (SSH_AUTH_SOCK)',
        'settings.keyboardInteractive': 'keyboard-interactive (OTP / dynamic code)',
        'settings.encryptPassword': 'Encrypt saved password (system keychain)',
        'settings.proxyHost': 'Proxy jump host',
        'settings.proxyPortUser': 'Port / user',
        'settings.proxyKey': 'Proxy jump private key',
        'settings.cancelEdit': 'Cancel edit',
        'settings.clear': 'Clear',
        'settings.testing': 'Connecting…',
        'settings.testOk': '✓ Connected',
        'settings.testConn': 'Test connection',
        'settings.saving': 'Saving…',
        'settings.save': 'Save',
        'settings.recentWorkspaces': 'Recent workspaces of the current machine (one-click switch)',
        'settings.switch': 'Switch',
        'settings.forwards': 'Port forwarding (SSH tunnels)',
        'settings.fwdStop': 'Stop',
        'settings.fwdStart': 'Start',
        'settings.fwdRemove': 'Remove',
        'settings.fwdDirLocal': 'Local → remote',
        'settings.fwdDirReverse': 'Remote → local',
        'settings.fwdListen': 'Listen port',
        'settings.fwdTargetHost': 'Target host',
        'settings.fwdTargetPort': 'Target port',
        'settings.fwdAuto': 'Auto reconnect',
        'settings.fwdAdd': 'Add forward',
        'settings.audit': 'Recent remote commands (audit log)',
        'settings.auditEmpty': 'No records yet (commands run remotely are logged to $DSH_HOME/remote-workspaces/audit.log)',
        'settings.update': 'Update',
        'settings.updateChecking': 'Loading version info…',
        'settings.checking': 'Checking…',
        'settings.checkUpdate': 'Check for updates',
        'settings.updateNow': 'Update now',
        'settings.updateMode': 'Update mode:',
        'settings.updateManual': 'Manual',
        'settings.updateAuto': 'Auto',
        'settings.updateOff': 'Off',
        'settings.like': 'Like it?',
        'settings.star': '⭐ Star on GitHub',
        'settings.feedback': '💬 Feedback / report issue',
        'settings.deleted': 'Deleted',
        'settings.saved': 'Saved',
        'settings.added': 'Added — you can set it as current',
        'settings.switched': 'Switched to current remote machine',
        'settings.cleared': 'Cleared current remote — local sessions no longer use remote context automatically',
        'settings.filledSsh': 'Filled from ~/.ssh/config (only references the private key path, never reads its content)',
        'settings.workspaceSwitched': 'Switched to workspace {path}',
        'settings.connOk': 'Connection successful',
        'settings.connOkWith': 'Connection successful ({user}@{host}, {latency}ms){shell}',
        'settings.connFail': 'Connection failed',
        'settings.shellWin': ' (Windows · Git Bash)',
        'settings.shellWinNoGit': ' (Windows · no Git Bash found)',
        'settings.shellPosix': ' (POSIX)',
        'settings.updateFail': 'Failed to check for updates',
        'settings.updateAvailable': 'New version found: v{version}',
        'settings.updateLatest': 'Already up to date (v{version})',
        'settings.updateConfirm': 'Update dsh-remote to v{version}? This replaces the local plugin files and requires a Harness restart to take effect. Continue?',
        'settings.updateApplied': '✅ Updated to v{to} ({from} → {to}). Restart Harness to apply.',
        'settings.updateFailed': 'Update failed',
        'settings.updateFailedMsg': 'Update failed: {msg}',
        'settings.registryUnreachable': 'Cannot reach the npm registry',
        'settings.updateModeSet': 'Update mode set to "{mode}"',
        'settings.updateModeSaveFail': 'Failed to save mode: {msg}',
        'settings.deleteConfirm': 'Delete this machine?',
        'settings.sshReadFail': 'Failed to read ~/.ssh/config: {msg}',
        'settings.delFail': 'Delete failed: {msg}',
        'settings.addFail': 'Save failed: {msg}',
        'settings.modeAuto': 'Auto',
        'settings.modeOff': 'Off',
        'settings.modeManual': 'Manual',
        'picker.title': 'Select working directory',
        'picker.close': 'Close ✕',
        'picker.tabLocal': 'Local',
        'picker.tabRemote': 'Remote',
        'picker.localIntro': 'Opens the system folder dialog; when unavailable, uses the built-in directory browser. You can also type a local path directly.',
        'picker.localPlaceholder': 'Local directory, e.g. C:\\Users\\you\\project',
        'picker.useLocalPath': 'Use this local path',
        'picker.openSysPicker': 'Open system folder picker',
        'picker.opening': 'Opening…',
        'picker.remoteMachine': 'Remote machine:',
        'picker.chooseMachine': '— choose a machine —',
        'picker.noMachines': 'No machines yet — add one in Settings first',
        'picker.recent': 'Recent:',
        'picker.pathPlaceholder': 'Enter remote path (auto-complete)',
        'picker.pathPlaceholderWin': 'Enter remote path, e.g. C:\\Users\\… (auto-complete)',
        'picker.chooseMachineFirst': 'Choose a remote machine first',
        'picker.browse': 'Browse…',
        'picker.home': '~ Home',
        'picker.setRemoteWs': 'Set as remote workspace',
        'picker.mirroring': 'Mirroring…',
        'picker.cancel': 'Cancel',
        'picker.selectDir': 'Select working directory',
        'picker.selected': 'Selected: {path}',
        'picker.driveRoot': ' (drive root)',
        'picker.emptyDir': ' (empty directory)',
        'picker.loading': 'Loading…',
        'picker.readingRoot': 'Reading root directory…',
        'picker.back': 'Back ▴',
        'picker.closeBtn': 'Close ✕',
        'picker.newDir': 'New directory',
        'picker.newFolder': 'New folder',
        'picker.create': 'Create',
        'picker.chooseThis': 'Use this path',
        'picker.enterDir': 'Enter {name}',
        'picker.enterDrive': 'Enter drive {name}',
        'picker.fileAt': 'File: {name}',
        'picker.cancelled': 'Selection cancelled',
        'picker.noSysPicker': 'Cannot open the system folder picker — you can type a local path in the input box',
        'picker.timeout': 'Directory selection timed out — retry or type a local path directly',
        'picker.pickerBinNotFound': 'Directory picker program not found',
        'picker.noSysPickerHost': 'This system cannot auto-open a directory picker — type a local path in the input box',
        'picker.noHomeWin': 'Windows remotes do not support ~ resolution — enter an absolute path',
        'picker.typePath': ' — type a local path in the input box instead',
        'picker.noHome': 'Cannot resolve home directory',
        'picker.newDirName': 'New directory name (under {path})',
        'picker.noSubdir': ' (no subdirectories — you can use the current directory)',
        'picker.truncated': ' (too many entries, truncated)',
        'picker.thisPc': 'This PC',
        'picker.chooseDrive': ' choose a drive',
        'picker.homeBtn': '🏠',
        'picker.goHome': 'Go to home',
        'explorer.refresh': 'Refresh',
        'explorer.newDir': 'New directory',
        'explorer.more': '…',
        'explorer.remoteWs': 'Remote workspace: {path}{host}',
        'explorer.hostTag': '  ({user}@{host})',
        'explorer.noRemoteWs': 'No remote workspace set',
        'explorer.sessionLocal': 'This session does not use a remote workspace',
        'explorer.localSession': 'This session is a local workspace and does not use remote files.\n\nTo access remote, set a machine as "current" in Settings, then pick a remote workspace with the "…" button above.',
        'explorer.loading': 'Loading…',
        'explorer.dirMissing': 'Directory does not exist or was deleted',
        'explorer.notConnected': 'Not connected to the remote host (after a restart, set a machine as "current" in Settings, or refresh the right column)',
        'explorer.softError': '⚠ {msg} (showing cache, click ↻ to refresh)',
        'explorer.busy': 'Processing… ',
        'explorer.menuExpand': '📂 Expand/collapse',
        'explorer.menuOpen': '📄 Open file',
        'explorer.menuDownload': '⬇ Download to local mirror',
        'explorer.menuCopyRel': '📋 Copy relative path',
        'explorer.menuCopyAbs': '📋 Copy absolute path',
        'explorer.menuRename': '✏ Rename',
        'explorer.menuDelete': '🗑 Delete',
        'explorer.menuDeleteDir': '🗑 Delete (with contents)',
        'explorer.renamePrompt': 'Rename to (new name)',
        'explorer.deleteConfirm': 'Delete {path}?',
        'explorer.copied': 'Copied',
        'explorer.tabTitle': 'Remote Files',
        'file.readonly': 'read-only',
        'file.editing': 'editing',
        'file.saveToRemote': 'Save to remote',
        'file.saving': 'Saving…',
        'file.cancel': 'Cancel',
        'file.edit': 'Edit',
        'file.download': 'Download',
        'file.loading': 'Loading…',
        'file.binary': 'Binary file ({size}) — use "Download", rw_download or the local mirror to view.',
        'file.unknownSize': 'unknown size',
        'file.empty': ' (empty file)',
        'file.truncated': '… content truncated (read-only remote view; use rw_read_file / Download for the full file)',
        'file.conflict': 'The remote file changed, please re-read it',
        'file.downloaded': 'Downloaded to local mirror{local}',
        'file.downloadedAt': ': {path}',
        'file.readFail': 'Failed to read remote: {msg}',
        'file.listFail': 'Failed to list remote directory: {msg}',
        'common.refresh': 'Refresh',
        'common.close': 'Close',
        'common.confirm': 'Confirm',
      },
    }

    // Active dictionary: resolved from the DSH locale service when available
    // (its active locale + en fallback), else from the browser language, else en.
    let ACTIVE_LANG = 'en'
    try {
      const nav = (typeof navigator !== 'undefined' && navigator.languages) ? navigator.languages : (typeof navigator !== 'undefined' ? [navigator.language] : [])
      for (const tag of nav) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh') { ACTIVE_LANG = 'zh'; break }
        if (primary === 'en') { ACTIVE_LANG = 'en'; break }
      }
    } catch { /* keep en */ }

    // The DSH locale service binds a translate thunk; we call it first and fall
    // back to our own dictionary so missing keys never blank the UI.
    function makeTr() {
      const dict = L[ACTIVE_LANG] || L.en
      return (key, params) => {
        let text = dict[key]
        if (text === undefined && ACTIVE_LANG !== 'en') text = L.en[key]
        if (text === undefined) text = key
        if (params) text = String(text).replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m))
        return text
      }
    }
    let tr = makeTr()
    // Called from apply() once the real locale service is reachable; registers
    // both dictionaries and rebinds tr so live locale switches take effect.
    function wireLocale(ctx) {
      try {
        const locale = ctx && ctx.get && ctx.get('locale')
        if (!locale || typeof locale.register !== 'function') return
        const dispose = locale.register(NS, { zh: L.zh, en: L.en })
        const bound = locale.bind(NS)
        tr = (key, params) => {
          let text = bound(key, params)
          if (text === key) {
            const d = L[ACTIVE_LANG] || L.en
            text = d[key] !== undefined ? d[key] : L.en[key]
            if (text === undefined) text = key
            if (params) text = String(text).replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m))
          }
          return text
        }
        if (ctx.effect) ctx.effect(() => dispose, 'dsh-remote.locale')
      } catch (e) { /* keep local dict fallback */ }
    }

    // Known host-side error messages (lib/index.js) are Chinese. Map them to
    // dictionary keys so non-zh locales see localized errors instead of raw
    // zh text. Unknown / server-generated messages pass through untouched.
    const HOST_ERROR_KEYS = {
      '目录选择已超时，请重试或直接在输入框填本地路径': 'picker.timeout',
      '无法打开系统文件夹选择器': 'picker.noSysPicker',
      '当前系统不支持自动打开目录选择器，请在输入框直接填本地路径': 'picker.noSysPickerHost',
      'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径': 'picker.noHomeWin',
      '无法连接 npm registry': 'settings.registryUnreachable',
    }
    const HOST_ERROR_PREFIX = [
      ['未找到目录选择器程序', 'picker.pickerBinNotFound'],
    ]
    const HOST_ERROR_SUFFIX = [
      [' — 可直接在输入框填本地路径', 'picker.typePath'],
    ]
    function trHostError(msg) {
      if (!msg || ACTIVE_LANG === 'zh') return msg
      if (HOST_ERROR_KEYS[msg]) return tr(HOST_ERROR_KEYS[msg])
      for (const [prefix, key] of HOST_ERROR_PREFIX) {
        if (msg.startsWith(prefix)) {
          const en = L.en[key]
          if (en !== undefined) return en + msg.slice(prefix.length)
        }
      }
      for (const [suffix, key] of HOST_ERROR_SUFFIX) {
        if (msg.endsWith(suffix)) {
          const en = L.en[key]
          if (en !== undefined) return msg.slice(0, -suffix.length) + en
        }
      }
      return msg
    }

    async function api(method, path, body) {
      const opts = { method, headers: {} }
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(path, opts)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(trHostError((data && (data.error || data.message))) || 'HTTP ' + res.status)
      return data
    }

    // Like api() but returns {status, data} so callers can handle 409 etc.
    async function apiRaw(method, path, body) {
      const opts = { method, headers: {} }
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(path, opts)
      const data = await res.json().catch(() => ({}))
      if (data && typeof data.error === 'string') data.error = trHostError(data.error)
      if (data && typeof data.message === 'string') data.message = trHostError(data.message)
      return { status: res.status, data }
    }

    // Theme via DSH design tokens so this follows the harness light/dark theme.
    const v = (name, fb) => `var(${name}, ${fb})`
    const T = {
      bg: v('--dsw-alias-bg-layer-1', 'rgba(128,128,128,0.07)'),
      bg2: v('--dsw-alias-interactive-bg-hover', 'rgba(128,128,128,0.10)'),
      border: v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
      borderStrong: v('--dsw-alias-border-l3', 'rgba(128,128,128,0.5)'),
      danger: v('--dsw-static-red-500', '#e06c75'),
      dangerText: v('--dsw-static-red-400', '#e06c75'),
      ok: v('--dsw-static-green-500', '#4caf7d'),
      warn: v('--dsw-static-yellow-500', '#e6c07b'),
      radius: 8,
      muted: v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.7)'),
      label: v('--dsw-alias-label-primary', '#e4e4e7'),
      primary: v('--dsw-alias-button-primary-fill', '#2563eb'),
      onPrimary: v('--dsw-alias-button-contrast-fill', '#fff'),
      hoverBg: v('--dsw-alias-interactive-bg-hover', 'rgba(128,128,128,0.14)'),
    }
    const inputS = { flex: 1, padding: '6px 10px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, outline: 'none' }
    const buttonS = { padding: '6px 12px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, cursor: 'pointer' }
    const primaryBtnS = { padding: '6px 12px', borderRadius: T.radius, border: 'none', background: T.primary, color: T.onPrimary, cursor: 'pointer', fontWeight: 600 }
    const box = { border: '1px solid ' + T.border, borderRadius: T.radius, background: T.bg, padding: 10 }
    const boxS = box

    function humanSize(n) {
      if (n == null) return ''
      if (n < 1024) return n + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let i = -1
      let v = n
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
      return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i]
    }
    function fmtTime(ts) {
      if (!ts) return ''
      const d = new Date(ts * 1000)
      const pad = (x) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    // Write text to the clipboard. Prefers the async Clipboard API (works on
    // http://127.0.0.1 secure contexts) and falls back to the legacy
    // execCommand('copy') path, mirroring primitives' writeClipboard semantics.
    function copyToClipboard(text) {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => false)
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = String(text)
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        return Promise.resolve(ok)
      } catch (e) {
        return Promise.resolve(false)
      }
    }

    let WORKSPACES = null // ctx.get('workspaces'), set in apply()
    let SESSIONS = null // ctx.get('sessions'), set in apply()

    // ── Settings → 远程工作区 (machine registry + forwards + audit) ──────────
    function RemoteWorkspacePage() {
      const [machines, setMachines] = React.useState([])
      const [currentId, setCurrentId] = React.useState('')
      const [form, setForm] = React.useState({
        name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '',
        passphrase: '', workspace: '', hostKeyMode: '', useAgent: false, keyboardInteractive: false,
        encryptPassword: false, proxyHost: '', proxyPort: '22', proxyUser: '', proxyPassword: '', proxyKey: '', id: '',
      })
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')
      const [tst, setTst] = React.useState('') // idle | testing | ok | failing
      const [forwards, setForwards] = React.useState([])
      const [fwdForm, setFwdForm] = React.useState({ listenPort: '', targetHost: '127.0.0.1', targetPort: '', direction: 'local', autoStart: false })
      const [auditLines, setAuditLines] = React.useState([])
      const [sshEntries, setSshEntries] = React.useState(null)
      const [workspaces, setWorkspaces] = React.useState([])
      const [advOpen, setAdvOpen] = React.useState(false) // 高级配置折叠

      const testConn = () => {
        if (!form.host.trim() || tst === 'testing') return
        setTst('testing'); setErr(''); setMsg('')
        api('POST', '/dsh-remote/test-connect', {
          host: form.host, port: Number(form.port) || 22, username: form.username || 'root',
          password: form.password, privateKeyPath: form.privateKeyPath, passphrase: form.passphrase,
          proxy: form.proxyHost ? { host: form.proxyHost, port: Number(form.proxyPort) || 22, username: form.proxyUser || '', password: form.proxyPassword || '', privateKeyPath: form.proxyKey || '' } : undefined,
        })
          .then((r) => {
            if (r && r.ok) {
              const shellTag = r.platform === 'windows' ? (r.gitBash ? tr('settings.shellWin') : tr('settings.shellWinNoGit')) : (r.platform === 'posix' ? tr('settings.shellPosix') : '')
              setTst('ok'); setMsg(r.latencyMs != null ? tr('settings.connOkWith', { user: r.user, host: r.host, latency: r.latencyMs, shell: shellTag }) : tr('settings.connOk')); refresh()
            }
            else { setTst('failing'); setErr((r && r.error) || tr('settings.connFail')) }
          })
          .catch((e) => { setTst('failing'); setErr(String((e && e.message) || e)) })
      }

      const refresh = () => api('GET', '/dsh-remote/machines').then((r) => {
        setMachines(r.machines || []); setCurrentId(r.currentId || '')
        const cur = (r.machines || []).find((m) => m.id === r.currentId)
        setWorkspaces((cur && cur.recentWorkspaces) || [])
      })
      React.useEffect(() => { refresh() }, [])

      // ── update state ────────────────────────────────────────────────────────
      const [upd, setUpd] = React.useState(null) // { current, latest, updateAvailable, updateMode, updatedMarker }
      const [updBusy, setUpdBusy] = React.useState(false)
      const [updMsg, setUpdMsg] = React.useState('')
      const [updMode, setUpdMode] = React.useState('manual')
      const checkUpdate = (quiet) => {
        if (updBusy) return
        setUpdBusy(true); setUpdMsg('')
        api('GET', '/dsh-remote/update-check')
          .then((r) => {
            if (!r || !r.ok) { setUpdMsg((r && r.error) || tr('settings.updateFail')); return }
            setUpd(r)
            if (r.updateMode) setUpdMode(r.updateMode)
            if (!quiet) setUpdMsg(r.updateAvailable ? tr('settings.updateAvailable', { version: r.latest }) : tr('settings.updateLatest', { version: r.current }))
          })
          .catch((e) => setUpdMsg(String((e && e.message) || e)))
          .finally(() => setUpdBusy(false))
      }
      const applyUpdateNow = () => {
        if (!upd || !upd.latest) return
        if (!window.confirm(tr('settings.updateConfirm', { version: upd.latest }))) return
        setUpdBusy(true); setUpdMsg('')
        api('POST', '/dsh-remote/update-apply', { version: upd.latest })
          .then((r) => {
            if (r && r.ok) setUpdMsg(tr('settings.updateApplied', { to: r.to, from: (r.from || '') }))
            else setUpdMsg((r && r.error) || tr('settings.updateFailed'))
            checkUpdate(true)
          })
          .catch((e) => setUpdMsg(tr('settings.updateFailedMsg', { msg: String((e && e.message) || e) })))
          .finally(() => setUpdBusy(false))
      }
      const saveUpdateMode = (mode) => {
        setUpdMode(mode); setUpdMsg(tr('settings.updateModeSet', { mode: mode === 'auto' ? tr('settings.modeAuto') : mode === 'off' ? tr('settings.modeOff') : tr('settings.modeManual') }))
        api('POST', '/dsh-remote/update-mode', { mode }).catch((e) => setUpdMsg(tr('settings.updateModeSaveFail', { msg: String((e && e.message) || e) })))
      }
      React.useEffect(() => { checkUpdate(true) }, [])

      const refreshForwards = () => api('GET', '/dsh-remote/forwards').then((r) => setForwards(r.forwards || [])).catch(() => {})
      React.useEffect(() => { refreshForwards(); api('GET', '/dsh-remote/audit?limit=30').then((r) => setAuditLines(r.lines || [])).catch(() => {}) }, [])

      const setF = (k) => (ev) => setForm({ ...form, [k]: ev.target.value })
      const setFb = (k) => (ev) => setForm({ ...form, [k]: ev.target.checked })
      const startEdit = (m) => {
        setForm({
          name: m.name, host: m.host, port: String(m.port || 22), username: m.username || 'root',
          password: '', privateKeyPath: m.privateKeyPath || '', passphrase: '', workspace: m.workspace || '',
          hostKeyMode: m.hostKeyMode || '', useAgent: !!m.useAgent, keyboardInteractive: !!m.keyboardInteractive,
          encryptPassword: !!(m.credentialBackend && m.credentialBackend !== 'plain'),
          proxyHost: (m.proxy && m.proxy.host) || '', proxyPort: String((m.proxy && m.proxy.port) || 22),
          proxyUser: (m.proxy && m.proxy.username) || '', proxyPassword: '', proxyKey: (m.proxy && m.proxy.privateKeyPath) || '',
          id: m.id,
        })
        // 编辑时若该机器用了高级配置(私钥/agent/跳板/钥匙串等),自动展开折叠区
        if (m.privateKeyPath || m.useAgent || m.keyboardInteractive || m.workspace || (m.proxy && m.proxy.host) || (m.credentialBackend && m.credentialBackend !== 'plain')) {
          setAdvOpen(true)
        }
      }
      const clearForm = () => setForm({ name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '', passphrase: '', workspace: '', hostKeyMode: '', useAgent: false, keyboardInteractive: false, encryptPassword: false, proxyHost: '', proxyPort: '22', proxyUser: '', proxyPassword: '', proxyKey: '', id: '' })
      const save = (action) => {
        setBusy(true); setErr(''); setMsg('')
        if (action === 'delete') {
          api('POST', '/dsh-remote/machines', { action: 'delete', id: form.id }).then(refresh).then(() => { clearForm(); setMsg(tr('settings.deleted')) }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false))
          return
        }
        api('POST', '/dsh-remote/machines', {
          action: form.id ? 'update' : 'add', id: form.id || undefined, name: form.name, host: form.host, port: Number(form.port) || 22,
          username: form.username, password: form.password, privateKeyPath: form.privateKeyPath, passphrase: form.passphrase,
          workspace: form.workspace, hostKeyMode: form.hostKeyMode, useAgent: form.useAgent, keyboardInteractive: form.keyboardInteractive,
          encryptPassword: form.encryptPassword,
          proxy: form.proxyHost ? { host: form.proxyHost, port: Number(form.proxyPort) || 22, username: form.proxyUser || '', password: form.proxyPassword || '', privateKeyPath: form.proxyKey || '' } : undefined,
        }).then((r) => { refresh(); clearForm(); setMsg(form.id ? tr('settings.saved') : tr('settings.added')) }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false))
      }
      const useNow = (id) => { setBusy(true); api('POST', '/dsh-remote/current', { id }).then((r) => { setCurrentId(r.currentId); setMsg(tr('settings.switched')) }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false)) }
      // Issue #13: "active remote = none" — saved machines stay, but no machine
      // is current, so local sessions are never dragged into a remote context.
      const clearCurrent = () => { setBusy(true); api('POST', '/dsh-remote/current', { id: '' }).then((r) => { setCurrentId(''); setMsg(tr('settings.cleared')) }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false)) }
      const del = (id) => { if (window.confirm(tr('settings.deleteConfirm'))) { api('POST', '/dsh-remote/machines', { action: 'delete', id }).then(refresh).then(() => setMsg(tr('settings.deleted'))).catch((e) => setErr(String((e && e.message) || e))) } }

      const importSsh = () => {
        api('GET', '/dsh-remote/ssh-config').then((r) => setSshEntries(r && r.present ? (r.entries || []) : []))
          .catch((e) => setErr(tr('settings.sshReadFail', { msg: String((e && e.message) || e) })))
      }
      const applySshEntry = (e) => {
        setForm({ ...form,
          name: e.host, host: e.hostName || e.host, port: String(e.port || 22),
          username: e.user || 'root', privateKeyPath: e.identityFile || '',
        })
        setSshEntries(null)
        setMsg(tr('settings.filledSsh'))
      }

      const setWorkspaceNow = (p) => {
        api('POST', '/dsh-remote/workspace', { path: p })
          .then(() => setMsg(tr('settings.workspaceSwitched', { path: p })))
          .catch((e) => setErr(String((e && e.message) || e)))
      }

      // ── forwards panel ────────────────────────────────────────────────────
      const fwdAction = (action, id) => {
        api('POST', '/dsh-remote/forwards', { action, id })
          .then((r) => { setForwards(r.forwards || []); setErr(''); setMsg('') })
          .catch((e) => setErr(String((e && e.message) || e)))
      }
      const fwdDefine = () => {
        if (!fwdForm.listenPort) return
        api('POST', '/dsh-remote/forwards', { action: 'define', listenPort: Number(fwdForm.listenPort), targetHost: fwdForm.targetHost || '127.0.0.1', targetPort: Number(fwdForm.targetPort) || Number(fwdForm.listenPort), direction: fwdForm.direction, autoStart: fwdForm.autoStart })
          .then((r) => { setForwards(r.forwards || []); setFwdForm({ listenPort: '', targetHost: '127.0.0.1', targetPort: '', direction: 'local', autoStart: false }) })
          .catch((e) => setErr(String((e && e.message) || e)))
      }

      const row = (label, ctrl, k) => React.createElement('div', { key: k, style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 } },
        React.createElement('label', { style: { width: 84, fontSize: 12, opacity: 0.8, flexShrink: 0 } }, label), ctrl)

      return React.createElement('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 860 } },
        React.createElement('div', { style: { fontSize: 15, fontWeight: 600 } }, tr('settings.title')),
        React.createElement('div', { style: { fontSize: 12, opacity: 0.8 } },
          tr('settings.intro')),
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, tr('settings.machines')),
          machines.length
            ? machines.map((m) => React.createElement('div', { key: m.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid ' + T.border } },
                React.createElement('div', { style: { flex: 1, fontSize: 13 } },
                  m.name + '  ',
                  React.createElement('code', { style: { fontSize: 12, opacity: 0.8 } }, m.username + '@' + m.host + ':' + m.port),
                  m.passwordSet ? ' 🔒' : '',
                  (m.credentialBackend && m.credentialBackend !== 'plain') ? ' 🗝' : '',
                  m.proxy && m.proxy.host ? ' ⛳' : '',
                  m.latencyMs != null ? React.createElement('span', { style: { fontSize: 11, opacity: 0.6 } }, ` · ${m.latencyMs}ms`) : null,
                  m.id === currentId ? React.createElement('span', { style: { color: T.ok, fontSize: 12 } }, ' · ' + tr('settings.current')) : null),
                React.createElement('button', { style: buttonS, onClick: () => startEdit(m) }, tr('settings.edit')),
                React.createElement('button', { style: buttonS, onClick: () => del(m.id) }, tr('settings.delete')),
                React.createElement('button', { style: { ...buttonS, padding: '6px 10px', whiteSpace: 'nowrap' }, onClick: () => useNow(m.id), disabled: m.id === currentId }, tr('settings.setCurrent'))))
            : React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, tr('settings.noMachines')),
          currentId
            ? React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', paddingTop: 6, fontSize: 12, color: T.ok } },
                tr('settings.currentMachine', { name: ((machines.find((m) => m.id === currentId) || {}).name || currentId) }),
                React.createElement('button', { style: { ...buttonS, padding: '2px 8px', fontSize: 12, marginLeft: 'auto' }, onClick: clearCurrent }, tr('settings.clearCurrent')))
            : React.createElement('div', { style: { paddingTop: 6, fontSize: 12, opacity: 0.6 } }, tr('settings.noActive')),
          ),
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
            React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, form.id ? tr('settings.editMachine') : tr('settings.addMachine')),
            React.createElement('button', { style: { ...buttonS, fontSize: 12, padding: '3px 8px' }, onClick: () => (sshEntries ? setSshEntries(null) : importSsh()) }, sshEntries ? tr('settings.sshCollapse') : tr('settings.sshImport'))),
          sshEntries ? React.createElement('div', { style: { marginBottom: 8, maxHeight: 160, overflowY: 'auto', border: '1px solid ' + T.border, borderRadius: T.radius } },
            sshEntries.length ? sshEntries.map((e) => React.createElement('div', { key: e.host, onClick: () => applySshEntry(e), style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12, borderBottom: '1px solid ' + T.border } },
              e.host + '  →  ' + (e.hostName || '?') + (e.user ? '  (' + e.user + ')' : '') + (e.identityFile ? '  [key]' : '') + (e.proxyJump ? '  ⛳' : '')))
              : React.createElement('div', { style: { padding: 8, fontSize: 12, opacity: 0.6 } }, tr('settings.sshNoEntries')))
          : null,
          row(tr('settings.name'), React.createElement('input', { value: form.name, onChange: setF('name'), placeholder: tr('settings.name') + ' (e.g. build-server)', style: inputS }), 'n'),
          row(tr('settings.host'), React.createElement('input', { value: form.host, onChange: setF('host'), placeholder: 'IP or hostname', style: inputS }), 'h'),
          row(tr('settings.port'), React.createElement('input', { value: form.port, onChange: setF('port'), placeholder: '22', style: { ...inputS, width: 70 } }), 'p'),
          row(tr('settings.user'), React.createElement('input', { value: form.username, onChange: setF('username'), placeholder: 'root', style: inputS }), 'u'),
          row(tr('settings.password'), React.createElement('input', { type: 'password', value: form.password, onChange: setF('password'), placeholder: 'SSH password (hidden)', style: inputS }), 'w'),
          // 高级配置折叠开关
          React.createElement('button', {
            type: 'button',
            onClick: () => setAdvOpen(!advOpen),
            style: { ...buttonS, width: '100%', marginBottom: advOpen ? 10 : 0, color: advOpen ? T.primary : 'inherit', fontWeight: advOpen ? 600 : 400, borderStyle: 'dashed' },
          }, advOpen ? tr('settings.advCollapse') : tr('settings.advExpand')),
          advOpen ? React.createElement('div', { key: 'adv', style: { paddingTop: 2 } },
            row(tr('settings.privateKey'), React.createElement('input', { value: form.privateKeyPath, onChange: setF('privateKeyPath'), placeholder: 'Empty = password or agent', style: inputS }), 'k'),
            row(tr('settings.passphrase'), React.createElement('input', { type: 'password', value: form.passphrase, onChange: setF('passphrase'), placeholder: 'Encrypted private key passphrase', style: inputS }), 'pp'),
            row(tr('settings.workspace'), React.createElement('input', { value: form.workspace, onChange: setF('workspace'), placeholder: 'Optional: default remote dir for this machine', style: inputS }), 'ws'),
            row(tr('settings.hostKeyMode'), React.createElement('select', { value: form.hostKeyMode, onChange: setF('hostKeyMode'), style: { ...inputS, maxWidth: 220 } },
              React.createElement('option', { value: '' }, tr('settings.hkDefault')),
              React.createElement('option', { value: 'accept-new' }, tr('settings.hkAccept')),
              React.createElement('option', { value: 'verify' }, tr('settings.hkVerify')),
              React.createElement('option', { value: 'off' }, tr('settings.hkOff'))), 'hkm'),
            React.createElement('div', { style: { display: 'flex', gap: 16, paddingLeft: 90, flexWrap: 'wrap', marginBottom: 8 } },
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: form.useAgent, onChange: setFb('useAgent') }), tr('settings.agent')),
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: form.keyboardInteractive, onChange: setFb('keyboardInteractive') }), tr('settings.keyboardInteractive')),
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: form.encryptPassword, onChange: setFb('encryptPassword') }), tr('settings.encryptPassword'))),
            row(tr('settings.proxyHost'), React.createElement('input', { value: form.proxyHost, onChange: setF('proxyHost'), placeholder: 'Route through this host (optional)', style: inputS }), 'ph'),
            row(tr('settings.proxyPortUser'), React.createElement('div', { style: { display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' } },
              React.createElement('input', { value: form.proxyPort, onChange: setF('proxyPort'), placeholder: 'Port (22)', style: { ...inputS, minWidth: 90, maxWidth: 120 } }),
              React.createElement('input', { value: form.proxyUser, onChange: setF('proxyUser'), placeholder: 'Jump user', style: { ...inputS, minWidth: 140 } }),
              React.createElement('input', { type: 'password', value: form.proxyPassword, onChange: setF('proxyPassword'), placeholder: 'Jump password', style: { ...inputS, minWidth: 140 } })), 'pu'),
            row(tr('settings.proxyKey'), React.createElement('input', { value: form.proxyKey, onChange: setF('proxyKey'), placeholder: 'Jump private key path (optional)', style: inputS }), 'pk'),
          ) : null,
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', marginTop: 4 } },
            msg ? React.createElement('span', { style: { color: T.ok, fontSize: 12, marginRight: 'auto' } }, msg) : null,
            form.id ? React.createElement('button', { style: buttonS, onClick: () => save('delete') }, tr('settings.delete')) : null,
            React.createElement('button', { style: buttonS, onClick: () => { clearForm(); setErr(''); setTst('idle'); setAdvOpen(false) } }, form.id ? tr('settings.cancelEdit') : tr('settings.clear')),
            React.createElement('button', { style: { ...buttonS, fontFamily: 'monospace', whiteSpace: 'nowrap' }, onClick: testConn, disabled: busy || !form.host.trim() || tst === 'testing' },
              tst === 'testing' ? tr('settings.testing') : tst === 'ok' ? tr('settings.testOk') : tr('settings.testConn')),
            React.createElement('button', { style: { ...buttonS, fontWeight: 700 }, onClick: () => save(form.id ? 'update' : 'add'), disabled: busy || !form.host.trim() }, busy ? tr('settings.saving') : tr('settings.save')),
          ),
        ),
        // 快捷切换工作区（该机器的最近工作区）
        workspaces.length ? React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, tr('settings.recentWorkspaces')),
          workspaces.map((w, i) => React.createElement('div', { key: w + i, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' } },
            React.createElement('code', { style: { flex: 1, fontSize: 12, fontFamily: 'monospace' } }, w),
            React.createElement('button', { style: { ...buttonS, padding: '2px 10px' }, onClick: () => setWorkspaceNow(w) }, tr('settings.switch'))))) : null,
        // 端口转发面板
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, tr('settings.forwards')),
          forwards.length ? forwards.map((f) => React.createElement('div', { key: f.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 12, fontFamily: 'monospace' } },
            React.createElement('span', { style: { color: f.active ? T.ok : T.muted } }, f.active ? '●' : '○'),
            React.createElement('span', { style: { flex: 1 } }, `${f.direction} 127.0.0.1:${f.listenPort} → ${f.targetHost}:${f.targetPort}${f.autoStart ? ' [auto]' : ''}`),
            f.active
              ? React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: () => fwdAction('stop', f.id) }, tr('settings.fwdStop'))
              : React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: () => fwdAction('start', f.id) }, tr('settings.fwdStart')),
            React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: () => fwdAction('remove', f.id) }, tr('settings.fwdRemove')))) : null,
          React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
            React.createElement('select', { value: fwdForm.direction, onChange: (e) => setFwdForm({ ...fwdForm, direction: e.target.value }), style: { ...inputS, maxWidth: 110 } },
              React.createElement('option', { value: 'local' }, tr('settings.fwdDirLocal')),
              React.createElement('option', { value: 'reverse' }, tr('settings.fwdDirReverse'))),
            React.createElement('input', { value: fwdForm.listenPort, onChange: (e) => setFwdForm({ ...fwdForm, listenPort: e.target.value }), placeholder: tr('settings.fwdListen'), style: { ...inputS, maxWidth: 90 } }),
            React.createElement('input', { value: fwdForm.targetHost, onChange: (e) => setFwdForm({ ...fwdForm, targetHost: e.target.value }), placeholder: tr('settings.fwdTargetHost'), style: { ...inputS, maxWidth: 120 } }),
            React.createElement('input', { value: fwdForm.targetPort, onChange: (e) => setFwdForm({ ...fwdForm, targetPort: e.target.value }), placeholder: tr('settings.fwdTargetPort'), style: { ...inputS, maxWidth: 90 } }),
            React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
              React.createElement('input', { type: 'checkbox', checked: fwdForm.autoStart, onChange: (e) => setFwdForm({ ...fwdForm, autoStart: e.target.checked }) }), tr('settings.fwdAuto')),
            React.createElement('button', { style: { ...buttonS, fontWeight: 700 }, onClick: fwdDefine, disabled: !fwdForm.listenPort }, tr('settings.fwdAdd'))),
        ),
        // 审计日志
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, tr('settings.audit')),
          auditLines.length
            ? React.createElement('div', { style: { maxHeight: 180, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6 } },
                auditLines.map((l, i) => React.createElement('div', { key: i, style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, l)))
            : React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, tr('settings.auditEmpty')),
        ),
        err ? React.createElement('div', { style: { color: T.danger, fontSize: 13 } }, err) : null,
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, tr('settings.update')),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 } },
            upd
              ? React.createElement('span', { style: { opacity: 0.85 } },
                  'v' + upd.current,
                  upd.updateAvailable ? React.createElement('b', { style: { color: T.ok, marginLeft: 6 } }, '→ v' + upd.latest) : null)
              : React.createElement('span', { style: { opacity: 0.6 } }, tr('settings.updateChecking')),
            React.createElement('button', { style: { ...buttonS, padding: '2px 10px' }, onClick: () => checkUpdate(false), disabled: updBusy }, updBusy ? tr('settings.checking') : tr('settings.checkUpdate')),
            upd && upd.updateAvailable
              ? React.createElement('button', { style: { ...buttonS, padding: '2px 10px', fontWeight: 700, color: T.ok }, onClick: applyUpdateNow, disabled: updBusy }, tr('settings.updateNow'))
              : null,
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 12 } },
            React.createElement('span', { style: { opacity: 0.8 } }, tr('settings.updateMode')),
            ['manual', 'auto', 'off'].map((m) =>
              React.createElement('button', {
                key: m, style: { ...buttonS, padding: '2px 10px', fontWeight: updMode === m ? 700 : 400, color: updMode === m ? T.ok : 'inherit' },
                onClick: () => saveUpdateMode(m), disabled: updBusy,
              }, m === 'manual' ? tr('settings.modeManual') : m === 'auto' ? tr('settings.modeAuto') : tr('settings.modeOff')),
            ),
          ),
          updMsg ? React.createElement('div', { style: { marginTop: 6, fontSize: 12, color: updMsg.startsWith('✅') ? T.ok : 'inherit', opacity: 0.9 } }, updMsg) : null,
        ),
        React.createElement('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, opacity: 0.65, borderTop: '1px solid ' + T.border, paddingTop: 10, marginTop: 4 } },
          React.createElement('span', {}, tr('settings.like')),
          React.createElement('a', { href: 'https://github.com/flymysql/dsh-remote', target: '_blank', rel: 'noopener noreferrer', style: { color: 'inherit' } }, tr('settings.star')),
          React.createElement('span', {}, '·'),
          React.createElement('a', { href: 'https://github.com/flymysql/dsh-remote/issues/new', target: '_blank', rel: 'noopener noreferrer', style: { color: 'inherit' } }, tr('settings.feedback')),
          React.createElement('span', { style: { marginLeft: 'auto', opacity: 0.5 } }, 'dsh-remote v' + (upd && upd.current ? upd.current : '?.?.?')),
        ),
      )
    }

    // ── Unified picker (fill the directory-flow holes) ───────────────────
    function parseLs(text) {
      const out = []
      for (const ln of String(text || '').split('\n')) {
        const t = ln.trim()
        if (!t || !t.length || /^total\b/i.test(t)) continue
        const parts = t.split(/\s+/).filter(Boolean)
        if (parts.length < 8) continue
        const mode = parts[0]
        const name = parts.slice(8).join(' ')
        if (!name || name === '.' || name === '..') continue
        const isDir = mode.charAt(0) === 'd'
        out.push({ name, dir: isDir })
      }
      return out
    }

    // Clickable breadcrumb of the current remote path. Windows remotes show a
    // "This PC" root and `\` separators (此电脑 / C:\ / Users / dev); POSIX `/`.
    function breadcrumb(active, cur, win, jumpTo) {
      const raw = String(cur || '')
      const isWinPath = win && (raw === '' || /^[a-zA-Z]:/.test(raw))
      const rootLabel = isWinPath ? tr('picker.thisPc') : '/'
      const crumbs = []
      const rootStyle = { cursor: active ? 'pointer' : 'default', color: active ? T.ok : T.muted, whiteSpace: 'nowrap' }
      crumbs.push(React.createElement('span', { key: 'root', style: rootStyle, onClick: active ? () => jumpTo('') : undefined }, rootLabel))
      if (isWinPath && raw !== '') {
        const driveM = raw.match(/^([a-zA-Z]):(.*)$/)
        const drive = driveM[1].toUpperCase() + ':\\'
        crumbs.push(React.createElement('span', { key: 'sep0', style: { color: T.muted } }, '\\'))
        crumbs.push(React.createElement('span', { key: 'drive', style: { cursor: active ? 'pointer' : 'default', color: active ? T.label : T.muted, fontWeight: raw === drive ? 700 : 400, whiteSpace: 'nowrap' }, onClick: active ? () => jumpTo(drive) : undefined }, drive))
        let acc = drive
        for (const s of (driveM[2] || '').split('\\')) {
          if (!s) continue
          acc += s + '\\'
          const target = acc.slice(0, -1)
          crumbs.push(React.createElement('span', { key: 's|' + target, style: { color: T.muted } }, '\\'))
          crumbs.push(React.createElement('span', { key: target, style: { cursor: active ? 'pointer' : 'default', color: active ? T.label : T.muted, fontWeight: target === raw ? 700 : 400, whiteSpace: 'nowrap' }, onClick: active ? () => jumpTo(target) : undefined }, s))
        }
      } else if (!isWinPath && raw !== '' && raw !== '/') {
        const segs = raw.replace(/\/+$/, '').split('/')
        let acc = ''
        for (const s of segs) {
          if (!s) continue
          acc += '/' + s
          crumbs.push(React.createElement('span', { key: s + '|' + acc, style: { color: T.muted } }, '/'))
          crumbs.push(React.createElement('span', { key: acc, style: { cursor: active ? 'pointer' : 'default', color: active ? T.label : T.muted, fontWeight: acc === raw ? 700 : 400, whiteSpace: 'nowrap' }, onClick: active ? () => jumpTo(acc) : undefined }, s))
        }
      }
      if (crumbs.length === 1) crumbs.push(React.createElement('span', { key: 'empty', style: { color: T.muted } }, isWinPath ? tr('picker.chooseDrive') : ''))
      return React.createElement('span', { key: 'crumb', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '100%' } }, crumbs)
    }

    function DirPicker(props) {
      const { open, busy, onPicked, onCancel } = props
      const [tab, setTab] = React.useState('local')
      const [machines, setMachines] = React.useState([])
      const [machineId, setMachineId] = React.useState('')
      const [path, setPath] = React.useState('')
      const [items, setItems] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [levels, setLevels] = React.useState(null)
      const [popOpen, setPopOpen] = React.useState(false)
      const [suggest, setSuggest] = React.useState([])
      const [suggestOpen, setSuggestOpen] = React.useState(false)
      const [recent, setRecent] = React.useState([])
      const [win, setWin] = React.useState(false) // remote platform: windows = Git-Bash host
      // 本机浏览浮层（browse 后端）：{ path, home, crumbs, entries, truncated }。
      const [localPop, setLocalPop] = React.useState(null)
      const [newDirName, setNewDirName] = React.useState('')
      const suggestTimer = React.useRef(null)
      const suggestRef = React.useRef(null)
      React.useEffect(() => {
        if (!suggestOpen) return
        const onDown = (ev) => { if (suggestRef.current && !suggestRef.current.contains(ev.target)) setSuggestOpen(false) }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [suggestOpen])
      const [mOpen, setMOpen] = React.useState(false)
      const ddRef = React.useRef(null)
      React.useEffect(() => {
        if (!mOpen) return
        const onDown = (ev) => { if (ddRef.current && !ddRef.current.contains(ev.target)) setMOpen(false) }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [mOpen])

      const sortItems = (list) => {
        const dirs = list.filter((it) => it.dir)
        const files = list.filter((it) => !it.dir)
        dirs.sort((a, b) => a.name.localeCompare(b.name))
        files.sort((a, b) => a.name.localeCompare(b.name))
        return dirs.concat(files)
      }

      // Client-side full-path fallback: when the server did not attach a `path`
      // (older host half), join base + name with the base's own separator.
      const joinDisplay = (base, name) => {
        const b = String(base || '')
        const n = String(name || '')
        if (!b || b === '/') return '/' + n
        const sep = /^[a-zA-Z]:/.test(b) || b.includes('\\') ? '\\' : '/'
        return b.replace(/[\\/]+$/, '') + sep + n
      }

      const loadLevels = (id, p, toIndex) => {
        if (!id) return
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/current', { id }).catch(() => {})
        .then(() => api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(p || '')))
        .then((res) => {
          setWin(res && res.platform === 'windows')
          const real = res && res.path ? res.path : (p || '')
          // Server returns [{ type, name, size, mtime, path }] where `path` is
          // the FULL display-form path (C:\Users\dev on Windows) — the client
          // never joins paths itself, so drives and Windows paths just work.
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir', size: it.size, mtime: it.mtime, path: it.path || joinDisplay(real, it.name), drive: !!it.drive }))
            : parseLs(res && res.text)
          const node = { path: real, dirs: sortItems(list.filter((it) => it.dir)), all: sortItems(list) }
          setLevels((prev) => {
            const base = prev && prev.length ? prev.slice() : []
            let idx = typeof toIndex === 'number' && toIndex >= 0 ? toIndex : base.length
            if (idx >= base.length) return base.concat([node])
            base[idx] = node
            return base.slice(0, idx + 1)
          })
        })
        .catch((e) => setErr(String((e && e.message) || e)))
        .finally(() => setLoading(false))
      }

      React.useEffect(() => { if (open) {
        // Bug fix: the picker must NOT reopen with the previous selection's
        // path — reset the path bar (and the browse state) on every open.
        setPath(''); setLevels(null); setWin(false)
        setLocalPop(null); setNewDirName('')
        api('GET', '/dsh-remote/machines').then((r) => {
          setMachines(r.machines || [])
          const cur = (r.machines || []).find((m) => m.id === r.currentId)
          setRecent((cur && cur.recentWorkspaces) || [])
          setMachineId(r.currentId || (r.machines && r.machines[0] && r.machines[0].id) || '')
        })
      } }, [open])

      // 本机目录浏览（browse 后端兜底）：列出 path 的子目录；path 为空 → 宿主家目录。
      const loadLocal = (p) => {
        setLoading(true); setErr('')
        api('GET', '/dsh-remote/local-list' + (p ? '?path=' + encodeURIComponent(p) : ''))
          .then((r) => setLocalPop({ path: (r && r.path) || p || '', home: (r && r.home) || '', crumbs: (r && r.crumbs) || [], entries: (r && r.entries) || [], truncated: !!(r && r.truncated), drives: (r && r.drives) || [] }))
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setLoading(false))
      }

      const chooseLocal = () => {
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/local-pick')
          .then((r) => {
            if (r && r.path) { setLoading(false); onPicked(String(r.path)) }
            // browse 后端（DSH Desktop / 无显示的远程宿主）：没有 OS 对话框可开
            // → 打开内置本机目录浏览器。
            else if (r && r.kind === 'browse') loadLocal('')
            else if (r && r.cancelled) { setLoading(false); setErr(tr('picker.cancelled')) }
            else { setLoading(false); setErr((r && r.error) || tr('picker.noSysPicker')) }
          })
          .catch((e) => { setLoading(false); setErr(String((e && e.message) || e) + tr('picker.typePath')) })
      }

      // 在浮层当前目录下新建文件夹（browse 后端 createDirectory），成功后刷新列表。
      const mkdirLocal = () => {
        const cur = localPop
        const name = newDirName.trim()
        if (!cur || !cur.path || !name || loading) return
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/local-mkdir', { path: cur.path, name })
          .then(() => { setNewDirName(''); loadLocal(cur.path) })
          .catch((e) => { setErr(String((e && e.message) || e)); setLoading(false) })
      }

      // 选用浮层中的本机目录：回填输入框（不直接提交），复核后再点「选用此本地路径」。
      const acceptLocalPick = (p) => {
        setPath(String(p || ''))
        setErr('')
        setLocalPop(null)
      }

      const switchTab = (t) => {
        setTab(t); setErr('')
        // each tab keeps its own path — never leak the other tab's selection
        setPath('')
        if (t === 'remote') {
          // Windows remotes show a "This PC" drive view at the root; POSIX shows
          // the filesystem root. Either way loadLevels('') lists that root.
          if (machineId) loadLevels(machineId, '', 0)
        }
      }

      // Parent path of a display-form remote path (client-side, both separators).
      const parentOf = (p) => {
        const t = String(p || '')
        if (!t || t === '/') return null
        const win = /^[a-zA-Z]:/.test(t)
        if (win && /^[a-zA-Z]:\\?$/.test(t)) return null // drive root: no parent
        const sep = win ? '\\' : '/'
        const idx = t.lastIndexOf(sep)
        if (idx <= 0) return null
        const par = t.slice(0, idx)
        if (win && /^[a-zA-Z]:$/.test(par)) return par + '\\'
        return par || '/'
      }

      // enterDir(it): drive into the given entry — `it.path` is the FULL
      // display-form path from the server (drives C:\, Windows and POSIX alike).
      const enterDir = (it) => {
        if (busy || loading || !it || !it.dir) return
        loadLevels(machineId, it.path, (levels ? levels.length : 0))
      }

      // Navigate one level up in the browse popup. When the current level was
      // opened directly at a deep path (levels.length === 1 — e.g. the popup
      // was opened at the path bar's value) the parent is loaded as the new top
      // level instead of being disabled.
      const goUp = () => {
        if (loading) return
        const last = levels && levels.length ? levels[levels.length - 1] : null
        if (!last) return
        if (levels.length > 1) { setLevels((p) => p.slice(0, p.length - 1)); return }
        const par = parentOf(last.path)
        if (par) loadLevels(machineId, par, 1)
      }

      const loadSuggestions = (raw, mid) => {
        const id = mid || machineId
        if (!id || !raw) { setSuggest([]); setSuggestOpen(false); return }
        const t = String(raw || '').trim()
        if (!t) { setSuggest([]); setSuggestOpen(false); return }
        // Separator-aware split: `\` when the input looks like a Windows path.
        const backslash = t.includes('\\') || /^[a-zA-Z]:/.test(t)
        const sep = backslash ? '\\' : '/'
        const idx = t.lastIndexOf(sep)
        let parent, lastSeg
        if (idx < 0) { parent = backslash ? t + '\\' : '/'; lastSeg = backslash ? '' : t }
        else if (idx === t.length - 1) { parent = t.slice(0, idx) || '/'; lastSeg = '' }
        else { parent = t.slice(0, idx) || '/'; lastSeg = t.slice(idx + 1) }
        api('POST', '/dsh-remote/current', { id }).catch(() => {})
        .then(() => api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(parent || '/')))
        .then((res) => {
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir', path: it.path || joinDisplay(parent, it.name) }))
            : []
          const matches = list
            .filter((it) => it.dir && (!lastSeg || it.name.toLowerCase().startsWith(String(lastSeg).toLowerCase())))
            .slice(0, 40).map((it) => it.path)
          setSuggest(matches)
          setSuggestOpen(!!matches.length)
        }).catch(() => { setSuggest([]); setSuggestOpen(false) })
      }

      const onPathChange = (raw) => {
        setPath(raw); setErr('')
        if (suggestTimer.current) clearTimeout(suggestTimer.current)
        suggestTimer.current = setTimeout(() => loadSuggestions(raw), 220)
      }

      const continueSuggest = (dir) => {
        if (!machineId || !dir) { setSuggest([]); setSuggestOpen(false); return }
        setSuggestOpen(false)
        api('POST', '/dsh-remote/current', { id: machineId }).catch(() => {})
        .then(() => api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(String(dir).replace(/[\\/]+$/, '') || '/')))
        .then((res) => {
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir', path: it.path || joinDisplay(dir, it.name) }))
            : []
          const kids = list.slice(0, 40).map((it) => it.path)
          setSuggest(kids)
          setSuggestOpen(!!kids.length)
        }).catch(() => { setSuggest([]); setSuggestOpen(false) })
      }

      const selectSuggestion = (s) => {
        if (!s) { setSuggestOpen(false); return }
        // Auto-append the trailing separator so the path reads as a directory
        // and the user can keep typing the next segment right away.
        const sep = String(s).includes('\\') ? '\\' : '/'
        const withSep = String(s).replace(/[\\/]+$/, '') + sep
        setPath(withSep); setErr(''); setSuggestOpen(false)
        continueSuggest(withSep)
      }

      const commitPath = (p) => {
        const target = String(p || '').trim()
        if (!target || !machineId || busy) return
        setPopOpen(false); setSuggestOpen(false)
        api('POST', '/dsh-remote/mirror', { path: target }).then((res) => (res && res.localMirror ? onPicked(res.localMirror) : setErr((res && res.error) || ''))).catch((e) => setErr(String((e && e.message) || e)))
      }

      const acceptBrowserPick = (p) => {
        setPath(String(p || ''))
        setSuggestOpen(false)
        setPopOpen(false)
      }

      const pickHome = () => {
        api('POST', '/dsh-remote/home').then((r) => {
          if (r && r.home) { setPath(r.home); setErr(''); loadSuggestions(r.home) }
          else setErr((r && (r.hint || r.error)) || tr('picker.noHome'))
        }).catch((e) => setErr(String((e && e.message) || e)))
      }

      const mkdirHere = () => {
        const last = levels && levels.length ? levels[levels.length - 1] : null
        const base = (last && last.path) || '/'
        const nm = window.prompt(tr('picker.newDirName', { path: base }))
        if (!nm || !nm.trim()) return
        const sep = base.includes('\\') ? '\\' : '/'
        const full = base === '/' ? '/' + nm.trim() : base + sep + nm.trim()
        api('POST', '/dsh-remote/fs', { op: 'mkdir', path: full })
          .then(() => { setErr(''); loadLevels(machineId, base, (levels ? levels.length - 1 : 0)) })
          .catch((e) => setErr(String((e && e.message) || e)))
      }

      // 本机浏览浮层的面包屑：browse 后端给出完整祖先链（含盘符根），可点击跳转。
      const localCrumbs = (cur) => {
        const crumbs = (cur && cur.crumbs) || []
        if (!crumbs.length) return React.createElement('span', null, '/')
        const out = []
        crumbs.forEach((c, i) => {
          if (i > 0) out.push(React.createElement('span', { key: 'sep' + i, style: { color: T.muted } }, ' › '))
          out.push(React.createElement('span', {
            key: c.path || i,
            title: c.path,
            onClick: () => loadLocal(c.path),
            style: { cursor: 'pointer', color: i === crumbs.length - 1 ? T.label : T.ok, fontWeight: i === crumbs.length - 1 ? 700 : 400 },
          }, c.name))
        })
        return React.createElement('span', null, out)
      }

      // 本机目录浏览浮层（browse 后端）：进入子目录 / 面包屑跳转 / 回家目录 /
      // 新建文件夹 / 选用回填。与远程浏览弹层同一套交互。
      function renderLocalPopup() {
        const cur = localPop
        if (!cur) return null
        const crumbs = cur.crumbs || []
        const parent = crumbs.length >= 2 ? crumbs[crumbs.length - 2].path : null
        return React.createElement('div', {
          style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 },
          onClick: () => setLocalPop(null),
        },
          React.createElement('div', { style: { background: v('--dsw-alias-bg-overlay', '#1e1e1e'), border: '1px solid ' + T.borderStrong, borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,0.5)', width: 'min(560px, 94vw)', minWidth: 320, display: 'flex', flexDirection: 'column', maxHeight: 'min(460px, 84vh)', overflow: 'hidden' }, onClick: (e) => e.stopPropagation() },
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid ' + T.border } },
              React.createElement('button', { style: { ...buttonS, padding: '3px 10px' }, onClick: () => parent && loadLocal(parent), disabled: !parent || loading, title: parent || '' }, tr('picker.back')),
              cur.home ? React.createElement('button', { style: { ...buttonS, padding: '3px 8px' }, onClick: () => loadLocal(cur.home), disabled: loading, title: tr('picker.goHome') }, tr('picker.homeBtn')) : null,
              React.createElement('div', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, localCrumbs(cur)),
              React.createElement('button', { style: { ...buttonS, padding: '3px 10px' }, onClick: () => setLocalPop(null) }, tr('picker.closeBtn')),
            ),
            // 盘符切换行（Windows 无统一根目录，browse 面包屑到不了其他盘）。
            (cur.drives && cur.drives.length > 1) ? React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', padding: '6px 12px', borderBottom: '1px solid ' + T.border } },
              cur.drives.map((d) => {
                const active = String(cur.path).toUpperCase().startsWith(String(d.name).toUpperCase())
                return React.createElement('button', {
                  key: d.path,
                  onClick: () => loadLocal(d.path),
                  disabled: loading,
                  title: d.path,
                  style: { ...buttonS, padding: '2px 8px', fontSize: 11, fontFamily: 'monospace', fontWeight: active ? 700 : 400, color: active ? T.ok : T.label },
                }, d.name)
              }),
            ) : null,
            React.createElement('div', { style: { overflowY: 'auto', overflowX: 'hidden' } },
              loading ? React.createElement('div', { style: { opacity: 0.7, padding: 12 } }, tr('picker.loading'))
                : (cur.entries.length ? cur.entries.slice(0, 400).map((it, i) => React.createElement('div', {
                    key: it.path || i, title: tr('picker.enterDir', { name: it.name }),
                    onClick: () => loadLocal(it.path),
                    style: { padding: '7px 12px', cursor: 'pointer', color: T.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid ' + T.border },
                  },
                    React.createElement('span', null, '📁'),
                    React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.name),
                  )) : React.createElement('div', { style: { opacity: 0.6, padding: 12 } }, tr('picker.noSubdir'))),
              cur.truncated ? React.createElement('div', { style: { opacity: 0.6, padding: '6px 12px', fontSize: 11 } }, tr('picker.truncated')) : null,
            ),
            err ? React.createElement('div', { style: { color: T.danger, fontSize: 12, padding: '4px 12px' } }, err) : null,
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderTop: '1px solid ' + T.border } },
              React.createElement('input', { value: newDirName, onChange: (e) => setNewDirName(e.target.value), placeholder: tr('picker.newFolder'), style: { ...inputS, width: 110, flex: '0 0 auto', padding: '4px 8px', fontSize: 12 } }),
              React.createElement('button', { style: { ...buttonS, padding: '4px 10px', whiteSpace: 'nowrap' }, onClick: mkdirLocal, disabled: loading || !newDirName.trim() || !cur.path }, tr('picker.create')),
              React.createElement('span', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, tr('picker.selected', { path: cur.path })),
              React.createElement('button', { style: { ...buttonS, fontWeight: 600, whiteSpace: 'nowrap' }, onClick: () => acceptLocalPick(cur.path) }, tr('picker.chooseThis')),
            ),
          ),
        )
      }

      function renderDirPopup() {
        if (!levels || !levels.length) {
          return React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, (loading ? tr('picker.loading') : tr('picker.readingRoot')))
        }
        const last = levels[levels.length - 1]
        const entries = last.all || []
        return React.createElement('div', { style: { border: '1px solid ' + T.borderStrong, borderRadius: 10, background: v('--dsw-alias-bg-overlay', '#1e1e1e'), boxShadow: '0 8px 32px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', maxHeight: 'min(300px, 46vh)', overflow: 'hidden' } },
          React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid ' + T.border } },
            React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: goUp, disabled: loading || (levels.length <= 1 && !parentOf(last.path)) }, tr('picker.back')),
            React.createElement('div', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, breadcrumb(!!machineId, last.path, win, (p) => setLevels((prev) => { const cut = (prev || []).findIndex((lv) => lv.path === p); return cut >= 0 ? prev.slice(0, cut + 1) : prev }))),
            React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: mkdirHere }, tr('picker.newDir')),
            React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: () => setPopOpen(false) }, tr('picker.closeBtn')),
          ),
          React.createElement('div', { style: { overflowY: 'auto', overflowX: 'hidden' } },
            loading ? React.createElement('div', { style: { opacity: 0.7, padding: 12 } }, tr('picker.loading'))
              : (entries.length ? entries.slice(0, 400).map((it, i) => React.createElement('div', {
                  key: i, title: it.drive ? tr('picker.enterDrive', { name: it.name }) : (it.dir ? tr('picker.enterDir', { name: it.name }) : tr('picker.fileAt', { name: it.name })),
                  onClick: it.dir ? () => enterDir(it) : undefined,
                  style: { padding: '6px 10px', cursor: it.dir ? 'pointer' : 'default', color: T.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid ' + T.border },
                },
                  React.createElement('span', { style: { flexShrink: 0, display: 'inline-flex', color: T.label, fontSize: 13 } }, it.drive ? '💽' : (it.dir
                    ? React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor' }, React.createElement('path', { d: 'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2a1.5 1.5 0 0 1 1.06.44L8.5 3.7h4.5A1.5 1.5 0 0 1 14.5 5.2V12A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5Zm2.5 1a.5.5 0 0 0 0 1h1.2a.5.5 0 0 0 0-1H4Z' }))
                    : React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', opacity: 0.85 }, React.createElement('path', { d: 'M3.5 1.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5.2a1 1 0 0 0-.29-.7L10.5 1.79a1 1 0 0 0-.7-.29H3.5Zm1.5 3h2.25a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5ZM5 9.5h6a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5Zm0 2.25h4a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5Z' })))),
                  React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, it.name),
                  React.createElement('span', { style: { fontSize: 11, opacity: 0.55, flexShrink: 0, fontFamily: 'monospace' } }, it.dir ? '' : (humanSize(it.size) + (it.mtime ? '  ' + fmtTime(it.mtime) : ''))),
                )) : React.createElement('div', { style: { opacity: 0.6, padding: 12 } }, tr('picker.emptyDir'))),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', padding: '6px 10px', borderTop: '1px solid ' + T.border } },
            React.createElement('span', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, tr('picker.selected', { path: (last.path || (win ? tr('picker.driveRoot') : '/')) })),
            React.createElement('button', { style: { ...buttonS, fontWeight: 600 }, onClick: () => { acceptBrowserPick(last.path); setPopOpen(false) } }, tr('picker.chooseThis')),
          ),
        )
      }

      if (!open) return null
      const tabBtn = (t, lbl) => React.createElement('button', { onClick: () => switchTab(t), style: { ...buttonS, fontWeight: tab === t ? 700 : 400 } }, lbl)
      return React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }, onClick: () => { if (!busy) onCancel() } },
        React.createElement('div', { style: { background: v('--dsw-alias-bg-layer-1', '#18181b'), border: '1px solid ' + T.borderStrong, borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,0.5)', width: 'min(600px, 94vw)', maxHeight: 'min(680px, 92vh)', display: 'flex', flexDirection: 'column', padding: 16, boxSizing: 'border-box' }, onClick: (e) => e.stopPropagation() },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
          React.createElement('div', null, tr('picker.title')),
          React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: () => { if (!busy) onCancel() }, disabled: busy }, tr('picker.close')),
        ),
        React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          tabBtn('local', tr('picker.tabLocal')),
          tabBtn('remote', tr('picker.tabRemote')),
        ),
        tab === 'local'
          ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              React.createElement('div', { style: { fontSize: 12, opacity: 0.8 } }, tr('picker.localIntro')),
              React.createElement('div', { style: { display: 'flex', gap: 6 } },
                React.createElement('input', { value: path, onChange: (e) => setPath(e.target.value), placeholder: tr('picker.localPlaceholder'), style: inputS }),
                React.createElement('button', { style: buttonS, onClick: () => (path.trim() ? onPicked(path) : undefined), disabled: !path.trim() }, tr('picker.useLocalPath')),
              ),
              React.createElement('button', { style: { ...buttonS, alignSelf: 'flex-start' }, onClick: chooseLocal, disabled: loading }, loading ? tr('picker.opening') : tr('picker.openSysPicker')),
              err ? React.createElement('div', { style: { color: T.danger, fontSize: 12 } }, err) : null,
              localPop ? renderLocalPopup() : null,
            )
          : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto' } },
              React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                React.createElement('label', { style: { fontSize: 12, opacity: 0.8, whiteSpace: 'nowrap' } }, tr('picker.remoteMachine')),
                React.createElement('div', { ref: ddRef, style: { position: 'relative', display: 'inline-block' } },
                  React.createElement('button', { style: { ...inputS, textAlign: 'left', cursor: 'pointer', minWidth: 200, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, onClick: () => setMOpen((x) => !x) },
                    (machines.find((m) => m.id === machineId) || {}).name || (machineId ? '…' : tr('picker.chooseMachine')),
                  ),
                  mOpen
                    ? React.createElement('div', { style: { position: 'absolute', top: '100%', left: 0, zIndex: 1000, marginTop: 2, minWidth: 300, maxHeight: 260, overflow: 'auto', background: v('--dsw-alias-bg-overlay', '#1f1f23'), border: '1px solid ' + T.border, borderRadius: T.radius, padding: 4 } },
                        machines.length
                          ? machines.map((m) => React.createElement('div', { key: m.id, onClick: () => { setMachineId(m.id); setRecent(m.recentWorkspaces || []); setLevels(null); setPath(''); setMOpen(false); if (m.id) loadLevels(m.id, '', 0) }, style: { padding: '6px 8px', borderRadius: 4, cursor: 'pointer', color: m.id === machineId ? T.ok : 'inherit' } }, m.name + '  (' + m.username + '@' + m.host + ':' + m.port + ')'))
                          : React.createElement('div', { style: { padding: 6, opacity: 0.6 } }, tr('picker.noMachines')),
                      )
                    : null,
                ),
              ),
              // 最近工作区快捷入口
              recent.length ? React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap' } }, tr('picker.recent')),
                recent.map((w, i) => React.createElement('button', { key: w + i, onClick: () => { setPath(w); setErr(''); continueSuggest(w) }, style: { ...buttonS, padding: '2px 8px', fontSize: 11, fontFamily: 'monospace' } }, w))) : null,
              React.createElement('div', { ref: suggestRef, style: { position: 'relative' } },
                React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  React.createElement('input', { value: path, onChange: (e) => onPathChange(e.target.value), onFocus: () => loadSuggestions(path), placeholder: (machineId ? (win ? tr('picker.pathPlaceholderWin') : tr('picker.pathPlaceholder')) : tr('picker.chooseMachineFirst')), disabled: !machineId, style: { ...inputS, flex: 1, minWidth: 120 } }),
                  React.createElement('button', { style: { ...buttonS, whiteSpace: 'nowrap' }, onClick: () => { if (!machineId) return; const p = path.trim(); loadLevels(machineId, p || '', 0); setPopOpen(true) }, disabled: !machineId }, tr('picker.browse')),
                  React.createElement('button', { style: { ...buttonS, whiteSpace: 'nowrap' }, onClick: pickHome, disabled: !machineId }, tr('picker.home')),
                ),
                (suggestOpen && suggest.length)
                  ? React.createElement('div', { style: { marginTop: 6, background: v('--dsw-alias-bg-overlay', '#1e1e1e'), border: '1px solid ' + T.borderStrong, borderRadius: 8, maxHeight: 200, overflowY: 'auto', boxShadow: '0 6px 24px rgba(0,0,0,0.25)' } },
                      suggest.map((s, i) => React.createElement('div', { key: s + i, onMouseDown: () => selectSuggestion(s), style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s)),
                    )
                  : null,
              ),
              popOpen ? renderDirPopup() : null,
              err ? React.createElement('div', { style: { color: T.danger, fontSize: 12 } }, err) : null,
              React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' } },
                React.createElement('span', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, path ? tr('picker.selected', { path }) : ''),
                React.createElement('button', { style: { ...buttonS, fontWeight: 600 }, onClick: () => commitPath(path), disabled: busy || !machineId || !path.trim() }, busy ? tr('picker.mirroring') : tr('picker.setRemoteWs')),
              ),
            ),
        (tab === 'local') ? React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } }, React.createElement('button', { style: { background: 'transparent' }, onClick: onCancel }, tr('picker.cancel'))) : null,
        React.createElement('div', { style: { display: 'flex', gap: 10, justifyContent: 'center', alignItems: 'center', paddingTop: 6, fontSize: 10, opacity: 0.5 } },
          React.createElement('a', { href: 'https://github.com/flymysql/dsh-remote', target: '_blank', rel: 'noopener noreferrer', style: { color: 'inherit' } }, '⭐ Star dsh-remote'),
          React.createElement('span', {}, '·'),
          React.createElement('a', { href: 'https://github.com/flymysql/dsh-remote/issues/new', target: '_blank', rel: 'noopener noreferrer', style: { color: 'inherit' } }, 'Feedback / report issue'),
        ),
        ),
      )
    }

    // ── better-sidebar integration (optional) ────────────────────────────────
    const SIDEBAR_EXPLORER_ID = 'dsh-remote:explorer'
    const SIDEBAR_FILE_ID = 'dsh-remote:file'

    function fetchRemoteStatus() {
      return api('GET', '/dsh-remote/status').catch(() => null)
    }

    // Resolve the remote path this session shows. Issue #13: the ONLY source
    // of truth is the session's own cwd mapped through /dsh-remote/resolve-
    // mirror — a cwd outside any mirror dir means "this session is NOT a
    // remote session", and the sidebar must NOT fall back to the machine
    // workspace (that made an unrelated saved machine leak into local
    // sessions).
    function resolveSessionRemote(sessionId) {
      if (!sessionId) return Promise.resolve('')
      // 1) Prefer the client-side session list cwd (mirror dir under
      //    $DSH_HOME/remote-workspaces/...) passed as ?local=.
      let local = ''
      try {
        const list = SESSIONS && SESSIONS.list && typeof SESSIONS.list.getSnapshot === 'function'
          ? SESSIONS.list.getSnapshot()
          : null
        const entry = list && list.byId && list.byId[sessionId]
        if (entry && entry.cwd) local = String(entry.cwd)
      } catch { /* sessions store shape differs */ }
      if (local) {
        return api('GET', '/dsh-remote/resolve-mirror?local=' + encodeURIComponent(local))
          .then((r) => (r && r.remotePath) || '')
          .catch(() => '')
      }
      // 2) Fall back to host-side session header cwd.
      return api('GET', '/dsh-remote/resolve-mirror?sessionId=' + encodeURIComponent(sessionId))
        .then((r) => (r && r.remotePath) || '')
        .catch(() => '')
    }

    function readRemoteFile(path, maxBytes) {
      return api('POST', '/dsh-remote/read', { path, maxBytes }).catch((e) => {
        throw new Error(tr('file.readFail', { msg: ((e && e.message) || e) }))
      })
    }

    function listRemoteDir(path) {
      return api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(path || '')).catch((e) => {
        throw new Error(tr('file.listFail', { msg: ((e && e.message) || e) }))
      })
    }

    function joinRemote(base, name) {
      if (!base) return name
      return base.replace(/[\\/]+$/, '') + (base.includes('\\') ? '\\' : '/') + name
    }

    // ── Remote explorer tab ────────────────────────────────────────────────
    // Inline monochrome icons (fill: currentColor → follows the row text color,
    // i.e. black on the sidebar). Folder open/closed + file.
    const IconFolder = (open) => React.createElement('svg', {
      width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', style: { flexShrink: 0 },
    },
      open
        ? React.createElement('path', { d: 'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2a1.5 1.5 0 0 1 1.06.44L8.5 3.7h4.5A1.5 1.5 0 0 1 14.5 5.2V12A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5Zm2.5 1a.5.5 0 0 0 0 1h1.2a.5.5 0 0 0 0-1H4Z' })
        : React.createElement('path', { d: 'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2a1.5 1.5 0 0 1 1.06.44L8.5 3.7h4.5A1.5 1.5 0 0 1 14.5 5.2V12A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5Zm2.5 1a.5.5 0 0 0 0 1h1.2a.5.5 0 0 0 0-1H4Z' }),
    )
    const IconFile = () => React.createElement('svg', {
      width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', style: { flexShrink: 0, opacity: 0.85 },
    },
      React.createElement('path', { d: 'M3.5 1.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5.2a1 1 0 0 0-.29-.7L10.5 1.79a1 1 0 0 0-.7-.29H3.5Zm1.5 3h2.25a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5ZM5 9.5h6a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5Zm0 2.25h4a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5Z' }),
    )

    // Tree-style remote file explorer. Uses the same `expanded` / `onToggleDir`
    // contract as the built-in local file tree (better-sidebar framework
    // manages + persists the expanded set), so interaction and look match the
    // local files tab. Data is listed live from the remote host over
    // /dsh-remote/ls, rooted at this session's remote workspace dir.
    function RemoteExplorerTab(props) {
      const [status, setStatus] = React.useState(null)
      const [root, setRoot] = React.useState('') // remote root path for this session
      const [data, setData] = React.useState({}) // dir -> { entries | error | loading }
      const dataRef = React.useRef(data)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [picker, setPicker] = React.useState(false)
      const [menu, setMenu] = React.useState(null) // { x, y, path, isDir, name }
      const [rootOpen, setRootOpen] = React.useState(true) // first level expanded by default
      const [hoverPath, setHoverPath] = React.useState('') // row hover highlight
      /** Row whose path was just copied — shows a brief「已复制」label. */
      const [copiedPath, setCopiedPath] = React.useState('')
      const expanded = Array.isArray(props.expanded) ? props.expanded : []

      const storeLevel = (path, level) => {
        dataRef.current = { ...dataRef.current, [path]: level }
        setData(dataRef.current)
      }

      const loadDir = React.useCallback((dir, opts) => {
        const cur = dataRef.current
        const existing = cur[dir]
        // If we already have data (entries loaded) and this is a background
        // refresh, keep what we have — don't flash a loading state over a
        // populated tree.
        if (existing && !existing.loading && opts && opts.keep) return
        if (cur[dir] !== undefined && !cur[dir].loading) return
        storeLevel(dir, { loading: true })
        listRemoteDir(dir)
          .then((res) => {
            const items = Array.isArray(res && res.items) ? res.items : []
            const sorted = items.slice().sort((a, b) => {
              if (a.type === 'dir' && b.type !== 'dir') return -1
              if (a.type !== 'dir' && b.type === 'dir') return 1
              return String(a.name).localeCompare(String(b.name))
            })
            storeLevel(dir, { entries: sorted })
          })
          .catch((e) => {
            // Keep any previously-loaded entries under this dir (so a transient
            // SFTP failure doesn't collapse the whole subtree); surface a
            // message only when there was nothing to show before.
            const prev = dataRef.current[dir]
            if (prev && prev.entries) {
              storeLevel(dir, { ...prev, softError: String((e && e.message) || e) })
            } else {
              storeLevel(dir, { error: String((e && e.message) || e) })
            }
          })
      }, [])

      // Resolve this session's remote root, then load it and every expanded dir.
      // Re-runs whenever the session scope changes (switching conversations, or
      // the async sessionCwd fetch landing), so the sidebar follows the session's
      // own workspace dir.
      const scopeCwd = props.scope && props.scope.cwd
      const sessionId = props.scope && props.scope.sessionId
      const rootRef = React.useRef('')
      const refreshStatus = React.useCallback((opts) => {
        const applyRoot = (r, connected) => {
          const prevRoot = rootRef.current
          rootRef.current = r
          setRoot(r)
          // Full reset ONLY when the session's remote root actually changed
          // (different workspace / different conversation). When we just come
          // back to this tab with the same workspace, keep the loaded tree so
          // expanded dirs and their contents stay put.
          const sameRoot = prevRoot && r && prevRoot === r
          if (!sameRoot) {
            setData({})
            dataRef.current = {}
          }
          if (r) {
            // Not connected (e.g. freshly restarted, machine no longer active):
            // show a clear disconnected state instead of firing ls requests
            // that all fail with AggregateError / 500 in a loop.
            if (!connected) {
              storeLevel(r, { error: tr('explorer.notConnected') })
              return
            }
            if (!sameRoot) {
              storeLevel(r, { loading: true })
            }
            listRemoteDir(r)
              .then((res) => {
                const items = Array.isArray(res && res.items) ? res.items : []
                const sorted = items.slice().sort((a, b) => {
                  if (a.type === 'dir' && b.type !== 'dir') return -1
                  if (a.type !== 'dir' && b.type === 'dir') return 1
                  return String(a.name).localeCompare(String(b.name))
                })
                storeLevel(r, { entries: sorted, missing: !!(res && res.missing) })
                for (const dir of expanded) loadDir(dir, { keep: true })
              })
              .catch((e) => {
                // Transient connection failure: keep the previously visible
                // root level so the tree doesn't collapse to an error.
                const prev = dataRef.current[r]
                if (prev && prev.entries) {
                  storeLevel(r, { ...prev, softError: String((e && e.message) || e) })
                } else {
                  storeLevel(r, { error: String((e && e.message) || e) })
                }
              })
          }
        }
        const resolveRoot = () => {
          if (scopeCwd) {
            return api('GET', '/dsh-remote/resolve-mirror?local=' + encodeURIComponent(scopeCwd))
              .then((r) => (r && r.remotePath) || '')
              .catch(() => '')
          }
          if (sessionId) return resolveSessionRemote(sessionId)
          return Promise.resolve('')
        }
        resolveRoot().then((r) => {
          fetchRemoteStatus().then((s) => {
            setStatus(s)
            // Issue #13: NEVER fall back to the machine-level workspace here —
            // a session whose cwd is not a mirror is a LOCAL session and shows
            // the "no remote workspace" empty state instead.
            applyRoot(r || '', !!(s && s.connected))
          })
        })
      }, [scopeCwd, sessionId])

      React.useEffect(() => { refreshStatus() }, [refreshStatus])
      React.useEffect(() => { if (props.visible) refreshStatus({ visible: true }) }, [props.visible])
      // Load dirs as they get expanded (keep already-loaded content).
      React.useEffect(() => { if (root) for (const dir of expanded) loadDir(dir, { keep: true }) }, [root, expanded, loadDir])
      // ── Context-menu portal: append to document.body so the sidebar's
      //    overflow/transform cannot clip it. Pure DOM, no React portal needed.
      React.useEffect(() => {
        if (!menu) return
        const host = document.createElement('div')
        host.style.cssText = 'position:fixed;z-index:999999;pointer-events:auto'
        const box = document.createElement('div')
        box.style.cssText = 'position:fixed;left:' + menu.x + 'px;top:' + menu.y + 'px;z-index:999999;background:#1f1f23;border:1px solid rgba(128,128,128,0.5);border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:170;font-family:system-ui,sans-serif'
        const mkItem = (label, danger, fn) => {
          const d = document.createElement('div')
          d.textContent = label
          d.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:12px;color:' + (danger ? '#e06c75' : '#e4e4e7') + ';border-radius:4px;white-space:nowrap;transition:background 0.1s'
          d.onmouseenter = () => { d.style.background = 'rgba(128,128,128,0.14)' }
          d.onmouseleave = () => { d.style.background = 'transparent' }
          d.addEventListener('click', (e) => { e.stopPropagation(); setMenu(null); fn() })
          return d
        }
        box.appendChild(mkItem(menu.isDir ? tr('explorer.menuExpand') : tr('explorer.menuOpen'), false, () => { if (menu.isDir) { if (props.onToggleDir) props.onToggleDir(menu.path) } else openFile(menu.path) }))
        box.appendChild(mkItem(tr('explorer.menuDownload'), false, () => doFs('download', { path: menu.path })))
        box.appendChild(mkItem(tr('explorer.menuCopyRel'), false, () => copyPath(relPath(menu.path), menu.path)))
        box.appendChild(mkItem(tr('explorer.menuCopyAbs'), false, () => copyPath(menu.path, menu.path)))
        box.appendChild(mkItem(tr('explorer.menuRename'), false, () => { const nm = window.prompt(tr('explorer.renamePrompt'), menu.name); if (nm && nm.trim() && nm.trim() !== menu.name) doFs('rename', { path: menu.path, dest: joinRemote(String(menu.path).replace(/[\\/][^\\/]*$/, ''), nm.trim()) }, true) }))
        box.appendChild(mkItem(menu.isDir ? tr('explorer.menuDeleteDir') : tr('explorer.menuDelete'), true, () => { if (window.confirm(tr('explorer.deleteConfirm', { path: menu.path }))) doFs('remove', { path: menu.path }, true) }))
        host.appendChild(box)
        document.body.appendChild(host)
        const close = (e) => { if (!box.contains(e.target)) { setMenu(null) } }
        // Delay adding listener so the same mousedown that opened the menu doesn't close it
        const tid = setTimeout(() => document.addEventListener('mousedown', close), 0)
        return () => { clearTimeout(tid); document.removeEventListener('mousedown', close); host.remove() }
      }, [menu])

      const openFile = (p) => {
        const name = String(p).split(/[\\/]/).pop() || p
        props.ctx.betterSidebar.openTab({ type: SIDEBAR_FILE_ID, title: name, path: p }, props.scope)
      }

      const doFs = (op, payload, refreshParent) => {
        setBusy(op)
        return api('POST', '/dsh-remote/fs', { op, ...payload })
          .then(() => {
            setErr('')
            if (refreshParent) {
              dataRef.current = {}
              setData({})
              if (root) { storeLevel(root, { loading: true }); loadDir(root) }
              for (const dir of expanded) loadDir(dir)
            }
          })
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setBusy(''))
      }

      const onCtx = (e, path, isDir, name) => {
        e.preventDefault(); e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY, path, isDir, name })
      }
      const ctxItem = (label, danger, fn) => React.createElement('div', {
        onClick: (e) => { e.stopPropagation(); setMenu(null); fn() },
        style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12, color: danger ? '#e06c75' : '#e4e4e7', borderRadius: 4, whiteSpace: 'nowrap' },
      }, label)

      // The path shown by「复制相对地址」: relative to this session's remote
      // workspace root (mirror of the built-in local tree's cwd-relative copy).
      const relPath = (p) => {
        if (!root) return p
        const r = String(root).replace(/[\\/]+$/, '')
        const s = String(p)
        if (s === r) return '.'
        if (s.startsWith(r + '/')) return s.slice(r.length + 1)
        if (s.startsWith(r + '\\')) return s.slice(r.length + 1)
        return s
      }
      // Copy `text`, then briefly flag the row whose path was copied.
      const copyPath = (text, path) => {
        copyToClipboard(text).then((ok) => {
          if (!ok) return
          setCopiedPath(path)
          window.setTimeout(() => {
            setCopiedPath((cur) => (cur === path ? '' : cur))
          }, 1200)
        })
      }
      /** Trailing「已复制」feedback for a row (after a successful copy). */
      const copiedMark = (path) => (copiedPath === path
        ? React.createElement('span', { style: { fontSize: 11, opacity: 0.75, flexShrink: 0, color: T.ok } }, tr('explorer.copied'))
        : null)

      // One tree row (dir toggles via the framework's onToggleDir; file opens).
      // Text uses the normal foreground (theme-following) — no accent green.
      const row = (entry, depth) => {
        const pad = depth * 22 + 6
        const hovered = hoverPath === entry.path
        const base = {
          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: pad,
          borderRadius: 5, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis', transition: 'background 0.12s ease',
          background: hovered ? 'rgba(128,128,128,0.14)' : 'transparent',
          color: T.label,
        }
        if (entry.type === 'dir') {
          const isOpen = expanded.includes(entry.path)
          return React.createElement('div', { key: entry.path },
            React.createElement('div', {
              role: 'button', tabIndex: 0,
              onClick: () => { if (props.onToggleDir) props.onToggleDir(entry.path) },
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (props.onToggleDir) props.onToggleDir(entry.path) } },
              onContextMenu: (e) => onCtx(e, entry.path, true, entry.name),
              onMouseEnter: () => setHoverPath(entry.path),
              onMouseLeave: () => setHoverPath((p) => (p === entry.path ? '' : p)),
              style: base,
              title: entry.path,
            },
              React.createElement('span', { style: { flexShrink: 0, color: T.label, display: 'inline-flex' } }, IconFolder(isOpen)),
              React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, fontWeight: 500 } }, entry.name),
              copiedMark(entry.path),
            ),
            isOpen ? renderLevel(entry.path, depth + 1) : null,
          )
        }
        return React.createElement('div', {
          role: 'button', tabIndex: 0, key: entry.path,
          onClick: () => openFile(entry.path),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(entry.path) } },
          onContextMenu: (e) => onCtx(e, entry.path, false, entry.name),
          onMouseEnter: () => setHoverPath(entry.path),
          onMouseLeave: () => setHoverPath((p) => (p === entry.path ? '' : p)),
          style: base,
          title: entry.path,
        },
          React.createElement('span', { style: { flexShrink: 0, display: 'inline-flex' } }, IconFile()),
          React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, entry.name),
          copiedMark(entry.path),
          (entry.size != null || entry.mtime)
            ? React.createElement('span', { style: { fontSize: 11, opacity: 0.55, flexShrink: 0, fontFamily: 'monospace' } },
                humanSize(entry.size) + (entry.mtime ? '  ' + fmtTime(entry.mtime) : ''))
            : null,
        )
      }

      const renderLevel = (dir, depth) => {
        const level = data[dir]
        if (level === undefined || (level.loading && !level.entries)) {
          return React.createElement('div', { key: dir + ':loading', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: depth * 22 + 6, fontSize: 13, opacity: 0.6 } }, tr('explorer.loading'))
        }
        if (level.missing) {
          return React.createElement('div', { key: dir + ':missing', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: depth * 22 + 6, fontSize: 13, opacity: 0.6 } }, tr('explorer.dirMissing'))
        }
        if (level.error !== undefined) {
          return React.createElement('div', { key: dir + ':err', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: depth * 22 + 6, fontSize: 13, color: '#e06c75' } }, level.error)
        }
        const items = level.entries || []
        const soft = level.softError
          ? React.createElement('div', { key: dir + ':softerr', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: depth * 22 + 6, fontSize: 11, opacity: 0.6, color: '#e6c07b' } }, tr('explorer.softError', { msg: level.softError }))
          : null
        if (!items.length) return soft || null
        return React.createElement('div', { key: dir + ':list' },
          items.map((it) => row({ ...it, path: joinRemote(dir, it.name) }, depth)),
          soft,
        )
      }

      const rootName = root ? String(root).split(/[\\/]/).filter(Boolean).pop() || root : ''
      const rootLevel = data[root]

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,0.25)' } },
          React.createElement('button', { style: { ...buttonS, padding: '3px 8px', fontSize: 12 }, onClick: refreshStatus, title: tr('explorer.refresh') }, '↻'),
          React.createElement('button', {
            style: { ...buttonS, padding: '3px 8px', fontSize: 12 },
            onClick: () => { const nm = window.prompt(tr('picker.newDirName', { path: (root || '/') })); if (nm && nm.trim()) doFs('mkdir', { path: joinRemote(root, nm.trim()) }, true) },
          }, tr('explorer.newDir')),
          React.createElement('button', { style: { ...buttonS, padding: '3px 8px', fontSize: 12 }, onClick: () => setPicker(true) }, tr('explorer.more')),
        ),
        status && status.workspace && root
          ? React.createElement('div', { style: { fontSize: 11, opacity: 0.7, padding: '4px 8px', wordBreak: 'break-all' } }, tr('explorer.remoteWs', { path: root, host: (status.host ? tr('explorer.hostTag', { user: status.username, host: status.host }) : '') }))
          : React.createElement('div', { style: { fontSize: 11, opacity: 0.7, padding: '4px 8px' } }, root ? tr('explorer.noRemoteWs') : tr('explorer.sessionLocal')),
        picker ? React.createElement('div', { style: { padding: 8 } }, React.createElement(DirPicker, {
          open: true, busy: false, onPicked: () => { setPicker(false); refreshStatus() }, onCancel: () => setPicker(false),
        })) : null,
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', minHeight: 0, padding: '2px 0' } },
          !root
            ? React.createElement('div', { style: { opacity: 0.6, padding: 12, fontSize: 13 } }, tr('explorer.localSession'))
            : React.createElement('div', { key: root },
                React.createElement('div', {
                  role: 'button', tabIndex: 0,
                  onClick: () => setRootOpen((v) => !v),
                  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRootOpen((v) => !v) } },
                  onContextMenu: (e) => onCtx(e, root, true, rootName),
                  style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: 6, borderRadius: 5, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: T.label, fontWeight: 600 },
                  title: root,
                },
                  React.createElement('span', { style: { flexShrink: 0, color: T.label, display: 'inline-flex' } }, IconFolder(rootOpen)),
                  React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, rootName || root),
                ),
                rootLevel && rootOpen ? renderLevel(root, 1) : null,
              ),
        ),
        // context menu — now rendered via DOM portal in useEffect above
        null,
        err ? React.createElement('div', { style: { color: '#e06c75', fontSize: 12, padding: '4px 8px' } }, (busy ? tr('explorer.busy') : '') + err) : null,
      )
    }

    // ── Remote file tab (opened by the explorer; live read + explicit edit) ──
    function RemoteFileTab(props) {
      const { tab, scope } = props
      const path = tab.path || ''
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [edit, setEdit] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)

      const load = () => {
        if (!path) { setLoading(false); return }
        let cancelled = false
        setLoading(true); setErr(''); setData(null); setEdit(false)
        readRemoteFile(path, 256 * 1024)
          .then((d) => { if (!cancelled) { setData(d); setLoading(false) } })
          .catch((e) => { if (!cancelled) { setErr(String((e && e.message) || e)); setLoading(false) } })
        return () => { cancelled = true }
      }
      React.useEffect(load, [path])

      const startEdit = () => {
        if (!data || data.binary) return
        setDraft((data.content != null ? data.content : '').replace(/\n…\[truncated:.*$/, ''))
        setEdit(true); setErr('')
      }
      const saveRemote = () => {
        setSaving(true); setErr('')
        apiRaw('POST', '/dsh-remote/write', { path, content: draft })
          .then((r) => {
            if (r.status === 409) {
              setErr(String((r.data && r.data.error) || tr('file.conflict')))
              return
            }
            if (r.status >= 400) throw new Error((r.data && (r.data.error || r.data.message)) || 'HTTP ' + r.status)
            setEdit(false)
            load()
          })
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setSaving(false))
      }
      const downloadMirror = () => {
        setSaving(true); setErr('')
        api('POST', '/dsh-remote/fs', { op: 'download', path })
          .then((r) => setErr(tr('file.downloaded', { local: (r && r.local ? tr('file.downloadedAt', { path: r.local }) : '') })))
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setSaving(false))
      }

      const baseName = path.split(/[\\/]/).pop() || path
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid rgba(128,128,128,0.25)', fontSize: 12 } },
          React.createElement('span', { style: { fontWeight: 600, whiteSpace: 'nowrap' } }, '📄 ' + baseName),
          React.createElement('code', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.75 } }, path),
          React.createElement('span', { style: { opacity: 0.7, fontSize: 11, flexShrink: 0 } }, edit ? tr('file.editing') : tr('file.readonly')),
          edit
            ? React.createElement(React.Fragment, null,
                React.createElement('button', { style: { ...buttonS, padding: '2px 10px', fontSize: 12 }, onClick: saveRemote, disabled: saving }, saving ? tr('file.saving') : tr('file.saveToRemote')),
                React.createElement('button', { style: { ...buttonS, padding: '2px 10px', fontSize: 12 }, onClick: () => { setEdit(false); setErr('') } }, tr('file.cancel')))
            : React.createElement(React.Fragment, null,
                React.createElement('button', { style: { ...buttonS, padding: '2px 10px', fontSize: 12 }, onClick: startEdit, disabled: !data || data.binary }, tr('file.edit')),
                React.createElement('button', { style: { ...buttonS, padding: '2px 10px', fontSize: 12 }, onClick: downloadMirror, disabled: saving }, tr('file.download'))),
        ),
        React.createElement('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 } },
          loading ? React.createElement('div', { style: { opacity: 0.7, padding: 12, fontSize: 13 } }, tr('file.loading'))
            : err ? React.createElement('div', { style: { color: '#e06c75', padding: 12, fontSize: 13 } }, err)
              : (data && data.binary
                  ? React.createElement('div', { style: { padding: 12, fontSize: 13, color: '#e6c07b' } },
                      tr('file.binary', { size: (data.size != null ? data.size + ' bytes' : tr('file.unknownSize')) }))
                  : (edit
                      ? React.createElement('textarea', { value: draft, onChange: (e) => setDraft(e.target.value), spellCheck: false, style: { width: '100%', height: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', resize: 'none', background: 'transparent', color: '#e4e4e7', fontSize: 13, lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', padding: '10px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } })
                      : React.createElement('div', { style: { fontSize: 13, lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', padding: '10px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                          (data && data.content != null) ? data.content : tr('file.empty'),
                          (data && data.truncated)
                            ? React.createElement('div', { style: { color: '#e6c07b', fontSize: 12, marginTop: 8 } }, tr('file.truncated'))
                            : null,
                        ))),
        ),
      )
    }

    // ── better-sidebar registration (guarded: plugin may be absent) ────────
    function registerSidebarIntegration(ctx) {
      const bs = (ctx && ctx.get && ctx.get('betterSidebar')) || null
      if (!bs || typeof bs.registerTab !== 'function') return
      const disposers = []
      try {
        disposers.push(bs.registerTab({
          id: SIDEBAR_EXPLORER_ID,
          title: () => tr('explorer.tabTitle'),
          icon: (size) => React.createElement('span', { style: { fontSize: (size || 14), lineHeight: 1 } }, '🌐'),
          order: 55,
          single: true,
          component: (props) => React.createElement(RemoteExplorerTab, props),
        }))
        disposers.push(bs.registerTab({
          id: SIDEBAR_FILE_ID,
          title: () => tr('explorer.tabTitle'),
          hidden: true, // not in the + menu; opened from the explorer tree
          dedupeKey: (tab) => tab.path,
          component: (props) => React.createElement(RemoteFileTab, props),
        }))
      } catch (e) {
        console.warn('[dsh-remote] better-sidebar integration skipped:', e)
        disposers.forEach((d) => { try { d() } catch {} })
        return
      }
      let autoOpenedFor = new Set()
      let disposeAuto = null
      const tryAutoOpen = () => {
        if (typeof bs.subscribeState !== 'function') return
        const snap = bs.getSnapshot && bs.getSnapshot()
        if (!snap || !snap.sessionId) return
        if (autoOpenedFor.has(snap.sessionId)) return
        const sessionId = snap.sessionId
        // Issue #13: only auto-open the Remote Files tab for sessions that are
        // genuinely remote (cwd inside a mirror). A plain local session must
        // not get a remote tab popped open by a machine that happens to be
        // saved as "current".
        resolveSessionRemote(sessionId).then((remotePath) => {
          if (!remotePath || autoOpenedFor.has(sessionId)) return
          autoOpenedFor.add(sessionId)
          try {
            bs.openTab({ type: SIDEBAR_EXPLORER_ID, title: tr('explorer.tabTitle'), path: remotePath })
          } catch (e2) {
            console.warn('[dsh-remote] better-sidebar auto-open skipped:', e2)
          }
        })
      }
      tryAutoOpen()
      if (typeof bs.subscribeState === 'function') {
        disposeAuto = bs.subscribeState(tryAutoOpen)
        disposers.push(disposeAuto)
      }
      return () => disposers.forEach((d) => { try { d() } catch {} })
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      wireLocale(ctx)
      // Issue #26: on dsh 0.1.2-rc.1+ the cordis ctx proxy throws
      // "cannot get property \"workspaces\" without inject" on ANY bare property
      // read of an undeclared/unavailable service. ctx.get(name) stays an
      // optional lookup that returns undefined instead of throwing, so never
      // fall back to ctx.<name> property access — keep it purely optional.
      WORKSPACES = (ctx && ctx.get && ctx.get('workspaces')) || null
      SESSIONS = (ctx && ctx.get && ctx.get('sessions')) || null
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'dsh-remote', priority: 40, label: () => tr('settings.title') }, () => React.createElement(RemoteWorkspacePage, null)),
      )
      slots.inject(
        'conversation.hero.workspace.directoryFlow',
        () => slots.inject('sidebar.workspaces.directoryFlow',
          function* () {
            yield slots.register({ name: 'conversation.hero.workspace.directoryFlow', id: 'dsh-remote', priority: -100 }, DirPicker)
            yield slots.register({ name: 'sidebar.workspaces.directoryFlow', id: 'dsh-remote', priority: -100 }, DirPicker)
          },
        ),
      )
      ctx.inject(['betterSidebar'], (inner) => {
        const bsDispose = registerSidebarIntegration(inner)
        if (bsDispose) {
          inner.effect(() => bsDispose, 'dsh-remote.betterSidebar')
        }
      })
    }

    exports.name = name
    exports.apply = apply
    return module.exports
  },
})
