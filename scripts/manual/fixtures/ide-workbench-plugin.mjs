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
  let artifactStep = 0
  const generatedHtml = '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>Remote artifact</title></head><body><h1>GENERATED_ON_REMOTE_SFTP</h1></body></html>\n'
  ctx.llm.registerAdapter(['ide-artifact-fixture'], new class extends llm.LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'deterministic', name: 'IDE generated artifact fixture', contextWindow: 65536 }] }
    async *stream(options) {
      if (options.purpose) { yield* reply('HTML 工作区产物验收', null, llm.ToolCallId, -1); return }
      const step = artifactStep++
      if (step === 0) {
        if (!options.tools.some(tool => tool.name === 'rw_write_file')) throw new Error('The real remote write tool must be available')
        yield* reply('使用远端文件工具创建页面。', { name: 'rw_write_file', args: { path: path.join(process.env.DSH_E2E_PROJECT, 'generated.html'), content: generatedHtml } }, llm.ToolCallId, 1000)
      } else if (step === 1) {
        const result = options.messages.filter(message => message.role === 'tool').at(-1)
        if (!result || result.isError) throw new Error('Remote HTML creation must succeed before exposing its link')
        yield* reply('新页面已写入远端：[generated.html](generated.html)。\n\n旧任务仅留下本地镜像副本，可显式恢复：[legacy-only.html](legacy-only.html)。', null, llm.ToolCallId, 1001)
      } else throw new Error('Unexpected extra artifact model call')
    }
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
  route('artifacts-start', async ({ mirror }) => {
    if (!path.resolve(mirror).startsWith(path.join(process.env.DSH_HOME, 'remote-workspaces') + path.sep)) throw new Error('Expected disposable artifact mirror')
    await ctx.sessionController.create({ sessionId: 'ide-artifacts', cwd: mirror })
    await ctx.sessionController.selectModel({ sessionId: 'ide-artifacts', provider: 'ide-artifact-fixture', model: 'deterministic' })
    await ctx.sessionController.prompt({ sessionId: 'ide-artifacts', requestId: 'ide-artifacts-generate', mode: 'queue', content: [{ type: 'text', text: '在远程工作区创建 generated.html 并给出文件链接，同时列出已有历史本地副本 legacy-only.html 的恢复链接。' }] }, new AbortController().signal)
  })
  route('artifacts-status', () => ({ step: artifactStep, status: ctx.agents.get('ide-artifacts')?.status }))
  route('presentation-title', () => ctx.sessionController.rename({ sessionId: 'ide-primary', title: '修复远程构建' }))
  route('stress-header', () => ctx.sessionController.rename({ sessionId: 'ide-primary', title: '超长远程开发会话标题 · 构建与目录搜索交互回归 · SSH 多工作区并行任务验证 · Native IDE header stress title' }))
  route('run', async () => {
    buildStarted = true
    await ctx.sessionController.prompt({ sessionId: 'ide-primary', requestId: 'ide-build', mode: 'queue', content: [{ type: 'text', text: '编译 src/main.c 并修复后运行。' }] }, new AbortController().signal)
  })
  route('status', () => ({ step: build.step, status: ctx.agents.get('ide-primary')?.status }))
}
