// Windows DPAPI script generation (issue #30).
//
// The Windows credential backend shells out to PowerShell:
//   [System.Security.Cryptography.ProtectedData]::Protect/Unprotect
// Windows PowerShell 5.1 does NOT preload System.Security, so the type is
// reported as "not found" unless `Add-Type -AssemblyName System.Security` runs
// first. Without that line every `加密保存密码` save failed, and the password was
// silently dropped (see test/route-errors.test.js for the fallback contract).
//
// Windows itself cannot be exercised from this suite, so the generated script —
// the exact artifact handed to `powershell -Command` — is asserted here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dpapiProtectScript, dpapiUnprotectScript, platformBackend } from '../lib/credential.js'

test('the protect script loads System.Security BEFORE touching ProtectedData', () => {
  const s = dpapiProtectScript('hunter2')
  const addType = s.indexOf('Add-Type -AssemblyName System.Security')
  const protect = s.indexOf('ProtectedData]::Protect')
  assert.ok(addType >= 0, 'the Add-Type preamble is mandatory on Windows PowerShell 5.1')
  assert.ok(protect > addType, 'Add-Type must precede the ProtectedData call')
  assert.match(s, /DataProtectionScope\]::CurrentUser/)
  assert.match(s, /\[Convert\]::ToBase64String/)
})

test('the unprotect script loads System.Security BEFORE touching ProtectedData', () => {
  const s = dpapiUnprotectScript('AAAA')
  const addType = s.indexOf('Add-Type -AssemblyName System.Security')
  const unprotect = s.indexOf('ProtectedData]::Unprotect')
  assert.ok(addType >= 0)
  assert.ok(unprotect > addType)
  assert.match(s, /FromBase64String\('AAAA'\)/)
  assert.match(s, /DataProtectionScope\]::CurrentUser/)
})

test('a password containing a single quote stays inside the PowerShell string', () => {
  const s = dpapiProtectScript("it's a 'secret'")
  // PowerShell escapes ' inside a single-quoted string by doubling it.
  assert.match(s, /\$p='it''s a ''secret''';/)
  assert.ok(!/\$p='it's/.test(s), 'an unescaped quote would break the command')
})

test('a base64 blob containing a single quote stays inside the PowerShell string', () => {
  const s = dpapiUnprotectScript("ab'cd")
  assert.match(s, /FromBase64String\('ab''cd'\)/)
})

test('platformBackend reports a known backend name', () => {
  assert.ok(['keychain', 'windows', 'secret'].includes(platformBackend()))
})
