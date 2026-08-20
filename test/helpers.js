// In-memory remote SFTP server used by the sync/search tests.
// Mirrors the promisified sftp surface from lib/index.js (readdir/stat/lstat/
// mkdir/rmdir/unlink/rename/readFile/writeFile/fastGet/fastPut), backed by a
// plain object tree so tests are deterministic and fast.

export class MemFs {
  constructor() {
    this.root = new Map() // path → { type, content?, mtime, size }
    this.t = 1700000000
  }
  _set(path, entry) {
    this.root.set(path, { ...entry, size: entry.content ? entry.content.length : 0, mtime: entry.mtime || this.t++ })
  }
  mkdirSync(path) { this._set(path, { type: 'dir' }) }
  writeFileSync(path, content) { this._set(path, { type: 'file', content: Buffer.from(content) }) }
  existsSync(path) { return this.root.has(path) }
  readFileSync(path) {
    const e = this.root.get(path)
    if (!e || e.type !== 'file') throw new Error('no such file: ' + path)
    return e.content
  }
  statSync(path) {
    const e = this.root.get(path)
    if (!e) throw new Error('no such file: ' + path)
    return { size: e.size, mtime: e.mtime, isDirectory: () => e.type === 'dir', isSymbolicLink: () => false }
  }
}

/** Build the promisified sftp surface used by lib/sync.js / lib/search.js. */
export function makeSftp(fs) {
  const readdir = (dir) => {
    const out = []
    const prefix = dir === '/' ? '' : dir
    for (const [p, e] of fs.root) {
      if (p.startsWith(prefix + '/')) {
        const rest = p.slice(prefix.length + 1)
        if (rest && !rest.includes('/')) {
          out.push({ filename: rest, attrs: { size: e.size, mtime: e.mtime, isDirectory: () => e.type === 'dir', isSymbolicLink: () => false } })
        }
      }
    }
    return Promise.resolve(out)
  }
  return {
    readdir: (d) => readdir(d),
    stat: (p) => Promise.resolve(fs.statSync(p)),
    lstat: (p) => Promise.resolve(fs.statSync(p)),
    mkdir: (p) => { fs.mkdirSync(p); return Promise.resolve() },
    rmdir: (p) => { fs.root.delete(p); return Promise.resolve() },
    unlink: (p) => { fs.root.delete(p); return Promise.resolve() },
    rename: (a, b) => {
      const e = fs.root.get(a)
      if (!e) return Promise.reject(new Error('no such file'))
      fs.root.delete(a)
      fs._set(b, e)
      return Promise.resolve()
    },
    realpath: (p) => Promise.resolve(p),
    readFile: (p) => Promise.resolve(fs.readFileSync(p)),
    writeFile: (p, buf) => { fs.writeFileSync(p, buf); return Promise.resolve() },
    fastGet: (p, lp) => { fs.writeFileSync('@local:' + lp, fs.readFileSync(p)); return Promise.resolve() },
    fastPut: (p, lp) => { fs.writeFileSync(p, fs.readFileSync('@local:' + lp)); return Promise.resolve() },
  }
}

/** Seed a MemFs with a tree: { 'dir/file': 'content', ... } (parent dirs auto).
 * All paths are stored in absolute POSIX form ('/proj/README.md'). */
export function seed(fs, tree) {
  for (const [p, content] of Object.entries(tree)) {
    const parts = String(p).split('/').filter(Boolean)
    let cur = ''
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? cur + '/' + parts[i] : '/' + parts[i]
      if (!fs.existsSync(cur)) fs.mkdirSync(cur)
    }
    fs.writeFileSync('/' + parts.join('/'), content)
  }
}
