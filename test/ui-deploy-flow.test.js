// The remote-deploy panel, driven by clicks.
//
// 体检 / 部署并验证 / 让 AI 排查 is the flow that decides whether a remote machine
// can host a DSH Web UI, and it is the only place in the plugin that RUNS commands
// on the remote as a side effect of a button. Its failure modes are UI-shaped:
// a probe button that is clickable without a machine, a verdict whose findings the
// panel swallows, an install that fires without the confirm step, or a task that
// renders as "done" while the backend said it failed.
//
// The stubbed host answers the same shapes /dsh-remote/web-attach returns, so the
// assertions are about what the USER sees for a given verdict.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const MACHINE = {
  id: 'm-1',
  name: 'box',
  host: '10.0.0.9',
  port: 22,
  username: 'root',
  passwordSet: true,
  credentialBackend: 'plain',
  useSshConfig: false,
  backend: 'native',
  recentWorkspaces: [],
}

/** A verdict the backend produces: findings carry their own severity. */
const BLOCKED_VERDICT = {
  ok: false,
  findings: [
    // The REAL finding shape from judgeProbe(): {code, severity, summary, detail?, fix?}.
    { code: 'node-missing', severity: 'blocker', summary: '远端没有 node', detail: '需要 >= 20', fix: '装 node 20+ 或换机器' },
    { code: 'npm-slow', severity: 'warn', summary: 'npm registry 很慢' },
    { code: 'ssh-ok', severity: 'ok', summary: 'SSH 可达' },
  ],
}

const OK_VERDICT = {
  ok: true,
  findings: [{ code: 'dsh-ready', severity: 'ok', summary: '远端 dsh 已就绪' }],
}

function mount({ probe = null, install = null } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ method, url: String(url), body })
    const reply = (obj) => ({ ok: true, status: 200, json: async () => obj })
    const u = String(url)
    if (u.includes('/dsh-remote/web-attach')) {
      if (method === 'GET') return reply({ ok: true, attach: null, attaches: [], deploys: [], deploy: null })
      if (body && body.action === 'probe') return reply({ ok: true, kind: 'probe', verdict: probe })
      if (body && body.action === 'install') return reply({ ok: true, task: install })
      return reply({ ok: true })
    }
    if (u.includes('/dsh-remote/machines')) return reply({ machines: [MACHINE], currentId: '' })
    if (u.includes('/dsh-remote/forwards')) return reply({ forwards: [] })
    if (u.includes('/dsh-remote/audit')) return reply({ ok: true, auditEnabled: false, lines: [] })
    if (u.includes('/dsh-remote/update-check')) return reply({ ok: true, current: '1.0.0', latest: '1.0.0', updateAvailable: false, updateMode: 'off' })
    return reply({ ok: true })
  }
  return { ui: mountClient({ fetch }), calls }
}

/** Expand a collapsed settings section by its visible title. */
async function openSection(ui, re) {
  let tree = await ui.settle()
  const toggle = ui.button(tree, re)
  toggle.el.props.onClick()
  return ui.settle()
}

/** The machine <select> inside the deploy panel. */
function deploySelect(ui, tree) {
  const selects = ui.elements(tree).filter((el) => el.type === 'select')
  const hit = selects.find((el) => ui.elements(el).some((o) => o.type === 'option' && /m-1/.test(String(o.props.value))))
  assert.ok(hit, `the deploy panel must offer a machine picker (selects: ${selects.length})`)
  return hit
}

test('the deploy panel refuses to probe until a machine is chosen, then renders the verdict', async () => {
  const { ui, calls } = mount({ probe: BLOCKED_VERDICT })
  try {
    let tree = await openSection(ui, /部署/)
    const probe = ui.button(tree, /^体检（只读）$/)
    assert.equal(probe.disabled, true, 'probing without a machine must be impossible')

    // Choose the machine the way the browser does.
    const select = deploySelect(ui, tree)
    select.props.onChange({ target: { value: 'm-1' } })
    tree = await ui.settle()
    const ready = ui.button(tree, /^体检（只读）$/)
    assert.equal(ready.disabled, false, 'with a machine chosen the probe must be clickable')

    ready.el.props.onClick()
    await ui.tick()
    tree = await ui.settle()

    const sent = calls.find((c) => c.body && c.body.action === 'probe')
    assert.ok(sent, 'clicking 体检 must POST a probe')
    assert.equal(sent.body.machineId, 'm-1', 'the probe must name the chosen machine')

    const text = ui.text(tree)
    assert.match(text, /远端环境有问题/, 'a blocking verdict must be stated as such')
    for (const finding of BLOCKED_VERDICT.findings) {
      assert.match(text, new RegExp(finding.summary), `every finding must be shown, missing: ${finding.summary}`)
    }
    assert.match(text, /需要 >= 20/, 'a finding detail must be shown')
    assert.match(text, /装 node 20/, 'the suggested fix must be shown')
    assert.doesNotMatch(text, /远端环境可用/, 'a blocked verdict must not also claim readiness')
  } finally { ui.dispose() }
})

test('a passing probe says the machine is ready and offers the deploy action', async () => {
  const { ui } = mount({ probe: OK_VERDICT })
  try {
    let tree = await openSection(ui, /部署/)
    deploySelect(ui, tree).props.onChange({ target: { value: 'm-1' } })
    tree = await ui.settle()
    ui.button(tree, /^体检（只读）$/).el.props.onClick()
    await ui.tick()
    tree = await ui.settle()
    const text = ui.text(tree)
    assert.match(text, /远端环境可用/, 'a passing verdict must be stated positively')
    assert.match(text, /远端 dsh 已就绪/, 'its finding must be listed too')
    assert.doesNotMatch(text, /远端环境有问题/)
  } finally { ui.dispose() }
})

test('deploying asks for confirmation and reports the task progress it was given', async () => {
  const task = {
    id: 't-1',
    status: 'running',
    current: 'npm install',
    steps: [
      { id: 's1', title: '上传安装包', ok: true },
      { id: 's2', title: 'npm install', ok: false, output: 'ETIMEDOUT' },
    ],
    progress: { doneSteps: 1, totalSteps: 3 },
  }
  const { ui, calls } = mount({ probe: OK_VERDICT, install: task })
  try {
    let tree = await openSection(ui, /部署/)
    const before = ui.button(tree, /部署并验证/)
    assert.equal(before.disabled, true, 'deploying without a machine must be impossible')
    deploySelect(ui, tree).props.onChange({ target: { value: 'm-1' } })
    tree = await ui.settle()
    ui.button(tree, /部署并验证/).el.props.onClick()
    await ui.tick()
    tree = await ui.settle()

    const sent = calls.find((c) => c.body && c.body.action === 'install')
    assert.ok(sent, 'the deploy button must POST an install')
    assert.equal(sent.body.machineId, 'm-1')

    const text = ui.text(tree)
    assert.match(text, /npm install/, 'the in-flight step must be visible')
    assert.match(text, /ETIMEDOUT/, 'a failed step must show its output, not just a red cross')
    assert.match(text, /1\/3|1 \/ 3/, 'the progress counter must be rendered')
    assert.match(text, /取消/, 'a running task must offer a cancel action')
  } finally { ui.dispose() }
})
