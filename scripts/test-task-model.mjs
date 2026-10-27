// Tests for #136, a model per task: how a task's model resolves against the worker model from Settings; older
// tasks.json files (no model, or one that isn't a model) loading as before; setting, clearing and refusing models; Fable
// only with the user's consent from Corvid's dialog (which no task tool has), Undo bringing a Fable task back without
// asking, and a hand edit of tasks.json that puts a task on Fable being undone. tasks.ts runs in a temporary folder
// through a stand-in for electron, like test-cost.mjs. Nothing is started.
//
//   npm run test-task-model

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-task-model-'))
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
// an older file: one task without a model, one with something that isn't a model
writeFileSync(
  file,
  JSON.stringify({
    nextId: 3,
    tasks: [
      { id: 1, title: 'old', notes: '', column: 'backlog', order: 1, createdAt: 1, updatedAt: 1 },
      { id: 2, title: 'odd', notes: '', column: 'next', order: 1, model: 'gpt-9', createdAt: 1, updatedAt: 1 }
    ]
  })
)

const { taskModel, parseTaskModel } = await import(src + 'shared/models.ts')
const tasks = await import(src + 'main/tasks.ts')
tasks.initTasks(() => {}, { resolve: () => undefined, forPath: () => undefined, folder: () => undefined })
const get = (id) => tasks.listTasks().find((t) => t.id === id)

after(() => {
  rmSync(tmp, { recursive: true, force: true })
  // the tasks.json watcher would keep the test running
  setTimeout(() => process.exit(0), 50)
})

test("a task's model beats the worker model; unset follows Settings", () => {
  assert.equal(taskModel({ model: 'opus' }, 'sonnet'), 'opus')
  assert.equal(taskModel({}, 'sonnet'), 'sonnet')
  assert.equal(taskModel({}, 'default'), 'default')
  assert.equal(taskModel(undefined, 'haiku'), 'haiku')
  assert.equal(taskModel({ model: 'nonsense' }, 'default'), 'default')
  assert.equal(parseTaskModel('default'), null)
  assert.equal(parseTaskModel(undefined), null)
  assert.equal(parseTaskModel(' Opus '), 'opus')
  assert.equal(parseTaskModel('gpt'), undefined)
})

test('older tasks load as before: no model, and a bad one dropped', () => {
  assert.equal(get(1).title, 'old')
  assert.equal('model' in get(1), false)
  assert.equal('model' in get(2), false)
})

test('create and update set, clear and refuse models', () => {
  const plain = tasks.createTask({ title: 'plain' })
  assert.equal('model' in plain, false)
  const t = tasks.createTask({ title: 'on opus', model: 'opus' })
  assert.equal(t.model, 'opus')
  tasks.updateTask(t.id, { model: 'haiku' })
  assert.equal(get(t.id).model, 'haiku')
  tasks.updateTask(t.id, { title: 'renamed' })
  assert.equal(get(t.id).model, 'haiku', 'a patch without a model keeps it')
  tasks.updateTask(t.id, { model: 'default' })
  assert.equal('model' in get(t.id), false)
  assert.throws(() => tasks.updateTask(t.id, { model: 'gpt' }), /isn't a model/)
  const saved = JSON.parse(readFileSync(file, 'utf8')).tasks.find((x) => x.id === t.id)
  assert.equal('model' in saved, false)
})

test('Fable needs the dialog: refused without consent, kept on later saves', () => {
  assert.throws(() => tasks.createTask({ title: 'fable', model: 'fable' }), /task editor/)
  const t = tasks.createTask({ title: 'sonnet first', model: 'sonnet' })
  assert.throws(() => tasks.updateTask(t.id, { model: 'fable' }), /task editor/)
  assert.equal(get(t.id).model, 'sonnet', 'a refused change leaves the task as it was')
  tasks.updateTask(t.id, { model: 'fable' }, { fable: true })
  assert.equal(get(t.id).model, 'fable')
  // saving the editor again sends the same model: no new consent needed
  tasks.updateTask(t.id, { model: 'fable', title: 'still fable' })
  assert.equal(get(t.id).model, 'fable')
  const f = tasks.createTask({ title: 'new on fable', model: 'fable' }, { fable: true })
  assert.equal(f.model, 'fable')
})

test('Undo brings a Fable task back on Fable without asking', () => {
  const t = tasks.createTask({ title: 'undo me', model: 'fable' }, { fable: true })
  const removed = tasks.removeTask(t.id)
  assert.equal(tasks.restoresFable(removed), true)
  const back = tasks.createTask({ ...removed })
  assert.equal(back.id, t.id)
  assert.equal(back.model, 'fable')
  // but a new task can't borrow that
  assert.equal(tasks.restoresFable({ id: 9999, model: 'fable' }), false)
})

test('a hand edit of tasks.json that puts a task on Fable is undone', async () => {
  const t = tasks.createTask({ title: 'hand edited', model: 'opus' })
  const keep = tasks.createTask({ title: 'already fable', model: 'fable' }, { fable: true })
  await new Promise((r) => setTimeout(r, 700))
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  for (const x of raw.tasks) if (x.id === t.id || x.id === 1) x.model = 'fable'
  writeFileSync(file, JSON.stringify(raw))
  await new Promise((r) => setTimeout(r, 900))
  assert.equal(get(t.id).model, 'opus')
  assert.equal('model' in get(1), false)
  assert.equal(get(keep.id).model, 'fable', 'a task that was on Fable stays on it')
})
