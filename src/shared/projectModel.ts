import type { AppConfig, GitInfo, LiveSession, ProjectsState, SessionSummary } from './types'
import { projectKey } from './projects'
import { folderFor, folderName, normKey, primaryFolder, projectIdFor } from './projectList'
import { relTime } from './time'

export const ACTIVE_MS = 30 * 86400_000
const DAY = 86400_000

export interface Risk {
  id: string
  key: string
  severity: 'warn' | 'serious'
  text: string
}

/** One folder of a project as shown (3/5): each has its own git state and can be missing on its own. */
export interface FolderView {
  path: string
  /** projectKey of the path, the key of its git state */
  key: string
  /** its label, else its folder name */
  name: string
  label?: string
  primary: boolean
  missing: boolean
  git: GitInfo | null | undefined
  sessions: number
}

export interface Project {
  /** the project's id in projects.json */
  id: string
  /** projectKey of the primary folder */
  key: string
  path: string
  name: string
  pinned: boolean
  archived: boolean
  /** Corvid's own project (#78) */
  builtin?: 'corvid'
  /** the folder doesn't exist any more (4/5 handles moves) */
  missing: boolean
  createdAt: number
  /** a session in the last 30 days; only decides which risks are worth flagging */
  active: boolean
  sessions: SessionSummary[]
  lastActivity: number
  live: LiveSession[]
  /** the primary folder's git state: undefined = not checked yet, null = no repo found */
  git: GitInfo | null | undefined
  /** every folder, in the user's order (3/5); one entry for a one-folder project */
  folders: FolderView[]
  daily30: number[]
  risks: Risk[]
}

export function days30(now = Date.now()): string[] {
  const out: string[] = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * DAY)
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  return out
}

/**
 * The user's projects (#73), with the sessions that file under each: by folder (or a past path), or as a
 * worktree of the project's repo. Sessions that match nothing are unfiled and not shown here.
 */
export function buildProjects(
  state: ProjectsState | null,
  sessions: Record<string, SessionSummary>,
  live: LiveSession[],
  git: Record<string, GitInfo | null>,
  config: AppConfig | null,
  now = Date.now()
): Project[] {
  const records = state?.projects ?? []
  const missing = new Set(state?.missing ?? [])
  const missingFolders = new Set(state?.missingFolders ?? [])
  const byId = new Map<string, Project>()
  const recordOf = new Map(records.map((r) => [r.id, r]))
  for (const r of records) {
    const path = primaryFolder(r)
    const folders = r.folders.map(
      (f): FolderView => ({
        path: f.path,
        key: projectKey(f.path),
        name: folderName(f),
        label: f.label,
        primary: f.path === path,
        missing: missingFolders.has(normKey(f.path)),
        git: git[projectKey(f.path)],
        sessions: 0
      })
    )
    byId.set(r.id, {
      id: r.id,
      key: projectKey(path),
      path,
      name: r.name,
      pinned: r.pinned,
      archived: r.archived,
      ...(r.builtin ? { builtin: r.builtin } : {}),
      missing: missing.has(r.id),
      createdAt: r.createdAt,
      active: false,
      sessions: [],
      lastActivity: 0,
      live: [],
      git: git[projectKey(path)],
      folders,
      daily30: [],
      risks: []
    })
  }
  // the same folder comes up for many sessions; match each once
  const memo = new Map<string, string | undefined>()
  const idFor = (cwd: string): string | undefined => {
    const k = normKey(cwd)
    if (!memo.has(k)) memo.set(k, projectIdFor(cwd, records, state?.cwds))
    return memo.get(k)
  }
  for (const s of Object.values(sessions)) {
    if (!s.cwd) continue
    const p = byId.get(idFor(s.cwd) ?? '')
    if (!p) continue
    p.sessions.push(s)
    p.lastActivity = Math.max(p.lastActivity, s.lastActivity)
    if (p.folders.length > 1) {
      const f = folderFor(s.cwd, recordOf.get(p.id)!, state?.cwds[normKey(s.cwd)])
      const v = f && p.folders.find((x) => x.path === f.path)
      if (v) v.sessions++
    } else if (p.folders[0]) p.folders[0].sessions++
  }
  for (const l of live) byId.get(idFor(l.cwd) ?? '')?.live.push(l)

  const dates = days30(now)
  for (const p of byId.values()) {
    p.active = now - p.lastActivity < ACTIVE_MS
    p.sessions.sort((a, b) => b.lastActivity - a.lastActivity)
    p.daily30 = dates.map((d) => p.sessions.reduce((a, s) => a + (s.dailyOutput[d] ?? 0), 0))
    p.risks = p.archived ? [] : folderRisks(p, config, now)
  }
  // a project added but not worked in yet sorts by when it was added
  return [...byId.values()].sort((a, b) => (b.lastActivity || b.createdAt) - (a.lastActivity || a.createdAt))
}

/**
 * Risks for each folder that exists (3/5), named by folder for the non-primary ones. The primary folder keeps the
 * project's own risk ids, so earlier snoozes and tasks made from a risk still match.
 */
function folderRisks(p: Project, config: AppConfig | null, now: number): Risk[] {
  const several = p.folders.length > 1
  return p.folders
    .filter((f) => !f.missing)
    .flatMap((f) => {
      const sessions = several ? p.sessions.filter((s) => s.cwd && normKey(s.cwd).startsWith(normKey(f.path))) : p.sessions
      const risks = risksFor({ ...p, key: f.key, git: f.git, sessions }, config, now)
      // the primary folder's risks read as the project's own; the others say which folder
      return several && !f.primary ? risks.map((r) => ({ ...r, text: `${f.name}: ${r.text}` })) : risks
    })
}

/** "Medium push": flag work that could be lost; never act on it. */
export function risksFor(p: Project, config: AppConfig | null, now = Date.now()): Risk[] {
  const out: Risk[] = []
  const add = (kind: string, severity: Risk['severity'], text: string): void => {
    const id = `${p.key}:${kind}`
    if ((config?.snoozed[id] ?? 0) > now) return
    out.push({ id, key: p.key, severity, text })
  }
  const g = p.git
  if (g === undefined || !(p.active || p.pinned)) return out
  if (g === null) {
    const recent = p.sessions.filter((s) => now - s.lastActivity < 7 * DAY).length
    if (p.sessions.length)
      add(
        'no-git',
        recent ? 'serious' : 'warn',
        `No git: ${p.sessions.length} session${p.sessions.length === 1 ? '' : 's'} of work with no history or backup`
      )
    return out
  }
  if (g.error) {
    add('error', 'warn', `Git error: ${g.error}`)
    return out
  }
  if (g.conflicts) add('conflicts', 'serious', `${g.conflicts} file${g.conflicts === 1 ? '' : 's'} with merge conflicts`)
  if (!g.remoteUrl) add('no-remote', 'warn', 'No remote: commits live only on this machine')
  else if (!g.upstream && g.lastCommit) add('no-upstream', 'warn', `Branch ${g.branch} has never been pushed`)
  const ab = g.agentBranches ?? []
  if (ab.length)
    add(
      'agent-branches',
      'warn',
      ab.length === 1
        ? `Agent branch ${ab[0].name} has ${ab[0].ahead} commit${ab[0].ahead === 1 ? '' : 's'} never merged`
        : `${ab.length} agent branches have commits never merged (${ab.map((b) => b.name).join(', ')})`
    )
  if (g.ahead) add('unpushed', 'warn', `${g.ahead} commit${g.ahead === 1 ? '' : 's'} not pushed`)
  const dirty = g.changed + g.untracked
  const since = g.lastCommit ? now - g.lastCommit.ts : Infinity
  if (dirty && since > 7 * DAY) {
    add(
      'dirty',
      since > 21 * DAY ? 'serious' : 'warn',
      `${dirty} uncommitted file${dirty === 1 ? '' : 's'}, last commit ${g.lastCommit ? relTime(g.lastCommit.ts, now) : 'never'}`
    )
  }
  return out
}
