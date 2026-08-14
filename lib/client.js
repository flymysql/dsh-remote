// dsh-remote — client half.
// Settings → 远程工作区 + a unified workspace directory picker that fills
// ui-workspace's two directory-flow holes (sidebar + conversation hero).
//
// The picker has two tabs, styled to match the harness:
//   • 本机 — drives the SAME local Host backend as the official picker
//     (ctx.workspaces.listDirectory), so local dirs still work.
//   • 远程 — browses the remote over /dsh-remote/ls (SFTP); on confirm it asks
//     the host to build a real LOCAL mirror (/dsh-remote/mirror) then
//     onPicked(localMirror) so the DSH workspaceRegistry adopts the local dir.
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

    async function api(method, path, body) {
      const opts = { method, headers: {} }
      if (body) {
        opts.headers['Content-Type'] = 'application/json'
        opts.body = JSON.stringify(body)
      }
      const res = await fetch(path, opts)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data && (data.error || data.message)) || 'HTTP ' + res.status)
      return data
    }

    const T = { bg: 'rgba(128,128,128,0.07)', border: 'rgba(128,128,128,0.35)', danger: '#e06c75', ok: '#4caf7d', radius: 8 }

    const inputS = { flex: 1, padding: '6px 10px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg }
    const buttonS = { padding: '6px 12px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, cursor: 'pointer' }

    // ── Settings → 远程工作区 ────────────────────────────────────────────────
    function RemoteWorkspacePage() {
      const [status, setStatus] = React.useState(null)
      const [form, setForm] = React.useState({ host: '', port: '22', username: '', password: '', privateKeyPath: '' })
      const [busy, setBusy] = React.useState(false)
      const [browse, setBrowse] = React.useState({ path: '', out: '' })
      const [error, setError] = React.useState('')
      const [okMsg, setOkMsg] = React.useState('')

      const loadStatus = () => api('GET', '/dsh-remote/status').then(setStatus).catch((e) => setError(String((e && e.message) || e)))
      React.useEffect(() => { loadStatus() }, [])

      const setField = (k) => (ev) => setForm({ ...form, [k]: ev.target.value })

      const connect = () => {
        setBusy(true); setError(''); setOkMsg('')
        api('POST', '/dsh-remote/connect', {
          host: form.host.trim(), port: Number(form.port) || 22, username: form.username.trim() || 'root',
          password: form.password || undefined, privateKeyPath: form.privateKeyPath.trim() || undefined,
        })
          .then((res) => { setStatus(res); if (res && res.workspace) setBrowse({ path: res.workspace, out: '' }); setOkMsg(res.ok ? '已连接 ✓ 可浏览远程目录。' : '') })
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setBusy(false))
      }

      const doBrowse = (p) => {
        const target = p !== undefined ? p : browse.path.trim()
        setBusy(true); setError('')
        api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(target || ''))
          .then((res) => setBrowse({ path: target, out: res.text }))
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setBusy(false))
      }

      const setWorkspace = () => {
        const p = browse.path.trim(); if (!p) return
        setBusy(true); setError(''); setOkMsg('')
        api('POST', '/dsh-remote/workspace', { path: p })
          .then((res) => { setStatus(res); setOkMsg('远程工作区已设为 ' + p) })
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setBusy(false))
      }

      const row = (t, v, k) => React.createElement(
        'div', { key: k },
        React.createElement('label', { style: { fontSize: 12, opacity: 0.75 } }, t + ': '), v,
      )

      return React.createElement(
        'div',
        { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 } },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 15 } }, '远程工作区（dsh-remote）'),
        React.createElement('div', { style: { fontSize: 12, opacity: 0.8 } },
          '连接远程主机后即可用 rw_* 工具操作；选中的远程目录会镜像成一个本地工作区（可与本地工作区并存）。'),
        status
          ? React.createElement('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 } },
              React.createElement('span', null, '远程: ', React.createElement('code', null, (status.username || '?') + '@' + (status.host || '?'))),
              React.createElement('span', null, '连接: ', React.createElement('code', null, status.connected ? '是' : '否')),
              React.createElement('span', null, '工作区: ', React.createElement('code', null, status.workspace || '（未设置）')),
              status.localMirror ? React.createElement('span', null, '本地镜像: ', React.createElement('code', null, status.localMirror)) : null,
            )
          : null,
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
          row('主机', React.createElement('input', { value: form.host, onChange: setField('host'), placeholder: 'IP 或 hostname', style: inputS }), 'h'),
          row('端口', React.createElement('input', { value: form.port, onChange: setField('port'), placeholder: '22', style: { ...inputS, width: 70 } }), 'p'),
          row('用户', React.createElement('input', { value: form.username, onChange: setField('username'), placeholder: 'root', style: inputS }), 'u'),
          row('私钥路径', React.createElement('input', { value: form.privateKeyPath, onChange: setField('privateKeyPath'), placeholder: '如 C:/Users/me/.ssh/id_rsa', style: inputS }), 'k'),
          row('密码', React.createElement('input', { type: 'password', value: form.password, onChange: setField('password'), placeholder: 'SSH 无 key 时用', style: inputS }), 'w'),
        ),
        React.createElement('button', { onClick: connect, disabled: busy, style: { ...buttonS, alignSelf: 'flex-start' } }, busy ? '连接中…' : '连接远程'),
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          React.createElement('input', { value: browse.path, onChange: (e) => setBrowse({ ...browse, path: e.target.value }), placeholder: '远程路径，如 /home/dev/project', style: inputS }),
          React.createElement('button', { onClick: () => doBrowse(), disabled: busy, style: buttonS }, '列目录'),
          React.createElement('button', { onClick: setWorkspace, disabled: busy || !browse.path.trim(), style: buttonS }, '设为远程工作区'),
        ),
        error ? React.createElement('div', { style: { color: T.danger, whiteSpace: 'pre-wrap', fontSize: 13 } }, error) : null,
        okMsg ? React.createElement('div', { style: { color: T.ok, fontSize: 13 } }, okMsg) : null,
        browse.out
          ? React.createElement('pre', { style: { fontSize: 12, background: T.bg, padding: 10, borderRadius: T.radius, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' } }, browse.out)
          : null,
      )
    }

    // ── Unified workspace directory picker (fills the directory-flow holes) ──
    let LOCAL_WORKSPACES = null // ctx.workspaces, bound in apply()

    function parseLs(text) {
      const out = []
      for (const ln of String(text || '').split('\n')) {
        const m = ln.match(/^(d[-r][rwx-]{8})\s+[^ ]+\s+[^ ]+\s+[^ ]+\s+[^ ]+\s+\d{4,}-\d{2}-\d{2}([T ]+\S+)?\s+(.+)$/)
        if (!m) continue
        out.push((m[1].charAt(0) === 'd' ? '📁' : '📄') + m[3])
      }
      if (!out.length && String(text || '').trim()) out.push(...String(text).trim().split('\n').slice(1).map((l) => '📄 ' + l.trim()).filter(Boolean))
      return out
    }

    function DirPicker(props) {
      const { open, busy, onPicked, onCancel } = props
      const [tab, setTab] = React.useState('local')
      const [path, setPath] = React.useState('')
      const [items, setItems] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [loading, setLoading] = React.useState(false)

      const load = (target, useLocal) => {
        const p = target !== undefined ? target : path
        setLoading(true); setErr('')
        if (useLocal) {
          const w = LOCAL_WORKSPACES || {}
          const list = w.listDirectory || (() => Promise.reject(new Error('本机目录服务不可用')))
          Promise.resolve(list(p || undefined)).then((lv) => {
            const names = (lv && lv.entries) || (lv && lv.children) || (lv && lv.list) || []
            setPath(p || (lv && lv.path) || '')
            setItems((Array.isArray(names) ? names : []).map((e) => (e && e.name ? e.name : String(e))))
          }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setLoading(false))
        } else {
          api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(p || '')).then((res) => {
            setPath(res && res.path ? res.path : p)
            setItems(parseLs(res && res.text))
          }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setLoading(false))
        }
      }

      React.useEffect(() => { if (open) load('', tab === 'local') }, [open])

      const switchTab = (t) => { setTab(t); setPath(''); setItems(null); setErr(''); load('', t === 'local') }
      const goUp = () => {
        const sep = tab === 'local' ? '\\' : '/'
        const idx = String(path).replace(/[\\/]+$/, '').lastIndexOf(sep)
        const parent = idx <= 0 ? (tab === 'local' ? (path.slice(0, 3) || 'C:\\') : '/') : String(path).slice(0, idx)
        load(parent, tab === 'local')
      }
      const enter = (name) => {
        const sep = tab === 'local' ? '\\' : '/'
        const np = path === '' || path.endsWith(sep) ? path + name : path + sep + name
        load(np, tab === 'local')
      }
      const pickCurrent = () => {
        if (loading || busy) return
        if (tab === 'local') { onPicked(path); return }
        api('POST', '/dsh-remote/mirror', { path })
          .then((res) => (res && res.localMirror ? onPicked(res.localMirror) : setErr((res && res.error) || '')))
          .catch((e) => setErr(String((e && e.message) || e)))
      }

      if (!open) return null
      const isDir = (label) => String(label || '').charAt(0) === '📁'
      const cell = { ...buttonS, textAlign: 'center' }
      const active = { ...cell, fontWeight: 700 }
      return React.createElement(
        'div', { style: { padding: 14, minWidth: 440, maxWidth: 680 } },
        React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          React.createElement('button', { onClick: () => switchTab('local'), style: tab === 'local' ? active : cell }, '本机'),
          React.createElement('button', { onClick: () => switchTab('remote'), style: tab === 'remote' ? active : cell }, '远程'),
        ),
        React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          React.createElement('input', { value: path, onChange: (e) => setPath(e.target.value), placeholder: tab === 'local' ? '本机目录路径' : '远程路径，如 /home/dev/project', style: inputS }),
          React.createElement('button', { onClick: () => load(path, tab === 'local'), style: buttonS }, '载入'),
          React.createElement('button', { onClick: goUp, style: buttonS }, '上一级'),
        ),
        err ? React.createElement('div', { style: { color: T.danger, marginBottom: 6, fontSize: 12 } }, err) : null,
        React.createElement(
          'div', { style: { border: '1px solid ' + T.border, borderRadius: T.radius, padding: 8, maxHeight: 280, overflow: 'auto', fontSize: 13 } },
          loading
            ? '加载中…'
            : (items && items.length
                ? items.slice(0, 400).map((n, i) => React.createElement('div', { key: i, onClick: () => (isDir(n) ? enter(n.slice(2)) : null), style: { padding: '3px 6px', borderRadius: 4, cursor: isDir(n) ? 'pointer' : 'default', color: isDir(n) ? T.ok : 'inherit' } }, isDir(n) ? n : '   ' + n))
                : React.createElement('div', { style: { opacity: 0.6 } }, items === null ? '（输入路径后点「载入」）' : '（空）')),
        ),
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' } },
          React.createElement('button', { onClick: onCancel, style: { background: 'transparent' } }, '取消'),
          React.createElement('button', { onClick: pickCurrent, disabled: loading || busy || !path.trim(), style: buttonS }, busy ? '处理中…' : tab === 'local' ? '选用此目录' : '设为远程工作区'),
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // workspaces is a client service: read it lazily via ctx.get (the direct
      // property form needs an inject declaration, which a bare plugin can't rely
      // on; the official picker injects the service, we resolve it here instead).
      LOCAL_WORKSPACES = (ctx && ctx.get && ctx.get('workspaces')) || null
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'dsh-remote', priority: 40, label: () => '远程工作区' }, () => React.createElement(RemoteWorkspacePage, null)),
      )
      slots.inject(
        'conversation.hero.workspace.directoryFlow',
        () =>
          slots.inject('sidebar.workspaces.directoryFlow', function* () {
            yield slots.register({ name: 'conversation.hero.workspace.directoryFlow', id: 'dsh-remote', priority: -100 }, DirPicker)
            yield slots.register({ name: 'sidebar.workspaces.directoryFlow', id: 'dsh-remote', priority: -100 }, DirPicker)
          }),
      )
    }

    exports.name = name
    exports.apply = apply
    return module.exports
  },
})