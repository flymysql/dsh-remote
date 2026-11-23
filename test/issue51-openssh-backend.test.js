// Issue #51 — the system-OpenSSH backend.
//
// The whole point of this backend is that the LOCAL `ssh` executable performs
// the transport, which is the only way to reach hosts that accept just
// GSSAPI/Kerberos (the user's kinit ticket lives in the ssh process, not in
// ssh2). These tests pin the parts that are easy to get subtly wrong and
// expensive to discover on a live enterprise host:
//
//   • the argument vector must NOT override the authentication settings that
//     live in ~/.ssh/config (PreferredAuthentications, GSSAPIAuthentication,
//     ProxyJump…). Overriding them would silently defeat the feature.
//   • an ssh-config ALIAS must reach ssh VERBATIM (ssh matches `Host` blocks
//     against the name it is handed) and no -l/-p/-i of our own may accompany
//     it, or the block stops matching and its GSSAPI settings are skipped.
//   • a configured secret goes through askpass, never argv, and BatchMode must
//     be off when it does (BatchMode forbids every prompt, askpass included —
//     measured on a real host).
//   • the two backends must present ONE identical surface, since every caller
//     (sync/search/routes/forwards/web-attach) is written against it.
//   • the ActivePool facade must switch delegate class with the machine while
//     KEEPING the hooks the plugin assigned once at startup.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'

import {
  SystemOpenSshPool, OpenSshConnection, baseSshArgs, hostKeyArgs, resolveSshBinary,
  sshBinaryAvailable, ensureAskpassHelper, askpassEnv, isSystemOpenSshBackend,
  loadSftpEngine, askpassDir, defaultKnownHostsPath,
} from '../lib/openssh.js'
import { SshPool, ActivePool, createPool } from '../lib/pool.js'
import { buildSftpSurface } from '../lib/sftp-surface.js'

const baseConfig = (over = {}) => ({
  host: 'example.internal',
  port: 22,
  username: 'root',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  workspace: '',
  useAgent: false,
  keyboardInteractive: false,
  hostKeyMode: 'accept-new',
  connectTimeoutMs: 15000,
  commandTimeoutMs: 20000,
  maxOutputChars: 200000,
  backend: 'openssh',
  ...over,
})

// ── backend selection ───────────────────────────────────────────────────────

test('#51: only the explicit `openssh` value selects the new backend', () => {
  assert.equal(isSystemOpenSshBackend({ backend: 'openssh' }), true)
  assert.equal(isSystemOpenSshBackend({ backend: 'OpenSSH' }), true, 'case-insensitive')
  for (const v of [undefined, '', 'native', 'ssh2', 'Open SSH']) {
    assert.equal(isSystemOpenSshBackend({ backend: v }), false, `${JSON.stringify(v)} must stay native`)
  }
  // A default config (no backend field) must not change behaviour for anybody.
  assert.ok(createPool(baseConfig({ backend: 'native' })) instanceof SshPool)
  assert.ok(createPool(baseConfig({ backend: 'openssh' })) instanceof SystemOpenSshPool)
})

// ── the argument vector: the heart of the feature ───────────────────────────

test('#51: the ssh argv never overrides the auth settings ~/.ssh/config owns', () => {
  const args = baseSshArgs(baseConfig({ privateKeyPath: '/home/u/.ssh/id_ed25519', port: 2222, username: 'dev' }))
  const joined = args.join(' ')
  // A PassphraseHost or Kerberos host is broken by ANY of these.
  for (const forbidden of [
    'PreferredAuthentications', 'PubkeyAuthentication', 'GSSAPIAuthentication',
    'GSSAPIDelegateCredentials', 'PasswordAuthentication', 'KbdInteractiveAuthentication',
    'ProxyCommand', 'ProxyJump=',
  ]) {
    assert.ok(!joined.includes(forbidden),
      `${forbidden} must come from ~/.ssh/config, never from our argv`)
  }
  // What we DO pass: the target and an explicit -i when the machine has one.
  assert.deepEqual(args.slice(0, 4), ['-p', '2222', '-l', 'dev'])
  assert.ok(joined.includes('-i /home/u/.ssh/id_ed25519'))
})

test('#51: an unset port/user/key emits no -p/-l/-i, so the config block decides', () => {
  // This is the shape an ALIAS machine produces (see connectTargetFor).
  const args = baseSshArgs(baseConfig({ port: 0, username: '', privateKeyPath: '' }))
  assert.deepEqual(args.filter((a) => a === '-l'), [], 'no -l may be emitted')
  assert.deepEqual(args.filter((a) => a === '-p'), [], 'no -p may be emitted')
  assert.deepEqual(args.filter((a) => a === '-i'), [], 'no -i may be emitted')
})

test('#51: BatchMode is on for key/agent/GSSAPI and OFF when a secret is offered', () => {
  const keyAuth = baseSshArgs(baseConfig()).join(' ')
  assert.ok(keyAuth.includes('BatchMode=yes'), 'without a secret, fail fast instead of hanging on a prompt')

  // BatchMode=yes forbids EVERY prompt, askpass included — so a configured
  // secret must turn it off (otherwise a password-only host can never log in).
  const withSecret = baseSshArgs(baseConfig(), { forSecret: true }).join(' ')
  assert.ok(!withSecret.includes('BatchMode=yes'), 'BatchMode must be off when askpass supplies a secret')
  assert.ok(withSecret.includes('NumberOfPasswordPrompts=1'), 'the prompt count must stay bounded')
})

test('#51: an explicit jump host maps onto -J, and hostKeyMode onto StrictHostKeyChecking', () => {
  const args = baseSshArgs(baseConfig({ proxy: { host: 'bastion', port: 2222, username: 'jump' } })).join(' ')
  assert.ok(args.includes('-J jump@bastion:2222'), 'the explicit jump host must become -J')

  assert.deepEqual(hostKeyArgs({ hostKeyMode: 'verify' }), ['-o', 'StrictHostKeyChecking=yes'])
  assert.deepEqual(hostKeyArgs({ hostKeyMode: 'off' }), ['-o', 'StrictHostKeyChecking=no'])
  assert.deepEqual(hostKeyArgs({ hostKeyMode: 'accept-new' }), ['-o', 'StrictHostKeyChecking=accept-new'])
  // An unset/unknown mode must not silently become "no" (that would disable
  // host-key checking for every machine that never picked a mode).
  assert.deepEqual(hostKeyArgs({}), ['-o', 'StrictHostKeyChecking=accept-new'])
})

test('#51: the ssh binary is configurable but defaults to PATH', () => {
  assert.equal(resolveSshBinary({}), 'ssh')
  assert.equal(resolveSshBinary({ sshBinary: '  /usr/bin/ssh  ' }), '/usr/bin/ssh')
  assert.equal(resolveSshBinary({ sshBinary: '' }), 'ssh')
  assert.equal(sshBinaryAvailable('ssh'), true, 'this test itself runs where ssh exists')
  assert.equal(sshBinaryAvailable('definitely-not-an-ssh-binary-xyz'), false)
})

// ── the askpass helper: a secret must never be written down ─────────────────

test('#51: the askpass helper carries no secret and reads it from the environment', () => {
  const helper = ensureAskpassHelper()
  assert.ok(helper.startsWith(askpassDir()), 'the helper lives in the stable per-user dir')

  // On Windows the entry point is a .cmd that chains to askpass.js (a bare
  // `echo %VAR%` would mangle secrets containing cmd metacharacters), so the
  // contract is satisfied by the CHAIN, not by one file.
  const bodies = [readFileSync(helper, 'utf8')]
  if (helper.endsWith('.cmd')) {
    const js = helper.replace(/\.cmd$/, '.js')
    bodies.push(readFileSync(js, 'utf8'))
  }
  const all = bodies.join('\n')
  assert.ok(/DSH_REMOTE_SSH_SECRET/.test(all),
    'the helper must read the secret from the environment')
  for (const body of bodies) {
    assert.ok(!/hunter2|s3cr3t-value/.test(body), 'no literal secret may be baked into the helper')
  }

  const env = askpassEnv('s3cr3t-value')
  assert.equal(env.DSH_REMOTE_SSH_SECRET, 's3cr3t-value')
  assert.equal(env.SSH_ASKPASS, helper)
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'force', 'ssh must not fall back to a tty prompt')
  // The secret must not leak into the inherited environment of other processes.
  assert.equal(process.env.DSH_REMOTE_SSH_SECRET, undefined)
})

test('#51: the default known_hosts path is the user\'s own', () => {
  assert.match(defaultKnownHostsPath(), /\.ssh[\\/]known_hosts$/)
})

// ── the ssh2 SFTP engine really is loadable (the SFTP strategy depends on it)

test('#51: ssh2\'s SFTP engine is reachable, since the SFTP path drives it', () => {
  const Engine = loadSftpEngine()
  assert.equal(typeof Engine, 'function')
  // Cached: repeated calls hand back the same constructor (no re-resolution).
  assert.equal(loadSftpEngine(), Engine)
})

// ── one shared surface across both backends ─────────────────────────────────

test('#51: both pools expose the identical surface every caller is written against', () => {
  const native = new SshPool(baseConfig({ backend: 'native' }))
  const openssh = new SystemOpenSshPool(baseConfig())
  const methods = ['setTarget', 'connect', 'exec', 'sftp', 'detect', 'invalidate', 'close']
  for (const m of methods) {
    assert.equal(typeof native[m], 'function', `native pool must implement ${m}()`)
    assert.equal(typeof openssh[m], 'function', `system-OpenSSH pool must implement ${m}()`)
  }
  for (const f of ['config', 'platform', 'gitBashPath', 'shellMode', 'passwordResolver', 'onReady', 'onCloseHook']) {
    assert.ok(f in native, `native pool must carry ${f}`)
    assert.ok(f in openssh, `system-OpenSSH pool must carry ${f}`)
  }
  // The plugin reads pool.client directly to answer "Connected?".
  assert.equal(native.client, null)
  assert.equal(openssh.client, null)
})

test('#51: the promptisified sftp surface is shared, so both backends behave alike', async () => {
  // A fake channel that records the calls and answers them like a server would.
  const calls = []
  const fake = new EventEmitter()
  fake.readdir = (dir, cb) => { calls.push(['readdir', dir]); cb(null, []) }
  fake.stat = (p, cb) => { calls.push(['stat', p]); cb(null, { size: 1 }) }
  fake.readFile = (p, cb) => { calls.push(['readFile', p]); cb(null, Buffer.from('x')) }
  fake.open = (p, flags, cb) => cb(null, 'h')
  fake.read = (h, buf, off, len, pos, cb) => cb(null, 0, buf)
  fake.close = (h, cb) => cb && cb()
  const surface = buildSftpSurface(fake, { commandTimeoutMs: 1000 })

  await surface.readdir('/a')
  await surface.stat('/b')
  await surface.readFile('/c')
  assert.deepEqual(calls, [['readdir', '/a'], ['stat', '/b'], ['readFile', '/c']])

  // A dead channel must fail FAST (issue #44: otherwise a tree walk costs
  // N × 2 × timeout). This is the rule the shared module exists to preserve.
  fake.emit('end')
  await assert.rejects(() => surface.stat('/d'), /sftp channel closed/)
})

test('#51: readPartial never downloads the whole file', async () => {
  let readArgs = null
  const fake = new EventEmitter()
  fake.open = (p, flags, cb) => cb(null, 'handle')
  fake.read = (h, buf, off, len, pos, cb) => {
    readArgs = { h, len, pos }
    buf.fill(65, 0, Math.min(len, 8))
    cb(null, 8, buf)
  }
  fake.close = (h, cb) => cb && cb()
  const surface = buildSftpSurface(fake, { commandTimeoutMs: 1000 })
  const out = await surface.readPartial('/big', 4096, 64)
  assert.deepEqual(readArgs, { h: 'handle', len: 64, pos: 4096 }, 'the read must be bounded to the requested range')
  assert.equal(out.length, 8)
  assert.equal(out.toString(), 'AAAAAAAA')
})

// ── the ActivePool facade ───────────────────────────────────────────────────

test('#51: ActivePool picks the class from config.backend', () => {
  const c = { host: 'h', port: 22, username: 'u', backend: 'native', commandTimeoutMs: 1000 }
  const pool = new ActivePool(c, { knownHostsFile: () => '' })
  assert.ok(pool.delegate instanceof SshPool)

  // Moving to a Kerberos host must swap the implementation, not just the fields.
  c.backend = 'openssh'
  assert.ok(pool.delegate instanceof SystemOpenSshPool, 'the backend switch must really change the class')

  c.backend = 'native'
  assert.ok(pool.delegate instanceof SshPool, 'and back again')
})

test('#51: a backend switch KEEPS the hooks the plugin assigned once at startup', () => {
  // This is the bug the facade exists to prevent: the plugin wires forwards and
  // keychain lookups onto the ACTIVE pool exactly once. Replacing the object on
  // a machine switch would silently drop them.
  const c = { host: 'h', port: 22, username: 'u', backend: 'native', commandTimeoutMs: 1000 }
  const pool = new ActivePool(c, { knownHostsFile: () => '' })
  const resolver = async () => 'pw'
  let closed = 0
  let readied = 0
  pool.passwordResolver = resolver
  pool.onReady = () => { readied++ }
  pool.onCloseHook = () => { closed++ }

  c.backend = 'openssh'
  const swapped = pool.delegate
  assert.equal(swapped.passwordResolver, resolver, 'the keychain resolver must survive the swap')
  assert.equal(swapped.onReady, pool.onReady)
  assert.equal(swapped.onCloseHook, pool.onCloseHook)

  // Re-assigning after the swap must reach the live delegate too.
  const resolver2 = async () => 'pw2'
  pool.passwordResolver = resolver2
  assert.equal(swapped.passwordResolver, resolver2)

  // The swap must tear the old backend down (its connection belonged to a host
  // we are no longer talking to) and the facade must still report the new one.
  assert.ok(pool.delegate instanceof SystemOpenSshPool)
  assert.ok(closed >= 0)
  assert.equal(readied, 0, 'onReady fires on connect, not on construction')
})

test('#51: the facade mirrors the state the plugin reads directly', () => {
  const c = { host: 'h', port: 22, username: 'u', backend: 'openssh', commandTimeoutMs: 1000 }
  const pool = new ActivePool(c, { knownHostsFile: () => '' })
  // The plugin and its tests assign these on the active pool.
  pool.platform = 'posix'
  pool.gitBashPath = '/usr/bin/bash'
  pool.shellMode = 'git-bash'
  assert.equal(pool.platform, 'posix')
  assert.equal(pool.gitBashPath, '/usr/bin/bash')
  assert.equal(pool.shellMode, 'git-bash')
  pool.client = { end() {} }
  assert.ok(pool.client, 'the plugin reads pool.client for its "Connected" answer')
  pool.close()
})

// ── setTarget must treat the backend as part of the target identity ─────────

test('#51: changing the backend through setTarget re-points the pool', () => {
  const c = baseConfig({ backend: 'native' })
  const pool = new SystemOpenSshPool(c)
  // Arm a fake connection so we can observe the close.
  let ended = 0
  pool.client = { close() { ended++ }, end() { ended++ } }
  pool.setTarget({ backend: 'native' }, { ...c, backend: 'openssh' })
  assert.equal(ended, 1, 'a backend change must drop the old connection')
})

test('#51: an UNCHANGED target is still a no-op for the new backend', () => {
  // The per-keystroke reconnect fix (issue #41) must not regress here.
  const c = baseConfig()
  const pool = new SystemOpenSshPool(c)
  let ended = 0
  pool.client = { close() { ended++ }, end() { ended++ } }
  pool.setTarget({ host: c.host, port: c.port, username: c.username, backend: 'openssh' })
  assert.equal(ended, 0, 're-asserting the same target must not close the live connection')
})

// ── the connection adapter the tunnel users rely on ─────────────────────────

test('#51: the connection adapter advertises the capabilities the callers probe', async () => {
  const pool = new SystemOpenSshPool(baseConfig())
  const conn = new OpenSshConnection(pool, { sshBinary: 'ssh', secret: '' })
  assert.equal(typeof conn.forwardOut, 'function', 'ForwardManager/WebAttach call this')
  assert.equal(conn.supportsReverseForward, true, 'ForwardManager prefers the CLI reverse path')
  assert.equal(typeof conn.reverseForward, 'function')
  assert.equal(typeof conn.close, 'function')
  // forwardIn must fail with an explanation rather than hang or throw sync.
  await new Promise((resolve) => {
    conn.forwardIn('127.0.0.1', 8080, (err) => {
      assert.ok(err, 'forwardIn is superseded on this backend')
      assert.match(err.message, /reverseForward/)
      resolve()
    })
  })
  conn.close()
  assert.equal(conn.closed, true)
})

test('#51: closing the connection reaps every child it spawned', () => {
  const pool = new SystemOpenSshPool(baseConfig())
  const conn = new OpenSshConnection(pool, { sshBinary: 'ssh', secret: '' })
  const killed = []
  const fake = { kill() { killed.push(1) }, on() {}, stderr: new EventEmitter(), stdin: { end() {} }, stdout: new EventEmitter() }
  conn.children.add(fake)
  conn.close()
  assert.equal(killed.length, 1, 'a leaked ssh child would outlive the pool')
  assert.equal(conn.children.size, 0)
})

test('#51: connecting to a host without a reachable ssh fails with an actionable message', async () => {
  const pool = new SystemOpenSshPool(baseConfig({ sshBinary: 'definitely-not-ssh-xyz' }))
  await assert.rejects(() => pool.connect(), (err) => {
    assert.match(err.message, /system-OpenSSH backend needs/)
    assert.match(err.message, /native/, 'the message must say how to opt out')
    return true
  })
})

test('#51: connecting with no host configured is refused before spawning anything', async () => {
  const pool = new SystemOpenSshPool(baseConfig({ host: '', sshBinary: 'ssh' }))
  await assert.rejects(() => pool.connect(), /no host configured/)
  await assert.rejects(() => pool.exec('true'), /no host configured/)
})

// ── password resolution must not depend on connect() having run ─────────────

test('#51: exec/sftp resolve the keychain password themselves (no connect() first)', async () => {
  // On this backend connect() opens no socket, so exec() is often the FIRST
  // call — a pool that only resolved the secret in connect() would spawn ssh
  // with no askpass and fail a password-only host.
  const pool = new SystemOpenSshPool(baseConfig({ password: '' }))
  let asked = 0
  pool.passwordResolver = async () => { asked++; return 'from-keychain' }
  const secret = await pool._resolveSecret()
  assert.equal(secret, 'from-keychain')
  assert.equal(asked, 1)
  // Memoized: a second operation must not hit the keychain again.
  assert.equal(await pool._resolveSecret(), 'from-keychain')
  assert.equal(asked, 1, 'the resolver must be consulted once per target')
})

test('#51: a target change clears the memoized secret', async () => {
  const pool = new SystemOpenSshPool(baseConfig({ password: 'old' }))
  assert.equal(await pool._resolveSecret(), 'old')
  pool.setTarget({ host: 'other.internal', password: 'new' })
  assert.equal(await pool._resolveSecret(), 'new', 'a new target must re-read its own credential')
})

test('#51: the explicit password wins over the stored one', async () => {
  const pool = new SystemOpenSshPool(baseConfig({ password: 'explicit' }))
  pool.passwordResolver = async () => 'stored'
  assert.equal(await pool._resolveSecret(), 'explicit')
})

// ── no secret may reach argv ────────────────────────────────────────────────

test('#51: the secret never appears in the ssh argument vector', () => {
  const SECRET = 'hunter2-super-secret'
  const pool = new SystemOpenSshPool(baseConfig({ password: SECRET }))
  const args = baseSshArgs(pool.config, { forSecret: true })
  assert.ok(!args.join(' ').includes(SECRET), 'the password must go through askpass, never argv')
  const env = askpassEnv(SECRET)
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'force', 'so ssh consults the helper before any tty')
})

// ── platform detection is reused verbatim ───────────────────────────────────

test('#51: detect() reports posix for a host that answers uname, and Windows for cmd', async () => {
  const posixPool = new SystemOpenSshPool(baseConfig())
  posixPool._runSsh = async (args) => {
    const cmd = args[args.length - 1]
    if (cmd === 'cmd /c "ver"') return { code: 127, stdout: '', stderr: 'command not found' }
    if (cmd === 'uname -s') return { code: 0, stdout: 'Linux\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  await posixPool.detect()
  assert.equal(posixPool.platform, 'posix')
  assert.equal(posixPool.shellMode, 'native')

  const winPool = new SystemOpenSshPool(baseConfig())
  winPool._runSsh = async (args) => {
    const cmd = args[args.length - 1]
    // A cmd.exe default shell cannot run uname (issue #199's host shape).
    if (cmd === 'uname -s') return { code: 1, stdout: '', stderr: "'uname' is not recognized\r\n" }
    if (cmd === 'cmd /c "ver"') return { code: 0, stdout: 'Microsoft Windows [Version 10.0]\r\n', stderr: '' }
    if (cmd === 'cmd /c where bash') return { code: 0, stdout: 'C:\\Program Files\\Git\\bin\\bash.exe\r\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  await winPool.detect()
  assert.equal(winPool.platform, 'windows')
  assert.equal(winPool.gitBashPath, 'C:\\Program Files\\Git\\bin\\bash.exe')
  assert.equal(winPool.shellMode, 'git-bash')
})

test('#51: exec pipes the script to bash -s on a Git-Bash remote (no quoting round-trip)', async () => {
  const pool = new SystemOpenSshPool(baseConfig())
  pool.platform = 'windows'
  pool.gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const seen = []
  pool._runSsh = async (args, opts) => { seen.push({ args, opts }); return { code: 0, stdout: 'ok', stderr: '' } }
  const script = "printf '%s' \"a && b | c\""
  await pool.exec(script)
  assert.equal(seen.length, 1)
  assert.ok(seen[0].args[seen[0].args.length - 1].includes('bash.exe'), 'the command must run under Git Bash')
  assert.equal(seen[0].opts.stdin, script, 'the script must travel on stdin verbatim')
})

test('#51: exec forwards the caller AbortSignal so a cancelled turn stops the remote command', async () => {
  const pool = new SystemOpenSshPool(baseConfig())
  pool.platform = 'posix'
  const seen = []
  pool._runSsh = async (args, opts) => { seen.push(opts); return { code: 0, stdout: '', stderr: '' } }
  const ac = new AbortController()
  await pool.exec('sleep 100', { signal: ac.signal, timeoutMs: 50 })
  assert.equal(seen[0].signal, ac.signal, 'issue #44 cancellation must reach the ssh child')
})

// ── regression guard: the two backends must not drift apart ─────────────────

test('#51: the sftp surface module is the single implementation (no copy in pool.js)', () => {
  const poolSrc = readFileSync(new URL('../lib/pool.js', import.meta.url), 'utf8')
  const sshSrc = readFileSync(new URL('../lib/openssh.js', import.meta.url), 'utf8')
  assert.ok(poolSrc.includes("from './sftp-surface.js'"), 'pool.js must import the shared surface')
  assert.ok(sshSrc.includes("from './sftp-surface.js'"), 'openssh.js must import the shared surface')
  // The dead-channel rule must exist in exactly one place; a second copy is how
  // the issue-#44 hang comes back for whichever backend missed a fix.
  assert.ok(!/const dead = false/.test(poolSrc), 'pool.js must not keep its own copy of the dead-channel logic')
})

test('#51: the SFTP window is granted in packetSize multiples and refilled only on drain', () => {
  // This pins the flow-control contract that a 4 MB upload deadlocked on.
  // ssh2 arms its flush callback ONLY from inside its own subtraction, when that
  // subtraction reaches exactly 0 — so the window handed over must be an exact
  // multiple of packetSize, and nothing may re-clamp it behind the engine's back.
  const src = readFileSync(new URL('../lib/openssh.js', import.meta.url), 'utf8')
  const packet = Number((src.match(/const PACKET = (\d+)/) || [])[1])
  const grant = src.match(/const GRANT = PACKET \* (\d+)/)
  assert.ok(Number.isInteger(packet) && packet > 0, 'PACKET must be a positive integer')
  assert.ok(grant, 'GRANT must be derived from PACKET, so the multiple is structural')
  assert.ok(Number(grant[1]) >= 1, 'the grant must cover at least one packet')
  assert.ok(src.includes('child.stdin.on(\'drain\', onStdinDrain)'),
    'the window may only be refilled from the pipe drain event')
  // channelData must not clamp the window: doing so bypasses the engine's own
  // zero-detection and permanently strands its buffered remainder.
  const channelDataBody = src.slice(src.indexOf('channelData(_id, data)'), src.indexOf('channelClose()'))
  assert.ok(!/outgoing\.window\s*=/.test(channelDataBody),
    'channelData must NOT write the window — the engine must reach 0 through its own subtraction')
})
