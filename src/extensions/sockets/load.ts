// Loading extensions into their sockets (#102), the same way in the main process and in the window. Each extension
// is tried on its own: one that is switched off registers nothing, one built for a newer socket API is skipped with a
// clear reason, and one that throws is logged, has whatever it registered removed, and is skipped. None of this can
// stop Corvid from starting.

/** The socket API this Corvid offers. An extension declares the version it was written for in `api`. */
export const EXTENSION_API_VERSION = 1

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Folder names under src/extensions that aren't extensions. */
const RESERVED = new Set(['sockets'])

/** The header every extension's entry point exports, in the main process and in the window alike. */
export interface ExtensionHeader {
  /** the extension's id: its folder name, and the `id` in its .corvid file */
  id: string
  name: string
  /** the socket API version it was written for */
  api: number
}

export interface ExtensionModule<S> extends ExtensionHeader {
  /** Called once at start-up (and again after its flag is switched back on), with the sockets it may use. */
  register: (sockets: S) => void
}

export type LoadState = 'loaded' | 'off' | 'skipped' | 'failed'

export interface LoadResult {
  id: string
  name: string
  api: number
  state: LoadState
  /** for skipped and failed: why, in plain words */
  reason?: string
  /** how many things it registered */
  registered: number
}

export interface LoadDeps {
  /** the per-extension flag from the config: false registers nothing */
  enabled: (id: string) => boolean
  /** the crash log (#83) */
  log: (what: string, details: string) => void
}

/** The parts of a socket set the loader needs: the sockets for one owner, a count of what it holds, and removal. */
export interface SocketHost<S> {
  socketsFor: (owner: string) => S
  count: (owner: string) => number
  removeOwner: (owner: string) => void
}

const errText = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e))

/** A header problem in plain words, or null. */
export function headerProblem(m: Partial<ExtensionHeader> | null | undefined): string | null {
  if (!m || typeof m !== 'object') return 'It exports no extension.'
  if (typeof m.id !== 'string' || m.id.length < 3 || m.id.length > 64 || !ID.test(m.id)) return 'Its id must be 3 to 64 lowercase letters, digits and single hyphens.'
  if (RESERVED.has(m.id)) return `"${m.id}" is reserved.`
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60) return 'Its name must be 1 to 60 characters.'
  if (typeof m.api !== 'number' || !Number.isInteger(m.api) || m.api < 1) return 'It must declare the socket API version it was written for (api: 1).'
  if (m.api > EXTENSION_API_VERSION)
    return `It needs socket API ${m.api}, and this Corvid offers ${EXTENSION_API_VERSION}. Update Corvid, or use a version of the extension written for API ${EXTENSION_API_VERSION}.`
  return null
}

export function loadExtensions<S>(mods: ExtensionModule<S>[], host: SocketHost<S>, deps: LoadDeps): LoadResult[] {
  const out: LoadResult[] = []
  const seen = new Set<string>()
  for (const m of mods) {
    const id = typeof m?.id === 'string' ? m.id : '(no id)'
    const base = { id, name: typeof m?.name === 'string' ? m.name : id, api: typeof m?.api === 'number' ? m.api : 0, registered: 0 }
    const problem = headerProblem(m) ?? (seen.has(id) ? 'Another extension already has this id.' : typeof m.register !== 'function' ? 'It has no register function.' : null)
    if (problem) {
      deps.log(`Extension ${id} skipped`, problem)
      out.push({ ...base, state: 'skipped', reason: problem })
      continue
    }
    seen.add(id)
    if (!deps.enabled(id)) {
      out.push({ ...base, state: 'off' })
      continue
    }
    try {
      m.register(host.socketsFor(id))
      out.push({ ...base, state: 'loaded', registered: host.count(id) })
    } catch (e) {
      host.removeOwner(id)
      deps.log(`Extension ${id} failed to load and was skipped`, errText(e))
      out.push({ ...base, state: 'failed', reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}
