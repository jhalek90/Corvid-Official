import { CORE_AREAS, minimumTier, type ExtensionTier } from './extensionTiers'
import { compareVersions, SEMVER_RE, validateCorvid, type ParsedExtension } from './extensions'
import { fmtTokens, modelWeight, WINDOW_TOKENS } from './costEstimate'

// The packaging wizard (#100, Extensions 6/8): a chat that turns a feature the user built, or a new idea, into a
// .corvid draft. This file holds what the window and the main process share: the wizard's state, the outline, the
// checks Corvid runs on a draft itself (the validator from #95 plus a leak scan), and small text helpers. Nothing
// here installs, builds or shares anything; the wizard only ever produces text.

export type PackagerMode = 'built' | 'scratch' | 'edit'
export type PackagerStage = 'pick' | 'interview' | 'outline' | 'draft' | 'saved' | 'stopped'

/** A merged feature from the feature-branch workflow (#45): one merge commit on main and the task it came from. */
export interface MergedFeature {
  /** the merge commit, short */
  commit: string
  taskId?: number
  title: string
  /** milliseconds */
  date: number
  files: string[]
  /** minutes the task's agent worked, when known */
  minutes?: number
}

export interface PackagerOutline {
  name: string
  purpose: string
  behaviours: string[]
  tier: ExtensionTier
  coreAreas: string[]
  packages: string[]
  hosts: string[]
  data?: string
  requires: string[]
  checks: string[]
}

export interface PackagerMessage {
  id: number
  from: 'agent' | 'user' | 'corvid'
  text: string
  at: number
  /** quick-reply buttons under an agent message */
  quick?: string[]
  outline?: PackagerOutline
  /** a full draft the agent proposed, with Corvid's own checks on it */
  draft?: { text: string; problems: string[] }
}

/** What Corvid found in the source diff, so the declared capabilities rest on evidence (the user can correct it). */
export interface DerivedCapabilities {
  tier: ExtensionTier
  coreAreas: string[]
  packages: string[]
  hosts: string[]
  files: number
  protectedFiles: string[]
}

export interface PackagerState {
  /** one wizard at a time; null when none is open */
  open: boolean
  mode?: PackagerMode
  stage: PackagerStage
  busy: boolean
  /** the agent's name on the Agents page */
  agentName: string
  messages: PackagerMessage[]
  features?: MergedFeature[]
  picked?: string[]
  derived?: DerivedCapabilities
  /** the latest draft that passed every check, ready to save */
  ready?: string
  /** editing: the record being revised and its text, for the diff */
  editing?: { key: string; id: string; version: string; text: string }
  author: string
  error?: string
  startedAt?: number
  /** model turns so far, for the planning cap */
  turns: number
  /** shown before a session starts */
  estimate?: string
}

export const PACKAGER_AGENT_NAME = 'Packaging agent'
/** the planning phase is short: after this many exchanges the agent is told to write the draft */
export const PLANNING_TURNS = 5
/** a hard stop on model turns per wizard session */
export const MAX_TURNS = 14
/** the rough fixed estimate, shown only until the main process has made its own with the cost engine (#97) */
export const ROUGH_ESTIMATE = 'about as much as a small task: a few short model turns, usually 1 to 3% of a 5-hour window'

/** Output tokens of a typical wizard session (a few chat turns and one or two drafts), in the terms of the cost
 *  engine from Extensions 3/8 (#97): its window sizes and model weights. */
export const SESSION_TOKENS = { low: 4_000, likely: 9_000, high: 20_000 }

export function packagerEstimate(model: string, fiveHourNow?: number): string {
  const w = modelWeight(model)
  const pct = (n: number): string => ((n * w * 100) / WINDOW_TOKENS.fiveHour).toFixed(1)
  const t = SESSION_TOKENS
  return `about ${fmtTokens(t.likely)} output tokens (${fmtTokens(t.low)} to ${fmtTokens(t.high)}), roughly ${pct(t.likely)}% of a 5-hour window${fiveHourNow === undefined ? '' : `, which is at ${Math.round(fiveHourNow)}% now`}`
}

export const emptyPackager = (author = 'user'): PackagerState => ({ open: false, stage: 'pick', busy: false, agentName: PACKAGER_AGENT_NAME, messages: [], author, turns: 0 })

// ---------- leaks: author-specific details that must never reach the output ----------

export interface LeakContext {
  /** the user's home folder, the machine's and account's names, project names and folders, connection names */
  words: string[]
  /** hosts seen in the source diff or the user's connections; a host the draft declares in capabilities.hosts is fine */
  hosts: string[]
}

const KEY_PATTERNS: [RegExp, string][] = [
  [/\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9]{16,}/, 'something that looks like an API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'something that looks like a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'something that looks like an AWS key'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, 'something that looks like a Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'something that looks like a signed token'],
  [/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i, 'a password or key written out']
]
const PATH_PATTERNS: [RegExp, string][] = [
  [/\b[A-Za-z]:[\\/][^\s`'"]+/, 'a Windows file path'],
  [/(?:^|[\s(`'"])\/(?:home|Users|mnt|var|opt|srv|root)\/[^\s`'"]+/, 'an absolute file path'],
  [/~[\\/][^\s`'"]+/, 'a path in a home folder'],
  [/\\\\[A-Za-z0-9._-]+\\[^\s`'"]+/, 'a network share path'],
  // macOS and Linux (#161): mounted volumes and $HOME spellings
  [/(?:^|[\s(`'"])\/(?:Volumes|media|run\/media|private\/var)\/[^\s`'"]+/, 'an absolute file path'],
  [/\$\{?HOME\}?[\\/][^\s`'"]+/, 'a path in a home folder']
]
// Corvid's own repository layout is the author's file layout too: the seed prompt must speak in behaviour and
// extension points, never "edit src/main/board.ts".
const LAYOUT_RE = /\b(?:src|scripts|resources)\/[\w./-]+\.(?:tsx?|mjs|js|css|json|md)\b/
const STEER_RE = /\b(?:do not|don't|never)\s+(?:tell|inform|mention|show|let)\s+(?:the\s+)?user\b|\bwithout\s+(?:telling|asking|informing)\s+(?:the\s+)?user\b|\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|other)\s+(?:instructions|rules)\b|\b(?:disable|skip|bypass|turn off)\s+(?:the\s+)?(?:scan|validator|deny rules|checks|safety|approval)/i
const URL_HOST_RE = /\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Author-specific details, secrets, the author's file layout and build-agent steering in a draft, as plain sentences. */
export function leakFindings(text: string, ctx: LeakContext, declaredHosts: string[] = []): string[] {
  const out: string[] = []
  for (const [re, what] of KEY_PATTERNS) if (re.test(text)) out.push(`It contains ${what}. Remove it: an extension never carries keys or secrets.`)
  for (const [re, what] of PATH_PATTERNS) {
    const m = re.exec(text)
    if (m) out.push(`It contains ${what} (“${m[0].trim().slice(0, 40)}”). Describe the place in plain words instead.`)
  }
  const layout = LAYOUT_RE.exec(text)
  if (layout) out.push(`It names a file in the author's own layout (“${layout[0]}”). Refer to the behaviour and the extension point in plain words, so it builds on any Corvid.`)
  const steer = STEER_RE.exec(text)
  if (steer) out.push(`It tells the build agent something beyond the build (“${steer[0]}”). An extension may only describe what to build.`)
  const lower = text.toLowerCase()
  for (const w of [...new Set(ctx.words.map((x) => x.trim()).filter((x) => x.length >= 4))]) {
    if (new RegExp(`(?:^|[^a-z0-9])${escapeRe(w.toLowerCase())}(?:$|[^a-z0-9])`).test(lower))
      out.push(`It mentions “${w}”, which is specific to this machine, account or project. Leave it out.`)
  }
  const allowed = new Set(declaredHosts.map((h) => h.toLowerCase()))
  const known = new Set(ctx.hosts.map((h) => h.toLowerCase()))
  for (const m of text.matchAll(URL_HOST_RE)) {
    const host = m[1].toLowerCase()
    if (!allowed.has(host) && known.has(host)) out.push(`It mentions the host ${host}, one of the author's own. Leave it out, or declare it in capabilities.hosts if the extension really needs it.`)
  }
  for (const h of known) if (!allowed.has(h) && lower.includes(h) && !out.some((o) => o.includes(h))) out.push(`It mentions the host ${h}, one of the author's own. Leave it out.`)
  return [...new Set(out)]
}

/** Every check Corvid runs on a draft itself: the validator from #95, the leak scan, and the tier against what the
 *  source diff touched. `extraScan` is the hook for the text scan from Extensions 2/8 (#96) once it lands. */
export function checkDraft(
  text: string,
  ctx: LeakContext,
  derived?: DerivedCapabilities,
  extraScan?: (ext: ParsedExtension) => string[]
): { ok: true; ext: ParsedExtension; problems: string[] } | { ok: false; problems: string[] } {
  const v = validateCorvid(text)
  if (!v.ok) return { ok: false, problems: v.errors.map((e) => `Validator: ${e}`) }
  const h = v.ext.header
  // the author line is the display name the user chose for sharing, so it is the one place their name belongs
  const problems = leakFindings(v.ext.canonical.replace(/^author:.*$/m, ''), ctx, h.capabilities.hosts)
  if (derived && h.capabilities.tier < derived.tier)
    problems.push(`The source diff touched ${derived.tier === 3 ? 'protected core' : 'core'}, so the tier must be at least ${derived.tier}; the draft says ${h.capabilities.tier}.`)
  if (extraScan) problems.push(...extraScan(v.ext))
  return problems.length ? { ok: false, problems } : { ok: true, ext: v.ext, problems }
}

// ---------- capabilities from the source diff ----------

const areaOfPath = (p: string): string | undefined => {
  const path = p.replace(/\\/g, '/')
  // the most specific area wins (secrets sits inside connectors and remote)
  let best: { id: string; len: number } | undefined
  for (const a of CORE_AREAS)
    for (const q of a.paths) {
      const hit = q.endsWith('/') ? path.startsWith(q) : path === q
      if (hit && (!best || q.length > best.len)) best = { id: a.id, len: q.length }
    }
  return best?.id
}

/**
 * Capabilities derived from a diff: the core areas its files fall in, new packages from package.json, and hosts in
 * added lines. A stand-in for the diff scanner from Extensions 4/8 (#98), which replaces it when it lands.
 * `files` are the paths touched, `added` the added lines of the diff (never stored, never sent anywhere).
 */
export function deriveCapabilities(files: string[], added: string[], packageAdds: string[] = []): DerivedCapabilities {
  const areas = new Set<string>()
  const protectedFiles: string[] = []
  for (const f of files) {
    const a = areaOfPath(f)
    if (!a) continue
    areas.add(a)
    if (CORE_AREAS.find((x) => x.id === a)?.protected) protectedFiles.push(f)
  }
  // a new file that only registers itself is tier 1; we can't tell that apart from a diff alone, so be honest
  const coreAreas = CORE_AREAS.map((a) => a.id).filter((id) => areas.has(id))
  const hosts = new Set<string>()
  for (const line of added) for (const m of line.matchAll(URL_HOST_RE)) if (!/^(?:localhost|127\.|example\.)/.test(m[1])) hosts.add(m[1].toLowerCase())
  return { tier: minimumTier(coreAreas), coreAreas, packages: packageAdds, hosts: [...hosts].slice(0, 20), files: files.length, protectedFiles }
}

// ---------- header helpers ----------

/** Sets (or adds) one header field; the canonical form puts it in its place, so where it goes doesn't matter. */
export function setHeaderField(text: string, key: string, value: string | undefined): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return text
  const end = lines.indexOf('---', 1)
  if (end < 0) return text
  const at = lines.findIndex((l, i) => i > 0 && i < end && l.startsWith(`${key}:`))
  if (value === undefined || value === '') {
    if (at >= 0) lines.splice(at, 1)
  } else if (at >= 0) lines[at] = `${key}: ${value}`
  else lines.splice(end, 0, `${key}: ${value}`)
  return lines.join('\n')
}

export const headerField = (text: string, key: string): string | undefined => {
  const m = new RegExp(`^${escapeRe(key)}:[ \\t]*(.*)$`, 'm').exec(text.split(/\n---\s*\n/)[0] ?? '')
  return m?.[1].trim() || undefined
}

/** The next version when repackaging: a minor bump. */
export function bumpVersion(v: string): string {
  if (!SEMVER_RE.test(v)) return '1.0.0'
  const [maj, min] = v.split(/[-+]/)[0].split('.').map(Number)
  return `${maj}.${min + 1}.0`
}

/** At least `min`: a bumped version is never older than the one it revises. */
export const atLeast = (v: string, min: string): string => (SEMVER_RE.test(v) && compareVersions(v, min) > 0 ? v : bumpVersion(min))

/** A slug for a name, made unique against the ids already in the ledger. */
export function uniqueId(base: string, taken: string[]): string {
  let slug = base.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'my-extension'
  if (slug.length < 3) slug = `${slug}-ext`
  const set = new Set(taken)
  if (!set.has(slug)) return slug
  for (let i = 2; ; i++) if (!set.has(`${slug}-${i}`)) return `${slug}-${i}`
}

// ---------- a line diff of two texts, for Edit ----------

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/** A plain longest-common-subsequence line diff; .corvid files are small (64 KB at most). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n'), y = b.split('\n')
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ kind: 'del' as const, text: t })), ...y.map((t) => ({ kind: 'add' as const, text: t }))]
  const n = x.length, m = y.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ kind: 'same', text: x[i] }), i++, j++)
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: x[i++] })
    else out.push({ kind: 'add', text: y[j++] })
  }
  while (i < n) out.push({ kind: 'del', text: x[i++] })
  while (j < m) out.push({ kind: 'add', text: y[j++] })
  return out
}

/** The agent's reply, which the instructions ask to be one JSON object; anything else is shown as plain text. */
export interface AgentReply {
  say: string
  quick?: string[]
  outline?: PackagerOutline
  draft?: string
}

export function parseAgentReply(raw: string): AgentReply {
  const s = raw.trim()
  const start = s.indexOf('{'), end = s.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>
      const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 400)) : [])
      let outline: PackagerOutline | undefined
      const o = j.outline as Record<string, unknown> | undefined
      if (o && typeof o === 'object' && typeof o.name === 'string') {
        const tier = Number(o.tier)
        outline = {
          name: String(o.name).slice(0, 60),
          purpose: String(o.purpose ?? '').slice(0, 200),
          behaviours: strs(o.behaviours).slice(0, 12),
          tier: tier === 1 || tier === 2 || tier === 3 ? tier : 2,
          coreAreas: strs(o.coreAreas),
          packages: strs(o.packages),
          hosts: strs(o.hosts),
          data: typeof o.data === 'string' ? o.data.slice(0, 300) : undefined,
          requires: strs(o.requires),
          checks: strs(o.checks).slice(0, 20)
        }
      }
      return {
        say: typeof j.say === 'string' ? j.say.slice(0, 4000) : '',
        quick: strs(j.quick).slice(0, 5),
        outline,
        draft: typeof j.draft === 'string' && j.draft.trim() ? j.draft : undefined
      }
    } catch {
      /* not JSON after all */
    }
  }
  return { say: s.slice(0, 4000) }
}
