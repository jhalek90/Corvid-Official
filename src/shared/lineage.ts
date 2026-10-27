// Lineage (#203): where each agent's context came from and what it left behind. The events are appended to
// lineage.jsonl in the data folder (src/main/lineage.ts), one JSON object per line; the graph is derived at view time
// from those events plus the notes, board messages and tasks that already exist. Read-only: nothing here changes how
// a prompt is built or what an agent may do.
import type { BoardMessage } from './board'
import type { Note, Task } from './types'

/** Who did something: a worker (by task and name) or Corvid the assistant. A worker id is set when known. */
export interface LineageActor {
  kind: 'agent' | 'assistant'
  agentName?: string
  taskId?: number
  workerId?: string
}

/** One input a worker started with, measured in characters. */
export interface LineageInput {
  /** task: title and notes; files: the task's attached files; claude-md: the project's CLAUDE.md; rules: Corvid's
   *  standard worker instructions (system prompt and tool prompts); thesis: the "What Corvid is" dose; extra: the
   *  instructions typed at start */
  kind: 'task' | 'files' | 'claude-md' | 'rules' | 'thesis' | 'extra'
  /** where it came from, e.g. "task #12", "D:\\proj\\CLAUDE.md" */
  origin: string
  chars: number
}

export type LineageEvent =
  | { kind: 'worker-started'; ts: number; workerId: string; agentName: string; taskId: number; project: string; inputs: LineageInput[]; resumed?: boolean }
  | { kind: 'worker-ended'; ts: number; workerId: string; taskId: number; reason: string }
  | { kind: 'worker-merged'; ts: number; workerId: string; taskId: number; project: string }
  | { kind: 'note-read'; ts: number; actor: LineageActor; noteId: string }
  | { kind: 'note-written'; ts: number; actor: LineageActor; noteId: string; action: 'created' | 'appended' | 'updated' | 'deleted' }
  | { kind: 'task-file-read'; ts: number; actor: LineageActor; taskId: number; file: string }
  | { kind: 'board-read'; ts: number; actor: LineageActor; messageIds: number[] }
  | { kind: 'board-post'; ts: number; actor: LineageActor; messageId: number; done?: boolean }
  | { kind: 'ping'; ts: number; from: string; to: string; messageId: number; wake: boolean }

export const LINEAGE_KINDS = new Set<LineageEvent['kind']>(['worker-started', 'worker-ended', 'worker-merged', 'note-read', 'note-written', 'task-file-read', 'board-read', 'board-post', 'ping'])

/** One parsed line, or null for a line that isn't a lineage event (a bad line never spoils the rest). */
export function parseLineageLine(line: string): LineageEvent | null {
  const s = line.trim()
  if (!s) return null
  try {
    const e = JSON.parse(s)
    if (!e || typeof e !== 'object' || !LINEAGE_KINDS.has(e.kind) || typeof e.ts !== 'number') return null
    return e as LineageEvent
  } catch {
    return null
  }
}

// ---------- the graph ----------

export type LaneKind = 'source' | 'agent' | 'artifact'

export interface LineageNode {
  id: string
  lane: LaneKind
  /** source: task | files | claude-md | rules | thesis | extra; agent: worker | corvid; artifact: note | post | done | project */
  type: string
  label: string
  /** when it first appeared (an artifact's creation, an agent's start, a source's first use) */
  ts: number
  taskId?: number
  /** who made it: an agent node id, for artifacts */
  by?: string
  /** the artifact no longer exists (a deleted note, an expired message) */
  gone?: boolean
  /** a note's or post's text size in characters, when known */
  chars?: number
  /** the project it belongs to (#213), as a normalised path: a worker's project, a task's sources, a project's
   *  CLAUDE.md and main, and a note or post by a worker whose project is known. Unset where it cannot be known
   *  (Corvid, the rules, the thesis, the user's notes): those are shared by everyone. */
  project?: string
}

export interface LineageEdge {
  from: string
  to: string
  kind: 'started' | 'read' | 'wrote' | 'merged'
  ts: number
  /** characters handed over, on started edges */
  chars?: number
  /** how it was written, on wrote edges */
  action?: string
}

export interface LineageGraph {
  nodes: LineageNode[]
  edges: LineageEdge[]
  /** the oldest event in the log, or undefined with no log yet */
  loggedSince?: number
  events: number
  /** every project a worker started in or merged into, whatever the filter (#213): paths as first logged, without
   *  trailing slashes, one per normalised path */
  projects?: string[]
}

export interface LineageFilter {
  /** only the last n days; 0 or undefined with no taskId is all time */
  days?: number
  taskId?: number
  /** only this project's workers and what they touched (#213), by path; a task filter takes priority over it */
  project?: string
}

/** A project path as the graph compares it: no trailing slashes, lower case (what projectNodeId does). */
export const normProject = (path: string): string => path.replace(/[\\/]+$/, '').toLowerCase()

/** How a node relates to the project in view (#213): its own, another project's (foreign), or shared by everyone
 *  because its project cannot be known (Corvid, the rules, the thesis, the user's notes). Without a project in view
 *  everything is `own`. */
export type ProjectRelation = 'own' | 'foreign' | 'shared'
export function projectRelationOf(n: Pick<LineageNode, 'project'>, project: string | undefined): ProjectRelation {
  if (!project) return 'own'
  if (!n.project) return 'shared'
  return n.project === normProject(project) ? 'own' : 'foreign'
}

export interface LineageSources {
  events: LineageEvent[]
  notes: Note[]
  messages: BoardMessage[]
  tasks: Task[]
  now?: number
}

export const CORVID_NODE = 'agent:corvid'
export const agentNodeId = (actor: { kind?: 'agent' | 'assistant'; agentName?: string; taskId?: number }): string =>
  actor.kind === 'assistant' || (actor.taskId === undefined && !actor.agentName) ? CORVID_NODE : `agent:${actor.taskId ?? '?'}:${(actor.agentName ?? 'worker').toLowerCase()}`
export const noteNodeId = (id: string): string => `note:${id.toUpperCase()}`
export const postNodeId = (id: number): string => `post:${id}`
export const projectNodeId = (path: string): string => `project:${path.replace(/[\\/]+$/, '').toLowerCase()}`

const SOURCE_LABEL: Record<LineageInput['kind'], string> = {
  task: 'Task',
  files: 'Attached files',
  'claude-md': 'CLAUDE.md',
  rules: 'Worker rules',
  thesis: 'What Corvid is',
  extra: 'Extra instructions'
}

/** Sources are shared where the text is: the task's own per task, CLAUDE.md per project, the rules and thesis once. */
const sourceNodeId = (i: LineageInput, taskId: number, project: string): string =>
  i.kind === 'task' || i.kind === 'files' || i.kind === 'extra' ? `source:${i.kind}:${taskId}` : i.kind === 'claude-md' ? `source:claude-md:${normProject(project)}` : `source:${i.kind}`

const shortPath = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

const edgeKey = (e: LineageEdge): string => `${e.from}|${e.to}|${e.kind}|${e.ts}`

/**
 * The provenance graph from the log and the existing data. Nodes outside the time window are dropped with their edges;
 * a source stays when any of its edges does. With a task id, only that task's agents and what they touched.
 *
 * With a `seed` (#210, the live view) the graph grows from it: the seed's nodes and edges are kept, and only what
 * the events, notes and messages add is new. Nothing in the seed is changed; the result is a fresh graph.
 */
export function deriveLineage(src: LineageSources, filter: LineageFilter = {}, seed?: LineageGraph): LineageGraph {
  const now = src.now ?? Date.now()
  const nodes = new Map<string, LineageNode>()
  const edges: LineageEdge[] = []
  const seen = new Set<string>()
  for (const n of seed?.nodes ?? []) nodes.set(n.id, { ...n })
  for (const e of seed?.edges ?? []) {
    edges.push(e)
    seen.add(edgeKey(e))
  }
  const addEdge = (e: LineageEdge): void => {
    const k = edgeKey(e)
    if (seen.has(k)) return
    seen.add(k)
    edges.push(e)
  }
  const events = [...src.events].sort((a, b) => a.ts - b.ts)
  const taskOf = (id: number): Task | undefined => src.tasks.find((t) => t.id === id)
  // which project each task's workers run in (#213): from the log first, the seed next, the task itself last
  const taskProject = new Map<number, string>()
  const projects = new Map<string, string>()
  for (const p of seed?.projects ?? []) projects.set(normProject(p), p)
  for (const e of events) {
    if (e.kind !== 'worker-started' && e.kind !== 'worker-merged') continue
    const key = normProject(e.project)
    if (!projects.has(key)) projects.set(key, e.project.replace(/[\\/]+$/, ''))
    if (!taskProject.has(e.taskId)) taskProject.set(e.taskId, key)
  }
  for (const n of seed?.nodes ?? []) if (n.type === 'worker' && n.taskId !== undefined && n.project && !taskProject.has(n.taskId)) taskProject.set(n.taskId, n.project)
  const projectOfTask = (taskId: number | undefined): string | undefined => {
    if (taskId === undefined) return undefined
    const known = taskProject.get(taskId)
    if (known) return known
    const t = taskOf(taskId)
    return t?.project ? normProject(t.project) : undefined
  }
  const put = (n: LineageNode): LineageNode => {
    const old = nodes.get(n.id)
    if (!old) nodes.set(n.id, n)
    else {
      if (n.ts < old.ts) old.ts = n.ts
      if (n.project && !old.project) old.project = n.project
    }
    return nodes.get(n.id)!
  }
  const agentNode = (actor: LineageActor, ts: number): string => {
    const id = agentNodeId(actor)
    if (id === CORVID_NODE) put({ id, lane: 'agent', type: 'corvid', label: 'Corvid', ts })
    else put({ id, lane: 'agent', type: 'worker', label: `${actor.agentName ?? 'worker'} (#${actor.taskId})`, ts, taskId: actor.taskId, project: projectOfTask(actor.taskId) })
    return id
  }
  /** an artifact's project is its author's: a worker's project, or none for Corvid and the user */
  const artifactProject = (author: string, taskId: number | undefined): string | undefined => (author === 'agent' ? projectOfTask(taskId) : undefined)

  // artifacts that exist now: notes and posts, with their authors as the "wrote" edge
  for (const n of src.notes) {
    const by = n.author === 'user' ? undefined : agentNodeId({ kind: n.author === 'assistant' ? 'assistant' : 'agent', agentName: n.agentName, taskId: n.taskId })
    put({ id: noteNodeId(n.id), lane: 'artifact', type: 'note', label: `${n.id} ${cut(n.name, 40)}`, ts: n.created, taskId: n.taskId, by, chars: n.text.length, project: artifactProject(n.author, n.taskId) })
    if (by) {
      agentNode({ kind: n.author === 'assistant' ? 'assistant' : 'agent', agentName: n.agentName, taskId: n.taskId }, n.created)
      addEdge({ from: by, to: noteNodeId(n.id), kind: 'wrote', ts: n.created, action: 'created' })
    }
  }
  for (const m of src.messages) {
    if (m.author === 'user') continue
    const actor: LineageActor = { kind: m.author === 'assistant' ? 'assistant' : 'agent', agentName: m.agentName, taskId: m.taskId }
    // notices the app posts about an agent are not the agent's own words
    const by = m.author === 'agent' || m.author === 'assistant' ? agentNode(actor, m.ts) : undefined
    put({ id: postNodeId(m.id), lane: 'artifact', type: m.done ? 'done' : 'post', label: `m${m.id} ${cut(m.text, 40)}`, ts: m.ts, taskId: m.taskId, by, chars: m.text.length, project: artifactProject(m.author, m.taskId) })
    if (by) addEdge({ from: by, to: postNodeId(m.id), kind: 'wrote', ts: m.ts })
  }

  // the log: workers and what they were given, read and wrote
  const workerOf = new Map<string, string>()
  for (const e of events) {
    switch (e.kind) {
      case 'worker-started': {
        const id = agentNode({ kind: 'agent', agentName: e.agentName, taskId: e.taskId, workerId: e.workerId }, e.ts)
        workerOf.set(e.workerId, id)
        const project = normProject(e.project)
        // the worker's own start says where it ran, whatever the task's other workers did
        nodes.get(id)!.project = project
        for (const i of e.inputs) {
          const sid = sourceNodeId(i, e.taskId, e.project)
          const t = taskOf(e.taskId)
          const label =
            i.kind === 'task' ? `#${e.taskId} ${cut(t?.title ?? '', 36)}`.trim() : i.kind === 'claude-md' ? `CLAUDE.md (${shortPath(e.project)})` : i.kind === 'files' || i.kind === 'extra' ? `${SOURCE_LABEL[i.kind]} #${e.taskId}` : SOURCE_LABEL[i.kind]
          // the task's own sources and the CLAUDE.md belong to the project; the rules and the thesis are everyone's
          const own = i.kind === 'task' || i.kind === 'files' || i.kind === 'extra'
          put({ id: sid, lane: 'source', type: i.kind, label, ts: e.ts, ...(own ? { taskId: e.taskId, project } : i.kind === 'claude-md' ? { project } : {}) })
          addEdge({ from: sid, to: id, kind: 'started', ts: e.ts, chars: i.chars })
        }
        break
      }
      case 'worker-merged': {
        // without its start in these events (a live batch, #210), the task's newest worker node is the one that merged
        const id = workerOf.get(e.workerId) ?? [...nodes.values()].filter((n) => n.type === 'worker' && n.taskId === e.taskId).sort((a, b) => b.ts - a.ts)[0]?.id ?? agentNodeId({ kind: 'agent', taskId: e.taskId })
        if (!nodes.has(id)) break
        const pid = projectNodeId(e.project)
        put({ id: pid, lane: 'artifact', type: 'project', label: `main of ${shortPath(e.project)}`, ts: e.ts, project: normProject(e.project) })
        addEdge({ from: id, to: pid, kind: 'merged', ts: e.ts })
        break
      }
      case 'note-read': {
        const id = agentNode(e.actor, e.ts)
        const nid = noteNodeId(e.noteId)
        if (!nodes.has(nid)) put({ id: nid, lane: 'artifact', type: 'note', label: `${e.noteId.toUpperCase()} (deleted)`, ts: e.ts, gone: true })
        addEdge({ from: nid, to: id, kind: 'read', ts: e.ts })
        break
      }
      case 'note-written': {
        const id = agentNode(e.actor, e.ts)
        const nid = noteNodeId(e.noteId)
        if (!nodes.has(nid)) put({ id: nid, lane: 'artifact', type: 'note', label: `${e.noteId.toUpperCase()} (deleted)`, ts: e.ts, gone: true, by: id, project: nodes.get(id)?.project })
        // the note's own creation is already an edge; appends and rewrites are the rest
        if (e.action !== 'created') addEdge({ from: id, to: nid, kind: 'wrote', ts: e.ts, action: e.action })
        break
      }
      case 'task-file-read': {
        const id = agentNode(e.actor, e.ts)
        const sid = `source:files:${e.taskId}`
        put({ id: sid, lane: 'source', type: 'files', label: `Attached files #${e.taskId}`, ts: e.ts, taskId: e.taskId, project: projectOfTask(e.taskId) })
        addEdge({ from: sid, to: id, kind: 'read', ts: e.ts })
        break
      }
      case 'board-read': {
        const id = agentNode(e.actor, e.ts)
        for (const mid of e.messageIds) {
          const pid = postNodeId(mid)
          // the user's posts are not artifacts of an agent, so an unknown message only appears when it was read
          if (!nodes.has(pid)) {
            const m = src.messages.find((x) => x.id === mid)
            if (m && m.author === 'user') continue
            if (!m) put({ id: pid, lane: 'artifact', type: 'post', label: `m${mid} (expired)`, ts: e.ts, gone: true })
          }
          if (nodes.get(pid)?.by === id) continue
          addEdge({ from: pid, to: id, kind: 'read', ts: e.ts })
        }
        break
      }
      case 'board-post': {
        const id = agentNode(e.actor, e.ts)
        const pid = postNodeId(e.messageId)
        if (!nodes.has(pid)) put({ id: pid, lane: 'artifact', type: e.done ? 'done' : 'post', label: `m${e.messageId} (expired)`, ts: e.ts, gone: true, by: id, project: nodes.get(id)?.project })
        if (!edges.some((x) => x.from === id && x.to === pid && x.kind === 'wrote')) addEdge({ from: id, to: pid, kind: 'wrote', ts: e.ts })
        break
      }
      case 'ping': {
        // a ping is the post reaching its target: a read edge from the post to the agent it was delivered to
        const pid = postNodeId(e.messageId)
        if (!nodes.has(pid)) break
        const to = e.to === 'assistant' ? CORVID_NODE : [...nodes.values()].find((n) => n.lane === 'agent' && n.label.toLowerCase().startsWith(e.to.toLowerCase()))?.id
        if (!to) break
        addEdge({ from: pid, to, kind: 'read', ts: e.ts, action: e.wake ? 'woke' : 'ping' })
        break
      }
      case 'worker-ended':
        break
    }
  }

  // the window: by time, then by task, or else by project (#213): a task already implies its project
  const since = filter.days && filter.days > 0 && filter.taskId === undefined ? now - filter.days * 86_400_000 : 0
  const project = filter.taskId === undefined && filter.project ? normProject(filter.project) : undefined
  const keep = new Set<string>()
  for (const n of nodes.values()) {
    if (n.lane === 'source') continue
    if (n.ts < since) continue
    if (filter.taskId !== undefined && n.taskId !== filter.taskId) continue
    if (project !== undefined && n.project !== project) continue
    keep.add(n.id)
  }
  if (filter.taskId !== undefined) {
    // one hop out: what the task's agents touched, and whoever touched the task's artifacts (Corvid, other agents)
    const base = new Set(keep)
    for (const e of edges) {
      if (base.has(e.from)) keep.add(e.to)
      if (base.has(e.to)) keep.add(e.from)
    }
  } else if (project !== undefined) {
    // one hop out from the project's own nodes, wherever the neighbour lives (a foreign note, the rules, Corvid),
    // except other projects' workers: they and what is reachable only through them stay out
    const base = new Set(keep)
    const hop = (id: string): void => {
      const n = nodes.get(id)
      if (n && n.ts >= since && !(n.lane === 'agent' && projectRelationOf(n, project) === 'foreign')) keep.add(id)
    }
    for (const e of edges) {
      if (base.has(e.from)) hop(e.to)
      if (base.has(e.to)) hop(e.from)
    }
  }
  const kept = edges.filter((e) => {
    const a = nodes.get(e.from)
    const b = nodes.get(e.to)
    if (!a || !b) return false
    const src = a.lane === 'source' ? keep.has(e.to) : keep.has(e.from)
    const dst = b.lane === 'source' ? keep.has(e.from) : keep.has(e.to)
    return src && dst
  })
  for (const e of kept) {
    keep.add(e.from)
    keep.add(e.to)
  }
  const out = [...nodes.values()].filter((n) => keep.has(n.id)).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
  return {
    nodes: out,
    edges: kept.sort((a, b) => a.ts - b.ts),
    loggedSince: seed?.loggedSince ?? events[0]?.ts,
    events: (seed?.events ?? 0) + events.length,
    projects: [...projects.values()].sort((a, b) => a.localeCompare(b))
  }
}

/** The task an event belongs to, when it has one. */
const eventTask = (e: LineageEvent): number | undefined => ('taskId' in e && e.kind !== 'task-file-read' ? e.taskId : 'actor' in e ? e.actor.taskId : undefined)

/** The project of each task a batch itself tells (#213): a worker's start or merge in it. The view asks this before
 *  the task list, so a worker whose start is in the same batch is placed even when the graph has not seen it. */
export function taskProjectsOf(events: LineageEvent[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const e of events) if ((e.kind === 'worker-started' || e.kind === 'worker-merged') && !out.has(e.taskId)) out.set(e.taskId, e.project)
  return out
}

/**
 * Whether a live event can show under the filter (#210): inside the day window, and with a task picked, about that
 * task or touching one of its artifacts already in the graph (the one-hop rule). With a project picked and no task
 * (#213): a worker of that project starting, merging or touching anything; Corvid, or a worker whose project is
 * not known, touching a node already in the graph; never another project's worker. `taskProject` tells a task's
 * project when the graph does not know it yet (a worker whose start is in the same batch). An event that cannot
 * show is dropped, not queued.
 */
export function eventInFilter(e: LineageEvent, filter: LineageFilter, g: LineageGraph, now = Date.now(), taskProject?: (taskId: number) => string | undefined): boolean {
  const inDays = !filter.days || filter.days <= 0 || e.ts >= now - filter.days * 86_400_000
  if (filter.taskId === undefined && !filter.project) return inDays
  const has = (id: string): boolean => g.nodes.some((n) => n.id === id)
  if (filter.taskId === undefined) {
    if (!inDays) return false
    const project = normProject(filter.project!)
    if (e.kind === 'worker-started' || e.kind === 'worker-merged') return normProject(e.project) === project
    if (e.kind === 'worker-ended') return false
    if (e.kind === 'ping') return has(postNodeId(e.messageId))
    // the actor's project: the graph's worker node, any node of its task, then the task itself
    const taskId = e.actor.kind === 'assistant' ? undefined : e.actor.taskId
    const actorProject = e.actor.kind === 'assistant' ? undefined : (g.nodes.find((n) => n.taskId === taskId && n.project)?.project ?? (taskId !== undefined && taskProject?.(taskId) ? normProject(taskProject(taskId)!) : undefined))
    if (actorProject === project) return true
    if (actorProject !== undefined) return false
  } else if (eventTask(e) === filter.taskId || (e.kind === 'task-file-read' && e.taskId === filter.taskId)) return true
  switch (e.kind) {
    case 'note-read':
    case 'note-written':
      return has(noteNodeId(e.noteId))
    case 'board-read':
      return e.messageIds.some((m) => has(postNodeId(m)))
    case 'board-post':
    case 'ping':
      return has(postNodeId(e.messageId))
    default:
      return false
  }
}

/** The context receipt of an agent node: what it started with, then everything it read and wrote, in time order. */
export interface ReceiptLine {
  ts: number
  what: 'started with' | 'read' | 'wrote' | 'merged into'
  node: LineageNode
  chars?: number
  action?: string
}

export function receiptOf(g: LineageGraph, agentId: string): ReceiptLine[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const lines: ReceiptLine[] = []
  for (const e of g.edges) {
    if (e.to === agentId && e.kind === 'started') lines.push({ ts: e.ts, what: 'started with', node: byId.get(e.from)!, chars: e.chars })
    else if (e.to === agentId && e.kind === 'read') lines.push({ ts: e.ts, what: 'read', node: byId.get(e.from)!, action: e.action })
    else if (e.from === agentId && e.kind === 'wrote') lines.push({ ts: e.ts, what: 'wrote', node: byId.get(e.to)!, action: e.action })
    else if (e.from === agentId && e.kind === 'merged') lines.push({ ts: e.ts, what: 'merged into', node: byId.get(e.to)! })
  }
  // the sort is stable, so inputs keep the order they were given in
  const rank = (w: ReceiptLine['what']): number => (w === 'started with' ? 0 : 1)
  return lines.filter((l) => l.node).sort((a, b) => a.ts - b.ts || rank(a.what) - rank(b.what))
}

/** Who wrote an artifact and who read it, with when. */
export function readersOf(g: LineageGraph, nodeId: string): { by?: LineageNode; readers: { node: LineageNode; ts: number; action?: string }[] } {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const n = byId.get(nodeId)
  return {
    by: n?.by ? byId.get(n.by) : undefined,
    readers: g.edges
      .filter((e) => e.from === nodeId && e.kind === 'read')
      .map((e) => ({ node: byId.get(e.to)!, ts: e.ts, action: e.action }))
      .filter((r) => r.node)
      .sort((a, b) => a.ts - b.ts)
  }
}
