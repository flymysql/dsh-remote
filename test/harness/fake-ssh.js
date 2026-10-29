// An in-process SSH server for tests.
//
// Why: the plugin's real work happens over SSH, and until now the suite had two
// choices — pure logic (95-100% covered, no SSH) or "connect to a closed port and
// assert it failed" (38% of lib/index.js). Every branch that matters to a user
// (list/read/write/stat/mkdir/remove/move/sync/search/upload/download/exec/
// forwards/terminal) lives on the other side of that connection, so it was simply
// untested. This server speaks enough of the protocol to exercise them for real:
// password / publickey / keyboard-interactive auth, `exec`, PTY shells, and an
// in-memory SFTP filesystem.
//
//   const srv = await startFakeSsh({ users: { root: { password: 'pw' } } })
//   // … point a machine at { host: '127.0.0.1', port: srv.port } …
//   srv.fs.get('/home/u/a.txt')      // inspect what the plugin wrote
//   srv.execLog                      // every command the plugin ran
//   await srv.close()
//
// Deliberate limits (documented so nobody mistakes this for a security test):
//   · no real filesystem, permissions, or symlink loops — it is an SFTP-shaped
//     in-memory tree;
//   · no algorithm negotiation edge cases (that is ssh2's own job);
//   · `exec` answers from a small command table + an `onExec` hook, so a test that
//     needs `ls`/`git` output supplies it explicitly instead of guessing.
import net from 'node:net'
import ssh2 from 'ssh2'
import { posix } from 'node:path'

const { Server, utils } = ssh2
const { OPEN_MODE, STATUS_CODE, flagsToString } = utils.sftp

/** One host key for the whole suite: generating ed25519 is fast but not free. */
let HOST_KEY = null
function hostKey() {
  if (!HOST_KEY) {
    const pair = utils.generateKeyPairSync('ed25519')
    HOST_KEY = pair.private
  }
  return HOST_KEY
}

const now = () => Math.floor(Date.now() / 1000)

/** In-memory POSIX-ish filesystem used by the SFTP server side. */
export class FakeFs {
  constructor(tree = {}) {
    /** @type {Map<string, {type:'file'|'dir'|'link', content?:Buffer, target?:string, mode?:number, mtime?:number}>} */
    this.entries = new Map()
    this.entries.set('/', { type: 'dir', mode: 0o40755, mtime: now() })
    for (const [p, v] of Object.entries(tree)) this.write(p, v)
  }
  _norm(p) {
    const n = posix.normalize(String(p || '/'))
    return n.startsWith('/') ? n : '/' + n
  }
  has(p) { return this.entries.has(this._norm(p)) }
  get(p) { return this.entries.get(this._norm(p)) }
  /** Create/overwrite a file (string or Buffer). Parent dirs are created. */
  write(p, content) {
    const abs = this._norm(p)
    this._mkdirp(posix.dirname(abs))
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content))
    this.entries.set(abs, { type: 'file', content: buf, mode: 0o100644, mtime: now() })
    return abs
  }
  mkdir(p) {
    const abs = this._norm(p)
    if (this.entries.has(abs)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    this._mkdirp(posix.dirname(abs))
    this.entries.set(abs, { type: 'dir', mode: 0o40755, mtime: now() })
    return abs
  }
  _mkdirp(dir) {
    if (!dir || dir === '/' || dir === '.') return
    if (this.entries.has(dir)) return
    this._mkdirp(posix.dirname(dir))
    this.entries.set(dir, { type: 'dir', mode: 0o40755, mtime: now() })
  }
  symlink(target, linkPath) {
    const abs = this._norm(linkPath)
    this._mkdirp(posix.dirname(abs))
    this.entries.set(abs, { type: 'link', target, mode: 0o120777, mtime: now() })
    return abs
  }
  /** Resolve a path through symlinks (bounded). */
  resolve(p, depth = 0) {
    const abs = this._norm(p)
    const e = this.entries.get(abs)
    if (!e || e.type !== 'link' || depth > 8) return abs
    const target = e.target.startsWith('/') ? e.target : posix.join(posix.dirname(abs), e.target)
    return this.resolve(target, depth + 1)
  }
  read(p) {
    const e = this.entries.get(this.resolve(p))
    if (!e || e.type !== 'file') throw Object.assign(new Error('no such file: ' + p), { code: 'ENOENT' })
    return e.content
  }
  readText(p) { return this.read(p).toString('utf8') }
  remove(p) {
    const abs = this.resolve(p)
    const e = this.entries.get(abs)
    if (!e) throw Object.assign(new Error('no such file: ' + p), { code: 'ENOENT' })
    if (e.type === 'dir') {
      for (const key of [...this.entries.keys()]) {
        if (key !== abs && key.startsWith(abs + '/')) this.entries.delete(key)
      }
    }
    this.entries.delete(abs)
  }
  rmdir(p) {
    const abs = this.resolve(p)
    const e = this.entries.get(abs)
    if (!e || e.type !== 'dir') throw Object.assign(new Error('no such dir: ' + p), { code: 'ENOENT' })
    const kids = [...this.entries.keys()].filter((k) => k !== abs && posix.dirname(k) === abs)
    if (kids.length) throw Object.assign(new Error('dir not empty'), { code: 'ENOTEMPTY' })
    this.entries.delete(abs)
  }
  rename(from, to) {
    const src = this.resolve(from)
    const e = this.entries.get(src)
    if (!e) throw Object.assign(new Error('no such file: ' + from), { code: 'ENOENT' })
    const dst = this._norm(to)
    this._mkdirp(posix.dirname(dst))
    this.entries.set(dst, e)
    this.entries.delete(src)
  }
  /** Entries directly inside a directory. */
  list(dir) {
    const abs = this.resolve(dir)
    const e = this.entries.get(abs)
    if (!e) throw Object.assign(new Error('no such dir: ' + dir), { code: 'ENOENT' })
    if (e.type !== 'dir') throw Object.assign(new Error('not a dir: ' + dir), { code: 'ENOTDIR' })
    const out = []
    for (const [key, entry] of this.entries) {
      if (key === abs) continue
      if (posix.dirname(key) !== abs) continue
      out.push({ filename: posix.basename(key), entry })
    }
    return out
  }
  attrsOf(entry, filename) {
    if (!entry) return { mode: 0, uid: 0, gid: 0, size: 0, atime: now(), mtime: now() }
    const size = entry.type === 'file' ? entry.content.length : entry.type === 'link' ? (entry.target || '').length : 4096
    return { mode: entry.mode || (entry.type === 'dir' ? 0o40755 : 0o100644), uid: 0, gid: 0, size, atime: entry.mtime, mtime: entry.mtime, ...(filename ? {} : {}) }
  }
}

const DEFAULT_TREE = {
  '/etc/hostname': 'fake-ssh\n',
}

/**
 * Start the fake server.
 *
 * @param {object} [opts]
 * @param {object} [opts.users] - `{ [username]: { password?, publicKey?, acceptKeyboard? } }`.
 *   An empty `users` map accepts ANY password (convenient for "the transport
 *   works" tests); pass `{}` + `rejectAll: true` to exercise auth failures.
 * @param {boolean} [opts.rejectAll] - reject every authentication attempt.
 * @param {string} [opts.platform] - 'posix' (default) or 'windows' (cmd/ver answers).
 * @param {object} [opts.fs] - initial tree `{ '/path': 'content' }`.
 * @param {string} [opts.cwd] - default working directory for relative paths.
 * @param {Function} [opts.onExec] - `(cmd, { username }) => { stdout?, stderr?, code? }`.
 * @param {boolean} [opts.silent] - do not print protocol errors to the console.
 */
export async function startFakeSsh(opts = {}) {
  const {
    users = {}, rejectAll = false, platform = 'posix', fs = DEFAULT_TREE,
    cwd = '/home/user', onExec = null,
  } = opts
  const tree = new FakeFs(fs)
  tree._mkdirp(cwd)
  const execLog = []
  const connections = []
  const sockets = new Set()
  let authAttempts = 0

  const answerExec = (cmd) => {
    execLog.push(cmd)
    const trimmed = String(cmd).trim()
    if (onExec) {
      const custom = onExec(trimmed, { cwd, tree })
      if (custom) return { stdout: '', stderr: '', code: 0, ...custom }
    }
    // Platform detection (lib/pool.js _detect): `cmd /c ver` must FAIL on posix.
    if (/^cmd(\.exe)?\s+\/c\s+ver/i.test(trimmed)) {
      return platform === 'windows'
        ? { stdout: '\r\nMicrosoft Windows [Version 10.0.19045.3803]\r\n', code: 0 }
        : { stdout: '', stderr: 'sh: cmd: command not found\n', code: 127 }
    }
    if (/^uname(\s+-s)?$/.test(trimmed)) {
      return { stdout: platform === 'windows' ? 'MINGW64_NT-10.0-19045\n' : 'Linux\n', code: 0 }
    }
    if (/^true$/.test(trimmed)) return { stdout: '', code: 0 }
    if (/^false$/.test(trimmed)) return { stdout: '', code: 1 }
    // `echo` ANYWHERE in the line: the plugin wraps commands with a `cd … &&`
    // prefix, so an anchored match would answer "(no output)" for a command that
    // really printed. A bare `~` expands to the login directory like a POSIX shell
    // (dsh-remote's /home route depends on that).
    const echo = /(?:^|&&|;|\|)\s*echo\s+(.+?)\s*$/.exec(trimmed)
    if (echo) {
      const arg = echo[1].replace(/^["']|["']$/g, '').replace(/^~$/, cwd)
      return { stdout: arg + '\n', code: 0 }
    }
    if (/^pwd$/.test(trimmed)) return { stdout: cwd + '\n', code: 0 }
    if (/^ls(\s|$)/.test(trimmed)) {
      try {
        const target = trimmed.split(/\s+/)[1] || cwd
        const names = tree.list(target.startsWith('/') ? target : posix.join(cwd, target))
        return { stdout: names.map((n) => n.filename).join('\n') + (names.length ? '\n' : ''), code: 0 }
      } catch (err) {
        return { stdout: '', stderr: `ls: ${err.message}\n`, code: 2 }
      }
    }
    // Unknown command → the REAL shell answer: exit 127, "command not found".
    // Answering exit 0 with empty output instead would be a lie with consequences:
    // `searchRemote` tries `grep` over the shell first and treats a clean exit as
    // "no matches", so a permissive fake would silently skip the SFTP fallback and
    // every search test would pass while testing nothing.
    return { stdout: '', stderr: `sh: ${trimmed.split(/\s+/)[0]}: command not found\n`, code: 127 }
  }

  const server = new Server({ hostKeys: [hostKey()] }, (client) => {
    connections.push(client)
    const dbg = process.env.FAKE_SSH_DEBUG ? (...a) => console.log('[fake-ssh]', ...a) : () => {}
    dbg('connection')
    client.on('error', (e) => dbg('client error', e && e.message))
    client.on('authentication', (ctx) => {
      authAttempts += 1
      dbg('auth', ctx.method, ctx.username)
      if (rejectAll) return ctx.reject(['password', 'publickey', 'keyboard-interactive'])
      const user = users[ctx.username]
      if (!user) {
        // No user table at all → accept anything (transport-level tests).
        if (Object.keys(users).length === 0) return ctx.accept()
        return ctx.reject(['password', 'publickey', 'keyboard-interactive'])
      }
      if (ctx.method === 'password' && user.password !== undefined && ctx.password === user.password) return ctx.accept()
      if (ctx.method === 'publickey' && user.publicKey && ctx.key && ctx.key.data) {
        const presented = ctx.key.data.toString('base64')
        if (presented === user.publicKey || ctx.key.algo === 'ssh-ed25519') {
          // Accept the key the test configured, by base64 compare when given.
          if (user.publicKey === presented) return ctx.accept()
        }
        return ctx.reject(['password', 'publickey', 'keyboard-interactive'])
      }
      if (ctx.method === 'keyboard-interactive' && user.acceptKeyboard) {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          if (answers && answers[0] === user.password) ctx.accept()
          else ctx.reject(['password', 'keyboard-interactive'])
        })
      }
      return ctx.reject(['password', 'publickey', 'keyboard-interactive'])
    })
    client.on('ready', () => {
      // direct-tcpip: what a port forward uses (`rw_forward`, /forwards). The fake
      // server really dials the requested target, so a test can forward to a local
      // echo server and prove bytes come back.
      client.on('tcpip', (accept, reject, info) => {
        const upstream = net.connect(info.destPort, info.destIP, () => {
          const channel = accept()
          channel.pipe(upstream).pipe(channel)
          channel.on('close', () => upstream.destroy())
          upstream.on('close', () => channel.destroy())
          upstream.on('error', () => { try { channel.destroy() } catch { /* gone */ } })
        })
        upstream.on('error', () => { try { reject() } catch { /* already rejected */ } })
      })
      client.on('session', (accept) => {
        const session = accept()
        session.on('env', (acceptEnv) => { try { acceptEnv() } catch { /* optional */ } })
        session.on('exec', (acceptExec, rejectExec, info) => {
          const stream = acceptExec()
          const res = answerExec(info.command)
          if (res.stdout) stream.write(res.stdout)
          if (res.stderr) stream.stderr.write(res.stderr)
          stream.exit(res.code || 0)
          stream.end()
        })
        // PTY shells: echo whatever arrives, answer `exit` by closing the channel.
        session.on('pty', (acceptPty) => { try { acceptPty() } catch { /* optional */ } })
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('fake-ssh$ ')
          stream.on('data', (chunk) => {
            const text = chunk.toString('utf8')
            if (/^\s*exit\s*$/m.test(text)) {
              stream.write('\n')
              stream.exit(0)
              stream.end()
              return
            }
            stream.write(text)
          })
        })
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          if (process.env.FAKE_SSH_DEBUG) {
            const emit = sftp.emit.bind(sftp)
            sftp.emit = (event, ...args) => {
              console.log('[fake-ssh sftp]', event, args.filter((a) => typeof a !== 'object' || a === null).join(' '))
              return emit(event, ...args)
            }
          }
          serveSftp(sftp, tree, cwd)
        })
      })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return {
    host: '127.0.0.1',
    port,
    fs: tree,
    execLog,
    get connections() { return connections.length },
    get authAttempts() { return authAttempts },
    /** A machine record body a test can hand to /dsh-remote/machines or rw_connect. */
    machine(overrides = {}) {
      return { host: '127.0.0.1', port, username: 'root', password: 'pw', hostKeyMode: 'off', ...overrides }
    },
    async close() {
      for (const socket of sockets) { try { socket.destroy() } catch { /* gone */ } }
      for (const client of connections) { try { client.end() } catch { /* gone */ } }
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Serve one SFTP channel against the in-memory tree. */
function serveSftp(sftp, tree, cwd) {
  const handles = new Map()
  let nextHandle = 1
  const abs = (p) => {
    const s = String(p || '')
    return tree._norm(s.startsWith('/') ? s : posix.join(cwd, s))
  }
  const mkHandle = (entry) => {
    const id = nextHandle++
    handles.set(id, entry)
    return Buffer.from(String(id))
  }
  const entryOf = (buf) => handles.get(Number(buf.toString()))
  const fail = (reqid, code = STATUS_CODE.FAILURE) => sftp.status(reqid, code)
  const noSuch = (reqid) => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
  const nameOf = (filename, entry) => ({
    filename,
    longname: filename,
    attrs: tree.attrsOf(entry, filename),
  })

  sftp.on('REALPATH', (reqid, p) => {
    const resolved = abs(p || '.')
    sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} }])
  })
  sftp.on('OPEN', (reqid, filename, flags) => {
    const target = abs(filename)
    const mode = flagsToString(flags) || ''
    const wantsWrite = /[wa+]/.test(mode) || (flags & OPEN_MODE.WRITE) || (flags & OPEN_MODE.CREAT)
    const existing = tree.get(target)
    if (!existing) {
      if (!wantsWrite) return noSuch(reqid)
      tree.write(target, '')
    } else if (existing.type === 'dir') {
      return fail(reqid, STATUS_CODE.FAILURE)
    } else if (mode.includes('w') || (flags & OPEN_MODE.TRUNC)) {
      tree.write(target, '')
    }
    sftp.handle(reqid, mkHandle({ kind: 'file', path: target }))
  })
  sftp.on('OPENDIR', (reqid, p) => {
    const target = abs(p)
    if (!tree.has(target)) return noSuch(reqid)
    sftp.handle(reqid, mkHandle({ kind: 'dir', path: target }))
  })
  sftp.on('READDIR', (reqid, buf) => {
    const h = entryOf(buf)
    if (!h) return fail(reqid)
    // One reply per request: ssh2's server side accepts a single response for a
    // request id, so "names + EOF" in one go silently drops the EOF and the client
    // re-sends READDIR forever. The protocol therefore needs TWO rounds: the listing
    // first, then STATUS EOF on the next READDIR for the same handle.
    if (h.readdirDone) return sftp.status(reqid, STATUS_CODE.EOF)
    let names
    try { names = tree.list(h.path) } catch { return noSuch(reqid) }
    h.readdirDone = true
    if (!names.length) return sftp.status(reqid, STATUS_CODE.EOF)
    sftp.name(reqid, names.map((n) => nameOf(n.filename, n.entry)))
  })
  sftp.on('READ', (reqid, buf, offset, length) => {
    const h = entryOf(buf)
    if (!h) return fail(reqid)
    let content
    try { content = tree.read(h.path) } catch { return noSuch(reqid) }
    if (offset >= content.length) return sftp.status(reqid, STATUS_CODE.EOF)
    sftp.data(reqid, content.subarray(offset, Math.min(offset + length, content.length)))
  })
  sftp.on('WRITE', (reqid, buf, offset, data) => {
    const h = entryOf(buf)
    if (!h) return fail(reqid)
    let current
    try { current = tree.read(h.path) } catch { current = Buffer.alloc(0) }
    const end = offset + data.length
    const next = Buffer.alloc(Math.max(current.length, end))
    current.copy(next, 0)
    data.copy(next, offset)
    tree.write(h.path, next)
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('FSTAT', (reqid, buf) => {
    const h = entryOf(buf)
    if (!h) return fail(reqid)
    const e = tree.get(h.path)
    if (!e) return noSuch(reqid)
    sftp.attrs(reqid, tree.attrsOf(e, posix.basename(h.path)))
  })
  sftp.on('STAT', (reqid, p) => {
    const target = tree.resolve(abs(p))
    const e = tree.get(target)
    if (!e) return noSuch(reqid)
    sftp.attrs(reqid, tree.attrsOf(e, posix.basename(target)))
  })
  sftp.on('LSTAT', (reqid, p) => {
    const target = abs(p)
    const e = tree.get(target)
    if (!e) return noSuch(reqid)
    sftp.attrs(reqid, tree.attrsOf(e, posix.basename(target)))
  })
  sftp.on('READLINK', (reqid, p) => {
    const e = tree.get(abs(p))
    if (!e || e.type !== 'link') return noSuch(reqid)
    sftp.name(reqid, [{ filename: e.target, longname: e.target, attrs: {} }])
  })
  sftp.on('SYMLINK', (reqid, linkPath, targetPath) => {
    try { tree.symlink(targetPath, abs(linkPath)); sftp.status(reqid, STATUS_CODE.OK) } catch { fail(reqid) }
  })
  sftp.on('CLOSE', (reqid, buf) => {
    handles.delete(Number(buf.toString()))
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('REMOVE', (reqid, p) => {
    try { tree.remove(abs(p)); sftp.status(reqid, STATUS_CODE.OK) } catch { noSuch(reqid) }
  })
  sftp.on('RMDIR', (reqid, p) => {
    try { tree.rmdir(abs(p)); sftp.status(reqid, STATUS_CODE.OK) } catch (err) {
      fail(reqid, err && err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE)
    }
  })
  sftp.on('MKDIR', (reqid, p) => {
    try { tree.mkdir(abs(p)); sftp.status(reqid, STATUS_CODE.OK) } catch { fail(reqid) }
  })
  sftp.on('RENAME', (reqid, from, to) => {
    try { tree.rename(abs(from), abs(to)); sftp.status(reqid, STATUS_CODE.OK) } catch { noSuch(reqid) }
  })
  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
  sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
}
