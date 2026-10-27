import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Cloud, FolderGit2, GitBranch, Tag } from 'lucide-react'
import type { GitGraph, GraphCommit, GraphRef } from '@shared/types'
import { api } from '../api'
import { relTime } from '../format'
import { LANE_W, laneX, layoutGraph, ROW_H, rowY } from '../graphLayout'

/** commits per load; "Load more" adds another page, up to the main process's cap */
const PAGE = 200
const MAX_COMMITS = 2000
/** wider graphs are clipped at the right edge of the lane column */
const MAX_LANES = 8
/** rows drawn above and below the visible window */
const OVERSCAN = 12

const lane = (color: number): string => `var(--lane-${color})`

interface Label {
  key: string
  text: string
  kind: GraphRef['kind']
  current: boolean
  remote: boolean
  worktree?: string
  title: string
}

/** A branch and its remote twin at the same commit share one label, as main + origin/main. */
function labels(c: GraphCommit): Label[] {
  const remotes = c.refs.filter((r) => r.kind === 'remote')
  const used = new Set<GraphRef>()
  const out: Label[] = []
  for (const r of c.refs) {
    if (r.kind === 'remote' || used.has(r)) continue
    if (r.kind === 'head') {
      out.push({ key: 'HEAD', text: 'HEAD', kind: 'head', current: true, remote: false, title: 'HEAD (detached)' })
      continue
    }
    const twin = r.kind === 'branch' ? remotes.find((x) => !used.has(x) && x.name.slice(x.name.indexOf('/') + 1) === r.name) : undefined
    if (twin) used.add(twin)
    const where = r.worktree ? `\nchecked out in worktree ${r.worktree}` : ''
    const title =
      r.kind === 'tag'
        ? `tag ${r.name}`
        : r.kind === 'worktree'
          ? `worktree ${r.worktree} (detached)`
          : `${r.current ? 'HEAD → ' : ''}${r.name}${twin ? ` · ${twin.name}` : ''}${where}`
    out.push({ key: `${r.kind}:${r.name}`, text: r.name, kind: r.kind, current: !!r.current, remote: !!twin, worktree: r.worktree, title })
  }
  for (const r of remotes) {
    if (!used.has(r)) out.push({ key: `remote:${r.name}`, text: r.name, kind: 'remote', current: false, remote: true, title: r.name })
  }
  // Where HEAD is first, then local branches, then remotes, tags and worktrees.
  const rank = (l: Label): number => (l.current ? 0 : l.kind === 'branch' ? 1 : l.kind === 'remote' ? 2 : l.kind === 'tag' ? 3 : 4)
  return out.sort((a, b) => rank(a) - rank(b))
}

function RefChip({ l, color }: { l: Label; color: number }): ReactNode {
  return (
    <span className={`gref${l.current ? ' current' : ''}${l.kind === 'tag' ? ' tag' : ''}`} style={{ ['--lc' as string]: lane(color) }} title={l.title}>
      {l.kind === 'tag' ? <Tag size={10} /> : l.kind === 'worktree' ? <FolderGit2 size={10} /> : l.kind === 'remote' ? <Cloud size={10} /> : l.kind === 'branch' ? <GitBranch size={10} /> : null}
      <span className="n">{l.text}</span>
      {l.kind === 'branch' && l.remote && <Cloud size={10} className="extra" />}
      {l.kind === 'branch' && l.worktree && <FolderGit2 size={10} className="extra" />}
    </span>
  )
}

/**
 * Commits across all branches as lanes and dots, read-only. Rows outside the scrolled window aren't rendered.
 * Give it a key per repo so switching repos starts over.
 */
export function CommitGraph({ repoRoot, refreshKey, now }: { repoRoot: string; refreshKey?: number; now: number }): ReactNode {
  const [limit, setLimit] = useState(PAGE)
  const [graph, setGraph] = useState<GitGraph | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState({ top: 0, height: 480 })
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api.gitGraph(repoRoot, limit).then((graph) => {
      if (cancelled) return
      setGraph(graph)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [repoRoot, limit, refreshKey])

  const layout = useMemo(() => (graph ? layoutGraph(graph.commits) : null), [graph])
  const labelsByRow = useMemo(() => graph?.commits.map(labels) ?? [], [graph])
  const hasRows = !!graph && !graph.error && graph.commits.length > 0

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const update = (): void => setView({ top: el.scrollTop, height: el.clientHeight })
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [hasRows])

  if (!graph || !layout) return <div className="muted">{loading ? 'Reading history…' : ''}</div>
  if (graph.error) return <div className="muted">Couldn't read the history: {graph.error}</div>
  if (!graph.commits.length) return <div className="muted">No commits yet.</div>

  const commits = graph.commits
  const lanes = Math.min(layout.lanes, MAX_LANES)
  const graphW = laneX(lanes - 1) + LANE_W / 2 + 2
  const first = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN)
  const last = Math.min(commits.length, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN)
  const rows: ReactNode[] = []
  const dots: ReactNode[] = []
  for (let i = first; i < last; i++) {
    const c = commits[i]
    const n = layout.nodes[i]
    const ls = labelsByRow[i]
    const shown = ls.slice(0, 3)
    const isHead = c.hash === graph.head
    const x = laneX(n.lane)
    const y = rowY(i)
    if (isHead) dots.push(<circle key={`h${i}`} className="ghead" cx={x} cy={y} r={7} style={{ stroke: lane(n.color) }} />)
    dots.push(
      n.merge ? (
        <circle key={i} className="gmerge" cx={x} cy={y} r={3.5} style={{ stroke: lane(n.color) }} />
      ) : (
        <circle key={i} cx={x} cy={y} r={4} style={{ fill: lane(n.color) }} />
      )
    )
    rows.push(
      <div
        key={c.hash}
        className={`grow${isHead ? ' head' : ''}${n.merge ? ' merge' : ''}`}
        style={{ top: i * ROW_H, height: ROW_H }}
        title={`${c.subject}\n${c.hash}\n${c.author} · ${new Date(c.ts).toLocaleString()}${c.parents.length > 1 ? `\nmerge of ${c.parents.length} parents` : ''}`}
      >
        <span />
        <span className="gmain">
          {shown.map((l) => (
            <RefChip key={l.key} l={l} color={n.color} />
          ))}
          {ls.length > shown.length && (
            <span className="gref more" title={ls.slice(shown.length).map((l) => l.title).join('\n')}>
              +{ls.length - shown.length}
            </span>
          )}
          <span className="subj">{c.subject}</span>
        </span>
        <span className="mono muted ghash">{c.hash.slice(0, 7)}</span>
        <span className="muted gauthor">{c.author}</span>
        <span className="muted num gage">{relTime(c.ts, now)}</span>
      </div>
    )
  }

  const height = commits.length * ROW_H
  return (
    <div className="cgraph">
      <div className="cgraph-scroll" ref={scroller}>
        <div className="cgraph-inner" style={{ height, ['--gw' as string]: `${graphW}px` }}>
          <svg className="cgraph-lines" width={graphW} height={height}>
            {layout.paths.map((d, i) => d && <path key={i} d={d} style={{ stroke: lane(i) }} />)}
            {dots}
          </svg>
          {rows}
        </div>
      </div>
      <div className="cgraph-foot muted">
        <span>
          {commits.length} commit{commits.length === 1 ? '' : 's'}
          {graph.truncated ? ' (newest first)' : ''}
          {layout.lanes > MAX_LANES ? ` · ${layout.lanes} lanes, ${MAX_LANES} shown` : ''}
        </span>
        {graph.truncated && limit < MAX_COMMITS && (
          <button className="btn ghost sm" disabled={loading} onClick={() => setLimit((l) => Math.min(MAX_COMMITS, l + PAGE))}>
            {loading ? 'Loading…' : `Load ${PAGE} more`}
          </button>
        )}
        {graph.truncated && limit >= MAX_COMMITS && <span>Showing the newest {MAX_COMMITS}</span>}
      </div>
    </div>
  )
}
