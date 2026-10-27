// The agents the Agents view shows as cards, with the status each card shows. The agent birds read the
// same list, so a bird's mood always matches its card's status word.
//
// Sample agents are a debug aid for trying the birds and cards without spending real worker time:
// `__dash.sampleAgents(4)` adds four made-up agents, `__dash.sampleAgents(4, ['busy', 'idle', ...])`
// sets their states, and `__dash.sampleAgents(0)` clears them. There's no way to reach it from the UI.

import { useMemo, useSyncExternalStore } from 'react'
import type { LiveSession, SessionActivity, SessionSummary, Task, TerminalInfo, Worker } from '@shared/types'
import { useStore } from './store'

/** What a card shows: the live registry's status, plus 'starting' (no registry entry yet) and 'exited'. */
export type AgentStatus = 'waiting' | 'blocked' | 'busy' | 'starting' | 'idle' | 'exited'
export type Origin = 'worker' | 'resumed' | 'fork' | 'new' | 'shell'

export interface Agent {
  t: TerminalInfo
  status: AgentStatus
  origin: Origin
  live?: LiveSession
  s?: SessionSummary
  a?: SessionActivity
  worker?: Worker
  task?: Task
}

// Agents that need you first, then working ones; ties keep the order they were opened in.
export const RANK: Record<AgentStatus, number> = { waiting: 0, blocked: 0, busy: 1, starting: 2, idle: 3, exited: 4 }

export const needsYou = (st: AgentStatus): boolean => st === 'waiting' || st === 'blocked'

function originOf(t: TerminalInfo, worker?: Worker): Origin {
  if (t.kind === 'shell') return 'shell'
  if (worker) return 'worker'
  // The titles are the ones launch(), newSession() and newProject() give their tabs.
  if (t.title.startsWith('⑂')) return 'fork'
  if (t.title.endsWith(' · new') || t.title.startsWith('New project ·')) return 'new'
  return 'resumed'
}

/** Every terminal in the Agents view (shells too), sorted the way the cards are. */
export function useAgents(): Agent[] {
  const terminals = useStore((s) => s.terminals)
  const liveSessions = useStore((s) => s.liveSessions)
  const sessions = useStore((s) => s.sessions)
  const activity = useStore((s) => s.activity)
  const workers = useStore((s) => s.assistant.workers)
  const tasks = useStore((s) => s.tasks)
  const samples = useSyncExternalStore(watchSamples, () => sampleList)

  return useMemo<Agent[]>(() => {
    const liveByTerm = new Map(liveSessions.filter((l) => l.termId).map((l) => [l.termId!, l]))
    const real = terminals
      .filter((t) => !t.side)
      .map((t) => {
        const live = liveByTerm.get(t.termId)
        const worker = workers.find((w) => w.termId === t.termId)
        const sid = live?.sessionId ?? t.sessionId ?? worker?.sessionId
        const status: AgentStatus =
          t.exited !== undefined ? 'exited' : (live?.status as AgentStatus | undefined) ?? (worker?.liveStatus as AgentStatus | undefined) ?? 'starting'
        return {
          t,
          status: status in RANK ? status : 'idle',
          origin: originOf(t, worker),
          live,
          s: sid ? sessions[sid] : undefined,
          a: sid ? activity[sid] : undefined,
          worker,
          task: worker ? tasks.find((x) => x.id === worker.taskId) : undefined
        }
      })
    return [...real, ...samples].sort((x, y) => RANK[x.status] - RANK[y.status] || x.t.createdAt - y.t.createdAt)
  }, [terminals, liveSessions, sessions, activity, workers, tasks, samples])
}

// ---------- sample agents (debug only) ----------

const SAMPLE_NAMES = [
  'Senior Twig Inspector',
  'Acting Breadcrumb Auditor',
  'Junior Puddle Surveyor',
  'Chief Shiny Object Officer',
  'Deputy Nest Architect',
  'Lead Worm Logistics Analyst',
  'Head of Feather Compliance',
  'Interim Acorn Archivist',
  'Principal Scarecrow Liaison',
  'Staff Weathervane Engineer'
]
const SAMPLE_STATES: AgentStatus[] = ['busy', 'idle', 'waiting', 'busy', 'idle', 'busy', 'waiting', 'idle', 'busy', 'idle']

let sampleList: Agent[] = []
const sampleWatchers = new Set<() => void>()
function watchSamples(cb: () => void): () => void {
  sampleWatchers.add(cb)
  return () => sampleWatchers.delete(cb)
}

/**
 * Debug: pretend there are `n` more agents, with made-up names and tasks. `states` sets each one's
 * status ('busy', 'idle', 'waiting', 'exited'); agents kept from the last call keep their terminal
 * id, so flipping states doesn't respawn their birds. `restart` gives the listed ones a new id, as a
 * restarted worker gets. `extra` adds to each one's worker, e.g. `[{ branch: 'task-1-x', git: { state: 'kept' } }]`.
 */
export function sampleAgents(n: number, states?: AgentStatus[], restart: number[] = [], extra: Partial<Worker>[] = []): void {
  const now = Date.now()
  sampleList = Array.from({ length: n }, (_, i) => {
    const old = sampleList[i]
    const name = SAMPLE_NAMES[i % SAMPLE_NAMES.length]
    const status = states?.[i] ?? old?.status ?? SAMPLE_STATES[i % SAMPLE_STATES.length]
    const termId = old && !restart.includes(i) ? old.t.termId : `sample-${i}-${now}`
    const taskId = 900 + i
    return {
      t: { termId, title: name, cwd: 'C:\\sample', kind: 'claude', agentName: name, createdAt: old?.t.createdAt ?? now + i, exited: status === 'exited' ? 0 : undefined },
      status,
      origin: 'worker',
      worker: {
        id: termId,
        taskId,
        taskTitle: `Sample task ${i + 1} for trying the agent birds`,
        agentName: name,
        model: 'default',
        termId,
        project: 'C:\\sample',
        startedAt: now,
        workedMs: 0,
        clockFrom: now,
        state: status === 'exited' ? 'exited' : 'running',
        ...extra[i]
      }
    }
  })
  for (const cb of sampleWatchers) cb()
}
