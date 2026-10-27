import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Activity, Bot, Cable, Columns2, FolderGit2, ListTodo, PanelLeft, Plus, Rows2, Settings, StickyNote, Terminal, X, Blocks, BookOpen, Waypoints } from 'lucide-react'
import { api } from '../api'
import { getState, moveShellToSide, newSideShell, setState, useStore, type View } from '../store'
import {
  MAX_PANES,
  VIEWS,
  activateTab,
  allPanes,
  closePane,
  closeTab,
  dockPane,
  dockTab,
  focusPane,
  insertTab,
  isShellTab,
  isTermTab,
  mergePane,
  paneOf,
  setSizes,
  shellIdOf,
  splitPane,
  termIdOf,
  visibleViews,
  type Dir,
  type DropSide,
  type LayoutNode,
  type PaneLayout,
  type PaneNode,
  type SplitNode,
  type Tab
} from '../panes'
import { TasksView } from '../views/TasksView'
import { AgentTab, AgentTabLabel, AgentsView } from '../views/AgentsView'
import { UsageView } from '../views/UsageView'
import { ProjectsView } from '../views/ProjectsView'
import { SettingsView } from '../views/SettingsView'
import { DocsView } from '../views/DocsView'
import { LineageView } from '../views/LineageView'
import { NotesView } from '../views/NotesView'
import { ConnectionsView } from '../views/ConnectionsView'
import { ExtensionsView } from '../views/ExtensionsView'
import { ErrorBoundary } from './ErrorBoundary'
import { ShellTab, ShellTabLabel, shellTitle } from './ShellTab'

export const VIEW_META: Record<View, { icon: typeof Activity; label: string }> = {
  tasks: { icon: ListTodo, label: 'Tasks' },
  terminals: { icon: Bot, label: 'Agents' },
  usage: { icon: Activity, label: 'Usage' },
  projects: { icon: FolderGit2, label: 'Projects' },
  notes: { icon: StickyNote, label: 'Notes' },
  connections: { icon: Cable, label: 'Connections' },
  extensions: { icon: Blocks, label: 'Extensions' },
  docs: { icon: BookOpen, label: 'Docs' },
  lineage: { icon: Waypoints, label: 'Context cloud' },
  settings: { icon: Settings, label: 'Settings' }
}

/** Agents stays mounted while hidden, so its terminals and scrollback survive. */
const KEEP_MOUNTED: View[] = ['terminals']

/** Below this a pane stops giving way to its neighbour when a divider is dragged. */
const MIN_PANE = { row: 260, col: 140 }

/**
 * Edge drop zones take 30% of the pane's width (left/right) or height (top/bottom), capped at 160px,
 * so small panes still get a usable edge and big ones keep a wide centre for merging tabs.
 */
const EDGE = { frac: 0.3, max: 160 }

const update = (fn: (l: PaneLayout) => PaneLayout): void => setState((s) => ({ layout: fn(s.layout) }))

/** Opens a view in a new pane beside the focused one; with no room left it just shows the view. */
export function openInSplit(view: View, dir: Dir = 'row'): void {
  const l = getState().layout
  const next = splitPane(l, l.focus, dir, view)
  setState(next === l ? { view } : { layout: next })
}

// Each view renders once, through a portal, into a host element that moves between pane slots.
// The views keep their place in the React tree, so splitting or moving a tab never remounts them.
const hosts = new Map<View, HTMLElement>()
function hostFor(view: View): HTMLElement {
  let el = hosts.get(view)
  if (!el) {
    el = document.createElement('section')
    el.className = 'view'
    hosts.set(view, el)
  }
  return el
}

function renderView(view: View, visible: boolean): ReactNode {
  return <ErrorBoundary area={VIEW_META[view].label}>{viewBody(view, visible)}</ErrorBoundary>
}

function viewBody(view: View, visible: boolean): ReactNode {
  switch (view) {
    case 'tasks':
      return <TasksView />
    case 'terminals':
      return <AgentsView visible={visible} />
    case 'usage':
      return <UsageView />
    case 'projects':
      return <ProjectsView />
    case 'notes':
      return <NotesView />
    case 'connections':
      return <ConnectionsView />
    case 'extensions':
      return <ExtensionsView />
    case 'docs':
      return <DocsView />
    case 'lineage':
      return <LineageView />
    case 'settings':
      return <SettingsView />
  }
}

function ViewHosts(): ReactNode {
  const shown = useStore((s) => visibleViews(s.layout).join(' '))
  const visible = new Set(shown.split(' '))
  return VIEWS.filter((v) => visible.has(v) || KEEP_MOUNTED.includes(v)).map((v) => createPortal(renderView(v, visible.has(v)), hostFor(v), v))
}

export function Panes(): ReactNode {
  const root = useStore((s) => s.layout.root)
  return (
    <main className="main">
      <LayoutTree node={root} />
      {/* After the tree, so the slots hold their hosts before the views' own effects run. */}
      <ViewHosts />
    </main>
  )
}

function LayoutTree({ node }: { node: LayoutNode }): ReactNode {
  return node.kind === 'pane' ? <Pane node={node} /> : <Split node={node} />
}

function Split({ node }: { node: SplitNode }): ReactNode {
  return (
    <div className={`split ${node.dir}`}>
      {node.children.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <SplitHandle split={node} />}
          <div className="split-child" style={{ flexGrow: node.sizes[i] }}>
            <LayoutTree node={c} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

/**
 * Divider between two children of a split. Like the #8 resizers it writes straight to the DOM
 * while dragging and only saves the new sizes when the drag ends.
 */
function SplitHandle({ split }: { split: SplitNode }): ReactNode {
  const row = split.dir === 'row'
  const drag = useRef<{ at: number; a: number; b: number }>(undefined)

  const els = (handle: HTMLElement): { a: HTMLElement; b: HTMLElement; all: HTMLElement[] } => ({
    a: handle.previousElementSibling as HTMLElement,
    b: handle.nextElementSibling as HTMLElement,
    all: [...handle.parentElement!.children].filter((c): c is HTMLElement => c.classList.contains('split-child'))
  })
  const size = (el: HTMLElement): number => (row ? el.getBoundingClientRect().width : el.getBoundingClientRect().height)

  /** Gives the pair `a` px to the first child and the rest to the second. */
  const place = (handle: HTMLElement, a: number, pair: number): void => {
    const { a: elA, b: elB, all } = els(handle)
    const avail = all.reduce((s, el) => s + size(el), 0)
    const min = Math.min(MIN_PANE[split.dir], pair / 2)
    const na = Math.max(min, Math.min(pair - min, a))
    elA.style.flexGrow = String(na / avail)
    elB.style.flexGrow = String((pair - na) / avail)
  }

  const save = (handle: HTMLElement): void => {
    const sizes = els(handle).all.map((el) => Number(el.style.flexGrow) || 0)
    update((l) => setSizes(l, split.id, sizes))
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const { a, b } = els(e.currentTarget)
    drag.current = { at: row ? e.clientX : e.clientY, a: size(a), b: size(b) }
    document.body.classList.add('resizing', ...(row ? [] : ['rows']))
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (d) place(e.currentTarget, d.a + (row ? e.clientX : e.clientY) - d.at, d.a + d.b)
  }

  const end = (e: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    drag.current = undefined
    document.body.classList.remove('resizing', 'rows')
    save(e.currentTarget)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 64 : 16
    const dir = e.key === (row ? 'ArrowRight' : 'ArrowDown') ? 1 : e.key === (row ? 'ArrowLeft' : 'ArrowUp') ? -1 : 0
    if (!dir) return
    e.preventDefault()
    const { a, b } = els(e.currentTarget)
    place(e.currentTarget, size(a) + dir * step, size(a) + size(b))
    save(e.currentTarget)
  }

  const onDoubleClick = (e: { currentTarget: HTMLDivElement }): void => {
    const { a, b } = els(e.currentTarget)
    const pair = size(a) + size(b)
    place(e.currentTarget, pair / 2, pair)
    save(e.currentTarget)
  }

  return (
    <div
      className={`split-handle ${split.dir}`}
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      tabIndex={0}
      title="Drag to resize · double-click to even out"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  )
}

function Pane({ node }: { node: PaneNode }): ReactNode {
  const focused = useStore((s) => s.layout.focus === node.id)
  const multi = useStore((s) => s.layout.root.kind === 'split')
  const drag = useDrag()
  const ref = useRef<HTMLDivElement>(null)

  // Native listener: the view inside is a portal, so its React events never bubble through here.
  useEffect(() => {
    const el = ref.current!
    const onDown = (): void => {
      if (getState().layout.focus !== node.id) update((l) => focusPane(l, node.id))
    }
    el.addEventListener('pointerdown', onDown, true)
    return () => el.removeEventListener('pointerdown', onDown, true)
  }, [node.id])

  return (
    <div
      ref={ref}
      data-pane={node.id}
      className={`pane${focused ? ' focused' : ''}${multi ? ' multi' : ''}${drag?.kind === 'pane' && drag.id === node.id ? ' lifted' : ''}`}
    >
      <PaneTabs node={node} multi={multi} />
      {!node.active ? <EmptyPane node={node} /> : isTermTab(node.active) ? (
        <ErrorBoundary area="Agent tab">
          <AgentTab termId={termIdOf(node.active)} />
        </ErrorBoundary>
      ) : isShellTab(node.active) ? (
        <ErrorBoundary area="Shell tab">
          <ShellTab termId={shellIdOf(node.active)} />
        </ErrorBoundary>
      ) : <ViewSlot view={node.active} />}
      {drag && <DockTarget node={node} item={drag} />}
    </div>
  )
}

function ViewSlot({ view }: { view: View }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = ref.current!
    const host = hostFor(view)
    slot.appendChild(host)
    return () => {
      if (host.parentNode === slot) slot.removeChild(host)
    }
  }, [view])
  return <div className="pane-body" ref={ref} />
}

// ---------- dragging tabs and panes ----------
// dataTransfer can't be read until the drop, so the dragged item lives here; the MIME type only
// tells our drags apart from files or text dragged in from elsewhere.

/** A single tab, or a whole pane grabbed by its tab strip. A shell docked in the side panel drags as a tab too (#111). */
export type DragItem = { kind: 'tab'; view: Tab } | { kind: 'pane'; id: string }
type Zone = DropSide | 'centre'

const DOCK_MIME = 'application/x-dashboard-dock'
let dragItem: DragItem | undefined
let dragShown: DragItem | undefined
const dragSubs = new Set<() => void>()

export function startDrag(e: DragEvent, item: DragItem): void {
  e.dataTransfer.setData(DOCK_MIME, '')
  e.dataTransfer.effectAllowed = 'move'
  dragItem = item
  // Drop targets appear on the next tick: changing the DOM inside dragstart can cancel the drag.
  setTimeout(() => {
    if (dragItem !== item) return
    dragShown = item
    dragSubs.forEach((f) => f())
  })
}

export function endDrag(): void {
  dragItem = dragShown = undefined
  dragSubs.forEach((f) => f())
}

const subscribeDrag = (f: () => void): (() => void) => {
  dragSubs.add(f)
  return () => dragSubs.delete(f)
}
export const useDrag = (): DragItem | undefined => useSyncExternalStore(subscribeDrag, () => dragShown)

export const dragged = (e: DragEvent): DragItem | undefined => (e.dataTransfer.types.includes(DOCK_MIME) ? dragItem : undefined)

/** The chip under the pointer while a pane is dragged: its active view, plus how many tabs come along. */
function paneDragImage(e: DragEvent, node: PaneNode): void {
  const ghost = document.createElement('div')
  ghost.className = 'drag-ghost'
  const lead = !node.active ? 'Empty pane' : isTermTab(node.active) ? 'Agent terminal' : isShellTab(node.active) ? 'Shell' : VIEW_META[node.active].label
  ghost.textContent = node.tabs.length > 1 ? `${lead} +${node.tabs.length - 1}` : lead
  document.body.appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, 14, 14)
  setTimeout(() => ghost.remove())
}

function zoneAt(r: DOMRect, x: number, y: number): Zone {
  const ex = Math.min(r.width * EDGE.frac, EDGE.max)
  const ey = Math.min(r.height * EDGE.frac, EDGE.max)
  // Each edge scores how far into its zone the pointer is; in a corner the nearer edge wins.
  const scores: [Zone, number][] = [
    ['left', (x - r.left) / ex],
    ['right', (r.right - x) / ex],
    ['top', (y - r.top) / ey],
    ['bottom', (r.bottom - y) / ey]
  ]
  const [side, score] = scores.reduce((a, b) => (b[1] < a[1] ? b : a))
  return score < 1 ? side : 'centre'
}

const ZONE_LABEL: Record<Zone, string> = {
  centre: 'Add as tab',
  left: 'Split left',
  right: 'Split right',
  top: 'Split up',
  bottom: 'Split down'
}

/** What dropping `item` on pane `node` at `zone` would do, or undefined when it would change nothing. */
function dropResult(l: PaneLayout, item: DragItem, node: PaneNode, zone: Zone): PaneLayout | undefined {
  let next: PaneLayout
  if (item.kind === 'pane') next = zone === 'centre' ? mergePane(l, item.id, node.id) : dockPane(l, item.id, node.id, zone)
  else if (zone === 'centre') next = paneOf(l, item.view)?.id === node.id ? l : insertTab(l, node.id, item.view)
  else next = dockTab(l, item.view, node.id, zone)
  return next === l ? undefined : next
}

/**
 * Covers a pane's body while something is dragged, so views (terminals, webviews) can't swallow
 * the drop. The centre adds the dragged tabs to this pane; an edge splits it, and the preview
 * shows the half the dragged pane will take.
 */
function DockTarget({ node, item }: { node: PaneNode; item: DragItem }): ReactNode {
  const [zone, setZone] = useState<Zone>()

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (dragged(e) !== item) return
    const z = zoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)
    if (!dropResult(getState().layout, item, node, z)) return setZone(undefined)
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setZone(z)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const z = zoneAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)
    const next = dropResult(getState().layout, item, node, z)
    setZone(undefined)
    endDrag()
    if (next) setState({ layout: next })
  }

  return (
    <div
      className="drop-target"
      onDragOver={onDragOver}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setZone(undefined)}
      onDrop={onDrop}
    >
      {zone && (
        <div className={`drop-preview ${zone}`}>
          <span>{ZONE_LABEL[zone]}</span>
        </div>
      )}
    </div>
  )
}

function PaneTabs({ node, multi }: { node: PaneNode; multi: boolean }): ReactNode {
  const canSplit = useStore((s) => allPanes(s.layout.root).length < MAX_PANES)
  const terminals = useStore((s) => s.terminals)
  const [dropAt, setDropAt] = useState<number>()
  const stripRef = useRef<HTMLDivElement>(null)
  /** whether the last press landed on bare strip (the pane's grab handle) rather than a tab or button */
  const grabbed = useRef(false)

  const indexAt = (x: number): number => {
    const tabs = [...stripRef.current!.querySelectorAll<HTMLElement>('.ptab')]
    const i = tabs.findIndex((t) => {
      const r = t.getBoundingClientRect()
      return x < r.left + r.width / 2
    })
    return i < 0 ? tabs.length : i
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    const item = dragged(e)
    if (!item || (item.kind === 'pane' && item.id === node.id)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropAt(indexAt(e.clientX))
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    const item = dragged(e)
    setDropAt(undefined)
    if (!item) return
    e.preventDefault()
    endDrag()
    const at = indexAt(e.clientX)
    update((l) => (item.kind === 'tab' ? insertTab(l, node.id, item.view, at) : mergePane(l, item.id, node.id, at)))
  }

  const onDragStart = (e: DragEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return // a tab started its own drag
    if (!grabbed.current) return e.preventDefault()
    paneDragImage(e, node)
    startDrag(e, { kind: 'pane', id: node.id })
  }

  return (
    <div
      className="pane-tabs"
      ref={stripRef}
      draggable={multi}
      onPointerDown={(e) => (grabbed.current = !(e.target as Element).closest('button, .menu'))}
      onDragStart={onDragStart}
      onDragEnd={endDrag}
      onDragOver={onDragOver}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropAt(undefined)}
      onDrop={onDrop}
    >
      {node.tabs.map((v, i) => {
        const term = isTermTab(v)
        const shell = isShellTab(v)
        const { icon: Icon, label } = term
          ? { icon: undefined, label: 'Agent terminal' }
          : shell
            ? { icon: undefined, label: shellTitle(terminals.find((t) => t.termId === shellIdOf(v))) }
            : VIEW_META[v]
        const close = (): void => (shell ? void api.closeTerminal(shellIdOf(v)) : update((l) => closeTab(l, node.id, v)))
        return (
          <button
            key={v}
            className={`ptab${term ? ' term' : ''}${shell ? ' shell' : ''}${v === node.active ? ' on' : ''}${dropAt === i ? ' drop-before' : ''}`}
            draggable
            onDragStart={(e) => startDrag(e, { kind: 'tab', view: v })}
            onDragEnd={endDrag}
            onClick={() => update((l) => activateTab(l, node.id, v))}
            onAuxClick={(e) => e.button === 1 && close()}
            title={`${label} · drag onto another pane, onto a pane's edge to split it${shell ? ', or onto the side panel' : ''}`}
          >
            {term ? (
              <AgentTabLabel termId={termIdOf(v)} />
            ) : shell ? (
              <ShellTabLabel termId={shellIdOf(v)} />
            ) : (
              <>
                {Icon && <Icon size={13} strokeWidth={1.75} />}
                <span className="t">{label}</span>
              </>
            )}
            {shell && (
              <span
                className="x"
                title="Move to the side panel"
                onClick={(e) => {
                  e.stopPropagation()
                  moveShellToSide(shellIdOf(v))
                }}
              >
                <PanelLeft size={12} />
              </span>
            )}
            <span
              className="x"
              title={term ? 'Close tab. The agent keeps running and its terminal goes back to its card.' : shell ? 'Close the shell' : 'Close tab'}
              onClick={(e) => {
                e.stopPropagation()
                close()
              }}
            >
              <X size={12} />
            </span>
          </button>
        )
      })}
      <span className={`ptab-end${dropAt === node.tabs.length && node.tabs.length ? ' drop-before' : ''}`} />
      <AddTab node={node} />
      <div className="pane-tools">
        <button className="btn ghost icon xs" title="Split right" disabled={!canSplit} onClick={() => update((l) => splitPane(l, node.id, 'row'))}>
          <Columns2 size={13} />
        </button>
        <button className="btn ghost icon xs" title="Split down" disabled={!canSplit} onClick={() => update((l) => splitPane(l, node.id, 'col'))}>
          <Rows2 size={13} />
        </button>
        {multi && (
          <button className="btn ghost icon xs" title="Close pane" onClick={() => update((l) => closePane(l, node.id))}>
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  )
}

/** Views that can be opened in a pane: closed ones open, ones elsewhere move over; and a new shell (#111). */
function ViewChoices({ node, onPick }: { node: PaneNode; onPick?: () => void }): ReactNode {
  const layout = useStore((s) => s.layout)
  const views = VIEWS.filter((v) => !node.tabs.includes(v)).map((v) => {
    const { icon: Icon, label } = VIEW_META[v]
    const open = paneOf(layout, v)
    return (
      <button
        key={v}
        className="mi"
        onClick={() => {
          onPick?.()
          update((l) => insertTab(l, node.id, v))
        }}
      >
        <Icon size={14} strokeWidth={1.75} /> {label}
        {open && <small>moves here</small>}
      </button>
    )
  })
  return (
    <>
      {views}
      <button
        className="mi"
        onClick={() => {
          onPick?.()
          void newSideShell(undefined, undefined, node.id)
        }}
      >
        <Terminal size={14} strokeWidth={1.75} /> New shell
      </button>
    </>
  )
}

function AddTab({ node }: { node: PaneNode }): ReactNode {
  const [menu, setMenu] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  return (
    <div className="ptab-add" ref={ref}>
      <button className="btn ghost icon xs" title="Open a view in this pane" onClick={() => setMenu(!menu)}>
        <Plus size={13} />
      </button>
      {menu && (
        <div className="menu pane-menu">
          <ViewChoices node={node} onPick={() => setMenu(false)} />
        </div>
      )}
    </div>
  )
}

function EmptyPane({ node }: { node: PaneNode }): ReactNode {
  return (
    <div className="pane-body pane-empty">
      <div className="pane-pick">
        <div className="section-label">Open a view here</div>
        <div className="menu">
          <ViewChoices node={node} />
        </div>
        <div className="muted">or drag a tab onto this pane</div>
      </div>
    </div>
  )
}
