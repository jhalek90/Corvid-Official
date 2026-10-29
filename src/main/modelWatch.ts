// The run-time health watch for workers on the user's own models (#319, step 7 of the plan in N175, section 6). The
// pre-start check (customHealth.ts) only says the server answered once; this reads a custom-model worker's terminal
// output for what Claude Code prints when its model goes wrong later: API Error lines, a refused connection, a request
// over the context size, and the prompts that block a session before it starts (trust, first-run set-up, an update).
// Pure: it only reads text and words the messages, so scripts/test-model-watch.mjs feeds it fake output. workers.ts
// posts what it finds, once per kind per worker. Nothing here ever moves a task to a Claude model, which would spend
// plan usage the user didn't choose; the user restarts it or picks another model.

import type { CustomModel } from '@shared/customModels'
import type { ModelTroubleKind } from '@shared/types'

/** How much raw output is kept between chunks, so a line split over two chunks is still seen whole. */
const TAIL_MAX = 4096
/** Blocking prompts only show before the session's first turn; after this long, or once it's been busy, they aren't looked for. */
export const PROMPT_WINDOW_MS = 3 * 60_000

/** One worker's watch: the last bit of its output, the kinds already reported, and whether start-up is over. */
export interface ModelWatch {
  startedAt: number
  tail: string
  fired: Set<ModelTroubleKind>
  /** seen working on a turn: start-up prompts are behind it */
  sawBusy: boolean
}

export const newWatch = (startedAt: number): ModelWatch => ({ startedAt, tail: '', fired: new Set(), sawBusy: false })

/** The prompts that stop a session until someone answers them in its terminal. */
export const BLOCKING: readonly ModelTroubleKind[] = ['trust', 'onboarding', 'update']

/**
 * The terminal's text, roughly as it reads on screen: colours and other escapes go, a cursor move forward is a space
 * (Windows' console writes runs of spaces that way), and any other cursor move starts a new line.
 */
export function screenText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-9;?]*C/g, ' ')
    .replace(/\x1b\[[0-?]*[ -/]*[mK]/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '\n')
    .replace(/\x1b[^[\]]/g, '')
}

/** Its lines with Claude Code's own bullets and frames taken off the front. A ">" stays: that's the prompt the user or Corvid typed. */
const lines = (text: string): string[] =>
  text
    .split(/[\r\n]+/)
    .map((l) => l.replace(/^[\s⎿⏺●○◯│┃|╭╰╮╯─*·✻✳✢✶✽]+/, '').trimEnd())
    .filter(Boolean)

const API_ERROR = /^API Error\b/i
/** a request over the context: llama-server's "exceeds the available context size", Anthropic's "prompt is too long" */
const CONTEXT = /exceed_context_size|exceeds? the (available )?context|context (size|length|window)|n_ctx|prompt is too long|too many tokens/i
const DOWN = /connection (error|refused)|ECONNREFUSED|ECONNRESET|fetch failed|unable to connect|socket hang up/i
/** Claude Code retries a failed request: the first two tries may be a blip, so they don't count yet */
const EARLY_RETRY = /attempt [12]\s*\//i
const TRUST = /do you trust the files in this folder|is this a project you created or one you trust|trust this folder\?/i
const ONBOARDING = /choose the text style|select login method|let'?s get started|do you want to use this api key/i
const UPDATE = /update available|a new version of claude code|update now\?/i

export interface ModelTrouble {
  kind: ModelTroubleKind
  /** the line it was found on, cut short */
  line: string
}

/** What the output in `text` shows, in the order it matters: one finding per kind, the kinds in `skip` left out. */
export function findTrouble(text: string, opts: { prompts: boolean; skip?: ReadonlySet<ModelTroubleKind> }): ModelTrouble[] {
  const found = new Map<ModelTroubleKind, string>()
  const add = (kind: ModelTroubleKind, line: string): void => {
    if (!opts.skip?.has(kind) && !found.has(kind)) found.set(kind, line.slice(0, 160))
  }
  const ls = lines(screenText(text))
  ls.forEach((l, i) => {
    if (API_ERROR.test(l) || /^Prompt is too long/i.test(l) || /^Unable to connect to API/i.test(l)) {
      // a long error wraps in the terminal: the next few lines belong to it
      const whole = [l, ...ls.slice(i + 1, i + 4)].join(' ')
      if (CONTEXT.test(whole)) add('context', l)
      else if (DOWN.test(whole)) {
        if (!EARLY_RETRY.test(whole)) add('down', l)
      } else if (!EARLY_RETRY.test(whole)) add('api', l)
    }
    if (!opts.prompts) return
    if (TRUST.test(l)) add('trust', l)
    if (ONBOARDING.test(l)) add('onboarding', l)
    if (UPDATE.test(l)) add('update', l)
  })
  return [...found].map(([kind, line]) => ({ kind, line }))
}

/** Feed one chunk of a worker's output to its watch; returns what's new, each kind once per watch. */
export function scanChunk(watch: ModelWatch, chunk: string, now: number): ModelTrouble[] {
  const text = watch.tail + chunk
  watch.tail = text.slice(-TAIL_MAX)
  const prompts = !watch.sawBusy && now - watch.startedAt < PROMPT_WINDOW_MS
  const found = findTrouble(text, { prompts, skip: watch.fired })
  for (const t of found) watch.fired.add(t.kind)
  return found
}

/** "32k" for a context size. */
const kTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1024)}k` : String(n))

/** What the board and the card say about it, in plain words: what happened, where the work is, what the user can do. */
export function troubleMessage(t: ModelTrouble, m: CustomModel, taskId: number, branch?: string): string {
  const work = branch ? 'Its work so far is on its branch.' : 'Its work so far is in its folder.'
  const noSwitch = "Corvid won't move it to a Claude model by itself."
  switch (t.kind) {
    case 'context':
      return `#${taskId}'s model ran out of context (${kTokens(m.contextTokens)}, ${m.label}). ${work} Restart it on a bigger model, or split the task.`
    case 'down':
      return `#${taskId} lost its model: ${m.baseUrl} stopped answering (${m.label}). ${work} Start the server again, then restart #${taskId}; ${noSwitch}`
    case 'api':
      return `#${taskId}'s model sent an error (${m.label}): "${t.line}". Its terminal in Agents shows the rest.`
    case 'trust':
      return `#${taskId} is stuck at Claude Code's "trust this folder" prompt on ${m.label}. Answer it in its terminal in Agents, or run Set up once in Settings → Models.`
    case 'onboarding':
      return `#${taskId} is stuck at Claude Code's first-run set-up on ${m.label}. Finish it in its terminal in Agents, or run Set up once in Settings → Models.`
    case 'update':
      return `#${taskId} is stuck at Claude Code's update notice on ${m.label}. Answer it in its terminal in Agents.`
  }
}
