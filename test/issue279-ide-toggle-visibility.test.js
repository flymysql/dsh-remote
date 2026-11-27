// Issue #279 — the IDE-mode button is offered on every session's header even
// for users who always use the plain layout. A preference switch (settings →
// 插件偏好, default ON) now hides it; hiding the button does NOT touch
// remoteIdeState.enabled, so an IDE session already open keeps working.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function section(start, end) {
  const from = source.indexOf(start), until = source.indexOf(end, from)
  assert.ok(from >= 0 && until > from, 'the slice must be present: ' + start)
  return source.slice(from, until)
}

test('#279: the preference is independent of the layout enabled state', () => {
  const helpers = section('    const remoteIdeWatchers = new Set()', '    function remoteIdeWidths(')
  const store = new Map()
  const fns = new Function('window', helpers + '\nreturn { set: ideToggleSetVisible, read: () => ideToggleVisible, setLayout: remoteIdeSet, layout: () => remoteIdeState }')({
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  })
  // Default: the button is visible, the layout is off.
  assert.equal(fns.read(), true, 'the IDE button is visible by default')
  assert.equal(fns.layout().enabled, false)
  // Hiding the button must NOT disable the layout.
  fns.setLayout({ enabled: true })
  fns.set(false)
  assert.equal(fns.read(), false, 'the button can be hidden')
  assert.equal(fns.layout().enabled, true, 'the layout choice is untouched (#279: hiding is a preference, not a teardown)')
  // Persisted across a reload (a fresh function with the same storage).
  const again = new Function('window', helpers + '\nreturn { read: () => ideToggleVisible }')({
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  })
  assert.equal(again.read(), false, 'the hidden preference survives a reload')
})

test('#279: RemoteIdeToggle returns null when the preference hides it', () => {
  const toggle = source.slice(source.indexOf('    function RemoteIdeToggle(props)'))
  assert.ok(toggle.includes('useIdeToggleVisible()'), 'the toggle subscribes to the visibility preference')
  assert.ok(toggle.includes('if (!toggleVisible) return null'), 'a hidden preference renders no button')
})

test('#279: the settings panel exposes the switch (both locales, stable test id)', () => {
  assert.ok(source.includes("'data-testid': 'ide-toggle-visible'"), 'the preferences panel renders the switch with a stable test id')
  assert.ok(source.includes("'settings.ideToggleVisible': '显示「IDE 模式」按钮'"), 'zh label present')
  assert.ok(source.includes("'settings.ideToggleVisible': 'Show the IDE mode button'"), 'en label present')
})
