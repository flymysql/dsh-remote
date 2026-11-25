// Sidebar file routes: /ls /read /write /fs.
//
// Machine-scoped callers (workspace picker, settings) omit sessionId and use
// the active-machine pool. Session-scoped callers (explorer / file tab) MUST
// pass sessionId (or local=mirror cwd); those requests resolve through the
// same mirror binding as rw_* tools and never fall back to the active machine.
// URLSearchParams already decodes query paths. Another decoding pass corrupts
// literal percent characters and names containing sequences such as `%2F`.
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { mirrorDownloadTarget, assertDownloadHasNoSymlinks } from './mirror-paths.js'
export { mirrorDownloadTarget } from './mirror-paths.js'
import { createLocalCopyRoutes, localCopyInfo } from './local-copy.js'
import {
  normalizeRemotePath, joinRemotePath, remoteDirname, mkdirRemoteDirs, toDisplayPath,
} from './paths.js'
import { requestSessionHint } from './binding.js'
import { captureRemoteFile, atomicRemoteWrite, remoteRevision, missingRemoteFile } from './remote-write.js'
import { listDirStructured, listRemoteDrives, removeRemoteTree, previewRemoteFile } from './remote-fs.js'

/**
 * RFC 6266/5987 attachment header: an ASCII fallback plus the UTF-8 name, so a
 * file called `报告 2026.pdf` keeps its name in every browser while a quote or a
 * CR/LF inside the path can never break out of the header.
 */
function contentDisposition(name) {
  const raw = String(name || 'download')
  const ascii = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(raw).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** Resolve once the response can take more bytes, or reject when the client left. */
function responseDrained(res) {
  return new Promise((resolve, reject) => {
    const done = (err) => {
      res.removeListener('drain', ok)
      res.removeListener('close', closed)
      res.removeListener('error', fail)
      if (err) reject(err)
      else resolve()
    }
    const ok = () => done()
    const closed = () => done(Object.assign(new Error('download aborted by the client'), { code: 'CLIENT_GONE' }))
    const fail = (err) => done(err)
    res.once('drain', ok)
    res.once('close', closed)
    res.once('error', fail)
  })
}

/**
 * Copy a remote (or local-workspace) file into the HTTP response.
 *
 * The SFTP surface exposes no read stream, and buffering the file would hold up
 * to `maxFileBytes` in the host's memory per click, so read and write in 1 MiB
 * steps and honour backpressure.
 */
async function streamFileToResponse(sftp, remotePath, size, res) {
  const CHUNK = 1024 * 1024
  if (typeof sftp.readPartial !== 'function') {
    // Surface without bounded reads (tests, older adapters): one full read is
    // still better than fastGet, which would park the bytes on the host's disk.
    const buf = await sftp.readFile(remotePath)
    if (buf && buf.length) res.write(buf)
    res.end()
    return
  }
  let offset = 0
  while (offset < size) {
    const buf = await sftp.readPartial(remotePath, offset, Math.min(CHUNK, size - offset))
    if (!buf || !buf.length) break
    offset += buf.length
    if (!res.write(buf)) await responseDrained(res)
  }
  res.end()
}

export function createFsRoutes({
  sendJson,
  readBody,
  resolveRequestBinding,
  decodeBuf,
  encodeText,
  audit,
  config,
  mirrorDirFor,
  onRemoteMutation = () => {},
  openLocalPath,
  mirrorRoot,
}) {
  const bindOrReply = async (req, res, body = {}) => {
    try {
      return await resolveRequestBinding(req, body)
    } catch (err) {
      sendJson(res, (err && err.httpStatus) || 500, { ok: false, error: String((err && err.message) || err) })
      return null
    }
  }

  const checkExpectedRevision = (body, snapshot, local = false) => {
    if (body.expectedRevision != null) {
      if (typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRevision)) {
        throw Object.assign(new Error('expectedRevision must be a SHA-256 revision returned by a complete file preview'), { httpStatus: 400 })
      }
      if (!snapshot.stat || !snapshot.bytes || remoteRevision(snapshot.bytes) !== body.expectedRevision) {
        throw Object.assign(new Error(local ? '本地文件已变化，已放弃保存。请重新读取并比较后重试。' : '远端文件已变化，已放弃保存。请重新读取并比较后重试。'), { httpStatus: 409, code: 'REMOTE_FILE_CONFLICT' })
      }
    }
    if (body.expectedMtime != null) {
      if (!Number.isFinite(Number(body.expectedMtime))) throw Object.assign(new Error('expectedMtime must be a finite timestamp'), { httpStatus: 400 })
      if (!snapshot.stat || snapshot.stat.mtime !== Number(body.expectedMtime)) {
        throw Object.assign(new Error(local ? '本地文件已变化，已放弃保存。请重新读取并比较后重试。' : '远端文件已变化，已放弃保存。请重新读取并比较后重试。'), { httpStatus: 409, code: 'REMOTE_FILE_CONFLICT' })
      }
    }
  }

  return [
    ...createLocalCopyRoutes({ sendJson, readBody, resolveRequestBinding, config, audit, onRemoteMutation }),
    {
      kind: 'exact',
      path: '/dsh-remote/ls',
      handler: async (req, res) => {
        try {
          // A POST body counts. This route used to read the session hint from the
          // QUERY STRING only, so `POST /ls {sessionId}` silently listed the ACTIVE
          // machine instead of the caller's — the wrong-host hazard issue #25 is
          // about, reachable through the API even though the browser always uses
          // GET. `/read`, `/write` and `/fs` already honoured the body; now this one
          // does too, and `path` may come from either place.
          let body = {}
          if (req.method === 'POST') {
            try { body = JSON.parse((await readBody(req)) || '{}') } catch { body = {} }
          }
          const hint = requestSessionHint(req, body)
          const b = await bindOrReply(req, res, { ...body, ...hint })
          if (!b) return
          // Identity echo (external-switch defense): name the machine this
          // listing is answered for, straight from the pool's target — the
          // picker validates every listing against the machine it INTENDED and
          // re-switches on mismatch (the settings page can change the active
          // machine under a memoized picker).
          const tgt = (b.pool && b.pool.config) || {}
          const machine = {
            host: String(tgt.host || b.host || ''),
            port: Number(tgt.port) || Number(b.port) || 22,
            username: String(tgt.username || b.username || ''),
          }
          await b.pool.detect()
          const q = new URL(req.url, 'http://localhost').searchParams
          const raw = q.get('path')
            ? q.get('path')
            : (body.path ? String(body.path) : (b.ws || ''))
          const canon = normalizeRemotePath(raw)
          const win = b.pool.platform === 'windows'
          if (!b.local && (canon === '/' || raw === '' || raw === '/')) {
            if (win || b.pool.platform !== 'posix') {
              const drives = await listRemoteDrives(b.pool)
              if (drives.length) return sendJson(res, 200, { path: '', platform: 'windows', items: drives, bound: b.bound, machine })
            }
            if (win) return sendJson(res, 200, { path: '', platform: 'windows', items: [], bound: b.bound, machine })
          }
          const sftp = await b.pool.sftp()
          const out = await listDirStructured(sftp, canon)
          const items = out.items.map((it) => ({
            ...it,
            path: toDisplayPath(joinRemotePath(canon, it.name), b.pool.platform),
          }))
          return sendJson(res, 200, {
            path: toDisplayPath(out.path, b.pool.platform),
            platform: win ? 'windows' : 'posix',
            items,
            missing: !!out.missing,
            bound: b.bound,
            machine,
          })
        } catch (err) {
          return sendJson(res, err.httpStatus || 500, { error: String((err && err.message) || err) })
        }
      },
    },
    {
      // Bytes for the machine running the BROWSER, not for the harness host.
      //
      // `fs op=download` writes the file into the DSH host's local mirror, which
      // is the wrong machine as soon as the page is opened from another desktop:
      // the file lands next to the harness and the browser is handed a path. This
      // route answers the bytes themselves — GET, so the browser's own download
      // manager owns progress, resume and cancel.
      //
      // The binding is the usual session one (query `sessionId`, plus
      // `workspace=local` for a local workspace) and resolveWorkbenchBinding
      // fences this route like /read, so a click in one session's explorer can
      // never pull a file from another session's host, nor read outside a local
      // workspace's root.
      kind: 'exact',
      path: '/dsh-remote/download',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        let streaming = false
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          const requested = q.get('path') || ''
          if (!requested) return sendJson(res, 400, { ok: false, error: 'path is required' })
          const b = await bindOrReply(req, res, {})
          if (!b) return
          const p = normalizeRemotePath(requested)
          if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path is required' })
          const sftp = await b.pool.sftp()
          const st = await sftp.stat(p).catch((error) => {
            if (missingRemoteFile(error)) return null
            throw error
          })
          if (!st) return sendJson(res, 404, { ok: false, error: 'not found' })
          if (st.isDirectory?.()) return sendJson(res, 400, { ok: false, error: 'download requires a file' })
          const size = Number(st.size) || 0
          if (config.maxFileBytes > 0 && size > config.maxFileBytes) {
            return sendJson(res, 400, { ok: false, error: `file is ${size} bytes (over ${config.maxFileBytes} cap)` })
          }
          const name = String(p).split(/[\\/]/).filter(Boolean).pop() || 'download'
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader('Content-Disposition', contentDisposition(name))
          res.setHeader('Content-Length', String(size))
          res.setHeader('Cache-Control', 'no-store')
          // Read by the UI to name the saved file: Content-Disposition parsing
          // differs per browser, a plain field does not.
          res.setHeader('X-Dsh-Download-Name', encodeURIComponent(name))
          if (!b.local) audit('download', `download ${p} (to browser)`, 0, b)
          streaming = true
          await streamFileToResponse(sftp, p, size, res)
        } catch (err) {
          if (streaming) { try { res.destroy(err) } catch { /* already gone */ } return }
          return sendJson(res, err.httpStatus || 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/read',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const q = new URL(req.url, 'http://localhost').searchParams
          let p = q.get('path') ? q.get('path') : ''
          let encoding = ''
          let maxBytes = 256 * 1024
          let body = {}
          if (req.method === 'POST') {
            body = JSON.parse((await readBody(req)) || '{}')
            if (!p) p = String(body.path || '')
            if (body.encoding) encoding = String(body.encoding)
            if (body.maxBytes) maxBytes = Number(body.maxBytes)
          }
          if (q.get('maxBytes')) maxBytes = Number(q.get('maxBytes'))
          if (!p) return sendJson(res, 400, { ok: false, error: 'path is required' })
          const b = await bindOrReply(req, res, body)
          if (!b) return
          const target = normalizeRemotePath(p)
          let sftp
          try {
            sftp = await b.pool.sftp()
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: 'sftp unavailable: ' + ((err && err.message) || err) })
          }
          try {
            const preview = await previewRemoteFile(sftp, target, {
              maxBytes,
              encoding: encoding || config.encoding,
              decodeBuf,
            })
            return sendJson(res, 200, preview)
          } catch (err) {
            if (missingRemoteFile(err)) {
              if (b.local) return sendJson(res, 404, { ok: false, source: 'local', path: target, code: 'LOCAL_FILE_NOT_FOUND', error: '本地项目中不存在此文件。' })
              const localCopy = await localCopyInfo(b, target)
              return sendJson(res, 404, { ok: false, source: 'remote', path: target,
                code: localCopy ? 'REMOTE_FILE_MISSING_LOCAL_COPY' : 'REMOTE_FILE_NOT_FOUND',
                error: localCopy ? '远端不存在此文件。本地镜像有同名副本，但尚未确认上传；可只读查看后显式上传。' : '远端不存在此文件。',
                ...(localCopy ? { localCopy } : {}),
              })
            }
            return sendJson(res, err.httpStatus || 500, { ok: false, error: 'read failed: ' + ((err && err.message) || err) })
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/write',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const p = normalizeRemotePath(String(body.path || ''))
          if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path is required' })
          const b = await bindOrReply(req, res, body)
          if (!b) return
          const sftp = await b.pool.sftp()
          const before = await captureRemoteFile(sftp, p, { read: body.expectedRevision != null, maxReadBytes: 2 * 1024 * 1024 })
          checkExpectedRevision(body, before, b.local)
          const buf = encodeText(String(body.content ?? ''), body.encoding || config.encoding)
          if (!before.stat) await mkdirRemoteDirs(sftp, remoteDirname(p))
          await atomicRemoteWrite(sftp, before, buf)
          if (!b.local) audit('write', `write ${p}`, 0, b)
          if (!b.local) onRemoteMutation()
          const st2 = await sftp.stat(p).catch(() => null)
          return sendJson(res, 200, { ok: true, bytes: buf.byteLength, mtime: st2 ? st2.mtime : Math.floor(Date.now() / 1000), revision: remoteRevision(buf) })
        } catch (err) {
          return sendJson(res, err.httpStatus || 500, { ok: false, error: String((err && err.message) || err), ...(err.code ? { code: err.code } : {}) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/fs',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const op = String(body.op || '')
          const b = await bindOrReply(req, res, body)
          if (!b) return
          if (b.local && op === 'download') return sendJson(res, 400, { ok: false, error: 'Local files are already on this host; no mirror download is needed' })
          if (op === 'revealLocal') {
            // Issue #207: "download to local mirror" used to end in a file the
            // user could not find — no path picker is involved by design, and
            // the explorer discarded the response entirely. The UI now offers
            // "show in folder", backed by this op. The target is ALWAYS fenced
            // to the plugin's own mirror tree; arbitrary local paths are
            // refused (this is not a file launcher).
            if (typeof openLocalPath !== 'function' || typeof mirrorRoot !== 'function') {
              return sendJson(res, 501, { ok: false, error: 'reveal is not available on this host' })
            }
            const resolved = path.resolve(String(body.path || ''))
            const rootDir = path.resolve(mirrorRoot())
            if (!resolved.startsWith(rootDir + path.sep)) {
              return sendJson(res, 400, { ok: false, error: 'revealLocal only accepts paths inside the local mirror tree' })
            }
            if (!existsSync(resolved)) return sendJson(res, 404, { ok: false, error: 'not found' })
            const r = await openLocalPath(resolved, 'reveal')
            if (!r.ok) return sendJson(res, r.httpStatus || 500, { ok: false, error: r.error, path: resolved })
            return sendJson(res, 200, { ok: true, path: resolved, how: r.how })
          }
          const sftp = await b.pool.sftp()
          if (op === 'mkdir') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            if (b.local) await b.pool.mkdirTree(p)
            else await mkdirRemoteDirs(sftp, p)
            if (!b.local) audit('mkdir', `mkdir ${p}`, 0, b)
            if (!b.local) onRemoteMutation()
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'rename') {
            const p = normalizeRemotePath(String(body.path || ''))
            const d = normalizeRemotePath(String(body.dest || ''))
            if (!p || !d) return sendJson(res, 400, { ok: false, error: 'path and dest required' })
            await sftp.rename(p, d)
            if (!b.local) audit('move', `move ${p} → ${d}`, 0, b)
            if (!b.local) onRemoteMutation()
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'remove') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            const st = await sftp.stat(p).catch(() => null)
            if (!st) return sendJson(res, 404, { ok: false, error: 'not found' })
            if (st.isDirectory && st.isDirectory()) {
              if (b.local) await b.pool.removeTree(p)
              else await removeRemoteTree(sftp, p)
            } else {
              await sftp.unlink(p)
            }
            if (!b.local) audit('remove', `remove ${p}`, 0, b)
            if (!b.local) onRemoteMutation()
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'write' || op === 'append') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            const before = await captureRemoteFile(sftp, p, {
              read: op === 'append' || body.expectedRevision != null,
              maxReadBytes: config.maxFileBytes > 0 ? Math.min(config.maxFileBytes, 2 * 1024 * 1024) : 2 * 1024 * 1024,
            })
            checkExpectedRevision(body, before, b.local)
            const content = op === 'append' && before.bytes ? decodeBuf(before.bytes, body.encoding || config.encoding) : ''
            const buf = encodeText(content + String(body.content ?? ''), body.encoding || config.encoding)
            if (op === 'write' && !before.stat) await mkdirRemoteDirs(sftp, remoteDirname(p))
            await atomicRemoteWrite(sftp, before, buf)
            if (!b.local) audit(op, `${op} ${p}`, 0, b)
            if (!b.local) onRemoteMutation()
            return sendJson(res, 200, { ok: true, bytes: buf.byteLength, revision: remoteRevision(buf) })
          }
          if (op === 'download') {
            const p = normalizeRemotePath(String(body.path || ''))
            const ws = b.ws
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            if (!ws) return sendJson(res, 400, { ok: false, error: 'no remote workspace set' })
            const base = b.mirrorDir || mirrorDirFor(ws, b.host, b.username, b.port)
            const local = mirrorDownloadTarget(base, ws, p)
            const st = await sftp.stat(p).catch(error => { if (missingRemoteFile(error)) return null; throw error })
            if (!st) return sendJson(res, 404, { ok: false, error: 'not found' })
            if (st.isDirectory?.()) return sendJson(res, 400, { ok: false, error: 'download requires a file' })
            if (config.maxFileBytes > 0 && st.size > config.maxFileBytes) {
              return sendJson(res, 400, { ok: false, error: `file is ${st.size} bytes (over ${config.maxFileBytes} cap)` })
            }
            assertDownloadHasNoSymlinks(base, local)
            mkdirSync(path.dirname(local), { recursive: true })
            await sftp.fastGet(p, local)
            if (!b.local) audit('download', `download ${p}`, 0, b)
            return sendJson(res, 200, { ok: true, bytes: st.size, local })
          }
          return sendJson(res, 400, { ok: false, error: 'unknown op' })
        } catch (err) {
          return sendJson(res, err.httpStatus || 500, { ok: false, error: String((err && err.message) || err), ...(err.code ? { code: err.code } : {}) })
        }
      },
    },
  ]
}
