// The reasoning effort Claude Code runs at (#238): one setting for Corvid, one for new workers. Not the extension
// build size classes in costEstimate.ts, which are called Effort.

/** The levels the CLI's --effort flag takes (checked on CLI 2.1.312: "--effort <level> (low, medium, high, xhigh, max)"). */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
/** A setting's value: 'default' passes nothing, so Claude Code uses its own default. */
export type ReasoningEffortSetting = 'default' | ReasoningEffort

export const isReasoningEffort = (e: unknown): e is ReasoningEffort =>
  typeof e === 'string' && (REASONING_EFFORTS as readonly string[]).includes(e)
export const isReasoningEffortSetting = (e: unknown): e is ReasoningEffortSetting => e === 'default' || isReasoningEffort(e)

/** What goes on the claude command line for a setting: nothing for 'default' (or anything that isn't a level). */
export const effortArgs = (e: unknown): string[] => (isReasoningEffort(e) ? ['--effort', e] : [])

const LABEL: Record<ReasoningEffort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
/** "Low" … "Max", or "Claude Code default": the name a selector or tooltip shows. */
export const effortLabel = (e: ReasoningEffortSetting): string => (e === 'default' ? 'Claude Code default' : LABEL[e])
