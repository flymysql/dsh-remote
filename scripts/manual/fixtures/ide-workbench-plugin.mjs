// Disposable Web fixture: actual Agent/SSH/compiler task, with deterministic
// model pacing so layout switches are exercised while the task is running.
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createBuildAdapter, reply } from '../../../test/harness/agent-build-model.js'
const require = createRequire(path.join(process.env.IT_DSH_MODULES, '__fixture__.cjs'))
const llm = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
export const name = 'ide-workbench-e2e-fixture'
export const inject = ['llm', 'agents', 'webServer', 'sessionController']
export function apply(ctx) {
  if (process.env.DSH_IDE_E2E !== '1' || !process.env.DSH_IDE_E2E_NONCE) throw new Error('IDE fixture requires the isolated E2E launcher')
  const build = createBuildAdapter(llm, { project: process.env.DSH_E2E_PROJECT })
  const listBuildModels = build.listModels.bind(build)
  build.listModels = async provider => (await listBuildModels(provider)).map(model => ({ ...model, contextWindow: 65536 }))
  let buildStarted = false
  const original = build.stream.bind(build)
  build.stream = async function* (options) {
    if (!buildStarted) { yield* reply('IDE 原生会话已就绪。', null, llm.ToolCallId, -1); return }
    await new Promise(resolve => setTimeout(resolve, 700)); yield* original(options)
  }
  ctx.llm.registerAdapter(['ide-build-fixture'], build)
  ctx.llm.registerAdapter(['ide-ready-fixture'], new class extends llm.LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'deterministic', name: 'IDE ready fixture', contextWindow: 65536 }] }
    async *stream() { yield* reply('IDE 原生会话已就绪。', null, llm.ToolCallId, -1) }
  }())
  const route = (name, action) => ctx.webServer.register({ kind: 'exact', path: '/ide-e2e/' + name, async handler(req, res) {
    if (req.headers['x-dsh-ide-e2e'] !== process.env.DSH_IDE_E2E_NONCE) { res.statusCode = 403; res.end(); return }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const data = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}
      const result = await action(data)
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result || { ok: true }))
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })) }
  } })
  route('create', async ({ mirror, secondMirror }) => {
    for (const cwd of [mirror, secondMirror]) if (!path.resolve(cwd).startsWith(path.join(process.env.DSH_HOME, 'remote-workspaces') + path.sep)) throw new Error('Expected disposable mirror')
    for (const [id, cwd] of [['ide-primary', mirror], ['ide-secondary', secondMirror], ['ide-local', process.env.DSH_E2E_PROJECT]]) {
      await ctx.sessionController.create({ sessionId: id, cwd })
      await ctx.sessionController.selectModel({ sessionId: id, provider: id === 'ide-primary' ? 'ide-build-fixture' : 'ide-ready-fixture', model: 'deterministic' })
      await ctx.sessionController.prompt({ sessionId: id, requestId: id + '-ready', mode: 'queue', content: [{ type: 'text', text: '准备 IDE 验收。' }] }, new AbortController().signal)
    }
  })
  route('run', async () => {
    buildStarted = true
    await ctx.sessionController.prompt({ sessionId: 'ide-primary', requestId: 'ide-build', mode: 'queue', content: [{ type: 'text', text: '编译 src/main.c 并修复后运行。' }] }, new AbortController().signal)
  })
  route('status', () => ({ step: build.step, status: ctx.agents.get('ide-primary')?.status }))
}
