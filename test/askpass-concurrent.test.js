import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

test('concurrent DSH processes use distinct askpass helpers and preserve metacharacters',async()=>{
  const run=promisify(execFile)
  const url=new URL('../lib/openssh.js',import.meta.url).href
  const secret='fixture-only & % ^ " quotes'
  const script=`
    const {ensureAskpassHelper,askpassEnv}=await import(${JSON.stringify(url)});
    const {execFileSync}=await import('node:child_process');
    const {statSync}=await import('node:fs');
    const file=ensureAskpassHelper();
    const before=statSync(file).mtimeMs;
    if(ensureAskpassHelper()!==file || statSync(file).mtimeMs!==before)throw Error('helper was rewritten');
    const value=execFileSync(file,[],{encoding:'utf8',env:askpassEnv(${JSON.stringify(secret)}),shell:process.platform==='win32'});
    console.log(JSON.stringify({file,value}));
  `
  const results=await Promise.all(Array.from({length:4},()=>run(process.execPath,['--input-type=module','-e',script],{timeout:15000})))
  const values=results.map(result=>JSON.parse(result.stdout))
  assert.equal(new Set(values.map(value=>value.file)).size,4,'processes must not race to write the same file')
  for(const value of values)assert.equal(value.value.trimEnd(),secret)
})
