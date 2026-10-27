import { createHash } from 'node:crypto'
import { authSlots, effectiveAuth } from '@shared/httpAuth'

// The connector manifest standard (#87), described for people in docs/CONNECTORS.md. A manifest is data only:
// what a connector can reach, which operations it offers and how each is classed, its limits and the names of
// the secrets it needs. Never code, never a secret value. This file has no electron or app imports, so the
// validator and summary run in plain Node for the tests (scripts/test-connectors.mjs).

export const RUNTIMES = ['ssh', 'http', 'postgres', 'mysql', 'mssql', 'sqlite'] as const
export type Runtime = (typeof RUNTIMES)[number]
export type OpClass = 'read' | 'write' | 'admin'
export const OP_CLASSES: OpClass[] = ['read', 'write', 'admin']
export const SECRET_TYPES = ['password', 'passphrase', 'token', 'key', 'certificate'] as const
export const CONFIG_TYPES = ['string', 'number', 'boolean', 'host', 'path'] as const
export const MAX_MANIFEST_BYTES = 64 * 1024

/** A small JSON-schema subset for operation inputs and outputs. */
export interface DataSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
  description?: string
  properties?: Record<string, DataSchema>
  required?: string[]
  items?: DataSchema
  enum?: (string | number)[]
  maxLength?: number
  maximum?: number
  minimum?: number
}

export interface ConfigField {
  key: string
  label: string
  type: (typeof CONFIG_TYPES)[number]
  required?: boolean
  default?: string | number | boolean
  description?: string
}

/** A named place for a secret. The value lives in Corvid's encrypted store, never here. */
export interface SecretSlot {
  key: string
  label: string
  type: (typeof SECRET_TYPES)[number]
  optional?: boolean
}

/** Where a connector may connect. `host` is a fixed name; `hostFrom` takes it from a connection's config field. */
export interface Target {
  host?: string
  hostFrom?: string
  ports?: number[]
  portFrom?: string
  scheme?: string
  database?: string
}

export interface Operation {
  name: string
  description: string
  class: OpClass
  /** HTTP: the method and path pattern; databases: the statement kinds allowed */
  method?: string
  path?: string
  statements?: string[]
  /** a built-in classifier that may lower the class per call (ssh: plain inspection commands count as read) */
  classifier?: 'ssh-command'
  input?: DataSchema
  output?: DataSchema
}

export interface Limits {
  timeoutMs: number
  maxResponseBytes: number
  ratePerMinute?: number
  /** the largest file one upload may send (ssh only, #168) */
  maxUploadBytes?: number
}

export interface ScrubRules {
  /** response header or field names whose values are always masked */
  fields?: string[]
}

export interface ConnectorTest {
  name: string
  operation: string
  args?: Record<string, unknown>
  expect?: { ok?: boolean; contains?: string }
  /** for agent drafts (#92): what Corvid's local mock server answers for this test; never the real host */
  mock?: { status?: number; body?: unknown; contentType?: string }
}

export interface ConnectorManifest {
  manifestVersion: 1
  id: string
  name: string
  version: string
  description: string
  runtime: Runtime
  /** deliberately reaches many hosts or targets; the approval screen warns loudly */
  broad?: boolean
  config: ConfigField[]
  secrets: SecretSlot[]
  capabilities: { targets: Target[]; operations: Operation[] }
  limits: Limits
  scrub?: ScrubRules
  tests?: ConnectorTest[]
}

/** What capabilitySummary needs from a connection, so it can name the real host and saved secrets. */
export interface ConnectionLike {
  name?: string
  config?: Record<string, string | number | boolean | undefined>
  secretsSet?: Record<string, boolean>
}

// ---------- canonical form and hash ----------

/** JSON with keys sorted at every level and no whitespace: the same manifest always gives the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export const manifestHash = (m: unknown): string => 'sha256:' + createHash('sha256').update(canonical(m)).digest('hex')

// ---------- validation ----------

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const ID = /^[a-z][a-z0-9-]{1,47}$/
const KEY = /^[a-z][a-z0-9_]{0,39}$/
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

/** Anything that reads like program code, in any string of the manifest. */
const CODE = [
  /=>/,
  /\bfunction\s*\(/,
  /\b(require|import|eval)\s*\(/,
  /\bnew\s+Function\b/,
  /<script\b/i,
  /\bchild_process\b/,
  /\bprocess\.(env|exit|binding)\b/,
  /\$\{[^}]*\}/
]

/** Strings that look like a secret value someone pasted in. */
const SECRETISH = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|rk)[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(bearer|basic)\s+[A-Za-z0-9+/._=-]{16,}/i,
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
  /(password|passwd|pwd|secret|token|api[-_]?key)\s*[=:]\s*\S{4,}/i
]

/** A long unbroken run of letters and digits with high entropy, like a key or token. */
function looksRandom(s: string): boolean {
  for (const run of s.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) {
    const counts = new Map<string, number>()
    for (const ch of run) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    let h = 0
    for (const n of counts.values()) h -= (n / run.length) * Math.log2(n / run.length)
    if (h > 4) return true
  }
  return false
}

const FIELDS: Record<string, string[]> = {
  manifest: ['manifestVersion', 'id', 'name', 'version', 'description', 'runtime', 'broad', 'config', 'secrets', 'capabilities', 'limits', 'scrub', 'tests'],
  config: ['key', 'label', 'type', 'required', 'default', 'description'],
  secret: ['key', 'label', 'type', 'optional'],
  capabilities: ['targets', 'operations'],
  target: ['host', 'hostFrom', 'ports', 'portFrom', 'scheme', 'database'],
  operation: ['name', 'description', 'class', 'method', 'path', 'statements', 'classifier', 'input', 'output'],
  limits: ['timeoutMs', 'maxResponseBytes', 'ratePerMinute', 'maxUploadBytes'],
  scrub: ['fields'],
  test: ['name', 'operation', 'args', 'expect', 'mock'],
  expect: ['ok', 'contains'],
  mock: ['status', 'body', 'contentType'],
  schema: ['type', 'description', 'properties', 'required', 'items', 'enum', 'maxLength', 'maximum', 'minimum']
}

export type ValidationResult = { ok: true; manifest: ConnectorManifest; hash: string } | { ok: false; errors: string[] }

export function validateManifest(raw: unknown): ValidationResult {
  const errors: string[] = []
  const err = (s: string): void => void errors.push(s)
  let text: string
  try {
    text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    return { ok: false, errors: ['The manifest is not plain JSON data.'] }
  }
  if (Buffer.byteLength(text ?? '') > MAX_MANIFEST_BYTES) return { ok: false, errors: [`The manifest is larger than ${MAX_MANIFEST_BYTES / 1024} KB.`] }
  let m: any
  try {
    m = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(text)
  } catch {
    return { ok: false, errors: ['The manifest is not valid JSON.'] }
  }
  if (!isObj(m)) return { ok: false, errors: ['The manifest must be a JSON object.'] }

  const known = (o: Record<string, unknown>, kind: string, where: string): void => {
    for (const k of Object.keys(o)) if (!FIELDS[kind].includes(k)) err(`${where}: unknown field "${k}".`)
  }
  const str = (v: unknown, where: string, max = 500): v is string => {
    if (typeof v !== 'string' || !v.trim()) return (err(`${where} must be a non-empty string.`), false)
    if (v.length > max) return (err(`${where} is longer than ${max} characters.`), false)
    return true
  }

  known(m, 'manifest', 'manifest')
  if (m.manifestVersion !== 1) err('manifestVersion must be 1.')
  if (typeof m.id !== 'string' || !ID.test(m.id)) err('id must be 2-48 lowercase letters, digits or dashes, starting with a letter.')
  str(m.name, 'name', 80)
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) err('version must be a semantic version like 1.0.0.')
  str(m.description, 'description', 2000)
  if (!RUNTIMES.includes(m.runtime)) err(`runtime must be one of ${RUNTIMES.join(', ')}.`)
  if (m.broad !== undefined && typeof m.broad !== 'boolean') err('broad must be true or false.')

  const configKeys = new Set<string>()
  if (!Array.isArray(m.config)) err('config must be a list (it may be empty).')
  else
    m.config.forEach((f: any, i: number) => {
      const w = `config[${i}]`
      if (!isObj(f)) return err(`${w} must be an object.`)
      known(f, 'config', w)
      if (typeof f.key !== 'string' || !KEY.test(f.key)) err(`${w}.key must be a lowercase identifier.`)
      else if (configKeys.has(f.key)) err(`${w}.key "${f.key}" is used twice.`)
      else configKeys.add(f.key)
      str(f.label, `${w}.label`, 80)
      if (!CONFIG_TYPES.includes(f.type)) err(`${w}.type must be one of ${CONFIG_TYPES.join(', ')}.`)
      if (f.default !== undefined && !['string', 'number', 'boolean'].includes(typeof f.default)) err(`${w}.default must be a plain value.`)
    })

  const slotKeys = new Set<string>()
  if (!Array.isArray(m.secrets)) err('secrets must be a list (it may be empty).')
  else
    m.secrets.forEach((s: any, i: number) => {
      const w = `secrets[${i}]`
      if (!isObj(s)) return err(`${w} must be an object.`)
      if ('value' in s || 'default' in s) err(`${w} holds a value: a manifest names secret slots only, never their values.`)
      known(s, 'secret', w)
      if (typeof s.key !== 'string' || !KEY.test(s.key)) err(`${w}.key must be a lowercase identifier.`)
      else if (slotKeys.has(s.key) || configKeys.has(s.key)) err(`${w}.key "${s.key}" is used twice.`)
      else slotKeys.add(s.key)
      str(s.label, `${w}.label`, 80)
      if (!SECRET_TYPES.includes(s.type)) err(`${w}.type must be one of ${SECRET_TYPES.join(', ')}.`)
    })

  const caps = m.capabilities
  const opNames = new Set<string>()
  if (!isObj(caps)) err('capabilities must be an object with targets and operations.')
  else {
    known(caps, 'capabilities', 'capabilities')
    if (!Array.isArray(caps.targets) || !caps.targets.length) {
      if (!m.broad) err('capabilities.targets must list at least one host or target (or set "broad": true on purpose).')
    } else
      caps.targets.forEach((t: any, i: number) => {
        const w = `capabilities.targets[${i}]`
        if (!isObj(t)) return err(`${w} must be an object.`)
        known(t, 'target', w)
        if (t.host === undefined && t.hostFrom === undefined && t.database === undefined) err(`${w} needs a host, hostFrom or database.`)
        if (t.host !== undefined) {
          const wild = typeof t.host !== 'string' || /[*?]/.test(t.host) || ['0.0.0.0', '::', 'any', 'all'].includes(t.host.toLowerCase())
          if (wild && !m.broad) err(`${w}.host is a wildcard; name the hosts, or set "broad": true on purpose.`)
          else if (!wild && !HOST.test(t.host) && !IPV4.test(t.host)) err(`${w}.host "${t.host}" is not a host name.`)
        }
        if (t.hostFrom !== undefined && !configKeys.has(t.hostFrom)) err(`${w}.hostFrom must name a config field.`)
        if (t.portFrom !== undefined && !configKeys.has(t.portFrom)) err(`${w}.portFrom must name a config field.`)
        if (t.ports !== undefined && (!Array.isArray(t.ports) || t.ports.some((p: unknown) => !Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535)))
          err(`${w}.ports must be a list of port numbers.`)
        if (t.scheme !== undefined && !/^[a-z][a-z0-9+.-]{0,15}$/.test(String(t.scheme))) err(`${w}.scheme is not a scheme name.`)
      })
    if (!Array.isArray(caps.operations) || !caps.operations.length) err('capabilities.operations must list at least one operation.')
    else
      caps.operations.forEach((o: any, i: number) => {
        const w = `capabilities.operations[${i}]`
        if (!isObj(o)) return err(`${w} must be an object.`)
        known(o, 'operation', w)
        if (typeof o.name !== 'string' || !KEY.test(o.name)) err(`${w}.name must be a lowercase identifier.`)
        else if (opNames.has(o.name)) err(`${w}.name "${o.name}" is used twice.`)
        else opNames.add(o.name)
        str(o.description, `${w}.description`, 500)
        if (!OP_CLASSES.includes(o.class)) err(`${w}.class must be read, write or admin.`)
        if (o.method !== undefined && !METHODS.includes(o.method)) err(`${w}.method must be one of ${METHODS.join(', ')}.`)
        if (o.path !== undefined && (typeof o.path !== 'string' || !o.path.startsWith('/'))) err(`${w}.path must start with /.`)
        if (o.statements !== undefined && (!Array.isArray(o.statements) || o.statements.some((s: unknown) => typeof s !== 'string' || !/^[A-Z ]{2,30}$/.test(s as string))))
          err(`${w}.statements must be statement kinds like SELECT or INSERT.`)
        if (o.classifier !== undefined && o.classifier !== 'ssh-command') err(`${w}.classifier must be a built-in classifier (ssh-command).`)
        if (o.input !== undefined) checkSchema(o.input, `${w}.input`, err, 0)
        if (o.output !== undefined) checkSchema(o.output, `${w}.output`, err, 0)
      })
  }

  const lim = m.limits
  if (!isObj(lim)) err('limits must be an object with timeoutMs and maxResponseBytes.')
  else {
    known(lim, 'limits', 'limits')
    if (!Number.isInteger(lim.timeoutMs) || lim.timeoutMs < 100 || lim.timeoutMs > 600_000) err('limits.timeoutMs must be between 100 and 600000.')
    if (!Number.isInteger(lim.maxResponseBytes) || lim.maxResponseBytes < 1 || lim.maxResponseBytes > 50 * 1024 * 1024) err('limits.maxResponseBytes must be between 1 and 50 MB.')
    if (lim.ratePerMinute !== undefined && (!Number.isInteger(lim.ratePerMinute) || lim.ratePerMinute < 1 || lim.ratePerMinute > 6000)) err('limits.ratePerMinute must be between 1 and 6000.')
    if (lim.maxUploadBytes !== undefined && (!Number.isInteger(lim.maxUploadBytes) || lim.maxUploadBytes < 1 || lim.maxUploadBytes > 50 * 1024 * 1024)) err('limits.maxUploadBytes must be between 1 and 50 MB.')
  }
  if (m.scrub !== undefined) {
    if (!isObj(m.scrub)) err('scrub must be an object.')
    else {
      known(m.scrub, 'scrub', 'scrub')
      if (m.scrub.fields !== undefined && (!Array.isArray(m.scrub.fields) || m.scrub.fields.some((f: unknown) => typeof f !== 'string' || (f as string).length > 100)))
        err('scrub.fields must be a list of names.')
    }
  }
  if (m.tests !== undefined) {
    if (!Array.isArray(m.tests)) err('tests must be a list.')
    else
      m.tests.forEach((t: any, i: number) => {
        const w = `tests[${i}]`
        if (!isObj(t)) return err(`${w} must be an object.`)
        known(t, 'test', w)
        str(t.name, `${w}.name`, 120)
        if (!opNames.has(t.operation)) err(`${w}.operation must name one of the operations.`)
        if (t.args !== undefined && !isObj(t.args)) err(`${w}.args must be an object.`)
        if (t.expect !== undefined) isObj(t.expect) ? known(t.expect, 'expect', `${w}.expect`) : err(`${w}.expect must be an object.`)
        if (t.mock !== undefined) {
          if (!isObj(t.mock)) err(`${w}.mock must be an object.`)
          else {
            known(t.mock, 'mock', `${w}.mock`)
            if (t.mock.status !== undefined && (!Number.isInteger(t.mock.status) || t.mock.status < 100 || t.mock.status > 599)) err(`${w}.mock.status must be an HTTP status code.`)
            if (t.mock.contentType !== undefined && (typeof t.mock.contentType !== 'string' || t.mock.contentType.length > 100)) err(`${w}.mock.contentType must be a content type.`)
          }
        }
      })
  }

  // every string anywhere: no code, nothing that looks like a secret value
  walkStrings(m, '', (s, where) => {
    if (looksLikeCode(s)) err(`${where || 'manifest'} looks like code; a manifest is data only.`)
    if (looksLikeSecret(s)) err(`${where || 'manifest'} looks like a secret value; manifests name secret slots, never values.`)
  })

  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, manifest: m as ConnectorManifest, hash: manifestHash(m) }
}

/** The validator's own checks for one string, also used on an agent's reason for a draft (#92). */
export const looksLikeCode = (s: string): boolean => CODE.some((r) => r.test(s))
export const looksLikeSecret = (s: string): boolean => SECRETISH.some((r) => r.test(s)) || looksRandom(s)

function checkSchema(s: any, where: string, err: (e: string) => void, depth: number): void {
  if (depth > 8) return err(`${where} is nested too deeply.`)
  if (!isObj(s)) return err(`${where} must be a schema object.`)
  for (const k of Object.keys(s)) if (!FIELDS.schema.includes(k)) err(`${where}: unknown field "${k}".`)
  if (!['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(s.type)) err(`${where}.type is not a JSON type.`)
  if (s.properties !== undefined) {
    if (!isObj(s.properties)) err(`${where}.properties must be an object.`)
    else for (const [k, v] of Object.entries(s.properties)) checkSchema(v, `${where}.properties.${k}`, err, depth + 1)
  }
  if (s.items !== undefined) checkSchema(s.items, `${where}.items`, err, depth + 1)
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r: unknown) => typeof r !== 'string'))) err(`${where}.required must be a list of names.`)
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

function walkStrings(v: unknown, where: string, f: (s: string, where: string) => void): void {
  if (typeof v === 'string') f(v, where)
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${where}[${i}]`, f))
  else if (isObj(v))
    for (const [k, x] of Object.entries(v)) {
      f(k, where ? `${where}.${k}` : k)
      walkStrings(x, where ? `${where}.${k}` : k, f)
    }
}

// ---------- plain-language summary ----------

const RUNTIME_TEXT: Record<Runtime, string> = {
  ssh: 'over SSH, running shell commands',
  http: 'over HTTPS',
  postgres: 'as a PostgreSQL database',
  mysql: 'as a MySQL database',
  mssql: 'as a SQL Server database',
  sqlite: 'as a SQLite database file'
}

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** The hosts or databases in words, using the connection's settings when there is one. */
export function targetsText(m: ConnectorManifest, c?: ConnectionLike): string[] {
  return m.capabilities.targets.map((t) => {
    const host = t.host ?? (t.hostFrom ? (c?.config?.[t.hostFrom] !== undefined ? String(c.config[t.hostFrom]) : `the host set in each connection`) : undefined)
    const port = t.portFrom && c?.config?.[t.portFrom] !== undefined ? [Number(c.config[t.portFrom])] : t.ports
    const where = [t.database ? `database ${t.database}` : '', host ? `${host}${port?.length ? ` (port ${port.join(', ')})` : ''}` : ''].filter(Boolean).join(' on ')
    return where || 'an unnamed target'
  })
}

export function operationText(o: Operation): string {
  const what = o.method || o.path ? `${o.method ?? ''} ${o.path ?? ''}`.trim() : o.statements?.length ? o.statements.join('/') : ''
  return `${o.name}${what ? ` (${what})` : ''}`
}

/**
 * The one description of what a connector can do, shown when it asks for approval and on the Connections tab.
 * With a connection it names the real host and the labels of the secrets saved for it.
 */
/** The secret slots a connection uses: for http only those its sign-in method needs (#103), else all of them. */
export function secretsInUse(m: ConnectorManifest, c?: ConnectionLike): SecretSlot[] {
  if (m.runtime !== 'http' || !c?.config) return m.secrets
  const used = authSlots(effectiveAuth(c.config, m.config, m.secrets.map((s) => s.key)))
  return m.secrets.filter((s) => used.has(s.key))
}

export function capabilitySummary(m: ConnectorManifest, c?: ConnectionLike): string {
  const ops = m.capabilities.operations
  const classes = new Set(ops.map((o) => o.class))
  const targets = targetsText(m, c)
  const parts: string[] = []
  parts.push(
    m.broad
      ? `Warning: this connector is marked broad, so it is not limited to named hosts. It can reach ${targets.length ? list(targets) + ' and other places' : 'any host'} ${RUNTIME_TEXT[m.runtime]}.`
      : `This connector can reach ${list(targets)} ${RUNTIME_TEXT[m.runtime]}.`
  )
  const byClass = (k: OpClass): string[] => ops.filter((o) => o.class === k).map(operationText)
  const opParts = OP_CLASSES.filter((k) => classes.has(k)).map((k) => `${k === 'admin' ? 'administer' : k}: ${list(byClass(k))}`)
  parts.push(`Operations it offers, by what they do: ${opParts.join('; ')}.`)
  if (ops.some((o) => o.classifier === 'ssh-command')) parts.push('Commands Corvid recognises as plain inspection count as reads; anything else counts as a change.')
  const inUse = secretsInUse(m, c)
  if (m.runtime === 'http' && c?.config && !inUse.length) parts.push(`It calls ${list(targets)} without sending any credentials.`)
  else if (inUse.length) {
    const slots = inUse.map((s) => {
      const set = c?.secretsSet?.[s.key]
      return `the ${s.type} you saved as '${s.label}'${c ? (set ? '' : ' (not set yet)') : ''}${s.optional ? ' when there is one' : ''}`
    })
    parts.push(`It authenticates with ${list(slots)}. Agents never see these; Corvid uses them for the agent.`)
  } else parts.push('It uses no saved secrets.')
  parts.push(
    classes.has('admin')
      ? 'It can read data, change data and make administrative changes.'
      : classes.has('write')
        ? 'It can read and change data.'
        : 'It can only read data.'
  )
  parts.push(`Each call is limited to ${Math.round(m.limits.timeoutMs / 1000)} s and ${fmtBytes(m.limits.maxResponseBytes)} of response${m.limits.ratePerMinute ? `, at most ${m.limits.ratePerMinute} calls a minute` : ''}.`)
  return parts.join(' ')
}

const fmtBytes = (n: number): string => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`)
