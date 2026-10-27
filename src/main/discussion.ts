import { spawn } from 'node:child_process'
import type { BoardMessage } from '@shared/board'
import type { CrowLook } from '@shared/types'
import { agentName } from '@shared/agentNames'
import { agentLook } from '@shared/agentAvatar'
import { cutText } from '@shared/text'
import { thesisDose } from '@shared/corvidThesis'
import {
  ANGLES,
  CALL_TIMEOUT_MS,
  discussionNote,
  MAX_POST_CHARS,
  panelPrompt,
  summaryPrompt,
  type DiscussionMark,
  type TranscriptLine
} from '@shared/discussion'
import type { PostInput } from './board'
import { agentSettingsArgs } from './agentDeny'

// /discuss (#200): the orchestrator. Panelists are one-shot headless Claude calls (claude -p) the main process drives one
// at a time, in a fixed round-robin: no terminal, no worktree, no branch, no write tools, no connections, no network
// but the model call. Their posts go straight to the board through their own path (never the agents' MCP post tool),
// so the agents' posting limits don't apply and no @mention they write pings or wakes anyone. Only the user's own
// typing in the board's message box reaches startDiscussion (slashCommands.ts asserts the origin); nothing an agent,
// a ping, a tool, an extension or a socket does can.

export interface ConfirmInfo {
  topic: string
  agents: number
  turns: number
  calls: number
  /** 'default' when the worker model setting is the user's Claude Code default */
  model: string
  /** the names and angles, in speaking order */
  panel: string[]
  /** why usage is over the limit (#93), when it is: the user may still start */
  usageOver: string | null
}

export interface HeadlessCall {
  prompt: string
  /** the project folder the panelist may read, or nothing (no file tools at all) */
  dir?: string
  /** the --model to pass, or nothing for the user's Claude Code default */
  model?: string
  timeoutMs: number
}

export interface DiscussDeps {
  /** a board post on the discussion's own path: never the agents' tool, never rate limited */
  post: (input: PostInput) => BoardMessage
  /** what index.ts does after any post (toasts and notifications; discussion posts address nobody, so it stays quiet) */
  posted: (m: BoardMessage) => void
  messages: () => BoardMessage[]
  setMark: (id: number, patch: Partial<DiscussionMark>) => void
  /** the headless call: a fake in tests, claude -p in the app */
  run: (call: HeadlessCall) => Promise<{ text: string } | { error: string }>
  /** the dialog in Corvid's window: true only on the user's Start click */
  confirm: (info: ConfirmInfo) => Promise<boolean>
  /** whether a discussion in this channel is about Corvid (#202): the panel then gets the full thesis, else the three sentences */
  corvidTopic?: (channel: string) => boolean
  /** the #93 text when usage is at or over the gates (or unknown), else null */
  usageOver: (model: string) => Promise<string | null>
  /** Settings' "Block new agents" above the limit: then an over-limit discussion is refused outright */
  usageBlocks: () => boolean
  /** the worker model setting: 'default', or a model choice */
  model: () => string
  /** the folder of the channel's project; undefined for All and General */
  projectFolder: (channel: string) => string | undefined
  takenNames: () => string[]
  takenLooks: () => CrowLook[]
  createNote: (name: string, text: string, project: string | undefined) => { id: string }
  userName: () => string
}

interface Panelist {
  name: string
  look: CrowLook
  angle: (typeof ANGLES)[number]
}

interface Running {
  id: number
  topic: string
  turns: number
  channel: string
  dir?: string
  panel: Panelist[]
  transcript: TranscriptLine[]
  /** user messages up to this id are in the transcript already */
  seenUpTo: number
  stopped: boolean
  startedAt: number
}

let deps: DiscussDeps | null = null
let current: Running | null = null

export const initDiscussion = (d: DiscussDeps): void => void (deps = d)

/** The running discussion's header id, or null. */
export const runningDiscussion = (): number | null => current?.id ?? null

/** The flags of one panelist call: read-only or no tools at all. Exported so tests can assert them. */
export function callArgs(call: HeadlessCall): string[] {
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
  if (call.dir) {
    // the deny rules (#91) exactly as for workers: never the data folder, ~/.claude or secret files
    args.push('--tools', 'Read', 'Glob', 'Grep', '--allowedTools', 'Read', 'Glob', 'Grep', ...agentSettingsArgs(call.dir, call.dir))
  } else args.push('--tools', '')
  if (call.model) args.push('--model', call.model)
  return args
}

/** One headless call through the normal Claude lookup; the prompt goes on stdin. */
export async function runHeadless(call: HeadlessCall, bin: string, fallbackCwd: string): Promise<{ text: string } | { error: string }> {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(bin, callArgs(call), { cwd: call.dir ?? fallbackCwd, env, windowsHide: true })
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, call.timeoutMs)
  child.stdin.end(call.prompt)
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  clearTimeout(timer)
  if (timedOut) return { error: `no answer within ${Math.round(call.timeoutMs / 60_000)} minutes` }
  try {
    const j = JSON.parse(out.trim().split('\n').pop() ?? '') as { result?: string; is_error?: boolean }
    if (j.is_error) return { error: cutText(j.result ?? 'the call ended with an error', 200) }
    return { text: j.result ?? '' }
  } catch {
    return { error: code ? `claude stopped (exit ${code}) ${cutText(err, 200)}`.trim() : 'claude gave no answer' }
  }
}

const d = (): DiscussDeps => {
  if (!deps) throw new Error('The discussion module is not set up.')
  return deps
}

/** The panelists for a topic: names and crows the same for the same topic, never twins of each other or a running agent. */
export function makePanel(topic: string, n: number, takenNames: string[] = [], takenLooks: CrowLook[] = []): Panelist[] {
  const names = [...takenNames]
  const looks = [...takenLooks]
  const panel: Panelist[] = []
  for (let i = 0; i < n; i++) {
    const seed = `discuss:${topic}:${i + 1}`
    const name = agentName({ seed, title: topic }, names)
    const look = agentLook(seed, looks)
    names.push(name)
    looks.push(look)
    panel.push({ name, look, angle: ANGLES[i] })
  }
  return panel
}

/**
 * Start one, from the board's message box only. `origin` must be 'window': the slash command code passes it, and
 * nothing else may call this. Returns the notice the command shows under the user's message.
 */
export async function startDiscussion(
  o: { agents: number; turns: number; topic: string; channel: string; replyTo?: number; origin: 'window' | string }
): Promise<string> {
  if (o.origin !== 'window') throw new Error('Only the user, from the board’s message box, can start a discussion.')
  const dp = d()
  if (current) return `A discussion is already running (m${current.id}: "${cutText(current.topic, 60)}"). /discuss stop ends it; then start another.`
  const dir = dp.projectFolder(o.channel)
  const model = dp.model()
  const calls = o.agents * o.turns
  const usageOver = await dp.usageOver(model)
  if (usageOver && dp.usageBlocks()) return `The discussion can't start: ${usageOver} Settings blocks new agents above the usage limit.`
  const panel = makePanel(o.topic, o.agents, dp.takenNames(), dp.takenLooks())
  const ok = await dp.confirm({ topic: o.topic, agents: o.agents, turns: o.turns, calls, model, panel: panel.map((p) => `${p.name} (${p.angle.name})`), usageOver })
  if (!ok) return 'The discussion was cancelled: nothing was started.'
  const meanwhile = runningDiscussion()
  if (meanwhile !== null) return `A discussion started meanwhile (m${meanwhile}); this one wasn't started.`
  const header = dp.post({
    author: 'corvid',
    text: `Discussion: ${o.topic} (${o.agents} agents, ${o.turns} turn${o.turns === 1 ? '' : 's'})\nPanel: ${panel.map((p) => `${p.name}, the ${p.angle.name}`).join('; ')}.${dir ? ' They can read this project’s files, nothing more.' : ' They have no file access here.'}`,
    project: o.channel,
    replyTo: o.replyTo,
    discussion: { id: 0, role: 'header', status: 'running', progress: 'Starting' }
  })
  dp.setMark(header.id, { id: header.id })
  dp.posted(header)
  current = { id: header.id, topic: o.topic, turns: o.turns, channel: o.channel, dir, panel, transcript: [], seenUpTo: header.id, stopped: false, startedAt: Date.now() }
  void runLoop(current, model === 'default' ? undefined : model).catch((e) => {
    console.error('[discussion] failed', e)
    finish(current!, 'failed', `The discussion stopped with an error: ${cutText(String((e as Error)?.message ?? e), 200)}`)
  })
  return `Started: ${calls} calls, one at a time. /discuss stop ends it after the current one.`
}

/** User messages posted in the discussion's channel since it last looked, added as from the user (not a panelist). */
function pickUpUserLines(r: Running): void {
  const dp = d()
  for (const m of dp.messages()) {
    if (m.id <= r.seenUpTo || m.author !== 'user' || m.command) continue
    const inChannel = (m.project ?? '') === (r.channel ?? '') || m.replyTo === r.id
    if (!inChannel) continue
    r.transcript.push({ who: dp.userName() || 'the user', kind: 'user', text: cutText(m.text, MAX_POST_CHARS) })
  }
  r.seenUpTo = Math.max(r.seenUpTo, ...dp.messages().map((m) => m.id))
}

async function runLoop(r: Running, model: string | undefined): Promise<void> {
  const dp = d()
  let failures = 0
  for (let turn = 1; turn <= r.turns && !r.stopped; turn++) {
    for (let i = 0; i < r.panel.length; i++) {
      if (r.stopped) break
      const p = r.panel[i]
      dp.setMark(r.id, { progress: `Turn ${turn} of ${r.turns}: ${p.name} is speaking (${i + 1} of ${r.panel.length})` })
      pickUpUserLines(r)
      const prompt = panelPrompt({
        thesis: thesisDose(dp.corvidTopic?.(r.channel) ?? true ? 'full' : 'short', false),
        topic: r.topic,
        me: p.name,
        angle: p.angle,
        others: r.panel.filter((x) => x !== p).map((x) => x.name),
        turn,
        turns: r.turns,
        transcript: r.transcript,
        files: !!r.dir
      })
      const res = await dp.run({ prompt, dir: r.dir, model, timeoutMs: CALL_TIMEOUT_MS })
      if (current !== r) return // cancelled meanwhile
      if ('error' in res || !res.text.trim()) {
        failures++
        const why = 'error' in res ? res.error : 'an empty answer'
        dp.posted(dp.post({ author: 'corvid', text: `${p.name} didn't answer this turn (${why}).`, project: r.channel, replyTo: r.id, discussion: { id: r.id, role: 'header' } }))
        if (failures >= 2) return finish(r, 'failed', 'Two calls in a row failed, so the discussion ended early.')
        continue
      }
      failures = 0
      const text = cutText(res.text.trim(), MAX_POST_CHARS)
      const m = dp.post({ author: 'agent', agentName: p.name, avatar: p.look, text, project: r.channel, discussion: { id: r.id, role: 'panel', angle: p.angle.name } })
      dp.posted(m)
      r.transcript.push({ who: p.name, kind: 'panel', text })
    }
  }
  if (r.stopped && !r.transcript.some((l) => l.kind === 'panel')) return finish(r, 'stopped', 'The discussion was stopped before anyone spoke.')
  await summarise(r, r.stopped ? 'stopped' : 'done')
}

async function summarise(r: Running, status: 'done' | 'stopped'): Promise<void> {
  const dp = d()
  dp.setMark(r.id, { progress: 'Corvid is summing up' })
  pickUpUserLines(r)
  // a fixed summary call with no tools at all: it can't start workers, read the board or use any connection
  const res = r.transcript.length ? await dp.run({ prompt: summaryPrompt(r.topic, r.transcript, thesisDose(dp.corvidTopic?.(r.channel) ?? true ? 'full' : 'short', false)), timeoutMs: CALL_TIMEOUT_MS }) : { text: 'Nobody spoke, so there is nothing to sum up.' }
  if (current !== r) return
  const text = 'error' in res ? `Corvid couldn't sum up (${res.error}). The transcript is above; Save as note keeps it.` : cutText(res.text.trim() || '(no summary)', 1800)
  dp.posted(dp.post({ author: 'assistant', text, project: r.channel, replyTo: r.id, discussion: { id: r.id, role: 'summary' } }))
  finish(r, status, status === 'stopped' ? 'The discussion was stopped; Corvid summed up what was said.' : `Discussion finished: ${r.transcript.filter((l) => l.kind === 'panel').length} messages.`)
}

function finish(r: Running, status: DiscussionMark['status'], line: string): void {
  if (current !== r) return
  current = null
  d().setMark(r.id, { status, progress: line })
}

/** /discuss stop, or the header's Stop button: ends it after the call that is running now. */
export function stopDiscussion(): string {
  if (!current) return 'No discussion is running.'
  if (current.stopped) return 'It is already stopping: the current call finishes first.'
  current.stopped = true
  d().setMark(current.id, { progress: 'Stopping after the current call' })
  return 'Stopping the discussion after the current call; Corvid then sums up what was said.'
}

/** On start: a discussion that was running when the app closed is over. A calm notice, no resume. */
export function cancelLeftovers(): number {
  const dp = d()
  let n = 0
  for (const m of dp.messages()) {
    if (m.discussion?.role !== 'header' || m.discussion.status !== 'running' || m.discussion.id !== m.id) continue
    dp.setMark(m.id, { status: 'cancelled', progress: 'Cancelled: Corvid restarted while it ran' })
    dp.posted(dp.post({ author: 'corvid', text: 'Corvid restarted, so this discussion ended where it was. Start it again with /discuss if you want the rest.', project: m.project ?? '', replyTo: m.id, discussion: { id: m.id, role: 'header' } }))
    n++
  }
  return n
}

/** The messages that make up discussion `id`, in order: the header, the panelists', the user's in between, the summary. */
export function discussionMessages(id: number, all = d().messages()): BoardMessage[] {
  const header = all.find((m) => m.id === id && m.discussion?.role === 'header')
  if (!header) return []
  const end = all.find((m) => m.discussion?.id === id && m.discussion.role === 'summary')?.id ?? Number.MAX_SAFE_INTEGER
  return all.filter(
    (m) => m.id >= id && m.id <= end && (m.discussion?.id === id || (m.author === 'user' && !m.command && ((m.project ?? '') === (header.project ?? '') || m.replyTo === id)))
  )
}

/** Save as note: the transcript (panelists and the user's lines) plus the summary. Nothing a panelist wrote is run. */
export function saveDiscussionNote(id: number): string {
  const dp = d()
  const msgs = discussionMessages(id)
  const header = msgs[0]
  if (!header) throw new Error('That discussion is gone (its messages expired or the board was cleared).')
  const topic = /^Discussion: ([\s\S]*?) \(\d+ agents?, \d+ turns?\)/.exec(header.text)?.[1] ?? header.text.split('\n')[0]
  const lines: TranscriptLine[] = msgs
    .filter((m) => m.discussion?.role === 'panel' || m.author === 'user')
    .map((m) => (m.author === 'user' ? { who: dp.userName() || 'the user', kind: 'user' as const, text: m.text } : { who: m.agentName ?? 'panelist', kind: 'panel' as const, text: m.text }))
  const summary = msgs.find((m) => m.discussion?.role === 'summary')?.text ?? ''
  const note = discussionNote(topic, header.ts, lines, summary)
  return dp.createNote(note.name, note.text, header.project || undefined).id
}
