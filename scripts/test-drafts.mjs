// Tests for #92, connectors proposed by agents: the draft rules and their plain-language refusals, caps and expiry,
// the mock-server tests, project scope and promotion, immutability (a change is a new draft), decline reasons,
// set-up requests, the Settings switch and the kill switch, and an end-to-end run where an approved draft is used
// with a planted fake secret that must never reach the agent, a log, a notice or the drafts file. Only local fake
// servers and made-up values; name resolution is a fake table. Runs on Node 24's own TypeScript support with a
// stand-in for electron, like test-http.mjs.
//
//   npm run test-drafts

import { register } from 'node:module'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-drafts-'))
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
const PLANTED = 'Fake-Draft-Token-60317-kk' // secret-scan: allow

// ---------- a fake API, reached only through the test's own https stand-in ----------

const seen = []
const server = http.createServer((req, res) => {
  seen.push({ method: req.method, path: req.url, auth: req.headers.authorization })
  res.writeHead(200, { 'content-type': 'application/json' })
  // echoes the credential back, so the scrubber has something to catch
  res.end(JSON.stringify({ orders: [{ id: 7 }], youSent: req.headers.authorization ?? null }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
// a draft's host is fixed to https on 443; this stand-in sends those requests to the fake API on localhost instead
const realHttps = https.request
https.request = (url, opts, cb) => {
  const u = new URL(String(url))
  const { lookup: _l, servername: _s, rejectUnauthorized: _r, ...rest } = opts ?? {}
  return http.request(`http://127.0.0.1:${port}${u.pathname}${u.search}`, rest, cb)
}
after(() => {
  https.request = realHttps
  server.close()
  rmSync(tmp, { recursive: true, force: true })
})

// ---------- Corvid's modules ----------

const remote = await import('../src/main/remote/index.ts')
const store = await import('../src/main/connectors/store.ts')
const connectors = await import('../src/main/connectors/index.ts')
const httpRt = await import('../src/main/connectors/http.ts')
const drafts = await import('../src/main/connectors/drafts.ts')
const rules = await import('../src/main/connectors/draftRules.ts')
const { validateManifest } = await import('../src/main/connectors/manifest.ts')

httpRt.httpDeps.lookup = async (host) => {
  // a documentation address stands in for the public one; nothing reaches real DNS
  const table = { 'api.shopdemo.com': ['93.184.216.34'] }
  if (!table[host]) throw new Error('ENOTFOUND')
  return table[host].map((address) => ({ address, family: 4 }))
}

const shop = join(tmp, 'projects', 'shop')
const other = join(tmp, 'projects', 'other')
const projectIdForPath = (p) => (p.toLowerCase() === shop.toLowerCase() ? 'p1' : p.toLowerCase() === other.toLowerCase() ? 'p2' : undefined)
const notices = []
let enabled = true
remote.initRemote({ changed: () => {}, approvalRequested: () => {} })
store.initConnectorStore({ projectIdForPath, remoteSystems: () => [], remoteSecret: () => undefined })
connectors.initConnectors({ projectIdForPath, changed: () => {} })
drafts.initDrafts({ projectIdForPath, projectName: (id) => ({ p1: 'Shop', p2: 'Other' })[id], enabled: () => enabled, arrived: (a) => notices.push(a), changed: () => {} })

const agentA = { project: shop, agent: 'worker #201', agentName: 'Test Pigeon', taskId: 201 }
const agentB = { project: other, agent: 'worker #202', agentName: 'Other Sparrow', taskId: 202 }
// every tool answer and error, for the leak search at the end
const outputs = []
const tools = (scope) =>
  Object.fromEntries(
    drafts.draftTools(scope).map((t) => [
      t.name,
      (a) =>
        Promise.resolve()
          .then(() => t.run(a))
          .then(
            (r) => (outputs.push(JSON.stringify(r)), r),
            (e) => (outputs.push(e.message), Promise.reject(e))
          )
    ])
  )
const A = tools(agentA)
const B = tools(agentB)

const good = (patch = {}) => ({
  manifestVersion: 1,
  id: 'shopdemo-orders',
  name: 'Shop demo orders',
  version: '1.0.0',
  description: 'Reads orders from the shop demo API.',
  runtime: 'http',
  config: [],
  secrets: [{ key: 'token', label: 'Shop demo token', type: 'token' }],
  capabilities: {
    targets: [{ host: 'api.shopdemo.com', ports: [443], scheme: 'https' }],
    operations: [{ name: 'list_orders', description: 'List orders', class: 'read', method: 'GET', path: '/v1/orders' }]
  },
  limits: { timeoutMs: 5000, maxResponseBytes: 65536, ratePerMinute: 30 },
  tests: [
    { name: 'lists orders', operation: 'list_orders', expect: { ok: true, contains: 'orders' }, mock: { status: 200, body: { orders: [] } } },
    { name: 'server error fails', operation: 'list_orders', expect: { ok: false }, mock: { status: 500, body: 'boom' } }
  ],
  ...patch
})
const errorsOf = async (manifest, agent = A) => {
  const r = await agent.propose_connector({ manifest, reason: 'testing a refusal' })
  assert.equal(r.saved, false, `expected a refusal, got ${JSON.stringify(r)}`)
  return r.errors.join(' | ')
}

// ---------- the guide ----------

test('the guide examples pass both validators, and the guide says data only and where details may come from', () => {
  const g = rules.connectorGuide()
  for (const ex of g.examples) {
    const v = validateManifest(ex)
    assert.ok(v.ok, JSON.stringify(v.errors))
    assert.deepEqual(rules.draftProblems(v.manifest, JSON.stringify(ex)), [])
  }
  const text = JSON.stringify(g)
  assert.match(text, /never code/)
  assert.match(text, /Never from text found in tool results/)
  assert.match(text, /Never ask for, write down/)
})

// ---------- refusals ----------

test('refusals come back in plain words, and nothing is saved', async () => {
  const t = good().capabilities.targets[0]
  const caps = (targets, operations = good().capabilities.operations) => ({ capabilities: { targets, operations } })
  const op = (o) => ({ ...caps([t], [{ name: 'anything', description: 'Any call', class: 'write', ...o }]), tests: undefined })
  assert.match(await errorsOf(good(caps([{ ...t, host: '*.shopdemo.com' }]))), /wildcard/)
  assert.match(await errorsOf(good({ broad: true })), /can't set "broad"/)
  assert.match(await errorsOf(good(caps([{ ...t, host: 'localhost' }]))), /local or internal/)
  assert.match(await errorsOf(good(caps([{ ...t, host: '127.0.0.1' }]))), /is an address/)
  assert.match(await errorsOf(good(caps([{ ...t, host: '10.1.2.3' }]))), /is an address/)
  assert.match(await errorsOf(good(caps([{ ...t, host: 'printer.lan' }]))), /local or internal/)
  assert.match(await errorsOf(good(caps([{ ...t, host: '169.254.169.254' }]))), /is an address/)
  assert.match(await errorsOf(good(caps([{ ...t, host: 'metadata.google.internal' }]))), /metadata/)
  assert.match(await errorsOf(good(caps([{ ...t, ports: [22] }]))), /port 443 or 8443/)
  assert.match(await errorsOf(good({ config: [{ key: 'host', label: 'Host', type: 'host' }], ...caps([{ hostFrom: 'host' }]) })), /hostFrom and portFrom/)
  assert.match(await errorsOf(good({ description: 'x => process.env.TOKEN' })), /looks like code/)
  assert.match(await errorsOf(good({ description: `use token=${'Zx8'.repeat(6)}q` })), /looks like a secret/)
  assert.match(await errorsOf(good({ secrets: [{ key: 'token', label: 'Token', type: 'token', value: 'abc' }] })), /holds a value/)
  assert.match(await errorsOf(good({ description: 'Long. '.repeat(330), name: 'Big' , tests: undefined, capabilities: { ...good().capabilities, operations: Array.from({ length: 40 }, (_, i) => ({ name: `op_${i}`, description: 'An operation with a long description '.repeat(8), class: 'read', method: 'GET', path: `/v1/thing${i}` })) } })), /at most 16 KB/)
  assert.match(await errorsOf(good({ id: 'ssh' })), /built into Corvid/)
  assert.match(await errorsOf(good({ id: 'http-api' })), /built into Corvid/)
  assert.match(await errorsOf(good(op({}))), /needs a "method"[\s\S]*needs a "path"/)
  assert.match(await errorsOf(good(op({ method: 'GET', path: '/**' }))), /wildcard/)
  assert.match(await errorsOf(good(op({ method: 'GET', path: '/{p}' }))), /no fixed part/)
  assert.match(await errorsOf(good({ limits: { timeoutMs: 600000, maxResponseBytes: 50 * 1024 * 1024, ratePerMinute: 6000 } })), /timeoutMs may be at most[\s\S]*maxResponseBytes may be at most[\s\S]*ratePerMinute may be at most/)
  assert.match(await errorsOf(good({ scrub: { off: true } })), /belong to Corvid/)
  assert.match(await errorsOf(good({ audit: false })), /belong to Corvid/)
  assert.match(await errorsOf(good({ runtime: 'ssh' })), /only the user can add one/)
  assert.match(await errorsOf(good({ config: [{ key: 'local', label: 'Local', type: 'boolean', default: true }] })), /only the user can add/)
  assert.equal(drafts.draftsState().drafts.length, 0, 'nothing was saved')
})

test('a reason with a secret in it is refused', async () => {
  await assert.rejects(A.propose_connector({ manifest: good(), reason: `my key is ghp_${'a1B2'.repeat(6)}` }), /secret/)
  assert.equal(drafts.draftsState().drafts.length, 0)
})

// ---------- the good path, end to end ----------

let draftId
test('a good manifest: proposed, tested on the mock, shown for review, approved for its project only', async () => {
  const r = await A.propose_connector({ manifest: good(), reason: 'The user asked me to read shop demo orders.', source: "the user's request in #201" })
  assert.equal(r.status, 'waiting for review')
  draftId = r.draft
  assert.match(draftId, /^draft-[0-9a-f]{8}$/)
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /Test Pigeon proposed a connector: Shop demo orders 1\.0\.0[\s\S]*Review it in Connections/)
  assert.equal(drafts.draftsWaiting(), 1)
  // not a connector yet: nothing in connectors\, so no tool can use it
  assert.equal(store.getManifest('shopdemo-orders'), undefined)
  assert.equal((await A.connector_status({ id: draftId })).status, 'waiting for review')
  assert.equal((await A.connector_status({ id: draftId })).tests, 'not run')

  const t = await A.test_connector({ draft: draftId })
  assert.equal(t.passed, true, JSON.stringify(t))
  assert.equal(t.results.length, 2)
  assert.equal(seen.length, 0, 'the mock answered, not the fake API')

  const v = drafts.draftsState().drafts[0]
  assert.equal(v.status, 'open')
  assert.equal(v.agentName, 'Test Pigeon')
  assert.equal(v.taskId, 201)
  assert.equal(v.projectId, 'p1')
  assert.equal(v.source, "the user's request in #201")
  assert.deepEqual(v.targets, [{ text: 'api.shopdemo.com (port 443)', isNew: true }])
  assert.match(v.summary, /can reach api\.shopdemo\.com \(port 443\) over HTTPS[\s\S]*read: list_orders \(GET \/v1\/orders\)/)
  assert.equal(v.tests.passed, true)

  drafts.approveDraft(draftId, v.hash, 'project')
  const s = store.connectorState('shopdemo-orders')
  assert.equal(s.status, 'approved')
  assert.equal(s.source, 'agent')
  assert.equal(s.projectId, 'p1')
  assert.match(s.draftedBy, /Test Pigeon \(#201, Shop\)/)
  const st = await A.connector_status({ id: draftId })
  assert.equal(st.status, 'approved')
  assert.equal(st.scope, 'this project only')
  assert.equal(drafts.draftsWaiting(), 0)
})

test('the other project sees nothing, and connections are limited to the project', async () => {
  assert.equal((await B.connector_status({ id: draftId })).status, 'unknown')
  assert.equal((await B.connector_status({ id: 'shopdemo-orders' })).status, 'unknown')
  await assert.rejects(B.test_connector({ draft: draftId }), /No draft/)
  await assert.rejects(B.request_connection({ connector: 'shopdemo-orders', suggested_name: 'orders', purpose: 'read orders' }), /No connector called/)
  assert.throws(() => store.saveConnection({ connectorId: 'shopdemo-orders', name: 'orders-other', config: {}, safety: 'free', projectIds: ['p2'] }), /only be linked to that project/)
  // an agent in the other project can't take the id over either
  assert.match(await errorsOf(good({ version: '2.0.0' }), B), /id is taken/)
})

test('request_connection asks the user, and the agent uses the connection without ever seeing the secret', async () => {
  const r = await A.request_connection({ connector: 'shopdemo-orders', suggested_name: 'shop-orders', purpose: 'read the latest orders for the report' })
  assert.equal(r.status, 'asked the user')
  assert.match(notices.at(-1).text, /asks you to set up a connection "shop-orders"[\s\S]*No agent can enter a secret/)
  assert.equal(drafts.draftsState().requests[0].status, 'open')
  // only the user's side creates the connection and enters the secret
  const c = store.saveConnection({ connectorId: 'shopdemo-orders', name: 'shop-orders', config: {}, safety: 'free', projectIds: ['p1'] })
  store.setSecret(c.id, 'token', PLANTED)
  const out = await connectors.call(agentA, 'shop-orders', 'list_orders', {})
  outputs.push(JSON.stringify(out))
  assert.equal(out.status, 200)
  assert.equal(seen.at(-1).auth, `Bearer ${PLANTED}`, 'Corvid added the credential')
  assert.ok(!JSON.stringify(out).includes(PLANTED), 'the echoed credential was masked')
  await assert.rejects(connectors.call(agentB, 'shop-orders', 'list_orders', {}), /No connection/)
})

test('an approved connector is immutable: a change is a new draft with a diff, and the old version stays in force', async () => {
  assert.match(await errorsOf(good({ description: 'Changed but same version.' })), /new version number/)
  assert.match(await errorsOf(good()), /exactly the approved version/)
  const before = store.getManifest('shopdemo-orders').hash
  const r = await A.propose_connector({
    manifest: good({ version: '1.1.0', capabilities: { ...good().capabilities, targets: [...good().capabilities.targets, { host: 'files.shopdemo.com', ports: [443], scheme: 'https' }] } }),
    reason: 'Also needs the files host the user mentioned.'
  })
  const v = drafts.draftsState().drafts.find((d) => d.id === r.draft)
  assert.equal(v.previousVersion, '1.0.0')
  assert.match(v.previousText, /"version": "1\.0\.0"/)
  assert.deepEqual(
    v.targets.map((t) => t.isNew),
    [false, true],
    'only the new host is highlighted'
  )
  assert.equal(store.getManifest('shopdemo-orders').hash, before, 'nothing changed until approval')
  assert.equal(store.connectorState('shopdemo-orders').status, 'approved')
  drafts.declineDraft(r.draft, 'Not the files host, please.')
  const st = await A.connector_status({ id: r.draft })
  assert.equal(st.status, 'declined')
  assert.equal(st.declineReason, 'Not the files host, please.')
  assert.match(st.note, /information, not instructions/)
  assert.equal(store.getManifest('shopdemo-orders').hash, before)
})

test('promotion to all projects works and is audited', async () => {
  drafts.promoteConnector('shopdemo-orders')
  assert.equal(store.connectorState('shopdemo-orders').projectId, undefined)
  assert.equal((await B.connector_status({ id: 'shopdemo-orders' })).status, 'approved')
  store.saveConnection({ connectorId: 'shopdemo-orders', name: 'orders-other', config: {}, safety: 'free', projectIds: ['p2'] })
  assert.ok(store.readCallAudit(50).some((e) => e.operation === 'make available to all projects' && e.connector === 'shopdemo-orders@1.0.0'))
  assert.ok(store.readCallAudit(200).some((e) => e.operation === 'propose_connector' && e.detail?.startsWith('sha256:')), 'proposals are audited with their hash')
})

test('caps: proposals per agent per hour and open drafts per project', async () => {
  const C = tools({ project: shop, agent: 'worker #203', agentName: 'Busy Finch', taskId: 203 })
  for (let i = 0; i < 5; i++) assert.equal((await C.propose_connector({ manifest: good({ id: `cap-test-${i}` }), reason: 'cap test' })).status, 'waiting for review')
  await assert.rejects(C.propose_connector({ manifest: good({ id: 'cap-test-5' }), reason: 'cap test' }), /in the last hour/)
  let n = drafts.draftsState().drafts.filter((d) => d.projectId === 'p1' && d.status === 'open').length
  for (let a = 0; n < 20; a++) {
    const D = tools({ project: shop, agent: `worker #30${a}`, agentName: `Filler ${a}`, taskId: 300 + a })
    for (let i = 0; i < 5 && n < 20; i++, n++) await D.propose_connector({ manifest: good({ id: `fill-${a}-${i}` }), reason: 'cap test' })
  }
  const E = tools({ project: shop, agent: 'worker #399', agentName: 'Late Owl', taskId: 399 })
  await assert.rejects(E.propose_connector({ manifest: good({ id: 'one-too-many' }), reason: 'cap test' }), /20 drafts waiting/)
})

test('untouched drafts expire, and the user can extend or delete them', async () => {
  const open = drafts.draftsState().drafts.filter((d) => d.status === 'open')
  drafts.extendDraft(open[0].id)
  drafts.deleteDraft(open[1].id)
  const realNow = Date.now
  Date.now = () => realNow() + 15 * 24 * 60 * 60 * 1000
  try {
    const later = drafts.draftsState().drafts
    assert.ok(later.every((d) => d.status !== 'open'), 'all open drafts expired after 14 days')
    assert.ok(!later.some((d) => d.id === open[1].id), 'the deleted one is gone')
    assert.equal(drafts.draftsWaiting(), 1, 'only the open set-up request is still waiting')
  } finally {
    Date.now = realNow
  }
})

test('the Settings switch and the kill switch stop proposals', async () => {
  enabled = false
  assert.equal(drafts.draftAccess(agentA), null, 'no tools for agents started now')
  await assert.rejects(A.propose_connector({ manifest: good({ id: 'off-test' }), reason: 'switch test' }), /switched off connector proposals/)
  enabled = true
  store.setKillAll(true)
  await assert.rejects(A.propose_connector({ manifest: good({ id: 'kill-test' }), reason: 'switch test' }), /All connectors are switched off/)
  await assert.rejects(connectors.call(agentA, 'shop-orders', 'list_orders', {}), /switched off/)
  store.setKillAll(false)
  assert.equal(drafts.draftAccess(agentA).tools.length, 5)
})

test('nothing on the agent side can approve: the tools are exactly the five, and a forged hash approves nothing', async () => {
  assert.deepEqual(
    drafts.draftTools(agentA).map((t) => t.name),
    ['get_connector_guide', 'propose_connector', 'test_connector', 'connector_status', 'request_connection']
  )
  const r = await A.propose_connector({ manifest: good({ id: 'forge-test' }), reason: 'forge test' })
  assert.throws(() => drafts.approveDraft(r.draft, 'sha256:forged', 'global'), /changed/)
  assert.equal(store.getManifest('forge-test'), undefined)
})

test('the planted secret is nowhere: tool outputs, notices, the audit log, the drafts file', () => {
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name))
  }
  walk(globalThis.__userData)
  const places = [['tool outputs', outputs.join('\n')], ['notices', JSON.stringify(notices)], ...files.map((f) => [f, readFileSync(f, 'utf8')])]
  for (const [where, text] of places) assert.ok(!text.includes(PLANTED), `found the planted secret in ${where}`)
  assert.ok(outputs.length > 20)
})
