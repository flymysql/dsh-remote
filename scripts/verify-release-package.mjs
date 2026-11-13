// Inspect the tarball that will be distributed, including bundled dependencies.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function auditPackagePaths(paths) {
  // ssh2's published package includes public protocol-test keys. These are
  // upstream fixtures, not user credentials; do not reject the locked bundle.
  const publicFixtures = new Set(['id_rsa', 'https_cert.pem', 'https_key.pem'].map((name) => 'package/node_modules/ssh2/test/fixtures/' + name))
  const required = ['package/package.json', 'package/cordis.patch.yml', 'package/lib/boot.js', 'package/lib/client.js', 'package/lib/index.js', 'package/lib/sync-status.js', 'package/lib/auto-update.js']
  const missing = required.filter((name) => !paths.includes(name))
  const forbidden = paths.filter((name) => !name.startsWith('package/') || name.split('/').includes('..')
    || /\.node$/i.test(name) || !publicFixtures.has(name) && (/\.(?:pem|key)$/i.test(name) || /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|machines\.json|id_rsa|id_ed25519)(?:\/|$)/.test(name))
    || /^package\/(?:test|scripts|artifacts|dev-harness)\//.test(name))
  return { missing, forbidden }
}

export function verifyReleasePackage(file) {
  // Git Bash's GNU tar treats a Windows drive colon as a remote host.
  // Run beside the archive and pass only its basename; BSD tar accepts this too.
  const archive = path.resolve(file)
  const tarOptions = { encoding: 'utf8', cwd: path.dirname(archive) }
  const paths = execFileSync('tar', ['-tzf', path.basename(archive)], tarOptions).trim().split(/\r?\n/)
  const audit = auditPackagePaths(paths)
  if (audit.missing.length || audit.forbidden.length) throw new Error(`Invalid release package: ${JSON.stringify(audit)}`)
  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', path.basename(archive), 'package/package.json'], tarOptions))
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const expected = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (manifest.name !== expected.name || manifest.version !== expected.version) throw new Error('Candidate manifest does not match this checkout')
  const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
  return { name: manifest.name, version: manifest.version, files: paths.length, sha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/verify-release-package.mjs <candidate.tgz>')
  console.log(JSON.stringify(verifyReleasePackage(process.argv[2]), null, 2))
}
