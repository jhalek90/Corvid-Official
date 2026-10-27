import { app } from 'electron'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Connection, ConnectionAuditEntry, ConnectorInfo, ConnectionView, ConnectionsState, RemoteSystem } from '@shared/types'
import { capabilitySummary, validateManifest, type ConnectorManifest } from './manifest'
import { normalSafety, type ConnectorState } from './policy'
import { BUILTIN_CONNECTORS } from './builtin'
import { decryptSecret, encryptSecret, storageStatus } from '../secureStorage'

// Connectors and connections (#87), all in the data folder, outside every repo:
//   connectors\<id>.json            one manifest per connector (data only, see docs/CONNECTORS.md)
//   connectors\state.json           per connector: status, version, hash, where it came from, the approval;
//                                   and the kill switch
//   connections\connections.json    the user's connections: no secrets, only which slots are set
//   connections\secrets.json        slot values, each encrypted with system secure storage (secureStorage.ts)
//   connections\audit.jsonl         every call, scrubbed, never a secret
//   connections\migration.json      what the move of the SSH servers into connections has done
// None of these are in the rolling backups (backups.ts keeps an allowlist), so secrets aren't multiplied.
// SSH servers stay stored in remote\ for now: the Servers panel and run_on still read them there. Each one is
// mirrored as a connection of the built-in ssh connector, with the same id, and its secret slots point at the
// remote store instead of copying the values.

export interface StoreDeps {
  /** the #73 project id a folder files under */
  projectIdForPath: (path: string) => string | undefined
  remoteSystems: () => RemoteSystem[]
  /** a stored SSH secret, decrypted; main process only */
  remoteSecret: (systemId: string, kind: 'password' | 'passphrase') => string | undefined
}

interface StateFile {
  connectors: Record<string, ConnectorState>
  killSwitch: { all: boolean; changedAt?: number }
}
interface MigrationFile {
  remote?: { version: number; firstAt: number; lastAt: number; runs: number; backup?: string; confirmedAt?: number }
}

const root = (): string => app.getPath('userData')
const cdir = (): string => join(root(), 'connectors')
const ndir = (): string => join(root(), 'connections')
const REMOTE_REF = 'remote:'

let deps: StoreDeps = { projectIdForPath: () => undefined, remoteSystems: () => [], remoteSecret: () => undefined }
let manifests = new Map<string, { manifest?: ConnectorManifest; hash?: string; errors?: string[] }>()
let state: StateFile = { connectors: {}, killSwitch: { all: false } }
let connections: Connection[] = []
let secrets: Record<string, Record<string, string>> = {}
let migration: MigrationFile = {}
let ready = false

function read<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Write to a temporary file, then rename over the old one, so a crash never leaves half a file. */
function writeAtomic(file: string, data: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2))
  renameSync(tmp, file)
}

const saveState = (): void => writeAtomic(join(cdir(), 'state.json'), state)
const saveConnections = (): void => writeAtomic(join(ndir(), 'connections.json'), { version: 1, connections })
const saveSecrets = (): void => writeAtomic(join(ndir(), 'secrets.json'), secrets)

export function initConnectorStore(d: StoreDeps): void {
  deps = d
  state = read<StateFile>(join(cdir(), 'state.json'), { connectors: {}, killSwitch: { all: false } })
  state.connectors ??= {}
  state.killSwitch ??= { all: false }
  connections = read<{ connections?: Connection[] }>(join(ndir(), 'connections.json'), {}).connections ?? []
  secrets = read(join(ndir(), 'secrets.json'), {})
  migration = read(join(ndir(), 'migration.json'), {})
  installBuiltins()
  loadManifests()
  ready = true
  syncRemote()
}

// ---------- connectors ----------

function installBuiltins(): void {
  mkdirSync(cdir(), { recursive: true })
  for (const m of BUILTIN_CONNECTORS) {
    const file = join(cdir(), `${m.id}.json`)
    const want = JSON.stringify(m, null, 2)
    // Built-in manifests are Corvid's own: an edited or older copy is put back, and a new hash asks again.
    if (read<string | null>(file, null) === null || readFileSync(file, 'utf8') !== want) writeAtomic(file, want)
  }
}

function loadManifests(): void {
  manifests = new Map()
  for (const name of readdirSync(cdir()).filter((n) => n.endsWith('.json') && n !== 'state.json')) {
    let text = ''
    try {
      text = readFileSync(join(cdir(), name), 'utf8')
    } catch {
      continue
    }
    const v = validateManifest(text)
    const id = name.replace(/\.json$/, '')
    if (!v.ok) {
      manifests.set(id, { errors: v.errors })
      continue
    }
    if (v.manifest.id !== id) {
      manifests.set(id, { errors: [`The file is named ${name} but the manifest's id is ${v.manifest.id}.`] })
      continue
    }
    manifests.set(id, { manifest: v.manifest, hash: v.hash })
    const builtin = BUILTIN_CONNECTORS.some((b) => b.id === id)
    const s = state.connectors[id]
    if (!s) state.connectors[id] = { status: 'pending', version: v.manifest.version, hash: v.hash, source: builtin ? 'builtin' : 'user' }
    else if (s.hash !== v.hash) {
      // a changed manifest waits for approval again (a switch-off stays)
      state.connectors[id] = { ...s, version: v.manifest.version, hash: v.hash, status: s.status === 'draft' ? 'draft' : 'pending' }
    }
  }
  saveState()
}

export const getManifest = (id: string): { manifest: ConnectorManifest; hash: string } | undefined => {
  const e = manifests.get(id)
  return e?.manifest && e.hash ? { manifest: e.manifest, hash: e.hash } : undefined
}
export const connectorState = (id: string): ConnectorState | undefined => state.connectors[id]
export const killedAll = (): boolean => !!state.killSwitch.all

/** Recorded per connector id, version and hash; only Corvid's own approval dialog and the user's UI call this. */
export function recordDecision(id: string, hash: string, approve: boolean, by: string): void {
  const s = state.connectors[id]
  const m = getManifest(id)
  if (!s || !m || m.hash !== hash) return // the manifest changed while the dialog was open: decide nothing
  state.connectors[id] = { ...s, status: approve ? 'approved' : 'declined', decidedHash: hash, decidedAt: Date.now(), decidedBy: by }
  saveState()
  // the approved version, kept so the Connections tab (#88) can show what changed in a later one
  if (approve) writeAtomic(join(cdir(), 'approved', `${id}.json`), JSON.stringify(m.manifest, null, 2))
}

/** Reads the manifests again after the Connections tab added or deleted one (#88). */
export function reloadManifests(removedId?: string): void {
  if (removedId) delete state.connectors[removedId]
  loadManifests()
}

export function setConnectorDisabled(id: string, disabled: boolean): void {
  const s = state.connectors[id]
  if (!s) return
  s.disabled = disabled
  saveState()
}

/**
 * An approved agent draft (#92): where it came from, and the project it is limited to (none: all projects). Only
 * drafts.ts calls this, from the user's decision in the Connections tab.
 */
export function setAgentOrigin(id: string, draftedBy: string, projectId: string | undefined): void {
  const s = state.connectors[id]
  if (!s) return
  state.connectors[id] = { ...s, source: 'agent', draftedBy, projectId }
  saveState()
}

export function setKillAll(on: boolean): void {
  state.killSwitch = { all: on, changedAt: Date.now() }
  saveState()
}

export function connectorInfos(): ConnectorInfo[] {
  return [...manifests.entries()].map(([id, e]) => {
    const s = state.connectors[id]
    return {
      id,
      name: e.manifest?.name ?? id,
      version: e.manifest?.version ?? '',
      runtime: e.manifest?.runtime ?? '',
      status: e.manifest ? (s?.status ?? 'pending') : 'invalid',
      disabled: !!s?.disabled,
      hash: e.hash ?? '',
      source: s?.source ?? 'user',
      draftedBy: s?.draftedBy,
      projectId: s?.projectId,
      approvedHash: s?.status === 'approved' ? s.decidedHash : undefined,
      decidedAt: s?.decidedAt,
      summary: e.manifest ? capabilitySummary(e.manifest) : '',
      operations: e.manifest?.capabilities.operations.map((o) => ({ name: o.name, class: o.class })) ?? [],
      errors: e.errors
    }
  })
}

// ---------- connections ----------

export const listConnections = (): Connection[] => connections
export const getConnection = (id: string): Connection | undefined => connections.find((c) => c.id === id)

/** Connections an agent on this project may use. One linked to no project is visible to no agent. */
export const connectionsForProject = (projectId: string | undefined): Connection[] =>
  projectId ? connections.filter((c) => c.projectIds.includes(projectId)) : []

export function secretsSet(c: Connection): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const slot of getManifest(c.connectorId)?.manifest.secrets ?? []) out[slot.key] = !!secretValue(c, slot.key)
  return out
}

export const view = (c: Connection): ConnectionView => {
  const { secretRefs: _r, ...rest } = c
  return { ...rest, secretsSet: secretsSet(c) }
}

/** Main process only: a slot's value, for the runtime that uses it. Never returned to a tool or the renderer. */
export function secretValue(c: Connection, slot: string): string | undefined {
  const ref = c.secretRefs[slot]
  if (!ref) return undefined
  if (ref.startsWith(REMOTE_REF)) {
    try {
      return deps.remoteSecret(ref.slice(REMOTE_REF.length), slot as 'password' | 'passphrase')
    } catch {
      return undefined
    }
  }
  const enc = secrets[c.id]?.[slot]
  if (!enc) return undefined
  try {
    return decryptSecret(enc)
  } catch {
    return undefined
  }
}

/** Why a slot that is stored can't be read now (a locked or missing keyring), or undefined when it reads fine or
 *  isn't stored. Main process only; the text never holds the secret. */
export function secretProblem(c: Connection, slot: string): string | undefined {
  const ref = c.secretRefs[slot]
  if (!ref) return undefined
  try {
    if (ref.startsWith(REMOTE_REF)) deps.remoteSecret(ref.slice(REMOTE_REF.length), slot as 'password' | 'passphrase')
    else {
      const enc = secrets[c.id]?.[slot]
      if (enc) decryptSecret(enc)
    }
    return undefined
  } catch (e) {
    return (e as Error).message
  }
}

/** Every secret value Corvid holds for any connection, for the scrubber. */
export function allConnectionSecrets(): string[] {
  const out: string[] = []
  for (const c of connections) for (const slot of Object.keys(c.secretRefs)) {
    const v = secretValue(c, slot)
    if (v) out.push(v)
  }
  return out
}

/** Write-only: a value goes in, nothing comes back but whether it is set. null or '' clears it. */
export function setSecret(connectionId: string, slot: string, value: string | null): boolean {
  const c = getConnection(connectionId)
  if (!c) throw new Error('No such connection.')
  if (!getManifest(c.connectorId)?.manifest.secrets.some((s) => s.key === slot)) throw new Error(`The connector has no secret slot called ${slot}.`)
  if (c.secretRefs[slot]?.startsWith(REMOTE_REF)) throw new Error('SSH secrets are set in the Servers panel for now.')
  const entry = (secrets[c.id] ??= {})
  if (!value) {
    delete entry[slot]
    delete c.secretRefs[slot]
  } else {
    // never falls back to plain text: encryptSecret throws the reason when there's no real keyring
    entry[slot] = encryptSecret(value)
    c.secretRefs[slot] = `${c.id}:${slot}`
  }
  if (!Object.keys(entry).length) delete secrets[c.id]
  saveSecrets()
  saveConnections()
  return !!value
}

export interface ConnectionInput {
  id?: string
  connectorId: string
  name: string
  config: Record<string, string | number | boolean>
  safety?: string
  adminWithoutAsking?: boolean
  projectIds: string[]
}

export function saveConnection(input: ConnectionInput): ConnectionView {
  const name = String(input.name ?? '').trim()
  if (!/^[\w.-]{1,60}$/.test(name)) throw new Error('Use letters, digits, dot, dash or underscore in the name; agents refer to it by name.')
  const m = getManifest(input.connectorId)
  if (!m) throw new Error('That connector is missing or not valid.')
  if (connections.some((c) => c.id !== input.id && c.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a connection called ${name}.`)
  const fields = new Map(m.manifest.config.map((f) => [f.key, f]))
  const config: Connection['config'] = {}
  for (const [k, v] of Object.entries(input.config ?? {})) {
    if (!fields.has(k)) throw new Error(`The connector has no setting called ${k}.`)
    config[k] = v
  }
  for (const f of m.manifest.config) if (f.required && (config[f.key] === undefined || config[f.key] === '')) throw new Error(`Fill in ${f.label}.`)
  const scope = state.connectors[m.manifest.id]?.projectId
  // a connector an agent drafted (#92) is linked to its own project only, until the user makes it available to all
  if (scope && (input.projectIds ?? []).some((p) => String(p) !== scope))
    throw new Error('This connector was proposed for one project and can only be linked to that project until you make it available to all projects (Connectors).')
  const existing = input.id ? getConnection(input.id) : undefined
  if (existing?.origin === 'remote') throw new Error('SSH servers are edited in the Servers panel for now.')
  const now = Date.now()
  const c: Connection = {
    id: existing?.id ?? randomUUID(),
    connectorId: m.manifest.id,
    name,
    config,
    secretRefs: existing?.secretRefs ?? {},
    // new connections start strict
    safety: normalSafety(input.safety),
    adminWithoutAsking: normalSafety(input.safety) === 'free' && input.adminWithoutAsking === true,
    projectIds: [...new Set((input.projectIds ?? []).map(String))],
    origin: 'user',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt
  }
  if (existing) connections[connections.indexOf(existing)] = c
  else connections.push(c)
  saveConnections()
  return view(c)
}

export function deleteConnection(id: string): void {
  const c = getConnection(id)
  if (!c) return
  if (c.origin === 'remote') throw new Error('SSH servers are removed in the Servers panel for now.')
  connections = connections.filter((x) => x !== c)
  delete secrets[id]
  saveSecrets()
  saveConnections()
}

export function touchConnection(id: string): void {
  const c = getConnection(id)
  if (!c) return
  c.lastUsedAt = Date.now()
  saveConnections()
}

/** For sharing: settings only. No secrets, no slot references, no ids. */
export function exportConnections(): string {
  return JSON.stringify(
    {
      corvid: 'connections',
      version: 1,
      note: 'No secrets are included.',
      connections: connections.map((c) => ({ connector: c.connectorId, name: c.name, config: c.config, safety: c.safety, slots: Object.keys(c.secretRefs) }))
    },
    null,
    2
  )
}

// ---------- the SSH servers, mirrored as connections ----------

const REMOTE_FILES = ['connections.json', 'known-hosts.json', 'audit.jsonl', 'audit.1.jsonl']

/**
 * Brings every SSH server in remote\ into connections, keeping its id, name, safety level and linked projects
 * (paths turned into project ids). Safe to run any number of times: each run makes connections match the remote
 * store. It runs at start-up and after every change in the Servers panel. Before the first run it copies the
 * remote files (not secrets.json) aside; the remote files themselves are never changed or deleted here.
 */
export function syncRemote(): void {
  if (!ready) return
  const systems = deps.remoteSystems()
  const now = Date.now()
  if (!migration.remote && systems.length) {
    const dest = join(ndir(), `migration-backup-${now}`)
    mkdirSync(dest, { recursive: true })
    for (const f of REMOTE_FILES) {
      const src = join(root(), 'remote', f)
      if (existsSync(src)) copyFileSync(src, join(dest, f))
    }
    migration.remote = { version: 1, firstAt: now, lastAt: now, runs: 0, backup: dest }
    // SSH was in use before connectors existed: the user already chose to let agents use it
    const s = state.connectors.ssh
    const m = getManifest('ssh')
    if (s && m && s.status === 'pending' && !s.decidedHash) {
      state.connectors.ssh = { ...s, status: 'approved', decidedHash: m.hash, decidedAt: now, decidedBy: 'in use before connectors (#87 migration)' }
      saveState()
    }
  }
  const ids = new Set(systems.map((s) => s.id))
  const before = JSON.stringify(connections)
  connections = connections.filter((c) => c.origin !== 'remote' || ids.has(c.id))
  for (const s of systems) {
    const existing = getConnection(s.id)
    const projectIds: string[] = []
    const unlinkedPaths: string[] = []
    for (const p of s.projects) {
      const id = deps.projectIdForPath(p)
      if (id) projectIds.push(id)
      else unlinkedPaths.push(p)
    }
    const secretRefs: Record<string, string> = {}
    for (const kind of ['password', 'passphrase'] as const) if (safeRemote(s.id, kind)) secretRefs[kind] = `${REMOTE_REF}${s.id}`
    const c: Connection = {
      id: s.id,
      connectorId: 'ssh',
      name: s.name,
      config: { host: s.host, port: s.port, user: s.user, auth: s.auth, ...(s.keyPath ? { key_path: s.keyPath } : {}) },
      secretRefs,
      safety: normalSafety(s.safety),
      adminWithoutAsking: false,
      projectIds: [...new Set(projectIds)],
      unlinkedPaths: unlinkedPaths.length ? unlinkedPaths : undefined,
      origin: 'remote',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastUsedAt: existing?.lastUsedAt
    }
    if (existing) connections[connections.indexOf(existing)] = c
    else connections.push(c)
  }
  if (JSON.stringify(connections) !== before || !existsSync(join(ndir(), 'connections.json'))) saveConnections()
  if (migration.remote) {
    migration.remote.lastAt = now
    migration.remote.runs++
    writeAtomic(join(ndir(), 'migration.json'), migration)
  }
}

const safeRemote = (id: string, kind: 'password' | 'passphrase'): boolean => {
  try {
    return !!deps.remoteSecret(id, kind)
  } catch {
    return false
  }
}

/**
 * The first successful call after the move. Until this is set the old remote files are the fallback; part 2,
 * which replaces the Servers panel, may retire them only after it.
 */
export function confirmMigration(): void {
  if (!migration.remote || migration.remote.confirmedAt) return
  migration.remote.confirmedAt = Date.now()
  writeAtomic(join(ndir(), 'migration.json'), migration)
}
export const migrationInfo = (): MigrationFile => migration

// ---------- audit ----------

const MAX_AUDIT = 5 * 1024 * 1024
const auditFile = (): string => join(ndir(), 'audit.jsonl')

/** One line per call. The caller scrubs the request summary; results are logged only by size. */
export function auditCall(e: ConnectionAuditEntry): void {
  mkdirSync(ndir(), { recursive: true })
  try {
    if (statSync(auditFile()).size > MAX_AUDIT) renameSync(auditFile(), auditFile().replace(/\.jsonl$/, '.1.jsonl'))
  } catch {
    /* no log yet */
  }
  appendFileSync(auditFile(), JSON.stringify(e) + '\n')
}

/** Newest first. */
export function readCallAudit(limit = 200): ConnectionAuditEntry[] {
  try {
    return readFileSync(auditFile(), 'utf8')
      .trim()
      .split('\n')
      .slice(-limit)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ConnectionAuditEntry]
        } catch {
          return []
        }
      })
      .reverse()
  } catch {
    return []
  }
}

export function connectionsState(): ConnectionsState {
  return {
    killSwitch: killedAll(),
    secretStorage: storageStatus(),
    connectors: connectorInfos(),
    connections: connections.map(view),
    migration: migration.remote ? { firstAt: migration.remote.firstAt, runs: migration.remote.runs, confirmedAt: migration.remote.confirmedAt } : undefined
  }
}
