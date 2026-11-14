// Deterministic regression: intentionally choose the familiar local write,
// consume the real denial, then create the result through the remote tool.
import assert from 'node:assert/strict'
import { reply } from './agent-build-model.js'
export const generatedHtml = '<!doctype html><html><body><h1>REMOTE_GENERATED_HTML_中文鱼</h1></body></html>\n'
export function createBuildAdapter({ LlmAdapter, ToolCallId }) {
  return new class extends LlmAdapter {
    step = 0
    results = []
    async listModels(provider) { return [{ provider, id: 'deterministic', name: 'Local-write recovery regression' }] }
    async *stream(options) {
      if (options.purpose) { yield* reply('远端 HTML 来源验收', null, ToolCallId, -1); return }
      const ptc = options.tools?.some(tool => tool.name === 'run_code') && !options.tools.some(tool => tool.name === 'rw_write_file')
      const last = options.messages.filter(message => message.role === 'tool').at(-1)
      if (last) this.results.push(last)
      const output = last?.content.map(block => block.text || '').join('\n') || ''
      const step = this.step++
      if (step === 0) {
        yield* reply('生成 HTML 文件。', { name: 'write', args: { file_path: 'crocodile-bicycle.html', content: generatedHtml } }, ToolCallId, step, ptc)
      } else if (step === 1) {
        assert.equal(last?.isError, true, 'a remote session must reject the local filesystem mutation')
        assert.match(output, /LOCAL mirror|LOCAL.*mirror/)
        assert.match(output, /rw_write_file/)
        yield* reply('本地工具没有写入远端，改用远程工具。', { name: 'rw_write_file', args: { path: 'crocodile-bicycle.html', content: generatedHtml } }, ToolCallId, step, ptc)
      } else if (step === 2) {
        assert.notEqual(last?.isError, true)
        assert.match(output, /wrote \d+ bytes/)
        yield* reply('已通过远程工具保存：[打开 HTML](crocodile-bicycle.html)', null, ToolCallId, step, ptc)
      } else throw new Error('unexpected additional model step')
    }
  }()
}
