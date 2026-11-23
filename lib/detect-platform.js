// Shared remote platform / shell detection — the single implementation both
// backends (SshPool native ssh2 and SystemOpenSshPool) route through, the same
// way sftp-surface.js owns the SFTP surface. It replaced two verbatim copies
// that had already drifted (openssh lacked the %LOCALAPPDATA% Git Bash
// candidate), and centralized three fixes:
//
//   · issue #197 — a POSIX default shell (Git Bash / MSYS / Cygwin set as the
//     sshd DefaultShell) must be recognized BEFORE the cmd.exe probe:
//     `cmd /c ver` succeeds through Git Bash too, and the old order then picked
//     the Windows-path bash wrapper, which a POSIX default shell cannot exec
//     (quoted backslash paths arrive mangled). On such hosts bash is located
//     POSIX-style (`command -v bash` → /usr/bin/bash) so the `"bash" -s`
//     wrapper survives the default shell's own quoting.
//   · issue #199 — the token after `cmd /c` MUST be quoted: Windows OpenSSH
//     re-wraps the client command as `cmd.exe /c "…"`, and a bare `cmd /c ver`
//     reaches the inner cmd with a stray trailing quote (`'ver"' is not
//     recognized…`), which misdetected healthy cmd.exe hosts as POSIX.
//   · `uname` answering MINGW is ambiguous — it can also mean "cmd.exe default
//     shell with Git's usr/bin on PATH" — so `echo $0` disambiguates: a POSIX
//     shell prints its own name, cmd.exe echoes the literal "$0", PowerShell
//     prints nothing.
//
// The contract: `run(cmd, timeoutMs)` executes ONE raw command (no detection,
// no Git Bash wrapper) and resolves { code, stdout, stderr }; a REJECTED
// promise means the transport itself is broken (a failed command resolves with
// a non-zero code instead).

const PROBE_TIMEOUT_MS = 8000

/** Detect platform + shell mode + the Git Bash path. Resolves
 *  { platform: 'windows'|'posix'|'unknown', shellMode, gitBashPath }. */
export async function detectPlatform(run, config = {}) {
  const cap = () => Math.min(config.commandTimeoutMs || PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS)
  const shellCfg = String(config.shell || '').trim()

  // 1. A POSIX default shell answers `uname` itself; probe it FIRST (#197).
  let uname = null
  try {
    uname = await run('uname -s', cap())
  } catch {
    // The transport failed, not the command — everything below would too.
    return { platform: 'unknown', shellMode: 'native', gitBashPath: '' }
  }
  const unameOut = String((uname && uname.stdout) || '').trim()

  if (/mingw|msys|cygwin/i.test(unameOut)) {
    let posixDefaultShell = false
    try {
      const e = await run('echo $0', cap())
      const v = String((e && e.stdout) || '').trim()
      posixDefaultShell = v !== '' && !v.includes('$')
    } catch { /* conservative: treat as a non-POSIX default shell */ }
    if (posixDefaultShell) {
      return { platform: 'windows', ...(await resolveGitBashPosixDefault(run, shellCfg, cap)) }
    }
    // MSYS tools on PATH but a cmd.exe/PowerShell default shell: the regular
    // Windows resolution applies (a Windows-path bash that shell CAN exec).
    return { platform: 'windows', ...(await resolveGitBashWindows(run, shellCfg, cap)) }
  }
  // A uname that answered with anything else means a working POSIX shell —
  // no Windows probe needed (and `cmd` would only exist under Wine).
  if (uname && uname.code === 0 && unameOut) {
    return { platform: 'posix', shellMode: 'native', gitBashPath: '' }
  }

  // 2. cmd.exe / PowerShell default shell. The token after /c is quoted
  //    because of the sshd re-wrapping (#199) — see the header comment.
  let res = null
  try {
    res = await run('cmd /c "ver"', cap())
  } catch {
    return { platform: 'unknown', shellMode: 'native', gitBashPath: '' }
  }
  const out = String((res && res.stdout) || '') + '\n' + String((res && res.stderr) || '')
  if (res && res.code === 0 && /microsoft windows/i.test(out)) {
    return { platform: 'windows', ...(await resolveGitBashWindows(run, shellCfg, cap)) }
  }

  // 3. Nothing Windows answered — the historical POSIX default.
  return { platform: 'posix', shellMode: 'native', gitBashPath: '' }
}

/** Git Bash resolution for a cmd.exe/PowerShell default shell: every probe is
 *  a `cmd /c …` form, and the resolved path stays Windows-style because the
 *  wrapper is exec'd BY that shell. */
async function resolveGitBashWindows(run, shellCfg, cap) {
  const exists = async (p) => {
    try {
      const r = await run(`cmd /c if exist "${p}" (echo Y) else (echo N)`, cap())
      return /Y/.test(String((r && r.stdout) || ''))
    } catch {
      return false
    }
  }
  if (shellCfg && shellCfg !== 'git-bash' && shellCfg !== 'native') {
    if (await exists(shellCfg)) return { shellMode: 'git-bash', gitBashPath: shellCfg }
  }
  if (shellCfg === 'native') return { shellMode: 'native', gitBashPath: '' }
  try {
    const r = await run('cmd /c where bash', cap())
    const first = String((r && r.stdout) || '').trim().split(/\r?\n/)[0].trim()
    if (first) return { shellMode: 'git-bash', gitBashPath: first }
  } catch { /* fall through to the candidate list */ }
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    '%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe',
  ]
  for (const c of candidates) {
    if (await exists(c)) return { shellMode: 'git-bash', gitBashPath: c }
  }
  return { shellMode: 'git-bash', gitBashPath: '' } // wanted but not found — commands fall back to raw
}

/** Git Bash resolution when the DEFAULT SHELL is already POSIX (#197): every
 *  path must come out POSIX-style, because the default shell execs the
 *  `"bash" -s` wrapper itself and cannot parse quoted backslash paths. */
async function resolveGitBashPosixDefault(run, shellCfg, cap) {
  if (shellCfg === 'native') return { shellMode: 'native', gitBashPath: '' }
  const locate = async (p) => {
    // Quote only when needed (spaces etc.) — a bare `command -v bash` reads
    // cleaner in logs and behaves identically.
    const argv = /^[\w./%~:-]+$/.test(p) ? p : JSON.stringify(p)
    try {
      const r = await run(`command -v ${argv}`, cap())
      if (r && r.code === 0) {
        const first = String(r.stdout || '').trim().split(/\r?\n/)[0].trim()
        if (first) return first
      }
    } catch { /* try the next form */ }
    return ''
  }
  // A configured path is honored but normalized to forward slashes first.
  if (shellCfg && shellCfg !== 'git-bash') {
    const found = await locate(shellCfg.replace(/\\/g, '/'))
    if (found) return { shellMode: 'git-bash', gitBashPath: found }
  }
  const found = await locate('bash')
  if (found) return { shellMode: 'git-bash', gitBashPath: found }
  // No bash located: the default shell is POSIX anyway, so raw commands work.
  return { shellMode: 'native', gitBashPath: '' }
}
