// ssh-config agent identities: `IdentityFile ~/.ssh/%n.pub` + `IdentityAgent`.
//
// The report: a machine whose ~/.ssh/config reads
//
//     Host *
//         IdentityAgent /path/to/rbw/ssh-agent-socket
//     Host *
//         IdentitiesOnly yes
//         IdentityFile ~/.flinty/ssh/%n.pub
//
// failed with `cannot read private key ".../%n.pub"`: the `%n` token was not
// expanded, and the PUBLIC key file (OpenSSH's "use this agent key" idiom) was
// read as a private key. IdentityAgent was ignored too.
//
// Part A pins the resolver (tokens, IdentityAgent, IdentitiesOnly). Part B
// connects a REAL SshPool to an in-process ssh2 server through an in-process
// agent socket and proves the `.pub` path selects the matching agent key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import ssh2 from 'ssh2'
import { resolveMachineSshConfig, sshAliasTarget, expandSshTokens } from '../lib/sshconfig.js'
import { SshPool, isPublicKeyPath, publicKeyBlob, PreferredKeyAgent } from '../lib/pool.js'

const LF = '\n'
const { utils, Server, AgentProtocol } = ssh2

// ── Part A: resolution ────────────────────────────────────────────────────

const CONFIG = [
  'Host *',
  '  IdentityAgent ~/agent.sock',
  '',
  'Host box',
  '  HostName 10.0.0.5',
  '  User alice',
  '',
  'Host *',
  '  IdentitiesOnly yes',
  '  IdentityFile ~/.keys/%n-%r@%h:%p.pub',
].join(LF)

test('IdentityFile tokens (%n %r %h %p) are expanded per alias', () => {
  const t = sshAliasTarget('box', { text: CONFIG })
  assert.equal(t.privateKeyPath, path.join(homedir(), '.keys', 'box-alice@10.0.0.5:22.pub'))
})

test('IdentityAgent and IdentitiesOnly reach the machine resolution', () => {
  const r = resolveMachineSshConfig({ host: 'box', useSshConfig: true }, { text: CONFIG })
  assert.equal(r.agentSocket, path.join(homedir(), 'agent.sock'))
  assert.equal(r.identitiesOnly, true)
})

test('IdentityAgent SSH_AUTH_SOCK / none / $VAR', () => {
  const at = (v) => sshAliasTarget('x', { text: `Host x${LF}  IdentityAgent ${v}` }).agentSocket
  assert.equal(at('SSH_AUTH_SOCK'), '')
  assert.equal(at('none'), 'none')
  process.env.DSH_TEST_AGENT_SOCK = '/tmp/some.sock'
  try {
    assert.equal(at('$DSH_TEST_AGENT_SOCK'), '/tmp/some.sock')
    assert.equal(at('${DSH_TEST_AGENT_SOCK}'), '/tmp/some.sock')
  } finally { delete process.env.DSH_TEST_AGENT_SOCK }
})

test('expandSshTokens: %% is literal, unknown tokens are kept', () => {
  assert.equal(expandSshTokens('a%%b%Zc', {}), 'a%b%Zc')
  assert.equal(expandSshTokens('%d/x', {}), `${homedir()}/x`)
})

test('isPublicKeyPath / publicKeyBlob', () => {
  assert.equal(isPublicKeyPath('/k/id.pub'), true)
  assert.equal(isPublicKeyPath('/k/id'), false)
  const pair = utils.generateKeyPairSync('ed25519')
  const blob = publicKeyBlob(pair.public)
  assert.ok(Buffer.from(utils.parseKey(pair.public).getPublicSSH()).equals(blob))
  assert.equal(publicKeyBlob('garbage'), null)
})

test('PreferredKeyAgent puts the wanted key first, or alone with IdentitiesOnly', async () => {
  const a = utils.parseKey(utils.generateKeyPairSync('ed25519').public)
  const b = utils.parseKey(utils.generateKeyPairSync('ed25519').public)
  const inner = { getIdentities: (cb) => cb(null, [a, b]), sign: () => {} }
  const want = Buffer.from(b.getPublicSSH())
  const list = (only) => new Promise((resolve, reject) => {
    new PreferredKeyAgent(inner, want, only).getIdentities((err, keys) => (err ? reject(err) : resolve(keys)))
  })
  assert.deepEqual(await list(false), [b, a])
  assert.deepEqual(await list(true), [b])
})

// ── Part B: a real connect through an agent socket ────────────────────────

/** An ssh-agent on a unix socket holding `keys` (parsed private keys). */
function startAgent(sockPath, keys) {
  const server = net.createServer((sock) => {
    const proto = new AgentProtocol(false)
    proto.on('identities', (req) => proto.getIdentitiesReply(req, keys))
    proto.on('sign', (req, pubKey, data) => {
      const blob = Buffer.from(pubKey.getPublicSSH())
      const key = keys.find((k) => Buffer.from(k.getPublicSSH()).equals(blob))
      if (!key) return proto.failureReply(req)
      proto.signReply(req, key.sign(data))
    })
    proto.on('error', () => {})
    sock.on('error', () => {})
    sock.pipe(proto).pipe(sock)
  })
  return new Promise((resolve) => server.listen(sockPath, () => resolve(server)))
}

/** An ssh server accepting only `allowed` (public key line); records offers. */
function startServer(allowed) {
  const offered = []
  const allowedBlob = publicKeyBlob(allowed)
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
      offered.push(Buffer.from(ctx.key.data))
      if (!ctx.key.data.equals(allowedBlob)) return ctx.reject(['publickey'])
      if (!ctx.signature) return ctx.accept()
      const pk = utils.parseKey(allowed)
      return pk.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject()
    })
    client.on('ready', () => {})
    client.on('error', () => {})
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, offered, port: server.address().port })))
}

test('a .pub IdentityFile + IdentityAgent authenticates with the matching agent key only', async (t) => {
  // unix socket paths are length-limited: keep the dir short. Windows cannot
  // listen on a file path at all — an agent there is a named pipe (which
  // ssh2's createAgent also treats as an OpenSSH agent).
  const dir = mkdtempSync(path.join(tmpdir(), 'dra-'))
  const sockPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\dra-${path.basename(dir)}`
    : path.join(dir, 'a.sock')
  const pairs = [0, 1, 2].map(() => utils.generateKeyPairSync('ed25519'))
  const agent = await startAgent(sockPath, pairs.map((p) => utils.parseKey(p.private)))
  const want = pairs[2]
  const pubPath = path.join(dir, 'box.pub')
  writeFileSync(pubPath, want.public + LF)
  const { server, offered, port } = await startServer(want.public)
  const pool = new SshPool({
    host: '127.0.0.1', port, username: 'u',
    privateKeyPath: pubPath, agentSocket: sockPath, identitiesOnly: true,
    useAgent: false, hostKeyMode: 'off', connectTimeoutMs: 10000,
  }, { knownHostsFile: path.join(dir, 'known_hosts.json') })
  t.after(() => {
    try { pool.close() } catch {}
    server.close(); agent.close()
    rmSync(dir, { recursive: true, force: true })
  })
  await pool.connect()
  const wantBlob = publicKeyBlob(want.public)
  assert.ok(offered.length >= 1)
  assert.ok(offered.every((b) => b.equals(wantBlob)), 'only the IdentityFile key is offered')
})

test('a .pub IdentityFile with no agent reports the agent, not a private-key read', async () => {
  const pool = new SshPool({
    host: '127.0.0.1', port: 1, username: 'u',
    privateKeyPath: '/nonexistent/box.pub', agentSocket: 'none',
    hostKeyMode: 'off', connectTimeoutMs: 2000,
  })
  await assert.rejects(pool.connect(), /no SSH agent available: the identity/)
})
