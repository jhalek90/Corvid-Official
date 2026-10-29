// Tests for #93, starting agents above the usage limit: under the limit no question; over the 5-hour gate, the weekly
// gate or both the user is asked with the right numbers; Cancel and the timeout start nothing; Start anyway starts it
// and puts it on record; the master switch, each gate's switch and "Block new agents"; unknown usage; two starts at
// once; start_worker's detached ask; "don't ask again until usage resets"; and config.json repair. Usage is faked
// through the workers' quota dependency and the dialog is a stand-in; no Claude session, git or terminal is started.
// Runs on Node 24's own TypeScript support with stand-ins for electron, the terminals and git, like test-drafts.mjs.
//
//   npm run test-usage-limit

import { register } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-usage-limit-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const project = join(tmp, 'project')
mkdirSync(project)
// the workers' clocks tick on intervals; they mustn't keep the test process alive
const realInterval = globalThis.setInterval
globalThis.setInterval = (...a) => realInterval(...a).unref()

const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
const mod = (code) => `'data:text/javascript,' + encodeURIComponent(${JSON.stringify(code)})`
const stubs = {
  electron: `export const app = { getPath: () => globalThis.__userData }; export const powerMonitor = { on() {} }`,
  './pty': `let n = 0
    export const launchWorker = () => ({ termId: 't' + ++n })
    export const listTerminals = () => []
    export const onTerminalExit = () => {}
    export const onTerminalData = () => {}
    export const kill = () => {}
    export const lastOutput = () => undefined`,
  './claudeBin': `export const resolveClaude = async () => ({ path: 'claude' }); export const CLAUDE_NOT_FOUND = 'Claude Code (claude) not found.'`,
  './agentGit': `export const prepareBranch = async () => ({ kind: 'current' })
    export const cleanUp = async () => null
    export const setActive = () => {}
    export const unsavedWork = async () => null`,
  './gitTools': `export const gitAccess = () => undefined`,
  './projectStore': `export const builtinProject = () => undefined; export const pastPathsOf = () => []`
}
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const stubs = { ${Object.entries(stubs).map(([k, v]) => `${JSON.stringify(k)}: ${mod(v)}`).join(',\n')} }
    export async function resolve(s, c, next) {
      if (stubs[s] && (s === 'electron' || c.parentURL?.endsWith('/workers.ts'))) return { url: stubs[s], shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.split('?')[0].endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
        for (const ext of ['.ts', '/index.ts']) {
          try { return await next(s + ext, c) } catch {}
        }
      }
      return next(s, c)
    }
    export async function load(u, c, next) {
      // a ?query loads a fresh copy of a module (the config test)
      return u.split('?')[0].endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const { getConfig, setConfig } = await import('../src/main/config.ts')
const workers = await import('../src/main/workers.ts')

// ---------- the fakes: usage, tasks, the dialog, the board ----------

let usage = null
const tasks = new Map()
const asked = []
const announced = []
const notes = []
/** what the next dialogs answer, in order: 'yes', 'yes-dontask', 'no', 'timeout', or a promise of one */
let answers = []
const answer = (a) => (a === 'timeout' ? { ok: false, dontAsk: false, timedOut: true } : { ok: a.startsWith('yes'), dontAsk: a === 'yes-dontask', timedOut: false })

workers.initWorkers({
  quota: () => usage,
  refreshQuota: async () => {},
  task: (id) => tasks.get(id),
  moveTask: () => {},
  changed: () => {},
  note: (text, tone) => notes.push({ text, tone }),
  access: () => null,
  gitChanged: () => {},
  ended: () => {},
  announce: (w, text) => announced.push(text),
  waitingOnUser: () => false,
  confirmOverLimit: async (r) => {
    asked.push(r)
    return answer(await (answers.shift() ?? 'no'))
  }
})

let nextId = 100
function newTask() {
  const id = nextId++
  tasks.set(id, { id, title: `Throwaway ${id}`, project, column: 'todo', createdAt: 0 })
  return id
}
const fresh = (fiveHour, week) => ({ fiveHour, week, at: Date.now(), resets5h: Date.now() + 90 * 60_000 })
function reset(limits = {}) {
  workers.stopAll('test')
  asked.length = announced.length = notes.length = 0
  answers = []
  setConfig({ limits: { ...getConfig().limits, usageLimit: true, gate5h: 70, gate5hOn: true, gateWeek: 80, gateWeekOn: true, overLimit: 'ask', maxWorkers: 4, ...limits } })
}

// ---------- the gates ----------

test('under the limit: starts as before, no question', async () => {
  reset()
  usage = fresh(41, 20)
  const r = await workers.startWorker(newTask())
  assert.ok(r.worker, r.error)
  assert.equal(asked.length, 0)
  assert.equal(announced.length, 0)
})

test('over the 5-hour gate: the question shows both gates, which is over and the reset; Cancel starts nothing', async () => {
  reset()
  usage = fresh(72, 23)
  answers = ['no']
  const r = await workers.startWorker(newTask())
  assert.equal(r.worker, undefined)
  assert.match(r.error, /chose Cancel/)
  assert.equal(asked.length, 1)
  const t = asked[0].text
  assert.match(t, /5h 72% \(limit 70%\) and the week is at 23% \(limit 80%\)/)
  assert.match(t, /The 5-hour limit is passed/)
  assert.match(t, /The 5-hour window resets at /)
  assert.match(t, /may stall or stop/)
  assert.equal(workers.runningWorkers().length, 0)
})

test('over the 5-hour gate: Start anyway starts it, with a board notice', async () => {
  reset()
  usage = fresh(72, 23)
  answers = ['yes']
  const id = newTask()
  const r = await workers.startWorker(id)
  assert.ok(r.worker, r.error)
  assert.deepEqual(announced, [`Started #${id} above the usage limit (5h 72% of 70%) at your OK.`])
})

test('over the weekly gate, and over both', async () => {
  reset()
  usage = fresh(30, 85)
  answers = ['yes']
  await workers.startWorker(newTask())
  assert.match(asked[0].text, /The weekly limit is passed/)
  assert.match(announced[0], /\(week 85% of 80%\)/)
  usage = fresh(75, 85)
  answers = ['no']
  await workers.startWorker(newTask())
  assert.match(asked[1].text, /Both limits are passed/)
})

test("Fable's weekly limit (#127): asks only for a Fable worker, and says so", async () => {
  reset()
  try {
    usage = { ...fresh(30, 40), fable: 82 }
    setConfig({ workerModel: 'sonnet' })
    const plain = await workers.startWorker(newTask())
    assert.ok(plain.worker, plain.error)
    assert.equal(asked.length, 0, 'another model never asks for the Fable limit')
    setConfig({ workerModel: 'fable' })
    answers = ['no']
    const r = await workers.startWorker(newTask())
    assert.equal(r.worker, undefined)
    assert.equal(asked.length, 1)
    assert.match(asked[0].text, /Fable usage is at 82% of the weekly Fable limit \(limit 80%\)/)
    assert.doesNotMatch(asked[0].text, /The weekly limit is passed/)
    answers = ['yes']
    await workers.startWorker(newTask())
    assert.match(announced.at(-1), /\(Fable week 82% of 80%\)/)
    usage = { ...fresh(30, 40), fable: 60 }
    assert.ok((await workers.startWorker(newTask())).worker)
    assert.equal(asked.length, 2, 'under the gate: no question')
  } finally {
    setConfig({ workerModel: 'default' })
  }
})

test('no answer in time counts as Cancel', async () => {
  reset()
  usage = fresh(72, 23)
  answers = ['timeout']
  const r = await workers.startWorker(newTask())
  assert.equal(r.worker, undefined)
  assert.match(r.error, /nobody answered .* which counts as Cancel/)
  assert.equal(asked[0].timeoutMs, workers.CONFIRM_TIMEOUT_MS)
})

// ---------- Settings ----------

test('the master switch off: no check and no question, even at 99%', async () => {
  reset({ usageLimit: false })
  usage = fresh(99, 99)
  assert.ok((await workers.startWorker(newTask())).worker)
  assert.equal(asked.length, 0)
})

test('one gate off: the other still applies, and the question says "no limit"', async () => {
  reset({ gate5hOn: false })
  usage = fresh(99, 10)
  assert.ok((await workers.startWorker(newTask())).worker)
  assert.equal(asked.length, 0)
  usage = fresh(99, 90)
  answers = ['no']
  await workers.startWorker(newTask())
  assert.match(asked[0].text, /5h 99% \(no limit\)/)
})

test('changed thresholds apply at once', async () => {
  reset({ gate5h: 90 })
  usage = fresh(85, 10)
  assert.ok((await workers.startWorker(newTask())).worker)
  assert.equal(asked.length, 0)
})

test('"Block new agents" refuses with the old message and asks nothing', async () => {
  reset({ overLimit: 'block' })
  usage = fresh(72, 23)
  const r = await workers.startWorker(newTask())
  assert.equal(r.error, '5-hour usage is at 72%, at or above the 70% limit for starting workers.')
  assert.equal(asked.length, 0)
  assert.match(await workers.startBlocker(), /limit for starting workers/)
  reset()
  assert.equal(await workers.startBlocker(), null, 'with "Ask me first" being over is not a blocker')
})

test('unknown usage asks, and says it is unknown; blocked mode refuses as before', async () => {
  reset()
  usage = null
  answers = ['no']
  await workers.startWorker(newTask())
  assert.match(asked[0].text, /Current usage is unknown/)
  reset({ overLimit: 'block' })
  assert.match((await workers.startWorker(newTask())).error, /usage is unknown/)
})

test('stale numbers are said to be stale', async () => {
  reset()
  usage = { fiveHour: 72, week: 23, at: Date.now() - 30 * 60_000 }
  answers = ['no']
  await workers.startWorker(newTask())
  assert.match(asked[0].text, /from 30 minutes ago: the latest usage check failed/)
})

// ---------- races and start_worker ----------

test('two starts at once each ask, and one yes covers only its own start', async () => {
  reset()
  usage = fresh(72, 23)
  let release
  answers = [new Promise((r) => (release = r)), 'no']
  const a = workers.startWorker(newTask())
  const b = workers.startWorker(newTask())
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(asked.length, 1, 'one dialog at a time')
  release('yes')
  const [ra, rb] = await Promise.all([a, b])
  assert.ok(ra.worker)
  assert.match(rb.error, /chose Cancel/)
  assert.equal(asked.length, 2)
  assert.equal(workers.runningWorkers().length, 1)
})

test("start_worker's detached ask returns at once and starts only on the user's yes", async () => {
  reset()
  // "Plan & ask" only proposes; this is the path Corvid's start_worker takes with workers allowed to start
  setConfig({ assistantMode: 'auto' })
  usage = fresh(72, 23)
  let release
  answers = [new Promise((r) => (release = r))]
  const r = await workers.requestWorker(newTask(), undefined, true)
  setConfig({ assistantMode: 'ask' })
  assert.match(r.asked, /has been asked .* Nothing has started yet/)
  assert.equal(workers.runningWorkers().length, 0)
  release('yes')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(workers.runningWorkers().length, 1)
  assert.match(notes.at(-1).text, /above the usage limit, at your OK/)
})

test('the cap still applies after a yes', async () => {
  reset({ maxWorkers: 1 })
  usage = fresh(72, 23)
  answers = ['yes', 'yes']
  assert.ok((await workers.startWorker(newTask())).worker)
  assert.match((await workers.startWorker(newTask())).error, /which is the limit/)
})

test('"Don\'t ask again until usage resets" covers the next starts until the reset', async () => {
  reset()
  usage = fresh(72, 23)
  answers = ['yes-dontask']
  assert.ok((await workers.startWorker(newTask())).worker)
  assert.ok((await workers.startWorker(newTask())).worker)
  assert.equal(asked.length, 1)
  assert.equal(announced.length, 2, 'each override is still on record')
})

// ---------- config.json ----------

test('old configs keep their thresholds and get "Ask me first"; bad values are repaired', async () => {
  const cfg = join(globalThis.__userData, 'config.json')
  const load = async (limits) => {
    writeFileSync(cfg, JSON.stringify({ limits }))
    return (await import(`../src/main/config.ts?${Math.random()}`))
  }
  let c = await load({ maxWorkers: 3, gate5h: 85, gateWeek: 60, workerMinutes: 45 })
  assert.deepEqual(
    (({ gate5h, gateWeek, usageLimit, gate5hOn, gateWeekOn, overLimit }) => ({ gate5h, gateWeek, usageLimit, gate5hOn, gateWeekOn, overLimit }))(c.getConfig().limits),
    { gate5h: 85, gateWeek: 60, usageLimit: true, gate5hOn: true, gateWeekOn: true, overLimit: 'ask' }
  )
  assert.deepEqual(c.configRepairs(), [])
  c = await load({ gate5h: 500, gate5hOn: 'yes', overLimit: 'sometimes', usageLimit: false })
  const l = c.getConfig().limits
  assert.equal(l.gate5h, 70)
  assert.equal(l.gate5hOn, true)
  assert.equal(l.overLimit, 'ask')
  assert.equal(l.usageLimit, false, 'a good value stays')
  assert.equal(c.configRepairs().length, 3)
  assert.ok(readFileSync(cfg, 'utf8'))
})

test('saved models (#127): Fable and the old ones load as saved, an unknown one is repaired', async () => {
  const cfg = join(globalThis.__userData, 'config.json')
  const load = async (saved) => {
    writeFileSync(cfg, JSON.stringify(saved))
    return (await import(`../src/main/config.ts?${Math.random()}`))
  }
  let c = await load({ assistantModel: 'fable', workerModel: 'fable', scanModel: 'fable' })
  assert.deepEqual([c.getConfig().assistantModel, c.getConfig().workerModel, c.getConfig().scanModel], ['fable', 'fable', 'fable'])
  assert.deepEqual(c.configRepairs(), [])
  c = await load({ assistantModel: 'opus', workerModel: 'default' })
  assert.deepEqual([c.getConfig().assistantModel, c.getConfig().workerModel, c.getConfig().scanModel], ['opus', 'default', undefined])
  assert.deepEqual(c.configRepairs(), [])
  c = await load({ assistantModel: 'gpt', workerModel: 'mythos', scanModel: 7 })
  assert.deepEqual([c.getConfig().assistantModel, c.getConfig().workerModel, c.getConfig().scanModel], ['haiku', 'default', undefined])
  assert.equal(c.configRepairs().length, 3)
})
