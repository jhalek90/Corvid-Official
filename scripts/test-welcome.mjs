// Tests for #122, Corvid's "welcome back" on the board (src/shared/welcome.ts and src/shared/welcomeLines.ts): which
// starts get a greeting, the line bank's length and content rules, and the message for each voice, mode and status.
// Pure functions on sample data; no app, board or data folder is touched.
//
//   npm run test-welcome

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
const W = await import(src + 'shared/welcome.ts')
const { CROW_LINES, PLAIN_LINES } = await import(src + 'shared/welcomeLines.ts')
const { BOARD_EMOJI, styleIssues, BOARD_VOICES } = await import(src + 'shared/boardVoice.ts')
const { emojiIn, charCount } = await import(src + 'shared/text.ts')

const H = 3600_000
const NOW = new Date(2026, 9, 21, 9, 30).getTime()
const at = (h, min = 0) => new Date(2026, 9, 21, h, min)
const NONE = { agentsDone: 0, needYou: [], doing: 0, approvals: 0 }
const CROWISMS = /\b(caw\w*|perch\w*|nest\w*|roost\w*|flock\w*|murder|swoop\w*|peck\w*|shiny|feathers?|molt\w*|talons?|fly-by|hoard\w*|sky|fly off)\b/gi
const TIMES = ['morning', 'afternoon', 'evening', 'late']
const AWAYS = ['short', 'newday', 'day', 'week']

// ---------- when to greet ----------

const check = (o) => W.shouldGreet({ kind: 'quit', mode: 'status', state: { firstDone: true }, now: NOW, ...o }).greet

test('a start after the user quit greets', () => assert.equal(check({}), 'back'))
test('the first run gets the one-time welcome, once', () => {
  assert.equal(check({ kind: 'first', state: {} }), 'first')
  assert.equal(check({ kind: 'first', state: { firstDone: true } }), 'back')
})
test('no greeting after a deploy, a self-restart, a rollback (a deploy run) or a crash', () => {
  for (const kind of ['deploy', 'restart', 'crash']) assert.equal(check({ kind }), null, kind)
})
test('no greeting within 10 minutes of a deploy, one after', () => {
  assert.equal(check({ deployAt: NOW - 5 * 60_000 }), null)
  assert.equal(check({ deployAt: NOW - 11 * 60_000 }), 'back')
})
test('two opens within 4 hours give one greeting', () => {
  assert.equal(check({ state: { firstDone: true, lastGreetAt: NOW - 3 * H } }), null)
  assert.equal(check({ state: { firstDone: true, lastGreetAt: NOW - 5 * H } }), 'back')
})
test('Off never greets, not even the first run', () => {
  assert.equal(check({ mode: 'off' }), null)
  assert.equal(check({ mode: 'off', kind: 'first', state: {} }), null)
})

// ---------- the bank ----------

test('at least 25 crow lines, unique ids, every time of day and absence covered', () => {
  assert.ok(CROW_LINES.length >= 25, `${CROW_LINES.length}`)
  assert.equal(new Set(CROW_LINES.map((l) => l.id)).size, CROW_LINES.length)
  for (const t of TIMES) for (const a of AWAYS) {
    const pool = CROW_LINES.filter((l) => (!l.times || l.times.includes(t)) && (!l.away || l.away.includes(a)))
    assert.ok(pool.length >= 3, `${t}/${a}: ${pool.length}`)
  }
})

for (const [bank, label] of [[CROW_LINES, 'crow'], [PLAIN_LINES, 'plain']])
  test(`${label} lines: short, one name slot, good with and without a name, no forbidden content`, () => {
    for (const l of bank) {
      assert.equal((l.text.match(/\{, name\}/g) ?? []).length, 1, l.id)
      for (const name of ['', 'Robin', 'Ana-Lucía Montgomery-Smith']) {
        const t = W.withName(l.text, name)
        assert.ok(charCount(t) <= W.LINE_MAX, `${l.id}: ${t}`)
        assert.ok(!/[{}]|\s[,.!?]|\s{2}|,,|^\s|\s$/.test(t), `${l.id} reads badly: "${t}"`)
        assert.deepEqual(styleIssues(t, BOARD_VOICES.crow.style), [], l.id)
      }
      // nothing nagging, nothing at the user's expense, no paths, links or mentions
      assert.ok(!/haven't|finally|where (?:have )?you been|days?\b.*\bago|neglect|abandon|lazy|slack|[\\/]|https?:|@|#\d/i.test(l.text), `${l.id}: ${l.text}`)
      const emoji = emojiIn(l.text)
      if (label === 'plain') assert.equal(emoji.length, 0, l.id)
      assert.ok(emoji.length <= 1 && emoji.every((e) => BOARD_EMOJI.includes(e)), `${l.id}: ${emoji}`)
      assert.ok((l.text.match(CROWISMS) ?? []).length <= 2, `${l.id} has too many crow-isms`)
      if (label === 'plain') assert.equal((l.text.match(CROWISMS) ?? []).length, 0, l.id)
    }
  })

test('time of day', () => {
  assert.equal(W.timeOfDay(at(7)), 'morning')
  assert.equal(W.timeOfDay(at(13)), 'afternoon')
  assert.equal(W.timeOfDay(at(19)), 'evening')
  assert.equal(W.timeOfDay(at(23)), 'late')
  assert.equal(W.timeOfDay(at(2)), 'late')
})

test('away lengths: same day, first open of the day, a day, a week', () => {
  const now = at(9)
  assert.equal(W.awayFor(now, at(7).getTime()), 'short')
  assert.equal(W.awayFor(now, now.getTime() - 12 * H), 'newday')
  assert.equal(W.awayFor(now, now.getTime() - 30 * H), 'day')
  assert.equal(W.awayFor(now, now.getTime() - 6 * 24 * H), 'week')
  assert.equal(W.awayFor(now, undefined), 'short')
})

test('the pick fits the time, never repeats the last line, and varies by day', () => {
  for (const t of [7, 13, 19, 23]) {
    const l = W.pickLine(CROW_LINES, at(t), 'short')
    assert.ok(!l.times || l.times.includes(W.timeOfDay(at(t))), l.id)
  }
  let last
  for (let i = 0; i < 40; i++) {
    const l = W.pickLine(CROW_LINES, at(9), 'day', last, i)
    assert.notEqual(l.id, last)
    last = l.id
  }
  const days = new Set(Array.from({ length: 10 }, (_, d) => W.pickLine(CROW_LINES, new Date(2026, 9, 1 + d, 9), 'day').id))
  assert.ok(days.size >= 3, `only ${days.size} different lines over 10 days`)
})

// ---------- the status line ----------

test('status: agents finished and one needing the user, in one sentence', () => {
  assert.equal(W.statusLine({ ...NONE, agentsDone: 2, needYou: [61] }), '2 agents wrapped up while you were away, and #61 needs you.')
  assert.equal(W.statusLine({ ...NONE, agentsDone: 1 }), 'One agent wrapped up while you were away.')
  assert.equal(W.statusLine({ ...NONE, needYou: [61, 64] }), '#61 and #64 need you.')
  assert.equal(W.statusLine({ ...NONE, needYou: [1, 2, 3] }), '3 agents need you.')
})
test('status: Doing, approvals, a new build and high usage only; empty when nothing', () => {
  assert.equal(W.statusLine(NONE), '')
  assert.equal(W.statusLine({ ...NONE, fiveHour: 40 }), '')
  assert.equal(W.statusLine({ ...NONE, doing: 3, approvals: 1, fiveHour: 82.4 }), '3 tasks are in Doing, one approval is waiting for you and the 5-hour usage is at 82%.')
  assert.equal(W.statusLine({ ...NONE, build: 'updated' }), "You're on a new build since last time.")
  assert.equal(W.statusLine({ ...NONE, agentsDone: 2, doing: 1 }, true), '2 agents done, 1 in Doing.')
})
test('board facts: unread done posts and unanswered questions to the user', () => {
  const msgs = [
    { id: 1, ts: 1, author: 'agent', agentName: 'A', taskId: 5, text: 'done', done: true },
    { id: 2, ts: 2, author: 'agent', agentName: 'B', taskId: 6, text: 'done', done: true },
    { id: 3, ts: 3, author: 'agent', agentName: 'B', taskId: 6, text: 'done again', done: true },
    { id: 4, ts: 4, author: 'agent', agentName: 'C', taskId: 61, text: 'q?', question: true, to: ['user'] },
    { id: 5, ts: 5, author: 'agent', agentName: 'D', taskId: 62, text: 'q?', question: true, to: ['user'] },
    { id: 6, ts: 6, author: 'user', text: 'answer', replyTo: 5 },
    { id: 7, ts: 7, author: 'assistant', text: 'hi', to: ['user'] }
  ]
  assert.deepEqual(W.boardFacts(msgs, 0), { agentsDone: 2, needYou: [61] })
  assert.deepEqual(W.boardFacts(msgs, 2), { agentsDone: 1, needYou: [61] })
  assert.deepEqual(W.boardFacts(msgs, 7), { agentsDone: 0, needYou: [] })
})

// ---------- the whole message ----------

const FULL = { ...NONE, agentsDone: 2, needYou: [61], doing: 3, approvals: 1, build: 'updated', fiveHour: 91 }
const compose = (o) => W.composeWelcome({ greet: 'back', mode: 'status', style: 'crow', name: '', now: at(9), since: at(9).getTime() - 30 * H, state: {}, facts: NONE, hotkey: 'Control+Alt+Space', ...o })

test('every style, mode, time and status stays short: three lines at most, no report form', () => {
  for (const style of ['crow', 'plain', 'terse'])
    for (const mode of ['short', 'status'])
      for (const h of [7, 13, 19, 23])
        for (const facts of [NONE, FULL, { ...NONE, needYou: [61] }])
          for (const name of ['', 'Robin']) {
            const out = compose({ style, mode, now: at(h), facts, name })
            if (!out) continue
            assert.ok(charCount(out.text) <= W.MESSAGE_MAX, out.text)
            assert.ok(out.text.split('\n').length <= 3, out.text)
            assert.deepEqual(styleIssues(out.text, BOARD_VOICES.crow.style), [], out.text)
            assert.ok(emojiIn(out.text).length <= 1, out.text)
            if (style !== 'crow') assert.equal(emojiIn(out.text).length, 0, out.text)
            if (name) assert.ok(style === 'terse' || out.text.includes('Robin'), out.text)
            assert.ok(!/\?\s*$/.test(out.text.split('\n').at(-1)) || style === 'plain', `reads as a question: ${out.text}`)
          }
})
test('Short has no status; With a quick status adds it on its own line, facts only', () => {
  const short = compose({ mode: 'short', facts: FULL })
  assert.ok(!short.text.includes('\n'))
  const full = compose({ facts: FULL })
  assert.match(full.text, /\n2 agents wrapped up while you were away, and #61 needs you\. 3 tasks are in Doing/)
  assert.equal(compose({ facts: NONE }).text.includes('\n'), false)
})
test('Terse: a bare status or nothing', () => {
  assert.equal(compose({ style: 'terse', facts: NONE }), null)
  assert.equal(compose({ style: 'terse', mode: 'short', facts: FULL }), null)
  assert.equal(compose({ style: 'terse', facts: { ...NONE, doing: 2 } }).text, '2 in Doing.')
})
test('the voice setting and personality pick the style', () => {
  assert.equal(W.welcomeStyle('crow', '', 'default'), 'crow')
  assert.equal(W.welcomeStyle('crow', '', 'casual'), 'crow')
  assert.equal(W.welcomeStyle('crow', '', 'strict'), 'plain')
  assert.equal(W.welcomeStyle('plain', '', 'casual'), 'plain')
  assert.equal(W.welcomeStyle('terse', '', 'casual'), 'terse')
  assert.equal(W.welcomeStyle('custom', 'Formal and precise, like a butler.', 'default'), 'plain')
  assert.equal(W.welcomeStyle('custom', 'Playful, lots of jokes', 'default'), 'crow')
  assert.equal(W.welcomeStyle('custom', '', 'default'), 'crow')
})
test('the line is remembered so the next greeting differs', () => {
  const a = compose({})
  const b = compose({ state: { lastLine: a.lineId, count: 1 } })
  assert.notEqual(a.lineId, b.lineId)
})
test('first run: the Agents page, the shortcuts and Settings, with and without a name, in every style', () => {
  for (const style of ['crow', 'plain', 'terse']) {
    const t = compose({ greet: 'first', style, name: 'Robin' }).text
    assert.match(t, /Agents page/)
    assert.match(t, /Ctrl\+Alt\+Space/)
    assert.match(t, /Settings/)
    assert.ok(charCount(t) <= W.MESSAGE_MAX && t.split('\n').length <= 3, t)
    assert.deepEqual(styleIssues(t, BOARD_VOICES.crow.style), [], t)
    const bare = compose({ greet: 'first', style, hotkey: '' }).text
    assert.ok(!/ ,|\s{2}|Ctrl\+Alt/.test(bare), bare)
  }
})

// ---------- who can post it ----------

test('only the start-up code posts it: no IPC, tool, board or agent path reaches the welcome module', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? files(join(d, f.name)) : /\.tsx?$/.test(f.name) ? [join(d, f.name)] : []))
  const root = join(import.meta.dirname, '..', 'src')
  const mainDir = join(root, 'main')
  const users = files(root).filter((f) => (f.startsWith(mainDir) && /from '\.\/welcome'/.test(readFileSync(f, 'utf8'))) || /main\/welcome'/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(users.map((f) => f.slice(root.length + 1).split('\\').join('/')), ['main/index.ts'])
  const index = readFileSync(join(root, 'main', 'index.ts'), 'utf8')
  assert.equal((index.match(/welcomeOnShow\(/g) ?? []).length, 1)
  assert.ok(!/ipcMain\.handle\([^)]*welcome/i.test(index))
  // posted straight into the store, not through boardPosted: no ping, no notification, no wake
  const main = readFileSync(join(root, 'main', 'welcome.ts'), 'utf8')
  assert.match(main, /post\(\{ author: 'assistant', text: out\.text, to: \['user'\] \}\)/)
  assert.ok(!/boardPosted|Notification|invoke|wake|question/.test(main.replace(/\/\/.*$/gm, '')))
})
