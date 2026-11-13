// Settings manage hosts; the workspace creation flow owns directory selection.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const MACHINE = {
  id: 'm-1', name: 'box', host: 'box', port: 22, username: 'deploy',
  passwordSet: false, credentialBackend: 'plain', useSshConfig: true,
  backend: 'native', recentWorkspaces: [],
  sshConfigResolved: { matched: true, host: '10.0.0.7', username: 'deploy', port: 2200 },
}

/** A host that answers like the plugin's routes do. */
function stub({ probe = { ok: true, latencyMs: 42, host: '10.0.0.7', user: 'deploy' }, machines = [MACHINE], entries = null } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ method, url: String(url), body })
    const reply = (o) => ({ ok: true, status: 200, json: async () => o })
    const u = String(url)
    if (u.includes('/dsh-remote/ssh-config')) {
      return reply({ ok: true, present: true, file: '/home/me/.ssh/config', entries: entries || [
        { host: 'fresh', alias: 'fresh', hostName: '10.0.0.8', user: 'root', port: 22 },
      ] })
    }
    if (u.includes('/dsh-remote/machines')) {
      if (method === 'POST') {
        return reply({ ok: true, created: true, machine: MACHINE, machines: [MACHINE], currentId: MACHINE.id })
      }
      return reply({ machines, currentId: '' })
    }
    if (u.includes('/dsh-remote/current')) return reply({ ok: true, currentId: MACHINE.id })
    if (u.includes('/dsh-remote/test-connect')) return reply(probe)
    if (u.includes('/dsh-remote/forwards')) return reply({ forwards: [] })
    if (u.includes('/dsh-remote/audit')) return reply({ ok: true, auditEnabled: false, lines: [] })
    if (u.includes('/dsh-remote/web-attach')) return reply({ ok: true, attach: null, attaches: [], deploys: [] })
    if (u.includes('/dsh-remote/update-check')) return reply({ ok: true, current: '9.9.9', latest: '9.9.9', updateAvailable: false, updateMode: 'off' })
    return reply({ ok: true })
  }
  return { ui: mountClient({ fetch, effectDependencies: true }), calls }
}

test('opening settings automatically probes each host without adopting, selecting, or opening a workspace', async () => {
  const { ui, calls } = stub()
  try {
    const tree = await ui.settle()
    const probes = calls.filter(call => call.url.includes('/test-connect'))
    assert.equal(probes.length, 2)
    assert.ok(probes.some(call => call.body.id === MACHINE.id))
    assert.ok(probes.some(call => call.body.host === 'fresh' && call.body.useSshConfig === true))
    assert.match(ui.text(tree), /可用 · 42 ms/)
    assert.equal(calls.filter(call => call.method === 'POST' && !call.url.includes('/test-connect')).length, 0)
    assert.equal(ui.components(tree).some(component => component.type === ui.component('sidebar.workspaces.directoryFlow')), false)
    assert.doesNotMatch(ui.text(tree), /当前远程机|默认目标|默认目录|打开项目|最近工作区/)
    assert.equal(ui.buttons(tree).some(button => /^(连接|选目录|打开项目)$/.test(button.label)), false)
  } finally { ui.dispose() }
})

test('a failed automatic probe reports its own host and keeps other settings usable', async () => {
  const { ui } = stub({ probe: { ok: false, error: 'Permission denied (publickey)' } })
  try {
    const tree = await ui.settle()
    const rows = ui.elements(tree).filter(element => element.props.className?.includes('dsh-rw-settings-host-row'))
    assert.equal(rows.length, 2)
    for (const row of rows) assert.match(ui.textOf(row), /不可用.*Permission denied|Permission denied.*不可用/)
    assert.equal(ui.buttons(tree).find(button => button.label === '编辑').disabled, false)
  } finally { ui.dispose() }
})

test('refresh rechecks connectivity without touching the workspace, while registry polls do not reconnect repeatedly', async () => {
  const { ui, calls } = stub()
  try {
    let tree = await ui.settle()
    await ui.fireIntervals(); tree = await ui.settle()
    assert.equal(calls.filter(call => call.url.includes('/test-connect')).length, 2)
    const refresh = ui.buttons(tree).find(button => button.title.includes('重新读取'))
    refresh.el.props.onClick(); await ui.tick(); tree = await ui.settle()
    assert.equal(calls.filter(call => call.url.includes('/test-connect')).length, 4)
    assert.equal(calls.some(call => /\/(current|mirror|workspace)$/.test(call.url)), false)
  } finally { ui.dispose() }
})

// ── list ergonomics: search, recency, live state ───────────────────────────

test('the search box narrows BOTH halves of the list', async () => {
  const machines = [
    { ...MACHINE, id: 'm-1', name: 'alpha', host: 'alpha' },
    { ...MACHINE, id: 'm-2', name: 'beta', host: 'beta' },
  ]
  const { ui } = stub({ machines, entries: [{ host: 'gamma', alias: 'gamma', hostName: '10.9.9.9', user: 'root', port: 22 }] })
  try {
    let tree = await ui.settle()
    assert.match(ui.text(tree), /alpha/, 'alpha is listed before filtering')
    assert.match(ui.text(tree), /gamma/, 'the ssh-config host is listed too')

    const box = ui.inputs(tree).find((p) => String(p.placeholder || '').includes('搜索'))
    assert.ok(box, 'the host list must offer a search box')
    box.onChange({ target: { value: 'gam' } })
    tree = await ui.settle()

    const text = ui.text(tree)
    assert.match(text, /gamma/, 'the matching host stays')
    assert.doesNotMatch(text, /alpha/, 'a non-matching saved machine is filtered out')
    assert.doesNotMatch(text, /beta/, 'and so is the other one')
  } finally { ui.dispose() }
})

test('connectivity results replace historical connection state instead of implying a global active host', async () => {
  const machines = [
    { ...MACHINE, id: 'm-live', name: 'livebox', connected: true, latencyMs: 12 },
    { ...MACHINE, id: 'm-past', name: 'pastbox', connected: false, latencyMs: 88, lastConnectedAt: new Date().toISOString() },
  ]
  const { ui } = stub({ machines, entries: [], probe: { ok: true, latencyMs: 42 } })
  try {
    const tree = await ui.settle()
    const results = ui.elements(tree).filter(element => element.props.className === 'dsh-rw-settings-probe')
    assert.equal(results.length, 2)
    for (const result of results) assert.equal(ui.textOf(result), '可用 · 42 ms')
    assert.doesNotMatch(ui.text(tree), /已连接|上次连接|当前远程机|默认目标/)
  } finally { ui.dispose() }
})
test('a FAILED ssh-config request says so — it must not masquerade as "no hosts in your config"', async () => {
  // Real-GUI report: the panel showed 没在 C:\Users\…\.ssh\config 里找到主机 while the
  // file plainly had Host blocks. Cause: loadSshHosts() swallowed the request error
  // and set an empty list, so a 401 / 500 / an older host half that predates the
  // route rendered "your config has no hosts" — sending the user to edit a file that
  // was fine. The two states must read differently.
  const machines = []
  const ui = mountClient({
    fetch: async (url, init) => {
      const u = String(url)
      if (u.includes('/dsh-remote/ssh-config')) {
        return { ok: false, status: 500, json: async () => ({ ok: false, error: 'internal boom' }) }
      }
      if (u.includes('/dsh-remote/machines')) return { ok: true, status: 200, json: async () => ({ machines, currentId: '' }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })
  try {
    const tree = await ui.settle()
    const text = ui.text(tree)
    assert.doesNotMatch(text, /没在 .* 里找到主机/, 'a failed read must not claim the config has no hosts')
    assert.match(text, /读取失败/, 'it must say the read failed')
    assert.match(text, /internal boom|HTTP 500/, 'and carry the underlying reason')
  } finally { ui.dispose() }
})
test('automatic checks are bounded and leaving settings cancels queued checks and late results', async t => {
  const pending=[]
  const machines=Array.from({length:7},(_,index)=>({...MACHINE,id:'host-'+index,host:'host-'+index,name:'Host '+index}))
  const ui=mountClient({effectDependencies:true,fetch:async(url,init={})=>{
    const reply=json=>({ok:true,status:200,json:async()=>json})
    if(String(url).includes('/machines'))return reply({machines,currentId:'host-0'})
    if(String(url).includes('/ssh-config'))return reply({entries:[]})
    if(String(url).includes('/test-connect'))return new Promise(resolve=>pending.push({signal:init.signal,resolve}))
    return reply({ok:true})
  }})
  t.after(()=>ui.dispose())
  let tree=await ui.settle()
  assert.equal(pending.length,3,'a large registry must not open an unbounded number of SSH probes')
  assert.equal(ui.elements(tree).filter(element=>element.props.className==='dsh-rw-settings-probe').length,7)
  pending[0].resolve({ok:true,status:200,json:async()=>({ok:true,latencyMs:12})})
  await ui.tick();tree=await ui.settle()
  assert.equal(pending.length,4,'the next queued host starts when a slot is free')
  assert.match(ui.text(tree),/可用 · 12 ms/)
  ui.dispose()
  assert.ok(pending.every(check=>check.signal.aborted))
  for(const check of pending)check.resolve({ok:true,status:200,json:async()=>({ok:true,latencyMs:99999})})
  await ui.tick();tree=await ui.settle()
  assert.equal(pending.length,4,'closing the settings page prevents the remaining queued probes')
  assert.doesNotMatch(ui.text(tree),/99999/,'late probe results cannot update a closed settings page')
})

test('checks wait for both host lists so different API response times cannot start duplicate probe batches', async t => {
  let deliverConfig
  let probes=0
  const reply=json=>({ok:true,status:200,json:async()=>json})
  const ui=mountClient({effectDependencies:true,fetch:async(url)=>{
    if(String(url).includes('/machines'))return reply({machines:[MACHINE]})
    if(String(url).includes('/ssh-config'))return new Promise(resolve=>{deliverConfig=resolve})
    if(String(url).includes('/test-connect')){probes++;return reply({ok:true,latencyMs:8})}
    return reply({ok:true})
  }})
  t.after(()=>ui.dispose())
  await ui.settle()
  assert.equal(probes,0,'a slower SSH configuration read must not cause an early partial batch')
  deliverConfig(reply({entries:[{alias:'fresh',hostName:'another.test'}]}))
  await ui.tick();const tree=await ui.settle()
  assert.equal(probes,2,'each saved or discovered host is tested exactly once after both lists arrive')
  assert.match(ui.text(tree),/可用 · 8 ms/)
})
