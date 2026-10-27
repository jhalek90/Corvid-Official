// Light formatting for agents' and Corvid's board messages (#126): the text is parsed into data (blocks, inline runs
// and highlighted tokens, each with its offset in the original text) that the board draws as React text nodes. Nothing
// here builds HTML or runs anything, and the stored message is never changed. Every rule that decides what stands
// out lives in this file, with its tests in scripts/test-board-format.mjs, so it is easy to tune.
//
// Each step is a single pass or a regex anchored at a word boundary, so even hostile input (long runs of * or `,
// a huge word, a thousand list items) stays linear.

/** A highlighted kind of text. 'ref' is a #12, N7 or m42 the board may draw as a chip when it leads somewhere. */
export type TokenKind = 'url' | 'ref' | 'path' | 'hash' | 'version' | 'num' | 'ok' | 'warn' | 'bad'

/** A run of inline text: plain, author-marked (bold, italic, code) or a highlighted token. `at` is its offset in the original. */
export type Inline =
  | { t: 'text'; at: number; text: string; toks?: Token[] }
  | { t: 'bold' | 'italic'; at: number; end: number; kids: Inline[] }
  | { t: 'code'; at: number; end: number; text: string; textAt: number }

export type Block =
  | { t: 'para'; at: number; end: number; lines: Line[] }
  | { t: 'list'; ordered: boolean; at: number; end: number; items: Item[] }

export interface Line {
  at: number
  end: number
  inl: Inline[]
}
export interface Item {
  at: number
  end: number
  /** the marker as typed ("-", "*", "•", "3.", "3)"), drawn in place so the shape is the author's */
  marker: string
  markerAt: number
  /** nesting from the indent, 0 to 2 */
  level: number
  lines: Line[]
}

export interface Formatted {
  blocks: Block[]
  /** worth folding to a preview: many lines or many characters */
  long: boolean
}

/** A message longer than this, in lines or characters, folds to a preview with Show more. */
export const COLLAPSE_LINES = 10
export const COLLAPSE_CHARS = 600

const BULLET = /^( {0,8})([-*•])[ \t]+(?=\S)/
const NUMBERED = /^( {0,8})(\d{1,3}[.)])[ \t]+(?=\S)/

/** The message as blocks: paragraphs (blank lines between them) and lists, a line at a time. */
export function formatMessage(text: string): Formatted {
  const blocks: Block[] = []
  let para: Line[] = []
  let list: Extract<Block, { t: 'list' }> | null = null
  const flushPara = (): void => {
    if (para.length) blocks.push({ t: 'para', at: para[0].at, end: para[para.length - 1].end, lines: para })
    para = []
  }
  const flushList = (): void => {
    if (list) blocks.push(list)
    list = null
  }
  let lineCount = 0
  let at = 0
  while (at <= text.length) {
    let end = text.indexOf('\n', at)
    if (end < 0) end = text.length
    const raw = text.slice(at, end)
    lineCount++
    if (!raw.trim()) {
      flushPara()
      flushList()
    } else {
      const m = BULLET.exec(raw) ?? NUMBERED.exec(raw)
      if (m) {
        flushPara()
        const ordered = /\d/.test(m[2])
        if (list && list.ordered !== ordered && m[1].length === 0) flushList()
        if (!list) list = { t: 'list', ordered, at, end, items: [] }
        const bodyAt = at + m[0].length
        list.items.push({
          at,
          end,
          marker: m[2],
          markerAt: at + m[1].length,
          level: Math.min(2, Math.floor(m[1].length / 2)),
          lines: [{ at: bodyAt, end, inl: inline(text.slice(bodyAt, end), bodyAt) }]
        })
        list.end = end
      } else if (list && /^\s{2,}\S/.test(raw)) {
        // an indented line under a list item continues it
        const item = list.items[list.items.length - 1]
        const lead = raw.length - raw.trimStart().length
        item.lines.push({ at: at + lead, end, inl: inline(raw.slice(lead), at + lead) })
        item.end = list.end = end
      } else {
        flushList()
        para.push({ at, end, inl: inline(raw, at) })
      }
    }
    at = end + 1
  }
  flushPara()
  flushList()
  // highlight the plain runs in reading order, each line with its own budget, so a list's items look alike
  const all = blocks.flatMap((b) => (b.t === 'para' ? b.lines : b.items.flatMap((i) => i.lines)))
  const mark = (inl: Inline[], budget: { left: number }): void => {
    for (const x of inl) {
      if (x.t === 'text') x.toks = highlight(x.text, budget)
      else if (x.t !== 'code') mark(x.kids, budget)
    }
  }
  for (const l of all) mark(l.inl, budgetFor(text.slice(l.at, l.end), all.length === 1 ? 2 : 1))
  return { blocks, long: lineCount > COLLAPSE_LINES || text.length > COLLAPSE_CHARS }
}

/** Runs of one character: where they start and how long they are. */
function runs(s: string, ch: string): { at: number; n: number }[] {
  const out: { at: number; n: number }[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ch) continue
    let j = i
    while (j < s.length && s[j] === ch) j++
    out.push({ at: i, n: j - i })
    i = j - 1
  }
  return out
}

/** One line's inline runs: `code` first (nothing inside it is touched), then **bold**, then *italic*. */
export function inline(s: string, base: number): Inline[] {
  const out: Inline[] = []
  // pair each backtick run with the next run of the same length; one with no partner stays as typed
  const ticks = runs(s, '`')
  const nextSame = new Map<number, number>()
  const lastOf = new Map<number, number>()
  for (let k = ticks.length - 1; k >= 0; k--) {
    const n = ticks[k].n
    if (lastOf.has(n)) nextSame.set(k, lastOf.get(n)!)
    lastOf.set(n, k)
  }
  let from = 0
  let k = 0
  while (k < ticks.length) {
    const open = ticks[k]
    const close = nextSame.get(k)
    if (close === undefined || open.at < from) {
      k++
      continue
    }
    const c = ticks[close]
    const inner = s.slice(open.at + open.n, c.at)
    if (!inner.trim()) {
      k++
      continue
    }
    emphasis(s.slice(from, open.at), base + from, out)
    out.push({ t: 'code', at: base + open.at, end: base + c.at + c.n, text: inner, textAt: base + open.at + open.n })
    from = c.at + c.n
    k = close + 1
  }
  emphasis(s.slice(from), base + from, out)
  return out
}

const word = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c)
const space = (c: string | undefined): boolean => c === undefined || /\s/.test(c)

/** **bold** and *italic* in text with no code in it. A delimiter opens before a non-space and closes after one, and a
 *  single * only next to a non-word character, so 2*3*4, a*b and a lone * stay as typed. */
function emphasis(s: string, base: number, out: Inline[]): void {
  if (!s) return
  const pairs = delimPairs(s, 2, (i) => !space(s[i + 2]), (i) => !space(s[i - 1]))
  let from = 0
  for (const [a, b] of pairs) {
    italics(s.slice(from, a), base + from, out)
    const kids: Inline[] = []
    italics(s.slice(a + 2, b), base + a + 2, kids)
    out.push({ t: 'bold', at: base + a, end: base + b + 2, kids })
    from = b + 2
  }
  italics(s.slice(from), base + from, out)
}

function italics(s: string, base: number, out: Inline[]): void {
  if (!s) return
  const pairs = delimPairs(
    s,
    1,
    (i) => !space(s[i + 1]) && !word(s[i - 1]),
    (i) => !space(s[i - 1]) && !word(s[i + 1])
  )
  let from = 0
  for (const [a, b] of pairs) {
    text(s.slice(from, a), base + from, out)
    out.push({ t: 'italic', at: base + a, end: base + b + 1, kids: [{ t: 'text', at: base + a + 1, text: s.slice(a + 1, b) }] })
    from = b + 1
  }
  text(s.slice(from), base + from, out)
}

/** Opening and closing positions of `*` runs exactly `n` long, paired left to right in one pass. */
function delimPairs(s: string, n: number, opens: (i: number) => boolean, closes: (i: number) => boolean): [number, number][] {
  const pairs: [number, number][] = []
  let open = -1
  for (const r of runs(s, '*')) {
    if (r.n !== n) continue
    if (open >= 0 && closes(r.at) && r.at > open + n) {
      pairs.push([open, r.at])
      open = -1
    } else if (opens(r.at)) open = r.at
  }
  return pairs
}

function text(s: string, at: number, out: Inline[]): void {
  if (s) out.push({ t: 'text', at, text: s })
}

// ---- highlighting: the parts of plain text worth picking out ----

/** Status words with a tone, matched as whole words only. The word carries the meaning; the tone only helps. */
export const STATUS: Record<'ok' | 'warn' | 'bad', string[]> = {
  ok: ['done', 'merged', 'passed', 'passes', 'deployed', 'healthy'],
  warn: ['waiting', 'needs you', 'blocked', 'stuck', 'held'],
  bad: ['failed', 'fails', 'error', 'refused', 'rolled back']
}
/** A status word right after one of these stays plain: "no error", "not merged", "never failed". */
const NEGATIONS = /(?:^|[^\p{L}])(?:no|not|never|without|nothing|isn't|wasn't|didn't|hasn't|haven't|aren't|won't)\s+$/iu

/** Words a number can carry to count as a measure: "12 minutes", "4 files". */
const UNITS =
  'ms|s|sec|secs|seconds?|mins?|minutes?|h|hrs?|hours?|days?|weeks?|months?|kb|mb|gb|tb|bytes?|tokens?|files?|lines?|tests?|' +
  'commits?|messages?|posts?|notes?|tasks?|agents?|workers?|errors?|warnings?|items?|chars?|characters?|words?|times|px|steps?|checks?|branches?'

/** done, Done and DONE, but not dOnE: the regex has no i flag, so camelCase and hashes stay exact */
const statusAlt = (list: string[]): string =>
  list.flatMap((w) => [w, w[0].toUpperCase() + w.slice(1), w.toUpperCase()]).map((w) => w.replace(/ /g, '\\s+')).join('|')

// One regex, one alternative per kind, each forced to start at a token boundary so a long word is tried once, not at
// every character. Order matters where two could match the same place: a URL before a path, a hash before a number.
const TOKENS = new RegExp(
  [
    /(?<url>\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]])/.source,
    /(?<ref>(?<![\w&#])#\d{1,6}\b|\b[Nm]\d{1,6}\b)/.source,
    // a path: a drive, ~/ or ./ start, or at least two parts with a file extension or a second separator
    /(?<path>(?<![\w.\/\\-])(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])?[\w@.-]+(?:[\\/][\w@.-]+)+[\\/]?)/.source,
    /(?<branch>(?<![\w\/-])(?:task|feature|fix|bugfix|hotfix|release)-[\w.\/-]*\w)/.source,
    /(?<hash>(?<![\w.-])[0-9a-f]{7,40}(?![\w.-]))/.source,
    /(?<version>(?<![\w.-])v?\d+\.\d+\.\d+(?:-[\w.]+)?(?![\w-])|(?<![\w.-])v\d+(?:\.\d+)?(?![\w.-]))/.source,
    `(?<num>(?<![\\w.])\\d+(?:[.,]\\d+)?(?:\\s?%|:1\\b|\\s?(?:${UNITS}|KB|MB|GB|TB)(?![\\w-])))`,
    // dotted or underscored names and camelCase: package.json, api.boardPost(), read_messages, useStickToBottom
    /(?<ident>(?<![\w.\/\\-])(?:[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+(?:\(\))?|[a-z][a-z0-9]*_[a-z0-9_]+|[a-z]+[a-z0-9]*[A-Z][A-Za-z0-9]*)(?![\w.\/\\-]))/.source,
    `(?<ok>(?<![\\w-])(?:${statusAlt(STATUS.ok)})(?![\\w-]))`,
    `(?<warn>(?<![\\w-])(?:${statusAlt(STATUS.warn)})(?![\\w-]))`,
    `(?<bad>(?<![\\w-])(?:${statusAlt(STATUS.bad)})(?![\\w-]))`
  ].join('|'),
  'gu'
)

export interface Token {
  kind: TokenKind
  /** offsets within the text given to highlight() */
  start: number
  end: number
}

/** How sure a match is that it's worth picking out, for when there are more than the budget allows. */
const RANK: Record<TokenKind, number> = { url: 9, ref: 9, bad: 8, warn: 7, ok: 6, path: 5, hash: 4, version: 3, num: 2 }
/** Kinds that never count against the budget: they lead somewhere or are needed to read the line. */
const FREE = new Set<TokenKind>(['url', 'ref'])

/** A path-like match that's really a path, not "and/or" or "12/45". */
function isPath(s: string): boolean {
  if (/^(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/])/.test(s)) return true
  if (!/[A-Za-z]/.test(s)) return false
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts.length >= 3 || /\.[A-Za-z][\w]{0,7}$/.test(s)
}
/** e.g, i.e and a.m. aren't names; a name has a part at least two letters long and is at least four characters. */
const isIdent = (s: string): boolean => s.length >= 4 && (/[_A-Z(]/.test(s) || s.split('.').some((p) => p.length >= 2)) && !/^(?:e\.g|i\.e|a\.m|p\.m|etc)\b/i.test(s)
/** a hash has both a digit and a letter, so "1234567" and "deadbee" alone read as what they are */
const isHash = (s: string): boolean => /\d/.test(s) && /[a-f]/.test(s)

/** Longer than this, a word is drawn plain: nobody reads one that long, and it keeps hostile text cheap. */
const HUGE = 300

/**
 * The tokens worth picking out in a run of plain text. At most about one word in ten is styled (plus links and
 * references, which lead somewhere): when there are more, the surest are kept. `words` is the message's word count,
 * so the budget is the message's, shared by its runs through `spend`.
 */
export function highlight(s: string, budget: { left: number } = { left: Infinity }): Token[] {
  if (!s || s.length > 20_000) return []
  const found: Token[] = []
  TOKENS.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKENS.exec(s))) {
    const g = m.groups!
    const v = m[0]
    const start = m.index
    if (v.length > HUGE) continue
    let kind: TokenKind | undefined
    if (g.url) kind = 'url'
    else if (g.ref) kind = 'ref'
    else if (g.path) kind = isPath(v) ? 'path' : undefined
    else if (g.branch) kind = 'path'
    else if (g.hash) kind = isHash(v) ? 'hash' : undefined
    else if (g.version) kind = 'version'
    else if (g.num) kind = 'num'
    else if (g.ident) kind = isIdent(v) ? 'path' : undefined
    else {
      const tone: TokenKind = g.ok ? 'ok' : g.warn ? 'warn' : 'bad'
      kind = NEGATIONS.test(s.slice(Math.max(0, start - 12), start)) ? undefined : tone
    }
    if (kind) found.push({ kind, start, end: start + v.length })
  }
  if (!found.length) return found
  const paid = found.filter((t) => !FREE.has(t.kind))
  if (paid.length <= budget.left) {
    budget.left -= paid.length
    return found
  }
  const keep = new Set(
    [...paid]
      .sort((a, b) => RANK[b.kind] - RANK[a.kind] || a.start - b.start)
      .slice(0, Math.max(0, budget.left))
  )
  budget.left = 0
  return found.filter((t) => FREE.has(t.kind) || keep.has(t))
}

/** The highlight budget for a line: about one word in ten, and at least `least` (two for a one-line message). */
export const budgetFor = (text: string, least = 2): { left: number } => ({ left: Math.max(least, Math.ceil((text.match(/\S+/g)?.length ?? 0) / 10)) })

// ---- the parse is pure, so each message is parsed once ----

const cache = new Map<string, Formatted>()
const CACHE_MAX = 800

/** formatMessage, remembered by message id and text. */
export function formatCached(id: number, text: string): Formatted {
  const key = `${id}\u0000${text}`
  let f = cache.get(key)
  if (!f) {
    f = formatMessage(text)
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
    cache.set(key, f)
  }
  return f
}

// ---- colours: the tones, nudged until they read on every bubble the theme draws ----

type Rgb = [number, number, number]

function parseRgb(v: string | undefined): Rgb | null {
  if (!v) return null
  const s = v.trim().toLowerCase()
  let m = /^#([0-9a-f]{3,8})$/.exec(s)
  if (m) {
    const h = m[1].length <= 4 ? [...m[1].slice(0, 3)].map((c) => c + c).join('') : m[1].slice(0, 6)
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  if (s === 'white') return [255, 255, 255]
  if (s === 'black') return [0, 0, 0]
  return null
}
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t) as Rgb
const lum = (c: Rgb): number => {
  const [r, g, b] = c.map((v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const ratio = (a: Rgb, b: Rgb): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const hex = (c: Rgb): string => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

/** The least contrast a highlight colour may have against any bubble it sits on. */
export const MIN_CONTRAST = 4.5

/** The backgrounds board text sits on, from the theme's tokens: the list, the bubble, a hovered or flashed one, and
 *  the tints of a message to the user and a question (the same mixes board.css draws). */
export function bubbleBackgrounds(tokens: Record<string, string>): Rgb[] {
  const bg2 = parseRgb(tokens['bg-2'])
  const out = ['bg', 'bg-1', 'bg-2', 'bg-3'].map((k) => parseRgb(tokens[k])).filter((c): c is Rgb => !!c)
  const accent = parseRgb(tokens.accent)
  const warn = parseRgb(tokens.warn)
  if (bg2 && accent) out.push(mix(bg2, accent, 0.07))
  if (bg2 && warn) out.push(mix(bg2, warn, 0.08))
  return out
}

/**
 * The board's highlight colours for a theme, as CSS variables: each starts from a theme colour (the accent, the
 * syntax green, warn, danger) and is moved towards the text colour, a step at a time, until it has at least
 * MIN_CONTRAST against every background in bubbleBackgrounds. If even the text colour can't, black or white is used.
 */
export function formatColours(tokens: Record<string, string>): Record<string, string> {
  const bgs = bubbleBackgrounds(tokens)
  const textC = parseRgb(tokens.text) ?? [128, 128, 128]
  const worst = (c: Rgb): number => Math.min(...bgs.map((b) => ratio(c, b)))
  const fit = (from: string | undefined): string => {
    const start = parseRgb(from) ?? textC
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const c = mix(start, textC, t)
      if (worst(c) >= MIN_CONTRAST + 0.05) return hex(c)
    }
    const black: Rgb = [0, 0, 0]
    const white: Rgb = [255, 255, 255]
    return hex(worst(black) > worst(white) ? black : white)
  }
  return {
    'fmt-link': fit(tokens.accent),
    'fmt-ok': fit(tokens['syn-string'] ?? tokens.accent),
    'fmt-warn': fit(tokens.warn),
    'fmt-bad': fit(tokens.danger),
    'fmt-text': fit(tokens.text)
  }
}
