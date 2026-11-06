// Local-mirror workspace cleanup — the filesystem half of the TUI's
// "彻底删除工作区 / 只删除对话" actions.
//
// Two rules drive everything here:
//   1. NEVER delete outside `$DSH_HOME/remote-workspaces/<host>-<user>-<port>/<name>`.
//      The mirror root is the only tree this module accepts, the target must be
//      exactly two levels below it, and its `.dsh-remote-meta.json` must parse —
//      a symlinked or half-typed path is refused instead of guessed at.
//   2. Session logs live at `$DSH_HOME/sessions/<project-key(cwd)>/<encoded id>`
//      (the layout of `@deepseek-ai/dsh-session-persistence-jsonl`). The key and
//      segment encoders below mirror that package's `projectKey()` /
//      `encodeSegment()` so this module can find the directories DSH itself
//      writes. They are pure and covered by tests; if DSH ever changes the
//      layout, those tests name the drift instead of silently deleting nothing.
//
// Deletion is intentionally synchronous: the caller runs it from a maintenance
// action (not a hot path), and it must finish before the UI reports success.

import { existsSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

/** Name of the per-mirror binding file (`ensureMirror()` writes it). */
export const MIRROR_META_FILE = '.dsh-remote-meta.json'

/** Encode an arbitrary string as one path segment (mirror of DSH's encoder).
 *
 * Safe code units stay literal; everything else (including `~`) becomes
 * `~XXXX` (UTF-16 code unit, uppercase hex, at least four digits). `.`/`..`
 * are special-cased so a segment can never traverse.
 *
 * @param {string} raw - non-empty string (session id).
 * @returns {string} a single filesystem-safe segment.
 */
export function encodeSegment(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw)
  if (value.length === 0) throw new Error('cannot encode an empty path segment')
  if (value === '.') return '~002E'
  if (value === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** Decode one `encodeSegment()` result back to the original string.
 *
 * @param {string} segment - encoded path segment.
 * @returns {string} the decoded value (unknown escapes are left verbatim).
 */
export function decodeSegment(segment) {
  const value = String(segment === undefined || segment === null ? '' : segment)
  let out = ''
  for (let i = 0; i < value.length;) {
    if (value[i] === '~' && /^[0-9A-Fa-f]{4}$/.test(value.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(value.slice(i + 1, i + 5), 16))
      i += 5
      continue
    }
    out += value[i]
    i += 1
  }
  return out
}

/** The project directory key DSH gives a session cwd (mirror of its encoder).
 *
 * Separators (`/`, `\`, `:`) collapse into one `-`; unsafe units escape as
 * `~XXXX`; the whole key is wrapped in `--` and capped at 251 characters.
 *
 * @param {string} cwd - absolute project directory.
 * @returns {string} the directory name under the sessions root.
 */
export function projectKey(cwd) {
  const value = String(cwd === undefined || cwd === null ? '' : cwd)
  if (value.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** True when `target` is a strict descendant of `root` (separator-aware). */
export function isUnder(root, target) {
  if (!root || !target) return false
  const rel = path.relative(path.resolve(String(root)), path.resolve(String(target)))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Parse a mirror's `.dsh-remote-meta.json`; undefined when absent/unusable.
 *
 * @param {string} localMirror - candidate mirror directory.
 * @returns {{host: string, port: number, username: string, remotePath: string, alias: string}|undefined}
 */
export function readMirrorMeta(localMirror) {
  const file = path.join(String(localMirror || ''), MIRROR_META_FILE)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    if (!parsed.host) return undefined
    return {
      host: String(parsed.host),
      port: Number(parsed.port) || 22,
      username: String(parsed.username || ''),
      remotePath: String(parsed.remotePath || ''),
      alias: String(parsed.alias || ''),
    }
  } catch {
    return undefined
  }
}

/** Validate that `localMirror` is a real mirror exactly two levels under the root.
 *
 * @param {object} input
 * @param {string} input.mirrorRoot - `$DSH_HOME/remote-workspaces`.
 * @param {string} input.localMirror - candidate directory.
 * @returns {{real: string, meta: object}} resolved path + parsed meta.
 * @throws {Error} `code: 'VALIDATION'` when the path is not a usable mirror.
 */
export function validateMirror({ mirrorRoot, localMirror } = {}) {
  const invalid = (message) => {
    const error = new Error(message)
    error.code = 'VALIDATION'
    return error
  }
  if (!mirrorRoot || !existsSync(mirrorRoot)) throw invalid('远程工作区根目录不存在')
  if (!localMirror || !path.isAbsolute(String(localMirror))) throw invalid('必须是绝对路径')
  let realRoot
  let real
  try {
    realRoot = realpathSync(String(mirrorRoot))
  } catch {
    throw invalid('远程工作区根目录不可读')
  }
  try {
    real = realpathSync(String(localMirror))
  } catch {
    throw invalid('目录不存在或已删除')
  }
  if (!isUnder(realRoot, real)) throw invalid('不是远程工作区镜像（不在 remote-workspaces 下）')
  const parts = path.relative(realRoot, real).split(path.sep).filter(Boolean)
  if (parts.length !== 2) throw invalid('不是远程工作区镜像（层级不符）')
  const meta = readMirrorMeta(real)
  if (!meta) throw invalid('缺少 .dsh-remote-meta.json，拒绝删除')
  return { real, meta }
}

/** Every mirror found under the registry root (read-only scan, no SSH). */
export function listMirrorEntries(mirrorRoot) {
  const entries = []
  if (!mirrorRoot || !existsSync(mirrorRoot)) return entries
  let hostDirs = []
  try {
    hostDirs = readdirSync(mirrorRoot, { withFileTypes: true })
  } catch {
    return entries
  }
  for (const hostDir of hostDirs) {
    if (!hostDir.isDirectory()) continue
    const hostPath = path.join(mirrorRoot, hostDir.name)
    let children = []
    try {
      children = readdirSync(hostPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const localMirror = path.join(hostPath, child.name)
      const meta = readMirrorMeta(localMirror)
      if (!meta) continue
      entries.push({ localMirror, mirrorName: child.name, hostDir: hostDir.name, ...meta })
    }
  }
  return entries
}

/** Sum a tree's bytes, capped so a huge mirror cannot stall the UI. */
export function dirSizeBytes(dir, limit = 5000) {
  let bytes = 0
  let files = 0
  let truncated = false
  const walk = (current, depth) => {
    if (truncated || depth > 24) return
    let list
    try {
      list = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of list) {
      if (entry.name === '.git') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        if (truncated) return
        continue
      }
      files += 1
      if (files > limit) {
        truncated = true
        return
      }
      try {
        bytes += statSync(full).size
      } catch { /* unreadable file: skip */ }
    }
  }
  walk(String(dir || ''), 0)
  return { bytes, truncated }
}

/** The project directory DSH groups one cwd's sessions under. */
export function sessionsDirFor(sessionsRoot, cwd) {
  return path.join(String(sessionsRoot), projectKey(String(cwd)))
}

/** Session directories DSH keeps for one project cwd.
 *
 * @param {object} input
 * @param {string} input.sessionsRoot - `$DSH_HOME/sessions`.
 * @param {string} input.cwd - the mirror directory recorded as the session cwd.
 * @returns {Array<{id: string, name: string, dir: string, modifiedAt: number}>}
 */
export function listSessionDirs({ sessionsRoot, cwd, cwds = [] } = {}) {
  const out = []
  if (!sessionsRoot || !cwd || !existsSync(sessionsRoot)) return out
  // DSH stores the cwd as the session header saw it. When `$DSH_HOME` itself
  // is behind a symlink, realpath() and the header path differ, so accept both
  // spellings (the caller passes the alias it was given) and dedupe by dir.
  const candidates = []
  for (const candidate of [cwd, ...(Array.isArray(cwds) ? cwds : [])]) {
    const value = String(candidate || '')
    if (!value) continue
    try {
      const dir = sessionsDirFor(sessionsRoot, value)
      if (!candidates.includes(dir)) candidates.push(dir)
    } catch { /* unencodable candidate */ }
  }
  const seen = new Set()
  for (const projectDir of candidates) {
    if (!existsSync(projectDir)) continue
    let children = []
    try {
      children = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const dir = path.join(projectDir, child.name)
      if (seen.has(dir)) continue
      seen.add(dir)
      let modifiedAt = 0
      try {
        modifiedAt = statSync(dir).mtimeMs || 0
      } catch { /* keep 0 */ }
      out.push({ id: decodeSegment(child.name), name: child.name, dir, modifiedAt })
    }
  }
  return out
}

/** Delete one mirror tree, refusing anything that is not a validated mirror.
 *
 * @param {object} input
 * @param {string} input.mirrorRoot - registry root.
 * @param {string} input.localMirror - mirror to remove.
 * @returns {boolean} true when removed.
 */
export function deleteMirrorTree({ mirrorRoot, localMirror } = {}) {
  const { real } = validateMirror({ mirrorRoot, localMirror })
  rmSync(real, { recursive: true, force: true })
  return true
}

/** Delete every session directory of one project cwd.
 *
 * `isLive(sessionId, dir)` is consulted per session; live ones are skipped and
 * reported so the caller can tell the person to stop them first. With
 * `force: true` they are deleted anyway (the confirmation text says so).
 *
 * @param {object} input
 * @param {string} input.sessionsRoot - `$DSH_HOME/sessions`.
 * @param {string} input.cwd - project cwd (the local mirror).
 * @param {(id: string, dir: string) => boolean|Promise<boolean>} [input.isLive]
 * @param {boolean} [input.force]
 * @returns {Promise<{removed: string[], skippedLive: string[]}>}
 */
export async function deleteSessionsFor({ sessionsRoot, cwd, cwds = [], isLive, force = false } = {}) {
  const removed = []
  const skippedLive = []
  for (const session of listSessionDirs({ sessionsRoot, cwd, cwds })) {
    let live = false
    if (!force && typeof isLive === 'function') {
      try {
        live = await isLive(session.id, session.dir) === true
      } catch {
        live = false
      }
    }
    if (live) {
      skippedLive.push(session.id)
      continue
    }
    try {
      rmSync(session.dir, { recursive: true, force: true })
      removed.push(session.id)
    } catch { /* unreadable dir: leave it and let the caller report fewer removals */ }
  }
  // Leave no empty history group behind when the last session is gone; a
  // non-empty dir (live session, unreadable sibling) makes rmdir a no-op.
  for (const candidate of [cwd, ...(Array.isArray(cwds) ? cwds : [])]) {
    if (!candidate) continue
    try {
      rmdirSync(sessionsDirFor(sessionsRoot, candidate))
    } catch { /* still holds something */ }
  }
  return { removed, skippedLive }
}
