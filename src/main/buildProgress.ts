import { execFile } from 'node:child_process'
import { z } from 'zod'
import { cleanReport, REPORT_LIMITS, REPORT_STAGES, type TouchedFile } from '@shared/buildProgress'
import { areaLabel, areaOf } from '@shared/extensionDiffScan'
import { isProtectedPath } from '@shared/extensionTiers'
import type { ExtensionRecord } from '@shared/extensions'
import type { AccessPart } from './agentAccess'
import { scrubber } from './remote/scrub'
import * as ledger from './extensions'

// Live build progress (#108, docs/EXTENSIONS.md "Build progress"): the build agent's report_progress tool, and the
// read-only views of its worktree the progress panel polls. Display only: nothing here approves, merges, confirms or
// moves a build between #98's states. Progress is local; nothing is sent anywhere.

const recordOfTask = (taskId: number): ExtensionRecord | undefined => ledger.list().find((r) => r.build?.taskId === taskId && r.build.state !== 'discarded')
const recordOf = (key: string): ExtensionRecord | undefined => ledger.list().find((r) => r.key === key)

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()))
      else resolve(stdout)
    })
  })
}

/** Take a report_progress call from the worker `workerId` on task `taskId`. Only that build's current worker counts:
 *  a stale worker of the same task, or a report for a build that isn't running, is ignored. */
export function takeReport(taskId: number, workerId: string, raw: Record<string, unknown>, now = Date.now()): string {
  const r = recordOfTask(taskId)
  if (!r?.build || r.build.state !== 'building') return 'There is no build of yours running, so the report was ignored.'
  if (r.build.workerId && r.build.workerId !== workerId) return 'This is not your build, so the report was ignored.'
  const log = r.build.progress ?? { reports: [] }
  const out = cleanReport(raw, log.reports, now, scrubber())
  if ('error' in out) {
    if (out.rateLimited) ledger.updateInstall(r.key, (x) => ({ build: { ...x.build!, progress: { ...log, dropped: (log.dropped ?? 0) + 1 } } }))
    return out.error
  }
  ledger.updateInstall(r.key, (x) => {
    const p = x.build?.progress ?? { reports: [] }
    return { build: { ...x.build!, progress: { ...p, reports: [...p.reports, out.report].slice(-REPORT_LIMITS.kept) } } }
  })
  return 'Noted on the build page. This is for the display only: it changes no stage. Carry on.'
}

/** The build agent's report_progress tool. Only a worker on an extension build gets it, bound to its own task. */
export function progressAccess(taskId: number, workerId: string): AccessPart | null {
  if (!recordOfTask(taskId)) return null
  return {
    allowed: ['report_progress'],
    prompt:
      'Progress: call mcp__corvid__report_progress at your milestones only, so the user can follow the build: when planning is done, when you start each part, ' +
      'when tests are running, with the acceptance checks passed so far, and when you have finished. A handful of calls per build, not every step; the note is one short plain line, never a secret. ' +
      'It is information for the display only: it approves, merges and changes nothing.',
    tools: [
      {
        name: 'report_progress',
        description:
          "Report a milestone of this extension build for the progress display on the extension's page: planning, part, tests, checks or finished, with a short note. " +
          'Information only: it cannot approve, merge or change the build. At most one call every 15 seconds.',
        input: {
          stage: z.enum(REPORT_STAGES).describe('planning (planning done), part (starting a part), tests (tests running), checks (acceptance checks so far), finished'),
          note: z.string().max(1000).optional().describe('one short plain line: what you are doing or just did'),
          checks_passed: z.number().int().min(0).max(40).optional(),
          checks_total: z.number().int().min(0).max(40).optional(),
          files_touched: z.number().int().min(0).max(5000).optional(),
          checks: z
            .array(z.object({ check: z.number().int().min(1).max(40), result: z.enum(['pass', 'fail', 'not-run']) }))
            .max(40)
            .optional()
            .describe('per-check results so far, by acceptance check number')
        },
        run: (a: Record<string, unknown>) => takeReport(taskId, workerId, a)
      }
    ]
  }
}

// ---------- the panel's read-only views (Corvid's window) ----------

const tier3Allows = (r: ExtensionRecord, area: string): boolean =>
  r.header.capabilities.tier === 3 && r.tier3?.hash === r.hash && r.tier3.areas.includes(area) && r.header.capabilities.coreAreas.includes(area)

/** The files the build has touched so far: committed on its branch since it started, and uncommitted in its worktree. */
export async function touchedFiles(key: string): Promise<{ files: TouchedFile[] } | { error: string }> {
  const r = recordOf(key)
  const b = r?.build
  if (!r || !b) return { error: 'There is no build.' }
  const tree = b.worktree && b.state === 'building' ? b.worktree : undefined
  const repo = tree ?? b.repo
  if (!repo) return { error: 'The build has no folder yet.' }
  const from = b.baseCommit ?? b.base ?? 'main'
  const head = tree ? 'HEAD' : b.tip ?? b.branch
  if (!head) return { files: [] }
  const committed = (await git(repo, ['diff', '--name-only', '--no-renames', `${from}...${head}`]).catch(() => ''))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const loose = tree
    ? (await git(tree, ['status', '--porcelain', '--untracked-files=all']).catch(() => ''))
        .split('\n')
        .map((l) => l.slice(3).trim().replace(/^"|"$/g, '').split(' -> ').pop()!)
        .filter(Boolean)
    : []
  const all = [...new Set([...committed, ...loose])].slice(0, 2000)
  return {
    files: all.map((path) => {
      const area = areaOf(path, r.id)
      const prot = isProtectedPath(path)
      return { path, area, areaLabel: areaLabel(area), protected: prot, allowed: !prot || tier3Allows(r, area), committed: committed.includes(path) }
    })
  }
}

/** The diff so far, read only: the worktree (committed and not) against where the build started. */
export async function diffSoFar(key: string): Promise<{ text: string; truncated: boolean } | { error: string }> {
  const b = recordOf(key)?.build
  const tree = b?.worktree
  if (!b || !tree || b.state !== 'building') return { error: 'There is no running build to show.' }
  const t = await git(tree, ['diff', '--no-color', '--stat', '--patch', '--no-ext-diff', b.baseCommit ?? b.base ?? 'main']).catch((e) => `The diff couldn't be read: ${(e as Error).message}`)
  const max = 2 * 1024 * 1024
  return { text: t.slice(0, max) || 'No changes to tracked files yet (new files show once they are added or committed).', truncated: t.length > max }
}

// ---------- the cap dialog (#97), so the panel can say the build needs you ----------

let capAsking = 0
/** Wraps #97's cap question: while it is open, the building extension shows "Needs your input". */
export async function whileCapAsk<T>(ask: () => Promise<T>): Promise<T> {
  capAsking++
  try {
    return await ask()
  } finally {
    capAsking--
  }
}
export const capDialogOpen = (): boolean => capAsking > 0
