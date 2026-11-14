import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'
const reply=(json,status=200)=>({ok:status<400,status,json:async()=>json})
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
function setup(t,{eol='lf'}={}){
 let text='original\n',revision='a'.repeat(64),mtime=7,pending=[],reads=[]
 const writes=[],ui=mountClient({effectDependencies:true,fetch:async(url,init={})=>{
  if(String(url).includes('/write')){
   const body=JSON.parse(init.body),wait=deferred();writes.push(body);pending.push(()=>{text=body.content.replace(/\r\n/g,'\n');revision=String.fromCharCode(97+writes.length).repeat(64);mtime++;wait.resolve(reply({ok:true,mtime,revision,bytes:Buffer.byteLength(body.content)}))});return wait.promise
  }
  if(String(url).includes('/dsh-remote/read'))reads.push(String(url));return reply({content:text,revision,mtime,size:Buffer.byteLength(text),eol})
 }})
 const body=ui.body('dsh-remote/file'),props={sessionId:'save-session',useTabInfo:()=>({tab:{navigation:{address:'dsh-resource://dsh-remote/save-session/'+encodeURIComponent('/project/a.txt')}}})}
 const render=()=>ui.settleComponent(body,props)
 const editor=tree=>{const component=ui.components(tree).find(e=>e.type.name==='HighlightedEditor');assert.ok(component,'complete remote text is immediately editable');return component}
 const change=(tree,value)=>editor(tree).props.onChange({target:{value,selectionStart:value.length}})
 t.after(()=>ui.dispose())
 return{ui,render,editor,change,click:(tree,re)=>ui.button(tree,re).el.props.onClick(),writes,reads,complete:()=>pending.shift()()}
}

test('typing during a slow save preserves the newer draft and advances its revision baseline',async t=>{
 const f=setup(t);let tree=await f.render();assert.equal(f.editor(tree).props.value,'original\n')
 f.change(tree,'first save\n');tree=await f.render();await f.click(tree,/^保存到远程$/);await f.ui.tick();tree=await f.render()
 f.change(tree,'newer unsaved draft\n');tree=await f.render();f.complete();await f.ui.tick();tree=await f.render()
 assert.equal(f.editor(tree).props.value,'newer unsaved draft\n');assert.match(f.ui.textOf(tree),/仍有新的未保存输入/)
 await f.click(tree,/^保存到远程$/);await f.ui.tick()
 assert.equal(f.writes[1].content,'newer unsaved draft\n');assert.equal(f.writes[1].expectedRevision,'b'.repeat(64))
 f.complete();await f.ui.tick();tree=await f.render();assert.equal(f.editor(tree).props.value,'newer unsaved draft\n');assert.equal(f.ui.button(tree,/^保存到远程$/).disabled,true);assert.equal(f.reads.length,1,'saving updates the baseline without reloading or replacing the editor')
})

test('returning to the old text during an in-flight save is retained as a new draft',async t=>{
 const f=setup(t);let tree=await f.render();assert.equal(f.editor(tree).props.value,'original\n')
 f.change(tree,'first save\n');tree=await f.render();await f.click(tree,/^保存到远程$/);await f.ui.tick();tree=await f.render()
 f.change(tree,'original\n');tree=await f.render();f.complete();await f.ui.tick();tree=await f.render()
 assert.equal(f.editor(tree).props.value,'original\n');assert.match(f.ui.textOf(tree),/仍有新的未保存输入/)
 await f.click(tree,/^保存到远程$/);await f.ui.tick();assert.equal(f.writes[1].expectedRevision,'b'.repeat(64));assert.equal(f.writes[1].content,'original\n');f.complete();await f.ui.tick()
})

test('CRLF editing sends the byte revision and restores CRLF while the editor remains normalized',async t=>{
 const f=setup(t,{eol:'crlf'});let tree=await f.render();assert.match(f.ui.textOf(tree),/CRLF/)
 f.change(tree,'你好\nsecond\n');tree=await f.render()
 await f.click(tree,/^保存到远程$/);await f.ui.tick();assert.equal(f.writes[0].content,'你好\r\nsecond\r\n');assert.equal(f.writes[0].expectedRevision,'a'.repeat(64));f.complete();await f.ui.tick()
})

test('discard confirms unsaved input, restores the latest saved baseline and keeps the editor open',async t=>{
 const f=setup(t);let tree=await f.render()
 f.change(tree,'saved baseline\n');tree=await f.render();await f.click(tree,/^保存到远程$/);f.complete();await f.ui.tick();tree=await f.render()
 f.change(tree,'discard candidate\n');tree=await f.render()
 let discard=f.click(tree,/^放弃更改$/);tree=await f.render()
 let confirm=f.ui.components(tree).find(component=>component.type.name==='ConfirmDialog')
 assert.ok(confirm,'discarding changed text must ask before losing the draft')
 confirm.props.onAnswer(false);await discard;tree=await f.render()
 assert.equal(f.editor(tree).props.value,'discard candidate\n','cancelling the confirmation preserves input')
 discard=f.click(tree,/^放弃更改$/);tree=await f.render()
 confirm=f.ui.components(tree).find(component=>component.type.name==='ConfirmDialog');confirm.props.onAnswer(true);await discard;tree=await f.render()
 assert.equal(f.editor(tree).props.value,'saved baseline\n')
 assert.equal(f.ui.button(tree,/^保存到远程$/).disabled,true)
 assert.equal(f.writes.length,1,'discard never writes to the remote file')
 assert.equal(f.reads.length,1,'discard uses the saved baseline without reloading the editor')
})
