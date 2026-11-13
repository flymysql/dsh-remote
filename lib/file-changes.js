// Bounded, presentation-only facts about successful remote mutations.
import { structuredPatch } from './vendor/jsdiff/patch/create.js'

export const CHANGE_CAPTURE_BYTES = 64 * 1024
const MAX_LINES = 4000
const MAX_DIFF_CHARS = 24000

export function fileChange(path, operation, before, after) {
  const base = { kind: 'dsh-remote.change', version: 1, path, operation, applied: true, diffs: [], additions: 0, deletions: 0, truncated: false, unchanged: false }
  if (before === undefined) return { ...base, truncated: true, reason: 'baseline-unavailable' }
  const oldText = before === null ? '' : before
  if (Buffer.byteLength(oldText) + Buffer.byteLength(after) > CHANGE_CAPTURE_BYTES * 2 || oldText.split('\n').length + after.split('\n').length > MAX_LINES) return { ...base, truncated: true, reason: 'too-large' }
  if (oldText.includes('\0') || after.includes('\0')) return { ...base, truncated: true, reason: 'binary' }
  if (oldText === after) return { ...base, unchanged: true }
  const patch = structuredPatch('', '', oldText, after, undefined, undefined, { context: 3, timeout: 60, maxEditLength: 3000 })
  if (!patch) return { ...base, truncated: true, reason: 'too-large' }
  let length = 0
  for (const hunk of patch.hunks) {
    const oldLines = [], newLines = []
    for (const line of hunk.lines) {
      if (line[0] === '\\') continue
      if (line[0] === '-') { oldLines.push(line.slice(1)); base.deletions++ }
      else if (line[0] === '+') { newLines.push(line.slice(1)); base.additions++ }
      else { oldLines.push(line.slice(1)); newLines.push(line.slice(1)) }
    }
    const oldPart = oldLines.length ? oldLines.join('\n') : null
    const newPart = newLines.join('\n')
    if (length + (oldPart?.length || 0) + newPart.length > MAX_DIFF_CHARS || base.diffs.length >= 30) {
      base.truncated = true; base.reason = 'too-large'; break
    }
    base.diffs.push({ path, oldText: oldPart, newText: newPart })
    length += (oldPart?.length || 0) + newPart.length
  }
  return base
}

export function presentFileChange(_args, result) {
  const meta = result?.meta
  if (result?.isError || meta?.kind !== 'dsh-remote.change' || meta.applied !== true || !Array.isArray(meta.diffs) || !meta.diffs.length) return undefined
  if (!meta.diffs.every(d => d && typeof d.path === 'string' && (d.oldText === null || typeof d.oldText === 'string') && typeof d.newText === 'string')) return undefined
  return { card: 'diff', title: meta.path, diffs: meta.diffs }
}

export const changeOutput = {
  schema: { type: 'object', additionalProperties: false, properties: {
    ok: { type: 'boolean', required: true }, bytes: { type: 'integer' }, text: { type: 'string' },
    change: { type: 'object', required: true, additionalProperties: false, properties: {
      kind: { type: 'string', required: true }, version: { type: 'integer', required: true }, path: { type: 'string', required: true }, operation: { type: 'string', required: true }, applied: { type: 'boolean', required: true },
      additions: { type: 'integer', required: true }, deletions: { type: 'integer', required: true }, truncated: { type: 'boolean', required: true }, unchanged: { type: 'boolean', required: true }, reason: { type: 'string' },
      diffs: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, oldText: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true }, newText: { type: 'string', required: true },
      } } },
    } },
  } },
  render: (_args, value) => [{ type: 'text', text: value.text || (value.ok ? 'ok' : 'failed') }],
  presentationMeta: (_args, value) => value.change,
}
