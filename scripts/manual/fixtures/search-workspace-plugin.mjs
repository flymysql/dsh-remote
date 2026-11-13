// Test-only session setup, guarded by a nonce and a disposable DSH_HOME.
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { reply } from '../../../test/harness/agent-build-model.js'
const require = createRequire(path.join(process.env.IT_DSH_MODULES, '__fixture__.cjs'))
const { LlmAdapter, ToolCallId } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
export const name = 'search-workspace-e2e-fixture'
export const inject = ['webServer', 'sessionController', 'llm']
export function apply(ctx) {
  if (process.env.DSH_SEARCH_E2E !== '1' || !process.env.DSH_SEARCH_E2E_NONCE) throw new Error('Search fixture requires its isolated E2E launcher')
  const adapter = new class extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'deterministic', name: 'Search workbench fixture' }] }
    async *stream() { yield* reply('远程搜索检查会话已就绪。', null, ToolCallId, 0) }
  }()
  ctx.llm.registerAdapter(['search-workspace-fixture'], adapter)
  ctx.webServer.register({ kind: 'exact', path: '/search-e2e/create-session', async handler(req, res) {
    if (req.method !== 'POST' || req.headers['x-dsh-search-e2e'] !== process.env.DSH_SEARCH_E2E_NONCE) { res.statusCode = 403; res.end(); return }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const { mirror } = JSON.parse(Buffer.concat(chunks))
      if (!path.resolve(mirror).startsWith(path.join(process.env.DSH_HOME, 'remote-workspaces') + path.sep)) throw new Error('Expected fixture mirror')
      await ctx.sessionController.create({ sessionId: 'remote-search-e2e', cwd: mirror })
      await ctx.sessionController.selectModel({ sessionId: 'remote-search-e2e', provider: 'search-workspace-fixture', model: 'deterministic' })
      await ctx.sessionController.prompt({ sessionId: 'remote-search-e2e', requestId: 'search-fixture-prompt', mode: 'queue', content: [{ type: 'text', text: '准备远程搜索检查会话。' }] }, new AbortController().signal)
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ sessionId: 'remote-search-e2e' }))
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })) }
  } })
}
