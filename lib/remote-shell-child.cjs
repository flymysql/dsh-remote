#!/usr/bin/env node
/**
 * The program the host terminal runs when the user picks the "Remote SSH" shell.
 *
 * It is started by a generated launcher (see `remote-shell.js`) inside the
 * session's working directory, resolves which remote checkout that directory
 * belongs to, and then replaces itself with `ssh`. Inheriting stdio is the whole
 * point: the local pty stays in charge of the screen, so resize and key handling
 * keep working without this script knowing anything about terminals.
 *
 * Plain CommonJS on purpose: it is spawned as a standalone script, and it must
 * not depend on how the plugin package itself is loaded.
 */

'use strict'

const { spawn } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')

/** Name of the marker the host half writes into every local mirror root. */
const META_FILE = '.dsh-remote-meta.json'
/** How far up from the working directory a marker may be found. */
const MAX_WALK_UP = 12

/**
 * Read and parse a JSON file, returning undefined for anything unusable.
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Find the mirror root that contains `cwd` by walking upwards for the marker.
 * @param {string} cwd - session working directory
 * @param {{ exists?: (p: string) => boolean, readJsonFile?: (p: string) => any, maxUp?: number }} deps
 * @returns {{ dir: string, meta: object } | null}
 */
function findMirror(cwd, deps = {}) {
  const exists = deps.exists || ((p) => existsSync(p))
  const read = deps.readJsonFile || readJson
  const maxUp = deps.maxUp || MAX_WALK_UP
  let dir = path.resolve(cwd || '.')
  for (let depth = 0; depth <= maxUp; depth += 1) {
    const marker = path.join(dir, META_FILE)
    if (exists(marker)) {
      const meta = read(marker)
      if (meta && typeof meta === 'object' && meta.host) return { dir, meta }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Pick the saved connection that owns a mirror.
 *
 * The marker records the SSH alias when the machine was saved from
 * `~/.ssh/config` (issue #38), so the alias is the most precise key; otherwise
 * host + user + port identify it. A missing entry is not fatal — the marker
 * alone is enough to connect, and ssh will use its own defaults for the key.
 *
 * @param {object} meta - mirror marker
 * @param {{ list?: object[] }} registry - parsed `machines.json`
 * @returns {object | undefined}
 */
function matchMachine(meta, registry) {
  const list = registry && Array.isArray(registry.list) ? registry.list : []
  const port = Number(meta.port || 22)
  if (meta.alias) {
    const byAlias = list.find((m) => m && m.host === meta.alias)
    if (byAlias) return byAlias
  }
  return list.find((m) => m && m.host === meta.host
    && String(m.username || '') === String(meta.username || '')
    && Number(m.port || 22) === port)
}

/**
 * Quote one path for a POSIX shell, single quotes only.
 * @param {string} value
 * @returns {string}
 */
function quotePosix(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * Build the `cd` half of the remote command, keeping `~` for the *remote* shell
 * to expand: the local home is not the remote home, so expanding it here would
 * silently land in the wrong directory.
 * @param {string} remotePath
 * @returns {string}
 */
function remoteCd(remotePath) {
  const raw = String(remotePath || '').trim()
  if (raw === '' || raw === '~') return 'cd "$HOME"'
  if (raw === '~/') return 'cd "$HOME"'
  if (raw.startsWith('~/')) return 'cd "$HOME"/' + quotePosix(raw.slice(2))
  return 'cd ' + quotePosix(raw)
}

/**
 * The remote command: land in the workspace, then hand over to a login shell.
 *
 * `exec` keeps the pty attached to a single interactive shell, so the exit code
 * the terminal sees is the shell's own, and a deleted workspace falls back to
 * `$HOME` instead of leaving a broken terminal.
 *
 * @param {string} remotePath
 * @returns {string}
 */
function remoteCommand(remotePath) {
  return `${remoteCd(remotePath)} 2>/dev/null || cd "$HOME"; exec "\${SHELL:-/bin/bash}" -l`
}

/** Absolute Windows path: `D:\x`, `D:/x`, or a `\\server\share` UNC path.
 * These cannot be the operand of a POSIX `cd`. */
const WINDOWS_REMOTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/

/**
 * Whether a remote workspace path is a Windows one.
 *
 * A Windows remote speaks cmd or PowerShell in its default shell, so the POSIX
 * `cd … || …; exec "$SHELL"` line would fail outright there — `2>/dev/null`,
 * `||` and `exec` are not cmd syntax at all. The marker records no remote
 * platform, but the path form is unambiguous: `/srv/x` and `~/x` are POSIX,
 * while `D:\x` and `\\server\share` are not valid POSIX paths.
 *
 * @param {string} p - `remotePath` from the mirror marker
 * @returns {boolean}
 */
function isWindowsRemotePath(p) {
  return WINDOWS_REMOTE_PATH.test(String(p || '').trim())
}

/**
 * Argument list (without the ssh binary) for one connection.
 *
 * `-tt` is mandatory: the terminal needs a tty even though a command is given,
 * otherwise the shell comes up non-interactive and every key press is ignored.
 * Options are pushed in order and never spliced between an `-o` and its value —
 * an inserted `-J` there once reached ssh as the value of `-o`, which aborted
 * every connection that used a jump host (issue #21).
 *
 * @param {object} target - `{ host, port, username, alias, remotePath }`
 * @param {object} [machine] - saved connection, for the key and transport hints
 * @returns {string[]}
 */
function buildSshArgs(target, machine) {
  const args = ['-tt']
  const alias = target.alias || (machine && machine.useSshConfig ? machine.host : '')
  if (alias) {
    args.push(String(alias))
  } else {
    const port = Number(target.port || (machine && machine.port) || 22)
    if (port !== 22) args.push('-p', String(port))
    const key = machine && machine.privateKeyPath
    if (key && !machine.useAgent) args.push('-i', String(key))
    const user = target.username || (machine && machine.username) || ''
    args.push(user ? `${user}@${target.host}` : String(target.host))
  }
  // A Windows workspace cannot be reached with the POSIX line: the remote's
  // default shell may be cmd or PowerShell, and picking one would be a guess.
  // Opening ssh with no command leaves the remote's own default shell in charge,
  // so the terminal still works; only the automatic `cd` is given up.
  if (!isWindowsRemotePath(target.remotePath)) args.push(remoteCommand(target.remotePath))
  return args
}

/**
 * Prefer the OS OpenSSH binary on Windows. A PATH lookup there can reach an
 * MSYS2/git-bash `ssh`, which resolves `~/.ssh` against a different home and
 * makes keys saved by the host half look missing.
 * @param {string} [platform]
 * @param {object} [env]
 * @param {(p: string) => boolean} [exists]
 * @returns {string}
 */
function sshBinary(platform = process.platform, env = process.env, exists = existsSync) {
  if (platform === 'win32') {
    const system = env.SystemRoot || env.windir || 'C:\\Windows'
    const native = path.join(system, 'System32', 'OpenSSH', 'ssh.exe')
    if (exists(native)) return native
  }
  return 'ssh'
}

/**
 * The shell to fall back to when this directory is not a remote checkout.
 * @param {string} [platform]
 * @param {object} [env]
 * @returns {string}
 */
function localShell(platform = process.platform, env = process.env) {
  if (platform === 'win32') return env.ComSpec || 'cmd.exe'
  return env.SHELL || '/bin/sh'
}

/**
 * Parse the arguments the launcher passes.
 * @param {string[]} argv
 * @returns {{ machines?: string }}
 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--machines' && argv[i + 1]) {
      out.machines = argv[i + 1]
      i += 1
    }
  }
  return out
}

/**
 * Resolve everything needed to connect from a working directory.
 * @param {{ cwd?: string, machines?: string, exists?: Function, readJsonFile?: Function }} input
 * @returns {{ target?: object, machine?: object, found: boolean }}
 */
function resolveTarget(input = {}) {
  const cwd = input.cwd || process.cwd()
  const mirror = findMirror(cwd, input)
  if (!mirror) return { found: false }
  const registry = input.machines ? (input.readJsonFile || readJson)(input.machines) : undefined
  const machine = matchMachine(mirror.meta, registry)
  const target = {
    host: mirror.meta.host,
    port: mirror.meta.port || (machine && machine.port) || 22,
    username: mirror.meta.username || (machine && machine.username) || '',
    alias: mirror.meta.alias || '',
    remotePath: mirror.meta.remotePath || (machine && machine.workspace) || '',
  }
  return { found: true, target, machine, dir: mirror.dir }
}

/**
 * Hand the current process over to `file args…`, propagating the exit code.
 * @param {string} file
 * @param {string[]} args
 * @returns {import('node:child_process').ChildProcess}
 */
function handover(file, args) {
  const child = spawn(file, args, { stdio: 'inherit' })
  child.on('error', (error) => {
    process.stderr.write(`[dsh-remote] cannot run ${file}: ${error && error.message}\n`)
    process.exit(127)
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code == null ? 0 : code)
  })
  return child
}

/**
 * Entry point: connect, or explain why a local shell was used instead.
 * @param {string[]} [argv]
 * @param {{ cwd?: string, platform?: string, env?: object }} [deps]
 */
function main(argv = process.argv.slice(2), deps = {}) {
  const platform = deps.platform || process.platform
  const env = deps.env || process.env
  const options = parseArgs(argv)
  const resolved = resolveTarget({ cwd: deps.cwd || process.cwd(), machines: options.machines })
  if (!resolved.found) {
    process.stderr.write('[dsh-remote] this directory is not a remote workspace; opening a local shell.\n')
    process.stderr.write('[dsh-remote] 当前目录不是远程工作区，已打开本地终端。\n')
    return handover(localShell(platform, env), platform === 'win32' ? [] : ['-l'])
  }
  const ssh = sshBinary(platform, env)
  const args = buildSshArgs(resolved.target, resolved.machine)
  const user = resolved.target.username || (resolved.machine && resolved.machine.username) || ''
  process.stderr.write(`[dsh-remote] connecting to ${user ? user + '@' : ''}${resolved.target.host}…\n`)
  if (isWindowsRemotePath(resolved.target.remotePath)) {
    process.stderr.write('[dsh-remote] the remote workspace is a Windows path; opening the remote default shell without changing directory.\n')
    process.stderr.write('[dsh-remote] 远端工作区是 Windows 路径，已打开默认 shell（未自动切换目录）。\n')
  }
  return handover(ssh, args)
}

module.exports = {
  META_FILE,
  buildSshArgs,
  findMirror,
  isWindowsRemotePath,
  localShell,
  main,
  matchMachine,
  parseArgs,
  remoteCd,
  remoteCommand,
  resolveTarget,
  sshBinary,
}

if (require.main === module) main()
