// Issue #63: a LOCAL session must not carry the full rw_* schema surface.
//
// All 21 rw_* tools register globally (at registration time there is no
// session to consult), yet 16 of them can never succeed in a local session —
// bindingFor() refuses them with "this session is LOCAL". The plugin now
// trims the per-request tool list in the `system-prompt/assemble` waterfall:
// a session whose cwd maps to a mirror keeps everything; anything else gets
// the configuration loop (rw_machines / rw_connect / rw_pick_workspace), or
// none / all per config.localTools.
//
// The harness host passes `{ agent, scope: agent }` as the assemble context
// (dsh-agent's assembleContextFor), so these tests invoke the captured
// listener the same way. The SSH layer is never touched: the filter only
// reads the mirror registry on disk.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Build an isolated DSH_HOME with a machine registry and one mirror. */
function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-issue63-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })

  const machines = [
    { id: 'm-linux', name: 'linuxbox', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw-linux' },
  ]
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: machines, currentId: 'm-linux' }))

  const mirror = (host, user, port, base, remotePath) => {
    const dir = path.join(root, `${host}-${user}-${port}`, base)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, '.dsh-remote-meta.json'), JSON.stringify({ host, port, username: user, remotePath }))
    return dir
  }
  return { home, mirrorCwd: mirror('127.0.0.11', 'lucas', 1, 'proj', '/home/lucas/proj') }
}

/** Minimal ctx: apply() needs effect/inject/get/tools/systemPrompt; `on`
 *  captures the assemble listener under test. */
function makeCtx() {
  const tools = new Map()
  const listeners = new Map()
  return {
    ctx: {
      effect: () => {},
      inject: () => {},
      get: () => undefined,
      on: (event, fn) => { listeners.set(event, fn); return () => {} },
      tools: { register: (t) => tools.set(t.name, t) },
      systemPrompt: { section: () => {} },
    },
    tools,
    listeners,
  }
}

/** Load apply() with DSH_HOME pointed at an isolated home. */
async function loadPlugin(home) {
  process.env.DSH_HOME = home
  // Cache-bust so each test observes a fresh module-level state.
  return import(`../lib/index.js?issue63=${Math.random()}`)
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
  localTools: 'bootstrap',
}

/** A minimal PromptAssembly stand-in: the filter only reads `tools[].name`. */
const assemblyFor = (names) => ({
  sections: [],
  contexts: [],
  variables: {},
  tools: names.map((name) => ({ name, description: `desc of ${name}`, parameters: { type: 'object' } })),
})

// Two bootstrap tools, four operation tools, and two non-rw harness tools —
// the non-rw ones must survive every mode untouched.
const NAMES = [
  'rw_machines', 'rw_connect', 'rw_pick_workspace',
  'rw_exec', 'rw_read_file', 'rw_info', 'rw_disconnect',
  'pwsh', 'read_file',
]

/** Invoke the captured listener the way the host's waterfall would. */
async function runFilter(listener, assembly, agentCtx) {
  let nextCalls = 0
  const next = async () => { nextCalls += 1; return assembly }
  const result = await listener(assembly, agentCtx, next)
  return { result, nextCalls }
}

const ctxForCwd = (cwd) => (cwd === undefined
  ? { agent: { session: { header: {} } } }
  : { agent: { session: { header: { cwd } } } })

const toolNames = (assembly) => assembly.tools.map((t) => t.name)

test('assemble listener is registered and trims a LOCAL session to the bootstrap loop', async (t) => {
  const { home } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const mod = await loadPlugin(home)
  const { ctx, listeners } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })

  const listener = listeners.get('system-prompt/assemble')
  assert.equal(typeof listener, 'function', 'apply() must register a system-prompt/assemble waterfall listener')

  const localCwd = path.join(home, 'plain-local-dir')
  mkdirSync(localCwd, { recursive: true })
  const assembly = assemblyFor(NAMES)
  const { result, nextCalls } = await runFilter(listener, assembly, ctxForCwd(localCwd))

  assert.equal(nextCalls, 1, 'the waterfall contract: next() is called exactly once')
  assert.deepEqual(toolNames(result), ['rw_machines', 'rw_connect', 'rw_pick_workspace', 'pwsh', 'read_file'])
  // The operation tools are gone; the surviving tools keep their schemas intact.
  const kept = result.tools.find((x) => x.name === 'rw_connect')
  assert.equal(kept.description, 'desc of rw_connect', 'filtering must not rewrite surviving schemas')
  assert.notEqual(result, assembly, 'a filtered assembly is a new object (no mutation of the input)')
  assert.equal(toolNames(assembly).length, NAMES.length, 'input assembly left unmutated')
})

test('a mirror-bound session keeps the full surface', async (t) => {
  const { home, mirrorCwd } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const mod = await loadPlugin(home)
  const { ctx, listeners } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  const listener = listeners.get('system-prompt/assemble')
  assert.equal(typeof listener, 'function')

  const assembly = assemblyFor(NAMES)
  const { result, nextCalls } = await runFilter(listener, assembly, ctxForCwd(mirrorCwd))
  assert.equal(nextCalls, 1)
  assert.deepEqual(toolNames(result), NAMES)
  assert.equal(result, assembly, 'untouched assemblies pass through by reference')
})

test('an assembly without agent/cwd is left alone', async (t) => {
  const { home } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const mod = await loadPlugin(home)
  const { ctx, listeners } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  const listener = listeners.get('system-prompt/assemble')

  for (const agentCtx of [undefined, {}, { agent: {} }, ctxForCwd(undefined)]) {
    const assembly = assemblyFor(NAMES)
    const { result } = await runFilter(listener, assembly, agentCtx)
    assert.deepEqual(toolNames(result), NAMES, `agentCtx=${JSON.stringify(agentCtx)} must pass through`)
  }
})

test("localTools 'none' hides every rw_* tool in a local session", async (t) => {
  const { home } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const mod = await loadPlugin(home)
  const { ctx, listeners } = makeCtx()
  await mod.apply(ctx, { ...CONFIG, localTools: 'none' })
  const listener = listeners.get('system-prompt/assemble')

  const localCwd = path.join(home, 'plain-local-dir')
  mkdirSync(localCwd, { recursive: true })
  const { result } = await runFilter(listener, assemblyFor(NAMES), ctxForCwd(localCwd))
  assert.deepEqual(toolNames(result), ['pwsh', 'read_file'])
})

test("localTools 'all' keeps the legacy full surface even in a local session", async (t) => {
  const { home } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const mod = await loadPlugin(home)
  const { ctx, listeners } = makeCtx()
  await mod.apply(ctx, { ...CONFIG, localTools: 'all' })
  const listener = listeners.get('system-prompt/assemble')

  const localCwd = path.join(home, 'plain-local-dir')
  mkdirSync(localCwd, { recursive: true })
  const { result, nextCalls } = await runFilter(listener, assemblyFor(NAMES), ctxForCwd(localCwd))
  assert.equal(nextCalls, 1, "'all' still honours the waterfall (downstream listeners run)")
  assert.deepEqual(toolNames(result), NAMES)
})

test("an invalid localTools value degrades to 'bootstrap'", async (t) => {
  const { home } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const mod = await loadPlugin(home)
  const { ctx, listeners } = makeCtx()
  await mod.apply(ctx, { ...CONFIG, localTools: 'everthing' })
  const listener = listeners.get('system-prompt/assemble')

  const localCwd = path.join(home, 'plain-local-dir')
  mkdirSync(localCwd, { recursive: true })
  const { result } = await runFilter(listener, assemblyFor(NAMES), ctxForCwd(localCwd))
  assert.deepEqual(toolNames(result), ['rw_machines', 'rw_connect', 'rw_pick_workspace', 'pwsh', 'read_file'])
})

test('a mirror with a broken meta counts as LOCAL (resolveMirror reports no binding)', async (t) => {
  const { home } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  // A mirror-shaped directory whose meta is unparsable: bindingFor refuses
  // it as local, so the filter must treat it as local too.
  const broken = path.join(home, 'remote-workspaces', '127.0.0.11-lucas-1', 'broken')
  mkdirSync(broken, { recursive: true })
  writeFileSync(path.join(broken, '.dsh-remote-meta.json'), '{not json')

  const mod = await loadPlugin(home)
  const { ctx, listeners } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  const listener = listeners.get('system-prompt/assemble')

  const { result } = await runFilter(listener, assemblyFor(NAMES), ctxForCwd(broken))
  assert.deepEqual(toolNames(result), ['rw_machines', 'rw_connect', 'rw_pick_workspace', 'pwsh', 'read_file'])
})

test('LOCAL_BOOTSTRAP_TOOLS only names tools the plugin really registers', async (t) => {
  const { home } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const mod = await loadPlugin(home)
  const { ctx, tools } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })

  assert.deepEqual(mod.LOCAL_BOOTSTRAP_TOOLS, ['rw_machines', 'rw_connect', 'rw_pick_workspace'])
  for (const name of mod.LOCAL_BOOTSTRAP_TOOLS) {
    assert.ok(tools.has(name), `bootstrap tool ${name} is not among the ${tools.size} registered tools`)
  }
  // The bootstrap set must be usable in a local session: rw_pick_workspace is
  // the one tool deliberately allowed to fall back to the active machine.
  assert.equal(tools.size, 21, 'the plugin still registers all 21 rw_* tools globally')
})

test('normalizeLocalTools maps anything unrecognized to bootstrap', async () => {
  const mod = await import('../lib/index.js?issue63-pure=' + Math.random())
  assert.equal(mod.normalizeLocalTools('bootstrap'), 'bootstrap')
  assert.equal(mod.normalizeLocalTools('none'), 'none')
  assert.equal(mod.normalizeLocalTools('all'), 'all')
  assert.equal(mod.normalizeLocalTools(' NONE '), 'none')
  assert.equal(mod.normalizeLocalTools('All'), 'all')
  assert.equal(mod.normalizeLocalTools(''), 'bootstrap')
  assert.equal(mod.normalizeLocalTools(undefined), 'bootstrap')
  assert.equal(mod.normalizeLocalTools('garbage'), 'bootstrap')
})

test('pickWorkspaceNextStep: a local session is told to OPEN the mirror first', async () => {
  const mod = await import('../lib/index.js?issue63-pure2=' + Math.random())
  const local = mod.pickWorkspaceNextStep(true)
  assert.match(local, /this session is LOCAL/)
  assert.match(local, /Open a session whose workspace IS the local mirror path/)
  assert.doesNotMatch(local, /^Run rw_sync/, 'a local session must not be told to just run rw_sync — it always fails')

  const bound = mod.pickWorkspaceNextStep(false)
  assert.equal(bound, 'Run rw_sync to download its files into the local mirror.')
})

test('rw_pick_workspace wires its closing hint through pickWorkspaceNextStep', async () => {
  // Source-level pin (same style as docs-i18n.test.js): the success text must
  // branch on the session's locality instead of always printing "Run rw_sync".
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')
  assert.ok(
    src.includes('${pickWorkspaceNextStep(b.local)}'),
    'rw_pick_workspace success text must call pickWorkspaceNextStep(b.local)',
  )
})
