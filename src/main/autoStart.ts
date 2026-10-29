import { autoStartNotice, autoStartReady, autoStartWaiting } from '@shared/autoStart'
import type { Task } from '@shared/types'
import { listTasks } from './tasks'
import * as workers from './workers'

// Start automatically when its blockers are done (#282). tasks.ts reports each move into Done; the tasks that opt in
// and now have every blocker done start through workers.autoStartWorker, which is startWorker with all its checks.
// With every worker slot taken a task waits here, in memory, and starts when one frees: the worker whose merge moved
// the blocker to Done still holds its slot for a few minutes, so with a cap of 1 a chain would otherwise never go on.
// The wait is checked again before each try (switch still on, still in Backlog or Up next, blockers still done), and
// a restart forgets it.

const TICK_MS = 5_000

interface AutoStartDeps {
  /** a dashboard notice on the board, in the task's channel */
  notice: (text: string, taskId: number) => void
  /** a line in Corvid's chat */
  note: (text: string) => void
}

let deps: AutoStartDeps = { notice: () => {}, note: () => {} }
/** tasks a start is under way for, so two Done moves at once can't start the same task twice */
const starting = new Set<number>()
/** tasks waiting for a free slot, oldest first */
let waiting: number[] = []
let tick: NodeJS.Timeout | null = null
let draining = false

export function initAutoStart(d: AutoStartDeps): void {
  deps = d
}

const find = (id: number): Task | undefined => listTasks().find((t) => t.id === id)
const busy = (id: number): boolean => starting.has(id) || workers.runningWorkers().some((w) => w.taskId === id)

/** Tasks `ids` just moved into Done: try each task that was waiting on them, one at a time so the cap counts each. */
export async function afterDone(ids: number[]): Promise<void> {
  for (const t of autoStartReady(ids, listTasks(), busy)) await tryStart(t.id, false)
}

async function tryStart(id: number, fromQueue: boolean): Promise<void> {
  if (busy(id)) return
  starting.add(id)
  try {
    const r = await workers.autoStartWorker(id)
    if (r.action === 'no-slot') {
      if (fromQueue) waiting.unshift(id)
      else if (!waiting.includes(id)) {
        waiting.push(id)
        deps.notice(autoStartNotice(id, 'no-slot', { cap: workers.slotInfo().cap }), id)
      }
      startTicking()
      return
    }
    deps.notice(autoStartNotice(id, r.action, { error: r.error }), id)
    if (r.worker) deps.note(`Started ${r.worker.agentName ? `${r.worker.agentName} on` : 'a worker for'} #${id} automatically: its blockers are done.`)
  } catch (e) {
    console.error(`[auto-start] #${id} failed`, e)
  } finally {
    starting.delete(id)
  }
}

function startTicking(): void {
  if (!tick) tick = setInterval(() => void drain(), TICK_MS)
}

/** One waiting task gets a try when a slot is free; tasks that no longer qualify leave the wait quietly. */
async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    waiting = waiting.filter((id) => {
      const t = find(id)
      return t && autoStartWaiting(t, find) && !busy(id)
    })
    if (!waiting.length) {
      if (tick) clearInterval(tick)
      tick = null
      return
    }
    const { running, cap } = workers.slotInfo()
    if (running >= cap) return
    await tryStart(waiting.shift()!, true)
  } finally {
    draining = false
  }
}
