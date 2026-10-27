import type { Task, TaskColumn } from './types'

// "Blocked by" links between tasks. A block is only a hint: nothing is ever refused because of one.
// A blocker is resolved once it's in Done (#138) or gone: removed tasks are deleted, so one that no longer
// exists counts as resolved too (finished and discarded look the same). Either way its id stays in the list,
// ignored, so moving it out of Done or undoing the delete blocks the waiting tasks again; the id of a deleted
// one is dropped the next time that task is saved (a Done one stays, it still exists).

/** A task can wait on at most this many others. */
export const MAX_BLOCKERS = 10

type Lookup = (id: number) => Task | undefined

/** How a blocker's column reads in chips and messages. Backlog and next haven't started, which is the stronger hint. */
export const BLOCKER_STATE: Record<TaskColumn, string> = { backlog: 'not started, backlog', next: 'not started, up next', doing: 'in progress', done: 'done' }

export const notStarted = (b: Task): boolean => b.column === 'backlog' || b.column === 'next'

/** A task in Done no longer blocks anything (#138). */
export const finished = (b: Task): boolean => b.column === 'done'

/** The blockers that still exist and aren't done, in the task's order. */
export function openBlockers(t: Task, find: Lookup): Task[] {
  return (t.blockedBy ?? []).flatMap((id) => {
    const b = id === t.id ? undefined : find(id)
    return b && !finished(b) ? [b] : []
  })
}

/** The tasks waiting on `t`; none once `t` is done, since it no longer blocks them. */
export const blockedTasks = (t: Task, all: Task[]): Task[] => (finished(t) ? [] : all.filter((x) => x.id !== t.id && x.blockedBy?.includes(t.id)))

/** "#57 Rebrand the assistant (in progress)" */
export const blockerLabel = (b: Task): string => `#${b.id} ${b.title} (${BLOCKER_STATE[b.column]})`

/** A blockedBy list as read from tasks.json, which people and tools may edit by hand: whole positive
 *  numbers, no repeats, not the task itself, at most MAX_BLOCKERS. Undefined when empty. */
export function cleanBlockedBy(raw: unknown, self?: number): number[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== self))].slice(0, MAX_BLOCKERS)
  return ids.length ? ids : undefined
}

/** If `id` waited on `blocker`, would that close a loop? Returns the path back to `id` (blocker … id), or null. */
export function loopPath(id: number, blocker: number, find: Lookup): number[] | null {
  const seen = new Set<number>()
  const walk = (at: number, path: number[]): number[] | null => {
    if (at === id) return path
    if (seen.has(at)) return null
    seen.add(at)
    for (const next of find(at)?.blockedBy ?? []) {
      if (!find(next) && next !== id) continue
      const found = walk(next, [...path, next])
      if (found) return found
    }
    return null
  }
  return find(blocker) ? walk(blocker, [blocker]) : null
}

/** Why `id` can't wait on `blocker`, in words for the user, or null if it can. `id` is undefined for a task
 *  that isn't saved yet (nothing waits on it, so it can't close a loop). */
export function blockerProblem(id: number | undefined, blocker: number, find: Lookup): string | null {
  if (id !== undefined && blocker === id) return `#${id} can't be blocked by itself.`
  if (!find(blocker)) return `There's no task #${blocker}. It may have been completed or discarded.`
  if (id === undefined) return null
  const path = loopPath(id, blocker, find)
  if (!path) return null
  const chain = path.length > 2 ? ` (through ${path.slice(1, -1).map((n) => `#${n}`).join(', ')})` : ''
  return `#${blocker} already waits on #${id}${chain}, so #${id} can't wait on #${blocker}: they'd be waiting on each other forever.`
}

/**
 * Check a new blockedBy list for task `id` and tidy it. Ids that were already on the list but whose task is
 * gone are dropped quietly (a finished blocker); any other problem is an error. Returns the list to store.
 */
export function checkBlockedBy(id: number | undefined, list: unknown, previous: number[] | undefined, find: Lookup): { ids?: number[]; error?: string } {
  if (!Array.isArray(list)) return { error: 'Blocked by must be a list of task numbers.' }
  const ids: number[] = []
  for (const raw of list) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) return { error: `"${raw}" isn't a task number.` }
    if (ids.includes(n)) continue
    if (!find(n) && previous?.includes(n) && n !== id) continue
    const problem = blockerProblem(id, n, find)
    if (problem) return { error: problem }
    ids.push(n)
  }
  if (ids.length > MAX_BLOCKERS) return { error: `A task can be blocked by at most ${MAX_BLOCKERS} others.` }
  return { ids: ids.length ? ids : undefined }
}
