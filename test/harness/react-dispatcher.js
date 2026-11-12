// Install a positional test-hook dispatcher on React 18 or React 19.
//
// React 18 exposes { ReactCurrentDispatcher: { current } } and reads `.current`
// from that captured object. React 19 removed that shape; its client internals
// hold the active dispatcher directly in `H`. Keeping the version detection in
// one place prevents each UI test from hard-coding a private React 18 layout.
export function installTestDispatcher(React, dispatcher) {
  const react18 = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const react19 = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  if (react18 && react18.ReactCurrentDispatcher) {
    react18.ReactCurrentDispatcher.current = dispatcher
    return
  }
  if (react19 && Object.prototype.hasOwnProperty.call(react19, 'H')) {
    react19.H = dispatcher
    return
  }
  throw new Error(`Unsupported React ${React.version || ''}: no test dispatcher slot`)
}
