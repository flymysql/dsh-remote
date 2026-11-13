import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditPackagePaths, verifyReleasePackage } from '../scripts/verify-release-package.mjs'

const files = ['package/package.json', 'package/cordis.patch.yml', 'package/lib/boot.js', 'package/lib/client.js', 'package/lib/index.js', 'package/lib/sync-status.js']
test('release package requires the new runtime files and rejects compiled platform-specific native binaries', () => {
  assert.deepEqual(auditPackagePaths([...files, 'package/node_modules/ssh2/lib/client.js']), { missing: [], forbidden: [] })
  const native = 'package/node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node'
  assert.deepEqual(auditPackagePaths([...files, native]).forbidden, [native])
  assert.deepEqual(auditPackagePaths([...files, 'package/node_modules/ssh2/test/fixtures/id_rsa']).forbidden, [])
  assert.deepEqual(auditPackagePaths([...files, 'package/node_modules/ssh2/test/fixtures/.env']).forbidden, ['package/node_modules/ssh2/test/fixtures/.env'])
  assert.deepEqual(auditPackagePaths(files.slice(0, -1)).missing, ['package/lib/sync-status.js'])
})
test('release package cannot include workspaces, credentials, test fixtures or path traversal', () => {
  const unsafe = ['package/.env', 'package/.ssh/config', 'package/machines.json', 'package/key.pem', 'package/scripts/manual/fixtures/agent-build-plugin.mjs', 'package/../outside', 'outside']
  assert.deepEqual(auditPackagePaths([...files, ...unsafe]).forbidden, unsafe)
})

test('npm itself accepts the supported prerelease host versions without overriding peers', async () => {
  const { readFileSync } = await import('node:fs')
  const { default: semver } = await import('semver')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const [name, range] of Object.entries(manifest.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))) {
    for (const version of ['0.1.5-rc.2', '0.1.7-rc.2', '0.2.0-rc.2', '0.2.2-rc.1']) assert.ok(semver.satisfies(version, range), `${name} rejects ${version} under normal npm SemVer rules`)
  }
})


test('the real package audit handles archive directories containing spaces and drive colons', async t => {
  const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=await import('node:fs')
  const {tmpdir}=await import('node:os')
  const path=await import('node:path')
  const {execFileSync}=await import('node:child_process')
  // POSIX can reproduce GNU tar's colon parsing without a Windows runner;
  // Windows uses its real drive letter, where a colon in a folder is illegal.
  const directory=mkdtempSync(path.join(tmpdir(),process.platform==='win32'?'dsh package-':'dsh package:'))
  t.after(()=>rmSync(directory,{recursive:true,force:true}))
  const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'))
  for(const file of files){
    const target=path.join(directory,file)
    mkdirSync(path.dirname(target),{recursive:true})
    writeFileSync(target,file.endsWith('/package.json')?JSON.stringify(manifest):'export {}\n')
  }
  execFileSync('tar',['-czf','candidate.tgz','package'],{cwd:directory})
  const result=verifyReleasePackage(path.join(directory,'candidate.tgz'))
  assert.equal(result.version,manifest.version)
  assert.equal(result.name,'dsh-remote')
  assert.ok(result.files>=files.length)
  assert.match(result.sha256,/^[a-f0-9]{64}$/)
})
