import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, CircleAlert, Code2, FolderOpen, Loader2, Plus, Search, StickyNote, Trash2, TriangleAlert, X } from 'lucide-react'
import type { Note } from '@shared/types'
import { LARGE_NOTE_BYTES, MAX_NOTE_BYTES, noteAuthor, noteBytes, sizeLabel, updatedByLabel } from '@shared/notes'
import { baseName } from '@shared/projects'
import { api } from '../api'
import { newNote, openNote, openProject, removeNote, setState, toast, useStore, useUserName } from '../store'
import { relTime } from '../format'
import { UserBadge } from '../components/AgentAvatar'
import { ScopeChip } from '../components/ProjectSwitcher'
import { useInScope, useScope } from '../scope'
import { InfoTip } from '../components/Tooltip'

type Sort = 'updated' | 'created' | 'name' | 'author'

const SORTS: { id: Sort; label: string }[] = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'created', label: 'Recently created' },
  { id: 'name', label: 'Name' },
  { id: 'author', label: 'Author' }
]

function readSort(): Sort {
  try {
    const s = localStorage.getItem('notesSort')
    return SORTS.some((x) => x.id === s) ? (s as Sort) : 'updated'
  } catch {
    return 'updated'
  }
}

const sorters: Record<Sort, (a: Note, b: Note) => number> = {
  updated: (a, b) => b.updated - a.updated,
  created: (a, b) => b.created - a.created,
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || b.updated - a.updated,
  author: (a, b) => noteAuthor(a).localeCompare(noteAuthor(b)) || b.updated - a.updated
}

export function NotesView(): ReactNode {
  const notes = useStore((s) => s.notes)
  const openId = useStore((s) => s.openNoteId)
  const open = openId ? notes.find((n) => n.id === openId) : undefined

  if (openId && open) return <NoteEditor key={open.id} note={open} />
  if (openId)
    return (
      <div className="notes-view">
        <div className="kempty notes-gone">
          {openId} no longer exists: it was deleted, or its file was moved out of the notes folder.
          <button className="btn sm" onClick={() => setState({ openNoteId: undefined })}>
            <ArrowLeft size={13} /> All notes
          </button>
        </div>
      </div>
    )
  return <NotesGrid notes={notes} />
}

function NotesGrid({ notes }: { notes: Note[] }): ReactNode {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>(readSort)
  // the project switcher (#77): the chosen project's notes, and the general ones that belong to no project
  const scope = useScope()
  const inScope = useInScope()
  const mine = scope ? notes.filter((n) => !n.project || inScope(n.project)) : notes
  const needle = q.trim().toLowerCase()
  const shown = mine
    .filter((n) => !needle || `${n.id} ${n.name}\n${n.text}`.toLowerCase().includes(needle))
    .sort(sorters[sort])
  const unread = notes.filter((n) => n.unread).length

  return (
    <div className="notes-view" data-tour="notes.view">
      <div className="tasks-head notes-head">
        <div>
          <h2>
            Notes
            <ScopeChip />
          </h2>
          <p className="muted">
            {scope ? `${mine.length} here (with notes that have no project) · ${notes.length} in all` : `${notes.length} note${notes.length === 1 ? '' : 's'}`}
            {unread ? ` · ${unread} new from agents` : ''} <InfoTip tip="Plain text files, stored only on this PC." />
          </p>
        </div>
        <div className="notes-tools">
          <div className="input-wrap notes-search">
            <Search size={14} />
            <input className="input" spellCheck placeholder="Search names and text…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select
            className="select"
            title="Sort"
            value={sort}
            onChange={(e) => {
              const s = e.target.value as Sort
              setSort(s)
              try {
                localStorage.setItem('notesSort', s)
              } catch {
                /* ignore */
              }
            }}
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button className="btn ghost icon" title="Open the notes folder" onClick={() => void api.openNotesFolder()}>
            <FolderOpen size={15} />
          </button>
          <button className="btn primary" onClick={() => void newNote()}>
            <Plus size={14} /> New note
          </button>
        </div>
      </div>

      {shown.length ? (
        <div className="notes-grid">
          {shown.map((n) => (
            <NoteCard key={n.id} n={n} />
          ))}
        </div>
      ) : (
        <div className="kempty">
          {notes.length
            ? mine.length || needle
              ? 'No notes match.'
              : 'No notes for this project yet.'
            : 'No notes yet. Write one, or ask Corvid or an agent to leave its findings as a note. Anyone can refer to a note by its ID (like N7) or its name.'}
        </div>
      )}
    </div>
  )
}

function NoteCard({ n }: { n: Note }): ReactNode {
  const me = useUserName()
  const preview = n.text.slice(0, 400).trim()
  return (
    <div className={`ncard${n.unread ? ' unread' : ''}`} onClick={() => openNote(n.id)}>
      <div className="tc-top">
        {n.unread && <span className="ncard-new">New</span>}
        <span className="tid">{n.id}</span>
        <div className="tc-actions">
          <button
            title="Delete (moves it to the notes trash)"
            onClick={(e) => {
              e.stopPropagation()
              void removeNote(n.id)
            }}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="tc-title">{n.name}</div>
      {preview ? <div className="ncard-preview">{preview}</div> : <div className="ncard-preview empty">Empty</div>}
      <div className="tc-meta">
        <span className={`chip${n.author === 'user' ? '' : ' agent'}`} title={n.author === 'agent' ? `Agent working on #${n.taskId}` : undefined}>
          {n.author === 'user' && <UserBadge size={14} name={me} />}
          {noteAuthor(n, me)}
          {n.author === 'agent' && n.taskId ? ` · #${n.taskId}` : ''}
        </span>
        {n.size >= LARGE_NOTE_BYTES && (
          <span className="src" title="Large note: agents read it in pieces">
            <TriangleAlert size={11} /> {sizeLabel(n.size)}
          </span>
        )}
        <span className="when" title={`Updated ${new Date(n.updated).toLocaleString()}`}>
          {relTime(n.updated)}
        </span>
      </div>
    </div>
  )
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict' | 'toolarge'

const AUTOSAVE_MS = 600

function NoteEditor({ note }: { note: Note }): ReactNode {
  const me = useUserName()
  const [name, setName] = useState(note.name)
  const [text, setText] = useState(note.text)
  const [status, setStatus] = useState<SaveState>('saved')
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState<Note | null>(null)
  const [outside, setOutside] = useState<string>()
  const [settled, setSettled] = useState(0)
  // Refs carry the latest draft into the debounced save and the unmount flush.
  const draft = useRef({ name: note.name, text: note.text })
  const base = useRef(note.rev)
  const dirty = useRef(false)
  const saving = useRef(false)
  const conflicted = useRef(false)
  const timer = useRef(0)

  const save = async (): Promise<void> => {
    window.clearTimeout(timer.current)
    if (saving.current || conflicted.current || !dirty.current) return
    if (noteBytes(draft.current.text) > MAX_NOTE_BYTES) {
      setStatus('toolarge')
      return
    }
    saving.current = true
    dirty.current = false
    setStatus('saving')
    try {
      const r = await api.updateNote(note.id, draft.current, base.current)
      if ('conflict' in r) {
        dirty.current = true
        conflicted.current = true
        setConflict(r.conflict)
        setStatus('conflict')
      } else {
        base.current = r.note.rev
        setStatus(dirty.current ? 'dirty' : 'saved')
      }
    } catch (e) {
      dirty.current = true
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setStatus('error')
    } finally {
      saving.current = false
      setSettled((x) => x + 1)
      if (dirty.current && !conflicted.current) timer.current = window.setTimeout(() => void save(), AUTOSAVE_MS)
    }
  }

  const change = (patch: Partial<typeof draft.current>): void => {
    draft.current = { ...draft.current, ...patch }
    if (patch.name !== undefined) setName(patch.name)
    if (patch.text !== undefined) setText(patch.text)
    dirty.current = true
    setOutside(undefined)
    if (!conflicted.current) {
      setStatus(noteBytes(draft.current.text) > MAX_NOTE_BYTES ? 'toolarge' : 'dirty')
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void save(), AUTOSAVE_MS)
    }
  }

  // The note changed under us (an agent appended, or an edit in VS Code). Untouched: show the new
  // version. With unsaved typing: don't overwrite either side, ask.
  useEffect(() => {
    if (saving.current || note.rev === base.current) return
    if (!dirty.current) {
      draft.current = { name: note.name, text: note.text }
      base.current = note.rev
      setName(note.name)
      setText(note.text)
      setOutside(updatedByLabel(note.updatedBy, me))
    } else if (!conflicted.current) {
      conflicted.current = true
      window.clearTimeout(timer.current)
      setConflict(note)
      setStatus('conflict')
    } else setConflict(note)
  }, [note.rev, settled])

  // Leaving the editor saves what's pending straight away.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      if (dirty.current && !conflicted.current && !saving.current && noteBytes(draft.current.text) <= MAX_NOTE_BYTES)
        void api
          .updateNote(note.id, draft.current, base.current)
          .then((r) => 'conflict' in r && toast(`${note.id} changed on disk, so your last edit wasn't saved`, 'error'))
          .catch(() => {
            /* deleted while open: nothing left to save to */
          })
    },
    []
  )

  const resolve = (keepMine: boolean): void => {
    if (!conflict) return
    base.current = conflict.rev
    conflicted.current = false
    if (keepMine) {
      dirty.current = true
      void save()
    } else {
      dirty.current = false
      draft.current = { name: conflict.name, text: conflict.text }
      setName(conflict.name)
      setText(conflict.text)
      setStatus('saved')
    }
    setConflict(null)
  }

  const size = noteBytes(text)

  return (
    <div className="notes-view note-editor">
      <div className="note-bar">
        <button className="btn ghost sm" onClick={() => setState({ openNoteId: undefined })}>
          <ArrowLeft size={14} /> Notes
        </button>
        <span className="tid">{note.id}</span>
        <SaveIndicator status={status} error={error} outside={outside} />
        <div style={{ flex: 1 }} />
        <button className="btn ghost icon sm" title="Open the file in VS Code" onClick={() => void api.openFile(note.file)}>
          <Code2 size={14} />
        </button>
        <button className="btn ghost icon sm" title="Delete (moves it to the notes trash)" onClick={() => void removeNote(note.id)}>
          <Trash2 size={14} />
        </button>
      </div>
      <input className="task-title-input note-name" spellCheck placeholder="Name" value={name} onChange={(e) => change({ name: e.target.value })} />
      <div className="note-meta">
        <span className={`chip${note.author === 'user' ? '' : ' agent'}`}>
          {note.author === 'user' ? <UserBadge size={16} name={me} /> : <StickyNote size={11} />} {noteAuthor(note, me)}
          {note.author === 'agent' && note.taskId ? ` · #${note.taskId}` : ''}
        </span>
        {note.project && (
          <span className="chip link" onClick={() => openProject(note.project!)}>
            {baseName(note.project)}
          </span>
        )}
        <span>created {relTime(note.created)}</span>
        <span>
          updated {relTime(note.updated)}
          {note.updatedBy && note.updatedBy !== note.author ? ` by ${updatedByLabel(note.updatedBy, me)}` : ''}
        </span>
        <span className={size > MAX_NOTE_BYTES ? 'danger' : size >= LARGE_NOTE_BYTES ? 'warn' : ''}>{sizeLabel(size)}</span>
      </div>
      {conflict && (
        <div className="note-conflict">
          <CircleAlert size={14} />
          <span>
            This note changed on disk{conflict.updatedBy ? ` (by ${updatedByLabel(conflict.updatedBy, me)})` : ''} while you were editing. Your last changes
            aren't saved yet.
          </span>
          <button className="btn sm" onClick={() => resolve(false)}>
            Load the new version
          </button>
          <button className="btn sm" onClick={() => resolve(true)}>
            Overwrite with mine
          </button>
        </div>
      )}
      {size > MAX_NOTE_BYTES ? (
        <div className="automate-blocked">
          <TriangleAlert size={13} /> Too large to save: notes are limited to {MAX_NOTE_BYTES / 1024} KB. Split it into several notes.
        </div>
      ) : (
        size >= LARGE_NOTE_BYTES && (
          <div className="automate-blocked">
            <TriangleAlert size={13} /> Large note ({sizeLabel(size)}). Agents read it in pieces; the limit is {MAX_NOTE_BYTES / 1024} KB.
          </div>
        )
      )}
      <textarea className="task-notes note-text" spellCheck placeholder="Write anything. Plain text." value={text} onChange={(e) => change({ text: e.target.value })} autoFocus={!note.text} />
    </div>
  )
}

function SaveIndicator({ status, error, outside }: { status: SaveState; error: string; outside?: string }): ReactNode {
  if (status === 'saving')
    return (
      <span className="note-save">
        <Loader2 size={12} className="spin" /> Saving…
      </span>
    )
  if (status === 'dirty') return <span className="note-save">Editing…</span>
  if (status === 'error')
    return (
      <span className="note-save danger" title={error}>
        <CircleAlert size={12} /> Not saved: {error}
      </span>
    )
  if (status === 'conflict')
    return (
      <span className="note-save warn">
        <CircleAlert size={12} /> Not saved: changed on disk
      </span>
    )
  if (status === 'toolarge')
    return (
      <span className="note-save danger">
        <CircleAlert size={12} /> Not saved: too large
      </span>
    )
  return (
    <span className="note-save ok">
      <Check size={12} /> Saved{outside ? ` · updated by ${outside}` : ''}
    </span>
  )
}
