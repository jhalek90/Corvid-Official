import type { AppConfig, AssistantMode, AssistantModel, UsageQuota } from '@shared/types'
import type { BoardMessage } from '@shared/board'
import { commandLabel, leadingCommand, parseCommand, type CommandList, type SlashCommand } from '@shared/slashCommands'
import { cutText } from '@shared/text'
import { ALL_CHANNEL } from '@shared/board'
import { parseDiscuss } from '@shared/discussion'
import { choiceLabel, MODEL_CHOICES } from '@shared/models'
import { assistantModelProblem, customModelRef, isCustomModelRef, type CustomModelRef } from '@shared/customModels'

// Slash commands from the board's message box (#71). Only index.ts's board:post handler calls this, for the text the
// user typed in the app's own window: the board tools never do, so a message an agent or a tool posts that starts with
// "/" stays plain text and runs nothing.

export interface CommandDeps {
  list: () => CommandList
  /** a built-in Corvid's session has that doesn't work in this chat */
  unavailable: (name: string) => SlashCommand | undefined
  /** `channel`: the board channel it was typed in (#145); the notices under it follow it there */
  post: (text: string, replyTo: number | undefined, command: string, channel?: string) => BoardMessage
  /** a quiet dashboard notice under the user's message */
  notice: (text: string, replyTo: number) => void
  /** an extension's command (#102): its answer, or null when no extension has that name */
  runExtension: (name: string, args: string) => Promise<string | null>
  /** a Claude command for Corvid's session, sent as typed in a turn of its own */
  ask: (m: BoardMessage, command: string) => void
  config: () => AppConfig
  /** the settings change as from Settings: switching to Fable asks in Corvid's window first (#127) */
  setConfig: (patch: Partial<AppConfig>) => Promise<AppConfig>
  reset: () => void
  interrupt: () => boolean
  quota: () => UsageQuota | null
  liveQuota: () => { fiveHour: number; week: number; at: number } | undefined
  /** /discuss (#200): starts the panel (after the confirmation dialog) and answers with the notice to show */
  discuss: (o: { agents: number; turns: number; topic: string; channel: string; replyTo?: number; origin: 'window' }) => Promise<string>
  discussStop: () => string
}

/**
 * Handle `text` if it's a command; null when it's a normal message (the caller posts it as usual). `origin` says where the
 * text came from: only 'window' (the board's message box) may run commands, and that is asserted here, so an agent's
 * post, a ping, a tool, an extension or a socket can never reach a command whatever it sends.
 */
export function runCommand(text: string, replyTo: number | undefined, d: CommandDeps, channel?: string, origin: 'window' | string = 'window'): BoardMessage | null {
  if (origin !== 'window') throw new Error('Slash commands run only from the board’s message box.')
  const typed = text.trim()
  const hit = parseCommand(typed, d.list().commands)
  const name = leadingCommand(typed)
  const off = !hit && name ? d.unavailable(name) : undefined
  if (!hit && !off) return null
  const m = d.post(text, replyTo, hit?.cmd.name ?? off!.name, channel)
  if (off) {
    d.notice(`/${off.name} isn't available in this chat: Corvid runs headless with read-only tools. Run it in a Claude Code terminal instead.`, m.id)
  } else if (hit!.cmd.source === 'dashboard') {
    void Promise.resolve(dashboard(hit!.cmd.name, hit!.args, d, { replyTo, channel: channel ?? ALL_CHANNEL })).then((text) => d.notice(text, m.id))
  } else if (hit!.cmd.source === 'extension') {
    void d.runExtension(hit!.cmd.name, hit!.args).then((text) => d.notice(text ?? `/${hit!.cmd.name} is no longer available.`, m.id))
  } else d.ask(m, hit!.cmd.name)
  return m
}

const MODES: Record<string, AssistantMode> = { ask: 'ask', plan: 'ask', auto: 'auto' }
const modeLabel = (m: AssistantMode): string => (m === 'ask' ? 'Plan & ask' : 'Auto')

function dashboard(name: string, args: string, d: CommandDeps, where: { replyTo?: number; channel: string }): string | Promise<string> {
  const arg = args.split(/\s+/)[0]?.toLowerCase() ?? ''
  switch (name) {
    case 'discuss': {
      const p = parseDiscuss(args)
      if (p.kind === 'error') return p.error
      if (p.kind === 'stop') return d.discussStop()
      // All has no project: the panel gets no file access there, same as General
      const channel = where.channel === ALL_CHANNEL ? '' : where.channel
      return d.discuss({ agents: p.agents, turns: p.turns, topic: p.topic, channel, replyTo: where.replyTo, origin: 'window' })
    }
    case 'clear':
      d.reset()
      return 'Conversation cleared: Corvid starts a new one with your next message. Board messages stay.'
    case 'stop':
      return d.interrupt() ? "Stopped Corvid's turn." : "Corvid wasn't doing anything, so there was nothing to stop."
    case 'mode': {
      const now = d.config().assistantMode
      if (!arg) return `Corvid's mode is ${modeLabel(now)}. Change it with /mode ask or /mode auto.`
      const next = MODES[arg]
      if (!next) return `There's no "${arg}" mode. Use /mode ask (Plan & ask) or /mode auto.`
      if (next === now) return `Corvid is already in ${modeLabel(now)} mode.`
      void d.setConfig({ assistantMode: next })
      // on a custom model (#320) the mode stays Plan & ask until Corvid is back on a Claude model
      const held = next === 'auto' && isCustomModelRef(d.config().assistantModel) ? ` While Corvid runs on ${choiceLabel(d.config().assistantModel, d.config().models)} it stays ${modeLabel('ask')}: workers need your approval.` : ''
      return `Corvid's mode is now ${modeLabel(next)}.${held}`
    }
    case 'model': {
      const now = d.config().assistantModel
      const own = d.config().models ?? []
      // the user's own models (#316); Corvid itself only on those with a big enough context, experimentally (#320)
      const fits = own.filter((m) => !assistantModelProblem(own, customModelRef(m.id)))
      const yours = own.length
        ? fits.length
          ? ` Or one of your models with a context of 64k or more (experimental, workers need your approval while Corvid runs there): ${fits.map((m) => `/model ${m.id}`).join(', ')}.`
          : ` Your models (${own.map((m) => m.label).join(', ')}) are for workers only: Corvid itself needs one with a context of 64k or more.`
        : ''
      if (!arg) return `Corvid runs on ${choiceLabel(now, own)}. Change it with /model haiku, sonnet, opus or fable.${yours}`
      const mine = own.find((m) => m.id === arg.replace(/^custom:/, '') || m.label.toLowerCase() === arg)
      const next: AssistantModel | CustomModelRef | undefined = MODEL_CHOICES.find((x) => x === arg) ?? (mine && customModelRef(mine.id))
      if (!next) return `/model here takes haiku, sonnet, opus or fable, not "${arg}".${yours}`
      if (next === now) return `Corvid already runs on ${choiceLabel(now, own)}.`
      const why = mine && assistantModelProblem(own, next)
      if (why) return `Corvid can't run on ${mine.label}: ${why}`
      // Fable asks in a dialog in Corvid's window first; Cancel (or a plan without it) keeps the model
      return d.setConfig({ assistantModel: next }).then((c) =>
        c.assistantModel === next
          ? `Corvid now runs on ${choiceLabel(next, own)}${mine ? ' (experimental); it starts a new conversation, and workers need your approval while it runs there.' : '; the conversation carries over.'}`
          : `Corvid stays on ${choiceLabel(c.assistantModel, own)}: ${choiceLabel(next, own)} wasn't confirmed.`
      )
    }
    case 'usage':
      return usage(d)
    case 'help':
    default:
      return help(d.list())
  }
}

function usage(d: CommandDeps): string {
  const q = d.quota()
  const live = d.liveQuota()
  const lines: string[] = []
  if (q && !q.error) {
    if (q.session) lines.push(`${q.session.label}: ${q.session.pct}% used${q.session.resetsAt ? `, resets ${q.session.resetsAt}` : ''}`)
    for (const w of q.weeks) lines.push(`${w.label}: ${w.pct}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ''}`)
    lines.push(`(checked ${new Date(q.fetchedAt).toLocaleTimeString()})`)
  }
  if (live && (!q || q.error || live.at > q.fetchedAt)) lines.push(`Corvid's latest turn saw 5-hour ${live.fiveHour}% and week ${live.week}% (${new Date(live.at).toLocaleTimeString()}).`)
  if (!lines.length) return `The dashboard has no usage figures yet${q?.error ? ` (${q.error})` : ''}. The Usage view can refresh them.`
  return ['Plan usage', ...lines, 'More in the Usage view.'].join('\n')
}

function help(list: CommandList): string {
  const ours = list.commands.filter((c) => c.source === 'dashboard')
  const claude = list.commands.filter((c) => c.source !== 'dashboard')
  const from =
    list.from === 'session'
      ? "From Corvid's session"
      : list.from === 'cache'
        ? "From Corvid's last session (it isn't running now)"
        : "Corvid hasn't started yet, so this is a short built-in list"
  const row = (c: SlashCommand): string => cutText(`${commandLabel(c)}: ${c.description ?? ''}`.replace(/: $/, ''), 90)
  const bySource = (s: SlashCommand['source']): string[] => claude.filter((c) => c.source === s).map((c) => `/${c.name}`)
  const text = [
    'Commands go to Corvid only, typed first in the box.',
    'Dashboard:',
    ...ours.map(row),
    `${from}:`,
    ...claude.filter((c) => c.source === 'builtin').map(row),
    ...(bySource('skill').length ? [`Skills: ${bySource('skill').join(' ')}`] : []),
    ...(bySource('custom').length ? [`Custom commands: ${bySource('custom').join(' ')}`] : []),
    ...(bySource('extension').length ? [`From extensions: ${bySource('extension').join(' ')}`] : [])
  ].join('\n')
  return cutText(text, 1800)
}
