// Pure helpers for the 3D Context cloud view (#205; named Lineage until #209): the node cap, the time fade, degrees and the colour and shape of a
// node. No React, no three.js, so the unit tests load this file on its own.
import type { LineageEdge, LineageGraph, LineageNode, ProjectRelation } from '@shared/lineage'

/** More nodes than this and the picture stops being one; the oldest go first. */
export const NODE_CAP = 2000
/** Above this many edges only every n-th read or wrote edge carries a particle. */
export const PARTICLE_EDGE_CAP = 500

/** The newest `max` nodes and the edges between them. `dropped` says how many old nodes fell off. */
export function capNodes(g: LineageGraph, max = NODE_CAP): { graph: LineageGraph; dropped: number } {
  if (g.nodes.length <= max) return { graph: g, dropped: 0 }
  const nodes = [...g.nodes].sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id)).slice(0, max)
  const keep = new Set(nodes.map((n) => n.id))
  const edges = g.edges.filter((e) => keep.has(e.from) && keep.has(e.to))
  return { graph: { ...g, nodes, edges }, dropped: g.nodes.length - max }
}

/** How bright a node is for its age: the newest 1, the oldest `floor`, linear in between. One node is bright. */
export function fadeOf(ts: number, oldest: number, newest: number, floor = 0.22): number {
  if (newest <= oldest) return 1
  const t = (ts - oldest) / (newest - oldest)
  return floor + Math.max(0, Math.min(1, t)) * (1 - floor)
}

/** The oldest and newest time in a graph, or undefined when it is empty. */
export function timeSpan(nodes: LineageNode[]): { oldest: number; newest: number } | undefined {
  if (!nodes.length) return undefined
  let oldest = Infinity
  let newest = -Infinity
  for (const n of nodes) {
    if (n.ts < oldest) oldest = n.ts
    if (n.ts > newest) newest = n.ts
  }
  return { oldest, newest }
}

/** Edges per node. */
export function degrees(edges: LineageEdge[]): Map<string, number> {
  const d = new Map<string, number>()
  for (const e of edges) {
    d.set(e.from, (d.get(e.from) ?? 0) + 1)
    d.set(e.to, (d.get(e.to) ?? 0) + 1)
  }
  return d
}

/** A node's radius from its degree: a floor so lone nodes still show, a slow growth so hubs don't swallow the rest. */
export function radiusOf(degree: number, corvid = false): number {
  const r = 1.6 + Math.sqrt(Math.max(0, degree)) * 0.75
  return corvid ? Math.max(7, r * 1.8) : Math.min(r, 6)
}

export type Shape = 'sphere' | 'box' | 'octa'

export interface NodeStyle {
  /** 0xRRGGBB */
  color: number
  shape: Shape
}

/** The project tints (#213), in a project view: a node of another project (a note or post written there and read
 *  here) is coral, loud on purpose; one shared by everyone (Corvid, the rules, the thesis, the user's notes) is a
 *  quiet grey-violet. The same values sit in lineage.css for the legend. */
export const FOREIGN_COLOR = 0xff7a4d
export const SHARED_COLOR = 0xa9a6c2

/** Colours by kind: sources amber, workers cyan, Corvid white-violet, notes and posts green, done posts and merges
 *  bright green, the user's own notes rose. A gone artifact is grey. In a project view (#213) a foreign or shared
 *  node takes its tint instead, the shape stays; a gone one stays grey. */
export function styleOf(n: LineageNode, relation: ProjectRelation = 'own'): NodeStyle {
  const shape: Shape = n.lane === 'agent' ? 'sphere' : n.lane === 'source' || n.type === 'project' ? 'octa' : 'box'
  if (n.gone) return { color: 0x5a6070, shape: n.lane === 'agent' ? 'sphere' : 'box' }
  if (relation === 'foreign') return { color: FOREIGN_COLOR, shape }
  if (relation === 'shared') return { color: SHARED_COLOR, shape }
  if (n.lane === 'source') return { color: 0xf0b45a, shape }
  if (n.lane === 'agent') return n.type === 'corvid' ? { color: 0xd8c8ff, shape } : { color: 0x4fd3ff, shape }
  if (n.type === 'project') return { color: 0x7dffb0, shape }
  if (n.type === 'done') return { color: 0x62e68a, shape }
  // a note or post nobody is recorded as writing is the user's own
  if (!n.by) return { color: 0xff7ab8, shape }
  return { color: n.type === 'note' ? 0x8fe3a8 : 0x6fc9a0, shape }
}

/** Which edges get a moving particle: every read and wrote edge up to the cap, then every n-th so the count stays
 *  around the cap. Started and merged edges never do. */
export function particleEdges(edges: LineageEdge[], cap = PARTICLE_EDGE_CAP): number[] {
  const flow: number[] = []
  edges.forEach((e, i) => (e.kind === 'read' || e.kind === 'wrote') && flow.push(i))
  if (flow.length <= cap) return flow
  const step = Math.ceil(flow.length / cap)
  return flow.filter((_, i) => i % step === 0)
}

/** Rest length of an edge's spring in the layout: what a worker started with sits close, what it merged sits far. */
export function restLength(kind: LineageEdge['kind']): number {
  return kind === 'started' ? 14 : kind === 'merged' ? 30 : 20
}

/** How much a node, edge or particle shows while a node is picked (#209): the picked node, its neighbours and the
 *  edges to them, and everything else. With nothing picked, everything is at `none`. */
export type Level = 'none' | 'selected' | 'neighbour' | 'other'

export const LEVEL_OPACITY: Record<Level, number> = { none: 1, selected: 1, neighbour: 0.9, other: 0.2 }

/** Which level a node is at: `none` when nothing is picked. */
export function levelOf(id: string, selected: string | undefined, neighbours: Set<string>): Level {
  if (!selected) return 'none'
  if (id === selected) return 'selected'
  return neighbours.has(id) ? 'neighbour' : 'other'
}

/** The level of an edge between `a` and `b`: an edge that touches the picked node is on the path to a neighbour. */
export function edgeLevelOf(a: string, b: string, selected: string | undefined): Level {
  if (!selected) return 'none'
  return a === selected || b === selected ? 'neighbour' : 'other'
}

/** The brightness of a thing at a level, given its time fade (1 newest, `floor` oldest): the picked node is at full
 *  brightness whatever its age; the rest keep the fade inside the level, so an old neighbour never outshines a new
 *  one and is at most 90%. */
export function brightnessOf(level: Level, fade: number): number {
  if (level === 'selected') return 1
  return LEVEL_OPACITY[level] * Math.max(0, Math.min(1, fade))
}

/** The level as a factor on linear light. The scene draws in linear light and the screen shows sRGB, so a 20% look
 *  needs a much smaller linear factor: a plain 0.2 shows as about half brightness against black. */
export function linearGain(level: Level): number {
  return Math.pow(LEVEL_OPACITY[level], 2.2)
}

// ---------- live updates (#210) ----------

/** How long an edge counts as active after its event, then how long it eases back to its normal level. */
export const ACTIVE_MS = 10_000
export const ACTIVE_EASE_MS = 10_000
/** An active edge outside a pick's selection still shows at this level, so live traffic is never hidden. */
export const ACTIVE_OTHER_OPACITY = 0.6
/** A new node pulses for this long, then joins the time fade. */
export const ARRIVAL_PULSE_MS = 1000
/** A running worker's "started with" edges hold this level, the neighbour level, so you see what it works from. */
export const RUNNING_STARTED_OPACITY = LEVEL_OPACITY.neighbour
/** Particles on an active edge: this many times the normal speed, and this many extra particles per edge. */
export const ACTIVE_PARTICLE_SPEED = 3
export const ACTIVE_PARTICLE_EXTRA = 2

export type Activity = 'active' | 'easing' | 'normal'

/** How far an edge is from its event: 1 while active, easing down to 0 over the next ACTIVE_EASE_MS, then 0. A
 *  repeat of the event (a newer `eventTs`) restarts it. */
export function activityOf(eventTs: number | undefined, now: number): number {
  if (eventTs === undefined) return 0
  const age = now - eventTs
  if (age < 0) return 1
  if (age < ACTIVE_MS) return 1
  if (age >= ACTIVE_MS + ACTIVE_EASE_MS) return 0
  const t = (age - ACTIVE_MS) / ACTIVE_EASE_MS
  // ease out: quick at first, settling gently
  return 1 - t * t
}

export function activityStateOf(eventTs: number | undefined, now: number): Activity {
  const a = activityOf(eventTs, now)
  return a >= 1 ? 'active' : a > 0 ? 'easing' : 'normal'
}

/**
 * An edge's brightness with the live rules on top of the pick levels (#209): a running worker's started edges hold
 * the neighbour level, and an active edge draws at 100%, or at ACTIVE_OTHER_OPACITY outside a selection, easing
 * back to its normal level with `activity`.
 */
export function liveEdgeOpacity(level: Level, fade: number, kind: LineageEdge['kind'], activity: number, running: boolean): number {
  let normal = brightnessOf(level, fade)
  if (running && kind === 'started' && level !== 'other') normal = Math.max(normal, RUNNING_STARTED_OPACITY)
  if (activity <= 0) return normal
  const target = level === 'other' ? ACTIVE_OTHER_OPACITY : 1
  if (activity >= 1) return Math.max(target, normal)
  return normal + (Math.max(target, normal) - normal) * Math.min(1, activity)
}

/** A node's brightness with the live rules: an end of an active edge draws at 100% whatever its age (60% when it
 *  is outside a selection), easing back with `activity`. */
export function liveNodeOpacity(level: Level, fade: number, activity: number): number {
  const normal = brightnessOf(level, fade)
  if (activity <= 0) return normal
  const target = level === 'other' ? ACTIVE_OTHER_OPACITY : 1
  if (activity >= 1) return Math.max(target, normal)
  return normal + (Math.max(target, normal) - normal) * Math.min(1, activity)
}

/** The size of a new node's pulse at `age` ms: a bump that rises and falls within ARRIVAL_PULSE_MS, 1 after. */
export function pulseScale(age: number): number {
  if (age < 0 || age >= ARRIVAL_PULSE_MS) return 1
  return 1 + 0.8 * Math.sin((age / ARRIVAL_PULSE_MS) * Math.PI)
}

/** The breathing of a running worker: a slow scale pulse of a few percent. */
export function breathScale(now: number): number {
  return 1 + 0.07 * Math.sin((now / 1400) * Math.PI)
}

export type Vec3 = [number, number, number]

export interface Merge {
  graph: LineageGraph
  /** where every node sits now: the old ones where they were, the new ones next to their anchor */
  pos: Map<string, Vec3>
  /** the ids of the nodes that arrived */
  added: string[]
  /** the edges that arrived */
  addedEdges: LineageEdge[]
  /** how many of the oldest nodes fell off the cap this time */
  dropped: number
}

/**
 * Grow a graph by what a batch derived (#210), without moving anything: nodes already there keep their position,
 * a new node lands next to the node it attaches to (the agent that read the note, the task the worker started
 * on) with a small random offset, and one with no placed neighbour yet lands at a random spot near the middle.
 * Past the cap the oldest nodes fall off, with their edges, and `dropped` says how many.
 */
export function mergeIncoming(cur: LineageGraph, pos: Map<string, Vec3>, incoming: LineageGraph, max = NODE_CAP, rand: () => number = Math.random): Merge {
  const have = new Set(cur.nodes.map((n) => n.id))
  const edgeKey = (e: LineageEdge): string => `${e.from}|${e.to}|${e.kind}|${e.ts}`
  const haveEdge = new Set(cur.edges.map(edgeKey))
  const fresh = incoming.nodes.filter((n) => !have.has(n.id)).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
  const addedEdges = incoming.edges.filter((e) => !haveEdge.has(edgeKey(e)))
  const out = new Map(pos)
  const jitter = (): Vec3 => [(rand() - 0.5) * 8, (rand() - 0.5) * 8, (rand() - 0.5) * 8]
  const allEdges = [...cur.edges, ...addedEdges]
  for (const n of fresh) {
    let anchor: Vec3 | undefined
    for (const e of allEdges) {
      const other = e.from === n.id ? e.to : e.to === n.id ? e.from : undefined
      if (other === undefined) continue
      const p = out.get(other)
      if (p) {
        anchor = p
        break
      }
    }
    const j = jitter()
    const at: Vec3 = anchor ? [anchor[0] + j[0], anchor[1] + j[1], anchor[2] + j[2]] : [j[0] * 3, j[1] * 3, j[2] * 3]
    out.set(n.id, at)
  }
  let nodes = [...cur.nodes, ...fresh]
  let edges = [...cur.edges, ...addedEdges]
  let dropped = 0
  if (nodes.length > max) {
    const capped = capNodes({ ...incoming, nodes, edges }, max)
    dropped = capped.dropped
    nodes = capped.graph.nodes
    edges = capped.graph.edges
    const keep = new Set(nodes.map((n) => n.id))
    for (const id of [...out.keys()]) if (!keep.has(id)) out.delete(id)
  }
  const keep = new Set(nodes.map((n) => n.id))
  return {
    graph: { ...incoming, nodes, edges },
    pos: out,
    added: fresh.map((n) => n.id).filter((id) => keep.has(id)),
    addedEdges: addedEdges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    dropped
  }
}

/**
 * Catch-up for a view that is not drawing (#210): while hidden, batches are queued; when the view shows again, the
 * whole queue is taken in one step and applied with no pulses and no highlight. Events that cannot show under the
 * filter are dropped at the door, never queued.
 */
export class LiveQueue<T> {
  private waiting: T[] = []
  /** Hand in a batch: applied now when `visible`, queued otherwise. Returns what to apply now, if anything. */
  offer(items: T[], visible: boolean): T[] {
    if (!visible) {
      this.waiting.push(...items)
      return []
    }
    return items
  }
  /** Everything queued while hidden, once; the queue is empty after. */
  take(): T[] {
    const out = this.waiting
    this.waiting = []
    return out
  }
  get size(): number {
    return this.waiting.length
  }
}

// ---------- curved edges (#212) ----------

/** How the edges are drawn: straight lines, or quadratic curves that fan parallel edges apart. Visual only. */
export type EdgeMode = 'straight' | 'curved'
/** A curved edge is this many straight segments in the line batch. */
export const CURVE_SEGMENTS = 10
/** The control point sits this far off the midpoint, as a fraction of the edge's length. */
export const CURVE_BEND = 0.15

/** Line vertices per edge in the batch: two for a straight line, two per segment for a curve. */
export function verticesPerEdge(mode: EdgeMode): number {
  return mode === 'curved' ? CURVE_SEGMENTS * 2 : 2
}

/** Which way an edge bends, as an angle around its own axis in [0, 2π): hashed from the edge's key, so it is the
 *  same every frame and every load, and parallel edges between the same pair get different angles. */
export function bendAngle(key: string): number {
  // FNV-1a, 32 bit
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h / 0x100000000) * Math.PI * 2
}

/** The control point of an edge's curve: the midpoint, pushed `bend` of the edge's length sideways, turned by
 *  `angle` around the edge. Ends that coincide give the midpoint. */
export function controlPoint(a: Vec3, b: Vec3, angle: number, bend = CURVE_BEND): Vec3 {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dz = b[2] - a[2]
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const mid: Vec3 = [a[0] + dx / 2, a[1] + dy / 2, a[2] + dz / 2]
  if (len < 1e-6) return mid
  const nx = dx / len
  const ny = dy / len
  const nz = dz / len
  // a reference axis that is not along the edge, then two unit vectors across it
  const [rx, ry, rz]: Vec3 = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  let ux = ny * rz - nz * ry
  let uy = nz * rx - nx * rz
  let uz = nx * ry - ny * rx
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz)
  ux /= ul
  uy /= ul
  uz /= ul
  const wx = ny * uz - nz * uy
  const wy = nz * ux - nx * uz
  const wz = nx * uy - ny * ux
  const c = Math.cos(angle) * bend * len
  const s = Math.sin(angle) * bend * len
  return [mid[0] + ux * c + wx * s, mid[1] + uy * c + wy * s, mid[2] + uz * c + wz * s]
}

/** A point on the quadratic curve from `a` over `c` to `b`, `t` in [0, 1]. */
export function curvePoint(a: Vec3, c: Vec3, b: Vec3, t: number): Vec3 {
  const u = 1 - t
  const w0 = u * u
  const w1 = 2 * u * t
  const w2 = t * t
  return [w0 * a[0] + w1 * c[0] + w2 * b[0], w0 * a[1] + w1 * c[1] + w2 * b[1], w0 * a[2] + w1 * c[2] + w2 * b[2]]
}
