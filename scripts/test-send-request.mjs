// Tests for #105, the Connections tab's "Send a request": the user's own request through an HTTP connection goes
// through the #89 runtime with every rule (host lock, SSRF, TLS, redirects, limits), the kill switch and approval
// block it, writes and admin paths need confirmation, the response is scrubbed, and the audit says "user (send
// request)". Only a local fake server and a made-up credential; name resolution is a fake table.
// Runs on Node 24's own TypeScript support with a stand-in for electron, like test-http.mjs.
//
//   npm run test-send-request

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

// a made-up credential for the leak search (secret-scan: allow)
const TOKEN = 'Fake-Panel-Token-60417-zx' // secret-scan: allow
const PLANTED = [TOKEN]

// ---------- the fake API ----------

const seen = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname
    seen.push({ method: req.method, path: p, headers: req.headers, body })
    const json = (status, o, h = {}) => res.writeHead(status, { 'content-type': 'application/json', 'x-total-count': '100', 'set-cookie': 'sid=x', ...h }).end(JSON.stringify(o))
    if (req.method === 'OPTIONS') return res.writeHead(204, { allow: 'GET, HEAD, OPTIONS, POST' }).end()
    if (p === '/posts') return json(200, Array.from({ length: 100 }, (_, i) => ({ id: i + 1, title: `post ${i + 1}`, body: 'lorem ipsum' })))
    if (p === '/echo' || p.startsWith('/admin')) {
      const auth = req.headers.authorization ?? ''
      return json(200, { method: req.method, body, youSent: auth, again: Buffer.from(auth.replace(/^Bearer /, '')).toString('base64') }, { 'x-request-id': auth })
    }
    if (p === '/huge') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(3 * 1024 * 1024) })
      const chunk = 'y'.repeat(64 * 1024)
      let n = 0
      const pump = () => {
        while (n < 48) {
          n++
          if (!res.write(chunk)) return res.once('drain', pump)
        }
        res.end()
      }
      return pump()
    }
    if (p === '/binary') return res.writeHead(200, { 'content-type': 'image/png', 'content-length': '4096' }).end(Buffer.alloc(4096, 3))
    if (p === '/slow') return setTimeout(() => json(200, { slow: true }), 3000)
    if (p === '/redirect-other') return res.writeHead(302, { location: `http://other.test:${port}/echo` }).end()
    json(404, { error: 'no route' })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
let tlsServer
after(() => {
  server.closeAllConnections?.()
  server.close()
  tlsServer?.close()
  rmSync(tmp, { recursive: true, force: true })
})

const remote = await import('../src/main/remote/index.ts')
const store = await import('../src/main/connectors/store.ts')
const connectors = await import('../src/main/connectors/index.ts')
const httpRt = await import('../src/main/connectors/http.ts')
const policy = await import('../src/main/connectors/policy.ts')
const panel = await import('../src/main/connectors/userRequest.ts')

const dns = { 'fake-api.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'], 'public.test': ['10.0.0.9'] }
httpRt.httpDeps.lookup = async (host) => {
  if (!dns[host]) throw new Error('ENOTFOUND')
  return dns[host].map((address) => ({ address, family: 4 }))
}
const agentAsks = []
remote.initRemote({ changed: () => {}, approvalRequested: (a) => agentAsks.push(a) })
store.initConnectorStore({ projectIdForPath: () => 'p1', remoteSystems: () => [], remoteSecret: () => undefined })
connectors.initConnectors({ projectIdForPath: () => 'p1', changed: () => {} })

// everything the panel was given, for the leak search at the end
const shown = []
const make = (name, config, safety = 'strict') => {
  const c = store.saveConnection({ connectorId: 'http-api', name, config, safety, projectIds: ['p1'] })
  store.setSecret(c.id, 'token', TOKEN)
  return store.getConnection(c.id)
}
const req = (method, path, extra = {}) => ({ method, path, query: [], headers: [], bodyKind: 'json', ...extra })
let n = 0
const send = async (c, r, confirmed = null) => {
  const out = await panel.sendUserRequest(c.id, `t${++n}`, r, confirmed)
  shown.push(JSON.stringify(out))
  return out
}
const plan = (c, r) => {
  const out = panel.planUserRequest(c.id, r)
  shown.push(JSON.stringify(out))
  return out
}
const base = `http://fake-api.test:${port}`
const api = make('JsonTest', { base_url: base, local: true, auth: 'bearer', test_path: '/posts' })
const lastAudit = () => store.readCallAudit(1)[0]

test('an unapproved connector blocks with "Review and approve"; nothing is sent and no agent dialog opens', async () => {
  const before = seen.length
  const r = await send(api, req('GET', '/posts'))
  assert.equal(r.ok, false)
  assert.equal(r.approve, true)
  assert.match(r.error, /isn't approved yet/)
  assert.equal(seen.length, before)
  assert.equal(remote.listApprovals().length, 0, 'the panel never asks through the agent approval dialog')
  assert.equal(lastAudit().agent, 'user (send request)')
  assert.equal(lastAudit().decision, 'refused')
  store.recordDecision('http-api', store.getManifest('http-api').hash, true, 'user')
})

test('GET returns the full JSON body, status and reason, size, time and a few headers; audited as the user', async () => {
  const r = await send(api, req('GET', '/posts'))
  assert.equal(r.ok, true, r.error)
  assert.deepEqual([r.status, r.reason, r.json], [200, 'OK', true])
  assert.equal(r.body.length, 100, 'every post, not a cut-off list')
  assert.ok(r.size > 4000 && r.durationMs >= 0)
  assert.equal(r.headers['x-total-count'], '100')
  assert.equal(r.headers['set-cookie'], undefined, 'cookies are not shown')
  assert.equal(r.capBytes, 1024 * 1024)
  const a = lastAudit()
  assert.deepEqual([a.agent, a.operation, a.class, a.decision, a.request], ['user (send request)', 'request', 'read', 'automatic', 'GET /posts'])
  assert.match(a.detail, /HTTP 200/)
  assert.ok(a.resultBytes > 4000 && a.durationMs >= 0)
  // a Strict connection: the owner's reads still just run
  assert.equal(api.safety, 'strict')
  assert.equal(remote.listApprovals().length, 0)
})

test('query values whose names look secret are masked in the audit', async () => {
  await send(api, req('GET', '/posts', { query: [['page', '2'], ['api_token', 'abc123hidden']] }))
  assert.equal(lastAudit().request, 'GET /posts?page=2&api_token=***')
})

test('HEAD and OPTIONS work', async () => {
  const h = await send(api, req('HEAD', '/posts'))
  assert.deepEqual([h.ok, h.status, h.body], [true, 200, null])
  const o = await send(api, req('OPTIONS', '/anything'))
  assert.deepEqual([o.ok, o.status], [true, 204])
})

test('a large body is cut at the cap and says so; a binary body is only summarised', async () => {
  const big = await send(api, req('GET', '/huge'))
  assert.equal(big.truncated, true)
  assert.equal(big.body.length, 1024 * 1024)
  assert.match(big.notes.join(), /cut off at 1048576 bytes of 3145728/)
  const bin = await send(api, req('GET', '/binary'))
  assert.deepEqual([bin.ok, bin.body, bin.binary], [true, null, 'image/png'])
  assert.match(bin.notes.join(), /image\/png \(4096 bytes\)/)
})

test('a slow request can be cancelled', async () => {
  const p = panel.sendUserRequest(api.id, 'slow-1', req('GET', '/slow'), null)
  await new Promise((r) => setTimeout(r, 200))
  panel.cancelUserRequest('slow-1')
  const r = await p
  shown.push(JSON.stringify(r))
  assert.equal(r.ok, false)
  assert.match(r.error, /You cancelled the request/)
  assert.equal(lastAudit().error, 'cancelled by user')
})

test('a write needs confirmation: the plan shows the exact request; unconfirmed sends nothing', async () => {
  const post = req('POST', '/echo', { body: '{"title":"hello"}' })
  const pl = plan(api, post)
  assert.equal(pl.cls, 'write')
  assert.match(pl.shown, /^POST http:\/\/fake-api\.test:\d+\/echo/)
  assert.match(pl.shown, /\{"title":"hello"\}/)
  assert.match(pl.shown, /Authorization: \[credential added by Corvid\]/)
  const before = seen.length
  const no = await send(api, post, null)
  assert.equal(no.ok, false)
  assert.match(no.error, /needs your confirmation; nothing was sent/)
  assert.equal(seen.length, before, 'nothing reached the server')
  const yes = await send(api, post, 'write')
  assert.equal(yes.ok, true)
  assert.equal(seen.at(-1).body, '{"title":"hello"}')
  assert.deepEqual([lastAudit().decision, lastAudit().class], ['approved', 'write'])
  assert.match(lastAudit().detail, /confirmed by user/)
})

test('an admin path needs the stronger confirmation', async () => {
  const pl = plan(api, req('GET', '/admin/users'))
  assert.equal(pl.cls, 'admin')
  assert.match(pl.why, /administrative path/)
  const before = seen.length
  const weak = await send(api, req('GET', '/admin/users'), 'write')
  assert.match(weak.error, /administrative path and needs your confirmation/)
  assert.equal(seen.length, before)
  assert.equal((await send(api, req('GET', '/admin/users'), 'admin')).ok, true)
})

test('an invalid JSON body and locked headers are handled before sending', async () => {
  const bad = plan(api, req('POST', '/echo', { body: '{oops' }))
  assert.match(bad.error, /isn't valid JSON/)
  const r = await send(api, req('GET', '/echo', { headers: [['Authorization', 'Bearer stolen'], ['Host', 'evil.test'], ['X-Debug', '1']] }))
  assert.equal(seen.at(-1).headers.authorization, `Bearer ${TOKEN}`, 'Corvid sets the credential, not the panel')
  assert.equal(seen.at(-1).headers.host, `fake-api.test:${port}`)
  assert.equal(seen.at(-1).headers['x-debug'], '1')
  assert.match(r.notes.join(), /Dropped the Authorization header/)
})

test('an echoed credential is masked and flagged', async () => {
  const r = await send(api, req('GET', '/echo'))
  assert.equal(r.body.youSent, 'Bearer [redacted]')
  assert.equal(r.body.again, '[redacted]')
  assert.equal(r.headers['x-request-id'], 'Bearer [redacted]')
  assert.equal(r.hidden, true)
  assert.equal((await send(api, req('GET', '/posts'))).hidden, false)
})

test('host, SSRF and redirect rules still refuse', async () => {
  const before = seen.length
  for (const path of ['https://evil.test/x', '//evil.test/x', 'evil.test/x']) assert.match((await send(api, req('GET', path))).error, /path must be a path on the connection/)
  const priv = make('Private', { base_url: 'https://public.test', auth: 'bearer' })
  assert.match((await send(priv, req('GET', '/x'))).error, /private, loopback or link-local/)
  const meta = make('Meta', { base_url: 'http://169.254.169.254', local: true, auth: 'bearer' })
  assert.match((await send(meta, req('GET', '/latest'))).error, /cloud metadata/)
  const redirect = await send(api, req('GET', '/redirect-other'))
  assert.match(redirect.error, /redirected to other\.test.*credential was not sent there/)
  assert.equal(seen.length, before + 1, 'only the redirecting request reached the server')
})

const openssl = [process.env.OPENSSL, 'openssl', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'].find(
  (p) => p && !spawnSync(p, ['version']).error
)
test('TLS: a self-signed certificate is refused in plain words', { skip: !openssl && 'openssl not found' }, async () => {
  const dir = join(tmp, 'tls')
  mkdirSync(dir)
  spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k'), '-out', join(dir, 'c'), '-days', '1', '-subj', '/CN=localhost'], {
    env: { ...process.env, MSYS_NO_PATHCONV: '1' }
  })
  assert.ok(existsSync(join(dir, 'c')))
  tlsServer = https.createServer({ key: readFileSync(join(dir, 'k')), cert: readFileSync(join(dir, 'c')) }, (_q, res) => res.writeHead(200).end('{}'))
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r))
  const c = make('Tls', { base_url: `https://localhost:${tlsServer.address().port}`, local: true, auth: 'bearer' })
  const r = await send(c, req('GET', '/x'))
  assert.match(r.error, /certificate could not be verified.*you can allow it on the connection/)
})

test('a disabled connector and the kill switch block with their own messages', async () => {
  connectors.switchOffConnector('http-api', true)
  assert.match((await send(api, req('GET', '/posts'))).error, /HTTP API connector is switched off/)
  connectors.switchOffConnector('http-api', false)
  connectors.switchOffAll(true)
  const k = await send(api, req('GET', '/posts'))
  assert.match(k.error, /All connectors are switched off \("Disable all connectors" is on\)/)
  assert.equal(k.approve, undefined)
  connectors.switchOffAll(false)
  // the kill switch also stops a request already running
  const p = panel.sendUserRequest(api.id, 'slow-2', req('GET', '/slow'), null)
  await new Promise((r) => setTimeout(r, 200))
  connectors.switchOffAll(true)
  const r = await p
  shown.push(JSON.stringify(r))
  assert.equal(r.ok, false)
  assert.match(r.error, /switched off/)
  connectors.switchOffAll(false)
})

test('save to a note: scrubbed, capped, and the cut is said', () => {
  const note = panel.responseNoteText('GET /echo on JsonTest', `Authorization: Bearer ${TOKEN}\n${'z'.repeat(200 * 1024)}`)
  shown.push(JSON.stringify(note))
  assert.ok(!note.text.includes(TOKEN))
  assert.match(note.text, /Bearer \[redacted\]/)
  assert.ok(Buffer.byteLength(note.text) < 101 * 1024)
  assert.match(note.text, /Cut at 100 KB/)
})

test('nothing reaches an agent: the panel never opened an agent approval', () => {
  assert.equal(agentAsks.length, 0)
  assert.equal(remote.listApprovals().length, 0)
})

test('the planted credential appears nowhere: panel results, plans, the audit, files', () => {
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (!/secrets\.json$/.test(e.name)) files.push([p, readFileSync(p, 'utf8')])
    }
  }
  walk(globalThis.__userData)
  assert.ok(shown.length > 20)
  const audit = store.readCallAudit(500)
  const texts = [...shown.map((s) => ['panel', s]), ['audit', JSON.stringify(audit)], ...files]
  for (const v of PLANTED) for (const form of policy.secretVariants(v)) for (const [where, text] of texts) assert.ok(!text.includes(form), `a form of the planted credential is in ${where}`)
  assert.ok(audit.every((e) => e.agent === 'user (send request)'), 'every entry is the user')
})
