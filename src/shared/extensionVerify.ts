import type { DiffRule, DiffScanResult } from './extensionDiffScan'
import type { BuildReport, Effort, ExtensionRecord, InstallPrompt } from './extensions'
import { leakFindings, setHeaderField, type LeakContext } from './packager'

// Verify and Share (#101, docs/EXTENSIONS.md "Verifying and sharing"). The pure part: whether a verify build passed,
// what the shared file says, and the final leak check. The pipeline is in src/main/extensionVerify.ts.

/** What the page says about a verification, everywhere it is shown. */
export const VERIFY_HONESTY =
  "Verified means the text rebuilt the feature on a clean Corvid at that version. It doesn't prove the feature is safe or that it will build the same way on other versions or with other models."

/** Corvid's own verification of a record's exact text (the ledger's `verification`). Bound to `hash` and `baseCommit`:
 *  a record whose hash differs (any edit makes a new record) is unverified. */
export interface VerificationRecord {
  /** sha256 of the canonical text that was verified: the record's hash at the time */
  hash: string
  /** the clean commit the build started from, and the Corvid version in its package.json */
  baseCommit: string
  baseVersion: string
  /** which base the user picked: the extension's built_on (or the commit before their own feature), or main */
  baseKind: BaseKind
  at: number
  model: string
  /** the real effort, measured: replaces the author's guess and sets the effort class */
  minutes: number
  tokens: number
  files: number
  checks: number
  effort: Effort
  /** the build report and the diff scan of the verify build, kept after its worktree and branch are removed */
  report: BuildReport
  diffScan: DiffScanResult
}

export type BaseKind = 'built-on' | 'before-feature' | 'main'

/** A verify build in progress or the last one that ended (the ledger's `verify`). */
export interface VerifyRun {
  state: 'building' | 'passed' | 'failed' | 'cancelled'
  taskId?: number
  workerId?: string
  repo?: string
  branch?: string
  worktree?: string
  baseCommit?: string
  baseVersion?: string
  baseKind?: BaseKind
  startedAt: number
  endedAt?: number
  /** the hash of the text this run builds; a run for another hash is stale */
  hash: string
  /** why it failed, each in plain words: failed checks, differences from the declared capabilities, the build */
  reasons?: string[]
  report?: BuildReport
  diffScan?: DiffScanResult
  /** whether the throwaway worktree and branch were removed (kept only if removal failed, with why) */
  cleaned?: boolean
  cleanupNote?: string
}

/** One Share of a verified record: when and where, for the user's reference. Never sent anywhere. */
export interface ShareRecord {
  at: number
  /** a file path the user picked, or the clipboard */
  where: string
  /** sha256 of the exact text shared (with the verification block filled in) and of the record's text */
  fileHash: string
  hash: string
}

/** A clean commit to verify on (src/main/extensionVerify.ts resolveBase). */
export interface VerifyBase {
  kind: BaseKind
  commit: string
  version: string
  /** what the page says about this base */
  label: string
}

/** What stands in the way of a verify, and the two bases the user can pick from. */
export interface VerifyCheck {
  ok: boolean
  blockers: string[]
  verified: boolean
  bases: { 'built-on': VerifyBase | { error: string }; main: VerifyBase | { error: string } }
}

/** The verify confirmation: #97's estimate, the cap, the usage warning, and the base. */
export interface VerifyPrompt extends InstallPrompt {
  base: VerifyBase
}

/** What Share would write, and the final leak check. */
export interface SharePreview {
  text: string
  fileName: string
  leaks: string[]
  verification: VerificationRecord
}

/** Verified now: a verification for this exact text. */
export const isVerified = (r: Pick<ExtensionRecord, 'hash'> & { verification?: VerificationRecord }): boolean => !!r.verification && r.verification.hash === r.hash

/** The real effort class from what the verify build used, on the same scale as the estimate's defaults (#97). */
export function effortFromTokens(tokens: number): Effort {
  if (tokens < 80_000) return 'small'
  if (tokens < 200_000) return 'medium'
  return 'large'
}

// Rules whose flags mean the build did something the extension didn't declare; any of them fails a verify.
const CAPABILITY_RULES: DiffRule[] = ['dependency', 'install-script', 'network-host', 'protected-path', 'undeclared-area']

/** Whether a verify build passed: every acceptance check reported and passed, no test failed (the typecheck among
 *  them), the diff scan matches the declared capabilities (no block, no capability flag), and the tier's shape holds.
 *  Other diff-scan flags (network code, programs, and the like) are listed as notes, not failures. */
export function verifyOutcome(report: BuildReport, scan: DiffScanResult, checks: number, tier: 1 | 2 | 3): { pass: boolean; reasons: string[]; notes: string[] } {
  const reasons: string[] = []
  const notes: string[] = []
  for (let i = 1; i <= checks; i++) {
    const a = report.acceptance.find((x) => x.check === i)
    if (!a) reasons.push(`Acceptance check ${i} wasn't reported.`)
    else if (a.result !== 'pass') reasons.push(`Acceptance check ${i} ${a.result === 'fail' ? 'failed' : 'was not run'}${a.how ? `: ${a.how}` : '.'}`)
  }
  for (const t of report.tests) if (t.result === 'fail') reasons.push(`${t.name} failed${t.detail ? `: ${t.detail}` : '.'}`)
  if (!report.tests.some((t) => /typecheck|tsc/i.test(t.name) && t.result === 'pass')) reasons.push("The build report doesn't show a passing typecheck.")
  for (const f of scan.flags) {
    const where = `${f.file}${f.line ? `:${f.line}` : ''}`
    if (f.severity === 'block' || CAPABILITY_RULES.includes(f.rule)) reasons.push(`Differs from the declared capabilities: ${f.text} (${where}).`)
    else notes.push(`${f.text} (${where})`)
  }
  if (tier === 1 && !scan.tier1Shape && !scan.flags.some((f) => f.rule === 'undeclared-area')) reasons.push('It declares tier 1, but the build changed more than its own folder and registration lines.')
  if (!scan.files.length) reasons.push('The build changed no files.')
  return { pass: !reasons.length, reasons, notes }
}

/** The text to share: the record's canonical text with the verification block filled in and the author's effort
 *  guess replaced by what the verify build really took. The hash binding is to the record's text; this file's own
 *  hash is recorded with each share. */
export function sharedText(canonical: string, v: VerificationRecord): string {
  let t = canonical
  t = setHeaderField(t, 'effort', v.effort)
  t = setHeaderField(t, 'effort.minutes', String(Math.max(1, v.minutes)))
  t = setHeaderField(t, 'effort.files', String(v.files))
  t = setHeaderField(t, 'effort.model', v.model)
  t = setHeaderField(t, 'effort.checks', String(v.checks))
  t = setHeaderField(t, 'effort.cost', v.effort)
  t = setHeaderField(t, 'effort.tokens', String(v.tokens))
  t = setHeaderField(t, 'verified.commit', v.baseCommit.slice(0, 12))
  t = setHeaderField(t, 'verified.at', new Date(v.at).toISOString().slice(0, 10))
  t = setHeaderField(t, 'verified.by', `Corvid ${v.baseVersion} Verify`)
  return t
}

/** The final leak check before a share: local paths, names, hosts and keys (the wizard's leak scan, #100). The author
 *  field is left out: it is what the user chose. */
export function shareLeaks(text: string, ctx: LeakContext, declaredHosts: string[]): string[] {
  return leakFindings(setHeaderField(text, 'author', undefined), ctx, declaredHosts)
}

/** How an imported file's verification block reads: the author's claim, never Corvid's verification. */
export function claimText(h: { builtOn: { version: string; commit: string }; verified?: { commit: string; at: string; by?: string } }): string | null {
  const v = h.verified
  if (!v) return null
  const on = h.builtOn.commit.startsWith(v.commit) || v.commit.startsWith(h.builtOn.commit) ? `Corvid ${h.builtOn.version} (${v.commit.slice(0, 7)})` : `Corvid commit ${v.commit.slice(0, 7)}`
  return `The author says it was verified on ${on} at ${v.at}${v.by ? `, by ${v.by}` : ''}. This is a claim by the author: your Corvid still scans, estimates, builds and reviews it in full.`
}
