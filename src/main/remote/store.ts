import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RemoteSystem, RemoteSystemInput, RemoteSystemView, SafetyLevel } from '@shared/types'
import { projectKey } from '@shared/projects'
import { decryptSecret, encryptSecret } from '../secureStorage'

// Everything lives in <data>\remote\, outside any repo:
//   connections.json  connection info, no secrets (safe to show, export)
//   secrets.json      passwords and passphrases, each encrypted with system secure storage (secureStorage.ts)
//   known-hosts.json  host key fingerprints, remembered on first connect
// Secrets are decrypted only in the main process, at connect time, and never sent to the renderer.

type SecretKind = 'password' | 'passphrase'

interface KnownHost {
  type: string
  fingerprint: string
  firstSeen: number
}

const dir = (): string => join(app.getPath('userData'), 'remote')
const path = (name: string): string => join(dir(), name)

let systems: RemoteSystem[] = []
let secrets: Record<string, Partial<Record<SecretKind, string>>> = {}
let knownHosts: Record<string, KnownHost> = {}

function read<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

function write(name: string, data: unknown): void {
  mkdirSync(dir(), { recursive: true })
  const tmp = path(name) + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path(name))
}

export function initStore(): void {
  systems = read<{ systems?: RemoteSystem[] }>('connections.json', {}).systems ?? []
  secrets = read('secrets.json', {})
  knownHosts = read('known-hosts.json', {})
}

const hostKeyId = (s: Pick<RemoteSystem, 'host' | 'port'>): string => `${s.host.toLowerCase()}:${s.port}`

export function view(s: RemoteSystem): RemoteSystemView {
  const k = knownHosts[hostKeyId(s)]
  return {
    ...s,
    hasPassword: !!secrets[s.id]?.password,
    hasPassphrase: !!secrets[s.id]?.passphrase,
    hostKey: k ? `${k.type} ${k.fingerprint}` : undefined
  }
}

export const listSystems = (): RemoteSystem[] => systems
export const listViews = (): RemoteSystemView[] => systems.map(view)
export const getSystem = (id: string): RemoteSystem | undefined => systems.find((s) => s.id === id)

/** Systems an agent working in `project` may use. */
export function systemsForProject(project: string): RemoteSystem[] {
  const k = projectKey(project)
  return systems.filter((s) => s.projects.some((p) => projectKey(p) === k))
}


function setSecret(id: string, kind: SecretKind, value: string | null | undefined): void {
  if (value === undefined) return
  const entry = (secrets[id] ??= {})
  if (value === null || value === '') delete entry[kind]
  else {
    // Never fall back to plain text: encryptSecret throws the reason when there's no real keyring.
    entry[kind] = encryptSecret(value)
  }
  if (!Object.keys(entry).length) delete secrets[id]
}

/** Main process only: decrypt at connect time. */
export function getSecret(id: string, kind: SecretKind): string | undefined {
  const enc = secrets[id]?.[kind]
  if (!enc) return undefined
  return decryptSecret(enc)
}

/** Every stored secret, decrypted, for scrubbing command output. */
export function allSecretValues(): string[] {
  const out: string[] = []
  for (const id of Object.keys(secrets)) {
    for (const kind of ['password', 'passphrase'] as const) {
      try {
        const v = getSecret(id, kind)
        if (v) out.push(v)
      } catch {
        /* undecryptable (another user/machine): nothing to scrub */
      }
    }
  }
  return out
}

const SAFETY: SafetyLevel[] = ['free', 'approve-writes', 'strict']

export function saveSystem(input: RemoteSystemInput): RemoteSystemView {
  const name = input.name.trim()
  const host = input.host.trim()
  const user = input.user.trim()
  const port = Math.round(Number(input.port) || 22)
  if (!name) throw new Error('Give the system a name.')
  if (!/^[\w.-]+$/.test(name)) throw new Error('Use letters, digits, dot, dash or underscore in the name; agents refer to it by name.')
  if (!host || /\s/.test(host)) throw new Error('Enter a host name or address.')
  if (!user) throw new Error('Enter the user to log in as.')
  if (port < 1 || port > 65535) throw new Error('The port must be between 1 and 65535.')
  if (systems.some((s) => s.id !== input.id && s.name.toLowerCase() === name.toLowerCase()))
    throw new Error(`There is already a system called ${name}.`)
  if (input.auth === 'key' && !input.keyPath?.trim()) throw new Error('Choose the private key file.')

  const now = Date.now()
  const existing = input.id ? getSystem(input.id) : undefined
  const sys: RemoteSystem = {
    id: existing?.id ?? randomUUID(),
    name,
    host,
    port,
    user,
    auth: input.auth === 'password' ? 'password' : 'key',
    keyPath: input.auth === 'key' ? input.keyPath!.trim() : undefined,
    projects: [...new Set(input.projects.map((p) => p.replace(/[\\/]+$/, '')))],
    // new systems start strict
    safety: SAFETY.includes(input.safety) ? input.safety : 'strict',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  // An empty field means "keep what's stored"; null clears it. Switching auth type drops the other kind.
  const keep = (v: string | null | undefined): string | null | undefined => (v === '' ? undefined : v)
  const pw = sys.auth === 'password' ? keep(input.password) : null
  if (sys.auth === 'password' && (pw === null || (!pw && !secrets[sys.id]?.password))) throw new Error('Enter the password.')
  setSecret(sys.id, 'password', pw)
  setSecret(sys.id, 'passphrase', sys.auth === 'key' ? keep(input.passphrase) : null)

  if (existing) systems[systems.indexOf(existing)] = sys
  else systems.push(sys)
  write('secrets.json', secrets)
  write('connections.json', { systems })
  return view(sys)
}

export function deleteSystem(id: string): void {
  systems = systems.filter((s) => s.id !== id)
  delete secrets[id]
  write('secrets.json', secrets)
  write('connections.json', { systems })
}

/** For sharing or backup: connection info only. Secrets, host keys and ids stay behind. */
export function exportSystems(): string {
  const items = systems.map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest)
  return JSON.stringify({ corvid: 'remote-systems', version: 1, note: 'No passwords or passphrases are included.', systems: items }, null, 2)
}

// ---------- host keys ----------

export function knownHost(s: RemoteSystem): KnownHost | undefined {
  return knownHosts[hostKeyId(s)]
}

export function rememberHost(s: RemoteSystem, type: string, fingerprint: string): void {
  knownHosts[hostKeyId(s)] = { type, fingerprint, firstSeen: Date.now() }
  write('known-hosts.json', knownHosts)
}

export function forgetHost(id: string): void {
  const s = getSystem(id)
  if (!s) return
  delete knownHosts[hostKeyId(s)]
  write('known-hosts.json', knownHosts)
}
