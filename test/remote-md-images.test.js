// Remote Markdown illustrations.
//
// The host renderer draws `![alt](dest)` two ways: an absolute HTTP(S)
// destination as authored, and everything else through the owner's
// `pathImages` vocabulary. A miss is not an error — it renders the alt text.
// The remote file pane used to pass NO vocabulary, so every `![](img/x.svg)`
// in a remote .md rendered as its caption and the figures never loaded. These
// tests pin the fix where the user sees it: the DOM the pane produces for a
// document whose figures live next to it on the REMOTE host.
//
// Two things must stay true, or the fix becomes a regression:
//   · a figure is read over the SESSION binding (never through this host's
//     local `api/file` route, which would read a different file), and
//   · nothing is read for ordinary links, absolute HTTP(S) images, or a
//     document that is merely opened in source mode.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

// The file tab's own address grammar (see remoteFilePath): the session comes
// from the tab's slot props, not from the address.
const ADDRESS = (path) => 'dsh-resource://dsh-remote/file/' + encodeURIComponent(path)
const SVG = 'PHN2ZyB2aWV3Qm94PSIwIDAgMSAxIj48L3N2Zz4+'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function json(obj) {
  return { ok: true, status: 200, json: async () => obj }
}

/** A fetch stub that answers the remote file read and lets the other routes no-op. */
function remoteReadStub({ text, images = () => undefined, documentPath = '/srv/app/README.md' } = {}) {
  const calls = []
  const fetch = async (url, init) => {
    const path = String(url)
    const body = init && init.body ? JSON.parse(init.body) : null
    calls.push({ path, body })
    if (path.includes('/dsh-remote/read') && body) {
      const image = images(body.path)
      if (image) return json({ ok: true, binary: false, image: true, mime: image.mime, content: image.content, size: 8, mtime: 1 })
      if (body.path === documentPath) return json({ ok: true, binary: false, content: text, size: text.length, mtime: 1, revision: 'a'.repeat(64), eol: 'lf' })
      return { ok: false, status: 404, json: async () => ({ ok: false, code: 'REMOTE_FILE_NOT_FOUND', error: '远端不存在此文件。' }) }
    }
    return json({ ok: true })
  }
  return { calls, fetch }
}

function mount(opts) {
  const stub = remoteReadStub(opts)
  const ui = mountClient({
    fetch: stub.fetch,
    // The pane's effects use real dependency arrays (source mode / text), so
    // the driver must re-run them when those change, as React does.
    effectDependencies: true,
    // Faithful image rendering: HTTP(S) as authored, otherwise the vocabulary,
    // otherwise the alt text — the host's `imageSource` contract.
    hostMarkdownImages: true,
  })
  return { ui, calls: stub.calls }
}

function fileProps(sessionId = 's-1', path = '/srv/app/README.md') {
  return { sessionId, useTabInfo: () => ({ tab: { navigation: { address: ADDRESS(path) } } }) }
}

/**
 * The MarkdownText stub is a `React.memo` wrapper (the host's real shape), so
 * the tree walker leaves it unmounted. Render it to inspect what the pane
 * asked the host to draw.
 */
function markdownOutput(ui, tree) {
  const el = ui.elements(tree).find(e => e.props && typeof e.props.text === 'string' && e.type && e.type.$$typeof === Symbol.for('react.memo'))
  assert.ok(el, 'expected the rendered MarkdownText branch')
  const inner = typeof el.type.type === 'function' ? el.type.type : el.type
  return inner(el.props)
}

/** Open the document and switch the pane to its rendered preview. */
async function openPreview(ui, path = '/srv/app/README.md', sessionId = 's-1') {
  const body = ui.body('dsh-remote/file')
  const props = fileProps(sessionId, path)
  let tree = await ui.settleComponent(body, props)
  ui.button(tree, /^预览$/).el.props.onClick()
  tree = await ui.settleComponent(body, props)
  await ui.tick(10)
  tree = await ui.settleComponent(body, props)
  return tree
}

const imageReads = (calls) => calls.filter(c => c.path.includes('/dsh-remote/read') && c.body && /\.(png|svg)$/i.test(String(c.body.path)))

test('a remote .md figure renders from the bytes read over the session', async () => {
  const text = '# HND\n\n![NHD 与 HND 的页内布局对比](img/kv-block-nhd-vs-hnd.svg)\n'
  const { ui, calls } = mount({
    text,
    images: (path) => path === '/srv/app/img/kv-block-nhd-vs-hnd.svg' ? { mime: 'image/svg+xml', content: SVG } : undefined,
  })
  try {
    const tree = await openPreview(ui)
    const out = ui.elements(markdownOutput(ui, tree))
    const images = out.filter(el => el.type === 'img')
    assert.equal(images.length, 1, 'the illustration must be an <img>, not its caption')
    assert.equal(images[0].props.src, 'data:image/svg+xml;base64,' + SVG)
    assert.equal(images[0].props.alt, 'NHD 与 HND 的页内布局对比')
    const reads = imageReads(calls)
    assert.equal(reads.length, 1, 'one read per illustration')
    assert.equal(reads[0].body.path, '/srv/app/img/kv-block-nhd-vs-hnd.svg', 'relative destinations resolve against the REMOTE document directory')
    assert.equal(reads[0].body.sessionId, 's-1', 'the read carries the tab session, so it binds to that session\'s machine')
  } finally { ui.dispose() }
})

test('source mode reads no illustrations at all', async () => {
  const text = '![a](img/a.svg)\n![b](img/b.png)\n'
  const { ui, calls } = mount({ text, images: () => ({ mime: 'image/svg+xml', content: SVG }) })
  try {
    const body = ui.body('dsh-remote/file')
    const tree = await ui.settleComponent(body, fileProps())
    await ui.tick(10)
    assert.equal(imageReads(calls).length, 0, 'a document opened as source must not cost SFTP reads for figures nobody draws')
    assert.equal(ui.elements(tree).some(el => el.props && typeof el.props.text === 'string'), false, 'source mode draws no markdown at all')
  } finally { ui.dispose() }
})

test('an unreadable figure stays the alt text, not a broken image', async () => {
  const text = '![缺失的插图](img/missing.svg)\n'
  const { ui } = mount({ text }) // every image read answers 404
  try {
    const out = ui.elements(markdownOutput(ui, await openPreview(ui)))
    assert.equal(out.some(el => el.type === 'img'), false, 'a failed read must not emit an <img> with a dead src')
    const alt = out.filter(el => el.props && el.props.className === 'md-image-alt')
    assert.equal(alt.length, 1)
    assert.equal(alt[0].props.children, '缺失的插图')
  } finally { ui.dispose() }
})

test('only image destinations are fetched; absolute links stay the renderer\'s job', async () => {
  const text = [
    '# Links',
    '',
    '![remote](https://example.com/cover.png)',
    '![local](img/figure.svg)',
    '',
    '[spec]: img/notes.txt',
    '[home]: https://example.com/',
  ].join('\n')
  const { ui, calls } = mount({
    text,
    images: (path) => path === '/srv/app/img/figure.svg' ? { mime: 'image/svg+xml', content: SVG } : undefined,
  })
  try {
    const out = ui.elements(markdownOutput(ui, await openPreview(ui)))
    const images = out.filter(el => el.type === 'img')
    assert.equal(images.length, 2, 'the absolute image and the local figure both render')
    assert.equal(images[0].props.src, 'https://example.com/cover.png', 'absolute HTTP(S) images are used as authored')
    assert.equal(images[1].props.src, 'data:image/svg+xml;base64,' + SVG)
    assert.deepEqual(imageReads(calls).map(c => c.body.path), ['/srv/app/img/figure.svg'], 'a non-image destination never costs a read')
  } finally { ui.dispose() }
})

test('percent escapes, query suffixes and .. segments resolve like the host does', async () => {
  const text = '![escaped](img/a%20b.png#frag)\n![up](../img/loss.png?raw=1)\n'
  const { ui, calls } = mount({
    text,
    images: (path) => path.endsWith('a b.png') || path.endsWith('loss.png') ? { mime: 'image/png', content: PNG } : undefined,
  })
  try {
    const out = ui.elements(markdownOutput(ui, await openPreview(ui)))
    assert.equal(out.filter(el => el.type === 'img').length, 2)
    assert.deepEqual(imageReads(calls).map(c => c.body.path).sort(), ['/srv/app/img/a b.png', '/srv/img/loss.png'])
  } finally { ui.dispose() }
})

test('a Windows remote document joins figures onto its drive path', async () => {
  const text = '![win](img/figure.png)\n'
  const { ui, calls } = mount({
    text,
    documentPath: 'D:\\proj\\docs\\README.md',
    images: (path) => /figure\.png$/i.test(path) ? { mime: 'image/png', content: PNG } : undefined,
  })
  try {
    const out = ui.elements(markdownOutput(ui, await openPreview(ui, 'D:\\proj\\docs\\README.md')))
    assert.equal(out.filter(el => el.type === 'img').length, 1)
    const reads = imageReads(calls)
    assert.equal(reads.length, 1)
    assert.ok(reads[0].body.path === 'D:\\proj\\docs\\img\\figure.png' || reads[0].body.path === 'D:\\proj\\docs\\img/figure.png',
      `expected a drive-rooted figure path, got ${reads[0].body.path}`)
  } finally { ui.dispose() }
})
