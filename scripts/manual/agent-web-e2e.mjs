// Opt-in real Web/Agent/SSH/compiler verification with a scripted model.
// IT_DSH_MODULES is the installed candidate by default. IT_AGENT_SOURCE=1 uses
// a temporary source overlay; IT_AGENT_APPLIED_DIFF=1 adds a rejected edit and
// verifies the recorded applied diff in the real Web conversation.
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
const reviewFailure=process.env.IT_AGENT_APPLIED_DIFF==='1'
if(reviewFailure&&live)throw Error('The applied-diff failure scenario requires the scripted model')
const selectedPlugin=path.join(path.resolve(modules),'dsh-remote')
const selectedManifest=JSON.parse(fs.readFileSync(path.join(selectedPlugin,'package.json'),'utf8'))
const expectedClient=fs.readFileSync(path.join(selectedPlugin,'lib/client.js'),'utf8')
assert.ok(expectedClient.includes("const CLIENT_VERSION = '"+selectedManifest.version+"'"),'selected package client and manifest versions must agree')
const project=home+'/project'
fs.writeFileSync(home+'/ssh_config','')
fs.mkdirSync(project+'/src',{recursive:true});fs.writeFileSync(project+'/src/main.c',broken)
fs.mkdirSync(home+'/profiles/web',{recursive:true})
fs.writeFileSync(home+'/profiles/web/cordis.yml','[]\n')
fs.writeFileSync(home+'/profiles/web/cordis.patch.yml','[]\n')
fs.writeFileSync(home+'/profiles/web/package.json',JSON.stringify({name:'dsh-profile-web',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}))
fs.symlinkSync(path.resolve(modules),home+'/profiles/web/node_modules')
const server=await startDiskWorkspace(project)
fs.writeFileSync(home+'/patch.yml',`- insert:\n    - id: dsh-remote\n      name: ${JSON.stringify(path.join(selectedPlugin,'lib/boot.js'))}\n      config:\n        telemetry: false\n        updateMode: off\n    - id: agent-e2e\n      name: ${JSON.stringify(path.join(repo,'scripts/manual/fixtures/agent-build-plugin.mjs'))}\n`)
if(live)fs.appendFileSync(home+'/patch.yml',`- id: llm-pi-ai\n  config:\n    providers:\n      release-deepseek:\n        displayName: DeepSeek release acceptance\n        apiKeyEnv: DEEPSEEK_API_KEY\n        api: openai-completions\n        baseURL: https://api.deepseek.com/v1\n        models:\n          - id: ${JSON.stringify(process.env.IT_AGENT_MODEL || 'deepseek-chat')}\n            name: DeepSeek release acceptance\n        defaultContextWindow: 65536\n        defaultMaxTokens: 8192\n        streamIdleTimeoutMs: 60000\n`)
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
 if(reviewFailure)assert.ok(servedClient.includes('dsh-remote.change')&&servedClient.includes('function AppliedChangeView('),'served client must contain the applied change renderer and metadata contract')
 fs.writeFileSync(path.join(artifactDir,'served-client.js'),servedClient)
 console.log('Served Agent client version:',selectedManifest.version)
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
 else assert.equal(status.step,reviewFailure?7:6,JSON.stringify(status.events?.slice(-3)))
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
 if(reviewFailure){
  // Native results carry presentation metadata beside the model message;
  // PTC persists it on the completed nested dispatch, outside run_code text.
  const resultEvents=status.events.flatMap(event=>event.type==='tool/result'?[event]:
   event.type==='tool/ptc-dispatch'?[{data:{message:{toolCallId:event.data.rootCallId,content:event.data.content,isError:event.data.isError},meta:event.data.meta}}]:[])
  const edits=status.events.flatMap(event=>event.type==='tool/call'&&event.data.name==='rw_edit'?[event]:
   event.type==='tool/ptc-dispatch-start'&&event.data.name==='rw_edit'?[{data:{callId:event.data.rootCallId,arguments:JSON.stringify(event.data.arguments)}}]:[])
  const failedCall=edits.find(event=>String(event.data.arguments).includes('__MISSING_EDIT_BASELINE__'))
  assert.ok(failedCall,'the real Agent must attempt the intentionally conflicting edit')
  const failed=resultEvents.find(event=>event.data.message?.toolCallId===failedCall.data.callId)
  assert.equal(failed?.data.message.isError,true);assert.notEqual(failed?.data.meta?.applied,true)
  const success=resultEvents.find(event=>event.data.meta?.kind==='dsh-remote.change'&&event.data.meta.applied===true)
  assert.ok(success,'the successful Agent edit must persist applied metadata')
  assert.equal(success.data.meta.path,project+'/src/main.c')
  assert.equal(success.data.meta.additions,1);assert.equal(success.data.meta.deletions,1)
  assert.ok(success.data.meta.diffs.some(diff=>diff.oldText.includes('#include <stdio.h>')&&diff.newText.includes('return 0;')&&diff.newText.includes('puts("REMOTE_BUILD_OK");')),'persist actual changed hunks with surrounding context, not just old/new arguments')
  const successText=success.data.message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n')
  assert.equal(successText,`edited ${project}/src/main.c: replaced 1 occurrence(s)`)
  const modelResult=status.modelResults.find(message=>message.toolCallId===success.data.message.toolCallId)||
   (process.env.IT_AGENT_PTC==='1'&&status.modelResults.find(message=>message.content.some(part=>part.type==='text'&&part.text.includes(successText))))
  assert.ok(modelResult,'the subsequent model step must consume the successful edit output')
  const modelText=modelResult?.content.filter(part=>part.type==='text').map(part=>part.text).join('\n')||''
  if(process.env.IT_AGENT_PTC!=='1')assert.equal(modelText,successText,'model-visible output remains unchanged by UI metadata')
  else assert.ok(modelText.includes(successText),'PTC returns the ordinary edit output through run_code')
  assert.doesNotMatch(modelText,/oldText|newText|dsh-remote\.change|"diffs"/)
  const applied=page.locator('[data-rw-agent-tool=rw_edit] [data-rw-applied-change]').first()
  await applied.waitFor();assert.match(await applied.innerText(),/已应用到远端/)
  assert.match(await applied.innerText(),/\+1\s*−1/)
  assert.match(await applied.innerText(),/#include <stdio.h>/)
  assert.match(await applied.innerText(),/puts\("REMOTE_BUILD_OK"\);/)
  assert.equal(await applied.locator('.dsh-rw-change-hunk').count(),0,'this host must render its shared native DiffBlock, not the fallback details preview')
  await applied.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifactDir,'agent-applied-diff.png')})
  const failedRow=page.locator('[data-rw-agent-tool=rw_edit][data-rw-agent-status=failed]').first()
  await failedRow.waitFor();assert.equal(await failedRow.locator('[data-rw-applied-change]').count(),0)
  assert.doesNotMatch(await failedRow.innerText(),/已应用到远端/)
  assert.match(await failedRow.innerText(),/old text not found/)
  await failedRow.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(artifactDir,'agent-rejected-edit.png')})
  console.log('PASS: real Agent rejected edit has no applied marker; successful edit shows the shared native DiffBlock, actual context and counts; ordinary model-facing edit text is unchanged.')
 }
 await compileRow.getByRole('button',{name:'打开 src/main.c 第 3 行',exact:true}).click()
 const file=page.locator('[data-rw-file]')
 await file.locator('[data-line=\"3\"]').waitFor()
 assert.ok(await file.locator('[data-line=\"3\"]').evaluate(el=>el.classList.contains('dsh-rw-line-flash')),'diagnostic must select the correct line')
 assert.match(await file.innerText(),/puts\(\"REMOTE_BUILD_OK\"\);/,'the sidebar must show the file the agent actually changed')
 await page.screenshot({path:path.join(artifactDir,'agent-file-result.png')})
 // Exercise the shipped workspace-files entry, with a remote-only file that
 // has never appeared in the local mirror.
 fs.writeFileSync(project+'/remote-only-entry.txt','REMOTE_ONLY_WORKSPACE_FILES\n')
 assert.equal(fs.existsSync(mirror.localMirror+'/remote-only-entry.txt'),false)
 await page.getByRole('button',{name:'新标签页',exact:true}).last().click()
 await page.getByRole('button',{name:/^工作区文件/}).first().click()
 const remoteOnly=page.locator('[data-rw-tree-row]').filter({hasText:'remote-only-entry.txt'}).first()
 await remoteOnly.waitFor()
 await remoteOnly.click()
 await page.locator('[data-rw-file]').filter({hasText:'REMOTE_ONLY_WORKSPACE_FILES'}).waitFor()
 await page.screenshot({path:path.join(artifactDir,'workspace-files-remote.png')})
 console.log('PASS: built-in workspace-files entry lists and opens remote-only files without a local mirror copy.')
 assert.deepEqual(errors,[])
 fs.rmSync(path.join(artifactDir,'agent-failure.png'),{force:true})
 console.log('Artifacts:',artifactDir)
 console.log('Plugin mode:',process.env.IT_AGENT_SOURCE==='1'?'SOURCE OVERLAY (development acceptance)':'INSTALLED CANDIDATE')
 console.log('Model mode:',live?'LIVE DEEPSEEK':'SCRIPTED')
 console.log('PASS: real DSH Web agent loop, real SSH/SFTP disk, real compiler failure/fix/build/run, conversation rendering.')
}catch(e){if(browser){const page=browser.contexts()[0]?.pages()[0];if(page)await page.screenshot({path:path.join(artifactDir,'agent-failure.png')})}throw e}
finally{if(browser)await browser.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await server.close();fs.rmSync(home,{recursive:true,force:true})}
