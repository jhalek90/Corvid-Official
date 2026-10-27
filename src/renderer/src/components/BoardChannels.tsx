import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Eye, EyeOff, Pin, PinOff, SlidersHorizontal } from 'lucide-react'
import type { BoardMessage, BoardSnapshot } from '@shared/board'
import { ALL_CHANNEL, channelOf, GENERAL_CHANNEL, needsUser, unreadFor } from '@shared/board'
import { readLocal, useStore, writeLocal } from '../store'
import { LearnMore } from '../views/DocsView'
import { taskProject } from '../scope'

// Board channels (#145): a row of filters over the one message board. All shows every message in order, General what
// belongs to no project, and each project with recent messages, open tasks or running agents gets its own. They only
// filter what the board shows: nothing is copied or moved. Pins and hidden channels are kept per window in localStorage.

/** Messages this recent keep a project's channel on the row. */
const RECENT = 7 * 86400_000
const PREFS = 'boardChannels'

export interface Channel {
  key: string
  name: string
  unread: number
  /** something addressed to the user, or a question for them, not read yet */
  needsYou: number
  pinned: boolean
}

interface Prefs {
  pinned: string[]
  hidden: string[]
}

function readPrefs(): Prefs {
  try {
    const p = JSON.parse(readLocal(PREFS) ?? '{}')
    const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
    return { pinned: list(p.pinned), hidden: list(p.hidden) }
  } catch {
    return { pinned: [], hidden: [] }
  }
}

let prefsNow = readPrefs()
const listeners = new Set<() => void>()
function setPrefs(next: Prefs): void {
  prefsNow = next
  writeLocal(PREFS, JSON.stringify(next))
  for (const l of listeners) l()
}
function usePrefs(): Prefs {
  const [p, setP] = useState(prefsNow)
  useEffect(() => {
    const l = (): void => setP(prefsNow)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return p
}

const toggle = (list: string[], key: string): string[] => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key])

/** The channels the row shows, in order: All, General, pinned projects, then the rest by their latest message. */
export function useChannels(board: BoardSnapshot, current: string): { channels: Channel[]; all: { key: string; name: string; pinned: boolean; hidden: boolean }[] } {
  const projects = useStore((s) => s.projects.projects)
  const tasks = useStore((s) => s.tasks)
  const workers = useStore((s) => s.assistant.workers)
  const prefs = usePrefs()
  return useMemo(() => {
    const now = Date.now()
    const latest = new Map<string, number>()
    for (const m of board.messages) if (m.project && now - m.ts < RECENT) latest.set(m.project, Math.max(latest.get(m.project) ?? 0, m.ts))
    const busy = new Set<string>()
    for (const t of tasks) if (t.column !== 'done') busy.add(taskProject(t) ?? '')
    for (const w of workers)
      if (w.state === 'running') {
        const t = tasks.find((x) => x.id === w.taskId)
        busy.add((t && taskProject(t)) ?? '')
      }
    const count = (key: string): { unread: number; needsYou: number } => {
      const unread = unreadFor(board, key)
      return { unread: unread.length, needsYou: unread.filter((m) => needsUser(board, m)).length }
    }
    const named = new Map(projects.filter((p) => !p.archived).map((p) => [p.id, p.name]))
    // a channel can outlive its project (removed or archived) while its messages are on the board
    for (const m of board.messages) if (m.project && !named.has(m.project)) named.set(m.project, projects.find((p) => p.id === m.project)?.name ?? 'Removed project')
    const all = [...named].map(([key, name]) => ({ key, name, pinned: prefs.pinned.includes(key), hidden: prefs.hidden.includes(key) }))
    const shown = all
      .map((c) => ({ ...c, ...count(c.key) }))
      .filter((c) => c.key === current || c.needsYou > 0 || (!c.hidden && (c.pinned || latest.has(c.key) || busy.has(c.key))))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (latest.get(b.key) ?? 0) - (latest.get(a.key) ?? 0) || a.name.localeCompare(b.name))
    return {
      channels: [
        { key: ALL_CHANNEL, name: 'All', pinned: false, ...count(ALL_CHANNEL) },
        { key: GENERAL_CHANNEL, name: 'General', pinned: false, ...count(GENERAL_CHANNEL) },
        ...shown
      ],
      all: all.sort((a, b) => a.name.localeCompare(b.name))
    }
  }, [board, projects, tasks, workers, prefs, current])
}

/** The row of channels above the messages: a strip that scrolls sideways in a narrow pane, never a sidebar. */
export function ChannelBar({ board, channel, onChannel }: { board: BoardSnapshot; channel: string; onChannel: (key: string) => void }): ReactNode {
  const { channels, all } = useChannels(board, channel)
  const [managing, setManaging] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const prefs = usePrefs()

  // keep the chosen channel in view when the row scrolls
  useEffect(() => {
    rowRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [channel])

  // arrow keys move between channels, as in any tab row
  const onKey = (e: KeyboardEvent): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const i = channels.findIndex((c) => c.key === channel)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? channels.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + channels.length) % channels.length
    onChannel(channels[next].key)
    requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
  }

  const tipOf = (c: Channel): string =>
    (c.key === ALL_CHANNEL
      ? 'Every message on the board, in order'
      : c.key === GENERAL_CHANNEL
        ? 'Messages that belong to no project: chat with Corvid, welcome-back and app-wide notices'
        : `Messages about ${c.name}: its agents, its notices, and what you write here. Corvid takes this channel as the project you mean`) +
    (c.unread ? ` · ${c.unread} new` : '') +
    (c.needsYou ? ` · ${c.needsYou} for you` : '')

  return (
    <div className="mb-channels">
      <div className="mb-ch-row" role="tablist" aria-label="Board channels" ref={rowRef} onKeyDown={onKey}>
        {channels.map((c) => (
          <button
            key={c.key}
            role="tab"
            aria-selected={c.key === channel}
            tabIndex={c.key === channel ? 0 : -1}
            className={`mb-ch${c.key === channel ? ' on' : ''}${c.needsYou ? ' you' : ''}`}
            data-tip={tipOf(c)}
            onClick={() => onChannel(c.key)}
          >
            {c.pinned && <Pin size={10} aria-hidden />}
            <span className="mb-ch-name">{c.name}</span>
            {c.needsYou > 0 && <span className="mb-ch-dot" aria-label={`${c.needsYou} for you`} />}
            {c.unread > 0 && <span className="mb-ch-badge">{c.unread > 99 ? '99+' : c.unread}</span>}
          </button>
        ))}
      </div>
      <button
        className={`btn ghost icon xs${managing ? ' on' : ''}`}
        aria-expanded={managing}
        aria-label="Pin or hide channels"
        data-tip="Pin or hide project channels. Hidden ones still show in All, and come back while something there is for you"
        onClick={() => setManaging(!managing)}
      >
        <SlidersHorizontal size={13} />
      </button>
      <LearnMore page="board-and-corvid/channels" label="" />
      {managing && (
        <div className="mb-ch-manage" role="dialog" aria-label="Pin or hide channels" onKeyDown={(e) => e.key === 'Escape' && setManaging(false)}>
          {all.length === 0 && <p className="muted">No projects yet. Channels appear once a project has messages, open tasks or running agents.</p>}
          {all.map((c) => (
            <div key={c.key} className="mb-ch-item">
              <span className={c.hidden ? 'muted' : undefined}>{c.name}</span>
              <button
                className="btn ghost icon xs"
                aria-pressed={c.pinned}
                aria-label={c.pinned ? `Unpin ${c.name}` : `Pin ${c.name}`}
                data-tip={c.pinned ? 'Unpin: it shows only while it has recent activity' : 'Pin: always on the row, first'}
                onClick={() => setPrefs({ pinned: toggle(prefs.pinned, c.key), hidden: prefs.hidden.filter((k) => k !== c.key) })}
              >
                {c.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              </button>
              <button
                className="btn ghost icon xs"
                aria-pressed={c.hidden}
                aria-label={c.hidden ? `Show ${c.name}` : `Hide ${c.name}`}
                data-tip={c.hidden ? 'Show it on the row again' : 'Hide it from the row; its messages stay in All'}
                onClick={() => setPrefs({ hidden: toggle(prefs.hidden, c.key), pinned: prefs.pinned.filter((k) => k !== c.key) })}
              >
                {c.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** In a project channel or General: what's waiting for the user in other channels, so a question is never lost (#145). */
export function ElsewhereForYou({ board, channel, onChannel }: { board: BoardSnapshot; channel: string; onChannel: (key: string) => void }): ReactNode {
  if (channel === ALL_CHANNEL) return null
  const waiting = board.messages.filter((m: BoardMessage) => channelOf(m) !== channel && needsUser(board, m))
  if (!waiting.length) return null
  const only = new Set(waiting.map(channelOf)).size === 1 ? channelOf(waiting[0]) : ALL_CHANNEL
  return (
    <div className="mb-elsewhere" role="status">
      <span>
        <b>{waiting.length}</b> {waiting.length === 1 ? 'message' : 'messages'} for you in other channels
        {waiting.some((m) => m.question) ? ', with a question' : ''}
      </span>
      <button className="btn ghost sm" onClick={() => onChannel(only)}>
        Show
      </button>
    </div>
  )
}
