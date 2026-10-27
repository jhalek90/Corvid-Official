// Tests for #90, the database connectors: the SQL classifier for each dialect (a large table), the constructs
// refused at every level, read-only enforcement at the database, limits, column masking, safety levels, the kill
// switch, project scoping, approval text and the leak search for a planted password. SQLite runs live on throwaway
// files; PostgreSQL runs live on PGlite (Postgres in WebAssembly, in a temp folder) when PG_LIVE points at its
// socket server, otherwise against a fake wire-protocol server; MySQL and SQL Server against fake servers and a fake
// driver that echoes the password. Made-up credentials only. Runs on Node 24's TypeScript support like test-http.mjs.
//
//   npm run test-db

import { register } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-db-'))
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


// Driver requires in db.ts are plain require() calls (the main bundle is CommonJS); give the ESM test run one.
globalThis.require = createRequire(join(import.meta.dirname, '..', 'package.json'))

// a made-up password for the leak search (secret-scan: allow)
const PASS = 'Fake-Db-Pass-60417-zz' // secret-scan: allow
const PLANTED = [PASS]

const remote = await import('../src/main/remote/index.ts')
const store = await import('../src/main/connectors/store.ts')
const connectors = await import('../src/main/connectors/index.ts')
const db = await import('../src/main/connectors/db.ts')
const rules = await import('../src/main/connectors/sqlRules.ts')
const policy = await import('../src/main/connectors/policy.ts')
const { DB_CONNECTORS } = await import('../src/main/connectors/builtin.ts')
const { validateManifest, capabilitySummary } = await import('../src/main/connectors/manifest.ts')
const { DatabaseSync } = await import('node:sqlite')
const PG = DB_CONNECTORS.find((m) => m.id === 'postgres')
const LITE = DB_CONNECTORS.find((m) => m.id === 'sqlite')

const servers = []
after(() => {
  for (const s of servers) s.close()
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    /* Windows may still hold a SQLite file for a moment; the temp folder is cleaned up later */
  }
})

const proj = join(tmp, 'projects', 'shop')
const other = join(tmp, 'projects', 'blog')
const projectIdForPath = (p) => (p.toLowerCase() === proj.toLowerCase() ? 'p1' : p.toLowerCase() === other.toLowerCase() ? 'p2' : undefined)
const requests = []
remote.initRemote({ changed: () => {}, approvalRequested: (a) => requests.push(a) })
store.initConnectorStore({ projectIdForPath, remoteSystems: () => [], remoteSecret: () => undefined })
connectors.initConnectors({ projectIdForPath, changed: () => {} })
const agent = { project: proj, agent: 'worker #90' }

const outputs = []
const logged = []
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k]
  console[k] = (...a) => {
    logged.push(a.map(String).join(' '))
    orig(...a)
  }
}
const call = async (conn, op, args, who = agent) => {
  try {
    const r = await connectors.call(who, conn, op, args)
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
const make = (name, connectorId, config, slots = {}, safety = 'free') => {
  const c = store.saveConnection({ connectorId, name, config, safety, projectIds: ['p1'] })
  for (const [k, v] of Object.entries(slots)) store.setSecret(c.id, k, v)
  return c
}
const approved = new Set()
/** The first call on each connector asks for first-use approval; this answers it. */
const firstUse = async (connectorId, conn, op, args) => {
  if (approved.has(connectorId)) return call(conn, op, args)
  approved.add(connectorId)
  const p = call(conn, op, args)
  await answerNext(true)
  return p
}

// ---------- the classifier ----------

const R = 'read', W = 'write', A = 'admin', X = 'refused'
const TABLE = {
  all: [
    ['SELECT 1', R],
    ['select * from users where id = 3', R],
    ['  SeLeCt name FROM users  ', R],
    ['SELECT 1; SELECT 2', R],
    ["SELECT 'DELETE FROM users'", R],
    ["SELECT 1 -- ; DROP TABLE users", R],
    ['SELECT 1 /* DROP TABLE users */', R],
    ['SELECT 1; DELETE FROM users', W],
    ['SELECT 1;DROP TABLE users', A],
    ['select 1; /* hi */ drop table users', A],
    ['DeLeTe FROM users', W],
    ['INSERT INTO t VALUES (1)', W],
    ['UPDATE t SET a = 1', W],
    ['WITH x AS (SELECT 1) SELECT * FROM x', R],
    ['WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone', W],
    ['WITH x AS (UPDATE t SET a = 1 RETURNING a) SELECT * FROM x', W],
    ['EXPLAIN SELECT * FROM t', R],
    ['EXPLAIN ANALYZE SELECT * FROM t', R],
    ['EXPLAIN ANALYZE DELETE FROM t', W],
    ['EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 2', W],
    ['SELECT * INTO backup_users FROM users', A],
    ['SELECT * FROM t FOR UPDATE', W],
    ['CREATE TABLE t (a int)', A],
    ['create index i on t(a)', A],
    ['ALTER TABLE t ADD COLUMN b int', A],
    ['DROP TABLE t', A],
    ['TRUNCATE t', A],
    ['GRANT SELECT ON t TO bob', A],
    ['REVOKE ALL ON t FROM bob', A],
    ['CALL do_things()', A],
    ['BEGIN', A],
    ['COMMIT', A],
    ['SELECT 1; COMMIT; DELETE FROM t', A],
    ['SET search_path = evil', A],
    ['FROBNICATE t', A],
    ['SELECT name, comment FROM posts', R],
    ['SELECT CASE WHEN a THEN 1 END FROM t', R],
    ["SELECT REPLACE(name, 'a', 'b') FROM t", R],
    ['', X],
    ["SELECT 'unterminated", X]
  ],
  postgres: [
    ['SELECT "delete" FROM t', R],
    ['SELECT $1::int', R],
    ['SELECT $$ DROP TABLE t $$', R],
    ['SELECT $tag$ ; DELETE FROM t; $tag$', R],
    ["SELECT E'\\' ; DELETE FROM t; --'", R],
    ["SELECT 'a\\'; DELETE FROM t; --'", W],
    ['SELECT 1 /* nested /* comment */ DROP TABLE t */', R],
    ['VALUES (1), (2)', R],
    ['TABLE users', R],
    ['SHOW search_path', R],
    ["SELECT nextval('s')", W],
    ["SELECT setval('s', 10)", W],
    ['SELECT pg_advisory_lock(1)', W],
    ['SELECT * FROM t FOR NO KEY UPDATE', W],
    ['INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING', W],
    ['INSERT INTO t VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2', W],
    ['DO $$ BEGIN DELETE FROM t; END $$', A],
    ['VACUUM t', A],
    ['LISTEN chan', A],
    ['SELECT pg_terminate_backend(123)', A],
    ["COPY t TO '/tmp/x'", X],
    ["copy (select 1) to program 'calc.exe'", X],
    ["SELECT pg_read_file('/etc/passwd')", X],
    ['SELECT PG_READ_FILE($1)', X],
    ["SELECT lo_import('/etc/passwd')", X],
    ["SELECT * FROM dblink('host=evil', 'select 1') AS t(a int)", X],
    ["SELECT set_config('transaction_read_only', 'off', false)", X],
    ['CREATE EXTENSION dblink', X],
    ["CREATE FUNCTION f() RETURNS int LANGUAGE c AS 'evil.so'", X],
    ["ALTER SYSTEM SET log_directory = '/tmp'", X],
    ['CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw', X],
    ['GRANT pg_execute_server_program TO bob', X],
    ['SELECT 1 /* unclosed', X]
  ],
  mysql: [
    ['SHOW TABLES', R],
    ['DESCRIBE users', R],
    ['SELECT `delete` FROM t', R],
    ['SELECT "DROP TABLE t"', R],
    ["SELECT 'it\\'s; DROP TABLE t'", R],
    ['SELECT 1 # ; DROP TABLE t', R],
    ['SELECT 1 #\n; DROP TABLE t', A],
    ['REPLACE INTO t VALUES (1)', W],
    ['INSERT INTO t SET a = 1', W],
    ['INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 2', W],
    ["SELECT GET_LOCK('x', 1)", W],
    ['SELECT * FROM t INTO @v', A],
    ['LOCK TABLES t WRITE', A],
    ['USE other_db', A],
    ['CALL proc()', A],
    ['PREPARE s FROM @q', A],
    ['SELECT 1 /*! ; DROP TABLE t */', X],
    ['SELECT /*+ MAX_EXECUTION_TIME(1) */ 1', X],
    ["SELECT LOAD_FILE('/etc/passwd')", X],
    ["SELECT * FROM t INTO OUTFILE '/tmp/x'", X],
    ["SELECT 1 INTO DUMPFILE '/tmp/x'", X],
    ["LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE t", X],
    ["INSTALL PLUGIN x SONAME 'x.so'", X],
    ['SET GLOBAL general_log = 1', X],
    ["CREATE TABLE f (a int) ENGINE=FEDERATED CONNECTION='mysql://x'", X]
  ],
  mssql: [
    ['SELECT "delete" FROM t', R],
    ['SELECT TOP 5 * FROM [users]', R],
    ['SELECT [delete] FROM t', R],
    ['SELECT 1 DELETE FROM t', W],
    ['SELECT 1 DROP TABLE t', A],
    ['SELECT 1 USE master', A],
    ['SELECT 1 KILL 52', A],
    ['EXEC sp_who', A],
    ["EXEC('DROP TABLE t')", A],
    ["EXECUTE sp_executesql N'SELECT 1'", A],
    ['MERGE t USING s ON t.a = s.a WHEN MATCHED THEN UPDATE SET a = 1;', W],
    ['SELECT * INTO #tmp FROM t', A],
    ['DECLARE @x int', A],
    ['BEGIN TRAN', A],
    ["EXEC xp_cmdshell 'whoami'", X],
    ["exec master..xp_dirtree '\\\\evil\\share'", X],
    ['EXEC sp_configure', X],
    ['RECONFIGURE', X],
    ["SELECT * FROM OPENROWSET('SQLNCLI', 'Server=evil;', 'SELECT 1')", X],
    ["SELECT * FROM OPENQUERY(evil, 'SELECT 1')", X],
    ["BULK INSERT t FROM 'c:\\x.csv'", X],
    ['SELECT * FROM evilserver.db.dbo.users', X],
    ['SELECT * FROM evilserver..dbo.users', X],
    ["EXEC sp_addlinkedserver 'evil'", X],
    ["DECLARE @o int; EXEC sp_OACreate 'WScript.Shell', @o OUT", X],
    ["BACKUP DATABASE d TO DISK = 'c:\\x.bak'", X]
  ],
  sqlite: [
    ['SELECT "delete" FROM t', R],
    ['PRAGMA table_info(users)', R],
    ["PRAGMA table_info('users')", R],
    ['PRAGMA journal_mode', R],
    ['PRAGMA journal_mode = DELETE', A],
    ['PRAGMA writable_schema = 1', A],
    ['SELECT [x] FROM t', R],
    ['SELECT `x` FROM t', R],
    ['INSERT OR REPLACE INTO t VALUES (1)', W],
    ["ATTACH DATABASE 'c:\\other.db' AS o", X],
    ["attach 'x.db' as y", X],
    ['DETACH o', X],
    ["SELECT load_extension('evil.dll')", X],
    ["VACUUM INTO 'c:\\copy.db'", X],
    ["SELECT readfile('c:\\secret.txt')", X]
  ]
}

test('the classifier: the table of statements for every dialect', () => {
  let n = 0
  const wrong = []
  for (const d of rules.DIALECTS) {
    for (const [sql, want] of [...TABLE.all, ...TABLE[d]]) {
      const p = rules.classifySql(sql, d)
      const got = p.refused ? X : p.cls
      n++
      if (got !== want) wrong.push(`${d}: ${JSON.stringify(sql)} -> ${got}${p.refused ? ` (${p.refused})` : ''}, expected ${want}`)
    }
  }
  assert.deepEqual(wrong, [])
  assert.ok(n > 250, `${n} cases`)
})

test('blocked constructs are refused for every operation and every safety level', () => {
  for (const access of ['read', 'read-write', 'admin'])
    for (const op of PG.capabilities.operations.filter((o) => ['query', 'execute', 'admin'].includes(o.name)))
      for (const sql of ["SELECT pg_read_file('x')", "COPY t FROM PROGRAM 'x'", 'SELECT 1; SELECT * FROM dblink(1)'])
        assert.throws(() => db.planDbCall(PG, { host: 'h', user: 'u', access }, op, { sql }), /Refused at every safety level/)
  assert.ok(rules.BLOCKED.length >= 60)
})

test('a statement classed above its operation, or above what the connection allows, is refused before anyone is asked', () => {
  const op = (n) => PG.capabilities.operations.find((o) => o.name === n)
  assert.throws(() => db.planDbCall(PG, { host: 'h', user: 'u' }, op('query'), { sql: 'DELETE FROM t' }), /use the execute operation/)
  assert.throws(() => db.planDbCall(PG, { host: 'h', user: 'u' }, op('execute'), { sql: 'DROP TABLE t' }), /use the admin operation/)
  assert.throws(() => db.planDbCall(PG, { host: 'h', user: 'u', access: 'read' }, op('execute'), { sql: 'DELETE FROM t' }), /only allows reads/)
  assert.throws(() => db.planDbCall(PG, { host: 'h', user: 'u' }, op('admin'), { sql: 'DROP TABLE t' }), /only allows reads and data changes/)
  assert.equal(db.planDbCall(PG, { host: 'h', user: 'u' }, op('execute'), { sql: 'SELECT 1' }).cls, 'read', 'a read through execute still runs read-only')
  assert.throws(() => db.planDbCall(PG, { host: 'h', user: 'u' }, op('query'), { sql: 'SELECT $1', params: [{ a: 1 }] }), /plain values/)
})

test('audit text masks secret-looking literals; the approval shows the exact statement and its class', () => {
  assert.ok(!rules.auditStatement(`CREATE USER bob WITH PASSWORD '${PASS}'`).includes(PASS))
  assert.match(rules.auditStatement("ALTER LOGIN x WITH PASSWORD = 'short-ish'"), /\[redacted\]/) // made up (secret-scan: allow)
  assert.match(rules.auditStatement("SELECT 'abcdefghijklmnopqrstuvwxyz0123'"), /\[redacted\]/)
  assert.equal(rules.auditStatement("SELECT 'hello world'"), "SELECT 'hello world'")
  assert.match(rules.auditStatement('SELECT ' + 'x'.repeat(5000)), /\.\.\.\[cut\]$/)
  const plan = db.planDbCall(PG, { host: 'h', user: 'u', access: 'admin' }, PG.capabilities.operations.find((o) => o.name === 'admin'), { sql: "CREATE USER bob WITH PASSWORD 'x-visible-1'" })
  assert.match(plan.shown, /^\[admin\] CREATE USER bob WITH PASSWORD 'x-visible-1'/)
  assert.ok(!plan.request.includes('x-visible-1'))
})

test('the built-in database connectors are valid manifests; settings, TLS defaults, limits and the summary', () => {
  for (const m of DB_CONNECTORS) {
    const v = validateManifest(m)
    assert.ok(v.ok, `${m.id}: ${JSON.stringify(v.errors)}`)
  }
  assert.equal(rules.dbSettings('postgres', { host: 'db.example.com', user: 'u' }, PG.limits).tls, 'verify', 'remote hosts verify TLS by default')
  assert.equal(rules.dbSettings('postgres', { host: 'localhost', user: 'u' }, PG.limits).tls, 'off')
  assert.match(rules.dbWarnings(rules.dbSettings('postgres', { host: 'db.example.com', tls: 'off' }, PG.limits))[0], /unencrypted/)
  assert.match(rules.dbWarnings(rules.dbSettings('postgres', { host: 'db.example.com', tls: 'no-verify' }, PG.limits))[0], /not checked/)
  assert.throws(() => rules.dbSettings('postgres', { host: 'postgres://u:p@h/db' }, PG.limits), /name or address only/)
  const s = rules.dbSettings('postgres', { host: 'h', max_rows: 99999, timeout_seconds: 9999, max_response_kb: 999999 }, PG.limits)
  assert.deepEqual([s.maxRows, s.timeoutMs, s.maxBytes], [rules.MAX_ROWS, PG.limits.timeoutMs, PG.limits.maxResponseBytes], 'a connection can only lower the limits')
  const sum = db.dbSummary(PG, { host: 'db.example.com', port: 5432, database: 'shop', user: 'agent', access: 'read-write' })
  assert.match(sum, /can read and change data in database shop on db\.example\.com:5432 as agent; can change the schema, users or grants: no/)
  assert.match(db.dbSummary(PG, { host: 'h', database: 'd', user: 'u', access: 'admin' }), /grants: yes/)
  assert.match(db.dbSummary(PG, { host: 'h', database: 'd', user: 'u', access: 'read' }), /can only read data/)
  assert.match(capabilitySummary(PG), /PostgreSQL/)
})

test('masking: matching columns are masked, others are not', () => {
  const s = { mask: rules.DEFAULT_MASK.split(',').map(rules.maskPattern), maxRows: 10, maxBytes: 1e6 }
  const r = rules.shapeResult(['id', 'name', 'password_hash', 'API_TOKEN', 'ssn', 'email'], [[1, 'ann', 'h1', 't1', '123', 'a@b.test']], 0, s)
  assert.deepEqual(r.rows[0], [1, 'ann', '[masked]', '[masked]', '[masked]', 'a@b.test'])
  assert.match(r.notes.join(' '), /Masked columns: password_hash, API_TOKEN, ssn\./)
})

// ---------- SQLite, live on throwaway files ----------

const file = join(tmp, 'shop.db')
{
  const d = new DatabaseSync(file)
  d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, password_hash TEXT, api_token TEXT)')
  d.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT)')
  const ins = d.prepare('INSERT INTO users (name, email, password_hash, api_token) VALUES (?, ?, ?, ?)')
  for (let i = 0; i < 1200; i++) ins.run(`user${i}`, `u${i}@example.test`, `hash-${i}`, `tok-${i}`)
  d.close()
}
const count = (sql) => {
  const d = new DatabaseSync(file, { readOnly: true })
  try {
    return d.prepare(sql).get().n
  } finally {
    d.close()
  }
}

test('SQLite: first use asks once; query, describe and sample_rows; columns masked; rows capped with a count', async () => {
  make('lite', 'sqlite', { path: file, max_rows: 100 })
  const r = await firstUse('sqlite', 'lite', 'query', { sql: 'SELECT * FROM users ORDER BY id' })
  assert.equal(r.class, 'read')
  assert.deepEqual(r.columns, ['id', 'name', 'email', 'password_hash', 'api_token'])
  assert.equal(r.rows_returned, 100)
  assert.equal(r.truncated, true)
  assert.match(r.notes[0], /Truncated: 1100 more rows not returned \(limit 100\)/)
  assert.deepEqual(r.rows[0], [1, 'user0', 'u0@example.test', '[masked]', '[masked]'])
  const t = await call('lite', 'describe', {})
  assert.deepEqual(t.rows.map((x) => x[0]), ['items', 'users'])
  const cols = await call('lite', 'describe', { table: 'users' })
  assert.ok(cols.rows.some((x) => x[0] === 'email'))
  const sample = await call('lite', 'sample_rows', { table: 'users', limit: 3 })
  assert.equal(sample.rows_returned, 3)
  await assert.rejects(call('lite', 'sample_rows', { table: 'users; DROP TABLE users' }), /does not accept/)
  const p = await call('lite', 'query', { sql: 'SELECT name FROM users WHERE id = ?', params: [5] })
  assert.deepEqual(p.rows, [['user4']])
})

test('SQLite: a misclassified write still fails in a read call (read-only open and query_only)', async () => {
  const s = rules.dbSettings('sqlite', { path: file }, LITE.limits)
  await assert.rejects(db.dbDeps.run.sqlite({ s, readOnly: true, statements: [{ text: 'DELETE FROM users', params: [] }], signal: new AbortController().signal }), /readonly|read-only|read only/i)
  assert.equal(count('SELECT count(*) AS n FROM users'), 1200)
})

test('SQLite: execute commits, admin asks even on Free, access read refuses changes, blocked constructs never run', async () => {
  const r = await call('lite', 'execute', { sql: "INSERT INTO items (title) VALUES ('a'); INSERT INTO items (title) VALUES ('b')" })
  assert.equal(r.rows_affected, 1)
  assert.equal(count('SELECT count(*) AS n FROM items'), 2)
  await assert.rejects(call('lite', 'execute', { sql: "INSERT INTO items (title) VALUES ('c'); INSERT INTO nope VALUES (1)" }), /no such table/)
  assert.equal(count('SELECT count(*) AS n FROM items'), 2, 'a failed call rolls back all its statements')
  await assert.rejects(call('lite', 'admin', { sql: 'CREATE TABLE t2 (a)' }), /only allows reads and data changes/)
  make('lite-admin', 'sqlite', { path: file, access: 'admin' })
  const p = call('lite-admin', 'admin', { sql: 'CREATE TABLE t2 (a)' })
  const a = await answerNext(true)
  assert.match(a.command, /^\[admin\] CREATE TABLE t2 \(a\)/)
  await p
  make('lite-ro', 'sqlite', { path: file, access: 'read' })
  await assert.rejects(call('lite-ro', 'execute', { sql: 'DELETE FROM items' }), /only allows reads/)
  await assert.rejects(call('lite-admin', 'admin', { sql: `ATTACH DATABASE '${join(tmp, 'other.db')}' AS o` }), /Refused at every safety level/)
  await assert.rejects(call('lite', 'query', { sql: "SELECT load_extension('x')" }), /Refused at every safety level/)
  assert.equal(existsSync(join(tmp, 'other.db')), false)
  await assert.rejects(call('lite', 'query', { sql: 'DELETE FROM items' }), /use the execute operation/)
  const audit = store.readCallAudit(50)
  assert.ok(audit.some((e) => e.decision === 'refused' && /ATTACH/.test(e.request)), 'refusals are audited')
  assert.ok(audit.some((e) => /rows returned/.test(e.detail ?? '')), 'rows returned are audited')
  assert.ok(!JSON.stringify(audit).includes('user0'), 'result rows never reach the audit')
})

test('SQLite: a missing file is not created', async () => {
  make('lite-missing', 'sqlite', { path: join(tmp, 'nope.db') })
  await assert.rejects(call('lite-missing', 'query', { sql: 'SELECT 1' }), /does not exist/)
  assert.equal(existsSync(join(tmp, 'nope.db')), false)
})

const SLOW = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300000000) SELECT count(*) FROM c'

test('limits: statement timeout, response size and concurrent calls', async () => {
  make('lite-slow', 'sqlite', { path: file, timeout_seconds: 1, max_concurrent: 2 })
  const t0 = Date.now()
  await assert.rejects(call('lite-slow', 'query', { sql: SLOW }), /did not finish within 1 s/)
  assert.ok(Date.now() - t0 < 5000)
  const a = call('lite-slow', 'query', { sql: SLOW }).catch((e) => e)
  const b = call('lite-slow', 'query', { sql: SLOW }).catch((e) => e)
  await new Promise((r) => setTimeout(r, 50))
  await assert.rejects(call('lite-slow', 'query', { sql: 'SELECT 1' }), /already has 2 calls running/)
  await Promise.all([a, b])
  make('lite-small', 'sqlite', { path: file, max_response_kb: 4, max_rows: 1000 })
  const r = await call('lite-small', 'query', { sql: 'SELECT id, name, email FROM users' })
  assert.ok(JSON.stringify(r.rows).length <= 4096)
  assert.equal(r.truncated, true)
  assert.match(r.notes.join(' '), /to stay under 4 KB/)
})

test('safety levels: approve-writes runs reads and asks for writes; Strict asks for reads, showing the statement', async () => {
  const c = make('lite-aw', 'sqlite', { path: file }, {}, 'approve-writes')
  await call('lite-aw', 'query', { sql: 'SELECT 1' })
  const p = call('lite-aw', 'execute', { sql: "UPDATE items SET title = 'z' WHERE id = 1" })
  const a = await answerNext(false)
  assert.match(a.command, /^\[write\] UPDATE items SET title = 'z' WHERE id = 1/)
  await assert.rejects(p, /declined/)
  store.saveConnection({ id: c.id, connectorId: 'sqlite', name: c.name, config: c.config, safety: 'strict', projectIds: ['p1'] })
  const q = call('lite-aw', 'query', { sql: 'SELECT count(*) FROM users' })
  const s = await answerNext(true)
  assert.match(s.command, /^\[read\] SELECT count\(\*\) FROM users/)
  assert.match(s.why, /Strict/)
  await q
})

test('the kill switch refuses calls and stops one in flight; project scoping hides other projects', async () => {
  connectors.switchOffAll(true)
  await assert.rejects(call('lite', 'query', { sql: 'SELECT 1' }), /switched off/)
  connectors.switchOffAll(false)
  make('lite-long', 'sqlite', { path: file, timeout_seconds: 30 })
  const p = call('lite-long', 'query', { sql: SLOW })
  await new Promise((r) => setTimeout(r, 300))
  connectors.switchOffAll(true)
  await assert.rejects(p, /switched off/)
  connectors.switchOffAll(false)
  await assert.rejects(call('lite', 'query', { sql: 'SELECT 1' }, { project: other, agent: 'worker #99' }), /No connections are linked|No connection called/)
})

test('test connection signs in and runs a read-only SELECT 1', async () => {
  const c = store.listConnections().find((x) => x.name === 'lite')
  const r = await db.testDbConnection(c, LITE)
  assert.equal(r.ok, true, r.message)
  assert.equal(store.readCallAudit(1)[0].operation, 'test_connection')
})

// ---------- network databases: fake servers and a fake driver; live PostgreSQL on PGlite when available ----------

/** A PostgreSQL server that answers every sign-in with an error quoting the password back, like a careless proxy. */
function fakePg() {
  const srv = net.createServer((sock) => {
    sock.once('data', () => {
      const msg = `password authentication failed for user "agent" (got ${PASS}) postgres://agent:${PASS}@x/shop` // made up (secret-scan: allow)
      const fields = Buffer.concat([Buffer.from('SFATAL\0'), Buffer.from('C28P01\0'), Buffer.from(`M${msg}\0`), Buffer.from('\0')])
      const head = Buffer.alloc(5)
      head.write('E', 0)
      head.writeUInt32BE(fields.length + 4, 1)
      sock.end(Buffer.concat([head, fields]))
    })
  })
  servers.push(srv)
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
}

/** A MySQL server: a real handshake, then an access-denied error that quotes the password back. */
function fakeMysql() {
  const packet = (seq, body) => {
    const h = Buffer.alloc(4)
    h.writeUIntLE(body.length, 0, 3)
    h[3] = seq
    return Buffer.concat([h, body])
  }
  const srv = net.createServer((sock) => {
    const salt = Buffer.from('abcdefghijklmnopqrst')
    const caps = 0x0000f7ff | 0x00080000 | 0x00008000 | 0x00000200
    const hs = Buffer.concat([
      Buffer.from([10]),
      Buffer.from('8.0.0-fake\0'),
      Buffer.from([1, 0, 0, 0]),
      salt.subarray(0, 8),
      Buffer.from([0]),
      Buffer.from([caps & 0xff, (caps >> 8) & 0xff]),
      Buffer.from([33]),
      Buffer.from([2, 0]),
      Buffer.from([(caps >> 16) & 0xff, (caps >> 24) & 0xff]),
      Buffer.from([21]),
      Buffer.alloc(10),
      salt.subarray(8),
      Buffer.from([0]),
      Buffer.from('mysql_native_password\0')
    ])
    sock.write(packet(0, hs))
    sock.on('error', () => {})
    sock.once('data', () => {
      const msg = Buffer.from(`Access denied for user 'agent'@'localhost' (using password: ${PASS})`)
      sock.end(packet(2, Buffer.concat([Buffer.from([0xff, 0x15, 0x04]), Buffer.from('#28000'), msg])))
    })
  })
  servers.push(srv)
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
}

test('PostgreSQL (real pg driver, fake server): the password in the server error never reaches the agent', async () => {
  const port = await fakePg()
  make('pg-fake', 'postgres', { host: '127.0.0.1', port, database: 'shop', user: 'agent' }, { password: PASS })
  const e = await firstUse('postgres', 'pg-fake', 'query', { sql: 'SELECT 1' }).catch((x) => x)
  assert.match(e.message, /refused the sign-in for agent/)
  assert.ok(!e.message.includes(PASS))
})

test('MySQL (real mysql2 driver, fake server): the password in the server error never reaches the agent', async () => {
  const port = await fakeMysql()
  make('my-fake', 'mysql', { host: '127.0.0.1', port, database: 'shop', user: 'agent' }, { password: PASS })
  const e = await firstUse('mysql', 'my-fake', 'query', { sql: 'SELECT 1' }).catch((x) => x)
  assert.match(e.message, /refused the sign-in|The database answered/)
  assert.ok(!e.message.includes(PASS), e.message)
})

test('SQL Server (real tedious driver): a refused connection gives a plain error; a fake driver that echoes the password is scrubbed', async () => {
  const closed = net.createServer()
  await new Promise((r) => closed.listen(0, '127.0.0.1', r))
  const port = closed.address().port
  await new Promise((r) => closed.close(r))
  make('ms-down', 'mssql', { host: '127.0.0.1', port, database: 'shop', user: 'agent', tls: 'off' }, { password: PASS })
  const e = await firstUse('mssql', 'ms-down', 'query', { sql: 'SELECT 1' }).catch((x) => x)
  assert.ok(e instanceof Error)
  assert.ok(!e.message.includes(PASS), e.message)
  const real = db.dbDeps.run.mssql
  try {
    db.dbDeps.run.mssql = async (t) => {
      assert.equal(t.password, PASS, 'the driver gets the saved password')
      assert.equal(t.readOnly, true)
      throw Object.assign(new Error(`Login failed for user 'agent'. Server=127.0.0.1;Password=${PASS};`), { code: 'ESOCKET' }) // made up (secret-scan: allow)
    }
    const e2 = await call('ms-down', 'query', { sql: 'SELECT 1' }).catch((x) => x)
    assert.ok(!e2.message.includes(PASS), e2.message)
    assert.match(e2.message, /refused the sign-in/)
    db.dbDeps.run.mssql = async () => ({ columns: ['note'], rows: [[`echo ${PASS}`]], more: 0 })
    const r = await call('ms-down', 'query', { sql: 'SELECT note FROM t' })
    assert.match(JSON.stringify(r), /\[redacted\]/, 'a password in result rows is scrubbed')
  } finally {
    db.dbDeps.run.mssql = real
  }
})

const live = process.env.PG_LIVE
test('PostgreSQL live (PGlite): reads, read-only enforcement, row cap with count, params, writes, admin, statement timeout set', { skip: !live && 'PG_LIVE not set (start PGlite to run it)' }, async () => {
  const [host, port] = live.split(':')
  const tbl = `people_${Date.now()}`
  make('pg-live', 'postgres', { host, port: Number(port), database: 'postgres', user: 'postgres', access: 'admin', max_rows: 50, timeout_seconds: 2 }, { password: PASS })
  await firstUse('postgres', 'pg-live', 'query', { sql: 'SELECT 1' })
  const p = call('pg-live', 'admin', { sql: `CREATE TABLE ${tbl} (id serial PRIMARY KEY, name text, password text)` })
  await answerNext(true)
  await p
  await call('pg-live', 'execute', { sql: `INSERT INTO ${tbl} (name, password) SELECT 'p' || g, 'pw' || g FROM generate_series(1, 120) g` })
  const r = await call('pg-live', 'query', { sql: `SELECT * FROM ${tbl} ORDER BY id` })
  assert.equal(r.rows_returned, 50)
  assert.match(r.notes[0], /70 more rows/)
  assert.equal(r.rows[0][2], '[masked]')
  const withParam = await call('pg-live', 'query', { sql: `SELECT name FROM ${tbl} WHERE id = $1`, params: [7] })
  assert.deepEqual(withParam.rows, [['p7']])
  const s = rules.dbSettings('postgres', { host, port: Number(port), user: 'postgres', database: 'postgres' }, PG.limits)
  await assert.rejects(db.dbDeps.run.postgres({ s, password: PASS, readOnly: true, statements: [{ text: `DELETE FROM ${tbl}`, params: [] }], signal: new AbortController().signal }), /read-only/)
  const left = await call('pg-live', 'query', { sql: `SELECT count(*) AS n FROM ${tbl}` })
  assert.equal(Number(left.rows[0][0]), 120, 'the misclassified write did not happen')
  // PGlite runs in one thread and doesn't enforce statement_timeout itself, so check that Corvid set it
  const timeout = await call('pg-live', 'query', { sql: 'SHOW statement_timeout' })
  assert.equal(timeout.rows[0][0], '2s')
  const t = await call('pg-live', 'describe', { table: tbl })
  assert.ok(t.rows.some((x) => x[1] === 'name'))
})

// ---------- the leak search ----------

test('the planted password is in no result, error, approval, log, audit or file', () => {
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
  assert.ok(outputs.length > 30)
  for (const value of PLANTED) for (const form of policy.secretVariants(value)) for (const [where, text] of texts) assert.ok(!text.includes(form), `a form of the planted password is in ${where}`)
})
