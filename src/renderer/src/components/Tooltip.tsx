import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'

/**
 * Corvid's one tooltip (#128). Any element with a data-tip, or a plain title attribute, gets it: it shows
 * quickly on hover and on keyboard focus, wraps long text, stays inside the window and looks the same in every
 * theme. A title is lifted off its element while the tip shows, so the native one doesn't double it, and put back
 * after. The titles of the elements around it are lifted too, or the native tip would show the nearest of them
 * instead, like the agent card's under its ctx tag (#239): the innermost tip wins and is the only one. An empty
 * title (or data-tip) keeps an outer element's tip from showing, as the native one does. Disabled controls still
 * get mouse events in this Chromium, so their tips show too. It is the only tooltip: don't add a CSS ::after one
 * beside it (#236). Tips show below their element, or beside it inside a data-tip-side="right".
 */

const SHOW_MS = 300
/** moving from one tip to the next within this shows the next one at once */
const WARM_MS = 600
const GAP = 6
const EDGE = 8

interface Shown {
  el: HTMLElement
  text: string
}

/** The element whose tip applies at this target, or null: the nearest data-tip or title, if it isn't empty. */
function tipAnchor(target: EventTarget | null): HTMLElement | null {
  for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
    if (el.hasAttribute('data-tip')) return el.getAttribute('data-tip') ? (el as HTMLElement) : null
    if (el.hasAttribute('title')) return el.getAttribute('title') ? (el as HTMLElement) : null
  }
  return null
}

/** Takes the title off (keeping it as the accessible name or description meanwhile) and returns the text. */
function lift(el: HTMLElement): string {
  const tip = el.getAttribute('data-tip')
  if (tip) return tip
  const title = el.getAttribute('title') ?? ''
  el.removeAttribute('title')
  el.dataset.tipTitle = title
  if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !el.textContent?.trim()) {
    el.setAttribute('aria-label', title)
    el.dataset.tipAria = 'label'
  } else if (!el.hasAttribute('aria-description')) {
    el.setAttribute('aria-description', title)
    el.dataset.tipAria = 'description'
  }
  return title
}

/** The elements around this one with a title, which the native tip would fall back to once its own is lifted. */
function titledAround(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (p.getAttribute('title')) out.push(p)
  return out
}

/** Puts a lifted title back, unless the page set a new one meanwhile. */
function restore(el: HTMLElement): void {
  const title = el.dataset.tipTitle
  if (title === undefined) return
  if (!el.hasAttribute('title')) el.setAttribute('title', title)
  if (el.dataset.tipAria) el.removeAttribute(`aria-${el.dataset.tipAria}`)
  delete el.dataset.tipTitle
  delete el.dataset.tipAria
}

export function TooltipLayer(): ReactNode {
  const [shown, setShown] = useState<Shown | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let current: HTMLElement | null = null
    // the titles around current, lifted while its tip shows
    let around: HTMLElement[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let hiddenAt = 0
    let watch: MutationObserver | undefined
    // focus by Tab or arrows shows the tip; focus from a click doesn't (the pointer already shows it)
    let keyboard = false

    const hide = (): void => {
      clearTimeout(timer)
      watch?.disconnect()
      if (current) {
        restore(current)
        around.forEach(restore)
        hiddenAt = Date.now()
      }
      around = []
      current = null
      setShown(null)
    }
    const show = (el: HTMLElement): void => {
      if (current === el) return
      hide()
      current = el
      setShown({ el, text: lift(el) })
      around = titledAround(el)
      around.forEach(lift)
      // a title the page changes meanwhile updates the tip, and is lifted again; one around it is only lifted again
      watch = new MutationObserver((changes) => {
        if (current !== el) return
        for (const p of around) {
          if (p.getAttribute('title') && changes.some((c) => c.target === p)) {
            delete p.dataset.tipTitle
            lift(p)
          }
        }
        if (!changes.some((c) => c.target === el)) return
        if (el.getAttribute('title')) {
          delete el.dataset.tipTitle
          setShown({ el, text: lift(el) })
        } else if (el.hasAttribute('data-tip')) {
          const t = el.getAttribute('data-tip')
          if (t) setShown({ el, text: t })
          else hide()
        }
      })
      watch.observe(el, { attributes: true, attributeFilter: ['title', 'data-tip'] })
      for (const p of around) watch.observe(p, { attributes: true, attributeFilter: ['title'] })
    }
    const later = (el: HTMLElement): void => {
      clearTimeout(timer)
      if (Date.now() - hiddenAt < WARM_MS || current) show(el)
      else timer = setTimeout(() => el.isConnected && show(el), SHOW_MS)
    }

    const over = (e: MouseEvent): void => {
      const el = tipAnchor(e.target)
      if (el === current) return clearTimeout(timer)
      if (!el) return hide()
      later(el)
    }
    const out = (e: MouseEvent): void => {
      // leaving the window altogether
      if (!e.relatedTarget) hide()
    }
    const focus = (e: FocusEvent): void => {
      const t = e.target
      if (!(t instanceof HTMLElement) || !(keyboard || t.matches(':focus-visible'))) return
      const el = t.hasAttribute('data-tip') || t.hasAttribute('title') ? tipAnchor(t) : null
      if (el) show(el)
      else if (current) hide()
    }
    const blur = (e: FocusEvent): void => {
      if (e.target === current) hide()
    }
    const down = (e: PointerEvent): void => {
      keyboard = false
      // clicking an info icon shows its tip right away; any other click puts the tip away
      const el = tipAnchor(e.target)
      if (el?.classList.contains('info-tip')) show(el)
      else hide()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' || e.key.startsWith('Arrow')) keyboard = true
      if (e.key === 'Escape' && current) hide()
    }
    // scrolling puts a hover tip away, but a focused element's tip follows it (Tab scrolls it into view)
    const scroll = (): void => {
      if (current && current === document.activeElement) setShown((s) => s && { ...s })
      else hide()
    }
    // a tip whose element went away (a re-render, a closed dialog) goes with it
    const gone = setInterval(() => current && !current.isConnected && hide(), 400)

    document.addEventListener('mouseover', over, true)
    document.addEventListener('mouseout', out, true)
    document.addEventListener('focusin', focus, true)
    document.addEventListener('focusout', blur, true)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key, true)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    return () => {
      hide()
      clearInterval(gone)
      document.removeEventListener('mouseover', over, true)
      document.removeEventListener('mouseout', out, true)
      document.removeEventListener('focusin', focus, true)
      document.removeEventListener('focusout', blur, true)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
    }
  }, [])

  // below the element, or above it when there's no room, and never past the window's edges. Inside a
  // data-tip-side="right" (the rail) it goes beside the element instead, so it doesn't cover its neighbours.
  useLayoutEffect(() => {
    const tip = ref.current
    if (!shown || !tip) return
    const a = shown.el.getBoundingClientRect()
    const w = tip.offsetWidth
    const h = tip.offsetHeight
    let top: number
    let left: number
    if (shown.el.closest('[data-tip-side="right"]')) {
      top = a.top + a.height / 2 - h / 2
      left = a.right + GAP
      if (left + w > innerWidth - EDGE && a.left - GAP - w >= EDGE) left = a.left - GAP - w
    } else {
      top = a.bottom + GAP
      if (top + h > innerHeight - EDGE && a.top - GAP - h >= EDGE) top = a.top - GAP - h
      left = a.left + a.width / 2 - w / 2
    }
    top = Math.max(EDGE, Math.min(top, innerHeight - h - EDGE))
    left = Math.max(EDGE, Math.min(left, innerWidth - w - EDGE))
    tip.style.top = `${Math.round(top)}px`
    tip.style.left = `${Math.round(left)}px`
    tip.style.visibility = 'visible'
  }, [shown])

  if (!shown) return null
  return (
    <div ref={ref} className="tooltip" role="tooltip" style={{ visibility: 'hidden' }}>
      {shown.text}
    </div>
  )
}

/** A small info icon whose tip holds a setting's or control's longer explanation; focusable, so it works by keyboard. */
export function InfoTip({ tip, label }: { tip: string; label?: string }): ReactNode {
  return (
    <button type="button" className="info-tip" data-tip={tip} aria-label={label ? `About ${label}` : 'More info'} aria-description={tip}>
      <Info size={12} aria-hidden />
    </button>
  )
}

/** A Settings row's label: the short name, with its explanation in a tip on the name and on an info icon beside it. */
export function SettingLabel({ label, tip, children }: { label: ReactNode; tip?: string; children?: ReactNode }): ReactNode {
  return (
    <div className="setting-label">
      <div className="setting-name">
        <span data-tip={tip}>{label}</span>
        {tip && <InfoTip tip={tip} label={typeof label === 'string' ? label : undefined} />}
      </div>
      {children}
    </div>
  )
}
