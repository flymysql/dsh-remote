import {test, mock} from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {saveSecret} from '../lib/credential.js'

function useHelper(t, platform, run) {
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform')
  Object.defineProperty(process,'platform',{value:platform})
  mock.method(childProcess,'spawn',(bin,args,options)=>{
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:options.stdio[0]==='pipe'?new PassThrough():null,kill(){}})
    queueMicrotask(()=>run({child,bin,args,options}))
    return child
  })
  syncBuiltinESMExports()
  t.after(()=>{mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,'platform',descriptor)})
}

test('argument-only keychain helpers do not receive an unused stdin pipe',async t=>{
  useHelper(t,'darwin',({child,bin,options})=>{
    assert.equal(bin,'security')
    assert.equal(options.stdio[0],'ignore')
    child.emit('close',0)
  })
  assert.equal((await saveSecret('fixture','test-only')).ok,true)
})

test('a helper failure after committing is successful only after reading back the requested secret',async t=>{
  let writes=0,reads=0
  useHelper(t,'darwin',({child,args})=>{
    if(args[0]==='add-generic-password'){writes++;child.stderr.write('helper failed after committing');child.emit('close',1)}
    else {reads++;child.stdout.write('test-only');child.emit('close',0)}
  })
  assert.deepEqual(await saveSecret('fixture','test-only'),{ok:true,backend:'keychain',error:''})
  assert.equal(writes,1);assert.equal(reads,1)
})

test('a failed write and a different old credential remain a refusal with redacted diagnostics',async t=>{
  useHelper(t,'darwin',({child,args})=>{
    if(args[0]==='add-generic-password'){child.stderr.write('denied test-only');child.emit('close',1)}
    else {child.stdout.write('old-secret');child.emit('close',0)}
  })
  const saved=await saveSecret('fixture','test-only')
  assert.equal(saved.ok,false)
  assert.ok(!saved.error.includes('test-only'))
  assert.match(saved.error,/denied/)
})

test('secret-tool still receives the actual secret followed by EOF',async t=>{
  useHelper(t,'linux',({child,bin,options})=>{
    assert.equal(bin,'secret-tool')
    assert.equal(options.stdio[0],'pipe')
    assert.equal(child.stdin.read().toString(),'test-only\n')
    assert.equal(child.stdin.writableEnded,true)
    child.emit('close',0)
  })
  assert.equal((await saveSecret('fixture','test-only')).ok,true)
})
