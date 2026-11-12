// Issue #124 — the audit panel showed the raw UTC timestamp while the file
// browser on the same settings page renders local time. Storage stays UTC
// (test/audit.test.js pins that); only the RENDER converts, and the original
// line remains one hover away via the row's title attribute.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mountClient, elements } from './harness/render.js'

const KNOWN_LINE = '2026-11-12T01:52:39.628Z | ?@box:22 | exec | 0 | ls -la'
const PLAIN_LINE = 'not a stamped line at all'

function stub() {
  const fetch = async (url, init) => {
    const reply = (o) => ({ ok: true, status: 200, json: async () => o })
    const u = String(url)
    if (u.includes('/dsh-remote/audit')) return reply({ ok: true, auditEnabled: true, lines: [KNOWN_LINE, PLAIN_LINE], file: '/x/audit.log' })
    if (u.includes('/dsh-remote/machines')) return reply({ machines: [], currentId: '' })
    if (u.includes('/dsh-remote/ssh-config')) return reply({ ok: true, present: false, entries: [] })
    if (u.includes('/dsh-remote/forwards')) return reply({ forwards: [] })
    if (u.includes('/dsh-remote/web-attach')) return reply({ ok: true, attach: null, attaches: [], deploys: [] })
    if (u.includes('/dsh-remote/update-check')) return reply({ ok: true, current: '9.9.9', latest: '9.9.9', updateAvailable: false, updateMode: 'off' })
    return reply({ ok: true })
  }
  return { ui: mountClient({ fetch }) }
}

test('audit panel renders the stamp in LOCAL time, keeps raw UTC on hover', async () => {
  const { ui } = stub()
  try {
    let tree = await ui.settle()
    // Expand the audit section ("最近执行的远程命令（审计日志）").
    tree = await ui.click(tree, /最近执行的远程命令/)

    const text = ui.text(tree)
    assert.match(text, /exec \| 0 \| ls -la/, 'the audit line itself is rendered')
    assert.doesNotMatch(text, /2026-11-12T01:52:39/, 'raw UTC must not be visible anymore')

    // The converted stamp equals what Date computes for THIS machine's local
    // zone — no hard-coded offset, the test travels across timezones.
    const d = new Date('2026-11-12T01:52:39.628Z')
    const pad = (x) => String(x).padStart(2, '0')
    const expectStamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    assert.ok(text.includes(expectStamp), `expected local stamp ${expectStamp} in panel`)

    // Hover keeps the untouched original (UTC forensic trail).
    const auditRows = elements(tree).filter((el) => el.props && el.props.title === KNOWN_LINE)
    assert.equal(auditRows.length, 1, 'exactly one row carries the raw line as its tooltip')

    // Lines WITHOUT a recognisable stamp pass through unchanged (no NaN garbage).
    assert.ok(text.includes(PLAIN_LINE), 'plain lines render verbatim')
    ui.dispose()
  } finally {
    ui.dispose()
  }
})
