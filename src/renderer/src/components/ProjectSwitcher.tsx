// The project switcher at the left of the top bar (#77), and the small "Showing <project>" chip the filtered
// views carry. Ctrl+P opens it (terminals keep Ctrl+P), typing filters, arrows move, Enter picks, Esc closes.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Archive, Check, ChevronDown, Layers, Pin, Search, X } from 'lucide-react'
import type { ProjectRecord } from '@shared/types'
import { primaryFolder } from '@shared/projectList'
import { setScope, useScope } from '../scope'
import { useStore } from '../store'
import { useProjects } from '../views/ProjectsView'
import { keyLabel, mod } from '../keys'

const LANES = 8

/** A project's colour: one of the theme's lane colours, picked from its id so it stays the same. */
function laneOf(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `var(--lane-${h % LANES})`
}

/** The project's initial in a small square of its colour; All projects gets a stack. */
export function ProjectMark({ p, size = 18 }: { p?: Pick<ProjectRecord, 'id' | 'name'>; size?: number }): ReactNode {
  if (!p)
    return (
      <span className="psw-mark all" style={{ width: size, height: size }}>
        <Layers size={size - 6} />
      </span>
    )
  return (
    <span className="psw-mark" style={{ width: size, height: size, ['--mark' as string]: laneOf(p.id) }}>
      {(p.name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

export function ProjectSwitcher(): ReactNode {
  const scope = useScope()
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!mod(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'p') return
      // terminals keep Ctrl+P (previous command in the shell's history)
      if ((document.activeElement as HTMLElement | null)?.closest('.xterm')) return
      e.preventDefault()
      setOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  // a choice made elsewhere (the chip's ×, a fallback to All projects) closes the menu
  useEffect(() => setOpen(false), [scope?.id])

  return (
    <div className="psw">
      <button
        ref={btn}
        className={`psw-btn${scope ? ' on' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${scope ? `Showing ${scope.name}: Agents, Tasks, Notes and Projects narrow to it.` : 'Showing all projects.'} Switch project (${keyLabel('P')})`}
        onClick={() => setOpen(!open)}
      >
        <ProjectMark p={scope} />
        <span className="psw-name">{scope?.name ?? 'All projects'}</span>
        <ChevronDown size={13} className="psw-chev" />
      </button>
      {open && <SwitcherMenu anchor={btn.current} onClose={() => setOpen(false)} />}
    </div>
  )
}

type Row = { id?: string; p?: ProjectRecord; group: string }

function SwitcherMenu({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }): ReactNode {
  const scope = useScope()
  const projects = useProjects()
  const [q, setQ] = useState('')
  const [archived, setArchived] = useState(false)
  const [hi, setHi] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 8, top: 40 })

  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect()
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), top: r.bottom + 4 })
  }, [anchor])

  // the model gives the order (by last activity) and the records give the rest
  const list = useStore((s) => s.projects.projects)
  const records = useMemo(() => new Map(list.map((p) => [p.id, p])), [list])
  const needle = q.trim().toLowerCase()
  const rows = useMemo<Row[]>(() => {
    const match = (p: { name: string; path: string }): boolean => !needle || `${p.name} ${p.path}`.toLowerCase().includes(needle)
    const live = projects.filter((p) => !p.archived && match(p))
    const rec = (id: string): ProjectRecord | undefined => records.get(id)
    const out: Row[] = []
    if (!needle || 'all projects'.includes(needle)) out.push({ group: '' })
    for (const p of live.filter((x) => x.pinned)) out.push({ id: p.id, p: rec(p.id), group: 'Pinned' })
    for (const p of live.filter((x) => !x.pinned)) out.push({ id: p.id, p: rec(p.id), group: 'Recent' })
    if (archived) for (const p of projects.filter((x) => x.archived && match(x))) out.push({ id: p.id, p: rec(p.id), group: 'Archived' })
    return out
  }, [projects, records, needle, archived])
  const archivedCount = projects.filter((p) => p.archived).length

  useEffect(() => setHi(0), [needle, archived])
  useEffect(() => {
    listRef.current?.querySelector('.psw-row.hi')?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Element
      if (!ref.current?.contains(t) && !t.closest?.('.psw-btn')) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [onClose])

  const choose = (r: Row | undefined): void => {
    if (!r) return
    setScope(r.id)
    onClose()
  }

  return (
    <div
      className="psw-menu"
      ref={ref}
      role="dialog"
      aria-label="Switch project"
      style={pos}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          setHi((i) => Math.min(rows.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setHi((i) => Math.max(0, i - 1))
        } else if (e.key === 'Enter') {
          e.preventDefault()
          choose(rows[hi])
        }
      }}
    >
      <div className="psw-search">
        <Search size={13} />
        <input autoFocus spellCheck={false} placeholder="Find a project…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a project" />
        <kbd>Esc</kbd>
      </div>
      <div className="psw-list" ref={listRef} role="listbox">
        {rows.map((r, i) => (
          <div key={r.id ?? 'all'}>
            {r.group && r.group !== rows[i - 1]?.group && <div className="psw-group">{r.group}</div>}
            <div
              role="option"
              aria-selected={(r.id ?? '') === (scope?.id ?? '')}
              className={`psw-row${i === hi ? ' hi' : ''}${r.p?.archived ? ' archived' : ''}`}
              onMouseMove={() => setHi(i)}
              onClick={() => choose(r)}
              title={r.p ? primaryFolder(r.p) : 'Every project, as Corvid shows it without a filter'}
            >
              <ProjectMark p={r.p} />
              <span className="psw-row-name">{r.p?.name ?? 'All projects'}</span>
              {r.p?.pinned && !r.p.archived && <Pin size={11} className="psw-pin" />}
              {r.p?.archived && <span className="psw-tag">Archived</span>}
              {(r.id ?? '') === (scope?.id ?? '') && <Check size={13} className="psw-check" />}
            </div>
          </div>
        ))}
        {!rows.length && <div className="psw-empty">No project matches “{q.trim()}”.</div>}
      </div>
      {archivedCount > 0 && (
        <button className="psw-foot" onClick={() => setArchived(!archived)}>
          <Archive size={12} /> {archived ? 'Hide' : 'Show'} {archivedCount} archived
        </button>
      )}
    </div>
  )
}

/** On a view the switcher narrows: which project it shows, and one click back to All projects. */
export function ScopeChip(): ReactNode {
  const scope = useScope()
  if (!scope) return null
  return (
    <span className="scope-chip" title={`Only ${scope.name} is shown here. Pick another project from the switcher at the top left (${keyLabel('P')}).`}>
      <ProjectMark p={scope} size={14} />
      <span className="scope-chip-name">{scope.name}</span>
      <button className="scope-chip-x" title="Show all projects" aria-label="Show all projects" onClick={() => setScope(undefined)}>
        <X size={11} />
      </button>
    </span>
  )
}
