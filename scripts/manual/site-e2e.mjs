// Render the real documentation and check its bilingual, responsive interactions.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {readFile, mkdir} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const repo=fileURLToPath(new URL('../../',import.meta.url))
const root=path.join(repo,'docs')
const require=createRequire(path.join(process.env.IT_BROWSER_MODULES || repo,'__site__.cjs'))
const {chromium}=require('playwright-core')
const artifacts=process.env.IT_SITE_ARTIFACTS || '/tmp/dsh-site-artifacts'
await mkdir(artifacts,{recursive:true})
const server=createServer(async(req,res)=>{
 try {
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname)
  const file=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':''))
  if(!file.startsWith(root+path.sep))throw Error('outside docs')
  const body=await readFile(file)
  res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.png':'image/png','.json':'application/json','.svg':'image/svg+xml'})[path.extname(file)] || 'application/octet-stream')
  res.end(body)
 }catch{res.writeHead(404);res.end('Not found')}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const base='http://127.0.0.1:'+server.address().port
let browser
try {
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']})
 const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']})
 const page=await context.newPage()
 const errors=[];page.on('pageerror',error=>errors.push(error.message))
 // Keep rendering deterministic; the public registry is verified separately at release.
 await page.route('https://registry.npmjs.org/dsh-remote/latest',route=>route.fulfill({json:{version:'1.0.0'}}))
 const layout=async()=>{
  await page.evaluate(()=>document.fonts.ready)
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page must not scroll horizontally')
  assert.deepEqual(await page.locator('img:visible').evaluateAll(images=>images.filter(image=>!image.complete || image.naturalWidth===0).map(image=>image.src)),[],'visible images must load')
 }
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000})
  await page.goto(base+'/')
  for(const lang of ['zh','en']){
   await page.locator('#lang-'+lang).click()
   assert.equal(await page.locator('html').getAttribute('lang'),lang==='zh'?'zh-CN':'en')
   await page.locator('#tab-agent').click()
   await layout()
   await page.screenshot({path:path.join(artifacts,`homepage-${width}-${lang}.png`),fullPage:true})
   await page.locator('#tab-agent').focus()
   await page.keyboard.press('ArrowRight')
   assert.equal(await page.locator('#tab-file').getAttribute('aria-selected'),'true')
   await page.locator('#panel-file img').evaluate(image=>image.decode())
   await layout()
   await page.keyboard.press('End')
   assert.equal(await page.locator('#tab-terminal').getAttribute('aria-selected'),'true')
   await page.locator('#panel-terminal img').evaluate(image=>image.decode())
   await layout()
   await page.keyboard.press('Home')
   assert.equal(await page.locator('#tab-agent').getAttribute('aria-selected'),'true')
   await page.locator('#copy-install').click()
   assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'dsh plugin --profile web add dsh-remote')
   assert.match(await page.locator('#copy-note').innerText(),lang==='zh'?/已复制/:/copied/)
   await page.reload()
   assert.equal(await page.locator('#lang-'+lang).getAttribute('aria-pressed'),'true','language preference survives reload')
  }
 }
 for(const [source,target,fixedHeight] of [['cover.html','cover.png',640],['features.html','shots/features.png',null]]){
  await page.setViewportSize({width:1280,height:1000})
  await page.goto(base+'/'+source)
  await page.locator('img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())))
  const height=fixedHeight || Math.ceil(await page.locator('main').evaluate(element=>element.getBoundingClientRect().height))
  await page.setViewportSize({width:1280,height})
  await layout()
  assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'rendered image must fit its canvas')
  await page.screenshot({path:path.join(root,target)})
  console.log('Rendered:',target,`1280x${height}`)
 }
 assert.deepEqual(errors,[])
 console.log('PASS: Chinese/English, desktop/mobile, images, keyboard tabs, clipboard, language persistence, documentation figures.')
 console.log('Artifacts:',artifacts)
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
