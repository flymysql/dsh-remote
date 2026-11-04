// Host-side in-process API (`ctx.dshRemote`) — contract tests (docs/tui.md §3).
//
// Two layers:
//  1. `createHostApi(deps)` with FAKE deps — proves the contract shaping on its
//     own (pure data, secret stripping, semantic error codes, subscribe), with
//     no plugin instance and no SSH.
//  2. The REAL plugin through test/harness/plugin-host.js — proves lib/index.js
//     wires the API to its one closure: machine CRUD reaches machines.json,
//     ensureRemoteWorkspace creates the local mirror + meta WITHOUT dialing,
//     and the workspace registry gets the host-qualified title.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHostApi } from '../lib/host-api.js'
import { resolveMirror } from '../lib/binding.js'
import { encodeSegment, projectKey } from '../lib/workspace-cleanup.js'
import { createHost, machine } from './harness/plugin-host.js'
import { MemFs, makeSftp, seed } from './helpers.js'

// ── helpers ────────────────────────────────────────────────────────────────

const SECRET_PASSWORD = 'Sup3r-Secret-Pa55'
const SECRET_PASSPHRASE = 'pp-Secret-42'

/** Minimal fake pool over the in-memory SFTP surface used by remote-fs tests. */
function fakePool(tree = {}, platform = 'posix') {
  const fs = new MemFs()
  seed(fs, tree)
  return {
    platform,
    config: { host: '10.0.0.9', port: 22, username: 'root' },
    async detect() { return platform },
    async sftp() { return makeSftp(fs) },
  }
}

function statusSnapshot(overrides = {}) {
  return {
    currentId: 'm-1',
    host: '10.0.0.9', port: 22, username: 'root',
    connected: false, workspace: '/srv/proj', localMirror: '',
    activeSource: 'machine', sessionMode: 'standby', sessionRemotePath: '',
    machines: [], hostKeyMode: 'off', hostKeyKnown: false,
    forwards: [], auditEnabled: false, backend: 'keychain', platform: 'posix',
    shell: 'native', gitBash: '',
    ...overrides,
  }
}

/** Fake `createHostApi` deps: every closure the real plugin supplies, backed by
 *  a tiny in-memory registry. Deliberately includes secrets in the records so
 *  the API's own scrubbing is what keeps them in. */
function fakeDeps({ dirOk = true, upsertExtra = {}, listDirPool = null } = {}) {
  const state = {
    machines: [{
      id: 'm-1', name: 'box', host: '10.0.0.9', port: 22, username: 'root',
      password: SECRET_PASSWORD, passphrase: SECRET_PASSPHRASE,
      privateKeyPath: '', credentialBackend: 'plain',
    }],
    currentId: 'm-1',
    ensured: [],
    registered: [],
    connectCalls: [],
    currentCalls: [],
  }
  const deps = {
    listMachinesView: () => ({ machines: state.machines, currentId: state.currentId }),
    upsertMachineRecord: async (body) => {
      const rec = { id: body.id || 'm-new', ...body }
      const i = state.machines.findIndex((m) => m.id === rec.id)
      if (i >= 0) state.machines[i] = { ...state.machines[i], ...rec }
      else state.machines.push(rec)
      return { machine: rec, machines: state.machines, currentId: state.currentId, ...upsertExtra }
    },
    removeMachineRecord: async (id) => {
      const i = state.machines.findIndex((m) => m.id === id)
      if (i < 0) { const e = new Error('machine not found'); e.code = 'MACHINE_NOT_FOUND'; throw e }
      state.machines.splice(i, 1)
      if (state.currentId === id) state.currentId = null
      return { machines: state.machines, currentId: state.currentId }
    },
    setCurrentForApi: async (id) => {
      if (id && !state.machines.some((m) => m.id === id)) {
        const e = new Error(`machine not found: ${id}`); e.code = 'MACHINE_NOT_FOUND'; throw e
      }
      state.currentCalls.push(id)
      state.currentId = id
    },
    connectMachine: async (opts) => {
      state.connectCalls.push(opts)
      return statusSnapshot({ currentId: state.currentId, connected: true })
    },
    probeMachineRecord: async (body) => ({
      ok: true, host: String(body.host || ''), user: 'root', latencyMs: 12,
      platform: 'posix', shell: 'native', usedSavedCredential: false,
    }),
    statusSnapshot: () => statusSnapshot({ currentId: state.currentId }),
    resolveDirBinding: async () => ({
      pool: listDirPool || fakePool({ '/srv/proj/README.md': 'hi', '/srv/proj/sub/a.txt': 'x' }),
      ws: '/srv/proj',
      bound: false,
      machine: { id: 'm-1', name: 'box', host: '10.0.0.9', port: 22, username: 'root' },
    }),
    listRemoteProjects: () => [{
      dir: '/mirrors/10.0.0.9-proj', host: '10.0.0.9', port: 22, username: 'root',
      remotePath: '/srv/proj', alias: 'boxalias', name: 'box', machineId: 'm-1',
    }],
    resolveMachine: (id) => {
      const rec = id
        ? state.machines.find((m) => m.id === id)
        : state.machines.find((m) => m.id === state.currentId)
      if (!rec) {
        const e = new Error(id ? `machine not found: ${id}` : '当前没有活动远程机')
        e.code = id ? 'MACHINE_NOT_FOUND' : 'NO_ACTIVE_MACHINE'
        throw e
      }
      return {
        record: rec, machineId: rec.id, name: rec.name || rec.host,
        host: rec.host, port: rec.port, username: rec.username, alias: '',
      }
    },
    ensureMirror: (remotePath, host, username, port) => {
      const base = String(remotePath).split('/').filter(Boolean).pop() || 'workspace'
      const dir = `/mirrors/${host}-${username}-${port}/${base}`
      state.ensured.push({ remotePath, host, username, port, dir })
      return dir
    },
    registerMirroredWorkspace: async (localDir, remotePath, record) => {
      const base = String(remotePath).split('/').filter(Boolean).pop() || 'workspace'
      const title = `${record.name}-${base}`
      state.registered.push({ localDir, remotePath, recordId: record.id, title })
      return { id: 'w-1', title }
    },
    checkRemoteDir: async () => dirOk,
  }
  return { api: createHostApi(deps), deps, state }
}

function assertNoSecrets(label, value) {
  const text = JSON.stringify(value)
  for (const [what, secret] of [['password', SECRET_PASSWORD], ['passphrase', SECRET_PASSPHRASE]]) {
    assert.equal(text.includes(secret), false, `${label} leaked the ${what}: ${text.slice(0, 400)}`)
  }
  assert.doesNotMatch(text, /"(password|passphrase)"\s*:/, `${label} exposed a raw secret field: ${text.slice(0, 400)}`)
}

/** Fake `ctx.workspaceRegistry` (the real one is a dsh-workspace service). */
function fakeWorkspaceRegistry() {
  const workspaces = []
  return {
    workspaces,
    async resolveByPath(p) { return workspaces.find((w) => w.path === p) || null },
    list: () => workspaces.map((w) => ({ id: w.id, title: w.title })),
    async create(workspacePath, title) {
      const w = { id: `w-${workspaces.length + 1}`, path: workspacePath, title }
      workspaces.push(w)
      return { id: w.id, title: w.title }
    },
  }
}

// ── 1. contract shaping with fake deps ─────────────────────────────────────

test('apiVersion is 1 and every contract method is present and async', () => {
  const { api } = fakeDeps()
  assert.equal(api.apiVersion, 1)
  for (const name of [
    'listMachines', 'upsertMachine', 'removeMachine', 'setCurrent', 'connect',
    'probeMachine', 'status', 'listDir', 'listRemoteProjects',
    'ensureRemoteWorkspace', 'pickRemoteWorkspace',
    'listWorkspaceMirrors', 'deleteWorkspaceSessions', 'deleteRemoteWorkspace', 'forgetWorkspaceRecent',
  ]) {
    assert.equal(typeof api[name], 'function', `${name} must be a function`)
    assert.equal(api[name].constructor.name, 'AsyncFunction', `${name} must be async`)
  }
  assert.equal(typeof api.subscribe, 'function')
})

test('listMachines strips password/passphrase (also from a raw deps result) and echoes currentId', async () => {
  const { api } = fakeDeps()
  const res = await api.listMachines()
  assert.equal(res.currentId, 'm-1')
  assert.equal(res.machines.length, 1)
  assert.equal(res.machines[0].id, 'm-1')
  assertNoSecrets('listMachines', res)
})

test('upsertMachine scrubs the record and collects non-fatal warnings', async () => {
  const { api, state } = fakeDeps({
    upsertExtra: {
      warning: 'secret-store-refused',
      warningDetail: 'keychain unavailable',
      sshConfigWarning: '~/.ssh/config already names "box"',
    },
  })
  const res = await api.upsertMachine({ name: 'box', host: '10.0.0.10', username: 'dev' })
  assert.equal(res.machine.host, '10.0.0.10')
  assert.equal(res.currentId, 'm-1')
  assert.equal(state.machines.length, 2)
  assert.deepEqual(res.warnings, [
    'secret-store-refused: keychain unavailable',
    '~/.ssh/config already names "box"',
  ])
  assertNoSecrets('upsertMachine', res)
})

test('removeMachine returns the new list and throws MACHINE_NOT_FOUND for an unknown id', async () => {
  const { api, state } = fakeDeps()
  const res = await api.removeMachine('m-1')
  assert.equal(res.currentId, null)
  assert.deepEqual(res.machines, [])
  assert.equal(state.machines.length, 0)
  await assert.rejects(api.removeMachine('m-1'), (err) => {
    assert.equal(err.code, 'MACHINE_NOT_FOUND')
    return true
  })
})

test('setCurrent maps coded deps failures and returns Status with machineId', async () => {
  const { api, state } = fakeDeps()
  await assert.rejects(api.setCurrent('m-nope'), (err) => err.code === 'MACHINE_NOT_FOUND')
  const status = await api.setCurrent('m-1')
  assert.equal(status.machineId, 'm-1')
  assert.equal(state.currentCalls.at(-1), 'm-1')
  const cleared = await api.setCurrent(null)
  assert.equal(cleared.machineId, null)
  assert.equal(state.currentCalls.at(-1), null)
})

test('connect forwards persist:false and returns Status', async () => {
  const { api, state } = fakeDeps()
  const status = await api.connect({ machineId: 'm-1', persist: false })
  assert.equal(status.connected, true)
  assert.equal(status.machineId, 'm-1')
  assert.deepEqual(state.connectCalls, [{ machineId: 'm-1', persist: false }])
})

test('probeMachine returns the probe result; network failures get a semantic code', async () => {
  const { api, deps } = fakeDeps()
  const ok = await api.probeMachine({ host: '10.0.0.9', username: 'root' })
  assert.equal(ok.ok, true)
  assert.equal(ok.host, '10.0.0.9')

  deps.probeMachineRecord = async () => { throw new Error('connect ECONNREFUSED 10.0.0.9:22') }
  const failing = createHostApi(deps)
  await assert.rejects(failing.probeMachine({ host: '10.0.0.9', port: 22 }), (err) => {
    assert.equal(err.code, 'NETWORK')
    assert.match(err.message, /连接被拒绝/)
    return true
  })
})

test('listDir returns the contract listing (path/parent/items/machine) over the SFTP surface', async () => {
  const { api } = fakeDeps()
  const listing = await api.listDir({ path: '/srv/proj' })
  assert.equal(listing.path, '/srv/proj')
  assert.equal(listing.parent, '/srv')
  assert.equal(listing.platform, 'posix')
  assert.deepEqual(
    listing.items.map((i) => [i.name, i.type]).sort(),
    [['README.md', 'file'], ['sub', 'dir']],
  )
  const readme = listing.items.find((i) => i.name === 'README.md')
  assert.equal(readme.path, '/srv/proj/README.md')
  assert.equal(typeof readme.size, 'number')
  assert.equal(typeof readme.mtime, 'number')
  assert.deepEqual(listing.machine, { id: 'm-1', name: 'box', host: '10.0.0.9', port: 22, username: 'root' })
  // Root listing reports a null parent rather than a self-referencing "/".
  const root = await api.listDir({ path: '/' })
  assert.equal(root.parent, null)
})

test('listDir maps pool failures to NETWORK and coded binding errors pass through', async () => {
  const brokenPool = {
    platform: 'posix',
    config: {},
    async detect() { return 'posix' },
    async sftp() { throw new Error('connect ECONNREFUSED 10.0.0.9:22') },
  }
  const { api } = fakeDeps({ listDirPool: brokenPool })
  await assert.rejects(api.listDir({ path: '/srv' }), (err) => err.code === 'NETWORK')

  const { deps } = fakeDeps()
  deps.resolveDirBinding = async () => { const e = new Error('machine not found: m-x'); e.code = 'MACHINE_NOT_FOUND'; throw e }
  await assert.rejects(createHostApi(deps).listDir({ machineId: 'm-x' }), (err) => err.code === 'MACHINE_NOT_FOUND')
})

test('listRemoteProjects is pure data (no handles) and defaults alias/name', async () => {
  const { api } = fakeDeps()
  const projects = await api.listRemoteProjects()
  assert.deepEqual(projects, [{
    dir: '/mirrors/10.0.0.9-proj', host: '10.0.0.9', port: 22, username: 'root',
    remotePath: '/srv/proj', alias: 'boxalias', name: 'box', machineId: 'm-1',
  }])
  // JSON-serialisable: the API hands out no live objects.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(projects)))
})

test('ensureRemoteWorkspace builds the mirror + meta-less title and optionally registers', async () => {
  const { api, state } = fakeDeps()
  const res = await api.ensureRemoteWorkspace({ remotePath: '/srv/proj' })
  assert.deepEqual(res, {
    machineId: 'm-1', remotePath: '/srv/proj', localMirror: '/mirrors/10.0.0.9-root-22/proj', title: 'box-proj',
    workspace: { id: 'w-1', title: 'box-proj' },
  })
  assert.equal(state.ensured.length, 1)
  assert.equal(state.registered.length, 1)

  const unregistered = await api.ensureRemoteWorkspace({ remotePath: '/srv/other', register: false })
  assert.equal('workspace' in unregistered, false)
  assert.equal(state.registered.length, 1)
  await assert.rejects(api.ensureRemoteWorkspace({ remotePath: '   ' }), (err) => err.code === 'NOT_A_DIRECTORY')
})

test('pickRemoteWorkspace refuses a non-directory with NOT_A_DIRECTORY and does not mirror it', async () => {
  const { api, state } = fakeDeps({ dirOk: false })
  await assert.rejects(api.pickRemoteWorkspace({ remotePath: '/srv/not-a-dir' }), (err) => err.code === 'NOT_A_DIRECTORY')
  assert.equal(state.ensured.length, 0)
})

test('pickRemoteWorkspace validates then ensures and returns the fresh Status', async () => {
  const { api, state } = fakeDeps({ dirOk: true })
  const res = await api.pickRemoteWorkspace({ remotePath: '/srv/proj', registerWorkspace: false })
  assert.equal(res.remotePath, '/srv/proj')
  assert.equal(res.localMirror, '/mirrors/10.0.0.9-root-22/proj')
  assert.equal('workspace' in res, false)
  assert.equal(res.status.machineId, 'm-1')
  assert.equal(state.ensured.length, 1)
})

test('subscribe emits machines/status events and unsubscribe stops them', async () => {
  const { api } = fakeDeps()
  const seen = []
  const off = api.subscribe((evt) => seen.push(evt.type))
  await api.upsertMachine({ name: 'box2', host: '10.0.0.11' })
  await api.setCurrent('m-1')
  await api.connect({ machineId: 'm-1' })
  await api.ensureRemoteWorkspace({ remotePath: '/srv/x' })
  assert.deepEqual(seen, ['machines', 'status', 'status', 'status'])
  off()
  await api.upsertMachine({ name: 'box3', host: '10.0.0.12' })
  assert.equal(seen.length, 4)
})

test('a throwing subscriber never breaks the API call', async () => {
  const { api } = fakeDeps()
  api.subscribe(() => { throw new Error('subscriber exploded') })
  await assert.doesNotReject(api.upsertMachine({ name: 'box2', host: '10.0.0.11' }))
})

test('missing deps fail with INTERNAL instead of crashing the module', async () => {
  const api = createHostApi({})
  await assert.rejects(api.listMachines(), (err) => err.code === 'INTERNAL')
  await assert.rejects(api.status(), (err) => err.code === 'INTERNAL')
})

// ── 2. the real plugin: lib/index.js wiring ───────────────────────────────

test('the plugin exposes ctx.dshRemote (apiVersion 1) through the harness ctx', async () => {
  const host = await createHost({ machines: [machine({ id: 'm-1', host: '10.0.0.9' })], currentId: 'm-1' })
  try {
    const viaCtx = host.ctx.get('dshRemote')
    assert.ok(viaCtx, 'ctx.get("dshRemote") must return the API object')
    assert.equal(viaCtx.apiVersion, 1)
    assert.equal(host.api, viaCtx, 'harness exposes the same object as host.api')
  } finally { await host.dispose() }
})

test('listMachines through the real plugin never echoes stored secrets', async () => {
  const host = await createHost({
    machines: [machine({
      id: 'm-secret', name: 'secret-box', host: '10.0.0.44',
      password: SECRET_PASSWORD, passphrase: SECRET_PASSPHRASE,
      privateKeyPath: '/home/user/.ssh/id_ed25519',
    })],
    currentId: 'm-secret',
  })
  try {
    const res = await host.api.listMachines()
    assert.equal(res.currentId, 'm-secret')
    assert.equal(res.machines[0].passwordSet, true)
    assert.equal(res.machines[0].passphraseSet, true)
    assertNoSecrets('listMachines', res)
  } finally { await host.dispose() }
})

test('upsertMachine add then update: disk state, omit-keeps-old semantics, currentId untouched', async () => {
  const host = await createHost({
    machines: [machine({ id: 'm-a', name: 'a', host: '10.0.0.1' })],
    currentId: 'm-a',
  })
  try {
    const api = host.api
    const added = await api.upsertMachine({
      name: 'box', host: '10.0.0.5', port: 22, username: 'dev', password: 'pw-new',
      privateKeyPath: '/opt/keys/testkey', passphrase: 'pp-keep',
    })
    assert.equal(added.machines.length, 2)
    assert.equal(added.currentId, 'm-a', 'saving a machine must not switch the current machine')
    assert.equal(host.readMachines().length, 2)
    assertNoSecrets('upsertMachine add', added)

    const id = added.machine.id
    // A partial update: omitted privateKeyPath/passphrase keep their stored
    // values, only `name` changes (the data-loss class issue #48 guards).
    const updated = await api.upsertMachine({ id, host: '10.0.0.5', name: 'renamed' })
    assert.equal(updated.machine.name, 'renamed')
    assert.equal(updated.machine.privateKeyPath, '/opt/keys/testkey')
    assert.equal(updated.machine.passphraseSet, true)
    const onDisk = host.readMachines().find((m) => m.id === id)
    assert.equal(onDisk.name, 'renamed')
    assert.equal(onDisk.privateKeyPath, '/opt/keys/testkey')
    assert.equal(onDisk.passphrase, 'pp-keep')
    assert.equal(host.readRegistry().currentId, 'm-a')

    // Missing host is a caller-input problem: the contract's VALIDATION code
    // (not INTERNAL, not the route-only HOST_REQUIRED string), and the message
    // is the user-facing Chinese sentence the contract promises.
    await assert.rejects(api.upsertMachine({ name: 'no-host' }), (err) => (
      err.code === 'VALIDATION' && /主机/.test(err.message)
    ))

    // `group` is the contract's name for the registry's `environment` column:
    // a TUI form write must land there, and reads must project it back.
    const grouped = await api.upsertMachine({ id, host: '10.0.0.5', group: 'prod-east' })
    assert.equal(grouped.machine.group, 'prod-east')
    assert.equal(host.readMachines().find((m) => m.id === id).environment, 'prod-east')
    const listed = await api.listMachines()
    assert.equal(listed.machines.find((m) => m.id === id).group, 'prod-east')
    // An omitted group keeps the stored value (same "omitted ≠ delete" rule).
    const renamedAgain = await api.upsertMachine({ id, host: '10.0.0.5', name: 'renamed-2' })
    assert.equal(renamedAgain.machine.group, 'prod-east')
  } finally { await host.dispose() }
})

test('removeMachine deletes the current machine, leaves no current, never promotes a sibling', async () => {
  const host = await createHost({
    machines: [
      machine({ id: 'm-a', name: 'a', host: '10.0.0.1' }),
      machine({ id: 'm-b', name: 'b', host: '10.0.0.2' }),
    ],
    currentId: 'm-a',
  })
  try {
    const res = await host.api.removeMachine('m-a')
    assert.equal(res.currentId, null)
    // Every machines[] projection carries the same shape (MachineView.group).
    assert.ok(res.machines.every((m) => typeof m.group === 'string'), 'removed list keeps the group projection')
    assert.deepEqual(res.machines.map((m) => m.id), ['m-b'])
    assert.equal(host.readRegistry().currentId, null)
    assert.equal(host.readMachines().length, 1)
    await assert.rejects(host.api.removeMachine('m-a'), (err) => err.code === 'MACHINE_NOT_FOUND')
  } finally { await host.dispose() }
})

test('ensureRemoteWorkspace creates the local mirror + meta WITHOUT SSH, then listRemoteProjects finds it', async () => {
  const registry = fakeWorkspaceRegistry()
  const host = await createHost({
    machines: [machine({ id: 'm-1', name: 'box', host: '10.0.0.9', username: 'root' })],
    currentId: 'm-1',
    services: { workspaceRegistry: registry },
    // No SSH server exists for 10.0.0.9: if this test dialed, it would time out.
  })
  try {
    const api = host.api
    const res = await api.ensureRemoteWorkspace({ remotePath: '/srv/proj' })
    assert.equal(res.machineId, 'm-1')
    assert.equal(res.remotePath, '/srv/proj')
    assert.equal(res.title, 'box-proj')
    assert.ok(existsSync(res.localMirror), `mirror dir must exist: ${res.localMirror}`)
    const meta = JSON.parse(readFileSync(path.join(res.localMirror, '.dsh-remote-meta.json'), 'utf8'))
    assert.equal(meta.host, '10.0.0.9')
    assert.equal(meta.port, 22)
    assert.equal(meta.username, 'root')
    assert.equal(meta.remotePath, '/srv/proj')

    // The absolute requirement binding.js derives session identity from: the
    // returned localMirror must resolve back to the SAME remote path.
    const back = resolveMirror(res.localMirror, path.join(host.home, 'remote-workspaces'))
    assert.equal(back.remotePath, '/srv/proj')
    assert.equal(back.machine.host, '10.0.0.9')

    // Workspace ledger: host-qualified title, and no duplicate on re-ensure.
    assert.deepEqual(res.workspace, { id: 'w-1', title: 'box-proj' })
    assert.deepEqual(registry.workspaces.map((w) => [w.path, w.title]), [[res.localMirror, 'box-proj']])
    await api.ensureRemoteWorkspace({ remotePath: '/srv/proj' })
    assert.equal(registry.workspaces.length, 1, 'an existing mirror/workspace must be reused, not duplicated')

    // register:false creates the mirror but leaves the ledger alone.
    const other = await api.ensureRemoteWorkspace({ remotePath: '/srv/other', register: false })
    assert.equal('workspace' in other, false)
    assert.ok(existsSync(other.localMirror))
    assert.equal(registry.workspaces.length, 1)

    const projects = await api.listRemoteProjects()
    assert.equal(projects.length, 2)
    const proj = projects.find((p) => p.remotePath === '/srv/proj')
    assert.equal(proj.dir, res.localMirror)
    assert.equal(proj.machineId, 'm-1')
    assert.equal(proj.name, 'box')
    assert.equal(proj.alias, '')
    assertNoSecrets('listRemoteProjects', projects)
  } finally { await host.dispose() }
})

test('ensureRemoteWorkspace resolves machineId over the current machine', async () => {
  const host = await createHost({
    machines: [
      machine({ id: 'm-a', name: 'alpha', host: '10.0.0.1', username: 'root' }),
      machine({ id: 'm-b', name: 'beta', host: '10.0.0.2', port: 2222, username: 'dev' }),
    ],
    currentId: 'm-a',
  })
  try {
    const res = await host.api.ensureRemoteWorkspace({ machineId: 'm-b', remotePath: '/home/dev/work' })
    assert.equal(res.machineId, 'm-b')
    assert.equal(res.title, 'beta-work')
    const meta = JSON.parse(readFileSync(path.join(res.localMirror, '.dsh-remote-meta.json'), 'utf8'))
    assert.deepEqual(
      { host: meta.host, port: meta.port, username: meta.username },
      { host: '10.0.0.2', port: 2222, username: 'dev' },
    )
    await assert.rejects(
      host.api.ensureRemoteWorkspace({ machineId: 'm-nope', remotePath: '/tmp' }),
      (err) => err.code === 'MACHINE_NOT_FOUND',
    )
  } finally { await host.dispose() }
})

test('status() reports the current machine through the contract field machineId', async () => {
  const host = await createHost({ machines: [machine({ id: 'm-1', host: '10.0.0.9' })], currentId: 'm-1' })
  try {
    // Boot restore applies the current machine on a setImmediate (same as the
    // /status route); setCurrent is the synchronous way to make that state
    // explicit without waiting on a timer.
    await host.api.setCurrent('m-1')
    const status = await host.api.status()
    assert.equal(status.machineId, 'm-1')
    assert.equal(status.currentId, 'm-1')
    assert.equal(status.host, '10.0.0.9')
    assert.equal(typeof status.connected, 'boolean')
    assert.ok(Array.isArray(status.forwards))
  } finally { await host.dispose() }
})

test('listDir without a machine and without a current machine reports NO_ACTIVE_MACHINE', async () => {
  const host = await createHost({})
  try {
    await assert.rejects(host.api.listDir({ path: '/' }), (err) => err.code === 'NO_ACTIVE_MACHINE')
  } finally { await host.dispose() }
})

test('listDir with an unknown machineId reports MACHINE_NOT_FOUND without dialing', async () => {
  const host = await createHost({ machines: [machine({ id: 'm-1', host: '10.0.0.9' })], currentId: 'm-1' })
  try {
    await assert.rejects(host.api.listDir({ machineId: 'm-x', path: '/' }), (err) => err.code === 'MACHINE_NOT_FOUND')
  } finally { await host.dispose() }
})

test('pickRemoteWorkspace on an unreachable host refuses with NOT_A_DIRECTORY', async () => {
  const host = await createHost({
    machines: [machine({ id: 'm-dead', name: 'dead', host: '127.0.0.1', port: 1, username: 'u' })],
    currentId: 'm-dead',
  })
  try {
    await assert.rejects(
      host.api.pickRemoteWorkspace({ machineId: 'm-dead', remotePath: '/srv/proj' }),
      (err) => err.code === 'NOT_A_DIRECTORY',
    )
  } finally { await host.dispose() }
})

test('probeMachine surfaces a connection failure as a semantic error code', async () => {
  const host = await createHost({})
  try {
    await assert.rejects(
      host.api.probeMachine({ host: '127.0.0.1', port: 1, username: 'u', password: 'pw', hostKeyMode: 'off' }),
      (err) => {
        // Loopback port 1 refuses immediately; a firewall that drops instead
        // turns the same failure into TIMEOUT. Both are the contract's codes.
        assert.ok(['NETWORK', 'TIMEOUT'].includes(err.code), `unexpected code: ${err.code} (${err.message})`)
        assert.equal(typeof err.message, 'string')
        assert.ok(err.message.length > 0)
        return true
      },
    )
  } finally { await host.dispose() }
})

test('subscribe fires on real mutations (upsert → machines, setCurrent → status)', async () => {
  const host = await createHost({
    machines: [machine({ id: 'm-a', name: 'a', host: '10.0.0.1' })],
    currentId: 'm-a',
  })
  try {
    const events = []
    const off = host.api.subscribe((evt) => events.push(evt.type))
    const added = await host.api.upsertMachine({ name: 'b', host: '10.0.0.2' })
    await host.api.setCurrent(added.machine.id)
    assert.deepEqual(events, ['machines', 'status'])
    off()
    await host.api.setCurrent('m-a')
    assert.deepEqual(events, ['machines', 'status'])
  } finally { await host.dispose() }
})


// ── workspace cleanup (mirror + conversations) ────────────────────────────

/** Build a real on-disk mirror + session dirs and a deps object for one. */
function cleanupArea({ liveSession = 'session-live', extraMirrors = 0 } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-clean-area-'))
  const mirrorRoot = path.join(home, 'remote-workspaces')
  const sessionsRoot = path.join(home, 'sessions')
  const mirror = path.join(mirrorRoot, 'host-user-22', 'proj')
  mkdirSync(mirror, { recursive: true })
  writeFileSync(path.join(mirror, '.dsh-remote-meta.json'),
    JSON.stringify({ host: '10.0.0.9', port: 22, username: 'root', remotePath: '/srv/proj' }))
  writeFileSync(path.join(mirror, 'file.txt'), 'hello')
  for (let i = 0; i < extraMirrors; i += 1) {
    const extra = path.join(mirrorRoot, 'host-user-22', `proj-${i}`)
    mkdirSync(extra, { recursive: true })
    writeFileSync(path.join(extra, '.dsh-remote-meta.json'),
      JSON.stringify({ host: '10.0.0.9', port: 22, username: 'root', remotePath: `/srv/proj-${i}` }))
  }
  // The API validates through realpath (tmp dirs are symlinked on macOS), so
  // the session project key must use the same resolved path.
  const realMirror = realpathSync(mirror)
  const projectDir = path.join(sessionsRoot, projectKey(realMirror))
  for (const id of ['session-live', 'session-dead']) {
    const dir = path.join(projectDir, encodeSegment(id))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'x')
  }

  const state = {
    forgotten: [],
    deletedWorkspaces: [],
    mirror: realMirror,
    realMirror,
    mirrorRoot,
    sessionsRoot,
    projectDir,
    home,
  }
  const registry = {
    records: [{ id: 'w-1', path: realMirror, title: 'box-proj' }],
    list() { return [...this.records] },
    async resolveByPath(p) { return this.records.find((w) => w.path === p) || null },
    async delete(id) {
      const i = this.records.findIndex((w) => w.id === id)
      if (i < 0) return false
      state.deletedWorkspaces.push(id)
      this.records.splice(i, 1)
      return true
    },
  }
  const deps = {
    listMachinesView: () => ({
      machines: [{
        id: 'm-1', name: 'box', host: '10.0.0.9', port: 22, username: 'root',
        recentWorkspaces: ['/srv/proj'], workspace: '/srv/proj',
      }],
      currentId: 'm-1',
    }),
    listRemoteProjects: () => {
      const rows = [{ dir: realMirror, host: '10.0.0.9', port: 22, username: 'root', remotePath: '/srv/proj', alias: '', name: 'box', machineId: 'm-1' }]
      for (let i = 0; i < extraMirrors; i += 1) {
        rows.push({
          dir: realpathSync(path.join(mirrorRoot, 'host-user-22', `proj-${i}`)),
          host: '10.0.0.9', port: 22, username: 'root', remotePath: `/srv/proj-${i}`, alias: '', name: 'box', machineId: 'm-1',
        })
      }
      return rows
    },
    workspaceRoot: () => mirrorRoot,
    sessionsRoot: () => sessionsRoot,
    workspaceRegistry: () => registry,
    forgetRemotePath: async (remotePath) => {
      state.forgotten.push(remotePath)
      return { recents: 1, current: 1 }
    },
    isSessionLive: (id) => id === liveSession,
  }
  return { api: createHostApi(deps), deps, registry, state }
}

test('listWorkspaceMirrors reports sessions, liveness, registration and recent flag', async () => {
  const area = cleanupArea({ extraMirrors: 1 })
  try {
    const list = await area.api.listWorkspaceMirrors()
    assert.equal(list.length, 2)
    const entry = list.find((item) => item.localMirror === area.state.mirror)
    assert.ok(entry)
    assert.equal(entry.sessionCount, 2)
    assert.equal(entry.liveSessionCount, 1)
    assert.equal(entry.registered, true)
    assert.equal(entry.recent, true)
    assert.equal(entry.remotePath, '/srv/proj')
    assert.equal(entry.machineName, 'box')
    assert.match(entry.title, /proj/)
    assert.ok(entry.mirrorBytes >= 5)
    // machine filter
    const none = await area.api.listWorkspaceMirrors({ machineId: 'm-other' })
    assert.deepEqual(none, [])
  } finally { rmSync(area.state.home, { recursive: true, force: true }) }
})

test('deleteRemoteWorkspace refuses while a session is live (and deletes nothing)', async () => {
  const area = cleanupArea()
  try {
    await assert.rejects(
      area.api.deleteRemoteWorkspace({ localMirror: area.state.mirror }),
      (err) => err.code === 'WORKSPACE_BUSY' && Array.isArray(err.liveSessions) && err.liveSessions.includes('session-live'),
    )
    assert.equal(existsSync(area.state.mirror), true, 'mirror must survive a refused delete')
    assert.equal(existsSync(path.join(area.state.projectDir, encodeSegment('session-dead'))), true)
    assert.deepEqual(area.registry.records.length, 1)
  } finally { rmSync(area.state.home, { recursive: true, force: true }) }
})

test('deleteRemoteWorkspace removes conversations, registration, recent entry and the mirror', async () => {
  const area = cleanupArea()
  try {
    const result = await area.api.deleteRemoteWorkspace({ localMirror: area.state.mirror, force: true })
    assert.equal(result.removedMirror, true)
    assert.equal(result.removedSessions, 2)
    assert.equal(result.removedRegistration, true)
    assert.equal(result.removedRecents, 1)
    assert.equal(result.clearedMachineWorkspace, 1)
    assert.equal(existsSync(area.state.mirror), false)
    assert.equal(existsSync(area.state.projectDir), false)
    assert.deepEqual(area.registry.records, [])
    assert.deepEqual(area.state.forgotten, ['/srv/proj'])
  } finally { rmSync(area.state.home, { recursive: true, force: true }) }
})

test('deleteWorkspaceSessions removes dead chats, skips live ones and keeps the mirror', async () => {
  const area = cleanupArea()
  try {
    const result = await area.api.deleteWorkspaceSessions({ localMirror: area.state.mirror })
    assert.equal(result.removedSessions, 1)
    assert.deepEqual(result.skippedLiveSessions, ['session-live'])
    assert.equal(existsSync(path.join(area.state.projectDir, encodeSegment('session-dead'))), false)
    assert.equal(existsSync(path.join(area.state.projectDir, encodeSegment('session-live'))), true)
    assert.equal(existsSync(area.state.mirror), true)
    assert.equal(area.registry.records.length, 1)
  } finally { rmSync(area.state.home, { recursive: true, force: true }) }
})

test('forgetWorkspaceRecent only drops the recent entry', async () => {
  const area = cleanupArea()
  try {
    const result = await area.api.forgetWorkspaceRecent({ localMirror: area.state.mirror })
    assert.equal(result.removedRecents, 1)
    assert.deepEqual(area.state.forgotten, ['/srv/proj'])
    assert.equal(existsSync(area.state.mirror), true)
    assert.equal(area.registry.records.length, 1)
  } finally { rmSync(area.state.home, { recursive: true, force: true }) }
})

test('cleanup refuses paths that are not mirrors (VALIDATION, nothing removed)', async () => {
  const area = cleanupArea()
  try {
    const outside = path.join(area.state.home, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    const noMeta = path.join(area.state.mirrorRoot, 'host-user-22', 'no-meta')
    mkdirSync(noMeta, { recursive: true })
    for (const target of [outside, noMeta, path.join(area.state.mirrorRoot, 'host-user-22')]) {
      await assert.rejects(
        area.api.deleteRemoteWorkspace({ localMirror: target, force: true }),
        (err) => err.code === 'VALIDATION',
        `${target} must be refused`,
      )
    }
    assert.equal(readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
    assert.equal(existsSync(area.state.mirror), true)
  } finally { rmSync(area.state.home, { recursive: true, force: true }) }
})

test('real plugin: deleteRemoteWorkspace drops the mirror, registration and recent entry', async () => {
  const registry = fakeWorkspaceRegistry()
  registry.list = () => registry.workspaces.map((w) => ({ id: w.id, title: w.title, path: w.path }))
  registry.delete = async (id) => {
    const index = registry.workspaces.findIndex((w) => w.id === id)
    if (index < 0) return false
    registry.workspaces.splice(index, 1)
    return true
  }
  const host = await createHost({
    machines: [machine({ id: 'm-a', name: 'box', host: '10.0.0.9', recentWorkspaces: ['/srv/del'] })],
    currentId: 'm-a',
    services: { workspaceRegistry: registry },
  })
  try {
    const ensured = await host.api.ensureRemoteWorkspace({ machineId: 'm-a', remotePath: '/srv/del', register: true })
    const mirror = ensured.localMirror
    assert.ok(existsSync(mirror), 'mirror exists before delete')
    // The API validates via realpath; point the fake registry at the same path.
    if (registry.workspaces[0]) registry.workspaces[0].path = realpathSync(mirror)
    assert.equal(host.readMachines()[0].recentWorkspaces.includes('/srv/del'), true)

    const sessionsRoot = path.join(process.env.DSH_HOME, 'sessions')
    // The API validates through realpath (tmp dirs are symlinked on macOS), so
  // the session project key must use the same resolved path.
  const realMirror = realpathSync(mirror)
  const projectDir = path.join(sessionsRoot, projectKey(realMirror))
    const sessionDir = path.join(projectDir, encodeSegment('session-x'))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'x')

    const result = await host.api.deleteRemoteWorkspace({ localMirror: mirror, force: true })
    assert.equal(result.removedMirror, true)
    assert.equal(result.removedSessions, 1)
    assert.equal(existsSync(mirror), false)
    assert.equal(existsSync(sessionDir), false)
    assert.equal(host.readMachines()[0].recentWorkspaces.includes('/srv/del'), false)
    assert.equal(registry.workspaces.length, 0)
  } finally { await host.dispose() }
})
