// Tests for #88, the Connections tab's main-process side: import and validation, approve from the tab, disable and
// enable, the diff against the approved version, delete with and without connections, secrets set, replaced and
// cleared without ever reaching the window, the merged log and its export, and the kill switch. Fake data and a
// fake SSH server on localhost only.
//
//   npm run test-connections-tab

import { register } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { generateKeyPairSync } from 'node:crypto'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-conntab-'))
globalThis.__userData = join(tmp, 'data')
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
// electron as far as these modules use it; safeStorage "encrypts" by xor so nothing plain lands on disk
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

const SECRET = 'Tab-Fake-Secret-4410' // a made-up value for the leak search (secret-scan: allow)
const data = globalThis.__userData
const proj = join(tmp, 'projects', 'shop')

const HTTP = {
  manifestVersion: 1,
  id: 'example-api',
  name: 'Example API',
  version: '1.2.0',
  description: 'Reads and creates orders in the example shop.',
  runtime: 'http',
  config: [{ key: 'region', label: 'Region', type: 'string' }],
  secrets: [{ key: 'api_key', label: 'API key', type: 'token' }],
  capabilities: {
    targets: [{ host: 'api.example.com', ports: [443], scheme: 'https' }],
    operations: [
      { name: 'list_orders', description: 'List orders', class: 'read', method: 'GET', path: '/v1/orders' },
      { name: 'create_order', description: 'Create an order', class: 'write', method: 'POST', path: '/v1/orders' }
    ]
  },
  limits: { timeoutMs: 10000, maxResponseBytes: 1048576 }
}

// a fake SSH server on localhost: the tab's Test button, and run_on for the Activity inbox
const require = createRequire(import.meta.url)
const { Server } = require('ssh2')
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === SECRET ? ctx.accept() : ctx.reject(['password'])))
  client.on('session', (accept) =>
    accept().on('exec', (acc, _rej, info) => {
      const s = acc()
      s.write(`ran: ${info.command}\n`)
      s.exit(0)
      s.end()
    })
  )
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
after(() => {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
})

const xor = (s) => Buffer.from([...Buffer.from('fake-dpapi:' + s)].map((c) => c ^ 0x5a)).toString('base64')
mkdirSync(join(data, 'remote'), { recursive: true })
writeFileSync(
  join(data, 'remote', 'connections.json'),
  JSON.stringify({ systems: [{ id: 'sys-1', name: 'fake-box', host: '127.0.0.1', port, user: 'tester', auth: 'password', projects: [proj], safety: 'strict', createdAt: 1, updatedAt: 2 }] })
)
writeFileSync(join(data, 'remote', 'secrets.json'), JSON.stringify({ 'sys-1': { password: xor(SECRET) } }))
writeFileSync(
  join(data, 'remote', 'audit.jsonl'),
  JSON.stringify({ ts: 5, system: 'fake-box', target: 'x', command: 'uptime', agent: 'worker #3', safety: 'strict', readOnly: true, decision: 'auto', approvedBy: 'auto' }) + '\n'
)

const remoteStore = await import('../src/main/remote/store.ts')
const remote = await import('../src/main/remote/index.ts')
const store = await import('../src/main/connectors/store.ts')
const connectors = await import('../src/main/connectors/index.ts')
const manage = await import('../src/main/connectors/manage.ts')
const { testConnection } = await import('../src/main/remote/ssh.ts')
const projectIdForPath = (p) => (p.toLowerCase() === proj.toLowerCase() ? 'p1' : undefined)
remoteStore.initStore()
remote.initRemote({ changed: () => {}, approvalRequested: () => {} })
store.initConnectorStore({ projectIdForPath, remoteSystems: remoteStore.listSystems, remoteSecret: remoteStore.getSecret })
connectors.initConnectors({ projectIdForPath, changed: () => {} })
const agent = { project: proj, agent: 'worker #1' }
const answerNext = async (approve) => {
  for (let i = 0; i < 200 && !remote.listApprovals().length; i++) await new Promise((r) => setTimeout(r, 10))
  const a = remote.listApprovals()[0]
  assert.ok(a, 'an approval was requested')
  remote.decide(a.id, approve)
  return a
}
/** everything the tab's IPC sends to the window */
const toWindow = () => [
  JSON.stringify(store.connectionsState()),
  ...store.connectorInfos().map((c) => JSON.stringify(manage.connectorDetail(c.id))),
  JSON.stringify(manage.mergedAudit()),
  manage.auditExport()
]

test('existing SSH servers show as connections, and the tab can test one against a fake server', async () => {
  const c = store.connectionsState().connections.find((x) => x.name === 'fake-box')
  assert.equal(c.connectorId, 'ssh')
  assert.deepEqual(c.secretsSet, { password: true, passphrase: false })
  assert.equal(c.secretRefs, undefined, 'no slot references reach the window')
  const r = await testConnection(remoteStore.getSystem('sys-1'))
  assert.ok(r.newHostKey, 'connected and remembered the host key')
})

test('import: an invalid manifest is refused with plain errors; a valid one is added waiting for approval', () => {
  const bad = manage.checkManifest(JSON.stringify({ ...HTTP, id: 'Bad Id', extra: 1 }))
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.length >= 1)
  assert.equal(manage.checkManifest(JSON.stringify({ ...HTTP, id: 'ssh' })).ok, false, 'a built-in id is refused')
  assert.throws(() => manage.importManifest('{ nope'))
  const good = manage.checkManifest(JSON.stringify(HTTP))
  assert.equal(good.ok, true)
  assert.match(good.summary, /api\.example\.com/)
  assert.equal(manage.importManifest(JSON.stringify(HTTP)), 'example-api')
  const d = manage.connectorDetail('example-api')
  assert.equal(d.status, 'pending', 'added is not active')
  assert.equal(d.reads.length, 1)
  assert.equal(d.secretSlots[0].key, 'api_key')
})

test('add, edit, link, unlink, replace and clear a secret, delete: values never come back', () => {
  const v = store.saveConnection({ connectorId: 'example-api', name: 'shop-api', config: { region: 'eu' }, projectIds: [] })
  assert.equal(v.safety, 'strict')
  assert.deepEqual(
    store.connectionsForProject('p1').map((c) => c.name),
    ['fake-box'],
    'linked to no project: visible to no agent'
  )
  store.saveConnection({ id: v.id, connectorId: 'example-api', name: 'shop-api', config: { region: 'us' }, safety: 'approve-writes', projectIds: ['p1'] })
  assert.ok(store.connectionsForProject('p1').some((c) => c.name === 'shop-api'))
  assert.equal(store.getConnection(v.id).config.region, 'us')
  assert.equal(store.getConnection(v.id).safety, 'approve-writes', 'the new level is what the next call reads')
  assert.equal(store.setSecret(v.id, 'api_key', SECRET + '-a'), true)
  assert.equal(store.setSecret(v.id, 'api_key', SECRET + '-b'), true, 'replaced')
  assert.equal(store.secretValue(store.getConnection(v.id), 'api_key'), SECRET + '-b')
  for (const t of toWindow()) assert.ok(!t.includes(SECRET), 'no secret value in anything sent to the window')
  assert.equal(store.connectionsState().connections.find((c) => c.id === v.id).secretsSet.api_key, true)
  assert.equal(store.setSecret(v.id, 'api_key', null), false, 'cleared')
  assert.equal(store.connectionsState().connections.find((c) => c.id === v.id).secretsSet.api_key, false)
  store.saveConnection({ id: v.id, connectorId: 'example-api', name: 'shop-api', config: { region: 'us' }, safety: 'approve-writes', projectIds: [] })
  assert.ok(!store.connectionsForProject('p1').some((c) => c.name === 'shop-api'), 'unlinked')
  store.setSecret(v.id, 'api_key', SECRET + '-c')
  store.deleteConnection(v.id)
  assert.equal(store.getConnection(v.id), undefined)
  assert.ok(!readFileSync(join(data, 'connections', 'secrets.json'), 'utf8').includes(v.id), 'its secret is deleted too')
})

test('approve from the tab, disable, enable; a changed version shows a diff against the approved one', () => {
  const d = manage.connectorDetail('example-api')
  manage.decideConnector('example-api', 'sha256:not-this-one', true)
  assert.equal(manage.connectorDetail('example-api').status, 'pending', 'only the exact hash shown is approved')
  manage.decideConnector('example-api', d.hash, true)
  assert.equal(manage.connectorDetail('example-api').status, 'approved')
  assert.equal(manage.connectorDetail('example-api').previousText, undefined)
  connectors.switchOffConnector('example-api', true)
  assert.equal(manage.connectorDetail('example-api').disabled, true)
  connectors.switchOffConnector('example-api', false)
  assert.equal(manage.connectorDetail('example-api').status, 'approved', 'enabling restores the approval')
  manage.importManifest(JSON.stringify({ ...HTTP, version: '1.3.0', description: 'Now also refunds.' }))
  const changed = manage.connectorDetail('example-api')
  assert.equal(changed.status, 'pending', 'a changed version waits for approval again')
  assert.match(changed.previousText, /"version": "1.2.0"/)
  assert.match(changed.manifestText, /"version": "1.3.0"/)
})

test('delete a connector with and without connections using it', () => {
  manage.importManifest(JSON.stringify({ ...HTTP, id: 'spare-api', name: 'Spare' }))
  manage.deleteConnector('spare-api')
  assert.equal(manage.connectorDetail('spare-api'), undefined)
  const v = store.saveConnection({ connectorId: 'example-api', name: 'doomed', config: {}, projectIds: ['p1'] })
  store.setSecret(v.id, 'api_key', SECRET + '-d')
  assert.deepEqual(manage.connectorDetail('example-api').usedBy, ['doomed'])
  manage.deleteConnector('example-api')
  assert.equal(store.getConnection(v.id), undefined, 'its connections go with it')
  assert.ok(!readFileSync(join(data, 'connections', 'secrets.json'), 'utf8').includes(v.id))
  assert.throws(() => manage.deleteConnector('ssh'), /built into Corvid/)
})

test('activity: approve and decline a waiting call, the merged log, and an export without secrets or results', async () => {
  // fake-box is Strict, so every call waits for the user
  const first = remote.runOn(agent, 'fake-box', 'uptime')
  await answerNext(true)
  assert.match(await first, /ran: uptime/)
  const second = remote.runOn(agent, 'fake-box', `echo ${SECRET}`)
  await answerNext(false)
  await assert.rejects(second)
  const log = manage.mergedAudit()
  assert.ok(log.some((e) => e.operation === 'run_on' && e.decision === 'approved'))
  assert.ok(log.some((e) => e.decision === 'denied'))
  assert.ok(log.some((e) => e.agent === 'worker #3' && e.decision === 'automatic'), 'older run_on lines are mapped too')
  assert.deepEqual([...log].sort((a, b) => b.ts - a.ts), log, 'newest first')
  assert.ok(!manage.auditExport().includes('ran: uptime'), 'no results in the export')
  for (const t of toWindow()) assert.ok(!t.includes(SECRET), 'no secret in the log or export')
})

test('kill switch from the tab: what an agent sees, then back on', async () => {
  connectors.switchOffAll(true)
  assert.equal(store.connectionsState().killSwitch, true)
  await assert.rejects(remote.runOn(agent, 'fake-box', 'ls'), /switched off/)
  connectors.switchOffAll(false)
  assert.equal(store.connectionsState().killSwitch, false)
})
