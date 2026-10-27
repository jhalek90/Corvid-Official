import type { PingMark } from './agentPings'
import type { DiscussionMark } from './discussion'
// The message board in the Agents view: a small local chat between the user, the assistant and agents.
// The assistant shows as "Corvid"; its stored author and address stay 'assistant', so old messages keep working.

import type { CrowLook } from './types'
import { hasUserName, userLabel } from './userName'

/** 'corvid' is the app itself, saying what happened to an agent it stopped (taskId and agentName are that agent's).
 *  It shows as a "Dashboard notice", never as Corvid the assistant, which is 'assistant'. */
export type BoardAuthor = 'user' | 'assistant' | 'agent' | 'corvid'

export interface BoardMessage {
  /** increasing, never reused while the app runs; tools show it as "m42" */
  id: number
  ts: number
  /** 'user' only ever comes from the app's own message box, never from the MCP tools */
  author: BoardAuthor
  /** the agent's goofy name, when an agent posted it */
  agentName?: string
  /** the task the agent works on */
  taskId?: number
  /** the posting agent's crow, from its connection when it posted, so it stays after the worker ends */
  avatar?: CrowLook
  text: string
  replyTo?: number
  /** who it's addressed to: 'user', 'assistant' (Corvid), or an agent's name */
  to?: string[]
  /** on the user's own messages with no recognised @mention: `to` was filled in for them (#69). untagged: to Corvid;
   *  reply: a reply to an agent's message, to that agent. The text stays as typed. */
  via?: Via
  /** an agent or the assistant asking the user something */
  question?: boolean
  /** an agent's final "done" post for its task (#70): the dashboard may close it once it's quiet */
  done?: boolean
  /** set once the user saved it as a note; the note is a copy that doesn't expire */
  noteId?: string
  /** who of `to` has had it back from read_messages ('assistant' or an agent's name), for the board's "seen" mark */
  seen?: string[]
  /** on the user's own messages: what happened to each mentioned agent that wasn't running when it was posted, keyed as in `to` */
  wake?: Record<string, Wake>
  /** on Corvid's reply to an @corvid message: what it did that turn, for the quiet "what I did" line */
  actions?: BoardAction[]
  /** on the user's own message that ran a slash command (#71): the command's name as typed, which starts the text.
   *  Set only by the board's message box (index.ts), never by the board tools, so no agent can run one. */
  command?: string
  /** the channel it belongs to (#145): a project id (projects.json), from the agent's task, the task a notice is about,
   *  or the channel the user wrote in. Unset (every message from before channels, chat with Corvid, app-wide notices)
   *  is General. Channels only filter the one board: All shows every message, in order. */
  project?: string
  /** files the user attached in the board's message box (#147), copied into board/attachments/m<id>/ in the data folder. Only the
   *  user's own messages have them: the board tools can't attach anything. */
  attachments?: BoardAttachment[]
  /** on an agent's message (#195): what its ping did to each agent ('assistant' for Corvid) it mentioned, for the board's
   *  ping and wake tags. Set only by main's agent-ping code, never by the board tools' callers. */
  ping?: Record<string, PingMark>
  /** on a /discuss message (#200): the header (a notice with the Stop button and progress), a panelist's post, or
   *  Corvid's summary. Set only by main's discussion code, never by the board tools. */
  discussion?: DiscussionMark
}

/** One attached file (#147): stored as `name` (already made safe) in the message's own folder. */
export interface BoardAttachment {
  name: string
  size: number
  /** image: shown as a thumbnail and handed to readers as an image; text: readable as text; file: by name and size only */
  kind: AttachmentKind
}

export type AttachmentKind = 'image' | 'text' | 'file'

export const MAX_ATTACH_FILE = 20 * 1024 * 1024
export const MAX_ATTACH_TOTAL = 50 * 1024 * 1024
export const MAX_ATTACH_COUNT = 10

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
const TEXT_EXT = new Set([
  'txt', 'md', 'log', 'json', 'jsonl', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'html', 'htm', 'css', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'ps1', 'bat', 'sql', 'diff', 'patch', 'svg', 'gd', 'lua'
])
/** Windows shortcuts point somewhere else; attaching one would attach nothing useful, so they're refused. */
const SHORTCUT_EXT = new Set(['lnk', 'url', 'pif'])

export const extOf = (name: string): string => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
export const attachmentKind = (name: string): AttachmentKind => (IMAGE_EXT.has(extOf(name)) ? 'image' : TEXT_EXT.has(extOf(name)) ? 'text' : 'file')
export const isShortcut = (name: string): boolean => SHORTCUT_EXT.has(extOf(name))

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
const MAX_NAME = 100

/** A file name that is safe to store: the last path part only, no characters Windows refuses, no reserved device name,
 *  no leading or trailing dots and spaces, at most 100 characters with the extension kept. Never empty. */
export function safeAttachmentName(raw: string): string {
  let n = String(raw ?? '').split(/[\\/]/).pop() ?? ''
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '')
  const dot = n.lastIndexOf('.')
  let stem = dot > 0 ? n.slice(0, dot) : n
  let ext = dot > 0 ? n.slice(dot) : ''
  if (ext.length > 16) ext = ''
  if (!stem) stem = 'file'
  if (RESERVED.test(stem)) stem = `_${stem}`
  if (stem.length + ext.length > MAX_NAME) stem = stem.slice(0, MAX_NAME - ext.length).replace(/[\s.]+$/, '') || 'file'
  return stem + ext
}

/** `name` made unique among `taken` (compared without case, as Windows does): "shot.png", "shot (2).png", … */
export function uniqueName(name: string, taken: string[]): string {
  const has = (n: string): boolean => taken.some((t) => t.toLowerCase() === n.toLowerCase())
  if (!has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) if (!has(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** What a set of files breaks of the limits, as one sentence the user sees, or '' when they fit. */
export function attachProblem(files: { name: string; size: number }[], what = 'one message'): string {
  if (files.length > MAX_ATTACH_COUNT) return `At most ${MAX_ATTACH_COUNT} files go with ${what}.`
  const big = files.find((f) => f.size > MAX_ATTACH_FILE)
  if (big) return `${big.name} is ${formatBytes(big.size)}; each file can be at most ${formatBytes(MAX_ATTACH_FILE)}.`
  const lnk = files.find((f) => isShortcut(f.name))
  if (lnk) return `${lnk.name} is a shortcut to another file; attach the file itself.`
  const total = files.reduce((s, f) => s + f.size, 0)
  if (total > MAX_ATTACH_TOTAL) return `These files come to ${formatBytes(total)}; ${what} can carry at most ${formatBytes(MAX_ATTACH_TOTAL)}.`
  return ''
}

/** A stored list as read back from disk: names already safe, sizes numbers, kinds known (a hand edit is dropped, not trusted). */
export const validAttachments = (a: unknown): a is BoardAttachment[] =>
  Array.isArray(a) &&
  a.every((x: any) => !!x && typeof x.name === 'string' && x.name === safeAttachmentName(x.name) && Number.isFinite(x.size) && ['image', 'text', 'file'].includes(x.kind))

/** "shot.png (image, 120 KB), notes.txt (text, 3 KB)", for tools, notes and copies. */
export const attachmentList = (list: BoardAttachment[]): string => list.map((a, i) => `${i + 1}. ${a.name} (${a.kind}, ${formatBytes(a.size)})`).join(', ')

export type Via = 'untagged' | 'reply'

/** One thing Corvid did while answering, such as "Created task “Fix login”"; ok false when the tool failed. */
export interface BoardAction {
  label: string
  ok: boolean
}

/**
 * Bringing back an ended agent the user mentioned (#62). ask: waits for the user's Resume (Ask first, or the hourly cap);
 * off: the setting is off; full: no free slot, the user can choose to wait; queued: waiting for a slot; resuming: starting;
 * back: it was started again; blocked: it can't be, with the reason.
 * Waking a running agent (#80). busy: held until its turn ends; prompt: held until the user answers its prompt;
 * delivered: typed into its terminal; capped: its hourly cap was reached, so it waits for its next check; later: the
 * setting is off or @all found it busy, so it waits for its next check; failed: it couldn't be delivered, with the reason.
 */
export type WakeStatus = 'ask' | 'off' | 'full' | 'queued' | 'resuming' | 'back' | 'blocked' | 'busy' | 'prompt' | 'delivered' | 'capped' | 'later' | 'failed'

export interface Wake {
  status: WakeStatus
  at: number
  /** the task of the agent it is about, once known */
  taskId?: number
  reason?: string
}

/** At most this many automatic resumes in any hour; past it, mentions fall back to Ask first for the rest of the hour. */
export const AUTO_RESUMES_PER_HOUR = 6

/** At most this many wake-ups of one running agent in any hour (#80); past it, mentions wait for its next check. */
export const INVOKES_PER_HOUR = 6

export const WAKE_STATUSES: WakeStatus[] = ['ask', 'off', 'full', 'queued', 'resuming', 'back', 'blocked', 'busy', 'prompt', 'delivered', 'capped', 'later', 'failed']

export interface BoardSnapshot {
  messages: BoardMessage[]
  /** messages up to this id have been seen in the board */
  seenUpTo: number
  keepDays: number
  /** per channel (#145): messages up to this id were seen in that channel; reading All (seenUpTo) counts for every one */
  channelSeen?: Record<string, number>
}

/** The board's channels (#145): All shows everything, General what belongs to no project; any other key is a project id. */
export const ALL_CHANNEL = 'all'
export const GENERAL_CHANNEL = 'general'

/** The channel a message is in: its project, or General. */
export const channelOf = (m: BoardMessage): string => m.project ?? GENERAL_CHANNEL

/** Whether a message shows in a channel; All shows every one. */
export const inChannel = (m: BoardMessage, channel: string): boolean => channel === ALL_CHANNEL || channelOf(m) === channel

/** How far a message's channel has been read: All's mark counts for every channel. */
const seenFor = (b: BoardSnapshot, m: BoardMessage): number => Math.max(b.seenUpTo, b.channelSeen?.[channelOf(m)] ?? 0)

export const MAX_MESSAGE_CHARS = 2000
export const KEEP_DAYS_MIN = 7
export const KEEP_DAYS_MAX = 30
export const KEEP_DAYS_DEFAULT = 14

export const clampKeepDays = (n: number | undefined): number =>
  Math.max(KEEP_DAYS_MIN, Math.min(KEEP_DAYS_MAX, Math.round(Number(n) || KEEP_DAYS_DEFAULT)))

export const messageRef = (id: number): string => `m${id}`

/** The assistant's name wherever the user or an agent sees it. */
export const ASSISTANT_NAME = 'Corvid'
/** How the app's own notices (author 'corvid') are labelled, so they are never taken for the assistant. */
export const NOTICE_LABEL = 'Dashboard notice'

/** How the board names an author. `me` is the user's name from Settings ("You" until one is set); old messages show the current one. */
export const boardAuthor = (m: BoardMessage, me?: string): string =>
  m.author === 'user' ? (hasUserName(me) ? userLabel(me) : 'You') : m.author === 'assistant' ? ASSISTANT_NAME : m.author === 'corvid' ? NOTICE_LABEL : (m.agentName ?? `Worker for #${m.taskId}`)

/** How an address shows: 'assistant' as Corvid, 'user' as the user's name (`me`, "user" by default), the rest as stored. */
export const addressLabel = (t: string, me?: string): string => (t === 'assistant' ? ASSISTANT_NAME : t === 'user' ? userLabel(me) : t)

/** Names compare without case, spaces, hyphens or underscores, so @Senior-Pixel-Plumber finds "Senior Pixel Plumber". */
export const nameKey = (s: string): string => s.toLowerCase().replace(/^@/, '').replace(/[\s_\-'".]+/g, '')

export interface Mention {
  start: number
  end: number
  /** 'user', 'assistant' (Corvid), ALL, or the agent's name */
  target: string
}

/** The target of @all: every running agent, and only when the user writes it (postAsUser expands it). */
export const ALL = '*all'

/**
 * Who a mention can name: the live agents (workers and named terminals) first, then every agent that posted or was
 * addressed in a message still on the board, newest first. Main's board tools and the board's view both use this, so a
 * name the composer offers is the name main addresses, and a running agent wins its task number over an ended one.
 */
export function mentionables(
  live: { name: string; taskId?: number }[],
  messages: BoardMessage[],
  /** agents known to have ended (workers still listed), before the ones only the messages know */
  ended: { name: string; taskId?: number }[] = []
): { name: string; taskId?: number; live: boolean }[] {
  const out = new Map<string, { name: string; taskId?: number; live: boolean }>()
  const add = (name: string | undefined, taskId: number | undefined, isLive: boolean): void => {
    const k = name ? nameKey(name) : ''
    if (!k || k === 'user' || k === 'assistant' || k === 'corvid' || k === 'all' || out.has(k)) return
    out.set(k, { name: name!, taskId, live: isLive })
  }
  for (const a of live) add(a.name, a.taskId, true)
  for (const a of ended) add(a.name, a.taskId, false)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.author === 'agent') add(m.agentName, m.taskId, false)
    for (const t of m.to ?? []) add(t, undefined, false)
  }
  return [...out.values()]
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The @mentions in a message: @user (or @you), @corvid (or the older @assistant), @#12 for the agent on task 12, and an
 * agent's name with spaces, hyphens, underscores or nothing between its words (@Senior-Pixel-Plumber), and @all.
 * `me`, the user's name from Settings, addresses the user too; @user always does.
 * The board's composer inserts a mention as "@" plus the whole name, which this reads back exactly: the names come from
 * `mentionables`, the longest wins, and the name must end at a word boundary.
 * Unknown @words are left alone, so an email address never addresses anyone.
 */
export function findMentions(text: string, agents: { name: string; taskId?: number }[], me?: string): Mention[] {
  const out: Mention[] = []
  // longest names first, so "Senior Pixel Plumber" wins over a "Pixel" that might also exist
  const named = [...agents.map((a) => ({ name: a.name, target: a.name })), ...(hasUserName(me) ? [{ name: userLabel(me), target: 'user' }] : [])]
    .filter((a) => a.name.trim())
    .sort((a, b) => b.name.length - a.name.length)
    .map((a) => ({ target: a.target, re: new RegExp(`^${a.name.trim().split(/[\s_-]+/).map(escapeRe).join('[\\s_-]*')}(?![\\w])`, 'i') }))
  const re = /(^|[^\w@])@/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const at = m.index + m[1].length
    const rest = text.slice(at + 1)
    let hit: { len: number; target: string } | undefined
    const word = /^(user|you|corvid|assistant|all)(?![\w])/i.exec(rest)
    if (word) hit = { len: word[0].length, target: /^(corvid|assistant)$/i.test(word[1]) ? 'assistant' : /^all$/i.test(word[1]) ? ALL : 'user' }
    const task = !hit && /^#(\d+)(?!\d)/.exec(rest)
    if (task) {
      const a = agents.find((x) => x.taskId === Number(task[1]))
      if (a) hit = { len: task[0].length, target: a.name }
    }
    if (!hit)
      for (const n of named) {
        const k = n.re.exec(rest)
        if (k) {
          hit = { len: k[0].length, target: n.target }
          break
        }
      }
    if (hit) {
      out.push({ start: at, end: at + 1 + hit.len, target: hit.target })
      re.lastIndex = at + 1 + hit.len
    }
  }
  return out
}

/**
 * Who one of the user's own messages is for (#69). Any recognised mention decides (an agent, @all, @corvid, or the
 * user's own name, which wakes no one). With none, a reply to an agent's message goes to that agent, and anything else
 * goes to Corvid, unless the composer is on Board only. An unknown @word isn't a mention, so it counts as untagged.
 * `on` is the "Untagged messages go to Corvid" setting; off, neither rule applies: the old behaviour.
 */
export function addressUserMessage(
  text: string,
  agents: { name: string; taskId?: number; live?: boolean }[],
  me: string | undefined,
  opts: { replyTo?: BoardMessage; on: boolean; boardOnly?: boolean }
): { to: string[]; via?: Via } {
  const mentions = findMentions(text, agents, me)
  if (mentions.length) return { to: [...new Set(mentions.flatMap((m) => (m.target === ALL ? agents.filter((a) => a.live).map((a) => a.name) : [m.target])))] }
  if (!opts.on) return { to: [] }
  const p = opts.replyTo
  if (p?.author === 'agent' && p.agentName) return { to: [p.agentName], via: 'reply' }
  return opts.boardOnly ? { to: [] } : { to: ['assistant'], via: 'untagged' }
}

/** The @ the caret is in, if any: at the start or after a space or punctuation (never inside a word or an email
 *  address, the same rule findMentions uses), with no line break between it and the caret. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && /[\w@]/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (query.length > 48 || /[\n@]/.test(query) || /^\s/.test(query)) return null
  return { start: at, query }
}

/** Addressed to the user, by the field or an @user / @you in the text. */
export const forUser = (m: BoardMessage): boolean => !!m.to?.includes('user')

/** Unread for the user: posted by someone else after what the board last showed. */
export const unreadFor = (b: BoardSnapshot, channel: string = ALL_CHANNEL): BoardMessage[] =>
  b.messages.filter((m) => m.id > seenFor(b, m) && m.author !== 'user' && inChannel(m, channel))

/** Where the board's "New" line goes in a channel: what that channel had been read up to. */
export const seenUpToIn = (b: BoardSnapshot, channel: string): number =>
  channel === ALL_CHANNEL ? b.seenUpTo : Math.max(b.seenUpTo, b.channelSeen?.[channel] ?? 0)

/** Something that must not get lost in a channel the user isn't looking at (#145): unread and addressed to the user,
 *  which every question for the user is. */
export const needsUser = (b: BoardSnapshot, m: BoardMessage): boolean => m.author !== 'user' && forUser(m) && m.id > seenFor(b, m)
