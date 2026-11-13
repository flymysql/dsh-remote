import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceSearches, createSearchRoutes } from '../lib/workspace-search.js'
const dir = name => ({ filename: name, attrs: { isDirectory: () => true, size: 0 } })
const file = (name, size = 20) => ({ filename: name, attrs: { isDirectory: () => false, size } })
const binding = (sftp, ws = '/project') => ({ bound: true, host: 'fixture', port: 22, username: 'dev', ws, pool: { sftp: async () => sftp } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const finish = async (manager, start) => { const job = manager.jobs.get(start.id); await job.promise; return manager.get(job.owner, job.id) }
const tick = () => new Promise(r => setImmediate(r))

test('search finds unloaded nested files and directories, preserving progress and ignore scope', async () => {
  const reads = []
  const tree = { '/project': [dir('src'),dir('node_modules'),dir('blocksvr'),file('README.md')], '/project/src': [file('block.c'), dir('deep')], '/project/src/deep': [file('block.txt')], '/project/blocksvr': [] }
  const sftp = { readdir: async p => { reads.push(p); return tree[p] || [] } }
  const manager = new WorkspaceSearches()
  const result = await finish(manager,manager.start('a',binding(sftp),{query:'block',isIgnored:p=>p==='node_modules'}))
  assert.equal(result.status,'completed');assert.deepEqual(result.results.map(r=>r.relative).sort(),['blocksvr','src/block.c','src/deep/block.txt'])
  assert.equal(result.results.find(r=>r.relative==='blocksvr').type,'directory')
  assert.equal(reads.includes('/project/node_modules'),false);assert.ok(result.scannedFiles>=3);assert.equal(result.scannedDirs,4)
  const directories = await finish(manager,manager.start('a',binding(sftp),{query:'block',mode:'directories'}))
  assert.ok(directories.results.every(r=>r.type==='directory'))
  const files = await finish(manager,manager.start('a',binding(sftp),{query:'*.C',mode:'files'}))
  assert.deepEqual(files.results.map(r=>r.relative),['src/block.c'])
})

test('slow search exposes partial results and counts; cancel is immediate without closing a shared connection', async () => {
  const gate=deferred();let closed=false
  const sftp={readdir:async p=>p==='/project'?[dir('block-slow')]:gate.promise}
  const b=binding(sftp);b.pool.close=()=>{closed=true}
  const manager=new WorkspaceSearches(),start=manager.start('owner',b,{query:'block'})
  await tick()
  const progress=manager.get('owner',start.id)
  assert.equal(progress.status,'running');assert.equal(progress.scannedDirs,1);assert.equal(progress.results.length,1)
  assert.equal(manager.cancel('owner',start.id).status,'cancelled')
  const result=await finish(manager,start)
  assert.equal(result.status,'cancelled');assert.equal(closed,false)
  gate.resolve([file('block-late.txt')]);await tick()
  assert.equal(manager.get('owner',start.id).results.length,1,'late network responses do not append after cancellation')
})

test('content search returns literal matches with line numbers and skips binary, huge files and symlinks',async()=>{
  const bytes={'/project/main.c':Buffer.from('header\r\n你好 [value]\r\nlast'),'/project/image':Buffer.from('x\0[value]')}
  const link={filename:'link',attrs:{isDirectory:()=>false,isSymbolicLink:()=>true,size:4}}
  const sftp={readdir:async()=>[file('main.c'),file('image'),file('huge',2000000),link],readFile:async p=>bytes[p]}
  const manager=new WorkspaceSearches(),result=await finish(manager,manager.start('a',binding(sftp),{query:'[value]',mode:'content'}))
  assert.equal(result.status,'completed');assert.equal(result.results.length,1)
  assert.equal(result.results[0].line,2);assert.equal(result.results[0].text,'你好 [value]');assert.equal(result.skipped,3)
})

test('limits and unreadable subdirectories report partial results rather than a false complete empty result',async()=>{
  let manager=new WorkspaceSearches({maxResults:1})
  let result=await finish(manager,manager.start('a',binding({readdir:async()=>[file('match1'),file('match2')]}),{query:'match'}))
  assert.equal(result.status,'partial');assert.equal(result.reason,'results');assert.equal(result.results.length,1)
  manager=new WorkspaceSearches()
  result=await finish(manager,manager.start('a',binding({readdir:async p=>{if(p==='/project')return[dir('private')];throw new Error('permission denied')}}),{query:'absent'}))
  assert.equal(result.status,'partial');assert.equal(result.errors,1)
  result=await finish(manager,manager.start('a',binding({readdir:async()=>{throw new Error('root permission denied')}}),{query:'absent'}))
  assert.equal(result.status,'failed');assert.match(result.error,/permission denied/)
})

test('timeouts and replacement searches stop old jobs and never publish results into another owner',async()=>{
  const slow={readdir:()=>new Promise(r=>setTimeout(()=>r([file('late')]),30))}
  const manager=new WorkspaceSearches({timeoutMs:10})
  const first=manager.start('a',binding(slow),{query:'late'})
  assert.equal(manager.get('b',first.id),null);assert.equal(manager.cancel('b',first.id),null)
  const timed=await finish(manager,first);assert.equal(timed.status,'partial');assert.equal(timed.reason,'timeout')
  const old=manager.start('a',binding(slow),{query:'old'})
  const fresh=manager.start('a',binding({readdir:async()=>[file('fresh')]}),{query:'fresh'})
  assert.equal((await finish(manager,old)).status,'cancelled')
  assert.equal((await finish(manager,fresh)).results[0].name,'fresh')
})

test('invalid queries, local workspaces and unsafe child paths cannot trigger scans',async()=>{
  const manager=new WorkspaceSearches()
  assert.throws(()=>manager.start('a',binding({}),{query:''}),/query/)
  assert.throws(()=>manager.start('a',{...binding({}),bound:false},{query:'x'}),/remote workspace/)
  const visited=[];const result=await finish(manager,manager.start('a',binding({readdir:async p=>{visited.push(p);return[dir('..\\escape'),dir('../escape'),file('safe')]}}),{query:'safe'}))
  assert.deepEqual(visited,['/project']);assert.equal(result.results[0].name,'safe')
})

test('HTTP search requests require session scope and cannot poll or cancel a different workspace',async()=>{
  const searches=new WorkspaceSearches(),b=binding({readdir:async()=>[file('target')]})
  const [route]=createSearchRoutes({searches,sendJson:(res,status,json)=>Object.assign(res,{status,json}),readBody:async req=>JSON.stringify(req.body||{}),resolveRequestBinding:async req=>({...b,ws:new URL(req.url,'http://fixture').searchParams.get('sessionId')==='other'?'/other':'/project'})})
  const call=async(url,body,method=body?'POST':'GET')=>{const res={};await route.handler({method,url,body},res);return res}
  assert.equal((await call('/dsh-remote/search',{query:'target'})).status,400)
  const start=await call('/dsh-remote/search?sessionId=own',{query:'target'})
  assert.equal(start.status,200)
  const id=start.json.search.id
  await searches.jobs.get(id).promise
  assert.equal((await call('/dsh-remote/search?sessionId=other&id='+id)).status,404)
  assert.equal((await call('/dsh-remote/search?sessionId=other',{id,action:'cancel'})).status,404)
  const own=await call('/dsh-remote/search?sessionId=own&id='+id)
  assert.equal(own.json.search.results[0].name,'target')
  searches.dispose()
})

test('content snippets center long-line matches and retain original case and Unicode text', async () => {
  const content = 'x'.repeat(2500) + 'FindThis' + 'y'.repeat(2500) + '\n' + 'İ'.repeat(400) + 'NEEDLE' + '末尾'.repeat(400)
  const sftp = { readdir: async () => [file('long.txt', Buffer.byteLength(content))], readFile: async () => Buffer.from(content) }
  const manager = new WorkspaceSearches()
  const long = await finish(manager, manager.start('a', binding(sftp), { query: 'findthis', mode: 'content' }))
  assert.equal(long.results[0].line, 1); assert.match(long.results[0].text, /FindThis/)
  assert.ok(long.results[0].text.startsWith('…')); assert.ok(long.results[0].text.endsWith('…')); assert.ok(long.results[0].text.length <= 502)
  const unicode = await finish(manager, manager.start('a', binding(sftp), { query: 'needle', mode: 'content' }))
  assert.equal(unicode.results[0].line, 2); assert.match(unicode.results[0].text, /NEEDLE/)
  assert.ok(unicode.results[0].text.length <= 502)
  manager.dispose()
})

function stalledReadsFixture() {
  const gates = [], counts = { inFlight: 0, peak: 0, reads: 0, connections: 0, closed: 0 }
  const track = async fn => {
    counts.inFlight++; counts.peak = Math.max(counts.peak, counts.inFlight)
    try { return await fn() } finally { counts.inFlight-- }
  }
  const sftp = {
    readdir: () => track(async () => [file('fresh.txt'), file('a.txt'), file('b.txt')]),
    readFile: () => track(() => { counts.reads++; const gate = deferred(); gates.push(gate); return gate.promise }),
  }
  const b = binding(sftp)
  b.pool.sftp = () => track(async () => { counts.connections++; return sftp })
  b.pool.close = () => { counts.closed++ }
  const reach = async count => { for (let i = 0; i < 30 && counts.reads < count; i++) await tick(); assert.equal(counts.reads, count) }
  return { b, gates, counts, reach }
}

async function occupySix(manager, fixture) {
  const first = manager.start('owner', fixture.b, { query: 'needle', mode: 'content' })
  await fixture.reach(3)
  manager.cancel('owner', first.id); await finish(manager, first)
  const second = manager.start('owner', fixture.b, { query: 'needle', mode: 'content' })
  await fixture.reach(6)
  manager.cancel('owner', second.id); await finish(manager, second)
  return [first, second]
}

test('rapidly cancelled queries never exceed six real in-flight operations and a new query proceeds when one settles', async t => {
  const manager = new WorkspaceSearches(), f = stalledReadsFixture()
  t.after(() => { manager.dispose(); for (const gate of f.gates) gate.resolve(Buffer.from('late needle')) })
  const old = await occupySix(manager, f)
  for (let i = 0; i < 25; i++) {
    const search = manager.start('owner', f.b, { query: 'query-' + i })
    await tick()
    assert.equal(manager.get('owner', search.id).status, 'running')
    manager.cancel('owner', search.id); await finish(manager, search)
  }
  assert.equal(f.counts.connections, 2, 'cancelled queue entries must never issue their underlying connection request')
  assert.equal(f.counts.reads, 6); assert.equal(f.counts.inFlight, 6); assert.ok(f.counts.peak <= 6)
  const fresh = manager.start('owner', f.b, { query: 'fresh' })
  await tick()
  assert.equal(manager.get('owner', fresh.id).phase, 'connecting')
  assert.equal(manager.get('owner', fresh.id).scannedDirs, 0)
  f.gates[0].resolve(Buffer.from('late needle'))
  const result = await finish(manager, fresh)
  assert.equal(result.status, 'completed'); assert.equal(result.results[0].name, 'fresh.txt')
  assert.ok(f.counts.peak <= 6); assert.equal(f.counts.closed, 0)
  for (const prior of old) assert.equal(manager.get('owner', prior.id).results.length, 0, 'late old content must not reappear')
})

test('a new query waiting behind cancelled network requests still honors its own time budget', async t => {
  const manager = new WorkspaceSearches({ timeoutMs: 1000 }), f = stalledReadsFixture()
  // The product has an HTTP listener; keep this isolated test alive while the
  // intentionally unref-ed budget timer races permanently stalled promises.
  const keepAlive = setTimeout(() => {}, 1000)
  t.after(() => { clearTimeout(keepAlive); manager.dispose(); for (const gate of f.gates) gate.resolve(Buffer.from('late')) })
  await occupySix(manager, f)
  manager.timeoutMs = 20
  const start = manager.start('owner', f.b, { query: 'fresh' })
  const result = await finish(manager, start)
  assert.equal(result.status, 'partial'); assert.equal(result.reason, 'timeout'); assert.equal(result.truncated, true)
  assert.equal(result.scannedDirs, 0); assert.ok(result.elapsedMs >= 15)
  assert.equal(f.counts.connections, 2); assert.equal(f.counts.closed, 0)
})
