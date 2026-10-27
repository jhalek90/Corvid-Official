import { useLayoutEffect, useRef, type RefObject } from 'react'

// Following the bottom of a growing list, the way a chat does (#123): it stays on the newest item while the user
// hasn't scrolled up, and keeps their reading place when they have. Only the user's own scrolling (wheel, touch,
// keys, the scrollbar, a click or drag inside) switches between the two. A scroll the layout causes never does:
// a resize, a narrower width that rewraps the text, or a pane moved to another slot (the view's host is re-parented,
// which starts the list at the top) only puts the list back where it belongs. The state lives outside the
// component, by key, so a remount or a hidden view comes back where it was.

/** Closer to the bottom than this counts as at the bottom. */
const NEAR_BOTTOM = 48
/** A scroll this soon after the user's wheel, touch, key or pointer counts as theirs; each of theirs extends it,
 *  so a smooth scroll keeps counting. */
const INTENT_MS = 300

interface Place {
  follow: boolean
  /** while not following: the item at the top of the view (its element id) and its distance below the top edge */
  anchor?: { id: string; offset: number }
}
const places = new Map<string, Place>()

export interface StickToBottom {
  /** the list follows the newest item */
  following: () => boolean
  /** follow again, at the newest item */
  toBottom: () => void
  /** put the list where it belongs now: the bottom while following, else the saved reading place */
  settle: () => void
}

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '])
const editable = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

const gap = (el: HTMLElement): number => el.scrollHeight - el.scrollTop - el.clientHeight

/** The first item (a child with an id) not wholly above the top edge, found by halving: the children are in order. */
function anchorOf(el: HTMLElement): Place['anchor'] {
  const items = [...el.children].filter((c) => c.id)
  const top = el.getBoundingClientRect().top
  let lo = 0
  let hi = items.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].getBoundingClientRect().bottom > top + 1) {
      found = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  if (found < 0) return undefined
  return { id: items[found].id, offset: items[found].getBoundingClientRect().top - top }
}

/**
 * Keeps the scroll element `ref` on its newest (last) item, or on the user's reading place once they scroll up.
 * `key` names the list for as long as the app runs. `onFollow` hears when following turns on or off.
 * Items to anchor to are the element's children with an id.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, key: string, onFollow?: (following: boolean) => void): StickToBottom {
  const cb = useRef(onFollow)
  cb.current = onFollow
  const self = useRef<StickToBottom>(undefined)
  if (!self.current) {
    if (!places.has(key)) places.set(key, { follow: true })
    const place = places.get(key)!
    self.current = {
      following: () => place.follow,
      toBottom: () => {
        place.anchor = undefined
        if (!place.follow) {
          place.follow = true
          cb.current?.(true)
        }
        const el = ref.current
        if (el) el.scrollTop = el.scrollHeight
      },
      settle: () => {
        const el = ref.current
        // hidden or detached: nothing to measure, and its scroll position means nothing yet
        if (!el || !el.clientHeight) return
        if (place.follow) {
          if (gap(el) > 1) el.scrollTop = el.scrollHeight
          return
        }
        const a = place.anchor
        const item = a && [...el.children].find((c) => c.id === a.id)
        if (!a || !item) return
        const off = item.getBoundingClientRect().top - el.getBoundingClientRect().top
        if (Math.abs(off - a.offset) >= 1) el.scrollTop += off - a.offset
      }
    }
  }
  const api = self.current

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = places.get(key)!
    let userAt = -Infinity
    let held = false
    const user = (): void => {
      userAt = performance.now()
    }
    const onScroll = (): void => {
      if (!el.clientHeight) return
      const now = performance.now()
      if (held || now - userAt < INTENT_MS) {
        // the user's own scroll: follow when they're at the bottom, else remember what they're reading
        userAt = now
        const bottom = gap(el) < NEAR_BOTTOM
        place.anchor = bottom ? undefined : anchorOf(el)
        if (bottom !== place.follow) {
          place.follow = bottom
          cb.current?.(bottom)
        }
      } else api.settle() // the layout moved it: back to the bottom, or to the reading place
    }
    const onDown = (): void => {
      held = true
      user()
    }
    const onUp = (): void => {
      if (!held) return
      held = false
      user()
    }
    // Enter on a button inside, such as a quote that scrolls to the message it answers
    const onKey = (e: KeyboardEvent): void => {
      if ((SCROLL_KEYS.has(e.key) && !editable(e.target)) || (e.key === 'Enter' && el.contains(e.target as Node))) user()
    }

    // After a size change (the element's, or an item's as it rewraps or grows), settle now, before the paint, and
    // again over the next two frames in case the layout keeps moving. One pending pass at a time, so it can't loop.
    let raf = 0
    const settleSoon = (): void => {
      api.settle()
      if (raf) return
      let n = 2
      const again = (): void => {
        api.settle()
        raf = --n > 0 ? requestAnimationFrame(again) : 0
      }
      raf = requestAnimationFrame(again)
    }
    const ro = new ResizeObserver(settleSoon)
    ro.observe(el)
    for (const c of el.children) ro.observe(c)
    // items come and go with the list
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (n instanceof Element) ro.observe(n)
        for (const n of r.removedNodes) if (n instanceof Element) ro.unobserve(n)
      }
    })
    mo.observe(el, { childList: true })

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', user, { passive: true })
    el.addEventListener('touchstart', user, { passive: true })
    el.addEventListener('touchmove', user, { passive: true })
    el.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey)
    api.settle()
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', user)
      el.removeEventListener('touchstart', user)
      el.removeEventListener('touchmove', user)
      el.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [ref, key, api])

  return api
}
