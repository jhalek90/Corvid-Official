// The project switcher (#77): pick a project once and the views narrow to it, like a workspace in a chat app.
// It only changes what the user sees: nothing is hidden from agents or Corvid, nothing changes on disk, and a
// Needs you or an approval from another project is never hidden (the views count them, with a way back).
// The choice is kept in localStorage; a project that leaves the list, or is archived while chosen, falls
// back to All projects.
//
// Hook for the Unfiled inbox (#74): an 'unfiled' scope would match folders that file under no project
// (projectOfPath() === undefined). It needs an entry in the switcher's list and a case in useInScope().

import { useMemo } from 'react'
import type { ProjectRecord, ProjectsState, Task } from '@shared/types'
import { normKey, primaryFolder, projectIdFor } from '@shared/projectList'
import { getState, setExplorerRoot, setState, subscribe, toast, useStore, writeLocal, type State } from './store'

const KEY = 'projectScope'

/** The chosen project, while it is on the list. */
const scopeOf = (s: State): ProjectRecord | undefined => (s.scope ? s.projects.projects.find((p) => p.id === s.scope) : undefined)

export function setScope(id: string | undefined): void {
  const p = id ? getState().projects.projects.find((x) => x.id === id) : undefined
  writeLocal(KEY, p?.id ?? '')
  // the Projects view shows the chosen project's page next (or the list, on All projects)
  setState({ scope: p?.id, selectedProject: undefined })
  // the file explorer starts in the chosen project's folder, unless it's somewhere in that project already
  const folder = p && primaryFolder(p)
  const root = getState().explorerRoot
  if (p && folder && (!root || projectOfPath(root) !== p.id)) setExplorerRoot(folder)
}

// The same folders come up again and again (cards, feed rows, notes): match each once per project list.
let memoFor: ProjectsState | undefined
let memo = new Map<string, string | undefined>()

/** The id of the project a folder files under (#73's matching: folder, past path or worktree), or undefined. */
export function projectOfPath(path: string | undefined, list: ProjectsState = getState().projects): string | undefined {
  if (!path) return undefined
  if (memoFor !== list) {
    memoFor = list
    memo = new Map()
  }
  const k = normKey(path)
  if (!memo.has(k)) memo.set(k, projectIdFor(path, list.projects, list.cwds))
  return memo.get(k)
}

/** The chosen project, or undefined on All projects. */
export const useScope = (): ProjectRecord | undefined => useStore(scopeOf)

/** Whether a folder is in the chosen project; always true on All projects. */
export function useInScope(): (path: string | undefined) => boolean {
  const id = useStore((s) => scopeOf(s)?.id)
  const list = useStore((s) => s.projects)
  return useMemo(() => (path: string | undefined) => !id || projectOfPath(path, list) === id, [id, list])
}

/** A task's project: its id, else the folder it was made with. */
export const taskProject = (t: Pick<Task, 'projectId' | 'project'>): string | undefined => t.projectId ?? projectOfPath(t.project)

// Fall back to All projects when the chosen project leaves the list, or is archived while chosen. One picked
// from the archived list on purpose stays picked, also across a restart.
let seen: ProjectsState | undefined
subscribe(() => {
  const s = getState()
  if (!s.booted || s.projects === seen) return
  const prev = seen
  seen = s.projects
  if (!s.scope) return
  const p = s.projects.projects.find((x) => x.id === s.scope)
  const was = prev?.projects.find((x) => x.id === s.scope)
  if (!p) {
    setScope(undefined)
    toast(`${was?.name ?? 'The project you had chosen'} is no longer on the project list, so Corvid shows All projects again.`)
  } else if (p.archived && was && !was.archived) {
    setScope(undefined)
    toast(`${p.name} was archived, so Corvid shows All projects again.`)
  }
})
