import { STATUS_CODES } from 'node:http'
import type { Connection } from '@shared/types'
import { NOTE_CAP, type UserRequest, type UserRequestPlan, type UserRequestRefusal, type UserResponse, type RequestClass } from '@shared/sendRequest'
import type { ConnectorManifest, Operation } from './manifest'
import { connectorGate, MASK, scrubDeep } from './policy'
import { auditCall, connectorState, getConnection, getManifest, killedAll } from './store'
import { httpCall } from './http'
import { auditLine, httpSettings, httpWarnings, isTextType, planRequest, shownRequest } from './httpRules'
import { trackRunning } from './index'
import { hasKnownSecret, scrubber } from '../remote/scrub'

// The Connections tab's "Send a request" (#105): the user, as the owner, sends one request through an HTTP
// connection and reads the response in the panel. It goes through the same runtime as an agent's call (http.ts):
// the host lock, address rules, TLS, redirects, limits and credential injection all apply. The response goes back
// to the window that asked and nowhere else: not to an agent, not to the board, not to disk (unless the user saves
// it as a note). Reads run straight away; the panel confirms writes and admin paths, and main checks it did.

const AUDIT_AS = 'user (send request)'

/** Requests in flight, by the panel's id, so Cancel can stop one. */
const inFlight = new Map<string, AbortController>()

interface Target {
  c: Connection
  m: ConnectorManifest
  hash: string
  op: Operation
}

function target(id: string): Target | UserRequestRefusal {
  const c = getConnection(String(id))
  if (!c) return { ok: false, error: 'That connection no longer exists.' }
  const entry = getManifest(c.connectorId)
  if (!entry) return { ok: false, error: 'The connector behind this connection is missing.' }
  if (entry.manifest.runtime !== 'http') return { ok: false, error: 'Send a request works with HTTP connections only.' }
  const op = entry.manifest.capabilities.operations.find((o) => o.name === 'request' && !o.path)
  if (!op) return { ok: false, error: "This connector has no general request operation, so the panel can't send through it." }
  return { c, m: entry.manifest, hash: entry.hash, op }
}

/** The kill switch and the connector's approval, in the user's words. Nothing is asked here: approving is the user's click. */
function gate(t: Target): UserRequestRefusal | null {
  if (killedAll()) return { ok: false, error: 'All connectors are switched off ("Disable all connectors" is on), so nothing was sent. Switch them back on at the top of this tab first.' }
  const state = connectorState(t.c.connectorId)
  const g = connectorGate(state, t.hash, false)
  if (g.ok) return null
  if (state?.disabled) return { ok: false, error: `The ${t.m.name} connector is switched off, so nothing was sent. Switch it back on under Connectors first.` }
  if (state?.status === 'draft') return { ok: false, error: 'This connector is still a draft, so nothing was sent.' }
  if (state?.status === 'declined' && state.decidedHash === t.hash)
    return { ok: false, approve: true, error: `You declined the ${t.m.name} ${t.m.version} connector, so nothing was sent. Review and approve it to use this connection.` }
  return { ok: false, approve: true, error: `The ${t.m.name} ${t.m.version} connector isn't approved yet, so nothing was sent. Review and approve it first.` }
}

/** The panel's fields as the runtime's arguments. Throws a plain message for a JSON body that doesn't parse. */
function args(r: UserRequest): Record<string, unknown> {
  const query: Record<string, string[]> = {}
  for (const [k, v] of r.query ?? []) if (k.trim()) (query[k.trim()] ??= []).push(String(v ?? ''))
  const headers: Record<string, string> = {}
  for (const [k, v] of r.headers ?? []) if (k.trim()) headers[k.trim()] = String(v ?? '')
  const out: Record<string, unknown> = { method: String(r.method ?? 'GET').toUpperCase(), path: String(r.path ?? '/'), query, headers }
  if (r.body !== undefined && r.body.trim() !== '') {
    if (r.bodyKind === 'json') {
      try {
        out.body = JSON.parse(r.body)
      } catch (e) {
        throw new Error(`The body isn't valid JSON: ${(e as Error).message}. Switch the body to Text to send it as it is.`)
      }
      // a bare JSON string would go out as text/plain; keep it JSON
      if (typeof out.body === 'string') {
        out.body = r.body
        headers['Content-Type'] ??= 'application/json'
      }
    } else out.body = r.body
  }
  return out
}

/** The runtime's messages are written for agents; the panel speaks to the owner. */
const forUser = (msg: string): string =>
  msg
    .replace(/ask the user to /gi, '')
    .replace(/the user's own/gi, 'your own')
    .replace(/the user can/gi, 'you can')
    .replace(/Ask the user to check/gi, 'Check')

/** The exact request and its class, for the confirmation; refuses what the runtime would refuse anyway. */
export function planUserRequest(id: string, req: UserRequest): UserRequestPlan | UserRequestRefusal {
  const t = target(id)
  if ('ok' in t) return t
  const blocked = gate(t)
  if (blocked) return blocked
  const scrub = scrubber()
  try {
    const s = httpSettings(t.m, t.c.config)
    const p = planRequest(t.m, s, t.op, args(req))
    return { ok: true, cls: p.cls, why: p.why, shown: scrub(shownRequest(p, s)), warnings: httpWarnings(s), notes: p.notes.map(scrub) }
  } catch (e) {
    return { ok: false, error: scrub(forUser((e as Error).message)) }
  }
}

/**
 * Sends the request and returns the scrubbed response to the panel. `confirmed` is the class the user confirmed in
 * the panel: a write needs at least 'write', an admin path 'admin'; without it nothing is sent.
 */
export async function sendUserRequest(id: string, reqId: string, req: UserRequest, confirmed: RequestClass | null): Promise<UserResponse | UserRequestRefusal> {
  const t = target(id)
  if ('ok' in t) return t
  const { c, m, op } = t
  const scrub = scrubber()
  const started = Date.now()
  let cls: RequestClass = 'read'
  let request = `${String(req.method ?? 'GET').slice(0, 10)} ${String(req.path ?? '').split('?')[0]}`
  const log = (decision: 'automatic' | 'approved' | 'refused', extra: { detail?: string; resultBytes?: number; error?: string } = {}): void =>
    auditCall({
      ts: Date.now(),
      agent: AUDIT_AS,
      connection: c.name,
      connector: `${m.id}@${m.version}`,
      operation: op.name,
      class: cls,
      decision,
      request: scrub(request).slice(0, 2000),
      durationMs: Date.now() - started,
      ...extra,
      error: extra.error ? scrub(extra.error) : undefined
    })

  const blocked = gate(t)
  if (blocked) {
    log('refused', { detail: blocked.error })
    return blocked
  }
  let a: Record<string, unknown>
  try {
    a = args(req)
    const s = httpSettings(m, c.config)
    const p = planRequest(m, s, op, a)
    cls = p.cls
    request = auditLine(p)
  } catch (e) {
    const error = scrub(forUser((e as Error).message))
    log('refused', { error })
    return { ok: false, error, durationMs: 0 }
  }
  const rank = { read: 0, write: 1, admin: 2 }
  if (cls !== 'read' && (!confirmed || rank[confirmed] < rank[cls])) {
    const error = cls === 'admin' ? 'This is an administrative path and needs your confirmation; nothing was sent.' : 'This request can change data and needs your confirmation; nothing was sent.'
    log('refused', { error })
    return { ok: false, error, durationMs: 0 }
  }

  const ac = new AbortController()
  inFlight.set(reqId, ac)
  const untrack = trackRunning(() => ac.abort(new Error('Connectors were switched off, so this request was stopped.')))
  const decision = cls === 'read' ? 'automatic' : 'approved'
  const who = cls === 'read' ? 'user (owner)' : 'confirmed by user'
  try {
    const r = await httpCall(c, m, op, a, ac.signal)
    if (killedAll() || connectorState(c.connectorId)?.disabled) throw new Error('Connectors were switched off while this ran, so its response is withheld.')
    const before = JSON.stringify(r)
    const body = scrubDeep(r.body, scrub)
    const headers = scrubDeep(r.headers, scrub)
    const notes = (r.notes ?? []).map(scrub)
    const hidden = before.includes(MASK) || JSON.stringify(body) !== JSON.stringify(r.body) || JSON.stringify(headers) !== JSON.stringify(r.headers)
    const type = String(r.headers['content-type'] ?? '')
    const binary = type && !isTextType(type) ? type.split(';')[0].trim() : undefined
    const json = body !== null && typeof body === 'object'
    const size = body === null ? 0 : Buffer.byteLength(typeof body === 'string' ? body : JSON.stringify(body))
    log(decision, { detail: `${who}, HTTP ${r.status}`, resultBytes: size })
    return {
      ok: true,
      status: r.status,
      reason: STATUS_CODES[r.status] ?? '',
      durationMs: Date.now() - started,
      size,
      url: scrub(r.url),
      headers,
      body,
      json,
      truncated: !!r.truncated,
      capBytes: m.limits.maxResponseBytes,
      binary,
      notes,
      hidden
    }
  } catch (e) {
    const cancelled = ac.signal.aborted && ac.signal.reason === CANCEL
    const error = cancelled
      ? 'You cancelled the request. If it had already reached the server, the server may still have acted on it.'
      : scrub(forUser((e as Error).message))
    log(decision, { detail: who, error: cancelled ? 'cancelled by user' : error })
    return { ok: false, error, durationMs: Date.now() - started }
  } finally {
    inFlight.delete(reqId)
    untrack()
  }
}

const CANCEL = new Error('Cancelled by the user.')

/** The panel's Cancel button, or the panel closing while a request runs. */
export function cancelUserRequest(reqId: string): void {
  inFlight.get(String(reqId))?.abort(CANCEL)
}

/**
 * "Save to a note": the only way a response leaves the panel, and only on the user's click. Scrubbed again, capped,
 * and refused if a stored secret is still in it.
 */
export function responseNoteText(name: string, text: string): { name: string; text: string } {
  const scrub = scrubber()
  let body = scrub(String(text ?? ''))
  if (Buffer.byteLength(body) > NOTE_CAP) {
    body = Buffer.from(body).subarray(0, NOTE_CAP).toString('utf8').replace(/�$/, '')
    body += `\n\n[Cut at ${NOTE_CAP / 1024} KB for the note; the panel showed more.]`
  }
  const n = scrub(String(name ?? '')).slice(0, 120)
  if (hasKnownSecret(body) || hasKnownSecret(n)) throw new Error('The response still holds a stored secret, so it was not saved.')
  return { name: n, text: body }
}
