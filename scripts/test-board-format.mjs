// Tests for #126, the light formatting of agents' and Corvid's board messages (src/shared/boardFormat.ts): blocks and
// lists, **bold**, *italic* and `code`, the highlighted tokens and their budget, hostile input staying cheap and
// literal, offsets that map back to the original text, and the highlight colours' contrast in every theme.
// Pure functions on sample data; no app, board or data folder is touched.
//
//   npm run test-board-format

import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(s, c, next) {
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.split('?')[0].endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
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
const F = await import(src + 'shared/boardFormat.ts')
const { THEMES, themeTokens } = await import(src + 'shared/themes.ts')

/** What highlight() picks out, as "kind:text". */
const hl = (s) => F.highlight(s).map((t) => `${t.kind}:${s.slice(t.start, t.end)}`)
/** The inline runs of one line, flattened to "kind:text" (text is what's drawn). */
const flat = (inl, s) =>
  inl.flatMap((x) => (x.t === 'text' ? [`text:${x.text}`] : x.t === 'code' ? [`code:${x.text}`] : [`${x.t}[`, ...flat(x.kids, s), `]`]))
const line = (s) => flat(F.inline(s, 0), s)

test('bold, italic and code, and asterisks in ordinary text stay as typed', () => {
  assert.deepEqual(line('a **big** deal'), ['text:a ', 'bold[', 'text:big', ']', 'text: deal'])
  assert.deepEqual(line('an *odd* one'), ['text:an ', 'italic[', 'text:odd', ']', 'text: one'])
  assert.deepEqual(line('run `npm test` now'), ['text:run ', 'code:npm test', 'text: now'])
  assert.deepEqual(line('2*3*4 and a * b and 5 * 6'), ['text:2*3*4 and a * b and 5 * 6'])
  assert.deepEqual(line('snake*case*word'), ['text:snake*case*word'])
  assert.deepEqual(line('** not bold **'), ['text:** not bold **'])
  assert.deepEqual(line('`**not bold** in code`'), ['code:**not bold** in code'])
  assert.deepEqual(line('``has ` inside``'), ['code:has ` inside'])
  assert.deepEqual(line('lone ` tick'), ['text:lone ` tick'])
  assert.deepEqual(line('***triple***'), ['text:***triple***'])
})

test('blocks: paragraphs, bullet and numbered lists with markers as typed, continuation lines', () => {
  const t = 'Intro line\nsecond line\n\n- one\n- two\n  more of two\n* three\n\n1. first\n2) second\nAfter'
  const f = F.formatMessage(t)
  assert.deepEqual(
    f.blocks.map((b) => b.t + (b.t === 'list' ? (b.ordered ? ':ol' : ':ul') + b.items.length : b.lines.length)),
    ['para2', 'list:ul3', 'list:ol2', 'para1']
  )
  const ul = f.blocks[1]
  assert.deepEqual(ul.items.map((i) => i.marker), ['-', '-', '*'])
  assert.equal(ul.items[1].lines.length, 2)
  assert.deepEqual(f.blocks[2].items.map((i) => i.marker), ['1.', '2)'])
  // a heading, a table and HTML are plain text
  const p = F.formatMessage('# Title\n| a | b |\n<img src=x onerror=alert(1)>').blocks
  assert.equal(p.length, 1)
  assert.deepEqual(p[0].lines.map((l) => flat(l.inl).join('')), ['text:# Title', 'text:| a | b |', 'text:<img src=x onerror=alert(1)>'])
})

test('every drawn run maps back to the same characters in the original', () => {
  const t = 'Hi **there**, see `src/a.ts` and *this*.\n\n- item **b**\n  cont\n12. last'
  const f = F.formatMessage(t)
  const check = (inl) => {
    for (const x of inl) {
      if (x.t === 'text') assert.equal(t.slice(x.at, x.at + x.text.length), x.text)
      else if (x.t === 'code') assert.equal(t.slice(x.textAt, x.textAt + x.text.length), x.text)
      else check(x.kids)
    }
  }
  for (const b of f.blocks) for (const l of b.t === 'para' ? b.lines : b.items.flatMap((i) => i.lines)) check(l.inl)
  for (const i of f.blocks[1].items) assert.equal(t.slice(i.markerAt, i.markerAt + i.marker.length), i.marker)
})

test('highlights: refs, paths, hashes, numbers with units, versions, status words', () => {
  assert.deepEqual(hl('See #12, N7 and m42'), ['ref:#12', 'ref:N7', 'ref:m42'])
  assert.deepEqual(hl('Edited src/renderer/src/board.css and package.json'), ['path:src/renderer/src/board.css', 'path:package.json'])
  assert.deepEqual(hl('on task-126-board-make-agent, commit 0290ff5'), ['path:task-126-board-make-agent', 'hash:0290ff5'])
  assert.deepEqual(hl('38% used, 12 minutes left, 4 files, 4.5:1'), ['num:38%', 'num:12 minutes', 'num:4 files', 'num:4.5:1'])
  assert.deepEqual(hl('version 1.2.3 and v2'), ['version:1.2.3', 'version:v2'])
  assert.deepEqual(hl('Merged, tests passed. Build failed. Still blocked, needs you.'), ['ok:Merged', 'ok:passed', 'bad:failed', 'warn:blocked', 'warn:needs you'])
  assert.deepEqual(hl('calls read_messages and useStickToBottom'), ['path:read_messages', 'path:useStickToBottom'])
})

test('plain words stay plain: and/or, e.g., 12/45, words containing status words, negations', () => {
  assert.deepEqual(hl('and/or e.g. 12/45 i.e. the end'), [])
  assert.deepEqual(hl('undone, unmerged, errors, refusedly, blockedness, holdings'), [])
  assert.deepEqual(hl('no error, not failed, never refused, nothing blocked'), [])
  assert.deepEqual(hl('I counted 12 and 7 things'), [])
  assert.deepEqual(hl('deadbee 1234567'), [])
  assert.deepEqual(hl('Hello there Robin, it is a nice day.'), [])
})

test('URLs are picked out whole, trailing punctuation left off', () => {
  assert.deepEqual(hl('Open https://example.com/a?b=1. Then'), ['url:https://example.com/a?b=1'])
  assert.deepEqual(hl('(see http://x.test/y)'), ['url:http://x.test/y'])
})

test('the budget keeps about one word in ten styled, the surest first; refs and links are free', () => {
  const s = 'done merged passed failed 1 file 2 files 3 files src/a.ts src/b.ts #12 N7 and some more words here'
  const b = { left: 3 }
  const got = F.highlight(s, b).map((t) => t.kind)
  assert.equal(got.filter((k) => k !== 'ref').length, 3)
  assert.equal(got.filter((k) => k === 'ref').length, 2)
  assert.ok(got.includes('bad'))
  assert.equal(F.budgetFor('a b c d e f g h i j k l m n o p q r s t u').left, 3)
  assert.equal(F.budgetFor('short').left, 2)
})

test('long messages fold; short ones never do', () => {
  assert.equal(F.formatMessage('short one').long, false)
  assert.equal(F.formatMessage(Array(12).fill('x').join('\n')).long, true)
  assert.equal(F.formatMessage('x'.repeat(700)).long, true)
  assert.equal(F.formatMessage(Array(10).fill('x').join('\n')).long, false)
})

test('hostile input finishes quickly and stays literal', () => {
  const nasty = [
    '*'.repeat(2000),
    '`'.repeat(2000),
    '` '.repeat(1000),
    '** '.repeat(700),
    '*a '.repeat(700),
    'a'.repeat(2000),
    'a.'.repeat(1000),
    'a/'.repeat(1000),
    '1.'.repeat(1000),
    'deadbeef'.repeat(250),
    Array(1000).fill('- item').join('\n'),
    Array(1000).fill('1. item').join('\n'),
    '<script>alert(1)</script><img src=x onerror=alert(1)><style>*{display:none}</style>',
    '‮evil‬ ​​​zero ‏',
    ('x'.repeat(50) + '/').repeat(40),
    '9'.repeat(2000) + '%'
  ]
  for (const s of nasty) {
    const t0 = performance.now()
    for (let i = 0; i < 5; i++) {
      const f = F.formatMessage(s)
      const budget = F.budgetFor(s)
      for (const b of f.blocks) for (const l of b.t === 'para' ? b.lines : b.items.flatMap((x) => x.lines)) for (const x of l.inl) if (x.t === 'text') F.highlight(x.text, budget)
    }
    const ms = (performance.now() - t0) / 5
    assert.ok(ms < 40, `${JSON.stringify(s.slice(0, 20))}… took ${ms.toFixed(1)} ms`)
  }
  // HTML is only ever text: the parse holds strings, never markup
  const f = F.formatMessage('<b>hi</b> **<i>x</i>**')
  assert.deepEqual(flat(f.blocks[0].lines[0].inl), ['text:<b>hi</b> ', 'bold[', 'text:<i>x</i>', ']'])
})

test('several hundred messages parse fast, and the cache gives the same object back', () => {
  const msg = 'Merged #126 into main: **3 files** changed in `src/renderer`, typecheck passed.\n\n- one\n- two\n1. three'
  const t0 = performance.now()
  for (let i = 0; i < 500; i++) F.formatMessage(msg + i)
  assert.ok(performance.now() - t0 < 300)
  assert.equal(F.formatCached(1, msg), F.formatCached(1, msg))
  assert.notEqual(F.formatCached(1, msg), F.formatCached(2, msg))
})

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))

test('every highlight colour reads at 4.5:1 or better on every bubble, in each built-in theme', () => {
  for (const th of THEMES) {
    const tokens = themeTokens(th.id)
    const c = F.formatColours(tokens)
    for (const [k, v] of Object.entries(c))
      for (const bg of F.bubbleBackgrounds(tokens)) assert.ok(F.ratio(hexRgb(v), bg) >= F.MIN_CONTRAST, `${th.id} ${k} ${v}: ${F.ratio(hexRgb(v), bg).toFixed(2)}`)
  }
})

test('an extension theme with unusual colours still gets readable highlights', () => {
  const odd = {
    ...themeTokens('dark'),
    bg: '#3a0d4a',
    'bg-1': '#40104f',
    'bg-2': '#4a1a5c',
    'bg-3': '#552266',
    text: '#f6e8ff',
    accent: '#5a1a70',
    warn: '#4a2a00',
    danger: '#5c0a0a',
    'syn-string': '#204020'
  }
  const c = F.formatColours(odd)
  for (const [k, v] of Object.entries(c)) for (const bg of F.bubbleBackgrounds(odd)) assert.ok(F.ratio(hexRgb(v), bg) >= F.MIN_CONTRAST, `${k} ${v}`)
  // a light theme with a pale accent
  const pale = { ...themeTokens('light'), accent: '#e0fff8', warn: '#fff2c0', danger: '#ffd0d0', 'syn-string': '#d0ffd0' }
  const p = F.formatColours(pale)
  for (const [k, v] of Object.entries(p)) for (const bg of F.bubbleBackgrounds(pale)) assert.ok(F.ratio(hexRgb(v), bg) >= F.MIN_CONTRAST, `${k} ${v}`)
})

test('each line of a list gets its own budget, so the items look alike', () => {
  const t = Array.from({ length: 12 }, (_, i) => `${i + 1}. Step ${i + 1}: touched src/main/part${i}.ts, ${i + 2} tests passed`).join('\n')
  const items = F.formatMessage(t).blocks[0].items
  const kinds = items.map((it) => it.lines[0].inl.flatMap((x) => (x.toks ?? []).map((k) => k.kind)).join(','))
  assert.equal(new Set(kinds).size, 1, kinds.join(' | '))
  assert.equal(kinds[0], 'ok')
})
