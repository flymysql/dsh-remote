// Recent directories belong to workspace creation, not host settings.
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
  return { ui: mountClient({ fetch, effectDependencies: true }), calls, state }
}

test('settings keep host configuration separate from per-workspace recent directories', async () => {
  const machines = [
    { ...MACHINE, id: 'm-a', name: 'alpha', host: 'alpha', recentWorkspaces: ['/srv/alpha/web', '/srv/alpha/api'] },
    { ...MACHINE, id: 'm-b', name: 'beta', host: 'beta', recentWorkspaces: ['/home/beta/proj'] },
  ]
  const { ui, calls } = stub({ machines })
  try {
    const tree = await ui.settle()
    assert.match(ui.text(tree), /alpha/)
    assert.match(ui.text(tree), /beta/)
    assert.doesNotMatch(ui.text(tree), /最近工作区|\/srv\/alpha|\/home\/beta/)
    assert.equal(ui.components(tree).some(component => component.type === ui.component('sidebar.workspaces.directoryFlow')), false)
    assert.equal(calls.some(call => call.url.includes('/mirror')), false)
  } finally { ui.dispose() }
})

test('the page notices host edits elsewhere without adopting an external global target', async () => {
  const machines = [
    { ...MACHINE, id: 'm-a', name: 'alpha', host: 'alpha' },
    { ...MACHINE, id: 'm-b', name: 'beta', host: 'beta' },
  ]
  const { ui, calls, state } = stub({ machines })
  try {
    let tree = await ui.settle()
    state.currentId = 'm-b'
    state.machines = machines.map(machine => machine.id === 'm-b' ? { ...machine, name: 'beta-updated', connected: true } : machine)
    const fired = await ui.fireIntervals()
    assert.ok(fired > 0)
    tree = await ui.settle()
    assert.match(ui.text(tree), /beta-updated/)
    assert.doesNotMatch(ui.text(tree), /当前远程机|默认目标|已连接/)
    assert.ok(calls.filter(call => call.method === 'GET' && call.url.includes('/machines')).length >= 2)
    assert.equal(calls.some(call => call.url.includes('/current')), false)
  } finally { ui.dispose() }
})
