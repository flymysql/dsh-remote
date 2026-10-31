// Client-half smoke test: evaluate lib/client.js the way the harness module
// loader does (a classic script registering via window.__ModuleLoader__.load),
// with stubbed `require` targets, then call apply() against a fake client ctx.
//
// It does not render React, but it does execute the module factory and the
// plugin's apply()/registration path — which is where a syntax error, a bad
// i18n dictionary or a missing client service would break the Settings page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

/** Minimal React stand-in: createElement returns a describable node. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}

/** Collect every registered client-side contribution. */
function makeClientCtx() {
  const state = { locales: [], slots: [], effects: [], sources: [], sections: [] }
  const ctx = {
    get(name) {
      if (name === 'locale') return { register: (ns, dicts) => state.locales.push({ ns, dicts }), bind: () => (k, p) => (p ? k + JSON.stringify(p) : k) }
      if (name === 'slots') {
        return {
          inject: (slot, fn) => { state.slots.push({ slot, fn }); return () => {} },
          get: () => [],
        }
      }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {} }) } }
      if (name === 'betterSidebar') return undefined
      if (name === 'sidebarRightTabs') return undefined
      if (name === 'directoryPicker') return undefined
      if (name === 'connection') return { send: async () => ({}) }
      return undefined
    },
    effect(fn) { state.effects.push(fn); const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(names, cb) { state.injected = names; if (names.every((n) => this.get(n) !== undefined)) cb(this) },
    on() {},
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  }
  return { ctx, state }
}

test('lib/client.js registers through the module loader and its apply() runs', () => {
  let loaded = null
  const sandbox = {
    window: {
      addEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {} },
      __ModuleLoader__: { load: (mod) => { loaded = mod } },
    },
    document: {
      head: { appendChild: () => {} },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
      getElementById: () => null,
    },
    setTimeout, clearTimeout, console,
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { relativeTime: () => ({ unit: 'now', n: 0 }) }
    throw new Error('unexpected require: ' + id)
  }
  // Execute the classic script with the sandboxed globals in scope.
  const run = new Function('window', 'document', 'setTimeout', 'clearTimeout', 'console', 'require', src)
  run(sandbox.window, sandbox.document, setTimeout, clearTimeout, console, requireStub)
  assert.ok(loaded, 'the script must register a module')
  assert.equal(loaded.id, 'dsh-remote')
  assert.equal(typeof loaded.factory, 'function')

  const mod = loaded.factory(requireStub)
  assert.equal(typeof mod.apply, 'function')

  const { ctx, state } = makeClientCtx()
  mod.apply(ctx)
  // The i18n dictionaries are the place where a missing/mismatched key breaks
  // the whole Settings page, so assert they were registered with BOTH locales.
  assert.equal(state.locales.length, 1)
  const { dicts } = state.locales[0]
  assert.ok(dicts.zh && dicts.en, 'zh + en dictionaries must both be registered')
  const zhKeys = Object.keys(dicts.zh).sort()
  const enKeys = Object.keys(dicts.en).sort()
  assert.deepEqual(enKeys, zhKeys, 'en must cover exactly the zh key set')
  const required = [
    // Issue #73: the first screen is the ~/.ssh/config host list, so these are the
    // strings the primary path depends on. The old import-panel keys
    // (sshImport/sshUseAlias/sshCopyFields/sshAliasHint) are gone with that panel —
    // the list is always visible now and each row has one 连接 action.
    'settings.pickHost', 'settings.hostListSource', 'settings.hostListRefresh',
    'settings.hostListEmpty', 'settings.hostConnect', 'settings.hostConnected',
    'settings.openSshConfig', 'settings.sshConfigOpened', 'settings.openWorkspace', 'settings.workspaceOpened',
    // The alias/ssh-config semantics the list still relies on.
    'settings.useSshConfig', 'settings.useSshConfigHint', 'settings.sshResolvedTo',
    'settings.sshResolvedNone', 'settings.sshResolvedWarn', 'settings.badgeSshConfig',
  ]
  for (const key of required) assert.ok(dicts.zh[key], `missing zh key ${key}`)
  assert.ok(state.slots.length > 0, 'the client half must contribute at least one slot')
})
