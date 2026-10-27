// A short check of Corvid's Linux behaviour on a headless box (#164, part of #142): run it from a fresh clone, paste
// the report back. It uses the app's own platform layer (src/main/platform, #149 to #153) through Node's built-in
// TypeScript support, so it needs no npm install, no Electron and no build.
//
//   node scripts/linux-check.mjs            the plain-text report (about 30 lines)
//   node scripts/linux-check.mjs --json     the same as JSON
//   node scripts/linux-check.mjs --help
//
// Needs Node 22.18 or newer, or 23.6+ (an older 22.x is retried once with --experimental-strip-types), and git. A signed-in claude is
// optional. Exit code 0 only when no check failed.
//
// Safety: it refuses to run as root. Everything it writes is in one temp folder it makes (mkdtemp under $TMPDIR or
// /tmp, named corvid-linux-check-*) and deletes at the end, also on a failure or Ctrl+C. It never writes to ~/.claude,
// ~/.config, ~/.ssh or any real data folder (Corvid's data folder is only worked out, never opened), makes no
// system-wide change, opens no ports and sends nothing anywhere. The only processes it kills are the ones it
// started, by pid and process group, never by name. Its git commands get an empty global config from the temp folder
// (GIT_CONFIG_GLOBAL, git 2.32+; an older git still reads ~/.gitconfig, but nothing writes it). The report has no secrets, no environment dump and no home path (shown as ~).
//
// The commands it runs, all of them:
//   git --version, and in the temp folder: git init / add / commit / worktree add / worktree prune / worktree list /
//     worktree remove / branch -d / check-ignore / rev-parse / rev-list / status / symbolic-ref (the app's agentGit)
//   rm node_modules                       removes the worktree's node_modules symlink, never the folder behind it
//   ps -A -o pid=,ppid=,pgid=,stat=        the process list, for the process-tree check (the app's killTree)
//   /bin/sh -c '…'                         a small shell that starts a sleep ignoring SIGHUP and SIGTERM; killed by pid
//   ps -A -o pid=,ppid=,command=           the process list deploy.mjs matches on the install folder's path (#154)
//   <temp>/install/app/corvid -e '…'       a copy of this Node, idling, standing in for an installed app; killed by pid
//   <your login shell> -i -l -c 'printf …; env; printf …'   your login shell's PATH (only PATH is kept, never printed)
//   <claude> --version                     for each place the Claude CLI may be installed that exists on this box
//
// Adding a check: append { name, run } to CHECKS below. run(ctx) returns pass(detail), skip(why), or throws (a
// FAIL with the error's first line). A failing check never stops the others.

// a namespace import and no import.meta.dirname, so an old Node gets to main()'s version message instead of failing here
import * as nodeModule from 'node:module'
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, release, tmpdir, type } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

// ---------- pure parts (scripts/test-linux-check.mjs runs these on any machine) ----------

export const USAGE = `Usage: node scripts/linux-check.mjs [--json] [--help]

Checks Corvid's Linux behaviour on this machine without installing or building anything:
platform folders, deny rules, path keys, a real git worktree, the Claude CLI lookup, shells,
ending a process tree, and the login-shell PATH. Works in a temp folder it deletes afterwards.
Refuses to run as root. Prints a short report to paste back; exit code 0 when nothing failed.

  --json   machine-readable output
  --help   this text`

/** The command line as { json, help }, or { error } for anything else. */
export function parseArgs(argv) {
  const opts = { json: false, help: false }
  for (const a of argv) {
    if (a === '--json') opts.json = true
    else if (a === '--help' || a === '-h') opts.help = true
    else return { ...opts, error: `unknown option ${a}` }
  }
  return opts
}

/** Whether this Node can load the app's TypeScript: 22.7+ (with the flag below before 22.18), or 23+. */
export function nodeOk(version) {
  const [major, minor] = version.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 7)
}

export const pass = (detail = '') => ({ status: 'PASS', detail })
export const skip = (detail) => ({ status: 'SKIP', detail })

/** One line, with the home folder shown as ~ (and nothing longer than `max`). */
export function redact(text, home = homedir(), max = 160) {
  let s = String(text ?? '').split(/\r?\n/).find((l) => l.trim()) ?? ''
  if (home && home.length > 1) s = s.split(home).join('~')
  s = s.trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** Runs every check in order; a throw is that check's FAIL, never the end of the run. */
export async function runChecks(checks, ctx, home = homedir()) {
  const results = []
  for (const c of checks) {
    const t = Date.now()
    let r
    try {
      r = (await c.run(ctx)) ?? pass()
      if (!['PASS', 'SKIP'].includes(r.status)) r = { status: 'FAIL', detail: `bad check result: ${JSON.stringify(r)}` }
    } catch (e) {
      r = { status: 'FAIL', detail: e?.message ?? String(e) }
    }
    results.push({ name: c.name, status: r.status, detail: redact(r.detail, home), ms: Date.now() - t })
  }
  return results
}

export function counts(results) {
  const n = { PASS: 0, FAIL: 0, SKIP: 0 }
  for (const r of results) n[r.status]++
  return n
}

export const exitCode = (results) => (counts(results).FAIL ? 1 : 0)

/** The plain-text report. `info` is { os, kernel, node, git, temp }. */
export function formatReport(info, results) {
  const n = counts(results)
  const width = Math.max(...results.map((r) => r.name.length), 10)
  const lines = [
    'Corvid Linux check (#164)',
    `OS:     ${info.os}`,
    `Kernel: ${info.kernel}`,
    `Node:   ${info.node}    git: ${info.git}`,
    `Temp:   ${info.temp} (deleted: ${info.tempDeleted ? 'yes' : 'NO'})`,
    ''
  ]
  for (const r of results) lines.push(`${r.status}  ${r.name.padEnd(width)}${r.detail ? `  ${r.detail}` : ''}`)
  lines.push('', `${n.PASS} passed, ${n.FAIL} failed, ${n.SKIP} skipped`)
  return lines.join('\n')
}

export const formatJson = (info, results) => JSON.stringify({ ...info, checks: results, counts: counts(results) }, null, 2)

/** Whether `dir` is a temp folder this script made, the only folder it ever deletes. */
export const isOurTemp = (dir, tmp = tmpdir()) => typeof dir === 'string' && basename(dir).startsWith('corvid-linux-check-') && dir.startsWith(tmp)

/** The tree's pids from a ps listing (the platform layer's parsePsTree), those that are still running (not zombies). */
export const stillRunning = (pids, list) => pids.filter((p) => list.some((e) => e.pid === p && !e.zombie))

/** The stand-in for an installed app in the deploy check: a copy of this Node (`execPath`) that idles for `ms`.
 *  Not a copy of sleep: on Ubuntu 25.10+ sleep is the uutils multicall binary, which picks its tool by its own file
 *  name, so a copy named corvid isn't sleep and exits at once. Node runs the -e script whatever it's called. */
export const standInApp = (execPath, ms = 300_000) => ({ source: execPath, args: ['-e', `setTimeout(() => {}, ${Math.round(ms)})`] })

// ---------- the checks ----------

const expect = (cond, why) => {
  if (!cond) throw new Error(why)
}
const eq = (got, want, what) => expect(got === want, `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
const isLinux = () => process.platform === 'linux'
const posixOnly = () => (process.platform === 'win32' ? skip('POSIX only, this is Windows') : null)
const linuxOnly = () => (isLinux() ? null : skip(`Linux only, this is ${process.platform}`))
/** Linux-shaped inputs: the real home on Linux, a made-up one elsewhere. */
const linuxHome = (ctx) => (isLinux() ? ctx.home : '/home/tester')

function onPathPosix(exe, env = process.env) {
  for (const d of (env.PATH ?? '').split(':')) {
    if (!d.startsWith('/')) continue
    try {
      accessSync(join(d, exe), constants.X_OK)
      return join(d, exe)
    } catch {
      /* not here */
    }
  }
  return null
}

const run = (file, args, opts = {}) =>
  new Promise((resolve) => execFile(file, args, { timeout: 15_000, encoding: 'utf8', ...opts }, (err, stdout, stderr) => resolve({ err, stdout: stdout ?? '', stderr: stderr ?? '' })))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The platform layer's functions the checks below use, by the ctx module they come from. */
export const USES = {
  shared: ['platformOf', 'appDataDir', 'dataDirCandidates', 'realDataDir', 'toNative', 'killTree', 'parsePsTree', 'psTreeCommand', 'treeOf', 'installProfile', 'listProcessesCommand', 'parseProcessList', 'insideDir'],
  paths: ['absRule'],
  keys: ['pathKey', 'within', 'samePath'],
  claude: ['claudeLocations', 'findClaude'],
  shells: ['shellList', 'projectShell'],
  loginEnv: ['loginShell', 'readLoginShellEnv', 'mergePath'],
  deny: ['dataFolderRules'],
  agentGit: ['prepareBranch', 'linkDeps', 'cleanUp'],
  keyring: ['secretStorageStatus', 'NO_KEYRING']
}

/** Which keyring a list of D-Bus names shows (the session bus's running and activatable names): the Secret Service
 *  (GNOME Keyring and friends, what Electron's gnome_libsecret uses) or KWallet, else null. */
export function keyringOnBus(names) {
  if (names.includes('org.freedesktop.secrets')) return 'Secret Service (GNOME Keyring or similar)'
  if (names.some((n) => /^org\.kde\.kwalletd\d*$/.test(n))) return 'KWallet'
  return null
}

/** The quoted names in dbus-send --print-reply output. */
export const busNames = (out) => [...out.matchAll(/string "([^"]+)"/g)].map((m) => m[1])

export const CHECKS = [
  {
    name: 'platform layer loaded',
    async run(ctx) {
      const missing = Object.entries(USES).flatMap(([m, names]) => names.filter((n) => ctx[m]?.[n] === undefined).map((n) => `${m}.${n}`))
      expect(!missing.length, `missing: ${missing.join(', ')} (renamed? update scripts/linux-check.mjs)`)
      return pass(`${Object.values(USES).flat().length} functions from src/main/platform and friends`)
    }
  },
  {
    name: 'platform and data folders',
    async run(ctx) {
      const { platformOf, appDataDir, dataDirCandidates, realDataDir } = ctx.shared
      const home = linuxHome(ctx)
      const env = isLinux() ? ctx.env : {}
      const appData = appDataDir('linux', env, home)
      eq(appData, env.XDG_CONFIG_HOME || `${home}/.config`, 'appData')
      eq(dataDirCandidates(appData, 'linux').join(), `${appData}/Corvid`, 'data folder candidates')
      eq(realDataDir(appData, () => true, 'linux'), `${appData}/Corvid`, 'data folder')
      eq(platformOf('freebsd'), 'linux', 'other Unixes count as Linux')
      const p = platformOf(process.platform)
      if (p !== 'linux') return skip(`this is ${p}; the Linux values were worked out for a made-up home`)
      return pass(`linux; data folder ${appData}/Corvid${env.XDG_CONFIG_HOME ? ' (XDG_CONFIG_HOME)' : ''}`)
    }
  },
  {
    name: 'deny-rule paths',
    async run(ctx) {
      const { absRule } = ctx.paths
      // what #150 pinned in scripts/test-deny-platforms.mjs
      const pinned = [
        ['/home/x/.config/Corvid', '//home/x/.config/Corvid'],
        ['/root/.config/Corvid', '//root/.config/Corvid'],
        ['/home/x/.config/Corvid/', '//home/x/.config/Corvid'],
        ['/home//x///.config/Corvid//', '//home/x/.config/Corvid'],
        ['/home/x/repo/../.config/Corvid', '//home/x/.config/Corvid'],
        ['/home/x/Code/other app', '//home/x/Code/other app'],
        ['/home/x/repo [old]', '//home/x/repo \\[old\\]']
      ]
      for (const [p, want] of pinned) eq(absRule(p, 'linux'), want, `absRule(${p})`)
      const rules = ctx.deny.dataFolderRules('/home/x/.config/Corvid', '/home/x/.config', 'linux')
      eq(rules.join(), '//home/x/.config/Corvid/**', 'data folder rules')
      // a real folder with a space on this machine: exactly two slashes, never three
      const real = join(ctx.tmp, 'with space')
      mkdirSync(real)
      const rule = absRule(realpathSync(real), 'linux')
      if (process.platform === 'win32') return pass(`${pinned.length} pinned paths match (the real-folder rule is POSIX only)`)
      expect(rule.startsWith('//') && !rule.startsWith('///'), `rule for a temp folder starts with three slashes: ${rule}`)
      return pass(`${pinned.length} pinned paths match, a real temp folder gives //…/with space`)
    }
  },
  {
    name: 'path keys and toNative',
    async run(ctx) {
      const { pathKey, within, samePath } = ctx.keys
      const { toNative } = ctx.shared
      eq(pathKey('/home/x/Repo/', 'linux'), '/home/x/Repo', 'pathKey keeps case and drops the trailing /')
      eq(pathKey('/', 'linux'), '/', 'pathKey of the root')
      eq(within('/home/x/repo/src', '/home/x/repo', 'linux'), true, 'within, inside')
      eq(within('/home/x/repo-worktrees/a', '/home/x/repo', 'linux'), false, 'within, a sibling with the same prefix')
      eq(samePath('/home/x/repo ', '/home/x/repo/', 'linux'), true, 'samePath, git spacing')
      eq(samePath('/home/x/Repo', '/home/x/repo', 'linux'), false, 'samePath, case counts on Linux')
      eq(toNative('/home/x/a b/c', 'linux'), '/home/x/a b/c', 'toNative leaves POSIX paths alone')
      if (process.platform === 'win32') return pass('POSIX keys checked with made-up paths')
      const real = realpathSync(ctx.tmp)
      // macOS folds case in keys (its volumes are case-insensitive), and its temp folder has capitals (/private/var/folders/…/T/)
      eq(pathKey(real + '/'), process.platform === 'darwin' ? real.toLowerCase() : real, 'pathKey of the temp folder on this machine')
      return pass('POSIX keys, and the temp folder keyed on this machine')
    }
  },
  {
    name: 'git worktree + node_modules link',
    async run(ctx) {
      const not = posixOnly()
      if (not) return not
      if (!ctx.gitVersion) return skip('git not found')
      const A = ctx.agentGit
      const repo = join(ctx.tmp, 'Repo')
      mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
      writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
      writeFileSync(join(repo, 'README.md'), 'test\n')
      const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      // git init -b needs git 2.28; symbolic-ref works on any git, whatever init.defaultBranch says
      g(repo, 'init', '-q')
      g(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main')
      g(repo, 'add', '-A')
      g(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first')
      const plan = await A.prepareBranch(repo, 164, 'Linux check')
      expect(plan.kind === 'branch', `prepareBranch gave no worktree: ${plan.reason}`)
      const tree = plan.b.worktree
      const link = join(tree, 'node_modules')
      expect(lstatSync(link).isSymbolicLink(), 'node_modules in the worktree is not a symlink')
      eq(g(tree, 'status', '--porcelain').trim(), '', 'git status in the worktree (the link must be ignored)')
      // what workers are told to run: removes the link, never the packages behind it
      execFileSync('rm', ['node_modules'], { cwd: tree })
      expect(!existsSync(link), 'rm node_modules left the link')
      expect(existsSync(join(repo, 'node_modules', 'pkg', 'index.js')), 'rm node_modules removed the packages behind the link')
      A.linkDeps(repo, tree)
      expect(lstatSync(link).isSymbolicLink(), 'linkDeps did not make the link again')
      const kept = await A.cleanUp(plan.b)
      expect(kept === null, `cleanUp: ${kept}`)
      expect(!existsSync(tree), 'the worktree is still there after cleanUp')
      expect(existsSync(join(repo, 'node_modules', 'pkg', 'index.js')), 'cleanUp removed the packages behind the link')
      eq(g(repo, 'branch', '--list', 'task-164-*').trim(), '', 'task branch after cleanUp')
      return pass('made, link ignored, rm node_modules kept the target, removed')
    }
  },
  {
    name: 'Claude CLI lookup',
    async run(ctx) {
      const not = posixOnly()
      if (not) return not
      const { claudeLocations, findClaude } = ctx.claude
      const l = claudeLocations('linux', ctx.home)
      const probe = {
        exists: (p) => {
          try {
            accessSync(p, constants.X_OK)
            return true
          } catch {
            return false
          }
        },
        readdir: (d) => readdirSync(d),
        version: async (p) => /(\d+\.\d+\.\d+)/.exec((await run(p, ['--version'])).stdout)?.[1] ?? null
      }
      const looked = [...l.fixed.map((f) => f.source), 'VS Code extension', 'PATH']
      ctx.claudeFound = await findClaude(probe, 'linux', ctx.home, process.env)
      if (!ctx.claudeFound) return pass(`not found (looked in ${looked.join(', ')}); install: ${ctx.installUrl}`)
      return pass(`found via ${ctx.claudeFound.source}: ${ctx.claudeFound.path}`)
    }
  },
  {
    name: 'claude --version',
    async run(ctx) {
      if (!ctx.claudeFound) return skip('no claude on this box (optional)')
      const r = await run(ctx.claudeFound.path, ['--version'])
      expect(!r.err, `claude --version failed: ${r.err?.message}`)
      return pass(r.stdout.trim())
    }
  },
  {
    name: 'shells',
    async run(ctx) {
      const not = posixOnly()
      if (not) return not
      const { shellList, projectShell } = ctx.shells
      const login = process.env.SHELL ? basename(process.env.SHELL) : '(unset)'
      const installed = shellList('linux').map((s) => s.id)
      const proj = projectShell('linux')
      expect(existsSync(proj.file), `the project shell ${proj.file} does not exist`)
      expect(installed.length > 0, 'no shell found')
      return pass(`$SHELL ${login}; installed: ${[...new Set(installed)].join(', ')}; project terminal: ${basename(proj.file)} ${proj.args.join(' ')}`)
    }
  },
  {
    name: 'killTree (SIGHUP-ignoring grandchild)',
    async run(ctx) {
      const not = posixOnly()
      if (not) return not
      const { killTree, parsePsTree, psTreeCommand, treeOf } = ctx.shared
      const ps = await run(psTreeCommand.file, psTreeCommand.args)
      if (ps.err) return skip('ps not found (install procps); killTree then only signals the root pid')
      // root sh -> inner sh -> sleep; the inner sh and its sleep ignore SIGHUP and SIGTERM, so SIGKILL is needed
      const script = `/bin/sh -c 'trap "" HUP TERM; sleep 300; :' & wait`
      const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
      // detached: its own process group, which everything below it stays in (a non-interactive sh makes no new groups)
      ctx.groups.push(child.pid)
      let tree = []
      for (let i = 0; i < 30 && tree.length < 3; i++) {
        await sleep(100)
        tree = treeOf(child.pid, parsePsTree((await run(psTreeCommand.file, psTreeCommand.args)).stdout))
      }
      expect(tree.length >= 3, `the test tree did not start (${tree.length} processes)`)
      const err = await killTree(child.pid, { graceMs: 1000, timeoutMs: 6000 })
      expect(!err, `killTree: ${err?.message}`)
      await sleep(200)
      const left = stillRunning(tree, parsePsTree((await run(psTreeCommand.file, psTreeCommand.args)).stdout))
      expect(!left.length, `${left.length} of ${tree.length} processes still running after killTree`)
      return pass(`${tree.length} processes ended, nothing left`)
    }
  },
  {
    name: 'login-shell PATH merge',
    async run(ctx) {
      const not = posixOnly()
      if (not) return not
      const L = ctx.loginEnv
      eq(L.mergePath('/a:/b', '/b:/c:rel:'), '/a:/b:/c', 'mergePath with made-up PATHs')
      const shell = L.loginShell()
      const login = await L.readLoginShellEnv(shell)
      if (!login.PATH) return skip(`${basename(shell)} -i -l printed no PATH in 5 s (a profile that waits for input, or no shell)`)
      const merged = L.mergePath(login.PATH, process.env.PATH)
      const mine = login.PATH.split(':').filter((d) => d.startsWith('/'))
      expect(merged.split(':').slice(0, new Set(mine).size).join(':') === [...new Set(mine)].join(':'), 'the login PATH does not come first')
      const added = merged.split(':').length - (process.env.PATH ?? '').split(':').filter((d) => d.startsWith('/')).length
      const tools = ['git', 'node'].map((t) => `${t} ${onPathPosix(t, { PATH: merged }) ? 'yes' : 'NO'}`).join(', ')
      return pass(`${basename(shell)}: ${mine.length} login entries, ${Math.max(added, 0)} new; on merged PATH: ${tools}`)
    }
  },
  {
    name: 'keyring / safeStorage backend',
    async run(ctx) {
      const not = linuxOnly()
      if (not) return not
      // the app's own check, with stand-ins for Electron's safeStorage: only a real keyring may hold secrets
      const { secretStorageStatus, NO_KEYRING } = ctx.keyring
      const st = (backend) => secretStorageStatus({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend }, 'linux')
      for (const b of ['basic_text', 'unknown']) expect(!st(b).available && st(b).reason === NO_KEYRING, `${b} is not refused`)
      for (const b of ['gnome_libsecret', 'kwallet5']) expect(st(b).available, `${b} is refused`)
      // which keyring Electron would find here, from the session bus (Electron itself isn't loaded)
      if (!process.env.DBUS_SESSION_BUS_ADDRESS) return pass('basic_text refused; no session bus here, so Corvid would refuse to store secrets (normal on a headless box)')
      const ask = (method) => run('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', `org.freedesktop.DBus.${method}`])
      const names = await ask('ListNames')
      if (names.err) return pass(`basic_text refused; keyring unknown (dbus-send ${names.err.code === 'ENOENT' ? 'not installed' : 'failed'})`)
      const found = keyringOnBus([...busNames(names.stdout), ...busNames((await ask('ListActivatableNames')).stdout)])
      return pass(found ? `basic_text refused; ${found} on the session bus, so Corvid can store secrets once it's unlocked` : 'basic_text refused; no keyring on the session bus, so Corvid would refuse to store secrets')
    }
  },
  {
    name: 'deny rules with a real claude',
    async run() {
      return skip('not run: claude -p would write ~/.claude session history and use the network; see docs/PLATFORM.md')
    }
  },
  {
    // #154: how deploy.mjs finds a running install on Linux: ps with the command line, matched on the install
    // folder's path, never by name. A copy of Node named corvid in a temp "install" stands in for the app.
    name: 'deploy: install paths and process match',
    async run(ctx) {
      const { installProfile, listProcessesCommand, parseProcessList, insideDir, killTree } = ctx.shared
      const home = linuxHome(ctx)
      const env = isLinux() ? { XDG_DATA_HOME: ctx.env.XDG_DATA_HOME } : {}
      const p = installProfile('/src', 'linux', env, home)
      eq(p.installDir, `${env.XDG_DATA_HOME || `${home}/.local/share`}/corvid/app`, 'install folder')
      eq(p.previousDir, `${p.installDir}.previous`, 'kept installs')
      const not = posixOnly()
      if (not) return not
      const dir = join(ctx.tmp, 'install', 'app')
      mkdirSync(dir, { recursive: true })
      const fake = p.executable(dir)
      const app = standInApp(process.execPath)
      copyFileSync(app.source, fake)
      chmodSync(fake, 0o755)
      const child = spawn(fake, app.args, { detached: true, stdio: 'ignore' })
      ctx.groups.push(child.pid)
      await sleep(500)
      expect(child.exitCode === null && child.signalCode === null, `the stand-in app exited before ps looked (${child.exitCode ?? child.signalCode})`)
      const [cmd, ...args] = listProcessesCommand('linux').split(' ')
      const ps = await run(cmd, args)
      if (ps.err) return skip('ps not found (install procps)')
      const list = parseProcessList(ps.stdout, 'linux')
      expect(list.some((e) => e.pid === process.pid), 'this script is in the process list')
      const found = list.filter((e) => insideDir(e.path, dir, 'linux')).map((e) => e.pid)
      eq(found.join(), String(child.pid), 'processes running from the install folder')
      expect(!list.some((e) => insideDir(e.path, `${dir}.previous`, 'linux')), 'nothing matched in the kept-installs folder')
      const err = await killTree(child.pid, { graceMs: 1000, timeoutMs: 5000 })
      expect(!err, `killTree: ${err?.message}`)
      return pass(`found the stand-in app (pid ${child.pid}) by its folder among ${list.length} processes, and ended it`)
    }
  },
  {
    // #154: test copies get their own data folder, never the real one (test-instance.mjs's guard)
    name: 'test copies kept out of the data folder',
    async run(ctx) {
      const { insideRealData } = await import(pathToFileURL(join(SRC, '..', 'scripts', 'test-instance.mjs')).href)
      const home = linuxHome(ctx)
      const env = isLinux() ? ctx.env : {}
      const real = `${env.XDG_CONFIG_HOME || `${home}/.config`}/Corvid`
      for (const v of [real, `${real}/`, real.toLowerCase(), `${real}/corvid-test-instances/x/data`]) expect(insideRealData(v, 'linux', env, home), `refuses ${v}`)
      expect(!insideRealData(join(tmpdir(), 'corvid-test-instances', 'x', 'data'), 'linux', env, home), 'the default test home is allowed')
      return pass('refuses the real data folder however it is spelled; the default test home is allowed')
    }
  }
  // New checks go here: { name: '…', async run(ctx) { … return pass('…') } }
]

// ---------- running it ----------

/** Loads the app's TypeScript modules: @shared/ aliases, extensionless imports, and a stand-in for electron whose
 *  paths are all inside the temp folder. */
function registerLoader() {
  const src = pathToFileURL(SRC + '/').href
  nodeModule.register(
    'data:text/javascript,' +
      encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent('export const app = { getPath: (n) => globalThis.__linuxCheck[n] ?? globalThis.__linuxCheck.userData }; export const safeStorage = { isEncryptionAvailable: () => false }')
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
}

const mod = (rel) => import(pathToFileURL(join(SRC, rel)).href)

function osName() {
  try {
    const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(readFileSync('/etc/os-release', 'utf8'))
    if (m) return m[1]
  } catch {
    /* not Linux, or no os-release */
  }
  return `${type()} (${process.platform})`
}

function gitVersion() {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^git version /, '')
  } catch {
    return null
  }
}

/** After a failed or interrupted check: SIGKILL the process groups this script started, but only one ps still lists
 *  members of, so a group number reused later by something else is never signalled. Never by name. */
function killGroups(groups, shared) {
  if (!groups.length || !shared || process.platform === 'win32') return
  let list
  try {
    list = shared.parsePsTree(execFileSync(shared.psTreeCommand.file, shared.psTreeCommand.args, { encoding: 'utf8', timeout: 5000 }))
  } catch {
    return
  }
  for (const g of groups) {
    if (g <= 1 || g === process.pid || !list.some((p) => p.pgid === g && !p.zombie)) continue
    try {
      process.kill(-g, 'SIGKILL')
    } catch {
      /* gone already */
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || opts.error) {
    if (opts.error) console.error(opts.error)
    console.log(USAGE)
    process.exit(opts.error ? 2 : 0)
  }
  if (process.getuid?.() === 0) {
    console.error('Refusing to run as root. Run it as an ordinary user (a throwaway one is best): it needs no sudo.')
    process.exit(2)
  }
  if (!nodeOk(process.versions.node)) {
    console.error(`Needs Node 22.18 or newer (found ${process.version}). docs/TESTING-PLATFORMS.md shows how to unpack one in your home folder, no sudo.`)
    process.exit(2)
  }
  // Node 22.7 to 22.17 strips TypeScript only with a flag: run again with it, once
  if (!process.features.typescript && !process.env.CORVID_LINUX_CHECK_RERUN) {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, CORVID_LINUX_CHECK_RERUN: '1' }
    })
    process.exit(r.status ?? 1)
  }

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'corvid-linux-check-')))
  const ctx = { tmp, home: homedir(), env: process.env, groups: [], gitVersion: gitVersion() }
  const cleanup = () => {
    killGroups(ctx.groups, ctx.shared)
    ctx.groups = []
    if (isOurTemp(tmp, realpathSync(tmpdir()))) rmSync(tmp, { recursive: true, force: true })
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(sig, () => {
      cleanup()
      process.exit(130)
    })

  let results
  try {
    // the app's modules look for their data folder through electron's app.getPath: all inside the temp folder
    globalThis.__linuxCheck = { userData: join(tmp, 'data'), appData: join(tmp, 'appdata'), home: join(tmp, 'home') }
    mkdirSync(globalThis.__linuxCheck.userData, { recursive: true })
    // git in the temp folder: an empty config instead of ~/.gitconfig and /etc/gitconfig, and a made-up author
    writeFileSync(join(tmp, 'gitconfig'), '')
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: join(tmp, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Linux check',
      GIT_AUTHOR_EMAIL: 'check@example.invalid',
      GIT_COMMITTER_NAME: 'Linux check',
      GIT_COMMITTER_EMAIL: 'check@example.invalid'
    })
    registerLoader()
    try {
      ctx.shared = await mod('main/platform/shared.mjs')
      ctx.paths = await mod('main/platform/paths.ts')
      ctx.keys = await mod('shared/pathKeys.ts')
      ctx.claude = await mod('main/platform/claude.ts')
      ctx.shells = await mod('main/platform/shells.ts')
      ctx.loginEnv = await mod('main/platform/loginEnv.ts')
      ctx.deny = await mod('main/agentDeny.ts')
      ctx.agentGit = await mod('main/agentGit.ts')
      ctx.keyring = await mod('main/platform/keyring.ts')
      ctx.installUrl = (await mod('main/claudeBin.ts')).CLAUDE_INSTALL_URL
    } catch (e) {
      console.error(`Could not load Corvid's platform layer (${redact(e.message)}). Needs Node 22.18 or newer, run from the repo root.`)
      process.exitCode = 2
      return
    }
    results = await runChecks(CHECKS, ctx)
  } finally {
    cleanup()
  }
  const info = {
    os: osName(),
    kernel: `${type()} ${release()} ${process.arch}`,
    node: process.version,
    git: ctx.gitVersion ?? 'not found',
    temp: basename(tmp),
    tempDeleted: !existsSync(tmp)
  }
  console.log(opts.json ? formatJson(info, results) : formatReport(info, results))
  process.exitCode = exitCode(results) || (info.tempDeleted ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
