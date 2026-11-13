// npm treats package.json.readme as BODY TEXT, and otherwise may select a
// localized README redirect. Run on the publish staging tree before packing.
import {readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

export function prepareNpmReadme(directory) {
  const file=path.join(directory,'package.json')
  const manifest=JSON.parse(readFileSync(file,'utf8'))
  const readme=readFileSync(path.join(directory,'README.md'),'utf8')
  if(readme.length<1000)throw Error('Refusing to publish a missing or redirect-only README')
  manifest.readme=readme
  manifest.readmeFilename='README.md'
  writeFileSync(file,JSON.stringify(manifest,null,2)+'\n')
  return {filename:manifest.readmeFilename,characters:readme.length}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  console.log('npm README:',JSON.stringify(prepareNpmReadme(path.resolve(process.argv[2]||'.'))))
}
