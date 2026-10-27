// Tests for #97, Extensions 3/8: the estimate engine with no history (defaults), some history (calibrated) and an author
// claim far from Corvid's; ranges widening with little data; the share of the 5-hour and weekly windows following fake
// quota values; the install confirmation (confirm, cancel, over the usage limit, nothing without the dialog's token);
// the soft cap with a fake build (asks past 2x, Continue asks again one estimate later, Stop keeps the branch, the cap
// setting); and estimated-versus-actual records feeding the next estimate. Usage, sessions and the dialog are fakes;
// the ledger runs in a temporary folder through a stand-in for electron, like test-extensions.mjs. No build is run.
//
//   npm run test-cost

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-cost-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent('export const app = { getPath: () => globalThis.__userData, isPackaged: false }')
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
const cost = await import(src + 'shared/costEstimate.ts')
const ledger = await import(src + 'main/extensions.ts')
const { getConfig, setConfig } = await import(src + 'main/config.ts')
const budget = await import(src + 'main/extensionBudget.ts')
after(() => rmSync(tmp, { recursive: true, force: true }))

const DAY = 86400_000
const NOW = Date.UTC(2026, 9, 21)
const base = { effort: 'medium', seedChars: 1500, checks: 4, tier: 2, model: 'claude-opus-5-5', history: [], now: NOW }
const width = (e) => e.tokens.high / e.tokens.low

// ---------- the engine ----------

test('no history: the documented defaults, a wide range, low confidence, labelled as an estimate', () => {
  const e = cost.estimate(base)
  assert.equal(e.tokens.likely, cost.EFFORT_DEFAULTS.medium.tokens)
  assert.equal(e.confidence, 'low')
  assert.equal(e.samples, 0)
  assert.match(e.label, /excluding retries and failed builds/)
  assert.match(e.basis, /defaults/)
  assert.ok(width(e) > 4.5, `range ${e.tokens.low}-${e.tokens.high}`)
  assert.ok(cost.estimate({ ...base, effort: 'small' }).tokens.likely < e.tokens.likely)
  assert.ok(cost.estimate({ ...base, effort: 'large' }).tokens.likely > e.tokens.likely)
})

test('inputs move it: protected core, a longer seed prompt, more checks, the classifier', () => {
  const e = cost.estimate(base).tokens.likely
  assert.ok(cost.estimate({ ...base, tier: 3 }).tokens.likely > e, 'protected core costs more')
  assert.ok(cost.estimate({ ...base, seedChars: 6000 }).tokens.likely > e)
  assert.ok(cost.estimate({ ...base, checks: 12 }).tokens.likely > e)
  assert.ok(cost.estimate({ ...base, complexity: 1 }).tokens.likely > cost.estimate({ ...base, complexity: 0 }).tokens.likely)
  // the classifier can raise the effort class, never lower it below what's declared
  assert.equal(cost.estimate({ ...base, inferredEffort: 'large' }).effort, 'large')
  assert.equal(cost.estimate({ ...base, inferredEffort: 'small' }).effort, 'medium')
})

const tasks = (n, tokens, effort = 'medium', ageDays = 1) =>
  Array.from({ length: n }, (_, i) => ({ kind: 'task', at: NOW - ageDays * DAY - i * 1000, effort, sizeChars: 1500, outputTokens: tokens * (1 + (i % 3) * 0.05), minutes: 40 }))

test('some history calibrates it, and the range narrows as history grows', () => {
  const few = cost.estimate({ ...base, history: tasks(2, 300_000) })
  const many = cost.estimate({ ...base, history: tasks(12, 300_000) })
  assert.ok(few.tokens.likely > cost.EFFORT_DEFAULTS.medium.tokens, 'pulled up by history')
  assert.ok(many.tokens.likely > few.tokens.likely, 'more history pulls further')
  assert.ok(Math.abs(many.tokens.likely - 300_000) / 300_000 < 0.25, `close to the history: ${many.tokens.likely}`)
  assert.ok(width(many) < width(few), 'narrower with more data')
  assert.ok(width(few) < width(cost.estimate(base)) + 0.01)
  assert.equal(many.confidence, 'high')
  assert.match(many.basis, /12 similar medium/)
})

test('recent history counts more, and failed or cancelled builds never feed it', () => {
  const recent = tasks(6, 300_000, 'medium', 1)
  const old = tasks(6, 60_000, 'medium', 200)
  assert.ok(cost.estimate({ ...base, history: [...recent, ...old] }).tokens.likely > 200_000)
  const failed = tasks(10, 900_000).map((r) => ({ ...r, kind: 'build', outcome: 'failed' }))
  assert.equal(cost.estimate({ ...base, history: failed }).tokens.likely, cost.EFFORT_DEFAULTS.medium.tokens)
})

test("an author claim far from Corvid's is flagged, a close one isn't", () => {
  assert.match(cost.estimate({ ...base, observed: { tokens: 20_000 } }).mismatch, /6\.0× what the author reports/)
  assert.match(cost.estimate({ ...base, observed: { cost: 'small' } }).mismatch, /author reports \(small cost\)/)
  assert.match(cost.estimate({ ...base, observed: { tokens: 900_000 } }).mismatch, /well below/)
  assert.equal(cost.estimate({ ...base, observed: { tokens: 110_000, minutes: 30 } }).mismatch, undefined)
  // the claim is shown, never used
  assert.equal(cost.estimate({ ...base, observed: { tokens: 20_000 } }).tokens.likely, cost.estimate(base).tokens.likely)
})

test('the share of the 5-hour and weekly windows follows the quota and the model', () => {
  const a = cost.estimate({ ...base, quota: { fiveHour: 72, week: 23 } })
  assert.equal(a.share.fiveHour.now, 72)
  assert.equal(a.share.week.now, 23)
  assert.ok(Math.abs(a.share.fiveHour.likely - (120_000 * 100) / cost.WINDOW_TOKENS.fiveHour) < 0.01)
  assert.ok(a.share.fiveHour.likely > a.share.week.likely)
  const b = cost.estimate({ ...base, quota: { fiveHour: 10, week: 90 } })
  assert.equal(b.share.fiveHour.now, 10)
  assert.equal(b.share.week.now, 90)
  assert.equal(cost.estimate({ ...base, quota: null }).share.fiveHour.now, undefined)
  assert.ok(cost.estimate({ ...base, model: 'sonnet' }).share.fiveHour.likely < a.share.fiveHour.likely)
})

test('Fable (#127): at least as costly as Opus; no Fable history is wide and low, Fable history calibrates it', () => {
  const opus = cost.estimate({ ...base, history: tasks(12, 300_000) })
  const guess = cost.estimate({ ...base, model: 'fable', history: tasks(12, 300_000) })
  assert.ok(guess.share.fiveHour.likely >= opus.share.fiveHour.likely, 'never cheaper than Opus')
  assert.equal(guess.confidence, 'low')
  assert.ok(width(guess) > width(opus), 'a wider range')
  assert.ok(width(guess) > cost.FABLE_PRIOR_SPREAD ** 2 * 0.95, `range ${guess.tokens.low}-${guess.tokens.high}`)
  assert.match(guess.basis, /On Fable a token counts 2× an Opus one; with too little Fable work on this PC yet, the range is wide and confidence is low/)
  // Fable's own sessions (by family, like the session index's models) calibrate its tokens once there are a few
  const fableWork = tasks(8, 500_000).map((r) => ({ ...r, model: 'claude-fable-5-1' }))
  const known = cost.estimate({ ...base, model: 'claude-fable-5-1', history: [...tasks(12, 300_000), ...fableWork] })
  assert.notEqual(known.confidence, 'low')
  // only the Fable work feeds it: the same 8 records at the other sessions' 300k would give less
  const asOthers = cost.estimate({ ...base, model: 'claude-fable-5-1', history: tasks(8, 300_000).map((r) => ({ ...r, model: 'claude-fable-5-1' })) })
  assert.ok(known.tokens.likely > asOthers.tokens.likely * 1.2, `pulled by the Fable history: ${known.tokens.likely} vs ${asOthers.tokens.likely}`)
  assert.match(known.basis, /8 similar medium Fable pieces/)
  assert.doesNotMatch(known.basis, /too little Fable/)
  const scan = cost.scanEstimate('fable')
  assert.equal(scan.model, 'fable')
  assert.equal(scan.confidence, 'low')
  assert.ok(scan.share.week.likely > cost.scanEstimate('opus').share.week.likely)
})

test('the scan has a small fixed cost through the same display', () => {
  const s = cost.scanEstimate('haiku', { fiveHour: 40 })
  assert.equal(s.tokens.likely, cost.SCAN_COST.tokens)
  assert.equal(s.share.fiveHour.now, 40)
  assert.ok(s.share.fiveHour.likely < 1)
})

test('the cap: asks at 2x, Continue moves the next ask one estimate on, the multiple is clamped', () => {
  let c = cost.newCap(100_000, 2)
  assert.equal(c.askAt, 200_000)
  assert.ok(!cost.overCap(c, 199_000))
  assert.ok(cost.overCap(c, 201_000))
  c = cost.raiseCap(c, 201_000)
  assert.equal(c.askAt, 301_000)
  assert.equal(c.continued, 1)
  assert.equal(cost.newCap(100_000, 3).askAt, 300_000)
  assert.equal(cost.cleanCapMultiple(99), cost.CAP_MULTIPLE.max)
  assert.equal(cost.cleanCapMultiple('x'), 2)
})

// ---------- the main process: history, the confirmation, the monitor ----------

const corvid = (id, seedWords = 60) => `---
format: 1
id: ${id}
name: Sample ${id.replace(/-/g, ' ')}
version: 1.0.0
description: A sample extension for the cost tests.
built_on: 0.1.0 @ 15be862
effort: medium
effort.tokens: 20000
capabilities.tier: 2
capabilities.core_areas: board
capabilities.rebuild: yes
---

## Summary

A sample.

## What it does

Nothing real.

## Seed prompt

${Array.from({ length: seedWords }, () => 'word').join(' ')}

## Acceptance checks

1. One.
2. Two.
3. Three.
4. Four.
`

let usage = null
let sessions = []
const asked = []
const notices = []
let answers = []
budget.initBudget({
  sessions: () => sessions,
  quota: () => usage,
  askCap: async (title, text) => {
    asked.push({ title, text })
    return answers.shift() ?? true
  },
  notice: (text) => notices.push(text)
})
const keyOf = (id) => ledger.list().find((r) => r.id === id).key

test('history: finished "#<id>" task sessions summed over resumes; live, junk and untitled ones are skipped', () => {
  const now = Date.now()
  const s = (id, title, out, extra = {}) => ({ id, title, firstPrompt: 'x'.repeat(1500), startedAt: now - 3 * 3600_000, lastActivity: now - 2 * 3600_000, tokens: { output: out }, models: { 'claude-opus-5-5': 1 }, junk: false, ...extra })
  const h = budget.history(
    [s('a', '#12 Fix the thing', 100_000), s('b', '#12 Fix the thing (resumed)', 50_000), s('c', '#13 Live one', 9, { lastActivity: now }), s('d', 'Plain chat', 5), s('e', '#14 junk', 7, { junk: true })],
    [],
    now
  )
  assert.equal(h.length, 1)
  assert.equal(h[0].outputTokens, 150_000)
  assert.equal(h[0].effort, 'medium')
})

test('the estimate for an extension uses its seed prompt and checks, and the quota', () => {
  ledger.importText(corvid('cost-one'))
  usage = { fiveHour: 30, week: 20, at: Date.now() }
  const e = budget.estimateFor(keyOf('cost-one'))
  assert.equal(e.share.fiveHour.now, 30)
  assert.match(e.mismatch, /author reports \(20,000 tokens\)/)
  assert.ok(e.tokens.likely < cost.EFFORT_DEFAULTS.medium.tokens, 'a short seed prompt costs less')
})

test('confirmation: Cancel starts nothing; Confirm needs the token from this dialog, once; nothing else confirms', () => {
  const key = keyOf('cost-one')
  // without a dialog there is no token, so an agent or a board message has nothing to confirm with
  assert.match(budget.confirmInstall(key, 'yes').error, /expired/)
  assert.match(budget.confirmInstall(key, undefined).error, /expired/)
  const p = budget.prepareInstall(key)
  assert.ok(p.token && p.estimate && p.capMultiple === 2 && p.capTokens === p.estimate.tokens.likely * 2)
  assert.equal(p.usage, undefined, 'under the limit: no second warning')
  // Cancel: the dialog just closes; nothing was recorded
  assert.equal(ledger.list().find((r) => r.key === key).cost, undefined)
  assert.match(budget.confirmInstall(keyOf('cost-one') + 'x', p.token).error, /expired/, 'a token is for its own extension')
  let started = null
  budget.onInstallConfirmed((k) => ((started = k), false))
  const p2 = budget.prepareInstall(key)
  const ok = budget.confirmInstall(key, p2.token)
  assert.ok(ok.ok)
  assert.equal(started, key)
  assert.match(ok.message, /nothing was started/)
  assert.ok(ledger.list().find((r) => r.key === key).cost.estimate.confirmedAt)
  assert.match(budget.confirmInstall(key, p2.token).error, /expired/, 'used once')
})

test('over the usage limit: one combined warning in the same dialog; "block" disables Confirm', () => {
  const key = keyOf('cost-one')
  usage = { fiveHour: 85, week: 20, at: Date.now() }
  let p = budget.prepareInstall(key)
  assert.match(p.usage.text, /5-hour usage is at 85% \(your limit is 70%\)/)
  assert.equal(p.usage.block, false)
  assert.ok(budget.confirmInstall(key, p.token).ok, 'Ask me first: Build anyway works')
  usage = { fiveHour: 85, week: 95, at: Date.now() }
  assert.match(budget.prepareInstall(key).usage.text, /and weekly usage is at 95%/)
  setConfig({ ...getConfig(), limits: { ...getConfig().limits, overLimit: 'block' } })
  p = budget.prepareInstall(key)
  assert.equal(p.usage.block, true)
  assert.match(budget.confirmInstall(key, p.token).error, /nothing was started/)
  usage = null
  assert.match(budget.prepareInstall(key).usage.text, /unknown/)
  setConfig({ ...getConfig(), limits: { ...getConfig().limits, overLimit: 'ask' } })
  usage = { fiveHour: 10, week: 10, at: Date.now() }
})

const fakeBuild = (key, likely) => {
  let tokens = 0
  let stopped = false
  const e = { ...budget.estimateFor(key), tokens: { low: likely / 2, likely, high: likely * 2 } }
  const h = budget.watchBuild({ key, what: 'The build of Sample', estimate: e, outputTokens: () => tokens, stop: () => void (stopped = true), seedChars: 300, checks: 4, tier: 2, pollMs: 1e9 })
  return { h, set: (n) => (tokens = n), stopped: () => stopped }
}

test('the cap with a fake build: asks past 2x, Continue asks again at the next estimate, Stop keeps the branch', async () => {
  const key = keyOf('cost-one')
  asked.length = notices.length = 0
  const b = fakeBuild(key, 100_000)
  b.set(150_000)
  await b.h.tick()
  assert.equal(asked.length, 0, 'under the cap: no question')
  answers = [true]
  b.set(205_000)
  await b.h.tick()
  assert.equal(asked.length, 1)
  assert.match(asked[0].title, /used about 2x its estimate\. Continue, or stop\?/)
  assert.match(asked[0].text, /205k output tokens against an estimate of 100k/)
  assert.match(asked[0].text, /keeps its branch/)
  assert.equal(b.h.cap().askAt, 305_000)
  b.set(290_000)
  await b.h.tick()
  assert.equal(asked.length, 1, 'no question before the next estimate')
  answers = [false]
  b.set(310_000)
  await b.h.tick()
  assert.equal(asked.length, 2)
  assert.ok(b.stopped(), 'Stop ends the agent')
  assert.ok(notices.some((n) => /stopped at its budget cap\. The branch and the work so far are kept/.test(n)))
  const r = ledger.list().find((x) => x.key === key)
  assert.equal(r.cost.actual.amount, 310_000)
  assert.equal(r.cost.actual.capHit, true)
  assert.equal(r.cost.runs.at(-1).outcome, 'cancelled')
  assert.equal(r.cost.runs.at(-1).continued, 1)
})

test('the cap setting changes when it asks', async () => {
  setConfig({ ...getConfig(), extensionCapMultiple: 3 })
  asked.length = 0
  const b = fakeBuild(keyOf('cost-one'), 100_000)
  b.set(250_000)
  await b.h.tick()
  assert.equal(asked.length, 0)
  answers = [true]
  b.set(301_000)
  await b.h.tick()
  assert.equal(asked.length, 1)
  b.h.finish('ok')
  setConfig({ ...getConfig(), extensionCapMultiple: 2 })
})

test('estimated-versus-actual records feed the next estimate and the "off by" note; failed ones are kept but unused', async () => {
  ledger.importText(corvid('cost-two', 300))
  const key = keyOf('cost-two')
  const before = budget.estimateFor(key).tokens.likely
  for (let i = 0; i < 4; i++) {
    const b = fakeBuild(key, 100_000)
    b.set(400_000)
    answers = [true, true, true]
    b.h.finish('ok')
  }
  const failed = fakeBuild(key, 100_000)
  failed.set(5_000_000)
  failed.h.finish('failed')
  const r = ledger.list().find((x) => x.key === key)
  assert.equal(r.cost.runs.length, 5, 'all kept in the ledger')
  const after = budget.estimateFor(key)
  assert.ok(after.tokens.likely > before * 1.5, `${before} -> ${after.tokens.likely}`)
  assert.ok(after.tokens.likely < 2_000_000, 'the failed build is ignored')
  const acc = budget.accuracy()
  assert.ok(acc.n >= 3)
  assert.ok(acc.offBy >= 100, `off by ${acc.offBy}%`)
  // stored on disk, nothing anywhere else
  const disk = JSON.parse(readFileSync(join(globalThis.__userData, 'extensions.json'), 'utf8'))
  assert.equal(disk.extensions.find((x) => x.key === key).cost.runs.length, 5)
})

test('no network and no evaluation in the estimate or the budget code', () => {
  for (const f of ['src/shared/costEstimate.ts', 'src/main/extensionBudget.ts', 'src/renderer/src/views/ExtensionCost.tsx']) {
    const t = readFileSync(join(root, f), 'utf8')
    assert.doesNotMatch(t, /\bfetch\(|https?:\/\/|net\.request|\beval\(|new Function|child_process/, f)
  }
})
