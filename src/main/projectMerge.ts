import type { MergePreview, ProjectRecord, SessionSummary } from '@shared/types'
import { folderFor, normKey, projectIdFor } from '@shared/projectList'
import { projectKey } from '@shared/projects'
import { getConfig } from './config'
import { listNotes } from './notes'
import { getProject, mergeProjects, projectsState } from './projectStore'
import { listTasks, refileTasks, taskFolder } from './tasks'

// Merging one project into another (3/5): what moves, shown before anything changes, then the move itself.
// Nothing is copied or rewritten on disk: folders keep their paths, so sessions, notes and path-keyed settings
// follow the folder; only task records change project, and they keep the folder they worked in.

const pathsOf = (p: ProjectRecord): Set<string> => new Set(p.folders.flatMap((f) => [f.path, ...f.pastPaths]).map(normKey))

export function mergePreview(intoId: string, fromId: string, sessions: SessionSummary[]): MergePreview | { error: string } {
  const into = getProject(intoId)
  const from = getProject(fromId)
  if (!into || !from || into === from) return { error: 'Those projects are no longer on the list.' }
  const state = projectsState()
  const memo = new Map<string, string | undefined>()
  const idFor = (cwd: string): string | undefined => {
    const k = normKey(cwd)
    if (!memo.has(k)) memo.set(k, projectIdFor(cwd, state.projects, state.cwds))
    return memo.get(k)
  }
  const paths = pathsOf(from)
  const config = getConfig()
  const settings: string[] = []
  if (from.pinned && !into.pinned) settings.push(`pinned (${into.name} becomes pinned)`)
  for (const f of from.folders) {
    const mode = config.agentGitOverrides[projectKey(f.path)]
    if (mode) settings.push(`agent git mode for ${f.label || from.name}: ${mode} (stays with the folder)`)
  }
  return {
    from: { id: from.id, name: from.name },
    into: { id: into.id, name: into.name },
    folders: from.folders.map((f) => f.path),
    sessions: sessions.filter((s) => s.cwd && idFor(s.cwd) === from.id).length,
    tasks: listTasks()
      .filter((t) => t.projectId === from.id)
      .map((t) => ({ id: t.id, title: t.title })),
    notes: listNotes()
      .filter((n) => n.project && paths.has(normKey(n.project)))
      .map((n) => ({ id: n.id, name: n.name })),
    settings
  }
}

export function merge(intoId: string, fromId: string): { project: ProjectRecord } | { error: string } {
  const from = getProject(fromId)
  if (!from) return { error: 'That project is no longer on the list.' }
  // each task keeps working in the folder it used: its own choice, else its old project's primary folder
  return mergeProjects(intoId, fromId, () =>
    refileTasks(fromId, intoId, (t) => {
      const path = taskFolder(t)
      return (path && folderFor(path, from)?.path) || from.folders.find((f) => f.primary)?.path
    })
  )
}
