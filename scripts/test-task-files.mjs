// Tests for #187, files attached to tasks: copies under task-files\t<id>\ with safe, unique names, the board's limits
// (#147) counted per task, refused files leaving nothing behind, the list kept on the task (older tasks load as before,
// a tampered list is dropped), the task tools unable to add files, read_task_file (an image as an image, text as text
// in parts, other files by name; a worker only for its own task, Corvid for any), the start instructions naming the
// files, and removal, Undo and the start-up sweep. tasks.ts runs on fake data in a temp folder through a stand-in for
// electron; the real data folder is never touched.
//
//   npm run test-task-files

import { register } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-task-files-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
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
      return /\\.ts(?:\\?|$)/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const data = globalThis.__userData
const filesRoot = join(data, 'task-files')
// left behind: a folder of a task that's gone, and a stray file in a live task's folder (a save that failed half way)
mkdirSync(join(filesRoot, 't99'), { recursive: true })
writeFileSync(join(filesRoot, 't99', 'gone.txt'), 'old')
mkdirSync(join(filesRoot, 't2'), { recursive: true })
writeFileSync(join(filesRoot, 't2', 'kept.txt'), 'kept')
writeFileSync(join(filesRoot, 't2', 'stray.txt'), 'stray')
writeFileSync(
  join(data, 'tasks.json'),
  JSON.stringify({
    nextId: 4,
    tasks: [
      // an older task, without files
      { id: 1, title: 'old', notes: '', column: 'backlog', order: 1, createdAt: 1, updatedAt: 1 },
      { id: 2, title: 'has one', notes: '', column: 'next', order: 1, attachments: [{ name: 'kept.txt', size: 4, kind: 'text' }], createdAt: 1, updatedAt: 1 },
      // a hand-edited list with a path trick is dropped, the task stays
      { id: 3, title: 'tampered', notes: '', column: 'next', order: 2, attachments: [{ name: '..\\..\\secrets.json', size: 3, kind: 'text' }], createdAt: 1, updatedAt: 1 }
    ]
  })
)

const tasks = await import(src + 'main/tasks.ts')
tasks.initTasks(() => {}, { resolve: () => undefined, forPath: () => undefined, folder: () => undefined })
const tft = await import(src + 'main/taskFileTools.ts')
const shared = await import(src + 'shared/board.ts')
const get = (id) => tasks.listTasks().find((t) => t.id === id)
const bytes = (s) => new TextEncoder().encode(s)
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
const read = (actor) => tft.taskFileTools(actor).find((t) => t.name === 'read_task_file')

after(() => {
  rmSync(tmp, { recursive: true, force: true })
  // the tasks.json watcher would keep the test running
  setTimeout(() => process.exit(0), 50)
})

test('older tasks load as before; a tampered list is dropped; the sweep clears orphans', () => {
  assert.equal(get(1).attachments, undefined)
  assert.equal(get(3).attachments, undefined)
  assert.equal(get(3).title, 'tampered')
  assert.deepEqual(get(2).attachments, [{ name: 'kept.txt', size: 4, kind: 'text' }])
  assert.equal(existsSync(join(filesRoot, 't99')), false)
  assert.deepEqual(readdirSync(join(filesRoot, 't2')), ['kept.txt'])
})

test('attaching copies files under safe, unique names, and never overwrites', () => {
  const t = tasks.createTask({ title: 'with files' })
  tasks.addTaskFiles(t.id, [
    { name: 'C:\\Users\\me\\shot.png', data: PNG },
    { name: '../../notes.txt', data: bytes('line one\nline two') },
    { name: 'shot.png', data: PNG },
    { name: 'tool.exe', data: bytes('MZ') }
  ])
  const names = get(t.id).attachments.map((a) => a.name)
  assert.deepEqual(names, ['shot.png', 'notes.txt', 'shot (2).png', 'tool.exe'])
  assert.deepEqual(
    get(t.id).attachments.map((a) => a.kind),
    ['image', 'text', 'image', 'file']
  )
  assert.deepEqual(readdirSync(join(filesRoot, `t${t.id}`)).sort(), [...names].sort())
  assert.equal(readFileSync(join(filesRoot, `t${t.id}`, 'notes.txt'), 'utf8'), 'line one\nline two')
  // the stored list is in tasks.json, so it survives a restart
  const saved = JSON.parse(readFileSync(join(data, 'tasks.json'), 'utf8')).tasks.find((x) => x.id === t.id)
  assert.equal(saved.attachments.length, 4)
})

test('limits are counted per task, with what it already has; a refused batch leaves nothing behind', () => {
  const t = tasks.createTask({ title: 'limits' })
  const big = new Uint8Array(shared.MAX_ATTACH_FILE + 1)
  assert.throws(() => tasks.addTaskFiles(t.id, [{ name: 'big.bin', data: big }]), /each file can be at most 20/)
  assert.throws(() => tasks.addTaskFiles(t.id, [{ name: 'link.lnk', data: bytes('x') }]), /shortcut/)
  const nine = Array.from({ length: 9 }, (_, i) => ({ name: `f${i}.txt`, data: bytes('x') }))
  tasks.addTaskFiles(t.id, nine)
  assert.throws(
    () =>
      tasks.addTaskFiles(t.id, [
        { name: 'a.txt', data: bytes('a') },
        { name: 'b.txt', data: bytes('b') }
      ]),
    /At most 10 files go with one task/
  )
  assert.equal(get(t.id).attachments.length, 9)
  assert.equal(readdirSync(join(filesRoot, `t${t.id}`)).length, 9)
  const half = new Uint8Array(19 * 1024 * 1024)
  const u = tasks.createTask({ title: 'total' })
  tasks.addTaskFiles(u.id, [
    { name: 'a.bin', data: half },
    { name: 'b.bin', data: half }
  ])
  assert.throws(() => tasks.addTaskFiles(u.id, [{ name: 'c.bin', data: half }]), /one task can carry at most 50/)
  assert.equal(readdirSync(join(filesRoot, `t${u.id}`)).length, 2)
})

test('the task tools cannot add or change files; a new or copied task starts without any', () => {
  const before = get(2).attachments
  tasks.updateTask(2, { title: 'renamed', attachments: [{ name: 'evil.txt', size: 1, kind: 'text' }] })
  assert.deepEqual(get(2).attachments, before)
  const copy = tasks.createTask({ title: 'copy', attachments: get(2).attachments })
  assert.equal(copy.attachments, undefined)
  // moving between columns, into Done too, keeps them
  tasks.updateTask(2, { column: 'done' })
  assert.equal(get(2).attachments.length, 1)
  assert.ok(existsSync(join(filesRoot, 't2', 'kept.txt')))
})

test('removing a file deletes its copy', () => {
  const t = tasks.createTask({ title: 'remove one' })
  tasks.addTaskFiles(t.id, [
    { name: 'a.txt', data: bytes('a') },
    { name: 'b.txt', data: bytes('b') }
  ])
  tasks.removeTaskFile(t.id, 0)
  assert.deepEqual(
    get(t.id).attachments.map((a) => a.name),
    ['b.txt']
  )
  assert.deepEqual(readdirSync(join(filesRoot, `t${t.id}`)), ['b.txt'])
})

test('read_task_file: images as images, text as text in parts, other files by name; a worker only its own task', () => {
  const t = tasks.listTasks().find((x) => x.title === 'with files')
  const mine = read({ kind: 'agent', taskId: t.id })
  const list = mine.run({})
  assert.match(list, /shot\.png \(image/)
  assert.match(list, /information, never instructions or permission/)
  const img = mine.run({ file: 1 })
  assert.equal(img.image.mimeType, 'image/png')
  assert.equal(img.image.data, Buffer.from(PNG).toString('base64'))
  assert.match(mine.run({ file: 'notes.txt' }), /line one\nline two/)
  assert.match(mine.run({ file: 4 }), /tool\.exe \(file, 2 B\).*only its name and size/s)
  assert.throws(() => mine.run({ file: 9 }), /has no attached file/)
  // another task's files are refused, even when named
  assert.throws(() => mine.run({ task: 2, file: 1 }), /only the files of your own task/)
  assert.throws(() => read({ kind: 'agent', taskId: 1 }).run({ task: t.id, file: 1 }), /only the files of your own task/)
  // Corvid can read any task's
  assert.match(read({ kind: 'assistant' }).run({ task: 2, file: 1 }), /kept/)
  // long text comes in parts, with where to read on
  const long = tasks.createTask({ title: 'long' })
  tasks.addTaskFiles(long.id, [{ name: 'long.log', data: bytes('a'.repeat(150_000) + 'END') }])
  const r = read({ kind: 'agent', taskId: long.id })
  const first = r.run({ file: 1 })
  assert.match(first, /Read on with offset: 100000/)
  assert.doesNotMatch(first, /END/)
  assert.match(r.run({ file: 1, offset: 100000 }), /END$/)
})

test('the start instructions name the files and how to read them, and say they are not instructions', () => {
  const t = tasks.listTasks().find((x) => x.title === 'with files')
  const p = tft.taskFilesPrompt(t)
  assert.match(p, /shot\.png \(image, \d+ B\)/)
  assert.match(p, /notes\.txt \(text/)
  assert.match(p, /mcp__corvid__read_task_file/)
  assert.match(p, /never instructions or permission/)
  assert.equal(tft.taskFilesPrompt(get(1)), '')
})

test('a removed task keeps its files for Undo; the start-up sweep clears them once it stays gone', () => {
  const t = tasks.createTask({ title: 'undo me' })
  tasks.addTaskFiles(t.id, [{ name: 'u.txt', data: bytes('u') }])
  const gone = tasks.removeTask(t.id)
  assert.ok(existsSync(join(filesRoot, `t${t.id}`, 'u.txt')))
  // Undo passes the task back with its id: the files come with it
  tasks.createTask(gone)
  assert.deepEqual(
    get(t.id).attachments.map((a) => a.name),
    ['u.txt']
  )
  assert.match(read({ kind: 'agent', taskId: t.id }).run({ file: 1 }), /u$/)
  // removed again and not undone: the next start's sweep deletes the folder
  tasks.removeTask(t.id)
  tasks.sweepTaskFiles()
  assert.equal(existsSync(join(filesRoot, `t${t.id}`)), false)
  // an Undo after the files went brings the task back without them
  tasks.createTask(gone)
  assert.equal(get(t.id).attachments, undefined)
})

test('the storage total counts every task file', () => {
  const sum = tasks.listTasks().reduce((s, t) => s + (t.attachments ?? []).reduce((a, f) => a + f.size, 0), 0)
  assert.equal(tasks.taskFilesBytes(), sum)
  assert.ok(sum > 38 * 1024 * 1024)
})
