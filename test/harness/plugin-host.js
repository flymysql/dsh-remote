// Reusable HOST harness for dsh-remote.
//
// Why this exists: before it, every route/tool test re-implemented the same fake
// `ctx` + temp `DSH_HOME` + "drive one handler" plumbing (11 files did it, each a
// little differently), and the rest of the 34 routes simply had no test at all —
// which is how "编辑已连接机器 → 测试连接 → 缺少凭据" reached users: the route
// layer had 38% line coverage while the pure-logic modules had 95-100%, so a
// green `npm test` said nothing about the surface people actually click.
//
// What it gives a test:
//   const host = await createHost({ machines: [...] })
//   await host.call('/dsh-remote/machines', { method: 'GET' })
//   host.readMachines()            // what actually landed on disk
//   host.tool('rw_machines')       // the registered tool definition
//   await host.run('rw_machines')  // execute it with parsed args
//   await host.dispose()           // run effects' cleanups + delete the temp home
//
// Notes for test authors:
//   · `DSH_HOME` is process-global, so ONE host per test and one test at a time
//     (node:test already runs tests inside a file sequentially).
//   · The plugin module is imported with a cache-busting query so each host gets a
//     fresh module instance (module-level state: pool, machines, store).
//   · Nothing here mocks the SSH layer. Routes that need a real connection fail
//     fast at the network layer unless the test points them at the fake SSH server
//     in ./fake-ssh.js.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import path from 'node:path'

/** Config defaults that keep tests fast and deterministic (no 15s timeouts). */
export const DEFAULT_CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1500,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
  credentialFallback: 'refuse',
}

/**
 * Boot the plugin host half against an isolated DSH_HOME.
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.machines] - seeded registry records (secrets allowed).
 * @param {string} [opts.currentId] - seed the active machine id.
 * @param {object} [opts.config] - config overrides merged over DEFAULT_CONFIG.
 * @param {object} [opts.services] - extra `ctx.get(name)` services (e.g. jobs, llm).
 * @returns {Promise<object>} the host handle (see the file header).
 */
export async function createHost({ machines = [], currentId = null, config = {}, services = {} } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-host-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  const registryFile = path.join(root, 'machines.json')
  if (machines.length || currentId) {
    const payload = { list: machines }
    if (currentId !== null) payload.currentId = currentId
    writeFileSync(registryFile, JSON.stringify(payload, null, 2))
  }
  process.env.DSH_HOME = home

  const routes = new Map()
  const tools = new Map()
  const commands = new Map()
  const sections = []
  const cleanups = []
  const listeners = new Map()

  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
    inject(names, callback) { if (names.every((n) => this.get(n) !== undefined)) callback(this) },
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        }
      }
      if (name === 'commands') {
        return {
          register(cmd) {
            commands.set(cmd.name, cmd)
            return () => commands.delete(cmd.name)
          },
        }
      }
      if (name === 'logger') return { info() {}, warn() {}, error() {}, debug() {} }
      return services[name]
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    systemPrompt: { section: (s) => sections.push(s) },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
    },
  }

  const mod = await import(`../../lib/index.js?host=${Math.random().toString(36).slice(2)}`)
  await mod.apply(ctx, { ...DEFAULT_CONFIG, ...config })

  const readMachines = () => {
    if (!existsSync(registryFile)) return []
    try { return JSON.parse(readFileSync(registryFile, 'utf8')).list || [] } catch { return [] }
  }
  const readRegistry = () => {
    if (!existsSync(registryFile)) return { list: [] }
    try { return JSON.parse(readFileSync(registryFile, 'utf8')) } catch { return { list: [] } }
  }
  const writeMachines = (list, id) => {
    const payload = { list }
    if (id !== undefined) payload.currentId = id
    writeFileSync(registryFile, JSON.stringify(payload, null, 2))
  }

  return {
    home,
    root,
    registryFile,
    mod,
    ctx,
    routes,
    tools,
    commands,
    sections,
    listeners,
    config: { ...DEFAULT_CONFIG, ...config },
    readMachines,
    readRegistry,
    writeMachines,
    /** Drive one registered route handler the way the webserver does. */
    call: (routePath, opts) => callRoute(routes, routePath, opts),
    /** The registered tool definition (throws when the plugin stopped registering it). */
    tool(name) {
      const t = tools.get(name)
      if (!t) throw new Error(`tool ${name} is not registered (registered: ${[...tools.keys()].join(', ')})`)
      return t
    },
    /** Execute a registered tool with the given args (same shape the model sends). */
    async run(name, args = {}) {
      const t = this.tool(name)
      const parsed = t.parameters && typeof t.parameters.parse === 'function' ? t.parameters.parse(args) : args
      return t.execute(parsed, { sessionId: args.__sessionId })
    },
    async dispose() {
      for (const fn of cleanups.splice(0)) { try { fn() } catch { /* already disposed */ } }
      delete process.env.DSH_HOME
      try { rmSync(home, { recursive: true, force: true }) } catch { /* windows lock */ }
    },
  }
}

/**
 * Drive one route handler with a raw body, exactly as dsh-host-webserver would.
 *
 * @param {Map<string, object>} routes
 * @param {string} routePath
 * @param {object} [opts] - `method`, `body` (object or string), `raw`, `url`, `headers`.
 * @returns {Promise<{status:number, headers:object, raw:string, json:object|null, rejected:Error|null}>}
 */
export async function callRoute(routes, routePath, { method = 'POST', body = {}, raw = false, url, headers = {} } = {}) {
  // The real webserver dispatches on the PATHNAME; a query string is data for the
  // handler (`?id=…`, `?sessionId=…`), never part of the lookup key.
  const pathname = String(routePath).split('?')[0]
  const route = routes.get(pathname)
  if (!route) throw new Error(`route ${pathname} is not registered (registered: ${[...routes.keys()].sort().join(', ')})`)
  const payload = raw ? String(body) : JSON.stringify(body)
  const req = Readable.from([Buffer.from(payload)])
  req.method = method
  req.url = url || routePath
  req.headers = { host: '127.0.0.1:3080', ...headers }
  const res = {
    statusCode: 0,
    headers: {},
    payload: '',
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  let rejected = null
  await route.handler(req, res).catch((e) => { rejected = e })
  let json = null
  try { json = JSON.parse(res.payload) } catch { /* not JSON */ }
  return { status: res.statusCode, headers: res.headers, raw: res.payload, json, rejected }
}

/** A registry record with sane defaults, so a test only states what it cares about. */
export function machine(overrides = {}) {
  const host = overrides.host || '10.0.0.9'
  return {
    id: overrides.id || `m-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name || host,
    host,
    port: 22,
    username: 'root',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    workspace: '',
    hostKeyMode: '',
    useAgent: false,
    keyboardInteractive: false,
    backend: 'native',
    sshBinary: '',
    credentialBackend: 'plain',
    recentWorkspaces: [],
    lastConnectedAt: null,
    latencyMs: null,
    ...overrides,
  }
}
