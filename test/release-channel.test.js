import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseChannel } from '../scripts/release-channel.mjs'

test('release candidates and betas never replace stable latest', () => {
  for (const version of ['1.0.0-rc.1', '1.0.0-beta.2', '2.0.0-0']) assert.deepEqual(releaseChannel(version), { npmTag: 'next', prerelease: true })
  for (const version of ['0.8.94', '1.0.0', '2.1.3+build.4']) assert.deepEqual(releaseChannel(version), { npmTag: 'latest', prerelease: false })
})

test('release channel requires an exact version rather than an npm range or tag', () => {
  for (const invalid of ['', 'latest', '^1.0.0', 'v1.0.0', '../1.0.0', '1.0', null]) assert.throws(() => releaseChannel(invalid))
})
