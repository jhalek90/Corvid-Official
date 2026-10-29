// Tests for #317, step 5 of the custom models plan (N175 section 4, decision 7): the indexer reads the custom models'
// config folder as a second projects root. A session there is local: it shows in the session list (and its live
// updates come through) but costs nothing and stays out of the live minute chart, today's figures and every Usage
// stat, which get one line per local model instead. sessionFolder() finds a transcript in either root, so resume works.
// Fixtures only: fake transcripts under a temporary folder, never ~/.claude or a real config folder. The indexer runs
// in this process with a stand-in for node:worker_threads; no Claude session is started.
//
//   node --test scripts/test-local-sessions.mjs

import { register } from 'node:module'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-local-sessions-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
// the custom config folder is worked out under here, never the real %LOCALAPPDATA%; Claude's own under CLAUDE_CONFIG_DIR
process.env.LOCALAPPDATA = join(tmp, 'local')
process.env.XDG_STATE_HOME = join(tmp, 'state')
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
// macOS puts the custom folder under the home folder
if (process.platform === 'darwin') process.env.HOME = join(tmp, 'home')
// the indexer's and workers' timers tick on intervals; they mustn't keep the test process alive
const realInterval = globalThis.setInterval
globalThis.setInterval = (...a) => realInterval(...a).unref()

const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
const mod = (code) => `'data:text/javascript,' + encodeURIComponent(${JSON.stringify(code)})`
const stubs = {
  electron: `export const app = { getPath: () => globalThis.__userData }; export const powerMonitor = { on() {} }`,
  'node:worker_threads': `export const workerData = globalThis.__workerData
    export const parentPort = { postMessage: (m) => globalThis.__posts.push(m), on: () => {} }`,
  // the indexer's watchers, closed at the end: on Windows a watcher that has fired keeps the process alive even unref'd
  'node:fs': `import * as fs from 'node:fs'
    export * from 'node:fs'
    export const watch = (...a) => { const w = fs.watch(...a); globalThis.__watchers.push(w); return w }`,
  './pty': `export const launchWorker = () => ({ termId: 't1' })
    export const listTerminals = () => []
    export const onTerminalExit = () => {}
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
const STUBBED_FOR = { 'node:worker_threads': '/indexer/worker.ts', 'node:fs': '/indexer/worker.ts' }
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const stubs = { ${Object.entries(stubs).map(([k, v]) => `${JSON.stringify(k)}: ${mod(v)}`).join(',\n')} }
    const only = ${JSON.stringify(STUBBED_FOR)}
    export async function resolve(s, c, next) {
      const parent = c.parentURL?.split('?')[0] ?? ''
      if (stubs[s] && (only[s] ? parent.endsWith(only[s]) : s === 'electron' || parent.endsWith('/workers.ts'))) return { url: stubs[s], shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && parent.endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
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

const { customClaudeDir } = await import('../src/main/platform/paths.ts')
const { localModelLabel } = await import('../src/shared/customModels.ts')
const { estimateCost } = await import('../src/shared/models.ts')

// ---------- the fixtures: one Claude session, one local session with a subagent ----------

const claudeRoot = join(process.env.CLAUDE_CONFIG_DIR, 'projects')
const localRoot = join(customClaudeDir('data'), 'projects')
assert.ok(localRoot.startsWith(tmp), 'the custom config folder must be under the test folder')
const CLAUDE_ID = '11111111-1111-4111-8111-111111111111'
const LOCAL_ID = '22222222-2222-4222-8222-222222222222'
const projDir = 'D--work-app'
const cwd = 'D:\\work\\app'

const ts = (agoMs) => new Date(Date.now() - agoMs).toISOString()
const user = (text, ago) => JSON.stringify({ type: 'user', cwd, timestamp: ts(ago), message: { role: 'user', content: text } })
const reply = (id, model, usage, ago, text = 'done') =>
  JSON.stringify({ type: 'assistant', cwd, timestamp: ts(ago), message: { id, model, role: 'assistant', content: [{ type: 'text', text }], usage } })
const usage = (input, output) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })

mkdirSync(join(claudeRoot, projDir), { recursive: true })
writeFileSync(join(claudeRoot, projDir, `${CLAUDE_ID}.jsonl`), [user('fix the build', 120_000), reply('m1', 'claude-opus-5-5', usage(1000, 200), 60_000)].join('\n') + '\n')
const localFile = join(localRoot, projDir, `${LOCAL_ID}.jsonl`)
mkdirSync(join(localRoot, projDir, LOCAL_ID, 'subagents'), { recursive: true })
writeFileSync(localFile, [user('tidy the readme', 120_000), reply('q1', 'qwen-local', usage(5000, 700), 60_000)].join('\n') + '\n')
// a subagent transcript beside it: its tokens count toward the local session, found from the transcript's own folder
writeFileSync(join(localRoot, projDir, LOCAL_ID, 'subagents', 'agent-a1.jsonl'), reply('q2', 'qwen-local', usage(300, 50), 50_000) + '\n')

// ---------- the indexer ----------

globalThis.__posts = []
globalThis.__watchers = []
globalThis.__workerData = { projectsRoot: claudeRoot, localRoot, cacheDir: join(tmp, 'cache') }
await import('../src/main/indexer/worker.ts')

const posts = globalThis.__posts
async function waitFor(pick, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const hit = pick()
    if (hit) return hit
    if (Date.now() > end) throw new Error('timed out waiting for the indexer')
    await new Promise((r) => setTimeout(r, 50))
  }
}
/** when the live-update test wrote to a transcript: the indexer saves its cache a few seconds after that */
let appendedAt = 0
const indexFile = join(tmp, 'cache', 'index.json')
after(async () => {
  // let the indexer's last cache save land before its folder goes, then stop its watchers
  if (appendedAt) await waitFor(() => existsSync(indexFile) && statSync(indexFile).mtimeMs >= appendedAt, 15_000)
  for (const w of globalThis.__watchers) w.close()
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
})
const lastOf = (type) => posts.filter((p) => p.type === type).at(-1)
await waitFor(() => posts.some((p) => p.type === 'progress' && p.progress.ready))
const sessions = lastOf('sessions').sessions
const stats = lastOf('stats').stats
const byId = (id) => sessions.find((s) => s.id === id)

test('both roots are read: the local session shows in the session list, marked local', () => {
  assert.equal(sessions.length, 2)
  assert.equal(byId(CLAUDE_ID).local, undefined)
  assert.equal(byId(LOCAL_ID).local, true)
  assert.equal(byId(LOCAL_ID).title, 'tidy the readme')
  assert.equal(byId(LOCAL_ID).file, localFile)
})

test("a local session has no API-equivalent cost, where 'other' would price it like Sonnet", () => {
  assert.equal(byId(LOCAL_ID).costUsd, 0)
  assert.ok(estimateCost('qwen-local', { input: 5000, output: 700, cacheRead: 0, cacheWrite: 0 }) > 0, 'the old price would not be zero')
  assert.ok(byId(CLAUDE_ID).costUsd > 0)
})

test("a subagent's tokens under the local root count toward its session", () => {
  assert.equal(byId(LOCAL_ID).tokens.input, 5300)
  assert.equal(byId(LOCAL_ID).tokens.output, 750)
})

test('the Usage stats leave local sessions out of every plan figure', () => {
  assert.deepEqual(stats.totals, { sessions: 1, costUsd: byId(CLAUDE_ID).costUsd, output: 200, messages: 1 })
  const families = new Set(stats.daily.flatMap((d) => Object.keys(d.byModel)))
  assert.deepEqual([...families], ['opus'])
  assert.equal(stats.topProjects.length, 1)
  assert.equal(stats.topProjects[0].output, 200)
  assert.equal(stats.heatmap.flat().reduce((a, b) => a + b, 0), 1)
})

test('and list them per model for the week instead', () => {
  assert.deepEqual(stats.local, [{ model: 'qwen-local', tokens: 6050, sessions: 1 }])
})

test("today's live figures and the minute chart are Claude only", async () => {
  const live = (await waitFor(() => lastOf('live'))).live
  assert.equal(live.today.sessions, 1)
  assert.equal(live.today.output, 200)
  assert.equal(live.today.costUsd, byId(CLAUDE_ID).costUsd)
  assert.equal(live.minutes.reduce((a, b) => a + b.output, 0), 200)
})

test('a new reply in a local transcript comes through as a live update', async () => {
  const before = posts.length
  appendedAt = Date.now()
  appendFileSync(localFile, reply('q3', 'qwen-local', usage(6000, 90), 0, 'and the changelog') + '\n')
  const upd = await waitFor(() => posts.slice(before).find((p) => p.type === 'updated' && p.sessions.some((s) => s.id === LOCAL_ID)))
  const s = upd.sessions.find((x) => x.id === LOCAL_ID)
  assert.equal(s.local, true)
  assert.equal(s.tokens.output, 840)
  assert.equal(s.costUsd, 0)
})

test('the Usage line names the entry the transcript model belongs to, else the model itself', () => {
  const models = [{ id: 'qwen', label: 'Qwen 27B (local)', kind: 'anthropic', baseUrl: 'http://localhost:8080', model: 'qwen-local', smallModel: 'qwen-small', contextTokens: 32768 }]
  assert.equal(localModelLabel(models, 'qwen-local'), 'Qwen 27B (local)')
  assert.equal(localModelLabel(models, 'qwen-small'), 'Qwen 27B (local)')
  assert.equal(localModelLabel(models, 'C:/models/other.gguf'), 'C:/models/other.gguf')
  assert.equal(localModelLabel(undefined, 'qwen-local'), 'qwen-local')
})

// ---------- resume ----------

test('sessionFolder() finds a transcript in either root, and nothing for an unknown or odd id', async () => {
  const { sessionFolder } = await import('../src/main/workers.ts')
  assert.equal(sessionFolder(CLAUDE_ID), projDir.toLowerCase())
  assert.equal(sessionFolder(LOCAL_ID), projDir.toLowerCase())
  assert.equal(sessionFolder('33333333-3333-4333-8333-333333333333'), undefined)
  assert.equal(sessionFolder('../x'), undefined)
})
