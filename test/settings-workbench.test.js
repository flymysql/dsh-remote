import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mountClient} from './harness/render.js'

function setup(t, probe) {
  const machines=[
    {id:'a',name:'Development',host:'dev.test',port:22,username:'root',passwordSet:true,credentialBackend:'plain'},
    {id:'b',name:'Staging',host:'stage.test',port:22,username:'ubuntu',passwordSet:true,credentialBackend:'plain'},
  ]
  const calls=[]
  const reply=json=>({ok:true,status:200,json:async()=>json})
  const ui=mountClient({effectDependencies:true,fetch:async(url,init={})=>{
    const body=init.body?JSON.parse(init.body):null
    calls.push({url:String(url),body})
    if(String(url).includes('/test-connect'))return probe?probe():reply({ok:true,host:'dev.test'})
    if(String(url).includes('/machines')) {
      if(init.method==='POST') {
        const index=machines.findIndex(machine=>machine.id===body.id)
        machines[index]={...machines[index],...body,passwordSet:true}
        return reply({ok:true,machine:machines[index]})
      }
      return reply({machines,currentId:'a'})
    }
    if(String(url).includes('/ssh-config'))return reply({entries:[],file:'/fixture/ssh_config'})
    return reply({current:'1.0.0',ok:true})
  }})
  t.after(()=>ui.dispose())
  const input=(tree,key)=>ui.elements(tree).find(element=>element.type==='input'&&element.props.id?.endsWith('-field-'+key))
  return {ui,input,calls,reply}
}

test('settings tabs retain an editor draft, and closing/reopening the settings component restores it',async t=>{
  const {ui,input}=setup(t)
  let tree=await ui.settle()
  ui.buttons(tree).find(button=>button.label==='编辑').el.props.onClick();tree=await ui.settle()
  input(tree,'n').props.onChange({target:{value:'Changed name'}})
  tree=await ui.settle()
  assert.match(ui.textOf(tree),/有未保存的更改/)
  const tabs=()=>ui.buttons(tree).filter(button=>button.el.props.role==='tab')
  tabs()[1].el.props.onClick();tree=await ui.settle()
  assert.equal(ui.elements(tree).find(element=>element.props.role==='tabpanel'&&element.props.id.endsWith('-hosts')).props.hidden,true)
  tabs()[0].el.props.onClick();tree=await ui.settle()
  assert.equal(input(tree,'n').props.value,'Changed name')
  let warned=false
  ui.dispatchWindowEvent('beforeunload',{preventDefault(){warned=true}})
  assert.equal(warned,true)
  ui.resetState();tree=await ui.settle()
  assert.equal(input(tree,'n').props.value,'Changed name')
  assert.match(ui.textOf(tree),/已恢复上次未保存/)
  await ui.click(tree,/^取消编辑$/);tree=await ui.settle()
  const dialog=ui.components(tree).find(component=>component.type.name==='ConfirmDialog')
  assert.match(dialog.props.message,/放弃这台主机/)
  dialog.props.onAnswer(false);await ui.tick();tree=await ui.settle()
  assert.equal(input(tree,'n').props.value,'Changed name')
  await ui.click(tree,/^取消编辑$/);tree=await ui.settle()
  ui.components(tree).find(component=>component.type.name==='ConfirmDialog').props.onAnswer(true);await ui.tick();tree=await ui.settle()
  assert.equal(input(tree,'n'),undefined)
})

test('saving an editor clears its dirty state without losing its test-connection action',async t=>{
  const {ui,input,calls}=setup(t)
  let tree=await ui.settle()
  ui.buttons(tree).find(button=>button.label==='编辑').el.props.onClick();tree=await ui.settle()
  input(tree,'n').props.onChange({target:{value:'Saved name'}});tree=await ui.settle()
  await ui.click(tree,/^保存$/);tree=await ui.settle()
  assert.equal(input(tree,'n').props.value,'Saved name')
  assert.doesNotMatch(ui.textOf(tree),/有未保存的更改/)
  assert.equal(calls.filter(call=>call.body?.action==='update').length,1)
  assert.equal(ui.button(tree,/^测试连接$/).disabled,false)
  let warned=false;ui.dispatchWindowEvent('beforeunload',{preventDefault(){warned=true}})
  assert.equal(warned,false)
  ui.resetState();tree=await ui.settle()
  assert.equal(input(tree,'n'),undefined,'a saved form is not restored as an unsaved draft')
})

test('a late connection probe cannot label a different editor with the previous host result',async t=>{
  let finish
  const pending=new Promise(resolve=>{finish=resolve})
  const {ui,input,reply}=setup(t,()=>pending)
  let tree=await ui.settle()
  ui.buttons(tree).find(button=>button.label==='编辑').el.props.onClick();tree=await ui.settle()
  await ui.click(tree,/^测试连接$/);tree=await ui.settle()
  await ui.click(tree,/^取消编辑$/);tree=await ui.settle()
  ui.buttons(tree).filter(button=>button.label==='编辑')[1].el.props.onClick();tree=await ui.settle()
  assert.equal(input(tree,'h').props.value,'stage.test')
  finish(reply({ok:true,host:'PREVIOUS_HOST_RESULT',user:'root',latencyMs:1}))
  await ui.tick()
  tree=await ui.settle()
  assert.doesNotMatch(ui.textOf(tree),/PREVIOUS_HOST_RESULT/)
  assert.equal(ui.button(tree,/^测试连接$/).disabled,false)
})
