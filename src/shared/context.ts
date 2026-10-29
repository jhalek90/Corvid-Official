import type { SessionSummary } from './types'
import { findCustomModel, isCustomModelRef, type CustomModel } from './customModels'

/** Past this, every turn re-sends enough context that it dominates the session's cost. */
export const CONTEXT_WARN = 150_000
/** Always-on context above this is worth trimming: CLAUDE.md, memory, MCP servers. */
export const BASE_WARN = 40_000

export const contextHigh = (s: Pick<SessionSummary, 'context'>): boolean => s.context >= CONTEXT_WARN
export const baseHigh = (s: Pick<SessionSummary, 'baseContext'>): boolean => s.baseContext >= BASE_WARN

export const CONTEXT_TIP = 'Every turn re-sends all of it. Run /compact, or start a fresh session with a short handoff note.'
export const BASE_TIP = 'Loaded before you type anything. Trim CLAUDE.md, memory files, or unused MCP servers.'

// ---------- Corvid's own context ring (#326) ----------

/** The window of the Claude models Corvid runs on. */
export const CORVID_WINDOW = 1_000_000
/** The ring turns amber, then red, past these shares of the window. */
export const RING_AMBER = 0.6
export const RING_RED = 0.85

/** The context window a session works against: a custom model's entry, else the Claude models' 1M. Corvid's own ring
 *  and the agent cards' (#327) both use it. */
export function corvidWindow(model: unknown, models: readonly CustomModel[] | undefined): number {
  return (isCustomModelRef(model) && findCustomModel(models, model)?.contextTokens) || CORVID_WINDOW
}

export interface RingUse {
  tokens: number
  window: number
  /** 0-1, at most 1 */
  share: number
  level: 'calm' | 'amber' | 'red'
  /** compacted, the size is unknown until the next reply */
  compacted: boolean
}

/** `tokens` is the session summary's `context` (the latest reply's input + cache read + cache write; 0 just after a compact). */
export function ringUse(tokens: number, window: number): RingUse {
  const share = window > 0 ? Math.min(1, Math.max(0, tokens / window)) : 0
  return { tokens, window, share, level: share >= RING_RED ? 'red' : share >= RING_AMBER ? 'amber' : 'calm', compacted: tokens <= 0 }
}

/** 214000 -> "214k", 1000000 -> "1M", 32768 -> "33k" */
export const ringTokens = (n: number): string => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))

/** "86k of 1M, 9%", the exact numbers in an agent card's context chip (#327). */
export const ringShort = (u: RingUse): string => `${ringTokens(u.tokens)} of ${ringTokens(u.window)}, ${Math.round(u.share * 100)}%`

export function ringTitle(u: RingUse): string {
  if (u.compacted) return `Corvid's context was just compacted; its size shows after Corvid's next reply. The window is ${ringTokens(u.window)}.`
  return `Corvid's context: ${ringTokens(u.tokens)} of ${ringTokens(u.window)} (${Math.round(u.share * 100)}%). Claude Code compacts on its own near the end.`
}
