// Tests for #282, "start automatically when its blockers are done": older tasks.json files loading without the field,
// the switch saving, moves into Done being reported, and the trigger logic (autoStart.ts) as pure functions: blockers
// done, one still open, a deleted blocker, a task in Done, one already running, ask mode, the cap full and usage over
// the limit. tasks.ts runs in a temporary folder through a stand-in for electron, like test-task-done.mjs. Nothing is
// started.
//
//   npm run test-auto-start

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-auto-start-'))
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

const file = join(globalThis.__userData, 'tasks.json')
// an older file, from before #282: no task has autoStart; one hand edit has a value that isn't true
writeFileSync(
  file,
  JSON.stringify({
    nextId: 5,
    tasks: [
      { id: 1, title: 'first', notes: '', column: 'doing', order: 1, createdAt: 1, updatedAt: 1 },
      { id: 2, title: 'second', notes: '', column: 'next', order: 1, blockedBy: [1], createdAt: 1, updatedAt: 1 },
      { id: 3, title: 'odd', notes: '', column: 'backlog', order: 1, autoStart: 'yes', createdAt: 1, updatedAt: 1 },
      { id: 4, title: 'on', notes: '', column: 'backlog', order: 2, autoStart: true, blockedBy: [1], createdAt: 1, updatedAt: 1 }
    ]
  })
)

const auto = await import(src + 'shared/autoStart.ts')
const tasks = await import(src + 'main/tasks.ts')
const done = []
tasks.onMovedToDone((ids) => done.push(...ids))
tasks.initTasks(() => {}, { resolve: () => undefined, forPath: () => undefined, folder: () => undefined })
const get = (id) => tasks.listTasks().find((t) => t.id === id)
const saved = () => JSON.parse(readFileSync(file, 'utf8'))

after(() => {
  rmSync(tmp, { recursive: true, force: true })
  // the tasks.json watcher would keep the test running
  setTimeout(() => process.exit(0), 50)
})

const task = (id, more = {}) => ({ id, title: `t${id}`, notes: '', column: 'backlog', order: id, createdAt: 1, updatedAt: 1, ...more })
const none = () => false

test('older task data without the field loads unchanged; a value that is not true means off', () => {
  assert.equal('autoStart' in get(1), false)
  assert.equal('autoStart' in get(2), false)
  assert.deepEqual(get(2).blockedBy, [1])
  assert.equal('autoStart' in get(3), false)
  assert.equal(get(4).autoStart, true)
})

test('the switch saves, and off leaves no field behind', () => {
  tasks.updateTask(2, { autoStart: true })
  assert.equal(saved().tasks.find((t) => t.id === 2).autoStart, true)
  tasks.updateTask(2, { autoStart: false })
  assert.equal('autoStart' in saved().tasks.find((t) => t.id === 2), false)
  const made = tasks.createTask({ title: 'chained', autoStart: true })
  assert.equal(made.autoStart, true)
  tasks.removeTask(made.id)
})

test('moving into Done is reported, by the editor and by a drag; other moves are not', () => {
  done.length = 0
  tasks.updateTask(3, { column: 'next' })
  assert.deepEqual(done, [])
  tasks.updateTask(1, { column: 'done' })
  assert.deepEqual(done, [1])
  tasks.updateTask(1, { column: 'done', title: 'first again' })
  assert.deepEqual(done, [1], 'already in Done: no second report')
  tasks.arrangeColumn('done', [1, 3])
  assert.deepEqual(done, [1, 3], 'only the one that moved')
})

test('all blockers done: it is ready', () => {
  const all = [task(1, { column: 'done' }), task(2, { column: 'done' }), task(3, { autoStart: true, blockedBy: [1, 2] })]
  assert.deepEqual(auto.autoStartReady([2], all, none).map((t) => t.id), [3])
})

test('one blocker still open: not ready', () => {
  const all = [task(1, { column: 'done' }), task(2, { column: 'doing' }), task(3, { autoStart: true, blockedBy: [1, 2] })]
  assert.deepEqual(auto.autoStartReady([1], all, none), [])
})

test('a deleted blocker counts as done', () => {
  const all = [task(1, { column: 'done' }), task(3, { autoStart: true, column: 'next', blockedBy: [1, 99] })]
  assert.deepEqual(auto.autoStartReady([1], all, none).map((t) => t.id), [3])
})

test('only tasks that opt in, in Backlog or Up next, and blocked by the one that moved', () => {
  const all = [
    task(1, { column: 'done' }),
    task(2, { blockedBy: [1] }),
    task(3, { autoStart: true, column: 'done', blockedBy: [1] }),
    task(4, { autoStart: true, column: 'doing', blockedBy: [1] }),
    task(5, { autoStart: true, column: 'next', blockedBy: [1] }),
    task(6, { autoStart: true }),
    task(7, { column: 'done' }),
    task(8, { autoStart: true, blockedBy: [7] })
  ]
  assert.deepEqual(auto.autoStartReady([1], all, none).map((t) => t.id), [5])
})

test('a task in Done is never started', () => {
  const all = [task(1, { column: 'done' }), task(3, { autoStart: true, column: 'done', blockedBy: [1] })]
  assert.deepEqual(auto.autoStartReady([1], all, none), [])
  assert.equal(auto.autoStartWaiting(all[1], () => all[0]), false)
})

test('a task with a worker running is not started again', () => {
  const all = [task(1, { column: 'done' }), task(3, { autoStart: true, blockedBy: [1] })]
  assert.deepEqual(auto.autoStartReady([1], all, (id) => id === 3), [])
})

test('a blocker that is not actually in Done triggers nothing', () => {
  const all = [task(1, { column: 'next' }), task(3, { autoStart: true, blockedBy: [1] })]
  assert.deepEqual(auto.autoStartReady([1], all, none), [])
})

test('the same task blocked by two that both just moved is listed once', () => {
  const all = [task(1, { column: 'done' }), task(2, { column: 'done' }), task(3, { autoStart: true, blockedBy: [1, 2] })]
  assert.deepEqual(auto.autoStartReady([1, 2], all, none).map((t) => t.id), [3])
})

test('ask mode proposes, whatever the slots and usage', () => {
  assert.equal(auto.autoStartAction({ mode: 'ask', freeSlots: 0, usageOver: true }), 'propose')
  assert.equal(auto.autoStartAction({ mode: 'ask', freeSlots: 2, usageOver: false }), 'propose')
})

test('cap full: a notice, nothing starts now (it waits for a slot)', () => {
  assert.equal(auto.autoStartAction({ mode: 'auto', freeSlots: 0, usageOver: false }), 'no-slot')
  assert.match(auto.autoStartNotice(7, 'no-slot', { cap: 3 }), /^#7 is ready to start .*all 3 worker slots are busy; it starts automatically when one frees/)
})

test('usage over the limit: a notice, never a start or a dialog', () => {
  assert.equal(auto.autoStartAction({ mode: 'auto', freeSlots: 2, usageOver: true }), 'over-limit')
  assert.equal(auto.autoStartNotice(7, 'over-limit'), '#7 is ready to start but usage is over the limit; start it yourself.')
})

test('room and usage fine: it starts, with one notice', () => {
  assert.equal(auto.autoStartAction({ mode: 'auto', freeSlots: 1, usageOver: false }), 'start')
  assert.equal(auto.autoStartNotice(7, 'start'), 'Started #7 automatically: its blockers are done.')
})
