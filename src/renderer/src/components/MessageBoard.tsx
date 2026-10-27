import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { AlertCircle, ArrowDown, Check, ChevronDown, ChevronRight, CircleStop, Clock, Copy, Moon, CornerUpLeft, Info, MessageCircleQuestion, MessagesSquare, PanelRightClose, RotateCcw, SendHorizontal, StickyNote, X } from 'lucide-react'
import type { BoardMessage } from '@shared/board'
import type { BoardAsk } from '@shared/types'
import { addressLabel, ALL, ALL_CHANNEL, ASSISTANT_NAME, boardAuthor, findMentions, forUser, inChannel, MAX_MESSAGE_CHARS, mentionables, nameKey, seenUpToIn, unreadFor, type Wake } from '@shared/board'
import { api } from '../api'
import { editTask, getState, openNote, openTerminal, toast, useStore, useUserName } from '../store'
import { MicButton, useDictation } from './Dictation'
import { charCount, headChars } from '@shared/text'
import { hasUserName, userLabel } from '@shared/userName'
import { EmojiText, emojify } from '../emoji'
import { AgentAvatar, AssistantBadge, AV, messageLook, seededLook, UserBadge } from './AgentAvatar'
import { CommandPopup, MentionPopup, useCommands, useMentionOptions, useMentions } from './MentionPopup'
import { FALLBACK_COMMANDS, DASHBOARD_COMMANDS, leadingCommand, parseCommand } from '@shared/slashCommands'
import { CorvidStrip } from './Assistant'
import { boardChips, type BoardChip } from './boardChips'
import { allModelsWeek } from '@shared/models'
import { ChannelBar, ElsewhereForYou } from './BoardChannels'
import { useStickToBottom } from '../stickToBottom'
import { BOARD_JUMP_EVENT, jumpToMessage } from '../boardJump'
import { FormattedText } from './FormattedText'
import { InfoTip } from './Tooltip'
import { AttachButton, droppedFiles, MessageAttachments, pastedFiles, releaseStaged, StagedChips, stageFiles, type Staged } from './BoardAttachments'
import { playTour } from '../tourPlayer'

// The message board beside the agent cards: the user, the assistant (Corvid) and agents in one small chat.
// Agents only see it when they call read_messages, so nothing here reaches them in real time.

/** The draft survives the board switching between its full, strip and hidden forms. */
let draft = ''
let draftReply: number | undefined
/** Board only (#69): untagged messages post without waking Corvid. Kept until switched back, or Ctrl+J / a chip. */
let draftBoardOnly = false
/** The channel the board shows (#145). It starts on All each time Corvid starts and is kept while it runs. */
let draftChannel = ALL_CHANNEL
/** Files attached to the next message (#147), kept with the draft until it's sent or they're removed. */
let draftFiles: Staged[] = []

/** Files dropped anywhere on the board go to the message box. */
const ATTACH_EVENT = 'corvid:attach-files'
const hasFiles = (e: DragEvent): boolean => [...e.dataTransfer.types].includes('Files')

/** What Copy puts on the clipboard: the text, and the names of any attached files (never their contents). */
const copyText = (m: BoardMessage): string =>
  [m.text, m.attachments?.length ? `Attached: ${m.attachments.map((a) => a.name).join(', ')}` : ''].filter(Boolean).join('\n\n')

/** How many of the newest messages the board draws when it opens, changes channel or comes back into view (#181).
 *  Drawing a busy board in full (thousands of messages) froze the window for seconds; older ones come with
 *  "Load earlier messages", PAGE at a time. While following the newest, the drawn list is trimmed back to PAGE once
 *  it passes twice that. */
const PAGE = 100

/** The same message, as the board's snapshot replaces every message object on each change. */
const same = (a: BoardMessage | undefined, b: BoardMessage | undefined): boolean => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b))

/** Messages from the same author this close together share one name and avatar. */
const GROUP_GAP = 10 * 60_000

const pad = (n: number): string => String(n).padStart(2, '0')
const clock = (ts: number): string => {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const dayKey = (ts: number): string => new Date(ts).toDateString()

/** The same author as the message before, soon after it: shown under it without repeating the name and avatar. */
const follows = (prev: BoardMessage | undefined, m: BoardMessage): boolean =>
  !!prev &&
  prev.author === m.author &&
  prev.taskId === m.taskId &&
  prev.agentName === m.agentName &&
  prev.project === m.project &&
  m.ts - prev.ts < GROUP_GAP &&
  dayKey(prev.ts) === dayKey(m.ts)

/** The face beside a message: the agent's own crow, the assistant's (the user's crow look) or the user's plain marker.
 *  The app's notices have none: they show as a plain centred line. */
function Face({ m }: { m: BoardMessage }): ReactNode {
  const me = useUserName()
  if (m.author === 'user') return <UserBadge name={me} size={AV.chat} />
  if (m.author === 'assistant') return <AssistantBadge size={AV.chat} />
  return <AgentAvatar look={messageLook(m)} name={boardAuthor(m, me)} size={AV.chat} />
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400_000)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })
}

/** "Error invoking remote method 'board:post': Error: Refused: …" → "Refused: …" */
const ipcError = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The names the board knows, the same list main's board tools address (`mentionables`): running workers and named
 *  terminals, then agents that ended or are only on the board, so mentions of finished agents still stand out. */
function useBoardAgents(messages: BoardMessage[]): { name: string; taskId?: number }[] {
  const workers = useStore((s) => s.assistant.workers)
  const terminals = useStore((s) => s.terminals)
  const list = useMemo(() => {
    const live: { name: string; taskId?: number }[] = []
    for (const w of workers) if (w.agentName && w.state === 'running') live.push({ name: w.agentName, taskId: w.taskId })
    for (const t of terminals) if (t.agentName && t.exited === undefined) live.push({ name: t.agentName })
    const ended = workers.filter((w) => w.agentName && w.state !== 'running').map((w) => ({ name: w.agentName!, taskId: w.taskId }))
    return mentionables(live, messages, ended)
  }, [workers, terminals, messages])
  // the same list keeps its identity, so the drawn messages (memoised) don't redraw for every board or terminal change
  const kept = useRef({ key: '', list })
  const key = JSON.stringify(list)
  if (kept.current.key !== key) kept.current = { key, list }
  return kept.current.list
}

/** The "Untagged messages go to Corvid" setting (#69), on until the config says otherwise. */
const useUntaggedToCorvid = (): boolean => useStore((s) => s.config?.untaggedToCorvid ?? true)

/** The suggestion chips under the box (#206), from what's going on: recomputed only when the board, the workers, the
 *  tasks, the usage bars or the channel change, never on a keystroke. Empty with the Settings switch off. */
function useBoardChips(channel: string): BoardChip[] {
  const on = useStore((s) => s.config?.boardChips !== false)
  const messages = useStore((s) => s.board.messages)
  const workers = useStore((s) => s.assistant.workers)
  const tasks = useStore((s) => s.tasks)
  const quota = useStore((s) => s.quota)
  const liveQuota = useStore((s) => s.assistant.liveQuota)
  return useMemo(() => {
    if (!on) return []
    // the CLI's live numbers when they're newer than the fetched bars, as the Agents summary shows them
    const fresh = liveQuota && (!quota || liveQuota.at > quota.fetchedAt)
    const usage = fresh ? { fiveHour: liveQuota.fiveHour, week: liveQuota.week } : { fiveHour: quota?.session?.pct, week: allModelsWeek(quota?.weeks)?.pct }
    const lastUser = messages.reduce<number | undefined>((at, m) => (m.author === 'user' ? Math.max(at ?? 0, m.ts) : at), undefined)
    return boardChips({ messages, workers, tasks, channel, usage, lastActiveAt: lastUser, now: Date.now() })
  }, [on, messages, workers, tasks, quota, liveQuota, channel])
}

/** The "Format messages" setting (#126): agents', Corvid's and the app's messages drawn with light formatting. */
const useFormatMessages = (): boolean => useStore((s) => s.config?.formatMessages ?? true)

/** "to @…": the user by their name from Settings ("you" until one is set), Corvid as Corvid. */
const targetLabel = (t: string, me: string): string => (t === 'user' ? (hasUserName(me) ? userLabel(me) : 'you') : addressLabel(t))

/** Message text with @mentions as chips, and #12, N7 and links made clickable when they lead somewhere.
 *  @all is a mention only in the user's own messages, the only place it addresses anyone. */
function RichText({ text, agents, all = false }: { text: string; agents: { name: string; taskId?: number }[]; all?: boolean }): ReactNode {
  const tasks = useStore((s) => s.tasks)
  const notes = useStore((s) => s.notes)
  const me = useUserName()
  const parts: ReactNode[] = []
  const mentions = findMentions(text, agents, me).filter((mn) => all || mn.target !== ALL)
  const refs = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(^|[^\w&#])#(\d+)\b|\b(N\d+)\b/g
  let at = 0
  let key = 0
  const plain = (s: string): void => {
    let last = 0
    let m: RegExpExecArray | null
    refs.lastIndex = 0
    while ((m = refs.exec(s))) {
      const lead = m[2] ?? ''
      const start = m.index + lead.length
      const raw = m[0].slice(lead.length)
      let node: ReactNode = null
      if (m[1]) {
        node = (
          <a key={key++} href={m[1]} target="_blank" rel="noreferrer">
            {raw}
          </a>
        )
      } else if (m[3]) {
        const t = tasks.find((x) => x.id === Number(m![3]))
        if (t)
          node = (
            <button key={key++} className="mb-ref" title={`Task #${t.id}: ${t.title}`} onClick={() => editTask(t)}>
              {raw}
            </button>
          )
      } else if (m[4]) {
        const n = notes.find((x) => x.id === m![4])
        if (n)
          node = (
            <button key={key++} className="mb-ref" title={`Note ${n.id}: ${n.name}`} onClick={() => openNote(n.id)}>
              {raw}
            </button>
          )
      }
      if (!node) continue
      parts.push(...emojify(s.slice(last, start), (key += 1000)))
      parts.push(node)
      last = start + raw.length
    }
    parts.push(...emojify(s.slice(last), (key += 1000)))
  }
  for (const mn of mentions) {
    plain(text.slice(at, mn.start))
    const label = mn.target === 'assistant' ? ASSISTANT_NAME : mn.target === ALL ? 'all' : mn.target === 'user' ? text.slice(mn.start + 1, mn.end) : mn.target
    parts.push(
      <span
        key={key++}
        className={`mb-mention${mn.target === 'user' ? ' you' : ''}`}
        title={text.slice(mn.start, mn.end) === `@${label}` ? undefined : text.slice(mn.start, mn.end)}
      >
        @{label}
      </span>
    )
    at = mn.end
  }
  plain(text.slice(at))
  return <>{parts}</>
}

/** The user's slash command as typed (#71): the command in monospace, the rest plain. */
function CommandText({ text }: { text: string }): ReactNode {
  const name = /^\/\S+/.exec(text)?.[0] ?? ''
  return (
    <>
      <code className="mb-cmd">{name}</code>
      <EmojiText text={text.slice(name.length)} />
    </>
  )
}

export function MessageBoard({
  mode,
  active,
  switcher,
  onExpand,
  onCollapse
}: {
  /** full: beside the cards; panel: opened out beside a terminal; strip: a narrow bar beside a terminal; hidden */
  mode: 'full' | 'panel' | 'strip' | 'hidden'
  /** the user can see it now, so new messages count as read */
  active: boolean
  /** the Cards / Board toggle on a narrow window */
  switcher?: ReactNode
  onExpand?: () => void
  onCollapse?: () => void
}): ReactNode {
  const board = useStore((s) => s.board)
  const unread = unreadFor(board)
  const toYou = unread.some(forUser)

  if (mode === 'strip')
    return (
      <button className={`mb-strip${toYou ? ' you' : ''}`} title={unread.length ? `Board · ${unread.length} new` : 'Open the message board'} onClick={onExpand}>
        <MessagesSquare size={16} />
        {unread.length > 0 && <span className="badge">{unread.length}</span>}
        <span className="mb-strip-label">Board</span>
      </button>
    )
  return <BoardPanel mode={mode} active={active && mode !== 'hidden'} switcher={switcher} onCollapse={onCollapse} />
}

function BoardPanel({
  mode,
  active,
  switcher,
  onCollapse
}: {
  mode: 'full' | 'panel' | 'hidden'
  active: boolean
  switcher?: ReactNode
  onCollapse?: () => void
}): ReactNode {
  const board = useStore((s) => s.board)
  const messages = board.messages
  const agents = useBoardAgents(messages)
  // the channel (#145) only filters what shows; replies, mentions and the agents list still see the whole board
  const [channel, setChannelState] = useState(draftChannel)
  const setChannel = (c: string): void => {
    draftChannel = c
    setChannelState(c)
    setFrom(undefined)
  }
  const shown = useMemo(() => messages.filter((m) => inChannel(m, channel)), [messages, channel])
  const projects = useStore((s) => s.projects.projects)
  // in All, each project's message says which channel it's in
  const channelName = (m: BoardMessage): string | undefined =>
    channel === ALL_CHANNEL && m.project ? (projects.find((p) => p.id === m.project)?.name ?? 'Removed project') : undefined
  const untagged = useUntaggedToCorvid()
  const [below, setBelow] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  // where the "New" line goes: what this channel was read up to when it came into view
  const [newFrom, setNewFrom] = useState(seenUpToIn(board, channel))
  // the first message drawn (#181): undefined draws the newest PAGE (back to the "New" line, up to 3 × PAGE);
  // set once the user reads further back, so what's drawn stays put while new messages come in
  const [from, setFrom] = useState<number>()
  const fromIdx = from === undefined ? -1 : shown.findIndex((m) => m.id >= from)
  const newIdx = shown.findIndex((x) => x.id > newFrom && x.author !== 'user')
  const start =
    fromIdx >= 0 ? fromIdx : Math.max(0, Math.min(shown.length - PAGE, newIdx < 0 ? Infinity : newIdx), shown.length - 3 * PAGE)
  const startId = useRef<number>(undefined)
  startId.current = shown[start]?.id
  // follow the newest message unless the user scrolled up to read; a moved or resized pane changes neither (#123)
  const follow = useStickToBottom(scrollRef, 'board', (on) => {
    if (on) setBelow(0)
    else setFrom((f) => f ?? startId.current)
  })
  const seenCount = useRef(shown.length)

  useEffect(() => {
    if (active) setNewFrom(seenUpToIn(getState().board, channel))
  }, [active, channel])

  // read once it's on screen and the window has focus: All counts for every channel, a channel only for itself
  useEffect(() => {
    if (!active) return
    const mark = (): void => {
      const b = getState().board
      const last = b.messages.filter((m) => inChannel(m, channel)).at(-1)
      if (last && last.id > seenUpToIn(b, channel) && document.hasFocus()) void api.boardSeen(last.id, channel)
    }
    mark()
    window.addEventListener('focus', mark)
    return () => window.removeEventListener('focus', mark)
  }, [active, shown, channel])

  // follow new messages, unless the user has scrolled up to read
  useLayoutEffect(() => {
    const el = scrollRef.current
    const added = shown.length - seenCount.current
    seenCount.current = shown.length
    if (!el) return
    if (follow.following()) {
      follow.settle()
      setBelow(0)
      if (shown.length - start > 2 * PAGE) setFrom(undefined)
    } else if (added > 0) setBelow((b) => b + added)
  }, [shown])

  // coming into view, or another channel: start at the newest, with only the newest drawn (going out of view too, so
  // a long read-back isn't kept drawn while hidden)
  useLayoutEffect(() => {
    if (follow.following()) setFrom(undefined)
    if (active) follow.settle()
  }, [active, mode])

  // "Load earlier messages" keeps the message that was at the top where it was
  const keepTop = useRef<{ id: string; top: number }>(undefined)
  const loadEarlier = (to?: number): void => {
    const el = scrollRef.current
    const first = el?.querySelector<HTMLElement>('.mb-msg[id]')
    if (el && first) keepTop.current = { id: first.id, top: first.getBoundingClientRect().top - el.getBoundingClientRect().top }
    setFrom(to ?? shown[Math.max(0, start - PAGE)].id)
  }
  useLayoutEffect(() => {
    const k = keepTop.current
    const el = scrollRef.current
    keepTop.current = undefined
    const item = k && document.getElementById(k.id)
    if (!el || !k || !item) return
    el.scrollTop += item.getBoundingClientRect().top - el.getBoundingClientRect().top - k.top
  }, [start])

  // a reply's quote or an m42 pointing further back than what's drawn: draw back to it, then go there
  const jumping = useRef<number>(undefined)
  useEffect(() => {
    const onJump = (e: Event): void => {
      const id = Number((e as CustomEvent).detail)
      const at = shown.findIndex((m) => m.id === id)
      if (at < 0 || at >= start) return
      jumping.current = id
      loadEarlier(id)
    }
    window.addEventListener(BOARD_JUMP_EVENT, onJump)
    return () => window.removeEventListener(BOARD_JUMP_EVENT, onJump)
  })
  useEffect(() => {
    const id = jumping.current
    jumping.current = undefined
    if (id !== undefined && document.getElementById(`mb-${id}`)) jumpToMessage(id)
  }, [start])
  useLayoutEffect(() => {
    seenCount.current = shown.length
    follow.toBottom()
    setBelow(0)
  }, [channel])

  const toBottom = (): void => {
    follow.toBottom()
    setBelow(0)
  }

  // the "New" line goes above the first message from someone else that wasn't read before
  const firstNew = shown[newIdx]?.id

  const [replyTo, setReplyTo] = useState<number | undefined>(draftReply)
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)
  const reply = useCallback((id: number | undefined): void => {
    draftReply = id
    setReplyTo(id)
  }, [])

  return (
    <section
      className={`mboard ${mode}${dropping ? ' dropping' : ''}`}
      hidden={mode === 'hidden'}
      aria-label="Message board"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current++
        setDropping(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0
          setDropping(false)
        }
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDropping(false)
        // a dropped folder is refused by name here, before anything is read
        const files = droppedFiles(e)
        if (files.length) window.dispatchEvent(new CustomEvent(ATTACH_EVENT, { detail: files }))
      }}
    >
      {dropping && (
        <div className="mb-drop" aria-hidden>
          <span>Drop to attach to your next message</span>
        </div>
      )}
      {/* no title bar (#125): only the narrow window's Cards / Board toggle and the fold button, when either applies.
          Clearing the board and its expiry note are in Settings → Main chat. */}
      {(switcher || onCollapse) && (
        <div className="mb-bar">
          {switcher}
          {onCollapse && (
            <button className="btn ghost icon sm" title="Fold the board into a strip" aria-label="Fold the board" onClick={onCollapse}>
              <PanelRightClose size={15} />
            </button>
          )}
        </div>
      )}
      <CorvidStrip />
      <ChannelBar board={board} channel={channel} onChannel={setChannel} />
      <ElsewhereForYou board={board} channel={channel} onChannel={setChannel} />

      <div className="mb-list" ref={scrollRef} data-tour="messages.board">
        {shown.length === 0 && messages.length > 0 && (
          <div className="mb-empty">
            <MessagesSquare size={22} color="var(--text-4)" />
            <p>Nothing in this channel yet.</p>
            <p className="muted">
              What you write here is tagged with this channel.{' '}
              <InfoTip tip="Channels only filter the board: every message is still in All, in order. Agents post to their task's project, and Corvid takes the channel you write in as the project you mean." />
            </p>
          </div>
        )}
        {messages.length === 0 && (
          <div className="mb-empty">
            <MessagesSquare size={22} color="var(--text-4)" />
            <p>No messages yet.</p>
            <p className="muted">
              {untagged ? 'Write to Corvid, or @mention an agent.' : 'Write @corvid to talk to Corvid.'}{' '}
              <InfoTip
                tip={`Agents post here when they start, finish, get stuck or have a question, and you can post too. They only see the board when they read it, so nothing here interrupts them. ${
                  untagged
                    ? 'A message with no @mention goes to Corvid, who answers here; @mention an agent to write to it instead.'
                    : 'Write @corvid to talk to Corvid, who answers here.'
                } Type / at the start for Corvid's commands.`}
              />
            </p>
          </div>
        )}
        {start > 0 && (
          <button className="mb-earlier" onClick={() => loadEarlier()}>
            Load earlier messages · {start} more
          </button>
        )}
        {shown.slice(start).map((m, j) => {
          const prev = shown[start + j - 1]
          return (
            <Fragment key={m.id}>
              {(!prev || dayKey(prev.ts) !== dayKey(m.ts)) && (
                <div className="mb-sep">
                  <span>{dayLabel(m.ts)}</span>
                </div>
              )}
              {m.id === firstNew && (
                <div className="mb-sep new">
                  <span>New</span>
                </div>
              )}
              <Message
                m={m}
                cont={m.id !== firstNew && follows(prev, m)}
                parent={m.replyTo ? messages.find((x) => x.id === m.replyTo) : undefined}
                agents={agents}
                channelName={channelName(m)}
                onReply={reply}
              />
            </Fragment>
          )
        })}
      </div>
      {below > 0 && (
        <button className="mb-below" onClick={toBottom}>
          <ArrowDown size={13} /> {below} new message{below === 1 ? '' : 's'}
        </button>
      )}

      <Composer messages={messages} agents={agents} channel={channel} replyTo={replyTo ? messages.find((x) => x.id === replyTo) : undefined} onReply={reply} onSent={toBottom} />
    </section>
  )
}

/** One message, drawn again only when something it shows changed (#181). */
const Message = memo(
  MessageRow,
  (a, b) =>
    a.cont === b.cont && a.channelName === b.channelName && a.agents === b.agents && a.onReply === b.onReply && same(a.m, b.m) && same(a.parent, b.parent)
)

function MessageRow({
  m,
  cont,
  parent,
  agents,
  channelName,
  onReply
}: {
  m: BoardMessage
  /** in All: the project channel it's in (#145) */
  channelName?: string
  /** follows a message by the same author: no name or avatar of its own */
  cont: boolean
  parent?: BoardMessage
  agents: { name: string; taskId?: number }[]
  onReply: (id: number) => void
}): ReactNode {
  const tasks = useStore((s) => s.tasks)
  const workers = useStore((s) => s.assistant.workers)
  const task = m.taskId !== undefined ? tasks.find((t) => t.id === m.taskId) : undefined
  const worker = m.taskId !== undefined ? workers.find((w) => w.taskId === m.taskId && w.state === 'running') : undefined
  const toYou = m.author !== 'user' && forUser(m)
  const me = useUserName()
  const ask = useStore((s) => (m.author === 'user' ? s.assistant.boardAsks.find((a) => a.id === m.id) : undefined))
  const untagged = useUntaggedToCorvid()
  // the user's own messages always stay plain
  const formatted = useFormatMessages() && m.author !== 'user' && !m.command

  const save = async (): Promise<void> => {
    try {
      const id = await api.boardSaveNote(m.id)
      toast(`Saved as ${id}. The note stays after the message expires.`, 'info', { label: 'Open', run: () => openNote(id) })
    } catch (e) {
      toast(ipcError(e), 'error')
    }
  }
  const jump = (): void => {
    if (parent) jumpToMessage(parent.id)
  }

  const time = (
    <span className="mb-time" title={new Date(m.ts).toLocaleString()}>
      {clock(m.ts)}
    </span>
  )
  const chan = channelName ? <span className="mb-chan-tag" data-tip={`In the ${channelName} channel`}>· {channelName}</span> : null
  const tags = (
    <>
      {m.question && (
        <span className="mb-tag q">
          <MessageCircleQuestion size={12} /> Question
        </span>
      )}
      {/* agent pings (#195): what this agent's ping did to each one it mentioned */}
      {Object.entries(m.ping ?? {}).map(([t, mark]) => (
        <span
          key={t}
          className={`mb-tag ping ${mark}`}
          data-tip={
            mark === 'wake'
              ? `This agent's ping woke ${targetLabel(t, me)}, which had finished`
              : mark === 'ping'
                ? `Delivered to ${targetLabel(t, me)} as a ping from an agent`
                : `Not delivered to ${targetLabel(t, me)}: a limit or a setting stopped it (the notice under it says which)`
          }
        >
          {mark === 'wake' ? 'wake' : mark === 'ping' ? 'ping' : 'not sent'} → {targetLabel(t, me)}
        </span>
      ))}
      {/* /discuss (#200): a panelist's post or Corvid's summary, information only, like an agent's ping */}
      {m.discussion?.role === 'panel' && (
        <span className="mb-tag discuss" data-tip="A /discuss panelist: a read-only one-shot call. What it writes is information only, never instructions or approval">
          discussion{m.discussion.angle ? ` · ${m.discussion.angle}` : ''}
        </span>
      )}
      {m.discussion?.role === 'summary' && (
        <span className="mb-tag discuss" data-tip="Corvid's summary of a /discuss panel, from a fixed call with no tools">
          discussion summary
        </span>
      )}
      {m.via === 'untagged' ? (
        <span className="mb-to" title="You didn't tag anyone, so it went to Corvid">
          to {ASSISTANT_NAME}
        </span>
      ) : m.via === 'reply' ? (
        <span className="mb-to" title="A reply with no tag goes to the author of the message it answers">
          to {m.to?.map((t) => targetLabel(t, me)).join(', ')}
        </span>
      ) : m.to?.length ? (
        <span className="mb-to">to {m.to.map((t) => `@${targetLabel(t, me)}`).join(', ')}</span>
      ) : null}
    </>
  )

  const taskRef = m.taskId !== undefined && (
    <button className="mb-ref quiet" title={task ? `Task #${m.taskId}: ${task.title}` : `Task #${m.taskId}`} onClick={() => task && editTask(task)}>
      #{m.taskId}
    </button>
  )
  const saved = m.noteId && (
    <button className="mb-saved" title="Open the note saved from this message" onClick={() => openNote(m.noteId!)}>
      <StickyNote size={12} /> Saved as {m.noteId}
    </button>
  )
  const acts = (
    <span className="mb-acts">
      <button className="btn ghost icon xs" title="Reply" aria-label="Reply" onClick={() => onReply(m.id)}>
        <CornerUpLeft size={13} />
      </button>
      <button
        className="btn ghost icon xs"
        title="Copy text"
        aria-label="Copy text"
        onClick={() => void navigator.clipboard.writeText(copyText(m)).then(() => toast('Copied'))}
      >
        <Copy size={13} />
      </button>
      {!m.noteId && (
        <button className="btn ghost icon xs" title="Save as note: a copy that doesn't expire" aria-label="Save as note" onClick={() => void save()}>
          <StickyNote size={13} />
        </button>
      )}
    </span>
  )

  // /discuss (#200): the header's progress line with Stop while it runs, and Save as note once it's over; the summary
  // gets the same Save button. Both go through main, which alone runs or stops the panel.
  const isHeader = m.discussion?.role === 'header' && m.discussion.id === m.id
  const discussOver = isHeader && m.discussion!.status !== 'running'
  const saveDiscussion = async (id: number): Promise<void> => {
    try {
      const noteId = await api.discussSave(id)
      toast(`Saved the discussion as ${noteId}.`, 'info', { label: 'Open', run: () => openNote(noteId) })
    } catch (e) {
      toast(ipcError(e), 'error')
    }
  }
  const discuss = isHeader ? (
    <div className="mb-discuss" role="status">
      <span className={`mb-discuss-state ${m.discussion!.status ?? ''}`}>{m.discussion!.progress ?? m.discussion!.status}</span>
      {m.discussion!.status === 'running' ? (
        <button className="btn xs" onClick={() => void api.discussStop().then((t) => toast(t)).catch((e) => toast(ipcError(e), 'error'))}>
          <CircleStop size={12} /> Stop
        </button>
      ) : discussOver ? (
        <button className="btn xs" title="A note with the transcript and the summary" onClick={() => void saveDiscussion(m.id)}>
          <StickyNote size={12} /> Save as note
        </button>
      ) : null}
    </div>
  ) : m.discussion?.role === 'summary' ? (
    <div className="mb-discuss">
      <button className="btn xs" title="A note with the transcript and this summary" onClick={() => void saveDiscussion(m.discussion!.id)}>
        <StickyNote size={12} /> Save discussion as note
      </button>
    </div>
  ) : null

  // The app's own notices (author 'corvid'), such as a worker stopped at the time limit: a quiet
  // centred line with no face or bubble, so they never read as Corvid the assistant.
  if (m.author === 'corvid')
    return (
      <article id={`mb-${m.id}`} className={`mb-msg notice${isHeader ? ' discuss-head' : ''}`}>
        <div className="mb-body">
          <div className="mb-meta">
            <Info size={12} aria-hidden />
            <span className="mb-who">{boardAuthor(m, me)}</span>
            {taskRef}
            {time}
            {chan}
          </div>
          <div className="mb-text">{formatted ? <FormattedText m={m} agents={agents} /> : <RichText text={m.text} agents={agents} />}</div>
          {discuss}
          {saved}
        </div>
        {acts}
      </article>
    )

  // A chat row: the face in a column of its own (on the right for the user), then the name and time
  // over the message in a bubble. A run from the same author shows the face and name once, on the
  // first; the rest keep the column empty and show their time there on hover.
  return (
    <article
      id={`mb-${m.id}`}
      className={`mb-msg ${m.author}${toYou ? ' to-you' : ''}${m.question ? ' question' : ''}${cont ? ' cont' : ''}`}
    >
      <span className="mb-face">{cont ? <span className="mb-gtime">{time}</span> : <Face m={m} />}</span>
      <div className="mb-body">
        {cont ? (
          <>
            <span className="mb-who sr-only">{boardAuthor(m, me)}</span>
            {(m.question || m.to?.length || m.ping) && <div className="mb-meta">{tags}</div>}
          </>
        ) : (
          <div className="mb-meta">
            <span className="mb-who">{boardAuthor(m, me)}</span>
            {m.author === 'agent' && taskRef}
            {time}
            {chan}
            {tags}
          </div>
        )}
        <div className="mb-bubble">
          {parent && (
            <button className="mb-quote" title="Show the message this answers" onClick={jump}>
              <CornerUpLeft size={11} /> {boardAuthor(parent, me)}: <EmojiText text={headChars(parent.text.split('\n')[0], 90)} />
            </button>
          )}
          {m.replyTo && !parent && <div className="mb-quote gone">Reply to a message that has expired</div>}
          <div className="mb-text">
            {m.command ? (
              <CommandText text={m.text} />
            ) : formatted ? (
              <FormattedText m={m} agents={agents} />
            ) : (
              <RichText text={m.text} agents={agents} all={m.author === 'user'} />
            )}
          </div>
          <MessageAttachments m={m} />
          {m.author === 'user' && <Delivery m={m} />}
          {discuss}
          {m.question && m.author !== 'user' && (
            <div className="mb-qnote">
              {m.author === 'assistant'
                ? untagged
                  ? 'Reply to answer it: a message with no tag goes to Corvid.'
                  : 'Corvid sees replies the next time it reads the board. To reach it now, write a new message with @corvid.'
                : `${boardAuthor(m, me)} keeps working unless it said it's waiting, and sees replies the next time it reads the board. To reach it now, type in its terminal.`}
              {worker && (
                <button className="btn xs" onClick={() => openTerminal(worker.termId)}>
                  Open terminal
                </button>
              )}
            </div>
          )}
          {saved}
        </div>
        {m.actions?.length ? <WhatIDid actions={m.actions} /> : null}
        {ask && <CorvidStatus ask={ask} />}
      </div>
      {acts}
    </article>
  )
}

/** Under the user's message to agents, one quiet line per agent: read (its read_messages returned it), waiting for a
 *  running agent, or, for one that had ended, what Corvid did about it (#62). Corvid isn't listed: its replying line says more. */
function Delivery({ m }: { m: BoardMessage }): ReactNode {
  const agents = (m.to ?? []).filter((t) => t !== 'user' && t !== 'assistant')
  if (!agents.length) return null
  const seen = agents.filter((t) => m.seen?.includes(t))
  return (
    <div className="mb-delivery">
      {seen.length > 0 && (
        <span title="Their read_messages returned this message">
          <Check size={11} aria-hidden /> Read by {seen.join(', ')}
        </span>
      )}
      {agents
        .filter((t) => !m.seen?.includes(t))
        .map((t) => (
          <AgentDelivery key={t} id={m.id} who={t} wake={m.wake?.[t]} />
        ))}
    </div>
  )
}

function AgentDelivery({ id, who, wake }: { id: number; who: string; wake?: Wake }): ReactNode {
  const worker = useStore((s) => s.assistant.workers.find((w) => w.state === 'running' && w.agentName && nameKey(w.agentName) === nameKey(who)))
  const term = useStore((s) => s.terminals.find((t) => t.exited === undefined && t.agentName && nameKey(t.agentName) === nameKey(who)))
  const act = async (action: 'now' | 'queue' | 'cancel'): Promise<void> => {
    try {
      await api.boardWake(id, who, action)
    } catch (e) {
      toast(ipcError(e), 'error')
    }
  }
  const btn = (label: string, action: 'now' | 'queue' | 'cancel', title?: string): ReactNode => (
    <button className="mb-wake-btn" title={title} onClick={() => void act(action)}>
      {label}
    </button>
  )
  const open = (): void => (worker ? openTerminal(worker.termId) : undefined)

  if (worker || term) {
    if (wake?.status === 'back' && worker)
      return (
        <span className="mb-wake back" title="Resumed because you mentioned it; it reads this when it checks the board">
          <AgentAvatar look={worker.avatar ?? seededLook(worker.taskId)} name={who} size={14} />
          <button className="mb-wake-link" onClick={open}>
            {who}
          </button>{' '}
          is back on it
        </span>
      )
    // waking a running agent (#80)
    const name = worker ? (
      <button className="mb-wake-link" onClick={open}>
        {who}
      </button>
    ) : (
      who
    )
    switch (wake?.status) {
      case 'delivered':
        return worker?.liveStatus === 'busy' ? (
          <span className="mb-wake back" title="It was woken with your message and is working">
            <AgentAvatar look={worker.avatar ?? seededLook(worker.taskId)} name={who} size={14} />
            {name} is on it
          </span>
        ) : (
          <span className="mb-wake" title="A short message pointing it to the board was typed into its terminal">
            <Check size={11} aria-hidden /> Delivered to {name}
          </span>
        )
      case 'busy':
        return (
          <span className="mb-wake" title={wake.reason ? `Held: ${wake.reason}` : 'Nothing is typed into a busy terminal: it gets this as soon as its turn ends'}>
            <Clock size={11} aria-hidden />{' '}
            {worker?.liveStatus === 'idle' && !wake.reason ? <>Delivering to {name}…</> : <>Queued: {name} is busy, will get it after it finishes this turn</>}
          </span>
        )
      case 'prompt':
        return (
          <span className="mb-wake" title="Nothing is typed while it waits on a prompt; it gets this once you've answered">
            <Clock size={11} aria-hidden /> Waiting for you to answer {name}'s prompt {worker && (
              <button className="mb-wake-btn" onClick={open}>
                Open terminal
              </button>
            )}
          </span>
        )
      case 'failed':
        return (
          <span className="mb-wake blocked">
            <AlertCircle size={11} aria-hidden /> Couldn't wake {name}: {wake.reason ?? 'unknown reason'}. It sees this at its next check. {btn('Retry', 'now')}
          </span>
        )
      case 'capped':
      case 'later':
        return (
          <span className="mb-wake" title={wake.reason}>
            <Clock size={11} aria-hidden /> {name} will see it when it next checks the board{wake.reason ? ` (${wake.reason})` : ''}
          </span>
        )
    }
    return (
      <span title="Agents aren't interrupted: it sees this the next time it reads the board">
        <Clock size={11} aria-hidden /> {who} will see it when it next checks the board
      </span>
    )
  }
  const ended = (
    <>
      <Moon size={11} aria-hidden /> {who} ended
    </>
  )
  switch (wake?.status) {
    case 'resuming':
      return (
        <span className="mb-wake">
          <Clock size={11} aria-hidden /> Resuming {who}…
        </span>
      )
    case 'off':
      return (
        <span className="mb-wake" title="Resume mentioned agents is off in Settings">
          {ended} · not resumed (off in Settings)
        </span>
      )
    case 'full':
      return (
        <span className="mb-wake">
          {ended} · {wake.reason ?? 'No free slot'} {btn('Resume when a slot is free', 'queue', "Waits for a slot to free up, after anything you start yourself")}
        </span>
      )
    case 'queued':
      return (
        <span className="mb-wake">
          {ended} · waiting for a free slot {btn('Cancel', 'cancel')}
        </span>
      )
    case 'blocked':
      return (
        <span className="mb-wake blocked">
          <AlertCircle size={11} aria-hidden /> {who}: {wake.reason ?? "couldn't resume"} {btn('Retry', 'now')}
        </span>
      )
    case 'failed':
      return (
        <span className="mb-wake" title={wake.reason}>
          {ended} · {wake.reason ?? "couldn't be woken"} {btn('Resume', 'now', 'Start it again in its own Claude session; uses usage like any worker')}
        </span>
      )
    case 'back':
      return (
        <span className="mb-wake">
          {ended} again before reading this {btn('Resume', 'now', 'Start it again in its own Claude session; uses usage like any worker')}
        </span>
      )
    case 'ask':
      return (
        <span className="mb-wake" title={wake.reason}>
          {ended} {btn('Resume', 'now', wake.reason ?? 'Start it again in its own Claude session; uses usage like any worker')}
        </span>
      )
    default:
      return <span className="mb-wake">{ended}</span>
  }
}

/** Under Corvid's reply: what it did that turn (created a task, started a worker…), folded to one quiet line. */
function WhatIDid({ actions }: { actions: { label: string; ok: boolean }[] }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-did">
      <button className="mb-did-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} What I did · {actions.length}
      </button>
      {open && (
        <ul>
          {actions.map((x, i) => (
            <li key={i} className={x.ok ? '' : 'failed'}>
              {x.ok ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />} {x.label}
              {x.ok ? '' : ' (failed)'}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Corvid on the user's message to it: replying, queued behind another turn, why it didn't answer (with Retry), or
 *  that it left an untagged message alone because it was plainly for someone else. */
function CorvidStatus({ ask }: { ask: BoardAsk }): ReactNode {
  const retry = async (): Promise<void> => {
    try {
      await api.boardAskCorvid(ask.id)
    } catch (e) {
      toast(ipcError(e), 'error')
    }
  }
  if (ask.status === 'failed')
    return (
      <div className="mb-corvid failed" role="status">
        <AlertCircle size={12} aria-hidden />
        <span>{ask.error ?? "Corvid didn't answer."} Your message is kept.</span>
        <button className="btn xs" onClick={() => void retry()}>
          <RotateCcw size={11} /> Retry
        </button>
      </div>
    )
  if (ask.status === 'skipped')
    return (
      <div className="mb-corvid" role="status" title="Write @corvid to ask it anyway">
        <AssistantBadge size={16} />
        <span>Corvid left this one: it read as meant for someone else.</span>
      </div>
    )
  return (
    <div className="mb-corvid" role="status">
      <AssistantBadge size={16} />
      {ask.status === 'replying' ? (
        <>
          <span>Corvid is replying</span>
          <span className="mb-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <button className="btn xs stop" title="Stop Corvid's reply" onClick={() => void api.assistantInterrupt()}>
            <CircleStop size={11} /> Stop
          </button>
        </>
      ) : (
        <span>Queued: Corvid is finishing another turn and answers this next.</span>
      )}
    </div>
  )
}

function Composer({
  messages,
  agents,
  channel,
  replyTo,
  onReply,
  onSent
}: {
  messages: BoardMessage[]
  agents: { name: string; taskId?: number }[]
  /** the channel it's written in (#145): the message is tagged with it, and Corvid takes it as the project meant */
  channel: string
  replyTo?: BoardMessage
  onReply: (id: number | undefined) => void
  onSent: () => void
}): ReactNode {
  const [text, setTextState] = useState(draft)
  const [sending, setSending] = useState(false)
  const [files, setFilesState] = useState<Staged[]>(draftFiles)
  const setFiles = (next: Staged[]): void => {
    draftFiles = next
    setFilesState(next)
  }
  // files are read one after another, so two quick drops don't both slip under a limit
  const adding = useRef(Promise.resolve())
  const addFiles = (list: { file: File; name?: string }[]): void => {
    adding.current = adding.current.then(async () => setFiles(await stageFiles(draftFiles, list)))
  }
  const removeFile = (key: string): void => {
    releaseStaged(draftFiles.filter((f) => f.key === key))
    setFiles(draftFiles.filter((f) => f.key !== key))
    inputRef.current?.focus()
  }
  const me = useUserName()
  const untagged = useUntaggedToCorvid()
  const [boardOnly, setBoardOnlyState] = useState(draftBoardOnly)
  const setBoardOnly = (v: boolean): void => {
    draftBoardOnly = v
    setBoardOnlyState(v)
  }
  // who this goes to, as main will address it (main decides; this only shows it)
  const mentioned = findMentions(text, agents, me)
  const replyAgent = untagged && !mentioned.length && replyTo?.author === 'agent' ? replyTo.agentName : undefined
  const toCorvid = untagged && !boardOnly && !mentioned.length && !replyAgent
  const recipients = mentioned.length
    ? [...new Set(mentioned.map((x) => (x.target === ALL ? '@all' : `@${targetLabel(x.target, me)}`)))].join(', ')
    : replyAgent
  const live = useRef({ agents, me, untagged })
  live.current = { agents, me, untagged }
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const setText = (v: string): void => {
    draft = v
    setTextState(v)
  }
  const dictation = useDictation({
    value: text,
    setValue: setText,
    inputRef,
    hotkey: 'focused',
    reveal: () => inputRef.current?.focus(),
    keyterms: () => getState().assistant.workers.map((w) => w.agentName ?? '').filter(Boolean)
  })
  const mentions = useMentions({ text, setText, inputRef, options: useMentionOptions(messages) })
  const cmdList = useStore((s) => s.assistant.commands) ?? { commands: [...DASHBOARD_COMMANDS, ...FALLBACK_COMMANDS], from: 'fallback' as const }
  const commands = useCommands({ text, setText, inputRef, list: cmdList.commands })
  // the popup that's open, for the textarea's combobox attributes: at most one is (an @ never starts a "/word")
  const popup = commands.open ? { m: commands, id: 'mb-command-list' } : { m: mentions, id: 'mb-mention-list' }
  const typedCmd = leadingCommand(text.trim())
  const runsCmd = parseCommand(text.trim(), cmdList.commands)
  const unknownCmd = typedCmd && !commands.open && !runsCmd ? typedCmd : null
  // the tour chip (#214) only while tours are offered (Settings)
  const offerTours = useStore((s) => s.config?.offerTours !== false)
  const chips = useBoardChips(channel).filter((c) => !c.tour || offerTours)
  // the Answer chip (#206): the reply target goes to the agent's question, which addresses that agent with untagged
  // messages on; otherwise "@name " leads the draft so the answer still reaches it
  const answer = (a: { id: number; agentName?: string }): void => {
    setBoardOnly(false)
    onReply(a.id)
    if (!untagged && a.agentName) setText(`@${a.agentName} `)
    const ta = inputRef.current
    if (!ta) return
    ta.focus()
    requestAnimationFrame(() => ta.setSelectionRange(draft.length, draft.length))
  }

  useLayoutEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(160, ta.scrollHeight) + 'px'
    if (mirrorRef.current) mirrorRef.current.scrollTop = ta.scrollTop
  }, [text, dictation.interim])

  useEffect(() => {
    if (replyTo) inputRef.current?.focus()
  }, [replyTo?.id])

  // Ctrl+J, Ask Corvid and the suggestion chips: back to "To Corvid", and the question in the box, caret at the end. With
  // untagged messages going to Corvid that is plain text; otherwise (or when the draft @mentions someone) "@corvid " leads.
  useEffect(() => {
    const onAsk = (e: Event): void => {
      const ask = String((e as CustomEvent).detail ?? '')
      const rest = draft.replace(/^\s*@corvid\b\s*/i, '')
      const body = ask || rest
      const { agents: known, me: name, untagged: on } = live.current
      setBoardOnly(false)
      const next = on && !findMentions(body, known, name).length ? body : `@corvid ${body}`
      setText(next)
      const ta = inputRef.current
      if (!ta) return
      ta.focus()
      requestAnimationFrame(() => ta.setSelectionRange(next.length, next.length))
    }
    window.addEventListener('corvid:ask', onAsk)
    return () => window.removeEventListener('corvid:ask', onAsk)
  }, [])

  useEffect(() => {
    const onFiles = (e: Event): void => {
      addFiles(((e as CustomEvent).detail as File[]).map((file) => ({ file })))
      inputRef.current?.focus()
    }
    window.addEventListener(ATTACH_EVENT, onFiles)
    return () => window.removeEventListener(ATTACH_EVENT, onFiles)
  }, [])

  // an ended agent's Resume on its card: "@name " leads the draft, caret at the end
  useEffect(() => {
    const onMention = (e: Event): void => {
      const tag = `@${String((e as CustomEvent).detail ?? '')}`
      const next = draft.includes(tag) ? draft : `${tag} ${draft.trimStart()}`
      setText(next)
      const ta = inputRef.current
      if (!ta) return
      ta.focus()
      requestAnimationFrame(() => ta.setSelectionRange(next.length, next.length))
    }
    window.addEventListener('corvid:mention', onMention)
    return () => window.removeEventListener('corvid:mention', onMention)
  }, [])

  // as people see it, the way main counts it: an emoji is one character
  const len = charCount(text.trim())
  const over = len > MAX_MESSAGE_CHARS

  // a message may be files alone, with no text (#147)
  const empty = !len && !files.length

  const send = async (): Promise<void> => {
    if (empty || over || sending) return
    dictation.stop()
    setSending(true)
    try {
      await adding.current
      const sent = draftFiles
      await api.boardPost(text, replyTo?.id, { boardOnly, channel, ...(sent.length ? { files: sent.map((f) => ({ name: f.name, data: f.data })) } : {}) })
      releaseStaged(sent)
      setFiles(draftFiles.filter((f) => !sent.includes(f)))
      setText('')
      onReply(undefined)
      onSent()
    } catch (e) {
      toast(ipcError(e), 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mb-compose-wrap">
      {replyTo && (
        <div className="mb-replying">
          <CornerUpLeft size={12} />
          <span>
            Replying to <b>{boardAuthor(replyTo, me)}</b>: <EmojiText text={headChars(replyTo.text.split('\n')[0], 80)} />
          </span>
          <button className="btn ghost icon xs" title="Cancel the reply" aria-label="Cancel the reply" onClick={() => onReply(undefined)}>
            <X size={12} />
          </button>
        </div>
      )}
      {!text.trim() && !replyTo && !files.length && chips.length > 0 && (
        <div className="mb-sugg" aria-label="Ask Corvid">
          {chips.map((c) => (
            <button
              key={c.text}
              className="chip"
              title={c.answer ? `Reply to ${c.answer.agentName ?? 'the agent'}’s question` : `Put “${untagged ? '' : '@corvid '}${c.text}” in the box, to Corvid`}
              onClick={() => (c.tour ? playTour(c.tour) : c.answer ? answer(c.answer) : window.dispatchEvent(new CustomEvent('corvid:ask', { detail: c.text })))}
            >
              {c.text}
            </button>
          ))}
        </div>
      )}
      <StagedChips files={files} onRemove={removeFile} />
      <MentionPopup m={mentions} id="mb-mention-list" />
      <CommandPopup m={commands} id="mb-command-list" from={cmdList.from} />
      <div className="dock-compose mb-compose" data-tour="messages.box">
        <AttachButton onFiles={(list) => addFiles(list.map((file) => ({ file })))} disabled={sending} />
        <div className={`dock-input${dictation.interim ? ' has-interim' : ''}`}>
          <textarea
            ref={inputRef}
            rows={1}
            spellCheck
            data-own-dictation
            placeholder={
              !untagged
                ? 'Message the board · @corvid to ask Corvid, @ to address someone · / for commands'
                : boardOnly
                  ? "Post to the board, Corvid isn't woken · @ to address someone · / for commands"
                  : 'Message Corvid, or @mention an agent · / for commands'
            }
            value={text}
            role="combobox"
            aria-expanded={popup.m.open}
            aria-controls={popup.m.open ? popup.id : undefined}
            aria-activedescendant={popup.m.open ? `${popup.id}-${popup.m.active}` : undefined}
            aria-autocomplete="list"
            onChange={(e) => {
              dictation.noteTyping()
              setText(e.target.value)
              mentions.track()
              commands.track()
            }}
            onPaste={(e) => {
              // a screenshot (#147): an image with no text alongside it is attached, not pasted as text
              const pasted = pastedFiles(e)
              if (!pasted.length) return
              e.preventDefault()
              addFiles(pasted)
            }}
            onSelect={() => {
              mentions.track()
              commands.track()
            }}
            onBlur={() => {
              mentions.close()
              commands.close()
            }}
            onScroll={(e) => {
              if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop
            }}
            onKeyDown={(e) => {
              // the @ and / popups go first: while one is open, Enter and Tab pick, Esc closes it
              if (mentions.onKeyDown(e) || commands.onKeyDown(e)) return
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              } else if (e.key === 'Escape' && replyTo) onReply(undefined)
            }}
          />
          {dictation.interim && (
            <div className="dock-mirror" ref={mirrorRef} aria-hidden="true">
              {text.slice(0, dictation.interim.start)}
              <span className="voice-interim">{text.slice(dictation.interim.start, dictation.interim.end)}</span>
              {text.slice(dictation.interim.end)}
              {'​'}
            </div>
          )}
          <MicButton d={dictation} />
        </div>
        <button className="btn icon primary" title="Send (Enter) · Shift+Enter for a new line" disabled={empty || over || sending} onClick={() => void send()}>
          <SendHorizontal size={15} />
        </button>
      </div>
      {unknownCmd && (
        <div className="mb-count">
          {cmdList.from === 'fallback'
            ? `No /${unknownCmd} in the short list (Corvid hasn't started yet). You can still send it.`
            : `No /${unknownCmd} command in this chat. You can still send it.`}
        </div>
      )}
      <div className="mb-route">
        <span className="mb-route-label">To</span>
        {untagged ? (
          <div
            className={`seg xs mb-route-seg${recipients ? ' decided' : ''}`}
            role="radiogroup"
            aria-label="Who a message with no @mention goes to"
            title={recipients ? 'Your @mention or reply decides who this is for' : undefined}
          >
            <button
              role="radio"
              aria-checked={!boardOnly}
              className={!boardOnly ? 'on' : ''}
              title="A message with no @mention goes to Corvid, which replies here. Each one uses some of your Claude usage."
              onClick={() => setBoardOnly(false)}
            >
              {ASSISTANT_NAME}
            </button>
            <button
              role="radio"
              aria-checked={boardOnly}
              className={boardOnly ? 'on' : ''}
              title="Post without waking Corvid: for the room, or a note to agents that needs no reply. @corvid still asks Corvid."
              onClick={() => setBoardOnly(true)}
            >
              Board only
            </button>
          </div>
        ) : null}
        <span className="mb-route-hint">
          {/* a command always goes to Corvid (#71), whatever Board only, the setting or a mention in it say */}
          {runsCmd
            ? `/${runsCmd.cmd.name} ${runsCmd.cmd.source === 'dashboard' || runsCmd.cmd.source === 'extension' ? 'is run by the dashboard' : 'goes to Corvid as a command'}`
            : recipients
            ? `${recipients}${replyAgent ? ' (reply)' : ''}${mentioned.some((x) => x.target === 'assistant') ? '' : untagged ? " · Corvid isn't woken" : ''}`
            : toCorvid
              ? 'Corvid replies here'
              : untagged
                ? "Corvid isn't woken"
                : 'Board only · @corvid to ask Corvid'}
        </span>
      </div>
      {len > MAX_MESSAGE_CHARS - 300 && (
        <div className={`mb-count${over ? ' over' : ''}`}>
          {len} / {MAX_MESSAGE_CHARS}
          {over ? ' · too long: put the details in a note and link it here (N7)' : ''}
        </div>
      )}
    </div>
  )
}
