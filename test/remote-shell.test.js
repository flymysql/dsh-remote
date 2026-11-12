import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import {
  SHELL_OPTION_NAME,
  addShellCandidate,
  appendPathEntry,
  installTerminalShell,
  launcherSource,
  resolveThroughPath,
  runtimeNodeCandidates,
  shellCandidate,
  shellLauncherPath,
  writeLauncher,
} from '../lib/remote-shell.js'

const require = createRequire(import.meta.url)
const child = require('../lib/remote-shell-child.cjs')

// ── launcher files ─────────────────────────────────────────────────────────

test('the launcher name is what the shell menu shows, per platform', () => {
  assert.equal(SHELL_OPTION_NAME, 'remote ssh')
  assert.equal(shellLauncherPath('/tmp/shell', 'win32'), path.join('/tmp/shell', 'remote ssh.cmd'))
  assert.equal(shellLauncherPath('/tmp/shell', 'darwin'), path.join('/tmp/shell', 'remote ssh'))
  assert.equal(shellLauncherPath('/tmp/shell', 'linux'), path.join('/tmp/shell', 'remote ssh'))
})

test('the Windows launcher bakes node, falls back to node on PATH, then to Electron', () => {
  const source = launcherSource({
    platform: 'win32',
    nodePath: 'C:\\dsh\\node.exe',
    electronPath: 'C:\\dsh\\Harness.exe',
    childPath: 'C:\\pkg\\lib\\remote-shell-child.cjs',
    machinesFile: 'C:\\home\\machines.json',
  })
  assert.match(source, /@echo off/)
  assert.match(source, /set "DSH_NODE=C:\\dsh\\node\.exe"/)
  // A missing bundled node must not kill the terminal: `where node` comes next.
  assert.match(source, /for \/f "delims=" %%N in \('where node 2\^>nul'\)/)
  // …and the last resort re-enters the Electron binary as node.
  assert.match(source, /set "ELECTRON_RUN_AS_NODE=1"/)
  assert.match(source, /"C:\\dsh\\Harness\.exe" "%DSH_CHILD%" --machines "%DSH_MACHINES%"/)
  assert.match(source, /"%DSH_NODE%" "%DSH_CHILD%" --machines "%DSH_MACHINES%"/)
  // Windows needs CRLF, or cmd mis-parses labels and the `for` body.
  assert.ok(source.includes('\r\n'))
})

test('a launcher without a known interpreter still explains the failure', () => {
  const source = launcherSource({
    platform: 'win32',
    childPath: 'C:\\pkg\\child.cjs',
    machinesFile: 'C:\\m.json',
  })
  assert.match(source, /no node interpreter found/)
  assert.match(source, /DSH_REMOTE_TERMINAL_NODE/)
  assert.match(source, /exit \/b 127/)
  // Nothing to re-enter on a plain node install: no empty `if exist ""` line and
  // no quoted-empty program, which cmd would treat as a missing command.
  assert.ok(!source.includes('ELECTRON_RUN_AS_NODE'))
  assert.ok(!source.includes('"" '))
})

test('the POSIX launcher quotes paths and execs node', () => {
  const source = launcherSource({
    platform: 'linux',
    nodePath: '/usr/bin/node',
    childPath: "/pkg/it's/child.cjs",
    machinesFile: '/root/m.json',
  })
  assert.match(source, /^#!\/bin\/sh/)
  assert.match(source, /DSH_NODE='\/usr\/bin\/node'/)
  // A single quote inside a single-quoted string must be closed, escaped, reopened.
  assert.match(source, /DSH_CHILD='\/pkg\/it'\\''s\/child\.cjs'/)
  assert.match(source, /exec "\$DSH_NODE" "\$DSH_CHILD" --machines "\$DSH_MACHINES"/)
})

test('writeLauncher creates the directory, writes the file and marks it executable', () => {
  const calls = []
  const fs = {
    mkdirSync: (dir, options) => calls.push(['mkdir', dir, options]),
    writeFileSync: (file, data) => calls.push(['write', file, data]),
    chmodSync: (file, mode) => calls.push(['chmod', file, mode]),
  }
  const result = writeLauncher({
    dir: '/root/shell',
    platform: 'linux',
    childPath: '/pkg/child.cjs',
    machinesFile: '/root/m.json',
    fs,
  })
  assert.equal(result.path, path.join('/root/shell', 'remote ssh'))
  assert.deepEqual(calls[0], ['mkdir', '/root/shell', { recursive: true }])
  assert.deepEqual(calls[1].slice(0, 2), ['write', path.join('/root/shell', 'remote ssh')])
  assert.deepEqual(calls[2], ['chmod', path.join('/root/shell', 'remote ssh'), 0o755])
})

test('Windows launchers are not chmodded', () => {
  const calls = []
  writeLauncher({
    dir: 'C:\\shell',
    platform: 'win32',
    childPath: 'C:\\pkg\\child.cjs',
    machinesFile: 'C:\\m.json',
    fs: {
      mkdirSync: () => {},
      writeFileSync: (file) => calls.push(['write', path.basename(file)]),
      chmodSync: () => calls.push(['chmod']),
    },
  })
  // launcher .cmd + term-askpass.cjs + term-askpass.cmd; Windows has no
  // execute bit, so nothing is chmodded.
  assert.deepEqual(calls, [['write', 'remote ssh.cmd'], ['write', 'term-askpass.cjs'], ['write', 'term-askpass.cmd']])
})

test('a failed write is reported rather than swallowed', () => {
  assert.throws(() => writeLauncher({
    dir: '/root/shell',
    platform: 'linux',
    childPath: '/pkg/child.cjs',
    machinesFile: '/root/m.json',
    fs: { mkdirSync: () => {}, writeFileSync: () => { throw new Error('EACCES') }, chmodSync: () => {} },
  }), /EACCES/)
})

test('runtime node candidates are filtered to interpreters that exist', () => {
  const found = runtimeNodeCandidates({
    platform: 'win32',
    execPath: 'C:\\Programs\\Harness\\Harness.exe',
    resourcesPath: 'C:\\Programs\\Harness\\resources',
    env: { DSH_REMOTE_TERMINAL_NODE: 'C:\\custom\\node.exe' },
  })
  // Nothing on this machine matches, so the list is empty rather than imaginary.
  assert.deepEqual(found, [])
})

test('a plain node install offers its own executable', () => {
  const execPath = process.execPath
  const found = runtimeNodeCandidates({ platform: process.platform, execPath, env: {}, electron: false })
  assert.ok(found.includes(execPath), `expected ${execPath} in ${JSON.stringify(found)}`)
})

// ── registering the option ─────────────────────────────────────────────────

test('the shell entry is appended live and taken back on dispose', () => {
  const config = { shellCandidates: ['cmd', 'powershell'] }
  const undo = addShellCandidate({ config }, 'C:\\shell\\remote ssh.cmd')
  assert.deepEqual(config.shellCandidates, ['cmd', 'powershell', 'C:\\shell\\remote ssh.cmd'])
  assert.equal(typeof undo, 'function')
  undo()
  assert.deepEqual(config.shellCandidates, ['cmd', 'powershell'])
})

test('a host without a shell list is left untouched', () => {
  assert.equal(addShellCandidate({ config: {} }, '/x'), null)
  assert.equal(addShellCandidate({}, '/x'), null)
  assert.equal(addShellCandidate(null, '/x'), null)
  assert.equal(addShellCandidate({ config: { shellCandidates: 'nope' } }, '/x'), null)
})

test('the entry is not added twice, and undo cannot remove someone else copy', () => {
  const config = { shellCandidates: ['/x'] }
  assert.equal(addShellCandidate({ config }, '/x'), null)
  assert.deepEqual(config.shellCandidates, ['/x'])
})

test('a host that exposes a read-only shell list fails loudly, not silently', () => {
  const config = { shellCandidates: Object.freeze(['cmd']) }
  // Nothing appears in the menu either way; the difference is whether the caller
  // gets a chance to log why.
  assert.throws(() => addShellCandidate({ config }, '/x'), TypeError)
})

// ── resolving the target from the working directory ────────────────────────

function fakeFs(files) {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readJsonFile: (p) => files[p],
  }
}

/**
 * The root of THIS runner's filesystem (`C:\` on Windows, `/` elsewhere).
 * Walk-up tests need absolute paths: `findMirror` resolves its starting
 * directory, so a drive-relative spelling like `C:x` means a different
 * absolute path per runner and the mocked marker keys never match.
 */
function fsRoot() {
  return path.parse(process.cwd()).root
}

test('the mirror marker is found from a subdirectory of the checkout', () => {
  const root = path.join(fsRoot(), 'home', 'remote-workspaces', 'host-user-22', 'proj')
  const nested = path.join(root, 'src', 'lib')
  const deps = fakeFs({
    [path.join(root, '.dsh-remote-meta.json')]: { host: 'host', username: 'user', remotePath: '/srv/proj' },
  })
  const found = child.findMirror(nested, deps)
  assert.ok(found)
  assert.equal(found.dir, root)
  assert.equal(found.meta.remotePath, '/srv/proj')
})

test('a directory outside any checkout resolves to nothing', () => {
  const found = child.findMirror(path.join(fsRoot(), 'work', 'local'), { exists: () => false })
  assert.equal(found, null)
})

test('an unreadable marker is skipped instead of aborting the walk', () => {
  const root = path.join(fsRoot(), 'a')
  const deps = {
    exists: (p) => p === path.join(root, '.dsh-remote-meta.json'),
    readJsonFile: () => undefined,
  }
  assert.equal(child.findMirror(path.join(root, 'src'), deps), null)
})

test('a saved connection is matched by ssh alias first, then host/user/port', () => {
  const list = [
    { host: 'detsim-alias', username: 'root', port: 22, useSshConfig: true },
    { host: 'other', username: 'ubuntu', port: 2222 },
  ]
  assert.equal(child.matchMachine({ host: '10.0.0.5', alias: 'detsim-alias' }, { list }), list[0])
  assert.equal(child.matchMachine({ host: 'other', username: 'ubuntu', port: 2222 }, { list }), list[1])
  // Port defaults to 22 on both sides, so a marker without one still matches.
  assert.equal(child.matchMachine({ host: 'other', username: 'ubuntu' }, { list }), undefined)
})

test('resolveTarget merges the marker with the saved connection', () => {
  const root = path.join(fsRoot(), 'home', 'remote-workspaces', 'h-u-22', 'proj')
  const marker = path.join(root, '.dsh-remote-meta.json')
  const machines = { list: [{ host: 'h', username: 'u', port: 22, privateKeyPath: 'C:\\k', workspace: '/srv/proj' }] }
  const resolved = child.resolveTarget({
    cwd: root,
    machines: 'C:\\m.json',
    exists: (p) => p === marker,
    readJsonFile: (p) => (p === marker ? { host: 'h', username: 'u', remotePath: '/srv/proj' } : machines),
  })
  assert.equal(resolved.found, true)
  assert.equal(resolved.target.host, 'h')
  assert.equal(resolved.target.remotePath, '/srv/proj')
  assert.equal(resolved.machine.privateKeyPath, 'C:\\k')
})

// ── building the ssh invocation ────────────────────────────────────────────

test('the remote command keeps ~ for the remote shell to expand', () => {
  assert.equal(child.remoteCd(''), 'cd "$HOME"')
  assert.equal(child.remoteCd('~'), 'cd "$HOME"')
  assert.equal(child.remoteCd('~/'), 'cd "$HOME"')
  assert.equal(child.remoteCd('~/proj'), `cd "$HOME"/'proj'`)
  assert.equal(child.remoteCd('/srv/my proj'), `cd '/srv/my proj'`)
  // A quote inside the path must not end the quoting.
  assert.equal(child.remoteCd("/srv/it's"), `cd '/srv/it'\\''s'`)
})

test('the remote command crosses the login shell through sh -c, then execs the user shell', () => {
  const inner = 'cd ' + "'/srv/proj'" + ' 2>/dev/null || cd "$HOME"; exec "${SHELL:-/bin/bash}" -l'
  const expected = `sh -c '${inner.replace(/'/g, "'\\''")}'`
  const command = child.remoteCommand('/srv/proj')
  assert.equal(command, expected)
  assert.match(command, /^sh -c '/, 'sshd only has to parse one explicit sh invocation')
  assert.match(command, /exec "\$\{SHELL:-\/bin\/bash\}" -l'$/, 'the interactive shell remains the user\'s own')
})

test('a key-authenticated connection passes the key and the port', () => {
  const args = child.buildSshArgs(
    { host: '10.0.0.5', port: 2222, username: 'ubuntu', remotePath: '/srv/proj' },
    { host: '10.0.0.5', username: 'ubuntu', port: 2222, privateKeyPath: 'C:\\keys\\id' },
  )
  assert.equal(args[0], '-tt')
  assert.deepEqual(args.slice(1, 5), ['-p', '2222', '-i', 'C:\\keys\\id'])
  assert.equal(args[5], 'ubuntu@10.0.0.5')
  assert.match(args[6], /exec "\$\{SHELL:-\/bin\/bash\}" -l/)
})

test('the default port is left implicit, and an agent connection passes no key', () => {
  const args = child.buildSshArgs(
    { host: 'h', port: 22, username: 'u', remotePath: '/p' },
    { host: 'h', username: 'u', port: 22, privateKeyPath: 'C:\\k', useAgent: true },
  )
  assert.ok(!args.includes('-p'))
  assert.ok(!args.includes('-i'))
  assert.equal(args[1], 'u@h')
})

test('an ssh-config alias is delegated whole to ssh', () => {
  const args = child.buildSshArgs(
    { host: 'detsim', port: 2222, username: 'root', alias: 'detsim', remotePath: '/srv' },
    { host: 'detsim', useSshConfig: true, port: 2222, privateKeyPath: 'C:\\k' },
  )
  // The alias carries host/port/key/user in ~/.ssh/config; re-stating them here
  // would override whatever the user configured there.
  assert.deepEqual(args.slice(0, 2), ['-tt', 'detsim'])
  assert.ok(!args.includes('-p'))
  assert.ok(!args.includes('-i'))
})

test('a marker without a user still produces a usable target', () => {
  const args = child.buildSshArgs({ host: 'h', port: 22, username: '', remotePath: '' })
  assert.equal(args[1], 'h')
})

test('-tt stays first so a jump host can never become an option value', () => {
  const args = child.buildSshArgs({ host: 'h', port: 22, username: 'u', remotePath: '' })
  // Exact shape on purpose: one option that owns no value, then the
  // destination, then the command. Splicing anything between an `-o` and its
  // value is what turned `-J` into ssh's option argument (issue #21).
  assert.deepEqual(args, ['-tt', 'u@h', child.remoteCommand('')])
})

// ── platform availability ──────────────────────────────────────────────────
//
// The contribution is per host platform: each one generates a launcher the host
// terminal will start, resolves an interpreter from that platform's Electron
// layout, and reaches the remote through a shell the remote can actually parse.
// These tests walk all three host platforms rather than the one this checkout
// happens to run on.

const HOST_PLATFORMS = [
  { platform: 'win32', launcher: 'remote ssh.cmd', executable: false, crlf: true },
  { platform: 'darwin', launcher: 'remote ssh', executable: true, crlf: false },
  { platform: 'linux', launcher: 'remote ssh', executable: true, crlf: false },
]

/** Minimal stand-in for the plugin context: `effect` runs immediately. */
function fakeContext() {
  const effects = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => { effects.push(fn()) },
  }
  return { ctx, effects }
}

/** A private environment object, so a test never edits the runner's own PATH. */
function fakeEnv() {
  return {
    Path: process.env.Path || process.env.PATH || '',
    PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
  }
}

/** A throwaway directory for the launcher, cleaned up by the caller. */
function launcherDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-shell-'))
  return {
    dir,
    spec: {
      dir,
      childPath: path.join(dir, 'child.cjs'),
      machinesFile: path.join(dir, 'machines.json'),
      electron: false,
      env: fakeEnv(),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('a launcher left under the old spelling is replaced, not shadowed', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-rename-'))
  try {
    // The label is the file name, so a rename is a file rename. On NTFS and
    // default APFS the old spelling is the SAME directory entry, which would
    // swallow the write and leave the menu showing the previous name.
    const stale = shellLauncherPath(dir, process.platform).replace(/remote ssh/i, 'Remote SSH')
    writeFileSync(stale, 'stale')
    const wrote = writeLauncher({
      dir,
      platform: process.platform,
      childPath: path.join(dir, 'child.cjs'),
      machinesFile: path.join(dir, 'machines.json'),
      nodePath: '',
    })
    // Exactly one launcher survives, under the current spelling (alongside the
    // credential-bridge helper pair, which is rewritten alongside).
    const wrapperName = process.platform === 'win32' ? 'term-askpass.cmd' : 'term-askpass'
    assert.deepEqual(readdirSync(dir).sort(), [path.basename(wrote.path), wrapperName, 'term-askpass.cjs'].sort())
    assert.match(readFileSync(wrote.path, 'utf8'), /Generated by dsh-remote/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('each host platform writes a launcher the terminal can start', () => {
  for (const host of HOST_PLATFORMS) {
    const calls = []
    const fs = {
      mkdirSync: () => {},
      writeFileSync: (file, data) => calls.push(['write', file, data]),
      chmodSync: (file, mode) => calls.push(['chmod', file, mode]),
    }
    const wrote = writeLauncher({
      dir: '/opt/dsh/remote-terminal',
      childPath: '/pkg/child.cjs',
      machinesFile: '/home/.dsh/machines.json',
      platform: host.platform,
      nodePath: host.platform === 'win32' ? 'C:\\dsh\\node.exe' : '/usr/bin/node',
      fs,
    })
    assert.equal(path.basename(wrote.path), host.launcher, host.platform)
    const [[kind, file, data], ...rest] = calls
    assert.equal(kind, 'write')
    assert.equal(file, wrote.path)
    // The credential-bridge helpers are written right after the launcher
    // (writeLauncher calls writeTermSecretHelpers), and on POSIX the wrapper
    // gets its own execute bit.
    const helperWrites = rest.filter((c) => c[0] === 'write').map((c) => path.basename(c[1])).sort()
    assert.deepEqual(helperWrites, ['term-askpass', 'term-askpass.cjs'].map((n) => (host.platform === 'win32' && n === 'term-askpass' ? 'term-askpass.cmd' : n)).sort(), host.platform)
    if (host.executable) {
      // The host gates its shell list on X_OK, which is a real bit on POSIX —
      // and the askpass wrapper is itself exec'd by ssh, so it needs one too.
      const chmods = rest.filter((c) => c[0] === 'chmod')
      assert.deepEqual(chmods, [['chmod', wrote.path, 0o755], ['chmod', wrote.askpass, 0o755]], host.platform)
    } else {
      // Windows has no execute bit, so a chmod there would mean nothing.
      assert.deepEqual(rest.filter((c) => c[0] === 'chmod'), [], host.platform)
    }
    // cmd mis-parses a bare LF inside `for /f`; sh keeps a CR as part of a word.
    if (host.crlf) assert.ok(!/(?<!\r)\n/.test(data), 'Windows launcher must end lines with CRLF')
    else assert.ok(!data.includes('\r'), 'POSIX launcher must not contain CR')
  }
})

test('the bundled interpreter is found in each platform Electron layout', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-layout-'))
  try {
    for (const host of HOST_PLATFORMS) {
      const exe = host.platform === 'win32' ? 'node.exe' : 'node'
      const resourcesPath = path.join(base, host.platform, host.platform === 'win32' ? 'resources' : 'Resources')
      const node = path.join(resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', exe)
      mkdirSync(path.dirname(node), { recursive: true })
      writeFileSync(node, '')
      const found = runtimeNodeCandidates({
        platform: host.platform,
        resourcesPath,
        execPath: '',
        env: {},
      })
      assert.deepEqual(found, [node], host.platform)
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the macOS bundle is derived from the executable path, not the Windows layout', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-macos-'))
  try {
    const contents = path.join(base, 'Harness.app', 'Contents')
    const node = path.join(contents, 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node')
    mkdirSync(path.dirname(node), { recursive: true })
    writeFileSync(node, '')
    const execPath = path.join(contents, 'MacOS', 'Harness')
    // No resourcesPath supplied: the interpreter still has to be found beside
    // the bundle, where Electron puts it on macOS.
    const found = runtimeNodeCandidates({ platform: 'darwin', execPath, resourcesPath: '', env: {}, electron: true })
    assert.deepEqual(found, [node])
    // The sibling-of-executable `resources/` layout is a Windows/Linux thing.
    assert.ok(!found.some((p) => p.includes(path.join('MacOS', 'resources'))))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ── issue #91: DSH NEXT 2.x nests the runtime under an arch directory ────────

test('the bundled interpreter is found under the DSH NEXT 2.x arch segment', () => {
  // `resources/runtime/x64/primary-runtime/…` — the layout issue #91 hit,
  // where the arch-less candidate misses and the launcher fell through to the
  // Electron masquerade.
  const base = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-arch-'))
  try {
    for (const host of HOST_PLATFORMS) {
      const exe = host.platform === 'win32' ? 'node.exe' : 'node'
      const resourcesPath = path.join(base, host.platform, 'resources')
      const node = path.join(resourcesPath, 'runtime', process.arch, 'primary-runtime', 'dependencies', 'node', 'bin', exe)
      mkdirSync(path.dirname(node), { recursive: true })
      writeFileSync(node, '')
      const found = runtimeNodeCandidates({
        platform: host.platform,
        resourcesPath,
        execPath: '',
        env: {},
      })
      assert.deepEqual(found, [node], host.platform)
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the arch-specific runtime wins over the legacy layout and other arch dirs', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-arch-order-'))
  try {
    const resourcesPath = path.join(base, 'resources')
    const make = (...segments) => {
      const node = path.join(resourcesPath, 'runtime', ...segments, 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
      mkdirSync(path.dirname(node), { recursive: true })
      writeFileSync(node, '')
      return node
    }
    const legacy = make()
    // The "other" arch must differ from this runner's arch, otherwise the two
    // paths coincide and dedup collapses them (the macOS CI leg is arm64).
    const otherArch = make(process.arch === 'arm64' ? 'x64' : 'arm64')
    const exactArch = make(process.arch)
    const found = runtimeNodeCandidates({ platform: 'win32', resourcesPath, execPath: '', env: {} })
    // Preference order: this arch, then the pre-2.x layout, then any other
    // arch directory (renamed segments still resolve instead of Electron).
    assert.deepEqual(found, [exactArch, legacy, otherArch])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a renamed arch segment still resolves through the runtime scan', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-arch-renamed-'))
  try {
    const resourcesPath = path.join(base, 'resources')
    const node = path.join(resourcesPath, 'runtime', 'win-x64', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    mkdirSync(path.dirname(node), { recursive: true })
    writeFileSync(node, '')
    const found = runtimeNodeCandidates({ platform: 'win32', resourcesPath, execPath: '', env: {} })
    assert.deepEqual(found, [node])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the Electron fallback prints its hint BEFORE running, not after exit /b', () => {
  const source = launcherSource({
    platform: 'win32',
    nodePath: '',
    electronPath: 'C:\\dsh\\Harness.exe',
    childPath: 'C:\\pkg\\child.cjs',
    machinesFile: 'C:\\m.json',
  })
  const hint = source.indexOf('DSH_REMOTE_TERMINAL_NODE')
  const fallback = source.indexOf('ELECTRON_RUN_AS_NODE')
  assert.ok(hint !== -1 && fallback !== -1, 'the fallback keeps its escape-hatch hint')
  assert.ok(hint < fallback, 'the hint must execute before the fallback; after `exit /b` it is dead code')
  assert.match(source, /falling back to the bundled runtime/)
})

// ── issue #91: refuse a terminal that can never receive input ───────────────

test('a pipe on stdin is not interactive; a console is', () => {
  assert.equal(child.stdinIsInteractive({ stdin: { isTTY: true }, fstat: () => { throw new Error('unused') } }), true)
  // Some runtimes never set isTTY; the fd itself still tells the truth.
  assert.equal(child.stdinIsInteractive({ stdin: {}, fstat: () => ({ isCharacterDevice: () => true }) }), true)
  assert.equal(child.stdinIsInteractive({ stdin: {}, fstat: () => ({ isCharacterDevice: () => false }) }), false)
  assert.equal(child.stdinIsInteractive({ stdin: {}, fstat: () => { throw new Error('EBADF') } }), false)
})

test('a deaf terminal is refused loudly instead of spawning a dead ssh', () => {
  const lines = []
  let code = null
  const result = child.main([], {
    cwd: fsRoot(),
    stdin: {}, // no isTTY, exactly what an Electron-as-node stdio looks like
    fstat: () => ({ isCharacterDevice: () => false }),
    exists: () => false,
    write: (line) => lines.push(line),
    exit: (value) => { code = value },
  })
  // Nothing was spawned: the refusal IS the result.
  assert.equal(result, undefined)
  assert.equal(code, 126)
  assert.ok(lines.some((line) => line.includes('stdin')), JSON.stringify(lines))
  assert.ok(lines.some((line) => line.includes('DSH_REMOTE_TERMINAL_NODE')), JSON.stringify(lines))
})

// ── the menu label vs the file that runs ───────────────────────────────────
//
// The label is `executableName(candidate)` and nothing is stripped from it, so
// a path shows its `.cmd`. Windows cannot start an extensionless file (ConPTY
// fails with ERROR_BAD_EXE_FORMAT), so the only way to a clean label is to
// contribute the bare name and let the host resolve it through PATH + PATHEXT.

test('Windows contributes a bare name, POSIX contributes the file path', () => {
  const launcher = path.join('/tmp/shell', 'remote ssh.cmd')
  assert.equal(shellCandidate('win32', launcher), SHELL_OPTION_NAME)
  assert.equal(shellCandidate('linux', launcher), launcher)
  assert.equal(shellCandidate('darwin', launcher), launcher)
  // The host only guesses extensions when the name has none of its own, so a
  // dot in the label would quietly break the lookup.
  assert.equal(path.extname(shellCandidate('win32', launcher)), '')
})

test('the bare name resolves the way the host resolves it', () => {
  const dirs = ['C:\\a', 'C:\\b']
  const present = new Set(['c:\\b\\remote ssh.cmd'])
  const found = resolveThroughPath('remote ssh', {
    platform: 'win32',
    pathEnv: dirs.join(';'),
    pathExt: '.COM;.EXE;.BAT;.CMD',
    fs: { existsSync: (p) => present.has(p.toLowerCase()) },
  })
  // The modeled platform is win32, so the expectation is too: `path.win32`
  // resolves drive letters on any runner, the runtime `path` does not.
  assert.equal(found, path.win32.resolve('C:\\b', 'remote ssh.CMD'))
  assert.equal(resolveThroughPath('remote ssh', {
    platform: 'win32',
    pathEnv: dirs.join(';'),
    pathExt: '.COM;.EXE',
    fs: { existsSync: (p) => present.has(p.toLowerCase()) },
  }), '')
})

test('a name with its own extension is never extended', () => {
  const seen = []
  resolveThroughPath('remote.ssh', {
    platform: 'win32',
    pathEnv: 'C:\\a',
    pathExt: '.CMD',
    fs: { existsSync: (p) => { seen.push(p); return false } },
  })
  assert.deepEqual(seen, [path.win32.resolve('C:\\a', 'remote.ssh')])
})

// The PATH values below use this runner's own path format: `appendPathEntry`
// edits the REAL process environment, which always follows the runtime
// platform — a posix PATH split on ';' would shatter on every ':'. What is
// being pinned is the ref-counting, which is platform-independent.
test('the launcher directory is appended once and removed exactly once', () => {
  const windows = path.join(fsRoot(), 'Windows')
  const tools = path.join(fsRoot(), 'Tools')
  const launchers = path.join(fsRoot(), 'launchers')
  const env = { PATH: windows + path.delimiter + tools }
  const undo = appendPathEntry(launchers, env)
  assert.equal(env.PATH, windows + path.delimiter + tools + path.delimiter + launchers)
  const again = appendPathEntry(launchers, env)
  assert.equal(env.PATH, windows + path.delimiter + tools + path.delimiter + launchers, 'idempotent')
  again()
  assert.equal(env.PATH, windows + path.delimiter + tools + path.delimiter + launchers, 'a duplicate undo changes nothing')
  undo()
  assert.equal(env.PATH, windows + path.delimiter + tools)
  undo()
  assert.equal(env.PATH, windows + path.delimiter + tools, 'undo twice is harmless')
})

test('two live registrations keep the entry until the last one is released', () => {
  // A reload installs the new contribution before (or after) disposing the old
  // one. A set/clear pair would let the first release strip PATH out from under
  // the still-live entry, and the menu item would stop resolving.
  const windows = path.join(fsRoot(), 'Windows')
  const launchers = path.join(fsRoot(), 'launchers')
  const env = { PATH: windows }
  const first = appendPathEntry(launchers, env)
  const second = appendPathEntry(launchers, env)
  assert.equal(env.PATH, windows + path.delimiter + launchers)
  first()
  assert.equal(env.PATH, windows + path.delimiter + launchers)
  second()
  assert.equal(env.PATH, windows)
})

test('a directory that was already on PATH is not ours to remove', () => {
  const windows = path.join(fsRoot(), 'Windows')
  const launchers = path.join(fsRoot(), 'launchers')
  const env = { PATH: windows + path.delimiter + launchers }
  const undo = appendPathEntry(launchers, env)
  assert.equal(env.PATH, windows + path.delimiter + launchers)
  undo()
  assert.equal(env.PATH, windows + path.delimiter + launchers)
})

test('an empty PATH grows a single entry rather than a leading separator', () => {
  const env = {}
  const undo = appendPathEntry('/opt/launchers', env)
  assert.equal(env.PATH, '/opt/launchers')
  undo()
  assert.equal(env.PATH, '')
})

test('a reload does not stack the same PATH entry', () => {
  const { dir, spec, cleanup } = launcherDir()
  try {
    const controller = { config: { shellCandidates: ['cmd'] } }
    // Pinned to win32 so the PATH branch is exercised on every runner.
    const winSpec = {
      ...spec,
      platform: 'win32',
      fs: { existsSync: (p) => p.toLowerCase().endsWith('remote ssh.cmd') },
    }
    const { ctx, effects } = fakeContext()
    installTerminalShell(ctx, controller, winSpec)
    for (const dispose of effects) dispose()
    installTerminalShell(ctx, controller, winSpec)
    const entries = spec.env.Path.split(path.delimiter)
      .filter((entry) => entry !== '' && path.resolve(entry) === path.resolve(dir))
    assert.equal(entries.length, 1)
    assert.deepEqual(controller.config.shellCandidates, ['cmd', SHELL_OPTION_NAME])
  } finally {
    cleanup()
  }
})

test('every host platform contributes its launcher to the menu', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-menu-'))
  try {
    for (const host of HOST_PLATFORMS) {
      const dir = path.join(base, host.platform)
      const controller = { config: { shellCandidates: ['cmd'] } }
      const env = fakeEnv()
      const before = env.Path
      const { ctx } = fakeContext()
      const ok = installTerminalShell(ctx, controller, {
        dir,
        childPath: path.join(dir, 'child.cjs'),
        machinesFile: path.join(base, 'machines.json'),
        platform: host.platform,
        electron: false,
        env,
        // Only the launcher itself resolves, so the assertion does not depend
        // on which platform the test runner happens to be.
        fs: { existsSync: (p) => p.toLowerCase().endsWith('remote ssh.cmd') },
      })
      assert.equal(ok, true, host.platform)
      const launcher = path.join(dir, host.launcher)
      // Windows contributes the bare name: the menu label is the candidate's
      // basename, so a path would put `.cmd` on screen. The host resolves the
      // name through PATH + PATHEXT to this same file.
      const expected = host.platform === 'win32' ? SHELL_OPTION_NAME : launcher
      assert.deepEqual(controller.config.shellCandidates, ['cmd', expected], host.platform)
      assert.ok(existsSync(launcher), `${host.platform}: expected ${launcher} on disk`)
      if (host.platform === 'win32') {
        assert.equal(env.Path, before + path.delimiter + dir, 'win32: the launcher directory is appended to PATH')
      } else {
        assert.equal(env.Path, before, `${host.platform}: PATH must stay untouched`)
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a PATHEXT without .CMD falls back to the absolute path instead of losing the option', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-pathext-'))
  try {
    const controller = { config: { shellCandidates: ['cmd'] } }
    const env = { Path: process.env.Path || '', PATHEXT: '.COM;.EXE' }
    const before = env.Path
    const { ctx } = fakeContext()
    installTerminalShell(ctx, controller, {
      dir,
      childPath: path.join(dir, 'child.cjs'),
      machinesFile: path.join(dir, 'machines.json'),
      platform: 'win32',
      electron: false,
      env,
      fs: { existsSync: (p) => p.toLowerCase().endsWith('.cmd') },
    })
    // Usable, with the suffix visible in the label — never silently missing.
    assert.deepEqual(controller.config.shellCandidates, ['cmd', path.join(dir, 'remote ssh.cmd')])
    assert.equal(env.Path, before, 'the PATH entry is rolled back when it buys nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unloading the plugin withdraws the entry again', () => {
  const { dir, spec, cleanup } = launcherDir()
  try {
    const controller = { config: { shellCandidates: ['cmd'] } }
    const pathBefore = spec.env.Path
    const { ctx, effects } = fakeContext()
    installTerminalShell(ctx, controller, spec)
    assert.equal(controller.config.shellCandidates.length, 2)
    for (const dispose of effects) dispose()
    assert.deepEqual(controller.config.shellCandidates, ['cmd'])
    // Whatever the platform contributed, the environment goes back too: a
    // reloadable plugin must not leak the same PATH entry on every load.
    assert.equal(spec.env.Path, pathBefore)
    assert.ok(dir)
  } finally {
    cleanup()
  }
})

// ── the default-shell claim (remote session → remote terminal by default) ────
//
// `config.shell` is what discovery puts first and what a shellPath-less spawn
// resolves to. Pointing it at the cwd-aware launcher makes "open terminal" do
// the right thing for both remote and local sessions. The claim is polite:
// never overrides a configured shell, never clobbers a later claimant.

test('an unclaimed default shell slot is claimed with the absolute launcher path', () => {
  const { dir, spec, cleanup } = launcherDir()
  try {
    const controller = { config: { shellCandidates: ['cmd'] } }
    const { ctx, effects } = fakeContext()
    installTerminalShell(ctx, controller, spec)
    assert.deepEqual(controller.config.shell, {
      path: path.join(dir, process.platform === 'win32' ? 'remote ssh.cmd' : 'remote ssh'),
      name: 'remote ssh',
      args: [],
    })
    for (const dispose of effects) dispose()
    assert.equal(controller.config.shell, undefined, 'unload restores the empty slot')
  } finally {
    cleanup()
  }
})

test('a configured default shell is never overridden', () => {
  const { dir, spec, cleanup } = launcherDir()
  try {
    const mine = { path: '/bin/zsh', name: 'zsh', args: ['-i'] }
    const controller = { config: { shellCandidates: ['cmd'], shell: mine } }
    const { ctx, effects } = fakeContext()
    installTerminalShell(ctx, controller, spec)
    assert.equal(controller.config.shell, mine, 'the user/admin default wins over our launcher')
    // …but the menu candidate is still contributed.
    assert.equal(controller.config.shellCandidates.length, 2)
    for (const dispose of effects) dispose()
    assert.equal(controller.config.shell, mine)
  } finally {
    cleanup()
  }
})

test('claimDefault: false keeps the launcher menu-only', () => {
  const { dir, spec, cleanup } = launcherDir()
  try {
    const controller = { config: { shellCandidates: ['cmd'] } }
    const { ctx } = fakeContext()
    installTerminalShell(ctx, controller, { ...spec, claimDefault: false })
    assert.equal(controller.config.shell, undefined)
    assert.equal(controller.config.shellCandidates.length, 2)
  } finally {
    cleanup()
  }
})

test('dispose does not clobber a default someone else set after us', () => {
  const { dir, spec, cleanup } = launcherDir()
  try {
    const controller = { config: { shellCandidates: ['cmd'] } }
    const { ctx, effects } = fakeContext()
    installTerminalShell(ctx, controller, spec)
    assert.ok(controller.config.shell, 'claimed')
    // The host admin (or another plugin) configures a default while we hold it.
    const theirs = { path: '/bin/fish', name: 'fish', args: ['-i'] }
    controller.config.shell = theirs
    for (const dispose of effects) dispose()
    assert.equal(controller.config.shell, theirs, 'their claim survives our unload')
  } finally {
    cleanup()
  }
})

// ── the credential bridge (saved passwords for the remote ssh terminal) ──────

test('both launchers export DSH_TERM_DIR so the child can find the bridge', () => {
  const win = launcherSource({ platform: 'win32', childPath: 'C:\\p\\c.cjs', machinesFile: 'C:\\m.json' })
  assert.match(win, /set "DSH_TERM_DIR=%~dp0"/)
  const posix = launcherSource({ platform: 'linux', childPath: '/p/c.cjs', machinesFile: '/m.json' })
  assert.match(posix, /DSH_TERM_DIR=\$\(CDPATH= cd -- "\$\(dirname -- "\$0"\)" && pwd\)/)
})

test('writeLauncher also writes the askpass helper pair (no secrets baked in)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-askpass-'))
  try {
    const wrote = writeLauncher({
      dir,
      platform: process.platform,
      childPath: path.join(dir, 'child.cjs'),
      machinesFile: path.join(dir, 'machines.json'),
      nodePath: process.execPath,
    })
    assert.ok(wrote.askpass, 'the wrapper path is reported')
    const helper = readFileSync(path.join(dir, 'term-askpass.cjs'), 'utf8')
    assert.match(helper, /term-secret\.json/, 'the helper reads the payload file, nothing baked in')
    assert.match(helper, /authorization/)
    assert.ok(existsSync(wrote.askpass), `wrapper exists at ${wrote.askpass}`)
    if (process.platform !== 'win32') {
      assert.match(readFileSync(wrote.askpass, 'utf8'), /^#!\/bin\/sh/)
    } else {
      assert.match(readFileSync(wrote.askpass, 'utf8'), /term-askpass\.cjs/)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('needsAskpass: keys/agents/aliases/OTP stay on their own rails, stored passwords bridge', () => {
  assert.equal(child.needsAskpass(undefined), false)
  assert.equal(child.needsAskpass({ useAgent: true, password: 'x' }), false)
  assert.equal(child.needsAskpass({ useSshConfig: true, host: 'alias' }), false)
  assert.equal(child.needsAskpass({ keyboardInteractive: true, password: 'x' }), false, 'OTP prompts are per-login: bridging them would answer with the static password')
  assert.equal(child.needsAskpass({ privateKeyPath: 'C:\\k' }), false)
  assert.equal(child.needsAskpass({ password: 's3cret', credentialBackend: 'plain' }), true)
  assert.equal(child.needsAskpass({ credentialBackend: 'keychain' }), true, 'a keychain backend implies a stored secret')
  assert.equal(child.needsAskpass({ credentialBackend: 'plain' }), false, 'plain with EMPTY password: nothing to bridge')
  assert.equal(child.needsAskpass({}), false)
})

test('askpassEnv points ssh at the wrapper and carries the machine identity', () => {
  const env = child.askpassEnv(
    { host: 'h', port: 2222, username: 'u', alias: 'al' },
    '/term/dir',
    'linux',
  )
  assert.equal(env.SSH_ASKPASS, path.join('/term/dir', 'term-askpass'))
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'force')
  assert.equal(env.DSH_TS_HOST, 'h')
  assert.equal(env.DSH_TS_PORT, '2222')
  assert.equal(env.DSH_TS_USERNAME, 'u')
  assert.equal(env.DSH_TS_ALIAS, 'al')
  const win = child.askpassEnv({ host: 'h' }, 'C:\\term', 'win32')
  assert.equal(win.SSH_ASKPASS, path.join('C:\\term', 'term-askpass.cmd'))
})

// ── environment helpers ────────────────────────────────────────────────────

test('the native Windows OpenSSH wins over a PATH ssh from git-bash', () => {
  assert.equal(
    child.sshBinary('win32', { SystemRoot: 'C:\\Windows' }, () => true),
    path.join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
  )
  assert.equal(child.sshBinary('win32', { SystemRoot: 'C:\\Windows' }, () => false), 'ssh')
  // macOS and Linux both carry the system client on PATH; there is no
  // second implementation to prefer, so the bare name is correct.
  assert.equal(child.sshBinary('darwin', {}, () => true), 'ssh')
  assert.equal(child.sshBinary('linux', {}, () => true), 'ssh')
})

test('the local fallback shell follows the platform', () => {
  assert.equal(child.localShell('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }), 'C:\\Windows\\system32\\cmd.exe')
  assert.equal(child.localShell('win32', {}), 'cmd.exe')
  // macOS defaults to zsh but respects $SHELL, exactly like Linux.
  assert.equal(child.localShell('darwin', { SHELL: '/bin/zsh' }), '/bin/zsh')
  assert.equal(child.localShell('darwin', {}), '/bin/sh')
  assert.equal(child.localShell('linux', { SHELL: '/bin/zsh' }), '/bin/zsh')
  assert.equal(child.localShell('linux', {}), '/bin/sh')
})

test('a Windows remote workspace is detected from its path form', () => {
  // A POSIX `cd` cannot take any of these, so the remote's own shell must run.
  for (const p of ['D:\\Code', 'C:/Users/dev', '\\\\server\\share\\proj']) {
    assert.equal(child.isWindowsRemotePath(p), true, p)
  }
  for (const p of ['/srv/proj', '~/proj', '', '/mnt/share/x', 'D:', 'relative/path']) {
    assert.equal(child.isWindowsRemotePath(p), false, p)
  }
})

test('a POSIX remote still lands in the workspace', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    // The host platform must not change the remote command: it is executed by
    // the remote shell, which is POSIX whenever the workspace path is.
    assert.equal(child.buildSshArgs({ host: 'h', port: 22, username: 'u', remotePath: '/srv/proj' }).length, 3, platform)
  }
})

test('a Windows remote gets no POSIX command, so its default shell starts intact', () => {
  const args = child.buildSshArgs({ host: 'h', port: 22, username: 'u', remotePath: 'D:\\Code' })
  // `-tt` still forces a tty; without a command ssh opens the remote's default
  // shell, which is the only thing that works for cmd/PowerShell.
  assert.deepEqual(args, ['-tt', 'u@h'])
})

test('--machines is parsed and unknown arguments are ignored', () => {
  assert.deepEqual(child.parseArgs(['--machines', 'C:\\m.json', '-i']), { machines: 'C:\\m.json' })
  assert.deepEqual(child.parseArgs(['-i']), {})
  assert.deepEqual(child.parseArgs(['--machines']), {})
})
