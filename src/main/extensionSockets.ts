import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_EXTENSIONS } from '../extensions/mainExtensions'
import { THEME_EXTENSIONS } from '../extensions/themeExtensions'
import { loadThemeExtensions, rejectionNotice, type ThemeSockets } from '../extensions/sockets/theme'
import { loadExtensions, type ExtensionModule, type LoadResult } from '../extensions/sockets/load'
import { clearMainSockets, extensionAccess, extensionConnectors, mainHost, mainSocketCounts, setTakenCommands, type MainSockets, type ToolAuditEntry } from '../extensions/sockets/main'
import type { AccessPart } from './agentAccess'
import { logCrash, scrubSecrets } from './crashLog'
import { allConnectionSecrets } from './connectors/store'
import { validateManifest } from './connectors/manifest'
import { draftsState, proposeConnector } from './connectors/drafts'

// The main process's side of the extension sockets (#102): loads the extensions in src/extensions/mainExtensions.ts
// into their sockets at start-up and when their flags change, and hands the core what they registered. Every way in
// goes through an existing gate: worker tools through the worker's own token, Claude Code's permission prompt and an
// audit line; connectors through propose_connector's validator and the user's review; commands only from the user's
// own typing (slashCommands.ts).

export interface SocketDeps {
  enabled: (id: string) => boolean
  /** a quiet notice for the user: the window's start-up notices */
  notice: (text: string) => void
  /** the command names the core already uses, so an extension can't shadow one */
  takenCommands: () => string[]
  /** Corvid's own project folder, which extension connector drafts are filed under */
  corvidFolder: () => string | undefined
}

let deps: SocketDeps | undefined
let results: LoadResult[] = []
let mods: ExtensionModule<MainSockets>[] = MAIN_EXTENSIONS
let themeMods: ExtensionModule<ThemeSockets>[] = THEME_EXTENSIONS

/** Loads (or reloads) every extension; one that is off, too new or broken is skipped and the rest still load. */
export function loadMainExtensions(d: SocketDeps = deps!, list: ExtensionModule<MainSockets>[] = mods): LoadResult[] {
  deps = d
  mods = list
  clearMainSockets()
  setTakenCommands(d.takenCommands)
  results = loadExtensions(list, mainHost, { enabled: d.enabled, log: (what, details) => logCrash('main', what, details) })
  const bad = results.filter((r) => r.state === 'failed' || r.state === 'skipped')
  if (bad.length) d.notice(`${bad.length === 1 ? 'An extension was' : `${bad.length} extensions were`} skipped: ${bad.map((r) => `${r.name} (${r.reason})`).join('; ')} Details are in the crash log.`)
  offerConnectors()
  loadMainThemes(d)
  return results
}

/**
 * The theme extensions (#114), so the saved theme, the window background and the first paint know them. Main logs and
 * reports what was skipped; the window loads the same index quietly for the picker and the Extensions page.
 */
export function loadMainThemes(d: Pick<SocketDeps, 'enabled' | 'notice'> = deps!, list: ExtensionModule<ThemeSockets>[] = themeMods): ReturnType<typeof loadThemeExtensions> {
  themeMods = list
  const load = loadThemeExtensions(list, { enabled: d.enabled, log: (what, details) => logCrash('main', what, details) })
  const bad = load.results.filter((r) => r.state === 'failed' || r.state === 'skipped')
  if (bad.length) d.notice(`${bad.length === 1 ? 'A theme extension was' : `${bad.length} theme extensions were`} skipped: ${bad.map((r) => `${r.name} (${r.reason})`).join('; ')} Details are in the crash log.`)
  const rejected = rejectionNotice(load)
  if (rejected) d.notice(rejected)
  return load
}

/** For the Extensions tab: each extension's state and what it registered in the main process. */
export const mainExtensionStates = (): (LoadResult & { counts: Record<string, number> })[] => results.map((r) => ({ ...r, counts: mainSocketCounts(r.id) }))

// ---------- worker access ----------

const auditFile = (): string => join(app.getPath('userData'), 'extension-tool-audit.jsonl')

function audit(e: ToolAuditEntry): void {
  try {
    const f = auditFile()
    if (existsSync(f) && statSync(f).size > 1024 * 1024) renameSync(f, f + '.1')
    appendFileSync(f, JSON.stringify(e) + '\n')
  } catch (err) {
    console.error('extension tool audit failed', err)
  }
}

/** The crash log's patterns plus every connection secret Corvid holds, longest first. */
function scrub(text: string): string {
  let out = text
  try {
    for (const s of allConnectionSecrets().sort((a, b) => b.length - a.length)) if (s.length >= 4) out = out.split(s).join('[redacted]')
  } catch {
    /* the store isn't readable: the patterns below still apply */
  }
  return scrubSecrets(out)
}

/** The extensions' tools and instruction lines for one worker, bound to its project. */
export const extensionWorkerAccess = (scope: { project: string; agent: string; taskId?: number }): AccessPart | null => extensionAccess(scope, { scrub, audit })

/** The last lines of the audit, newest last (for tests and the tab). */
export function readToolAudit(limit = 100): ToolAuditEntry[] {
  try {
    return readFileSync(auditFile(), 'utf8').trim().split('\n').slice(-limit).map((l) => JSON.parse(l) as ToolAuditEntry)
  } catch {
    return []
  }
}

// ---------- connectors ----------

/** Each connector an extension offers becomes a draft in Connections, once per version: the same validator, rules and
 *  review as an agent's proposal. A draft the user declined isn't offered again; nothing here approves anything. */
function offerConnectors(): void {
  const offers = extensionConnectors()
  if (!offers.length || !deps) return
  const folder = deps.corvidFolder()
  for (const o of offers) {
    const v = validateManifest(JSON.stringify(o.manifest))
    if (!v.ok) {
      logCrash('main', `Extension ${o.owner}: its connector manifest was refused`, v.errors.join('\n'))
      deps.notice(`The ${o.owner} extension offers a connector that isn't valid, so it wasn't proposed. Details are in the crash log.`)
      continue
    }
    let known = false
    try {
      known = draftsState().drafts.some((d) => d.connectorId === v.manifest.id && d.hash === v.hash && d.status !== 'expired')
    } catch {
      /* drafts not loaded: propose and let proposeConnector decide */
    }
    if (known) continue
    if (!folder) {
      deps.notice(`The ${o.owner} extension offers the connector ${v.manifest.name}, but Corvid's own project isn't set up, so it can't be proposed yet.`)
      continue
    }
    try {
      const r = proposeConnector({ project: folder, agent: `extension ${o.owner}`, agentName: `The ${o.owner} extension` }, o.manifest, o.reason, `the ${o.owner} extension in Corvid's source`)
      if (r.saved === false) logCrash('main', `Extension ${o.owner}: its connector wasn't proposed`, (r.errors as string[]).join('\n'))
    } catch (e) {
      logCrash('main', `Extension ${o.owner}: its connector wasn't proposed`, e instanceof Error ? e.message : String(e))
    }
  }
}
