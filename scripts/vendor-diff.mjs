// Keep the tiny structuredPatch dependency closure inside lib/: historical
// self-updaters replace package files but do not run a dependency installation.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const packageRoot = path.dirname(require.resolve('diff/package.json'))
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json')))
if (manifest.version !== '8.0.4') throw Error('Vendoring requires exactly diff@8.0.4')
const source = path.join(packageRoot, 'libesm'), target = path.join(root, 'lib/vendor/jsdiff')
rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true })
const copied = new Set()
function copy(relative) {
  if (copied.has(relative)) return
  copied.add(relative)
  const text = readFileSync(path.join(source, relative), 'utf8').replace(/^\/\/# sourceMappingURL=.*$/mg, '')
  const destination = path.join(target, relative)
  mkdirSync(path.dirname(destination), { recursive: true })
  writeFileSync(destination, '// Vendored unchanged from jsdiff 8.0.4; BSD-3-Clause. See lib/vendor/jsdiff/LICENSE.\n' + text)
  for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) copy(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])))
}
copy('patch/create.js')
writeFileSync(path.join(target, 'LICENSE'), readFileSync(path.join(packageRoot, 'LICENSE')))
writeFileSync(path.join(target, 'SOURCE.md'), 'Source: https://www.npmjs.com/package/diff/v/8.0.4\nLicense: BSD-3-Clause\nOnly the ESM structuredPatch dependency closure is included.\nRebuild: npm ci --legacy-peer-deps && node scripts/vendor-diff.mjs\n')
console.log('Vendored jsdiff@' + manifest.version + ': ' + copied.size + ' JavaScript files')
