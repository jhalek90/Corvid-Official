// Tests for #214, guided tours: the validator (a good tour and each error), the anchor registry against the renderer
// source, every built-in tour, the docs page's anchor list, and the player's step logic as pure functions (next,
// back, a missing anchor, an event advance). No app or data folder is touched.
//
//   npm test -- --test-name-pattern=tours

import { register } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(s, c, next) {
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.split('?')[0].endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
        return next(s + '.ts', c)
      }
      return next(s, c)
    }
    export async function load(u, c, next) {
      return /\\.ts(?:\\?|$)/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)
const T = await import(src + 'shared/tours.ts')
const A = await import(src + 'shared/tourAnchors.ts')

const good = () => ({
  format: 1,
  id: 'test-tour',
  title: 'A test tour',
  summary: 'Two steps.',
  steps: [
    { anchor: 'nav.tasks', text: 'The task board.' },
    { anchor: 'board.add-task', view: 'tasks', advance: 'task-created', text: 'Add a task.' }
  ]
})
const errorsOf = (json) => {
  const r = T.validateTour(json)
  assert.ok('errors' in r, 'expected errors')
  return r.errors.join(' | ')
}

test('tours: a good tour validates, trimmed to the known fields', () => {
  const r = T.validateTour({ ...good(), extra: 1 })
  assert.ok('tour' in r)
  assert.equal(r.tour.id, 'test-tour')
  assert.equal(r.tour.steps[1].advance, 'task-created')
  assert.equal(r.tour.extra, undefined)
  // "next" is the default, so it is left out
  const n = T.validateTour({ ...good(), steps: [{ anchor: 'nav.tasks', text: 'x', advance: 'next' }] })
  assert.equal(n.tour.steps[0].advance, undefined)
})

test('tours: each error is named in plain words', () => {
  assert.match(errorsOf(null), /JSON object/)
  assert.match(errorsOf({ ...good(), format: 2 }), /Unknown format 2/)
  assert.match(errorsOf({ ...good(), id: 'Bad Id' }), /"id" must be lowercase/)
  assert.match(errorsOf({ ...good(), title: '' }), /"title" must be a non-empty string/)
  assert.match(errorsOf({ ...good(), steps: [] }), /at least one step/)
  assert.match(errorsOf({ ...good(), steps: [{ anchor: '.kcol', text: 'x' }] }), /Step 1: unknown anchor "\.kcol"/)
  assert.match(errorsOf({ ...good(), steps: [{ anchor: 'nav.tasks', text: 'x', advance: 'task-deleted' }] }), /unknown event "task-deleted"/)
  assert.match(errorsOf({ ...good(), steps: [{ anchor: 'nav.tasks', text: 'x', advance: 'view-opened:nowhere' }] }), /unknown event/)
  assert.match(errorsOf({ ...good(), steps: [{ anchor: 'nav.tasks', text: 'x', view: 'sessions' }] }), /unknown view "sessions"/)
  assert.match(errorsOf({ ...good(), steps: [{ anchor: 'nav.tasks', text: 'x'.repeat(T.MAX_TEXT + 1) }] }), /at most 240/)
  const many = Array.from({ length: T.MAX_STEPS + 1 }, () => ({ anchor: 'nav.tasks', text: 'x' }))
  assert.match(errorsOf({ ...good(), steps: many }), /Too many steps: 13; at most 12/)
  assert.ok(T.isTourEvent('view-opened:notes'))
})

test('tours: a custom anchor list is honoured', () => {
  assert.ok('tour' in T.validateTour({ ...good(), steps: [{ anchor: 'mine', text: 'x' }] }, new Set(['mine'])))
})

/** Every renderer source file, joined. */
function rendererSources() {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(join(root, 'src', 'renderer', 'src'))
  return out.join('\n')
}

test('tours: every registry anchor has a data-tour in the renderer source', () => {
  // the names in data-tour attributes: plain strings on those lines, and the rail's nav.${v} over its NAV list
  const named = new Set()
  for (const line of rendererSources().split('\n'))
    if (line.includes('data-tour=')) for (const m of line.matchAll(/["']([a-z]+\.[a-z-]+)["']/g)) named.add(m[1])
  const app = readFileSync(join(root, 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
  assert.ok(app.includes('data-tour={`nav.${v}`}'), 'the rail tags its entries')
  const nav = /const NAV: View\[\] = \[([^\]]*)\]/.exec(app)[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1))
  for (const v of nav) named.add(`nav.${v}`)
  const names = new Set(A.TOUR_ANCHORS.map((a) => a.name))
  assert.equal(names.size, A.TOUR_ANCHORS.length, 'anchor names are unique')
  for (const a of A.TOUR_ANCHORS) {
    assert.ok(named.has(a.name), `no data-tour="${a.name}" in the renderer`)
    assert.ok(a.about.length > 0 && a.about.length <= 120, `${a.name} needs a one-line description`)
  }
})

test('tours: every built-in tour validates, with a unique id', () => {
  const dir = join(root, 'src', 'renderer', 'src', 'tours')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  assert.ok(files.includes('your-first-day.json'))
  const ids = new Set()
  for (const f of files) {
    const r = T.validateTour(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    assert.ok('tour' in r, `${f}: ${r.errors?.join('; ')}`)
    assert.ok(!ids.has(r.tour.id), `${f}: duplicate id`)
    ids.add(r.tour.id)
  }
})

test('tours: the docs page lists every anchor', () => {
  const page = readFileSync(join(root, 'docs', 'getting-started', 'guided-tours.md'), 'utf8')
  for (const a of A.TOUR_ANCHORS) assert.ok(page.includes(`\`${a.name}\``), `docs miss ${a.name}`)
})

test('tours: next, back and the end', () => {
  const tour = T.validateTour(good()).tour
  let run = T.startTour(tour)
  assert.equal(T.stepLabel(run), 'Step 1 of 2')
  assert.deepEqual(T.backStep(run), run, 'back stays on the first step')
  run = T.nextStep(run).run
  assert.equal(run.index, 1)
  assert.equal(T.backStep(run).index, 0)
  assert.deepEqual(T.nextStep(run), { end: 'finished' })
})

test('tours: a hands-on step moves on only for its own event', () => {
  const tour = T.validateTour(good()).tour
  const first = T.startTour(tour)
  assert.equal(T.waitsForEvent(T.currentStep(first)), false)
  assert.equal(T.onTourEvent(first, 'task-created'), null, 'a Next step ignores events')
  const second = T.nextStep(first).run
  assert.equal(T.waitsForEvent(T.currentStep(second)), true)
  assert.equal(T.onTourEvent(second, 'worker-started'), null)
  assert.deepEqual(T.onTourEvent(second, 'task-created'), { end: 'finished' })
})

test('tours: a missing anchor puts the bubble in the middle; a present one beside it', () => {
  const win = { width: 1000, height: 800 }
  const bubble = { width: 300, height: 120 }
  assert.deepEqual(T.bubbleBox(null, bubble, win), { left: 350, top: 340, centred: true })
  assert.equal(T.bubbleBox({ left: 0, top: 0, width: 0, height: 0 }, bubble, win).centred, true)
  assert.deepEqual(T.bubbleBox({ left: 100, top: 100, width: 200, height: 40 }, bubble, win), { left: 50, top: 154, centred: false })
  const above = T.bubbleBox({ left: 600, top: 700, width: 100, height: 40 }, bubble, win)
  assert.equal(above.top, 700 - 14 - 120)
  assert.ok(above.left + bubble.width <= win.width - 8)
})

test('tours: user tours never replace a built-in; the first-run offer shows once', () => {
  const tour = T.validateTour(good()).tour
  const { tours, clashes } = T.mergeTours([tour], [tour, { ...tour, id: 'other' }])
  assert.deepEqual(
    tours.map((t) => `${t.id}:${t.source}`),
    ['test-tour:built-in', 'other:user']
  )
  assert.deepEqual(clashes, ['test-tour'])
  assert.equal(T.shouldOfferTour(T.readToursState(undefined), undefined), true)
  assert.equal(T.shouldOfferTour({ finished: [], offered: true }, undefined), false)
  assert.equal(T.shouldOfferTour({ finished: ['x'] }, undefined), false)
  assert.equal(T.shouldOfferTour({ finished: [] }, false), false)
  assert.deepEqual(T.readToursState({ finished: ['a', 3], offered: 'yes' }), { finished: ['a'], offered: undefined })
})

test('tours: a narrow Agents view shows the half the step points at', () => {
  assert.equal(T.agentsPaneFor('messages.board'), 'board')
  assert.equal(T.agentsPaneFor('messages.corvid'), 'board')
  assert.equal(T.agentsPaneFor('messages.box'), 'board')
  assert.equal(T.agentsPaneFor('agents.worker-card'), 'cards')
  assert.equal(T.agentsPaneFor('agents.view'), undefined)
  assert.equal(T.agentsPaneFor('nav.tasks'), undefined)
  for (const a of A.TOUR_ANCHORS.filter((x) => x.name.startsWith('messages.'))) assert.equal(T.agentsPaneFor(a.name), 'board', a.name)
})

test('tours: a view offers its tour once, never with the first-run card, never once finished (#215)', () => {
  const answered = { finished: [], offered: true }
  assert.equal(T.shouldHintTour(answered, undefined, 'who-knows-what'), true)
  assert.equal(T.shouldHintTour({ finished: [] }, undefined, 'who-knows-what'), false, 'the first-run card is still due')
  assert.equal(T.shouldHintTour(answered, false, 'who-knows-what'), false, 'tours are off')
  assert.equal(T.shouldHintTour({ ...answered, hinted: ['who-knows-what'] }, undefined, 'who-knows-what'), false)
  assert.equal(T.shouldHintTour({ finished: ['who-knows-what'], offered: true }, undefined, 'who-knows-what'), false)
  assert.deepEqual(T.readToursState({ finished: [], offered: true, hinted: ['who-knows-what', 7] }), { finished: [], offered: true, hinted: ['who-knows-what'] })
})

test('tours: "Who knows what" ends in the Context cloud, and the cloud offers it (#215)', () => {
  const r = T.validateTour(JSON.parse(readFileSync(join(root, 'src', 'renderer', 'src', 'tours', 'who-knows-what.json'), 'utf8')))
  assert.ok('tour' in r, r.errors?.join('; '))
  const steps = r.tour.steps
  assert.ok(steps.length >= 6 && steps.length <= 8, `${steps.length} steps`)
  assert.equal(steps.at(-1).view, 'lineage')
  assert.match(steps.at(-1).text, /while a worker runs and watch/)
  const view = readFileSync(join(root, 'src', 'renderer', 'src', 'views', 'LineageView.tsx'), 'utf8')
  assert.ok(view.includes('<TourHint id="who-knows-what"'), 'the Context cloud offers the tour')
})

test('tours: the "?" menu lists built-in and user tours as the Docs list does, finished ones checked (#218)', () => {
  const tour = T.validateTour(good()).tour
  const mine = { ...tour, id: 'mine', title: 'Mine', summary: 'My own.' }
  const { tours } = T.mergeTours([tour], [mine, tour])
  const entries = T.tourEntries(tours, ['mine'])
  assert.deepEqual(entries, [
    { id: 'test-tour', title: 'A test tour', summary: 'Two steps.', yours: false, done: false },
    { id: 'mine', title: 'Mine', summary: 'My own.', yours: true, done: true }
  ])
  // one source: both lists draw from useTourEntries, and the menu never reads the tours itself
  const dir = join(root, 'src', 'renderer', 'src', 'components')
  const player = readFileSync(join(dir, 'TourPlayer.tsx'), 'utf8')
  const menu = readFileSync(join(dir, 'TourMenu.tsx'), 'utf8')
  assert.match(player, /export function TourList[\s\S]*useTourEntries\(\)/)
  assert.match(menu, /useTourEntries\(\)/)
  assert.doesNotMatch(menu, /toursUser|mergeTours/)
  // the menu's last entry asks Corvid, through the Ask Corvid button's own path
  assert.match(menu, /askCorvid\('Explain '\)/)
})

test('tours: "Your first day" ends at the "?" button, and still validates (#218)', () => {
  assert.ok(A.TOUR_ANCHOR_NAMES.has('titlebar.tours'))
  const json = JSON.parse(readFileSync(join(root, 'src', 'renderer', 'src', 'tours', 'your-first-day.json'), 'utf8'))
  const r = T.validateTour(json)
  assert.ok('tour' in r, r.errors?.join('; '))
  const last = r.tour.steps.at(-1)
  assert.equal(last.anchor, 'titlebar.tours')
  assert.equal(last.view, undefined, 'the title bar shows in every view')
})
