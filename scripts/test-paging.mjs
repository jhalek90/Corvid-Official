// Tests for #104, paged connector results: a long call() result comes back one page at a time, the rest is held in
// memory for the agent and project that made the call, and call_more reads it on without sending the request again.
// Pages break between JSON items, rows and lines; select and limit cut a JSON response down on Corvid's side. Only a
// local fake server, a throwaway SQLite file and made-up credentials; name resolution is a fake table. Runs on Node
// 24's own TypeScript support with a stand-in for electron, like test-http.mjs.
//
//   npm run test-paging

import { register } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-paging-'))
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

// a made-up credential for the planted-secret search (secret-scan: allow)
const TOKEN = 'Fake-Paging-Token-60417-zz' // secret-scan: allow

// ---------- data ----------

const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua quia et suscipit recusandae'.split(' ')
let seed = 7
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const sentence = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ')
// shaped like JSONPlaceholder's /posts: 100 posts, a short title, a body of four lines
const POSTS = Array.from({ length: 100 }, (_, i) => ({ userId: Math.floor(i / 10) + 1, id: i + 1, title: sentence(6), body: [sentence(7), sentence(7), sentence(7), sentence(6)].join('\n') }))
const items = (n, size) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `item ${i + 1} ✨`, text: sentence(Math.ceil(size / 6)).slice(0, size) }))
const ITEMS_500K = items(2000, 230)
const ITEMS_5M = items(20000, 230)
const TEXT = Array.from({ length: 1500 }, (_, i) => `line ${i + 1}: ${sentence(8)}`).join('\n')
const SECRETS = items(300, 200)
SECRETS.push({ id: 301, note: `leaked ${TOKEN} and ${Buffer.from(TOKEN).toString('base64')} and ${encodeURIComponent(TOKEN)}` })
const BIG_ITEM = [{ id: 1, small: true }, { id: 2, blob: 'z'.repeat(50_000) }, { id: 3, small: true }]
const WIDE = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`field_${i}`, sentence(5)]))

// ---------- the fake API ----------

const hits = new Map()
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  hits.set(u.pathname, (hits.get(u.pathname) ?? 0) + 1)
  const json = (o, pretty) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(pretty ? JSON.stringify(o, null, 2) : JSON.stringify(o))
  }
  const routes = {
    '/posts': () => json(POSTS, true),
    '/items500k': () => json(ITEMS_500K),
    '/items5m': () => json(ITEMS_5M),
    '/secrets': () => json(SECRETS),
    '/bigitem': () => json(BIG_ITEM),
    '/wide': () => json(WIDE),
    '/text': () => res.writeHead(200, { 'content-type': 'text/plain' }).end(TEXT),
    '/oneline': () => res.writeHead(200, { 'content-type': 'text/plain' }).end('q'.repeat(45_000))
  }
  ;(routes[u.pathname] ?? (() => res.writeHead(404).end()))()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const hitsOf = (p) => hits.get(p) ?? 0

after(() => {
  server.close()
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    /* Windows may still hold the SQLite file for a moment */
  }
})

// ---------- Corvid's modules ----------

const remote = await import('../src/main/remote/index.ts')
const store = await import('../src/main/connectors/store.ts')
const connectors = await import('../src/main/connectors/index.ts')
const pages = await import('../src/main/connectors/pages.ts')
const httpRt = await import('../src/main/connectors/http.ts')
const { validateManifest } = await import('../src/main/connectors/manifest.ts')
const { DatabaseSync } = await import('node:sqlite')

httpRt.httpDeps.lookup = async (host) => {
  if (host !== 'fake-api.test') throw new Error('ENOTFOUND')
  return [{ address: '127.0.0.1', family: 4 }]
}

const proj = join(tmp, 'projects', 'shop')
const other = join(tmp, 'projects', 'blog')
const projectIdForPath = (p) => (p.toLowerCase() === proj.toLowerCase() ? 'p1' : p.toLowerCase() === other.toLowerCase() ? 'p2' : undefined)
let pageSize
remote.initRemote({ changed: () => {}, approvalRequested: () => {} })

const BIG = {
  manifestVersion: 1,
  id: 'fake-big',
  name: 'Fake big API',
  version: '1.0.0',
  description: 'A made-up API on a local fake server that returns long results.',
  runtime: 'http',
  config: [{ key: 'local', label: 'Local', type: 'boolean', default: true }],
  secrets: [{ key: 'token', label: 'Token', type: 'token' }],
  capabilities: {
    targets: [{ host: 'fake-api.test', ports: [port], scheme: 'http' }],
    operations: [{ name: 'get', description: 'Any GET', class: 'read', method: 'GET' }]
  },
  limits: { timeoutMs: 20_000, maxResponseBytes: 8 * 1024 * 1024, ratePerMinute: 100 }
}
assert.ok(validateManifest(BIG).ok, JSON.stringify(validateManifest(BIG).errors))
const { mkdirSync } = await import('node:fs')
mkdirSync(join(globalThis.__userData, 'connectors'), { recursive: true })
writeFileSync(join(globalThis.__userData, 'connectors', 'fake-big.json'), JSON.stringify(BIG))
store.initConnectorStore({ projectIdForPath, remoteSystems: () => [], remoteSecret: () => undefined })
connectors.initConnectors({ projectIdForPath, changed: () => {}, pageChars: () => pageSize })

const agent = { project: proj, agent: 'worker #104' }
const outputs = []
const call = async (conn, op, args, want, who = agent) => {
  const r = await connectors.call(who, conn, op, args, want)
  outputs.push(JSON.stringify(r))
  return r
}
const more = (id, page, who = agent) => {
  const r = connectors.callMore(who, id, page)
  outputs.push(JSON.stringify(r))
  return r
}
const make = (name, connectorId, config, slots = {}, safety = 'free', projectIds = ['p1']) => {
  const c = store.saveConnection({ connectorId, name, config, safety, projectIds })
  for (const [k, v] of Object.entries(slots)) store.setSecret(c.id, k, v)
  return c
}
const approve = (id) => store.recordDecision(id, store.getManifest(id).hash, true, 'test')

approve('fake-big')
approve('sqlite')
const bigConn = make('big', 'fake-big', {}, { token: TOKEN })

/** Reads every page of a paged answer; returns the page texts, the footers and the id. */
function readAll(first, who = agent) {
  assert.ok(first.textParts, 'the answer is paged')
  const texts = [first.textParts[0]]
  const footers = [first.textParts[1]]
  const m = /^\[Page 1 of (\d+) \(([\d,]+) bytes in total\)/.exec(footers[0])
  assert.ok(m, footers[0])
  const n = Number(m[1])
  const id = /result_id: "(r[0-9a-f]{10})"/.exec(footers[0])?.[1]
  assert.ok(id, 'the footer names the result id')
  for (let p = 2; p <= n; p++) {
    const r = more(id, p, who)
    texts.push(r.textParts[0])
    footers.push(r.textParts[1])
  }
  assert.match(footers.at(-1), /This is the last page/)
  for (const t of texts) assert.ok(t.length <= pages.pageChars(pageSize), `a page is at most the page size (${t.length})`)
  // what mcp.ts sends: each block under its 24,000-character cap, so nothing is cut with "[truncated]"
  for (let i = 0; i < texts.length; i++) assert.ok(texts[i].length + footers[i].length < 24_000)
  return { texts, footers, id, n, totalBytes: Number(m[2].replace(/,/g, '')) }
}

/** Joins the pages of a body that is a JSON array: page 1 is the result, the rest arrays of items. */
const joinItems = (texts, at = (r) => r.body) => [...at(JSON.parse(texts[0])), ...texts.slice(1).flatMap((t) => JSON.parse(t))]

// ---------- the cause, and the #94 case ----------

test('the cause: mcp.ts cuts a tool answer at 24,000 characters, which is where the posts ended', () => {
  const mcp = readFileSync(join(import.meta.dirname, '..', 'src', 'main', 'mcp.ts'), 'utf8')
  assert.match(mcp, /const MAX_RESULT = 24_000/)
  // the old path: the whole http result as compact JSON, cut at 24,000 with " …[truncated]"
  const result = { status: 200, ok: true, url: '/posts', headers: { 'content-type': 'application/json; charset=utf-8' }, body: POSTS }
  const s = JSON.stringify(result)
  const pretty = JSON.stringify(POSTS, null, 2)
  const cut = s.slice(0, 24_000)
  const whole = (cut.match(/"userId":/g) ?? []).length - 1
  console.log(`[#104] fake /posts: ${Buffer.byteLength(pretty)} bytes as served, ${s.length} characters as one compact result; a 24,000 cut keeps ${whole} whole posts and part of post ${whole + 1}`)
  assert.ok(s.length > 24_000 && whole >= 90 && whole < 100)
})

test('#94 again: GET /posts with 100 items, all 100 reachable, in whole items', async () => {
  pageSize = undefined
  const before = hitsOf('/posts')
  const first = await call('big', 'get', { path: '/posts' })
  const all = readAll(first)
  assert.equal(all.n, 2)
  assert.match(all.footers[0], /items 1-\d+ of 100 in body/)
  assert.match(all.footers[0], /select and limit/)
  assert.deepEqual(joinItems(all.texts), POSTS)
  assert.equal(JSON.parse(all.texts[0]).status, 200, 'page 1 is the result itself, valid JSON')
  assert.equal(hitsOf('/posts') - before, 1, 'paging sent nothing more')
})

test('27 KB, 500 KB and 5 MB: first page, footer, call_more to the end, the same items, nothing cut mid-item', async () => {
  for (const [path, data] of [['/posts', POSTS], ['/items500k', ITEMS_500K], ['/items5m', ITEMS_5M]]) {
    const before = hitsOf(path)
    const first = await call('big', 'get', { path })
    const all = readAll(first)
    assert.deepEqual(joinItems(all.texts), data, path)
    for (const t of all.texts.slice(1)) assert.ok(Array.isArray(JSON.parse(t)), 'each later page is a valid JSON array')
    assert.ok(all.totalBytes >= Buffer.byteLength(JSON.stringify(data)))
    assert.equal(hitsOf(path) - before, 1, `${path}: one request, however many pages`)
    console.log(`[#104] ${path}: ${all.totalBytes} bytes in ${all.n} pages`)
  }
})

test('paging makes no new requests, so it does not count against the rate limit', async () => {
  // 100 calls a minute; the 5 MB result alone took over 250 call_more reads, and new calls still run
  await call('big', 'get', { path: '/bigitem' })
})

test('plain text is split between lines; a line longer than a page, mid-line; joining gives the text back', async () => {
  const t = readAll(await call('big', 'get', { path: '/text' }))
  const body = JSON.parse(t.texts[0]).body
  assert.equal(body + t.texts.slice(1).join(''), TEXT)
  for (const p of t.texts.slice(1, -1)) assert.ok(p.endsWith('\n'), 'pages end at a line break')
  assert.match(t.footers[0], /plain text, split between lines/)
  const o = readAll(await call('big', 'get', { path: '/oneline' }))
  assert.equal(JSON.parse(o.texts[0]).body + o.texts.slice(1).join(''), 'q'.repeat(45_000))
})

test('an item larger than a page is the only thing split mid-item, and says so', async () => {
  const r = readAll(await call('big', 'get', { path: '/bigitem' }))
  assert.ok(r.footers.some((f) => /item 2 of 3 in body, part 1 of \d \(larger than a page/.test(f)))
  const page1 = JSON.parse(r.texts[0]).body
  assert.deepEqual(page1, [BIG_ITEM[0]])
  const partsEnd = r.texts.length - 1
  assert.deepEqual(JSON.parse(r.texts.slice(1, partsEnd).join('')), BIG_ITEM[1])
  assert.deepEqual(JSON.parse(r.texts[partsEnd]), [BIG_ITEM[2]])
})

test('an object with no large array is paged as indented JSON by lines', async () => {
  const r = readAll(await call('big', 'get', { path: '/wide' }))
  assert.deepEqual(JSON.parse(r.texts.join('')).body, WIDE)
  assert.match(r.footers[0], /indented JSON, split between lines/)
})

test('the page size is a setting, kept in range', async () => {
  pageSize = 5000
  const r = readAll(await call('big', 'get', { path: '/posts' }))
  assert.ok(r.n >= 5)
  assert.deepEqual(joinItems(r.texts), POSTS)
  pageSize = 999_999
  assert.equal(pages.pageChars(pageSize), 22_000)
  assert.equal(pages.pageChars(10), 4000)
  assert.equal(pages.pageChars(undefined), 20_000)
  pageSize = undefined
})

test('a database result is paged between rows, with the columns on page 1', async () => {
  const file = join(tmp, 'rows.db')
  const d = new DatabaseSync(file)
  d.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, level TEXT, message TEXT)')
  const ins = d.prepare('INSERT INTO logs (level, message) VALUES (?, ?)')
  d.exec('BEGIN')
  for (let i = 0; i < 3000; i++) ins.run(i % 7 ? 'info' : 'warn', `event ${i}: ${sentence(6)}`)
  d.exec('COMMIT')
  d.close()
  make('rows', 'sqlite', { path: file, max_rows: 5000 })
  const r = readAll(await call('rows', 'query', { sql: 'SELECT * FROM logs ORDER BY id' }))
  const p1 = JSON.parse(r.texts[0])
  assert.deepEqual(p1.columns, ['id', 'level', 'message'])
  const rows = joinItems(r.texts, (x) => x.rows)
  assert.equal(rows.length, 3000)
  assert.deepEqual(rows.map((x) => x[0]), Array.from({ length: 3000 }, (_, i) => i + 1))
  assert.match(r.footers[0], /items 1-\d+ of 3000 in rows/)
  await assert.rejects(call('rows', 'query', { sql: 'SELECT 1' }, { select: '[*]' }), /for a database, name the columns and add a LIMIT/)
})

test('over MCP: the page and its footer arrive as two text blocks, neither cut with [truncated]', async () => {
  const { startMcp } = await import('../src/main/mcp.ts')
  const tools = connectors.connectionTools(agent)
  const ep = await startMcp(tools)
  try {
    const rpc = async (method, params) => {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      })
      const text = await res.text()
      return JSON.parse(text.startsWith('{') ? text : /^data: (.*)$/m.exec(text)[1]).result
    }
    const r = await rpc('tools/call', { name: 'call', arguments: { connection: 'big', operation: 'get', args: { path: '/posts' } } })
    assert.equal(r.content.length, 2)
    assert.ok(!r.content.some((c) => c.text.includes('[truncated]')))
    const id = /result_id: "(r[0-9a-f]+)"/.exec(r.content[1].text)[1]
    const r2 = await rpc('tools/call', { name: 'call_more', arguments: { result_id: id, page: 2 } })
    assert.deepEqual([...JSON.parse(r.content[0].text).body, ...JSON.parse(r2.content[0].text)], POSTS)
    const titles = await rpc('tools/call', { name: 'call', arguments: { connection: 'big', operation: 'get', args: { path: '/posts' }, select: '[*].title', limit: 3 } })
    assert.deepEqual(JSON.parse(titles.content[0].text).body, POSTS.slice(0, 3).map((p) => p.title))
  } finally {
    ep.server.close()
  }
})

// ---------- who can read, and for how long ----------

test('another agent, another project, a wrong id: refused; the audit records the refusal', async () => {
  const r = await call('big', 'get', { path: '/posts' })
  const id = /result_id: "(r[0-9a-f]+)"/.exec(r.textParts[1])[1]
  assert.throws(() => more(id, 2, { project: proj, agent: 'worker #7' }), /not made by you in this project/)
  assert.throws(() => more(id, 2, { project: other, agent: 'worker #104' }), /not made by you in this project/)
  assert.throws(() => more('rdeadbeef00', 2), /There is no result rdeadbeef00/)
  assert.throws(() => more(id, 9), /has pages 1 to 2/)
  assert.ok(more(id, 2).textParts[0].length > 0, 'the owner still reads it')
  const refused = store.readCallAudit(50).filter((e) => e.resultId === id && e.decision === 'refused')
  assert.equal(refused.length, 2)
})

test('expiry: an id is gone after its time, and the agent hears that it expired', async () => {
  const keep = pages.HOLD.idleMs
  pages.HOLD.idleMs = 40
  try {
    const r = await call('big', 'get', { path: '/posts' })
    const id = /result_id: "(r[0-9a-f]+)"/.exec(r.textParts[1])[1]
    await new Promise((res) => setTimeout(res, 80))
    assert.throws(() => more(id, 2), /is no longer held: it expired/)
  } finally {
    pages.HOLD.idleMs = keep
  }
})

test('the cap on held results drops the oldest first and says why', async () => {
  const keep = pages.HOLD.perOwner
  pages.HOLD.perOwner = 2
  try {
    const ids = []
    for (let i = 0; i < 3; i++) ids.push(/result_id: "(r[0-9a-f]+)"/.exec((await call('big', 'get', { path: '/posts' })).textParts[1])[1])
    assert.throws(() => more(ids[0], 2), /dropped to make room/)
    assert.ok(more(ids[2], 2))
    assert.ok(pages.heldStats().results <= pages.HOLD.maxResults)
  } finally {
    pages.HOLD.perOwner = keep
  }
  const keepChars = pages.HOLD.maxChars
  pages.HOLD.maxChars = 10_000
  try {
    const r = await call('big', 'get', { path: '/posts' })
    assert.match(r.textParts[1], /too large for Corvid to hold/)
  } finally {
    pages.HOLD.maxChars = keepChars
  }
})

test('the kill switch mid-paging drops held results; a changed connection drops its own', async () => {
  const r = await call('big', 'get', { path: '/items500k' })
  const id = /result_id: "(r[0-9a-f]+)"/.exec(r.textParts[1])[1]
  more(id, 2)
  connectors.switchOffAll(true)
  assert.throws(() => more(id, 3), /no longer held: connectors were switched off/)
  connectors.switchOffAll(false)
  assert.throws(() => more(id, 3), /no longer held/)
  const r2 = await call('big', 'get', { path: '/posts' })
  const id2 = /result_id: "(r[0-9a-f]+)"/.exec(r2.textParts[1])[1]
  connectors.switchOffConnector('fake-big', true)
  assert.throws(() => more(id2, 2), /its connector was switched off/)
  connectors.switchOffConnector('fake-big', false)
  const r3 = await call('big', 'get', { path: '/posts' })
  const id3 = /result_id: "(r[0-9a-f]+)"/.exec(r3.textParts[1])[1]
  await new Promise((res) => setTimeout(res, 5))
  store.saveConnection({ id: bigConn.id, connectorId: 'fake-big', name: 'big', config: {}, safety: 'strict', projectIds: ['p1'] })
  assert.throws(() => more(id3, 2), /was changed after the call/)
  store.saveConnection({ id: bigConn.id, connectorId: 'fake-big', name: 'big', config: {}, safety: 'free', projectIds: ['p1'] })
  const r4 = await call('big', 'get', { path: '/posts' })
  connectors.dropResultsOf('worker #104')
  assert.throws(() => more(/result_id: "(r[0-9a-f]+)"/.exec(r4.textParts[1])[1], 2), /the agent that made the call ended/)
})

// ---------- scrubbing and audit ----------

test('a planted secret on the last page is scrubbed, in every encoding', async () => {
  const r = readAll(await call('big', 'get', { path: '/secrets' }))
  const last = r.texts.at(-1)
  assert.match(last, /leaked \[redacted\] and \[redacted\] and \[redacted\]/)
  const all = r.texts.join('')
  for (const v of [TOKEN, Buffer.from(TOKEN).toString('base64'), encodeURIComponent(TOKEN)]) assert.ok(!all.includes(v))
})

test('the audit shows pages and byte counts, never the content', () => {
  const log = store.readCallAudit(2000)
  const paged = log.filter((e) => e.page !== undefined)
  assert.ok(paged.length > 100)
  const firstPages = paged.filter((e) => e.page === 1)
  assert.ok(firstPages.every((e) => e.pages > 1 && e.returnedBytes > 0 && e.resultBytes > e.returnedBytes && /page 1 of/.test(e.detail)))
  const reads = paged.filter((e) => e.page > 1)
  assert.ok(reads.every((e) => /call_more: page \d+ of \d+, from the held result \(nothing sent\)/.test(e.detail) && e.returnedBytes > 0 && /^(GET |\[read\] SELECT)/.test(e.request)))
  const text = JSON.stringify(log)
  for (const s of [POSTS[50].title, ITEMS_500K[1500].text, 'line 900:', TOKEN]) assert.ok(!text.includes(s), `the audit holds no content (${s.slice(0, 20)})`)
})

// ---------- select and limit ----------

test('select and limit: done by Corvid, so less reaches the agent', async () => {
  const titles = await call('big', 'get', { path: '/posts' }, { select: '[*].title', limit: 20 })
  assert.deepEqual(titles.body, POSTS.slice(0, 20).map((p) => p.title))
  assert.match(titles.notes.join(' '), /Kept the first 20 of 100 items/)
  const two = await call('big', 'get', { path: '/posts' }, { select: '$[*]{id,title}' })
  assert.deepEqual(two.body, POSTS.map(({ id, title }) => ({ id, title })))
  assert.equal(two.textParts, undefined, 'small enough for one page')
  assert.deepEqual((await call('big', 'get', { path: '/posts' }, { select: '[-1].id' })).body, 100)
  assert.equal((await call('big', 'get', { path: '/items5m' }, { limit: 3 })).body.length, 3)
  const deep = pages.narrow({ data: { items: [{ a: 1, 'odd key': { x: 2 } }] } }, 'data.items[0]."odd key".x', undefined)
  assert.equal(deep.value, 2)
})

test('select: invalid paths are refused before anything is sent; paths that match nothing say why', async () => {
  const before = hitsOf('/posts')
  for (const bad of ['posts[*', '[*].', 'a..b', '{id}.x', '[abc]', '', 'x'.repeat(301), 'constructor()', '[*]{}']) {
    await assert.rejects(call('big', 'get', { path: '/posts' }, { select: bad }), /select/, JSON.stringify(bad))
  }
  await assert.rejects(call('big', 'get', { path: '/posts' }, { limit: 0 }), /limit must be a whole number/)
  await assert.rejects(call('big', 'get', { path: '/posts' }, { limit: 2.5 }), /limit must be a whole number/)
  assert.equal(hitsOf('/posts'), before, 'nothing was sent for a bad select or limit')
  await assert.rejects(call('big', 'get', { path: '/posts' }, { select: 'posts[*].title' }), /matches nothing: the body is an array of 100 items, so "posts" matches nothing/)
  await assert.rejects(call('big', 'get', { path: '/posts' }, { select: '[0].nope' }), /\[0\] is an object with fields userId, id, title, body/)
  await assert.rejects(call('big', 'get', { path: '/posts' }, { select: '__proto__' }), /matches nothing/)
  await assert.rejects(call('big', 'get', { path: '/text' }, { select: 'x' }), /select needs a JSON response/)
})

test('no planted credential in anything the agent saw, the audit or the data folder; nothing held is on disk', () => {
  const seen = outputs.join('\n')
  for (const v of [TOKEN, Buffer.from(TOKEN).toString('base64'), encodeURIComponent(TOKEN)]) assert.ok(!seen.includes(v))
  const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]))
  const disk = files(globalThis.__userData).map((f) => readFileSync(f).toString('latin1')).join('\n')
  for (const s of [TOKEN, POSTS[42].title, ITEMS_5M[19000].text, 'line 1200:']) assert.ok(!disk.includes(s), `not on disk: ${s.slice(0, 20)}`)
})
