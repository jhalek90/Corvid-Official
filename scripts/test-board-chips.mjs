// Tests for #206, the suggestion chips under the board's message box (src/renderer/src/components/boardChips.ts):
// one test per rule, the priority order and the cap of four. Pure functions on sample data; no app, board or data
// folder is touched.
//
//   npm test -- --test-name-pattern=chips

import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(s, c, next) {
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.split('?')[0].endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
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
const C = await import(src + 'renderer/src/components/boardChips.ts')

const NOW = 1_700_000_000_000
const HOUR = 60 * 60_000

let nextId = 1
const msg = (over = {}) => ({ id: nextId++, ts: NOW - 60_000, author: 'agent', agentName: 'Senior Perch Polisher', taskId: 12, text: 'hello', ...over })
const worker = (over = {}) => ({ id: 'w1', taskId: 12, taskTitle: 'A task', model: 'default', termId: 't1', project: 'd:/p', startedAt: NOW - HOUR, workedMs: 0, state: 'running', ...over })
const task = (over = {}) => ({ id: 12, title: 'A task', notes: '', column: 'doing', order: 0, projectId: 'proj-a', createdAt: NOW, updatedAt: NOW, ...over })

/** An empty nest in the All channel, with whatever is given on top. */
const state = (over = {}) => ({ messages: [], workers: [], tasks: [], channel: 'all', usage: {}, now: NOW, ...over })
const texts = (s) => C.boardChips(s).map((c) => c.text)

test('chips: an empty nest gets the onboarding chips', () => {
  assert.deepEqual(texts(state()), [...C.ONBOARDING_CHIPS])
  assert.equal(C.ONBOARDING_CHIPS.length, 4)
  assert.equal(C.boardChips(state()).find((c) => c.text === C.TOUR_CHIP.text)?.tour, C.TOUR_CHIP.tour)
})

test('chips: an agent question with no reply gets an Answer chip that replies to it', () => {
  const q = msg({ question: true, to: ['user'] })
  const chips = C.boardChips(state({ messages: [q] }))
  assert.deepEqual(chips, [{ text: 'Answer Senior Perch Polisher on #12', answer: { id: q.id, agentName: 'Senior Perch Polisher' } }])
})

test('chips: a reply from the user, or a later message to that agent, closes the question', () => {
  const q = msg({ question: true, to: ['user'] })
  const replied = msg({ author: 'user', agentName: undefined, taskId: undefined, replyTo: q.id, to: ['Senior Perch Polisher'] })
  assert.deepEqual(texts(state({ messages: [q, replied] })), [...C.ONBOARDING_CHIPS])
  const addressed = msg({ author: 'user', agentName: undefined, taskId: undefined, to: ['Senior Perch Polisher'] })
  assert.deepEqual(texts(state({ messages: [q, addressed] })), [...C.ONBOARDING_CHIPS])
  // an earlier message to the agent doesn't answer a later question
  const before = msg({ author: 'user', agentName: undefined, taskId: undefined, to: ['Senior Perch Polisher'] })
  const later = msg({ question: true, to: ['user'] })
  assert.deepEqual(texts(state({ messages: [before, later] })), ['Answer Senior Perch Polisher on #12'])
})

test('chips: a question to another agent, or from Corvid, is not the user’s to answer', () => {
  const toAgent = msg({ question: true, to: ['Head Nest Builder'] })
  const fromCorvid = msg({ author: 'assistant', agentName: undefined, taskId: undefined, question: true, to: ['user'] })
  assert.deepEqual(texts(state({ messages: [toAgent, fromCorvid] })), [...C.ONBOARDING_CHIPS])
})

test('chips: the newest open question per agent, newest agent first, and only in the shown channel', () => {
  const a1 = msg({ question: true, to: ['user'], agentName: 'A', taskId: 1, project: 'proj-a' })
  const b1 = msg({ question: true, to: ['user'], agentName: 'B', taskId: 2, project: 'proj-b' })
  const a2 = msg({ question: true, to: ['user'], agentName: 'A', taskId: 1, project: 'proj-a' })
  assert.deepEqual(texts(state({ messages: [a1, b1, a2] })), ['Answer A on #1', 'Answer B on #2'])
  assert.equal(C.boardChips(state({ messages: [a1, b1, a2] }))[0].answer.id, a2.id)
  assert.deepEqual(texts(state({ messages: [a1, b1, a2], channel: 'proj-b' })).filter((t) => t.startsWith('Answer')), ['Answer B on #2'])
})

test('chips: a running worker asks how its task is going, the most recently started one', () => {
  const older = worker({ id: 'w1', taskId: 12, startedAt: NOW - 2 * HOUR })
  const newer = worker({ id: 'w2', taskId: 13, startedAt: NOW - HOUR })
  assert.deepEqual(texts(state({ workers: [older, newer] })), ['How is #13 going?'])
  // an ended worker doesn't count
  assert.deepEqual(texts(state({ workers: [worker({ state: 'exited' })] })), [...C.ONBOARDING_CHIPS])
})

test('chips: in a project channel only that project’s workers count', () => {
  const tasks = [task({ id: 12, projectId: 'proj-a' }), task({ id: 13, projectId: 'proj-b' })]
  const workers = [worker({ id: 'w1', taskId: 12, startedAt: NOW - 2 * HOUR }), worker({ id: 'w2', taskId: 13, startedAt: NOW - HOUR })]
  assert.deepEqual(texts(state({ workers, tasks, channel: 'proj-a' })), ['How is #12 going?', C.CHIP_TEXT.projectState, C.CHIP_TEXT.projectNext])
})

test('chips: a done post in the last hour asks what finished, unless that worker runs again', () => {
  const done = msg({ done: true, taskId: 12, ts: NOW - 30 * 60_000 })
  assert.deepEqual(texts(state({ messages: [done] })), ['What did #12 finish?'])
  const stale = msg({ done: true, taskId: 12, ts: NOW - 2 * HOUR })
  assert.deepEqual(texts(state({ messages: [stale] })), [...C.ONBOARDING_CHIPS])
  // resumed and running: it's "going", not "finished"
  assert.deepEqual(texts(state({ messages: [done], workers: [worker({ taskId: 12 })] })), ['How is #12 going?'])
  // the newest done post wins
  const other = msg({ done: true, taskId: 14, ts: NOW - 10 * 60_000 })
  assert.deepEqual(texts(state({ messages: [done, other] })), ['What did #14 finish?'])
})

test('chips: a project channel gets the two project chips; All and General don’t', () => {
  assert.deepEqual(texts(state({ channel: 'proj-a' })), [C.CHIP_TEXT.projectState, C.CHIP_TEXT.projectNext])
  assert.deepEqual(texts(state({ channel: 'general' })), [...C.ONBOARDING_CHIPS])
  assert.deepEqual(texts(state({ channel: 'all' })), [...C.ONBOARDING_CHIPS])
})

test('chips: Done asks what finished with three tasks, or one after eight hours away', () => {
  const done = (id) => task({ id, column: 'done' })
  assert.deepEqual(texts(state({ tasks: [done(1), done(2)] })), [...C.ONBOARDING_CHIPS])
  assert.deepEqual(texts(state({ tasks: [done(1), done(2), done(3)] })), [C.CHIP_TEXT.away])
  assert.deepEqual(texts(state({ tasks: [done(1)], lastActiveAt: NOW - 9 * HOUR })), [C.CHIP_TEXT.away])
  assert.deepEqual(texts(state({ tasks: [done(1)], lastActiveAt: NOW - 7 * HOUR })), [...C.ONBOARDING_CHIPS])
  // away with nothing in Done asks nothing
  assert.deepEqual(texts(state({ tasks: [task({ column: 'doing' })], lastActiveAt: NOW - 9 * HOUR })), [...C.ONBOARDING_CHIPS])
  // in a project channel only that project's Done counts
  const mixed = [done(1), done(2), { ...done(3), projectId: 'proj-b' }]
  assert.ok(!texts(state({ tasks: mixed, channel: 'proj-a' })).includes(C.CHIP_TEXT.away))
  assert.ok(texts(state({ tasks: mixed, channel: 'all' })).includes(C.CHIP_TEXT.away))
})

test('chips: usage at 60% on either bar gets the usage chip', () => {
  assert.deepEqual(texts(state({ usage: { fiveHour: 59, week: 10 } })), [...C.ONBOARDING_CHIPS])
  assert.deepEqual(texts(state({ usage: { fiveHour: 60 } })), [C.CHIP_TEXT.usage])
  assert.deepEqual(texts(state({ usage: { week: 75 } })), [C.CHIP_TEXT.usage])
})

test('chips: the rules come in priority order and never more than four', () => {
  const q = msg({ question: true, to: ['user'], project: 'proj-a' })
  const done = msg({ done: true, taskId: 15, ts: NOW - 5 * 60_000, project: 'proj-a' })
  const s = state({
    messages: [q, done],
    workers: [worker({ taskId: 13 })],
    tasks: [task({ id: 12 }), task({ id: 13 }), task({ id: 15 }), task({ id: 1, column: 'done' }), task({ id: 2, column: 'done' }), task({ id: 3, column: 'done' })],
    usage: { week: 90 },
    channel: 'proj-a'
  })
  const all = texts(s)
  assert.equal(all.length, C.MAX_CHIPS)
  assert.deepEqual(all, ['Answer Senior Perch Polisher on #12', 'How is #13 going?', 'What did #15 finish?', C.CHIP_TEXT.projectState])
  // with fewer rules firing, the later ones get their turn, still in order
  assert.deepEqual(texts({ ...s, messages: [], workers: [] }), [C.CHIP_TEXT.projectState, C.CHIP_TEXT.projectNext, C.CHIP_TEXT.away, C.CHIP_TEXT.usage])
})

test('chips: the onboarding chips only show when nothing else does', () => {
  const s = state({ usage: { week: 61 } })
  assert.ok(!texts(s).some((t) => C.ONBOARDING_CHIPS.includes(t)))
})
