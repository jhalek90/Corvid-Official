// Tests for #150, deny rules on macOS and Linux: the rules agents get for Corvid's data folder, the user's projects
// and secret files, for win32, darwin and linux path shapes, on any machine. Before #150 a POSIX path came out as
// ///Users/... (three slashes), which Claude Code reads as something else, so agents could read the data folder.
// Claude Code's form for an absolute path is //Users/... (its permissions docs: "//path: absolute path from
// filesystem root"; on Windows C:\Users becomes //c/Users). Windows output must not change: test-platform pins
// it too. Runs on Node 24's TypeScript support with a stand-in for electron; every path here is made up.
//
//   npm run test-deny-platforms

import { register } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-deny-'))
const local = { userData: join(tmp, 'data'), appData: join(tmp, 'appdata') }
// what the fake electron's app.getPath answers, by name
globalThis.__paths = local
mkdirSync(local.userData, { recursive: true })
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent('export const app = { getPath: (n) => globalThis.__paths[n] ?? globalThis.__paths.userData }')
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
      return /\\.ts(?:\\?|$)/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const P = await import(src + 'main/platform/index.ts')
const { appDataDir } = await import(src + 'main/platform/shared.mjs')
const deny = await import(src + 'main/agentDeny.ts')
const { getConfig } = await import(src + 'main/config.ts')
const { DENY_DEFAULTS, denyDefaultsFor } = await import(src + 'shared/secretRules.ts')
// the config is read once from this copy's (temp) folder and kept, before the paths below turn POSIX
getConfig()

after(() => rmSync(tmp, { recursive: true, force: true }))

/** denyRules as an agent on `platform` gets them, with that platform's app folders. */
function rulesOn(platform, paths, ...args) {
  globalThis.__paths = paths
  try {
    return deny.denyRules(...args.concat(Array(3 - args.length).fill(undefined)), platform)
  } finally {
    globalThis.__paths = local
  }
}
const mac = { userData: '/Users/x/Library/Application Support/Corvid', appData: '/Users/x/Library/Application Support' }
const lin = { userData: '/home/x/.config/Corvid', appData: '/home/x/.config' }

test('POSIX absolute paths become //path, never ///path', () => {
  const cases = [
    ['/Users/x/Library/Application Support/Corvid', '//Users/x/Library/Application Support/Corvid'],
    ['/home/x/.config/Corvid', '//home/x/.config/Corvid'],
    ['/root/.config/Corvid', '//root/.config/Corvid'],
    // trailing and doubled slashes, and .., are resolved so the rule names the folder itself
    ['/home/x/.config/Corvid/', '//home/x/.config/Corvid'],
    ['/home//x///.config/Corvid//', '//home/x/.config/Corvid'],
    ['/home/x/repo/../.config/Corvid', '//home/x/.config/Corvid'],
    // gitignore's special characters are escaped, so a folder name is matched literally
    ['/home/x/repo [old]', '//home/x/repo \\[old\\]'],
    ['/Users/x/what?/*', '//Users/x/what\\?/\\*']
  ]
  for (const os of ['darwin', 'linux']) for (const [p, rule] of cases) assert.equal(P.absRule(p, os), rule, `${os} ${p}`)
  // anything Corvid doesn't know is treated as Linux
  assert.equal(P.absRule('/home/x', 'freebsd'), '//home/x')
})

test('Windows absRule is unchanged, spaces and all', () => {
  assert.equal(P.absRule('C:\\Users\\x y\\AppData\\Roaming\\Corvid', 'win32'), '//c/Users/x y/AppData/Roaming/Corvid')
  assert.equal(P.absRule('C:\\Users\\x\\AppData\\Roaming\\Corvid\\', 'win32'), '//c/Users/x/AppData/Roaming/Corvid/')
  assert.equal(P.absRule('D:\\repo [old]', 'win32'), '//d/repo [old]')
  if (process.platform === 'win32') assert.equal(deny.absRule('C:\\Users\\x\\AppData\\Roaming\\Corvid'), '//c/Users/x/AppData/Roaming/Corvid')
})

test('data folder rules: this copy\'s folder and the real app\'s, per platform', () => {
  // the real app on each platform: one folder, one rule
  assert.deepEqual(deny.dataFolderRules(mac.userData, mac.appData, 'darwin'), ['//Users/x/Library/Application Support/Corvid/**'])
  assert.deepEqual(deny.dataFolderRules(lin.userData, lin.appData, 'linux'), ['//home/x/.config/Corvid/**'])
  // a test copy also keeps its agents out of the real app's folder
  assert.deepEqual(deny.dataFolderRules('/tmp/corvid-test-1/data', mac.appData, 'darwin'), [
    '//tmp/corvid-test-1/data/**',
    '//Users/x/Library/Application Support/Corvid/**'
  ])
  // homes under /home, /Users and /root, XDG_CONFIG_HOME, and a trailing slash
  assert.deepEqual(deny.dataFolderRules('/root/.config/Corvid', appDataDir('linux', {}, '/root'), 'linux'), ['//root/.config/Corvid/**'])
  assert.deepEqual(deny.dataFolderRules('/home/x/cfg/Corvid/', appDataDir('linux', { XDG_CONFIG_HOME: '/home/x/cfg/' }, '/home/x'), 'linux'), ['//home/x/cfg/Corvid/**'])
  assert.deepEqual(deny.dataFolderRules('/Users/x/Library/Application Support/Corvid', appDataDir('darwin', {}, '/Users/x'), 'darwin'), [
    '//Users/x/Library/Application Support/Corvid/**'
  ])
  // Windows: today's three rules, "Claude Dashboard" included
  assert.deepEqual(deny.dataFolderRules('C:\\Users\\x\\AppData\\Roaming\\Corvid', 'C:\\Users\\x\\AppData\\Roaming', 'win32'), [
    '//c/Users/x/AppData/Roaming/Corvid/**',
    '//c/Users/x/AppData/Roaming/Claude Dashboard/**'
  ])
})

test('the rules an agent gets on macOS and Linux: data folder, secrets, project folders', () => {
  for (const [os, paths, home] of [
    ['darwin', mac, '/Users/x'],
    ['linux', lin, '/home/x']
  ]) {
    const rules = rulesOn(os, paths, `${home}/proj`, `${home}/proj`, [`${home}/proj`, `${home}/Code/other app`])
    const data = os === 'darwin' ? '//Users/x/Library/Application Support/Corvid/**' : '//home/x/.config/Corvid/**'
    assert.ok(rules.includes(`Read(${data})`) && rules.includes(`Edit(${data})`), `${os} data folder`)
    for (const p of ['~/.ssh/**', '~/.aws/**', '~/.config/gcloud/**', '~/.kube/**', '~/.gnupg/**', '~/.netrc', '~/.git-credentials', '~/.claude/.credentials.json', '~/.config/gh/hosts.yml'])
      assert.ok(rules.includes(`Read(${p})`), `${os} ${p}`)
    assert.equal(rules.includes('Read(~/Library/Keychains/**)'), os === 'darwin', `${os} keychains`)
    assert.equal(rules.includes('Read(~/.local/share/keyrings/**)'), os === 'linux', `${os} keyrings`)
    assert.ok(rules.includes(`Read(/${home}/proj/**/.env)`), `${os} project root`)
    assert.ok(rules.includes(`Read(/${home}/Code/other app/**/.env)`), `${os} project root with a space`)
    assert.ok(rules.includes('Read(**/.env)'))
    assert.ok(!rules.some((r) => r.includes('///')), `${os}: no rule has three slashes`)
  }
})

test('Windows gets exactly the secret defaults it had before #150', () => {
  const before = [
    '~/.ssh/**', '~/.aws/**', '~/.azure/**', '~/.config/gcloud/**', '~/AppData/Roaming/gcloud/**', '~/.kube/**', '~/.docker/config.json',
    '~/.npmrc', '~/.pypirc', '~/.netrc', '~/.git-credentials', '~/.gnupg/**', '~/.claude/.credentials.json', '**/.env', '**/.env.*', '**/*.pem',
    '**/*.key', '**/*.p12', '**/*.pfx', '**/*.ppk', '**/id_rsa', '**/id_dsa', '**/id_ecdsa', '**/id_ed25519', '**/credentials.json', '**/secrets.*'
  ]
  assert.deepEqual(denyDefaultsFor('win32').map((d) => d.pattern), before)
  const win = { userData: 'C:\\Users\\x\\AppData\\Roaming\\Corvid', appData: 'C:\\Users\\x\\AppData\\Roaming' }
  const rules = rulesOn('win32', win, undefined, undefined, ['D:\\projects\\dashboard'])
  assert.deepEqual(rules.slice(0, 4), ['Read(//c/Users/x/AppData/Roaming/Corvid/**)', 'Edit(//c/Users/x/AppData/Roaming/Corvid/**)', 'Read(//c/Users/x/AppData/Roaming/Claude Dashboard/**)', 'Edit(//c/Users/x/AppData/Roaming/Claude Dashboard/**)'])
  assert.ok(rules.includes('Read(//d/projects/dashboard/**/.env)'))
  assert.ok(!rules.some((r) => /Keychains|keyrings|gh\/hosts/.test(r)))
})

test('secret defaults use only the ~/ and **/ forms, which Claude Code reads the same on every platform', () => {
  for (const d of DENY_DEFAULTS) {
    assert.ok(d.project ? d.pattern.startsWith('**/') : d.pattern.startsWith('~/'), d.pattern)
    assert.ok(!d.pattern.includes('\\'), `${d.pattern}: forward slashes only`)
    for (const os of d.platforms ?? []) assert.ok(['win32', 'darwin', 'linux'].includes(os), `${d.pattern}: ${os}`)
  }
})

test('the Claude Code login is denied where CLAUDE_CONFIG_DIR moves it', () => {
  assert.deepEqual(deny.claudeConfigRules({}, 'linux'), [])
  assert.deepEqual(deny.claudeConfigRules({ CLAUDE_CONFIG_DIR: '/home/x/.claude-work/' }, 'linux'), ['//home/x/.claude-work/.credentials.json'])
  assert.deepEqual(deny.claudeConfigRules({ CLAUDE_CONFIG_DIR: 'C:\\Users\\x\\.claude-alt' }, 'win32'), ['//c/Users/x/.claude-alt/.credentials.json'])
})

test('a glob matcher reads the POSIX rules as the folder they name (a stand-in for Claude Code\'s own)', async (t) => {
  let picomatch
  try {
    picomatch = (await import('picomatch')).default
  } catch {
    return t.skip('picomatch not installed')
  }
  // a // rule is anchored at the filesystem root, so drop one slash to get the absolute glob
  const matches = (rule, file) => picomatch(rule.slice(1), { dot: true, windows: false })(file)
  const file = '/Users/x/Library/Application Support/Corvid/connections.json'
  const rule = deny.dataFolderRules(mac.userData, mac.appData, 'darwin')[0]
  assert.ok(matches(rule, file))
  assert.ok(!matches(`//${mac.userData}/**`, file), 'the old three-slash form does not match')
  assert.ok(matches(`${P.absRule('/home/x/repo [old]', 'linux')}/**`, '/home/x/repo [old]/.env'))
  assert.ok(!matches(`${P.absRule('/home/x/repo [old]', 'linux')}/**`, '/home/x/repo o/.env'))
})
