import type { OpClass } from './manifest'

// The rules every connector call goes through (#87), kept free of electron so the tests can run them directly.

export type SafetyLevel = 'free' | 'approve-writes' | 'strict'
export type ConnectorStatus = 'draft' | 'pending' | 'approved' | 'declined'

export interface ConnectorState {
  status: ConnectorStatus
  version: string
  hash: string
  source: 'builtin' | 'user' | 'agent'
  /** switched off by the user (the per-connector kill switch); the approval is kept for when it's back on */
  disabled?: boolean
  /** for agent drafts: which agent and task wrote it */
  draftedBy?: string
  /** for agent drafts (#92): the only project it may be used in, until the user makes it available to all */
  projectId?: string
  /** the version and hash the user approved or declined; a different hash needs a new approval */
  decidedHash?: string
  decidedAt?: number
  decidedBy?: string
}

/**
 * Whether a call may go ahead before looking at the safety level. Approval is tied to the manifest hash, so an
 * edited manifest counts as not approved. The refusal texts are what the agent sees: short, no details.
 */
export function connectorGate(
  state: ConnectorState | undefined,
  currentHash: string,
  killAll: boolean
): { ok: true } | { ok: false; ask: boolean; reason: string } {
  if (killAll) return { ok: false, ask: false, reason: 'All connectors are switched off in Corvid right now. Nothing was run.' }
  if (!state) return { ok: false, ask: false, reason: 'That connector is not available.' }
  if (state.disabled) return { ok: false, ask: false, reason: 'That connector is switched off in Corvid. Nothing was run.' }
  if (state.status === 'draft') return { ok: false, ask: false, reason: 'That connector is still a draft and cannot be used yet.' }
  if (state.decidedHash === currentHash && state.status === 'approved') return { ok: true }
  if (state.decidedHash === currentHash && state.status === 'declined')
    return { ok: false, ask: false, reason: 'The user declined this connector. Nothing was run. Do not try to get around this; ask the user if you need it.' }
  // pending, or approved/declined for an older version or hash: ask on first use
  return { ok: false, ask: true, reason: 'This connector has not been approved by the user. Nothing was run.' }
}

/** Whether one operation of a given class runs straight away or waits for the user, under a connection's level. */
export function needsUser(safety: SafetyLevel, cls: OpClass, adminWithoutAsking = false): boolean {
  if (cls === 'admin') return !(safety === 'free' && adminWithoutAsking)
  if (safety === 'free') return false
  if (safety === 'approve-writes') return cls !== 'read'
  return true
}

export const SAFETY_LEVELS: SafetyLevel[] = ['free', 'approve-writes', 'strict']
export const normalSafety = (s: unknown): SafetyLevel => (SAFETY_LEVELS.includes(s as SafetyLevel) ? (s as SafetyLevel) : 'strict')

// ---------- scrubbing ----------

export const MASK = '[redacted]'

/** A secret and the common ways it gets re-encoded on its way back: base64 (both alphabets), URL encoding, hex, reversed. */
export function secretVariants(v: string): string[] {
  const b = Buffer.from(v, 'utf8')
  const b64 = b.toString('base64')
  const out = [v, b64, b64.replace(/=+$/, ''), b.toString('base64url'), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, '+'), b.toString('hex'), b.toString('hex').toUpperCase(), [...v].reverse().join('')]
  return [...new Set(out)]
}

/** Masks every given secret, and its encodings, in text. Short values would mask ordinary words, so they are skipped. */
export function makeScrubber(secrets: string[]): (text: string) => string {
  const values = [...new Set(secrets.filter((v) => v && v.length >= 3).flatMap(secretVariants))].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length)
  return (text) => {
    let out = String(text ?? '')
    for (const v of values) if (out.includes(v)) out = out.split(v).join(MASK)
    return out
  }
}

/** Scrubs every string inside a JSON-like value. */
export function scrubDeep<T>(value: T, scrub: (s: string) => string): T {
  if (typeof value === 'string') return scrub(value) as T
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), scrubDeep(v, scrub)])) as T
  return value
}
