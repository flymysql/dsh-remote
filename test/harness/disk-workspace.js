// A loopback SSH fixture whose SFTP and shell share REAL disposable files.
// Unlike the command-table fixture, build/test output comes from child processes.
import * as fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { startFakeSsh } from './fake-ssh.js'

class DiskFs {
  constructor(root) { this.root = path.resolve(root) }
  resolve(raw) {
    const target = path.resolve(raw)
    if (target !== this.root && !target.startsWith(this.root + path.sep)) throw new Error('outside disposable workspace')
    return target
  }
  _norm(raw) { return this.resolve(raw) }
  _mkdirp(raw) { fs.mkdirSync(this.resolve(raw), { recursive: true }) }
  get(raw) {
    const file = this.resolve(raw)
    try {
      const stat = fs.lstatSync(file)
      return { type: stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : 'file', stat }
    } catch (e) { if (e.code === 'ENOENT') return undefined; throw e }
  }
  has(raw) { return !!this.get(raw) }
  read(raw) { return fs.readFileSync(this.resolve(raw)) }
  readText(raw) { return this.read(raw).toString('utf8') }
  write(raw, content) { fs.writeFileSync(this.resolve(raw), content) }
  mkdir(raw) { fs.mkdirSync(this.resolve(raw)) }
  remove(raw) { fs.rmSync(this.resolve(raw), { recursive: true }) }
  rmdir(raw) { fs.rmdirSync(this.resolve(raw)) }
  rename(from, to) { fs.renameSync(this.resolve(from), this.resolve(to)) }
  symlink(target, raw) { fs.symlinkSync(this.resolve(target), this.resolve(raw)) }
  list(raw) { return fs.readdirSync(this.resolve(raw)).map((filename) => ({ filename, entry: this.get(path.join(raw, filename)) })) }
  attrsOf(entry) {
    const stat = entry.stat
    return { mode: stat.mode, size: stat.size, uid: stat.uid, gid: stat.gid, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) }
  }
}

/** Only for trusted test commands: shell processes have the test runner's OS permissions. */
export async function startDiskWorkspace(root, options = {}) {
  const children = new Set()
  const commands = []
  const filesystem = new DiskFs(root)
  const server = await startFakeSsh({
    users: { root: { password: 'test-only' } }, cwd: root, filesystem,
    onPtyExec(command, stream, session) {
      commands.push(command)
      if (options.onPtyExec?.(command, stream, session)) return true
      const child = spawn('/bin/sh', ['-c', command], { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      children.add(child)
      const kill = () => { if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* exited */ } } }
      child.stdout.pipe(stream, { end: false })
      child.stderr.pipe(stream.stderr, { end: false })
      stream.pipe(child.stdin)
      child.stdin.on('error', () => {})
      child.on('error', (error) => { stream.stderr.write(error.message); stream.exit(127); stream.end() })
      child.on('close', (code) => { children.delete(child); try { stream.exit(code ?? 128); stream.end() } catch { /* cancelled channel */ } })
      stream.on('close', kill)
      return true
    },
  })
  return {
    ...server, commands,
    async close() {
      for (const child of children) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* exited */ } }
      await server.close()
    },
  }
}
