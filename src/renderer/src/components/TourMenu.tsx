// The "?" button at the right end of the title bar (#218): a small menu of every guided tour, built-in and the
// user's, to play again, and "Ask Corvid to explain something…". The list is the Docs list's (useTourEntries), so
// there is one source. It shows whatever "Offer tours" says: that switch only stops tours being offered on their own.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleHelp, MessageCircle } from 'lucide-react'
import { askCorvid } from '../store'
import { playTour } from '../tourPlayer'
import { useTourEntries } from './TourPlayer'

export function TourButton(): ReactNode {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const close = (focusButton: boolean): void => {
    setOpen(false)
    if (focusButton) btn.current?.focus()
  }
  return (
    <>
      <button
        ref={btn}
        className={`btn ghost icon sm${open ? ' on' : ''}`}
        data-tour="titlebar.tours"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Guided tours"
        title="Guided tours"
        onClick={() => setOpen(!open)}
      >
        <CircleHelp size={14} />
      </button>
      {open && <TourMenu anchor={btn.current} onClose={close} />}
    </>
  )
}

function TourMenu({ anchor, onClose }: { anchor: HTMLElement | null; onClose: (focusButton: boolean) => void }): ReactNode {
  const entries = useTourEntries()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ right: 8, top: 40 })

  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect()
    if (r) setPos({ right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 4 })
  }, [anchor])

  // focus the first entry, so Enter on the button and then the arrows work without the mouse
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose(false)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [anchor, onClose])

  const moveFocus = (by: number | 'first' | 'last'): void => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    if (!items.length) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = by === 'first' ? 0 : by === 'last' ? items.length - 1 : (at + by + items.length) % items.length
    items[next].focus()
  }

  return (
    <div
      className="tour-menu"
      ref={ref}
      role="menu"
      aria-label="Guided tours"
      style={pos}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose(true)
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          moveFocus(1)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          moveFocus(-1)
        } else if (e.key === 'Home') {
          e.preventDefault()
          moveFocus('first')
        } else if (e.key === 'End') {
          e.preventDefault()
          moveFocus('last')
        }
      }}
    >
      <div className="tour-menu-head">Guided tours</div>
      <div className="tour-menu-list">
        {entries.map((t) => (
          <button
            key={t.id}
            role="menuitem"
            className="tour-menu-row"
            onClick={() => {
              onClose(false)
              playTour(t.id)
            }}
          >
            <span className="tour-menu-title">
              {t.title}
              {t.yours && <span className="tour-menu-tag">yours</span>}
              {t.done && <Check size={12} className="tour-menu-check" aria-label="finished" />}
            </span>
            <span className="tour-menu-summary">{t.summary}</span>
          </button>
        ))}
      </div>
      <button
        role="menuitem"
        className="tour-menu-row tour-menu-ask"
        onClick={() => {
          onClose(false)
          askCorvid('Explain ')
        }}
      >
        <MessageCircle size={13} /> Ask Corvid to explain something…
      </button>
    </div>
  )
}
