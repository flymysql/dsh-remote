// The sentence `rw_connect` prints after it reaches a machine.
//
// Two identities are in play, and confusing them is what makes a working
// connection look broken (issue #51, #153):
//
//   • the DIAL identity — what the transport was actually told. On the
//     system-OpenSSH backend an ssh-config alias is handed to `ssh` VERBATIM:
//     the plugin emits no `-l`/`-p` (that is precisely what keeps the
//     `Host` block matching), so the dial identity carries no user and the
//     fallback port 22, while the file supplies both.
//   • the MACHINE identity — what `ssh <alias>` really reaches: the HostName,
//     User and Port ~/.ssh/config resolves for that alias.
//
// Reporting the dial identity produced "Connected to devbox as ." for a machine
// that connects perfectly as yangruitao@10.37.111.244. A sentence that reads
// like a missing username sends the agent — and the person reading it — looking
// for a configuration error that does not exist. Describe the MACHINE here; the
// dial identity stays where it belongs, in the audit log of the transport
// (`connect <dialUser>@<dialHost>:<dialPort>`, which `audit()` keeps).
//
// Kept as a pure function so the rule is testable without a live SSH server: an
// alias connect cannot be faked against the real `ssh` binary in CI (ssh reads
// the developer's own ~/.ssh/config, not the plugin's reader).
//
// `connectFailureText` is the failure half of the same idea: what `rw_connect`
// prints when the post-dial `echo ok` probe does not come back clean.

/**
 * @param {object} input
 * @param {string} [input.alias] - the ~/.ssh/config alias the registry stores ('' for a literal machine).
 * @param {boolean} [input.aliasNative] - true when the alias itself was dialed (system-OpenSSH backend).
 * @param {{host?: string, port?: number, username?: string}|null} [input.resolved] - what the file resolves the alias to.
 * @param {string} [input.dialHost] - host the transport was given.
 * @param {string} [input.dialUser] - user the transport was given ('' for an alias-native dial).
 * @param {number} [input.dialPort] - port the transport was given (fallback 22 for an alias-native dial).
 * @param {string[]} [input.warnings] - ~/.ssh/config directives the plugin could not honour.
 * @returns {string} one paragraph: "Connected to <machine> as <user>." plus the alias note.
 */
export function describeConnect({ alias = '', aliasNative = false, resolved = null, dialHost = '', dialUser = '', dialPort = 22, warnings = [] } = {}) {
  const name = String(alias || '')
  // The alias is what the user (and `ssh`) calls this machine, so an
  // alias-native dial is reported as the ALIAS, not as the address the file
  // happens to resolve it to today.
  const machineHost = aliasNative && name ? name : String(dialHost || '')
  const user = String((aliasNative && resolved && resolved.username) || (!aliasNative && dialUser) || '')
  const endpoint = {
    host: String((aliasNative && resolved && resolved.host) || dialHost || ''),
    port: Number(aliasNative && resolved && resolved.port) || Number(dialPort) || 22,
  }
  const note = (Array.isArray(warnings) ? warnings : []).filter(Boolean)
  const via = name
    ? `\n(ssh-config alias "${name}" → ${user ? user + '@' : ''}${endpoint.host}:${endpoint.port}` + (note.length ? `; ${note.join(' ')}` : '') + ')'
    : ''
  return `Connected to ${machineHost}${user ? ` as ${user}` : ''}.${via}`
}

/**
 * The failure half: what `rw_connect` prints when the post-dial `echo ok`
 * probe does not come back clean.
 *
 * pool.exec never rejects — its deadline RESOLVES with
 * `{ code: -1, signal: 'TIMEOUT', stdout: '', stderr: '' }` (both backends,
 * see the pool timers) — so the only way to see a probe timeout is the
 * `signal` field, exactly how the rw_info ping ("Ping: timeout"), the
 * connect-stage probe ("ssh timed out after Xms", dsh-remote-fix3) and the
 * exec tools ("[command timed out after Xms]") already treat this shape.
 * Reading only code/stderr degrades every slower-than-budget dial to a bare
 * `exit -1` and hides the one fact the user needs.
 *
 * @param {{code: number, signal?: string, stderr?: string}} res - the resolved pool.exec result.
 * @param {{host?: string, timeoutMs?: number}} [where] - dial host and probe budget, echoed in the message.
 * @returns {string} the detail after the literal `connect failed: ` prefix.
 */
export function connectFailureText(res, { host = '', timeoutMs = 0 } = {}) {
  if (res.signal === 'TIMEOUT') {
    return `the post-dial probe timed out after ${Number(timeoutMs) || 0}ms with no reply from ${String(host || 'the host')}`
      + ' — check the link (a dual-stack hostname whose ::1 blackholes can also stall every dial before the IPv4 fallback)'
  }
  return res.stderr || `exit ${res.code}`
}
