// Real Agent native/PTC local-write rejection, remote creation and clicked core file-link regression.
// IT_DSH_MODULES is the installed candidate by default. IT_AGENT_SOURCE=1 uses
// a temporary source overlay. IT_AGENT_PTC=1 uses the real PTC preset.
// This scripted regression intentionally rejects local write and then recovers.
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {randomUUID} from 'node:crypto'
let modules=process.env.IT_DSH_MODULES
const browserModules=process.env.IT_BROWSER_MODULES || modules
if(!modules)throw Error('Set IT_DSH_MODULES to the installed DSH node_modules directory')
const browserRequire=createRequire(path.join(path.resolve(browserModules),'__e2e__.cjs'))
const {chromium}=browserRequire('playwright-core')
const repo=fileURLToPath(new URL('../../',import.meta.url))
const artifactDir=process.env.IT_AGENT_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(),'dsh-agent-artifacts-'))
fs.mkdirSync(artifactDir,{recursive:true})
if(process.env.IT_AGENT_REAL_MODEL==='1')throw Error('Local-write recovery acceptance requires the scripted model')
const nonce=randomUUID()
const port=String(Number(process.env.IT_AGENT_PORT || 50688))
const base='http://127.0.0.1:'+port
import {spawn} from 'node:child_process'
import * as fs from 'node:fs'
import assert from 'node:assert/strict'
import {startDiskWorkspace} from '../../test/harness/disk-workspace.js'
const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-agent-web-e2e-'))
// Explicit development mode: copy the current plugin into a temporary host
// overlay. The default remains the supplied, installed candidate package.
if(process.env.IT_AGENT_SOURCE==='1'){
 const overlay=path.join(home,'source-host/node_modules')
 fs.mkdirSync(overlay,{recursive:true})
 for(const name of fs.readdirSync(modules))if(name!=='dsh-remote')fs.symlinkSync(path.join(path.resolve(modules),name),path.join(overlay,name))
 const plugin=path.join(overlay,'dsh-remote');fs.mkdirSync(plugin)
 fs.cpSync(path.join(repo,'lib'),path.join(plugin,'lib'),{recursive:true})
 for(const name of ['package.json','cordis.patch.yml'])fs.copyFileSync(path.join(repo,name),path.join(plugin,name))
 if(fs.existsSync(path.join(modules,'dsh-remote/node_modules')))fs.symlinkSync(path.join(path.resolve(modules),'dsh-remote/node_modules'),path.join(plugin,'node_modules'))
 modules=overlay
}
const require=createRequire(path.join(path.resolve(modules),'__e2e__.cjs'))
const selectedPlugin=path.join(path.resolve(modules),'dsh-remote')
const selectedManifest=JSON.parse(fs.readFileSync(path.join(selectedPlugin,'package.json'),'utf8'))
const expectedClient=fs.readFileSync(path.join(selectedPlugin,'lib/client.js'),'utf8')
assert.ok(expectedClient.includes("const CLIENT_VERSION = '"+selectedManifest.version+"'"),'selected package client and manifest versions must agree')
const project=home+'/project'
fs.writeFileSync(home+'/ssh_config','')
fs.mkdirSync(project,{recursive:true})
fs.mkdirSync(home+'/profiles/web',{recursive:true})
fs.writeFileSync(home+'/profiles/web/cordis.yml','[]\n')
fs.writeFileSync(home+'/profiles/web/cordis.patch.yml','[]\n')
fs.writeFileSync(home+'/profiles/web/package.json',JSON.stringify({name:'dsh-profile-web',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}))
fs.symlinkSync(path.resolve(modules),home+'/profiles/web/node_modules')
const server=await startDiskWorkspace(project)
fs.writeFileSync(home+'/patch.yml',`- insert:\n    - id: dsh-remote\n      name: ${JSON.stringify(path.join(selectedPlugin,'lib/boot.js'))}\n      config:\n        telemetry: false\n        updateMode: off\n    - id: agent-e2e\n      name: ${JSON.stringify(path.join(repo,'scripts/manual/fixtures/agent-local-write-recovery-plugin.mjs'))}\n`)
let log='',browser
const child=spawn(process.execPath,[path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')),'lib/bin.js'),'web','--patch',home+'/patch.yml','--host','127.0.0.1','--port',port,'--no-open'],{cwd:home+'/profiles/web',env:{...process.env,DSH_HOME:home,DSH_REMOTE_SSH_CONFIG:home+'/ssh_config',DSH_E2E_PROJECT:project,DSH_AGENT_E2E:'1',DSH_AGENT_E2E_NONCE:nonce,IT_DSH_MODULES:path.resolve(modules)},stdio:['ignore','pipe','pipe']})
child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d)
try {
 for(let i=0;i<150&&!log.includes('dsh web:');i++){if(child.exitCode!=null)throw Error(log.replace(/https?:\/\/\S+/g,'[local URL]'));await new Promise(r=>setTimeout(r,100))}
 const url=log.match(new RegExp('http://127\\.0\\.0\\.1:'+port+'/\\S*'))?.[0];if(!url)throw Error(log.replace(/https?:\/\/\S+/g,'[local URL]'))
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']})
 const page=await browser.newPage({viewport:{width:1500,height:1050},locale:'zh-CN'});page.setDefaultTimeout(12000)
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 const servedClients=[],clientReads=[]
 page.on('response',response=>{if(response.request().resourceType()==='script')clientReads.push(response.text().then(body=>{if(body.includes("id: 'dsh-remote'"))servedClients.push(body)}).catch(()=>{}))})
 await page.goto(url)
 for(const name of ['继续','稍后配置'])await page.getByRole('button',{name,exact:true}).click({timeout:1000}).catch(()=>{})
 const post=async(path,data)=>{const r=await page.request.post(base+path,{data,headers:{'x-dsh-agent-e2e':nonce}});if(!r.ok())throw Error((await r.text()).slice(0,1000));return r.json()}
 const machine=await post('/dsh-remote/machines',{host:'127.0.0.1',port:server.port,name:'Agent build fixture',username:'root',password:'test-only',backend:'native',hostKeyMode:'off'})
 const mirror=await post('/dsh-remote/mirror',{path:project,machineId:machine.machine.id})
 await post('/agent-e2e/start',{mirror:mirror.localMirror})
 await page.evaluate(()=>localStorage.setItem('dsh.sessions.current',JSON.stringify({sessionId:'remote-build-e2e'})))
 await page.reload()
 await page.waitForTimeout(1200)
 await Promise.all(clientReads)
 const servedClient=servedClients.find(body=>body.includes(expectedClient))
 assert.ok(servedClient,'served plugin script must match the selected installed package bytes, not the repository self-reference')
 assert.ok(servedClient.includes("const CLIENT_VERSION = '"+selectedManifest.version+"'"),'served client version must match the selected package')
 fs.writeFileSync(path.join(artifactDir,'served-client.js'),servedClient)
 console.log('Served Agent client version:',selectedManifest.version)
 let status
 for(let i=0;i<150;i++){
  status=await (await page.request.get(base+'/agent-e2e/status',{headers:{'x-dsh-agent-e2e':nonce}})).json()
  if(status.status==='idle')break
  await page.waitForTimeout(100)
 }
 const eventJson=JSON.stringify(status,null,2)
 if(process.env.DEEPSEEK_API_KEY)assert.ok(!eventJson.includes(process.env.DEEPSEEK_API_KEY),'credentials must not enter the session log')
 fs.writeFileSync(path.join(artifactDir,'agent-events.json'),eventJson)
 assert.equal(status.step,3,JSON.stringify(status.events?.slice(-4)))
 assert.equal(status.status,'idle')
 const target=project+'/crocodile-bicycle.html'
 const {generatedHtml}=await import('../../test/harness/local-write-recovery-model.js')
 assert.equal(fs.readFileSync(target,'utf8'),generatedHtml)
 assert.equal(fs.existsSync(mirror.localMirror+'/crocodile-bicycle.html'),false,'the denied native write must not leave a local mirror artifact')
 const denied=status.events.find(event=>event.type==='tool/ptc-dispatch'&&event.data.name==='write')||status.events.find(event=>event.type==='tool/result'&&event.data.message?.isError&&JSON.stringify(event.data.message.content).includes('rw_write_file'))
 assert.ok(denied,'persist the actual native or nested local-write refusal')
 if(denied.type==='tool/ptc-dispatch')assert.equal(denied.data.isError,true)
 fs.writeFileSync(mirror.localMirror+'/crocodile-bicycle.html','STALE_LOCAL_MIRROR_COPY_MUST_NOT_RENDER')
 const reads=[]
 page.on('response',async response=>{if(response.url().includes('/dsh-remote/read'))reads.push({status:response.status(),body:await response.text()})})
 await page.getByText('打开 HTML',{exact:true}).click()
 const file=page.locator('[data-rw-file]').filter({hasText:'crocodile-bicycle.html'})
 await file.locator('textarea').waitFor()
 assert.equal(await file.locator('textarea').inputValue(),generatedHtml,'the clicked core link must open the actual remote result, not the stale same-name mirror')
 await page.waitForTimeout(100)
 assert.ok(reads.some(result=>result.status===200&&result.body.includes('REMOTE_GENERATED_HTML')))
 assert.equal(await file.locator('[data-rw-local-copy-recovery]').count(),0)
 await page.screenshot({path:path.join(artifactDir,'agent-local-write-recovered-core-link.png')})
 assert.deepEqual(errors,[])
 console.log('PASS: real Agent '+(process.env.IT_AGENT_PTC==='1'?'PTC':'native')+' local write was denied without changing the mirror; model consumed the refusal, saved with rw_write_file, and the clicked core file link opened the real remote HTML despite a stale local copy.')
 console.log('Plugin mode:',process.env.IT_AGENT_SOURCE==='1'?'SOURCE OVERLAY':'INSTALLED CANDIDATE')
 console.log('Host tools version:',require('@deepseek-ai/dsh-tools/package.json').version)
 console.log('Artifacts:',artifactDir)
}catch(e){if(browser){const page=browser.contexts()[0]?.pages()[0];if(page)await page.screenshot({path:path.join(artifactDir,'failure.png')})}throw e}
finally{if(browser)await browser.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await server.close();fs.rmSync(home,{recursive:true,force:true})}
