import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AssistantPersonality, AssistantSnapshot, AssistantState, BoardAsk, ChatItem } from '@shared/types'
import type { BoardAction, BoardMessage } from '@shared/board'
import { quietTool, toolLabel } from '@shared/corvidActions'
import { choiceLabel, launchArgs, MODEL_CHOICES } from '@shared/models'
import { getConfig, setConfig } from './config'
import { CLAUDE_NOT_FOUND, resolveClaude } from './claudeBin'
import type { McpEndpoint } from './mcp'
import * as workers from './workers'
import { HARD_MAX_WORKERS, usageLimitLine } from '@shared/workerLimits'
import { NOTES_PROMPT } from './noteTools'
import { assistantBoardPrompt, NO_REPLY, userNameLine } from './boardTools'
import { SUGGESTION_PREFIX, SUGGESTIONS_NOTE, thesisDose } from '@shared/corvidThesis'
import { allowAssistant } from './testCopy'
import { agentSettingsArgs } from './agentDeny'
import { listProjects } from './projectStore'
import { extensionCommands } from '../extensions/sockets/main'
import { DASHBOARD_COMMANDS, FALLBACK_COMMANDS, findCommand, HEADLESS_BUILTINS, type CommandList, type SlashCommand } from '@shared/slashCommands'

// The assistant is the user's own Claude Code CLI in headless streaming mode
// (`claude -p --input-format stream-json`), kept alive between messages. Its only
// built-in tools are read-only; everything else goes through the dashboard's MCP tools.

const MAX_CHAT = 300

export const assistantDir = (): string => join(app.getPath('userData'), 'assistant')

// Only the tone line differs between personalities; the rules and limits are shared.
const TONE: Record<AssistantPersonality, string> = {
  default: 'Be brief and concrete: short sentences, small lists, no preamble. The user reads you on the message board, where one message holds at most 2000 characters.',
  // Loosely after ASD-STE100 (Simplified Technical English): the gist, not the full word list.
  strict:
    'Write in the style of Simplified Technical English (ASD-STE100). Give only the facts and actions the user needs: no greetings, no preamble, no filler, no opinions, no closing offers. Use one idea per sentence. Keep sentences under 20 words. Use the active voice and simple tenses. Use common words with one clear meaning; no idioms, slang or jokes. Use the same word for the same thing every time. Write instructions as commands ("Open Settings."), and put sequential steps in a numbered list, one action per step. Keep paragraphs to three sentences or fewer. The user reads you on the message board, where one message holds at most 2000 characters.',
  casual:
    'Be relaxed and conversational, like a friendly colleague: plain everyday words, contractions, the odd light remark. Still keep replies short (the user reads you on the message board) and keep task ids, numbers and facts exact. The casual tone never loosens any of the rules above.'
}

function systemPrompt(): string {
  const l = getConfig().limits
  return [
    'You are Corvid, the assistant inside the Corvid dashboard app, the user\'s personal Claude Code dashboard: a desktop app that tracks their Claude Code sessions, projects (git repos), a task board, and plan usage.',
    'You and the app share the name. You are the assistant the user talks to on the message board in the Agents view (an untagged message or @corvid), not the app itself. When the user says "Corvid", tell from context whether they mean you or the app; when it matters, call the app "the Corvid app" or "the dashboard" and refer to yourself as "I".',
    'Use the mcp__dashboard__ tools to answer questions about projects, tasks, sessions and usage, and to act on the task board. Prefer one `overview` call for broad questions. You can Read/Grep/Glob files to answer questions, but you cannot edit files or run commands yourself.',
    'To get real work done on a task, use start_worker: it launches a separate interactive Claude Code session in the task\'s project folder. Workers ask the user for permission like any session, and the user can watch them in the Agents view.',
    `Hard limits enforced by the app (you cannot change them): at most ${l.maxWorkers} concurrent workers (the user's setting in Settings, which can't go above ${HARD_MAX_WORKERS}), ${usageLimitLine(l)}, each worker stopped after ${l.workerMinutes} minutes of work (time the computer sleeps or a worker waits for the user does not count). Each worker is its own Claude session using the user's plan usage, so several at once use it up faster; the usage limit only affects starting new workers, not running ones. If start_worker is refused, explain why and suggest what to do. Never try to work around a limit.`,
    'When the user asks where something is or how to do something in Corvid, or asks you to explain a Corvid feature ("explain X", "what is X", "what does this do"), a short guided tour often helps: call tour_anchors, then play_tour with 3 to 6 steps, and answer in one or two sentences on the board too. If no anchor fits, answer in text only; never force a tour. Save a tour (save_tour) only when the user asks to keep it.',
    `Notes: ${NOTES_PROMPT} Notes the user wrote are theirs: rewrite or delete one only when the user asks you to in their message, naming it.`,
    `Message board: ${assistantBoardPrompt(getConfig().agentPings)} ${userNameLine(getConfig().userName)}`.trimEnd(),
    'The task board has four columns: backlog, next (Up next), doing (In progress) and done. Done holds finished work until the user removes it: a task moves there by itself when the worker on it merges its branch, or when someone moves it (update_task with column done). No worker starts on a task in done. finish_task still deletes a task from any column.',
    'Tasks can be "blocked by" other tasks: only a hint, a task in done no longer blocks anything, the user can always start anything. If start_worker says a task has open blockers, tell the user which ones and their state and ask whether to start anyway. Call it again with override_blockers: true only after the user has said yes in their reply; never decide that yourself.',
    'Only start workers when the user asks for work to be done. Start one per task; don\'t start several unless asked. Don\'t complete or discard tasks unless the user says so.',
    `Refer to tasks as #id. ${TONE[getConfig().assistantPersonality] ?? TONE.default}`,
    `The mode is "${getConfig().assistantMode}". In "ask" mode start_worker only proposes; tell the user to approve it under "Awaiting your approval" at the top of the Agents view.`,
    `You are running on ${choiceLabel(getConfig().assistantModel)}. New workers run on ${getConfig().workerModel === 'default' ? "the user's Claude Code default model" : choiceLabel(getConfig().workerModel)}. The models to choose from are ${MODEL_CHOICES.map(choiceLabel).join(', ')}; Fable costs the most and the user confirms it in a dialog. The user can change either with the Corvid strip at the top of the message board (or in Settings, or /model); you can't change them yourself, but tell them where they are if asked. The effort Claude Code runs at, for you and for new workers, is set only in Settings (Effort and Worker effort), default Claude Code's own. A task can have its own model, which beats the worker model for its workers: create_task and update_task can set Haiku, Sonnet or Opus (or default) when the user asks; only the user can put a task on Fable, in the task's editor.`,
    `Your personality is "${getConfig().assistantPersonality}". The user can change it in Settings; you can't change it yourself.`,
    thesisDose('full'),
    `Agents on other projects may end their done post with one line starting "${SUGGESTION_PREFIX}". The app collects those lines into the note "${SUGGESTIONS_NOTE}" (task, project, date; exact duplicates skipped). Raise a suggestion only when the user asks, or when the same one has come from more than one task; never turn one into a task on your own; keep that note tidy and merge near-duplicates only when the user asks. Never post about suggestions on your own.`
  ].join('\n')
}

let proc: ChildProcessWithoutNullStreams | null = null
let endpoint: McpEndpoint | null = null
let state: AssistantState = 'offline'
let chat: ChatItem[] = []
let lastTurn: AssistantSnapshot['lastTurn']
let liveQuota: AssistantSnapshot['liveQuota']
let lastCumulativeCost = 0
let turnStartedAt = 0
let emit: (s: AssistantSnapshot) => void = () => {}
let onQuota: (q: { fiveHour: number; week: number }) => void = () => {}
let emitTimer: NodeJS.Timeout | null = null
let saveTimer: NodeJS.Timeout | null = null
let resumeFailed = false

export function initAssistant(e: McpEndpoint, onSnapshot: (s: AssistantSnapshot) => void, quotaUpdate: typeof onQuota): void {
  endpoint = e
  emit = onSnapshot
  onQuota = quotaUpdate
  mkdirSync(assistantDir(), { recursive: true })
  try {
    chat = JSON.parse(readFileSync(join(assistantDir(), 'chat.json'), 'utf8'))
    for (const c of chat) if (c.kind === 'tool' && c.status === 'running') c.status = 'error'
  } catch {
    chat = []
  }
  try {
    const c = JSON.parse(readFileSync(join(assistantDir(), 'commands.json'), 'utf8'))
    if (Array.isArray(c.commands)) sessionCommands = { all: c.commands, at: c.at ?? 0, live: false }
  } catch {
    /* none yet: the fallback list until Corvid first starts */
  }
}

export function snapshot(): AssistantSnapshot {
  return { state, chat, workers: workers.listWorkers(), proposals: workers.listProposals(), blocker: workers.knownBlocker() ?? undefined, lastTurn, liveQuota, boardAsks: asks, commands: commandList() }
}

/** The user's latest message: what the assistant is acting on now. The notes tools check it before
 *  the assistant changes a note the user wrote. */
export function currentRequest(): string {
  for (let i = chat.length - 1; i >= 0; i--) {
    const c = chat[i]
    if (c.kind === 'user') return c.text
  }
  return ''
}

/** The id of the user's latest message, so a tool can tell whether the user has spoken since it last answered. */
export function currentRequestId(): string {
  for (let i = chat.length - 1; i >= 0; i--) {
    const c = chat[i]
    if (c.kind === 'user') return c.id
  }
  return ''
}

export function getLiveQuota(): AssistantSnapshot['liveQuota'] {
  return liveQuota
}

export function changed(): void {
  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    emit(snapshot())
  }, 40)
  if (!saveTimer) saveTimer = setTimeout(saveChat, 1500)
}

function saveChat(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  try {
    writeFileSync(join(assistantDir(), 'chat.json'), JSON.stringify(chat.slice(-MAX_CHAT)))
  } catch {
    /* disk errors shouldn't take the app down */
  }
}

function setState(s: AssistantState): void {
  state = s
  changed()
}

function push(item: ChatItem): void {
  chat.push(item)
  if (chat.length > MAX_CHAT) chat.splice(0, chat.length - MAX_CHAT)
  changed()
}

export function note(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
  // Collapse repeats ("Worker for #1 finished its turn" ×3) into one line with a count.
  const last = chat[chat.length - 1]
  const base = (t: string): string => t.replace(/ \(×\d+\)$/, '')
  if (last?.kind === 'note' && base(last.text) === text) {
    const n = Number(/\(×(\d+)\)$/.exec(last.text)?.[1] ?? 1) + 1
    last.text = `${text} (×${n})`
    last.ts = Date.now()
    changed()
    return
  }
  push({ kind: 'note', id: randomUUID(), ts: Date.now(), text, tone })
  if (tone === 'error') lastError = text
  // with the dock gone, warnings and errors (a usage gate, Corvid failing to start) also show on the board
  if (tone !== 'info') boardHooks.notice(text)
}

/** The latest error note, so a board message that failed can say why. */
let lastError = ''

async function start(): Promise<boolean> {
  // a test copy runs no assistant unless the test asks (DASH_TEST_ASSISTANT=1), and then on a fresh session (#85)
  if (!allowAssistant()) {
    note('This is a test copy of Corvid: the assistant is off (start it with DASH_TEST_ASSISTANT=1).', 'info')
    return false
  }
  const bin = await resolveClaude(getConfig().claudePath)
  if (!bin || !endpoint) {
    note(`${CLAUDE_NOT_FOUND} This chat runs on it.`, 'error')
    setState('error')
    return false
  }
  const cfg = getConfig()
  const mcp = JSON.stringify({
    mcpServers: { dashboard: { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` } } }
  })
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // the model and effort (#238); an effort change, like a model change, applies from the next session
    ...launchArgs(cfg.assistantModel, cfg.assistantEffort),
    '--mcp-config', mcp,
    '--strict-mcp-config',
    '--tools', 'Read', 'Glob', 'Grep',
    '--allowedTools', 'mcp__dashboard__*', 'Read', 'Glob', 'Grep',
    // files agents may not read (#91), in every project folder since the chat reads them by absolute path
    ...agentSettingsArgs(undefined, undefined, listProjects().flatMap((p) => p.folders.map((f) => f.path))),
    '--append-system-prompt', systemPrompt()
  ]
  if (cfg.assistantSessionId && !resumeFailed) args.push('--resume', cfg.assistantSessionId)

  // Runs on the subscription login; a stray API key in the environment would take precedence.
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  setState('starting')
  const child = spawn(bin.path, args, { cwd: assistantDir(), env, windowsHide: true })
  proc = child
  lastCumulativeCost = 0
  let buf = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        handle(JSON.parse(line))
      } catch {
        /* non-JSON noise */
      }
    }
  })
  child.stderr.on('data', (d) => (stderr += d))
  // the session's own command list, with descriptions; no model turn. Asked on every start, so a restart refreshes it.
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `cmds-${randomUUID()}`, request: { subtype: 'initialize' } }) + '\n')
  child.on('exit', (code) => {
    if (proc !== child) return
    proc = null
    if (sessionCommands) sessionCommands.live = false
    for (const c of chat) if (c.kind === 'tool' && c.status === 'running') c.status = 'error'
    for (const c of chat) if (c.kind === 'assistant' && c.streaming) c.streaming = false
    failTurn(code ? `Corvid stopped (exit ${code}) before it answered.` : 'Corvid closed before it answered.')
    if (code && state !== 'offline') {
      if (cfg.assistantSessionId && !resumeFailed && /resume|session|conversation/i.test(stderr)) {
        resumeFailed = true
        note('Couldn\'t resume the previous conversation; the next message starts a new one.', 'warn')
      } else {
        note(`Corvid stopped (exit ${code}). ${stderr.trim().split('\n').slice(-2).join(' ')}`.trim(), 'error')
      }
      setState('error')
    } else setState('offline')
    // whatever else is queued gets its own try, on a fresh process
    pump(PUMP_AFTER_TURN_MS)
  })
  return true
}

let streamMsgId = ''
let streamItem: Extract<ChatItem, { kind: 'assistant' }> | null = null

function handle(m: any): void {
  switch (m.type) {
    case 'control_response': {
      const cmds = m.response?.response?.commands
      if (m.response?.subtype === 'success' && Array.isArray(cmds)) gotCommands(cmds)
      break
    }
    case 'system':
      if (m.subtype === 'init' && m.session_id && m.session_id !== getConfig().assistantSessionId) {
        setConfig({ assistantSessionId: m.session_id })
        resumeFailed = false
      }
      if (m.subtype === 'status' && m.status === 'requesting' && state !== 'tool') setState('thinking')
      break
    case 'rate_limit_event': {
      const w = m.rate_limit_info?.unifiedWindows
      if (w?.five_hour || w?.seven_day) {
        liveQuota = { fiveHour: Math.round((w.five_hour?.utilization ?? 0) * 100), week: Math.round((w.seven_day?.utilization ?? 0) * 100), at: Date.now() }
        onQuota(liveQuota)
        changed()
      }
      break
    }
    case 'stream_event': {
      const ev = m.event
      if (ev?.type === 'message_start') streamMsgId = ev.message?.id ?? randomUUID()
      else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
        streamItem = { kind: 'assistant', id: `${streamMsgId}:${ev.index}`, ts: Date.now(), text: '', streaming: true }
        push(streamItem)
        setState('thinking')
      } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use') setState('tool')
      else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && streamItem) {
        streamItem.text += ev.delta.text
        changed()
      } else if (ev?.type === 'content_block_stop' && streamItem) {
        streamItem.streaming = false
        streamItem = null
        changed()
      }
      break
    }
    case 'assistant':
      for (const b of m.message?.content ?? []) {
        if (b.type === 'tool_use') {
          push({ kind: 'tool', id: b.id, ts: Date.now(), name: String(b.name).replace(/^mcp__dashboard__/, ''), input: b.input, status: 'running' })
          setState('tool')
        } else if (b.type === 'text' && b.text) {
          // Partial messages already streamed this text; only add it if streaming missed it.
          const exists = chat.some((c) => c.kind === 'assistant' && c.id.startsWith(`${m.message.id}:`) && c.text.trim() === b.text.trim())
          if (!exists) push({ kind: 'assistant', id: `${m.message.id}:${randomUUID().slice(0, 4)}`, ts: Date.now(), text: b.text })
        }
      }
      break
    case 'user':
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (b.type !== 'tool_result') continue
        const item = chat.find((c) => c.kind === 'tool' && c.id === b.tool_use_id)
        if (item && item.kind === 'tool') {
          item.status = b.is_error ? 'error' : 'ok'
          const text = Array.isArray(b.content) ? b.content.map((x: any) => x.text ?? '').join(' ') : String(b.content ?? '')
          item.result = text.slice(0, 400)
        }
      }
      setState('thinking')
      break
    case 'result': {
      const cost = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0
      lastTurn = {
        costUsd: Math.max(0, cost - lastCumulativeCost),
        outputTokens: m.usage?.output_tokens ?? 0,
        durationMs: m.duration_ms ?? Date.now() - turnStartedAt
      }
      lastCumulativeCost = cost
      for (const c of chat) if (c.kind === 'assistant' && c.streaming) c.streaming = false
      if (m.is_error) note(`Turn ended with an error: ${(m.errors ?? [m.subtype]).join('; ')}`, 'error')
      finishTurn(!!m.is_error)
      setState('idle')
      pump(PUMP_AFTER_TURN_MS)
      break
    }
  }
}

// ---------- slash commands (#71) ----------
// Corvid's session lists its commands in its `initialize` reply. Kept in memory and in assistant/commands.json, so the
// popup has the last session's list while Corvid isn't running. Built-ins not checked to work here are kept too, only to
// answer "not available in this chat" instead of sending them.

type StoredCommand = SlashCommand & { available: boolean }
let sessionCommands: { all: StoredCommand[]; at: number; live: boolean } | null = null

function gotCommands(raw: any[]): void {
  const userSkills = join(homedir(), '.claude', 'skills')
  const all: StoredCommand[] = raw
    .filter((c) => typeof c?.name === 'string' && c.name && !c.name.startsWith('_'))
    .map((c) => {
      const synced = typeof c.description === 'string' && c.description.includes('(claude.ai sync)')
      const source: SlashCommand['source'] = c.builtin ? 'builtin' : synced || existsSync(join(userSkills, c.name)) ? 'skill' : 'custom'
      return {
        name: c.name,
        ...(c.description ? { description: String(c.description).replace(/\s*\(claude\.ai sync\)\s*$/, '') } : {}),
        ...(c.argumentHint ? { argumentHint: String(c.argumentHint) } : {}),
        ...(Array.isArray(c.aliases) && c.aliases.length ? { aliases: c.aliases.map(String) } : {}),
        source,
        // the user's own commands and skills are theirs to run; Claude's built-ins only when checked to work headless
        available: source !== 'builtin' || HEADLESS_BUILTINS.has(c.name)
      }
    })
  sessionCommands = { all, at: Date.now(), live: true }
  try {
    writeFileSync(join(assistantDir(), 'commands.json'), JSON.stringify({ at: sessionCommands.at, commands: all }))
  } catch {
    /* the list comes back on the next start */
  }
  changed()
}

/** What the popup offers: the dashboard's commands, then the session's that work here (the dashboard's names win). */
export function commandList(): CommandList {
  const claude = sessionCommands ? sessionCommands.all.filter((c) => c.available).map(({ available: _a, ...c }) => c) : FALLBACK_COMMANDS
  const shadowed = (c: SlashCommand): boolean => [c.name, ...(c.aliases ?? [])].some((n) => findCommand(n, DASHBOARD_COMMANDS))
  return {
    // extension commands (#102) last: their socket refuses a name the core already uses
    commands: [...DASHBOARD_COMMANDS, ...claude.filter((c) => !shadowed(c)), ...extensionCommands().map(({ owner: _o, ...c }): SlashCommand => ({ ...c, source: 'extension' }))],
    from: !sessionCommands ? 'fallback' : sessionCommands.live && proc ? 'session' : 'cache',
    ...(sessionCommands ? { at: sessionCommands.at } : {})
  }
}

/** A command Corvid's session has but that doesn't work in this chat, if `name` is one. */
export function unavailableCommand(name: string): SlashCommand | undefined {
  const c = sessionCommands ? findCommand(name, sessionCommands.all) : undefined
  return c && !(c as StoredCommand).available ? c : undefined
}

/** Show `item` in the chat and hand `content` to Claude as the user's next message. False when Corvid couldn't start. */
async function deliver(item: Extract<ChatItem, { kind: 'user' }>, content: string): Promise<boolean> {
  push(item)
  if (!proc && !(await start())) return false
  turnStartedAt = Date.now()
  setState('thinking')
  proc!.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
  return true
}

// ---------- the user's board messages to Corvid ----------
// The user's own board messages addressed to Corvid (@corvid, or untagged, #69) come here, only from the board's
// message box (see index.ts). Each is the user speaking to Corvid: the same process, mode, tools and approvals. The chat
// shows the user's words marked as from the board; Claude gets them with a little board context. Several that arrive
// while Corvid is busy go over together as one turn, in order. When the turn ends, its last words are posted on the
// board as Corvid's reply to the last of them.

/** At most this many turns for board messages per rolling hour, so a bug can never loop Corvid. */
export const BOARD_ASKS_PER_HOUR = 30
/** At most this many waiting messages go over in one turn; the rest wait for the next. */
const BATCH_MAX = 8
/** After a turn, wait this long before the next board message: the user's next board message waits its turn. */
const PUMP_AFTER_TURN_MS = 1000

let asks: BoardAsk[] = []
/** A message with `command` set (a slash command, #71) is sent as typed and is always a turn of its own: never merged. */
let queue: BoardMessage[] = []
/** `restricted`: an agent's ping started it (#195), so gateTools refuses every tool outside CORVID_PING_TOOLS until it ends */
let turn: { ids: number[]; item: string; command?: string; restricted?: boolean } | null = null

/** Is the turn in progress one an agent's ping started (#195)? Corvid's tool gate asks this on every call. */
export const restrictedTurn = (): boolean => !!turn?.restricted

/** The agent-ping switch went off (#195): agents' pings still queued for Corvid go. */
export function dropAgentAsks(): void {
  const gone = queue.filter((m) => m.author === 'agent')
  queue = queue.filter((m) => m.author !== 'agent')
  gone.forEach((m) => dropAsk(m.id))
}
let askTimes: number[] = []
let pumpTimer: NodeJS.Timeout | null = null
let boardHooks: {
  /** what Claude gets for these messages: their words with a little board context */
  prompt: (msgs: BoardMessage[]) => string
  reply: (id: number, text: string, actions: BoardAction[]) => void
  seen: (id: number) => void
  /** a quiet dashboard notice, under the message `replyTo` when given */
  notice: (text: string, replyTo?: number) => void
} = {
  prompt: (msgs) => msgs.map((m) => m.text).join('\n\n'),
  reply: () => {},
  seen: () => {},
  notice: () => {}
}

export function setBoardHooks(h: typeof boardHooks): void {
  boardHooks = h
}

const busy = (): boolean => state === 'thinking' || state === 'tool' || state === 'starting'

function setAsk(id: number, status: BoardAsk['status'], error?: string): void {
  asks = [...asks.filter((a) => a.id !== id), { id, status, ...(error ? { error } : {}) }]
  changed()
}
function dropAsk(id: number): void {
  asks = asks.filter((a) => a.id !== id)
  changed()
}

/** Queue one of the user's board messages to Corvid. One that runs a slash command (`command`, set only by the board's
 *  own box) goes as typed, so the command comes first in the prompt, with no board framing. */
export function askFromBoard(msg: BoardMessage): void {
  if (turn?.ids.includes(msg.id) || queue.some((q) => q.id === msg.id)) return
  const now = Date.now()
  askTimes = askTimes.filter((t) => t > now - 3600_000)
  if (askTimes.length >= BOARD_ASKS_PER_HOUR) {
    setAsk(msg.id, 'failed', `Corvid has answered ${BOARD_ASKS_PER_HOUR} times on the board in the last hour, the most it takes. Try again later.`)
    return
  }
  queue.push(msg)
  // "queued" only when it really waits: behind a turn in progress or another board message
  setAsk(msg.id, turn || busy() || queue.length > 1 ? 'queued' : 'replying')
  pump()
}

function pump(delay = 0): void {
  if (pumpTimer) clearTimeout(pumpTimer)
  pumpTimer = setTimeout(() => {
    pumpTimer = null
    void next()
  }, delay)
}

async function next(): Promise<void> {
  if (turn || busy() || !queue.length) return
  // a command goes alone and in order; a batch of plain messages stops before the next command. An agent's ping (#195)
  // goes alone too, as its own restricted turn, so a ping never shares a turn with the user's words.
  const first = queue[0].command || queue[0].author === 'agent' ? 1 : queue.findIndex((m) => m.command || m.author === 'agent')
  const msgs = queue.splice(0, Math.min(BATCH_MAX, first > 0 ? first : queue.length)).sort((a, b) => a.id - b.id)
  const item = randomUUID()
  const last = msgs[msgs.length - 1]
  const command = msgs.length === 1 ? last.command : undefined
  const restricted = last.author !== 'user'
  turn = { ids: msgs.map((m) => m.id), item, ...(command ? { command } : {}), ...(restricted ? { restricted } : {}) }
  askTimes.push(Date.now())
  for (const m of msgs) {
    setAsk(m.id, 'replying')
    boardHooks.seen(m.id)
  }
  // an agent's ping shows in Corvid's chat as from that agent, not as the user's words
  const shown = restricted ? `[Ping from ${last.agentName ?? 'an agent'}${last.taskId !== undefined ? ` on #${last.taskId}` : ''}] ${last.text}` : msgs.map((m) => m.text).join('\n\n')
  if (!(await deliver({ kind: 'user', id: item, ts: Date.now(), text: shown, board: last.id }, command ? last.text : boardHooks.prompt(msgs)))) {
    failTurn(`Corvid could not start${lastError ? `: ${lastError}` : '.'}`)
    // the rest get their own try, and their own error if it fails again
    pump()
  }
}

/** The board turn ended without an answer: keep the messages, say why on them. */
function failTurn(why: string): void {
  if (!turn) return
  for (const id of turn.ids) setAsk(id, 'failed', why)
  turn = null
}

/** A turn ended: if it was for board messages, post its last words on the board under the last one and mark them in the chat. */
function finishTurn(isError: boolean): void {
  if (!turn) return
  const t = turn
  if (isError) return failTurn(`The turn ended with an error${lastError ? `: ${lastError}` : '.'}`)
  turn = null
  const replyTo = t.ids[t.ids.length - 1]
  const done = (): void => t.ids.forEach(dropAsk)
  const at = chat.findIndex((c) => c.id === t.item)
  let after = at >= 0 ? chat.slice(at + 1) : []
  // another message delivered meanwhile starts its own answer
  const cut = after.findIndex((c) => c.kind === 'user')
  if (cut >= 0) after = after.slice(0, cut)
  // Corvid answered on the board itself: nothing more to post
  if (after.some((c) => c.kind === 'tool' && c.name === 'post_message')) return done()
  // the quiet "what I did" line under the reply: real actions only, not look-ups
  const actions: BoardAction[] = after
    .filter((c): c is Extract<ChatItem, { kind: 'tool' }> => c.kind === 'tool' && !quietTool(c.name))
    .map((c) => ({ label: toolLabel(c.name, c.input, c.result), ok: c.status !== 'error' }))
  const lastTool = after.map((c) => c.kind).lastIndexOf('tool')
  const said = after.slice(lastTool + 1).filter((c): c is Extract<ChatItem, { kind: 'assistant' }> => c.kind === 'assistant' && !!c.text.trim())
  const text = said.map((c) => c.text.trim()).join('\n\n')
  // a command with nothing to say (a successful /compact): a quiet notice, not an empty reply
  if (t.command && !text && !actions.length) {
    done()
    return boardHooks.notice(t.command === 'compact' ? 'Conversation compacted.' : `Corvid ran /${t.command}.`, replyTo)
  }
  // an untagged message that was plainly for someone else: Corvid stays out of it, and says so quietly on the message
  if (!t.command && text.replace(/[\s.*`]/g, '') === NO_REPLY && !actions.length) {
    for (const id of t.ids) setAsk(id, 'skipped')
    return
  }
  for (const c of said) c.board = replyTo
  done()
  boardHooks.reply(replyTo, t.command ? plainOutput(text) : text, actions)
}

/** A command's output as board text: Markdown headings and bold marks dropped, the rest as it came. */
function plainOutput(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/ {2,}$/gm, '')
    .trim()
}

/** Stopping (or clearing) Corvid stops its board messages too: each keeps an error, with a Retry on the board. */
function stopAsks(why: string): void {
  failTurn(why)
  for (const q of queue) setAsk(q.id, 'failed', why)
  queue = []
}

/** Stop the current turn. The process is restarted (resuming the conversation) on the next message. False when there was none. */
export function interrupt(): boolean {
  if (!proc) return false
  const p = proc
  proc = null
  p.kill()
  for (const c of chat) if (c.kind === 'tool' && c.status === 'running') c.status = 'error'
  for (const c of chat) if (c.kind === 'assistant' && c.streaming) c.streaming = false
  stopAsks('Stopped before Corvid answered.')
  note('Stopped.', 'info')
  setState('offline')
  return true
}

/** Clear the chat: the visible items, chat.json, and the session the assistant resumes from. */
export function reset(): void {
  interrupt()
  stopAsks("Corvid's chat was cleared before it answered.")
  chat = []
  streamItem = null
  lastTurn = undefined
  resumeFailed = false
  setConfig({ assistantSessionId: undefined })
  setState('offline')
  // write now rather than on the debounce, so a quick quit can't bring the old chat back
  saveChat()
}

/** Restart so model/mode/personality/limit changes reach the system prompt. */
export function reload(): void {
  if (!proc) return
  const p = proc
  proc = null
  p.kill()
  setState('offline')
}

export function shutdown(): void {
  proc?.kill()
  proc = null
  if (saveTimer) saveChat()
}
