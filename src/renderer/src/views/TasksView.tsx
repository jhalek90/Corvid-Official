import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { addToEditor, attachToTask, pastedFiles, TaskFilesBadge, TaskFilesField, useFileDrop } from '../components/TaskAttachments'
import { releaseStaged, type Staged } from '../components/BoardAttachments'
import { createPortal } from 'react-dom'
import { Bot, FolderOpen, Hourglass, Link2, Lock, Plus, Search, Trash2, TriangleAlert, WandSparkles, X, MessageSquare, Zap } from 'lucide-react'
import type { AssistantModel, Task, TaskColumn } from '@shared/types'
import type { CustomModelRef } from '@shared/customModels'
import { effectiveAssistantMode } from '@shared/customModels'
import { choiceLabel } from '@shared/models'
import { BLOCKER_STATE, blockedTasks, blockerLabel, blockerProblem, MAX_BLOCKERS, notStarted, openBlockers } from '@shared/blockers'
import { baseName, projectKey } from '@shared/projects'
import { SECRET_WARNING, secretKindIn } from '@shared/secretRules'
import { api } from '../api'
import { editTask, finishTask, finishTasks, getState, openProject, openTerminal, setState, showSession, toast, useStore } from '../store'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { relTime } from '../format'
import { useProjects } from './ProjectsView'
import { primaryFolder } from '@shared/projectList'
import { workedMs } from '@shared/workerClock'
import { taskProject, useScope } from '../scope'
import { ScopeChip } from '../components/ProjectSwitcher'
import { InfoTip } from '../components/Tooltip'
import { ModelOptions } from '../components/ModelOptions'
import { workerModelLabel } from '../components/Assistant'
import { mod } from '../keys'

export const COLUMNS: { id: TaskColumn; label: string; hint: string }[] = [
  { id: 'backlog', label: 'Backlog', hint: 'Everything that should happen eventually' },
  { id: 'next', label: 'Up next', hint: 'What you’ll pick up soon' },
  { id: 'doing', label: 'In progress', hint: 'Being worked on now' },
  { id: 'done', label: 'Done', hint: 'Finished tasks wait here until you remove them' }
]

/** The project's name on a card (#73): looked up by id, else the folder's name. */
function projectName(t: { projectId?: string; project?: string }): string {
  const p = getState().projects.projects.find((x) => x.id === t.projectId)
  return p?.name ?? baseName(t.project ?? '')
}

/** Which folder a task works in, for a project with several (3/5): its label, or the primary one's. */
function folderLabel(t: { projectId?: string; folder?: string }): string | undefined {
  const p = getState().projects.projects.find((x) => x.id === t.projectId)
  if (!p || p.folders.length < 2) return undefined
  const f = (t.folder && p.folders.find((x) => x.path === t.folder)) || p.folders.find((x) => x.primary) || p.folders[0]
  return f.label || baseName(f.path)
}

export function TasksView(): ReactNode {
  const tasks = useStore((s) => s.tasks)
  const blocker = useStore((s) => s.assistant.blocker)
  const [q, setQ] = useState('')
  const [project, setProject] = useState('')
  const [drag, setDrag] = useState<{ id: number; over?: TaskColumn; index?: number } | null>(null)
  const [hideBlocked, setHideBlocked] = useState(false)
  const find = useFinder()

  // by project id; a task whose folder is on no project yet is grouped by its folder
  const list = useStore((s) => s.projects.projects)
  const filterKey = (t: Task): string => t.projectId ?? (t.project ? projectKey(t.project) : '')
  const projects = useMemo(() => {
    const m = new Map<string, Task>()
    for (const t of tasks) if (filterKey(t)) m.set(filterKey(t), t)
    return [...m.entries()].map(([key, t]) => ({ key, t, name: projectName(t) })).sort((a, b) => a.name.localeCompare(b.name))
  }, [tasks, list]) // eslint-disable-line react-hooks/exhaustive-deps

  // the project switcher (#77) wins over the page's own project filter while a project is chosen
  const scope = useScope()
  const proj = scope?.id ?? project
  const needle = q.trim().toLowerCase()
  const visible = tasks.filter(
    (t) =>
      (scope ? taskProject(t) === scope.id : !project || filterKey(t) === project) &&
      (!needle || `#${t.id} ${t.title} ${t.notes} ${t.project ?? ''}`.toLowerCase().includes(needle)) &&
      (!hideBlocked || !openBlockers(t, find).length)
  )
  const hiddenBlocked = hideBlocked ? tasks.filter((t) => openBlockers(t, find).length).length : 0
  const byColumn = (c: TaskColumn): Task[] => visible.filter((t) => t.column === c).sort((a, b) => a.order - b.order)
  // Done tasks are finished, so "open" leaves them out (#138)
  const open = (list: Task[]): number => list.filter((t) => t.column !== 'done').length
  const doneCount = (scope ? visible : tasks).length - open(scope ? visible : tasks)

  const drop = (column: TaskColumn): void => {
    if (!drag) return
    const ids = tasks
      .filter((t) => t.column === column && t.id !== drag.id)
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id)
    // index is relative to the visible (filtered) cards; map it onto the full column
    const shown = byColumn(column).filter((t) => t.id !== drag.id)
    const anchor = shown[drag.index ?? shown.length]
    const at = anchor ? ids.indexOf(anchor.id) : ids.length
    ids.splice(at < 0 ? ids.length : at, 0, drag.id)
    void api.arrangeTasks(column, ids)
    setDrag(null)
  }

  return (
    <div className="tasks">
      <div className="tasks-head">
        <div>
          <h2>
            Tasks
            <ScopeChip />
          </h2>
          <p className="muted" style={{ whiteSpace: 'nowrap' }}>
            {scope ? `${open(visible)} open here · ${open(tasks)} in all` : `${open(tasks)} open`}
            {doneCount > 0 && ` · ${doneCount} done`}
            {hiddenBlocked > 0 && ` · ${hiddenBlocked} blocked hidden`}{' '}
            <InfoTip tip="Finished tasks go to Done: drag them there, or they move by themselves when a worker's branch is merged. Remove a task from its card in Done, or with Remove… in its editor. It is deleted, with Undo for a few seconds." />
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div className="input-wrap" style={{ width: 220 }}>
            <Search size={14} />
            <input className="input" spellCheck placeholder="Filter tasks…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button
            className={`btn ghost sm hide-blocked${hideBlocked ? ' on' : ''}`}
            aria-pressed={hideBlocked}
            aria-label="Hide blocked tasks"
            title={hideBlocked ? 'Show tasks that are blocked by unfinished ones again' : 'Show only tasks that are ready to start: hide those blocked by unfinished tasks'}
            onClick={() => setHideBlocked(!hideBlocked)}
          >
            <Lock size={13} /> <span>{hideBlocked ? 'Show blocked' : 'Hide blocked'}</span>
          </button>
          {!scope && (
            <select className="select" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="btn primary"
            data-tour="board.add-task"
            onClick={() =>
              editTask(
                scope
                  ? { projectId: scope.id, project: primaryFolder(scope) }
                  : project
                    ? { projectId: projects.find((p) => p.key === project)?.t.projectId, project: projects.find((p) => p.key === project)?.t.project }
                    : {}
              )
            }
          >
            <Plus size={14} /> New task
          </button>
        </div>
      </div>

      {blocker && (
        <div className="automate-blocked">
          <TriangleAlert size={13} /> Automate is paused: {blocker}
        </div>
      )}

      <div className="kanban" data-tour="board.columns">
        {COLUMNS.map((col) => {
          const items = byColumn(col.id)
          return (
            <div
              key={col.id}
              data-tour={col.id === 'done' ? 'board.done-column' : undefined}
              className={`kcol${drag?.over === col.id ? ' over' : ''}`}
              onDragOver={(e) => {
                if (!drag) return
                e.preventDefault()
                const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('.tcard:not(.dragging)')]
                const index = cards.findIndex((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2)
                setDrag({ ...drag, over: col.id, index: index < 0 ? cards.length : index })
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag((d) => (d ? { ...d, over: undefined } : d))
              }}
              onDrop={(e) => {
                e.preventDefault()
                drop(col.id)
              }}
            >
              <div className="kcol-head">
                <span className="kname">{col.label}</span>
                <span className="kcount">{items.length}</span>
                {col.id === 'done' && items.length > 1 && <RemoveAllDone items={items} />}
              </div>
              {col.id === 'backlog' && <QuickAdd project={proj} />}
              <div className="kcards">
                {(() => {
                  // drop index counts only the cards that aren't being dragged
                  let ri = 0
                  return items.map((t) => {
                    const isDragged = drag?.id === t.id
                    const lineBefore = !isDragged && drag?.over === col.id && drag.index === ri
                    if (!isDragged) ri++
                    return (
                      <div key={t.id}>
                        {lineBefore && <div className="drop-line" />}
                        <ErrorBoundary area={`Task #${t.id}`}>
                          <TaskCard t={t} done={col.id === 'done'} dragging={isDragged} onDragStart={() => setDrag({ id: t.id })} onDragEnd={() => setDrag(null)} />
                        </ErrorBoundary>
                      </div>
                    )
                  })
                })()}
                {drag?.over === col.id && (drag.index ?? 0) >= items.filter((t) => t.id !== drag.id).length && <div className="drop-line" />}
                {!items.length && !drag && <div className="kempty">{col.hint}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Task titles and notes go into every worker's prompt (#91): a gentle warning, saving still works. */
function SecretWarning({ text }: { text: string }): ReactNode {
  if (!secretKindIn(text)) return null
  return (
    <div className="secret-warning" role="alert">
      <TriangleAlert size={13} /> {SECRET_WARNING}
    </div>
  )
}

function QuickAdd({ project }: { project: string }): ReactNode {
  const [title, setTitle] = useState('')
  return (
    <form
      className="quick-add"
      onSubmit={(e) => {
        e.preventDefault()
        if (!title.trim()) return
        void api.createTask({ title, project: project || undefined })
        setTitle('')
      }}
    >
      <Plus size={14} />
      <input spellCheck placeholder="Add a task, press Enter" value={title} onChange={(e) => setTitle(e.target.value)} />
      <SecretWarning text={title} />
    </form>
  )
}

function TaskCard({
  t,
  done,
  dragging,
  onDragStart,
  onDragEnd
}: {
  t: Task
  done: boolean
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
}): ReactNode {
  const worker = useStore((s) => s.assistant.workers.find((w) => w.taskId === t.id && w.state === 'running'))
  const models = useStore((s) => s.config?.models)
  const [removing, setRemoving] = useState(false)
  // files dropped on the card are attached to the task straight away (#187); a card dragged between columns isn't files
  const drop = useFileDrop((files) => void attachToTask(t, files.map((file) => ({ file }))))
  return (
    <div
      className={`tcard${dragging ? ' dragging' : ''}${drop.dropping ? ' file-drop' : ''}`}
      {...drop.props}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(t.id))
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={() => editTask(t)}
    >
      <div className="tc-top">
        <span className="tid">#{t.id}</span>
        {/* only on Done cards (#138), up here away from the meta row's buttons; it asks first, like the editor's Remove… */}
        {done && (
          <button
            className="tc-remove"
            title="Remove this finished task from the board (asks first)"
            draggable={false}
            onClick={(e) => {
              e.stopPropagation()
              setRemoving(true)
            }}
          >
            <Trash2 size={11} /> Remove
          </button>
        )}
      </div>
      <div className="tc-title">
        {/^(Build|Install) extension[: ]/.test(t.title) && <span className="chip tc-ext" title="An extension build (#98): review and merge it on the extension's page">extension</span>}
        {t.title}
      </div>
      {t.notes && <div className="tc-notes clamp2">{t.notes}</div>}
      <div className="tc-meta">
        {t.project && (
          <span
            className="chip"
            onClick={(e) => {
              e.stopPropagation()
              openProject(t.project!)
            }}
          >
            {projectName(t)}
          </span>
        )}
        {folderLabel(t) && (
          <span className="tc-folder" title={t.folder ? 'Works in this folder' : 'No folder chosen: works in the primary folder'}>
            {folderLabel(t)}
          </span>
        )}
        {t.autoStart && t.column !== 'done' && (
          <span className="tc-auto" title="Starts automatically when its blockers are done" aria-label="Starts automatically when its blockers are done">
            <Zap size={11} />
          </span>
        )}
        {t.model && (
          <span className="tc-model" title={`Workers on this task run on ${choiceLabel(t.model, models)}, not the worker model from Settings`}>
            {choiceLabel(t.model, models)}
          </span>
        )}
        {t.source && t.source !== 'error' && (
          <span className="src" title={t.source}>
            <TriangleAlert size={11} /> flagged
          </span>
        )}
        {t.source === 'error' && (
          <span className="src">
            <TriangleAlert size={11} /> app error
          </span>
        )}
        <BlockChips t={t} />
        <TaskFilesBadge t={t} />
        {t.sessionId && (
          <span
            className="src link"
            onClick={(e) => {
              e.stopPropagation()
              showSession(t.sessionId!)
            }}
          >
            <MessageSquare size={11} /> session
          </span>
        )}
        {worker && (
          <span
            className="src link worker-chip"
            title={`Open ${worker.agentName ?? 'the worker'} in Agents`}
            onClick={(e) => {
              e.stopPropagation()
              openTerminal(worker.termId)
            }}
          >
            <span className={`dot ${worker.liveStatus ?? 'idle'}`} style={{ width: 6, height: 6 }} />
            <Bot size={11} /> worker {Math.floor(workedMs(worker, Date.now()) / 60000)}m
          </span>
        )}
        <span className="when">{relTime(t.createdAt)}</span>
        {/* nothing starts on a finished task (#138) */}
        {!done && <AutomateButton t={t} running={!!worker} />}
      </div>
      {removing && (
        <RemoveConfirm
          t={t}
          onRemove={() => {
            setRemoving(false)
            void finishTask(t.id)
          }}
          onClose={() => setRemoving(false)}
        />
      )}
    </div>
  )
}

/** "Remove all" in Done's header (#138): every Done card showing (the filters apply), after a confirmation that counts them. */
function RemoveAllDone({ items }: { items: Task[] }): ReactNode {
  const [asking, setAsking] = useState(false)
  return (
    <>
      <button className="btn ghost sm tc-remove-all" title="Remove every task in Done that's showing (asks first)" onClick={() => setAsking(true)}>
        Remove all
      </button>
      {asking && (
        <RemoveConfirm
          t={items}
          onRemove={() => {
            setAsking(false)
            void finishTasks(items.map((t) => t.id))
          }}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  )
}

/** Look up a task on the board by id, for the blocker helpers. */
function useFinder(): (id: number) => Task | undefined {
  const tasks = useStore((s) => s.tasks)
  return useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]))
    return (id: number) => byId.get(id)
  }, [tasks])
}

/** "#57, #58" with the rest counted, so a chip stays one short line. */
const idList = (ids: number[], max = 3): string =>
  ids.slice(0, max).map((id) => `#${id}`).join(', ') + (ids.length > max ? ` +${ids.length - max}` : '')

/** One quiet line of the card's meta row: what this task waits on, and what waits on it. Blockers that are
 *  gone (completed or discarded) don't show. One that hasn't started yet is the stronger hint, said in words. */
export function BlockChips({ t, waiting = true }: { t: Task; waiting?: boolean }): ReactNode {
  const tasks = useStore((s) => s.tasks)
  const find = useFinder()
  const open = openBlockers(t, find)
  const blocks = waiting ? blockedTasks(t, tasks) : []
  const unstarted = open.filter(notStarted).length
  return (
    <>
      {open.length > 0 && (
        <span className={`src blk${unstarted ? ' strong' : ''}`} title={['Blocked by', ...open.map(blockerLabel)].join('\n')}>
          <Lock size={11} /> Blocked by {idList(open.map((b) => b.id))}{' '}
          <span className="blk-state">
            · {unstarted === open.length ? 'not started' : unstarted ? `${unstarted} not started` : 'in progress'}
          </span>
        </span>
      )}
      {blocks.length > 0 && (
        <span className="src blk" title={[`Waiting on #${t.id}`, ...blocks.map(blockerLabel)].join('\n')}>
          <Link2 size={11} /> Blocks {idList(blocks.map((b) => b.id))}
        </span>
      )}
    </>
  )
}

/** Does what asking the assistant to handle the task does: start_worker, with the same limits and
 *  "ask"-mode approval. The main process re-checks everything; this only mirrors it for display. */
function AutomateButton({ t, running }: { t: Task; running: boolean }): ReactNode {
  // always ask while Corvid runs on a custom model (#320)
  const ask = useStore((s) => !s.config || effectiveAssistantMode(s.config) !== 'auto')
  const proposed = useStore((s) => s.assistant.proposals.some((p) => p.taskId === t.id))
  const blocker = useStore((s) => s.assistant.blocker)
  const find = useFinder()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [picking, setPicking] = useState(false)
  // no project (a task made from an error before #117, say): the button offers to set one instead of starting
  const noProject = !running && !proposed && !t.project

  const reason = running
    ? `A worker is already running for #${t.id}.`
    : proposed
      ? "Waiting for your approval in the Agents view."
      : noProject
        ? "This task has no project, so the worker has no folder to work in. Click to set the project; then Automate can run it."
        : blocker
  const label = busy ? (ask ? 'Proposing…' : 'Starting…') : running ? 'Running' : proposed ? 'Awaiting approval' : noProject ? 'Set the project' : 'Automate'
  const disabled = busy || (!!reason && !noProject)
  const hint = ask
    ? "Propose a worker for this task; it starts once you approve it in the Agents view"
    : 'Start a worker on this task now, within your limits'

  const go = (): void => {
    setConfirm(false)
    setBusy(true)
    void api
      .requestWorker(t.id)
      .then((r) => r !== 'proposed' && r !== 'started' && toast(r, 'error'))
      .catch((err) => toast(String(err?.message ?? err), 'error'))
      .finally(() => setBusy(false))
  }
  const open = openBlockers(t, find)

  return (
    <>
      <button
        data-tour="task.start-worker"
        className={`tc-automate${disabled ? ' off' : ''}${proposed ? ' pending' : ''}`}
        aria-disabled={disabled}
        title={reason ?? hint}
        onClick={(e) => {
          // not the disabled attribute: it would swallow the tooltip and let the click open the editor
          e.stopPropagation()
          if (disabled) return
          if (noProject) setPicking(true)
          // a soft block: say so first, and starting anyway works exactly as it does without one
          else if (open.length) setConfirm(true)
          else go()
        }}
      >
        {proposed ? <Hourglass size={11} /> : noProject ? <FolderOpen size={11} /> : <WandSparkles size={11} />} {label}
      </button>
      {confirm && open.length > 0 && <BlockedConfirm t={t} open={open} ask={ask} onStart={go} onClose={() => setConfirm(false)} />}
      {picking && <SetProject t={t} onClose={() => setPicking(false)} />}
    </>
  )
}

/** Automate on a task with no project (#117): pick one in a click, Corvid's own project first. Starts nothing. */
function SetProject({ t, onClose }: { t: Task; onClose: () => void }): ReactNode {
  const list = useStore((s) => s.projects.projects)
  const choices = list.filter((p) => !p.archived).sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin) || Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => cancelRef.current?.focus(), [])
  const pick = (projectId: string): void =>
    void api
      .updateTask(t.id, { projectId })
      .then(() => onClose())
      .catch((err) => toast(String(err?.message ?? err), 'error'))
  return createPortal(
    <div
      className="overlay"
      onMouseDown={onClose}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="dialog blocked-confirm" role="dialog" aria-label={`Set the project for #${t.id}`} onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <FolderOpen size={15} /> Set the project for #{t.id}
        </h3>
        <p>Automate needs a project, so the worker has a folder to work in. Pick one; then press Automate.</p>
        <div className="bc-list">
          {choices.slice(0, 12).map((p) => (
            <div key={p.id} className="bc-row">
              <span className="bc-title">
                {p.name}
                {p.builtin && ' (Corvid itself)'}
              </span>
              <button className="btn sm ghost" onClick={() => pick(p.id)}>
                Set
              </button>
            </div>
          ))}
          {!choices.length && <div className="bc-row">There are no projects yet. Add one on the Projects page.</div>}
        </div>
        <div className="actions">
          <button
            className="btn ghost"
            onClick={() => {
              onClose()
              editTask(t)
            }}
          >
            More projects…
          </button>
          <button ref={cancelRef} className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Before Automate starts a task whose blockers aren't done: which ones, their state, and the choice. */
function BlockedConfirm({ t, open, ask, onStart, onClose }: { t: Task; open: Task[]; ask: boolean; onStart: () => void; onClose: () => void }): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => cancelRef.current?.focus(), [])
  // in a portal so the card under it doesn't take the clicks, which React still bubbles: stop them here
  return createPortal(
    <div
      className="overlay"
      onMouseDown={onClose}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <div className="dialog blocked-confirm" role="alertdialog" aria-label={`#${t.id} is blocked`} onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <Lock size={15} /> #{t.id} is waiting on {open.length === 1 ? 'another task' : `${open.length} tasks`}
        </h3>
        <p>
          {open.length === 1 ? "This task isn't done yet." : "These tasks aren't done yet."} A block is only a hint, so you can still{' '}
          {ask ? 'propose a worker' : 'start it'} anyway.
        </p>
        <div className="bc-list">
          {open.map((b) => (
            <div key={b.id} className={`bc-row${notStarted(b) ? ' strong' : ''}`}>
              <span className="tid">#{b.id}</span>
              <span className="bc-title">{b.title}</span>
              <span className="bc-state">{BLOCKER_STATE[b.column]}</span>
              <button
                className="btn sm ghost"
                onClick={() => {
                  onClose()
                  editTask(b)
                }}
              >
                Open #{b.id}
              </button>
            </div>
          ))}
        </div>
        <div className="actions">
          <button ref={cancelRef} className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={onStart}>
            <WandSparkles size={14} /> {ask ? 'Propose anyway' : 'Start anyway'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** The editor's autoStart switch (#282). */
const AUTO_START_TIP =
  'When the last task it is blocked by moves to Done, a worker starts on it, with the same limits as any start (in "ask" mode you get the usual proposal). Turning this on starts nothing by itself, even if its blockers are already done. If every worker slot is taken, it starts when one frees. If usage is over the limit, a board notice says so and you start it yourself.'

export function TaskEditor(): ReactNode {
  const draft = useStore((s) => s.taskEditor)
  const projects = useProjects()
  const [form, setForm] = useState<Partial<Task>>({})
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState(false)
  // a new task's files (#187), stored once it's added; an existing task's are stored as they're attached
  const [staged, setStagedState] = useState<Staged[]>([])
  const stagedRef = useRef<Staged[]>([])
  const setStaged = (next: Staged[]): void => {
    stagedRef.current = next
    setStagedState(next)
  }
  const titleRef = useRef<HTMLInputElement>(null)
  const live = useStore((s) => (draft?.id === undefined ? undefined : s.tasks.find((x) => x.id === draft.id)))
  const drop = useFileDrop((files) => addToEditor(live, files.map((file) => ({ file })), stagedRef.current, setStaged))

  useEffect(() => {
    if (draft) {
      setForm({ column: 'backlog', notes: '', title: '', ...draft })
      setRemoving(false)
      releaseStaged(stagedRef.current)
      setStaged([])
      setError('')
      setTimeout(() => titleRef.current?.focus(), 30)
    }
  }, [draft])

  // hooks stay above the early return: one below it threw React #310 and blanked the window whenever the editor opened (#83)
  const formFolders = useStore((s) => s.projects.projects.find((x) => x.id === form.projectId)?.folders)

  if (!draft) return null
  const close = (): void => {
    releaseStaged(stagedRef.current)
    setStaged([])
    setState({ taskEditor: undefined })
  }
  const isNew = draft.id === undefined
  const save = async (): Promise<void> => {
    if (!form.title?.trim()) return
    try {
      // blockedBy always goes along, so ids of blockers that are gone get dropped now
      if (isNew) {
        // a new task never takes files from its draft (a copy starts without them, #187): only the ones attached here
        const { attachments: _none, ...fields } = form
        const t = await api.createTask({ ...fields, title: form.title })
        const files = stagedRef.current
        if (files.length)
          await api.addTaskFiles(t.id, files.map((f) => ({ name: f.name, data: f.data }))).catch((e) =>
            toast(`#${t.id} was added, but its files weren't: ${String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error')
          )
      } else await api.updateTask(draft.id!, { ...form, blockedBy: form.blockedBy ?? [] })
      close()
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  const projectOptions = projects.filter((p) => !p.archived || p.id === form.projectId)

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className={`dialog task-dialog${drop.dropping ? ' file-drop' : ''}`}
        {...drop.props}
        onPaste={(e) => {
          // a screenshot (#147, #187): an image pasted with no text alongside it is attached, not pasted as text
          const pasted = pastedFiles(e)
          if (!pasted.length) return
          e.preventDefault()
          addToEditor(live, pasted, stagedRef.current, setStaged)
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
          if (e.key === 'Enter' && mod(e)) void save()
        }}
      >
        <h3>{isNew ? 'New task' : `Task #${draft.id}`}</h3>
        <input
          ref={titleRef}
          className="task-title-input"
          spellCheck
          placeholder="What needs doing?"
          value={form.title ?? ''}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && !mod(e) && void save()}
        />
        <textarea
          className="task-notes"
          spellCheck
          placeholder="Notes, context, acceptance criteria…"
          value={form.notes ?? ''}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
        <SecretWarning text={`${form.title ?? ''}
${form.notes ?? ''}`} />
        <div className="task-fields">
          <label>
            <span className="section-label">Column</span>
            <div className="seg">
              {COLUMNS.map((c) => (
                <button key={c.id} className={form.column === c.id ? 'on' : ''} onClick={() => setForm({ ...form, column: c.id })}>
                  {c.label}
                </button>
              ))}
            </div>
          </label>
          <label>
            <span className="section-label">Project</span>
            <select
              className="select"
              value={form.projectId ?? ''}
              onChange={(e) => {
                const p = projects.find((x) => x.id === e.target.value)
                setForm({ ...form, projectId: p?.id, project: p?.path, folder: '' })
              }}
            >
              <option value="">None</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="section-label">Model</span>
            <TaskModelSelect id={draft.id} value={form.model} onChange={(model) => setForm({ ...form, model })} onError={setError} />
          </label>
          {(formFolders?.length ?? 0) > 1 && (
            <label>
              <span className="section-label">Folder</span>
              <select className="select" value={form.folder ?? ''} onChange={(e) => setForm({ ...form, folder: e.target.value })}>
                <option value="">Primary ({formFolders!.find((f) => f.primary)?.label || baseName(formFolders!.find((f) => f.primary)?.path ?? '')})</option>
                {formFolders!.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.label || baseName(f.path)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <BlockedByField id={draft.id} value={form.blockedBy} onChange={(blockedBy) => setForm({ ...form, blockedBy })} />
        <div className="task-autostart" title={AUTO_START_TIP}>
          <span>Start automatically when its blockers are done</span>
          <div
            className={`toggle${form.autoStart ? ' on' : ''}`}
            role="switch"
            tabIndex={0}
            aria-checked={!!form.autoStart}
            aria-label="Start automatically when its blockers are done"
            onClick={() => setForm({ ...form, autoStart: !form.autoStart })}
            onKeyDown={(e) => {
              if (e.key !== ' ' && e.key !== 'Enter') return
              e.preventDefault()
              e.stopPropagation()
              setForm({ ...form, autoStart: !form.autoStart })
            }}
          />
        </div>
        <TaskFilesField id={draft.id} staged={staged} setStaged={setStaged} />
        {drop.dropping && (
          <div className="mb-drop" aria-hidden>
            <span>Drop to attach to this task</span>
          </div>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="actions">
          {/* the one finish action (#134): kept apart from Save, and it asks first */}
          {!isNew && (
            <button className="btn ghost task-remove" title="Finished with this task? Remove it from the board" onClick={() => setRemoving(true)}>
              <Trash2 size={14} /> Remove…
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!form.title?.trim()} onClick={() => void save()}>
            {isNew ? 'Add task' : 'Save'}
          </button>
        </div>
        {removing && (
          <RemoveConfirm
            t={draft}
            onRemove={() => {
              setRemoving(false)
              close()
              void finishTask(draft.id!)
            }}
            onClose={() => setRemoving(false)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * A task's model (#136): Default follows the worker model in Settings (and says what that is now), else one of the
 * models every selector offers. Picking Fable asks in Corvid's own dialog first; Cancel keeps the previous choice.
 */
function TaskModelSelect({
  id,
  value,
  onChange,
  onError
}: {
  id?: number
  value?: AssistantModel | CustomModelRef
  onChange: (m: AssistantModel | CustomModelRef | undefined) => void
  onError: (e: string) => void
}): ReactNode {
  const workerModel = useStore((s) => s.config?.workerModel ?? 'default')
  const models = useStore((s) => s.config?.models)
  const claudeDefault = useStore((s) => s.claudeDefaultModel)
  const [asking, setAsking] = useState(false)
  const settings = workerModelLabel(workerModel, claudeDefault, models)
  return (
    <select
      className="select"
      value={value ?? ''}
      disabled={asking}
      title="The model workers on this task run on. Default follows the worker model in Settings."
      onChange={(e) => {
        const v = (e.target.value || undefined) as AssistantModel | CustomModelRef | undefined
        if (v !== 'fable' || value === 'fable') return onChange(v)
        setAsking(true)
        void api
          .pickTaskFable(id)
          .catch(() => ({ ok: false, problem: "Couldn't ask about Fable; the task keeps its model." }))
          .then((r) => {
            setAsking(false)
            if (r.ok) onChange('fable')
            else if (r.problem) onError(r.problem)
          })
      }}
    >
      <option value="">{workerModel === 'default' ? settings : `Default (${settings})`}</option>
      <ModelOptions custom="on" current={value} />
    </select>
  )
}

/** "Remove this task?" (#134): Cancel has the focus, so Enter or a stray click doesn't delete anything.
 *  Given a list (Done's Remove all, #138), it says how many and which. */
function RemoveConfirm({ t, onRemove, onClose }: { t: Partial<Task> | Task[]; onRemove: () => void; onClose: () => void }): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => cancelRef.current?.focus(), [])
  // a portal, like BlockedConfirm; React still bubbles to the editor, so its keys and clicks stop here
  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        e.stopPropagation()
        onClose()
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <div
        className="dialog remove-confirm"
        role="alertdialog"
        aria-label={Array.isArray(t) ? `Remove ${t.length} done tasks?` : `Remove #${t.id}?`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {Array.isArray(t) ? (
          <>
            <h3>Remove {t.length} done tasks?</h3>
            <p>
              {t.length} tasks are deleted from the board: {idList(t.map((x) => x.id), 8)}. You can undo it for a few seconds.
            </p>
          </>
        ) : (
          <>
            <h3>Remove this task?</h3>
            <p>
              #{t.id} {t.title} is deleted from the board. You can undo it for a few seconds.
            </p>
          </>
        )}
        <div className="actions">
          <button ref={cancelRef} className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" onClick={onRemove}>
            <Trash2 size={14} /> Remove
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** The editor's "Blocked by": pick other tasks by number or title, several allowed, and remove them again.
 *  A pick that would block the task on itself or close a loop is turned down here with the reason. */
function BlockedByField({ id, value, onChange }: { id?: number; value?: number[]; onChange: (ids: number[]) => void }): ReactNode {
  const tasks = useStore((s) => s.tasks)
  const find = useFinder()
  const [q, setQ] = useState('')
  const [problem, setProblem] = useState('')
  const [hi, setHi] = useState(0)
  const ids = value ?? []
  // a blocker that's gone (completed or discarded) no longer blocks, so it isn't shown; saving drops it
  const shown = ids.flatMap((b) => find(b) ?? [])
  const needle = q.trim().replace(/^#/, '').toLowerCase()
  const matches = needle
    ? tasks
        .filter((x) => x.id !== id && !ids.includes(x.id) && (String(x.id).startsWith(needle) || x.title.toLowerCase().includes(needle)))
        .sort((a, b) => Number(String(b.id) === needle) - Number(String(a.id) === needle) || a.id - b.id)
        .slice(0, 6)
    : []

  const add = (b: Task): void => {
    const why = shown.length >= MAX_BLOCKERS ? `A task can be blocked by at most ${MAX_BLOCKERS} others.` : blockerProblem(id, b.id, find)
    if (why) return setProblem(why)
    onChange([...ids.filter((x) => find(x)), b.id])
    setQ('')
    setProblem('')
    setHi(0)
  }

  return (
    <div className="blocked-field">
      <span className="section-label">Blocked by</span>
      <div className="bf-box">
        {shown.map((b) => (
          <span key={b.id} className={`chip bf-chip${notStarted(b) ? ' strong' : ''}`} title={blockerLabel(b)}>
            <span className="tid">#{b.id}</span>
            <span className="bf-title">{b.title}</span>
            <span className="bf-state">{BLOCKER_STATE[b.column]}</span>
            <button title={`Remove #${b.id}`} aria-label={`Remove #${b.id}`} onClick={() => onChange(ids.filter((x) => x !== b.id && find(x)))}>
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          className="bf-input"
          spellCheck={false}
          placeholder={shown.length ? 'Add another…' : 'Search tasks by number or title'}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setProblem('')
            setHi(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setHi((h) => Math.max(0, Math.min(matches.length - 1, h + (e.key === 'ArrowDown' ? 1 : -1))))
            } else if (e.key === 'Enter' && !mod(e) && matches[hi]) {
              e.preventDefault()
              add(matches[hi])
            } else if (e.key === 'Backspace' && !q && shown.length) {
              onChange(ids.filter((x) => x !== shown[shown.length - 1].id && find(x)))
            } else if (e.key === 'Escape' && q) {
              e.stopPropagation()
              setQ('')
            }
          }}
        />
      </div>
      {matches.length > 0 && (
        <div className="bf-matches" role="listbox">
          {matches.map((m, i) => (
            <button key={m.id} role="option" aria-selected={i === hi} className={i === hi ? 'on' : ''} onMouseEnter={() => setHi(i)} onClick={() => add(m)}>
              <span className="tid">#{m.id}</span>
              <span className="bf-title">{m.title}</span>
              <span className="bf-state">{BLOCKER_STATE[m.column]}</span>
            </button>
          ))}
        </div>
      )}
      {needle && !matches.length && <div className="bf-hint">No other task matches “{q.trim()}”.</div>}
      {problem && <div className="form-error">{problem}</div>}
    </div>
  )
}
