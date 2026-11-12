// dsh-remote — package entry point (package.json "main" / exports["."]).
//
// A thin shell around the real plugin body (lib/index.js). Its only job is to
// give the startup self-repair somewhere to live: ES module imports HOIST, so
// code placed inside index.js runs strictly after every static import of it
// has already been resolved — there is no room inside index.js to react to a
// missing sibling file. Dynamic import() is the only place such a guard can
// sit, hence this indirection.
//
// What happens here (see lib/self-heal.js for the policy):
//   import('./index.js') → on a missing-own-file crash (the half-updated
//   0.8.92 scenario, issue #126) the CURRENT version's tarball is re-laid from
//   npm and the import retried once. Healthy installs pay zero overhead: one
//   extra dynamic import of the same file the host would have loaded anyway.
//
// ★ TWO INVARIANTS protect this file:
//   1. Stay minimal and self-contained — only import lib/self-heal.js (which
//      only imports lib/update.js + node builtins). Anything richer could be
//      the file that is missing.
//   2. Re-export index.js's public surface EXACTLY. The cordis loader, the
//      settings UI and tests consume these names; test/self-heal-boot.test.js
//      pins the key set so index.js cannot gain an export this shell forgets
//      to forward.

import { importWithSelfHeal } from './self-heal.js'

const { module: main, repaired } = await importWithSelfHeal(() => import('./index.js'))

if (repaired) {
  console.warn('[dsh-remote] startup self-repair succeeded — the incomplete update has been fully re-applied and this boot is healthy')
}

export const name = main.name
export const DEFAULT_UPDATE_MODE = main.DEFAULT_UPDATE_MODE
export const decodePickStdout = main.decodePickStdout
export const win32FolderPickScript = main.win32FolderPickScript
export const LOCAL_BOOTSTRAP_TOOLS = main.LOCAL_BOOTSTRAP_TOOLS
export const normalizeLocalTools = main.normalizeLocalTools
export const pickWorkspaceNextStep = main.pickWorkspaceNextStep
export const inject = main.inject
export const Config = main.Config
export const apply = main.apply
