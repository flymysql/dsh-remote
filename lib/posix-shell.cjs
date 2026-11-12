'use strict'

/**
 * Quote one string for a POSIX shell using single quotes only.
 *
 * A single quote inside the value is emitted as the three-step sequence
 * close-quote, escaped-quote, reopen-quote. The result preserves the value
 * literally, including newlines, dollar signs, backticks and double quotes.
 *
 * @param {unknown} value
 * @returns {string}
 */
function quotePosix(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * Run a generated POSIX script through `sh` instead of the remote login shell.
 *
 * sshd gives an exec request to the user's login shell. That shell may be fish,
 * csh or another non-POSIX implementation, while this package's internal launch
 * and probe scripts are deliberately POSIX. The outer shell only has to parse
 * the simple `sh -c '<quoted script>'` invocation; `sh` then parses the actual
 * script. Generic rw_exec commands are NOT routed through this helper, so users
 * retain their login-shell semantics.
 *
 * @param {string} command
 * @returns {string}
 */
function posixViaSh(command) {
  return `sh -c ${quotePosix(command)}`
}

module.exports = { posixViaSh, quotePosix }
