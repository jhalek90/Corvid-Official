import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  dependentsOf,
  lifecycleState,
  rebuilding,
  removalOrder,
  updateFor,
  CONFLICT_WHY,
  type ConflictHold,
  type LifecycleEvent,
  type LifecycleInfo,
  type LifecycleResult,
  type PendingChange
} from '@shared/extensionLifecycle'
import type { ExtensionRecord } from '@shared/extensions'
import { isProtectedPath } from '@shared/extensionTiers'
import { cleanUp, defaultBranch, linkDeps, mergeBranch, unlinkDeps, type AgentBranch } from './agentGit'
import * as ledger from './extensions'

export { rebuilding }

// The lifecycle of an installed extension (#99, docs/EXTENSIONS.md "Lifecycle"). Built on #98's ledger records: the
// merge commit, the build's tip, the files touched and the flag from the build report.
//
//   disable   the flag off (instant) when the code reads it, else a revert of the merge on a new branch
//   enable    the flag on, or a revert of that revert: the same stored commits, no agent, no usage
//   remove    a revert like disable, then the record goes back to "Not installed yet" (or "Removed" with its text deleted)
//   reapply   a cherry-pick of the recorded merge onto the current main: the stored build, free
//   rebuild / update   the install pipeline again (#98), built on top of what's installed; the old record is replaced
//                      only when the user merges the new build
//
// Every git change is made with git alone on its own branch and worktree, and merged only from the user's click in
// Corvid's window (mergeBranch: --no-ff, a lock, aborted on conflict, never forced, never pushed). Nothing deploys.

export interface LifecycleDeps {
  corvid: () => { projectId: string; folder: string } | undefined
  agentsIn: (folder: string) => string[]
  disabledIds: () => string[]
  setDisabledIds: (ids: string[]) => void
  /** the app's data folder: what an extension left there is listed, never deleted */
  dataDir: () => string
  gitChanged: (repo: string) => void
}

let deps: LifecycleDeps | undefined
export const initLifecycle = (d: LifecycleDeps): void => {
  deps = d
  void verifyLedger()
}

function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()))
      else resolve(stdout)
    })
  })
}
const ok = (cwd: string, args: string[]): Promise<boolean> => git(cwd, args).then(() => true, () => false)

export const recordOf = (key: string): ExtensionRecord | undefined => ledger.list().find((r) => r.key === key)
export const event = (what: string, commits?: (string | undefined)[], detail?: string, who: 'user' | 'corvid' = 'user'): LifecycleEvent => ({
  at: Date.now(),
  what,
  who,
  ...(commits?.filter(Boolean).length ? { commits: commits.filter(Boolean) as string[] } : {}),
  ...(detail ? { detail } : {})
})

const repoOf = (r: ExtensionRecord): string | undefined => r.build?.repo ?? deps?.corvid()?.folder

// ---------- the ledger check ----------

/** On load: every installed extension's merge commit must still be in main's history. If the user reverted, reset or
 *  deleted things by hand, the record is marked "changed outside Corvid", never dropped. Never throws. */
export async function verifyLedger(): Promise<void> {
  for (const r of ledger.list()) {
    try {
      if ((r.status !== 'installed' && r.status !== 'disabled') || !r.build?.mergeCommit) continue
      const repo = repoOf(r)
      if (!repo || !existsSync(repo)) continue
      const main = (await defaultBranch(repo)) ?? 'main'
      // the latest merge that applied or reverted it supersedes the install's own (a re-apply after a reset, say)
      const commits = [r.lifecycle?.lastMerge ?? r.build.mergeCommit]
      let inMain = true
      for (const c of commits) if (!(await ok(repo, ['merge-base', '--is-ancestor', c, main]))) inMain = false
      if (!inMain && !r.lifecycle?.changedOutside)
        ledger.updateLifecycle(r.key, (x) => ({ lifecycle: { ...x.lifecycle, changedOutside: true } }), event('Changed outside Corvid', commits, `A recorded merge commit is no longer in ${main}'s history (a reset, a hand revert or a rebase). Re-apply or rebuild it, or remove it.`, 'corvid'))
      else if (inMain && r.lifecycle?.changedOutside) ledger.updateLifecycle(r.key, (x) => ({ lifecycle: { ...x.lifecycle, changedOutside: false } }), event('Back in main\'s history', commits, undefined, 'corvid'))
    } catch {
      /* one bad record never stops the others */
    }
  }
}

// ---------- what the page offers ----------

/** The flag the build used (its report), and whether the code really reads it: a simple scan of main's source. */
async function flagOf(r: ExtensionRecord, repo: string | undefined, main: string): Promise<LifecycleInfo['flag']> {
  const name = r.build?.report?.flag?.trim()
  if (!name) return undefined
  if (!repo) return { name, readInCode: false }
  // the sockets loader switches an extension off by its id in disabledExtensions; the extension's own code may read
  // its flag too. Either way the flag's name must appear in src on main.
  const hits = await git(repo, ['grep', '-l', '-F', '-e', name, main, '--', 'src']).catch(() => '')
  return { name, readInCode: hits.trim().length > 0 }
}

function dataLeft(r: ExtensionRecord): string[] {
  const dir = deps?.dataDir()
  if (!dir) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().includes(r.id.toLowerCase()) && !f.endsWith('.corvid'))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

async function guards(repo: string | undefined): Promise<LifecycleInfo['guards']> {
  if (!repo) return { dirty: false, agents: [] }
  const dirty = (await git(repo, ['status', '--porcelain', '--untracked-files=no']).catch(() => '')).trim().length > 0
  return { dirty, agents: deps?.agentsIn(repo) ?? [] }
}

export async function info(key: string): Promise<LifecycleInfo | { error: string }> {
  const r = recordOf(key)
  if (!r) return { error: 'That extension is no longer in the list.' }
  const all = ledger.list()
  const repo = repoOf(r)
  const main = (repo && (await defaultBranch(repo))) || 'main'
  const flag = await flagOf(r, repo, main)
  const up = updateFor(r, all)
  return {
    state: lifecycleState(r),
    flag,
    disableMode: flag?.readInCode && r.lifecycle?.disabledBy !== 'revert' ? 'instant' : 'rebuild',
    dependents: dependentsOf(r, all).map((x) => ({ key: x.key, name: x.name, version: x.version })),
    removalOrder: removalOrder(r, all).map((x) => ({ key: x.key, name: x.name })),
    ...(up ? { update: { key: up.key, version: up.version } } : {}),
    guards: await guards(repo),
    dataLeft: dataLeft(r),
    history: r.lifecycle?.history ?? []
  }
}

/** Refuses on uncommitted changes in main or agents mid-task in the Corvid project, unless the user confirmed. */
async function guarded(repo: string, confirmed: boolean): Promise<string | null> {
  if (confirmed) return null
  const g = await guards(repo)
  if (g.dirty) return "Corvid's main branch has uncommitted changes. Commit or put them aside first, or confirm to go on anyway (the merge itself still refuses until main is clean)."
  if (g.agents.length) return `${g.agents.length === 1 ? 'An agent is' : `${g.agents.length} agents are`} working in the Corvid project (${g.agents.slice(0, 4).join(', ')}). Confirm to go on anyway; a rebuild later ends them.`
  return null
}

// ---------- the actions ----------

export type ActionResult = LifecycleResult

/** Disable: the flag off when the code reads it (instant), else a revert of the merge on a new branch for review. */
export async function disable(key: string, confirmed = false): Promise<ActionResult> {
  const r = recordOf(key)
  if (!r || r.status !== 'installed') return { error: 'Only an installed extension can be disabled.' }
  if (r.lifecycle?.pending) return { error: 'A change to this extension is already waiting for review.' }
  const repo = repoOf(r)
  const main = (repo && (await defaultBranch(repo))) || 'main'
  const flag = await flagOf(r, repo, main)
  if (flag?.readInCode && deps) {
    deps.setDisabledIds([...new Set([...deps.disabledIds(), flag.name])])
    ledger.updateLifecycle(key, (x) => ({ status: 'disabled', lifecycle: { ...x.lifecycle, disabledBy: 'flag' } }), event(`Disabled (flag ${flag.name} off)`))
    return { ok: true, message: `Disabled: the flag ${flag.name} is off. Corvid reloaded its sockets at once; new agents get the change, running ones keep the tools they started with. No rebuild needed.` }
  }
  return prepare(key, 'disable', confirmed)
}

/** Enable: the flag back on, or re-apply the same stored commits (a revert of the revert), no agent, no usage. */
export async function enable(key: string, confirmed = false): Promise<ActionResult> {
  const r = recordOf(key)
  if (!r || r.status !== 'disabled') return { error: 'Only a disabled extension can be enabled.' }
  if (r.lifecycle?.disabledBy === 'flag' && deps) {
    const name = r.build?.report?.flag ?? r.id
    deps.setDisabledIds(deps.disabledIds().filter((x) => x !== name))
    ledger.updateLifecycle(key, (x) => ({ status: 'installed', lifecycle: { ...x.lifecycle, disabledBy: undefined } }), event(`Enabled (flag ${name} on)`))
    return { ok: true, message: `Enabled: the flag ${name} is on again. Corvid reloaded its sockets at once.` }
  }
  return prepare(key, 'enable', confirmed)
}

/** Remove: a revert like disable; once merged the record goes back to "Not installed yet", or to "Removed" with its
 *  stored text deleted when the user chose that. Dependents are refused here: the page removes them first, in order. */
export async function remove(key: string, deleteText: boolean, confirmed = false): Promise<ActionResult> {
  const r = recordOf(key)
  if (!r || (r.status !== 'installed' && r.status !== 'disabled')) return { error: 'Only an installed or disabled extension can be removed.' }
  const deps2 = dependentsOf(r, ledger.list())
  if (deps2.length) return { error: `Remove what needs it first: ${deps2.map((x) => `"${x.name}"`).join(', ')}.` }
  if (r.status === 'disabled' && r.lifecycle?.disabledBy === 'revert') {
    // already reverted on main: nothing left to take out, only the record changes
    finishRemove(key, deleteText, [r.lifecycle.lastMerge])
    return { ok: true, message: `Removed "${r.name}". Its changes were already reverted on main, so no git change was needed.` }
  }
  if (r.status === 'disabled' && r.lifecycle?.disabledBy === 'flag' && deps) deps.setDisabledIds(deps.disabledIds().filter((x) => x !== (r.build?.report?.flag ?? r.id)))
  return prepare(key, 'remove', confirmed, deleteText)
}

/** Re-apply the stored build: the recorded merge cherry-picked onto the current main (its first-parent changes). */
export async function reapply(key: string, confirmed = false): Promise<ActionResult> {
  const r = recordOf(key)
  if (!r?.build?.mergeCommit && !r?.build?.tip) return { error: 'There is no stored build to re-apply.' }
  return prepare(key, 'reapply', confirmed)
}

export function finishRemove(key: string, deleteText: boolean, commits: (string | undefined)[], detail?: string): void {
  if (deleteText) ledger.deleteText(key)
  ledger.updateLifecycle(
    key,
    (x) => ({ status: deleteText ? 'removed' : 'not-installed', lifecycle: { ...x.lifecycle, disabledBy: undefined, pending: undefined, changedOutside: false } }),
    event(deleteText ? 'Removed, text deleted' : 'Removed (can be installed again)', commits, detail)
  )
}

const stamp = (): string => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)

/** Makes the branch for a git-only change: a worktree from main, the revert or cherry-pick with no commit, then one
 *  commit with a trailer. A conflict aborts and removes the worktree; nothing on main is touched. */
async function prepare(key: string, op: PendingChange['op'], confirmed: boolean, deleteText = false): Promise<ActionResult> {
  const r = recordOf(key)!
  if (r.lifecycle?.pending) return { error: 'A change to this extension is already waiting for review.' }
  const held = r.lifecycle?.conflict
  if (held)
    return held.state === 'resolving'
      ? { error: "An agent is resolving a conflict for this extension. Wait for it, or stop it on the extension's page." }
      : { error: `A conflicted ${held.op} is waiting in ${held.files.join(', ')}. Resolve it with an agent, or leave it as it is, first.`, conflict: held.files, resolvable: true }
  const repo = repoOf(r)
  if (!repo || !existsSync(repo)) return { error: "Corvid's source checkout isn't set up, so there is nothing to change." }
  const stop = await guarded(repo, confirmed)
  if (stop) return { error: stop, needsConfirm: true }
  const base = (await defaultBranch(repo)) ?? 'main'
  const baseCommit = (await git(repo, ['rev-parse', base])).trim()
  const b = r.build!
  const what: string[] =
    op === 'disable' || op === 'remove'
      ? ['revert', '--no-commit', ...(await isMerge(repo, lastApplied(r)) ? ['-m', '1'] : []), lastApplied(r)!]
      : op === 'enable'
        ? ['revert', '--no-commit', r.lifecycle?.revertCommit ?? '']
        : b.mergeCommit && (await ok(repo, ['cat-file', '-e', `${b.mergeCommit}^{commit}`]))
          ? ['cherry-pick', '--no-commit', '-m', '1', b.mergeCommit]
          : ['cherry-pick', '--no-commit', `${b.baseCommit}..${b.tip}`]
  if (what.includes('') || what.includes(undefined as never)) return { error: 'The commits this needs are not on the record.' }
  const branch = `ext-${op}-${r.id}-${stamp()}`.slice(0, 80)
  const worktree = join(`${repo}-worktrees`, branch)
  try {
    await git(repo, ['worktree', 'add', '-b', branch, worktree, base])
  } catch (e) {
    return { error: `Couldn't make the branch: ${(e as Error).message.split('\n')[0]}` }
  }
  const drop = async (): Promise<void> => {
    await git(worktree, ['reset', '--hard', '-q', 'HEAD']).catch(() => {})
    await git(repo, ['worktree', 'remove', worktree]).catch(() => {})
    await git(repo, ['branch', '-d', branch]).catch(() => {})
  }
  try {
    await git(worktree, ['-c', 'core.autocrlf=false', ...what], 120_000)
  } catch (e) {
    const conflict = (await git(worktree, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim().split('\n').filter(Boolean)
    // #117: a conflicted Disable or Remove keeps its branch and worktree, the revert left conflicted, so an agent can
    // resolve it by hand after the user's confirmation; Enable and Re-apply still point to Rebuild from the text
    const hold = conflict.length > 0 && (op === 'disable' || op === 'remove')
    if (hold) {
      const revertOf = lastApplied(r)!
      const extFiles = await filesOf(repo, revertOf, r)
      linkDeps(repo, worktree)
      const h: ConflictHold = { op, branch, worktree, repo, base, baseCommit, revertOf, extFiles, files: conflict, protectedFiles: conflict.filter(isProtectedPath), ...(deleteText ? { deleteText } : {}), at: Date.now(), state: 'held' }
      ledger.updateLifecycle(key, (x) => ({ lifecycle: { ...x.lifecycle, conflict: h } }), event(`${op} conflicted`, [baseCommit, revertOf], `${conflict.join(', ')}. The branch ${branch} is kept for an agent to resolve, or to leave.`))
      deps?.gitChanged(repo)
    } else {
      await drop()
      ledger.updateLifecycle(key, (x) => ({ lifecycle: { ...x.lifecycle } }), event(`${op} conflicted`, [baseCommit], conflict.join(', ') || (e as Error).message.split('\n')[0]))
    }
    return {
      error: conflict.length
        ? `This conflicts with later changes to Corvid in ${conflict.slice(0, 10).join(', ')}. Nothing was changed on main.${hold ? ` ${CONFLICT_WHY}` : ' Re-install with Rebuild from the text instead.'}`
        : `git couldn't do it: ${(e as Error).message.split('\n')[0]}. Nothing was changed.`,
      conflict,
      offerReinstall: op === 'enable' || op === 'reapply',
      ...(hold ? { resolvable: true } : {})
    }
  }
  const staged = (await git(worktree, ['diff', '--cached', '--name-only']).catch(() => '')).trim().split('\n').filter(Boolean)
  if (!staged.length) {
    await drop()
    return { error: 'There is nothing to change: main already looks like this.' }
  }
  const subject = { disable: 'Disable', enable: 'Enable', remove: 'Remove', reapply: 'Re-apply' }[op]
  await git(worktree, ['commit', '-q', '-m', `${subject} extension ${r.id} ${r.version}`, '-m', `Corvid-Extension-${subject}: ${r.id} ${r.version}\nCorvid-Extension-Hash: ${r.hash}`])
  const tip = (await git(worktree, ['rev-parse', 'HEAD'])).trim()
  linkDeps(repo, worktree)
  const pending: PendingChange = { op, branch, worktree, repo, base, baseCommit, tip, files: staged, check: await typecheck(worktree), ...(deleteText ? { deleteText } : {}), at: Date.now() }
  ledger.updateLifecycle(key, (x) => ({ lifecycle: { ...x.lifecycle, pending } }), event(`${subject} prepared for review`, [tip], `${staged.length} file${staged.length === 1 ? '' : 's'} on ${branch}`))
  deps?.gitChanged(repo)
  return { ok: true, pending, message: `${subject} is ready on ${branch}. Review it, then Approve and merge.` }
}

/** The files a commit changed against its first parent (the extension's own files); the record's list as a fallback. */
async function filesOf(repo: string, commit: string, r: ExtensionRecord): Promise<string[]> {
  const out = (await git(repo, ['diff', '--name-only', '--no-renames', `${commit}^1`, commit]).catch(() => '')).trim().split('\n').filter(Boolean)
  return out.length ? out : (r.build?.filesTouched ?? [])
}

/** The commit that last put the extension into main: the re-apply's merge, else the install's merge. */
const lastApplied = (r: ExtensionRecord): string | undefined => (r.lifecycle?.disabledBy !== 'revert' && r.lifecycle?.lastMerge) || r.build?.mergeCommit
const isMerge = async (repo: string, c?: string): Promise<boolean> => !!c && (await git(repo, ['rev-list', '--parents', '-n', '1', c]).catch(() => '')).trim().split(' ').length > 2

/** The typecheck in the branch's worktree, when the project has one. The full build runs in the deploy (#78), which
 *  rolls back if it fails. */
export function typecheck(worktree: string): Promise<{ ok: boolean; output: string } | null> {
  if (!existsSync(join(worktree, 'node_modules')) || !existsSync(join(worktree, 'tsconfig.json'))) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'typecheck'], { cwd: worktree, windowsHide: true, timeout: 300_000, shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${stdout}${stderr}`.slice(-4000) })
    )
  })
}

export async function pendingDiff(key: string): Promise<{ text: string } | { error: string }> {
  const p = recordOf(key)?.lifecycle?.pending
  if (!p) return { error: 'There is no change waiting for review.' }
  const t = await git(p.repo, ['diff', '--no-color', '--stat', '--patch', `${p.baseCommit}..${p.tip}`]).catch((e) => `The diff couldn't be read: ${(e as Error).message}`)
  return { text: t.slice(0, 2 * 1024 * 1024) }
}

/** Approve and merge, from the user's click in Corvid's window only. Never pushed; the deploy is the user's own. */
export async function approve(key: string, tip: string): Promise<ActionResult> {
  const r = recordOf(key)
  const p = r?.lifecycle?.pending
  if (!r || !p) return { error: 'There is no change waiting for review.' }
  const now = (await git(p.repo, ['rev-parse', p.branch]).catch(() => '')).trim()
  if (now !== p.tip || tip !== p.tip) return { error: 'The branch changed since it was prepared. Discard it and start again.' }
  const b: AgentBranch = { repo: p.repo, branch: p.branch, cwd: p.worktree ?? p.repo, defaultBranch: p.base, worktree: p.worktree, reused: true }
  const m = await mergeBranch(b, `${p.op} extension ${r.id} ${r.version}`, false, 120_000, `Corvid-Extension-${p.op}: ${r.id} ${r.version}`)
  if (!m.ok || !m.merged) return { error: m.message }
  const merged = (await git(p.repo, ['rev-parse', p.base]).catch(() => '')).trim()
  if (p.worktree) unlinkDeps(p.worktree)
  await cleanUp(b)
  const words = { disable: 'Disabled', enable: 'Enabled', remove: 'Removed', reapply: 'Re-applied' }[p.op]
  if (p.op === 'remove') {
    ledger.updateLifecycle(key, (x) => ({ build: { ...x.build!, needsDeploy: true }, lifecycle: { ...x.lifecycle, revertCommit: p.tip, lastMerge: merged } }))
    finishRemove(key, !!p.deleteText, [p.tip, merged], p.resolved && `resolved by an agent as #${p.resolved.taskId}`)
  } else
    ledger.updateLifecycle(
      key,
      (x) => ({
        status: p.op === 'disable' ? 'disabled' : 'installed',
        build: { ...x.build!, needsDeploy: true },
        lifecycle: {
          ...x.lifecycle,
          pending: undefined,
          changedOutside: false,
          disabledBy: p.op === 'disable' ? 'revert' : undefined,
          revertCommit: p.op === 'disable' ? p.tip : undefined,
          lastMerge: merged
        }
      }),
      event(`${words} (merged)`, [p.tip, merged], p.resolved && `The conflict was resolved by an agent as #${p.resolved.taskId} and checked by Corvid.`)
    )
  deps?.gitChanged(p.repo)
  return { ok: true, message: `${words} "${r.name}": merged into ${p.base} (${merged.slice(0, 7)}), not pushed. Rebuild and restart Corvid to use it; that ends running agents.` }
}

/** Discard a prepared change: the worktree goes, the branch is kept (git keeps work; delete it on the project page). */
export async function discardPending(key: string): Promise<ActionResult> {
  const p = recordOf(key)?.lifecycle?.pending
  if (!p) return { error: 'There is no change waiting for review.' }
  if (p.worktree) {
    unlinkDeps(p.worktree)
    await git(p.repo, ['worktree', 'remove', ...(p.resolved ? ['--force'] : []), p.worktree]).catch(() => {})
  }
  // an agent's resolution (#117) was made for this change alone: Discard takes its branch too
  if (p.resolved && (await git(p.repo, ['branch', '-D', p.branch]).then(() => true, () => false))) {
    ledger.updateLifecycle(key, (x) => ({ lifecycle: { ...x.lifecycle, pending: undefined } }), event(`${p.op} discarded`, [p.tip], `the resolution's branch ${p.branch} and its worktree were deleted`))
    return { ok: true, message: `Discarded. The branch ${p.branch} and its worktree were deleted; main is as it was.` }
  }
  ledger.updateLifecycle(key, (x) => ({ lifecycle: { ...x.lifecycle, pending: undefined } }), event(`${p.op} discarded`, [p.tip], `branch ${p.branch} kept`))
  return { ok: true, message: `Discarded. The branch ${p.branch} is kept; delete it on the Corvid project page if you don't want it.` }
}

// ---------- rebuild and update: the install pipeline (#98) again, built on top ----------

/** Rebuild from the text: the record's current build is kept in `lifecycle.previous` and the Install flow (estimate,
 *  confirmation, build, review) runs again. Until the user merges the new build the old one stays on main. */
export function requestRebuild(key: string): ActionResult {
  const r = recordOf(key)
  if (!r?.build?.mergeCommit) return { error: 'Only an installed build can be rebuilt.' }
  ledger.updateLifecycle(
    key,
    (x) => ({ lifecycle: { ...x.lifecycle, previous: [...(x.lifecycle?.previous ?? []), { version: x.version, hash: x.hash, mergeCommit: x.build?.mergeCommit, tip: x.build?.tip, at: Date.now(), status: x.status, build: x.build }].slice(-10) } }),
    event('Rebuild from the text requested', [r.build.mergeCommit])
  )
  return { ok: true, message: 'Rebuild is ready to start: Install shows a new estimate and a confirmation.' }
}


/** After a build of `key` merged (#98's merge): a rebuild's snapshot is closed, and an older installed version of the
 *  same id is marked replaced (Update builds on top, so its changes are part of the new build now). */
export function afterMerge(key: string): void {
  const r = recordOf(key)
  if (!r) return
  if (rebuilding(r))
    ledger.updateLifecycle(key, (x) => ({ lifecycle: { ...x.lifecycle, changedOutside: false, lastMerge: undefined, previous: x.lifecycle?.previous?.map((p) => ({ ...p, done: true })) } }), event('Rebuilt (merged)', [r.build?.mergeCommit]))
  for (const old of ledger.list())
    if (old.key !== key && old.id === r.id && (old.status === 'installed' || old.status === 'disabled'))
      ledger.updateLifecycle(old.key, () => ({ status: 'removed' }), event(`Replaced by ${r.version}`, [old.build?.mergeCommit, r.build?.mergeCommit]))
}

/** After a rebuild's new build was discarded or failed: the old, still merged build comes back on the record. */
export function afterDiscard(key: string): void {
  const r = recordOf(key)
  const prev = [...(r?.lifecycle?.previous ?? [])].reverse().find((p) => p.hash === r?.hash && !p.done)
  if (!r || !prev?.build) return
  ledger.updateLifecycle(
    key,
    (x) => ({ status: prev.status ?? 'installed', build: prev.build, lifecycle: { ...x.lifecycle, previous: x.lifecycle?.previous?.map((p) => (p === prev ? { ...p, done: true } : p)) } }),
    event('Rebuild discarded; the old build is kept', [prev.mergeCommit])
  )
}

