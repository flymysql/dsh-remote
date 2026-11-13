// Actual workspace-directory picker, with an isolated profile and loopback SSH.
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { startFakeSsh } from '../../test/harness/fake-ssh.js'
const modules = process.env.IT_DSH_MODULES
if (!modules) throw Error('Set IT_DSH_MODULES to the installed DSH node_modules directory')
const req = createRequire(path.join(path.resolve(modules), 'fixture.cjs'))
const browserReq = createRequire(path.join(path.resolve(process.env.IT_BROWSER_MODULES || modules), 'fixture.cjs'))
const { chromium } = browserReq('playwright-core')
const artifacts = process.env.IT_PICKER_ARTIFACTS || path.join(os.tmpdir(), 'dsh-picker-artifacts')
fs.mkdirSync(artifacts, { recursive: true })
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-picker-layout-'))
const tree = { '/home/fixture/readme.txt': 'Fixture project' }
for (let i = 0; i < 24; i++) tree['/home/fixture/project-' + String(i).padStart(2, '0') + '/README.md'] = '# Project\n'
const server = await startFakeSsh({ users: { root: { password: 'fixture-only' } }, fs: tree, cwd: '/home/fixture' })
fs.mkdirSync(home + '/profiles/web', { recursive: true })
fs.mkdirSync(home + '/remote-workspaces')
fs.writeFileSync(home + '/profiles/web/cordis.yml', '[]\n')
fs.writeFileSync(home + '/profiles/web/cordis.patch.yml', '[]\n')
fs.writeFileSync(home + '/profiles/web/package.json', JSON.stringify({ name: 'picker-layout-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
fs.symlinkSync(path.resolve(modules), home + '/profiles/web/node_modules')
fs.writeFileSync(home + '/ssh_config', '')
fs.writeFileSync(home + '/remote-workspaces/machines.json', JSON.stringify({ list: [{ id: 'picker-dev', name: 'Picker fixture', host: '127.0.0.1', port: server.port, username: 'root', password: 'fixture-only', backend: 'native', hostKeyMode: 'off', recentWorkspaces: ['/home/fixture/project-00'] }], currentId: 'picker-dev' }))
fs.writeFileSync(home + '/patch.yml', `- insert:\n    - id: dsh-remote\n      name: ${JSON.stringify(path.join(modules, 'dsh-remote/lib/boot.js'))}\n      config:\n        telemetry: false\n        updateMode: off\n`)
const port = String(Number(process.env.IT_PICKER_PORT || 50664))
let log = '', browser
const child = spawn(process.execPath, [path.join(path.dirname(req.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'), 'web', '--patch', home + '/patch.yml', '--host', '127.0.0.1', '--port', port, '--no-open'], { cwd: home + '/profiles/web', env: { ...process.env, DSH_HOME: home, DSH_REMOTE_SSH_CONFIG: home + '/ssh_config' }, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d)
try {
  for (let i = 0; i < 150 && !log.includes('dsh web:'); i++) { if (child.exitCode !== null) throw Error('DSH exited during startup'); await new Promise(r => setTimeout(r, 100)) }
  const url = log.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\S*'))?.[0]
  assert.ok(url, 'DSH must bind its isolated web listener')
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 768 }, locale: 'zh-CN' })
  page.setDefaultTimeout(12000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  for (const name of ['继续', '稍后配置']) await page.getByRole('button', { name, exact: true }).click({ timeout: 1000 }).catch(() => {})
  const intro = page.getByRole('dialog', { name: '开始使用', exact: true })
  if (await intro.waitFor({ timeout: 5000 }).then(() => true, () => false)) await intro.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '添加工作区', exact: true }).click()
  const picker = page.locator('[data-rw-dir-picker]')
  await picker.waitFor()
  const remote = picker.getByRole('tab', { name: '远程', exact: true })
  if (await remote.count()) await remote.click()
  else await picker.getByRole('button', { name: '远程', exact: true }).click()
  await picker.getByRole('button', { name: /^Picker fixture/ }).click()
  const input = picker.getByRole('combobox')
  await input.fill('/home/fixture')
  await picker.getByRole('button', { name: '浏览…', exact: true }).click()
  const list = picker.locator('[data-rw-directory-list]')
  await list.getByRole('button', { name: 'project-00', exact: true }).waitFor()
  const measurements = []
  for (const [name, width, height] of [['desktop', 1280, 768], ['compact', 900, 640], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(150)
    const box = await list.boundingBox(), panel = await picker.boundingBox()
    const row = await list.getByRole('button', { name: 'project-00', exact: true }).boundingBox()
    const visibleRows = Math.floor(box.height / row.height)
    measurements.push({ name, viewport: { width, height }, listHeight: box.height, rowHeight: row.height, visibleRows })
    assert.ok(visibleRows >= 8, name + ': directory list should show at least eight rows, got ' + visibleRows)
    assert.ok(panel.y >= 0 && panel.y + panel.height <= height + 1, name + ': dialog fits the viewport')
    assert.equal(await picker.locator('.dsh-rw-suggestions').count(), 0, 'browse must reclaim the autocomplete area')
    assert.equal(await picker.locator('[data-rw-picker-commit]').count(), 0, 'browse has one visible selection footer')
    await page.screenshot({ path: path.join(artifacts, name + '.png') })
  }
  await page.setViewportSize({ width: 1280, height: 768 })
  await list.getByRole('button', { name: 'project-00', exact: true }).focus()
  await page.keyboard.press('Enter')
  await picker.getByText('所选: /home/fixture/project-00', { exact: true }).waitFor()
  await picker.getByRole('button', { name: '选用此路径', exact: true }).click()
  assert.equal(await input.inputValue(), '/home/fixture/project-00')
  assert.equal(await picker.locator('[data-rw-directory-browser]').count(), 0)
  await picker.getByRole('button', { name: '浏览…', exact: true }).click()
  await list.waitFor(); await page.keyboard.press('Escape')
  await picker.locator('[data-rw-picker-commit]').waitFor()
  assert.equal(await picker.count(), 1)
  fs.writeFileSync(path.join(artifacts, 'measurements.json'), JSON.stringify(measurements, null, 2))
  assert.deepEqual(errors, [])
  console.log('PASS: actual DSH directory picker has >=8 visible rows at 768/640/mobile heights, one selection footer, keyboard directory entry and safe Escape.')
  console.log(JSON.stringify(measurements))
} catch (error) {
  if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }); console.error((await page.locator('body').innerText()).slice(-2800)) } }
  console.error(log.replace(/https?:\/\/\S+/g, '[local URL]'))
  throw error
} finally {
  if (browser) await browser.close()
  child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
  await server.close(); fs.rmSync(home, { recursive: true, force: true })
}
