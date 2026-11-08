// Self-update routes: /update-check /update-apply /update-reload /update-mode.
//
// Extracted from lib/index.js (issue #82: the god-file split). Handler bodies
// moved VERBATIM; the mechanism lives in ./update.js, this file only adapts the
// HTTP surface to it. Dependencies that belong to the plugin entry (config,
// the loader handle, the default-mode constant) arrive as `deps`.
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  applyUpdate,
  diskVersion,
  fetchLatestVersion,
  gtVersion,
  isInstalledCopy,
  lastSelfReload,
  LOADED_VERSION,
  persistUpdateMode,
  readUpdateMode,
  scheduleSelfReload,
  selfDir,
} from './update.js'

/**
 * @param {object} deps
 * @param {(res: object, status: number, body: object) => void} deps.sendJson
 * @param {(req: object) => Promise<string>} deps.readBody
 * @param {object} deps.config - validated plugin Config.
 * @param {object} deps.loader - `ctx.loader`, for the hot-swap scheduling.
 * @param {string} deps.defaultUpdateMode - DEFAULT_UPDATE_MODE from the entry.
 * @returns {Array<object>} route descriptors for registerHttpTransports.
 */
export function createUpdateRoutes({ sendJson, readBody, config, loader, defaultUpdateMode }) {
  return [
    {
      kind: 'exact',
      path: '/dsh-remote/update-check',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // `loaded` is the code actually running; `disk` may already be newer.
        // They differ between an applied update and its hot swap (or a boot).
        const loaded = LOADED_VERSION
        const disk = diskVersion()
        // Three-layer precedence: the persisted `update-mode` override (settings
        // UI) beats the profile config, which beats DEFAULT_UPDATE_MODE. The
        // fallback must not hard-code a second default here, or this path would
        // silently disagree with the schema default.
        const rawMode = readUpdateMode() || config.updateMode || defaultUpdateMode
        const base = {
          current: loaded,
          loaded,
          disk,
          pendingReload: gtVersion(disk, loaded),
          updateMode: ['manual', 'auto', 'off'].includes(rawMode) ? rawMode : defaultUpdateMode,
          updatedMarker: existsSync(path.join(selfDir(), '.dsh-remote-updated')),
          // Exposed so the settings page can explain why `auto` may not act:
          // a link:/dev install must not be overwritten by an npm publish.
          selfUpdateAllowed: isInstalledCopy(),
          // Outcome of the last hot-swap attempt (null if never tried). Without
          // this the swap could fail forever while the panel kept saying a
          // reload was merely pending — which is exactly what happened.
          lastReload: lastSelfReload(),
        }
        const probe = await fetchLatestVersion()
        // 即使查不到最新版，也把**本地状态**照常返回（ok:true），只把 registry
        // 的失败原因放在 registryError 里。
        //
        // 为什么：原先 registry 失败时整条响应 ok:false，客户端遇到 !ok 就只设错误
        // 文案、不 setUpd，于是面板永远停在「版本信息加载中…」——看起来像卡死，
        // 而实际上本地版本、更新模式、是否允许自更新都是已知的，完全可以展示。
        if (probe.error) {
          return sendJson(res, 200, { ok: true, ...base, latest: null, updateAvailable: false, registryError: probe.error, registryReason: probe.reason })
        }
        return sendJson(res, 200, {
          ok: true,
          ...base,
          latest: probe.version,
          updateAvailable: gtVersion(probe.version, loaded),
        })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-apply',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          // Capture the outgoing version BEFORE the swap: reading it afterwards
          // reports the version we just installed, not the one we replaced.
          const from = diskVersion()
          const loaded = LOADED_VERSION
          const body = JSON.parse((await readBody(req)) || '{}')
          const target = String(body.version || '')
          if (!target) return sendJson(res, 400, { ok: false, error: 'version is required' })
          const result = await applyUpdate(target)
          const wantReload = body.reload !== false && config.updateAutoReload !== false
          // Answer first, then swap: the swap disposes the fiber serving this
          // very request, so nothing may touch the plugin after it.
          if (wantReload) scheduleSelfReload(loader, 300)
          return sendJson(res, 200, {
            ok: true,
            from,
            loadedBefore: loaded,
            ...result,
            reloadScheduled: wantReload,
            // what the swap will land on, for a caller that wants to verify
            loadedAfterReload: wantReload ? result.to : loaded,
          })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-reload',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        // Hot-swap the host half to whatever is on disk now. Answers first (with
        // what was loaded and what it is about to become), then swaps.
        const loaded = LOADED_VERSION
        const disk = diskVersion()
        scheduleSelfReload(loader, 300)
        return sendJson(res, 200, { ok: true, scheduled: true, loaded, disk, willReloadTo: disk })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/update-mode',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = JSON.parse((await readBody(req)) || '{}')
          const mode = String(body.mode || '')
          if (!['manual', 'auto', 'off'].includes(mode)) return sendJson(res, 400, { ok: false, error: 'mode must be manual | auto | off' })
          if (!persistUpdateMode(mode)) return sendJson(res, 500, { ok: false, error: 'cannot persist mode' })
          return sendJson(res, 200, { ok: true, mode })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]
}
