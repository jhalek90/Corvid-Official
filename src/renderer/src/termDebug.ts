// Debug-only counters for terminal sizing (#79): fits, sizes sent to the process and xterm render bursts.
// Off unless localStorage 'corvid.termDebug' is '1'; then window.__termStats holds the counts, and
// window.__termStats.reset() clears them between measured steps.

interface TermStats {
  fits: number
  fitChanged: number
  sent: number
  renders: number
  log: string[]
  reset: () => void
}

function make(): TermStats | null {
  try {
    if (localStorage.getItem('corvid.termDebug') !== '1') return null
  } catch {
    return null
  }
  const s: TermStats = {
    fits: 0,
    fitChanged: 0,
    sent: 0,
    renders: 0,
    log: [],
    reset: () => {
      s.fits = s.fitChanged = s.sent = s.renders = 0
      s.log = []
    }
  }
  ;(window as unknown as { __termStats: TermStats }).__termStats = s
  return s
}

const stats = make()

export function countTerm(kind: 'fits' | 'fitChanged' | 'sent' | 'renders', what?: string): void {
  if (!stats) return
  stats[kind]++
  if (what) stats.log.push(`${Math.round(performance.now())} ${kind} ${what}`)
}
