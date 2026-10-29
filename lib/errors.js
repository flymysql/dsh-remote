// dsh-remote — SSH/SFTP error classification → actionable hints.
// Pure function so it is unit-testable and reused by tools, slash commands,
// the test-connect route and the settings UI.

/** Classify an error thrown by the ssh pool / sftp wrapper.
 * @returns {{ category: 'auth'|'network'|'hostkey'|'timeout'|'sftp'|'credentials'|'other', hint: string, raw: string }}
 */
export function classifyError(err, opts = {}) {
  const msg = String((err && err.message) || err || '')
  const { host, port } = opts
  const where = host ? ` (${host}:${port || 22})` : ''

  if (/host key/i.test(msg) && /(change|mismatch|fingerprint|verify|unknown host)/i.test(msg)) {
    return {
      category: 'hostkey',
      hint: `主机指纹校验失败${where}：可能遭遇中间人攻击，或该主机重装/更换过密钥。确认无异常后执行 /remote-forget-key 重新信任。`,
      raw: msg,
    }
  }
  if (/permission denied|all configured authentication methods failed|authentication failed/i.test(msg)) {
    return {
      category: 'auth',
      hint: `认证失败${where}：检查用户名/密码/私钥路径，私钥是否设了 passphrase；若公司机器要求 OTP/动态码，请确认机器配置了 keyboard-interactive 或对应密码。`,
      raw: msg,
    }
  }
  // Checked BEFORE the generic `no credentials` branch: the actionable failure
  // there is "this process has no ssh-agent", not "you forgot to configure a
  // credential". Telling a Windows user to "set a password or a privateKeyPath"
  // when they already ticked 使用 SSH agent is how a config page gets a
  // reputation for lying.
  if (/no SSH agent available|SSH_AUTH_SOCK/i.test(msg)) {
    return {
      category: 'credentials',
      hint: `SSH agent 不可用${where}：这台机器勾选了「使用 SSH agent」，但 DSH 宿主进程里没有 SSH_AUTH_SOCK（Windows 默认没有 agent 服务）。要么在启动 DSH 之前把 agent 跑起来并导出 SSH_AUTH_SOCK（或用 Pageant），要么取消勾选 agent 并给这台机器保存密码/私钥。`,
      raw: msg,
    }
  }
  if (/no credentials/i.test(msg)) {
    return {
      category: 'credentials',
      hint: `缺少凭据${where}：这台机器没有可用密码、私钥或 agent。请在「远程工作区」设置里填密码（或用私钥路径 / 勾选 agent）后保存；若你确信已经填过，说明保存时密码没有真正落盘（看保存后是否弹出密钥库失败警告），重新填写并保存即可，可用「测试连接」当场验证。`,
      raw: msg,
    }
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return {
      category: 'network',
      hint: `主机不可达${where}：检查 host 拼写 / IP / DNS；内网机器可能需要走跳板机（配置 proxy）或 VPN。`,
      raw: msg,
    }
  }
  // ssh2 reports a socket that dies DURING the handshake as the bare string
  // "Connection lost before handshake" — no host, no cause, no advice. That is
  // the message a user sees when the port is open but nothing speaks SSH on it,
  // or when a firewall/security group cuts the connection after the TCP accept;
  // it is indistinguishable from "wrong credentials" unless it is classified.
  if (/connection lost before handshake|handshake failed|no matching (key exchange|host key|cipher)/i.test(msg)) {
    return {
      category: 'network',
      hint: `SSH 握手未完成${where}：TCP 连上了但 SSH 握手没走完——端口上没有跑 sshd、连接被防火墙/安全组拒绝、或远端只支持不兼容的加密算法。确认 host/port 指向 sshd，必要时换端口或让运维放行。`,
      raw: msg,
    }
  }
  if (/ECONNREFUSED|connection refused/i.test(msg)) {
    return {
      category: 'network',
      hint: `连接被拒绝${where}：确认端口 ${port || 22} 正确、远端 sshd 在监听；检查防火墙/安全组是否放行。`,
      raw: msg,
    }
  }
  if (/sftp operation timed out|sftp failed|readdir|writeFile|fastGet|fastPut/i.test(msg)) {
    return {
      category: 'sftp',
      hint: `SFTP 操作失败：可能是远端磁盘/权限问题或服务器卡死（已自动超时保护）。检查目标路径权限。`,
      raw: msg,
    }
  }
  if (/ETIMEDOUT|timed out|timeout/i.test(msg)) {
    return {
      category: 'timeout',
      hint: `连接/操作超时${where}：检查端口、防火墙、路由；或调大 connectTimeoutMs / commandTimeoutMs。`,
      raw: msg,
    }
  }
  if (/cannot read private key/i.test(msg)) {
    return {
      category: 'credentials',
      hint: `无法读取私钥文件：检查 privateKeyPath 是否存在、当前用户是否有读取权限。`,
      raw: msg,
    }
  }
  // ssh2 throws these SYNCHRONOUSLY from Client.connect (issue #48) — the most
  // common one is an encrypted OpenSSH key without a passphrase.
  if (/no passphrase given|cannot parse privatekey|does not contain a \(valid\) private key/i.test(msg)) {
    return {
      category: 'credentials',
      hint: `私钥解析失败${where}：私钥已加密但未提供 passphrase，或私钥格式不受支持。请为该机器填写 passphrase，或改用未加密/受支持格式（OpenSSH/PEM）的私钥。`,
      raw: msg,
    }
  }
  return { category: 'other', hint: msg, raw: msg }
}

/** One-line friendly message: hint (+ raw when it adds information).
 *
 *  An UNCLASSIFIED failure still gets the host appended: "Connection lost before
 *  handshake" or a raw errno on its own leaves the user unable to tell WHICH
 *  machine failed, which is the one thing a multi-machine plugin must never hide. */
export function friendlyMessage(err, opts = {}) {
  const c = classifyError(err, opts)
  const where = opts.host ? ` (${opts.host}:${opts.port || 22})` : ''
  if (c.category === 'other') {
    return where && !c.raw.includes(opts.host) ? `${c.raw}${where}` : c.raw
  }
  if (c.raw && c.raw !== c.hint) return `${c.hint}（原始错误：${c.raw}）`
  return c.hint
}
