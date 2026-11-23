// Static gate (issue #192): web e2e scripts must not pin fixed default ports.
//
// Rejected, with the offending pattern reported:
//   1. any manual script reintroducing a hardcoded `SOME_PORT || 50xxx`
//      default — that is exactly how agent-acceptance ended up with two
//      pairs of scripts sharing one port and flaking with EADDRINUSE;
//   2. a *-web-e2e.mjs that does not resolve its port through
//      e2ePort('IT_*_PORT') from ./lib/free-port.mjs, so an unconfigured
//      local run takes a kernel-assigned free port.
//
// The SSH probe scripts (PROBE_PORT, default 22) are remote target ports,
// not local listeners, and are out of scope for the 50xxx pattern.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const self = 'check-e2e-ports.mjs'
const files = readdirSync(here, { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.mjs') && e.name !== self)
  .map(e => e.name)
  .sort()
const failures = []
const webE2e = []
for (const file of files) {
  const text = readFileSync(join(here, file), 'utf8')
  const hardcoded = [...new Set(text.match(/[A-Z_]+_PORT\s*\|\|\s*50\d\d\d/g) || [])]
  if (hardcoded.length) failures.push(`${file}: hardcoded default port(s) ${hardcoded.join(', ')} — route through e2ePort() in ./lib/free-port.mjs (issue #192)`)
  if (/-web-e2e\.mjs$/.test(file)) webE2e.push([file, text])
}
for (const [file, text] of webE2e) {
  if (!/e2ePort\(\s*'IT_[A-Z_]+_PORT'\s*\)/.test(text)) {
    failures.push(`${file}: web e2e must resolve its port via e2ePort('IT_*_PORT') so unconfigured runs take a free port (issue #192)`)
  }
}
if (failures.length) {
  console.error('e2e port guard FAILED:\n  ' + failures.join('\n  '))
  process.exit(1)
}
console.log(`e2e port guard OK: ${webE2e.length} web-e2e scripts on dynamic ports, no hardcoded 50xxx defaults`)