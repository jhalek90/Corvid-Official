// Tests for #199, the board's posting and reading limits: the values (agents 30 posts an hour 10 s apart and 60 reads,
// Corvid 40 posts 5 s apart and 80 reads, 150 posts an hour for everyone together), each at its boundary through the real
// post_message and read_messages tools, the error text with the numbers, and that the tool descriptions and the worker
// instructions show the numbers from BOARD_LIMITS, never old ones. A temporary board folder and fake actors only.
//
//   node --test scripts/test-board-limits.mjs

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-board-limits-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
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

const board = await import('../src/main/board.ts')
const tools = await import('../src/main/boardTools.ts')
const { BOARD_LIMITS } = tools

after(() => rmSync(tmp, { recursive: true, force: true }))

let clock = Date.now()
const realNow = Date.now
Date.now = () => clock
after(() => (Date.now = realNow))
const later = (ms) => (clock += ms)

board.initBoard(join(tmp, 'board'), { keepDays: () => 14, changed: () => {}, projectOfTask: () => undefined })
const deps = { agents: () => [], posted: () => {}, userName: () => '' }
const agent = (taskId) => ({ kind: 'agent', agentName: `Crow ${taskId}`, taskId })
const toolOf = (actor, name) => tools.boardTools(actor, deps).find((t) => t.name === name)
const tryRun = (tool, args) => (async () => tool.run(args))().then((ok) => ({ ok }), (e) => ({ err: e.message }))

beforeEach(() => {
  later(2 * 3600_000)
  tools.resetBoardLimits()
})

test('the relaxed values: agents 30 posts an hour, 10 s apart, 60 reads; Corvid 40, 5 s, 80; everyone 150', () => {
  assert.deepEqual(BOARD_LIMITS, {
    agent: { postsPerHour: 30, gapSec: 10, readsPerHour: 60 },
    assistant: { postsPerHour: 40, gapSec: 5, readsPerHour: 80 },
    allPostsPerHour: 150
  })
})

for (const kind of ['agent', 'assistant']) {
  const actor = kind === 'agent' ? agent(7) : { kind: 'assistant' }
  const lim = BOARD_LIMITS[kind]

  test(`${kind}: the post gap, refused 1 s short with the wait, passes at exactly ${lim.gapSec} s`, async () => {
    const post = toolOf(actor, 'post_message')
    assert.ok((await tryRun(post, { text: 'first' })).ok)
    later(lim.gapSec * 1000 - 1000)
    assert.equal((await tryRun(post, { text: 'too soon' })).err, `Rate limit: posts must be at least ${lim.gapSec} seconds apart. Wait 1 s, or combine what you have into one message.`)
    later(1000)
    assert.ok((await tryRun(post, { text: 'on time' })).ok)
  })

  test(`${kind}: ${lim.postsPerHour} posts in an hour pass, the next is refused, and one frees up when the first is an hour old`, async () => {
    const post = toolOf(actor, 'post_message')
    const first = clock
    for (let i = 0; i < lim.postsPerHour; i++) {
      assert.ok((await tryRun(post, { text: `post ${i}` })).ok, `post ${i}`)
      later(lim.gapSec * 1000)
    }
    assert.match((await tryRun(post, { text: 'one too many' })).err, new RegExp(`^Rate limit: you posted ${lim.postsPerHour} messages in the last hour, the most allowed\\.`))
    clock = first + 3600_000 + 1
    assert.ok((await tryRun(post, { text: 'an hour later' })).ok)
  })

  test(`${kind}: ${lim.readsPerHour} reads in an hour pass, the next is refused`, async () => {
    const read = toolOf(actor, 'read_messages')
    for (let i = 0; i < lim.readsPerHour; i++) assert.ok((await tryRun(read, {})).ok, `read ${i}`)
    assert.match((await tryRun(read, {})).err, new RegExp(`^Rate limit: you read the board ${lim.readsPerHour} times in the last hour\\.`))
  })

  test(`${kind}: the tool descriptions show the numbers from BOARD_LIMITS`, () => {
    assert.ok(toolOf(actor, 'post_message').description.includes(`${lim.postsPerHour} posts per hour, ${lim.gapSec} s apart.`))
    assert.ok(toolOf(actor, 'read_messages').description.includes(`(${lim.readsPerHour} reads per hour)`))
  })
}

test(`all posters together: ${BOARD_LIMITS.allPostsPerHour} posts in an hour pass, the next is refused`, async () => {
  // round robin over just enough agents that none of them reaches its own limits
  const n = Math.ceil(BOARD_LIMITS.allPostsPerHour / BOARD_LIMITS.agent.postsPerHour)
  const posts = Array.from({ length: n }, (_, a) => toolOf(agent(100 + a), 'post_message'))
  for (let i = 0; i < BOARD_LIMITS.allPostsPerHour; i++) {
    assert.ok((await tryRun(posts[i % n], { text: `p${i}` })).ok, `post ${i}`)
    later(Math.ceil((BOARD_LIMITS.agent.gapSec * 1000) / n))
  }
  const r = await tryRun(toolOf(agent(999), 'post_message'), { text: 'one too many' })
  assert.equal(r.err, 'Rate limit: the board has had all the agent messages it takes for this hour. Keep working without posting.')
})

test("the worker instructions state the agent limits from BOARD_LIMITS, and no old numbers", () => {
  const p = tools.workerBoardPrompt({ agentName: 'Crow 7', taskId: 7 })
  const a = BOARD_LIMITS.agent
  assert.ok(p.includes(`Limits: ${a.postsPerHour} posts per hour, ${a.gapSec} seconds apart, and ${a.readsPerHour} reads per hour.`))
  assert.ok(!/\b12 posts|20 seconds apart|\b20 reads/.test(p))
})
