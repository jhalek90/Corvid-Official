// Tests for #117 part 5: a task made from an error or a message (src/shared/taskFromMessage.ts) gets a short title,
// the full message in its notes, and Corvid's own project when it is about Corvid or an extension, so Automate can run
// it. Task #116 was made with the whole lifecycle conflict message as its title, no notes and no project.
//
//   npm run test-task-from-message

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// the package is CommonJS: load the .ts file as a module, on Node 24's own TypeScript support
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function load(u, c, next) { return u.endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c) }`)
)

const { taskFromMessage, shortTitle } = await import(pathToFileURL(join(import.meta.dirname, '..', 'src', 'shared', 'taskFromMessage.ts')).href)

const CONFLICT =
  'This conflicts with later changes to Corvid in src/shared/themes.ts. Nothing was changed. An agent can resolve it (with an estimate and your confirmation), or leave it as it is.'

test("the lifecycle conflict that made #116: a short title, the message in the notes, Corvid's project", () => {
  const t = taskFromMessage(CONFLICT, { extension: 'Dracula theme' })
  assert.equal(t.title, 'Resolve extension conflict: Dracula theme')
  assert.ok(t.notes.includes(CONFLICT))
  assert.equal(t.corvid, true)
})

test('the same message without the extension name names the files', () => {
  const t = taskFromMessage(CONFLICT)
  assert.equal(t.title, 'Resolve extension conflict in src/shared/themes.ts')
  assert.equal(t.corvid, true)
})

test('any other error: its first sentence, cut at a word, and no project chosen for it', () => {
  const t = taskFromMessage('git push failed in D:\projects\example because the remote refused the branch name for a reason nobody can explain. Try again later.')
  assert.ok(t.title.length <= 70, t.title)
  assert.ok(t.title.endsWith('…'))
  assert.ok(!t.title.includes('Try again'))
  assert.equal(t.corvid, false)
  assert.ok(t.notes.includes('Try again later.'))
})

test('a message about Corvid or an extension is Corvid\'s', () => {
  assert.equal(taskFromMessage("Corvid's source checkout isn't set up.").corvid, true)
  assert.equal(taskFromMessage('Only an installed extension can be disabled.').corvid, true)
})

test('short and empty messages', () => {
  assert.equal(shortTitle('Disk full.'), 'Disk full')
  assert.equal(taskFromMessage('   ').title, 'Look into an error')
})
