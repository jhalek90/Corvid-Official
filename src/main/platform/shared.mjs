// The part of the platform layer (#149, part of #142) that the scripts share with the app: plain JavaScript, no
// electron, no TypeScript, so scripts/deploy.mjs, test-instance.mjs and setup.mjs can import it as it is and the
// app gets it through src/main/platform/. Types are in shared.d.mts.
//
// Every function takes the platform as an argument (default process.platform), so the tests run the win32,
// darwin and linux branches on any machine. The win32 branches are today's Windows code, moved here unchanged;
// scripts/test-platform.mjs pins their outputs. darwin and linux return the planned values from N78 where they
// are already known, and throw "not implemented yet" where a later cross-platform task decides them.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { homedir } from 'node:os'

export const PLATFORMS = ['win32', 'darwin', 'linux']

/** The error for a part a later cross-platform task fills in. */
export function notYet(what, platform) {
  return new Error(`${what} is not implemented yet on ${platform}`)
}

/** Only the platforms Corvid knows about; anything else (freebsd, aix…) is treated as Linux. */
export const platformOf = (platform = process.platform) => (platform === 'win32' || platform === 'darwin' ? platform : 'linux')

/** The platform's path functions, whatever machine this runs on: on Windows path.win32 is what node:path is. */
export const pathsOf = (platform = process.platform) => (platformOf(platform) === 'win32' ? win32 : posix)

// ---------- app data and the data folder ----------

/** Where per-user app data goes: what electron's app.getPath('appData') gives, worked out without electron. */
export function appDataDir(platform = process.platform, env = process.env, home = homedir()) {
  const { join } = pathsOf(platform)
  switch (platformOf(platform)) {
    case 'win32':
      return env.APPDATA
    case 'darwin':
      return join(home, 'Library', 'Application Support')
    default:
      return env.XDG_CONFIG_HOME || join(home, '.config')
  }
}

/** The real app's data folders, the one it picks first first: the pre-rename "Claude Dashboard" (kept where it
 *  exists, Windows only: the other platforms never had it), then "Corvid". */
export function dataDirCandidates(appData, platform = process.platform) {
  const { join } = pathsOf(platform)
  return platformOf(platform) === 'win32' ? [join(appData, 'Claude Dashboard'), join(appData, 'Corvid')] : [join(appData, 'Corvid')]
}

/** The real app's data folder: the first candidate that exists, else the last one. `exists` is fs.existsSync. */
export function realDataDir(appData, exists, platform = process.platform) {
  const c = dataDirCandidates(appData, platform)
  return c.find((d, i) => i < c.length - 1 && exists(d)) ?? c[c.length - 1]
}

// ---------- process control ----------

/** The command that kills a process and everything it started. Windows: taskkill /T /F by pid, never by name. */
export function killTreeCommand(pid, platform = process.platform, env = process.env) {
  const { join } = pathsOf(platform)
  if (platformOf(platform) !== 'win32') throw notYet('killTreeCommand', platform)
  return { file: join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), args: ['/PID', String(pid), '/T', '/F'] }
}

/** POSIX: the command that lists every process with its parent, process group and state, one per line. The same
 *  keywords work in procps (Linux) and BSD ps (macOS). */
export const psTreeCommand = { file: 'ps', args: ['-A', '-o', 'pid=,ppid=,pgid=,stat='] }

/** psTreeCommand's output as [{ pid, ppid, pgid, zombie }]; lines that don't parse are skipped. */
export function parsePsTree(out) {
  const list = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(\S*)/.exec(line)
    if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), zombie: m[4].startsWith('Z') })
  }
  return list
}

/** `pid` and everything below it in `list` (parsePsTree's), parents before their children. */
export function treeOf(pid, list) {
  const children = new Map()
  for (const p of list) {
    if (p.pid === p.ppid) continue
    if (!children.has(p.ppid)) children.set(p.ppid, [])
    children.get(p.ppid).push(p.pid)
  }
  const tree = [pid]
  const seen = new Set(tree)
  for (let i = 0; i < tree.length; i++) {
    for (const c of children.get(tree[i]) ?? []) if (!seen.has(c)) seen.add(c), tree.push(c)
  }
  return tree
}

/**
 * What a POSIX kill of `pid`'s tree signals: every process in the tree (snapshotted before anything is signalled,
 * so children aren't lost when their parent dies and they move to init), plus the process groups that a process in
 * the tree leads (node-pty shells and detached spawns are group leaders, and so is each job an interactive shell
 * starts), which also catches a group member that already left the tree. Never pid 0 or 1, never `self` (Corvid)
 * and never `self`'s own group. Without a listing it's `pid` and, only if it leads its own group, that group.
 */
export function posixKillPlan(pid, list, self = process.pid) {
  const byPid = new Map(list.map((p) => [p.pid, p]))
  const selfGroup = byPid.get(self)?.pgid
  const safe = (n) => n > 1 && n !== self && n !== selfGroup
  const tree = list.length ? treeOf(pid, list) : [pid]
  // Corvid's own ancestors are refused whole, not just Corvid within them
  if (!safe(pid) || tree.includes(self)) return { pids: [], groups: [] }
  const pids = tree.filter(safe)
  const groups = list.length ? pids.filter((p) => byPid.get(p)?.pgid === p) : []
  return { pids, groups }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The real ps, signal and clock for killTree; tests pass their own. */
function posixDeps() {
  return {
    ps: () => new Promise((resolve) => execFile(psTreeCommand.file, psTreeCommand.args, { timeout: 5000 }, (err, out) => resolve(err ? null : String(out)))),
    signal: (target, sig) => {
      try {
        process.kill(target, sig)
      } catch {
        /* already gone, or a group that has no members left */
      }
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        return e.code === 'EPERM'
      }
    },
    sleep,
    self: process.pid
  }
}

/**
 * Kill `pid` and everything it started; resolves with an Error if something may have survived, else null.
 * Windows: taskkill /PID <pid> /T /F, as before (#149), by pid only. POSIX (#153): take one ps snapshot of the
 * tree, SIGTERM every process and every group it leads (and SIGHUP `pid`, the hang-up a closed terminal sends, which
 * interactive shells listen to instead of SIGTERM), wait up to `graceMs`, then SIGKILL whatever is left of the
 * snapshot and its groups, and wait for it to go until `timeoutMs`. Never by name.
 * `rootFirstMs` (POSIX, for Corvid itself): SIGTERM `pid` alone first and give it that long to end its own children,
 * before the rest is signalled as above. Signalled together, Chromium's GPU process dies under an app that is still
 * running, which relaunches it, fails and logs "GPU process isn't usable. Goodbye." (#178).
 */
export async function killTree(pid, opts = {}, platform = process.platform, deps) {
  const timeoutMs = opts.timeoutMs ?? 8000
  if (platformOf(platform) === 'win32') {
    const { file, args } = killTreeCommand(pid, platform)
    return new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: opts.timeoutMs }, (err) => resolve(err)))
  }
  const d = { ...posixDeps(), ...deps }
  const out = await d.ps()
  const list = out == null ? [] : parsePsTree(out)
  const { pids, groups } = posixKillPlan(pid, list, d.self)
  if (!pids.length) return new Error(`refused to kill pid ${pid}`)
  // what's still running: a fresh ps where there is one, so a dead child its parent hasn't reaped yet (a zombie)
  // doesn't count, and a pid that has gone isn't signalled again
  const remaining = async () => {
    const o = await d.ps()
    if (o == null) return pids.filter((p) => d.alive(p))
    const now = new Map(parsePsTree(o).map((p) => [p.pid, p]))
    return pids.filter((p) => now.has(p) && !now.get(p).zombie)
  }
  const waitGone = async (until) => {
    for (let i = 1; ; i++) {
      if (!pids.some((p) => d.alive(p))) return []
      if (Date.now() >= until) return remaining()
      // every half second, ask ps: what's left may only be zombies
      if (i % 5 === 0 && !(await remaining()).length) return []
      await d.sleep(100)
    }
  }
  const start = Date.now()
  if (opts.rootFirstMs) {
    d.signal(pid, 'SIGTERM')
    if (!(await waitGone(start + Math.min(opts.rootFirstMs, timeoutMs))).length) return null
  }
  const termAt = Date.now()
  for (const g of groups) d.signal(-g, 'SIGTERM')
  for (const p of pids) d.signal(p, 'SIGTERM')
  d.signal(pid, 'SIGHUP')
  let left = await waitGone(Math.min(termAt + (opts.graceMs ?? 2000), start + timeoutMs))
  if (!left.length) return null
  for (const g of groups) d.signal(-g, 'SIGKILL')
  for (const p of left) d.signal(p, 'SIGKILL')
  left = await waitGone(start + timeoutMs)
  return left.length ? new Error(`pid ${left.join(', ')} still running ${timeoutMs} ms after SIGKILL`) : null
}

/** The command that lists every process with its pid, parent and executable (deploy only). Windows: JSON from one
 *  CIM query. POSIX (#154): ps with the full command line, which starts with the executable's path. */
export function listProcessesCommand(platform = process.platform) {
  if (platformOf(platform) !== 'win32') return 'ps -A -o pid=,ppid=,command='
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress'
  return `powershell -NoProfile -Command "${ps}"`
}

/** listProcessesCommand's output as [{ pid, ppid, path }], path lowercased on Windows. On POSIX `path` is the whole
 *  command line (a path with spaces can't be told apart from its arguments), which insideDir matches by its start;
 *  lines that don't parse are skipped. */
export function parseProcessList(out, platform = process.platform) {
  if (platformOf(platform) !== 'win32') {
    const list = []
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line)
      if (m && m[3]) list.push({ pid: Number(m[1]), ppid: Number(m[2]), path: m[3] })
    }
    return list
  }
  return JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, path: (p.ExecutablePath || '').toLowerCase() }))
}

// ---------- install profile (deploy.mjs, setup.mjs) ----------

/**
 * Where a deploy builds, installs and starts Corvid. `root` is the main checkout. Windows: today's
 * %LOCALAPPDATA%\Programs\Corvid. macOS: ~/Applications/Corvid.app; Linux: ~/.local/share/corvid/app (#154).
 * CORVID_INSTALL_DIR swaps in a throwaway install (tests), with its kept copies beside it and no app-menu entry.
 */
export function installProfile(root, platform = process.platform, env = process.env, home = homedir()) {
  const { join, delimiter } = pathsOf(platform)
  const p = platformOf(platform)
  if (p === 'win32') {
    const installDir = env.CORVID_INSTALL_DIR || join(env.LOCALAPPDATA, 'Programs', 'Corvid')
    return {
      builderArgs: ['--win', '--dir'],
      builtDir: join(root, 'dist', 'win-unpacked'),
      installDir,
      previousDir: `${installDir}.previous`,
      exeName: 'Corvid.exe',
      /** the executable inside an install or build folder */
      executable: (dir) => join(dir, 'Corvid.exe'),
      /** the folder holding app.asar inside an install or build folder */
      resources: (dir) => join(dir, 'resources'),
      /** PATH's separator, for the node_modules/.bin a detached run adds */
      pathDelimiter: delimiter,
      legacyInstallDir: join(env.LOCALAPPDATA, 'Programs', 'Claude Dashboard'),
      legacyExeName: 'Claude Dashboard.exe',
      desktopEntry: null,
      shownPath: '%LOCALAPPDATA%\\Programs\\Corvid'
    }
  }
  if (p === 'darwin') {
    const installDir = env.CORVID_INSTALL_DIR || join(home, 'Applications', 'Corvid.app')
    return {
      builderArgs: ['--mac', '--dir'],
      // dist/mac-arm64 on Apple Silicon, dist/mac on Intel
      builtDir: join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Corvid.app'),
      installDir,
      // under the data folder, so Launchpad and Spotlight don't list the kept copies; beside a throwaway install
      previousDir: env.CORVID_INSTALL_DIR ? `${installDir}.previous` : join(appDataDir('darwin', env, home), 'Corvid', 'previous-builds'),
      exeName: 'Corvid',
      executable: (dir) => join(dir, 'Contents', 'MacOS', 'Corvid'),
      resources: (dir) => join(dir, 'Contents', 'Resources'),
      pathDelimiter: delimiter,
      legacyInstallDir: null,
      legacyExeName: null,
      desktopEntry: null,
      shownPath: '~/Applications/Corvid.app'
    }
  }
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  const installDir = env.CORVID_INSTALL_DIR || join(dataHome, 'corvid', 'app')
  return {
    builderArgs: ['--linux', '--dir'],
    builtDir: join(root, 'dist', 'linux-unpacked'),
    installDir,
    previousDir: `${installDir}.previous`,
    exeName: 'corvid',
    executable: (dir) => join(dir, 'corvid'),
    resources: (dir) => join(dir, 'resources'),
    pathDelimiter: delimiter,
    legacyInstallDir: null,
    legacyExeName: null,
    // a throwaway install leaves the user's app menu alone
    desktopEntry: env.CORVID_INSTALL_DIR ? null : join(dataHome, 'applications', 'corvid.desktop'),
    shownPath: '~/.local/share/corvid/app'
  }
}

// ---------- paths the scripts need ----------

/** A path as the OS writes it: Windows turns / into \ (today's winPath, without its trim); elsewhere unchanged. */
export const toNative = (p, platform = process.platform) => (platformOf(platform) === 'win32' ? p.replace(/\//g, '\\') : p)

/** Whether `path` is inside `dir`, the way deploy.mjs compares a lowercased Windows process path. POSIX (#154): a
 *  parseProcessList command line that starts inside `dir`, case folded on macOS (its disks usually are). */
export function insideDir(path, dir, platform = process.platform) {
  const p = platformOf(platform)
  if (p === 'win32') return path.startsWith(dir.toLowerCase() + '\\')
  const prefix = dir.replace(/\/+$/, '') + '/'
  return p === 'darwin' ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix)
}

/** A packaged app's install folder from its executable's path (on macOS the .app bundle three levels up), and where
 *  deploy.mjs keeps the earlier installs for it (#154). Windows: the exe's folder and <folder>.previous, as before. */
export function installOf(exe, platform = process.platform, env = process.env, home = homedir()) {
  const { dirname, join } = pathsOf(platform)
  if (platformOf(platform) === 'darwin') return { dir: dirname(dirname(dirname(exe))), previousDir: join(appDataDir('darwin', env, home), 'Corvid', 'previous-builds') }
  const dir = dirname(exe)
  return { dir, previousDir: `${dir}.previous` }
}

/** What `npm install` must have put in node_modules for Corvid to run here: the prebuilt terminal library for this
 *  platform and CPU, and Electron's own binary (#154). */
export function nativeDeps(platform = process.platform, arch = process.arch) {
  const p = platformOf(platform)
  const electron = p === 'win32' ? 'electron/dist/electron.exe' : p === 'darwin' ? 'electron/dist/Electron.app/Contents/MacOS/Electron' : 'electron/dist/electron'
  return { pty: `@lydell/node-pty-${p}-${arch}`, electron }
}

// Electron 44 no longer downloads its binary on npm install: its install.js is opt-in (#175). It writes dist/ and
// then path.txt, which electron-vite reads to find the binary, so both have to be there.

/** Electron's own installer, relative to node_modules: it downloads the zip (ELECTRON_MIRROR, proxies and the cache
 *  apply), checks it against the package's checksums.json and unpacks it. */
export const ELECTRON_INSTALLER = 'electron/install.js'

/** Whether node_modules holds Electron's binary for this platform: dist/<executable> and path.txt. */
export function electronBinaryPresent(nodeModules, platform = process.platform, exists = existsSync) {
  const p = pathsOf(platform)
  return exists(p.join(nodeModules, nativeDeps(platform).electron)) && exists(p.join(nodeModules, 'electron', 'path.txt'))
}

/** Whether to run Electron's installer: the package is installed (not with --omit=dev) but its binary isn't. */
export function electronNeedsDownload(nodeModules, platform = process.platform, exists = existsSync) {
  return exists(pathsOf(platform).join(nodeModules, ELECTRON_INSTALLER)) && !electronBinaryPresent(nodeModules, platform, exists)
}

/** How to get git on this platform, for setup's messages. */
export function gitInstallHint(platform = process.platform) {
  const p = platformOf(platform)
  if (p === 'win32') return 'Install Git for Windows from git-scm.com'
  if (p === 'darwin') return 'Install the Xcode Command Line Tools (run xcode-select --install in Terminal), which include git'
  return "Install git with your distribution's package manager (for example sudo apt install git, or sudo dnf install git)"
}

/** A desktop-entry string value (the spec's string escapes): \ doubled, newlines and tabs written as \n and \t. */
const desktopString = (s) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')

/** One Exec argument: in double quotes with ", `, $ and \ escaped and % doubled (the quoting rules), then the string
 *  escapes on top, so a literal $ is written \\$ and a " is \\" in the file, as the Desktop Entry spec says. */
const execArg = (a) => desktopString(`"${a.replace(/["`$\\]/g, (c) => '\\' + c).replace(/%/g, '%%')}"`)

/** The Linux app-menu entry for an install (#154, #158), or with `autostart` the ~/.config/autostart entry that
 *  opens Corvid hidden at login. TryExec hides the entry where the desktop checks it once the app is removed. */
export function desktopEntryText(executable, icon, { autostart = false } = {}) {
  const exec = autostart ? `${execArg(executable)} --hidden` : `${execArg(executable)} %U`
  const lines = ['[Desktop Entry]', 'Type=Application', 'Name=Corvid', 'Comment=Claude Code dashboard', `Exec=${exec}`, `TryExec=${desktopString(executable)}`]
  if (icon) lines.push(`Icon=${desktopString(icon)}`)
  lines.push('Terminal=false', 'Categories=Development;', 'StartupWMClass=Corvid')
  if (autostart) lines.push('X-GNOME-Autostart-enabled=true')
  return [...lines, ''].join('\n')
}

/** Where "open at login" lives on Linux: $XDG_CONFIG_HOME/autostart (default ~/.config/autostart). */
export function autostartEntryPath(env = process.env, home = homedir()) {
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), 'autostart', 'corvid.desktop')
}
