// Browser component contract using the selected host's real React, Shiki and
// theme primitives. A disposable fixture exposes its own public module loader;
// the installed host and plugin files are never patched. Remote save/navigation
// integration remains covered separately by ide-web-e2e and agent-web-e2e.
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const originalModules = process.env.IT_DSH_MODULES
if (!originalModules) throw new Error('Set IT_DSH_MODULES to an isolated DSH node_modules')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-highlight-editor-'))
const artifacts = process.env.IT_EDITOR_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-highlight-artifacts-'))
fs.mkdirSync(artifacts, { recursive: true })
let modules = path.resolve(originalModules)
if (process.env.IT_EDITOR_SOURCE === '1') {
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
const source = fs.readFileSync(path.join(modules, 'dsh-remote/lib/client.js'), 'utf8')
const componentStart = source.indexOf('    function HighlightedEditor('), componentEnd = source.indexOf('    const remoteDrafts', componentStart)
assert.ok(componentStart >= 0 && componentEnd > componentStart, 'selected package must contain the editable code component')
const snippet = process.env.IT_EDITOR_SNIPPET ? fs.readFileSync(process.env.IT_EDITOR_SNIPPET, 'utf8') : source.slice(componentStart, componentEnd)
const indent = source.slice(source.indexOf('    function indentRemoteDraft('), componentStart)
const profile = path.join(home, 'profiles/web')
fs.mkdirSync(profile, { recursive: true })
for (const file of ['cordis.yml', 'cordis.patch.yml']) fs.writeFileSync(path.join(profile, file), '[]\n')
fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'highlight-editor-test', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
fs.symlinkSync(modules, path.join(profile, 'node_modules'))
fs.writeFileSync(home + '/ssh_config', '')
const fixture = path.join(home, 'highlight-editor-browser-fixture')
fs.mkdirSync(fixture)
fs.writeFileSync(fixture + '/package.json', JSON.stringify({ name: 'highlight-editor-browser-fixture', version: '0.0.0', type: 'module', exports: { '.': './index.mjs', './client': './client.js' }, dsh: { client: { inject: ['@deepseek-ai/dsh-client-ui-renderer'], platform: 'web' } } }))
fs.writeFileSync(fixture + '/index.mjs', "export const name='highlight-editor-browser-fixture';export function apply(){}\n")
fs.writeFileSync(fixture + '/client.js', "window.__ModuleLoader__.load({id:'highlight-editor-browser-fixture',factory:require=>{window.__HL_REQUIRE__=require;return{name:'highlight-editor-browser-fixture',apply(){}}}})\n")
fs.writeFileSync(home + '/patch.yml', `- insert:\n    - id: dsh-remote\n      name: ${JSON.stringify(path.join(modules, 'dsh-remote/lib/boot.js'))}\n      config:\n        telemetry: false\n        updateMode: off\n    - id: highlight-editor-browser-fixture\n      name: ${JSON.stringify(fixture + '/index.mjs')}\n`)
const port = String(Number(process.env.IT_EDITOR_PORT || 50686))
const child = spawn(process.execPath, [path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js'), 'web', '--patch', home + '/patch.yml', '--host', '127.0.0.1', '--port', port, '--no-open'], { cwd: profile, env: { ...process.env, DSH_HOME: home, DSH_REMOTE_SSH_CONFIG: home + '/ssh_config' }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', browser
child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data)
try {
  for (let i = 0; i < 180 && !log.includes('dsh web:'); i++) { if (child.exitCode !== null) throw new Error('DSH exited before binding'); await new Promise(resolve => setTimeout(resolve, 100)) }
  const url = log.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\S*'))?.[0]
  assert.ok(url, 'DSH must start')
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1500, height: 1000 } }); page.setDefaultTimeout(12000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  for (const name of ['继续', '稍后配置']) await page.getByRole('button', { name, exact: true }).click({ timeout: 1000 }).catch(() => {})
  const intro = page.getByRole('dialog', { name: '开始使用', exact: true })
  if (await intro.waitFor({ timeout: 4000 }).then(() => true, () => false)) await intro.getByRole('button', { name: '关闭', exact: true }).click()
  await page.waitForFunction(() => window.__HL_REQUIRE__)
  await page.evaluate(({snippet,indent})=>{
    const require=window.__HL_REQUIRE__,React=require('react'),DOM=require('react-dom/client'),primitives=require('@deepseek-ai/dsh-client-ui-primitives')
    const T={label:'var(--dsw-alias-label-primary,#ddd)',border:'var(--dsw-alias-border-l2,#555)',muted:'var(--dsw-alias-label-tertiary,#888)'}
    const Component=new Function('React','useCodeHighlighterFn','languageForPathFn','T',indent+'\n'+snippet+'\nreturn HighlightedEditor')(React,primitives.useCodeHighlighter,primitives.languageForPath,T)
    const root=document.createElement('div');root.id='highlight-direct-fixture';root.style='position:fixed;inset:30px;z-index:999999;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid gray'
    document.body.append(root)
    function App(){
      const [value,setValue]=React.useState('const 名称 = "大肥鱼";\nconsole.log(名称);\n')
      const [wrap,setWrap]=React.useState(false),[path,setPath]=React.useState('editor.js')
      const [jumpLine,setJumpLine]=React.useState(null),[revision,setRevision]=React.useState(0),[match,setMatch]=React.useState(null)
      const editorRef=React.useRef(null)
      window.__hl={setValue,setWrap,setPath,setMatch,editorRef,jump:line=>{setJumpLine(line);setRevision(r=>r+1)}}
      return React.createElement(React.Fragment,{},
        React.createElement('header',{style:{padding:10}},'真实宿主 Shiki 可编辑代码 / 中文 / native undo ',React.createElement('button',{id:'wrap-toggle',onClick:()=>setWrap(w=>!w)},'自动换行')),
        React.createElement(Component,{value,path,wrap,editorRef,jumpLine,jumpRevision:revision,matchingLines:match?[match]:[],currentMatchLine:match,'aria-label':'远程代码编辑器',onChange:e=>setValue(e.target.value),onKeyDown:e=>{window.__keyReceived=e.key;if(e.key==='s'&&(e.ctrlKey||e.metaKey))e.preventDefault()}}))
    }
    DOM.createRoot(root).render(React.createElement(App))
  },{snippet,indent})
  const file=page.locator('#highlight-direct-fixture'),editor=file.locator('textarea')
  const content='const 名称 = "大肥鱼";\n'+Array.from({length:100},(_,i)=>'// 第'+i+'行 '+ 'abcdefghij中文 '.repeat(i===3?40:2)).join('\n')+'\nconsole.log(名称);\n'
  await editor.fill(content)
  await page.waitForFunction(()=>document.querySelector('[data-rw-editor-highlighted="true"]'))
  assert.ok(await file.locator('[data-rw-editor-token]').evaluateAll(nodes=>new Set(nodes.map(n=>getComputedStyle(n).color)).size)>2,'JS editing must show actual Shiki token colors')
  const dimensions=async()=>editor.evaluate(node=>{
    const root=node.closest('[data-rw-highlight-editor]'),paint=root.querySelector('[data-rw-editor-paint]')
    const input=getComputedStyle(node),color=getComputedStyle(paint)
    return {nativeHeight:node.scrollHeight,paintHeight:paint.scrollHeight,clientWidth:node.clientWidth,paintWidth:paint.getBoundingClientRect().width,whiteSpace:input.whiteSpace,paintWhiteSpace:color.whiteSpace,font:input.font,paintFont:color.font,padding:input.padding,paintPadding:color.padding,tabSize:input.tabSize,paintTabSize:color.tabSize}
  })
  let geometry=await dimensions()
  assert.equal(geometry.nativeHeight,geometry.paintHeight,JSON.stringify(geometry))
  assert.equal(geometry.clientWidth,geometry.paintWidth,JSON.stringify(geometry))
  assert.equal(geometry.font,geometry.paintFont);assert.equal(geometry.padding,geometry.paintPadding);assert.equal(geometry.tabSize,geometry.paintTabSize)
  await editor.evaluate(node=>{node.scrollTop=700;node.scrollLeft=140;node.dispatchEvent(new Event('scroll',{bubbles:true}))})
  assert.equal(await file.locator('[data-rw-editor-paint]').evaluate(node=>node.style.transform.replace(/\s/g,'')),'translate(-140px,-700px)')
  await file.getByRole('button',{name:'自动换行',exact:true}).click()
  await page.waitForTimeout(120)
  geometry=await dimensions()
  assert.equal(geometry.nativeHeight,geometry.paintHeight,JSON.stringify(geometry))
  assert.equal(geometry.whiteSpace,geometry.paintWhiteSpace)
  assert.equal(await file.locator('[data-rw-editor-gutter]>div>div').evaluateAll(rows=>rows.reduce((sum,row)=>sum+row.getBoundingClientRect().height,0)+20),geometry.paintHeight)
  await editor.evaluate(node=>{node.focus();node.setSelectionRange(6,8)})
  assert.equal(await editor.evaluate(node=>node.value.slice(node.selectionStart,node.selectionEnd)),'名称')
  await editor.evaluate(node=>node.dshScrollToLine(1))
  const selectedStyle=await editor.evaluate(node=>getComputedStyle(node,'::selection').backgroundColor)
  assert.match(selectedStyle,/0\.32/,'selection is translucent so colored glyphs stay visible')
  await page.screenshot({path:path.join(artifacts,'editor-js-selected.png')})
  await editor.fill('const x = 1;\n')
  await editor.evaluate(node=>{node.focus();node.setSelectionRange(node.value.length,node.value.length)})
  await editor.pressSequentially('// typed')
  const typed=await editor.inputValue()
  await editor.press('Tab')
  assert.equal(await editor.inputValue(),typed+'  ')
  await editor.press('Control+z')
  assert.equal(await editor.inputValue(),typed,'Tab must preserve the browser undo stack after ordinary typing')
  await editor.press('Control+Shift+z')
  assert.equal(await editor.inputValue(),typed+'  ')
  await editor.press('Shift+Tab')
  assert.equal(await editor.inputValue(),typed+'  ','outdent removes leading whitespace, not spaces at the caret')
  await editor.fill('first\nsecond\nthird\n')
  await editor.evaluate(node=>{node.focus();node.setSelectionRange(0,13)})
  await editor.press('Tab')
  assert.equal(await editor.inputValue(),'  first\n  second\nthird\n')
  await editor.press('Shift+Tab')
  assert.equal(await editor.inputValue(),'first\nsecond\nthird\n')
  await editor.evaluate(node=>{window.__sameEditor=node;window.__keyReceived='';node.focus();node.setSelectionRange(node.value.length,node.value.length)})
  const session=await page.context().newCDPSession(page)
  await session.send('Input.imeSetComposition',{text:'中文输入',selectionStart:4,selectionEnd:4})
  assert.equal(await editor.evaluate(node=>getComputedStyle(node).color==='rgba(0, 0, 0, 0)'),false,'composing characters must not be invisible')
  const during=await editor.inputValue()
  await editor.evaluate(node=>{node.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,isComposing:true}));node.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,isComposing:true}))})
  assert.equal(await editor.inputValue(),during,'IME Tab must not indent')
  assert.equal(await page.evaluate(()=>window.__keyReceived),'','IME save/Tab must not reach the parent shortcuts')
  await session.send('Input.insertText',{text:'中文输入'})
  await page.waitForTimeout(100)
  assert.equal(await editor.evaluate(node=>node===window.__sameEditor),true)
  assert.ok((await editor.inputValue()).endsWith('中文输入'))
  assert.equal(await file.locator('[data-rw-highlight-editor]').getAttribute('data-rw-editor-highlighted'),'true')
  await editor.fill(content)
  await page.evaluate(()=>window.__hl.jump(82))
  await page.waitForTimeout(100)
  assert.ok(await editor.evaluate(node=>node.scrollTop)>700)
  const offset=await editor.evaluate(node=>node.selectionStart)
  await editor.pressSequentially('Z')
  assert.equal(await editor.evaluate(node=>node.selectionStart),offset+1,'typing after a diagnostic jump must not pull the caret back')
  await page.evaluate(()=>window.__hl.setPath('main.c'))
  await editor.fill('#include <stdio.h>\nint main(void) {\n  puts("大肥鱼");\n  return 0;\n}\n')
  await page.waitForFunction(()=>new Set([...document.querySelectorAll('[data-rw-editor-token]')].map(n=>getComputedStyle(n).color)).size>2)
  let lightColors
  for(const colorScheme of ['light','dark']){
    await page.emulateMedia({colorScheme})
    await page.waitForTimeout(100)
    const colors=await file.locator('[data-rw-editor-token]').evaluateAll(nodes=>[...new Set(nodes.map(n=>getComputedStyle(n).color))])
    if(colorScheme==='light')lightColors=colors
    else assert.notDeepEqual(colors,lightColors,'host theme must change real token colors')
    await page.screenshot({path:path.join(artifacts,'editor-c-'+colorScheme+'.png')})
  }
  await page.evaluate(()=>window.__hl.setPath('notes.unknown-extension'))
  await editor.fill('plain text\n第二行\nthird target\nlast line\n')
  await page.evaluate(()=>window.__hl.jump(3))
  await page.waitForFunction(()=>window.__hl.editorRef.current.selectionStart===15)
  assert.equal(await file.locator('[data-rw-highlight-editor]').getAttribute('data-rw-editor-highlighted'),'false','unknown grammar must be reported honestly')
  const plainLine=file.locator('[data-rw-editor-line="3"]')
  assert.equal(await plainLine.evaluate(node=>getComputedStyle(node.parentElement).visibility),'visible','unknown grammar must still show line positioning')
  assert.match(await plainLine.getAttribute('class'),/dsh-rw-line-flash/)
  assert.equal(await plainLine.innerText(),'third target')
  await page.evaluate(()=>window.__hl.setMatch(3))
  assert.match(await plainLine.getAttribute('class'),/dsh-rw-code-current/)
  await editor.evaluate(node=>{window.__sameEditor=node})
  await page.evaluate(()=>window.__hl.setValue('log\n'.repeat(12000)))
  assert.equal(await file.locator('[data-rw-editor-line]').count(),0,'large fallback renders no per-line paint DOM')
  assert.equal(await file.locator('[data-rw-editor-gutter]>div>div').count(),0,'large fallback renders no per-line gutter DOM')
  assert.equal(await editor.evaluate(node=>node===window.__sameEditor),true,'large fallback must preserve the native textarea')
  await page.evaluate(()=>window.__hl.jump(11000))
  await page.waitForTimeout(100)
  assert.equal(await editor.evaluate(node=>node.selectionStart),10999*4)
  assert.ok(await editor.evaluate(node=>node.scrollTop)>200000)
  await editor.pressSequentially('X')
  await editor.press('Control+z')
  assert.equal((await editor.inputValue()).length,48000,'plain fallback must retain native undo')
  assert.deepEqual(errors,[])
  console.log('PASS: actual host Shiki C/JS/CJK colors + light/dark theme; exact scroll extents and gutter softwrap; transparent selection; typing/Tab/multiline/outdent/undo/redo; real Chromium IME including Tab/CtrlS; diagnostic caret stability; large fallback DOM/undo.')
  console.log('Component mode:', process.env.IT_EDITOR_SNIPPET ? 'DEVELOPMENT SNIPPET' : process.env.IT_EDITOR_SOURCE === '1' ? 'SOURCE OVERLAY' : 'INSTALLED CANDIDATE')
  console.log('Artifacts:', artifacts)
} catch (error) {
  if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }) }
  console.error(log.replace(/https?:\/\/\S+/g, '[local URL]')); throw error
} finally {
  if (browser) await browser.close()
  child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
  fs.rmSync(home, { recursive: true, force: true })
}
