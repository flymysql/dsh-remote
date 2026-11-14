// Real native IDE UI, SSH, Agent, compiler and responsive header acceptance. Never edits a user profile.
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startDiskWorkspace } from '../../test/harness/disk-workspace.js'
const originalModules = process.env.IT_DSH_MODULES
if (!originalModules) throw new Error('Set IT_DSH_MODULES to an isolated DSH node_modules')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ide-web-e2e-'))
const artifacts = process.env.IT_IDE_ARTIFACTS || path.join(os.tmpdir(), 'dsh-ide-artifacts-' + randomUUID())
fs.mkdirSync(artifacts, { recursive: true })
let modules = path.resolve(originalModules)
if (process.env.IT_IDE_SOURCE === '1') {
  // Copy only the plugin's current runtime, sharing the fixture's already
  // installed peer tree. This does not alter the supplied installation.
  const overlay = path.join(home, 'source-host/node_modules')
  fs.mkdirSync(overlay, { recursive: true })
  for (const name of fs.readdirSync(modules)) if (name !== 'dsh-remote') fs.symlinkSync(path.join(modules, name), path.join(overlay, name))
  const plugin = path.join(overlay, 'dsh-remote'); fs.mkdirSync(plugin)
  fs.cpSync(path.join(repo, 'lib'), path.join(plugin, 'lib'), { recursive: true })
  if (process.env.IT_IDE_SNIPPET) {
    const clientPath = path.join(plugin, 'lib/client.js')
    let source = fs.readFileSync(clientPath, 'utf8')
    if (!source.includes('function installRemoteIde(ctx)')) source = source.replace('    function apply(ctx) {', fs.readFileSync(process.env.IT_IDE_SNIPPET, 'utf8') + '\n    function apply(ctx) {\n      installRemoteIde(ctx)')
    fs.writeFileSync(clientPath, source)
  }
  for (const name of ['package.json', 'cordis.patch.yml']) fs.copyFileSync(path.join(repo, name), path.join(plugin, name))
  if (fs.existsSync(path.join(modules, 'dsh-remote/node_modules'))) fs.symlinkSync(path.join(modules, 'dsh-remote/node_modules'), path.join(plugin, 'node_modules'))
  modules = overlay
}
const require = createRequire(path.join(modules, '__fixture__.cjs'))
const browserRequire = createRequire(path.join(process.env.IT_BROWSER_MODULES || modules, '__fixture__.cjs'))
const { chromium } = browserRequire('playwright-core')
const project = path.join(home, 'actual-remote')
const secondary = path.join(home, 'second-remote')
fs.mkdirSync(project + '/src', { recursive: true }); fs.mkdirSync(secondary)
const { broken, fixed } = await import('../../test/harness/agent-build-model.js')
fs.writeFileSync(project + '/src/main.c', broken)
fs.writeFileSync(project + '/notes.txt', 'REMOTE_NOTES\n')
fs.copyFileSync(path.join(repo, 'lib/workspace-search.js'), project + '/src/workspace-search.js')
fs.writeFileSync(secondary + '/second-only.txt', 'SECOND_REMOTE_ONLY\n')
const server = await startDiskWorkspace(project), secondServer = await startDiskWorkspace(secondary)
const nonce = randomUUID(), port = String(Number(process.env.IT_IDE_PORT || 50670)), base = 'http://127.0.0.1:' + port
fs.mkdirSync(home + '/profiles/web', { recursive: true })
for (const file of ['cordis.yml', 'cordis.patch.yml']) fs.writeFileSync(home + '/profiles/web/' + file, '[]\n')
fs.writeFileSync(home + '/profiles/web/package.json', JSON.stringify({ name: 'ide-workbench-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
fs.symlinkSync(modules, home + '/profiles/web/node_modules')
fs.writeFileSync(home + '/ssh_config', '')
const headerPlugin = path.join(home, 'ide-header-fixture')
fs.mkdirSync(headerPlugin)
fs.writeFileSync(path.join(headerPlugin, 'package.json'), JSON.stringify({ name: 'ide-header-fixture', version: '0.0.0', type: 'module', exports: { '.': './index.mjs', './client': './client.js' }, dsh: { client: { inject: ['@deepseek-ai/dsh-client-ui-renderer'], platform: 'web' } } }))
fs.writeFileSync(path.join(headerPlugin, 'index.mjs'), "export const name='ide-header-fixture'; export const inject=[]; export function apply(){}\n")
fs.copyFileSync(path.join(repo, 'scripts/manual/fixtures/ide-header-client.js'), path.join(headerPlugin, 'client.js'))
fs.writeFileSync(home + '/patch.yml', `- insert:\n    - id: dsh-remote\n      name: ${JSON.stringify(path.join(modules, 'dsh-remote/lib/boot.js'))}\n      config:\n        telemetry: false\n        updateMode: off\n    - id: ide-e2e\n      name: ${JSON.stringify(path.join(repo, 'scripts/manual/fixtures/ide-workbench-plugin.mjs'))}\n    - id: ide-header-fixture\n      name: ${JSON.stringify(path.join(headerPlugin, 'index.mjs'))}\n`)
const child = spawn(process.execPath, [path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'), 'web', '--patch', home + '/patch.yml', '--host', '127.0.0.1', '--port', port, '--no-open'], { cwd: home + '/profiles/web', env: { ...process.env, DSH_HOME: home, DSH_REMOTE_SSH_CONFIG: home + '/ssh_config', IT_DSH_MODULES: modules, DSH_E2E_PROJECT: project, DSH_IDE_E2E: '1', DSH_IDE_E2E_NONCE: nonce }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', browser
child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data)
try {
  for (let i = 0; i < 180 && !log.includes('dsh web:'); i++) { if (child.exitCode !== null) throw new Error('DSH exited before binding'); await new Promise(r => setTimeout(r, 100)) }
  const url = log.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\S*'))?.[0]
  assert.ok(url, 'DSH must start')
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1500, height: 1000 } }); page.setDefaultTimeout(12000)
  const servedProblems = []
  page.on('response', async response => { try { if (response.request().resourceType() === 'script') { const body = await response.text().catch(() => ''); if (body.includes("id: 'dsh-remote'")) { fs.writeFileSync(path.join(artifacts, 'served-client.js'), body); assert.ok(body.includes('function installRemoteIde(ctx)'), 'served client must contain IDE implementation'); const manifest = JSON.parse(fs.readFileSync(path.join(modules, 'dsh-remote/package.json'), 'utf8')); assert.ok(body.includes("const CLIENT_VERSION = '" + manifest.version + "'"), 'served client must match selected package version'); assert.ok(body.includes(fs.readFileSync(path.join(modules, 'dsh-remote/lib/client.js'), 'utf8')), 'served client bytes must match the selected package'); console.log('Served IDE client version:', manifest.version) } } } catch (error) { servedProblems.push(error.message) } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  for (const name of ['继续', '稍后配置']) await page.getByRole('button', { name, exact: true }).click({ timeout: 1000 }).catch(() => {})
  const intro = page.getByRole('dialog', { name: '开始使用', exact: true })
  if (await intro.waitFor({ timeout: 4000 }).then(() => true, () => false)) await intro.getByRole('button', { name: '关闭', exact: true }).click()
  const post = async (route, data) => {
    const response = await page.request.post(base + route, { data, headers: { 'x-dsh-ide-e2e': nonce } })
    if (!response.ok()) throw new Error((await response.text()).slice(0, 1000))
    return response.json()
  }
  const makeMirror = async (port, project, name) => {
    const result = await post('/dsh-remote/machines', { host: '127.0.0.1', port, username: 'root', password: 'test-only', backend: 'native', hostKeyMode: 'off', name })
    return post('/dsh-remote/mirror', { path: project, machineId: result.machine.id })
  }
  const mirror = await makeMirror(server.port, project, 'IDE primary'), secondMirror = await makeMirror(secondServer.port, secondary, 'IDE secondary')
  await post('/ide-e2e/create', { mirror: mirror.localMirror, secondMirror: secondMirror.localMirror })
  const selectSession = async sessionId => {
    await page.evaluate(sessionId => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId })), sessionId)
    await page.reload()
    await page.locator('[data-conversation-content][data-conversation-session="' + sessionId + '"]').waitFor()
  }
  await selectSession('ide-primary')
  // First entry has no user-opened file: show the plugin guide rather than
  // the host's generic Start tab, even if native auto-open created an explorer.
  await page.locator('[data-rw-ide-toggle]').click()
  const welcome = page.locator('[data-rw-ide-welcome]')
  const waitWelcomeLayout = () => page.waitForFunction(() => {
    const welcome = document.querySelector('[data-rw-ide-editor] [data-rw-ide-welcome]'), panel = welcome?.closest('[data-rw-ide-editor]'), seat = document.querySelector('[data-rw-ide-seat=editor]')
    if (!welcome || !panel || !seat) return false
    const w = welcome.getBoundingClientRect(), p = panel.getBoundingClientRect(), s = seat.getBoundingClientRect()
    return w.width > 100 && w.left >= p.left - 2 && w.right <= p.right + 2 && Math.abs(p.left - s.left) < 2 && Math.abs(p.width - s.width) < 2
  })
  await welcome.waitFor(); await waitWelcomeLayout()
  await page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: 'notes.txt' }).first().waitFor()
  assert.ok((await welcome.innerText()).trim().length > 25, 'initial IDE welcome must include useful instructions')
  await page.screenshot({ path: path.join(artifacts, 'ide-welcome.png') })
  await page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: 'notes.txt' }).first().click()
  await page.locator('[data-rw-ide-editor] [data-rw-file]').waitFor()
  await welcome.waitFor({ state: 'hidden' })
  await page.evaluate(() => window.__DSH_IDE_E2E__.closeDocuments('ide-primary'))
  await welcome.waitFor(); await waitWelcomeLayout()
  assert.equal(await page.locator('[data-rw-ide-editor] [data-rw-file]:visible').count(), 0)
  await page.screenshot({ path: path.join(artifacts, 'ide-welcome-after-close.png') })
  await post('/ide-e2e/stress-header', {})
  await page.locator('[data-rw-ide-chat]').getByText(/超长远程开发会话标题/).first().waitFor()
  const headerChecks = []
  const setChatWidth = async width => {
    const handle = page.locator('[data-rw-ide-divider="right"]')
    const box = await handle.boundingBox(), current = (await page.locator('[data-rw-ide-chat]').boundingBox()).width
    await page.mouse.move(box.x + box.width / 2, box.y + 100); await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + current - width, box.y + 100); await page.mouse.up()
    await page.waitForFunction(width => Math.abs(document.querySelector('[data-rw-ide-chat]').getBoundingClientRect().width - width) < 2, width)
  }
  const checkHeader = async (width, expanded = false) => {
    await setChatWidth(width)
    const chat = page.locator('[data-rw-ide-chat]')
    await chat.locator('[data-conversation-scroll]').evaluate(node => { node.scrollTop = 0 })
    await page.waitForTimeout(100)
    const result = await chat.evaluate(root => {
      const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
      const header = root.querySelector('header[data-window-drag]'), content = root.querySelector('[data-conversation-content]')
      const controls = [...header.querySelectorAll('button')].filter(node => { const r = node.getBoundingClientRect(), css = getComputedStyle(node); return r.width > 1 && r.height > 1 && css.visibility !== 'hidden' && css.display !== 'none' && css.opacity !== '0' }).map(node => ({ label: node.getAttribute('aria-label') || node.textContent.trim(), rect: rect(node) }))
      const overlaps = []
      for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) { const a = controls[i].rect, b = controls[j].rect; if (Math.min(a.right,b.right) - Math.max(a.left,b.left) > 2 && Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top) > 2) overlaps.push([controls[i].label,controls[j].label]) }
      const bounds = rect(root), outside = controls.filter(control => control.rect.left < bounds.left - 1 || control.rect.right > bounds.right + 1).map(control => control.label)
      return { width: bounds.width, header: rect(header), content: rect(content), controls, overlaps, outside, host: rect(header.querySelector('[data-dsh-remote-chip]')), agentButtons: header.querySelectorAll('[data-ide-e2e-header-control^="agent-"]').length }
    })
    result.toolsExpanded = expanded
    fs.writeFileSync(path.join(artifacts, 'ide-header-layout.json'), JSON.stringify([...headerChecks, result], null, 2))
    assert.equal(result.agentButtons, 2)
    assert.equal(result.controls.filter(control => /^Agent fixture/.test(control.label)).length, expanded ? 2 : 0, 'Agent extensions should follow the tools disclosure')
    assert.equal(result.controls.filter(control => /^Fixture /.test(control.label)).length, expanded ? 3 : 0, 'extra toolbar extensions should follow the tools disclosure')
    if (!expanded) { assert.ok(result.header.height <= 100, 'default IDE header must stay compact'); assert.equal(result.host.width, 0, 'host chip belongs to the collapsed tools disclosure') }
    else assert.ok(result.host.width > 0, 'host chip should be available after expanding tools')
    assert.deepEqual(result.overlaps, [], 'header buttons must not overlap at ' + width + 'px: ' + JSON.stringify(result))
    assert.deepEqual(result.outside, [], 'header controls must stay inside chat at ' + width + 'px: ' + JSON.stringify(result))
    assert.ok(result.content.top >= result.header.bottom - 1, 'native transcript must begin after the complete header at ' + width + 'px')
    const firstLine = chat.getByText('准备 IDE 验收。', { exact: true }).first()
    await firstLine.waitFor()
    const lineCheck = await firstLine.evaluate(node => {
      const root = node.closest('[data-rw-ide-chat]'), r = node.getBoundingClientRect(), header = root.querySelector('header[data-window-drag]').getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { top: r.top, bottom: r.bottom, headerBottom: header.bottom, hit: !!hit && (node.contains(hit) || hit.contains(node)), node: node.outerHTML.slice(0, 800), scrollTop: root.querySelector('[data-conversation-scroll]').scrollTop }
    })
    result.firstLine = lineCheck
    fs.writeFileSync(path.join(artifacts, 'ide-header-layout.json'), JSON.stringify([...headerChecks, result], null, 2))
    assert.ok(lineCheck.top >= lineCheck.headerBottom - 1, 'first transcript line must not hide under tabs at ' + width + 'px: ' + JSON.stringify(lineCheck))
    assert.equal(lineCheck.hit, true, 'first line must receive pointer hit testing')
    headerChecks.push(result)
    await page.screenshot({ path: path.join(artifacts, 'ide-header-' + (expanded ? 'expanded-' : 'collapsed-') + width + '.png') })
  }
  for (const width of [280, 360, 400]) await checkHeader(width)
  await page.locator('[data-rw-ide-tools-toggle]').click()
  for (const width of [280, 360, 400]) await checkHeader(width, true)
  await page.locator('[data-rw-ide-tools-toggle]').click()
  await page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: 'notes.txt' }).first().click()
  const file = page.locator('[data-rw-file]').filter({ hasText: 'notes.txt' })
  const editor = file.locator('textarea')
  await editor.fill('UNSAVED_IDE_DRAFT\n')
  await page.evaluate(() => {
    window.__ideNodes = { editor: document.querySelector('[data-rw-file] textarea'), chat: document.querySelector('[data-conversation-session="ide-primary"]').closest('[data-phase]') }
  })
  await post('/ide-e2e/run', {})
  await page.locator('[data-rw-ide-shell="ide-primary"]').waitFor()
  await page.locator('[data-rw-ide-chat]').waitFor()
  await page.locator('[data-rw-ide-editor]').waitFor()
  const rect = selector => page.locator(selector).boundingBox()
  const left = await rect('[data-rw-ide-tree]'), middle = await rect('[data-rw-ide-editor]'), right = await rect('[data-rw-ide-chat]')
  assert.ok(left.width >= 180 && middle.width >= 320 && right.width >= 280, JSON.stringify({ left, middle, right }))
  assert.ok(middle.x >= left.x + left.width && right.x >= middle.x + middle.width, JSON.stringify({ left, middle, right }))
  assert.equal(await page.locator('[data-conversation-content][data-conversation-session="ide-primary"]').count(), 1)
  assert.equal(await editor.inputValue(), 'UNSAVED_IDE_DRAFT\n')
  assert.equal(await page.evaluate(() => window.__ideNodes.editor === document.querySelector('[data-rw-file] textarea') && window.__ideNodes.chat === document.querySelector('[data-rw-ide-chat]')), true)
  let status
  for (let i = 0; i < 200; i++) { status = await post('/ide-e2e/status', {}); if (status.status === 'idle' && status.step === 6) break; await page.waitForTimeout(100) }
  assert.equal(status.step, 6); assert.equal(fs.readFileSync(project + '/src/main.c', 'utf8'), fixed)
  assert.ok(fs.existsSync(project + '/dist/app'))
  await page.locator('[data-rw-ide-chat]').getByText(/远端 GCC 编译通过/).waitFor()
  assert.equal(await editor.inputValue(), 'UNSAVED_IDE_DRAFT\n')
  for (const expanded of [false, true]) {
    if (expanded) await page.locator('[data-rw-ide-tools-toggle]').click()
    for (const width of [280, 360, 400]) { await checkHeader(width, expanded); assert.equal(await editor.inputValue(), 'UNSAVED_IDE_DRAFT\n'); assert.equal(await page.evaluate(() => window.__ideNodes.editor === document.querySelector('[data-rw-file] textarea') && window.__ideNodes.chat === document.querySelector('[data-rw-ide-chat]')), true) }
  }
  await page.locator('[data-rw-ide-tools-toggle]').click()
  fs.writeFileSync(path.join(artifacts, 'ide-header-layout.json'), JSON.stringify(headerChecks, null, 2))
  await page.waitForFunction(() => { const root = document.querySelector('[data-rw-ide-chat]'), composer = root?.querySelector('[data-composer-seat]'); return root && composer && Math.abs(root.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom) < 4 })
  await page.screenshot({ path: path.join(artifacts, 'ide-desktop.png') })
  fs.writeFileSync(path.join(artifacts, 'ide-layout.json'), JSON.stringify(await page.locator('[data-rw-ide-chat]').evaluate(root => [root, ...root.querySelectorAll('[data-slot],[data-conversation-content],[data-conversation-scroll],[data-composer-seat]')].map(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return { tag: node.tagName, class: node.className, slot: node.getAttribute('data-slot'), phase: node.getAttribute('data-phase'), contentPhase: node.getAttribute('data-content-phase'), composer: node.hasAttribute('data-composer-seat'), display: style.display, flex: style.flex, height: style.height, minHeight: style.minHeight, top: rect.top, bottom: rect.bottom } })), null, 2))
  // Portaled menus and dialogs must remain above both docked native roots.
  const modalSteps = []
  const modalSnapshot = async stage => { modalSteps.push({ stage, ...(await page.evaluate(() => ({ surface: window.__DSH_IDE_E2E__.snapshot('ide-primary'), focus: document.activeElement?.outerHTML.slice(0, 350), dialogs: [...document.querySelectorAll('[role=dialog]')].map(node => ({ title: node.getAttribute('aria-label'), text: node.textContent.slice(0, 300) })), file: [...document.querySelectorAll('[data-rw-file]')].map(node => node.getAttribute('data-rw-file')) }))) }); fs.writeFileSync(path.join(artifacts, 'ide-modal-diagnostics.json'), JSON.stringify(modalSteps, null, 2)) }
  await modalSnapshot('before-context')
  const notesRow = page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: 'notes.txt' })
  await notesRow.click({ button: 'right' })
  const contextMenu = page.getByRole('menu').last()
  await contextMenu.waitFor()
  assert.equal(await contextMenu.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(15, box.height / 2))) }), true)
  await page.keyboard.press('Escape'); await contextMenu.waitFor({ state: 'hidden' }); await modalSnapshot('after-context-escape'); await page.waitForFunction(() => !!document.activeElement?.closest('[data-rw-tree-row]'))
  await page.locator('[data-rw-ide-tree]').getByRole('button', { name: '新建目录', exact: true }).click()
  const prompt = page.getByRole('dialog', { name: '新建目录', exact: true })
  await prompt.waitFor(); await modalSnapshot('prompt-visible')
  assert.equal(await prompt.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) }), true)
  await modalSnapshot('before-prompt-cancel')
  await prompt.getByRole('button', { name: '取消', exact: true }).click()
  await prompt.waitFor({ state: 'hidden' })
  // Linux Web has no default settings chord in DSH. Invoke the existing
  // native launcher to verify an externally opened dialog while IDE stays on.
  await page.getByRole('button', { name: '账号菜单', exact: true }).evaluate(element => element.click())
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.waitFor()
  assert.equal(await settings.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) }), true)
  await page.screenshot({ path: path.join(artifacts, 'ide-settings.png') })
  await settings.getByRole('button', { name: '关闭', exact: true }).click()
  await settings.waitFor({ state: 'hidden' })
  assert.equal(await editor.inputValue(), 'UNSAVED_IDE_DRAFT\n')

  const handle = page.locator('[data-rw-ide-divider="left"]')
  await handle.focus(); await handle.press('ArrowRight')
  await page.waitForTimeout(100)
  assert.equal(Math.round((await rect('[data-rw-ide-tree]')).width), Math.round(left.width + 16))
  const separator = await handle.boundingBox()
  await page.mouse.move(separator.x + 3, separator.y + 100); await page.mouse.down(); await page.mouse.move(separator.x + 43, separator.y + 100); await page.mouse.up()
  await page.waitForTimeout(100)
  assert.equal(Math.round((await rect('[data-rw-ide-tree]')).width), Math.round(left.width + 56))
  await page.locator('[data-rw-ide-exit]').click()
  await page.locator('[data-rw-ide-shell]').waitFor({ state: 'detached' })
  assert.equal(await page.locator('[data-rw-ide-chat],[data-rw-ide-editor]').count(), 0)
  assert.equal(await editor.inputValue(), 'UNSAVED_IDE_DRAFT\n')
  assert.equal(await page.evaluate(() => window.__ideNodes.editor === document.querySelector('[data-rw-file] textarea') && window.__ideNodes.chat.isConnected), true)
  await page.locator('[data-rw-ide-toggle]').click()
  await page.setViewportSize({ width: 600, height: 900 })
  await page.getByRole('navigation', { name: 'IDE 模式', exact: true }).getByRole('button', { name: '会话', exact: true }).click()
  await page.waitForTimeout(100)
  assert.equal(await page.locator('[data-rw-ide-editor]').getAttribute('inert'), '')
  assert.ok((await rect('[data-rw-ide-chat]')).width >= 590)
  await page.getByRole('navigation', { name: 'IDE 模式', exact: true }).getByRole('button', { name: '编辑器', exact: true }).click()
  assert.equal(await editor.inputValue(), 'UNSAVED_IDE_DRAFT\n')
  assert.equal(await page.locator('[data-rw-ide-chat]').getAttribute('inert'), '')
  await page.screenshot({ path: path.join(artifacts, 'ide-mobile-editor.png') })
  await page.getByRole('navigation', { name: 'IDE 模式', exact: true }).getByRole('button', { name: '文件', exact: true }).click()
  await page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: 'notes.txt' }).click()
  await page.waitForTimeout(100)
  assert.equal(await editor.inputValue(), 'UNSAVED_IDE_DRAFT\n')
  await page.setViewportSize({ width: 1500, height: 1000 })
  const sourceFolder = page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: /^src$/ })
  if (await sourceFolder.getAttribute('aria-expanded') !== 'true') await sourceFolder.click()
  await page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: 'main.c' }).click()
  await page.locator('[data-rw-ide-editor] [data-rw-file]').filter({ hasText: 'main.c' }).getByText(/REMOTE_BUILD_OK/).first().waitFor()
  await page.waitForFunction(() => { const root = document.querySelector('[data-rw-ide-chat]'), composer = root?.querySelector('[data-composer-seat]'); return root && composer && Math.abs(root.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom) < 4 })
  await page.screenshot({ path: path.join(artifacts, 'ide-agent-c.png') })
  await page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: 'workspace-search.js' }).click()
  await page.locator('[data-rw-ide-editor] [data-rw-file]').filter({ hasText: 'workspace-search.js' }).getByText(/randomUUID/).first().waitFor()
  await page.waitForFunction(() => { const root = document.querySelector('[data-rw-ide-chat]'), input = root?.querySelector('[data-composer-input]'); return root && input && input.getBoundingClientRect().bottom > root.getBoundingClientRect().bottom - 180 })
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(artifacts, 'ide-code.png') })
  await selectSession('ide-secondary')
  await page.locator('[data-rw-ide-shell="ide-secondary"]').waitFor()
  await page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: 'second-only.txt' }).waitFor()
  assert.equal(await page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: 'notes.txt' }).count(), 0)
  await page.locator('[data-rw-ide-tree] [data-rw-tree-row]').filter({ hasText: 'second-only.txt' }).click()
  const secondEditor = page.locator('[data-rw-ide-editor] textarea')
  await secondEditor.waitFor(); assert.equal(await secondEditor.inputValue(), 'SECOND_REMOTE_ONLY\n')
  await selectSession('ide-local')
  assert.equal(await page.locator('[data-rw-ide-shell],[data-rw-ide-toggle]').count(), 0)
  assert.equal(await page.locator('[data-rw-ide-chat],[data-rw-ide-editor]').count(), 0)
  // Actual Agent-generated links must use the remote source. Explicitly seed
  // one legacy mirror-only artifact: this represents history from before the
  // native mutation gate, not a current Agent writing to the local filesystem.
  const legacyHtml = '<!doctype html>\n<html><body><h1>HISTORICAL_LOCAL_MIRROR_ONLY</h1></body></html>\n'
  fs.writeFileSync(path.join(mirror.localMirror, 'legacy-only.html'), legacyHtml)
  assert.equal(fs.existsSync(path.join(project, 'legacy-only.html')), false)
  await post('/ide-e2e/artifacts-start', { mirror: mirror.localMirror })
  let artifactStatus
  for (let i = 0; i < 150; i++) { artifactStatus = await post('/ide-e2e/artifacts-status', {}); if (artifactStatus.status === 'idle' && artifactStatus.step === 2) break; await page.waitForTimeout(100) }
  assert.equal(artifactStatus.step, 2)
  const generatedHtml = fs.readFileSync(path.join(project, 'generated.html'), 'utf8')
  assert.match(generatedHtml, /GENERATED_ON_REMOTE_SFTP/)
  fs.writeFileSync(path.join(mirror.localMirror, 'generated.html'), 'LOCAL_MIRROR_MUST_NOT_OPEN\n')
  await selectSession('ide-artifacts')
  const artifactChat = page.locator('[data-rw-ide-chat]')
  await artifactChat.getByText('generated.html', { exact: true }).last().click()
  const generatedFile = page.locator('[data-rw-ide-editor] [data-rw-file]').filter({ hasText: 'generated.html' })
  await generatedFile.locator('textarea').waitFor()
  assert.equal(await generatedFile.locator('textarea').inputValue(), generatedHtml)
  assert.doesNotMatch(await generatedFile.locator('textarea').inputValue(), /LOCAL_MIRROR_MUST_NOT_OPEN/)
  await page.screenshot({ path: path.join(artifacts, 'ide-agent-generated-html.png') })
  const missingRead = page.waitForResponse(response => new URL(response.url()).pathname === '/dsh-remote/read' && response.status() === 404)
  await artifactChat.getByText('legacy-only.html', { exact: true }).last().click()
  const missing = await (await missingRead).json()
  assert.equal(missing.code, 'REMOTE_FILE_MISSING_LOCAL_COPY')
  const legacyFile = page.locator('[data-rw-ide-editor] [data-rw-file]').filter({ hasText: 'legacy-only.html' })
  const recovery = legacyFile.locator('[data-rw-local-copy-recovery]')
  await recovery.waitFor()
  assert.equal(await legacyFile.locator('textarea:visible').count(), 0)
  await page.screenshot({ path: path.join(artifacts, 'ide-agent-local-missing.png') })
  const localRead = page.waitForResponse(response => new URL(response.url()).pathname === '/dsh-remote/local-copy/read')
  await recovery.getByRole('button', { name: '查看本地副本', exact: true }).click()
  const preview = await (await localRead).json()
  assert.match(preview.localRevision, /^[a-f0-9]{64}$/)
  await legacyFile.locator('[data-rw-local-copy-preview]').waitFor()
  assert.match(await legacyFile.locator('[data-rw-local-copy-preview]').innerText(), /HISTORICAL_LOCAL_MIRROR_ONLY/)
  assert.equal(await legacyFile.locator('textarea:visible').count(), 0)
  assert.equal(fs.existsSync(path.join(project, 'legacy-only.html')), false)
  await page.screenshot({ path: path.join(artifacts, 'ide-agent-local-readonly.png') })
  const publication = page.waitForResponse(response => new URL(response.url()).pathname === '/dsh-remote/local-copy/publish')
  await recovery.getByRole('button', { name: '上传到远端并打开', exact: true }).click()
  const published = await publication, publishedBody = published.request().postDataJSON()
  assert.equal(published.status(), 200)
  assert.equal(publishedBody.expectedLocalRevision, preview.localRevision)
  assert.equal(publishedBody.sessionId, 'ide-artifacts')
  await legacyFile.locator('textarea').waitFor()
  assert.equal(await legacyFile.locator('textarea').inputValue(), legacyHtml)
  assert.equal(fs.readFileSync(path.join(project, 'legacy-only.html'), 'utf8'), legacyHtml)
  assert.equal(await legacyFile.locator('[data-rw-local-copy-recovery]').count(), 0)
  await page.screenshot({ path: path.join(artifacts, 'ide-agent-local-published.png') })
  fs.writeFileSync(path.join(artifacts, 'agent-artifact-verification.json'), JSON.stringify({ actualAgentSteps: artifactStatus.step, tool: 'rw_write_file', generatedRemoteBytesVerified: true, conflictingMirrorIgnored: true, structuredMissingCode: missing.code, localPreviewReadOnly: true, publicationRevisionChecked: true, publishedRemoteBytesVerified: true, coreLinksClicked: ['generated.html', 'legacy-only.html'] }, null, 2))

  assert.deepEqual(errors, []); assert.deepEqual(servedProblems, [])
  fs.writeFileSync(path.join(artifacts, 'verification.json'), JSON.stringify({ dshVersion: require('@deepseek-ai/dsh/package.json').version, pluginVersion: JSON.parse(fs.readFileSync(path.join(modules, 'dsh-remote/package.json'), 'utf8')).version, packageMode: process.env.IT_IDE_SOURCE === '1' ? 'source-copy' : 'installed', modelMode: 'scripted model with actual SSH/SFTP and GCC process', actualAgentSteps: status.step, actualCompilerArtifact: true, initialAndLastClosedWelcome: true, responsiveHeaderWidths: [280,360,400], compactHeaderAndDisclosure: true, headerOverlapChecks: headerChecks.length, originalChatAndDraftRetained: true, widthAndNarrowPanes: true, remoteSessionIsolation: true, localFallback: true, menusAndDialogsOnTop: true, generatedCoreLinksAndLocalRecovery: true, pageErrors: errors }, null, 2))
  for (const obsolete of ['failure.png', 'ide-failure-state.json', 'ide-header-280.png', 'ide-header-360.png', 'ide-header-400.png']) fs.rmSync(path.join(artifacts, obsolete), { force: true })
  console.log('PASS IDE: actual Agent/GCC task survives switches; one original chat; original native editor and unsaved draft preserved; 3 columns; keyboard/drag persisted width; narrow panes; remote-session identity; local fallback; native menus/settings/dialogs above the IDE; actual Agent core links and explicit local-mirror recovery.')
  console.log('Artifacts:', artifacts)
} catch (error) {
  if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }); fs.writeFileSync(path.join(artifacts, 'ide-failure-state.json'), JSON.stringify(await page.evaluate(() => ({ surface: window.__DSH_IDE_E2E__?.snapshot('ide-primary'), focus: document.activeElement?.outerHTML.slice(0,350), dialogs: [...document.querySelectorAll('[role=dialog]')].map(node=>node.textContent.slice(0,300)), files: [...document.querySelectorAll('[data-rw-file]')].map(node=>node.getAttribute('data-rw-file')) })), null, 2)); console.error((await page.locator('body').innerText()).slice(-2500)) } }
  console.error(log.replace(/https?:\/\/\S+/g, '[local URL]')); throw error
} finally {
  if (browser) await browser.close()
  child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r))
  await server.close(); await secondServer.close(); if (process.env.IT_IDE_KEEP !== '1') fs.rmSync(home, { recursive: true, force: true }); else console.log('Fixture preserved:', home)
}
