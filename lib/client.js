// dsh-remote — client half.
// Settings → 远程工作区:	a multi-machine SSH registry (add/edit/select current;
// password stored host-side and kept private). No workspace path here — the
// path is picked at workspace-add time.
//
// A unified workspace directory picker fills ui-workspace's two directory-flow
// holes (sidebar + conversation hero):
//   • 本机 tab → opens the NATIVE OS folder chooser (ctx.workspaces.pickDirectory)
//     and returns the picked local path (works with local workspaces).
//   • 远程 tab → pick a machine (dropdown), list its directories over
//     /dsh-remote/ls, choose or type a remote path → /dsh-remote/mirror builds a
//     real LOCAL mirror → onPicked(localMirror) so host adopts it as a workspace.
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
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(path, opts)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data && (data.error || data.message)) || 'HTTP ' + res.status)
      return data
    }

    const T = { bg: 'rgba(128,128,128,0.07)', border: 'rgba(128,128,128,0.35)', danger: '#e06c75', ok: '#4caf7d', radius: 8, muted: 'rgba(128,128,128,0.7)' }
    const inputS = { flex: 1, padding: '6px 10px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg }
    const buttonS = { padding: '6px 12px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, cursor: 'pointer' }
    const box = { border: '1px solid ' + T.border, borderRadius: T.radius, background: T.bg, padding: 10 }
    const boxS = box

    let WORKSPACES = null // ctx.get('workspaces'), set in apply()

    // ── Settings → 远程工作区 (machine registry) ─────────────────────────────
    function RemoteWorkspacePage() {
      const [machines, setMachines] = React.useState([])
      const [currentId, setCurrentId] = React.useState('')
      const [form, setForm] = React.useState({ name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '', id: '' })
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')

      const refresh = () => api('GET', '/dsh-remote/machines').then((r) => { setMachines(r.machines || []); setCurrentId(r.currentId || '') })
      React.useEffect(() => { refresh() }, [])

      const setF = (k) => (ev) => setForm({ ...form, [k]: ev.target.value })
      const startEdit = (m) => setForm({ name: m.name, host: m.host, port: String(m.port || 22), username: m.username || 'root', password: '', privateKeyPath: m.privateKeyPath || '', id: m.id })
      const save = (action) => {
        setBusy(true); setErr(''); setMsg('')
        if (action === 'delete') {
          api('POST', '/dsh-remote/machines', { action: 'delete', id: form.id }).then(refresh).then(() => { setForm({ name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '', id: '' }); setMsg('已删除') }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false))
          return
        }
        api('POST', '/dsh-remote/machines', {
          action: form.id ? 'update' : 'add', id: form.id || undefined, name: form.name, host: form.host, port: Number(form.port) || 22,
          username: form.username, password: form.password, privateKeyPath: form.privateKeyPath,
        }).then((r) => { refresh(); setForm({ name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '', id: '' }); setMsg(form.id ? '已保存更新' : '已添加 — 可设为当前') }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false))
      }
      const useNow = (id) => { setBusy(true); api('POST', '/dsh-remote/current', { id }).then((r) => { setCurrentId(r.currentId); setMsg('已切换为当前远程机') }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setBusy(false)) }
      const del = (id) => { if (window.confirm('确定删除这台机器？')) { api('POST', '/dsh-remote/machines', { action: 'delete', id }).then(refresh).then(() => setMsg('已删除')).catch((e) => setErr(String((e && e.message) || e))) } }

      const row = (label, ctrl, k) => React.createElement('div', { key: k, style: { display: 'flex', gap: 6, alignItems: 'center' } },
        React.createElement('label', { style: { width: 76, fontSize: 12, opacity: 0.8 } }, label), ctrl)

      return React.createElement('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 } },
        React.createElement('div', { style: { fontSize: 15, fontWeight: 600 } }, '远程工作区（dsh-remote）'),
        React.createElement('div', { style: { fontSize: 12, opacity: 0.8 } },
          '维护多台 SSH 机器。路径不在设置里配置 —— 新建/选择工作区时，「本机」走系统文件夹对话框；「远程」选一台机器在远程目录中选择。'),
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, '已配置的机器'),
          machines.length
            ? machines.map((m) => React.createElement('div', { key: m.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid ' + T.border } },
                React.createElement('div', { style: { flex: 1, fontSize: 13 } },
                  m.name + '  ',
                  React.createElement('code', { style: { fontSize: 12, opacity: 0.8 } }, m.username + '@' + m.host + ':' + m.port),
                  m.passwordSet ? ' 🔒' : '',
                  m.id === currentId ? React.createElement('span', { style: { color: T.ok, fontSize: 12 } }, ' · 当前') : null),
                React.createElement('button', { style: buttonS, onClick: () => startEdit(m) }, '编辑'),
                React.createElement('button', { style: buttonS, onClick: () => del(m.id) }, '删除'),
                React.createElement('button', { style: buttonS, onClick: () => useNow(m.id), disabled: m.id === currentId }, '设为当前')))
            : React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, '还没有机器。在下方添加。'),
          ),
        React.createElement('div', { style: boxS },
          React.createElement('div', { style: { marginBottom: 6, fontSize: 13, fontWeight: 600 } }, form.id ? '编辑机器' : '添加机器'),
          row('名称', React.createElement('input', { value: form.name, onChange: setF('name'), placeholder: '例如 编译机', style: inputS }), 'n'),
          row('主机', React.createElement('input', { value: form.host, onChange: setF('host'), placeholder: 'IP 或 hostname', style: inputS }), 'h'),
          row('端口', React.createElement('input', { value: form.port, onChange: setF('port'), placeholder: '22', style: { ...inputS, width: 70 } }), 'p'),
          row('用户', React.createElement('input', { value: form.username, onChange: setF('username'), placeholder: 'root', style: inputS }), 'u'),
          row('密码', React.createElement('input', { type: 'password', value: form.password, onChange: setF('password'), placeholder: 'SSH 无 key 时用（不回显、仅保存）', style: inputS }), 'w'),
          row('私钥路径', React.createElement('input', { value: form.privateKeyPath, onChange: setF('privateKeyPath'), placeholder: '留空用默认 key', style: inputS }), 'k'),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' } },
            msg ? React.createElement('span', { style: { color: T.ok, fontSize: 12, marginRight: 'auto' } }, msg) : null,
            form.id ? React.createElement('button', { style: buttonS, onClick: () => save('delete') }, '删除') : null,
            React.createElement('button', { style: buttonS, onClick: () => { setForm({ name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '', id: '' }); setErr('') } }, form.id ? '取消编辑' : '清空'),
            React.createElement('button', { style: { ...buttonS, fontWeight: 700 }, onClick: () => save(form.id ? 'update' : 'add'), disabled: busy || !form.host.trim() }, busy ? '保存中…' : '保存'),
          ),
        ),
        err ? React.createElement('div', { style: { color: T.danger, fontSize: 13 } }, err) : null,
      )
    }

    // ── Unified picker (fill the directory-flow holes) ───────────────────
    function parseLs(text) {
      const out = []
      for (const ln of String(text || '').split('\n')) {
        const t = ln.trim()
        if (!t || !t.length || /^total\b/i.test(t)) continue
        const parts = t.split(/\s+/).filter(Boolean)
        if (parts.length < 2) continue
        const mode = parts[0]
        const name = parts[parts.length - 1]
        if (name === '.' || name === '..') continue
        const isDirL = mode.charAt(0) === 'd'
        out.push((isDirL ? '📁' : '📄') + name)
      }
      return out
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

      React.useEffect(() => { if (open) { api('GET', '/dsh-remote/machines').then((r) => { setMachines(r.machines || []); setMachineId(r.currentId || (r.machines && r.machines[0] && r.machines[0].id) || '') }) } }, [open])

      const chooseLocal = () => {
        const w = WORKSPACES || {}
        const pick = w.pickDirectory || w.openDirectory || w.pickPath
        if (typeof pick === 'function') {
          setLoading(true); setErr('')
          Promise.resolve(pick()).then((p) => { if (p) onPicked(String(p)); }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setLoading(false))
        } else {
          setErr('本机系统选择器不可用，请在对话框中输入本机路径或使用远程tab')
        }
      }

      const switchTab = (t) => { setTab(t); setErr(''); if (t === 'remote' && machineId) loadRemote(machineId, '') }
      const useMachine = (id) => { setMachineId(id); loadRemote(id, '') }
      const loadRemote = (id, target) => {
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/current', { id }).catch(() => {})
        .then(() => api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(target || '')))
        .then((res) => { setPath(res && res.path ? res.path : target || ''); setItems(parseLs(res && res.text)) })
        .catch((e) => setErr(String((e && e.message) || e)))
        .finally(() => setLoading(false))
      }
      const enter = (n) => {
        const base = String(path).replace(/\/+$/, '')
        const next = (base ? base : '') + '/' + String(n).replace(/^📁/, '')
        loadRemote(machineId, next)
      }
      const goUp = () => {
        const base = String(path).replace(/\/+$/, '')
        const idx = base.lastIndexOf('/')
        loadRemote(machineId, idx <= 0 ? '/' : base.slice(0, idx))
      }
      const pickRemote = () => {
        if (busy || loading) return
        api('POST', '/dsh-remote/mirror', { path }).then((res) => (res && res.localMirror ? onPicked(res.localMirror) : setErr((res && res.error) || ''))).catch((e) => setErr(String((e && e.message) || e)))
      }

      if (!open) return null
      const tabBtn = (t, lbl) => React.createElement('button', { onClick: () => switchTab(t), style: { ...buttonS, fontWeight: tab === t ? 700 : 400 } }, lbl)
      return React.createElement('div', { style: { padding: 14, minWidth: 460, maxWidth: 720 } },
        React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
          tabBtn('local', '本机'),
          tabBtn('remote', '远程'),
        ),
        tab === 'local'
          ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              React.createElement('div', { style: { fontSize: 12, opacity: 0.8 } }, '系统选择器优先；不可用时直接输入本机目录。'),
              React.createElement('div', { style: { display: 'flex', gap: 6 } },
                React.createElement('input', { value: path, onChange: (e) => setPath(e.target.value), placeholder: '本机目录，如 C:\\Users\\you\\project', style: inputS }),
                React.createElement('button', { style: buttonS, onClick: () => (path.trim() ? onPicked(path) : undefined), disabled: !path.trim() }, '选用此本地路径'),
              ),
              React.createElement('button', { style: { ...buttonS, alignSelf: 'flex-start' }, onClick: chooseLocal, disabled: loading }, loading ? '打开中…' : '打开系统文件夹选择器'),
              err ? React.createElement('div', { style: { color: T.danger, fontSize: 12 } }, err) : null,
            )
          : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                React.createElement('label', { style: { fontSize: 12, opacity: 0.8 } }, '远程机器:'),
                React.createElement('select', { value: machineId, onChange: (e) => useMachine(e.target.value), style: inputS },
                  React.createElement('option', { value: '' }, '— 选择 —'),
                  machines.map((m) => React.createElement('option', { key: m.id, value: m.id }, m.name + ' (' + m.username + '@' + m.host + ')')),
                ),
              ),
              React.createElement('div', { style: { display: 'flex', gap: 6 } },
                React.createElement('input', { value: path, onChange: (e) => setPath(e.target.value), placeholder: '远程目录，如 /home/dev/project', style: inputS }),
                React.createElement('button', { style: buttonS, onClick: () => loadRemote(machineId, path), disabled: !machineId || loading }, '载入'),
                React.createElement('button', { style: buttonS, onClick: goUp, disabled: !machineId || loading }, '上一级'),
              ),
              err ? React.createElement('div', { style: { color: T.danger, fontSize: 12 } }, err) : null,
              React.createElement('div', { style: boxS, ...{ minHeight: 150 } },
                loading ? '加载中…'
                  : (items && items.length ? items.slice(0, 400).map((n, i) => { const isDir = n.indexOf('📁') === 0; return React.createElement('div', { key: i, onClick: () => (isDir ? enter(n.slice(2)) : null), style: { padding: '3px 6px', borderRadius: 4, cursor: isDir ? 'pointer' : 'default', color: isDir ? T.ok : 'inherit' } }, isDir ? n : '  ' + n) }) : React.createElement('div', { style: { opacity: 0.6 } }, '先选机器，再点「载入」或输入路径')),
              ),
              React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                React.createElement('button', { style: { background: 'transparent' }, onClick: onCancel }, '取消'),
                React.createElement('button', { style: { ...buttonS, fontWeight: 600 }, onClick: pickRemote, disabled: busy || loading || !machineId || !path.trim() }, busy ? '镜像中…' : '设为远程工作区'),
              ),
            ),
        (tab === 'local') ? React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } }, React.createElement('button', { style: { background: 'transparent' }, onClick: onCancel }, '取消')) : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      WORKSPACES = (ctx && ((ctx.get && ctx.get('workspaces')) || ctx.workspaces)) || null
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'dsh-remote', priority: 40, label: () => '远程工作区' }, () => React.createElement(RemoteWorkspacePage, null)),
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
    }

    exports.name = name
    exports.apply = apply
    return module.exports
  },
})