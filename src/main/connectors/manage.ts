import { app } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionAuditEntry, ConnectorDetail } from '@shared/types'
import { readAudit } from '../remote/audit'
import { BUILTIN_CONNECTORS } from './builtin'
import { capabilitySummary, operationText, targetsText, validateManifest, type OpClass } from './manifest'
import { connectorInfos, connectorState, deleteConnection, getManifest, listConnections, readCallAudit, recordDecision, reloadManifests } from './store'

// The Connections tab (#88): what the window needs on top of #87's store to manage connectors. Nothing here
// returns a secret: manifests hold slot labels only (the validator refuses values), and the audit is scrubbed.

const cdir = (): string => join(app.getPath('userData'), 'connectors')
const approvedDir = (): string => join(cdir(), 'approved')

// connectorspproved\<id>.json is written by recordDecision when a version is approved
function approvedCopy(id: string): string | undefined {
  try {
    return readFileSync(join(approvedDir(), `${id}.json`), 'utf8')
  } catch {
    return undefined
  }
}

export function connectorDetail(id: string): ConnectorDetail | undefined {
  const info = connectorInfos().find((c) => c.id === id)
  if (!info) return undefined
  const m = getManifest(id)?.manifest
  const byClass = (k: OpClass): string[] => m?.capabilities.operations.filter((o) => o.class === k).map(operationText) ?? []
  const text = m ? JSON.stringify(m, null, 2) : ''
  const prev = approvedCopy(id)
  return {
    ...info,
    description: m?.description ?? '',
    targets: m ? targetsText(m) : [],
    reads: byClass('read'),
    writes: byClass('write'),
    admin: byClass('admin'),
    secretLabels: m?.secrets.map((s) => s.label) ?? [],
    broad: !!m?.broad,
    manifestText: text,
    // only when the approved version differs from the one now on disk
    previousText: prev && prev.trim() !== text.trim() && connectorState(id)?.decidedHash !== info.hash ? prev : undefined,
    configFields: m?.config.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, default: f.default, description: f.description })) ?? [],
    secretSlots: m?.secrets.map((s) => ({ key: s.key, label: s.label, type: s.type, optional: s.optional })) ?? [],
    usedBy: listConnections()
      .filter((c) => c.connectorId === id)
      .map((c) => c.name)
  }
}

/** Approve or decline from the Connections tab: the same record as the first-use dialog, for exactly this hash. */
export function decideConnector(id: string, hash: string, approve: boolean): void {
  recordDecision(id, hash, approve, approve ? 'user (Connections tab)' : 'declined by user (Connections tab)')
}

/** Checks a pasted or imported manifest with #87's validator; nothing is saved. */
export function checkManifest(text: string): { ok: true; id: string; name: string; version: string; summary: string; exists: boolean } | { ok: false; errors: string[] } {
  const v = validateManifest(text)
  if (!v.ok) return { ok: false, errors: v.errors }
  if (BUILTIN_CONNECTORS.some((b) => b.id === v.manifest.id)) return { ok: false, errors: [`"${v.manifest.id}" is the id of a connector built into Corvid; choose another id.`] }
  return { ok: true, id: v.manifest.id, name: v.manifest.name, version: v.manifest.version, summary: capabilitySummary(v.manifest), exists: !!getManifest(v.manifest.id) }
}

/** Saves a valid manifest as connectors\<id>.json. It waits for approval like any connector: added is not active. */
export function importManifest(text: string): string {
  const r = checkManifest(text)
  if (!r.ok) throw new Error(r.errors.join(' '))
  const v = validateManifest(text)
  if (!v.ok) throw new Error(v.errors.join(' '))
  writeFileSync(join(cdir(), `${v.manifest.id}.json`), JSON.stringify(v.manifest, null, 2))
  reloadManifests()
  return v.manifest.id
}

/** Deletes a connector the user added, and every connection that uses it, with their saved secrets. */
export function deleteConnector(id: string): void {
  if (BUILTIN_CONNECTORS.some((b) => b.id === id)) throw new Error('Connectors built into Corvid can be disabled, not deleted.')
  for (const c of listConnections().filter((x) => x.connectorId === id)) deleteConnection(c.id)
  for (const f of [join(cdir(), `${id}.json`), join(approvedDir(), `${id}.json`)]) if (existsSync(f)) unlinkSync(f)
  reloadManifests(id)
}

/** call's log and run_on's log (remoteudit.jsonl, kept as it was) as one list, newest first. Both are scrubbed. */
export function mergedAudit(limit = 500): ConnectionAuditEntry[] {
  const fromRunOn = readAudit(limit).map(
    (e): ConnectionAuditEntry => ({
      ts: e.ts,
      agent: e.agent,
      project: e.project,
      connection: e.system,
      connector: 'ssh (run_on)',
      operation: 'run_on',
      class: e.readOnly ? 'read' : 'write',
      decision: RUN_ON_DECISION[e.decision],
      detail: e.approvedBy,
      request: e.command,
      resultBytes: e.outputBytes,
      durationMs: e.durationMs,
      error: e.error
    })
  )
  return [...readCallAudit(limit), ...fromRunOn].sort((a, b) => b.ts - a.ts).slice(0, limit)
}
const RUN_ON_DECISION = { auto: 'automatic', approved: 'approved', denied: 'denied', timeout: 'timed out', refused: 'refused' } as const

/** The audit log as JSON lines, for saving: already scrubbed and without results; error texts are left out too. */
export function auditExport(entries: ConnectionAuditEntry[] = mergedAudit(100_000)): string {
  return entries.map(({ error, ...e }) => JSON.stringify({ ...e, ...(error ? { error: 'failed (text left out of the export)' } : {}) })).join('\n') + '\n'
}
