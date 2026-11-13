// A REAL DSH agent loop and tool runtime, using deterministic model decisions.
// SFTP and shell share disk: compiler diagnostics are never canned responses.
// Run with IT_DSH_MODULES=/path/to/dsh/node_modules and gcc on PATH.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startDiskWorkspace } from './harness/disk-workspace.js'
import { DEFAULT_CONFIG } from './harness/plugin-host.js'
import { broken, fixed, createBuildAdapter, reply } from './harness/agent-build-model.js'

const modules = process.env.IT_DSH_MODULES
const skip = modules ? false : 'set IT_DSH_MODULES to a full DSH 0.2.x node_modules directory (scripted model; real agent/SSH/compiler)'


async function setup(t, AdapterFactory) {
  const previousHome = process.env.DSH_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-build-'))
  process.env.DSH_HOME = home
  const project = path.join(home, 'actual-remote')
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.writeFileSync(path.join(project, 'src/main.c'), broken)
  const server = await startDiskWorkspace(project)
  const rootDir = path.join(home, 'remote-workspaces')
  const mirror = path.join(rootDir, `127.0.0.1-root-${server.port}`, 'actual-remote')
  fs.mkdirSync(path.join(mirror, 'src'), { recursive: true })
  const localSentinel = '#error LOCAL_MIRROR_MUST_NOT_COMPILE\n'
  fs.writeFileSync(path.join(mirror, 'src/main.c'), localSentinel)
  fs.writeFileSync(path.join(mirror, '.dsh-remote-meta.json'), JSON.stringify({ host: '127.0.0.1', port: server.port, username: 'root', remotePath: project }))
  const machine = { id: 'build-fixture', host: '127.0.0.1', port: server.port, username: 'root', password: 'test-only', backend: 'native', hostKeyMode: 'off' }
  fs.writeFileSync(path.join(rootDir, 'machines.json'), JSON.stringify({ list: [machine], currentId: machine.id }))
  const require = createRequire(path.join(path.resolve(modules), '__agent_test__.cjs'))
  const load = (name) => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
  let nativeExecutor
  try { nativeExecutor = await load('dsh-tool-executor-native') } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
  const { Context } = await load('cordis')
  const root = new Context()
  root.provide('loader', {})
  t.after(async () => {
    await root.fiber.dispose()
    await server.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  })
  for (const name of ['dsh-system-prompt', 'dsh-tools', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop']) {
    const mod = await load(name)
    await root.plugin(mod.default, name === 'dsh-tools' && !nativeExecutor ? { mode: 'native' } : name === 'dsh-agent-loop' ? { agents: [] } : undefined)
  }
  if (nativeExecutor) await root.plugin(nativeExecutor)
  const remote = await import('../lib/index.js?agentBuild=' + Math.random())
  await root.plugin(remote, { ...DEFAULT_CONFIG, telemetry: false, commandTimeoutMs: 10000, connectTimeoutMs: 5000, updateCheckIntervalMs: 60000 })
  const llm = await load('dsh-llm')
  const adapter = AdapterFactory(llm, { project, mirror })
  root.llm.registerAdapter(['scripted-build-test'], adapter)
  const handle = await root.agents.create({ sessionId: 'remote-build-agent', meta: { cwd: mirror }, agentOptions: { provider: 'scripted-build-test', model: 'deterministic' } })
  const send = (text) => handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  return { root, agent: handle.agent, adapter, project, mirror, server, send, localSentinel }
}

test('agent consumes real compiler errors, edits the remote file, rebuilds and reports actual run output', { skip }, async (t) => {
  const h = await setup(t, createBuildAdapter)
  h.send('请检查远程项目的编译问题，修复后重新编译并运行，报告实际输出。')
  await h.agent.whenIdle()
  assert.equal(h.adapter.step, 6, JSON.stringify(h.agent.session.snapshotEvents().slice(-4)))
  assert.equal(fs.readFileSync(path.join(h.project, 'src/main.c'), 'utf8'), fixed)
  assert.ok(fs.existsSync(path.join(h.project, 'dist/app')), 'compiler must produce a real remote binary')
  assert.equal(fs.readFileSync(path.join(h.mirror, 'src/main.c'), 'utf8'), h.localSentinel)
  assert.equal(fs.existsSync(path.join(h.mirror, 'dist/app')), false)
  const events = h.agent.session.snapshotEvents()
  const final = events.filter((e) => e.type === 'assistant/message').at(-1)
  assert.match(JSON.stringify(final), /远端 GCC 编译通过/)
  const results = events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 5)
  assert.equal(results[1].data.meta.status, 'failed')
  assert.equal(results[1].data.meta.code, 1)
  assert.equal(results[3].data.meta.status, 'completed')
  assert.equal(results[3].data.meta.code, 0)
  assert.equal(events.at(-1).type, 'turn/end')
  assert.match(JSON.stringify(events.at(-1)), /completed|stop/)
})


test('stopping a running agent stops the remote process and the next task can still run', { skip }, async (t) => {
  const h = await setup(t, ({ LlmAdapter, ToolCallId }) => new class extends LlmAdapter {
    step = 0
    async *stream(options) {
      const step = this.step++
      if (step === 0) yield* reply('开始远程长任务。', { name: 'rw_exec', args: { command: 'printf started > started; sleep 2; printf BAD > escaped', promoteOnTimeout: false } }, ToolCallId, step)
      else if (step === 1) yield* reply('执行停止后的新任务。', { name: 'rw_exec', args: { command: 'printf RESUMED_OK' } }, ToolCallId, step)
      else {
        const last = options.messages.filter((m) => m.role === 'tool').at(-1)
        assert.match(JSON.stringify(last), /RESUMED_OK/)
        yield* reply('新任务成功：RESUMED_OK。', null, ToolCallId, step)
      }
    }
  }())
  h.send('启动远程任务，等待我停止。')
  for (let i = 0; i < 150 && !fs.existsSync(path.join(h.project, 'started')); i++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(fs.existsSync(path.join(h.project, 'started')), 'cancellation must occur after the remote command actually started')
  h.agent.cancel({ kind: 'user' })
  await h.agent.whenIdle()
  await new Promise((r) => setTimeout(r, 2200))
  assert.equal(fs.existsSync(path.join(h.project, 'escaped')), false, 'the remote process must not keep writing after the user stopped the task')
  assert.equal(h.adapter.step, 1, 'no new model step may run after cancellation')
  const stopped = h.agent.session.snapshotEvents().filter((e) => e.type === 'turn/end').at(-1)
  assert.deepEqual(stopped.data.reason, { kind: 'aborted', reason: { kind: 'user' } })
  h.send('请执行一个新的远程任务。')
  await h.agent.whenIdle()
  assert.equal(h.adapter.step, 3)
  assert.match(JSON.stringify(h.agent.session.snapshotEvents().filter((e) => e.type === 'assistant/message').at(-1)), /新任务成功/)
})
