// Corvid's own cost estimate for work that spends the user's Claude usage (#97): building an extension (#98), the
import { apiPrice, modelFamily } from './models'
// packaging wizard's sessions (#100), a verify build (#101) and the scan's classifier (#96). Pure and synchronous: the
// main process gathers the inputs (the header, the user's history on this PC, the quota) and calls estimate(). The
// author's numbers are shown next to it, never used as the estimate. Nothing here is ever sent anywhere.

import type { Effort } from './extensions'

// ---------- the defaults, in one place ----------

/** Output tokens for one build of each effort class with no history on this PC: a typical size of seed prompt
 *  (TYPICAL_SEED_CHARS), 4 acceptance checks, tier 2. Rough, from Claude Code worker sessions; history replaces them. */
export const EFFORT_DEFAULTS: Record<Effort, { tokens: number; minutes: number }> = {
  small: { tokens: 40_000, minutes: 15 },
  medium: { tokens: 120_000, minutes: 35 },
  large: { tokens: 300_000, minutes: 75 }
}
/** The seed prompt size the defaults are for; a longer prompt costs more, by its square root. */
export const TYPICAL_SEED_CHARS = 1500
export const TYPICAL_CHECKS = 4
/** Extra review for core and protected core. */
export const TIER_FACTOR: Record<1 | 2 | 3, number> = { 1: 0.85, 2: 1, 3: 1.35 }
/**
 * Fable (#127), conservatively: a token counts as much as its list price says against Opus's (twice, per models.ts), so
 * never less than Opus. Fable's own token counts come from the user's Fable history once there are FABLE_MIN_HISTORY
 * finished pieces of Fable work; until then the estimate uses all history, a wider range and says "low" confidence.
 */
function fableWeight(): number {
  return Math.max(1, apiPrice('fable')[1] / apiPrice('opus')[1])
}
export const FABLE_MIN_HISTORY = 3
/** The spread for Fable with no Fable history: wider than PRIOR_SPREAD. */
export const FABLE_PRIOR_SPREAD = 3
/** How much of the plan's windows a token of each model takes, relative to Opus. A rough guide only. */
export const MODEL_WEIGHT: Record<string, number> = { opus: 1, fable: fableWeight(), sonnet: 0.6, haiku: 0.25 }
/** Output tokens that fill a whole 5-hour window and a whole week at model weight 1. A rough guide for the share only;
 *  tune these if the shares look wrong for your plan. */
export const WINDOW_TOKENS = { fiveHour: 1_500_000, week: 15_000_000 }
/** The spread with no history: low = likely / 2.2, high = likely × 2.2. */
export const PRIOR_SPREAD = 2.2
/** History older than this counts half as much; much older counts for little. */
export const HALF_LIFE_DAYS = 30
/** A build of an extension counts this many times more than a task session: it's the same kind of work. */
export const BUILD_WEIGHT = 2
/** Task request sizes (title + notes, characters) for grouping task sessions by size. */
export const SIZE_CLASS = { mediumFrom: 700, largeFrom: 2500 }
/** The scan's classifier (#96): one short, fixed-size run. */
export const SCAN_COST = { tokens: 6_000, minutes: 2 }
/** The soft cap: this multiple of the likely estimate, the user's setting. */
export const CAP_MULTIPLE = { min: 1.5, max: 5, default: 2 }
export const ESTIMATE_LABEL = 'Estimate, excluding retries and failed builds'

export const cleanCapMultiple = (n: unknown): number => {
  const v = typeof n === 'number' ? n : NaN
  return Number.isFinite(v) ? Math.max(CAP_MULTIPLE.min, Math.min(CAP_MULTIPLE.max, Math.round(v * 2) / 2)) : CAP_MULTIPLE.default
}

// ---------- inputs and output ----------

/** One piece of the user's history: a finished task's session, or a build of an extension. */
export interface HistoryRecord {
  kind: 'task' | 'build'
  at: number
  /** a build's effort class; a task's comes from its request size */
  effort?: Effort
  /** the seed prompt (build) or the task's title and notes (task), in characters */
  sizeChars: number
  checks?: number
  tier?: 1 | 2 | 3
  outputTokens: number
  minutes?: number
  model?: string
  /** a build's own estimate at the time, for "estimates have been off by" */
  estimatedLikely?: number
  /** failed and cancelled builds stay in the ledger but never feed an estimate */
  outcome?: 'ok' | 'failed' | 'cancelled'
}

export interface EstimateInput {
  /** what the header declares */
  effort: Effort
  /** the author's observations from the header: shown beside the estimate, never used for it */
  observed?: { minutes?: number; files?: number; model?: string; checks?: number; cost?: Effort; tokens?: number }
  /** from the classifier (#96), when it has run: 0 (simple) to 1 (complex), and its own effort class */
  complexity?: number
  inferredEffort?: Effort
  seedChars: number
  checks: number
  tier: 1 | 2 | 3
  /** the model the build will use */
  model: string
  history: HistoryRecord[]
  /** current usage, 0-100, when known */
  quota?: { fiveHour?: number; week?: number } | null
  now?: number
}

export interface Range {
  low: number
  likely: number
  high: number
}

export interface CostEstimate {
  label: string
  model: string
  /** output tokens */
  tokens: Range
  minutes: Range
  /** percentage points of each window this would take, and where usage would be afterwards (when it's known) */
  share: { fiveHour: Range & { now?: number }; week: Range & { now?: number } }
  confidence: 'low' | 'medium' | 'high'
  /** how many similar records calibrated it */
  samples: number
  /** in words, what it's based on */
  basis: string
  /** the effort class it used: the classifier's when it ran, else the declared one */
  effort: Effort
  author: { tokens?: number; minutes?: number; cost?: Effort; model?: string }
  /** set when Corvid's estimate and the author's claim are far apart */
  mismatch?: string
}

// ---------- the engine ----------

const EFFORTS: Effort[] = ['small', 'medium', 'large']
const bigger = (a: Effort, b: Effort): Effort => (EFFORTS.indexOf(a) >= EFFORTS.indexOf(b) ? a : b)

export const modelWeight = (model: string): number => {
  const m = model.toLowerCase()
  const k = Object.keys(MODEL_WEIGHT).find((x) => m.includes(x))
  return k ? MODEL_WEIGHT[k] : 1
}

export const sizeClass = (chars: number): Effort => (chars >= SIZE_CLASS.largeFrom ? 'large' : chars >= SIZE_CLASS.mediumFrom ? 'medium' : 'small')

/** What the defaults alone say for one piece of work (no history): the base the history ratios are taken against. */
export function baseTokens(p: { effort: Effort; sizeChars: number; checks?: number; tier?: 1 | 2 | 3; complexity?: number }): number {
  const size = Math.sqrt(Math.max(0.3, Math.min(4, (p.sizeChars || TYPICAL_SEED_CHARS) / TYPICAL_SEED_CHARS)))
  const checks = 1 + 0.04 * Math.max(-3, Math.min(20, (p.checks ?? TYPICAL_CHECKS) - TYPICAL_CHECKS))
  const complexity = p.complexity === undefined ? 1 : 0.75 + 0.5 * Math.max(0, Math.min(1, p.complexity))
  return EFFORT_DEFAULTS[p.effort].tokens * size * checks * TIER_FACTOR[p.tier ?? 2] * complexity
}

const recordEffort = (r: HistoryRecord): Effort => r.effort ?? sizeClass(r.sizeChars)
const usable = (r: HistoryRecord): boolean => r.outcome !== 'failed' && r.outcome !== 'cancelled' && r.outputTokens > 0
const weightOf = (r: HistoryRecord, now: number): number =>
  (r.kind === 'build' ? BUILD_WEIGHT : 1) * Math.pow(0.5, Math.max(0, now - r.at) / (HALF_LIFE_DAYS * 86400_000))

/** A weighted mean and spread of log ratios (actual ÷ what the defaults would have said). */
function calibrate(records: HistoryRecord[], now: number, value: (r: HistoryRecord) => number | undefined, base: (r: HistoryRecord) => number) {
  const pts = records
    .map((r) => ({ v: value(r), b: base(r), w: weightOf(r, now) }))
    .filter((p): p is { v: number; b: number; w: number } => !!p.v && p.v > 0 && p.b > 0)
  const wsum = pts.reduce((a, p) => a + p.w, 0)
  if (!pts.length || wsum <= 0) return null
  const mean = pts.reduce((a, p) => a + p.w * Math.log(p.v / p.b), 0) / wsum
  const variance = pts.reduce((a, p) => a + p.w * (Math.log(p.v / p.b) - mean) ** 2, 0) / wsum
  return { ratio: Math.exp(mean), sigma: Math.sqrt(variance), n: pts.length }
}

const round = (n: number, to: number): number => Math.max(to, Math.round(n / to) * to)

export function estimate(input: EstimateInput): CostEstimate {
  const now = input.now ?? Date.now()
  const effort = input.inferredEffort ? bigger(input.inferredEffort, input.effort) : input.effort
  const base = baseTokens({ effort, sizeChars: input.seedChars, checks: input.checks, tier: input.tier, complexity: input.complexity })
  const baseMin = EFFORT_DEFAULTS[effort].minutes * (base / EFFORT_DEFAULTS[effort].tokens)

  // Fable (#127): its own history when there's enough of it, else all of it, with a wider range and low confidence
  const fable = modelFamily(input.model) === 'fable'
  const fableOk = fable ? input.history.filter((r) => usable(r) && !!r.model && modelFamily(r.model) === 'fable') : []
  const fableGuess = fable && fableOk.length < FABLE_MIN_HISTORY
  // similar work: the same effort class first, and all of it when there's too little of that
  const ok = fable && !fableGuess ? fableOk : input.history.filter(usable)
  const same = ok.filter((r) => recordEffort(r) === effort)
  const pool = same.length >= 3 ? same : ok
  const baseOf = (r: HistoryRecord): number => baseTokens({ effort: recordEffort(r), sizeChars: r.sizeChars, checks: r.checks, tier: r.tier })
  const tok = calibrate(pool, now, (r) => r.outputTokens, baseOf)
  const min = calibrate(pool, now, (r) => r.minutes, (r) => EFFORT_DEFAULTS[recordEffort(r)].minutes * (baseOf(r) / EFFORT_DEFAULTS[recordEffort(r)].tokens))

  // with n records the history's spread counts n/(n+3); the rest is the wide prior, and other-class history counts less
  const n = tok?.n ?? 0
  const trust = (n / (n + 3)) * (pool === same ? 1 : 0.6)
  const priorSigma = Math.log(PRIOR_SPREAD)
  const sigma = Math.max(fableGuess ? Math.log(FABLE_PRIOR_SPREAD) : 0.25, trust * Math.max(tok?.sigma ?? priorSigma, 0.2) + (1 - trust) * priorSigma)
  const spread = Math.exp(sigma)
  const likely = base * (tok ? Math.pow(tok.ratio, trust) : 1)
  const likelyMin = baseMin * (min ? Math.pow(min.ratio, trust) : 1)
  const tokens = { low: round(likely / spread, 1000), likely: round(likely, 1000), high: round(likely * spread, 1000) }
  const minutes = { low: round(likelyMin / spread, 1), likely: round(likelyMin, 1), high: round(likelyMin * spread, 1) }

  const weight = modelWeight(input.model)
  const share = (whole: number, now?: number): Range & { now?: number } => ({
    low: (tokens.low * weight * 100) / whole,
    likely: (tokens.likely * weight * 100) / whole,
    high: (tokens.high * weight * 100) / whole,
    ...(now === undefined ? {} : { now })
  })

  const confidence: CostEstimate['confidence'] = fableGuess ? 'low' : n >= 8 && pool === same && sigma < 0.5 ? 'high' : n >= 3 ? 'medium' : 'low'
  const basis =
    (!n
      ? `Corvid's defaults for ${effort} work (no similar work on this PC yet)`
      : `${n} ${pool === same ? `similar ${effort}` : 'earlier'} ${fable && !fableGuess ? 'Fable ' : ''}piece${n === 1 ? '' : 's'} of work on this PC${pool === same ? '' : ` (too few ${effort} ones to use only those)`}, recent ones counting more`) +
    (fable ? fableNote(fableGuess) : '')

  const o = input.observed ?? {}
  const author = { tokens: o.tokens, minutes: o.minutes, cost: o.cost, model: o.model }
  const est: CostEstimate = {
    label: ESTIMATE_LABEL,
    model: input.model,
    tokens,
    minutes,
    share: { fiveHour: share(WINDOW_TOKENS.fiveHour, input.quota?.fiveHour), week: share(WINDOW_TOKENS.week, input.quota?.week) },
    confidence,
    samples: n,
    basis,
    effort,
    author
  }
  est.mismatch = mismatch(est, o)
  return est
}

/** "Corvid's estimate is 3.1× the author's": when the author's claim is more than twice off either way. */
export function mismatch(est: CostEstimate, o: EstimateInput['observed'] = {}): string | undefined {
  const theirs = o?.tokens ?? (o?.cost ? EFFORT_DEFAULTS[o.cost].tokens : undefined)
  const what = o?.tokens ? `${o.tokens.toLocaleString('en-US')} tokens` : o?.cost ? `${o.cost} cost` : undefined
  if (theirs && what) {
    const r = est.tokens.likely / theirs
    if (r > 2) return `Corvid's estimate is about ${r.toFixed(1)}× what the author reports (${what}). The author's number may come from another model or Corvid version, or be wrong.`
    if (r < 0.5) return `Corvid's estimate is well below what the author reports (${what}); the author's build may have needed retries.`
  }
  if (o?.minutes) {
    const r = est.minutes.likely / o.minutes
    if (r > 2) return `Corvid expects about ${r.toFixed(1)}× the author's ${o.minutes} minutes.`
  }
  return undefined
}

/** What the basis says about Fable (#127): how its tokens count, and that there's no Fable history to go on yet. */
const fableNote = (guess: boolean): string =>
  `. On Fable a token counts ${MODEL_WEIGHT.fable}× an Opus one${guess ? '; with too little Fable work on this PC yet, the range is wide and confidence is low' : ''}`

/** The scan's classifier run (#96): small and fixed, through the same display. */
export function scanEstimate(model: string, quota?: EstimateInput['quota']): CostEstimate {
  const w = modelWeight(model)
  const t = { low: SCAN_COST.tokens / 2, likely: SCAN_COST.tokens, high: SCAN_COST.tokens * 2 }
  const share = (whole: number, now?: number) => ({
    low: (t.low * w * 100) / whole,
    likely: (t.likely * w * 100) / whole,
    high: (t.high * w * 100) / whole,
    ...(now === undefined ? {} : { now })
  })
  return {
    label: 'Estimate for the scan (a small, fixed cost)',
    model,
    tokens: t,
    minutes: { low: 1, likely: SCAN_COST.minutes, high: SCAN_COST.minutes * 2 },
    share: { fiveHour: share(WINDOW_TOKENS.fiveHour, quota?.fiveHour), week: share(WINDOW_TOKENS.week, quota?.week) },
    confidence: modelFamily(model) === 'fable' ? 'low' : 'medium',
    samples: 0,
    basis: `a fixed cost for one classifier run${modelFamily(model) === 'fable' ? fableNote(true) : ''}`,
    effort: 'small',
    author: {}
  }
}

/** "Estimates have been off by about 35%": the mean error of recent finished builds, once there are at least 3. */
export function estimateAccuracy(history: HistoryRecord[], atLeast = 3): { offBy: number; n: number } | null {
  const b = history
    .filter((r) => r.kind === 'build' && usable(r) && r.estimatedLikely && r.estimatedLikely > 0)
    .sort((x, y) => y.at - x.at)
    .slice(0, 10)
  if (b.length < atLeast) return null
  const offBy = b.reduce((a, r) => a + Math.abs(r.outputTokens - r.estimatedLikely!) / r.estimatedLikely!, 0) / b.length
  return { offBy: Math.round(offBy * 100), n: b.length }
}

// ---------- the soft cap ----------

/** The budget cap for one run: asks at cap × likely, and each Continue moves the next ask one estimate further on. */
export interface CapState {
  likely: number
  multiple: number
  /** the output tokens the next ask is at */
  askAt: number
  continued: number
  hit: boolean
}

export const newCap = (likely: number, multiple: number): CapState => ({
  likely,
  multiple: cleanCapMultiple(multiple),
  askAt: Math.round(likely * cleanCapMultiple(multiple)),
  continued: 0,
  hit: false
})

/** Whether usage so far has passed the cap (time to ask). */
export const overCap = (c: CapState, used: number): boolean => used >= c.askAt

/** The user chose Continue: one more estimate before the next ask. */
export const raiseCap = (c: CapState, used: number): CapState => ({
  ...c,
  askAt: Math.max(c.askAt, used) + c.likely,
  continued: c.continued + 1,
  hit: true
})

// ---------- words ----------

export const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))
export const fmtPct = (n: number): string => (n < 1 ? '<1%' : `${Math.round(n)}%`)
