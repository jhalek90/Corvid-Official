// Corvid's "welcome back" on the board (#122): when to greet, and what to say. Pure functions on local facts, so the
// tests can run every case; src/main/welcome.ts gathers the facts and posts. No model is ever called for this.

import type { BoardMessage } from './board'
import type { BoardVoice } from './boardVoice'
import { cleanCustomVoice } from './boardVoice'
import type { AssistantPersonality } from './types'
import { CROW_LINES, PLAIN_LINES, type Away, type TimeOfDay, type WelcomeLine } from './welcomeLines'

export type WelcomeMode = 'off' | 'short' | 'status'
export const WELCOME_MODES: WelcomeMode[] = ['off', 'short', 'status']
export const isWelcomeMode = (v: unknown): v is WelcomeMode => WELCOME_MODES.includes(v as WelcomeMode)

/**
 * How the last run ended, from running.json and last-exit.json (#85):
 * first: a fresh data folder · quit: a clean quit by the user (or Windows logging off) · restart: a clean quit the app
 * made to restart itself · deploy: the marker was left and a deploy or rollback ran since · crash: the marker was left
 * with no deploy, so the app died
 */
export type StartKind = 'first' | 'quit' | 'restart' | 'deploy' | 'crash'

/** welcome.json in the data folder: kept across restarts. */
export interface WelcomeState {
  lastGreetAt?: number
  lastLine?: string
  /** greetings so far, part of the seed */
  count?: number
  /** the one-time "welcome to Corvid" is behind us (or this folder was in use before #122) */
  firstDone?: boolean
  /** the build the last greeting ran on, to tell when the app was updated since */
  commit?: string
}

/** At most one greeting in this long, across restarts. */
export const QUIET_MS = 4 * 3600_000
/** No greeting this soon after a deploy: the deploy agent already posted. */
export const DEPLOY_QUIET_MS = 10 * 60_000
/** Most characters in one greeting line, and in the whole message. */
export const LINE_MAX = 90
export const MESSAGE_MAX = 320

export interface GreetCheck {
  kind: StartKind
  mode: WelcomeMode
  state: WelcomeState
  now: number
  /** when deploy.log last changed */
  deployAt?: number
}

/** Whether this open gets a greeting, and why (for the log). */
export function shouldGreet(c: GreetCheck): { greet: 'first' | 'back' | null; why: string } {
  if (c.mode === 'off') return { greet: null, why: 'the welcome message is off in Settings' }
  if (c.kind === 'first' && !c.state.firstDone) return { greet: 'first', why: 'first run on this data folder' }
  if (c.kind === 'restart') return { greet: null, why: 'Corvid restarted itself' }
  if (c.kind === 'deploy') return { greet: null, why: 'a deploy or rollback restarted Corvid' }
  if (c.kind === 'crash') return { greet: null, why: 'the last run ended unexpectedly' }
  if (c.deployAt && c.now - c.deployAt >= 0 && c.now - c.deployAt < DEPLOY_QUIET_MS) return { greet: null, why: 'a deploy ran a few minutes ago' }
  if (c.state.lastGreetAt && c.now - c.state.lastGreetAt >= 0 && c.now - c.state.lastGreetAt < QUIET_MS) return { greet: null, why: 'greeted within the last 4 hours' }
  return { greet: 'back', why: 'the user opened Corvid after a quit' }
}

export function timeOfDay(d: Date): TimeOfDay {
  const h = d.getHours()
  if (h >= 5 && h < 12) return 'morning'
  if (h >= 12 && h < 17) return 'afternoon'
  if (h >= 17 && h < 22) return 'evening'
  return 'late'
}

const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

/** How long the user was away, from when they last left (`since`) to now. */
export function awayFor(now: Date, since?: number): Away {
  if (!since || since > now.getTime()) return 'short'
  const ms = now.getTime() - since
  if (ms >= 3 * 86400_000) return 'week'
  if (ms >= 20 * 3600_000) return 'day'
  return dayKey(new Date(since)) === dayKey(now) ? 'short' : 'newday'
}

/** A small stable hash, so the pick varies by day and by greeting but is the same for the same inputs. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

const fits = (l: WelcomeLine, t: TimeOfDay, a: Away): boolean => (!l.times || l.times.includes(t)) && (!l.away || l.away.includes(a))

/** One line from the bank for this time and absence: never `last`, seeded by the day and the greeting count. */
export function pickLine(bank: WelcomeLine[], now: Date, away: Away, last?: string, count = 0): WelcomeLine {
  const t = timeOfDay(now)
  let pool = bank.filter((l) => fits(l, t, away))
  if (!pool.length) pool = bank.filter((l) => !l.times && !l.away)
  const fresh = pool.filter((l) => l.id !== last)
  if (fresh.length) pool = fresh
  return pool[hash(`${dayKey(now)}:${count}:${t}:${away}`) % pool.length]
}

/** Fill in the name: "{, name}" is ", Robin" with one and nothing without. */
export const withName = (text: string, name: string): string => text.replace(/\{, name\}/g, name ? `, ${name}` : '')

const EMOJI = /\p{Extended_Pictographic}️?/gu
const noEmoji = (s: string): string => s.replace(EMOJI, '').replace(/\s+$/, '')

// ---------- the status line ----------

export interface WelcomeFacts {
  /** agents whose done post the user hasn't read yet */
  agentsDone: number
  /** tasks whose agent asked the user something unread and unanswered */
  needYou: number[]
  /** tasks in Doing */
  doing: number
  /** connectors and connections waiting for the user's approval */
  approvals: number
  /** the app was updated, or rolled back, since the last greeting */
  build?: 'updated' | 'rolledback'
  /** the 5-hour usage window, in percent, when known */
  fiveHour?: number
}

/** Usage is only worth a mention from here. */
export const HIGH_USAGE = 70

const n = (k: number, one: string, many: string): string => (k === 1 ? `one ${one}` : `${k} ${many}`)
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const joinAnd = (parts: string[]): string => (parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`)

function needsLine(ids: number[]): string {
  if (ids.length === 1) return `#${ids[0]} needs you`
  if (ids.length === 2) return `#${ids[0]} and #${ids[1]} need you`
  return `${ids.length} agents need you`
}

/** One or two short sentences of facts, or '' when there's nothing worth saying. */
export function statusLine(f: WelcomeFacts, terse = false): string {
  const usage = f.fiveHour !== undefined && f.fiveHour >= HIGH_USAGE ? Math.round(f.fiveHour) : undefined
  if (terse) {
    const a = [
      ...(f.agentsDone ? [`${f.agentsDone} agent${f.agentsDone === 1 ? '' : 's'} done`] : []),
      ...(f.needYou.length ? [needsLine(f.needYou)] : []),
      ...(f.doing ? [`${f.doing} in Doing`] : []),
      ...(f.approvals ? [`${f.approvals} approval${f.approvals === 1 ? '' : 's'} waiting`] : []),
      ...(f.build === 'updated' ? ['new build'] : f.build === 'rolledback' ? ['last rebuild rolled back'] : []),
      ...(usage !== undefined ? [`5-hour usage ${usage}%`] : [])
    ]
    return a.length ? `${cap(a.join(', '))}.` : ''
  }
  const first: string[] = []
  if (f.agentsDone) first.push(`${n(f.agentsDone, 'agent', 'agents')} wrapped up while you were away`)
  if (f.needYou.length) first.push(needsLine(f.needYou))
  const second: string[] = []
  if (f.doing) second.push(`${n(f.doing, 'task is', 'tasks are')} in Doing`)
  if (f.approvals) second.push(f.approvals === 1 ? 'one approval is waiting for you' : `${f.approvals} approvals are waiting for you`)
  if (f.build === 'updated') second.push("you're on a new build since last time")
  else if (f.build === 'rolledback') second.push("the last rebuild didn't start, so Corvid rolled back")
  if (usage !== undefined) second.push(`the 5-hour usage is at ${usage}%`)
  return [first.length ? `${cap(first.join(', and '))}.` : '', second.length ? `${cap(joinAnd(second))}.` : ''].filter(Boolean).join(' ')
}

/** What the user hasn't read on the board yet: agents that finished, and agents' questions to them still unanswered. */
export function boardFacts(messages: BoardMessage[], seenUpTo: number): Pick<WelcomeFacts, 'agentsDone' | 'needYou'> {
  const unread = messages.filter((m) => m.id > seenUpTo && m.author === 'agent' && m.taskId !== undefined)
  const done = new Set(unread.filter((m) => m.done).map((m) => m.taskId!))
  // answered: the user replied to it, or wrote to that agent after it
  const answered = (q: BoardMessage): boolean =>
    messages.some((a) => a.author === 'user' && a.id > q.id && (a.replyTo === q.id || (!!q.agentName && !!a.to?.includes(q.agentName))))
  const needYou = [...new Set(unread.filter((m) => m.question && !answered(m)).map((m) => m.taskId!))]
  return { agentsDone: done.size, needYou: needYou.sort((a, b) => a - b) }
}

// ---------- the message ----------

export type WelcomeStyle = 'crow' | 'plain' | 'terse'

/** Which bank to use: the Board voice setting, toned down by a strict personality. A custom voice is plain unless it asks for play. */
export function welcomeStyle(voice: BoardVoice, custom: string | undefined, personality: AssistantPersonality): WelcomeStyle {
  if (voice === 'terse') return 'terse'
  let style: WelcomeStyle = voice === 'plain' ? 'plain' : 'crow'
  if (voice === 'custom') {
    const text = cleanCustomVoice(custom)
    style = !text || /\b(crow|caw|playful|whimsical|funny|jok\w*|banter|silly|emoji)\b/i.test(text) ? 'crow' : 'plain'
  }
  return personality === 'strict' ? 'plain' : style
}

export interface ComposeInput {
  greet: 'first' | 'back'
  mode: WelcomeMode
  style: WelcomeStyle
  /** the user's name from Settings, '' for none */
  name: string
  now: Date
  /** when the user last left */
  since?: number
  state: WelcomeState
  facts: WelcomeFacts
  /** the global hotkey, as Electron writes it ("Control+Alt+Space"), '' for none */
  hotkey: string
  /** macOS: the shortcuts are named with Cmd instead of Ctrl (#156) */
  mac?: boolean
}

const keyLabel = (accel: string, mac = false): string =>
  accel
    .replace(/\bCommandOrControl\b|\bCmdOrCtrl\b/g, mac ? 'Cmd' : 'Ctrl')
    .replace(/\bControl\b/g, 'Ctrl')
    .replace(/\bCommand\b/g, 'Cmd')

/** The one-time welcome for a fresh install: the Agents page, the shortcuts and Settings. */
export function firstRunText(style: WelcomeStyle, name: string, hotkey: string, mac = false): string {
  const show = hotkey ? keyLabel(hotkey, mac) : ''
  const m = mac ? 'Cmd' : 'Ctrl'
  if (style === 'terse')
    return `Welcome to Corvid. Agents page: ${m}+1. Talk to Corvid: ${m}+J.${show ? ` Show Corvid: ${show}.` : ''} Search: ${m}+K. Settings: left rail, ${m}+6.`
  const hello = style === 'crow' ? withName("Welcome to Corvid{, name}! Glad you've landed in the roost 🐦", name) : withName('Welcome to Corvid{, name}.', name)
  const tips =
    `The Agents page (${m}+1) has the message board, where ${m}+J talks to me.${show ? ` ${show} brings Corvid up from anywhere,` : ''} ` +
    `${m}+K finds everything else, and Settings is on the left rail (${m}+6).`
  return `${hello}\n${tips}`
}

/** The whole message, or null when there's nothing to post (a terse voice with no news). */
export function composeWelcome(c: ComposeInput): { text: string; lineId?: string } | null {
  if (c.mode === 'off') return null
  if (c.greet === 'first') return { text: firstRunText(c.style, c.name, c.hotkey, c.mac) }
  const status = c.mode === 'status' ? statusLine(c.facts, c.style === 'terse') : ''
  if (c.style === 'terse') return status ? { text: status } : null
  const away = awayFor(c.now, c.since)
  const line = pickLine(c.style === 'crow' ? CROW_LINES : PLAIN_LINES, c.now, away, c.state.lastLine, c.state.count ?? 0)
  const hello = c.style === 'crow' ? withName(line.text, c.name) : noEmoji(withName(line.text, c.name))
  return { text: status ? `${hello}\n${status}` : hello, lineId: line.id }
}
