// The suggestion chips under the board's message box (#206): questions for Corvid picked from what is going on
// right now, instead of the same four every time. A pure function from state to chips, so each rule is tested on
// its own (scripts/test-board-chips.mjs). MessageBoard.tsx only calls boardChips() and draws the result.

import { ALL_CHANNEL, GENERAL_CHANNEL, forUser, inChannel, type BoardMessage } from '@shared/board'
import type { Task, Worker } from '@shared/types'

/** One chip: its text goes in the box, to Corvid. An Answer chip sets the reply target instead. */
export interface BoardChip {
  text: string
  /** the agent's unanswered question this chip answers: the board replies to that message, which addresses the agent */
  answer?: { id: number; agentName?: string }
  /** a guided tour's id (#214): the chip plays that tour instead of asking Corvid */
  tour?: string
}

export interface ChipState {
  /** every board message (the rules narrow to the channel themselves) */
  messages: BoardMessage[]
  workers: Worker[]
  tasks: Task[]
  /** the channel the box writes in: All, General or a project id */
  channel: string
  /** the 5-hour and weekly bars, 0 to 100, when known */
  usage: { fiveHour?: number; week?: number }
  /** when the user was last around, if known: their newest board post */
  lastActiveAt?: number
  now: number
}

/** Never more than this many chips, in rule order. */
export const MAX_CHIPS = 4
/** A done post this recent still gets a "What did #12 finish?" chip. */
export const RECENT_DONE_MS = 60 * 60_000
/** Away this long makes one task in Done enough for "What finished while I was away?". */
export const AWAY_MS = 8 * 60 * 60_000
/** This many tasks in Done ask the same without an absence. */
export const DONE_PILE = 3
/** A bar at or above this share of its limit gets the usage chip. */
export const USAGE_PCT = 60

/** The strings, in one place. Curly apostrophes, like the rest of the board's text. */
export const CHIP_TEXT = {
  answer: (agent: string, taskId: number | undefined): string => `Answer ${agent}${taskId !== undefined ? ` on #${taskId}` : ''}`,
  running: (taskId: number): string => `How is #${taskId} going?`,
  finished: (taskId: number): string => `What did #${taskId} finish?`,
  projectState: 'What’s the state of this project?',
  projectNext: 'What’s the next task here?',
  away: 'What finished while I was away?',
  usage: 'How’s my usage?'
} as const

/** The onboarding chip that plays the "Your first day" tour (#214) rather than asking Corvid. */
export const TOUR_CHIP = { text: 'Show me around', tour: 'your-first-day' } as const

/** Chips for a fresh install or an empty board, when no other rule applies. */
export const ONBOARDING_CHIPS: readonly string[] = ['What can you do?', 'How do I start a worker?', 'Show me the task board', TOUR_CHIP.text]

const isProjectChannel = (channel: string): boolean => channel !== ALL_CHANNEL && channel !== GENERAL_CHANNEL

/** An agent's question to the user that no message of the user's has answered: no reply to it, and nothing addressed
 *  to that agent since. Newest first, one per agent. */
export function unansweredQuestions(messages: BoardMessage[], channel: string): BoardMessage[] {
  const asked = messages.filter((m) => m.author === 'agent' && m.question && forUser(m) && inChannel(m, channel))
  const open = asked.filter(
    (q) => !messages.some((m) => m.author === 'user' && m.id > q.id && (m.replyTo === q.id || (!!q.agentName && !!m.to?.includes(q.agentName))))
  )
  const seen = new Set<string>()
  return [...open].reverse().filter((q) => {
    const key = q.agentName ?? `#${q.taskId ?? q.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function boardChips(s: ChipState): BoardChip[] {
  const chips: BoardChip[] = []
  const inScope = (taskId: number | undefined): boolean => {
    if (!isProjectChannel(s.channel)) return true
    const t = s.tasks.find((x) => x.id === taskId)
    return !!t && t.projectId === s.channel
  }

  // 1. an agent asked and nobody answered
  for (const q of unansweredQuestions(s.messages, s.channel)) {
    chips.push({ text: CHIP_TEXT.answer(q.agentName ?? 'the agent', q.taskId), answer: { id: q.id, agentName: q.agentName } })
  }

  // 2. the most recently started running worker
  const running = s.workers.filter((w) => w.state === 'running' && inScope(w.taskId)).sort((a, b) => b.startedAt - a.startedAt)
  if (running[0]) chips.push({ text: CHIP_TEXT.running(running[0].taskId) })

  // 3. the newest done post of the last hour whose worker isn't running any more
  const live = new Set(running.map((w) => w.taskId))
  const done = s.messages.filter(
    (m) => m.author === 'agent' && m.done && m.taskId !== undefined && s.now - m.ts < RECENT_DONE_MS && !live.has(m.taskId) && inChannel(m, s.channel) && inScope(m.taskId)
  )
  if (done.length) chips.push({ text: CHIP_TEXT.finished(done[done.length - 1].taskId!) })

  // 4. in a project's channel
  if (isProjectChannel(s.channel)) chips.push({ text: CHIP_TEXT.projectState }, { text: CHIP_TEXT.projectNext })

  // 5. a pile in Done, or anything in Done after a long absence
  const doneTasks = s.tasks.filter((t) => t.column === 'done' && inScope(t.id)).length
  const away = s.lastActiveAt !== undefined && s.now - s.lastActiveAt > AWAY_MS
  if (doneTasks >= DONE_PILE || (away && doneTasks > 0)) chips.push({ text: CHIP_TEXT.away })

  // 6. a usage bar past the mark
  if ((s.usage.fiveHour ?? 0) >= USAGE_PCT || (s.usage.week ?? 0) >= USAGE_PCT) chips.push({ text: CHIP_TEXT.usage })

  // 7. nothing going on: how to start
  if (!chips.length) return ONBOARDING_CHIPS.map((text) => (text === TOUR_CHIP.text ? { ...TOUR_CHIP } : { text }))
  return chips.slice(0, MAX_CHIPS)
}
