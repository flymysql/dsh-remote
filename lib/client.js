// dsh-remote — remote-access assistant for DeepSeek Harness (Client half).
//
// Settings → 远程访问 (Remote Access): shows the live port, LAN IPs, trusted
// hosts and the exact SSH tunnel / reverse-tunnel / reverse-proxy commands,
// with a copy button. Data comes from the host half's JSON endpoint
// (GET /dsh-remote/info) served by the official `webServer` service.
//
// Client entries must be classic scripts that register via
// window.__ModuleLoader__.load({ id, factory }); the factory receives a
// synchronous `require` and returns the module exports.
window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const name = 'dsh-remote'

    async function fetchInfo(target) {
      const q = target ? '?target=' + encodeURIComponent(target) : ''
      const res = await fetch('/dsh-remote/info' + q)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status)
      return data
    }

    function RemotePage() {
      const [info, setInfo] = React.useState(null)
      const [error, setError] = React.useState('')
      const [target, setTarget] = React.useState('')
      const [copied, setCopied] = React.useState(false)

      const refresh = (t) => {
        fetchInfo(t || '')
          .then(setInfo)
          .catch((err) => setError(String((err && err.message) || err)))
      }

      React.useEffect(() => {
        refresh('')
      }, [])

      const copy = (text) => {
        if (navigator && navigator.clipboard) {
          navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
            .catch(() => {})
        }
      }

      const block = (title, code) =>
        React.createElement(
          'div',
          { key: title, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } }, title),
          React.createElement('code', {
            style: {
              display: 'block',
              padding: '8px 10px',
              borderRadius: '6px',
              border: '1px solid rgba(128,128,128,0.35)',
              fontSize: '12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            },
          }, code),
          React.createElement('button', { onClick: () => copy(code), style: { alignSelf: 'flex-start' } }, '复制'),
        )

      if (error)
        return React.createElement('div', { style: { color: '#e06c75', padding: 16 } }, error)
      if (!info)
        return React.createElement('div', { style: { padding: 16, opacity: 0.6 } }, '加载中…')

      const c = info.commands || {}
      const lan = Array.isArray(info.lanAddresses) ? info.lanAddresses : []
      const trusted = Array.isArray(info.trustedHosts) ? info.trustedHosts : []

      return React.createElement(
        'div',
        { style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' } },
        React.createElement('div', { style: { fontWeight: 600 } }, '远程访问（dsh-remote）'),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '13px' } },
          React.createElement('span', null, 'Web GUI: ', React.createElement('code', null, info.url)),
          React.createElement('span', null, '端口: ', React.createElement('code', null, String(info.port))),
          lan.length
            ? React.createElement('span', null, '局域网: ', React.createElement('code', null, lan.join(', ')))
            : null,
          trusted.length
            ? React.createElement('span', null, 'trusted hosts: ', React.createElement('code', null, trusted.join(', ')))
            : null,
        ),
        React.createElement('div', { style: { fontSize: '12px', opacity: 0.75 } },
          '跨机器访问请用 SSH 隧道。harness 默认只监听 127.0.0.1，这是官方安全设计（GUI 无鉴权，--host 0.0.0.0 被刻意拒绝）。可选：输入 user@host 生成具体命令。',
        ),
        React.createElement('div', { style: { display: 'flex', gap: '8px' } },
          React.createElement('input', {
            value: target,
            onChange: (ev) => setTarget(ev.target.value),
            placeholder: 'user@remote-host（可选）',
            style: { flex: 1 },
          }),
          React.createElement('button', { onClick: () => refresh(target) }, '生成'),
        ),
        c.localForward ? block('本机 → 远程（ssh 本地转发，推荐）', c.localForward) : null,
        c.localForwardAuto ? block('autossh 保活版本', c.localForwardAuto) : null,
        c.reverseForward ? block('远程 → 本机（反向隧道，NAT 友好）', c.reverseForward) : null,
        c.trustedFlag ? block('反向代理直达（需自行加鉴权）', c.trustedFlag) : null,
        copied ? React.createElement('div', { style: { fontSize: '12px', opacity: 0.7 } }, '已复制 ✓') : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'dsh-remote', order: 40, label: () => '远程访问' },
          () => React.createElement(RemotePage, null),
        ),
      )
    }

    exports.name = name
    exports.apply = apply
    return module.exports
  },
})
