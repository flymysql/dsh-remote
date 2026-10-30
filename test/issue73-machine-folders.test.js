// Issue #73 follow-up: 「最近工作区」挂在各自的机器下面，页面也会自己发现别处改了机器。
//
// Two gaps this closes:
//   · the folder list used to be ONE card showing only the current machine's recent
//     folders, so with several machines it silently described a different host than
//     the row you were looking at (VSCode's shape is host → folders);
//   · the page never noticed a change made elsewhere — an agent calling rw_connect, or
//     another tab switching machines — until the user reloaded. There is no push
//     channel, so the page polls the registry and also refreshes on window focus.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const MACHINE = {
  id: 'm-1', name: 'box', host: 'box', port: 22, username: 'root',
  passwordSet: false, credentialBackend: 'plain', useSshConfig: true,
  backend: 'native', sshConfigResolved: { matched: true, host: '10.0.0.7', username: 'root', port: 22 },
  recentWorkspaces: [],
}

/** A host that answers like the plugin's routes and lets the test mutate its state. */
function stub({ machines = [MACHINE], currentId = '' } = {}) {
  const state = { machines, currentId }
  const calls = []
  const fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ method, url: String(url), body })
    const reply = (o) => ({ ok: true, status: 200, json: async () => o })
    const u = String(url)
    if (u.includes('/dsh-remote/ssh-config')) return reply({ ok: true, present: false, file: '/home/me/.ssh/config', entries: [] })
    if (u.includes('/dsh-remote/machines')) {
      if (method === 'POST') return reply({ ok: true, created: false, machine: state.machines[0], machines: state.machines, currentId: state.currentId })
      return reply({ machines: state.machines, currentId: state.currentId })
    }
    if (u.includes('/dsh-remote/current')) return reply({ ok: true, currentId: state.currentId })
    if (u.includes('/dsh-remote/mirror')) {
      // The host re-asserts the machine, creates/reuses the mirror and remembers the folder.
      const m = state.machines.find((x) => x.id === body.machineId)
      if (m) {
        m.recentWorkspaces = [body.path, ...(m.recentWorkspaces || []).filter((p) => p !== body.path)]
        state.currentId = m.id
      }
      return reply({ ok: true, path: body.path, localMirror: '/mirrors/x', currentId: m ? m.id : '', machines: state.machines })
    }
    if (u.includes('/dsh-remote/test-connect')) return reply({ ok: true, latencyMs: 20, host: '10.0.0.7', user: 'root' })
    if (u.includes('/dsh-remote/forwards')) return reply({ forwards: [] })
    if (u.includes('/dsh-remote/audit')) return reply({ ok: true, auditEnabled: false, lines: [] })
    if (u.includes('/dsh-remote/web-attach')) return reply({ ok: true, attach: null, attaches: [], deploys: [] })
    if (u.includes('/dsh-remote/update-check')) return reply({ ok: true, current: '9.9.9', latest: '9.9.9', updateAvailable: false, updateMode: 'off' })
    return reply({ ok: true })
  }
  return { ui: mountClient({ fetch }), calls, state }
}

test('each machine carries its own recent folders, and opening one goes through /mirror for THAT machine', async () => {
  const machines = [
    { ...MACHINE, id: 'm-a', name: 'alpha', host: 'alpha', recentWorkspaces: ['/srv/alpha/web', '/srv/alpha/api'] },
    { ...MACHINE, id: 'm-b', name: 'beta', host: 'beta', recentWorkspaces: ['/home/beta/proj'] },
  ]
  const { ui, calls } = stub({ machines })
  try {
    let tree = await ui.settle()
    // Both machines advertise their own folder counts; the old single card is gone.
    assert.match(ui.text(tree), /最近工作区（2）/, 'alpha advertises its two folders')
    assert.match(ui.text(tree), /最近工作区（1）/, 'beta advertises its one folder')
    assert.doesNotMatch(ui.text(tree), /当前机器最近工作区/, 'the old current-machine-only card is gone')

    // Expand beta's list and open its folder.
    const betaToggle = ui.buttons(tree).find((b) => /最近工作区（1）/.test(b.label))
    assert.ok(betaToggle, 'the expander must be a button')
    betaToggle.el.props.onClick()
    tree = await ui.settle()
    assert.match(ui.text(tree), /\/home\/beta\/proj/, 'beta\'s folder is listed under beta')

    const open = ui.buttons(tree).filter((b) => /^打开$/.test(b.label))
    assert.equal(open.length, 1, 'only the expanded row shows an 打开 action')
    open[0].el.props.onClick()
    await ui.tick()
    tree = await ui.settle()

    const mirror = calls.find((c) => c.url.includes('/dsh-remote/mirror'))
    assert.ok(mirror, 'opening a folder must call /mirror (it creates/reuses the mirror)')
    assert.equal(mirror.body.machineId, 'm-b', 'and it must target the machine whose folder was clicked')
    assert.equal(mirror.body.path, '/home/beta/proj')
    assert.match(ui.text(tree), /已打开远程工作区/, 'the panel confirms what it opened')
  } finally { ui.dispose() }
})

test('a machine with no history shows no expander at all', async () => {
  const { ui } = stub({ machines: [{ ...MACHINE, recentWorkspaces: [] }] })
  try {
    const tree = await ui.settle()
    assert.equal(ui.buttons(tree).some((b) => /最近工作区/.test(b.label)), false,
      'nothing to expand → no dead affordance')
  } finally { ui.dispose() }
})

test('the page polls the registry, so a machine switched elsewhere shows up without a reload', async () => {
  const machines = [
    { ...MACHINE, id: 'm-a', name: 'alpha', host: 'alpha' },
    { ...MACHINE, id: 'm-b', name: 'beta', host: 'beta' },
  ]
  const { ui, calls, state } = stub({ machines, currentId: '' })
  try {
    let tree = await ui.settle()
    assert.doesNotMatch(ui.text(tree), /当前远程机：beta/, 'beta is not current yet')

    // An agent calls rw_connect for beta: the registry changes, the page does not.
    state.currentId = 'm-b'
    state.machines = machines.map((m) => (m.id === 'm-b' ? { ...m, connected: true, latencyMs: 33 } : m))

    const fired = await ui.fireIntervals()
    assert.ok(fired > 0, 'the page must register a poll interval')
    tree = await ui.settle()

    const gets = calls.filter((c) => c.method === 'GET' && c.url.includes('/dsh-remote/machines'))
    assert.ok(gets.length >= 2, 'the poll must re-read /machines')
    assert.match(ui.text(tree), /当前远程机：beta/, 'the externally switched machine is reflected')
    assert.match(ui.text(tree), /已连接/, 'and so is its live connection')
  } finally { ui.dispose() }
})

test('committing a folder must NOT post /mirror twice (the picker already created it)', async () => {
  // Real-GUI regression found on an isolated instance: DirPicker.commitPath() calls
  // onPicked(localMirror) AFTER /mirror succeeded, and the settings page treated that
  // LOCAL mirror path as a remote one and posted /mirror again — the host then tried
  // to stat a Windows path on the remote and the panel showed
  // "not a directory (or unreachable)". The picker now also hands over the remote
  // path, and the settings page stops re-posting.
  const machines = [{ ...MACHINE, id: 'm-a', name: 'alpha', host: 'alpha', recentWorkspaces: [] }]
  const { ui, calls } = stub({ machines, currentId: 'm-a' })
  try {
    let tree = await ui.settle()
    ui.buttons(tree).find((b) => /^选目录$/.test(b.label)).el.props.onClick()
    tree = await ui.settle()

    // Drive the picker's own commit the way the remote tab does: the component under
    // test is the real DirPicker, so call its onPicked with what commitPath passes.
    const DirPicker = ui.component('sidebar.workspaces.directoryFlow')
    const modal = ui.components(tree).find((el) => el.type === DirPicker)
    assert.ok(modal, 'the picker must be mounted')
    modal.props.onPicked('/mirrors/alpha/home', '/home/alpha')

    tree = await ui.settle()
    const mirrors = calls.filter((c) => c.url.includes('/dsh-remote/mirror'))
    assert.deepEqual(mirrors, [], 'onPicked must not trigger a second /mirror — it is already done')
    assert.match(ui.text(tree), /已打开远程工作区/, 'and it still reports what was opened')
    assert.equal(calls.some((c) => c.method === 'GET' && c.url.includes('/dsh-remote/machines')), true,
      'the registry is re-read so the new folder shows under the machine')
  } finally { ui.dispose() }
})