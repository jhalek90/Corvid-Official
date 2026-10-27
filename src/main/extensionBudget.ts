import { randomUUID } from 'node:crypto'
import {
  estimate,
  estimateAccuracy,
  fmtTokens,
  newCap,
  overCap,
  raiseCap,
  scanEstimate,
  sizeClass,
  type CapState,
  type CostEstimate,
  type HistoryRecord
} from '@shared/costEstimate'
import type { CostRun, ExtensionRecord, InstallPrompt } from '@shared/extensions'
import type { SessionSummary } from '@shared/types'
import { overGates } from '@shared/workerLimits'
import { getConfig } from './config'
import * as ledger from './extensions'

// The estimate and the soft budget cap (#97), the one place every part that spends usage goes through: the install
// build (#98), the wizard's sessions (#100), the verify build (#101) and the scan (#96).
//
//   estimateFor(key)            Corvid's own estimate for building an extension
//   prepareInstall(key)         the confirmation's content and a one-time token for it
//   confirmInstall(key, token)  the user's Confirm in the window: the only way an install may start
//   watchBuild(opts)            the soft cap while a build runs, then its actual usage in the ledger
//
// Only the window's IPC handlers reach prepareInstall and confirmInstall; no MCP tool or board message does, and a
// token is made only when the user opens the dialog. Nothing here is sent anywhere.

type Quota = { fiveHour?: number; week?: number; at: number; resets5h?: number } | null

interface Deps {
  sessions: () => SessionSummary[]
  quota: () => Quota
  /** the cap's question, in Corvid's own window: true = Continue, false = Stop */
  askCap: (title: string, text: string) => Promise<boolean>
  /** a dashboard notice on the board */
  notice: (text: string, taskId?: number) => void
}

let deps: Deps = { sessions: () => [], quota: () => null, askCap: async () => false, notice: () => {} }
export const initBudget = (d: Deps): void => void (deps = d)

/** The model a build runs with: the worker model from Settings. */
export const buildModel = (): string => {
  const m = getConfig().workerModel
  return m === 'default' ? 'your default model' : m
}

// ---------- history ----------

const TASK_TITLE = /^#(\d+)\s/
/** A session counts as finished once it has been quiet this long. */
const QUIET_MS = 30 * 60_000

/** What similar work really cost on this PC: task sessions ("#<id> ...", summed over resumes) and extension builds. */
export function history(sessions = deps.sessions(), records = ledger.list(), now = Date.now()): HistoryRecord[] {
  const byTask = new Map<number, HistoryRecord>()
  for (const s of sessions) {
    const m = TASK_TITLE.exec(s.title ?? '')
    if (!m || s.junk || now - s.lastActivity < QUIET_MS || !s.tokens?.output) continue
    const id = Number(m[1])
    const minutes = Math.max(1, Math.min(240, (s.lastActivity - s.startedAt) / 60_000))
    const prev = byTask.get(id)
    // the first prompt carries the task's title, notes and instructions: its size stands for the task's size
    const size = Math.max(prev?.sizeChars ?? 0, (s.firstPrompt ?? '').length)
    byTask.set(id, {
      kind: 'task',
      at: Math.max(prev?.at ?? 0, s.lastActivity),
      sizeChars: size,
      effort: sizeClass(size),
      outputTokens: (prev?.outputTokens ?? 0) + s.tokens.output,
      minutes: (prev?.minutes ?? 0) + minutes,
      model: Object.keys(s.models ?? {})[0]
    })
  }
  const builds = records.flatMap((r) => (r.cost?.runs ?? []).map(runToHistory))
  return [...byTask.values(), ...builds]
}

const runToHistory = (r: CostRun): HistoryRecord => ({
  kind: 'build',
  at: r.at,
  effort: r.effort,
  sizeChars: r.seedChars,
  checks: r.checks,
  tier: r.tier,
  outputTokens: r.actual.tokens,
  minutes: r.actual.minutes,
  model: r.model,
  estimatedLikely: r.estimate.likely,
  outcome: r.outcome
})

// ---------- estimates ----------

export function estimateFor(key: string): CostEstimate | null {
  const d = ledger.detail(key)
  if (!d) return null
  const h = d.record.header
  const scan = d.record.scan as (ExtensionRecord['scan'] & { complexity?: number; effort?: 'small' | 'medium' | 'large' }) | undefined
  return estimate({
    effort: h.effort.class,
    observed: h.effort.observed,
    complexity: scan?.complexity,
    inferredEffort: scan?.effort,
    // without the stored text, the header's description stands in (the page says the text is missing)
    seedChars: d.sections?.seedPrompt.length ?? h.description.length,
    checks: d.sections?.checks.length ?? h.effort.observed.checks ?? 4,
    tier: h.capabilities.tier,
    model: buildModel(),
    history: history(),
    quota: deps.quota()
  })
}

/** The scan's small fixed cost (#96), through the same engine and display. */
export const estimateScan = (model = 'haiku'): CostEstimate => scanEstimate(model, deps.quota())

/** The "estimates have been off by X%" line for the Extensions tab, once there are a few builds. */
export const accuracy = (): { offBy: number; n: number } | null => estimateAccuracy(history())

// ---------- the confirmation before an install ----------

/** One token per dialog the user opened, for 15 minutes, used once. In memory only. */
const tokens = new Map<string, { key: string; estimate: CostEstimate; until: number }>()
const TOKEN_MS = 15 * 60_000

/** The confirmation's content: the estimate, the cap, and the usage limit's warning when usage is over it (#93). */
export function prepareInstall(key: string): InstallPrompt | { error: string } {
  const r = ledger.list().find((x) => x.key === key)
  if (!r) return { error: 'That extension is no longer in the list.' }
  if (r.status !== 'not-installed' && r.status !== 'ready' && r.status !== 'failed')
    return { error: `"${r.name}" is ${r.status}, so it can't be installed now.` }
  const est = estimateFor(key)
  if (!est) return { error: 'That extension is no longer in the list.' }
  const now = Date.now()
  for (const [t, v] of tokens) if (v.until < now) tokens.delete(t)
  const token = randomUUID()
  tokens.set(token, { key, estimate: est, until: now + TOKEN_MS })
  const multiple = getConfig().extensionCapMultiple
  return { token, estimate: est, capMultiple: multiple, capTokens: Math.round(est.tokens.likely * multiple), usage: usageWarning() }
}

/** The estimate for an agent resolving a Remove or Disable conflict (#117): a small job, sized by the conflicted
 *  text the agent must read (the conflicted files' diff), two checks (the typecheck and the tests), the extension's tier. */
export function estimateResolve(tier: 1 | 2 | 3, conflictChars: number): CostEstimate {
  return estimate({ effort: 'small', seedChars: Math.min(conflictChars, 60_000), checks: 2, tier, model: buildModel(), history: history(), quota: deps.quota() })
}

/** The confirmation's content for a conflict resolution (#117): the same estimate, cap and usage warning as an install. */
export function resolvePrompt(est: CostEstimate): Omit<InstallPrompt, 'token'> {
  const multiple = getConfig().extensionCapMultiple
  return { estimate: est, capMultiple: multiple, capTokens: Math.round(est.tokens.likely * multiple), usage: usageWarning() }
}

/** The usage limit (#93) as the confirmation shows it: a second, specific warning in the same dialog. */
export function usageWarning(): InstallPrompt['usage'] {
  const l = getConfig().limits
  if (!l.usageLimit || (!l.gate5hOn && !l.gateWeekOn)) return undefined
  const q = deps.quota()
  const block = l.overLimit === 'block'
  if (!q) return { block, text: "Current usage is unknown: the usage check failed, so Corvid can't tell whether you're over your usage limit." }
  const o = overGates(l, q.fiveHour, q.week)
  if (!o.five && !o.week) return undefined
  const pct = (v?: number): string => (v === undefined ? 'unknown' : `${Math.round(v)}%`)
  const parts = [o.five && `5-hour usage is at ${pct(q.fiveHour)} (your limit is ${l.gate5h}%)`, o.week && `weekly usage is at ${pct(q.week)} (your limit is ${l.gateWeek}%)`]
  const text = `You're over your usage limit: ${parts.filter(Boolean).join(' and ')}. ${
    block ? 'Settings blocks new agents above the limit, so the build can\'t start until usage resets.' : 'The build may stall or stop when you reach your plan\'s limit.'
  }`
  return { block, text }
}

/** The user pressed Confirm in the dialog. Checks the token, records the estimate, and hands over to the build. */
export function confirmInstall(key: unknown, token: unknown): { ok: true; estimate: CostEstimate; started: boolean; message: string } | { error: string } {
  const t = typeof token === 'string' ? tokens.get(token) : undefined
  if (!t || t.key !== key || t.until < Date.now()) return { error: 'This confirmation has expired. Press Install again to see a fresh estimate.' }
  tokens.delete(token as string)
  if (usageWarning()?.block) return { error: "You're over your usage limit and Settings blocks new agents, so nothing was started." }
  ledger.setCost(t.key, (c) => ({ ...c, estimate: { ...pick(t.estimate), at: Date.now(), confirmedAt: Date.now() } }))
  const started = onConfirmed(t.key, t.estimate)
  return {
    ok: true,
    estimate: t.estimate,
    started,
    message: started ? 'Confirmed: the build is starting.' : 'Confirmed and saved with its estimate. Building comes with the install pipeline (Extensions 4/8), so nothing was started.'
  }
}

const pick = (e: CostEstimate) => ({ low: e.tokens.low, likely: e.tokens.likely, high: e.tokens.high, unit: 'output tokens', model: e.model, minutes: e.minutes.likely, confidence: e.confidence })

/** The install pipeline (#98) registers here; until then a confirmation only records the estimate. */
let onConfirmed: (key: string, estimate: CostEstimate) => boolean = () => false
export const onInstallConfirmed = (fn: (key: string, estimate: CostEstimate) => boolean): void => void (onConfirmed = fn)

// ---------- the soft cap while a build runs ----------

export interface BuildWatch {
  /** the ledger key of the extension, or undefined for usage that isn't an extension build (the wizard, #100) */
  key?: string
  taskId?: number
  what: string
  estimate: CostEstimate
  /** the build's output tokens so far, from its session's live data */
  outputTokens: () => number | undefined
  /** ends the agent; the branch and its work are kept */
  stop: () => void | Promise<void>
  /** extra, for the ledger's record */
  seedChars?: number
  checks?: number
  tier?: 1 | 2 | 3
  pollMs?: number
}

export interface WatchHandle {
  /** the build ended on its own: record it (ok or failed) */
  finish: (outcome: 'ok' | 'failed' | 'cancelled') => CostRun
  cap: () => CapState
}

/** Watch a running build against the soft cap: past it, ask Continue or Stop in Corvid's window. */
export function watchBuild(w: BuildWatch): WatchHandle {
  const started = Date.now()
  let cap = newCap(w.estimate.tokens.likely, getConfig().extensionCapMultiple)
  let asking = false
  let done = false
  let stoppedByCap = false
  let used = 0
  const tick = async (): Promise<void> => {
    if (done || asking) return
    used = Math.max(used, w.outputTokens() ?? 0)
    if (!overCap(cap, used)) return
    asking = true
    cap = { ...cap, hit: true }
    const times = (used / cap.likely).toFixed(1)
    deps.notice(`${w.what} has used about ${times}× its estimate (${fmtTokens(used)} of ${fmtTokens(cap.likely)} output tokens). Corvid is asking you whether to continue.`, w.taskId)
    const go = await deps.askCap(`${w.what} has used about ${Math.round(used / cap.likely)}x its estimate. Continue, or stop?`, capText(w, used, cap))
    asking = false
    if (done) return
    if (go) {
      cap = raiseCap(cap, used)
      deps.notice(`${w.what} continues; Corvid asks again at ${fmtTokens(cap.askAt)} output tokens.`, w.taskId)
    } else {
      stoppedByCap = true
      deps.notice(`${w.what} was stopped at its budget cap. The branch and the work so far are kept.`, w.taskId)
      await w.stop()
      handle.finish('cancelled')
    }
  }
  const timer = setInterval(() => void tick(), w.pollMs ?? 15_000)
  timer.unref?.()
  const handle: WatchHandle = {
    cap: () => cap,
    finish: (outcome) => {
      const run: CostRun = {
        at: Date.now(),
        effort: w.estimate.effort,
        seedChars: w.seedChars ?? 0,
        checks: w.checks,
        tier: w.tier,
        model: w.estimate.model,
        estimate: { low: w.estimate.tokens.low, likely: w.estimate.tokens.likely, high: w.estimate.tokens.high },
        actual: { tokens: Math.max(used, w.outputTokens() ?? 0), minutes: Math.round((Date.now() - started) / 60_000) },
        capHit: cap.hit,
        continued: cap.continued,
        outcome: stoppedByCap ? 'cancelled' : outcome
      }
      if (done) return run
      done = true
      clearInterval(timer)
      if (w.key) ledger.setCost(w.key, (c) => ({ ...c, actual: { amount: run.actual.tokens, unit: 'output tokens', at: run.at, minutes: run.actual.minutes, model: run.model, capHit: run.capHit, outcome: run.outcome }, runs: [...(c.runs ?? []), run].slice(-20) }))
      return run
    }
  }
  // exposed for tests and for a build that wants to check right away
  ;(handle as WatchHandle & { tick: () => Promise<void> }).tick = tick
  return handle
}

/** The cap dialog's text, with the numbers, and what Stop does. */
export function capText(w: Pick<BuildWatch, 'what'>, used: number, cap: CapState): string {
  return [
    `${w.what} has used about ${(used / cap.likely).toFixed(1)}× its estimate: ${fmtTokens(used)} output tokens against an estimate of ${fmtTokens(cap.likely)}.`,
    `Continue lets it use one more estimate (up to ${fmtTokens(Math.max(cap.askAt, used) + cap.likely)}) and asks again there.`,
    "Stop ends the agent and keeps its branch and the work so far. A build can't be paused in the middle of a turn, so Stop is the only way to halt it."
  ].join('\n\n')
}
