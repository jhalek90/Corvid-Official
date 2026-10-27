// Tests for #194, the Claude Code path in Settings → System: the path checks (a good path, a folder, a missing file,
// newlines and control characters, .bat/.cmd/.ps1 on Windows, a relative path), Check against fake programs (one that
// prints a Claude Code version, one that hangs, one that prints junk), the config validation on load and on save, and
// that nothing but Settings' own IPC writes the key. Fake files in a temp folder and a fake userData; no Corvid, no claude.
//
//   npm run test-claude-path

import { register } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

// the real path: macOS's tmpdir() is /var/folders/…, a link to /private/var/folders/…, and a path through a link
// would (rightly) get a `resolved`, which the tests below check only for the symlink they make themselves
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'corvid-claude-path-')))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent(\`
      export const app = { getPath: () => globalThis.__userData, isPackaged: false }
      export const safeStorage = { isEncryptionAvailable: () => false }\`)
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

const cp = await import(src + 'main/claudePath.ts')
const config = await import(src + 'main/config.ts')

after(() => rmSync(tmp, { recursive: true, force: true }))

const win = process.platform === 'win32'
const exe = join(tmp, win ? 'claude.exe' : 'claude')
writeFileSync(exe, 'fake')
if (!win) chmodSync(exe, 0o755)

/** A probe over the real disk whose `--version` answers with what the test says. */
const probe = (answer) => ({ ...cp.realProbe, version: async () => answer })
const says = (stdout) => probe({ stdout, timedOut: false, failed: false })

// ---------- the text checks ----------

test('text: a full path is fine; empty, too long, newlines, control characters and relative paths are refused', () => {
  assert.deepEqual(cp.checkClaudePathText('C:\\Users\\x\\.local\\bin\\claude.exe', 'win32'), { path: 'C:\\Users\\x\\.local\\bin\\claude.exe' })
  assert.deepEqual(cp.checkClaudePathText('  /usr/local/bin/claude  ', 'linux'), { path: '/usr/local/bin/claude' })
  assert.match(cp.checkClaudePathText(42, 'linux').error, /must be text/)
  assert.match(cp.checkClaudePathText('   ', 'linux').error, /Choose/)
  assert.match(cp.checkClaudePathText('/' + 'a'.repeat(cp.CLAUDE_PATH_MAX), 'linux').error, /longer than/)
  assert.match(cp.checkClaudePathText('/usr/bin/claude\n--dangerously', 'linux').error, /newline or another control/)
  assert.match(cp.checkClaudePathText('/usr/bin/cl\u0007aude', 'darwin').error, /control/)
  assert.match(cp.checkClaudePathText('C:\\x\\claude.exe\r', 'win32').error, /control/)
  for (const [p, os] of [['bin/claude', 'linux'], ['./claude', 'darwin'], ['claude.exe', 'win32'], ['.local\\bin\\claude.exe', 'win32'], ['\\claude.exe', 'win32']])
    assert.match(cp.checkClaudePathText(p, os).error, /relative path is refused/, p)
  assert.ok('path' in cp.checkClaudePathText('\\\\server\\share\\claude.exe', 'win32'))
  // saved normalised, so a forward-slash path on Windows isn't shown as a link to itself
  assert.deepEqual(cp.checkClaudePathText('C:/Users/x/.local/bin/claude.exe', 'win32'), { path: 'C:\\Users\\x\\.local\\bin\\claude.exe' })
  assert.deepEqual(cp.checkClaudePathText('/usr/local/../bin/claude', 'linux'), { path: '/usr/bin/claude' })
})

test('text: on Windows a .bat, .cmd or .ps1 is refused with the WSL reason and a pointer to claude.exe; elsewhere a .sh name is fine', () => {
  for (const ext of ['bat', 'cmd', 'ps1', 'BAT'])
    assert.match(cp.checkClaudePathText(`C:\\Users\\x\\bin\\claude.${ext}`, 'win32').error, /WSL.*claude\.exe/s, ext)
  assert.match(cp.checkClaudePathText('C:\\Users\\x\\bin\\claude', 'win32').error, /pick claude\.exe/)
  assert.ok('path' in cp.checkClaudePathText('/home/x/bin/claude.sh', 'linux'))
})

// ---------- Check with a probe ----------

test('check: a good path answers with its version; a missing file, a folder and a script are refused before anything runs', async () => {
  let ran = 0
  const counting = { ...cp.realProbe, version: async () => (ran++, { stdout: '2.1.309 (Claude Code)\n', timedOut: false, failed: false }) }
  assert.deepEqual(await cp.checkClaudePath(exe, counting), { ok: true, path: exe, resolved: undefined, version: '2.1.309' })
  assert.match((await cp.checkClaudePath(join(tmp, win ? 'nope.exe' : 'nope'), counting)).error, /^Not found/)
  const dir = join(tmp, win ? 'folder.exe' : 'folder')
  mkdirSync(dir, { recursive: true })
  assert.match((await cp.checkClaudePath(dir, counting)).error, /folder/)
  if (win) assert.match((await cp.checkClaudePath(join(tmp, 'claude.bat'), counting)).error, /WSL/)
  assert.equal(ran, 1)
})

test('check: junk, an error with no output, and a hang each get their plain message', async () => {
  assert.match((await cp.checkClaudePath(exe, says('v22.18.0\n'))).error, /doesn't look like Claude Code/)
  assert.match((await cp.checkClaudePath(exe, says('Claude Code\n'))).error, /doesn't look like Claude Code/)
  assert.match((await cp.checkClaudePath(exe, probe({ stdout: '', timedOut: false, failed: true }))).error, /^Not executable/)
  assert.match((await cp.checkClaudePath(exe, probe({ stdout: '', timedOut: true, failed: true }))).error, /didn't answer/)
})

test('check: off Windows, a file without the execute bit is not executable, and a symlink shows where it points', { skip: win }, async () => {
  const plain = join(tmp, 'not-runnable')
  writeFileSync(plain, 'x')
  chmodSync(plain, 0o644)
  assert.match((await cp.checkClaudePath(plain, says('1.0.0 (Claude Code)'))).error, /^Not executable/)
  const link = join(tmp, 'claude-link')
  symlinkSync(exe, link)
  const r = await cp.checkClaudePath(link, says('1.0.0 (Claude Code)'))
  assert.equal(r.ok, true)
  assert.equal(r.resolved, exe)
})

// ---------- the real run, with fake programs ----------

const script = (name, body) => {
  const f = join(tmp, name)
  writeFileSync(f, body)
  return f
}
const prints = script('prints.mjs', "console.log(process.argv.includes('--version') ? '3.4.5 (Claude Code)' : 'wrong args')")
const hangs = script('hangs.mjs', 'setInterval(() => {}, 1000)')
const junk = script('junk.mjs', "process.stdout.write('x'.repeat(200000))")

test('run: the program gets --version and nothing else, no shell, and its answer is read', async () => {
  const r = await cp.runCapped(process.execPath, [prints, '--version'], 5000)
  assert.equal(r.stdout.trim(), '3.4.5 (Claude Code)')
  assert.deepEqual([r.timedOut, r.failed], [false, false])
  const src = readFileSync(join(root, 'src', 'main', 'claudePath.ts'), 'utf8')
  assert.match(src, /return runCapped\(path, \['--version'\], timeoutMs\)/)
  assert.match(src, /shell: false/)
})

test('run: a program that hangs is stopped at the timeout and counts as not answering', async () => {
  const t = Date.now()
  const r = await cp.runCapped(process.execPath, [hangs], 700)
  assert.ok(Date.now() - t < 5000)
  assert.equal(r.timedOut, true)
  const c = await cp.checkClaudePath(exe, { ...cp.realProbe, version: () => cp.runCapped(process.execPath, [hangs], 700) })
  assert.match(c.error, /didn't answer/)
})

test('run: a flood of junk is cut at the cap and is not Claude Code', async () => {
  const r = await cp.runCapped(process.execPath, [junk], 5000)
  assert.ok(r.stdout.length <= 16 * 1024)
  assert.equal(r.timedOut, false)
  const c = await cp.checkClaudePath(exe, { ...cp.realProbe, version: () => cp.runCapped(process.execPath, [junk], 5000) })
  assert.match(c.error, /doesn't look like Claude Code/)
})

test('run: off Windows, a real executable script answers runVersion directly', { skip: win }, async () => {
  const f = script('fake-claude', '#!/bin/sh\necho "9.8.7 (Claude Code)"\n')
  chmodSync(f, 0o755)
  assert.deepEqual(await cp.checkClaudePath(f), { ok: true, path: f, resolved: undefined, version: '9.8.7' })
})

// ---------- config ----------

test('config: a saved path that is bad text, missing or a folder is repaired on load; a good one stays', () => {
  assert.equal(config.claudePathProblem(exe), null)
  const folder = join(tmp, win ? 'folder.exe' : 'folder')
  mkdirSync(folder, { recursive: true })
  assert.equal(config.claudePathProblem(folder), 'is a folder')
  assert.equal(config.claudePathProblem(join(tmp, win ? 'gone.exe' : 'gone')), "doesn't exist")
  assert.equal(config.claudePathProblem('relative/claude'), "isn't a usable path")
  assert.equal(config.claudePathProblem(exe + '\n'), "isn't a usable path", 'a trailing newline is refused, not trimmed')
  assert.equal(config.claudePathProblem(`${exe}\nx`), "isn't a usable path")
  assert.equal(config.claudePathProblem(['/usr/bin/claude']), "isn't a usable path")
  writeFileSync(join(globalThis.__userData, 'config.json'), JSON.stringify({ claudePath: 'claude.bat' }))
  assert.equal(config.getConfig().claudePath, undefined)
  assert.ok(config.configRepairs().some((r) => /the Claude path/.test(r)))
})

test('config: setConfig never writes a bad path, keeps a good one, and a reset removes it', () => {
  config.setConfig({ claudePath: 'relative/claude' })
  assert.equal(JSON.parse(readFileSync(join(globalThis.__userData, 'config.json'), 'utf8')).claudePath, undefined)
  config.setConfig({ claudePath: exe })
  assert.equal(JSON.parse(readFileSync(join(globalThis.__userData, 'config.json'), 'utf8')).claudePath, exe)
  config.setConfig({ claudePath: undefined })
  assert.equal('claudePath' in JSON.parse(readFileSync(join(globalThis.__userData, 'config.json'), 'utf8')), false)
})

// ---------- who can write it ----------

test('no tool, slash command, socket or extension writes the Claude path; config:set drops it', () => {
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) files.push(p)
    }
  }
  walk(join(root, 'src', 'main'))
  walk(join(root, 'src', 'extensions'))
  const writers = files.filter((f) => /setConfig\(\{[^}]*claudePath/.test(readFileSync(f, 'utf8')))
  // setClaudePath in index.ts is the one writer, behind the window-only IPC
  assert.deepEqual(writers.map((f) => f.slice(root.length + 1).replace(/\\/g, '/')), ['src/main/index.ts'])
  const index = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
  assert.equal((index.match(/setConfig\(\{ claudePath/g) ?? []).length, 2, 'set and reset, both in setClaudePath')
  for (const ch of ['browse', 'check', 'set'])
    assert.match(index, new RegExp(`ipcMain\\.handle\\('claudePath:${ch}', (async )?\\(e(, path: unknown)?\\) => \\{\\s+if \\(e\\.sender !== win\\?\\.webContents\\)`), ch)
  // applyConfig (config:set, the slash commands, extensions' flags) drops the key
  assert.match(index, /if \(patch && 'claudePath' in patch\) \{\s+patch = \{ \.\.\.patch \}\s+delete patch\.claudePath/)
  // a new path is checked again in main and confirmed in Corvid's own dialog before it's saved, and logged
  assert.match(index, /const c = await checkClaudePath\(raw\)\s+if \(!c\.ok\) return done\(false, c\.error\)/)
  assert.match(index, /if \(!\(await confirmClaudePath\(/)
  assert.match(index, /Corvid will run this program for agents and Corvid: \$\{path\}/)
  assert.match(index, /console\.warn\(`\[config\] Claude Code path set by the user/)
  // nothing reachable by agents or Corvid's tools even mentions the key
  for (const f of ['assistantTools.ts', 'boardTools.ts', 'mcp.ts', 'slashCommands.ts', 'extensionSockets.ts', 'noteTools.ts', 'gitTools.ts', 'taskFileTools.ts'])
    assert.doesNotMatch(readFileSync(join(root, 'src', 'main', f), 'utf8'), /claudePath/, f)
})

test('everything that starts Claude looks it up through resolveClaude with the saved path, each time', () => {
  const read = (f) => readFileSync(join(root, 'src', 'main', f), 'utf8')
  for (const f of ['assistant.ts', 'usage.ts', 'workers.ts', 'newProject.ts']) assert.match(read(f), /resolveClaude\(getConfig\(\)\.claudePath\)/, f)
  assert.match(read('packager.ts'), /resolveClaude\(deps\.claudePath\(\)\)/)
  const index = read('index.ts')
  assert.match(index, /claude: async \(\) => \(await resolveClaude\(getConfig\(\)\.claudePath\)\)\?\.path/, 'extension scans')
  assert.match(index, /async function fableProblem[\s\S]*?resolveClaude\(getConfig\(\)\.claudePath\)/, 'the Fable check')
  // a saved path skips the one-minute cache, and Reset forgets it
  assert.match(read('claudeBin.ts'), /if \(override && existsSync\(override\)\) \{\s+return \{ path: override/)
  assert.match(index, /forgetClaude\(\)/)
})
