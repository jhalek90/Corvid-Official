// Tests for #87, connectors and connections: the manifest validator and hash, capabilitySummary, first-use approval,
// safety levels, project scoping, secrets never leaking, the move of SSH servers into connections, run_on and call
// against a fake SSH server on localhost, and the kill switch. Runs on Node 24's own TypeScript support with a
// stand-in for electron; all data is fake and lives in a temp folder.
//
//   npm run test-connectors

import { register } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { generateKeyPairSync } from 'node:crypto'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-connectors-'))
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

const { validateManifest, manifestHash, canonical, capabilitySummary } = await import('../src/main/connectors/manifest.ts')
const policy = await import('../src/main/connectors/policy.ts')
const { SSH_CONNECTOR } = await import('../src/main/connectors/builtin.ts')

const clone = (o) => JSON.parse(JSON.stringify(o))
const HTTP = {
  manifestVersion: 1,
  id: 'example-api',
  name: 'Example API',
  version: '1.2.0',
  description: 'Reads and creates orders in the example shop.',
  runtime: 'http',
  config: [],
  secrets: [{ key: 'api_key', label: 'API key', type: 'token' }],
  capabilities: {
    targets: [{ host: 'api.example.com', ports: [443], scheme: 'https' }],
    operations: [
      { name: 'list_orders', description: 'List orders', class: 'read', method: 'GET', path: '/v1/orders' },
      { name: 'create_order', description: 'Create an order', class: 'write', method: 'POST', path: '/v1/orders' }
    ]
  },
  limits: { timeoutMs: 10000, maxResponseBytes: 1048576, ratePerMinute: 60 },
  tests: [{ name: 'lists', operation: 'list_orders', expect: { ok: true } }]
}
const DB = {
  manifestVersion: 1,
  id: 'shop-db',
  name: 'Shop database',
  version: '0.1.0',
  description: 'The shop database, read-only reporting plus admin maintenance.',
  runtime: 'postgres',
  config: [{ key: 'host', label: 'Host', type: 'host', required: true }],
  secrets: [{ key: 'password', label: 'DB password', type: 'password' }],
  capabilities: {
    targets: [{ hostFrom: 'host', ports: [5432], database: 'shop' }],
    operations: [
      { name: 'query', description: 'Run a SELECT', class: 'read', statements: ['SELECT'] },
      { name: 'vacuum', description: 'Vacuum a table', class: 'admin', statements: ['VACUUM'] }
    ]
  },
  limits: { timeoutMs: 30000, maxResponseBytes: 5242880 }
}

// ---------- validator ----------

test('good manifests pass: ssh, http, database', () => {
  for (const m of [SSH_CONNECTOR, HTTP, DB]) {
    const r = validateManifest(m)
    assert.ok(r.ok, JSON.stringify(r.errors))
  }
})

test('every rejection rule', () => {
  const bad = (mutate, re) => {
    const m = clone(HTTP)
    mutate(m)
    const r = validateManifest(m)
    assert.ok(!r.ok, `should reject: ${re}`)
    assert.ok(r.errors.some((e) => re.test(e)), `${re} not in ${JSON.stringify(r.errors)}`)
  }
  bad((m) => (m.capabilities.operations[0].description = 'x => fetch(evil)'), /looks like code/)
  bad((m) => (m.description = 'calls require("child_process")'), /looks like code/)
  bad((m) => (m.secrets[0].value = 'hunter2hunter2'), /holds a value/)
  bad((m) => (m.config.push({ key: 'auth', label: 'Auth', type: 'string', default: 'Bearer abcdefghijklmnopqrstuvwx' })), /secret value/)
  bad((m) => (m.description = 'token: ghp_abcdefghijklmnopqrstuvwxyz0123'), /secret value/)
  bad((m) => (m.description = 'k Zx8vQ2pL9mN4bR7tY1wE5uI3oA6sD0fG2hJ'), /secret value/)
  bad((m) => (m.capabilities.targets[0].host = '*.example.com'), /wildcard/)
  bad((m) => (m.capabilities.targets = []), /at least one host/)
  bad((m) => delete m.capabilities.targets, /at least one host/)
  bad((m) => (m.extra = 1), /unknown field "extra"/)
  bad((m) => (m.capabilities.operations[0].script = 'x'), /unknown field "script"/)
  bad((m) => (m.description = 'x'.repeat(70 * 1024)), /larger than/)
  bad((m) => (m.version = '1.2'), /semantic version/)
  bad((m) => (m.version = 'v1.2.0'), /semantic version/)
  bad((m) => (m.capabilities.operations[0].class = 'superuser'), /read, write or admin/)
  bad((m) => (m.runtime = 'python'), /runtime must be/)
  // a deliberately broad connector is allowed, with the flag
  const broad = clone(HTTP)
  broad.broad = true
  broad.capabilities.targets = [{ host: '*' }]
  const r = validateManifest(broad)
  assert.ok(r.ok, JSON.stringify(r.errors))
  assert.match(capabilitySummary(r.manifest), /^Warning: this connector is marked broad/)
})

test('the JSON schema names the same fields as the validator', () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src', 'main', 'connectors', 'manifest.schema.json'), 'utf8'))
  const top = ['manifestVersion', 'id', 'name', 'version', 'description', 'runtime', 'broad', 'config', 'secrets', 'capabilities', 'limits', 'scrub', 'tests']
  assert.deepEqual(Object.keys(schema.properties).sort(), [...top].sort())
  const m = clone(HTTP)
  m.unknownThing = 1
  assert.ok(!validateManifest(m).ok && schema.additionalProperties === false)
})

test('the hash changes with any edit; the canonical form is stable', () => {
  const h = manifestHash(HTTP)
  const reordered = Object.fromEntries(Object.entries(clone(HTTP)).reverse())
  assert.equal(manifestHash(reordered), h, 'key order does not matter')
  assert.equal(canonical(reordered), canonical(HTTP))
  for (const edit of [(m) => (m.version = '1.2.1'), (m) => (m.capabilities.operations[0].path = '/v1/order'), (m) => (m.limits.timeoutMs = 10001), (m) => (m.secrets[0].label = 'API Key')]) {
    const m = clone(HTTP)
    edit(m)
    assert.notEqual(manifestHash(m), h)
  }
})

// ---------- capabilitySummary ----------

test('capabilitySummary reads well for ssh, http and a database', () => {
  const ssh = capabilitySummary(SSH_CONNECTOR, { config: { host: 'build.example.test', port: 22 }, secretsSet: { password: true, passphrase: false } })
  assert.match(ssh, /reach build\.example\.test \(port 22\) over SSH/)
  assert.match(ssh, /the password you saved as 'Password'/)
  assert.match(ssh, /read data, change data and make administrative changes/)
  const http = capabilitySummary(HTTP, { secretsSet: { api_key: true } })
  assert.match(http, /reach api\.example\.com \(port 443\) over HTTPS/)
  assert.match(http, /read: list_orders \(GET \/v1\/orders\); write: create_order \(POST \/v1\/orders\)/)
  assert.match(http, /token you saved as 'API key'/)
  assert.match(http, /It can read and change data\./)
  const db = capabilitySummary(DB)
  assert.match(db, /database shop on the host set in each connection \(port 5432\) as a PostgreSQL database/)
  assert.match(db, /administer: vacuum \(VACUUM\)/)
  console.log('\n  ssh:  ' + ssh + '\n  http: ' + http + '\n  db:   ' + db + '\n')
})

// ---------- policy ----------

test('safety levels against read, write and admin', () => {
  const expect = {
    free: { read: false, write: false, admin: true },
    'approve-writes': { read: false, write: true, admin: true },
    strict: { read: true, write: true, admin: true }
  }
  for (const [lvl, row] of Object.entries(expect)) for (const [cls, ask] of Object.entries(row)) assert.equal(policy.needsUser(lvl, cls), ask, `${lvl}/${cls}`)
  assert.equal(policy.needsUser('free', 'admin', true), false, 'admin runs unasked only on Free with the box ticked')
  assert.equal(policy.needsUser('approve-writes', 'admin', true), true)
  assert.equal(policy.normalSafety(undefined), 'strict')
  assert.equal(policy.normalSafety('nonsense'), 'strict')
})

// ---------- the store, approvals, scoping, secrets, migration, calls ----------

const SECRET = 'Planted-Fake-Secret-7731' // a made-up value for the leak search (secret-scan: allow)
const PASS2 = 'Another-Fake-Pass-9902'
const data = globalThis.__userData
const proj = join(tmp, 'projects', 'shop')
const other = join(tmp, 'projects', 'blog')
const xor = (s) => Buffer.from([...Buffer.from('fake-dpapi:' + s)].map((c) => c ^ 0x5a)).toString('base64')

// a fake SSH server on localhost: password auth, echoes the command, and leaks the secret in several encodings
const require = createRequire(import.meta.url)
const { Server } = require('ssh2')
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
const ran = []
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === SECRET ? ctx.accept() : ctx.reject(['password'])))
  client.on('session', (accept) =>
    accept().on('exec', (acc, _rej, info) => {
      ran.push(info.command)
      const s = acc()
      const b64 = Buffer.from(SECRET).toString('base64')
      s.write(`ran: ${info.command}\nleak ${SECRET} ${b64} ${encodeURIComponent(SECRET)} ${Buffer.from(SECRET).toString('hex')} ${[...SECRET].reverse().join('')}\n`)
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

// real-shaped remote data from before #87
mkdirSync(join(data, 'remote'), { recursive: true })
const systems = [
  { id: 'sys-1', name: 'fake-box', host: '127.0.0.1', port, user: 'tester', auth: 'password', projects: [proj], safety: 'approve-writes', createdAt: 1, updatedAt: 2 },
  { id: 'sys-2', name: 'old-box', host: 'old.example.test', port: 22, user: 'ops', auth: 'password', projects: [join(tmp, 'gone')], safety: 'strict', createdAt: 3, updatedAt: 4 }
]
writeFileSync(join(data, 'remote', 'connections.json'), JSON.stringify({ systems }))
writeFileSync(join(data, 'remote', 'secrets.json'), JSON.stringify({ 'sys-1': { password: xor(SECRET) }, 'sys-2': { password: xor(PASS2) } }))
writeFileSync(join(data, 'remote', 'known-hosts.json'), JSON.stringify({ 'old.example.test:22': { type: 'ssh-ed25519', fingerprint: 'SHA256:fake', firstSeen: 1 } }))
writeFileSync(join(data, 'remote', 'audit.jsonl'), JSON.stringify({ ts: 1, system: 'old-box', command: 'uptime', decision: 'auto' }) + '\n')
const remoteBefore = Object.fromEntries(readdirSync(join(data, 'remote')).map((f) => [f, readFileSync(join(data, 'remote', f), 'utf8')]))

const remoteStore = await import('../src/main/remote/store.ts')
const remote = await import('../src/main/remote/index.ts')
const store = await import('../src/main/connectors/store.ts')
const connectors = await import('../src/main/connectors/index.ts')
const httpRt = await import('../src/main/connectors/http.ts')
const projectIdForPath = (p) => (p.toLowerCase() === proj.toLowerCase() ? 'p1' : p.toLowerCase() === other.toLowerCase() ? 'p2' : undefined)
const requests = []
remote.initRemote({ changed: () => {}, approvalRequested: (a) => requests.push(a) })
const storeDeps = { projectIdForPath, remoteSystems: remoteStore.listSystems, remoteSecret: remoteStore.getSecret }
store.initConnectorStore(storeDeps)
connectors.initConnectors({ projectIdForPath, changed: () => {} })
const shopAgent = { project: proj, agent: 'worker #1' }
const blogAgent = { project: other, agent: 'worker #2' }
/** answer the next approval as Corvid's dialog would (remote:decide) */
const answerNext = async (approve) => {
  for (let i = 0; i < 200 && !remote.listApprovals().length; i++) await new Promise((r) => setTimeout(r, 10))
  const a = remote.listApprovals()[0]
  assert.ok(a, 'an approval was requested')
  remote.decide(a.id, approve)
  return a
}

test('migration: systems, secrets, known hosts, audit and links survive; running twice changes nothing', () => {
  const list = store.listConnections()
  assert.deepEqual(list.map((c) => [c.id, c.name, c.safety, c.connectorId]).sort(), [
    ['sys-1', 'fake-box', 'approve-writes', 'ssh'],
    ['sys-2', 'old-box', 'strict', 'ssh']
  ])
  assert.deepEqual(store.getConnection('sys-1').projectIds, ['p1'])
  assert.deepEqual(store.getConnection('sys-2').projectIds, [], 'an unknown folder links to no project')
  assert.deepEqual(store.getConnection('sys-2').unlinkedPaths, [join(tmp, 'gone')], 'and is kept so nothing is lost')
  assert.equal(store.secretValue(store.getConnection('sys-1'), 'password'), SECRET)
  assert.deepEqual(store.view(store.getConnection('sys-2')).secretsSet, { password: true, passphrase: false })
  assert.equal(store.connectorState('ssh').status, 'approved', 'SSH was in use already, so it is approved by the migration')
  const backup = store.migrationInfo().remote.backup
  assert.ok(existsSync(join(backup, 'connections.json')) && existsSync(join(backup, 'known-hosts.json')) && existsSync(join(backup, 'audit.jsonl')))
  assert.ok(!existsSync(join(backup, 'secrets.json')), 'secrets are not copied into the backup')
  const first = readFileSync(join(data, 'connections', 'connections.json'), 'utf8')
  store.initConnectorStore(storeDeps)
  store.syncRemote()
  assert.equal(readFileSync(join(data, 'connections', 'connections.json'), 'utf8'), first)
  assert.equal(store.migrationInfo().remote.backup, backup, 'one backup, before the first run')
  for (const [f, text] of Object.entries(remoteBefore)) assert.equal(readFileSync(join(data, 'remote', f), 'utf8'), text, `remote/${f} untouched`)
})

test('project scoping: an agent sees only its project; an unlinked connection is seen by none', async () => {
  const list = (scope) => connectors.connectionTools(scope).find((t) => t.name === 'list_connections').run({})
  assert.deepEqual(list(shopAgent).map((c) => c.name), ['fake-box'])
  assert.equal(list(blogAgent), 'No connections are linked to this project.')
  assert.equal(connectors.connectionsAccess(blogAgent), null)
  await assert.rejects(connectors.call(blogAgent, 'fake-box', 'run', { command: 'ls' }), /No connections are linked/)
  await assert.rejects(connectors.call(shopAgent, 'old-box', 'run', { command: 'ls' }), /No connection called "old-box"/)
})

test('run_on still works against a fake SSH server, with output scrubbed', async () => {
  const out = await remote.runOn(shopAgent, 'fake-box', 'uptime')
  assert.match(out, /exit code: 0/)
  assert.match(out, /ran: uptime/)
  assert.match(out, /first connection: remembered host key/)
  assert.ok(!out.includes(SECRET))
  assert.ok(store.migrationInfo().remote.confirmedAt, 'a successful call confirms the move')
})

test('first use asks; approve works; a changed hash asks again; decline refuses cleanly', async () => {
  const dir = join(data, 'connectors')
  writeFileSync(join(dir, 'example-api.json'), JSON.stringify(HTTP))
  store.initConnectorStore(storeDeps)
  const c = store.saveConnection({ connectorId: 'example-api', name: 'shop-api', config: {}, projectIds: ['p1'] })
  assert.equal(c.safety, 'strict', 'new connections default to Strict')
  store.setSecret(c.id, 'api_key', SECRET + '-api')
  assert.deepEqual(store.view(store.getConnection(c.id)).secretsSet, { api_key: true })

  // first use: the connector approval dialog, then (Strict) the call itself. Fake DNS sends api.example.com to
  // loopback, so the http runtime (#89) refuses it before anything leaves the machine.
  httpRt.httpDeps.lookup = async () => [{ address: '127.0.0.1', family: 4 }]
  const p = connectors.call(shopAgent, 'shop-api', 'list_orders', {})
  const a = await answerNext(true)
  assert.equal(a.kind, 'connector')
  assert.match(a.summary, /api\.example\.com/)
  assert.deepEqual(a.details.find((d) => d.label.startsWith('Saved secrets')).items, ['API key'])
  assert.ok(!JSON.stringify(a).includes(SECRET))
  const b = await answerNext(true)
  assert.equal(b.kind, 'command')
  await assert.rejects(p, /private, loopback or link-local/)
  assert.equal(store.connectorState('example-api').status, 'approved')
  assert.equal(store.connectorState('example-api').decidedHash, manifestHash(HTTP))

  // a new version needs approval again; decline gives a clean refusal
  const v2 = clone(HTTP)
  v2.version = '1.3.0'
  writeFileSync(join(dir, 'example-api.json'), JSON.stringify(v2))
  store.initConnectorStore(storeDeps)
  assert.equal(store.connectorState('example-api').status, 'pending')
  const p2 = connectors.call(shopAgent, 'shop-api', 'list_orders', {})
  await answerNext(false)
  await assert.rejects(p2, (e) => e.message === 'The user did not approve this connector. Nothing was run.')
  await assert.rejects(connectors.call(shopAgent, 'shop-api', 'list_orders', {}), /declined this connector/)
  assert.equal(remote.listApprovals().length, 0, 'a declined connector does not ask again')
})

test('an unanswered approval times out and refuses', async () => {
  const dir = join(data, 'connectors')
  writeFileSync(join(dir, 'shop-db.json'), JSON.stringify(DB))
  store.initConnectorStore(storeDeps)
  store.saveConnection({ connectorId: 'shop-db', name: 'shop-db', config: { host: 'db.example.test' }, projectIds: ['p1'] })
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const p = connectors.call(shopAgent, 'shop-db', 'query', { sql: 'SELECT 1' })
    await Promise.resolve()
    assert.equal(remote.listApprovals().length, 1)
    mock.timers.tick(remote.APPROVAL_TIMEOUT_MS + 1)
    await assert.rejects(p, /within 3 minutes/)
  } finally {
    mock.timers.reset()
  }
  assert.equal(store.connectorState('shop-db').status, 'pending', 'a timeout decides nothing')
})

test('nothing approves from a tool call or the board', async () => {
  const names = [...connectors.connectionTools(shopAgent), ...remote.remoteTools(shopAgent)].map((t) => t.name)
  assert.deepEqual(names.sort(), ['call', 'call_more', 'describe_connection', 'list_connections', 'list_systems', 'run_on'])
  // call_more (#104) only reads results Corvid already holds; an unknown id is refused and approves nothing
  for (const t of connectors.connectionTools(shopAgent).filter((t) => t.readOnly && t.name !== 'call_more')) await t.run({ name: 'shop-db' })
  assert.throws(() => connectors.connectionTools(shopAgent).find((t) => t.name === 'call_more').run({ result_id: 'shop-db', page: 1 }), /There is no result/)
  assert.equal(store.connectorState('shop-db').status, 'pending')
  // the board module does not reach the approval queue at all
  const board = readFileSync(join(import.meta.dirname, '..', 'src', 'main', 'boardTools.ts'), 'utf8')
  const imports = board.match(/^import .*$/gm).join(' ')
  assert.ok(!/remote|connectors/.test(imports) && !/(decide|recordDecision|askUser)\(/.test(board), 'boardTools has no path to approvals')
})

test('safety levels on a real call: approve-writes runs reads, asks for writes; strict asks for everything', async () => {
  ran.length = 0
  const read = await connectors.call(shopAgent, 'fake-box', 'run', { command: 'ls /srv' })
  assert.match(read, /ran: ls \/srv/)
  assert.equal(remote.listApprovals().length, 0)
  const write = connectors.call(shopAgent, 'fake-box', 'run', { command: 'rm -rf /srv/cache' })
  const a = await answerNext(false)
  assert.equal(a.command, 'rm -rf /srv/cache', 'the dialog shows exactly what will run')
  await assert.rejects(write, /declined this call/)
  const admin = connectors.call(shopAgent, 'fake-box', 'run_as_root', { command: 'systemctl restart nginx' })
  const ad = await answerNext(true)
  assert.ok(ad.warn)
  assert.match(await admin, /ran: sudo -n sh -c 'systemctl restart nginx'/)
  assert.deepEqual(ran, ['ls /srv', "sudo -n sh -c 'systemctl restart nginx'"], 'the declined write never reached the server')
})

test('kill switch: every call refused, then restored; a single connector can be switched off', async () => {
  connectors.switchOffAll(true)
  await assert.rejects(connectors.call(shopAgent, 'fake-box', 'run', { command: 'ls' }), /switched off/)
  await assert.rejects(remote.runOn(shopAgent, 'fake-box', 'ls'), /switched off/)
  connectors.switchOffAll(false)
  assert.match(await connectors.call(shopAgent, 'fake-box', 'run', { command: 'ls' }), /ran: ls/)
  connectors.switchOffConnector('ssh', true)
  await assert.rejects(remote.runOn(shopAgent, 'fake-box', 'ls'), /switched off/)
  connectors.switchOffConnector('ssh', false)
  assert.match(await remote.runOn(shopAgent, 'fake-box', 'ls'), /ran: ls/)
  // persisted
  assert.equal(JSON.parse(readFileSync(join(data, 'connectors', 'state.json'), 'utf8')).killSwitch.all, false)
})

test('secrets never appear in tool output, logs, audit, errors, approvals or exports, in any encoding', async () => {
  const outputs = []
  outputs.push(await connectors.call(shopAgent, 'fake-box', 'run', { command: `echo ${SECRET}` }))
  outputs.push(await remote.runOn(shopAgent, 'fake-box', `cat /etc/app.conf`))
  for (const t of connectors.connectionTools(shopAgent).filter((t) => t.readOnly && t.name !== 'call_more')) outputs.push(JSON.stringify(await t.run({ name: 'fake-box' })))
  try {
    await connectors.call(shopAgent, 'fake-box', 'nope', {})
  } catch (e) {
    outputs.push(e.message)
  }
  outputs.push(store.exportConnections(), JSON.stringify(store.connectionsState()), JSON.stringify(requests))
  const files = []
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (!/secrets\.json$/.test(n.name)) files.push([p, readFileSync(p, 'utf8')])
    }
  }
  walk(data)
  for (const value of [SECRET, PASS2, SECRET + '-api']) {
    const forms = policy.secretVariants(value)
    for (const text of outputs) for (const f of forms) assert.ok(!text.includes(f), `found a form of a secret in tool output: ${text.slice(0, 200)}`)
    for (const [p, text] of files) for (const f of forms) assert.ok(!text.includes(f), `found a form of a secret in ${p}`)
  }
  assert.match(outputs[0], /\[redacted\]/)
  // the encrypted store holds no plain value either
  assert.ok(!readFileSync(join(data, 'connections', 'secrets.json'), 'utf8').includes(SECRET))
  const audit = store.readCallAudit()
  assert.ok(audit.length >= 5)
  assert.ok(audit.every((e) => e.agent && e.connection && e.operation && e.class && e.decision && e.request !== undefined))
  assert.ok(audit.some((e) => e.decision === 'denied') && audit.some((e) => e.decision === 'timed out') && audit.some((e) => e.decision === 'refused'))
})
