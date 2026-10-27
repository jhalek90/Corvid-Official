// Tests for #102, extension sockets: each socket registers and unregisters; a sample extension, written by hand here
// and never shipped, adds a slash command, worker tools, an instruction line, a connector, a settings section and a
// page, and all of it goes when its flag is off or it is gone from the index; a throwing extension and one for a newer
// socket API are skipped, logged and reported; extension tools are scoped, masked, audited and not pre-approved
// unless read-only; a connector only ever becomes a draft for review; and the mechanical tier-1 diff check. Runs on
// Node 24's own TypeScript support with a stand-in for electron, like test-drafts.mjs.
//
//   npm run test-sockets

import { register } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-sockets-'))
globalThis.__userData = join(tmp, 'data')
const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent(\`
      const x = (b) => Buffer.from(b.map((c) => c ^ 0x5a))
      export const app = { getPath: () => globalThis.__userData }
      export const safeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret', // read on Linux only: a real keyring, so platform/keyring.ts lets secrets be saved
        encryptString: (s) => x([...Buffer.from('fake-dpapi:' + s)]),
        decryptString: (b) => { const s = x([...b]).toString(); if (!s.startsWith('fake-dpapi:')) throw new Error('bad'); return s.slice(11) }
      }\`)
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
after(() => rmSync(tmp, { recursive: true, force: true }))

const { createRegistry } = await import(src + 'extensions/sockets/registry.ts')
const { EXTENSION_API_VERSION, headerProblem } = await import(src + 'extensions/sockets/load.ts')
const mainSockets = await import(src + 'extensions/sockets/main.ts')
const win = await import(src + 'extensions/sockets/window.ts')
const { loadExtensions } = await import(src + 'extensions/sockets/load.ts')
const { diffShape, isRegistrationLine } = await import(src + 'extensions/sockets/diffShape.ts')
const { SOCKET_BUILD_GUIDANCE } = await import(src + 'extensions/sockets/guidance.ts')
const remote = await import(src + 'main/remote/index.ts')
const store = await import(src + 'main/connectors/store.ts')
const connectors = await import(src + 'main/connectors/index.ts')
const drafts = await import(src + 'main/connectors/drafts.ts')
const host = await import(src + 'main/extensionSockets.ts')
const { runCommand } = await import(src + 'main/slashCommands.ts')
const { DASHBOARD_COMMANDS } = await import(src + 'shared/slashCommands.ts')

const CORVID = 'D:\\projects\\corvid-src'
const projectIdForPath = (p) => (p === CORVID ? 'corvid' : undefined)
remote.initRemote({ changed: () => {}, approvalRequested: () => {} })
store.initConnectorStore({ projectIdForPath, remoteSystems: () => [], remoteSecret: () => undefined })
connectors.initConnectors({ projectIdForPath, changed: () => {} })
const arrived = []
drafts.initDrafts({ projectIdForPath, projectName: () => 'Corvid', enabled: () => true, arrived: (a) => arrived.push(a), changed: () => {} })

const manifest = {
  manifestVersion: 1,
  id: 'sample-weather',
  name: 'Sample weather',
  version: '1.0.0',
  description: 'Reads a forecast from a sample API.',
  runtime: 'http',
  config: [],
  secrets: [],
  capabilities: {
    targets: [{ host: 'api.sample-weather.com', ports: [443], scheme: 'https' }],
    operations: [{ name: 'forecast', description: 'Get the forecast', class: 'read', method: 'GET', path: '/v1/forecast' }]
  },
  limits: { timeoutMs: 5000, maxResponseBytes: 65536, ratePerMinute: 30 },
  tests: [{ name: 'forecast', operation: 'forecast', expect: { ok: true, contains: 'days' }, mock: { status: 200, body: { days: [] } } }]
}

// a made-up value shaped like an API key, for the masking check (secret-scan: allow)
const FAKE_KEY = 'sk-ant-api03-SampleFakeKeyForSocketTests0000' // secret-scan: allow

// ---------- the sample extension, by hand ----------

const sampleMain = {
  id: 'sample-ext',
  name: 'Sample extension',
  api: 1,
  register(s) {
    s.command({ name: 'sample-hello', description: 'Says hello', run: (args) => `Hello, ${args || 'you'}.` })
    s.tool({ name: 'where', description: 'Says where it runs', input: {}, readOnly: true, run: (args, ctx) => ({ args, ctx, keys: Object.keys(ctx) }) })
    s.tool({ name: 'leak', description: 'Tries to return a secret', input: {}, run: () => `the key is ${FAKE_KEY} and token=hunter2hunter2` })
    s.instruction({ id: 'hint', text: 'Sample extension: say hello on the board.' })
    s.connector({ manifest, reason: 'The sample shows the weather.' })
  }
}
const sampleWindow = {
  id: 'sample-ext',
  name: 'Sample extension',
  api: 1,
  register(s) {
    s.settingsSection({ id: 'options', title: 'Sample options', Component: () => null })
    s.page({ id: 'home', title: 'Sample', Component: () => null })
  }
}

const notices = []
const deps = (enabled = () => true) => ({
  enabled,
  notice: (t) => notices.push(t),
  takenCommands: () => DASHBOARD_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
  corvidFolder: () => CORVID
})
const access = () => host.extensionWorkerAccess({ project: 'D:\\work\\shop', agent: 'worker #7', taskId: 7 })
const tool = (name) => access().tools.find((t) => t.name === name)
const crashLog = () => (existsSync(join(globalThis.__userData, 'crash.log')) ? readFileSync(join(globalThis.__userData, 'crash.log'), 'utf8') : '')

// ---------- registries ----------

test('a registry adds, refuses a taken key, unregisters, and removes by owner', () => {
  const r = createRegistry('Thing', (x) => x.k)
  const off = r.add('a', { k: 'one' })
  r.add('a', { k: 'two' })
  r.add('b', { k: 'three' })
  assert.throws(() => r.add('b', { k: 'one' }), /already registered by a/)
  off()
  assert.deepEqual(r.list().map((e) => e.item.k), ['two', 'three'])
  r.removeOwner('a')
  assert.deepEqual(r.list().map((e) => e.owner), ['b'])
})

test('each main socket registers and its returned function unregisters', () => {
  mainSockets.clearMainSockets()
  const s = mainSockets.mainHost.socketsFor('demo-one')
  const offs = [
    s.command({ name: 'demo-cmd', description: 'Demo', run: () => 'ok' }),
    s.tool({ name: 'demo_tool', description: 'Demo', input: {}, run: () => 1 }),
    s.instruction({ id: 'line', text: 'A line.' }),
    s.connector({ manifest: { id: 'x' }, reason: 'Demo.' })
  ]
  assert.deepEqual(mainSockets.mainSocketCounts('demo-one'), { commands: 1, tools: 1, instructions: 1, connectors: 1 })
  for (const off of offs) off()
  assert.deepEqual(mainSockets.mainSocketCounts('demo-one'), { commands: 0, tools: 0, instructions: 0, connectors: 0 })
})

test('each window socket registers and its returned function unregisters', () => {
  win.clearWindowSockets()
  const s = win.windowHost.socketsFor('demo-one')
  const a = s.settingsSection({ id: 'opts', title: 'Demo', Component: () => null })
  const b = s.page({ id: 'home', title: 'Demo', Component: () => null })
  assert.equal(win.settingsSections().length, 1)
  assert.equal(win.extensionPages().length, 1)
  a()
  b()
  assert.equal(win.settingsSections().length + win.extensionPages().length, 0)
})

test('sockets refuse bad shapes in plain words', () => {
  mainSockets.clearMainSockets()
  const s = mainSockets.mainHost.socketsFor('demo-two')
  mainSockets.setTakenCommands(() => ['clear', 'new'])
  assert.throws(() => s.command({ name: 'clear', description: 'x', run: () => '' }), /already a command/)
  assert.throws(() => s.command({ name: 'Bad Name', description: 'x', run: () => '' }), /lowercase/)
  assert.throws(() => s.tool({ name: 'x', description: 'x', input: {}, run: () => 1 }), /2 to 32/)
  assert.throws(() => s.instruction({ id: 'l', text: 'two\nlines' }), /one line/)
  assert.throws(() => s.instruction({ id: 'l', text: 'x'.repeat(301) }), /300/)
  assert.throws(() => s.connector({ manifest: null, reason: 'x' }), /manifest object/)
  const w = win.windowHost.socketsFor('demo-two')
  assert.throws(() => w.page({ id: 'p', title: 'x'.repeat(31), Component: () => null }), /30 characters/)
})

// ---------- loading ----------

test('the header check: ids, names and the API version', () => {
  assert.equal(EXTENSION_API_VERSION, 1)
  assert.equal(headerProblem({ id: 'ok-ext', name: 'Ok', api: 1 }), null)
  assert.match(headerProblem({ id: 'Bad_Id', name: 'x', api: 1 }), /lowercase/)
  assert.match(headerProblem({ id: 'sockets', name: 'x', api: 1 }), /reserved/)
  assert.match(headerProblem({ id: 'ok-ext', name: 'x' }), /declare the socket API/)
  assert.match(headerProblem({ id: 'ok-ext', name: 'x', api: 2 }), /needs socket API 2, and this Corvid offers 1/)
})

test('the sample extension adds a command, tools, an instruction and a connector draft in main', async () => {
  const r = host.loadMainExtensions(deps(), [sampleMain])
  assert.deepEqual(r.map((x) => [x.id, x.state, x.registered]), [['sample-ext', 'loaded', 5]])
  assert.deepEqual(mainSockets.extensionCommands().map((c) => c.name), ['sample-hello'])
  assert.equal(await mainSockets.runExtensionCommand('sample-hello', 'Robin'), 'Hello, Robin.')
  const a = access()
  assert.deepEqual(a.tools.map((t) => t.name).sort(), ['ext_sample_ext_leak', 'ext_sample_ext_where'])
  assert.match(a.prompt, /Sample extension: say hello on the board\./)
  assert.match(a.prompt, /mcp__corvid__ext_sample_ext_where/)
  // the connector is a draft waiting for review, filed under Corvid's project, never approved
  const d = drafts.draftsState().drafts.filter((x) => x.connectorId === 'sample-weather')
  assert.equal(d.length, 1)
  assert.equal(d[0].status, 'open')
  assert.equal(d[0].agent, 'extension sample-ext')
  assert.equal(store.connectorState('sample-weather'), undefined)
  assert.match(arrived.at(-1).text, /approves nothing/)
  // loading again doesn't propose the same version twice
  host.loadMainExtensions(deps(), [sampleMain])
  assert.equal(drafts.draftsState().drafts.filter((x) => x.connectorId === 'sample-weather').length, 1)
})

test('the sample extension adds a settings section and a page in the window', () => {
  win.clearWindowSockets()
  const r = loadExtensions([sampleWindow], win.windowHost, { enabled: () => true, log: () => {} })
  assert.equal(r[0].state, 'loaded')
  assert.deepEqual(win.settingsSections().map((s) => s.title), ['Sample options'])
  assert.deepEqual(win.extensionPages().map((s) => s.title), ['Sample'])
  win.clearWindowSockets()
  const off = loadExtensions([sampleWindow], win.windowHost, { enabled: () => false, log: () => {} })
  assert.equal(off[0].state, 'off')
  assert.equal(win.settingsSections().length + win.extensionPages().length, 0)
})

test('with its flag off, or gone from the index, nothing of the extension is registered', async () => {
  host.loadMainExtensions(deps((id) => id !== 'sample-ext'), [sampleMain])
  assert.equal(host.mainExtensionStates()[0].state, 'off')
  assert.deepEqual(mainSockets.extensionCommands(), [])
  assert.equal(access(), null)
  assert.equal(await mainSockets.runExtensionCommand('sample-hello', ''), null)
  host.loadMainExtensions(deps(), [])
  assert.deepEqual(host.mainExtensionStates(), [])
  assert.equal(access(), null)
  // a slash command typed after it went is a notice, not a crash
  const posted = []
  const cmd = { name: 'sample-hello', description: 'x', source: 'extension' }
  runCommand('/sample-hello', undefined, {
    list: () => ({ commands: [cmd], from: 'session' }),
    unavailable: () => undefined,
    post: (text) => ({ id: 1, text }),
    notice: (t) => posted.push(t),
    ask: () => assert.fail('an extension command never goes to Claude'),
    runExtension: mainSockets.runExtensionCommand
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.match(posted[0], /no longer available/)
})

test('a throwing extension is skipped and logged, what it registered is removed, and the rest still load', () => {
  notices.length = 0
  const broken = { id: 'broken-ext', name: 'Broken', api: 1, register: (s) => (s.command({ name: 'half-done', description: 'x', run: () => '' }), JSON.parse('{oops')) }
  const r = host.loadMainExtensions(deps(), [broken, sampleMain])
  assert.deepEqual(r.map((x) => x.state), ['failed', 'loaded'])
  assert.deepEqual(mainSockets.extensionCommands().map((c) => c.name), ['sample-hello'])
  assert.match(crashLog(), /Extension broken-ext failed to load and was skipped/)
  assert.match(notices.join(' '), /Broken \(.*JSON/)
})

test('an extension for a newer socket API is skipped with a clear message', () => {
  notices.length = 0
  const r = host.loadMainExtensions(deps(), [{ ...sampleMain, id: 'future-ext', name: 'Future', api: 2 }])
  assert.equal(r[0].state, 'skipped')
  assert.match(r[0].reason, /needs socket API 2, and this Corvid offers 1/)
  assert.match(notices[0], /Future/)
  assert.match(crashLog(), /Extension future-ext skipped/)
  assert.deepEqual(mainSockets.extensionCommands(), [])
})

test('a command may not shadow one of Corvid\'s own', () => {
  const r = host.loadMainExtensions(deps(), [{ id: 'shadow-ext', name: 'Shadow', api: 1, register: (s) => s.command({ name: 'clear', description: 'x', run: () => '' }) }])
  assert.equal(r[0].state, 'failed')
  assert.match(r[0].reason, /already a command/)
})

// ---------- tools: scoping, approvals, secrets, audit ----------

test('an extension tool is bound to the worker\'s project, gets no powers, and only read-only tools are pre-approved', async () => {
  host.loadMainExtensions(deps(), [sampleMain])
  const a = access()
  assert.deepEqual(a.allowed, ['ext_sample_ext_where'])
  const out = JSON.parse(await tool('ext_sample_ext_where').run({ project: 'C:\\elsewhere' }))
  assert.equal(out.ctx.project, 'D:\\work\\shop')
  assert.equal(out.ctx.taskId, 7)
  assert.deepEqual(out.keys.sort(), ['caller', 'project', 'taskId'])
})

test('an extension tool can\'t return a secret, and every call is audited', async () => {
  const text = await tool('ext_sample_ext_leak').run({})
  assert.ok(!text.includes(FAKE_KEY), text)
  assert.ok(!text.includes('hunter2hunter2'), text)
  const audit = host.readToolAudit()
  const last = audit.at(-1)
  assert.equal(last.tool, 'ext_sample_ext_leak')
  assert.equal(last.agent, 'worker #7')
  assert.equal(last.masked, true)
  assert.ok(!JSON.stringify(audit).includes(FAKE_KEY))
  assert.ok(audit.some((e) => e.tool === 'ext_sample_ext_where' && e.masked === false))
})

test('a tool that throws is reported as an error, masked and audited', async () => {
  host.loadMainExtensions(deps(), [{ id: 'thrower', name: 'Thrower', api: 1, register: (s) => s.tool({ name: 'boom', description: 'x', input: {}, run: () => { throw new Error(`bad ${FAKE_KEY}`) } }) }])
  await assert.rejects(tool('ext_thrower_boom').run({}), (e) => !e.message.includes(FAKE_KEY))
  assert.equal(host.readToolAudit().at(-1).ok, false)
})

test('nothing in the sockets can approve: the sources hold no approval calls', () => {
  for (const f of ['extensions/sockets/main.ts', 'extensions/sockets/window.ts', 'extensions/sockets/load.ts', 'main/extensionSockets.ts']) {
    const text = readFileSync(join(root, 'src', f), 'utf8')
    assert.ok(!/approveDraft|recordDecision|grantWorker|resolveApproval|setConnectorDisabled|setSecret|\beval\(|new Function/.test(text), f)
  }
  // board tools never run slash commands: only the window's own post handler does
  assert.ok(!/runCommand/.test(readFileSync(join(root, 'src/main/boardTools.ts'), 'utf8')))
})

// ---------- the tier-1 diff check ----------

test('the mechanical tier-1 check', () => {
  const reg = {
    path: 'src/extensions/mainExtensions.ts',
    status: 'M',
    added: ["import sampleExt from './sample-ext/main'", 'export const MAIN_EXTENSIONS: ExtensionModule<MainSockets>[] = [other, sampleExt]'],
    removed: ['export const MAIN_EXTENSIONS: ExtensionModule<MainSockets>[] = [other]']
  }
  const own = [
    { path: 'src/extensions/sample-ext/main.ts', status: 'A' },
    { path: 'src\\extensions\\sample-ext\\window.tsx', status: 'A' }
  ]
  assert.equal(diffShape('sample-ext', [...own, reg]).tier1, true)
  const core = diffShape('sample-ext', [...own, reg, { path: 'src/main/index.ts', status: 'M' }])
  assert.equal(core.tier1, false)
  assert.deepEqual(core.outside, ['src/main/index.ts'])
  assert.equal(diffShape('sample-ext', [...own, { ...reg, added: [...reg.added, 'console.log(1)'] }]).tier1, false)
  assert.match(diffShape('sample-ext', [{ ...reg, added: ['export const MAIN_EXTENSIONS: ExtensionModule<MainSockets>[] = [sampleExt]'] }]).reasons[0], /removes another/)
  assert.equal(diffShape('sample-ext', [{ ...reg, added: undefined }]).tier1, false)
  assert.equal(diffShape('sample-ext', [{ path: 'src/extensions/sample-ext/x.ts', status: 'R', from: 'src/main/config.ts' }]).tier1, false)
  assert.equal(diffShape('sample-ext', [{ path: 'src/extensions/other-ext/main.ts', status: 'A' }]).tier1, false)
  assert.equal(diffShape('sample-ext', [{ path: 'src/extensions/sample-ext/../../main/index.ts', status: 'M' }]).tier1, false)
  assert.equal(diffShape('sample-ext', []).tier1, false)
  assert.equal(isRegistrationLine("import x from './other-ext/main'", 'sample-ext'), false)
})

test('the build guidance and the docs point at the sockets', () => {
  assert.match(SOCKET_BUILD_GUIDANCE, /src\/extensions\/<id>\//)
  assert.match(SOCKET_BUILD_GUIDANCE, /disabledExtensions/)
  const docs = readFileSync(join(root, 'docs/EXTENSIONS.md'), 'utf8')
  for (const word of ['## Extension sockets', 'command(', 'tool(', 'instruction(', 'connector(', 'settingsSection(', 'page(', 'deliberately do not allow'])
    assert.ok(docs.includes(word), word)
})
