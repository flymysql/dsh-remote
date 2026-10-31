// dsh-remote — dynamic remote instruction injection (issue #71).
//
// Issue #68 gave a remote workspace a STATIC instruction index: the workspace
// is shallow-scanned at pick/sync time, the files are mirrored locally, and the
// prompt lists them. What remained missing is the DYNAMIC half the core does
// for local sessions — three gaps, all plugin-side fixable:
//
//   1. The mirrored copies never refreshed, so a mid-session edit to a remote
//      AGENTS.md was invisible until a manual rw_sync.
//   2. The core's incremental injection only recognizes read/write/edit with a
//      `file_path` argument. `rw_read_file` is named differently AND takes
//      `path`, so a remote file touch never registered.
//   3. The core expands scopes from cwd to the TOUCHED path — both local. A
//      remote absolute path (`/root/proj/x.md`) can never map onto a local
//      mirror cwd, so even a "touch" would expand nothing.
//
// This module closes all three without a single line of core change:
//   • `noteTouchedPath` turns an rw_* file touch into the FULL ancestor chain
//     below the workspace root (the same shape core's descendantDirsBetween
//     produces — every level, not just the deepest);
//   • `refreshTouched` stats each level's AGENTS.md/CLAUDE.md, pulls the ones
//     that changed, and returns the chain's current contents;
//   • `buildInstructionMessage` renders that into ONE user message whose source
//     is our OWN kind, so the core's `agent-instructions` state machine never
//     confuses it for its own (that is what keeps the two paths from fighting).
//
// Everything here is best-effort and synchronous-safe: an offline machine must
// never hang a tool call or a prompt assembly, so every remote step is guarded
// and every caller is expected to treat a rejection as "no injection".

import { statSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { joinRemotePath, relPathUnder } from './paths.js'
import { INSTRUCTION_MAX_BYTES } from './instructions.js'

/** The message source kind this plugin owns. Deliberately NOT the core's
 *  `agent-instructions`: consumers fall through unknown kinds, and the core's
 *  reconcile only claims messages carrying its own kind. */
export const REMOTE_INSTRUCTIONS_KIND = 'dsh-remote-instructions'

/** Total byte budget for one injected batch (the core's own budget is similar). */
export const INSTRUCTION_MESSAGE_MAX_BYTES = 16 * 1024

/** Per-session throttle for the stat-and-refresh sweep, in milliseconds. */
export const REFRESH_THROTTLE_MS = 30 * 1000

const keyOf = (size, mtime) => `${size}:${Math.floor(mtime || 0)}`

/**
 * Split a remote path into the ancestor directories strictly BELOW `root`,
 * root-excluded — the core's `ancestorChain(cwd, dir).slice(1)` shape.
 *
 * Reading `<root>/a/b/c.ts` yields `['a', 'a/b']`, so `a/AGENTS.md` and
 * `a/b/AGENTS.md` are both in scope while `<root>/AGENTS.md` (the baseline
 * layer) is not re-scanned. A path at or above the root yields `[]`.
 *
 * @param {string} root - the workspace root (remote absolute path).
 * @param {string} touched - the touched remote path.
 * @returns {string[]} workspace-relative directory prefixes, shallow → deep.
 */
export function descendantDirs(root, touched) {
  const rootRel = relPathUnder(String(root || ''), String(touched || ''))
  if (!rootRel) return []
  const parts = rootRel.split('/').filter(Boolean)
  // The last part is the file itself; the chain stops at its directory.
  parts.pop()
  const out = []
  let cur = ''
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part
    out.push(cur)
  }
  return out
}

/**
 * Which instruction files a touch puts in scope, as workspace-relative paths:
 * each directory in the chain contributes `AGENTS.md` and `CLAUDE.md`.
 *
 * @param {string} root - workspace root.
 * @param {string} touched - touched path.
 * @param {number} depth - how many trailing chain levels to include (0 = none,
 *   which is what "touched a file directly in the root" means).
 * @returns {string[]} candidate relative paths.
 */
export function instructionCandidates(root, touched, depth = Infinity) {
  const dirs = descendantDirs(root, touched)
  // `depth: 0` means "no chain level" (the touched file sits directly in the
  // root): `slice(-0)` would return the WHOLE array, so this needs its own branch.
  const chain = depth === 0 ? [] : (Number.isFinite(depth) ? dirs.slice(-depth) : dirs)
  const out = []
  for (const dir of chain) {
    out.push(`${dir}/AGENTS.md`, `${dir}/CLAUDE.md`)
  }
  return out
}

/**
 * A digest of an instruction's content, used to inject a given version once.
 * Size + mtime is not enough: a same-size edit inside one second would slip
 * through, and a spurious re-injection costs prompt budget.
 *
 * @param {Buffer|string} content
 * @returns {string}
 */
export function contentDigest(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8')
  // A 16-char prefix is plenty for "did this text change" within one session,
  // and keeps the tracker's maps small.
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

/**
 * Per-session injection state: which (remote path → digest) pairs have already
 * been delivered, plus the last sweep time for throttling.
 *
 * @returns {object} a tracker with `shouldInject`, `markInjected`, `removed`, and `throttled`.
 */
export function createInjectionTracker({ throttleMs = REFRESH_THROTTLE_MS } = {}) {
  /** sessionId → { injected: Map<relPath, digest>, lastSweep: number } */
  const sessions = new Map()
  const stateFor = (sessionId) => {
    const key = String(sessionId || 'unscoped')
    let s = sessions.get(key)
    if (!s) { s = { injected: new Map(), lastSweep: 0 }; sessions.set(key, s) }
    return s
  }
  return {
    /** Whether a sweep may run now (the throttle gate). */
    throttled(sessionId, now = Date.now()) {
      const s = stateFor(sessionId)
      return now - s.lastSweep < throttleMs
    },
    /** Record that a sweep happened now. */
    swept(sessionId, now = Date.now()) {
      stateFor(sessionId).lastSweep = now
    },
    /** Whether this exact content has NOT been delivered to this session yet. */
    shouldInject(sessionId, rel, digest) {
      return stateFor(sessionId).injected.get(rel) !== digest
    },
    /** Mark one file's content as delivered. */
    markInjected(sessionId, rel, digest) {
      stateFor(sessionId).injected.set(rel, digest)
    },
    /** Every rel path this session has been given, for scoped reconciliation. */
    injectedRels(sessionId) {
      return stateFor(sessionId).injected.keys()
    },
    /**
     * Files injected before that are gone from a sweep LIMITED to `covers`.
     *
     * Scoping matters in both directions: a file outside the swept chain was
     * never examined, so it must keep its record (dropping it would re-inject
     * live rules later and, worse, could report a live rule as removed).
     *
     * @param {string} sessionId
     * @param {Set<string>} present - rel paths the sweep actually found.
     * @param {(rel: string) => boolean} covers - whether the sweep covered a rel.
     * @returns {string[]} rel paths to report as removed.
     */
    removedInScope(sessionId, present, covers) {
      const s = stateFor(sessionId)
      const out = []
      for (const rel of [...s.injected.keys()]) {
        if (typeof covers === 'function' && !covers(rel)) continue
        if (present.has(rel)) continue
        out.push(rel)
        s.injected.delete(rel)
      }
      return out
    },
    /**
     * Files that were injected before but no longer exist remotely — the model
     * must be told, or it keeps following rules that were deleted.
     * @returns {string[]} rel paths to report as removed.
     */
    removed(sessionId, stillPresent) {
      return this.removedInScope(sessionId, stillPresent, null)
    },
    /** Forget a session entirely (its cwd changed, or it went away). */
    reset(sessionId) {
      sessions.delete(String(sessionId || 'unscoped'))
    },
    /** Every session currently tracked (diagnostics/tests). */
    sessions() {
      return [...sessions.keys()]
    },
  }
}

/**
 * Fetch the CURRENT content of one instruction candidate from the remote and
 * mirror it locally, three-way safe (a local edit is never clobbered).
 *
 * Returns null when the file does not exist remotely — that is a normal answer,
 * not an error, since most directories carry no instruction file.
 *
 * @param {object} sftp - promisified sftp surface.
 * @param {string} remoteRoot - workspace root.
 * @param {string} rel - workspace-relative candidate path.
 * @param {string} mirrorDir - local mirror root.
 * @returns {Promise<{rel: string, remote: string, content: string, digest: string, mirrored: boolean}|null>}
 */
export async function fetchInstruction(sftp, remoteRoot, rel, mirrorDir) {
  const remote = joinRemotePath(remoteRoot, rel)
  let st
  try { st = await sftp.stat(remote) } catch { return null }
  if (!st || (typeof st.isDirectory === 'function' && st.isDirectory())) return null
  const size = typeof st.size === 'number' ? st.size : 0
  if (size > INSTRUCTION_MAX_BYTES) {
    // Too large to inject whole: report the file, not its text.
    return { rel, remote, content: '', digest: `oversize:${size}`, mirrored: false, oversizeBytes: size }
  }
  let buf
  try { buf = await sftp.readFile(remote) } catch { return null }
  const digest = contentDigest(buf)
  let mirrored = false
  if (mirrorDir) {
    try {
      const lp = path.join(mirrorDir, ...String(rel).split('/'))
      let same = false
      try {
        const lst = statSync(lp)
        same = lst.size === size && keyOf(lst.size, lst.mtimeMs / 1000) === keyOf(size, st.mtime)
      } catch { same = false }
      if (!same) {
        mkdirSync(path.dirname(lp), { recursive: true })
        writeFileSync(lp, buf)
        try { utimesSync(lp, new Date((st.mtime || 0) * 1000), new Date((st.mtime || 0) * 1000)) } catch { /* cosmetic */ }
      }
      mirrored = true
    } catch { /* a mirror failure must not lose the instruction itself */ }
  }
  return { rel, remote, content: buf.toString('utf8'), digest, mirrored }
}

/**
 * Sweep the ancestor chain of a touched path and return the instructions that
 * should enter the context now.
 *
 * @param {object} arg
 * @param {object} arg.sftp
 * @param {string} arg.remoteRoot - workspace root.
 * @param {string} arg.touched - the touched remote path.
 * @param {string} arg.mirrorDir - local mirror.
 * @param {object} arg.tracker - from {@link createInjectionTracker}.
 * @param {string} arg.sessionId
 * @param {number} [arg.depth] - chain depth to consider (default: whole chain).
 * @returns {Promise<{items: Array, removed: string[]}>} new/changed files and removals.
 */
export async function refreshTouched({ sftp, remoteRoot, touched, mirrorDir, tracker, sessionId, depth }) {
  const candidates = instructionCandidates(remoteRoot, touched, depth)
  if (!candidates.length) return { items: [], removed: [] }
  const found = []
  const present = new Set()
  for (const rel of candidates) {
    const got = await fetchInstruction(sftp, remoteRoot, rel, mirrorDir)
    if (!got) continue
    found.push(got)
    present.add(got.rel)
  }
  const items = found.filter((f) => tracker.shouldInject(sessionId, f.rel, f.digest))
  for (const f of items) tracker.markInjected(sessionId, f.rel, f.digest)
  // Removal notices must be scoped to the directories THIS touch covers — both
  // directions matter:
  //   • a file that no longer exists anywhere in the covered chain is gone;
  //   • a file outside the covered chain was simply never looked at, so its
  //     absence from `present` says nothing (and must not delete its record,
  //     or the model would be told a live rule vanished).
  const dirs = descendantDirs(remoteRoot, touched)
  if (!dirs.length) return { items, removed: [] }
  const prefixes = dirs.map((d) => d + '/')
  const covers = (rel) => prefixes.includes(rel.slice(0, rel.lastIndexOf('/') + 1))
  // Only files INSIDE the covered chain can be judged by this sweep: a record
  // for some other subtree was simply not examined, so its absence from
  // `present` means nothing there.
  const removed = tracker.removedInScope(sessionId, present, covers)
  return { items, removed }
}

/**
 * Render the injection batch into ONE user message.
 *
 * The shape mirrors what the core produces for its own incremental batches —
 * a system-reminder-framed body with per-file sections — so the model reads the
 * two identically while the SOURCE kind keeps them distinguishable.
 *
 * @param {Array} items - from {@link refreshTouched}.
 * @param {string[]} removed - rel paths that no longer exist.
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @param {(p: string) => string} [opts.display] - path formatter for sections.
 * @param {(text: string, source: object) => object} [opts.createUserMessage] -
 *   the core message factory when available.
 * @returns {object|null} a user message, or null when there is nothing to say.
 */
export function buildInstructionMessage(items, removed, opts = {}) {
  const maxBytes = Number(opts.maxBytes) || INSTRUCTION_MESSAGE_MAX_BYTES
  const display = typeof opts.display === 'function' ? opts.display : (p) => p
  const factory = typeof opts.createUserMessage === 'function' ? opts.createUserMessage : null
  if ((!items || !items.length) && (!removed || !removed.length)) return null
  const blocks = []
  let used = 0
  const sent = []
  const truncated = []
  for (const item of items || []) {
    const head = item.oversizeBytes
      ? `### ${display(item.remote)}\n(too large to inject: ${item.oversizeBytes} bytes — read it with rw_read_file if you need its rules)`
      : `### ${display(item.remote)}\n${item.content}`
    const bytes = Buffer.byteLength(head, 'utf8')
    if (used + bytes > maxBytes) { truncated.push(display(item.remote)); continue }
    used += bytes
    blocks.push(head)
    sent.push(item.rel)
  }
  if (removed && removed.length) {
    const line = `Removed on the remote host (no longer in effect): ${removed.map((r) => display(r)).join(', ')}`
    if (used + Buffer.byteLength(line, 'utf8') <= maxBytes) blocks.push(line)
  }
  if (truncated.length) {
    blocks.push(`Workspace instruction budget ${maxBytes} bytes: truncated ${truncated.join(', ')}`)
  }
  if (!blocks.length) return null
  const text = [
    '<system-reminder>',
    'Remote workspace instructions for the directories you just touched. These are the CURRENT contents from the remote host, delivered because you accessed files under them.',
    '',
    blocks.join('\n\n'),
    '</system-reminder>',
  ].join('\n')
  const source = { kind: REMOTE_INSTRUCTIONS_KIND, form: 'instructions', changes: sent.map((rel) => ({ path: rel, change: 'changed' })) }
  const content = [{ type: 'text', text }]
  // The fallback object MUST carry an id. The core validates every stored message
  // on session restore (`assertMessageEventShape`: `message.id` must be a non-empty
  // string) and REJECTS THE WHOLE LOG on the first offender — one of these objects
  // without an id made a 130+-turn session fail to reopen ("历史加载失败").
  // `randomUUID` matches the factory's own identity source
  // (@deepseek-ai/dsh-llm createMessage → brandString(randomUUID())).
  return factory ? factory({ content, source }) : { id: randomUUID(), role: 'user', content, source }
}
