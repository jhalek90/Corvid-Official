// The lineage log (#203): an append-only file in the data folder, lineage.jsonl, one JSON event per line, written
// by one-line hooks in the tool handlers and the worker launch. It is only ever appended to and read; nothing else
// in Corvid depends on it, and a failure to write is logged and ignored so no tool call ever fails because of it.
// Everything here takes a folder, never electron, so the tests run it on a temporary folder.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deriveLineage, parseLineageLine, type LineageActor, type LineageEvent, type LineageFilter, type LineageGraph, type LineageInput, type LineageSources } from '@shared/lineage'

export const LINEAGE_FILE = 'lineage.jsonl'

let file: string | undefined

/** Where the log lives. Until this is called, every log call is a no-op (tests of the tools don't need a folder). */
export function initLineage(dataDir: string): void {
  file = join(dataDir, LINEAGE_FILE)
}

export const lineageFile = (): string | undefined => file

export interface LineageBatcher {
  push(e: LineageEvent): void
  /** send whatever is waiting now, without waiting for the timer */
  flush(): void
}

/**
 * Events appended within `delayMs` of the first one go out together (#210): a worker start logs its five inputs at
 * once, and the view adds a batch in one step. The timer starts with the first event of a batch, not the last, so
 * a steady trickle still arrives about once a second.
 */
export function createBatcher(send: (events: LineageEvent[]) => void, delayMs = 1000): LineageBatcher {
  let waiting: LineageEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!waiting.length) return
    const out = waiting
    waiting = []
    send(out)
  }
  return {
    push(e) {
      waiting.push(e)
      if (timer === undefined) timer = setTimeout(flush, delayMs)
    },
    flush
  }
}

let batcher: LineageBatcher | undefined

/** Where appended events are pushed (#210): the main process hands in a sender to the window. Without one, and
 *  in the tests, appends are only written. */
export function setLineageSink(send: ((events: LineageEvent[]) => void) | undefined, delayMs = 1000): void {
  batcher?.flush()
  batcher = send ? createBatcher(send, delayMs) : undefined
}

/** Append one event, and push it to the window's batch when a sink is set. Never throws. */
export function logLineage(e: LineageEvent): void {
  if (!file) return
  try {
    appendFileSync(file, JSON.stringify(e) + '\n')
    batcher?.push(e)
  } catch (err) {
    console.error('[lineage] append failed', err)
  }
}

/** Every event in a log file, oldest first as written; bad lines are skipped. A missing file is an empty log. */
export function readLineage(path = file): LineageEvent[] {
  if (!path || !existsSync(path)) return []
  const out: LineageEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const e = parseLineageLine(line)
    if (e) out.push(e)
  }
  return out
}

/** The graph for the view, from the log and whatever notes, messages and tasks exist now. */
export function lineageGraph(data: Omit<LineageSources, 'events'>, filter: LineageFilter): LineageGraph {
  return deriveLineage({ ...data, events: readLineage() }, filter)
}

// ---------- the hooks' helpers: each caller is one line ----------

const chars = (s: string | undefined): number => (s ?? '').length

/** The size of a project's CLAUDE.md in characters, 0 without one; a worker reads it on its own at start. */
export function claudeMdChars(project: string): number {
  try {
    const p = join(project, 'CLAUDE.md')
    return existsSync(p) ? statSync(p).size : 0
  } catch {
    return 0
  }
}

/** A worker started: measure each of its inputs where they are assembled (workers.ts launch). */
export function workerStarted(w: {
  workerId: string
  agentName: string
  taskId: number
  project: string
  title: string
  notes: string
  instructions?: string
  attachedBytes: number
  /** the worker's system prompt and tool prompts, with the thesis dose counted apart */
  rules: string
  thesis: string
  resumed: boolean
}): void {
  const inputs: LineageInput[] = [
    { kind: 'task', origin: `task #${w.taskId}`, chars: chars(w.title) + chars(w.notes) },
    ...(w.attachedBytes ? [{ kind: 'files' as const, origin: `files attached to #${w.taskId}`, chars: w.attachedBytes }] : []),
    ...(w.instructions ? [{ kind: 'extra' as const, origin: 'typed at start', chars: chars(w.instructions) }] : []),
    ...(claudeMdChars(w.project) ? [{ kind: 'claude-md' as const, origin: join(w.project, 'CLAUDE.md'), chars: claudeMdChars(w.project) }] : []),
    { kind: 'rules', origin: 'Corvid (workers.ts and the tool prompts)', chars: chars(w.rules) },
    { kind: 'thesis', origin: 'docs/getting-started/what-corvid-is.md', chars: chars(w.thesis) }
  ]
  logLineage({ kind: 'worker-started', ts: Date.now(), workerId: w.workerId, agentName: w.agentName, taskId: w.taskId, project: w.project, inputs, ...(w.resumed && { resumed: true }) })
}

export const workerEnded = (w: { id: string; taskId: number; reason?: string }): void =>
  logLineage({ kind: 'worker-ended', ts: Date.now(), workerId: w.id, taskId: w.taskId, reason: w.reason ?? 'ended' })

export const workerMerged = (workerId: string, taskId: number, project: string): void => logLineage({ kind: 'worker-merged', ts: Date.now(), workerId, taskId, project })

export const noteRead = (actor: LineageActor, noteId: string): void => logLineage({ kind: 'note-read', ts: Date.now(), actor: slim(actor), noteId })

export const noteWritten = (actor: LineageActor, noteId: string, action: 'created' | 'appended' | 'updated' | 'deleted'): void =>
  logLineage({ kind: 'note-written', ts: Date.now(), actor: slim(actor), noteId, action })

export const taskFileRead = (actor: LineageActor, taskId: number, file: string): void => logLineage({ kind: 'task-file-read', ts: Date.now(), actor: slim(actor), taskId, file })

export const boardRead = (actor: LineageActor, messageIds: number[]): void => {
  if (messageIds.length) logLineage({ kind: 'board-read', ts: Date.now(), actor: slim(actor), messageIds })
}

export const boardPosted = (actor: LineageActor, messageId: number, done?: boolean): void =>
  logLineage({ kind: 'board-post', ts: Date.now(), actor: slim(actor), messageId, ...(done && { done: true }) })

export const pinged = (from: string, to: string, messageId: number, wake: boolean): void => logLineage({ kind: 'ping', ts: Date.now(), from, to, messageId, wake })

/** Only the fields the graph needs: the tool actors carry closures and avatars too. */
const slim = (a: LineageActor): LineageActor => ({ kind: a.kind, ...(a.agentName && { agentName: a.agentName }), ...(a.taskId !== undefined && { taskId: a.taskId }), ...(a.workerId && { workerId: a.workerId }) })
