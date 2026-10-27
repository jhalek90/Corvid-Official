// Tests for #188, the in-app Docs view's model (src/shared/docs.ts): the Markdown parser, the search, link and image
// resolution, and a render check of every page in docs/: each one parses, every internal link and image resolves,
// and no raw HTML survives outside code. Pure functions on the repo's docs/ folder; no app or data folder is touched.
//
//   npm run test-docs-view

import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readDocsTree } from './docs-manifest.mjs'

const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function load(u, c, next) {
      return /\\.ts(?:\\?|$)/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)
const D = await import(src + 'shared/docs.ts')

const entries = [
  { path: 'a/connections.md', title: 'Connections overview', section: 'a', headings: ['Safety'], text: 'Connections reach servers and APIs.' },
  { path: 'a/ssh.md', title: 'SSH servers', section: 'a', headings: ['Upload a file'], text: 'An SSH connection runs commands. It uses connections too.' },
  { path: 'b/board.md', title: 'Message board', section: 'b', headings: ['Channels'], text: 'The board has a channel per project.' }
]

test('search: title matches come before heading and body matches, every word must match', () => {
  const hits = D.searchDocs(entries, 'connections')
  assert.deepEqual(hits.map((h) => h.path), ['a/connections.md', 'a/ssh.md'])
  assert.equal(hits[0].where, 'title')
  assert.equal(hits[1].where, 'text')
  assert.deepEqual(D.searchDocs(entries, 'channels').map((h) => [h.path, h.where]), [['b/board.md', 'heading']])
  assert.deepEqual(D.searchDocs(entries, 'ssh upload').map((h) => h.path), ['a/ssh.md'])
  assert.deepEqual(D.searchDocs(entries, 'ssh banana'), [])
  assert.deepEqual(D.searchDocs(entries, '   '), [])
})

test('search: the snippet marks the first match in the body', () => {
  const [hit] = D.searchDocs(entries, 'project')
  assert.equal(hit.snippet.slice(hit.mark.start, hit.mark.start + hit.mark.len).toLowerCase(), 'project')
  const long = { path: 'x/y.md', title: 'Y', section: 'x', headings: [], text: 'word '.repeat(60) + 'needle ' + 'word '.repeat(60) }
  const [h] = D.searchDocs([long], 'needle')
  assert.ok(h.snippet.startsWith('…') && h.snippet.endsWith('…'))
  assert.equal(h.snippet.slice(h.mark.start, h.mark.start + h.mark.len), 'needle')
})

test('links: pages, anchors, external, missing and blocked', () => {
  const pages = new Set(['index.md', 'settings/reference.md', 'connections/overview.md'])
  assert.deepEqual(D.resolveDocLink('connections/overview.md', '../settings/reference.md#profile', pages), { kind: 'page', path: 'settings/reference.md', anchor: 'profile' })
  assert.deepEqual(D.resolveDocLink('index.md', 'settings/reference.md', pages), { kind: 'page', path: 'settings/reference.md', anchor: '' })
  assert.deepEqual(D.resolveDocLink('index.md', '#intro', pages), { kind: 'anchor', anchor: 'intro' })
  assert.deepEqual(D.resolveDocLink('index.md', 'https://example.com/x', pages), { kind: 'external', url: 'https://example.com/x' })
  assert.deepEqual(D.resolveDocLink('index.md', 'nope/gone.md', pages), { kind: 'missing', path: 'nope/gone.md' })
  assert.deepEqual(D.resolveDocLink('help/faq.md', '../../LICENSE', pages), { kind: 'source', path: 'LICENSE' })
  assert.deepEqual(D.resolveDocLink('help/faq.md', '../SECURITY.md', pages, new Set([...pages, 'SECURITY.md'])), { kind: 'source', path: 'docs/SECURITY.md' })
  for (const bad of ['javascript:alert(1)', 'file:///c:/x', 'mailto:a@b.c', 'data:text/html,x']) assert.equal(D.resolveDocLink('index.md', bad, pages).kind, 'blocked')
  assert.deepEqual(D.docTarget('settings/reference#profile'), { path: 'settings/reference.md', anchor: 'profile' })
  assert.deepEqual(D.docTarget('index'), { path: 'index.md', anchor: '' })
})

test('images: only bundled files from docs/ load', () => {
  const assets = new Map([['images/tasks-dark.png', '/assets/tasks-dark.png']])
  assert.equal(D.resolveDocImage('tasks-and-agents/task-board.md', '../images/tasks-dark.png', assets), '/assets/tasks-dark.png')
  assert.equal(D.resolveDocImage('index.md', 'https://example.com/x.png', assets), undefined)
  assert.equal(D.resolveDocImage('index.md', '../../secret.png', assets), undefined)
  assert.equal(D.resolveDocImage('index.md', 'images/none.png', assets), undefined)
})

test('markdown: blocks, inline runs, anchors and callouts', () => {
  const b = D.parseMarkdown(
    [
      '# Title',
      '',
      'Some **bold**, *em*, `code` and a [link](x.md). <b onclick="x">raw</b>',
      '',
      '- one',
      '  - nested',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      '| A | B |',
      '|---|--:|',
      '| 1 | 2 |',
      '',
      '```js',
      'const a = 1',
      '```',
      '',
      'WARNING: this deletes things.',
      '',
      '> NOTE: context here.',
      '',
      '## Title',
      '<!-- asd-ignore: reason -->'
    ].join('\n')
  )
  assert.deepEqual(b.map((x) => x.t), ['heading', 'para', 'list', 'list', 'table', 'code', 'callout', 'callout', 'heading'])
  assert.deepEqual([b[0].id, b[8].id], ['title', 'title-1'])
  assert.deepEqual(b[1].inl.map((x) => x.t), ['text', 'strong', 'text', 'em', 'text', 'code', 'text', 'link', 'text'])
  assert.ok(b[1].inl.at(-1).text.includes('<b onclick="x">raw</b>'), 'raw HTML stays literal text')
  assert.equal(b[2].items.length, 2)
  assert.equal(b[2].items[0][1].t, 'list')
  assert.equal(b[3].ordered, true)
  assert.deepEqual(b[4].align, ['', 'right'])
  assert.deepEqual([b[5].lang, b[5].text], ['js', 'const a = 1'])
  assert.equal(b[6].kind, 'warning')
  assert.equal(D.inlineText(b[6].blocks[0].inl), 'this deletes things.')
  assert.equal(b[7].kind, 'note')
})

test('every page in docs/ renders: no throw, no broken internal link or image, no raw HTML outside code', () => {
  const tree = readDocsTree()
  const assets = new Map([...tree.assets].map((p) => [p, `/bundled/${p}`]))
  const docs = D.loadDocs(tree.files, tree.sections, tree.assets)
  assert.deepEqual(docs.errors, [])
  const order = D.readingOrder(docs.manifest)
  assert.ok(order.length > 10)
  const leaks = []
  for (const path of order) {
    const blocks = D.parseMarkdown(docs.bodies.get(path))
    assert.equal(blocks[0]?.t, 'heading', `${path} starts with a heading`)
    const ids = new Set(D.headingsOf(blocks).map((h) => h.id))
    for (const l of D.linksOf(blocks)) {
      if (l.t === 'image') {
        assert.ok(D.resolveDocImage(path, l.src, assets), `${path}: image ${l.src} is bundled`)
        assert.ok(l.alt.trim(), `${path}: image ${l.src} has alt text`)
        continue
      }
      const r = D.resolveDocLink(path, l.href, docs.pages, docs.files)
      assert.notEqual(r.kind, 'missing', `${path}: link ${l.href}`)
      assert.notEqual(r.kind, 'blocked', `${path}: link ${l.href}`)
      if (r.kind === 'anchor' && r.anchor) assert.ok(ids.has(r.anchor), `${path}: anchor #${r.anchor}`)
      if (r.kind === 'page' && r.anchor) {
        const there = new Set(D.headingsOf(D.parseMarkdown(docs.bodies.get(r.path))).map((h) => h.id))
        assert.ok(there.has(r.anchor), `${path}: ${l.href}`)
      }
    }
    const walk = (x) => {
      if (Array.isArray(x)) return x.forEach(walk)
      if (!x || typeof x !== 'object') return
      if (x.t === 'code') return
      if (x.t === 'text' && /<\/?[a-z][^>]*>/i.test(x.text)) leaks.push(`${path}: ${x.text}`)
      Object.values(x).forEach(walk)
    }
    walk(blocks)
  }
  assert.deepEqual(leaks, [], 'raw HTML tags shown as text on a page')
})
