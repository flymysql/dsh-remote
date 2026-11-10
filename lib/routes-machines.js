// Machine-registry routes: /machines (GET|POST) and /ssh-config.
//
// Extracted from lib/index.js (issue #82: the god-file split). Handler bodies
// moved VERBATIM; the record mechanics live in ./registry.js and ./sshconfig.js
// while the ENTRY owns the live store (machines array, current pointer) and the
// upsert/remove/probe orchestration closures — those arrive as `deps` because
// they are shared with the in-process API assembled in the entry.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { listAliases, sshConfigPath, readSshConfigText } from './sshconfig.js'

/**
 * @param {object} deps
 * @param {(res: object, status: number, body: object) => void} deps.sendJson
 * @param {(req: object) => Promise<string>} deps.readBody
 * @param {(raw: string) => object} deps.parseJsonObject - 400-throwing object parser.
 * @param {object} deps.store - machine-registry store (`currentId`).
 * @param {Array<object>} deps.machines - the LIVE registry array (shared reference).
 * @param {() => Array<object>} deps.machinesForClient - sanitized list view.
 * @param {(body: object) => Promise<object>} deps.upsertMachineRecord
 * @param {(id: string) => Promise<object>} deps.removeMachineRecord
 * @param {(id: string) => Promise<boolean>} deps.setCurrent
 * @param {(list: Array<object>, currentId: string|null, keepCurrentKey: boolean) => void} deps.saveMachines
 * @param {(m: object) => object} deps.sanitizeMachine
 * @param {() => string} deps.machineId - fresh record id.
 * @param {() => string} deps.sshConfigText - memoised ~/.ssh/config text.
 * @param {(m: object) => boolean} deps.nativeUsableCredential
 * @param {() => object} deps.status - the entry's status snapshot.
 * @param {(target: string, action?: 'open'|'reveal') => Promise<object>} deps.openLocalPath
 * @returns {Array<object>} route descriptors for registerHttpTransports.
 */
export function createMachineRoutes({ sendJson, readBody, parseJsonObject, store, machines, machinesForClient, upsertMachineRecord, removeMachineRecord, setCurrent, saveMachines, sanitizeMachine, machineId, sshConfigText, nativeUsableCredential, status, openLocalPath }) {
  return [
    {
      kind: 'exact',
      path: '/dsh-remote/machines',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          return sendJson(res, 200, { machines: machinesForClient(), currentId: store.currentId })
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}')
            const action = body.action || 'add'
            if (action === 'add' || action === 'update') {
              try {
                return sendJson(res, 200, { ok: true, ...(await upsertMachineRecord(body)) })
              } catch (err) {
                return sendJson(res, (err && err.httpStatus) || 500, { ok: false, error: String((err && err.message) || err) })
              }
            }
            // Issue #73: one click on a host listed from ~/.ssh/config. The settings
            // page no longer asks the user to understand "alias" vs "copy": it lists
            // the file's hosts and this action adopts one — upsert an alias machine
            // (never a duplicate), make it the current machine, and let the caller
            // connect/probe next. Nothing about the user's file is rewritten here:
            // the alias IS the source of truth (issue #50).
            if (action === 'from-ssh-config') {
              const alias = String(body.alias || body.host || '').trim()
              if (!alias) return sendJson(res, 400, { ok: false, error: 'alias required' })
              const known = listAliases(sshConfigText()).find((a) => a.alias === alias)
              if (!known) {
                return sendJson(res, 404, {
                  ok: false,
                  error: `~/.ssh/config 里没有 "${alias}"（改完文件后重新打开设置页即可刷新）`,
                })
              }
              const existing = machines.find((m) => m.useSshConfig && String(m.host) === alias)
              let rec = existing
              if (!rec) {
                rec = {
                  id: machineId(),
                  name: alias,
                  host: alias,
                  useSshConfig: true,
                  port: Number(known.port) || 22,
                  username: String(known.user || ''),
                  password: '',
                  privateKeyPath: '',
                  passphrase: '',
                  workspace: '',
                  hostKeyMode: '',
                  useAgent: false,
                  keyboardInteractive: false,
                  // ~/.ssh/config defines this machine, and the user's own `ssh`
                  // is what interprets that file (default identity discovery,
                  // agent/keychain, ProxyJump, GSSAPI). Native cannot see any of
                  // it, so a Host block with no IdentityFile would be reported as
                  // "no credentials".
                  backend: 'openssh',
                  sshBinary: '',
                  credentialBackend: 'plain',
                  recentWorkspaces: [],
                  lastConnectedAt: null,
                  latencyMs: null,
                }
                machines.push(rec)
                saveMachines(machines, store.currentId, false)
              } else if (String(rec.backend || 'native') !== 'openssh' && !nativeUsableCredential(rec)) {
                // A record adopted before this fix carries `native` with no
                // credential: upgrade it in place, so clicking Connect dials what
                // `ssh <alias>` already does.
                rec.backend = 'openssh'
                saveMachines(machines, store.currentId, false)
              }
              // Making it current is the whole point of the click: the picker and
              // every session route then act on this machine.
              const okSet = await setCurrent(rec.id)
              if (!okSet) return sendJson(res, 500, { ok: false, error: 'could not activate the machine' })
              return sendJson(res, 200, {
                ok: true,
                created: !existing,
                machine: sanitizeMachine(rec),
                machines: machinesForClient(),
                currentId: store.currentId,
                ...status(),
              })
            }
            if (action === 'delete') {
              try {
                return sendJson(res, 200, { ok: true, ...(await removeMachineRecord(String(body.id || ''))) })
              } catch (err) {
                return sendJson(res, (err && err.httpStatus) || 500, { ok: false, error: String((err && err.message) || err) })
              }
            }
            return sendJson(res, 400, { ok: false, error: 'unknown action' })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/dsh-remote/ssh-config',
      handler: async (req, res) => {
        // GET lists hosts. POST {action:'open'|'reveal'} opens THAT file on the
        // machine running DSH — the same affordance as the audit log. The path
        // is always sshConfigPath(); a path in the body is ignored, so this is
        // not a general file launcher.
        if (req.method === 'POST') {
          try {
            const body = parseJsonObject(await readBody(req))
            const action = String(body.action || '')
            if (action !== 'open' && action !== 'reveal') {
              return sendJson(res, 400, { ok: false, error: 'action must be open | reveal' })
            }
            const file = sshConfigPath()
            mkdirSync(path.dirname(file), { recursive: true })
            // Create an empty config so the editor has a file. Never truncate
            // one the user already wrote.
            if (!existsSync(file)) writeFileSync(file, '', { encoding: 'utf8', mode: 0o600 })
            const r = await openLocalPath(file, action)
            if (!r.ok) return sendJson(res, r.httpStatus || 500, { ok: false, error: r.error, file })
            return sendJson(res, 200, { ok: true, action, file, how: r.how })
          } catch (err) {
            return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
          }
        }
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const text = readSshConfigText()
          // Issue #73: the settings page lists the hosts of ~/.ssh/config the way
          // VSCode Remote-SSH does, so this must include EVERY concrete alias —
          // `importableEntries` filtered out a bare `Host mybox` with no options,
          // which is a perfectly normal entry to connect to. `host` is kept as an
          // alias of `alias` so existing callers keep working.
          const entries = listAliases(text).map((a) => ({
            host: a.alias,
            alias: a.alias,
            hostName: a.hostName || a.alias,
            user: a.user || '',
            port: Number(a.port) || 22,
            identityFile: a.identityFile || '',
            proxyJump: a.proxyJump || '',
            proxyCommand: a.proxyCommand || '',
          }))
          return sendJson(res, 200, { ok: true, file: sshConfigPath(), present: !!text, entries })
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]
}
