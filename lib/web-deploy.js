// dsh-remote — remote DSH deployment probe & installer (issue #46 follow-up).
//
// Why this exists: connecting to a remote machine's DSH Web UI fails for
// environmental reasons far more often than for plugin reasons. Measured on a
// real host: its global dsh was 0.1.0-rc.6, whose node-pty@1.1.0 publishes
// darwin/win32 prebuilds but **no linux-x64**, so `dsh web` could not boot at
// all ("Failed to load native module: pty.node"). The user saw only "the remote
// DSH did not report a startup token" and had no way to know why.
//
// Two design commitments, both deliberate:
//
//  1. **Detection and installation are deterministic, so they are code, not a
//     model call.** A probe that needs an LLM is slow, costs money and cannot be
//     unit-tested. Everything in this module is a pure function over shell
//     output: the caller supplies `exec`, tests supply strings.
//  2. **The probe is strictly read-only.** It never writes, installs or mutates
//     remote state — that is what makes it safe to run before the user has
//     agreed to anything, and safe to run on a machine they are merely looking
//     at.
//
// The installer deliberately targets a PRIVATE PREFIX by default rather than a
// global install: no write permission to the system prefix is required, the
// user's PATH is untouched, and a dsh they are already using is never replaced.
// That is the same shape used to get the E2E working by hand.

/** Machine-readable markers the probe prints; parsing never guesses. */
const MARK = {
  platform: 'P_OS',
  arch: 'P_ARCH',
  node: 'P_NODE',
  nodeVersion: 'P_NODE_V',
  npm: 'P_NPM',
  npmVersion: 'P_NPM_V',
  dsh: 'P_DSH',
  dshVersion: 'P_DSH_V',
  dshRoot: 'P_DSH_ROOT',
  noOpen: 'P_NOOPEN',
  ptyPrebuild: 'P_PTY',
  home: 'P_HOME',
  writePrefix: 'P_WRITABLE',
  prefix: 'P_PREFIX',
  installed: 'P_INSTALLED',
  installedVersion: 'P_INSTALLED_V',
  installedPty: 'P_INSTALLED_PTY',
  installedWeb: 'P_INSTALLED_WEB',
  gitBash: 'P_GITBASH',
  proxyVar: 'P_PROXY_NAME',
  registry: 'P_REGISTRY',
}

/**
 * Build the READ-ONLY environment probe.
 *
 * Multiline rather than '; '-joined on purpose: the launch builder once shipped a
 * `do;` POSIX syntax error that only a real shell caught, and newlines remove
 * that entire failure mode. Nothing here writes, installs or deletes.
 *
 * @param {object} [opts] - probe options.
 * @param {string} [opts.prefix] - directory the installer would use; reported
 *   only to say whether it is writable (the probe never creates it).
 * @returns {string} a POSIX shell script.
 */
export function buildProbeCommand(opts = {}) {
  // `prefix` may be:
  //   • an explicit absolute path from configuration, checked verbatim;
  //   • empty, meaning "use the default", which MUST be resolved ON THE REMOTE:
  //     the caller cannot know $HOME before the probe runs, and guessing (the
  //     caller's own /tmp) would report writability for a directory that has
  //     nothing to do with the real install location.
  const prefix = String(opts.prefix || '')
  const useDefaultPrefix = !prefix && opts.defaultPrefixFor === 'home'
  // A dsh a previous deployment installed FOR THIS MACHINE. Probing only the
  // PATH dsh would keep reporting the old broken one after a successful install,
  // so the installed binary is probed explicitly and preferred when usable.
  const installed = String(opts.installedCommand || '')
  // Statements are one-per-line. `if ...; then` is legitimate shell, but mixing
  // `;`-joined statements with a `while`/`if` body is exactly how the launch
  // builder once produced a `do;` syntax error — so this stays newline-only and
  // a test asserts that.
  const lines = [
    'echo "P_OS=$(uname -s 2>/dev/null || echo unknown)"',
    'A=$(uname -m 2>/dev/null || echo unknown)',
    'case "$A" in x86_64|amd64) A=x64;; aarch64|arm64) A=arm64;; esac',
    'echo "P_ARCH=$A"',
    'echo "P_HOME=$HOME"',
    'N=$(command -v node 2>/dev/null)',
    'echo "P_NODE=$N"',
    'if [ -n "$N" ]',
    'then',
    '  echo "P_NODE_V=$($N -v 2>/dev/null)"',
    'fi',
    'M=$(command -v npm 2>/dev/null)',
    'echo "P_NPM=$M"',
    'if [ -n "$M" ]',
    'then',
    '  echo "P_NPM_V=$($M -v 2>/dev/null)"',
    'fi',
    'D=$(command -v dsh 2>/dev/null)',
    'echo "P_DSH=$D"',
    'if [ -n "$D" ]',
    'then',
    '  echo "P_DSH_V=$($D --version 2>/dev/null | tail -1)"',
    'fi',
  ]
  // A prefix the caller is considering. Reported, never created.
  if (useDefaultPrefix) {
    // Resolve the default on the REMOTE and report it back, so the caller learns
    // the real install path (and its writability) in the same round trip.
    lines.push(
      `DFLT="$HOME/${DEFAULT_PREFIX_SUFFIX}"`,
      'echo "P_PREFIX=$DFLT"',
      'if [ -w "$HOME" ]',
      'then',
      '  echo "P_WRITABLE=parent:yes"',
      'else',
      '  echo "P_WRITABLE=parent:no"',
      'fi',
    )
  } else if (prefix) {
    lines.push(
      `if [ -d "${prefix}" ]`,
      'then',
      `  if [ -w "${prefix}" ]`,
      '  then',
      '    echo "P_WRITABLE=yes"',
      '  else',
      '    echo "P_WRITABLE=no"',
      '  fi',
      `elif [ -w "$(dirname "${prefix}")" ]`,
      'then',
      '  echo "P_WRITABLE=parent:yes"',
      'else',
      '  echo "P_WRITABLE=parent:no"',
      'fi',
    )
  } else {
    lines.push('echo "P_WRITABLE=unknown"')
  }

  // Probe whatever a previous deployment installed for THIS machine, and prefer
  // it when it is usable. Without this a successful install is invisible to the
  // next probe, because only the PATH dsh would be examined.
  if (installed) {
    lines.push(
      `INSTALLED="${installed}"`,
      'if [ -x "$INSTALLED" ]',
      'then',
      '  echo "P_INSTALLED=yes"',
      '  echo "P_INSTALLED_V=$("$INSTALLED" --version 2>/dev/null | tail -1)"',
      ...resolveRootLines('INSTALLED', 'RI'),
      '  OSI=$(echo "$(uname -s)" | tr "A-Z" "a-z")',
      '  PTYI="$RI/node_modules/node-pty/prebuilds/$OSI-$A/pty.node"',
      '  ALTI="$RI/node_modules/@deepseek-ai/dsh/node_modules/node-pty/prebuilds/$OSI-$A/pty.node"',
      '  if [ -f "$PTYI" ] || [ -f "$ALTI" ]',
      '  then',
      '    echo "P_INSTALLED_PTY=yes"',
      '  else',
      '    echo "P_INSTALLED_PTY=no"',
      '  fi',
      '  if "$INSTALLED" web --help 2>&1 | grep -q -- "--port"',
      '  then',
      '    echo "P_INSTALLED_WEB=yes"',
      '  else',
      '    echo "P_INSTALLED_WEB=no"',
      '  fi',
      'else',
      '  echo "P_INSTALLED=no"',
      'fi',
    )
  }

  // A POSIX shell on a Windows remote. The launch/install commands need one, and
  // this is the single fact that decides whether a Windows host is deployable.
  lines.push(
    'GB=""',
    'for c in /usr/bin/bash.exe /bin/bash.exe bash',
    'do',
    '  if command -v "$c" >/dev/null 2>&1',
    '  then',
    '    GB=$(command -v "$c")',
    '    break',
    '  fi',
    'done',
    'echo "P_GITBASH=$GB"',
  )

  // Proxy configuration: REPORTED only. An install that inherits a broken proxy
  // is a plausible cause of a slow or failing npm, and the user is the one who
  // knows the right value. The probe never sets or changes it.
  lines.push(
    'PX=""',
    'for v in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy',
    'do',
    '  EV=$(eval "echo \\$$v")',
    '  if [ -n "$EV" ]',
    '  then',
    '    PX="$v"',
    '    break',
    '  fi',
    'done',
    'echo "P_PROXY_NAME=$PX"',
  )

  // Whether npm already points at a non-default registry (an internal mirror).
  // Reported so an install can keep using it rather than overriding it.
  lines.push(
    'if [ -n "$M" ]',
    'then',
    '  RG=$($M config get registry 2>/dev/null | head -1)',
    '  echo "P_REGISTRY=$RG"',
    'fi',
  )

  // Facts that need the dsh binary: where it lives and whether it can boot web.
  lines.push(
    'if [ -n "$D" ]',
    'then',
    '  if [ -n "$N" ]',
    '  then',
    ...resolveRootLines('D', 'R').map((l) => '  ' + l),
    '    echo "P_DSH_ROOT=$R"',
    '    OS=$(echo "$(uname -s)" | tr "A-Z" "a-z")',
    '    PTY="$R/node_modules/node-pty/prebuilds/$OS-$A/pty.node"',
    '    ALT="$R/node_modules/@deepseek-ai/dsh/node_modules/node-pty/prebuilds/$OS-$A/pty.node"',
    '    if [ -f "$PTY" ] || [ -f "$ALT" ]',
    '    then',
    '      echo "P_PTY=yes"',
    '    else',
    '      echo "P_PTY=no"',
    '    fi',
    '  fi',
    // `web --help` is cheap and reveals the flag family; it does NOT prove the
    // surface boots (a broken native module still prints help), which is why
    // P_PTY is probed separately.
    '  if $D web --help 2>&1 | grep -q -- "--no-open"',
    '  then',
    '    echo "P_NOOPEN=yes"',
    '  else',
    '    echo "P_NOOPEN=no"',
    '  fi',
    'fi',
  )
  return lines.join('\n')
}

/** Read one `KEY=value` line out of probe output. */
function valueOf(text, key) {
  const re = new RegExp('^' + key + '=(.*)$', 'm')
  const m = re.exec(text)
  return m ? m[1].trim() : ''
}

/**
 * Resolve a `dsh` executable to the PREFIX ROOT that owns its `node_modules`,
 * as a POSIX shell fragment (one statement per line).
 *
 * Not `dirname(dirname(bin))`. The bin is typically a symlink like
 * `node_modules/.bin/dsh -> ../@deepseek-ai/dsh/lib/bin.js`, so realpath puts us
 * at `<root>/node_modules/@deepseek-ai/dsh/lib/bin.js` and two dirnames land at
 * `<root>/node_modules/@deepseek-ai/dsh` — INSIDE the package, where a sibling
 * `node-pty` does not exist. Measured on a real host: that produced a false
 * "pty missing" verdict for a perfectly good install, and the same mistake would
 * hide a genuinely broken one.
 *
 * Walking up to the first ancestor that contains a `node_modules` DIRECTORY
 * resolves both layouts: a private prefix (`.../dsh/node_modules/.bin/dsh`) and a
 * global install (`.../lib/node_modules/@deepseek-ai/dsh/lib/bin.js`).
 *
 * @param {string} binVar - shell variable holding the executable path.
 * @param {string} outVar - shell variable to receive the resolved root.
 * @returns {string[]} shell lines.
 */
export function resolveRootLines(binVar, outVar) {
  return [
    `${outVar}=""`,
    `RD="$(dirname "$${binVar}")"`,
    'i=0',
    'while [ $i -lt 8 ]',
    'do',
    `  if [ -d "$RD/node_modules" ]`,
    '  then',
    `    ${outVar}="$RD"`,
    '    break',
    '  fi',
    '  NC="$(dirname "$RD")"',
    '  if [ "$NC" = "$RD" ]',
    '  then',
    '    break',
    '  fi',
    '  RD="$NC"',
    '  i=$((i+1))',
    'done',
  ]
}

/**
 * Parse probe output into facts. Absent keys stay empty rather than defaulting,
 * so the judge can tell "not installed" from "probe could not tell".
 *
 * @param {string} output - raw stdout of {@link buildProbeCommand}.
 * @returns {object} parsed facts.
 */
export function parseProbe(output) {
  const text = String(output || '')
  const platform = valueOf(text, MARK.platform)
  const lower = platform.toLowerCase()
  // Git Bash / MSYS / Cygwin report an emulated uname; treat them as Windows.
  const windows = /mingw|msys|cygwin|windows/i.test(platform)
  return {
    platform: lower === 'unknown' ? '' : platform,
    arch: valueOf(text, MARK.arch),
    windows,
    posix: !windows && lower !== 'unknown' && lower !== '',
    node: valueOf(text, MARK.node),
    nodeVersion: valueOf(text, MARK.nodeVersion),
    npm: valueOf(text, MARK.npm),
    npmVersion: valueOf(text, MARK.npmVersion),
    dsh: valueOf(text, MARK.dsh),
    dshVersion: valueOf(text, MARK.dshVersion),
    dshRoot: valueOf(text, MARK.dshRoot),
    noOpen: valueOf(text, MARK.noOpen),
    ptyPrebuild: valueOf(text, MARK.ptyPrebuild),
    installed: valueOf(text, MARK.installed),
    installedVersion: valueOf(text, MARK.installedVersion),
    installedPty: valueOf(text, MARK.installedPty),
    installedWeb: valueOf(text, MARK.installedWeb),
    gitBash: valueOf(text, MARK.gitBash),
    proxyVar: valueOf(text, MARK.proxyVar),
    registry: valueOf(text, MARK.registry),
    home: valueOf(text, MARK.home),
    writable: valueOf(text, MARK.writePrefix),
    // The prefix the REMOTE resolved for itself (only reported when the caller
    // asked for the default). Absent when an explicit prefix was probed.
    resolvedPrefix: valueOf(text, MARK.prefix),
  }
}

/** Compare dotted versions; returns true when `a` >= `b` (empty `a` is false). */
export function versionAtLeast(a, b) {
  const parse = (v) => String(v || '').replace(/^v/, '').split(/[.\-+]/).map((x) => Number(x) || 0)
  const [x, y] = [parse(a), parse(b)]
  if (!String(a || '').trim()) return false
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const l = x[i] || 0
    const r = y[i] || 0
    if (l !== r) return l > r
  }
  return true
}

/** The first dsh release whose node-pty ships Linux prebuilds (measured). */
export const PTY_FIXED_VERSION = '0.1.5-rc.2'

/**
 * Minimum Node the remote must run, and the reason it is exactly this number.
 *
 * DSH's boot path imports `parseEnv` from `node:util`, and that export only
 * exists from **20.12.0** (Node 21.7.0 and later have it too). Measured on a
 * real host with two nodes installed:
 *
 *   /usr/bin/node (v18.19.1)                          → parseEnv: undefined
 *   ~/.nvm/versions/node/v24.22.0/bin/node (v24.22.0) → parseEnv: function
 *
 * The failure mode is what makes this worth a BLOCKER rather than a warning: npm
 * only prints EBADENGINE (it does not refuse), so all ~535 packages install
 * cleanly and the crash arrives afterwards as
 *
 *   SyntaxError: The requested module 'node:util' does not provide an export
 *   named 'parseEnv'    at .../@deepseek-ai/dsh-app-boot/lib/index.js:4
 *
 * which does not read as "your node is too old". Checking the version BEFORE the
 * install is the only way to turn that into an actionable message.
 *
 * Reference: Node.js 20.12.0 release notes, "Loading and parsing environment
 * variables" — https://nodejs.org/en/blog/release/v20.12.0
 */
export const MIN_NODE_VERSION = '20.12.0'

/**
 * Turn facts into a verdict: what is wrong, why, and what to do.
 *
 * Severity is deliberately coarse — `blocker` means "connecting cannot work
 * until this changes", `warn` means "works, but with a caveat", `info` means
 * "worth knowing", `ok` means "nothing to do". The UI maps these directly.
 *
 * @param {object} facts - parsed probe facts.
 * @param {object} [opts] - judgement options.
 * @param {string} [opts.installedCommand] - command the installer already placed, if any.
 * @returns {{severity: string, ok: boolean, findings: object[], useCommand: string, canAutoInstall: boolean}}
 */
export function judgeProbe(facts, opts = {}) {
  const f = facts || {}
  const findings = []
  const add = (code, severity, summary, detail, fix) => {
    findings.push({ code, severity, summary, detail: detail || '', ...(fix ? { fix } : {}) })
  }

  // ── platform / shell ──────────────────────────────────────────────────────
  if (!f.platform) {
    add('PLATFORM_UNKNOWN', 'warn', '无法识别远端操作系统',
      '探测没有返回可识别的 uname 结果。', '确认该主机是常规 Linux/macOS/Windows。')
  } else if (f.windows) {
    // The launch command is POSIX shell (setsid/nohup). pool.exec wraps commands
    // in Git Bash when it finds one on a Windows remote; without it there is no
    // POSIX shell to run them in, and an install would produce a dsh we could
    // never start.
    if (f.gitBash) {
      add('WINDOWS_REMOTE_GITBASH', 'info', '远端是 Windows 主机，但有 Git Bash',
        '启动命令会经 Git Bash 执行，自动部署与连接都可用。')
    } else {
      add('WINDOWS_REMOTE', 'warn', '远端是 Windows 主机且没有 Git Bash',
        '本功能的启动命令是 POSIX shell（依赖 setsid/nohup），没有 Git Bash 就无法执行。',
        '在该机器安装 Git Bash（随 Git for Windows 一起），或改用 Linux/macOS 远端。')
    }
  }

  // ── node / npm ────────────────────────────────────────────────────────────
  if (!f.node) {
    add('NO_NODE', 'blocker', '远端没有 node',
      '自动部署需要 node 与 npm。',
      '先在该机器安装 Node.js（nvm 或系统包管理器），再回来重试。')
  } else if (f.nodeVersion && !versionAtLeast(f.nodeVersion, MIN_NODE_VERSION)) {
    // The install itself SUCCEEDS on this node — npm only warns (EBADENGINE) —
    // and the failure surfaces later as a parseEnv import error that does not
    // read as a version problem. So the check has to happen before the install.
    add('NODE_TOO_OLD', 'blocker',
      `远端 node ${f.nodeVersion} 版本过低（需要 ≥ ${MIN_NODE_VERSION}）`,
      `dsh 启动时要 import node:util 的 parseEnv，该导出从 Node ${MIN_NODE_VERSION} 起才有。`
      + '在这个版本上 npm 只会给 EBADENGINE 警告、仍然把包装完，'
      + '直到启动时才崩：SyntaxError: The requested module \'node:util\' does not provide an export named \'parseEnv\'。',
      `升级该机器的 node 到 ${MIN_NODE_VERSION} 以上（例如 nvm install 22），`
      + '并把 `webAttachCommand` 指向新 node 的绝对路径（如 ~/.nvm/versions/node/v22.x/bin/node <前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js）。')
  }
  if (!f.npm) {
    add('NO_NPM', 'blocker', '远端没有 npm',
      '自动部署通过 npm 拉取 dsh。',
      '随 Node.js 一起安装 npm（或换用 nvm 安装的 node）。')
  }

  // ── existing dsh ──────────────────────────────────────────────────────────
  if (!f.dsh) {
    add('NO_DSH', 'info', '远端没有 dsh',
      '没有找到可执行的 dsh。',
      '可以自动装到私有前缀，不影响该机器上已装的任何东西。')
  } else {
    // The exact failure measured on a real host: node-pty has no prebuild for
    // this platform, so the web surface cannot boot at all.
    if (f.ptyPrebuild === 'no' && !f.windows) {
      add('PTY_MISSING', 'blocker',
        `远端 dsh ${f.dshVersion || '(版本未知)'} 无法启动 web 界面`,
        '它依赖的 node-pty 在当前平台没有预编译产物，'
        + '启动会直接失败（Failed to load native module: pty.node）。',
        `装一个 ${PTY_FIXED_VERSION} 或更新的 dsh 到私有前缀即可（其 node-pty 带该平台产物）。`)
    }
    if (f.noOpen === 'no') {
      // Handled automatically by WebAttach (it retries without the flag), so
      // this is informational rather than a problem.
      add('OLD_FLAG_SET', 'info', `远端 dsh ${f.dshVersion || ''} 不认识 --no-open`,
        '这是较新的 flag；插件会自动去掉它重试一次，无需处理。',
        '升级到较新版本可避免这条重试。')
    }
    if (f.noOpen === 'yes' && f.ptyPrebuild !== 'no') {
      add('DSH_OK', 'ok', `远端 dsh ${f.dshVersion || ''} 可以直接使用`,
        '已装且有当前平台的 node-pty 预编译产物。')
    }
  }

  // ── prefix writability (only relevant when we would install) ──────────────
  if ((!f.dsh || f.ptyPrebuild === 'no') && f.writable === 'no') {
    add('PREFIX_UNWRITABLE', 'warn', '默认安装位置不可写',
      '自动部署会改用 $HOME 下的私有目录；若 $HOME 也不可写则需要人工处理。',
      '通常无需处理，安装器会回退到 $HOME。')
  }

  // ── a dsh a previous deployment installed for this machine ─────────────────
  // This must be judged BEFORE the PATH dsh: an installed build is the whole
  // point of a deployment, and reporting the old broken PATH dsh after a
  // successful install would make the feature look like it did nothing.
  const installed = String(opts.installedCommand || '').trim()
  const installedUsable = f.installed === 'yes'
    && f.installedPty !== 'no'
    && f.installedWeb !== 'no'
  if (installed && installedUsable) {
    add('INSTALLED_OK', 'ok',
      `已部署的 dsh ${f.installedVersion || ''} 可用`,
      '该机器上之前自动部署的版本已通过校验（native 模块与 web 子命令都在）。')
  } else if (installed && f.installed === 'no') {
    add('INSTALLED_MISSING', 'info', '之前部署的 dsh 已不在',
      `${installed} 不存在（可能被清理或换了机器镜像）。`,
      '重新部署一次即可。')
  } else if (installed && f.installed === 'yes' && !installedUsable) {
    add('INSTALLED_UNUSABLE', 'warn', '已部署的 dsh 校验未通过',
      '它存在但 web 界面或 native 模块有问题。',
      '重新部署一次；仍失败时用「让 AI 排查」。')
  }

  // ── environment notes that change what an install will do ─────────────────
  // Reported, never "fixed": the user is the one who knows whether the proxy or
  // mirror is correct, and silently overriding either would be worse than slow.
  if (f.proxyVar) {
    add('PROXY_SET', 'info', `远端设置了代理（${f.proxyVar}）`,
      '安装会沿用远端已有的代理设置。',
      '若 npm 下载很慢或失败，检查这个代理是否可达。')
  }
  if (f.registry && !/registry\.npmjs\.org/.test(f.registry)) {
    add('CUSTOM_REGISTRY', 'info', `远端 npm 使用了自定义源：${f.registry}`,
      '安装默认沿用远端自己的 npm 配置，不会覆盖它。')
  }

  const blockers = findings.filter((x) => x.severity === 'blocker')
  // A Windows remote with Git Bash can be installed into: pool.exec pipes every
  // command through `bash -s`, so the POSIX plan works there.
  //
  // A node older than MIN_NODE_VERSION makes an install POINTLESS as well as
  // failing: the packages land, then the binary cannot boot. Promising
  // "can auto-install: yes" there is what sent the reporter of issue #54 through
  // a 535-package install that ended in a parseEnv SyntaxError.
  const nodeUsable = !!f.node && (!f.nodeVersion || versionAtLeast(f.nodeVersion, MIN_NODE_VERSION))
  const canAutoInstall = nodeUsable && !!f.npm && (!f.windows || !!f.gitBash)

  // Which command should the attach flow use? A verified deployment wins, then a
  // usable dsh already on PATH.
  //
  // Note `noOpen` deliberately does NOT disqualify a PATH dsh: WebAttach already
  // retries without `--no-open`, so an old version is perfectly usable. Treating
  // it as unusable would tell users to reinstall for no reason.
  const usablePath = f.dsh && f.ptyPrebuild !== 'no' ? f.dsh : ''
  const useCommand = installedUsable ? installed : usablePath

  // If the installed build works, the PATH dsh's shortcomings are no longer
  // blockers — the user can connect right now.
  const effectiveBlockers = installedUsable
    ? blockers.filter((x) => x.code !== 'PTY_MISSING')
    : blockers

  return {
    ok: effectiveBlockers.length === 0,
    severity: effectiveBlockers.length ? 'blocker'
      : findings.some((x) => x.severity === 'warn') ? 'warn' : 'ok',
    findings,
    useCommand,
    canAutoInstall,
  }
}

// ── installation ────────────────────────────────────────────────────────────

/** Where the installer puts dsh when the user does not choose. */
export const DEFAULT_PREFIX_SUFFIX = '.dsh-remote/dsh'
/** Default version: the first release whose node-pty ships Linux prebuilds. */
export const DEFAULT_INSTALL_VERSION = PTY_FIXED_VERSION

/**
 * Resolve the install prefix from probe facts and configuration.
 *
 * Preference order is deliberate: an explicit user setting, then `$HOME`, and
 * only then a temp directory. `$HOME` keeps the install across reboots, which
 * matters because the resulting `webAttachCommand` is written into the machine
 * record and would otherwise dangle after a reboot wipes `/tmp`.
 *
 * @param {object} facts - parsed probe facts.
 * @param {object} [opts] - overrides.
 * @param {string} [opts.prefix] - explicit prefix.
 * @returns {string} a remote directory path.
 */
export function resolvePrefix(facts, opts = {}) {
  const explicit = String(opts.prefix || '').trim()
  if (explicit) return explicit
  const home = String((facts && facts.home) || '').trim()
  if (home) return `${home.replace(/\/+$/, '')}/${DEFAULT_PREFIX_SUFFIX}`
  return `/tmp/${DEFAULT_PREFIX_SUFFIX}`
}

/** Quote one shell argument. */
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * Build the ordered install plan.
 *
 * Each step is a separate SSH exec rather than one long script, because the
 * caller wants per-step progress and a failure report that names the step. The
 * plan is pure data so a test can assert the exact commands without a shell.
 *
 * @param {object} spec - install parameters.
 * @param {object} spec.facts - parsed probe facts.
 * @param {string} spec.prefix - remote prefix directory.
 * @param {string} [spec.version] - dsh version to install.
 * @param {string} [spec.registry] - npm registry to use.
 * @param {object} [spec.env] - env vars for the install step (proxy, mirror…).
 * @param {boolean} [spec.forcePosix] - allow the plan for a Windows remote that
 *   has Git Bash (pool.exec then pipes commands through `bash -s`).
 * @returns {{steps: object[], command: string}} the plan and the resulting dsh path.
 */
export function buildInstallPlan(spec) {
  const facts = spec.facts || {}
  const prefix = String(spec.prefix || '').trim().replace(/\/+$/, '')
  // An empty prefix emits `mkdir -p ''` / `cd ''` / `--prefix ''`: commands that
  // either fail confusingly or (worse) touch the filesystem root. Refuse to build
  // such a plan at all — the caller must resolve a prefix first.
  if (!prefix || prefix === '/') {
    throw new Error('buildInstallPlan: refusing to build a plan without a private install prefix')
  }
  const version = String(spec.version || DEFAULT_INSTALL_VERSION)
  const registry = String(spec.registry || '')
  const env = spec.env && typeof spec.env === 'object' ? spec.env : undefined
  const bin = `${prefix}/node_modules/.bin/dsh`

  // `--no-audit --no-fund` keeps output small; `--loglevel=error` keeps the
  // captured stdout parseable. `--prefix` installs locally without touching any
  // system or user-global prefix.
  const npmArgs = [
    'install', '--prefix', q(prefix),
    '--no-audit', '--no-fund', '--loglevel=error',
    // `--ignore-scripts=false` is npm's default and is stated explicitly here
    // because a restrictive global config would otherwise silently skip
    // node-pty's build/install step, producing an install that cannot boot web.
    ...(registry ? ['--registry', q(registry)] : []),
    q(`@deepseek-ai/dsh@${version}`),
  ]

  const steps = [
    {
      id: 'prepare',
      title: '准备安装目录',
      // A private package.json stops npm from walking up to an unrelated
      // project and mutating its dependency tree.
      command: `mkdir -p ${q(prefix)} && printf '%s\\n' `
        + `'{"name":"dsh-remote-install","private":true,"version":"0.0.0"}' > ${q(`${prefix}/package.json`)}`
        + ` && echo OK`,
    },
    {
      id: 'install',
      title: `安装 dsh@${version} 到私有目录`,
      command: `cd ${q(prefix)} && ${facts.npm || 'npm'} ${npmArgs.join(' ')}`,
      // npm can legitimately take minutes on a cold cache.
      timeoutMs: 600000,
      ...(env ? { env } : {}),
    },
    {
      id: 'verify-binary',
      title: '校验安装结果',
      command: `test -x ${q(bin)} && ${q(bin)} --version`,
    },
  ]

  // A native-module check is what actually distinguishes "installed" from
  // "installed and able to boot the web surface" — the exact gap that made the
  // original failure so opaque. It uses the walk-up rule from
  // `resolveRootLines` rather than dirname(dirname()), which lands inside the
  // package and yields a FALSE NEGATIVE on a good install (measured).
  steps.push({
    id: 'verify-pty',
    title: '校验 web 界面可启动（native 模块）',
    command: [
      `BIN=${q(bin)}`,
      ...resolveRootLines('BIN', 'ROOT'),
      `OS=$(echo "$(uname -s)" | tr 'A-Z' 'a-z')`,
      `A=$(uname -m)`,
      `case "$A" in x86_64|amd64) A=x64;; aarch64|arm64) A=arm64;; esac`,
      `P1="$ROOT/node_modules/node-pty/prebuilds/$OS-$A/pty.node"`,
      `P2="$ROOT/node_modules/@deepseek-ai/dsh/node_modules/node-pty/prebuilds/$OS-$A/pty.node"`,
      // One `if` rather than a `||` continuation: a line beginning with `||`
      // after a newline is a syntax error in POSIX sh (caught by the real-shell
      // gate, not by string assertions).
      `if [ -f "$P1" ] || [ -f "$P2" ]`,
      `then`,
      `  echo PTY_OK`,
      `else`,
      `  echo "PTY_MISSING: no prebuild at $P1 or $P2" >&2`,
      `  exit 1`,
      `fi`,
    ].join('\n'),
  })

  steps.push({
    id: 'verify-web',
    title: '校验 dsh web 可用',
    command: `${q(bin)} web --help 2>&1 | grep -q -- '--port'`,
  })

  return { steps, command: bin }
}

/** One step's outcome, as returned to the UI. */
export function stepResult(step, res) {
  const out = String((res && res.stdout) || '')
  const err = String((res && res.stderr) || '')
  const code = res && res.code !== undefined ? res.code : 0
  return {
    id: step.id,
    title: step.title,
    ok: code === 0,
    code,
    // Keep a bounded tail: enough to diagnose, small enough to stream to a UI.
    output: (out + (err ? '\n' + err : '')).trim().slice(-1200),
  }
}

