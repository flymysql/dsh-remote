// deck-bridge 公开入口：外挂插件 dsh-deck-remote-exec 用它替代「绝对路径动态 import lib/*.js」。
//
// 这里验证两件事：
//   1. 通过包名 `dsh-remote/deck-bridge` 能解析到 6 个符号（self-reference，靠 package.json 的 exports）——
//      这正是外挂插件不再绕过 exports 限制的前提；
//   2. 转发的符号与原模块是同一个函数/类，行为一致（本文件只做转发，零逻辑）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveMirror, SystemOpenSshPool, resolveRemoteWorkspacePath, relPathUnder, remoteDirname, shq,
} from 'dsh-remote/deck-bridge'
import { resolveMirror as bindingResolveMirror } from '../lib/binding.js'
import { SystemOpenSshPool as opensshPool } from '../lib/openssh.js'
import {
  resolveRemoteWorkspacePath as pathsResolve, relPathUnder as pathsRel, remoteDirname as pathsDirname, shq as pathsShq,
} from '../lib/paths.js'

test('公开入口通过包名可解析，且恰好导出插件需要的 6 个符号', async () => {
  const m = await import('dsh-remote/deck-bridge')
  assert.deepEqual(
    Object.keys(m).sort(),
    ['SystemOpenSshPool', 'relPathUnder', 'remoteDirname', 'resolveMirror', 'resolveRemoteWorkspacePath', 'shq'],
  )
})

test('转发的符号与原模块是同一实现', () => {
  assert.equal(resolveMirror, bindingResolveMirror)
  assert.equal(SystemOpenSshPool, opensshPool)
  assert.equal(resolveRemoteWorkspacePath, pathsResolve)
  assert.equal(relPathUnder, pathsRel)
  assert.equal(remoteDirname, pathsDirname)
  assert.equal(shq, pathsShq)
})

test('转发的纯函数行为与原模块一致', () => {
  assert.equal(shq("it's"), `'it'\\''s'`)
  assert.equal(relPathUnder('/a/b', '/a/b/c'), 'c')
  assert.equal(relPathUnder('/a/b', '/x/y'), null)
  assert.equal(remoteDirname('/a/b/c'), '/a/b')
  assert.equal(resolveRemoteWorkspacePath('/remote/ws', 'src/main.py', '/local/mirror'), '/remote/ws/src/main.py')
})
