import type { ReactNode } from 'react'
import { choiceLabel, FABLE_MAYBE_UNAVAILABLE, FABLE_WARNING, fableWeek, MODEL_CHOICES } from '@shared/models'
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

/** <option>s for a model <select>. */
export function ModelOptions(): ReactNode {
  const note = useFableNote()
  return (
    <>
      {MODEL_CHOICES.map((m) => (
        <option key={m} value={m} title={m === 'fable' ? fableTitle(note) : undefined}>
          {choiceLabel(m)}
          {m === 'fable' ? note : ''}
        </option>
      ))}
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
