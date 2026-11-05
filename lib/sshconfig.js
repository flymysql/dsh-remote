// dsh-remote — ~/.ssh/config reading and OpenSSH alias resolution (issue #38).
//
// ## Why this module exists
//
// A saved machine can be an ALIAS from the user's ssh config: the registry keeps
// `{ host: '<alias>', useSshConfig: true }` and NOTHING else — no HostName, no
// user, no port, no key path. Every connect resolves that alias against
// `~/.ssh/config` as it is RIGHT NOW, which is what VSCode Remote-SSH does with
// the same file: editing the config (a new jump host, a rotated IdentityFile, a
// different port) is picked up without re-importing anything into the plugin.
//
// ## What is read
//
// Host / HostName / User / Port / IdentityFile / ProxyJump / ProxyCommand /
// IdentityAgent / IdentitiesOnly. `IdentityFile` is imported as a PATH
// reference only — the plugin never opens key material (v0.5.5 policy); its
// `%n`-style tokens are expanded (expandSshTokens). A `.pub` IdentityFile is
// OpenSSH's "use THIS agent key" idiom, which the pool honours.
//
// ## OpenSSH semantics implemented
//
//   • `Host a b` / `Host *.example.com` / `Host !x *.y` pattern lists, evaluated
//     with `*` and `?` wildcards, case-insensitively (see hostBlockMatches).
//   • first-obtained-value-wins ACROSS all matching blocks, not first-block-wins:
//     ssh_config(5) — "for each parameter, the first obtained value will be used".
//   • `Include` directives, globbed, expanded in place, relative to ~/.ssh
//     (falling back to the including file's directory), depth- and cycle-limited.
//   • backslash line continuations.
//
// The module is pure (I/O is injectable), so it is unit-testable without a real
// home directory — see test/sshconfig.test.js.

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, hostname as osHostname, userInfo } from 'node:os'
import path from 'node:path'

/** Default location of the user's ssh config. An env override exists so tests
 *  (and any deployment that isolates its home directory) can point the plugin
 *  at a substitute file instead of the real ~/.ssh/config. */
export const sshConfigPath = () => {
  const env = process.env.DSH_REMOTE_SSH_CONFIG
  if (env && String(env).trim()) return path.resolve(String(env).trim())
  return path.join(homedir(), '.ssh', 'config')
}

/** Directory `Include` paths are resolved against (ssh_config(5)). */
export const sshConfigDir = () => {
  const env = process.env.DSH_REMOTE_SSH_CONFIG
  if (env && String(env).trim()) return path.dirname(path.resolve(String(env).trim()))
  return path.join(homedir(), '.ssh')
}

/** Parameters the resolver cares about, lowercase (as parsed). */
const KNOWN_PARAMS = new Set([
  'hostname', 'user', 'port', 'identityfile', 'proxyjump', 'proxycommand', 'identitiesonly',
  'identityagent',
])

/** Read the user's ~/.ssh/config text, Includes expanded ('' when absent). */
export function readSshConfigText(filePath = sshConfigPath()) {
  return loadSshConfigText(filePath)
}

/**
 * Read an ssh config file and expand its `Include` directives in place.
 *
 * Relative includes resolve against `~/.ssh` first (ssh_config(5)) and then
 * against the including file's directory, because real-world configs use both.
 * A missing or unreadable include is skipped: one broken line must not hide the
 * rest of the config.
 *
 * @param {string} [filePath] - the config file (default ~/.ssh/config).
 * @param {object} [io] - injectable filesystem hooks (tests).
 * @param {(p: string) => string} [io.readFile]
 * @param {(p: string) => boolean} [io.exists]
 * @param {(p: string) => string[]} [io.listDir]
 * @param {number} [io.maxDepth]
 * @returns {string} the expanded config text ('' when nothing could be read).
 */
export function loadSshConfigText(filePath = sshConfigPath(), io = {}) {
  const readFile = io.readFile || ((p) => readFileSync(p, 'utf8'))
  const listDir = io.listDir || ((p) => readdirSync(p))
  return expandFile(filePath, { readFile, listDir, maxDepth: io.maxDepth ?? 3, depth: 0, seen: new Set() })
}

function expandFile(file, state) {
  let text
  try {
    text = state.readFile(file)
  } catch {
    return ''
  }
  if (typeof text !== 'string') return ''
  if (state.depth >= state.maxDepth) return text
  const out = []
  for (const line of joinContinuations(text)) {
    const patterns = matchInclude(line)
    if (!patterns) { out.push(line); continue }
    for (const pattern of patterns) {
      for (const included of expandIncludePath(pattern, path.dirname(file), state.listDir)) {
        const key = path.resolve(included)
        if (state.seen.has(key)) continue
        state.seen.add(key)
        const child = expandFile(included, { ...state, depth: state.depth + 1 })
        if (child.trim()) out.push(child)
      }
    }
  }
  return out.join('\n')
}

/** The value tokens of `Include <pattern> [pattern...]`, or null. */
function matchInclude(line) {
  const m = String(line).match(/^\s*include\s+(.+?)\s*$/i)
  if (!m) return null
  return splitValue(m[1])
}

/** Expand one include pattern.
 *
 *  ssh_config(5): a relative path is relative to `~/.ssh`. The including file's
 *  own directory is tried only when that yields nothing — which is what makes
 *  the plugin able to read a config the user pointed it at elsewhere, without
 *  double-resolving (and double-reading) the normal `~/.ssh` case.
 */
function expandIncludePath(pattern, callerDir, listDir) {
  const raw = stripQuotes(pattern)
  if (!raw) return []
  if (path.isAbsolute(raw)) return globFiles(raw, listDir).sort()
  if (raw.startsWith('~')) return globFiles(path.join(homedir(), raw.replace(/^~[\\/]?/, '')), listDir).sort()
  const primary = globFiles(path.join(sshConfigDir(), raw), listDir)
  if (primary.length) return primary.sort()
  if (callerDir && path.resolve(callerDir) !== path.resolve(sshConfigDir())) {
    return globFiles(path.join(callerDir, raw), listDir).sort()
  }
  return []
}

/** Files matching a path whose basename may contain `*` / `?` (one level). */
function globFiles(target, listDir) {
  const base = path.basename(target)
  if (!/[*?]/.test(base)) return [target]
  const dir = path.dirname(target)
  let entries
  try {
    entries = listDir(dir)
  } catch {
    return []
  }
  const re = globRegex(base)
  return entries
    .filter((name) => re.test(name))
    .map((name) => path.join(dir, name))
}

/** Join lines ending in a backslash (ssh config line continuation). */
function joinContinuations(text) {
  const lines = []
  let pending = ''
  for (const raw of String(text).split('\n')) {
    const line = pending + raw
    if (/\\\s*$/.test(line) && !/\\\\\s*$/.test(line)) {
      pending = line.replace(/\\\s*$/, ' ') + ' '
      continue
    }
    pending = ''
    lines.push(line)
  }
  if (pending) lines.push(pending)
  return lines
}

/** Config lines with continuations joined — the form every parser consumes. */
const configLines = (text) => joinContinuations(text)

/** Split a parameter value into whitespace-separated tokens, honoring quotes. */
export function splitValue(value) {
  return (String(value || '').match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map(stripQuotes)
    .filter((token) => token !== '')
}

const stripQuotes = (s) => String(s || '').replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1')

/**
 * Parse OpenSSH config text into Host BLOCKS, preserving pattern lists.
 * @param {string} text
 * @returns {Array<{patterns: string[], values: Record<string, string|number>, line: number}>}
 */
export function parseHostBlocks(text) {
  const blocks = []
  let current = null
  const lines = configLines(text)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s+(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'host') {
      current = { patterns: splitValue(value), values: {}, line: i + 1 }
      blocks.push(current)
      continue
    }
    if (!current || !KNOWN_PARAMS.has(key)) continue
    // First value wins inside a block too (a repeated parameter is ignored).
    if (Object.prototype.hasOwnProperty.call(current.values, key)) continue
    current.values[key] = key === 'port' ? (Number(value) || value) : stripQuotes(value)
  }
  return blocks
}

/**
 * Legacy block list: one entry per `Host` line, flattened to the fields the
 * import UI shows. Kept stable for the existing importer + tests.
 * @returns {Array<{host: string, hostName: string, user: string, port: number, identityFile: string, proxyJump: string}>}
 */
export function parseSshConfig(text) {
  const entries = []
  let cur = null
  for (const raw of configLines(text)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s+(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'host') {
      cur = { host: stripQuotes(val), hostName: '', user: '', port: 22, identityFile: '', proxyJump: '' }
      entries.push(cur)
      continue
    }
    if (!cur) continue
    if (key === 'hostname' && !cur.hostName) cur.hostName = stripQuotes(val)
    else if (key === 'user' && !cur.user) cur.user = stripQuotes(val)
    else if (key === 'port' && cur.port === 22) cur.port = Number(val) || 22
    else if (key === 'identityfile' && !cur.identityFile) cur.identityFile = stripQuotes(val)
    else if (key === 'proxyjump' && !cur.proxyJump) cur.proxyJump = stripQuotes(val)
  }
  return entries
}

/** Entries a user can actually import: concrete aliases (skip wildcards). */
export function importableEntries(text) {
  return parseSshConfig(text).filter((e) => {
    if (!e.host || e.host.includes('*') || e.host.includes('!') || e.host.includes(',')) return false
    return e.hostName || e.user || e.port !== 22 || e.identityFile || e.proxyJump
  })
}

/**
 * Every concrete (non-wildcard) alias the config defines, with the effective
 * values after OpenSSH first-wins resolution — the list the import UI offers.
 * @param {string} text
 * @returns {Array<{alias: string, hostName: string, user: string, port: number, identityFile: string, proxyJump: string, proxyCommand: string}>}
 */
export function listAliases(text) {
  const seen = new Set()
  const out = []
  for (const block of parseHostBlocks(text)) {
    for (const pattern of block.patterns) {
      if (!pattern || /[*?!]/.test(pattern) || seen.has(pattern)) continue
      seen.add(pattern)
      out.push(resolveSshHost(pattern, text))
    }
  }
  return out.sort((a, b) => compareText(a.alias, b.alias))
}

/** Glob match for ssh host patterns (`*`, `?`), case-insensitive. */
export function globMatch(pattern, value) {
  return globRegex(pattern).test(String(value || ''))
}

function globRegex(pattern) {
  let re = ''
  for (const ch of String(pattern || '')) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

/**
 * Whether a `Host` pattern list applies to a name: any positive pattern matches
 * AND no negated (`!`) pattern does.
 * @param {string[]|string} patterns
 * @param {string} name
 */
export function hostBlockMatches(patterns, name) {
  const list = Array.isArray(patterns) ? patterns : splitValue(patterns)
  const negative = list.filter((p) => p.startsWith('!')).map((p) => p.slice(1))
  const positive = list.filter((p) => !p.startsWith('!'))
  if (negative.some((p) => globMatch(p, name))) return false
  return positive.some((p) => globMatch(p, name))
}

/**
 * Effective configuration for one alias, with OpenSSH first-wins semantics.
 *
 * `hostName` falls back to the alias itself (ssh's own behaviour), so a block
 * that only sets `User`/`IdentityFile` still yields a connectable host.
 *
 * @param {string} alias
 * @param {string} text - FULL config text (Include-expanded).
 * @returns {{alias: string, matched: boolean, hostName: string, user: string, port: number, identityFile: string, proxyJump: string, proxyCommand: string, identitiesOnly: string, identityAgent: string}}
 */
export function resolveSshHost(alias, text) {
  const name = String(alias || '').trim()
  const out = {
    alias: name,
    matched: false,
    hostName: '',
    user: '',
    port: 0,
    identityFile: '',
    proxyJump: '',
    proxyCommand: '',
    identitiesOnly: '',
    identityAgent: '',
  }
  if (!name) return out
  for (const block of parseHostBlocks(text)) {
    if (!hostBlockMatches(block.patterns, name)) continue
    out.matched = true
    // first obtained value wins, ACROSS blocks in file order
    for (const [key, value] of Object.entries(block.values)) {
      if (key === 'hostname') { if (!out.hostName) out.hostName = String(value) }
      else if (key === 'user') { if (!out.user) out.user = String(value) }
      else if (key === 'port') { if (!out.port) out.port = Number(value) || 0 }
      else if (key === 'identityfile') { if (!out.identityFile) out.identityFile = String(value) }
      else if (key === 'proxyjump') { if (!out.proxyJump) out.proxyJump = String(value) }
      else if (key === 'proxycommand') { if (!out.proxyCommand) out.proxyCommand = String(value) }
      else if (key === 'identitiesonly') { if (!out.identitiesOnly) out.identitiesOnly = String(value) }
      else if (key === 'identityagent') { if (!out.identityAgent) out.identityAgent = String(value) }
    }
  }
  if (!out.hostName) out.hostName = name
  return out
}

/**
 * Resolve an alias from a config FILE (Include-expanded) or from given text.
 * @param {string} alias
 * @param {{file?: string, text?: string, io?: object}} [opts]
 */
export function resolveSshAlias(alias, opts = {}) {
  const text = opts.text !== undefined ? String(opts.text) : loadSshConfigText(opts.file || sshConfigPath(), opts.io || {})
  return resolveSshHost(alias, text)
}

/** Expand a leading `~` in an ssh config path (IdentityFile). */
export function expandHome(p) {
  const s = String(p || '')
  if (!s.startsWith('~')) return s
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(homedir(), s.slice(2))
  return s
}

/**
 * Expand ssh_config(5) TOKENS and `${VAR}` environment references in an
 * IdentityFile / IdentityAgent value: `%%` `%d` `%h` `%n` `%p` `%r` `%u` `%i`
 * `%l` `%L`. A config like `IdentityFile ~/.ssh/%n.pub` (one key per alias)
 * used to be read as a file literally named `%n.pub`. Unknown tokens are left
 * as-is, so the resulting "file not found" names what was not understood.
 *
 * @param {string} value
 * @param {{alias?: string, host?: string, port?: number, user?: string}} ctx
 */
export function expandSshTokens(value, ctx = {}) {
  const s = String(value || '')
  let localUser = ''
  try { localUser = userInfo().username } catch {}
  const longHost = (() => { try { return osHostname() } catch { return '' } })()
  const map = {
    '%': '%',
    d: homedir(),
    h: String(ctx.host || ctx.alias || ''),
    n: String(ctx.alias || ctx.host || ''),
    p: String(Number(ctx.port) || 22),
    r: String(ctx.user || localUser),
    u: localUser,
    i: (() => { try { return String(process.getuid ? process.getuid() : '') } catch { return '' } })(),
    l: longHost.split('.')[0],
    L: longHost.split('.')[0],
  }
  return s
    .replace(/%([%a-zA-Z])/g, (m, t) => (Object.prototype.hasOwnProperty.call(map, t) ? map[t] : m))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, v) => (process.env[v] !== undefined ? process.env[v] : m))
}

/** An IdentityFile path, tokens and `~` expanded. */
function identityPath(value, ctx) {
  return value ? expandHome(expandSshTokens(value, ctx)) : ''
}

/**
 * The agent socket an `IdentityAgent` value selects. `''` means "the process
 * SSH_AUTH_SOCK" (also what `SSH_AUTH_SOCK` itself and an unset value mean);
 * `none` disables the agent and is returned as the literal `'none'`.
 */
function identityAgentPath(value, ctx) {
  const v = String(value || '').trim()
  if (!v || v === 'SSH_AUTH_SOCK') return ''
  if (/^none$/i.test(v)) return 'none'
  // `$VAR` (no braces) names an environment variable holding the socket path.
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return process.env[v.slice(1)] || ''
  return expandHome(expandSshTokens(v, ctx))
}

/**
 * Split a ProxyJump value into hops: `[user@]host[:port]`, comma-separated, and
 * `none` meaning "no jump".
 * @param {string} value
 * @returns {Array<{user: string, host: string, port: number}>}
 */
export function parseProxyJump(value) {
  const raw = String(value || '').trim()
  if (!raw || /^none$/i.test(raw)) return []
  return raw.split(',').map((hop) => hop.trim()).filter(Boolean).map((hop) => {
    const m = hop.match(/^(?:([^@]+)@)?([^:[\] ]+)(?::(\d+))?$/)
    if (!m) return { user: '', host: hop, port: 0 }
    return { user: m[1] || '', host: m[2], port: Number(m[3]) || 0 }
  })
}

/**
 * Shared proxy/warning shaping for alias and literal resolutions (issue #50).
 *
 * `ProxyJump` maps onto the plugin's single jump host. A multi-hop chain cannot
 * be represented by one `proxy`, so the FIRST hop is used and `warnings` says so
 * — silently connecting through the wrong path would be worse. `ProxyCommand`
 * (an arbitrary local command) is reported but never executed.
 */
function targetFromResolved(resolved, text, { defaultPort }) {
  const warnings = []
  const ctx = {
    alias: resolved.alias,
    host: resolved.hostName || resolved.alias,
    port: resolved.port || defaultPort || 22,
    user: resolved.user,
  }
  let proxy
  const hops = parseProxyJump(resolved.proxyJump)
  if (hops.length > 1) {
    warnings.push(`ProxyJump has ${hops.length} hops; dsh-remote supports one jump host — using the first (${hops[0].host}).`)
  }
  if (hops.length) {
    const hop = hops[0]
    const hopResolved = resolveSshHost(hop.host, text)
    proxy = {
      host: hopResolved.hostName || hop.host,
      port: hop.port || hopResolved.port || 22,
      username: hop.user || hopResolved.user || '',
      privateKeyPath: identityPath(hopResolved.identityFile, {
        alias: hop.host, host: hopResolved.hostName || hop.host,
        port: hop.port || hopResolved.port, user: hop.user || hopResolved.user,
      }),
      passphrase: '',
      password: '',
    }
    // Only when set, so a hop without them keeps its established shape.
    const hopAgent = identityAgentPath(hopResolved.identityAgent, { alias: hop.host, host: hopResolved.hostName || hop.host })
    if (hopAgent) proxy.agentSocket = hopAgent
    if (/^yes$/i.test(hopResolved.identitiesOnly || '')) proxy.identitiesOnly = true
  } else if (resolved.proxyCommand) {
    warnings.push('ProxyCommand is not supported by dsh-remote (no jump host was applied).')
  }
  return {
    alias: resolved.alias,
    matched: resolved.matched,
    host: resolved.hostName || resolved.alias,
    port: resolved.port || defaultPort,
    username: resolved.user || '',
    privateKeyPath: identityPath(resolved.identityFile, ctx),
    agentSocket: identityAgentPath(resolved.identityAgent, ctx),
    identitiesOnly: /^yes$/i.test(resolved.identitiesOnly || ''),
    proxy,
    proxyJump: resolved.proxyJump,
    warnings,
  }
}

/**
 * Connect target for an ssh-config alias: the shape the plugin's pool expects.
 *
 * @param {string} alias
 * @param {object} [opts]
 * @param {string} [opts.text] - config text (else the real file is read).
 * @param {string} [opts.file]
 * @param {object} [opts.io]
 * @returns {{alias: string, matched: boolean, host: string, port: number, username: string, privateKeyPath: string, proxy: object|undefined, proxyJump: string, warnings: string[]}}
 */
export function sshAliasTarget(alias, opts = {}) {
  const text = opts.text !== undefined ? String(opts.text) : loadSshConfigText(opts.file || sshConfigPath(), opts.io || {})
  return targetFromResolved(resolveSshHost(alias, text), text, { defaultPort: 22 })
}

/**
 * Effective connect identity for a LITERAL machine (issue #50).
 *
 * A machine saved with literal host/user/port/key holds a COPY of what may also
 * be written in ~/.ssh/config, and the copy goes stale the moment the file is
 * edited. The file is the single source for any host it NAMES: when a Host
 * block matches the machine's literal host — with at least one positive pattern
 * that is not the bare `*` — the resolved values win per field and the record
 * fills the gaps. A bare `Host *` block deliberately does NOT name a host:
 * treating universal defaults as an override would hijack every saved machine
 * at once. Group patterns (`*.corp`, `web-?`) DO name hosts, exactly as ssh
 * itself applies them to a literal dial.
 *
 * `port` is 0 (not 22) when the file says nothing, so the caller falls back to
 * the record instead of the default.
 *
 * @param {object} machine - a registry record with a literal `host`.
 * @param {{text?: string, file?: string, io?: object}} [opts]
 * @returns {null | {alias: string, matched: true, host: string, port: number, username: string, privateKeyPath: string, proxy: object|undefined, proxyJump: string, warnings: string[]}}
 *   null when no Host block names the machine's host.
 */
export function resolveLiteralSshConfig(machine, opts = {}) {
  if (!machine || machine.useSshConfig) return null
  const name = String(machine.host || '').trim()
  if (!name) return null
  const text = opts.text !== undefined ? String(opts.text) : loadSshConfigText(opts.file || sshConfigPath(), opts.io || {})
  const resolved = {
    alias: name, matched: false, hostName: '', user: '', port: 0,
    identityFile: '', proxyJump: '', proxyCommand: '', identitiesOnly: '', identityAgent: '',
  }
  for (const block of parseHostBlocks(text)) {
    if (!hostBlockMatches(block.patterns, name)) continue
    const positive = block.patterns.filter((p) => !p.startsWith('!'))
    // A block whose only positive pattern is the bare `*` is a defaults block,
    // not a block that names this host.
    if (positive.length && positive.every((p) => p === '*')) continue
    resolved.matched = true
    for (const [key, value] of Object.entries(block.values)) {
      if (key === 'hostname') { if (!resolved.hostName) resolved.hostName = String(value) }
      else if (key === 'user') { if (!resolved.user) resolved.user = String(value) }
      else if (key === 'port') { if (!resolved.port) resolved.port = Number(value) || 0 }
      else if (key === 'identityfile') { if (!resolved.identityFile) resolved.identityFile = String(value) }
      else if (key === 'proxyjump') { if (!resolved.proxyJump) resolved.proxyJump = String(value) }
      else if (key === 'proxycommand') { if (!resolved.proxyCommand) resolved.proxyCommand = String(value) }
      else if (key === 'identitiesonly') { if (!resolved.identitiesOnly) resolved.identitiesOnly = String(value) }
      else if (key === 'identityagent') { if (!resolved.identityAgent) resolved.identityAgent = String(value) }
    }
  }
  if (!resolved.matched) return null
  return targetFromResolved(resolved, text, { defaultPort: 0 })
}

/**
 * Effective connect identity for a saved machine.
 *
 * A machine in ALIAS mode (`useSshConfig: true`, `host` = the alias) inherits
 * everything from ~/.ssh/config; a field the user filled in explicitly still
 * wins. "Explicitly" cannot be distinguished from "form default" for the two
 * fields that have defaults (port 22, user `root`), so those inherit unless they
 * differ from the default — stated in the settings UI.
 *
 * @param {object} machine
 * @param {{text?: string, file?: string, io?: object}} [opts]
 * @returns {{alias: string, matched: boolean, host: string, port: number, username: string, privateKeyPath: string, proxy: object|undefined, warnings: string[]}|null}
 *   null when the machine is not in alias mode.
 */
export function resolveMachineSshConfig(machine, opts = {}) {
  if (!machine || !machine.useSshConfig) return null
  const alias = String(machine.host || '').trim()
  if (!alias) return null
  const target = sshAliasTarget(alias, opts)
  const warnings = [...target.warnings]
  if (!target.matched) warnings.push(`no ~/.ssh/config block matches "${alias}" — using the name itself.`)
  const port = machine.port && Number(machine.port) !== 22 ? Number(machine.port) : target.port
  const username = machine.username && machine.username !== 'root' ? String(machine.username) : (target.username || machine.username || '')
  const privateKeyPath = machine.privateKeyPath ? String(machine.privateKeyPath) : target.privateKeyPath
  const proxy = machine.proxy && machine.proxy.host ? machine.proxy : target.proxy
  return {
    alias,
    matched: target.matched,
    host: target.host,
    port: Number(port) || 22,
    username: String(username || ''),
    privateKeyPath,
    agentSocket: target.agentSocket,
    identitiesOnly: target.identitiesOnly,
    proxy,
    warnings,
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

// ── Writing: the managed Host block (issue #50) ─────────────────────────────
//
// The four connection fields (host/user/port/key) have ONE home: ~/.ssh/config.
// When the plugin saves a literal machine it upserts a Host block tagged with
// MANAGED_MARK, so the file and the registry can never drift — and so the
// plugin can tell ITS OWN block apart from one the user wrote. Two rules keep
// the file safe:
//   • a Host block without the marker is never touched — a same-named user
//     block is a CONFLICT, reported to the caller instead of overwritten;
//   • inside a managed block, lines the plugin does not own (a user-added
//     `ForwardAgent yes`, a comment) survive an update — only the four known
//     parameters are rewritten.

/** Marker comment that tags a Host block as owned by dsh-remote. */
export const MANAGED_MARK = '# dsh-remote: managed'

/** Parameters the managed block rewrites (lowercase). */
const MANAGED_PARAMS = new Set(['hostname', 'user', 'port', 'identityfile'])

/** Read the RAW config text — no Include expansion (a write targets ONE file). */
export function readRawSshConfig(filePath = sshConfigPath()) {
  try {
    const text = readFileSync(filePath, 'utf8')
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/** Quote one value for a config line when it contains whitespace. */
function quoteCfg(value) {
  const s = String(value)
  return /[\s#]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/** The values a managed block must carry for these fields ('' = omit). */
function desiredValues(fields) {
  const alias = String(fields.alias || '').trim()
  const hostName = String(fields.hostName || '').trim()
  const port = Number(fields.port) || 0
  return {
    hostname: hostName && hostName !== alias ? hostName : '',
    user: String(fields.user || '').trim(),
    port: port && port !== 22 ? port : '',
    identityfile: String(fields.identityFile || '').trim(),
  }
}

/** Render the owned body lines of a managed block. */
function desiredLines(fields) {
  const want = desiredValues(fields)
  const out = []
  if (want.hostname) out.push(`  HostName ${quoteCfg(want.hostname)}`)
  if (want.user) out.push(`  User ${quoteCfg(want.user)}`)
  if (want.port) out.push(`  Port ${want.port}`)
  if (want.identityfile) out.push(`  IdentityFile ${quoteCfg(want.identityfile)}`)
  return out
}

/**
 * Locate the MANAGED Host block for `alias` in raw config lines.
 * The marker must be the nearest non-blank line above the Host line; a block
 * that names the alias without the marker is the user's, not ours.
 */
function locateManagedBlock(lines, alias) {
  const wanted = alias.toLowerCase()
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*host\s+(.+?)\s*$/i)
    if (!m) continue
    const names = splitValue(m[1]).map((p) => p.toLowerCase())
    if (!names.includes(wanted)) continue
    let j = i - 1
    while (j >= 0 && lines[j].trim() === '') j -= 1
    if (j < 0 || lines[j].trim().toLowerCase() !== MANAGED_MARK) continue
    let end = lines.length
    for (let k = i + 1; k < lines.length; k += 1) {
      if (/^\s*(host|match)\s/i.test(lines[k])) { end = k; break }
    }
    return { markerLine: j, hostLine: i, end }
  }
  return null
}

/** Whether an UNMANAGED Host block names `alias` (exact token, case-insensitive). */
function hasUnmanagedConflict(lines, alias) {
  const wanted = alias.toLowerCase()
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*host\s+(.+?)\s*$/i)
    if (!m) continue
    const names = splitValue(m[1]).map((p) => p.toLowerCase())
    if (!names.includes(wanted)) continue
    let j = i - 1
    while (j >= 0 && lines[j].trim() === '') j -= 1
    if (j >= 0 && lines[j].trim().toLowerCase() === MANAGED_MARK) continue // ours
    return true
  }
  return false
}

/**
 * Insert or refresh the managed Host block for a saved machine.
 *
 * @param {string} rawText - the RAW ~/.ssh/config text ('' when absent).
 * @param {{alias: string, hostName?: string, user?: string, port?: number|string, identityFile?: string}} fields
 * @returns {{status: 'appended'|'updated'|'unchanged'|'conflict'|'invalid', text: string}}
 *   'conflict' — an unmanaged block already names the alias (text untouched);
 *   'invalid' — the alias can never be a safe Host token (space/wildcard).
 */
export function upsertManagedHostBlock(rawText, fields) {
  const text = String(rawText || '')
  const alias = String((fields && fields.alias) || '').trim()
  if (!alias || /[\s*?!,]/.test(alias)) return { status: 'invalid', text }
  const lines = text.split('\n')
  if (hasUnmanagedConflict(lines, alias)) return { status: 'conflict', text }

  const want = desiredValues({ ...fields, alias })
  const found = locateManagedBlock(lines, alias)
  if (!found) {
    const block = [MANAGED_MARK, `Host ${alias}`, ...desiredLines({ ...fields, alias })]
    const trimmedEnd = text.replace(/\s+$/, '')
    const prefix = trimmedEnd === '' ? '' : trimmedEnd + '\n\n'
    return { status: 'appended', text: prefix + block.join('\n') + '\n' }
  }

  // Compare what the block HAS with what it MUST have; a rewrite that changes
  // nothing would only cost the file's mtime.
  const current = parseHostBlocks(lines.slice(found.hostLine, found.end).join('\n'))[0]
  const cur = (current && current.values) || {}
  const same = ['hostname', 'user', 'port', 'identityfile']
    .every((k) => String(cur[k] ?? '') === String(want[k] ?? ''))
  if (same) return { status: 'unchanged', text }

  // Rewrite only the four owned parameters; user lines inside OUR block stay.
  const body = lines.slice(found.hostLine + 1, found.end)
  const kept = body.filter((l) => {
    const m = l.match(/^\s*(\S+)\s/)
    return !m || !MANAGED_PARAMS.has(m[1].toLowerCase())
  })
  const next = [
    ...lines.slice(0, found.hostLine + 1),
    ...desiredLines({ ...fields, alias }),
    ...kept,
    ...lines.slice(found.end),
  ]
  return { status: 'updated', text: next.join('\n') }
}

/**
 * Remove the managed block for `alias` (used when a machine is RENAMED away:
 * the old block is the plugin's own artifact of that edit). Deleting a machine
 * deliberately does NOT call this — the Host block is the user's ssh access,
 * not plugin state. Unmanaged blocks are never removed.
 *
 * @returns {{status: 'removed'|'absent', text: string}}
 */
export function removeManagedHostBlock(rawText, alias) {
  const text = String(rawText || '')
  const name = String(alias || '').trim()
  if (!name) return { status: 'absent', text }
  const lines = text.split('\n')
  const found = locateManagedBlock(lines, name)
  if (!found) return { status: 'absent', text }
  let start = found.markerLine
  while (start > 0 && lines[start - 1].trim() === '') start -= 1
  const next = [...lines.slice(0, start), ...lines.slice(found.end)]
  return { status: 'removed', text: next.join('\n') }
}

/**
 * Persist a config text, creating ~/.ssh first. Permissions follow OpenSSH's
 * expectations on POSIX (dir 0700, file 0600) and are a no-op elsewhere.
 */
export function writeSshConfig(text, filePath = sshConfigPath(), io = {}) {
  const mkdir = io.mkdir || ((p) => mkdirSync(p, { recursive: true }))
  const write = io.write || ((p, data) => writeFileSync(p, data, 'utf8'))
  const chmod = io.chmod || ((p, mode) => { try { chmodSync(p, mode) } catch { /* no modes here */ } })
  mkdir(path.dirname(filePath))
  write(filePath, String(text))
  if (process.platform !== 'win32') {
    chmod(path.dirname(filePath), 0o700)
    chmod(filePath, 0o600)
  }
}
