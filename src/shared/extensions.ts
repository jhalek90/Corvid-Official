import { CORE_AREAS, minimumTier, type ExtensionTier } from './extensionTiers'
import type { ScanState } from './extensionScan'
import type { CostEstimate } from './costEstimate'
import type { LifecycleRecord } from './extensionLifecycle'
import type { DiffScanResult } from './extensionDiffScan'
import type { BuildProgressLog } from './buildProgress'
import type { ShareRecord, VerificationRecord, VerifyRun } from './extensionVerify'

// The .corvid extension format (#95), described in docs/EXTENSIONS.md. A .corvid file is TEXT ONLY: a header of
// "key: value" lines between two "---" lines, then fixed "## " sections. It is never executed. This parser is
// line based and strict: no YAML, no tags, anchors, includes or evaluation of any kind; unknown or repeated header
// keys are refused. validateCorvid() is the one gate every import goes through, and its errors are plain words.

export const FORMAT_VERSION = 1
/** Files over this many bytes are refused before anything else is looked at. */
export const MAX_BYTES = 64 * 1024
/** Fenced code: a few short snippets (a schema, a regular expression, a config shape) and no more. */
export const CODE_LIMITS = { blocks: 3, linesPerBlock: 15, charsPerBlock: 800, totalChars: 1500 }

export type Effort = 'small' | 'medium' | 'large'
export const EFFORT_WORDS: Record<Effort, string> = { small: 'Small', medium: 'Medium', large: 'Large' }

export interface ExtensionHeader {
  format: number
  id: string
  name: string
  version: string
  author?: string
  description: string
  builtOn: { version: string; commit: string }
  worksWith?: string
  effort: {
    class: Effort
    /** what the author's own build took: a claim, not a measurement here */
    observed: { minutes?: number; files?: number; model?: string; checks?: number; cost?: Effort; tokens?: number }
  }
  requires: { id: string; range: string }[]
  conflicts: string[]
  capabilities: {
    tier: ExtensionTier
    packages: { name: string; version: string }[]
    hosts: string[]
    data?: string
    coreAreas: string[]
    rebuild: boolean
  }
  /** the author's claim that a build passed the acceptance checks; proof comes from Verify (#101) */
  verified?: { commit: string; at: string; by?: string }
}

export interface ExtensionSections {
  summary: string
  whatItDoes: string
  seedPrompt: string
  /** the numbered acceptance checks, without their numbers */
  checks: string[]
  notes?: string
}

export interface ParsedExtension {
  header: ExtensionHeader
  sections: ExtensionSections
  /** the canonical text: what is stored and what the hash is taken over */
  canonical: string
}

export type ValidationResult = { ok: true; ext: ParsedExtension } | { ok: false; errors: string[] }

// ---------- header keys, in canonical order ----------

type KeyKind = 'required' | 'optional'
const KEYS: [string, KeyKind][] = [
  ['format', 'required'],
  ['id', 'required'],
  ['name', 'required'],
  ['version', 'required'],
  ['author', 'optional'],
  ['description', 'required'],
  ['built_on', 'required'],
  ['works_with', 'optional'],
  ['effort', 'required'],
  ['effort.minutes', 'optional'],
  ['effort.files', 'optional'],
  ['effort.model', 'optional'],
  ['effort.checks', 'optional'],
  ['effort.cost', 'optional'],
  ['effort.tokens', 'optional'],
  ['requires', 'optional'],
  ['conflicts', 'optional'],
  ['capabilities.tier', 'required'],
  ['capabilities.packages', 'optional'],
  ['capabilities.hosts', 'optional'],
  ['capabilities.data', 'optional'],
  ['capabilities.core_areas', 'optional'],
  ['capabilities.rebuild', 'required'],
  ['verified.commit', 'optional'],
  ['verified.at', 'optional'],
  ['verified.by', 'optional']
]
export const HEADER_KEYS = KEYS.map(([k]) => k)

const SECTIONS = [
  ['Summary', 'summary', true],
  ['What it does', 'whatItDoes', true],
  ['Seed prompt', 'seedPrompt', true],
  ['Acceptance checks', 'checks', true],
  ['Notes', 'notes', false]
] as const

// ---------- small grammars ----------

export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NUM = '(?:0|[1-9]\\d*)'
const PRE = '(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?'
export const SEMVER_RE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}${PRE}$`)
const COMPARATOR_RE = new RegExp(`^(?:\\*|(?:>=|<=|>|<|=|\\^|~)?${NUM}\\.${NUM}\\.${NUM}${PRE})$`)
const COMMIT_RE = /^[0-9a-f]{7,40}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$/
const HOST_RE = /^(?=.{1,253}$)(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$/

/** A version range: comparators separated by spaces (all must hold), e.g. ">=0.1.0 <0.2.0", "^1.2.0" or "*". */
export const isRange = (s: string): boolean => s.length <= 80 && s.split(/\s+/).every((c) => COMPARATOR_RE.test(c))

/** Compares two semver versions; prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string[]] => {
    const [core, pre] = v.split('+')[0].split(/-(.*)/s)
    return [core.split('.').map(Number), pre ? pre.split('.') : []]
  }
  const [ca, pa] = split(a)
  const [cb, pb] = split(b)
  for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return ca[i] - cb[i]
  if (!pa.length || !pb.length) return pb.length - pa.length
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1
    if (pb[i] === undefined) return 1
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i])
    if (na && nb && +pa[i] !== +pb[i]) return +pa[i] - +pb[i]
    if (na !== nb) return na ? -1 : 1
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

// ---------- the text-only rules ----------

const hex = (c: number): string => 'U+' + c.toString(16).toUpperCase().padStart(4, '0')

/** Characters that hide or reorder text: zero-width, bidirectional controls, tags, odd separators, private use. */
function hiddenKind(c: number): string | null {
  if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0x2060 || c === 0xfeff || c === 0x180e || c === 0x034f || c === 0x00ad || (c >= 0x2061 && c <= 0x2064))
    return 'an invisible (zero-width) character'
  if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f || c === 0x061c) return 'a bidirectional text control'
  if (c >= 0xe0000 && c <= 0xe007f) return 'an invisible tag character'
  if ((c >= 0xfe00 && c <= 0xfe0e) || (c >= 0xe0100 && c <= 0xe01ef)) return 'a variation selector'
  if (c === 0x2028 || c === 0x2029) return 'a Unicode line separator'
  if ((c >= 0x2000 && c <= 0x200a) || c === 0x3000 || c === 0x205f || c === 0x1680) return 'an unusual space character'
  if ((c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000) return 'a private-use character'
  if ((c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) === 0xfffe) return 'a Unicode non-character'
  if (c === 0xfffd) return 'a replacement character (the file was damaged or not really text)'
  return null
}

/** Look-alike tricks in a short identifying string: mixed scripts, compatibility forms (fullwidth, maths letters). */
function lookAlike(s: string): string | null {
  if (s.normalize('NFKC') !== s) return 'uses look-alike or compatibility characters (fullwidth or styled letters)'
  const scripts = new Set<string>()
  for (const ch of s) {
    if (!/\p{L}/u.test(ch)) continue
    for (const sc of ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Cherokee', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Arabic', 'Hebrew', 'Devanagari', 'Thai'])
      if (new RegExp(`\\p{Script=${sc}}`, 'u').test(ch)) scripts.add(sc)
  }
  // Japanese mixes Han and kana by design; anything else mixing scripts can pass for another name
  const cjk = ['Han', 'Hiragana', 'Katakana']
  const rest = [...scripts].filter((x) => !cjk.includes(x))
  if (rest.length > 1 || (rest.length === 1 && rest[0] !== 'Latin' && scripts.size > rest.length) || (rest.includes('Latin') && scripts.size > 1))
    return `mixes letters from different scripts (${[...scripts].join(', ')}), which can make it pass for another name`
  return null
}

const HTML_RE =
  /<\/?(?:script|iframe|object|embed|style|svg|img|a|link|meta|form|input|button|textarea|select|html|body|head|div|span|p|br|hr|table|tr|td|video|audio|source|base|frame|frameset|template|math|details|dialog|marquee|applet)\b[^>]*>|<!--|<!\[CDATA\[|<\?(?:php|xml)?|<%|\b(?:javascript|vbscript|livescript):|\bdata:[a-z]+\/[a-z0-9.+-]+[;,]|\bon[a-z]{3,}\s*=\s*["']/i

const DIFF_LINE_RES: [RegExp, string][] = [
  [/^diff --git /, 'a "diff --git" line'],
  [/^diff -[a-zA-Z]+ /, 'a diff command line'],
  [/^(?:---|\+\+\+) (?:a\/|b\/|\/dev\/null|\S+\t)/, 'a patch file header ("--- a/" or "+++ b/")'],
  [/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, 'a unified diff hunk ("@@ -1,4 +1,6 @@")'],
  [/^index [0-9a-f]{7,40}\.\.[0-9a-f]{7,40}/, 'a git index line'],
  [/^(?:new|deleted) file mode \d+/, 'a git file-mode line'],
  [/^GIT binary patch/, 'a git binary patch'],
  [/^From [0-9a-f]{40} /, 'a git format-patch header'],
  [/^Index: \S/, 'an svn patch header'],
  [/^\*\*\* \S+.*\n?$/, ''],
  [/^\*\*\*\*\*\*\*\*\*\*\*\*\*\*\*$/, 'a context diff separator']
]

/** Lines that read like source code, outside fences: a lot of them is a patch in disguise. */
const CODE_LINE_RE =
  /^\s*(?:import\s+[\w{*].*\bfrom\b|export\s+(?:default|const|function|class|interface|type)\b|(?:const|let|var)\s+\w+\s*=|function\s+\w+\s*\(|class\s+\w+|return\b.*;$|if\s*\(.*\)\s*\{|for\s*\(.*\)\s*\{|\}\s*(?:else\b.*)?\{?$|.*\)\s*=>\s*\{?$|.*;\s*$|def\s+\w+\(|#include\b|require\(['"])/

function textRules(text: string): string[] {
  const errors: string[] = []
  // characters, by code point; each kind reported once with its line
  const seen = new Set<string>()
  let line = 1
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 0x0a) line++
    let kind: string | null = null
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || (c >= 0x80 && c <= 0x9f)) kind = 'a control character'
    else if (c === 0x0d) kind = null
    else kind = hiddenKind(c)
    if (kind && !seen.has(kind)) {
      seen.add(kind)
      errors.push(`Line ${line} contains ${kind} (${hex(c)}). A .corvid file must be plain visible text.`)
    }
  }
  if (/\r(?!\n)/.test(text)) errors.push('The file uses lone carriage returns. Save it with ordinary line endings.')

  const lines = text.split(/\r?\n/)
  const html = lines.findIndex((l) => HTML_RE.test(l))
  if (html >= 0) errors.push(`Line ${html + 1} contains HTML or script content. A .corvid file is plain text: describe behaviour in words instead.`)

  // encoded blobs
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const b64 = /[A-Za-z0-9+/]{80,}={0,2}|[A-Za-z0-9_-]{80,}/.exec(l)
    if (b64 && /\d/.test(b64[0]) && /[a-z]/.test(b64[0]) && /[A-Z]/.test(b64[0])) {
      errors.push(`Line ${i + 1} contains a long encoded run (looks like base64). Encoded data is not allowed in a .corvid file.`)
      break
    }
    if (/[0-9a-fA-F]{65,}/.test(l)) {
      errors.push(`Line ${i + 1} contains a long run of hex digits. Encoded data is not allowed in a .corvid file.`)
      break
    }
    if (/(?:\\x[0-9a-fA-F]{2}){12,}|(?:\\u[0-9a-fA-F]{4}){8,}|(?:%[0-9a-fA-F]{2}){12,}|(?:&#x?[0-9a-fA-F]+;){8,}/.test(l)) {
      errors.push(`Line ${i + 1} contains a run of escaped bytes. Encoded data is not allowed in a .corvid file.`)
      break
    }
  }

  // patches and diffs
  let diff: string | null = null
  let plusRun = 0
  for (let i = 0; i < lines.length && !diff; i++) {
    for (const [re, what] of DIFF_LINE_RES)
      if (what && re.test(lines[i])) {
        diff = `Line ${i + 1} looks like part of a patch (${what}).`
        break
      }
    plusRun = /^\+(?!\+\+ )(?! \S)/.test(lines[i]) ? plusRun + 1 : 0
    if (plusRun >= 5) diff = `Lines ${i - 3} to ${i + 1} look like added lines from a diff.`
  }
  if (diff) errors.push(`${diff} Extensions never ship patches or code: describe the feature and let the seed prompt build it.`)
  return errors
}

/** Fenced code blocks and code-like prose: a few short snippets are fine, more is a patch in another form. */
function codeRules(body: string, firstLine: number): string[] {
  const errors: string[] = []
  const lines = body.split('\n')
  const blocks: { start: number; lines: string[] }[] = []
  let open: { fence: string; start: number; lines: string[] } | null = null
  let codeish = 0
  let indented = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l)
    if (open) {
      if (f && f[1][0] === open.fence[0] && f[1].length >= open.fence.length && l.trim() === f[1]) {
        blocks.push(open)
        open = null
      } else open.lines.push(l)
      continue
    }
    if (f) {
      open = { fence: f[1], start: firstLine + i, lines: [] }
      continue
    }
    if (CODE_LINE_RE.test(l)) codeish++
    if (/^(?: {4}|\t)\S/.test(l) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(l)) indented++
  }
  if (open) errors.push(`The code block that starts on line ${open.start} is never closed.`)
  const n = CODE_LIMITS
  if (blocks.length > n.blocks) errors.push(`The file has ${blocks.length} code blocks; at most ${n.blocks} short snippets are allowed.`)
  for (const b of blocks) {
    const chars = b.lines.join('\n').length
    if (b.lines.length > n.linesPerBlock || chars > n.charsPerBlock)
      errors.push(`The code block on line ${b.start} is too long (${b.lines.length} lines, ${chars} characters; the limit is ${n.linesPerBlock} lines and ${n.charsPerBlock} characters).`)
  }
  const total = blocks.reduce((s, b) => s + b.lines.join('\n').length, 0)
  if (total > n.totalChars) errors.push(`The code blocks add up to ${total} characters; the limit is ${n.totalChars}.`)
  if (codeish > 12) errors.push(`${codeish} lines outside code blocks read like source code. Describe the behaviour in words instead.`)
  if (indented > 15) errors.push(`${indented} lines are indented like code. Describe the behaviour in words instead.`)
  return errors
}

// ---------- header ----------

const list = (v: string): string[] => (v.trim() ? v.split(',').map((s) => s.trim()) : [])
const int = (v: string): number | null => (/^(?:0|[1-9]\d{0,8})$/.test(v) ? Number(v) : null)

function parseHeader(lines: string[], firstLine: number, errors: string[]): ExtensionHeader | null {
  const before = errors.length
  const raw = new Map<string, string>()
  lines.forEach((l, i) => {
    const at = `Header line ${firstLine + i}`
    if (!l.trim() || /^#/.test(l.trim())) return
    const m = /^([a-z_]+(?:\.[a-z_]+)?):(?:\s(.*))?$/.exec(l)
    if (!m) return void errors.push(`${at} isn't "key: value". Each header line is one key, a colon, a space and its value.`)
    const [, key, value = ''] = m
    if (!HEADER_KEYS.includes(key)) return void errors.push(`${at}: "${key}" is not a known header field. Unknown fields are not allowed (see docs/EXTENSIONS.md).`)
    if (raw.has(key)) return void errors.push(`${at}: "${key}" appears more than once.`)
    if (value.length > 300) return void errors.push(`${at}: the value of "${key}" is longer than 300 characters.`)
    raw.set(key, value.trim())
  })
  for (const [k, kind] of KEYS) if (kind === 'required' && !raw.get(k)) errors.push(`The header is missing "${k}".`)
  const get = (k: string): string => raw.get(k) ?? ''

  if (raw.has('format') && get('format') !== String(FORMAT_VERSION))
    errors.push(`"format" is ${get('format')}, but this Corvid reads format ${FORMAT_VERSION}.`)
  const id = get('id')
  if (id && (!ID_RE.test(id) || id.length < 3 || id.length > 64))
    errors.push(`"id" must be 3 to 64 lowercase letters, digits and single hyphens (like "board-reactions"); "${id}" isn't.`)
  const name = get('name')
  if (name.length > 60) errors.push('"name" is longer than 60 characters.')
  const nameTrick = name && lookAlike(name)
  if (nameTrick) errors.push(`"name" ${nameTrick}.`)
  const version = get('version')
  if (version && !SEMVER_RE.test(version)) errors.push(`"version" must be a version like 1.2.0; "${version}" isn't.`)
  const author = get('author')
  if (author.length > 60) errors.push('"author" is longer than 60 characters.')
  const authorTrick = author && lookAlike(author)
  if (authorTrick) errors.push(`"author" ${authorTrick}.`)
  if (get('description').length > 160) errors.push('"description" must be one line of at most 160 characters.')

  const builtOn = /^(\S+)\s+@\s+(\S+)$/.exec(get('built_on'))
  if (raw.has('built_on') && (!builtOn || !SEMVER_RE.test(builtOn[1]) || !COMMIT_RE.test(builtOn[2])))
    errors.push('"built_on" must be the Corvid version and commit, like "0.1.0 @ 15be862".')
  if (raw.get('works_with') && !isRange(get('works_with'))) errors.push(`"works_with" isn't a version range (like ">=0.1.0 <0.2.0" or "^0.1.0").`)

  const effortClass = (k: string): Effort | null => (['small', 'medium', 'large'].includes(get(k)) ? (get(k) as Effort) : null)
  if (raw.get('effort') && !effortClass('effort')) errors.push('"effort" must be small, medium or large.')
  if (raw.get('effort.cost') && !effortClass('effort.cost')) errors.push('"effort.cost" must be small, medium or large.')
  for (const k of ['effort.minutes', 'effort.files', 'effort.checks', 'effort.tokens'])
    if (raw.get(k) && int(get(k)) === null) errors.push(`"${k}" must be a whole number.`)
  if (raw.get('effort.model') && !MODEL_RE.test(get('effort.model'))) errors.push('"effort.model" must be a model name like claude-opus-5-5.')

  const requires: { id: string; range: string }[] = []
  for (const r of list(get('requires'))) {
    const m = /^([a-z0-9-]+)(?:\s+(.+))?$/.exec(r)
    if (!m || !ID_RE.test(m[1]) || (m[2] && !isRange(m[2]))) errors.push(`"requires" entry "${r}" must be an extension id and an optional version range, like "board-reactions ^1.0.0".`)
    else requires.push({ id: m[1], range: m[2] ?? '*' })
  }
  const conflicts = list(get('conflicts'))
  for (const c of conflicts) if (!ID_RE.test(c)) errors.push(`"conflicts" entry "${c}" isn't an extension id.`)
  if (id && (requires.some((r) => r.id === id) || conflicts.includes(id))) errors.push('An extension can\'t require or conflict with itself.')

  const tier = get('capabilities.tier')
  if (tier && !['1', '2', '3'].includes(tier)) errors.push('"capabilities.tier" must be 1, 2 or 3.')
  const packages: { name: string; version: string }[] = []
  for (const p of list(get('capabilities.packages'))) {
    const m = /^(@?[^@\s]+)@(\S+)$/.exec(p)
    if (!m || !NPM_NAME_RE.test(m[1]) || m[1].length > 214 || !(SEMVER_RE.test(m[2]) || isRange(m[2])))
      errors.push(`"capabilities.packages" entry "${p}" must be an npm package name and version, like "date-fns@4.1.0".`)
    else packages.push({ name: m[1], version: m[2] })
  }
  const hosts = list(get('capabilities.hosts'))
  for (const h of hosts) if (!HOST_RE.test(h)) errors.push(`"capabilities.hosts" entry "${h}" must be a host name only, like "api.example.com" (no scheme, port or path).`)
  const coreAreas = list(get('capabilities.core_areas'))
  for (const a of coreAreas)
    if (!CORE_AREAS.some((c) => c.id === a)) errors.push(`"capabilities.core_areas" entry "${a}" isn't a known area. The areas are: ${CORE_AREAS.map((c) => c.id).join(', ')}.`)
  if (tier && coreAreas.every((a) => CORE_AREAS.some((c) => c.id === a))) {
    const need = minimumTier(coreAreas)
    if (Number(tier) < need) errors.push(`"capabilities.tier" is ${tier}, but the core areas it changes make it at least tier ${need}.`)
  }
  const rebuild = get('capabilities.rebuild')
  if (rebuild && !['yes', 'no'].includes(rebuild)) errors.push('"capabilities.rebuild" must be yes or no.')

  const vc = get('verified.commit'), va = get('verified.at')
  if ((vc || va || raw.get('verified.by')) && !(vc && va)) errors.push('A verification needs both "verified.commit" and "verified.at".')
  if (vc && !COMMIT_RE.test(vc)) errors.push('"verified.commit" must be a git commit hash.')
  if (va && !DATE_RE.test(va)) errors.push('"verified.at" must be a date like 2026-10-21.')

  if (errors.length !== before) return null
  const opt = <T,>(v: T | null | undefined | ''): T | undefined => (v === '' || v === null ? undefined : v)
  const observed: ExtensionHeader['effort']['observed'] = {}
  if (raw.get('effort.minutes')) observed.minutes = int(get('effort.minutes'))!
  if (raw.get('effort.files')) observed.files = int(get('effort.files'))!
  if (raw.get('effort.model')) observed.model = get('effort.model')
  if (raw.get('effort.checks')) observed.checks = int(get('effort.checks'))!
  if (raw.get('effort.cost')) observed.cost = effortClass('effort.cost')!
  if (raw.get('effort.tokens')) observed.tokens = int(get('effort.tokens'))!
  return {
    format: FORMAT_VERSION,
    id,
    name,
    version,
    author: opt(author),
    description: get('description'),
    builtOn: { version: builtOn![1], commit: builtOn![2] },
    worksWith: opt(get('works_with')),
    effort: { class: effortClass('effort')!, observed },
    requires,
    conflicts,
    capabilities: {
      tier: Number(tier) as ExtensionTier,
      packages,
      hosts,
      data: opt(get('capabilities.data')),
      coreAreas,
      rebuild: rebuild === 'yes'
    },
    verified: vc ? { commit: vc, at: va, by: opt(get('verified.by')) } : undefined
  }
}

// ---------- the whole file ----------

/** Decodes bytes as strict UTF-8 (a leading byte-order mark is dropped). Refuses binary content. */
export function decodeText(bytes: Uint8Array): { text: string } | { error: string } {
  if (bytes.length > MAX_BYTES) return { error: `The file is ${Math.ceil(bytes.length / 1024)} KB; a .corvid file can be at most ${MAX_BYTES / 1024} KB.` }
  if (bytes.includes(0)) return { error: 'The file contains binary data (zero bytes). A .corvid file must be plain UTF-8 text.' }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    return { text }
  } catch {
    return { error: "The file isn't valid UTF-8 text. It may be binary, or saved in another encoding: save it as UTF-8." }
  }
}

/**
 * Validates a .corvid file and returns its parsed form and canonical text, or every problem found, in plain words.
 * Pure and synchronous: it reads the text and nothing else, and nothing in it is ever evaluated.
 */
export function validateCorvid(input: Uint8Array | string): ValidationResult {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const decoded = decodeText(bytes)
  if ('error' in decoded) return { ok: false, errors: [decoded.error] }
  const text = decoded.text
  if (!text.trim()) return { ok: false, errors: ['The file is empty.'] }

  const errors = textRules(text)
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (lines[i] !== '---') {
    errors.push('A .corvid file starts with a header between two "---" lines. This one doesn\'t start with "---".')
    return { ok: false, errors }
  }
  const end = lines.indexOf('---', i + 1)
  if (end < 0) {
    errors.push('The header is never closed: add a "---" line after the last header field.')
    return { ok: false, errors }
  }
  const header = parseHeader(lines.slice(i + 1, end), i + 2, errors)

  // sections: "## Name" lines, each once, in the order of SECTIONS
  const found = new Map<string, { start: number; body: string[] }>()
  let current: { start: number; body: string[] } | null = null
  const order: string[] = []
  for (let j = end + 1; j < lines.length; j++) {
    const h = /^##\s+(.+?)\s*$/.exec(lines[j])
    if (h && !/^###/.test(lines[j])) {
      const title = h[1]
      const known = SECTIONS.find(([t]) => t.toLowerCase() === title.toLowerCase())
      if (!known) {
        errors.push(`Line ${j + 1}: "## ${title}" isn't a known section. The sections are: ${SECTIONS.map(([t]) => t).join(', ')}.`)
        current = null
        continue
      }
      if (found.has(known[0])) errors.push(`Line ${j + 1}: the "${known[0]}" section appears twice.`)
      current = { start: j + 2, body: [] }
      found.set(known[0], current)
      order.push(known[0])
      continue
    }
    if (current) current.body.push(lines[j])
    else if (lines[j].trim()) {
      errors.push(`Line ${j + 1} is outside any section. Everything after the header belongs under a "## " section heading.`)
      break
    }
  }
  const want = SECTIONS.map(([t]) => t).filter((t) => found.has(t))
  if (order.join('|') !== want.join('|')) errors.push(`The sections are out of order. They go: ${SECTIONS.map(([t]) => t).join(', ')}.`)
  const sectionText = (t: string): string => {
    const b = found.get(t)?.body ?? []
    return b.join('\n').replace(/^\n+|\n+$/g, '')
  }
  for (const [t, , required] of SECTIONS) if (required && !sectionText(t)) errors.push(`The "${t}" section is missing or empty.`)

  const checks: string[] = []
  const checkLines = sectionText('Acceptance checks').split('\n')
  let expect = 1
  for (const l of checkLines) {
    const m = /^(\d+)[.)]\s+(.+)$/.exec(l)
    if (m) {
      if (Number(m[1]) !== expect) {
        errors.push(`Acceptance check ${m[1]} is out of sequence; number them 1, 2, 3 and so on.`)
        break
      }
      checks.push(m[2].trim())
      expect++
    } else if (l.trim() && checks.length && /^\s+\S/.test(l)) checks[checks.length - 1] += ' ' + l.trim()
    else if (l.trim()) {
      errors.push(`In "Acceptance checks", "${l.trim().slice(0, 60)}" isn't a numbered check. Write each one as "1. …".`)
      break
    }
  }
  if (sectionText('Acceptance checks') && !checks.length) errors.push('"Acceptance checks" needs at least one numbered check.')
  if (checks.length > 40) errors.push('There are more than 40 acceptance checks.')

  for (const [t] of SECTIONS) {
    const s = found.get(t)
    if (s) errors.push(...codeRules(s.body.join('\n'), s.start))
  }
  if (errors.length || !header) return { ok: false, errors: errors.length ? errors : ['The header is not valid.'] }

  const sections: ExtensionSections = {
    summary: sectionText('Summary'),
    whatItDoes: sectionText('What it does'),
    seedPrompt: sectionText('Seed prompt'),
    checks,
    notes: sectionText('Notes') || undefined
  }
  return { ok: true, ext: { header, sections, canonical: canonicalText(header, sections) } }
}

/** The canonical form: header keys in a fixed order with normalised values, sections in order, LF line endings,
 *  no trailing spaces. Whitespace-only differences give the same text; any other edit gives a different one. */
export function canonicalText(h: ExtensionHeader, s: ExtensionSections): string {
  const o = h.effort.observed
  const kv: [string, string | number | undefined][] = [
    ['format', h.format],
    ['id', h.id],
    ['name', h.name],
    ['version', h.version],
    ['author', h.author],
    ['description', h.description],
    ['built_on', `${h.builtOn.version} @ ${h.builtOn.commit}`],
    ['works_with', h.worksWith],
    ['effort', h.effort.class],
    ['effort.minutes', o.minutes],
    ['effort.files', o.files],
    ['effort.model', o.model],
    ['effort.checks', o.checks],
    ['effort.cost', o.cost],
    ['effort.tokens', o.tokens],
    ['requires', h.requires.map((r) => (r.range === '*' ? r.id : `${r.id} ${r.range}`)).join(', ') || undefined],
    ['conflicts', h.conflicts.join(', ') || undefined],
    ['capabilities.tier', h.capabilities.tier],
    ['capabilities.packages', h.capabilities.packages.map((p) => `${p.name}@${p.version}`).join(', ') || undefined],
    ['capabilities.hosts', h.capabilities.hosts.join(', ') || undefined],
    ['capabilities.data', h.capabilities.data],
    ['capabilities.core_areas', h.capabilities.coreAreas.join(', ') || undefined],
    ['capabilities.rebuild', h.capabilities.rebuild ? 'yes' : 'no'],
    ['verified.commit', h.verified?.commit],
    ['verified.at', h.verified?.at],
    ['verified.by', h.verified?.by]
  ]
  const head = kv.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${v}`)
  const body = [
    ['Summary', s.summary],
    ['What it does', s.whatItDoes],
    ['Seed prompt', s.seedPrompt],
    ['Acceptance checks', s.checks.map((c, i) => `${i + 1}. ${c}`).join('\n')],
    ['Notes', s.notes]
  ]
    .filter(([, v]) => v)
    .map(([t, v]) => `## ${t}\n\n${v}\n`)
  return ['---', ...head, '---', '', body.join('\n')].join('\n')
}

// ---------- the ledger (extensions.json) ----------

export type ExtensionStatus = 'not-installed' | 'scanning' | 'ready' | 'building' | 'needs-review' | 'installed' | 'disabled' | 'failed' | 'removed'

export const STATUS_WORDS: Record<ExtensionStatus, string> = {
  'not-installed': 'Not installed yet',
  scanning: 'Scanning',
  ready: 'Ready to review',
  building: 'Building',
  'needs-review': 'Needs review',
  installed: 'Installed',
  disabled: 'Disabled',
  failed: 'Failed',
  removed: 'Removed'
}

export interface ExtensionRecord {
  /** the ledger key: the id plus the start of the hash, so two versions can be kept side by side */
  key: string
  id: string
  name: string
  version: string
  /** sha256 of the canonical text, hex */
  hash: string
  /** `features`: for a created extension, the merge commits of the user's own feature it was packaged from (#100), so
   *  Verify (#101) can start from a clean commit without it */
  source: { kind: 'created' | 'imported'; fileName?: string; via?: 'drop' | 'picker' | 'paste'; features?: string[] }
  status: ExtensionStatus
  createdAt: number
  updatedAt: number
  header: ExtensionHeader
  /** filled by #96 (scanning): see ScanState in extensionScan.ts */
  scan?: ScanState
  /** filled by #97 (cost): the confirmed estimate, the latest build's actual usage, and every build's estimated versus actual */
  cost?: ExtensionCost
  /** filled by #98 (install): the build task, its branch, the diff scan, the review and the merge. See BuildRecord. */
  build?: BuildRecord
  /** the user ticked "This extension changes protected parts of Corvid" (#98) */
  tier3?: Tier3Confirmation
  /** filled by #99 (lifecycle): disable, enable, remove, re-install, update. See LifecycleRecord in extensionLifecycle.ts */
  lifecycle?: LifecycleRecord
  /** filled by #101 (verify): Corvid's own verification of this exact text, the current or last verify build, and the
   *  shares (src/shared/extensionVerify.ts) */
  verification?: VerificationRecord
  verify?: VerifyRun
  shares?: ShareRecord[]
}

/** A build's report, sent by the build agent with its submit_build_report tool (#98). The agent's claim: the diff scan
 *  and the user's review are what count. */
export interface BuildReport {
  at: number
  /** what changed, in plain words */
  summary: string
  files: string[]
  /** the typecheck, the existing tests and the acceptance checks: what ran and how it went */
  tests: { name: string; result: 'pass' | 'fail' | 'not-run'; detail?: string }[]
  /** one entry per acceptance check, in order */
  acceptance: { check: number; result: 'pass' | 'fail' | 'not-run'; how?: string }[]
  notDone?: string
  /** gated behind a per-extension flag (5/8 uses it to disable) */
  flag?: string
}

/** The install pipeline's part of a record (#98, src/main/extensionInstall.ts). #99 (lifecycle), #101 (verify) and
 *  #108 (build progress) read it: keep it additive. */
export interface BuildRecord {
  /** where the build stands; the record's status says the same to the user */
  state: 'building' | 'needs-review' | 'merged' | 'failed' | 'discarded'
  /** the build task in the Corvid project, and its worker while one runs */
  taskId?: number
  workerId?: string
  /** the repository (Corvid's source checkout), the build branch and its worktree, and the default branch it is based on */
  repo?: string
  branch?: string
  worktree?: string
  base?: string
  /** main's commit when the build started */
  baseCommit?: string
  /** the branch tip the diff scan ran on and the user reviewed; kept after the merge so the build can be re-applied (5/8) */
  tip?: string
  /** the merge commit on main, once the user merged */
  mergeCommit?: string
  filesTouched?: string[]
  startedAt?: number
  endedAt?: number
  reviewedAt?: number
  mergedAt?: number
  /** kept for compatibility with part 1's field */
  at?: number
  /** why it failed, in plain words */
  error?: string
  report?: BuildReport
  diffScan?: DiffScanResult
  /** the user's notes from Send back, oldest first */
  sendBacks?: { at: number; note: string }[]
  /** the merge is on main but the running app isn't rebuilt yet */
  needsDeploy?: boolean
  /** extensions never push (the install is local); recorded so later parts can say so */
  pushed?: false
  /** the build agent's report_progress milestones (#108, display only) */
  progress?: BuildProgressLog
}

/** An extension's requirement, checked against the ledger before an install (#98). */
export interface RequirementState {
  id: string
  range: string
  state: 'installed' | 'available' | 'missing' | 'wrong-version'
  /** the ledger record to install first, when one in the list satisfies the range */
  key?: string
  version?: string
}

/** What stands in the way of an install, and what to warn about (#98, preflight() in src/main/extensionInstall.ts). */
export interface Preflight {
  ok: boolean
  /** each stops the install, in plain words */
  blockers: string[]
  /** shown, the user can go on */
  warnings: string[]
  /** requirements in the order to install them (deepest first), each to be installed on its own */
  requires: RequirementState[]
  tier: 1 | 2 | 3
  /** tier 3: the protected areas the user must confirm, and whether they have */
  protectedAreas: { id: string; label: string }[]
  tier3Confirmed: boolean
  /** extensions are never pushed after the merge */
  push: false
}

/** The user's tier-3 confirmation, given in Corvid's window before a build (#98). Tied to the extension's hash. */
export interface Tier3Confirmation {
  at: number
  hash: string
  areas: string[]
}

/** The cost part of a record (#97, src/shared/costEstimate.ts). Never sent anywhere. */
export interface ExtensionCost {
  estimate?: { low: number; likely?: number; high: number; unit: string; at: number; model?: string; minutes?: number; confidence?: string; confirmedAt?: number }
  actual?: { amount: number; unit: string; at: number; minutes?: number; model?: string; capHit?: boolean; outcome?: CostRun['outcome'] }
  /** every build's estimated versus actual, the last 20; failed and cancelled ones are kept but never feed an estimate */
  runs?: CostRun[]
}

/** One build's estimated versus actual usage (#97). */
export interface CostRun {
  at: number
  effort: Effort
  seedChars: number
  checks?: number
  tier?: ExtensionTier
  model: string
  estimate: { low: number; likely: number; high: number }
  actual: { tokens: number; minutes: number }
  capHit: boolean
  /** how many times the user chose Continue at the cap */
  continued: number
  outcome: 'ok' | 'failed' | 'cancelled'
}

/** What the install confirmation shows (#97), with the one-time token its Confirm sends back. */
export interface InstallPrompt {
  token: string
  estimate: CostEstimate
  capMultiple: number
  capTokens: number
  /** the usage limit (#93) is passed, or usage is unknown: a second warning; block = Settings blocks new agents */
  usage?: { block: boolean; text: string }
}

export interface ExtensionsFile {
  version: 1
  extensions: ExtensionRecord[]
}

/** A record and the text it was imported from, for the extension's page. */
export interface ExtensionDetail {
  record: ExtensionRecord
  sections: ExtensionSections | null
  text: string | null
}

export type ImportOutcome =
  | { name: string; ok: true; key: string; replaced?: boolean }
  | { name: string; ok: false; errors: string[] }
  | {
      name: string
      ok: false
      conflict: { token: string; existing: { key: string; version: string }; incoming: { version: string; hash: string }; canReplace: boolean }
    }
