import { randomBytes } from 'node:crypto'
import { headUnits } from '@shared/text'

// Paged call() results (#104). A result larger than a page is split, the first page goes back with a footer, and
// the rest is held here, in memory only, for the agent and project that made the call; call_more reads it on. Pages
// break between JSON array items (or rows), between lines of text, and only mid-item or mid-line when one alone is
// larger than a page. select/limit cut a JSON response down on Corvid's side first, so less reaches the agent.
// Free of electron so the tests run it directly.

/** Page size in characters (UTF-16 units, what mcp.ts's MAX_RESULT of 24,000 counts): a page and its footer fit under it. */
export const PAGE_CHARS = { min: 4_000, max: 22_000, default: 20_000 }

export const HOLD = {
  /** a held result expires this long after it was last read */
  idleMs: 10 * 60_000,
  /** and at the latest this long after the call */
  maxMs: 60 * 60_000,
  maxResults: 20,
  perOwner: 8,
  /** characters held in all, about twice that in memory */
  maxChars: 32 * 1024 * 1024
}

export const pageChars = (n: unknown): number => {
  const v = Math.round(Number(n))
  return Number.isFinite(v) && v > 0 ? Math.min(PAGE_CHARS.max, Math.max(PAGE_CHARS.min, v)) : PAGE_CHARS.default
}

// ---------- splitting ----------

export interface Split {
  pages: string[]
  /** per page, what it holds: "items 1-96 of 100 in body" */
  labels: string[]
  /** how pages were broken, for the footer of page 1 */
  how: string
}

type Path = (string | number)[]
const size = (v: unknown): number => JSON.stringify(v)?.length ?? 4
const pathText = (p: Path): string => p.map((k, i) => (typeof k === 'number' ? `[${k}]` : i ? `.${k}` : k)).join('') || 'the result'
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The largest array or string in the result, up to three fields deep: what gets paged. */
function mainPart(v: unknown): { path: Path; value: unknown[] | string; size: number } | null {
  let best: { path: Path; value: unknown[] | string; size: number } | null = null
  const visit = (x: unknown, path: Path): void => {
    if (Array.isArray(x) || typeof x === 'string') {
      const n = size(x)
      if (!best || n > best.size) best = { path, value: x, size: n }
      return
    }
    if (isObj(x) && path.length < 3) for (const [k, y] of Object.entries(x)) visit(y, [...path, k])
  }
  visit(v, [])
  return best
}

function setAt(v: unknown, path: Path, to: unknown): unknown {
  if (!path.length) return to
  const [k, ...rest] = path
  return { ...(v as Record<string, unknown>), [k]: setAt((v as Record<string, unknown>)[k as string], rest, to) }
}

/** The first piece of text, at most `max` units, ending at a line break when one is in the second half. */
function textCut(s: string, max: number): number {
  if (s.length <= max) return s.length
  const end = Math.max(1, headUnits(s, max).length)
  const nl = s.lastIndexOf('\n', end - 1)
  return nl >= end / 2 ? nl + 1 : end
}

function textPages(s: string, max: number): string[] {
  const out: string[] = []
  for (let at = 0; at < s.length; ) {
    const n = textCut(s.slice(at, at + max + 64), max)
    out.push(s.slice(at, at + n))
    at += n
  }
  return out.length ? out : ['']
}

/** Splits a (scrubbed) result into pages of at most `max` characters each. One page when it fits. */
export function splitResult(value: unknown, max: number): Split {
  const whole = typeof value === 'string' ? value : JSON.stringify(value)
  if (whole.length <= max) return { pages: [whole], labels: [''], how: '' }
  const main = typeof value === 'string' ? { path: [], value, size: whole.length } : mainPart(value)
  // a result without one large array or text (a big object of many fields) is paged as indented JSON, by lines
  if (!main || main.size * 2 < whole.length) {
    const pages = textPages(JSON.stringify(value, null, 1), max)
    return { pages, labels: pages.map(() => ''), how: 'The result is shown as indented JSON, split between lines; join the pages to read it whole.' }
  }
  const where = pathText(main.path)
  // page 1 is the result itself with the large part cut to what fits; a random marker stands in for that part
  const marker = `\u0000page-${randomBytes(6).toString('hex')}`
  const shell = typeof value === 'string' ? JSON.stringify(marker) : JSON.stringify(setAt(value, main.path, marker))
  const [before, after] = shell.split(JSON.stringify(marker))

  if (typeof main.value === 'string') {
    const text = main.value
    let first = ''
    if (typeof value === 'string') first = text.slice(0, textCut(text, max))
    else {
      // inside JSON the text is escaped and grows: shrink the cut until the escaped piece fits
      const room = Math.max(0, max - before.length - after.length)
      let n = textCut(text, room)
      while (n > 0 && JSON.stringify(text.slice(0, n)).length > room) n = textCut(text, Math.floor(n * 0.9))
      first = text.slice(0, n)
    }
    const rest = textPages(text.slice(first.length), max)
    const pages = [typeof value === 'string' ? first : before + JSON.stringify(first) + after, ...(first.length < text.length ? rest : [])]
    return {
      pages,
      labels: pages.map(() => ''),
      how:
        typeof value === 'string'
          ? 'Text is split between lines (mid-line only for a line longer than a page); join the pages as they are.'
          : `${where} is text: page 1 holds its start inside the JSON, later pages carry on as plain text, split between lines; join them as they are.`
    }
  }

  const items = main.value.map((x) => JSON.stringify(x) ?? 'null')
  const total = items.length
  const pages: string[] = []
  const labels: string[] = []
  const label = (a: number, b: number): string => (b > a ? `items ${a + 1}-${b} of ${total} in ${where}` : `no items of ${where} on this page`)
  let i = 0
  let open = before
  let close = after
  for (;;) {
    let len = open.length + close.length + 2
    const from = i
    while (i < total) {
      const add = items[i].length + (i > from ? 1 : 0)
      if (len + add > max) break
      len += add
      i++
    }
    if (i > from || !pages.length) {
      pages.push(`${open}[${items.slice(from, i).join(',')}]${close}`)
      labels.push(label(from, i))
    }
    if (i >= total) break
    if (i === from) {
      // one item larger than a page: its JSON goes on as text, the only place a page breaks mid-item
      const parts = textPages(items[i], max)
      parts.forEach((p, k) => {
        pages.push(p)
        labels.push(`item ${i + 1} of ${total} in ${where}, part ${k + 1} of ${parts.length} (larger than a page, so split mid-item as text)`)
      })
      i++
      if (i >= total) break
    }
    open = ''
    close = ''
  }
  return {
    pages,
    labels,
    how: `${where} is paged between items: page 1 is the result with the first items, each later page is a JSON array of the next ones.`
  }
}

// ---------- held results ----------

export interface Owner {
  agent: string
  project: string
}

export interface Held {
  id: string
  owner: Owner
  connectionId: string
  connectionName: string
  connectorId: string
  connector: string
  operation: string
  cls: 'read' | 'write' | 'admin'
  /** the connection's updatedAt when the call ran: a changed connection drops its held results */
  connectionUpdatedAt: number
  /** the scrubbed audit line of the request */
  request: string
  pages: string[]
  labels: string[]
  how: string
  totalBytes: number
  chars: number
  createdAt: number
  lastRead: number
}

const held = new Map<string, Held>()
/** ids that are gone, with why, so an agent hears "expired" rather than "unknown" */
const gone = new Map<string, { owner: Owner; why: string; at: number }>()
let sweeper: ReturnType<typeof setInterval> | undefined

const sameOwner = (a: Owner, b: Owner): boolean => a.agent === b.agent && a.project === b.project
const expired = (h: Held, now: number): boolean => now - h.lastRead > HOLD.idleMs || now - h.createdAt > HOLD.maxMs

function drop(h: Held, why: string): void {
  held.delete(h.id)
  gone.set(h.id, { owner: h.owner, why, at: Date.now() })
  if (gone.size > 500) gone.delete(gone.keys().next().value as string)
}

export function sweep(now = Date.now()): void {
  for (const h of held.values()) if (expired(h, now)) drop(h, `it expired (results are held for ${HOLD.idleMs / 60_000} minutes after the last read)`)
  for (const [id, g] of gone) if (now - g.at > HOLD.maxMs) gone.delete(id)
}

export const heldStats = (): { results: number; chars: number } => ({ results: held.size, chars: [...held.values()].reduce((n, h) => n + h.chars, 0) })

/** Holds a split result and returns its id, or null when it is too large to hold even alone. */
export function hold(h: Omit<Held, 'id' | 'chars' | 'createdAt' | 'lastRead'>): string | null {
  sweep()
  const chars = h.pages.reduce((n, p) => n + p.length, 0)
  if (chars > HOLD.maxChars) return null
  const oldest = (only?: Owner): Held | undefined => [...held.values()].filter((x) => !only || sameOwner(x.owner, only)).sort((a, b) => a.createdAt - b.createdAt)[0]
  const room = 'it was dropped to make room for newer results (a few are held at a time)'
  while ([...held.values()].filter((x) => sameOwner(x.owner, h.owner)).length >= HOLD.perOwner) drop(oldest(h.owner)!, room)
  while (held.size >= HOLD.maxResults || heldStats().chars + chars > HOLD.maxChars) drop(oldest()!, room)
  const id = 'r' + randomBytes(5).toString('hex')
  const now = Date.now()
  held.set(id, { ...h, id, chars, createdAt: now, lastRead: now })
  sweeper ??= setInterval(() => sweep(), 60_000)
  sweeper.unref?.()
  return id
}

/** The held result for this owner, or the reason it can't be read. Reading it keeps it for another while. */
export function lookup(owner: Owner, id: string): { ok: true; held: Held } | { ok: false; why: string; other?: Held } {
  sweep()
  const key = String(id ?? '').trim()
  const h = held.get(key)
  if (h && !sameOwner(h.owner, owner)) return { ok: false, why: `Result ${key} was not made by you in this project, so it can't be read here.`, other: h }
  if (h) {
    h.lastRead = Date.now()
    return { ok: true, held: h }
  }
  const g = gone.get(key)
  if (g && sameOwner(g.owner, owner)) return { ok: false, why: `Result ${key} is no longer held: ${g.why}. Run the call again, ideally with select or limit so less comes back.` }
  if (g) return { ok: false, why: `Result ${key} was not made by you in this project, so it can't be read here.` }
  return { ok: false, why: `There is no result ${key}. Result ids come from a call() whose result was split into pages.` }
}

/** Drops held results: all, one connector's, one connection's or one agent's. */
export function dropHeld(match: (h: Held) => boolean, why: string): number {
  let n = 0
  for (const h of [...held.values()]) if (match(h)) (drop(h, why), n++)
  return n
}

export function footer(h: Pick<Held, 'id' | 'pages' | 'labels' | 'how' | 'totalBytes'>, page: number, idleMs = HOLD.idleMs): string {
  const n = h.pages.length
  const what = h.labels[page - 1] ? `; this page: ${h.labels[page - 1]}` : ''
  const head = `[Page ${page} of ${n} (${h.totalBytes.toLocaleString('en-US')} bytes in total)${what}.`
  if (page === n) return `${head} This is the last page of result ${h.id}.]`
  return [
    `${head} More with call_more(result_id: "${h.id}", page: ${page + 1}), up to page ${n}; held for ${idleMs / 60_000} minutes after the last read.`,
    page === 1 ? ` ${h.how} Large results cost the user's usage: if you need only part, call again with select and limit instead of reading every page.]` : ']'
  ].join('')
}

/** A paged answer: the page itself (valid JSON where the result was) and the footer, as two text blocks (see mcp.ts). */
export interface PageOut {
  textParts: [string, string]
}
export const pageOut = (page: string, foot: string): PageOut => ({ textParts: [page, foot] })

// ---------- select and limit ----------

type Step = { k: 'key'; key: string } | { k: 'index'; i: number } | { k: 'all' } | { k: 'pick'; keys: string[] }

const NAME = /^(?:[A-Za-z0-9_$@:-]+|"[^"\\]{1,100}")/

/**
 * Parses a path like posts[*].title, data.items[0], [*]{id,title} or "odd key".x. Names, quoted names, [n]
 * (negative counts from the end), [*] for every item, and {a,b} at the end to keep some fields. Nothing is evaluated.
 */
export function parseSelect(src: unknown): Step[] {
  const s = String(src ?? '').trim()
  if (!s) throw new Error('select is empty.')
  if (s.length > 300) throw new Error('select may be at most 300 characters.')
  const steps: Step[] = []
  // an optional leading $ (the body itself), as in $.posts or $[*]
  let at = /^\$(?:$|[.[{])/.test(s) ? (s[1] === '.' ? 2 : 1) : 0
  const bad = (why: string): never => {
    throw new Error(`select "${s}" is not a path Corvid understands (${why} at character ${at + 1}). Use names, [n], [*] and a final {a,b}, like posts[*].title or [*]{id,title}.`)
  }
  while (at < s.length) {
    if (steps.at(-1)?.k === 'pick') bad('{…} must come last')
    const ch = s[at]
    if (ch === '[') {
      const m = /^\[(\*|-?\d{1,9})\]/.exec(s.slice(at))
      if (!m) bad('expected [n] or [*]')
      steps.push(m![1] === '*' ? { k: 'all' } : { k: 'index', i: Number(m![1]) })
      at += m![0].length
    } else if (ch === '{') {
      const m = /^\{([^{}]{1,500})\}/.exec(s.slice(at))
      if (!m) bad('expected {field,field}')
      const keys = m![1].split(',').map((k) => k.trim().replace(/^"(.*)"$/, '$1'))
      if (keys.some((k) => !k) || keys.length > 50) bad('expected {field,field}')
      steps.push({ k: 'pick', keys })
      at += m![0].length
    } else {
      if (ch === '.') {
        if (!steps.length) bad('unexpected "."')
        at++
      } else if (steps.length) bad('expected ".", "[" or "{"')
      const m = NAME.exec(s.slice(at))
      if (!m) bad('expected a field name')
      steps.push({ k: 'key', key: m![0].startsWith('"') ? m![0].slice(1, -1) : m![0] })
      at += m![0].length
    }
    if (steps.length > 20) bad('more than 20 steps')
  }
  return steps
}

const MISSING = Symbol('missing')

function describeValue(v: unknown): string {
  if (Array.isArray(v)) return `an array of ${v.length} items`
  if (isObj(v)) {
    const keys = Object.keys(v)
    return keys.length ? `an object with fields ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''}` : 'an empty object'
  }
  return v === null ? 'null' : `a ${typeof v}`
}

/** Applies a parsed path to a JSON value. Throws a plain explanation when it matches nothing. */
export function applySelect(value: unknown, steps: Step[], src: string): unknown {
  let why = ''
  const miss = (where: string, v: unknown, wanted: string): typeof MISSING => {
    why ||= `${where || 'the body'} is ${describeValue(v)}, so ${wanted} matches nothing`
    return MISSING
  }
  const walk = (v: unknown, i: number, where: string): unknown => {
    if (i === steps.length) return v
    const s = steps[i]
    if (s.k === 'key') return isObj(v) && Object.hasOwn(v, s.key) ? walk(v[s.key], i + 1, where ? `${where}.${s.key}` : s.key) : miss(where, v, `"${s.key}"`)
    if (s.k === 'index') {
      if (!Array.isArray(v)) return miss(where, v, `[${s.i}]`)
      const j = s.i < 0 ? v.length + s.i : s.i
      return j >= 0 && j < v.length ? walk(v[j], i + 1, `${where}[${s.i}]`) : miss(where, v, `[${s.i}]`)
    }
    if (s.k === 'all') {
      if (!Array.isArray(v)) return miss(where, v, '[*]')
      const out = v.map((x) => walk(x, i + 1, `${where}[*]`))
      return v.length && out.every((x) => x === MISSING) ? MISSING : out.map((x) => (x === MISSING ? null : x))
    }
    const pick = (o: unknown): unknown => (isObj(o) ? Object.fromEntries(s.keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]])) : null)
    if (Array.isArray(v)) return v.map(pick)
    return isObj(v) ? pick(v) : miss(where, v, `{${s.keys.join(',')}}`)
  }
  const out = walk(value, 0, '')
  if (out === MISSING) throw new Error(`select "${src}" matches nothing: ${why}. Nothing else was sent; the request already ran once.`)
  return out
}

/** select and limit on one value: what is left, and a note saying what was done. */
export function narrow(value: unknown, select: string | undefined, limit: number | undefined): { value: unknown; note: string } {
  let v = select === undefined ? value : applySelect(value, parseSelect(select), select)
  const notes: string[] = []
  if (select !== undefined) notes.push(`Selected ${select} from the body on Corvid's side.`)
  if (limit !== undefined) {
    if (Array.isArray(v)) {
      if (v.length > limit) notes.push(`Kept the first ${limit} of ${v.length} items (limit).`)
      v = v.slice(0, limit)
    } else notes.push(`limit was not applied: the ${select === undefined ? 'body' : 'selection'} is ${describeValue(v)}, not an array.`)
  }
  return { value: v, note: notes.join(' ') }
}

export function checkLimit(n: unknown): number | undefined {
  if (n === undefined || n === null) return undefined
  const v = Number(n)
  if (!Number.isInteger(v) || v < 1 || v > 100_000) throw new Error('limit must be a whole number from 1 to 100000.')
  return v
}
