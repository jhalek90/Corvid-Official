// Tests for #149, the platform layer (src/main/platform/): every function takes the platform as an argument, so
// the win32, darwin and linux branches all run here on any machine. The first half pins today's exact Windows
// outputs, both as literal values and against the code the call sites still use (normKey, projectKey, within,
// absRule, resolveDataDir, the scripts' data folder and install paths), so the cross-platform tasks that come
// after (#150 to #163) can't change Windows by accident. Runs on Node 24's TypeScript support with a stand-in
// for electron; every path here is made up and nothing is written outside a temp folder.
//
//   npm run test-platform

import { register } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-platform-'))
// what the fake electron's app.getPath answers, by name
globalThis.__paths = { userData: join(tmp, 'data'), appData: join(tmp, 'appdata') }
mkdirSync(globalThis.__paths.userData, { recursive: true })
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
const shared = await import(src + 'main/platform/shared.mjs')
const { normKey, within } = await import(src + 'shared/projectList.ts')
const { projectKey } = await import(src + 'shared/projects.ts')
const { platformInfo, shortcutLabel } = await import(src + 'shared/platformInfo.ts')
const onWindows = process.platform === 'win32'

after(() => rmSync(tmp, { recursive: true, force: true }))

// ---------- today's Windows behaviour, pinned ----------

const KEYS = [
  ['D:\\projects\\dashboard', 'd:\\projects\\dashboard'],
  ['D:/Projects/Dashboard/', 'd:\\projects\\dashboard'],
  ['d:\\projects\\dashboard\\\\', 'd:\\projects\\dashboard'],
  ['C:\\Users\\X\\AppData\\Roaming\\Corvid', 'c:\\users\\x\\appdata\\roaming\\corvid'],
  ['c:/a//b', 'c:\\a\\\\b'],
  ['C:\\', 'c:'],
  ['\\\\server\\share\\Repo', '\\\\server\\share\\repo'],
  ['D:\\projects\\dashboard-worktrees\\task-149-x', 'd:\\projects\\dashboard-worktrees\\task-149-x'],
  ['', '']
]

// The call sites (normKey, projectKey, within, absRule) follow the OS they run on (#150, #151): they give the win32
// values on Windows, and on macOS and Linux exactly that OS's branch of the platform layer.
const host = process.platform

test('win32 pathKey is exactly today\'s normKey (and projectKey after / to \\)', () => {
  for (const [input, key] of KEYS) {
    const backslashed = input.replace(/\//g, '\\')
    assert.equal(P.pathKey(input, 'win32'), key, input)
    assert.equal(normKey(input), onWindows ? key : P.pathKey(input, host), `normKey ${input}`)
    assert.equal(projectKey(backslashed), onWindows ? key : P.pathKey(backslashed, host), `projectKey ${input}`)
  }
})

test('win32 within is exactly today\'s within', () => {
  const cases = [
    ['d:\\projects\\dashboard', 'd:\\projects\\dashboard', true],
    ['d:\\projects\\dashboard\\src', 'd:\\projects\\dashboard', true],
    ['d:\\projects\\dashboard-worktrees\\x', 'd:\\projects\\dashboard', false],
    ['d:\\projects', 'd:\\projects\\dashboard', false],
    ['c:\\x', 'c:', true]
  ]
  for (const [key, folder, inside] of cases) {
    assert.equal(P.within(key, folder, 'win32'), inside, `${key} in ${folder}`)
    assert.equal(within(key, folder), onWindows ? inside : P.within(key, folder, host), `today's within: ${key} in ${folder}`)
  }
})

test('win32 absRule gives today\'s deny-rule paths', async () => {
  const cases = [
    ['C:\\Users\\x\\AppData\\Roaming\\Corvid', '//c/Users/x/AppData/Roaming/Corvid'],
    ['C:\\Users\\x\\AppData\\Roaming\\Claude Dashboard', '//c/Users/x/AppData/Roaming/Claude Dashboard'],
    ['D:\\projects\\dashboard', '//d/projects/dashboard'],
    ['d:/mixed\\Seps', '//d/mixed/Seps'],
    ['\\\\server\\share', '////server/share']
  ]
  const deny = await import(src + 'main/agentDeny.ts')
  for (const [p, rule] of cases) {
    assert.equal(P.absRule(p, 'win32'), rule, p)
    assert.equal(deny.absRule(p), onWindows ? rule : P.absRule(p, host), `agentDeny.absRule ${p}`)
  }
  // the data folder rules agents get: this copy's folder and both of the real app's names
  if (onWindows) {
    globalThis.__paths = { userData: 'C:\\Users\\x\\AppData\\Roaming\\Corvid', appData: 'C:\\Users\\x\\AppData\\Roaming' }
    assert.deepEqual(deny.dataFolders(), ['//c/Users/x/AppData/Roaming/Corvid/**', '//c/Users/x/AppData/Roaming/Claude Dashboard/**'])
    globalThis.__paths = { userData: join(tmp, 'data'), appData: join(tmp, 'appdata') }
  }
})

test('win32 data folder: APPDATA, "Claude Dashboard" where it exists, else Corvid, same as the app', async () => {
  const appData = 'C:\\Users\\x\\AppData\\Roaming'
  assert.equal(shared.appDataDir('win32', { APPDATA: appData }), appData)
  assert.deepEqual(shared.dataDirCandidates(appData, 'win32'), [`${appData}\\Claude Dashboard`, `${appData}\\Corvid`])
  assert.equal(shared.realDataDir(appData, () => false, 'win32'), `${appData}\\Corvid`)
  assert.equal(shared.realDataDir(appData, (d) => d.endsWith('Claude Dashboard'), 'win32'), `${appData}\\Claude Dashboard`)
  // the app's own choice (main/dataDir.ts), on a real folder
  if (onWindows) {
    const { resolveDataDir, realDataDirs } = await import(src + 'main/dataDir.ts')
    const fakeAppData = join(tmp, 'Roaming')
    assert.deepEqual(realDataDirs(fakeAppData), shared.dataDirCandidates(fakeAppData, 'win32'))
    const def = join(fakeAppData, 'Corvid')
    assert.equal(resolveDataDir(fakeAppData, def, {}).dir, shared.realDataDir(fakeAppData, () => false, 'win32'))
    mkdirSync(join(fakeAppData, 'Claude Dashboard'), { recursive: true })
    assert.equal(resolveDataDir(fakeAppData, def, {}).dir, join(fakeAppData, 'Claude Dashboard'))
    assert.equal(shared.realDataDir(fakeAppData, (d) => d === join(fakeAppData, 'Claude Dashboard'), 'win32'), join(fakeAppData, 'Claude Dashboard'))
  }
})

test('win32 temp folders for the import skip rules are skipEnv\'s', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', TEMP: 'C:\\T1', TMP: 'C:\\T2' }
  assert.deepEqual(P.tempDirs('win32', env, 'C:\\Tmp'), ['C:\\Tmp', 'C:\\Users\\x\\AppData\\Local\\Temp', 'C:\\T1', 'C:\\T2'])
  assert.deepEqual(P.tempDirs('win32', {}, 'C:\\Tmp'), ['C:\\Tmp'])
})

test('win32 shell list and default: PowerShell 7 first, only installed shells, same files and arguments', () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATH: 'C:\\bin;D:\\tools' }
  const all = new Set([
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\system32\\cmd.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Windows\\System32\\wsl.exe'
  ])
  assert.deepEqual(P.shellList('win32', env, (p) => all.has(p)), [
    { id: 'pwsh', label: 'PowerShell 7', args: ['-NoLogo'], file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    { id: 'powershell', label: 'PowerShell', args: ['-NoLogo'], file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    { id: 'cmd', label: 'Command Prompt', args: [], file: 'C:\\Windows\\system32\\cmd.exe' },
    { id: 'gitbash', label: 'Git Bash', args: ['--login', '-i'], file: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    { id: 'wsl', label: 'WSL', args: [], file: 'C:\\Windows\\System32\\wsl.exe' }
  ])
  // pwsh found on PATH only; no Git Bash, no WSL, ComSpec unset
  const some = new Set(['D:\\tools\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\cmd.exe'])
  const list = P.shellList('win32', { ...env, ComSpec: undefined }, (p) => some.has(p))
  assert.deepEqual(list.map((s) => [s.id, s.file]), [
    ['pwsh', 'D:\\tools\\pwsh.exe'],
    ['powershell', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
    ['cmd', 'C:\\Windows\\System32\\cmd.exe']
  ])
  // the project shell (pty.ts launchShell)
  assert.deepEqual(P.projectShell('win32'), { file: 'powershell.exe', args: ['-NoLogo'] })
  assert.deepEqual(P.loginEnv('win32'), {})
})

test('win32 kill: taskkill /PID <pid> /T /F from System32, never by name', () => {
  assert.deepEqual(shared.killTreeCommand(4242, 'win32', { SystemRoot: 'C:\\Windows' }), { file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '4242', '/T', '/F'] })
  assert.deepEqual(shared.killTreeCommand(7, 'win32', {}).file, 'C:\\Windows\\System32\\taskkill.exe')
  assert.ok(!shared.killTreeCommand(7, 'win32', {}).args.includes('/IM'))
  assert.equal(
    shared.listProcessesCommand('win32'),
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress"'
  )
  assert.deepEqual(shared.parseProcessList('[{"ProcessId":5,"ParentProcessId":1,"ExecutablePath":"C:\\\\X\\\\Corvid.exe"},{"ProcessId":6,"ParentProcessId":5,"ExecutablePath":null}]', 'win32'), [
    { pid: 5, ppid: 1, path: 'c:\\x\\corvid.exe' },
    { pid: 6, ppid: 5, path: '' }
  ])
  assert.equal(shared.insideDir('c:\\users\\x\\appdata\\local\\programs\\corvid\\corvid.exe', 'C:\\Users\\x\\AppData\\Local\\Programs\\Corvid', 'win32'), true)
  assert.equal(shared.insideDir('c:\\users\\x\\appdata\\local\\programs\\corvid.previous\\a\\corvid.exe', 'C:\\Users\\x\\AppData\\Local\\Programs\\Corvid', 'win32'), false)
})

test('win32 install profile is deploy.mjs\'s paths', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }
  const p = shared.installProfile('D:\\projects\\dashboard', 'win32', env)
  assert.deepEqual(p.builderArgs, ['--win', '--dir'])
  assert.equal(p.builtDir, 'D:\\projects\\dashboard\\dist\\win-unpacked')
  assert.equal(p.installDir, 'C:\\Users\\x\\AppData\\Local\\Programs\\Corvid')
  assert.equal(p.previousDir, 'C:\\Users\\x\\AppData\\Local\\Programs\\Corvid.previous')
  assert.equal(p.exeName, 'Corvid.exe')
  assert.equal(p.executable(p.installDir), 'C:\\Users\\x\\AppData\\Local\\Programs\\Corvid\\Corvid.exe')
  assert.equal(p.legacyInstallDir, 'C:\\Users\\x\\AppData\\Local\\Programs\\Claude Dashboard')
  assert.equal(p.legacyExeName, 'Claude Dashboard.exe')
  assert.equal(p.desktopEntry, null)
  assert.equal(shared.installProfile('D:\\r', 'win32', { ...env, CORVID_INSTALL_DIR: 'E:\\throwaway' }).installDir, 'E:\\throwaway')
  assert.equal(shared.installProfile('D:\\r', 'win32', { ...env, CORVID_INSTALL_DIR: 'E:\\throwaway' }).previousDir, 'E:\\throwaway.previous')
})

test('win32 claude locations: the VS Code extension and ~/.local/bin/claude.exe, never PATH', () => {
  const l = P.claudeLocations('win32', 'C:\\Users\\x')
  assert.equal(l.binary, 'claude.exe')
  assert.equal(l.extensionsRoot, 'C:\\Users\\x\\.vscode\\extensions')
  assert.deepEqual(l.extensionBinary, ['resources', 'native-binary', 'claude.exe'])
  assert.deepEqual(l.fixed, [{ path: 'C:\\Users\\x\\.local\\bin\\claude.exe', source: '~/.local/bin' }])
  assert.equal(l.usePath, false)
})

test('win32 launchers: Windows Terminal and VS Code through cmd.exe, same arguments as launch.ts had', () => {
  assert.deepEqual(P.externalTerminal('D:\\p', 'C:\\c\\claude.exe', ['--resume', 's1'], 'a;b', 'win32'), {
    file: 'wt.exe',
    args: ['-w', 'new', 'new-tab', '-d', 'D:\\p', '--title', 'a,b', 'C:\\c\\claude.exe', '--resume', 's1']
  })
  assert.deepEqual(P.externalTerminal('D:\\p', 'claude', [], undefined, 'win32').args, ['-w', 'new', 'new-tab', '-d', 'D:\\p', 'claude'])
  assert.deepEqual(P.vscodeCommand(['"D:\\p"'], 'win32'), { file: 'cmd.exe', args: ['/d', '/s', '/c', 'code', '"D:\\p"'], verbatim: true })
  assert.deepEqual(P.vscodeCommand(['-r', '"D:\\p\\a.ts"'], 'win32').args, ['/d', '/s', '/c', 'code', '-r', '"D:\\p\\a.ts"'])
  assert.equal(P.loginItemKind('win32'), 'electron')
  assert.equal(P.badgeKind('win32'), 'overlay')
  assert.deepEqual(P.trayImage('win32'), { normal: 'tray.png', alert: 'tray-alert.png' })
})

test('win32 toNative is winPath without its trim', () => {
  assert.equal(P.toNative('D:/projects/dashboard/.git', 'win32'), 'D:\\projects\\dashboard\\.git')
  assert.equal(P.toNative('C:\\already', 'win32'), 'C:\\already')
})

test('the window gets Ctrl on Windows and Linux, Cmd on macOS', () => {
  assert.deepEqual({ ...platformInfo('win32') }, { os: 'win32', isMac: false, modKey: 'ctrlKey', modLabel: 'Ctrl', keySep: '+' })
  assert.equal(shortcutLabel(platformInfo('win32'), 'J'), 'Ctrl+J')
  assert.equal(shortcutLabel(platformInfo('linux'), 'K'), 'Ctrl+K')
  assert.equal(shortcutLabel(platformInfo('darwin'), 'J'), '⌘J')
  assert.equal(platformInfo('darwin').modKey, 'metaKey')
  assert.equal(platformInfo('freebsd').os, 'linux')
  assert.ok(Object.isFrozen(platformInfo('win32')))
})

// ---------- macOS and Linux: planned values, and the parts later tasks fill in ----------

test('darwin and linux paths keep / and fold case only on macOS', () => {
  assert.equal(P.pathKey('/Users/X/Repo/', 'darwin'), '/users/x/repo')
  assert.equal(P.pathKey('/home/x/Repo/', 'linux'), '/home/x/Repo')
  assert.equal(P.pathKey('/', 'linux'), '/')
  assert.equal(P.within('/home/x/repo/src', '/home/x/repo', 'linux'), true)
  assert.equal(P.within('/home/x/repo-worktrees/a', '/home/x/repo', 'linux'), false)
  assert.equal(P.toNative('/home/x/repo', 'linux'), '/home/x/repo')
  assert.deepEqual(P.tempDirs('darwin', {}, '/var/folders/ab/T'), ['/var/folders/ab/T', '/private/var/folders/ab/T'])
  assert.deepEqual(P.tempDirs('linux', { TMPDIR: '/tmp' }, '/tmp'), ['/tmp'])
})

test('darwin and linux data folders follow electron\'s appData, with no "Claude Dashboard" legacy', () => {
  assert.equal(shared.appDataDir('darwin', {}, '/Users/x'), '/Users/x/Library/Application Support')
  assert.equal(shared.appDataDir('linux', {}, '/home/x'), '/home/x/.config')
  assert.equal(shared.appDataDir('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/x'), '/cfg')
  assert.deepEqual(shared.dataDirCandidates('/Users/x/Library/Application Support', 'darwin'), ['/Users/x/Library/Application Support/Corvid'])
  assert.equal(shared.realDataDir('/home/x/.config', () => true, 'linux'), '/home/x/.config/Corvid')
})

test('darwin and linux install profiles are the planned ones', () => {
  const mac = shared.installProfile('/src/corvid', 'darwin', {}, '/Users/x')
  assert.deepEqual(mac.builderArgs, ['--mac', '--dir'])
  assert.equal(mac.installDir, '/Users/x/Applications/Corvid.app')
  assert.equal(mac.executable(mac.installDir), '/Users/x/Applications/Corvid.app/Contents/MacOS/Corvid')
  const lin = shared.installProfile('/src/corvid', 'linux', {}, '/home/x')
  assert.deepEqual(lin.builderArgs, ['--linux', '--dir'])
  assert.equal(lin.builtDir, '/src/corvid/dist/linux-unpacked')
  assert.equal(lin.installDir, '/home/x/.local/share/corvid/app')
  assert.equal(lin.desktopEntry, '/home/x/.local/share/applications/corvid.desktop')
  assert.equal(lin.executable(lin.installDir), '/home/x/.local/share/corvid/app/corvid')
})

test('darwin and linux claude locations, shells and OS facts', () => {
  const mac = P.claudeLocations('darwin', '/Users/x')
  assert.equal(mac.binary, 'claude')
  assert.equal(mac.usePath, true)
  assert.ok(mac.fixed.some((f) => f.path === '/opt/homebrew/bin/claude'))
  assert.deepEqual(P.claudeLocations('linux', '/home/x').fixed.map((f) => f.path), ['/home/x/.local/bin/claude', '/home/x/.claude/local/claude'])
  assert.equal(P.loginItemKind('darwin'), 'electron')
  assert.equal(P.loginItemKind('linux'), 'autostart-desktop')
  assert.equal(P.badgeKind('darwin'), 'dock')
  assert.equal(P.trayImage('darwin').normal, 'trayTemplate.png')
})

// ---------- #153: POSIX shells and killing process trees ----------

test('posix shells: the login shell first, then zsh, bash, fish, sh and pwsh where installed, each once', () => {
  const has = (...files) => (p) => files.includes(p)
  const mac = has('/bin/zsh', '/bin/bash', '/bin/sh', '/opt/homebrew/bin/fish')
  assert.deepEqual(P.shellList('darwin', { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }, mac), [
    { id: 'zsh', label: 'zsh', args: ['-l'], file: '/bin/zsh' },
    { id: 'bash', label: 'bash', args: ['-l'], file: '/bin/bash' },
    { id: 'fish', label: 'fish', args: ['-l'], file: '/opt/homebrew/bin/fish' },
    { id: 'sh', label: 'sh', args: ['-l'], file: '/bin/sh' }
  ])
  assert.deepEqual(P.projectShell('darwin', { SHELL: '/bin/zsh' }, mac), { file: '/bin/zsh', args: ['-l'] })
  // the user's own shell wins over the one on the PATH, and an unknown one is listed by its name
  const lin = has('/usr/bin/fish', '/home/x/bin/fish', '/usr/bin/bash', '/bin/sh', '/usr/bin/pwsh', '/usr/local/bin/nu')
  assert.deepEqual(P.shellList('linux', { SHELL: '/home/x/bin/fish', PATH: '/usr/bin' }, lin).map((s) => [s.id, s.file, s.args]), [
    ['fish', '/home/x/bin/fish', ['-l']],
    ['bash', '/usr/bin/bash', ['-l']],
    ['sh', '/bin/sh', ['-l']],
    ['pwsh', '/usr/bin/pwsh', ['-NoLogo']]
  ])
  assert.deepEqual(P.shellList('linux', { SHELL: '/usr/local/bin/nu' }, lin)[0], { id: 'nu', label: 'nu', args: ['-l'], file: '/usr/local/bin/nu' })
  // $SHELL unset or missing: the first installed one; nothing at all: /bin/sh -l
  assert.deepEqual(P.projectShell('linux', { SHELL: '/gone/zsh' }, lin), { file: '/usr/bin/bash', args: ['-l'] })
  assert.deepEqual(P.projectShell('linux', {}, () => false), { file: '/bin/sh', args: ['-l'] })
  assert.deepEqual(P.shellList('linux', {}, () => false), [])
})

// What `ps -A -o pid=,ppid=,pgid=,stat=` prints, procps and BSD alike: Corvid (100) runs a terminal's shell (200, its
// own session and group, as node-pty makes it), which runs a job (300, its own group, as an interactive shell
// makes it) with a SIGHUP-ignoring child (301); 302 is a dead child not reaped yet; 500 was in the job's group but
// its parent died, so it's now init's. Corvid also runs an npm install (600 and 601) in its own group.
const PS = `
    1     0     1 Ss
   90     1    90 Ss
  100    90   100 Sl
  200   100   200 Ss+
  300   200   300 S
  301   300   300 Sl
  302   300   300 Z
  500     1   300 S
  600   100   100 S
  601   600   100 Sl
  700     1   700 Ss
 garbage line
`

test('posix tree walking from ps output', () => {
  const list = shared.parsePsTree(PS)
  assert.equal(list.length, 11)
  assert.deepEqual(list[3], { pid: 200, ppid: 100, pgid: 200, zombie: false })
  assert.equal(list.find((p) => p.pid === 302).zombie, true)
  assert.deepEqual(shared.treeOf(200, list), [200, 300, 301, 302])
  assert.deepEqual(shared.treeOf(600, list), [600, 601])
  assert.deepEqual(shared.treeOf(999, list), [999])
  // the shell's tree and the groups it leads (its own and the job's, which reaches the orphaned 500)
  assert.deepEqual(shared.posixKillPlan(200, list, 100), { pids: [200, 300, 301, 302], groups: [200, 300] })
  // the npm install shares Corvid's group: its tree only, never Corvid's group
  assert.deepEqual(shared.posixKillPlan(600, list, 100), { pids: [600, 601], groups: [] })
  // never Corvid itself, init or pid 0
  for (const pid of [100, 1, 0, -5]) assert.deepEqual(shared.posixKillPlan(pid, list, 100), { pids: [], groups: [] })
  // nor anything Corvid runs under: a tree with Corvid in it is refused whole
  assert.deepEqual(shared.posixKillPlan(90, list, 100), { pids: [], groups: [] })
  // no ps: the pid alone and no group, since its group can't be checked
  assert.deepEqual(shared.posixKillPlan(200, [], 100), { pids: [200], groups: [] })
  assert.deepEqual(shared.psTreeCommand, { file: 'ps', args: ['-A', '-o', 'pid=,ppid=,pgid=,stat='] })
})

/** A fake process table for killTree: who is alive, and which signals each one ignores. */
function fakeProcs(ignores = {}) {
  const procs = new Map(shared.parsePsTree(PS).map((p) => [p.pid, { ...p, alive: true }]))
  const sent = []
  const hit = (p, sig) => {
    if (p.alive && !p.zombie && (sig === 'SIGKILL' || !(ignores[p.pid] ?? []).includes(sig))) p.alive = false
  }
  return {
    sent,
    procs,
    deps: {
      self: 100,
      ps: async () => [...procs.values()].filter((p) => p.alive).map((p) => `${p.pid} ${p.ppid} ${p.pgid} ${p.zombie ? 'Z' : 'S'}`).join('\n'),
      signal: (target, sig) => {
        sent.push([target, sig])
        if (target < 0) for (const p of procs.values()) p.pgid === -target && hit(p, sig)
        else if (procs.has(target)) hit(procs.get(target), sig)
      },
      alive: (pid) => procs.get(pid)?.alive ?? false,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))
    }
  }
}

test('posix killTree: SIGTERM to the tree and its groups, SIGHUP to the shell, done when all are gone', async () => {
  const f = fakeProcs({ 200: ['SIGTERM'], 301: ['SIGHUP'] })
  assert.equal(await shared.killTree(200, { timeoutMs: 1000, graceMs: 200 }, 'linux', f.deps), null)
  assert.deepEqual(f.sent, [[-200, 'SIGTERM'], [-300, 'SIGTERM'], [200, 'SIGTERM'], [300, 'SIGTERM'], [301, 'SIGTERM'], [302, 'SIGTERM'], [200, 'SIGHUP']])
  for (const pid of [200, 300, 301, 500]) assert.equal(f.procs.get(pid).alive, false, `pid ${pid}`)
  for (const pid of [100, 600, 601, 700]) assert.equal(f.procs.get(pid).alive, true, `pid ${pid} untouched`)
  assert.ok(!f.sent.some(([t]) => t === 100 || t === -100 || t === -90 || t === 1), 'never Corvid, its group or init')
})

test('posix killTree: SIGKILL after the grace period, only to what is left', async () => {
  const f = fakeProcs({ 301: ['SIGTERM', 'SIGHUP'] })
  assert.equal(await shared.killTree(200, { timeoutMs: 1000, graceMs: 50 }, 'darwin', f.deps), null)
  const kills = f.sent.filter(([, sig]) => sig === 'SIGKILL')
  assert.deepEqual(kills, [[-200, 'SIGKILL'], [-300, 'SIGKILL'], [301, 'SIGKILL']])
  assert.equal(f.procs.get(301).alive, false)
})

test('posix killTree rootFirstMs: the app gets SIGTERM alone and ends its own children, GPU process included (#178)', async () => {
  const f = fakeProcs()
  const signal = f.deps.signal
  // like Electron: SIGTERM to the app (200) and it shuts its whole tree down itself
  f.deps.signal = (target, sig) => {
    signal(target, sig)
    if (target === 200 && sig === 'SIGTERM') for (const pid of [300, 301]) f.procs.get(pid).alive = false
  }
  assert.equal(await shared.killTree(200, { timeoutMs: 1000, graceMs: 50, rootFirstMs: 200 }, 'linux', f.deps), null)
  assert.deepEqual(f.sent, [[200, 'SIGTERM']], 'nothing else is signalled while the app shuts down')
  // an app that doesn't go in time: the usual tree-wide SIGTERM and SIGKILL follow
  const hung = fakeProcs({ 200: ['SIGTERM', 'SIGHUP'] })
  assert.equal(await shared.killTree(200, { timeoutMs: 1000, graceMs: 50, rootFirstMs: 30 }, 'linux', hung.deps), null)
  assert.deepEqual(hung.sent.slice(0, 2), [[200, 'SIGTERM'], [-200, 'SIGTERM']])
  assert.ok(hung.sent.some(([t, sig]) => t === -200 && sig === 'SIGKILL'))
  assert.equal(hung.procs.get(200).alive, false)
})

test("posix killTree: an npm install in Corvid's own group is ended by its tree, never by the group", async () => {
  const f = fakeProcs()
  assert.equal(await shared.killTree(600, { timeoutMs: 500, graceMs: 50 }, 'linux', f.deps), null)
  assert.deepEqual(f.sent, [[600, 'SIGTERM'], [601, 'SIGTERM'], [600, 'SIGHUP']])
  assert.equal(f.procs.get(100).alive, true)
})

test('posix killTree: refuses Corvid and init, and reports what survived', async () => {
  const f = fakeProcs()
  assert.match((await shared.killTree(100, {}, 'linux', f.deps)).message, /refused/)
  assert.match((await shared.killTree(1, {}, 'linux', f.deps)).message, /refused/)
  assert.deepEqual(f.sent, [])
  // a process that survives SIGKILL (stuck in the kernel): an error naming it once the timeout has passed
  const stuck = fakeProcs()
  stuck.deps.signal = (target, sig) => stuck.sent.push([target, sig])
  const err = await shared.killTree(600, { timeoutMs: 100, graceMs: 30 }, 'linux', stuck.deps)
  assert.match(err.message, /pid 600, 601 still running 100 ms after SIGKILL/)
})

test('posix killTree on a real child this test started (skipped on Windows)', { skip: onWindows && 'POSIX only' }, async () => {
  const { spawn } = await import('node:child_process')
  // a group leader whose child ignores SIGHUP and SIGTERM, like a stubborn tool a shell started
  const js = "process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log(process.pid)"
  const child = spawn('/bin/sh', ['-c', `"${process.execPath}" -e "${js}" & wait`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const grandchild = Number(await new Promise((r) => child.stdout.once('data', (d) => r(String(d).trim()))))
  assert.equal(await shared.killTree(child.pid, { timeoutMs: 5000, graceMs: 300 }), null)
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  assert.equal(alive(grandchild), false, 'the grandchild is gone')
})

test('win32 killTree still runs taskkill /PID <pid> /T /F (the command is pinned above)', { skip: !onWindows && 'Windows only' }, async () => {
  // a pid that can't exist: taskkill says so, which shows the Windows branch ran taskkill
  const err = await shared.killTree(2 ** 31 - 2, { timeoutMs: 10_000 }, 'win32')
  assert.ok(err, 'taskkill fails for a pid that does not exist')
  assert.match(String(err.cmd ?? err.message), /taskkill\.exe"? \/PID 2147483646 \/T \/F/i)
})

test('what later tasks fill in says so instead of guessing', () => {
  for (const os of ['darwin', 'linux']) {
    assert.throws(() => shared.killTreeCommand(1, os), /not implemented yet on/)
    assert.deepEqual(P.loginEnv(os), {}) // #152: what loginEnv.ts merged, and nothing has been merged here
  }
})

test('on this machine the defaults are this platform\'s', () => {
  assert.equal(P.platformOf(), P.platformOf(process.platform))
  if (onWindows) assert.equal(shared.appDataDir(), process.env.APPDATA)
  // node:path on Windows is path.win32, so the Windows branches join exactly as the old code did
  if (onWindows) assert.equal(shared.pathsOf('win32').join, win32.join)
})

// ---------- #154: data folders, deploy and test-instance on every platform ----------

/** Each platform's real data folder for a made-up user, as the app, deploy.mjs and test-instance.mjs find it. */
const REAL = {
  win32: { env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, home: 'C:\\Users\\x', real: 'C:\\Users\\x\\AppData\\Roaming\\Corvid' },
  darwin: { env: {}, home: '/Users/x', real: '/Users/x/Library/Application Support/Corvid' },
  linux: { env: {}, home: '/home/x', real: '/home/x/.config/Corvid' }
}

test('a test copy is refused the real data folder on all three platforms, however it is spelled', async () => {
  const { resolveDataDir } = await import(src + 'main/dataDir.ts')
  for (const [os, { env, home, real }] of Object.entries(REAL)) {
    const appData = shared.appDataDir(os, env, home)
    assert.equal(shared.realDataDir(appData, () => false, os), real, os)
    const { join: at, sep } = shared.pathsOf(os)
    for (const v of [real, real + sep, real.toUpperCase(), real.toLowerCase(), at(real, 'x', '..')]) {
      const r = resolveDataDir(appData, real, { DASH_DATA_DIR: v, DASH_TEST_INSTANCE: 'unit' }, os)
      assert.ok('error' in r, `${os}: should refuse ${v}`)
    }
    // the pre-rename name is refused too, everywhere: refusing more is the safe direction
    assert.ok('error' in resolveDataDir(appData, real, { DASH_DATA_DIR: at(appData, 'Claude Dashboard') }, os), os)
    assert.equal(resolveDataDir(appData, real, { DASH_DATA_DIR: at(appData, 'CorvidTest') }, os).test, true, `${os}: a sibling folder is fine`)
  }
})

test("test-instance.mjs never puts a copy's data in the real data folder, on all three platforms", async () => {
  const { insideRealData } = await import('./test-instance.mjs')
  for (const [os, { env, home, real }] of Object.entries(REAL)) {
    const { join: at, sep } = shared.pathsOf(os)
    for (const v of [real, real + sep, real.toUpperCase(), at(real, 'corvid-test-instances', 'a-1', 'data'), at(shared.appDataDir(os, env, home), 'Claude Dashboard')])
      assert.equal(insideRealData(v, os, env, home), true, `${os}: ${v}`)
    for (const v of [at(shared.appDataDir(os, env, home), 'CorvidTest'), at(home, 'tmp', 'corvid-test-instances', 'a-1', 'data')])
      assert.equal(insideRealData(v, os, env, home), false, `${os}: ${v}`)
  }
  assert.equal(insideRealData('/cfg/Corvid/x', 'linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/x'), true, 'XDG_CONFIG_HOME')
  // where test copies go by default is never inside it
  assert.equal(insideRealData(join(tmpdir(), 'corvid-test-instances', 'x', 'data')), false)
})

test('the app keeps "Claude Dashboard" only on Windows', async () => {
  const { resolveDataDir } = await import(src + 'main/dataDir.ts')
  const appData = join(tmp, 'legacy-appdata')
  mkdirSync(join(appData, 'Claude Dashboard'), { recursive: true })
  const def = join(appData, 'Corvid')
  assert.equal(resolveDataDir(appData, def, {}, 'win32').dir, join(appData, 'Claude Dashboard'))
  for (const os of ['darwin', 'linux']) assert.equal(resolveDataDir(appData, def, {}, os).dir, def)
})

test('posix process list for deploy: ps with the command line, matched on the install folder, never a name', () => {
  for (const os of ['darwin', 'linux']) assert.equal(shared.listProcessesCommand(os), 'ps -A -o pid=,ppid=,command=')
  const out = '    1     0 /sbin/launchd\n  501     1 /Users/x/Applications/Corvid.app/Contents/MacOS/Corvid --type=renderer\n\n  777   501 /usr/bin/Corvid\nnot a line\n'
  assert.deepEqual(shared.parseProcessList(out, 'darwin'), [
    { pid: 1, ppid: 0, path: '/sbin/launchd' },
    { pid: 501, ppid: 1, path: '/Users/x/Applications/Corvid.app/Contents/MacOS/Corvid --type=renderer' },
    { pid: 777, ppid: 501, path: '/usr/bin/Corvid' }
  ])
  const app = '/Users/x/Applications/Corvid.app'
  assert.equal(shared.insideDir('/Users/x/Applications/Corvid.app/Contents/MacOS/Corvid --flag', app, 'darwin'), true)
  assert.equal(shared.insideDir('/users/x/applications/corvid.app/Contents/MacOS/Corvid', app, 'darwin'), true, 'macOS folds case')
  assert.equal(shared.insideDir('/Users/x/Applications/Corvid.app.previous/1/Contents/MacOS/Corvid', app, 'darwin'), false)
  assert.equal(shared.insideDir('/usr/bin/Corvid', app, 'darwin'), false, 'a process called Corvid elsewhere is left alone')
  const lin = '/home/x/.local/share/corvid/app'
  assert.equal(shared.insideDir('/home/x/.local/share/corvid/app/corvid --no-sandbox', lin + '/', 'linux'), true)
  assert.equal(shared.insideDir('/home/x/.local/share/corvid/APP/corvid', lin, 'linux'), false, 'Linux keeps case')
  assert.equal(shared.insideDir('/home/x/.local/share/corvid/app.previous/1/corvid', lin, 'linux'), false)
})

test('install profiles: where the kept copies and resources go, and a throwaway install stays out of the app menu', () => {
  const mac = shared.installProfile('/src', 'darwin', {}, '/Users/x')
  assert.equal(mac.previousDir, '/Users/x/Library/Application Support/Corvid/previous-builds', 'outside Launchpad')
  assert.equal(mac.resources(mac.builtDir), mac.builtDir + '/Contents/Resources')
  assert.equal(mac.pathDelimiter, ':')
  assert.equal(shared.installProfile('/src', 'darwin', { CORVID_INSTALL_DIR: '/tmp/t/Corvid.app' }, '/Users/x').previousDir, '/tmp/t/Corvid.app.previous')
  const lin = shared.installProfile('/src', 'linux', {}, '/home/x')
  assert.equal(lin.previousDir, '/home/x/.local/share/corvid/app.previous')
  assert.equal(lin.resources(lin.installDir), '/home/x/.local/share/corvid/app/resources')
  assert.equal(shared.installProfile('/src', 'linux', { CORVID_INSTALL_DIR: '/tmp/t/app' }, '/home/x').desktopEntry, null)
  const win = shared.installProfile('D:\\r', 'win32', { LOCALAPPDATA: 'C:\\L' })
  assert.equal(win.resources(win.builtDir), 'D:\\r\\dist\\win-unpacked\\resources')
  assert.equal(win.pathDelimiter, ';')
})

test('setup checks: the native packages and Electron binary per platform, git hints, and the install of a running app', () => {
  assert.deepEqual(shared.nativeDeps('win32', 'x64'), { pty: '@lydell/node-pty-win32-x64', electron: 'electron/dist/electron.exe' }, 'what corvidSelf checked before')
  assert.deepEqual(shared.nativeDeps('darwin', 'arm64'), { pty: '@lydell/node-pty-darwin-arm64', electron: 'electron/dist/Electron.app/Contents/MacOS/Electron' })
  assert.deepEqual(shared.nativeDeps('linux', 'x64'), { pty: '@lydell/node-pty-linux-x64', electron: 'electron/dist/electron' })
  assert.equal(shared.gitInstallHint('win32'), 'Install Git for Windows from git-scm.com')
  assert.match(shared.gitInstallHint('darwin'), /xcode-select --install/)
  assert.match(shared.gitInstallHint('linux'), /package manager/)
  for (const os of ['darwin', 'linux']) assert.doesNotMatch(shared.gitInstallHint(os), /Windows/)
  assert.deepEqual(shared.installOf('C:\\L\\Programs\\Corvid\\Corvid.exe', 'win32'), { dir: 'C:\\L\\Programs\\Corvid', previousDir: 'C:\\L\\Programs\\Corvid.previous' })
  assert.deepEqual(shared.installOf('/Users/x/Applications/Corvid.app/Contents/MacOS/Corvid', 'darwin', {}, '/Users/x'), {
    dir: '/Users/x/Applications/Corvid.app',
    previousDir: shared.installProfile('/src', 'darwin', {}, '/Users/x').previousDir
  })
  const lin = shared.installProfile('/src', 'linux', {}, '/home/x')
  assert.deepEqual(shared.installOf(lin.executable(lin.installDir), 'linux', {}, '/home/x'), { dir: lin.installDir, previousDir: lin.previousDir })
  // and on this machine, npm put them there
  const nm = join(import.meta.dirname, '..', 'node_modules')
  for (const p of Object.values(shared.nativeDeps())) assert.ok(existsSync(join(nm, p)), p)
  assert.ok(shared.electronBinaryPresent(nm), 'and path.txt beside dist/')
})

test('the Linux app-menu entry quotes the executable', () => {
  const text = shared.desktopEntryText('/home/x/my "apps"/corvid/app/corvid', '/home/x/.local/share/corvid/icon.png')
  assert.match(text, /^\[Desktop Entry\]\n/)
  // the quoting escape, then the string escape on top (Desktop Entry spec): a " in the path is \\" in the file
  assert.match(text, /\nExec="\/home\/x\/my \\\\"apps\\\\"\/corvid\/app\/corvid" %U\n/)
  assert.match(text, /\nIcon=\/home\/x\/.local\/share\/corvid\/icon.png\n/)
  assert.match(text, /\nTerminal=false\n/)
  assert.ok(!shared.desktopEntryText('/a/corvid').includes('Icon='))
})
