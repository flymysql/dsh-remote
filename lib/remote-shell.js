/**
 * Remote terminal as a shell choice — the host terminal's own option list.
 *
 * The built-in terminal is a *local* pty whose program comes from
 * `dsh-api-terminal-controller`'s verified shell list (`shellCandidates`). A
 * plugin cannot hand that pty a command line, but it CAN contribute one entry
 * to that list: an absolute path to a launcher we generate. The pty then runs
 * our launcher as a local process, and the launcher execs `ssh` with inherited
 * stdio — which is exactly how the terminal should behave. Resizing, key
 * binding, scrollback and color all stay the host's job; nothing is re-implemented
 * here.
 *
 * The launcher itself is dumb (find node, run the child script). The child
 * (`remote-shell-child.cjs`) resolves the remote target from the checkout it is
 * started in and replaces itself with `ssh`.
 *
 * @module dsh-remote/remote-shell
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Label shown in the terminal's shell menu.
 *
 * Windows needs a real `.cmd` on disk (ConPTY cannot start an extensionless
 * file), but the label does not have to advertise it: the menu shows the
 * candidate's basename, and `shellCandidate` contributes the bare name so the
 * host resolves it through `PATH` + `PATHEXT`. The suffix is therefore an
 * implementation detail of the file on disk, not of the menu entry. */
export const SHELL_OPTION_NAME = 'remote ssh'

/** Absolute path of the generated launcher for this platform. */
export function shellLauncherPath(dir, platform = process.platform) {
  return path.join(dir, platform === 'win32' ? SHELL_OPTION_NAME + '.cmd' : SHELL_OPTION_NAME)
}

/** Default `PATHEXT`, used when the environment does not carry one. */
const DEFAULT_PATH_EXT = '.COM;.EXE;.BAT;.CMD'

/**
 * The value to contribute to `shellCandidates`.
 *
 * The menu label is `executableName(candidate)` — the candidate's basename, with
 * no extension stripped — while the path that actually runs is whatever the host
 * resolves. Those are two different things, and the gap is the only way to get a
 * clean label on Windows.
 *
 * A file path would be shown as `remote ssh.cmd`, because the terminal has to
 * start a real `.cmd` and ConPTY refuses anything else (a file with no extension
 * dies with 193, `ERROR_BAD_EXE_FORMAT`). So on Windows the *bare* name is
 * contributed instead: the host resolves it through `PATH` + `PATHEXT`, lands on
 * `remote ssh.cmd`, and the label stays `remote ssh`. That is exactly the rule
 * `resolveExecutable` documents — an absolute path is checked as-is with no
 * extension guessing, a bare name is looked up per `PATHEXT`.
 *
 * Two consequences, both handled by the caller: the launcher's directory has to
 * be on `PATH` (see `appendPathEntry`), and the name must contain no dot, since
 * a bare name is only extended when `extname()` is empty.
 *
 * POSIX has no such rule — the file is directly executable — so the absolute
 * path is contributed as-is.
 *
 * @param {string} platform
 * @param {string} launcherPath
 * @returns {string} candidate value for the shell list
 */
export function shellCandidate(platform, launcherPath) {
  if (platform !== 'win32') return launcherPath
  return path.basename(launcherPath).replace(/\.cmd$/i, '')
}

/**
 * Resolve a bare command name the way the host does, without spawning anything.
 *
 * A mirror of `subprocess-local`'s `executableCandidates` + `resolveExecutable`:
 * directory-major order over `PATH`, extension-minor over `PATHEXT`, and
 * extensions only when the name has none of its own. Used to decide whether the
 * bare-name contribution will actually resolve; if it will not, the caller falls
 * back to the absolute path and accepts the `.cmd` in the label.
 *
 * @param {string} name
 * @param {{ platform?: string, pathEnv?: string, pathExt?: string, cwd?: string,
 *           fs?: { existsSync: (p: string) => boolean } }} [deps]
 * @returns {string} resolved path, or '' when nothing matches
 */
export function resolveThroughPath(name, deps = {}) {
  const platform = deps.platform || process.platform
  const fs = deps.fs || { existsSync }
  const pathEnv = deps.pathEnv === undefined ? (process.env.PATH || '') : deps.pathEnv
  const pathExt = deps.pathExt === undefined
    ? (process.env.PATHEXT || DEFAULT_PATH_EXT)
    : deps.pathExt
  const cwd = deps.cwd || process.cwd()
  const extensions = platform === 'win32' && path.extname(name) === ''
    ? pathExt.split(';').filter(Boolean)
    : ['']
  const delimiter = platform === 'win32' ? ';' : ':'
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.resolve(cwd, directory, name + extension)
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch { /* an unreadable directory is simply skipped */ }
    }
  }
  return ''
}

/** Per-environment ownership of the entries this module added. */
const pathEntries = new WeakMap()

/**
 * Append a directory to the process `PATH`, idempotently and ref-counted.
 *
 * Appended, never prepended: a plugin has no business shadowing a program the
 * user already has, and the launcher's name cannot collide by accident.
 *
 * The entry is ref-counted per environment object because the contribution can
 * be installed more than once in a process lifetime — a reload disposes the old
 * effect and installs a new one, and the two callbacks may interleave. A plain
 * "set/clear" pair would let the first disposal strip the entry out from under
 * the still-live registration, which only shows up much later as the menu entry
 * silently vanishing (the host cannot resolve a bare name that is no longer on
 * PATH).
 *
 * A directory that was already on `PATH` before we touched it is marked as
 * externally owned and is never removed by us.
 *
 * @param {string} dir - absolute directory to expose
 * @param {object} [env] - environment object; defaults to `process.env`
 * @returns {() => void} undo, safe to call more than once
 * @throws {Error} when the variable cannot be written
 */
export function appendPathEntry(dir, env = process.env) {
  const absolute = path.resolve(dir)
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') || 'PATH'
  let owned = pathEntries.get(env)
  if (!owned) {
    owned = new Map()
    pathEntries.set(env, owned)
  }
  const count = owned.get(absolute)
  if (count === undefined) {
    const current = env[key] || ''
    const parts = current.split(path.delimiter).filter(Boolean)
    if (parts.some((entry) => path.resolve(entry) === absolute)) {
      owned.set(absolute, 0) // pre-existing: ours to use, not ours to remove
    } else {
      env[key] = current === '' ? dir : current + path.delimiter + dir
      owned.set(absolute, 1)
    }
  } else if (count > 0) {
    owned.set(absolute, count + 1)
  }
  return () => {
    const live = owned.get(absolute)
    if (live === undefined || live <= 0) return
    if (live > 1) {
      owned.set(absolute, live - 1)
      return
    }
    owned.delete(absolute)
    const kept = (env[key] || '')
      .split(path.delimiter)
      .filter((entry) => entry !== '' && path.resolve(entry) !== absolute)
    env[key] = kept.join(path.delimiter)
  }
}

/**
 * Node interpreters worth baking into the launcher, most specific first.
 *
 * The desktop host does not put its bundled node on a child's PATH (by design),
 * so an absolute path is the only reliable option; `where node` is a last
 * resort. When no node is found the launcher falls back to re-entering the
 * Electron binary with `ELECTRON_RUN_AS_NODE`, which needs no second runtime.
 *
 * Electron puts its resources beside the executable on Windows and Linux, but
 * under `Contents/Resources` on macOS, so the path derived from `execPath` has
 * to follow the platform; the `resourcesPath` candidate already does.
 *
 * @param {{ execPath?: string, resourcesPath?: string, platform?: string, env?: object }} deps
 * @returns {string[]} existing interpreter candidates, in preference order
 */
export function runtimeNodeCandidates(deps = {}) {
  const platform = deps.platform || process.platform
  const env = deps.env || process.env
  // `undefined` means "ask the process", `''` means "this host has no such
  // executable" — callers that model another platform rely on the difference.
  const execPath = deps.execPath === undefined ? (process.execPath || '') : deps.execPath
  const exe = platform === 'win32' ? 'node.exe' : 'node'
  const bundledNode = ['runtime', 'primary-runtime', 'dependencies', 'node', 'bin', exe]
  const out = []
  const push = (value) => { if (value && !out.includes(value)) out.push(value) }
  push(env.DSH_REMOTE_TERMINAL_NODE)
  if (deps.resourcesPath) push(path.join(deps.resourcesPath, ...bundledNode))
  if (execPath) {
    const here = path.dirname(execPath)
    push(path.join(platform === 'darwin' ? path.join(here, '..', 'Resources') : path.join(here, 'resources'), ...bundledNode))
    // A plain node install: execPath IS the interpreter.
    if (!deps.electron && path.basename(execPath).toLowerCase() === exe) push(execPath)
  }
  return out.filter((candidate) => {
    try { return existsSync(candidate) } catch { return false }
  })
}

/**
 * Body of the generated launcher. Pure so it can be asserted without touching
 * the filesystem.
 *
 * @param {{ platform?: string, nodePath?: string, electronPath?: string, childPath: string, machinesFile: string }} spec
 * @returns {string} launcher source, runnable as-is
 */
export function launcherSource(spec) {
  const platform = spec.platform || process.platform
  const child = spec.childPath
  const machines = spec.machinesFile
  if (platform === 'win32') {
    const node = spec.nodePath || ''
    const electron = spec.electronPath || ''
    const lines = [
      '@echo off',
      'rem Generated by dsh-remote - do not edit; rewritten on every load.',
      'setlocal',
      `set "DSH_CHILD=${child}"`,
      `set "DSH_MACHINES=${machines}"`,
      `set "DSH_NODE=${node}"`,
      'if defined DSH_NODE if exist "%DSH_NODE%" goto :run',
      'set "DSH_NODE="',
      'for /f "delims=" %%N in (\'where node 2^>nul\') do if not defined DSH_NODE set "DSH_NODE=%%N"',
      'if defined DSH_NODE goto :run',
    ]
    // Re-entering the Electron binary as node only makes sense when this host
    // IS an Electron app; a plain node install has nothing to re-enter.
    if (electron) {
      lines.push(
        'set "ELECTRON_RUN_AS_NODE=1"',
        `"${electron}" "%DSH_CHILD%" --machines "%DSH_MACHINES%"`,
        'exit /b %ERRORLEVEL%',
      )
    }
    lines.push(
      'echo [dsh-remote] no node interpreter found for the remote terminal. 1>&2',
      'echo [dsh-remote] set DSH_REMOTE_TERMINAL_NODE to an absolute node.exe path, or reinstall dsh-remote. 1>&2',
      'exit /b 127',
      ':run',
      '"%DSH_NODE%" "%DSH_CHILD%" --machines "%DSH_MACHINES%"',
      'exit /b %ERRORLEVEL%',
      '',
    )
    return lines.join('\r\n')
  }
  const node = spec.nodePath || ''
  return [
    '#!/bin/sh',
    '# Generated by dsh-remote - do not edit; rewritten on every load.',
    `DSH_CHILD=${shqPosix(child)}`,
    `DSH_MACHINES=${shqPosix(machines)}`,
    node ? `DSH_NODE=${shqPosix(node)}` : 'DSH_NODE=',
    'if [ -n "$DSH_NODE" ] && [ -x "$DSH_NODE" ]; then exec "$DSH_NODE" "$DSH_CHILD" --machines "$DSH_MACHINES"; fi',
    'if command -v node >/dev/null 2>&1; then exec node "$DSH_CHILD" --machines "$DSH_MACHINES"; fi',
    'echo "[dsh-remote] no node interpreter found for the remote terminal." >&2',
    'exit 127',
    '',
  ].join('\n')
}

/** POSIX single-quote, for paths baked into a shell script. */
export function shqPosix(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * Remove a launcher left on disk under another spelling of the same name.
 *
 * The menu label IS the file name, so renaming the option renames the file. On
 * a case-insensitive volume (NTFS, and APFS by default) writing the new spelling
 * lands in the OLD directory entry and the menu keeps showing the previous
 * name; on a case-sensitive one the old file would simply linger and, having
 * been registered before, could still appear. Deleting the stale entry first
 * makes a rename take effect on both.
 *
 * Best effort throughout: a launcher that cannot be cleaned up must not stop
 * the new one from being written.
 *
 * @param {string} dir
 * @param {string} keepName - basename that must survive
 * @param {object} fs
 */
function removeStaleLauncher(dir, keepName, fs) {
  if (typeof fs.readdirSync !== 'function' || typeof fs.unlinkSync !== 'function') return
  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return // first run: the directory does not exist yet
  }
  for (const entry of entries) {
    if (entry === keepName || entry.toLowerCase() !== keepName.toLowerCase()) continue
    try { fs.unlinkSync(path.join(dir, entry)) } catch { /* keep going */ }
  }
}

/**
 * Write (or refresh) the launcher. Idempotent and cheap: the content is a pure
 * function of this install's paths, so a plugin upgrade that moves the package
 * rewrites the same file with the new child path.
 *
 * @param {{ dir: string, platform?: string, childPath: string, machinesFile: string, nodePath?: string, electronPath?: string, fs?: object }} spec
 * @returns {{ path: string, source: string }}
 */
export function writeLauncher(spec) {
  const platform = spec.platform || process.platform
  const fs = spec.fs || { mkdirSync, writeFileSync, chmodSync, readdirSync, unlinkSync }
  fs.mkdirSync(spec.dir, { recursive: true })
  const file = shellLauncherPath(spec.dir, platform)
  // Before writing: on a case-insensitive filesystem the new name would
  // otherwise be absorbed into the old entry.
  removeStaleLauncher(spec.dir, path.basename(file), fs)
  const source = launcherSource({ ...spec, platform })
  fs.writeFileSync(file, source, 'utf8')
  if (platform !== 'win32') {
    try { fs.chmodSync(file, 0o755) } catch { /* a no-op on filesystems without modes */ }
  }
  return { path: file, source }
}

/**
 * Add one entry to the host terminal's shell list.
 *
 * `shellCandidates` is the exact array `discoverShells` reads on every `shells()`
 * call, so appending to it is live: the next time the user opens the shell menu
 * the entry is there, and `spawn()` accepts the matching `shellPath` because it
 * looks the path up in that same list. Removing it on dispose keeps the menu
 * truthful when the plugin is unloaded.
 *
 * A host without the field (older line, or a controller rebuilt to hide the
 * array) is not an error: the plugin simply contributes no shell. A host that
 * HAS the field but refuses the write is a different story — that throws, so the
 * caller can say why the option never appeared instead of leaving the user to
 * guess.
 *
 * @param {object} controller - the `terminalController` service
 * @param {string} candidate - absolute launcher path
 * @returns {(() => void) | null} undo, or null when there is nothing to undo
 * @throws {TypeError} when the host exposes a shell list that cannot be written
 */
export function addShellCandidate(controller, candidate) {
  const config = controller && controller.config
  const list = config && config.shellCandidates
  if (!Array.isArray(list)) return null
  if (list.includes(candidate)) return null
  list.push(candidate)
  return () => {
    const at = list.indexOf(candidate)
    if (at >= 0) list.splice(at, 1)
  }
}

/** Human-readable reason from anything thrown. */
function reason(err) {
  return String((err && err.message) || err)
}

/** Read an environment variable case-insensitively, as Windows does. */
function envValue(env, name) {
  if (!env) return undefined
  if (env[name] !== undefined) return env[name]
  const match = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase())
  return match === undefined ? undefined : env[match]
}

/**
 * Write the launcher and put it in the terminal's shell menu.
 *
 * Kept out of the plugin entry so the whole contribution — write, publish,
 * withdraw — can be exercised without booting the host. Every way this can
 * fail to produce a visible menu entry is reported through `logger.warn`,
 * because the failure mode that matters is silent: a launcher on disk plus no
 * option in the menu is indistinguishable from "the feature was never built".
 *
 * @param {object} ctx - plugin context; only `effect`, `get('logger')` are used
 * @param {object} controller - the resolved `terminalController` *service*
 * @param {{ dir: string, childPath: string, machinesFile: string, platform?: string,
 *           nodePath?: string, electronPath?: string, electron?: boolean, logger?: object,
 *           env?: object, fs?: { existsSync: (p: string) => boolean } }} spec
 * @returns {boolean} whether the option is (or already was) in the menu
 */
export function installTerminalShell(ctx, controller, spec = {}) {
  const logger = spec.logger !== undefined
    ? spec.logger
    : (ctx && typeof ctx.get === 'function' ? ctx.get('logger') : undefined)
  const warn = (message) => {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(`dsh-remote: ${message}`)
    } catch { /* a logger failure must not change the outcome */ }
  }

  const platform = spec.platform || process.platform
  const electron = spec.electron === undefined
    ? Boolean(process.versions && process.versions.electron)
    : spec.electron
  const nodePath = spec.nodePath === undefined
    ? (runtimeNodeCandidates({
      platform,
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
      env: process.env,
      electron,
    })[0] || '')
    : spec.nodePath
  const electronPath = spec.electronPath === undefined
    ? (electron ? process.execPath : '')
    : spec.electronPath

  let launcher
  try {
    launcher = writeLauncher({
      dir: spec.dir,
      platform,
      childPath: spec.childPath,
      machinesFile: spec.machinesFile,
      nodePath,
      electronPath,
    })
  } catch (err) {
    // A read-only DSH_HOME must not take the plugin down: the terminal just
    // keeps offering the shells it already had.
    warn(`cannot write the remote terminal launcher: ${reason(err)}`)
    return false
  }

  if (controller === undefined || controller === null) {
    warn('the terminal controller is unavailable; the remote ssh option is unavailable')
    return false
  }
  const list = controller.config && controller.config.shellCandidates
  if (!Array.isArray(list)) {
    // Either an older host, or the wrong object was passed in — the service is
    // reached with `ctx.get('terminalController')`, not with the inject callback
    // argument itself. Say which one it looks like.
    const looksLikeContext = typeof controller.get === 'function' || typeof controller.inject === 'function'
    warn(looksLikeContext
      ? 'the terminal controller was not resolved (a plugin context was passed instead); the remote ssh option is unavailable'
      : 'the terminal controller exposes no shellCandidates list; the remote ssh option is unavailable')
    return false
  }

  // On Windows the label is the candidate's basename, so contributing a file
  // path would show `remote ssh.cmd`. Contributing the bare name keeps the label
  // clean, at the price of exposing the launcher directory on PATH — and only
  // while the host can actually resolve that name.
  const bare = shellCandidate(platform, launcher.path)
  const needsPath = bare !== launcher.path
  const env = spec.env || process.env
  const fs = spec.fs || { existsSync }

  let installed = false
  const publish = () => {
    // The PATH entry lives inside the effect, not outside it: if the effect ever
    // re-runs, the new run must put the entry back that the previous disposal
    // took away. `appendPathEntry` ref-counts, so interleaved install/dispose
    // pairs cannot strand a live registration without PATH.
    let restorePath
    let candidate = launcher.path
    if (needsPath) {
      try {
        restorePath = appendPathEntry(path.dirname(launcher.path), env)
        const found = resolveThroughPath(bare, {
          platform,
          pathEnv: envValue(env, 'PATH') || '',
          pathExt: envValue(env, 'PATHEXT'),
          fs,
        })
        if (found) candidate = bare
        else {
          // `PATHEXT` without `.CMD`, or a PATH that refuses the write. The
          // option still works when contributed by absolute path; only its
          // label carries the suffix.
          restorePath()
          restorePath = undefined
          warn('the host cannot resolve the launcher by name; the remote ssh option keeps its .cmd suffix')
        }
      } catch (err) {
        candidate = launcher.path
        restorePath = undefined
        warn(`the launcher directory cannot be added to PATH (${reason(err)}); the remote ssh option keeps its .cmd suffix`)
      }
    }
    try {
      const undo = addShellCandidate(controller, candidate)
      installed = true
      return () => {
        if (undo) undo()
        if (restorePath) restorePath()
      }
    } catch (err) {
      // The host advertises a shell list but will not take a write.
      if (restorePath) restorePath()
      warn(`the terminal shell list rejected the remote shell (${reason(err)}); the remote ssh option is unavailable`)
      return undefined
    }
  }

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(publish, 'dsh-remote.terminal-shell')
  } else {
    publish()
  }
  return installed
}
