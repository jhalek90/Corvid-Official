// Tests for #238, the reasoning effort Corvid and new workers run at: config.json loading each level, an invalid value
// and a missing key (back to Claude Code's default, with a repair notice only for the invalid one); setConfig refusing
// an invalid value; the --model/--effort part of the command line; and the arguments a worker is really launched with,
// with and without an effort set. The assistant's launch is checked through the same launchArgs it calls, never by
// starting a Claude session. Stand-ins for electron, the terminals and git, like test-usage-limit.mjs.
// Also #306, the worker permission mode: no --permission-mode for Claude Code default, acceptEdits for accept edits,
// an invalid or bypass value back to the default, and only workers get it.
// Also #314, workers on the user's own models: the exact env, unset list and args customLaunch gives them, no login or
// key reaching them, never --effort or acceptEdits, and Claude workers launched exactly as before.
// Also #320, Corvid itself on one of the user's own models: its args and env through the same customLaunch (no --effort),
// only entries of 64k context and up, and the mode forced to ask while it runs there.
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
// what each worker was launched with: launchWorker's extra claude arguments, and its environment change (#314)
globalThis.__launches = []
globalThis.__envs = []
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
    export const launchWorker = (...a) => { globalThis.__launches.push(a[5]); globalThis.__envs.push({ n: a.length, env: a[7] }); return { termId: 't' + ++n } }
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
      // a ?query loads a fresh copy of a module (the config tests)
      return u.split('?')[0].endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const { setConfig } = await import('../src/main/config.ts')
const workers = await import('../src/main/workers.ts')
const { launchArgs } = await import('../src/shared/models.ts')
const { REASONING_EFFORTS, effortArgs } = await import('../src/shared/reasoningEffort.ts')
const { permissionArgs } = await import('../src/shared/permissionMode.ts')

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
  confirmOverLimit: async () => ({ ok: false, dontAsk: false, timedOut: false }),
  // the custom entries here point at localhost:8080, which may be the user's own server: never ask it (#315)
  modelHealth: async () => null
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
  assert.equal(c.getConfig().workerPermissionMode, 'default')
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

test('the worker permission mode loads as saved, and anything else (bypass too) goes back to the default', async () => {
  for (const m of ['default', 'acceptEdits']) {
    const c = await load({ workerPermissionMode: m })
    assert.equal(c.getConfig().workerPermissionMode, m)
    assert.deepEqual(c.configRepairs(), [])
  }
  for (const bad of ['bypassPermissions', 'auto', 'plan', 'ACCEPTEDITS', '', null, 1]) {
    const c = await load({ workerPermissionMode: bad })
    assert.equal(c.getConfig().workerPermissionMode, 'default', JSON.stringify(bad))
    assert.equal(c.configRepairs().length, 1, JSON.stringify(bad))
  }
  assert.equal(setConfig({ workerPermissionMode: 'acceptEdits' }).workerPermissionMode, 'acceptEdits')
  assert.equal(setConfig({ workerPermissionMode: 'bypassPermissions' }).workerPermissionMode, 'default')
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

test('permissionArgs: --permission-mode only for accept edits, never bypass', () => {
  for (const m of ['default', undefined, 'bypassPermissions', 'auto', 'nope']) assert.deepEqual(permissionArgs(m), [], String(m))
  assert.deepEqual(permissionArgs('acceptEdits'), ['--permission-mode', 'acceptEdits'])
  assert.deepEqual(launchArgs('default', 'default', 'default'), [])
  assert.deepEqual(launchArgs('sonnet', 'high', 'acceptEdits'), ['--model', 'sonnet', '--effort', 'high', '--permission-mode', 'acceptEdits'])
  assert.deepEqual(launchArgs('default', 'default', 'bypassPermissions'), [])
})

test("the assistant's launch passes its model and effort through launchArgs", () => {
  const read = (f) => readFileSync(join(import.meta.dirname, '..', 'src', 'main', f), 'utf8')
  // the model part of its command line comes from assistantLaunch.ts (#320), which calls launchArgs for Claude models
  const s = read('assistantLaunch.ts')
  assert.match(s, /launchArgs\(cfg\.assistantModel, cfg\.assistantEffort\)/)
  assert.match(read('assistant.ts'), /\.\.\.launch\.args,/)
  for (const f of ['assistant.ts', 'assistantLaunch.ts']) {
    assert.doesNotMatch(read(f), /'--effort'|'--model'/, `no second, hand-built --model or --effort in ${f}`)
    // Corvid's own session gets no permission mode: two arguments, and no --permission-mode of its own
    assert.doesNotMatch(read(f), /launchArgs\([^)]*,[^)]*,[^)]*\)|--permission-mode|PermissionMode/, f)
  }
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

test('a worker gets no --permission-mode by default, and acceptEdits once it is set', async () => {
  setConfig({ workerModel: 'default', workerEffort: 'default', workerPermissionMode: 'default' })
  let { args } = await launched()
  assert.ok(!args.includes('--permission-mode'), args.join(' '))
  setConfig({ workerPermissionMode: 'acceptEdits' })
  ;({ args } = await launched())
  assert.deepEqual(after(args, '--permission-mode', 2), ['--permission-mode', 'acceptEdits'])
  assert.equal(args.filter((a) => a === '--permission-mode').length, 1)
  // beside the model and effort, all from the one launchArgs
  setConfig({ workerModel: 'opus', workerEffort: 'low' })
  ;({ args } = await launched())
  assert.deepEqual(after(args, '--model', 6), ['--model', 'opus', '--effort', 'low', '--permission-mode', 'acceptEdits'])
  // a bypass value can't get in through setConfig either
  setConfig({ workerPermissionMode: 'bypassPermissions' })
  ;({ args } = await launched())
  assert.ok(!args.includes('--permission-mode'))
  assert.ok(!args.includes('bypassPermissions'))
  setConfig({ workerModel: 'default', workerEffort: 'default', workerPermissionMode: 'default' })
})

// ---------- custom models (#314) ----------

const { customLaunch, autoCompactPct, withEnv, CUSTOM_UNSET, DUMMY_TOKEN } = await import('../src/main/customLaunch.ts')
const { customClaudeDir } = await import('../src/main/platform/paths.ts')
const { denyPatterns } = await import('../src/main/agentDeny.ts')

const qwen = { id: 'qwen-local', label: 'Qwen 27B (local)', kind: 'anthropic', baseUrl: 'http://localhost:8080', model: 'qwen-local', contextTokens: 32768 }
const configDir = customClaudeDir('data')
const KEY_LIKE = /API_KEY|OAUTH|IDENTITY_TOKEN|BEARER|CUSTOM_HEADERS|FILE_DESCRIPTOR/

test('customLaunch: the exact env, unset list and args for an entry', () => {
  const l = customLaunch(qwen, configDir)
  assert.deepEqual(l.env, {
    ANTHROPIC_BASE_URL: 'http://localhost:8080',
    ANTHROPIC_AUTH_TOKEN: DUMMY_TOKEN,
    ANTHROPIC_MODEL: 'qwen-local',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen-local',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen-local',
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'qwen-local',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen-local',
    ANTHROPIC_SMALL_FAST_MODEL: 'qwen-local',
    CLAUDE_CODE_SUBAGENT_MODEL: 'qwen-local',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
    CLAUDE_CONFIG_DIR: configDir,
    // 80% of (32768 - 4096), as a share of the 200k window Claude Code assumes: 11%, about 22k tokens
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '11'
  })
  assert.equal(DUMMY_TOKEN, 'corvid-no-key')
  assert.deepEqual(l.args, ['--model', 'qwen-local'])
  for (const n of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDECODE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])
    assert.ok(l.unset.includes(n), n)
  for (const n of Object.keys(l.env)) assert.doesNotMatch(n, KEY_LIKE, n)
})

test("customLaunch: the small model, max output, the entry's env, and what that env can't touch", () => {
  const env = { API_TIMEOUT_MS: '600000', CLAUDE_CODE_USE_MANTLE: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }
  const l = customLaunch({ ...qwen, smallModel: 'qwen-small', maxOutputTokens: 8192, env }, configDir)
  assert.equal(l.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwen-small')
  assert.equal(l.env.ANTHROPIC_SMALL_FAST_MODEL, 'qwen-small')
  assert.equal(l.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'qwen-local')
  assert.equal(l.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8192')
  assert.equal(l.env.API_TIMEOUT_MS, '600000')
  // a provider switch or a name Corvid sets never comes in through the entry's env
  assert.equal(l.env.CLAUDE_CODE_USE_MANTLE, undefined)
  assert.equal(l.env.CLAUDE_CODE_SUBAGENT_MODEL, 'qwen-local')
})

test('autoCompactPct: from the context, and left out where Claude Code compacts early enough itself', () => {
  assert.equal(autoCompactPct(qwen), 11)
  assert.equal(autoCompactPct({ ...qwen, contextTokens: 8192 }), 1)
  assert.equal(autoCompactPct({ ...qwen, contextTokens: 131072 }), 50)
  assert.equal(autoCompactPct({ ...qwen, contextTokens: 262144 }), undefined)
  assert.equal(customLaunch({ ...qwen, contextTokens: 262144 }, configDir).env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined)
})

test('withEnv takes out every login and switch in any case, and sets the rest', () => {
  const l = customLaunch(qwen, configDir)
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', claude_code_oauth_token: 't', Anthropic_Base_Url: 'https://api.example', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/home/x/.claude' }
  const env = withEnv(base, l)
  assert.deepEqual(env, { PATH: '/bin', ...l.env })
  for (const n of CUSTOM_UNSET) assert.ok(!Object.keys(env).some((k) => k.toUpperCase() === n), n)
})

test('the custom config folder sits outside the data folder on every platform', () => {
  assert.equal(customClaudeDir('Corvid', 'win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'C:\\Users\\x'), 'C:\\Users\\x\\AppData\\Local\\Corvid\\claude-custom')
  assert.equal(customClaudeDir('Corvid', 'win32', {}, 'C:\\Users\\x'), 'C:\\Users\\x\\AppData\\Local\\Corvid\\claude-custom')
  assert.equal(customClaudeDir('Corvid', 'darwin', {}, '/Users/x'), '/Users/x/Library/Application Support/Corvid-claude-custom')
  assert.equal(customClaudeDir('Corvid', 'linux', {}, '/home/x'), '/home/x/.local/state/Corvid/claude-custom')
  assert.equal(customClaudeDir('Corvid', 'linux', { XDG_STATE_HOME: '/s' }, '/home/x'), '/s/Corvid/claude-custom')
})

test("the custom folder's login file is denied once there are models, and only then", () => {
  const custom = (c) => denyPatterns(c).home.filter((p) => p.includes('claude-custom'))
  assert.deepEqual(custom({}), [])
  assert.deepEqual(custom({ models: [] }), [])
  const rule = custom({ models: [qwen] })
  assert.equal(rule.length, 1)
  assert.ok(rule[0].endsWith('/data/claude-custom/.credentials.json'), rule[0])
  assert.ok(rule[0].includes('/local/'), rule[0])
  // switching off the ~/.claude login default doesn't open it: it isn't the user's login
  assert.deepEqual(custom({ models: [qwen], agentDenyOff: ['~/.claude/.credentials.json'] }), rule)
})

const launchedWithEnv = async (taskModel) => {
  globalThis.__envs.length = 0
  const r = await launched(taskModel)
  return { ...r, env: globalThis.__envs[0].env }
}

test('a custom-model worker gets its env and --model, never --effort or --permission-mode, whatever Settings say', async () => {
  setConfig({ models: [qwen], workerModel: 'custom:qwen-local', workerEffort: 'high', workerPermissionMode: 'acceptEdits' })
  const { args, env, worker } = await launchedWithEnv()
  const l = customLaunch(qwen, configDir)
  assert.deepEqual(env, { env: l.env, unset: l.unset })
  assert.deepEqual(after(args, '--model', 2), ['--model', 'qwen-local'])
  assert.equal(args.filter((a) => a === '--model').length, 1)
  for (const flag of ['--effort', '--permission-mode', 'acceptEdits', 'high']) assert.ok(!args.includes(flag), `${flag} in ${args.join(' ')}`)
  assert.equal(worker.model, 'custom:qwen-local')
  assert.equal(worker.effort, undefined)
  assert.equal(env.env.CLAUDE_CONFIG_DIR, configDir)
  for (const n of Object.keys(env.env)) assert.doesNotMatch(n, KEY_LIKE, n)
  setConfig({ workerModel: 'default', workerEffort: 'default', workerPermissionMode: 'default' })
})

test("a task's own custom model beats Settings, and a task's Claude model beats a custom worker model", async () => {
  setConfig({ models: [qwen], workerModel: 'sonnet' })
  let { args, env } = await launchedWithEnv('custom:qwen-local')
  assert.deepEqual(after(args, '--model', 2), ['--model', 'qwen-local'])
  assert.equal(env.env.ANTHROPIC_BASE_URL, 'http://localhost:8080')
  setConfig({ workerModel: 'custom:qwen-local' })
  ;({ args, env } = await launchedWithEnv('opus'))
  assert.deepEqual(after(args, '--model', 2), ['--model', 'opus'])
  assert.equal(env, undefined)
  setConfig({ workerModel: 'default' })
})

test('a custom model whose entry is gone starts nothing and never falls back to Claude', async () => {
  setConfig({ models: [], workerModel: 'default' })
  globalThis.__launches.length = 0
  const r = await workers.startWorker(newTask('custom:qwen-local'))
  assert.equal(r.worker, undefined)
  assert.match(r.error, /"qwen-local" isn't in Settings → Models/)
  assert.equal(globalThis.__launches.length, 0)
})

test('Claude workers are launched exactly as before, with custom models configured or not', async () => {
  const combos = [
    ['default', 'default', 'default', undefined],
    ['sonnet', 'high', 'acceptEdits', undefined],
    ['default', 'low', 'default', 'opus']
  ]
  for (const [workerModel, workerEffort, workerPermissionMode, taskModel] of combos) {
    setConfig({ models: [], workerModel, workerEffort, workerPermissionMode })
    const before = await launchedWithEnv(taskModel)
    setConfig({ models: [qwen] })
    const now = await launchedWithEnv(taskModel)
    assert.deepEqual(now.args, before.args)
    // no environment change: pty.spawn builds the same environment it always has
    assert.equal(before.env, undefined)
    assert.equal(now.env, undefined)
  }
  setConfig({ models: [], workerModel: 'default', workerEffort: 'default', workerPermissionMode: 'default' })
})

test("pty: a Claude worker's environment is built as before, and only a custom one goes through withEnv", () => {
  const s = readFileSync(join(import.meta.dirname, '..', 'src', 'main', 'pty.ts'), 'utf8')
  assert.match(s, /const env = \{ \.\.\.process\.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', DASHBOARD_PTY: '1' \}/)
  assert.match(s, /env: \(change \? withEnv\(env, change\) : env\) as Record<string, string>/)
})

// ---------- #318: the lean profile's Claude Code flags and the start-up size check ----------

const { LEAN_CLI_FLAGS } = await import('../src/shared/leanProfile.ts')

test('a lean custom worker gets the lean flags after its model; a full one and Claude workers never do', async () => {
  setConfig({ models: [qwen], workerModel: 'default' })
  let { args } = await launched('custom:qwen-local')
  assert.deepEqual(after(args, '--model', 2 + LEAN_CLI_FLAGS.length), ['--model', 'qwen-local', ...LEAN_CLI_FLAGS])
  setConfig({ models: [{ ...qwen, profile: 'full' }] })
  ;({ args } = await launched('custom:qwen-local'))
  assert.deepEqual(args, ['--model', 'qwen-local'])
  setConfig({ models: [{ ...qwen, contextTokens: 131072 }] })
  ;({ args } = await launched('custom:qwen-local'))
  assert.deepEqual(args, ['--model', 'qwen-local'], '100k and up is full unless the entry says lean')
  for (const m of ['opus', undefined]) {
    ;({ args } = await launched(m))
    for (const f of LEAN_CLI_FLAGS) assert.ok(!args.includes(f), `${f} for ${m ?? 'default'}`)
  }
  setConfig({ models: [], workerModel: 'default' })
})

test('a custom worker too big for its context starts nothing, and says why', async () => {
  setConfig({ models: [{ ...qwen, contextTokens: 8192 }], workerModel: 'default' })
  globalThis.__launches.length = 0
  const r = await workers.startWorker(newTask('custom:qwen-local'))
  assert.equal(r.worker, undefined)
  assert.match(r.error, /^No agent started for #\d+: Qwen 27B \(local\) has a context of 8,192 tokens, and a worker on #\d+ needs about [\d,]+ just to start plus 4,096 for its answers/)
  assert.equal(globalThis.__launches.length, 0)
  assert.equal(workers.customRunning('custom:qwen-local'), 0, 'nothing left counted on its cap')
  setConfig({ models: [], workerModel: 'default' })
})

// ---------- Corvid itself on a custom model (#320) ----------

const { assistantLaunch } = await import('../src/main/assistantLaunch.ts')
const { ASSISTANT_MIN_CONTEXT, assistantModelProblem, effectiveAssistantMode } = await import('../src/shared/customModels.ts')

const big = { ...qwen, id: 'qwen-big', label: 'Qwen 27B (64k)', model: 'qwen-big', contextTokens: 65536 }
const loginEnv = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'https://api.example' }

test("Corvid on a Claude model: launchArgs and the environment without an API key, as before", () => {
  const l = assistantLaunch({ assistantModel: 'sonnet', assistantEffort: 'high', models: [big] }, loginEnv, configDir)
  assert.deepEqual(l.args, launchArgs('sonnet', 'high'))
  assert.deepEqual(l.args, ['--model', 'sonnet', '--effort', 'high'])
  const { ANTHROPIC_API_KEY: _k, ...rest } = loginEnv
  assert.deepEqual(l.env, rest)
  assert.equal(l.custom, undefined)
})

test("Corvid on a custom model: the same customLaunch env and args as a worker, and never --effort", () => {
  const l = assistantLaunch({ assistantModel: 'custom:qwen-big', assistantEffort: 'high', models: [qwen, big] }, loginEnv, configDir)
  const c = customLaunch(big, configDir)
  assert.deepEqual(l.args, c.args)
  assert.deepEqual(l.args, ['--model', 'qwen-big'])
  assert.ok(!l.args.includes('--effort') && !l.args.includes('high'), l.args.join(' '))
  assert.deepEqual(l.env, withEnv(loginEnv, c))
  assert.deepEqual(l.env, { PATH: '/bin', ...c.env })
  assert.equal(l.env.ANTHROPIC_BASE_URL, 'http://localhost:8080')
  assert.equal(l.env.ANTHROPIC_AUTH_TOKEN, DUMMY_TOKEN)
  assert.equal(l.env.CLAUDE_CONFIG_DIR, configDir)
  for (const n of CUSTOM_UNSET) assert.ok(!(n in l.env), n)
  for (const n of Object.keys(l.env)) assert.doesNotMatch(n, KEY_LIKE, n)
  assert.equal(l.custom, big)
})

test('Corvid only runs on entries of 64k context and up, and never on one that is gone', () => {
  assert.equal(ASSISTANT_MIN_CONTEXT, 64_000)
  assert.equal(assistantModelProblem([big], 'custom:qwen-big'), null)
  assert.equal(assistantModelProblem([{ ...big, contextTokens: 64_000 }], 'custom:qwen-big'), null)
  assert.match(assistantModelProblem([qwen], 'custom:qwen-local'), /^Qwen 27B \(local\) has a context of 32,768 tokens; Corvid itself needs one of 64,000 or more\./)
  assert.match(assistantModelProblem([qwen], 'custom:gone'), /There's no model "gone"/)
  for (const [models, ref] of [[[qwen], 'custom:qwen-local'], [[], 'custom:qwen-big'], [undefined, 'custom:qwen-big']]) {
    const l = assistantLaunch({ assistantModel: ref, assistantEffort: 'default', models }, loginEnv, configDir)
    assert.ok('problem' in l && !('args' in l), `${ref} starts nothing`)
  }
})

test('the mode is ask while Corvid is on a custom model, and the saved mode otherwise', () => {
  assert.equal(effectiveAssistantMode({ assistantMode: 'auto', assistantModel: 'custom:qwen-big' }), 'ask')
  assert.equal(effectiveAssistantMode({ assistantMode: 'ask', assistantModel: 'custom:qwen-big' }), 'ask')
  assert.equal(effectiveAssistantMode({ assistantMode: 'auto', assistantModel: 'haiku' }), 'auto')
  assert.equal(effectiveAssistantMode({ assistantMode: 'ask', assistantModel: 'opus' }), 'ask')
})

test("start_worker only proposes while Corvid runs on a custom model, even in Auto, and the saved mode isn't changed", async () => {
  setConfig({ models: [big], workerModel: 'default', assistantMode: 'auto', assistantModel: 'custom:qwen-big' })
  globalThis.__launches.length = 0
  const id = newTask()
  const r = await workers.requestWorker(id)
  assert.equal(r.worker, undefined)
  assert.equal(r.proposal?.taskId, id)
  assert.equal(globalThis.__launches.length, 0, 'nothing launched')
  // an automatic start after a blocker is done goes the same way
  const id2 = newTask()
  const a = await workers.autoStartWorker(id2)
  assert.equal(a.action, 'propose')
  assert.equal(globalThis.__launches.length, 0)
  const { getConfig } = await import('../src/main/config.ts')
  assert.equal(getConfig().assistantMode, 'auto', 'the saved mode stays as the user set it')
  for (const p of [...workers.listProposals()]) workers.reject(p.id)
  // back on a Claude model, Auto starts again
  setConfig({ assistantModel: 'haiku' })
  const s = await workers.requestWorker(newTask())
  assert.ok(s.worker, s.error)
  workers.stopAll('test')
  setConfig({ models: [], assistantMode: 'ask' })
})

test("Corvid's start checks its custom model's server and cap first, and only the user's click switches to Haiku", () => {
  const read = (f) => readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8')
  const a = read('main/assistant.ts')
  // the order inside start(): the launch, then the cap and the health check, before anything is spawned
  const start = a.slice(a.indexOf('async function start()'), a.indexOf('let streamMsgId'))
  const at = (re) => start.search(re)
  assert.ok(at(/assistantLaunch\(cfg, process\.env, customConfigDir\(\)\)/) > 0)
  assert.ok(at(/workers\.customRunning\(cfg\.assistantModel\)/) > at(/assistantLaunch\(/))
  assert.ok(at(/await checkCustomModel\(m\)/) > at(/customRunning/))
  assert.ok(at(/spawn\(bin\.path, args, \{ cwd: assistantDir\(\), env: launch\.env/) > at(/checkCustomModel/))
  // nothing in main ever sets Corvid's model on its own: the Haiku button is in the strip, on the user's click
  assert.doesNotMatch(a, /assistantModel: 'haiku'/)
  const strip = read('renderer/src/components/Assistant.tsx')
  assert.match(strip, /onClick=\{\(\) => void api\.setConfig\(\{ assistantModel: 'haiku' \}\)\}[^>]*>\s*Run Corvid on Haiku instead/)
})
