import http from 'node:http'
import https from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { Connection } from '@shared/types'
import type { ConnectorManifest, Operation } from './manifest'
import { makeScrubber, MASK } from './policy'
import { allConnectionSecrets, auditCall, killedAll, connectorState, secretProblem, secretValue } from './store'
import {
  addressRefusal,
  auditLine,
  httpSettings,
  isJsonType,
  isTextType,
  MAX_CONCURRENT,
  MAX_REDIRECTS,
  pathMatches,
  planRequest,
  RESPONSE_HEADERS,
  type HttpSettings,
  type PlannedRequest
} from './httpRules'

// The http runtime (#89). The agent describes a request on a connection; Corvid builds it on the connection's own
// origin, resolves the host once and connects to that address only after checking it, adds the credential itself,
// follows redirects only where it may (never carrying the credential to another origin), keeps to the limits, and
// returns status, a few response headers and a text or JSON body. The rules without network are in httpRules.ts.

/** Name resolution; the tests swap it for a fake one so nothing reaches real DNS. */
export const httpDeps = {
  lookup: async (host: string): Promise<{ address: string; family: number }[]> => dnsLookup(host, { all: true, verbatim: true })
}

export interface HttpResult {
  status: number
  ok: boolean
  /** the final path and query, secret-looking query values masked */
  url: string
  headers: Record<string, string>
  body: unknown
  truncated?: boolean
  notes?: string[]
}

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
  truncated: boolean
  binary?: string
}

// ---------- per-connection limits, tokens and cookies (memory only) ----------

const recent = new Map<string, number[]>()
const active = new Map<string, number>()
const tokens = new Map<string, { key: string; token: string; expiresAt: number }>()
const cookies = new Map<string, Map<string, string>>()

function takeSlot(c: Connection, m: ConnectorManifest): () => void {
  const now = Date.now()
  const rate = m.limits.ratePerMinute
  const times = (recent.get(c.id) ?? []).filter((t) => now - t < 60_000)
  if (rate && times.length >= rate) {
    const wait = Math.ceil((60_000 - (now - times[0])) / 1000)
    throw new Error(`${c.name} allows at most ${rate} calls a minute; try again in about ${wait} s. Nothing was sent.`)
  }
  const n = active.get(c.id) ?? 0
  if (n >= MAX_CONCURRENT) throw new Error(`${c.name} already has ${MAX_CONCURRENT} calls running; wait for one to finish. Nothing was sent.`)
  times.push(now)
  recent.set(c.id, times)
  active.set(c.id, n + 1)
  return () => active.set(c.id, Math.max(0, (active.get(c.id) ?? 1) - 1))
}

/** Forgets a connection's OAuth token and cookies, e.g. when it is edited or deleted. */
export function forgetHttpState(connectionId?: string): void {
  for (const map of [tokens, cookies, recent]) connectionId ? map.delete(connectionId) : map.clear()
}

// ---------- address checks and pinned resolution ----------

type Pinned = { address: string; family: number }

/** Resolves a host once, refuses it if any address is not allowed, and returns the address to connect to. */
async function resolveChecked(hostname: string, s: HttpSettings, cache: Map<string, Pinned>): Promise<Pinned> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const hit = cache.get(host)
  if (hit) return hit
  let addrs: Pinned[]
  if (isIP(host)) addrs = [{ address: host, family: isIP(host) }]
  else {
    if (host === 'localhost' || host.endsWith('.localhost')) addrs = [{ address: '127.0.0.1', family: 4 }]
    else {
      try {
        addrs = await httpDeps.lookup(host)
      } catch {
        throw new Error(`${host} could not be found. Nothing was sent.`)
      }
    }
  }
  if (!addrs.length) throw new Error(`${host} could not be found. Nothing was sent.`)
  for (const a of addrs) {
    const why = addressRefusal(a.address, s.local)
    if (why) throw new Error(`Refused: ${host} resolves to ${why} Nothing was sent.`)
  }
  cache.set(host, addrs[0])
  return addrs[0]
}

/** A lookup that always answers with the address checked before, so DNS can't change between check and connect. */
const pinnedLookup =
  (p: Pinned) =>
  (_h: string, opts: { all?: boolean } | number | undefined, cb: (...a: unknown[]) => void): void => {
    if (typeof opts === 'object' && opts?.all) cb(null, [{ address: p.address, family: p.family }])
    else cb(null, p.address, p.family)
  }

// ---------- one request ----------

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|UNABLE_TO_GET_ISSUER/

function send(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  pinned: Pinned,
  s: HttpSettings,
  maxBytes: number,
  signal: AbortSignal
): Promise<RawResponse> {
  return new Promise((resolveP, rejectP) => {
    let settled = false
    const resolve = (r: RawResponse): void => void (settled || ((settled = true), resolveP(r)))
    const reject = (e: Error): void => void (settled || ((settled = true), rejectP(e)))
    const lib = url.protocol === 'https:' ? https : http
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const opts: https.RequestOptions = {
      method,
      headers: { ...headers, ...(body ? { 'Content-Length': String(body.length) } : {}) },
      agent: false,
      lookup: pinnedLookup(pinned) as unknown as https.RequestOptions['lookup'],
      signal
    }
    if (url.protocol === 'https:') {
      opts.rejectUnauthorized = !s.insecureTls
      if (!isIP(host)) opts.servername = host
    }
    const req = lib.request(url, opts, (res) => {
      const type = String(res.headers['content-type'] ?? '')
      const done = (r: Omit<RawResponse, 'status' | 'headers'>): void => resolve({ status: res.statusCode ?? 0, headers: res.headers, ...r })
      if (method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) {
        res.resume()
        return done({ body: Buffer.alloc(0), truncated: false })
      }
      if (!isTextType(type)) {
        res.destroy()
        return done({ body: Buffer.alloc(0), truncated: false, binary: type.split(';')[0].trim() })
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (ch: Buffer) => {
        if (size >= maxBytes) return
        chunks.push(ch)
        size += ch.length
        if (size >= maxBytes) {
          done({ body: Buffer.concat(chunks).subarray(0, maxBytes), truncated: true })
          res.destroy()
        }
      })
      res.on('end', () => done({ body: Buffer.concat(chunks), truncated: false }))
      res.on('error', (e) => reject(e))
      res.on('aborted', () => reject(new Error('The connection was closed before the response finished.')))
    })
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (signal.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('The call was stopped.'))
      const code = String(e.code ?? '')
      if (TLS_CODES.test(code) || /certificate/i.test(e.message))
        return reject(
          new Error(
            `The server's certificate could not be verified (${code || e.message}), so nothing was sent. If this is the user's own internal service with a self-signed certificate, the user can allow it on the connection.`
          )
        )
      if (code === 'ECONNREFUSED') return reject(new Error(`${url.host} refused the connection.`))
      reject(new Error(`The request failed: ${code || e.message}.`))
    })
    if (body) req.write(body)
    req.end()
  })
}

// ---------- credentials ----------

interface Creds {
  values: string[]
  apply: (url: URL, headers: Record<string, string>) => void
}

const need = (c: Connection, slot: string, label: string): string => {
  const v = secretValue(c, slot)
  const problem = v ? undefined : secretProblem(c, slot)
  if (problem) throw new Error(`${problem} (${label} for ${c.name}; nothing was sent)`)
  if (!v) throw new Error(`The ${label} for ${c.name} isn't saved in Corvid yet; ask the user to set it on the connection. Nothing was sent.`)
  return v
}

async function credentials(c: Connection, s: HttpSettings, maxBytes: number, signal: AbortSignal, cache: Map<string, Pinned>, fresh = false): Promise<Creds> {
  const values: string[] = []
  const steps: ((url: URL, headers: Record<string, string>) => void)[] = []
  for (const a of s.auth) {
    if (a === 'bearer') {
      const t = need(c, 'token', 'bearer token')
      steps.push((_u, h) => void (h.Authorization = `Bearer ${t}`))
    } else if (a === 'basic') {
      const p = need(c, 'password', 'password')
      const pair = `${s.username}:${p}`
      values.push(pair, Buffer.from(pair).toString('base64'))
      steps.push((_u, h) => void (h.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`))
    } else if (a === 'header') {
      const k = need(c, 'api_key', 'API key')
      steps.push((_u, h) => void (h[s.authHeader] = k))
    } else if (a === 'query') {
      const k = need(c, 'api_key', 'API key')
      steps.push((u) => u.searchParams.set(s.authQuery, k))
    } else if (a === 'oauth2') {
      const t = await oauthToken(c, s, maxBytes, signal, cache, fresh)
      values.push(t)
      steps.push((_u, h) => void (h.Authorization = `Bearer ${t}`))
    }
  }
  return { values, apply: (u, h) => steps.forEach((f) => f(u, h)) }
}

/** OAuth2 client credentials: Corvid fetches and refreshes the access token; it stays in memory and never reaches the agent. */
async function oauthToken(c: Connection, s: HttpSettings, maxBytes: number, signal: AbortSignal, cache: Map<string, Pinned>, fresh: boolean): Promise<string> {
  const secret = need(c, 'client_secret', 'client secret')
  const key = createHash('sha256').update(`${c.updatedAt}\n${s.tokenUrl!.href}\n${s.clientId}\n${s.scope}\n${secret}`).digest('hex')
  const hit = tokens.get(c.id)
  if (!fresh && hit && hit.key === key && hit.expiresAt > Date.now()) return hit.token
  tokens.delete(c.id)
  const url = new URL(s.tokenUrl!.href)
  const form = new URLSearchParams({ grant_type: 'client_credentials' })
  if (s.scope) form.set('scope', s.scope)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (s.oauthSend === 'body') {
    form.set('client_id', s.clientId)
    form.set('client_secret', secret)
  } else headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`
  const pinned = await resolveChecked(url.hostname, s, cache)
  const r = await send(url, 'POST', headers, Buffer.from(form.toString()), pinned, s, Math.min(maxBytes, 64 * 1024), signal)
  let json: { access_token?: unknown; expires_in?: unknown; token_type?: unknown } = {}
  try {
    json = JSON.parse(r.body.toString('utf8'))
  } catch {
    /* handled below */
  }
  if (r.status >= 400 || typeof json.access_token !== 'string' || !json.access_token)
    throw new Error(`Corvid could not get an access token for ${c.name} (the token endpoint answered ${r.status}). Ask the user to check the client id and secret. Nothing else was sent.`)
  const life = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 3_600_000
  tokens.set(c.id, { key, token: json.access_token, expiresAt: Date.now() + Math.max(1000, life - 30_000) })
  return json.access_token
}

// ---------- cookies (only when the connection keeps them) ----------

function rememberCookies(c: Connection, setCookie: string[] | undefined): void {
  if (!setCookie?.length) return
  const jar = cookies.get(c.id) ?? new Map<string, string>()
  for (const line of setCookie) {
    const [pair, ...attrs] = line.split(';')
    const i = pair.indexOf('=')
    if (i < 1) continue
    const name = pair.slice(0, i).trim()
    const gone = attrs.some((a) => /^\s*max-age\s*=\s*(0|-)/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split('=').slice(1).join('=')) < Date.now()))
    if (gone) jar.delete(name)
    else jar.set(name, pair.slice(i + 1).trim())
  }
  cookies.set(c.id, jar)
}

// ---------- the call ----------

/** Plans, approves (in index.ts) and then runs here: one request, with redirects, on a connection. */
export async function httpCall(c: Connection, m: ConnectorManifest, op: Operation, args: Record<string, unknown>, stop: AbortSignal): Promise<HttpResult> {
  const s = httpSettings(m, c.config)
  const plan = planRequest(m, s, op, args)
  const release = takeSlot(c, m)
  const deadline = AbortSignal.timeout(m.limits.timeoutMs)
  const signal = AbortSignal.any([stop, deadline])
  const cache = new Map<string, Pinned>()
  const extra: string[] = []
  try {
    // the address first: a refused host is refused before any credential is even looked up
    await resolveChecked(plan.url.hostname, s, cache)
    let creds = await credentials(c, s, m.limits.maxResponseBytes, signal, cache)
    extra.push(...creds.values)
    let r = await follow(c, m, s, plan, creds, signal, cache)
    if (r.res.status === 401 && s.auth.includes('oauth2')) {
      // the token may have been revoked or expired early: one fresh token, one retry
      creds = await credentials(c, s, m.limits.maxResponseBytes, signal, cache, true)
      extra.push(...creds.values)
      r = await follow(c, m, s, plan, creds, signal, cache)
    }
    const jar = cookies.get(c.id)
    if (jar) extra.push(...jar.values())
    return scrubResult(result(r.res, r.url, s, plan.notes, m.limits.maxResponseBytes), m, extra)
  } catch (e) {
    if (deadline.aborted && !stop.aborted) throw new Error(`No complete answer within ${Math.round(m.limits.timeoutMs / 1000)} s, so the call was stopped.`)
    if (stop.aborted) throw new Error('Connectors were switched off, so this call was stopped.')
    throw new Error(makeScrubber(extra)((e as Error).message))
  } finally {
    release()
  }
}

async function follow(
  c: Connection,
  m: ConnectorManifest,
  s: HttpSettings,
  plan: PlannedRequest,
  creds: Creds,
  signal: AbortSignal,
  cache: Map<string, Pinned>
): Promise<{ res: RawResponse; url: URL }> {
  let url = new URL(plan.url.href)
  let method = plan.method
  let body = plan.body
  const headers = { ...plan.headers }
  const scrubCreds = makeScrubber(creds.values.concat(credentialValues(c, s)))
  for (let hop = 0; ; hop++) {
    const same = url.origin === s.base.origin
    const hopUrl = new URL(url.href)
    const hopHeaders = { ...headers }
    if (same) {
      creds.apply(hopUrl, hopHeaders)
      const jar = s.keepCookies ? cookies.get(c.id) : undefined
      if (jar?.size) hopHeaders.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
    }
    const pinned = await resolveChecked(url.hostname, s, cache)
    const res = await send(hopUrl, method, hopHeaders, body, pinned, s, m.limits.maxResponseBytes, signal)
    if (same && s.keepCookies) rememberCookies(c, res.headers['set-cookie'])
    const loc = res.headers.location
    if (![301, 302, 303, 307, 308].includes(res.status) || !loc) return { res, url }
    if (hop >= MAX_REDIRECTS) throw new Error(`More than ${MAX_REDIRECTS} redirects; stopped.`)
    let next: URL
    try {
      next = new URL(String(loc), url)
    } catch {
      throw new Error('The server redirected to an address that is not a valid URL; not followed.')
    }
    if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new Error(`The server redirected to a ${next.protocol} address; not followed.`)
    if (next.username || next.password) throw new Error('The server redirected to an address with a user name in it; not followed.')
    if (next.origin !== s.base.origin) {
      if (!s.extraHosts.includes(next.hostname.toLowerCase()))
        throw new Error(`The server redirected to ${next.host}, which this connection may not reach. The redirect was not followed and the credential was not sent there.`)
      if (next.protocol === 'http:' && !s.local) throw new Error(`The server redirected to plain http on ${next.host}; not followed.`)
      if (scrubCreds(next.href) !== next.href) throw new Error(`The server redirected to ${next.host} with the credential in the address; not followed.`)
    } else {
      // a redirect stays inside the connection's lock and can't turn a non-admin call into an admin path
      const p = decodeSafe(next.pathname)
      if (!s.allowedPaths.some((x) => pathMatches(x, p))) throw new Error(`The server redirected to ${next.pathname}, outside what this connection allows; not followed.`)
      if (plan.cls !== 'admin' && s.adminPaths.some((x) => pathMatches(x, p) || pathMatches(x, p.slice(s.basePath.length) || '/')))
        throw new Error(`The server redirected to the administrative path ${next.pathname}; not followed.`)
      if (next.protocol === 'http:' && s.base.protocol === 'https:') throw new Error('The server redirected from https to plain http; not followed.')
    }
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      if (method !== 'HEAD') method = 'GET'
      body = undefined
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k]
    }
    url = next
  }
}

const decodeSafe = (p: string): string => {
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}

/** Values beyond the stored slots that are credentials in this request: the Basic pair, for redirect checks. */
function credentialValues(c: Connection, s: HttpSettings): string[] {
  const out: string[] = []
  for (const slot of ['token', 'api_key', 'password', 'client_secret']) {
    const v = secretValue(c, slot)
    if (v) out.push(v)
  }
  if (s.auth.includes('basic')) {
    const p = secretValue(c, 'password')
    if (p) out.push(Buffer.from(`${s.username}:${p}`).toString('base64'))
  }
  return out
}

function result(r: RawResponse, url: URL, s: HttpSettings, notes: string[], maxBytes: number): HttpResult {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(r.headers)) {
    if (!RESPONSE_HEADERS.has(k) || v === undefined) continue
    let value = Array.isArray(v) ? v.join(', ') : String(v)
    if (k === 'location') {
      try {
        const l = new URL(value, url)
        value = l.origin === s.base.origin ? l.pathname + l.search : l.href
      } catch {
        /* keep as sent */
      }
    }
    headers[k] = value
  }
  const out: HttpResult = { status: r.status, ok: r.status >= 200 && r.status < 300, url: auditLine({ method: '', url }).trim(), headers, body: null }
  const extra = [...notes]
  if (r.binary) extra.push(`The response is ${r.binary || 'binary data'}${r.headers['content-length'] ? ` (${r.headers['content-length']} bytes)` : ''}, which this runtime does not download; only text and JSON are returned.`)
  else if (r.body.length) {
    const text = r.body.toString('utf8')
    if (r.truncated) {
      out.body = text
      out.truncated = true
      extra.push(`The response was cut off at ${maxBytes} bytes${r.headers['content-length'] ? ` of ${r.headers['content-length']}` : ''}; the rest was not downloaded.`)
    } else if (isJsonType(String(r.headers['content-type'] ?? ''))) {
      try {
        out.body = JSON.parse(text)
      } catch {
        out.body = text
      }
    } else out.body = text
  }
  if (extra.length) out.notes = extra
  return out
}

/** Masks the credentials Corvid made for this call, and the manifest's scrub fields, before the general scrubber runs. */
function scrubResult(r: HttpResult, m: ConnectorManifest, extra: string[]): HttpResult {
  const scrub = makeScrubber(extra)
  const fields = new Set((m.scrub?.fields ?? []).map((f) => f.toLowerCase()))
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fields.has(k.toLowerCase()) ? MASK : walk(x)]))
    return v
  }
  const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, fields.has(k) ? MASK : scrub(v)]))
  return { ...r, url: scrub(r.url), headers, body: walk(r.body), notes: r.notes?.map(scrub) }
}

/** The Connections tab's "test connection": the configured safe read (GET test_path), returning only the outcome. */
export async function testHttpConnection(c: Connection, m: ConnectorManifest): Promise<{ ok: boolean; status?: number; message: string; durationMs: number }> {
  const started = Date.now()
  const scrub = makeScrubber(allConnectionSecrets())
  const op: Operation = { name: 'request', description: 'test connection', class: 'read' }
  let out: { ok: boolean; status?: number; message: string }
  let request = 'GET (test connection)'
  try {
    if (killedAll() || connectorState(c.connectorId)?.disabled) throw new Error('Connectors are switched off in Corvid, so nothing was sent.')
    const s = httpSettings(m, c.config)
    request = auditLine({ method: 'GET', url: new URL(s.base.origin + s.basePath + s.testPath) })
    const r = await httpCall(c, m, op, { method: 'GET', path: s.testPath }, new AbortController().signal)
    out = { ok: r.ok, status: r.status, message: r.ok ? `Connected: the server answered ${r.status}.` : `The server answered ${r.status}.` }
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
    detail: out.status ? `HTTP ${out.status}` : undefined,
    request: scrub(request),
    durationMs,
    error: out.ok ? undefined : out.message
  })
  return { ...out, durationMs }
}
