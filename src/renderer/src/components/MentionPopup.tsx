import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Users } from 'lucide-react'
import type { BoardMessage } from '@shared/board'
import { ASSISTANT_NAME, mentionAt, mentionables, nameKey } from '@shared/board'
import { commandAt, findCommand, SOURCE_LABEL, type CommandList, type SlashCommand } from '@shared/slashCommands'
import type { CrowLook } from '@shared/types'
import { useStore } from '../store'
import { AgentAvatar, AssistantBadge, AV, messageLook, seededLook, workerLook } from './AgentAvatar'

// The board composer's @ popup: who a message can address, filtered as the user types. Picking one inserts "@" and the
// whole name as stored, which findMentions in @shared/board reads back exactly, in this window and in main.
// The same popup and keys serve the "/" commands (#71), which open only for a "/word" that starts the box.

export interface MentionOption {
  key: string
  /** what the row shows, and what goes after the @ */
  name: string
  kind: 'corvid' | 'agent' | 'all'
  taskId?: number
  /** running now; ended agents show muted */
  live: boolean
  look?: CrowLook
  /** other words that find it */
  aliases?: string[]
}

function matches(o: MentionOption, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const num = /^#?(\d+)$/.exec(q)
  if (num) return o.taskId !== undefined && String(o.taskId).startsWith(num[1])
  const k = nameKey(q)
  const words = [o.name, ...(o.aliases ?? [])]
  // the whole name from its start ("staff marg"), or any one of its words ("concierge")
  return words.some((w) => nameKey(w).startsWith(k)) || (!/\s/.test(q) && o.name.toLowerCase().split(/[\s_-]+/).some((w) => w.startsWith(q)))
}

/** Everyone the popup offers, in order: Corvid, running agents, @all when any run, then agents that ended but are still on the board. */
export function useMentionOptions(messages: BoardMessage[]): MentionOption[] {
  const workers = useStore((s) => s.assistant.workers)
  const terminals = useStore((s) => s.terminals)
  return useMemo(() => {
    const live: { name: string; taskId?: number }[] = []
    for (const w of workers) if (w.agentName && w.state === 'running') live.push({ name: w.agentName, taskId: w.taskId })
    for (const t of terminals) if (t.agentName && t.exited === undefined) live.push({ name: t.agentName })
    const ended = workers.filter((w) => w.agentName && w.state !== 'running').map((w) => ({ name: w.agentName!, taskId: w.taskId }))
    const lookOf = (name: string, taskId?: number): CrowLook => {
      const w = workers.find((x) => x.agentName === name)
      if (w) return workerLook(w, name)
      const m = [...messages].reverse().find((x) => x.author === 'agent' && x.agentName === name)
      return m ? messageLook(m) : seededLook(taskId ?? name)
    }
    const agents = mentionables(live, messages, ended).map(
      (a): MentionOption => ({ key: `a:${nameKey(a.name)}`, name: a.name, kind: 'agent', taskId: a.taskId, live: a.live, look: lookOf(a.name, a.taskId) })
    )
    const running = agents.filter((a) => a.live)
    return [
      { key: 'corvid', name: ASSISTANT_NAME, kind: 'corvid', live: true, aliases: ['assistant'] },
      ...running,
      ...(running.length ? [{ key: 'all', name: 'all', kind: 'all', live: true, aliases: ['everyone'] } satisfies MentionOption] : []),
      ...agents.filter((a) => !a.live)
    ]
  }, [workers, terminals, messages])
}

export interface Picker<T> {
  open: boolean
  list: T[]
  active: number
  setActive: (i: number) => void
  track: () => void
  close: () => void
  pick: (o: T) => void
  /** true when the popup took the key: the composer must not act on it */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

interface Box {
  text: string
  setText: (v: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
}

/** The @ popup for one textarea. */
export function useMentions(opts: Box & { options: MentionOption[] }): Picker<MentionOption> {
  const { options } = opts
  const filter = useCallback(
    (query: string): MentionOption[] => {
      const found = options.filter((o) => matches(o, query))
      // "@Corvid " just after picking it, or typed in full and a space: done, not a search
      return /\s$/.test(query) && found.some((o) => nameKey(o.name) === nameKey(query)) ? [] : found
    },
    [options]
  )
  return usePicker({ ...opts, sigil: '@', find: mentionAt, filter, insert: (o) => `@${o.name} ` })
}

/** The "/" popup: Corvid's commands, by name or alias from the start, the dashboard's first, an exact name on top. */
export function useCommands(opts: Box & { list: SlashCommand[] }): Picker<SlashCommand> {
  const { list } = opts
  const filter = useCallback(
    (query: string): SlashCommand[] => {
      const q = query.toLowerCase()
      const hit = (c: SlashCommand): boolean => [c.name, ...(c.aliases ?? [])].some((n) => n.toLowerCase().startsWith(q))
      // typed in full: still shown, so Enter or Tab completes it with its space
      return list.filter(hit).sort((a, b) => Number(!!findCommand(q, [b])) - Number(!!findCommand(q, [a])))
    },
    [list]
  )
  return usePicker({ ...opts, sigil: '/', find: commandAt, filter, insert: (c) => `/${c.name} ` })
}

/**
 * The popup's state for one textarea. `track` reads the caret after the user typed, pasted, clicked or moved it;
 * dictation sets the text without any of those, so it never opens the popup by itself. Esc closes it until the next
 * `sigil` somewhere else.
 */
function usePicker<T>(
  opts: Box & {
    sigil: string
    find: (text: string, caret: number) => { start: number; query: string } | null
    filter: (query: string) => T[]
    insert: (o: T) => string
  }
): Picker<T> {
  const { text, setText, inputRef, sigil, find, filter, insert } = opts
  const [at, setAt] = useState<{ start: number; query: string } | null>(null)
  const [closedAt, setClosedAt] = useState<number | null>(null)
  const [active, setActive] = useState(0)

  const track = (): void => {
    const ta = inputRef.current
    if (!ta || ta.selectionStart !== ta.selectionEnd) return setAt(null)
    const next = find(ta.value, ta.selectionStart)
    setAt(next)
    if (!next || next.start !== closedAt) setClosedAt(null)
  }

  // the text changed under the popup (sent, dictated, cleared): it only stays while its @ (or /) is still there
  useEffect(() => {
    if (at && text[at.start] !== sigil) setAt(null)
  }, [text])

  const list = useMemo(() => (!at || at.start === closedAt ? [] : filter(at.query)), [at, closedAt, filter])
  const open = list.length > 0

  useEffect(() => setActive(0), [at?.start, at?.query])

  const pick = (o: T): void => {
    const ta = inputRef.current
    if (!at || !ta) return
    const end = at.start + 1 + at.query.length
    const ins = insert(o)
    // for a command, the rest of the word being completed goes too ("/comp|act" → "/compact ")
    const after = text.slice(end).replace(sigil === '/' ? /^\S* ?/ : /^ /, '')
    const v = text.slice(0, at.start) + ins + after
    const caret = at.start + ins.length
    setText(v)
    setClosedAt(at.start)
    setAt(null)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(caret, caret)
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + d + list.length) % list.length)
      return true
    }
    if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault()
      pick(list[Math.min(active, list.length - 1)])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setClosedAt(at!.start)
      return true
    }
    return false
  }

  return { open, list, active, setActive, track, close: () => setAt(null), pick, onKeyDown }
}

/** The list itself, above the composer so it stays in the window at the bottom of the board. */
function PickerPopup<T>({
  m,
  id,
  label,
  hint,
  rowKey,
  rowClass,
  row
}: {
  m: Picker<T>
  id: string
  label: string
  hint: ReactNode
  rowKey: (o: T) => string
  rowClass?: (o: T) => string
  row: (o: T) => ReactNode
}): ReactNode {
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [m.active, m.list])
  if (!m.open) return null
  return (
    <div className="mb-mentions" role="presentation">
      <ul ref={listRef} id={id} role="listbox" aria-label={label}>
        {m.list.map((o, i) => (
          <li
            key={rowKey(o)}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === m.active}
            className={`${i === m.active ? 'on' : ''}${rowClass?.(o) ? ` ${rowClass(o)}` : ''}`}
            // keep the focus (and the caret) in the textarea
            onMouseDown={(e) => {
              e.preventDefault()
              m.pick(o)
            }}
            onMouseEnter={() => m.setActive(i)}
          >
            {row(o)}
          </li>
        ))}
      </ul>
      <div className="mb-mn-hint">{hint}</div>
    </div>
  )
}

export function MentionPopup({ m, id }: { m: Picker<MentionOption>; id: string }): ReactNode {
  return (
    <PickerPopup
      m={m}
      id={id}
      label="Who to address"
      hint="Agents see it the next time they read the board; nothing interrupts them."
      rowKey={(o) => o.key}
      rowClass={(o) => (o.live ? '' : 'ended')}
      row={(o) => (
          <>
            <span className="mb-mn-face">
              {o.kind === 'corvid' ? (
                <AssistantBadge size={AV.mention} />
              ) : o.kind === 'all' ? (
                <span className="plain-badge" style={{ width: AV.mention, height: AV.mention }}>
                  <Users aria-hidden />
                </span>
              ) : (
                <AgentAvatar look={o.look!} name={o.name} size={AV.mention} />
              )}
            </span>
            <span className="mb-mn-name">{o.kind === 'all' ? 'all' : o.name}</span>
            <span className="mb-mn-side">
              {o.kind === 'corvid'
                ? 'answers here'
                : o.kind === 'all'
                  ? 'every running agent'
                  : [o.taskId !== undefined ? `#${o.taskId}` : '', o.live ? '' : 'ended'].filter(Boolean).join(' · ')}
            </span>
          </>
      )}
    />
  )
}

/** The "/" list: name and argument hint, a one-line description, and where it comes from. */
export function CommandPopup({ m, id, from }: { m: Picker<SlashCommand>; id: string; from: CommandList['from'] }): ReactNode {
  return (
    <PickerPopup
      m={m}
      id={id}
      label="Commands for Corvid"
      hint={
        from === 'session'
          ? "Commands go to Corvid. Claude's come from its current session."
          : from === 'cache'
            ? "Commands go to Corvid. Claude's come from its last session; Corvid isn't running now."
            : "Corvid hasn't started yet, so this is a short built-in list. The full one comes once it starts."
      }
      rowKey={(c) => c.name}
      rowClass={() => 'cmd'}
      row={(c) => (
        <>
          <span className="mb-cmd-main">
            <span className="mb-cmd-name">
              /{c.name}
              {c.argumentHint && <span className="mb-cmd-args"> {c.argumentHint}</span>}
            </span>
            {c.description && <span className="mb-cmd-desc">{c.description.split('\n')[0]}</span>}
          </span>
          <span className={`mb-cmd-tag ${c.source}`}>{SOURCE_LABEL[c.source]}</span>
        </>
      )}
    />
  )
}
