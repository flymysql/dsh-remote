// Issue #172 — the plugin's remote-file explorer used to take over PURE LOCAL
// projects too: `routeWorkspaceFiles()` routed `remote || localWorkspaceSession`
// sessions to the plugin explorer, so a plain local workspace lost the host's
// own files panel (reveal / open-with / upload / create / archive). PR #176
// narrowed the takeover to sessions whose cwd actually sits inside a MIRROR
// (`mirrorForCwd`), the only world where the plugin explorer is the right tool.
//
// These tests pin the behavior at the routing boundary — the exact decision
// `remote ? NATIVE_EXPLORER : kind` — so the old shape cannot quietly return.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function section(start, end) {
  const from = source.indexOf(start), until = source.indexOf(end, from)
  assert.ok(from >= 0 && until > from, 'the routeWorkspaceFiles slice must be present: ' + start)
  return source.slice(from, until)
}

const EXPLORER = 'dsh-remote/explorer'
const MIRROR_DIR = '/home/me/.dsh/remote-workspaces/10.0.0.5-root-22/app'

/** Build routeWorkspaceFiles with injected closure collaborators. */
function makeRouter({ cwdForSession = () => '', mirrorForCwd = () => null, mirrorsLoaded = true } = {}) {
  const MIRRORS = { loaded: mirrorsLoaded, list: [{ dir: MIRROR_DIR }] }
  const ensureMirrors = () => Promise.resolve()
  const sessionCwdFor = (id) => cwdForSession(id)
  return new Function(
    'mirrorForCwd', 'MIRRORS', 'ensureMirrors', 'sessionCwdFor', 'NATIVE_EXPLORER',
    section('    function routeWorkspaceFiles(sidebar)', '    function registerNativeSidebar(inner)')
      + '\nreturn routeWorkspaceFiles',
  )(mirrorForCwd, MIRRORS, ensureMirrors, sessionCwdFor, EXPLORER)
}

/** A sidebar double whose openTab records what it was finally asked to open. */
function fakeSidebar() {
  const opened = []
  return {
    opened,
    mounted: { getSnapshot: () => 's-1' },
    openTab(kind) { opened.push(kind) },
  }
}

test('#172: a PLAIN LOCAL project keeps the host explorer — no plugin takeover', () => {
  // The reported shape: the session's cwd is an ordinary local directory that
  // belongs to no mirror. `localWorkspaceSession` was true for it, which is
  // exactly what the old `remote || localWorkspaceSession(sessionId)` matched.
  const router = makeRouter({
    cwdForSession: () => '/home/me/projects/purely-local',
    mirrorForCwd: (cwd) => (cwd === MIRROR_DIR ? { dir: MIRROR_DIR } : null),
  })
  const sidebar = fakeSidebar()
  const dispose = router(sidebar)
  try {
    sidebar.openTab('files')
    assert.deepEqual(sidebar.opened, ['files'],
      'the host keeps its own files panel (reveal / open-with / upload stay available)')
  } finally {
    dispose()
  }
})

test('#172: a session bound to a mirror IS routed to the plugin explorer', () => {
  const router = makeRouter({
    cwdForSession: () => MIRROR_DIR,
    mirrorForCwd: (cwd) => (cwd === MIRROR_DIR ? { dir: MIRROR_DIR } : null),
  })
  const sidebar = fakeSidebar()
  const dispose = router(sidebar)
  try {
    sidebar.openTab('files')
    assert.deepEqual(sidebar.opened, [EXPLORER], 'a mirror cwd is the plugin explorer\'s world')
  } finally {
    dispose()
  }
})

test('#172: other kinds are never rewritten, even for a mirror session', () => {
  const router = makeRouter({
    cwdForSession: () => MIRROR_DIR,
    mirrorForCwd: (cwd) => ({ dir: MIRROR_DIR }),
  })
  const sidebar = fakeSidebar()
  const dispose = router(sidebar)
  try {
    sidebar.openTab('terminal')
    sidebar.openTab('changes')
    assert.deepEqual(sidebar.opened, ['terminal', 'changes'], 'only kind "files" is ever rerouted')
  } finally {
    dispose()
  }
})

test('#172: a cold mirror registry still decides correctly after it loads', async () => {
  // ensureMirrors() is async on a cold page: the decision must land AFTER the
  // registry is ready, and a pure-local session must not flip mid-flight.
  const router = makeRouter({
    mirrorsLoaded: false,
    cwdForSession: () => '/home/me/projects/purely-local',
    mirrorForCwd: () => null,
  })
  const sidebar = fakeSidebar()
  const dispose = router(sidebar)
  try {
    sidebar.openTab('files')
    assert.deepEqual(sidebar.opened, [], 'the routing waits for the registry rather than guessing')
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(sidebar.opened, ['files'], 'once loaded: still the host explorer for a local project')
  } finally {
    dispose()
  }
})

test('#172: source pin — the takeover decision is the mirror lookup, never the old session-locality shape', () => {
  const slice = section('    function routeWorkspaceFiles(sidebar)', '    function registerNativeSidebar(inner)')
  assert.ok(slice.includes('const remote = mirrorForCwd(sessionCwdFor(sessionId), MIRRORS.list)'),
    'the decision must come from the mirror registry')
  assert.ok(slice.includes('next[kindIndex] = remote ? NATIVE_EXPLORER : kind'),
    'the PR #176 reroute line must stay')
  assert.ok(!slice.includes('localWorkspaceSession'),
    'session locality alone must never select the plugin explorer again — that is the #172 bug shape')
})
