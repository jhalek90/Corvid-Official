import { app, powerMonitor } from 'electron'
import { taskFilesPrompt } from '@shared/taskFiles'
import { thesisDose } from '@shared/corvidThesis'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CrowLook, LiveSession, Proposal, Task, Worker } from '@shared/types'
import { agentLook, looksAlike } from '@shared/agentAvatar'
import { agentName, isPlainName, plainAgentName, type NameInput } from '@shared/agentNames'
import { projectKey } from '@shared/projects'
import { nameKey } from '@shared/board'
import { choiceLabel, launchArgs, taskModel } from '@shared/models'
import { isReasoningEffort } from '@shared/reasoningEffort'
import { BLOCKER_STATE, openBlockers } from '@shared/blockers'
import type { AccessPart } from './agentAccess'
import { cleanUp, prepareBranch, setActive, unsavedWork, type AgentBranch, type BranchPlan } from './agentGit'
import { clampWorkers, overFableGate, overGates } from '@shared/workerLimits'
import { clockLine, pauseClock, tickClock, workedMs } from '@shared/workerClock'
import { getConfig } from './config'
import { builtinProject } from './projectStore'
import { gitAccess } from './gitTools'
import { killByNameExamples } from './platform/agentWords'
import { endedRefusal } from './agentPing'
import { CLAUDE_NOT_FOUND, resolveClaude } from './claudeBin'
import * as pty from './pty'
import * as lineage from './lineage'
import { pastPathsOf } from './projectStore'
import { allowWorkers } from './testCopy'

// Workers are ordinary interactive Claude sessions in a dashboard terminal, one per task.
// Every limit here is enforced by the app, whatever the assistant asks for.

const QUOTA_MAX_AGE = 10 * 60_000
const WARN_BEFORE_MS = 5 * 60_000
/** how often the work clocks tick and the time limit is checked */
const CLOCK_TICK_MS = 5000

export interface WorkerDeps {
  /** freshest known usage, 0-100 */
  quota: () => { fiveHour?: number; week?: number; fable?: number; at: number; resets5h?: number } | null
  refreshQuota: () => Promise<void>
  /** whether the plan has Fable (#127's plan check): null when it works, else why not; for a task on Fable (#136) */
  fableProblem?: () => Promise<string | null>
  task: (id: number) => Task | undefined
  moveTask: (id: number, column: Task['column']) => void
  changed: () => void
  note: (text: string, tone: 'info' | 'warn' | 'error') => void
  /** extra CLI args and system-prompt text for a worker: its notes tools, and its project's remote systems if any.
   *  `request` is what the user asked of it (task title, notes, extra instructions). */
  access: (w: { id: string; taskId: number; project: string; cwd: string; agentName?: string; avatar?: CrowLook; request: string; git?: AccessPart; branch?: AgentBranch }) => { args: string[]; prompt: string; reminder?: string } | null
  /** a worker's branch was merged or cleaned up: the project's git state changed */
  gitChanged: (repo: string) => void
  /** a worker stopped or exited: take back what access() gave it */
  ended: (w: Worker) => void
  /** post on the message board as Corvid, about this worker */
  announce: (w: Worker, text: string) => void
  /** it has a question to the user with no answer yet, or a remote command waiting for approval */
  waitingOnUser: (w: Worker) => boolean
  /** a remote command of its waits for the user's approval (its tool call hangs meanwhile) */
  awaitingApproval?: (w: Worker) => boolean
  /** which of a multi-folder project's folders a task works in, said when it starts (3/5) */
  folderNote?: (task: Task) => string | undefined
  /** ask the user in Corvid's own dialog whether to start an agent above the usage limit (#93); nothing else answers it */
  confirmOverLimit: (r: ConfirmRequest) => Promise<{ ok: boolean; dontAsk: boolean; timedOut: boolean }>
}

let deps: WorkerDeps
const workers: Worker[] = []
/** worker id -> its task branch */
const branches = new Map<string, AgentBranch>()
const proposals: Proposal[] = []
const warned = new Set<string>()
let lastQuotaWarning = 0

/** What's needed to bring a task's last agent back after it ended, kept in <data>\agents.json so it outlives a restart (#62). */
export interface AgentRecord {
  taskId: number
  agentName?: string
  avatar?: CrowLook
  sessionId?: string
  /** the folder its Claude session belongs to */
  cwd: string
  endedAt?: number
  /** how it ended, for agent wake-ups (#195): only one that finished on its own may be woken by an agent */
  endState?: Worker['state']
  endReason?: string
}
const records = new Map<number, AgentRecord>()
const recordsFile = (): string => join(app.getPath('userData'), 'agents.json')

function loadRecords(): void {
  try {
    const raw = JSON.parse(readFileSync(recordsFile(), 'utf8'))
    for (const r of Array.isArray(raw) ? raw : []) if (Number.isInteger(r?.taskId) && typeof r.cwd === 'string') records.set(r.taskId, r)
  } catch {
    /* first run */
  }
}

function remember(w: Worker, cwd?: string): void {
  const prev = records.get(w.taskId)
  records.set(w.taskId, {
    taskId: w.taskId,
    agentName: w.agentName,
    avatar: w.avatar,
    sessionId: w.sessionId ?? prev?.sessionId,
    cwd: cwd ?? prev?.cwd ?? w.worktree ?? w.project,
    endedAt: w.endedAt,
    ...(w.state !== 'running' ? { endState: w.state, endReason: w.reason } : {})
  })
  // tasks are deleted when done, so only recent ones matter
  const keep = [...records.values()].sort((a, b) => (b.endedAt ?? Infinity) - (a.endedAt ?? Infinity)).slice(0, 50)
  try {
    const tmp = recordsFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(keep, null, 2))
    renameSync(tmp, recordsFile())
  } catch (e) {
    console.error('agents.json write failed', e)
  }
}

export function initWorkers(d: WorkerDeps): void {
  deps = d
  loadRecords()
  pty.onTerminalExit((termId, code) => {
    const w = workers.find((x) => x.termId === termId && x.state === 'running')
    if (!w) return
    if (failedStart(w, code)) return
    w.state = 'exited'
    w.endedAt = Date.now()
    pauseClock(w, w.endedAt)
    w.liveStatus = undefined
    w.reason = code === 0 ? 'Session closed' : `Exited with code ${code}`
    w.closeAt = w.closeHeld = undefined
    quiet.delete(w.id)
    remember(w)
    deps.ended(w)
    void finishBranch(w)
    deps.note(`${who(w)} ended: ${w.reason.toLowerCase()}.`, 'info')
    deps.changed()
  })
  setInterval(() => tickClocks(Date.now()), CLOCK_TICK_MS)
  // a sleeping PC isn't working: stop every clock at suspend, start them again at resume
  powerMonitor.on('suspend', () => suspendClocks(Date.now()))
  powerMonitor.on('resume', () => resumeClocks(Date.now()))
  setInterval(closeFinished, 1000)
}

export const listWorkers = (): Worker[] => workers
export const listProposals = (): Proposal[] => proposals
export const runningWorkers = (): Worker[] => workers.filter((w) => w.state === 'running')

/** The user's limit from Settings, clamped again here so a hand-edited config.json can't pass the ceiling. */
const cap = (): number => clampWorkers(getConfig().limits.maxWorkers)

/** Running workers and the cap, for "No free slot (3 of 3 agents running)". */
export const slotInfo = (): { running: number; cap: number } => ({ running: runningWorkers().length, cap: cap() })

/** Starts past the limit check but not yet running (making the worktree, say), so two at once can't both slip under it. */
let starting = 0

const concurrencyBlocker = (): string | null => {
  const n = runningWorkers().length
  if (n >= cap()) return `${n} of ${cap()} workers are already running, which is the limit.`
  if (n + starting >= cap()) return `${n} of ${cap()} workers are running and ${starting} more ${starting === 1 ? 'is' : 'are'} starting, which is the limit.`
  return null
}

/** Usage as the gates see it: the freshest known numbers, when they were read, and when the 5-hour window resets. */
type Usage = { fiveHour?: number; week?: number; fable?: number; at: number; resets5h?: number }

/** What the usage limit says about starting one more agent (#93). */
interface OverLimit {
  q: Usage | null
  /** the numbers are older than QUOTA_MAX_AGE: the latest check failed */
  stale: boolean
  five: boolean
  week: boolean
  /** the agent runs on Fable and Fable's own weekly limit is at or past the weekly gate (#127) */
  fable: boolean
}

/** Over the usage limit, or null when nothing is over or the limit is off. Unknown usage counts as over, so it asks. */
function overLimit(q: Usage | null, model: string = getConfig().workerModel): OverLimit | null {
  const l = getConfig().limits
  if (!l.usageLimit || (!l.gate5hOn && !l.gateWeekOn)) return null
  if (!q) return { q, stale: false, five: false, week: false, fable: false }
  const over = { ...overGates(l, q.fiveHour, q.week), fable: model === 'fable' && overFableGate(l, q.fable) }
  return over.five || over.week || over.fable ? { q, stale: Date.now() - q.at > QUOTA_MAX_AGE, ...over } : null
}

const pct = (v?: number): string => (v === undefined ? 'unknown' : `${Math.round(v)}%`)
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** "5h 72% of 70%": the gates that are over, for notices and the audit line. */
function overShort(o: OverLimit): string {
  const l = getConfig().limits
  if (!o.q) return 'usage unknown'
  return [o.five && `5h ${pct(o.q.fiveHour)} of ${l.gate5h}%`, o.week && `week ${pct(o.q.week)} of ${l.gateWeek}%`, o.fable && `Fable week ${pct(o.q.fable)} of ${l.gateWeek}%`]
    .filter(Boolean)
    .join(', ')
}

/** The refusal in "Block new agents" mode, worded as before #93. */
function usageBlocker(o: OverLimit): string {
  const l = getConfig().limits
  if (!o.q) return 'Current usage is unknown, so no new workers can start. Try refreshing usage.'
  if (o.five) return `5-hour usage is at ${pct(o.q.fiveHour)}, at or above the ${l.gate5h}% limit for starting workers.`
  if (o.week) return `Weekly usage is at ${pct(o.q.week)}, at or above the ${l.gateWeek}% limit for starting workers.`
  return `Fable usage is at ${pct(o.q.fable)} of its weekly limit, at or above the ${l.gateWeek}% limit for starting workers on Fable.`
}

/** The dialog's text: both gates' numbers, which is over, when the 5-hour window resets, and how fresh it all is. */
export function overText(o: OverLimit): string {
  const l = getConfig().limits
  const gate = (v: number | undefined, on: boolean, limit: number): string => `${pct(v)} (${on ? `limit ${limit}%` : 'no limit'})`
  const lines: string[] = []
  if (!o.q) lines.push("Current usage is unknown: the usage check failed, so Corvid can't tell whether you're over the limit.")
  else {
    lines.push(`Usage is at 5h ${gate(o.q.fiveHour, l.gate5hOn, l.gate5h)} and the week is at ${gate(o.q.week, l.gateWeekOn, l.gateWeek)}.`)
    if (o.five || o.week) lines.push(o.five && o.week ? 'Both limits are passed.' : o.five ? 'The 5-hour limit is passed.' : 'The weekly limit is passed.')
    if (o.fable) lines.push(`Fable usage is at ${pct(o.q.fable)} of the weekly Fable limit (limit ${l.gateWeek}%), and this agent runs on Fable.`)
    if (o.q.resets5h && o.q.resets5h > Date.now()) lines.push(`The 5-hour window resets at ${clock(o.q.resets5h)}.`)
    if (o.stale) lines.push(`These numbers are from ${Math.round((Date.now() - o.q.at) / 60_000)} minutes ago: the latest usage check failed.`)
  }
  lines.push("Agents started now may stall or stop when you reach your plan's limit, and work in progress could be cut off.")
  return lines.join(' ')
}

/** The freshest usage, checked again first when it's older than QUOTA_MAX_AGE. */
async function usageNow(): Promise<Usage | null> {
  const q = deps.quota()
  if (q && Date.now() - q.at <= QUOTA_MAX_AGE) return q
  await deps.refreshQuota()
  return deps.quota()
}

/** The #93 dialog text when usage is over the limit, or null: for asking before an extension scan (#96). */
export async function usageOverText(model?: string): Promise<string | null> {
  if (!deps) return null
  const o = overLimit(await usageNow(), model)
  return o ? overText(o) : null
}

/** Why a new worker can't start right now without asking, or null if it can (or would ask first). */
export async function startBlocker(): Promise<string | null> {
  const busy = concurrencyBlocker()
  if (busy) return busy
  const o = overLimit(await usageNow())
  return o && getConfig().limits.overLimit === 'block' ? usageBlocker(o) : null
}

/** startBlocker from what's already known, without refreshing usage. For showing in the UI: with "Ask me first",
 *  being over the usage limit isn't a blocker, since a start asks. startWorker still runs the full check. */
export function knownBlocker(): string | null {
  if (!deps) return null
  const o = overLimit(deps.quota())
  return concurrencyBlocker() ?? (o?.q && getConfig().limits.overLimit === 'block' ? usageBlocker(o) : null)
}

// ---------- asking before a start above the usage limit (#93) ----------
//
// Only the user's answer in Corvid's own dialog (deps.confirmOverLimit, a native message box) lets a start above the
// limit go ahead. No tool argument, board message or IPC call carries a yes: there is no flag to pass, and every start
// path (Automate, start_worker, approving a proposal, resuming by mention and its queue) runs through startWorker here.

/** How long the dialog waits before it counts as Cancel. */
export const CONFIRM_TIMEOUT_MS = 3 * 60_000

/** "Don't ask again until usage resets": until when. In memory only, so a restart asks again. */
let skipUntil = 0
/** One dialog at a time: two starts at once each get their own, one after the other. */
let asking: Promise<unknown> = Promise.resolve()

export interface ConfirmRequest {
  taskId: number
  taskTitle: string
  text: string
  timeoutMs: number
}

/** Ask the user whether to start `task` above the limit. Resolves with why not, or null to go ahead. */
async function askOverLimit(task: Task, o: OverLimit): Promise<string | null> {
  const turn = asking.then(() =>
    // a box ticked in an earlier dialog covers the starts after it, until the reset
    Date.now() < skipUntil
      ? { ok: true, dontAsk: true, timedOut: false }
      : deps.confirmOverLimit({ taskId: task.id, taskTitle: task.title, text: overText(o), timeoutMs: CONFIRM_TIMEOUT_MS })
  )
  asking = turn.catch(() => undefined)
  const a = await turn.catch((e) => {
    console.error('[workers] the usage confirmation failed', e)
    return { ok: false, dontAsk: false, timedOut: false }
  })
  if (!a.ok)
    return a.timedOut
      ? `Not started: usage is over the limit (${overShort(o)}) and nobody answered the confirmation in ${CONFIRM_TIMEOUT_MS / 60_000} minutes, which counts as Cancel.`
      : `Not started: usage is over the limit (${overShort(o)}) and the user chose Cancel.`
  // for this reset window only: the 5-hour reset when it's known, otherwise an hour
  if (a.dontAsk && Date.now() >= skipUntil) skipUntil = o.q?.resets5h && o.q.resets5h > Date.now() ? o.q.resets5h : Date.now() + 3600_000
  return null
}

/** An agent that isn't a task's worker (the packaging wizard, #100) goes through the same checks before it starts:
 *  a free slot, "Block new agents", and Corvid's own ask-first dialog. Resolves with why not, or null to go ahead. */
export async function extraAgentBlocker(label: string): Promise<string | null> {
  const busy = concurrencyBlocker()
  if (busy) return busy
  const o = overLimit(await usageNow())
  if (!o) return null
  if (getConfig().limits.overLimit === 'block') return usageBlocker(o)
  return askOverLimit({ id: 0, title: label } as Task, o)
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' / ').replace(/\s+/g, ' ').trim()

/** How notes refer to a worker: its name with the task number, or plain "Worker for #12" for one without. */
const who = (w: Worker, plain = 'Worker'): string => (w.agentName ? `${w.agentName} (#${w.taskId})` : `${plain} for #${w.taskId}`)

/**
 * A name for an agent about to start: a goofy job title, or with Goofy agent names off a plain one
 * ("Text Selector Agent"). Every agent gets one, so the board can always address it, by name or #task.
 * Never the same as another open agent's; `previous` (the name this task's last worker had) is kept
 * while it's free and still of the kind the setting asks for. The user's name from Settings is never
 * handed out: if a name would read as theirs on the board, the agent is the one that gets another.
 */
export function nameAgent(input: NameInput, previous?: string, keep = false): string {
  const goofy = getConfig().goofyNames
  const taken = pty
    .listTerminals()
    .filter((t) => t.exited === undefined && t.agentName)
    .map((t) => t.agentName!)
  const me = getConfig().userName
  const free = (n: string): boolean => !taken.some((t) => nameKey(t) === nameKey(n)) && (!me || nameKey(n) !== nameKey(me))
  if (previous && (keep || isPlainName(previous) !== goofy) && free(previous)) return previous
  for (;;) {
    const name = goofy ? agentName(input, taken) : plainAgentName(input, taken)
    if (free(name)) return name
    // only the user's name can clash here (taken ones are never picked): skip it and pick again
    taken.push(name)
  }
}

/**
 * A crow for an agent about to start, made here and never from anything the agent says. The same task
 * gets the same crow; `previous` (this task's last worker's) is kept while no running agent looks
 * like it, and a roll that would twin a running agent is rerolled.
 */
export function lookForAgent(taskId: number, previous?: CrowLook): CrowLook {
  const taken = runningWorkers().flatMap((w) => (w.avatar && w.taskId !== taskId ? [w.avatar] : []))
  if (previous && !taken.some((t) => looksAlike(t, previous))) return previous
  return agentLook(taskId, taken)
}

/** Session and tab titles keep "#<id> <task title>" first, which is what titles get matched on; the name follows. */
function workerTitle(task: Task, name?: string): string {
  const base = `#${task.id} ${task.title}`
  if (!name) return base.slice(0, 60)
  return `${base.length > 52 ? `${base.slice(0, 51).trimEnd()}…` : base} · ${name}`
}

/** Why nothing starts on a task in Done (#138). */
const inDone = (id: number): string => `#${id} is in Done, so no worker starts on it. Move it back to Up next first if there's more to do.`

/** Bringing back a task's ended agent in its own Claude session (#62): `message` is its first prompt, from the dashboard. */
export interface ResumeRequest {
  sessionId: string
  agentName?: string
  avatar?: CrowLook
  message: string
}

export async function startWorker(
  taskId: number,
  instructions?: string,
  resume?: ResumeRequest,
  /** over the usage limit, don't wait for the answer: return `asked` now, and start later only if the user says yes */
  detach = false
): Promise<{ worker?: Worker; error?: string; asked?: string }> {
  // real workers spend the user's Claude usage: a test copy starts one only when the test opts in (#85)
  if (!allowWorkers()) return { error: 'This is a test copy of Corvid, so it starts no workers (DASH_TEST_WORKERS=1 allows them).' }
  const task = deps.task(taskId)
  if (!task) return { error: resume ? `Task #${taskId} no longer exists (it was completed or discarded).` : `Task #${taskId} doesn't exist.` }
  // a finished task gets no new worker (#138); resuming its own agent by mention still works, to answer the user
  if (task.column === 'done' && !resume) return { error: inDone(taskId) }
  if (!task.project) return { error: `Task #${taskId} has no project set, so there's no folder to work in. Set a project on it first.` }
  // never in a missing folder (4/5): Claude would start in the wrong place and the work would land nowhere
  if (!existsSync(task.project))
    return { error: `No agent started for #${taskId}: its project folder ${task.project} is missing (moved, renamed, deleted, or on a drive that isn't connected). Use Locate folder… on the project page, then start it again.` }
  if (workers.some((w) => w.taskId === taskId && w.state === 'running')) return { error: `A worker is already running for #${taskId}.` }
  const busy = concurrencyBlocker()
  if (busy) return { error: busy }
  // the task's own model beats the worker model from Settings (#136); Fable is checked against the plan first
  const model = taskModel(task, getConfig().workerModel)
  if (model === 'fable') {
    const problem = await deps.fableProblem?.()
    if (problem) return { error: `No agent started for #${taskId}: ${problem} Pick another model for it in the task's editor${task.model ? '' : ' or in Settings'}.` }
  }
  const over = overLimit(await usageNow(), model)
  if (over && getConfig().limits.overLimit === 'block') return { error: usageBlocker(over) }
  if (over && detach) {
    void confirmedStart(task, over, instructions, resume).then((r) =>
      deps.note(
        r.error ? `Didn't start #${taskId}: ${r.error}` : `Started ${r.worker?.agentName ? `${r.worker.agentName} on` : 'a worker for'} #${taskId} above the usage limit, at your OK.`,
        r.error ? 'info' : 'warn'
      )
    )
    return {
      asked:
        `Usage is over the limit (${overShort(over)}), so the user has been asked in a dialog in Corvid's window whether to start #${taskId} anyway. ` +
        `It starts only if they choose "Start anyway"; Cancel, or no answer in ${CONFIRM_TIMEOUT_MS / 60_000} minutes, starts nothing. Nothing has started yet. ` +
        `Don't call start_worker again for it: no flag or argument skips the question.`
    }
  }
  return over ? confirmedStart(task, over, instructions, resume) : launchChecked(task, instructions, resume)
}

/** Ask, start only on the user's yes, and put the override on record. */
async function confirmedStart(task: Task, over: OverLimit, instructions?: string, resume?: ResumeRequest): Promise<{ worker?: Worker; error?: string }> {
  const no = await askOverLimit(task, over)
  if (no) return { error: no }
  // things may have changed while the dialog was up
  const now = deps.task(task.id)
  if (!now) return { error: `Task #${task.id} no longer exists.` }
  if (now.column === 'done' && !resume) return { error: inDone(task.id) }
  if (workers.some((w) => w.taskId === task.id && w.state === 'running')) return { error: `A worker is already running for #${task.id}.` }
  const r = await launchChecked(now, instructions, resume)
  if (r.worker) {
    console.warn(`[workers] override: #${task.id} started above the usage limit (${overShort(over)}) at the user's OK${Date.now() < skipUntil ? ' (no asking until the reset)' : ''}`)
    deps.announce(r.worker, `Started #${task.id} above the usage limit (${overShort(over)}) at your OK.`)
  }
  return r
}

/** The cap once more, in the same step as counting this start in, then launch. */
async function launchChecked(task: Task, instructions?: string, resume?: ResumeRequest): Promise<{ worker?: Worker; error?: string }> {
  if (!task.project) return { error: `Task #${task.id} has no project set, so there's no folder to work in.` }
  const blocked = concurrencyBlocker()
  if (blocked) return { error: blocked }
  starting++
  try {
    return await launch({ ...task, project: task.project }, instructions, resume)
  } finally {
    starting--
  }
}

/** For a task in Corvid's own project (#78): what's different about editing the tool you run in. */
function corvidLine(task: Task): string {
  const p = builtinProject()
  if (!p || task.projectId !== p.id) return ''
  return (
    ` This project is Corvid's own source: the running app is built from the main branch of this checkout, and a rebuild (npm run deploy) restarts it and ends every agent, so deploy only when the user asks and run the typecheck first. Be careful with changes to settings, stored data and scripts/deploy.mjs: a broken build breaks the tool itself.` +
    // #85: the rules for testing the app you're running in
    ` To test Corvid, start copies only with npm run test-instance (it gives each copy its own data folder, port and owner) and stop them with its stop command. Never kill or quit Corvid by name or image (${killByNameExamples()}), never point anything at the real data folder or the real app, never write to ~/.claude, and never deploy unless the user asked.`
  )
}

async function launch(task: Task & { project: string }, instructions?: string, resume?: ResumeRequest): Promise<{ worker?: Worker; error?: string }> {
  const bin = await resolveClaude(getConfig().claudePath)
  if (!bin) return { error: CLAUDE_NOT_FOUND }
  const sessionDir = resume ? sessionFolder(resume.sessionId) : undefined
  if (resume && !sessionDir) return { error: 'Its Claude session is gone (Claude Code deletes old sessions after about 30 days).' }

  const mode = getConfig().agentGitOverrides[projectKey(task.project)] ?? getConfig().agentGit
  const plan: BranchPlan = mode === 'branches' ? await prepareBranch(task.project, task.id, task.title) : { kind: 'current' }
  const b = plan.kind === 'branch' ? plan.b : undefined
  if (resume) {
    // never onto the default branch: with branches on, it goes back on its task branch or not at all
    if (mode === 'branches' && !b)
      return { error: `Couldn't put it back on its task branch (${plan.kind === 'current' ? plan.reason : 'no branch'}), and a resumed agent never works on the default branch.` }
    // Claude finds a session by id from any folder, but an agent should only carry on where it worked: its folder now,
    // or the same place before the project was moved (4/5)
    const here = b?.cwd ?? task.project
    const before = pastPathsOf(task.project).map((old) => old + here.slice(task.project.length))
    if (![here, ...before].some((c) => sessionDir === sessionKey(c))) {
      if (b && !b.reused) await cleanUp(b)
      return { error: `Its Claude session belongs to another folder than the one task #${task.id} works in now, so it can't be resumed there.` }
    }
  }
  const where = deps.folderNote?.(task)
  if (where) deps.note(where, 'info')
  if (plan.kind === 'current' && plan.reason) deps.note(`#${task.id} works on the current branch: ${plan.reason}.`, 'info')

  const minutes = getConfig().limits.workerMinutes
  const thesis = thesisDose(builtinProject()?.id === task.projectId ? 'full' : 'short', getConfig().agentSuggestions !== false).replace(/\n/g, ' ')
  const system =
    `You were started by Corvid, the user's dashboard assistant, to work on a single task (#${task.id}). Stay focused on it. ` +
    `Do not push to remotes, publish, deploy, or delete data unless the task explicitly asks for it. ` +
    TIME_LIMIT_PROMPT(minutes) +
    // what Corvid is (#202): the full page on the user's own copy of Corvid, the three sentences and the suggest rule elsewhere
    ` ${thesis}`
  const name = nameAgent(
    { seed: task.id, title: task.title, notes: task.notes, project: task.project },
    resume?.agentName ?? workers.find((w) => w.taskId === task.id)?.agentName,
    !!resume
  )
  const avatar = lookForAgent(task.id, resume?.avatar ?? workers.find((w) => w.taskId === task.id)?.avatar)
  const title = workerTitle(task, name)
  const model = taskModel(task, getConfig().workerModel)
  // the effort from Settings (#238), for new workers only; a running worker keeps the one it started with
  const effortSetting = getConfig().workerEffort
  const effort = isReasoningEffort(effortSetting) ? effortSetting : undefined
  const id = randomUUID().slice(0, 8)
  const access = deps.access({
    id,
    taskId: task.id,
    project: task.project,
    cwd: b?.cwd ?? task.project,
    agentName: name,
    avatar,
    request: [task.title, task.notes, instructions].filter(Boolean).join('\n'),
    branch: b,
    git: b
      ? gitAccess(b, `#${task.id} ${task.title}`, () => getConfig().pushAfterMerge, (message) => {
          const w = workers.find((x) => x.id === id)
          if (w) w.git = { state: 'merged', message }
          lineage.workerMerged(id, task.id, b.repo)
          // its branch is in (#138): an In progress task moves to Done. Only a move, never a delete, and a task
          // the user has put elsewhere in the meantime stays where it is
          if (deps.task(task.id)?.column === 'doing') deps.moveTask(task.id, 'done')
          deps.note(`${w ? who(w) : `#${task.id}`}: ${message.split('. ')[0]}.`, 'info')
          deps.gitChanged(b.repo)
          deps.changed()
        })
      : undefined
  })
  // a soft block: the user chose to start anyway, so the worker gets told to check before relying on it
  const open = openBlockers(task, deps.task)
  const blockedLine = open.length
    ? ` This task is blocked by ${open.map((b) => `#${b.id} (${BLOCKER_STATE[b.column]})`).join(', ')}; check the board and git log before relying on ${open.length > 1 ? 'them' : 'it'}, and say on the board what you found.`
    : ''
  // an earlier worker for this task that ended: the new one carries on from it rather than starting over
  const earlier = workers.find((w) => w.taskId === task.id && w.state !== 'running')
  const prompt = resume
    ? oneLine(`${resume.message}${access?.reminder ? ` ${access.reminder}` : ''}`)
    : oneLine(
        `Work on task #${task.id} from my task board: "${task.title}".` +
          (task.notes ? ` Notes: ${task.notes}` : '') +
          (instructions ? ` Extra instructions: ${instructions}` : '') +
          (taskFilesPrompt(task) ? ` ${taskFilesPrompt(task)}` : '') +
          blockedLine +
          corvidLine(task) +
          (earlier ? ` An earlier worker on this task ended (${earlier.reason ?? 'stopped'}); you are restarting it, so pick up from its work and the board.` : '') +
          (access?.reminder ? ` ${access.reminder}` : '') +
          ` When you're done, finish with a short summary of what you changed and anything left to do.`
      )
  const term = pty.launchWorker(
    bin.path,
    b?.cwd ?? task.project,
    title,
    prompt,
    access ? `${system} ${access.prompt}` : system,
    [...(resume ? ['--resume', resume.sessionId] : []), ...launchArgs(model, effort), ...(access?.args ?? [])],
    name
  )

  // the lineage log (#203): what this worker was given, measured here where it is put together
  lineage.workerStarted({ workerId: id, agentName: name, taskId: task.id, project: task.project, title: task.title, notes: task.notes, instructions, attachedBytes: (task.attachments ?? []).reduce((s, a) => s + a.size, 0), rules: `${system} ${access?.prompt ?? ''}`.replace(thesis, ''), thesis, resumed: !!resume })
  const worker: Worker = {
    id,
    taskId: task.id,
    taskTitle: task.title,
    agentName: name,
    avatar,
    model,
    ...(effort ? { effort } : {}),
    termId: term.termId,
    project: task.project,
    // every start, restart and resume gets a fresh clock, never an earlier worker's
    startedAt: Date.now(),
    workedMs: 0,
    clockFrom: Date.now(),
    state: 'running',
    ...(resume && { sessionId: resume.sessionId }),
    ...(b && { branch: b.branch, worktree: b.worktree, git: { state: 'working' as const } })
  }
  remember(worker, b?.cwd ?? task.project)
  if (b) {
    branches.set(id, b)
    setActive(b, true)
  }
  // a replacement supersedes earlier ended workers for the same task
  for (const old of workers.filter((x) => x.taskId === task.id && x.state !== 'running')) workers.splice(workers.indexOf(old), 1)
  workers.unshift(worker)
  pruneEnded()
  // an agent resumed on a task in Done (to answer a mention) leaves it there
  if (deps.task(task.id)?.column !== 'done') deps.moveTask(task.id, 'doing')
  deps.changed()
  return { worker }
}

/** What the assistant's start_worker does: in "ask" mode only propose, otherwise start within the limits.
 *  The task board's Automate button goes through here too. */
export async function requestWorker(
  taskId: number,
  instructions?: string,
  detach = false
): Promise<{ proposal?: Proposal; worker?: Worker; error?: string; asked?: string }> {
  if (getConfig().assistantMode === 'ask') {
    const p = propose(taskId, instructions)
    return 'error' in p ? { error: p.error } : { proposal: p }
  }
  return startWorker(taskId, instructions, undefined, detach)
}

/** `state` finished is for a finished agent the dashboard closed (#70), so it doesn't read as stopped by you or a failure. */
export function stopWorker(id: string, reason = 'Stopped by you', state: 'stopped' | 'finished' = 'stopped'): Worker | undefined {
  const w = workers.find((x) => x.id === id)
  if (!w || w.state !== 'running') return w
  w.state = state
  w.endedAt = Date.now()
  pauseClock(w, w.endedAt)
  w.liveStatus = undefined
  w.reason = reason
  w.closeAt = w.closeHeld = undefined
  quiet.delete(w.id)
  remember(w)
  pty.kill(w.termId)
  deps.ended(w)
  // give the process a moment to let go of its folder
  setTimeout(() => void finishBranch(w), 3000)
  deps.changed()
  return w
}

/** Remove an ended worker from the list. Running workers have to be stopped first. */
export function dismissWorker(id: string): void {
  const w = workers.find((x) => x.id === id)
  if (!w || w.state === 'running') return
  workers.splice(workers.indexOf(w), 1)
  deps.changed()
}

export function stopAll(reason = 'Stopped with kill-all'): number {
  const running = runningWorkers()
  for (const w of running) stopWorker(w.id, reason)
  return running.length
}

// ---------- the time limit (#81) ----------

/**
 * What a worker is told about its time limit. Agents can't see a clock and tend to think far more time
 * has passed than has (they wrapped up "at the 45-minute limit" after 8 to 15 minutes), so they're told
 * to ask instead of guessing.
 */
export const TIME_LIMIT_PROMPT = (minutes: number): string =>
  `The dashboard stops this session after ${minutes} minutes of work; time the computer sleeps or you wait for the user doesn't count, and every start or resume gets a fresh clock. ` +
  'You cannot feel time passing and will tend to think much more has passed than really has, so never stop early, skip steps or say you ran out of time on a guess: ' +
  'call time_left (mcp__corvid__time_left) to see how long you have, always before cutting anything short. Your board tool results show it too, and warn you when 5 minutes are left.'

let lastTick = Date.now()
let asleep = false

/** Not working on its own: at a permission prompt, waiting for an approval, or ended its turn on a question to the user. */
function waitingForYou(w: Worker): boolean {
  if (w.liveStatus === 'waiting' || w.liveStatus === 'blocked') return true
  if (deps.awaitingApproval?.(w)) return true
  return w.liveStatus === 'idle' && deps.waitingOnUser(w)
}

/** Move every running worker's clock on (paused while it waits for you), then check the limit. */
export function tickClocks(now: number): void {
  if (asleep) return
  let changed = false
  for (const w of runningWorkers()) {
    const you = waitingForYou(w)
    if (tickClock(w, now, lastTick, you)) changed = true
    const paused = you ? 'you' : undefined
    if (w.paused !== paused) {
      w.paused = paused
      changed = true
    }
  }
  lastTick = now
  enforceTimeLimit(now)
  if (changed) deps.changed()
}

export function suspendClocks(now: number): void {
  if (asleep) return
  asleep = true
  for (const w of runningWorkers()) {
    pauseClock(w, now)
    w.paused = 'sleep'
  }
  console.log(`[workers] suspend: ${runningWorkers().length} worker clock(s) paused`)
  deps.changed()
}

export function resumeClocks(now: number): void {
  if (!asleep) return
  asleep = false
  lastTick = now
  for (const w of runningWorkers()) w.paused = undefined
  console.log('[workers] resume: worker clocks running again')
  tickClocks(now)
  deps.changed()
}

const wholeMinutes = (ms: number): number => Math.floor(ms / 60_000)

/** The line a worker's own Corvid tools add to their results: its clock, or a last call once 5 minutes are left. */
export function clockNote(workerId: string, now = Date.now()): string | undefined {
  const w = workers.find((x) => x.id === workerId && x.state === 'running')
  if (!w) return undefined
  const limit = getConfig().limits.workerMinutes
  const line = clockLine(w, now, limit)
  if (workedMs(w, now) >= limit * 60_000 - WARN_BEFORE_MS)
    return `[Your clock: ${line}. Wrap up now: commit what you have, say on the board what's left, and post your done message before the dashboard stops you.]`
  return `[Your clock: ${line}; sleep and waiting for the user don't count. Don't cut work short on a guess about the time.]`
}

function enforceTimeLimit(now: number): void {
  const limit = getConfig().limits.workerMinutes
  const limitMs = limit * 60_000
  for (const w of runningWorkers()) {
    const worked = workedMs(w, now)
    if (worked >= limitMs) {
      // the measured time, never the setting: a notice saying 45 whatever really happened is part of what #81 found
      const ran = wholeMinutes(worked)
      const wall = wholeMinutes(now - w.startedAt)
      stopWorker(w.id, `Time limit (worked ${ran} of ${limit} min)`)
      deps.note(`Stopped ${who(w, 'the worker')}: it worked ${ran} minutes, the limit is ${limit}.`, 'warn')
      // it was killed mid-task, so it never got to post its own done message
      deps.announce(
        w,
        `Stopped at the time limit: ${who(w, 'the worker')} worked for ${ran} minutes (limit ${limit})` +
          (wall > ran ? `, ${wall} minutes after it started, the rest asleep or waiting for you` : '') +
          `, and couldn't post its own done message.` +
          (w.branch ? ` Commits it made, if any, stay on ${w.branch}.` : '') +
          ` Its terminal in Agents shows how far it got; start a worker on #${w.taskId} again to carry on.`
      )
    } else if (worked >= limitMs - WARN_BEFORE_MS && !warned.has(w.id)) {
      warned.add(w.id)
      const left = Math.max(1, Math.ceil((limitMs - worked) / 60_000))
      deps.note(`${who(w)} will be stopped in about ${left} minute${left === 1 ? '' : 's'}: it has worked ${wholeMinutes(worked)} of ${limit}.`, 'warn')
    }
  }
}

/** Fold the live registry into worker state; note when a worker finishes a turn. */
export function updateFromLive(list: LiveSession[]): void {
  let changed = false
  for (const w of runningWorkers()) {
    const l = list.find((x) => x.termId === w.termId)
    if (!l) continue
    if (w.liveStatus === 'busy' && l.status !== 'busy') {
      deps.note(
        l.status === 'idle'
          ? `${who(w)} finished its turn. Review it in Agents.`
          : `${who(w)} needs you${l.waitingFor ? `: ${l.waitingFor}` : ''}.`,
        l.status === 'idle' ? 'info' : 'warn'
      )
    }
    if (w.liveStatus !== l.status || w.sessionId !== l.sessionId) changed = true
    w.liveStatus = l.status
    if (l.sessionId && w.sessionId !== l.sessionId) {
      w.sessionId = l.sessionId
      remember(w)
    }
  }
  if (changed) deps.changed()
}

/** A worker that exits with an error this soon after starting never got going (a model the plan lacks, say). */
const START_FAIL_MS = 45_000

/** The CLI's own words from a worker's terminal: the last line that reads like an error, else the last line. */
function exitReason(termId: string): string {
  const lines = pty
    .attach(termId)
    .replace(NOT_TYPING, '')
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean)
  const line = [...lines].reverse().find((l) => /error|model|not available|invalid|access|permission/i.test(l)) ?? lines.at(-1)
  return line ? line.slice(0, 200) : 'no output'
}

/**
 * A worker that exited with an error within START_FAIL_MS (#136): no dead card is left behind. It's taken off the list
 * with its terminal, the task goes back to Next, and the reason (with the model it was started on) is reported.
 */
function failedStart(w: Worker, code: number): boolean {
  if (code === 0 || Date.now() - w.startedAt > START_FAIL_MS) return false
  const reason = exitReason(w.termId)
  const on = w.model === 'default' ? 'your Claude Code default model' : choiceLabel(w.model)
  w.state = 'exited'
  w.endedAt = Date.now()
  pauseClock(w, w.endedAt)
  w.liveStatus = undefined
  w.reason = `Didn't start on ${on}: ${reason}`
  quiet.delete(w.id)
  remember(w)
  deps.ended(w)
  void finishBranch(w)
  workers.splice(workers.indexOf(w), 1)
  pty.close(w.termId)
  if (deps.task(w.taskId)?.column !== 'done') deps.moveTask(w.taskId, 'next')
  const fix = deps.task(w.taskId)?.model ? "Pick another model in the task's editor" : 'Pick another worker model in Settings'
  deps.note(`#${w.taskId} didn't start on ${on}: claude exited with code ${code} (${reason}). ${fix}, then start it again.`, 'error')
  deps.changed()
  return true
}

/** Called whenever usage updates: warn (at most hourly) if workers run past the gates. */
export function checkUsage(fiveHour?: number, week?: number, fable?: number): void {
  if (!runningWorkers().length || Date.now() - lastQuotaWarning < 3600_000) return
  const l = getConfig().limits
  const over = overGates(l, fiveHour, week)
  // Fable's weekly limit only matters while Fable agents run, or when new ones would start on it
  const fableOver = overFableGate(l, fable) && (getConfig().workerModel === 'fable' || runningWorkers().some((w) => w.model === 'fable'))
  if (over.five || over.week || fableOver) {
    lastQuotaWarning = Date.now()
    deps.note(
      `Usage is past your limit for new agents (5h ${Math.round(fiveHour ?? 0)}%, week ${Math.round(week ?? 0)}%${fableOver ? `, Fable week ${Math.round(fable ?? 0)}%` : ''}) while ${runningWorkers().length} worker(s) run. ` +
        `${l.overLimit === 'block' ? 'No new ones will start' : 'New ones will ask you first'}; use Stop all to halt these.`,
      'warn'
    )
  }
}

/** A worker ended: remove its worktree and branch if nothing on it is left unmerged, else keep and say why. */
async function finishBranch(w: Worker): Promise<void> {
  const b = branches.get(w.id)
  if (!b) return
  branches.delete(w.id)
  setActive(b, false)
  let kept = await cleanUp(b)
  // the process can take a few seconds to let go of the folder
  if (kept && /permission|in use|being used|busy|denied/i.test(kept)) {
    await new Promise((r) => setTimeout(r, 5000))
    kept = await cleanUp(b)
  }
  const merged = w.git?.state === 'merged'
  w.git = kept
    ? { state: 'kept', message: kept }
    : { state: 'removed', message: merged ? w.git?.message : `${b.branch} had no commits of its own, so it was removed.` }
  if (kept) deps.note(`${who(w)}: ${kept}`, /not merged/.test(kept) ? 'warn' : 'info')
  deps.gitChanged(b.repo)
  deps.changed()
}

// ---------- closing finished agents (#70) ----------
//
// An agent counts as finished once it has posted its done post (post_message with done: true) and sits idle with nothing
// happening: no output, no typing, no mention, its terminal not on screen, no question to the user unanswered and no
// approval pending. Then a countdown runs, and at its end it's stopped through stopWorker like any other, so finishBranch
// cleans up as usual. Nothing here merges: it only closes once its git shows nothing unmerged or uncommitted, and
// cleanUp checks that again itself before removing a branch. Agents that never post done (started before this) stay open.

/** Debug: DASH_CLOSE_FINISHED_SEC=<n> closes finished agents after n seconds instead of the setting's minutes, for tests. */
function closeDelay(): { ms: number; label: string } | null {
  const sec = Math.round(Number(process.env.DASH_CLOSE_FINISHED_SEC))
  if (sec > 0) return { ms: sec * 1000, label: `${sec} second${sec === 1 ? '' : 's'}` }
  const min = getConfig().closeFinishedMinutes
  return min > 0 ? { ms: min * 60_000, label: `${min} minute${min === 1 ? '' : 's'}` } : null
}

/** How long it has to read idle after its done post before going busy again counts as working again, not a blip. */
const IDLE_SETTLE_MS = 5000
/** How often a finished agent's git is looked at again while it waits. */
const GIT_RECHECK_MS = 20_000

/** Per running worker, kept off Worker since the window doesn't need it. */
interface Quiet {
  /** the last time something held or reset it: typing, a mention, its terminal on screen, not idle */
  since: number
  /** when it was first seen idle after its done post */
  idleAt?: number
  /** the last look at its git, and what it found (the card's note), null for nothing unmerged */
  gitAt?: number
  held?: string | null
  checking?: boolean
}
const quiet = new Map<string, Quiet>()
/** terminals the window has on screen or focused */
let viewing = new Set<string>()

function quietOf(w: Worker): Quiet {
  let q = quiet.get(w.id)
  if (!q) quiet.set(w.id, (q = { since: Date.now() }))
  return q
}

/** The agent on this task posted its done post. */
export function markDone(taskId: number): void {
  const w = runningWorkers().find((x) => x.taskId === taskId)
  if (!w) return
  w.doneAt = Date.now()
  w.keepOpen = undefined
  quiet.set(w.id, { since: w.doneAt })
  deps.changed()
}

/** Something happened to it: the countdown, if one runs, starts over. */
function touch(w: Worker): void {
  quietOf(w).since = Date.now()
  if (w.closeAt === undefined) return
  w.closeAt = undefined
  deps.changed()
}

/** Escape sequences that aren't typing: focus reports and the terminal's answers to queries (keys like arrows go too). */
const NOT_TYPING = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)?|\x1b[^\r]/g

/** Keys the user pressed, not just the terminal answering a query or reporting focus. */
export const isTyping = (data: string): boolean => !!data.replace(NOT_TYPING, '')

/** The user typed into a terminal. */
export function typed(termId: string, data: string): void {
  const w = runningWorkers().find((x) => x.termId === termId)
  if (w && isTyping(data)) touch(w)
}

/** A board message addressed these agents by name, or replied to one of their posts; `fromTask` is the poster's own task. */
export function addressed(names: string[], fromTask?: number): void {
  for (const w of runningWorkers())
    if (w.agentName && w.taskId !== fromTask && names.some((n) => nameKey(n) === nameKey(w.agentName!))) touch(w)
}

/** The terminals the window has on screen or focused: an agent there is never closed. */
export function setViewing(termIds: unknown): void {
  viewing = new Set(Array.isArray(termIds) ? termIds.filter((t): t is string => typeof t === 'string') : [])
  for (const w of runningWorkers()) if (viewing.has(w.termId)) touch(w)
}

/** Keep open: no countdown for it until it works again and posts another done post. */
export function keepOpen(id: string): void {
  const w = workers.find((x) => x.id === id && x.state === 'running')
  if (!w) return
  w.keepOpen = true
  w.closeAt = undefined
  deps.changed()
}

/** Why it can't count down now: not finished, not quiet, or someone may still need it. */
const held = (w: Worker): boolean => !w.doneAt || w.liveStatus !== 'idle' || !!w.keepOpen || viewing.has(w.termId) || deps.waitingOnUser(w)

async function checkGit(w: Worker, q: Quiet): Promise<void> {
  q.checking = true
  try {
    q.held = await unsavedWork(branches.get(w.id), w.worktree ?? w.project)
  } finally {
    q.checking = false
    q.gitAt = Date.now()
  }
}

/** Every second: start, show, reset or finish each finished agent's countdown. */
function closeFinished(): void {
  const delay = closeDelay()
  const now = Date.now()
  let changed = false
  const show = (w: Worker, closeAt: number | undefined, note: string | undefined): void => {
    if (w.closeAt === closeAt && w.closeHeld === note) return
    w.closeAt = closeAt
    w.closeHeld = note
    changed = true
  }
  for (const w of runningWorkers()) {
    const q = quietOf(w)
    // working (or waiting) again after its done turn ended: it has to post done again before it counts as finished
    if (w.doneAt && w.liveStatus === 'idle') q.idleAt ??= now
    else if (w.doneAt && w.liveStatus && q.idleAt !== undefined) {
      if (now - q.idleAt >= IDLE_SETTLE_MS) {
        w.doneAt = w.keepOpen = undefined
        changed = true
      }
      q.idleAt = undefined
    }
    if (!delay || !w.doneAt) {
      show(w, undefined, undefined)
      continue
    }
    const idle = w.liveStatus === 'idle'
    // its git is looked at now and then while it sits finished; the note shows even while something else holds it
    if (idle && !q.checking && (q.gitAt === undefined || now - q.gitAt > GIT_RECHECK_MS)) void checkGit(w, q)
    const note = idle ? (q.held ?? undefined) : undefined
    const wait = held(w)
    if (wait) q.since = now
    if (wait || note || q.gitAt === undefined) {
      show(w, undefined, note)
      continue
    }
    const closeAt = Math.max(q.since, w.doneAt, q.idleAt ?? now, pty.lastOutput(w.termId) ?? 0) + delay.ms
    show(w, closeAt, undefined)
    if (now >= closeAt && !q.checking) void close(w, q)
  }
  if (changed) deps.changed()
}

/** The countdown ran out: look at its git once more, and close it only if it would still be closed now. */
async function close(w: Worker, q: Quiet): Promise<void> {
  await checkGit(w, q)
  const delay = closeDelay()
  if (w.state !== 'running' || !delay || held(w)) return
  if (q.held) {
    w.closeAt = undefined
    w.closeHeld = q.held
    return deps.changed()
  }
  // something may have printed or happened while git ran
  if (Date.now() < Math.max(q.since, w.doneAt!, pty.lastOutput(w.termId) ?? 0) + delay.ms) return
  stopWorker(w.id, `Finished, closed after ${delay.label} idle`, 'finished')
  deps.announce(w, `${who(w)} wrapped up and was closed after ${delay.label} idle. Mention it here to bring it back.`)
}

function pruneEnded(): void {
  const ended = workers.filter((w) => w.state !== 'running')
  for (const w of ended.slice(8)) workers.splice(workers.indexOf(w), 1)
}

// ---------- resuming an agent (#62) ----------

/** How Claude Code names a folder's session directory under ~/.claude/projects: every other character becomes "-". */
const sessionKey = (cwd: string): string => cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
const claudeProjects = (): string => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')

/** The session directory (as a sessionKey) that holds this session's transcript, or undefined when Claude Code has deleted it. */
function sessionFolder(sessionId: string): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined
  try {
    for (const d of readdirSync(claudeProjects())) if (existsSync(join(claudeProjects(), d, `${sessionId}.jsonl`))) return d.toLowerCase()
  } catch {
    /* no Claude data */
  }
  return undefined
}

/** The task of the agent called `name`: a listed worker first, then what's remembered from before a restart. */
/** Session ids of agents Corvid started for tasks (agents.json), for the project import's skip rules. */
export function agentSessionIds(): Set<string> {
  return new Set([...records.values()].map((r) => r.sessionId).filter((id): id is string => !!id))
}

export function taskOfAgent(name: string): number | undefined {
  const k = nameKey(name)
  return (
    workers.find((w) => w.agentName && nameKey(w.agentName) === k)?.taskId ??
    [...records.values()].sort((a, b) => (b.endedAt ?? Infinity) - (a.endedAt ?? Infinity)).find((r) => r.agentName && nameKey(r.agentName) === k)?.taskId
  )
}

/**
 * Bring task `taskId`'s last agent back in its own Claude session, through startWorker, so the cap, the usage gates, the
 * time limit (it restarts), the branch and the "a replacement supersedes earlier ended workers" rule are the same as for
 * any start. `message` is its first prompt, from the dashboard.
 */
export async function resumeWorker(taskId: number, message: string): Promise<{ worker?: Worker; error?: string }> {
  if (workers.some((w) => w.taskId === taskId && w.state === 'running')) return { error: 'It is already running.' }
  const listed = workers.find((w) => w.taskId === taskId)
  const rec = records.get(taskId)
  const sessionId = listed?.sessionId ?? rec?.sessionId
  if (!sessionId) return { error: "Corvid never learned its Claude session, so there's nothing to resume." }
  return startWorker(taskId, undefined, { sessionId, agentName: listed?.agentName ?? rec?.agentName, avatar: listed?.avatar ?? rec?.avatar, message })
}

/**
 * Why an agent's ping may not wake task `taskId`'s last agent (#195), or null when it may: only one that finished on
 * its own (closed after idle, or its session ended normally) is woken, never one the user, Corvid, the kill switch, the
 * time limit (waking it would sidestep that limit) or anything else stopped, nor one whose task was removed; and never
 * over the worker cap or at or above the usage gates, whatever "above the limit" says, since only the user can answer
 * that dialog. startWorker runs all its own checks again after this.
 */
export async function agentWakeBlocker(taskId: number): Promise<string | null> {
  const task = deps.task(taskId)
  if (!task) return `task #${taskId} was removed`
  if (workers.some((w) => w.taskId === taskId && w.state === 'running')) return null
  const listed = workers.find((w) => w.taskId === taskId)
  const rec = records.get(taskId)
  const state = listed?.state ?? rec?.endState
  const reason = listed?.reason ?? rec?.endReason ?? ''
  if (!(listed?.sessionId ?? rec?.sessionId)) return "Corvid never learned its Claude session, so there's nothing to resume"
  const ended = endedRefusal(state, reason)
  if (ended) return ended
  const busy = concurrencyBlocker()
  if (busy) return `no free agent slot: ${busy}`
  const o = overLimit(await usageNow(), taskModel(task, getConfig().workerModel))
  if (o) return `usage is at or above the limit (${overShort(o)}), and only the user can start an agent past it`
  return null
}

// ---------- proposals ("Plan & ask" mode) ----------

export function propose(taskId: number, instructions?: string): Proposal | { error: string } {
  const task = deps.task(taskId)
  if (!task) return { error: `Task #${taskId} doesn't exist.` }
  if (task.column === 'done') return { error: inDone(taskId) }
  if (!task.project) return { error: `Task #${taskId} has no project set. Set a project on it first.` }
  const existing = proposals.find((p) => p.taskId === taskId)
  if (existing) return existing
  const p: Proposal = {
    id: randomUUID().slice(0, 8),
    taskId,
    taskTitle: task.title,
    project: task.project,
    instructions,
    createdAt: Date.now()
  }
  proposals.push(p)
  deps.changed()
  return p
}

export async function approve(id: string): Promise<void> {
  const p = proposals.find((x) => x.id === id)
  if (!p) return
  proposals.splice(proposals.indexOf(p), 1)
  deps.changed()
  const r = await startWorker(p.taskId, p.instructions)
  deps.note(
    r.error ? `Couldn't start #${p.taskId}: ${r.error}` : `Started ${r.worker?.agentName ? `${r.worker.agentName} on` : 'a worker for'} #${p.taskId}.`,
    r.error ? 'error' : 'info'
  )
}

export function reject(id: string): void {
  const p = proposals.find((x) => x.id === id)
  if (!p) return
  proposals.splice(proposals.indexOf(p), 1)
  deps.note(`Declined the worker for #${p.taskId}.`, 'info')
  deps.changed()
}
