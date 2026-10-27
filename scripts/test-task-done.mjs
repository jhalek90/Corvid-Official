// Tests for #138, the Done column: older tasks.json files loading as before (and a column this version doesn't know
// landing in Backlog instead of vanishing), moving tasks into and out of Done and arranging it, Undo bringing a removed
// Done task back into Done, and the blocker helpers treating a Done task as finished. tasks.ts runs in a temporary
// folder through a stand-in for electron, like test-task-model.mjs. Nothing is started.
//
//   npm run test-task-done

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-task-done-'))
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
// an older file: the three columns there were, plus one this version doesn't know
writeFileSync(
  file,
  JSON.stringify({
    nextId: 5,
    tasks: [
      { id: 1, title: 'old', notes: '', column: 'backlog', order: 1, createdAt: 1, updatedAt: 1 },
      { id: 2, title: 'soon', notes: '', column: 'next', order: 1, blockedBy: [1], createdAt: 1, updatedAt: 1 },
      { id: 3, title: 'going', notes: '', column: 'doing', order: 1, createdAt: 1, updatedAt: 1 },
      { id: 4, title: 'typo', notes: '', column: 'reveiw', order: 1, createdAt: 1, updatedAt: 1 }
    ]
  })
)

const { TASK_COLUMNS } = await import(src + 'shared/types.ts')
const blockers = await import(src + 'shared/blockers.ts')
const tasks = await import(src + 'main/tasks.ts')
tasks.initTasks(() => {}, { resolve: () => undefined, forPath: () => undefined, folder: () => undefined })
const get = (id) => tasks.listTasks().find((t) => t.id === id)
const saved = () => JSON.parse(readFileSync(file, 'utf8'))

after(() => {
  rmSync(tmp, { recursive: true, force: true })
  // the tasks.json watcher would keep the test running
  setTimeout(() => process.exit(0), 50)
})

test('the columns, left to right', () => {
  assert.deepEqual([...TASK_COLUMNS], ['backlog', 'next', 'doing', 'done'])
  for (const c of TASK_COLUMNS) assert.equal(typeof blockers.BLOCKER_STATE[c], 'string')
})

test('older tasks load in their columns; an unknown column goes to Backlog', () => {
  assert.equal(get(1).column, 'backlog')
  assert.equal(get(2).column, 'next')
  assert.equal(get(3).column, 'doing')
  assert.equal(get(4).column, 'backlog')
  assert.deepEqual(get(2).blockedBy, [1])
})

test('a task moves into Done and out again, and Done saves', () => {
  tasks.updateTask(3, { column: 'done' })
  assert.equal(get(3).column, 'done')
  assert.equal(saved().tasks.find((t) => t.id === 3).column, 'done')
  tasks.updateTask(3, { column: 'next' })
  assert.equal(get(3).column, 'next')
  const made = tasks.createTask({ title: 'made done', column: 'done' })
  assert.equal(made.column, 'done')
  tasks.removeTask(made.id)
})

test('dragging into Done sets the column and the order', () => {
  tasks.arrangeColumn('done', [3, 1])
  assert.equal(get(3).column, 'done')
  assert.equal(get(1).column, 'done')
  assert.equal(get(3).order, 1)
  assert.equal(get(1).order, 2)
  tasks.arrangeColumn('backlog', [1])
  tasks.arrangeColumn('doing', [3])
})

test('Undo brings a removed Done task back into Done', () => {
  tasks.updateTask(3, { column: 'done' })
  const gone = tasks.removeTask(3)
  assert.equal(get(3), undefined)
  tasks.createTask(gone)
  assert.equal(get(3).column, 'done')
  assert.equal(get(3).title, 'going')
})

test('a blocker in Done is finished: it no longer blocks, and comes back if it leaves Done', () => {
  const find = (id) => get(id)
  assert.deepEqual(blockers.openBlockers(get(2), find).map((b) => b.id), [1])
  assert.deepEqual(blockers.blockedTasks(get(1), tasks.listTasks()).map((t) => t.id), [2])
  tasks.updateTask(1, { column: 'done' })
  assert.deepEqual(blockers.openBlockers(get(2), find), [])
  assert.deepEqual(blockers.blockedTasks(get(1), tasks.listTasks()), [])
  // the link itself stays, so moving it out of Done blocks again
  assert.deepEqual(get(2).blockedBy, [1])
  tasks.updateTask(1, { column: 'next' })
  assert.deepEqual(blockers.openBlockers(get(2), find).map((b) => b.id), [1])
  assert.equal(blockers.notStarted(get(1)), true)
})

test('only backlog and next count as not started', () => {
  assert.equal(blockers.notStarted({ column: 'backlog' }), true)
  assert.equal(blockers.notStarted({ column: 'next' }), true)
  assert.equal(blockers.notStarted({ column: 'doing' }), false)
  assert.equal(blockers.notStarted({ column: 'done' }), false)
  assert.equal(blockers.BLOCKER_STATE.done, 'done')
})

test('saving a task that waits on a Done one keeps the link', () => {
  tasks.updateTask(1, { column: 'done' })
  tasks.updateTask(2, { blockedBy: [1] })
  assert.deepEqual(get(2).blockedBy, [1])
})
