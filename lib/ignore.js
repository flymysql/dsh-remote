// dsh-remote — gitignore-style ignore matcher for mirror sync / remote search.
import { readFileSync } from 'node:fs'
//
// Deliberately a SUBSET of gitignore semantics (documented, no surprises):
//   - blank lines and `#` comments are skipped
//   - `!` negation is NOT supported (later rules never un-ignore)
//   - a trailing `/` matches directories only (and everything under them)
//   - a pattern containing `/` (or starting with `/`) is anchored to the
//     workspace root; otherwise it matches the basename at ANY depth
//   - `*` matches any run of chars except `/`; `**` matches any run incl. `/`;
//     `?` matches one char except `/`
//   - character classes (`[abc]`) are not supported (treated literally)

/** Convert one glob segment to a regex source (no `/` crossing). A leading
 * double-star-slash (`**` + `/`) matches zero or more directories (gitignore). */
function globToRe(glob) {
  let out = ''
  let i = 0
  const s = String(glob)
  if (s.startsWith('**/')) { out = '(?:.*/)?'; i = 3 }
  while (i < s.length) {
    const c = s[i]
    if (c === '*') {
      if (s[i + 1] === '*') { out += '.*'; i += 2; continue }
      out += '[^/]*'; i++; continue
    }
    if (c === '?') { out += '[^/]'; i++; continue }
    if ('\\^$+{}[]()|.'.includes(c)) out += '\\' + c
    else out += c
    i++
  }
  return out
}

/**
 * Parse ONE ignore line into `{ pattern, dirOnly, anchored }`, or null for a
 * blank / comment line.
 *
 * Shared with the POSIX search fast path (lib/search.js), which turns these into
 * `rg`/`grep` exclude flags: one parser means the shell path cannot drift
 * from the matcher the SFTP walk uses. `anchored` is true when the rule is
 * relative to the search root — a leading `/`, or any `/` left after the
 * markers are stripped.
 */
export function parseIgnoreRule(raw) {
  let line = String(raw || '').trim()
  if (!line || line.startsWith('#')) return null
  let dirOnly = false
  if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1) }
  let anchored = line.startsWith('/')
  if (anchored) line = line.slice(1)
  if (!line) return null
  return { pattern: line, dirOnly, anchored: anchored || line.includes('/') }
}

/**
 * Compile a list of ignore patterns into a matcher.
 * @param {string[]|string} patterns lines or an array of lines
 * @returns {(relPath: string, isDir?: boolean) => boolean} true = ignored.
 *   `relPath` is POSIX-style ('/' separated, no leading '/').
 */
export function compileIgnore(patterns) {
  const rules = []
  const lines = Array.isArray(patterns) ? patterns : String(patterns || '').split('\n')
  for (const raw of lines) {
    const rule = parseIgnoreRule(raw)
    if (!rule) continue
    const { pattern: line, dirOnly } = rule
    const segRe = globToRe(line)
    let re
    if (rule.anchored) {
      // Root-anchored: match the full path from the root.
      re = dirOnly
        ? new RegExp('^' + segRe + '(/.*)?$')
        : new RegExp('^' + segRe + '$')
    } else {
      // Basename at any depth; a dir pattern also covers everything under it.
      re = dirOnly
        ? new RegExp('(^|/)' + segRe + '(/|$)')
        : new RegExp('(^|/)' + segRe + '$')
    }
    rules.push({ re, dirOnly })
  }
  return function isIgnored(relPath, isDir) {
    const rel = String(relPath || '').replace(/^\/+/, '').replace(/\\/g, '/')
    if (!rel) return false
    for (const r of rules) {
      if (r.re.test(rel)) return true
    }
    return false
  }
}

/** Built-in defaults: never pull/push these into/from a mirror. */
export const DEFAULT_IGNORE = [
  '.git/',
  '.svn/',
  '.hg/',
  'node_modules/',
  'target/',
  'dist/',
  'build/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.idea/',
  '.vscode/',
  '*.o',
  '*.a',
  '*.so',
  '*.dylib',
  '*.exe',
  '*.dll',
  '*.class',
  '*.jar',
  '*.log',
  '*.tmp',
  '.DS_Store',
  'Thumbs.db',
  '.dsh-remote-meta.json',
  '.dsh-remote-sync-state.json',
]

/**
 * Extra directories skipped by `rw_search` (but NOT by mirror sync — a user may
 * legitimately want their cache tree mirrored, and silently excluding it from
 * sync would lose data).
 *
 * These are machine-local package/tool caches: enormous numbers of tiny files
 * that essentially never contain what a human is searching for, and that are
 * the main way a "search my home directory" turns into a multi-hour walk
 * (issue #44 reports `~/.npm/_cacache` specifically). Searching them is
 * available via an explicit `path`, which bypasses these excludes.
 */
export const DEFAULT_SEARCH_IGNORE = [
  ...DEFAULT_IGNORE,
  '.npm/',
  '.cache/',
  '.local/',
  '.cargo/',
  '.rustup/',
  '.gradle/',
  '.m2/',
  '.pnpm-store/',
  '.yarn/',
  '.conda/',
  '.docker/',
  '.nvm/',
  '.pyenv/',
  '.Trash/',
  '.Trash-1000/',
  'snap/',
  'AppData/',
  'Library/Caches/',
]

/**
 * Whether a normalized remote path is a FILESYSTEM ROOT: POSIX `/`, a Windows
 * drive root (`D:\`), or a UNC share root (`\\server\share`).
 *
 * Root workspaces are legal (issue #60) but dangerous to walk naively: `/proc`
 * and `/sys` are synthetic (new pids appear between readdirs, `/proc/kcore`
 * advertises 128 TB), `/dev` holds never-ending character devices, and
 * `/var/lib/docker` is tens of GB of image layers. ROOT_IGNORE exists so a
 * root workspace skips exactly those trees.
 */
export function isFilesystemRoot(p) {
  const s = String(p || '')
  return s === '/' || /^[a-zA-Z]:\\?$/.test(s) || /^\\\\[^\\]+\\[^\\]+$/.test(s)
}

/**
 * Patterns merged in ONLY when the workspace is the filesystem root
 * (issue #60). Every entry is root-anchored AND directory-only, so even when
 * merged they can only match at the workspace top level: `/` skips `/proc`,
 * while a hypothetical `/home/u/proc` under a non-root workspace is ordinary
 * content (and non-root workspaces never receive these patterns at all, so
 * their behaviour is byte-identical to before).
 */
export const ROOT_IGNORE = [
  '/proc/',
  '/sys/',
  '/dev/',
  '/run/',
  '/boot/',
  '/var/lib/docker/',
]

/**
 * Effective ignore patterns for a workspace rooted at `root`:
 * the defaults, plus ROOT_IGNORE only for a root workspace, plus the user's
 * own `.dsh-remote-ignore` lines (always last, they stack on top).
 *
 * @param {string} root - workspace root as passed to sync/push/search.
 * @param {{search?: boolean, fromFile?: string[]}} [opts]
 */
export function ignorePatternsFor(root, { search = false, fromFile = [] } = {}) {
  const base = search ? DEFAULT_SEARCH_IGNORE : DEFAULT_IGNORE
  const extra = isFilesystemRoot(root) ? ROOT_IGNORE : []
  return base.concat(extra, fromFile)
}

/**
 * Load the user ignore file (gitignore syntax) and merge with defaults.
 * Returns `{ patterns, fromFile }`.
 */
export function loadIgnore(ignoreFile) {
  let fromFile = []
  if (ignoreFile) {
    try {
      const text = readFileSync(ignoreFile, 'utf8')
      fromFile = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    } catch { /* missing file → defaults only */ }
  }
  const patterns = DEFAULT_IGNORE.concat(fromFile)
  return { patterns, fromFile, matcher: compileIgnore(patterns) }
}
