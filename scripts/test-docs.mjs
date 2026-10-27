// Tests for the docs tooling (#186): the shared docs model and manifest (docs-lib.mjs), the linter's checks
// (docs-lint-lib.mjs), and the real docs/ tree, which must lint without errors.
//   node --test scripts/test-docs.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildManifest, parseFrontMatter, resolveLink, searchText, slugify } from './docs-lib.mjs'
import { lintMarkdown, lintTree, parseStandard } from './docs-lint-lib.mjs'
import { readDocsTree } from './docs-manifest.mjs'

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs')

// a small standard in the same shape as docs/ASD-PLUS.md
const STANDARD = `# ASD+

## Part 1: Words

**1.3** Spell out acronyms.

**1.6 No emojis.** Say it in words.

**1.8 No em dashes.** Use a full stop.

**1.9 No weasel words.** Cut "very", "really" and "basically".

**1.10 Short words.** Prefer short words.

**2.6** Short paragraphs.

## Part 3: Pages

**3.1 No headers on short pages.**

## Part 5: Honesty

**5.3 Say what is missing.**

## Part 6: Banned words

| Avoid | Use instead |
|---|---|
| utilize | use |
| in order to | to |
| leverage / harness | use / apply |
| — (em dash) | period, comma, colon, or parentheses |
| delve / delve into | look at / check |
| navigate (non-literal) | handle / deal with |
| showcase(s) / boasts | has |
| I'll just / simply | (cut the filler word) |

## Part 7: Other

| a | b |
|---|---|
| notbanned | x |
`

const SECTIONS = [{ id: 'start', title: 'Getting started', order: 1 }, { id: 'tasks', title: 'Tasks', order: 2 }]
const page = (title, section, order, body = 'Some words here.') =>
  `---\ntitle: ${title}\nsummary: About ${title.toLowerCase()}.\nsection: ${section}\norder: ${order}\n---\n\n# ${title}\n\n${body}\n`
const goodFiles = () => [
  { path: 'index.md', text: '---\ntitle: Docs\nsummary: The docs.\n---\n\n# Docs\n\n- [Install](start/install.md)\n- [Board](tasks/board.md)\n' },
  { path: 'start/install.md', text: page('Install', 'start', 1, 'See [the board](../tasks/board.md#columns).') },
  { path: 'tasks/board.md', text: page('Board', 'tasks', 1, 'Words.\n\n## Columns\n\n' + 'More words to make the page long enough. '.repeat(15)) },
  { path: 'GUIDE.md', text: '# Old guide — not a page\n' },
]
const standard = parseStandard(STANDARD)
const lint = (text, opts = {}) => lintMarkdown(text, { path: 'x.md', standard, ...opts })
const rules = (findings) => findings.map((f) => `${f.level}:${f.rule}`)

test('front matter: fields, body line, and the errors', () => {
  const fm = parseFrontMatter('---\ntitle: "Install"\norder: 2\n---\n\n# Install\n')
  assert.deepEqual(fm.data, { title: 'Install', order: '2' })
  assert.equal(fm.bodyLine, 5)
  assert.match(parseFrontMatter('# No front matter\n').error, /no front matter/)
  assert.match(parseFrontMatter('---\ntitle: a\n').error, /not closed/)
  assert.match(parseFrontMatter('---\ntitle a\n---\n').error, /key: value/)
  assert.match(parseFrontMatter('---\ntitle: a\ntitle: b\n---\n').error, /twice/)
})

test('links resolve relative to the page, and slugs match GitHub', () => {
  assert.deepEqual(resolveLink('start/install.md', '../tasks/board.md#columns'), { path: 'tasks/board.md', anchor: 'columns', outside: false })
  assert.equal(resolveLink('start/install.md', '../../README.md').outside, true)
  assert.equal(slugify('Plan & ask, and `Auto`'), 'plan--ask-and-auto')
})

test('manifest: nav in order, top-level files left out, search text has no Markdown', () => {
  const { manifest, errors } = buildManifest({ files: goodFiles(), sections: SECTIONS })
  assert.deepEqual(errors, [])
  assert.equal(manifest.index.title, 'Docs')
  assert.deepEqual(manifest.sections.map((s) => [s.id, s.pages.map((p) => p.path)]), [['start', ['start/install.md']], ['tasks', ['tasks/board.md']]])
  assert.ok(!manifest.search.some((s) => s.path === 'GUIDE.md'))
  const install = manifest.search.find((s) => s.path === 'start/install.md')
  assert.deepEqual(install.headings, ['Install'])
  assert.equal(install.text, 'See the board.')
  const st = searchText('## A **bold** `code` head\n\n| a | b |\n|---|---|\n| c | d |\n\n- item [x](y.md)\n```\nfenced\n```\n')
  assert.deepEqual(st.headings, ['A bold code head'])
  assert.equal(st.text, 'a b c d item x fenced')
})

test('manifest: missing front matter, duplicate order, unknown section, wrong folder, missing page', () => {
  const files = [
    ...goodFiles(),
    { path: 'start/none.md', text: '# No front matter\n' },
    { path: 'start/dup.md', text: page('Dup', 'start', 1) },
    { path: 'start/where.md', text: page('Where', 'nowhere', 3) },
    { path: 'start/moved.md', text: page('Moved', 'tasks', 4) },
    { path: 'start/half.md', text: '---\ntitle: Half\n---\n' },
    { path: 'start/bad-order.md', text: page('Bad', 'start', 'two') },
    { path: 'tasks/links.md', text: page('Links', 'tasks', 2, '[gone](gone.md) and ![pic](../images/none.png)') },
  ]
  const { errors } = buildManifest({ files, sections: SECTIONS })
  const msg = (p) => errors.filter((e) => e.path === p).map((e) => e.message).join(' | ')
  assert.match(msg('start/none.md'), /no front matter/)
  assert.ok(errors.some((e) => /order 1 is already used by start\/(dup|install)\.md/.test(e.message)))
  assert.match(msg('start/where.md'), /unknown section "nowhere"/)
  assert.match(msg('start/moved.md'), /doesn't match the folder/)
  assert.match(msg('start/half.md'), /missing "summary".*missing "section".*missing "order"/)
  assert.match(msg('start/bad-order.md'), /whole number/)
  assert.match(msg('tasks/links.md'), /link to a missing file: gone\.md.*image to a missing file/)
  assert.equal(errors.find((e) => e.path === 'tasks/links.md').line, 10) // 6 lines of front matter, the title, then the body
})

test('standard: rule numbers, the Part 6 table only, and the 1.9 words', () => {
  assert.ok(['1.6', '1.8', '1.9', '1.10', '3.1', '5.3'].every((r) => standard.rules.has(r)))
  assert.deepEqual(standard.banned.map((b) => b.term), [
    'utilize', 'in order to', 'leverage', 'harness', 'delve', 'delve into', 'navigate', 'showcase', 'showcases', 'boasts', "I'll just", 'simply',
  ])
  assert.equal(standard.banned[0].instead, 'use')
  assert.deepEqual(standard.weasel, ['very', 'really', 'basically'])
  assert.deepEqual(standard.errors, [])
  assert.deepEqual(parseStandard('# Nothing\n').errors.length, 2)
})

test('standard: the real docs/ASD-PLUS.md reads, with every rule the linter reports', () => {
  const real = parseStandard(readFileSync(join(docsDir, 'ASD-PLUS.md'), 'utf8'))
  assert.deepEqual(real.errors, [])
  for (const r of ['1.3', '1.6', '1.8', '1.9', '2.6', '3.1', '5.3']) assert.ok(real.rules.has(r), r)
  for (const t of ['utilize', 'in order to', 'basically', 'underscores', 'dive into']) assert.ok(real.banned.some((b) => b.term === t), t)
  assert.ok(!real.banned.some((b) => /—|\(/.test(b.term)))
  assert.deepEqual(real.weasel, ['loosely', 'fairly', 'somewhat', 'relatively', 'generally', 'reasonably'])
})

test('lint: the prose rules catch em dashes, emojis, banned and weasel words, bare TODOs', () => {
  const f = lint('# T\n\nWe utilize it — fast 🎉.\n\nIt is very good. In  order to win.\n\nTODO\n\nTODO: screenshot once #190 lands.\n')
  assert.deepEqual(rules(f), ['error:1.8', 'error:1.6', 'error:6', 'error:6', 'error:1.9', 'error:5.3'])
  assert.deepEqual(f.map((x) => x.line), [3, 3, 3, 5, 5, 7])
  assert.match(f[2].message, /"utilize" is on the banned list \(Part 6\): use/)
  assert.deepEqual(lint('# T\n\nUtilization and harnesses, everyday words © 2026.\n'), [])
  assert.deepEqual(rules(lint("# T\n\nWe delve into it. I’ll just look.\n")), ['error:6', 'error:6'], 'one finding per phrase, curly apostrophes too')
})

test('lint: code, fenced blocks, link targets and asd-ignore may quote a banned word', () => {
  const ok = '# T\n\nWrite `utilize` like this. See [the page](very-utilize.md).\n\n```\nutilize — 🎉\n```\n\n' +
    'Do not write utilize. <!-- asd-ignore: quoting the banned word -->\n\n<!-- asd-ignore: the next line quotes it -->\nWe utilize.\n'
  assert.deepEqual(lint(ok), [])
  assert.deepEqual(rules(lint('# T\n\nutilize <!-- asd-ignore -->\n')), ['error:asd-ignore'])
})

test('lint: long paragraphs, headers on short pages and acronyms only warn', () => {
  const long = '# T\n\n' + 'One sentence here. '.repeat(7) + '\n\n- ' + 'word '.repeat(121) + '\n'
  assert.deepEqual(rules(lint(long)), ['warn:2.6', 'warn:2.6'])
  assert.deepEqual(rules(lint('# T\n\nShort.\n\n## Part\n\nShort.\n', { page: true })), ['warn:3.1'])
  const acr = lint('# T\n\nThe REPL runs. The REPL again. Use a JSON file and Windows Subsystem for Linux (WSL), then WSL. Also LSP (Language Server Protocol).\n')
  assert.deepEqual(rules(acr), ['warn:1.3'])
  assert.match(acr[0].message, /"REPL"/)
})

test('lint: heading order and alt text are errors', () => {
  assert.deepEqual(rules(lint('## Not a title\n\nWords.\n', { page: true })), ['error:headings', 'warn:3.1'])
  assert.deepEqual(rules(lint('# T\n\n### Skipped\n\n# Again\n')), ['error:headings', 'error:headings'])
  assert.deepEqual(rules(lint('# T\n\n![](images/a.webp)\n')), ['error:images'])
  assert.deepEqual(lint('# T\n\n```\n# not a heading\n```\n'), [])
})

test('tree: a good tree is clean; unreachable pages, bad anchors and a missing standard are errors', () => {
  const clean = lintTree({ files: goodFiles(), sections: SECTIONS, standardText: STANDARD })
  assert.deepEqual(clean.filter((f) => f.level === 'error'), [])
  const files = goodFiles()
  files[0].text = files[0].text.replace('- [Board](tasks/board.md)\n', '')
  files[1].text = files[1].text.replace('#columns', '#rows')
  files.push({ path: 'tasks/lost.md', text: page('Lost', 'tasks', 2, '[Up](#nowhere).') })
  const f = lintTree({ files, sections: SECTIONS, standardText: STANDARD })
  const errs = f.filter((x) => x.level === 'error').map((x) => `${x.path}:${x.rule}:${x.message}`)
  assert.ok(errs.some((e) => /^start\/install\.md:links:link to a missing heading: \.\.\/tasks\/board\.md#rows/.test(e)))
  assert.ok(errs.some((e) => /^tasks\/lost\.md:links:link to a missing heading on this page/.test(e)))
  assert.ok(errs.some((e) => /^tasks\/lost\.md:index:/.test(e)))
  assert.ok(!errs.some((e) => /^tasks\/board\.md:index:/.test(e)), 'board is reached through install.md')
  assert.ok(lintTree({ files: goodFiles(), sections: SECTIONS, standardText: null }).some((x) => x.rule === 'standard' && x.level === 'error'))
  const stale = lintTree({ files: goodFiles(), sections: SECTIONS, standardText: STANDARD.replace('**3.1', '**3.2') })
  assert.ok(stale.some((x) => x.level === 'warn' && /has no rule 3\.1/.test(x.message)))
})

test('the docs in docs/ lint without errors', () => {
  const tree = readDocsTree(docsDir)
  assert.deepEqual(tree.errors, [])
  const standardPath = join(docsDir, 'ASD-PLUS.md')
  const standardText = existsSync(standardPath) ? readFileSync(standardPath, 'utf8') : null
  const extra = tree.files.filter((f) => f.path === 'WRITING.md')
  const errors = lintTree({ ...tree, standardText, extra }).filter((f) => f.level === 'error')
  assert.deepEqual(errors, [], 'run npm run docs:lint for the details')
})
