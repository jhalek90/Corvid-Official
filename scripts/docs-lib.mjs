// The docs model shared by the docs manifest, the docs linter, the in-app Docs view and the website builder. Pure:
// no file system, no dependencies. Callers pass the files in and get plain data back.
//
// The docs live in docs/: index.md is the entry page, docs/sections.json lists the sections, and every page is
// docs/<section>/<page>.md with a front matter block (title, summary, section, order). See docs/WRITING.md.

export const PAGE_FIELDS = ['title', 'summary', 'section', 'order']

// A front matter block: "---", then "key: value" lines, then "---", at the very top of the file. Values are plain
// strings (quotes around them are dropped), except order, which must be a whole number. Returns the fields, the body
// and the 1-based line the body starts on, or an error with its line.
export function parseFrontMatter(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0] !== '---') return { error: 'no front matter: the file must start with a "---" line', line: 1, body: text, bodyLine: 1 }
  const data = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === '---') return { data, body: lines.slice(i + 1).join('\n'), bodyLine: i + 2 }
    if (!line.trim()) continue
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!m) return { error: `front matter line is not "key: value": ${line}`, line: i + 1, body: text, bodyLine: 1 }
    if (m[1] in data) return { error: `front matter has "${m[1]}" twice`, line: i + 1, body: text, bodyLine: 1 }
    let value = m[2].trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    data[m[1]] = value
  }
  return { error: 'front matter is not closed with a "---" line', line: 1, body: text, bodyLine: 1 }
}

// The anchor a heading gets, the way GitHub makes it: lower case, punctuation dropped, spaces to hyphens.
export function slugify(heading) {
  return plainInline(heading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

// Markdown inline syntax to plain text: links and images keep their text, code keeps its content, emphasis and HTML
// go.
export function plainInline(s) {
  return s
    .replace(/<!--.*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/g, '$1$2')
}

// Splits a Markdown body into lines tagged by kind, with fenced code marked so checks can skip it.
// kind: 'blank' | 'fence' (a ``` line) | 'code' (inside a fence) | 'heading' | 'table' | 'list' | 'quote' | 'html' | 'text'
export function scanLines(body, firstLine = 1) {
  const out = []
  let fence = null
  for (const [i, text] of body.split(/\r?\n/).entries()) {
    const line = firstLine + i
    const f = /^\s*(```+|~~~+)/.exec(text)
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) { out.push({ line, text, kind: 'fence' }); fence = null }
      else out.push({ line, text, kind: 'code' })
      continue
    }
    if (f) { fence = f[1]; out.push({ line, text, kind: 'fence' }); continue }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text)
    if (h) { out.push({ line, text, kind: 'heading', level: h[1].length, heading: h[2] }); continue }
    let kind = 'text'
    if (!text.trim()) kind = 'blank'
    else if (/^\s*\|/.test(text)) kind = 'table'
    else if (/^\s*([-*+]|\d+[.)])\s+/.test(text)) kind = 'list'
    else if (/^\s*>/.test(text)) kind = 'quote'
    else if (/^\s*<!--.*-->\s*$/.test(text)) kind = 'html'
    out.push({ line, text, kind })
  }
  return out
}

// Every [text](target) and ![alt](target) outside code, with its line. Inline code spans are skipped.
export function findLinks(scanned) {
  const links = []
  for (const l of scanned) {
    if (l.kind === 'code' || l.kind === 'fence') continue
    const text = l.text.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    for (const m of text.matchAll(/(!?)\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)) {
      links.push({ line: l.line, image: m[1] === '!', text: m[2], target: m[3] })
    }
  }
  return links
}

// A link target that points inside the docs: no scheme, not mailto, not only an anchor.
export function isInternal(target) {
  return !!target && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//') && !target.startsWith('#')
}

// Resolves a relative link from one docs path to another ("a/b.md" + "../c/d.md#x" -> { path: "c/d.md", anchor: "x" }).
// Paths are relative to docs/, with forward slashes. A link that climbs out of docs/ gets outside: true.
export function resolveLink(fromPath, target) {
  const [rawPath, anchor = ''] = target.split('#')
  const parts = fromPath.split('/').slice(0, -1)
  let outside = false
  for (const p of decodeURI(rawPath).split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') { if (parts.length) parts.pop(); else outside = true }
    else parts.push(p)
  }
  return { path: parts.join('/'), anchor, outside }
}

// Headings, then plain text, of a page body: what the search box looks in. No Markdown syntax, one space between
// words.
export function searchText(body) {
  const scanned = scanLines(body)
  const headings = []
  const text = []
  for (const l of scanned) {
    if (l.kind === 'fence' || l.kind === 'blank' || l.kind === 'html') continue
    if (l.kind === 'heading') { headings.push(plainInline(l.heading)); continue }
    let t = l.text
    if (l.kind === 'table') { if (/^\s*\|?[\s:|-]+\|?\s*$/.test(t)) continue; t = t.replace(/\|/g, ' ') }
    if (l.kind === 'list') t = t.replace(/^\s*([-*+]|\d+[.)])\s+/, '')
    if (l.kind === 'quote') t = t.replace(/^\s*>\s?/, '')
    text.push(plainInline(t))
  }
  const squash = (a) => a.join(' ').replace(/\s+/g, ' ').trim()
  return { headings, text: squash(text) }
}

// Builds the docs manifest from the docs files.
//   files: [{ path: 'getting-started/install.md', text }]  every .md under docs/, paths relative to docs/
//   sections: [{ id, title, order }]                       from docs/sections.json
//   assets: Set of other file paths under docs/ (images), for checking image links
// Pages are the .md files inside a section folder, plus index.md. Files at the top of docs/ other than index.md
// (WRITING.md, PLATFORM.md and so on) are not pages and are left out.
// Returns { manifest, errors } where errors are [{ path, line, message }]. The manifest is built even with errors,
// from the pages that could be read.
export function buildManifest({ files, sections, assets = new Set() }) {
  const errors = []
  const err = (path, line, message) => errors.push({ path, line, message })
  const sectionIds = new Map()
  for (const s of sections ?? []) {
    if (!s || typeof s.id !== 'string' || typeof s.title !== 'string' || !Number.isInteger(s.order)) {
      err('sections.json', 1, `a section needs an id, a title and a whole-number order: ${JSON.stringify(s)}`)
      continue
    }
    if (sectionIds.has(s.id)) err('sections.json', 1, `section "${s.id}" is listed twice`)
    sectionIds.set(s.id, { id: s.id, title: s.title, order: s.order, pages: [] })
  }

  const all = new Set(files.map((f) => f.path))
  let index = null
  const pages = []
  const search = []
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const isIndex = f.path === 'index.md'
    const parts = f.path.split('/')
    if (!isIndex && parts.length !== 2) continue
    const fm = parseFrontMatter(f.text)
    if (fm.error) { err(f.path, fm.line, fm.error); continue }
    const d = fm.data
    for (const k of isIndex ? ['title', 'summary'] : PAGE_FIELDS) if (!d[k]) err(f.path, 1, `front matter is missing "${k}"`)
    if (!d.title) continue
    let order = 0
    if (!isIndex) {
      order = Number(d.order)
      if (d.order && !/^\d+$/.test(d.order)) err(f.path, 1, `order must be a whole number, not "${d.order}"`)
      if (d.section && !sectionIds.has(d.section)) err(f.path, 1, `unknown section "${d.section}" (sections are listed in docs/sections.json)`)
      else if (d.section && d.section !== parts[0]) err(f.path, 1, `section "${d.section}" doesn't match the folder "${parts[0]}"`)
    }
    const page = { title: d.title, summary: d.summary ?? '', path: f.path }
    if (isIndex) index = page
    else pages.push({ ...page, section: d.section, order })
    const st = searchText(fm.body)
    search.push({ path: f.path, title: d.title, section: isIndex ? null : d.section, headings: st.headings, text: st.text })

    for (const link of findLinks(scanLines(fm.body, fm.bodyLine))) {
      if (!isInternal(link.target)) continue
      const r = resolveLink(f.path, link.target)
      if (r.outside) continue // a link to the repo (README.md, source files) isn't checked here
      if (!r.path) continue
      if (!all.has(r.path) && !assets.has(r.path)) {
        err(f.path, link.line, `${link.image ? 'image' : 'link'} to a missing file: ${link.target}`)
      }
    }
  }
  if (!index) err('index.md', 1, 'docs/index.md is missing or has no title')

  for (const p of pages) {
    const s = sectionIds.get(p.section)
    if (!s || p.section !== p.path.split('/')[0]) continue
    const clash = s.pages.find((q) => q.order === p.order)
    if (clash) err(p.path, 1, `order ${p.order} is already used by ${clash.path} in section "${s.id}"`)
    s.pages.push({ title: p.title, summary: p.summary, order: p.order, path: p.path })
  }
  const nav = [...sectionIds.values()].sort((a, b) => a.order - b.order)
  for (const s of nav) s.pages.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))
  return { manifest: { version: 1, index, sections: nav, search }, errors }
}
