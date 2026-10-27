import { app } from 'electron'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { TASK_COLUMNS, type Task, type TaskColumn, type TaskFile } from '@shared/types'
import { attachmentKind, attachProblem, safeAttachmentName, uniqueName, validAttachments, type BoardAttachment } from '@shared/board'
import { checkBlockedBy, cleanBlockedBy, loopPath } from '@shared/blockers'
import { parseTaskModel } from '@shared/models'

// Plain JSON so other tools (the assistant, later) can read and edit tasks too.
// Removed tasks are deleted, not archived. Done (#138) is a column like the others: a task there stays until it's removed.
const file = (): string => join(app.getPath('userData'), 'tasks.json')

// Attached files (#187), built on the board's (#147): copies, one folder per task, task-files	<id>\<safe name>, under the
// data folder that agents are denied (#91). Agents read them only through read_task_file (taskFileTools.ts), for their own task.
const filesRoot = (): string => join(app.getPath('userData'), 'task-files')
const filesFolder = (id: number): string => join(filesRoot(), `t${id}`)
/** A removed task's files wait this long, so Undo brings them back with it; then they go if the task is still gone. */
export const REMOVED_FILES_KEEP_MS = 5 * 60_000

let data: TaskFile = { nextId: 1, tasks: [] }
let emit: (tasks: Task[]) => void = () => {}
let lastWrite = 0

/** A project (#73) for a task: by id, name or folder; worktree folders count as their repo's project. */
export interface ProjectResolver {
  /** id, name or path -> the project's id and primary folder */
  resolve: (q: string) => { id: string; folder: string } | undefined
  /** a folder path -> the id of the project it files under */
  forPath: (path: string) => string | undefined
  /** one of a project's folders by label or path -> its current path (3/5) */
  folder: (id: string, q: string) => string | undefined
}
let projects: ProjectResolver = { resolve: () => undefined, forPath: () => undefined, folder: () => undefined }

/** What a task tool hears when it tries to put a task on Fable (#136): only the user's pick in the editor can. */
export const TASK_FABLE_REFUSED =
  "Fable can only be set on a task by the user, in the task editor: open the task and pick Fable under Model, which asks them first. Haiku, Sonnet and Opus (or default) can be set here."

/** Tasks whose model was Fable when they were removed: Undo brings them back on Fable without asking again. */
const removedFable = new Set<number>()
/** Undo of a task that was on Fable: it comes back on Fable without asking again. */
export const restoresFable = (input: Partial<Task>): boolean => !!input.id && !find(input.id) && removedFable.has(input.id)

/**
 * `before` (each task's model as it was) is passed when tasks.json changed outside the app: a task that wasn't on Fable
 * doesn't go onto it that way (#136), since only the user's pick in the editor can; it keeps its previous model.
 */
function load(before?: Map<number, Task['model']>): boolean {
  let refused = false
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as TaskFile
    data = { nextId: raw.nextId ?? 1, tasks: Array.isArray(raw.tasks) ? raw.tasks : [] }
    // older files have no blockedBy; a hand-edited one is tidied, never refused
    for (const t of data.tasks) {
      const ids = cleanBlockedBy(t.blockedBy, t.id)
      if (ids) t.blockedBy = ids
      else delete t.blockedBy
      // a column this version doesn't know (a hand edit, say) would hide the task: it goes to Backlog instead
      if (!(TASK_COLUMNS as readonly string[]).includes(t.column)) t.column = 'backlog'
      // priority is gone (#134): an older file's value is dropped here and so leaves the file on the next save
      delete (t as { priority?: unknown }).priority
      // a task's model (#136): older files have none, and anything that isn't a model means "follow Settings"
      const model = parseTaskModel(t.model)
      if (model) t.model = model
      else delete t.model
      // attached files (#187): older tasks have none; a hand-edited list that isn't valid is dropped, never trusted
      if (t.attachments !== undefined && (!validAttachments(t.attachments) || !t.attachments.length)) delete t.attachments
      if (before && t.model === 'fable' && before.get(t.id) !== 'fable') {
        console.warn(`[tasks] #${t.id} was set to Fable outside Corvid; kept on ${before.get(t.id) ?? 'the Settings model'}`)
        refused = true
        if (before.get(t.id)) t.model = before.get(t.id)
        else delete t.model
      }
    }
    data.nextId = Math.max(data.nextId, ...data.tasks.map((t) => t.id + 1))
  } catch {
    /* first run */
  }
  return refused
}

function save(): void {
  lastWrite = Date.now()
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file())
  emit(data.tasks)
}

/**
 * Older tasks hold a folder path: give each the id of the project that folder files under. Only adds
 * projectId; the title, notes and path stay exactly as they were. tasks.json.bak is saved first.
 */
export function fillProjectIds(): void {
  const fill = data.tasks.filter((t) => !t.projectId && t.project).map((t) => [t, projects.forPath(t.project!)] as const).filter(([, id]) => id)
  if (!fill.length) return
  if (existsSync(file()) && !existsSync(file() + '.bak')) copyFileSync(file(), file() + '.bak')
  for (const [t, id] of fill) t.projectId = id
  save()
}

/** `project` as typed (an id, a name or a path) -> projectId plus the folder; unknown text is kept as a path. */
function withProject<T extends Partial<Task>>(input: T, current?: Task): T {
  const out = withProjectOnly(input)
  // a changed project drops the folder choice unless one comes with it; a folder is checked against the project
  if (!('folder' in out) && 'projectId' in out && current?.folder && out.projectId !== current.projectId) return { ...out, folder: undefined }
  if (!('folder' in out)) return out
  const id = 'projectId' in out ? out.projectId : current?.projectId
  if (!out.folder) return { ...out, folder: undefined }
  const path = id ? projects.folder(id, out.folder) : undefined
  if (!path) throw new Error(`"${out.folder}" isn't one of the project's folders. Use a folder's label or path, or leave it empty for the primary folder.`)
  return { ...out, folder: path }
}

function withProjectOnly<T extends Partial<Task>>(input: T): T {
  if (!('project' in input) && !('projectId' in input)) return input
  const q = input.projectId || input.project
  if (!q) return { ...input, project: undefined, projectId: undefined }
  // a subfolder or an agent worktree counts as its project, which works in its own folder
  const p = projects.resolve(q) ?? projects.resolve(projects.forPath(q) ?? '')
  if (p) return { ...input, projectId: p.id, project: p.folder }
  return { ...input, projectId: undefined, project: q }
}

/**
 * Merging projects (3/5): every task of `from` files under `into` and keeps working in the folder it worked in.
 * Returns how to put each one back exactly. tasks.json.bak-merge is saved first.
 */
export function refileTasks(fromId: string, intoId: string, folderOf: (t: Task) => string | undefined): () => void {
  const moved = data.tasks.filter((t) => t.projectId === fromId)
  if (!moved.length) return () => {}
  copyFileSync(file(), file() + '.bak-merge')
  const before = moved.map((t) => ({ id: t.id, projectId: t.projectId, project: t.project, folder: t.folder }))
  for (const t of moved) {
    const folder = folderOf(t)
    t.projectId = intoId
    if (folder) t.folder = folder
  }
  save()
  return () => {
    for (const b of before) {
      const t = find(b.id)
      if (!t) continue
      t.projectId = b.projectId
      t.project = b.project
      if (b.folder) t.folder = b.folder
      else delete t.folder
    }
    save()
  }
}

export function initTasks(onChange: (tasks: Task[]) => void, resolver: ProjectResolver): void {
  emit = onChange
  projects = resolver
  load()
  if (!existsSync(file())) save()
  fillProjectIds()
  sweepTaskFiles()
  // Pick up edits made outside the app; ignore the echo of our own writes.
  watch(app.getPath('userData'), (_evt, name) => {
    if (name !== 'tasks.json' || Date.now() - lastWrite < 500) return
    setTimeout(() => {
      if (load(new Map(data.tasks.map((t) => [t.id, t.model])))) save()
      emit(data.tasks)
      fillProjectIds()
    }, 100)
  })
}

/** The folder a task works in: the project folder it names (3/5), else its project's primary folder, else the path it was made with. */
export function taskFolder(t: Task): string | undefined {
  return (t.projectId && t.folder && projects.folder(t.projectId, t.folder)) || (t.projectId && projects.resolve(t.projectId)?.folder) || t.project
}

export function listTasks(): Task[] {
  return data.tasks
}

const find = (id: number): Task | undefined => data.tasks.find((t) => t.id === id)

/** A checked blockedBy list for task `id`, or throws with a message for the user. */
function blockers(id: number | undefined, list: unknown, previous?: number[]): number[] | undefined {
  const r = checkBlockedBy(id, list, previous, find)
  if (r.error) throw new Error(r.error)
  return r.ids
}

/**
 * A task's model as given (#136): the choice, or null for "follow Settings". Fable needs `fable`: the user confirmed it
 * in Corvid's own dialog (index.ts). Throws with a message for the user otherwise.
 */
function modelFor(given: unknown, current: Task['model'], fable: boolean): Task['model'] | null {
  const m = parseTaskModel(given)
  if (m === undefined) throw new Error(`"${String(given)}" isn't a model. Use haiku, sonnet or opus, or default to follow the worker model in Settings.`)
  if (m === 'fable' && current !== 'fable' && !fable) throw new Error(TASK_FABLE_REFUSED)
  return m
}

/** `fable`: the user confirmed Fable for this task in Corvid's dialog (#136); nothing else may put a task on Fable. */
export interface ModelConsent {
  fable?: boolean
}

const nextOrder = (column: TaskColumn): number =>
  Math.max(0, ...data.tasks.filter((t) => t.column === column).map((t) => t.order)) + 1

export function createTask(typed: Partial<Task> & { title: string }, consent: ModelConsent = {}): Task {
  const input = withProject(typed)
  const now = Date.now()
  const column = input.column ?? 'backlog'
  // only Undo passes an id: the task comes back with its own list, keeping ids of tasks that are gone
  // (they count as resolved) and quietly leaving out any that would now close a loop
  const restoring = !!input.id && !find(input.id)
  const blockedBy = restoring
    ? cleanBlockedBy(input.blockedBy, input.id)?.filter((b) => !loopPath(input.id!, b, find))
    : input.blockedBy === undefined
      ? undefined
      : blockers(undefined, input.blockedBy)
  // Undo brings a task back on the model it had, Fable included, without asking again
  const model = modelFor(input.model, undefined, !!consent.fable || (restoring && removedFable.has(input.id!)))
  const task: Task = {
    id: restoring ? input.id! : data.nextId++,
    title: input.title.trim(),
    notes: input.notes ?? '',
    column,
    order: input.order ?? nextOrder(column),
    project: input.project,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.projectId && input.folder ? { folder: input.folder } : {}),
    sessionId: input.sessionId,
    source: input.source,
    ...(blockedBy?.length ? { blockedBy } : {}),
    ...(model ? { model } : {}),
    // only Undo brings files back, and only those still kept on disk; a copy or a new task starts without any (#187)
    ...(restoring && restoredFiles(input.id!, input.attachments).length ? { attachments: restoredFiles(input.id!, input.attachments) } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: now
  }
  data.nextId = Math.max(data.nextId, task.id + 1)
  data.tasks.push(task)
  save()
  return task
}

export function updateTask(id: number, typed: Partial<Task>, consent: ModelConsent = {}): Task | undefined {
  const t = data.tasks.find((x) => x.id === id)
  if (!t) return undefined
  // priority is ignored since #134; attachments change only through addTaskFiles and removeTaskFile (#187)
  const { priority: _gone, attachments: _files, ...rest } = typed as Partial<Task> & { priority?: unknown }
  const patch = withProject(rest, t)
  const movedColumn = patch.column && patch.column !== t.column
  // checked before anything changes, so a refused list leaves the task as it was
  const blockedBy = 'blockedBy' in patch ? blockers(id, patch.blockedBy ?? [], t.blockedBy) : t.blockedBy
  const model = 'model' in patch ? modelFor(patch.model, t.model, !!consent.fable) : t.model
  Object.assign(t, patch, { id, updatedAt: Date.now() })
  if (model) t.model = model
  else delete t.model
  if (blockedBy) t.blockedBy = blockedBy
  else delete t.blockedBy
  if (!t.projectId) delete t.projectId
  if (!t.projectId || !t.folder) delete t.folder
  if (movedColumn && patch.order === undefined) t.order = nextOrder(t.column)
  save()
  return t
}

/** Finishing a task (done or discard, the same thing): it is gone. Returns it so the UI can offer undo. */
export function removeTask(id: number): Task | undefined {
  const t = data.tasks.find((x) => x.id === id)
  if (t?.model === 'fable') removedFable.add(id)
  data.tasks = data.tasks.filter((x) => x.id !== id)
  save()
  // its files stay for the undo window, then go unless Undo brought the task back (#187)
  if (t?.attachments?.length) setTimeout(() => !find(id) && rmSync(filesFolder(id), { recursive: true, force: true }), REMOVED_FILES_KEEP_MS).unref?.()
  return t
}

// ---------- attached files (#187) ----------

/** Where a task's attached file is stored (by its number from 0, or its name), or undefined when it has no such file. */
export function taskFilePath(id: number, which: number | string): { path: string; att: BoardAttachment; index: number } | undefined {
  const list = find(id)?.attachments ?? []
  const index = typeof which === 'number' ? which : list.findIndex((a) => a.name.toLowerCase() === which.toLowerCase())
  const att = list[index]
  return att ? { path: join(filesFolder(id), att.name), att, index } : undefined
}

/** Undo's list: only the entries whose copy is still on disk. */
function restoredFiles(id: number, list: unknown): BoardAttachment[] {
  if (!validAttachments(list)) return []
  return list.filter((a) => existsSync(join(filesFolder(id), a.name)))
}

/**
 * Copy files onto a task, under safe names unique within it, within the board's limits counted with what it already has.
 * Only the window calls this (index.ts). On any failure the files written here go again and the task is left as it was.
 */
export function addTaskFiles(id: number, files: { name: string; data: Uint8Array }[]): Task {
  const t = find(id)
  if (!t) throw new Error(`Task #${id} doesn't exist.`)
  if (!files.length) return t
  const have = t.attachments ?? []
  const problem = attachProblem([...have, ...files.map((f) => ({ name: f.name, size: f.data.byteLength }))], 'one task')
  if (problem) throw new Error(problem)
  const folder = filesFolder(id)
  const added: BoardAttachment[] = []
  try {
    mkdirSync(folder, { recursive: true })
    for (const f of files) {
      // unique against the list and against anything left on disk, and 'wx' never overwrites
      const taken = [...have, ...added].map((a) => a.name).concat(readdirSync(folder))
      const name = uniqueName(safeAttachmentName(f.name), taken)
      writeFileSync(join(folder, name), f.data, { flag: 'wx' })
      added.push({ name, size: f.data.byteLength, kind: attachmentKind(name) })
    }
    t.attachments = [...have, ...added]
    t.updatedAt = Date.now()
    save()
  } catch (e) {
    for (const a of added) rmSync(join(folder, a.name), { force: true })
    if (have.length) t.attachments = have
    else delete t.attachments
    throw new Error(`Couldn't attach the files: ${(e as Error).message}`)
  }
  return t
}

/** Take one file off a task and delete its copy. */
export function removeTaskFile(id: number, index: number): Task {
  const found = taskFilePath(id, index)
  const t = find(id)
  if (!t || !found) throw new Error('That file is no longer on the task.')
  const rest = (t.attachments ?? []).filter((_, i) => i !== found.index)
  if (rest.length) t.attachments = rest
  else delete t.attachments
  t.updatedAt = Date.now()
  save()
  rmSync(found.path, { force: true })
  return t
}

/** On start: folders of tasks that are gone (their undo window passed with the app closed) and files no task lists (a save
 *  that failed half way) are deleted. */
export function sweepTaskFiles(): void {
  let names: string[] = []
  try {
    names = readdirSync(filesRoot())
  } catch {
    return
  }
  for (const n of names) {
    const t = find(Number(/^t(\d+)$/.exec(n)?.[1] ?? NaN))
    const folder = join(filesRoot(), n)
    if (!t?.attachments?.length) {
      rmSync(folder, { recursive: true, force: true })
      continue
    }
    const keep = new Set(t.attachments.map((a) => a.name.toLowerCase()))
    try {
      for (const f of readdirSync(folder)) if (!keep.has(f.toLowerCase())) rmSync(join(folder, f), { recursive: true, force: true })
    } catch {
      /* not a folder: gone above next time */
    }
  }
}

/** Bytes the tasks' attached files take, for the storage display. */
export const taskFilesBytes = (): number => data.tasks.reduce((s, t) => s + (t.attachments ?? []).reduce((a, f) => a + f.size, 0), 0)

/** Set a column's contents and order in one go (drag and drop). */
export function arrangeColumn(column: TaskColumn, ids: number[]): void {
  ids.forEach((id, i) => {
    const t = data.tasks.find((x) => x.id === id)
    if (t) {
      if (t.column !== column) t.updatedAt = Date.now()
      t.column = column
      t.order = i + 1
    }
  })
  save()
}
