import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {prepareNpmReadme} from '../scripts/prepare-npm-readme.mjs'

test('publish staging carries the canonical README body even with localized redirect files',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'dsh-npm-readme-'))
  try{
    const readme='# dsh-remote\n'+('Actual documentation and absolute image links.\n'.repeat(40))
    writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',readme:'README.md'}))
    writeFileSync(path.join(directory,'README.md'),readme)
    writeFileSync(path.join(directory,'README.zh.md'),'Moved')
    assert.equal(prepareNpmReadme(directory).characters,readme.length)
    const manifest=JSON.parse(readFileSync(path.join(directory,'package.json')))
    assert.equal(manifest.readme,readme)
    assert.equal(manifest.readmeFilename,'README.md')
  }finally{rmSync(directory,{recursive:true,force:true})}
})

test('the source manifest never overrides npm README with a filename or stale body',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)))
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8')
  if(manifest.readme!==undefined)assert.equal(manifest.readme,readme)
})
