// Sidebar file routes: /ls /read /write /fs.
//
// Machine-scoped callers (workspace picker, settings) omit sessionId and use
// the active-machine pool. Session-scoped callers (explorer / file tab) MUST
// pass sessionId (or local=mirror cwd); those requests resolve through the
// same mirror binding as rw_* tools and never fall back to the active machine.
// URLSearchParams already decodes query paths. Another decoding pass corrupts
// literal percent characters and names containing sequences such as `%2F`.
import { mkdirSync } from 'node:fs'
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
}) {
  const bindOrReply = async (req, res, body = {}) => {
    try {
      return await resolveRequestBinding(req, body)
    } catch (err) {
      sendJson(res, (err && err.httpStatus) || 500, { ok: false, error: String((err && err.message) || err) })
      return null
    }
  }

  const checkExpectedRevision = (body, snapshot) => {
    if (body.expectedRevision != null) {
      if (typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRevision)) {
        throw Object.assign(new Error('expectedRevision must be a SHA-256 revision returned by a complete file preview'), { httpStatus: 400 })
      }
      if (!snapshot.stat || !snapshot.bytes || remoteRevision(snapshot.bytes) !== body.expectedRevision) {
        throw Object.assign(new Error('远端文件已变化，已放弃保存。请重新读取并比较后重试。'), { httpStatus: 409, code: 'REMOTE_FILE_CONFLICT' })
      }
    }
    if (body.expectedMtime != null) {
      if (!Number.isFinite(Number(body.expectedMtime))) throw Object.assign(new Error('expectedMtime must be a finite timestamp'), { httpStatus: 400 })
      if (!snapshot.stat || snapshot.stat.mtime !== Number(body.expectedMtime)) {
        throw Object.assign(new Error('远端文件已变化，已放弃保存。请重新读取并比较后重试。'), { httpStatus: 409, code: 'REMOTE_FILE_CONFLICT' })
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
          const b = await bindOrReply(req, res, hint)
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
          if (canon === '/' || raw === '' || raw === '/') {
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
          return sendJson(res, 500, { error: String((err && err.message) || err) })
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
              const localCopy = await localCopyInfo(b, target)
              return sendJson(res, 404, { ok: false, source: 'remote', path: target,
                code: localCopy ? 'REMOTE_FILE_MISSING_LOCAL_COPY' : 'REMOTE_FILE_NOT_FOUND',
                error: localCopy ? '远端不存在此文件。本地镜像有同名副本，但尚未确认上传；可只读查看后显式上传。' : '远端不存在此文件。',
                ...(localCopy ? { localCopy } : {}),
              })
            }
            return sendJson(res, 500, { ok: false, error: 'read failed: ' + ((err && err.message) || err) })
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
          checkExpectedRevision(body, before)
          const buf = encodeText(String(body.content ?? ''), body.encoding || config.encoding)
          if (!before.stat) await mkdirRemoteDirs(sftp, remoteDirname(p))
          await atomicRemoteWrite(sftp, before, buf)
          audit('write', `write ${p}`, 0, b)
          onRemoteMutation()
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
          const sftp = await b.pool.sftp()
          if (op === 'mkdir') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            await mkdirRemoteDirs(sftp, p)
            audit('mkdir', `mkdir ${p}`, 0, b)
            onRemoteMutation()
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'rename') {
            const p = normalizeRemotePath(String(body.path || ''))
            const d = normalizeRemotePath(String(body.dest || ''))
            if (!p || !d) return sendJson(res, 400, { ok: false, error: 'path and dest required' })
            await sftp.rename(p, d)
            audit('move', `move ${p} → ${d}`, 0, b)
            onRemoteMutation()
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'remove') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            const st = await sftp.stat(p).catch(() => null)
            if (!st) return sendJson(res, 404, { ok: false, error: 'not found' })
            if (st.isDirectory && st.isDirectory()) {
              await removeRemoteTree(sftp, p)
            } else {
              await sftp.unlink(p)
            }
            audit('remove', `remove ${p}`, 0, b)
            onRemoteMutation()
            return sendJson(res, 200, { ok: true })
          }
          if (op === 'write' || op === 'append') {
            const p = normalizeRemotePath(String(body.path || ''))
            if (!p || p === '/') return sendJson(res, 400, { ok: false, error: 'path required' })
            const before = await captureRemoteFile(sftp, p, {
              read: op === 'append' || body.expectedRevision != null,
              maxReadBytes: config.maxFileBytes > 0 ? Math.min(config.maxFileBytes, 2 * 1024 * 1024) : 2 * 1024 * 1024,
            })
            checkExpectedRevision(body, before)
            const content = op === 'append' && before.bytes ? decodeBuf(before.bytes, body.encoding || config.encoding) : ''
            const buf = encodeText(content + String(body.content ?? ''), body.encoding || config.encoding)
            if (op === 'write' && !before.stat) await mkdirRemoteDirs(sftp, remoteDirname(p))
            await atomicRemoteWrite(sftp, before, buf)
            audit(op, `${op} ${p}`, 0, b)
            onRemoteMutation()
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
            audit('download', `download ${p}`, 0, b)
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
