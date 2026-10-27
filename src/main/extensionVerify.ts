import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { CostEstimate } from '@shared/costEstimate'
import type { DiffScanResult } from '@shared/extensionDiffScan'
import type { BuildReport, ExtensionRecord, InstallPrompt } from '@shared/extensions'
import { reviewGate } from '@shared/extensionScan'
import { effortFromTokens, isVerified, sharedText, shareLeaks, verifyOutcome, type SharePreview, type VerificationRecord, type VerifyBase, type VerifyCheck, type VerifyPrompt } from '@shared/extensionVerify'
import type { LeakContext } from '@shared/packager'
import type { AccessPart } from './agentAccess'
import { slug, type AgentBranch } from './agentGit'
import { buildDenyRules, buildInstructions, diffScanOf, protectedAreasOf } from './extensionInstall'
import * as ledger from './extensions'

// Verify and Share (#101, docs/EXTENSIONS.md "Verifying and sharing").
//
// Verify test-builds an extension from its TEXT on a clean throwaway copy of Corvid: a task branch made at the
// extension's built_on commit (or, if the user picks it, the current main), never containing the author's own
// feature, with #98's build instructions, deny rules, submit_build_report and diff scan. It is never merged: there is
// no merge here at all, and the worktree and branch are removed when it ends (the report and the scan are kept).
// A pass records the verification, bound to the text's hash. Share writes the text, with the verification block
// filled in, to a file the user picks, or copies it; nothing is uploaded.
//
// Starting a verify (the estimate's Confirm), Share and Copy come only from Corvid's window. The verify agent's one
// tool, submit_build_report, only stores its report and runs the checks.

export interface VerifyDeps {
  corvid: () => { projectId: string; folder: string } | undefined
  estimateFor: (key: string) => CostEstimate | null
  usageWarning: () => InstallPrompt['usage']
  capMultiple: () => number
  createTask: (t: { title: string; notes: string; projectId: string; project: string }) => { id: number }
  removeTask: (id: number) => void
  startWorker: (taskId: number, instructions: string) => Promise<{ worker?: { id: string; branch?: string; worktree?: string }; error?: string; asked?: string }>
  stopWorker: (workerId: string, reason: string) => void
  workerRunning: (taskId: number) => boolean
  watch: (o: { key: string; taskId: number; what: string; estimate: CostEstimate; stop: () => void; seedChars: number; checks: number; tier: 1 | 2 | 3 }) => {
    finish: (outcome: 'ok' | 'failed' | 'cancelled') => { actual: { tokens: number; minutes: number }; model: string }
  }
  notice: (text: string, taskId?: number) => void
  leaks: () => LeakContext
  /** the save dialog; undefined when the user cancelled */
  savePath: (defaultName: string) => Promise<string | undefined>
  copy: (text: string) => void
}

let deps: VerifyDeps | undefined
export function initVerify(d: VerifyDeps): void {
  deps = d
  // a verify that was running when Corvid stopped can't be followed: it fails, and its throwaway copy is removed
  for (const r of ledger.list())
    if (r.verify?.state === 'building') {
      endRun(r.key, { reasons: ['Corvid restarted during the verify build.'] })
      void cleanUp(r.key)
    }
}

const running = new Map<number, { key: string; watch?: ReturnType<VerifyDeps['watch']>; stopReason?: string; reported?: boolean }>()

function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()))
      else resolve(stdout)
    })
  })
}
const ok = (cwd: string, args: string[]): Promise<boolean> => git(cwd, args).then(() => true, () => false)

const recordOf = (key: string): ExtensionRecord | undefined => ledger.list().find((r) => r.key === key)
const recordOfTask = (taskId: number): ExtensionRecord | undefined => ledger.list().find((r) => r.verify?.taskId === taskId && r.verify.state === 'building')
/** Whether a task is a verify build (its worker gets the build's tools, prompt and deny rules, and no merge tool). */
export const isVerifyTask = (taskId: number): boolean => !!recordOfTask(taskId)

// ---------- the clean base ----------

/** Why a commit contains the extension's own feature, or null when it doesn't: one of the merge commits the user's
 *  feature was packaged from (#100), or a merge of an install of this extension (#98's trailer). */
export async function featureIn(repo: string, commit: string, r: ExtensionRecord): Promise<string | null> {
  for (const f of r.source.features ?? [])
    if (await ok(repo, ['merge-base', '--is-ancestor', f, commit])) return `it contains your own feature (commit ${f.slice(0, 7)})`
  const merged = (await git(repo, ['log', '-1', '--format=%h', '--fixed-strings', `--grep=Corvid-Extension: ${r.id} `, commit]).catch(() => '')).trim()
  if (merged) return `it contains an install of "${r.id}" (merge ${merged})`
  return null
}

const versionAt = async (repo: string, commit: string): Promise<string> => {
  try {
    return String(JSON.parse(await git(repo, ['show', `${commit}:package.json`])).version ?? '?')
  } catch {
    return '?'
  }
}

/** The clean commit to verify on. built_on: the extension's own commit, or, when that already holds the user's
 *  feature, the commit just before the feature was merged. main: the current main, refused when it holds the feature. */
export async function resolveBase(r: ExtensionRecord, repo: string, kind: 'built-on' | 'main'): Promise<VerifyBase | { error: string }> {
  if (kind === 'main') {
    const commit = (await git(repo, ['rev-parse', '--verify', 'main^{commit}']).catch(() => '')).trim()
    if (!commit) return { error: "Corvid's repository has no main branch." }
    const has = await featureIn(repo, commit, r)
    if (has) return { error: `Your main can't be the clean copy: ${has}. Verify on the extension's built_on commit instead.` }
    return { kind, commit, version: await versionAt(repo, commit), label: `the current main (${commit.slice(0, 7)})` }
  }
  const want = r.header.builtOn.commit
  const commit = (await git(repo, ['rev-parse', '--verify', `${want}^{commit}`]).catch(() => '')).trim()
  if (!commit) return { error: `The extension's built_on commit ${want} isn't in your Corvid repository (it may come from someone else's copy). Verify on the current main instead.` }
  const has = await featureIn(repo, commit, r)
  if (!has) return { kind, commit, version: await versionAt(repo, commit), label: `its built_on commit, Corvid ${r.header.builtOn.version} (${commit.slice(0, 7)})` }
  // the author's own Corvid: built_on has the feature, so start just before it was merged
  for (const f of r.source.features ?? []) {
    const parent = (await git(repo, ['rev-parse', '--verify', `${f}^1`]).catch(() => '')).trim()
    if (parent && (await ok(repo, ['merge-base', '--is-ancestor', parent, commit])) && !(await featureIn(repo, parent, r)))
      return { kind: 'before-feature', commit: parent, version: await versionAt(repo, parent), label: `the commit just before your feature was merged (${parent.slice(0, 7)}), since built_on already has it` }
  }
  return { error: `The built_on commit can't be the clean copy: ${has}. Verify on the current main instead, if it doesn't have the feature.` }
}

// ---------- before a verify ----------

/** What stands in the way of a verify, and the two bases the user can pick from. */
export async function verifyCheck(key: string): Promise<VerifyCheck | { error: string }> {
  const r = recordOf(key)
  if (!r) return { error: 'That extension is no longer in the list.' }
  const blockers: string[] = []
  const c = deps?.corvid()
  const none = { error: "Corvid's own project has no source checkout." }
  if (!c) blockers.push("Corvid's own project has no source checkout yet. Set it up on the Corvid project page first.")
  const other = ledger.list().find((x) => x.status === 'building' || x.verify?.state === 'building')
  if (other) blockers.push(`"${other.name}" is ${other.verify?.state === 'building' ? 'being verified' : 'building'}. Corvid runs one extension build at a time.`)
  if (['building', 'needs-review'].includes(r.status)) blockers.push(`"${r.name}" has an install build ${r.status === 'building' ? 'running' : 'waiting for review'}; finish that first.`)
  const gate = reviewGate(r.scan, r.hash)
  if (!gate.ok) blockers.push(gate.need === 'blocked' ? 'The scan blocked this extension, so no agent builds it, not even to verify.' : 'Scan it first (and confirm any warnings): a verify build runs an agent on this text like an install does.')
  if (r.header.capabilities.tier === 3 && !(r.tier3?.hash === r.hash && protectedAreasOf(r).every((a) => r.tier3!.areas.includes(a.id))))
    blockers.push('This extension changes protected parts of Corvid. Tick the extra confirmation under "Before installing" first; a verify build gets the same rules.')
  const bases = c
    ? { 'built-on': await resolveBase(r, c.folder, 'built-on'), main: await resolveBase(r, c.folder, 'main') }
    : { 'built-on': none, main: none }
  if (c && 'error' in bases['built-on'] && 'error' in bases.main) blockers.push('There is no clean copy to verify on (see below).')
  return { ok: !blockers.length, blockers, verified: isVerified(r), bases }
}

/** One confirmation per dialog, 15 minutes, used once; in memory only. */
const tokens = new Map<string, { key: string; estimate: CostEstimate; base: VerifyBase; until: number }>()

/** The confirmation's content (#97's estimate, the cap and the usage warning) for a verify on the chosen base. */
export async function prepareVerify(key: string, kind: unknown): Promise<VerifyPrompt | { error: string }> {
  if (!deps) return { error: 'Verify is not ready yet.' }
  const check = await verifyCheck(key)
  if ('error' in check) return check
  if (!check.ok) return { error: check.blockers.join(' ') }
  const base = check.bases[kind === 'main' ? 'main' : 'built-on']
  if ('error' in base) return base
  const estimate = deps.estimateFor(key)
  if (!estimate) return { error: 'That extension is no longer in the list.' }
  const now = Date.now()
  for (const [t, v] of tokens) if (v.until < now) tokens.delete(t)
  const token = randomUUID()
  tokens.set(token, { key, estimate, base, until: now + 15 * 60_000 })
  const multiple = deps.capMultiple()
  return { token, estimate, capMultiple: multiple, capTokens: Math.round(estimate.tokens.likely * multiple), usage: deps.usageWarning(), base }
}

/** The user pressed Confirm: start the verify build. */
export async function confirmVerify(key: unknown, token: unknown): Promise<{ ok: true; taskId: number } | { error: string }> {
  const t = typeof token === 'string' ? tokens.get(token) : undefined
  if (!t || t.key !== key || t.until < Date.now()) return { error: 'This confirmation has expired. Press Verify again to see a fresh estimate.' }
  tokens.delete(token as string)
  if (deps?.usageWarning()?.block) return { error: "You're over your usage limit and Settings blocks new agents, so nothing was started." }
  return startVerify(t.key, t.estimate, t.base)
}

/** The verify agent's task text: #98's build instructions, plus what a verify is. */
export function verifyInstructions(r: ExtensionRecord, seed: string, checks: string[], base: VerifyBase, branch: string): string {
  return [
    `VERIFY BUILD. This is a test build on a CLEAN, THROWAWAY copy of Corvid at ${base.commit.slice(0, 12)} (Corvid ${base.version}), to prove that the extension's text alone rebuilds the feature. It is never merged, and its worktree and branch are deleted afterwards; only your report and Corvid's diff scan are kept.`,
    `Build ONLY from the text below. Don't look for, copy or restore the feature from other branches, commits, stashes or folders (git log, git show, git checkout of other refs, or the user's main checkout): a build that does that proves nothing.`,
    buildInstructions(r, seed, checks, branch)
  ].join('\n')
}

async function startVerify(key: string, estimate: CostEstimate, base: VerifyBase): Promise<{ ok: true; taskId: number } | { error: string }> {
  if (!deps) return { error: 'Verify is not ready yet.' }
  const check = await verifyCheck(key)
  if ('error' in check) return check
  if (!check.ok) return { error: check.blockers.join(' ') }
  const r = recordOf(key)!
  const d = ledger.detail(key)
  if (!d?.sections) return { error: "The extension's stored text is missing, so there is nothing to build from." }
  const c = deps.corvid()!
  // checked again right before the branch is made: the clean copy never has the feature
  const has = await featureIn(c.folder, base.commit, r)
  if (has) return { error: `That base isn't clean: ${has}.` }
  const title = `Verify extension ${r.id} ${r.version}`
  const task = deps.createTask({
    title,
    notes: `Extension verify (#101): "${r.name}" ${r.version}, id ${r.id}, sha256 ${r.hash}, on a clean throwaway copy at ${base.commit.slice(0, 12)}. Never merged; the branch and worktree are removed when it ends.`,
    projectId: c.projectId,
    project: c.folder
  })
  // the task's branch made here, at the clean commit: the worker's usual branch setup (#45) then reuses it as is
  const branch = `task-${task.id}-${slug(title)}`
  try {
    await git(c.folder, ['branch', branch, base.commit])
  } catch (e) {
    deps.removeTask(task.id)
    return { error: `The throwaway branch couldn't be made: ${(e as Error).message.split('\n')[0]}` }
  }
  ledger.updateVerify(key, () => ({
    verify: { state: 'building', taskId: task.id, repo: c.folder, branch, baseCommit: base.commit, baseVersion: base.version, baseKind: base.kind, startedAt: Date.now(), hash: r.hash }
  }))
  running.set(task.id, { key })
  const res = await deps.startWorker(task.id, verifyInstructions(r, d.sections.seedPrompt, d.sections.checks, base, branch))
  if (!res.worker) {
    endRun(key, { reasons: [res.error ?? res.asked ?? 'The verify agent did not start.'] })
    await cleanUp(key)
    return { error: res.error ?? res.asked ?? 'The verify agent did not start.' }
  }
  ledger.updateVerify(key, (x) => ({ verify: { ...x.verify!, workerId: res.worker!.id, worktree: res.worker!.worktree } }))
  // it must be on the throwaway branch at the clean commit, never in the main folder
  const head = res.worker.worktree ? (await git(res.worker.worktree, ['rev-parse', 'HEAD']).catch(() => '')).trim() : ''
  if (res.worker.branch !== branch || head !== base.commit) {
    deps.stopWorker(res.worker.id, 'Not on the clean verify branch')
    endRun(key, { reasons: ["The verify agent didn't start on the clean throwaway branch (task branches must be on for the Corvid project), so it was stopped."] })
    return { error: "The verify agent didn't start on the clean throwaway branch, so it was stopped. Turn task branches on for the Corvid project." }
  }
  const ctx = running.get(task.id)!
  ctx.watch = deps.watch({
    key,
    taskId: task.id,
    what: `The verify build of "${r.name}"`,
    estimate,
    seedChars: d.sections.seedPrompt.length,
    checks: d.sections.checks.length,
    tier: r.header.capabilities.tier,
    stop: () => {
      ctx.stopReason = 'Stopped at the budget cap.'
      deps!.stopWorker(res.worker!.id, 'Stopped at the budget cap')
    }
  })
  deps.notice(`Verifying "${r.name}" ${r.version} as #${task.id}, on a clean throwaway copy of Corvid at ${base.commit.slice(0, 7)}. It is never merged; the copy is removed when it ends.`, task.id)
  return { ok: true, taskId: task.id }
}

function endRun(key: string, o: { reasons?: string[]; state?: 'failed' | 'cancelled' }): void {
  ledger.updateVerify(key, (x) => ({ verify: { ...(x.verify ?? { startedAt: Date.now(), hash: x.hash }), state: o.state ?? 'failed', reasons: o.reasons, endedAt: Date.now() } }))
}

// ---------- the verify agent's side ----------

/** The verify agent's git prompt and its one tool: it commits, reports and stops. No merge tool. */
export function verifyAccess(taskId: number, b?: AgentBranch): AccessPart | null {
  const r = recordOfTask(taskId)
  if (!r) return null
  return {
    allowed: ['submit_build_report'],
    prompt:
      `Git: you work on the throwaway branch ${b?.branch ?? 'your task branch'}${b?.cwd ? ` in your own git worktree, ${b.cwd}` : ''}, made at a clean commit of Corvid for this verify build. ` +
      `${b?.repo ? `The main folder, ${b.repo}, belongs to the user: your file tools can't edit it, and you must not read from it or change it any other way. ` : ''}` +
      `Commit on your branch. Never merge, push, rebase, reset, force or deploy, never switch branches or check out other refs, and never change git config or remotes. ` +
      `Your file tools are denied on Corvid's protected paths for this build; if the extension needs one, stop and report. node_modules is a link to the main folder's: don't install packages through it.`,
    tools: [
      {
        name: 'submit_build_report',
        description: 'Send the report of this verify build once you have committed: what changed, the files, the tests and acceptance checks you ran with their results, and anything not done. Corvid then scans the diff. Nothing is merged.',
        input: {
          summary: z.string().max(4000).describe('what changed, in plain words'),
          files: z.array(z.string().max(300)).max(400).describe('the files you added or changed'),
          tests: z.array(z.object({ name: z.string().max(200), result: z.enum(['pass', 'fail', 'not-run']), detail: z.string().max(1000).optional() })).max(60).describe('the typecheck, existing tests and acceptance tests you ran'),
          acceptance: z.array(z.object({ check: z.number().int().min(1).max(40), result: z.enum(['pass', 'fail', 'not-run']), how: z.string().max(600).optional() })).max(40).describe('one entry per acceptance check, by its number'),
          not_done: z.string().max(3000).optional().describe('anything not built, and why'),
          flag: z.string().max(80).optional().describe('the per-extension flag the feature is gated behind, if any')
        },
        run: async (a: { summary: string; files: string[]; tests: BuildReport['tests']; acceptance: BuildReport['acceptance']; not_done?: string; flag?: string }) =>
          finishVerify(taskId, { at: Date.now(), summary: a.summary, files: a.files, tests: a.tests, acceptance: a.acceptance, notDone: a.not_done, flag: a.flag })
      }
    ]
  }
}

export function verifyDeny(taskId: number, cwd: string, repo?: string): string[] {
  const r = recordOfTask(taskId)
  return r ? buildDenyRules(r, cwd, repo) : []
}

/** The report arrived: scan the diff against the clean base, decide pass or fail, record it. */
export async function finishVerify(taskId: number, report: BuildReport): Promise<string> {
  const r = recordOfTask(taskId)
  const ctx = running.get(taskId)
  if (!r || !r.verify || !ctx || ctx.reported) return 'This verify build is not waiting for a report.'
  ctx.reported = true
  const v = r.verify
  const checks = ledger.detail(r.key)?.sections?.checks.length ?? 0
  const ahead = Number((await git(v.repo!, ['rev-list', '--count', `${v.baseCommit}..${v.branch}`]).catch(() => '0')).trim()) || 0
  let reasons: string[] = []
  let scan: DiffScanResult | undefined
  if (!ahead) reasons = ['The build made no commits.']
  else {
    const d = await diffScanOf(r, v.repo!, v.baseCommit!, v.branch!)
    if ('error' in d) reasons = [d.error]
    else {
      scan = d.scan
      reasons = verifyOutcome(report, d.scan, checks, r.header.capabilities.tier).reasons
    }
  }
  const pass = !reasons.length && !!scan
  const run = ctx.watch?.finish(pass ? 'ok' : 'failed')
  ledger.updateVerify(r.key, (x) => {
    const verify = { ...x.verify!, state: pass ? ('passed' as const) : ('failed' as const), report, diffScan: scan, reasons: pass ? undefined : reasons, endedAt: Date.now() }
    if (!pass || !scan) return { verify }
    const tokens = run?.actual.tokens ?? 0
    const verification: VerificationRecord = {
      hash: v.hash,
      baseCommit: v.baseCommit!,
      baseVersion: v.baseVersion ?? '?',
      baseKind: v.baseKind ?? 'built-on',
      at: Date.now(),
      model: run?.model ?? 'unknown',
      minutes: run?.actual.minutes ?? Math.round((Date.now() - v.startedAt) / 60_000),
      tokens,
      files: scan.files.length,
      checks,
      effort: effortFromTokens(tokens),
      report,
      diffScan: scan
    }
    // bound to the hash: a record whose text changed since the build started stays unverified
    return v.hash === x.hash ? { verify, verification } : { verify }
  })
  deps?.notice(
    pass
      ? `"${r.name}" ${r.version} is verified: its text rebuilt the feature on a clean Corvid at ${v.baseCommit!.slice(0, 7)}. The throwaway copy is being removed. Share is on the extension's page.`
      : // the first reason in its own words, so the board says why without opening the page (#114)
        `The verify build of "${r.name}" failed: ${(reasons[0] ?? 'no reason was recorded').replace(/\.?$/, '.')}${reasons.length > 1 ? ` ${reasons.length - 1} more reason${reasons.length === 2 ? ' is' : 's are'} on the extension's page.` : " Details are on the extension's page."} The throwaway copy is being removed; the report is kept.`,
    taskId
  )
  // the agent posts its done message, then it is stopped and the throwaway copy removed (verifyEnded)
  setTimeout(() => {
    const wid = recordOf(r.key)?.verify?.workerId
    if (wid && deps?.workerRunning(taskId)) deps.stopWorker(wid, 'Verify finished')
  }, 90_000).unref?.()
  return `Report received: the verify ${pass ? 'passed' : 'failed'}. Post your done message on the board and stop. Nothing is merged; this branch and worktree are removed in a minute.`
}

/** The verify's worker ended: without a report it failed. Then the throwaway worktree and branch are removed. */
export function verifyEnded(taskId: number, reason?: string): void {
  const r = recordOfTask(taskId) ?? ledger.list().find((x) => x.verify?.taskId === taskId)
  const ctx = running.get(taskId)
  if (!r || !ctx) return
  if (!ctx.reported && r.verify?.state === 'building') {
    ctx.watch?.finish(ctx.stopReason ? 'cancelled' : 'failed')
    endRun(r.key, { reasons: [ctx.stopReason ?? `The verify agent ended (${reason ?? 'stopped'}) without a build report.`], state: ctx.stopReason ? 'cancelled' : 'failed' })
  }
  running.delete(taskId)
  // after the worker's own end handling, and once Windows lets go of the folder
  setTimeout(() => void cleanUp(r.key), 5_000).unref?.()
}

/** Removes the throwaway worktree, its node_modules link (never what it points at), the branch and the task. The
 *  record keeps the report and the diff scan. */
export async function cleanUp(key: string): Promise<void> {
  const r = recordOf(key)
  const v = r?.verify
  if (!r || !v || v.state === 'building' || v.cleaned || !v.repo || !v.branch) return
  const notes: string[] = []
  const tree = v.worktree ?? join(`${v.repo}-worktrees`, v.branch)
  const link = join(tree, 'node_modules')
  const isLink = (): boolean => {
    try {
      return lstatSync(link).isSymbolicLink()
    } catch {
      return false
    }
  }
  if (isLink()) {
    try {
      unlinkSync(link)
    } catch {
      // a non-recursive rmdir removes a junction and never what it points at
      try {
        rmdirSync(link)
      } catch {
        /* checked below */
      }
    }
  }
  if (existsSync(tree)) {
    // never a forced removal while the link to the main folder's node_modules is still there
    if (isLink()) notes.push(`its worktree ${tree} still links to node_modules, so it was left in place`)
    else if (!(await ok(v.repo, ['worktree', 'remove', '--force', tree]))) notes.push(`its worktree ${tree} couldn't be removed`)
  }
  await git(v.repo, ['worktree', 'prune']).catch(() => {})
  // a throwaway branch made only for this verify, never merged: deleted with its commits
  if ((await ok(v.repo, ['rev-parse', '--verify', `refs/heads/${v.branch}`])) && !(await ok(v.repo, ['branch', '-D', v.branch]))) notes.push(`the branch ${v.branch} couldn't be deleted`)
  if (v.taskId !== undefined) deps?.removeTask(v.taskId)
  ledger.updateVerify(key, (x) => ({ verify: { ...x.verify!, cleaned: !notes.length, cleanupNote: notes.length ? `Not cleaned up: ${notes.join('; ')}.` : undefined } }))
}

// ---------- share ----------

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex')

/** What Share would write, and the final leak check. Refused unless this exact text is verified. */
export function sharePreview(key: string): SharePreview | { error: string } {
  const r = recordOf(key)
  if (!r) return { error: 'That extension is no longer in the list.' }
  if (!isVerified(r) || !r.verification) return { error: "Only a verified extension can be shared: verify this exact text first (any edit makes it unverified)." }
  const text = ledger.textOf(key)
  if (!text) return { error: "The extension's stored text is missing." }
  const out = sharedText(text, r.verification)
  return { text: out, fileName: `${r.id}-${r.version}.corvid`, leaks: deps ? shareLeaks(out, deps.leaks(), r.header.capabilities.hosts) : [], verification: r.verification }
}

/** Save the shared file where the user picks, or copy it. With leak findings, only after "I've read these". */
export async function share(key: string, how: unknown, leaksRead: unknown): Promise<{ ok: true; message: string } | { error: string } | { cancelled: true }> {
  const p = sharePreview(key)
  if ('error' in p) return p
  if (p.leaks.length && leaksRead !== true) return { error: 'Read the leak check first: fix the text through Edit, or tick that the file is fine as it is.' }
  const r = recordOf(key)!
  let where: string
  if (how === 'copy') {
    deps!.copy(p.text)
    where = 'the clipboard'
  } else {
    const path = await deps!.savePath(p.fileName)
    if (!path) return { cancelled: true }
    writeFileSync(path, p.text, 'utf8')
    where = path
  }
  ledger.updateVerify(key, (x) => ({ shares: [...(x.shares ?? []), { at: Date.now(), where, fileHash: sha(p.text), hash: r.hash }].slice(-50) }))
  return { ok: true, message: how === 'copy' ? 'Copied the extension as text. Nothing was uploaded.' : `Saved ${p.fileName}. Nothing was uploaded: send the file yourself.` }
}
