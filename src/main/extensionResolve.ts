import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { z } from 'zod'
import { parseUnifiedDiff, scanDiff } from '@shared/extensionDiffScan'
import type { CostEstimate } from '@shared/costEstimate'
import type { ConflictHold, LifecycleResult, PendingChange, ResolvePrompt } from '@shared/extensionLifecycle'
import type { ExtensionRecord } from '@shared/extensions'
import { CORE_AREAS, isProtectedPath, PROTECTED_PATHS } from '@shared/extensionTiers'
import { pathKey } from '@shared/pathKeys'
import type { AccessPart } from './agentAccess'
import { absRule } from './agentDeny'
import { linkDeps, slug, unlinkDeps, type AgentBranch } from './agentGit'
import * as ledger from './extensions'
import { event, recordOf, typecheck } from './extensionLifecycle'

// "Resolve with an agent" (#117, docs/EXTENSIONS.md "Lifecycle"): a Disable or Remove whose revert conflicted with later
// changes to Corvid (Dracula's theme entry after #114's theme socket, say). prepare() keeps the branch and worktree with
// the revert left conflicted; after the user's Confirm (estimate, cap, usage warning) a normal worker on a build task
// edits the conflicted files to take the extension out and keep everything newer, commits, and reports. Corvid then
// checks the result itself (the commit and its trailers, the files, protected paths, the diff scan, the typecheck) and
// turns it into the same pending change the automatic path makes, for the user's review and merge.
//
// The agent never merges, confirms or touches the ledger: its only tool is submit_resolution_report, which runs
// Corvid's checks. Starting, approving, sending back and leaving come only from Corvid's own window.

export interface ResolveDeps {
  createTask: (t: { title: string; notes: string; projectId: string; project: string }) => { id: number }
  removeTask: (id: number) => void
  taskExists: (id: number) => boolean
  corvidProjectId: () => string | undefined
  startWorker: (taskId: number, instructions: string) => Promise<{ worker?: { id: string; branch?: string; worktree?: string }; error?: string; asked?: string }>
  resumeWorker: (taskId: number, message: string) => Promise<{ worker?: { id: string }; error?: string }>
  stopWorker: (workerId: string, reason: string) => void
  workerRunning: (taskId: number) => boolean
  /** #97: the estimate for a resolution, the confirmation's cap and usage warning, and the soft cap while it runs */
  estimate: (tier: 1 | 2 | 3, conflictChars: number) => CostEstimate
  prompt: (e: CostEstimate) => Omit<ResolvePrompt, 'token' | 'files' | 'protectedFiles'>
  watch: (o: { taskId: number; what: string; estimate: CostEstimate; stop: () => void; seedChars: number; checks: number; tier: 1 | 2 | 3 }) => { finish: (outcome: 'ok' | 'failed' | 'cancelled') => unknown }
  notice: (text: string, taskId?: number) => void
  gitChanged: (repo: string) => void
  /** the app's data folder: the agent's file tools are denied it (the ledger lives there) */
  dataDir: () => string
}

let deps: ResolveDeps | undefined
export const initResolve = (d: ResolveDeps): void => {
  deps = d
  interrupted()
}

/** Resolutions in progress, by task id (in memory; the ledger has the rest). */
const running = new Map<number, { key: string; watch?: { finish: (o: 'ok' | 'failed' | 'cancelled') => unknown }; stopReason?: string }>()

function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()))
      else resolve(stdout)
    })
  })
}

const SUBJECT = { disable: 'Disable', remove: 'Remove' } as const
const holdOf = (key: string): ConflictHold | undefined => recordOf(key)?.lifecycle?.conflict
const recordOfTask = (taskId: number): ExtensionRecord | undefined => ledger.list().find((r) => r.lifecycle?.conflict?.taskId === taskId)
/** Whether a task is a conflict resolution (its worker gets the report tool, its own git prompt and deny rules). */
export const isResolveTask = (taskId: number): boolean => recordOfTask(taskId)?.lifecycle?.conflict?.state === 'resolving'
const setHold = (key: string, f: (h: ConflictHold) => Partial<ConflictHold>, e?: Parameters<typeof ledger.updateLifecycle>[2]): void =>
  void ledger.updateLifecycle(key, (x) => ({ lifecycle: { ...x.lifecycle, conflict: x.lifecycle?.conflict && { ...x.lifecycle.conflict, ...f(x.lifecycle.conflict) } } }), e)
/** A path with 8.3 short names, junctions and symlinks resolved where it exists: git reports a worktree by its real
 *  path, which can be spelled differently from the hold's (a CI runner's TEMP is C:\Users\RUNNER~1\...). */
const realPath = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return resolvePath(p)
  }
}
const samePath = (a?: string, b?: string): boolean => !!a && !!b && pathKey(realPath(a)) === pathKey(realPath(b))
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

/** A resolution that was running when Corvid stopped can't be followed any more: "Resolution interrupted". */
function interrupted(): void {
  for (const r of ledger.list())
    if (r.lifecycle?.conflict?.state === 'resolving' && !running.has(r.lifecycle.conflict.taskId ?? -1))
      setHold(r.key, () => ({ state: 'interrupted', workerId: undefined, reasons: ['Corvid restarted while the agent was resolving the conflict. The branch is kept: Retry starts again from the conflict, Leave it removes the branch.'] }))
}

// ---------- the confirmation ----------

/** One token per dialog, 15 minutes, used once; in memory only. */
const tokens = new Map<string, { key: string; estimate: CostEstimate; until: number }>()

/** The confirmation's content: #97's estimate for this conflict, the cap and the usage warning (#93). */
export async function prepareResolve(key: string): Promise<ResolvePrompt | { error: string }> {
  if (!deps) return { error: 'Conflict resolution is not ready yet.' }
  const r = recordOf(key)
  const h = r?.lifecycle?.conflict
  if (!r || !h) return { error: 'There is no conflict waiting for this extension.' }
  if (h.state === 'resolving') return { error: 'An agent is already resolving it.' }
  if (!existsSync(h.worktree)) return { error: `The conflict's worktree ${h.worktree} is gone. Leave it as it is, then run ${h.op === 'remove' ? 'Remove' : 'Disable'} again.` }
  const text = await git(h.repo, ['diff', '--no-color', `${h.revertOf}^1`, h.revertOf, '--', ...h.files]).catch(() => '')
  const est = deps.estimate(r.header.capabilities.tier, text.length + 2000 * h.files.length)
  const now = Date.now()
  for (const [t, v] of tokens) if (v.until < now) tokens.delete(t)
  const token = randomUUID()
  tokens.set(token, { key, estimate: est, until: now + 15 * 60_000 })
  return { token, ...deps.prompt(est), files: h.files, protectedFiles: h.protectedFiles }
}

/** The user pressed Confirm in Corvid's window: the only way a resolution starts. Protected paths need their own tick. */
export async function confirmResolve(key: unknown, token: unknown, protectedOk: unknown): Promise<{ ok: true; taskId: number } | { error: string }> {
  const t = typeof token === 'string' ? tokens.get(token) : undefined
  if (!t || t.key !== key || t.until < Date.now()) return { error: 'This confirmation has expired. Press Resolve with an agent again to see a fresh estimate.' }
  tokens.delete(token as string)
  const h = holdOf(t.key)
  if (!h) return { error: 'There is no conflict waiting for this extension.' }
  if (h.protectedFiles.length && protectedOk !== true) return { error: `The conflict is in protected parts of Corvid (${h.protectedFiles.join(', ')}). Tick the extra confirmation first.` }
  if (deps?.prompt(t.estimate).usage?.block) return { error: "You're over your usage limit and Settings blocks new agents, so nothing was started." }
  return start(t.key, t.estimate)
}

// ---------- the agent ----------

/** The resolution agent's task text: what to take out, what to keep, and the rules. */
export function resolveInstructions(r: ExtensionRecord, h: ConflictHold): string {
  const s = SUBJECT[h.op]
  return [
    `EXTENSION CONFLICT RESOLUTION. ${s} the extension "${r.name}" ${r.version} (id ${r.id}) from Corvid, on the branch ${h.branch}. Corvid ran \`git revert --no-commit\` of the commit that put it into main, ${h.revertOf}, and it conflicted with later changes to Corvid. The revert is left in that state in your worktree: the conflicted files have conflict markers, everything else is already staged.`,
    `The extension's merge commit: ${h.revertOf} (see what it changed with \`git show --first-parent ${h.revertOf}\` or \`git diff ${h.revertOf}^1 ${h.revertOf}\`).`,
    `The files the extension changed: ${h.extFiles.join(', ') || '(none recorded)'}.`,
    `The conflicted files: ${h.files.join(', ')}.`,
    `Goal: resolve the conflict so that EVERYTHING the extension added is removed and EVERYTHING that landed in Corvid since (for example #114's theme socket) is kept. Touch nothing else: no other files, no refactoring, no formatting changes.`,
    `How: edit the conflicted files by hand (remove the markers, keep the newer code, take out only the extension's lines), \`git add\` them, and check \`git status\` shows nothing unmerged. Then commit once with exactly this message:`,
    `  subject: ${s} extension ${r.id} ${r.version}`,
    `  body (trailers, on their own lines): Corvid-Extension-${s}: ${r.id} ${r.version}`,
    `                                      Corvid-Extension-Hash: ${r.hash}`,
    `(for example \`git commit -m "${s} extension ${r.id} ${r.version}" -m "Corvid-Extension-${s}: ${r.id} ${r.version}" -m "Corvid-Extension-Hash: ${r.hash}"\`, or one -m with the two trailer lines together).`,
    `Run the typecheck (npm run typecheck) and the existing tests that cover the files you touched (the npm run test-* scripts in package.json). Then call mcp__corvid__submit_resolution_report once with a short report: what you took out, what you kept, the tests you ran and their results.`,
    `Never push, merge, rebase, reset, deploy, switch branches, or change git config. Never touch Corvid's extension ledger or its data folder. You can't approve anything: Corvid checks your commit itself (the files, protected paths, the diff scan and the typecheck), and the user reviews and merges it in Corvid's own window.`
  ].join('\n')
}

/** The deny rules: the protected paths (except a protected conflicted file the user confirmed), the main checkout, the
 *  data folder, and agent and git configuration. Read rules for secrets come from #91. */
export function resolveDenyRules(h: ConflictHold, cwd: string, dataDir?: string): string[] {
  const allowed = h.protectedFiles.filter((f) => h.extFiles.includes(f))
  const paths = [...new Set(CORE_AREAS.filter((a) => a.protected).flatMap((a) => a.paths))].filter((p) => PROTECTED_PATHS.includes(p) && !allowed.some((f) => (p.endsWith('/') ? f.startsWith(p) : f === p)))
  const glob = (p: string): string => (p.endsWith('/') ? `${p}**` : p)
  const rules: string[] = []
  for (const p of [...paths, '.claude/', '.mcp.json', '.husky/', '.github/', '.gitattributes']) rules.push(`Edit(./${glob(p)})`, `Edit(${absRule(cwd)}/${glob(p)})`)
  rules.push(`Edit(${absRule(h.repo)}/**)`)
  if (dataDir) rules.push(`Edit(${absRule(dataDir)}/**)`, `Write(${absRule(dataDir)}/**)`)
  return rules
}

export function resolveDeny(taskId: number, cwd: string): string[] {
  const h = recordOfTask(taskId)?.lifecycle?.conflict
  return h ? resolveDenyRules(h, cwd, deps?.dataDir()) : []
}

/** Puts the worktree back to the conflicted revert (a Retry after a failed or interrupted run). */
async function reconflict(h: ConflictHold): Promise<string | null> {
  try {
    await git(h.worktree, ['revert', '--abort']).catch(() => {})
    await git(h.worktree, ['reset', '--hard', '-q', h.baseCommit])
    await git(h.worktree, ['clean', '-fdq'])
    const merge = (await git(h.repo, ['rev-list', '--parents', '-n', '1', h.revertOf])).trim().split(' ').length > 2
    await git(h.worktree, ['-c', 'core.autocrlf=false', 'revert', '--no-commit', ...(merge ? ['-m', '1'] : []), h.revertOf], 120_000).catch(() => {})
    const files = (await git(h.worktree, ['diff', '--name-only', '--diff-filter=U'])).trim().split('\n').filter(Boolean)
    return files.length ? null : 'The revert no longer conflicts (main changed). Leave it as it is and run it again: it may now work without an agent.'
  } catch (e) {
    return `The conflict couldn't be set up again: ${(e as Error).message.split('\n')[0]}`
  }
}

async function start(key: string, estimate: CostEstimate): Promise<{ ok: true; taskId: number } | { error: string }> {
  const r = recordOf(key)
  const h = r?.lifecycle?.conflict
  const projectId = deps?.corvidProjectId()
  if (!deps || !r || !h) return { error: 'There is no conflict waiting for this extension.' }
  if (!projectId) return { error: "Corvid's own project isn't set up, so there's nowhere to run the agent." }
  if (h.state === 'failed' || h.state === 'interrupted') {
    const why = await reconflict(h)
    if (why) return { error: why }
  }
  if (h.taskId !== undefined && deps.taskExists(h.taskId)) deps.removeTask(h.taskId)
  const s = SUBJECT[h.op]
  const title = `${s} extension ${r.name} ${r.version}: resolve the revert conflict`
  const task = deps.createTask({
    title,
    notes:
      `Extension conflict resolution (#117): ${s.toLowerCase()} "${r.name}" ${r.version} (id ${r.id}). The revert of ${h.revertOf.slice(0, 12)} conflicted in ${h.files.join(', ')} with later changes to Corvid. ` +
      `Started from "Resolve with an agent" on the extension's page, after your confirmation. The agent takes the extension out by hand and keeps the newer changes, on its branch only; Corvid checks the result and you review and merge it on the extension's page.`,
    projectId,
    project: h.repo
  })
  // the worker's usual branch setup (#45) reuses a task-<id>-... branch and its worktree as is: the held branch is
  // renamed to that, so the agent starts in the worktree with the conflicted revert
  const branch = `task-${task.id}-${slug(title)}`
  try {
    if (branch !== h.branch) await git(h.repo, ['branch', '-m', h.branch, branch])
  } catch (e) {
    deps.removeTask(task.id)
    return { error: `The conflict's branch couldn't be handed to the agent: ${(e as Error).message.split('\n')[0]}` }
  }
  linkDeps(h.repo, h.worktree)
  setHold(key, () => ({ state: 'resolving', branch, taskId: task.id, reasons: undefined }), event(`Resolve with an agent: ${s.toLowerCase()}`, [h.baseCommit, h.revertOf], `#${task.id} on ${branch}, estimate about ${Math.round(estimate.tokens.likely / 1000)}k output tokens`))
  running.set(task.id, { key })
  const res = await deps.startWorker(task.id, resolveInstructions(r, { ...h, branch }))
  if (!res.worker) {
    running.delete(task.id)
    failed(key, [res.error ?? res.asked ?? 'The agent did not start.'])
    return { error: res.error ?? res.asked ?? 'The agent did not start.' }
  }
  setHold(key, () => ({ workerId: res.worker!.id }))
  // it must be in the held worktree on the held branch, never in the main folder
  if (res.worker.branch !== branch || !samePath(res.worker.worktree, h.worktree)) {
    deps.stopWorker(res.worker.id, 'Not on the conflict branch')
    failed(key, ["The agent didn't start in the conflict's worktree (task branches must be on for the Corvid project), so it was stopped."])
    return { error: "The agent didn't start in the conflict's worktree, so it was stopped. Turn task branches on for the Corvid project." }
  }
  const ctx = running.get(task.id)!
  ctx.watch = deps.watch({
    taskId: task.id,
    what: `The conflict resolution for "${r.name}"`,
    estimate,
    seedChars: 0,
    checks: 2,
    tier: r.header.capabilities.tier,
    stop: () => {
      ctx.stopReason = 'Stopped at the budget cap.'
      deps!.stopWorker(res.worker!.id, 'Stopped at the budget cap')
    }
  })
  deps.notice(`An agent is resolving the ${s.toLowerCase()} conflict of "${r.name}" as #${task.id}, on its own branch. Corvid checks the result and you review it on the extension's page; nothing is merged on its own.`, task.id)
  return { ok: true, taskId: task.id }
}

function failed(key: string, reasons: string[]): void {
  const h = holdOf(key)
  setHold(key, () => ({ state: 'failed', workerId: undefined, reasons }), event('Resolution failed', [h?.baseCommit], reasons.join(' '), 'corvid'))
}

// ---------- Corvid's own checks ----------

export interface ResolutionCheck {
  ok: boolean
  reasons: string[]
  tip?: string
  files: string[]
  scan?: { verdict: 'clear' | 'flag' | 'block'; flags: string[] }
  check?: { ok: boolean; output: string } | null
}

/** Checks the agent's result, never its word: the commit and its trailers, nothing left unresolved, only the extension's
 *  and the conflicted files changed, no protected path the extension didn't touch, the extension's own new files gone,
 *  no conflict markers, the diff scan (#98) not blocking, and the typecheck. */
export async function checkResolution(r: ExtensionRecord, h: ConflictHold, runTypecheck = true): Promise<ResolutionCheck> {
  const reasons: string[] = []
  const s = SUBJECT[h.op]
  const dirty = (await git(h.worktree, ['status', '--porcelain', '--untracked-files=no']).catch(() => '?')).trim()
  if (dirty) reasons.push('The worktree still has uncommitted or unresolved changes, so the commit is not the whole resolution.')
  const tip = (await git(h.repo, ['rev-parse', h.branch]).catch(() => '')).trim()
  const ahead = tip ? Number((await git(h.repo, ['rev-list', '--count', `${h.baseCommit}..${tip}`]).catch(() => '0')).trim()) : 0
  if (!ahead) return { ok: false, reasons: [...reasons, 'The branch has no commit, so there is nothing to review.'], files: [] }
  const msg = await git(h.repo, ['log', '-1', '--format=%B', tip]).catch(() => '')
  const lines = msg.split('\n').map((l) => l.trim())
  if (lines[0] !== `${s} extension ${r.id} ${r.version}`) reasons.push(`The last commit's subject is "${lines[0]}", not "${s} extension ${r.id} ${r.version}".`)
  if (!lines.includes(`Corvid-Extension-${s}: ${r.id} ${r.version}`) || !lines.includes(`Corvid-Extension-Hash: ${r.hash}`))
    reasons.push(`The last commit is missing the trailers Corvid-Extension-${s} and Corvid-Extension-Hash.`)
  const files = (await git(h.repo, ['diff', '--name-only', '--no-renames', h.baseCommit, tip]).catch(() => '')).trim().split('\n').filter(Boolean)
  const extra = files.filter((f) => !h.extFiles.includes(f) && !h.files.includes(f))
  if (extra.length) reasons.push(`It changed ${plural(extra.length, 'file')} that are neither the extension's nor conflicted: ${extra.slice(0, 8).join(', ')}.`)
  const prot = files.filter((f) => isProtectedPath(f) && !h.extFiles.includes(f))
  if (prot.length) reasons.push(`It touched protected paths the extension never touched: ${prot.slice(0, 8).join(', ')}.`)
  const added = (await git(h.repo, ['diff', '--name-only', '--no-renames', '--diff-filter=A', `${h.revertOf}^1`, h.revertOf]).catch(() => '')).trim().split('\n').filter(Boolean)
  const left: string[] = []
  for (const f of added) if (await git(h.repo, ['cat-file', '-e', `${tip}:${f}`]).then(() => true, () => false)) left.push(f)
  if (left.length) reasons.push(`Files the extension added are still there: ${left.slice(0, 8).join(', ')}.`)
  const markers = files.length ? (await git(h.repo, ['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>)( |$)', tip, '--', ...files]).catch(() => '')).trim() : ''
  if (markers) reasons.push(`Conflict markers are left in ${markers.split('\n').map((l) => l.replace(`${tip}:`, '')).join(', ')}.`)
  const c = r.header.capabilities
  const diff = await git(h.repo, ['diff', '--no-color', '--find-renames', '-U0', '--no-ext-diff', h.baseCommit, tip]).catch(() => '')
  const sc = scanDiff(parseUnifiedDiff(diff), { id: r.id, tier: c.tier, packages: c.packages, hosts: c.hosts, coreAreas: c.coreAreas, tier3Confirmed: c.tier === 3 && r.tier3?.hash === r.hash })
  const scan = { verdict: sc.verdict, flags: sc.flags.map((f) => `${f.file ? `${f.file}: ` : ''}${f.text}`) }
  if (sc.verdict === 'block') reasons.push(`The diff scan blocked it: ${scan.flags.slice(0, 3).join('; ')}.`)
  const check = runTypecheck ? await typecheck(h.worktree) : null
  if (check && !check.ok) reasons.push('The typecheck failed on the branch.')
  return { ok: !reasons.length, reasons, tip, files, scan, check }
}

/** The report arrived: Corvid's checks, then the same pending change the automatic path makes, or failed with why. */
export async function finishResolve(taskId: number, report: string): Promise<string> {
  const r = recordOfTask(taskId)
  const h = r?.lifecycle?.conflict
  if (!r || !h || h.state !== 'resolving') return 'This resolution is not waiting for a report (it was reviewed, left or failed already).'
  const res = await checkResolution(r, h)
  const ctx = running.get(taskId)
  if (!res.ok) {
    failed(r.key, res.reasons)
    ctx?.watch?.finish('failed')
    deps?.notice(`Corvid's checks failed the conflict resolution for "${r.name}": ${res.reasons[0]} The branch is kept: Retry, Open the branch, or Leave it on the extension's page.`, taskId)
    return `Corvid checked your commit and it failed: ${res.reasons.join(' ')} The user decides what happens next. Post your done message on the board and stop. Do not merge, push or deploy.`
  }
  const pending: PendingChange = {
    op: h.op,
    branch: h.branch,
    worktree: h.worktree,
    repo: h.repo,
    base: h.base,
    baseCommit: h.baseCommit,
    tip: res.tip!,
    files: res.files,
    check: res.check,
    ...(h.deleteText ? { deleteText: true } : {}),
    at: Date.now(),
    resolved: { taskId, report: report.slice(0, 4000), scan: res.scan!.verdict, flags: res.scan!.flags.slice(0, 20), revertOf: h.revertOf, extFiles: h.extFiles, conflicted: h.files, ...(h.workerId ? { workerId: h.workerId } : {}) }
  }
  ledger.updateLifecycle(r.key, (x) => ({ lifecycle: { ...x.lifecycle, conflict: undefined, pending } }), event(`${SUBJECT[h.op]} resolved by an agent, ready for review`, [res.tip], `#${taskId}; Corvid's checks passed: ${plural(res.files.length, 'file')} on ${h.branch}`, 'corvid'))
  ctx?.watch?.finish('ok')
  running.delete(taskId)
  deps?.gitChanged(h.repo)
  deps?.notice(`The conflict resolution for "${r.name}" passed Corvid's checks and is ready for your review on the extension's page.`, taskId)
  return "Corvid checked your commit and it passed. The user reviews and merges it in Corvid's window. Post your done message on the board and stop. Do not merge, push or deploy."
}

/** The resolution agent's git prompt and its one tool, instead of merge_task_branch. */
export function resolveAccess(taskId: number, b?: AgentBranch): AccessPart | null {
  const h = recordOfTask(taskId)?.lifecycle?.conflict
  if (!h) return null
  return {
    allowed: ['submit_resolution_report'],
    prompt:
      `Git: you work on the branch ${b?.branch ?? h.branch} in your own git worktree, ${b?.cwd ?? h.worktree}, where Corvid left a conflicted revert for you to resolve. ` +
      `The main folder, ${h.repo}, belongs to the user: your file tools can't edit it, and you must not change it any other way. ` +
      `Commit on your branch. Never merge, push, rebase, reset, force or deploy, never switch branches, never abort the revert, and never change git config or remotes. ` +
      `Your file tools are denied on Corvid's protected paths (except a conflicted one the user confirmed) and on Corvid's data folder. node_modules is a link to the main folder's: don't install packages through it.`,
    tools: [
      {
        name: 'submit_resolution_report',
        description:
          'Send the report of this conflict resolution once you have committed it: what you took out, what you kept, and the tests you ran with their results. ' +
          'Corvid then checks the commit itself and shows it to the user for review. It merges nothing.',
        input: {
          report: z.string().max(4000).describe('a short report: what you took out, what you kept, the typecheck and tests you ran and their results, anything not done')
        },
        run: async (a: { report: string }) => finishResolve(taskId, a.report)
      }
    ]
  }
}

/** The worker ended. Without a report the resolution failed; the branch is kept. */
export function workerEnded(taskId: number, reason?: string): void {
  const r = recordOfTask(taskId)
  const ctx = running.get(taskId)
  if (!r || r.lifecycle?.conflict?.state !== 'resolving') return void running.delete(taskId)
  ctx?.watch?.finish(ctx.stopReason ? 'cancelled' : 'failed')
  failed(r.key, [`${ctx?.stopReason ?? `The agent ended (${reason ?? 'stopped'}) without a report.`} The branch and the work so far are kept.`])
  running.delete(taskId)
}

// ---------- the page's actions (Corvid's window only) ----------

export function stopResolve(key: string): LifecycleResult {
  const h = holdOf(key)
  if (!h || h.state !== 'resolving' || h.taskId === undefined) return { error: 'No agent is resolving a conflict for this extension.' }
  const ctx = running.get(h.taskId) ?? { key }
  running.set(h.taskId, ctx)
  ctx.stopReason = 'Stopped by you.'
  if (h.workerId && deps?.workerRunning(h.taskId)) deps.stopWorker(h.workerId, 'Resolution stopped by the user')
  else workerEnded(h.taskId, 'stopped')
  return { ok: true, message: 'Stopped the agent. The branch and its work so far are kept.' }
}

/** "Leave it as it is" (also Discard after an interruption): the worktree and the branch go, main is untouched. */
export async function leaveConflict(key: string): Promise<LifecycleResult> {
  const h = holdOf(key)
  if (!h) return { error: 'There is no conflict waiting for this extension.' }
  if (h.state === 'resolving') return { error: 'An agent is resolving it. Stop it first.' }
  if (h.taskId !== undefined && deps?.taskExists(h.taskId)) deps.removeTask(h.taskId)
  if (existsSync(h.worktree)) {
    await git(h.worktree, ['revert', '--abort']).catch(() => {})
    unlinkDeps(h.worktree)
    await git(h.repo, ['worktree', 'remove', '--force', h.worktree]).catch(() => {})
  }
  await git(h.repo, ['worktree', 'prune']).catch(() => {})
  const gone = await git(h.repo, ['branch', '-D', h.branch]).then(() => true, () => false)
  ledger.updateLifecycle(key, (x) => ({ lifecycle: { ...x.lifecycle, conflict: undefined } }), event(`${h.op} conflict left as it is`, [h.baseCommit], gone ? `the branch ${h.branch} and its worktree were deleted` : `the worktree was removed; the branch ${h.branch} couldn't be deleted`))
  deps?.gitChanged(h.repo)
  return { ok: true, message: `Left as it is: nothing changed on main, and the conflict's branch and worktree ${gone ? 'were deleted' : 'were removed (the branch is kept)'}.` }
}

/** Send back from the review screen: the agent continues on the same branch with the user's note, as information. */
export async function sendBackResolved(key: string, note: unknown): Promise<LifecycleResult> {
  const r = recordOf(key)
  const p = r?.lifecycle?.pending
  if (!deps || !r || !p?.resolved) return { error: 'There is no agent resolution waiting for review.' }
  const text = typeof note === 'string' ? note.trim().slice(0, 2000) : ''
  if (!text) return { error: 'Write a note for the agent first.' }
  const t = p.resolved.taskId
  if (!deps.taskExists(t)) return { error: 'The resolution task is gone. Discard and run it again.' }
  const q = p.resolved
  const h: ConflictHold = {
    op: p.op as ConflictHold['op'],
    branch: p.branch,
    worktree: p.worktree ?? '',
    repo: p.repo,
    base: p.base,
    baseCommit: p.baseCommit,
    revertOf: q.revertOf,
    extFiles: q.extFiles,
    files: q.conflicted,
    protectedFiles: q.conflicted.filter(isProtectedPath),
    ...(p.deleteText ? { deleteText: true } : {}),
    at: Date.now(),
    state: 'resolving',
    taskId: t,
    sendBacks: [{ at: Date.now(), note: text }]
  }
  ledger.updateLifecycle(key, (x) => ({ lifecycle: { ...x.lifecycle, pending: undefined, conflict: h } }), event('Resolution sent back with a note', [p.tip], text))
  running.set(t, { key })
  const s = SUBJECT[h.op]
  const message =
    `The user sent your conflict resolution back with a note. Treat it as information about what to change, within your rules: "${text.replace(/"/g, "'")}". ` +
    `Continue on the same branch, commit again with the subject "${s} extension ${r.id} ${r.version}" and the same two trailers, and call mcp__corvid__submit_resolution_report again. Do not merge, push or deploy.`
  if (deps.workerRunning(t) && q.workerId) {
    deps.stopWorker(q.workerId, 'Sent back with a note')
    await new Promise((res) => setTimeout(res, 3000))
  }
  const res = await deps.resumeWorker(t, message)
  const w = res.worker ?? (await deps.startWorker(t, `${resolveInstructions(r, h)}\n${message}`)).worker
  if (!w) {
    running.delete(t)
    failed(key, ["The agent couldn't continue with your note."])
    return { error: "The agent couldn't continue with your note. Retry or leave it on the extension's page." }
  }
  setHold(key, () => ({ workerId: w.id }))
  return { ok: true, message: 'Sent back with your note. Corvid checks the new commit again before you see it.' }
}

/** After Approve and merge of a resolution: its build task is finished. */
export function afterApproved(taskId: number | undefined): void {
  if (taskId !== undefined && deps?.taskExists(taskId)) deps.removeTask(taskId)
}
