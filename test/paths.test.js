import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shq, normalizeRemotePath, joinRemotePath, remoteDirname, mkdirRemoteDirs,
  toSftpPath, remotePathBase, truncate, shortHash, relPathUnder,
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

test('mkdirRemoteDirs creates every level (POSIX + Windows)', async () => {
  const made = []
  const sftp = { mkdir: async (p) => made.push(p) }
  await mkdirRemoteDirs(sftp, '/a/b/c.txt')
  assert.deepEqual(made, ['/a', '/a/b'])
  made.length = 0
  await mkdirRemoteDirs(sftp, 'D:\\x\\y\\f.txt')
  assert.deepEqual(made, ['D:\\', 'D:\\x', 'D:\\x\\y'])
})
