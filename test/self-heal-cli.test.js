import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function tarHeader(name, size) {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('000644 \0', 100, 8, 'ascii')
  h.write('000000 \0', 108, 8, 'ascii')
  h.write('000000 \0', 116, 8, 'ascii')
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  h.write('00000000000\0', 136, 12, 'ascii')
  h.write('        ', 148, 8, 'ascii')
  h.write('0', 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}

function makeTarball(files) {
  const chunks = []
  for (const [rel, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    chunks.push(tarHeader('package/' + rel, data.length), data)
    const pad = Math.ceil(data.length / 512) * 512 - data.length
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

function makeBrokenInstall() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-cli-'))
  const pkgDir = path.join(dir, 'node_modules', 'dsh-remote')
  mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  for (const file of ['self-heal.js', 'update.js', 'index.js', 'main.js']) {
    copyFileSync(path.join(root, 'lib', file), path.join(pkgDir, 'lib', file))
  }
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-remote', version: '0.2.0', main: 'lib/index.js' }))
  return { dir, pkgDir }
}

function runCli(pkgDir, tarballPath, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pkgDir, 'lib', 'self-heal.js'), '--dir', pkgDir, '--tarball', tarballPath, ...extra], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('node lib/self-heal.js repairs a broken install without importing the broken main', async () => {
  const { dir, pkgDir } = makeBrokenInstall()
  try {
    const tarball = makeTarball({
      'lib/index.js': readFileSync(path.join(root, 'lib', 'index.js')),
      'lib/main.js': "export const name = 'dsh-remote'\nexport { answer } from './helper.js'\n// " + 'y'.repeat(120) + '\n',
      'lib/helper.js': 'export const answer = 42\n',
      'package.json': JSON.stringify({ name: 'dsh-remote', version: '0.2.0', main: 'lib/index.js' }),
    })
    const tarballPath = path.join(dir, 'repair.tgz')
    writeFileSync(tarballPath, tarball)
    const result = await runCli(pkgDir, tarballPath)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /repair completed: 0\.2\.0/)
    const entry = await import(pathToFileURL(path.join(pkgDir, 'lib', 'index.js')).href + '?cli-repaired=' + Date.now())
    assert.equal(entry.name, 'dsh-remote')
    const main = await import(pathToFileURL(path.join(pkgDir, 'lib', 'main.js')).href + '?cli-repaired-main=' + Date.now())
    assert.equal(main.answer, 42)
    assert.deepEqual(readdirSync(pkgDir).filter((n) => n.startsWith('.dsh-remote-update-')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI rejects an invalid version with a non-zero exit', async () => {
  const { dir, pkgDir } = makeBrokenInstall()
  try {
    const result = await runCli(pkgDir, path.join(dir, 'missing.tgz'), ['--version', 'not-a-version'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /invalid version/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
