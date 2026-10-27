import { useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { BoardMessage } from '@shared/board'
import { ALL, ASSISTANT_NAME, findMentions } from '@shared/board'
import { formatCached, type Block, type Inline, type Line } from '@shared/boardFormat'
import { editTask, openNote, useStore, useUserName } from '../store'
import { emojify } from '../emoji'
import { jumpToMessage } from '../boardJump'

// Agents' and Corvid's board messages drawn with light structure (#126): paragraphs, lists with their markers as
// typed, **bold**, *italic*, `code`, and a few highlighted tokens (shared/boardFormat.ts decides which). Everything is
// React text, so nothing in a message can run or load anything. Each drawn run carries its offsets in the original
// (data-o, data-e), so copying a selection gives the text exactly as posted, markdown and all.

/** Show more / Show less, per message, for the session. */
const unfolded = new Map<number, boolean>()

type Agents = { name: string; taskId?: number }[]


export function FormattedText({ m, agents }: { m: BoardMessage; agents: Agents }): ReactNode {
  const tasks = useStore((s) => s.tasks)
  const notes = useStore((s) => s.notes)
  const ids = useStore((s) => s.board.messages)
  const me = useUserName()
  const f = formatCached(m.id, m.text)
  const [open, setOpen] = useState(() => unfolded.get(m.id) ?? false)
  const [fits, setFits] = useState(false)
  const foldRef = useRef<HTMLDivElement>(null)

  // a long message that happens to fit the preview (a wide pane) needs no toggle
  useLayoutEffect(() => {
    const el = foldRef.current
    if (!f.long || open || !el) return
    const check = (): void => setFits(el.scrollHeight <= el.clientHeight + 2)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [f.long, open])

  const body = useMemo(() => {
    let key = 0
    const leaf = (text: string, at: number): ReactNode => (
      <span key={key++} data-o={at} data-e={at + text.length}>
        {emojify(text, key * 1000)}
      </span>
    )
    const ref = (raw: string, at: number): ReactNode => {
      const o = { 'data-o': at, 'data-e': at + raw.length }
      if (raw.startsWith('#')) {
        const t = tasks.find((x) => x.id === Number(raw.slice(1)))
        if (t)
          return (
            <button key={key++} {...o} className="mb-ref" title={`Task #${t.id}: ${t.title}`} onClick={() => editTask(t)}>
              {raw}
            </button>
          )
      } else if (raw.startsWith('N')) {
        const n = notes.find((x) => x.id === raw)
        if (n)
          return (
            <button key={key++} {...o} className="mb-ref" title={`Note ${n.id}: ${n.name}`} onClick={() => openNote(n.id)}>
              {raw}
            </button>
          )
      } else {
        const id = Number(raw.slice(1))
        if (ids.some((x) => x.id === id))
          return (
            <button key={key++} {...o} className="mb-ref" title={`Show message ${raw}`} onClick={() => jumpToMessage(id)}>
              {raw}
            </button>
          )
      }
      return leaf(raw, at)
    }
    /** A plain run: @mentions as chips, then the highlighted tokens the parse found, the rest as text. */
    const plain = (x: Extract<Inline, { t: 'text' }>): ReactNode[] => {
      const out: ReactNode[] = []
      const { text, at } = x
      const mentions = findMentions(text, agents, me).filter((mn) => mn.target !== ALL)
      const toks = (x.toks ?? []).filter((t) => !mentions.some((mn) => t.start < mn.end && t.end > mn.start))
      const cuts = [
        ...mentions.map((mn) => ({ start: mn.start, end: mn.end, mn })),
        ...toks.map((t) => ({ start: t.start, end: t.end, t }))
      ].sort((a, b) => a.start - b.start)
      let last = 0
      for (const c of cuts) {
        if (c.start < last) continue
        if (c.start > last) out.push(leaf(text.slice(last, c.start), at + last))
        const raw = text.slice(c.start, c.end)
        const o = { 'data-o': at + c.start, 'data-e': at + c.end }
        if ('mn' in c && c.mn) {
          const mn = c.mn
          const label = mn.target === 'assistant' ? ASSISTANT_NAME : mn.target === 'user' ? raw.slice(1) : mn.target
          out.push(
            <span key={key++} {...o} className={`mb-mention${mn.target === 'user' ? ' you' : ''}`} title={raw === `@${label}` ? undefined : raw}>
              @{label}
            </span>
          )
        } else if ('t' in c && c.t) {
          const kind = c.t.kind
          if (kind === 'ref') out.push(ref(raw, at + c.start))
          else if (kind === 'url')
            // shown, not followed: an agent's text could carry any address
            out.push(
              <span key={key++} {...o} className="fmt-url" title={`${raw}\nLinks in agents' messages aren't opened from the board. Copy it if you trust it.`}>
                {raw}
              </span>
            )
          else
            out.push(
              <span key={key++} {...o} className={`fmt-${kind}`}>
                {raw}
              </span>
            )
        }
        last = c.end
      }
      if (last < text.length) out.push(leaf(text.slice(last), at + last))
      return out
    }
    const inl = (list: Inline[]): ReactNode[] =>
      list.flatMap((x): ReactNode[] => {
        if (x.t === 'text') return plain(x)
        if (x.t === 'code')
          return [
            <code key={key++} className="fmt-code" data-o={x.textAt} data-e={x.textAt + x.text.length}>
              {x.text}
            </code>
          ]
        const Tag = x.t === 'bold' ? 'strong' : 'em'
        return [<Tag key={key++}>{inl(x.kids)}</Tag>]
      })
    const lines = (ls: Line[]): ReactNode[] => ls.flatMap((l, i) => (i ? ['\n', ...inl(l.inl)] : inl(l.inl)))
    const block = (b: Block): ReactNode =>
      b.t === 'para' ? (
        <p key={key++} className="fmt-p">
          {lines(b.lines)}
        </p>
      ) : (
        <div key={key++} className={`fmt-list${b.ordered ? ' ol' : ''}`}>
          {b.items.map((it) => (
            <div key={key++} className={`fmt-li l${it.level}`}>
              <span className="fmt-mk" data-o={it.markerAt} data-e={it.markerAt + it.marker.length}>
                {it.marker === '*' ? '•' : it.marker}
              </span>
              <span className="fmt-li-body">{lines(it.lines)}</span>
            </div>
          ))}
        </div>
      )
    return f.blocks.map(block)
  }, [f, tasks, notes, ids, agents, me])

  const folded = f.long && !open && !fits
  const toggle = (v: boolean): void => {
    unfolded.set(m.id, v)
    setOpen(v)
  }
  return (
    <>
      <div ref={foldRef} className={`mb-fmt${f.long && !open ? ' fold' : ''}${folded ? ' cut' : ''}`} onCopy={(e) => copyOriginal(e, m.text)}>
        {body}
      </div>
      {f.long && (open || !fits) && (
        <button className="mb-more" aria-expanded={open} onClick={() => toggle(!open)}>
          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  )
}

/** Copying a selection inside one message gives the original text between its ends, exactly as posted. A selection
 *  reaching outside the message is left to the browser. */
function copyOriginal(e: ClipboardEvent<HTMLDivElement>, text: string): void {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || sel.isCollapsed) return
  const r = sel.getRangeAt(0)
  const root = e.currentTarget
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return
  const a = offsetAt(root, r.startContainer, r.startOffset, true)
  const b = offsetAt(root, r.endContainer, r.endOffset, false)
  if (a === undefined || b === undefined || b < a) return
  e.clipboardData.setData('text/plain', text.slice(a, b))
  e.preventDefault()
}

const span = (el: Element): [number, number] => [Number(el.getAttribute('data-o')), Number(el.getAttribute('data-e'))]

/** Where a selection end falls in the original text. Inside a drawn run, by the characters before it (when the run
 *  shows exactly its original characters), else the run's start or end; between runs, the nearest run's edge. */
function offsetAt(root: HTMLElement, node: Node, offset: number, start: boolean): number | undefined {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
  const run = el?.closest('[data-o]')
  if (run && root.contains(run)) {
    const [o, end] = span(run)
    if (node === run) return offset === 0 ? o : end
    if (node.nodeType === Node.TEXT_NODE) {
      if ((run.textContent ?? '').length !== end - o) return start ? o : end
      const pre = document.createRange()
      pre.setStart(run, 0)
      pre.setEnd(node, offset)
      return o + pre.toString().length
    }
  }
  // a boundary between elements: the next run's start, or the previous run's end
  const runs = [...root.querySelectorAll('[data-o]')]
  const probe = document.createRange()
  probe.setStart(node, offset)
  if (start) {
    for (const x of runs) if (probe.comparePoint(x, 0) >= 0) return span(x)[0]
    return undefined
  }
  for (let i = runs.length - 1; i >= 0; i--) if (probe.comparePoint(runs[i], runs[i].childNodes.length) <= 0) return span(runs[i])[1]
  return undefined
}
