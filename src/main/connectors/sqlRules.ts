import type { OpClass } from './manifest'

// The database runtimes' rules (#90), kept free of electron and of the drivers so the tests run them directly:
// a tokenizer that understands each dialect's comments, strings and quoted names, a statement splitter, the
// classifier (read, write, admin), the constructs refused at every level, the connection settings, masking and the
// least-privilege examples. Like remote/classify.ts for shell commands: when unsure, the answer is the riskier class.

export type Dialect = 'postgres' | 'mysql' | 'mssql' | 'sqlite'
export const DIALECTS: Dialect[] = ['postgres', 'mysql', 'mssql', 'sqlite']
export const isDialect = (r: unknown): r is Dialect => DIALECTS.includes(r as Dialect)

const RANK: Record<OpClass, number> = { read: 0, write: 1, admin: 2 }
export const maxClass = (a: OpClass, b: OpClass): OpClass => (RANK[a] >= RANK[b] ? a : b)
export const classAbove = (a: OpClass, b: OpClass): boolean => RANK[a] > RANK[b]

// ---------- tokens ----------

export type Token = { t: 'word'; v: string; raw: string } | { t: 'str'; v: string } | { t: 'ident'; v: string } | { t: 'punct'; v: string; at?: number } | { t: 'num'; v: string } | { t: 'param'; v: string }

/** Thrown for text the tokenizer won't guess about: an unclosed string or comment, or a MySQL executable comment. */
export class SqlRefusal extends Error {}

/**
 * Splits SQL into tokens. Comments are dropped (so they can't hide anything), strings and quoted names become
 * single tokens (so a keyword inside one doesn't count), words are upper-cased (so case games don't matter).
 */
export function tokenize(sql: string, d: Dialect): Token[] {
  const out: Token[] = []
  const s = String(sql ?? '')
  let i = 0
  const n = s.length
  const until = (close: string, from: number, what: string): number => {
    const j = s.indexOf(close, from)
    if (j < 0) throw new SqlRefusal(`The statement has an unclosed ${what}.`)
    return j
  }
  /** a quoted run where the quote doubles to escape it (and, in MySQL strings, a backslash escapes) */
  const quoted = (q: string, backslash: boolean, what: string): string => {
    let j = i + 1
    let v = ''
    for (;;) {
      if (j >= n) throw new SqlRefusal(`The statement has an unclosed ${what}.`)
      const ch = s[j]
      if (backslash && ch === '\\') {
        v += s[j + 1] ?? ''
        j += 2
        continue
      }
      if (ch === q) {
        if (s[j + 1] === q) {
          v += q
          j += 2
          continue
        }
        i = j + 1
        return v
      }
      v += ch
      j++
    }
  }
  while (i < n) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '-' && s[i + 1] === '-') {
      const j = s.indexOf('\n', i)
      i = j < 0 ? n : j + 1
      continue
    }
    if (c === '#' && d === 'mysql') {
      const j = s.indexOf('\n', i)
      i = j < 0 ? n : j + 1
      continue
    }
    if (c === '/' && s[i + 1] === '*') {
      // MySQL runs the text of /*! ... */ and /*+ ... */ hints; nothing here guesses what the server makes of them
      if (d === 'mysql' && (s[i + 2] === '!' || s[i + 2] === '+' || s[i + 2] === 'M')) throw new SqlRefusal('MySQL executable comments (/*! ... */) are not allowed.')
      if (d === 'postgres' || d === 'mssql') {
        // these dialects nest block comments
        let depth = 0
        let j = i
        for (;;) {
          if (j >= n) throw new SqlRefusal('The statement has an unclosed comment.')
          if (s[j] === '/' && s[j + 1] === '*') (depth++, (j += 2))
          else if (s[j] === '*' && s[j + 1] === '/') {
            depth--
            j += 2
            if (!depth) break
          } else j++
        }
        i = j
      } else i = until('*/', i + 2, 'comment') + 2
      continue
    }
    if (c === "'") {
      out.push({ t: 'str', v: quoted("'", d === 'mysql', 'string') })
      continue
    }
    if ((c === 'E' || c === 'e') && s[i + 1] === "'" && d === 'postgres') {
      i++
      out.push({ t: 'str', v: quoted("'", true, 'string') })
      continue
    }
    if ((c === 'N' || c === 'n' || c === 'X' || c === 'x' || c === 'B' || c === 'b') && s[i + 1] === "'") {
      i++
      out.push({ t: 'str', v: quoted("'", d === 'mysql', 'string') })
      continue
    }
    if (c === '"') {
      // a string in MySQL's default mode, a quoted name elsewhere: either way a single token
      const v = quoted('"', d === 'mysql', 'quoted name')
      out.push(d === 'mysql' ? { t: 'str', v } : { t: 'ident', v })
      continue
    }
    if (c === '`' && (d === 'mysql' || d === 'sqlite')) {
      out.push({ t: 'ident', v: quoted('`', false, 'quoted name') })
      continue
    }
    if (c === '[' && (d === 'mssql' || d === 'sqlite')) {
      out.push({ t: 'ident', v: quoted(']', false, 'quoted name') })
      continue
    }
    if (c === '$' && d === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i))
      if (m) {
        const end = until(m[0], i + m[0].length, 'dollar-quoted string')
        out.push({ t: 'str', v: s.slice(i + m[0].length, end) })
        i = end + m[0].length
        continue
      }
      const p = /^\$\d+/.exec(s.slice(i))
      if (p) {
        out.push({ t: 'param', v: p[0] })
        i += p[0].length
        continue
      }
    }
    if (/[A-Za-z_\u0080-￿@#]/.test(c)) {
      const m = /^[A-Za-z_\u0080-￿@#][A-Za-z0-9_$@#\u0080-￿]*/.exec(s.slice(i))!
      if (m[0].startsWith('@') || (m[0].startsWith('#') && d === 'mssql')) out.push({ t: 'param', v: m[0] })
      else out.push({ t: 'word', v: m[0].toUpperCase(), raw: m[0] })
      i += m[0].length
      continue
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9][0-9A-Za-z_.]*/.exec(s.slice(i))!
      out.push({ t: 'num', v: m[0] })
      i += m[0].length
      continue
    }
    if (c === '?' || c === ':') {
      out.push({ t: c === '?' ? 'param' : 'punct', v: c })
      i++
      continue
    }
    out.push({ t: 'punct', v: c, at: i })
    i++
  }
  return out
}

/** Statements, split on top-level semicolons (found by the tokenizer, so never inside a string, name or comment). */
export function splitStatements(sql: string, d: Dialect): { text: string; tokens: Token[] }[] {
  const s = String(sql ?? '')
  const cuts: number[] = []
  let depth = 0
  for (const t of tokenize(s, d)) {
    if (t.t !== 'punct') continue
    if (t.v === '(') depth++
    else if (t.v === ')') depth = Math.max(0, depth - 1)
    else if (t.v === ';' && depth === 0) cuts.push(t.at!)
  }
  const parts: string[] = []
  let from = 0
  for (const c of cuts) (parts.push(s.slice(from, c)), (from = c + 1))
  parts.push(s.slice(from))
  return parts.map((text) => ({ text: text.trim(), tokens: tokenize(text, d) })).filter((p) => p.tokens.length)
}

// ---------- blocked constructs (one list, every dialect, every class) ----------

/**
 * Words or word runs that reach files, programs, other servers or the server's own configuration. Refused at every
 * level, whatever the safety setting: there is no approval that makes them run through Corvid. Checked on the
 * upper-cased word tokens, so case, comments and spacing don't matter; string contents are never words.
 */
export const BLOCKED: { dialects: Dialect[] | 'all'; words: string[]; why: string }[] = [
  // PostgreSQL
  { dialects: 'all', words: ['COPY'], why: 'COPY reads and writes server files and programs' },
  { dialects: 'all', words: ['PG_READ_FILE'], why: 'reads server files' },
  { dialects: 'all', words: ['PG_READ_BINARY_FILE'], why: 'reads server files' },
  { dialects: 'all', words: ['PG_LS_DIR'], why: 'lists server folders' },
  { dialects: 'all', words: ['PG_STAT_FILE'], why: 'reads server files' },
  { dialects: 'all', words: ['PG_FILE_WRITE'], why: 'writes server files' },
  { dialects: 'all', words: ['PG_LS_LOGDIR'], why: 'lists server folders' },
  { dialects: 'all', words: ['PG_LS_WALDIR'], why: 'lists server folders' },
  { dialects: 'all', words: ['LO_IMPORT'], why: 'reads server files' },
  { dialects: 'all', words: ['LO_EXPORT'], why: 'writes server files' },
  { dialects: 'all', words: ['DBLINK'], why: 'reaches another server' },
  { dialects: 'all', words: ['DBLINK_CONNECT'], why: 'reaches another server' },
  { dialects: 'all', words: ['DBLINK_EXEC'], why: 'reaches another server' },
  { dialects: 'all', words: ['DBLINK_CONNECT_U'], why: 'reaches another server' },
  { dialects: 'all', words: ['CREATE', 'SERVER'], why: 'defines a link to another server' },
  { dialects: 'all', words: ['CREATE', 'FOREIGN'], why: 'defines a link to another server' },
  { dialects: 'all', words: ['CREATE', 'USER', 'MAPPING'], why: 'stores credentials for another server' },
  { dialects: 'all', words: ['CREATE', 'EXTENSION'], why: 'loads server-side code' },
  { dialects: 'all', words: ['CREATE', 'LANGUAGE'], why: 'loads server-side code' },
  { dialects: 'all', words: ['LANGUAGE', 'C'], why: 'runs native code on the server' },
  { dialects: 'all', words: ['LANGUAGE', 'PLPYTHONU'], why: 'runs untrusted code on the server' },
  { dialects: 'all', words: ['LANGUAGE', 'PLPYTHON3U'], why: 'runs untrusted code on the server' },
  { dialects: 'all', words: ['LANGUAGE', 'PLPERLU'], why: 'runs untrusted code on the server' },
  { dialects: 'all', words: ['LANGUAGE', 'PLSH'], why: 'runs programs on the server' },
  { dialects: 'all', words: ['ALTER', 'SYSTEM'], why: "changes the server's configuration" },
  { dialects: 'all', words: ['PG_RELOAD_CONF'], why: "changes the server's configuration" },
  { dialects: 'all', words: ['SET_CONFIG'], why: 'changes settings Corvid relies on (like read-only)' },
  { dialects: 'all', words: ['PG_EXECUTE_SERVER_PROGRAM'], why: 'grants running programs on the server' },
  { dialects: 'all', words: ['PG_READ_SERVER_FILES'], why: 'grants reading server files' },
  { dialects: 'all', words: ['PG_WRITE_SERVER_FILES'], why: 'grants writing server files' },
  // MySQL and MariaDB
  { dialects: 'all', words: ['LOAD_FILE'], why: 'reads server files' },
  { dialects: 'all', words: ['OUTFILE'], why: 'writes server files' },
  { dialects: 'all', words: ['DUMPFILE'], why: 'writes server files' },
  { dialects: 'all', words: ['LOAD', 'DATA'], why: 'reads files' },
  { dialects: 'all', words: ['LOAD', 'XML'], why: 'reads files' },
  { dialects: 'all', words: ['INSTALL'], why: 'loads server plugins' },
  { dialects: 'all', words: ['UNINSTALL'], why: 'unloads server plugins' },
  { dialects: 'all', words: ['SONAME'], why: 'loads native code on the server' },
  { dialects: 'all', words: ['FEDERATED'], why: 'reaches another server' },
  { dialects: 'all', words: ['SYS_EXEC'], why: 'runs programs on the server' },
  { dialects: 'all', words: ['SYS_EVAL'], why: 'runs programs on the server' },
  { dialects: 'all', words: ['SET', 'GLOBAL'], why: "changes the server's configuration" },
  { dialects: 'all', words: ['SET', 'PERSIST'], why: "changes the server's configuration" },
  { dialects: 'all', words: ['CHANGE', 'MASTER'], why: 'points the server at another server' },
  { dialects: 'all', words: ['CHANGE', 'REPLICATION'], why: 'points the server at another server' },
  { dialects: 'all', words: ['SHUTDOWN'], why: 'stops the server' },
  // SQL Server
  { dialects: 'all', words: ['XP_CMDSHELL'], why: 'runs programs on the server' },
  { dialects: 'all', words: ['SP_CONFIGURE'], why: "changes the server's configuration" },
  { dialects: 'all', words: ['RECONFIGURE'], why: "changes the server's configuration" },
  { dialects: 'all', words: ['OPENROWSET'], why: 'reads files and reaches other servers' },
  { dialects: 'all', words: ['OPENDATASOURCE'], why: 'reaches another server' },
  { dialects: 'all', words: ['OPENQUERY'], why: 'reaches another server' },
  { dialects: 'all', words: ['BULK'], why: 'reads files' },
  { dialects: 'all', words: ['SP_ADDLINKEDSERVER'], why: 'reaches another server' },
  { dialects: 'all', words: ['SP_ADDLINKEDSRVLOGIN'], why: 'stores credentials for another server' },
  { dialects: 'all', words: ['SP_EXECUTE_EXTERNAL_SCRIPT'], why: 'runs programs on the server' },
  { dialects: 'all', words: ['SP_SEND_DBMAIL'], why: 'sends mail from the server' },
  { dialects: 'all', words: ['CREATE', 'ASSEMBLY'], why: 'loads native code on the server' },
  { dialects: 'all', words: ['BACKUP'], why: 'writes server files' },
  { dialects: 'all', words: ['RESTORE'], why: 'reads server files' },
  // SQLite
  { dialects: 'all', words: ['ATTACH'], why: 'opens another database file' },
  { dialects: 'all', words: ['DETACH'], why: 'changes which database files are open' },
  { dialects: 'all', words: ['LOAD_EXTENSION'], why: 'loads native code' },
  { dialects: 'all', words: ['VACUUM', 'INTO'], why: 'writes another file' },
  { dialects: 'all', words: ['READFILE'], why: 'reads files' },
  { dialects: 'all', words: ['WRITEFILE'], why: 'writes files' },
  { dialects: 'all', words: ['FTS3_TOKENIZER'], why: 'can load native code' }
]

/** Word prefixes refused the same way: SQL Server's extended and OLE automation procedures. */
const BLOCKED_PREFIXES: { prefix: string; why: string }[] = [
  { prefix: 'XP_', why: 'extended procedures reach files, the registry and programs' },
  { prefix: 'SP_OA', why: 'OLE automation runs programs on the server' }
]

/** The first blocked construct in the tokens, or null. */
export function blockedIn(tokens: Token[]): string | null {
  const words = tokens.map((t) => (t.t === 'word' ? t.v : t.t === 'ident' ? '"' : t.t === 'punct' && t.v === '.' ? '.' : ' '))
  for (let i = 0; i < words.length; i++) {
    for (const b of BLOCKED) {
      if (b.words.every((w, k) => words[i + k] === w)) return `${b.words.join(' ')} (${b.why})`
    }
    for (const p of BLOCKED_PREFIXES) if (words[i].startsWith(p.prefix)) return `${(tokens[i] as { raw?: string }).raw ?? words[i]} (${p.why})`
  }
  // SQL Server four-part names (server.database.schema.table) reach a linked server
  for (let i = 0; i + 5 < tokens.length; i++) {
    const nameAt = (k: number): boolean => tokens[k]?.t === 'word' || tokens[k]?.t === 'ident'
    const dotAt = (k: number): boolean => tokens[k]?.t === 'punct' && tokens[k].v === '.'
    if (nameAt(i) && dotAt(i + 1) && (nameAt(i + 2) || dotAt(i + 2)) && dotAt(i + 3) && nameAt(i + 4) && dotAt(i + 5) && nameAt(i + 6) && (i === 0 || !dotAt(i - 1)))
      return 'a four-part name (it reaches a linked server)'
    if (nameAt(i) && dotAt(i + 1) && dotAt(i + 2) && nameAt(i + 3) && dotAt(i + 4) && nameAt(i + 5) && (i === 0 || !dotAt(i - 1))) return 'a four-part name (it reaches a linked server)'
  }
  return null
}

// ---------- classification ----------

const READ_STARTS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'])
const WRITE_STARTS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT'])
/** Anywhere in a statement, these make it at least a change (a CTE that writes, T-SQL's second statement without ;). */
const WRITE_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'NEXTVAL', 'SETVAL', 'PG_ADVISORY_LOCK', 'PG_ADVISORY_XACT_LOCK', 'GET_LOCK', 'SLEEP_UNTIL'])
/** Statement starts that are administrative: structure, security, settings, transactions, dynamic SQL. */
const ADMIN_WORDS = new Set([
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'RENAME', 'COMMENT', 'VACUUM', 'REINDEX', 'CLUSTER', 'ANALYZE', 'ANALYSE', 'OPTIMIZE', 'REPAIR',
  'LOCK', 'UNLOCK', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'START', 'END', 'ABORT', 'SET', 'RESET', 'DO', 'CALL', 'EXEC', 'EXECUTE', 'SP_EXECUTESQL',
  'PREPARE', 'DEALLOCATE', 'DECLARE', 'USE', 'KILL', 'FLUSH', 'HANDLER', 'PURGE', 'REFRESH', 'SECURITY', 'OWNER', 'IMPERSONATE', 'REVERT', 'SETUSER', 'DBCC',
  'CHECKPOINT', 'LISTEN', 'NOTIFY', 'UNLISTEN', 'DISCARD', 'IMPORT', 'REASSIGN'
])
/**
 * Anywhere in a statement, these make it administrative. Words that are also common column names (comment, end,
 * owner) only count as a statement start, except in SQL Server, where a second statement needs no ; before it.
 */
const ADMIN_ANYWHERE = new Set([
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'SET', 'DO', 'CALL', 'EXEC', 'EXECUTE', 'SP_EXECUTESQL',
  'PREPARE', 'DEALLOCATE', 'DECLARE', 'DBCC', 'SETUSER', 'REVERT', 'IMPERSONATE', 'VACUUM', 'REINDEX',
  'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'LO_UNLINK', 'LO_CREATE', 'LO_FROM_BYTEA', 'PG_SWITCH_WAL', 'TXID_CURRENT'
])
/** T-SQL statement starts that can follow another statement without a ; and count as administrative there. */
const MSSQL_STARTS = new Set(['USE', 'KILL', 'DBCC', 'CHECKPOINT', 'SAVE', 'RECEIVE', 'SEND', 'ENABLE', 'DISABLE', 'GO', 'TRUNCATE', 'OPEN', 'FETCH', 'CLOSE', 'DEALLOCATE'])
/** SQLite pragmas that only report; any other pragma, or one given a value, is administrative. */
const READ_PRAGMAS = new Set(['TABLE_INFO', 'TABLE_XINFO', 'TABLE_LIST', 'INDEX_LIST', 'INDEX_INFO', 'INDEX_XINFO', 'FOREIGN_KEY_LIST', 'DATABASE_LIST', 'COLLATION_LIST', 'FUNCTION_LIST', 'PRAGMA_LIST', 'USER_VERSION', 'SCHEMA_VERSION', 'PAGE_COUNT', 'PAGE_SIZE', 'ENCODING', 'INTEGRITY_CHECK', 'QUICK_CHECK', 'FOREIGN_KEY_CHECK', 'COMPILE_OPTIONS', 'FREELIST_COUNT', 'APPLICATION_ID', 'JOURNAL_MODE'])

export interface StatementClass {
  cls: OpClass
  why: string
  text: string
}

export interface SqlPlan {
  cls: OpClass
  statements: StatementClass[]
  /** set when something must be refused at every level */
  refused?: string
}

/** One statement's class and the reason, in words. */
export function classifyStatement(tokens: Token[], text: string, d: Dialect): StatementClass {
  const words = tokens.filter((t) => t.t === 'word').map((t) => t.v)
  const first = tokens[0]
  if (first.t !== 'word') return { cls: 'admin', why: 'it does not start with a known keyword', text }
  const head = first.v
  let cls: OpClass
  let why: string
  if (head === 'PRAGMA' && d === 'sqlite') {
    const name = tokens.find((t, k) => k > 0 && t.t === 'word' && !(tokens[k + 1]?.t === 'punct' && tokens[k + 1].v === '.'))
    const assigns = tokens.some((t) => t.t === 'punct' && t.v === '=')
    const ok = name?.t === 'word' && READ_PRAGMAS.has(name.v) && !assigns && !(name.v === 'JOURNAL_MODE' && tokens.some((t) => t.t === 'punct' && t.v === '('))
    return ok ? { cls: 'read', why: 'a pragma that only reports', text } : { cls: 'admin', why: 'a pragma that changes settings', text }
  }
  if (head === 'EXPLAIN') {
    // EXPLAIN ANALYZE runs the statement; classify what it runs. Plain EXPLAIN only plans it.
    const rest = tokens.slice(1)
    const analyzes = rest.slice(0, 6).some((t) => t.t === 'word' && (t.v === 'ANALYZE' || t.v === 'ANALYSE'))
    if (!analyzes) return { cls: 'read', why: 'EXPLAIN only shows the plan', text }
    const inner = rest.findIndex((t) => t.t === 'word' && (READ_STARTS.has(t.v) || WRITE_STARTS.has(t.v) || t.v === 'CREATE'))
    if (inner < 0) return { cls: 'admin', why: 'EXPLAIN ANALYZE of something unrecognised', text }
    const c = classifyStatement(rest.slice(inner), text, d)
    return { ...c, why: `EXPLAIN ANALYZE runs it: ${c.why}` }
  }
  if (READ_STARTS.has(head)) ((cls = 'read'), (why = 'a query that only reads'))
  else if (WRITE_STARTS.has(head)) ((cls = 'write'), (why = `${head} changes data`))
  else if (ADMIN_WORDS.has(head)) return { cls: 'admin', why: `${head} changes structure, security, settings or transactions`, text }
  else return { cls: 'admin', why: `${head} is not a statement Corvid recognises`, text }

  const anywhere = d === 'mssql' ? (w: string) => ADMIN_ANYWHERE.has(w) || MSSQL_STARTS.has(w) : (w: string) => ADMIN_ANYWHERE.has(w)
  // UPDATE ... SET, INSERT ... SET (MySQL), ON CONFLICT ... DO, CASE ... END are part of the statement, not another one
  let setOwed = ['UPDATE', 'INSERT', 'MERGE', 'REPLACE'].includes(head)
  for (let k = 1; k < words.length; k++) {
    const w = words[k]
    if (['UPDATE', 'INSERT', 'MERGE', 'REPLACE'].includes(w)) setOwed = true
    if (w === 'SET' && setOwed) {
      setOwed = false
      continue
    }
    if (w === 'DO' && words.slice(0, k).includes('CONFLICT') && ['NOTHING', 'UPDATE'].includes(words[k + 1] ?? '')) continue
    if (w === 'END' && words.includes('CASE')) continue
    if (anywhere(w)) return { cls: 'admin', why: `it contains ${w}`, text }
    if (cls === 'read' && WRITE_WORDS.has(w)) ((cls = 'write'), (why = `it contains ${w}`))
  }
  if (cls === 'read') {
    // SELECT ... INTO makes a table (PostgreSQL, SQL Server) or sets variables; FOR UPDATE takes write locks
    const into = words.indexOf('INTO')
    if (into >= 0) return { cls: 'admin', why: 'SELECT ... INTO creates a table', text }
    const f = words.indexOf('FOR')
    if (f >= 0 && ['UPDATE', 'SHARE', 'NO'].includes(words[f + 1] ?? '')) return { cls: 'write', why: 'FOR UPDATE or SHARE takes locks', text }
  }
  return { cls, why, text }
}

/** Splits, classifies each statement and takes the most dangerous; refuses what can't be parsed or is blocked. */
export function classifySql(sql: string, d: Dialect): SqlPlan {
  let parts: { text: string; tokens: Token[] }[]
  try {
    parts = splitStatements(sql, d)
  } catch (e) {
    return { cls: 'admin', statements: [], refused: e instanceof SqlRefusal ? e.message : 'The statement could not be read.' }
  }
  if (!parts.length) return { cls: 'read', statements: [], refused: 'The statement is empty.' }
  const statements: StatementClass[] = []
  let cls: OpClass = 'read'
  for (const p of parts) {
    const b = blockedIn(p.tokens)
    if (b) return { cls: 'admin', statements, refused: `Refused at every safety level: ${b}. Corvid's database connections never touch files, programs or other servers.` }
    const c = classifyStatement(p.tokens, p.text, d)
    statements.push(c)
    cls = maxClass(cls, c.cls)
  }
  return { cls, statements }
}

/** The statement for the audit log: string literals that look like secrets masked, cut to a length. */
export function auditStatement(sql: string, max = 1000): string {
  const masked = String(sql ?? '')
    // IDENTIFIED BY 'x', PASSWORD 'x', password = 'x' and similar
    .replace(/((?:IDENTIFIED\s+(?:WITH\s+\w+\s+)?BY|PASSWORD\s*=?|SECRET\s*=?|TOKEN\s*=?)\s*)(N?'(?:[^']|'')*')/gi, "$1'[redacted]'")
    // a long literal with no spaces looks like a key or token
    .replace(/'([A-Za-z0-9+/=_\-.~]{20,})'/g, "'[redacted]'")
  return masked.length > max ? masked.slice(0, max) + ' ...[cut]' : masked
}

// ---------- settings ----------

export type TlsMode = 'verify' | 'no-verify' | 'off'

export interface DbSettings {
  dialect: Dialect
  host: string
  port: number
  database: string
  user: string
  tls: TlsMode
  path: string
  local: boolean
  timeoutMs: number
  maxRows: number
  maxBytes: number
  maxConcurrent: number
  mask: RegExp[]
  maskText: string[]
}

export const DEFAULT_PORT: Record<Exclude<Dialect, 'sqlite'>, number> = { postgres: 5432, mysql: 3306, mssql: 1433 }
export const MAX_ROWS = 5000
export const DEFAULT_ROWS = 500
export const MAX_CONCURRENT_DB = 4
export const DEFAULT_MASK = '*password*, *passwd*, *secret*, *token*, *api_key*, *apikey*, *ssn*'
export const MASKED = '[masked]'

const LOCAL = /^(localhost|127(\.\d+){3}|::1|\[::1\])$/i

export function isLocalHost(h: string): boolean {
  return LOCAL.test(h.trim())
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim())
const posInt = (v: unknown): number | undefined => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** A column-name pattern (* for anything) as a whole-name, case-insensitive match. */
export const maskPattern = (p: string): RegExp => new RegExp('^' + p.trim().split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')

/** The connection's settings, checked. Per-connection limits can only lower the connector's. */
export function dbSettings(dialect: Dialect, config: Record<string, unknown>, limits: { timeoutMs: number; maxResponseBytes: number }): DbSettings {
  const host = dialect === 'sqlite' ? '' : str(config.host)
  if (dialect !== 'sqlite' && !host) throw new Error('The connection has no host set.')
  if (host && !/^[A-Za-z0-9.\-:[\]_]+$/.test(host)) throw new Error('The host should be a name or address only, without a scheme, user or path.')
  const path = dialect === 'sqlite' ? str(config.path) : ''
  if (dialect === 'sqlite' && !path) throw new Error('The connection has no database file set.')
  const port = dialect === 'sqlite' ? 0 : (posInt(config.port) ?? DEFAULT_PORT[dialect])
  if (port > 65535) throw new Error('The port must be between 1 and 65535.')
  const local = !!host && isLocalHost(host)
  const tlsIn = str(config.tls).toLowerCase()
  const tls: TlsMode = tlsIn === 'off' || tlsIn === 'no-verify' || tlsIn === 'verify' ? tlsIn : local ? 'off' : 'verify'
  const maskText = (config.mask_columns === undefined ? DEFAULT_MASK : str(config.mask_columns))
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  return {
    dialect,
    host,
    port,
    database: str(config.database),
    user: str(config.user),
    tls,
    path,
    local,
    timeoutMs: Math.min(limits.timeoutMs, (posInt(config.timeout_seconds) ?? Infinity) * 1000),
    maxRows: Math.min(MAX_ROWS, posInt(config.max_rows) ?? DEFAULT_ROWS),
    maxBytes: Math.min(limits.maxResponseBytes, (posInt(config.max_response_kb) ?? Infinity) * 1024),
    maxConcurrent: Math.min(MAX_CONCURRENT_DB, posInt(config.max_concurrent) ?? MAX_CONCURRENT_DB),
    mask: maskText.map(maskPattern),
    maskText
  }
}

/** What the user should know before approving: weakened TLS, masking. */
export function dbWarnings(s: DbSettings): string[] {
  const out: string[] = []
  if (s.dialect === 'sqlite') return out
  if (s.tls === 'off' && !s.local) out.push(`Warning: TLS is off for ${s.host}, so the password and every result cross the network unencrypted.`)
  if (s.tls === 'no-verify') out.push(`Warning: the server's certificate is not checked for ${s.host}, so anyone in the middle could read the password.`)
  return out
}

/** One line for the approval dialog and the summary: where, as whom, and the masked columns. */
export function dbTargetText(s: DbSettings): string {
  if (s.dialect === 'sqlite') return `the SQLite file ${s.path}`
  return `database ${s.database || '(default)'} on ${s.host}:${s.port}${s.user ? ` as ${s.user}` : ''}`
}

export function maskingText(s: DbSettings): string {
  return s.maskText.length ? `Columns named like ${s.maskText.join(', ')} are shown as ${MASKED} (by name only, best effort).` : 'No columns are masked.'
}

// ---------- results ----------

export interface DbResult {
  columns: string[]
  rows: unknown[][]
  rows_returned: number
  rows_affected?: number
  truncated?: boolean
  notes?: string[]
}

/** Values JSON can carry: dates as ISO text, binary as a size, big numbers as text. */
export function plainValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString()
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `[binary, ${v.length} bytes]`
  if (typeof v === 'object') {
    try {
      return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))
    } catch {
      return String(v)
    }
  }
  return v
}

/**
 * Masks columns by name, keeps to the row cap (the caller passes how many more rows there were) and the size cap,
 * and says plainly what was cut.
 */
export function shapeResult(columns: string[], rows: unknown[][], more: number, s: Pick<DbSettings, 'mask' | 'maxRows' | 'maxBytes'>, affected?: number): DbResult {
  const masked = columns.map((c) => s.mask.some((r) => r.test(c)))
  let out = rows.slice(0, s.maxRows).map((r) => r.map((v, i) => (masked[i] && v !== null && v !== undefined ? MASKED : plainValue(v))))
  let extra = more + Math.max(0, rows.length - s.maxRows)
  const notes: string[] = []
  let size = JSON.stringify(out).length
  if (size > s.maxBytes) {
    let keep = out.length
    while (keep > 0 && size > s.maxBytes) {
      keep = Math.floor(keep * 0.8)
      size = JSON.stringify(out.slice(0, keep)).length
    }
    notes.push(`Cut to ${keep} rows to stay under ${Math.round(s.maxBytes / 1024)} KB.`)
    extra += out.length - keep
    out = out.slice(0, keep)
  }
  const r: DbResult = { columns, rows: out, rows_returned: out.length }
  if (affected !== undefined) r.rows_affected = affected
  if (extra > 0) {
    r.truncated = true
    notes.unshift(`Truncated: ${extra} more row${extra === 1 ? '' : 's'} not returned (limit ${s.maxRows}). Narrow the query or add a LIMIT.`)
  }
  if (masked.some(Boolean)) notes.push(`Masked columns: ${columns.filter((_c, i) => masked[i]).join(', ')}.`)
  if (notes.length) r.notes = notes
  return r
}

// ---------- describe ----------

const ident = /^[A-Za-z_][A-Za-z0-9_$]*$/

/** The read-only statement behind describe: tables, or one table's columns. Names are checked, never pasted raw. */
export function describeSql(d: Dialect, table?: string, schema?: string): { sql: string; params: unknown[] } {
  for (const [k, v] of [['table', table], ['schema', schema]] as const) if (v && !ident.test(v)) throw new Error(`The ${k} name "${v}" has characters describe does not accept; use plain names.`)
  if (d === 'sqlite') {
    if (!table) return { sql: "SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name", params: [] }
    return { sql: 'SELECT name, type, "notnull" AS not_null, pk FROM pragma_table_info(?) ORDER BY cid', params: [table] }
  }
  const p = (i: number): string => (d === 'postgres' ? `$${i}` : d === 'mssql' ? `@p${i}` : '?')
  if (!table) {
    const where = schema ? `table_schema = ${p(1)}` : d === 'postgres' ? "table_schema NOT IN ('pg_catalog','information_schema')" : d === 'mysql' ? 'table_schema = DATABASE()' : "table_schema <> 'sys' AND table_schema <> 'INFORMATION_SCHEMA'"
    return { sql: `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE ${where} ORDER BY table_schema, table_name`, params: schema ? [schema] : [] }
  }
  const where = [`table_name = ${p(1)}`, schema ? `table_schema = ${p(2)}` : d === 'mysql' ? 'table_schema = DATABASE()' : ''].filter(Boolean).join(' AND ')
  return { sql: `SELECT table_schema, column_name, data_type, is_nullable FROM information_schema.columns WHERE ${where} ORDER BY table_schema, ordinal_position`, params: schema ? [table, schema] : [table] }
}

/** A few rows of one table, for exploring. */
export function sampleSql(d: Dialect, table: string, n: number, schema?: string): string {
  for (const v of [table, schema]) if (v && !ident.test(v)) throw new Error(`"${v}" has characters sample_rows does not accept; use plain names.`)
  const q = (x: string): string => (d === 'mysql' ? `\`${x}\`` : d === 'mssql' ? `[${x}]` : `"${x}"`)
  const name = schema ? `${q(schema)}.${q(table)}` : q(table)
  return d === 'mssql' ? `SELECT TOP (${n}) * FROM ${name}` : `SELECT * FROM ${name} LIMIT ${n}`
}
