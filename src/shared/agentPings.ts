// Agent pings (#195): an agent's @mention of another running agent, or of @corvid, delivered like the user's own, behind
// two switches in Settings. Shared by main (which enforces every limit) and the window (which shows and edits them).

export interface AgentPingLimits {
  /** agent pings per rolling hour, all agents together (wake-ups included) */
  perHour: number
  /** the longest chain of pings caused by pings */
  chain: number
  /** wake-ups of finished agents per rolling hour, all agents together */
  wakesPerHour: number
}

export const AGENT_PING_DEFAULTS: AgentPingLimits = { perHour: 20, chain: 3, wakesPerHour: 3 }

/** The ranges Settings and config validation keep the numbers in. */
export const AGENT_PING_RANGES: Record<keyof AgentPingLimits, { min: number; max: number }> = {
  perHour: { min: 1, max: 60 },
  chain: { min: 1, max: 10 },
  wakesPerHour: { min: 1, max: 10 }
}

/** Fixed limits, not settings: one agent, one pair, the gap between one agent's pings, and the text a ping carries. */
export const PING_PER_AGENT_HOUR = 5
export const PING_PER_PAIR_HOUR = 3
export const PING_COOLDOWN_MS = 30_000
export const PING_TEXT_MAX = 1000

/** A number from a saved config or the window, kept in range; anything that isn't a number is the default. */
export function cleanPingLimits(raw: unknown): AgentPingLimits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out = { ...AGENT_PING_DEFAULTS }
  for (const k of Object.keys(AGENT_PING_RANGES) as (keyof AgentPingLimits)[]) {
    const v = r[k]
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(AGENT_PING_RANGES[k].min, Math.min(AGENT_PING_RANGES[k].max, Math.round(v)))
  }
  return out
}

/** The settings that only the user's own click in Corvid's window may change: config:set drops them. */
export const AGENT_PING_KEYS = ['agentPings', 'agentPingWake', 'agentPingLimits'] as const

/** The warning next to the wake switch, and in its confirmation dialog. */
export const WAKE_WARNING = 'Waking a finished agent starts it again and uses your plan. Agents can do this without asking you.'

/** What a running agent is told when pings are off (tool error, Board: line). */
export const PINGS_OFF = 'Agent pings are switched off in Settings; ask the user instead.'

/** The counter in Settings. */
export interface AgentPingStats {
  pings: number
  wakes: number
  perHour: number
  wakesPerHour: number
}

/** On an agent's message: what happened to each agent (or 'assistant') it pinged, for the board's ping and wake tags. */
export type PingMark = 'ping' | 'wake' | 'refused'
export const PING_MARKS: PingMark[] = ['ping', 'wake', 'refused']
