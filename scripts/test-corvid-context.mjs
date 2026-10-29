// Tests for #326, Corvid's context ring: a fixture transcript of Corvid's session goes through the indexer's own parser
// (the numbers an agent card's ctx tag shows), then into the ring: its share of the window, the colour past 60% and
// 85%, the tooltip, the window for a Claude or a custom model, and the compacted state. Nothing is started and no real
// transcript is read.
//
//   npm run test-corvid-context

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
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.split('?')[0].endsWith('.ts') && !/\\.[a-z]+$/.test(s)) return next(s + '.ts', c)
      return next(s, c)
    }
    export async function load(u, c, next) {
      return u.split('?')[0].endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const { newState, applyRecord } = await import('../src/main/indexer/parse.ts')
const { corvidWindow, ringTitle, ringUse, CORVID_WINDOW } = await import('../src/shared/context.ts')

// ---------- a fixture of Corvid's transcript, as Claude Code writes it ----------

const CWD = 'C:\\fixture\\Corvid\\assistant'
let n = 0
const at = () => new Date(Date.UTC(2026, 9, 28, 9, 0, n++)).toISOString()
const user = (text) => ({ type: 'user', cwd: CWD, timestamp: at(), message: { role: 'user', content: text } })
const reply = (usage, text = 'ok') => ({
  type: 'assistant',
  cwd: CWD,
  timestamp: at(),
  message: { id: `msg_${n}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }], usage }
})

function summary(records) {
  const st = newState('corvid-session', 'corvid-session.jsonl', 'fixture')
  for (const r of records) applyRecord(st, r, {})
  return st.summary
}

test("the ring reads the latest reply's input + cache read + cache write, as the ctx tag does", () => {
  const s = summary([
    user('what is next?'),
    reply({ input_tokens: 10, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000, output_tokens: 400 }),
    user('and then?'),
    reply({ input_tokens: 4, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 13_996, output_tokens: 900 })
  ])
  assert.equal(s.context, 214_000)
  const u = ringUse(s.context, CORVID_WINDOW)
  assert.equal(u.level, 'calm')
  assert.equal(ringTitle(u), "Corvid's context: 214k of 1M (21%). Claude Code compacts on its own near the end.")
})

test('amber past 60%, red past 85%, and never more than full', () => {
  assert.equal(ringUse(599_999, CORVID_WINDOW).level, 'calm')
  assert.equal(ringUse(600_000, CORVID_WINDOW).level, 'amber')
  assert.equal(ringUse(740_000, CORVID_WINDOW).level, 'amber')
  assert.equal(ringUse(850_000, CORVID_WINDOW).level, 'red')
  assert.equal(ringUse(1_200_000, CORVID_WINDOW).share, 1)
})

test("a compact boundary leaves the size unknown until Corvid's next reply", () => {
  const s = summary([
    user('hi'),
    reply({ input_tokens: 5, cache_read_input_tokens: 700_000, cache_creation_input_tokens: 40_000, output_tokens: 10 }),
    { type: 'system', subtype: 'compact_boundary', cwd: CWD, timestamp: at() }
  ])
  assert.equal(s.context, 0)
  assert.ok(s.peakContext > 0, 'the conversation still had a reply, so the ring stays')
  const u = ringUse(s.context, CORVID_WINDOW)
  assert.equal(u.compacted, true)
  assert.match(ringTitle(u), /just compacted/)
})

test("the window is 1M on a Claude model and the entry's context on a custom one", () => {
  const models = [{ id: 'qwen', label: 'Qwen', baseUrl: 'http://localhost:8080', model: 'qwen', contextTokens: 65_536 }]
  for (const m of ['haiku', 'sonnet', 'opus', 'fable', 'default']) assert.equal(corvidWindow(m, models), 1_000_000)
  assert.equal(corvidWindow('custom:qwen', models), 65_536)
  // an entry that's gone falls back rather than dividing by nothing
  assert.equal(corvidWindow('custom:gone', models), 1_000_000)
  assert.equal(ringTitle(ringUse(50_000, 65_536)), "Corvid's context: 50k of 66k (76%). Claude Code compacts on its own near the end.")
})
