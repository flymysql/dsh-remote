// Issue #206: the per-machine `shell` config was declared in the schema and
// read by both backends' detection, but applyMachine() never copied it, both
// setTarget()s ignored it, and POST /dsh-remote/machines rebuilt the record
// without it — so a hand-edited value in machines.json was dead on arrival and
// wiped on the next save. These tests pin the whole chain:
//
//   machines.json → applyMachine → shared config.shell → setTarget diff →
//   detection honoring it → the exec wrapper using the configured bash.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyMachine } from '../lib/registry.js'
import { SshPool } from '../lib/pool.js'
import { SystemOpenSshPool } from '../lib/openssh.js'
import { createHost, machine } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

const POOL_CONFIG = {
  host: 'example.internal', port: 22, username: 'root', password: '',
  privateKeyPath: '', passphrase: '', workspace: '', shell: '',
  commandTimeoutMs: 3000, connectTimeoutMs: 5000, maxOutputChars: 100000,
  maxFileBytes: 1000000, hostKeyMode: 'off', useAgent: false,
  keyboardInteractive: false, encoding: 'utf-8',
}

test('#206: applyMachine copies the per-machine shell onto the shared config', () => {
  const config = { ...POOL_CONFIG }
  applyMachine(config, machine({ host: 'h1', shell: 'D:/wrap/bash.exe' }))
  assert.equal(config.shell, 'D:/wrap/bash.exe')
  // Continuing #206 (apply-machine reset): an absent field used to keep
  // whatever the shared config held — but that value is indistinguishable
  // from the PREVIOUS machine's leftover (a stale backend or a disabled
  // host-key mode leaked exactly this way), so it now resets to the schema
  // default '' (lib/main.js Config.shell). See test/apply-machine-reset.test.js.
  const config2 = { ...POOL_CONFIG, shell: 'global-bash' }
  applyMachine(config2, machine({ host: 'h2' }))
  assert.equal(config2.shell, '')
})

for (const [label, makePool] of [
  ['native ssh2', () => new SshPool({ ...POOL_CONFIG })],
  ['system openssh', () => new SystemOpenSshPool({ ...POOL_CONFIG, backend: 'openssh', sshBinary: process.execPath })],
]) {
  test(`#206 (${label}): setTarget treats a shell change as a target change and resets detection`, () => {
    const pool = makePool()
    try {
      // Simulate a completed detection for the old target.
      pool.platform = 'posix'
      pool.shellMode = 'native'
      pool.gitBashPath = '/usr/bin/bash'
      // Same host, only the shell differs → must still re-point.
      pool.setTarget({ host: 'example.internal', shell: 'D:/wrap/bash.exe' })
      assert.equal(pool.config.shell, 'D:/wrap/bash.exe', 'the shell reaches the pool config')
      assert.equal(pool.platform, 'unknown', 'the cached detection must reset so the new shell is honored')
      assert.equal(pool.gitBashPath, '')
      // An identical repeat is a no-op (the fingerprint contract).
      pool.platform = 'posix'
      pool.setTarget({ host: 'example.internal', shell: 'D:/wrap/bash.exe' })
      assert.equal(pool.platform, 'posix', 'an unchanged target must not reset detection')
    } finally {
      pool.close()
    }
  })
}

test('#206: POST /machines stores the shell, preserves it when a save omits it, and clears it on explicit empty', async () => {
  const host = await createHost({})
  try {
    const add = await host.call('/dsh-remote/machines', {
      body: { action: 'add', name: 'win-box', host: '10.0.0.5', username: 'admin', password: 'pw', shell: 'D:/wrap/bash.exe' },
    })
    assert.equal(add.status, 200, add.raw)
    const id = add.json.machine.id
    assert.equal(host.readMachines().find((m) => m.id === id).shell, 'D:/wrap/bash.exe', 'add stores the shell')

    // The historical wipe: a save that rebuilds the record field by field
    // (e.g. just picking a workspace) must NOT lose a stored shell.
    const keep = await host.call('/dsh-remote/machines', {
      body: { action: 'update', id, name: 'win-box', host: '10.0.0.5', username: 'admin', workspace: 'C:/work' },
    })
    assert.equal(keep.status, 200, keep.raw)
    assert.equal(host.readMachines().find((m) => m.id === id).shell, 'D:/wrap/bash.exe',
      'a save that omits shell keeps the stored value (the #206 wipe)')

    const clear = await host.call('/dsh-remote/machines', {
      body: { action: 'update', id, name: 'win-box', host: '10.0.0.5', username: 'admin', shell: '' },
    })
    assert.equal(clear.status, 200, clear.raw)
    assert.equal(host.readMachines().find((m) => m.id === id).shell, '', 'an explicit empty shell clears it')
  } finally {
    await host.dispose()
  }
})

test('#206: rw_connect persists a shell argument onto the saved machine', async () => {
  const srv = await startFakeSsh({ users: { root: { password: 'pw' } }, fs: { '/home/user/a.txt': 'x' } })
  const host = await createHost({
    config: { host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', workspace: '/home/user', commandTimeoutMs: 5000, connectTimeoutMs: 5000 },
  })
  try {
    const res = await host.run('rw_connect', { host: '127.0.0.1', port: srv.port, username: 'root', password: 'pw', shell: 'D:/wrap/bash.exe' })
    assert.match(String(res.text || res.content || ''), /connected|saved|active/i, String(res.text || res.content || res))
    const rec = host.readMachines().find((m) => m.host === '127.0.0.1')
    assert.ok(rec, 'the machine was saved')
    assert.equal(rec.shell, 'D:/wrap/bash.exe', 'rw_connect stores the shell for later connects')
  } finally {
    await host.dispose()
    await srv.close()
  }
})

test('#206: end to end — the active machine\'s shell drives Git Bash resolution on a Windows remote', async () => {
  // A Windows-shaped fake host: `cmd /c "ver"` answers the banner, `uname -s`
  // answers MINGW (with the literal-$0 `echo $0` keeping it on the cmd.exe
  // resolution path). The machine's configured shell must WIN over
  // auto-detection: `cmd /c if exist "D:/wrap/bash.exe"` is asked FIRST and,
  // answered with Y, the exec wrapper uses that exact path.
  const SHELL = 'D:/wrap/bash.exe'
  const srv = await startFakeSsh({
    platform: 'windows',
    users: { admin: { password: 'pw' } },
    fs: { 'C:/work/a.txt': 'x' },
    cwd: 'C:/work',
    onExec: (cmd) => {
      if (cmd === `cmd /c if exist "${SHELL}" (echo Y) else (echo N)`) return { stdout: 'Y\r\n', code: 0 }
      if (cmd === 'cmd /c where bash') return { stdout: 'C:\\Windows\\System32\\bash.exe\r\n', code: 0 }
      // The fake shell cannot exec the wrapper binary; answer the wrapped
      // script's expected output so the tool result is realistic.
      if (cmd === `"${SHELL}" -s`) return { stdout: 'hello\r\n', code: 0 }
      return null
    },
  })
  const host = await createHost({
    machines: [machine({ id: 'm-win', name: 'win', host: '127.0.0.1', port: srv.port, username: 'admin', password: 'pw', workspace: 'C:/work', shell: SHELL })],
    currentId: 'm-win',
    config: { host: '127.0.0.1', port: srv.port, username: 'admin', password: 'pw', workspace: 'C:/work', commandTimeoutMs: 5000, connectTimeoutMs: 5000 },
  })
  try {
    const res = await host.run('rw_exec', { command: 'echo hello' })
    assert.match(String(res.text || res.content || ''), /hello/, 'exec runs through the wrapper')
    // The proof the configured shell was used: the if-exist probe for IT ran,
    // and the wrapper line names it (not the auto-detected System32 bash).
    assert.ok(srv.execLog.includes(`cmd /c if exist "${SHELL}" (echo Y) else (echo N)`),
      `the configured shell is probed first — log: ${JSON.stringify(srv.execLog)}`)
    assert.ok(srv.execLog.some((c) => c === `"${SHELL}" -s`),
      `the exec wrapper uses the configured shell — log: ${JSON.stringify(srv.execLog)}`)
    assert.ok(!srv.execLog.includes('cmd /c where bash'),
      `auto-detection is skipped entirely when the configured shell exists — log: ${JSON.stringify(srv.execLog)}`)
  } finally {
    await host.dispose()
    await srv.close()
  }
})

test('#206: the settings UI keeps the machine shell in its form and save body (source pin)', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Load into the form…
  assert.ok(src.includes('shell: m.shell || \'\''), 'beginEdit loads the stored shell into the form')
  // …save it back…
  assert.ok(src.includes('shell: form.shell || \'\''), 'the save body carries the form shell')
  // …and render an input for it.
  assert.ok(/'machine-shell'/.test(src), 'the advanced section renders a shell input')
})
