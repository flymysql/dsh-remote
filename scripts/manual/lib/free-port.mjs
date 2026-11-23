// Dynamic port allocation for the manual web e2e scripts (issue #192).
//
// Every *-web-e2e.mjs used to fall back to a fixed default port when its
// IT_*_PORT env var was unset. Two pairs of defaults collided, and since
// agent-acceptance runs those scripts back to back, the kill()→exit window
// of the previous DSH was enough to turn the next spawn into EADDRINUSE.
//
// The contract kept from CI: an explicitly set IT_*_PORT always wins
// (agent-acceptance.yml pins IT_AGENT_PORT=50605 for the local-write run).
// When unset, we ask the kernel for a free port instead of guessing one.
import net from 'node:net'

export function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, host, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export async function e2ePort(envName) {
  const value = process.env[envName]
  if (value !== undefined && value !== '') return Number(value)
  return freePort()
}