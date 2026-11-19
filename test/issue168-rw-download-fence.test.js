// Issue #168: rw_download is the only rw_* tool that writes the LOCAL
// filesystem, and it used to do so with no fencing at all — an arbitrary
// `localPath` resolved anywhere on this machine, no remote-sandbox check,
// no symlink guard, no audit line. A read-only session (whose local write
// tools are all disabled) could still rewrite any local file through the
// remote. The fix aligns the tool surface with the HTTP download route
// (routes-fs.js op=download): sandbox fence, grammar-aware mirror-only
// destination, symlink guard, audit.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mirrorConstrainLocalTarget } from '../lib/mirror-paths.js'

/** Repository root: the source-invariant test reads lib/main.js itself. */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Build an isolated DSH_HOME with a machine registry and one mirror. */
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-168-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  const machines = [
    { id: 'm-1', name: 'linuxbox', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw' },
  ]
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: machines, currentId: 'm-1' }))
  const cwd = path.join(root, '127.0.0.11-lucas-1', 'proj')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(path.join(cwd, '.dsh-remote-meta.json'), JSON.stringify({ host: '127.0.0.11', port: 1, username: 'lucas', remotePath: '/home/lucas/proj' }))
  return { home, cwd }
}

function makeCtx() {
  const tools = new Map()
  return {
    ctx: {
      effect: () => {},
      inject: () => {},
      get: () => undefined,
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => {} },
    },
    tools,
  }
}

const execFor = (cwd) => ({ agent: { session: { header: { cwd } } } })

const CONFIG = (remoteSandbox) => ({
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
  remoteSandbox,
})

async function loadTools(home, remoteSandbox) {
  process.env.DSH_HOME = home
  // Cache-bust so each test observes a fresh module-level state.
  const { apply } = await import(`../lib/index.js?fence=${Math.random()}`)
  const { ctx, tools } = makeCtx()
  await apply(ctx, CONFIG(remoteSandbox))
  return tools
}

const runDownload = (tool, args, cwd) =>
  tool.execute(args, execFor(cwd)).then(() => null, (e) => e)

// ── pure predicate ──────────────────────────────────────────────────────────

test('mirrorConstrainLocalTarget keeps an explicit localPath inside the mirror', () => {
  assert.equal(mirrorConstrainLocalTarget('/mirror', '/mirror/sub/f.txt'), path.resolve('/mirror/sub/f.txt'))
  for (const target of ['/mirror/../evil', '/etc/pwned', '/mirror/.dsh-remote-meta.json']) {
    assert.throws(() => mirrorConstrainLocalTarget('/mirror', target), (e) => e.httpStatus === 403, target)
  }
})

test('mirrorConstrainLocalTarget refuses Windows-unusable names like the HTTP route', () => {
  for (const target of ['C:\\mirror\\NUL.txt', 'C:\\mirror\\a?b', 'C:\\mirror\\file.']) {
    assert.throws(() => mirrorConstrainLocalTarget('C:\\mirror', target, path.win32), (e) => e.httpStatus === 403, target)
  }
})

// ── tool-surface fences (the refusal happens before any SSH dial) ───────────

test('read-only session: rw_download is refused with the official denial shape', async () => {
  const { home, cwd } = makeHome()
  try {
    const tools = await loadTools(home, 'read-only')
    const err = await runDownload(tools.get('rw_download'), { path: '/home/lucas/proj/a.txt' }, cwd)
    assert.ok(err, 'must refuse')
    assert.match(String(err.message), /rw_download: \[sandbox: read-only\]/)
    assert.match(String(err.message), /read-only sessions may not modify a remote host/)
    assert.doesNotMatch(String(err.message), /invalid arguments/)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('workspace-write session: a source outside the workspace is refused', async () => {
  const { home, cwd } = makeHome()
  try {
    const tools = await loadTools(home, 'workspace-write')
    const err = await runDownload(tools.get('rw_download'), { path: '/etc/passwd' }, cwd)
    assert.ok(err, 'must refuse')
    assert.match(String(err.message), /workspace-write only permits changes inside \/home\/lucas\/proj/)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('explicit localPath outside the mirror is refused even at full access', async () => {
  const { home, cwd } = makeHome()
  try {
    // remoteSandbox left unset → the resolved mode is danger-full-access,
    // which is exactly the old unconfined default: the mirror-only
    // destination must hold even when the sandbox has nothing to say.
    const tools = await loadTools(home, undefined)
    const err = await runDownload(tools.get('rw_download'), { path: '/home/lucas/proj/a.txt', localPath: '/etc/pwned' }, cwd)
    assert.ok(err, 'must refuse')
    assert.match(String(err.message), /must be a regular file inside this workspace mirror/)
    // Refused before the SSH stage: the unreachable machine is never dialed.
    assert.doesNotMatch(String(err.message), /127\.0\.0\.11/)
  } finally {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

// ── source invariants: the fence/mapping/guard/audit stay wired ─────────────

test('rw_download wires fence, mirror mapping, symlink guard and audit like the HTTP route', () => {
  const src = readFileSync(path.join(root, 'lib', 'main.js'), 'utf8')
  const block = src.slice(src.indexOf("name: 'rw_download'"), src.indexOf("name: 'rw_upload'"))
  assert.ok(block.includes("requireRemoteSandbox(exec, 'write', { tool: 'rw_download'"), 'sandbox fence')
  assert.ok(block.includes('mirrorConstrainLocalTarget('), 'explicit localPath is constrained to the mirror')
  assert.ok(block.includes('mirrorDownloadTarget('), 'default destination uses the grammar-aware mapping')
  assert.ok(block.includes('assertDownloadHasNoSymlinks('), 'symlink guard')
  assert.ok(block.includes("audit('download'"), 'audit line')
})
