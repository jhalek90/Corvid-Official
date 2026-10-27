// Build, install and relaunch: to %LOCALAPPDATA%\Programs\Corvid on Windows, ~/Applications/Corvid.app on macOS
// and ~/.local/share/corvid/app on Linux (the install profiles in src/main/platform/shared.mjs, #154).
//
// Safe to run from inside the dashboard (a worker or terminal tab asked to "rebuild and restart"):
// the old app has to die for the install to happen, and that takes its terminals with it, so in
// that case this script re-launches itself detached. Every run appends to deploy.log in the app's data folder.
//
// Exit codes (#177): 0 the new build (or, with --rollback, the restored one) started and reported healthy;
// 1 the deploy or rollback failed; 2 the new build didn't report healthy and the previous install was put back;
// 3 it was installed and launched but didn't report healthy, with nothing to roll back to (left in place).
// --detach (and a run from inside the dashboard) exits 0 once the background run has started.
//
// Test only: CORVID_DEPLOY_FAIL_HEALTH=1 makes the new build count as never reporting healthy (a deterministic
// rollback for scripts/test-deploy.mjs and docs/TESTING-PLATFORMS.md). It has no effect unless set.
import { execSync, spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appDataDir, desktopEntryText, insideDir, installProfile, killTree, listProcessesCommand, parseProcessList, platformOf, realDataDir, toNative } from '../src/main/platform/shared.mjs'

delete process.env.ELECTRON_RUN_AS_NODE
const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = platformOf() === 'win32'

/**
 * Always build the main checkout. Worker worktrees symlink node_modules to it, and electron-builder
 * silently leaves platform binaries (@lydell/node-pty-win32-x64) out of a package built through that
 * link: the app then dies on launch. Workers merge into main before deploying, so main has their work.
 */
function mainCheckout(dir) {
  try {
    const common = execSync('git rev-parse --path-format=absolute --git-common-dir', { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return dirname(toNative(common.trim()))
  } catch {
    return dir
  }
}
const root = mainCheckout(scriptRoot)
const self = join(root, 'scripts', 'deploy.mjs')
// CORVID_INSTALL_DIR is for testing against a throwaway copy of the install; normal runs never set it.
const profile = installProfile(root)
const dest = profile.installDir
// Earlier installs, kept so a bad build can be undone (the newest KEEP_PREVIOUS)
const previousDir = profile.previousDir
const KEEP_PREVIOUS = 2
const HEALTH_MS = Number(process.env.CORVID_HEALTH_SECS || 30) * 1000
// test only, see the top of this file
const FAIL_HEALTH = process.env.CORVID_DEPLOY_FAIL_HEALTH === '1'
const built = profile.builtDir
const exeName = profile.exeName
// A throwaway install (CORVID_INSTALL_DIR) never stops a Corvid by image name, nor touches the real pre-rename install.
const throwaway = !!process.env.CORVID_INSTALL_DIR
// Install from before the app was renamed (Windows only): stopped like the current one, then removed once Corvid is in.
const legacyDest = throwaway ? null : profile.legacyInstallDir
const legacyExeName = profile.legacyExeName
// DASH_DATA_DIR: the app's own test override for its data folder, passed on when it starts a deploy. Otherwise the
// same rule as the app: the pre-rename data folder stays in use where it exists (Windows only).
const logDir = process.env.DASH_DATA_DIR || realDataDir(appDataDir(), existsSync)
const logFile = join(logDir, 'deploy.log')
// POSIX: copy symlinks as they are (a macOS bundle's frameworks are full of relative ones; resolving them would
// point the install back into dist/). Windows keeps its options as they were.
const copyOpts = isWin ? { recursive: true, force: true } : { recursive: true, force: true, verbatimSymlinks: true }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const detachedRun = process.argv.includes('--detached-run')
const rollbackRun = process.argv.includes('--rollback')

mkdirSync(logDir, { recursive: true })
// deploy.log grows by appending; past LOG_MAX it moves to deploy.old.log (replacing the one before) at a run's start
const LOG_MAX = 1024 * 1024
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  console.log(line)
  try {
    appendFileSync(logFile, line + '\n')
  } catch {
    /* the log never stops a deploy */
  }
}
function startLog() {
  try {
    if (existsSync(logFile) && statSync(logFile).size > LOG_MAX) renameSync(logFile, join(logDir, 'deploy.old.log'))
    appendFileSync(logFile, `\n===== ${new Date().toISOString()} deploy${rollbackRun ? ' --rollback' : ''}${detachedRun ? ' (in the background)' : ''} =====\n`)
  } catch {
    /* as above */
  }
}

/** Every process as { pid, ppid, path }: one CIM query on Windows, ps elsewhere (path is then the command line). */
function processes() {
  const out = execSync(listProcessesCommand(), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return parseProcessList(out)
}

// matched on the install folder's path, never on a process name
const inside = (path, dir) => !!dir && insideDir(path, dir)

/** True when one of our ancestors is the dashboard (or its terminal host), i.e. we'd be killed with it. */
function runningInsideDashboard() {
  if (process.env.DASHBOARD_PTY) return true
  try {
    const all = processes()
    const byPid = new Map(all.map((p) => [p.pid, p]))
    let p = byPid.get(process.pid)
    for (let i = 0; p && i < 30; i++) {
      if (inside(p.path, dest) || inside(p.path, legacyDest) || inside(p.path, built)) return true
      p = byPid.get(p.ppid)
    }
  } catch {
    /* can't tell; assume not */
  }
  return false
}

/** Kill the dashboard with its whole tree, then anything still running out of the given folders. */
async function stopDashboard(dirs) {
  // by image name on Windows only, as it always was; elsewhere, and for a throwaway install, only what runs out of
  // the folders below (by name would also end the user's real Corvid)
  if (isWin && !throwaway) {
    for (const name of [exeName, legacyExeName]) {
      try {
        execSync(`taskkill /IM "${name}" /F /T`, { stdio: 'ignore' })
      } catch {
        /* not running */
      }
    }
  }
  for (let i = 0; i < 30; i++) {
    const left = processes().filter((p) => p.pid !== process.pid && dirs.some((d) => inside(p.path, d)))
    if (!left.length) return
    for (const p of left) {
      if (!isWin) {
        // only the top of each tree: its children (the GPU process among them) go with it, and the next pass
        // catches anything that didn't
        if (left.some((q) => q.pid === p.ppid)) continue
        // the tree by pid, SIGTERM then SIGKILL; killTree refuses this script and its own ancestors. The app gets
        // SIGTERM on its own first, so it ends Chromium's GPU process itself (#178)
        await killTree(p.pid, { timeoutMs: 5000, rootFirstMs: 2000 })
        continue
      }
      try {
        execSync(`taskkill /PID ${p.pid} /F /T`, { stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    }
    await sleep(500)
  }
  log('Warning: some processes in the install folder would not exit.')
}

function launch() {
  const exe = [profile.executable(dest), profile.executable(built)].find(existsSync)
  if (!exe) return log('Nothing to launch: no built app found.')
  spawn(exe, [], { cwd: dirname(exe), detached: true, stdio: 'ignore', env: process.env }).unref()
  log(`Launched ${exe}`)
}

// ---------- keeping the previous install, and rolling back (#78) ----------

const healthFile = join(logDir, 'health.json')
const noticeFile = join(logDir, 'deploy-notice.json')
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return undefined
  }
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const kept = () => (existsSync(previousDir) ? readdirSync(previousDir).sort().reverse() : [])

/** Move the current install into Corvid.previous\<time>, then prune all but the newest KEEP_PREVIOUS. */
function keepPrevious() {
  if (!existsSync(profile.executable(dest))) return
  mkdirSync(previousDir, { recursive: true })
  const to = join(previousDir, stamp())
  try {
    renameSync(dest, to)
  } catch (e) {
    log(`Couldn't move the old install aside (${e.code}); copying it instead.`)
    cpSync(dest, to, copyOpts)
  }
  log(`Kept the previous install in ${to}`)
  for (const old of kept().slice(KEEP_PREVIOUS)) {
    rmSync(join(previousDir, old), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    log(`Pruned an older install (${old}).`)
  }
}

/** Put the newest kept install back in place of the current one, which is dropped (a failed build) or kept in turn. */
function restorePrevious(dropCurrent) {
  const [newest] = kept()
  if (!newest) throw new Error('No previous install is kept.')
  if (existsSync(dest)) {
    if (dropCurrent) rmSync(dest, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
    else renameSync(dest, join(previousDir, `${stamp()}-replaced`))
  }
  renameSync(join(previousDir, newest), dest)
  log(`Restored the install kept as ${newest}.`)
}

/** Wait for the launched app's heartbeat (written once its window is up) from the commit we installed (any, when
 *  that isn't known). `isNew`: the build just installed, which CORVID_DEPLOY_FAIL_HEALTH (test only) never lets pass. */
async function healthy(since, commit, isNew) {
  if (isNew && FAIL_HEALTH) log('CORVID_DEPLOY_FAIL_HEALTH=1 (test only): the new build counts as never reporting healthy.')
  for (let t = 0; t < HEALTH_MS; t += 1000) {
    const h = readJson(healthFile)
    if (!(isNew && FAIL_HEALTH) && h && h.at >= since && (!h.commit || !commit || h.commit === commit)) return true
    await sleep(1000)
  }
  return false
}

/** Launch an install that was put back (a rollback) and wait for it too. */
async function launchRestored(what) {
  const since = Date.now()
  launch()
  if (await healthy(since, readJson(join(dest, 'corvid-build.json'))?.commit)) return log(`${what} started and reported healthy.`)
  log(`${what} didn't report healthy within ${HEALTH_MS / 1000}s either. It was left in place; it may still be starting.`)
  return false
}

/** Launch the new install; if it doesn't come up, put the previous one back and leave a notice for its next start. */
async function launchChecked(commit) {
  const since = Date.now()
  launch()
  if (await healthy(since, commit, true)) return log('The new build started and reported healthy.')
  if (!kept().length) {
    // a first install: nothing to go back to, so the new build stays
    log(`The new build didn't report healthy within ${HEALTH_MS / 1000}s, and there's no previous install to roll back to, so it was left in place. It may still be starting; if it doesn't open, the details are in ${logFile}.`)
    process.exitCode = 3
    return
  }
  log(`The new build didn't report healthy within ${HEALTH_MS / 1000}s. Restoring the previous install…`)
  await stopDashboard([dest])
  try {
    restorePrevious(true)
  } catch (e) {
    process.exitCode = 1
    return log(`Couldn't restore the previous install: ${e.message}`)
  }
  process.exitCode = 2
  const back = readJson(join(dest, 'corvid-build.json'))?.commit?.slice(0, 7) ?? 'an earlier build'
  const text = `The last rebuild (${commit ? commit.slice(0, 7) : 'commit unknown'}) didn't start, so Corvid rolled back to the previous build (${back}). Details are in deploy.log.`
  writeFileSync(noticeFile, JSON.stringify({ at: Date.now(), text }))
  log(text)
  await launchRestored('The previous build')
}

if (!detachedRun && (process.argv.includes('--detach') || runningInsideDashboard())) {
  if (!isWin) {
    // POSIX: a detached child leads its own session, so it outlives the dashboard and whoever started this
    const again = ['--detached-run', ...(rollbackRun ? ['--rollback'] : [])]
    spawn(process.execPath, [self, ...again], { cwd: root, detached: true, stdio: 'ignore', env: process.env }).unref()
    console.log(`Deploy continues in the background: the dashboard will close, update and restart in a minute or two.`)
    console.log(`Progress: ${logFile}`)
    process.exit(0)
  }
  // Start through WMI so the new process has no parent in this tree: a plain detached child can
  // still be reaped by the caller (Claude's Bash tool) or die with the dashboard's terminal.
  const q = (s) => s.replace(/'/g, "''")
  const ps = [
    `$ProgressPreference = 'SilentlyContinue'`,
    `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }`,
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(`"${process.execPath}" "${self}" --detached-run${rollbackRun ? ' --rollback' : ''}`)}'; CurrentDirectory = '${q(root)}'; ProcessStartupInformation = $si }`,
    `exit $r.ReturnValue`
  ].join('; ')
  execSync(`powershell -NoProfile -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`, { stdio: 'ignore' })
  console.log(`Deploy continues in the background: the dashboard will close, update and restart in a minute or two.`)
  console.log(`Progress: ${logFile}`)
  process.exit(0)
}
startLog()

// npm puts node_modules/.bin on PATH for `npm run`; a detached run has to do it itself.
const binPath = { ...process.env, PATH: `${join(root, 'node_modules', '.bin')}${profile.pathDelimiter}${process.env.PATH ?? process.env.Path ?? ''}` }
delete binPath.Path
const run = (cmd) => execSync(cmd, { cwd: root, stdio: detachedRun ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: binPath, maxBuffer: 64 * 1024 * 1024 })

/**
 * Load every package the main process requires, using the packaged app's own runtime and asar,
 * before the running app is touched. Catches anything electron-builder left out.
 */
function verifyPackage() {
  const mainDir = join(root, 'out', 'main')
  const mods = new Set()
  for (const f of readdirSync(mainDir).filter((f) => f.endsWith('.js'))) {
    for (const m of readFileSync(join(mainDir, f), 'utf8').matchAll(/require\(["']([^"'.][^"']*)["']\)/g)) {
      const spec = m[1]
      if (spec === 'electron' || spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0])) continue
      mods.add(spec)
    }
  }
  const asarPkg = join(profile.resources(built), 'app.asar', 'package.json')
  const check = join(tmpdir(), `corvid-verify-${process.pid}.cjs`)
  const script = [
    `const r = require('module').createRequire(${JSON.stringify(asarPkg)})`,
    `for (const m of ${JSON.stringify([...mods])}) {`,
    `  try { r(m) } catch (e) { console.error(m + ': ' + String(e.message).split(/\\r?\\n/)[0]); process.exitCode = 1 }`,
    `}`
  ]
  writeFileSync(check, script.join('\n'))
  try {
    execSync(`"${profile.executable(built)}" "${check}"`, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
  } catch (e) {
    throw new Error(`The new build can't load its dependencies, so it wasn't installed:\n${String(e.stderr ?? e.message).trim()}`)
  } finally {
    rmSync(check, { force: true })
  }
  log(`Package check passed (${mods.size} modules load).`)
}

// --rollback: no build, just swap the newest kept install back in
if (rollbackRun) {
  try {
    if (!kept().length) throw new Error('No previous install is kept.')
    log('Rolling back to the previous install. Stopping the dashboard…')
    await stopDashboard([dest, built])
    restorePrevious(false)
    rmSync(noticeFile, { force: true })
  } catch (e) {
    log(`Rollback failed: ${e.message}`)
    process.exitCode = 1
  }
  if (process.exitCode) launch()
  else if ((await launchRestored('The restored build')) === false) process.exitCode = 3
  process.exit()
}

let installed = false
let commit = ''
try {
  if (root.toLowerCase() !== scriptRoot.toLowerCase()) log(`Started from a worktree; building the main checkout at ${root}.`)
  // a copy without git (git archive, a zip) still deploys, with its commit unknown
  try {
    log(`Building ${execSync('git log -1 --format="%h %s"', { cwd: root, encoding: 'utf8' }).trim()}`)
    commit = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    commit = ''
    log("Building commit unknown: this folder isn't a git repository (or git isn't available), so the build records no commit.")
  }
  // A copy running straight from dist/ would lock the build output.
  await stopDashboardIfRunningFrom(built)
  log('Building…')
  run('node scripts/ev.mjs build')
  run(`npx electron-builder ${profile.builderArgs.join(' ')}`)
  verifyPackage()
  // which commit each install is, for the kept copies and the rollback notice
  // (no commit field when it's unknown)
  writeFileSync(join(built, 'corvid-build.json'), JSON.stringify({ commit: commit || undefined, time: Date.now() }))
  // where Corvid's own project finds its source (#78)
  writeFileSync(join(logDir, 'corvid-source.json'), JSON.stringify({ source: root, commit: commit || undefined, at: Date.now() }, null, 2))
  log('Build done. Stopping the dashboard…')
  await stopDashboard([dest, legacyDest, built].filter(Boolean))
  log(`Installing to ${dest}`)
  try {
    keepPrevious()
  } catch (e) {
    log(`Couldn't keep the previous install (${e.message}).`)
  }
  try {
    rmSync(dest, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
  } catch (e) {
    log(`Couldn't remove the old install (${e.code}); copying over it instead.`)
  }
  cpSync(built, dest, copyOpts)
  installed = true
  log('Installed.')
  if (profile.desktopEntry) writeDesktopEntry()
  if (legacyDest && existsSync(legacyDest)) {
    try {
      rmSync(legacyDest, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
      log(`Removed the old install at ${legacyDest}`)
    } catch (e) {
      log(`Couldn't remove the old install at ${legacyDest} (${e.code}); delete it by hand.`)
    }
  }
} catch (e) {
  log(`Deploy failed: ${e.message}`)
  if (e.stderr) log(String(e.stderr).slice(-2000))
  process.exitCode = 1
}
// Whatever happened, don't leave the user without a dashboard; a new install (a first one too) has to show it starts.
if (installed) await launchChecked(commit)
else launch()

/** Linux: the app-menu entry, with the icon copied beside the install. A failure is logged, never fatal. */
function writeDesktopEntry() {
  try {
    const icon = join(dirname(dest), 'icon.png')
    copyFileSync(join(root, 'resources', 'icon.png'), icon)
    mkdirSync(dirname(profile.desktopEntry), { recursive: true })
    writeFileSync(profile.desktopEntry, desktopEntryText(profile.executable(dest), icon))
    log(`Wrote the app-menu entry ${profile.desktopEntry}`)
  } catch (e) {
    log(`Couldn't write the app-menu entry (${e.message}).`)
  }
}

async function stopDashboardIfRunningFrom(dir) {
  if (processes().some((p) => inside(p.path, dir))) await stopDashboard([dir])
}
