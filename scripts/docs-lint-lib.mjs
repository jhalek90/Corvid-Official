// The docs linter's checks: the mechanical rules of the ASD+ writing standard (docs/ASD-PLUS.md) plus the docs'
// own structure (front matter, links, images, headings, every page reachable from the index). Pure, like
// docs-lib.mjs: callers pass text in and get findings back. scripts/docs-lint.mjs is the command.
//
// A finding is { path, line, level: 'error' | 'warn', rule, message }. rule is the ASD+ rule number where there is
// one ("1.8"), or a short name for the docs' own checks ("links"). Errors fail the run; warnings only print.
//
// Quoting a banned word is fine inside inline code or a fenced block, or with <!-- asd-ignore: reason --> on the
// same line or the line before. The reason is required.

import { buildManifest, findLinks, isInternal, parseFrontMatter, plainInline, resolveLink, scanLines, slugify } from './docs-lib.mjs'

// Which rule each check reports. The numbers are those of docs/ASD-PLUS.md; "6" is its Part 6 table. Checks the
// standard has no number for are named after their section in docs/WRITING.md.
export const RULES = {
  emDash: { rule: '1.8', level: 'error' },
  emoji: { rule: '1.6', level: 'error' },
  banned: { rule: '6', level: 'error' },
  weasel: { rule: '1.9', level: 'error' },
  todo: { rule: '5.3', level: 'error' },
  shortPageHeader: { rule: '3.1', level: 'warn' },
  longParagraph: { rule: '2.6', level: 'warn' },
  acronym: { rule: '1.3', level: 'warn' },
  ignore: { rule: 'asd-ignore', level: 'error' },
  frontMatter: { rule: 'front-matter', level: 'error' },
  title: { rule: 'front-matter', level: 'warn' },
  links: { rule: 'links', level: 'error' },
  images: { rule: 'images', level: 'error' },
  reachable: { rule: 'index', level: 'error' },
  headings: { rule: 'headings', level: 'error' },
  standard: { rule: 'standard', level: 'error' },
}

// Acronyms that need no spelled-out form on first use: the common ones, plus Corvid's own terms (HTTP and SSH are
// in the names of its built-in connectors, "HTTP API" and "SSH server").
export const ACRONYM_ALLOW = new Set([
  'API', 'CLI', 'URL', 'JSON', 'ASD', 'MCP', 'ID', 'OK', 'UI', 'PC', 'PNG', 'HTML', 'CSS', 'PDF', 'GIF', 'CSV', 'TODO',
  'HTTP', 'HTTPS', 'SSH', 'CI',
  // the risk labels of ASD+ rule 4.8
  'NOTE', 'CAUTION', 'WARNING',
])

export const LONG_PARAGRAPH = { sentences: 6, words: 120 }
export const SHORT_PAGE_WORDS = 100

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A case-insensitive regex for a word or phrase, matched as whole words.
export function termPattern(term) {
  const body = term.trim().split(/\s+/).map(escapeRe).join('\\s+').replace(/['’]/g, "['’]")
  const start = /^\w/.test(term.trim()) ? '\\b' : ''
  const end = /\w$/.test(term.trim()) ? '\\b' : ''
  return new RegExp(`${start}${body}${end}`, 'giu')
}

// Words quoted in a piece of the standard: "x", “x”, `x` or *x*. A slash or comma list inside one quote ("a / b")
// gives each part.
export function quotedTerms(text) {
  const terms = []
  for (const m of text.matchAll(/"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`|(?<!\*)\*([^*\n]+)\*(?!\*)/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4]
    for (const t of raw.split(/\s*[/,]\s*/)) {
      const term = t.replace(/^[\s'‘]+|[\s'’.…]+$/g, '').trim()
      if (term && /\w/.test(term) && term.length <= 60) terms.push(term)
    }
  }
  return terms
}

// The words in one cell of the Part 6 table: "leverage", "I'll just / simply / basically", "navigate (non-literal)",
// "showcase(s) / boasts". Notes in brackets are dropped, "(s)" gives both forms, and the em dash row is left to rule
// 1.8.
export function bannedTerms(cell) {
  const terms = []
  for (const part of plainInline(cell).split('/')) {
    const t = part.replace(/\(s\)/g, '\u0000').replace(/\([^)]*\)/g, '').trim()
    if (!/\w/.test(t)) continue
    if (t.includes('\u0000')) terms.push(t.replace('\u0000', ''), t.replace('\u0000', 's'))
    else terms.push(t)
  }
  return terms
}

// Reads what the linter needs from docs/ASD-PLUS.md, so the word lists are kept in one place:
//   rules: the rule numbers it has ("1.8"), banned: [{ term, instead, line }] from the Part 6 table,
//   weasel: the words quoted in rule 1.9. errors: what couldn't be read.
export function parseStandard(text) {
  const lines = text.split(/\r?\n/)
  const rules = new Set()
  const errors = []
  for (const l of lines) {
    const m = /^\s*(?:#{1,6}\s*|[-*]\s+|\d+[.)]\s+)?(?:\*\*|__)?(?:Rule\s+)?(\d+\.\d+)[.):\s*_]/i.exec(l)
    if (m) rules.add(m[1])
  }

  // Part 6: the first table after a heading that names Part 6, up to the next heading of the same level or higher
  const banned = []
  const p6 = lines.findIndex((l) => /^#{1,6}\s.*\bpart\s*6\b/i.test(l))
  if (p6 < 0) errors.push('no heading for Part 6 (the banned words table)')
  else {
    const level = /^#+/.exec(lines[p6])[0].length
    let inTable = false
    let pastHeader = false
    for (let i = p6 + 1; i < lines.length; i++) {
      const h = /^(#{1,6})\s/.exec(lines[i])
      if (h && h[1].length <= level) break
      if (!/^\s*\|/.test(lines[i])) { if (inTable) break; continue }
      inTable = true
      const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      if (cells.every((c) => /^:?-+:?$/.test(c))) { pastHeader = true; continue }
      if (!pastHeader) continue // the header row
      for (const term of bannedTerms(cells[0] ?? '')) banned.push({ term, instead: plainInline(cells[1] ?? '').trim(), line: i + 1 })
    }
    if (!banned.length) errors.push('found no rows in the Part 6 table')
  }

  // Rule 1.9: from its line to the next rule
  const weasel = []
  const r19 = lines.findIndex((l) => /^\s*(?:#{1,6}\s*|[-*]\s+)?(?:\*\*|__)?(?:Rule\s+)?1\.9[.):\s*_]/i.test(l))
  if (r19 < 0) errors.push('no rule 1.9 (weasel words)')
  else {
    const block = [lines[r19]]
    for (let i = r19 + 1; i < lines.length; i++) {
      if (/^\s*(?:#{1,6}\s*|[-*]\s+)?(?:\*\*|__)?(?:Rule\s+)?\d+\.\d+[.):\s*_]/i.test(lines[i]) || /^#{1,6}\s/.test(lines[i])) break
      block.push(lines[i])
    }
    weasel.push(...quotedTerms(block.join('\n')))
    if (!weasel.length) errors.push('found no quoted words in rule 1.9')
  }
  return { rules, banned, weasel: [...new Set(weasel.map((w) => w.toLowerCase()))], errors }
}

// The text the prose rules look at, per line: code, link targets and HTML comments blanked out (same length, so
// columns stay right), and lines covered by an asd-ignore marker left out.
function proseLines(scanned, add) {
  const ignored = new Set()
  for (const l of scanned) {
    if (l.kind === 'code' || l.kind === 'fence') continue
    for (const m of l.text.matchAll(/<!--\s*asd-ignore\b:?\s*(.*?)\s*-->/g)) {
      if (!m[1]) add(l.line, RULES.ignore, 'asd-ignore needs a reason: <!-- asd-ignore: why this word is needed -->')
      ignored.add(l.line).add(l.line + 1)
    }
  }
  const blank = (m) => ' '.repeat(m.length)
  return scanned
    .filter((l) => l.kind !== 'code' && l.kind !== 'fence' && !ignored.has(l.line))
    .map((l) => ({
      ...l,
      prose: l.text
        .replace(/<!--.*?-->/g, blank)
        .replace(/`[^`]*`/g, blank)
        .replace(/\]\([^)]*\)/g, (m) => ']' + ' '.repeat(m.length - 1))
        .replace(/<https?:[^>]*>|\bhttps?:\/\/\S+/g, blank),
    }))
}

const words = (s) => plainInline(s).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w))

// Lints one Markdown file.
//   path: for the findings; standard: from parseStandard; page: true for docs pages (index.md and section pages),
//   which must start with an H1 and get the short-page check.
//   checkLink(link): optional, returns an error message for a broken link or image, or null.
export function lintMarkdown(text, { path, standard, page = false, checkLink } = {}) {
  const findings = []
  const add = (line, r, message) => findings.push({ path, line, level: r.level, rule: r.rule, message })
  const fm = text.startsWith('---') ? parseFrontMatter(text) : { body: text, bodyLine: 1 }
  const scanned = scanLines(fm.error ? text : fm.body, fm.error ? 1 : fm.bodyLine)

  const prose = proseLines(scanned, add)
  const seenAcronyms = new Set()
  for (const l of prose) {
    const t = l.prose
    if (t.includes('—')) add(l.line, RULES.emDash, 'em dash: use a full stop, a colon or a comma instead')
    const emoji = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u.exec(t)
    if (emoji) add(l.line, RULES.emoji, `emoji "${emoji[0]}": say it in words`)
    // longest terms first, so "delve into" is reported once and not again as "delve"
    const taken = []
    for (const b of [...(standard?.banned ?? [])].sort((x, y) => y.term.length - x.term.length)) {
      for (const m of t.matchAll(termPattern(b.term))) {
        if (taken.some(([s, e]) => m.index < e && m.index + m[0].length > s)) continue
        taken.push([m.index, m.index + m[0].length])
        add(l.line, RULES.banned, `"${m[0]}" is on the banned list (Part 6)${b.instead ? `: ${b.instead}` : ''}`)
      }
    }
    for (const w of standard?.weasel ?? []) {
      for (const m of t.matchAll(termPattern(w))) add(l.line, RULES.weasel, `weasel word "${m[0]}": cut it, or say exactly how much`)
    }
    for (const m of t.matchAll(/\bTODO\b(.{0,3})/g)) {
      if (!/^\s*[:(-]\s*\S/.test(m[1])) add(l.line, RULES.todo, 'TODO without a reason: write "TODO: what is missing and why"')
    }
    // not part of a file name or a hyphenated word, like ASD-PLUS.md
    for (const m of t.matchAll(/(?<![-\w.])[A-Z][A-Z0-9]+(?=s?\b)(?![-.]\w)/g)) {
      const a = m[0]
      if (/^\d+$/.test(a) || ACRONYM_ALLOW.has(a) || seenAcronyms.has(a)) continue
      seenAcronyms.add(a)
      const before = t.slice(0, m.index)
      const after = t.slice(m.index + a.length)
      if (/\(\s*$/.test(before) || /^s?\s*\(/.test(after)) continue // "Secure Shell (SSH)" or "SSH (Secure Shell)"
      add(l.line, RULES.acronym, `"${a}" on first use: spell it out once, like "Secure Shell (SSH)", or add it to the allow-list`)
    }
  }

  // headings: one H1, first; no skipped levels
  const headings = scanned.filter((l) => l.kind === 'heading')
  let last = 0
  for (const [i, h] of headings.entries()) {
    if (i === 0 && page && h.level !== 1) add(h.line, RULES.headings, 'a page starts with its title as a level 1 heading (# Title)')
    if (i > 0 && h.level === 1) add(h.line, RULES.headings, 'only one level 1 heading per page')
    if (last && h.level > last + 1) add(h.line, RULES.headings, `heading jumps from level ${last} to level ${h.level}`)
    last = h.level
  }
  if (page && !headings.length) add(fm.bodyLine ?? 1, RULES.headings, 'a page starts with its title as a level 1 heading (# Title)')
  if (page && fm.data?.title && headings[0]?.level === 1 && plainInline(headings[0].heading) !== fm.data.title) {
    add(headings[0].line, RULES.title, `the heading "${headings[0].heading}" doesn't match the front matter title "${fm.data.title}"`)
  }

  // paragraphs: text lines in a row, or a list item with its continuation lines
  const paragraphs = []
  let cur = null
  for (const l of scanned) {
    if (l.kind === 'text' || l.kind === 'quote') {
      if (!cur) { cur = { line: l.line, text: [] }; paragraphs.push(cur) }
      cur.text.push(l.text)
    } else if (l.kind === 'list') {
      cur = { line: l.line, text: [l.text.replace(/^\s*([-*+]|\d+[.)])\s+/, '')] }
      paragraphs.push(cur)
    } else cur = null
  }
  for (const p of paragraphs) {
    const plain = plainInline(p.text.join(' ').replace(/`[^`]*`/g, 'code'))
    const n = words(plain).length
    const sentences = (plain.replace(/\b(e\.g|i\.e|etc|vs)\./gi, '$1').match(/[.!?](\s|$)/g) ?? []).length
    if (sentences > LONG_PARAGRAPH.sentences || n > LONG_PARAGRAPH.words) {
      add(p.line, RULES.longParagraph, `long paragraph (${sentences} sentences, ${n} words): split it, or make it a list`)
    }
  }

  if (page) {
    const bodyWords = scanned.filter((l) => !['heading', 'code', 'fence', 'html'].includes(l.kind)).reduce((n, l) => n + words(l.text).length, 0)
    const sub = headings.find((h) => h.level >= 2)
    if (sub && bodyWords < SHORT_PAGE_WORDS) add(sub.line, RULES.shortPageHeader, `a page of ${bodyWords} words needs no section headings`)
  }

  for (const link of findLinks(scanned)) {
    if (link.image && !link.text.trim()) add(link.line, RULES.images, `image without alt text: ${link.target}`)
    const message = checkLink?.(link)
    if (message) add(link.line, link.image ? RULES.images : RULES.links, message)
  }
  return findings
}

// The anchors a Markdown body offers: its headings' slugs, numbered for repeats the way GitHub does it.
export function anchors(text) {
  const fm = text.startsWith('---') ? parseFrontMatter(text) : { body: text }
  const seen = new Map()
  const out = new Set()
  for (const l of scanLines(fm.error ? text : fm.body)) {
    if (l.kind !== 'heading') continue
    const s = slugify(l.heading)
    const n = seen.get(s) ?? 0
    seen.set(s, n + 1)
    out.add(n ? `${s}-${n}` : s)
  }
  return out
}

// Lints the whole docs tree: every page, the front matter and nav (through buildManifest), links and anchors
// between pages, and that every page can be reached from index.md by following links.
//   files, sections, assets: as for buildManifest; standardText: docs/ASD-PLUS.md (null if it's missing);
//   extra: other docs files to lint for prose only, like WRITING.md.
export function lintTree({ files, sections, assets = new Set(), standardText, extra = [] }) {
  const findings = []
  let standard = null
  if (standardText == null) {
    findings.push({ path: 'ASD-PLUS.md', line: 1, level: 'error', rule: 'standard', message: 'docs/ASD-PLUS.md is missing: the banned words come from it' })
  } else {
    standard = parseStandard(standardText)
    for (const e of standard.errors) findings.push({ path: 'ASD-PLUS.md', line: 1, level: 'error', rule: 'standard', message: `can't read the standard: ${e}` })
    for (const r of Object.values(RULES)) {
      if (/^\d+\.\d+$/.test(r.rule) && !standard.rules.has(r.rule)) {
        findings.push({ path: 'ASD-PLUS.md', line: 1, level: 'warn', rule: 'standard', message: `the linter reports rule ${r.rule}, but docs/ASD-PLUS.md has no rule ${r.rule}` })
      }
    }
  }

  const { manifest, errors } = buildManifest({ files, sections, assets })
  for (const e of errors) {
    const r = /missing file/.test(e.message) ? (/^image/.test(e.message) ? RULES.images : RULES.links) : RULES.frontMatter
    findings.push({ path: e.path, line: e.line, level: r.level, rule: r.rule, message: e.message })
  }

  const byPath = new Map(files.map((f) => [f.path, f]))
  const pagePaths = new Set([manifest.index?.path, ...manifest.sections.flatMap((s) => s.pages.map((p) => p.path))].filter(Boolean))
  const anchorCache = new Map()
  const anchorsOf = (p) => {
    if (!anchorCache.has(p)) anchorCache.set(p, anchors(byPath.get(p)?.text ?? ''))
    return anchorCache.get(p)
  }
  const linkGraph = new Map()

  const lintOne = (f, page) => {
    const out = new Set()
    linkGraph.set(f.path, out)
    const checkLink = (link) => {
      if (link.target.startsWith('#')) {
        const a = decodeURI(link.target.slice(1))
        return a && !anchorsOf(f.path).has(a) ? `link to a missing heading on this page: ${link.target}` : null
      }
      if (!isInternal(link.target)) return null
      const r = resolveLink(f.path, link.target)
      if (r.outside || !r.path) return null
      out.add(r.path)
      // a missing file is reported once, by buildManifest, for pages
      if (!byPath.has(r.path) && !assets.has(r.path)) return page ? null : `${link.image ? 'image' : 'link'} to a missing file: ${link.target}`
      if (r.anchor && byPath.has(r.path) && !anchorsOf(r.path).has(decodeURI(r.anchor))) return `link to a missing heading: ${link.target}`
      return null
    }
    findings.push(...lintMarkdown(f.text, { path: f.path, standard, page, checkLink }))
    if (page) {
      const fm = parseFrontMatter(f.text)
      for (const k of Object.keys(fm.data ?? {})) {
        if (!['title', 'summary', 'section', 'order'].includes(k)) findings.push({ path: f.path, line: 1, level: 'warn', rule: 'front-matter', message: `unknown front matter field "${k}"` })
      }
      const s = fm.data?.summary
      if (s && (!/[.!?]$/.test(s) || /[.!?]\s+\S/.test(s))) {
        findings.push({ path: f.path, line: 1, level: 'error', rule: 'front-matter', message: 'the summary is one sentence that ends with a full stop' })
      }
    }
  }
  for (const p of pagePaths) lintOne(byPath.get(p), true)
  for (const f of extra) lintOne(f, false)

  // reachable: follow links from index.md
  if (manifest.index) {
    const seen = new Set(['index.md'])
    const queue = ['index.md']
    while (queue.length) for (const next of linkGraph.get(queue.shift()) ?? []) if (pagePaths.has(next) && !seen.has(next)) { seen.add(next); queue.push(next) }
    for (const p of pagePaths) if (!seen.has(p)) findings.push({ path: p, line: 1, level: 'error', rule: 'index', message: 'no link path from index.md reaches this page' })
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
}

export function formatFinding(f, prefix = 'docs/') {
  return `${prefix}${f.path}:${f.line}: ${f.level === 'error' ? 'error' : 'warn'} [${f.rule}] ${f.message}`
}
