// Tests for #315, step 3 of the custom models plan (N175 sections 4 and 6): the pre-start health check against a
// throwaway HTTP stub on a random port (up, down, slow, a context that's too small, where the context is read from);
// a custom model's own cap, with the assistant counted and the global cap still counting local workers; the plan usage
// gate, its ask-first dialog and the Fable check skipped for custom models only; and a start refused when the server
// is down. Never the user's own model server: every entry here points at the stub or at a port just closed. Stand-ins
// for electron, the terminals and git, like test-usage-limit.mjs; no Claude session is started.
//
//   node --test scripts/test-custom-health.mjs

import { register } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-custom-health-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const project = join(tmp, 'project')
mkdirSync(project)
globalThis.__launches = []
// the custom models' config folder is worked out under here, never the real %LOCALAPPDATA% (nothing creates it anyway)
process.env.LOCALAPPDATA = join(tmp, 'local')
process.env.XDG_STATE_HOME = join(tmp, 'state')
// the workers' clocks tick on intervals; they mustn't keep the test process alive
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
    export const onTerminalData = () => {}
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
const { checkCustomModel, healthRefusal, contextFromModels, contextFromProps, HEALTH_TIMEOUT_MS } = await import('../src/main/customHealth.ts')

// ---------- the stub server: what it answers is set per test ----------

const hits = []
/** (req, res) => void; leaving res unanswered is the slow server */
let route = () => {}
const server = createServer((req, res) => {
  hits.push(req.url)
  route(req, res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const stubUrl = `http://127.0.0.1:${server.address().port}`
after(() => {
  server.closeAllConnections()
  server.close()
})
const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
/** llama-server's /v1/models shape; n_ctx_train is the model's training length, never the server's context */
const modelList = (meta = {}) => ({ object: 'list', data: [{ id: 'qwen-local', object: 'model', owned_by: 'llamacpp', meta: { n_ctx_train: 262144, ...meta } }] })
const serve = (models, props) => {
  route = (req, res) => {
    if (req.url === '/v1/models') return models === undefined ? json(res, { error: 'no' }, 404) : json(res, models)
    if (req.url === '/props' && props !== undefined) return json(res, props)
    json(res, { error: 'not found' }, 404)
  }
}

/** A port nothing listens on: opened, then closed again. */
const closedPort = async () => {
  const s = createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const port = s.address().port
  await new Promise((r) => s.close(r))
  return port
}

const entry = (over = {}) => ({ id: 'qwen-local', label: 'Qwen 27B (local)', kind: 'anthropic', baseUrl: stubUrl, model: 'qwen-local', contextTokens: 32768, ...over })

// ---------- the check itself ----------

test('the timeout is 3 seconds', () => assert.equal(HEALTH_TIMEOUT_MS, 3000))

test('up, with the context in the model list: passes and says it', async () => {
  serve(modelList({ n_ctx: 32768 }))
  hits.length = 0
  const h = await checkCustomModel(entry())
  assert.equal(h.ok, true)
  assert.equal(h.serverContext, 32768)
  assert.match(h.message, /Qwen 27B \(local\) is answering at http:\/\/127\.0\.0\.1:\d+ with a context of 32,768 tokens/)
  // the model list said it, so /props isn't asked
  assert.deepEqual(hits, ['/v1/models'])
  assert.equal(await healthRefusal(entry(), 12), null)
})

test("up, context only in /props: read from there; n_ctx_train is never taken for the server's context", async () => {
  serve(modelList(), { default_generation_settings: { n_ctx: 65536 }, total_slots: 1 })
  hits.length = 0
  const h = await checkCustomModel(entry())
  assert.equal(h.ok, true)
  assert.equal(h.serverContext, 65536)
  assert.deepEqual(hits, ['/v1/models', '/props'])
})

test('up, no context anywhere (or no model list at all): passes, context unknown', async () => {
  serve(modelList())
  let h = await checkCustomModel(entry())
  assert.equal(h.ok, true)
  assert.equal(h.serverContext, undefined)
  serve(undefined)
  h = await checkCustomModel(entry())
  assert.equal(h.ok, true)
  assert.match(h.message, /HTTP 404, no model list, so its context is unknown/)
})

test('a smaller context than the entry says: refused with both numbers', async () => {
  serve(modelList({ n_ctx: 8192 }))
  const h = await checkCustomModel(entry())
  assert.equal(h.ok, false)
  assert.equal(h.reason, 'context')
  assert.equal(h.serverContext, 8192)
  assert.match(h.message, /runs with a context of 8,192 tokens, but its entry says 32,768/)
  const why = await healthRefusal(entry(), 12)
  assert.match(why, /8,192/)
  assert.match(why, /32,768/)
  assert.match(why, /start #12 again\.$/)
  // from /props too
  serve(modelList(), { default_generation_settings: { n_ctx: 16384 } })
  assert.equal((await checkCustomModel(entry())).reason, 'context')
  // bigger than the entry is fine
  serve(modelList({ n_ctx: 131072 }))
  assert.equal((await checkCustomModel(entry())).ok, true)
})

test('down: nothing listens on the port, refused in plain words', async () => {
  const m = entry({ baseUrl: `http://127.0.0.1:${await closedPort()}` })
  const h = await checkCustomModel(m)
  assert.equal(h.ok, false)
  assert.equal(h.reason, 'down')
  assert.equal(await healthRefusal(m, 12), `Qwen 27B (local) isn't answering at ${m.baseUrl}. Start its server, then start #12 again.`)
})

test('slow: no answer within the timeout counts as down, and the check gives up on time', async () => {
  route = () => {} // never answers
  const t0 = Date.now()
  const h = await checkCustomModel(entry(), 300)
  const took = Date.now() - t0
  assert.equal(h.ok, false)
  assert.equal(h.reason, 'down')
  assert.ok(took >= 250 && took < 2000, `took ${took} ms`)
  server.closeAllConnections()
})

test('a redirect is never followed off the entry’s own host', async () => {
  hits.length = 0
  route = (req, res) => {
    res.writeHead(302, { location: 'http://example.invalid/v1/models' })
    res.end()
  }
  const h = await checkCustomModel(entry())
  assert.equal(h.ok, true)
  assert.equal(h.serverContext, undefined)
  // only the stub was asked (the /v1/models and the /props try), never the redirect's target
  assert.deepEqual(hits, ['/v1/models', '/props'])
})

test('a base URL with a trailing slash or a path prefix is joined cleanly', async () => {
  hits.length = 0
  serve(modelList({ n_ctx: 32768 }))
  await checkCustomModel(entry({ baseUrl: `${stubUrl}/` }))
  assert.deepEqual(hits, ['/v1/models'])
  hits.length = 0
  route = (req, res) => json(res, {}, 404)
  await checkCustomModel(entry({ baseUrl: `${stubUrl}/llm` }))
  assert.deepEqual(hits, ['/llm/v1/models', '/llm/props'])
})

test('reading the context: n_ctx on the matching model or the only one, meta.n_ctx, /props', () => {
  assert.equal(contextFromModels({ data: [{ id: 'a', n_ctx: 1000 }, { id: 'qwen-local', n_ctx: 9000 }] }, 'qwen-local'), 9000)
  assert.equal(contextFromModels({ data: [{ id: 'a', n_ctx: 1000 }, { id: 'b', n_ctx: 2000 }] }, 'qwen-local'), undefined)
  assert.equal(contextFromModels({ data: [{ id: 'gguf-path', meta: { n_ctx: 4096 } }] }, 'qwen-local'), 4096)
  assert.equal(contextFromModels({ data: [{ id: 'x', meta: { n_ctx_train: 4096 } }] }, 'x'), undefined)
  assert.equal(contextFromModels(null, 'x'), undefined)
  assert.equal(contextFromModels({ data: 'nope' }, 'x'), undefined)
  assert.equal(contextFromProps({ default_generation_settings: { n_ctx: 8192 } }), 8192)
  assert.equal(contextFromProps({ n_ctx: 8192 }), 8192)
  assert.equal(contextFromProps({ n_ctx: -1 }), undefined)
  assert.equal(contextFromProps('x'), undefined)
})

// ---------- starting workers: caps, gates and the check ----------

let usage = null
let assistantOn
const tasks = new Map()
const asked = []
let fableAsked = 0
workers.initWorkers({
  quota: () => usage,
  refreshQuota: async () => {},
  fableProblem: async () => (fableAsked++, 'Your plan has no Fable.'),
  task: (id) => tasks.get(id),
  moveTask: () => {},
  changed: () => {},
  note: () => {},
  access: () => null,
  gitChanged: () => {},
  ended: () => {},
  announce: () => {},
  waitingOnUser: () => false,
  confirmOverLimit: async (r) => (asked.push(r), { ok: false, dontAsk: false, timedOut: false }),
  assistantModel: () => assistantOn
  // no modelHealth: the real check runs, against the stub
})
let nextId = 100
function newTask(model) {
  const id = nextId++
  tasks.set(id, { id, title: `Throwaway ${id}`, project, column: 'todo', createdAt: 0, ...(model ? { model } : {}) })
  return id
}
const fresh = (fiveHour, week) => ({ fiveHour, week, at: Date.now(), resets5h: Date.now() + 90 * 60_000 })
function reset({ models = [entry()], limits = {} } = {}) {
  workers.stopAll('test')
  asked.length = 0
  fableAsked = 0
  assistantOn = undefined
  usage = fresh(10, 10)
  globalThis.__launches.length = 0
  serve(modelList({ n_ctx: 32768 }))
  setConfig({
    models,
    workerModel: 'default',
    limits: { ...getConfig().limits, usageLimit: true, gate5h: 70, gate5hOn: true, gateWeek: 80, gateWeekOn: true, overLimit: 'ask', maxWorkers: 4, ...limits }
  })
}
const start = (model) => workers.startWorker(newTask(model))

test('maxRunning unset means 1: a second session on the model is refused, a Claude worker still starts', async () => {
  reset()
  const a = await start('custom:qwen-local')
  assert.ok(a.worker, a.error)
  assert.equal(workers.customRunning('custom:qwen-local'), 1)
  const b = await start('custom:qwen-local')
  assert.equal(b.worker, undefined)
  assert.match(b.error, /Qwen 27B \(local\) already has 1 of 1 session running/)
  const c = await start('sonnet')
  assert.ok(c.worker, c.error)
  // the stopped one frees the slot
  workers.stopWorker(a.worker.id)
  assert.equal(workers.customRunning('custom:qwen-local'), 0)
  assert.ok((await start('custom:qwen-local')).worker)
})

test('maxRunning 2: two start, the third is refused', async () => {
  reset({ models: [entry({ maxRunning: 2 })] })
  assert.ok((await start('custom:qwen-local')).worker)
  assert.ok((await start('custom:qwen-local')).worker)
  const r = await start('custom:qwen-local')
  assert.match(r.error, /already has 2 of 2 sessions running/)
})

test('each model has its own cap', async () => {
  reset({ models: [entry(), entry({ id: 'other', label: 'Other (local)', model: 'other' })] })
  assert.ok((await start('custom:qwen-local')).worker)
  assert.ok((await start('custom:other')).worker)
  assert.equal(workers.customRunning('custom:qwen-local'), 1)
  assert.equal(workers.customRunning('custom:other'), 1)
})

test('the assistant on the model counts as one of its sessions', async () => {
  reset()
  assistantOn = 'custom:qwen-local'
  const r = await start('custom:qwen-local')
  assert.equal(r.worker, undefined)
  assert.match(r.error, /already has 1 of 1 session running/)
  // on another model it doesn't count
  assistantOn = 'haiku'
  assert.ok((await start('custom:qwen-local')).worker)
})

test('local workers still count toward the global cap (decision 1)', async () => {
  reset({ models: [entry({ maxRunning: 3 })], limits: { maxWorkers: 2 } })
  assert.ok((await start('custom:qwen-local')).worker)
  assert.ok((await start('custom:qwen-local')).worker)
  const r = await start('sonnet')
  assert.match(r.error, /2 of 2 workers are already running/)
  assert.match((await start('custom:qwen-local')).error, /2 of 2 workers are already running/)
})

test('two starts at once on a 1-session model: only one gets through the health check wait', async () => {
  reset()
  const [a, b] = await Promise.all([start('custom:qwen-local'), start('custom:qwen-local')])
  assert.equal([a, b].filter((r) => r.worker).length, 1)
  assert.match([a, b].find((r) => !r.worker).error, /already has 1 of 1 session running/)
})

test('over the usage limit: a custom model starts with no question, a Claude worker is asked', async () => {
  reset()
  usage = fresh(95, 95)
  const r = await start('custom:qwen-local')
  assert.ok(r.worker, r.error)
  assert.equal(asked.length, 0)
  const c = await start('sonnet')
  assert.equal(c.worker, undefined)
  assert.equal(asked.length, 1)
})

test('"Block new agents" and unknown usage block Claude workers, not custom ones', async () => {
  reset({ models: [entry({ maxRunning: 2 })], limits: { overLimit: 'block' } })
  usage = fresh(95, 95)
  assert.ok((await start('custom:qwen-local')).worker)
  assert.match((await start('sonnet')).error, /5-hour usage is at 95%/)
  usage = null
  assert.ok((await start('custom:qwen-local')).worker)
})

test('a custom worker model skips the gate for its workers, but not for agents that always run on Claude', async () => {
  reset({ limits: { overLimit: 'block' } })
  usage = fresh(95, 95)
  setConfig({ workerModel: 'custom:qwen-local' })
  assert.equal(await workers.startBlocker(), null)
  assert.match(await workers.extraAgentBlocker('Packaging'), /5-hour usage is at 95%/)
  assert.ok(await workers.usageOverText())
  assert.ok(await workers.usageOverText('custom:qwen-local'))
})

test('no Fable plan check for a custom model, and a Fable task still gets one', async () => {
  reset()
  assert.ok((await start('custom:qwen-local')).worker)
  assert.equal(fableAsked, 0)
  assert.match((await start('fable')).error, /Your plan has no Fable/)
  assert.equal(fableAsked, 1)
})

test('the server down: the start is refused in plain words and nothing launches', async () => {
  const port = await closedPort()
  reset({ models: [entry({ baseUrl: `http://127.0.0.1:${port}` })] })
  const id = newTask('custom:qwen-local')
  const r = await workers.startWorker(id)
  assert.equal(r.worker, undefined)
  assert.equal(r.error, `No agent started for #${id}: Qwen 27B (local) isn't answering at http://127.0.0.1:${port}. Start its server, then start #${id} again.`)
  assert.equal(globalThis.__launches.length, 0)
  assert.equal(workers.customRunning('custom:qwen-local'), 0)
})

test('a context mismatch refuses the start with both numbers', async () => {
  reset()
  serve(modelList({ n_ctx: 8192 }))
  const r = await start('custom:qwen-local')
  assert.equal(r.worker, undefined)
  assert.match(r.error, /8,192 tokens, but its entry says 32,768/)
  assert.equal(globalThis.__launches.length, 0)
})

test('an entry that is gone refuses before any check, and never falls back to Claude', async () => {
  reset({ models: [] })
  hits.length = 0
  const r = await start('custom:qwen-local')
  assert.match(r.error, /"qwen-local" isn't in Settings → Models/)
  assert.equal(globalThis.__launches.length, 0)
  assert.deepEqual(hits, [])
  workers.stopAll('test')
})
