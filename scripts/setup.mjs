// `npm run setup` (#143): set up Corvid from a clone of its public repository, in one command.
//
//   1. Preflight: Node, git, npm, Claude Code (installed and signed in) and disk space. Stops with what to do
//      when something is missing; it never installs system software.
//   2. Git: a fresh clone becomes the user's own repository (see setup-git.mjs). Anything that isn't a fresh
//      clone is left alone and refused, unless --keep-git says to build it as it is.
//   3. Dependencies (npm ci, then Electron's binary, which Electron 44 no longer downloads by itself: #175) and the
//      project's own build.
//   4. Install and start through scripts/deploy.mjs (package check, install to this platform's folder, health
//      check, roll back to the previous install if the new one doesn't come up), the same flow on every platform
//      (#163; Linux was run for real in #173). Linux first prints the one-time sandbox step if it's needed (#158).
//
// Safe to run again: it rebuilds and reinstalls. It never touches Corvid's data folder, ~/.claude or git history.
// What it runs: git (local commands, and nothing against the network), npm ci, the project's build, deploy.mjs.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statfsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyRepo, convertRepo, deployOutcome, WINDOWS_PLACES } from './setup-git.mjs'
import { electronBinaryPresent, gitInstallHint, installProfile, nativeDeps } from '../src/main/platform/shared.mjs'
import { ensureElectronBinary } from './electron-binary.mjs'
import { checkSandbox } from './linux-sandbox.mjs'
import { lockfileRefusal, npmSupport, SUPPORTED_NPM } from './setup-npm.mjs'

delete process.env.ELECTRON_RUN_AS_NODE
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const isWin = process.platform === 'win32'

// Electron 44 and vite 8 need 22.12+; the tests and linux-check load .ts files directly (type stripping, unflagged from
// 22.18) and use node:sqlite. One minimum everywhere: package.json engines, INSTALL.md, corvidSelf.ts
const MIN_NODE = [22, 18]
const MIN_FREE_GB = 3

if (has('--help') || has('-h')) {
  console.log(`Set up Corvid from this clone: checks, dependencies, build, install and first launch.

Usage: npm run setup [-- options]

Options:
  --check      Only run the checks (Node, git, npm, Claude Code, disk space); change nothing.
  --keep-git   Leave git exactly as it is. Use it in a checkout that isn't a fresh clone (setup refuses
               to change the remotes of one), for example your own development checkout.
  --no-launch  Only build: don't install or start Corvid (npm run deploy does that later).
  --help       Show this help.

Running it again is safe: it rebuilds and reinstalls, and never touches your Corvid data,
~/.claude or your git history. Full guide: INSTALL.md`)
  process.exit(0)
}

const say = (msg = '') => console.log(msg)
const ok = (msg) => say(`  ok    ${msg}`)
const warn = (msg) => say(`  note  ${msg}`)
const problems = []
const fail = (msg, fix) => {
  say(`  !!    ${msg}`)
  problems.push({ msg, fix })
}
function stop(title, fixes) {
  say()
  say(title)
  for (const f of fixes) say(`  - ${f}`)
  process.exit(1)
}

const version = (cmd, argv, shell = false) => {
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'], shell }).trim()
  } catch {
    return undefined
  }
}

/** npm through the npm that started us (npm_execpath), so no shell or .cmd shim is needed. The spawnSync result. */
function npmRun(argv, opts = {}) {
  const cli = process.env.npm_execpath
  return cli
    ? spawnSync(process.execPath, [cli, ...argv], { cwd: root, stdio: 'inherit', ...opts })
    : spawnSync('npm', argv, { cwd: root, stdio: 'inherit', shell: isWin, ...opts })
}
const npm = (argv, opts) => npmRun(argv, opts).status === 0

/** The same places Corvid looks (src/main/platform/claude.ts claudeLocations): the native installer's ~/.local/bin and
 *  the VS Code extension; on macOS and Linux also ~/.claude/local, Homebrew's and /usr/local/bin (macOS), and PATH. */
function findClaude() {
  const exe = isWin ? 'claude.exe' : 'claude'
  const found = []
  const fixed = isWin
    ? [join(homedir(), '.local', 'bin', exe)]
    : [
        join(homedir(), '.local', 'bin', exe),
        join(homedir(), '.claude', 'local', exe),
        ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'] : []),
        ...(process.env.PATH ?? '').split(':').filter((d) => d.startsWith('/')).map((d) => join(d, exe))
      ]
  for (const p of fixed) if (existsSync(p) && !found.includes(p)) found.push(p)
  try {
    const ext = join(homedir(), '.vscode', 'extensions')
    for (const name of existsSync(ext) ? readdirSync(ext) : []) {
      if (!/^anthropic\.claude-code-\d/.test(name)) continue
      const p = join(ext, name, 'resources', 'native-binary', exe)
      if (existsSync(p)) found.push(p)
    }
  } catch {
    /* no extensions folder */
  }
  return found
}

// ---------- 1. preflight ----------

say('Corvid setup')
say()
say('Checking what Corvid needs…')

const [maj, min] = process.versions.node.split('.').map(Number)
if (maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1])) ok(`Node.js ${process.versions.node}`)
else fail(`Node.js ${process.versions.node} is too old: Corvid needs ${MIN_NODE.join('.')} or newer.`, 'Install the current LTS of Node.js from https://nodejs.org, open a new terminal, and run npm run setup again.')

const gitV = version('git', ['--version'])
if (gitV) ok(gitV)
else fail("git isn't installed (or isn't on PATH).", isWin ? 'Install git from https://git-scm.com, open a new terminal, and run npm run setup again.' : `${gitInstallHint()}, open a new terminal, and run npm run setup again.`)

const npmV = process.env.npm_execpath ? process.env.npm_config_user_agent?.match(/npm\/(\S+)/)?.[1] : version('npm', ['--version'], isWin) // npm is a .cmd shim on Windows
const npmFit = npmSupport(npmV)
const npmList = SUPPORTED_NPM.join(' and ')
if (npmFit === 'supported') ok(`npm ${npmV}`)
else if (npmV) warn(`npm ${npmV}: setup is tested with npm ${npmList}${npmFit === 'newer' ? '' : ' (the one that comes with Node.js 22 or 24)'}. Carrying on; if installing dependencies fails, run setup through npm 10: npx -y npm@10 run setup`)
else fail("npm isn't available.", 'npm comes with Node.js: reinstall Node.js from https://nodejs.org and run npm run setup again.')

const claude = findClaude()
if (claude.length) {
  ok(`Claude Code: ${claude[0]}`)
  // Signed in: only whether a sign-in exists is checked; nothing in ~/.claude is read or changed.
  const signedIn =
    existsSync(join(homedir(), '.claude', '.credentials.json')) || !!process.env.ANTHROPIC_API_KEY || !!process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (signedIn) ok('Claude Code is signed in')
  else if (process.platform === 'darwin') warn("Can't tell whether Claude Code is signed in (macOS keeps it in the Keychain). If it isn't, run claude and then /login.")
  else fail("Claude Code isn't signed in.", 'Run claude in a terminal, type /login and finish signing in, then run npm run setup again.')
} else {
  fail(
    "Claude Code isn't installed where Corvid looks for it.",
    isWin
      ? `Install Claude Code with its native installer (https://code.claude.com/docs/en/overview), which puts it in ~/.local/bin, or install the Claude Code extension in VS Code. Then run npm run setup again. (A claude installed only through npm or on PATH isn't found; you can point Corvid at it later in Settings.)`
      : `Install Claude Code with its native installer (https://code.claude.com/docs/en/overview), which puts it in ~/.local/bin, then open a new terminal and run npm run setup again.`
  )
}

try {
  const s = statfsSync(root)
  const freeGb = (s.bavail * s.bsize) / 1024 ** 3
  if (freeGb >= MIN_FREE_GB) ok(`${freeGb.toFixed(1)} GB free`)
  else fail(`Only ${freeGb.toFixed(1)} GB free on this drive; setup needs about ${MIN_FREE_GB} GB.`, 'Free up some space (or clone into a folder on another drive) and run npm run setup again.')
} catch {
  warn("Couldn't check the free disk space; setup needs about 3 GB.")
}

if (problems.length) stop('Setup stopped before changing anything. To fix:', problems.map((p) => p.fix))
if (has('--check')) {
  say()
  say('All checks passed. Nothing was changed (--check).')
  process.exit(0)
}

// ---------- 2. git: the user's own repository ----------

say()
say('Your own repository…')
if (has('--keep-git')) ok('Leaving git as it is (--keep-git).')
else {
  const repo = classifyRepo(root)
  if (repo.kind === 'installed') ok(`Already your own repository; updates come from ${repo.upstreamUrl} (fetch only).`)
  else if (repo.kind === 'fresh-clone') {
    convertRepo(root)
    ok(`Made this clone your own repository. The public repo is now the remote "upstream" (fetch only, push disabled),`)
    ok(`and nothing here pushes anywhere. Started from public commit ${repo.commit.slice(0, 12)}.`)
  } else
    stop(`Setup didn't change git, and stopped. ${repo.reason}`, [
      'Setup only turns a fresh clone of the public repository into your own repository, so it never rewrites a repository you already work in.',
      'To build and install this checkout as it is, without touching git: npm run setup -- --keep-git',
      'For a normal install, clone the public repository into a new folder and run npm run setup there (see INSTALL.md).'
    ])
}

// ---------- 3. dependencies and build ----------

say()
say('Installing dependencies (npm ci)…')
if (!npm(['ci', '--no-audit', '--no-fund'])) {
  // npm ci's lockfile refusal comes with a long usage dump; a dry run (no download, nothing changed) tells it apart
  const dry = npmRun(['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  const refused = lockfileRefusal(`${dry.stdout}${dry.stderr}`)
  if (refused)
    stop(`npm ${npmV ?? ''} refused this checkout's package-lock.json: it says the lockfile and package.json are out of sync${refused.length ? ` (missing or wrong: ${refused.join(', ')})` : ''}.`, [
      `That's npm's strict lockfile check, not a problem with your computer or your connection. Setup is tested with npm ${npmList}.`,
      'Run setup through npm 10 instead, which changes nothing in the checkout: npx -y npm@10 run setup',
      "Don't run npm install to \"fix\" it: that rewrites package-lock.json and makes later updates conflict.",
      'If npm 10 refuses it too, please report it with the output above (see INSTALL.md, Troubleshooting).'
    ])
  stop('Installing dependencies failed (see above).', ['Check your internet connection and run npm run setup again.', 'If it keeps failing, delete the node_modules folder and try again.'])
}
// Electron 44's binary is opt-in (#175): the postinstall usually got it, but not with --ignore-scripts or offline
ensureElectronBinary(root)
// this platform's prebuilt terminal library and Electron's binary (#154): npm skips them quietly when it can't get them
const native = nativeDeps()
const nm = join(root, 'node_modules')
const missing = [existsSync(join(nm, native.pty)) ? '' : native.pty, electronBinaryPresent(nm) ? '' : native.electron].filter(Boolean)
if (missing.length)
  stop(`Dependencies are installed, but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing.`, [
    'Check your internet connection and run npm run setup again.',
    "To get Electron's binary on its own: node node_modules/electron/install.js (it uses ELECTRON_MIRROR and your proxy settings if they're set).",
    `If it keeps failing, delete the node_modules folder and try again. The terminal library ships prebuilt for ${process.platform}-${process.arch}, so no compiler is needed.`
  ])

const profile = installProfile(root)
// as the messages show them: the installed app and the data folder
const places = isWin
  ? WINDOWS_PLACES
  : process.platform === 'darwin'
    ? { exe: '~/Applications/Corvid.app', data: '~/Library/Application Support/Corvid' }
    : { exe: `${profile.shownPath}/corvid (or Corvid in the app menu)`, data: '~/.config/Corvid' }

if (has('--no-launch')) {
  say()
  say('Building…')
  if (!npm(['run', 'build'])) stop('The build failed (see above).', ['Run npm run setup again; if it fails the same way, see Troubleshooting in INSTALL.md.'])
  say()
  say('Built. To install and start Corvid: npm run deploy')
  process.exit(0)
}

// Linux (#158): Chromium's sandbox needs a one-time sudo step where AppArmor restricts user namespaces
const sandbox = checkSandbox([profile.executable(profile.installDir), join(root, 'node_modules', nativeDeps().electron)])
if (sandbox) {
  say()
  for (const line of sandbox) say(line)
}

// ---------- 4. install and first launch ----------

say()
say(`Building, installing to ${profile.shownPath} and starting Corvid…`)
warn('If Corvid is already running it closes and restarts, which ends any running agents.')
const r = spawnSync(process.execPath, [join(root, 'scripts', 'deploy.mjs')], { cwd: root, stdio: 'inherit' })
const o = deployOutcome(r.status, places)
if (o) stop(o.title, sandbox ? [...o.fixes, "If it didn't start because of Chromium's sandbox, do the one-time step printed above first."] : o.fixes)
say()
say('Done. Corvid is installed and running.')
say(`Start it later from ${places.exe}${isWin ? ' (pin it to the taskbar)' : ''}, and rebuild after changes`)
say('with npm run deploy. On first launch this folder becomes the pinned "Corvid" project.')
