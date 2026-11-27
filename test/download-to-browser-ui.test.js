import test from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

const filePath = '/workspace/报告 & 100%.bin'
const sessionId = 'session /&?'

async function openFile(t, baseURI, { local = false, error = false } = {}) {
  const location = new URL(baseURI)
  const requests = [], clicks = [], appended = []
  const { promise: body, resolve: finish } = Promise.withResolvers()
  let blobReads = 0
  const ui = mountClient({
    languages: ['en'],
    location,
    document: {
      baseURI,
      body: { appendChild: (node) => appended.push(node) },
      createElement: (tag) => {
        const element = { style: {}, remove() { appended.splice(appended.indexOf(this), 1) } }
        if (tag === 'a') element.click = function () {
          assert.ok(appended.includes(this), 'download links must be attached when clicked')
          clicks.push({ href: this.href, target: this.target, rel: this.rel, download: this.download })
        }
        return element
      },
    },
    services: local ? { sessions: { list: { getSnapshot: () => ({ byId: { [sessionId]: { cwd: '/workspace' } } }) } } } : {},
    fetch: async (url, options) => {
      if (url.includes('/dsh-remote/download?')) {
        requests.push({ url, options })
        if (error) return { ok: false, status: 404, json: async () => ({ error: 'Fixture file is gone' }) }
        return {
          ok: true,
          headers: new Headers({ 'X-Dsh-Download-Name': encodeURIComponent('实际文件名.bin') }),
          blob() { blobReads++; return body },
        }
      }
      const data = url.includes('/dsh-remote/bindings') ? { mirrors: [] } : { content: 'fixture' }
      return { ok: true, status: 200, json: async () => data }
    },
  })
  t.after(async () => { finish(new Blob()); await ui.tick(); ui.timers.flush(1000); ui.dispose() })
  const props = {
    sessionId,
    useTabInfo: () => ({ tab: { visible: true, navigation: { address: 'dsh-resource://dsh-remote/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(filePath) } } }),
  }
  const render = () => ui.settleComponent(ui.body('dsh-remote/file'), props)
  const download = (tree) => {
    const action = ui.components(tree).find((c) => c.type.name === 'WorkbenchAction' && c.props.icon === 'download')
    assert.ok(action, 'the file pane must expose the download action')
    return action.props
  }
  const tree = await render()
  assert.equal(download(tree).disabled, false)
  return { ui, render, download, tree, requests, clicks, finish, blobReads: () => blobReads }
}

for (const [baseURI, mount, local] of [
  ['http://dsh.test/', '/', false],
  ['https://dsh.test/app/Harness/dsh/', '/app/Harness/dsh/', true],
]) {
  test('downloads at ' + baseURI + ' navigate synchronously before receiving bytes', async (t) => {
    const fixture = await openFile(t, baseURI, { local })
    fixture.download(fixture.tree).onClick()
    assert.equal(fixture.clicks.length, 1, 'navigation must start in the click handler while the body is pending')
    const [click] = fixture.clicks
    const origin = new URL(baseURI).origin
    assert.equal(click.href, origin + mount + 'dsh-remote/download?path=' + encodeURIComponent(filePath)
      + '&sessionId=' + encodeURIComponent(sessionId) + (local ? '&workspace=local' : ''))
    assert.equal(click.target, '_blank', 'HTTP errors must open away from the workspace')
    assert.equal(click.rel, 'noopener')
    assert.equal(click.download, undefined, 'the response decides whether this is an attachment')
    assert.deepEqual(fixture.requests, [], 'HTTP downloads must not fetch the file in the page')
    await fixture.ui.tick()
    const tree = await fixture.render()
    assert.equal(fixture.download(tree).disabled, false)
    assert.doesNotMatch(fixture.ui.text(tree), /Download started on this computer/)
  })
}

test('dsh-app waits for its Blob and uses the server-provided filename', async (t) => {
  const fixture = await openFile(t, 'dsh-app://app/index.html')
  fixture.download(fixture.tree).onClick()
  await fixture.ui.tick()
  assert.deepEqual(fixture.requests, [{
    url: '/api/dsh-remote/download?path=' + encodeURIComponent(filePath) + '&sessionId=' + encodeURIComponent(sessionId),
    options: { credentials: 'same-origin' },
  }])
  assert.equal(fixture.blobReads(), 1)
  assert.deepEqual(fixture.clicks, [], 'the desktop carrier still waits for the full Blob')
  assert.equal(fixture.download(await fixture.render()).disabled, true)
  fixture.finish(new Blob(['fixture file']))
  await fixture.ui.tick()
  assert.equal(fixture.clicks.length, 1)
  assert.match(fixture.clicks[0].href, /^blob:/)
  assert.equal(fixture.clicks[0].download, '实际文件名.bin')
  assert.match(fixture.ui.text(await fixture.render()), /Download started on this computer/)
})

test('dsh-app displays the server error without clicking a Blob link', async (t) => {
  const fixture = await openFile(t, 'dsh-app://app/index.html', { error: true })
  fixture.download(fixture.tree).onClick()
  await fixture.ui.tick()
  const tree = await fixture.render()
  assert.match(fixture.ui.text(tree), /Fixture file is gone/)
  assert.equal(fixture.download(tree).disabled, false)
  assert.deepEqual(fixture.clicks, [])
  assert.equal(fixture.blobReads(), 0)
})
