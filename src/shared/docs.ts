// The in-app Docs view's model (#188): Markdown pages parsed into data (blocks and inline runs) that the view draws as
// React elements, the search over the manifest's search text, and link resolution between pages. Nothing here builds
// HTML: raw HTML in a page stays literal text, and only http(s) links and images bundled from docs/images get through.
// Pure, so scripts/test-docs-view.mjs can test it on every page. The manifest itself comes from scripts/docs-lib.mjs,
// shared with the docs linter and the website builder.

import { buildManifest, isInternal, parseFrontMatter, resolveLink, slugify, type DocsManifest, type DocsSearchEntry } from '../../scripts/docs-lib.mjs'

export type { DocsManifest, DocsSearchEntry }
export { buildManifest, parseFrontMatter, slugify }

/** The website the docs are also published on, with no trailing slash. Empty until launch: the view hides its
 *  "Open on the website" link while this is empty. A page's web address is this plus its path without ".md". */
export const DOCS_SITE_URL = ''

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong' | 'em'; kids: Inline[] }
  | { t: 'link'; href: string; kids: Inline[] }
  | { t: 'image'; src: string; alt: string }

export type CalloutKind = 'note' | 'caution' | 'warning'

export type Block =
  | { t: 'heading'; level: number; id: string; text: string; inl: Inline[] }
  | { t: 'para'; inl: Inline[] }
  | { t: 'callout'; kind: CalloutKind; blocks: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'table'; align: ('left' | 'center' | 'right' | '')[]; head: Inline[][]; rows: Inline[][][] }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'hr' }

// 1-2 code span, 3-4 image, 5-6 link, 7 autolink, then an HTML comment (dropped), 8-9 strong, 10-11 emphasis, 12 escape
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)|\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^>\s]+)>|<!--[\s\S]*?-->|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([^*]*?[^\s*])\*|(?<!\w)_(?=[^\s_])([^_]*?[^\s_])_(?!\w)|\\([!-/:-@[-`{-~])/g

/** One line (or a paragraph's joined lines) of Markdown inline syntax as runs. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  const text = (t: string): void => {
    if (!t) return
    const last = out[out.length - 1]
    if (last?.t === 'text') last.text += t
    else out.push({ t: 'text', text: t })
  }
  let at = 0
  for (const m of s.matchAll(INLINE)) {
    text(s.slice(at, m.index))
    at = m.index + m[0].length
    if (m[2] !== undefined) out.push({ t: 'code', text: m[2].replace(/^ (.*) $/, '$1') })
    else if (m[4] !== undefined) out.push({ t: 'image', src: m[4], alt: m[3] })
    else if (m[6] !== undefined) out.push({ t: 'link', href: m[6], kids: parseInline(m[5]) })
    else if (m[7] !== undefined) out.push({ t: 'link', href: m[7], kids: [{ t: 'text', text: m[7] }] })
    else if (m[8] !== undefined || m[9] !== undefined) out.push({ t: 'strong', kids: parseInline(m[8] ?? m[9]) })
    else if (m[10] !== undefined || m[11] !== undefined) out.push({ t: 'em', kids: parseInline(m[10] ?? m[11]) })
    else if (m[12] !== undefined) text(m[12])
  }
  text(s.slice(at))
  return out
}

/** The plain text of inline runs, for headings' anchors, image alt text and tests. */
export function inlineText(inl: Inline[]): string {
  return inl.map((x) => (x.t === 'text' || x.t === 'code' ? x.text : x.t === 'image' ? x.alt : inlineText(x.kids))).join('')
}

const FENCE = /^(\s*)(```+|~~~+)\s*([\w+-]*)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const LIST = /^(\s*)([-*+]|(\d{1,9})[.)])(\s+|$)/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const CALLOUT = /^(NOTE|CAUTION|WARNING):\s*/
const COMMENT_LINE = /^\s*<!--.*-->\s*$/

const indentOf = (l: string): number => /^\s*/.exec(l)![0].replace(/\t/g, '    ').length
const blank = (l: string): boolean => !l.trim()
const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))

/** Starts a block other than a paragraph: a paragraph ends at one of these. */
function startsBlock(l: string, next: string | undefined): boolean {
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || /^\s*>/.test(l) || LIST.test(l) || (/^\s*\|/.test(l) && !!next && TABLE_SEP.test(next))
}

/** A Markdown body as blocks. Heading ids are their GitHub-style anchors, made unique with -1, -2 as GitHub does;
 *  `ids` carries the used ones across nested calls. */
export function parseMarkdown(body: string, ids: Map<string, number> = new Map()): Block[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (blank(l) || COMMENT_LINE.test(l)) {
      i++
      continue
    }
    const f = FENCE.exec(l)
    if (f) {
      const mark = f[2]
      const code: string[] = []
      i++
      while (i < lines.length && !(lines[i].trim().startsWith(mark[0].repeat(mark.length)) && /^\s*(```+|~~~+)\s*$/.test(lines[i]))) code.push(lines[i++])
      i++
      const pad = f[1].length
      blocks.push({ t: 'code', lang: f[3].toLowerCase(), text: code.map((c) => c.slice(Math.min(pad, indentOf(c)))).join('\n') })
      continue
    }
    const h = HEADING.exec(l)
    if (h) {
      const inl = parseInline(h[2])
      const base = slugify(h[2])
      const n = ids.get(base) ?? 0
      ids.set(base, n + 1)
      blocks.push({ t: 'heading', level: h[1].length, id: n ? `${base}-${n}` : base, text: inlineText(inl), inl })
      i++
      continue
    }
    if (HR.test(l)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(l)
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''))
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const r = cells(lines[i++])
        rows.push(head.map((_, c) => parseInline(r[c] ?? '')))
      }
      blocks.push({ t: 'table', align, head: head.map(parseInline), rows })
      continue
    }
    if (/^\s*>/.test(l)) {
      const inner: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ''))
      // "> NOTE: ..." is the callout itself: its first paragraph already became one, and the rest of the quote joins it
      const kids = parseMarkdown(inner.join('\n'), ids)
      const first = kids[0]
      blocks.push(first?.t === 'callout' ? { ...first, blocks: [...first.blocks, ...kids.slice(1)] } : { t: 'quote', blocks: kids })
      continue
    }
    const li = LIST.exec(l)
    if (li) {
      const base = li[1].length
      const ordered = li[3] !== undefined
      const items: Block[][] = []
      while (i < lines.length) {
        const m = LIST.exec(lines[i])
        if (!m || m[1].length !== base || (m[3] !== undefined) !== ordered) break
        const content = m[0].length
        const item: string[] = [lines[i].slice(content)]
        i++
        while (i < lines.length) {
          const c = lines[i]
          if (blank(c)) {
            let j = i
            while (j < lines.length && blank(lines[j])) j++
            if (j < lines.length && indentOf(lines[j]) >= content) {
              item.push('')
              i++
              continue
            }
            break
          }
          const ind = indentOf(c)
          const sub = LIST.exec(c)
          if (ind >= content || (sub && sub[1].length > base)) item.push(c.slice(Math.min(ind, content)))
          else if (sub || startsBlock(c, lines[i + 1])) break
          else item.push(c.trim()) // a lazy continuation line
          i++
        }
        items.push(parseMarkdown(item.join('\n'), ids))
        // a blank line between two items of the same list keeps the list going
        let j = i
        while (j < lines.length && blank(lines[j])) j++
        const next = j < lines.length ? LIST.exec(lines[j]) : null
        if (j > i && next && next[1].length === base && (next[3] !== undefined) === ordered) i = j
      }
      blocks.push({ t: 'list', ordered, start: ordered ? Number(li[3]) : 1, items })
      continue
    }
    const para: string[] = []
    while (i < lines.length && !blank(lines[i]) && !(para.length && startsBlock(lines[i], lines[i + 1]))) {
      if (!COMMENT_LINE.test(lines[i])) para.push(lines[i].trim())
      i++
    }
    if (!para.length) continue
    const label = CALLOUT.exec(para[0])
    const p: Block = { t: 'para', inl: parseInline(para.join(' ')) }
    blocks.push(label ? callout(label, [p]) : p)
  }
  return blocks
}

/** NOTE:, CAUTION: or WARNING: at the start of a paragraph (ASD+ rule 4.8), as a callout with the label taken off. */
function callout(label: RegExpExecArray, kids: Block[]): Block {
  const first = kids[0] as Extract<Block, { t: 'para' }>
  const lead = first.inl[0] as Extract<Inline, { t: 'text' }>
  const rest = lead.text.slice(label[0].length)
  const inl = rest ? [{ ...lead, text: rest }, ...first.inl.slice(1)] : first.inl.slice(1)
  return { t: 'callout', kind: label[1].toLowerCase() as CalloutKind, blocks: [{ t: 'para', inl }, ...kids.slice(1)] }
}

/** Every heading of a page, in order: the "on this page" outline uses levels 2 and 3. */
export function headingsOf(blocks: Block[]): Extract<Block, { t: 'heading' }>[] {
  const out: Extract<Block, { t: 'heading' }>[] = []
  const walk = (bs: Block[]): void => {
    for (const b of bs) {
      if (b.t === 'heading') out.push(b)
      else if (b.t === 'list') b.items.forEach(walk)
      else if (b.t === 'quote' || b.t === 'callout') walk(b.blocks)
    }
  }
  walk(blocks)
  return out
}

/** Every link and image of a page, for the render test. */
export function linksOf(blocks: Block[]): Extract<Inline, { t: 'link' | 'image' }>[] {
  const out: Extract<Inline, { t: 'link' | 'image' }>[] = []
  const inl = (xs: Inline[]): void => {
    for (const x of xs) {
      if (x.t === 'link') (out.push(x), inl(x.kids))
      else if (x.t === 'image') out.push(x)
      else if (x.t === 'strong' || x.t === 'em') inl(x.kids)
    }
  }
  const walk = (bs: Block[]): void => {
    for (const b of bs) {
      if (b.t === 'heading' || b.t === 'para') inl(b.inl)
      else if (b.t === 'list') b.items.forEach(walk)
      else if (b.t === 'quote' || b.t === 'callout') walk(b.blocks)
      else if (b.t === 'table') [...b.head, ...b.rows.flat()].forEach(inl)
    }
  }
  walk(blocks)
  return out
}

/** Where a link in a page goes. 'page' and 'anchor' open in place; 'external' opens in the system browser through
 *  the window's open handler (http and https only); 'source' is a file in Corvid's source folder that isn't a page
 *  (docs/SECURITY.md, LICENSE), which the app doesn't ship; 'missing' is a docs link to a page that isn't there;
 *  'blocked' is any other scheme (javascript:, file:, mailto:), drawn as plain text. */
export type DocLink =
  | { kind: 'page'; path: string; anchor: string }
  | { kind: 'anchor'; anchor: string }
  | { kind: 'external'; url: string }
  | { kind: 'source'; path: string }
  | { kind: 'missing'; path: string }
  | { kind: 'blocked'; target: string }

/** `files` is every file under docs/ (pages, other Markdown, images); a link that climbs out of docs/ is taken to be
 *  a source file too, as the docs linter leaves those unchecked. */
export function resolveDocLink(fromPath: string, target: string, pages: ReadonlySet<string>, files: ReadonlySet<string> = pages): DocLink {
  if (target.startsWith('#')) return { kind: 'anchor', anchor: target.slice(1) }
  if (/^https?:\/\/[^\s/]/i.test(target)) return { kind: 'external', url: target }
  if (!isInternal(target)) return { kind: 'blocked', target }
  let r: ReturnType<typeof resolveLink>
  try {
    r = resolveLink(fromPath, target)
  } catch {
    return { kind: 'missing', path: target }
  }
  if (!r.path) return { kind: 'anchor', anchor: r.anchor }
  if (!r.outside && pages.has(r.path)) return { kind: 'page', path: r.path, anchor: r.anchor }
  if (r.outside || files.has(r.path)) return { kind: 'source', path: r.outside ? r.path : `docs/${r.path}` }
  return { kind: 'missing', path: r.path }
}

/** The bundled file an image points at, or undefined: a remote image, or one that isn't in docs/, is never loaded
 *  and the view shows its alt text instead. */
export function resolveDocImage(fromPath: string, src: string, assets: ReadonlyMap<string, string>): string | undefined {
  if (!isInternal(src)) return undefined
  const r = resolveLink(fromPath, src)
  return r.outside ? undefined : assets.get(r.path)
}

/** "settings/reference", "settings/reference.md" or "settings/reference#profile" as a page path and an anchor. */
export function docTarget(id: string): { path: string; anchor: string } {
  const [p, anchor = ''] = id.split('#')
  const path = !p || p === 'index' ? 'index.md' : p.endsWith('.md') ? p : `${p}.md`
  return { path, anchor }
}

/** The reading order: the index, then every section's pages. Previous and next follow it. */
export function readingOrder(m: DocsManifest): string[] {
  return [...(m.index ? [m.index.path] : []), ...m.sections.flatMap((s) => s.pages.map((p) => p.path))]
}

export interface DocsHit {
  path: string
  title: string
  section: string | null
  /** where the words were found: the title scores highest, then a heading, then the body */
  where: 'title' | 'heading' | 'text'
  score: number
  /** a short piece of the body around the first match, with the matched word's place in it */
  snippet: string
  mark?: { start: number; len: number }
}

/** The search box: every word of the query must be in the page, title matches first, then headings, then body text.
 *  Plain lower-case substring matching, which is plenty for some fifty pages. */
export function searchDocs(entries: DocsSearchEntry[], query: string, limit = 20): DocsHit[] {
  const q = query.trim().toLowerCase()
  const words = q.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const hits: DocsHit[] = []
  for (const e of entries) {
    const title = e.title.toLowerCase()
    const heads = e.headings.join(' ').toLowerCase()
    const text = e.text.toLowerCase()
    const every = (hay: string): boolean => words.every((w) => hay.includes(w))
    let where: DocsHit['where']
    let score: number
    if (every(title)) (where = 'title'), (score = 100 + (title.startsWith(q) ? 50 : 0) + (title === q ? 50 : 0))
    else if (every(`${title} ${heads}`)) (where = 'heading'), (score = 60)
    else if (every(`${title} ${heads} ${text}`)) (where = 'text'), (score = 20)
    else continue
    // more mentions of the words in the body rank a page higher within its group, a little
    score += Math.min(10, words.reduce((n, w) => n + text.split(w).length - 1, 0))
    hits.push({ path: e.path, title: e.title, section: e.section, where, score, ...snippetOf(e.text, text, words) })
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit)
}

const BEFORE = 40
const AFTER = 90

function snippetOf(text: string, lower: string, words: string[]): { snippet: string; mark?: { start: number; len: number } } {
  let at = -1
  let len = 0
  for (const w of words) {
    const i = lower.indexOf(w)
    if (i >= 0 && (at < 0 || i < at)) (at = i), (len = w.length)
  }
  if (at < 0) return { snippet: text.slice(0, BEFORE + AFTER).trim() + (text.length > BEFORE + AFTER ? '…' : '') }
  let from = Math.max(0, at - BEFORE)
  if (from > 0) from = text.indexOf(' ', from) + 1 || from
  const to = Math.min(text.length, at + len + AFTER)
  const lead = from > 0 ? '…' : ''
  const snippet = lead + text.slice(from, to) + (to < text.length ? '…' : '')
  return { snippet, mark: { start: lead.length + at - from, len } }
}

/** The docs, from the files in docs/: the manifest and each page's body (front matter taken off), keyed by path. */
export function loadDocs(files: { path: string; text: string }[], sections: { id: string; title: string; order: number }[], assets: Set<string>) {
  const { manifest, errors } = buildManifest({ files, sections, assets })
  const bodies = new Map<string, string>()
  for (const f of files) {
    const fm = parseFrontMatter(f.text)
    if (!fm.error) bodies.set(f.path, fm.body)
  }
  const pages = new Set(readingOrder(manifest))
  const all = new Set([...files.map((f) => f.path), ...assets])
  return { manifest, errors, bodies, pages, files: all }
}
