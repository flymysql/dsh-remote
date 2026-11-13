// dsh-remote — client half.
// Settings → 远程工作区: a multi-machine SSH registry (configuration and independent connectivity checks;
// passphrase / host-key mode / proxy jump / agent / keychain password; password
// stored host-side and kept private). Plus a port-forward panel, the command
// audit log view and SSH configuration management.
//
// A unified workspace directory picker fills ui-workspace's two directory-flow
// holes (sidebar + conversation hero):
//   • 本机 tab → opens the NATIVE OS folder chooser (/dsh-remote/local-pick)
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
    const CLIENT_VERSION = '1.0.1'

    // ── optional host primitives ────────────────────────────────────────────
    // Issue #74: a remote session's .md link must open over SFTP, NOT via the
    // built-in preview that reads the local mirror and dies with ENOENT when the
    // file was never synced. remote-link therefore claims .md again (issue #64's
    // objection was "source is a downgrade from a rendered doc") — but the viewer
    // RENDERS the markdown with the host's own MarkdownText when this build ships
    // one, so there is no downgrade. Older builds / the test harness fall back to
    // plain source.
    const Primitives = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return null } })()
    // A host primitive is a component TYPE, and a component type is not always a
    // function: the host ships MarkdownText as a `React.memo` wrapper, i.e.
    // `typeof === 'object'` with `$$typeof === Symbol.for('react.memo')`, which
    // createElement accepts just fine. Testing `typeof === 'function'` therefore
    // threw the renderer away and every remote .md silently degraded to the
    // raw-source wall (issue #101).
    const isComponentType = (value) => typeof value === 'function'
      || (typeof value === 'object' && value !== null && typeof value.$$typeof === 'symbol')
    const MarkdownText = (Primitives && isComponentType(Primitives.MarkdownText)) ? Primitives.MarkdownText : null
    // Host visual primitives adopted incrementally, always with a graceful
    // fallback (the shared map's contents vary by host version — the bundle
    // ships ~290 exports, older type packages fewer):
    //   Modal — always-portaled dialog with focus trap/autofocus/restore and
    //     IME-composition guards (useModalLayer underneath). Its mask dismisses
    //     on bare click, so the DIR PICKER keeps its own press-origin-guarded
    //     overlay (issue #52); simple dialogs without mid-gesture re-layouts
    //     (PromptDialog, ConfirmDialog) adopt Modal wholesale.
    //   HostMenu — anchored menu with optional body portal; replaces our
    //     imperative-DOM context menu when present.
    //   useModalLayer — the focus/escape layer on its own, applied to the picker's
    //     custom overlay (which keeps its #52 mask guard).
    //   writeClipboard — replaces the scratch-textarea copy hack.
    //   Switch — settings toggles (bundle-verified contract: onChange delivers
    //     a bare BOOLEAN, not an event, and unknown props are swallowed, so the
    //     stable data-testids ride on a wrapper span, never on the Switch).
    //   SegmentedTabs — the dir picker's 本机/远程 switch (items[{value,label}],
    //     value, onChange(value)); brings the sliding-indicator tablist.
    //   FileTypeIcon — explorer/picker row glyphs ({kind:'folder'} for dirs,
    //     {path:name} for files; unknown extensions land on 'other').
    const Modal = (Primitives && typeof Primitives.Modal === 'function') ? Primitives.Modal : null
    const HostMenu = (Primitives && typeof Primitives.Menu === 'function') ? Primitives.Menu : null
    const useModalLayerFn = (Primitives && typeof Primitives.useModalLayer === 'function') ? Primitives.useModalLayer : null
    const writeClipboardFn = (Primitives && typeof Primitives.writeClipboard === 'function') ? Primitives.writeClipboard : null
    // The host's Shiki-backed code highlighter (issue #104). Contract verified
    // against the bundle: useCodeHighlighter(lang) → highlight(text) → per-line
    // token arrays [{text, style:{color}}], or undefined for unknown grammars.
    // languageForPath maps a file extension to a grammar id. Either missing ⇒
    // plain text with line numbers (the fallback still answers the issue).
    const useCodeHighlighterFn = (Primitives && typeof Primitives.useCodeHighlighter === 'function') ? Primitives.useCodeHighlighter : null
    const languageForPathFn = (Primitives && typeof Primitives.languageForPath === 'function') ? Primitives.languageForPath : null
    const HostSwitch = (Primitives && typeof Primitives.Switch === 'function') ? Primitives.Switch : null
    const HostSegmentedTabs = (Primitives && typeof Primitives.SegmentedTabs === 'function') ? Primitives.SegmentedTabs : null
    const HostFileTypeIcon = (Primitives && typeof Primitives.FileTypeIcon === 'function') ? Primitives.FileTypeIcon : null

    // Issue #93: floating layers must PORTAL to document.body, exactly like the
    // host's own Modal/Menu (and like our context menu already does with an
    // imperative append). An inline `position:fixed` overlay stays inside the
    // slot's subtree, where the 0.2.2 conversation layout traps its pointer
    // events in existing sessions — the dialog paints but every click falls
    // through to the chat text beneath (the hero page has no such container,
    // which is why new sessions "worked"). react-dom is in the host's shared
    // module map; when it is not (older host, test harness), keep the inline
    // overlay rather than lose the dialog altogether.
    const ReactDOM = (() => { try { return require('react-dom') } catch { return null } })()
    const portalize = (element) => (
      ReactDOM && typeof ReactDOM.createPortal === 'function'
        && typeof document !== 'undefined' && document.body
        ? ReactDOM.createPortal(element, document.body)
        : element
    )

    // ── i18n (issue #14) ────────────────────────────────────────────────────
    // Dictionaries are keyed by stable ids, zh + en share the same key set.
    // Lookup order: active locale → en fallback → the key itself (so a missing
    // translation stays visible instead of blanking the UI).
    const NS = 'dsh-remote'
    const L = {
      zh: {
        'settings.sshConfigEditorTitle': "SSH 配置",
        'settings.sshConfigEditorHint': "编辑运行 DSH 的主机上的 SSH 配置，保存后重新检测主机。",
        'settings.sshConfigReload': "重新载入",
        'settings.sshConfigReloadHint': "从磁盘重新读取；有未保存修改时会先确认",
        'settings.sshConfigSaveHint': "保存配置（Ctrl/Cmd+S）",
        'settings.sshConfigClean': "没有未保存的修改",
        'settings.sshConfigSaved': "SSH 配置已保存，主机列表已刷新。",
        'settings.sshConfigReadFailed': "无法读取 SSH 配置：{msg}",
        'settings.sshConfigSaveFailed': "无法保存 SSH 配置：{msg}",
        'settings.sshConfigConflict': "SSH 配置已被其他程序修改。你的草稿已保留，请先复制需要的修改，再重新载入。",
        'settings.discardSshChanges': "放弃 SSH 配置中未保存的修改？",
        'settings.sshEditorUnavailable': "运行中的插件尚不支持内置编辑器，请完全重启 DSH 并刷新页面。",
        'settings.runtimeMismatch': "界面 v{client} 与运行中的服务 v{host} 不一致（磁盘 v{disk}）。请完全重启 DSH 并刷新此页面。",

        'agent.exec': '远程命令',
        'agent.read': '读取远程文件',
        'agent.edit': '修改远程文件',
        'agent.write': '写入远程文件',
        'agent.search': '搜索远程文件',
        'agent.list': '浏览远程目录',
        'agent.sync': '拉取远程文件',
        'agent.push': '推送本地改动',
        'agent.other': '远程操作',
        'agent.preparing': '准备中',
        'agent.running': '执行中',
        'agent.completed': '已完成',
        'agent.failed': '执行失败',
        'agent.stopped': '已停止',
        'agent.timeout': '执行超时',
        'agent.background': '后台运行中',
        'agent.unknown': '结果待确认',
        'agent.diagnostics': '编译诊断',
        'agent.diagnosticErrors': '{n} 项编译错误',
        'agent.raw': '命令输出',
        'agent.inspect': '查看执行记录',
        'agent.exit': '退出码 {code}',
        'agent.duration': '耗时 {n} 秒',
        'agent.open': '打开 {path} 第 {line} 行',
        'agent.before': '替换前',
        'agent.after': '替换后',
        'agent.truncated': '此处显示前 100,000 个字符，可复制输出或查看执行记录。',
        'settings.title': '远程工作区（dsh-remote）',
        'settings.probeDetails': '查看原因',
        'settings.reachable': '可用',
        'settings.unreachable': '不可用',
        'settings.latencyHint': 'SSH 连接与执行探测的总耗时；不影响任何工作区',
        'settings.pageTitle': '远程工作区',
        'settings.categories': '远程工作区设置分类',
        'settings.category.hosts': '主机',
        'settings.category.tools': '连接工具',
        'settings.category.preferences': '插件偏好',
        'settings.hostActions': '{name} 的更多操作',
        'settings.backHosts': '返回主机列表',
        'settings.unsaved': '有未保存的更改',
        'settings.draftRestored': '已恢复上次未保存的主机设置。',
        'settings.discardChanges': '放弃这台主机尚未保存的更改？',
        'explorer.emptyFolder': '此文件夹为空',
        'explorer.connection.loading': '正在读取远程目录…',
        'explorer.connection.interrupted': '远程访问中断 · 已保留文件列表',
        'explorer.connection.ready': '远程目录已就绪',
        'file.conflictHelp': '远端文件已变化，草稿已保留。请复制草稿后重新读取远端版本，再合并修改；当前不会覆盖远端。',
        'file.copyDraft': '复制草稿',
        'project.hostKeyHelp': '请核对服务器指纹是否发生变更，确认可信后在主机设置中处理。',
        'project.authHelp': '请检查这台主机的 SSH 凭据或认证方式；已输入的路径会保留。',
        'project.pathHelp': '请确认目录存在且当前 SSH 用户有访问权限，或重新浏览选择目录。',
        'project.networkHelp': '请检查网络与 SSH 服务后再次打开。若确认请求已发出但响应丢失，工作区可能已创建，请先检查工作区列表。',
        'file.discardConfirm': '舍弃尚未保存的草稿？如需保留，请先复制草稿。',
        'file.discardReload': '舍弃草稿并读取远端',
        'sync.unknown': '镜像同步 · 尚无本次运行记录',
        'sync.running': '镜像同步中…',
        'sync.completed': '上次镜像同步已完成',
        'sync.partial': '镜像同步部分完成',
        'sync.conflicts': '镜像同步存在冲突',
        'sync.failed': '镜像同步失败',
        'sync.pending': '本地改动待推送',
        'sync.explain': '此状态记录实际同步操作，不代表本地与远端始终一致。使用 rw_sync 拉取远端，rw_push 推送本地；文件栏直接访问远端。',
        'sync.conflictHelp': '冲突文件未覆盖。请比较本地镜像与远端版本后合并修改，再执行同步。',
        'explorer.cannotResolve': '暂时无法读取此会话的远程工作区，请重试连接。',
        'project.machineChanged': '浏览期间目标主机发生变化，请重新选择主机后重试。',
        'file.incompletePreview': '当前文件预览不完整。请在远程终端编辑完整文件，避免覆盖未读取的内容。',
        'workbench.explorer': '资源管理器',
        'workbench.openTerminal': '打开远程终端',
        'workbench.terminalUnavailable': '远程终端尚不可用，请检查宿主终端插件与 remote ssh Shell。',
        'workbench.filter': '筛选已加载文件',
        'workbench.noFilteredFiles': '没有匹配的已加载文件',
        'workbench.collapse': '折叠全部目录',
        'workbench.remote': '远程工作区',
        'workbench.backToFiles': '返回文件树',
        'workbench.copyPath': '复制远程路径',
        'workbench.copyContent': '复制文件内容',
        'workbench.find': '在文件中查找',
        'workbench.wrap': '自动换行',
        'workbench.previous': '上一个匹配',
        'workbench.next': '下一个匹配',
        'workbench.closeFind': '关闭查找',
        'workbench.preview': '预览',
        'workbench.source': '源码',
        'workbench.refreshing': '正在刷新…',
        'workbench.lines': '{n} 行',
        'workbench.position': '第 {line} 行，第 {col} 列',
        'workbench.saved': '已保存到远端',
        'workbench.loadingFile': '正在读取远端文件…',
        'workbench.noMatches': '无匹配',
        'workbench.matches': '{current} / {total}',
        'workbench.openFolder': '打开所属目录',
        'project.search': '搜索项目、主机或路径…',
        'project.recent': '最近打开的项目',
        'project.hosts': 'SSH 主机',
        'project.noMatches': '没有匹配的项目或主机，试试其他关键词。',
        'project.noHosts': '尚无主机。在运行 DSH 的机器上配置 ~/.ssh/config，然后重试。',
        'project.retry': '重试',
        'project.addingHost': '正在添加主机…',
        'project.configHint': '选择最近项目可直接打开；选择主机后再选择目录。新主机来自 DSH 所在机器的 ~/.ssh/config。',
        'project.back': '切换主机或项目',
        'project.opening': '正在打开远程项目…',
        'project.cancel': '取消打开',
        'project.failed': '打开失败，路径已保留。检查连接或路径后重试。',
        'project.details': '诊断详情',
        'project.cancelled': '已取消打开。',
        'project.folder': '选择远程目录',
        'settings.intro': '管理 SSH 主机与连接配置。每个远程工作区独立连接，可同时使用多台主机。',
        'settings.noMachines': '暂无主机。编辑 SSH 配置添加主机，在新建远程工作区时选择主机和目录。',
        // ── issue #73：首屏就是 ssh 配置里的主机列表（像 VSCode Remote-SSH）──
        'settings.pickHost': 'SSH 主机',
        'settings.hostListSource': '来自 ~/.ssh/config',
        'settings.hostListLoading': '正在读取 ~/.ssh/config…',
        'settings.hostListRefresh': '刷新',
        'settings.hostListRefreshHint': '重新读取 ~/.ssh/config（改完文件点这里，不用重开设置页）',
        'settings.hostListEmpty': '没在 {file} 里找到主机。写好 Host 段后点「刷新」。',
        'settings.hostListFailed': '读取失败：{msg}。这不是你的 ssh 配置有问题（文件根本没读到）——点「刷新」重试；一直失败说明插件版本与服务端不一致，重启 DSH 即可。',
        'settings.openSshConfig': '编辑 SSH 配置',
        'settings.openSshConfigHint': '用本机编辑器打开 ~/.ssh/config。改完点「刷新」，新的 Host 会出现在列表里。',
        'settings.badgeKey': '私钥',
        // 列表的搜索、排序与连接状态（机器一多就要用）。
        'settings.hostFilter': '搜索主机（名字 / 地址 / 用户）',
                'settings.edit': '编辑',
        'settings.delete': '删除',
        'settings.editMachine': '编辑机器',
        'settings.badgeSshConfig': 'ssh cfg',
        // Issue #51 — transport backend (GSSAPI/Kerberos via system OpenSSH).
        'settings.badgeOpenssh': 'openssh',
        'settings.backend': '连接后端',
        'settings.backendNative': 'native（内置 ssh2：密码 / 私钥 / agent / 动态码）',
        'settings.backendOpenssh': 'openssh（调用本机 ssh 命令）',
        'settings.backendOpensshHint': '调用本机 ssh，因此完全遵循 ~/.ssh/config：支持 GSSAPI/Kerberos（kinit 后免密登录）、ProxyCommand、PKCS11Provider、Match 等 OpenSSH 专有特性；主机密钥由 ssh 用你自己的 known_hosts 校验。代价是每条命令都要新建一次连接（比 native 慢），文件浏览（SFTP）仍保持长连接。',
        'settings.backendOpensshAliasOk': '已勾选「使用 ssh_config 别名」：主机名原样交给 ssh，端口/用户/私钥/跳板机一律由 ~/.ssh/config 的 Host 块决定，对应的输入框在 openssh 后端下填了也不生效（这就是「配置唯一来源」，issue #50）。密码/Passphrase 仍会通过 askpass 交给 ssh，仅当 Host 块里没有可用认证时才用得上。',
        'settings.sshBinary': 'ssh 路径',
        'settings.sshBinaryPlaceholder': '留空 = 用 PATH 里的 ssh',
        // Issue #54: the README told users to point `webAttachCommand` at a
        // private-prefix dsh, but the settings UI offered nowhere to type it —
        // it could only be written by the deploy flow or by hand-editing
        // machines.json. It is an ordinary per-machine field now.
        'settings.webAttachCmd': '远端 dsh 命令',
        'settings.webAttachCmdPlaceholder': '留空 = 用全局 webAttachCommand（默认 dsh）',
        'settings.webAttachCmdHint': '远端 dsh 不在 SSH 登录 PATH 时（私有前缀 / nvm 装的 node）填它的绝对路径，例如 /home/you/.nvm/versions/node/v22.19.0/bin/node /home/you/.dsh-remote/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js。留空则用全局的 webAttachCommand。',
        // Issue #125: reuse a resident remote instance instead of always
        // spawning a second one that shares the same DSH_HOME.
        'settings.webAttachDiscover': '常驻实例发现命令',
        'settings.webAttachDiscoverPlaceholder': '留空 = 总是新起一个远端 dsh web',
        'settings.webAttachDiscoverHint': '「连接并打开」前先在远端执行这条命令：stdout 最后一行打出 http://127.0.0.1:<端口>/?token=… 形式的地址 = 复用那个常驻实例（不会再启新的，断开时也不会停它）；没输出 / 失败 / 超时就照旧新起一个。命令按远端的登录 shell 执行，所以 Windows 远端可以直接写 PowerShell，例如 powershell -NoProfile -Command "Get-Content $env:USERPROFILE\\.dsh-web-url -ErrorAction SilentlyContinue"。',
        'settings.sshImport': '从 ~/.ssh/config 导入',
        'settings.useSshConfig': '使用 SSH 别名',
        'settings.useSshConfigHint': '连的时候会按 ~/.ssh/config 里这个 Host 的实际配置去连（用户/端口/私钥/跳板机都从文件读，改文件就生效）；这里留空即可。',
        'settings.saveWritesSshConfig': '保存后也会更新 SSH 配置中的主机记录。随后可直接编辑 SSH 配置。',
        'settings.sshResolvedTo': '→ {user}@{host}:{port}',
        'settings.sshResolvedNone': '~/.ssh/config 中没有匹配「{alias}」的 Host 条目',
        'settings.sshResolvedWarn': '注意：{msg}',
        'settings.sshAliasSaved': '已按别名保存（连接时解析）',
        'settings.name': '名称',
        'settings.host': '主机',
        'settings.port': '端口',
        'settings.user': '用户',
        'settings.password': '密码',
        // 密码框永远是空的（宿主不会把密文/明文回传），所以「有没有存过密码」
        // 只能靠 placeholder 表达：星号 = 已保存。空框 + 中性提示会让人以为
        // 插件把密码弄丢了。
        'settings.passwordPlaceholder': 'SSH 密码（隐藏输入；不用密码可留空）',
        'settings.secretSavedPlaceholder': '••••••••••••（已保存，留空 = 不修改）',
        'settings.secretSavedHint': '已保存密码。留空可保留，输入新密码后保存即可替换。',
        'settings.passphraseSavedHint': '已保存私钥 passphrase ••••••••••••：留空保存 = 沿用，填新值 = 覆盖。',
        'settings.proxyPwdSavedHint': '已保存跳板机密码 ••••••••••••：留空保存 = 沿用，填新值 = 覆盖。',
        'settings.noCredentialHint': '⚠️ 这台机器还没有任何凭据（密码 / 私钥 / agent 都没填），连接会报「缺少凭据」。',
        'settings.testUsedSaved': '（本次测试使用了已保存的密码）',
        'settings.testHint': '用上面的配置测试连接；留空的密码/私钥/passphrase 会自动沿用已保存的值',
        'settings.testNeedsHost': '先填写主机地址才能测试',
        // 灰按钮必须能解释自己：用户「点了没反应」时唯一能拿到的线索就是 hover 提示。
        'settings.saveNeedsHost': '先填写主机地址才能保存',
        'settings.saveHint': '保存这台机器（留空的密码/私钥/passphrase 沿用已保存的值）',
        'settings.fwdNeedsPort': '先填写本地监听端口才能添加转发',
        'settings.fwdAddHint': '添加一条端口转发',
        'settings.advCollapse': '收起高级配置',
        'settings.advExpand': '高级配置：认证与连接选项',
        'settings.privateKey': '私钥路径',
        'settings.passphrase': 'Passphrase',
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
        'settings.testing': '连接中…',
        'settings.testOk': '✓ 连接成功',
        'settings.testConn': '测试连接',
        'settings.saving': '保存中…',
        'settings.save': '保存',
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
        'settings.cleanup': '工作区清理（本地镜像与对话）',
        'settings.cleanupRefresh': '刷新',
        'settings.cleanupEmpty': '没有本地镜像。选定一个远程工作区后它会出现在这里。',
        'settings.cleanupChats': ' 个对话',
        'settings.cleanupLive': '有会话在用',
        'settings.cleanupSessions': '删对话',
        'settings.cleanupSessionsHint': '只删该工作区的全部对话（保留镜像与登记）；被占用的会话会跳过',
        'settings.cleanupRecent': '移出最近',
        'settings.cleanupRecentHint': '把工作区从「最近列表/当前工作区」移出，不删镜像（止住自动重建）',
        'settings.cleanupAll': '彻底删除',
        'settings.cleanupAllHint': '对话 + 登记 + 最近记录 + 本地镜像全部删除（远端目录不动），不可恢复',
        'settings.cleanupConfirmAll': '彻底删除工作区「{path}」？它的全部对话、工作区登记、最近记录和本地镜像都会被删除（远端目录不动）。此操作不可恢复。',
        'settings.cleanupConfirmSessions': '删除工作区「{path}」的全部对话？镜像与登记保留。',
        'settings.cleanupDone': '已删除',
        'settings.cleanupFailed': '操作失败：{msg}',
        'settings.audit': '最近执行的远程命令（审计日志）',
        'settings.auditEmpty': '暂无记录（在远端执行的命令会记录到 $DSH_HOME/remote-workspaces/audit.log）',
        'settings.auditRefresh': '刷新日志',
        'settings.auditOpen': '打开日志文件',
        'settings.auditReveal': '在文件夹中显示',
        'settings.auditOpenHint': '用本机默认程序打开审计日志文件（日志在运行 DSH 的这台机器上）',
        'settings.auditRevealHint': '在本机文件管理器里定位这个日志文件',
        'settings.auditOpened': '已打开：{file}',
        'settings.auditRevealed': '已在文件管理器中定位：{file}',
        'settings.auditOpenFailed': '无法自动打开（{msg}）——可以直接复制上面的路径自己打开。',
        'settings.webAttach': '远程 DSH 界面',
        'settings.webAttachHint': '在本机浏览器里打开远程机器上的 DSH 网页界面。不需要在远端开放任何端口：插件会主动 SSH 连出去，在远端启一个只监听 127.0.0.1 的 dsh web，再把它的端口通过 SSH 隧道搬回本机。',
        'settings.webAttachMachine': '机器',
        'settings.webAttachOpen': '连接并打开',
        'settings.webAttachOpening': '正在连接…',
        'settings.webAttachReopen': '打开',
        'settings.webAttachClose': '断开',
        'settings.webAttachCloseStop': '断开并停止远端',
        'settings.webAttachReconnect': '重连',
        'settings.webAttachDropped': '连接已断开',
        'settings.webAttachNone': '尚未连接任何远程界面',
        'settings.webAttachExisting': '或粘贴远端已在运行的界面地址（http://127.0.0.1:<端口>/?token=…）',
        'settings.webAttachExistingGo': '连接已有实例',
        'settings.webAttachTokenWarn': '地址含登录令牌，仅供本机使用，请勿外发。',
        'settings.webAttachFailed': '连接失败：',
        // Issue #125: the discovery outcome, shown on the attach row.
        'settings.webAttachDiscoveryHit': '复用常驻实例',
        'settings.webAttachDiscoveryMiss': '未发现常驻实例，已新起一个',
        'settings.webAttachDiscoveryTimeout': '发现命令超时，已新起一个',
        'settings.webAttachDiscoveryError': '发现命令执行失败，已新起一个',
        'settings.webAttachDiscoveryProbeFailed': '发现的常驻实例未响应探活，已新起一个',
        'settings.badgePwd': '密码',
        'settings.badgeKeychain': '钥匙串',
        'settings.badgeProxy': '跳板',
        'settings.sectionHide': '收起此栏',
        'settings.sectionShow': '展开此栏',
        'settings.update': '更新',
        'settings.updateChecking': '版本信息加载中…',
        'settings.checking': '检查中…',
        'settings.autoUpdate.idle': '自动更新准备中',
        'settings.autoUpdate.checking': '正在自动检查更新',
        'settings.autoUpdate.downloading': '正在下载并安装更新',
        'settings.autoUpdate.reloading': '正在切换到新版本',
        'settings.autoUpdate.current': '自动检查完成，已是最新版本',
        'settings.autoUpdate.paused': '自动更新已暂停',
        'settings.autoUpdate.unsupported': '开发链接安装不执行自动更新',
        'settings.autoUpdate.restart-required': '新版本已安装，请重启 DSH 并刷新页面',
        'settings.autoUpdate.error': '自动更新失败，将自动重试',
        'settings.nextUpdateCheck': '下次检查 {time}',
        'settings.updateReloadFailed': '版本切换未完成：{reason}。请重启 DSH 并刷新页面。',
        'settings.checkUpdate': '检查更新',
        'settings.updateNow': '立即更新',
        'settings.updateMode': '更新模式：',
        'settings.explorerAutoOpen': '打开远程工作区时，自动在侧边栏展开「远程文件」',
        'settings.updateManual': '手动',
        'settings.updateAuto': '自动',
        'settings.updateOff': '关闭',
        'settings.like': '项目与支持',
        'settings.star': '源代码',
        'settings.feedback': '报告问题',
        'settings.deleted': '已删除',
        'settings.saved': '已保存更新',
        'settings.rebound': '已将 {n} 个本地工作区镜像重新绑定到新地址（内容保留，无需重新同步）',
        'settings.added': '已添加 — 可设为当前',
        'settings.secretStoreFailed': '密码未能写入系统密钥库（{msg}），已按 credentialFallback=plain 回退为明文保存在 machines.json。',
        'settings.secretStoreRefused': '密码未能写入系统密钥库（{msg}），已放弃保存该密码（不会以明文落盘）。修复密钥库后重新保存，或把 credentialFallback 设为 plain 以接受明文回退。',
        'settings.connOk': '连接成功',
        'settings.connOkWith': '连接成功（{user}@{host}，{latency}ms）{shell}',
        'settings.connFail': '连接失败',
        'settings.shellWin': '（Windows · Git Bash）',
        'settings.shellWinNoGit': '（Windows · 未找到 Git Bash）',
        'settings.shellPosix': '（POSIX）',
        'settings.updateFail': '检查更新失败',
        'settings.updateAvailable': '发现新版本 v{version}',
        'settings.updateLatest': '已是最新版本（v{version}）',
        'settings.updateConfirm': '将更新 dsh-remote 到 v{version}，替换本机插件文件并在线热切换宿主半（不重启 Harness）。继续？',
        'settings.updateApplied': '✅ 已更新到 v{to}（{from} → {to}），宿主半已在线热切换。',
'settings.updateAppliedNoReload': '✅ 已更新到 v{to}（{from} → {to}）。重启 Harness 生效。',
'settings.updatePendingReload': '磁盘已是 v{disk}，运行中仍是 v{loaded}。请完全重启 DSH 并刷新页面。',
'settings.selfUpdateBlocked': 'ℹ️ 当前是 link:/开发模式安装（不在 node_modules 下），已禁止自动更新以免覆盖源码——请在你的源码仓库里更新。',
'settings.updateRegistryError': 'npm registry 查询失败：{msg}',
        'settings.updateFailed': '更新失败',
        'settings.updateFailedMsg': '更新失败: {msg}',
        'settings.registryUnreachable': '无法连接 npm registry',
        'settings.updateModeSet': '更新模式已设为「{mode}」',
        'settings.updateModeSaveFail': '模式保存失败: {msg}',
        'settings.deleteConfirm': '确定删除这台机器？',
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
        'picker.suggestionsHint': '输入路径查看目录建议，或点击“浏览…”选择文件夹。',
        'picker.pathPlaceholderWin': '输入远程路径，如 C:\\Users\\…（自动补全）',
        'picker.chooseMachineFirst': '先选远程机器',
        'picker.browse': '浏览…',
        'picker.home': '~ 主目录',
        'picker.setRemoteWs': '设为远程工作区',
        'picker.mirroring': '镜像中…',
        'picker.cancel': '取消',
        'confirm.title': '请确认',
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
        'picker.hintKeys': '↑↓ 选择补全 · Enter 补全/确认 · Esc 返回 · Ctrl/⌘+Enter 打开工作区',
        'picker.star': '⭐ Star dsh-remote',
        'picker.feedback': '反馈 / 提 issue',
        'explorer.refresh': '刷新',
        'explorer.newDir': '新建目录',
        'explorer.more': '…',
        'explorer.remoteWs': '远程工作区: {path}{host}',
        'explorer.hostTag': '  ({user}@{host})',
        'explorer.noRemoteWs': '未设置远程工作区',
        'explorer.sessionLocal': '当前会话未使用远程工作区',
        'explorer.localSession': '当前会话是本地工作区，未使用远程文件。\n\n如需访问远程，可在设置页将某台机器「设为当前」，再用上方「…」选择远程工作区。',
        // issue #49：会话列表里标识「这是远程会话，连的是哪台机」
        'session.remoteBadge': '远程会话：{target}',
        'session.remoteHover': '远程主机：{target}',
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
        'explorer.renameTitle': '重命名',
        'explorer.mkdirTitle': '新建目录',
        'explorer.namePlaceholder': '名称',
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
        'file.dirty': '未保存',
        'file.saveHint': 'Ctrl/⌘+S 保存',
        'file.downloaded': '已下载到本地镜像{local}',
        'file.downloadedAt': ': {path}',
        'file.readFail': '远程读取失败: {msg}',
        'file.listFail': '远程目录读取失败: {msg}',
        // Issue #55: a file link in a remote Session cannot be mapped onto the
        // remote host (no mirror for the Session's cwd), so say so instead of
        // rendering an empty editor.
        // The host MarkdownText renders code blocks / footnotes with chrome
        // strings from its `labels` prop and dereferences them unguarded.
        'file.markdown.copy': '复制',
        'file.markdown.copied': '已复制',
        'file.markdown.code': '代码块',
        'file.markdown.wrap': '自动换行',
        'file.markdown.unwrap': '取消换行',
        'file.markdown.footnotes': '脚注',
        'file.linkUnresolved': '这个文件链接无法对应到远端路径（该会话的工作区不是一个远程镜像目录）。请用侧栏「远程文件」打开，或用 rw_read_file 读取。',
        'common.refresh': '刷新',
        'common.close': '关闭',
        'common.confirm': '确认',
      },
      en: {
        'settings.sshConfigEditorTitle': "SSH configuration",
        'settings.sshConfigEditorHint': "Edit SSH configuration on the host running DSH. Saving rechecks the host list.",
        'settings.sshConfigReload': "Reload from disk",
        'settings.sshConfigReloadHint': "Reload from disk after confirming any unsaved changes",
        'settings.sshConfigSaveHint': "Save configuration (Ctrl/Cmd+S)",
        'settings.sshConfigClean': "No unsaved changes",
        'settings.sshConfigSaved': "SSH configuration saved; host list refreshed.",
        'settings.sshConfigReadFailed': "Could not read SSH configuration: {msg}",
        'settings.sshConfigSaveFailed': "Could not save SSH configuration: {msg}",
        'settings.sshConfigConflict': "SSH configuration changed outside this editor. Your draft is retained; copy your changes before reloading.",
        'settings.discardSshChanges': "Discard unsaved SSH configuration changes?",
        'settings.sshEditorUnavailable': "The running plugin does not support the built-in editor yet. Restart DSH and refresh this page.",
        'settings.runtimeMismatch': "UI v{client} differs from running service v{host} (disk v{disk}). Restart DSH and refresh this page.",

        'agent.exec': 'Remote command',
        'agent.read': 'Read remote file',
        'agent.edit': 'Edit remote file',
        'agent.write': 'Write remote file',
        'agent.search': 'Search remote files',
        'agent.list': 'Browse remote directory',
        'agent.sync': 'Pull remote files',
        'agent.push': 'Push local changes',
        'agent.other': 'Remote operation',
        'agent.preparing': 'Preparing',
        'agent.running': 'Running',
        'agent.completed': 'Completed',
        'agent.failed': 'Failed',
        'agent.stopped': 'Stopped',
        'agent.timeout': 'Timed out',
        'agent.background': 'Running in background',
        'agent.unknown': 'Outcome unknown',
        'agent.diagnostics': 'Compiler diagnostics',
        'agent.diagnosticErrors': '{n} compiler errors',
        'agent.raw': 'Command output',
        'agent.inspect': 'Inspect execution',
        'agent.exit': 'Exit code {code}',
        'agent.duration': '{n} seconds',
        'agent.open': 'Open {path} at line {line}',
        'agent.before': 'Before replacement',
        'agent.after': 'After replacement',
        'agent.truncated': 'Showing the first 100,000 characters. Copy the output or inspect the execution for more.',
        'settings.title': 'Remote workspace (dsh-remote)',
        'settings.probeDetails': 'Show reason',
        'settings.reachable': 'Reachable',
        'settings.unreachable': 'Unavailable',
        'settings.latencyHint': 'Total time for SSH connection and command probe; no workspace is changed',
        'settings.pageTitle': 'Remote workspace',
        'settings.categories': 'Remote workspace settings categories',
        'settings.category.hosts': 'Hosts',
        'settings.category.tools': 'Connection tools',
        'settings.category.preferences': 'Preferences',
        'settings.hostActions': 'More actions for {name}',
        'settings.backHosts': 'Back to hosts',
        'settings.unsaved': 'Unsaved changes',
        'settings.draftRestored': 'Your unsaved host settings have been restored.',
        'settings.discardChanges': 'Discard the unsaved changes to this host?',
        'explorer.emptyFolder': 'This folder is empty',
        'explorer.connection.loading': 'Reading remote directory…',
        'explorer.connection.interrupted': 'Remote access interrupted · File list preserved',
        'explorer.connection.ready': 'Remote directory ready',
        'file.conflictHelp': 'The remote file changed. Your draft is preserved. Copy it, reload the remote version, and merge your edits before saving.',
        'file.copyDraft': 'Copy draft',
        'project.hostKeyHelp': 'Verify the server fingerprint. Resolve trusted host-key changes in host settings before retrying.',
        'project.authHelp': 'Check the SSH credentials or authentication method for this host. Your path is preserved.',
        'project.pathHelp': 'Check that the directory exists and your SSH user can access it, or browse to another folder.',
        'project.networkHelp': 'Check the network and SSH service before opening again. If the response was lost after submission, the workspace may already exist; check your workspace list first.',
        'file.discardConfirm': 'Discard the unsaved draft? Copy it first if you want to keep your changes.',
        'file.discardReload': 'Discard draft and reload remote',
        'sync.unknown': 'Mirror sync · No activity recorded this run',
        'sync.running': 'Syncing mirror…',
        'sync.completed': 'Last mirror sync completed',
        'sync.partial': 'Mirror sync partially completed',
        'sync.conflicts': 'Mirror sync has conflicts',
        'sync.failed': 'Mirror sync failed',
        'sync.pending': 'Local changes pending upload',
        'sync.explain': 'This records actual sync operations, not continuous equality. Use rw_sync to download and rw_push to upload. The file explorer reads the remote host directly.',
        'sync.conflictHelp': 'Conflicting files were not overwritten. Compare and merge the local mirror and remote versions before syncing again.',
        'explorer.cannotResolve': 'Could not resolve this session’s remote workspace. Retry the connection.',
        'project.machineChanged': 'The active host changed while browsing. Select your intended host and try again.',
        'file.incompletePreview': 'This preview is incomplete. Edit the full file in the remote terminal to avoid overwriting unseen content.',
        'workbench.explorer': 'Explorer',
        'workbench.openTerminal': 'Open remote terminal',
        'workbench.terminalUnavailable': 'Remote terminal is unavailable. Check the host terminal plugin and remote ssh shell.',
        'workbench.filter': 'Filter loaded files',
        'workbench.noFilteredFiles': 'No matching loaded files',
        'workbench.collapse': 'Collapse all folders',
        'workbench.remote': 'Remote workspace',
        'workbench.backToFiles': 'Back to explorer',
        'workbench.copyPath': 'Copy remote path',
        'workbench.copyContent': 'Copy file content',
        'workbench.find': 'Find in file',
        'workbench.wrap': 'Word wrap',
        'workbench.previous': 'Previous match',
        'workbench.next': 'Next match',
        'workbench.closeFind': 'Close find',
        'workbench.preview': 'Preview',
        'workbench.source': 'Source',
        'workbench.refreshing': 'Refreshing…',
        'workbench.lines': '{n} lines',
        'workbench.position': 'Ln {line}, Col {col}',
        'workbench.saved': 'Saved to remote',
        'workbench.loadingFile': 'Reading remote file…',
        'workbench.noMatches': 'No matches',
        'workbench.matches': '{current} / {total}',
        'workbench.openFolder': 'Open containing folder',
        'project.search': 'Search projects, hosts or paths…',
        'project.recent': 'Recent projects',
        'project.hosts': 'SSH hosts',
        'project.noMatches': 'No matching projects or hosts. Try another search.',
        'project.noHosts': 'No hosts yet. Configure ~/.ssh/config on the DSH host, then retry.',
        'project.retry': 'Retry',
        'project.addingHost': 'Adding host…',
        'project.configHint': 'Open a recent project directly, or select a host to choose a folder. New hosts come from ~/.ssh/config on the DSH host.',
        'project.back': 'Switch host or project',
        'project.opening': 'Opening remote project…',
        'project.cancel': 'Cancel opening',
        'project.failed': 'Could not open this project. Your path is preserved; check the connection or path and retry.',
        'project.details': 'Diagnostic details',
        'project.cancelled': 'Opening cancelled.',
        'project.folder': 'Choose remote folder',
        'settings.intro': 'Manage SSH hosts and connection settings. Each remote workspace connects independently; multiple hosts can be used in parallel.',
        'settings.noMachines': 'No hosts yet. Add hosts to your SSH configuration, then choose a host and folder when creating a remote workspace.',
        'settings.pickHost': 'Choose a remote machine',
        'settings.hostListSource': 'from ~/.ssh/config',
        'settings.hostListLoading': 'Reading ~/.ssh/config…',
        'settings.hostListRefresh': 'Refresh',
        'settings.hostListRefreshHint': 'Re-read ~/.ssh/config (no need to reopen this page)',
        'settings.hostListEmpty': 'No hosts found in {file}. Add Host blocks, then hit Refresh.',
        'settings.hostListFailed': 'Could not read it: {msg}. This is NOT a problem with your ssh config (the file was never read) — hit Refresh; if it keeps failing the plugin versions are out of sync, so restart DSH.',
        'settings.openSshConfig': 'Edit SSH config',
        'settings.openSshConfigHint': 'Open ~/.ssh/config in your editor. Hit Refresh afterwards and the new Host shows up here.',
        'settings.badgeKey': 'key',
        'settings.hostFilter': 'Search hosts (name / address / user)',
                'settings.edit': 'Edit',
        'settings.delete': 'Delete',
        'settings.editMachine': 'Edit machine',
        'settings.badgeSshConfig': 'ssh cfg',
        // Issue #51 — transport backend (GSSAPI/Kerberos via system OpenSSH).
        'settings.badgeOpenssh': 'openssh',
        'settings.backend': 'Backend',
        'settings.backendNative': 'native (built-in ssh2: password / key / agent / OTP)',
        'settings.backendOpenssh': 'openssh (drive the local ssh command)',
        'settings.backendOpensshHint': 'Delegates the transport to the local `ssh`, so the whole of ~/.ssh/config applies: GSSAPI/Kerberos (log in once with kinit and no secret is needed), ProxyCommand, PKCS11Provider, Match blocks… Host keys are checked by ssh against your own known_hosts. The cost is a fresh connection per command (slower than native); file browsing over SFTP still reuses one session.',
        'settings.backendOpensshAliasOk': '"Use a ~/.ssh/config alias" is on: the name is handed to ssh verbatim, and Port/User/IdentityFile/ProxyJump come from that Host block — the matching fields below have no effect (this is the "one source of truth" case, issue #50). A password/passphrase is still offered to ssh through askpass, and is only used if the Host block has no usable authentication.',
        'settings.sshBinary': 'ssh path',
        'settings.sshBinaryPlaceholder': 'Empty = the ssh on PATH',
        // Issue #54: the README documented `webAttachCommand` but the settings
        // UI had no field for it.
        'settings.webAttachCmd': 'Remote dsh command',
        'settings.webAttachCmdPlaceholder': 'Empty = the global webAttachCommand (default: dsh)',
        'settings.webAttachCmdHint': 'Set the absolute path when the remote dsh is not on the SSH login PATH (a private prefix, or node installed with nvm), e.g. /home/you/.nvm/versions/node/v22.19.0/bin/node /home/you/.dsh-remote/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js. Empty falls back to the global webAttachCommand.',
        // Issue #125: reuse a resident remote instance instead of always
        // spawning a second one that shares the same DSH_HOME.
        'settings.webAttachDiscover': 'Discover command',
        'settings.webAttachDiscoverPlaceholder': 'Empty = always start a new remote dsh web',
        'settings.webAttachDiscoverHint': 'Before "Connect & open", run this on the remote first: when its LAST stdout line prints an address like http://127.0.0.1:<port>/?token=…, the running instance is reused (no second process, and disconnect never stops it); on no output / failure / timeout a fresh one is started as before. The command runs in the remote login shell, so a Windows remote can use PowerShell directly, e.g. powershell -NoProfile -Command "Get-Content $env:USERPROFILE\\.dsh-web-url -ErrorAction SilentlyContinue".',
        'settings.sshImport': 'Import from ~/.ssh/config',
        'settings.useSshConfig': 'Use SSH alias',
        'settings.useSshConfigHint': 'Connecting follows that Host block in ~/.ssh/config (user / port / key / jump host are read from the file, so editing it takes effect). Leave the other fields empty.',
        'settings.saveWritesSshConfig': 'Saving also updates this host in your SSH configuration. Later edits to that file take precedence.',
        'settings.sshResolvedTo': '→ {user}@{host}:{port}',
        'settings.sshResolvedNone': 'no ~/.ssh/config block matches "{alias}"',
        'settings.sshResolvedWarn': 'Heads-up: {msg}',
        'settings.sshAliasSaved': 'Saved as an alias (resolved on connect)',
        'settings.name': 'Name',
        'settings.host': 'Host',
        'settings.port': 'Port',
        'settings.user': 'User',
        'settings.password': 'Password',
        'settings.passwordPlaceholder': 'SSH password (hidden; leave blank if unused)',
        'settings.secretSavedPlaceholder': '•••••••••••• (saved — leave blank to keep)',
        'settings.secretSavedHint': 'A password is saved. Leave this empty to keep it, or enter and save a new one to replace it.',
        'settings.passphraseSavedHint': 'A private-key passphrase is saved (••••••••••••): leave the box empty to keep it, type a new value to replace it.',
        'settings.proxyPwdSavedHint': 'A jump-host password is saved (••••••••••••): leave the box empty to keep it, type a new value to replace it.',
        'settings.noCredentialHint': '⚠️ This machine has no credential yet (no password, private key or agent) — connecting will fail with "no credentials".',
        'settings.testUsedSaved': '(this test used the saved password)',
        'settings.testHint': 'Probe with the values above; a blank password/key/passphrase falls back to the saved one',
        'settings.testNeedsHost': 'Fill in the host before testing',
        'settings.saveNeedsHost': 'Fill in the host before saving',
        'settings.saveHint': 'Save this machine (a blank password/key/passphrase keeps the saved one)',
        'settings.fwdNeedsPort': 'Fill in the local listen port before adding a forward',
        'settings.fwdAddHint': 'Add a port forward',
        'settings.advCollapse': 'Hide advanced options',
        'settings.advExpand': 'Advanced authentication and connection options',
        'settings.privateKey': 'Private key path',
        'settings.passphrase': 'Passphrase',
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
        'settings.testing': 'Connecting…',
        'settings.testOk': '✓ Connected',
        'settings.testConn': 'Test connection',
        'settings.saving': 'Saving…',
        'settings.save': 'Save',
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
        'settings.cleanup': 'Workspace cleanup (local mirrors & chats)',
        'settings.cleanupRefresh': 'Refresh',
        'settings.cleanupEmpty': 'No local mirrors yet. Pick a remote workspace and it shows up here.',
        'settings.cleanupChats': ' chats',
        'settings.cleanupLive': 'in use',
        'settings.cleanupSessions': 'Delete chats',
        'settings.cleanupSessionsHint': 'Delete only this workspace\'s chats (mirror and registration stay); occupied sessions are skipped',
        'settings.cleanupRecent': 'Forget',
        'settings.cleanupRecentHint': 'Remove the workspace from the recent/current lists without deleting the mirror (stops auto-recreation)',
        'settings.cleanupAll': 'Delete forever',
        'settings.cleanupAllHint': 'Chats + registration + recent entry + the local mirror all go (the REMOTE directory is untouched). Irreversible',
        'settings.cleanupConfirmAll': 'Permanently delete workspace "{path}"? All its chats, the registration, the recent entry and the local mirror are removed (the remote directory stays). This cannot be undone.',
        'settings.cleanupConfirmSessions': 'Delete all chats of workspace "{path}"? The mirror and registration stay.',
        'settings.cleanupDone': 'Deleted',
        'settings.cleanupFailed': 'Failed: {msg}',
        'settings.audit': 'Recent remote commands (audit log)',
        'settings.auditEmpty': 'No records yet (commands run remotely are logged to $DSH_HOME/remote-workspaces/audit.log)',
        'settings.auditRefresh': 'Refresh log',
        'settings.auditOpen': 'Open log file',
        'settings.auditReveal': 'Show in folder',
        'settings.auditOpenHint': 'Open the audit log with the host machine default application (the log lives on the machine running DSH)',
        'settings.auditRevealHint': 'Reveal this log file in the host file manager',
        'settings.auditOpened': 'Opened: {file}',
        'settings.auditRevealed': 'Revealed in the file manager: {file}',
        'settings.auditOpenFailed': 'Could not open it automatically ({msg}) — copy the path above and open it yourself.',
        'settings.webAttach': 'Remote DSH Web UI',
        'settings.webAttachHint': 'Open the DSH web interface of a remote machine in this browser. The remote never opens an inbound port: this plugin SSHes out, starts a loopback-only dsh web there, and carries its port back over the SSH connection.',
        'settings.webAttachMachine': 'Machine',
        'settings.webAttachOpen': 'Connect & open',
        'settings.webAttachOpening': 'Connecting…',
        'settings.webAttachReopen': 'Open',
        'settings.webAttachClose': 'Disconnect',
        'settings.webAttachCloseStop': 'Disconnect & stop remote',
        'settings.webAttachReconnect': 'Reconnect',
        'settings.webAttachDropped': 'Disconnected',
        'settings.webAttachNone': 'No remote UI attached',
        'settings.webAttachExisting': 'Or paste the URL of an interface already running there (http://127.0.0.1:<port>/?token=…)',
        'settings.webAttachExistingGo': 'Attach to running instance',
        'settings.webAttachTokenWarn': 'The URL carries a login token. It is for this machine only — do not share it.',
        'settings.webAttachFailed': 'Could not attach: ',
        // Issue #125: the discovery outcome, shown on the attach row.
        'settings.webAttachDiscoveryHit': 'resident instance reused',
        'settings.webAttachDiscoveryMiss': 'no resident instance found — started a new one',
        'settings.webAttachDiscoveryTimeout': 'discover command timed out — started a new one',
        'settings.webAttachDiscoveryError': 'discover command failed — started a new one',
        'settings.webAttachDiscoveryProbeFailed': 'the found instance did not answer a probe — started a new one',
        'settings.badgePwd': 'password',
        'settings.badgeKeychain': 'keychain',
        'settings.badgeProxy': 'jump',
        'settings.sectionHide': 'Collapse section',
        'settings.sectionShow': 'Expand section',
        'settings.update': 'Update',
        'settings.updateChecking': 'Loading version info…',
        'settings.checking': 'Checking…',
        'settings.autoUpdate.idle': 'Automatic updates are getting ready',
        'settings.autoUpdate.checking': 'Checking for updates automatically',
        'settings.autoUpdate.downloading': 'Downloading and installing the update',
        'settings.autoUpdate.reloading': 'Switching to the new version',
        'settings.autoUpdate.current': 'Automatic check complete; up to date',
        'settings.autoUpdate.paused': 'Automatic updates are paused',
        'settings.autoUpdate.unsupported': 'Linked development installs do not update automatically',
        'settings.autoUpdate.restart-required': 'Update installed; restart DSH and refresh this page',
        'settings.autoUpdate.error': 'Automatic update failed; retry scheduled',
        'settings.nextUpdateCheck': 'Next check {time}',
        'settings.updateReloadFailed': 'Version switch did not complete: {reason}. Restart DSH and refresh this page.',
        'settings.checkUpdate': 'Check for updates',
        'settings.updateNow': 'Update now',
        'settings.updateMode': 'Update mode:',
        'settings.explorerAutoOpen': 'Auto-open the Remote Files sidebar tab for remote workspaces',

        'settings.updateManual': 'Manual',
        'settings.updateAuto': 'Auto',
        'settings.updateOff': 'Off',
        'settings.like': 'Project & support',
        'settings.star': 'Source code',
        'settings.feedback': 'Report an issue',
        'settings.deleted': 'Deleted',
        'settings.saved': 'Saved',
        'settings.rebound': 'Rebound {n} local workspace mirror(s) to the new address (content kept — no re-sync needed)',
        'settings.added': 'Added — you can set it as current',
        'settings.secretStoreFailed': 'The OS keychain refused the password ({msg}); credentialFallback=plain wrote it to machines.json in plaintext.',
        'settings.secretStoreRefused': 'The OS keychain refused the password ({msg}); the password was NOT saved (it will not be written to disk in plaintext). Repair the keychain and save again, or set credentialFallback to plain to accept the plaintext fallback.',
        'settings.connOk': 'Connection successful',
        'settings.connOkWith': 'Connection successful ({user}@{host}, {latency}ms){shell}',
        'settings.connFail': 'Connection failed',
        'settings.shellWin': ' (Windows · Git Bash)',
        'settings.shellWinNoGit': ' (Windows · no Git Bash found)',
        'settings.shellPosix': ' (POSIX)',
        'settings.updateFail': 'Failed to check for updates',
        'settings.updateAvailable': 'New version found: v{version}',
        'settings.updateLatest': 'Already up to date (v{version})',
        'settings.updateConfirm': 'Update dsh-remote to v{version}? This replaces the local plugin files and hot-swaps the host half in place (no Harness restart). Continue?',
        'settings.updateApplied': '✅ Updated to v{to} ({from} → {to}); the host half hot-swapped in place.',
'settings.updateAppliedNoReload': '✅ Updated to v{to} ({from} → {to}). Restart Harness to apply.',
'settings.updatePendingReload': 'v{disk} is on disk; v{loaded} is still running. Restart DSH and refresh this page.',
'settings.selfUpdateBlocked': 'ℹ️ This is a link:/dev install (not under node_modules), so self-update is disabled to avoid overwriting source — update it from its source repo.',
        'settings.updateRegistryError': 'npm registry query failed: {msg}',
        'settings.updateFailed': 'Update failed',
        'settings.updateFailedMsg': 'Update failed: {msg}',
        'settings.registryUnreachable': 'Cannot reach the npm registry',
        'settings.updateModeSet': 'Update mode set to "{mode}"',
        'settings.updateModeSaveFail': 'Failed to save mode: {msg}',
        'settings.deleteConfirm': 'Delete this machine?',
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
        'picker.suggestionsHint': 'Type a path for suggestions, or browse to choose a folder.',
        'picker.pathPlaceholderWin': 'Enter remote path, e.g. C:\\Users\\… (auto-complete)',
        'picker.chooseMachineFirst': 'Choose a remote machine first',
        'picker.browse': 'Browse…',
        'picker.home': '~ Home',
        'picker.setRemoteWs': 'Set as remote workspace',
        'picker.mirroring': 'Mirroring…',
        'picker.cancel': 'Cancel',
        'confirm.title': 'Please confirm',
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
        'picker.hintKeys': '↑↓ select · Enter completes/confirms · Esc goes back · Ctrl/⌘+Enter opens workspace',
        'picker.star': '⭐ Star dsh-remote',
        'picker.feedback': 'Feedback / report issue',
        'explorer.refresh': 'Refresh',
        'explorer.newDir': 'New directory',
        'explorer.more': '…',
        'explorer.remoteWs': 'Remote workspace: {path}{host}',
        'explorer.hostTag': '  ({user}@{host})',
        'explorer.noRemoteWs': 'No remote workspace set',
        'explorer.sessionLocal': 'This session does not use a remote workspace',
        'explorer.localSession': 'This session is a local workspace and does not use remote files.\n\nTo access remote, set a machine as "current" in Settings, then pick a remote workspace with the "…" button above.',
        // issue #49: tell a remote Session apart in the Session list, and name its host.
        'session.remoteBadge': 'Remote session: {target}',
        'session.remoteHover': 'Remote host: {target}',
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
        'explorer.renameTitle': 'Rename',
        'explorer.mkdirTitle': 'New directory',
        'explorer.namePlaceholder': 'Name',
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
        'file.dirty': 'unsaved',
        'file.saveHint': 'Ctrl/⌘+S to save',
        'file.downloaded': 'Downloaded to local mirror{local}',
        'file.downloadedAt': ': {path}',
        'file.readFail': 'Failed to read remote: {msg}',
        'file.listFail': 'Failed to list remote directory: {msg}',
        'file.markdown.copy': 'Copy',
        'file.markdown.copied': 'Copied',
        'file.markdown.code': 'Code block',
        'file.markdown.wrap': 'Wrap lines',
        'file.markdown.unwrap': 'Unwrap lines',
        'file.markdown.footnotes': 'Footnotes',
        'file.linkUnresolved': 'This file link does not map onto a remote path (the Session workspace is not a remote mirror directory). Open it from the sidebar "Remote Files" tab, or read it with rw_read_file.',
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

    // The official Electron shell serves the shared API over its private
    // dsh-app carrier. Legacy browser hosts keep their existing route prefix.
    // Choose before sending: never retry a mutating request on another route.
    function apiPath(path) {
      return window.location && window.location.protocol === 'dsh-app:'
        ? '/api' + path : path
    }

    function sessionQuery(sessionId) {
      return sessionId ? 'sessionId=' + encodeURIComponent(sessionId) : ''
    }
    function withSessionQuery(path, sessionId) {
      const q = sessionQuery(sessionId)
      if (!q) return path
      return path + (path.includes('?') ? '&' : '?') + q
    }
    function withSessionBody(body, sessionId) {
      if (!sessionId) return body
      return Object.assign({}, body || {}, { sessionId })
    }

    async function api(method, path, body, signal) {
      const opts = { method, headers: {}, ...(signal ? { signal } : {}) }
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(apiPath(path), opts)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(trHostError((data && (data.error || data.message))) || 'HTTP ' + res.status)
      return data
    }

    // Like api() but returns {status, data} so callers can handle 409 etc.
    async function apiRaw(method, path, body) {
      const opts = { method, headers: {} }
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(apiPath(path), opts)
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
      // Text ON a --dsw-alias-button-primary-fill surface must use the *label*
      // token, which is the pairing the harness's own primary button uses
      // (._primary{background:button-primary-fill;color:label-primary-foreground}).
      // --dsw-alias-button-contrast-fill is a FILL token (the harness uses it as a
      // `background`), so it is NOT the light-on-dark colour: in the light theme it
      // is #61666b (gray on #0f1115 = 3.3:1, and 1.6:1 once :disabled fades it),
      // and in the dark theme it collapses to #f9fafb on a #f9fafb fill (invisible).
      onPrimary: v('--dsw-alias-label-primary-foreground', '#fff'),
      // Hover tints are a neutral translucent gray rather than a theme token:
      // the harness's own interactive-bg-hover is a 6% tint that disappears on
      // the settings surface, while a gray overlay darkens light themes and
      // lightens dark ones.
      hoverBg: 'rgba(128,128,128,0.14)',
    }
    const inputS = { flex: 1, padding: '6px 10px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, outline: 'none' }
    const buttonS = { padding: '6px 12px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, cursor: 'pointer' }
    const primaryBtnS = { padding: '6px 12px', borderRadius: T.radius, border: 'none', background: T.primary, color: T.onPrimary, cursor: 'pointer', fontWeight: 600 }
    const box = { border: '1px solid ' + T.border, borderRadius: 10, background: T.bg, padding: 12 }
    const boxS = box
    const LABEL_W = 108
    const CHROME_CSS_ID = 'dsh-remote-chrome'
    const CHROME_CSS_TEXT = [
          '[data-rw-settings-legacy-icon]{position:relative}[data-rw-settings-legacy-icon]>svg{opacity:0}[data-rw-settings-legacy-icon]::before{content:"";position:absolute;left:12px;top:50%;transform:translateY(-50%);width:16px;height:16px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M3%204h18v12H3zM8%2020h8M12%2016v4M7%208l3%202-3%202M13%2012h4%22%2F%3E%3C%2Fsvg%3E") center/contain no-repeat;-webkit-mask:url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.6%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M3%204h18v12H3zM8%2020h8M12%2016v4M7%208l3%202-3%202M13%2012h4%22%2F%3E%3C%2Fsvg%3E") center/contain no-repeat;pointer-events:none}',
          '.dsh-rw-btn{transition:background .12s ease,opacity .12s ease,border-color .12s ease}',
          '.dsh-rw-btn:hover:not(:disabled){background:rgba(128,128,128,.18)}',
          '.dsh-rw-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#2563eb);outline-offset:1px}',
          // A disabled FILLED primary keeps its solid fill. Fading the whole
          // button (opacity) turned the near-black primary fill into a muddy
          // gray and dragged the white label down to ~1.5:1 — the fill is the
          // affordance here, so keep it pure; the cursor carries "disabled".
          '.dsh-rw-btn:disabled{cursor:not-allowed}',
          '.dsh-rw-btn:disabled:not(.dsh-rw-primary){opacity:.45}',
          // A filled primary keeps its own fill on hover; opacity is the only
          // cue that stays visible whether that fill is near-black or near-white.
          '.dsh-rw-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,#2563eb);opacity:.85}',
          '.dsh-rw-input{transition:border-color .12s ease,box-shadow .12s ease}',
          '.dsh-rw-input:focus{border-color:var(--dsw-alias-button-primary-fill,#2563eb)!important;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-button-primary-fill,#2563eb) 28%,transparent)}',
          '.dsh-rw-row{border-radius:8px;margin:0 -6px;padding-left:8px;padding-right:8px;transition:background .12s ease}',
          '.dsh-rw-row:hover{background:rgba(128,128,128,.14)}',
          '.dsh-rw-list-item{transition:background .1s ease}',
          '.dsh-rw-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex-shrink:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#929298);cursor:pointer}',
          '.dsh-rw-action:hover:not(:disabled),.dsh-rw-action[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,#e4e4e7)}',
          '.dsh-rw-action:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#2563eb);outline-offset:-2px}',
          '.dsh-rw-action:disabled{opacity:.4;cursor:default}',
          '.dsh-rw-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10))!important}',
          '.dsh-rw-tree-row[aria-selected=true]{background:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#2563eb) 10%,transparent)!important}',
          '.dsh-rw-tree-row .dsh-rw-row-meta{opacity:0;transition:opacity .1s}',
          '.dsh-rw-tree-row:hover .dsh-rw-row-meta,.dsh-rw-tree-row:focus .dsh-rw-row-meta{opacity:.65}',
          '.dsh-rw-path{font-size:11px;color:var(--dsw-alias-label-tertiary,#929298);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.dsh-rw-file-status{display:flex;gap:12px;align-items:center;flex-wrap:wrap;min-height:26px;padding:3px 12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));font-size:11px;color:var(--dsw-alias-label-tertiary,#929298)}',
          '.dsh-rw-code-wrap [data-line]{white-space:pre-wrap!important;overflow-wrap:anywhere}',
          '.dsh-rw-code-wrap [data-line]>span:last-child{min-width:0}',
          '.dsh-rw-code-hit{background:color-mix(in srgb,var(--dsw-static-yellow-500,#e6c07b) 16%,transparent)}',
          '.dsh-rw-code-current{background:color-mix(in srgb,var(--dsw-alias-button-primary-fill,#2563eb) 18%,transparent)}',

          '.dsh-rw-agent-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:8px;overflow:hidden;margin:5px 0;min-width:0}',
          '.dsh-rw-agent-header{display:flex;align-items:center;gap:7px;width:100%;min-width:0;padding:8px 10px;border:0;background:transparent;color:inherit;cursor:pointer;text-align:left;font:inherit;font-size:12px}',
          '.dsh-rw-agent-header:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}',
          '.dsh-rw-agent-header:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#2563eb);outline-offset:-2px}',
          '.dsh-rw-agent-summary{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
          '.dsh-rw-agent-output{margin:0;padding:10px 12px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;tab-size:2}',
          '.dsh-rw-agent-diagnostic{display:block;max-width:100%;border:0;background:transparent;color:inherit;text-align:left;font:inherit;font-size:12px;line-height:1.5;padding:5px 0;cursor:pointer;overflow-wrap:anywhere}',
          '.dsh-rw-agent-diagnostic:hover{text-decoration:underline}',
          '.dsh-rw-tree-chevron{display:inline-flex;align-items:center;justify-content:center;width:14px;flex-shrink:0;color:var(--dsw-alias-label-tertiary,#929298)}',

          '[data-rw-tree-row]:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#2563eb);outline-offset:-2px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}',
          '.dsh-rw-list-item:hover{background:rgba(128,128,128,.18)}',
          // The line a chat link jumped to flashes once (issue #104).
          '@keyframes dshRwLineFlash{0%{background:var(--dsw-alias-state-warning-secondary,rgba(255,213,79,.40))}100%{background:transparent}}',
          '.dsh-rw-line-flash{animation:dshRwLineFlash 1.6s ease-out}',
          '.dsh-rw-tabs{display:inline-flex;padding:3px;gap:2px;border-radius:10px;background:rgba(128,128,128,.14);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))}',
          '.dsh-rw-tab{border:none!important;background:transparent!important}',
          '.dsh-rw-tab.is-active{background:var(--dsw-alias-button-primary-fill,#2563eb)!important;color:var(--dsw-alias-label-primary-foreground,#fff)!important;font-weight:600}',
          '.dsh-rw-pill{display:inline-flex;align-items:center;font-size:11px;line-height:1.3;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));opacity:.9;white-space:nowrap}',
          '.dsh-rw-pill.is-ok{color:var(--dsw-static-green-500,#4caf7d);border-color:currentColor}',

          '.dsh-rw-settings{padding:22px 24px;display:flex;flex-direction:column;gap:16px;min-width:0;max-width:860px;box-sizing:border-box}',
          '.dsh-rw-settings-tabs{display:flex;gap:20px;position:sticky;top:0;z-index:4;background:var(--dsw-alias-background-primary,#fff);border-bottom:1px solid var(--dsw-alias-border-primary,#ddd);padding-top:6px}',
          '.dsh-rw-settings-tabs [role=tab]{background:none;border:0;border-bottom:2px solid transparent;padding:8px 0 12px;cursor:pointer;font:inherit;font-size:12px;color:inherit;opacity:.6;white-space:nowrap}',
          '.dsh-rw-settings-tabs [aria-selected=true]{opacity:1;border-bottom-color:currentColor;font-weight:600}',
          '.dsh-rw-settings-tabs button:focus-visible,.dsh-rw-settings-menu summary:focus-visible{outline:2px solid currentColor;outline-offset:3px}',
          '.dsh-rw-settings-panel{flex-direction:column;gap:16px;min-width:0}',
          '.dsh-rw-settings-card{min-width:0}',
          '.dsh-rw-settings-hosts{border:0!important;padding:0!important}',
          '.dsh-rw-settings-hosts .dsh-rw-row{margin:0;padding:12px 8px!important;border-radius:5px}',
          '.dsh-rw-settings-hosts .dsh-rw-row code{font-size:11px!important;line-height:1.7;color:inherit;opacity:.55}',
          '.dsh-rw-settings-host-actions{display:flex;gap:6px;align-items:center;flex-shrink:0}',
          '.dsh-rw-settings-host-row{display:grid!important;grid-template-columns:minmax(0,1fr) 152px;column-gap:16px!important;align-items:start!important}',
          '.dsh-rw-settings-host-row>div:first-child{min-width:0!important}',
          '.dsh-rw-settings-identity{display:flex;flex-direction:column;align-items:flex-start;gap:3px;min-width:0}',
          '.dsh-rw-settings-identity>div:first-child,.dsh-rw-settings-identity>span:first-child{font-size:13px;font-weight:600;line-height:20px}',
          '.dsh-rw-settings-identity>code{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:18px}',
          '.dsh-rw-settings-host-flags:empty{display:none}.dsh-rw-settings-host-flags{display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-height:16px}',
          '.dsh-rw-settings-host-actions{display:grid!important;grid-template-columns:116px 28px;gap:8px;width:152px;align-items:center;padding-top:3px}',
          '.dsh-rw-settings-probe{font-size:12px;line-height:28px;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}',
          '.dsh-rw-settings-menu-spacer{width:28px;height:30px}',
          '.dsh-rw-settings-editor-heading{flex-direction:column;align-items:flex-start!important;gap:12px!important}',
          '.dsh-rw-settings-editor-heading>div>strong{font-size:16px;line-height:24px;font-weight:600}',
          '.dsh-rw-settings-check{display:flex;align-items:center;gap:8px;font-size:12px;min-height:28px;line-height:1.6;cursor:pointer}',
          '.dsh-rw-settings-check input{margin:0;flex-shrink:0}',
          '.dsh-rw-settings-field-note{margin:-6px 0 16px 120px;font-size:11px;line-height:1.65}',
          '@media(max-width:600px){.dsh-rw-settings-field.is-toggle{display:block}.dsh-rw-settings-field.is-toggle>span{display:none}.dsh-rw-settings-field-note{margin-left:0}.dsh-rw-settings-host-row{column-gap:12px!important}}',
          '.dsh-rw-settings-menu{position:relative}',
          '.dsh-rw-settings-menu summary{display:flex;align-items:center;justify-content:center;list-style:none;width:28px;height:30px;border-radius:5px;cursor:pointer;opacity:.65}',
          '.dsh-rw-settings-menu summary::-webkit-details-marker{display:none}',
          '.dsh-rw-settings-menu[open] summary,.dsh-rw-settings-menu summary:hover{background:rgba(128,128,128,.12);opacity:1}',
          '.dsh-rw-settings-menu-items{position:absolute;right:0;top:34px;z-index:6;min-width:142px;padding:5px;display:flex;flex-direction:column;gap:2px;border:1px solid;border-radius:8px;box-shadow:0 8px 24px #0002}',
          '.dsh-rw-settings-menu-items button{border:0!important;text-align:left;background:transparent!important;padding:8px 10px!important}',
          '.dsh-rw-settings-menu-items button:hover{background:rgba(128,128,128,.1)!important}',
          '.dsh-rw-settings .dsh-rw-pill{border-color:transparent!important;background:rgba(128,128,128,.07);color:inherit!important;font-size:10px}',
          '.dsh-rw-settings-advanced{display:flex;gap:6px;align-items:center;border:0!important;background:transparent!important;text-align:left;padding:8px 0!important}',
          '.dsh-rw-settings-editor{border:0!important;padding:0!important}',
          '.dsh-rw-settings-editor-heading{display:flex;gap:12px;align-items:center;padding:0 0 4px}',
          '.dsh-rw-settings-editor-heading>button{display:flex;gap:4px;align-items:center;border:0!important;padding:4px 0!important;font-size:11px;opacity:.7}',
          '.dsh-rw-settings-editor-actions{position:sticky;top:47px;z-index:3;display:flex;justify-content:flex-end;gap:8px;padding:10px 0 14px;border-bottom:1px solid;margin-bottom:16px}',
          '.dsh-rw-settings-field{display:grid;grid-template-columns:108px minmax(0,1fr);gap:12px;align-items:center;margin-bottom:14px}',
          '.dsh-rw-settings-field input:not([type=checkbox]),.dsh-rw-settings-field select{min-width:0;max-width:100%;box-sizing:border-box}',
          '.dsh-rw-settings-field input[type=checkbox]{justify-self:start}',
          '.dsh-rw-settings-message{padding:9px 12px;border-radius:6px;background:rgba(128,128,128,.06);overflow-wrap:anywhere}',
          '.dsh-rw-settings-section-heading{flex-wrap:wrap}.dsh-rw-settings-section-heading>.dsh-rw-section-btn{flex:1;min-width:150px;width:auto;line-height:1.6}.dsh-rw-settings-section-heading>.dsh-rw-btn{white-space:nowrap;flex-shrink:0}',
          '@media(max-width:600px){[data-shortcut-modal=settings]:has([data-rw-settings]){display:flex!important;flex-direction:column!important;overflow:hidden!important}[data-shortcut-modal=settings]:has([data-rw-settings])>nav{flex:0 0 auto!important;width:100%!important;max-width:none!important;padding:16px 16px 0!important;box-sizing:border-box}[data-shortcut-modal=settings]:has([data-rw-settings])>nav>div:first-child{padding:0!important;margin:0 0 10px!important;min-height:32px}[data-shortcut-modal=settings]:has([data-rw-settings])>nav>div:last-child{display:flex!important;flex-direction:row!important;overflow-x:auto!important;gap:4px;padding-bottom:8px}[data-shortcut-modal=settings]:has([data-rw-settings]) nav button{flex:0 0 auto!important;white-space:nowrap;padding:8px 10px!important}[data-shortcut-modal=settings]:has([data-rw-settings])>nav+div{flex:1!important;min-width:0!important;min-height:0!important;width:100%!important;overflow:auto}[data-shortcut-modal=settings]:has([data-rw-settings])>nav+div>div:first-child{position:absolute!important;top:16px;right:16px;padding:0!important;min-height:30px;z-index:1}[data-shortcut-modal=settings]:has([data-rw-settings])>nav+div>div:last-child{padding:0 16px 16px!important;min-width:0!important}[data-rw-settings]{box-sizing:border-box}.dsh-rw-settings{padding:16px 0!important}}',
          '@media(max-width:600px){.dsh-rw-settings-section-heading>.dsh-rw-section-btn{flex-basis:100%}}',
          '@media(max-width:600px){.dsh-rw-settings{padding:16px;gap:14px}.dsh-rw-settings-tabs{gap:18px}.dsh-rw-settings-field{grid-template-columns:1fr;gap:5px}.dsh-rw-settings-editor [style*="margin-left"]{margin-left:0!important}.dsh-rw-settings-editor [style*="padding-left"]{padding-left:0!important}.dsh-rw-settings-editor-actions{flex-wrap:wrap;top:47px}.dsh-rw-settings-panel>div{min-width:0}.dsh-rw-settings-panel [style*="min-width: 260px"]{min-width:0!important}}',
          '.dsh-rw-section-btn{width:100%;text-align:left;display:flex;align-items:center;gap:8px;background:transparent;border:none;cursor:pointer;padding:0;color:inherit}',
          '@keyframes dsh-rw-in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}',
          '.dsh-rw-modal-panel{animation:dsh-rw-in .14s ease-out}',
        ].join('')
    function ensureChromeCss() {
      try {
        if (typeof document === 'undefined' || !document.head || typeof document.getElementById !== 'function') return
        const existing = document.getElementById(CHROME_CSS_ID)
        const el = existing || document.createElement('style')
        // A hot upgrade keeps document.head. Refresh the legacy node in place,
        // and avoid rewriting the sheet on unchanged component mounts.
        if (el.textContent !== CHROME_CSS_TEXT) el.textContent = CHROME_CSS_TEXT
        if (!existing) { el.id = CHROME_CSS_ID; document.head.appendChild(el) }
      } catch { /* vm tests / no DOM */ }
    }
    /**
     * Issue #52 — a backdrop may close its dialog only when the PRESS began on
     * the backdrop itself.
     *
     * `click` is dispatched on the nearest common ancestor of the mousedown and
     * mouseup targets. A gesture that pressed an element INSIDE the panel and
     * released on the backdrop — because the panel re-laid-out mid-gesture (the
     * remote autocomplete list used to sit in document flow, so expanding it
     * pushed a centred panel's edges out from under the pointer) — is therefore
     * reported as a click ON THE BACKDROP, and a bare `onClick` closed the whole
     * dialog. Selecting a suggestion kicked the user out of the picker.
     *
     * Guarding on the press origin keeps "click outside to dismiss" while a
     * drag that merely ENDS outside can no longer dismiss anything. The panel's
     * own `stopPropagation` stays as a second line of defence.
     *
     * @returns {{onMouseDown: Function, onClick: (e: object) => boolean}} props to
     *   spread on the backdrop; `onClick` reports whether the press started there.
     */
    function useBackdropGuard() {
      const pressedOnBackdrop = React.useRef(false)
      return {
        onMouseDown: (e) => { pressedOnBackdrop.current = e.target === e.currentTarget },
        onClick: (e) => {
          const startedOnBackdrop = pressedOnBackdrop.current
          pressedOnBackdrop.current = false
          return startedOnBackdrop && e.target === e.currentTarget
        },
      }
    }

    function PromptDialog(props) {
      const { title, initial, placeholder, onSubmit, onCancel } = props
      const backdrop = useBackdropGuard()
      const [val, setVal] = React.useState(initial || '')
      const submit = () => { const t = val.trim(); if (t) onSubmit(t) }
      React.useEffect(() => {
        try {
          if (typeof document === 'undefined') return
          const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); onCancel() }
            if (e.key === 'Enter') { e.preventDefault(); submit() }
          }
          document.addEventListener('keydown', onKey)
          return () => document.removeEventListener('keydown', onKey)
        } catch { return undefined }
      }, [val, onSubmit, onCancel])
      // Host Modal when available: portal + focus trap + autofocus + restore +
      // IME-composition guard come from its useModalLayer; our document-level
      // Escape/Enter stays as the fallback path's key handling (harmless
      // duplication: Modal's layer preventDefaults first).
      if (Modal) {
        return React.createElement(Modal, {
          open: true,
          onClose: onCancel,
          title,
          closeLabel: tr('picker.close'),
          onKeyDownCapture: (e) => {
            if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit() }
          },
        },
          React.createElement('input', { autoFocus: true, 'data-modal-autofocus': true, value: val, onChange: (e) => setVal(e.target.value), placeholder: placeholder || '', className: 'dsh-rw-input', style: inputS }),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 } },
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: onCancel }, tr('file.cancel')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: submit, disabled: !val.trim() }, tr('common.confirm')),
          ),
        )
      }
      return React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 1000000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
        onMouseDown: backdrop.onMouseDown,
        // Issue #52: only a press that STARTED here may dismiss (a gesture that
        // began inside the panel and ended on the backdrop must not).
        onClick: (e) => { if (backdrop.onClick(e)) onCancel() },
      },
        React.createElement('div', {
          className: 'dsh-rw-modal-panel',
          style: { background: v('--dsw-alias-bg-overlay', '#1e1e1e'), border: '1px solid ' + T.borderStrong, borderRadius: 10, padding: 14, width: 'min(420px, 92vw)', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.4)' },
          onClick: (e) => e.stopPropagation(),
        },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: T.label } }, title),
          React.createElement('input', { autoFocus: true, value: val, onChange: (e) => setVal(e.target.value), placeholder: placeholder || '', className: 'dsh-rw-input', style: inputS }),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: onCancel }, tr('file.cancel')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => { const t = val.trim(); if (t) onSubmit(t) }, disabled: !val.trim() }, tr('common.confirm')),
          ),
        ),
      )
    }

    /**
     * Themed confirm dialog. Uses the host Modal when the build ships one
     * (always portaled, focus trap, autofocus, focus restore, Escape, IME
     * guard); otherwise our own press-guarded portalized overlay. Either way it
     * replaces `window.confirm`, which is visually alien and may be suppressed
     * by embedders. Safe for Mask adoption here because the content never
     * re-lays-out mid-gesture (no autocomplete list — that is why the DIRECTORY
     * picker keeps its custom guarded overlay).
     */
    function ConfirmDialog(props) {
      const { message, onAnswer } = props
      const cancelBtn = React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => onAnswer(false) }, tr('file.cancel'))
      const okBtn = React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, 'data-modal-autofocus': true, onClick: () => onAnswer(true) }, tr('common.confirm'))
      if (Modal) {
        return React.createElement(Modal, {
          open: true,
          onClose: () => onAnswer(false),
          title: tr('confirm.title'),
          closeLabel: tr('picker.close'),
        },
          React.createElement('div', { style: { fontSize: 13, color: T.label, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: 'min(460px, 86vw)' } }, message),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 } }, cancelBtn, okBtn),
        )
      }
      const backdrop = useBackdropGuard()
      return portalize(React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 1000001, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
        onMouseDown: backdrop.onMouseDown,
        onClick: (e) => { if (backdrop.onClick(e)) onAnswer(false) },
      },
        React.createElement('div', { style: { background: v('--dsw-alias-bg-layer-1', '#18181b'), color: T.label, border: '1px solid ' + T.borderStrong, borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,0.5)', padding: 16, maxWidth: 'min(460px, 86vw)' }, onClick: (e) => e.stopPropagation() },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, tr('confirm.title')),
          React.createElement('div', { style: { fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, message),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 } }, cancelBtn, okBtn),
        ),
      ))
    }

    /** Promise-style confirm: `if (!(await confirm.ask(msg))) return`. Render
     * `confirm.node` anywhere in the component's tree. */
    function useConfirm() {
      const [req, setReq] = React.useState(null)
      const ask = React.useCallback((message) => new Promise((resolve) => setReq({ message, resolve })), [])
      const node = req
        ? React.createElement(ConfirmDialog, {
          message: req.message,
          onAnswer: (ok) => { setReq(null); req.resolve(ok) },
        })
        : null
      return { ask, node }
    }

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
    // Audit lines arrive with a leading UTC ISO stamp (the on-disk format stays
    // UTC — sortable and machine-comparable across timezones). Render it in the
    // user's LOCAL timezone like the file browser's mtime (fmtTime above), so
    // "when did that command run" needs no mental +N conversion. Seconds are
    // kept: command ordering inside a minute matters for audit reading.
    // Unparseable lines render unchanged (issue #124).
    function fmtAuditLine(line) {
      return String(line).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/, (iso) => {
        const d = new Date(iso)
        if (isNaN(d.getTime())) return iso
        const pad = (x) => String(x).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      })
    }

    // Write text to the clipboard. Order: the host primitive (its behavior is
    // the reference), then the async Clipboard API (works on http://127.0.0.1
    // secure contexts), then the legacy execCommand('copy') path.
    function copyToClipboard(text) {
      if (writeClipboardFn) {
        try { return Promise.resolve(writeClipboardFn(String(text))).then(() => true).catch(() => false) } catch { /* fall through to the manual paths */ }
      }
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

    let SESSIONS = null // optional sessions service, tracked by ctx.inject in apply()
    let WEB_TERMINALS = null
    let SIDEBAR_RIGHT = null // optional native right-column controller (ctx.sidebarRight)
    // Which world currently owns the remote-explorer presentation: set by the
    // guide-card handshake in registerNativeSidebar (better-sidebar arrival
    // moves the card there; its departure brings it back).
    let explorerOwnedByBs = false
    // Sessions whose native explorer tab we already auto-opened. Per-session,
    // never persisted: a user who closed the tab keeps it closed for the
    // session, but tomorrow's visit opens it again (same rule as the
    // better-sidebar world's autoOpenedFor).
    const autoOpenedNative = new Set()

    // ── Settings → 远程工作区 (machine registry + forwards + audit) ──────────
    let settingsEditorDraft = null
    let settingsSshDraft = null
    let nativeSettingsIcon = false
    // DSH 0.2.1 does not declare the icon seat. Keep React's nav structure
    // intact and apply a scoped visual fallback to this plugin's label only.
    function legacySettingsIcon() {
      if (typeof document === 'undefined' || typeof MutationObserver !== 'function' || !document.body || typeof document.querySelectorAll !== 'function') return
      const marked = new Set()
      const sync = () => {
        if (nativeSettingsIcon) { for (const button of marked) button.removeAttribute('data-rw-settings-legacy-icon'); marked.clear(); return }
        for (const button of document.querySelectorAll('[role="dialog"] nav button')) {
          if (button.textContent.trim() !== tr('settings.pageTitle') || !button.querySelector('svg')) continue
          button.setAttribute('data-rw-settings-legacy-icon', 'true'); marked.add(button)
        }
      }
      const observer = new MutationObserver(sync)
      observer.observe(document.body, { childList: true, subtree: true }); sync()
      return () => { observer.disconnect(); for (const button of marked) button.removeAttribute('data-rw-settings-legacy-icon') }
    }
    function discoveredProbeTargets(hosts, machines) {
      return (hosts || []).filter(host => !machines.some(machine => machine.useSshConfig && machine.host === String(host.alias || host.host))).map(host => ({ key: 'ssh:' + String(host.alias || host.host), body: { host: String(host.alias || host.host), port: Number(host.port) || 22, username: host.user || '', useSshConfig: true }, fingerprint: host }))
    }
    function RemoteWorkspacePage() {
      const settingsId = React.useId()
      const [settingsTab, setSettingsTab] = React.useState('hosts')
      const [settingsMenu, setSettingsMenu] = React.useState(null)
      const [sshEditor, setSshEditor] = React.useState(() => settingsSshDraft)
      const [sshEditorBusy, setSshEditorBusy] = React.useState(false)
      const sshEditorDirty = !!sshEditor && sshEditor.text !== sshEditor.baseline
      React.useEffect(() => { settingsSshDraft = sshEditorDirty ? sshEditor : null }, [sshEditor, sshEditorDirty])
      React.useEffect(() => { if (sshEditor) document.getElementById(settingsId + '-ssh-text')?.focus?.() }, [!!sshEditor])
      const settingsLabels = { hosts: 'settings.category.hosts', tools: 'settings.category.tools', preferences: 'settings.category.preferences' }
      const formBaseline = React.useRef(settingsEditorDraft?.baseline || null)
      const probeRevision = React.useRef(0)
      const [machines, setMachines] = React.useState([])
      const [hostsLoaded, setHostsLoaded] = React.useState(false)
      const [form, setForm] = React.useState(() => settingsEditorDraft?.form || {
        name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '',
        passphrase: '', workspace: '', hostKeyMode: '', useAgent: false, keyboardInteractive: false,
        encryptPassword: false, proxyHost: '', proxyPort: '22', proxyUser: '', proxyPassword: '', proxyKey: '', id: '',
        // Issue #38: alias mode — `host` is a ~/.ssh/config Host name and the
        // resolved values are never copied into the registry.
        useSshConfig: false,
        // Secrets never come back from the host (it strips them), so the form
        // tracks only WHETHER one is saved: the boxes then show
        // "••••••••（已保存）" instead of looking empty, which is the difference
        // between "the plugin remembered my password" and "the plugin lost it".
        passwordSet: false, passphraseSet: false, proxyPasswordSet: false,
      })
      React.useEffect(() => { if (form.id) document.getElementById(settingsId + '-field-n')?.focus?.() }, [form.id])
      const formDirty = !!form.id && formBaseline.current !== null && JSON.stringify(form) !== formBaseline.current
      React.useEffect(() => {
        settingsEditorDraft = formDirty ? { form, baseline: formBaseline.current } : null
      }, [form, formDirty])
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState(() => settingsEditorDraft ? tr('settings.draftRestored') : '')
      const [err, setErr] = React.useState('')
      const [tst, setTst] = React.useState('') // idle | testing | ok | failing
      const [forwards, setForwards] = React.useState([])
      const [fwdForm, setFwdForm] = React.useState({ listenPort: '', targetHost: '127.0.0.1', targetPort: '', direction: 'local', autoStart: false })
      const [auditLines, setAuditLines] = React.useState([])
      // The audit LOG FILE on the host machine: its path plus the outcome of the last
      // 打开/显示 attempt. The browser cannot open a file that lives on the host, so
      // the host opens it and reports how it went.
      const [auditFile, setAuditFile] = React.useState('')
      const [auditMsg, setAuditMsg] = React.useState('')
      const [advOpen, setAdvOpen] = React.useState(false) // 高级配置折叠
      // Collapsed by default: the forwards panel sits BELOW the host list and used to
      // push the update/audit cards far down the page for a feature most sessions
      // never touch.
      const [fwdOpen, setFwdOpen] = React.useState(false)
      const [auditOpen, setAuditOpen] = React.useState(false)
      // Issue #96: workspace cleanup on Web/Desktop (the TUI's machine-menu
      // cleanup page has an in-process API; here it is these two routes).
      const [cleanupOpen, setCleanupOpen] = React.useState(false)
      const [cleanupRows, setCleanupRows] = React.useState([])
      const [cleanupBusy, setCleanupBusy] = React.useState('')
      const [cleanupMsg, setCleanupMsg] = React.useState('')
      const loadCleanup = () => api('GET', '/dsh-remote/workspace-mirrors')
        .then((r) => { if (r && r.ok) setCleanupRows(r.mirrors || []) })
        .catch(() => {})
      // Opening the section loads the list: a wrapped setter, not an effect —
      // the effect would refire on every cleanupOpen-keyed re-render.
      const openCleanupSection = (v) => { setCleanupOpen(v); if (v) loadCleanup() }
      const cleanupAct = async (row, mode) => {
        const label = row.remotePath || row.localMirror
        if (mode === 'all' && !(await confirmUi.ask(tr('settings.cleanupConfirmAll', { path: label })))) return
        if (mode === 'sessions' && !(await confirmUi.ask(tr('settings.cleanupConfirmSessions', { path: label })))) return
        setCleanupBusy(row.localMirror + ':' + mode)
        setCleanupMsg('')
        try {
          const r = await api('POST', '/dsh-remote/workspace-cleanup', { localMirror: row.localMirror, mode })
          if (r && r.ok) { setCleanupMsg(tr('settings.cleanupDone')); await loadCleanup() }
          else setCleanupMsg(tr('settings.cleanupFailed', { msg: (r && r.error) || 'unknown' }))
        } catch (e) {
          // api() throws with the host's user-facing message (incl. WORKSPACE_BUSY).
          setCleanupMsg(tr('settings.cleanupFailed', { msg: String((e && e.message) || e) }))
        }
        setCleanupBusy('')
      }
      // Issue #46: attach a REMOTE machine's DSH Web UI as a local page. One
      // session per machine; `webAttach` holds the machineId currently opening.
      const [webAttaches, setWebAttaches] = React.useState([])
      const [webAttachMachine, setWebAttachMachine] = React.useState('')
      const [webAttachOpen, setWebAttachOpen] = React.useState(false)
      const [webAttachBusy, setWebAttachBusy] = React.useState('')
      const [webAttachErr, setWebAttachErr] = React.useState('')
      const [webAttachExisting, setWebAttachExisting] = React.useState('')
      // Hosts from SSH configuration and their independent connectivity checks.
      const [sshHosts, setSshHosts] = React.useState(null) // null = not loaded yet
      const [sshFile, setSshFile] = React.useState('')
      const [sshError, setSshError] = React.useState('')
      const [rowState, setRowState] = React.useState({}) // key → { ok, text }
      const [hostFilter, setHostFilter] = React.useState('')
      React.useEffect(() => { ensureChromeCss() }, [])

      /** Load the ~/.ssh/config host list (cheap: the host reads a local file).
       *
       * A FAILED request must not look like "your ~/.ssh/config has no hosts": the
       * old catch swallowed it and set an empty list, so a 401/500 (or a host half
       * that predates this route) rendered 没在 … 里找到主机 — sending the user to
       * edit a file that was perfectly fine. The failure is surfaced instead. */
      const loadSshHosts = () => {
        setSshError('')
        return api('GET', '/dsh-remote/ssh-config')
          .then((r) => {
            setSshHosts(Array.isArray(r && r.entries) ? r.entries : [])
            setSshFile(String((r && r.file) || ''))
          })
          .catch((e) => {
            setSshHosts([])
            setSshError(String((e && e.message) || e || 'unknown error'))
          })
      }
      React.useEffect(() => { loadSshHosts() }, [])

      // Edit the host's fixed SSH config inside settings. OS launch success is
      // not evidence that an editor appeared on the browser user's computer.
      const openSshConfig = async () => {
        if (sshEditorBusy) return
        if (sshEditorDirty && !(await confirmUi.ask(tr('settings.discardSshChanges')))) return
        setSshEditorBusy(true); setErr(''); setMsg('')
        try {
          const result = await api('POST', '/dsh-remote/ssh-config', { action: 'read' })
          if (!result?.ok || typeof result.text !== 'string' || !result.revision) throw new Error(tr('settings.sshEditorUnavailable'))
          setSshEditor({ file: result.file, text: result.text, baseline: result.text, revision: result.revision })
        } catch (error) { setErr(tr('settings.sshConfigReadFailed', { msg: /action must.*open.*reveal/i.test(String(error.message || error)) ? tr('settings.sshEditorUnavailable') : String(error.message || error) })) }
        finally { setSshEditorBusy(false) }
      }
      const closeSshConfig = async () => {
        if (sshEditorBusy || sshEditorDirty && !(await confirmUi.ask(tr('settings.discardSshChanges')))) return
        settingsSshDraft = null; setSshEditor(null); setErr(''); setMsg('')
      }
      const saveSshConfig = async () => {
        if (!sshEditor || !sshEditorDirty || sshEditorBusy) return
        setSshEditorBusy(true); setErr(''); setMsg('')
        try {
          const { status, data } = await apiRaw('POST', '/dsh-remote/ssh-config', { action: 'save', text: sshEditor.text, revision: sshEditor.revision })
          if (status === 409) { setErr(tr('settings.sshConfigConflict')); return }
          if (status >= 400 || !data?.ok || typeof data.text !== 'string' || !data.revision) throw new Error(data?.error || tr('settings.sshEditorUnavailable'))
          settingsSshDraft = null
          setSshEditor({ file: data.file, text: data.text, baseline: data.text, revision: data.revision })
          setMsg(tr('settings.sshConfigSaved'))
          refreshHosts()
        } catch (error) { setErr(tr('settings.sshConfigSaveFailed', { msg: String(error.message || error) })) }
        finally { setSshEditorBusy(false) }
      }

      const setRow = (key, next) => setRowState((prev) => ({ ...prev, [key]: next }))

      const testConn = () => {
        if (!form.host.trim() || tst === 'testing') return
        const revision = ++probeRevision.current
        setTst('testing'); setErr(''); setMsg('')
        api('POST', '/dsh-remote/test-connect', {
          // `id` lets the host resolve THIS machine's saved credential: the form
          // cannot send the password back (the host strips secrets), so without
          // it "编辑一台连得上的机器 → 测试连接" always failed with
          // 「缺少凭据」 even though connecting worked.
          id: form.id || undefined,
          host: form.host, port: Number(form.port) || 22, username: form.username || 'root',
          password: form.password, privateKeyPath: form.privateKeyPath, passphrase: form.passphrase,
          useSshConfig: !!form.useSshConfig,
          // Auth METHOD flags: a probe that ignores them tests a different
          // authentication than the machine will use.
          useAgent: !!form.useAgent,
          keyboardInteractive: !!form.keyboardInteractive,
          hostKeyMode: form.hostKeyMode || undefined,
          sshBinary: form.sshBinary || undefined,
          // Issue #51: the probe must exercise the SAME backend the machine will
          // use — a host reachable only via GSSAPI fails the native probe.
          backend: form.backend || 'native',
          proxy: form.proxyHost ? { host: form.proxyHost, port: Number(form.proxyPort) || 22, username: form.proxyUser || '', password: form.proxyPassword || '', privateKeyPath: form.proxyKey || '' } : undefined,
        })
          .then((r) => {
            if (revision !== probeRevision.current) return
            if (r && r.ok) {
              const shellTag = r.platform === 'windows' ? (r.gitBash ? tr('settings.shellWin') : tr('settings.shellWinNoGit')) : (r.platform === 'posix' ? tr('settings.shellPosix') : '')
              setTst('ok'); setMsg(r.latencyMs != null ? tr('settings.connOkWith', { user: r.user, host: r.host, latency: r.latencyMs, shell: shellTag }) : tr('settings.connOk'))
              // Say WHEN the probe used the saved credential: an empty password
              // box next to "连接成功" is otherwise indistinguishable from magic.
              if (r.usedSavedCredential) setMsg((m) => m + ' ' + tr('settings.testUsedSaved'))
              // Issue #38: show where an alias resolved to (and what could not
              // be honoured), instead of leaving the user guessing.
              if (r.alias) {
                setMsg((m) => m + ' ' + tr('settings.sshResolvedTo', { user: r.alias.user || '?', host: r.alias.host, port: r.alias.port }))
                if (r.alias.warnings && r.alias.warnings.length) setErr(tr('settings.sshResolvedWarn', { msg: r.alias.warnings.join(' ') }))
              }
              refresh()
            }
            else { setTst('failing'); setErr((r && r.error) || tr('settings.connFail')) }
          })
          .catch((e) => { if (revision !== probeRevision.current) return; setTst('failing'); setErr(String((e && e.message) || e)) })
      }

      const refresh = () => api('GET', '/dsh-remote/machines').then((r) => {
        setMachines(r.machines || []); setHostsLoaded(true)
      })
      React.useEffect(() => { refresh().catch(error => setErr(String(error.message || error))) }, [])

      // Issue #73 follow-up: the settings page must notice changes made ELSEWHERE —
      // an agent calling rw_connect, or another tab switching machines — without the
      // user reloading. A light poll of the registry (a local JSON read) plus a
      // refresh on window focus; the ssh-config list is re-read on focus only, since
      // that one touches the filesystem.
      React.useEffect(() => {
        const poll = () => { refresh().catch(() => {}) }
        const timer = setInterval(poll, 5000)
        const onFocus = () => { poll(); loadSshHosts() }
        try { window.addEventListener('focus', onFocus) } catch { /* headless host */ }
        return () => {
          clearInterval(timer)
          try { window.removeEventListener('focus', onFocus) } catch { /* headless host */ }
        }
      }, [])

      // ── update state ────────────────────────────────────────────────────────
      const [upd, setUpd] = React.useState(null) // { current, latest, updateAvailable, updateMode, updatedMarker }
      const [updBusy, setUpdBusy] = React.useState(false)
      const [updMsg, setUpdMsg] = React.useState('')
      // Mirrors the host default (DEFAULT_UPDATE_MODE = 'auto') so the panel
      // does not flash "manual" before the first /update-check answers.
      const [updMode, setUpdMode] = React.useState('auto')
      // Render the local fallback immediately, then reconcile the shared host
      // value. The auto-open paths await the SAME promise, so a slow false never
      // arrives after an eager openTab.
      const [explorerAuto, setExplorerAuto] = React.useState(() => explorerAutoOpenEnabled())
      React.useEffect(() => {
        let cancelled = false
        explorerAutoOpenPreference().then((on) => { if (!cancelled) setExplorerAuto(on) })
        return () => { cancelled = true }
      }, [])
      // One applier per toggle, shared by the native-checkbox fallback (event
      // semantics) and the host Switch (bare-boolean callback), so both paths
      // behave identically.
      const applyExplorerAutoOpen = (on) => {
        setExplorerAuto(on)
        void updateExplorerAutoOpenPreference(on)
      }
      const checkUpdate = (quiet) => {
        if (updBusy) return
        setUpdBusy(true); setUpdMsg('')
        api('GET', '/dsh-remote/update-check')
          .then((r) => {
            if (!r) { setUpdMsg(tr('settings.updateFail')); return }
            // 即使 registry 查不到（限流/离线/超时），也先用本地状态填充面板，
            // 否则 latest 永远为 null，界面会一直停在「版本信息加载中…」——
            // 看起来像卡死，而本地版本/更新模式其实都是已知的。
            if (r.ok) { setUpd(r); if (r.updateMode) setUpdMode(r.updateMode) }
            if (r.registryError) {
              // 把真实原因说出来：限流是"稍后自动恢复"，与"网络坏了"处置不同。
              setUpdMsg(tr('settings.updateRegistryError', { msg: r.registryError }))
              return
            }
            if (!r.ok) { setUpdMsg(r.error || tr('settings.updateFail')); return }
            if (!quiet) setUpdMsg(r.updateAvailable ? tr('settings.updateAvailable', { version: r.latest }) : tr('settings.updateLatest', { version: r.current }))
          })
          .catch((e) => setUpdMsg(String((e && e.message) || e)))
          .finally(() => setUpdBusy(false))
      }
      const confirmUi = useConfirm()
      const applyUpdateNow = async () => {
        if (!upd || !upd.latest) return
        if (!(await confirmUi.ask(tr('settings.updateConfirm', { version: upd.latest })))) return
        setUpdBusy(true); setUpdMsg('')
        api('POST', '/dsh-remote/update-apply', { version: upd.latest })
          .then((r) => {
            if (r && r.ok) setUpdMsg(tr(r.reloadScheduled ? 'settings.updateApplied' : 'settings.updateAppliedNoReload', { to: r.to, from: (r.from || '') }))
            else setUpdMsg((r && r.error) || tr('settings.updateFailed'))
            // The host half swaps itself ~300ms after answering, so the panel
            // must not re-check immediately: it would still be talking to the
            // outgoing fiber and report the pre-swap version, i.e. "update
            // available" right after a successful update.
            window.setTimeout(() => checkUpdate(true), 2000)
          })
          .catch((e) => setUpdMsg(tr('settings.updateFailedMsg', { msg: String((e && e.message) || e) })))
          .finally(() => setUpdBusy(false))
      }
      const saveUpdateMode = (mode) => {
        setUpdMode(mode); setUpdMsg(tr('settings.updateModeSet', { mode: mode === 'auto' ? tr('settings.modeAuto') : mode === 'off' ? tr('settings.modeOff') : tr('settings.modeManual') }))
        api('POST', '/dsh-remote/update-mode', { mode }).then((r) => {
          if (!r || !r.ok) throw new Error(r?.error || tr('settings.updateFail'))
        }).catch((e) => { setUpdMode(upd?.updateMode || 'auto'); setUpdMsg(tr('settings.updateModeSaveFail', { msg: String((e && e.message) || e) })) })
      }
      React.useEffect(() => { checkUpdate(true) }, [])
      React.useEffect(() => {
        let disposed = false, pending = false
        const timer = setInterval(() => {
          if (pending) return
          pending = true
          api('GET', '/dsh-remote/update-check?statusOnly=1').then((r) => {
            if (!disposed && r?.ok) { setUpd((old) => ({ ...old, ...r })); setUpdMode(r.updateMode) }
          }).catch(() => {}).finally(() => { pending = false })
        }, 3000)
        return () => { disposed = true; clearInterval(timer) }
      }, [])

      const refreshForwards = () => api('GET', '/dsh-remote/forwards').then((r) => setForwards(r.forwards || [])).catch(() => {})
      React.useEffect(() => { refreshForwards(); api('GET', '/dsh-remote/audit?limit=30').then((r) => setAuditLines(r.lines || [])).catch(() => {}) }, [])

      // ── 远程 DSH 界面（issue #46）─────────────────────────────────────────
      // The remote never opens an inbound port; we SSH out and carry the remote
      // loopback web UI back to a local port. One tunnel per machine.
      //
      // Poll the live tunnels so a reopened window re-attaches to them.
      const refreshWebAttaches = () => api('GET', '/dsh-remote/web-attach')
        .then((r) => { setWebAttaches(r.attaches || []) })
        .catch(() => {})
        .catch(() => {})
      React.useEffect(() => {
        refreshWebAttaches()
        const t = setInterval(() => {
          refreshWebAttaches()
        }, 15000)
        return () => clearInterval(t)
      }, [])
      const webAttachAction = (action, machineId, extra) => {
        setWebAttachBusy(machineId + ':' + action); setWebAttachErr('')
        return api('POST', '/dsh-remote/web-attach', { action, machineId, ...(extra || {}) })
          .then((r) => { refreshWebAttaches(); return r })
          .catch((e) => { setWebAttachErr(String((e && e.message) || e)); return null })
          .then((r) => { setWebAttachBusy(''); return r })
      }

      const setF = (k) => (ev) => { probeRevision.current++; setTst(''); setForm({ ...form, [k]: ev.target.value }) }
      const setFb = (k) => (ev) => { probeRevision.current++; setTst(''); setForm({ ...form, [k]: ev.target.checked }) }
      // Issue #125: attach rows relay WHY a tunnel is a fresh spawn (or that it
      // reuses the resident instance). Declared as a table so the i18n dead-key
      // guard sees each status string referenced.
      const WEB_ATTACH_DISCOVERY_KEYS = {
        hit: 'settings.webAttachDiscoveryHit',
        miss: 'settings.webAttachDiscoveryMiss',
        timeout: 'settings.webAttachDiscoveryTimeout',
        error: 'settings.webAttachDiscoveryError',
        'probe-failed': 'settings.webAttachDiscoveryProbeFailed',
      }
      const beginEdit = (m) => {
        probeRevision.current++; setTst(''); setErr(''); setMsg(''); setSettingsTab('hosts')
        const next = {
          name: m.name, host: m.host, port: String(m.port || 22), username: m.username || 'root',
          password: '', privateKeyPath: m.privateKeyPath || '', passphrase: '', workspace: m.workspace || '',
          hostKeyMode: m.hostKeyMode || '', useAgent: !!m.useAgent, keyboardInteractive: !!m.keyboardInteractive,
          encryptPassword: !!(m.credentialBackend && m.credentialBackend !== 'plain'),
          proxyHost: (m.proxy && m.proxy.host) || '', proxyPort: String((m.proxy && m.proxy.port) || 22),
          proxyUser: (m.proxy && m.proxy.username) || '', proxyPassword: '', proxyKey: (m.proxy && m.proxy.privateKeyPath) || '',
          // Issue #51: the transport backend is per machine.
          backend: m.backend === 'openssh' ? 'openssh' : 'native', sshBinary: m.sshBinary || '',
          // Issue #54: the per-machine remote-dsh command for Web UI attach.
          webAttachCommand: m.webAttachCommand || '',
          // Issue #125: its resident-instance discover sibling.
          webAttachDiscoverCommand: m.webAttachDiscoverCommand || '',
          id: m.id,
          useSshConfig: !!m.useSshConfig,
          // "which secrets are already saved" — the boxes stay empty on purpose,
          // their placeholders show the dots.
          passwordSet: !!m.passwordSet,
          passphraseSet: !!m.passphraseSet,
          proxyPasswordSet: !!(m.proxy && m.proxy.passwordSet),
        }
        formBaseline.current = JSON.stringify(next)
        setForm(next)
        // 编辑时若该机器用了高级配置(私钥/agent/跳板/钥匙串/系统 OpenSSH 后端),自动展开折叠区
        setAdvOpen(!!(m.privateKeyPath || m.useAgent || m.keyboardInteractive || (m.proxy && m.proxy.host) || m.backend === 'openssh' || m.webAttachCommand || m.webAttachDiscoverCommand || (m.credentialBackend && m.credentialBackend !== 'plain')))
      }
      const startEdit = (machine) => {
        if (busy) return
        if (formDirty) { confirmUi.ask(tr('settings.discardChanges')).then(ok => { if (ok) beginEdit(machine) }); return }
        beginEdit(machine)
      }
      const closeEditor = async () => {
        if (busy || formDirty && !(await confirmUi.ask(tr('settings.discardChanges')))) return
        probeRevision.current++; settingsEditorDraft = null; formBaseline.current = null
        const focusId = settingsId + '-actions-' + form.id
        clearForm(); setErr(''); setMsg(''); setTst(''); setAdvOpen(false)
        window.setTimeout(() => document.getElementById(focusId)?.focus?.(), 0)
      }
      const clearForm = () => setForm({ name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '', passphrase: '', workspace: '', hostKeyMode: '', useAgent: false, keyboardInteractive: false, encryptPassword: false, proxyHost: '', proxyPort: '22', proxyUser: '', proxyPassword: '', proxyKey: '', backend: 'native', sshBinary: '', webAttachCommand: '', webAttachDiscoverCommand: '', id: '', useSshConfig: false, passwordSet: false, passphraseSet: false, proxyPasswordSet: false })
      const save = (action) => {
        if (busy) return
        probeRevision.current++
        setBusy(true); setErr(''); setMsg('')
        if (action === 'delete') {
          api('POST', '/dsh-remote/machines', { action: 'delete', id: form.id }).then(refresh).then(() => { clearForm(); setMsg(tr('settings.deleted')) }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false))
          return
        }
        api('POST', '/dsh-remote/machines', {
          action: form.id ? 'update' : 'add', id: form.id || undefined, name: form.name, host: form.host, port: Number(form.port) || 22,
          username: form.username, password: form.password, privateKeyPath: form.privateKeyPath, passphrase: form.passphrase,
          workspace: form.workspace, hostKeyMode: form.hostKeyMode, useAgent: form.useAgent, keyboardInteractive: form.keyboardInteractive,
          encryptPassword: form.encryptPassword, useSshConfig: !!form.useSshConfig,
          // Issue #51: the transport backend (and, for `openssh`, the executable).
          backend: form.backend || 'native', sshBinary: form.sshBinary || '',
          // Issue #54: the per-machine remote-dsh command for Web UI attach.
          webAttachCommand: form.webAttachCommand || '',
          // Issue #125: the per-machine resident-instance discover command.
          webAttachDiscoverCommand: form.webAttachDiscoverCommand || '',
          // `proxy: null` (NOT `undefined`) when the jump-host field is empty:
          // JSON.stringify drops undefined keys, so `undefined` reads as "not
          // mentioned" and the host would KEEP a stored jump host — the field
          // could never be cleared. `null` states "this machine has no jump host".
          proxy: form.proxyHost ? { host: form.proxyHost, port: Number(form.proxyPort) || 22, username: form.proxyUser || '', password: form.proxyPassword || '', privateKeyPath: form.proxyKey || '' } : null,
        }).then((r) => {
          refresh()
          // Keep the form BOUND to the machine that was just saved instead of
          // wiping it. The old code called clearForm(), which emptied `host` —
          // and the 测试连接 button requires a host, so "保存后想立刻验证" was
          // impossible: the button went dead the moment the save succeeded. The
          // secret inputs are cleared (the host strips them anyway) while the
          // *_Set flags tell the placeholders a credential is stored.
          const rec = r && r.machine
          if (rec && rec.id) {
            setForm((f) => {
              const next = { ...f,
              id: rec.id,
              password: '', passphrase: '', proxyPassword: '',
              passwordSet: !!rec.passwordSet,
              passphraseSet: !!rec.passphraseSet,
              proxyPasswordSet: !!(rec.proxy && rec.proxy.passwordSet),
              encryptPassword: !!(rec.credentialBackend && rec.credentialBackend !== 'plain'),
              }
              formBaseline.current = JSON.stringify(next)
              settingsEditorDraft = null
              return next
            })
            setTst('')
          } else {
            clearForm()
          }
          // Issue #30: "加密保存密码"失败时服务端回退明文并带警告 —— 不能再静默
          // 保存一台没有凭据的机器（那会让之后每次连接都失败且没有原因）。
          if (r && r.warning === 'secret-store-failed') setErr(tr('settings.secretStoreFailed', { msg: r.warningDetail || 'unknown' }))
          else if (r && r.warning === 'secret-store-refused') setErr(tr('settings.secretStoreRefused', { msg: r.warningDetail || 'unknown' }))
          // Issue #67: an edited address rebinds the machine's existing mirrors —
          // say so, or the user cannot tell their workspaces came along.
          else if (r && r.reboundMirrors) setMsg(tr('settings.saved') + ' — ' + tr('settings.rebound', { n: r.reboundMirrors }))
          else setMsg(form.id ? tr('settings.saved') : tr('settings.added'))
          setProbeGeneration(value => value + 1)
        }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false))
      }
      const del = async (id) => { if (!(await confirmUi.ask(tr('settings.deleteConfirm')))) return; api('POST', '/dsh-remote/machines', { action: 'delete', id }).then(refresh).then(() => setMsg(tr('settings.deleted'))).catch((e) => setErr(String((e && e.message) || e))) }

      // A settings probe is read-only with respect to workspace and target selection.
      // Every visible host is tested once on entry/config changes; at most three
      // probes run together. Leaving the page cancels queued work and stale results.
      const [probeGeneration, setProbeGeneration] = React.useState(0)
      const probeTargets = [
        ...discoveredProbeTargets(sshHosts, machines),
        ...machines.map(machine => ({ key: 'machine:' + machine.id, body: { id: machine.id, host: machine.host, port: machine.port, username: machine.username, useSshConfig: !!machine.useSshConfig }, fingerprint: machine })),
      ]
      probeTargets.sort((a, b) => a.key.localeCompare(b.key))
      const probeSignature = JSON.stringify(probeTargets.map(target => ({ ...target, fingerprint: target.fingerprint && { ...target.fingerprint, connected: undefined, lastConnectedAt: undefined, latencyMs: undefined, recentWorkspaces: undefined, workspace: undefined } })))
      React.useEffect(() => {
        if (!hostsLoaded || sshHosts === null) return
        const controller = new AbortController()
        const queue = probeTargets.slice()
        setRowState(Object.fromEntries(queue.map(target => [target.key, { pending: true }])))
        async function worker() {
          while (queue.length && !controller.signal.aborted) {
            const target = queue.shift()
            try {
              const result = await api('POST', '/dsh-remote/test-connect', { ...target.body, connectTimeoutMs: 5000 }, controller.signal)
              if (!controller.signal.aborted) setRow(target.key, { ok: !!result?.ok, latencyMs: result?.latencyMs, text: result?.ok ? '' : result?.error || tr('settings.connFail') })
            } catch (error) {
              if (!controller.signal.aborted) setRow(target.key, { ok: false, text: String(error.message || error) })
            }
          }
        }
        Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()))
        return () => controller.abort()
      }, [probeSignature, probeGeneration, hostsLoaded, sshHosts === null])
      const refreshHosts = () => { setProbeGeneration(value => value + 1); refresh().catch(error => setErr(String(error.message || error))); loadSshHosts() }

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

      const fieldNote = text => React.createElement('div', { className: 'dsh-rw-settings-field-note', style: { color: T.muted } }, text)
      const row = (label, ctrl, k) => {
        const id = ctrl.props.id || settingsId + '-field-' + k
        if (ctrl.props.type === 'checkbox') return React.createElement('div', { key: k, className: 'dsh-rw-settings-field is-toggle' }, React.createElement('span', { 'aria-hidden': true }), React.createElement('label', { htmlFor: id, className: 'dsh-rw-settings-check' }, React.cloneElement(ctrl, { id }), label))
        return React.createElement('div', { key: k, className: 'dsh-rw-settings-field' },
          React.createElement('label', { htmlFor: id, style: { fontSize: 12, color: T.muted } }, label),
          React.cloneElement(ctrl, { id }))
      }
      const pill = (cls, text) => React.createElement('span', { className: 'dsh-rw-pill' + (cls ? ' ' + cls : ''), style: { marginLeft: 4 } }, text)
      const sectionToggle = (open, setOpen, title, extra) => React.createElement('div', { className: 'dsh-rw-settings-section-heading', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: open ? 8 : 0 } },
        React.createElement('button', {
          type: 'button', className: 'dsh-rw-section-btn',
          title: open ? tr('settings.sectionHide') : tr('settings.sectionShow'), 'aria-expanded': open,
          onClick: () => setOpen(!open),
          style: { fontSize: 13, fontWeight: 600 },
        }, React.createElement('span', { style: { opacity: 0.7, width: 12 } }, open ? '▾' : '▸'), title),
        extra || null,
      )

      // Issue #73: hosts from ~/.ssh/config that are NOT saved yet — they are the
      // first thing the page shows, because that is the whole list a VSCode
      // Remote-SSH user expects. A saved alias machine hides its file entry (the row
      // below it is the same host, with the actions that belong to a saved machine).
      const savedAliases = new Set(machines.filter((m) => m.useSshConfig).map((m) => String(m.host)))
      const discovered = (sshHosts || []).filter((h) => !savedAliases.has(String(h.alias || h.host)))

      // Keep row order stable while connectivity results arrive.
      const sortedMachines = [...machines].sort((a, b) => String(a.name || a.host).localeCompare(String(b.name || b.host)))

      // One filter box for BOTH halves of the list (ssh-config hosts + saved ones).
      const needle = hostFilter.trim().toLowerCase()
      const matches = (...fields) => !needle || fields.some((f) => String(f || '').toLowerCase().includes(needle))
      const shownDiscovered = discovered.filter((h) => matches(h.alias, h.host, h.hostName, h.user))
      const shownMachines = sortedMachines.filter((m) => matches(m.name, m.host, m.username, m.sshConfigResolved && m.sshConfigResolved.host))

      const hostProbe = key => {
        const result = rowState[key]
        const pending = !result || result.pending
        return React.createElement('span', {
          className: 'dsh-rw-settings-probe', role: 'status',
          title: pending ? tr('settings.testing') : result.ok ? tr('settings.latencyHint') : result.text,
          style: { color: pending ? T.muted : result.ok ? 'var(--dsw-alias-state-success-primary,#25845b)' : 'var(--dsw-alias-state-error-primary,#c44b4b)' },
        }, pending ? tr('settings.testing') : result.ok ? tr('settings.reachable') + (result.latencyMs != null ? ' · ' + result.latencyMs + ' ms' : '') : tr('settings.unreachable'))
      }
      const rowResult = key => rowState[key]?.ok === false ? React.createElement('details', { className: 'dsh-rw-settings-probe-error', style: { fontSize: 11, color: T.muted, lineHeight: 1.6, marginTop: 3, overflowWrap: 'anywhere' } }, React.createElement('summary', { style: { cursor: 'pointer' } }, tr('settings.probeDetails')), React.createElement('div', { style: { paddingTop: 5 } }, rowState[key].text)) : null

      return React.createElement('div',
        { className: 'dsh-rw-settings', 'data-rw-settings': true, 'aria-label': tr('settings.title'), style: { color: T.label } },
        confirmUi.node,
        React.createElement('div', { style: { fontSize: 16, fontWeight: 650, letterSpacing: '-0.01em' } }, tr('settings.pageTitle')),
        React.createElement('div', { style: { fontSize: 12, opacity: 0.8, lineHeight: 1.55 } },
          tr('settings.intro')),
        React.createElement('div', { role: 'tablist', 'aria-label': tr('settings.categories'), className: 'dsh-rw-settings-tabs', style: { background: T.bg, borderColor: T.border } },
        ...['hosts', 'tools', 'preferences'].map(key => React.createElement('button', { type: 'button', role: 'tab', key, id: settingsId + '-tab-' + key, 'aria-controls': settingsId + '-' + key, 'aria-selected': settingsTab === key, tabIndex: settingsTab === key ? 0 : -1, onClick: () => setSettingsTab(key), onKeyDown: event => { const keys = ['hosts', 'tools', 'preferences']; let next = keys.indexOf(key); if (event.key === 'ArrowRight') next = (next + 1) % keys.length; else if (event.key === 'ArrowLeft') next = (next + keys.length - 1) % keys.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = keys.length - 1; else return; event.preventDefault(); setSettingsTab(keys[next]); event.currentTarget.parentElement?.querySelectorAll('[role=tab]')[next]?.focus() } }, tr(settingsLabels[key])))),
        upd && (upd.pendingReload || upd.current && upd.current !== CLIENT_VERSION) ? React.createElement('div', { role: 'status', className: 'dsh-rw-settings-message', style: { fontSize: 12, lineHeight: 1.6, color: T.muted } }, tr('settings.runtimeMismatch', { client: CLIENT_VERSION, host: upd.loaded || upd.current, disk: upd.disk || upd.current })) : null,
        msg ? React.createElement('div', { role: 'status', 'aria-live': 'polite', className: 'dsh-rw-settings-message', style: { color: T.muted, fontSize: 12, lineHeight: 1.5 } }, msg) : null,
        err ? React.createElement('div', { role: 'alert', className: 'dsh-rw-settings-message', style: { color: T.danger, fontSize: 13, lineHeight: 1.5 } }, err) : null,
        React.createElement('div', { id: settingsId + '-hosts', role: 'tabpanel', 'aria-labelledby': settingsId + '-tab-hosts', hidden: settingsTab !== 'hosts', className: 'dsh-rw-settings-panel', style: { display: settingsTab === 'hosts' ? 'flex' : 'none' } },
        React.createElement('div', { className: 'dsh-rw-settings-card dsh-rw-settings-hosts', hidden: !!form.id || !!sshEditor, style: { ...boxS, display: form.id || sshEditor ? 'none' : undefined } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
            React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, tr('settings.pickHost')),
            React.createElement('span', { style: { fontSize: 11, opacity: 0.6 } }, tr('settings.hostListSource')),
            React.createElement('button', {
              type: 'button', className: 'dsh-rw-btn',
              style: { ...buttonS, fontSize: 11, padding: '2px 8px', marginLeft: 'auto' },
              onClick: () => openSshConfig(),
              title: tr('settings.openSshConfigHint') + (sshFile ? '\n' + sshFile : ''),
            }, tr('settings.openSshConfig')),
            React.createElement('button', {
              type: 'button', className: 'dsh-rw-btn',
              style: { ...buttonS, fontSize: 11, padding: '2px 8px' },
              onClick: refreshHosts,
              title: tr('settings.hostListRefreshHint'),
            }, tr('settings.hostListRefresh'))),
          // One search box for BOTH halves of the list — with a dozen hosts, "scroll
          // until you find it" stops working.
          React.createElement('input', {
            className: 'dsh-rw-input',
            value: hostFilter,
            onChange: (e) => setHostFilter(e.target.value),
            placeholder: tr('settings.hostFilter'),
            'aria-label': tr('settings.hostFilter'), style: { ...inputS, width: '100%', boxSizing: 'border-box', marginBottom: 12 },
          }),
          // SSH config hosts are probed without adopting or selecting them.
          sshHosts === null
            ? React.createElement('div', { style: { fontSize: 12, opacity: 0.6 } }, tr('settings.hostListLoading'))
            : (shownDiscovered.length
              ? shownDiscovered.map((h) => {
                const alias = String(h.alias || h.host)
                const key = 'ssh:' + alias
                const target = (h.user ? h.user + '@' : '') + (h.hostName || alias) + (Number(h.port) && Number(h.port) !== 22 ? ':' + h.port : '')
                return React.createElement('div', { key, className: 'dsh-rw-row dsh-rw-settings-host-row', style: { display: 'flex', gap: 8, alignItems: 'center', paddingTop: 6, paddingBottom: 6, borderBottom: '1px solid ' + T.border, flexWrap: 'wrap' } },
                  React.createElement('div', { style: { flex: 1, fontSize: 13, minWidth: 180 } },
                    React.createElement('div', { className: 'dsh-rw-settings-identity' }, React.createElement('span', { style: { fontWeight: 600 } }, alias), React.createElement('code', { style: { fontSize: 12, opacity: 0.75 } }, target), React.createElement('div', { className: 'dsh-rw-settings-host-flags' }, h.proxyJump ? pill('', tr('settings.badgeProxy')) : null, h.identityFile ? pill('', tr('settings.badgeKey')) : null)),
                    rowResult(key)),
                  React.createElement('div', { className: 'dsh-rw-settings-host-actions' }, hostProbe(key), React.createElement('span', { className: 'dsh-rw-settings-menu-spacer', 'aria-hidden': true })))
              })
              : (sshError
                ? React.createElement('div', { style: { fontSize: 11, color: T.danger, lineHeight: 1.6, marginBottom: 6, wordBreak: 'break-all' } },
                    tr('settings.hostListFailed', { msg: sshError }))
                : (sshHosts.length
                  ? null
                  : React.createElement('div', { style: { fontSize: 11, opacity: 0.65, lineHeight: 1.6, marginBottom: 6 } },
                      tr('settings.hostListEmpty', { file: sshFile || '~/.ssh/config' }))))),
          ...shownMachines.map(m => React.createElement('div', { key: m.id, className: 'dsh-rw-row dsh-rw-settings-host-row', style: { padding: '12px 0', borderBottom: '1px solid ' + T.border } },
            React.createElement('div', { className: 'dsh-rw-settings-identity' },
              React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, m.name || m.host),
              React.createElement('code', { style: { fontSize: 12, opacity: 0.75 } }, m.sshConfigResolved?.matched ? (m.sshConfigResolved.username || m.username || '?') + '@' + m.sshConfigResolved.host + ':' + (m.sshConfigResolved.port || m.port || 22) : m.useSshConfig ? m.host : (m.username || 'root') + '@' + m.host + ':' + (m.port || 22)),
              React.createElement('div', { className: 'dsh-rw-settings-host-flags' },
                m.useSshConfig || m.sshConfigResolved?.matched ? pill('', tr('settings.badgeSshConfig')) : null,
                m.backend === 'openssh' ? pill('', tr('settings.badgeOpenssh')) : null,
                m.passwordSet ? pill('', tr('settings.badgePwd')) : null,
                m.credentialBackend && m.credentialBackend !== 'plain' ? pill('', tr('settings.badgeKeychain')) : null,
                m.proxy?.host ? pill('', tr('settings.badgeProxy')) : null),
              m.sshConfigResolved?.warnings?.length ? React.createElement('div', { style: { fontSize: 11, color: T.warn } }, tr('settings.sshResolvedWarn', { msg: m.sshConfigResolved.warnings.join(' ') })) : null,
              rowResult('machine:' + m.id)),
            React.createElement('div', { className: 'dsh-rw-settings-host-actions' },
              hostProbe('machine:' + m.id),
              HostMenu ? React.createElement('button', { type: 'button', className: 'dsh-rw-action', title: tr('settings.hostActions', { name: m.name || m.host }), 'aria-label': tr('settings.hostActions', { name: m.name || m.host }), id: settingsId + '-actions-' + m.id, 'aria-haspopup': 'menu', 'aria-expanded': settingsMenu?.machine.id === m.id, onClick: event => setSettingsMenu({ machine: m, anchor: event.currentTarget.getBoundingClientRect() }) }, React.createElement(WorkbenchIcon, { name: 'more' }))
                : React.createElement('details', { className: 'dsh-rw-settings-menu' },
                  React.createElement('summary', { 'aria-label': tr('settings.hostActions', { name: m.name || m.host }) }, React.createElement(WorkbenchIcon, { name: 'more', size: 16 })),
                  React.createElement('div', { className: 'dsh-rw-settings-menu-items', style: { background: T.bg, borderColor: T.border } },
                    React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => startEdit(m) }, tr('settings.edit')),
                    React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => del(m.id) }, tr('settings.delete'))))))),
          !shownMachines.length && !shownDiscovered.length && !hostFilter ? React.createElement('div', { style: { fontSize: 12, color: T.muted } }, tr('settings.noMachines')) : null),
        sshEditor ? React.createElement('div', { className: 'dsh-rw-settings-editor', 'data-rw-ssh-editor': true },
          React.createElement('div', { className: 'dsh-rw-settings-editor-heading' },
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, disabled: sshEditorBusy, onClick: closeSshConfig }, React.createElement(WorkbenchIcon, { name: 'left', size: 14 }), tr('settings.backHosts')),
            React.createElement('div', null, React.createElement('strong', null, tr('settings.sshConfigEditorTitle')), React.createElement('div', { style: { fontSize: 11, color: T.muted, overflowWrap: 'anywhere' } }, sshEditor.file))),
          React.createElement('div', { className: 'dsh-rw-settings-editor-actions', style: { background: T.bg, borderColor: T.border } },
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, disabled: sshEditorBusy, onClick: closeSshConfig }, tr('settings.cancelEdit')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, disabled: sshEditorBusy, title: tr('settings.sshConfigReloadHint'), onClick: openSshConfig }, tr('settings.sshConfigReload')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, disabled: sshEditorBusy || !sshEditorDirty, title: tr('settings.sshConfigSaveHint'), onClick: saveSshConfig }, sshEditorBusy ? tr('settings.saving') : tr('settings.save'))),
          React.createElement('label', { htmlFor: settingsId + '-ssh-text', style: { fontSize: 12, color: T.muted } }, tr('settings.sshConfigEditorHint')),
          React.createElement('textarea', { id: settingsId + '-ssh-text', 'aria-label': tr('settings.sshConfigEditorTitle'), spellCheck: false, autoCapitalize: 'off', readOnly: sshEditorBusy, value: sshEditor.text, onChange: event => setSshEditor({ ...sshEditor, text: event.target.value }), onKeyDown: event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveSshConfig() } }, style: { ...inputS, width: '100%', boxSizing: 'border-box', minHeight: 320, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, lineHeight: 1.7, whiteSpace: 'pre', tabSize: 2, marginTop: 8 } }),
          React.createElement('div', { role: 'status', style: { fontSize: 11, color: T.muted, marginTop: 6 } }, sshEditorDirty ? tr('settings.unsaved') : tr('settings.sshConfigClean'))) : null,
        form.id ? React.createElement('div', { className: 'dsh-rw-settings-card dsh-rw-settings-editor', style: boxS },
          React.createElement('div', { className: 'dsh-rw-settings-editor-heading' },
        React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: closeEditor, disabled: busy, 'aria-label': tr('settings.backHosts') }, React.createElement(WorkbenchIcon, { name: 'left', size: 14 }), tr('settings.backHosts')),
        React.createElement('div', { style: { minWidth: 0, flex: 1 } }, React.createElement('strong', {}, form.name || form.host), React.createElement('div', { style: { color: formDirty ? T.warn : T.muted, fontSize: 11 } }, formDirty ? tr('settings.unsaved') : tr('settings.editMachine')))),
          React.createElement('div', { className: 'dsh-rw-settings-editor-actions', style: { background: T.bg, borderColor: T.border } },
        React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: closeEditor, disabled: busy }, tr('settings.cancelEdit')),
        React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: testConn, disabled: busy || !form.host.trim() || tst === 'testing', title: form.host.trim() ? tr('settings.testHint') : tr('settings.testNeedsHost') }, tst === 'testing' ? tr('settings.testing') : tst === 'ok' ? tr('settings.testOk') : tr('settings.testConn')),
        React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => save('update'), disabled: busy || !form.host.trim(), title: form.host.trim() ? tr('settings.saveHint') : tr('settings.saveNeedsHost') }, busy ? tr('settings.saving') : tr('settings.save'))) ,
        React.createElement(React.Fragment, null,
          row(tr('settings.name'), React.createElement('input', { className: 'dsh-rw-input', value: form.name, onChange: setF('name'), placeholder: tr('settings.name') + ' (e.g. build-server)', style: inputS }), 'n'),
          row(tr('settings.host'), React.createElement('input', { className: 'dsh-rw-input', value: form.host, onChange: setF('host'), placeholder: form.useSshConfig ? tr('settings.sshImport') + ' Host 别名' : 'IP or hostname', style: inputS }), 'h'),
          row(tr('settings.useSshConfig'), React.createElement('input', { type: 'checkbox', checked: !!form.useSshConfig, onChange: setFb('useSshConfig') }), 'sshc'),
          form.useSshConfig ? fieldNote(tr('settings.useSshConfigHint')) : null,
          // Issue #50: a literal save also touches ~/.ssh/config (managed
          // block) — say so where the choice is made.
          !form.useSshConfig ? fieldNote(tr('settings.saveWritesSshConfig')) : null,
          form.useSshConfig ? (() => {
            // Preview where the alias points, from the same resolution the
            // connect path uses (the host list carries it — issue #38).
            const preview = machines.find((m) => m.host === form.host && m.useSshConfig)
            const res = preview && preview.sshConfigResolved
            if (!res) return null
            return React.createElement('div', { style: { fontSize: 11, marginBottom: 8, color: res.matched ? T.ok : T.warn, lineHeight: 1.5 } },
              res.matched
                ? form.host + ' ' + tr('settings.sshResolvedTo', { user: res.username || '?', host: res.host, port: res.port })
                : tr('settings.sshResolvedNone', { alias: form.host }),
              (res.warnings && res.warnings.length) ? React.createElement('div', { style: { opacity: 0.85 } }, tr('settings.sshResolvedWarn', { msg: res.warnings.join(' ') })) : null)
          })() : null,
          row(tr('settings.port'), React.createElement('input', { className: 'dsh-rw-input', value: form.port, onChange: setF('port'), placeholder: '22', style: { ...inputS, width: 70 } }), 'p'),
          row(tr('settings.user'), React.createElement('input', { className: 'dsh-rw-input', value: form.username, onChange: setF('username'), placeholder: 'root', style: inputS }), 'u'),
          // The password box is EMPTY by design (the host never echoes a secret
          // back) — but an empty box with a neutral placeholder reads as "this
          // machine has no password", which is exactly the wrong conclusion to
          // reach while debugging a connection. When a secret IS stored, the
          // placeholder shows dots and says what an empty box will do.
          row(tr('settings.password'), React.createElement('input', {
            className: 'dsh-rw-input',
            type: 'password',
            value: form.password,
            onChange: setF('password'),
            placeholder: form.passwordSet ? tr('settings.secretSavedPlaceholder') : tr('settings.passwordPlaceholder'),
            style: inputS,
            title: form.passwordSet ? tr('settings.secretSavedHint') : '',
          }), 'w'),
          form.passwordSet
            ? React.createElement('div', { style: { marginLeft: LABEL_W + 12, marginBottom: 8, fontSize: 11, lineHeight: 1.5, color: T.muted } },
                tr('settings.secretSavedHint'))
            : null,
          // A machine with NO credential of any kind cannot connect, and the error
          // it produces ("缺少凭据") blames the user's configuration. Say it here,
          // while the form is open, instead of after a failed connect.
          (!form.passwordSet && !form.password && !form.privateKeyPath.trim() && !form.useAgent && !form.keyboardInteractive)
            ? React.createElement('div', { style: { marginLeft: LABEL_W + 12, marginBottom: 8, fontSize: 11, lineHeight: 1.5, color: T.warn } },
                tr('settings.noCredentialHint'))
            : null,
          // 高级配置折叠开关
          React.createElement('button', {
            type: 'button',
            className: 'dsh-rw-btn dsh-rw-settings-advanced', 'aria-expanded': advOpen,
            onClick: () => setAdvOpen(!advOpen),
            style: { ...buttonS, width: '100%', marginBottom: advOpen ? 10 : 0, color: advOpen ? T.primary : 'inherit', fontWeight: advOpen ? 600 : 400, borderStyle: 'dashed' },
          }, React.createElement(WorkbenchIcon, { name: advOpen ? 'down' : 'right', size: 14 }), advOpen ? tr('settings.advCollapse') : tr('settings.advExpand')),
          advOpen ? React.createElement('div', { key: 'adv', style: { paddingTop: 2 } },
            // Issue #51 — transport backend. Placed FIRST in the advanced block
            // because it changes what the fields below even mean: with the
            // system-OpenSSH backend, host/user/port/key all come from
            // ~/.ssh/config and only the machine name (an alias) matters.
            row(tr('settings.backend'), React.createElement('select', { value: form.backend || 'native', onChange: setF('backend'), style: { ...inputS, maxWidth: 260 } },
              React.createElement('option', { value: 'native' }, tr('settings.backendNative')),
              React.createElement('option', { value: 'openssh' }, tr('settings.backendOpenssh'))), 'be'),
            (form.backend === 'openssh')
              ? React.createElement('div', { style: { fontSize: 11, opacity: 0.85, marginBottom: 8, marginLeft: LABEL_W + 12, lineHeight: 1.55 } },
                  React.createElement('div', null, tr('settings.backendOpensshHint')),
                  form.useSshConfig
                    ? React.createElement('div', { style: { color: T.ok, marginTop: 2 } }, tr('settings.backendOpensshAliasOk'))
                    : null)
              : null,
            (form.backend === 'openssh')
              ? row(tr('settings.sshBinary'), React.createElement('input', { value: form.sshBinary || '', onChange: setF('sshBinary'), placeholder: tr('settings.sshBinaryPlaceholder'), style: inputS }), 'sb')
              : null,
            row(tr('settings.privateKey'), React.createElement('input', { value: form.privateKeyPath, onChange: setF('privateKeyPath'), placeholder: 'Empty = password or agent', style: inputS }), 'k'),
            row(tr('settings.passphrase'), React.createElement('input', { type: 'password', value: form.passphrase, onChange: setF('passphrase'), placeholder: form.passphraseSet ? tr('settings.secretSavedPlaceholder') : 'Encrypted private key passphrase', style: inputS, title: form.passphraseSet ? tr('settings.secretSavedHint') : '' }), 'pp'),
            form.passphraseSet
              ? React.createElement('div', { style: { marginLeft: LABEL_W + 12, marginBottom: 8, fontSize: 11, lineHeight: 1.5, color: T.muted } }, tr('settings.passphraseSavedHint'))
              : null,
            row(tr('settings.hostKeyMode'), React.createElement('select', { value: form.hostKeyMode, onChange: setF('hostKeyMode'), style: { ...inputS, maxWidth: 220 } },
              React.createElement('option', { value: '' }, tr('settings.hkDefault')),
              React.createElement('option', { value: 'accept-new' }, tr('settings.hkAccept')),
              React.createElement('option', { value: 'verify' }, tr('settings.hkVerify')),
              React.createElement('option', { value: 'off' }, tr('settings.hkOff'))), 'hkm'),
            React.createElement('div', { style: { display: 'flex', gap: 16, paddingLeft: LABEL_W + 12, flexWrap: 'wrap', marginBottom: 8 } },
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
              React.createElement('input', { type: 'password', value: form.proxyPassword, onChange: setF('proxyPassword'), placeholder: form.proxyPasswordSet ? tr('settings.secretSavedPlaceholder') : 'Jump password', style: { ...inputS, minWidth: 140 }, title: form.proxyPasswordSet ? tr('settings.proxyPwdSavedHint') : '' })), 'pu'),
            row(tr('settings.proxyKey'), React.createElement('input', { value: form.proxyKey, onChange: setF('proxyKey'), placeholder: 'Jump private key path (optional)', style: inputS }), 'pk'),
            // Issue #54: where "远程 DSH 界面" gets its remote dsh. The README
            // pointed at `webAttachCommand` and there was no field for it.
            row(tr('settings.webAttachCmd'), React.createElement('input', { value: form.webAttachCommand || '', onChange: setF('webAttachCommand'), placeholder: tr('settings.webAttachCmdPlaceholder'), style: inputS }), 'wac'),
            React.createElement('div', { style: { paddingLeft: LABEL_W + 12, marginBottom: 8, fontSize: 11, lineHeight: 1.5, opacity: 0.7 } }, tr('settings.webAttachCmdHint')),
            // Issue #125: reuse a resident remote `dsh web` instead of always
            // spawning a twin that shares its DSH_HOME (also the only attach
            // path that needs no POSIX shell on the remote).
            row(tr('settings.webAttachDiscover'), React.createElement('input', { 'data-testid': 'web-attach-discover-command', value: form.webAttachDiscoverCommand || '', onChange: setF('webAttachDiscoverCommand'), placeholder: tr('settings.webAttachDiscoverPlaceholder'), style: inputS }), 'wad'),
            React.createElement('div', { style: { paddingLeft: LABEL_W + 12, marginBottom: 8, fontSize: 11, lineHeight: 1.5, opacity: 0.7 } }, tr('settings.webAttachDiscoverHint')),
          ) : null,

          ),
        ) : null),
        React.createElement('div', { id: settingsId + '-tools', role: 'tabpanel', 'aria-labelledby': settingsId + '-tab-tools', hidden: settingsTab !== 'tools', className: 'dsh-rw-settings-panel', style: { display: settingsTab === 'tools' ? 'flex' : 'none' } },
        React.createElement('div', { style: boxS },
          sectionToggle(webAttachOpen, setWebAttachOpen, tr('settings.webAttach')),
          webAttachOpen ? React.createElement(React.Fragment, null,
            React.createElement('div', { style: { opacity: 0.65, fontSize: 11, lineHeight: 1.5, marginBottom: 6 } }, tr('settings.webAttachHint')),
            // The URL below carries a one-time login token. It stays on loopback,
            // but a user could paste it into a chat — say so where the URL is.
            React.createElement('div', { style: { color: T.warn, fontSize: 11, lineHeight: 1.5, marginBottom: 6 } }, tr('settings.webAttachTokenWarn')),
            // Live tunnels, one row per machine.
            webAttaches.length ? webAttaches.map((a) => React.createElement('div', { key: a.machineId || a.localPort, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', fontSize: 12, flexWrap: 'wrap' } },
              React.createElement('span', { style: { color: a.active ? T.ok : T.muted } }, a.active ? '●' : '○'),
              React.createElement('code', { style: { fontFamily: 'monospace' } }, a.cleanUrl || ''),
              React.createElement('span', { style: { opacity: 0.6, fontFamily: 'monospace' } }, '→ :' + a.remotePort),
              // Issue #125: say where this tunnel came from — a reused resident
              // instance, or a fresh spawn after discovery missed/timed out.
              a.discovery && WEB_ATTACH_DISCOVERY_KEYS[a.discovery]
                ? React.createElement('span', {
                    style: { fontSize: 11, color: a.discovery === 'hit' ? T.ok : T.muted },
                  }, tr(WEB_ATTACH_DISCOVERY_KEYS[a.discovery]))
                : null,
              a.active ? React.createElement('a', {
                className: 'dsh-rw-btn dsh-rw-primary', style: { ...primaryBtnS, textDecoration: 'none' },
                // The token rides on this loopback URL only; DSH exchanges it
                // for a signed cookie and redirects to a clean '/'.
                href: a.url, target: '_blank', rel: 'noopener noreferrer',
              }, tr('settings.webAttachReopen')) : null,
              // A tunnel whose listener died (remote restart, sshd drop) keeps
              // its row so the user can see what happened and reconnect. The
              // remote process is NOT auto-restarted: that would silently
              // resurrect a server on a machine the user may be done with.
              !a.active ? React.createElement('button', {
                type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' },
                disabled: !!webAttachBusy, onClick: () => webAttachAction('open', a.machineId),
              }, tr('settings.webAttachReconnect')) : null,
              !a.active ? React.createElement('span', { style: { color: T.muted, fontSize: 11 } }, a.error || tr('settings.webAttachDropped')) : null,
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' },
                disabled: !!webAttachBusy, onClick: () => webAttachAction('close', a.machineId) }, tr('settings.webAttachClose')),
              // Only offered for a process we started: an attach onto the user's
              // own running DSH must never signal it.
              a.managed
                ? React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' },
                    disabled: !!webAttachBusy, onClick: () => webAttachAction('close', a.machineId, { stopRemote: true }) }, tr('settings.webAttachCloseStop'))
                : null)) : React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, tr('settings.webAttachNone')),
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
              React.createElement('select', { className: 'dsh-rw-input', value: webAttachMachine, onChange: (e) => setWebAttachMachine(e.target.value), style: { ...inputS, maxWidth: 200 } },
                React.createElement('option', { value: '' }, tr('settings.webAttachMachine') + '…'),
                machines.map((m) => React.createElement('option', { key: m.id, value: m.id }, `${m.name || m.host} (${m.username}@${m.host})`))),
              React.createElement('button', {
                type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS,
                disabled: !!webAttachBusy || !webAttachMachine,
                // The machine is named explicitly in the request, so attaching
                // never has to move the user's "current machine" selection.
                onClick: () => webAttachAction('open', webAttachMachine),
              }, webAttachBusy.endsWith(':open') ? tr('settings.webAttachOpening') : tr('settings.webAttachOpen'))),
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
              React.createElement('input', { className: 'dsh-rw-input', value: webAttachExisting, onChange: (e) => setWebAttachExisting(e.target.value), placeholder: tr('settings.webAttachExisting'), style: { ...inputS, flex: 1, minWidth: 260 } }),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' },
                disabled: !!webAttachBusy || !webAttachMachine || !webAttachExisting.trim(),
                onClick: () => webAttachAction('open', webAttachMachine, { existingUrl: webAttachExisting.trim() }).then(() => setWebAttachExisting('')) }, tr('settings.webAttachExistingGo'))),
            webAttachErr ? React.createElement('div', { style: { color: T.danger, fontSize: 12, marginTop: 6, wordBreak: 'break-all' } }, tr('settings.webAttachFailed') + webAttachErr) : null,
          ) : null,
        ),
        React.createElement('div', { style: boxS },
          sectionToggle(fwdOpen, setFwdOpen, tr('settings.forwards')),
          fwdOpen ? React.createElement(React.Fragment, null,
            forwards.length ? forwards.map((f) => React.createElement('div', { key: f.id, className: 'dsh-rw-row', style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', fontSize: 12, fontFamily: 'monospace' } },
              React.createElement('span', { style: { color: f.active ? T.ok : T.muted } }, f.active ? '●' : '○'),
              React.createElement('span', { style: { flex: 1 } }, `${f.direction} 127.0.0.1:${f.listenPort} → ${f.targetHost}:${f.targetPort}${f.autoStart ? ' [auto]' : ''}`),
              f.active
                ? React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' }, onClick: () => fwdAction('stop', f.id) }, tr('settings.fwdStop'))
                : React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' }, onClick: () => fwdAction('start', f.id) }, tr('settings.fwdStart')),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' }, onClick: () => fwdAction('remove', f.id) }, tr('settings.fwdRemove')))) : null,
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
              React.createElement('select', { className: 'dsh-rw-input', value: fwdForm.direction, onChange: (e) => setFwdForm({ ...fwdForm, direction: e.target.value }), style: { ...inputS, maxWidth: 110 } },
                React.createElement('option', { value: 'local' }, tr('settings.fwdDirLocal')),
                React.createElement('option', { value: 'reverse' }, tr('settings.fwdDirReverse'))),
              React.createElement('input', { className: 'dsh-rw-input', value: fwdForm.listenPort, onChange: (e) => setFwdForm({ ...fwdForm, listenPort: e.target.value }), placeholder: tr('settings.fwdListen'), style: { ...inputS, maxWidth: 90 } }),
              React.createElement('input', { className: 'dsh-rw-input', value: fwdForm.targetHost, onChange: (e) => setFwdForm({ ...fwdForm, targetHost: e.target.value }), placeholder: tr('settings.fwdTargetHost'), style: { ...inputS, maxWidth: 120 } }),
              React.createElement('input', { className: 'dsh-rw-input', value: fwdForm.targetPort, onChange: (e) => setFwdForm({ ...fwdForm, targetPort: e.target.value }), placeholder: tr('settings.fwdTargetPort'), style: { ...inputS, maxWidth: 90 } }),
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: fwdForm.autoStart, onChange: (e) => setFwdForm({ ...fwdForm, autoStart: e.target.checked }) }), tr('settings.fwdAuto')),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: fwdDefine, disabled: !fwdForm.listenPort, title: fwdForm.listenPort ? tr('settings.fwdAddHint') : tr('settings.fwdNeedsPort') }, tr('settings.fwdAdd'))),
          ) : null,
        ),
        React.createElement('div', { style: boxS },
          sectionToggle(auditOpen, setAuditOpen, tr('settings.audit'),
            React.createElement('div', { style: { display: 'flex', gap: 6, marginLeft: 'auto' } },
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px', fontSize: 12 }, onClick: (e) => { e.stopPropagation(); api('GET', '/dsh-remote/audit?limit=30').then((r) => { setAuditLines(r.lines || []); if (r && r.file) setAuditFile(String(r.file)) }).catch(() => {}) } }, tr('settings.auditRefresh')),
              React.createElement('button', {
                type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px', fontSize: 12 },
                title: tr('settings.auditOpenHint'),
                onClick: (e) => {
                  e.stopPropagation()
                  setAuditMsg('')
                  api('POST', '/dsh-remote/audit', { action: 'open' })
                    .then((r) => { if (r && r.file) setAuditFile(String(r.file)); setAuditMsg(tr('settings.auditOpened', { file: (r && r.file) || auditFile })) })
                    .catch((err) => setAuditMsg(tr('settings.auditOpenFailed', { msg: String((err && err.message) || err) })))
                },
              }, tr('settings.auditOpen')),
              React.createElement('button', {
                type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px', fontSize: 12 },
                title: tr('settings.auditRevealHint'),
                onClick: (e) => {
                  e.stopPropagation()
                  setAuditMsg('')
                  api('POST', '/dsh-remote/audit', { action: 'reveal' })
                    .then((r) => { if (r && r.file) setAuditFile(String(r.file)); setAuditMsg(tr('settings.auditRevealed', { file: (r && r.file) || auditFile })) })
                    .catch((err) => setAuditMsg(tr('settings.auditOpenFailed', { msg: String((err && err.message) || err) })))
                },
              }, tr('settings.auditReveal')))),
          auditOpen
            ? React.createElement(React.Fragment, null,
              // The path is always shown: even where the OS cannot open it (headless
              // host), the user can copy it into their own editor.
              auditFile
                ? React.createElement('div', { style: { fontSize: 11, opacity: 0.7, marginBottom: 4, fontFamily: 'monospace', wordBreak: 'break-all' } }, auditFile)
                : null,
              auditMsg ? React.createElement('div', { style: { fontSize: 11, marginBottom: 4, lineHeight: 1.5, wordBreak: 'break-all', color: /无法|failed|error/i.test(auditMsg) ? T.warn : T.ok } }, auditMsg) : null,
              auditLines.length
                ? React.createElement('div', { style: { maxHeight: 180, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6 } },
                    auditLines.map((l, i) => React.createElement('div', { key: i, title: String(l), style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, fmtAuditLine(l))))
                : React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, tr('settings.auditEmpty')))
            : null,
        ),
        React.createElement('div', { style: boxS },
          sectionToggle(cleanupOpen, openCleanupSection, tr('settings.cleanup'),
            React.createElement('button', {
              type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px', fontSize: 12, marginLeft: 'auto' },
              onClick: (e) => { e.stopPropagation(); loadCleanup() },
            }, tr('settings.cleanupRefresh'))),
          cleanupOpen
            ? (cleanupRows.length
              ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  cleanupRows.map((row) => React.createElement('div', {
                    key: row.localMirror,
                    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6, border: '1px solid ' + T.border, fontSize: 12 },
                  },
                    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                      React.createElement('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.title || row.machineName || row.host),
                      React.createElement('code', { style: { fontSize: 11, opacity: 0.7, wordBreak: 'break-all' } }, row.remotePath)),
                    React.createElement('span', { style: { fontSize: 11, opacity: 0.65, flexShrink: 0, whiteSpace: 'nowrap' } },
                      humanSize(row.mirrorBytes) + (row.mirrorSizeTruncated ? '+' : '') + ' · ' + row.sessionCount + tr('settings.cleanupChats') + (row.liveSessionCount > 0 ? ' · ' + tr('settings.cleanupLive') : '')),
                    React.createElement('button', {
                      type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px', fontSize: 11 },
                      disabled: cleanupBusy !== '', title: tr('settings.cleanupSessionsHint'),
                      onClick: () => cleanupAct(row, 'sessions'),
                    }, tr('settings.cleanupSessions')),
                    React.createElement('button', {
                      type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px', fontSize: 11 },
                      disabled: cleanupBusy !== '', title: tr('settings.cleanupRecentHint'),
                      onClick: () => cleanupAct(row, 'recent'),
                    }, tr('settings.cleanupRecent')),
                    React.createElement('button', {
                      type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px', fontSize: 11, color: T.dangerText },
                      disabled: cleanupBusy !== '', title: tr('settings.cleanupAllHint'),
                      onClick: () => cleanupAct(row, 'all'),
                    }, tr('settings.cleanupAll')))))
              : React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, tr('settings.cleanupEmpty')))
            : null,
          cleanupOpen && cleanupMsg
            ? React.createElement('div', { style: { fontSize: 11, marginTop: 6, lineHeight: 1.5, wordBreak: 'break-all', color: /失败|failed|拒绝|busy/i.test(cleanupMsg) ? T.warn : T.ok } }, cleanupMsg)
            : null,
        ),
        null),
        React.createElement('div', { id: settingsId + '-preferences', role: 'tabpanel', 'aria-labelledby': settingsId + '-tab-preferences', hidden: settingsTab !== 'preferences', className: 'dsh-rw-settings-panel', style: { display: settingsTab === 'preferences' ? 'flex' : 'none' } },
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, tr('settings.update')),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 } },
            upd
              ? React.createElement('span', { style: { opacity: 0.85 } },
                  'v' + upd.current,
                  upd.updateAvailable ? React.createElement('b', { style: { color: T.ok, marginLeft: 6 } }, '→ v' + upd.latest) : null)
              : React.createElement('span', { style: { opacity: 0.6 } }, tr('settings.updateChecking')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 10px' }, onClick: () => checkUpdate(false), disabled: updBusy }, updBusy ? tr('settings.checking') : tr('settings.checkUpdate')),
            upd && upd.updateAvailable
              ? React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: { ...primaryBtnS, padding: '2px 10px' }, onClick: applyUpdateNow, disabled: updBusy }, tr('settings.updateNow'))
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
          upd?.autoUpdate
            ? React.createElement('div', { role: 'status', style: { marginTop: 8, fontSize: 12, lineHeight: 1.6, color: upd.autoUpdate.error ? T.warn : 'inherit' } },
                tr(({ idle: 'settings.autoUpdate.idle', checking: 'settings.autoUpdate.checking', downloading: 'settings.autoUpdate.downloading', reloading: 'settings.autoUpdate.reloading', current: 'settings.autoUpdate.current', paused: 'settings.autoUpdate.paused', unsupported: 'settings.autoUpdate.unsupported', 'restart-required': 'settings.autoUpdate.restart-required', error: 'settings.autoUpdate.error' })[upd.autoUpdate.phase] || 'settings.autoUpdate.idle'),
                upd.autoUpdate.error ? '：' + upd.autoUpdate.error : '',
                updMode === 'auto' && upd.autoUpdate.nextCheckAt ? ' · ' + tr('settings.nextUpdateCheck', { time: new Date(upd.autoUpdate.nextCheckAt).toLocaleTimeString() }) : '')
            : null,
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontSize: 12 } },
            // Host Switch when shipped: its onChange hands back a bare boolean
            // and it does not forward unknown props, so the stable test id lives
            // on the tight wrapper span. The caption keeps label-like behaviour
            // (click toggles) so the swap is purely visual. Older hosts keep the
            // native checkbox — which then OWNS the data-testid: exactly one
            // element carries each id on either path.
            HostSwitch
              ? React.createElement('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', opacity: 0.85 } },
                  React.createElement('span', { 'data-testid': 'explorer-auto-open', style: { display: 'inline-flex' } },
                    React.createElement(HostSwitch, {
                      checked: explorerAuto,
                      label: tr('settings.explorerAutoOpen'),
                      onChange: (on) => applyExplorerAutoOpen(on === true),
                    })),
                  React.createElement('span', { style: { cursor: 'pointer' }, onClick: () => applyExplorerAutoOpen(!explorerAuto) }, tr('settings.explorerAutoOpen')),
                )
              : React.createElement('label', { style: { display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', opacity: 0.85 } },
                  React.createElement('input', {
                    type: 'checkbox', checked: explorerAuto, 'data-testid': 'explorer-auto-open',
                    onChange: (e) => applyExplorerAutoOpen(!!(e && e.target && e.target.checked)),
                  }),
                  tr('settings.explorerAutoOpen'),
                ),
          ),
          upd?.lastReload?.ok === false
            ? React.createElement('div', { role: 'status', style: { marginTop: 8, fontSize: 12, lineHeight: 1.6, color: T.warn } }, tr('settings.updateReloadFailed', { reason: upd.lastReload.reason || '' }))
            : null,
          upd && upd.pendingReload
            ? React.createElement('div', { style: { marginTop: 6, fontSize: 12, color: T.warn } },
                tr('settings.updatePendingReload', { disk: upd.disk, loaded: upd.loaded }))
            : null,
          upd && upd.selfUpdateAllowed === false
            ? React.createElement('div', { style: { marginTop: 6, fontSize: 12, color: T.warn } },
                tr('settings.selfUpdateBlocked'))
            : null,
          updMsg ? React.createElement('div', { style: { marginTop: 6, fontSize: 12, color: updMsg.startsWith('✅') ? T.ok : 'inherit', opacity: 0.9 } }, updMsg) : null,
        )),
        React.createElement('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, opacity: 0.65, borderTop: '1px solid ' + T.border, paddingTop: 10, marginTop: 4 } },
          React.createElement('span', {}, tr('settings.like')),
          React.createElement('a', { href: 'https://github.com/flymysql/dsh-remote', target: '_blank', rel: 'noopener noreferrer', style: { color: 'inherit' } }, tr('settings.star')),
          React.createElement('span', {}, '·'),
          React.createElement('a', { href: 'https://github.com/flymysql/dsh-remote/issues/new', target: '_blank', rel: 'noopener noreferrer', style: { color: 'inherit' } }, tr('settings.feedback')),
          React.createElement('span', { style: { marginLeft: 'auto', opacity: 0.5 } }, 'dsh-remote v' + CLIENT_VERSION),
        ),
        settingsMenu && HostMenu ? React.createElement(HostMenu, { open: true, portal: true, getAnchorRect: () => settingsMenu.anchor, items: [ { id: 'edit', label: tr('settings.edit') }, { id: 'delete', label: tr('settings.delete'), danger: true } ], onClose: () => setSettingsMenu(null), onSelect: id => { const machine = settingsMenu.machine; setSettingsMenu(null); if (id === 'edit') startEdit(machine); else if (id === 'delete') del(machine.id) } }) : null)
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

    function ProjectOpenError({ error }) {
      if (!error) return null
      const cancelled = error === tr('project.cancelled')
      const key = /host.?key|fingerprint|主机密钥|指纹/i.test(error) ? 'project.hostKeyHelp'
        : /auth|password|credential|认证|密码|私钥/i.test(error) ? 'project.authHelp'
        : /not a directory|no such file|目录|ENOENT/i.test(error) ? 'project.pathHelp'
        : 'project.networkHelp'
      return React.createElement('div', { role: cancelled ? 'status' : 'alert', style: { padding: '10px 12px', border: '1px solid ' + T.border, borderRadius: 8, color: cancelled ? T.muted : T.danger, fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' } },
        React.createElement('div', { style: { fontWeight: 600 } }, cancelled ? error : tr('project.failed')),
        !cancelled ? React.createElement(React.Fragment, null,
          React.createElement('div', {}, tr(key)),
          React.createElement('details', { style: { marginTop: 4 } }, React.createElement('summary', { style: { cursor: 'pointer' } }, tr('project.details')), React.createElement('div', { style: { whiteSpace: 'pre-wrap', fontFamily: 'monospace', paddingTop: 6 } }, error))) : null)
    }

    // Shared project-first entry inside both native directory-flow seats.
    // Discovery is read-only; adopting an SSH alias happens only on selection.
    function RemoteProjectChooser({ machines, busy, registryLoading, onMachine, onProject, onError }) {
      const [query, setQuery] = React.useState('')
      const [hosts, setHosts] = React.useState(null)
      const [error, setError] = React.useState('')
      const [opening, setOpening] = React.useState('')
      const requestRef = React.useRef(null)
      const listRef = React.useRef(null)
      const load = () => {
        if (requestRef.current) requestRef.current.abort()
        const controller = new AbortController()
        requestRef.current = controller
        setError(''); setHosts(null)
        api('GET', '/dsh-remote/ssh-config', undefined, controller.signal)
          .then((r) => { if (!controller.signal.aborted) setHosts(r.entries || []) })
          .catch((e) => { if (!controller.signal.aborted) { setError(String(e.message || e)); setHosts([]) } })
      }
      React.useEffect(() => { load(); return () => { if (requestRef.current) requestRef.current.abort() } }, [])
      const needle = query.trim().toLowerCase()
      const matches = (...fields) => !needle || fields.some((f) => String(f || '').toLowerCase().includes(needle))
      const sorted = machines.slice().sort((a, b) => (Date.parse(b.lastConnectedAt) || 0) - (Date.parse(a.lastConnectedAt) || 0))
      const recentProjects = sorted.flatMap((m) => (m.recentWorkspaces || []).filter((p) => matches(m.name, m.host, p)).map((path) => ({ machine: m, path })))
      const aliases = new Set(machines.filter((m) => m.useSshConfig).map((m) => m.host))
      const discovered = (hosts || []).filter((h) => !aliases.has(h.alias || h.host) && matches(h.alias, h.hostName, h.host, h.user))
      const saved = sorted.filter((m) => matches(m.name, m.host, m.username))
      const chooseAlias = async (h) => {
        if (busy || opening) return
        const controller = new AbortController()
        if (requestRef.current) requestRef.current.abort()
        requestRef.current = controller
        setOpening(h.alias || h.host); setError('')
        try {
          const r = await api('POST', '/dsh-remote/machines', { action: 'from-ssh-config', alias: h.alias || h.host }, controller.signal)
          if (controller.signal.aborted) return
          const next = await api('GET', '/dsh-remote/machines', undefined, controller.signal)
          if (!controller.signal.aborted) onMachine((next.machines || []).find((m) => m.id === r.currentId), next.machines)
        } catch (e) { if (!controller.signal.aborted) { setError(String(e.message || e)); if (onError) onError(e) } }
        finally { if (!controller.signal.aborted) setOpening('') }
      }
      const result = (key, title, subtitle, action) => React.createElement('button', {
        key, type: 'button', className: 'dsh-rw-project-row dsh-rw-btn', disabled: busy || !!opening,
        onClick: action, title: title + '\n' + subtitle,
        style: { ...buttonS, width: '100%', display: 'flex', gap: 12, alignItems: 'center', textAlign: 'left', padding: '10px 12px', background: 'transparent', border: 'none', borderRadius: 6 },
      },
        React.createElement('span', { 'aria-hidden': true, style: { color: T.muted, flexShrink: 0 } }, key.startsWith('project:') ? IconFolder() : 'SSH'),
        React.createElement('span', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
          React.createElement('span', { style: { fontSize: 11, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, subtitle)),
        React.createElement('span', { 'aria-hidden': true, style: { color: T.muted } }, '›'))
      const heading = (text) => React.createElement('div', { style: { padding: '10px 12px 4px', fontSize: 11, fontWeight: 600, color: T.muted } }, text)
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, gap: 8 } },
        React.createElement('input', { className: 'dsh-rw-input', 'data-modal-autofocus': true, 'aria-label': tr('project.search'), placeholder: tr('project.search'), value: query, disabled: busy || !!opening,
          onChange: (e) => setQuery(e.target.value), onKeyDown: (e) => { if (e.key === 'ArrowDown' && !e.isComposing) { e.preventDefault(); listRef.current && listRef.current.querySelector('button:not(:disabled)')?.focus() } }, style: { ...inputS, width: '100%', boxSizing: 'border-box' } }),
        React.createElement('div', { ref: listRef, style: { overflowY: 'auto', minHeight: 180, maxHeight: 'min(340px, 48vh)', border: '1px solid ' + T.border, borderRadius: 8 },
          onKeyDown: (e) => {
            if (e.isComposing || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
            const rows = Array.from(e.currentTarget.querySelectorAll('button:not(:disabled)'))
            const at = rows.indexOf(document.activeElement)
            if (at < 0 || !rows.length) return
            e.preventDefault()
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
            rows[next].focus()
          },
        },
          recentProjects.length ? heading(tr('project.recent')) : null,
          recentProjects.map(({ machine: m, path }) => result('project:' + m.id + ':' + path, path.split(/[\\/]/).filter(Boolean).pop() || path, (m.name || m.host) + ' · ' + path, () => onProject(m, path))),
          saved.length || discovered.length ? heading(tr('project.hosts')) : null,
          saved.map((m) => result('host:' + m.id, m.name || m.host, (m.username ? m.username + '@' : '') + m.host, () => onMachine(m))),
          discovered.map((h) => result('ssh:' + (h.alias || h.host), h.alias || h.host, (h.user ? h.user + '@' : '') + (h.hostName || h.host || h.alias), () => chooseAlias(h))),
          hosts === null || registryLoading ? React.createElement('div', { role: 'status', style: { padding: 12, color: T.muted, fontSize: 12 } }, tr('settings.hostListLoading')) : null,
          hosts !== null && !registryLoading && !error && !saved.length && !discovered.length && !recentProjects.length ? React.createElement('div', { style: { padding: 16, fontSize: 12, color: T.muted } }, tr(needle ? 'project.noMatches' : 'project.noHosts')) : null,
        ),
        error ? React.createElement('div', { role: 'alert', style: { color: T.danger, fontSize: 12, overflowWrap: 'anywhere' } }, error,
          React.createElement('button', { type: 'button', style: buttonS, className: 'dsh-rw-btn', onClick: load }, tr('project.retry'))) : null,
        opening ? React.createElement('div', { role: 'status', style: { fontSize: 12, color: T.muted } }, tr('project.addingHost')) : null,
        React.createElement('div', { style: { fontSize: 11, color: T.muted, lineHeight: 1.6 } }, tr('project.configHint')),
      )
    }

    function DirPicker(props) {
      // initialMachineId lets a caller open the picker FOR a specific machine. The
      // settings page needs it: 选目录 on a non-current machine must not silently
      // browse the current one.
      // registerWorkspace: this picker is the CORE's "Add workspace" directory
      // flow, which adopts the returned mirror as a workspace right after we
      // commit. The plugin's own pickers (settings, Remote Files) only choose a
      // folder, so they pass false and never grow a stray workspace.
      const { open, busy: externalBusy, onPicked, onCancel, initialMachineId, initialTab, registerWorkspace } = props
      const [tab, setTab] = React.useState(initialMachineId || initialTab === 'remote' ? 'remote' : 'local')
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
      const [mkdirPrompt, setMkdirPrompt] = React.useState(false)
      const suggestTimer = React.useRef(null)
      const suggestRef = React.useRef(null)
      // Issue #52 defect 1: the modal backdrop must dismiss only when the press
      // STARTED on it (a suggestion click whose mouseup landed on the backdrop
      // used to close the whole picker). The local-browse popup below is its own
      // full-screen overlay, so it gets its own guard ref — sharing one ref
      // would make a press on either backdrop arm the other.
      const backdrop = useBackdropGuard()
      const localBackdrop = useBackdropGuard()
      // Autocomplete performance (slow per-keystroke remote scans):
      //  - postedCurrentRef/currentPromiseRef: POST /current once per machine
      //    switch; concurrent callers share ONE in-flight promise and a failed
      //    switch REJECTS (never run /ls — or cache its listing — on the wrong
      //    machine)
      //  - lsCacheRef/lsInflightRef: one /ls per (machine, dir), TTL-cached
      //  - lsGenRef/fetchSeqRef: per-key fetch generation — a cache write from
      //    a superseded fetch (fresh navigation, picker reopen) is dropped
      //  - suggestSeqRef: drop stale suggestion responses (older keystrokes)
      const postedCurrentRef = React.useRef('')
      const currentPromiseRef = React.useRef(null)
      const lsCacheRef = React.useRef(new Map())
      const lsInflightRef = React.useRef(new Map())
      const lsGenRef = React.useRef(new Map())
      const fetchSeqRef = React.useRef(0)
      const suggestSeqRef = React.useRef(0)
      React.useEffect(() => {
        if (!suggestOpen) return
        const onDown = (ev) => { if (suggestRef.current && !suggestRef.current.contains(ev.target)) { suggestSeqRef.current++; setSuggestOpen(false) } }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [suggestOpen])
      const [mOpen, setMOpen] = React.useState(false)
      const [suggestIndex, setSuggestIndex] = React.useState(0)
      const [choosingProject, setChoosingProject] = React.useState(!initialMachineId)
      const [operationPhase, setOperationPhase] = React.useState('')
      const [registryLoading, setRegistryLoading] = React.useState(false)
      const operationRef = React.useRef(null)
      const pickerEpochRef = React.useRef(0)
      const browseSeqRef = React.useRef(0)
      const busy = !!externalBusy || !!operationPhase
      const cancelOperation = () => {
        const op = operationRef.current
        operationRef.current = null
        if (op) op.abort()
        setOperationPhase('')
      }
      const closePicker = () => { cancelOperation(); pickerEpochRef.current++; onCancel() }
      const runPickerOperation = async (phase, task) => {
        if (externalBusy || operationRef.current) return
        const controller = new AbortController()
        operationRef.current = controller
        setOperationPhase(phase); setErr('')
        const current = () => operationRef.current === controller && !controller.signal.aborted
        try { await task(controller.signal, current) }
        catch (e) { if (current()) setErr(String(e.message || e)) }
        finally { if (operationRef.current === controller) { operationRef.current = null; setOperationPhase('') } }
      }
      React.useEffect(() => {
        if (!open) cancelOperation()
        return () => { if (operationRef.current) { operationRef.current.abort(); operationRef.current = null }; pickerEpochRef.current++ }
      }, [open])
      const suggestListId = React.useId()
      const activeSuggestion = Math.min(suggestIndex, Math.max(0, suggest.length - 1))
      React.useEffect(() => { setSuggestIndex(0) }, [suggest])
      React.useEffect(() => {
        if (!suggestOpen) return
        const row = suggestRef.current && suggestRef.current.querySelector('[aria-selected="true"]')
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
      }, [suggestOpen, activeSuggestion, suggest])
      const ddRef = React.useRef(null)
      React.useEffect(() => {
        if (!mOpen) return
        const onDown = (ev) => { if (ddRef.current && !ddRef.current.contains(ev.target)) setMOpen(false) }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [mOpen])
      React.useEffect(() => { if (open) ensureChromeCss() }, [open])

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

      // Identity of the machine a listing was answered for (the /ls response
      // echoes it), checked against the machine the fetch INTENDED. The picker
      // memoizes "machine already active", but the settings page can switch
      // machines too — validate every listing before trusting the memo. A
      // machine may show up as its ~/.ssh/config alias OR its resolved host, so
      // accept either identity; nothing to compare against → accept.
      const echoMatches = (id, echo) => {
        if (!echo || !echo.host) return true // older host half without an echo
        const m = (machines || []).find((x) => x && x.id === id)
        if (!m) return true
        const cands = [{ host: String(m.host || ''), port: Number(m.port) || 22, username: String(m.username || '') }]
        const r = m.sshConfigResolved
        if (r && r.host) cands.push({ host: String(r.host), port: Number(r.port) || 22, username: String(r.username || m.username || '') })
        return cands.some((c) => c.host === String(echo.host) && c.port === (Number(echo.port) || 22) && c.username === String(echo.username || ''))
      }

      // POST /current once per machine switch. The picker used to post it before
      // EVERY /ls; the host re-applies the machine on that route, which used to
      // close the live SSH connection — so each autocomplete keystroke paid a
      // full reconnect. The memo is set only on SUCCESS and concurrent callers
      // share ONE in-flight promise, so no request can overtake a pending switch
      // and read the OLD machine's listing. A failed switch REJECTS: the
      // caller's fetch chain aborts WITHOUT writing the cache.
      const ensureCurrent = (id) => {
        if (!id) return Promise.resolve()
        if (postedCurrentRef.current === id) return Promise.resolve()
        const inflight = currentPromiseRef.current
        if (inflight) {
          if (inflight.id === id) return inflight.promise
          // Serialize switches: ours must land AFTER any pending one (the host
          // applies whichever POST arrives last), never race it.
          return inflight.promise.then(() => ensureCurrent(id), () => ensureCurrent(id))
        }
        const p = api('POST', '/dsh-remote/current', { id }).then(() => {
          postedCurrentRef.current = id
        })
        const entry = { id, promise: p }
        currentPromiseRef.current = entry
        const clear = () => { if (currentPromiseRef.current === entry) currentPromiseRef.current = null }
        p.then(clear, clear)
        return p
      }

      const LS_TTL_MS = 30000
      // Cached remote listing per (machine, dir): typing inside one parent
      // directory used to re-fetch the identical list on every keystroke.
      // `fresh` bypasses the cache (browse navigation / post-mkdir refresh) and
      // SUPERSEDES older fetches for the key: a cache write from a superseded
      // fetch is dropped (it still resolves its own callers), so a pre-mkdir
      // listing can never overwrite the post-mkdir one. Concurrent identical
      // requests share one in-flight fetch.
      const fetchDirList = (id, dirParam, fresh) => {
        const key = String(id) + '\u0000' + String(dirParam)
        const hit = lsCacheRef.current.get(key)
        if (!fresh && hit && Date.now() - hit.at < LS_TTL_MS) return Promise.resolve(hit.node)
        const inflight = fresh ? null : lsInflightRef.current.get(key)
        if (inflight) return inflight
        const gen = ++fetchSeqRef.current
        lsGenRef.current.set(key, gen)
        const toNode = (res) => {
          const real = res && res.path ? res.path : String(dirParam)
          // Server returns [{ type, name, size, mtime, path }] where `path` is
          // the FULL display-form path (C:\Users\dev on Windows) — the client
          // never joins paths itself, so drives and Windows paths just work.
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir', size: it.size, mtime: it.mtime, path: it.path || joinDisplay(real, it.name), drive: !!it.drive }))
            : parseLs(res && res.text)
          return {
            path: real,
            platform: !!(res && res.platform === 'windows'),
            dirs: sortItems(list.filter((it) => it.dir)),
            all: sortItems(list),
          }
        }
        const run = (retried) => ensureCurrent(id)
        .then(() => api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(dirParam)))
        .then((res) => {
          // External-switch defense: on an identity-echo mismatch the host is
          // no longer on the machine this fetch intended — bust the memo, force
          // one re-switch and retry ONCE. A mismatched listing is never cached.
          if (!echoMatches(id, res && res.machine)) {
            postedCurrentRef.current = ''
            if (retried) throw new Error(tr('project.machineChanged'))
            return run(true)
          }
          const node = toNode(res)
          if (lsGenRef.current.get(key) === gen) lsCacheRef.current.set(key, { at: Date.now(), node })
          return node
        })
        const p = run(false)
        .finally(() => { if (lsInflightRef.current.get(key) === p) lsInflightRef.current.delete(key) })
        lsInflightRef.current.set(key, p)
        return p
      }

      // Fresh session on every open: forget everything a previous open left
      // behind. A stale in-flight response must not repopulate the cache
      // (generation fence) and a stale suggestion response must not reopen the
      // dropdown on the now-live tree.
      const resetPickerFetchState = () => {
        pickerEpochRef.current++
        postedCurrentRef.current = ''
        lsCacheRef.current.clear()
        lsInflightRef.current.clear()
        lsGenRef.current.clear()
        suggestSeqRef.current++
      }

      const loadLevels = (id, p, toIndex) => {
        if (!id) return
        const epoch = pickerEpochRef.current
        const request = ++browseSeqRef.current
        const current = () => epoch === pickerEpochRef.current && request === browseSeqRef.current
        setLoading(true); setErr('')
        fetchDirList(id, p || '', true)
        .then((node) => {
          if (!current()) return
          setWin(node.platform)
          const level = { path: node.path, dirs: node.dirs, all: node.all }
          setLevels((prev) => {
            const base = prev && prev.length ? prev.slice() : []
            let idx = typeof toIndex === 'number' && toIndex >= 0 ? toIndex : base.length
            if (idx >= base.length) return base.concat([level])
            base[idx] = level
            return base.slice(0, idx + 1)
          })
        })
        .catch((e) => { if (current()) setErr(String(e.message || e)) })
        .finally(() => { if (current()) setLoading(false) })
      }

      const loadRegistry = () => {
        const epoch = pickerEpochRef.current
        setRegistryLoading(true); setErr('')
        api('GET', '/dsh-remote/machines').then((r) => {
          if (epoch !== pickerEpochRef.current) return
          setMachines(r.machines || [])
          const cur = (r.machines || []).find((m) => m.id === r.currentId)
          const selected = (r.machines || []).find((m) => m.id === initialMachineId) || cur
          setRecent((selected && selected.recentWorkspaces) || [])
          setMachineId(initialMachineId || r.currentId || (r.machines && r.machines[0] && r.machines[0].id) || '')
        }).catch((e) => { if (epoch === pickerEpochRef.current) setErr(String(e.message || e)) })
        .finally(() => { if (epoch === pickerEpochRef.current) setRegistryLoading(false) })
      }

      React.useEffect(() => { if (open) {
        // Bug fix: the picker must NOT reopen with the previous selection's
        // path — reset the path bar (and the browse state) on every open.
        setPath(''); setLevels(null); setWin(false); setPopOpen(false); setMOpen(false); killSuggestions()
        setChoosingProject(!initialMachineId)
        if (initialMachineId || initialTab === 'remote') setTab('remote')
        setLocalPop(null); setNewDirName('')
        // Fresh session: re-post /current on the first request and forget
        // everything a previous open left behind (TTL bounds staleness within
        // one open; reopening should see the live tree) — cached AND in-flight
        // listings, plus any pending suggestion response.
        resetPickerFetchState()
        if (suggestTimer.current) { clearTimeout(suggestTimer.current); suggestTimer.current = null }
        loadRegistry()
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
        if (busy) return
        killSuggestions()
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

      // Drop any pending suggestion response and close the dropdown.
      const killSuggestions = () => {
        suggestSeqRef.current++
        setSuggest([])
        setSuggestOpen(false)
      }

      // One seq-guarded "fetch listing → derive suggestion paths" pipeline
      // shared by loadSuggestions (typing: dirs matching a prefix) and
      // continueSuggest (expanding a picked dir: all its entries) — the
      // differing parts stay at the call sites as the `pick` parameter. Only
      // the newest request owns the dropdown: a slow older /ls must never
      // overwrite the suggestions for the text now in the input. The catch
      // keeps the seq-guarded empty fallback (a failed machine switch rejects
      // too, and must leave the dropdown closed and empty).
      const suggestFrom = (id, dirParam, pick, fresh) => {
        const seq = ++suggestSeqRef.current
        return fetchDirList(id, dirParam, fresh).then((node) => {
          if (seq !== suggestSeqRef.current) return
          const matches = pick(node).slice(0, 40)
          setSuggest(matches)
          setSuggestOpen(!!matches.length)
        }).catch(() => {
          if (seq !== suggestSeqRef.current) return
          setSuggest([]); setSuggestOpen(false)
        })
      }

      const loadSuggestions = (raw, mid) => {
        const id = mid || machineId
        const t = String(raw || '').trim()
        if (!id || !t) { killSuggestions(); return }
        // Separator-aware split: `\` when the input looks like a Windows path.
        const backslash = t.includes('\\') || /^[a-zA-Z]:/.test(t)
        const sep = backslash ? '\\' : '/'
        const idx = t.lastIndexOf(sep)
        let parent, lastSeg
        if (idx < 0) { parent = backslash ? t + '\\' : '/'; lastSeg = backslash ? '' : t }
        else if (idx === t.length - 1) { parent = t.slice(0, idx) || '/'; lastSeg = '' }
        else { parent = t.slice(0, idx) || '/'; lastSeg = t.slice(idx + 1) }
        suggestFrom(id, parent || '/', (node) => node.dirs
          .filter((it) => !lastSeg || it.name.toLowerCase().startsWith(String(lastSeg).toLowerCase()))
          .map((it) => it.path))
      }

      const onPathChange = (raw) => {
        setPath(raw); setErr(''); suggestSeqRef.current++; setSuggestOpen(false)
        if (suggestTimer.current) clearTimeout(suggestTimer.current)
        suggestTimer.current = setTimeout(() => loadSuggestions(raw), 220)
      }

      const continueSuggest = (dir) => {
        if (!machineId || !dir) { killSuggestions(); return }
        setSuggestOpen(false)
        const target = String(dir).replace(/[\\/]+$/, '') || '/'
        // Expanding a just-selected directory is a NAVIGATION step: the caching
        // spec only sanctions "typing inside one parent directory, local
        // filtering", so fetch fresh instead of serving up to 30s-stale entries.
        suggestFrom(machineId, target, (node) => node.all.map((it) => it.path), true)
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

      const commitPath = (p, selectedMachineId = machineId) => {
        const target = String(p || '').trim()
        if (!target || !selectedMachineId || busy) return
        setPopOpen(false); killSuggestions()
        return runPickerOperation('opening', async (signal, current) => {
          await ensureCurrent(selectedMachineId)
          if (!current()) return
          const res = await api('POST', '/dsh-remote/mirror', { path: target, machineId: selectedMachineId, registerWorkspace: registerWorkspace !== false }, signal)
          if (!current()) return
          if (!res || !res.localMirror) throw new Error((res && res.error) || tr('project.failed'))
          await onPicked(res.localMirror, res.path || target)
        })
      }

      const acceptBrowserPick = (p) => {
        setPath(String(p || ''))
        killSuggestions()
        setPopOpen(false)
      }

      const pickHome = () => {
        // Same identity contract as commitPath: /home is answered by the active
        // pool, so name the machine this picker is showing.
        const epoch = pickerEpochRef.current
        ensureCurrent(machineId)
          .then(() => api('POST', '/dsh-remote/home', { machineId }))
          .then((r) => {
            if (epoch !== pickerEpochRef.current) return
            if (r && r.home) { setPath(r.home); setErr(''); loadSuggestions(r.home) }
            else setErr((r && (r.hint || r.error)) || tr('picker.noHome'))
          }).catch((e) => { if (epoch === pickerEpochRef.current) setErr(String(e.message || e)) })
      }

      const mkdirHere = () => {
        const last = levels && levels.length ? levels[levels.length - 1] : null
        const base = (last && last.path) || '/'
        setMkdirPrompt({ base })
      }
      const confirmMkdirHere = (nm) => {
        const last = levels && levels.length ? levels[levels.length - 1] : null
        const base = (mkdirPrompt && mkdirPrompt.base) || (last && last.path) || '/'
        setMkdirPrompt(false)
        const name = String(nm || '').trim()
        if (!name) return
        const sep = base.includes('\\') ? '\\' : '/'
        const full = base === '/' ? '/' + name : base + sep + name
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
          onMouseDown: localBackdrop.onMouseDown,
          onClick: (e) => { if (localBackdrop.onClick(e)) setLocalPop(null) },
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
                    className: 'dsh-rw-list-item',
                    style: { padding: '7px 12px', cursor: 'pointer', color: T.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid ' + T.border },
                  },
                    // Same folder glyph as everywhere else when the host ships
                    // FileTypeIcon; the emoji stays as the no-primitive fallback.
                    React.createElement('span', { style: { display: 'inline-flex', flexShrink: 0 } }, HostFileTypeIcon ? React.createElement(HostFileTypeIcon, { kind: 'folder', size: 14 }) : '📁'),
                    React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.name),
                  )) : React.createElement('div', { style: { opacity: 0.6, padding: 12 } }, tr('picker.noSubdir'))),
              cur.truncated ? React.createElement('div', { style: { opacity: 0.6, padding: '6px 12px', fontSize: 11 } }, tr('picker.truncated')) : null,
            ),
            err ? React.createElement('div', { style: { color: T.danger, fontSize: 12, padding: '4px 12px' } }, err) : null,
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderTop: '1px solid ' + T.border } },
              React.createElement('input', { className: 'dsh-rw-input', value: newDirName, onChange: (e) => setNewDirName(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') mkdirLocal() }, placeholder: tr('picker.newFolder'), style: { ...inputS, width: 110, flex: '0 0 auto', padding: '4px 8px', fontSize: 12 } }),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '4px 10px', whiteSpace: 'nowrap' }, onClick: mkdirLocal, disabled: loading || !newDirName.trim() || !cur.path }, tr('picker.create')),
              React.createElement('span', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, tr('picker.selected', { path: cur.path })),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: { ...primaryBtnS, whiteSpace: 'nowrap' }, onClick: () => acceptLocalPick(cur.path) }, tr('picker.chooseThis')),
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
                  className: it.dir ? 'dsh-rw-list-item' : undefined,
                  style: { padding: '6px 10px', cursor: it.dir ? 'pointer' : 'default', color: T.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid ' + T.border },
                },
                  React.createElement('span', { style: { flexShrink: 0, display: 'inline-flex', color: T.label, fontSize: 13 } }, it.drive ? '💽' : (it.dir
                    ? IconFolder()
                    : IconFile(it.name))),
                  React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, it.name),
                  React.createElement('span', { style: { fontSize: 11, opacity: 0.55, flexShrink: 0, fontFamily: 'monospace' } }, it.dir ? '' : (humanSize(it.size) + (it.mtime ? '  ' + fmtTime(it.mtime) : ''))),
                )) : React.createElement('div', { style: { opacity: 0.6, padding: 12 } }, tr('picker.emptyDir'))),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', padding: '6px 10px', borderTop: '1px solid ' + T.border } },
            React.createElement('span', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, tr('picker.selected', { path: (last.path || (win ? tr('picker.driveRoot') : '/')) })),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => { acceptBrowserPick(last.path); setPopOpen(false) } }, tr('picker.chooseThis')),
          ),
        )
      }

      // Issue #97: the layered Escape, one home for both owners. The host's
      // modal layer (when shipped) drives it for us — focus trap, autofocus,
      // focus restore and the IME-composition guard included; without it, our
      // document listener below does the same cascade. The mask stays OURS:
      // the host Modal's mask dismisses on bare click, which the autocomplete
      // re-layout would turn into a mid-gesture close (issue #52).
      const dismissLayered = React.useCallback(() => {
        if (mkdirPrompt) return // the mkdir prompt owns Escape while open
        if (popOpen) { setPopOpen(false); return }
        if (suggestOpen) { suggestSeqRef.current++; setSuggestOpen(false); return }
        if (!externalBusy) closePicker()
      }, [mkdirPrompt, popOpen, suggestOpen, externalBusy, onCancel])
      // Conditional on a MODULE-level constant → hook order is stable forever.
      // The layer keeps a stack per document: the mkdir prompt's own Modal sits
      // above ours while open, so nested Escape reaches it first.
      const pickerLayerRef = React.useRef(null)
      React.useEffect(() => {
        if (!open) return
        const previous = document.activeElement
        const focus = () => pickerLayerRef.current?.querySelector('[data-modal-autofocus]:not(:disabled), button:not(:disabled)')?.focus()
        const timer = setTimeout(focus, 0)
        const trap = (e) => {
          if (useModalLayerFn || e.key !== 'Tab') return
          const nodes = Array.from(pickerLayerRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea, a[href], [tabindex="0"]') || []).filter((n) => n.getClientRects().length)
          if (!nodes.length) return
          if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes[nodes.length - 1].focus() }
          else if (!e.shiftKey && document.activeElement === nodes[nodes.length - 1]) { e.preventDefault(); nodes[0].focus() }
        }
        if (!useModalLayerFn) document.addEventListener('keydown', trap)
        return () => { clearTimeout(timer); document.removeEventListener('keydown', trap); if (!useModalLayerFn && previous && previous.isConnected) previous.focus() }
      }, [open])
      React.useEffect(() => {
        if (!open) return
        const timer = setTimeout(() => pickerLayerRef.current?.querySelector('[data-modal-autofocus]:not(:disabled)')?.focus(), 0)
        return () => clearTimeout(timer)
      }, [open, choosingProject, tab])

      if (useModalLayerFn) {
        try { useModalLayerFn(pickerLayerRef, open, dismissLayered) } catch { /* a partial face degrades to our own listener */ }
      }

      React.useEffect(() => {
        if (!open) return
        try {
          if (typeof document === 'undefined') return
          const onKey = (e) => {
            // The host modal layer owns Escape when present (composition-safe,
            // focus-aware); ours only handles it where the layer is absent.
            if (!useModalLayerFn && e.key === 'Escape') {
              e.preventDefault()
              dismissLayered()
              return
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              if (busy || e.isComposing || e.keyCode === 229 || popOpen || mkdirPrompt) return
              e.preventDefault()
              if (tab === 'local' && path.trim()) onPicked(path)
              else if (tab === 'remote' && path.trim()) commitPath(path)
            }
          }
          document.addEventListener('keydown', onKey)
          return () => document.removeEventListener('keydown', onKey)
        } catch { return undefined }
      }, [open, busy, tab, path, machineId, popOpen, suggestOpen, mkdirPrompt, dismissLayered])

      if (!open) return null
      const tabBtn = (t, lbl) => React.createElement('button', {
        type: 'button',
        className: 'dsh-rw-btn dsh-rw-tab' + (tab === t ? ' is-active' : ''),
        onClick: () => switchTab(t),
        style: { ...buttonS, fontWeight: tab === t ? 700 : 400, padding: '5px 14px' },
      }, lbl)
      return portalize(React.createElement('div', {
        // Match the host Modal's 1000 layer: newer host dialogs must remain above us.
        style: { position: 'fixed', inset: 0, zIndex: useModalLayerFn ? 1000 : 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
        onMouseDown: backdrop.onMouseDown,
        // Issue #52 defect 1: this was a bare onClick, so picking an autocomplete
        // suggestion (mousedown inside the panel, panel re-laid-out, mouseup on
        // the backdrop) closed the whole dialog. Only a press that began on the
        // backdrop dismisses now.
        onClick: (e) => { if (backdrop.onClick(e) && !externalBusy && !mkdirPrompt) closePicker() },
      },
        React.createElement('div', { ref: pickerLayerRef, tabIndex: -1, role: 'dialog', 'aria-modal': true, 'aria-labelledby': suggestListId + '-title', className: 'dsh-rw-modal-panel', style: { background: v('--dsw-alias-bg-layer-1', '#18181b'), color: T.label, border: '1px solid ' + T.borderStrong, borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,0.5)', width: 'min(600px, 94vw)', maxHeight: 'min(680px, 92vh)', display: 'flex', flexDirection: 'column', padding: 16, boxSizing: 'border-box' }, onClick: (e) => e.stopPropagation() },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
          React.createElement('div', { id: suggestListId + '-title', style: { fontSize: 15, fontWeight: 650 } }, tr('picker.title')),
          React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' }, onClick: closePicker, disabled: !!externalBusy }, tr('picker.close')),
        ),
        // 本机/远程 switch: host SegmentedTabs when the bundle ships one
        // (sliding-indicator tablist, roving tabindex and arrow-key navigation
        // baked in); onChange delivers the item value, which is exactly what
        // switchTab consumes. Older hosts keep the hand-rolled button pair.
        HostSegmentedTabs
          ? React.createElement('div', { style: { marginBottom: 10, alignSelf: 'flex-start' } },
              React.createElement(HostSegmentedTabs, {
                items: [
                  { value: 'local', label: tr('picker.tabLocal') },
                  { value: 'remote', label: tr('picker.tabRemote') },
                ],
                value: tab,
                onChange: switchTab,
                label: tr('picker.title'),
              }))
          : React.createElement('div', { className: 'dsh-rw-tabs', style: { marginBottom: 10, alignSelf: 'flex-start' } },
              tabBtn('local', tr('picker.tabLocal')),
              tabBtn('remote', tr('picker.tabRemote'))),
        tab === 'local'
          ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              React.createElement('div', { style: { fontSize: 12, opacity: 0.8, lineHeight: 1.5 } }, tr('picker.localIntro')),
              React.createElement('div', { style: { display: 'flex', gap: 6 } },
                React.createElement('input', { className: 'dsh-rw-input', value: path, onChange: (e) => setPath(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter' && path.trim()) { e.preventDefault(); onPicked(path) } }, placeholder: tr('picker.localPlaceholder'), 'data-modal-autofocus': true, style: inputS }),
                React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => (path.trim() ? onPicked(path) : undefined), disabled: !path.trim() }, tr('picker.useLocalPath')),
              ),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, alignSelf: 'flex-start' }, onClick: chooseLocal, disabled: loading }, loading ? tr('picker.opening') : tr('picker.openSysPicker')),
              err ? React.createElement(ProjectOpenError, { error: err }) : null,
              localPop ? renderLocalPopup() : null,
            )
          : (choosingProject && !path)
            ? React.createElement(RemoteProjectChooser, {
                machines, busy, registryLoading,
                onMachine: (m, list) => {
                  if (!m) { setErr(tr('project.failed')); return }
                  if (list) setMachines(list)
                  resetPickerFetchState(); killSuggestions()
                  setMachineId(m.id); setRecent(m.recentWorkspaces || []); setLevels(null); setPath(''); setErr(''); setChoosingProject(false)
                },
                onProject: (m, p) => { setMachineId(m.id); setRecent(m.recentWorkspaces || []); setPath(p); setChoosingProject(false); commitPath(p, m.id) },
              })
            : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: 'auto' } },
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', disabled: busy, style: { ...buttonS, alignSelf: 'flex-start', fontSize: 12 }, onClick: () => { killSuggestions(); resetPickerFetchState(); setPath(''); setChoosingProject(true) } }, '‹ ' + tr('project.back')),
              React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                React.createElement('label', { style: { fontSize: 12, opacity: 0.8, whiteSpace: 'nowrap' } }, tr('picker.remoteMachine')),
                React.createElement('div', { ref: ddRef, style: { position: 'relative', display: 'inline-block' } },
                  React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...inputS, textAlign: 'left', cursor: 'pointer', minWidth: 200, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, disabled: busy, onClick: () => setMOpen((x) => !x) },
                    (machines.find((m) => m.id === machineId) || {}).name || (machineId ? '…' : tr('picker.chooseMachine')),
                  ),
                  mOpen
                    ? React.createElement('div', { style: { position: 'absolute', top: '100%', left: 0, zIndex: 1000, marginTop: 2, minWidth: 300, maxHeight: 260, overflow: 'auto', background: v('--dsw-alias-bg-overlay', '#1f1f23'), color: T.label, border: '1px solid ' + T.border, borderRadius: T.radius, padding: 4 } },
                        machines.length
                          ? machines.map((m) => React.createElement('div', { key: m.id, className: 'dsh-rw-list-item', onClick: () => { setMachineId(m.id); setRecent(m.recentWorkspaces || []); setLevels(null); setPath(''); setMOpen(false); resetPickerFetchState(); killSuggestions(); setLoading(false); setErr(''); if (m.id) loadLevels(m.id, '', 0) }, style: { padding: '6px 8px', borderRadius: 4, cursor: 'pointer', color: m.id === machineId ? T.ok : 'inherit' } }, m.name + '  (' + m.username + '@' + m.host + ':' + m.port + ')'))
                          : React.createElement('div', { style: { padding: 6, opacity: 0.6 } }, tr('picker.noMachines')),
                      )
                    : null,
                ),
              ),
              recent.length ? React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap' } }, tr('picker.recent')),
                recent.map((w, i) => React.createElement('button', { type: 'button', className: 'dsh-rw-btn', key: w + i, onClick: () => { setPath(w); setErr(''); continueSuggest(w) }, style: { ...buttonS, padding: '2px 8px', fontSize: 11, fontFamily: 'monospace' } }, w))) : null,
              React.createElement('div', { ref: suggestRef, style: { position: 'relative' } },
                React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  React.createElement('input', {
                    className: 'dsh-rw-input',
                    value: path,
                    onChange: (e) => onPathChange(e.target.value),
                    onFocus: () => loadSuggestions(path),
                    role: 'combobox',
                    'aria-label': win ? tr('picker.pathPlaceholderWin') : tr('picker.pathPlaceholder'),
                    'aria-autocomplete': 'list',
                    'aria-expanded': suggestOpen && !!suggest.length,
                    'aria-controls': suggestOpen && suggest.length ? suggestListId : undefined,
                    'aria-activedescendant': suggestOpen && suggest.length ? suggestListId + '-' + activeSuggestion : undefined,
                    onKeyDown: (e) => {
                      // Composition Enter belongs to the IME; modified Enter is
                      // handled once by the modal's workspace shortcut.
                      if (busy || e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey) return
                      if (e.key === 'Escape') {
                        e.preventDefault(); e.stopPropagation()
                        if (suggestTimer.current) clearTimeout(suggestTimer.current)
                        if (suggestOpen) killSuggestions()
                        else dismissLayered()
                      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        if (!suggestOpen || !suggest.length) { loadSuggestions(path); return }
                        setSuggestIndex((activeSuggestion + (e.key === 'ArrowDown' ? 1 : -1) + suggest.length) % suggest.length)
                      } else if (e.key === 'Enter') {
                        e.preventDefault(); e.stopPropagation()
                        if (suggestOpen && suggest.length) selectSuggestion(suggest[activeSuggestion])
                        else if (path.trim()) commitPath(path)
                      }
                    },
                    placeholder: (machineId ? (win ? tr('picker.pathPlaceholderWin') : tr('picker.pathPlaceholder')) : tr('picker.chooseMachineFirst')),
                    disabled: !machineId || busy, 'data-modal-autofocus': true, style: { ...inputS, flex: 1, minWidth: 120 },
                  }),
                  React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, whiteSpace: 'nowrap' }, onClick: () => { if (!machineId) return; const p = path.trim(); loadLevels(machineId, p || '', 0); setPopOpen(true) }, disabled: !machineId || busy }, tr('picker.browse')),
                  React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, whiteSpace: 'nowrap' }, onClick: pickHome, disabled: !machineId || busy }, tr('picker.home')),
                ),
                // Reserve the same space with or without results: suggestions
                // never move the dialog or sit beneath the workspace action.
                React.createElement('div', { className: 'dsh-rw-suggestions', style: { position: 'relative', height: 'min(180px, 25vh)', marginTop: 8, border: '1px solid ' + T.border, borderRadius: 8, background: T.bg } },
                (suggestOpen && suggest.length)
                  ? React.createElement('div', { id: suggestListId, role: 'listbox', 'aria-label': tr('picker.pathPlaceholder'), style: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, zIndex: 60, background: v('--dsw-alias-bg-overlay', '#1e1e1e'), color: T.label, borderRadius: 8, maxHeight: 200, overflowY: 'auto' } },
                      // Issue #52 defect 1, local belt-and-braces: swallow the
                      // gesture so no ancestor (least of all the backdrop) can
                      // observe a click that began on a suggestion.
                      suggest.map((s, i) => React.createElement('div', { key: s + i, id: suggestListId + '-' + i, role: 'option', 'aria-selected': i === activeSuggestion, onMouseEnter: () => setSuggestIndex(i), className: 'dsh-rw-list-item', onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); selectSuggestion(s) }, style: { padding: '6px 10px', background: i === activeSuggestion ? T.hoverBg : undefined, cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s)),
                    )
                  : React.createElement('div', { style: { padding: '24px 16px', color: T.muted, fontSize: 12, lineHeight: 1.6, textAlign: 'center' } }, tr('picker.suggestionsHint')),
                ),
              ),
              popOpen ? renderDirPopup() : null,
              err ? React.createElement(ProjectOpenError, { error: err }) : null,
              // The action stays below the reserved results region, in a
              // separate opaque layer with a stable hit target.
              React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', position: 'relative', zIndex: 70, background: v('--dsw-alias-bg-layer-1', '#18181b') } },
                React.createElement('span', { title: path, style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, path ? tr('picker.selected', { path }) : ''),
                React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => commitPath(path), disabled: busy || !machineId || !path.trim() }, busy ? tr('project.opening') : tr('picker.setRemoteWs')),
              ),
            ),
        choosingProject && !path && err ? React.createElement('div', {},
          React.createElement(ProjectOpenError, { error: err }),
          React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, marginTop: 6 }, onClick: loadRegistry, disabled: registryLoading }, tr('project.retry'))) : null,
        operationPhase ? React.createElement('div', { role: 'status', 'aria-live': 'polite', style: { display: 'flex', gap: 8, alignItems: 'center', paddingTop: 10, fontSize: 12 } },
          React.createElement('span', { style: { flex: 1, color: T.muted } }, tr('project.opening')),
          React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => { cancelOperation(); setErr(tr('project.cancelled')) } }, tr('project.cancel'))) : null,
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 11, color: T.muted, paddingTop: 8 } },
          (tab === 'remote' ? tr('picker.hintKeys') : 'Enter · Esc').split(' · ').map((hint) => React.createElement('span', { key: hint, style: { whiteSpace: 'nowrap' } }, hint))),
        (tab === 'local') ? React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } }, React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: onCancel }, tr('picker.cancel'))) : null,
        mkdirPrompt ? React.createElement(PromptDialog, {
          title: tr('picker.newDirName', { path: mkdirPrompt.base || '/' }),
          placeholder: tr('explorer.namePlaceholder'),
          onSubmit: confirmMkdirHere,
          onCancel: () => setMkdirPrompt(false),
        }) : null,
        ),
      ))
    }

    // ── better-sidebar integration (optional) ────────────────────────────────
    // One descriptor only: the explorer page. The per-file viewer is a native
    // resource type, never a better-sidebar card (see registerSidebarIntegration).
    const SIDEBAR_EXPLORER_ID = 'dsh-remote:explorer'

    // Issue #78 + #119: durable opt-out for BOTH sidebar worlds. localStorage
    // remains a fallback/migration source, but it is origin-scoped and tether can
    // give the same DSH_HOME a fresh origin. The host file is authoritative once
    // set; the first auto-open waits for this shared value instead of racing a
    // late `enabled:false` and popping the panel before it arrives.
    const EXPLORER_AUTO_OPEN_KEY = 'dsh-remote:explorerAutoOpen'
    const EXPLORER_AUTO_OPEN_ROUTE = '/dsh-remote/explorer-auto-open'
    let explorerAutoEffective = true
    let explorerAutoPreferencePromise = null
    let explorerAutoPreferenceRevision = 0
    function localExplorerAutoOpenPreference() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return null
        const value = window.localStorage.getItem(EXPLORER_AUTO_OPEN_KEY)
        return value === '0' ? false : value === '1' ? true : null
      } catch { return null }
    }
    explorerAutoEffective = localExplorerAutoOpenPreference() ?? true
    function explorerAutoOpenEnabled() { return explorerAutoEffective }
    function explorerAutoOpenPreference() {
      if (explorerAutoPreferencePromise) return explorerAutoPreferencePromise
      const revision = explorerAutoPreferenceRevision
      const local = localExplorerAutoOpenPreference()
      if (local !== null) explorerAutoEffective = local
      explorerAutoPreferencePromise = api('GET', EXPLORER_AUTO_OPEN_ROUTE).then((r) => {
        // A user click after this request started always wins over its response.
        if (revision !== explorerAutoPreferenceRevision) return explorerAutoEffective
        if (r && typeof r.enabled === 'boolean') {
          if (r.persisted === true) {
            explorerAutoEffective = r.enabled
          } else if (local !== null) {
            // Upgrade path: the host has no explicit choice yet. Carry this
            // origin's old value into DSH_HOME; a failed migration still leaves
            // the local fallback in force for this run.
            explorerAutoEffective = local
            void api('POST', EXPLORER_AUTO_OPEN_ROUTE, { enabled: local }).catch(() => {})
          } else {
            explorerAutoEffective = r.enabled
          }
        } else if (local !== null) {
          explorerAutoEffective = local
        }
        return explorerAutoEffective
      }).catch(() => {
        // Host unreachable is not permission to ignore an explicit local OFF.
        if (revision === explorerAutoPreferenceRevision && local !== null) explorerAutoEffective = local
        return explorerAutoEffective
      })
      return explorerAutoPreferencePromise
    }
    function updateExplorerAutoOpenPreference(on) {
      explorerAutoPreferenceRevision++
      explorerAutoEffective = on
      try { window.localStorage.setItem(EXPLORER_AUTO_OPEN_KEY, on ? '1' : '0') } catch { /* session-only fallback */ }
      // Keep a working local fallback if the host is temporarily unreachable.
      return api('POST', EXPLORER_AUTO_OPEN_ROUTE, { enabled: on }).catch(() => null)
    }

    function fetchRemoteStatus(sessionId) {
      return api('GET', withSessionQuery('/dsh-remote/status', sessionId)).catch(() => null)
    }

    // Resolve the remote path this session shows. Issue #13: the ONLY source
    // of truth is the session's own cwd mapped through /dsh-remote/resolve-
    // mirror — a cwd outside any mirror dir means "this session is NOT a
    // remote session", and the sidebar must NOT fall back to the machine
    // workspace (that made an unrelated saved machine leak into local
    // sessions).
    function resolveSessionRemote(sessionId, strict = false) {
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
          .catch((e) => { if (strict) throw e; return '' })
      }
      // 2) Fall back to host-side session header cwd.
      return api('GET', '/dsh-remote/resolve-mirror?sessionId=' + encodeURIComponent(sessionId))
        .then((r) => (r && r.remotePath) || '')
        .catch((e) => { if (strict) throw e; return '' })
    }

    // ── which sessions are remote (issue #49) ────────────────────────────────
    //
    // The sidebar must say, at a glance, whether a Session row is a LOCAL
    // session or one working on a remote host — and which host. The truth is
    // already on the client: every Session summary carries its own cwd, and a
    // cwd that lives inside a `$DSH_HOME/remote-workspaces/<host-user-port>/…`
    // mirror IS a remote session bound to that mirror's recorded origin (the
    // same invariant lib/binding.js uses host-side; see issue #13).
    //
    // So one GET /dsh-remote/bindings (the whole mirror registry, with each
    // mirror's recorded host/port/user/path) answers every row, instead of one
    // request per row. The active machine is deliberately NOT consulted: a saved
    // machine that happens to be "current" must never label a local session.
    //
    // Failure is not fatal and not retried in a loop: no registry means no
    // badge, which is exactly what a user with zero mirrors sees.

    const MIRRORS = { list: [], loaded: false, error: '' }
    const mirrorWatchers = new Set()
    let mirrorLoad = null
    let mirrorTimer = null

    const notifyMirrors = () => {
      for (const fn of mirrorWatchers) { try { fn() } catch { /* one watcher must not stop the rest */ } }
    }
    /** Load the mirror registry once (concurrent callers share the request). */
    function ensureMirrors() {
      if (MIRRORS.loaded) return Promise.resolve(MIRRORS)
      if (mirrorLoad) return mirrorLoad
      mirrorLoad = api('GET', '/dsh-remote/bindings')
        .then((r) => {
          MIRRORS.list = (r && Array.isArray(r.mirrors)) ? r.mirrors : []
          MIRRORS.error = ''
        })
        .catch((e) => { MIRRORS.error = String((e && e.message) || e) })
        .then(() => {
          MIRRORS.loaded = true
          mirrorLoad = null
          notifyMirrors()
          return MIRRORS
        })
      return mirrorLoad
    }
    /** Force a refresh (mirrors appear when a workspace is picked). */
    function refreshMirrors() {
      MIRRORS.loaded = false
      return ensureMirrors()
    }
    /**
     * The mirror containing a local path, or null.
     *
     * Separator-aware on purpose: `/a/mirror-2` must NOT be treated as living
     * inside `/a/mirror` (the same trap lib/binding.js documents). The deepest
     * match wins, so a future nested layout stays stable. Windows paths compare
     * case-insensitively because the platform does.
     */
    function mirrorForCwd(cwd, mirrors) {
      const raw = String(cwd || '')
      if (!raw) return null
      const list = Array.isArray(mirrors) ? mirrors : []
      const isWin = raw.includes('\\')
      const sep = isWin ? '\\' : '/'
      const fold = (s) => (isWin ? s.toLowerCase() : s)
      const base = fold(raw.replace(/[\\/]+$/, ''))
      let best = null
      for (const m of list) {
        const dirRaw = String((m && m.dir) || '').replace(/[\\/]+$/, '')
        if (!dirRaw) continue
        const dir = fold(dirRaw)
        if (base !== dir && !base.startsWith(dir + sep) && !base.startsWith(dir + '/')) continue
        if (!best || dir.length > fold(String(best.dir).replace(/[\\/]+$/, '')).length) best = m
      }
      return best
    }
    // Server identity colors are independent of SSH health and workspace path.
    // Persist allocations per browser so adding a server never recolors old ones.
    const serverPalette = ['#5489d8', '#a579d5', '#d99a45', '#49a5ab', '#d8799c', '#858ed2', '#91a650', '#c5825c']
    const serverColorKey = 'dsh-remote.server-colors.v1'
    let serverColors = {}
    try {
      const saved = JSON.parse(localStorage.getItem(serverColorKey) || '{}')
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [key, value] of Object.entries(saved)) {
          if (/^#[0-9a-f]{6}$/i.test(value)) serverColors[key] = value
        }
      }
    } catch { /* storage may be unavailable */ }
    function mirrorColor(m) {
      // Ignore username: two accounts on the same endpoint are one server.
      const key = JSON.stringify([String(m.host || '').trim().toLowerCase(), Number(m.port) || 22])
      if (serverColors[key]) return serverColors[key]
      let hash = 2166136261
      for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0
      const used = new Set(Object.values(serverColors))
      const start = hash % serverPalette.length
      let color = serverPalette[start]
      for (let i = 0; i < serverPalette.length; i++) {
        const candidate = serverPalette[(start + i) % serverPalette.length]
        if (!used.has(candidate)) { color = candidate; break }
      }
      serverColors[key] = color
      try { localStorage.setItem(serverColorKey, JSON.stringify(serverColors)) } catch { /* memory fallback */ }
      return color
    }
    /** `user@host:port` for a mirror record (port omitted when it is 22). */
    function mirrorTarget(m) {
      if (!m) return ''
      const user = m.username ? m.username + '@' : ''
      const port = Number(m.port) && Number(m.port) !== 22 ? ':' + m.port : ''
      return user + String(m.host || '') + port
    }
    /** Host as the reader asked for it: the address, plus the saved machine name. */
    function mirrorLabel(m) {
      if (!m) return ''
      const target = mirrorTarget(m)
      return m.name && m.name !== m.host ? target + ' · ' + m.name : target
    }
    /**
     * The remote binding of one Session row, read from that row's own cwd.
     *
     * A row with no cwd (a blank New Session) is not remote — a blank session
     * has no workspace yet, and must never inherit the badge from a neighbor.
     *
     * Hook shape is CONSTANT: when the framework does not hand the entry a
     * `useSessions` (older sidebar), a stable no-op hook is selected instead of
     * skipping the call, so the hook count cannot change across renders (a
     * conditional hook is a crash, not a degraded badge).
     */
    const NO_SELECT = () => undefined
    function useSessionMirror(sessionId, useSessions) {
      // `mirrorVersion` is only a re-render trigger: the registry arrives
      // asynchronously, and every mounted mark must repaint when it does.
      const [, bumpMirrorVersion] = React.useState(0)
      const select = typeof useSessions === 'function' ? useSessions : NO_SELECT
      const cwd = select((s) => (sessionId && s && s.byId && s.byId[sessionId] ? s.byId[sessionId].cwd : undefined))
      React.useEffect(() => {
        const fn = () => bumpMirrorVersion((n) => n + 1)
        mirrorWatchers.add(fn)
        ensureMirrors()
        // Mirrors change when a remote workspace is picked in THIS tab; a slow
        // poll covers a pick made in another tab without a per-render request.
        if (!mirrorTimer && typeof setInterval === 'function') {
          mirrorTimer = setInterval(refreshMirrors, 60000)
        }
        return () => {
          mirrorWatchers.delete(fn)
          if (!mirrorWatchers.size && mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null }
        }
      }, [])
      return mirrorForCwd(cwd, MIRRORS.list)
    }

    // Leading seat of a Session row: the 16px cell before the title. A colored dot
    // identifies the remote server (not connection health); a local session renders
    // nothing at all, so the cell stays blank exactly as before. The owner only
    // mounts this seat while the row is idle (a running/pending row keeps its
    // own status dot there) — the hover card below therefore carries the host
    // for every row, running or not.
    function RemoteSessionMark(props) {
      const m = useSessionMirror(props.sessionId, props.useSessions)
      if (!m) return null
      const target = mirrorTarget(m)
      return React.createElement('span', {
        'data-dsh-remote-mark': '',
        role: 'img',
        'aria-label': tr('session.remoteBadge', { target }),
        title: tr('session.remoteBadge', { target }) + (m.remotePath ? '\n' + m.remotePath : ''),
        style: { width: 16, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
      }, React.createElement('span', {
        'aria-hidden': 'true',
        style: {
          width: 8, height: 8, borderRadius: '50%',
          background: mirrorColor(m),
          boxShadow: '0 0 0 2px color-mix(in srgb, ' + mirrorColor(m) + ' 22%, transparent)',
        },
      }))
    }

    // Hover-card section of a Session row, between its relative time and its
    // trailing status line: names the remote host (and the remote path it
    // works on) for a remote row. A local row renders nothing.
    function RemoteSessionHover(props) {
      const m = useSessionMirror(props.sessionId, props.useSessions)
      if (!m) return null
      return React.createElement('div', { 'data-dsh-remote-hover': '', style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, lineHeight: '16px' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          React.createElement('span', {
            'aria-hidden': 'true',
            style: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: mirrorColor(m) },
          }),
          React.createElement('span', { style: { color: '#cfd3d6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, mirrorLabel(m)),
        ),
        m.remotePath
          ? React.createElement('div', { style: { color: '#adb2b8', wordBreak: 'break-all', paddingLeft: 13 } }, m.remotePath)
          : null,
      )
    }

    // Conversation header chip for the CURRENT session: the one place the host
    // can stay visible without hovering anything (the row's 16px cell is too
    // narrow for an address). Renders nothing for a local session.
    //
    // This seat is session-scoped, so the owner hands the entry its `sessionId`
    // (exactly like the shipped "open in app" utility) and the chip needs
    // nothing from the sidebar.
    function RemoteSessionChip(props) {
      const m = useSessionMirror(props.sessionId, props.useSessions)
      // Native-right-column counterpart of the better-sidebar auto-open (#78):
      // this chip mounts exactly when a session is on screen, making it the
      // trigger for "a remote session on screen surfaces its remote files".
      // When better-sidebar is installed it owns the presentation (the
      // guide-card handshake arbitrates that); never open twice.
      React.useEffect(() => {
        if (!m || !props.sessionId) return undefined
        if (explorerOwnedByBs) return undefined
        if (autoOpenedNative.has(props.sessionId)) return undefined
        const right = SIDEBAR_RIGHT
        if (!right || typeof right.openTab !== 'function') return undefined
        let cancelled = false
        const sessionId = props.sessionId
        void explorerAutoOpenPreference().then((enabled) => {
          if (cancelled || !enabled || explorerOwnedByBs || autoOpenedNative.has(sessionId)) return
          autoOpenedNative.add(sessionId)
          try {
            right.openTab(NATIVE_EXPLORER)
          } catch {
            autoOpenedNative.delete(sessionId) // unregistered kind, etc: retry next time
          }
        })
        return () => { cancelled = true }
      }, [m, props.sessionId])
      if (!m) return null
      const target = mirrorTarget(m)
      return React.createElement(SIDEBAR_RIGHT && typeof SIDEBAR_RIGHT.openTab === 'function' ? 'button' : 'span', {
        type: 'button',
        onClick: () => { if (SIDEBAR_RIGHT && typeof SIDEBAR_RIGHT.openTab === 'function') SIDEBAR_RIGHT.openTab(NATIVE_EXPLORER) },
        'data-dsh-remote-chip': '',
        className: 'dsh-rw-pill dsh-rw-btn',
        title: tr('session.remoteHover', { target }) + (m.remotePath ? '\n' + m.remotePath : ''),
        style: { background: 'transparent', cursor: SIDEBAR_RIGHT ? 'pointer' : 'default', color: mirrorColor(m), borderColor: 'currentColor', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-flex', alignItems: 'center', gap: 5 },
      },
        React.createElement('span', {
          'aria-hidden': 'true',
          style: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: mirrorColor(m) },
        }),
        React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, target),
      )
    }

    function readRemoteFile(path, maxBytes, sessionId) {
      return api('POST', '/dsh-remote/read', withSessionBody({ path, maxBytes }, sessionId)).catch((e) => {
        throw new Error(tr('file.readFail', { msg: ((e && e.message) || e) }))
      })
    }

    function listRemoteDir(path, sessionId) {
      return api('GET', withSessionQuery('/dsh-remote/ls?path=' + encodeURIComponent(path || ''), sessionId)).catch((e) => {
        throw new Error(tr('file.listFail', { msg: ((e && e.message) || e) }))
      })
    }

    function joinRemote(base, name) {
      if (!base) return name
      return base.replace(/[\\/]+$/, '') + (base.includes('\\') ? '\\' : '/') + name
    }

    // ── Remote explorer tab ────────────────────────────────────────────────
    // Row glyphs: the host FileTypeIcon when the bundle ships one —
    // directories take its 'folder' kind (the host glyph has no open/closed
    // variant, matching our old SVG which drew the same path for both states),
    // files derive the kind from the file name (an unknown extension lands on
    // the 'other' glyph). Older hosts keep the inline monochrome SVGs
    // (fill: currentColor → follows the row text color, i.e. black on the
    // sidebar). The (open)/(name) parameters survive so call sites stay
    // meaningful on both paths.
    const IconFolder = (open) => HostFileTypeIcon
      ? React.createElement(HostFileTypeIcon, { kind: 'folder', size: 14 })
      : React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', style: { flexShrink: 0 },
      },
        React.createElement('path', { d: 'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2a1.5 1.5 0 0 1 1.06.44L8.5 3.7h4.5A1.5 1.5 0 0 1 14.5 5.2V12A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5Zm2.5 1a.5.5 0 0 0 0 1h1.2a.5.5 0 0 0 0-1H4Z' }),
      )
    const IconFile = (name) => HostFileTypeIcon
      ? React.createElement(HostFileTypeIcon, { path: String(name || ''), size: 14 })
      : React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', style: { flexShrink: 0, opacity: 0.85 },
      },
        React.createElement('path', { d: 'M3.5 1.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5.2a1 1 0 0 0-.29-.7L10.5 1.79a1 1 0 0 0-.7-.29H3.5Zm1.5 3h2.25a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5ZM5 9.5h6a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5Zm0 2.25h4a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5Z' }),
      )

    // Issue #32: the remote tree's expansion list travels on the TAB (`meta`),
    // never on better-sidebar's session-shared `expanded` array. Best-effort:
    // an older sidebar without tab meta simply forgets the expansion on reload.
    const TAB_EXPANDED_META = 'remoteExpanded'
    /** The tab's persisted expansion list, or null when the tab records none
     *  (so a caller can tell "never expanded" from "expanded then collapsed
     *  everything"). */
    function readTabExpanded(tab) {
      try {
        const meta = tab && tab.meta
        if (!meta || typeof meta !== 'object' || !(TAB_EXPANDED_META in meta)) return null
        const list = meta[TAB_EXPANDED_META]
        return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
      } catch { return null }
    }
    /** Fallback store when the sidebar predates tab meta (no persistence then,
     *  but the tree still opens and closes within the page's lifetime). */
    const tabExpandedFallback = new Map()
    function tabExpandedOf(tab) {
      const fromMeta = readTabExpanded(tab)
      if (fromMeta !== null) return fromMeta
      const id = tab && tab.id
      return (id && tabExpandedFallback.get(id)) || []
    }
    function toggleTabExpanded(ctx, tab, path) {
      const cur = tabExpandedOf(tab)
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]
      const id = tab && tab.id
      if (id) tabExpandedFallback.set(id, next)
      try {
        if (!ctx || !tab || !id || typeof ctx.get !== 'function') return next
        const bs = ctx.get('betterSidebar')
        if (!bs || typeof bs.updateTab !== 'function') return next
        const meta = tab.meta && typeof tab.meta === 'object' ? tab.meta : {}
        bs.updateTab(id, { meta: { ...meta, [TAB_EXPANDED_META]: next } })
      } catch { /* expansion memory is best-effort */ }
      return next
    }

    // Issue #32 healing, kept pure so it is directly testable: an older
    // dsh-remote pushed REMOTE paths into better-sidebar's session-shared
    // `expanded` set through onToggleDir. That set is PERSISTED (localStorage
    // `dsh-sidebar:v1:<sessionId>`) and the built-in local Files tree loads
    // every entry through a LOCAL fs.realpath, so those remote paths kept
    // failing with ENOENT until the set was cleaned.
    //
    // Return exactly the entries this tree owns: the current remote root and
    // anything under it. That range is remote-only by construction (the root
    // comes from resolve-mirror), so a legitimate local directory cannot
    // match. A LOCAL MIRROR path is never evicted — on a host whose own home is
    // an ancestor of the remote root (a macOS host driving a macOS remote) the
    // mirror under $DSH_HOME/remote-workspaces would otherwise fall inside it.
    //
    // On a WINDOWS host the sweep is broader and complete: a POSIX-absolute
    // entry (`/home/...`) can never be a valid local path there (Windows paths
    // are drive- or UNC-rooted), which is exactly why the bug only bit Windows.
    // That also cleans pollution left by an earlier remote root, which no
    // per-root rule could find.
    function isPosixAbsolutePath(p) {
      return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//')
    }
    function windowsHost() {
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : null
        if (!nav) return false
        if (nav.userAgentData && typeof nav.userAgentData.platform === 'string') {
          return /win/i.test(nav.userAgentData.platform)
        }
        if (typeof nav.platform === 'string' && nav.platform) return /win/i.test(nav.platform)
        return typeof nav.userAgent === 'string' && /windows/i.test(nav.userAgent)
      } catch { return false }
    }
    function strayRemoteSharedPaths(root, shared, hostIsWindows = windowsHost()) {
      if (!Array.isArray(shared) || !shared.length) return []
      let prefix = ''
      if (typeof root === 'string' && root !== '' && root !== '/') prefix = root.replace(/[\\/]+$/, '')
      const isMirror = (p) => p.includes('/remote-workspaces/') || p.includes('\\remote-workspaces\\')
      return shared.filter((p) => {
        if (typeof p !== 'string' || p === '' || isMirror(p)) return false
        if (prefix !== '' && (p === prefix || p === root ||
          p.startsWith(prefix + '/') || p.startsWith(prefix + '\\'))) return true
        return hostIsWindows && isPosixAbsolutePath(p)
      })
    }

    // Issue #32: the remote tree must NOT use better-sidebar's `expanded` /
    // `onToggleDir` props. That pair is the SESSION-shared expansion set, which
    // the built-in local Files tree also reads and loads as local directories
    // through /sidebar/api fs.tree. Feeding it remote paths (/home/...) made the
    // core tree run a LOCAL fs.realpath on them; on win32 a POSIX path counts as
    // absolute (drive-rooted), so it resolved to `D:\home\...` and failed with
    // ENOENT. Own the expansion here and persist it on the tab instead.
    //
    // Because that shared set is PERSISTED, an already-affected user stays
    // broken across reloads, so the stray entries are also migrated eagerly (see
    // migratePollutedSidebarState) and healed again from the tab (below).
    const SIDEBAR_STATE_PREFIX = 'dsh-sidebar:v1:'
    /**
     * Strip remote paths a pre-fix dsh-remote left in PERSISTED sidebar state,
     * before the built-in Files tree loads them. Only entries that cannot be a
     * valid local path on this host are removed (see strayRemoteSharedPaths).
     * Best-effort: any storage failure just leaves the tab-level healing to do
     * the job on the next load.
     *
     * @param storage - a Storage-like object (window.localStorage).
     * @param hostIsWindows - overrides host detection (tests).
     * @returns how many stray entries were removed.
     */
    function migratePollutedSidebarState(storage, hostIsWindows = windowsHost()) {
      if (!storage || typeof storage.length !== 'number') return 0
      let cleaned = 0
      try {
        const keys = []
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i)
          if (key && key.startsWith(SIDEBAR_STATE_PREFIX)) keys.push(key)
        }
        for (const key of keys) {
          const raw = storage.getItem(key)
          if (typeof raw !== 'string' || raw === '') continue
          let parsed
          try { parsed = JSON.parse(raw) } catch { continue }
          if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.expanded)) continue
          const stray = strayRemoteSharedPaths('', parsed.expanded, hostIsWindows)
          if (!stray.length) continue
          const drop = new Set(stray)
          parsed.expanded = parsed.expanded.filter((p) => !drop.has(p))
          storage.setItem(key, JSON.stringify(parsed))
          cleaned += stray.length
        }
      } catch { /* storage unavailable: the tab-level healing still runs */ }
      return cleaned
    }

    // `evictStray` heals state an older dsh-remote already polluted: the tree
    // calls it once it knows its remote root, and it drops exactly those paths
    // from the shared set. It is a plain function (not an effect) so the rule is
    // directly testable.
    function RemoteExplorerTabOwned(props) {
      const [expanded, setExpanded] = React.useState(tabExpandedOf(props.tab))
      const sharedExpanded = Array.isArray(props.expanded) ? props.expanded : []
      const evictShared = typeof props.onToggleDir === 'function' ? props.onToggleDir : null
      // Heal without needing the remote root: on a Windows host a POSIX-absolute
      // entry can never be a valid local path, so the sweep is complete there.
      // (The root-scoped sweep for the session's own remote tree runs inside the
      // tab, which is where the resolved root becomes known.)
      const sharedKey = sharedExpanded.join('\u0000')
      React.useEffect(() => {
        if (!evictShared) return
        const stray = strayRemoteSharedPaths('', sharedKey ? sharedKey.split('\u0000') : [])
        for (const p of stray) evictShared(p)
      }, [sharedKey, evictShared])
      // Explicitly drop the framework's session-shared pair from the child.
      const owned = { ...props }
      delete owned.expanded
      delete owned.onToggleDir
      return React.createElement(RemoteExplorerTab, {
        ...owned,
        evictStray: (root) => {
          if (!evictShared || !sharedExpanded.length) return []
          const stray = strayRemoteSharedPaths(root, sharedExpanded)
          for (const p of stray) evictShared(p)
          return stray
        },
        expanded,
        onCollapseAll: () => { for (const p of expanded) toggleTabExpanded(props.ctx, props.tab, p); setExpanded([]) },
        onToggleDir: (path) => setExpanded(toggleTabExpanded(props.ctx, props.tab, path)),
      })
    }

    const explorerMemory = new Map()
    const fileViewMemory = new Map()
    const explorerSelectionListeners = new Set()
    function rememberRemoteSelection(sessionId, path) {
      const key = sessionId || ''
      const state = explorerMemory.get(key) || {}
      explorerMemory.set(key, { ...state, selected: path })
      for (const notify of explorerSelectionListeners) notify(key, path)
    }
    function useRemoteTerminal(sessionId) {
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState('')
      const lifetime = React.useRef(null)
      React.useEffect(() => { setPending(false); setError(''); return () => { lifetime.current?.abort(); lifetime.current = null } }, [sessionId])
      const open = async () => {
        if (lifetime.current) return
        const controller = new AbortController()
        lifetime.current = controller
        setPending(true); setError('')
        try {
          const right = SIDEBAR_RIGHT
          const terminals = WEB_TERMINALS
          if (!right || !terminals || typeof terminals.launchShells !== 'function') throw new Error(tr('workbench.terminalUnavailable'))
          const choices = await terminals.launchShells(sessionId, controller.signal)
          if (controller.signal.aborted) return
          if (right.mounted && typeof right.mounted.getSnapshot === 'function' && right.mounted.getSnapshot() !== sessionId) return
          const shell = (choices.shells || []).find((s) => s.name === 'remote ssh' || /(^|[\\/])remote ssh(?:\.cmd)?$/i.test(s.path || ''))
          if (!shell) throw new Error(tr('workbench.terminalUnavailable'))
          right.openTab('terminal', { params: { shellPath: shell.path } })
        } catch (e) { if (!controller.signal.aborted) setError(String(e.message || e)) }
        finally { if (lifetime.current === controller) { lifetime.current = null; setPending(false) } }
      }
      return { open, pending, error }
    }
    function WorkbenchIcon({ name, size = 16 }) {
      const paths = {
        remote: 'M2 3h12v8H2zM6 14h4M8 11v3m-3-7 2 2-2 2m4 0h2',
        terminal: 'm3 4 4 4-4 4m6 0h4',
        refresh: 'M13 6a5 5 0 1 0 0 5M13 2v4H9',
        collapse: 'M4 5h9v8H4zM1 10V2h8',
        search: 'M10.5 10.5 14 14M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0',
        close: 'm4 4 8 8m0-8-8 8',
        copy: 'M5 5h8v9H5zM2 11V2h8',
        wrap: 'M2 4h12M2 8h9a2 2 0 0 1 0 4H8m2-2-2 2 2 2M2 12h3',
        folder: 'M2 4h5l2 2h5v7H2z',
        file: 'M4 2h5l3 3v9H4zM9 2v4h3',
        down: 'm5 6 3 3 3-3',
        right: 'm6 4 4 4-4 4',
        left: 'm10 4-4 4 4 4',
        more: 'M3 8h.01M8 8h.01M13 8h.01',
      }
      return React.createElement('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { flexShrink: 0 } }, React.createElement('path', { d: paths[name] || paths.file }))
    }
    function WorkbenchAction({ icon, label, onClick, disabled, pressed }) {
      return React.createElement('button', { type: 'button', className: 'dsh-rw-action', title: label, 'aria-label': label, 'aria-pressed': pressed, disabled, onClick }, React.createElement(WorkbenchIcon, { name: icon }))
    }

    // Tree-style remote file explorer. Data is listed live from the remote host
    // over /dsh-remote/ls, rooted at this session's remote workspace dir.
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
      const [selectedPath, setSelectedPath] = React.useState(() => explorerMemory.get(props.scope?.sessionId || '')?.selected || '')
      const [filter, setFilter] = React.useState('')
      const [filterOpen, setFilterOpen] = React.useState(false)
      const filterRef = React.useRef(null)
      const remoteTerminal = useRemoteTerminal(props.scope && props.scope.sessionId)
      const [namePrompt, setNamePrompt] = React.useState(null) // { kind, path, name }
      const confirmUi = useConfirm()
      React.useEffect(() => { ensureChromeCss() }, [])
      const expanded = Array.isArray(props.expanded) ? props.expanded : []
      const scopeCwd = props.scope && props.scope.cwd
      const sessionId = props.scope && props.scope.sessionId
      React.useEffect(() => {
        setSelectedPath(explorerMemory.get(sessionId || '')?.selected || '')
        const select = (key, path) => { if (key === (sessionId || '')) setSelectedPath(path) }
        explorerSelectionListeners.add(select)
        return () => explorerSelectionListeners.delete(select)
      }, [sessionId])
      React.useEffect(() => {
        const node = treeRef.current
        if (!node) return
        node.scrollTop = explorerMemory.get(sessionId || '')?.scrollTop || 0
      }, [root, sessionId])
      React.useEffect(() => { if (filterOpen) filterRef.current?.focus() }, [filterOpen])

      const storeLevel = (path, level) => {
        dataRef.current = { ...dataRef.current, [path]: level }
        setData(dataRef.current)
      }

      const viewKey = String(sessionId || '') + '\0' + String(scopeCwd || '')
      const viewRef = React.useRef({ key: viewKey, requests: new Map() })
      if (viewRef.current.key !== viewKey) {
        viewRef.current = { key: viewKey, requests: new Map() }
        dataRef.current = {}; setData({}); setRoot(''); setStatus(null); setBusy(''); setErr('')
      }
      React.useEffect(() => () => { viewRef.current = { key: '', requests: new Map() } }, [])
      const expandedRef = React.useRef(expanded)
      expandedRef.current = expanded
      const treeRef = React.useRef(null)
      const [focusedPath, setFocusedPath] = React.useState('')
      React.useEffect(() => {
        if (!focusedPath || !treeRef.current) return
        const exists = Array.from(treeRef.current.querySelectorAll('[data-rw-tree-row]')).some((row) => row.getAttribute('data-rw-tree-row') === focusedPath)
        if (!exists) setFocusedPath(root)
      }, [data, root, rootOpen, expanded, focusedPath])


      const loadDir = React.useCallback((dir, opts) => {
        const view = viewRef.current
        const existing = dataRef.current[dir]
        if (existing && existing.loading && view.requests.has(dir) && !(opts && opts.force)) return
        if (!(opts && opts.force) && existing && !existing.loading) return
        const request = {}
        view.requests.set(dir, request)
        const current = () => viewRef.current === view && view.requests.get(dir) === request
        storeLevel(dir, { ...existing, loading: true })
        return listRemoteDir(dir, sessionId)
          .then((res) => {
            if (!current()) return
            const items = Array.isArray(res && res.items) ? res.items : []
            const sorted = items.slice().sort((a, b) => {
              if (a.type === 'dir' && b.type !== 'dir') return -1
              if (a.type !== 'dir' && b.type === 'dir') return 1
              return String(a.name).localeCompare(String(b.name))
            })
            storeLevel(dir, { entries: sorted, missing: !!(res && res.missing) })
          })
          .catch((e) => {
            if (!current()) return
            if (existing && existing.entries) storeLevel(dir, { ...existing, loading: false, softError: String(e.message || e) })
            else storeLevel(dir, { loading: false, error: String(e.message || e) })
          })
      }, [sessionId])

      // Resolve this session's remote root, then load it and every expanded dir.
      // Re-runs whenever the session scope changes (switching conversations, or
      // the async sessionCwd fetch landing), so the sidebar follows the session's
      // own workspace dir.
      const rootRef = React.useRef('')
      const refreshStatus = React.useCallback((opts) => {
        const view = viewRef.current
        const refresh = {}
        view.refresh = refresh
        const current = () => viewRef.current === view && view.refresh === refresh
        setErr('')
        const applyRoot = (r, connected) => {
          if (!current()) return
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
            // A bound remote session lists on demand even if this process has
            // not yet opened the SSH socket; only an unbound/disconnected
            // machine-scoped view should show the empty "未连接" state.
            if (!connected && !sessionId) {
              storeLevel(r, { error: tr('explorer.notConnected') })
              return
            }
            if (!sameRoot) {
              storeLevel(r, { loading: true })
            }
            loadDir(r, { force: true })
            for (const dir of expandedRef.current) if (dir !== r) loadDir(dir, { force: true })

          }
        }
        const resolveRoot = () => {
          if (scopeCwd) {
            return api('GET', '/dsh-remote/resolve-mirror?local=' + encodeURIComponent(scopeCwd))
              .then((r) => (r && r.remotePath) || '')

          }
          if (sessionId) return resolveSessionRemote(sessionId, true)
          return Promise.resolve('')
        }
        resolveRoot().then((r) => {
          if (!current()) return
          return fetchRemoteStatus(sessionId).then((s) => {
            if (!current()) return
            if (s) setStatus(s)
            // Issue #13: NEVER fall back to the machine-level workspace here —
            // a session whose cwd is not a mirror is a LOCAL session and shows
            // the "no remote workspace" empty state instead.
            applyRoot(r || '', !!(s && s.connected))
          })
        }).catch((e) => {
          if (!current()) return
          setErr(String(e.message || e))
          const r = rootRef.current
          const previous = dataRef.current[r]
          if (r && previous && previous.entries) storeLevel(r, { ...previous, loading: false, softError: String(e.message || e) })
        })
      }, [scopeCwd, sessionId])

      React.useEffect(() => { refreshStatus() }, [refreshStatus])
      React.useEffect(() => { if (props.visible) refreshStatus({ visible: true }) }, [props.visible])
      // Load dirs as they get expanded (keep already-loaded content).
      React.useEffect(() => { if (root) for (const dir of expanded) loadDir(dir, { keep: true }) }, [root, expanded, loadDir])
      // Issue #32 healing: once the remote root is known, drop the paths an
      // older dsh-remote left in better-sidebar's PERSISTED session-shared
      // expansion set (the built-in local tree was loading them through a local
      // fs.realpath and failing). See strayRemoteSharedPaths().
      React.useEffect(() => {
        if (root && typeof props.evictStray === 'function') props.evictStray(root)
      }, [root, props.evictStray])
      /** Shared dispatch for the context menu (host Menu or the DOM fallback). */
      const runMenuAction = (id, m) => {
        if (!m) return
        if (id === 'open') { if (m.isDir) { if (props.onToggleDir) props.onToggleDir(m.path) } else openFile(m.path); return }
        if (id === 'download') { doFs('download', { path: m.path }); return }
        if (id === 'copy-rel') { copyPath(relPath(m.path), m.path); return }
        if (id === 'copy-abs') { copyPath(m.path, m.path); return }
        if (id === 'rename') { setNamePrompt({ kind: 'rename', path: m.path, name: m.name }); return }
        if (id === 'delete') { confirmUi.ask(tr('explorer.deleteConfirm', { path: m.path })).then((ok) => { if (ok) doFs('remove', { path: m.path }, true) }) }
      }
      // ── Context-menu portal: append to document.body so the sidebar's
      //    overflow/transform cannot clip it. Pure DOM, no React portal needed.
      //    Only the FALLBACK when the host ships no Menu primitive: the main
      //    path renders HostMenu (anchored, body-portaled, keyboard-navigable).
      React.useEffect(() => {
        if (!menu || HostMenu) return
        const host = document.createElement('div')
        host.style.cssText = 'position:fixed;z-index:999999;pointer-events:auto'
        const box = document.createElement('div')
        box.style.cssText = 'position:fixed;left:' + menu.x + 'px;top:' + menu.y + 'px;z-index:999999;background:var(--dsw-alias-bg-overlay,#1f1f23);border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.5));border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:170px;font-family:system-ui,sans-serif;color:var(--dsw-alias-label-primary,#e4e4e7)'
        const mkItem = (label, danger, fn) => {
          const d = document.createElement('div')
          d.textContent = label
          d.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:12px;color:' + (danger ? 'var(--dsw-static-red-400,#e06c75)' : 'inherit') + ';border-radius:4px;white-space:nowrap;transition:background 0.1s'
          d.onmouseenter = () => { d.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.14))' }
          d.onmouseleave = () => { d.style.background = 'transparent' }
          d.addEventListener('click', (e) => { e.stopPropagation(); setMenu(null); fn() })
          return d
        }
        box.appendChild(mkItem(menu.isDir ? tr('explorer.menuExpand') : tr('explorer.menuOpen'), false, () => runMenuAction('open', menu)))
        box.appendChild(mkItem(tr('explorer.menuDownload'), false, () => runMenuAction('download', menu)))
        box.appendChild(mkItem(tr('explorer.menuCopyRel'), false, () => runMenuAction('copy-rel', menu)))
        box.appendChild(mkItem(tr('explorer.menuCopyAbs'), false, () => runMenuAction('copy-abs', menu)))
        box.appendChild(mkItem(tr('explorer.menuRename'), false, () => runMenuAction('rename', menu)))
        box.appendChild(mkItem(menu.isDir ? tr('explorer.menuDeleteDir') : tr('explorer.menuDelete'), true, () => runMenuAction('delete', menu)))
        host.appendChild(box)
        document.body.appendChild(host)
        const close = (e) => { if (!box.contains(e.target)) { setMenu(null) } }
        // Delay adding listener so the same mousedown that opened the menu doesn't close it
        const tid = setTimeout(() => document.addEventListener('mousedown', close), 0)
        return () => { clearTimeout(tid); document.removeEventListener('mousedown', close); host.remove() }
        // confirmUi.ask is stable (useCallback); depending on the wrapper object
        // would rebuild the menu DOM on every render.
      }, [menu, confirmUi.ask])

      // Open one remote file. The viewer is a RESOURCE tab type: the address
      // names the file, and the HOST's tab registry picks the type that claims
      // it (ours, `dsh-resource://dsh-remote/**`). That is the same call the
      // native explorer makes through `onOpenFile`, so one file behaves
      // identically in both compositions — and it needs no better-sidebar
      // descriptor, whose only effect would have been a switch that unregisters
      // the viewer.
      const openFile = (p) => {
        if (props.onOpenFile) { props.onOpenFile(p); return }
        const sessionId = (props.scope && props.scope.sessionId) || ''
        try {
          const right = props.ctx && props.ctx.get && props.ctx.get('sidebarRight')
          if (right && typeof right.openResource === 'function') {
            right.openResource(remoteFileAddress(sessionId, p))
            return
          }
        } catch (e) {
          console.warn('[dsh-remote] remote file open failed:', e)
          return
        }
        console.warn('[dsh-remote] no right-sidebar resource opener; remote file not opened')
      }

      const doFs = (op, payload, refreshParent) => {
        const view = viewRef.current
        setBusy(op)
        return api('POST', '/dsh-remote/fs', withSessionBody({ op, ...payload }, sessionId))
          .then(() => {
            if (viewRef.current !== view) return
            setErr('')
            if (refreshParent) {
              if (root) loadDir(root, { force: true })
              for (const dir of expanded) if (dir !== root) loadDir(dir, { force: true })
            }
          })
          .catch((e) => { if (viewRef.current === view) setErr(String(e.message || e)) })
          .finally(() => { if (viewRef.current === view) setBusy('') })
      }

      const onCtx = (e, path, isDir, name) => {
        e.preventDefault(); e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY, path, isDir, name })
      }
      const ctxItem = (label, danger, fn) => React.createElement('div', {
        onClick: (e) => { e.stopPropagation(); setMenu(null); fn() },
        className: 'dsh-rw-list-item',
        style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12, color: danger ? T.danger : T.label, borderRadius: 4, whiteSpace: 'nowrap' },
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
      const treeKeyDown = (e) => {
        if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
        const rows = Array.from(e.currentTarget.querySelectorAll('[data-rw-tree-row]'))
        const at = rows.indexOf(e.target)
        if (at < 0) return
        const row = rows[at]
        const path = row.getAttribute('data-rw-tree-row')
        const expanded = row.getAttribute('aria-expanded')
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault()
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
          rows[next]?.focus()
        } else if (e.key === 'ArrowRight' && expanded !== null) {
          e.preventDefault()
          if (expanded === 'false') row.click()
          else rows[at + 1]?.focus()
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          if (expanded === 'true') row.click()
          else {
            const level = Number(row.getAttribute('aria-level'))
            for (let i = at - 1; i >= 0; i--) if (Number(rows[i].getAttribute('aria-level')) < level) { rows[i].focus(); break }
          }
        } else if (e.key === 'F2') {
          e.preventDefault(); setNamePrompt({ kind: 'rename', path, name: path.split(/[\\/]/).pop() })
        } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault()
          const rect = row.getBoundingClientRect()
          setMenu({ path, name: path.split(/[\\/]/).pop(), isDir: expanded !== null, x: rect.left + 12, y: rect.bottom })
        }
      }

      const row = (entry, depth) => {
        const pad = depth * 22 + 6
        const hovered = hoverPath === entry.path
        const base = {
          display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', paddingLeft: pad, minHeight: 28, boxSizing: 'border-box',
          borderRadius: 4, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis', transition: 'background 0.12s ease',
          background: hovered ? 'rgba(128,128,128,0.14)' : 'transparent',
          color: T.label,
        }
        if (entry.type === 'dir') {
          const isOpen = expanded.includes(entry.path)
          return React.createElement('div', { key: entry.path, role: 'none' },
            React.createElement('div', {
              role: 'treeitem', className: 'dsh-rw-tree-row', 'aria-selected': selectedPath === entry.path, 'data-rw-tree-row': entry.path, 'aria-level': depth + 1, tabIndex: focusedPath === entry.path ? 0 : -1, onFocus: () => setFocusedPath(entry.path),
              'aria-expanded': isOpen,
              onClick: () => { setSelectedPath(entry.path); if (props.onToggleDir) props.onToggleDir(entry.path) },
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (props.onToggleDir) props.onToggleDir(entry.path) } },
              onContextMenu: (e) => onCtx(e, entry.path, true, entry.name),
              onMouseEnter: () => setHoverPath(entry.path),
              onMouseLeave: () => setHoverPath((p) => (p === entry.path ? '' : p)),
              style: base,
              title: entry.path,
            },
              React.createElement('span', { className: 'dsh-rw-tree-chevron' }, React.createElement(WorkbenchIcon, { name: isOpen ? 'down' : 'right', size: 12 })),
              React.createElement('span', { style: { flexShrink: 0, color: T.label, display: 'inline-flex' } }, IconFolder(isOpen)),
              React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, fontWeight: 500 } }, entry.name),
              copiedMark(entry.path),
            ),
            isOpen ? renderLevel(entry.path, depth + 1) : null,
          )
        }
        return React.createElement('div', {
          role: 'treeitem', className: 'dsh-rw-tree-row', 'aria-selected': selectedPath === entry.path, 'data-rw-tree-row': entry.path, 'aria-level': depth + 1, tabIndex: focusedPath === entry.path ? 0 : -1, onFocus: () => setFocusedPath(entry.path), key: entry.path,
          onClick: () => { rememberRemoteSelection(sessionId, entry.path); openFile(entry.path) },
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); rememberRemoteSelection(sessionId, entry.path); openFile(entry.path) } },
          onContextMenu: (e) => onCtx(e, entry.path, false, entry.name),
          onMouseEnter: () => setHoverPath(entry.path),
          onMouseLeave: () => setHoverPath((p) => (p === entry.path ? '' : p)),
          style: base,
          title: entry.path,
        },
          React.createElement('span', { className: 'dsh-rw-tree-chevron' }),
          React.createElement('span', { style: { flexShrink: 0, display: 'inline-flex' } }, IconFile(entry.name)),
          React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, entry.name),
          copiedMark(entry.path),
          (entry.size != null || entry.mtime)
            ? React.createElement('span', { className: 'dsh-rw-row-meta', style: { fontSize: 10, flexShrink: 0, fontFamily: 'monospace' }, title: entry.mtime ? fmtTime(entry.mtime) : '' }, humanSize(entry.size))
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
          return React.createElement('div', { key: dir + ':err', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: depth * 22 + 6, fontSize: 13, color: T.danger } }, React.createElement('span', { role: 'alert' }, level.error), React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => loadDir(dir, { force: true }) }, tr('project.retry')))
        }
        const needle = filter.trim().toLowerCase()
        const items = (level.entries || []).filter((it) => it.type === 'dir' || !needle || String(it.name).toLowerCase().includes(needle))
        const soft = level.softError
            ? React.createElement('div', { key: dir + ':softerr', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: depth * 22 + 6, fontSize: 11, opacity: 0.6, color: T.warn } }, tr('explorer.softError', { msg: level.softError }), React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => loadDir(dir, { force: true }) }, tr('project.retry')))
          : null
        if (!items.length) return soft || React.createElement('div', { style: { padding: '8px 12px', paddingLeft: depth * 22 + 6, color: T.muted, fontSize: 12 } }, tr(filter ? 'workbench.noFilteredFiles' : 'explorer.emptyFolder'))
        return React.createElement('div', { key: dir + ':list' },
          items.map((it) => row({ ...it, path: joinRemote(dir, it.name) }, depth)),
          soft,
        )
      }

      React.useEffect(() => {
        if (!root || props.visible === false) return
        const view = viewRef.current
        const timer = setInterval(() => {
          fetchRemoteStatus(sessionId).then((next) => { if (next && viewRef.current === view) setStatus(next) })
        }, 5000)
        return () => clearInterval(timer)
      }, [root, sessionId, props.visible])

      const rootName = root ? String(root).split(/[\\/]/).filter(Boolean).pop() || root : ''
      const rootLevel = data[root]
      const connectionState = !rootLevel || rootLevel.loading ? 'loading' : (rootLevel.error || rootLevel.softError) ? 'interrupted' : 'ready'

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        React.createElement('div', { style: { padding: '10px 10px 6px', borderBottom: '1px solid ' + T.border } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement('span', { style: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600 } }, tr('workbench.explorer')),
            React.createElement(WorkbenchAction, { icon: 'terminal', label: tr('workbench.openTerminal'), disabled: !root || remoteTerminal.pending, onClick: remoteTerminal.open }),
            React.createElement(WorkbenchAction, { icon: 'search', label: tr('workbench.filter'), pressed: filterOpen, onClick: () => { setFilterOpen((v) => !v); setFilter('') } }),
            React.createElement(WorkbenchAction, { icon: 'refresh', label: tr('explorer.refresh'), onClick: () => refreshStatus({ force: true }) }),
            React.createElement(WorkbenchAction, { icon: 'collapse', label: tr('workbench.collapse'), disabled: !root, onClick: () => { props.onCollapseAll?.(); setRootOpen(true) } }),
          ),
          React.createElement('div', { className: 'dsh-rw-path', title: root, style: { marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement('span', { 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: connectionState === 'ready' ? T.ok : connectionState === 'interrupted' ? T.warn : T.muted } }),
            React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, status && status.host ? (status.username ? status.username + '@' : '') + status.host : tr('workbench.remote')),
            root ? React.createElement('span', { style: { marginLeft: 'auto', fontSize: 10 } }, rootName) : null),
          filterOpen ? React.createElement('input', { ref: filterRef, type: 'search', className: 'dsh-rw-input', 'aria-label': tr('workbench.filter'), placeholder: tr('workbench.filter'), value: filter, onChange: (e) => setFilter(e.target.value), onKeyDown: (e) => { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); setFilter(''); setFilterOpen(false) } }, style: { ...inputS, boxSizing: 'border-box', width: '100%', marginTop: 8, fontSize: 12 } }) : null,
        ),
        connectionState === 'interrupted' && root ? React.createElement('div', { role: 'status', style: { padding: '6px 10px', display: 'flex', gap: 6, fontSize: 11, color: T.warn, background: T.bg } },
          React.createElement('span', { style: { flex: 1 } }, tr('explorer.connection.interrupted')),
          React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => refreshStatus({ force: true }) }, tr('project.retry'))) : null,
        remoteTerminal.error ? React.createElement('div', { role: 'alert', style: { padding: '6px 10px', color: T.danger, fontSize: 12 } }, remoteTerminal.error) : null,
        root && status && status.sync ? React.createElement('details', { style: { padding: '4px 8px', fontSize: 11, color: T.muted, borderBottom: '1px solid ' + T.border } },
          React.createElement('summary', { style: { cursor: 'pointer' } }, tr(({ unknown: 'sync.unknown', running: 'sync.running', completed: 'sync.completed', partial: 'sync.partial', conflicts: 'sync.conflicts', failed: 'sync.failed', pending: 'sync.pending' })[status.sync.phase] || 'sync.unknown')),
          React.createElement('div', { style: { padding: '6px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 } },
            status.sync.updatedAt ? new Date(status.sync.updatedAt).toLocaleString() : tr('sync.explain'),
            status.sync.error ? '\n' + status.sync.error : '',
            (status.sync.conflicts || []).map((c) => '\n' + c.path + (c.reason ? ' · ' + c.reason : '')).join(''),
            status.sync.phase === 'conflicts' ? '\n' + tr('sync.conflictHelp') : '')) : null,
        picker ? React.createElement('div', { style: { padding: 8 } }, React.createElement(DirPicker, {
          open: true, busy: false, registerWorkspace: false, initialTab: 'remote', onPicked: () => { setPicker(false); refreshStatus() }, onCancel: () => setPicker(false),
        })) : null,
        React.createElement('div', { role: 'tree', 'aria-label': tr('explorer.tabTitle'), ref: treeRef, onScroll: (e) => explorerMemory.set(sessionId || '', { ...explorerMemory.get(sessionId || ''), scrollTop: e.currentTarget.scrollTop }), onKeyDown: treeKeyDown, style: { flex: 1, overflowY: 'auto', minHeight: 0, padding: '2px 0' } },
          !root
            ? React.createElement('div', { style: { opacity: 0.6, padding: 12, fontSize: 13 } }, err ? tr('explorer.cannotResolve') : tr('explorer.localSession'))
            : React.createElement('div', { key: root },
                React.createElement('div', {
                  role: 'treeitem', className: 'dsh-rw-tree-row', 'data-rw-tree-row': root, 'aria-level': 1, 'aria-expanded': rootOpen, tabIndex: !focusedPath || focusedPath === root ? 0 : -1, onFocus: () => setFocusedPath(root),
                  onClick: () => setRootOpen((v) => !v),
                  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRootOpen((v) => !v) } },
                  onContextMenu: (e) => onCtx(e, root, true, rootName),
                  style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: 6, borderRadius: 5, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: T.label, fontWeight: 600 },
                  title: root,
                },
                  React.createElement('span', { className: 'dsh-rw-tree-chevron' }, React.createElement(WorkbenchIcon, { name: rootOpen ? 'down' : 'right', size: 12 })),
                  React.createElement('span', { style: { flexShrink: 0, color: T.label, display: 'inline-flex' } }, IconFolder(rootOpen)),
                  React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, rootName || root),
                ),
                rootLevel && rootOpen ? renderLevel(root, 1) : null,
              ),
        ),
        React.createElement('div', { style: { display: 'flex', gap: 6, padding: '6px 10px', borderTop: '1px solid ' + T.border, alignItems: 'center' } },
          React.createElement('span', { className: 'dsh-rw-path', style: { flex: 1 }, title: root }, root),
          React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, fontSize: 11, padding: '3px 8px' }, disabled: !root || !!busy, onClick: () => setNamePrompt({ kind: 'mkdir', path: root, name: '' }) }, tr('explorer.newDir'))),
        // context menu — host Menu primitive when available (anchored at the
        // pointer, body-portaled), otherwise the DOM portal in the effect above
        menu && HostMenu ? React.createElement(HostMenu, {
          open: true,
          portal: true,
          getAnchorRect: () => ({ left: menu.x, top: menu.y, right: menu.x, bottom: menu.y, width: 0, height: 0 }),
          items: [
            { id: 'open', label: menu.isDir ? tr('explorer.menuExpand') : tr('explorer.menuOpen') },
            { id: 'download', label: tr('explorer.menuDownload') },
            { id: 'copy-rel', label: tr('explorer.menuCopyRel') },
            { id: 'copy-abs', label: tr('explorer.menuCopyAbs') },
            { id: 'rename', label: tr('explorer.menuRename') },
            { id: 'delete', label: menu.isDir ? tr('explorer.menuDeleteDir') : tr('explorer.menuDelete'), danger: true },
          ],
          onSelect: (id) => { const m = menu; setMenu(null); runMenuAction(id, m) },
          onClose: () => setMenu(null),
        }) : null,
        confirmUi.node,
        err ? React.createElement('div', { style: { color: T.danger, fontSize: 12, padding: '4px 8px' } }, (busy ? tr('explorer.busy') : '') + err) : null,
        namePrompt ? React.createElement(PromptDialog, {
          title: namePrompt.kind === 'rename' ? tr('explorer.renameTitle') : tr('explorer.mkdirTitle'),
          initial: namePrompt.name || '',
          placeholder: namePrompt.kind === 'rename' ? tr('explorer.renamePrompt') : tr('explorer.namePlaceholder'),
          onCancel: () => setNamePrompt(null),
          onSubmit: (nm) => {
            const name = String(nm || '').trim()
            const cur = namePrompt
            setNamePrompt(null)
            if (!name) return
            if (cur.kind === 'rename') {
              if (name === cur.name) return
              doFs('rename', { path: cur.path, dest: joinRemote(String(cur.path).replace(/[\\/][^\\/]*$/, ''), name) }, true)
            } else {
              doFs('mkdir', { path: joinRemote(cur.path, name) }, true)
            }
          },
        }) : null,
      )
    }

    // ── Code view with line numbers + syntax highlighting (issue #104) ────────

    /** Split a link-carried line anchor off a path: trailing `:42` (the way
     *  models cite lines) or nothing. Returns { path, line } with line ≥ 1 or
     *  null. A Windows drive colon never trails a digit sequence after a path
     *  separator, and `path:0` is meaningless, so the strip is unambiguous. */
    function splitLineAnchor(rawPath) {
      // Trailing `:42` or range `:24-30` / `:24:7` (the latter two keep the
      // start line, mirroring the core's own resolver).
      const m = /:(\d+)(?::\d+|-\d+)?$/.exec(String(rawPath || ''))
      if (!m) return { path: String(rawPath || ''), line: null }
      const line = Number(m[1])
      const path = String(rawPath).slice(0, m.index)
      if (!path || line < 1) return { path: String(rawPath || ''), line: null }
      return { path, line }
    }

    /**
     * Line-numbered code body. Tokens come from the host's Shiki highlighter
     * when the grammar is known; otherwise the same rows render unstyled.
     * `jumpLine` scrolls the row into view and flashes it once per open.
     */
    function CodeView(props) {
      const { code, path, jumpLine } = props
      const lang = languageForPathFn ? languageForPathFn(path || '') : undefined
      // useCodeHighlighterFn is a module-level constant, so this hook's
      // presence cannot change between renders — the order stays lawful.
      const highlight = useCodeHighlighterFn ? useCodeHighlighterFn(lang) : null
      const tokenLines = React.useMemo(() => {
        if (!highlight) return null
        try { return highlight(code) || null } catch { return null }
      }, [highlight, code])
      const lines = React.useMemo(() => tokenLines || String(code).split('\n').map((t) => [{ text: t, style: null }]), [tokenLines, code])
      const rowRefs = React.useRef(new Map())
      const digits = String(lines.length).length
      React.useEffect(() => {
        if (!jumpLine) return undefined
        const row = rowRefs.current.get(jumpLine)
        try { if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' }) } catch { /* non-DOM harness */ }
        return undefined
      }, [jumpLine, code, props.jumpRevision])
      return React.createElement('div', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13, lineHeight: 1.55, padding: '8px 0', color: T.label, minWidth: props.wrap ? 0 : 'min-content', width: props.wrap ? '100%' : undefined } },
        lines.map((tokens, i) => {
          const ln = i + 1
          const isTarget = jumpLine === ln
          return React.createElement('div', {
            key: isTarget ? ln + 'jump' + String(props.jumpRevision || 0) : ln,
            ref: (el) => { if (el) rowRefs.current.set(ln, el); else rowRefs.current.delete(ln) },
            'data-line': ln,
            className: [isTarget ? 'dsh-rw-line-flash' : '', props.currentMatchLine === ln ? 'dsh-rw-code-current' : (props.matchingLines || []).includes(ln) ? 'dsh-rw-code-hit' : ''].filter(Boolean).join(' ') || undefined,
            style: { display: 'flex', whiteSpace: 'pre', ...(isTarget ? { borderRadius: 4 } : {}) },
          },
            React.createElement('span', {
              'aria-hidden': 'true',
              style: {
                flexShrink: 0, width: digits + 'ch', paddingRight: 12, marginRight: 12,
                textAlign: 'right', userSelect: 'none', color: T.muted, background: v('--dsw-alias-bg-layer-1', '#18181b'), position: 'sticky', left: 0, zIndex: 1,
                borderRight: '1px solid ' + T.border,
              },
            }, String(ln)),
            React.createElement('span', { style: { flex: 1, paddingRight: 12 } },
              tokens.map((tk, ti) => React.createElement('span', { key: ti, style: tk.style || undefined }, tk.text))),
          )
        }),
      )
    }

    // ── Remote file tab (opened by the explorer; live read + explicit edit) ──
    /**
     * The host's MarkdownText reads chrome strings off `labels` while rendering
     * fenced code blocks (`labels.code.*`) and footnotes (`labels.footnotes`),
     * and those reads are NOT guarded. A caller that passes only `text` throws
     * inside the host renderer; the error boundary around the pane swallows it
     * and a `.md` containing a code fence opens to a blank page. Wrap the host
     * renderer so an unmet host expectation degrades to source instead.
     */
    const MarkdownGuard = React.Component
      ? class MarkdownGuard extends React.Component {
          constructor(props) { super(props); this.state = { failed: false } }
          static getDerivedStateFromError() { return { failed: true } }
          render() { return this.state.failed ? this.props.fallback : this.props.children }
        }
      // A partial React face (some registries/harnesses) has no `Component`.
      // Passing children through is the right degradation there: there is no
      // host renderer to guard in the first place.
      : (props) => props.children

    function indentRemoteDraft(text, start, end, reverse) {
      const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
      if (start === end && !reverse) {
        const padding = ' '.repeat(2 - (start - lineStart) % 2)
        return { text: text.slice(0, start) + padding + text.slice(end), start: start + padding.length, end: start + padding.length }
      }
      const lineEnd = end > start && text[end - 1] === '\n' ? end - 1 : end
      const nextBreak = text.indexOf('\n', lineEnd)
      const blockEnd = nextBreak < 0 ? text.length : nextBreak
      const block = text.slice(lineStart, blockEnd)
      const lines = block.split('\n')
      let adjustment = 0, firstAdjustment = 0
      const indented = lines.map((line, i) => {
        const remove = reverse ? (line.startsWith('\t') ? 1 : (line.match(/^ {1,2}/)?.[0].length || 0)) : 0
        const delta = reverse ? -remove : 2
        adjustment += delta
        if (i === 0) firstAdjustment = delta
        return reverse ? line.slice(remove) : '  ' + line
      }).join('\n')
      return { text: text.slice(0, lineStart) + indented + text.slice(blockEnd), start: Math.max(lineStart, start + firstAdjustment), end: Math.max(lineStart, end + adjustment) }
    }

    const remoteDrafts = new Map()
    function RemoteFileTab(props) {
      const { tab, scope } = props
      const path = tab.path || ''
      const fileSessionId = scope && scope.sessionId
      const [data, setData] = React.useState(() => fileViewMemory.get(String(fileSessionId || '') + '\0' + path)?.data || null)
      const [err, setErr] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [edit, setEdit] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const draftKey = String(fileSessionId || '') + '\0' + path
      const draftRecord = remoteDrafts.get(draftKey)
      const fileViewRef = React.useRef(draftKey)
      fileViewRef.current = draftKey
      React.useEffect(() => () => { fileViewRef.current = null }, [])
      React.useEffect(() => { setSaving(false) }, [draftKey])

      const [saveConflict, setSaveConflict] = React.useState(false)
      const remoteTerminal = useRemoteTerminal(fileSessionId)
      const cachedView = fileViewMemory.get(draftKey)
      const [wrap, setWrap] = React.useState(() => !!cachedView?.wrap)
      const [sourceMode, setSourceMode] = React.useState(() => !!cachedView?.sourceMode)
      const [findOpen, setFindOpen] = React.useState(false)
      const [findQuery, setFindQuery] = React.useState('')
      const [findIndex, setFindIndex] = React.useState(0)
      const [cursor, setCursor] = React.useState({ line: 1, col: 1 })
      const [copyNote, setCopyNote] = React.useState('')
      const scrollRef = React.useRef(null)
      const editorRef = React.useRef(null)
      const findRef = React.useRef(null)
      const copyTimerRef = React.useRef(null)
      React.useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current) }, [])
      React.useEffect(() => {
        const view = fileViewMemory.get(draftKey)
        setWrap(!!view?.wrap); setSourceMode(!!view?.sourceMode)
        setFindOpen(false); setFindQuery(''); setFindIndex(0)
        rememberRemoteSelection(fileSessionId, path)
      }, [draftKey])
      React.useEffect(() => { if (findOpen) { findRef.current?.focus(); findRef.current?.select() } }, [findOpen])
      React.useEffect(() => {
        if (loading || props.jumpLine) return
        const node = scrollRef.current
        const view = fileViewMemory.get(draftKey)
        if (node && view) { node.scrollTop = view.scrollTop || 0; node.scrollLeft = view.scrollLeft || 0 }
      }, [loading, draftKey])
      const keepView = (patch) => {
        const previous = fileViewMemory.get(draftKey) || {}
        fileViewMemory.delete(draftKey)
        fileViewMemory.set(draftKey, { ...previous, ...patch })
        while (fileViewMemory.size > 64) fileViewMemory.delete(fileViewMemory.keys().next().value)
      }
      const copy = async (value) => {
        if (await copyToClipboard(value)) {
          setCopyNote(tr('explorer.copied'))
          if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
          copyTimerRef.current = setTimeout(() => setCopyNote(''), 1600)
        }
      }
      const showExplorer = () => {
        rememberRemoteSelection(fileSessionId, path)
        if (SIDEBAR_RIGHT?.openTab) SIDEBAR_RIGHT.openTab(NATIVE_EXPLORER)
      }
      const updateCursor = (node) => {
        const before = node.value.slice(0, node.selectionStart)
        const parts = before.split('\n')
        setCursor({ line: parts.length, col: parts[parts.length - 1].length + 1 })
      }
      const discardConfirm = useConfirm()
      const saveTokenRef = React.useRef(null)
      const discardDraft = async (reload) => {
        if (dirty && !(await discardConfirm.ask(tr('file.discardConfirm')))) return
        remoteDrafts.delete(draftKey); setEdit(false); setErr(''); setSaveConflict(false)
        if (reload === true) load()
      }
      const changeDraft = (text) => {
        setDraft(text)
        const prev = remoteDrafts.get(draftKey)
        const baseText = prev ? prev.baseText : originalText
        if (text === baseText) remoteDrafts.delete(draftKey)
        else remoteDrafts.set(draftKey, { text, baseText, baseMtime: prev ? prev.baseMtime : data && data.mtime })
      }

      React.useEffect(() => { ensureChromeCss() }, [])
      // The host renderer takes its code-block / footnote chrome from here and
      // dereferences it without a guard (see MarkdownGuard). Rebuilt per render
      // on purpose: the pane re-renders only on load/edit, and a plain object
      // keeps this module loadable under harnesses that ship a partial React.
      const markdownLabels = {
        code: {
          copyLabel: tr('file.markdown.copy'),
          copiedLabel: tr('file.markdown.copied'),
          toolbarLabels: {
            codeLabel: tr('file.markdown.code'),
            wrapLabel: tr('file.markdown.wrap'),
            unwrapLabel: tr('file.markdown.unwrap'),
          },
        },
        footnotes: tr('file.markdown.footnotes'),
      }

      const originalText = (data && data.content != null ? data.content : '').replace(/\n…\[truncated:.*$/, '')
      const dirty = edit && draft !== originalText

      const load = () => {
        if (!path) { setLoading(false); return }
        let cancelled = false
        setLoading(true); setErr(''); setData(fileViewMemory.get(draftKey)?.data || null); setEdit(false); setSaveConflict(false)
        readRemoteFile(path, 256 * 1024, fileSessionId)
          .then((d) => { if (!cancelled && fileViewRef.current === draftKey) {
            keepView({ data: d }); setData(d); setLoading(false)
            const saved = remoteDrafts.get(draftKey)
            if (saved) { setDraft(saved.text); setEdit(true); setSaveConflict(!!d.truncated || (saved.baseMtime != null && d.mtime !== saved.baseMtime)) }
          } })
          .catch((e) => { if (!cancelled && fileViewRef.current === draftKey) { setErr(String((e && e.message) || e)); setLoading(false) } })
        return () => { cancelled = true }
      }
      React.useEffect(load, [path, fileSessionId, props.navigationRevision])

      const startEdit = () => {
        if (!data || data.binary || data.image || data.truncated) return
        setDraft((data.content != null ? data.content : '').replace(/\n…\[truncated:.*$/, ''))
        setEdit(true); setErr(''); setSaveConflict(false)
      }
      const saveRemote = () => {
        if (saving || saveConflict || (data && data.truncated) || saveTokenRef.current === draftKey) return
        saveTokenRef.current = draftKey
        setSaving(true); setErr('')
        apiRaw('POST', '/dsh-remote/write', withSessionBody({ path, content: draft, expectedMtime: draftRecord ? draftRecord.baseMtime : data && data.mtime }, fileSessionId))
          .then((r) => {
            if (r.status < 400) remoteDrafts.delete(draftKey)
            if (fileViewRef.current !== draftKey) return
            if (r.status === 409) {
              setSaveConflict(true); setErr(String((r.data && r.data.error) || tr('file.conflict')))
              return
            }
            if (r.status >= 400) throw new Error((r.data && (r.data.error || r.data.message)) || 'HTTP ' + r.status)
            remoteDrafts.delete(draftKey)
            setCopyNote(tr('workbench.saved'))
            setEdit(false)
            load()
          })
          .catch((e) => { if (fileViewRef.current === draftKey) setErr(String((e && e.message) || e)) })
          .finally(() => { if (saveTokenRef.current === draftKey) saveTokenRef.current = null; if (fileViewRef.current === draftKey) setSaving(false) })
      }
      const downloadMirror = () => {
        setSaving(true); setErr('')
        api('POST', '/dsh-remote/fs', withSessionBody({ op: 'download', path }, fileSessionId))
          .then((r) => { if (fileViewRef.current === draftKey) setCopyNote(tr('file.downloaded', { local: (r && r.local ? tr('file.downloadedAt', { path: r.local }) : '') })) })
          .catch((e) => { if (fileViewRef.current === draftKey) setErr(String((e && e.message) || e)) })
          .finally(() => { if (fileViewRef.current === draftKey) setSaving(false) })
      }

      const baseName = path.split(/[\\/]/).pop() || path
      const isMarkdown = /\.(md|markdown)$/i.test(baseName)
      const searchableText = edit ? draft : originalText
      const matches = React.useMemo(() => {
        if (!findQuery) return []
        const text = searchableText.toLowerCase(), needle = findQuery.toLowerCase(), found = []
        let at = 0, previous = 0, line = 1
        while ((at = text.indexOf(needle, at)) !== -1 && found.length < 5000) {
          for (let i = previous; i < at; i++) if (text[i] === '\n') line++
          found.push({ start: at, end: at + needle.length, line })
          previous = at; at += Math.max(1, needle.length)
        }
        return found
      }, [findQuery, searchableText])
      const activeMatch = matches.length ? matches[findIndex % matches.length] : null
      React.useEffect(() => { setFindIndex(0) }, [findQuery])
      React.useEffect(() => {
        if (!findOpen || !activeMatch) return
        if (edit && editorRef.current) {
          editorRef.current.setSelectionRange(activeMatch.start, activeMatch.end)
        } else {
          scrollRef.current?.querySelector('[data-line="' + activeMatch.line + '"]')?.scrollIntoView({ block: 'center' })
        }
      }, [findOpen, findIndex, findQuery, edit])
      const moveMatch = (delta) => setFindIndex((old) => matches.length ? (old + delta + matches.length) % matches.length : 0)
      return React.createElement('div', { 'data-rw-file': path, tabIndex: -1, onKeyDown: (e) => {
        if (e.isComposing) return
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); setFindOpen(true); setSourceMode(true); keepView({ sourceMode: true }) }
        if (e.key === 'F3') { e.preventDefault(); moveMatch(e.shiftKey ? -1 : 1) }
      }, style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: T.label, outline: 'none' } },
        React.createElement('div', { style: { borderBottom: '1px solid ' + T.border, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement(WorkbenchIcon, { name: 'file' }),
          React.createElement('span', { style: { flex: 1, minWidth: 80, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: path }, baseName),
          dirty ? React.createElement('span', { title: tr('file.dirty'), 'aria-label': tr('file.dirty'), style: { width: 7, height: 7, borderRadius: '50%', background: T.warn } }) : null,
          React.createElement(WorkbenchAction, { icon: 'search', label: tr('workbench.find'), pressed: findOpen, disabled: !data || data.binary || data.image, onClick: () => { setFindOpen((v) => !v); setSourceMode(true); keepView({ sourceMode: true }) } }),
          React.createElement(WorkbenchAction, { icon: 'wrap', label: tr('workbench.wrap'), pressed: wrap, onClick: () => { setWrap(!wrap); keepView({ wrap: !wrap }) } }),
          React.createElement(WorkbenchAction, { icon: 'copy', label: tr('workbench.copyContent'), disabled: !data || data.binary || data.image, onClick: () => copy(edit ? draft : originalText) }),
          React.createElement(WorkbenchAction, { icon: 'terminal', label: tr('workbench.openTerminal'), disabled: remoteTerminal.pending, onClick: remoteTerminal.open }),
          edit ? React.createElement(React.Fragment, null,
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: { ...primaryBtnS, padding: '4px 10px', fontSize: 12 }, onClick: saveRemote, disabled: saving || !dirty || saveConflict, title: tr('file.saveHint') }, saving ? tr('file.saving') : tr('file.saveToRemote')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '4px 8px', fontSize: 12 }, onClick: () => discardDraft(false) }, tr('file.cancel')))
          : React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '4px 10px', fontSize: 12 }, onClick: startEdit, disabled: loading || !data || data.binary || data.image || data.truncated, title: data && data.truncated ? tr('file.incompletePreview') : tr('file.edit') }, tr('file.edit')),
        ),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderBottom: '1px solid ' + T.border } },
          React.createElement(WorkbenchAction, { icon: 'folder', label: tr('workbench.backToFiles'), onClick: showExplorer }),
          React.createElement('span', { className: 'dsh-rw-path', style: { flex: 1 }, title: path }, path),
          React.createElement(WorkbenchAction, { icon: 'copy', label: tr('workbench.copyPath'), onClick: () => copy(path) }),
          !edit ? React.createElement(WorkbenchAction, { icon: 'refresh', label: tr('explorer.refresh'), disabled: loading, onClick: load }) : null,
          isMarkdown && !edit ? React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '3px 8px', fontSize: 11 }, onClick: () => { setSourceMode(!sourceMode); keepView({ sourceMode: !sourceMode }) } }, sourceMode ? tr('workbench.preview') : tr('workbench.source')) : null),
        findOpen ? React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid ' + T.border, background: T.bg } },
          React.createElement('input', { ref: findRef, className: 'dsh-rw-input', 'aria-label': tr('workbench.find'), placeholder: tr('workbench.find'), value: findQuery, onChange: (e) => setFindQuery(e.target.value), onKeyDown: (e) => {
            if (e.isComposing) return
            if (e.key === 'Enter') { e.preventDefault(); moveMatch(e.shiftKey ? -1 : 1) }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFindOpen(false); editorRef.current?.focus() }
          }, style: { ...inputS, flex: 1, width: 80, minWidth: 60, fontSize: 12 } }),
          React.createElement('span', { style: { fontSize: 10, color: T.muted, whiteSpace: 'nowrap' }, role: 'status' }, matches.length ? tr('workbench.matches', { current: findIndex % matches.length + 1, total: matches.length }) : tr('workbench.noMatches')),
          React.createElement(WorkbenchAction, { icon: 'right', label: tr('workbench.next'), disabled: !matches.length, onClick: () => moveMatch(1) }),
          React.createElement(WorkbenchAction, { icon: 'close', label: tr('workbench.closeFind'), onClick: () => setFindOpen(false) })) : null,
        remoteTerminal.error ? React.createElement('div', { role: 'alert', style: { padding: '6px 10px', color: T.danger, fontSize: 12 } }, remoteTerminal.error) : null,
        saveConflict ? React.createElement('div', { role: 'alert', style: { padding: '10px 12px', fontSize: 12, color: T.warn, borderBottom: '1px solid ' + T.border, lineHeight: 1.6 } },
          tr('file.conflictHelp'),
          React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, marginLeft: 8 }, onClick: () => copyToClipboard(draft) }, tr('file.copyDraft')),
          React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, marginLeft: 8 }, onClick: () => discardDraft(true) }, tr('file.discardReload'))) : null,
        discardConfirm.node,
        React.createElement('div', { ref: scrollRef, className: wrap ? 'dsh-rw-code-wrap' : '', onScroll: (e) => keepView({ scrollTop: e.currentTarget.scrollTop, scrollLeft: e.currentTarget.scrollLeft }), style: { flex: 1, overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' } },
          err ? React.createElement('div', { style: { color: T.danger, padding: '8px 12px', fontSize: 13, flexShrink: 0 } }, err, !edit ? React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, marginLeft: 8 }, onClick: load }, tr('project.retry')) : null) : null,
          loading && !data ? React.createElement('div', { style: { opacity: 0.7, padding: 12, fontSize: 13 } }, tr('file.loading'))
            : (data && data.binary
                  ? React.createElement('div', { style: { padding: 12, fontSize: 13, color: T.warn } },
                      tr('file.binary', { size: (data.size != null ? data.size + ' bytes' : tr('file.unknownSize')) }))
                  : data && data.image
                    ? React.createElement('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, minHeight: 0 } },
                        React.createElement('img', { src: `data:${data.mime};base64,${data.content}`, alt: baseName, style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } }))
                    : (edit
                      ? React.createElement('textarea', {
                          ref: editorRef, 'aria-label': tr('file.edit') + ' ' + baseName,
                          onSelect: (e) => updateCursor(e.currentTarget),
                          value: draft,
                          onChange: (e) => { changeDraft(e.target.value); updateCursor(e.target) },
                          onKeyDown: (e) => {
                            if (e.isComposing) return
                            if (e.key === 'Tab') {
                              e.preventDefault()
                              const node = e.currentTarget
                              const result = indentRemoteDraft(draft, node.selectionStart, node.selectionEnd, e.shiftKey)
                              changeDraft(result.text)
                              setTimeout(() => { node.setSelectionRange(result.start, result.end); updateCursor(node) }, 0)
                            }
                            if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (!e.isComposing && !saving && dirty && !saveConflict) saveRemote() }
                            if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur() }
                          },
                          spellCheck: false,
                          style: { width: '100%', height: '100%', flex: 1, boxSizing: 'border-box', border: 'none', outline: 'none', resize: 'none', background: 'transparent', color: T.label, fontSize: 13, lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', padding: '10px 12px', whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'anywhere' : 'normal' },
                        })
                      : (isMarkdown && !sourceMode && MarkdownText
                        // Render remote markdown with the host renderer instead of a
                        // source wall (issue #74 keeps #64's promise): a link that used
                        // to die with ENOENT on the local mirror now shows the remote
                        // file, rendered.
                        ? React.createElement('div', { style: { padding: '10px 14px', flexShrink: 0, overflow: 'auto' } },
                            React.createElement(MarkdownGuard, {
                              fallback: React.createElement('div', {
                                style: {
                                  fontSize: 13, lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: T.label,
                                },
                              }, originalText),
                            },
                              React.createElement(MarkdownText, { text: originalText, variant: 'body', labels: markdownLabels })),
                            (data && data.truncated)
                              ? React.createElement('div', { style: { color: T.warn, fontSize: 12, marginTop: 8 } }, tr('file.truncated'))
                              : null)
                        : React.createElement('div', { style: { padding: '0 12px 8px' } },
                            (data && data.content != null)
                              ? React.createElement(CodeView, { code: data.content, path, wrap, matchingLines: findOpen ? matches.map((m) => m.line) : [], currentMatchLine: findOpen && activeMatch ? activeMatch.line : null, jumpLine: props.jumpLine || null, jumpRevision: props.navigationRevision })
                              : React.createElement('div', { style: { fontSize: 13, lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', padding: '10px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: T.label } },
                                  err ? '' : tr('file.empty')),
                            (data && data.truncated)
                              ? React.createElement('div', { style: { color: T.warn, fontSize: 12, marginTop: 8 } }, tr('file.truncated'))
                              : null,
                          )))),
        ),
        React.createElement('div', { className: 'dsh-rw-file-status', role: 'status' },
          React.createElement('span', {}, edit ? tr('workbench.position', cursor) : tr('workbench.lines', { n: originalText.split('\n').length })),
          React.createElement('span', {}, data && data.size != null ? humanSize(data.size) : ''),
          React.createElement('span', {}, baseName.includes('.') ? baseName.split('.').pop().toUpperCase() : 'TEXT'),
          React.createElement('span', { style: { marginLeft: 'auto', color: copyNote ? T.ok : T.muted } }, copyNote || (loading && data ? tr('workbench.refreshing') : edit ? tr('file.editing') : tr('file.readonly')))),
      )
    }

    // ── better-sidebar registration (guarded: plugin may be absent) ────────
    function registerSidebarIntegration(ctx) {
      const bs = (ctx && ctx.get && ctx.get('betterSidebar')) || null
      if (!bs || typeof bs.registerTab !== 'function') return
      // Issue #32 migration: drop the remote paths an older dsh-remote left in
      // PERSISTED sidebar state, BEFORE the built-in Files tree loads them
      // through its local fs guard. Runs once per activation; a failure is
      // harmless because the tab-level healing repeats it.
      try {
        migratePollutedSidebarState(typeof window !== 'undefined' ? window.localStorage : null)
      } catch { /* best-effort migration */ }
      const disposers = []
      try {
        disposers.push(bs.registerTab({
          id: SIDEBAR_EXPLORER_ID,
          title: () => tr('explorer.tabTitle'),
          icon: (size) => React.createElement('span', { style: { fontSize: (size || 14), lineHeight: 1 } }, '🌐'),
          order: 55,
          single: true,
          // Issue #32: own the expansion state (see RemoteExplorerTabOwned).
          component: RemoteExplorerTabOwned,
        }))
        // No descriptor for the FILE viewer on purpose. It is a resource tab
        // type (`dsh-remote/file`, registered with `patterns` on the native
        // registry), not a page: it only means something once an address names
        // the file, so it has no card to draw and no page to open. A
        // descriptor here would put a card in better-sidebar's 侧边栏内容
        // inventory whose switch could only ever unregister the viewer — the
        // "switch does nothing" report this replaced. The tree hands the HOST
        // an address instead and the host routes it to that type (openFile).
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
        // Native and better-sidebar await the SAME effective preference. Only
        // after it resolves may we resolve the remote path and call openTab.
        void explorerAutoOpenPreference().then((enabled) => {
          if (!enabled || autoOpenedFor.has(sessionId)) return
          // Issue #13: only auto-open for a genuinely remote session. A plain
          // local session must never borrow the active machine's workspace.
          return resolveSessionRemote(sessionId).then((remotePath) => {
            if (!remotePath || autoOpenedFor.has(sessionId)) return
            autoOpenedFor.add(sessionId)
            try {
              bs.openTab({ type: SIDEBAR_EXPLORER_ID, title: tr('explorer.tabTitle'), path: remotePath })
            } catch (e2) {
              console.warn('[dsh-remote] better-sidebar auto-open skipped:', e2)
            }
          })
        })
      }
      tryAutoOpen()
      if (typeof bs.subscribeState === 'function') {
        disposeAuto = bs.subscribeState(tryAutoOpen)
        disposers.push(disposeAuto)
      }
      return () => disposers.forEach((d) => { try { d() } catch {} })
    }

    // Official Desktop's right-sidebar extension contract. Reuse the SSH
    // explorer/editor rather than replacing core Files or pretending remote
    // paths are local filesystem resources. Each address is session-scoped.
    const NATIVE_EXPLORER = 'dsh-remote/explorer'
    const NATIVE_FILE = 'dsh-remote/file'
    // Issue #55: the address the CORE emits for a file link, which is NOT the
    // one this plugin mints for its own explorer. A model-emitted
    // `[x](src/main.c)` (or a `@src/main.c` chip) is turned into
    // `dsh-resource://file/session/<sessionId>/<path>` by the chat, and the only
    // shipped claimant is the built-in text preview, which reads it through the
    // HOST's ctx.fs. For a remote Session the header cwd is the LOCAL MIRROR, so
    // the link opens an empty (or stale) local directory and fails. A plugin
    // cannot re-register protocol `file` (one provider per protocol, and it is
    // taken), so the supported interception is a tab type that CLAIMS that
    // address and serves it over SFTP instead.
    const NATIVE_LINK = 'dsh-remote/remote-link'
    function remoteFileAddress(sessionId, path) {
      return 'dsh-resource://dsh-remote/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(path)
    }
    function remoteFilePath(address) {
      const url = new URL(address)
      if (url.protocol !== 'dsh-resource:' || url.hostname !== 'dsh-remote') throw new Error('Invalid remote resource')
      return decodeURIComponent(url.pathname.split('/').slice(2).join('/'))
    }
    /**
     * Parse the core's `dsh-resource://file/session/<id>/<path>` address.
     *
     * Mirrors the grammar the core uses (`dsh-util-workspace-path`): the first
     * segment after the scheme is the scope (`session`), then the id, then the
     * path. Anything else — including the `absolute/` scope — is not ours: an
     * absolute remote path cannot be mapped back onto a mirror, so refusing is
     * correct rather than guessing.
     *
     * @param {string} address - the address a link click produced.
     * @returns {{sessionId: string, path: string}|null} the parts, or null when
     *   this is not a session-scoped core file address.
     */
    function parseCoreFileAddress(address) {
      let url
      try { url = new URL(String(address || '')) } catch { return null }
      if (url.protocol !== 'dsh-resource:' || url.hostname !== 'file') return null
      const rest = url.pathname.replace(/^\/+/, '')
      const [scope, ...tail] = rest.split('/')
      if (scope !== 'session' || tail.length < 2) return null
      let sessionId, decoded
      try {
        sessionId = decodeURIComponent(tail[0])
        decoded = decodeURIComponent(tail.slice(1).join('/'))
      } catch { return null } // A malformed link must not throw out of the host router.
      if (!sessionId) return null
      // Dropping the leading empty segment keeps a session-root address ('') a
      // legitimate empty path instead of turning it into '/'.
      // Issue #104 + #108: models cite lines as `path:42` / `path#L42`, and as
      // RANGES (`path:24-30`, `#L24-L30`) — the core's own prompt teaches the
      // range form. Range or not, the anchor is stripped from the path (no file
      // is ever looked up as "x.c:42"); we take the start line, like the core.
      const hashLine = /^#L?(\d+)(?:-L?\d+)?$/i.exec(url.hash || '')
      const split = splitLineAnchor(decoded)
      const line = hashLine ? Number(hashLine[1]) : split.line
      return { sessionId, path: split.path, ...(line ? { line } : {}) }
    }
    /**
     * The ABSOLUTE remote path a core file address refers to, or null.
     *
     * A relative link is mirror-rooted and an absolute one is already absolute;
     * either way what the reader must see is the path on the REMOTE host. The
     * session's own cwd (a mirror directory) identifies the mirror, whose record
     * carries the remote root the mirror was taken from — the same invariant
     * `lib/binding.js` uses host-side.
     *
     * Separator-aware on purpose (`mirrorForCwd` handles `/a/mirror` vs
     * `/a/mirror-2`): showing the WRONG remote file would be worse than the
     * current failure, so an ambiguous address returns null.
     *
     * @param {{sessionId: string, path: string}} parsed - a parsed core address.
     * @param {string} cwd - the session's local cwd (its mirror directory).
     * @returns {string} an absolute remote path, or null when it cannot be mapped.
     */
    function remotePathForCoreAddress(parsed, cwd) {
      const mirror = mirrorForCwd(cwd, MIRRORS.list)
      if (!mirror) return null
      const remoteRoot = String(mirror.remotePath || '').replace(/[\\/]+$/, '')
      // The REMOTE host's separator is INDEPENDENT of this machine's, and taking
      // it from the address was wrong: a Windows client mirroring a Linux host
      // is the ordinary case here, and reading the separator off the local path
      // then glued a POSIX root to a Windows join ("/home/u/app" + "\" + "x.c").
      // Decide from the remote root alone.
      const remoteIsWin = /^[A-Za-z]:/.test(remoteRoot) || (remoteRoot.includes('\\') && !remoteRoot.includes('/'))
      const remoteSep = remoteIsWin ? '\\' : '/'
      const toRemote = (s) => String(s).replace(/[\\/]+/g, remoteSep)
      // Comparison is separator-INSENSITIVE: `@` completion may insert either
      // style, and the two sides describe the same directory. The local side
      // folds case when it looks like a Windows path (Windows paths do).
      const canon = (s) => String(s).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
      const localDir = String(mirror.dir || '')
      const localIsWin = /^[A-Za-z]:/.test(localDir) || localDir.includes('\\')
      const fold = (s) => (localIsWin ? s.toLowerCase() : s)
      const rel = canon(parsed.path || '')
      const mirrorDir = canon(localDir)
      // The mirror's own directory prefix may be baked into the address when the
      // link was written against the LOCAL path (that is what `@` completion
      // inserts); strip it so the result is remote-relative rather than
      // duplicated under the remote root.
      const stripped = rel && mirrorDir && (fold(rel) === fold(mirrorDir) || fold(rel).startsWith(fold(mirrorDir) + '/'))
        ? rel.slice(mirrorDir.length).replace(/^\/+/, '')
        : rel
      const relBody = canon(stripped)
      if (!remoteRoot) return relBody ? toRemote(relBody) : remoteSep
      if (!relBody) return remoteRoot
      // A drive-letter absolute path on a POSIX remote is a LOCAL path that fell
      // outside the mirror: nothing on the remote can name it, so refuse rather
      // than invent "/home/u/app/D:/x.c".
      if (!remoteIsWin && /^[A-Za-z]:/.test(relBody)) return null
      // Genuinely absolute: the reader meant that path on the remote.
      if (/^[A-Za-z]:/.test(relBody) || /^\//.test(relBody)) return toRemote(relBody)
      return remoteRoot + remoteSep + toRemote(relBody)
    }
    function NativeExplorer(props) {
      const info = props.useTabInfo()
      const [expanded, setExpanded] = React.useState(() => explorerMemory.get(props.sessionId)?.expanded || [])
      React.useEffect(() => { setExpanded(explorerMemory.get(props.sessionId)?.expanded || []) }, [props.sessionId])
      const updateExpanded = (next) => setExpanded((old) => { const value = typeof next === 'function' ? next(old) : next; explorerMemory.set(props.sessionId, { ...explorerMemory.get(props.sessionId), expanded: value }); return value })
      return React.createElement(RemoteExplorerTab, {
        scope: { sessionId: props.sessionId }, visible: info.tab.visible,
        expanded,
        onToggleDir: (path) => updateExpanded((old) => old.includes(path) ? old.filter((p) => p !== path) : [...old, path]),
        onCollapseAll: () => updateExpanded([]),
        onOpenFile: (path) => info.tab.actions.openResource(remoteFileAddress(props.sessionId, path)),
      })
    }
    function NativeFile(props) {
      const info = props.useTabInfo()
      const path = remoteFilePath(info.tab.navigation.address)
      return React.createElement(RemoteFileTab, { key: path, tab: { path }, scope: { sessionId: props.sessionId }, navigationRevision: info.tab.navigation.revision })
    }
    /**
     * The body for a CORE file link in a remote Session (issue #55).
     *
     * It resolves the address to an absolute REMOTE path before rendering the
     * same editor the plugin's own explorer uses, so a link and the explorer
     * agree on what a path means. Resolution is attempted synchronously first
     * (the mirror registry is usually warm) and retried once the registry
     * arrives, so a click during page load still ends up in the right file.
     */
    function NativeRemoteLink(props) {
      const info = props.useTabInfo()
      const address = info.tab.navigation.address
      const parsed = parseCoreFileAddress(address)
      const sessionId = (parsed && parsed.sessionId) || props.sessionId
      // Resolve from the current navigation on every render. Keeping only an
      // initial path in state made same-tab navigation continue reading the old file.
      const [, invalidate] = React.useState(0)
      const remotePath = parsed ? remotePathForCoreAddress(parsed, sessionCwdFor(sessionId)) : null
      React.useEffect(() => {
        const changed = () => invalidate((version) => version + 1)
        mirrorWatchers.add(changed)
        const unsubscribe = SESSIONS?.list?.subscribe?.(changed)
        ensureMirrors()
        return () => {
          mirrorWatchers.delete(changed)
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [sessionId])
      if (!remotePath) {
        return React.createElement('div', { style: { padding: 16, fontSize: 12, opacity: 0.7 } },
          tr('file.linkUnresolved'))
      }
      // Issue #104 + #108: the line reaches us two ways — inside the address
      // (`x.c:42` / `#L42`, ranges take the start line) and, on 0.2.x, through
      // navigation params (`openResource(url, {params:{line}})`); the address
      // grammar itself never carries one.
      const paramsLine = (() => {
        try {
          const line = info.tab && info.tab.navigation && info.tab.navigation.params && info.tab.navigation.params.line
          // Host params are the current channel when the address has no
          // explicit anchor. Accept only actual positive integers: do not
          // coerce a string like "93" or let invalid params mask a legacy #L2.
          return Number.isSafeInteger(line) && line > 0 ? line : null
        } catch { return null }
      })()
      return React.createElement(RemoteFileTab, {
        key: remotePath,
        tab: { path: remotePath },
        scope: { sessionId },
        // Current hosts pass line numbers as navigation params; retain support
        // for older address-carried anchors. Invalid params must not mask them.
        jumpLine: (parsed && parsed.line) || paramsLine || null,
        navigationRevision: info.tab.navigation.revision,
      })
    }
    /** The local cwd of a session, from the client's own session store. */
    function sessionCwdFor(sessionId) {
      try {
        const list = SESSIONS && SESSIONS.list && typeof SESSIONS.list.getSnapshot === 'function'
          ? SESSIONS.list.getSnapshot()
          : null
        const entry = list && list.byId && list.byId[sessionId]
        return (entry && entry.cwd) ? String(entry.cwd) : ''
      } catch { return '' }
    }
    // The shipped workspace-files command opens kind "files". Route that
    // intent before navigation, using the captured session's binding; retain
    // the host's original page for local sessions and every other kind.
    function routeWorkspaceFiles(sidebar) {
      const originals = new Map(), pending = new Map()
      let disposed = false
      const install = (method, kindIndex, sessionIndex) => {
        const original = sidebar[method]
        if (typeof original !== 'function') return
        function routed(...args) {
          if (disposed) return Reflect.apply(original, this, args)
          const kind = args[kindIndex]
          const sessionId = sessionIndex == null ? sidebar.mounted?.getSnapshot?.() : args[sessionIndex]
          const revision = (pending.get(sessionId) || 0) + 1
          pending.set(sessionId, revision)
          if (kind !== 'files' || !sessionId) return Reflect.apply(original, this, args)
          const owner = this
          const open = () => {
            if (disposed || pending.get(sessionId) !== revision) return
            if (sessionIndex == null && sidebar.mounted?.getSnapshot?.() !== sessionId) return
            const remote = mirrorForCwd(sessionCwdFor(sessionId), MIRRORS.list)
            const next = args.slice()
            next[kindIndex] = remote ? NATIVE_EXPLORER : kind
            return Reflect.apply(original, owner, next)
          }
          if (MIRRORS.loaded) return open()
          void ensureMirrors().then(open)
        }
        try { sidebar[method] = routed; originals.set(method, { original, routed }) } catch { /* older readonly controller */ }
      }
      install('openTab', 0, null)
      // Session-bound tab actions use this controller face on 0.2.x; it is
      // optional so older public controllers still get the main entry routing.
      install('openTabIn', 1, 0)
      return () => {
        disposed = true; pending.clear()
        for (const [method, { original, routed }] of originals) if (sidebar[method] === routed) sidebar[method] = original
      }
    }

    function registerNativeSidebar(inner) {
      const tabs = inner.get('sidebarRightTabs')
      const slots = inner.get('slots')
      // Whether this build accepted the remote-link type. A local (not module
      // level) flag, so two plugin lifetimes cannot see each other's state.
      let linkTypeAccepted = false
      // Issue #55: `canOpen` is synchronous and runs on every routing decision,
      // so the mirror registry has to be warm BEFORE the first link click —
      // otherwise the very first click of a page load falls through to the
      // built-in local preview. This is a warm-up, not a dependency: a failure
      // just leaves the conservative behaviour in place.
      try { ensureMirrors() } catch { /* the registry is best-effort */ }
      // ── Who owns the 开始 card ────────────────────────────────────────────
      // The 远程文件 card on the right sidebar's start page (开始) is the
      // `guide` entry of a native tab type, and TWO providers can publish one:
      // this plugin (below) and dsh-better-sidebar, which registers a native
      // type per tab descriptor it hosts — our `dsh-remote:explorer` gets a
      // guide row of its own there, governed by its side-card settings switch.
      //
      // Publishing both is what made that switch look broken: turning the type
      // off removed better-sidebar's row and left ours, so the card never went
      // away. The card therefore belongs to exactly ONE provider:
      //   · better-sidebar in the composition → ITS descriptor owns the card
      //     (its switch IS the switch for it), and this type is registered
      //     without a guide entry. The type and its body stay: a tab opened by
      //     kind still renders, and nothing else about the panel changes.
      //   · plain install → the card is ours, always, exactly as before.
      //
      // `guide` is captured at registration time and an id may not be
      // registered twice, so a handover means dispose-then-register inside one
      // synchronous block: no render can observe the gap.
      let betterSidebar = false
      let disposed = false
      let disposeExplorer = null
      let guideListed = null
      const syncExplorerType = () => {
        const withGuide = !betterSidebar
        explorerOwnedByBs = betterSidebar
        if (guideListed === withGuide && disposeExplorer) return
        const previous = disposeExplorer
        disposeExplorer = null
        if (previous) { try { previous() } catch { /* already released */ } }
        disposeExplorer = tabs.register({
          id: NATIVE_EXPLORER, kind: NATIVE_EXPLORER,
          title: () => tr('explorer.tabTitle'),
          ...(withGuide ? { guide: [{ order: 55, title: () => tr('explorer.tabTitle') }] } : {}),
        })
        guideListed = withGuide
      }
      inner.effect(() => {
        syncExplorerType()
        return () => {
          disposed = true
          const dispose = disposeExplorer
          disposeExplorer = null
          guideListed = null
          if (dispose) { try { dispose() } catch { /* already released */ } }
        }
      }, 'dsh-remote.native-explorer-type')
      // The two plugins may activate in EITHER order, so the service has to be
      // followed rather than read once: the card moves to better-sidebar when
      // it arrives, and comes back here if it goes away.
      inner.inject(['betterSidebar'], (withSidebar) => {
        betterSidebar = true
        try { syncExplorerType() } catch (e) { console.warn('[dsh-remote] start-page card handover skipped:', e) }
        if (!withSidebar || typeof withSidebar.effect !== 'function') return
        withSidebar.effect(() => () => {
          betterSidebar = false
          if (disposed) return
          try { syncExplorerType() } catch (e) { console.warn('[dsh-remote] start-page card handover skipped:', e) }
        }, 'dsh-remote.start-card-owner')
      })
      inner.effect(() => tabs.register({
        id: NATIVE_FILE, kind: NATIVE_FILE,
        patterns: ['dsh-resource://dsh-remote/**'],
        title: (address) => remoteFilePath(address).split(/[\\/]/).pop() || tr('explorer.tabTitle'),
      }), 'dsh-remote.native-file-type')
      // Issue #55. No `priority` is declared, so this registers in the
      // `extension` band, which by contract outranks every viewer the product
      // ships — including the built-in text preview that currently claims
      // `dsh-resource://file/**` in the `fallback` band and reads locally.
      // better-sidebar also registers an extension-band editor, so the more
      // specific session/** pattern below must win the pattern-length tie-break.
      // `canOpen` is the safety guard: it must return true ONLY for a
      // session whose cwd is PROVEN to be a remote mirror. Local sessions, and
      // a page load before the mirror registry has arrived, fall through to the
      // built-in preview and behave exactly as they did before.
      //
      // Registration is wrapped because the address-claiming half of this
      // contract (`patterns` + `canOpen`) is not something every DSH line
      // necessarily has. The plugin supports both the 0.1.x and 0.2.x lines, and
      // on a build whose tab registry cannot express an address claim the right
      // outcome is "file links keep working the old way" — NOT a throw that
      // would take the explorer and file types down with it.
      inner.effect(() => {
        try {
          const dispose = tabs.register({
            id: NATIVE_LINK, kind: NATIVE_LINK,
            // Specificity beats bundle order: the registry ranks longest-glob-first,
            // and ties fall to registration order (which we do not control). Another
            // extension claiming `dsh-resource://file/**` used to win those ties and
            // read the local mirror (ENOENT) even for provably remote sessions
            // (issue #108). The narrower glob matches exactly what
            // parseCoreFileAddress accepts — the session scope.
            patterns: ['dsh-resource://file/session/**'],
            canOpen: (address) => {
              const parsed = parseCoreFileAddress(address)
              if (!parsed) return false
              // Issue #74: .md/.markdown are claimed too. The built-in Markdown
              // preview reads the LOCAL MIRROR — for a remote session a link to a
              // file that was never synced dies with ENOENT and shows nothing at
              // all. This editor opens the file over SFTP and RENDERS it via the
              // host's MarkdownText (source only when the primitive is missing),
              // so claiming is no longer a downgrade. Local sessions still fall
              // through: their cwd is not a mirror, proven below.
              const cwd = sessionCwdFor(parsed.sessionId)
              // `MIRRORS.loaded` is checked so a cold start NEVER steals a local
              // link: an empty registry cannot prove a mirror, and guessing would
              // break the text preview for every local session.
              if (!cwd || !MIRRORS.loaded) return false
              // Ask the SAME resolver the body uses, not merely whether the cwd
              // is a mirror. A remote session can cite a LOCAL absolute path
              // outside that mirror (e.g. D:/tmp/report.md on a POSIX remote):
              // the old check claimed it here, then NativeRemoteLink rejected it
              // and showed file.linkUnresolved. Refusing it here hands the address
              // back to the built-in LOCAL editor, which is the correct owner.
              return !!remotePathForCoreAddress(parsed, cwd)
            },
            title: (address) => {
              const parsed = parseCoreFileAddress(address)
              return ((parsed && parsed.path) || '').split(/[\\/]/).pop() || tr('explorer.tabTitle')
            },
          })
          linkTypeAccepted = true
          return () => { linkTypeAccepted = false; if (typeof dispose === 'function') dispose() }
        } catch (err) {
          try { console.warn('dsh-remote: remote file links are unavailable on this DSH build', err) } catch { /* no console */ }
          return undefined
        }
      }, 'dsh-remote.native-link-type')
      inner.effect(() => slots.inject('sidebar.right.pane.tab', () => {
        const disposers = [
          slots.register({ name: 'sidebar.right.pane.tab', key: NATIVE_EXPLORER }, NativeExplorer),
          slots.register({ name: 'sidebar.right.pane.tab', key: NATIVE_FILE }, NativeFile),
        ]
        // Only register the link body when its type was accepted: a body under a
        // kind nothing claims would never render, and on a build that rejected
        // the type the seat may reject the body too.
        if (linkTypeAccepted) {
          disposers.push(slots.register({ name: 'sidebar.right.pane.tab', key: NATIVE_LINK }, NativeRemoteLink))
        }
        return () => disposers.forEach((dispose) => dispose())
      }), 'dsh-remote.native-bodies')
    }


    // Native Tool views are keyed by wire name; older hosts simply omit this seat.
    const REMOTE_TOOL_TITLES = {
      rw_exec: 'exec', rw_read_file: 'read', rw_edit: 'edit', rw_write_file: 'write', rw_append: 'write',
      rw_search: 'search', rw_list_dir: 'list', rw_sync: 'sync', rw_push: 'push',
    }
    function remoteToolView(props) {
      const block = props.block || {}
      const done = props.phase === 'result'
      let args = {}
      try { args = JSON.parse((done ? block.call?.argsRaw : block.argsRaw) || '{}') || {} } catch { /* partial or historic arguments */ }
      const output = (block.content || []).map((part) => part.type === 'text' ? part.text : '').filter(Boolean).join('\n')
      const facts = block.meta?.kind === 'dsh-remote.exec' && block.meta.version === 1 ? block.meta : null
      const exit = /(?:^|\n)\[exit code: (-?\d+)\]\s*$/.exec(output)
      const interruption = String(block.error?.code || '') + ' ' + String(block.error?.name || '')
      let status = !done ? props.phase === 'preparing' ? 'preparing' : 'running'
        : /abort|cancel|interrupted/i.test(interruption) ? 'stopped' : /timeout|timed.?out/i.test(interruption) ? 'timeout' : block.isError ? 'failed'
        : facts && ['completed', 'failed', 'stopped', 'timeout', 'background', 'unknown'].includes(facts.status) ? facts.status
        : props.toolName !== 'rw_exec' ? 'completed'
        : /\[cancelled[ —]/.test(output) ? 'stopped' : /\[command timed out after \d+ms\]/.test(output) ? 'timeout'
        : exit ? (Number(exit[1]) === 0 ? 'completed' : 'failed') : 'unknown'
      // Never manufacture a successful exit code for a historical transcript.
      if (status === 'completed' && props.toolName === 'rw_exec' && facts && facts.code !== 0) status = 'unknown'
      const code = facts && Number.isInteger(facts.code) ? facts.code : exit ? Number(exit[1]) : null
      const diagnostics = []
      const seen = new Set()
      const clean = output.slice(0, 200000).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      for (const line of clean.split('\n')) {
        const gcc = /^(.+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning|note):\s*(.*)$/.exec(line)
        const tsc = !gcc && /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([^:]+):\s*(.*)$/.exec(line)
        const match = gcc || tsc
        if (!match) continue
        const item = { path: match[1].trim(), line: Number(match[2]), column: Number(match[3]) || 1, severity: match[4], message: gcc ? match[5] : match[5] + ': ' + match[6] }
        if (!item.path || /[\x00-\x1f\x7f]/.test(item.path) || !Number.isSafeInteger(item.line) || item.line < 1) continue
        const key = JSON.stringify(item)
        if (!seen.has(key)) { seen.add(key); diagnostics.push(item) }
        if (diagnostics.length >= 200) break
      }
      return { args, output, status, code, facts, diagnostics }
    }
    function RemoteToolCard(props) {
      const view = remoteToolView(props)
      const failed = view.status === 'failed' || view.status === 'timeout'
      const diagnosticErrors = view.diagnostics.filter((item) => /error/.test(item.severity)).length
      const attention = failed || diagnosticErrors > 0
      const [localOpen, setLocalOpen] = React.useState(attention)
      const disclosure = props.useDisclosure ? props.useDisclosure() : null
      const [touched, setTouched] = React.useState(false)
      const open = attention && !touched || (disclosure ? disclosure.expanded : localOpen)
      const setOpen = disclosure ? disclosure.setExpanded : setLocalOpen

      const [copied, setCopied] = React.useState(false)
      const copyTimer = React.useRef(null)
      React.useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])
      const title = tr(`agent.${REMOTE_TOOL_TITLES[props.toolName] || 'other'}`)
      const filePath = view.args.path || view.args.file_path || ''
      const summary = props.toolName === 'rw_exec' ? view.args.command || '' : filePath || view.args.query || ''
      const color = attention ? T.danger : view.status === 'completed' ? T.ok : ['stopped', 'unknown', 'timeout'].includes(view.status) ? T.warn : T.muted
      const bodyId = React.useId()
      const outputId = React.useId()
      const openPath = (path, line) => {
        if (typeof props.openFile !== 'function') return
        const cwd = view.facts?.cwd || view.args.cwd || ''
        const absolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
        props.openFile(!absolute && cwd ? joinRemote(cwd, path) : path, line ? { line } : undefined)
      }
      const copy = async () => {
        if (await copyToClipboard(view.output)) {
          setCopied(true)
          if (copyTimer.current) clearTimeout(copyTimer.current)
          copyTimer.current = setTimeout(() => setCopied(false), 1600)
        }
      }
      return React.createElement('section', { className: 'dsh-rw-agent-card', 'data-rw-agent-status': view.status, 'data-rw-agent-tool': props.toolName, style: { borderColor: attention ? T.danger : T.border, color: T.label } },
        React.createElement('button', { type: 'button', className: 'dsh-rw-agent-header', 'aria-expanded': !!open, 'aria-controls': bodyId, onClick: () => { setTouched(true); setOpen(!open) }, title: summary },
          React.createElement(WorkbenchIcon, { name: open ? 'down' : 'right', size: 12 }),
          React.createElement(WorkbenchIcon, { name: props.toolName === 'rw_exec' ? 'terminal' : props.toolName === 'rw_search' ? 'search' : 'file' }),
          React.createElement('strong', { style: { flexShrink: 0, fontWeight: 500 } }, title),
          React.createElement('span', { className: 'dsh-rw-agent-summary', style: { color: T.muted } }, summary),
          React.createElement('span', { style: { color, flexShrink: 0, fontSize: 11 } }, tr(`agent.${view.status}`)),
          diagnosticErrors ? React.createElement('span', { style: { color: T.danger, flexShrink: 0, fontSize: 11 } }, tr('agent.diagnosticErrors', { n: diagnosticErrors })) : null,
          view.code != null && view.code >= 0 ? React.createElement('span', { style: { color, flexShrink: 0, fontSize: 11 } }, tr('agent.exit', { code: view.code })) : null),
        open ? React.createElement('div', { id: bodyId, style: { borderTop: '1px solid ' + T.border } },
          React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', padding: '6px 10px', fontSize: 11, color: T.muted, alignItems: 'center' } },
            view.facts?.host ? React.createElement('span', {}, 'SSH · ' + view.facts.host) : null,
            view.facts?.cwd || view.args.cwd ? React.createElement('span', { className: 'dsh-rw-path', style: { flex: 1 }, title: view.facts?.cwd || view.args.cwd }, view.facts?.cwd || view.args.cwd) : null,
            view.code != null ? React.createElement('span', { style: { color } }, tr('agent.exit', { code: view.code })) : null,
            view.facts && Number.isFinite(view.facts.durationMs) ? React.createElement('span', {}, tr('agent.duration', { n: (view.facts.durationMs / 1000).toFixed(1) })) : null,
            view.output ? React.createElement(WorkbenchAction, { icon: 'copy', label: copied ? tr('explorer.copied') : tr('workbench.copyContent'), onClick: copy }) : null,
            props.inspect ? React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '3px 6px', fontSize: 11 }, onClick: props.inspect }, tr('agent.inspect')) : null),
          filePath && props.openFile ? React.createElement('button', { type: 'button', className: 'dsh-rw-agent-diagnostic', style: { margin: '0 10px' }, onClick: () => openPath(filePath) }, filePath) : null,
          view.diagnostics.length ? React.createElement('div', { style: { padding: '6px 12px', borderTop: '1px solid ' + T.border } },
            React.createElement('strong', { style: { fontSize: 12 } }, tr('agent.diagnostics') + ' · ' + view.diagnostics.length),
            view.diagnostics.map((item, index) => React.createElement('button', { key: index, type: 'button', className: 'dsh-rw-agent-diagnostic', disabled: !props.openFile, 'aria-label': tr('agent.open', item), onClick: () => openPath(item.path, item.line), style: { color: /error/.test(item.severity) ? T.danger : T.warn } }, item.path + ':' + item.line + ':' + item.column + ' · ' + item.message))) : null,
          props.toolName === 'rw_edit' && typeof (view.args.old ?? view.args.old_string) === 'string' ? React.createElement('div', { style: { borderTop: '1px solid ' + T.border, fontSize: 11 } },
            React.createElement('div', { style: { padding: '4px 12px', color: T.muted } }, tr('agent.before')),
            React.createElement('pre', { className: 'dsh-rw-agent-output', style: { color: T.danger } }, String(view.args.old ?? view.args.old_string).slice(0, 20000)),
            React.createElement('div', { style: { padding: '4px 12px', color: T.muted } }, tr('agent.after')),
            React.createElement('pre', { className: 'dsh-rw-agent-output', style: { color: T.ok } }, String(view.args.new ?? view.args.new_string ?? '').slice(0, 20000))) : null,
          view.output ? React.createElement('pre', { id: outputId, className: 'dsh-rw-agent-output', tabIndex: 0, 'aria-label': tr('agent.raw'), style: { background: T.bg } }, view.output.slice(0, 100000)) : null,
          view.output.length > 100000 ? React.createElement('div', { style: { padding: 8, fontSize: 11, color: T.warn } }, tr('agent.truncated')) : null,
        ) : null,
      )
    }

    function apply(ctx) {
      ensureChromeCss()
      const slots = ctx.get('slots')
      ctx.effect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
        const onUnload = (event) => {
          if (!remoteDrafts.size && !settingsEditorDraft && !settingsSshDraft) return
          event.preventDefault(); event.returnValue = ''
        }
        window.addEventListener('beforeunload', onUnload)
        return () => window.removeEventListener('beforeunload', onUnload)
      }, 'dsh-remote.unsaved-drafts')
      wireLocale(ctx)
      slots.inject('tool.call.toolview', () => {
        for (const key of Object.keys(REMOTE_TOOL_TITLES)) slots.register({ name: 'tool.call.toolview', key }, RemoteToolCard)
      })
      // Optional integrations must not gate the settings page. In particular,
      // replacement sidebars may disable the native ui-workspace package.
      ctx.inject(['sessions'], (inner) => {
        const sessions = inner.get('sessions')
        SESSIONS = sessions
        inner.effect(() => () => {
          if (SESSIONS === sessions) SESSIONS = null
        }, 'dsh-remote.sessions')
      })
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'dsh-remote', order: 40, label: () => tr('settings.pageTitle') }, props => React.createElement(RemoteWorkspacePage, props)),
      )
      slots.inject('settings.section.icon', () => {
        nativeSettingsIcon = true
        const dispose = slots.register({ name: 'settings.section.icon', id: 'dsh-remote' }, props => React.createElement('span', { 'data-rw-settings-icon': true, style: { display: 'inline-flex' } }, React.createElement(WorkbenchIcon, { name: 'remote', size: props.size || 16 })))
        return () => { nativeSettingsIcon = false; if (typeof dispose === 'function') dispose() }
      })
      ctx.effect(legacySettingsIcon, 'dsh-remote.legacy-settings-icon')
      for (const slot of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) {
        slots.inject(slot, () =>
          slots.register({ name: slot, id: 'dsh-remote', priority: -100 }, DirPicker),
        )
      }
      ctx.inject(['betterSidebar'], (inner) => {
        inner.effect(() => registerSidebarIntegration(inner), 'dsh-remote.betterSidebar')
      })
      ctx.inject(['sidebarRightTabs'], registerNativeSidebar)
      ctx.inject(['webTerminals'], (inner) => {
        const service = inner.get('webTerminals')
        WEB_TERMINALS = service
        inner.effect(() => () => { if (WEB_TERMINALS === service) WEB_TERMINALS = null }, 'dsh-remote.web-terminals')
      })
      ctx.inject(['sidebarRight'], (inner) => {
        const svc = inner.get('sidebarRight')
        SIDEBAR_RIGHT = svc
        inner.effect(() => routeWorkspaceFiles(svc), 'dsh-remote.workspace-files-route')
        inner.effect(() => () => { if (SIDEBAR_RIGHT === svc) SIDEBAR_RIGHT = null }, 'dsh-remote.sidebarRight')
      })
      // Issue #49: mark the remote Sessions in the sidebar's own Session list.
      // These three seats belong to the SHIPPED ui-workspace browser, so they
      // are injected (not assumed): a composition with a replacement sidebar
      // simply never declares them, and the mark is absent rather than broken.
      slots.inject('sidebar.session.row.leading', () =>
        slots.register({ name: 'sidebar.session.row.leading', id: 'dsh-remote-remote-mark', order: 5 }, RemoteSessionMark),
      )
      slots.inject('sidebar.session.row.hover', () =>
        slots.register({ name: 'sidebar.session.row.hover', id: 'dsh-remote-remote-host', order: 5 }, RemoteSessionHover),
      )
      slots.inject('conversation.session.header.utilities', () =>
        slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-remote-remote-chip', order: 15 }, RemoteSessionChip),
      )
    }

    exports.name = name
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
