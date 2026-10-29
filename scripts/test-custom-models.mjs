// Tests for #313, custom models step 1: config.json's optional "models" list and the custom:<id> value. An older
// config.json and tasks.json load and save unchanged; bad entries are dropped with a repair notice and the good ones
// stay; reserved and duplicate ids are refused; base URLs are loopback http(s) only, without credentials; the env
// allow list and its refusal of key-like names; and custom:<id> survives load and save in workerModel,
// assistantModel and a task's model even when its entry is gone. config.ts and tasks.ts run in a temporary folder
// through a stand-in for electron, like test-effort.mjs. Nothing is launched and no server is called.
//
//   npm run test-custom-models

import { register } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-custom-models-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent('export const app = { getPath: () => globalThis.__userData, isPackaged: false }; export const powerMonitor = { on() {} }')
    export async function resolve(s, c, next) {
      if (s === 'electron') return { url: fake, shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.split('?')[0].endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
        for (const ext of ['.ts', '/index.ts']) {
          try { return await next(s + ext, c) } catch {}
        }
      }
      return next(s, c)
    }
    export async function load(u, c, next) {
      // a ?query loads a fresh copy of a module (each config load)
      return u.split('?')[0].endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const cm = await import(src + 'shared/customModels.ts')
const { HARD_MAX_WORKERS } = await import(src + 'shared/workerLimits.ts')

after(() => {
  rmSync(tmp, { recursive: true, force: true })
  // the tasks.json watcher would keep the test running
  setTimeout(() => process.exit(0), 50)
})

const cfgFile = join(globalThis.__userData, 'config.json')
const load = async (saved) => {
  writeFileSync(cfgFile, JSON.stringify(saved))
  return await import(`${src}main/config.ts?${Math.random()}`)
}
const savedConfig = () => JSON.parse(readFileSync(cfgFile, 'utf8'))

/** A good entry, with every field the design names. */
const qwen = (over = {}) => ({
  id: 'qwen-local',
  label: 'Qwen 27B (local)',
  kind: 'anthropic',
  baseUrl: 'http://localhost:8080',
  model: 'qwen-local',
  smallModel: 'qwen-local',
  contextTokens: 32768,
  maxOutputTokens: 4096,
  maxRunning: 1,
  profile: 'lean',
  env: { API_TIMEOUT_MS: '600000' },
  auth: { kind: 'none' },
  ...over
})
const problem = (over, taken) => cm.customModelProblem(qwen(over), taken)

// ---------- the entry checks ----------

test('a full entry and a minimal one are fine', () => {
  assert.equal(cm.customModelProblem(qwen()), null)
  assert.equal(cm.customModelProblem({ id: 'm', label: 'M', kind: 'anthropic', baseUrl: 'http://127.0.0.1:1234', model: 'm', contextTokens: 8192 }), null)
})

test('reserved and duplicate ids are refused, and ids must be well formed', () => {
  for (const id of cm.RESERVED_MODEL_IDS) assert.match(problem({ id }), /reserved/, id)
  assert.match(problem({}, new Set(['qwen-local'])), /already has the id/)
  for (const id of ['', 'Qwen', 'has space', 'under_score', 'a'.repeat(33), 7, undefined]) assert.match(problem({ id }), /its id must be/, String(id))
})

test('base URLs: loopback http(s) only, no credentials', () => {
  for (const u of ['http://localhost:8080', 'https://localhost', 'http://127.0.0.1:8080/prefix', 'http://[::1]:8080', 'HTTP://LOCALHOST:1'])
    assert.equal(cm.baseUrlProblem(u), null, u)
  for (const u of ['http://192.168.1.20:8080', 'https://api.example.com', 'http://localhost.example.com', 'http://127.0.0.2'])
    assert.match(cm.baseUrlProblem(u), /not on this computer/, u)
  for (const u of ['http://user:pw@localhost:8080', 'http://user@localhost:8080']) assert.match(cm.baseUrlProblem(u), /user name or password/, u)
  for (const u of ['ftp://localhost', 'file:///c:/x', 'ws://localhost']) assert.match(cm.baseUrlProblem(u), /http or https/, u)
  for (const u of ['', 'localhost:8080', 'not a url', 42, undefined]) assert.match(cm.baseUrlProblem(u), /isn't a URL|http or https/, String(u))
  assert.match(cm.baseUrlProblem('http://localhost:8080/?key=x'), /query/)
  assert.match(problem({ baseUrl: 'http://10.0.0.5:8080' }), /not on this computer/)
})

test('context, sessions at once, auth and the other fields are range-checked', () => {
  assert.equal(problem({ contextTokens: 8192 }), null)
  assert.equal(problem({ contextTokens: 2_000_000 }), null)
  for (const n of [8191, 2_000_001, 32768.5, '32768', undefined]) assert.match(problem({ contextTokens: n }), /its context/, String(n))
  assert.equal(problem({ maxRunning: HARD_MAX_WORKERS }), null)
  for (const n of [0, HARD_MAX_WORKERS + 1, 1.5, '1']) assert.match(problem({ maxRunning: n }), /sessions at once/, String(n))
  for (const auth of [{ kind: 'secret', secretRef: 'x' }, { kind: 'bearer' }, {}, 'none', null])
    assert.match(problem({ auth }), /auth kind/, JSON.stringify(auth))
  assert.match(problem({ kind: 'openai' }), /kind/)
  assert.match(problem({ kind: undefined }), /kind/)
  assert.match(problem({ label: '' }), /label/)
  assert.match(problem({ label: 'x'.repeat(41) }), /label/)
  assert.match(problem({ model: '' }), /model name/)
  assert.match(problem({ smallModel: '' }), /small model/)
  assert.match(problem({ profile: 'tiny' }), /profile/)
  assert.match(problem({ maxOutputTokens: 40000 }), /max output/)
  assert.match(cm.customModelProblem('qwen'), /isn't an entry/)
  assert.match(cm.customModelProblem(null), /isn't an entry/)
})

test('the env allow list, and key-like names refused', () => {
  for (const n of ['API_TIMEOUT_MS', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS', 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING'])
    assert.equal(cm.envNameProblem(n), null, n)
  // N175 lists MAX_THINKING_TOKENS, but it contains TOKEN, and the key-like rule always wins
  assert.match(cm.envNameProblem('MAX_THINKING_TOKENS'), /secret/)
  for (const n of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY_HELPER', 'DISABLE_SECRET_X', 'CLAUDE_CODE_PASSWORD', 'CLAUDE_CODE_CREDENTIALS', 'CLAUDE_CODE_AUTH_X', 'DISABLE_KEYCHAIN'])
    assert.match(cm.envNameProblem(n), /secret/, n)
  for (const n of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'PATH', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'HTTPS_PROXY'])
    assert.match(cm.envNameProblem(n), /allow list/, n)
  for (const n of ['DISABLE_AUTOUPDATER', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'])
    assert.match(cm.envNameProblem(n), /Corvid sets itself/, n)
  for (const n of ['api_timeout_ms', '1ABC', 'A-B', '']) assert.match(cm.envNameProblem(n), /upper-case/, n)
  assert.match(problem({ env: { ANTHROPIC_API_KEY: 'x' } }), /secret/)
  assert.match(problem({ env: { API_TIMEOUT_MS: 600000 } }), /plain text/)
  assert.match(problem({ env: { API_TIMEOUT_MS: 'a\nb' } }), /plain text/)
  assert.match(problem({ env: { API_TIMEOUT_MS: 'x'.repeat(501) } }), /plain text/)
  assert.match(problem({ env: ['API_TIMEOUT_MS'] }), /env must be/)
})

test('custom:<id> refs: well formed whether or not the entry exists', () => {
  assert.equal(cm.isCustomModelRef('custom:qwen-local'), true)
  for (const v of ['custom:', 'custom:Qwen', 'custom:haiku', 'custom:default', 'qwen-local', 'Custom:qwen', 'custom:a b', 7, undefined])
    assert.equal(cm.isCustomModelRef(v), false, String(v))
  assert.equal(cm.customModelRef('qwen-local'), 'custom:qwen-local')
  assert.equal(cm.customModelId('custom:qwen-local'), 'qwen-local')
  assert.equal(cm.findCustomModel([qwen()], 'custom:qwen-local').label, 'Qwen 27B (local)')
  assert.equal(cm.findCustomModel([qwen()], 'custom:gone'), undefined)
  assert.equal(cm.findCustomModel(undefined, 'custom:qwen-local'), undefined)
})

// ---------- config.json ----------

/** An older config.json: no models key, a Claude worker model. */
const OLD_CONFIG = { assistantModel: 'sonnet', workerModel: 'opus', workerEffort: 'high', boardVoice: 'crow', usagePollSec: 300 }

test('an older config.json loads and saves unchanged: no models key, nothing repaired', async () => {
  const c = await load(OLD_CONFIG)
  const cfg = c.getConfig()
  assert.equal('models' in cfg, false)
  assert.equal(cfg.assistantModel, 'sonnet')
  assert.equal(cfg.workerModel, 'opus')
  assert.deepEqual(c.configRepairs(), [])
  c.setConfig({ ticker: false })
  assert.equal('models' in savedConfig(), false, 'saving adds no models key')
  assert.equal(savedConfig().workerModel, 'opus')
})

test('bad entries are dropped with a notice each; good ones stay as they are', async () => {
  const good = qwen()
  const other = qwen({ id: 'llama', label: 'Llama', baseUrl: 'http://127.0.0.1:9000', env: undefined })
  delete other.env
  const c = await load({
    ...OLD_CONFIG,
    models: [
      good,
      qwen({ label: 'Twin' }),
      qwen({ id: 'opus', label: 'Fake Opus' }),
      qwen({ id: 'lan', label: 'GPU box', baseUrl: 'http://192.168.1.20:8080' }),
      qwen({ id: 'creds', label: 'With creds', baseUrl: 'http://me:pw@localhost:8080' }),
      qwen({ id: 'tiny', label: 'Tiny', contextTokens: 4096 }),
      qwen({ id: 'many', label: 'Many', maxRunning: HARD_MAX_WORKERS + 1 }),
      qwen({ id: 'keyed', label: 'Keyed', auth: { kind: 'secret', secretRef: 'k1' } }),
      qwen({ id: 'envkey', label: 'Env key', env: { ANTHROPIC_API_KEY: 'sk-test' } }),
      qwen({ id: 'envpath', label: 'Env path', env: { PATH: 'c:\\x' } }),
      'nonsense',
      other
    ]
  })
  const cfg = c.getConfig()
  assert.deepEqual(cfg.models, [good, other])
  const r = c.configRepairs()
  assert.equal(r.length, 10, r.join('\n'))
  assert.match(r[0], /"Twin" \("qwen-local"\) was dropped: another entry already has the id/)
  assert.match(r[1], /"Fake Opus" \("opus"\) was dropped: the id "opus" is reserved/)
  assert.match(r[2], /"GPU box".*not on this computer/)
  assert.match(r[3], /"With creds".*user name or password/)
  assert.match(r[4], /"Tiny".*context/)
  assert.match(r[5], /"Many".*sessions at once/)
  assert.match(r[6], /"Keyed".*auth kind/)
  assert.match(r[7], /"Env key".*secret/)
  assert.match(r[8], /"Env path".*allow list/)
  assert.match(r[9], /number 11 was dropped: it isn't an entry/)
  assert.equal(r.join(' ').includes('sk-test'), false, 'a notice never repeats an env value')
  c.setConfig({})
  assert.deepEqual(savedConfig().models, [good, other], 'only the good entries are saved')
})

test('a models value that is not a list becomes an empty list, with a notice', async () => {
  const c = await load({ ...OLD_CONFIG, models: { id: 'x' } })
  assert.deepEqual(c.getConfig().models, [])
  assert.match(c.configRepairs()[0], /wasn't a list/)
})

test('setConfig never saves a bad entry', async () => {
  const c = await load(OLD_CONFIG)
  c.setConfig({ models: [qwen(), qwen({ id: 'pub', baseUrl: 'https://api.example.com' })] })
  assert.deepEqual(savedConfig().models.map((m) => m.id), ['qwen-local'])
})

test('custom:<id> survives load and save in workerModel and assistantModel, with its entry gone', async () => {
  const c = await load({ ...OLD_CONFIG, workerModel: 'custom:qwen-local', assistantModel: 'custom:gone', models: [] })
  assert.equal(c.getConfig().workerModel, 'custom:qwen-local')
  assert.equal(c.getConfig().assistantModel, 'custom:gone')
  assert.deepEqual(c.configRepairs(), [])
  c.setConfig({ ticker: true })
  assert.equal(savedConfig().workerModel, 'custom:qwen-local')
  assert.equal(savedConfig().assistantModel, 'custom:gone')
  const again = await load(savedConfig())
  assert.equal(again.getConfig().workerModel, 'custom:qwen-local')
  // no models key at all: still kept
  const none = await load({ ...OLD_CONFIG, workerModel: 'custom:qwen-local' })
  assert.equal(none.getConfig().workerModel, 'custom:qwen-local')
})

test('a malformed custom value is still repaired, as any unknown model is', async () => {
  const c = await load({ ...OLD_CONFIG, workerModel: 'custom:Not Valid', assistantModel: 'custom:haiku' })
  assert.equal(c.getConfig().workerModel, 'default')
  assert.equal(c.getConfig().assistantModel, 'haiku')
  assert.equal(c.configRepairs().length, 2)
})

// ---------- tasks.json ----------

test('tasks.json: an older file loads and saves unchanged, and custom:<id> stays with its entry gone', async () => {
  const file = join(globalThis.__userData, 'tasks.json')
  const old = [
    { id: 1, title: 'old', notes: '', column: 'backlog', order: 1, createdAt: 1, updatedAt: 1 },
    { id: 2, title: 'on opus', notes: '', column: 'next', order: 1, model: 'opus', createdAt: 1, updatedAt: 1 }
  ]
  const custom = [
    { id: 3, title: 'local', notes: '', column: 'next', order: 2, model: 'custom:qwen-local', createdAt: 1, updatedAt: 1 },
    { id: 4, title: 'bad custom', notes: '', column: 'next', order: 3, model: 'custom:NOPE', createdAt: 1, updatedAt: 1 }
  ]
  writeFileSync(file, JSON.stringify({ nextId: 5, tasks: [...old, ...custom] }))
  const tasks = await import(src + 'main/tasks.ts')
  // the entries in Settings → Models, as index.ts passes them (#316): none at first, so qwen-local's entry is gone
  let entries = []
  tasks.initTasks(() => {}, { resolve: () => undefined, forPath: () => undefined, folder: () => undefined, models: () => entries })
  const get = (id) => tasks.listTasks().find((t) => t.id === id)
  assert.deepEqual(get(1), old[0])
  assert.deepEqual(get(2), old[1])
  assert.equal(get(3).model, 'custom:qwen-local')
  assert.equal('model' in get(4), false, 'a malformed one still means "follow Settings"')

  // a save (any change) writes the older tasks back as they were, and keeps the custom model
  tasks.updateTask(3, { title: 'local, renamed' })
  let saved = JSON.parse(readFileSync(file, 'utf8')).tasks
  assert.deepEqual(saved.find((t) => t.id === 1), old[0])
  assert.deepEqual(saved.find((t) => t.id === 2), old[1])
  assert.equal(saved.find((t) => t.id === 3).model, 'custom:qwen-local')

  // the editor sends the task's model back with every save: that keeps it
  tasks.updateTask(3, { model: 'custom:qwen-local', notes: 'edited' })
  assert.equal(get(3).model, 'custom:qwen-local')
  // a task goes on a custom model only for an entry that exists (#316), from the editor or create_task/update_task
  assert.throws(() => tasks.updateTask(1, { model: 'custom:qwen-local' }), /no model "qwen-local" in Settings → Models/)
  assert.throws(() => tasks.createTask({ title: 'new', model: 'custom:qwen-local' }), /no model "qwen-local"/)
  entries = [{ id: 'qwen-local', label: 'Qwen', kind: 'anthropic', baseUrl: 'http://localhost:8080', model: 'q', contextTokens: 32768 }]
  assert.throws(() => tasks.createTask({ title: 'new', model: 'custom:other' }), /custom:qwen-local \(Qwen\)/, 'the refusal lists the entries')
  const onQwen = tasks.createTask({ title: 'new on qwen', model: 'custom:qwen-local' })
  assert.equal(onQwen.model, 'custom:qwen-local')
  tasks.updateTask(onQwen.id, { model: 'default' })
  assert.equal('model' in get(onQwen.id), false)
  tasks.updateTask(onQwen.id, { model: 'custom:qwen-local' })
  assert.equal(get(onQwen.id).model, 'custom:qwen-local')
  tasks.removeTask(onQwen.id)
  entries = []
  // a Claude model replaces it, and Undo brings a removed one back on its custom model
  const removed = tasks.removeTask(3)
  const back = tasks.createTask({ ...removed })
  assert.equal(back.model, 'custom:qwen-local')
  tasks.updateTask(3, { model: 'sonnet' })
  assert.equal(get(3).model, 'sonnet')
  saved = JSON.parse(readFileSync(file, 'utf8')).tasks
  assert.equal(saved.find((t) => t.id === 3).model, 'sonnet')
})

test("Set up's folder: the common parent of the projects and their worktree roots (#316)", async () => {
  const { setupFolder } = await import(src + 'main/customSetup.ts')
  // Windows paths, written with / here
  const w = (x) => x.replaceAll('/', String.fromCharCode(92))
  const win = (folders) => setupFolder(folders.map(w), 'win32')
  assert.equal(setupFolder([], 'win32'), null)
  // one project: its parent holds both it and <it>-worktrees
  assert.deepEqual(win(['D:/projects/dashboard']), { folder: w('D:/projects'), left: [] })
  assert.deepEqual(win(['D:/projects/a', 'D:/projects/games/b', 'd:/Projects/c']), { folder: w('D:/projects'), left: [] })
  assert.deepEqual(win(['D:/work/a', 'D:/play/b']), { folder: w('D:/'), left: [] })
  // another drive has no common parent: the drive with the most projects wins, and the rest are named
  assert.deepEqual(win(['D:/p/a', 'D:/p/b', 'C:/Users/me/x']), { folder: w('D:/p'), left: [w('C:/Users/me/x')] })
  assert.deepEqual(setupFolder(['/home/me/code/a', '/home/me/code/b/c'], 'linux'), { folder: '/home/me/code', left: [] })
  assert.deepEqual(setupFolder(['/home/me/a'], 'linux'), { folder: '/home/me', left: [] })
})
