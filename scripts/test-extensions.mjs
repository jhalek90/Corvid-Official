// Tests for #95, Extensions 1/8: the .corvid validator (a good file, and a table of bad ones for every rule), the
// canonical hash, the tiers, and the ledger's import paths (one file, many, a wrong type, an invalid file, replace,
// keep both and refused duplicates, delete, persistence). Sample .corvid files only, written here; the ledger runs
// in a temporary folder through a stand-in for electron, like test-drafts.mjs. No code from any file is ever run.
//
//   npm run test-extensions

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-extensions-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent('export const app = { getPath: () => globalThis.__userData }')
    export async function resolve(s, c, next) {
      if (s === 'electron') return { url: fake, shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
        for (const ext of ['.ts', '/index.ts']) {
          try { return await next(s + ext, c) } catch {}
        }
      }
      return next(s, c)
    }
    export async function load(u, c, next) {
      return /\\.ts(?:\\?|$)/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)
const fmt = await import(src + 'shared/extensions.ts')
const tiers = await import(src + 'shared/extensionTiers.ts')
const ledger = await import(src + 'main/extensions.ts')
after(() => rmSync(tmp, { recursive: true, force: true }))

const GOOD = `---
format: 1
id: board-reactions
name: Board reactions
version: 1.0.0
author: Sample Author
description: React to board messages with a small set of emoji.
built_on: 0.1.0 @ 15be862
works_with: >=0.1.0 <0.2.0
effort: small
effort.minutes: 25
effort.files: 4
effort.model: claude-opus-5-5
effort.checks: 4
effort.cost: small
requires: message-threads ^1.0.0
conflicts: board-emoji-classic
capabilities.tier: 2
capabilities.packages:
capabilities.hosts:
capabilities.data: reactions stored with each board message
capabilities.core_areas: board, ui
capabilities.rebuild: yes
verified.commit: 15be862
verified.at: 2026-10-20
verified.by: Sample Author
---

## Summary

Adds reactions to the message board, so you can acknowledge a post without writing a reply.

## What it does

Each board message gets a small reaction row. Clicking a reaction toggles yours on or off.
Counts show beside each reaction. Reactions are kept with the message, so they survive a restart.

## Seed prompt

Add emoji reactions to Corvid's message board. Find where board messages are stored and add an optional
reactions field: a map from one of six allowed emoji to the list of who reacted. Show a compact reaction row
under each message in the board view, and let the user toggle their own reaction. Agents cannot react.
Keep the stored shape backwards compatible: messages without reactions must load as before.

A stored message then looks like this:

\`\`\`json
{ "id": 42, "reactions": { "👍": ["user"] } }
\`\`\`

## Acceptance checks

1. A board message shows a reaction row with six emoji.
2. Clicking an emoji adds the user's reaction and shows a count of 1.
3. Clicking it again removes the reaction.
4. Reactions are still there after a restart.

## Notes

Written for the test of #95; not a real extension.
`

const ok = (text) => {
  const r = fmt.validateCorvid(text)
  assert.equal(r.ok, true, r.ok ? '' : r.errors.join('\n'))
  return r.ext
}
const bad = (text, re) => {
  const r = fmt.validateCorvid(text)
  assert.equal(r.ok, false, `expected a refusal matching ${re}`)
  assert.ok(r.errors.some((e) => re.test(e)), `no error matched ${re}:\n${r.errors.join('\n')}`)
  return r.errors
}
// function replacers, so a $ in the inserted text is never read as a replacement pattern
const withHeader = (line, value) => GOOD.replace(new RegExp(`^${line.replace('.', '\\.')}:.*$`, 'm'), () => (value === null ? '' : `${line}: ${value}`))
const addHeader = (line) => GOOD.replace('\n---\n\n## Summary', () => `\n${line}\n---\n\n## Summary`)
const inSeed = (extra) => GOOD.replace('Keep the stored shape', () => `${extra}\nKeep the stored shape`)

// ---------- the validator ----------

test('a good file parses, with every header field', () => {
  const e = ok(GOOD)
  assert.equal(e.header.id, 'board-reactions')
  assert.equal(e.header.capabilities.tier, 2)
  assert.deepEqual(e.header.capabilities.coreAreas, ['board', 'ui'])
  assert.deepEqual(e.header.requires, [{ id: 'message-threads', range: '^1.0.0' }])
  assert.deepEqual(e.header.builtOn, { version: '0.1.0', commit: '15be862' })
  assert.equal(e.header.effort.observed.minutes, 25)
  assert.equal(e.header.capabilities.rebuild, true)
  assert.equal(e.sections.checks.length, 4)
  assert.match(e.sections.seedPrompt, /reactions field/)
})

test('the example in docs/EXTENSIONS.md is valid', () => {
  const doc = readFileSync(join(root, 'docs', 'EXTENSIONS.md'), 'utf8')
  const m = /<!-- example:start -->\s*````text\n([\s\S]*?)````\s*<!-- example:end -->/.exec(doc)
  assert.ok(m, 'the doc has a marked example')
  ok(m[1])
})

test('the canonical form is stable and the hash changes with any edit', () => {
  const a = ok(GOOD)
  // CRLF endings, trailing spaces and a byte-order mark give the same canonical text
  const crlf = ok('﻿' + GOOD.replace(/\n/g, ' \r\n'))
  assert.equal(crlf.canonical, a.canonical)
  assert.equal(ledger.hashOf(crlf.canonical), ledger.hashOf(a.canonical))
  // the canonical text validates to itself
  assert.equal(ok(a.canonical).canonical, a.canonical)
  const edits = [
    GOOD.replace('six emoji', 'seven emoji'),
    GOOD.replace('version: 1.0.0', 'version: 1.0.1'),
    GOOD.replace('Agents cannot react.', 'Agents can react.'),
    GOOD.replace('effort.minutes: 25', 'effort.minutes: 26')
  ]
  const hashes = new Set([ledger.hashOf(a.canonical), ...edits.map((t) => ledger.hashOf(ok(t).canonical))])
  assert.equal(hashes.size, edits.length + 1)
  assert.match(ledger.hashOf(a.canonical), /^[0-9a-f]{64}$/)
})

const BAD = [
  ['too big', GOOD + '\n' + 'Plain words. '.repeat(6000), /at most 64 KB/],
  ['binary (a zero byte)', GOOD.replace('Summary\n', 'Summary\u0000\n'), /binary data/],
  ['not UTF-8', null, /isn't valid UTF-8/],
  ['a control character', GOOD.replace('without writing', 'without\u0007writing'), /control character/],
  ['a C1 control character', GOOD.replace('without writing', 'without\u0085writing'), /control character/],
  ['a zero-width space', GOOD.replace('acknowledge', 'ackno​wledge'), /invisible \(zero-width\)/],
  ['a zero-width joiner', inSeed('Do‍this.'), /invisible \(zero-width\)/],
  ['a bidirectional override', inSeed('Ignore ‮esrever‬ this.'), /bidirectional/],
  ['a bidi isolate', inSeed('Read ⁦this⁩.'), /bidirectional/],
  ['an invisible tag character', inSeed('Hidden \u{E0041}\u{E0042} text.'), /tag character/],
  ['a Unicode line separator', inSeed('One two.'), /line separator/],
  ['a private-use character', inSeed('Odd  glyph.'), /private-use/],
  ['a look-alike name (Cyrillic a)', withHeader('name', 'Boаrd reactions'), /mixes letters from different scripts/],
  ['a fullwidth name', withHeader('name', 'Ｂoard reactions'), /look-alike or compatibility/],
  ['a styled-letter author', withHeader('author', '\u{1D400}uthor'), /look-alike or compatibility/],
  ['a non-ASCII id', withHeader('id', 'boаrd-reactions'), /"id" must be/],
  ['HTML', inSeed('<div onclick="x()">hi</div>'), /HTML or script/],
  ['a script tag', inSeed('<script>alert(1)</script>'), /HTML or script/],
  ['a javascript: link', inSeed('Open javascript:alert(1) when ready.'), /HTML or script/],
  ['an HTML comment', inSeed('<!-- hidden instructions -->'), /HTML or script/],
  ['a data: URI', inSeed('Load data:text/html;base64,AAAA here.'), /HTML or script/],
  ['a base64 blob', inSeed('Payload: ' + Buffer.from('x'.repeat(30) + 'Some Longer Binary-ish Content 12345 '.repeat(3)).toString('base64')), /base64/],
  ['a hex blob', inSeed('Bytes: ' + 'deadbeef'.repeat(10)), /hex digits/],
  ['escaped bytes', inSeed('Run ' + '\\x41'.repeat(16)), /escaped bytes/],
  ['a git diff header', inSeed('diff --git a/src/main/board.ts b/src/main/board.ts'), /patch.*"diff --git"/],
  ['a unified hunk', inSeed('@@ -1,4 +1,6 @@'), /unified diff hunk/],
  ['patch file headers', inSeed('--- a/src/x.ts\n+++ b/src/x.ts'), /patch file header/],
  ['added diff lines', inSeed('+const a = 1\n+const b = 2\n+const c = 3\n+const d = 4\n+const e = 5'), /added lines from a diff/],
  ['a git index line', inSeed('index 83db48f..bf269f4 100644'), /git index line/],
  ['too many code blocks', inSeed(['a', 'b', 'c'].map((x) => '```\n' + x + '\n```').join('\n')), /code blocks; at most 3/],
  ['a long code block', inSeed('```ts\n' + 'x = 1\n'.repeat(20) + '```'), /too long/],
  ['an unclosed code block', GOOD + '\n```\nopen\n', /never closed/],
  ['code outside fences', inSeed(Array.from({ length: 14 }, (_, i) => `const v${i} = ${i};`).join('\n')), /read like source code/],
  ['an unknown header field', addHeader('homepage: https://example.com'), /not a known header field/],
  ['a duplicate key', addHeader('id: board-reactions-two'), /appears more than once/],
  ['a missing required field', withHeader('description', null), /missing "description"/],
  ['a bad id (uppercase)', withHeader('id', 'Board-Reactions'), /"id" must be/],
  ['a bad id (double hyphen)', withHeader('id', 'board--reactions'), /"id" must be/],
  ['a bad version', withHeader('version', '1.0'), /"version" must be/],
  ['a bad version (leading zero)', withHeader('version', '01.0.0'), /"version" must be/],
  ['a bad format version', withHeader('format', '2'), /reads format 1/],
  ['a bad built_on', withHeader('built_on', '0.1.0'), /"built_on" must be/],
  ['a bad works_with', withHeader('works_with', 'newer than 0.1'), /"works_with" isn't a version range/],
  ['bad requires syntax', withHeader('requires', 'message-threads >= one'), /"requires" entry/],
  ['a requires with a bad id', withHeader('requires', 'Message_Threads ^1.0.0'), /"requires" entry/],
  ['a bad conflicts id', withHeader('conflicts', 'Not An Id'), /"conflicts" entry/],
  ['a self requirement', withHeader('requires', 'board-reactions'), /require or conflict with itself/],
  ['a bad effort', withHeader('effort', 'huge'), /"effort" must be small, medium or large/],
  ['a bad effort number', withHeader('effort.minutes', 'about 20'), /whole number/],
  ['a bad tier', withHeader('capabilities.tier', '4'), /must be 1, 2 or 3/],
  ['a tier below its core areas', withHeader('capabilities.core_areas', 'board, connectors'), /at least tier 3/],
  ['tier 1 changing core', withHeader('capabilities.tier', '1'), /at least tier 2/],
  ['an unknown core area', withHeader('capabilities.core_areas', 'everything'), /isn't a known area/],
  ['a bad package', withHeader('capabilities.packages', 'left pad'), /npm package name and version/],
  ['a host with a scheme', withHeader('capabilities.hosts', 'https://api.example.com/v1'), /host name only/],
  ['a bad rebuild', withHeader('capabilities.rebuild', 'maybe'), /yes or no/],
  ['a half verification', withHeader('verified.at', null), /needs both/],
  ['no header', GOOD.slice(4), /starts with a header/],
  ['an unclosed header', GOOD.replace('\n---\n\n## Summary', '\n\n## Summary'), /never closed/],
  ['a malformed header line', addHeader('just some words'), /isn't "key: value"/],
  ['an unknown section', GOOD.replace('## Notes', '## Install script'), /isn't a known section/],
  ['a missing section', GOOD.replace(/## What it does[\s\S]*?## Seed prompt/, '## Seed prompt'), /"What it does" section is missing/],
  ['sections out of order', GOOD.replace('## Summary', '## Tmp').replace('## What it does', '## Summary').replace('## Tmp', '## What it does'), /out of order/],
  ['unnumbered checks', GOOD.replace('1. A board message', '- A board message'), /isn't a numbered check/],
  ['checks out of sequence', GOOD.replace('3. Clicking it again', '5. Clicking it again'), /out of sequence/],
  ['an empty file', '   \n', /empty/]
]

for (const [what, text, re] of BAD)
  test(`refused: ${what}`, () => {
    if (text === null) {
      const bytes = Buffer.concat([Buffer.from(GOOD.slice(0, 200)), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from(GOOD.slice(200))])
      return bad(bytes, re)
    }
    bad(text, re)
  })

test('each required header field, left out or empty, is a plain refusal', () => {
  for (const k of ['format', 'id', 'name', 'version', 'description', 'built_on', 'effort', 'capabilities.tier', 'capabilities.rebuild']) {
    bad(withHeader(k, null), new RegExp(`missing "${k.replace('.', '\\.')}"`))
    bad(withHeader(k, ''), new RegExp(`missing "${k.replace('.', '\\.')}"`))
  }
})

test('errors are plain words, not exceptions or stack traces', () => {
  for (const [, text] of BAD) {
    if (text === null) continue
    const r = fmt.validateCorvid(text)
    for (const e of r.errors) {
      assert.equal(typeof e, 'string')
      assert.doesNotMatch(e, /\bat .*:\d+:\d+|TypeError|undefined|\[object/)
    }
  }
})

test('a few short snippets are fine; a markdown bullet list is not a diff', () => {
  ok(inSeed('+ first point\n+ second point\n+ third point\n+ fourth point\n+ fifth point\n+ sixth point'))
  ok(inSeed('A pattern: `^[a-z0-9-]+$`, and the commit hash 15be862 or a full sha 83db48f4a4f9e7c3b2a1d0e9f8a7b6c5d4e3f2a1.'))
  ok(inSeed('```\n{ "a": 1 }\n```\n```\n/^x$/\n```'))
})

test('tiers: one place, with the protected paths', () => {
  assert.equal(tiers.TIER_WORDS[1], 'adds files')
  assert.equal(tiers.TIER_WORDS[3], 'changes protected core')
  assert.equal(tiers.minimumTier([]), 1)
  assert.equal(tiers.minimumTier(['ui', 'board']), 2)
  assert.equal(tiers.minimumTier(['ui', 'deploy']), 3)
  for (const p of ['scripts/deploy.mjs', 'src/main/connectors/http.ts', 'src/main/extensions.ts', 'src/main/backups.ts', 'src/main/agentDeny.ts'])
    assert.ok(tiers.isProtectedPath(p), p)
  assert.ok(!tiers.isProtectedPath('src/renderer/src/views/NotesView.tsx'))
})

test('compareVersions follows semver order', () => {
  const order = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0', '1.0.1', '1.2.0', '10.0.0']
  for (let i = 1; i < order.length; i++) assert.ok(fmt.compareVersions(order[i - 1], order[i]) < 0, `${order[i - 1]} < ${order[i]}`)
})

// ---------- the ledger and import ----------

const dir = join(tmp, 'files')
mkdirSync(dir)
const put = (name, text) => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}
let emitted = 0
ledger.initExtensions(() => emitted++)

test('import one file: added as Not installed yet, text stored canonical, ledger written', () => {
  const [r] = ledger.importFiles([put('reactions.corvid', GOOD)], 'drop')
  assert.equal(r.ok, true, JSON.stringify(r))
  const list = ledger.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'not-installed')
  assert.equal(list[0].source.kind, 'imported')
  assert.equal(list[0].hash, ledger.hashOf(ok(GOOD).canonical))
  const d = ledger.detail(r.key)
  assert.equal(d.text, ok(GOOD).canonical)
  assert.equal(d.sections.checks.length, 4)
  assert.ok(emitted > 0)
  const onDisk = JSON.parse(readFileSync(join(globalThis.__userData, 'extensions.json'), 'utf8'))
  assert.equal(onDisk.extensions[0].key, r.key)
})

test('an identical duplicate is refused, even with other line endings', () => {
  const [r] = ledger.importFiles([put('again.corvid', GOOD.replace(/\n/g, '\r\n'))], 'picker')
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /already in the list/)
  assert.equal(ledger.list().length, 1)
})

test('a wrong file type and an invalid file add nothing', () => {
  const [a, b, c] = ledger.importFiles([put('photo.png', 'not really'), put('broken.corvid', GOOD.replace('version: 1.0.0', 'version: one')), dir], 'drop')
  assert.match(a.errors[0], /isn't a \.corvid file/)
  assert.match(b.errors.join(' '), /"version" must be/)
  assert.equal(c.ok, false)
  assert.equal(ledger.list().length, 1)
})

test('a file over the cap is refused before it is read', () => {
  const [r] = ledger.importFiles([put('big.corvid', 'x'.repeat(70 * 1024))], 'drop')
  assert.match(r.errors[0], /at most 64 KB/)
})

test('the same id, newer version: replace is offered and replaces', () => {
  const [r] = ledger.importFiles([put('reactions-1.1.corvid', GOOD.replace('version: 1.0.0', 'version: 1.1.0'))], 'drop')
  assert.equal(r.ok, false)
  assert.equal(r.conflict.canReplace, true)
  assert.equal(r.conflict.existing.version, '1.0.0')
  const done = ledger.resolveImport(r.conflict.token, 'replace')
  assert.equal(done.ok, true)
  assert.equal(done.replaced, true)
  const list = ledger.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].version, '1.1.0')
  // the old text is gone with its record
  assert.deepEqual(readdirSync(join(globalThis.__userData, 'extensions')), [`${list[0].key}.corvid`])
  // the token is spent
  assert.equal(ledger.resolveImport(r.conflict.token, 'keep').ok, false)
})

test('the same id, older or equal version with other content: only keep both, by choice', () => {
  const [r] = ledger.importFiles([put('reactions-old.corvid', GOOD.replace('six emoji', 'four emoji'))], 'drop')
  assert.equal(r.conflict.canReplace, false)
  assert.equal(ledger.resolveImport(r.conflict.token, 'replace').ok, false)
  const [r2] = ledger.importFiles([put('reactions-old.corvid', GOOD.replace('six emoji', 'four emoji'))], 'drop')
  assert.equal(ledger.resolveImport(r2.conflict.token, 'skip').ok, false)
  assert.equal(ledger.list().length, 1)
  const [r3] = ledger.importFiles([put('reactions-old.corvid', GOOD.replace('six emoji', 'four emoji'))], 'drop')
  const kept = ledger.resolveImport(r3.conflict.token, 'keep')
  assert.equal(kept.ok, true)
  assert.equal(ledger.list().length, 2)
  assert.equal(new Set(ledger.list().map((x) => x.key)).size, 2)
})

test('many files at once, and paste', () => {
  const files = [1, 2, 3].map((n) => put(`ext-${n}.corvid`, GOOD.replace(/board-reactions/g, `sample-ext-${n}`).replace('requires: message-threads ^1.0.0', 'requires:')))
  const out = ledger.importFiles([...files, put('notes.txt', 'hello')], 'drop')
  assert.deepEqual(out.map((o) => o.ok), [true, true, true, false])
  const pasted = GOOD.replace(/board-reactions/g, 'pasted-ext').replace('requires: message-threads ^1.0.0', 'requires:')
  assert.equal(ledger.importText(pasted).ok, true)
  assert.equal(ledger.importText(pasted).ok, false)
  assert.ok(ledger.list().some((x) => x.id === 'pasted-ext' && x.source.via === 'paste'))
  assert.equal(ledger.importText(42).ok, false)
})

test('dropped files: read in the window, checked again here', () => {
  const enc = (t) => new TextEncoder().encode(t)
  const out = ledger.importDropped([
    { name: 'dropped.corvid', size: 10, bytes: enc(GOOD.replace(/board-reactions/g, 'dropped-ext').replace('requires: message-threads ^1.0.0', 'requires:')) },
    { name: 'huge.corvid', size: 900 * 1024, bytes: null },
    { name: 'picture.jpg', size: 10, bytes: null },
    { name: 'sneaky.corvid', size: 10, bytes: 'not bytes' },
    { name: '..\\..\\escape.corvid', size: 10, bytes: enc('nothing') }
  ])
  assert.deepEqual(out.map((o) => o.ok), [true, false, false, false, false])
  assert.match(out[1].errors[0], /at most 64 KB/)
  assert.match(out[2].errors[0], /isn't a \.corvid file/)
  assert.equal(out[4].name, 'escape.corvid')
  assert.ok(ledger.list().some((x) => x.id === 'dropped-ext' && x.source.via === 'drop'))
  assert.deepEqual(ledger.importDropped('nope'), [])
})

test('delete removes the record and its file', () => {
  const r = ledger.list().find((x) => x.id === 'sample-ext-1')
  assert.deepEqual(ledger.remove(r.key), { ok: true })
  assert.ok(!ledger.list().some((x) => x.key === r.key))
  assert.ok(!readdirSync(join(globalThis.__userData, 'extensions')).includes(`${r.key}.corvid`))
  assert.equal('error' in ledger.remove(r.key), true)
})

test('the ledger survives a restart (a fresh load of extensions.json)', async () => {
  const before = ledger.list().map((x) => x.key).sort()
  const again = await import(src + 'main/extensions.ts?restart')
  again.initExtensions(() => {})
  assert.deepEqual(again.list().map((x) => x.key).sort(), before)
  const json = readFileSync(join(globalThis.__userData, 'extensions.json'), 'utf8')
  assert.doesNotMatch(json, /token|password|secret/i)
})

test('extensions.json and the extensions folder are in the backups', () => {
  const b = readFileSync(join(root, 'src', 'main', 'backups.ts'), 'utf8')
  assert.match(b, /BACKUP_ITEMS = \[[^\]]*'extensions\.json'[^\]]*'extensions'\]/)
})

test('no code is run: the import path never evaluates file content', () => {
  for (const f of ['src/shared/extensions.ts', 'src/main/extensions.ts', 'src/renderer/src/views/ExtensionsView.tsx']) {
    const code = readFileSync(join(root, f), 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
    for (const re of [/\beval\s*\(/, /new\s+Function\b/, /\bimport\s*\(/, /\brequire\s*\(/, /node:vm|\bvm\./, /child_process|\bspawn\(|\bexecFile|(?<!\.)\bexec\(|\bexecSync/, /dangerouslySetInnerHTML|innerHTML/])
      assert.doesNotMatch(code, re, `${f} has ${re}`)
  }
  // JSON.parse only ever reads Corvid's own ledger, never an imported file
  const main = readFileSync(join(root, 'src/main/extensions.ts'), 'utf8')
  assert.equal((main.match(/JSON\.parse\(/g) ?? []).length, 1)
  assert.match(main, /JSON\.parse\(readFileSync\(file\(\)/)
})
