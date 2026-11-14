// Nonce-guarded disposable-profile fixture. The model is scripted; native file
// tools, Agent execution, GCC, session events and terminal processes are real.
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { reply } from '../../../test/harness/agent-build-model.js'
const require = createRequire(path.join(process.env.IT_DSH_MODULES, '__fixture__.cjs'))
const llm = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
const { setSandboxMode } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-sandbox-policy')))
const { setApprovalPolicy } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-user-approval')))
export const name = 'local-workbench-e2e-fixture'
export const inject = ['llm', 'agents', 'webServer', 'sessionController']
export function apply(ctx) {
  if (process.env.DSH_LOCAL_E2E !== '1' || !process.env.DSH_LOCAL_E2E_NONCE) throw new Error('Requires isolated local-workbench launcher')
  let running = false, step = 0
  ctx.llm.registerAdapter(['local-workbench-test'], new class extends llm.LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'deterministic', name: 'Local workspace acceptance', contextWindow: 65536 }] }
    async *stream(options) {
      if (options.purpose || !running) { yield* reply('本地工作区已就绪。', null, llm.ToolCallId, -1); return }
      const last = options.messages.filter(m => m.role === 'tool').at(-1)
      const output = last?.content.map(b => b.text || '').join('\n') || ''
      const current = step++
      const file = path.join(process.env.DSH_E2E_PROJECT, 'main.c')
      if (current === 0) yield* reply('使用原生 write 创建本地源码。', { name: 'write', args: { file_path: file, content: '#include <stdio.h>\nint main(void) { puts("LOCAL_BUILD_OK") return 0; }\n' } }, llm.ToolCallId, current)
      else if (current === 1) {
        assert.notEqual(last?.isError, true, output)
        yield* reply('生成本地 HTML。', { name: 'write', args: { file_path: path.join(process.env.DSH_E2E_PROJECT, 'generated.html'), content: '<!doctype html><h1>LOCAL_AGENT_GENERATED</h1>\n' } }, llm.ToolCallId, current)
      } else if (current === 2) {
        assert.notEqual(last?.isError, true, output)
        yield* reply('使用本地编译器检查错误。', { name: 'bash', args: { command: 'mkdir -p dist && gcc -Wall -Werror main.c -o dist/app', description: 'Compile the local project' } }, llm.ToolCallId, current)
      } else if (current === 3) {
        assert.match(output, /error:/)
        yield* reply('修复诊断指出的语法错误。', { name: 'edit', args: { file_path: file, old_string: 'puts("LOCAL_BUILD_OK")', new_string: 'puts("LOCAL_BUILD_OK");' } }, llm.ToolCallId, current)
      } else if (current === 4) {
        assert.notEqual(last?.isError, true, output)
        yield* reply('再次编译并运行实际产物。', { name: 'bash', args: { command: 'gcc -Wall -Werror main.c -o dist/app && ./dist/app', description: 'Compile and run local output' } }, llm.ToolCallId, current)
      } else if (current === 5) {
        assert.match(output, /LOCAL_BUILD_OK/)
        yield* reply('本地编译通过，运行输出 LOCAL_BUILD_OK。查看 [生成页面](generated.html) 与 [源码](main.c:2)。', null, llm.ToolCallId, current)
      } else throw new Error('Unexpected native local Agent model call')
    }
  }())
  const route = (name, action) => ctx.webServer.register({ kind: 'exact', path: '/local-workbench-e2e/' + name, async handler(req, res) {
    if (req.headers['x-dsh-local-e2e'] !== process.env.DSH_LOCAL_E2E_NONCE) { res.statusCode = 403; res.end(); return }
    try { const result = await action(); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result || { ok: true })) }
    catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })) }
  } })
  route('create', async () => {
    for (const [id, cwd] of [['local-primary', process.env.DSH_E2E_PROJECT], ['local-secondary', process.env.DSH_E2E_SECONDARY]]) {
      await ctx.sessionController.create({ sessionId: id, cwd })
      const session = ctx.agents.get(id).session
      setSandboxMode(session, 'danger-full-access'); setApprovalPolicy(session, 'never')
      await ctx.sessionController.selectModel({ sessionId: id, provider: 'local-workbench-test', model: 'deterministic' })
      await ctx.sessionController.prompt({ sessionId: id, requestId: id + '-ready', mode: 'queue', content: [{ type: 'text', text: '准备本地工作区验收。' }] }, new AbortController().signal)
    }
  })
  route('run', async () => {
    running = true
    await ctx.sessionController.prompt({ sessionId: 'local-primary', requestId: 'local-build', mode: 'queue', content: [{ type: 'text', text: '使用原生本地文件和命令工具创建 HTML 和 C 源码，实际编译、修复并运行，给出文件链接。' }] }, new AbortController().signal)
  })
  route('status', () => ({ step, status: ctx.agents.get('local-primary')?.status, events: ctx.agents.get('local-primary')?.session.snapshotEvents() }))
}
