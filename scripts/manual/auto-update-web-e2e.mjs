// Real DSH loader acceptance: enable auto in a running host and install the
// actual candidate without calling update-apply. Only an isolated copy changes.
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const modules = path.resolve(process.env.IT_DSH_MODULES || '')
const archive = process.env.IT_UPDATE_TARBALL
if (!archive || !process.env.IT_DSH_MODULES) throw Error('Set IT_DSH_MODULES and IT_UPDATE_TARBALL')
const req = createRequire(path.join(modules, 'fixture.cjs'))
const browserReq = createRequire(path.join(process.env.IT_BROWSER_MODULES || modules, 'fixture.cjs'))
const { chromium } = browserReq('playwright-core')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-update-'))
const installed = path.join(home, 'node_modules/dsh-remote')
fs.mkdirSync(path.dirname(installed), { recursive: true })
for (const name of fs.readdirSync(modules)) if (name !== 'dsh-remote') fs.symlinkSync(path.join(modules, name), path.join(home, 'node_modules', name))
fs.cpSync(path.join(modules, 'dsh-remote'), installed, { recursive: true, dereference: true })
// Start the candidate's updater with an older loaded/disk version, then serve
// the unmodified candidate tarball through an isolated registry fixture.
const pkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json')))
const target = pkg.version
pkg.version = '0.0.1'
fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify(pkg))
fs.writeFileSync(path.join(installed, 'update-mode'), 'manual')
fs.mkdirSync(home + '/profiles/web', { recursive: true })
for (const file of ['cordis.yml', 'cordis.patch.yml']) fs.writeFileSync(home + '/profiles/web/' + file, '[]\n')
fs.writeFileSync(home + '/profiles/web/package.json', JSON.stringify({ name: 'auto-update-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
fs.symlinkSync(home + '/node_modules', home + '/profiles/web/node_modules')
fs.writeFileSync(home + '/ssh_config', '')
fs.writeFileSync(home + '/patch.yml', `- insert:\n    - id: dsh-remote\n      name: ${JSON.stringify(path.join(installed, 'lib/boot.js'))}\n      config:\n        telemetry: false\n        updateMode: manual\n`)
fs.writeFileSync(home + '/registry.mjs', `import {readFileSync,appendFileSync} from 'node:fs';
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
const url=String(input);
if(url==='https://registry.npmjs.org/dsh-remote/latest')return Response.json({version:${JSON.stringify(target)}});
if(url===${JSON.stringify('https://registry.npmjs.org/dsh-remote/-/dsh-remote-' + target + '.tgz')}){
appendFileSync(${JSON.stringify(home + '/downloads')},'download\\n');return new Response(readFileSync(${JSON.stringify(path.resolve(archive))}));}
return original(input,init);};`)
const port = String(Number(process.env.IT_UPDATE_PORT || 50651))
const child = spawn(process.execPath, ['--import', home + '/registry.mjs', path.join(path.dirname(req.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'), 'web', '--patch', home + '/patch.yml', '--host', '127.0.0.1', '--port', port, '--no-open'], { cwd: home + '/profiles/web', env: { ...process.env, DSH_HOME: home, DSH_REMOTE_SSH_CONFIG: home + '/ssh_config' }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', browser
child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d)
try {
  for (let i = 0; i < 150 && !log.includes('dsh web:'); i++) { if (child.exitCode != null) throw Error('DSH exited before binding'); await new Promise(r => setTimeout(r, 100)) }
  const url = log.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\S*'))?.[0]
  assert.ok(url, 'DSH must start')
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ locale: 'zh-CN' })
  await page.goto(url)
  const api = async (route, body) => {
    const response = await page.request.fetch('http://127.0.0.1:' + port + '/api/dsh-remote/' + route, body ? { method: 'POST', data: body } : {})
    return response.json()
  }
  assert.equal((await api('update-check?statusOnly=1')).loaded, '0.0.1')
  assert.equal(fs.existsSync(home + '/downloads'), false)
  assert.equal((await api('update-mode', { mode: 'auto' })).ok, true)
  let result
  for (let i = 0; i < 160; i++) {
    try { result = await api('update-check?statusOnly=1') } catch { /* loader swap briefly unregisters routes */ }
    if (result?.loaded === target) break
    await new Promise(r => setTimeout(r, 100))
  }
  if (result?.loaded !== target) console.error('Update diagnostics:', JSON.stringify(result), 'downloads:', fs.existsSync(home + '/downloads') ? fs.readFileSync(home + '/downloads', 'utf8') : 'none')
  assert.equal(result?.loaded, target, 'the running loader must switch to the installed version automatically')
  assert.equal(result.disk, target); assert.equal(result.pendingReload, false)
  assert.equal(fs.readFileSync(home + '/downloads', 'utf8'), 'download\n')
  assert.equal(fs.readFileSync(installed + '/lib/auto-update.js', 'utf8'), fs.readFileSync(path.join(modules, 'dsh-remote/lib/auto-update.js'), 'utf8'))
  let off
  for (let i = 0; i < 100; i++) {
    try { off = await api('update-mode', { mode: 'off' }); if (off?.ok) break } catch { /* client rescan can refresh the loader entry */ }
    await new Promise(r => setTimeout(r, 100))
  }
  assert.equal(off?.ok, true)
  assert.equal(fs.readFileSync(installed + '/update-mode', 'utf8'), 'off')
  console.log('PASS real DSH auto update: manual → auto → actual candidate download → loader reload; no update-apply request, one download, off persists.')
} catch (error) {
  console.error(log.replace(/https?:\/\/\S+/g, '[local URL]'))
  throw error
} finally {
  if (browser) await browser.close()
  child.kill(); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r))
  fs.rmSync(home, { recursive: true, force: true })
}
