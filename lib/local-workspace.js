// Local execution-world adapter for the shared workspace UI. Never used by rw_*
// Agent tools. Every filesystem operation is rooted in a server-resolved session
// directory; neither an active SSH machine nor a client-supplied root is used.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const sameLocalPath = (a, b, grammar = path) => grammar.relative(a, b) === ''
const denied = () => Object.assign(new Error('Path is outside this local workspace (including symlink targets)'), { httpStatus: 403, code: 'LOCAL_WORKSPACE_PATH' })
const inside = (root, target) => { const rel = path.relative(root, target); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep) }
const attrs = stat => ({
  size: stat.size, mtime: stat.mtimeMs / 1000, mode: stat.mode,
  isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink(),
})

export async function createLocalWorkspacePool(directory) {
  const root = path.resolve(directory), canonical = await fs.realpath(root)
  if (!(await fs.stat(canonical)).isDirectory()) throw Object.assign(new Error('Local workspace directory is unavailable'), { httpStatus: 404 })
  const resolve = async (input, { mutation = false } = {}) => {
    if (typeof input !== 'string' || !input || input.includes('\0') || !path.isAbsolute(input)) throw denied()
    const target = path.resolve(input)
    if (!inside(root, target) && !inside(canonical, target)) throw denied()
    if (mutation && (sameLocalPath(root, target) || sameLocalPath(canonical, target))) throw denied()
    // Missing children may be created, but their nearest existing ancestor must
    // still be inside the canonical project. No symlink escape on read or save.
    let ancestor = target
    for (;;) {
      try { if (!inside(canonical, await fs.realpath(ancestor))) throw denied(); break }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        const parent = path.dirname(ancestor)
        if (parent === ancestor) throw denied()
        // A dangling symlink must not be treated as an ordinary missing child.
        try { if ((await fs.lstat(ancestor)).isSymbolicLink()) throw denied() } catch (e) { if (e.code !== 'ENOENT') throw e }
        ancestor = parent
      }
    }
    return target
  }
  const regularFile = async p => {
    const target = await resolve(p)
    if (!(await fs.stat(target)).isFile()) throw Object.assign(new Error('Only regular local files can be previewed'), { httpStatus: 415 })
    return target
  }
  const sftp = {
    async stat(p) { return attrs(await fs.stat(await resolve(p))) },
    async lstat(p) { return attrs(await fs.lstat(await resolve(p))) },
    async realpath(p) { return fs.realpath(await resolve(p)) },
    async readdir(p) {
      const dir = await resolve(p), names = await fs.readdir(dir)
      return Promise.all(names.map(async filename => ({ filename, attrs: attrs(await fs.lstat(path.join(dir, filename))) })))
    },
    async readFile(p) { return fs.readFile(await regularFile(p)) },
    async readPartial(p, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 4 * 1024 * 1024) throw new Error('Invalid bounded read')
      const file = await fs.open(await regularFile(p), 'r')
      try { const buffer = Buffer.alloc(length); const { bytesRead } = await file.read(buffer, 0, length, offset); return buffer.subarray(0, bytesRead) }
      finally { await file.close() }
    },
    async mkdir(p) { return fs.mkdir(await resolve(p, { mutation: true })) },
    async rmdir(p) { return fs.rmdir(await resolve(p, { mutation: true })) },
    async unlink(p) { return fs.unlink(await resolve(p, { mutation: true })) },
    async writeFile(p, bytes, options) { return fs.writeFile(await resolve(p, { mutation: true }), bytes, options) },
    async setstat(p, data) { if (data.mode != null) await fs.chmod(await resolve(p, { mutation: true }), data.mode) },
    async rename(from, to) {
      const source = await resolve(from, { mutation: true }), dest = await resolve(to, { mutation: true })
      const stat = await fs.lstat(source)
      if (stat.isFile()) { await fs.link(source, dest); await fs.unlink(source); return }
      try { await fs.lstat(dest); throw Object.assign(new Error('Destination already exists'), { code: 'EEXIST' }) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      return fs.rename(source, dest)
    },
    async renameOverwrite(from, to) { return fs.rename(await resolve(from, { mutation: true }), await resolve(to, { mutation: true })) },
  }
  return {
    checkPath: resolve,
    async mkdirTree(p) { return fs.mkdir(await resolve(p, { mutation: true }), { recursive: true }) },
    async removeTree(p) { return fs.rm(await resolve(p, { mutation: true }), { recursive: true }) },
    config: { local: true }, platform: process.platform === 'win32' ? 'windows' : 'posix', local: true,
    async detect() {}, async sftp() { return sftp },
    // Git receives an argv array, never a POSIX command string on Windows.
    execFile(file, args, { signal, timeoutMs = 15000, onData } = {}) {
      if (file !== 'git') throw new Error('Only read-only Git inspection is available through this adapter')
      return new Promise(resolveResult => {
        let stdout = '', stderr = '', timedOut = false, settled = false
        const env = { ...process.env }
        for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']) delete env[key]
        const child = spawn(file, args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        const append = (channel, chunk) => { const text = chunk.toString(); if (channel === 'stdout') stdout = (stdout + text).slice(0, 256 * 1024); else stderr = (stderr + text).slice(0, 256 * 1024); onData?.(channel, text) }
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
        child.stdout.on('data', data => append('stdout', data)); child.stderr.on('data', data => append('stderr', data))
        const stop = () => child.kill()
        const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
        const done = (code, error) => {
          if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop)
          resolveResult({ code: code ?? 1, stdout, stderr: error ? String(error.message || error) : stderr, ...(timedOut ? { signal: 'TIMEOUT' } : {}) })
        }
        child.on('error', error => done(error.code === 'ENOENT' ? 127 : 1, error)); child.on('close', code => done(code))
        if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true })
      })
    },
  }
}
