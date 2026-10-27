import type { ConfigField, ConnectorManifest, DataSchema } from './manifest'
import { DEFAULT_MASK, DEFAULT_ROWS, MAX_CONCURRENT_DB, MAX_ROWS } from './sqlRules'

// Connectors that ship with Corvid: SSH, HTTP and the databases.

export const SSH_CONNECTOR: ConnectorManifest = {
  manifestVersion: 1,
  id: 'ssh',
  name: 'SSH server',
  version: '1.1.0',
  description:
    'Runs shell commands on a server you added, over SSH, with the password or key you saved for it, and uploads single files to it over SFTP. Host keys are remembered on first connect and checked every time after.',
  runtime: 'ssh',
  config: [
    { key: 'host', label: 'Host', type: 'host', required: true },
    { key: 'port', label: 'Port', type: 'number', default: 22 },
    { key: 'user', label: 'User', type: 'string', required: true },
    { key: 'auth', label: 'Sign in with', type: 'string', default: 'key' },
    { key: 'key_path', label: 'Private key file', type: 'path' }
  ],
  secrets: [
    { key: 'password', label: 'Password', type: 'password', optional: true },
    { key: 'passphrase', label: 'Key passphrase', type: 'passphrase', optional: true }
  ],
  capabilities: {
    targets: [{ hostFrom: 'host', portFrom: 'port', scheme: 'ssh' }],
    operations: [
      {
        name: 'run',
        description: 'Run one shell command and return its exit code and output. Plain inspection commands count as reads; anything else as a change.',
        class: 'write',
        classifier: 'ssh-command',
        input: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'the exact command to run', maxLength: 20000 },
            timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 }
          },
          required: ['command']
        },
        output: { type: 'string', description: 'exit code, stdout and stderr, with known secrets masked' }
      },
      {
        name: 'run_as_root',
        description: 'Run one command with sudo. Always counted as administrative.',
        class: 'admin',
        input: { type: 'object', properties: { command: { type: 'string', maxLength: 20000 } }, required: ['command'] }
      },
      {
        // #168: no root variant on purpose; the file lands with the connection user's permissions
        name: 'upload',
        description:
          "Send one file from your own worktree or session scratchpad to a path on the server, over SFTP, as the connection's user. The bytes go straight from disk to the server. Refused: anything outside those folders, files the deny rules cover, keys and files that hold secrets, folders (tar them first) and files over the size limit. An existing file is only replaced with overwrite: true.",
        class: 'write',
        input: {
          type: 'object',
          properties: {
            local_path: { type: 'string', description: 'the file to send, inside your worktree or scratchpad', maxLength: 4096 },
            remote_path: { type: 'string', description: 'absolute path on the server, including the file name, like /tmp/upload/app.tar.gz', maxLength: 4096 },
            overwrite: { type: 'boolean', description: 'replace the file if it exists (default false)' },
            mode: { type: 'string', description: 'octal permissions to set afterwards, like "0644"' }
          },
          required: ['local_path', 'remote_path']
        },
        output: { type: 'object', description: 'remote_path, bytes written, sha256 of what was sent, replaced' }
      }
    ]
  },
  limits: { timeoutMs: 600_000, maxResponseBytes: 512 * 1024, maxUploadBytes: 50 * 1024 * 1024 }
}

/**
 * The generic HTTP API connector (#89). One connection per API: its base URL, how Corvid attaches the credential,
 * and which methods and paths are allowed. The runtime is http.ts; the rules it enforces are in httpRules.ts.
 */
export const HTTP_CONNECTOR: ConnectorManifest = {
  manifestVersion: 1,
  id: 'http-api',
  name: 'HTTP API',
  version: '1.0.0',
  description:
    'Calls a web API (REST, webhooks, cloud and SaaS APIs) at the base URL you set, with the API key, token or password you saved. Corvid adds the credential to each request itself, refuses other hosts and private addresses, and returns status, a few headers and a text or JSON body.',
  runtime: 'http',
  config: [
    { key: 'base_url', label: 'Base URL', type: 'string', required: true, description: 'Where every request goes, like https://api.example.com/v1. Agents give only the path after it.' },
    {
      key: 'auth',
      label: 'Attach the credential as',
      type: 'string',
      default: 'bearer',
      description: 'bearer (Authorization: Bearer, the Token slot), basic (user name and the Password slot), header (the API key slot in a header you name), query (the API key slot as a query parameter), oauth2 (client credentials), or none. Several can be combined with commas.'
    },
    { key: 'username', label: 'User name (for basic)', type: 'string' },
    { key: 'auth_header', label: 'Header name (for header)', type: 'string', default: 'X-API-Key' },
    { key: 'auth_query', label: 'Query parameter name (for query)', type: 'string', default: 'api_key' },
    { key: 'token_url', label: 'Token URL (for oauth2)', type: 'string', description: 'On the base host or one of the extra hosts.' },
    { key: 'client_id', label: 'Client id (for oauth2)', type: 'string' },
    { key: 'scope', label: 'Scope (for oauth2)', type: 'string' },
    { key: 'oauth_send', label: 'Send the client secret as (for oauth2)', type: 'string', default: 'basic', description: 'basic (an Authorization header) or body (form fields).' },
    { key: 'allowed_methods', label: 'Allowed methods', type: 'string', default: 'GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE' },
    { key: 'allowed_paths', label: 'Allowed paths', type: 'string', default: '/**', description: 'Path patterns, comma separated. * is one segment, ** any number.' },
    { key: 'admin_paths', label: 'Administrative paths', type: 'string', default: '/admin, /billing', description: 'Requests under these always ask, whatever the safety level.' },
    { key: 'extra_hosts', label: 'Extra hosts for redirects', type: 'string', description: 'Hosts a redirect may go to. The credential is never sent to them.' },
    { key: 'test_path', label: 'Test connection path', type: 'string', default: '/', description: 'A safe GET used by Test connection.' },
    { key: 'local', label: 'Local or internal service', type: 'boolean', default: false, description: 'Allows private, loopback and link-local addresses, and plain http. Leave off for internet APIs.' },
    { key: 'insecure_tls', label: 'Skip certificate checks', type: 'boolean', default: false, description: 'Only for your own internal service with a self-signed certificate. Anyone in the middle could read the credential.' },
    { key: 'keep_cookies', label: 'Keep cookies between calls', type: 'boolean', default: false }
  ],
  secrets: [
    { key: 'token', label: 'Bearer token', type: 'token', optional: true },
    { key: 'api_key', label: 'API key', type: 'token', optional: true },
    { key: 'password', label: 'Password', type: 'password', optional: true },
    { key: 'client_secret', label: 'OAuth2 client secret', type: 'token', optional: true }
  ],
  capabilities: {
    targets: [{ hostFrom: 'base_url', scheme: 'https' }],
    operations: [
      {
        name: 'request',
        description:
          'Send one request to the API: a method and a path under the base URL, with optional query, headers and a JSON or text body. GET, HEAD and OPTIONS are reads; POST, PUT, PATCH and DELETE are changes; administrative paths always ask.',
        class: 'write',
        input: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            path: { type: 'string', description: 'path under the base URL, starting with /, like /v1/orders', maxLength: 4000 },
            query: { type: 'object', description: 'query parameters, name to value' },
            headers: { type: 'object', description: 'extra non-sensitive headers; Corvid sets the credential and drops Authorization, Host, Cookie and similar' },
            body: { type: 'object', description: 'a JSON value, or a string for a text body' }
          },
          required: ['path']
        },
        output: { type: 'object', description: 'status, ok, url, a few response headers, body (JSON or text), truncated, notes' }
      }
    ]
  },
  limits: { timeoutMs: 30_000, maxResponseBytes: 1024 * 1024, ratePerMinute: 60 }
}

const DB_NAMES = { postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', mssql: 'SQL Server', sqlite: 'SQLite file' } as const
const DB_PORTS = { postgres: 5432, mysql: 3306, mssql: 1433 } as const

const sqlInput = (what: string): DataSchema => ({
  type: 'object',
  properties: {
    sql: { type: 'string', description: what, maxLength: 100000 },
    params: { type: 'array', description: 'values for placeholders ($1 in PostgreSQL, ? in MySQL and SQLite, @p1 in SQL Server)' }
  },
  required: ['sql']
})

/**
 * The database connectors (#90). One connection per database: where it is, the user, TLS, what the connection
 * allows (read, read-write or admin) and which columns are masked. Corvid classifies every statement itself; the
 * runtime is db.ts and the rules are in sqlRules.ts.
 */
function dbConnector(d: keyof typeof DB_NAMES): ConnectorManifest {
  const net = d !== 'sqlite'
  const netFields: ConfigField[] = [
    { key: 'host', label: 'Host', type: 'host', required: true, description: 'Name or address only, like db.example.com or 127.0.0.1.' },
    { key: 'port', label: 'Port', type: 'number', default: d === 'sqlite' ? 0 : DB_PORTS[d] },
    { key: 'database', label: 'Database', type: 'string', required: d !== 'mysql' },
    { key: 'user', label: 'User name', type: 'string', required: true, description: 'Best a user made for agents, with the least privileges that work.' },
    {
      key: 'tls',
      label: 'TLS',
      type: 'string',
      description:
        'verify (the default for remote hosts: encrypted, certificate checked), no-verify (encrypted, certificate not checked: anyone in the middle could read the password), off (the default for localhost only; unencrypted).'
    }
  ]
  const fileFields: ConfigField[] = [{ key: 'path', label: 'Database file', type: 'path', required: true, description: 'An existing SQLite file. Agents cannot open any other file.' }]
  return {
    manifestVersion: 1,
    id: d,
    name: DB_NAMES[d],
    version: '1.0.0',
    description: net
      ? `Runs SQL on a ${DB_NAMES[d]} database with the password you saved; agents never see it. Corvid classifies every statement itself, runs reads in a read-only transaction that is rolled back, refuses file, program and other-server access, and returns at most a set number of rows. Best practice: give agents their own database user with the least privileges that work (read-only where you can).`
      : 'Runs SQL on a SQLite database file you pick. Reads open the file read-only. Corvid classifies every statement itself, refuses ATTACH and extensions, and returns at most a set number of rows.',
    runtime: d,
    config: [
      ...(net ? netFields : fileFields),
      {
        key: 'access',
        label: 'Agents may',
        type: 'string',
        default: 'read-write',
        description: 'read (queries only), read-write (also insert, update, delete) or admin (also schema, users and grants; always asks). Anything above this is refused.'
      },
      {
        key: 'mask_columns',
        label: 'Masked columns',
        type: 'string',
        default: DEFAULT_MASK,
        description: 'Column names whose values are replaced with [masked] before an agent sees them; * matches anything. By name only, so best effort.'
      },
      { key: 'max_rows', label: 'Most rows per call', type: 'number', default: DEFAULT_ROWS, description: `At most ${MAX_ROWS}.` },
      { key: 'timeout_seconds', label: 'Statement timeout (seconds)', type: 'number', default: 30 },
      { key: 'max_response_kb', label: 'Largest response (KB)', type: 'number', default: 1024 },
      { key: 'max_concurrent', label: 'Calls at once', type: 'number', default: MAX_CONCURRENT_DB }
    ],
    secrets: net
      ? [
          { key: 'password', label: 'Database password', type: 'password', optional: true },
          { key: 'ca_certificate', label: 'CA certificate (PEM), for a private certificate authority', type: 'certificate', optional: true }
        ]
      : [],
    capabilities: {
      targets: [net ? { hostFrom: 'host', portFrom: 'port', scheme: d } : { hostFrom: 'path', scheme: 'file' }],
      operations: [
        {
          name: 'query',
          description: 'Run statements that only read (SELECT, WITH, SHOW, EXPLAIN). They run in a read-only transaction that is rolled back.',
          class: 'read',
          statements: ['SELECT'],
          input: sqlInput('one or more read-only statements')
        },
        {
          name: 'describe',
          description: "List tables (no args), or one table's columns (table, optional schema).",
          class: 'read',
          input: { type: 'object', properties: { table: { type: 'string' }, schema: { type: 'string' } } }
        },
        {
          name: 'sample_rows',
          description: 'A few rows of one table (table, optional schema, limit up to 20).',
          class: 'read',
          input: { type: 'object', properties: { table: { type: 'string' }, schema: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['table'] }
        },
        {
          name: 'execute',
          description: 'Insert, update, delete or merge rows. Committed when every statement succeeds, rolled back otherwise.',
          class: 'write',
          statements: ['INSERT', 'UPDATE', 'DELETE', 'MERGE'],
          input: sqlInput('statements that change data')
        },
        {
          name: 'admin',
          description: 'Schema, users, grants, procedures and settings (DDL, GRANT, CALL). Always asks the user.',
          class: 'admin',
          statements: ['DDL', 'GRANT', 'CALL'],
          input: sqlInput('administrative statements')
        }
      ]
    },
    limits: { timeoutMs: 120_000, maxResponseBytes: 4 * 1024 * 1024 }
  }
}

export const DB_CONNECTORS: ConnectorManifest[] = (['postgres', 'mysql', 'mssql', 'sqlite'] as const).map(dbConnector)

export const BUILTIN_CONNECTORS: ConnectorManifest[] = [SSH_CONNECTOR, HTTP_CONNECTOR, ...DB_CONNECTORS]
