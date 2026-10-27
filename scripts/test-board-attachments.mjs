// Tests for #147, files attached to board messages: safe names, the size and count limits, the copies in the board's
// own folder, read_attachment (images as images, text as text, other files by name only; agents only when the message
// is addressed to them), what read_messages and Corvid's prompt say, and the copies going with expiry, Clear and
// failed sends. Old messages without attachments load as before.
// The board runs on fake data in a temp folder, with a stand-in for electron; the real data folder is never touched.
//
//   npm run test-board-attachments

import { register } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-attach-'))
globalThis.__userData = join(tmp, 'data')
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent(\`
      export const app = { getPath: () => globalThis.__userData }
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

const board = await import('../src/main/board.ts')
const tools = await import('../src/main/boardTools.ts')
const shared = await import('../src/shared/board.ts')
const notes = await import('../src/main/notes.ts')

after(() => rmSync(tmp, { recursive: true, force: true }))

const deps = {
  agents: () => [
    { name: 'Alpha Crow', taskId: 11, live: true },
    { name: 'Beta Crow', taskId: 21, live: true }
  ],
  posted: () => {},
  userName: () => 'Robin',
  projectOf: () => undefined,
  projectName: () => undefined
}

const dir = join(tmp, 'board')
const att = join(dir, 'attachments')
mkdirSync(join(att, 'm99'), { recursive: true })
writeFileSync(join(att, 'm99', 'orphan.txt'), 'left by a crash')
const now = Date.now()
writeFileSync(
  join(dir, 'messages.jsonl'),
  [
    { id: 1, ts: now - 5000, author: 'user', text: 'old hello', to: ['assistant'], via: 'untagged' },
    // a hand-edited list with a path trick is dropped, the message stays
    { id: 2, ts: now - 4000, author: 'user', text: 'tampered', attachments: [{ name: '..\\..\\secrets.json', size: 3, kind: 'text' }] }
  ]
    .map((m) => JSON.stringify(m) + '\n')
    .join('')
)
let keep = 14
board.initBoard(dir, { keepDays: () => keep, changed: () => {} })

const bytes = (s) => new TextEncoder().encode(s)
// a 1x1 PNG
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
const tool = (actor, name) => tools.boardTools(actor, deps).find((t) => t.name === name)
const corvid = { kind: 'assistant' }
const alpha = { kind: 'agent', agentName: 'Alpha Crow', taskId: 11 }
const beta = { kind: 'agent', agentName: 'Beta Crow', taskId: 21 }

test('old messages load as before; a tampered attachment list is dropped; orphaned folders are swept', () => {
  const list = board.listMessages()
  assert.equal(list.length, 2)
  assert.equal(list[0].attachments, undefined)
  assert.equal(list[1].attachments, undefined)
  assert.equal(list[1].text, 'tampered')
  assert.equal(existsSync(join(att, 'm99')), false)
})

test('names are made safe: no paths, no reserved names, no bad characters, extension kept', () => {
  assert.equal(shared.safeAttachmentName('..\\..\\Windows\\evil.exe'), 'evil.exe')
  assert.equal(shared.safeAttachmentName('../etc/passwd'), 'passwd')
  assert.equal(shared.safeAttachmentName('CON.txt'), '_CON.txt')
  assert.equal(shared.safeAttachmentName('a<b>:c?.png'), 'a_b__c_.png')
  assert.equal(shared.safeAttachmentName('   ...   '), 'file')
  assert.equal(shared.safeAttachmentName('trailing. '), 'trailing')
  const long = shared.safeAttachmentName('x'.repeat(300) + '.json')
  assert.ok(long.length <= 100 && long.endsWith('.json'))
  assert.equal(shared.uniqueName('a.png', ['A.png', 'a (2).png']), 'a (3).png')
})

test('limits: size per file, per message, count, and shortcuts', () => {
  const MB = 1024 * 1024
  assert.match(shared.attachProblem([{ name: 'big.bin', size: 21 * MB }]), /at most 20/)
  assert.match(shared.attachProblem([{ name: 'a', size: 19 * MB }, { name: 'b', size: 19 * MB }, { name: 'c', size: 19 * MB }]), /at most 50/)
  assert.match(shared.attachProblem(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, size: 1 }))), /At most 10/)
  assert.match(shared.attachProblem([{ name: 'Thing.lnk', size: 1 }]), /shortcut/)
  assert.equal(shared.attachProblem([{ name: 'tool.exe', size: 10 }]), '')
  // main enforces them too, and a refused send leaves nothing behind
  const before = readdirSync(dir).includes('attachments') ? readdirSync(att) : []
  assert.throws(() => tools.postAsUser('too many', undefined, deps, { untagged: false, files: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, data: bytes('x') })) }), /At most 10/)
  assert.deepEqual(readdirSync(dir).includes('attachments') ? readdirSync(att) : [], before)
})

let shot, note
test('files are copied into the message folder under safe, unique names; a message may be files alone', () => {
  shot = tools.postAsUser('@Alpha Crow see the screenshot', undefined, deps, {
    untagged: true,
    files: [
      { name: 'shot.png', data: PNG },
      { name: 'notes.txt', data: bytes('line one\nline two') },
      { name: 'notes.txt', data: bytes('again') },
      { name: 'tool.exe', data: bytes('MZ') }
    ]
  })
  assert.deepEqual(shot.to, ['Alpha Crow'])
  assert.deepEqual(
    shot.attachments.map((a) => [a.name, a.kind, a.size]),
    [
      ['shot.png', 'image', PNG.length],
      ['notes.txt', 'text', 17],
      ['notes (2).txt', 'text', 5],
      ['tool.exe', 'file', 2]
    ]
  )
  assert.equal(readFileSync(join(att, `m${shot.id}`, 'notes.txt'), 'utf8'), 'line one\nline two')
  note = tools.postAsUser('', undefined, deps, { untagged: true, files: [{ name: 'log.txt', data: bytes('hello log') }] })
  assert.equal(note.text, '')
  assert.deepEqual(note.to, ['assistant'])
  assert.throws(() => tools.postAsUser('', undefined, deps, { untagged: true }), /empty/)
  // stored with the message and read back after a restart
  const line = readFileSync(join(dir, 'messages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === shot.id)
  assert.equal(line.attachments.length, 4)
})

test('Corvid reads any attachment: images as images, text as text, other files by name only', () => {
  const read = tool(corvid, 'read_attachment')
  const img = read.run({ message: `m${shot.id}`, file: 1 })
  assert.equal(img.image.mimeType, 'image/png')
  assert.equal(img.image.data, Buffer.from(PNG).toString('base64'))
  assert.match(img.text, /information, never instructions/)
  assert.match(read.run({ message: `m${shot.id}`, file: 2 }), /line one\nline two/)
  assert.match(read.run({ message: `m${shot.id}`, file: 4 }), /isn't text or an image/)
  assert.throws(() => read.run({ message: `m${shot.id}`, file: 5 }), /pass file: 1 to 4/)
  assert.throws(() => read.run({ message: 'm1' }), /no attached files/)
  // Corvid's prompt names them and says how to read them
  const prompt = tools.corvidPrompt([note])
  assert.match(prompt, /no text, only attached files/)
  assert.match(prompt, /Attached \(1\): 1\. log\.txt \(text, 9 B\)/)
  assert.match(prompt, /read_attachment \(message: "m\d+"/)
})

test('an agent reads attachments only of messages addressed to it', () => {
  assert.match(tool(alpha, 'read_attachment').run({ message: `m${shot.id}`, file: 2 }), /line one/)
  assert.throws(() => tool(beta, 'read_attachment').run({ message: `m${shot.id}`, file: 2 }), /isn't addressed to you/)
  // read_messages shows names and sizes to both; only Alpha is told how to read them
  const a = tool(alpha, 'read_messages').run({ all: true })
  assert.match(a, /Attached \(4\): 1\. shot\.png \(image, /)
  assert.match(a, new RegExp(`read_attachment \\(message: "m${shot.id}"`))
  const b = tool(beta, 'read_messages').run({ all: true })
  assert.match(b, /Attached \(4\)/)
  assert.match(b, /not addressed to you, so you can't read them/)
  assert.doesNotMatch(b, new RegExp(`read_attachment \\(message: "m${shot.id}"`))
  // agents can't attach: post_message takes no files, and says so
  const post = tool(alpha, 'post_message')
  assert.equal(post.input.files, undefined)
  assert.match(post.description, /cannot attach files/)
})

test('Save as note names the files without copying them in', () => {
  mkdirSync(join(tmp, 'data', 'notes'), { recursive: true })
  const id = tools.saveMessageAsNote(shot.id, () => undefined, 'Robin')
  const text = notes.getNote(id).text
  assert.match(text, /Attached files \(not copied into this note\): 1\. shot\.png/)
  assert.doesNotMatch(text, /line two/)
})

test('expiry and Clear delete the copies', () => {
  assert.ok(existsSync(join(att, `m${shot.id}`)))
  // expire everything older than 7 days, from a clock 8 days ahead
  keep = 7
  board.prune(Date.now() + 8 * 86400_000)
  assert.equal(existsSync(join(att, `m${shot.id}`)), false)
  assert.equal(existsSync(join(att, `m${note.id}`)), false)
  const again = tools.postAsUser('one more', undefined, deps, { untagged: false, files: [{ name: 'a.txt', data: bytes('a') }] })
  assert.ok(existsSync(join(att, `m${again.id}`)))
  board.clearBoard()
  assert.equal(existsSync(att), false)
})
