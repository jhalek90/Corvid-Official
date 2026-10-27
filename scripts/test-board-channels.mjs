// Tests for #145, board channels: the project tag on new messages (agents, notices, Corvid, the user's channel),
// old messages without one loading into General, per-channel unread marks, messages for the user staying findable
// from any channel, Corvid's project context, and an agent's read_messages scoped to its own project.
// The board runs on fake data in a temp folder, with a stand-in for electron; the real data folder is never touched.
//
//   npm run test-board-channels

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-channels-'))
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

after(() => rmSync(tmp, { recursive: true, force: true }))

// three fake projects, and tasks on them
const PROJECTS = { p1: 'Alpha', p2: 'Beta', p3: 'Gamma' }
const TASKS = { 11: 'p1', 12: 'p1', 21: 'p2', 31: 'p3' }
const projectOf = (id) => TASKS[id]
const deps = {
  agents: () => [
    { name: 'Alpha Crow', taskId: 11, live: true },
    { name: 'Beta Crow', taskId: 21, live: true }
  ],
  posted: () => {},
  userName: () => 'Robin',
  projectOf,
  projectName: (id) => PROJECTS[id]
}

const dir = join(tmp, 'board')
mkdirSync(dir, { recursive: true })
const now = Date.now()
// written before channels: no project field; one with a broken tag
writeFileSync(
  join(dir, 'messages.jsonl'),
  [
    { id: 1, ts: now - 5000, author: 'user', text: 'old hello', to: ['assistant'], via: 'untagged' },
    { id: 2, ts: now - 4000, author: 'agent', agentName: 'Alpha Crow', taskId: 11, text: 'old agent post' },
    { id: 3, ts: now - 3000, author: 'assistant', text: 'old reply', project: 42 }
  ]
    .map((m) => JSON.stringify(m) + '\n')
    .join('')
)
writeFileSync(join(dir, 'board.json'), JSON.stringify({ nextId: 4, seenUpTo: 3 }))
board.initBoard(dir, { keepDays: () => 14, changed: () => {}, projectOfTask: projectOf })

test('messages from before channels load into General, a broken tag is dropped', () => {
  const list = board.listMessages()
  assert.equal(list.length, 3)
  for (const m of list) {
    assert.equal(m.project, undefined)
    assert.equal(shared.channelOf(m), shared.GENERAL_CHANNEL)
  }
})

test('agents, notices and Corvid are tagged with the right channel', () => {
  const alpha = tools.boardTools({ kind: 'agent', agentName: 'Alpha Crow', taskId: 11 }, deps)
  alpha.find((t) => t.name === 'post_message').run({ text: 'Starting on #11.' })
  const a = board.listMessages().at(-1)
  assert.equal(a.project, 'p1')
  // a notice about a task goes to its project; an app-wide one goes to General
  assert.equal(board.post({ author: 'corvid', taskId: 21, text: 'Beta Crow was closed.' }).project, 'p2')
  assert.equal(board.post({ author: 'corvid', text: 'Usage is at 90%.' }).project, undefined)
  // Corvid's reply joins the channel of the message it answers
  const ask = tools.postAsUser("what's blocked here?", undefined, deps, { untagged: true, channel: 'p3' })
  assert.equal(ask.project, 'p3')
  assert.deepEqual(ask.to, ['assistant'])
  const reply = tools.postCorvidReply(ask.id, 'Nothing is blocked in Gamma.', [], deps)
  assert.equal(reply.project, 'p3')
})

test("the user's channel: a project, General, or in All the parent's channel", () => {
  const inP2 = tools.postAsUser('@Alpha Crow quick one', undefined, deps, { untagged: true, channel: 'p2' })
  assert.equal(inP2.project, 'p2')
  assert.deepEqual(inP2.to, ['Alpha Crow'], '@mentions still reach agents from any channel')
  assert.equal(tools.postAsUser('hi', undefined, deps, { untagged: true, channel: 'general' }).project, undefined)
  assert.equal(tools.postAsUser('hi', undefined, deps, { untagged: true, channel: 'all' }).project, undefined)
  const p1msg = board.listMessages().find((m) => m.project === 'p1')
  assert.equal(tools.postAsUser('replying', p1msg.id, deps, { untagged: true }).project, 'p1')
})

test('unread counts per channel; All marks every channel, a channel only itself', () => {
  board.markSeen(board.listMessages().at(-1).id)
  let snap = board.snapshot()
  assert.equal(shared.unreadFor(snap).length, 0)
  board.post({ author: 'agent', agentName: 'Alpha Crow', taskId: 11, text: 'a1' })
  board.post({ author: 'agent', agentName: 'Beta Crow', taskId: 21, text: 'b1' })
  const q = board.post({ author: 'agent', agentName: 'Beta Crow', taskId: 21, text: 'Which theme?', to: ['user'], question: true })
  snap = board.snapshot()
  assert.equal(shared.unreadFor(snap, 'p1').length, 1)
  assert.equal(shared.unreadFor(snap, 'p2').length, 2)
  assert.equal(shared.unreadFor(snap, 'general').length, 0)
  assert.equal(shared.unreadFor(snap).length, 3)
  // reading Alpha's channel leaves Beta's unread, and its question for the user still needs them
  board.markSeen(q.id, 'p1')
  snap = board.snapshot()
  assert.equal(shared.unreadFor(snap, 'p1').length, 0)
  assert.equal(shared.unreadFor(snap, 'p2').length, 2)
  assert.equal(shared.unreadFor(snap).length, 2)
  assert.ok(shared.needsUser(snap, q), 'the question is visible from any channel')
  assert.equal(shared.seenUpToIn(snap, 'p1'), q.id)
  // writing in General doesn't mark Beta read either
  tools.postAsUser('just me', undefined, deps, { untagged: false, channel: 'general' })
  assert.equal(shared.unreadFor(board.snapshot(), 'p2').length, 2)
  // the per-channel marks survive a restart
  board.initBoard(dir, { keepDays: () => 14, changed: () => {}, projectOfTask: projectOf })
  assert.equal(shared.unreadFor(board.snapshot(), 'p1').length, 0)
  assert.equal(shared.unreadFor(board.snapshot(), 'p2').length, 2)
  // reading All counts for every channel
  board.markSeen(board.listMessages().at(-1).id)
  snap = board.snapshot()
  assert.equal(shared.unreadFor(snap).length, 0)
  assert.ok(!shared.needsUser(snap, q))
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8')).channelSeen, {})
})

test("an agent's read_messages: its own project's channel plus what's for it; all: true for every channel", () => {
  tools.resetBoardLimits()
  board.post({ author: 'agent', agentName: 'Gamma Crow', taskId: 31, text: 'gamma only' })
  const mention = tools.postAsUser('@Alpha Crow from Beta', undefined, deps, { untagged: true, channel: 'p2' })
  const read = (actor, args = {}) => tools.boardTools(actor, deps).find((t) => t.name === 'read_messages').run({ limit: 50, ...args })
  const alpha = { kind: 'agent', agentName: 'Alpha Crow', taskId: 11 }
  const mine = read(alpha)
  assert.match(mine, /Showing the Alpha channel and anything addressed to you; pass all: true/)
  assert.doesNotMatch(mine, /gamma only/)
  assert.doesNotMatch(mine, /\bb1\b/)
  assert.match(mine, /a1/)
  assert.match(mine, new RegExp(`m${mention.id} .*in Beta channel`), 'a mention from another channel still reaches it, labelled')
  assert.match(mine, /old agent post/, 'its own posts from before channels')
  const all = read(alpha, { all: true })
  assert.match(all, /gamma only/)
  assert.doesNotMatch(all, /Showing the Alpha channel/)
  assert.match(read(alpha, { to_me: true }), /from Beta/)
  // the assistant reads every channel, with no all option
  const corvid = tools.boardTools({ kind: 'assistant' }, deps).find((t) => t.name === 'read_messages')
  assert.equal(corvid.input.all, undefined)
  assert.match(corvid.run({ limit: 50 }), /gamma only/)
})

test('Corvid is told which project a channel means', () => {
  const m = tools.postAsUser('start the next task', undefined, deps, { untagged: true, channel: 'p2' })
  const p = tools.corvidPrompt([m], 'Robin', deps.projectName)
  assert.match(p, /in the board's Beta channel \(project id p2\)/)
  assert.match(p, /they mean Beta/)
  const g = tools.postAsUser('hello', undefined, deps, { untagged: true, channel: 'general' })
  assert.doesNotMatch(tools.corvidPrompt([g], 'Robin', deps.projectName), /channel \(project id/)
})

test('clearing removes every channel', () => {
  board.clearBoard()
  assert.equal(board.listMessages().length, 0)
  assert.deepEqual(board.snapshot().channelSeen, {})
})

test('the prompts tell agents and Corvid about channels', () => {
  assert.match(tools.workerBoardPrompt({ agentName: 'X', taskId: 1 }), /pass all: true to read every channel/)
  assert.match(tools.ASSISTANT_BOARD_PROMPT, /The board has channels/)
})
