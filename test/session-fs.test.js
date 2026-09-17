// Sidebar HTTP routes must bind to the session's machine (Desktop multi-machine
// release blocker). rw_* already do this; /ls /read /write /fs used to use the
// active-machine pool instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-fs-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  const machines = [
    { id: 'm-linux', name: 'linuxbox', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw-linux' },
    { id: 'm-win', name: 'winbox', host: '127.0.0.22', port: 1, username: 'Administrator', password: 'pw-win' },
  ]
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: machines, currentId: 'm-win' }))
  const mirror = (host, user, port, base, remotePath) => {
    const dir = path.join(root, `${host}-${user}-${port}`, base)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({ host, port, username: user, remotePath }))
    return dir
  }
  return {
    home,
    linuxCwd: mirror('127.0.0.11', 'lucas', 1, 'proj', '/home/lucas/proj'),
    winCwd: mirror('127.0.0.22', 'Administrator', 1, 'tool', 'C:\\work\\tool'),
  }
}

function makeCtx(sessions) {
  const routes = new Map()
  const tools = new Map()
  const ctx = {
    effect: () => {},
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    get: (k) => {
      if (k === 'webServer') return { register: (r) => { routes.set(r.path, r); return () => {} } }
      if (k === 'sessions') return sessions
      return undefined
    },
    tools: { register: (t) => tools.set(t.name, t) },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes, tools }
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

async function loadPlugin(home, sessions) {
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?fs=${Math.random()}`)
  const { ctx, routes } = makeCtx(sessions)
  await mod.apply(ctx, { ...CONFIG })
  return { routes }
}

async function call(routes, routePath, { method = 'GET', url, body } = {}) {
  const route = routes.get(routePath)
  assert.ok(route, `route ${routePath} must be registered`)
  const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req = Readable.from([Buffer.from(payload)])
  req.method = method
  req.url = url || routePath
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
  return { status: res.statusCode, json, rejected, raw: res.payload }
}

test('GET /ls?sessionId hits THIS session host, not the active machine', async () => {
  const { home, linuxCwd, winCwd } = makeHome()
  const sessions = {
    get: (id) => ({
      'sess-linux': { header: { cwd: linuxCwd } },
      'sess-win': { header: { cwd: winCwd } },
    }[id]),
  }
  try {
    const { routes } = await loadPlugin(home, sessions)
    const linux = await call(routes, '/dsh-remote/ls', {
      url: '/dsh-remote/ls?path=' + encodeURIComponent('/home/lucas/proj') + '&sessionId=sess-linux',
    })
    const win = await call(routes, '/dsh-remote/ls', {
      url: '/dsh-remote/ls?path=' + encodeURIComponent('C:\\work\\tool') + '&sessionId=sess-win',
    })
    assert.equal(linux.rejected, null)
    assert.equal(win.rejected, null)
    const linuxMsg = JSON.stringify(linux.json) + linux.raw
    const winMsg = JSON.stringify(win.json) + win.raw
    assert.match(linuxMsg, /127\.0\.0\.11/, `linux sidebar must target its host, got: ${linuxMsg}`)
    assert.ok(!linuxMsg.includes('127.0.0.22'), `linux sidebar leaked onto the active windows host: ${linuxMsg}`)
    assert.match(winMsg, /127\.0\.0\.22/, `windows sidebar must target its host, got: ${winMsg}`)
    assert.ok(!winMsg.includes('127.0.0.11'), `windows sidebar leaked onto the linux host: ${winMsg}`)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('POST /read|/write|/fs with a LOCAL sessionId refuse instead of using the active machine', async () => {
  const { home } = makeHome()
  const sessions = { get: () => ({ header: { cwd: '/root/some/local/repo' } }) }
  try {
    const { routes } = await loadPlugin(home, sessions)
    const cases = [
      ['/dsh-remote/read', { method: 'POST', body: { path: '/etc/hostname', sessionId: 'local-1' } }],
      ['/dsh-remote/write', { method: 'POST', body: { path: '/tmp/x', content: 'x', sessionId: 'local-1' } }],
      ['/dsh-remote/fs', { method: 'POST', body: { op: 'mkdir', path: '/tmp/n', sessionId: 'local-1' } }],
    ]
    for (const [routePath, opts] of cases) {
      const r = await call(routes, routePath, opts)
      assert.equal(r.rejected, null, `${routePath} must not reject`)
      assert.equal(r.status, 403, `${routePath} status: ${r.status} ${r.raw}`)
      assert.match(String(r.json && r.json.error), /LOCAL/, `${routePath} gave: ${r.raw}`)
      assert.ok(!/127\.0\.0\.(11|22)/.test(r.raw), `${routePath} must not connect: ${r.raw}`)
    }
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('picker /ls without sessionId still uses the active-machine pool', async () => {
  const { home } = makeHome()
  try {
    const { routes } = await loadPlugin(home, { get: () => null })
    const r = await call(routes, '/dsh-remote/ls', { url: '/dsh-remote/ls?path=/' })
    // Active machine is m-win (127.0.0.22). No session hint → that host.
    const msg = JSON.stringify(r.json) + r.raw
    assert.match(msg, /127\.0\.0\.22/)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})
