// Keep release candidates off npm's stable latest channel.
import semver from 'semver'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

export function releaseChannel(version) {
  if (typeof version !== 'string' || !/^\d/.test(version) || version.trim() !== version || !semver.valid(version)) throw new Error('Expected an exact package SemVer')
  const prerelease = semver.prerelease(version) !== null
  return { npmTag: prerelease ? 'next' : 'latest', prerelease }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const plan = releaseChannel(process.argv[2])
  for (const [key, value] of Object.entries(plan)) console.log(`${key}=${value}`)
}
