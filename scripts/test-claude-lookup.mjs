// Tests for #152: finding the Claude Code CLI on Windows, macOS and Linux (src/main/platform/claude.ts findClaude),
// and reading the login shell's PATH for a GUI app (src/main/platform/loginEnv.ts). Every file layout here is
// fake and handed to findClaude as a probe, so all three platforms run on any machine. The login shell test runs
// a real bash (Git Bash on Windows) against a made-up HOME in a temp folder, never the real profile.
//
//   npm run test-claude-lookup

import { register } from 'node:module'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-claude-lookup-'))
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
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

const { findClaude } = await import(src + 'main/platform/claude.ts')
const { parseEnvOutput, mergePath, loginEnvChanges, readLoginShellEnv } = await import(src + 'main/platform/loginEnv.ts')

after(() => rmSync(tmp, { recursive: true, force: true }))

/** A fake machine: files maps a path to the version `--version` prints (null: it's there but doesn't run). */
function machine(files, dirs = {}) {
  const ran = []
  return {
    ran,
    probe: {
      exists: (p) => p in files,
      readdir: (d) => {
        if (!(d in dirs)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return dirs[d]
      },
      version: async (p) => {
        ran.push(p)
        return files[p] ?? null
      }
    }
  }
}

// ---------- Windows: today's choice, unchanged ----------

test('win32: the newest of the VS Code extension and ~/.local/bin/claude.exe; the extension is not run', async () => {
  const ext = 'C:\\Users\\x\\.vscode\\extensions'
  const m = machine(
    {
      [`${ext}\\anthropic.claude-code-2.1.0-win32-x64\\resources\\native-binary\\claude.exe`]: '2.1.0',
      [`${ext}\\anthropic.claude-code-2.3.0-win32-x64\\resources\\native-binary\\claude.exe`]: '2.3.0',
      'C:\\Users\\x\\.local\\bin\\claude.exe': '2.2.0',
      'C:\\Users\\x\\bin\\claude.exe': '9.9.9'
    },
    { [ext]: ['anthropic.claude-code-2.1.0-win32-x64', 'anthropic.claude-code-2.3.0-win32-x64', 'ms-python.python-1.0.0'] }
  )
  const bin = await findClaude(m.probe, 'win32', 'C:\\Users\\x', { PATH: 'C:\\Users\\x\\bin' })
  assert.deepEqual(bin, { path: `${ext}\\anthropic.claude-code-2.3.0-win32-x64\\resources\\native-binary\\claude.exe`, version: '2.3.0', source: 'VS Code extension' })
  assert.deepEqual(m.ran, ['C:\\Users\\x\\.local\\bin\\claude.exe'])
})

test('win32: never claude on PATH (there it is a WSL wrapper), and a silent ~/.local/bin one still counts as 0.0.0', async () => {
  const m = machine({ 'C:\\Users\\x\\.local\\bin\\claude.exe': null, 'C:\\Users\\x\\bin\\claude': '9.9.9', 'C:\\Users\\x\\bin\\claude.exe': '9.9.9' })
  const bin = await findClaude(m.probe, 'win32', 'C:\\Users\\x', { PATH: 'C:\\Users\\x\\bin' })
  assert.deepEqual(bin, { path: 'C:\\Users\\x\\.local\\bin\\claude.exe', version: '0.0.0', source: '~/.local/bin' })
  assert.equal(await findClaude(machine({ 'C:\\Users\\x\\bin\\claude.exe': '9.9.9' }).probe, 'win32', 'C:\\Users\\x', { PATH: 'C:\\Users\\x\\bin' }), null)
})

// ---------- macOS ----------

test('darwin: native installer, Homebrew, the extension and PATH; the newest that runs wins', async () => {
  const ext = '/Users/x/.vscode/extensions'
  const m = machine(
    {
      '/Users/x/.local/bin/claude': '2.2.0',
      '/opt/homebrew/bin/claude': '2.4.0',
      '/usr/local/bin/claude': null, // a broken leftover: there, but it doesn't run
      [`${ext}/anthropic.claude-code-2.5.0-darwin-arm64/resources/native-binary/claude`]: null,
      [`${ext}/anthropic.claude-code-2.3.0-darwin-arm64/resources/native-binary/claude`]: '2.3.0',
      [`${ext}/anthropic.claude-code-2.3.0-darwin-arm64/resources/native-binary/claude.exe`]: '9.9.9'
    },
    { [ext]: ['anthropic.claude-code-2.5.0-darwin-arm64', 'anthropic.claude-code-2.3.0-darwin-arm64'] }
  )
  const bin = await findClaude(m.probe, 'darwin', '/Users/x', { PATH: '/opt/homebrew/bin:/usr/bin:/bin' })
  assert.deepEqual(bin, { path: '/opt/homebrew/bin/claude', version: '2.4.0', source: 'Homebrew' })
  // every candidate was asked once; /opt/homebrew/bin on PATH is the same file as the Homebrew place
  assert.equal(m.ran.length, new Set(m.ran).size)
  assert.ok(m.ran.includes('/usr/local/bin/claude'))
})

test('darwin: a broken newest one is skipped for an older one that runs', async () => {
  const m = machine({ '/Users/x/.local/bin/claude': null, '/Users/x/.claude/local/claude': '1.0.0' })
  assert.deepEqual(await findClaude(m.probe, 'darwin', '/Users/x', {}), { path: '/Users/x/.claude/local/claude', version: '1.0.0', source: '~/.claude/local' })
})

test('darwin: found only on PATH (e.g. an npm global install), relative PATH entries ignored', async () => {
  const m = machine({ '/Users/x/.npm-global/bin/claude': '2.0.1', 'bin/claude': '9.9.9' })
  const bin = await findClaude(m.probe, 'darwin', '/Users/x', { PATH: 'bin::/usr/bin:/Users/x/.npm-global/bin' })
  assert.deepEqual(bin, { path: '/Users/x/.npm-global/bin/claude', version: '2.0.1', source: 'PATH' })
})

test('darwin: on ties the fixed places come first, then the extension, then PATH', async () => {
  const ext = '/Users/x/.vscode/extensions'
  const m = machine(
    { '/Users/x/.local/bin/claude': '2.0.0', [`${ext}/anthropic.claude-code-2.0.0/resources/native-binary/claude`]: '2.0.0', '/Users/x/bin/claude': '2.0.0' },
    { [ext]: ['anthropic.claude-code-2.0.0'] }
  )
  assert.equal((await findClaude(m.probe, 'darwin', '/Users/x', { PATH: '/Users/x/bin' })).path, '/Users/x/.local/bin/claude')
})

// ---------- Linux ----------

test('linux: ~/.local/bin, ~/.claude/local, the extension, PATH; no Homebrew places', async () => {
  const ext = '/home/x/.vscode/extensions'
  const m = machine(
    {
      '/home/x/.claude/local/claude': '2.1.0',
      [`${ext}/anthropic.claude-code-2.2.0-linux-x64/resources/native-binary/claude`]: '2.2.0',
      '/opt/homebrew/bin/claude': '9.9.9'
    },
    { [ext]: ['anthropic.claude-code-2.2.0-linux-x64'] }
  )
  const bin = await findClaude(m.probe, 'linux', '/home/x', { PATH: '/usr/bin' })
  assert.deepEqual(bin, { path: `${ext}/anthropic.claude-code-2.2.0-linux-x64/resources/native-binary/claude`, version: '2.2.0', source: 'VS Code extension' })
  assert.ok(!m.ran.includes('/opt/homebrew/bin/claude'))
})

test('nothing installed: null on every platform', async () => {
  for (const [os, home] of [['win32', 'C:\\Users\\x'], ['darwin', '/Users/x'], ['linux', '/home/x']]) {
    assert.equal(await findClaude(machine({}).probe, os, home, { PATH: '/usr/bin:/bin' }), null)
  }
})

// ---------- the login shell's environment ----------

const MARK = '__CORVID_ENV_0123456789abcdef__'

test('env output: noise before and after the markers is ignored', () => {
  const out = [
    'Last login: Thu Oct 22 09:00:00 on ttys001',
    'PATH=/fake/from/noise',
    '',
    MARK,
    'HOME=/Users/x',
    'PATH=/opt/homebrew/bin:/usr/bin:/bin',
    'EMPTY=',
    'EQUALS=a=b=c',
    MARK,
    'PATH=/after/the/end',
    'bye from .zlogout'
  ].join('\n')
  assert.deepEqual(parseEnvOutput(out, MARK), { HOME: '/Users/x', PATH: '/opt/homebrew/bin:/usr/bin:/bin', EMPTY: '', EQUALS: 'a=b=c' })
})

test('env output: multiline values, CRLF, odd lines, and missing markers', () => {
  const out = `noise\r\n${MARK}\r\nMULTI=line one\r\nline two\r\n  - not a var=really\r\nPATH=/usr/bin\r\n${MARK}\r\n`
  assert.deepEqual(parseEnvOutput(out, MARK), { MULTI: 'line one\nline two\n  - not a var=really', PATH: '/usr/bin' })
  // a value line before any NAME= is dropped, not glued onto nothing
  assert.deepEqual(parseEnvOutput(`${MARK}\n   orphan\nA=1\n${MARK}`, MARK), { A: '1' })
  // only the start marker (the shell was killed half way): nothing
  assert.deepEqual(parseEnvOutput(`${MARK}\nPATH=/usr/bin\n`, MARK), {})
  assert.deepEqual(parseEnvOutput('', MARK), {})
  // the marker must be a whole line, so a profile that echoes it inside text doesn't count
  assert.deepEqual(parseEnvOutput(`say ${MARK}\nPATH=/x\nsay ${MARK}`, MARK), {})
})

test('PATH merge: the login PATH first, the app\'s own entries after, no duplicates or relative entries', () => {
  assert.equal(mergePath('/opt/homebrew/bin:/usr/bin:.:/bin', '/usr/bin:/bin:/usr/sbin:/sbin'), '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin')
  assert.equal(mergePath(undefined, '/usr/bin:/bin'), '/usr/bin:/bin')
  assert.equal(mergePath('', undefined), undefined)
})

test('only PATH (and LANG when unset) is taken from the login shell, nothing secret', () => {
  const login = { PATH: '/opt/homebrew/bin:/usr/bin', LANG: 'de_DE.UTF-8', GITHUB_TOKEN: 'fake-not-a-token', AWS_PROFILE: 'x', SHELL: '/bin/zsh' }
  assert.deepEqual(loginEnvChanges(login, { PATH: '/usr/bin:/bin' }), { PATH: '/opt/homebrew/bin:/usr/bin:/bin', LANG: 'de_DE.UTF-8' })
  // the app's LANG stays; nothing to change when PATH already has it all
  assert.deepEqual(loginEnvChanges(login, { PATH: '/opt/homebrew/bin:/usr/bin', LANG: 'C' }), {})
  // no LANG anywhere, or a strange one: en_US.UTF-8
  assert.deepEqual(loginEnvChanges({}, { PATH: '/usr/bin', LANG: '' }), { LANG: 'en_US.UTF-8' })
  assert.deepEqual(loginEnvChanges({ LANG: '$(rm -rf ~)' }, { PATH: '/usr/bin' }), { LANG: 'en_US.UTF-8' })
})

const bash = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p))

test('a real login shell with a noisy profile, against a made-up HOME', { skip: !bash && 'no bash on this machine' }, async () => {
  const home = mkdtempSync(join(tmp, 'home-'))
  writeFileSync(
    join(home, '.bash_profile'),
    ['echo "Welcome to the fake profile"', 'printf "no newline at the end"', 'export PATH="/fake/login/bin:$PATH"', "export MULTI=$'one\\ntwo 2'", 'export LANG=en_GB.UTF-8'].join('\n') + '\n'
  )
  const saved = { HOME: process.env.HOME }
  process.env.HOME = home
  try {
    const env = await readLoginShellEnv(bash, 15_000)
    assert.match(env.PATH ?? '', /^\/fake\/login\/bin:/)
    // a continuation line that looks like NAME=value can't be told apart in env's output; only PATH is used
    assert.equal(env.MULTI, 'one\ntwo 2')
    assert.equal(env.LANG, 'en_GB.UTF-8')
  } finally {
    process.env.HOME = saved.HOME
    if (saved.HOME === undefined) delete process.env.HOME
  }
})

test('a login shell that hangs is cut off by the timeout and gives nothing', { skip: !bash && 'no bash on this machine' }, async () => {
  const home = mkdtempSync(join(tmp, 'home-'))
  writeFileSync(join(home, '.bash_profile'), 'sleep 30\n')
  const saved = process.env.HOME
  process.env.HOME = home
  try {
    const t = Date.now()
    assert.deepEqual(await readLoginShellEnv(bash, 1_500), {})
    assert.ok(Date.now() - t < 10_000)
  } finally {
    process.env.HOME = saved
    if (saved === undefined) delete process.env.HOME
  }
})

test('a shell that is not there gives nothing instead of throwing', async () => {
  assert.deepEqual(await readLoginShellEnv(join(tmp, 'no-such-shell'), 1_000), {})
})
