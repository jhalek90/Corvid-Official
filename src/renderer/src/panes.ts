// The main area is a tree of splits whose leaves are panes; each pane holds tabs.
// A view lives in at most one tab, so the views (and the store state they share) never run twice.
// A tab can also hold one agent's terminal ('term:<termId>'), opened out of its card in the Agents view,
// or one of the general shells ('shell:<termId>', #111), pulled out of the side panel; a shell with a tab
// shows there and nowhere else, and one without a tab lives in the side panel.
// The tree is plain data: every operation returns a new tree, and the store saves it to localStorage.

import type { View } from './store'

export type Dir = 'row' | 'col'

/** An agent's terminal in its own tab. */
export type TermTab = `term:${string}`
/** A general shell in a tab of its own (#111). */
export type ShellTab = `shell:${string}`
export type Tab = View | TermTab | ShellTab

export const termTab = (termId: string): TermTab => `term:${termId}`
export const isTermTab = (t: Tab): t is TermTab => t.startsWith('term:')
export const termIdOf = (t: TermTab): string => t.slice(5)
export const shellTab = (termId: string): ShellTab => `shell:${termId}`
export const isShellTab = (t: Tab): t is ShellTab => t.startsWith('shell:')
export const shellIdOf = (t: ShellTab): string => t.slice(6)
/** One of the views, rather than a terminal or a shell. */
export const isViewTab = (t: Tab): t is View => !isTermTab(t) && !isShellTab(t)

export interface PaneNode {
  kind: 'pane'
  id: string
  tabs: Tab[]
  active?: Tab
}

export interface SplitNode {
  kind: 'split'
  id: string
  dir: Dir
  children: LayoutNode[]
  /** fractions of the split, summing to 1 */
  sizes: number[]
}

export type LayoutNode = PaneNode | SplitNode

export interface PaneLayout {
  root: LayoutNode
  /** the pane that the rail, shortcuts and in-app links open views into */
  focus: string
}

export const VIEWS: View[] = ['terminals', 'tasks', 'usage', 'projects', 'notes', 'connections', 'extensions', 'docs', 'lineage', 'settings']

/** Splitting stops here; with one view per tab, more panes than views is just clutter. */
export const MAX_PANES = VIEWS.length

const KEY = 'paneLayout'

const newId = (): string => Math.random().toString(36).slice(2, 9)

export function defaultLayout(view: View = 'terminals'): PaneLayout {
  const id = newId()
  return { root: { kind: 'pane', id, tabs: [view], active: view }, focus: id }
}

// ---------- queries ----------

export function allPanes(node: LayoutNode): PaneNode[] {
  return node.kind === 'pane' ? [node] : node.children.flatMap(allPanes)
}

export function findPane(l: PaneLayout, id: string): PaneNode | undefined {
  return allPanes(l.root).find((p) => p.id === id)
}

export function paneOf(l: PaneLayout, view: Tab): PaneNode | undefined {
  return allPanes(l.root).find((p) => p.tabs.includes(view))
}

/** The focused pane's active view; undefined when that pane is empty or shows a terminal or a shell. */
export function focusedView(l: PaneLayout): View | undefined {
  const t = findPane(l, l.focus)?.active
  return t && isViewTab(t) ? t : undefined
}

/** Views showing right now (the active tab of each pane). */
export function visibleViews(l: PaneLayout): View[] {
  return allPanes(l.root).flatMap((p) => (p.active && isViewTab(p.active) ? [p.active] : []))
}

/** The shells that have a tab in the panes, open or not. */
export function shellTabs(l: PaneLayout): string[] {
  return allPanes(l.root).flatMap((p) => p.tabs.filter(isShellTab).map(shellIdOf))
}

/** The shells showing in the panes right now (the active tab of a pane), the focused pane's first. */
export function visibleShells(l: PaneLayout): string[] {
  const panes = allPanes(l.root).sort((a, b) => Number(b.id === l.focus) - Number(a.id === l.focus))
  return panes.flatMap((p) => (p.active && isShellTab(p.active) ? [shellIdOf(p.active)] : []))
}

/** The terminals that have a tab of their own, open or not. */
export function termTabs(l: PaneLayout): string[] {
  return allPanes(l.root).flatMap((p) => p.tabs.filter(isTermTab).map(termIdOf))
}

// ---------- tree plumbing ----------

function mapPanes(node: LayoutNode, fn: (p: PaneNode) => PaneNode): LayoutNode {
  if (node.kind === 'pane') return fn(node)
  return { ...node, children: node.children.map((c) => mapPanes(c, fn)) }
}

function updatePane(l: PaneLayout, id: string, fn: (p: PaneNode) => PaneNode): PaneLayout {
  return { ...l, root: mapPanes(l.root, (p) => (p.id === id ? fn(p) : p)) }
}

function withoutTab(p: PaneNode, view: Tab): PaneNode {
  const i = p.tabs.indexOf(view)
  if (i < 0) return p
  const tabs = p.tabs.filter((t) => t !== view)
  // An agent's terminal goes back to its card, so closing its tab shows the cards when they share the pane.
  const back = isTermTab(view) && tabs.includes('terminals') ? 'terminals' : tabs[Math.min(i, tabs.length - 1)]
  const active = p.active === view ? (back ?? undefined) : p.active
  return { ...p, tabs, active }
}

/** Drops a node; its share of the split goes to its neighbour, and one-child splits collapse. */
function removeNode(node: LayoutNode, id: string): LayoutNode | undefined {
  if (node.id === id) return undefined
  if (node.kind === 'pane') return node
  const children: LayoutNode[] = []
  const sizes: number[] = []
  let carry = 0 // share of a removed first child, waiting for the next one
  node.children.forEach((c, i) => {
    const next = removeNode(c, id)
    if (next) {
      children.push(next)
      sizes.push(node.sizes[i] + carry)
      carry = 0
    } else if (sizes.length) sizes[sizes.length - 1] += node.sizes[i]
    else carry += node.sizes[i]
  })
  if (!children.length) return undefined
  if (children.length === 1) return children[0]
  return flatten({ ...node, children, sizes: normal(sizes) })
}

/** A child split running the same way as its parent merges into it. */
function flatten(s: SplitNode): SplitNode {
  const children: LayoutNode[] = []
  const sizes: number[] = []
  s.children.forEach((c, i) => {
    if (c.kind === 'split' && c.dir === s.dir) {
      children.push(...c.children)
      sizes.push(...c.sizes.map((f) => f * s.sizes[i]))
    } else {
      children.push(c)
      sizes.push(s.sizes[i])
    }
  })
  return { ...s, children, sizes: normal(sizes) }
}

function normal(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0)
  return sum > 0 ? sizes.map((f) => f / sum) : sizes.map(() => 1 / sizes.length)
}

function removePane(l: PaneLayout, id: string): PaneLayout {
  const panes = allPanes(l.root)
  if (panes.length <= 1) return l
  const root = removeNode(l.root, id)!
  const focus = l.focus === id ? allPanes(root)[Math.max(0, panes.findIndex((p) => p.id === id) - 1)].id : l.focus
  return { root, focus }
}

// ---------- operations ----------

export function focusPane(l: PaneLayout, id: string): PaneLayout {
  return l.focus === id || !findPane(l, id) ? l : { ...l, focus: id }
}

export function activateTab(l: PaneLayout, paneId: string, view: Tab): PaneLayout {
  return { ...updatePane(l, paneId, (p) => ({ ...p, active: view })), focus: paneId }
}

// ---------- where a newly opened view goes (#109) ----------
// A view that isn't open anywhere gets a pane of its own, split off an existing one, while there's room;
// otherwise (or with the setting on tabs) it opens as a tab, as before. Only opening something new splits:
// a view that already has a tab, hidden or not, is shown where it is, and nothing else is resized.

/** How a view that isn't open anywhere opens: in a new pane split off an existing one, or as a tab. */
export type OpenIn = 'split' | 'tab'

/** A pane's size on screen, in px. */
export interface Room {
  w: number
  h: number
}

export interface Placement {
  openIn: OpenIn
  /** each pane's size on screen; a pane that isn't measured is never split */
  rooms: Record<string, Room>
  /** the pane to try first, and to add the tab to when nothing splits (the Agents pane, for an agent's terminal) */
  prefer?: string
}

/** Neither half of an automatic split may be smaller than this, or the view opens as a tab instead. */
export const MIN_SPLIT: Room = { w: 360, h: 240 }
/** Automatic splits stop at this many panes, then views open as tabs; the split buttons still go to MAX_PANES. */
export const AUTO_PANES = 4
/** Below this width the panes area counts as narrow (the width the Agents view switches to Cards / Board at), and views open as tabs. */
export const NARROW_MAIN = 760

/**
 * The pane an automatic split cuts in two, and which way, or undefined when a tab fits better.
 * Tried in order: the preferred pane, the focused one while it has more than half the area of the largest
 * (so repeated opens even out into a grid instead of carving the focused pane ever smaller), then the rest
 * from largest to smallest. A pane splits
 * across its longer side (to the right when it is at least as wide as tall, otherwise below), or across the
 * other side when only that leaves both halves usable. Splitting the longer side makes successive splits alternate.
 */
export function pickSplit(l: PaneLayout, place: Placement): { paneId: string; dir: Dir } | undefined {
  const panes = allPanes(l.root)
  if (panes.length >= AUTO_PANES) return undefined
  const area = (id: string): number => (place.rooms[id] ? place.rooms[id].w * place.rooms[id].h : 0)
  const bySize = panes.map((p) => p.id).sort((a, b) => area(b) - area(a))
  const focus = area(l.focus) > area(bySize[0]) / 2 ? l.focus : undefined
  const order = [...new Set([place.prefer, focus, ...bySize])]
  for (const id of order) {
    const r = id && panes.some((p) => p.id === id) ? place.rooms[id] : undefined
    if (!r) continue
    // the divider takes a pixel; half of what's left must still be a usable pane
    const fits: Record<Dir, boolean> = {
      row: (r.w - 1) / 2 >= MIN_SPLIT.w && r.h >= MIN_SPLIT.h,
      col: (r.h - 1) / 2 >= MIN_SPLIT.h && r.w >= MIN_SPLIT.w
    }
    const long: Dir = r.w >= r.h ? 'row' : 'col'
    const short: Dir = long === 'row' ? 'col' : 'row'
    if (fits[long]) return { paneId: id!, dir: long }
    if (fits[short]) return { paneId: id!, dir: short }
  }
  return undefined
}

/** Opens a view that isn't open anywhere: in a new pane when the placement allows one, otherwise as a tab. */
function openNew(l: PaneLayout, view: Tab, place?: Placement): PaneLayout {
  const at = place?.openIn === 'split' ? pickSplit(l, place) : undefined
  if (at) return splitPane(l, at.paneId, at.dir, view)
  return insertTab(l, place?.prefer && findPane(l, place.prefer) ? place.prefer : l.focus, view)
}

/**
 * Shows a view. One with a tab gets that tab activated and its pane focused, even when the tab was hidden:
 * it was opened on purpose, so it isn't opened a second time. One that isn't open anywhere opens per `place`
 * (a split or a tab); without a placement it opens as a tab in the focused pane, as before #109.
 */
export function reveal(l: PaneLayout, view: Tab, place?: Placement): PaneLayout {
  const home = paneOf(l, view)
  if (home) return home.active === view && l.focus === home.id ? l : activateTab(l, home.id, view)
  return openNew(l, view, place)
}

/** Shows an agent's terminal in its tab, opening one beside the Agents tab (or in the focused pane) the first time:
 *  in a pane split off the Agents pane when `place` allows, otherwise as a tab there. */
export function revealTerm(l: PaneLayout, termId: string, place?: Placement): PaneLayout {
  const tab = termTab(termId)
  if (paneOf(l, tab)) return reveal(l, tab)
  const prefer = paneOf(l, 'terminals')?.id ?? l.focus
  return openNew(l, tab, place ? { ...place, prefer } : { openIn: 'tab', rooms: {}, prefer })
}

/** Drops the tabs of terminals that are gone (a removed agent, or one from before a restart). */
export function pruneTermTabs(l: PaneLayout, alive: Set<string>): PaneLayout {
  let next = l
  for (const p of allPanes(l.root))
    for (const t of p.tabs) if (isTermTab(t) && !alive.has(termIdOf(t))) next = closeTab(next, p.id, t)
  return next
}

/** Drops the tabs of shells that are gone (closed, or from before a restart: shells don't outlive the app). */
export function pruneShellTabs(l: PaneLayout, alive: Set<string>): PaneLayout {
  let next = l
  for (const p of allPanes(l.root))
    for (const t of p.tabs) if (isShellTab(t) && !alive.has(shellIdOf(t))) next = closeTab(next, p.id, t)
  return next
}

/** Opens a view in a pane, after its active tab; a view open elsewhere moves here. */
export function insertTab(l: PaneLayout, paneId: string, view: Tab, index?: number): PaneLayout {
  const from = paneOf(l, view)
  let next = l
  if (from && from.id !== paneId) {
    next = updatePane(next, from.id, (p) => withoutTab(p, view))
    if (!findPane(next, from.id)!.tabs.length) next = removePane({ ...next, focus: paneId }, from.id)
  }
  next = updatePane(next, paneId, (p) => {
    const tabs = p.tabs.filter((t) => t !== view)
    let at = index ?? (p.active ? tabs.indexOf(p.active) + 1 : tabs.length)
    // Reordering within a pane: the drop index was counted with the tab still in place.
    if (index !== undefined && from?.id === paneId && p.tabs.indexOf(view) < index) at--
    tabs.splice(Math.max(0, Math.min(at, tabs.length)), 0, view)
    return { ...p, tabs, active: view }
  })
  return { ...next, focus: paneId }
}

/** Closes a tab; a pane left empty closes too, unless it is the last one. */
export function closeTab(l: PaneLayout, paneId: string, view: Tab): PaneLayout {
  const next = updatePane(l, paneId, (p) => withoutTab(p, view))
  return findPane(next, paneId)!.tabs.length ? next : removePane(next, paneId)
}

export function closePane(l: PaneLayout, paneId: string): PaneLayout {
  return removePane(l, paneId)
}

/** Where a pane is dropped against another: the centre merges tabs, an edge splits beside it. */
export type DropSide = 'left' | 'right' | 'top' | 'bottom'

/** Puts `fresh` beside a node, halving that node's share; joins the parent split when it runs the same way. */
function insertBeside(node: LayoutNode, targetId: string, fresh: LayoutNode, dir: Dir, before: boolean): LayoutNode {
  const pair = (t: LayoutNode): LayoutNode[] => (before ? [fresh, t] : [t, fresh])
  if (node.id === targetId) return { kind: 'split', id: newId(), dir, children: pair(node), sizes: [0.5, 0.5] }
  if (node.kind === 'pane') return node
  const i = node.children.findIndex((c) => c.id === targetId)
  if (i >= 0 && node.dir === dir) {
    const children = [...node.children]
    const sizes = [...node.sizes]
    children.splice(i, 1, ...pair(children[i]))
    sizes.splice(i, 1, sizes[i] / 2, sizes[i] / 2)
    return { ...node, children, sizes }
  }
  return { ...node, children: node.children.map((c) => insertBeside(c, targetId, fresh, dir, before)) }
}

const sideDir = (side: DropSide): Dir => (side === 'left' || side === 'right' ? 'row' : 'col')
const sideBefore = (side: DropSide): boolean => side === 'left' || side === 'top'

/**
 * Splits a pane in two. The new pane takes the active tab if the pane has others to keep;
 * otherwise it starts empty and offers a picker.
 */
export function splitPane(l: PaneLayout, paneId: string, dir: Dir, view?: Tab): PaneLayout {
  const src = findPane(l, paneId)
  if (!src || allPanes(l.root).length >= MAX_PANES) return l
  const fresh: PaneNode = { kind: 'pane', id: newId(), tabs: [] }
  const next = { root: insertBeside(l.root, paneId, fresh, dir, false), focus: fresh.id }
  const move = view ?? (src.tabs.length > 1 ? src.active : undefined)
  return move ? insertTab(next, fresh.id, move) : next
}

/** Moves every tab of one pane into another (at `index`, or after its active tab) and closes the first. */
export function mergePane(l: PaneLayout, fromId: string, toId: string, index?: number): PaneLayout {
  const from = findPane(l, fromId)
  const to = findPane(l, toId)
  if (!from || !to || fromId === toId) return l
  const tabs = [...to.tabs]
  const at = index ?? (to.active ? tabs.indexOf(to.active) + 1 : tabs.length)
  tabs.splice(Math.max(0, Math.min(at, tabs.length)), 0, ...from.tabs)
  const next = updatePane(removePane(l, fromId), toId, (p) => ({ ...p, tabs, active: from.active ?? p.active }))
  return { ...next, focus: toId }
}

/** Moves a whole pane, tabs and all, to one side of another pane. */
export function dockPane(l: PaneLayout, fromId: string, toId: string, side: DropSide): PaneLayout {
  const from = findPane(l, fromId)
  if (!from || !findPane(l, toId) || fromId === toId) return l
  const root = removeNode(l.root, fromId)!
  return { root: insertBeside(root, toId, from, sideDir(side), sideBefore(side)), focus: fromId }
}

/** Opens a view in a new pane on one side of a pane; the view leaves the tab it had. */
export function dockTab(l: PaneLayout, view: Tab, toId: string, side: DropSide): PaneLayout {
  const home = paneOf(l, view)
  const target = findPane(l, toId)
  if (!target || (home?.id === toId && target.tabs.length === 1)) return l
  // A pane left empty by the move closes, so moving a pane's only tab never adds a pane.
  if (allPanes(l.root).length >= MAX_PANES && !(home && home.tabs.length === 1)) return l
  let next = l
  if (home) {
    next = updatePane(next, home.id, (p) => withoutTab(p, view))
    if (!findPane(next, home.id)!.tabs.length) next = removePane(next, home.id)
  }
  const fresh: PaneNode = { kind: 'pane', id: newId(), tabs: [view], active: view }
  return { root: insertBeside(next.root, toId, fresh, sideDir(side), sideBefore(side)), focus: fresh.id }
}

export function setSizes(l: PaneLayout, splitId: string, sizes: number[]): PaneLayout {
  const walk = (node: LayoutNode): LayoutNode =>
    node.kind === 'pane' ? node : node.id === splitId ? { ...node, sizes: normal(sizes) } : { ...node, children: node.children.map(walk) }
  return { ...l, root: walk(l.root) }
}

// ---------- persistence ----------

export function loadLayout(): PaneLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PaneLayout | null
    if (raw) return sanitize(raw)
  } catch {
    /* fall through */
  }
  return defaultLayout()
}

export function saveLayout(l: PaneLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l))
  } catch {
    /* ignore */
  }
}

/**
 * Repairs whatever was saved: unknown or repeated views go, empty splits collapse, sizes renormalise.
 * A pane whose only views are gone (the removed Sessions view, say) closes rather than showing empty.
 * A saved Live tab (the view #64 removed) becomes Agents, which took over what it showed.
 * Agents' terminal tabs and shell tabs are kept here; once the terminals are known, pruneTermTabs and
 * pruneShellTabs drop the gone ones.
 */
const RENAMED: Record<string, View> = { live: 'terminals' }
const renamed = (v: Tab): Tab => RENAMED[v] ?? v
const known = (t: Tab): boolean => VIEWS.includes(t as View) || (isTermTab(t) && t.length > 5) || (isShellTab(t) && t.length > 6)

function sanitize(raw: PaneLayout): PaneLayout {
  const seen = new Set<Tab>()
  const ids = new Set<string>()
  const uniqueId = (id: unknown): string => {
    const s = typeof id === 'string' && id && !ids.has(id) ? id : newId()
    ids.add(s)
    return s
  }
  const walk = (n: LayoutNode | undefined): LayoutNode | undefined => {
    if (!n || typeof n !== 'object') return undefined
    if (n.kind === 'pane') {
      const saved = (Array.isArray(n.tabs) ? n.tabs : []).map(renamed)
      const tabs = saved.filter((t) => typeof t === 'string' && known(t) && !seen.has(t) && seen.add(t))
      if (saved.length && !tabs.length) return undefined
      const active = n.active && renamed(n.active)
      return { kind: 'pane', id: uniqueId(n.id), tabs, active: active && tabs.includes(active) ? active : tabs[0] }
    }
    if (n.kind !== 'split' || !Array.isArray(n.children)) return undefined
    const kept = n.children.map((c, i) => [walk(c), Number(n.sizes?.[i]) || 1 / n.children.length] as const).filter(([c]) => c)
    if (!kept.length) return undefined
    if (kept.length === 1) return kept[0][0]
    return flatten({
      kind: 'split',
      id: uniqueId(n.id),
      dir: n.dir === 'col' ? 'col' : 'row',
      children: kept.map(([c]) => c!),
      sizes: normal(kept.map(([, s]) => Math.max(0.05, s)))
    })
  }
  const root = walk(raw.root)
  if (!root) return defaultLayout()
  const panes = allPanes(root)
  return { root, focus: panes.some((p) => p.id === raw.focus) ? raw.focus : panes[0].id }
}
