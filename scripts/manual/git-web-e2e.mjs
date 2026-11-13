// Real native Git UI, SSH and repository acceptance. Never edits a user profile.
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startDiskWorkspace } from '../../test/harness/disk-workspace.js'
const originalModules = process.env.IT_DSH_MODULES
if (!originalModules) throw new Error('Set IT_DSH_MODULES to an isolated DSH node_modules')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-git-web-e2e-'))
const artifacts = process.env.IT_GIT_ARTIFACTS || path.join(os.tmpdir(), 'dsh-git-artifacts-' + randomUUID())
fs.mkdirSync(artifacts, { recursive: true })
let modules = path.resolve(originalModules)
if (process.env.IT_GIT_SOURCE === '1') {
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
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } })
git('init', '-q', '-b', 'daily-work')
fs.writeFileSync(path.join(project, 'main.c'), '// shared context\nconst int value = 1;\n')
git('add', 'main.c'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline')
const server = await startDiskWorkspace(project)
const nonce = randomUUID(), port = String(Number(process.env.IT_GIT_PORT || 50666)), base = 'http://127.0.0.1:' + port
fs.mkdirSync(home + '/profiles/web', { recursive: true })
for (const file of ['cordis.yml', 'cordis.patch.yml']) fs.writeFileSync(home + '/profiles/web/' + file, '[]\n')
fs.writeFileSync(home + '/profiles/web/package.json', JSON.stringify({ name: 'git-workbench-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
fs.symlinkSync(modules, home + '/profiles/web/node_modules')
fs.writeFileSync(home + '/ssh_config', '')
fs.writeFileSync(home + '/patch.yml', `- insert:\n    - id: dsh-remote\n      name: ${JSON.stringify(path.join(modules, 'dsh-remote/lib/boot.js'))}\n      config:\n        telemetry: false\n        updateMode: off\n    - id: git-e2e\n      name: ${JSON.stringify(path.join(repo, 'scripts/manual/fixtures/git-workbench-plugin.mjs'))}\n`)
const child = spawn(process.execPath, [path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'), 'web', '--patch', home + '/patch.yml', '--host', '127.0.0.1', '--port', port, '--no-open'], { cwd: home + '/profiles/web', env: { ...process.env, DSH_HOME: home, DSH_REMOTE_SSH_CONFIG: home + '/ssh_config', IT_DSH_MODULES: modules, DSH_GIT_E2E: '1', DSH_GIT_E2E_NONCE: nonce }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const r = await page.request.post(base + route, { data, headers: { 'x-dsh-git-e2e': nonce } })
    if (!r.ok()) throw new Error((await r.text()).slice(0, 1000))
    return r.json()
  }
  const machine = await post('/dsh-remote/machines', { host: '127.0.0.1', port: server.port, username: 'root', password: 'test-only', backend: 'native', hostKeyMode: 'off', name: 'Git fixture' })
  const mirror = await post('/dsh-remote/mirror', { path: project, machineId: machine.machine.id })
  assert.equal(fs.existsSync(path.join(mirror.localMirror, '.git')), false)
  // Workspace creation deliberately does not promise an initial sync. Seed a
  // conflicting local sentinel to prove every later read uses remote disk.
  fs.writeFileSync(path.join(mirror.localMirror, 'main.c'), 'LOCAL_MIRROR_MUST_NOT_OPEN\n')
  fs.writeFileSync(path.join(project, 'main.c'), '// shared context\nconst int value = 2; // STAGED_REMOTE\n'); git('add', 'main.c')
  fs.writeFileSync(path.join(project, 'main.c'), '// shared context\nconst int value = 3; // WORKING_REMOTE\n')
  fs.writeFileSync(path.join(project, 'remote-only.txt'), 'REMOTE_ONLY_GIT_FILE\n')
  const indexBefore = fs.readFileSync(path.join(project, '.git/index'))
  await post('/git-e2e/create-session', { mirror: mirror.localMirror })
  await page.evaluate(() => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'remote-git-e2e' })))
  await page.reload(); await page.locator('p').filter({ hasText: '远程 Git 检查会话已就绪。' }).first().waitFor()
  await page.getByRole('button', { name: '新标签页', exact: true }).last().click()
  await page.getByRole('button', { name: /^工作区文件/ }).first().click()
  await page.locator('[data-rw-tree-row]').filter({ hasText: 'main.c' }).first().waitFor()
  await page.getByRole('button', { name: '远端 Git 改动', exact: true }).click()
  const pane = page.locator('[data-rw-git]')
  await pane.waitFor(); await pane.getByText(/daily-work/).waitFor()
  await pane.locator('[data-rw-git-diff-line],.dsh-rw-git-diff-line').filter({ hasText: '+const int value = 3;' }).waitFor()
  assert.match(await pane.innerText(), /STAGED_REMOTE/)
  await page.screenshot({ path: path.join(artifacts, 'git-working.png') })
  await pane.getByRole('button', { name: /^已暂存/ }).click()
  await pane.locator('.dsh-rw-git-diff-line').filter({ hasText: '+const int value = 2;' }).waitFor()
  assert.doesNotMatch(await pane.innerText(), /WORKING_REMOTE/)
  assert.equal(await pane.locator('[data-rw-git-file="remote-only.txt"]').count(), 0)
  await page.screenshot({ path: path.join(artifacts, 'git-staged.png') })
  await pane.getByRole('button', { name: /^工作区/ }).click()
  await pane.locator('[data-rw-git-file="main.c"]').focus()
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-rw-git-file')), 'remote-only.txt')
  await pane.getByText('+REMOTE_ONLY_GIT_FILE', { exact: true }).waitFor()
  const filter = pane.getByRole('searchbox', { name: '筛选改动文件', exact: true })
  await filter.fill('no-such-file'); await pane.getByText('没有匹配的改动文件。', { exact: true }).waitFor(); await filter.fill('')
  await pane.locator('[data-rw-git-file="main.c"]').click()
  await pane.locator('[data-rw-diff-line="2"]').waitFor()
  await pane.locator('[data-rw-diff-line="2"]').click()
  const file = page.locator('[data-rw-file]')
  await file.locator('[data-line="2"]').waitFor()
  assert.equal(await file.locator('[data-line="2"]').evaluate(element => element.classList.contains('dsh-rw-line-flash')), true)
  assert.match(await file.innerText(), /WORKING_REMOTE/)
  assert.doesNotMatch(fs.readFileSync(path.join(mirror.localMirror, 'main.c'), 'utf8'), /WORKING_REMOTE/)
  await page.screenshot({ path: path.join(artifacts, 'git-file-line.png') })
  assert.deepEqual(fs.readFileSync(path.join(project, '.git/index')), indexBefore)
  assert.deepEqual(errors, [])
  fs.rmSync(path.join(artifacts, 'failure.png'), { force: true })
  console.log('PASS real DSH Git workbench: native explorer entry, remote working/staged diffs, remote-only file, filter, diff-line navigation; local mirror and remote Git index untouched.')
  console.log('Artifacts:', artifacts)
} catch (error) {
  if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }); console.error((await page.locator('body').innerText()).slice(-2500)) } }
  console.error(log.replace(/https?:\/\/\S+/g, '[local URL]')); throw error
} finally {
  if (browser) await browser.close()
  child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r))
  await server.close(); fs.rmSync(home, { recursive: true, force: true })
}
