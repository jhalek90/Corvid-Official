import type { BuildRecord, ExtensionCost, ExtensionRecord } from './extensions'
import { SECRET_RULES } from './secretRules'

// Live build progress (#108, docs/EXTENSIONS.md "Build progress"). Pure: the stage tracker, the activity lines and the
// numbers on the card and the page are worked out from the extension's ledger record (#98's BuildRecord and #97's
// cost), the build agent's own report_progress calls, and what Corvid already sees of the agent (its status, its
// activity feed, the files in its worktree). Nothing here approves, merges or changes a stage: it's display only.
//
// An agent can't know how far along it is, so there is no percentage: named stages, times, and elapsed time against
// #97's estimate range, labelled as an estimate.

export type StageId = 'queued' | 'scanning' | 'confirm' | 'building' | 'testing' | 'result-scan' | 'review' | 'merging' | 'deploy' | 'done'
/** how a build can end other than Done, or stand still waiting on the user */
export type EndState = 'failed' | 'stopped' | 'interrupted' | 'no-report' | 'needs-input'

export const STAGES: { id: StageId; label: string }[] = [
  { id: 'queued', label: 'Queued' },
  { id: 'scanning', label: 'Scanning' },
  { id: 'confirm', label: 'Waiting for your confirmation' },
  { id: 'building', label: 'Building' },
  { id: 'testing', label: 'Running tests' },
  { id: 'result-scan', label: 'Scanning the result' },
  { id: 'review', label: 'Waiting for your review' },
  { id: 'merging', label: 'Merging' },
  { id: 'deploy', label: 'Waiting for deploy' },
  { id: 'done', label: 'Done' }
]

export const END_WORDS: Record<EndState, string> = {
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Build interrupted',
  'no-report': 'Ended without a report',
  'needs-input': 'Needs your input'
}

/** What the build agent may report with report_progress: its own milestones. */
export const REPORT_STAGES = ['planning', 'part', 'tests', 'checks', 'finished'] as const
export type ReportStage = (typeof REPORT_STAGES)[number]
export const REPORT_WORDS: Record<ReportStage, string> = {
  planning: 'Planning done',
  part: 'Starting a part',
  tests: 'Running tests',
  checks: 'Acceptance checks',
  finished: 'Finished'
}

/** One report_progress call, as stored (cleaned, capped, scrubbed). */
export interface ProgressReport {
  at: number
  stage: ReportStage
  note: string
  checksPassed?: number
  checksTotal?: number
  filesTouched?: number
  /** per-check results so far, by check number */
  checks?: { check: number; result: 'pass' | 'fail' | 'not-run' }[]
}

/** The progress part of a BuildRecord (additive; a new build starts empty, Send back keeps it). */
export interface BuildProgressLog {
  reports: ProgressReport[]
  /** report_progress calls refused for the rate limit, so the page can say the agent was chatty */
  dropped?: number
}

export const REPORT_LIMITS = { noteChars: 300, minGapMs: 15_000, perBuild: 60, kept: 40 }

/** Masks anything that looks like a secret (the same patterns as the notes and board), keeping the rest. */
export function maskSecrets(text: string): string {
  let out = text
  for (const [, re] of SECRET_RULES) out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), '[removed]')
  return out
}

const int = (v: unknown, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : undefined

/** A report_progress call, cleaned: the note cut to one short line and scrubbed, numbers bounded, and the rate limit
 *  (one every 15 seconds, 60 per build; "finished" always gets through once). `scrub` is the main process's scrubber for
 *  stored secret values, on top of the pattern mask. */
export function cleanReport(
  raw: { stage?: unknown; note?: unknown; checks_passed?: unknown; checks_total?: unknown; files_touched?: unknown; checks?: unknown },
  prev: ProgressReport[],
  now: number,
  scrub: (s: string) => string = (s) => s
): { report: ProgressReport } | { error: string; rateLimited?: boolean } {
  const stage = REPORT_STAGES.find((s) => s === raw.stage)
  if (!stage) return { error: `stage must be one of ${REPORT_STAGES.join(', ')}.` }
  const last = prev[prev.length - 1]
  const finishing = stage === 'finished' && !prev.some((p) => p.stage === 'finished')
  if (!finishing) {
    if (prev.length >= REPORT_LIMITS.perBuild) return { error: 'This build has reported enough progress; carry on without reporting until you finish.', rateLimited: true }
    if (last && now - last.at < REPORT_LIMITS.minGapMs) return { error: 'Too soon after your last progress report: report milestones only, not every step.', rateLimited: true }
  }
  const note = maskSecrets(scrub(typeof raw.note === 'string' ? raw.note : ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REPORT_LIMITS.noteChars)
  const total = int(raw.checks_total, 40)
  const passed = int(raw.checks_passed, 40)
  const checks = Array.isArray(raw.checks)
    ? raw.checks
        .slice(0, 40)
        .map((c: { check?: unknown; result?: unknown }) => ({ check: int(c?.check, 40) ?? 0, result: (['pass', 'fail', 'not-run'] as const).find((r) => r === c?.result) }))
        .filter((c): c is { check: number; result: 'pass' | 'fail' | 'not-run' } => c.check >= 1 && !!c.result)
    : undefined
  return {
    report: {
      at: now,
      stage,
      note,
      ...(passed !== undefined && { checksPassed: total !== undefined ? Math.min(passed, total) : passed }),
      ...(total !== undefined && { checksTotal: total }),
      ...(int(raw.files_touched, 5000) !== undefined && { filesTouched: int(raw.files_touched, 5000) }),
      ...(checks?.length && { checks })
    }
  }
}

/** The agent as Corvid sees it right now (the Agents page's own data). */
export interface LiveAgent {
  /** the worker's state (running, stopped, finished, exited) and its card status */
  state?: 'running' | 'stopped' | 'finished' | 'exited'
  status?: 'waiting' | 'blocked' | 'busy' | 'starting' | 'idle' | 'exited'
  /** the latest activity events (the ticker's), newest last */
  events?: { ts: number; label: string; tool?: string }[]
  /** output tokens so far, from its session */
  outputTokens?: number
  /** the soft cap's dialog is open for this build (#97) */
  capAsking?: boolean
  /** the agent asked the user something on the board and it's unanswered */
  question?: string
}

export type StageState = 'done' | 'current' | 'pending' | 'skipped'
export type LineSource = 'agent' | 'corvid' | 'inferred'

export interface BuildProgress {
  /** the stage the build is in, or how it ended */
  current: StageId
  end?: EndState
  /** why it ended or what it needs, in plain words */
  endText?: string
  stages: { id: StageId; label: string; state: StageState; ms?: number }[]
  /** what needs the user right now (a question, a permission prompt, the cap dialog, the review), if anything */
  needsYou?: string
  agent: 'working' | 'idle' | 'needs-you' | 'starting' | 'ended' | 'none'
  /** newest first; each says where it came from */
  lines: { at: number; text: string; source: LineSource }[]
  checks: { check: number; text?: string; state: 'pending' | 'pass' | 'fail' | 'not-run'; source?: LineSource }[]
  checksSummary?: string
  elapsedMs?: number
  /** "about 12 minutes in, estimated 8 to 20" */
  timeText?: string
  tokens?: { used?: number; likely?: number; cap?: number }
}

const TEST_RUN = /\b(npm (run )?(typecheck|test[\w:-]*)|node --test|tsc\b|vitest|jest|playwright)/i

/** The estimate's time range in minutes: #97 stores the likely minutes; the token range's spread scales it. */
export function minutesRange(est: ExtensionCost['estimate']): { low: number; high: number } | undefined {
  if (!est?.minutes) return undefined
  const likely = est.likely ?? (est.low + est.high) / 2
  if (!likely) return undefined
  return { low: Math.max(1, Math.round((est.minutes * est.low) / likely)), high: Math.max(1, Math.round((est.minutes * est.high) / likely)) }
}

export const fmtMinutes = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m < 1 ? 'under a minute' : m === 1 ? '1 minute' : m < 90 ? `${m} minutes` : `${(m / 60).toFixed(1)} hours`
}

/** Which way a failed build ended, from #98's error text (its wording is the contract: see extensionInstall.ts). */
export function endOf(b: BuildRecord): EndState | undefined {
  if (b.state !== 'failed') return undefined
  const e = b.error ?? ''
  if (/^Corvid restarted during the build/.test(e)) return 'interrupted'
  if (/^Stopped (at the budget cap|by you)/.test(e)) return 'stopped'
  if (/without a build report/.test(e)) return 'no-report'
  return 'failed'
}

/** The whole progress view for one build. `checkTexts` are the extension's acceptance checks, in order. */
export function buildProgress(r: ExtensionRecord, live: LiveAgent, now: number, capMultiple = 2, checkTexts: string[] = []): BuildProgress | null {
  const b = r.build
  if (!b || b.state === 'discarded') return null
  const reports = b.progress?.reports ?? []
  const events = live.events ?? []
  const end = endOf(b)

  // when each stage began, from the record and the reports, falling back to what the activity feed shows
  const firstTestEvent = events.find((e) => e.ts >= (b.startedAt ?? 0) && TEST_RUN.test(e.label))?.ts
  const testsAt = reports.find((p) => p.stage === 'tests' || p.stage === 'checks')?.at ?? firstTestEvent
  const started: Partial<Record<StageId, number>> = {
    queued: r.createdAt,
    scanning: r.scan?.at,
    confirm: r.scan?.state === 'done' ? r.scan.at : undefined,
    building: b.startedAt,
    testing: testsAt,
    'result-scan': b.report?.at,
    review: b.state === 'needs-review' || b.mergedAt ? b.endedAt : undefined,
    merging: b.mergedAt,
    deploy: b.mergedAt,
    done: b.state === 'merged' && !b.needsDeploy ? b.mergedAt : undefined
  }
  let current: StageId =
    b.state === 'merged'
      ? b.needsDeploy
        ? 'deploy'
        : 'done'
      : b.state === 'needs-review'
        ? 'review'
        : b.state === 'failed'
          ? b.report
            ? 'result-scan'
            : testsAt
              ? 'testing'
              : 'building'
          : b.report
            ? 'result-scan'
            : testsAt
              ? 'testing'
              : 'building'
  // a build whose worker hasn't started yet is queued behind the worker limit or the usage prompt
  if (b.state === 'building' && !b.workerId && !live.state) current = 'queued'
  const idx = STAGES.findIndex((s) => s.id === current)
  const stages = STAGES.map((s, i) => {
    const state: StageState = i < idx ? (s.id === 'testing' && !testsAt ? 'skipped' : 'done') : i === idx ? (current === 'done' ? 'done' : 'current') : 'pending'
    const from = started[s.id]
    const next = STAGES.slice(i + 1).map((x) => started[x.id]).find((t) => t !== undefined)
    const to = state === 'current' ? (end ? b.endedAt : now) : next
    const ms = from !== undefined && to !== undefined && to >= from && (state === 'done' || state === 'current') && i >= 3 ? to - from : undefined
    return { id: s.id, label: s.label, state, ms }
  })

  // the agent, as its card sees it
  const running = live.state === 'running'
  const agent: BuildProgress['agent'] = !b.workerId && !live.state ? 'none' : !running ? (live.state ? 'ended' : 'starting') : live.status === 'waiting' || live.status === 'blocked' ? 'needs-you' : live.status === 'busy' ? 'working' : live.status === 'starting' || !live.status ? 'starting' : 'idle'

  let needsYou: string | undefined
  if (b.state === 'building') {
    if (live.capAsking) needsYou = 'The build passed its budget cap: Corvid is asking you to continue or stop, in its dialog.'
    else if (live.status === 'blocked') needsYou = 'The build agent is waiting for a permission prompt. Open the agent to answer it.'
    else if (live.question) needsYou = `The build agent asked you: "${live.question.slice(0, 200)}"`
    else if (live.status === 'waiting') needsYou = 'The build agent is waiting for you. Open the agent to answer it.'
  } else if (b.state === 'needs-review') needsYou = 'The build is waiting for your review below.'

  // the activity lines: the agent's own reports, Corvid's records, and what the feed shows
  const lines: BuildProgress['lines'] = []
  for (const p of reports) lines.push({ at: p.at, text: `${REPORT_WORDS[p.stage]}${p.note ? `: ${p.note}` : ''}`, source: 'agent' })
  for (const e of events.slice(-8)) if (e.ts >= (b.startedAt ?? 0)) lines.push({ at: e.ts, text: e.label, source: 'inferred' })
  if (b.startedAt) lines.push({ at: b.startedAt, text: `Build started as task #${b.taskId ?? '?'}${b.branch ? ` on ${b.branch}` : ''}`, source: 'corvid' })
  for (const s of b.sendBacks ?? []) lines.push({ at: s.at, text: `Sent back with a note: ${s.note.slice(0, 160)}`, source: 'corvid' })
  if (b.report) lines.push({ at: b.report.at, text: 'Build report received; Corvid scanned the diff', source: 'corvid' })
  if (b.endedAt && (b.state === 'failed' || b.state === 'needs-review')) lines.push({ at: b.endedAt, text: b.state === 'failed' ? `Ended: ${b.error ?? 'failed'}` : 'Ready for your review', source: 'corvid' })
  if (b.mergedAt) lines.push({ at: b.mergedAt, text: 'Merged by you', source: 'corvid' })
  if (b.state === 'building' && live.state && !running) lines.push({ at: now, text: 'The build agent has ended and no report has arrived', source: 'corvid' })
  lines.sort((x, y) => y.at - x.at)

  // acceptance checks: the final report wins; before it, the agent's latest per-check results
  const final = b.report?.acceptance
  const latest = [...reports].reverse().find((p) => p.checks?.length)?.checks
  const n = Math.max(checkTexts.length, ...(final ?? []).map((c) => c.check), ...(latest ?? []).map((c) => c.check), 0)
  const checks: BuildProgress['checks'] = []
  for (let i = 1; i <= n; i++) {
    const f = final?.find((c) => c.check === i)
    const l = latest?.find((c) => c.check === i)
    checks.push({ check: i, text: checkTexts[i - 1], state: f?.result ?? l?.result ?? 'pending', source: f ? 'agent' : l ? 'agent' : undefined })
  }
  const counted = [...reports].reverse().find((p) => p.checksTotal !== undefined)
  const checksSummary = final
    ? `${final.filter((c) => c.result === 'pass').length} of ${final.length} passed (the build report, the agent's own account)`
    : counted
      ? `${counted.checksPassed ?? 0} of ${counted.checksTotal} passing so far (the agent's count)`
      : undefined

  const elapsedMs = b.startedAt ? (b.endedAt && b.state !== 'building' ? b.endedAt : now) - b.startedAt : undefined
  const range = minutesRange(r.cost?.estimate)
  const timeText =
    elapsedMs !== undefined
      ? `${b.state === 'building' ? `about ${fmtMinutes(elapsedMs)} in` : `took ${fmtMinutes(elapsedMs)}`}${range ? `, estimated ${range.low} to ${range.high} minutes (an estimate)` : ''}`
      : undefined
  const est = r.cost?.estimate
  const likely = est ? est.likely ?? est.low : undefined
  const used = b.state === 'building' ? live.outputTokens : r.cost?.actual?.amount ?? live.outputTokens
  return {
    current,
    end: end ?? (needsYou && b.state === 'building' ? 'needs-input' : undefined),
    endText: end ? b.error : needsYou && b.state === 'building' ? needsYou : undefined,
    stages,
    needsYou,
    agent,
    lines: lines.slice(0, 14),
    checks,
    checksSummary,
    elapsedMs,
    timeText,
    tokens: { used, likely, cap: likely !== undefined ? Math.round(likely * capMultiple) : undefined }
  }
}

/** The area words the page groups touched files by, with the protected flag and the tier it would need. */
export interface TouchedFile {
  path: string
  area: string
  areaLabel: string
  protected: boolean
  /** what the extension declared allows: a protected path is only allowed for a confirmed tier-3 build of that area */
  allowed: boolean
  committed: boolean
}
