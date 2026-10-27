import { homedir } from 'node:os'
import type { ImportCandidate, ProjectRecord, SessionSummary, UnfiledEntry, UnfiledState } from '@shared/types'
import { matchFolder, normKey, primaryFolder, THROWAWAY, within } from '@shared/projectList'
import { addAlias, importCandidates, listProjects, projectsState, setUnfiledDecisions, unfiledDecisions } from './projectStore'

// The Unfiled inbox (#74): folders Claude sessions ran in that match no project. It is built from the
// import's own scan (importCandidates), so the skip rules (skipReason) are the very same: worktrees, temp and
// scratchpad folders, Corvid's own folders and folders only Corvid started sessions in never show up.
// Nothing is added on its own; the user adds, aliases or ignores. Decisions live in projects.json.

/**
 * Worth showing: at least two sessions; or one session of some size (5+ prompts or 25+ tool calls);
 * or any session in a git repo with a remote. Anything less waits quietly (still searchable and resumable).
 */
const MIN_SESSIONS = 2
const BIG_TURNS = 5
const BIG_TOOLS = 25

let state: UnfiledState = { entries: [], ignored: [], hidden: [], quiet: 0, seenAt: 0, ready: false }
let emit: (s: UnfiledState) => void = () => {}
let sessions: () => SessionSummary[] = () => []
/** the last scan, so a decision or a project change re-sorts without asking git again */
let scanned: ImportCandidate[] | null = null
let timer: NodeJS.Timeout | null = null
let running = false
let again = false

export function initUnfiled(d: { changed: (s: UnfiledState) => void; sessions: () => SessionSummary[] }): void {
  emit = d.changed
  sessions = d.sessions
}

export const unfiledState = (): UnfiledState => state

/** Scan again after `ms` (sessions changed: a minute; nothing sooner is pending). */
export function scheduleScan(ms = 60_000): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void scan()
  }, ms)
}

export async function scan(): Promise<UnfiledState> {
  if (running) {
    again = true
    return state
  }
  running = true
  try {
    scanned = await importCandidates()
    rebuild()
  } finally {
    running = false
  }
  if (again) {
    again = false
    void scan()
  }
  return state
}

/** Re-derive the inbox from the last scan: after a project was added or a decision made. */
export function rebuild(): void {
  if (!scanned) return
  const projects = listProjects()
  const cwds = projectsState().cwds
  const decisions = unfiledDecisions()
  const ignoredKeys = new Set(decisions.ignored.map((i) => normKey(i.path)))
  const dismissed = new Set(decisions.dismissed)
  // the sessions that file under no project, by folder
  const loose = sessions().filter((s) => s.cwd && !fileUnder(s.cwd, projects, cwds))
  // each session counts once, under the deepest scanned folder that holds it
  const keys = scanned.map((c) => normKey(c.path)).sort((a, b) => b.length - a.length)
  const byFolder = new Map<string, SessionSummary[]>()
  for (const s of loose) {
    const k = keys.find((f) => within(normKey(s.cwd), f))
    if (k) byFolder.set(k, [...(byFolder.get(k) ?? []), s])
  }
  const entries: UnfiledEntry[] = []
  const hidden: string[] = []
  const counts = new Map<string, { n: number; last: number }>()
  let quiet = 0
  for (const c of scanned) {
    const key = normKey(c.path)
    if (key === normKey(homedir())) continue
    const mine = byFolder.get(key) ?? []
    if (c.skip) {
      hidden.push(c.path)
      continue
    }
    // filed now (added a moment ago, or every session here sits in a project's subfolder)
    if (!mine.length || fileUnder(c.path, projects, cwds)) continue
    const last = Math.max(...mine.map((s) => s.lastActivity))
    counts.set(key, { n: mine.length, last })
    if (ignoredKeys.has(key)) continue
    const big = mine.some((s) => s.userTurns >= BIG_TURNS || s.toolCalls >= BIG_TOOLS)
    if (mine.length < MIN_SESSIONS && !big && !(c.isRepo && c.remote)) {
      quiet++
      continue
    }
    const suggestion = suggest(c, projects)
    entries.push({
      path: c.path,
      name: c.name,
      exists: c.exists,
      isRepo: c.isRepo,
      branch: c.branch,
      remote: c.remote,
      sessions: mine.length,
      lastActivity: last,
      suggestion: suggestion && !dismissed.has(`${key}|${suggestion.id}`) ? suggestion : undefined,
      scratch: looksScratch(c)
    })
  }
  state = {
    entries: entries.sort((a, b) => b.lastActivity - a.lastActivity),
    ignored: decisions.ignored.map((i) => ({ ...i, sessions: counts.get(normKey(i.path))?.n ?? 0, lastActivity: counts.get(normKey(i.path))?.last ?? 0 })),
    hidden,
    quiet,
    seenAt: decisions.seenAt,
    ready: true
  }
  emit(state)
}

function fileUnder(cwd: string, projects: ProjectRecord[], cwds: ReturnType<typeof projectsState>['cwds']): boolean {
  const m = matchFolder(cwd, projects, cwds[normKey(cwd)])
  return !!(m && 'id' in m)
}

/** A one-line hint: a second clone or copy of a project, or a folder that holds projects. */
function suggest(c: ImportCandidate, projects: ProjectRecord[]): UnfiledEntry['suggestion'] {
  const m = matchFolder(c.path, projects, c.isRepo ? { repo: c.path, remote: c.remote } : undefined)
  if (m && 'suggest' in m) {
    const p = projects.find((x) => x.id === m.suggest)
    if (p) return { id: `clone:${p.id}`, text: `Looks like a second clone of ${p.name} (same git remote)`, projectId: p.id }
  }
  const copy = c.firstCommit ? projects.find((p) => p.firstCommit === c.firstCommit) : undefined
  if (copy) return { id: `clone:${copy.id}`, text: `Looks like a copy of ${copy.name} (same first commit)`, projectId: copy.id }
  const key = normKey(c.path)
  const inside = projects.filter((p) => !p.archived && within(normKey(primaryFolder(p)), key))
  if (inside.length === 1) return { id: `holds:${inside[0].id}`, text: `Holds the ${inside[0].name} project: sessions may have opened a level up`, projectId: inside[0].id }
  if (inside.length > 1) return { id: 'holds', text: `Holds ${inside.length} projects (${inside.slice(0, 3).map((p) => p.name).join(', ')}${inside.length > 3 ? '…' : ''}): a parent folder` }
  const same = projects.find((p) => p.name.toLowerCase() === c.name.toLowerCase())
  if (same) return { id: `name:${same.id}`, text: `Same name as the ${same.name} project`, projectId: same.id }
  return undefined
}

/** A throwaway name (test, tmp, scratch…) in the folder or a folder above it, with no git remote. */
function looksScratch(c: ImportCandidate): boolean {
  if (c.remote) return false
  const parts = c.path.split(/[\\/]/).filter(Boolean).slice(1)
  return parts.some((p) => THROWAWAY.test(p)) || (!c.isRepo && c.sessions <= 2 && /[\\/](?:desktop|downloads)(?:[\\/]|$)/i.test(normKey(c.path)))
}

// ---------- decisions (each save tells index.ts, which rebuilds) ----------

export function ignore(paths: string[], now = Date.now()): void {
  const d = unfiledDecisions()
  const have = new Set(d.ignored.map((i) => normKey(i.path)))
  const add = [...new Map(paths.map((p) => [normKey(p), p])).entries()].filter(([k]) => !have.has(k)).map(([, path]) => ({ path, at: now }))
  if (!add.length) return
  setUnfiledDecisions({ ...d, ignored: [...d.ignored, ...add] })
}

export function restore(paths: string[]): void {
  const d = unfiledDecisions()
  const drop = new Set(paths.map(normKey))
  setUnfiledDecisions({ ...d, ignored: d.ignored.filter((i) => !drop.has(normKey(i.path))) })
}

export function dismissSuggestion(path: string, id: string): void {
  const d = unfiledDecisions()
  const k = `${normKey(path)}|${id}`
  if (d.dismissed.includes(k)) return
  setUnfiledDecisions({ ...d, dismissed: [...d.dismissed, k] })
}

/** The user looked at the inbox: the badge counts only what turns up after this. */
export function markSeen(now = Date.now()): void {
  const d = unfiledDecisions()
  if (!state.entries.some((e) => e.lastActivity > d.seenAt)) return
  setUnfiledDecisions({ ...d, seenAt: now })
}

export function addToProject(id: string, path: string): { project: ProjectRecord } | { error: string } {
  const r = addAlias(id, path)
  return 'error' in r ? r : { project: r }
}
