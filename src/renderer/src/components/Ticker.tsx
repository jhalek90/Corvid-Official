// The live ticker: a slim bar along the bottom of the window with the latest action across every
// session and agent, one at a time. It took over the Live view's activity feed (#64); clicking it
// opens that feed in full. New events wait their turn (one every few seconds, never a scroll), and
// the bar holds still under the pointer and while the window is hidden or unfocused. With reduced
// motion it just shows the newest event, updated in place. Sessions that need the user sit at its
// left in words, in amber.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, Hourglass, X } from 'lucide-react'
import { goTo, itemIcon, lane, useFeed, whatOf, type FeedItem } from '../feed'
import { useStore } from '../store'
import { useInScope } from '../scope'

/** how long each event shows before the next queued one takes its place */
const STEP_MS = 3500
/** after a pause, only the last few queued events play; older ones are in the panel */
const QUEUE = 4

const clock = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function useWindowActive(): boolean {
  const [active, setActive] = useState(() => document.hasFocus() && !document.hidden)
  useEffect(() => {
    const on = (): void => setActive(document.hasFocus() && !document.hidden)
    window.addEventListener('focus', on)
    window.addEventListener('blur', on)
    document.addEventListener('visibilitychange', on)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', on)
      document.removeEventListener('visibilitychange', on)
    }
  }, [])
  return active
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const on = (): void => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

/** With a project chosen in the switcher (#77), that project's actions; Needs you rows stay from every project. */
function useScopedFeed(): FeedItem[] {
  const feed = useFeed()
  const inScope = useInScope()
  return useMemo(() => feed.filter((f) => f.needs || inScope(f.cwd)), [feed, inScope])
}

export function Ticker(): ReactNode {
  const enabled = useStore((s) => s.config?.ticker !== false)
  const feed = useScopedFeed()
  const active = useWindowActive()
  const reduced = useReducedMotion()
  const [hover, setHover] = useState(false)
  const [panel, setPanel] = useState(false)
  const [shown, setShown] = useState<FeedItem | undefined>(() => feed.find((f) => !f.needs))
  const shownAt = useRef(Date.now())
  const paused = hover || !active || panel

  // Needs-you rows are pinned on the left rather than taking a turn, so the rotation is actions only.
  const actions = useMemo(() => feed.filter((f) => !f.needs), [feed])
  const waiting = useMemo(() => feed.filter((f) => f.needs), [feed])

  useEffect(() => {
    const latest = actions[0]
    if (!latest || latest.key === shown?.key) return
    const show = (f: FeedItem): void => {
      shownAt.current = Date.now()
      setShown(f)
    }
    // an empty bar fills even while paused; after that, paused means it holds still
    if (!shown) return show(latest)
    if (paused) return
    if (reduced) return show(latest)
    // the oldest event newer than the one showing, at most QUEUE back
    const at = actions.findIndex((f) => f.key === shown.key)
    const next = actions[Math.min(at < 0 ? QUEUE : at, QUEUE) - 1] ?? latest
    const t = window.setTimeout(() => show(next), Math.max(0, shownAt.current + STEP_MS - Date.now()))
    return () => clearTimeout(t)
  }, [actions, shown, paused, reduced])

  if (!enabled) return null
  const first = waiting[0]
  return (
    <>
      <footer
        className={`ticker${paused ? ' paused' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Live activity. Click for the full feed."
        title="Latest action across sessions and agents. Click for the last 3 hours."
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => setPanel(!panel)}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            setPanel(!panel)
          }
        }}
      >
        {first && (
          <button
            className="tk-needs"
            title={waiting.map((f) => `${f.who}: ${f.needs}`).join('\n')}
            onClick={(e) => {
              e.stopPropagation()
              goTo(first)
            }}
          >
            <Hourglass size={12} />
            <b>Needs you:</b> {first.who}
            {waiting.length > 1 && <span> +{waiting.length - 1}</span>}
          </button>
        )}
        <div className="tk-track">
          {shown ? <TickerItem key={shown.key} f={shown} /> : <span className="tk-quiet">Quiet for the last few hours</span>}
        </div>
        <span className="tk-open">
          <Activity size={12} /> Feed
        </span>
      </footer>
      {panel && <FeedPanel onClose={() => setPanel(false)} />}
    </>
  )
}

function TickerItem({ f }: { f: FeedItem }): ReactNode {
  const Icon = itemIcon(f)
  return (
    <span className={`tk-item${f.e?.kind === 'prompt' ? ' prompt' : ''}`}>
      <span className="tk-time">{clock(f.ts)}</span>
      <span className="tk-who">
        <span className="lane-dot" style={{ background: lane(f.sessionId) }} />
        {f.who}
      </span>
      <Icon size={12} className="tk-ico" />
      <span className="tk-what">
        {whatOf(f)}
        {f.n > 1 && <span className="muted"> ×{f.n}</span>}
      </span>
    </span>
  )
}

/** The whole feed, newest first, with a filter by who. Esc or a click outside closes it. */
function FeedPanel({ onClose }: { onClose: () => void }): ReactNode {
  const feed = useScopedFeed()
  const [who, setWho] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // the ticker toggles the panel itself, so a click on it doesn't count as outside
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element
      if (!ref.current?.contains(t) && !t.closest?.('.ticker')) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  // one entry per session, labelled the way its rows are
  const people = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of feed) if (!m.has(f.sessionId)) m.set(f.sessionId, f.who === f.title ? f.who : `${f.who} · ${f.title}`)
    return [...m.entries()]
  }, [feed])
  const rows = who ? feed.filter((f) => f.sessionId === who) : feed

  return (
    <div className="tk-panel" ref={ref} role="dialog" aria-label="Activity feed">
      <div className="feed-head">
        <h3>Activity</h3>
        <span className="muted">every action across sessions and agents, last 3 hours</span>
        <select className="tk-filter" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Filter by agent or session">
          <option value="">Everyone</option>
          {people.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn ghost icon sm" title="Close (Esc)" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="feed-rows">
        {rows.map((f) => {
          const Icon = itemIcon(f)
          return (
            <div
              key={f.key}
              className={`feed-row ${f.needs ? 'needs' : f.e!.kind}`}
              title={`${f.title}\n${f.termId ? 'Click to open its agent card' : 'Click for its project page'}`}
              onClick={() => {
                onClose()
                goTo(f)
              }}
            >
              <span className="time">{clock(f.ts)}</span>
              <span className="proj">
                <span className="lane-dot" style={{ background: lane(f.sessionId) }} />
                {f.who}
              </span>
              <Icon size={13} className="ico" />
              <span className="lbl">
                {whatOf(f)}
                {f.n > 1 && <span className="muted"> ×{f.n}</span>}
              </span>
            </div>
          )
        })}
        {!rows.length && <div className="muted" style={{ padding: '18px 4px' }}>Quiet for the last few hours.</div>}
      </div>
    </div>
  )
}
