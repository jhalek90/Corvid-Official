import type { TokenTotals } from './types'
import { effortArgs } from './reasoningEffort'

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'

export function modelFamily(model: string): ModelFamily {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  return 'other'
}

/** "claude-opus-5-5[1m]" -> "Opus 5.5" */
export function modelLabel(model: string): string {
  const fam = modelFamily(model)
  if (fam === 'other') return model
  const ver = model
    .replace(/\[.*?\]/g, '')
    .replace(/-\d{8}$/, '')
    .split(`${fam}-`)[1]
  const name = fam[0].toUpperCase() + fam.slice(1)
  return ver ? `${name} ${ver.replace(/-/g, '.')}` : name
}

// API list prices per million tokens (input, output). Subscription traffic isn't billed
// per token, so anything computed from this is an "API-equivalent" estimate only.
const PRICES: Record<ModelFamily, [number, number]> = {
  opus: [5, 25],
  sonnet: [3, 15],
  haiku: [1, 5],
  fable: [10, 50],
  other: [3, 15]
}

/** The [input, output] list price per million tokens of a family. */
export const apiPrice = (fam: ModelFamily): [number, number] => PRICES[fam]

export function estimateCost(model: string, t: TokenTotals): number {
  const [inp, out] = PRICES[modelFamily(model)]
  return (
    (t.input * inp + t.output * out + t.cacheRead * inp * 0.1 + t.cacheWrite * inp * 1.25) / 1e6
  )
}

export const emptyTokens = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

export function addTokens(a: TokenTotals, b: TokenTotals): void {
  a.input += b.input
  a.output += b.output
  a.cacheRead += b.cacheRead
  a.cacheWrite += b.cacheWrite
}

export const totalTokens = (t: TokenTotals): number => t.input + t.output + t.cacheRead + t.cacheWrite

// ---------- the models a user can pick (#127) ----------

/** The models offered by every selector (Corvid's model, the worker model, the scan model), cheapest first. */
export const MODEL_CHOICES = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type ModelChoice = (typeof MODEL_CHOICES)[number]
export const isModelChoice = (m: unknown): m is ModelChoice => typeof m === 'string' && (MODEL_CHOICES as readonly string[]).includes(m)

/** The current Fable model. The CLI also takes the alias `fable` (checked on CLI 2.1.307: it runs this id). */
export const FABLE_ID = 'claude-fable-5-1'

/** What --model gets for a choice. Every choice is a CLI alias for that family's latest model ("fable" -> FABLE_ID). */
export const cliModel = (m: ModelChoice): string => m

/**
 * The model and effort part of a claude command line, for Corvid and for workers: '--model' unless the model is
 * 'default', then '--effort' unless the effort is 'default' (#238). 'default' passes nothing, so Claude Code decides.
 */
export const launchArgs = (model: string, effort: unknown): string[] => [
  ...(isModelChoice(model) ? ['--model', cliModel(model)] : []),
  ...effortArgs(effort)
]

/** "Haiku", "Sonnet", "Opus", "Fable 5.1": the name a selector, notice or tooltip shows for a choice. */
export const choiceLabel = (m: string): string => (m === 'fable' ? modelLabel(FABLE_ID) : m ? m[0].toUpperCase() + m.slice(1) : m)

/** The warning in the confirmation shown whenever the user switches something to Fable, and the selectors' hint. */
export const FABLE_WARNING = 'Fable can use up your usage quickly and cost a lot more than the other models.'
/** Shown next to the Fable entry when the usage output has no Fable weekly limit. */
export const FABLE_MAYBE_UNAVAILABLE = 'may not be available on your plan'

/** The usage output's separate Fable weekly limit, when the account has one. */
export function fableWeek<T extends { label: string }>(weeks: T[] | undefined): T | undefined {
  return weeks?.find((w) => /fable/i.test(w.label))
}
/** The all-models weekly limit: the one without a model in its label. */
export function allModelsWeek<T extends { label: string }>(weeks: T[] | undefined): T | undefined {
  return weeks?.find((w) => /all models/i.test(w.label)) ?? weeks?.[0]
}

/** Any model name for display: a choice ("fable" -> "Fable 5.1"), a full id ("claude-opus-5-5" -> "Opus 5.5"), else as is. */
export const displayModel = (m: string): string => (isModelChoice(m) ? choiceLabel(m) : modelFamily(m) !== 'other' ? modelLabel(m) : m)

// ---------- the model tag on an agent's card (#234) ----------

const FAMILY_NAME: Record<Exclude<ModelFamily, 'other'>, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' }
const known = (m: string | undefined): Exclude<ModelFamily, 'other'> | undefined => {
  const fam = m ? modelFamily(m) : 'other'
  return fam === 'other' ? undefined : fam
}
/** The model a session's replies used most, from the counts the indexer already keeps. */
const mostUsed = (seen: Record<string, number> | undefined): string | undefined =>
  Object.entries(seen ?? {}).sort((a, b) => b[1] - a[1]).find(([m]) => known(m))?.[0]

/**
 * The short model tag an agent's card shows: "Opus", "Sonnet", "Haiku" or "Fable", with the family for its accent.
 * `model` is the worker's model (the task's own model already beat Settings when it started), or undefined for a
 * session Corvid didn't start. A worker on 'default' shows the Claude Code default when it's known, then the model its
 * session replied with, else just "Default". A session without a worker shows the model it replied with, or nothing.
 */
export function cardModel(
  model: string | undefined,
  claudeDefault?: string,
  seen?: Record<string, number>
): { label: string; family: ModelFamily } | undefined {
  if (!model) {
    const fam = known(mostUsed(seen))
    return fam && { label: FAMILY_NAME[fam], family: fam }
  }
  const fam = model === 'default' ? (known(claudeDefault) ?? known(mostUsed(seen))) : known(model)
  if (fam) return { label: FAMILY_NAME[fam], family: fam }
  return { label: model === 'default' ? 'Default' : model, family: 'other' }
}

// ---------- a task's own model (#136) ----------

/** The model a worker on this task runs on: the task's own model when it has one, else the worker model from Settings. */
export const taskModel = <M extends string>(task: { model?: string } | undefined, settings: M): ModelChoice | M =>
  isModelChoice(task?.model) ? task.model : settings

/** A task's model as given (a tool argument, the editor, a hand-edited file): a choice, null for "follow Settings", undefined for anything else. */
export function parseTaskModel(m: unknown): ModelChoice | null | undefined {
  if (m === undefined || m === null || m === '' || m === 'default') return null
  const v = typeof m === 'string' ? m.trim().toLowerCase() : m
  return v === 'default' ? null : isModelChoice(v) ? v : undefined
}
