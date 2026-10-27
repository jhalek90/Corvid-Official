// The Context cloud view (#203, redrawn in #205, renamed in #209; the view id stays `lineage` so saved pane
// layouts load): a 3D force-directed node graph of where each agent's context came from
// and what it left behind. The graph comes from one IPC call and is derived in the main process from lineage.jsonl
// plus the notes, board messages and tasks that exist now. The three.js scene lives in ../lineage/scene.ts; this
// file owns the bar, the filter, the hover label, the side panel and, above all, when the frame loop may run: only
// while the canvas is on screen, the document visible and the window focused. Hidden panes have frozen the app
// before, so the loop never runs in the background. While it is open the graph grows live (#210): the log pushes
// new events in batches, new notes and posts come from the store, and both are merged into the picture in place.
// Batches that arrive while the loop is stopped wait in a queue and are applied in one step when it starts again.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RefreshCw, Waypoints, X } from 'lucide-react'
import { agentNodeId, deriveLineage, eventInFilter, noteNodeId, normProject, postNodeId, projectRelationOf, receiptOf, readersOf, taskProjectsOf, type LineageEvent, type LineageGraph, type LineageNode } from '@shared/lineage'
import type { BoardMessage } from '@shared/board'
import type { Note } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { relTime } from '../format'
import { LiveQueue, NODE_CAP, capNodes, mergeIncoming, type EdgeMode } from '../lineage/helpers'
import { LineageScene, hasWebGL } from '../lineage/scene'
import { TourHint } from '../components/TourPlayer'
import '../lineage.css'

type Range = 7 | 30 | 0
const RANGES: { days: Range; label: string }[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 0, label: 'All time' }
]

const when = (ts: number): string => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const k = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

/** A few nodes to drift behind the empty-state text, so the pane is never black. Not data. */
function placeholderGraph(): LineageGraph {
  const now = Date.now()
  const nodes: LineageNode[] = [
    { id: 'agent:corvid', lane: 'agent', type: 'corvid', label: 'Corvid', ts: now },
    { id: 'agent:1:a', lane: 'agent', type: 'worker', label: 'a worker', ts: now - 1e6 },
    { id: 'agent:2:b', lane: 'agent', type: 'worker', label: 'a worker', ts: now - 3e6 },
    { id: 'source:task:1', lane: 'source', type: 'task', label: 'a task', ts: now - 4e6 },
    { id: 'source:rules', lane: 'source', type: 'rules', label: 'rules', ts: now - 5e6 },
    { id: 'note:N1', lane: 'artifact', type: 'note', label: 'a note', ts: now - 2e6, by: 'agent:1:a' },
    { id: 'post:1', lane: 'artifact', type: 'post', label: 'a post', ts: now - 2.5e6, by: 'agent:2:b' },
    { id: 'post:2', lane: 'artifact', type: 'done', label: 'a done post', ts: now - 0.5e6, by: 'agent:1:a' },
    { id: 'note:N2', lane: 'artifact', type: 'note', label: 'your note', ts: now - 6e6 }
  ]
  const edges: LineageGraph['edges'] = [
    { from: 'source:task:1', to: 'agent:1:a', kind: 'started', ts: now },
    { from: 'source:rules', to: 'agent:1:a', kind: 'started', ts: now },
    { from: 'source:rules', to: 'agent:2:b', kind: 'started', ts: now },
    { from: 'agent:1:a', to: 'note:N1', kind: 'wrote', ts: now },
    { from: 'note:N1', to: 'agent:corvid', kind: 'read', ts: now },
    { from: 'agent:2:b', to: 'post:1', kind: 'wrote', ts: now },
    { from: 'post:1', to: 'agent:1:a', kind: 'read', ts: now },
    { from: 'agent:1:a', to: 'post:2', kind: 'wrote', ts: now },
    { from: 'note:N2', to: 'agent:2:b', kind: 'read', ts: now }
  ]
  return { nodes, edges, events: 0 }
}

/** The edge shape (#212) is a look, not data: kept per window in localStorage, Straight unless the user picked Curved. */
const EDGE_MODE_KEY = 'lineage.edges'
const savedEdgeMode = (): EdgeMode => {
  try {
    return localStorage.getItem(EDGE_MODE_KEY) === 'curved' ? 'curved' : 'straight'
  } catch {
    return 'straight'
  }
}

/** The project filter (#213) is remembered the same way: the path as the log spells it, or nothing for all projects. */
const PROJECT_KEY = 'lineage.project'
const savedProject = (): string => {
  try {
    return localStorage.getItem(PROJECT_KEY) ?? ''
  } catch {
    return ''
  }
}

const shortPath = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
/** What the tint means, for the hover tip and the panel: nothing outside a project view or for the project's own. */
const relationText = (n: LineageNode, focus: string | undefined): string => {
  const r = projectRelationOf(n, focus)
  return r === 'foreign' ? ` · other project${n.project ? ` (${shortPath(n.project)})` : ''}` : r === 'shared' ? ' · shared' : ''
}

const reducedMotion = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function LineageView(): ReactNode {
  const tasks = useStore((s) => s.tasks)
  const notes = useStore((s) => s.notes)
  const messages = useStore((s) => s.board.messages)
  const workers = useStore((s) => s.assistant.workers)
  const [days, setDays] = useState<Range>(30)
  const [taskText, setTaskText] = useState('')
  /** what the last load gave, capped; the live graph grows from it */
  const [loaded, setLoaded] = useState<{ graph: LineageGraph; dropped: number }>()
  const [graph, setGraph] = useState<LineageGraph>()
  const [dropped, setDropped] = useState(0)
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [hover, setHover] = useState<{ node: LineageNode; x: number; y: number }>()
  const [tick, setTick] = useState(0)
  const [webgl] = useState(hasWebGL)
  const [edgeMode, setEdgeMode] = useState<EdgeMode>(savedEdgeMode)
  const [project, setProject] = useState<string>(savedProject)
  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<LineageScene>(null)
  const graphRef = useRef<LineageGraph>(undefined)
  const queueRef = useRef(new LiveQueue<LineageEvent>())
  /** the live apply, rebound every render so the scene's start handler and the push listener see fresh state */
  const applyRef = useRef<(events: LineageEvent[], animate: boolean, extra?: { notes: Note[]; messages: BoardMessage[] }) => void>(() => {})
  const taskId = /^\s*#?(\d+)\s*$/.test(taskText) ? Number(taskText.replace(/\D/g, '')) : undefined
  // a task already implies its project, so the project filter (#213) only counts without one
  const focus = taskId === undefined && project ? project : undefined
  const filter = useMemo(() => ({ days, taskId, project: focus }), [days, taskId, focus])
  /** every project the log knows, plus the remembered one so the list always has what is picked */
  const projects = useMemo(() => {
    const out = [...(graph?.projects ?? [])]
    if (project && !out.some((p) => normProject(p) === normProject(project))) out.push(project)
    return out
  }, [graph?.projects, project])

  useEffect(() => {
    let live = true
    api
      .lineageGraph(filter)
      .then((g) => live && (setLoaded(capNodes(g, NODE_CAP)), setError(undefined)))
      .catch((e) => live && setError(String(e?.message ?? e)))
    return () => {
      live = false
    }
  }, [filter, tick])

  const byId = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph])
  const sel = selected ? byId.get(selected) : undefined
  const empty = !!graph && graph.nodes.length === 0

  // the scene: made once per mount, disposed on unmount
  useEffect(() => {
    const host = hostRef.current
    if (!host || !webgl) return
    const scene = new LineageScene(host, {
      reducedMotion: reducedMotion(),
      edgeMode: savedEdgeMode(),
      onHover: (node, x, y) => setHover(node ? { node, x, y } : undefined),
      onClick: (node) => setSelected((cur) => (node && node.id !== cur ? node.id : undefined))
    })
    sceneRef.current = scene
    // debug aid, like __dash in main.tsx: lets a test copy hand the scene a made-up graph to time it
    const dash = (window as unknown as { __dash?: { lineageScene?: LineageScene } }).__dash
    if (dash) dash.lineageScene = scene
    // the frame loop runs only while the canvas is on screen, the document is visible and the window has focus
    let onScreen = false
    const update = (): void => {
      if (onScreen && !document.hidden && document.hasFocus()) {
        scene.start()
        // catch up on what arrived while hidden: all of it in one step, nothing pulses (#210)
        const queued = queueRef.current.take()
        if (queued.length) applyRef.current(queued, false)
      } else scene.stop()
    }
    const io = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting)
      update()
    })
    io.observe(host)
    const ro = new ResizeObserver(() => scene.resize())
    ro.observe(host)
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    update()
    return () => {
      io.disconnect()
      ro.disconnect()
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      scene.dispose()
      sceneRef.current = null
      if (dash?.lineageScene === scene) delete dash.lineageScene
    }
  }, [webgl])

  // a load (or a new filter) replaces the picture; the live graph starts over from it
  useEffect(() => {
    if (!loaded) return
    graphRef.current = loaded.graph
    setGraph(loaded.graph)
    setDropped(loaded.dropped)
    queueRef.current.take()
    const scene = sceneRef.current
    if (scene) {
      // the tint (#213) is set before the bodies are made, so the first frame is already right
      scene.setFocusProject(loaded.graph.nodes.length ? focus : undefined)
      if (loaded.graph.nodes.length) scene.setGraph(loaded.graph, true)
      else scene.setGraph(placeholderGraph(), false)
    }
    setSelected(undefined)
    setHover(undefined)
  }, [loaded])

  // the live apply (#210): derive what the batch adds on top of the graph we have, merge it next to its anchors,
  // and hand the scene only the new part; past the cap the oldest fall off and the scene is told where everything is
  applyRef.current = (events, animate, extra) => {
    const cur = graphRef.current
    const scene = sceneRef.current
    if (!cur || !scene) return
    // the store's notes and posts come along, so a read of one the graph does not show yet (another project's
    // note, #213, or one older than the window) finds the real note instead of leaving a "(deleted)" ghost
    const derived = deriveLineage({ events, notes: extra?.notes ?? notes, messages: extra?.messages ?? messages, tasks }, filter, cur)
    const merge = mergeIncoming(cur, scene.positions(), derived, NODE_CAP)
    if (!merge.added.length && !merge.addedEdges.length) return
    graphRef.current = merge.graph
    setGraph(merge.graph)
    if (merge.dropped) setDropped((d) => d + merge.dropped)
    if (!cur.nodes.length || merge.dropped) {
      // from the placeholder to a real graph, or with nodes gone: the scene takes the whole graph, positions kept
      scene.setGraph(merge.graph, true, merge.pos)
      if (selected && merge.graph.nodes.some((n) => n.id === selected)) scene.select(selected)
      else setSelected(undefined)
    } else scene.append(merge, animate)
  }

  // events pushed from the log: dropped when the filter excludes them, queued while the view is not drawing
  useEffect(
    () =>
      api.onLineageAppended((events) => {
        const scene = sceneRef.current
        const cur = graphRef.current
        if (!scene || !cur) return
        // a worker's project comes from its start or merge in this batch first, then from the task (#213)
        const inBatch = taskProjectsOf(events)
        const kept = events.filter((e) => eventInFilter(e, filter, cur, Date.now(), (id) => inBatch.get(id) ?? tasks.find((t) => t.id === id)?.project))
        const now = queueRef.current.offer(kept, scene.active)
        if (now.length) applyRef.current(now, true)
      }),
    [filter, tasks]
  )

  // the project choice (#213) survives restarts, like the edge shape
  useEffect(() => {
    try {
      if (project) localStorage.setItem(PROJECT_KEY, project)
      else localStorage.removeItem(PROJECT_KEY)
    } catch {
      // storage can be unavailable; the filter still works for this window
    }
  }, [project])

  // notes and posts that appeared since: only the ones the graph has no node for yet
  useEffect(() => {
    const cur = graphRef.current
    const scene = sceneRef.current
    if (!cur || !scene) return
    const has = new Set(cur.nodes.map((n) => n.id))
    const freshNotes = notes.filter((n) => !has.has(noteNodeId(n.id)))
    const freshMessages = messages.filter((m) => !has.has(postNodeId(m.id)))
    if (!freshNotes.length && !freshMessages.length) return
    applyRef.current([], scene.active, { notes: freshNotes, messages: freshMessages })
  }, [notes, messages, graph])

  // running workers breathe, and their started edges stay bright
  useEffect(() => {
    sceneRef.current?.setRunning(new Set(workers.filter((w) => w.state === 'running').map((w) => agentNodeId({ kind: 'agent', agentName: w.agentName, taskId: w.taskId }))))
  }, [workers, graph])

  useEffect(() => {
    sceneRef.current?.select(sel?.id)
  }, [sel])

  // straight or curved edges (#212): a look only, so the scene just redraws its lines; the choice survives restarts
  useEffect(() => {
    sceneRef.current?.setEdgeMode(edgeMode)
    try {
      localStorage.setItem(EDGE_MODE_KEY, edgeMode)
    } catch {
      // storage can be unavailable; the toggle still works for this window
    }
  }, [edgeMode])

  return (
    <div className="lineage" data-tour="context.cloud">
      <div className="lineage-bar">
        <Waypoints size={15} aria-hidden />
        <span className="lineage-title">Context cloud</span>
        <select value={days} onChange={(e) => setDays(Number(e.target.value) as Range)} aria-label="Time range">
          {RANGES.map((r) => (
            <option key={r.days} value={r.days}>
              {r.label}
            </option>
          ))}
        </select>
        <input list="lineage-tasks" value={taskText} onChange={(e) => setTaskText(e.target.value)} placeholder="One task, like 203" aria-label="Only one task" />
        <datalist id="lineage-tasks">
          {tasks.map((t) => (
            <option key={t.id} value={String(t.id)}>{`#${t.id} ${t.title}`}</option>
          ))}
        </datalist>
        {taskText && (
          <button className="btn icon xs" title="All tasks" onClick={() => setTaskText('')}>
            <X size={12} />
          </button>
        )}
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          disabled={taskId !== undefined}
          aria-label="Only one project"
          data-tour="context.project-filter"
          title={taskId !== undefined ? 'A task already picks its project' : project || 'Every project in the log'}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {shortPath(p)}
            </option>
          ))}
        </select>
        <div className="seg xs" role="group" aria-label="Edge shape">
          <button className={edgeMode === 'straight' ? 'on' : ''} title="Edges as straight lines" onClick={() => setEdgeMode('straight')}>
            Straight
          </button>
          <button className={edgeMode === 'curved' ? 'on' : ''} title="Edges as curves, parallel ones fanned apart" onClick={() => setEdgeMode('curved')}>
            Curved
          </button>
        </div>
        <span className="lineage-count">
          {graph ? `${graph.nodes.length} nodes, ${graph.edges.length} edges` : ''}
          {graph?.loggedSince ? ` · logged since ${relTime(graph.loggedSince)}` : ''}
        </span>
        <button className="btn icon xs" title="Refresh" onClick={() => setTick((t) => t + 1)}>
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="lineage-body">
        <div className="lineage-canvas" ref={hostRef}>
          {!webgl && <div className="kempty lineage-empty">This view needs WebGL and the GPU did not give it one. The lineage log and the data behind it are untouched.</div>}
          {error && <div className="kempty lineage-empty">Couldn't load the context cloud: {error}</div>}
          {empty && (
            <div className="kempty lineage-empty">
              {graph.events === 0 ? (
                <>
                  Nothing logged yet. The context cloud starts filling with this version of Corvid: from now on, every worker start records what it was given (the task, its files,
                  CLAUDE.md, the worker rules and the "What Corvid is" page, each with its size), and every note read or written, board read or post, task file read and
                  ping lands here too. Notes and board posts that already exist show as artifacts with their authors as soon as they fall in the time range.
                </>
              ) : taskId !== undefined ? (
                `Nothing for #${taskId}: no agent ran on it since logging began, and no note or post belongs to it.`
              ) : focus ? (
                `Nothing for ${shortPath(focus)} in this range: no worker started or merged there.`
              ) : (
                'Nothing in this range. Pick a longer one, or a task.'
              )}
            </div>
          )}
          {/* #215: one soft offer of the tour about this view, when tours are on */}
          <TourHint id="who-knows-what" text="New to this view? The crow can show you who knows what." />
          {dropped > 0 && <div className="lineage-corner">Showing the newest {NODE_CAP} nodes; {dropped} older ones are left out.</div>}
          {!empty && webgl && (
            <div className="lineage-legend" data-tour="context.legend">
              <span className="lineage-dot source" /> source <span className="lineage-dot agent" /> agent <span className="lineage-dot artifact" /> note, post <span className="lineage-dot user" /> yours
              {focus && (
                <>
                  <span className="lineage-dot foreign" /> other project <span className="lineage-dot shared" /> shared
                </>
              )}
            </div>
          )}
          {hover && !empty && (
            <div className="lineage-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
              <strong>{hover.node.label}</strong>
              <br />
              {hover.node.lane} · {hover.node.type}
              {hover.node.taskId !== undefined ? ` · #${hover.node.taskId}` : ''} · {when(hover.node.ts)}
              {relationText(hover.node, focus)}
            </div>
          )}
        </div>
        {sel && graph && <Panel node={sel} graph={graph} byId={byId} focus={focus} pick={setSelected} close={() => setSelected(undefined)} />}
      </div>
    </div>
  )
}

function Panel({ node, graph, byId, focus, pick, close }: { node: LineageNode; graph: LineageGraph; byId: Map<string, LineageNode>; focus?: string; pick: (id: string) => void; close: () => void }): ReactNode {
  const link = (n: LineageNode): ReactNode => (
    <button className="lineage-link" onClick={() => pick(n.id)}>
      {n.label}
    </button>
  )
  let body: ReactNode
  if (node.lane === 'agent') {
    const lines = receiptOf(graph, node.id)
    const inputs = lines.filter((l) => l.what === 'started with')
    const rest = lines.filter((l) => l.what !== 'started with')
    const total = inputs.reduce((s, l) => s + (l.chars ?? 0), 0)
    body = (
      <>
        <h4>Context receipt</h4>
        {inputs.length ? (
          <table>
            <tbody>
              {inputs.map((l, i) => (
                <tr key={i}>
                  <td>{link(l.node)}</td>
                  <td className="num">{k(l.chars ?? 0)}</td>
                </tr>
              ))}
              <tr className="sum">
                <td>started with, in all</td>
                <td className="num">{k(total)} chars</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="lineage-dim">No start recorded: it ran before the context log began, or it is Corvid, whose context is its own conversation.</p>
        )}
        <h4>Read and wrote</h4>
        {rest.length ? (
          <ol>
            {rest.map((l, i) => (
              <li key={i}>
                <span className="lineage-when">{when(l.ts)}</span> {l.what}
                {l.action ? ` (${l.action})` : ''} {link(l.node)}
              </li>
            ))}
          </ol>
        ) : (
          <p className="lineage-dim">Nothing logged.</p>
        )}
      </>
    )
  } else if (node.lane === 'artifact') {
    const r = readersOf(graph, node.id)
    body = (
      <>
        <p>
          {node.type === 'project' ? 'A merge into the project.' : node.gone ? 'This no longer exists; only the log remembers it.' : node.chars !== undefined ? `${k(node.chars)} characters.` : ''}
        </p>
        <h4>Written by</h4>
        <p>{r.by ? link(r.by) : node.type === 'project' ? 'the agents that merged' : 'the user, or unknown'}</p>
        <h4>Read by</h4>
        {r.readers.length ? (
          <ol>
            {r.readers.map((x, i) => (
              <li key={i}>
                <span className="lineage-when">{when(x.ts)}</span> {link(x.node)}
                {x.action ? ` (${x.action})` : ''}
              </li>
            ))}
          </ol>
        ) : (
          <p className="lineage-dim">No agent read it since logging began.</p>
        )}
      </>
    )
  } else {
    const starts = graph.edges.filter((e) => e.from === node.id).map((e) => ({ n: byId.get(e.to), ts: e.ts, chars: e.chars, kind: e.kind }))
    body = (
      <>
        <h4>Handed to</h4>
        {starts.length ? (
          <ol>
            {starts.map((s, i) => (
              <li key={i}>
                <span className="lineage-when">{when(s.ts)}</span> {s.n && link(s.n)}
                {s.chars !== undefined ? ` (${k(s.chars)} chars)` : s.kind === 'read' ? ' (read)' : ''}
              </li>
            ))}
          </ol>
        ) : (
          <p className="lineage-dim">Nobody in this range.</p>
        )}
      </>
    )
  }
  return (
    <aside className="lineage-panel">
      <div className="lineage-panel-head">
        <span className={`lineage-dot ${node.lane} ${node.type}`} />
        <strong>{node.label}</strong>
        <button className="btn icon xs" title="Close" onClick={close}>
          <X size={12} />
        </button>
      </div>
      <div className="lineage-dim">
        {node.lane} · {node.type} · {when(node.ts)}
        {node.taskId !== undefined ? ` · #${node.taskId}` : ''}
        {relationText(node, focus)}
      </div>
      {body}
    </aside>
  )
}
