// Deterministic decisions for integration tests; this is NOT a real model.
import assert from 'node:assert/strict'

export const broken = '#include <stdio.h>\nint main(void) {\n  puts("REMOTE_BUILD_OK")\n  return 0;\n}\n'
export const fixed = broken.replace('puts("REMOTE_BUILD_OK")', 'puts("REMOTE_BUILD_OK");')

export async function* reply(text, tool, ToolCallId, step, ptc = false) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  if (tool) {
    if (ptc) tool = { name: 'run_code', args: { description: text, code: 'const result = await tools.' + tool.name + '(' + JSON.stringify(tool.args) + '); console.log(result.text ?? JSON.stringify(result));' } }
    const block = { type: 'tool-call', id: ToolCallId('build-call-' + step), name: tool.name, arguments: JSON.stringify(tool.args) }
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id: block.id, name: block.name, argumentsDelta: block.arguments }
    yield { type: 'block-end', index: 1, block }
  }
  yield { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } }
}

export function createBuildAdapter({ LlmAdapter, ToolCallId }, { project }) {
  return new class extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'deterministic', name: 'Scripted integration test' }] }
    step = 0
    results = []
    async *stream(options) {
      if (options.purpose) { yield* reply('远程编译验收', null, ToolCallId, -1); return }
      const ptc = options.tools?.some((tool) => tool.name === 'run_code') && !options.tools.some((tool) => tool.name === 'rw_exec')
      const toolResults = options.messages.filter((m) => m.role === 'tool')
      const last = toolResults.at(-1)
      if (last) this.results.push(last)
      const output = last?.content.map((b) => b.text || '').join('\n') || ''
      const step = this.step++
      const file = project + '/src/main.c'
      const build = { name: 'rw_exec', args: { command: 'mkdir -p dist && gcc -Wall -Werror src/main.c -o dist/app' } }
      if (step === 0) {
        assert.match(JSON.stringify(options.messages), /Remote workspace/)
        assert.ok(ptc || options.tools.some((tool) => tool.name === 'rw_exec'))
        yield* reply('先读取远程源码，再实际编译。', { name: 'rw_read_file', args: { path: file } }, ToolCallId, step, ptc)
      } else if (step === 1) {
        assert.match(output, /puts\("REMOTE_BUILD_OK"\)/)
        assert.doesNotMatch(output, /LOCAL_MIRROR_MUST_NOT_COMPILE/)
        yield* reply('在远端运行 GCC，检查实际诊断。', build, ToolCallId, step, ptc)
      } else if (step === 2) {
        assert.match(output, /error:/)
        assert.match(output, /main\.c:3:/)
        assert.match(output, /\[exit code: 1\]/)
        yield* reply('编译失败：第 3 行缺少分号，现在修复。', { name: 'rw_edit', args: { path: file, old: 'puts("REMOTE_BUILD_OK")', new: 'puts("REMOTE_BUILD_OK");' } }, ToolCallId, step, ptc)
      } else if (step === 3) {
        assert.ok(!last.isError, output)
        yield* reply('修改已写入远端，重新编译。', build, ToolCallId, step, ptc)
      } else if (step === 4) {
        assert.ok(!last.isError, output)
        assert.doesNotMatch(output, /\[exit code: [1-9]/)
        yield* reply('编译成功，运行生成的程序。', { name: 'rw_exec', args: { command: './dist/app' } }, ToolCallId, step, ptc)
      } else if (step === 5) {
        assert.match(output, /REMOTE_BUILD_OK/)
        assert.ok(!last.isError, output)
        assert.doesNotMatch(output, /\[exit code: [1-9]/)
        yield* reply('已修复 src/main.c:3；远端 GCC 编译通过，运行输出为 REMOTE_BUILD_OK。', null, ToolCallId, step, ptc)
      } else throw new Error('unexpected extra model call')
    }
  }()
}
