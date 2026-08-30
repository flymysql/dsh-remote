import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shq, normalizeRemotePath, joinRemotePath, remoteDirname, mkdirRemoteDirs,
  toSftpPath, toShellPath, toDisplayPath, remotePathBase, truncate, shortHash, relPathUnder,
} from '../lib/paths.js'

test('shq quotes single quotes', () => {
  assert.equal(shq("it's"), `'it'\\''s'`)
  assert.equal(shq('/a b'), `'/a b'`)
})

test('normalizeRemotePath POSIX', () => {
  assert.equal(normalizeRemotePath('/home/user/proj'), '/home/user/proj')
  assert.equal(normalizeRemotePath('/a//b/../c'), '/a/c')
  assert.equal(normalizeRemotePath('relative'), '/relative')
  assert.equal(normalizeRemotePath('/'), '/')
})

test('normalizeRemotePath Windows drive + UNC', () => {
  assert.equal(normalizeRemotePath('D:\\Code'), 'D:\\Code')
  assert.equal(normalizeRemotePath('C:/Users/x'), 'C:\\Users\\x')
  assert.equal(normalizeRemotePath('\\\\server\\share\\a'), '\\\\server\\share\\a')
  assert.equal(normalizeRemotePath('D:\\a\\..\\b'), 'D:\\b')
})

test('joinRemotePath honors separators', () => {
  assert.equal(joinRemotePath('/a', 'b'), '/a/b')
  assert.equal(joinRemotePath('D:\\a', 'b'), 'D:\\a\\b')
  assert.equal(joinRemotePath('/a/', 'b'), '/a/b')
})

test('remoteDirname', () => {
  assert.equal(remoteDirname('/a/b/c'), '/a/b')
  assert.equal(remoteDirname('/a'), '/')
  assert.equal(remoteDirname('D:\\Code'), 'D:\\')
  assert.equal(remoteDirname('D:\\a\\b'), 'D:\\a')
})

test('toSftpPath converts drive letters', () => {
  assert.equal(toSftpPath('/a/b'), '/a/b')
  assert.equal(toSftpPath('D:\\Code'), '/D:/Code')
  assert.equal(toSftpPath('C:/Users/x'), '/C:/Users/x')
})

test('toShellPath → Git Bash mount form', () => {
  assert.equal(toShellPath('C:\\Users\\dev'), '/c/Users/dev')
  assert.equal(toShellPath('C:/Users/dev'), '/c/Users/dev')
  assert.equal(toShellPath('c:/Users/dev'), '/c/Users/dev')
  assert.equal(toShellPath('/c/Users/dev'), '/c/Users/dev')
  assert.equal(toShellPath('/C:/Users/dev'), '/c/Users/dev')
  assert.equal(toShellPath('C:'), '/c')
  assert.equal(toShellPath('C:\\'), '/c')
  assert.equal(toShellPath('C:\\Program Files'), '/c/Program Files')
  assert.equal(toShellPath('/c'), '/c')
  // POSIX passthrough + collapse
  assert.equal(toShellPath('/home/dev/code'), '/home/dev/code')
  assert.equal(toShellPath('/a//b/../c'), '/a/c')
  // UNC → //server/share
  assert.equal(toShellPath('\\\\server\\share\\x'), '//server/share/x')
})

test('toDisplayPath → Windows native form', () => {
  assert.equal(toDisplayPath('/c/Users/dev', 'windows'), 'C:\\Users\\dev')
  assert.equal(toDisplayPath('/c', 'windows'), 'C:\\')
  assert.equal(toDisplayPath('/C:/Users', 'windows'), 'C:\\Users')
  assert.equal(toDisplayPath('C:/Users', 'windows'), 'C:\\Users')
  assert.equal(toDisplayPath('', 'windows'), '')
  // POSIX-looking paths are NOT rewritten
  assert.equal(toDisplayPath('/home/dev', 'windows'), '/home/dev')
  // POSIX remotes pass through unchanged
  assert.equal(toDisplayPath('/c/Users', 'posix'), '/c/Users')
  assert.equal(toDisplayPath('/home/dev', 'posix'), '/home/dev')
})

test('remotePathBase', () => {
  assert.equal(remotePathBase('/home/user/proj'), 'proj')
  assert.equal(remotePathBase('D:\\Code\\x'), 'x')
  assert.equal(remotePathBase('D:\\'), 'workspace')
})

test('relPathUnder', () => {
  assert.equal(relPathUnder('/a', '/a/b/c.txt'), 'b/c.txt')
  assert.equal(relPathUnder('/a', '/a'), '')
  assert.equal(relPathUnder('/a', '/b'), null)
  assert.equal(relPathUnder('D:\\a', 'D:\\a\\b'), 'b')
})

test('truncate + shortHash', () => {
  assert.equal(truncate('abc', 2).startsWith('ab'), true)
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(shortHash('same'), shortHash('same'))
  assert.notEqual(shortHash('a'), shortHash('b'))
})

test('mkdirRemoteDirs creates parents AND the target (POSIX + Windows)', async () => {
  const made = []
  const sftp = { mkdir: async (p) => made.push(p) }
  await mkdirRemoteDirs(sftp, '/a/b/c')
  assert.deepEqual(made, ['/a', '/a/b', '/a/b/c'])
  made.length = 0
  // File callers pass the parent dir so the file path itself is never a dir.
  await mkdirRemoteDirs(sftp, remoteDirname('/a/b/f.txt'))
  assert.deepEqual(made, ['/a', '/a/b'])
  made.length = 0
  await mkdirRemoteDirs(sftp, 'D:\\x\\y\\z')
  assert.deepEqual(made, ['D:\\', 'D:\\x', 'D:\\x\\y', 'D:\\x\\y\\z'])
})
