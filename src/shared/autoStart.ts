import type { Task } from './types'
import { finished } from './blockers'

// Start automatically when its blockers are done (#282). A task can opt in with autoStart. When one of its blockers
// moves to Done, and every other blocker is done or deleted too, a worker starts on it through the normal start path
// (workers.startWorker), so the worker cap, the usage gates, the time limit, the task's model and the user's mode all
// apply. Only a blocker moving to Done triggers it: switching autoStart on never starts anything by itself.
// With every worker slot taken the task waits for one (main/autoStart.ts); with usage over the limit a board notice
// says so and the user starts it themselves, since an automatic start never opens the usage dialog.

/** What an automatic start does, given the state at the moment a blocker moved to Done. */
export type AutoStartAction =
  /** start a worker */
  | 'start'
  /** "ask" mode: create the usual proposal, which the user approves in the Agents view */
  | 'propose'
  /** every worker slot is taken: a notice, and it waits for a free slot */
  | 'no-slot'
  /** usage is over the limit (whether the setting blocks or asks): a notice, never a dialog from an automatic start */
  | 'over-limit'

/** A task that opts in, isn't started or finished, and whose blockers are all done or deleted now. */
export function autoStartWaiting(t: Task, find: (id: number) => Task | undefined): boolean {
  if (!t.autoStart || (t.column !== 'backlog' && t.column !== 'next')) return false
  return (t.blockedBy ?? []).every((id) => {
    const b = id === t.id ? undefined : find(id)
    return !b || finished(b)
  })
}

/**
 * The tasks to start now that `doneIds` moved to Done: those blocked by one of them that are autoStartWaiting and
 * have no worker running. Each task at most once, in board order.
 */
export function autoStartReady(doneIds: number[], all: Task[], running: (id: number) => boolean): Task[] {
  const find = (id: number): Task | undefined => all.find((t) => t.id === id)
  const done = doneIds.filter((id) => {
    const t = find(id)
    return t && finished(t)
  })
  if (!done.length) return []
  return all.filter((t) => t.blockedBy?.some((id) => done.includes(id)) && autoStartWaiting(t, find) && !running(t.id))
}

/** What to do for one ready task. `usageOver`: the usage gate is over the limit for one more worker. */
export function autoStartAction(s: { mode: string; freeSlots: number; usageOver: boolean }): AutoStartAction {
  if (s.mode === 'ask') return 'propose'
  if (s.freeSlots <= 0) return 'no-slot'
  if (s.usageOver) return 'over-limit'
  return 'start'
}

/** The board notice for each outcome. `error` is why startWorker refused, for anything the checks above didn't catch. */
export function autoStartNotice(id: number, outcome: AutoStartAction | 'failed', detail?: { cap?: number; error?: string }): string {
  switch (outcome) {
    case 'start':
      return `Started #${id} automatically: its blockers are done.`
    case 'propose':
      return `#${id}'s blockers are done, so a worker for it is waiting for your approval under "Awaiting your approval" in the Agents view.`
    case 'no-slot':
      return `#${id} is ready to start (its blockers are done), but all${detail?.cap ? ` ${detail.cap}` : ''} worker slots are busy; it starts automatically when one frees.`
    case 'over-limit':
      return `#${id} is ready to start but usage is over the limit; start it yourself.`
    case 'failed':
      return `#${id} is ready to start automatically (its blockers are done), but it didn't start: ${detail?.error ?? 'unknown reason'}`
  }
}
