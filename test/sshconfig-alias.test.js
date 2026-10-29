// ssh-config aliases (issue #38).
//
// The request: read connection parameters from ~/.ssh/config instead of keeping
// a second copy in the plugin, the way VSCode Remote-SSH does.
//
// Part A pins the OpenSSH semantics of the resolver (wildcards, negation,
// first-wins across blocks, Include, ProxyJump) — pure and I/O-injected.
// Part B drives the REAL registered routes + tools, with HOME/DSH_HOME pointed
// at scratch dirs, and proves the promise that matters: editing ~/.ssh/config
// changes where the machine connects WITHOUT re-importing anything, while the
// registry keeps nothing but the alias.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import {
  loadSshConfigText, parseHostBlocks, resolveSshHost, resolveSshAlias, sshAliasTarget,
  resolveMachineSshConfig, listAliases, parseProxyJump, hostBlockMatches, globMatch,
  importableEntries, expandHome, sshConfigPath,
} from '../lib/sshconfig.js'

const LF = '\n'

// ── Part A: OpenSSH semantics ─────────────────────────────────────────────

const SAMPLE = [
  '# a comment',
  'Host build',
  '  HostName 9.134.186.191',
  '  User mmdev',
  '  Port 36000',
  '  IdentityFile ~/.ssh/build_key',
  '  ProxyJump jump.example.com',
  '',
  'Host prod-* !prod-canary',
  '  HostName 10.0.0.1',
  '  User ops',
  '',
  'Host multi-a multi-b',
  '  User shared',
  '',
  'Host jump.example.com',
  '  HostName 10.1.1.1',
  '  User jumper',
  '  Port 2200',
  '',
].join(LF)

test('resolveSshHost: first obtained value wins, across blocks in file order', () => {
  const resolved = resolveSshHost('build', SAMPLE)
  assert.equal(resolved.matched, true)
  assert.equal(resolved.hostName, '9.134.186.191')
  assert.equal(resolved.user, 'mmdev')
  assert.equal(resolved.port, 36000)
  assert.equal(resolved.identityFile, '~/.ssh/build_key')
  assert.equal(resolved.proxyJump, 'jump.example.com')
})

test('resolveSshHost: a LATER block never overrides an earlier one (ssh_config(5))', () => {
  const text = ['Host x', '  User first', 'Host x', '  User second', '  Port 2222'].join(LF)
  const resolved = resolveSshHost('x', text)
  assert.equal(resolved.user, 'first')
  assert.equal(resolved.port, 2222) // not set by the first block, so it survives
})

test('resolveSshHost: a Host * block placed FIRST wins for the parameters it sets', () => {
  const text = ['Host *', '  User global', 'Host build', '  User specific', '  Port 2222'].join(LF)
  const resolved = resolveSshHost('build', text)
  assert.equal(resolved.user, 'global') // OpenSSH's real (and surprising) behaviour
  assert.equal(resolved.port, 2222)
})

test('resolveSshHost: no matching block → HostName falls back to the alias itself', () => {
  const resolved = resolveSshHost('nowhere', SAMPLE)
  assert.equal(resolved.matched, false)
  assert.equal(resolved.hostName, 'nowhere')
  assert.equal(resolved.port, 0)
})

test('wildcards, negation and multi-pattern Host lines', () => {
  assert.equal(hostBlockMatches(['prod-*', '!prod-canary'], 'prod-web'), true)
  assert.equal(hostBlockMatches(['prod-*', '!prod-canary'], 'prod-canary'), false)
  assert.equal(hostBlockMatches(['multi-a', 'multi-b'], 'multi-b'), true)
  assert.equal(hostBlockMatches(['multi-a', 'multi-b'], 'multi-c'), false)
  assert.equal(globMatch('*.example.com', 'jump.example.com'), true)
  assert.equal(globMatch('web?', 'web1'), true)
  assert.equal(globMatch('web?', 'web12'), false)
  const resolved = resolveSshHost('prod-web', SAMPLE)
  assert.equal(resolved.hostName, '10.0.0.1')
  assert.equal(resolved.user, 'ops')
  // the negated alias matches NO positive pattern → no block applies
  assert.equal(resolveSshHost('prod-canary', SAMPLE).hostName, 'prod-canary')
})

test('parameter names and host patterns are case-insensitive, values may be quoted', () => {
  const text = ['HOST BUILD', '  hostname "9.9.9.9"', '  PORT 2200'].join(LF)
  const resolved = resolveSshHost('build', text)
  assert.equal(resolved.hostName, '9.9.9.9')
  assert.equal(resolved.port, 2200)
  assert.equal(hostBlockMatches(['BUILD'], 'build'), true)
})

test('parseProxyJump splits [user@]host[:port] hops and understands "none"', () => {
  assert.deepEqual(parseProxyJump('jump.example.com'), [{ user: '', host: 'jump.example.com', port: 0 }])
  assert.deepEqual(parseProxyJump('u@h:2222'), [{ user: 'u', host: 'h', port: 2222 }])
  assert.deepEqual(parseProxyJump('none'), [])
  assert.deepEqual(parseProxyJump('a,b'), [{ user: '', host: 'a', port: 0 }, { user: '', host: 'b', port: 0 }])
})

test('sshAliasTarget: a single ProxyJump hop is resolved through its own block', () => {
  const target = sshAliasTarget('build', { text: SAMPLE })
  assert.equal(target.host, '9.134.186.191')
  assert.equal(target.port, 36000)
  assert.equal(target.username, 'mmdev')
  assert.equal(target.privateKeyPath, expandHome('~/.ssh/build_key'))
  assert.deepEqual(target.proxy, {
    host: '10.1.1.1', port: 2200, username: 'jumper',
    privateKeyPath: '', passphrase: '', password: '',
  })
  assert.deepEqual(target.warnings, [])
})

test('sshAliasTarget: a multi-hop chain is trimmed to the first hop LOUDLY', () => {
  const text = ['Host t', '  HostName 10.9.9.9', '  ProxyJump a,b'].join(LF)
  const target = sshAliasTarget('t', { text })
  assert.equal(target.proxy.host, 'a')
  assert.equal(target.warnings.length, 1)
  assert.match(target.warnings[0], /2 hops/)
})

test('sshAliasTarget: ProxyCommand is reported, never executed', () => {
  const text = ['Host t', '  HostName 10.9.9.9', '  ProxyCommand nc -X connect %h %p'].join(LF)
  const target = sshAliasTarget('t', { text })
  assert.equal(target.proxy, undefined)
  assert.match(target.warnings.join(' '), /ProxyCommand/)
})

test('Include: relative paths resolve against ~/.ssh, globs expand, cycles stop', () => {
  // Home-agnostic io stubs: relative includes resolve against the REAL
  // homedir()/.ssh, so the fake filesystem matches on basenames.
  const files = {
    config: ['Include conf.d/*.conf', 'Include missing.conf', 'Host main', '  HostName 1.1.1.1'].join(LF),
    '10-work.conf': ['Host work', '  HostName 2.2.2.2', '  Include conf.d/10-work.conf'].join(LF),
    '20-ignored.txt': '',
  }
  const text = loadSshConfigText('/fake/.ssh/config', {
    readFile: (p) => {
      const base = path.basename(p)
      if (!(base in files)) throw new Error('ENOENT ' + p)
      return files[base]
    },
    listDir: (d) => (path.basename(d).startsWith('conf.d') ? ['10-work.conf', '20-ignored.txt'] : []),
  })
  assert.match(text, /Host main/)
  assert.match(text, /Host work/)
  const work = resolveSshHost('work', text)
  assert.equal(work.hostName, '2.2.2.2')
  // The included file includes itself again: the cycle guard must not hang.
  assert.equal(text.split('Host work').length, 2)
})

test('Include: a tilde path and an absolute path both work', () => {
  const files = { '/home/u/.ssh/extra.conf': 'Host extra' + LF + '  HostName 3.3.3.3' + LF }
  const text = loadSshConfigText('/home/u/.ssh/config', {
    readFile: (p) => (p === '/home/u/.ssh/config' ? 'Include /home/u/.ssh/extra.conf' : files[p]),
    listDir: () => [],
  })
  assert.equal(resolveSshHost('extra', text).hostName, '3.3.3.3')
})

test('a backslash continuation is joined before parsing', () => {
  const text = ['Host t', '  HostName \\', '    4.4.4.4', '  Port 2222'].join(LF)
  const resolved = resolveSshHost('t', text)
  assert.equal(resolved.hostName, '4.4.4.4')
  assert.equal(resolved.port, 2222)
})

test('resolveMachineSshConfig: alias mode inherits, explicit non-defaults override', () => {
  const base = { useSshConfig: true, host: 'build' }
  const inherited = resolveMachineSshConfig(base, { text: SAMPLE })
  assert.equal(inherited.host, '9.134.186.191')
  assert.equal(inherited.port, 36000)
  assert.equal(inherited.username, 'mmdev')

  // form defaults (port 22 / user root) mean "inherit"
  const defaults = resolveMachineSshConfig({ ...base, port: 22, username: 'root' }, { text: SAMPLE })
  assert.equal(defaults.port, 36000)
  assert.equal(defaults.username, 'mmdev')

  // an explicitly different value wins
  const overridden = resolveMachineSshConfig({ ...base, port: 2222, username: 'root', privateKeyPath: '/k', proxy: { host: 'p' } }, { text: SAMPLE })
  assert.equal(overridden.port, 2222)
  assert.equal(overridden.username, 'mmdev')
  assert.equal(overridden.privateKeyPath, '/k')
  assert.deepEqual(overridden.proxy, { host: 'p' })
})

test('resolveMachineSshConfig: no alias mode (or no host) → null', () => {
  assert.equal(resolveMachineSshConfig({ host: '1.2.3.4' }, { text: SAMPLE }), null)
  assert.equal(resolveMachineSshConfig({ useSshConfig: true, host: '  ' }, { text: SAMPLE }), null)
  assert.equal(resolveMachineSshConfig(null, { text: SAMPLE }), null)
})

test('resolveMachineSshConfig: an unmatched alias keeps the name and warns', () => {
  const resolved = resolveMachineSshConfig({ useSshConfig: true, host: 'ghost' }, { text: SAMPLE })
  assert.equal(resolved.matched, false)
  assert.equal(resolved.host, 'ghost')
  assert.match(resolved.warnings.join(' '), /no ~\/\.ssh\/config block matches/)
})

test('listAliases returns concrete aliases only, fully resolved', () => {
  const aliases = listAliases(SAMPLE).map((a) => a.alias)
  assert.ok(aliases.includes('build'))
  assert.ok(aliases.includes('multi-a'))
  assert.ok(!aliases.some((a) => a.includes('*')))
  const build = listAliases(SAMPLE).find((a) => a.alias === 'build')
  assert.equal(build.hostName, '9.134.186.191')
})

test('parseHostBlocks keeps pattern lists; importableEntries still filters wildcards', () => {
  const blocks = parseHostBlocks(SAMPLE)
  assert.deepEqual(blocks[0].patterns, ['build'])
  assert.deepEqual(blocks.find((b) => b.line === 9).patterns, ['prod-*', '!prod-canary'])
  const importable = importableEntries(SAMPLE)
  assert.ok(importable.some((e) => e.host === 'build'))
  assert.ok(!importable.some((e) => e.host.includes('*')))
})

test('loadSshConfigText on a missing file returns "" (never throws)', () => {
  assert.equal(loadSshConfigText('/definitely/missing/config'), '')
  assert.equal(resolveSshAlias('x', { file: '/definitely/missing/config' }).matched, false)
})

// ── Part B: the plugin wiring ─────────────────────────────────────────────

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1200, connectTimeoutMs: 800,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

function makeCtx() {
  const routes = new Map()
  const tools = new Map()
  const ctx = {
    effect: () => {},
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    get: (k) => (k === 'webServer' ? { register: (r) => { routes.set(r.path, r); return () => {} } } : undefined),
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes, tools }
}

async function call(routes, routePath, { method = 'POST', body = {} } = {}) {
  const route = routes.get(routePath)
  assert.ok(route, `route ${routePath} must be registered`)
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = routePath
  const res = {
    statusCode: 0, headers: {}, payload: '',
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  await route.handler(req, res)
  let json = null
  try { json = JSON.parse(res.payload) } catch { /* not JSON */ }
  return { status: res.statusCode, json }
}

/** Fake home carrying a ~/.ssh/config, plus a scratch DSH_HOME. */
function makeEnv(sshConfigText) {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'dsh-remote-sshhome-'))
  mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true })
  writeFileSync(path.join(fakeHome, '.ssh', 'config'), sshConfigText)
  const dshHome = mkdtempSync(path.join(tmpdir(), 'dsh-remote-sshh-'))
  mkdirSync(path.join(dshHome, 'remote-workspaces'), { recursive: true })
  return { fakeHome, dshHome }
}

const ALIAS_CONFIG = [
  'Host build',
  '  HostName 127.0.0.1',
  '  User mmdev',
  '  Port 1',
].join(LF)

/** Point HOME/DSH_HOME at scratch dirs, load a fresh plugin, restore after. */
async function withPlugin(sshConfigText, machines, fn) {
  const env = makeEnv(sshConfigText)
  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE
  const savedDsh = process.env.DSH_HOME
  // `DSH_REMOTE_SSH_CONFIG` OVERRIDES the home directory (that is the documented
  // precedence), and the suite sets it globally so no test can touch the real
  // ~/.ssh/config. This helper isolates via HOME instead, so it must clear the
  // override — otherwise the plugin would read the suite's temp file while the
  // fixture lives in the scratch home.
  const savedSshConfig = process.env.DSH_REMOTE_SSH_CONFIG
  try {
    process.env.HOME = env.fakeHome
    process.env.USERPROFILE = env.fakeHome
    process.env.DSH_HOME = env.dshHome
    delete process.env.DSH_REMOTE_SSH_CONFIG
    if (machines) {
      writeFileSync(path.join(env.dshHome, 'remote-workspaces', 'machines.json'), JSON.stringify(machines, null, 2))
    }
    const mod = await import(`../lib/index.js?alias=${Math.random()}`)
    const { ctx, routes, tools } = makeCtx()
    await mod.apply(ctx, { ...CONFIG })
    return await fn({ routes, tools, env, machinesFile: path.join(env.dshHome, 'remote-workspaces', 'machines.json') })
  } finally {
    for (const [k, v] of [['HOME', savedHome], ['USERPROFILE', savedProfile], ['DSH_HOME', savedDsh], ['DSH_REMOTE_SSH_CONFIG', savedSshConfig]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(env.fakeHome, { recursive: true, force: true })
    rmSync(env.dshHome, { recursive: true, force: true })
  }
}

test('sshConfigPath/expandHome follow the current home', () => {
  // Node reads `HOME` on POSIX and `USERPROFILE` on Windows, at call time —
  // set both so the assertion is platform-independent (the CI failure that
  // taught us this: ubuntu kept /home/runner with only USERPROFILE set).
  const fake = path.join(tmpdir(), 'fakehome-x')
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  // The env override wins over the home directory by design, so this test — which
  // is ABOUT the home fallback — must clear it while it runs.
  const savedOverride = process.env.DSH_REMOTE_SSH_CONFIG
  process.env.HOME = fake
  process.env.USERPROFILE = fake
  delete process.env.DSH_REMOTE_SSH_CONFIG
  try {
    assert.equal(homedir(), fake, 'os.homedir() must follow the scratch home')
    assert.equal(sshConfigPath(), path.join(fake, '.ssh', 'config'))
    assert.equal(expandHome('~/.ssh/k'), path.join(fake, '.ssh', 'k'))
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (savedOverride !== undefined) process.env.DSH_REMOTE_SSH_CONFIG = savedOverride
  }
  assert.equal(expandHome('/abs/k'), '/abs/k')
  assert.equal(expandHome('/abs/k'), '/abs/k')
})

test('the machines route exposes where an alias resolves to', async () => {
  await withPlugin(ALIAS_CONFIG, { list: [{ id: 'm1', name: 'build', host: 'build', port: 22, username: 'root', useSshConfig: true }], currentId: 'm1' }, async ({ routes }) => {
    const { status, json } = await call(routes, '/dsh-remote/machines', { method: 'GET' })
    assert.equal(status, 200)
    const m = json.machines[0]
    assert.equal(m.useSshConfig, true)
    assert.equal(m.sshConfigResolved.host, '127.0.0.1')
    assert.equal(m.sshConfigResolved.port, 1)
    assert.equal(m.sshConfigResolved.username, 'mmdev')
    // a machine with literal values has no resolution block at all
    assert.equal(m.sshConfigResolved.alias, 'build')
  })
})

test('saving an alias machine stores ONLY the alias (no HostName/user/port/key copy)', async () => {
  await withPlugin(ALIAS_CONFIG, null, async ({ routes, machinesFile }) => {
    const { status, json } = await call(routes, '/dsh-remote/machines', {
      body: { action: 'add', name: 'build', host: 'build', useSshConfig: true, port: 22, username: 'root' },
    })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    const saved = JSON.parse(readFileSync(machinesFile, 'utf8'))
    const rec = saved.list.find((m) => m.host === 'build')
    assert.ok(rec, 'the alias machine must be persisted')
    assert.equal(rec.useSshConfig, true)
    // Nothing from ~/.ssh/config was copied into the registry.
    assert.equal(rec.privateKeyPath, '')
    assert.equal(JSON.stringify(rec).includes('127.0.0.1'), false)
    assert.equal(JSON.stringify(rec).includes('mmdev'), false)
  })
})

test('editing ~/.ssh/config retargets an existing alias machine without re-importing it', async () => {
  await withPlugin(ALIAS_CONFIG, { list: [{ id: 'm1', name: 'build', host: 'build', port: 22, username: 'root', useSshConfig: true }], currentId: 'm1' }, async ({ routes, env, machinesFile }) => {
    const before = await call(routes, '/dsh-remote/machines', { method: 'GET' })
    assert.equal(before.json.machines[0].sshConfigResolved.host, '127.0.0.1')

    // The user edits ~/.ssh/config (new host, new port, new user) — exactly the
    // workflow the issue asks for: nothing to re-import.
    const configFile = path.join(env.fakeHome, '.ssh', 'config')
    writeFileSync(configFile, ['Host build', '  HostName 10.20.30.40', '  User ops', '  Port 2222'].join(LF))
    // The resolver memoises the file text for a couple of seconds.
    await new Promise((r) => setTimeout(r, 2200))

    const after = await call(routes, '/dsh-remote/machines', { method: 'GET' })
    const resolved = after.json.machines[0].sshConfigResolved
    assert.equal(resolved.host, '10.20.30.40')
    assert.equal(resolved.username, 'ops')
    assert.equal(resolved.port, 2222)
    // …and the registry itself was never touched.
    const saved = JSON.parse(readFileSync(machinesFile, 'utf8'))
    assert.equal(saved.list[0].host, 'build')
    assert.equal(JSON.stringify(saved.list[0]).includes('10.20.30.40'), false)
  })
})

test('rw_connect dials the RESOLVED host of an alias, and the registry keeps the alias', async () => {
  await withPlugin(ALIAS_CONFIG, null, async ({ routes, tools, machinesFile }) => {
    const connect = tools.get('rw_connect')
    const err = await connect.execute({ host: 'build', useSshConfig: true, save: true }, {}).then(() => null, (e) => e)
    assert.ok(err, 'connecting to port 1 with no credentials must fail')

    // Where did it actually dial? The active-machine status is built from the
    // resolved identity of ~/.ssh/config (127.0.0.1:1), not from the alias.
    const st = await call(routes, '/dsh-remote/status', { method: 'GET' })
    assert.equal(st.json.host, '127.0.0.1')
    assert.equal(st.json.port, 1)
    assert.equal(st.json.username, 'mmdev')

    // …and the registry stored nothing but the alias (issue #38).
    const saved = JSON.parse(readFileSync(machinesFile, 'utf8'))
    const rec = saved.list.find((m) => m.host === 'build')
    assert.ok(rec, 'save:true must persist the machine')
    assert.equal(rec.useSshConfig, true)
    assert.equal(JSON.stringify(rec).includes('127.0.0.1'), false)
    assert.equal(JSON.stringify(rec).includes('mmdev'), false)
  })
})

test('rw_connect with a literal host named by a Host block resolves through the file (issue #50)', async () => {
  // SUPERSEDED contract: before issue #50 this test pinned "no accidental
  // alias lookup" — a literal host was dialed verbatim and only the
  // useSshConfig flag switched resolution on. Issue #50 makes ~/.ssh/config
  // the single source for any host it NAMES: `ssh build` resolves `Host
  // build` in real ssh, and the plugin now does the same. The registry still
  // holds the literal copy as the fallback for a missing/renamed block.
  await withPlugin(ALIAS_CONFIG, null, async ({ routes, tools, machinesFile }) => {
    const connect = tools.get('rw_connect')
    await connect.execute({ host: 'build', save: true }, {}).catch(() => {})
    const st = await call(routes, '/dsh-remote/status', { method: 'GET' })
    assert.equal(st.json.host, '127.0.0.1', 'HostName from the naming block wins')
    assert.equal(st.json.port, 1, 'Port from the naming block wins over the saved 22')
    assert.equal(st.json.username, 'mmdev')
    const saved = JSON.parse(readFileSync(machinesFile, 'utf8'))
    const rec = saved.list.find((m) => m.host === 'build')
    assert.ok(rec && !rec.useSshConfig, 'the record stays a literal copy (fallback), not an alias')
  })
})
