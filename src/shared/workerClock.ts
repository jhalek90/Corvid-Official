// A worker's time limit counts minutes of work, not wall time (#81): the time the PC sleeps and the
// time an agent waits on the user (a permission prompt, an approval, a question it ended its turn on)
// don't count. Pure functions so main enforces it, the renderer shows it, and a test can drive it.

/** The clock as a worker carries it: minutes banked so far, plus the running stretch if it's counting. */
export interface WorkClock {
  /** work counted before the current stretch, in ms */
  workedMs: number
  /** when the current counting stretch began (epoch ms); unset while paused */
  clockFrom?: number
}

/** Why a clock isn't counting right now. */
export type ClockPause = 'sleep' | 'you'

/** Ticks this far apart mean the app was frozen (sleep without a suspend event): the gap isn't counted. */
export const MAX_TICK_GAP = 60_000

export const workedMs = (c: WorkClock, now: number): number => c.workedMs + (c.clockFrom !== undefined ? Math.max(0, now - c.clockFrom) : 0)

/** Bank the running stretch up to `at` and stop counting. */
export function pauseClock(c: WorkClock, at: number): void {
  if (c.clockFrom === undefined) return
  c.workedMs += Math.max(0, at - c.clockFrom)
  c.clockFrom = undefined
}

export function runClock(c: WorkClock, at: number): void {
  if (c.clockFrom === undefined) c.clockFrom = at
}

/**
 * One tick for one clock: `lastTick` is the previous tick. After a gap longer than MAX_TICK_GAP only the
 * time up to the previous tick is banked, so a sleep the app never heard about isn't counted either.
 * Returns true when the clock started or stopped counting.
 */
export function tickClock(c: WorkClock, now: number, lastTick: number, waitingForYou: boolean): boolean {
  const was = c.clockFrom !== undefined
  if (was && now - lastTick > MAX_TICK_GAP) {
    pauseClock(c, lastTick)
    if (!waitingForYou) runClock(c, now)
    return false
  }
  if (waitingForYou) pauseClock(c, now)
  else runClock(c, now)
  return was !== (c.clockFrom !== undefined)
}

const mins = (ms: number): number => Math.floor(ms / 60_000)

/** For a tooltip: worked time against the limit, the wall time beside it, and why it's paused. */
export function clockTip(w: WorkClock & { startedAt: number; endedAt?: number; paused?: ClockPause }, now: number, limitMin: number): string {
  const end = w.endedAt ?? now
  const worked = mins(workedMs(w, end))
  const wall = mins(end - w.startedAt)
  const paused = w.endedAt === undefined && w.paused ? (w.paused === 'sleep' ? ' Paused while the computer sleeps.' : ' Paused while it waits for you.') : ''
  return `Worked ${worked} of ${limitMin} minutes${wall > worked ? ` (${wall} since it started)` : ''}; sleep and waiting for you don't count.${paused}`
}

/** "12 of 45 minutes worked, 33 left", for the agent's own tools. */
export function clockLine(c: WorkClock, now: number, limitMin: number): string {
  const worked = workedMs(c, now)
  const done = mins(worked)
  const left = Math.max(0, Math.ceil((limitMin * 60_000 - worked) / 60_000))
  return `${done} of ${limitMin} minutes worked, ${left} left`
}
