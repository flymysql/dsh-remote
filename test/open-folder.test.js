// lib/open-folder.js — 用系统文件管理器打开本地目录（纯命令拼接 + spawn 形状）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { folderOpenCommand, openLocalFolder } from '../lib/open-folder.js'

/** 最小 spawn 替身：记录参数，手动触发 spawn/error 事件。 */
function fakeSpawn(events = 'spawn') {
  const calls = []
  let emit
  const fake = (command, args, options) => {
    calls.push({ command, args, options })
    return {
      on(event, handler) {
        if (event === events) emit = handler
      },
      unref() { calls.push({ unref: true }) },
    }
  }
  fake.calls = calls
  fake.fire = (error) => emit?.(error)
  return fake
}

test('folderOpenCommand: macOS / Windows / Linux 各自的默认打开命令', () => {
  assert.equal(folderOpenCommand('darwin'), 'open')
  assert.equal(folderOpenCommand('win32'), 'explorer')
  assert.equal(folderOpenCommand('linux'), 'xdg-open')
  assert.equal(folderOpenCommand('freebsd'), 'xdg-open')
})

test('openLocalFolder: 传目录、detached + ignore、unref，spawn 成功后 resolve', async () => {
  const spawn = fakeSpawn('spawn')
  const pending = openLocalFolder('/tmp/mirrors', { platform: 'darwin', spawnImpl: spawn })
  assert.equal(spawn.calls[0].command, 'open')
  assert.deepEqual(spawn.calls[0].args, ['/tmp/mirrors'])
  assert.equal(spawn.calls[0].options.detached, true)
  assert.equal(spawn.calls[0].options.stdio, 'ignore')
  assert.ok(spawn.calls.some((entry) => entry.unref === true), '不能阻止宿主退出')
  spawn.fire()
  assert.equal(await pending, 'open')
})

test('openLocalFolder: spawn 失败（如水 xdg-open 缺失）时 reject，供上层报错', async () => {
  const spawn = fakeSpawn('error')
  const pending = openLocalFolder('/tmp/mirrors', { platform: 'linux', spawnImpl: spawn })
  spawn.fire(new Error('spawn xdg-open ENOENT'))
  await assert.rejects(pending, /ENOENT/)
})

test('openLocalFolder: 空路径直接拒绝', async () => {
  const spawn = fakeSpawn('spawn')
  await assert.rejects(openLocalFolder('', { spawnImpl: spawn }), /target is required/)
  assert.equal(spawn.calls.length, 0)
})
