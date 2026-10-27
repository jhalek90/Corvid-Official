// How many agents (workers) may run at once. The one place for these numbers: the main process
// enforces them, Settings shows them, and the assistant is told them.

/** Never more workers than this at once, whatever Settings or a hand-edited config.json says, so a typo
 *  or a bug can't start dozens of Claude sessions. */
export const HARD_MAX_WORKERS = 12
/** What a new install starts with, and what Settings suggests. Above it, Settings warns more strongly. */
export const SUGGESTED_WORKERS = 4
/** Going above this asks for a one-time confirmation in Settings. */
export const CONFIRM_WORKERS_ABOVE = 8

/** A saved or typed limit as a whole number from 1 to the ceiling. Anything that isn't a number gets the suggestion. */
export function clampWorkers(n: unknown): number {
  const v = typeof n === 'number' || (typeof n === 'string' && n.trim() !== '') ? Math.round(Number(n)) : NaN
  return Number.isFinite(v) ? Math.max(1, Math.min(HARD_MAX_WORKERS, v)) : SUGGESTED_WORKERS
}

/** A worker's time limit, in minutes of work (sleep and waiting for the user don't count, #81). */
export const WORKER_MINUTES = { min: 5, max: 240, default: 45 }

/** A saved time limit as a whole number in range. Anything that isn't a number gets the default. */
export function cleanWorkerMinutes(n: unknown): number {
  const v = typeof n === 'number' ? Math.round(n) : NaN
  return Number.isFinite(v) ? Math.max(WORKER_MINUTES.min, Math.min(WORKER_MINUTES.max, v)) : WORKER_MINUTES.default
}

// ---------- the usage limit for new agents (#93) ----------

/** The usage-limit part of WorkerLimits: a master switch, each gate with its own switch, and what happens above it. */
export interface UsageLimit {
  usageLimit: boolean
  gate5h: number
  gate5hOn: boolean
  gateWeek: number
  gateWeekOn: boolean
  overLimit: 'ask' | 'block'
}

/** Which gates this usage is at or above. Off gates (or the whole limit off) are never over; unknown usage counts as 0. */
export function overGates(l: UsageLimit, five?: number, week?: number): { five: boolean; week: boolean } {
  return {
    five: l.usageLimit && l.gate5hOn && (five ?? 0) >= l.gate5h,
    week: l.usageLimit && l.gateWeekOn && (week ?? 0) >= l.gateWeek
  }
}

/** Fable's own weekly limit (#127) against the weekly gate: only for work that runs on Fable. */
export const overFableGate = (l: UsageLimit, fable?: number): boolean => l.usageLimit && l.gateWeekOn && fable !== undefined && fable >= l.gateWeek

/** "70%", or "no limit" for a gate that's off. */
export const gateLabel = (l: UsageLimit, which: '5h' | 'week'): string =>
  !l.usageLimit || !(which === '5h' ? l.gate5hOn : l.gateWeekOn) ? 'no limit' : `${which === '5h' ? l.gate5h : l.gateWeek}%`

/** What Corvid's instructions say about the usage limit, matching Settings. */
export function usageLimitLine(l: UsageLimit): string {
  if (!l.usageLimit || (!l.gate5hOn && !l.gateWeekOn)) return 'no usage limit for new workers (the user turned it off in Settings)'
  const gates = [l.gate5hOn && `5-hour usage reaches ${l.gate5h}%`, l.gateWeekOn && `weekly usage reaches ${l.gateWeek}%`].filter(Boolean).join(' or ')
  return l.overLimit === 'block'
    ? `no new workers once ${gates}`
    : `once ${gates}, a new worker starts only after the user confirms it in a dialog in Corvid's window (start_worker then tells you they were asked; you can't answer or skip that dialog, and must not call start_worker again for it)`
}
