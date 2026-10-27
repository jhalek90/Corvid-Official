// Tests for #91, security defaults: the deny rules agents get (defaults, the data folder, the user's own
// patterns, "Allow this one"), the project secret scan (finds fake secrets, skips dependency and build
// folders, never returns a value) and the secret warning on look-alikes. Every secret here is fake and is
// put together at run time, so this file itself holds none. Runs on Node 24's TypeScript support with a
// stand-in for electron, in a temp folder.
//
//   npm run test-security

import { register } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-security-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
// electron as far as these modules use it
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

const { secretKindIn, nameMatches, denyDefaultsFor } = await import('../src/shared/secretRules.ts')
const { setConfig } = await import('../src/main/config.ts')
const { denyRules, agentSettingsArgs, absRule } = await import('../src/main/agentDeny.ts')
const { scanProject } = await import('../src/main/projectScan.ts')
const { projectKey } = await import('../src/shared/projects.ts')

after(() => rmSync(tmp, { recursive: true, force: true }))

// fake values, joined so no line here looks like one
const j = (...p) => p.join('')
const FAKE = {
  aws: j('AKIA', 'FAKEFAKEFAKEFAKE'),
  gh: j('ghp_', 'x'.repeat(36)),
  key: j('-----BEGIN ', 'RSA PRIVATE KEY-----'),
  url: j('postgres://app', ':', 'fakepass1', '@db.example.test/app'),
  pw: j('pass', 'word = "', 'notreal123', '"')
}

const proj = join(tmp, 'proj')
const put = (rel, text) => {
  mkdirSync(join(proj, rel, '..'), { recursive: true })
  writeFileSync(join(proj, rel), text)
}
put('.env', j('API_TOKEN', '=', 'fake-token-value-0001', '\n'))
put('src/config.js', `const db = '${FAKE.url}'\nconst k = '${FAKE.aws}'\n`)
put('deploy/server.key', `${FAKE.key}\nnot a real key\n`)
put('settings.yml', `${FAKE.pw}\n`)
put('notes.md', `token: ${FAKE.gh}\n`)
put('node_modules/pkg/index.js', `const k = '${FAKE.aws}'\n`)
put('dist/bundle.js', `const k = '${FAKE.aws}'\n`)
put('README.md', 'Set your password in the settings page. The token is refreshed hourly.\n')

test('look-alikes are not secrets; fake secrets are', () => {
  for (const ok of [
    'Fix the password reset page',
    'Rotate the API key next week',
    'token: see the vault',
    'password = ""',
    'Use postgres://localhost/app for dev',
    "The key is in Corvid's connections",
    'AKIA is the AWS prefix'
  ])
    assert.equal(secretKindIn(ok), null, ok)
  for (const [k, v] of Object.entries(FAKE)) assert.ok(secretKindIn(`note: ${v}`), k)
})

test('deny rules: defaults, data folder, read and edit', () => {
  const rules = denyRules(proj, proj)
  const data = `${absRule(globalThis.__userData)}/**`
  assert.ok(rules.includes(`Read(${data})`) && rules.includes(`Edit(${data})`))
  for (const d of denyDefaultsFor(process.platform)) assert.ok(rules.includes(`Read(${d.pattern})`), d.pattern)
  assert.ok(rules.includes('Read(~/.ssh/**)') && rules.includes('Read(**/.env)'))
})

test('a default switched off and a pattern of your own', () => {
  setConfig({ agentDenyOff: ['~/.npmrc'], agentDenyExtra: ['**/*.secret', '~/.myapp/token', 'bad(pattern)'] })
  const rules = denyRules(proj, proj)
  assert.ok(!rules.includes('Read(~/.npmrc)'))
  assert.ok(rules.includes('Read(**/*.secret)') && rules.includes('Read(~/.myapp/token)'))
  assert.ok(!rules.some((r) => r.includes('bad(')))
  setConfig({ agentDenyOff: [], agentDenyExtra: [] })
})

test('"Allow this one" drops the glob and denies the other matching files by path', () => {
  put('sub/.env', 'X=1\n')
  setConfig({ agentDenyAllow: [{ project: proj, file: '.env' }] })
  const rules = denyRules(proj, proj)
  assert.ok(!rules.includes('Read(**/.env)'))
  assert.ok(rules.includes('Read(./sub/.env)'))
  assert.ok(!rules.includes('Read(./.env)'))
  // another project keeps the glob
  assert.ok(denyRules(join(tmp, 'other'), join(tmp, 'other')).includes('Read(**/.env)'))
  setConfig({ agentDenyAllow: [] })
  rmSync(join(proj, 'sub'), { recursive: true })
})

test('the assistant gets project patterns under every project folder', () => {
  const rules = denyRules(undefined, undefined, [proj])
  assert.ok(rules.includes(`Read(${absRule(proj)}/**/.env)`))
})

test('the settings file holds only deny rules, named by its contents', () => {
  const [flag, file] = agentSettingsArgs(proj, proj)
  assert.equal(flag, '--settings')
  const s = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(s), ['permissions'])
  assert.deepEqual(Object.keys(s.permissions), ['deny'])
  assert.equal(agentSettingsArgs(proj, proj)[1], file)
})

test('nameMatches', () => {
  assert.ok(nameMatches('**/.env.*', '.env.local'))
  assert.ok(nameMatches('**/*.pem', 'Cert.PEM'))
  assert.ok(!nameMatches('**/.env', 'my.env'))
  assert.ok(!nameMatches('~/.ssh/**', 'id_rsa'))
})

test('the scan finds the fake secrets, skips ignored folders and never returns a value', async () => {
  const s = await scanProject(proj)
  const where = s.findings.map((f) => `${f.file}:${f.line}:${f.kind}`)
  for (const w of [
    '.env:0:a secret file',
    'src/config.js:1:a password in a URL',
    'src/config.js:2:an AWS access key',
    'deploy/server.key:0:a secret file',
    'deploy/server.key:1:a private key',
    'settings.yml:1:a password',
    'notes.md:1:a GitHub token'
  ])
    assert.ok(where.includes(w), `${w} not in ${where.join(' ')}`)
  assert.ok(!where.some((w) => w.startsWith('node_modules/') || w.startsWith('dist/') || w.startsWith('README.md')))
  const out = JSON.stringify(s)
  for (const v of [...Object.values(FAKE), 'fake-token-value-0001', 'fakepass1', 'notreal123', 'FAKEFAKEFAKEFAKE', 'x'.repeat(36)]) assert.ok(!out.includes(v), 'a value leaked')
  for (const f of s.findings) if (f.hint) assert.ok(f.hint.length <= 5)
  // the .env and the key file are denied to agents, the others aren't
  assert.equal(s.findings.find((f) => f.file === '.env').readable, false)
  assert.equal(s.findings.find((f) => f.file === 'notes.md').readable, true)
})

test('ignore and block change the scan; a clean project finds nothing', async () => {
  setConfig({ secretIgnore: { [projectKey(proj)]: ['notes.md|a GitHub token'] }, agentDenyExtra: ['./settings.yml'] })
  const s = await scanProject(proj)
  assert.ok(!s.findings.some((f) => f.file === 'notes.md'))
  assert.equal(s.findings.find((f) => f.file === 'settings.yml').readable, false)
  const clean = join(tmp, 'clean')
  mkdirSync(clean)
  writeFileSync(join(clean, 'index.js'), 'console.log("hello")\n')
  assert.equal((await scanProject(clean)).findings.length, 0)
})
