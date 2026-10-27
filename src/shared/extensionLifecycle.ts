import type { CostEstimate } from './costEstimate'
import { compareVersions, type ExtensionRecord } from './extensions'

// The lifecycle of an installed extension (#99, docs/EXTENSIONS.md "Lifecycle"): disable, enable, remove, re-install
// and update. The types and the pure helpers both sides use; the git work is in src/main/extensionLifecycle.ts.

export type LifecycleOp = 'disable' | 'enable' | 'remove' | 'reapply' | 'rebuild' | 'update'

export const OP_WORDS: Record<LifecycleOp, string> = {
  disable: 'Disable',
  enable: 'Enable',
  remove: 'Remove',
  reapply: 'Re-apply the stored build',
  rebuild: 'Rebuild from the text',
  update: 'Update'
}

/** One line of an extension's history: what happened, when, who, and the commits involved. */
export interface LifecycleEvent {
  at: number
  /** the action, or what was found ("changed outside Corvid") */
  what: string
  who: 'user' | 'corvid'
  commits?: string[]
  detail?: string
}

/** A lifecycle change waiting for the user's review: a branch Corvid made with git alone (no agent). */
export interface PendingChange {
  op: Exclude<LifecycleOp, 'rebuild' | 'update'>
  branch: string
  worktree?: string
  repo: string
  base: string
  /** main when the branch was made, and the branch's tip after the revert or cherry-pick */
  baseCommit: string
  tip: string
  files: string[]
  /** the typecheck in the branch's worktree: null when it couldn't run */
  check?: { ok: boolean; output: string } | null
  /** remove only: also delete the stored text once merged */
  deleteText?: boolean
  at: number
  /** made by an agent resolving a conflict (#117), and checked by Corvid before it was shown */
  resolved?: { taskId: number; report: string; scan: 'clear' | 'flag' | 'block'; flags: string[]; revertOf: string; extFiles: string[]; conflicted: string[]; workerId?: string }
}

/** A Disable or Remove whose revert conflicted (#117): the branch and worktree prepare() made are kept, with the revert
 *  left conflicted, so an agent can resolve it by hand after the user's confirmation. */
export interface ConflictHold {
  op: 'disable' | 'remove'
  /** ext-<op>-<id>-<stamp> at first; renamed to the build task's branch (task-<n>-...) when an agent starts on it */
  branch: string
  worktree: string
  repo: string
  base: string
  baseCommit: string
  /** the commit the revert takes out (the install's merge, or a re-apply's), and the files it changed */
  revertOf: string
  extFiles: string[]
  /** the files git left conflicted */
  files: string[]
  /** some conflicted file is a protected path: the user's extra confirmation is needed first */
  protectedFiles: string[]
  deleteText?: boolean
  at: number
  /** held: waiting for the user; resolving: an agent works on it; failed: the agent or Corvid's checks failed (the
   *  branch is kept); interrupted: Corvid restarted while an agent worked on it */
  state: 'held' | 'resolving' | 'failed' | 'interrupted'
  taskId?: number
  workerId?: string
  reasons?: string[]
  /** the user's note when the review sent it back */
  sendBacks?: { at: number; note: string }[]
}

/** The confirmation's content for "Resolve with an agent" (#117): #97's estimate, the cap and the usage warning. */
export interface ResolvePrompt {
  token: string
  estimate: CostEstimate
  capMultiple: number
  capTokens: number
  usage?: { block: boolean; text: string }
  files: string[]
  protectedFiles: string[]
}

/** The conflict box's plain explanation (#117): why it can't be taken out automatically. */
export const CONFLICT_WHY =
  "Corvid changed this file after the extension was installed, so it can't be taken out automatically. An agent can take it out by hand and keep the newer changes."

export interface LifecycleRecord {
  /** how it is off: the per-extension flag (instant) or a revert merged into main */
  disabledBy?: 'flag' | 'revert'
  /** the commit on the revert branch that took the extension out (enable reverts it) */
  revertCommit?: string
  /** the merge commit of the revert (or the re-apply) on main */
  lastMerge?: string
  /** the merge commit was not found in main's history on the last check */
  changedOutside?: boolean
  pending?: PendingChange
  /** a conflicted Disable or Remove, kept for an agent to resolve (#117) */
  conflict?: ConflictHold
  /** the build this one replaced (Rebuild or Update), kept for its commits and cost */
  previous?: { version: string; hash: string; mergeCommit?: string; tip?: string; at: number; status?: ExtensionRecord['status']; build?: ExtensionRecord['build']; done?: boolean }[]
  history?: LifecycleEvent[]
}

/** What the card and the page show. Derived: the ledger's status plus the lifecycle and the build. */
export type LifecycleState =
  | 'installed'
  | 'installed-needs-deploy'
  | 'disabled'
  | 'removed'
  | 'failed'
  | 'needs-rebuild'
  | 'changed-outside'
  | 'pending-review'
  | 'conflicted'
  | 'resolving'
  | 'other'

export const STATE_WORDS: Record<LifecycleState, string> = {
  installed: 'Installed',
  'installed-needs-deploy': 'Installed, needs deploy',
  disabled: 'Disabled',
  removed: 'Removed',
  failed: 'Failed',
  'needs-rebuild': 'Needs rebuild',
  'changed-outside': 'Changed outside Corvid',
  'pending-review': 'Change waiting for review',
  conflicted: 'Conflict to resolve',
  resolving: 'An agent is resolving a conflict',
  other: ''
}

export function lifecycleState(r: ExtensionRecord): LifecycleState {
  const l = r.lifecycle
  if (l?.pending) return 'pending-review'
  if (l?.conflict && (r.status === 'installed' || r.status === 'disabled')) return l.conflict.state === 'resolving' ? 'resolving' : 'conflicted'
  if (r.status === 'installed' || r.status === 'disabled') {
    if (l?.changedOutside) return 'changed-outside'
    if (r.status === 'disabled') return 'disabled'
    if (r.build?.needsDeploy) return 'installed-needs-deploy'
    return 'installed'
  }
  if (r.status === 'removed') return 'removed'
  if (r.status === 'failed') return r.build?.mergeCommit ? 'needs-rebuild' : 'failed'
  return 'other'
}

/** Rebuild from the text was asked for: Install may run again while the old build stays installed. */
export const rebuilding = (r: ExtensionRecord): boolean => !!r.lifecycle?.previous?.some((p) => p.hash === r.hash && !p.done)

export const isInstalled = (r: ExtensionRecord): boolean => r.status === 'installed' || r.status === 'disabled'

/** Installed extensions that require this one (by id), newest merge first: the order to remove them in. */
export function dependentsOf(r: ExtensionRecord, all: ExtensionRecord[]): ExtensionRecord[] {
  return all
    .filter((x) => x.key !== r.key && isInstalled(x) && (x.header.requires ?? []).some((q) => q.id === r.id))
    .sort((a, b) => (b.build?.mergedAt ?? 0) - (a.build?.mergedAt ?? 0))
}

/** Removal order for an extension and everything installed that depends on it, dependents first (the reverse of the
 *  stack order they were merged in). Cycles are cut. */
export function removalOrder(r: ExtensionRecord, all: ExtensionRecord[]): ExtensionRecord[] {
  const out: ExtensionRecord[] = []
  const seen = new Set<string>()
  const visit = (x: ExtensionRecord): void => {
    if (seen.has(x.key)) return
    seen.add(x.key)
    for (const d of dependentsOf(x, all)) visit(d)
    out.push(x)
  }
  visit(r)
  return out
}

/** A newer version of the same id in the list while this one is installed: "Update available". */
export function updateFor(r: ExtensionRecord, all: ExtensionRecord[]): ExtensionRecord | undefined {
  if (!isInstalled(r)) return undefined
  return all
    .filter((x) => x.id === r.id && x.key !== r.key && !isInstalled(x) && x.status !== 'removed' && compareVersions(x.version, r.version) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0]
}

/** A plain line diff of two texts (the spec and prompt of two versions), for the Update view. Small texts only
 *  (extensions are at most 64 KB): a longest-common-subsequence table, capped. */
export function textDiff(a: string, b: string): { kind: ' ' | '-' | '+'; line: string }[] {
  const x = a.split('\n').slice(0, 1500)
  const y = b.split('\n').slice(0, 1500)
  const n = x.length
  const m = y.length
  const t: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const out: { kind: ' ' | '-' | '+'; line: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) out.push({ kind: ' ', line: x[i++] }), j++
    else if (t[i + 1][j] >= t[i][j + 1]) out.push({ kind: '-', line: x[i++] })
    else out.push({ kind: '+', line: y[j++] })
  }
  while (i < n) out.push({ kind: '-', line: x[i++] })
  while (j < m) out.push({ kind: '+', line: y[j++] })
  return out
}

/** What the page needs to offer the actions (lifecycle:info). */
export interface LifecycleInfo {
  state: LifecycleState
  /** the flag the build used, and whether the code really reads it */
  flag?: { name: string; readInCode: boolean }
  disableMode: 'instant' | 'rebuild'
  dependents: { key: string; name: string; version: string }[]
  /** remove: dependents first, then this one */
  removalOrder: { key: string; name: string }[]
  update?: { key: string; version: string }
  /** blockers that need an explicit confirmation: uncommitted changes on main, agents mid-task */
  guards: { dirty: boolean; agents: string[] }
  /** files the extension may have left in the app's data folder (never deleted automatically) */
  dataLeft: string[]
  history: LifecycleEvent[]
}

export type LifecycleResult = { ok: true; message: string; pending?: PendingChange } | { error: string; needsConfirm?: boolean; conflict?: string[]; offerReinstall?: boolean; resolvable?: boolean }
