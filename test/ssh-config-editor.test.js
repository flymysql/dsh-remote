import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,lstatSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createHost} from './harness/plugin-host.js'

async function fixture(t,initial='Host dev\r\n  HostName dev.test\r\n'){
  const dir=mkdtempSync(path.join(tmpdir(),'dsh-ssh-editor-'))
  const file=path.join(dir,'config'), previous=process.env.DSH_REMOTE_SSH_CONFIG
  writeFileSync(file,initial);process.env.DSH_REMOTE_SSH_CONFIG=file
  const host=await createHost()
  t.after(async()=>{await host.dispose();if(previous===undefined)delete process.env.DSH_REMOTE_SSH_CONFIG;else process.env.DSH_REMOTE_SSH_CONFIG=previous;rmSync(dir,{recursive:true,force:true})})
  const edit=body=>host.call('/dsh-remote/ssh-config',{body})
  return {host,dir,file,edit,initial}
}

test('SSH config content is returned only by an explicit editor read; save preserves exact text and refreshes aliases',async t=>{
  const {host,file,edit,initial}=await fixture(t)
  const listing=await host.call('/dsh-remote/ssh-config',{method:'GET'})
  assert.equal(listing.json.text,undefined)
  const before=await edit({action:'read',file:'/ignored/requested/path'})
  assert.equal(before.json.text,initial)
  assert.equal(before.json.file,file)
  assert.match(before.json.revision,/^[a-f0-9]{64}$/)
  const text='# user comment\r\nHost newly-added\r\n  HostName 192.0.2.4\r\n  User deploy\r\n'
  const saved=await edit({action:'save',text,revision:before.json.revision})
  assert.equal(saved.json.ok,true)
  assert.equal(readFileSync(file,'utf8'),text)
  assert.notEqual(saved.json.revision,before.json.revision)
  assert.equal(saved.json.text,text)
  assert.ok(saved.json.entries.some(entry=>entry.alias==='newly-added'))
  assert.equal((await host.call('/dsh-remote/machines',{method:'GET'})).json.currentId,null,'editing config must not select a machine')
})

test('SSH config external edits and a second stale editor cannot overwrite newer content',async t=>{
  const {file,edit}=await fixture(t)
  const first=(await edit({action:'read'})).json
  writeFileSync(file,'Host external\n  HostName 192.0.2.6\n')
  const conflict=await edit({action:'save',text:'Host draft\n',revision:first.revision})
  assert.equal(conflict.status,409)
  assert.equal(conflict.json.code,'SSH_CONFIG_CONFLICT')
  assert.match(readFileSync(file,'utf8'),/Host external/)
  const latest=(await edit({action:'read'})).json
  assert.equal((await edit({action:'save',text:'Host newer\n',revision:latest.revision})).json.ok,true)
  assert.equal((await edit({action:'save',text:'Host stale\n',revision:latest.revision})).status,409)
  assert.equal(readFileSync(file,'utf8'),'Host newer\n')
})

test('SSH config save rejects missing revisions, invalid text and oversized input without changing the file',async t=>{
  const {file,edit,initial}=await fixture(t)
  const {revision}=(await edit({action:'read'})).json
  for(const input of [{text:'Host no-revision\n'},{text:42,revision},{text:'x'.repeat(1024*1024+1),revision}]){
    assert.equal((await edit({action:'save',...input})).status,400)
    assert.equal(readFileSync(file,'utf8'),initial)
  }
})

test('SSH config editor follows an existing config symlink and retains that link',{skip:process.platform==='win32'},async t=>{
  const {file,dir,edit}=await fixture(t)
  const target=path.join(dir,'dotfiles-config');writeFileSync(target,'Host linked\n')
  rmSync(file);symlinkSync(target,file)
  const current=(await edit({action:'read'})).json
  const saved=await edit({action:'save',text:'Host linked-edited\n',revision:current.revision})
  assert.equal(saved.json.ok,true)
  assert.equal(lstatSync(file).isSymbolicLink(),true)
  assert.equal(readFileSync(target,'utf8'),'Host linked-edited\n')
})
