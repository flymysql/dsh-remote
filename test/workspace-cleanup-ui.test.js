// Issue #96 — the settings page's workspace-cleanup section (Web/Desktop face
// of the TUI cleanup page). Drives the REAL settings page through the shared
// render harness: open the section, confirm the destructive tier through the
// themed dialog, assert the POST and the refreshed list. Cancel must not delete.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mountClient } from './harness/render.js'

const ROW = {
  localMirror: 'C:\\home\\remote-workspaces\\10.0.0.9-root-22\\proj',
  remotePath: '/srv/proj', host: '10.0.0.9', port: 22, username: 'root',
  machineId: 'm1', machineName: 'box', title: 'box-proj',
  registered: true, recent: true, sessionCount: 2, liveSessionCount: 0,
  mirrorBytes: 2048, mirrorSizeTruncated: false,
}

function mountCleanup({ mirrors = [ROW] } = {}) {
  const list = mirrors.slice()
  const calls = []
  const fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ method, url: String(url), body })
    const reply = (obj) => ({ ok: true, status: 200, json: async () => obj })
    if (String(url).includes('/dsh-remote/workspace-mirrors')) return reply({ ok: true, mirrors: list.map((m) => ({ ...m })) })
    if (String(url).includes('/dsh-remote/workspace-cleanup')) {
      if (body && body.mode) {
        const at = list.findIndex((m) => m.localMirror === body.localMirror)
        if (at >= 0 && body.mode !== 'recent') list.splice(at, 1)
        return reply({ ok: true, removedSessions: 2, removedMirror: body.mode === 'all' })
      }
      return reply({ ok: false, error: 'mode must be all | sessions | recent' })
    }
    return reply({ ok: true })
  }
  return { ui: mountClient({ fetch }), calls }
}

/** Open the cleanup section and return the settled tree. */
async function openSection(ui) {
  let tree = await ui.settle()
  const toggles = ui.button(tree, /工作区清理|Workspace cleanup/)
  toggles.el.props.onClick()
  await ui.tick()
  return ui.settle()
}

/** The confirm dialog element (nested component) rendered as its real subtree. */
function dialogSubtree(ui, tree) {
  const dlg = ui.elements(tree).find((el) => typeof el.type === 'function' && el.props && typeof el.props.message === 'string' && typeof el.props.onAnswer === 'function')
  return dlg ? { subtree: dlg.type(dlg.props), answer: dlg.props.onAnswer } : null
}

test('cleanup section: open → 彻底删除 → confirm → POST mode=all → row gone', async () => {
  const { ui, calls } = mountCleanup({})
  try {
    let tree = await ui.settle()
    assert.ok(!ui.text(tree).includes('/srv/proj'), 'collapsed section lists nothing')
    tree = await openSection(ui)
    assert.ok(ui.text(tree).includes('/srv/proj'), 'the seeded mirror row is listed')

    const del = ui.button(tree, /^(彻底删除|Delete forever)$/)
    del.el.props.onClick()
    await ui.tick()
    tree = await ui.settle()
    const dlg = dialogSubtree(ui, tree)
    assert.ok(dlg, 'the destructive tier asks first')
    assert.match(dlg.subtree.props && dlg.subtree.props.message ? dlg.subtree.props.message : ui.text(dlg.subtree), /srv\/proj/)
    const confirmBtn = ui.elements(dlg.subtree).find((el) => el.type === 'button' && /^(确认|Confirm)$/.test(ui.text(el).trim()))
    assert.ok(confirmBtn, 'the dialog has a confirm button')
    confirmBtn.props.onClick()
    await ui.tick()
    tree = await ui.settle()
    const post = calls.find((c) => c.url.includes('/dsh-remote/workspace-cleanup') && c.method === 'POST')
    assert.ok(post, 'the cleanup POST fired')
    assert.equal(post.body.mode, 'all')
    assert.equal(post.body.localMirror, ROW.localMirror)
    assert.ok(!ui.text(tree).includes('/srv/proj'), 'the row is gone after the refreshed list')
  } finally { ui.dispose() }
})

test('cleanup: declining the confirm dialog issues no request', async () => {
  const { ui, calls } = mountCleanup({})
  try {
    let tree = await openSection(ui)
    ui.button(tree, /^(彻底删除|Delete forever)$/).el.props.onClick()
    await ui.tick()
    tree = await ui.settle()
    const dlg = dialogSubtree(ui, tree)
    assert.ok(dlg)
    const cancelBtn = ui.elements(dlg.subtree).find((el) => el.type === 'button' && /^(取消|Cancel)$/.test(ui.text(el).trim()))
    cancelBtn.props.onClick()
    await ui.tick()
    await ui.settle()
    assert.ok(!calls.some((c) => c.url.includes('/dsh-remote/workspace-cleanup')), 'no POST when the user chickens out')
  } finally { ui.dispose() }
})

test('cleanup: 移出最近 is the light tier (no dialog)', async () => {
  const { ui, calls } = mountCleanup({})
  try {
    let tree = await openSection(ui)
    ui.button(tree, /^(移出最近|Forget)$/).el.props.onClick()
    await ui.tick()
    await ui.settle()
    const post = calls.find((c) => c.url.includes('/dsh-remote/workspace-cleanup'))
    assert.ok(post, 'the forget call fires immediately')
    assert.equal(post.body.mode, 'recent')
  } finally { ui.dispose() }
})
