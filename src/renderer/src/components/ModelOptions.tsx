import type { ReactNode } from 'react'
import { choiceLabel, customLabel, FABLE_MAYBE_UNAVAILABLE, FABLE_WARNING, fableWeek, MODEL_CHOICES } from '@shared/models'
import { ASSISTANT_MIN_CONTEXT, assistantModelProblem, customModelRef, isCustomModelRef, type CustomModel } from '@shared/customModels'
import { effortLabel, REASONING_EFFORTS } from '@shared/reasoningEffort'
import { useStore } from '../store'

// The models every selector offers (#127): Haiku, Sonnet, Opus, Fable, cheapest first. Choosing Fable asks in a dialog
// in the main process (applyConfig), so the selectors only show the choices and the cost hint.

/** " (may not be available on your plan)" when the usage output has no Fable weekly limit, else ''. */
export function useFableNote(): string {
  const quota = useStore((s) => s.quota)
  return quota && !quota.error && !fableWeek(quota.weeks) ? ` (${FABLE_MAYBE_UNAVAILABLE})` : ''
}

/** The tooltip on a Fable entry: the cost warning, and the plan note when there's one. */
export const fableTitle = (note: string): string => `${FABLE_WARNING}${note ? ` It ${note.trim().slice(1, -1)}.` : ''} Choosing it asks first.`

/** Corvid itself on one of the user's own models (#320): only from ASSISTANT_MIN_CONTEXT up, and experimental. */
export const CUSTOM_FOR_CORVID = 'Experimental: Corvid itself runs on this model. While it does, workers always need your approval (Plan & ask), and Corvid checks the server answers before it starts.'
/** The tooltip on an entry Corvid itself can't run on, or the experimental note when it can. */
export const corvidCustomTitle = (m: CustomModel, models: readonly CustomModel[] | undefined): string =>
  assistantModelProblem(models, customModelRef(m.id)) ?? `${m.label}. ${CUSTOM_FOR_CORVID}`
/** Can Corvid itself run on this entry (a context of ASSISTANT_MIN_CONTEXT or more)? */
export const corvidCanUse = (m: CustomModel): boolean => m.contextTokens >= ASSISTANT_MIN_CONTEXT
/** The tooltip on the user's own models in the worker pickers (#316). */
export const CUSTOM_WORKER_TIP = 'One of your own models (Settings → Models). Uses no plan usage. Workers on it ignore Worker effort and always ask before edits.'

/**
 * <option>s for a model <select>: the Claude models, then "Your models" when the user has any (#316). `custom` says
 * how they show: 'on' for worker pickers, 'corvid' for Corvid's own model (only entries of 64k context and up,
 * experimental, #320), unset for pickers they aren't offered in (the scan). `current` is the select's value, so a
 * custom:<id> whose entry is gone still shows.
 */
export function ModelOptions({ custom, current }: { custom?: 'on' | 'corvid'; current?: string }): ReactNode {
  const note = useFableNote()
  const models = useStore((s) => s.config?.models)
  const gone = custom && isCustomModelRef(current) && !models?.some((m) => customModelRef(m.id) === current) ? current : undefined
  return (
    <>
      {MODEL_CHOICES.map((m) => (
        <option key={m} value={m} title={m === 'fable' ? fableTitle(note) : undefined}>
          {choiceLabel(m)}
          {m === 'fable' ? note : ''}
        </option>
      ))}
      {custom && (models?.length || gone) ? (
        <optgroup label="Your models">
          {models?.map((m) => (
            <option
              key={m.id}
              value={customModelRef(m.id)}
              disabled={custom === 'corvid' && !corvidCanUse(m)}
              title={custom === 'corvid' ? corvidCustomTitle(m, models) : CUSTOM_WORKER_TIP}
            >
              {m.label}
              {custom === 'corvid' ? (corvidCanUse(m) ? ' (experimental)' : ' (workers only: under 64k context)') : ''}
            </option>
          ))}
          {gone && (
            <option value={gone} disabled title="Its entry was removed from Settings → Models, so nothing starts on it. Pick another model.">
              {customLabel(gone, models)}
            </option>
          )}
        </optgroup>
      ) : null}
    </>
  )
}

/** <option>s for an effort <select> (#238): Claude Code default first (it passes nothing), then the CLI's levels. */
export function EffortOptions(): ReactNode {
  return (
    <>
      {(['default', ...REASONING_EFFORTS] as const).map((e) => (
        <option key={e} value={e}>
          {effortLabel(e)}
        </option>
      ))}
    </>
  )
}
