import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { MIN_MAIN, clampWidth, commit, resetWidth, setWidth, type Pane } from '../layout'

/**
 * Drag handle on one edge of a pane; it resizes its parent element.
 * `guard` is the flexible neighbour that gives up the space, and never drops below `guardMin`.
 * Double-click resets the pane to its default width.
 */
export function Resizer({
  pane,
  edge,
  guard = '.app > .main',
  guardMin = MIN_MAIN
}: {
  pane: Pane
  edge: 'left' | 'right'
  guard?: string
  guardMin?: number
}): ReactNode {
  const drag = useRef<{ x: number; w: number; slack: number }>(undefined)
  const sign = edge === 'right' ? 1 : -1

  const measure = (el: HTMLElement): { w: number; slack: number } => {
    const w = el.parentElement!.getBoundingClientRect().width
    const g = document.querySelector(guard)?.getBoundingClientRect().width
    // Already tight: the pane may shrink but not grow, and never snaps smaller on its own.
    return { w, slack: g === undefined ? Infinity : Math.max(w, w + g - guardMin) }
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, ...measure(e.currentTarget) }
    document.body.classList.add('resizing')
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    setWidth(pane, clampWidth(pane, d.w + sign * (e.clientX - d.x), d.slack))
  }

  const end = (): void => {
    if (!drag.current) return
    drag.current = undefined
    document.body.classList.remove('resizing')
    commit()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 64 : 16
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    const { w, slack } = measure(e.currentTarget)
    setWidth(pane, clampWidth(pane, w + sign * dir * step, slack))
    commit()
  }

  return (
    <div
      className={`resizer ${edge}`}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => resetWidth(pane)}
      onKeyDown={onKeyDown}
    />
  )
}
