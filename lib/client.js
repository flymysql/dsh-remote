// dsh-remote — client half.
// Settings → 远程工作区: enter remote host/login (password or key path), connect,
// browse the remote filesystem, and pick a directory as the active remote workspace.
// All data flows through same-origin JSON routes on the harness `webServer`
// (/dsh-remote/status, /connect, /ls, /workspace). The host half owns the SSH pool,
// so no credentials live in the browser beyond what the form posts to loopback.
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

    function RemoteWorkspacePage() {
      const [status, setStatus] = React.useState(null)
      const [form, setForm] = React.useState({ host: '', port: '22', username: '', password: '', privateKeyPath: '' })
      const [busy, setBusy] = React.useState(false)
      const [browse, setBrowse] = React.useState({ path: '', out: '' })
      const [error, setError] = React.useState('')
      const [okMsg, setOkMsg] = React.useState('')

      const loadStatus = () => {
        api('GET', '/dsh-remote/status')
          .then(setStatus)
          .catch((err) => setError(String((err && err.message) || err)))
      }
      React.useEffect(() => {
        loadStatus()
      }, [])

      const setField = (k) => (ev) => setForm({ ...form, [k]: ev.target.value })

      const connect = () => {
        setBusy(true)
        setError('')
        setOkMsg('')
        api('POST', '/dsh-remote/connect', {
          host: form.host.trim(),
          port: Number(form.port) || 22,
          username: form.username.trim() || 'root',
          password: form.password || undefined,
          privateKeyPath: form.privateKeyPath.trim() || undefined,
        })
          .then((res) => {
            setStatus(res)
            setOkMsg(res.ok ? '已连接 ✓ 可浏览远程目录。' : '')
            if (res && res.workspace) setBrowse({ path: res.workspace, out: '' })
          })
          .catch((err) => setError(String((err && err.message) || err)))
          .finally(() => setBusy(false))
      }

      const doBrowse = (p) => {
        const target = p !== undefined ? p : browse.path.trim()
        setBusy(true)
        setError('')
        api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(target || '/'))
          .then((res) => setBrowse({ path: target, out: res.text }))
          .catch((err) => setError(String((err && err.message) || err)))
          .finally(() => setBusy(false))
      }

      const setWorkspace = () => {
        const p = browse.path.trim()
        if (!p) return
        setBusy(true)
        setError('')
        setOkMsg('')
        api('POST', '/dsh-remote/workspace', { path: p })
          .then((res) => {
            setStatus(res)
            setOkMsg('远程工作区已设为 ' + p)
          })
          .catch((err) => setError(String((err && err.message) || err)))
          .finally(() => setBusy(false))
      }

      const row = (t, v, action, key) =>
        React.createElement(
          'div',
          { key },
          React.createElement('label', { style: { fontSize: '12px', opacity: 0.75 } }, t + ': '),
          v,
          action || null,
        )

      return React.createElement(
        'div',
        { style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: 720 } },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 15 } }, '远程工作区（dsh-remote）'),
        React.createElement('div', { style: { fontSize: '12px', opacity: 0.8 } },
          '输入远程主机与登录方式，连接后在远程文件系统上浏览并选择工作区目录；agent 会用 remote_list_dir / remote_read_file / remote_exec 在所选远程工作区内操作。'),
        status
          ? React.createElement('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '13px' } },
              React.createElement('span', null, '远程: ', React.createElement('code', null, (status.username || '?') + '@' + (status.host || '?'))),
              React.createElement('span', null, '已连接: ', React.createElement('code', null, status.connected ? '是' : '否')),
              React.createElement('span', null, '远程工作区: ', React.createElement('code', null, status.workspace || '（未设置）')),
            )
          : null,
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
          row('主机', React.createElement('input', { value: form.host, onChange: setField('host'), placeholder: 'IP 或 hostname', style: { flex: 1 } }), null, 'f1'),
          row('端口', React.createElement('input', { value: form.port, onChange: setField('port'), placeholder: '22', style: { width: 60 } }), null, 'f2'),
          row('用户', React.createElement('input', { value: form.username, onChange: setField('username'), placeholder: 'root', style: { flex: 1 } }), null, 'f3'),
          row('私钥路径', React.createElement('input', { value: form.privateKeyPath, onChange: setField('privateKeyPath'), placeholder: '如 C:/Users/me/.ssh/id_rsa（留空用默认 key）', style: { flex: 1 } }), null, 'f4'),
          row('密码', React.createElement('input', { type: 'password', value: form.password, onChange: setField('password'), placeholder: '密码（SSH 无 key 时用；不进日志）', style: { flex: 1 } }), null, 'f5'),
        ),
        React.createElement('button', { onClick: connect, disabled: busy }, busy ? '连接中…' : '连接远程'),
        React.createElement('div', { style: { display: 'flex', gap: '8px' } },
          React.createElement('input', { value: browse.path, onChange: (ev) => setBrowse({ ...browse, path: ev.target.value }), placeholder: '浏览/作为工作区的路径，如 /home/dev/project', style: { flex: 1 } }),
          React.createElement('button', { onClick: () => doBrowse(), disabled: busy }, '列目录'),
          React.createElement('button', { onClick: setWorkspace, disabled: busy || !browse.path.trim() }, '设为远程工作区'),
        ),
        error ? React.createElement('div', { style: { color: '#e06c75', whiteSpace: 'pre-wrap', fontSize: 13 } }, error) : null,
        okMsg ? React.createElement('div', { style: { color: '#4caf7d', fontSize: 13 } }, okMsg) : null,
        browse.out
          ? React.createElement('pre', { style: { fontSize: 12, background: 'rgba(128,128,128,0.08)', padding: 10, borderRadius: 6, maxHeight: 320, overflow: 'auto' } }, browse.out)
          : null,
      )
    }

    // ── Remote directory picker: fills ui-workspace's directory-flow holes ──
    // Adapter that lets the native "Add workspace" flow pick a REMOTE directory.
    // It browses via /dsh-remote/ls (host SFTP) and, on confirm, asks the host to
    // create a real LOCAL mirror (/dsh-remote/mirror) so the DSH workspaceRegistry
    // (which requires fs.realpath on a local dir) can adopt it with onPicked(mirror).
    function RemoteDirectoryFlow(props) {
      const { open, busy, onPicked, onCancel } = props
      const [path, setPath] = React.useState('')
      const [entries, setEntries] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      React.useEffect(() => {
        if (!open) return
        setEntries(null)
        setErr('')
        setLoading(true)
        api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(''))
          .then((res) => {
            setPath(res && res.path ? res.path : '')
            setEntries(res && res.text ? res.text : '(empty)')
          })
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setLoading(false))
      }, [open])

      const browse = (p) => {
        const target = p !== undefined ? p : path
        setLoading(true)
        setErr('')
        api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(target || ''))
          .then((res) => {
            setPath(target)
            setEntries(res.text)
          })
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setLoading(false))
      }

      const goUp = () => {
        const idx = String(path).replace(/\/+$/, '').lastIndexOf('/')
        browse(idx <= 0 ? '/' : String(path).slice(0, idx))
      }

      const pick = () => {
        if (busy) return
        setErr('')
        api('POST', '/dsh-remote/mirror', { path })
          .then((res) => {
            if (res && res.localMirror) onPicked(res.localMirror)
            else if (res && res.error) setErr(res.error)
          })
          .catch((e) => setErr(String((e && e.message) || e)))
      }

      if (!open) return null
      return React.createElement(
        'div',
        { style: { padding: 16, minWidth: 420, maxWidth: 640 } },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '远程工作区目录'),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          React.createElement('input', {
            value: path,
            onChange: (e) => setPath(e.target.value),
            placeholder: '远程路径，如 /home/dev/project',
            style: { flex: 1 },
          }),
          React.createElement('button', { onClick: () => browse(), disabled: loading }, '列目录'),
          React.createElement('button', { onClick: goUp, disabled: loading }, '上一级'),
        ),
        err ? React.createElement('div', { style: { color: '#e06c75', marginBottom: 6, fontSize: 12 } }, err) : null,
        React.createElement(
          'pre',
          { style: { fontSize: 12, background: 'rgba(128,128,128,0.08)', padding: 8, borderRadius: 6, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' } },
          loading ? '加载中…' : entries || '（未连接远程，先连接或用 rw_connect）',
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' } },
          React.createElement('button', { onClick: onCancel, style: { background: 'transparent' } }, '取消'),
          React.createElement('button', { onClick: pick, disabled: busy || !path.trim() }, busy ? '本地镜像中…' : '设为远程工作区'),
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'dsh-remote', order: 40, label: () => '远程工作区' },
          () => React.createElement(RemoteWorkspacePage, null),
        ),
      )
      // fill ui-workspace's two directory-flow holes with the remote picker
      slots.inject(
        'conversation.hero.workspace.directoryFlow',
        () =>
          slots.inject('sidebar.workspaces.directoryFlow', function* () {
            yield slots.register({ name: 'conversation.hero.workspace.directoryFlow', id: 'dsh-remote', priority: -100 }, RemoteDirectoryFlow)
            yield slots.register({ name: 'sidebar.workspaces.directoryFlow', id: 'dsh-remote', priority: -100 }, RemoteDirectoryFlow)
          }),
      )
    }

    exports.name = name
    exports.apply = apply
    return module.exports
  },
})