// dsh-remote — the promisified SFTP surface every backend presents.
//
// Both SSH transports (the native ssh2 pool in lib/pool.js and the
// system-OpenSSH pool in lib/openssh.js) must expose the SAME object to
// callers: lib/sync.js, lib/search.js, lib/routes-fs.js, lib/remote-fs.js and
// the rw_* tools all consume this exact shape. Keeping one implementation
// matters more than it looks: the timeout, dead-channel and range-read rules
// below encode failures that were expensive to find (issue #44), and a second
// hand-copied version would drift away from the fixed one.
//
// The two rules that are easy to get wrong:
//   • A dead channel must fail FAST. ssh2's own EOF handling only rejects the
//     requests pending at that moment; every later request is registered and
//     never answered, so each waits out the full commandTimeoutMs. Over a tree
//     walk that is N × 2 × timeout — days on a large directory.
//   • `readPartial` exists so an oversized preview never downloads the whole
//     file to show its head.
import { toSftpPath } from './paths.js'

/**
 * Wrap a live SFTP channel (ssh2's SFTP instance) in the promisified surface
 * the plugin's callers expect.
 *
 * @param {object} sftp - an ssh2 SFTP channel (already negotiated/ready).
 * @param {object} opts
 * @param {number} opts.commandTimeoutMs - per-operation timeout.
 * @returns {object} promisified sftp surface.
 */
export function buildSftpSurface(sftp, { commandTimeoutMs, onTimeout }) {
  // A dead channel must fail fast (see the header). ssh2's SFTP instance and the
  // system-OpenSSH engine both emit these, so one hook covers both backends.
  let dead = false
  const markDead = () => { dead = true }
  if (typeof sftp.on === 'function') {
    sftp.on('end', markDead)
    sftp.on('close', markDead)
    sftp.on('error', markDead)
  }
  const withTimeout = (fn) => (...args) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(new Error('sftp channel closed'))
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        markDead()
        if (typeof onTimeout === 'function') { try { onTimeout() } catch { /* best effort */ } }
        reject(new Error('sftp operation timed out'))
      }, commandTimeoutMs)
      const finish = (err, value) => {
        clearTimeout(timer)
        if (timedOut) return
        err ? reject(err) : resolve(value)
      }
      try { fn(...args, finish) } catch (err) { clearTimeout(timer); if (!timedOut) reject(err) }
    })
  const P = (p) => toSftpPath(p)
  return {
    readdir: (dir) => withTimeout((d, cb) => sftp.readdir(d, cb))(P(dir)),
    stat: (p) => withTimeout((d, cb) => sftp.stat(d, cb))(P(p)),
    lstat: (p) => withTimeout((d, cb) => sftp.lstat(d, cb))(P(p)),
    mkdir: (dir) => withTimeout((d, cb) => sftp.mkdir(d, cb))(P(dir)),
    rmdir: (dir) => withTimeout((d, cb) => sftp.rmdir(d, cb))(P(dir)),
    unlink: (p) => withTimeout((d, cb) => sftp.unlink(d, cb))(P(p)),
    rename: (p, d) => withTimeout((a, b, cb) => sftp.rename(a, b, cb))(P(p), P(d)),
    // POSIX rename(2) semantics: atomically REPLACE an existing destination.
    // Plain SSH_FXP_RENAME fails when the target exists (OpenSSH's sftp-server
    // enforces that even though it advertises posix-rename@openssh.com — ssh2
    // only sends the extension when asked explicitly, verified against
    // OpenSSH_9.6 in issue #65). Servers with the extension get one atomic
    // request; servers without it get the move-aside dance, whose every hop
    // targets a path that does not exist, which plain RENAME always permits.
    // rw_edit's atomic write depends on this — without it every edit of an
    // existing file fails with a bare "Failure".
    renameOverwrite: (p, d) => withTimeout((a, b, cb) => {
      const ext = sftp._extensions && sftp._extensions['posix-rename@openssh.com']
      if (ext === '1' && typeof sftp.ext_openssh_rename === 'function') {
        return sftp.ext_openssh_rename(a, b, cb)
      }
      const bak = `${b}.dsh-remote-bak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`
      sftp.rename(b, bak, (e1) => {
        if (e1) {
          // Destination absent → a plain rename is already overwrite-safe.
          if (/no such/i.test(String((e1 && e1.message) || e1))) return sftp.rename(a, b, cb)
          return cb(e1)
        }
        sftp.rename(a, b, (e2) => {
          if (e2) {
            // Roll the original back into place before reporting the failure.
            return sftp.rename(bak, b, () => cb(e2))
          }
          // Best effort: a leftover backup must not fail the operation.
          sftp.unlink(bak, () => cb(null))
        })
      })
    })(P(p), P(d)),
    realpath: (p) => withTimeout((d, cb) => sftp.realpath(d, cb))(P(p)),
    // Attribute write (chmod semantics live in setstat at the protocol level,
    // so BOTH backends — ssh2's SFTPWrapper and its raw protocol SFTP — answer
    // this one shape). Used by rw_edit to restore the original mode after an
    // atomic rename replace (issue #65).
    setstat: (p, attrs) => withTimeout((d, a, cb) => sftp.setstat(d, a, cb))(P(p), attrs),
    readFile: (p) => withTimeout((d, cb) => sftp.readFile(d, cb))(P(p)),
    writeFile: (p, data, options) => withTimeout((d, data2, cb) => options ? sftp.writeFile(d, data2, options, cb) : sftp.writeFile(d, data2, cb))(P(p), data),
    fastGet: (p, lp) => withTimeout((d, l, cb) => sftp.fastGet(d, l, cb))(P(p), lp),
    fastPut: (lp, p) => withTimeout((l, d, cb) => sftp.fastPut(l, d, cb))(lp, P(p)),
    // Range read for oversized previews: never downloads the whole file.
    readPartial: (p, offset, length) => withTimeout((d, off, len, cb) => {
      sftp.open(d, 'r', (e, handle) => {
        if (e) return cb(e)
        const buf = Buffer.alloc(len)
        sftp.read(handle, buf, 0, len, off, (e2, bytesRead, data) => {
          sftp.close(handle, () => {})
          if (e2) return cb(e2)
          cb(null, Buffer.isBuffer(data) ? data.subarray(0, bytesRead) : buf.subarray(0, bytesRead))
        })
      })
    })(P(p), offset, length),
  }
}
