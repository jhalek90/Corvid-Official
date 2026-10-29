// Tests for #319, step 7 of the custom models plan (N175 section 6): the run-time health watch on a custom-model
// worker's terminal output. Fake terminal output for each pattern (a request over the context, a refused connection,
// another API error, and the trust, first-run and update prompts), the escapes and line wraps a real terminal adds,
// output that must not count (the typed prompt, an early retry, prompts after start-up), each kind reported once, and
// nothing at all for Claude workers. Stand-ins for electron, the terminals and git, like test-custom-health.mjs; no
// Claude session is started and no model server is asked anything.
//
//   node --test scripts/test-model-watch.mjs

import { register } from 'node:module'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-model-watch-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const project = join(tmp, 'project')
mkdirSync(project)
globalThis.__launches = []
// the terminal output listener workers.ts hands the terminals, so the tests can print into a worker's terminal
globalThis.__onData = []
process.env.LOCALAPPDATA = join(tmp, 'local')
process.env.XDG_STATE_HOME = join(tmp, 'state')
const realInterval = globalThis.setInterval
globalThis.setInterval = (...a) => realInterval(...a).unref()

const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
const mod = (code) => `'data:text/javascript,' + encodeURIComponent(${JSON.stringify(code)})`
const stubs = {
  electron: `export const app = { getPath: () => globalThis.__userData }; export const powerMonitor = { on() {} }`,
  './pty': `let n = 0
    export const launchWorker = (...a) => { globalThis.__launches.push(a[5]); return { termId: 't' + ++n } }
    export const listTerminals = () => []
    export const onTerminalExit = () => {}
    export const onTerminalData = (fn) => { globalThis.__onData.push(fn) }
    export const kill = () => {}
    export const lastOutput = () => undefined`,
  './claudeBin': `export const resolveClaude = async () => ({ path: 'claude' }); export const CLAUDE_NOT_FOUND = 'Claude Code (claude) not found.'`,
  './agentGit': `export const prepareBranch = async () => ({ kind: 'current' })
    export const cleanUp = async () => null
    export const setActive = () => {}
    export const unsavedWork = async () => null`,
  './gitTools': `export const gitAccess = () => undefined`,
  './projectStore': `export const builtinProject = () => undefined; export const pastPathsOf = () => []`
}
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const stubs = { ${Object.entries(stubs).map(([k, v]) => `${JSON.stringify(k)}: ${mod(v)}`).join(',\n')} }
    export async function resolve(s, c, next) {
      if (stubs[s] && (s === 'electron' || c.parentURL?.endsWith('/workers.ts'))) return { url: stubs[s], shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.split('?')[0].endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
        for (const ext of ['.ts', '/index.ts']) {
          try { return await next(s + ext, c) } catch {}
        }
      }
      return next(s, c)
    }
    export async function load(u, c, next) {
      return u.split('?')[0].endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const { getConfig, setConfig } = await import('../src/main/config.ts')
const workers = await import('../src/main/workers.ts')
const { findTrouble, scanChunk, newWatch, screenText, troubleMessage, PROMPT_WINDOW_MS } = await import('../src/main/modelWatch.ts')

// ---------- fake terminal output, as Claude Code prints it ----------

const ESC = '\x1b'
const OUT = {
  context:
    `  ⎿  API Error: 400 {"error":{"code":400,"message":"the request exceeds the available context size, try increasing it",` +
    `"type":"exceed_context_size_error","n_prompt_tokens":33012,"n_ctx":32768}}`,
  // Anthropic's own words for the same thing
  tooLong: '  ⎿  Prompt is too long',
  down: '  ⎿  API Error (Connection error.) · Retrying in 4 seconds… (attempt 3/10)',
  downPlain: '  ⎿  API Error: Connection error.',
  refused: 'Unable to connect to API (ConnectionRefused)',
  api: '  ⎿  API Error: 500 {"error":{"message":"Internal server error","type":"server_error"}}',
  trust: ' Do you trust the files in this folder?',
  // the newer wording of the same prompt
  trust2: ' Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team)',
  onboarding: ' Choose the text style that looks best with your terminal:',
  update: ' Update available! Run: claude update'
}

const kinds = (text, prompts = true) => findTrouble(text, { prompts }).map((t) => t.kind)

test('each pattern is found, and only as its own kind', () => {
  assert.deepEqual(kinds(OUT.context), ['context'])
  assert.deepEqual(kinds(OUT.tooLong), ['context'])
  assert.deepEqual(kinds(OUT.down), ['down'])
  assert.deepEqual(kinds(OUT.downPlain), ['down'])
  assert.deepEqual(kinds(OUT.refused), ['down'])
  assert.deepEqual(kinds(OUT.api), ['api'])
  assert.deepEqual(kinds(OUT.trust), ['trust'])
  assert.deepEqual(kinds(OUT.trust2), ['trust'])
  assert.deepEqual(kinds(OUT.onboarding), ['onboarding'])
  assert.deepEqual(kinds(OUT.update), ['update'])
})

test('colours, cursor moves and a wrapped error line read as the screen shows them', () => {
  // Windows' console writes spaces as cursor-forward moves and colours the bullet
  const painted = `${ESC}[2m  ⎿  ${ESC}[0m${ESC}[31mAPI${ESC}[1CError:${ESC}[1C400${ESC}[0m${ESC}[K`
  assert.equal(screenText(painted).trim(), '⎿  API Error: 400')
  // a long 400 wraps at the terminal's width: the context words are on the next line, after a cursor move
  const wrapped = `${painted}${ESC}[12;1H{"error":{"code":400,"message":"the request exceeds the available context${ESC}[13;1Hsize, try increasing it"}}`
  assert.deepEqual(kinds(wrapped), ['context'])
  // a prompt drawn with cursor moves for spaces
  assert.deepEqual(kinds(`Do${ESC}[1Cyou${ESC}[1Ctrust${ESC}[1Cthe${ESC}[1Cfiles${ESC}[1Cin${ESC}[1Cthis${ESC}[1Cfolder?`), ['trust'])
})

test("what isn't the model going wrong doesn't count", () => {
  // the task's own words, echoed as the typed prompt: they talk about API Error lines, but start with ">"
  assert.deepEqual(kinds("> Work on task #319: look for Claude Code's API Error lines, connection refused, a 400 about the context size"), [])
  // the same words in a file the agent shows (a diff line starts with its number)
  assert.deepEqual(kinds("  12 +  const line = '  ⎿  API Error: 400 context size'"), [])
  // a first or second retry may be a blip; the third counts
  assert.deepEqual(kinds('  ⎿  API Error (Connection error.) · Retrying in 1 seconds… (attempt 1/10)'), [])
  assert.deepEqual(kinds('  ⎿  API Error (Connection error.) · Retrying in 2 seconds… (attempt 2/10)'), [])
  // ordinary work
  assert.deepEqual(kinds('⏺ Read(src/main/workers.ts)\n  ⎿  Read 1243 lines\n✻ Thinking…'), [])
  // prompts are only looked for at start-up
  assert.deepEqual(kinds(OUT.trust + '\n' + OUT.onboarding + '\n' + OUT.update, false), [])
})

test('a watch reports each kind once, sees a line split over two chunks, and stops looking for prompts after start-up', () => {
  const w = newWatch(1000)
  assert.deepEqual(scanChunk(w, '  ⎿  API Er', 1001), [])
  assert.deepEqual(scanChunk(w, 'ror: Connection error.\r\n', 1002).map((t) => t.kind), ['down'])
  // the screen redraws the same line: not again
  assert.deepEqual(scanChunk(w, OUT.downPlain + '\r\n', 1003), [])
  // another kind still counts, once
  assert.deepEqual(scanChunk(w, OUT.context + '\r\n', 1004).map((t) => t.kind), ['context'])
  assert.deepEqual(scanChunk(w, OUT.context + '\r\n', 1005), [])
  // once it has been busy, the start-up prompts are behind it
  const busy = newWatch(1000)
  busy.sawBusy = true
  assert.deepEqual(scanChunk(busy, OUT.trust, 1001), [])
  // and after the start-up window too
  const late = newWatch(1000)
  assert.deepEqual(scanChunk(late, OUT.update, 1000 + PROMPT_WINDOW_MS), [])
  assert.deepEqual(scanChunk(newWatch(1000), OUT.update, 1001).map((t) => t.kind), ['update'])
})

test('the messages say what happened, where the work is and what to do, and never offer a Claude model', () => {
  const m = { id: 'qwen-local', label: 'Qwen 27B (local)', kind: 'anthropic', baseUrl: 'http://localhost:8080', model: 'qwen-local', contextTokens: 32768 }
  const say = (kind, branch) => troubleMessage({ kind, line: 'API Error: 500 boom' }, m, 12, branch)
  assert.equal(say('context', 'task-12-x'), "#12's model ran out of context (32k, Qwen 27B (local)). Its work so far is on its branch. Restart it on a bigger model, or split the task.")
  assert.match(say('down'), /^#12 lost its model: http:\/\/localhost:8080 stopped answering \(Qwen 27B \(local\)\)\. Its work so far is in its folder\./)
  assert.match(say('down'), /won't move it to a Claude model by itself/)
  assert.match(say('api'), /^#12's model sent an error \(Qwen 27B \(local\)\): "API Error: 500 boom"/)
  assert.match(say('trust'), /"trust this folder" prompt on Qwen 27B \(local\)\. Answer it in its terminal/)
  assert.match(say('onboarding'), /first-run set-up/)
  assert.match(say('update'), /update notice/)
})

// ---------- in workers.ts: only custom-model workers are watched ----------

const tasks = new Map()
const notes = []
const announced = []
let changes = 0
const moved = []
workers.initWorkers({
  quota: () => ({ fiveHour: 10, week: 10, at: Date.now() }),
  refreshQuota: async () => {},
  task: (id) => tasks.get(id),
  moveTask: (id, column) => moved.push([id, column]),
  changed: () => changes++,
  note: (text, tone) => notes.push({ text, tone }),
  access: () => null,
  gitChanged: () => {},
  ended: () => {},
  announce: (w, text) => announced.push({ taskId: w.taskId, text }),
  waitingOnUser: () => false,
  confirmOverLimit: async () => ({ ok: false, dontAsk: false, timedOut: false }),
  // never a real server: the pre-start check always passes here
  modelHealth: async () => null
})
assert.equal(globalThis.__onData.length, 1, 'workers.ts listens to terminal output')
const print = (termId, text) => globalThis.__onData[0](termId, text)

const qwen = { id: 'qwen-local', label: 'Qwen 27B (local)', kind: 'anthropic', baseUrl: 'http://localhost:8080', model: 'qwen-local', contextTokens: 65536, maxRunning: 2 }
let nextId = 100
function newTask(model) {
  const id = nextId++
  tasks.set(id, { id, title: `Throwaway ${id}`, project, column: 'todo', createdAt: 0, ...(model ? { model } : {}) })
  return id
}
function reset() {
  workers.stopAll('test')
  notes.length = announced.length = moved.length = 0
  globalThis.__launches.length = 0
  setConfig({ models: [qwen], workerModel: 'default', limits: { ...getConfig().limits, usageLimit: false, maxWorkers: 4 } })
}
const start = async (model) => {
  const r = await workers.startWorker(newTask(model))
  assert.ok(r.worker, r.error)
  return r.worker
}
const everything = Object.values(OUT).join('\r\n') + '\r\n'

test('a Claude worker printing every pattern gets nothing: no notice, no note, no card state', async () => {
  reset()
  const w = await start('sonnet')
  const n = changes
  print(w.termId, everything)
  assert.deepEqual(announced, [])
  assert.deepEqual(notes, [])
  assert.equal(w.modelTrouble, undefined)
  assert.equal(changes, n)
  // and one on the default worker model too
  const d = await start()
  print(d.termId, everything)
  assert.deepEqual(announced, [])
  assert.equal(d.modelTrouble, undefined)
})

test('a custom-model worker: one board notice and one card state per kind, and its task stays on its model', async () => {
  reset()
  const w = await start('custom:qwen-local')
  const launches = globalThis.__launches.length
  print(w.termId, OUT.context + '\r\n')
  assert.equal(announced.length, 1)
  assert.equal(announced[0].taskId, w.taskId)
  assert.match(announced[0].text, new RegExp(`^#${w.taskId}'s model ran out of context \\(64k, Qwen 27B \\(local\\)\\)`))
  assert.deepEqual(notes.at(-1), { text: announced[0].text, tone: 'error' })
  assert.equal(w.modelTrouble?.kind, 'context')
  assert.equal(w.modelTrouble?.message, announced[0].text)
  // the same error redrawn: nothing more
  print(w.termId, OUT.context + '\r\n')
  assert.equal(announced.length, 1)
  // the server goes away: a second notice, and the card shows the latest
  print(w.termId, OUT.downPlain + '\r\n')
  assert.equal(announced.length, 2)
  assert.match(announced[1].text, /lost its model: http:\/\/localhost:8080 stopped answering/)
  assert.equal(w.modelTrouble?.kind, 'down')
  // never switched to a Claude model, never restarted, still running
  assert.equal(tasks.get(w.taskId).model, 'custom:qwen-local')
  assert.equal(w.model, 'custom:qwen-local')
  assert.equal(w.state, 'running')
  assert.equal(globalThis.__launches.length, launches)
  assert.deepEqual(moved.filter(([id, c]) => id === w.taskId && c !== 'doing'), [])
  // another worker's output isn't this one's
  const other = await start('sonnet')
  print(other.termId, OUT.api)
  assert.equal(announced.length, 2)
})

test('a start-up prompt warns, and the card clears once the worker gets going', async () => {
  reset()
  const w = await start('custom:qwen-local')
  print(w.termId, OUT.trust + '\r\n')
  assert.equal(announced.length, 1)
  assert.match(announced[0].text, /stuck at Claude Code's "trust this folder" prompt/)
  assert.equal(notes.at(-1).tone, 'warn')
  assert.equal(w.modelTrouble?.kind, 'trust')
  // answered in its terminal: it starts its turn
  workers.updateFromLive([{ termId: w.termId, status: 'busy' }])
  assert.equal(w.modelTrouble, undefined)
  // past start-up, prompt words in its output don't count any more
  print(w.termId, OUT.onboarding + '\r\n')
  assert.equal(announced.length, 1)
  // but a real error still does, and isn't cleared by working on
  print(w.termId, OUT.api + '\r\n')
  assert.equal(w.modelTrouble?.kind, 'api')
  workers.updateFromLive([{ termId: w.termId, status: 'busy' }])
  assert.equal(w.modelTrouble?.kind, 'api')
})

test('a stopped worker is no longer watched', async () => {
  reset()
  const w = await start('custom:qwen-local')
  workers.stopWorker(w.id)
  print(w.termId, everything)
  assert.deepEqual(announced, [])
})
