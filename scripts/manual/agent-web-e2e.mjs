// Opt-in real Web/Agent/SSH/compiler verification with a scripted model.
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {randomUUID} from 'node:crypto'
const modules=process.env.IT_DSH_MODULES
const browserModules=process.env.IT_BROWSER_MODULES || modules
if(!modules)throw Error('Set IT_DSH_MODULES to the installed DSH node_modules directory')
const require=createRequire(path.join(path.resolve(modules),'__e2e__.cjs'))
const browserRequire=createRequire(path.join(path.resolve(browserModules),'__e2e__.cjs'))
const {chromium}=browserRequire('playwright-core')
const repo=fileURLToPath(new URL('../../',import.meta.url))
const artifactDir=process.env.IT_AGENT_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(),'dsh-agent-artifacts-'))
fs.mkdirSync(artifactDir,{recursive:true})
const live=process.env.IT_AGENT_REAL_MODEL==='1'
if(live&&!process.env.DEEPSEEK_API_KEY)throw Error('Real-model acceptance requires DEEPSEEK_API_KEY injected through environment settings')
const nonce=randomUUID()
const port=String(Number(process.env.IT_AGENT_PORT || 50602))
const base='http://127.0.0.1:'+port
import {spawn} from 'node:child_process'
import * as fs from 'node:fs'
import assert from 'node:assert/strict'
import {startDiskWorkspace} from '../../test/harness/disk-workspace.js'
import {broken,fixed} from '../../test/harness/agent-build-model.js'
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-agent-web-e2e-'))
const project=home+'/project'
fs.writeFileSync(home+'/ssh_config','')
fs.mkdirSync(project+'/src',{recursive:true});fs.writeFileSync(project+'/src/main.c',broken)
fs.mkdirSync(home+'/profiles/web',{recursive:true})
fs.writeFileSync(home+'/profiles/web/cordis.yml','[]\n')
fs.writeFileSync(home+'/profiles/web/cordis.patch.yml','[]\n')
fs.writeFileSync(home+'/profiles/web/package.json',JSON.stringify({name:'dsh-profile-web',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}))
fs.symlinkSync(path.resolve(modules),home+'/profiles/web/node_modules')
const server=await startDiskWorkspace(project)
fs.writeFileSync(home+'/patch.yml',`- insert:\n    - id: dsh-remote\n      name: dsh-remote\n      config:\n        telemetry: false\n        updateMode: off\n    - id: agent-e2e\n      name: ${JSON.stringify(path.join(repo,'scripts/manual/fixtures/agent-build-plugin.mjs'))}\n`)
if(live)fs.appendFileSync(home+'/patch.yml',`- id: llm-pi-ai\n  config:\n    providers:\n      release-deepseek:\n        displayName: DeepSeek release acceptance\n        apiKeyEnv: DEEPSEEK_API_KEY\n        api: openai-completions\n        baseURL: https://api.deepseek.com/v1\n        models:\n          - id: ${JSON.stringify(process.env.IT_AGENT_MODEL || 'deepseek-chat')}\n            name: DeepSeek release acceptance\n        defaultContextWindow: 65536\n        defaultMaxTokens: 8192\n        streamIdleTimeoutMs: 60000\n`)
let log='',browser
const child=spawn(process.execPath,[path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js'),'web','--patch',home+'/patch.yml','--host','127.0.0.1','--port',port,'--no-open'],{env:{...process.env,DSH_HOME:home,DSH_REMOTE_SSH_CONFIG:home+'/ssh_config',DSH_E2E_PROJECT:project,DSH_AGENT_E2E:'1',DSH_AGENT_E2E_NONCE:nonce,IT_DSH_MODULES:path.resolve(modules)},stdio:['ignore','pipe','pipe']})
child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d)
try {
 for(let i=0;i<150&&!log.includes('dsh web:');i++){if(child.exitCode!=null)throw Error(log.replace(/https?:\/\/\S+/g,'[local URL]'));await new Promise(r=>setTimeout(r,100))}
 const url=log.match(new RegExp('http://127\\.0\\.0\\.1:'+port+'/\\S*'))?.[0];if(!url)throw Error(log.replace(/https?:\/\/\S+/g,'[local URL]'))
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']})
 const page=await browser.newPage({viewport:{width:1500,height:1050},locale:'zh-CN'});page.setDefaultTimeout(12000)
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.goto(url)
 for(const name of ['继续','稍后配置'])await page.getByRole('button',{name,exact:true}).click({timeout:1000}).catch(()=>{})
 const post=async(path,data)=>{const r=await page.request.post(base+path,{data,headers:{'x-dsh-agent-e2e':nonce}});if(!r.ok())throw Error((await r.text()).slice(0,1000));return r.json()}
 const machine=await post('/dsh-remote/machines',{host:'127.0.0.1',port:server.port,name:'Agent build fixture',username:'root',password:'test-only',backend:'native',hostKeyMode:'off'})
 const mirror=await post('/dsh-remote/mirror',{path:project,machineId:machine.machine.id})
 await post('/agent-e2e/start',{mirror:mirror.localMirror})
 await page.evaluate(()=>localStorage.setItem('dsh.sessions.current',JSON.stringify({sessionId:'remote-build-e2e'})))
 await page.reload()
 await page.waitForTimeout(1200)
 let status
 for(let i=0;i<(live?3000:100);i++){
  status=await (await page.request.get(base+'/agent-e2e/status',{headers:{'x-dsh-agent-e2e':nonce}})).json()
  if(status.status==='idle')break
  await page.waitForTimeout(100)
 }
 const eventJson=JSON.stringify(status,null,2)
 if(process.env.DEEPSEEK_API_KEY)assert.ok(!eventJson.includes(process.env.DEEPSEEK_API_KEY),'credentials must not enter the session log')
 fs.writeFileSync(path.join(artifactDir,'agent-events.json'),eventJson)
 if(live)assert.ok(status.step>=2&&status.status==='idle',JSON.stringify(status.events?.slice(-3)))
 else assert.equal(status.step,6,JSON.stringify(status.events?.slice(-3)))
 assert.equal(fs.readFileSync(project+'/src/main.c','utf8'),fixed)
 assert.ok(fs.existsSync(project+'/dist/app'),'the task must produce the actual remote binary')
 await page.waitForTimeout(1000)
 console.log('Agent steps:',status.step)
 await page.screenshot({path:path.join(artifactDir,'agent-conversation.png')})
 assert.ok((await page.locator('body').innerText()).includes(live?'REMOTE_BUILD_OK':'远端 GCC 编译通过'),'actual agent completion must appear in the session conversation')

 await page.getByText(/已完成，用时|^用时 \d/).first().click()
 const groups=page.locator('button[data-process-activity][aria-expanded=false]')
 for(let i=0;i<30&&await groups.count();i++)await groups.first().click()
 const calls=page.locator('[data-chat-call-id] button[aria-expanded=false]')
 for(let i=0;i<80&&await calls.count();i++)await calls.first().click()
 const compileRow=page.locator('[data-rw-agent-tool=rw_exec]').filter({has:page.getByRole('button',{name:'打开 src/main.c 第 3 行',exact:true})}).first()
 await compileRow.waitFor()
 const compileHeader=compileRow.locator('button[aria-expanded]').first()
 if(await compileHeader.getAttribute('aria-expanded')==='false')await compileHeader.click()
 if(!live){
  assert.equal(await compileRow.getAttribute('data-rw-agent-status'),'failed')
  assert.ok((await compileRow.innerText()).includes('退出码 1'),'failed command must show its real exit code')
 }
 assert.ok((await compileRow.innerText()).includes('1 项编译错误'),'compiler errors must stand out even when a shell command masks the compiler exit code')
 await page.getByText(/src\/main\.c:3:26: error:/).first().waitFor()
 if(!live)assert.ok((await page.locator('body').innerText()).includes('[exit code: 1]'),'compiler failure must be visible in tool output')
 await page.screenshot({path:path.join(artifactDir,'agent-tool-output.png')})
 await compileRow.getByRole('button',{name:'打开 src/main.c 第 3 行',exact:true}).click()
 const file=page.locator('[data-rw-file]')
 await file.locator('[data-line=\"3\"]').waitFor()
 assert.ok(await file.locator('[data-line=\"3\"]').evaluate(el=>el.classList.contains('dsh-rw-line-flash')),'diagnostic must select the correct line')
 assert.match(await file.innerText(),/puts\(\"REMOTE_BUILD_OK\"\);/,'the sidebar must show the file the agent actually changed')
 await page.screenshot({path:path.join(artifactDir,'agent-file-result.png')})
 assert.deepEqual(errors,[])
 console.log('Artifacts:',artifactDir)
 console.log('Model mode:',live?'LIVE DEEPSEEK':'SCRIPTED')
 console.log('PASS: real DSH Web agent loop, real SSH/SFTP disk, real compiler failure/fix/build/run, conversation rendering.')
}catch(e){if(browser){const page=browser.contexts()[0]?.pages()[0];if(page)await page.screenshot({path:path.join(artifactDir,'agent-failure.png')})}throw e}
finally{if(browser)await browser.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await server.close();fs.rmSync(home,{recursive:true,force:true})}
