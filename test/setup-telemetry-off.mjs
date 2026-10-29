// 测试前置：保证整个测试进程**不产生任何外部副作用**。
//
// 这里守两条线，都是踩过事故后加的：
//
// ① 统计心跳。`upload.test.js` 会调用真实的 `apply()`，而 apply() 里有
//    `void sendHeartbeat(...)`，于是跑一次 npm test 就真的往生产统计里灌了假机器
//    —— 线上 dsh_blog_daily 里因此出现过来自 CI 的行，看起来像"多了两个 Linux 用户"。
//    这里把端点指向一个必定失败的本地地址。
//
// ② 用户的 `~/.ssh/config`。保存机器时插件会 upsert 一个 `# dsh-remote: managed`
//    Host 块到 ssh 配置里（issue #50 的设计：文件是唯一事实源）。测试里"保存一台
//    假机器"于是真的改了开发机的 ssh 配置 —— 实测在 ~/.ssh/config 里留下过
//    `Host 127.0.0.1 / Port 1`、`Host 10.9.9.6..9` 这类测试机器，而
//    `Host 127.0.0.1` 又会**反过来劫持**后续测试要连的 127.0.0.1（别名解析把它
//    改写到测试端口），于是假 SSH 服务器的测试莫名其妙连不上。
//    插件本身留了 `DSH_REMOTE_SSH_CONFIG` 覆盖口，这里把整轮测试指向一个临时文件。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.DSH_REMOTE_HEARTBEAT_URL = 'https://127.0.0.1:9/heartbeat-disabled-in-tests'

// ③ 本机目录选择器对话框。`/dsh-remote/local-pick` 会 spawn 一个真正的
//    FolderBrowserDialog / osascript / zenity，然后**等人类点确定**。测试（和 CI、
//    以及无桌面的宿主）一旦碰到这条路由就会挂住 —— 实测一次矩阵测试卡满 30s 超时。
//    插件留了 `DSH_REMOTE_NO_NATIVE_DIALOG` 口子，这里直接关掉。
process.env.DSH_REMOTE_NO_NATIVE_DIALOG = '1'

// 一个进程一个临时 ssh 配置：进程内的测试互不干扰，也永远不碰真实 home。
const sandbox = mkdtempSync(path.join(tmpdir(), 'dsh-remote-sshconfig-'))
process.env.DSH_REMOTE_SSH_CONFIG = path.join(sandbox, 'config')
