// Tests for #238, the reasoning effort Corvid and new workers run at: config.json loading each level, an invalid value
// and a missing key (back to Claude Code's default, with a repair notice only for the invalid one); setConfig refusing
// an invalid value; the --model/--effort part of the command line; and the arguments a worker is really launched with,
// with and without an effort set. The assistant's launch is checked through the same launchArgs it calls, never by
// starting a Claude session. Stand-ins for electron, the terminals and git, like test-usage-limit.mjs.
//
//   npm run test-effort

import { register } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-effort-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const project = join(tmp, 'project')
mkdirSync(project)
// what each worker was launched with: launchWorker's extra claude arguments
globalThis.__launches = []
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
      // a ?query loads a fresh copy of a module (the config tests)
      return u.split('?')[0].endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const { setConfig } = await import('../src/main/config.ts')
const workers = await import('../src/main/workers.ts')
const { launchArgs } = await import('../src/shared/models.ts')
const { REASONING_EFFORTS, effortArgs } = await import('../src/shared/reasoningEffort.ts')

const tasks = new Map()
workers.initWorkers({
  // usage well under the limit, so no start asks first
  quota: () => ({ fiveHour: 10, week: 10, at: Date.now(), resets5h: Date.now() + 90 * 60_000 }),
  refreshQuota: async () => {},
  task: (id) => tasks.get(id),
  moveTask: () => {},
  changed: () => {},
  note: () => {},
  access: () => null,
  gitChanged: () => {},
  ended: () => {},
  announce: () => {},
  waitingOnUser: () => false,
  confirmOverLimit: async () => ({ ok: false, dontAsk: false, timedOut: false })
})
let nextId = 100
function newTask(model) {
  const id = nextId++
  tasks.set(id, { id, title: `Throwaway ${id}`, project, column: 'todo', createdAt: 0, ...(model ? { model } : {}) })
  return id
}

const cfgFile = join(globalThis.__userData, 'config.json')
const load = async (saved) => {
  writeFileSync(cfgFile, JSON.stringify(saved))
  return await import(`../src/main/config.ts?${Math.random()}`)
}

// ---------- config.json ----------

test('a missing key is Claude Code default, with nothing to repair', async () => {
  const c = await load({ assistantModel: 'opus' })
  assert.equal(c.getConfig().assistantEffort, 'default')
  assert.equal(c.getConfig().workerEffort, 'default')
  assert.deepEqual(c.configRepairs(), [])
})

test('each level and default load as saved', async () => {
  for (const e of ['default', ...REASONING_EFFORTS]) {
    const c = await load({ assistantEffort: e, workerEffort: e })
    assert.deepEqual([c.getConfig().assistantEffort, c.getConfig().workerEffort], [e, e])
    assert.deepEqual(c.configRepairs(), [])
  }
})

test('an invalid value goes back to Claude Code default, with a repair notice', async () => {
  const c = await load({ assistantEffort: 'ultra', workerEffort: 3 })
  assert.deepEqual([c.getConfig().assistantEffort, c.getConfig().workerEffort], ['default', 'default'])
  assert.equal(c.configRepairs().length, 2)
  assert.match(c.configRepairs()[0], /Corvid's effort "ultra" isn't an effort level/)
  for (const bad of ['HIGH', '', null, 'medium ']) {
    const d = await load({ workerEffort: bad })
    assert.equal(d.getConfig().workerEffort, 'default', JSON.stringify(bad))
  }
})

test('setConfig keeps a level and refuses anything else', () => {
  assert.equal(setConfig({ workerEffort: 'xhigh' }).workerEffort, 'xhigh')
  assert.equal(setConfig({ workerEffort: 'turbo' }).workerEffort, 'default')
  assert.equal(setConfig({ assistantEffort: 'max' }).assistantEffort, 'max')
  assert.equal(setConfig({ assistantEffort: {} }).assistantEffort, 'default')
})

// ---------- the command line ----------

test('launchArgs: --effort only for a level, --model only for a model', () => {
  assert.deepEqual(effortArgs('default'), [])
  assert.deepEqual(effortArgs(undefined), [])
  assert.deepEqual(effortArgs('nope'), [])
  for (const e of REASONING_EFFORTS) assert.deepEqual(effortArgs(e), ['--effort', e])
  // Corvid's own session: always a model, an effort only when set
  assert.deepEqual(launchArgs('haiku', 'default'), ['--model', 'haiku'])
  assert.deepEqual(launchArgs('opus', 'high'), ['--model', 'opus', '--effort', 'high'])
  // a worker on the Claude Code default model
  assert.deepEqual(launchArgs('default', 'default'), [])
  assert.deepEqual(launchArgs('default', 'low'), ['--effort', 'low'])
})

test("the assistant's launch passes its model and effort through launchArgs", () => {
  const s = readFileSync(join(import.meta.dirname, '..', 'src', 'main', 'assistant.ts'), 'utf8')
  assert.match(s, /\.\.\.launchArgs\(cfg\.assistantModel, cfg\.assistantEffort\)/)
  assert.doesNotMatch(s, /'--effort'|'--model'/, 'no second, hand-built --model or --effort')
})

const launched = async (taskModel) => {
  globalThis.__launches.length = 0
  const r = await workers.startWorker(newTask(taskModel))
  assert.ok(r.worker, r.error)
  workers.stopAll('test')
  return { args: globalThis.__launches[0], worker: r.worker }
}
const after = (args, flag, n) => args.slice(args.indexOf(flag), args.indexOf(flag) + n)

test('a worker without an effort set gets no --effort, and its record has none', async () => {
  setConfig({ workerModel: 'default', workerEffort: 'default' })
  const { args, worker } = await launched()
  assert.ok(!args.includes('--effort'), args.join(' '))
  assert.ok(!args.includes('--model'))
  assert.equal(worker.effort, undefined)
})

test('a worker with an effort set is launched with it, beside its model', async () => {
  setConfig({ workerModel: 'sonnet', workerEffort: 'high' })
  let { args, worker } = await launched()
  assert.deepEqual(after(args, '--model', 4), ['--model', 'sonnet', '--effort', 'high'])
  assert.equal(worker.effort, 'high')
  // a task's own model still beats Settings; the effort is the one from Settings
  ;({ args } = await launched('opus'))
  assert.deepEqual(after(args, '--model', 4), ['--model', 'opus', '--effort', 'high'])
  setConfig({ workerModel: 'default', workerEffort: 'max' })
  ;({ args } = await launched())
  assert.deepEqual(after(args, '--effort', 2), ['--effort', 'max'])
  assert.ok(!args.includes('--model'))
  setConfig({ workerEffort: 'default' })
})
