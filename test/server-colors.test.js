import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('    const serverPalette ='), source.indexOf('    /** `user@host:port`'))
function load(storage) {
  const context = vm.createContext(storage ? { localStorage: storage } : {})
  vm.runInContext(code, context)
  return context.mirrorColor
}
test('server colors distinguish eight endpoints and ignore accounts and paths', () => {
  const color = load()
  const first = color({ host: 'server-a' })
  assert.equal(first, color({ host: 'SERVER-A', port: 22, username: 'other', remotePath: '/other' }))
  const colors = [first, ...Array.from({ length: 7 }, (_, i) => color({ host: `server-${i}` }))]
  assert.equal(new Set(colors).size, 8)
})
test('colors persist across reload and new server allocation', () => {
  const store = new Map()
  const storage = { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) }
  const color = load(storage)
  const first = color({ host: 'a' })
  color({ host: 'b' })
  assert.equal(load(storage)({ host: 'a' }), first)
})
test('missing or corrupt storage does not prevent rendering', () => {
  for (const storage of [undefined, { getItem() { return 'invalid' } }, { getItem() { throw Error('blocked') } }]) {
    assert.match(load(storage)({ host: 'a' }), /^#[0-9a-f]{6}$/)
  }
})
test('all three remote badge surfaces share server colors', () => {
  assert.equal((source.match(/background: mirrorColor\(m\)/g) || []).length, 3)
})
