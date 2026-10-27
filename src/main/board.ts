import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { BoardAction, BoardAttachment, BoardAuthor, BoardMessage, BoardSnapshot, Via } from '@shared/board'
import { ALL_CHANNEL, attachmentKind, attachProblem, clampKeepDays, MAX_MESSAGE_CHARS, safeAttachmentName, uniqueName, validAttachments, WAKE_STATUSES, type Wake } from '@shared/board'
import type { CrowLook } from '@shared/types'
import { cleanLook } from '@shared/crowParts'
import { charCount } from '@shared/text'
import { PING_MARKS, type PingMark } from '@shared/agentPings'
import type { DiscussionMark } from '@shared/discussion'

// The message board's store: one JSON line per message in <data>\board\messages.jsonl, on this
// machine only. Posting appends a line; anything else (expiry, clearing, the size cap, saving as a
// note) rewrites the file through a temporary file and a rename, so a crash never leaves half a file.
// A line cut short by a crash mid-append is skipped and the file rewritten clean on the next start.
// board.json keeps the next id and how far the user has read, in All and in each channel (#145).

/** Beyond this many messages the oldest go, whatever their age, so the file stays small. */
export const MAX_KEPT = 1000
const DAY = 86400_000

interface Meta {
  nextId: number
  seenUpTo: number
  /** per channel (#145); All's seenUpTo counts for every channel */
  channelSeen: Record<string, number>
}

let dir = ''
let messages: BoardMessage[] = []
let meta: Meta = { nextId: 1, seenUpTo: 0, channelSeen: {} }
let keepDays: () => number = () => 14
let emit: (s: BoardSnapshot) => void = () => {}
/** the project (channel) of a task, for tagging what agents and notices post about it (#145) */
let projectOfTask: (taskId: number) => string | undefined = () => undefined

const file = (): string => join(dir, 'messages.jsonl')
const metaFile = (): string => join(dir, 'board.json')

// Attached files (#147): copies, one folder per message, board\attachments\m<id>\<safe name>. They live in the data
// folder, which agents are denied (#91), so nobody reads them in place: the board tools' read_attachment hands them out.
const attachRoot = (): string => join(dir, 'attachments')
const attachFolder = (id: number): string => join(attachRoot(), `m${id}`)

/** Where a message's attached file is stored, or undefined when it has no such file. */
export function attachmentPath(id: number, index: number): { path: string; att: BoardAttachment } | undefined {
  const att = getMessage(id)?.attachments?.[index]
  return att ? { path: join(attachFolder(id), att.name), att } : undefined
}

function dropAttachments(gone: BoardMessage[]): void {
  for (const m of gone) if (m.attachments?.length) rmSync(attachFolder(m.id), { recursive: true, force: true })
}

/** Folders whose message is gone: a send that failed half way, or a crash before the message was written. */
function sweepAttachments(): void {
  let names: string[] = []
  try {
    names = readdirSync(attachRoot())
  } catch {
    return
  }
  const keep = new Set(messages.filter((m) => m.attachments?.length).map((m) => `m${m.id}`))
  for (const n of names) if (!keep.has(n)) rmSync(join(attachRoot(), n), { recursive: true, force: true })
}

function atomicWrite(path: string, raw: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp`)
  writeFileSync(tmp, raw)
  renameSync(tmp, path)
}

const rewrite = (): void => atomicWrite(file(), messages.map((m) => JSON.stringify(m) + '\n').join(''))
const saveMeta = (): void => atomicWrite(metaFile(), JSON.stringify(meta))

const AUTHORS: BoardAuthor[] = ['user', 'assistant', 'agent', 'corvid']

function valid(m: any): m is BoardMessage {
  return !!m && Number.isInteger(m.id) && typeof m.ts === 'number' && AUTHORS.includes(m.author) && typeof m.text === 'string'
}

const validWake = (w: unknown): boolean =>
  !!w && typeof w === 'object' && Object.values(w).every((x: any) => !!x && WAKE_STATUSES.includes(x.status) && typeof x.at === 'number')

function load(): void {
  let raw = ''
  try {
    raw = readFileSync(file(), 'utf8')
  } catch {
    /* first run */
  }
  let bad = 0
  messages = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line)
      // a hand-edited or damaged avatar is dropped; the board then derives one from the task
      if (valid(m)) {
        if (m.avatar !== undefined) m.avatar = cleanLook(m.avatar)
        if (m.seen !== undefined && !(Array.isArray(m.seen) && m.seen.every((x: unknown) => typeof x === 'string'))) delete m.seen
        if (m.to !== undefined && !(Array.isArray(m.to) && m.to.every((x: unknown) => typeof x === 'string'))) delete m.to
        if (m.wake !== undefined && !validWake(m.wake)) delete m.wake
        if (m.via !== undefined && !(m.author === 'user' && (m.via === 'untagged' || m.via === 'reply'))) delete m.via
        if (m.project !== undefined && !(typeof m.project === 'string' && m.project)) delete m.project
        if (m.actions !== undefined && !(Array.isArray(m.actions) && m.actions.every((x: any) => typeof x?.label === 'string'))) delete m.actions
        if (m.attachments !== undefined && !validAttachments(m.attachments)) delete m.attachments
        if (m.ping !== undefined && !(m.author === 'agent' && m.ping && typeof m.ping === 'object' && Object.values(m.ping).every((x) => PING_MARKS.includes(x as PingMark)))) delete m.ping
        messages.push(m)
      }
      else bad++
    } catch {
      bad++
    }
  }
  messages.sort((a, b) => a.id - b.id)
  try {
    const m = JSON.parse(readFileSync(metaFile(), 'utf8')) as Partial<Meta>
    const ch: Record<string, number> = {}
    if (m.channelSeen && typeof m.channelSeen === 'object')
      for (const [k, v] of Object.entries(m.channelSeen)) if (Number.isInteger(v) && v > 0) ch[k] = v
    meta = { nextId: Number(m.nextId) || 1, seenUpTo: Number(m.seenUpTo) || 0, channelSeen: ch }
  } catch {
    /* first run */
  }
  meta.nextId = Math.max(meta.nextId, (messages.at(-1)?.id ?? 0) + 1)
  if (bad) rewrite()
}

export const snapshot = (): BoardSnapshot => ({ messages, seenUpTo: meta.seenUpTo, keepDays: clampKeepDays(keepDays()), channelSeen: meta.channelSeen })
const publish = (): void => emit(snapshot())

/** Drop messages older than the Keep messages setting. Notes saved from them are separate files and stay. */
export function prune(now = Date.now()): number {
  const cutoff = now - clampKeepDays(keepDays()) * DAY
  const kept = messages.filter((m) => m.ts >= cutoff)
  const gone = messages.length - kept.length
  if (gone) {
    dropAttachments(messages.filter((m) => m.ts < cutoff))
    messages = kept
    rewrite()
    publish()
  }
  return gone
}

export function initBoard(
  folder: string,
  deps: { keepDays: () => number; changed: (s: BoardSnapshot) => void; projectOfTask?: (taskId: number) => string | undefined }
): void {
  dir = folder
  keepDays = deps.keepDays
  emit = deps.changed
  if (deps.projectOfTask) projectOfTask = deps.projectOfTask
  mkdirSync(dir, { recursive: true })
  load()
  prune()
  sweepAttachments()
  // about once a day while the app runs; a timer that only filters an array costs nothing
  setInterval(() => prune(), DAY).unref?.()
}

export const listMessages = (): BoardMessage[] => messages
export const getMessage = (id: number): BoardMessage | undefined => messages.find((m) => m.id === id)

export interface PostInput {
  author: BoardAuthor
  agentName?: string
  taskId?: number
  avatar?: CrowLook
  text: string
  replyTo?: number
  to?: string[]
  via?: Via
  question?: boolean
  done?: boolean
  actions?: BoardAction[]
  command?: string
  /** the channel (#145): a project id, or '' for General. Left out, it comes from the task (an agent's post, a notice
   *  about one), else from the message it replies to when Corvid or the app posts, else General. */
  project?: string
  /** the user's own message: the channel it was written in, which counts as read up to it ('all' by default) */
  seenIn?: string
  /** files to copy in with it (#147): only the board's message box passes these */
  files?: { name: string; data: Uint8Array }[]
  /** a /discuss message (#200): only main's discussion code passes this */
  discussion?: DiscussionMark
}

/** Write the files into the message's folder under safe, unique names; on any failure nothing stays behind. */
function storeFiles(id: number, files: { name: string; data: Uint8Array }[]): BoardAttachment[] {
  const problem = attachProblem(files.map((f) => ({ name: f.name, size: f.data.byteLength })))
  if (problem) throw new Error(problem)
  const folder = attachFolder(id)
  const out: BoardAttachment[] = []
  try {
    mkdirSync(folder, { recursive: true })
    for (const f of files) {
      const name = uniqueName(safeAttachmentName(f.name), out.map((a) => a.name))
      // 'wx': never overwrite, even if something got there first
      writeFileSync(join(folder, name), f.data, { flag: 'wx' })
      out.push({ name, size: f.data.byteLength, kind: attachmentKind(name) })
    }
  } catch (e) {
    rmSync(folder, { recursive: true, force: true })
    throw new Error(`Couldn't store the attached files: ${(e as Error).message}`)
  }
  return out
}

/** The channel a new message goes to (#145). */
function channelFor(input: PostInput): string | undefined {
  if (input.project !== undefined) return input.project || undefined
  if (input.taskId !== undefined) return projectOfTask(input.taskId) || undefined
  if (input.author !== 'user' && input.replyTo !== undefined) return getMessage(input.replyTo)?.project
  return undefined
}

/** Add a message. Who may post what (identity, secrets, rate limits) is checked by the callers in boardTools. */
export function post(input: PostInput): BoardMessage {
  const text = input.text.replace(/\r\n/g, '\n').trim()
  const files = input.author === 'user' ? (input.files ?? []) : []
  if (!text && !files.length) throw new Error('The message is empty.')
  // counted as people see them: an emoji is one character, however many UTF-16 pieces it takes
  const n = charCount(text)
  if (n > MAX_MESSAGE_CHARS)
    throw new Error(
      `Messages are limited to ${MAX_MESSAGE_CHARS} characters; this one has ${n}. Put longer text in a note and post a short message that points to it (e.g. "Details in N7").`
    )
  if (input.replyTo !== undefined && !getMessage(input.replyTo)) throw new Error(`There is no message m${input.replyTo} to reply to (it may have expired).`)
  const project = channelFor(input)
  const id = meta.nextId
  const attachments = files.length ? storeFiles(id, files) : []
  meta.nextId++
  const m: BoardMessage = {
    id,
    ts: Date.now(),
    author: input.author,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.avatar ? { avatar: input.avatar } : {}),
    ...(input.done ? { done: true } : {}),
    text,
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    ...(input.to?.length ? { to: [...new Set(input.to)] } : {}),
    ...(input.via && input.to?.length ? { via: input.via } : {}),
    ...(input.question ? { question: true } : {}),
    ...(input.actions?.length ? { actions: input.actions } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(project ? { project } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(input.discussion ? { discussion: input.discussion } : {})
  }
  messages = [...messages, m]
  try {
    if (messages.length > MAX_KEPT) {
      dropAttachments(messages.slice(0, -MAX_KEPT))
      messages = messages.slice(-MAX_KEPT)
      rewrite()
    } else appendFileSync(file(), JSON.stringify(m) + '\n')
  } catch (e) {
    // the send failed: its copies go too, so nothing is left orphaned
    messages = messages.filter((x) => x.id !== m.id)
    dropAttachments([m])
    throw e
  }
  // the user's own messages count as read, in the channel they were written in
  if (m.author === 'user') {
    if (!input.seenIn || input.seenIn === ALL_CHANNEL) meta.seenUpTo = m.id
    else meta.channelSeen = { ...meta.channelSeen, [input.seenIn]: m.id }
  }
  saveMeta()
  publish()
  return m
}

/** The user saw messages up to `upTo` in a channel; All (the default) counts for every channel. */
export function markSeen(upTo: number, channel: string = ALL_CHANNEL): void {
  upTo = Math.min(upTo, meta.nextId - 1)
  if (channel !== ALL_CHANNEL) {
    if (upTo <= Math.max(meta.seenUpTo, meta.channelSeen[channel] ?? 0)) return
    meta.channelSeen = { ...meta.channelSeen, [channel]: upTo }
    saveMeta()
    publish()
    return
  }
  if (upTo <= meta.seenUpTo) return
  meta.seenUpTo = upTo
  // every channel is read up to here now; older per-channel marks are dropped so the file stays small
  meta.channelSeen = Object.fromEntries(Object.entries(meta.channelSeen).filter(([, v]) => v > upTo))
  saveMeta()
  publish()
}

/** Mark messages as read by one of the people they're addressed to (`who` as stored in `to`), for the "seen" mark. */
export function noteReadBy(ids: number[], who: string): void {
  const want = new Set(ids)
  let hit = false
  messages = messages.map((m) => {
    if (!want.has(m.id) || !m.to?.includes(who) || m.seen?.includes(who)) return m
    hit = true
    return { ...m, seen: [...(m.seen ?? []), who] }
  })
  if (!hit) return
  rewrite()
  publish()
}

/** Set (or clear, with undefined) what happened to one agent the user's message mentioned, for its status line. */
export function setWake(id: number, who: string, wake: Wake | undefined): void {
  const m = getMessage(id)
  if (!m) return
  const next = { ...m.wake }
  if (wake) next[who] = wake
  else delete next[who]
  messages = messages.map((x) => {
    if (x.id !== id) return x
    const { wake: _old, ...rest } = x
    return Object.keys(next).length ? { ...rest, wake: next } : rest
  })
  rewrite()
  publish()
}

/** Mark what an agent's ping did to `who` (#195), for the board's ping and wake tags. */
export function setPing(id: number, who: string, mark: PingMark): void {
  const m = getMessage(id)
  if (!m || m.author !== 'agent') return
  messages = messages.map((x) => (x.id === id ? { ...x, ping: { ...x.ping, [who]: mark } } : x))
  rewrite()
  publish()
}

/** Update a /discuss message's mark (#200): the header's status and progress line. */
export function setDiscussion(id: number, patch: Partial<DiscussionMark>): void {
  const m = getMessage(id)
  if (!m?.discussion) return
  messages = messages.map((x) => (x.id === id && x.discussion ? { ...x, discussion: { ...x.discussion, ...patch } } : x))
  rewrite()
  publish()
}

/** Remember the note a message was saved as, for the board's Open link. */
export function setNote(id: number, noteId: string): void {
  if (!getMessage(id)) return
  messages = messages.map((m) => (m.id === id ? { ...m, noteId } : m))
  rewrite()
  publish()
}

/** Remove every message. Notes saved from them stay. */
export function clearBoard(): number {
  const n = messages.length
  messages = []
  rewrite()
  rmSync(attachRoot(), { recursive: true, force: true })
  meta.seenUpTo = meta.nextId - 1
  meta.channelSeen = {}
  saveMeta()
  publish()
  return n
}

export const boardDir = (): string => dir
