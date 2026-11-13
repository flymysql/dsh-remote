// Test-only, nonce-guarded routes; the launcher always creates a disposable profile.
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {createBuildAdapter} from '../../../test/harness/agent-build-model.js'
import path from 'node:path'
const require=createRequire(path.join(process.env.IT_DSH_MODULES,'__fixture__.cjs'))
const llm=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
export const name='agent-build-e2e-fixture'
export const inject=['llm','agents','webServer','sessionController']
export function apply(ctx){
 if(process.env.DSH_AGENT_E2E !== '1' || !process.env.DSH_AGENT_E2E_NONCE) throw Error('test fixture requires an isolated E2E launcher')
 const guard=(req,res)=>{if(req.headers['x-dsh-agent-e2e']!==process.env.DSH_AGENT_E2E_NONCE){res.statusCode=403;res.end();return false}return true}

 const live=process.env.IT_AGENT_REAL_MODEL==='1'
 const adapter=live?null:createBuildAdapter(llm,{project:process.env.DSH_E2E_PROJECT,reviewFailure:process.env.IT_AGENT_APPLIED_DIFF==='1'})
 if(adapter)ctx.llm.registerAdapter(['scripted-build-test'],adapter)
 let agent
 ctx.webServer.register({kind:'exact',path:'/agent-e2e/start',handler:async(req,res)=>{
  if(!guard(req,res))return
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk)
   const {mirror}=JSON.parse(Buffer.concat(chunks))
   if(!path.resolve(mirror).startsWith(path.join(process.env.DSH_HOME,'remote-workspaces')+path.sep))throw Error('expected a fixture mirror')
   await ctx.sessionController.create({sessionId:'remote-build-e2e',cwd:mirror,...(process.env.IT_AGENT_PTC==='1'?{agentPreset:'ptc'}:{})})
   await ctx.sessionController.selectModel({sessionId:'remote-build-e2e',provider:live?'release-deepseek':'scripted-build-test',model:live?(process.env.IT_AGENT_MODEL||'deepseek-chat'):'deterministic'})
   agent=ctx.agents.get('remote-build-e2e')
   await ctx.sessionController.prompt({sessionId:agent.id,requestId:'build-test-prompt',mode:'queue',content:[{type:'text',text:'检查远程工作区的 src/main.c。先使用 GCC 实际编译并检查错误，以最小修改修复语法错误，然后编译为 dist/app 并执行，汇报实际退出码和输出。使用 rw_* 操作远程工作区，不使用本地镜像，不安装依赖，不修改其他项目路径。'}]},new AbortController().signal)
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({sessionId:agent.id}))
  }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}))}
 }})
 ctx.webServer.register({kind:'exact',path:'/agent-e2e/status',handler:(req,res)=>{
  if(!guard(req,res))return
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({modelMode:live?'live':'scripted',step:adapter?.step??agent?.session.snapshotEvents().filter(e=>e.type==='step/start').length,status:agent?.status,modelResults:adapter?.results,events:agent?.session.snapshotEvents()}))
 }})
}
