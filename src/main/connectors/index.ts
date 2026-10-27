import { z } from 'zod'
import type { CallDecision, Connection, RemoteSystem } from '@shared/types'
import type { ToolDef } from '../mcp'
import type { AgentScope } from '../remote'
import { askUser, APPROVAL_TIMEOUT_MS, denyAll } from '../remote'
import { classify } from '../remote/classify'
import { runCommand, uploadFile } from '../remote/ssh'
import { getSystem } from '../remote/store'
import { hasKnownSecret, scrubber } from '../remote/scrub'
import { denyRules } from '../agentDeny'
import { capabilitySummary, operationText, secretsInUse, targetsText, type ConnectorManifest, type OpClass, type Operation } from './manifest'
import { connectorGate, needsUser, scrubDeep } from './policy'
import { httpCall } from './http'
import { dbCall, dbConnectionWarnings, dbDetail, dbSummary, planDbCall } from './db'
import { auditStatement, isDialect } from './sqlRules'
import { auditLine, httpSettings, httpWarnings, planRequest, shownRequest } from './httpRules'
import { auditUpload, DEFAULT_MAX_UPLOAD, planUpload, shownUpload, type UploadPlan } from './upload'
import { checkLimit, dropHeld, footer, hold, lookup, narrow, pageChars, pageOut, parseSelect, splitResult, type Owner, type PageOut } from './pages'
import {
  auditCall,
  confirmMigration,
  connectionsForProject,
  connectorState,
  getConnection,
  getManifest,
  killedAll,
  recordDecision,
  secretsSet,
  setConnectorDisabled,
  setKillAll,
  touchConnection
} from './store'

// Agents reach every connection through list_connections, describe_connection, call and call_more (#104). Corvid holds
// the secrets and runs the operation; the agent names a connection and gets a scrubbed result. run_on stays as the
// ssh connector's old name (remote/index.ts) and goes through the same kill switch and first-use approval.

export interface ConnectorDeps {
  projectIdForPath: (path: string) => string | undefined
  changed: () => void
  /** the page size for long results, in characters (Settings; pages.ts keeps it in range) */
  pageChars?: () => number | undefined
}
let deps: ConnectorDeps = { projectIdForPath: () => undefined, changed: () => {} }
export const initConnectors = (d: ConnectorDeps): void => void (deps = d)

/** Calls in flight; the kill switch withholds their results and stops what it can. */
const running = new Set<{ stop: () => void }>()

/** Lets the kill switches stop a call that isn't an agent's: the user's own request from the Connections tab (#105). */
export function trackRunning(stop: () => void): () => void {
  const handle = { stop }
  running.add(handle)
  return () => void running.delete(handle)
}

export function switchOffAll(on: boolean): void {
  setKillAll(on)
  if (on) {
    denyAll()
    for (const r of running) r.stop()
    dropHeld(() => true, 'connectors were switched off, which drops every held result')
  }
  deps.changed()
}

export function switchOffConnector(id: string, off: boolean): void {
  setConnectorDisabled(id, off)
  if (off) {
    for (const r of running) r.stop()
    dropHeld((h) => h.connectorId === id, 'its connector was switched off')
  }
  deps.changed()
}

const projectIdOf = (scope: AgentScope): string | undefined => deps.projectIdForPath(scope.project)
const mine = (scope: AgentScope): Connection[] => connectionsForProject(projectIdOf(scope))
const ownerOf = (scope: AgentScope): Owner => ({ agent: scope.agent, project: projectIdOf(scope) ?? scope.project })

/** Drops the held results of an agent that ended. */
export const dropResultsOf = (agent: string): number => dropHeld((h) => h.owner.agent === agent, 'the agent that made the call ended')

/**
 * Checks the kill switch and the connector's approval, and asks for first-use approval in Corvid's own dialog
 * when the version in use hasn't been approved. Returns a refusal for the agent, or null to go ahead.
 */
export async function connectorCheck(scope: AgentScope, c: Connection): Promise<{ refusal: string; decision: CallDecision } | null> {
  const m = getManifest(c.connectorId)
  if (!m) return { refusal: 'That connector is not available.', decision: 'refused' }
  // a drafted connector (#92) works only in the project it was proposed for, until the user makes it global
  const only = connectorState(c.connectorId)?.projectId
  if (only && only !== projectIdOf(scope)) return { refusal: 'That connector is not available in this project.', decision: 'refused' }
  const gate = connectorGate(connectorState(c.connectorId), m.hash, killedAll())
  if (gate.ok) return null
  if (!gate.ask) return { refusal: gate.reason, decision: 'refused' }
  const answer = await askUser({
    kind: 'connector',
    systemId: c.id,
    systemName: c.name,
    target: targetsText(m.manifest, connLike(c)).join(', '),
    command: `${m.manifest.name} ${m.manifest.version}`,
    agent: scope.agent,
    project: scope.project,
    why: `First use of the ${m.manifest.name} connector, version ${m.manifest.version}. Approve it once and its connections can be used, each under its own safety level. A changed connector asks again.`,
    summary: connectionSummary(m.manifest, c),
    details: approvalDetails(m.manifest, c),
    warn: [m.manifest.broad ? 'This connector is marked broad: it is not limited to named hosts or targets.' : '', ...connectionWarnings(c, m.manifest)].filter(Boolean).join(' ') || undefined
  })
  // the dialog answered for exactly this hash; recordDecision ignores it if the manifest changed meanwhile
  if (answer === 'approved' || answer === 'denied') recordDecision(c.connectorId, m.hash, answer === 'approved', answer === 'approved' ? 'user' : 'declined by user')
  deps.changed()
  if (answer === 'approved' && getManifest(c.connectorId)?.hash === m.hash && !killedAll()) return null
  if (answer === 'timeout') return { refusal: `No one approved this connector within ${APPROVAL_TIMEOUT_MS / 60_000} minutes, so the call was refused. Nothing was run.`, decision: 'timed out' }
  if (answer === 'denied') return { refusal: 'The user did not approve this connector. Nothing was run.', decision: 'denied' }
  return { refusal: 'The connector changed or was switched off while it waited for approval. Nothing was run.', decision: 'refused' }
}

function approvalDetails(m: ConnectorManifest, c: Connection): { label: string; items: string[] }[] {
  const byClass = (k: OpClass): string[] => m.capabilities.operations.filter((o) => o.class === k).map(operationText)
  return [
    { label: 'Targets', items: targetsText(m, connLike(c)) },
    { label: 'Reads', items: byClass('read') },
    { label: 'Changes', items: byClass('write') },
    { label: 'Administrative', items: byClass('admin') },
    { label: 'Saved secrets it uses (labels only)', items: secretsInUse(m, connLike(c)).map((s) => s.label) }
  ].filter((d) => d.items.length)
}

/** The audit line for a request refused before it was planned: http keeps to method and path, never a body or query. */
const refusedRequest = (m: ConnectorManifest, op: Operation, args: Record<string, unknown>): string =>
  isDialect(m.runtime) ? `${op.name} ${auditStatement(typeof args.sql === 'string' ? args.sql : String(args.table ?? ''))}` : m.runtime === 'http' ? `${String(args.method ?? op.method ?? 'GET').slice(0, 10)} ${String(op.path ?? args.path ?? '').split('?')[0]}` : `${op.name} ${JSON.stringify(args)}`

/** What the user should know about this connection's own settings (a local service, no certificate checks). */
function connectionWarnings(c: Connection, m: ConnectorManifest): string[] {
  if (isDialect(m.runtime)) return dbConnectionWarnings(m, c.config)
  if (m.runtime !== 'http') return []
  try {
    return httpWarnings(httpSettings(m, c.config))
  } catch {
    return []
  }
}

/** The connector's summary, and for a database what this connection allows (#90). */
const connectionSummary = (m: ConnectorManifest, c: Connection): string => [capabilitySummary(m, connLike(c)), dbSummary(m, c.config)].filter(Boolean).join(' ')

const connLike = (c: Connection): { name: string; config: Connection['config']; secretsSet: Record<string, boolean> } => ({ name: c.name, config: c.config, secretsSet: secretsSet(c) })

/** run_on's check: the ssh connection mirrored from this server. */
export async function sshGate(scope: AgentScope, systemId: string): Promise<string | null> {
  if (killedAll()) return 'All connectors are switched off in Corvid right now. Nothing was run.'
  const c = getConnection(systemId)
  // not mirrored yet (it is on the next sync): the server itself is the user's choice, so only the kill switch applies
  return c ? ((await connectorCheck(scope, c))?.refusal ?? null) : null
}

// ---------- call ----------

const SAFETY_TEXT = {
  free: 'Free: reads and changes run without asking',
  'approve-writes': 'Approve writes: reads run straight away; changes wait for the user',
  strict: 'Strict: every operation waits for the user'
} as const

function findConnection(scope: AgentScope, name: string): Connection {
  const list = mine(scope)
  const c = list.find((x) => x.name.toLowerCase() === String(name ?? '').trim().toLowerCase())
  if (!c)
    throw new Error(
      list.length ? `No connection called "${name}" is linked to this project. Available: ${list.map((x) => x.name).join(', ')}.` : 'No connections are linked to this project.'
    )
  return c
}

/** What to keep of a JSON response (#104), done by Corvid before anything reaches the agent. */
export interface Narrow {
  select?: string
  limit?: number
}

export async function call(scope: AgentScope, connName: string, opName: string, args: Record<string, unknown> = {}, want: Narrow = {}): Promise<unknown> {
  const c = findConnection(scope, connName)
  const m = getManifest(c.connectorId)
  if (!m) throw new Error('That connector is not available.')
  const op = m.manifest.capabilities.operations.find((o) => o.name === String(opName ?? '').trim())
  if (!op) throw new Error(`${c.name} has no operation "${opName}". Use describe_connection to see them.`)
  // checked before anything is sent, so a mistyped path costs no request
  const select = want.select === undefined || want.select === null ? undefined : String(want.select)
  const limit = checkLimit(want.limit)
  if ((select !== undefined || limit !== undefined) && m.manifest.runtime !== 'http')
    throw new Error(isDialect(m.manifest.runtime) ? 'select and limit work on HTTP JSON responses; for a database, name the columns and add a LIMIT in the SQL.' : 'select and limit work on HTTP JSON responses only.')
  if (select !== undefined) parseSelect(select)
  const scrub = scrubber()
  const started = Date.now()
  let planned: ReturnType<typeof classifyCall>
  try {
    planned = classifyCall(c, m.manifest, op, args, scope)
  } catch (e) {
    // a request the runtime won't send (another host, a forbidden path): refused before anyone is asked
    const msg = scrub((e as Error).message)
    auditCall({ ts: Date.now(), agent: scope.agent, project: projectIdOf(scope) ?? scope.project, connection: c.name, connector: `${m.manifest.id}@${m.manifest.version}`, operation: op.name, class: op.class, decision: 'refused', request: scrub(refusedRequest(m.manifest, op, args)).slice(0, 2000), durationMs: 0, error: msg })
    throw new Error(msg)
  }
  const { cls, request, why } = planned
  const log = (decision: CallDecision, extra: { detail?: string; resultBytes?: number; error?: string; page?: number; pages?: number; resultId?: string; returnedBytes?: number } = {}): void =>
    auditCall({
      ts: Date.now(),
      agent: scope.agent,
      project: projectIdOf(scope) ?? scope.project,
      connection: c.name,
      connector: `${m.manifest.id}@${m.manifest.version}`,
      operation: op.name,
      class: cls,
      decision,
      request: scrub(request).slice(0, 2000),
      durationMs: Date.now() - started,
      ...extra,
      error: extra.error ? scrub(extra.error) : undefined
    })

  const refused = await connectorCheck(scope, c)
  if (refused) {
    log(refused.decision, { detail: refused.refusal })
    throw new Error(refused.refusal)
  }
  const ask = needsUser(c.safety, cls, c.adminWithoutAsking)
  if (ask) {
    const answer = await askUser({
      kind: 'command',
      systemId: c.id,
      systemName: c.name,
      target: targetsText(m.manifest, connLike(c)).join(', '),
      command: scrub(planned.shown ?? request),
      agent: scope.agent,
      project: scope.project,
      why: c.safety === 'strict' ? `${c.name} is Strict: every operation needs approval.` : cls === 'admin' ? 'This is an administrative operation.' : why,
      warn: [cls === 'admin' ? 'Administrative operation' : '', ...(planned.warnings ?? [])].filter(Boolean).join(' ') || undefined
    })
    if (answer === 'approved' && (getConnection(c.id)?.updatedAt !== c.updatedAt || killedAll())) {
      log('refused', { detail: 'connection changed or connectors switched off while waiting' })
      throw new Error(`${c.name} was changed, removed or switched off while the call waited for approval. Nothing was run.`)
    }
    if (answer === 'denied') {
      log('denied', { detail: 'user' })
      throw new Error('The user declined this call. Nothing was run.')
    }
    if (answer === 'timeout') {
      log('timed out')
      throw new Error(`No one approved the call within ${APPROVAL_TIMEOUT_MS / 60_000} minutes, so it was refused. Nothing was run.`)
    }
  }

  try {
    const out = await runtimeCall(c, m.manifest, op, args, planned.upload)
    if (killedAll() || connectorState(c.connectorId)?.disabled) throw new Error('Connectors were switched off while this ran, so its result is withheld.')
    let text = typeof out === 'string' ? scrub(out) : scrubDeep(out, scrub)
    if (select !== undefined || limit !== undefined) text = narrowBody(text as { body?: unknown; notes?: string[] }, select, limit)
    const status = (out as { status?: unknown })?.status
    const rows = dbDetail(out)
    const detail = (ask ? 'user' : `auto (${c.safety})`) + (typeof status === 'number' ? `, HTTP ${status}` : '') + (rows ? `, ${rows}` : '')
    const resultBytes = JSON.stringify(text).length
    touchConnection(c.id)
    confirmMigration()
    const split = splitResult(text, pageChars(deps.pageChars?.()))
    if (split.pages.length === 1) {
      log(ask ? 'approved' : 'automatic', { detail, resultBytes })
      return text
    }
    // longer than a page: the first page now, the rest held in memory for this agent and project (pages.ts)
    const totalBytes = Buffer.byteLength(typeof text === 'string' ? text : JSON.stringify(text))
    const base = { pages: split.pages, labels: split.labels, how: split.how, totalBytes }
    const id = hold({
      ...base,
      owner: ownerOf(scope),
      connectionId: c.id,
      connectionName: c.name,
      connectorId: c.connectorId,
      connector: `${m.manifest.id}@${m.manifest.version}`,
      operation: op.name,
      cls,
      connectionUpdatedAt: c.updatedAt,
      request: scrub(request).slice(0, 2000)
    })
    const first = split.pages[0]
    log(ask ? 'approved' : 'automatic', { detail: `${detail}, page 1 of ${split.pages.length}`, resultBytes, page: 1, pages: split.pages.length, resultId: id ?? undefined, returnedBytes: Buffer.byteLength(first) })
    if (!id) return pageOut(first, `[Page 1 of ${split.pages.length} (${totalBytes.toLocaleString('en-US')} bytes in total). The rest is too large for Corvid to hold, so it is not available: call again with select and limit, or ask for less.]`)
    return pageOut(first, footer({ ...base, id }, 1))
  } catch (e) {
    const msg = scrub((e as Error).message)
    log(ask ? 'approved' : 'automatic', { error: msg })
    throw new Error(msg)
  }
}

/** select and limit on an http result's body; the rest of the result (status, headers) stays as it was. */
function narrowBody(r: { body?: unknown; notes?: string[] }, select: string | undefined, limit: number | undefined): unknown {
  if (r.body === null || r.body === undefined || typeof r.body === 'string') {
    if (select !== undefined) throw new Error(`select needs a JSON response; this one is ${r.body ? 'text' : 'empty'}. The request ran once and its result was not returned.`)
    return { ...r, notes: [...(r.notes ?? []), 'limit was not applied: the response is not JSON.'] }
  }
  const n = narrow(r.body, select, limit)
  return { ...r, body: n.value, notes: [...(r.notes ?? []), n.note].filter(Boolean) }
}

/**
 * call_more (#104): another page of a result this agent got from call() in this project. It reads what Corvid
 * holds, so it never sends the request again and never asks again; it still checks the kill switch, the connector
 * and the connection, and every read is audited with its page and size.
 */
export function callMore(scope: AgentScope, resultId: string, page: number): PageOut {
  const owner = ownerOf(scope)
  const found = lookup(owner, resultId)
  if (!found.ok) {
    const o = found.other
    // someone else's id: refused, and audited against the connection it belongs to
    if (o) auditCall({ ts: Date.now(), agent: scope.agent, project: owner.project, connection: o.connectionName, connector: o.connector, operation: o.operation, class: o.cls, decision: 'refused', detail: 'call_more on a result made by another agent or project', request: o.request, durationMs: 0, resultId: o.id })
    throw new Error(found.why)
  }
  const h = found.held
  const c = getConnection(h.connectionId)
  const m = getManifest(h.connectorId)
  const refuse = (why: string, dropWhy: string): never => {
    dropHeld((x) => x.id === h.id, dropWhy)
    auditCall({ ts: Date.now(), agent: scope.agent, project: owner.project, connection: h.connectionName, connector: h.connector, operation: h.operation, class: h.cls, decision: 'refused', detail: `call_more: ${why}`, request: h.request, durationMs: 0, resultId: h.id })
    throw new Error(why)
  }
  if (killedAll()) refuse('All connectors are switched off in Corvid right now. Nothing was returned.', 'connectors were switched off')
  if (!c || !m || !mine(scope).some((x) => x.id === c.id)) return refuse(`${h.connectionName} is no longer linked to this project, so its held result was dropped.`, 'the connection is gone from this project')
  if (c.updatedAt !== h.connectionUpdatedAt) refuse(`${h.connectionName} was changed after the call, so its held result was dropped. Run the call again.`, 'the connection was changed')
  if (!connectorGate(connectorState(h.connectorId), m.hash, false).ok) refuse('That connector is switched off or no longer approved in Corvid. Nothing was returned.', 'its connector is switched off or no longer approved')
  const n = Number(page)
  if (!Number.isInteger(n) || n < 1 || n > h.pages.length) throw new Error(`Result ${h.id} has pages 1 to ${h.pages.length}.`)
  const text = h.pages[n - 1]
  const bytes = Buffer.byteLength(text)
  auditCall({
    ts: Date.now(),
    agent: scope.agent,
    project: owner.project,
    connection: h.connectionName,
    connector: h.connector,
    operation: h.operation,
    class: h.cls,
    decision: 'automatic',
    detail: `call_more: page ${n} of ${h.pages.length}, from the held result (nothing sent)`,
    request: h.request,
    resultBytes: h.totalBytes,
    durationMs: 0,
    page: n,
    pages: h.pages.length,
    resultId: h.id,
    returnedBytes: bytes
  })
  return pageOut(text, footer(h, n))
}

/**
 * The class of this call, a one-line summary of what will run (logged, and shown under Strict unless `shown` gives
 * the exact request), and why it asks. Throws when the runtime would refuse the request anyway.
 */
function classifyCall(
  c: Connection,
  m: ConnectorManifest,
  op: Operation,
  args: Record<string, unknown>,
  scope: AgentScope
): { cls: OpClass; request: string; why: string; shown?: string; warnings?: string[]; upload?: UploadPlan } {
  if (m.runtime === 'http') {
    const s = httpSettings(m, c.config)
    const r = planRequest(m, s, op, args)
    return { cls: r.cls, request: auditLine(r), why: r.why, shown: shownRequest(r, s), warnings: httpWarnings(s) }
  }
  if (isDialect(m.runtime)) {
    const r = planDbCall(m, c.config, op, args)
    return { cls: r.cls, request: r.request, why: r.why, shown: r.shown, warnings: r.warnings }
  }
  if (m.runtime === 'ssh' && op.name === 'upload') {
    // the file is checked and read now, so what the user approves is exactly what is sent
    const cwd = scope.cwd ?? scope.project
    const upload = planUpload(args, {
      roots: scope.uploadRoots?.() ?? [],
      rules: denyRules(scope.project, cwd),
      cwd,
      maxBytes: m.limits.maxUploadBytes ?? DEFAULT_MAX_UPLOAD,
      hasKnownSecret
    })
    return {
      cls: op.class,
      request: auditUpload(upload),
      why: 'Sends a file to the server.',
      shown: shownUpload(upload),
      warnings: upload.overwrite ? [`Replaces ${upload.remote} on the server if it exists.`] : [],
      upload
    }
  }
  if (m.runtime === 'ssh') {
    const command = String(args.command ?? '')
    if (op.class === 'admin') return { cls: 'admin', request: `sudo -n ${command}`, why: 'Runs as root.' }
    if (op.classifier === 'ssh-command') {
      const r = classify(command)
      return { cls: r.readOnly ? 'read' : 'write', request: command, why: r.readOnly ? 'Read-only command.' : `Not recognised as read-only: ${r.reason}.` }
    }
  }
  return { cls: op.class, request: `${op.name} ${JSON.stringify(args)}`, why: `${op.name} is a ${op.class} operation.` }
}

/** Runtimes: ssh, http and the databases. */
async function runtimeCall(c: Connection, m: ConnectorManifest, op: Operation, args: Record<string, unknown>, upload?: UploadPlan): Promise<unknown> {
  if (m.runtime === 'http' || isDialect(m.runtime)) {
    const ac = new AbortController()
    const handle = { stop: () => ac.abort(new Error('Connectors were switched off, so this call was stopped.')) }
    running.add(handle)
    try {
      return await (m.runtime === 'http' ? httpCall : dbCall)(c, m, op, args, ac.signal)
    } finally {
      running.delete(handle)
    }
  }
  if (m.runtime !== 'ssh') throw new Error(`The ${m.runtime} runtime is not in this version of Corvid yet.`)
  const sys: RemoteSystem | undefined = getSystem(c.id)
  if (!sys) throw new Error(`${c.name} has no SSH server behind it any more.`)
  if (op.name === 'upload') {
    if (!upload) throw new Error('The upload was not checked, so nothing was sent.')
    const ac = new AbortController()
    const handle = { stop: () => ac.abort(new Error('Connectors were switched off, so this upload was stopped; the file on the server may be incomplete.')) }
    running.add(handle)
    try {
      const r = await uploadFile(sys, upload.data, upload.remote, { overwrite: upload.overwrite, mode: upload.mode }, m.limits.timeoutMs, ac.signal)
      return {
        remote_path: upload.remote,
        bytes: r.bytes,
        sha256: upload.sha256,
        replaced: r.replaced,
        ...(upload.mode !== undefined && { mode: upload.mode.toString(8).padStart(4, '0') }),
        ...(r.newHostKey && { first_connection: `remembered host key ${r.newHostKey}` }),
        check: `sha256sum '${upload.remote.replace(/'/g, `'\''`)}'`
      }
    } finally {
      running.delete(handle)
    }
  }
  const command = String(args.command ?? '')
  if (!command.trim()) throw new Error('The command is empty.')
  const timeoutS = Math.min(m.limits.timeoutMs / 1000, Math.max(1, Math.round(Number(args.timeout_seconds) || 60)))
  const full = op.class === 'admin' ? `sudo -n sh -c '${command.replace(/'/g, `'\\''`)}'` : command
  let stop: () => void = () => {}
  const stopped = new Promise<never>((_, reject) => (stop = () => reject(new Error('Connectors were switched off, so this call was stopped.'))))
  const handle = { stop: () => stop() }
  running.add(handle)
  try {
    const r = await Promise.race([runCommand(sys, full, timeoutS * 1000), stopped])
    const cap = (s: string): string => (s.length > m.limits.maxResponseBytes ? s.slice(0, m.limits.maxResponseBytes) + '\n[cut off]' : s)
    return [
      `exit code: ${r.code ?? (r.signal ? `killed (${r.signal})` : 'none')}${r.timedOut ? ` (timed out after ${timeoutS}s)` : ''}`,
      r.newHostKey ? `first connection: remembered host key ${r.newHostKey}` : '',
      r.stdout ? `--- stdout ---\n${cap(r.stdout)}` : '(no stdout)',
      r.stderr ? `--- stderr ---\n${cap(r.stderr)}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  } finally {
    running.delete(handle)
  }
}

// ---------- tools ----------

export function describe(c: Connection): Record<string, unknown> {
  const m = getManifest(c.connectorId)
  const s = connectorState(c.connectorId)
  return {
    name: c.name,
    type: m?.manifest.name ?? c.connectorId,
    connector: m ? `${m.manifest.id}@${m.manifest.version}` : c.connectorId,
    approved: !!m && s?.status === 'approved' && s.decidedHash === m.hash && !s.disabled,
    safety: SAFETY_TEXT[c.safety],
    operations: m?.manifest.capabilities.operations.map((o) => ({ name: o.name, class: o.class })) ?? []
  }
}

/** The connection tools for one agent's project, or null when it has none. */
export function connectionsAccess(scope: AgentScope): { tools: ToolDef[]; allowed: string[]; prompt: string } | null {
  const list = mine(scope)
  if (!list.length) return null
  return {
    tools: connectionTools(scope),
    // Corvid applies approvals and safety levels itself, so Claude Code doesn't ask a second time
    allowed: ['list_connections', 'describe_connection', 'call', 'call_more'],
    prompt:
      `Connections linked to this project: ${list.map((c) => c.name).join(', ')}. Use them with mcp__corvid__call, by name (mcp__corvid__list_connections and describe_connection show their operations). ` +
      'Corvid holds the credentials and uses them for you: never ask for, look for or write down passwords, tokens or keys. Some calls wait for the user to approve them in Corvid. ' +
      'A long result comes back one page at a time with a footer naming its result id; read further pages with mcp__corvid__call_more only if you need them. Large results cost the user usage: for JSON APIs, pass select (like "[*].title" or "[*]{id,title}") and limit to get only what you need.'
  }
}

const NEVER = 'Refer to connections by name only. You never get credentials, and must never ask the user for them or write them down anywhere.'

export function connectionTools(scope: AgentScope): ToolDef[] {
  return [
    {
      name: 'list_connections',
      description: `List the connections (servers, APIs, databases) linked to the project you are working in: name, type, operations with their class (read, write, admin), safety level and whether the user has approved the connector. ${NEVER}`,
      input: {},
      readOnly: true,
      run: () => {
        const list = mine(scope)
        return list.length ? list.map(describe) : 'No connections are linked to this project.'
      }
    },
    {
      name: 'describe_connection',
      description: `Describe one connection: what it can reach and do, in plain words, its operations with their input, and its safety level. ${NEVER}`,
      input: { name: z.string().describe('connection name, from list_connections') },
      readOnly: true,
      run: (a: { name: string }) => {
        const c = findConnection(scope, a.name)
        const m = getManifest(c.connectorId)
        return {
          ...describe(c),
          summary: m ? connectionSummary(m.manifest, c) : 'The connector is missing.',
          operations: m?.manifest.capabilities.operations.map((o) => ({ name: o.name, class: o.class, description: o.description, input: o.input })) ?? []
        }
      }
    },
    {
      name: 'call',
      description:
        'Run one operation on a connection linked to this project; Corvid uses the saved credentials and returns the result with known secrets masked as [redacted]. ' +
        "The connector must be approved by the user on first use, and the connection's safety level may make the call wait up to 3 minutes for the user; it fails if they decline or don't answer. " +
        'A result longer than a page (about 20,000 characters) returns its first page and a footer with a result id: read on with call_more. ' +
        'Pages break between JSON array items or rows, and between lines of text. Large results cost the user usage, so for an HTTP JSON response ask for less: ' +
        'select keeps part of the body (a path such as "posts[*].title", "[*]{id,title}" or "data.items[0]"), limit keeps the first N items. ' +
        NEVER,
      input: {
        connection: z.string().describe('connection name'),
        operation: z.string().describe('operation name, from describe_connection'),
        args: z.record(z.string(), z.unknown()).optional().describe("the operation's input"),
        select: z
          .string()
          .optional()
          .describe('HTTP JSON only: the part of the response body to return, done by Corvid. Names, [n], [*] for every item and a final {a,b} to keep some fields, e.g. "[*]{id,title}"'),
        limit: z.number().int().optional().describe('HTTP JSON only: keep the first N items of the body, or of the selection when it is an array')
      },
      run: (a: { connection: string; operation: string; args?: Record<string, unknown>; select?: string; limit?: number }) =>
        call(scope, a.connection, a.operation, a.args ?? {}, { select: a.select, limit: a.limit })
    },
    {
      name: 'call_more',
      description:
        'Read another page of a long call() result, by the result id in its footer. It returns what Corvid already holds: nothing is sent again and nothing is asked again. ' +
        'Results are held in memory for 10 minutes after the last read, only for you and this project. Read only the pages you need; to get less, run call again with select and limit.',
      input: {
        result_id: z.string().describe('the result id from the footer, like r1a2b3c4d5'),
        page: z.number().int().describe('the page to read, from 1')
      },
      readOnly: true,
      run: (a: { result_id: string; page: number }) => callMore(scope, a.result_id, a.page)
    }
  ]
}
