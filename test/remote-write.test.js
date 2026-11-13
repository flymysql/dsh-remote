import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureRemoteFile, atomicRemoteWrite } from '../lib/remote-write.js'

function fixture() {
  const files = new Map([['/file',Buffer.from('original')]])
  let mode = 0o600
  const missing=()=>Object.assign(new Error('missing'),{code:2})
  const sftp={
    stat:async p=>{if(!files.has(p))throw missing();return{size:files.get(p).length,mtime:1,mode,isDirectory:()=>false}},
    realpath:async p=>p,readFile:async p=>{if(!files.has(p))throw missing();return files.get(p)},
    writeFile:async(p,b,opts)=>{assert.equal(opts.mode,0o600);files.set(p,Buffer.from(b))},
    setstat:async(_p,attrs)=>{mode=attrs.mode},
    renameOverwrite:async(a,b)=>{files.set(b,files.get(a));files.delete(a)},
    rename:async(a,b)=>{if(files.has(b))throw new Error('exists');files.set(b,files.get(a));files.delete(a)},
    unlink:async p=>files.delete(p),
  }
  return{files,sftp}
}

test('a failed staged write leaves the old file untouched and cleans partial staging bytes',async()=>{
  const {files,sftp}=fixture(),baseline=await captureRemoteFile(sftp,'/file')
  sftp.writeFile=async(p)=>{files.set(p,Buffer.from('partial'));throw new Error('disk full')}
  await assert.rejects(atomicRemoteWrite(sftp,baseline,Buffer.from('changed')),/disk full/)
  assert.equal(files.get('/file').toString(),'original');assert.equal(files.size,1)
})

test('same-size same-second external edits are detected after uploading the staged content',async()=>{
  const {files,sftp}=fixture(),baseline=await captureRemoteFile(sftp,'/file')
  const write=sftp.writeFile;sftp.writeFile=async(...args)=>{await write(...args);files.set('/file',Buffer.from('external'))}
  await assert.rejects(atomicRemoteWrite(sftp,baseline,Buffer.from('changed')),error=>error.httpStatus===409)
  assert.equal(files.get('/file').toString(),'external');assert.equal(files.size,1)
})

test('permission failures are not mistaken for a missing file',async()=>{
  const {sftp}=fixture();sftp.stat=async()=>{throw Object.assign(new Error('permission denied'),{code:3})}
  await assert.rejects(captureRemoteFile(sftp,'/file'),/permission denied/)
})

test('successful replacement retains permissions and a newly appeared destination is never overwritten',async()=>{
  const {files,sftp}=fixture(),baseline=await captureRemoteFile(sftp,'/file')
  await atomicRemoteWrite(sftp,baseline,Buffer.from('changed'));assert.equal(files.get('/file').toString(),'changed')
  const create=await captureRemoteFile(sftp,'/new');sftp.writeFile=async(p,b)=>{files.set(p,b);files.set('/new',Buffer.from('other process'))}
  await assert.rejects(atomicRemoteWrite(sftp,create,Buffer.from('mine')),error=>error.httpStatus===409)
  assert.equal(files.get('/new').toString(),'other process');assert.equal(files.size,2)
})
