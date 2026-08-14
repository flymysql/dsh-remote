// dsh-remote — remote-access assistant for DeepSeek Harness (Host half).
//
// The harness Web server intentionally binds loopback only (the CLI rejects
// --host 0.0.0.0 for safety: the GUI has no auth and the agent executes code).
// This plugin does not fight that design — it makes the supported paths easy:
//   • a `/remote` slash command that prints the exact tunnel commands,
//   • a JSON endpoint (GET /dsh-remote/info) the settings page consumes.
// Commands cover local-forward (ssh -L), keepalive (autossh), reverse tunnel
// (ssh -R, NAT-friendly) and reverse-proxy (with --trusted-host) guidance.
import { networkInterfaces } from 'node:os'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-remote'

// The web server is the hard dependency: its live port feeds every command.
export const inject = ['webServer']

/** Optional deployment tuning. */
export const Config = z.object({
  /** Local port used by the ssh -L / autossh commands generated for the PC side. */
  localPort: z.number().step(1).min(1).max(65535).default(18080),
})

/** Non-loopback IPv4 addresses of this machine (empty when none are up). */
function lanAddresses() {
  const out = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address)
    }
  }
  return out
}

export async function apply(ctx, config) {
  const port = ctx.webServer.port
  const url = `http://127.0.0.1:${port}`
  const lan = lanAddresses()

  const webStartup = ctx.get('webStartup')
  const trustedHosts =
    webStartup && Array.isArray(webStartup.trustedHosts) ? webStartup.trustedHosts : []

  const buildCommands = (target) => {
    const remote = target && target.trim() ? target.trim() : '<user@remote-host>'
    return {
      localForward: `ssh -N -L ${config.localPort}:127.0.0.1:${port} ${remote}`,
      localForwardAuto: `autossh -M 0 -N -L ${config.localPort}:127.0.0.1:${port} ${remote}`,
      reverseForward: `ssh -N -R ${port}:127.0.0.1:${port} ${remote}`,
      trustedFlag: `dsh --profile web --port ${port} --trusted-host <your-public-host>`,
    }
  }

  const info = (target) => ({
    port,
    url,
    lanAddresses: lan,
    trustedHosts,
    commands: buildCommands(target || ''),
  })

  // ── /remote slash command ────────────────────────────────────────────────

  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'remote',
      description:
        'Show remote-access tunnel commands for this harness instance. Optional argument: user@host for the ssh tunnel target.',
      handler: (invocation) => {
        const target = (invocation.rawInput || '').trim()
        const i = info(target)
        const remote = target || '<user@remote-host>'
        const lines = [
          '## dsh-remote — remote access',
          '',
          `Web GUI: ${i.url}`,
          ...(lan.length ? [`LAN IPs: ${lan.join(', ')}`] : []),
          ...(trustedHosts.length ? [`trusted hosts: ${trustedHosts.join(', ')}`] : []),
          '',
          '### Tunnel from your PC (recommended — harness stays loopback)',
          `ssh -N -L ${config.localPort}:127.0.0.1:${port} ${remote}`,
          `autossh -M 0 -N -L ${config.localPort}:127.0.0.1:${port} ${remote}`,
          '',
          '### Reverse tunnel (remote pushes out; NAT-friendly)',
          `ssh -N -R ${port}:127.0.0.1:${port} ${remote}`,
          '',
          '### Direct web access behind a reverse proxy (add auth yourself!)',
          `dsh --profile web --port ${port} --trusted-host <your-public-host>`,
          '',
          'Note: --host 0.0.0.0 is intentionally rejected by the harness for safety.',
        ]
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  }

  // ── JSON endpoint for the settings page ──────────────────────────────────

  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  const disposeRoute = webServer.register({
    kind: 'exact',
    path: '/dsh-remote/info',
    handler: async (req, res) => {
      const query = (req.url || '').split('?')[1] || ''
      const match = query.match(/target=([^&]*)/)
      let target = ''
      try {
        target = match ? decodeURIComponent(match[1]) : ''
      } catch {
        target = ''
      }
      sendJson(res, 200, info(target))
    },
  })
  // Route is not fiber-bound: retain the disposer so stop/update never leaks.
  ctx.effect(() => disposeRoute, 'dsh-remote.routeDispose')
}
