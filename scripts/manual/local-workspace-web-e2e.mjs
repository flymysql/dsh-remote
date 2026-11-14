// Actual DSH Web + browser + native Agent tools + GCC + local PTY acceptance.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
const repo = fileURLToPath(new URL('../../', import.meta.url))
if (!process.env.IT_DSH_MODULES) throw new Error('Set IT_DSH_MODULES to a disposable DSH installation')
const original = path.resolve(process.env.IT_DSH_MODULES), home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-web-'))
const artifacts = process.env.IT_LOCAL_ARTIFACTS || path.join(os.tmpdir(), 'dsh-local-artifacts-' + randomUUID())
fs.mkdirSync(artifacts, { recursive: true })
const modules = process.env.IT_LOCAL_SOURCE === '0' ? original : path.join(home, 'source/node_modules')
const plugin = path.join(modules, 'dsh-remote')
if (modules !== original) {
  fs.mkdirSync(modules, { recursive: true })
  for (const name of fs.readdirSync(original)) if (name !== 'dsh-remote') fs.symlinkSync(path.join(original, name), path.join(modules, name))
  fs.mkdirSync(plugin)
  fs.cpSync(path.join(repo, 'lib'), path.join(plugin, 'lib'), { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml']) fs.copyFileSync(path.join(repo, file), path.join(plugin, file))
  if (fs.existsSync(path.join(original, 'dsh-remote/node_modules'))) fs.symlinkSync(path.join(original, 'dsh-remote/node_modules'), path.join(plugin, 'node_modules'))
}
const require = createRequire(path.join(modules, '__fixture__.cjs'))
const { chromium } = createRequire(path.join(process.env.IT_BROWSER_MODULES || modules, '__fixture__.cjs'))('playwright-core')
const project = path.join(home, 'project'), secondary = path.join(home, 'secondary')
fs.mkdirSync(project + '/nested', { recursive: true }); fs.mkdirSync(secondary)
fs.writeFileSync(project + '/notes.js', 'const localValue = 1;\r\n')
fs.writeFileSync(project + '/nested/find-me.txt', 'local search needle\n')
fs.writeFileSync(secondary + '/second-only.txt', 'SECOND_LOCAL_ONLY\n')
for (const args of [['init', '-q'], ['config', 'user.name', 'Acceptance'], ['config', 'user.email', 'test@example.invalid'], ['config', 'core.autocrlf', 'false'], ['add', '.'], ['commit', '-qm', 'initial']]) execFileSync('git', ['-C', project, ...args])
fs.mkdirSync(home + '/profiles/web', { recursive: true })
for (const file of ['cordis.yml', 'cordis.patch.yml']) fs.writeFileSync(home + '/profiles/web/' + file, '[]\n')
fs.writeFileSync(home + '/profiles/web/package.json', JSON.stringify({ name: 'local-workbench-web-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
fs.symlinkSync(modules, home + '/profiles/web/node_modules'); fs.writeFileSync(home + '/ssh_config', '')
fs.writeFileSync(home + '/patch.yml', `- insert:\n    - id: dsh-remote\n      name: ${JSON.stringify(path.join(plugin, 'lib/boot.js'))}\n      config:\n        telemetry: false\n        updateMode: off\n    - id: local-workbench-e2e\n      name: ${JSON.stringify(path.join(repo, 'scripts/manual/fixtures/local-workbench-plugin.mjs'))}\n`)
const nonce = randomUUID(), port = Number(process.env.IT_LOCAL_PORT || 50682), base = 'http://127.0.0.1:' + port
const child = spawn(process.execPath, [path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'), 'web', '--patch', home + '/patch.yml', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { cwd: home + '/profiles/web', env: { ...process.env, DSH_HOME: home, DSH_REMOTE_SSH_CONFIG: home + '/ssh_config', IT_DSH_MODULES: modules, DSH_E2E_PROJECT: project, DSH_E2E_SECONDARY: secondary, DSH_LOCAL_E2E: '1', DSH_LOCAL_E2E_NONCE: nonce }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', browser, page
child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
try {
  for (let i = 0; i < 200 && !log.includes('dsh web:'); i++) { if (child.exitCode != null) throw new Error('DSH exited before binding'); await new Promise(r => setTimeout(r, 100)) }
  const url = log.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\S*'))?.[0]; assert.ok(url, 'DSH must start')
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, locale: 'zh-CN' }); page.setDefaultTimeout(15000)
  const errors = [], reads = []; page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.url().includes('/dsh-remote/read')) reads.push(response.request().postDataJSON()) })
  await page.goto(url)
  for (const name of ['继续', '稍后配置']) await page.getByRole('button', { name, exact: true }).click({ timeout: 1000 }).catch(() => {})
  const intro = page.getByRole('dialog', { name: '开始使用', exact: true })
  if (await intro.waitFor({ timeout: 3000 }).then(() => true, () => false)) await intro.getByRole('button', { name: '关闭', exact: true }).click()
  const post = async route => { const r = await page.request.post(base + '/local-workbench-e2e/' + route, { headers: { 'x-dsh-local-e2e': nonce } }); if (!r.ok()) throw new Error((await r.text()).slice(0, 1000)); return r.json() }
  await post('create')
  const select = async id => { await page.evaluate(id => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })), id); await page.reload(); await page.locator('[data-conversation-content][data-conversation-session="' + id + '"]').waitFor() }
  await select('local-primary')
  await page.locator('[data-rw-ide-toggle]').click()
  await page.locator('[data-rw-ide-shell="local-primary"]').waitFor()
  await page.locator('[data-rw-ide-welcome]').getByText('本地开发工作区', { exact: true }).waitFor()
  const tree = page.locator('[data-rw-ide-tree]'), editor = page.locator('[data-rw-ide-editor]')
  await tree.locator('[data-rw-tree-row]').filter({ hasText: 'notes.js' }).click()
  const input = editor.locator('textarea:visible'); await input.waitFor()
  assert.equal(await input.inputValue(), 'const localValue = 1;\n')
  await input.fill('const localValue = 2;\n'); await input.press('Control+s')
  await page.waitForFunction(async ({ base, file }) => (await (await fetch(base + '/dsh-remote/read?sessionId=local-primary&workspace=local&path=' + encodeURIComponent(file))).json()).content === 'const localValue = 2;\n', { base, file: project + '/notes.js' })
  assert.equal(fs.readFileSync(project + '/notes.js', 'utf8'), 'const localValue = 2;\r\n')
  assert.ok(await editor.locator('[data-rw-highlight-editor] span[style*="color"]').count(), 'real code highlighting must remain visible')
  await tree.getByRole('button', { name: '搜索本地工作区', exact: true }).click()
  await tree.locator('input[type=search]').fill('find-me')
  await tree.locator('[data-rw-search-result]').filter({ hasText: 'find-me.txt' }).waitFor()
  await tree.locator('[data-rw-search-result]').filter({ hasText: 'find-me.txt' }).click()
  await editor.locator('textarea:visible').waitFor(); assert.equal(await editor.locator('textarea:visible').inputValue(), 'local search needle\n')
  await page.screenshot({ path: path.join(artifacts, 'local-search.png') })
  await post('run')
  let status
  for (let i = 0; i < 250; i++) { status = await (await page.request.get(base + '/local-workbench-e2e/status', { headers: { 'x-dsh-local-e2e': nonce } })).json(); if (status.step >= 6 && status.status === 'idle') break; await page.waitForTimeout(100) }
  fs.writeFileSync(path.join(artifacts, 'agent-events.json'), JSON.stringify(status, null, 2))
  assert.equal(status.step, 6, 'native local Agent must complete write/build/edit/build steps'); assert.equal(status.status, 'idle')
  assert.equal(execFileSync(project + '/dist/app', { encoding: 'utf8' }), 'LOCAL_BUILD_OK\n')
  const chat = page.locator('[data-rw-ide-chat]')
  await chat.getByText('生成页面', { exact: true }).last().click()
  await editor.locator('textarea:visible').waitFor(); assert.match(await editor.locator('textarea:visible').inputValue(), /LOCAL_AGENT_GENERATED/)
  assert.ok(reads.some(r => r?.workspace === 'local' && r.sessionId === 'local-primary' && /generated.html$/.test(r.path)))
  await page.screenshot({ path: path.join(artifacts, 'local-ide-agent.png') })
  const git = await (await page.request.get(base + '/dsh-remote/git?workspace=local&sessionId=local-primary')).json()
  assert.equal(git.available, true); assert.ok(git.files.some(f => f.path === 'notes.js'))
  await tree.getByRole('button', { name: '本地 Git 改动', exact: true }).click()
  await editor.locator('[data-rw-git-file="notes.js"]').click()
  await editor.getByRole('region', { name: '本地文件差异', exact: true }).waitFor()
  await page.screenshot({ path: path.join(artifacts, 'local-git.png') })
  await tree.getByRole('button', { name: '打开本地终端', exact: true }).click()
  const terminal = page.locator('.xterm').last(); await terminal.waitFor(); await terminal.click()
  await page.keyboard.type("printf 'LOCAL_PTY_OK\\n' > local-terminal-marker.txt; cat local-terminal-marker.txt", { delay: 2 }); await page.keyboard.press('Enter')
  for (let i = 0; i < 100 && !fs.existsSync(project + '/local-terminal-marker.txt'); i++) await page.waitForTimeout(100)
  assert.equal(fs.readFileSync(project + '/local-terminal-marker.txt', 'utf8'), 'LOCAL_PTY_OK\n')
  await terminal.locator('.xterm-rows').getByText('LOCAL_PTY_OK', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(artifacts, 'local-terminal.png') })
  await select('local-secondary'); await page.locator('[data-rw-ide-shell="local-secondary"]').waitFor()
  await tree.locator('[data-rw-tree-row]').filter({ hasText: 'second-only.txt' }).waitFor()
  assert.equal(await tree.locator('[data-rw-tree-row]').filter({ hasText: 'notes.js' }).count(), 0)
  await tree.locator('[data-rw-tree-row]').filter({ hasText: 'second-only.txt' }).click()
  assert.equal(await editor.locator('textarea:visible').inputValue(), 'SECOND_LOCAL_ONLY\n')
  await page.setViewportSize({ width: 650, height: 850 }); await page.getByRole('button', { name: '文件', exact: true }).click(); await tree.locator('[data-rw-tree-row]').filter({ hasText: 'second-only.txt' }).waitFor()
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(artifacts, 'verification.json'), JSON.stringify({ hostVersion: require('@deepseek-ai/dsh/package.json').version, packageMode: modules === original ? 'installed' : 'source-copy', noSshConfigured: true, highlightedLocalSaveCrlf: true, recursiveSearch: true, nativeAgentModel: 'scripted decisions, real native tools and GCC', nativeAgentSteps: status.step, actualBuildOutput: 'LOCAL_BUILD_OK', generatedLinkOpened: true, nativePtyOutput: 'LOCAL_PTY_OK', localSessionIsolation: true, narrowLayout: true, pageErrors: errors }, null, 2))
  console.log('PASS local workspace: real DSH, editable highlighted files, CRLF, recursive search, native Agent/GCC, generated links, local PTY and isolated sessions.')
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {})
  throw error
} finally {
  fs.writeFileSync(path.join(artifacts, 'host.log'), log.replace(/http:\/\/127\.0\.0\.1:\d+\/\S*/g, '[fixture URL]'))
  await browser?.close(); child.kill('SIGTERM')
  await new Promise(resolve => { if (child.exitCode != null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 3000).unref() } })
  if (process.env.IT_LOCAL_KEEP !== '1') fs.rmSync(home, { recursive: true, force: true })
}
