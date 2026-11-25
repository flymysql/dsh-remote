// Issue #212 — JumpServer-class gateways allocate a remote PTY only for a
// plain LOGIN: a session that carries a command (the terminal launcher's
// `sh -c 'cd …; exec "$SHELL" -l'`, even with -tt) comes up with no line
// discipline — Return sends \r raw, zsh's ZLE never starts, keys look dead;
// wrapping in `script -q -c` to force a PTY then doubles the terminal (ZLE
// redraw glitches, `stty size` stuck at 0 0).
//
// The fix is a per-machine opt-in: `terminalNoCommand` makes the generated
// launcher dial `ssh -tt <target>` with NO command — the gateway then hands
// the login a real PTY (working line editing and window resize), at the cost
// of the automatic cd into the workspace. The flag persists like any machine
// field (an omitted flag keeps the stored value; explicit false clears it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHost } from './harness/plugin-host.js'

const child = await import('../lib/remote-shell-child.cjs')

test('#212: terminalNoCommand drops the cd-and-exec command from the dial', () => {
  const target = { host: 'bastion-host', port: 22, username: 'ops', remotePath: '/srv/app' }
  const plain = child.buildSshArgs(target)
  assert.deepEqual(plain, ['-tt', 'ops@bastion-host', child.remoteCommand('/srv/app')],
    'default machines keep the cd-and-exec command')

  const loginOnly = child.buildSshArgs(target, { host: 'bastion-host', terminalNoCommand: true })
  assert.deepEqual(loginOnly, ['-tt', 'ops@bastion-host'],
    'a PTY-stingy gateway gets a plain login — no command, nothing for it to strip the PTY from')
})

test('#212: a Windows remote keeps its no-command shape either way', () => {
  const target = { host: 'win', port: 22, username: 'u', remotePath: 'D:\\work' }
  assert.deepEqual(child.buildSshArgs(target, { terminalNoCommand: true }), ['-tt', 'u@win'])
  assert.deepEqual(child.buildSshArgs(target), ['-tt', 'u@win'])
})

test('#212: the flag persists, survives an omitted-field save, and clears on explicit false', async () => {
  const host = await createHost({})
  try {
    const add = await host.call('/dsh-remote/machines', {
      body: { action: 'add', name: 'bastion', host: '10.0.0.9', username: 'ops', password: 'pw', terminalNoCommand: true },
    })
    assert.equal(add.status, 200, add.raw)
    const id = add.json.machine.id
    assert.equal(host.readMachines().find((m) => m.id === id).terminalNoCommand, true, 'add stores the flag')

    // A save that omits the field (older client, partial API update) keeps it.
    const keep = await host.call('/dsh-remote/machines', {
      body: { action: 'update', id, name: 'bastion', host: '10.0.0.9', username: 'ops', workspace: '/srv/app' },
    })
    assert.equal(keep.status, 200, keep.raw)
    assert.equal(host.readMachines().find((m) => m.id === id).terminalNoCommand, true, 'an omitted flag keeps the stored value')

    // The settings form unchecking sends false — that must clear it.
    const clear = await host.call('/dsh-remote/machines', {
      body: { action: 'update', id, name: 'bastion', host: '10.0.0.9', username: 'ops', terminalNoCommand: false },
    })
    assert.equal(clear.status, 200, clear.raw)
    assert.equal(host.readMachines().find((m) => m.id === id).terminalNoCommand, undefined, 'explicit false clears the flag')
  } finally {
    await host.dispose()
  }
})

test('#212: the settings UI carries the flag (form load, save body, checkbox, both locales)', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('terminalNoCommand: !!m.terminalNoCommand'), 'beginEdit loads the flag into the form')
  assert.ok(src.includes('terminalNoCommand: !!form.terminalNoCommand'), 'the save body carries the flag')
  assert.ok(/'terminal-no-command'/.test(src), 'the advanced section renders the checkbox')
  assert.ok(src.includes("'settings.terminalNoCommandHint': 'JumpServer"), 'zh hint present')
  assert.ok(src.includes("'settings.terminalNoCommandHint': 'JumpServer-class gateways allocate"), 'en hint present')
})
