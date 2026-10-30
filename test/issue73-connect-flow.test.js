// Issue #73, the click path: 「列出来 → 点连接 → 选目录」.
//
// The route tests prove the host half adopts a ~/.ssh/config host correctly. This
// file proves the UI does what the reporter asked for: the list is on screen, one
// click connects (activate + probe), the RESULT lands on that row, and the flow
// continues into the folder picker — the way VSCode Remote-SSH behaves.
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
  return { ui: mountClient({ fetch }), calls }
}

test('clicking 连接 on a ~/.ssh/config host adopts it, probes it, and reports on that row', async () => {
  const { ui, calls } = stub()
  try {
    let tree = await ui.settle()
    // The discovered host is on screen with exactly one 连接 button.
    assert.match(ui.text(tree), /fresh/)
    const rowButtons = ui.buttons(tree).filter((b) => /^连接$/.test(b.label))
    assert.equal(rowButtons.length, 2, 'one 连接 for the discovered host, one for the saved machine')

    // Click the FIRST one — the discovered host (list order: discovered, then saved).
    rowButtons[0].el.props.onClick()
    await ui.tick()
    tree = await ui.settle()

    const adopt = calls.find((c) => c.body && c.body.action === 'from-ssh-config')
    assert.ok(adopt, 'the click must adopt the ssh-config host (no form, no alias/copy jargon)')
    assert.equal(adopt.body.alias, 'fresh')

    const probe = calls.find((c) => c.url.includes('/dsh-remote/test-connect'))
    assert.ok(probe, 'and then PROBE it, so the row can say whether it really works')
    assert.equal(probe.body.id, MACHINE.id, 'the probe must target the machine it just adopted')

    const text = ui.text(tree)
    assert.match(text, /已连接/, 'the row must report success')
    assert.match(text, /42ms/, 'with the latency it measured')
  } finally { ui.dispose() }
})

test('a failing connect reports the reason on that row, not in a panel-level blob', async () => {
  const { ui } = stub({ probe: { ok: false, error: 'Permission denied (publickey)' } })
  try {
    let tree = await ui.settle()
    ui.buttons(tree).filter((b) => /^连接$/.test(b.label))[0].el.props.onClick()
    await ui.tick()
    tree = await ui.settle()
    const text = ui.text(tree)
    assert.match(text, /Permission denied/, 'the failure must be visible on the row that failed')
  } finally { ui.dispose() }
})

test('after connecting, the folder picker opens so the user can pick a remote directory', async () => {
  const { ui } = stub()
  try {
    let tree = await ui.settle()
    ui.buttons(tree).filter((b) => /^连接$/.test(b.label))[0].el.props.onClick()
    await ui.tick()
    tree = await ui.settle()
    // The picker is the SAME component the sidebar registers; asserting identity
    // (not just 'some modal') is what keeps the two entry points from drifting.
    const DirPicker = ui.component('sidebar.workspaces.directoryFlow')
    const modals = ui.components(tree).filter((el) => el.type === DirPicker)
    assert.equal(modals.length, 1, 'the folder picker must be mounted after a successful connect')
    assert.equal(modals[0].props.open, true, 'and open')
    assert.equal(typeof modals[0].props.onPicked, 'function', 'committing a folder must go through onPicked')
  } finally { ui.dispose() }
})

test('a saved machine can open the folder picker directly, without reconnecting', async () => {
  const { ui, calls } = stub()
  try {
    let tree = await ui.settle()
    const openFolder = ui.buttons(tree).filter((b) => /^选目录$/.test(b.label))
    assert.equal(openFolder.length, 1, 'the saved machine offers 选目录')
    openFolder[0].el.props.onClick()
    tree = await ui.settle()
    const DirPicker = ui.component('sidebar.workspaces.directoryFlow')
    assert.equal(ui.components(tree).filter((el) => el.type === DirPicker).length, 1, 'clicking 选目录 opens the picker')
    assert.equal(calls.some((c) => c.url.includes('/dsh-remote/test-connect')), false,
      'opening the folder picker must not probe anything')
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

test('saved machines are ordered most-recently-connected first', async () => {
  const machines = [
    { ...MACHINE, id: 'm-old', name: 'olderbox', host: 'olderbox', lastConnectedAt: '2026-10-01T00:00:00.000Z' },
    { ...MACHINE, id: 'm-new', name: 'newerbox', host: 'newerbox', lastConnectedAt: '2026-10-29T00:00:00.000Z' },
    { ...MACHINE, id: 'm-never', name: 'neverbox', host: 'neverbox', lastConnectedAt: null },
  ]
  const { ui } = stub({ machines, entries: [] })
  try {
    const tree = await ui.settle()
    const text = ui.text(tree)
    const at = (s) => text.indexOf(s)
    assert.ok(at('newerbox') >= 0 && at('olderbox') >= 0, `both rows render: ${text.slice(0, 200)}`)
    assert.ok(at('newerbox') < at('olderbox'), 'the most recent connection comes first')
    assert.ok(at('olderbox') < at('neverbox'), 'a machine that never connected comes last')
  } finally { ui.dispose() }
})

test('a live connection reads 已连接, a past one reads "上次连接 …"', async () => {
  const machines = [
    { ...MACHINE, id: 'm-live', name: 'livebox', host: 'livebox', connected: true, latencyMs: 12, lastConnectedAt: '2026-10-29T00:00:00.000Z' },
    { ...MACHINE, id: 'm-past', name: 'pastbox', host: 'pastbox', connected: false, latencyMs: 88, lastConnectedAt: new Date(Date.now() - 5 * 60000).toISOString() },
    { ...MACHINE, id: 'm-none', name: 'freshbox', host: 'freshbox', connected: false, latencyMs: null, lastConnectedAt: null },
  ]
  const { ui } = stub({ machines, entries: [] })
  try {
    const tree = await ui.settle()
    const text = ui.text(tree)
    assert.match(text, /已连接/, 'a live socket must be reported as connected')
    assert.match(text, /上次连接/, 'a past connection says when it happened')
    assert.match(text, /5 分钟前/, 'with a relative age')
    assert.match(text, /88ms/, 'and the latency it measured')
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