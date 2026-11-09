// 在系统默认文件管理器里打开一个本地目录。
//
// 插件跑在 dsh-tui 进程里，所以“打开本机文件夹”就是一个本地动作：
//   · macOS → `open <dir>`
//   · Windows → `explorer <dir>`
//   · 其它 → `xdg-open <dir>`
// 只做一次 spawn，不读输出、不等待、不阻塞；spawn 的异步 `error` 必须被吃掉，
// 否则一个不存在的 `xdg-open` 会以未处理事件把宿主进程带崩。

import { spawn } from 'node:child_process'

/** 当前平台对应的“打开文件夹”命令。 */
export function folderOpenCommand(platform = process.platform) {
  if (platform === 'darwin') return 'open'
  if (platform === 'win32') return 'explorer'
  return 'xdg-open'
}

/**
 * 用系统默认文件管理器打开 `target`。
 *
 * 返回的 Promise 在子进程真的 spawn 成功时 resolve、spawn 失败（如 Linux 没有
 * `xdg-open`、权限不足）时 reject —— 调用方不能先报“已打开”再吞掉失败。
 * 子进程本身仍然 detached + ignore，且从不 await 退出码：`explorer` 对目录参数
 * 返回非零退出码是常态。
 *
 * @param {string} target - 本地绝对路径。
 * @param {object} [options]
 * @param {string} [options.platform] - 覆盖平台（测试用）。
 * @param {Function} [options.spawnImpl] - 覆盖 spawn（测试用）。
 * @returns {Promise<string>} resolve 实际使用的命令名。
 */
export function openLocalFolder(target, options = {}) {
  const platform = options.platform || process.platform
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
  const directory = String(target == null ? '' : target)
  if (!directory) return Promise.reject(new Error('openLocalFolder: target is required'))
  const command = folderOpenCommand(platform)
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(command, [directory], { detached: true, stdio: 'ignore' })
    } catch (error) {
      reject(error)
      return
    }
    if (!child || typeof child.on !== 'function') {
      // 极小化的 spawn 替身：没有事件可等，按成功处理。
      resolve(command)
      return
    }
    child.on('spawn', () => resolve(command))
    child.on('error', reject)
    if (typeof child.unref === 'function') child.unref()
  })
}
