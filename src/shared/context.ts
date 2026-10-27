import type { SessionSummary } from './types'

/** Past this, every turn re-sends enough context that it dominates the session's cost. */
export const CONTEXT_WARN = 150_000
/** Always-on context above this is worth trimming: CLAUDE.md, memory, MCP servers. */
export const BASE_WARN = 40_000

export const contextHigh = (s: Pick<SessionSummary, 'context'>): boolean => s.context >= CONTEXT_WARN
export const baseHigh = (s: Pick<SessionSummary, 'baseContext'>): boolean => s.baseContext >= BASE_WARN

export const CONTEXT_TIP = 'Every turn re-sends all of it. Run /compact, or start a fresh session with a short handoff note.'
export const BASE_TIP = 'Loaded before you type anything. Trim CLAUDE.md, memory files, or unused MCP servers.'
