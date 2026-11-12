// Issue #117: localTools must filter the PTC SDK, not only native wire schemas.
//
// These tests use the real Cordis context, ToolRuntime and SystemPrompt. The
// assertion reads the generated tools:sdk TypeScript section because PTC's
// assembled.tools contains only run_code and therefore cannot demonstrate the
// bug. A non-rw sentinel catches an accidental global allowlist.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'

const BOOTSTRAP = ['rw_connect', 'rw_machines', 'rw_pick_workspace']
const ALL_RW = [
  'rw_append', 'rw_connect', 'rw_disconnect', 'rw_download', 'rw_edit',
  'rw_exec', 'rw_forward', 'rw_info', 'rw_list_dir', 'rw_machines',
  'rw_mkdir', 'rw_move', 'rw_pick_workspace', 'rw_push', 'rw_read_file',
  'rw_remove', 'rw_search', 'rw_stat', 'rw_sync', 'rw_upload', 'rw_write_file',
]

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 60000,
  telemetry: false, localTools: 'bootstrap',
}

const textOut = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-issue117-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  const machine = { id: 'm-linux', name: 'linuxbox', host: '127.0.0.11', port: 1, username: 'lucas', password: 'pw-linux' }
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: [machine], currentId: machine.id }))
  const mirrorCwd = path.join(root, '127.0.0.11-lucas-1', 'proj')
  mkdirSync(mirrorCwd, { recursive: true })
  writeFileSync(path.join(mirrorCwd, '.dsh-remote-meta.json'), JSON.stringify({
    host: machine.host, port: machine.port, username: machine.username, remotePath: '/home/lucas/proj',
  }))
  const localCwd = path.join(home, 'plain-local-dir')
  mkdirSync(localCwd, { recursive: true })
  return { home, mirrorCwd, localCwd }
}

function makeAgent(root, cwd, id) {
  const agent = { id, session: { id, header: cwd === undefined ? {} : { cwd } } }
  const scope = createScope(root, agent)
  agent.ctx = scope.ctx
  return { agent, scope }
}

/** Read only top-level ToolArgsMap members, not nested argument properties. */
function sdkCapabilityNames(assembly) {
  const text = assembly.sections.find((section) => section.name === 'tools:sdk')?.text || ''
  const match = text.match(/interface ToolArgsMap \{([\s\S]*?)\n\}/)
  if (!match) return []
  return [...match[1].matchAll(/^  ([A-Za-z_$][\w$]*):/gm)].map((entry) => entry[1]).sort()
}

const rwNames = (names) => names.filter((name) => name.startsWith('rw_')).sort()
const sorted = (names) => [...names].sort()

async function loadPlugin(root, config) {
  const mod = await import(`../lib/index.js?issue117=${Math.random()}`)
  const fiber = root.plugin(mod, config)
  await fiber
  return { mod, fiber }
}

async function setup(t, { mode = 'ptc', localTools = 'bootstrap', existingAgents = false } = {}) {
  const { home, mirrorCwd, localCwd } = makeHome()
  process.env.DSH_HOME = home
  const root = new Context()
  root.provide('loader', {})
  root.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body' })
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime, { mode })
  root.tools.register(defineTool({
    name: 'read', description: 'non-rw sentinel', parameters: {}, output: textOut,
    async execute() { return { text: 'sentinel' } },
  }))

  const liveAgents = []
  root.provide('agents', { list: () => liveAgents })
  const local = makeAgent(root, localCwd, 'local')
  const remote = makeAgent(root, mirrorCwd, 'remote')
  const records = [local, remote]
  if (existingAgents) liveAgents.push(local.agent, remote.agent)
  const loaded = await loadPlugin(root, { ...CONFIG, localTools })
  if (!existingAgents) {
    liveAgents.push(local.agent, remote.agent)
    for (const { agent } of records) await root.serial('agent/created', { agent })
  }

  t.after(async () => {
    for (const { scope } of records) await scope.dispose()
    await root.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  return {
    root, local: local.agent, remote: remote.agent, localScope: local.scope, loaded,
    assemble: (agent) => root.systemPrompt.assemble({ agent, scope: agent }),
  }
}

function assertPtcSurface(assembly, expectedRw) {
  assert.deepEqual(assembly.tools.map((tool) => tool.name), ['run_code'])
  const capabilities = sdkCapabilityNames(assembly)
  assert.deepEqual(rwNames(capabilities), sorted(expectedRw))
  assert.ok(capabilities.includes('read'), 'the non-rw sentinel must survive every restriction')
}

for (const [localTools, expected] of [
  ['bootstrap', BOOTSTRAP],
  ['none', []],
  ['all', ALL_RW],
]) {
  test(`PTC SDK honors localTools=${localTools} for created local agents and keeps remote full`, async (t) => {
    const h = await setup(t, { localTools })
    assertPtcSurface(await h.assemble(h.local), expected)
    assertPtcSurface(await h.assemble(h.remote), ALL_RW)
    assert.deepEqual(
      rwNames(h.root.tools.schemas(h.local).map((tool) => tool.name)),
      sorted(expected),
      'run_code bindings use the same visible set as the SDK',
    )
    assert.deepEqual(rwNames(h.root.tools.schemas(h.remote).map((tool) => tool.name)), sorted(ALL_RW))
  })
}

test('PTC restriction is installed for agents that already existed before plugin apply', async (t) => {
  const h = await setup(t, { existingAgents: true })
  assertPtcSurface(await h.assemble(h.local), BOOTSTRAP)
  assertPtcSurface(await h.assemble(h.remote), ALL_RW)
})

test('native real runtime keeps the issue #63 surface and non-rw tools', async (t) => {
  const h = await setup(t, { mode: 'native' })
  assert.deepEqual(
    (await h.assemble(h.local)).tools.map((tool) => tool.name).sort(),
    sorted([...BOOTSTRAP, 'read']),
  )
  assert.deepEqual(
    (await h.assemble(h.remote)).tools.map((tool) => tool.name).sort(),
    sorted([...ALL_RW, 'read']),
  )
})

test('agent disposal and plugin hot reload lift stale restrictions without a DSH restart', async (t) => {
  const h = await setup(t, { existingAgents: true })
  assertPtcSurface(await h.assemble(h.local), BOOTSTRAP)

  h.root.emit('agent/disposed', { agent: h.local })
  await new Promise((resolve) => setImmediate(resolve))
  assertPtcSurface(await h.assemble(h.local), ALL_RW)

  await h.root.serial('agent/created', { agent: h.local })
  assertPtcSurface(await h.assemble(h.local), BOOTSTRAP)

  await h.loaded.fiber.dispose()
  const reloaded = await loadPlugin(h.root, { ...CONFIG, localTools: 'all' })
  h.loaded = reloaded
  assertPtcSurface(await h.assemble(h.local), ALL_RW)
  assertPtcSurface(await h.assemble(h.remote), ALL_RW)
})

test('an agent without cwd keeps the full PTC surface', async (t) => {
  const h = await setup(t, { localTools: 'none' })
  const noCwd = makeAgent(h.root, undefined, 'no-cwd')
  t.after(() => noCwd.scope.dispose())
  await h.root.serial('agent/created', { agent: noCwd.agent })
  assertPtcSurface(await h.assemble(noCwd.agent), ALL_RW)
})

test('legacy DSH without tools.restrict keeps the native fallback and never rejects creation', async (t) => {
  const { home, localCwd } = makeHome()
  process.env.DSH_HOME = home
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const mod = await import(`../lib/index.js?issue117-legacy=${Math.random()}`)
  const listeners = new Map()
  const registered = new Map()
  const agent = { session: { header: { cwd: localCwd } }, ctx: { tools: {} } }
  const ctx = {
    effect: () => {}, inject: () => {},
    get: (name) => name === 'agents' ? { list: () => [agent] } : undefined,
    on: (event, fn) => { listeners.set(event, fn); return () => {} },
    tools: { register: (tool) => registered.set(tool.name, tool) },
    systemPrompt: { section: () => {} },
  }
  await mod.apply(ctx, { ...CONFIG })
  assert.doesNotThrow(() => listeners.get('agent/created')({ agent }))

  const assembly = {
    sections: [], contexts: [], variables: {},
    tools: [...registered.values(), { name: 'read' }].map((tool) => ({
      name: tool.name, description: '', parameters: { type: 'object' },
    })),
  }
  const filtered = await listeners.get('system-prompt/assemble')(assembly, { agent }, async () => assembly)
  assert.deepEqual(filtered.tools.map((tool) => tool.name).sort(), sorted([...BOOTSTRAP, 'read']))
})
