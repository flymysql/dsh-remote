// Issue #104 — the remote file viewer gains line numbers + host syntax
// highlighting + jump-to-line from chat links.
//
//   · every text file now renders line-numbered rows (highlighter or not);
//   · when the host ships its Shiki highlighter and knows the grammar, tokens
//     come out colored (bundle-verified contract: useCodeHighlighter(lang) →
//     highlight(text) → per-line [{text, style:{color}}]);
//   · a chat link carrying a line (`x.c:42` or `…#L42`) opens the file ON that
//     line: the anchor is stripped before resolution (no file is ever looked up
//     under the literal name "main.c:42") and the target row is flash-marked.
//
// Drives the REAL registered tab bodies through the render harness. CodeView is
// a nested component the tree walker does not mount, so each test mounts the
// CodeView element it finds (by its distinctive {code, path} props) — one extra
// call with the driver's dispatcher still installed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const CONTENT_3 = '#include <stdio.h>\nint main() {\n  return 0\n}\n'
const MIRROR = { dir: 'C:\\mirror\\proj', host: '10.0.0.9', port: 22, username: 'root', remotePath: '/srv/app', name: '' }

function fetchFor(content, calls) {
  return async (url, init) => {
    const u = String(url)
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ url: u, body })
    const reply = (obj) => ({ ok: true, status: 200, json: async () => obj })
    if (u.includes('/dsh-remote/bindings')) return reply({ mirrors: [MIRROR] })
    if (u.includes('/dsh-remote/read')) return reply({ content, mtime: 1, size: content.length })
    return reply({ ok: true })
  }
}

const sessionsFor = (cwd) => ({ list: { getSnapshot: () => ({ byId: { 's-1': { cwd } } }) } })

/** Find the CodeView element a RemoteFileTab-rendered tree contains, and mount it. */
function mountCodeView(tree, ui) {
  const el = ui.elements(tree).find((n) => n.props && typeof n.props.code === 'string' && typeof n.props.path === 'string')
  assert.ok(el, 'the file tab must contain a CodeView element')
  return el.type(el.props)
}

/** Row elements carry data-line; the gutter is their first child. */
function rows(cvTree, ui) {
  return ui.elements(cvTree).filter((n) => n.props && typeof n.props['data-line'] === 'number')
}

test('a text file renders line-numbered rows even with no host highlighter', async () => {
  const calls = []
  const ui = mountClient({ fetch: fetchFor(CONTENT_3, calls) })
  try {
    const body = ui.body('dsh-remote/file')
    const tree = await ui.settleComponent(body, {
      sessionId: 's-1',
      useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://dsh-remote/file/' + encodeURIComponent('/srv/app/main.c') } } }),
    })
    const cv = mountCodeView(tree, ui)
    const rs = rows(cv, ui)
    assert.equal(rs.length, 5, 'one row per source line (trailing newline included)')
    assert.deepEqual(rs.map((r) => r.props['data-line']), [1, 2, 3, 4, 5])
    // The gutter shows the numbers (right-aligned, non-selectable).
    assert.equal(rs[0].props.children[0].props.children, '1')
    assert.equal(rs[0].props.children[0].props.style.userSelect, 'none')
  } finally { ui.dispose() }
})

test('a known grammar is highlighted through the host engine', async () => {
  const calls = []
  const ui = mountClient({ fetch: fetchFor(CONTENT_3, calls), withCodeHighlighter: true })
  try {
    const body = ui.body('dsh-remote/file')
    const tree = await ui.settleComponent(body, {
      sessionId: 's-1',
      useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://dsh-remote/file/' + encodeURIComponent('/srv/app/main.c') } } }),
    })
    const cv = mountCodeView(tree, ui)
    const colored = ui.elements(cv).filter((n) => n.props && n.props.style && n.props.style.color === 'rgb(9,9,9)')
    assert.ok(colored.length >= 5, `expected stub-colored tokens on every line, got ${colored.length}`)
  } finally { ui.dispose() }
})

test('an unknown extension still gets line numbers (grammar-less fallback)', async () => {
  const calls = []
  const ui = mountClient({ fetch: fetchFor(CONTENT_3, calls), withCodeHighlighter: true })
  try {
    const body = ui.body('dsh-remote/file')
    const tree = await ui.settleComponent(body, {
      sessionId: 's-1',
      useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://dsh-remote/file/' + encodeURIComponent('/srv/app/Makefile.weird') } } }),
    })
    const cv = mountCodeView(tree, ui)
    const rs = rows(cv, ui)
    assert.equal(rs.length, 5, 'line numbers are not hostage to grammar knowledge')
  } finally { ui.dispose() }
})

test('a chat link with #L2 opens the file flash-marking line 2', async () => {
  const calls = []
  const many = Array.from({ length: 50 }, (_, i) => 'line ' + (i + 1)).join('\n')
  const ui = mountClient({ fetch: fetchFor(many, calls), services: { sessions: sessionsFor(MIRROR.dir) } })
  try {
    const body = ui.body('dsh-remote/remote-link')
    const tree = await ui.settleComponent(body, {
      sessionId: 's-1',
      useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://file/session/s-1/src/main.c#L2' } } }),
    })
    // Resolution stripped the anchor: the read went to the real path.
    const read = calls.find((c) => c.url.includes('/dsh-remote/read'))
    assert.ok(read, 'the link must trigger a remote read')
    assert.equal(read.body.path, '/srv/app/src/main.c', 'never look up a file literally named main.c#L2')
    const cv = mountCodeView(tree, ui)
    const target = rows(cv, ui).find((r) => r.props['data-line'] === 2)
    assert.ok(target, 'line 2 must exist in the rendered body')
    assert.match(String(target.props.className || ''), /dsh-rw-line-flash/, 'the jumped row is flash-marked')
    assert.ok(!rows(cv, ui).some((r) => r.props['data-line'] !== 2 && /dsh-rw-line-flash/.test(String(r.props.className || ''))), 'only the target row flashes')
  } finally { ui.dispose() }
})

test('a chat link with a :42 suffix strips it before resolving', async () => {
  const calls = []
  const many = Array.from({ length: 50 }, (_, i) => 'line ' + (i + 1)).join('\n')
  const ui = mountClient({ fetch: fetchFor(many, calls), services: { sessions: sessionsFor(MIRROR.dir) } })
  try {
    const body = ui.body('dsh-remote/remote-link')
    const tree = await ui.settleComponent(body, {
      sessionId: 's-1',
      useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://file/session/s-1/src/main.c:42' } } }),
    })
    const read = calls.find((c) => c.url.includes('/dsh-remote/read'))
    assert.equal(read.body.path, '/srv/app/src/main.c', 'the :42 suffix is an anchor, not part of the name')
    const cv = mountCodeView(tree, ui)
    assert.ok(rows(cv, ui).find((r) => r.props['data-line'] === 42 && /dsh-rw-line-flash/.test(String(r.props.className || ''))), 'line 42 flashes')
  } finally { ui.dispose() }
})

test('host navigation params preserve the line and same-tab navigation resolves the new file', async () => {
  const calls = []
  const many = Array.from({ length: 100 }, (_, i) => 'line ' + (i + 1)).join('\n')
  const ui = mountClient({ effectDependencies: true, fetch: fetchFor(many, calls), services: { sessions: sessionsFor(MIRROR.dir) } })
  try {
    const body = ui.body('dsh-remote/remote-link')
    for (const [path, line] of [['tools/queue_documents.py', 93], ['seedfactory/produce.py', 75], ['seedfactory/produce.py', 42]]) {
      const tree = await ui.settleComponent(body, {
        sessionId: 's-1',
        useTabInfo: () => ({ tab: { navigation: {
          address: 'dsh-resource://file/session/s-1//Workspace/tb4-workspace/tb4-new/' + path,
          params: { line },
        } } }),
      })
      const read = calls.filter((c) => c.url.includes('/dsh-remote/read')).at(-1)
      assert.equal(read.body.path, '/Workspace/tb4-workspace/tb4-new/' + path)
      assert.equal(read.body.sessionId, 's-1', 'read must retain the address session, not a global machine')
      const cv = mountCodeView(tree, ui)
      assert.ok(rows(cv, ui).find((r) => r.props['data-line'] === line && /dsh-rw-line-flash/.test(String(r.props.className || ''))))
    }
  } finally { ui.dispose() }
})

test('valid navigation lines override legacy anchors and invalid params fall back safely', async () => {
  for (const [param, expected] of [[3, 3], [0, 2], [-1, 2], [1.5, 2], ['93', 2], [undefined, 2]]) {
    const calls = []
    const ui = mountClient({ fetch: fetchFor(CONTENT_3, calls), services: { sessions: sessionsFor(MIRROR.dir) } })
    try {
      const tree = await ui.settleComponent(ui.body('dsh-remote/remote-link'), {
        sessionId: 's-1',
        useTabInfo: () => ({ tab: { navigation: {
          address: 'dsh-resource://file/session/s-1/src/main.c#L2', params: { line: param },
        } } }),
      })
      const cv = mountCodeView(tree, ui)
      const flashed = rows(cv, ui).filter((r) => /dsh-rw-line-flash/.test(String(r.props.className || '')))
      assert.deepEqual(flashed.map((r) => r.props['data-line']), [expected])
    } finally { ui.dispose() }
  }
})

test('a plain link (no anchor) opens the file at its top, nothing flashing', async () => {
  const calls = []
  const ui = mountClient({ fetch: fetchFor(CONTENT_3, calls), services: { sessions: sessionsFor(MIRROR.dir) } })
  try {
    const body = ui.body('dsh-remote/remote-link')
    const tree = await ui.settleComponent(body, {
      sessionId: 's-1',
      useTabInfo: () => ({ tab: { navigation: { address: 'dsh-resource://file/session/s-1/src/main.c' } } }),
    })
    const cv = mountCodeView(tree, ui)
    assert.ok(!rows(cv, ui).some((r) => /dsh-rw-line-flash/.test(String(r.props.className || ''))), 'no anchor → no flash')
  } finally { ui.dispose() }
})
