// rw_connect's post-dial probe (`echo ok`, hardcoded 8000ms) used to report a
// timeout as a bare `connect failed: exit -1`.
//
// pool.exec never rejects: its deadline RESOLVES with
// `{ code: -1, signal: 'TIMEOUT', stdout: '', stderr: '' }` on BOTH backends
// (the timers in lib/pool.js and lib/openssh.js), and the rw_connect tail only
// looked at code/stderr — so any dial slower than the budget lost the one fact
// that matters ("a timeout happened"). The mapping already existed elsewhere
// (rw_info's "Ping: timeout", the connect-stage probe's "ssh timed out after
// Xms" from dsh-remote-fix3, the exec tools' "[command timed out after Xms]");
// the tail now goes through `connectFailureText` (lib/connect-summary.js).
//
// The unit tests below pin the sentence and the non-timeout parity; the last
// test pins the WIRING end-to-end against the fake ssh server with a delayed
// `echo ok` — the REAL pool deadline path, same trick as issue #125's discover
// timeout. It costs ~8.5s because the 8000ms budget is the bug's own constant,
// not a config knob.
//
// Values are RFC 5737 / loopback placeholders; the fake server and the temp
// DSH_HOME keep ~/.ssh/config untouched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectFailureText } from '../lib/connect-summary.js'
import { createHost } from './harness/plugin-host.js'
import { startFakeSsh } from './harness/fake-ssh.js'

// ── unit: the failure sentence ───────────────────────────────────────────────

test('a TIMEOUT probe result is reported as a timeout with the budget and the host', () => {
  const text = connectFailureText(
    { code: -1, signal: 'TIMEOUT', stdout: '', stderr: '' },
    { host: '203.0.113.10', timeoutMs: 8000 },
  )
  assert.match(text, /timed out after 8000ms/)
  assert.match(text, /203\.0\.113\.10/)
  assert.doesNotMatch(text, /exit -1/, 'the bare exit code must not come back')
})

test('non-timeout failures keep the exact old text (stderr first, then exit N)', () => {
  assert.equal(
    connectFailureText({ code: 255, stderr: 'Permission denied (publickey)' }, { host: 'h', timeoutMs: 8000 }),
    'Permission denied (publickey)',
  )
  assert.equal(
    connectFailureText({ code: 255, stderr: '' }, { host: 'h', timeoutMs: 8000 }),
    'exit 255',
  )
})

// ── wiring: the REAL rw_connect handler must apply the mapping ──────────────

test('rw_connect reports a timed-out post-dial probe instead of "exit -1"', async () => {
  const srv = await startFakeSsh({
    users: { root: { password: 'pw' } },
    // Stall ONLY the probe command; platform detection (`uname -s`) answers
    // from the default table so the connect stage stays fast. 8500 > the
    // hardcoded 8000ms budget, so the pool's own timer wins and resolves the
    // exact shape the bug used to eat.
    onExec: (cmd) => (cmd === 'echo ok' ? { delayMs: 8500 } : null),
  })
  const host = await createHost({})
  try {
    const res = await host.run('rw_connect', { ...srv.machine(), save: false })
    assert.equal(typeof res.text, 'string')
    assert.match(res.text, /^connect failed: /)
    assert.match(res.text, /timed out after 8000ms/)
    assert.match(res.text, /127\.0\.0\.1/)
    assert.doesNotMatch(res.text, /exit -1/, 'the old bare-exit text must be gone')
  } finally {
    await host.dispose()
    await srv.close()
  }
})
