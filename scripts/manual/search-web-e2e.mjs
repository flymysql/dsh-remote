// Real native remote search UI and recursive SFTP acceptance. Never edits a user profile.
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-search-web-e2e-'))
const artifacts = process.env.IT_SEARCH_ARTIFACTS || path.join(os.tmpdir(), 'dsh-search-artifacts-' + randomUUID())
fs.mkdirSync(artifacts, { recursive: true })
let modules = path.resolve(originalModules)
if (process.env.IT_SEARCH_SOURCE === '1') {
  // Copy only the plugin's current runtime, sharing the fixture's already
  // installed peer tree. This does not alter the supplied installation.
  const overlay = path.join(home, 'source-host/node_modules')
  fs.mkdirSync(overlay, { recursive: true })
  for (const name of fs.readdirSync(modules)) if (name !== 'dsh-remote') fs.symlinkSync(path.join(modules, name), path.join(overlay, name))
  const plugin = path.join(overlay, 'dsh-remote'); fs.mkdirSync(plugin)
  fs.cpSync(path.join(repo, 'lib'), path.join(plugin, 'lib'), { recursive: true })
  for (const name of ['package.json', 'cordis.patch.yml']) fs.copyFileSync(path.join(repo, name), path.join(plugin, name))
  if (fs.existsSync(path.join(modules, 'dsh-remote/node_modules'))) fs.symlinkSync(path.join(modules, 'dsh-remote/node_modules'), path.join(plugin, 'node_modules'))
  modules = overlay
}
const require = createRequire(path.join(modules, '__fixture__.cjs'))
const browserRequire = createRequire(path.join(process.env.IT_BROWSER_MODULES || modules, '__fixture__.cjs'))
const { chromium } = browserRequire('playwright-core')
const project = path.join(home, 'actual-remote')
fs.mkdirSync(project)
const targetRelative = 'src/deep/block-target.txt'
const target = path.join(project, targetRelative)
const directoryRelative = 'src/deep/block-directory'
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.mkdirSync(path.join(project, directoryRelative))
fs.writeFileSync(target, 'first line\nsecond line\nSEARCH_REMOTE_SENTINEL in actual remote file\nlast line\n')
fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true })
fs.writeFileSync(path.join(project, 'node_modules/block-ignored.txt'), 'ignored fixture\n')
// Actual unopened directories force recursive SFTP traversal; these are never
// populated into the native tree or its mirror before search starts.
for (let i = 0; i < 64; i++) {
  const folder = path.join(project, 'filler-' + String(i).padStart(3, '0'))
  fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'sample.txt'), 'ordinary remote fixture\n')
}
const server = await startDiskWorkspace(project)
const nonce = randomUUID(), port = String(Number(process.env.IT_SEARCH_PORT || 50686)), base = 'http://127.0.0.1:' + port
fs.mkdirSync(home + '/profiles/web', { recursive: true })
for (const file of ['cordis.yml', 'cordis.patch.yml']) fs.writeFileSync(home + '/profiles/web/' + file, '[]\n')
fs.writeFileSync(home + '/profiles/web/package.json', JSON.stringify({ name: 'search-workspace-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
fs.symlinkSync(modules, home + '/profiles/web/node_modules')
fs.writeFileSync(home + '/ssh_config', '')
fs.writeFileSync(home + '/patch.yml', `- insert:\n    - id: dsh-remote\n      name: ${JSON.stringify(path.join(modules, 'dsh-remote/lib/boot.js'))}\n      config:\n        telemetry: false\n        updateMode: off\n    - id: search-e2e\n      name: ${JSON.stringify(path.join(repo, 'scripts/manual/fixtures/search-workspace-plugin.mjs'))}\n`)
const child = spawn(process.execPath, [path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'), 'web', '--patch', home + '/patch.yml', '--host', '127.0.0.1', '--port', port, '--no-open'], { cwd: home + '/profiles/web', env: { ...process.env, DSH_HOME: home, DSH_REMOTE_SSH_CONFIG: home + '/ssh_config', IT_DSH_MODULES: modules, DSH_SEARCH_E2E: '1', DSH_SEARCH_E2E_NONCE: nonce }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', browser
child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data)
try {
  for (let i = 0; i < 180 && !log.includes('dsh web:'); i++) { if (child.exitCode !== null) throw new Error('DSH exited before binding'); await new Promise(r => setTimeout(r, 100)) }
  const url = log.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\S*'))?.[0]
  assert.ok(url, 'DSH must start')
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1500, height: 1050 } }); page.setDefaultTimeout(12000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  for (const name of ['继续', '稍后配置']) await page.getByRole('button', { name, exact: true }).click({ timeout: 1000 }).catch(() => {})
  const intro = page.getByRole('dialog', { name: '开始使用', exact: true })
  if (await intro.waitFor({ timeout: 4000 }).then(() => true, () => false)) await intro.getByRole('button', { name: '关闭', exact: true }).click()
  const post = async (route, data) => {
    const r = await page.request.post(base + route, { data, headers: { 'x-dsh-search-e2e': nonce } })
    if (!r.ok()) throw new Error((await r.text()).slice(0, 1000))
    return r.json()
  }
  const machine = await post('/dsh-remote/machines', { host: '127.0.0.1', port: server.port, username: 'root', password: 'test-only', backend: 'native', hostKeyMode: 'off', name: 'Search fixture' })
  const mirror = await post('/dsh-remote/mirror', { path: project, machineId: machine.machine.id })
  assert.equal(fs.existsSync(path.join(mirror.localMirror, targetRelative)), false)
  await post('/search-e2e/create-session', { mirror: mirror.localMirror })
  await page.evaluate(() => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'remote-search-e2e' })))
  await page.reload(); await page.locator('p').filter({ hasText: '远程搜索检查会话已就绪。' }).first().waitFor()
  await page.getByRole('button', { name: '新标签页', exact: true }).last().click()
  await page.getByRole('button', { name: /^工作区文件/ }).first().click()
  await page.locator('[data-rw-tree-row]').filter({ hasText: 'src' }).first().waitFor()
  assert.equal(await page.locator(`[data-rw-tree-row="${target}"]`).count(), 0, 'nested target was never loaded into the tree')
  const jobs = [], scans = []
  page.on('response', async response => {
    if (!response.url().includes('/dsh-remote/search') || !response.ok()) return
    const payload = await response.json().catch(() => null)
    if (payload?.search) { scans.push(payload.search); if (response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'start') jobs.push({ ...payload.search, requestOptions: response.request().postDataJSON() }) }
  })
  await page.getByRole('button', { name: '搜索远程工作区', exact: true }).click()
  const query = page.getByRole('searchbox', { name: '搜索远程工作区', exact: true })
  const scope = page.getByRole('combobox', { name: '搜索范围', exact: true })
  const pane = page.locator('.dsh-rw-search-panel')
  const options = page.locator('.dsh-rw-search-options')
  const toggleOptions = () => options.locator('summary').click()
  const caseSensitive = options.getByRole('checkbox', { name: '区分大小写', exact: true })
  const includeIgnored = options.getByRole('checkbox', { name: '包含忽略目录', exact: true })
  assert.equal(await options.getAttribute('open'), null)
  assert.equal(await caseSensitive.isVisible(), false, 'advanced options are hidden by default')
  await toggleOptions(); await caseSensitive.check(); await caseSensitive.uncheck()
  await includeIgnored.check(); await includeIgnored.uncheck()
  await page.screenshot({ path: path.join(artifacts, 'search-options.png') })
  await toggleOptions()
  assert.equal(await page.getByText(/^镜像同步/).count(), 0, 'the live remote explorer carries no mirror-sync noise')
  const completed = async () => { await pane.getByText('搜索完成', { exact: true }).waitFor({ timeout: 30000 }) }
  await query.fill('block')
  await pane.getByText('准备搜索…', { exact: true }).waitFor()
  await pane.getByText('正在搜索…', { exact: true }).waitFor()
  await page.waitForFunction(() => /已扫描 [1-9]\d* 项/.test(document.querySelector('.dsh-rw-search-panel summary')?.innerText || ''))
  assert.equal(await pane.locator('details').getAttribute('open'), null)
  assert.equal(await page.getByRole('button', { name: '新建目录', exact: true }).isVisible(), false)
  await page.screenshot({ path: path.join(artifacts, 'search-progress.png') })
  await pane.locator('summary[aria-label="扫描详情"]').click()
  await pane.getByText(/[1-9]\d* 个目录 · \d+ 个文件/).waitFor()
  await page.screenshot({ path: path.join(artifacts, 'search-details.png') })
  await pane.locator('summary[aria-label="扫描详情"]').click()
  await completed()
  await pane.locator(`[data-rw-search-result="${targetRelative}"]`).waitFor()
  await pane.locator(`[data-rw-search-result="${directoryRelative}"]`).waitFor()
  assert.equal(await pane.locator('[data-rw-search-result="node_modules/block-ignored.txt"]').count(), 0)
  await page.screenshot({ path: path.join(artifacts, 'search-results.png') })
  const names = await pane.locator('[data-rw-search-result]').count()
  assert.equal(names, 2)
  await toggleOptions(); await includeIgnored.check(); await toggleOptions(); await completed()
  await pane.locator('[data-rw-search-result="node_modules/block-ignored.txt"]').waitFor()
  assert.equal(await pane.locator('[data-rw-search-result]').count(), 3)
  await toggleOptions(); await includeIgnored.uncheck(); await toggleOptions()
  await scope.selectOption('files'); await completed()
  assert.equal(await pane.locator('[data-rw-search-result]').count(), 1)
  await pane.locator(`[data-rw-search-result="${targetRelative}"]`).waitFor()
  await scope.selectOption('directories'); await completed()
  assert.equal(await pane.locator('[data-rw-search-result]').count(), 1)
  await pane.locator(`[data-rw-search-result="${directoryRelative}"]`).click()
  await page.locator(`[data-rw-tree-row="${path.join(project, directoryRelative)}"]`).waitFor()
  assert.equal(await page.locator(`[data-rw-tree-row="${path.join(project, 'src/deep')}"]`).getAttribute('aria-expanded'), 'true')
  await page.getByRole('button', { name: '搜索远程工作区', exact: true }).click()
  await scope.selectOption('content'); await query.fill('SEARCH_REMOTE_SENTINEL'); await completed()
  const contentRow = pane.locator(`[data-rw-search-result="${targetRelative}"]`)
  await contentRow.getByText('第 3 行', { exact: true }).waitFor()
  await contentRow.click()
  const file = page.locator('[data-rw-file]')
  await file.locator('[data-line="3"]').waitFor()
  assert.equal(await file.locator('[data-line="3"]').evaluate(element => element.classList.contains('dsh-rw-line-flash')), true)
  assert.match(await file.innerText(), /SEARCH_REMOTE_SENTINEL in actual remote file/)
  assert.equal(fs.existsSync(path.join(mirror.localMirror, targetRelative)), false, 'remote search and file opening do not require mirror hydration')
  await page.screenshot({ path: path.join(artifacts, 'search-file-line.png') })
  await file.getByRole('button', { name: '返回文件树', exact: true }).click()
  await page.getByRole('button', { name: '搜索远程工作区', exact: true }).click()
  await scope.selectOption('names'); await query.fill('cancel-this-query')
  await pane.getByText('正在搜索…', { exact: true }).waitFor()
  await page.waitForFunction(() => /已扫描 [1-9]\d* 项/.test(document.querySelector('.dsh-rw-search-panel summary')?.innerText || ''))
  const cancelDone = page.waitForResponse(response => response.url().includes('/dsh-remote/search') && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'cancel' && response.ok())
  await pane.getByRole('button', { name: '停止', exact: true }).click()
  await cancelDone
  await pane.getByText('搜索已停止', { exact: true }).waitFor()
  const cancelled = jobs.findLast(job => job.query === 'cancel-this-query')
  assert.ok(cancelled)
  const cancelResponse = await page.request.get(base + '/dsh-remote/search?id=' + cancelled.id + '&sessionId=remote-search-e2e')
  assert.equal((await cancelResponse.json()).search.status, 'cancelled')
  await toggleOptions(); await caseSensitive.check(); await query.fill('BLOCK'); await toggleOptions(); await completed()
  await pane.getByText('未找到匹配项。可切换搜索范围，或包含忽略目录后重试。', { exact: true }).waitFor()
  await toggleOptions(); await caseSensitive.uncheck(); await query.fill('block'); await toggleOptions(); await scope.selectOption('names'); await completed()
  await page.setViewportSize({ width: 390, height: 844 })
  await pane.locator(`[data-rw-search-result="${targetRelative}"]`).waitFor()
  const dimensions = await pane.evaluate(element => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth, client: element.clientWidth }))
  assert.ok(dimensions.width > 250 && dimensions.scroll <= dimensions.client + 1)
  await page.screenshot({ path: path.join(artifacts, 'search-mobile.png') })
  assert.ok(scans.some(job => job.status === 'running' && job.scannedDirs > 0), 'actual backend emitted incremental counts during remote traversal')
  assert.ok(jobs.some(job => job.requestOptions.includeIgnored === true), 'expanded ignore control reaches the real backend')
  assert.ok(jobs.some(job => job.query === 'BLOCK' && job.requestOptions.caseSensitive === true), 'expanded case control reaches the real backend')
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(artifacts, 'search-evidence.json'), JSON.stringify({ names, unopenedTarget: targetRelative, cancelled: true, line: 3, mobile: dimensions, scans: scans.map(({ query, mode, status, scannedDirs, scannedFiles, elapsedMs, results }) => ({ query, mode, status, scannedDirs, scannedFiles, elapsedMs, results: results.length })) }, null, 2))
  fs.rmSync(path.join(artifacts, 'failure.png'), { force: true })
  console.log('PASS real DSH remote search: unopened recursive files/directories, filters, incremental SFTP progress, directory reveal, file line navigation, cancellation, empty results and mobile layout.')
  console.log('Artifacts:', artifacts)
} catch (error) {
  if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }); console.error((await page.locator('body').innerText()).slice(-2500)) } }
  console.error(log.replace(/https?:\/\/\S+/g, '[local URL]')); throw error
} finally {
  if (browser) await browser.close()
  child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r))
  await server.close(); fs.rmSync(home, { recursive: true, force: true })
}
