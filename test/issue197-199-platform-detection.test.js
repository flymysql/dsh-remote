// Issues #197 + #199 — remote platform/shell detection on Windows OpenSSH hosts.
//
//   · #199: Windows OpenSSH re-wraps the client command as `cmd.exe /c "…"`, so
//     a bare `cmd /c ver` reaches the inner cmd with a stray trailing quote
//     (`'ver"' 不是内部或外部命令`). The probe must quote the token: `cmd /c "ver"`,
//     which the reporter verified returns exit 0 on a stock cmd.exe host. With
//     the bare form, healthy Windows hosts were misdetected as posix and the
//     workspace picker tried `sftp.readdir('/')` instead of listing drives.
//   · #197: with Git Bash set as the sshd DefaultShell, `cmd /c ver` SUCCEEDS
//     (Git Bash execs cmd.exe), so the old order picked the Windows-path bash
//     wrapper — which a POSIX default shell cannot exec (quoted backslash paths
//     arrive mangled). A POSIX default shell must be detected FIRST (uname +
//     `echo $0`), and its bash located POSIX-style (`command -v bash`).
//   · Ambiguity: `uname` answering MINGW can also mean "cmd.exe default shell
//     with Git's usr/bin on PATH" — there the Windows-path resolution is the
//     correct one, and `echo $0` disambiguates (cmd echoes the literal "$0").
//
// Both backends (SshPool native ssh2, SystemOpenSshPool) share one detector
// (lib/detect-platform.js), so each scenario is pinned against both.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SshPool } from '../lib/pool.js'
import { SystemOpenSshPool } from '../lib/openssh.js'

const POOL_CONFIG = {
  host: 'example.internal', port: 22, username: 'root', password: '',
  privateKeyPath: '', passphrase: '', workspace: '', shell: '',
  commandTimeoutMs: 3000, connectTimeoutMs: 5000, maxOutputChars: 100000,
  maxFileBytes: 1000000, hostKeyMode: 'off', useAgent: false,
  keyboardInteractive: false, encoding: 'utf-8',
}

const OPENSSH_CONFIG = {
  ...POOL_CONFIG,
  backend: 'openssh',
  // `_runSsh` is stubbed below, so the binary is never spawned; an absolute,
  // always-present executable keeps the availability probe honest.
  sshBinary: process.execPath,
  hostKeyMode: 'accept-new',
}

const VER_BANNER = 'Microsoft Windows [版本 10.0.17763.9245]\r\n'

/** Router-table double: `table[cmd] → {code,stdout,stderr}`; unknown commands
 *  answer 127 like a real shell ("command not found"). Records every probe. */
function router(table) {
  const seen = []
  const run = async (cmd) => {
    seen.push(cmd)
    if (Object.prototype.hasOwnProperty.call(table, cmd)) return { code: 0, stdout: '', stderr: '', ...table[cmd] }
    return { code: 127, stdout: '', stderr: `sh: ${cmd.split(/\s+/)[0]}: command not found\n` }
  }
  return { seen, run }
}

/** A SshPool with its transport stubbed by a router table. */
function nativePool(table) {
  const pool = new SshPool({ ...POOL_CONFIG })
  const { seen, run } = router(table)
  pool._execRaw = async (cmd, opts, stdinWriter) => {
    const res = await run(cmd)
    if (stdinWriter) stdinWriter({ end() { /* captured by the exec test */ } })
    return res
  }
  pool.__seen = seen
  return pool
}

/** A SystemOpenSshPool with its transport stubbed by a router table. */
function opensshPool(table) {
  const pool = new SystemOpenSshPool({ ...OPENSSH_CONFIG })
  const { seen, run } = router(table)
  pool._runSsh = async (args) => run(args[args.length - 1])
  pool.__seen = seen
  return pool
}

const BOTH_BACKENDS = [
  ['native ssh2', nativePool],
  ['system openssh', opensshPool],
]

// ── #199: a stock cmd.exe default shell (no Git Bash, no uname) ─────────────

for (const [label, make] of BOTH_BACKENDS) {
  test(`#199 (${label}): a cmd.exe default shell is detected as windows via the QUOTED ver probe`, async () => {
    const pool = make({
      'cmd /c "ver"': { code: 0, stdout: VER_BANNER },
      // `uname` does not exist on a stock Windows host.
      'uname -s': { code: 1, stdout: '', stderr: "'uname' 不是内部或外部命令\r\n" },
    })
    try {
      await pool.detect()
      assert.equal(pool.platform, 'windows', 'the platform must not fall through to posix (#199)')
      assert.ok(pool.__seen.includes('cmd /c "ver"'), 'the ver probe must be the quoted form')
      assert.ok(!pool.__seen.includes('cmd /c ver'), 'the bare single-token form is what sshd mangles (#199)')
    } finally {
      pool.close()
    }
  })
}

test('#199: no probe anywhere in lib/ sends the bare `cmd /c ver` form', () => {
  for (const file of ['lib/detect-platform.js', 'lib/pool.js', 'lib/openssh.js']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.ok(!/['"]cmd \/c ver['"]/.test(src), `${file} must quote the ver token (sshd re-wrapping breaks the bare form)`)
  }
})

// ── #197: Git Bash set as the sshd DefaultShell ─────────────────────────────

for (const [label, make] of BOTH_BACKENDS) {
  test(`#197 (${label}): a POSIX default shell (Git Bash) keeps platform windows and a POSIX bash path`, async () => {
    const pool = make({
      'uname -s': { code: 0, stdout: 'MINGW64_NT-10.0-26300.9974\r\n' },
      'echo $0': { code: 0, stdout: 'bash\n' },
      'command -v bash': { code: 0, stdout: '/usr/bin/bash\n' },
    })
    try {
      await pool.detect()
      assert.equal(pool.platform, 'windows', 'uname answered MINGW → windows')
      assert.equal(pool.shellMode, 'git-bash')
      assert.equal(pool.gitBashPath, '/usr/bin/bash',
        'the bash path must be POSIX-style: the POSIX default shell cannot exec quoted backslash paths')
    } finally {
      pool.close()
    }
  })
}

test('#197 (native ssh2): exec pipes the script to the POSIX bash, never a backslash wrapper', async () => {
  const table = {
    'uname -s': { code: 0, stdout: 'MINGW64_NT-10.0-26300.9974\r\n' },
    'echo $0': { code: 0, stdout: 'bash\n' },
    'command -v bash': { code: 0, stdout: '/usr/bin/bash\n' },
  }
  const pool = new SshPool({ ...POOL_CONFIG })
  const { seen, run } = router(table)
  const wrapped = []
  pool._execRaw = async (cmd, opts, stdinWriter) => {
    const res = await run(cmd)
    if (stdinWriter) stdinWriter({ end: (s) => wrapped.push({ cmd, script: s }) })
    return res
  }
  try {
    await pool.exec('echo READY/$PWD')
    const bashCalls = wrapped.filter((c) => /bash(\.exe)?"?\s+-s$/.test(c.cmd))
    assert.equal(bashCalls.length, 1, 'exactly one wrapped bash -s call')
    assert.equal(bashCalls[0].cmd, '"/usr/bin/bash" -s',
      'the wrapper must use the POSIX path — a "C:\\…bash.exe" -s wrapper is what #197 broke')
    assert.equal(bashCalls[0].script, 'echo READY/$PWD', 'the script rides on stdin verbatim')
  } finally {
    pool.close()
  }
})

test('#197 (system openssh): exec pipes the script to the POSIX bash over stdin', async () => {
  const pool = new SystemOpenSshPool({ ...OPENSSH_CONFIG })
  const { seen, run } = router({
    'uname -s': { code: 0, stdout: 'MINGW64_NT-10.0-26300.9974\r\n' },
    'echo $0': { code: 0, stdout: 'bash\n' },
    'command -v bash': { code: 0, stdout: '/usr/bin/bash\n' },
  })
  const wrapped = []
  pool._runSsh = async (args, opts) => {
    const cmd = args[args.length - 1]
    const res = await run(cmd)
    if (/" -s$/.test(cmd)) wrapped.push({ cmd, stdin: opts && opts.stdin })
    return res
  }
  try {
    await pool.exec('echo READY/$PWD')
    assert.equal(wrapped.length, 1)
    assert.equal(wrapped[0].cmd, '"/usr/bin/bash" -s')
    assert.equal(wrapped[0].stdin, 'echo READY/$PWD')
  } finally {
    pool.close()
  }
})

// ── the uname ambiguity: cmd.exe default shell with Git's usr/bin on PATH ──

for (const [label, make] of BOTH_BACKENDS) {
  test(`(#197/${label}): MINGW uname + cmd.exe default shell resolves a WINDOWS bash path`, async () => {
    const pool = make({
      'uname -s': { code: 0, stdout: 'MINGW64_NT-10.0-26300.9974\r\n' },
      'echo $0': { code: 0, stdout: '$0\r\n' }, // cmd.exe echoes the literal "$0"
      'cmd /c where bash': { code: 0, stdout: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe\r\n' },
    })
    try {
      await pool.detect()
      assert.equal(pool.platform, 'windows')
      assert.equal(pool.gitBashPath, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'a cmd.exe default shell CAN exec the Windows-path wrapper — that is the working historical mode')
      assert.equal(pool.shellMode, 'git-bash')
    } finally {
      pool.close()
    }
  })
}

// ── regression guards ───────────────────────────────────────────────────────

for (const [label, make] of BOTH_BACKENDS) {
  test(`(${label}): a plain POSIX host is detected from uname alone — no cmd probe is spent`, async () => {
    const pool = make({ 'uname -s': { code: 0, stdout: 'Linux\n' } })
    try {
      await pool.detect()
      assert.equal(pool.platform, 'posix')
      assert.equal(pool.shellMode, 'native')
      assert.deepEqual(pool.__seen, ['uname -s'], 'a successful uname must short-circuit the Windows probes')
    } finally {
      pool.close()
    }
  })
}

for (const [label, make] of BOTH_BACKENDS) {
  test(`(${label}): shell:'native' on a POSIX-default-shell host stays raw`, async () => {
    const pool = make({
      'uname -s': { code: 0, stdout: 'MINGW64_NT-10.0-26300.9974\r\n' },
      'echo $0': { code: 0, stdout: 'bash\n' },
    })
    try {
      await pool.detect()
      assert.equal(pool.platform, 'windows')
      assert.equal(pool.shellMode, 'native', 'an explicit shell:native config must be honored')
      assert.equal(pool.gitBashPath, '')
    } finally {
      pool.close()
    }
  })
}

test('the platform detector is the single shared implementation (no copy in either backend)', () => {
  const poolSrc = readFileSync(new URL('../lib/pool.js', import.meta.url), 'utf8')
  const sshSrc = readFileSync(new URL('../lib/openssh.js', import.meta.url), 'utf8')
  assert.ok(poolSrc.includes("from './detect-platform.js'"), 'pool.js must import the shared detector')
  assert.ok(sshSrc.includes("from './detect-platform.js'"), 'openssh.js must import the shared detector')
  for (const src of [poolSrc, sshSrc]) {
    assert.ok(!/cmd \/c (ver|"ver")/.test(src.replace(/^ *\/\/.*$/gm, '')),
      'neither backend may keep its own ver-probe copy')
  }
})
