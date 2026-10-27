import { BlockList, isIP } from 'node:net'
import type { ConnectorManifest, OpClass, Operation } from './manifest'

// The rules of the http runtime (#89) that need no network: which addresses are private, how a request is built
// from the agent's arguments without ever changing the host, which headers an agent may send, path patterns, and
// how a call is classed. No electron or store imports, so the tests run them directly. The runtime is http.ts.

export const READ_METHODS = ['GET', 'HEAD', 'OPTIONS']
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']
export const MAX_REQUEST_BYTES = 1024 * 1024
export const MAX_CONCURRENT = 4
export const MAX_REDIRECTS = 5
export const CREDENTIAL_MASK = '[credential added by Corvid]'
export const AUTH_KINDS = ['bearer', 'basic', 'header', 'query', 'oauth2', 'none'] as const
export type AuthKind = (typeof AUTH_KINDS)[number]

// ---------- addresses ----------

/** Never reachable, not even for a connection marked local: cloud metadata services. */
const metadata = new BlockList()
metadata.addAddress('169.254.169.254', 'ipv4')
metadata.addAddress('100.100.100.200', 'ipv4')
metadata.addAddress('fd00:ec2::254', 'ipv6')

/** Unspecified, broadcast and multicast: nothing a connection should ever talk to. */
const never = new BlockList()
never.addSubnet('0.0.0.0', 8, 'ipv4')
never.addSubnet('224.0.0.0', 4, 'ipv4')
never.addSubnet('240.0.0.0', 4, 'ipv4')
never.addAddress('::', 'ipv6')
never.addSubnet('ff00::', 8, 'ipv6')

/** Loopback, private, link-local, shared and reserved ranges: allowed only on a connection marked local. */
const internal = new BlockList()
for (const [a, n] of [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24]
] as const)
  internal.addSubnet(a, n, 'ipv4')
for (const [a, n] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['100::', 64],
  ['2001:db8::', 32],
  // NAT64 and 6to4 wrap an IPv4 address that could be anything
  ['64:ff9b::', 96],
  ['2002::', 16]
] as const)
  internal.addSubnet(a, n, 'ipv6')

/** An IPv4 address hidden in an IPv6 one (::ffff:127.0.0.1, ::127.0.0.1), or null. */
function embeddedV4(ip: string): string | null {
  const m = ip.toLowerCase().match(/^(?:0*:)*:(?:ffff(?::0+)?:)?((?:\d{1,3}\.){3}\d{1,3})$/)
  if (m) return m[1]
  const hex = ip.toLowerCase().match(/^(?:0*:)*:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const a = parseInt(hex[1], 16)
    const b = parseInt(hex[2], 16)
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`
  }
  return null
}

export type AddressKind = 'public' | 'internal' | 'metadata' | 'never'

export function addressKind(ip: string): AddressKind {
  const v4 = isIP(ip) === 6 ? embeddedV4(ip) : null
  if (v4) return addressKind(v4)
  const type = isIP(ip) === 4 ? 'ipv4' : isIP(ip) === 6 ? 'ipv6' : null
  if (!type) return 'never'
  if (metadata.check(ip, type)) return 'metadata'
  if (never.check(ip, type)) return 'never'
  if (internal.check(ip, type)) return 'internal'
  return 'public'
}

/** Why an address may not be used, or null when it may. */
export function addressRefusal(ip: string, local: boolean): string | null {
  const k = addressKind(ip)
  if (k === 'public') return null
  if (k === 'internal' && local) return null
  if (k === 'metadata') return `${ip} is a cloud metadata address, which no connection may reach.`
  if (k === 'never') return `${ip} is not an address a connection may reach.`
  return `${ip} is a private, loopback or link-local address. Only a connection the user marked as a local or internal service may reach those.`
}

// ---------- the connection's settings ----------

export interface HttpSettings {
  base: URL
  /** the base path without a trailing slash ('' for the root) */
  basePath: string
  auth: AuthKind[]
  username: string
  authHeader: string
  authQuery: string
  tokenUrl?: URL
  clientId: string
  scope: string
  oauthSend: 'basic' | 'body'
  /** hosts a redirect may go to (never with the credential); the manifest's fixed hosts and the user's extras */
  extraHosts: string[]
  methods: string[]
  allowedPaths: string[]
  adminPaths: string[]
  testPath: string
  local: boolean
  insecureTls: boolean
  keepCookies: boolean
}

const listOf = (v: unknown): string[] =>
  String(v ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)

/** A config value, or the manifest's default for it. */
export function configValue(m: ConnectorManifest, config: Record<string, unknown>, key: string): unknown {
  const v = config[key]
  if (v !== undefined && v !== '') return v
  return m.config.find((f) => f.key === key)?.default
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Reads a connection's settings; throws a plain message for a setting that can't work. */
export function httpSettings(m: ConnectorManifest, config: Record<string, unknown>): HttpSettings {
  const get = (k: string): unknown => configValue(m, config, k)
  const fixed = m.capabilities.targets.find((t) => t.host)
  const raw = get('base_url') ?? (fixed ? `${fixed.scheme === 'http' ? 'http' : 'https'}://${fixed.host}${fixed.ports?.length && ![80, 443].includes(fixed.ports[0]) ? `:${fixed.ports[0]}` : ''}` : undefined)
  if (!raw) throw new Error('This connection has no base URL.')
  let base: URL
  try {
    base = new URL(String(raw))
  } catch {
    throw new Error('The base URL of this connection is not a valid URL.')
  }
  const local = get('local') === true || get('local') === 'true'
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('The base URL must start with https://.')
  if (base.protocol === 'http:' && !local) throw new Error('The base URL uses plain http, which is only allowed on a connection marked as a local or internal service.')
  if (base.username || base.password) throw new Error('The base URL must not hold a user name or password; save those as secrets.')
  if (base.search || base.hash) throw new Error('The base URL must not have a query or fragment.')
  const auth = listOf(get('auth') ?? inferAuth(m)).map((a) => a.toLowerCase()) as AuthKind[]
  for (const a of auth) if (!AUTH_KINDS.includes(a)) throw new Error(`Unknown way to attach the credential: ${a}. Use ${AUTH_KINDS.join(', ')}.`)
  const authHeader = String(get('auth_header') ?? 'X-API-Key')
  if (!TOKEN.test(authHeader) || (FORBIDDEN_HEADERS.has(authHeader.toLowerCase()) && authHeader.toLowerCase() !== 'authorization'))
    throw new Error(`${authHeader} can't carry the credential; choose another header name.`)
  let tokenUrl: URL | undefined
  if (auth.includes('oauth2')) {
    try {
      tokenUrl = new URL(String(get('token_url') ?? ''))
    } catch {
      throw new Error('OAuth2 needs a token URL.')
    }
    if (tokenUrl.protocol !== 'https:' && !(tokenUrl.protocol === 'http:' && local)) throw new Error('The token URL must use https.')
    if (tokenUrl.username || tokenUrl.password) throw new Error('The token URL must not hold a user name or password.')
  }
  const extraHosts = [...new Set([...m.capabilities.targets.flatMap((t) => (t.host ? [t.host.toLowerCase()] : [])), ...listOf(get('extra_hosts')).map((h) => h.toLowerCase())])].filter(
    (h) => h !== base.hostname.toLowerCase()
  )
  if (tokenUrl && tokenUrl.hostname !== base.hostname && !extraHosts.includes(tokenUrl.hostname.toLowerCase()))
    throw new Error(`The token URL's host ${tokenUrl.hostname} must be the base host or one of the extra hosts.`)
  const methods = listOf(get('allowed_methods') ?? [...READ_METHODS, ...WRITE_METHODS].join(',')).map((x) => x.toUpperCase())
  const send = String(get('oauth_send') ?? 'basic')
  return {
    base,
    basePath: base.pathname.replace(/\/+$/, ''),
    auth,
    username: String(get('username') ?? ''),
    authHeader,
    authQuery: String(get('auth_query') ?? 'api_key'),
    tokenUrl,
    clientId: String(get('client_id') ?? ''),
    scope: String(get('scope') ?? ''),
    oauthSend: send === 'body' ? 'body' : 'basic',
    extraHosts,
    methods,
    allowedPaths: listOf(get('allowed_paths') ?? '/**'),
    adminPaths: listOf(get('admin_paths')),
    testPath: String(get('test_path') ?? '/'),
    local,
    insecureTls: get('insecure_tls') === true || get('insecure_tls') === 'true',
    keepCookies: get('keep_cookies') === true || get('keep_cookies') === 'true'
  }
}

/** A manifest without an auth setting: the credential's kind follows from its secret slots. */
function inferAuth(m: ConnectorManifest): string {
  const slots = m.secrets.map((x) => x.key)
  if (slots.includes('client_secret')) return 'oauth2'
  if (slots.includes('token')) return 'bearer'
  if (slots.includes('password')) return 'basic'
  if (slots.includes('api_key')) return 'header'
  return 'none'
}

/** What the user should know about a connection's settings, for the approval text and the Connections tab. */
export function httpWarnings(s: HttpSettings): string[] {
  const out: string[] = []
  if (s.local) out.push('Marked as a local or internal service: it may reach private, loopback and link-local addresses on your network.')
  if (s.base.protocol === 'http:') out.push('Plain http: the request and the credential travel unencrypted.')
  if (s.insecureTls) out.push('Certificate checks are switched off for this connection: anyone in the middle could read the credential.')
  return out
}

// ---------- path patterns ----------

/** `*` matches one path segment, `**` any number; a pattern without them also matches everything below it. */
export function pathMatches(pattern: string, path: string): boolean {
  const p = pattern.trim().replace(/\/+$/, '') || '/'
  const target = path.replace(/\/+$/, '') || '/'
  if (!/[*]/.test(p)) return target.toLowerCase() === p.toLowerCase() || target.toLowerCase().startsWith(p.toLowerCase() === '/' ? '/' : p.toLowerCase() + '/')
  const re = p
    .split('/')
    .map((seg) => (seg === '**' ? '\u0000' : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')))
    .join('/')
    .replace(/\/\u0000/g, '(?:/.*)?')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${re}$`, 'i').test(target)
}

/** The path as a server would read it: percent-escapes decoded where that's safe. Used for the admin and lock checks. */
function decodedPath(p: string): string {
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

// ---------- building a request ----------

/** Headers an agent may never set: Corvid sets them, or they would change where or how the request goes. */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'host',
  'cookie',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-http-method-override',
  'x-method-override'
])

export interface PlannedRequest {
  method: string
  url: URL
  headers: Record<string, string>
  body?: Buffer
  bodyText?: string
  /** headers or query parameters Corvid dropped, for the agent's result */
  notes: string[]
  cls: OpClass
  why: string
}

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/gi

/** Path parameters: one segment each, no traversal. */
function fillPath(template: string, args: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const v = args[name]
    if (v === undefined || v === null || v === '') throw new Error(`The path needs ${name}.`)
    const s = String(v)
    if (s === '.' || s === '..' || /[/\\]/.test(s)) throw new Error(`${name} must be a single path segment.`)
    return encodeURIComponent(s)
  })
}

/**
 * Turns a call into the exact request Corvid will send, without the credential: method, URL on the connection's
 * own origin, headers, body, and its class. Throws a plain message when the agent asks for something not allowed.
 */
export function planRequest(m: ConnectorManifest, s: HttpSettings, op: Operation, args: Record<string, unknown>): PlannedRequest {
  const notes: string[] = []
  let method: string
  let path: string
  if (op.path) {
    if (/\*/.test(op.path)) throw new Error(`${op.name} only marks paths for the connection's rules and can't be called; use request.`)
    method = (op.method ?? 'GET').toUpperCase()
    checkInput(op, args)
    path = fillPath(op.path, args)
  } else {
    method = String(args.method ?? 'GET').toUpperCase()
    path = String(args.path ?? '/')
  }
  if (![...READ_METHODS, ...WRITE_METHODS].includes(method)) throw new Error(`${method} is not a method this runtime sends.`)
  if (!op.path && !s.methods.includes(method)) throw new Error(`This connection does not allow ${method} requests. Allowed: ${s.methods.join(', ')}.`)

  // the path stays on the connection's origin: no scheme, no //host, no backslashes, no user info, no fragments
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\s#]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path))
    throw new Error('path must be a path on the connection, starting with a single /, like /v1/orders. Corvid adds the scheme, host and port itself.')
  const [pathOnly, pathQuery] = path.split('?', 2)
  let url: URL
  try {
    url = new URL(s.base.origin + s.basePath + pathOnly)
  } catch {
    throw new Error('That path does not make a valid URL.')
  }
  if (url.origin !== s.base.origin || url.username || url.password) throw new Error('The request must stay on the connection’s own host, scheme and port.')
  if (s.basePath && !(url.pathname === s.basePath || url.pathname.startsWith(s.basePath + '/'))) throw new Error(`The path must stay under ${s.basePath}.`)

  const query: [string, string][] = []
  if (pathQuery) for (const [k, v] of new URLSearchParams(pathQuery)) query.push([k, v])
  const q = args.query
  if (q !== undefined && q !== null) {
    if (typeof q !== 'object' || Array.isArray(q)) throw new Error('query must be an object of names and values.')
    for (const [k, v] of Object.entries(q as Record<string, unknown>))
      for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined && x !== null) query.push([k, typeof x === 'object' ? JSON.stringify(x) : String(x)])
  }
  for (const [k, v] of query) {
    if (s.auth.includes('query') && k.toLowerCase() === s.authQuery.toLowerCase()) {
      notes.push(`Dropped the query parameter ${k}: Corvid adds the credential itself.`)
      continue
    }
    url.searchParams.append(k, v)
  }

  const headers: Record<string, string> = {}
  const h = args.headers
  if (h !== undefined && h !== null) {
    if (typeof h !== 'object' || Array.isArray(h)) throw new Error('headers must be an object of names and values.')
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      const name = k.trim()
      const lower = name.toLowerCase()
      if (!TOKEN.test(name)) throw new Error(`${name} is not a valid header name.`)
      if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-') || (s.auth.includes('header') && lower === s.authHeader.toLowerCase())) {
        notes.push(`Dropped the ${name} header: Corvid sets it, or it could change where the request goes.`)
        continue
      }
      const value = String(v ?? '')
      if (/[\r\n\0]/.test(value)) throw new Error(`The ${name} header has a line break in it.`)
      headers[name] = value
    }
  }

  let body: Buffer | undefined
  let bodyText: string | undefined
  if (args.body !== undefined && args.body !== null) {
    if (method === 'GET' || method === 'HEAD') throw new Error(`${method} requests can't have a body.`)
    const typeKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type')
    if (typeof args.body === 'string') {
      bodyText = args.body
      if (!typeKey) headers['Content-Type'] = 'text/plain; charset=utf-8'
    } else {
      bodyText = JSON.stringify(args.body)
      if (!typeKey) headers['Content-Type'] = 'application/json'
    }
    body = Buffer.from(bodyText, 'utf8')
    if (body.length > MAX_REQUEST_BYTES) throw new Error(`The request body is larger than ${MAX_REQUEST_BYTES / 1024} KB.`)
  }
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) headers.Accept = 'application/json, text/*;q=0.9, */*;q=0.1'

  const real = decodedPath(url.pathname)
  if (!op.path && !s.allowedPaths.some((p) => pathMatches(p, real) && pathMatches(p, url.pathname)))
    throw new Error(`This connection is limited to ${s.allowedPaths.join(', ')}; ${url.pathname} is outside that.`)
  const { cls, why } = classify(m, s, op, method, real)
  return { method, url, headers, body, bodyText, notes, cls, why }
}

/** GET, HEAD and OPTIONS read; the other methods change; admin paths (the connection's or the manifest's) always ask. */
export function classify(m: ConnectorManifest, s: HttpSettings, op: Operation, method: string, path: string): { cls: OpClass; why: string } {
  const rel = s.basePath && path.startsWith(s.basePath) ? path.slice(s.basePath.length) || '/' : path
  const adminRule =
    s.adminPaths.find((p) => pathMatches(p, path) || pathMatches(p, rel)) ??
    m.capabilities.operations.filter((o) => o.class === 'admin' && o.path).map((o) => o.path!.replace(PLACEHOLDER, '*')).find((p) => pathMatches(p, path) || pathMatches(p, rel))
  if (adminRule) return { cls: 'admin', why: `${path} is an administrative path (${adminRule}), so it always asks.` }
  if (op.path) return { cls: op.class, why: `${op.name} is a ${op.class} operation.` }
  const cls: OpClass = READ_METHODS.includes(method) ? 'read' : 'write'
  return { cls, why: cls === 'read' ? `${method} only reads.` : `${method} can change data.` }
}

/** The small JSON-schema subset of #87, checked against a named operation's arguments. */
function checkInput(op: Operation, args: Record<string, unknown>): void {
  const sch = op.input
  if (!sch || sch.type !== 'object') return
  for (const r of sch.required ?? []) if (args[r] === undefined || args[r] === null || args[r] === '') throw new Error(`${op.name} needs ${r}.`)
  for (const [k, p] of Object.entries(sch.properties ?? {})) {
    const v = args[k]
    if (v === undefined || v === null) continue
    const t = Array.isArray(v) ? 'array' : typeof v
    const ok = p.type === 'integer' ? Number.isInteger(v) : p.type === 'number' ? t === 'number' : p.type === t
    if (!ok) throw new Error(`${op.name}: ${k} must be ${p.type === 'integer' ? 'an integer' : `a ${p.type}`}.`)
    if (p.enum && !p.enum.includes(v as string | number)) throw new Error(`${op.name}: ${k} must be one of ${p.enum.join(', ')}.`)
    if (p.maxLength !== undefined && typeof v === 'string' && v.length > p.maxLength) throw new Error(`${op.name}: ${k} is too long.`)
    if (p.maximum !== undefined && typeof v === 'number' && v > p.maximum) throw new Error(`${op.name}: ${k} is above ${p.maximum}.`)
    if (p.minimum !== undefined && typeof v === 'number' && v < p.minimum) throw new Error(`${op.name}: ${k} is below ${p.minimum}.`)
  }
}

// ---------- what is shown and logged ----------

const SECRET_NAME = /(key|token|secret|pass|pwd|sig|signature|auth|code|session|credential|jwt)/i

/** Method and path, with query values whose names look secret masked: the audit line. */
export function auditLine(r: { method: string; url: URL }): string {
  const u = new URL(r.url.href)
  for (const k of [...new Set(u.searchParams.keys())]) if (SECRET_NAME.test(k)) u.searchParams.set(k, '***')
  return `${r.method} ${u.pathname}${u.search}`
}

/** The exact request as it will be sent, with the credential's place marked: the text under Strict. */
export function shownRequest(r: PlannedRequest, s: HttpSettings): string {
  const u = new URL(r.url.href)
  if (s.auth.includes('query')) u.searchParams.append(s.authQuery, CREDENTIAL_MASK)
  const lines = [`${r.method} ${u.href.replace(new URLSearchParams({ x: CREDENTIAL_MASK }).toString().slice(2), CREDENTIAL_MASK)}`]
  for (const [k, v] of Object.entries(r.headers)) lines.push(`${k}: ${v}`)
  if (s.auth.some((a) => a === 'bearer' || a === 'basic' || a === 'oauth2')) lines.push(`Authorization: ${CREDENTIAL_MASK}`)
  if (s.auth.includes('header')) lines.push(`${s.authHeader}: ${CREDENTIAL_MASK}`)
  if (r.bodyText !== undefined) lines.push('', r.bodyText.length > 8000 ? r.bodyText.slice(0, 8000) + `\n[… ${r.bodyText.length - 8000} more characters]` : r.bodyText)
  return lines.join('\n')
}

// ---------- responses ----------

/** Response headers the agent gets back; everything else (cookies, auth challenges, server internals) is left out. */
export const RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-language',
  'date',
  'etag',
  'last-modified',
  'location',
  'retry-after',
  'link',
  'cache-control',
  'x-request-id',
  'x-total-count',
  'x-next-page',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset'
])

/** Text and JSON are returned; anything else is described, not downloaded. */
export function isTextType(contentType: string): boolean {
  const t = contentType.split(';')[0].trim().toLowerCase()
  if (!t) return true
  return (
    t.startsWith('text/') ||
    /[/+]json$/.test(t) ||
    /[/+]xml$/.test(t) ||
    ['application/javascript', 'application/x-www-form-urlencoded', 'application/graphql', 'application/x-ndjson', 'application/problem+json'].includes(t)
  )
}

export const isJsonType = (contentType: string): boolean => /[/+]json\b/i.test(contentType.split(';')[0])
