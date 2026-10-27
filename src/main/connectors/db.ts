import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { isIP } from 'node:net'
import type { Connection } from '@shared/types'
import type { ConnectorManifest, OpClass, Operation } from './manifest'
import { makeScrubber } from './policy'
import { allConnectionSecrets, auditCall, connectorState, getManifest, killedAll, secretProblem, secretValue } from './store'
import {
  auditStatement,
  classAbove,
  classifySql,
  dbSettings,
  dbTargetText,
  dbWarnings,
  describeSql,
  isDialect,
  maskingText,
  sampleSql,
  shapeResult,
  type DbResult,
  type DbSettings,
  type Dialect
} from './sqlRules'

// The database runtimes (#90): PostgreSQL (pg), MySQL and MariaDB (mysql2), SQL Server (tedious) and SQLite
// (Node's built-in node:sqlite, in a worker thread so a slow query can be stopped). The agent sends a statement;
// Corvid classifies it itself (sqlRules.ts), opens its own connection with the saved password, runs reads in a
// read-only transaction that is always rolled back, keeps to the limits, masks columns and returns rows. The
// password never leaves this file except into the driver.

// ---------- planning (no network; index.ts uses it to classify and to show the approval) ----------

export interface DbPlan {
  cls: OpClass
  statements: { text: string; params: unknown[] }[]
  /** the exact statements, for the approval dialog */
  shown: string
  /** the statements with secret-looking literals masked, for the audit */
  request: string
  why: string
  warnings: string[]
}

const ACCESS: Record<string, OpClass> = { read: 'read', 'read-write': 'write', admin: 'admin' }
export const connectionAccess = (config: Record<string, unknown>): OpClass => ACCESS[String(config.access ?? 'read-write').trim().toLowerCase()] ?? 'read'

const scalar = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v)

/** What a call will run and its class; throws (refused at every level) for what Corvid won't run. */
export function planDbCall(m: ConnectorManifest, config: Record<string, unknown>, op: Operation, args: Record<string, unknown>): DbPlan {
  const d = m.runtime as Dialect
  const s = dbSettings(d, config, m.limits)
  const warnings = dbWarnings(s)
  if (op.name === 'describe' || op.name === 'sample_rows') {
    const table = args.table === undefined ? undefined : String(args.table)
    const schema = args.schema === undefined ? undefined : String(args.schema)
    let st: { text: string; params: unknown[] }
    if (op.name === 'describe') {
      const q = describeSql(d, table, schema)
      st = { text: q.sql, params: q.params }
    } else {
      if (!table) throw new Error('sample_rows needs a table name.')
      const n = Math.min(20, Math.max(1, Math.floor(Number(args.limit) || 5)))
      st = { text: sampleSql(d, table, n, schema), params: [] }
    }
    const line = `${op.name}${schema ? ` ${schema}.` : ' '}${table ?? ''}`.trim()
    return { cls: 'read', statements: [st], shown: line, request: line, why: `${op.name} only reads the catalogue.`, warnings }
  }
  const sql = typeof args.sql === 'string' ? args.sql : ''
  if (!sql.trim()) throw new Error('Give the statement as args.sql.')
  if (sql.length > 100_000) throw new Error('The statement is longer than 100,000 characters.')
  const plan = classifySql(sql, d)
  if (plan.refused) throw new Error(plan.refused + ' Nothing was run.')
  const params = Array.isArray(args.params) ? args.params : []
  if (!params.every(scalar)) throw new Error('params must be a list of plain values (text, numbers, true/false or null).')
  if (params.length && plan.statements.length > 1) throw new Error('params can only be used with a single statement.')
  const worst = plan.statements.find((x) => x.cls === plan.cls)!
  if (classAbove(plan.cls, op.class)) {
    const use = plan.cls === 'admin' ? 'admin' : 'execute'
    throw new Error(`Corvid classes this as ${plan.cls} (${worst.why}), so ${op.name} won't run it; use the ${use} operation. Nothing was run.`)
  }
  const access = connectionAccess(config)
  if (classAbove(plan.cls, access))
    throw new Error(
      `This connection only allows ${access === 'read' ? 'reads' : 'reads and data changes'}, and Corvid classes this statement as ${plan.cls} (${worst.why}). Ask the user if it should allow more. Nothing was run.`
    )
  const statements = plan.statements.map((x) => ({ text: x.text, params: plan.statements.length === 1 ? params : [] }))
  const why =
    plan.cls === 'read' ? 'Reads only; it runs in a read-only transaction that is rolled back.' : plan.cls === 'write' ? `Changes data: ${worst.why}.` : `Changes structure, security or settings: ${worst.why}.`
  const label = `[${plan.cls}${plan.statements.length > 1 ? `, ${plan.statements.length} statements` : ''}] `
  return {
    cls: plan.cls,
    statements,
    shown: `${label}${sql.trim()}${params.length ? `\nparams: ${JSON.stringify(params).slice(0, 2000)}` : ''}`,
    request: label + auditStatement(sql),
    why,
    warnings
  }
}

/** The approval and describe_connection text for one database connection. */
export function dbSummary(m: ConnectorManifest, config: Record<string, unknown>): string {
  if (!isDialect(m.runtime)) return ''
  try {
    const s = dbSettings(m.runtime, config, m.limits)
    const access = connectionAccess(config)
    const what = access === 'read' ? 'can only read data in' : 'can read and change data in'
    return `This connection ${what} ${dbTargetText(s)}; can change the schema, users or grants: ${access === 'admin' ? 'yes (always asks)' : 'no'}. At most ${s.maxRows} rows and ${Math.round(s.maxBytes / 1024)} KB per call, ${Math.round(s.timeoutMs / 1000)} s per statement. ${maskingText(s)}`
  } catch (e) {
    return `This connection is not set up correctly: ${(e as Error).message}`
  }
}

export function dbConnectionWarnings(m: ConnectorManifest, config: Record<string, unknown>): string[] {
  try {
    return isDialect(m.runtime) ? dbWarnings(dbSettings(m.runtime, config, m.limits)) : []
  } catch {
    return []
  }
}

/** The connection form's check for a database connection, before it is saved: throws a plain message. */
export function checkDbConnection<T extends { connectorId: string; config: Record<string, unknown> }>(input: T): T {
  const m = getManifest(input.connectorId)?.manifest
  if (!m || !isDialect(m.runtime)) return input
  const cfg = input.config ?? {}
  dbSettings(m.runtime, cfg, m.limits)
  const tls = String(cfg.tls ?? '').trim().toLowerCase()
  if (tls && !['verify', 'no-verify', 'off'].includes(tls)) throw new Error('TLS must be verify, no-verify or off (or empty for the default).')
  const access = String(cfg.access ?? '').trim().toLowerCase()
  if (access && !ACCESS[access]) throw new Error('"Agents may" must be read, read-write or admin.')
  if (m.runtime !== 'sqlite' && !String(cfg.user ?? '').trim()) throw new Error('Set the user name the connection signs in as.')
  return input
}

// ---------- drivers ----------

interface Run {
  /** columns and rows of the last statement that returned rows, and how many more there were */
  columns: string[]
  rows: unknown[][]
  more: number
  affected?: number
}

interface Target {
  s: DbSettings
  password?: string
  ca?: string
  readOnly: boolean
  statements: { text: string; params: unknown[] }[]
  signal: AbortSignal
}

/** The drivers, swappable by the tests (a fake driver that echoes the password in its errors, say). */
export const dbDeps: { run: Record<Dialect, (t: Target) => Promise<Run>> } = {
  run: { postgres: runPostgres, mysql: runMysql, mssql: runMssql, sqlite: runSqlite }
}

const tlsFor = (t: Target): { rejectUnauthorized: boolean; ca?: string; servername?: string } | undefined =>
  t.s.tls === 'off' ? undefined : { rejectUnauthorized: t.s.tls === 'verify', ...(t.ca ? { ca: t.ca } : {}), ...(isIP(t.s.host) ? {} : { servername: t.s.host }) }

const CURSORABLE = /^\s*(SELECT|WITH|VALUES|TABLE)\b/i

/* eslint-disable @typescript-eslint/no-explicit-any */
async function runPostgres(t: Target): Promise<Run> {
  const { Client } = require('pg') as { Client: new (o: object) => any }
  const client = new Client({
    host: t.s.host,
    port: t.s.port,
    database: t.s.database || undefined,
    user: t.s.user || undefined,
    password: t.password ?? '',
    ssl: tlsFor(t) ?? false,
    connectionTimeoutMillis: 15_000,
    statement_timeout: t.s.timeoutMs,
    application_name: 'corvid'
  })
  client.on('error', () => {})
  const stop = (): void => void client.end().catch(() => {})
  t.signal.addEventListener('abort', stop, { once: true })
  let out: Run = { columns: [], rows: [], more: 0 }
  try {
    await client.connect()
    await client.query(t.readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
    // also set inside the transaction, for poolers and proxies that drop startup parameters
    await client.query(`SET LOCAL statement_timeout = ${Math.round(t.s.timeoutMs)}`)
    for (const st of t.statements) {
      // extended protocol: the server runs exactly one statement per query, whatever the text holds
      if (t.readOnly && CURSORABLE.test(st.text)) {
        await client.query({ text: `DECLARE corvid_rows NO SCROLL CURSOR FOR ${st.text}`, values: st.params, queryMode: 'extended' })
        const r = await client.query({ text: `FETCH FORWARD ${t.s.maxRows} FROM corvid_rows`, rowMode: 'array' })
        const rest = await client.query('MOVE FORWARD ALL IN corvid_rows')
        await client.query('CLOSE corvid_rows')
        out = { columns: r.fields.map((f: any) => f.name), rows: r.rows, more: Number(rest.rowCount) || 0 }
      } else {
        const r = await client.query({ text: st.text, values: st.params, rowMode: 'array', queryMode: 'extended' })
        out = r.fields?.length ? { columns: r.fields.map((f: any) => f.name), rows: r.rows, more: 0, affected: r.command === 'SELECT' ? undefined : (r.rowCount ?? undefined) } : { columns: [], rows: [], more: 0, affected: r.rowCount ?? 0 }
      }
    }
    await client.query(t.readOnly ? 'ROLLBACK' : 'COMMIT')
    return out
  } finally {
    t.signal.removeEventListener('abort', stop)
    await client.end().catch(() => {})
  }
}

async function runMysql(t: Target): Promise<Run> {
  const mysql = require('mysql2') as { createConnection: (o: object) => any }
  const conn = mysql.createConnection({
    host: t.s.host,
    port: t.s.port,
    database: t.s.database || undefined,
    user: t.s.user || undefined,
    password: t.password ?? '',
    ssl: tlsFor(t),
    connectTimeout: 15_000,
    multipleStatements: false,
    // a server must not be able to ask for a file from this computer (LOAD DATA LOCAL)
    flags: ['-LOCAL_FILES', '-MULTI_STATEMENTS'],
    infileStreamFactory: () => {
      throw new Error('Corvid does not send local files.')
    },
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true
  })
  // a failed sign-in or a dropped connection is reported on the connection, not on the query waiting behind it
  let fail: (e: Error) => void = () => {}
  const failed = new Promise<never>((_, reject) => (fail = reject))
  failed.catch(() => {})
  conn.on('error', (e: Error) => fail(e))
  const stop = (): void => {
    fail(new Error('stopped'))
    conn.destroy()
  }
  t.signal.addEventListener('abort', stop, { once: true })
  const q = (sql: string, values: unknown[] = []): Promise<Run> =>
    Promise.race([failed, new Promise<Run>((resolve, reject) => {
      const rows: unknown[][] = []
      let columns: string[] = []
      let more = 0
      let affected: number | undefined
      const query = conn.query({ sql, values, rowsAsArray: true, timeout: t.s.timeoutMs })
      query.on('error', reject)
      query.on('fields', (f: any[]) => void (columns = (f ?? []).map((x) => x.name)))
      query.on('result', (row: any) => {
        if (Array.isArray(row)) rows.length < t.s.maxRows ? rows.push(row) : more++
        else if (row && typeof row.affectedRows === 'number') affected = row.affectedRows
      })
      query.on('end', () => resolve({ columns, rows, more, affected }))
    })])
  try {
    await q(t.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION')
    let out: Run = { columns: [], rows: [], more: 0 }
    for (const st of t.statements) out = await q(st.text, st.params)
    await q(t.readOnly ? 'ROLLBACK' : 'COMMIT')
    return out
  } finally {
    t.signal.removeEventListener('abort', stop)
    conn.destroy()
  }
}

async function runMssql(t: Target): Promise<Run> {
  const { Connection, Request, TYPES } = require('tedious') as { Connection: new (o: object) => any; Request: new (sql: string, cb: (e?: Error, n?: number) => void) => any; TYPES: Record<string, unknown> }
  const conn = new Connection({
    server: t.s.host,
    authentication: { type: 'default', options: { userName: t.s.user, password: t.password ?? '' } },
    options: {
      port: t.s.port,
      database: t.s.database || undefined,
      encrypt: t.s.tls !== 'off',
      trustServerCertificate: t.s.tls === 'no-verify',
      ...(t.ca ? { cryptoCredentialsDetails: { ca: t.ca } } : {}),
      connectTimeout: 15_000,
      requestTimeout: t.s.timeoutMs,
      readOnlyIntent: t.readOnly,
      appName: 'corvid',
      rowCollectionOnRequestCompletion: false
    }
  })
  conn.on('error', () => {})
  const stop = (): void => void conn.close()
  t.signal.addEventListener('abort', stop, { once: true })
  const call = <T>(f: (cb: (e?: Error | null, x?: T) => void) => void): Promise<T> => new Promise((res, rej) => f((e, x) => (e ? rej(e) : res(x as T))))
  try {
    await new Promise<void>((res, rej) => {
      conn.once('connect', (e?: Error) => (e ? rej(e) : res()))
      conn.connect()
    })
    await call((cb) => conn.beginTransaction(cb, 'corvid'))
    let out: Run = { columns: [], rows: [], more: 0 }
    for (const st of t.statements) {
      out = await new Promise<Run>((resolve, reject) => {
        const rows: unknown[][] = []
        let columns: string[] = []
        let more = 0
        const req = new Request(st.text, (e, n) => (e ? reject(e) : resolve({ columns, rows, more, affected: columns.length ? undefined : (n ?? 0) })))
        st.params.forEach((v, i) => {
          const type = v === null ? TYPES.NVarChar : typeof v === 'number' ? (Number.isInteger(v) ? TYPES.BigInt : TYPES.Float) : typeof v === 'boolean' ? TYPES.Bit : TYPES.NVarChar
          req.addParameter(`p${i + 1}`, type, v)
        })
        req.on('columnMetadata', (cols: any[]) => {
          columns = cols.map((c) => c.colName)
          rows.length = 0
          more = 0
        })
        req.on('row', (cols: any[]) => (rows.length < t.s.maxRows ? rows.push(cols.map((c) => c.value)) : more++))
        conn.execSql(req)
      })
    }
    // SQL Server has no read-only transaction: a read call's transaction is always rolled back instead
    if (t.readOnly) await call((cb) => conn.rollbackTransaction(cb))
    else await call((cb) => conn.commitTransaction(cb))
    return out
  } finally {
    t.signal.removeEventListener('abort', stop)
    conn.close()
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Runs in a worker thread: node:sqlite is synchronous, and terminating the worker is how a slow query stops. */
const SQLITE_WORKER = `
const { parentPort, workerData: w } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
let db
try {
  db = new DatabaseSync(w.path, { readOnly: w.readOnly, allowExtension: false, timeout: 2000 })
  if (w.readOnly) db.exec('PRAGMA query_only = 1')
  db.exec(w.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')
  let out = { columns: [], rows: [], more: 0 }
  for (const st of w.statements) {
    const p = db.prepare(st.text)
    st.params = st.params.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v))
    const cols = p.columns()
    if (cols.length) {
      p.setReturnArrays?.(true)
      const rows = []
      let more = 0
      for (const r of p.iterate(...st.params)) {
        const row = Array.isArray(r) ? r : cols.map((c) => r[c.name])
        if (rows.length < w.maxRows) rows.push(row)
        else more++
      }
      out = { columns: cols.map((c) => c.name), rows, more }
    } else {
      const r = p.run(...st.params)
      out = { columns: [], rows: [], more: 0, affected: Number(r.changes) }
    }
  }
  db.exec(w.readOnly ? 'ROLLBACK' : 'COMMIT')
  parentPort.postMessage({ ok: true, out })
} catch (e) {
  try { db && db.isTransaction && db.exec('ROLLBACK') } catch {}
  parentPort.postMessage({ ok: false, message: String(e && e.message || e) })
} finally {
  try { db && db.close() } catch {}
}
`

function runSqlite(t: Target): Promise<Run> {
  if (!existsSync(t.s.path)) return Promise.reject(new Error(`The database file ${t.s.path} does not exist. Corvid only opens a file that is already there.`))
  return new Promise((resolve, reject) => {
    const w = new Worker(SQLITE_WORKER, { eval: true, workerData: { path: t.s.path, readOnly: t.readOnly, statements: t.statements, maxRows: t.s.maxRows } })
    const timer = setTimeout(() => {
      void w.terminate()
      reject(new Error('timeout'))
    }, t.s.timeoutMs)
    const stop = (): void => {
      void w.terminate()
      reject(t.signal.reason instanceof Error ? t.signal.reason : new Error('stopped'))
    }
    t.signal.addEventListener('abort', stop, { once: true })
    const done = (): void => {
      clearTimeout(timer)
      t.signal.removeEventListener('abort', stop)
    }
    w.once('message', (m: { ok: boolean; out?: Run; message?: string }) => {
      done()
      void w.terminate()
      m.ok ? resolve(m.out!) : reject(new Error(m.message))
    })
    w.once('error', (e) => (done(), reject(e)))
    w.once('exit', () => (done(), reject(new Error('The SQLite worker stopped.'))))
  })
}

// ---------- the call ----------

const active = new Map<string, number>()

function takeSlot(c: Connection, s: DbSettings): () => void {
  const n = active.get(c.id) ?? 0
  if (n >= s.maxConcurrent) throw new Error(`${c.name} already has ${s.maxConcurrent} calls running; wait for one to finish. Nothing was run.`)
  active.set(c.id, n + 1)
  return () => active.set(c.id, Math.max(0, (active.get(c.id) ?? 1) - 1))
}

/** Driver errors in plain words; the password and anything else known secret is masked first. */
function explain(e: unknown, s: DbSettings, scrub: (x: string) => string, timedOut: boolean): Error {
  const err = e as { message?: string; code?: string | number; errno?: number }
  const code = String(err?.code ?? '')
  const msg = scrub(String(err?.message ?? e))
  const where = s.dialect === 'sqlite' ? s.path : `${s.host}:${s.port}`
  if (timedOut || /timeout|timed out|canceling statement due to statement timeout/i.test(msg)) return new Error(`The statement did not finish within ${Math.round(s.timeoutMs / 1000)} s and was stopped.`)
  if (code === 'ECONNREFUSED') return new Error(`${where} refused the connection. Is the database running there?`)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error(`${s.host} could not be found.`)
  if (code === '28P01' || code === '28000' || code === 'ER_ACCESS_DENIED_ERROR' || code === 'ELOGIN' || /password authentication failed|access denied|login failed/i.test(msg))
    return new Error(`The database refused the sign-in for ${s.user || 'this user'}. Ask the user to check the user name and the saved password.`)
  if (/certificate|self[- ]signed|SSL|TLS/i.test(msg) && !/syntax/i.test(msg))
    return new Error(`The secure connection to ${where} failed (${msg.slice(0, 200)}). If this is the user's own server with a self-signed certificate, they can set TLS to no-verify on the connection.`)
  if (/read-only|readonly|read only/i.test(msg)) return new Error(`The database refused a change inside a read-only call: ${msg.slice(0, 500)}`)
  return new Error(`The database answered: ${msg.slice(0, 2000)}`)
}

/** Runs one planned call. index.ts has already classified, approved and checked the kill switch. */
export async function dbCall(c: Connection, m: ConnectorManifest, op: Operation, args: Record<string, unknown>, stopSignal: AbortSignal): Promise<unknown> {
  if (!isDialect(m.runtime)) throw new Error('Not a database connector.')
  const s = dbSettings(m.runtime, c.config, m.limits)
  const plan = planDbCall(m, c.config, op, args)
  const password = secretValue(c, 'password')
  const ca = secretValue(c, 'ca_certificate')
  // a stored secret the keyring won't give back now (#159): say so rather than connect without it
  for (const slot of ['password', 'ca_certificate']) {
    const problem = secretProblem(c, slot)
    if (problem) throw new Error(`${problem} (${slot.replace('_', ' ')} for ${c.name})`)
  }
  const scrub = makeScrubber([...(password ? [password] : []), ...allConnectionSecrets()])
  const release = takeSlot(c, s)
  const deadline = AbortSignal.timeout(s.timeoutMs + 20_000)
  const signal = AbortSignal.any([stopSignal, deadline])
  const started = Date.now()
  try {
    const r = await dbDeps.run[m.runtime]({ s, password, ca, readOnly: plan.cls === 'read', statements: plan.statements, signal })
    const out: DbResult & { class?: OpClass; statements?: number } = shapeResult(r.columns, r.rows, r.more, s, r.affected)
    if (plan.statements.length > 1) (out.notes ??= []).unshift(`${plan.statements.length} statements ran; the result is the last one's.`)
    return { class: plan.cls, ...out, duration_ms: Date.now() - started }
  } catch (e) {
    if (stopSignal.aborted) throw new Error('Connectors were switched off, so this call was stopped.')
    throw explain(e, s, scrub, deadline.aborted || (e as Error)?.message === 'timeout')
  } finally {
    release()
  }
}

/** The audit's detail for a database result: rows returned or affected, never the rows. */
export function dbDetail(out: unknown): string | undefined {
  const r = out as { rows_returned?: unknown; rows_affected?: unknown; truncated?: unknown }
  if (typeof r?.rows_returned !== 'number') return undefined
  return [typeof r.rows_affected === 'number' ? `${r.rows_affected} rows affected` : '', `${r.rows_returned} rows returned${r.truncated ? ' (truncated)' : ''}`].filter(Boolean).join(', ')
}

/** The Connections tab's "test connection": sign in, run a trivial read in a read-only transaction, report. */
export async function testDbConnection(c: Connection, m: ConnectorManifest): Promise<{ ok: boolean; message: string; durationMs: number }> {
  const started = Date.now()
  const scrub = makeScrubber(allConnectionSecrets())
  let out: { ok: boolean; message: string }
  try {
    if (killedAll() || connectorState(c.connectorId)?.disabled) throw new Error('Connectors are switched off in Corvid, so nothing was run.')
    if (!isDialect(m.runtime)) throw new Error('Not a database connector.')
    const op: Operation = { name: 'query', description: 'test connection', class: 'read' }
    await dbCall(c, m, op, { sql: 'SELECT 1' }, new AbortController().signal)
    out = { ok: true, message: `Connected: signed in and ran a read-only SELECT 1 (${dbTargetText(dbSettings(m.runtime, c.config, m.limits))}).` }
  } catch (e) {
    out = { ok: false, message: scrub((e as Error).message) }
  }
  const durationMs = Date.now() - started
  auditCall({
    ts: Date.now(),
    agent: 'user (test connection)',
    connection: c.name,
    connector: `${m.id}@${m.version}`,
    operation: 'test_connection',
    class: 'read',
    decision: 'automatic',
    request: 'SELECT 1',
    durationMs,
    error: out.ok ? undefined : out.message
  })
  return { ...out, durationMs }
}
