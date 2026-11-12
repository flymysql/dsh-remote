// dsh-remote — discover project skills on the REMOTE workspace (issue #120).
//
// The core filesystem skill provider scans the LOCAL MIRROR. This provider
// supplements it with the authoritative remote roots, so a mirror does not have
// to be synced before `.dsh/skills` / `.agents/skills` can be discovered and
// loaded. Local sessions return no candidates and keep the core behavior.

import { parse as parseYaml } from 'yaml'
import { joinRemotePath, joinRemoteRel, normalizeRemotePath } from './paths.js'

export const REMOTE_SKILL_PROVIDER = 'dsh-remote'
// A synced mirror is a COPY. Prefer the remote candidate over the local
// filesystem provider's same-named copy (core ranks 100/200), while preserving
// .dsh > .agents and runtime/user precedence.
const DSH_RANK = 90
const AGENTS_RANK = 190
const MAX_ENTRIES_PER_ROOT = 200
const MAX_SKILL_BYTES = 256 * 1024
const DEFAULT_REFRESH_MS = 5 * 60 * 1000
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const ROOTS = [
  { suffix: '.dsh/skills', source: 'project-dsh', rank: DSH_RANK },
  { suffix: '.agents/skills', source: 'project-agents', rank: AGENTS_RANK },
]

function throwIfAborted(signal) {
  if (!signal || signal.aborted !== true) return
  throw signal.reason || Object.assign(new Error('remote skill discovery aborted'), { name: 'AbortError' })
}

function isMissing(error) {
  return /no such file|not found|does not exist|enoent|not directory|enotdir/i.test(String((error && error.message) || error))
}

function parseBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') switch (value.toLowerCase()) {
    case 'true': case 'yes': case 'on': return true
    case 'false': case 'no': case 'off': return false
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

function invocationOf(data) {
  // Match dsh-skill-filesystem exactly, including rejection of legacy keys.
  for (const [legacy, canonical] of [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ]) {
    if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
  return {
    modelInvocable: parseBoolean(data, 'disable-model-invocation') !== true,
    userInvocable: parseBoolean(data, 'user-invocable') !== false,
  }
}

/** Parse the core's YAML-frontmatter shape, including CRLF files. */
export function parseRemoteSkill(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '')
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0 || text.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let closing = null
  for (let lineStart = start; lineStart <= text.length;) {
    const nextNewline = text.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? text.length : nextNewline
    if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      closing = { start: lineStart, bodyStart: nextNewline < 0 ? text.length : nextNewline + 1 }
      break
    }
    if (nextNewline < 0) break
    lineStart = nextNewline + 1
  }
  if (!closing) return undefined
  const data = parseYaml(text.slice(start, closing.start))
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  if (typeof data.name !== 'string' || !SKILL_NAME.test(data.name)) return undefined
  if (typeof data.description !== 'string' || data.description.length === 0) return undefined
  // Invocation errors are deliberately fatal to this FILE, not the whole scan.
  const invocation = invocationOf(data)
  return {
    name: data.name,
    description: data.description,
    ...(typeof data.whenToUse === 'string' && data.whenToUse.length > 0 ? { whenToUse: data.whenToUse } : {}),
    invocation,
    ...(data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata) ? { metadata: data.metadata } : {}),
    content: text.slice(closing.bodyStart).trim(),
  }
}

function resourceBase(directory) {
  return {
    kind: 'opaque',
    description: `Remote workspace directory: ${directory}. Resolve/read adjacent resources with rw_list_dir / rw_read_file using remote paths relative to this directory; do not use local filesystem tools on this path.`,
  }
}

/**
 * Create the remote provider. Dependencies are injected to keep this module
 * testable without a live DSH composition.
 */
export function createRemoteSkillProvider(control, {
  resolveBinding,
  poolForMachine,
  logger,
  refreshMs = DEFAULT_REFRESH_MS,
  maxEntriesPerRoot = MAX_ENTRIES_PER_ROOT,
  maxSkillBytes = MAX_SKILL_BYTES,
} = {}) {
  let disposed = false
  let timer = null
  const warn = (message) => {
    try { if (logger && typeof logger.warn === 'function') logger.warn(`[dsh-remote] ${message}`) } catch { /* logging only */ }
  }
  const invalidate = () => {
    if (disposed) return
    try { control.invalidate() } catch { /* a replaced registration owns no cache */ }
  }
  const armRefresh = () => {
    if (disposed || timer || !Number.isFinite(refreshMs) || refreshMs <= 0) return
    timer = setInterval(() => {
      // No SFTP work here: the next normal skill lookup decides what to read.
      if (!disposed) invalidate()
    }, refreshMs)
    if (typeof timer.unref === 'function') timer.unref()
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (timer) clearInterval(timer)
    timer = null
  }
  if (control && control.signal && typeof control.signal.addEventListener === 'function') {
    control.signal.addEventListener('abort', dispose, { once: true })
  }

  async function readSkillText(sftp, target, signal) {
    throwIfAborted(control && control.signal)
    throwIfAborted(signal)
    let st
    try { st = await sftp.stat(target) } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    throwIfAborted(control && control.signal)
    throwIfAborted(signal)
    const size = st && typeof st.size === 'number' ? st.size : 0
    if (size > maxSkillBytes) {
      const error = new Error(`skill file ${target} exceeds ${maxSkillBytes} bytes`)
      error.code = 'SKILL_TOO_LARGE'
      throw error
    }
    const buf = await sftp.readFile(target)
    throwIfAborted(control && control.signal)
    throwIfAborted(signal)
    return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf)
  }

  function candidateFor(parsed, spec, locator) {
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      provider: REMOTE_SKILL_PROVIDER,
      source: spec.source,
      rank: spec.rank,
      locator,
      resourceBase: resourceBase(locator.directory),
      path: locator.path,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    }
  }

  async function discoverRoot(pool, binding, spec, signal) {
    const remoteRoot = normalizeRemotePath(binding.remotePath)
    const root = joinRemoteRel(remoteRoot, spec.suffix)
    let entries
    try { entries = await pool.sftp().then((sftp) => sftp.readdir(root)) } catch (error) {
      if (isMissing(error)) return { candidates: [], complete: true }
      throw error
    }
    throwIfAborted(control && control.signal)
    throwIfAborted(signal)
    const names = entries.map((entry) => String(entry.filename || ''))
      .filter((name) => name && name !== '.' && name !== '..')
      .sort((a, b) => a.localeCompare(b))
    let complete = true
    if (names.length > maxEntriesPerRoot) {
      complete = false
      warn(`skill root ${root} has ${names.length} entries; only the first ${maxEntriesPerRoot} were scanned`)
    }
    const candidates = []
    for (const name of names.slice(0, maxEntriesPerRoot)) {
      throwIfAborted(control && control.signal)
      throwIfAborted(signal)
      const entry = entries.find((item) => String(item.filename || '') === name)
      const attrs = (entry && entry.attrs) || {}
      // Never follow links out of the workspace. Regular files/directories only.
      if (attrs.isSymbolicLink && attrs.isSymbolicLink()) continue
      const isDirectory = !!(attrs.isDirectory && attrs.isDirectory())
      const locator = isDirectory
        ? { path: joinRemotePath(joinRemotePath(root, name), 'SKILL.md'), directory: joinRemotePath(root, name) }
        : name.endsWith('.md')
          ? { path: joinRemotePath(root, name), directory: root }
          : null
      if (!locator) continue
      locator.machine = binding.machine
      locator.remotePath = binding.remotePath
      let parsed
      try {
        const text = await readSkillText(await pool.sftp(), locator.path, signal)
        if (text === undefined) continue
        parsed = parseRemoteSkill(text)
      } catch (error) {
        throwIfAborted(control && control.signal)
        throwIfAborted(signal)
        if (error && error.code === 'SKILL_TOO_LARGE') {
          complete = false
          warn(error.message)
          continue
        }
        warn(`skill file ${locator.path} ignored: ${(error && error.message) || error}`)
        continue
      }
      if (!parsed) {
        warn(`skill file ${locator.path} ignored: missing/invalid frontmatter`)
        continue
      }
      candidates.push(candidateFor(parsed, spec, locator))
    }
    return { candidates, complete }
  }

  async function list(options = {}) {
    throwIfAborted(control && control.signal)
    throwIfAborted(options.signal)
    if (disposed) return []
    const binding = options.cwd ? resolveBinding(String(options.cwd)) : null
    if (!binding || !binding.remotePath || !binding.machine) return []
    armRefresh()
    const candidates = []
    let complete = true
    for (const spec of ROOTS) {
      throwIfAborted(control && control.signal)
      throwIfAborted(options.signal)
      try {
        const pool = poolForMachine(binding.machine)
        const result = await discoverRoot(pool, binding, spec, options.signal)
        candidates.push(...result.candidates)
        if (!result.complete) complete = false
      } catch (error) {
        throwIfAborted(control && control.signal)
        throwIfAborted(options.signal)
        complete = false
        warn(`remote skill discovery failed for ${spec.suffix}: ${(error && error.message) || error}`)
      }
    }
    // A failed scan must never become a cached, authoritative "no skills".
    return complete ? candidates : { candidates, complete: false }
  }

  async function get(candidate, options = {}) {
    throwIfAborted(control && control.signal)
    throwIfAborted(options.signal)
    if (disposed) return undefined
    const locator = candidate && candidate.locator
    if (!locator || !locator.machine || !locator.path) return undefined
    const pool = poolForMachine(locator.machine)
    const text = await readSkillText(await pool.sftp(), locator.path, options.signal)
    if (text === undefined) return undefined
    const parsed = parseRemoteSkill(text)
    if (!parsed) return undefined
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      source: candidate.source,
      provider: REMOTE_SKILL_PROVIDER,
      resourceBase: resourceBase(locator.directory),
      path: locator.path,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
      content: parsed.content,
    }
  }

  return { name: REMOTE_SKILL_PROVIDER, list, get, invalidate, dispose }
}

/** Register on hosts that support the skills service; older hosts stay as-is. */
export function registerRemoteSkills(ctx, dependencies) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.registerProvider !== 'function') return null
  let provider
  const unregister = skills.registerProvider((control) => {
    provider = createRemoteSkillProvider(control, dependencies)
    return provider
  })
  return {
    provider,
    invalidate: () => { if (provider) provider.invalidate() },
    dispose: unregister,
  }
}
