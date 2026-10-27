import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CwdFacts, ImportCandidate, ProjectFolder, ProjectRecord, ProjectsFile, ProjectsState, RelocateCheck, SessionSummary, UnfiledDecisions } from '@shared/types'
import { baseName } from '@shared/projects'
import { corvidTitle, findRecord, folderName, matchFolder, normKey, projectPaths, skipReason, within, type SkipEnv } from '@shared/projectList'
import { getConfig } from './config'
import { repoFacts } from './git'
import { realDataDirs } from './dataDir'
import { staleWorktrees } from './agentGit'
import { tempDirs } from './platform'

// The explicit project list (#73), in <data>\projects.json. Projects are added by the user (New Project,
// the import); nothing is guessed from sessions any more. Removing one only takes it off the list.

const file = (): string => join(app.getPath('userData'), 'projects.json')

let data: ProjectsFile = { version: 1, nextId: 1, importOffered: false, projects: [] }
let cwds: Record<string, CwdFacts> = {}
let emit: (s: ProjectsState) => void = () => {}
let sessions: () => SessionSummary[] = () => []
let agentSessions: () => Set<string> = () => new Set()

function load(): void {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<ProjectsFile>
    const projects = Array.isArray(raw.projects) ? raw.projects : []
    data = {
      version: 1,
      // never below an id in use, so ids are never reused
      nextId: Math.max(raw.nextId ?? 1, ...projects.map((p) => Number(p.id.replace(/^p/, '')) + 1).filter(Number.isFinite)),
      importOffered: !!raw.importOffered,
      projects,
      ...(raw.unfiled ? { unfiled: raw.unfiled } : {})
    }
  } catch {
    /* first run: the import preview offers the old list */
  }
}

function save(): void {
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file())
  emit(projectsState())
}

export function projectsState(): ProjectsState {
  const missing = data.projects.filter((p) => !p.folders.some((f) => f.primary && existsSync(f.path))).map((p) => p.id)
  const missingFolders = data.projects.flatMap((p) => p.folders.filter((f) => !existsSync(f.path)).map((f) => normKey(f.path)))
  const undoMerge = undo && undo.until > Date.now() ? { into: undo.into.id, from: undo.from.id, until: undo.until } : undefined
  return { projects: data.projects, importOffered: data.importOffered, missing, missingFolders, cwds, undoMerge }
}

export function listProjects(): ProjectRecord[] {
  return data.projects
}

export function initProjectStore(d: {
  changed: (s: ProjectsState) => void
  sessions: () => SessionSummary[]
  /** session ids Corvid started for tasks (agents.json) */
  agentSessions: () => Set<string>
}): void {
  emit = d.changed
  sessions = d.sessions
  agentSessions = d.agentSessions
  load()
}

const checking = new Set<string>()
/** Learn the repo (and remote) behind each folder sessions ran in, so worktrees match their parent project. */
export async function learnCwds(paths: string[]): Promise<void> {
  const fresh = [...new Map(paths.filter(Boolean).map((p) => [normKey(p), p])).entries()].filter(([k]) => !cwds[k] && !checking.has(k))
  if (!fresh.length) return
  for (const [k] of fresh) checking.add(k)
  const next = { ...cwds }
  const queue = [...fresh]
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const [k, p] = queue.shift()!
        const f = existsSync(p) ? await repoFacts(p).catch(() => null) : null
        next[k] = f ? { repo: f.repo, worktree: f.worktree || undefined, remote: f.remotes[0] } : {}
      }
    })
  )
  cwds = next
  emit(projectsState())
}

export function projectFolder(id: string | undefined): string | undefined {
  const p = id ? data.projects.find((x) => x.id === id) : undefined
  return p ? ((p.folders.find((f) => f.primary) ?? p.folders[0])?.path) : undefined
}

/** One of a project's folders by label or path (a past path counts), as its current path; undefined if none fits. */
export function projectSubfolder(id: string | undefined, q: string): string | undefined {
  const p = id ? data.projects.find((x) => x.id === id) : undefined
  if (!p || !q.trim()) return undefined
  const n = q.trim().toLowerCase()
  const k = normKey(q)
  return (p.folders.find((f) => f.label?.toLowerCase() === n) ?? p.folders.find((f) => [f.path, ...f.pastPaths].some((x) => normKey(x) === k)))?.path
}

export function resolveProject(q: string | undefined): ProjectRecord | undefined {
  return q ? findRecord(data.projects, q) : undefined
}

/** The project a folder files under (worktrees count as their repo's project), or undefined. */
export function projectIdForPath(path: string): string | undefined {
  const m = matchFolder(path, data.projects, cwds[normKey(path)])
  return m && 'id' in m ? m.id : undefined
}

export type AddResult = { project: ProjectRecord } | { error: string; existing?: ProjectRecord }

/** Is this folder already a project, inside one, or a worktree of one? Then say so instead of adding it twice. */
export async function checkAddable(path: string): Promise<{ error: string; existing?: ProjectRecord } | null> {
  const key = normKey(path)
  if (key === normKey(homedir())) return { error: "Your home folder can't be a project. Pick a folder inside it." }
  const facts = await repoFacts(path).catch(() => null)
  const m = matchFolder(path, data.projects, facts ? { repo: facts.repo, worktree: facts.worktree } : undefined)
  if (m && 'id' in m) {
    const p = data.projects.find((x) => x.id === m.id)!
    const exact = projectPaths(p).some((f) => normKey(f) === key)
    const why = exact ? 'is already the project' : m.how === 'worktree' ? 'is a git worktree of the project' : 'is inside the project'
    return { error: `${baseName(path)} ${why} ${p.name}${p.archived ? ' (archived)' : ''}.`, existing: p }
  }
  return null
}

export async function addProject(input: { path: string; name?: string; pinned?: boolean; now?: number }): Promise<AddResult> {
  const blocked = await checkAddable(input.path)
  if (blocked) return blocked
  const facts = await repoFacts(input.path).catch(() => null)
  const project: ProjectRecord = {
    id: `p${data.nextId++}`,
    name: input.name?.trim() || baseName(input.path),
    pinned: !!input.pinned,
    archived: false,
    createdAt: input.now ?? Date.now(),
    folders: [{ path: input.path, primary: true, pastPaths: [] }],
    remotes: facts?.remotes ?? [],
    ...(facts?.firstCommit ? { firstCommit: facts.firstCommit } : {})
  }
  data.projects.push(project)
  save()
  return { project }
}

// ---------- Corvid's own project (#78) ----------

/** package.json's name in a folder, if it has one. */
function packageName(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }).name
  } catch {
    return undefined
  }
}

/** A folder holding Corvid's source: package.json named "corvid" and a git checkout. */
export const isCorvidSource = (dir: string): boolean => packageName(dir) === 'corvid' && existsSync(join(dir, '.git'))

/**
 * Make sure Corvid's own project is on the list. Candidates for its source, in order: the folder the last
 * deploy built from (`sources`, from corvid-source.json), the folder a dev run runs from. An existing
 * project whose folder is one of them, or holds Corvid's package.json, becomes the built-in one (same id,
 * tasks, notes and sessions, renamed Corvid). Otherwise one is added, on the source if found, else on the
 * install folder (`fallback`) until the source is set up.
 */
export function ensureBuiltin(sources: string[], fallback: string): void {
  if (data.projects.some((p) => p.builtin === 'corvid')) return
  const keys = new Set(sources.map(normKey))
  const mine = data.projects.find((p) => p.folders.some((f) => keys.has(normKey(f.path)))) ?? data.projects.find((p) => p.folders.some((f) => isCorvidSource(f.path)))
  if (mine) {
    mine.builtin = 'corvid'
    mine.name = 'Corvid'
    mine.pinned = true
    mine.archived = false
  } else {
    const path = sources.find(isCorvidSource) ?? fallback
    data.projects.unshift({ id: `p${data.nextId++}`, name: 'Corvid', pinned: true, archived: false, createdAt: Date.now(), folders: [{ path, primary: true, pastPaths: [] }], remotes: [], builtin: 'corvid' })
  }
  save()
}

export const builtinProject = (): ProjectRecord | undefined => data.projects.find((p) => p.builtin === 'corvid')

/** Point Corvid's project at a (new) source folder: it becomes the primary folder, the old path a past path. */
export function setBuiltinSource(path: string): ProjectRecord | { error: string } {
  const p = builtinProject()
  if (!p) return { error: "Corvid's project is missing." }
  if (!isCorvidSource(path)) return { error: `${baseName(path)} isn't a checkout of Corvid's source (no package.json named corvid, or no git).` }
  const other = data.projects.find((o) => o !== p && o.folders.some((f) => normKey(f.path) === normKey(path)))
  if (other) return { error: `${baseName(path)} already belongs to ${other.name}. Remove it there first.` }
  const f = p.folders.find((x) => x.primary) ?? p.folders[0]
  if (f && normKey(f.path) !== normKey(path)) {
    if (isCorvidSource(f.path)) f.pastPaths.push(f.path)
    f.path = path
  }
  save()
  return p
}

export function updateProject(id: string, patch: Partial<Pick<ProjectRecord, 'name' | 'pinned' | 'archived'>>): ProjectRecord | undefined {
  const p = data.projects.find((x) => x.id === id)
  if (!p) return undefined
  if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim()
  if (typeof patch.pinned === 'boolean') p.pinned = patch.pinned
  // Corvid's own project can be unpinned, never archived (#78)
  if (typeof patch.archived === 'boolean' && !p.builtin) p.archived = patch.archived
  save()
  return p
}

/** Takes it off the list only: no folder, session or task is deleted. */
export function removeProject(id: string): boolean {
  const before = data.projects.length
  data.projects = data.projects.filter((x) => x.id !== id || x.builtin)
  if (data.projects.length === before) return false
  save()
  return true
}

export function skipEnv(): SkipEnv {
  return {
    // Windows: tmpdir, LOCALAPPDATA\Temp, TEMP, TMP; macOS adds tmpdir's /private realpath (#151)
    tempDirs: tempDirs(),
    dataDirs: [app.getPath('userData'), ...realDataDirs(app.getPath('appData'))]
  }
}

/**
 * The folders the old model showed (from sessions, pins and New project), checked against the skip rules.
 * Read-only: nothing is added until applyImport.
 */
export async function importCandidates(): Promise<ImportCandidate[]> {
  const config = getConfig()
  const home = normKey(homedir())
  const agents = agentSessions()
  const pinned = new Set(config.pinnedProjects.map(normKey))
  const added = new Set(config.addedProjects.map((a) => normKey(a.path)))
  const groups = new Map<string, { path: string; list: SessionSummary[] }>()
  const add = (path: string, s?: SessionSummary): void => {
    const k = normKey(path)
    if (k === home) return
    const g = groups.get(k) ?? { path, list: [] }
    if (s) g.list.push(s)
    groups.set(k, g)
  }
  for (const s of sessions()) if (s.cwd) add(s.cwd, s)
  for (const p of config.pinnedProjects) add(p)
  for (const a of config.addedProjects) add(a.path)

  // A session in a repo's subfolder counts under the repo's top folder.
  const merged = new Map<string, { path: string; list: SessionSummary[]; facts: Awaited<ReturnType<typeof repoFacts>> }>()
  const entries = [...groups.values()]
  const queue = [...entries]
  const facts = new Map<string, Awaited<ReturnType<typeof repoFacts>>>()
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const g = queue.shift()!
        facts.set(normKey(g.path), existsSync(g.path) ? await repoFacts(g.path).catch(() => null) : null)
      }
    })
  )
  for (const g of entries) {
    const f = facts.get(normKey(g.path)) ?? null
    const path = f && !f.worktree ? f.top : g.path
    const k = normKey(path)
    const m = merged.get(k) ?? { path, list: [], facts: f }
    m.list.push(...g.list)
    merged.set(k, m)
  }

  const env = skipEnv()
  const out: ImportCandidate[] = []
  for (const [k, m] of merged) {
    const f = m.facts
    const corvid = m.list.filter((s) => s.junk || corvidTitle(s.title) || agents.has(s.id)).length
    const c: ImportCandidate = {
      path: m.path,
      name: baseName(m.path),
      pinned: pinned.has(k),
      exists: existsSync(m.path),
      isRepo: !!f,
      worktree: !!f?.worktree,
      parentRepo: f?.worktree ? f.repo : undefined,
      remote: f?.remotes[0],
      firstCommit: f?.firstCommit,
      branch: f?.branch,
      sessions: m.list.length,
      corvidSessions: corvid,
      lastActivity: Math.max(0, ...m.list.map((s) => s.lastActivity), ...config.addedProjects.filter((a) => normKey(a.path) === k).map((a) => a.addedAt)),
      userAdded: pinned.has(k) || added.has(k),
      checked: false
    }
    c.skip = skipReason(c, env) ?? undefined
    const match = matchFolder(m.path, data.projects, f ? { repo: f.repo, worktree: f.worktree } : undefined)
    c.already = !!(match && 'id' in match)
    c.checked = !c.skip && !c.already && c.exists
    out.push(c)
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity)
}

/** Add the picked folders. Safe to run twice: a folder already on the list (or inside or a worktree of one) is left alone. */
export async function applyImport(picks: { path: string; name?: string; pinned?: boolean }[]): Promise<{ added: number; skipped: number }> {
  let added = 0
  for (const p of picks) {
    const r = await addProject(p)
    if ('project' in r) added++
  }
  markImportOffered()
  return { added, skipped: picks.length - added }
}

export function markImportOffered(): void {
  if (data.importOffered) return
  data.importOffered = true
  save()
}

export const projectsFileExists = (): boolean => existsSync(file())


// ---------- several folders per project (3/5) ----------

export type AddFolderResult =
  | { project: ProjectRecord; warning?: string }
  | { error: string }
  /** the folder is a one-folder project of its own: offered as a merge (projectMerge.ts) */
  | { merge: string }

/**
 * Add a folder to a project. Refused when it's in another project (a folder belongs to one project), inside or
 * around one of this project's folders, or a worktree. A folder that is a one-folder project of its own comes
 * back as { merge } so the window can show what merging would move. A second clone of a folder already in the
 * project is added with a warning.
 */
export async function addFolder(id: string, path: string, label?: string): Promise<AddFolderResult> {
  const p = data.projects.find((x) => x.id === id)
  if (!p) return { error: 'That project is no longer on the list.' }
  const key = normKey(path)
  if (key === normKey(homedir())) return { error: "Your home folder can't be a project folder. Pick a folder inside it." }
  if (!existsSync(path)) return { error: `${path} doesn't exist.` }
  for (const f of p.folders) {
    const fk = normKey(f.path)
    if (fk === key) return { error: `${baseName(path)} is already a folder of ${p.name}.` }
    if (within(key, fk)) return { error: `Not added: ${baseName(path)} is inside the folder ${folderName(f)}, which is already part of ${p.name}, so its sessions already count here.` }
    if (within(fk, key))
      return { error: `Not added: ${baseName(path)} holds the folder ${folderName(f)}, which is already part of ${p.name}. Folders inside each other aren't allowed; take ${folderName(f)} off first to use the outer folder instead.` }
  }
  for (const o of data.projects) {
    if (o.id === id) continue
    const exact = o.folders.find((f) => normKey(f.path) === key)
    if (exact && o.folders.length === 1) return { merge: o.id }
    const where = `${o.name}${o.archived ? ' (archived)' : ''}`
    if (exact) return { error: `${baseName(path)} already belongs to ${where}. A folder can be in one project only; remove it there first.` }
    const outer = o.folders.find((f) => within(key, normKey(f.path)))
    if (outer) return { error: `${baseName(path)} is inside ${folderName(outer)}, which belongs to ${where}. A folder can be in one project only.` }
    const inner = o.folders.find((f) => within(normKey(f.path), key))
    if (inner) return { error: `${baseName(path)} holds ${folderName(inner)}, which belongs to ${where}. Folders inside each other aren't allowed.` }
  }
  const facts = await repoFacts(path).catch(() => null)
  if (facts?.worktree) return { error: `${baseName(path)} is a git worktree of ${baseName(facts.repo)}. Add the repo itself; its worktrees count with it.` }
  let warning: string | undefined
  if (facts) {
    for (const f of p.folders) {
      const o = existsSync(f.path) ? await repoFacts(f.path).catch(() => null) : null
      const sameRoot = !!o?.firstCommit && o.firstCommit === facts.firstCommit
      const sameRemote = !!o && facts.remotes.some((r) => o.remotes.includes(r))
      if (sameRoot || sameRemote) {
        warning = `${baseName(path)} looks like a clone of ${folderName(f)} (${sameRemote ? 'same remote' : 'same first commit'}). Added anyway; check that's what you meant.`
        break
      }
    }
  }
  const clean = label?.trim()
  p.folders.push({ path, primary: false, pastPaths: [], ...(clean ? { label: clean } : {}) })
  for (const r of facts?.remotes ?? []) if (!p.remotes.includes(r)) p.remotes.push(r)
  save()
  return { project: p, warning }
}

/** Take a folder off a project; nothing on disk changes. Removing the primary needs the folder that takes over. */
export function removeFolder(id: string, path: string, newPrimary?: string): { project: ProjectRecord } | { error: string } {
  const p = data.projects.find((x) => x.id === id)
  const f = p?.folders.find((x) => normKey(x.path) === normKey(path))
  if (!p || !f) return { error: 'That folder is no longer in the project.' }
  if (p.folders.length === 1) return { error: `${folderName(f)} is ${p.name}'s only folder. Remove the project instead.` }
  if (f.primary) {
    const next = newPrimary ? p.folders.find((x) => x !== f && normKey(x.path) === normKey(newPrimary)) : undefined
    if (!next) return { error: `${folderName(f)} is the primary folder. Choose which folder becomes primary first.` }
    next.primary = true
    f.primary = false
  }
  p.folders = p.folders.filter((x) => x !== f)
  save()
  return { project: p }
}

/** Primary, label and order of a project's folders. */
export function editFolder(id: string, path: string, patch: { primary?: boolean; label?: string; move?: number }): ProjectRecord | undefined {
  const p = data.projects.find((x) => x.id === id)
  const i = p ? p.folders.findIndex((x) => normKey(x.path) === normKey(path)) : -1
  if (!p || i < 0) return undefined
  const f = p.folders[i]
  if (patch.primary) for (const x of p.folders) x.primary = x === f
  if (typeof patch.label === 'string') {
    const clean = patch.label.trim()
    if (clean) f.label = clean
    else delete f.label
  }
  const j = i + Math.sign(patch.move ?? 0)
  if (j !== i && j >= 0 && j < p.folders.length) [p.folders[i], p.folders[j]] = [p.folders[j], p.folders[i]]
  save()
  return p
}

export function getProject(id: string): ProjectRecord | undefined {
  return data.projects.find((x) => x.id === id)
}

/** What undoMerge puts back; kept in memory for UNDO_MS, like the task board's undo. */
interface MergeUndo {
  until: number
  into: ProjectRecord
  from: ProjectRecord
  fromIndex: number
  restore: () => void
}
let undo: MergeUndo | undefined
export const UNDO_MS = 10 * 60_000

const copy = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/**
 * Move `from`'s folders into `into` and take `from` off the list. The folders keep their paths, so sessions,
 * notes and path-keyed settings follow on their own; `moveTasks` re-files the tasks and returns how to put them back.
 */
export function mergeProjects(intoId: string, fromId: string, moveTasks: () => () => void): { project: ProjectRecord } | { error: string } {
  const into = data.projects.find((x) => x.id === intoId)
  const fromIndex = data.projects.findIndex((x) => x.id === fromId)
  const from = data.projects[fromIndex]
  if (!into || !from || into === from) return { error: 'Those projects are no longer on the list.' }
  if (from.builtin) return { error: "Corvid's own project can't be merged into another. Merge the other project into it instead." }
  const before = copy(into)
  const saved = copy(from)
  const restoreTasks = moveTasks()
  into.folders.push(...from.folders.map((f): ProjectFolder => ({ ...f, primary: false, label: f.label || from.name })))
  for (const r of from.remotes) if (!into.remotes.includes(r)) into.remotes.push(r)
  into.pinned = into.pinned || from.pinned
  data.projects.splice(fromIndex, 1)
  undo = { until: Date.now() + UNDO_MS, into: before, from: saved, fromIndex, restore: restoreTasks }
  // the window drops its Undo button when the time is up
  setTimeout(() => emit(projectsState()), UNDO_MS + 1000)
  save()
  return { project: into }
}

/** Put the last merge back: both records as they were, and every moved task. */
export function undoMerge(): { error?: string } {
  const u = undo
  if (!u || u.until < Date.now()) return { error: 'The merge can no longer be undone.' }
  const i = data.projects.findIndex((x) => x.id === u.into.id)
  if (i < 0) return { error: `${u.into.name} was removed after the merge, so it can't be undone.` }
  // folders added to the project after the merge stay; the merged-in ones go back
  const fromKeys = new Set(u.from.folders.map((f) => normKey(f.path)))
  const had = new Set(u.into.folders.map((f) => normKey(f.path)))
  const kept = data.projects[i].folders.filter((f) => !fromKeys.has(normKey(f.path)) && !had.has(normKey(f.path)))
  data.projects[i] = { ...u.into, folders: [...u.into.folders, ...kept] }
  data.projects.splice(Math.min(u.fromIndex, data.projects.length), 0, u.from)
  undo = undefined
  u.restore()
  save()
  return {}
}

/** The Unfiled inbox's decisions (#74), stored with the project list. */
export function unfiledDecisions(): UnfiledDecisions {
  const u = data.unfiled
  return { ignored: u?.ignored ?? [], dismissed: u?.dismissed ?? [], seenAt: u?.seenAt ?? 0 }
}

export function setUnfiledDecisions(next: UnfiledDecisions): void {
  data.unfiled = next
  save()
}

/**
 * "Add to an existing project" from the Unfiled inbox (#74): the folder becomes a past path of the project's
 * main folder, so its sessions file under that project. Nothing on disk moves.
 */
export function addAlias(id: string, path: string): ProjectRecord | { error: string } {
  const p = data.projects.find((x) => x.id === id)
  if (!p) return { error: 'That project is no longer on the list.' }
  const f = p.folders.find((x) => x.primary) ?? p.folders[0]
  if (!f) return { error: `${p.name} has no folder.` }
  if (projectPaths(p).some((x) => normKey(x) === normKey(path))) return p
  f.pastPaths.push(path)
  save()
  return p
}

// ---------- moved and missing folders (4/5) ----------

let lastMissing = ''
/** Look again for missing folders (on window focus): a drive that comes back clears the mark, without a word. */
export function recheckMissing(): void {
  const s = projectsState()
  const sig = [...s.missing, '|', ...(s.missingFolders ?? [])].join(',')
  if (sig === lastMissing) return
  lastMissing = sig
  emit(s)
}

/** How a picked folder compares with the one it would replace; nothing changes. */
export async function relocateCheck(id: string, from: string, to: string): Promise<RelocateCheck> {
  const p = data.projects.find((x) => x.id === id)
  const f = p?.folders.find((x) => normKey(x.path) === normKey(from))
  if (!p || !f) return { error: 'That folder is no longer in the project.' }
  if (!existsSync(to)) return { error: `${to} doesn't exist.` }
  const key = normKey(to)
  if (key === normKey(from)) return { error: `That's the folder ${folderName(f)} already uses.` }
  if (key === normKey(homedir())) return { error: "Your home folder can't be a project folder. Pick a folder inside it." }
  for (const o of data.projects)
    for (const x of o.folders) {
      if (x === f) continue
      const xk = normKey(x.path)
      if (xk === key || within(key, xk) || within(xk, key))
        return { error: `${baseName(to)} ${xk === key ? 'is' : within(key, xk) ? 'is inside' : 'holds'} ${folderName(x)}, which already belongs to ${o.name}${o.archived ? ' (archived)' : ''}.` }
    }
  const facts = await repoFacts(to).catch(() => null)
  if (facts?.worktree) return { error: `${baseName(to)} is a git worktree of ${baseName(facts.repo)}. Pick the repo itself.` }
  const remotes = p.remotes.length ? p.remotes : []
  const sameRemote = !!facts && facts.remotes.some((r) => remotes.includes(r))
  const sameRoot = !!facts?.firstCommit && facts.firstCommit === p.firstCommit
  const sameName = baseName(to).toLowerCase() === baseName(f.path).toLowerCase()
  const why = sameRemote ? 'same git remote' : sameRoot ? 'same first commit' : sameName ? 'same folder name' : undefined
  return {
    same: !!why,
    why:
      why ??
      (facts
        ? `${baseName(to)} has a different git remote and history than ${p.name}, so it may be another project.`
        : `${baseName(to)} isn't a git repo and has a different name than ${baseName(f.path)}, so it may be another project.`)
  }
}

/**
 * Point a project's folder at its new place. The old path joins the folder's past paths, so every session, task and
 * note from there still belongs to the project. Nothing on disk is moved, copied or deleted.
 */
export async function relocateFolder(id: string, from: string, to: string): Promise<{ project: ProjectRecord; staleWorktrees: string[] } | { error: string }> {
  const check = await relocateCheck(id, from, to)
  if ('error' in check) return check
  const p = data.projects.find((x) => x.id === id)!
  const f = p.folders.find((x) => normKey(x.path) === normKey(from))!
  const old = f.path
  f.path = to
  f.pastPaths = [...f.pastPaths.filter((x) => normKey(x) !== normKey(to) && normKey(x) !== normKey(old)), old]
  const facts = await repoFacts(to).catch(() => null)
  for (const r of facts?.remotes ?? []) if (!p.remotes.includes(r)) p.remotes.push(r)
  if (!p.firstCommit && facts?.firstCommit) p.firstCommit = facts.firstCommit
  save()
  // agents' task worktrees still linked to the old place need a `git worktree repair`, which is left to the user
  const stale = facts && !facts.worktree ? await staleWorktrees(to).catch(() => []) : []
  return { project: p, staleWorktrees: stale }
}

/**
 * Folders that look like a new home for a project: another clone with the same git remote, found among the folders
 * sessions ran in, that isn't a folder of any project yet and exists.
 */
export function cloneSuggestions(id: string): string[] {
  const p = data.projects.find((x) => x.id === id)
  if (!p || !p.remotes.length) return []
  const norm = (u: string): string => u.trim().toLowerCase().replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const mine = new Set(p.remotes.map(norm))
  const taken = data.projects.flatMap((o) => o.folders.map((f) => normKey(f.path)))
  const out = new Map<string, string>()
  for (const [k, c] of Object.entries(cwds)) {
    if (!c.remote || c.worktree || !mine.has(norm(c.remote))) continue
    const top = c.repo ?? k
    const tk = normKey(top)
    if (taken.some((t) => within(tk, t) || within(t, tk)) || !existsSync(top)) continue
    out.set(tk, top)
  }
  return [...out.values()]
}

/**
 * Where a folder from a session or task is now: unchanged when it exists; else, if it was inside a folder's past path,
 * the same place under the folder's current path. Undefined when it's missing and no project moved it.
 */
export function currentPathFor(path: string): string | undefined {
  if (existsSync(path)) return path
  const key = normKey(path)
  for (const p of data.projects)
    for (const f of p.folders)
      for (const past of f.pastPaths) {
        const pk = normKey(past)
        if (!within(key, pk)) continue
        const moved = join(f.path, path.slice(past.length).replace(/^[\/]+/, ''))
        if (existsSync(moved)) return moved
      }
  return undefined
}

/** The past paths of the project folder now at `path` (4/5), so an agent's session from before a move still counts. */
export function pastPathsOf(path: string): string[] {
  const k = normKey(path)
  for (const p of data.projects) for (const f of p.folders) if (normKey(f.path) === k) return f.pastPaths
  return []
}
