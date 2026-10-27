// Tests for #200, /discuss: parsing, the round-robin order and the transcript each panelist sees, the user's messages
// picked up mid-discussion, the caps, one at a time, stop, the restart cancel, the confirmation (Cancel starts
// nothing), that nothing but the window's origin can start one, the read-only CLI flags, the posting path that no agent
// limit touches, the summary and Save as note. A fake headless runner only: no claude, no Corvid, nothing started.
//
//   npm run test-discussion

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-discuss-'))
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

const shared = await import('../src/shared/discussion.ts')
const disc = await import('../src/main/discussion.ts')
const board = await import('../src/main/board.ts')
const tools = await import('../src/main/boardTools.ts')
const slash = await import('../src/main/slashCommands.ts')
const cmds = await import('../src/shared/slashCommands.ts')

after(() => rmSync(tmp, { recursive: true, force: true }))

// ---------- parsing ----------

test('parsing: agents, optional turns, the topic, and every refusal with its reason', () => {
  const p = shared.parseDiscuss
  assert.deepEqual(p('3 What should the update flow do?'), { kind: 'start', agents: 3, turns: 2, topic: 'What should the update flow do?' })
  assert.deepEqual(p('4 3 Should board limits be settings?'), { kind: 'start', agents: 4, turns: 3, topic: 'Should board limits be settings?' })
  // a second number is the turns only when it is a number; "3 2026 plans" would be 2026 turns, which is refused
  assert.equal(p('3 2026 plans').kind, 'error')
  assert.deepEqual(p('2 1 one turn'), { kind: 'start', agents: 2, turns: 1, topic: 'one turn' })
  assert.match(p('3').error, /topic/)
  assert.match(p('3 2').error, /topic/)
  assert.match(p('1 lonely').error, /at least 2/)
  assert.match(p('0 nobody').error, /at least 2/)
  assert.match(p('9 crowd').error, /At most 5/)
  assert.match(p('3 0 none').error, /Turns go from 1 to 5/)
  assert.match(p('3 6 many').error, /Turns go from 1 to 5/)
  assert.match(p('three x').error, /isn't a number of agents/)
  assert.match(p('').error, /^Usage/)
  assert.match(p('2 ' + 'x'.repeat(600)).error, /under 500/)
  assert.deepEqual(p('stop'), { kind: 'stop' })
  assert.deepEqual(p(' STOP '), { kind: 'stop' })
  assert.equal(shared.MAX_AGENTS * shared.MAX_TURNS, shared.MAX_CALLS)
})

test('the command is listed with its hint, and the typo alias finds it', () => {
  const c = cmds.DASHBOARD_COMMANDS.find((x) => x.name === 'discuss')
  assert.equal(c.argumentHint, '<agents> [turns] <topic>')
  assert.equal(cmds.findCommand('disccus', cmds.DASHBOARD_COMMANDS), c)
  assert.equal(cmds.parseCommand('/disccus 3 hello', cmds.DASHBOARD_COMMANDS).cmd, c)
})

// ---------- a fake world ----------

let calls
let confirmAnswer
let confirmed
let usageOver
let blocks
let model
let folder
let notes
let replies

function setup() {
  rmSync(join(tmp, 'board'), { recursive: true, force: true })
  board.initBoard(join(tmp, 'board'), { keepDays: () => 14, changed: () => {}, projectOfTask: () => undefined })
  tools.resetBoardLimits()
  calls = []
  confirmAnswer = true
  confirmed = []
  usageOver = null
  blocks = false
  model = 'default'
  folder = '/proj/alpha'
  notes = []
  replies = (call, n) => (call.prompt.startsWith('You are Corvid') ? 'They agreed on X, disagreed on Y. Next: Z.' : `reply ${n} from ${/^You are (.*?),/.exec(call.prompt)[1]}`)
  disc.initDiscussion({
    post: board.post,
    posted: () => {},
    messages: board.listMessages,
    setMark: board.setDiscussion,
    run: async (call) => {
      calls.push(call)
      await new Promise((r) => setTimeout(r, 5))
      const r = replies(call, calls.length)
      return typeof r === 'string' ? { text: r } : r
    },
    confirm: async (info) => {
      confirmed.push(info)
      return confirmAnswer
    },
    usageOver: async () => usageOver,
    usageBlocks: () => blocks,
    model: () => model,
    projectFolder: (channel) => (channel === 'p1' ? folder : undefined),
    takenNames: () => ['Senior Taken Crow'],
    takenLooks: () => [],
    createNote: (name, text, project) => {
      notes.push({ name, text, project })
      return { id: `N${notes.length}` }
    },
    userName: () => 'Robin'
  })
}

beforeEach(setup)

const start = (o) => disc.startDiscussion({ agents: 3, turns: 2, topic: 'Should board limits be settings?', channel: 'p1', origin: 'window', ...o })
const header = () => board.listMessages().find((m) => m.discussion?.role === 'header')
const settle = async () => {
  for (let i = 0; i < 200 && disc.runningDiscussion() !== null; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(disc.runningDiscussion(), null, 'the discussion should have ended')
}

// ---------- the run ----------

test('round robin: every panelist speaks once a turn in a fixed order, each seeing the transcript so far', async () => {
  const notice = await start()
  assert.match(notice, /6 calls/)
  const h = header()
  assert.equal(h.author, 'corvid')
  assert.match(h.text, /^Discussion: Should board limits be settings\? \(3 agents, 2 turns\)/)
  assert.match(h.text, /pragmatist.*skeptic.*user advocate/s)
  assert.equal(h.discussion.status, 'running')
  assert.equal(h.project, 'p1')
  await settle()
  // 6 panel calls plus the summary
  assert.equal(calls.length, 7)
  const panel = board.listMessages().filter((m) => m.discussion?.role === 'panel')
  assert.equal(panel.length, 6)
  const names = panel.map((m) => m.agentName)
  assert.deepEqual(names.slice(0, 3), names.slice(3, 6), 'the same order both turns')
  assert.equal(new Set(names).size, 3)
  assert.ok(!names.includes('Senior Taken Crow'))
  for (const m of panel) {
    assert.equal(m.author, 'agent')
    assert.equal(m.taskId, undefined, 'no task: not a worker')
    assert.ok(m.avatar, 'a crow of its own')
    assert.equal(m.discussion.id, h.id)
    assert.ok(m.discussion.angle)
    assert.equal(m.to, undefined, 'addresses nobody, so nothing pings')
    assert.equal(m.project, 'p1')
  }
  // the first call sees an empty transcript, the fourth (turn 2, panelist 1) sees the three replies before it
  assert.match(calls[0].prompt, /Nobody has spoken yet/)
  assert.match(calls[0].prompt, /turn 1 of 2/)
  assert.match(calls[0].prompt, /Start your first message with "\(pragmatist\)"/)
  assert.match(calls[1].prompt, /\[.*\] reply 1 from/)
  assert.match(calls[3].prompt, /turn 2 of 2/)
  assert.equal((calls[3].prompt.match(/reply \d from/g) ?? []).length, 3)
  assert.doesNotMatch(calls[3].prompt, /Start your first message/)
  // the angles are deterministic and named in the prompt
  assert.match(calls[1].prompt, /Your angle: the skeptic/)
  // the summary: Corvid's, a fixed call with no folder (no tools), replying to the header
  const sum = board.listMessages().find((m) => m.discussion?.role === 'summary')
  assert.equal(sum.author, 'assistant')
  assert.equal(sum.replyTo, h.id)
  assert.match(sum.text, /agreed on X/)
  assert.equal(calls[6].dir, undefined)
  assert.match(calls[6].prompt, /^You are Corvid, moderating/)
  assert.equal(header().discussion.status, 'done')
  assert.match(header().discussion.progress, /6 messages/)
})

test('the progress line names the turn and the speaker while it runs', async () => {
  let seen = []
  replies = (call, n) => {
    seen.push(header().discussion.progress)
    return `r${n}`
  }
  await start({ agents: 2, turns: 1 })
  await settle()
  assert.match(seen[0], /^Turn 1 of 1: .* is speaking \(1 of 2\)$/)
  assert.match(seen[1], /\(2 of 2\)$/)
  assert.equal(seen[2], 'Corvid is summing up')
})

test('the user’s messages during the discussion reach the next panelist, labelled as from the user', async () => {
  let posted = false
  replies = (call, n) => {
    if (n === 2 && !posted) {
      posted = true
      board.post({ author: 'user', text: 'Keep it cheap please', project: 'p1' })
      // one in another channel, and a command, stay out
      board.post({ author: 'user', text: 'other channel', project: 'p2' })
      board.post({ author: 'user', text: '/usage', project: 'p1', command: 'usage' })
    }
    return `r${n}`
  }
  await start({ agents: 2, turns: 2 })
  await settle()
  assert.doesNotMatch(calls[1].prompt, /Keep it cheap/)
  assert.match(calls[2].prompt, /\[The user, not a panelist\] Keep it cheap please/)
  assert.doesNotMatch(calls[2].prompt, /other channel/)
  assert.doesNotMatch(calls[2].prompt, /\/usage/)
  assert.match(calls[4].prompt, /Keep it cheap please/, 'the summary sees it too')
})

test('the channel’s project folder is read-only; All and General give no file access', async () => {
  await start({ channel: 'p1' })
  await settle()
  assert.equal(calls[0].dir, '/proj/alpha')
  assert.match(calls[0].prompt, /may read files in the current folder/)
  setup()
  await start({ channel: '' })
  await settle()
  assert.equal(calls[0].dir, undefined)
  assert.match(calls[0].prompt, /You have no tools/)
  assert.match(header().text, /no file access here/)
})

test('the CLI flags: read-only tools and the deny rules with a folder, no tools at all without one, the model only when chosen', () => {
  const withDir = disc.callArgs({ prompt: 'x', dir: join(tmp, 'proj'), timeoutMs: 1000 })
  assert.ok(withDir.includes('-p'))
  assert.ok(withDir.includes('--no-session-persistence'))
  assert.ok(withDir.includes('--strict-mcp-config'))
  assert.equal(withDir[withDir.indexOf('--mcp-config') + 1], '{"mcpServers":{}}')
  const tools = withDir.slice(withDir.indexOf('--tools') + 1, withDir.indexOf('--allowedTools'))
  assert.deepEqual(tools, ['Read', 'Glob', 'Grep'])
  assert.deepEqual(withDir.slice(withDir.indexOf('--allowedTools') + 1, withDir.indexOf('--allowedTools') + 4), ['Read', 'Glob', 'Grep'])
  for (const bad of ['Bash', 'Edit', 'Write', 'WebFetch', 'Task', 'NotebookEdit']) assert.ok(!withDir.includes(bad), `${bad} is never allowed`)
  assert.ok(withDir.includes('--settings'), 'the deny rules file (#91)')
  assert.ok(!withDir.includes('--model'))
  const noDir = disc.callArgs({ prompt: 'x', timeoutMs: 1000 })
  assert.equal(noDir[noDir.indexOf('--tools') + 1], '')
  assert.ok(!noDir.includes('--allowedTools'))
  const sonnet = disc.callArgs({ prompt: 'x', model: 'sonnet', timeoutMs: 1000 })
  assert.equal(sonnet[sonnet.indexOf('--model') + 1], 'sonnet')
})

test('the worker model goes to the calls; default passes no model', async () => {
  model = 'haiku'
  await start({ agents: 2, turns: 1 })
  await settle()
  assert.equal(calls[0].model, 'haiku')
  assert.equal(confirmed[0].model, 'haiku')
  setup()
  await start({ agents: 2, turns: 1 })
  await settle()
  assert.equal(calls[0].model, undefined)
})

// ---------- the confirmation and the gates ----------

test('the confirmation carries the figures, and Cancel starts nothing', async () => {
  confirmAnswer = false
  const notice = await start({ agents: 4, turns: 3 })
  assert.match(notice, /cancelled: nothing was started/)
  assert.equal(confirmed.length, 1)
  assert.deepEqual(
    { ...confirmed[0], panel: confirmed[0].panel.length },
    { topic: 'Should board limits be settings?', agents: 4, turns: 3, calls: 12, model: 'default', panel: 4, usageOver: null }
  )
  assert.match(confirmed[0].panel[3], /\(security reviewer\)$/)
  assert.equal(calls.length, 0)
  assert.equal(board.listMessages().length, 0)
  assert.equal(disc.runningDiscussion(), null)
})

test('over the usage limit: the warning goes into the dialog, and Block refuses outright', async () => {
  usageOver = 'Usage is at 5h 80% (limit 70%).'
  await start({ agents: 2, turns: 1 })
  assert.equal(confirmed[0].usageOver, usageOver)
  await settle()
  assert.equal(calls.length, 3)
  setup()
  usageOver = 'Usage is at 5h 80% (limit 70%).'
  blocks = true
  const notice = await start({ agents: 2, turns: 1 })
  assert.match(notice, /can't start.*80%.*blocks new agents/)
  assert.equal(confirmed.length, 0)
  assert.equal(calls.length, 0)
})

test('only the window’s origin may start one', async () => {
  for (const origin of ['agent', 'ping', 'tool', 'extension', 'socket', 'assistant', '']) {
    await assert.rejects(disc.startDiscussion({ agents: 2, turns: 1, topic: 't', channel: '', origin }), /only the user, from the board’s message box/i)
  }
  assert.equal(confirmed.length, 0)
  assert.equal(board.listMessages().length, 0)
  // the slash command path itself refuses any origin but the window, before it looks at the text
  const deps = { list: () => ({ commands: cmds.DASHBOARD_COMMANDS, from: 'fallback' }), unavailable: () => undefined }
  assert.throws(() => slash.runCommand('/discuss 2 t', undefined, deps, '', 'agent'), /only from the board’s message box/)
  assert.throws(() => slash.runCommand('/usage', undefined, deps, '', 'tool'), /only from the board’s message box/)
})

test('the board tools cannot post a discussion message or run the command', () => {
  // an agent's post that starts with /discuss is plain text with no discussion mark
  const deps = { agents: () => [], posted: () => {}, userName: () => '', done: () => {}, projectOf: () => undefined, projectName: () => undefined, agentPosted: () => {}, pings: () => ({ on: false, wake: false }) }
  const t = tools.boardTools({ kind: 'agent', agentName: 'Some Crow', taskId: 7 }, deps).find((x) => x.name === 'post_message')
  t.run({ text: '/discuss 3 a topic' })
  const m = board.listMessages().at(-1)
  assert.equal(m.text, '/discuss 3 a topic')
  assert.equal(m.command, undefined)
  assert.equal(m.discussion, undefined)
  assert.equal(disc.runningDiscussion(), null)
})

// ---------- one at a time, stop, caps ----------

test('one at a time: a second /discuss is refused while one runs', async () => {
  await start({ agents: 2, turns: 2 })
  const second = await start({ agents: 2, turns: 1, topic: 'another' })
  assert.match(second, /already running \(m\d+/)
  assert.equal(confirmed.length, 1)
  await settle()
  assert.equal(board.listMessages().filter((m) => m.discussion?.role === 'header').length, 1)
})

test('stop ends it after the current call, then Corvid sums up what was said', async () => {
  assert.equal(disc.stopDiscussion(), 'No discussion is running.')
  let stopAt = 2
  replies = (call, n) => {
    if (n === stopAt) assert.match(disc.stopDiscussion(), /Stopping the discussion after the current call/)
    return `r${n}`
  }
  await start({ agents: 3, turns: 3 })
  await settle()
  // calls 1 and 2 ran, call 2 finished, then the summary
  assert.equal(calls.length, 3)
  assert.match(calls[2].prompt, /^You are Corvid/)
  assert.equal(header().discussion.status, 'stopped')
  assert.equal(board.listMessages().filter((m) => m.discussion?.role === 'panel').length, 2)
  assert.ok(board.listMessages().some((m) => m.discussion?.role === 'summary'))
  // stopped before anyone answered: no summary call
  setup()
  replies = (call, n) => {
    disc.stopDiscussion()
    return { error: 'killed' }
  }
  await start({ agents: 2, turns: 1 })
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(header().discussion.status, 'stopped')
  assert.match(header().discussion.progress, /before anyone spoke/)
})

test('a failed call is skipped with a notice; two in a row end it', async () => {
  replies = (call, n) => (n === 2 ? { error: 'no answer within 3 minutes' } : `r${n}`)
  await start({ agents: 2, turns: 2 })
  await settle()
  assert.equal(board.listMessages().filter((m) => m.discussion?.role === 'panel').length, 3)
  assert.ok(board.listMessages().some((m) => m.author === 'corvid' && /didn't answer this turn \(no answer within 3 minutes\)/.test(m.text)))
  assert.equal(header().discussion.status, 'done')
  setup()
  replies = () => ({ error: 'boom' })
  await start({ agents: 3, turns: 2 })
  await settle()
  assert.equal(calls.length, 2)
  assert.equal(header().discussion.status, 'failed')
  assert.match(header().discussion.progress, /Two calls in a row failed/)
})

test('long replies are cut to the post cap, and the calls carry the timeout', async () => {
  replies = () => 'w'.repeat(5000)
  await start({ agents: 2, turns: 1 })
  await settle()
  const panel = board.listMessages().filter((m) => m.discussion?.role === 'panel')
  assert.ok(panel[0].text.length <= shared.MAX_POST_CHARS)
  assert.equal(calls[0].timeoutMs, shared.CALL_TIMEOUT_MS)
})

test('the posting path is not the agents’ tool: 25 posts in a row pass where the agent limits would refuse', async () => {
  await start({ agents: 5, turns: 5 })
  await settle()
  const panel = board.listMessages().filter((m) => m.discussion?.role === 'panel')
  assert.equal(panel.length, 25)
  assert.ok(tools.BOARD_LIMITS.agent.gapSec > 0, 'the agents have a gap the panel never waited for')
})

test('a restart cancels a discussion that was running, with a calm notice, and resumes nothing', async () => {
  await start({ agents: 2, turns: 1 })
  // simulate the app closing mid-run: forget the running one, then start over on the same board file
  const h = header()
  board.initBoard(join(tmp, 'board'), { keepDays: () => 14, changed: () => {}, projectOfTask: () => undefined })
  assert.equal(header().discussion.status, 'running')
  assert.equal(disc.cancelLeftovers(), 1)
  assert.equal(header().discussion.status, 'cancelled')
  const notice = board.listMessages().find((m) => m.replyTo === h.id && /Corvid restarted/.test(m.text))
  assert.ok(notice)
  assert.equal(notice.author, 'corvid')
  assert.equal(disc.cancelLeftovers(), 0, 'nothing to cancel twice')
  await new Promise((r) => setTimeout(r, 100))
})

// ---------- save as note ----------

test('Save as note: the transcript with the user’s lines, then the summary, named from the topic', async () => {
  let posted = false
  replies = (call, n) => {
    // posted while the second panelist is being asked, so it lands between r1 and r2 on the board
    if (n === 2 && !posted) {
      posted = true
      board.post({ author: 'user', text: 'My two cents', project: 'p1' })
    }
    return call.prompt.startsWith('You are Corvid') ? 'The summary.' : `r${n}`
  }
  await start({ agents: 2, turns: 1 })
  await settle()
  const id = disc.saveDiscussionNote(header().id)
  assert.equal(id, 'N1')
  assert.equal(notes[0].name, 'Discussion: Should board limits be settings?')
  assert.equal(notes[0].project, 'p1')
  assert.match(notes[0].text, /Topic: Should board limits be settings\?/)
  assert.match(notes[0].text, /\[.*\] r1\n\n\[The user, not a panelist\] My two cents\n\n\[.*\] r2/)
  assert.match(notes[0].text, /Summary\n\nThe summary\./)
  assert.throws(() => disc.saveDiscussionNote(9999), /gone/)
})
