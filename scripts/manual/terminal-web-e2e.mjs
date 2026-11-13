// Native DSH terminal → real local PTY → OpenSSH → disposable SSH/shell/files.
// No host patches, DOM mascots or user profile changes. Text assertions use
// the terminal's rendered xterm rows, not React internals or injected output.
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-terminal-web-e2e-'))
const artifacts = process.env.IT_TERMINAL_ARTIFACTS || path.join(os.tmpdir(), 'dsh-terminal-artifacts-' + randomUUID())
fs.mkdirSync(artifacts, { recursive: true })
let modules = path.resolve(originalModules)
if (process.env.IT_TERMINAL_SOURCE === '1') {
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
fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'README.md'), '# Native terminal fixture\n')
// The remote test shell and OpenSSH client use only this disposable home.
process.env.HOME = home
process.env.SHELL = '/bin/bash'
const nativePty = require('node-pty')
const remoteProcesses = new Set()
const server = await startDiskWorkspace(project, { onPtyExec(command, stream, session) {
  if (!command.includes('exec "${SHELL:-/bin/bash}" -l')) return false
  // A real remote PTY is needed: OpenSSH sends Enter as CR and an ordinary
  // pipe-backed shell does not provide the terminal driver's CR→LF behavior.
  const remote = nativePty.spawn('/bin/sh', ['-c', command], { cwd: project, env: { ...process.env, HOME: home, SHELL: '/bin/sh' }, name: 'xterm-256color', cols: 120, rows: 30 })
  remoteProcesses.add(remote)
  remote.onData(data => { try { stream.write(data) } catch { /* SSH closed */ } })
  remote.onExit(({ exitCode }) => { remoteProcesses.delete(remote); try { stream.exit(exitCode); stream.end() } catch { /* SSH closed */ } })
  stream.on('data', data => remote.write(data.toString('utf8')))
  stream.on('close', () => { try { remote.kill() } catch { /* exited */ } })
  session.on('window-change', (accept, _reject, info) => { if (info.cols > 0 && info.rows > 0) remote.resize(info.cols, info.rows); accept?.() })
  return true
} })
const nonce = randomUUID(), marker = 'TERMINAL_DISK_' + randomUUID().replaceAll('-', '')
const port = String(Number(process.env.IT_TERMINAL_PORT || 50682)), base = 'http://127.0.0.1:' + port
fs.mkdirSync(home + '/profiles/web', { recursive: true }); fs.mkdirSync(home + '/bin')
for (const file of ['cordis.yml', 'cordis.patch.yml']) fs.writeFileSync(home + '/profiles/web/' + file, '[]\n')
fs.writeFileSync(home + '/profiles/web/package.json', JSON.stringify({ name: 'terminal-workbench-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
fs.symlinkSync(modules, home + '/profiles/web/node_modules')
fs.writeFileSync(home + '/ssh_config', `Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile ${home}/known_hosts\n  LogLevel ERROR\n`)
// The launcher's native ssh must not read the real account's ~/.ssh files.
fs.writeFileSync(home + '/bin/ssh', '#!/bin/sh\nexec /usr/bin/ssh -F ' + JSON.stringify(home + '/ssh_config') + ' "$@"\n', { mode: 0o755 })
fs.writeFileSync(home + '/patch.yml', `- insert:\n    - id: dsh-remote\n      name: ${JSON.stringify(path.join(modules, 'dsh-remote/lib/boot.js'))}\n      config:\n        telemetry: false\n        updateMode: off\n    - id: terminal-e2e\n      name: ${JSON.stringify(path.join(repo, 'scripts/manual/fixtures/terminal-workbench-plugin.mjs'))}\n`)
const child = spawn(process.execPath, [path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'), 'web', '--patch', home + '/patch.yml', '--host', '127.0.0.1', '--port', port, '--no-open'], { cwd: home + '/profiles/web', env: { ...process.env, HOME: home, PATH: home + '/bin:' + process.env.PATH, DSH_HOME: home, DSH_REMOTE_SSH_CONFIG: home + '/ssh_config', IT_DSH_MODULES: modules, DSH_TERMINAL_E2E: '1', DSH_TERMINAL_E2E_NONCE: nonce }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', browser
child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data)
try {
  for (let i = 0; i < 180 && !log.includes('dsh web:'); i++) { if (child.exitCode !== null) throw new Error('DSH exited before binding'); await new Promise(r => setTimeout(r, 100)) }
  const url = log.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\S*'))?.[0]
  assert.ok(url, 'DSH must start')
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1500, height: 1050 } })
  const page = await context.newPage(); page.setDefaultTimeout(15000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  for (const name of ['继续', '稍后配置']) await page.getByRole('button', { name, exact: true }).click({ timeout: 1000 }).catch(() => {})
  const intro = page.getByRole('dialog', { name: '开始使用', exact: true })
  if (await intro.waitFor({ timeout: 4000 }).then(() => true, () => false)) await intro.getByRole('button', { name: '关闭', exact: true }).click()
  const post = async (route, data) => {
    const response = await page.request.post(base + route, { data, headers: { 'x-dsh-terminal-e2e': nonce } })
    if (!response.ok()) throw new Error((await response.text()).slice(0, 1000))
    return response.json()
  }
  const machine = await post('/dsh-remote/machines', { host: '127.0.0.1', port: server.port, username: 'root', password: 'test-only', backend: 'native', hostKeyMode: 'off', name: 'Terminal fixture' })
  const mirror = await post('/dsh-remote/mirror', { path: project, machineId: machine.machine.id })
  await post('/terminal-e2e/create-session', { mirror: mirror.localMirror })
  await page.evaluate(() => localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: 'remote-terminal-e2e' })))
  await page.reload(); await page.getByText('远程终端检查会话已就绪。', { exact: true }).last().waitFor()
  await page.getByRole('button', { name: '新标签页', exact: true }).last().click()
  await page.getByRole('button', { name: /^工作区文件/ }).first().click()
  await page.locator('[data-rw-tree-row]').filter({ hasText: 'README.md' }).first().waitFor()
  await page.getByRole('button', { name: '打开远程终端', exact: true }).click()
  const terminal = page.locator('.xterm').last()
  await terminal.waitFor()
  const textarea = terminal.locator('textarea.xterm-helper-textarea')
  await textarea.waitFor({ state: 'attached' })
  await page.waitForTimeout(1500)
  await terminal.click()
  await page.keyboard.type(`printf '%s\\n' '${marker}' > terminal-marker.txt; cat terminal-marker.txt`, { delay: 4 })
  await page.keyboard.press('Enter')
  for (let i = 0; i < 100 && !fs.existsSync(path.join(project, 'terminal-marker.txt')); i++) await new Promise(r => setTimeout(r, 100))
  assert.equal(fs.readFileSync(path.join(project, 'terminal-marker.txt'), 'utf8'), marker + '\n', 'keyboard input must execute on actual remote disk')
  assert.equal(fs.existsSync(path.join(mirror.localMirror, 'terminal-marker.txt')), false, 'the mirror must not receive native terminal writes')
  // DSH uses xterm's DOM renderer. Read actual rendered rows after the remote
  // PTY has echoed its output; this neither fabricates output nor patches DSH.
  await terminal.locator('.xterm-rows').getByText(marker, { exact: true }).waitFor()
  const copied = await terminal.locator('.xterm-rows').innerText()
  fs.writeFileSync(path.join(artifacts, 'terminal-output.txt'), copied)
  assert.match(copied, /[█▀▄]/, 'the actual PTY welcome must contain the pixel fish')
  assert.match(copied, /dsh/)
  assert.match(copied, new RegExp(marker), 'remote output must be visible in the native xterm buffer')
  assert.doesNotMatch(copied, /(?:^|\r?\n)SSH  /, 'the obsolete SSH identity banner must be absent')
  assert.doesNotMatch(copied, new RegExp('(?:^|\\r?\\n)  ' + project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\r?\\n|$)'), 'the obsolete standalone directory banner must be absent')
  await terminal.click(); await page.screenshot({ path: path.join(artifacts, 'native-terminal-fish.png') })
  assert.deepEqual(errors, [])
  assert.ok(server.commands.some(command => command.includes(project)), 'OpenSSH must request the actual remote cwd')
  console.log('PASS real DSH native terminal: explorer action opens remote ssh; keyboard command writes remote-only disk marker; actual rendered xterm rows include pixel fish and command output, omits duplicate SSH banner.')
  console.log('Artifacts:', artifacts)
} catch (error) {
  if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }); console.error((await page.locator('body').innerText()).slice(-2500)) } }
  console.error(log.replace(/https?:\/\/\S+/g, '[local URL]')); throw error
} finally {
  if (browser) await browser.close()
  child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r))
  for (const remote of remoteProcesses) { try { remote.kill() } catch { /* exited */ } }
  await server.close(); fs.rmSync(home, { recursive: true, force: true })
}
