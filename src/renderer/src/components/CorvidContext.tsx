import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Eraser, FoldVertical, NotebookPen } from 'lucide-react'
import { corvidWindow, ringTitle, ringUse, type RingUse } from '@shared/context'
import { api } from '../api'
import { toast, useStore } from '../store'
import { corvidBusy } from './Assistant'

// Corvid's context ring in the strip at the top of the board (#326): how full Corvid's own context is, from its
// transcript like an agent card's ctx tag, with Compact and Clear. Both go through the board box's own path, as if the
// user had typed /compact or /clear in this channel, so they behave (and leave the same notices) as the commands do.

const R = 7
const LEN = 2 * Math.PI * R

const HANDOFF =
  "@corvid I'm about to clear your context. Before that, please write a short handoff note for your next conversation: what we were doing, decisions made, open threads and what's waiting on me. Keep it brief."

const failed = (e: unknown): void => toast(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')

/** As if typed in the board box in `channel`: a command runs the same way and leaves the same notice. */
const send = (text: string, channel: string): Promise<unknown> => api.boardPost(text, undefined, { channel }).catch(failed)

/** The ring itself, also on the agent cards' context chip (#327): the share filled, coloured by level. */
export function MiniRing({ share, level, size = 16 }: { share: number; level: RingUse['level']; size?: number }): ReactNode {
  return (
    <svg className={`ctx-ring ${level}`} viewBox="0 0 18 18" width={size} height={size} aria-hidden="true">
      <circle className="track" cx="9" cy="9" r={R} />
      <circle className="fill" cx="9" cy="9" r={R} strokeDasharray={`${share * LEN} ${LEN}`} transform="rotate(-90 9 9)" />
    </svg>
  )
}

export function ContextRing({ channel }: { channel: string }): ReactNode {
  const a = useStore((s) => s.assistant)
  const config = useStore((s) => s.config)
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  // the handoff message (its board id) whose turn has to end before the clear; `seen` once Corvid took it up
  const [handoff, setHandoff] = useState<{ id: number; seen: boolean; channel: string } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const busy = corvidBusy(a)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  // clear once Corvid has answered the handoff message: answered asks drop out of boardAsks
  useEffect(() => {
    if (!handoff) return
    const ask = a.boardAsks.find((x) => x.id === handoff.id)
    if (ask?.status === 'failed') {
      setHandoff(null)
      toast("Corvid couldn't write the handoff note, so its context wasn't cleared.", 'error')
    } else if (ask && !handoff.seen) setHandoff({ ...handoff, seen: true })
    else if (!ask && handoff.seen && !busy) {
      setHandoff(null)
      void send('/clear', handoff.channel)
    }
  }, [a.boardAsks, busy, handoff])

  if (a.context === undefined || !config) return null
  const u = ringUse(a.context, corvidWindow(config.assistantModel, config.models))
  const title = handoff ? 'Clearing Corvid’s context after it writes the handoff note.' : ringTitle(u)

  const clear = (note: boolean): void => {
    setConfirm(false)
    if (!note) return void send('/clear', channel)
    void api
      .boardPost(HANDOFF, undefined, { channel })
      .then((m) => setHandoff({ id: m.id, seen: false, channel }))
      .catch(failed)
  }

  return (
    <div className="cv-ctx" ref={ref}>
      <button className={`cv-ring${handoff ? ' pending' : ''}`} title={title} aria-label={title} onClick={() => setMenu(!menu)}>
        <MiniRing share={u.share} level={u.level} />
      </button>
      {menu && (
        <div className="menu cv-ctx-menu" role="menu">
          <div className="mh section-label">{u.compacted ? 'Just compacted' : `${Math.round(u.share * 100)}% of Corvid's context`}</div>
          <button
            className="mi"
            disabled={busy || !!handoff}
            title={busy ? 'Corvid is in the middle of a turn. Compact once it has answered.' : 'The same as typing /compact: Corvid summarises the conversation so far and carries on from the summary.'}
            onClick={() => {
              setMenu(false)
              void send('/compact', channel)
            }}
          >
            <FoldVertical size={14} /> Compact
          </button>
          {handoff ? (
            <button className="mi" onClick={() => (setMenu(false), setHandoff(null))} title="Keeps Corvid's context; the handoff note request stays on the board.">
              <Eraser size={14} /> Don't clear after the note
            </button>
          ) : (
            <button
              className="mi"
              title="The same as typing /clear: Corvid forgets this conversation. Board messages stay."
              onClick={() => {
                setMenu(false)
                setConfirm(true)
              }}
            >
              <Eraser size={14} /> Clear…
            </button>
          )}
        </div>
      )}
      {confirm && <ClearConfirm onClose={() => setConfirm(false)} onClear={clear} />}
    </div>
  )
}

function ClearConfirm({ onClose, onClear }: { onClose: () => void; onClear: (note: boolean) => void }): ReactNode {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-label="Clear Corvid's memory" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <Eraser size={17} /> Clear Corvid's memory?
        </h3>
        <p>Clear Corvid's memory of this conversation? Board messages stay. Corvid starts fresh with your next message.</p>
        <div className="actions">
          {/* it can't be undone, so Cancel is the default */}
          <button className="btn" autoFocus onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => onClear(true)} title="Corvid writes a short handoff note first, as a note; the clear follows once that turn ends.">
            <NotebookPen size={14} /> Write a handoff note first
          </button>
          <button className="btn primary" onClick={() => onClear(false)}>
            Clear
          </button>
        </div>
      </div>
    </div>
  )
}
