// Tests for #157: Open in VS Code and "Resume in a terminal window" per platform (src/main/platform/os.ts).
// The command construction for every platform runs here on any machine with made-up PATHs; no terminal or VS Code
// is started. Where a POSIX `sh` is around (macOS, Linux, Git Bash on Windows) the quoting is checked for real:
// shQuote's output and the generated terminal script are run by sh and must hand back every nasty string
// unchanged, without running anything inside them. The win32 commands stay pinned in test-platform.mjs.
//
//   npm run test-launch

import { register } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(s, c, next) {
      if (s === 'electron') return { url: 'data:text/javascript,export const app = {}', shortCircuit: true }
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

const tmp = mkdtempSync(join(tmpdir(), 'corvid-launch-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0
/** forward slashes, which sh on every platform (and Git Bash on Windows) takes */
const fwd = (p) => p.replace(/\\/g, '/')

// Strings a directory, session id or title could hold. Each must come back byte for byte.
const NASTY = [
  'plain',
  'with space',
  "it's",
  "''",
  '"double"',
  '$HOME',
  '${HOME}',
  '$(touch CANARY)',
  '`touch CANARY`',
  'back\\slash\\',
  'new\nline',
  'tab\there',
  'cr\rhere',
  ';&|<>*?~!#',
  '-leading-dash',
  '--resume',
  "'; touch CANARY; echo '",
  'unicode ünï 雀',
  ''
]
// Git Bash's sh on Windows drops a \r from the script text it reads (MSYS text handling), so there a CR can't
// survive; real POSIX shells keep it
const BACK = process.platform === 'win32' ? NASTY.map((n) => n.replace(/\r/g, '')) : NASTY

// ---------- shQuote ----------

test('shQuote wraps in single quotes and turns each \' into \'\\\'\'', () => {
  assert.equal(P.shQuote('a b'), "'a b'")
  assert.equal(P.shQuote("it's"), "'it'\\''s'")
  assert.equal(P.shQuote(''), "''")
  assert.equal(P.shQuote('$x `y` "z"\n'), "'$x `y` \"z\"\n'")
  assert.throws(() => P.shQuote('a\0b'), /NUL/)
})

test('sh gets every nasty string back unchanged from shQuote, and runs none of it', { skip: !hasSh && 'no sh here' }, () => {
  const cwd = mkdtempSync(join(tmp, 'q-'))
  const r = spawnSync('sh', ['-c', `printf '%s\\0' ${NASTY.map(P.shQuote).join(' ')}`], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.stdout.split('\0').slice(0, -1), BACK)
  assert.equal(existsSync(join(cwd, 'CANARY')), false, 'nothing inside the quotes ran')
})

// ---------- the terminal script (macOS and Linux) ----------

test('terminalScript: deletes itself, cds, sets the title and execs, every value quoted', () => {
  const s = P.terminalScript('/tmp/corvid-term-x/resume.sh', "/home/u/it's", '/usr/bin/claude', ['--resume', 'a$b'], 'T')
  assert.equal(
    s,
    [
      '#!/bin/sh',
      '# Written by Corvid to resume a Claude Code session in a terminal window. It deletes itself.',
      "rm -f -- '/tmp/corvid-term-x/resume.sh'",
      "rmdir -- '/tmp/corvid-term-x' 2>/dev/null",
      "cd -- '/home/u/it'\\''s' || exit 1",
      "printf '\\033]0;%s\\007' 'T'",
      "exec '/usr/bin/claude' '--resume' 'a$b'",
      ''
    ].join('\n')
  )
  // no title, no printf; control characters in a title become spaces
  assert.doesNotMatch(P.terminalScript('/t/r.sh', '/', '/c', []), /printf/)
  assert.match(P.terminalScript('/t/r.sh', '/', '/c', [], 'a\x07\x1b]0;evil\nb'), /printf '\\033\]0;%s\\007' 'a  \]0;evil b'\n/)
})

test('the terminal script really runs: right folder, every argument and the title intact, nothing injected, script gone', { skip: !hasSh && 'no sh here' }, () => {
  const base = mkdtempSync(join(tmp, 's-'))
  // the nastiest folder name every file system takes (no " or newline on Windows)
  const dirName = process.platform === 'win32' ? "a b$c`d'e;&(x)" : "a b$c`d'e;&(x)\"\nz"
  const cwd = join(base, dirName)
  mkdirSync(cwd)
  const scriptDir = join(base, 'corvid-term-test')
  mkdirSync(scriptDir)
  const script = fwd(join(scriptDir, 'resume.sh'))
  const title = 'title $(touch CANARY) `x` \'q\''
  // "claude" here is sh printing its folder's name and its arguments
  const args = ['-c', 'printf "%s\\0" "${PWD##*/}" "$@"', 'arg0', ...NASTY]
  writeFileSync(script, P.terminalScript(script, fwd(cwd), '/bin/sh', args, title), { mode: 0o700 })
  const r = spawnSync('sh', [script], { cwd: base, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const head = `\x1b]0;${title}\x07`
  assert.ok(r.stdout.startsWith(head), JSON.stringify(r.stdout.slice(0, 80)))
  const out = r.stdout.slice(head.length).split('\0').slice(0, -1)
  assert.deepEqual(out, [dirName, ...BACK])
  assert.equal(existsSync(script), false, 'the script deleted itself')
  assert.equal(existsSync(scriptDir), false, 'and its folder')
  for (const d of [base, cwd]) assert.equal(existsSync(join(d, 'CANARY')), false, 'nothing in a value ran')
})

// ---------- the external terminal command ----------

const linux = (paths, TERMINAL) => ({
  env: { PATH: '/usr/local/bin:/usr/bin', ...(TERMINAL === undefined ? {} : { TERMINAL }) },
  exists: (p) => paths.includes(p)
})
const S = '/tmp/corvid-term-Ab12_x/resume.sh'

test('macOS: Terminal.app runs the .command script through open -a Terminal; nothing else on the command line', () => {
  const script = '/var/folders/x/T/corvid-term-ab/resume.command'
  // the directory, session id and title only ever go in the script
  assert.deepEqual(P.externalTerminal("/Users/u/it's $x", '/opt/homebrew/bin/claude', ['--resume', '`id`'], 'a;b', 'darwin', { script }), {
    file: '/usr/bin/open',
    args: ['-a', 'Terminal', script]
  })
  assert.throws(() => P.externalTerminal('/p', '/c', [], undefined, 'darwin', { script: '/tmp/x/resume.sh' }), /\.command/)
  assert.equal(P.terminalAvailable('darwin', {}, () => false), true)
})

test('the script path must be absolute and plain on macOS and Linux (terminals may re-split it)', () => {
  for (const os of ['darwin', 'linux']) {
    for (const script of [undefined, '', 'resume.command', '/tmp/a b/resume.command', "/tmp/a'b/resume.command", '/tmp/$x/resume.command', '/tmp/a\nb/resume.command', 'C:\\t\\resume.command']) {
      assert.throws(() => P.externalTerminal('/p', '/c', [], undefined, os, { script, ...linux(['/usr/bin/xterm']) }), /Unsafe terminal script path/, `${os} ${script}`)
    }
  }
})

test('Linux: $TERMINAL first, then x-terminal-emulator, gnome-terminal, konsole, xterm, each with its own argument form', () => {
  const ext = (paths, TERMINAL) => P.externalTerminal('/home/u/p q', '/usr/bin/claude', ['--resume', 'x'], 't', 'linux', { script: S, ...linux(paths, TERMINAL) })
  const all = ['/usr/bin/x-terminal-emulator', '/usr/bin/gnome-terminal', '/usr/bin/konsole', '/usr/bin/xterm']
  assert.deepEqual(ext(all), { file: '/usr/bin/x-terminal-emulator', args: ['-e', S] })
  assert.deepEqual(ext(all.slice(1)), { file: '/usr/bin/gnome-terminal', args: ['--', S] })
  assert.deepEqual(ext(all.slice(2)), { file: '/usr/bin/konsole', args: ['-e', S] })
  assert.deepEqual(ext(all.slice(3)), { file: '/usr/bin/xterm', args: ['-e', S] })
  assert.equal(ext([]), null)
  // $TERMINAL wins, by name on the PATH or as an absolute path, with the right form for terminals that differ
  assert.deepEqual(ext([...all, '/usr/local/bin/kitty'], 'kitty'), { file: '/usr/local/bin/kitty', args: [S] })
  assert.deepEqual(ext([...all, '/usr/bin/xfce4-terminal'], 'xfce4-terminal'), { file: '/usr/bin/xfce4-terminal', args: ['-x', S] })
  assert.deepEqual(ext(['/usr/bin/wezterm'], 'wezterm'), { file: '/usr/bin/wezterm', args: ['start', '--', S] })
  assert.deepEqual(ext(['/usr/bin/foot'], 'foot'), { file: '/usr/bin/foot', args: [S] })
  assert.deepEqual(ext(['/opt/al/alacritty', ...all], '/opt/al/alacritty'), { file: '/opt/al/alacritty', args: ['-e', S] })
  assert.deepEqual(ext(['/usr/bin/terminator'], '  terminator  '), { file: '/usr/bin/terminator', args: ['-x', S] })
  // a $TERMINAL that isn't installed, isn't one word, or is a relative path falls through to the list
  for (const bad of ['missing', 'kitty --single-instance', 'xterm;rm -rf ~', '$(id)', '`id`', '../bin/kitty', 'bin/kitty', "it's", '']) {
    assert.deepEqual(ext([...all, '/usr/bin/kitty', '/usr/bin/missing'].filter((p) => !p.endsWith('missing')), bad), { file: '/usr/bin/x-terminal-emulator', args: ['-e', S] }, bad)
  }
})

test('Linux: the button hides when no terminal is found', () => {
  assert.equal(P.terminalAvailable('linux', ...Object.values(linux([]))), false)
  assert.equal(P.terminalAvailable('linux', ...Object.values(linux(['/usr/bin/xterm']))), true)
  assert.equal(P.terminalAvailable('linux', ...Object.values(linux(['/usr/bin/kitty'], 'kitty'))), true)
  assert.equal(P.terminalAvailable('win32', {}, () => false), true, 'Windows always shows it, as before')
  assert.deepEqual(P.findTerminal('win32'), { name: 'wt', file: 'wt.exe' })
})

test('win32 externalTerminal still returns just wt.exe and its arguments (no script)', () => {
  assert.deepEqual(Object.keys(P.externalTerminal('D:\\p', 'C:\\c\\claude.exe', [], undefined, 'win32')), ['file', 'args'])
})

// ---------- VS Code ----------

const mac = (paths) => ({ env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, exists: (p) => paths.includes(p) })

test('POSIX: code from the PATH, paths as plain arguments with no shell and no hand quoting', () => {
  const probe = linux(['/usr/bin/code'])
  for (const os of ['linux', 'darwin']) {
    for (const dir of NASTY.filter(Boolean).map((n) => `/home/u/${n}`)) {
      assert.deepEqual(P.vscodeCommand([dir], os, probe), { file: '/usr/bin/code', args: [dir], verbatim: false }, dir)
    }
    assert.deepEqual(P.vscodeCommand(['-r', '/home/u/a.ts'], os, probe).args, ['-r', '/home/u/a.ts'])
    assert.deepEqual(P.vscodeCommand(['/home/u', '/home/u/a b.ts'], os, probe).args, ['/home/u', '/home/u/a b.ts'])
  }
})

test('POSIX: only absolute paths and -r get through, so nothing turns into a code flag', () => {
  for (const os of ['linux', 'darwin']) {
    for (const bad of ['relative', '-', '--install-extension', '-rf', '--', '~/x', '', 'C:\\x', '/a\0b']) {
      assert.throws(() => P.vscodeCommand([bad], os, linux(['/usr/bin/code'])), /Not an absolute path/, `${os} ${JSON.stringify(bad)}`)
    }
  }
})

test('macOS without code on the PATH: open -b com.microsoft.VSCode with the paths (and without -r)', () => {
  assert.deepEqual(P.vscodeCommand(["/Users/u/it's here"], 'darwin', mac([])), { file: '/usr/bin/open', args: ['-b', 'com.microsoft.VSCode', "/Users/u/it's here"], verbatim: false })
  assert.deepEqual(P.vscodeCommand(['-r', '/Users/u/a.ts'], 'darwin', mac([])).args, ['-b', 'com.microsoft.VSCode', '/Users/u/a.ts'])
  // the login shell's PATH (#152) puts code back in front
  assert.deepEqual(P.vscodeCommand(['/Users/u'], 'darwin', { env: { PATH: '/opt/homebrew/bin:/usr/bin' }, exists: (p) => p === '/opt/homebrew/bin/code' }).file, '/opt/homebrew/bin/code')
})

test('Linux without code: null, so launch.ts opens the vscode://file URI', () => {
  assert.equal(P.vscodeCommand(['/home/u'], 'linux', linux([])), null)
  assert.equal(P.vscodeFileUri('/home/u/a b#c?d%e'), 'vscode://file/home/u/a%20b%23c%3Fd%25e')
  assert.equal(P.vscodeFileUri("/home/u/it's/雀"), "vscode://file/home/u/it's/%E9%9B%80")
})
