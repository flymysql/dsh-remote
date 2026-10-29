// Issue #50 — ~/.ssh/config is the single source for host/user/port/key.
//
// The design accepted in the issue thread:
//   · READ: the file wins for ANY host it names — an alias machine (issue #38)
//     always worked this way; a LITERAL machine's stored copy now follows too.
//     A bare `Host *` does not name a host (it would hijack every machine).
//   · WRITE: saving a literal machine upserts a Host block tagged
//     `# dsh-remote: managed`. Blocks without the marker are the user's and are
//     never touched — a same-named one is a reported conflict, not an overwrite.
//   · plugin state (recentWorkspaces, lastConnectedAt, latencyMs) stays in the
//     registry; only the four connection fields move to the file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MANAGED_MARK,
  resolveLiteralSshConfig,
  upsertManagedHostBlock,
  removeManagedHostBlock,
  writeSshConfig,
} from '../lib/sshconfig.js'

// ── the managed block: upsert ────────────────────────────────────────────────

test('upsert appends a tagged block, emitting only meaningful lines', () => {
  const r = upsertManagedHostBlock('', {
    alias: '9.134.186.191', hostName: '9.134.186.191', user: 'root', port: 36000, identityFile: '/home/me/.ssh/id build',
  })
  assert.equal(r.status, 'appended')
  assert.match(r.text, new RegExp('^' + MANAGED_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'))
  assert.match(r.text, /^Host 9\.134\.186\.191$/m)
  assert.match(r.text, /^ {2}User root$/m)
  assert.match(r.text, /^ {2}Port 36000$/m)
  // A path with spaces is quoted; HostName equal to the alias is noise and is
  // omitted (ssh defaults HostName to the alias).
  assert.match(r.text, /^ {2}IdentityFile "\/home\/me\/\.ssh\/id build"$/m)
  assert.doesNotMatch(r.text, /HostName/)
})

test('upsert on an existing config keeps the user\'s own blocks apart', () => {
  const raw = 'Host other\n  User someone\n'
  const r = upsertManagedHostBlock(raw, { alias: 'web', hostName: 'web', user: '', port: 22, identityFile: '' })
  assert.equal(r.status, 'appended')
  assert.ok(r.text.startsWith(raw), 'the existing content is untouched and comes first')
  assert.match(r.text, /Host other\n {2}User someone\n\n# dsh-remote: managed\nHost web\n/)
})

test('upsert rewrites only the four owned lines; user lines inside OUR block survive', () => {
  const raw = [
    MANAGED_MARK,
    'Host web',
    '  User old',
    '  Port 22',
    '  ForwardAgent yes',
    '  # keep me',
    '',
    'Host other',
    '  User x',
    '',
  ].join('\n')
  const r = upsertManagedHostBlock(raw, { alias: 'web', hostName: 'web', user: 'new', port: 2222, identityFile: '' })
  assert.equal(r.status, 'updated')
  assert.match(r.text, /^ {2}User new$/m)
  assert.match(r.text, /^ {2}Port 2222$/m)
  assert.doesNotMatch(r.text, /User old/)
  assert.match(r.text, /^ {2}ForwardAgent yes$/m, 'an unknown user line inside the managed block is kept')
  assert.match(r.text, /^ {2}# keep me$/m, 'a comment inside the managed block is kept')
  assert.match(r.text, /^Host other$/m, 'the next block is untouched')
})

test('upsert is a no-op when the managed block already says exactly this', () => {
  const raw = [MANAGED_MARK, 'Host web', '  User root', '  Port 2222', ''].join('\n')
  const r = upsertManagedHostBlock(raw, { alias: 'web', hostName: 'web', user: 'root', port: 2222, identityFile: '' })
  assert.equal(r.status, 'unchanged')
  assert.equal(r.text, raw)
})

test('a Host block the user wrote is a conflict, never an overwrite', () => {
  const raw = 'Host web\n  User mine\n'
  const r = upsertManagedHostBlock(raw, { alias: 'web', hostName: 'web', user: 'root', port: 22, identityFile: '' })
  assert.equal(r.status, 'conflict')
  assert.equal(r.text, raw, 'the file is left byte-for-byte alone')
})

test('an alias that can never be a Host token is refused', () => {
  for (const alias of ['', 'my host', 'web-*', 'a?b', 'a,b']) {
    const r = upsertManagedHostBlock('', { alias, hostName: alias, user: 'u', port: 22, identityFile: '' })
    assert.equal(r.status, 'invalid', JSON.stringify(alias))
  }
})

test('remove retires only a MANAGED block (the rename artifact), never a user block', () => {
  const raw = [
    MANAGED_MARK,
    'Host old',
    '  User root',
    '',
    'Host mine',
    '  User x',
    '',
  ].join('\n')
  const gone = removeManagedHostBlock(raw, 'old')
  assert.equal(gone.status, 'removed')
  assert.doesNotMatch(gone.text, /Host old/)
  assert.match(gone.text, /Host mine\n {2}User x/)
  const kept = removeManagedHostBlock(raw, 'mine')
  assert.equal(kept.status, 'absent', 'an unmanaged block is not ours to remove')
  assert.equal(kept.text, raw)
})

test('write creates ~/.ssh with OpenSSH permissions on POSIX', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-issue50-write-'))
  try {
    const file = path.join(dir, '.ssh', 'config')
    writeSshConfig('Host x\n', file)
    assert.equal(readFileSync(file, 'utf8'), 'Host x\n')
    if (process.platform !== 'win32') {
      // Explicit platform branch, not a silent skip: modes only exist on POSIX.
      assert.equal(statSync(file).mode & 0o777, 0o600, 'config file mode')
      assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700, '.ssh dir mode')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── read side: the file wins for any host it names ──────────────────────────

test('a concrete Host block drives a literal machine, record fills the gaps', () => {
  const text = [
    'Host 9.134.186.191',
    '  User jimmy',
    '  Port 36000',
    '  IdentityFile ~/.ssh/build_key',
    '',
  ].join('\n')
  const r = resolveLiteralSshConfig({ host: '9.134.186.191', port: 22, username: 'root' }, { text })
  assert.ok(r && r.matched)
  assert.equal(r.host, '9.134.186.191', 'no HostName → the alias itself')
  assert.equal(r.port, 36000, 'the file wins over the stored copy')
  assert.equal(r.username, 'jimmy')
  assert.ok(r.privateKeyPath.endsWith(path.join('.ssh', 'build_key')), '~ is expanded')
})

test('a bare Host * does NOT name a host — universal defaults never override a record', () => {
  const text = 'Host *\n  User admin\n  Port 2222\n'
  const r = resolveLiteralSshConfig({ host: 'web', port: 22, username: 'root' }, { text })
  assert.equal(r, null)
})

test('a group pattern names its hosts the way ssh itself applies it', () => {
  const text = 'Host *.corp\n  User deploy\n\nHost web-1.corp\n  Port 2201\n'
  const r = resolveLiteralSshConfig({ host: 'web-1.corp' }, { text })
  assert.ok(r && r.matched)
  assert.equal(r.username, 'deploy', 'the group block contributes what the concrete one does not')
  assert.equal(r.port, 2201, 'first obtained value wins across naming blocks')
})

test('port stays 0 when the file says nothing, so the record fills it', () => {
  const text = 'Host web\n  User deploy\n'
  const r = resolveLiteralSshConfig({ host: 'web' }, { text })
  assert.ok(r && r.matched)
  assert.equal(r.port, 0, '0 = fall back to the registry copy, not the ssh default')
  assert.equal(r.username, 'deploy')
})

test('unmatched hosts and alias machines resolve to null', () => {
  assert.equal(resolveLiteralSshConfig({ host: 'elsewhere' }, { text: 'Host web\n  User x\n' }), null)
  assert.equal(resolveLiteralSshConfig({ host: 'web', useSshConfig: true }, { text: 'Host web\n  User x\n' }), null,
    'alias machines take the issue-#38 path instead')
})

// ── route level: saving a machine writes the managed block ──────────────────

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-issue50-'))
  mkdirSync(path.join(home, 'remote-workspaces'), { recursive: true })
  mkdirSync(path.join(home, '.ssh'), { recursive: true })
  writeFileSync(path.join(home, 'remote-workspaces', 'machines.json'), JSON.stringify({ list: [] }))
  return home
}

function makeCtx() {
  const routes = new Map()
  const ctx = {
    effect: () => {},
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    get: (k) => (k === 'webServer' ? { register: (r) => { routes.set(r.path, r); return () => {} } } : undefined),
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes }
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

async function loadPlugin(home) {
  process.env.DSH_HOME = home
  // The ssh config path derives from the home directory; point it at the
  // throwaway one BEFORE any plugin code runs (os.homedir reads env per call).
  // `DSH_REMOTE_SSH_CONFIG` overrides the home directory by design, and the suite
  // sets it globally so no test can touch the real ~/.ssh/config — clear it here,
  // because THIS file isolates through HOME instead.
  delete process.env.DSH_REMOTE_SSH_CONFIG
  process.env.HOME = home
  process.env.USERPROFILE = home
  const mod = await import(`../lib/index.js?issue50=${Math.random()}`)
  const { ctx, routes } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  return { routes }
}

async function call(routes, routePath, method, body) {
  const route = routes.get(routePath)
  assert.ok(route, `route ${routePath} must be registered`)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = routePath
  const res = {
    statusCode: 0,
    payload: '',
    setHeader() {},
    end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: res.payload ? JSON.parse(res.payload) : {} }
}

test('saving a literal machine writes a managed Host block; editing the file then wins', async (t) => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const configFile = path.join(home, '.ssh', 'config')

    const add = await call(routes, '/dsh-remote/machines', 'POST', {
      action: 'add', host: '9.134.186.191', port: 22, username: 'root', privateKeyPath: '',
    })
    assert.equal(add.status, 200)
    assert.equal(add.json.ok, true)
    assert.ok(!add.json.sshConfigWarning, JSON.stringify(add.json.sshConfigWarning || ''))

    const written = readFileSync(configFile, 'utf8')
    assert.match(written, new RegExp(MANAGED_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\nHost 9\\.134\\.186\\.191\\n'))
    assert.match(written, /^ {2}User root$/m)
    assert.doesNotMatch(written, /Port 22\n/, 'the ssh default is not written as noise')

    // The row reports that the file drives this machine now.
    const list1 = await call(routes, '/dsh-remote/machines', 'GET')
    const row1 = list1.json.machines.find((m) => m.host === '9.134.186.191')
    assert.ok(row1.sshConfigResolved && row1.sshConfigResolved.matched, 'the literal machine resolves through the file')

    // Now the user edits the file (port 22 → 36000): the plugin must follow,
    // not the stale registry copy. The memoised text lives ~2s; sleep it out.
    writeFileSync(configFile, written.replace('User root', 'User root\n  Port 36000'))
    await new Promise((r) => setTimeout(r, 2100))
    const list2 = await call(routes, '/dsh-remote/machines', 'GET')
    const row2 = list2.json.machines.find((m) => m.host === '9.134.186.191')
    assert.equal(row2.sshConfigResolved.port, 36000, 'an edit to ~/.ssh/config takes effect (issue #50)')
    assert.equal(row2.port, 22, 'the registry copy is untouched — it is only the fallback')

    // Saving the machine again rewrites OUR block, and only it.
    const upd = await call(routes, '/dsh-remote/machines', 'POST', {
      action: 'update', id: row1.id, host: '9.134.186.191', port: 36000, username: 'jimmy', privateKeyPath: '',
    })
    assert.equal(upd.json.ok, true)
    const rewritten = readFileSync(configFile, 'utf8')
    assert.match(rewritten, /^ {2}User jimmy$/m)
    assert.match(rewritten, /^ {2}Port 36000$/m)
    assert.equal((rewritten.match(/dsh-remote: managed/g) || []).length, 1, 'still exactly one managed block')

    t.after(() => {})
  } finally {
    delete process.env.DSH_HOME
    delete process.env.HOME
    delete process.env.USERPROFILE
    rmSync(home, { recursive: true, force: true })
  }
})

test('a pre-existing user block for the same name is reported, not overwritten', async () => {
  const home = makeHome()
  try {
    const configFile = path.join(home, '.ssh', 'config')
    const mine = 'Host 10.0.0.5\n  User mine\n'
    writeFileSync(configFile, mine)
    const { routes } = await loadPlugin(home)
    const add = await call(routes, '/dsh-remote/machines', 'POST', {
      action: 'add', host: '10.0.0.5', port: 22, username: 'root', privateKeyPath: '',
    })
    assert.equal(add.json.ok, true, 'the machine itself still saves')
    assert.match(String(add.json.sshConfigWarning || ''), /not managed by dsh-remote/)
    assert.equal(readFileSync(configFile, 'utf8'), mine, 'the user block is byte-for-byte untouched')
    // …and the user's block already wins on the read side.
    const row = add.json.machines.find((m) => m.host === '10.0.0.5')
    assert.ok(row.sshConfigResolved && row.sshConfigResolved.matched)
    assert.equal(row.sshConfigResolved.username, 'mine')
  } finally {
    delete process.env.DSH_HOME
    delete process.env.HOME
    delete process.env.USERPROFILE
    rmSync(home, { recursive: true, force: true })
  }
})

test('renaming a machine retires the old managed block; deleting removes nothing', async () => {
  const home = makeHome()
  try {
    const { routes } = await loadPlugin(home)
    const configFile = path.join(home, '.ssh', 'config')
    const add = await call(routes, '/dsh-remote/machines', 'POST', {
      action: 'add', host: 'old-host', port: 22, username: 'root', privateKeyPath: '',
    })
    const id = add.json.machine.id
    assert.match(readFileSync(configFile, 'utf8'), /Host old-host/)

    const rename = await call(routes, '/dsh-remote/machines', 'POST', {
      action: 'update', id, host: 'new-host', port: 22, username: 'root', privateKeyPath: '',
    })
    assert.equal(rename.json.ok, true)
    const after = readFileSync(configFile, 'utf8')
    assert.doesNotMatch(after, /Host old-host/, 'the stale block was the plugin\'s own artifact — retired')
    assert.match(after, /Host new-host/)

    const del = await call(routes, '/dsh-remote/machines', 'POST', { action: 'delete', id })
    assert.equal(del.json.ok, true)
    assert.match(readFileSync(configFile, 'utf8'), /Host new-host/,
      'deleting a machine keeps the Host block: it is the user\'s ssh access, not plugin state')
    assert.ok(existsSync(configFile))
  } finally {
    delete process.env.DSH_HOME
    delete process.env.HOME
    delete process.env.USERPROFILE
    rmSync(home, { recursive: true, force: true })
  }
})
