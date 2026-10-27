// The small looping touches outside the birds' engine: a working agent's badge bobbing its head, the
// assistant's avatar blinking and tilting while it waits. Any animation that is running keeps the
// whole window redrawing at 60 fps, even through the long still stretches of a loop, and on Windows
// each of those frames costs the GPU process far more than the few pixels that change (#135). So
// the quiet ones are one-off runs that a shared timer starts now and then, nothing ticks between
// them, and the timer and every loop that's left stop while the window is hidden or unfocused,
// the same as the birds (crow.ts). With reduced motion nothing is started at all.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')

/** The window is showing and in use; while it isn't, <html> carries data-motion="paused" and crow.css pauses every loop. */
export const windowActive = (): boolean => document.visibilityState === 'visible' && document.hasFocus()

const sync = (): void => {
  const on = windowActive()
  if (on) delete document.documentElement.dataset.motion
  else document.documentElement.dataset.motion = 'paused'
}
document.addEventListener('visibilitychange', sync)
window.addEventListener('focus', sync)
window.addEventListener('blur', sync)
sync()

/** Adds `cls` to `el` for one run of its CSS animation, then takes it off again. */
export function playOnce(el: Element, cls: string): void {
  if (reduceMotion.matches || !el.isConnected || el.classList.contains(cls)) return
  el.classList.add(cls)
  const done = (): void => {
    el.classList.remove(cls)
    el.removeEventListener('animationend', done)
  }
  el.addEventListener('animationend', done)
  // a run that never starts (display: none, or the element left the page) doesn't leave the class stuck
  setTimeout(done, 3000)
}

// A working agent's badge (CrowBadge moving): one head bob about every 2.8 s, as the old endless
// loop did, each badge at its own moment so a row of cards doesn't nod in step.
const BOB_EVERY = 2800
window.setInterval(() => {
  if (!windowActive() || reduceMotion.matches) return
  for (const el of document.querySelectorAll('.crow-badge.moving')) {
    const at = Number((el as HTMLElement).dataset.bobAt ?? (((el as HTMLElement).dataset.bobAt = String(Math.floor(Math.random() * BOB_EVERY)))))
    setTimeout(() => playOnce(el, 'bob'), at)
  }
}, BOB_EVERY)
