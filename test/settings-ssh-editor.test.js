import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mountClient} from './harness/render.js'

function setup(t){
 const state={text:'Host dev\n  HostName dev.test\n',revision:'a'.repeat(64),conflict:false}
 const calls=[]
 const ui=mountClient({effectDependencies:true,fetch:async(url,init={})=>{
   const body=init.body?JSON.parse(init.body):null;calls.push({url:String(url),body})
   const reply=(json,status=200)=>({ok:status<400,status,json:async()=>json})
   if(String(url).includes('/ssh-config')){
     if(body?.action==='read')return reply({ok:true,file:'C:\\Users\\fixture\\.ssh\\config',text:state.text,revision:state.revision})
     if(body?.action==='save'){
       if(state.conflict)return reply({ok:false,code:'SSH_CONFIG_CONFLICT'},409)
       state.text=body.text;state.revision='b'.repeat(64)
       return reply({ok:true,file:'C:\\Users\\fixture\\.ssh\\config',text:state.text,revision:state.revision})
     }
     return reply({entries:[],file:'C:\\Users\\fixture\\.ssh\\config'})
   }
   if(String(url).includes('/machines'))return reply({machines:[]})
   return reply({ok:true,current:'1.0.1'})
 }})
 t.after(()=>ui.dispose())
 const area=tree=>ui.elements(tree).find(element=>element.type==='textarea')
 return {ui,state,calls,area}
}

test('Edit SSH config opens a real editor, preserves text across tabs, and saves its revision with Ctrl+S',async t=>{
 const {ui,state,calls,area}=setup(t)
 let tree=await ui.settle();await ui.click(tree,/^编辑 SSH 配置$/);tree=await ui.settle()
 assert.equal(area(tree).props.value,state.text)
 assert.equal(calls.some(call=>call.body?.action==='open'),false)
 const changed='Host changed\n  HostName 192.0.2.4\n'
 area(tree).props.onChange({target:{value:changed}});tree=await ui.settle()
 await ui.click(tree,/^连接工具$/);tree=await ui.settle();await ui.click(tree,/^主机$/);tree=await ui.settle()
 assert.equal(area(tree).props.value,changed)
 let prevented=false
 area(tree).props.onKeyDown({key:'s',ctrlKey:true,preventDefault(){prevented=true}})
 await ui.tick();tree=await ui.settle()
 assert.equal(prevented,true)
 assert.equal(state.text,changed)
 assert.deepEqual(calls.find(call=>call.body?.action==='save').body,{action:'save',text:changed,revision:'a'.repeat(64)})
 assert.match(ui.text(tree),/SSH 配置已保存/)
 assert.equal(ui.button(tree,/^保存$/).disabled,true)
})

test('SSH editor retains a conflicted draft and requires discard confirmation before reloading',async t=>{
 const {ui,state,area}=setup(t)
 let tree=await ui.settle();await ui.click(tree,/^编辑 SSH 配置$/);tree=await ui.settle()
 area(tree).props.onChange({target:{value:'Host draft\n'}});tree=await ui.settle()
 state.conflict=true;state.text='Host external\n'
 await ui.click(tree,/^保存$/);tree=await ui.settle()
 assert.equal(area(tree).props.value,'Host draft\n')
 assert.match(ui.text(tree),/已被其他程序修改/)
 await ui.click(tree,/^重新载入$/);tree=await ui.settle()
 ui.components(tree).find(component=>component.type.name==='ConfirmDialog').props.onAnswer(false)
 await ui.tick();tree=await ui.settle();assert.equal(area(tree).props.value,'Host draft\n')
 await ui.click(tree,/^重新载入$/);tree=await ui.settle()
 ui.components(tree).find(component=>component.type.name==='ConfirmDialog').props.onAnswer(true)
 await ui.tick();tree=await ui.settle();assert.equal(area(tree).props.value,'Host external\n')
})

test('closing the settings component retains an unsaved SSH draft in memory and warns before unload',async t=>{
 const {ui,area}=setup(t)
 let tree=await ui.settle();await ui.click(tree,/^编辑 SSH 配置$/);tree=await ui.settle()
 area(tree).props.onChange({target:{value:'Host retained\n'}});tree=await ui.settle()
 let warned=false;ui.dispatchWindowEvent('beforeunload',{preventDefault(){warned=true}})
 assert.equal(warned,true)
 ui.resetState();tree=await ui.settle();assert.equal(area(tree).props.value,'Host retained\n')
 await ui.click(tree,/^取消编辑$/);tree=await ui.settle()
 ui.components(tree).find(component=>component.type.name==='ConfirmDialog').props.onAnswer(true)
 await ui.tick();tree=await ui.settle();assert.equal(area(tree),undefined)
})
