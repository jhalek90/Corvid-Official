import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { TerminalInfo } from '@shared/types'
import { termPalette } from '@shared/themes'
import { getState, useStore } from '../store'
import { createXterm, type Xterm } from './TerminalPane'
import { showing } from '../termViewing'

// An agent's terminal has one xterm, made the first time it is shown (in its card or its tab) and kept
// until the terminal is removed. Showing it elsewhere moves its element into the new slot rather than
// making a copy, so the scrollback, the selection and the process's size come along and nothing restarts.
// Off screen (a folded card, a hidden pane, a card scrolled away) the element is detached or unseen, and
// xterm stops drawing; the process keeps its last size until the terminal shows again and settles.
// The general shells (#111) use the same registry, so one moving between the side panel and a pane tab
// keeps its xterm, its scrollback and its process too.

interface Shown extends Xterm {
  host: HTMLDivElement
  /** the slot holding it now; at most one */
  slot?: HTMLElement
  /** a general shell rather than an agent's terminal */
  side: boolean
}

const shown = new Map<string, Shown>()

function claim(term: TerminalInfo, slot: HTMLElement, fontSize: number): void {
  let x = shown.get(term.termId)
  if (!x) {
    const host = document.createElement('div')
    host.className = 'term-host'
    slot.appendChild(host)
    x = { host, side: !!term.side, ...createXterm(host, term, getState().theme, fontSize) }
    shown.set(term.termId, x)
  } else {
    if (x.host.parentNode !== slot) slot.appendChild(x.host)
    x.xt.options.theme = termPalette(getState().theme)
    if (x.xt.options.fontSize !== fontSize) x.xt.options.fontSize = fontSize
  }
  x.slot = slot
  x.refit()
}

/** Lets go of the terminal, unless another slot has taken it since. */
function release(termId: string, slot: HTMLElement): void {
  const x = shown.get(termId)
  if (!x || x.slot !== slot) return
  x.slot = undefined
  x.host.remove()
}

/** Disposes the xterms of terminals that are gone: agents' terminals, or with `side` the general shells. */
export function dropGoneTerminals(alive: Set<string>, side = false): void {
  for (const [id, x] of shown) {
    if (x.side !== side || alive.has(id)) continue
    x.host.remove()
    x.dispose()
    shown.delete(id)
  }
}

/** The terminal that has the keyboard, if any. */
export function focusedTerm(): string | undefined {
  const host = (document.activeElement as HTMLElement | null)?.closest('.term-host')
  if (host) for (const [id, x] of shown) if (x.host === host) return id
  return undefined
}

/** Gives a terminal the keyboard, if it is on screen in a slot. */
export function focusTerm(termId: string): boolean {
  const x = shown.get(termId)
  if (!x?.slot || x.host.offsetParent === null) return false
  x.xt.focus()
  return true
}

/** Whether the user is typing somewhere else (the board's box, a task form), so a terminal mustn't take focus. */
function typingElsewhere(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body || el.closest('.xterm')) return false
  return el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
}

/**
 * Where an agent's terminal shows while this is mounted. `focus` gives it the keyboard when it appears,
 * unless the user is typing elsewhere; an inline terminal never takes focus until it is clicked.
 */
export function TermSlot({ term, fontSize, focus, className }: { term: TerminalInfo; fontSize: number; focus?: boolean; className?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useStore((s) => s.theme)

  useLayoutEffect(() => {
    const slot = ref.current!
    claim(term, slot, fontSize)
    // open in its card or its tab: a finished agent shown here is never closed (#70)
    showing(term.termId, true)
    const take = (): void => {
      const x = shown.get(term.termId)
      if (x?.slot === slot && !typingElsewhere()) x.xt.focus()
    }
    if (focus && !typingElsewhere()) requestAnimationFrame(take)
    // a new terminal stays unseen (and unfocusable) until it has redrawn, so try again once it shows, unless the
    // keyboard went somewhere meanwhile
    const again = focus ? setTimeout(() => (!document.activeElement || document.activeElement === document.body) && take(), 400) : undefined
    return () => {
      clearTimeout(again)
      showing(term.termId, false)
      release(term.termId, slot)
    }
  }, [term.termId, fontSize])

  useEffect(() => {
    const x = shown.get(term.termId)
    if (x) x.xt.options.theme = termPalette(theme)
  }, [theme, term.termId])

  return <div className={`term-slot${className ? ` ${className}` : ''}`} ref={ref} />
}
