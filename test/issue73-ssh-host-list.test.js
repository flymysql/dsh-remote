// Issue #73: 「直接从 ~/.ssh/config 列出服务器，点一下就连接」.
//
// The reporter's point was that a user who can write an ssh config should not have
// to learn what "别名" and "副本" mean, or fill in a six-field form first. The fix has
// two halves and both are pinned here:
//
//   · HOST: `/ssh-config` lists EVERY concrete alias in the file (a bare `Host box`
//     with no options included — the old list filtered those out), and
//     `POST /machines {action:'from-ssh-config'}` adopts one: upsert (never a
//     duplicate), make it current, and never rewrite the user's file.
//   · CLIENT: the list is the first thing on the page and each row has ONE 连接
//     action that activates + probes, with the result on that row.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from './harness/plugin-host.js'

/** Point the plugin at a scratch ~/.ssh/config for one test. */
async function withSshConfig(text, fn, { machines = [] } = {}) {
  const saved = process.env.DSH_REMOTE_SSH_CONFIG
  // A temp dir of its own — never DSH_HOME and never the cwd: an earlier version
  // fell back to '.', which wrote the fixture INTO the repo (and into the commit).
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-sshcfg-'))
  const file = path.join(dir, 'config')
  writeFileSync(file, text, 'utf8')
  process.env.DSH_REMOTE_SSH_CONFIG = file
  const host = await createHost({ machines })
  try {
    await fn({ host, file })
  } finally {
    await host.dispose()
    if (saved === undefined) delete process.env.DSH_REMOTE_SSH_CONFIG
    else process.env.DSH_REMOTE_SSH_CONFIG = saved
    rmSync(dir, { recursive: true, force: true })
  }
}

const SAMPLE = [
  'Host box',
  '  HostName 10.0.0.7',
  '  User deploy',
  '  Port 2200',
  '  IdentityFile ~/.ssh/id_box',
  '',
  'Host bare',
  '',
  'Host *',
  '  ServerAliveInterval 30',
  '',
].join('\n')

test('/ssh-config lists every concrete alias, including a bare Host with no options', async () => {
  // DSH_HOME must exist before createHost picks its own; the suite's setup already
  // isolates the ssh config, so this test just swaps it per case.
  await withSshConfig(SAMPLE, async ({ host, file }) => {
    const r = await host.call('/dsh-remote/ssh-config', { method: 'GET' })
    assert.equal(r.json.ok, true)
    assert.equal(r.json.present, true)
    assert.equal(r.json.file, file, 'the route must read the file the environment points at')
    const aliases = r.json.entries.map((e) => e.alias).sort()
    assert.deepEqual(aliases, ['bare', 'box'], `wildcards excluded, bare Host included — got ${JSON.stringify(aliases)}`)
    const box = r.json.entries.find((e) => e.alias === 'box')
    assert.equal(box.hostName, '10.0.0.7')
    assert.equal(box.user, 'deploy')
    assert.equal(box.port, 2200)
    assert.equal(box.identityFile, '~/.ssh/id_box')
    // `host` is kept as an alias of `alias` for older callers.
    assert.equal(box.host, 'box')
  })
})

test('from-ssh-config adopts a host: alias machine, current, and no duplicate on a second click', async () => {
  await withSshConfig(SAMPLE, async ({ host }) => {
    const first = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: 'box' } })
    assert.equal(first.json.ok, true, `adopt failed: ${first.raw}`)
    assert.equal(first.json.created, true)
    const rec = first.json.machine
    assert.equal(rec.host, 'box', 'the machine stores the ALIAS, not a copy of the file values')
    assert.equal(rec.useSshConfig, true, 'so host/user/port/key keep coming from the file')
    assert.equal(first.json.currentId, rec.id, 'clicking 连接 must make it the current machine')

    const saved = host.readMachines()
    assert.equal(saved.length, 1, 'one machine in the registry')
    assert.equal(saved[0].useSshConfig, true)

    const second = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: 'box' } })
    assert.equal(second.json.created, false, 'a second click must reuse the machine, not add another')
    assert.equal(host.readMachines().length, 1, 'still one machine')
  })
})

test('from-ssh-config refuses an alias the file does not define, and a blank alias', async () => {
  await withSshConfig(SAMPLE, async ({ host }) => {
    const missing = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: 'nope' } })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.ok, false)
    assert.match(String(missing.json.error), /\.ssh\/config/, 'the error must name the file the user should edit')

    const blank = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config' } })
    assert.equal(blank.status, 400)
    assert.match(String(blank.json.error), /alias/)

    assert.equal(host.readMachines().length, 0, 'a refused adopt must not leave a machine behind')
  })
})

test('adopting a bare Host still produces a usable machine (the case the old list dropped)', async () => {
  await withSshConfig(SAMPLE, async ({ host }) => {
    const r = await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: 'bare' } })
    assert.equal(r.json.ok, true, `bare Host must be adoptable: ${r.raw}`)
    assert.equal(r.json.machine.host, 'bare')
    assert.equal(r.json.machine.useSshConfig, true)
    // The client-shaped row (`machines`) carries the resolved identity; a bare Host
    // resolves to itself, which is exactly what `ssh bare` does.
    const row = r.json.machines.find((m) => m.id === r.json.machine.id)
    assert.ok(row && row.sshConfigResolved, 'the client row must carry the resolution')
    assert.equal(row.sshConfigResolved.matched, true)
    assert.equal(row.sshConfigResolved.host, 'bare')
  })
})

/** Like withSshConfig, but the file may be missing and native dialogs are off. */
async function withSshEnv(fn, { text = null } = {}) {
  const savedCfg = process.env.DSH_REMOTE_SSH_CONFIG
  const savedDialog = process.env.DSH_REMOTE_NO_NATIVE_DIALOG
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-remote-sshcfg-'))
  const file = path.join(dir, 'config')
  if (text != null) writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
  process.env.DSH_REMOTE_SSH_CONFIG = file
  process.env.DSH_REMOTE_NO_NATIVE_DIALOG = '1'
  const host = await createHost()
  try {
    await fn({ host, file })
  } finally {
    await host.dispose()
    if (savedCfg === undefined) delete process.env.DSH_REMOTE_SSH_CONFIG
    else process.env.DSH_REMOTE_SSH_CONFIG = savedCfg
    if (savedDialog === undefined) delete process.env.DSH_REMOTE_NO_NATIVE_DIALOG
    else process.env.DSH_REMOTE_NO_NATIVE_DIALOG = savedDialog
    rmSync(dir, { recursive: true, force: true })
  }
}

test('POST /ssh-config opens the real config file and ignores a path in the body', async () => {
  await withSshEnv(async ({ host, file }) => {
    const r = await host.call('/dsh-remote/ssh-config', { body: { action: 'open', file: '/etc/passwd' } })
    assert.equal(r.status, 501, `headless open must refuse the dialog: ${r.raw}`)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.file, file, 'the opened path is sshConfigPath(), never the body')
    assert.notEqual(r.json.file, '/etc/passwd')
    assert.match(String(r.json.error), /DSH_REMOTE_NO_NATIVE_DIALOG/)
    assert.equal(existsSync(file), true, 'a missing config is created so the editor has a file')
    assert.equal(readFileSync(file, 'utf8'), '')
    assert.equal(statSync(file).mode & 0o777, 0o600, 'a new config must not be world-readable')
  })
})

test('POST /ssh-config does not truncate a config the user already wrote', async () => {
  const original = 'Host keepme\n  HostName 10.1.1.1\n'
  await withSshEnv(async ({ host, file }) => {
    const r = await host.call('/dsh-remote/ssh-config', { body: { action: 'reveal', file: '/tmp/nope' } })
    assert.equal(r.status, 501)
    assert.equal(r.json.file, file)
    assert.equal(readFileSync(file, 'utf8'), original)
  }, { text: original })
})

test('POST /ssh-config rejects an action that is not open or reveal', async () => {
  await withSshEnv(async ({ host, file }) => {
    const r = await host.call('/dsh-remote/ssh-config', { body: { action: 'install', file } })
    assert.equal(r.status, 400)
    assert.match(String(r.json.error), /open \| reveal/)
    assert.equal(existsSync(file), false, 'a rejected action must not create the file')
  })
})

test('adopting does NOT rewrite the user\'s ssh config', async () => {
  await withSshConfig(SAMPLE, async ({ host, file }) => {
    const before = (await import('node:fs')).readFileSync(file, 'utf8')
    await host.call('/dsh-remote/machines', { body: { action: 'from-ssh-config', alias: 'box' } })
    const after = (await import('node:fs')).readFileSync(file, 'utf8')
    assert.equal(after, before, 'the file is the source of truth; adopting must not touch it')
  })
})
