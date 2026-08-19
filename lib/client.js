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
    const ghostBtnS = { padding: '6px 12px', borderRadius: T.radius, border: 'none', background: 'transparent', color: T.label, cursor: 'pointer' }
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
      const [tst, setTst] = React.useState('') // idle | testing | ok | failing

      const testConn = () => {
        if (!form.host.trim() || tst === 'testing') return
        setTst('testing'); setErr(''); setMsg('')
        api('POST', '/dsh-remote/test-connect', {
          host: form.host, port: Number(form.port) || 22, username: form.username || 'root',
          password: form.password, privateKeyPath: form.privateKeyPath,
        })
          .then((r) => {
            if (r && r.ok) { setTst('ok'); setMsg(r.latencyMs != null ? `连接成功（${r.user}@${r.host}，${r.latencyMs}ms）` : '连接成功') }
            else { setTst('failing'); setErr((r && r.error) || '连接失败') }
          })
          .catch((e) => { setTst('failing'); setErr(String((e && e.message) || e)) })
      }

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
            React.createElement('button', { style: buttonS, onClick: () => { setForm({ name: '', host: '', port: '22', username: 'root', password: '', privateKeyPath: '', id: '' }); setErr(''); setTst('idle') } }, form.id ? '取消编辑' : '清空'),
            React.createElement('button', { style: { ...buttonS, fontFamily: 'monospace', whiteSpace: 'nowrap' }, onClick: testConn, disabled: busy || !form.host.trim() || tst === 'testing' },
              tst === 'testing' ? '连接中…' : tst === 'ok' ? '✓ 连接成功' : '测试连接'),
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
        // ls -l row: mode links owner group size month day [hh:mm|year] name...
        // NAME starts at column 8 (everything before it is the fixed metadata).
        if (parts.length < 8) continue
        const mode = parts[0]
        const name = parts.slice(8).join(' ')
        if (!name || name === '.' || name === '..') continue
        const isDir = mode.charAt(0) === 'd'
        out.push({ name, dir: isDir })
      }
      return out
    }

    // Clickable breadcrumb of the current remote path; clicking a segment jumps
    // to that ancestor level (finite-width, one line, ellipsized at the front).
    function breadcrumb(active, cur, jumpTo) {
      const norm = String(cur || '').replace(/\/+$/, '')
      const segs = norm === '' || norm === '/' ? [] : norm.split('/')
      const crumbs = []
      crumbs.push(React.createElement('span', { key: 'root', style: { cursor: active ? 'pointer' : 'default', color: active ? T.ok : T.muted }, onClick: active ? () => jumpTo('/') : undefined }, '/'))
      let acc = ''
      for (const s of segs) {
        if (!s) continue
        acc += '/' + s
        crumbs.push(React.createElement('span', { key: s + '|' + acc, style: { color: T.muted } }, '/'))
        crumbs.push(React.createElement('span', {
          key: acc,
          style: { cursor: active ? 'pointer' : 'default', color: active ? T.label : T.muted, fontWeight: acc === norm ? 700 : 400, whiteSpace: 'nowrap' },
          onClick: active ? () => jumpTo(acc) : undefined,
        }, s))
      }
      if (!crumbs.length) crumbs.push(React.createElement('span', { key: 'empty', style: { color: T.muted } }, '/'))
      return React.createElement('span', { key: 'crumb' }, crumbs)
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
      // 级联下钻状态：每一格是 { path, dirs } —— dirs 是该路径下的目录列表。
      const [levels, setLevels] = React.useState(null)
      const [popOpen, setPopOpen] = React.useState(false)
      const [suggest, setSuggest] = React.useState([])
      const [suggestOpen, setSuggestOpen] = React.useState(false)
      const suggestTimer = React.useRef(null)
      const suggestRef = React.useRef(null)
      // 点击候选路径下拉外部的空白处时，收起自动补全列表
      React.useEffect(() => {
        if (!suggestOpen) return
        const onDown = (ev) => { if (suggestRef.current && !suggestRef.current.contains(ev.target)) setSuggestOpen(false) }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [suggestOpen])
      // 机器下拉：点外部任意处关闭，避免候选层常驻遮挡下方按钮
      const [mOpen, setMOpen] = React.useState(false)
      const ddRef = React.useRef(null)
      React.useEffect(() => {
        if (!mOpen) return
        const onDown = (ev) => { if (ddRef.current && !ddRef.current.contains(ev.target)) setMOpen(false) }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [mOpen])

      const loadLevels = (id, p, toIndex) => {
        if (!id) return
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/current', { id }).catch(() => {})
        .then(() => api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(p || '')))
        .then((res) => {
          const real = res && res.path ? res.path : (p || '')
          // server returns [{ type:'dir'|'file', name }]; entering a dir is
          // decided by type dir (server already follows symlinks to dirs).
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir' }))
            : parseLs(res && res.text)
          const node = { path: real, dirs: list.filter((it) => it.dir), all: list }
          setLevels((prev) => {
            const base = prev && prev.length ? prev.slice() : []
            // toIndex >= 0 → put this node at that position, truncating below it.
            let idx = typeof toIndex === 'number' && toIndex >= 0 ? toIndex : base.length
            if (idx >= base.length) return base.concat([node])
            base[idx] = node
            return base.slice(0, idx + 1)
          })
        })
        .catch((e) => setErr(String((e && e.message) || e)))
        .finally(() => setLoading(false))
      }

      React.useEffect(() => { if (open) { api('GET', '/dsh-remote/machines').then((r) => { setMachines(r.machines || []); setMachineId(r.currentId || (r.machines && r.machines[0] && r.machines[0].id) || '') }) } }, [open])

      const chooseLocal = () => {
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/local-pick')
          .then((r) => {
            if (r && r.path) onPicked(String(r.path))
            else if (r && r.cancelled) setErr('已取消选择')
            else setErr((r && r.error) || '无法打开系统文件夹选择器，可直接在输入框填本地路径')
          })
          .catch((e) => setErr(String((e && e.message) || e) + ' — 可直接在输入框填本地路径'))
          .finally(() => setLoading(false))
      }

      const switchTab = (t) => {
        setTab(t); setErr('')
        if (t === 'remote') {
          if (machineId) loadLevels(machineId, '', 0)
          // Prime the field with the machine's root so the user immediately gets
          // a '/'-level completion list without typing anything.
          if (!path.trim()) { setPath('/'); loadSuggestions('/') }
        }
      }

      // enterDir(name): drive into the named subdir of the current deepest level,
// appending that directory as the new deepest level (path is pieced together).
      const enterDir = (name) => {
        if (busy || loading) return
        const last = levels && levels.length ? levels[levels.length - 1] : null
        const base = last && last.path ? last.path : ''
        const next = base === '/' ? '/' + name : (base ? base : '') + '/' + name
        loadLevels(machineId, next, (levels ? levels.length : 0))
      }

      // Autocomplete: given a partial remote path, list children of its parent dir
      // that start with the last segment (powered by the structured ls endpoint).
      const loadSuggestions = (raw, mid) => {
        const id = mid || machineId
        if (!id || !raw) { setSuggest([]); setSuggestOpen(false); return }
        const t = String(raw || '').trim()
        if (!t) { setSuggest([]); setSuggestOpen(false); return }
        const slash = t.lastIndexOf('/')
        const parent = slash <= 0 ? '/' : t.slice(0, slash)
        const lastSeg = slash < 0 ? t : t.slice(slash + 1)
        api('POST', '/dsh-remote/current', { id }).catch(() => {})
        .then(() => api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(parent || '/')))
        .then((res) => {
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir' }))
            : parseLs(res && res.text)
          const base = parent === '/' ? '/' : parent
          const matches = list.filter((it) => it.name.toLowerCase().startsWith(String(lastSeg).toLowerCase()))
            .slice(0, 40).map((it) => (base === '/' ? '/' + it.name : base + '/' + it.name))
          setSuggest(matches)
          setSuggestOpen(!!matches.length)
        }).catch(() => { setSuggest([]); setSuggestOpen(false) })
      }

      const onPathChange = (raw) => {
        setPath(raw); setErr('')
        if (suggestTimer.current) clearTimeout(suggestTimer.current)
        suggestTimer.current = setTimeout(() => loadSuggestions(raw), 220)
      }

      // After a directory is chosen, immediately reveal the next level: list the
      // chosen directory's children as fresh completions (no keystroke needed).
      const continueSuggest = (dir) => {
        if (!machineId || !dir) { setSuggest([]); setSuggestOpen(false); return }
        setSuggestOpen(false)
        api('POST', '/dsh-remote/current', { id: machineId }).catch(() => {})
        .then(() => api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(String(dir).replace(/\/+$/, '') || '/')))
        .then((res) => {
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir' }))
            : parseLs(res && res.text)
          const base = String(dir).replace(/\/+$/, '') === '' ? '/' : String(dir).replace(/\/+$/, '')
          const kids = list.filter((it) => it.dir).slice(0, 40).map((it) => (base === '/' ? '/' + it.name : base + '/' + it.name))
          setSuggest(kids)
          setSuggestOpen(!!kids.length)
        }).catch(() => { setSuggest([]); setSuggestOpen(false) })
      }

      // Choose a suggestion: fill the field and immediately open its next level.
      const selectSuggestion = (s) => {
        setPath(s); setErr(''); setSuggestOpen(false)
        continueSuggest(s)
      }

      // Commit an explicit remote path as the workspace (race from the input).
      const commitPath = (p) => {
        const target = String(p || '').trim()
        if (!target || !machineId || busy) return
        setPopOpen(false); setSuggestOpen(false)
        api('POST', '/dsh-remote/mirror', { path: target }).then((res) => (res && res.localMirror ? onPicked(res.localMirror) : setErr((res && res.error) || ''))).catch((e) => setErr(String((e && e.message) || e)))
      }

      // Confirm the highlighted directory from the browser popup by filling the
      // path input (not committing), so the user can review/edit before commit.
      const acceptBrowserPick = (p) => {
        setPath(String(p || ''))
        setSuggestOpen(false)
        setPopOpen(false)
      }

      function renderDirPopup() {
        if (!levels || !levels.length) {
          return React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, (loading ? '加载中…' : '正在读取根目录…'))
        }
        const last = levels[levels.length - 1]
        const entries = last.all || []
        // Floating overlay: pinned to viewport, covers the dialog background so
        // it never stretches the surrounding layout. The picker panel is a fixed
        // (height-capped) box whose directory list scrolls internally.
        return React.createElement('div', {
          style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 },
          onClick: () => setPopOpen(false),
        },
          React.createElement('div', { style: { background: v('--dsw-alias-bg-overlay', '#1e1e1e'), border: '1px solid ' + T.borderStrong, borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,0.5)', width: 'min(560px, 94vw)', minWidth: 320, display: 'flex', flexDirection: 'column', maxHeight: 'min(440px, 82vh)', overflow: 'hidden' }, onClick: (e) => e.stopPropagation() },
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid ' + T.border } },
              React.createElement('button', { style: { ...buttonS, padding: '3px 10px' }, onClick: () => setLevels((p) => p && p.length > 1 ? p.slice(0, p.length - 1) : p), disabled: levels.length <= 1 || loading }, '回上一级 ▴'),
              React.createElement('div', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, breadcrumb(machineId, last.path, (p) => setLevels((prev) => { const cut = (prev || []).findIndex((lv) => lv.path === p); return cut >= 0 ? prev.slice(0, cut + 1) : prev }))),
              React.createElement('button', { style: { ...buttonS, padding: '3px 10px' }, onClick: () => setPopOpen(false) }, '关闭 ✕'),
            ),
            React.createElement('div', { style: { overflowY: 'auto', overflowX: 'hidden' } },
              loading ? React.createElement('div', { style: { opacity: 0.7, padding: 12 } }, '加载中…')
                : (entries.length ? entries.slice(0, 400).map((it, i) => React.createElement('div', {
                    key: i, title: (it.dir ? '进入 ' : '文件: ') + it.name,
                    onClick: it.dir ? () => enterDir(it.name) : undefined,
                    style: { padding: '7px 12px', cursor: it.dir ? 'pointer' : 'default', color: it.dir ? T.ok : T.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid ' + T.border },
                  },
                    React.createElement('span', null, it.dir ? '📁' : '📄'),
                    React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.name),
                  )) : React.createElement('div', { style: { opacity: 0.6, padding: 12 } }, '（空目录）')),
            ),
            React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid ' + T.border } },
              React.createElement('span', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, '所选: ' + last.path),
              React.createElement('button', { style: { ...buttonS, fontWeight: 600 }, onClick: () => acceptBrowserPick(last.path) }, '选用此路径'),
            ),
          ),
        )
      }

      if (!open) return null
      const tabBtn = (t, lbl) => React.createElement('button', { onClick: () => switchTab(t), style: { ...buttonS, fontWeight: tab === t ? 700 : 400 } }, lbl)
      // The picker is a full-viewport centered modal (backdrop + panel), so it
      // renders identically in the narrow sidebar and in the conversation and
      // is never squeezed into a cramped in-place column.
      return React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }, onClick: () => { if (!busy) onCancel() } },
        React.createElement('div', { style: { background: v('--dsw-alias-bg-layer-1', '#18181b'), border: '1px solid ' + T.borderStrong, borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,0.5)', width: 'min(600px, 94vw)', padding: 16, boxSizing: 'border-box' }, onClick: (e) => e.stopPropagation() },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
          React.createElement('div', null, '选择工作目录'),
          React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: () => { if (!busy) onCancel() }, disabled: busy }, '关闭 ✕'),
        ),
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
                React.createElement('label', { style: { fontSize: 12, opacity: 0.8, whiteSpace: 'nowrap' } }, '远程机器:'),
                React.createElement('div', { ref: ddRef, style: { position: 'relative', display: 'inline-block' } },
                  React.createElement('button', { style: { ...inputS, textAlign: 'left', cursor: 'pointer', minWidth: 200, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, onClick: () => setMOpen((v) => !v) },
                    (machines.find((m) => m.id === machineId) || {}).name || (machineId ? '…' : '— 选择机器 —'),
                  ),
                  mOpen
                    ? React.createElement('div', { style: { position: 'absolute', top: '100%', left: 0, zIndex: 1000, marginTop: 2, minWidth: 300, maxHeight: 260, overflow: 'auto', background: '#1f1f23', border: '1px solid ' + T.border, borderRadius: T.radius, padding: 4 } },
                        machines.length
                          ? machines.map((m) => React.createElement('div', { key: m.id, onClick: () => { setMachineId(m.id); setLevels(null); if (m.id) { loadLevels(m.id, '', 0); if (!path.trim()) { setPath('/'); loadSuggestions('/', m.id) } } setMOpen(false) }, style: { padding: '6px 8px', borderRadius: 4, cursor: 'pointer', color: m.id === machineId ? T.ok : 'inherit' } }, m.name + '  (' + m.username + '@' + m.host + ':' + m.port + ')'))
                          : React.createElement('div', { style: { padding: 6, opacity: 0.6 } }, '还没有机器，请先在设置里添加'),
                      )
                    : null,
                ),
              ),
              // 路径输入框（带自动补全）+ 打开浏览弹层按钮
              React.createElement('div', { ref: suggestRef, style: { position: 'relative', display: 'flex', gap: 6 } },
                React.createElement('input', { value: path, onChange: (e) => onPathChange(e.target.value), onFocus: () => loadSuggestions(path), placeholder: (machineId ? '输入远程路径（自动补全）' : '先选远程机器'), disabled: !machineId, style: { ...inputS, flex: 1, minWidth: 120 } }),
                React.createElement('button', { style: { ...buttonS, whiteSpace: 'nowrap' }, onClick: () => { if (machineId) setPopOpen(true) }, disabled: !machineId }, '浏览…'),
                // 自动补全下拉
                (suggestOpen && suggest.length)
                  ? React.createElement('div', { style: { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: v('--dsw-alias-bg-overlay', '#1e1e1e'), border: '1px solid ' + T.borderStrong, borderRadius: 8, marginTop: 4, maxHeight: 200, overflowY: 'auto', boxShadow: '0 6px 24px rgba(0,0,0,0.25)' } },
                      suggest.map((s, i) => React.createElement('div', { key: s + i, onMouseDown: () => selectSuggestion(s), style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s)),
                    )
                  : null,
              ),
              err ? React.createElement('div', { style: { color: T.danger, fontSize: 12 } }, err) : null,
              React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' } },
                React.createElement('span', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, path ? '所选: ' + path : ''),
                React.createElement('button', { style: { ...buttonS, fontWeight: 600 }, onClick: () => commitPath(path), disabled: busy || !machineId || !path.trim() }, busy ? '镜像中…' : '设为远程工作区'),
              ),
              // 悬浮浏览弹层：选中的路径回填到输入框（不直接提交）
              popOpen ? renderDirPopup() : null,
            ),
        (tab === 'local') ? React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } }, React.createElement('button', { style: { background: 'transparent' }, onClick: onCancel }, '取消')) : null,
        ),
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