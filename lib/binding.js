// Session → remote-binding resolution.
//
// A session's remote target is derived from its own workspace mirror, never
// from the plugin's mutable active-machine state. That is what keeps concurrent
// sessions on different hosts independent: with a single shared connection and
// a single shared workspace value, one session switching machines redirected
// every other session's commands to the wrong host (issue #25).
//
// The mirror directory is the durable record of that binding: `ensureMirror()`
// writes `.dsh-remote-meta.json` with the remote origin (`host`/`port`/
// `username`/`remotePath`) when the workspace is picked, so a session's cwd
// alone identifies both the machine to connect to and the workspace root.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** Strip trailing separators so a mirror root and a path inside it compare cleanly. */
const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '') || ''

/** Whether `base` is `dir` itself or nested under it (separator-aware, so
 *  `/a/mirror-2` is NOT treated as living inside `/a/mirror`). */
const isUnder = (base, dir) => base === dir || base.startsWith(dir + path.sep) || base.startsWith(dir + '/')

/**
 * Resolve which remote workspace a LOCAL path belongs to by scanning the mirror
 * registry for the mirror that contains it.
 *
 * Mirrors live exactly one level under the registry root as
 * `<host>-<user>-<port>/<basename>`, and `mirrorDirFor()` appends a short hash
 * when two remote paths share a basename, so containment is unambiguous. The
 * longest containing path still wins, which keeps the result stable if a
 * future layout ever nests them.
 *
 * A mirror whose meta is missing, unparsable, or has no `host` is skipped
 * rather than guessed at: reporting no binding makes the caller refuse loudly,
 * while guessing would send commands to an unintended host.
 *
 * @param {string} local - absolute local path, typically a session's cwd.
 * @param {string} root - the mirror registry root (`$DSH_HOME/remote-workspaces`).
 * @returns {{mirrorDir: string|null, remotePath: string, machine: {host: string, port: number, username: string}|null}}
 *   `machine` is the mirror-recorded origin, or null when `local` is not inside
 *   a usable mirror (in which case `remotePath` is empty too).
 */
export function resolveMirror(local, root) {
  let mirrorDir = null
  let remotePath = ''
  let machine = null
  if (!local || !root || !existsSync(root)) return { mirrorDir, remotePath, machine }
  const base = norm(local)
  let hostDirs
  try {
    hostDirs = readdirSync(root)
  } catch {
    return { mirrorDir, remotePath, machine }
  }
  for (const hostDir of hostDirs) {
    const hostPath = path.join(root, hostDir)
    if (!statSync(hostPath, { throwIfNoEntry: false })?.isDirectory?.()) continue
    let entries
    try {
      entries = readdirSync(hostPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      const metaPath = path.join(hostPath, entry, '.dsh-remote-meta.json')
      if (!existsSync(metaPath)) continue
      const mirrorAbs = norm(path.join(hostPath, entry))
      if (!isUnder(base, mirrorAbs)) continue
      // Deepest match wins; an equal-length path cannot occur twice.
      if (mirrorDir && mirrorAbs.length <= mirrorDir.length) continue
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        if (!meta || !meta.host) continue
        mirrorDir = mirrorAbs
        remotePath = String(meta.remotePath || '')
        machine = {
          host: String(meta.host),
          port: Number(meta.port) || 22,
          username: String(meta.username || ''),
        }
      } catch { /* unparsable meta → not a usable binding */ }
    }
  }
  return { mirrorDir, remotePath, machine }
}

/**
 * Stable pool key for a remote identity. Two sessions on the same machine
 * produce the same key and therefore share one SSH connection; sessions on
 * different machines never collide.
 * @param {{host: string, port?: number|string, username?: string}} m - the remote identity.
 * @returns {string} the canonical `user@host:port` key.
 */
export function poolKey(m) {
  return `${(m && m.username) || ''}@${(m && m.host) || ''}:${Number(m && m.port) || 22}`
}
