// Mirror/connection routes: /connect /workspace /mirror /local-pick
// /local-list /local-mkdir /test-connect /current /forget-key /home.
//
// Extracted from lib/index.js (issue #82: the god-file split). Handler bodies
// moved VERBATIM. Pure helpers come straight from their leaf modules
// (paths/errors/hostkey); everything that closes over entry state — the active
// pool, the mirror registry writers, the machine-store plumbing shared with the
// in-process API — arrives as `deps`.
import { normalizeRemotePath } from './paths.js'
import { friendlyMessage } from './errors.js'
import { createHostKeyGuard } from './hostkey.js'

/**
 * @param {object} deps
 * @param {(res: object, status: number, body: object) => void} deps.sendJson
 * @param {(req: object) => Promise<string>} deps.readBody
 * @param {(raw: string) => object} deps.parseJsonObject - 400-throwing object parser.
 * @param {object} deps.config - validated plugin Config (MUTATED by setTarget flows).
 * @param {object} deps.pool - the ACTIVE machine pool (ActivePool facade).
 * @param {(m: object, cfg: object) => string} deps.backendFor - native vs openssh choice.
 * @param {() => object} deps.status - the entry's status snapshot.
 * @param {(p: string) => Promise<boolean>} deps.isRemoteDir
 * @param {(p: string) => void} deps.persistWorkspace
 * @param {(remotePath: string, host: string, user: string, port: number, extra?: object) => string} deps.ensureMirror
 * @param {(m: object) => string} deps.aliasOf
 * @param {() => object|null} deps.activeMachine
 * @param {(localDir: string) => void} deps.startAutoPush
 * @param {(body: object, res: object) => Promise<boolean>} deps.applyRequestedMachine - picker re-assertion (replies on mismatch).
 * @param {(localDir: string, remotePath: string, machine: object) => Promise<void>} deps.registerMirroredWorkspace
 * @param {() => Promise<object>} deps.localPickCapability - host picker backend probe.
 * @param {() => Promise<object>} deps.pickLocalNative - the OS dialog fallback.
 * @param {() => Array<object>} deps.listLocalDrives
 * @param {(body: object) => Promise<object>} deps.probeMachineRecord
 * @param {(id: string) => Promise<boolean>} deps.setCurrent
 * @param {() => string} deps.knownHostsFile
 * @returns {Array<object>} route descriptors for registerHttpTransports.
 */
export function createWorkspaceRoutes({ sendJson, readBody, parseJsonObject, config, pool, backendFor, status, isRemoteDir, persistWorkspace, ensureMirror, aliasOf, activeMachine, startAutoPush, applyRequestedMachine, registerMirroredWorkspace, localPickCapability, pickLocalNative, listLocalDrives, probeMachineRecord, setCurrent, knownHostsFile }) {
  return [
    {
      kind: 'exact',
      path: '/dsh-remote/connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        // Issue #30: `payload` is declared OUTSIDE the try block on purpose.
        // A `const payload` inside `try` is scoped to that block, so the catch
        // below used to throw `ReferenceError: payload is not defined` BEFORE
        // it could send anything — the webserver then turned the rejected
        // handler into an empty HTTP 400 and the real reason never reached the
        // UI. Hoisting it (and defaulting to {}) makes the failure path total:
        // this handler now always answers with JSON.
        let payload = {}
        try {
          payload = parseJsonObject(await readBody(req))
          // This route is a reconnect PROBE ("Connect" button): with the
          // unchanged-target no-op in setTarget, an identical target would
          // reuse a possibly half-open cached client and the probe could hang.
          // invalidate() is the design's forced-reconnect escape hatch — drop
          // the cached client so the `echo ok` below always re-dials.
          pool.invalidate()
          pool.setTarget({
            host: payload.host,
            port: payload.port,
            username: payload.username,
            password: payload.password !== undefined && payload.password !== '' ? payload.password : undefined,
            privateKeyPath: payload.privateKeyPath,
            workspace: payload.workspace,
            // A credential-less target — including an alias from ~/.ssh/config
            // whose Host block relies on OpenSSH's default keys — cannot connect
            // on native; dial it through the user's own ssh instead.
            backend: backendFor(payload, config),
          })
          await pool.exec('echo ok', { timeoutMs: Math.min(config.commandTimeoutMs, 8000) })
          return sendJson(res, 200, { ok: true, ...status() })
        } catch (err) {
          return sendJson(res, (err && err.httpStatus) || 500, { ok: false, error: friendlyMessage(err, { host: payload.host, port: payload.port }) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/workspace',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          // Blank-only guard: a filesystem root is a legal workspace (issue
          // #60); the real directory probe below answers everything else.
          const rawPath = String(payload.path || '').trim()
          if (!rawPath) return sendJson(res, 400, { error: 'path must be an absolute directory' })
          const p = normalizeRemotePath(rawPath)
          const okDir = await isRemoteDir(p)
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory: ${p}` })
          persistWorkspace(p)
          const local = ensureMirror(p, config.host, config.username, config.port, { alias: aliasOf(activeMachine()) })
          startAutoPush(local)
          return sendJson(res, 200, { ok: true, workspace: p, localMirror: local, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/mirror',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const payload = JSON.parse((await readBody(req)) || '{}')
          // Blank-only guard: a filesystem root is a legal workspace (issue
          // #60); the real directory probe below answers everything else.
          const rawPath = String(payload.path || '').trim()
          if (!rawPath) return sendJson(res, 400, { ok: false, error: 'path must be an absolute directory' })
          const p = normalizeRemotePath(rawPath)
          if (!config.host) return sendJson(res, 400, { ok: false, error: 'no remote host configured/connected — connect first' })
          // The picker names the machine it was browsing. Re-assert it so a
          // switch made elsewhere between the listing and this commit cannot
          // mirror onto a machine the user never looked at (the picker sends
          // /current only once per machine now, so nothing else re-applies it).
          if (!(await applyRequestedMachine(payload, res))) return
          const okDir = await isRemoteDir(p)
          if (!okDir) return sendJson(res, 400, { ok: false, error: `not a directory (or unreachable): ${p}` })
          const local = ensureMirror(p, config.host, config.username, config.port, { alias: aliasOf(activeMachine()) })
          persistWorkspace(p)
          startAutoPush(local)
          // The native "Add workspace" picker adopts the mirror right after this
          // response (`workspace.create({ path: localMirror })`). Registering it
          // here first is the only way to influence the title, because the core
          // Create API takes no title and would derive "xdfs" from the mirror's
          // last segment. Callers that only pick a folder (settings page, Remote
          // Files explorer) opt out with registerWorkspace:false, so no stray
          // workspace appears in their flow.
          if (payload.registerWorkspace !== false) await registerMirroredWorkspace(local, p, activeMachine())
          return sendJson(res, 200, { ok: true, path: p, localMirror: local, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-pick',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          let outcome = null
          let via = 'service'
          const cap = await localPickCapability()
          if (cap && cap.kind === 'native' && typeof cap.pick === 'function') {
            try {
              const pickAbort = new AbortController()
              const p = await Promise.resolve(cap.pick(pickAbort.signal || null))
              pickAbort.abort()
              outcome = (typeof p === 'string' && p) ? { path: p } : { cancelled: true }
            } catch (err) {
              outcome = null
            }
          }
          // Prefer a REAL OS dialog over the browse backend: operators expect
          // an Explorer-style chooser, and the own spawn (PowerShell
          // FolderBrowserDialog / osascript / zenity-kdialog) works even where
          // the host mounted browse — DSH Desktop (Electron) deliberately
          // mounts browse on win32 because the native backend's koffi dialog
          // worker cannot run under Electron, but a plain child process can.
          if (!outcome) {
            via = 'own'
            try {
              outcome = await pickLocalNative()
            } catch (err) {
              // No usable OS dialog (headless host, missing chooser binary):
              // fall back to the host's browse capability — fs-only, works
              // display-less — served as an in-app browser by the client
              // (backed by /dsh-remote/local-list + /dsh-remote/local-mkdir).
              if (cap && cap.kind === 'browse' && typeof cap.list === 'function') {
                return sendJson(res, 200, { ok: true, kind: 'browse', via: 'browse' })
              }
              return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) + ' — 可直接在输入框填本地路径' })
            }
          }
          if (outcome.cancelled) return sendJson(res, 200, { ok: true, cancelled: true, via })
          return sendJson(res, 200, { ok: true, path: outcome.path, via })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-list',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const cap = await localPickCapability()
          if (!cap || cap.kind !== 'browse' || typeof cap.list !== 'function') return sendJson(res, 400, { ok: false, error: '当前目录选择器不是浏览后端，无法列出本机目录' })
          const m = (req.url || '').match(/path=([^&]*)/)
          const raw = m ? decodeURIComponent(m[1]) : ''
          // No path → the browse backend lists the host home directory.
          try {
            const out = await Promise.resolve(cap.list(raw ? raw : undefined))
            return sendJson(res, 200, { ok: true, ...out, drives: listLocalDrives() })
          } catch (listErr) {
            return sendJson(res, 400, { ok: false, error: String((listErr && listErr.message) || listErr), code: (listErr && listErr.code) || 'directory-unreadable' })
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/local-mkdir',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const cap = await localPickCapability()
          if (!cap || cap.kind !== 'browse' || typeof cap.createDirectory !== 'function') return sendJson(res, 400, { ok: false, error: '当前目录选择器不是浏览后端，无法新建文件夹' })
          const payload = JSON.parse((await readBody(req)) || '{}')
          const p = String(payload.path || '')
          const name = String(payload.name || '')
          if (!p.trim() || !name.trim()) return sendJson(res, 400, { ok: false, error: 'path and name required' })
          try {
            const created = await Promise.resolve(cap.createDirectory(p, name))
            return sendJson(res, 200, { ok: true, path: created })
          } catch (mkErr) {
            return sendJson(res, 400, { ok: false, error: String((mkErr && mkErr.message) || mkErr), code: (mkErr && mkErr.code) || 'directory-create-failed' })
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/test-connect',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // Issue #30: `body` lives OUTSIDE the try — a try-scoped `const` is
        // invisible in catch, so the old catch threw `ReferenceError: body is
        // not defined` and the probe result never reached the UI (the webserver
        // answered with an empty 400 for every kind of failure). This route is a
        // probe: every outcome is a 200 carrying {ok:false, error}.
        let body = {}
        try {
          body = parseJsonObject(await readBody(req))
          return sendJson(res, 200, await probeMachineRecord(body))
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: friendlyMessage(err, { host: body.host, port: body.port }) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/current',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const id = String(body.id || '').trim()
          // Issue #13: an empty id is an explicit "active remote = none" —
          // saved machines stay in the registry but nothing is current.
          if (!id) {
            await setCurrent('')
            return sendJson(res, 200, { ok: true, currentId: null, ...status() })
          }
          const okSet = await setCurrent(id)
          if (!okSet) return sendJson(res, 404, { ok: false, error: 'machine not found' })
          return sendJson(res, 200, { ok: true, ...status() })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/forget-key',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        createHostKeyGuard(config, knownHostsFile()).forgetHost()
        return sendJson(res, 200, { ok: true, ...status() })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/home',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = parseJsonObject(await readBody(req))
          // The picker names the machine it is showing: re-assert it before
          // answering, so a switch made elsewhere cannot make /home describe a
          // different host than the tree the user is looking at.
          if (!(await applyRequestedMachine(body, res))) return
          const out = await pool.exec('echo ~', { timeoutMs: Math.min(config.commandTimeoutMs, 5000) })
          const home = String(out.stdout || '').replace(/\s+/g, '').trim()
          if (!home) return sendJson(res, 200, { ok: true, home: null, hint: 'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径' })
          return sendJson(res, 200, { ok: true, home })
        } catch (err) {
          // `ok:false` — reporting `ok:true` WITH an `error` is a contradiction:
          // any caller that trusts `ok` treats "could not resolve the home
          // directory" as success. The picker only reads `home`, so it still falls
          // back to `hint`/`error` exactly as before.
          return sendJson(res, 200, {
            ok: false,
            home: null,
            hint: 'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径',
            error: String((err && err.message) || err),
          })
        }
      },
    },
  ]
}
