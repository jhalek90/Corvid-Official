// Tests for #216, tours Corvid the assistant makes on the fly: play_tour refuses unknown anchors and over-long tours
// and plays a valid one, save_tour only saves when the user asked and writes a file that loads back and validates,
// and an agent's ping turn refuses play_tour and save_tour. Only a temporary folder is touched.
//
//   npm test -- --test-name-pattern=tour-tools

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-tour-tools-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
after(() => rmSync(tmp, { recursive: true, force: true }))
const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent(\`
      export const app = { getPath: () => globalThis.__userData, isPackaged: false }
      export const safeStorage = { isEncryptionAvailable: () => false }\`)
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
      return u.endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)
const { tourTools } = await import(src + 'main/tourTools.ts')
const { gateTools, CORVID_PING_TOOLS } = await import(src + 'main/agentPing.ts')
const { readUserTours, toursDir } = await import(src + 'main/tours.ts')
const T = await import(src + 'shared/tours.ts')

const steps = (n) => Array.from({ length: n }, (_, i) => ({ anchor: i % 2 ? 'nav.tasks' : 'nav.notes', text: `Step ${i + 1}: look here.` }))
const make = (request = 'show me where notes are') => {
  const played = []
  const ask = { text: request }
  const tools = Object.fromEntries(tourTools({ play: (t) => played.push(t), dir: toursDir, request: () => ask.text }).map((t) => [t.name, t]))
  return { tools, played, ask }
}

test('tour-tools: tour_anchors lists the registry, the views and the events', () => {
  const r = make().tools.tour_anchors.run({})
  assert.ok(r.anchors.some((a) => a.name === 'nav.tasks' && a.about))
  assert.ok(r.views.includes('notes'))
  assert.ok(r.events.includes('task-created') && r.events.includes('view-opened:tasks'))
  assert.equal(r.limits.steps, T.MAX_FLY_STEPS)
})

test('tour-tools: play_tour refuses unknown anchors and over-long tours, and plays nothing', () => {
  const { tools, played } = make()
  const bad = tools.play_tour.run({ title: 'Where notes live', steps: [{ anchor: 'nav.nowhere', text: 'Here.' }, { anchor: '#app > div', text: 'x' }] })
  assert.match(bad, /Not played/)
  assert.match(bad, /Step 1: unknown anchor "nav.nowhere"/)
  assert.match(bad, /Step 2: unknown anchor/)
  const long = tools.play_tour.run({ title: 'Too long', steps: steps(T.MAX_FLY_STEPS + 1) })
  assert.match(long, new RegExp(`at most ${T.MAX_FLY_STEPS}`))
  // a written tour may have 12 steps; one made on the spot may not, whatever else is wrong
  assert.match(tools.play_tour.run({ title: '', steps: steps(T.MAX_STEPS + 1) }), new RegExp(`at most ${T.MAX_FLY_STEPS}`))
  assert.match(tools.play_tour.run({ title: 'Long text', steps: [{ anchor: 'nav.tasks', text: 'x'.repeat(T.MAX_TEXT + 1) }] }), /at most 240/)
  assert.deepEqual(played, [])
})

test('tour-tools: play_tour plays a valid tour in the #214 format, and a second one replaces it', () => {
  const { tools, played } = make()
  const ok = tools.play_tour.run({ title: 'Where notes live!', steps: [{ anchor: 'nav.notes', text: '  Notes are here.  ' }, { anchor: 'notes.view', view: 'notes', text: 'Each note is shared.' }, { anchor: 'nav.tasks', text: 'Tasks are next door.', advance: 'next' }] })
  assert.match(ok, /Playing "Where notes live!" \(3 steps\)/)
  assert.equal(played.length, 1)
  const t = played[0]
  assert.equal(t.format, 1)
  assert.equal(t.id, 'where-notes-live')
  assert.equal(t.summary, 'Where notes live!')
  assert.equal(t.steps[0].text, 'Notes are here.')
  assert.equal(t.steps[2].advance, undefined)
  // what plays is exactly what the renderer's validateTour accepts
  assert.deepEqual(T.validateTour(t), { tour: t })
  tools.play_tour.run({ title: 'Another', steps: steps(3) })
  assert.equal(played.length, 2)
})

test('tour-tools: save_tour only saves when the user asked to keep it', () => {
  const { tools, ask } = make('how do I add a task?')
  tools.play_tour.run({ title: 'Adding a task', steps: steps(3) })
  assert.match(tools.save_tour.run({}), /Not saved: save_tour only runs when the user asks/)
  assert.equal(readUserTours().tours.length, 0)
  ask.text = 'great, save that tour please'
  assert.match(tools.save_tour.run({}), /Saved "Adding a task" as my-adding-a-task\.json/)
})

test('tour-tools: a saved tour loads back from the tours folder and validates; a second save never overwrites', () => {
  const { tools } = make('keep this one')
  assert.match(tools.save_tour.run({}), /no tour has been played yet/)
  const r1 = tools.save_tour.run({ title: 'Usage bars', summary: 'Where the limits are.', steps: [{ anchor: 'nav.usage', text: 'Usage lives here.' }, { anchor: 'usage.view', view: 'usage', text: 'The 5-hour and weekly bars.' }] })
  assert.match(r1, /my-usage-bars\.json/)
  const r2 = tools.save_tour.run({ title: 'Usage bars', steps: steps(2) })
  assert.match(r2, /my-usage-bars-2\.json/)
  assert.ok(!readdirSync(toursDir()).some((f) => f.endsWith('.tmp')))
  const { tours, skipped } = readUserTours()
  assert.deepEqual(skipped, [])
  const usage = tours.find((t) => t.id === 'my-usage-bars')
  assert.equal(usage.summary, 'Where the limits are.')
  assert.equal(usage.steps[1].view, 'usage')
  assert.ok('tour' in T.validateTour(JSON.parse(readFileSync(join(toursDir(), 'my-usage-bars.json'), 'utf8'))))
  // saved ids carry a prefix, so a saved tour never clashes with a built-in one
  assert.deepEqual(T.mergeTours([{ ...usage, id: 'your-first-day' }], tours).clashes, [])
  assert.match(tools.save_tour.run({ title: 'Bad', steps: [{ anchor: 'nope', text: 'x' }] }), /Not saved/)
})

test("tour-tools: an agent's ping turn refuses play_tour and save_tour; tour_anchors still answers", () => {
  const { tools, played } = make('save that tour')
  let restricted = true
  const gated = Object.fromEntries(gateTools(Object.values(tools), () => restricted).map((t) => [t.name, t]))
  assert.throws(() => gated.play_tour.run({ title: 'x', steps: steps(2) }), /started by an agent's ping/)
  assert.throws(() => gated.save_tour.run({ title: 'x', steps: steps(2) }), /started by an agent's ping/)
  assert.ok(gated.tour_anchors.run({}).anchors.length)
  assert.ok(CORVID_PING_TOOLS.has('tour_anchors') && !CORVID_PING_TOOLS.has('play_tour') && !CORVID_PING_TOOLS.has('save_tour'))
  assert.deepEqual(played, [])
  restricted = false
  assert.match(gated.play_tour.run({ title: 'x', steps: steps(2) }), /Playing/)
})

test('tour-tools: only the assistant gets the tour tools, never a worker', () => {
  const main = join(root, 'src', 'main')
  const users = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.ts$/.test(e.name) && e.name !== 'tourTools.ts' && /from '\.\/tourTools'/.test(readFileSync(p, 'utf8'))) users.push(e.name)
    }
  }
  walk(main)
  assert.deepEqual(users, ['assistantTools.ts'])
  // and assistantTools reaches workers nowhere: only Corvid's own endpoint is built from it
  const index = readFileSync(join(main, 'index.ts'), 'utf8')
  assert.equal((index.match(/assistantTools\(/g) ?? []).length, 1)
  assert.match(index, /startMcp\(\s*agentPing\.gateTools\(assistantTools\(/)
})
