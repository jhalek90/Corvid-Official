import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Note, NoteAuthor } from '@shared/types'
import { MAX_NOTE_BYTES } from '@shared/notes'
import { headChars } from '@shared/text'

// One plain Markdown file per note in <data>\notes\, so notes open fine in VS Code and never get
// stuck in a database. A small header between "---" lines holds the id, name, author and times;
// the rest of the file is the text. IDs (N1, N2, …) are never reused: the next one is kept in
// .notes.json, which also remembers which agent-written notes are still unread.
// Deleted notes go to notes\trash\ and are cleared out after TRASH_DAYS.

const TRASH_DAYS = 30

const dir = (): string => join(app.getPath('userData'), 'notes')
const trashDir = (): string => join(dir(), 'trash')
const metaFile = (): string => join(dir(), '.notes.json')

interface Meta {
  nextId: number
  unread: string[]
}

let meta: Meta = { nextId: 1, unread: [] }
let notes: Note[] = []
let emit: (notes: Note[]) => void = () => {}

/** who is making a change, for the header's updated-by and for new notes' author */
export interface NoteWho {
  author: NoteAuthor
  agentName?: string
  taskId?: number
}

export const whoLabel = (w: NoteWho): string =>
  w.author === 'agent' ? (w.agentName ? `${w.agentName} (#${w.taskId})` : `worker for #${w.taskId}`) : w.author

const hash = (raw: string): string => createHash('sha1').update(raw).digest('hex').slice(0, 12)
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')
const cleanName = (s: string): string => headChars(s.replace(/\s+/g, ' ').trim(), 120) || 'Untitled note'

export const isNoteId = (s: string): boolean => /^#?n\d+$/i.test(s.trim())
export const normalId = (s: string): string => s.trim().replace(/^#/, '').toUpperCase()

// ---------- file format ----------

function serialize(n: Note): string {
  const head: [string, string | number | undefined][] = [
    ['id', n.id],
    ['name', n.name],
    ['author', n.author],
    ['agent', n.agentName],
    ['task', n.taskId],
    ['project', n.project],
    ['created', new Date(n.created).toISOString()],
    ['updated', new Date(n.updated).toISOString()],
    ['updated-by', n.updatedBy]
  ]
  const lines = head.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`)
  return `---\n${lines.join('\n')}\n---\n\n${n.text}`
}

function parse(raw: string): { head: Record<string, string>; text: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (!m) return { head: {}, text: raw }
  const head: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) head[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return { head, text: raw.slice(m[0].length).replace(/^\r?\n/, '') }
}

const time = (s: string | undefined, fallback: number): number => {
  const t = s ? Date.parse(s) : NaN
  return Number.isFinite(t) ? t : fallback
}

function fromFile(file: string, raw: string): Note {
  const { head, text } = parse(raw)
  const st = statSync(file)
  const updated = time(head.updated, st.mtimeMs)
  const author = (['user', 'assistant', 'agent'] as const).find((a) => a === head.author) ?? 'user'
  const note: Note = {
    id: head.id && isNoteId(head.id) ? normalId(head.id) : '',
    name: cleanName(head.name ?? basename(file).replace(/\.md$/i, '')),
    text,
    author,
    agentName: head.agent || undefined,
    taskId: head.task && Number.isFinite(Number(head.task)) ? Number(head.task) : undefined,
    project: head.project || undefined,
    created: time(head.created, st.birthtimeMs || st.mtimeMs),
    updated,
    updatedBy: head['updated-by'] || undefined,
    size: bytes(text),
    rev: hash(raw),
    file
  }
  // Saved by an editor that doesn't know about the header: the file's own time is the real one.
  if (st.mtimeMs > updated + 2000) {
    note.updated = st.mtimeMs
    note.updatedBy = 'outside Corvid'
  }
  return note
}

/** Write to a temporary file, then rename over the real one, so a crash never leaves half a note. */
function atomicWrite(file: string, raw: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.tmp`)
  writeFileSync(tmp, raw)
  renameSync(tmp, file)
}

function writeNote(n: Note): void {
  const raw = serialize(n)
  atomicWrite(n.file, raw)
  n.rev = hash(raw)
  n.size = bytes(n.text)
}

function saveMeta(): void {
  atomicWrite(metaFile(), JSON.stringify(meta, null, 2))
}

const idNum = (id: string): number => Number(id.slice(1)) || 0

function allocId(): string {
  const id = `N${meta.nextId++}`
  saveMeta()
  return id
}

// ---------- loading and watching ----------

const noteFiles = (d: string): string[] => {
  try {
    return readdirSync(d).filter((f) => /\.md$/i.test(f) && !f.startsWith('.'))
  } catch {
    return []
  }
}

function load(): boolean {
  const before = new Map(notes.map((n) => [n.file, n]))
  const next: Note[] = []
  const seen = new Set<string>()
  let changed = false
  for (const f of noteFiles(dir())) {
    const file = join(dir(), f)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const old = before.get(file)
    let n = old && old.rev === hash(raw) ? old : fromFile(file, raw)
    // A file dropped in by hand, or a copy of another note: give it an ID of its own.
    if (!n.id || seen.has(n.id)) {
      n = { ...n, id: allocId() }
      writeNote(n)
    }
    if (n !== old) changed = true
    seen.add(n.id)
    next.push(n)
  }
  if (next.length !== before.size) changed = true
  const maxId = Math.max(0, ...next.map((n) => idNum(n.id)))
  if (meta.nextId <= maxId) {
    meta.nextId = maxId + 1
    saveMeta()
  }
  notes = next
  for (const n of notes) n.unread = meta.unread.includes(n.id) || undefined
  return changed
}

function loadMeta(): void {
  try {
    const raw = JSON.parse(readFileSync(metaFile(), 'utf8')) as Partial<Meta>
    meta = { nextId: Number(raw.nextId) || 1, unread: Array.isArray(raw.unread) ? raw.unread : [] }
  } catch {
    /* first run */
  }
  // Notes in the trash still own their IDs.
  for (const f of noteFiles(trashDir())) {
    try {
      const id = parse(readFileSync(join(trashDir(), f), 'utf8')).head.id
      if (id && isNoteId(id)) meta.nextId = Math.max(meta.nextId, idNum(normalId(id)) + 1)
    } catch {
      /* skip */
    }
  }
}

function purgeTrash(): void {
  const cutoff = Date.now() - TRASH_DAYS * 86400_000
  for (const f of noteFiles(trashDir())) {
    const file = join(trashDir(), f)
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file)
    } catch {
      /* leave it */
    }
  }
}

const publish = (): void => emit(notes)

export function initNotes(onChange: (notes: Note[]) => void): void {
  emit = onChange
  mkdirSync(trashDir(), { recursive: true })
  loadMeta()
  purgeTrash()
  load()
  if (!existsSync(metaFile())) saveMeta()
  // Pick up edits made outside the app. Our own writes come back as events too; their hash matches
  // what's in memory, so they change nothing.
  let timer: NodeJS.Timeout | null = null
  watch(dir(), (_evt, name) => {
    if (!name || name.startsWith('.') || !/\.md$/i.test(name)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (load()) publish()
    }, 150)
  })
}

// ---------- reading ----------

export const listNotes = (): Note[] => notes
export const getNote = (id: string): Note | undefined => notes.find((n) => n.id === normalId(id))

export function inTrash(id: string): boolean {
  const want = normalId(id)
  return noteFiles(trashDir()).some((f) => {
    try {
      return normalId(parse(readFileSync(join(trashDir(), f), 'utf8')).head.id ?? '') === want
    } catch {
      return false
    }
  })
}

// ---------- changing ----------

function checkSize(text: string): void {
  const b = bytes(text)
  if (b > MAX_NOTE_BYTES)
    throw new Error(`Notes are limited to ${MAX_NOTE_BYTES / 1024} KB; this would be ${Math.ceil(b / 1024)} KB. Split it into several notes.`)
}

function setUnread(id: string, on: boolean): void {
  const has = meta.unread.includes(id)
  if (on === has) return
  meta.unread = on ? [...meta.unread, id] : meta.unread.filter((x) => x !== id)
  saveMeta()
  const n = notes.find((x) => x.id === id)
  if (n) n.unread = on || undefined
}

export function createNote(input: { name: string; text: string; project?: string }, who: NoteWho): Note {
  checkSize(input.text)
  const now = Date.now()
  const id = allocId()
  const n: Note = {
    id,
    name: cleanName(input.name),
    text: input.text,
    author: who.author,
    agentName: who.agentName,
    taskId: who.taskId,
    project: input.project,
    created: now,
    updated: now,
    updatedBy: whoLabel(who),
    size: 0,
    rev: '',
    file: join(dir(), `${id}.md`)
  }
  writeNote(n)
  notes = [...notes, n]
  if (who.author !== 'user') setUnread(id, true)
  publish()
  return n
}

/**
 * Rename or rewrite a note. With baseRev (the editor's copy), a note that changed on disk since is
 * not overwritten: the fresh version comes back as `conflict` instead.
 */
export function updateNote(id: string, patch: { name?: string; text?: string }, who: NoteWho, baseRev?: string): { note: Note } | { conflict: Note } {
  const n = getNote(id)
  if (!n) throw new Error(`${normalId(id)} doesn't exist.`)
  if (patch.text !== undefined) checkSize(patch.text)
  let disk: string | undefined
  try {
    disk = readFileSync(n.file, 'utf8')
  } catch {
    /* gone from disk: writing brings it back */
  }
  if (disk !== undefined && hash(disk) !== n.rev) {
    // Changed outside the app and the watcher hasn't caught up yet.
    load()
    publish()
  }
  const cur = getNote(id)!
  if (baseRev && cur.rev !== baseRev) return { conflict: cur }
  const next: Note = {
    ...cur,
    name: patch.name !== undefined ? cleanName(patch.name) : cur.name,
    text: patch.text ?? cur.text,
    updated: Date.now(),
    updatedBy: whoLabel(who)
  }
  writeNote(next)
  notes = notes.map((x) => (x.id === cur.id ? next : x))
  publish()
  return { note: next }
}

export function appendNote(id: string, text: string, who: NoteWho): Note {
  const n = getNote(id)
  if (!n) throw new Error(`${normalId(id)} doesn't exist.`)
  const joined = n.text && !n.text.endsWith('\n') ? `${n.text}\n\n${text}` : `${n.text}${n.text ? '\n' : ''}${text}`
  const r = updateNote(id, { text: joined }, who)
  if ('conflict' in r) throw new Error('The note changed while appending; try again.')
  if (who.author !== 'user') setUnread(r.note.id, true)
  publish()
  return r.note
}

/** Moves the note to the trash folder; restoreNote brings it back. */
export function deleteNote(id: string): Note | undefined {
  const n = getNote(id)
  if (!n) return undefined
  const to = join(trashDir(), basename(n.file))
  rmSync(to, { force: true })
  renameSync(n.file, to)
  // the trash is cleared by age, counted from the delete
  utimesSync(to, new Date(), new Date())
  notes = notes.filter((x) => x.id !== n.id)
  setUnread(n.id, false)
  publish()
  return n
}

export function restoreNote(id: string): Note | undefined {
  const want = normalId(id)
  for (const f of noteFiles(trashDir())) {
    const from = join(trashDir(), f)
    let raw: string
    try {
      raw = readFileSync(from, 'utf8')
    } catch {
      continue
    }
    if (normalId(parse(raw).head.id ?? '') !== want) continue
    let to = join(dir(), f)
    if (existsSync(to)) to = join(dir(), `${want}-restored-${Date.now()}.md`)
    renameSync(from, to)
    // back to its own last-updated time, so it doesn't look edited outside the app
    const updated = new Date(time(parse(raw).head.updated, Date.now()))
    utimesSync(to, updated, updated)
    load()
    publish()
    return getNote(want)
  }
  return undefined
}

export function markSeen(id: string): void {
  if (!meta.unread.includes(normalId(id))) return
  setUnread(normalId(id), false)
  publish()
}

export const notesDir = dir
