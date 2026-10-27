import type { CwdFacts, ImportCandidate, ProjectFolder, ProjectRecord } from './types'
import { baseName, worktreeRoot } from './projects'
import { hostOs, keySep, pathKey, within } from './pathKeys'

// The explicit project list (#73): matching folders to projects, and the import's skip rules.
// Pure functions, shared by main and the window; #74's Unfiled inbox reuses skipReason.

/** projectKey with one kind of separator, so D:/x and d:\x compare equal: pathKey on this machine's platform. */
export const normKey = (path: string): string => pathKey(path)

export { within }

export const primaryFolder = (p: ProjectRecord): string => (p.folders.find((f) => f.primary) ?? p.folders[0])?.path ?? ''

/** A folder's label, else its folder name (3/5). */
export const folderName = (f: ProjectFolder): string => f.label || baseName(f.path)

/** The folder of a project that `cwd` is in (the deepest; a worktree counts as its repo's folder), if any. */
export function folderFor(cwd: string, p: ProjectRecord, facts?: CwdFacts): ProjectFolder | undefined {
  const tryKey = (key: string): ProjectFolder | undefined => {
    let best: { f: ProjectFolder; len: number } | undefined
    for (const f of p.folders)
      for (const path of [f.path, ...f.pastPaths]) {
        const k = normKey(path)
        if (within(key, k) && (!best || k.length > best.len)) best = { f, len: k.length }
      }
    return best?.f
  }
  const direct = tryKey(normKey(cwd))
  if (direct) return direct
  const repo = facts?.repo ?? worktreeRoot(cwd) ?? undefined
  return repo ? tryKey(normKey(repo)) : undefined
}

/** Every path a project answers to: each folder's current and past paths. */
export function projectPaths(p: ProjectRecord): string[] {
  return p.folders.flatMap((f) => [f.path, ...f.pastPaths])
}

export type FolderMatch =
  | { id: string; how: 'folder' | 'worktree' }
  /** a second clone of a project's repo: not merged automatically, the Unfiled inbox (2/5) suggests it */
  | { suggest: string; how: 'remote' }
  | null

/** The project with the deepest folder (current or past) that holds `key`. */
function byFolder(key: string, projects: ProjectRecord[]): string | undefined {
  let best: { id: string; len: number } | undefined
  for (const p of projects)
    for (const path of projectPaths(p)) {
      const f = normKey(path)
      if (within(key, f) && (!best || f.length > best.len)) best = { id: p.id, len: f.length }
    }
  return best?.id
}

const normRemote = (u: string): string =>
  u
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/|ssh:\/\/|git@)/, '')
    .replace(/:/, '/')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '')

/**
 * Which project a session's or task's folder belongs to, in this order: the folder (or a past path of it),
 * exactly or inside it; a git worktree whose repo is the project's folder (agent worktrees count as the
 * parent project); the same git remote (a second clone: only a suggestion). Null means unfiled.
 */
export function matchFolder(cwd: string, projects: ProjectRecord[], facts?: CwdFacts): FolderMatch {
  if (!cwd) return null
  const key = normKey(cwd)
  const direct = byFolder(key, projects)
  if (direct) return { id: direct, how: 'folder' }
  const repo = facts?.repo ?? worktreeRoot(cwd) ?? undefined
  if (repo && normKey(repo) !== key) {
    const id = byFolder(normKey(repo), projects)
    if (id) return { id, how: 'worktree' }
  }
  if (facts?.remote) {
    const r = normRemote(facts.remote)
    const p = projects.find((x) => x.remotes.some((u) => normRemote(u) === r))
    if (p) return { suggest: p.id, how: 'remote' }
  }
  return null
}

/** The project id a folder files under, or undefined (unfiled, including second clones). */
export function projectIdFor(cwd: string, projects: ProjectRecord[], facts?: Record<string, CwdFacts>): string | undefined {
  const m = matchFolder(cwd, projects, facts?.[normKey(cwd)])
  return m && 'id' in m ? m.id : undefined
}

/** A project by id, folder path, exact name, or part of its name; archived ones only when nothing else fits. */
export function findRecord(projects: ProjectRecord[], q: string): ProjectRecord | undefined {
  if (!q) return undefined
  const byId = projects.find((p) => p.id === q)
  if (byId) return byId
  const n = q.trim().toLowerCase()
  const order = [...projects.filter((p) => !p.archived), ...projects.filter((p) => p.archived)]
  const key = normKey(q)
  return (
    order.find((p) => projectPaths(p).some((f) => normKey(f) === key)) ??
    order.find((p) => p.name.toLowerCase() === n) ??
    order.find((p) => p.name.toLowerCase().includes(n))
  )
}

/** Where Corvid and Claude keep temporary and private folders; set by main (os.tmpdir(), userData, …). */
export interface SkipEnv {
  tempDirs: string[]
  /** Corvid's data folders: the one in use and the other name it has had (Corvid, Claude Dashboard) */
  dataDirs: string[]
  /** whose path rules apply: this machine's by default (the tests pass darwin and linux) */
  os?: string
}

/** Folder names that read as a throwaway: test, tmp, scratch, hello-test, proj, sandbox… */
export const THROWAWAY = /^(?:te?mp|tmp\d*|test\w*|.*[-_]test|hello\w*|scratch\w*|sandbox|playground|proj|demo|foo|bar|try\w*|untitled\w*)$/i

/** A session title Corvid gives the sessions it starts: "#12 Fix the thing · Agent Name", "New project · x". */
export const corvidTitle = (title: string): boolean => /^#\d+ /.test(title) || /^New project · /.test(title)

/**
 * Why a folder should not be offered as a project, or null to offer it. Everything Corvid made itself or
 * that is only temporary is left out: worktrees, temp and scratchpad folders, Corvid's own data folders,
 * folders whose sessions Corvid started for tasks, gone folders with nothing to show, one-off scratch folders.
 */
export function skipReason(c: ImportCandidate, env: SkipEnv): string | null {
  const os = env.os ?? hostOs()
  const key = pathKey(c.path, os)
  const inside = (folder: string): boolean => within(key, pathKey(folder, os), os)
  const parent = c.parentRepo ?? worktreeRoot(c.path)
  if (c.worktree || parent) return `Git worktree${parent ? ` of ${baseName(parent)}` : ''}: its sessions count under the parent project`
  if (env.tempDirs.some((t) => t && inside(t)) || /[\\/](?:temp|tmp)[\\/]claude[\\/]|[\\/]scratchpad(?:[\\/]|$)/i.test(key))
    return 'Temporary or scratchpad folder'
  if (env.dataDirs.some((d) => inside(pathKey(d, os) + keySep(os) + 'assistant'))) return "Corvid assistant's working folder"
  if (env.dataDirs.some((d) => inside(d))) return "Corvid's own data folder"
  if (c.userAdded) return null
  if (c.sessions > 0 && c.corvidSessions >= c.sessions) return 'Every session here was started by Corvid (task agents or /usage polls)'
  if (!c.exists && !c.isRepo && c.sessions < 5) return 'Folder no longer exists and has no git history to show for it'
  if (c.exists && !c.isRepo && c.sessions <= 1 && THROWAWAY.test(baseName(c.path))) return 'One-off scratch folder: a single session and no git'
  return null
}
