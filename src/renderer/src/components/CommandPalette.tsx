import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpen, CornerDownLeft, MessageSquare, Search } from 'lucide-react'
import type { SearchHit, SessionSummary } from '@shared/types'
import { api } from '../api'
import { searchDocs, type DocsHit } from '@shared/docs'
import { launch, openDocs, setState, showSession, useStore } from '../store'
import { docs } from '../docsData'
import { relTime } from '../format'
import { projectOfPath } from '../scope'
import { mod, platform } from '../keys'

type Item = { kind: 'session'; s: SessionSummary } | { kind: 'hit'; s: SessionSummary; hit: SearchHit } | { kind: 'doc'; doc: DocsHit }

/** Docs pages shown above the transcript hits (#188): the best few, opened in the Docs view. */
const DOC_HITS = 4

export function CommandPalette(): ReactNode {
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.projects)
  // a session from before a move or rename shows (and is found by) its project's name now (4/5)
  const nameOf = (s: SessionSummary): string => projects.projects.find((p) => p.id === projectOfPath(s.cwd, projects))?.name ?? s.projectName
  const indexing = useStore((s) => !s.progress.ready)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  useEffect(() => {
    const needle = q.trim()
    if (needle.length < 2) {
      setHits([])
      return
    }
    setSearching(true)
    const t = setTimeout(() => {
      void api.search(needle).then((h) => {
        setHits(h)
        setSearching(false)
      })
    }, 160)
    return () => clearTimeout(t)
  }, [q])

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase()
    const all = Object.values(sessions).sort((a, b) => b.lastActivity - a.lastActivity)
    const titleMatches = (
      needle
        ? all.filter((s) => {
            const hay = `${s.title} ${s.projectName} ${nameOf(s)} ${s.gitBranch ?? ''}`.toLowerCase()
            return needle.split(/\s+/).every((t) => hay.includes(t))
          })
        : all
    ).slice(0, needle ? 6 : 10)
    const shown = new Set(titleMatches.map((s) => s.id))
    const hitItems: Item[] = []
    for (const h of hits) {
      const s = sessions[h.sessionId]
      if (!s) continue
      hitItems.push({ kind: 'hit', s, hit: h })
      shown.add(s.id)
      if (hitItems.length >= 40) break
    }
    const docItems: Item[] = needle.length >= 2 ? searchDocs(docs.manifest.search, needle, DOC_HITS).map((doc) => ({ kind: 'doc' as const, doc })) : []
    return [...titleMatches.map((s) => ({ kind: 'session' as const, s })), ...docItems, ...hitItems]
  }, [q, sessions, hits, projects])

  useEffect(() => setIdx(0), [q])
  useEffect(() => {
    listRef.current?.querySelector('.pitem.on')?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  const close = (): void => setState({ paletteOpen: false })
  const choose = (item: Item, resume: boolean): void => {
    close()
    if (item.kind === 'doc') openDocs(item.doc.path)
    else if (resume && !item.s.deleted) void launch(item.s, 'resume')
    else showSession(item.s.id)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') setIdx((i) => Math.min(items.length - 1, i + 1))
    else if (e.key === 'ArrowUp') setIdx((i) => Math.max(0, i - 1))
    else if (e.key === 'Enter' && items[idx]) choose(items[idx], mod(e))
    else return
    e.preventDefault()
  }

  const firstHit = items.findIndex((i) => i.kind === 'hit')
  const firstDoc = items.findIndex((i) => i.kind === 'doc')

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-input">
          <Search size={17} color="var(--text-3)" />
          <input
            ref={inputRef}
            spellCheck
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search sessions, everything you and Claude said, and the docs…"
          />
          {searching && <span className="muted" style={{ fontSize: 11.5 }}>searching…</span>}
        </div>
        <div className="palette-results" ref={listRef}>
          {items.length > 0 && items[0].kind === 'session' && (
            <div className="palette-section section-label">{q.trim() ? 'Sessions' : 'Recent sessions'}</div>
          )}
          {items.map((item, i) => (
            <div key={`${item.kind}-${item.kind === 'doc' ? item.doc.path : item.s.id}-${i}`}>
              {i === firstDoc && <div className="palette-section section-label">Docs</div>}
              {i === firstHit && <div className="palette-section section-label">In transcripts</div>}
              {item.kind === 'doc' ? (
                <div className={`pitem${i === idx ? ' on' : ''}`} onMouseMove={() => setIdx(i)} onClick={() => choose(item, false)}>
                  <BookOpen size={15} color="var(--text-3)" style={{ marginTop: 2, flex: 'none' }} />
                  <div className="body">
                    <div className="t">{item.doc.title}</div>
                    <div className="s">{item.doc.mark ? <Highlight text={item.doc.snippet} start={item.doc.mark.start} len={item.doc.mark.len} /> : item.doc.snippet}</div>
                  </div>
                </div>
              ) : (
              <div className={`pitem${i === idx ? ' on' : ''}`} onMouseMove={() => setIdx(i)} onClick={(e) => choose(item, mod(e))}>
                {item.kind === 'session' ? (
                  <MessageSquare size={15} color="var(--text-3)" style={{ marginTop: 2, flex: 'none' }} />
                ) : (
                  <span className="chip" style={{ height: 18, fontSize: 10, flex: 'none' }}>
                    {item.hit.role === 'user' ? 'You' : 'Claude'}
                  </span>
                )}
                <div className="body">
                  <div className="t">{item.s.title}</div>
                  <div className="s">
                    {item.kind === 'hit' ? (
                      <Highlight text={item.hit.snippet} start={item.hit.matchStart} len={item.hit.matchLength} />
                    ) : (
                      <>
                        {nameOf(item.s)} · {relTime(item.s.lastActivity)}
                      </>
                    )}
                  </div>
                </div>
                {item.kind === 'hit' && <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{relTime(item.hit.ts || item.s.lastActivity)}</span>}
              </div>
              )}
            </div>
          ))}
          {!items.length && <div className="empty" style={{ padding: 30 }}>{searching ? 'Searching…' : indexing ? 'Indexing your transcripts…' : 'Nothing found.'}</div>}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>{' '}
            show in project
          </span>
          <span>
            <kbd>{platform.modLabel}</kbd>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>{' '}
            resume now
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}

function Highlight({ text, start, len }: { text: string; start: number; len: number }): ReactNode {
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, start + len)}</mark>
      {text.slice(start + len)}
    </>
  )
}
