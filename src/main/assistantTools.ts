import { z } from 'zod'
import { attachmentList } from '@shared/board'
import type {
  AppConfig,
  LiveSession,
  LiveTokens,
  SearchHit,
  SessionActivity,
  SessionSummary,
  Task,
  TranscriptEntry,
  UsageQuota,
  UsageStats
} from '@shared/types'
import { TASK_COLUMNS } from '@shared/types'
import { buildProjects, type Project } from '@shared/projectModel'
import { findRecord, folderName, projectIdFor } from '@shared/projectList'
import { allModelsWeek, fableWeek, modelLabel } from '@shared/models'
import type { ToolDef } from './mcp'
import { blockedTasks, blockerLabel, MAX_BLOCKERS, openBlockers } from '@shared/blockers'
import { createTask, listTasks, removeTask, TASK_FABLE_REFUSED, updateTask } from './tasks'

/** Task titles and notes go into every worker's prompt, so a secret never goes in one (#91). */
function refuseTaskSecret(text: string): void {
  const hit = secretIn(text)
  if (hit) throw new Error(`Refused: the task text looks like it contains ${hit}. Workers read task titles and notes; ask the user to save the secret in Corvid's connections instead, and describe where it lives.`)
}
import { getProject, projectsState } from './projectStore'
import { ensureTracked, gitCache } from './projects'
import { gitDetail } from './git'
import * as workers from './workers'
import { noteTools, resolveNote, secretIn, type NoteToolDeps } from './noteTools'
import { tourTools, type TourToolDeps } from './tourTools'

export interface ToolDeps {
  sessions: () => SessionSummary[]
  live: () => LiveSession[]
  activity: (sessionId: string) => SessionActivity | undefined
  config: () => AppConfig
  home: string
  quota: () => UsageQuota | null
  liveQuota: () => { fiveHour: number; week: number; at: number } | undefined
  liveTokens: () => LiveTokens | null
  stats: () => UsageStats | null
  search: (q: string) => Promise<SearchHit[]>
  transcript: (id: string, limit: number) => Promise<TranscriptEntry[]>
  show: (target: { view: string; project?: string; sessionId?: string; note?: string }) => void
  /** the user's current message, which decides whether the assistant may change a note the user wrote */
  request: () => string
  /** the id of that message: start_worker's override_blockers only counts in a later message than its warning */
  requestId: () => string
  noteLeft: NoteToolDeps['left']
  /** guided tours made on the fly (#216): play one in the window, and the tours folder save_tour writes to */
  playTour: TourToolDeps['play']
  toursDir: TourToolDeps['dir']
}

const ago = (ts: number): string => {
  if (!ts) return 'never'
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const findTask = (id: number): Task | undefined => listTasks().find((t) => t.id === id)

/** Which folder of a multi-folder project a task works in (3/5); undefined for one-folder projects. */
function taskFolderLabel(t: Task): string | undefined {
  const p = t.projectId ? getProject(t.projectId) : undefined
  if (!p || p.folders.length < 2) return undefined
  const f = (t.folder && p.folders.find((x) => x.path === t.folder)) || p.folders.find((x) => x.primary) || p.folders[0]
  return `${folderName(f)}${t.folder ? '' : ' (primary, none chosen)'}`
}

/** A task's model in create_task and update_task (#136). Fable is listed so asking for it gets the reason, not a type error. */
const taskModelInput = z
  .enum(['default', 'haiku', 'sonnet', 'opus', 'fable'])
  .optional()
  .describe('the model workers on this task run on; default follows the worker model in Settings. Fable is refused: only the user can set it, in the task editor')
const TASK_MODEL_HELP =
  "model sets the model this task's workers run on (haiku, sonnet, opus, or default to follow the worker model in Settings). Only set it when the user asks. Fable can't be set here: tell the user to open the task and pick Fable under Model in its editor, which asks them first."

const taskView = (t: Task) => ({
  id: t.id,
  title: t.title,
  column: t.column,
  project: t.project,
  project_id: t.projectId,
  folder: taskFolderLabel(t),
  // the task's own model (#136); "default" follows the worker model in Settings
  model: t.model ?? 'default',
  notes: t.notes || undefined,
  // attached files (#187): names, types and sizes; read_task_file reads them
  files: t.attachments?.length ? attachmentList(t.attachments) : undefined,
  created: ago(t.createdAt),
  // only blockers that still exist and aren't in Done: those no longer block
  blocked_by: openBlockers(t, findTask).map(blockerLabel).join('; ') || undefined,
  blocks: blockedTasks(t, listTasks()).map((x) => `#${x.id}`).join(', ') || undefined,
  worker: workers.listWorkers().find((w) => w.taskId === t.id && w.state === 'running')?.id
})

/** A project by id, folder path (a subfolder or worktree counts), exact name, or part of its name; archived ones last. */
export function matchProject(all: Project[], q: string): Project | undefined {
  const id = findRecord(projectsState().projects, q)?.id ?? projectIdFor(q, projectsState().projects, projectsState().cwds)
  return all.find((p) => p.id === id)
}

const blockedByInput = z
  .array(z.number())
  .max(MAX_BLOCKERS)
  .optional()
  .describe('task ids this one should wait for (a soft hint, never enforced); the whole list, [] clears it')

export function assistantTools(d: ToolDeps): ToolDef[] {
  // task id -> the user message start_worker warned about its blockers in
  const blockWarned = new Map<number, string>()
  const projects = (): Project[] => {
    const sessions = Object.fromEntries(d.sessions().map((s) => [s.id, s]))
    return buildProjects(projectsState(), sessions, d.live(), gitCache(), d.config())
  }
  const findProject = (q: string): Project | undefined => matchProject(projects(), q)
  const sessionTitle = (id: string): string => d.sessions().find((s) => s.id === id)?.title ?? id

  return [
    {
      name: 'overview',
      description:
        'One-call snapshot: running sessions and what they are doing, workers, tasks per column (backlog, next, doing, done), usage quota, worker limits and the current mode. Call this first when asked "what\'s going on".',
      input: {},
      readOnly: true,
      run: () => {
        const q = d.quota()
        const lq = d.liveQuota()
        const tasks = listTasks()
        return {
          now: new Date().toString(),
          mode: d.config().assistantMode,
          personality: d.config().assistantPersonality,
          models: { assistant: d.config().assistantModel, workers: d.config().workerModel },
          limits: d.config().limits,
          usage: {
            fiveHourPct: lq?.fiveHour ?? q?.session?.pct,
            weekPct: lq?.week ?? allModelsWeek(q?.weeks)?.pct,
            fableWeekPct: fableWeek(q?.weeks)?.pct,
            fiveHourResets: q?.session?.resetsAt,
            outputTokensToday: d.liveTokens()?.today.output
          },
          live: d.live().map((l) => {
            const a = d.activity(l.sessionId)
            const lastTool = a?.events.filter((e) => e.kind === 'tool').at(-1)
            return {
              session: sessionTitle(l.sessionId),
              sessionId: l.sessionId,
              cwd: l.cwd,
              status: l.status,
              waitingFor: l.waitingFor,
              task: a?.turnPrompt?.slice(0, 200),
              doing: lastTool ? `${lastTool.tool}: ${lastTool.label}` : undefined
            }
          }),
          workers: workers.listWorkers().map((w) => ({ id: w.id, task: w.taskId, state: w.state, status: w.liveStatus, started: ago(w.startedAt), reason: w.reason })),
          pendingApprovals: workers.listProposals().map((p) => ({ task: p.taskId, since: ago(p.createdAt) })),
          tasks: Object.fromEntries(TASK_COLUMNS.map((c) => [c, tasks.filter((t) => t.column === c).length])),
          // attached files (#187), per task that has any
          taskFiles: tasks.filter((t) => t.attachments?.length).map((t) => `#${t.id}: ${attachmentList(t.attachments!)}`)
        }
      }
    },

    // ---------- tasks ----------
    {
      name: 'list_tasks',
      description:
        'List the tasks on the board, column by column: backlog, next, doing (in progress) and done. Done tasks are finished but still on the board until removed; removed tasks are deleted, so they never show. Optional filters. model is the model its workers run on: default follows the worker model in Settings. blocked_by lists the tasks a task should wait for that are not done yet, and their state; blocks lists the tasks waiting on it. files lists the files the user attached (name, type, size): read them with read_task_file.',
      input: { column: z.enum(TASK_COLUMNS).optional(), project: z.string().optional().describe('project name or path') },
      readOnly: true,
      run: ({ column, project }) => {
        const p = project ? findProject(project) : undefined
        return listTasks()
          .filter((t) => (!column || t.column === column) && (!p || t.projectId === p.id))
          .sort((a, b) => TASK_COLUMNS.indexOf(a.column) - TASK_COLUMNS.indexOf(b.column) || a.order - b.order)
          .map(taskView)
      }
    },
    {
      name: 'create_task',
      description:
        'Add a task to the board. project takes a name, an id or a folder path; tasks need a project for a worker to work on them. ' +
        'It starts without attached files: only the user can attach files to a task, in Corvid’s window. ' +
        "folder picks which of a multi-folder project's folders to work in (its label or path); left out, the primary folder. " +
        TASK_MODEL_HELP,
      input: {
        title: z.string(),
        notes: z.string().optional(),
        project: z.string().optional().describe('project name or path'),
        folder: z.string().optional().describe("for a project with several folders: the folder's label or path"),
        // priority is gone (#134); still accepted and ignored so older prompts and workers don't error
        priority: z.unknown().optional().describe('not used'),
        column: z.enum(TASK_COLUMNS).optional(),
        blocked_by: blockedByInput,
        model: taskModelInput
      },
      run: ({ title, notes, project, folder, column, blocked_by, model }) => {
        if (model === 'fable') throw new Error(TASK_FABLE_REFUSED)
        refuseTaskSecret(`${title}
${notes ?? ''}`)
        const p = project ? findProject(project) : undefined
        if (project && !p) throw new Error(`No project matches "${project}".`)
        const t = createTask({
          title,
          notes,
          projectId: p?.id,
          project: p?.path,
          ...(folder ? { folder } : {}),
          column,
          blockedBy: blocked_by,
          ...(model && model !== 'default' ? { model } : {})
        })
        return taskView(t)
      }
    },
    {
      name: 'update_task',
      description:
        "Change a task: title, notes, column (backlog/next/doing/done; done is for finished work, and no worker starts on a done task), project, folder (which of a multi-folder project's folders to work in, by label or path; empty for the primary), blocked_by (the tasks it should wait for), or model. Attached files can't be added or removed here: only the user can, in Corvid's window. " +
        TASK_MODEL_HELP,
      input: {
        id: z.number(),
        title: z.string().optional(),
        notes: z.string().optional(),
        priority: z.unknown().optional().describe('not used'),
        column: z.enum(TASK_COLUMNS).optional(),
        project: z.string().optional(),
        folder: z.string().optional(),
        blocked_by: blockedByInput,
        model: taskModelInput
      },
      run: ({ id, project, priority: _gone, blocked_by, model, ...rest }) => {
        if (model === 'fable' && findTask(id)?.model !== 'fable') throw new Error(TASK_FABLE_REFUSED)
        refuseTaskSecret(`${rest.title ?? ''}
${rest.notes ?? ''}`)
        const p = project ? findProject(project) : undefined
        if (project && !p) throw new Error(`No project matches "${project}".`)
        const patch: Partial<Task> = { ...rest }
        if (blocked_by) patch.blockedBy = blocked_by
        // "default" clears it (tasks.ts), so the task follows Settings again
        if (model) patch.model = model as Task['model']
        if (p) Object.assign(patch, { projectId: p.id, project: p.path })
        const t = updateTask(id, patch)
        if (!t) throw new Error(`Task #${id} doesn't exist.`)
        return taskView(t)
      }
    },
    {
      name: 'finish_task',
      description:
        'Remove a task from the board: done and discard do the same thing, the task is deleted (from any column, Done included). To mark work finished but keep it on the board, use update_task with column done instead. Only remove when the user asks.',
      input: { id: z.number(), outcome: z.enum(['done', 'discard']) },
      run: ({ id, outcome }) => {
        const t = removeTask(id)
        if (!t) throw new Error(`Task #${id} doesn't exist.`)
        return `#${id} ${outcome === 'done' ? 'completed' : 'discarded'} and removed.`
      }
    },

    // ---------- projects ----------
    {
      name: 'list_projects',
      description:
        "The user's project list (they add and archive projects themselves): id, git state, flagged risks (no git, unpushed, stale uncommitted work), last activity. Archived projects only with archived: true.",
      // tag: the Work/Hobby filter is gone (#82); still accepted and ignored so older callers don't error
      input: { tag: z.unknown().optional().describe('not used'), archived: z.boolean().optional().describe('include archived projects') },
      readOnly: true,
      run: async ({ archived }) => {
        const shown = projects().filter((p) => (archived || !p.archived) && !p.missing)
        await ensureTracked(shown.map((p) => p.path))
        return projects()
          .filter((p) => archived || !p.archived)
          .map((p) => ({
            id: p.id,
            name: p.name,
            path: p.path,
            pinned: p.pinned || undefined,
            archived: p.archived || undefined,
            missing: p.missing ? 'the folder no longer exists' : undefined,
            lastActivity: ago(p.lastActivity),
            sessions: p.sessions.length,
            live: p.live.length ? p.live.map((l) => l.status) : undefined,
            git:
              p.git === null
                ? 'no git'
                : p.git
                  ? { branch: p.git.branch, uncommitted: p.git.changed + p.git.untracked, ahead: p.git.ahead, behind: p.git.behind, lastCommit: p.git.lastCommit && `${p.git.lastCommit.subject} (${ago(p.git.lastCommit.ts)})`, remote: p.git.webUrl ?? p.git.remoteUrl }
                  : 'unknown',
            risks: p.risks.length ? p.risks.map((r) => r.text) : undefined
          }))
      }
    },
    {
      name: 'project_details',
      description: 'Everything about one project: git status, uncommitted files, recent commits, its Claude sessions, files Claude edits most, open tasks.',
      input: { project: z.string().describe('project name or path') },
      readOnly: true,
      run: async ({ project }) => {
        const p0 = findProject(project)
        if (!p0) throw new Error(`No project matches "${project}".`)
        await ensureTracked([p0.path])
        const p = findProject(p0.id)!
        const detail = p.git ? await gitDetail(p.git.repoRoot) : undefined
        const edited = new Map<string, number>()
        for (const s of p.sessions) for (const [f, n] of Object.entries(s.editedFiles)) edited.set(f, (edited.get(f) ?? 0) + n)
        return {
          name: p.name,
          path: p.path,
          git: p.git === null ? 'no git repository' : p.git,
          uncommittedFiles: detail?.changes.slice(0, 40),
          recentCommits: detail?.commits.slice(0, 10).map((c) => `${c.hash.slice(0, 7)} ${c.subject} (${ago(c.ts)})`),
          risks: p.risks.map((r) => r.text),
          sessions: p.sessions.slice(0, 12).map((s) => ({ id: s.id, title: s.title, last: ago(s.lastActivity), turns: s.userTurns, deleted: s.deleted || undefined })),
          mostEdited: [...edited.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f, n]) => `${f} (${n})`),
          tasks: listTasks().filter((t) => t.projectId === p.id).map(taskView)
        }
      }
    },

    // ---------- sessions ----------
    {
      name: 'search_sessions',
      description: 'Full-text search across every Claude Code transcript (user prompts and replies). Returns matching sessions with snippets.',
      input: { query: z.string() },
      readOnly: true,
      run: async ({ query }) => {
        const hits = await d.search(query)
        return hits.slice(0, 25).map((h) => ({ sessionId: h.sessionId, session: sessionTitle(h.sessionId), who: h.role, when: ago(h.ts), snippet: h.snippet }))
      }
    },
    {
      name: 'recent_sessions',
      description: 'Most recently active Claude Code sessions with project, title, status and size.',
      input: { limit: z.number().optional() },
      readOnly: true,
      run: ({ limit }) => {
        const live = new Map(d.live().map((l) => [l.sessionId, l.status]))
        return d
          .sessions()
          .sort((a, b) => b.lastActivity - a.lastActivity)
          .slice(0, Math.min(limit ?? 15, 40))
          .map((s) => ({ id: s.id, title: s.title, project: s.projectName, last: ago(s.lastActivity), live: live.get(s.id), turns: s.userTurns, model: Object.keys(s.models)[0] && modelLabel(Object.keys(s.models)[0]) }))
      }
    },
    {
      name: 'session_details',
      description: 'One session: summary, first/last prompt, tools used, and its latest messages.',
      input: { session_id: z.string(), messages: z.number().optional() },
      readOnly: true,
      run: async ({ session_id, messages }) => {
        const s = d.sessions().find((x) => x.id === session_id || x.id.startsWith(session_id))
        if (!s) throw new Error('No such session.')
        const tail = await d.transcript(s.id, Math.min(messages ?? 8, 20))
        return {
          id: s.id,
          title: s.title,
          project: s.cwd,
          started: ago(s.startedAt),
          last: ago(s.lastActivity),
          firstPrompt: s.firstPrompt,
          lastPrompt: s.lastPrompt,
          topTools: Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 6),
          latest: tail.map((m) => ({ who: m.role, text: m.text.slice(0, 1500) }))
        }
      }
    },

    // ---------- usage ----------
    {
      name: 'usage',
      description: 'Plan usage: 5-hour and weekly quota with reset times, today\'s token output, last 14 days of output, top projects by estimated value.',
      input: {},
      readOnly: true,
      run: () => ({
        quota: d.quota(),
        liveQuota: d.liveQuota(),
        today: d.liveTokens()?.today,
        last14Days: d.stats()?.daily.map((x) => ({ date: x.date, output: Object.values(x.byModel).reduce((a, b) => a + b, 0) })),
        topProjects30d: d.stats()?.topProjects.slice(0, 6)
      })
    },

    // ---------- workers ----------
    {
      name: 'list_workers',
      description: 'Worker sessions started for tasks: state, live status, how long they have run, why they stopped. Also pending approvals.',
      input: {},
      readOnly: true,
      run: () => ({
        limits: d.config().limits,
        workers: workers.listWorkers().map((w) => ({ id: w.id, name: w.agentName, task: w.taskId, title: w.taskTitle, project: w.project, branch: w.branch, git: w.git, state: w.state, status: w.liveStatus, started: ago(w.startedAt), reason: w.reason })),
        pendingApprovals: workers.listProposals()
      })
    },
    {
      name: 'start_worker',
      description:
        'Start a worker: a separate interactive Claude Code session in the task\'s project that works on that task. Unless Settings say otherwise it gets its own task branch in a git worktree next to the project, and the dashboard merges that into the default branch when its checks pass. The dashboard enforces limits (concurrent workers, the usage limit, time cap) and may refuse; report the reason. Above the usage limit the dashboard either refuses or asks the user in its own dialog; then you are told they were asked, and the start goes ahead only if they choose Start anyway there. Nothing you pass answers that dialog, so never call start_worker again for it. In "ask" mode this only creates a proposal the user must approve in the Agents view ("Awaiting your approval"). ' +
        "The worker runs on the task's own model when it has one (list_tasks shows it), else the worker model from Settings; this tool can't change the model. " +
        'A task in the done column is never started: move it back to next first, if the user wants more work on it. ' +
        'The worker is told which files are attached to the task and can read them (only its own task’s) with read_task_file. ' +
        'A task with open blockers (tasks it is blocked by that still exist and are not done) is not started the first time: you get the blockers back. Tell the user and ask. Set override_blockers: true only after the user has replied that you should start it anyway, never on your own judgement.',
      input: {
        task_id: z.number(),
        instructions: z.string().optional().describe('extra guidance for the worker'),
        override_blockers: z.boolean().optional().describe('only after the user, in a reply to your warning about the blockers, said to start anyway')
      },
      run: async ({ task_id, instructions, override_blockers }) => {
        const t = findTask(task_id)
        // a task in Done is refused by requestWorker below, whatever blocks it
        const open = t && t.column !== 'done' ? openBlockers(t, findTask) : []
        if (open.length) {
          const list = open.map(blockerLabel).join('; ')
          if (!override_blockers) {
            blockWarned.set(task_id, d.requestId())
            return (
              `Not started: #${task_id} is blocked by ${list}. A block is only a hint, so the user can still say go. ` +
              `Tell the user which tasks block it and ask whether to start it anyway. If they say yes, call start_worker again with override_blockers: true. Nothing has started.`
            )
          }
          // the go-ahead has to come from the user: a message of theirs after the warning, not the same turn
          const warnedIn = blockWarned.get(task_id)
          if (warnedIn === undefined || warnedIn === d.requestId())
            return (
              `Not started: override_blockers only counts once the user has answered your warning. #${task_id} is blocked by ${list}. ` +
              `Tell the user and wait for their reply before calling start_worker with override_blockers again. Nothing has started.`
            )
        }
        blockWarned.delete(task_id)
        // above the usage limit, the user is asked in Corvid's own dialog (#93); this tool doesn't wait for the answer
        const r = await workers.requestWorker(task_id, instructions, true)
        if (r.error) throw new Error(r.error)
        if (r.asked) return r.asked
        if (r.proposal)
          return `Proposed a worker for #${task_id}. It is waiting for the user to click Approve under "Awaiting your approval" in the Agents view. Nothing has started yet.`
        return `Started worker ${r.worker!.id}${r.worker!.agentName ? ` ("${r.worker!.agentName}")` : ''} for #${task_id} in ${r.worker!.project}. The task moved to In progress.`
      }
    },
    {
      name: 'stop_worker',
      description: 'Stop a running worker (its terminal tab stays open for review).',
      input: { worker_id: z.string() },
      run: ({ worker_id }) => {
        const w = workers.stopWorker(worker_id, 'Stopped by Corvid')
        if (!w) throw new Error('No such worker.')
        return `Worker ${w.id} for #${w.taskId}: ${w.state}.`
      }
    },

    // ---------- notes ----------
    ...noteTools({ kind: 'assistant', request: d.request }, { findProject: (q) => findProject(q)?.path, left: d.noteLeft }),

    // ---------- UI ----------
    {
      name: 'show',
      description:
        'Navigate the dashboard UI for the user: a view (terminals = the Agents view: running Claude terminals and workers as cards, sessions running outside Corvid, recent sessions to resume, and the message board; tasks, usage, projects, notes), a project page, a session (shown on its project page), or one note opened in the Notes view (by ID or name). There is no separate sessions or live view: "live" still works and shows the Agents view.',
      input: {
        view: z.enum(['terminals', 'live', 'tasks', 'usage', 'projects', 'notes']).optional(),
        project: z.string().optional(),
        session_id: z.string().optional(),
        note: z.string().optional().describe('a note ID (N7) or name to open')
      },
      run: ({ view, project, session_id, note }) => {
        const p = project ? findProject(project) : undefined
        const n = note ? resolveNote(note) : undefined
        // 'live' is the Live view #64 removed; its sessions and feed moved to the Agents view and the ticker
        d.show({ view: n ? 'notes' : view === 'live' ? 'terminals' : (view ?? 'projects'), project: p?.path, sessionId: session_id, note: n?.id })
        return 'Shown.'
      }
    },
    ...tourTools({ play: d.playTour, dir: d.toursDir, request: d.request })
  ]
}
