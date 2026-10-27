// Tests for #89, the http runtime and the HTTP API connector: credentials (bearer, basic, header, query, OAuth2
// client credentials) reach a fake server and never the agent, host and redirect rules, SSRF and DNS rebinding,
// TLS, limits, safety levels, the kill switch and test connection. Only local fake servers and made-up
// credentials; name resolution is a fake table, so nothing reaches real DNS or the internet. Runs on Node 24's own
// TypeScript support with a stand-in for electron, like test-connectors.mjs.
//
//   npm run test-http

import { register } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-http-'))
globalThis.__userData = join(tmp, 'data')
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent(\`
      const x = (b) => Buffer.from(b.map((c) => c ^ 0x5a))
      export const app = { getPath: () => globalThis.__userData }
      export const safeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret', // read on Linux only: a real keyring, so platform/keyring.ts lets secrets be saved
        encryptString: (s) => x([...Buffer.from('fake-dpapi:' + s)]),
        decryptString: (b) => { const s = x([...b]).toString(); if (!s.startsWith('fake-dpapi:')) throw new Error('bad'); return s.slice(11) }
      }\`)
    export async function resolve(s, c, next) {
      if (s === 'electron') return { url: fake, shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
        for (const ext of ['.ts', '/index.ts']) {
          try { return await next(s + ext, c) } catch {}
        }
      }
      return next(s, c)
    }
    export async function load(u, c, next) {
      return u.endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

// made-up credentials for the leak search (secret-scan: allow)
const TOKEN = 'Fake-Bearer-Token-48213-qq' // secret-scan: allow
const PASS = 'Fake-Basic-Pass-55120-ww' // secret-scan: allow
const APIKEY = 'Fake-Api-Key-77341-ee' // secret-scan: allow
const CLIENT_SECRET = 'Fake-Client-Secret-31337-rr' // secret-scan: allow
const PLANTED = [TOKEN, PASS, APIKEY, CLIENT_SECRET, Buffer.from(`tester:${PASS}`).toString('base64'), `tester:${PASS}`]

// ---------- the fake API ----------

const seen = []
let issued = 0
let valid = new Set()
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const u = new URL(req.url, 'http://x')
    seen.push({ method: req.method, path: u.pathname, search: u.search, headers: req.headers, body })
    const json = (status, o, h = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'r1', 'set-cookie': 'sid=fake-session-cookie-1234; Path=/', 'www-authenticate': 'Bearer', ...h })
      res.end(JSON.stringify(o))
    }
    const p = u.pathname
    // echoes everything it got back, credentials included, in several encodings
    if (p === '/echo' || p.startsWith('/items') || p.startsWith('/admin') || p === '/') {
      const auth = req.headers.authorization ?? ''
      return json(200, { method: req.method, path: p, search: u.search, headers: req.headers, body, again: Buffer.from(auth).toString('base64'), hex: Buffer.from(auth).toString('hex') }, { 'x-echo-auth': auth })
    }
    if (p === '/redirect-same') return res.writeHead(302, { location: '/echo?from=redirect' }).end()
    if (p === '/redirect-other') return res.writeHead(302, { location: `http://other.test:${port}/echo` }).end()
    if (p === '/redirect-extra') return res.writeHead(307, { location: `http://cdn.test:${port}/echo` }).end()
    if (p === '/redirect-admin') return res.writeHead(302, { location: '/admin/secret-stuff' }).end()
    if (p === '/redirect-leak') return res.writeHead(302, { location: `http://cdn.test:${port}/echo?k=${encodeURIComponent(req.headers['x-api-key'] ?? '')}` }).end()
    if (p === '/slow') return setTimeout(() => json(200, { slow: true }), 1500)
    if (p === '/wait') return setTimeout(() => json(200, { waited: true }), 300)
    if (p === '/huge') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(5 * 1024 * 1024) })
      const chunk = 'x'.repeat(64 * 1024)
      let n = 0
      const pump = () => {
        while (n < 80) {
          n++
          if (!res.write(chunk)) return res.once('drain', pump)
        }
        res.end()
      }
      return pump()
    }
    if (p === '/binary') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '2048' })
      return res.end(Buffer.alloc(2048, 7))
    }
    if (p === '/token') {
      const want = 'Basic ' + Buffer.from(`client-1:${CLIENT_SECRET}`).toString('base64')
      if (req.headers.authorization !== want || !/grant_type=client_credentials/.test(body)) return json(401, { error: 'invalid_client' })
      const t = `fake-access-${++issued}-Zq81mXv0pLr`
      valid.add(t)
      return json(200, { access_token: t, token_type: 'Bearer', expires_in: 1 })
    }
    if (p.startsWith('/api/')) {
      const t = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      if (!valid.has(t)) return json(401, { error: 'expired' })
      return json(200, { ok: true, youSent: req.headers.authorization })
    }
    json(404, { error: 'no route' })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const hits = (path) => seen.filter((s) => s.path === path)

after(() => {
  server.close()
  tlsServer?.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ---------- Corvid's modules, with fake DNS ----------

const remote = await import('../src/main/remote/index.ts')
const store = await import('../src/main/connectors/store.ts')
const connectors = await import('../src/main/connectors/index.ts')
const httpRt = await import('../src/main/connectors/http.ts')
const rules = await import('../src/main/connectors/httpRules.ts')
const policy = await import('../src/main/connectors/policy.ts')
const { HTTP_CONNECTOR } = await import('../src/main/connectors/builtin.ts')
const { validateManifest } = await import('../src/main/connectors/manifest.ts')

let lookups = []
let dns = {
  'fake-api.test': ['127.0.0.1'],
  'other.test': ['127.0.0.1'],
  'cdn.test': ['127.0.0.1'],
  'internal.test': ['10.0.0.7'],
  'mixed.test': ['93.184.216.34', '10.0.0.1'],
  'meta.test': ['169.254.169.254'],
  'v6.test': ['::1']
}
httpRt.httpDeps.lookup = async (host) => {
  lookups.push(host)
  const v = typeof dns[host] === 'function' ? dns[host]() : dns[host]
  if (!v) throw new Error('ENOTFOUND')
  return v.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

const proj = join(tmp, 'projects', 'shop')
const projectIdForPath = (p) => (p.toLowerCase() === proj.toLowerCase() ? 'p1' : undefined)
const requests = []
remote.initRemote({ changed: () => {}, approvalRequested: (a) => requests.push(a) })
store.initConnectorStore({ projectIdForPath, remoteSystems: () => [], remoteSecret: () => undefined })
connectors.initConnectors({ projectIdForPath, changed: () => {} })
const agent = { project: proj, agent: 'worker #89' }

// everything the agent and the logs see, for the leak search at the end
const outputs = []
const logged = []
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k]
  console[k] = (...a) => {
    logged.push(a.map(String).join(' '))
    orig(...a)
  }
}
const call = async (conn, op, args) => {
  try {
    const r = await connectors.call(agent, conn, op, args)
    outputs.push(JSON.stringify(r))
    return r
  } catch (e) {
    outputs.push(e.message)
    throw e
  }
}
const answerNext = async (approve) => {
  for (let i = 0; i < 300 && !remote.listApprovals().length; i++) await new Promise((r) => setTimeout(r, 10))
  const a = remote.listApprovals()[0]
  assert.ok(a, 'an approval was requested')
  remote.decide(a.id, approve)
  return a
}
const make = (name, config, slots = {}, safety = 'free', connectorId = 'http-api') => {
  const c = store.saveConnection({ connectorId, name, config, safety, projectIds: ['p1'] })
  for (const [k, v] of Object.entries(slots)) store.setSecret(c.id, k, v)
  return c
}
const base = `http://fake-api.test:${port}`

// ---------- the connector itself ----------

test('the built-in HTTP API connector is a valid manifest, and first use asks once', async () => {
  const v = validateManifest(HTTP_CONNECTOR)
  assert.ok(v.ok, JSON.stringify(v.errors))
  assert.equal(store.connectorState('http-api').status, 'pending')
  make('bearer-api', { base_url: base, local: true, auth: 'bearer' }, { token: TOKEN })
  const p = call('bearer-api', 'request', { method: 'GET', path: '/echo' })
  const a = await answerNext(true)
  assert.equal(a.kind, 'connector')
  assert.match(a.summary, /fake-api\.test/)
  assert.match(a.warn, /local or internal service/, 'the approval warns about a local connection')
  const r = await p
  assert.equal(r.status, 200)
  assert.equal(store.connectorState('http-api').status, 'approved')
})

// ---------- credentials ----------

test('bearer: reaches the server, scrubbed from the echo, the agent never sees it', async () => {
  const r = await call('bearer-api', 'request', { method: 'GET', path: '/echo', headers: { Authorization: 'Bearer agent-made-up', Host: 'evil.test', 'X-Trace': 'abc' } })
  const got = hits('/echo').at(-1)
  assert.equal(got.headers.authorization, `Bearer ${TOKEN}`, 'Corvid’s credential, not the agent’s')
  assert.equal(got.headers.host, `fake-api.test:${port}`, 'the agent can’t set Host')
  assert.equal(got.headers['x-trace'], 'abc', 'ordinary headers pass')
  assert.ok(r.notes.some((n) => /Dropped the Authorization header/.test(n)) && r.notes.some((n) => /Dropped the Host header/.test(n)))
  assert.equal(r.body.headers.authorization, 'Bearer [redacted]')
  assert.ok(!('set-cookie' in r.headers) && !('x-echo-auth' in r.headers) && !('www-authenticate' in r.headers), 'only safe response headers come back')
  assert.equal(r.headers['x-request-id'], 'r1')
})

test('basic: user and password reach the server; the base64 pair is scrubbed from the echo', async () => {
  make('basic-api', { base_url: base, local: true, auth: 'basic', username: 'tester' }, { password: PASS })
  const r = await call('basic-api', 'request', { method: 'GET', path: '/echo' })
  assert.equal(hits('/echo').at(-1).headers.authorization, 'Basic ' + Buffer.from(`tester:${PASS}`).toString('base64'))
  assert.equal(r.body.headers.authorization, 'Basic [redacted]')
})

test('custom header and query parameter credentials; the agent can’t override either', async () => {
  make('header-api', { base_url: base, local: true, auth: 'header', auth_header: 'X-Api-Key' }, { api_key: APIKEY })
  const r = await call('header-api', 'request', { method: 'GET', path: '/echo', headers: { 'x-api-key': 'agent-value' } }) // secret-scan: allow (made up)
  assert.equal(hits('/echo').at(-1).headers['x-api-key'], APIKEY)
  assert.ok(r.notes.some((n) => /Dropped the x-api-key header/.test(n)))
  make('query-api', { base_url: base, local: true, auth: 'query', auth_query: 'key' }, { api_key: APIKEY })
  const q = await call('query-api', 'request', { method: 'GET', path: '/echo?key=agent', query: { page: 2, key: 'agent2' } })
  const got = hits('/echo').at(-1)
  assert.equal(new URLSearchParams(got.search).getAll('key').join(), APIKEY, 'only Corvid’s key is sent')
  assert.equal(new URLSearchParams(got.search).get('page'), '2')
  assert.match(q.body.search, /key=\[redacted\]/)
  const audit = store.readCallAudit(1)[0]
  assert.equal(audit.request, 'GET /echo?page=2', 'the audit has the method and path, never the credential')
  assert.match(audit.detail, /HTTP 200/)
})

test('a missing secret refuses with a plain message and sends nothing', async () => {
  make('empty-api', { base_url: base, local: true, auth: 'bearer' })
  const before = seen.length
  await assert.rejects(call('empty-api', 'request', { path: '/echo' }), /bearer token for empty-api isn't saved/)
  assert.equal(seen.length, before)
})

// ---------- host rules ----------

test('host rules: other hosts, absolute URLs, ports, user info and schemes are refused', async () => {
  const before = seen.length
  for (const path of [
    'https://evil.test/x',
    'http://fake-api.test/echo',
    '//evil.test/echo',
    'evil.test/echo',
    `fake-api.test:${port + 1}/echo`,
    ':9999/echo',
    'user:pw@evil.test/echo',
    '/echo\\..\\x',
    '/echo#frag',
    'javascript:alert(1)',
    '/a b'
  ])
    await assert.rejects(call('bearer-api', 'request', { method: 'GET', path }), /path must be a path on the connection/, path)
  assert.equal(seen.length, before, 'nothing reached the server')
  // the base path can't be left with ..
  make('scoped-api', { base_url: `${base}/items`, local: true }, { token: TOKEN })
  await assert.rejects(call('scoped-api', 'request', { path: '/../admin/x' }), /must stay under \/items/)
  await assert.rejects(call('scoped-api', 'request', { path: '/%2e%2e/admin/x' }), /must stay under \/items/)
  assert.equal((await call('scoped-api', 'request', { path: '/7' })).body.path, '/items/7')
  const audit = store.readCallAudit(3)
  assert.ok(audit.some((e) => e.decision === 'refused' && /stay under/.test(e.error)), 'refusals are audited')
})

test('redirects: within the host works; to another host refused without the credential; extra hosts get none', async () => {
  const r = await call('bearer-api', 'request', { path: '/redirect-same' })
  assert.equal(r.status, 200)
  assert.equal(r.body.search, '?from=redirect')
  assert.equal(hits('/echo').at(-1).headers.authorization, `Bearer ${TOKEN}`, 'same origin keeps the credential')

  const before = seen.length
  await assert.rejects(call('bearer-api', 'request', { path: '/redirect-other' }), /redirected to other\.test.*not followed and the credential was not sent/)
  assert.equal(seen.length, before + 1, 'only the first request reached a server')

  make('extra-api', { base_url: base, local: true, extra_hosts: 'cdn.test' }, { token: TOKEN })
  await call('extra-api', 'request', { path: '/redirect-extra' })
  const last = seen.at(-1)
  assert.equal(last.headers.host, `cdn.test:${port}`)
  assert.equal(last.headers.authorization, undefined, 'never forwarded to another origin')

  make('extra-hdr', { base_url: base, local: true, extra_hosts: 'cdn.test', auth: 'header' }, { api_key: APIKEY })
  const n = seen.length
  await assert.rejects(call('extra-hdr', 'request', { path: '/redirect-leak' }), /credential in the address; not followed/)
  assert.equal(seen.length, n + 1)

  await assert.rejects(call('bearer-api', 'request', { path: '/redirect-admin' }), /administrative path/)
})

// ---------- SSRF ----------

test('SSRF: private, loopback, link-local, metadata, IPv6 forms, odd IP spellings and private names are refused', async () => {
  const before = seen.length
  const bases = [
    'https://127.0.0.1',
    'https://127.1.2.3:8443',
    'https://localhost',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:7f00:1]',
    'https://[fe80::1]',
    'https://[fd00::1]',
    'https://[fd00:ec2::254]',
    'https://10.1.2.3',
    'https://172.16.5.4',
    'https://192.168.1.1',
    'https://169.254.169.254',
    'https://100.64.0.1',
    'https://0.0.0.0',
    'https://2130706433',
    'https://0x7f000001',
    'https://0177.0.0.1',
    'https://127.1',
    'https://internal.test',
    'https://mixed.test',
    'https://meta.test',
    'https://v6.test'
  ]
  bases.forEach((b, i) => make(`ssrf-${i}`, { base_url: b }, { token: TOKEN }))
  for (let i = 0; i < bases.length; i++)
    await assert.rejects(call(`ssrf-${i}`, 'request', { path: '/x' }), /Refused: .* (private, loopback or link-local|cloud metadata|not an address)/, bases[i])
  // metadata stays refused even on a connection marked local
  make('meta-local', { base_url: 'http://169.254.169.254', local: true })
  await assert.rejects(call('meta-local', 'request', { path: '/latest/meta-data' }), /cloud metadata/)
  // plain http is only for local connections
  make('plain', { base_url: 'http://api.example.test' }, { token: TOKEN })
  await assert.rejects(call('plain', 'request', { path: '/x' }), /plain http/)
  assert.equal(seen.length, before, 'nothing reached a server')
  // the address rules themselves
  for (const ip of ['8.8.8.8', '2606:4700::1111']) assert.equal(rules.addressKind(ip), 'public')
  for (const ip of ['::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1']) assert.equal(rules.addressKind(ip), 'internal', ip)
})

test('DNS rebinding: the name is resolved once and the request goes to that address', async () => {
  let n = 0
  dns['rebind.test'] = () => (++n === 1 ? ['127.0.0.1'] : ['10.255.255.1'])
  make('rebind', { base_url: `http://rebind.test:${port}`, local: true }, { token: TOKEN })
  lookups = []
  const r = await call('rebind', 'request', { path: '/redirect-same' })
  assert.equal(r.status, 200, 'both hops reached the checked address')
  assert.deepEqual(lookups, ['rebind.test'], 'one lookup for the whole call, redirects included')
  // the classic order: public first, private later; a non-local connection refuses the private answer whenever it comes
  dns['rebind2.test'] = ['127.0.0.1']
  make('rebind2', { base_url: 'https://rebind2.test' }, { token: TOKEN })
  await assert.rejects(call('rebind2', 'request', { path: '/x' }), /private, loopback/)
})

// ---------- TLS ----------

let tlsServer
const openssl = [process.env.OPENSSL, 'openssl', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'].find(
  (p) => p && !spawnSync(p, ['version']).error
)
test('TLS: a self-signed certificate is refused; the explicit exception works only when set', { skip: !openssl && 'openssl not found' }, async () => {
  const dir = join(tmp, 'tls')
  mkdirSync(dir)
  const out = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k'), '-out', join(dir, 'c'), '-days', '1', '-subj', '/CN=localhost'], {
    env: { ...process.env, MSYS_NO_PATHCONV: '1' }
  })
  assert.ok(existsSync(join(dir, 'c')), String(out.stderr))
  tlsServer = https.createServer({ key: readFileSync(join(dir, 'k')), cert: readFileSync(join(dir, 'c')) }, (req, res) => {
    seen.push({ path: 'tls' + req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"tls":true}')
  })
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r))
  const tport = tlsServer.address().port
  make('tls-strict', { base_url: `https://localhost:${tport}`, local: true }, { token: TOKEN })
  const before = seen.length
  await assert.rejects(call('tls-strict', 'request', { path: '/x' }), /certificate could not be verified/)
  assert.equal(seen.length, before, 'no request, so no credential, went out')
  make('tls-exception', { base_url: `https://localhost:${tport}`, local: true, insecure_tls: true }, { token: TOKEN })
  assert.deepEqual((await call('tls-exception', 'request', { path: '/x' })).body, { tls: true })
  const s = rules.httpSettings(HTTP_CONNECTOR, store.getConnection(store.listConnections().find((c) => c.name === 'tls-exception').id).config)
  assert.ok(rules.httpWarnings(s).some((w) => /Certificate checks are switched off/.test(w)))
})

// ---------- limits ----------

const LIMITED = {
  manifestVersion: 1,
  id: 'fake-shop',
  name: 'Fake shop',
  version: '1.0.0',
  description: 'A made-up shop API on a local fake server, with named operations.',
  runtime: 'http',
  config: [{ key: 'local', label: 'Local', type: 'boolean', default: true }],
  secrets: [{ key: 'token', label: 'Token', type: 'token' }],
  capabilities: {
    targets: [{ host: 'fake-api.test', ports: [port], scheme: 'http' }],
    operations: [
      { name: 'get_item', description: 'One item', class: 'read', method: 'GET', path: '/items/{id}', input: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
      { name: 'delete_item', description: 'Delete an item', class: 'write', method: 'DELETE', path: '/items/{id}' },
      { name: 'slow', description: 'Slow', class: 'read', method: 'GET', path: '/slow' },
      { name: 'huge', description: 'Huge', class: 'read', method: 'GET', path: '/huge' },
      { name: 'binary', description: 'Binary', class: 'read', method: 'GET', path: '/binary' },
      { name: 'admin_area', description: 'Marks /admin as administrative', class: 'admin', path: '/admin/**' },
      { name: 'request', description: 'Any request', class: 'write' }
    ]
  },
  limits: { timeoutMs: 600, maxResponseBytes: 10000, ratePerMinute: 6 }
}

test('named operations: path templates, input checks, and the manifest’s admin paths', async () => {
  assert.ok(validateManifest(LIMITED).ok, JSON.stringify(validateManifest(LIMITED).errors))
  writeFileSync(join(globalThis.__userData, 'connectors', 'fake-shop.json'), JSON.stringify(LIMITED))
  store.initConnectorStore({ projectIdForPath, remoteSystems: () => [], remoteSecret: () => undefined })
  make('shop', {}, { token: TOKEN }, 'approve-writes', 'fake-shop')
  const p = call('shop', 'get_item', { id: 42 })
  await answerNext(true) // first use of this connector
  assert.equal((await p).body.path, '/items/42')
  await assert.rejects(call('shop', 'get_item', { id: '../admin' }), /id must be an integer/)
  await assert.rejects(call('shop', 'delete_item', { id: '../admin' }), /single path segment/)
  await assert.rejects(call('shop', 'admin_area', {}), /only marks paths/)
  const admin = call('shop', 'request', { method: 'GET', path: '/admin/users' })
  const a = await answerNext(false)
  assert.match(a.warn, /Administrative/)
  assert.match(a.why, /administrative/i)
  await assert.rejects(admin, /declined/)
})

test('limits: slow response, huge response, binary response, too many calls', async () => {
  await assert.rejects(call('shop', 'slow', {}), /No complete answer within 1 s/)
  const huge = await call('shop', 'huge', {})
  assert.equal(huge.truncated, true)
  assert.equal(huge.body.length, 10000)
  assert.match(huge.notes.join(), /cut off at 10000 bytes of 5242880/)
  const bin = await call('shop', 'binary', {})
  assert.equal(bin.body, null)
  assert.match(bin.notes.join(), /image\/png \(2048 bytes\).*only text and JSON/)
  // 6 a minute: get_item, slow, huge, binary ran above, so two more and then a refusal
  await call('shop', 'get_item', { id: 1 })
  await call('shop', 'get_item', { id: 2 })
  await assert.rejects(call('shop', 'get_item', { id: 3 }), /at most 6 calls a minute/)
  // at most 4 at once per connection
  make('busy', { base_url: base, local: true }, { token: TOKEN })
  const all = await Promise.allSettled([1, 2, 3, 4, 5].map(() => call('busy', 'request', { path: '/wait' })))
  assert.equal(all.filter((r) => r.status === 'fulfilled').length, 4)
  assert.match(all.find((r) => r.status === 'rejected').reason.message, /already has 4 calls running/)
  // a request body over the limit is refused before anything is sent
  await assert.rejects(call('busy', 'request', { method: 'POST', path: '/echo', body: 'x'.repeat(1024 * 1024 + 1) }), /larger than 1024 KB/)
})

// ---------- safety levels, Strict text, kill switch ----------

test('safety levels: approve-writes runs GET, asks for POST; Strict shows the exact request with the credential masked', async () => {
  make('aw', { base_url: base, local: true, auth: 'bearer,header', auth_header: 'X-Api-Key' }, { token: TOKEN, api_key: APIKEY }, 'approve-writes')
  await call('aw', 'request', { method: 'GET', path: '/echo' })
  assert.equal(remote.listApprovals().length, 0)
  const post = call('aw', 'request', { method: 'POST', path: '/echo', query: { dry: 'no' }, body: { name: 'thing' } })
  const a = await answerNext(true)
  assert.equal(a.kind, 'command')
  assert.equal((await post).body.body, '{"name":"thing"}')

  make('strict', { base_url: base, local: true, auth: 'query', auth_query: 'key' }, { api_key: APIKEY }, 'strict')
  const g = call('strict', 'request', { method: 'PUT', path: '/items/9', headers: { 'X-Trace': 't1' }, body: { qty: 3 } })
  const s = await answerNext(false)
  assert.equal(
    s.command,
    [`PUT http://fake-api.test:${port}/items/9?key=[credential added by Corvid]`, 'X-Trace: t1', 'Content-Type: application/json', 'Accept: application/json, text/*;q=0.9, */*;q=0.1', '', '{"qty":3}'].join('\n')
  )
  assert.match(s.warn, /local or internal service/)
  await assert.rejects(g, /declined/)
  const before = seen.length
  const h = call('aw', 'request', { method: 'DELETE', path: '/items/1' })
  const d = await answerNext(false)
  assert.match(d.command, /^DELETE .*\nAuthorization: \[credential added by Corvid\]\nX-Api-Key: \[credential added by Corvid\]$/s)
  await assert.rejects(h, /declined/)
  assert.equal(seen.length, before, 'a declined call sends nothing')
})

test('the kill switch refuses calls and stops one in flight', async () => {
  connectors.switchOffAll(true)
  await assert.rejects(call('bearer-api', 'request', { path: '/echo' }), /switched off/)
  connectors.switchOffAll(false)
  make('slowpoke', { base_url: base, local: true }, { token: TOKEN })
  const p = call('slowpoke', 'request', { path: '/slow' })
  await new Promise((r) => setTimeout(r, 200))
  connectors.switchOffAll(true)
  await assert.rejects(p, /switched off/)
  const t = await httpRt.testHttpConnection(store.getConnection(store.listConnections().find((c) => c.name === 'slowpoke').id), HTTP_CONNECTOR)
  assert.equal(t.ok, false)
  connectors.switchOffAll(false)
})

// ---------- OAuth2 and test connection ----------

test('OAuth2 client credentials: the token is never visible, cached, refreshed on expiry and after a 401', async () => {
  make('oauth', { base_url: base, local: true, auth: 'oauth2', token_url: `${base}/token`, client_id: 'client-1' }, { client_secret: CLIENT_SECRET })
  const r1 = await call('oauth', 'request', { path: '/api/thing' })
  assert.equal(r1.status, 200)
  assert.equal(r1.body.youSent, 'Bearer [redacted]', 'the access token is masked in the echo')
  assert.equal(issued, 1)
  await call('oauth', 'request', { path: '/api/thing' })
  assert.equal(issued, 1, 'cached while it is valid')
  await new Promise((r) => setTimeout(r, 1100))
  await call('oauth', 'request', { path: '/api/thing' })
  assert.equal(issued, 2, 'refreshed after it expired')
  valid = new Set()
  assert.equal((await call('oauth', 'request', { path: '/api/thing' })).status, 200, 'a 401 gets one fresh token and one retry')
  assert.equal(issued, 3)
  make('oauth-bad', { base_url: base, local: true, auth: 'oauth2', token_url: `${base}/token`, client_id: 'client-1' }, { client_secret: 'wrong-secret-value' }) // secret-scan: allow (made up)
  await assert.rejects(call('oauth-bad', 'request', { path: '/api/thing' }), /could not get an access token/)
  for (let i = 1; i <= issued; i++) for (const o of outputs) assert.ok(!o.includes(`fake-access-${i}-`), 'an access token reached the agent')
})

test('test connection runs the configured safe GET and reports only the outcome', async () => {
  const c = make('testable', { base_url: base, local: true, test_path: '/echo' }, { token: TOKEN })
  const r = await httpRt.testHttpConnection(store.getConnection(c.id), HTTP_CONNECTOR)
  assert.deepEqual([r.ok, r.status], [true, 200])
  assert.equal(store.readCallAudit(1)[0].operation, 'test_connection')
})

// ---------- the connection form's sign-in choices (#103) ----------

const form = await import('../src/shared/httpAuth.ts')
const { capabilitySummary } = await import('../src/main/connectors/manifest.ts')
const slotKeys = HTTP_CONNECTOR.secrets.map((s) => s.key)
const slotName = (k) => HTTP_CONNECTOR.secrets.find((s) => s.key === k).label

test('#103 saved sign-in values load into the form as they are, and everything the form stores is what the runtime reads', () => {
  const cfg = (auth) => ({ base_url: base, local: true, auth, token_url: `${base}/token`, client_id: 'c' })
  for (const [stored, kinds] of [
    ['bearer', ['bearer']],
    ['basic', ['basic']],
    ['header,query', ['header', 'query']],
    ['header, query', ['header', 'query']],
    ['none', ['none']],
    ['oauth2', ['oauth2']]
  ]) {
    const loaded = form.effectiveAuth({ auth: stored }, HTTP_CONNECTOR.config, slotKeys)
    assert.deepEqual(loaded, kinds, `${stored} loads as ${kinds}`)
    assert.deepEqual(rules.httpSettings(HTTP_CONNECTOR, cfg(stored)).auth, kinds, 'the runtime reads the same')
  }
  // an older connection without the setting gets the connector's default, as the runtime does
  assert.deepEqual(form.effectiveAuth({}, HTTP_CONNECTOR.config, slotKeys), rules.httpSettings(HTTP_CONNECTOR, { base_url: base, local: true }).auth)
  // a drafted http connector without an auth setting: inferred from its slots, like httpRules' inferAuth
  assert.deepEqual(form.effectiveAuth({}, [], ['api_key']), ['header'])
  assert.deepEqual(form.effectiveAuth({}, [], []), ['none'])
  // every value the form can produce by ticking is accepted by the runtime unchanged
  const kinds = form.HTTP_AUTH_METHODS.map((m) => m.kind)
  for (const a of kinds)
    for (const b of kinds) {
      const v = form.formatAuth(form.pickAuth(form.pickAuth(['none'], a), b))
      assert.equal(form.authConflict(form.parseAuth(v)), undefined, v)
      assert.deepEqual(rules.httpSettings(HTTP_CONNECTOR, cfg(v)).auth, form.parseAuth(v))
    }
  assert.equal(form.formatAuth(form.parseAuth('none')), 'none')
  assert.equal(form.formatAuth(form.parseAuth('query,header')), 'header,query')
})

test('#103 choosing: No credentials excludes the others; one Authorization method at a time; header and query combine', () => {
  assert.deepEqual(form.pickAuth(['header', 'query'], 'none'), ['none'])
  assert.deepEqual(form.pickAuth(['none'], 'bearer'), ['bearer'])
  assert.deepEqual(form.pickAuth(['bearer'], 'basic'), ['basic'])
  assert.deepEqual(form.pickAuth(['header'], 'query'), ['header', 'query'])
  assert.deepEqual(form.pickAuth(['header', 'basic'], 'oauth2'), ['header', 'oauth2'])
  assert.match(form.authConflict(['none', 'bearer']), /can’t be combined/)
  assert.match(form.authConflict(['bearer', 'basic']), /Authorization header/)
})

test('#103 missing secrets name the slot and the method; No credentials has none', () => {
  const none = () => false
  assert.deepEqual(form.missingSecrets(['bearer'], slotName, none), ['Bearer token is empty, but you chose Bearer.'])
  assert.deepEqual(form.missingSecrets(['basic'], slotName, none), ['Password is empty, but you chose Basic.'])
  assert.deepEqual(form.missingSecrets(['header', 'query'], slotName, none), ['API key is empty, but you chose API key in a header and API key in the URL query.'])
  assert.deepEqual(form.missingSecrets(['oauth2'], slotName, none), ['OAuth2 client secret is empty, but you chose OAuth2.'])
  assert.deepEqual(form.missingSecrets(['none'], slotName, none), [])
  assert.deepEqual(form.missingSecrets(['bearer'], slotName, (s) => s === 'token'), [])
  assert.deepEqual(form.missingSettings(['basic'], {}, (k) => k), ['username is empty, but you chose Basic.'])
  assert.deepEqual(form.missingSettings(['none'], {}, (k) => k), [])
  assert.deepEqual([...form.authSlots(['none'])], [])
  assert.deepEqual([...form.authSlots(['header', 'query'])], ['api_key'])
})

test('#103 a pasted key suggests a method', () => {
  const b = form.guessPaste(`Bearer ${TOKEN}`)
  assert.deepEqual([b.kinds, b.value], [['bearer'], TOKEN], 'the Bearer prefix is taken off')
  const basic = form.guessPaste(`Authorization: Basic ${Buffer.from(`tester:${PASS}`).toString('base64')}`)
  assert.deepEqual([basic.kinds, basic.username, basic.value], [['basic'], 'tester', PASS])
  assert.equal(form.guessPaste('eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.ZmFrZQ').kinds[0], 'bearer') // secret-scan: allow (made up)
  assert.equal(form.guessPaste(APIKEY).kinds[0], 'header')
  assert.equal(form.guessPaste('hello there'), undefined)
  assert.equal(form.guessPaste('short1'), undefined)
})

test('#103 No credentials: nothing is attached, and the connection’s summary says so', async () => {
  make('open-api', { base_url: base, local: true, auth: 'none' })
  const r = await call('open-api', 'request', { method: 'GET', path: '/echo' })
  assert.equal(r.status, 200)
  const got = hits('/echo').at(-1)
  assert.equal(got.headers.authorization, undefined)
  assert.equal(got.headers['x-api-key'], undefined)
  assert.equal(got.search, '')
  const open = capabilitySummary(HTTP_CONNECTOR, { name: 'open-api', config: { base_url: base, auth: 'none' }, secretsSet: {} })
  assert.match(open, new RegExp(`calls ${base.replace(/[.:/]/g, '\\$&')} without sending any credentials`))
  assert.doesNotMatch(open, /Bearer token|API key|not set yet/)
  const bearer = capabilitySummary(HTTP_CONNECTOR, { name: 'b', config: { base_url: base, auth: 'bearer' }, secretsSet: { token: true } })
  assert.match(bearer, /'Bearer token'/)
  assert.doesNotMatch(bearer, /API key|client secret/)
  // the connector's own summary, with no connection, still lists every slot
  assert.match(capabilitySummary(HTTP_CONNECTOR), /'Bearer token'.*'API key'/)
})

// ---------- the leak search ----------

test('no planted credential, in any encoding, in tool output, approvals, audit, logs or files', () => {
  const files = []
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (!/secrets\.json$/.test(n.name)) files.push([p, readFileSync(p, 'utf8')])
    }
  }
  walk(globalThis.__userData)
  const texts = [...outputs.map((o) => ['tool output', o]), ['approvals', JSON.stringify(requests)], ['logs', logged.join('\n')], ...files]
  assert.ok(outputs.length > 40)
  for (const value of PLANTED) for (const form of policy.secretVariants(value)) for (const [where, text] of texts) assert.ok(!text.includes(form), `a form of a planted credential is in ${where}`)
  assert.ok(outputs.some((o) => o.includes('[redacted]')), 'the server did echo credentials, and they were masked')
})

test('the example manifests in docs/CONNECTORS.md pass the validator', () => {
  const md = readFileSync(join(import.meta.dirname, '..', 'docs', 'CONNECTORS.md'), 'utf8')
  const blocks = [...md.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1])).filter((m) => m.runtime === 'http')
  assert.ok(blocks.length >= 4)
  for (const m of blocks) {
    const v = validateManifest(m)
    assert.ok(v.ok, `${m.id}: ${JSON.stringify(v.errors)}`)
    assert.doesNotThrow(() => rules.httpSettings(v.manifest, { username: 'bot' }), m.id)
  }
})
