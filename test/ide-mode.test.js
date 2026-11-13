import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Exercise the actual classic client helpers without exporting a production
// test API or depending on Chromium. The two slices are the pure persistence /
// geometry adapter boundaries, separate from the React component code.
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function section(start, end) {
  const from = source.indexOf(start), until = source.indexOf(end, from)
  assert.ok(from >= 0 && until > from, 'IDE client helper must be present: ' + start)
  return source.slice(from, until)
}
function loadState(storage = new Map()) {
  const window = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } }
  const helpers = new Function('window', section('    const REMOTE_IDE_KEY =', '    function useRemoteIdeState()') + '\nreturn { read:remoteIdeRead, set:remoteIdeSet, widths:remoteIdeWidths, watchers:remoteIdeWatchers, state:()=>remoteIdeState, key:REMOTE_IDE_KEY }')(window)
  return { ...helpers, window, storage }
}
class Element {
  constructor() {
    this.attrs = new Map()
    this.properties = new Map()
    this.style = {
      getPropertyValue: key => this.properties.get(key)?.value || '',
      getPropertyPriority: key => this.properties.get(key)?.priority || '',
      setProperty: (key, value, priority = '') => this.properties.set(key, { value, priority }),
      removeProperty: key => this.properties.delete(key),
    }
  }
  getAttribute(key) { return this.attrs.has(key) ? this.attrs.get(key) : null }
  setAttribute(key, value) { this.attrs.set(key, String(value)) }
  removeAttribute(key) { this.attrs.delete(key) }
  toggleAttribute(key, force) { if (force ?? !this.attrs.has(key)) this.attrs.set(key, ''); else this.attrs.delete(key) }
}
const dock = new Function(section('    function remoteIdeDock(node, kind)', '    function RemoteIdeShell()') + '\nreturn remoteIdeDock')()

test('IDE column preferences preserve center space and survive temporary narrow viewports', () => {
  const { widths } = loadState()
  const preferred = { left: 900, right: 900 }
  assert.deepEqual(widths(1000, preferred), { left: 380, right: 288, narrow: false })
  const clamped = widths(1200, { left: 5, right: 4 })
  assert.equal(clamped.left, 180); assert.equal(clamped.right, 280)
  assert.ok(1200 - clamped.left - clamped.right - 12 >= 320)
  assert.equal(widths(600, preferred).narrow, true)
  assert.deepEqual(preferred, { left: 900, right: 900 })
  assert.deepEqual(widths(1600, preferred), { left: 380, right: 700, narrow: false })
})

test('IDE mode and column widths persist, notify mounted shells, and recover from denied storage', () => {
  const state = loadState(), updates = []
  state.watchers.add(() => updates.push(state.state()))
  assert.equal(state.state().enabled, false)
  state.set({ enabled: true, left: 286, right: 410 })
  assert.equal(updates.length, 1)
  assert.deepEqual(loadState(state.storage).state(), { enabled: true, left: 286, right: 410 })
  state.set({ enabled: false })
  assert.deepEqual(loadState(state.storage).state(), { enabled: false, left: 286, right: 410 })
  state.window.localStorage.setItem = () => { throw new Error('private browsing') }
  assert.doesNotThrow(() => state.set({ enabled: true }))
  assert.equal(state.state().enabled, true); assert.equal(updates.length, 3)
  state.window.localStorage.getItem = () => '{broken'
  assert.deepEqual(state.read(), { enabled: false, left: 240, right: 400 })
})

test('IDE docking restores host attributes, original inert state and custom-property priorities exactly', () => {
  const element = new Element()
  element.setAttribute('data-rw-ide-editor', 'previous-owner')
  element.setAttribute('inert', 'host-owned')
  element.setAttribute('aria-hidden', 'false')
  element.style.setProperty('--rw-ide-x', '17px', 'important')
  element.style.setProperty('width', '45%')
  const initialAttrs = new Map(element.attrs), initialStyle = new Map(element.properties)
  const adapter = dock(element, 'editor')
  adapter.position({ left: 240, top: 38, width: 600, height: 800 }, true)
  assert.equal(element.getAttribute('inert'), 'host-owned')
  assert.equal(element.style.getPropertyValue('--rw-ide-w'), '600px')
  adapter.position({ left: 240, top: 38, width: 600, height: 800 }, false)
  assert.equal(element.getAttribute('data-rw-ide-hidden'), '')
  assert.equal(element.getAttribute('inert'), '')
  adapter.dispose()
  assert.deepEqual(element.attrs, initialAttrs)
  assert.deepEqual(element.properties, initialStyle)
})

test('hidden narrow IDE panes become inert and the original conversation is fully restored', () => {
  const element = new Element()
  element.setAttribute('data-conversation-session', 'remote-one')
  const adapter = dock(element, 'chat')
  adapter.position({ left: 0, top: 0, width: 0, height: 0 }, false)
  assert.equal(element.getAttribute('inert'), '')
  adapter.position({ left: 0, top: 38, width: 600, height: 800 }, true)
  assert.equal(element.getAttribute('inert'), null)
  assert.equal(element.getAttribute('data-rw-ide-hidden'), null)
  adapter.dispose()
  assert.deepEqual([...element.attrs], [['data-conversation-session', 'remote-one']])
  assert.equal(element.properties.size, 0)
})

test('IDE registration tolerates a replacement sidebar without the native sidebarRight service', () => {
  const registrations = [], effects = []
  const slots = { inject: (name, install) => install(), register: definition => { registrations.push(definition); return () => {} } }
  const ctx = {
    get: name => name === 'slots' ? slots : undefined,
    inject: (names, install) => { if (names.every(name => ctx.get(name))) install(ctx) },
  }
  const install = new Function('RemoteIdeToggle', 'RemoteIdeShell', 'let remoteIdeController=null;\n' + section('    function installRemoteIde(ctx)', '    function apply(ctx)') + '\nreturn installRemoteIde')(() => null, () => null)
  assert.doesNotThrow(() => install(ctx))
  assert.deepEqual(registrations.map(value => value.name), ['conversation.session.header.actions'])
  assert.equal(effects.length, 0)
  const controller = { mounted: { getSnapshot: () => undefined } }
  ctx.get = name => name === 'slots' ? slots : name === 'sidebarRight' ? controller : undefined
  ctx.effect = effect => effects.push(effect())
  assert.doesNotThrow(() => install(ctx))
  assert.ok(registrations.some(value => value.name === 'shell.overlay'))
  for (const dispose of effects) dispose()
})
