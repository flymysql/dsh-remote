import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shq, normalizeRemotePath, joinRemotePath, joinRemoteRel, resolveRemoteWorkspacePath, remoteDirname, mkdirRemoteDirs,
  toSftpPath, toShellPath, toDisplayPath, remotePathBase, remoteWorkspaceTitle, truncate, shortHash, relPathUnder,
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

test('remoteWorkspaceTitle qualifies a remote folder with its machine', () => {
  // The whole point: a remote /mnt/xdfs must not be confused with a local one.
  assert.equal(remoteWorkspaceTitle('/mnt/xdfs', { name: 'code-server', host: '10.16.152.64' }), 'code-server-xdfs')
  // Windows remotes use their own basename rules.
  assert.equal(remoteWorkspaceTitle('D:\\Code\\proj', { name: 'build-box' }), 'build-box-proj')
  // No display name → the host keeps the title unique.
  assert.equal(remoteWorkspaceTitle('/home/u/app', { name: '', host: '10.0.0.9' }), '10.0.0.9-app')
  // A machine named after the folder itself would read "xdfs-xdfs"; the host is
  // the more useful qualifier there.
  assert.equal(remoteWorkspaceTitle('/mnt/xdfs', { name: 'xdfs', host: '10.0.0.9' }), '10.0.0.9-xdfs')
  // A title must never be empty: no machine at all still yields the basename.
  assert.equal(remoteWorkspaceTitle('/mnt/xdfs'), 'xdfs')
  assert.equal(remoteWorkspaceTitle('/mnt/xdfs', { name: '', host: '' }), 'xdfs')
  // Filesystem roots get the synthetic basename, never an empty title.
  assert.equal(remoteWorkspaceTitle('/', { name: 'host' }), 'host-workspace')
})

test('relPathUnder', () => {
  assert.equal(relPathUnder('/a', '/a/b/c.txt'), 'b/c.txt')
  assert.equal(relPathUnder('/a', '/a'), '')
  assert.equal(relPathUnder('/a', '/b'), null)
  assert.equal(relPathUnder('D:\\a', 'D:\\a\\b'), 'b')
  assert.equal(relPathUnder('C:\\Users\\dev\\mirror', '/C:/Users/dev/mirror/docs/a.md'), 'docs/a.md')
})

test('joinRemoteRel + resolveRemoteWorkspacePath maps mirrorDir paths and relative paths onto ws', () => {
  assert.equal(joinRemoteRel('/home/u/proj', 'src/a/b.c'), '/home/u/proj/src/a/b.c')
  assert.equal(joinRemoteRel('D:\\work\\proj', 'src/a/b.c'), 'D:\\work\\proj\\src\\a\\b.c')

  const mirror = 'C:\\Users\\dev\\.dsh\\remote-workspaces\\box-22\\proj'
  const ws = '/home/opc/workspaces/proj'
  // Exact mirror root → remote workspace root
  assert.equal(resolveRemoteWorkspacePath(ws, mirror, mirror), '/home/opc/workspaces/proj')
  // Child inside the local mirror (Windows backslashes, forward slashes, or SFTP /C:/ form)
  assert.equal(resolveRemoteWorkspacePath(ws, `${mirror}\\docs\\outline.md`, mirror), '/home/opc/workspaces/proj/docs/outline.md')
  assert.equal(resolveRemoteWorkspacePath(ws, 'C:/Users/dev/.dsh/remote-workspaces/box-22/proj/docs', mirror), '/home/opc/workspaces/proj/docs')
  assert.equal(resolveRemoteWorkspacePath(ws, '/C:/Users/dev/.dsh/remote-workspaces/box-22/proj/docs', mirror), '/home/opc/workspaces/proj/docs')
  // Relative paths resolve under ws
  assert.equal(resolveRemoteWorkspacePath(ws, 'src/main.py', mirror), '/home/opc/workspaces/proj/src/main.py')
  assert.equal(resolveRemoteWorkspacePath(ws, './docs/a.md', mirror), '/home/opc/workspaces/proj/docs/a.md')
  assert.equal(resolveRemoteWorkspacePath(ws, '', mirror), '/home/opc/workspaces/proj')
  // Unrelated remote absolute paths pass through unchanged
  assert.equal(resolveRemoteWorkspacePath(ws, '/etc/hosts', mirror), '/etc/hosts')
  assert.equal(resolveRemoteWorkspacePath('D:\\work\\proj', 'D:\\other\\file.txt', mirror), 'D:\\other\\file.txt')
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
