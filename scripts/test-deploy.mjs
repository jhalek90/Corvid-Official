// Tests for #154: scripts/deploy.mjs runs its whole flow (build, package check, stop the old app, keep the previous
// install, copy in, start, wait for health.json, roll back) against a throwaway install, with child_process swapped
// for a recorder. Nothing is built, started or killed: git, PowerShell, taskkill, electron-builder and the app
// itself are all answered by the stand-in, and every folder (install, data, %APPDATA%, %LOCALAPPDATA%, the main
// checkout) is made up inside one temp folder, so the real install and the real data folder are never touched.
//
// On Windows the same five runs (first install, an update with the old app running, a build that never reports
// healthy and is rolled back, --rollback, --detach) are made with deploy.mjs as it is and with the one tagged
// pre-crossplatform (git show), and the commands, their options, the log and the files left behind must be the
// same: the Windows deploy is unchanged by the cross-platform work. Off Windows the current script runs the Linux
// or macOS profile through the same stand-in. The deliberate Windows changes since then (#177) are listed in deliberate().
//
//   npm run test-deploy

import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const repo = join(import.meta.dirname, '..')
const onWindows = process.platform === 'win32'
const tmp = mkdtempSync(join(tmpdir(), 'corvid-deploy-test-'))
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))

// ---------- the stand-in for node:child_process ----------

const mockFile = join(tmp, 'child-process-mock.mjs')
writeFileSync(
  mockFile,
  `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const E = process.env
const rec = (r) => appendFileSync(E.MOCK_TRACE, JSON.stringify(r) + '\\n')
const win = process.platform === 'win32'
const exe = win ? 'Corvid.exe' : process.platform === 'darwin' ? 'Contents/MacOS/Corvid' : 'corvid'
// the old app: a made-up pid 4242 on Windows, where taskkill is the stand-in's too; off Windows a real sleep the
// test started, because killTree signals it for real (and must, to show it stops the right process)
const runPid = Number(E.MOCK_RUNNING_PID || 4242)
let winRunning = E.MOCK_RUNNING === '1'
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const running = () => (win ? winRunning : E.MOCK_RUNNING === '1' && isAlive(runPid))
const pick = (o) => o && { cwd: o.cwd, stdio: o.stdio, detached: o.detached, timeout: o.timeout, encoding: o.encoding,
  runAsNode: o.env?.ELECTRON_RUN_AS_NODE, firstPath: o.env?.PATH?.split(win ? ';' : ':')[0], sameEnv: o.env === process.env }
export function execSync(cmd, o) {
  rec({ kind: 'execSync', cmd, o: pick(o) })
  if (E.MOCK_NO_GIT === '1' && cmd.startsWith('git ')) throw new Error('fatal: not a git repository')
  if (cmd.startsWith('git rev-parse --path-format')) return E.MOCK_ROOT.replace(/\\\\/g, '/') + '/.git\\n'
  if (cmd.startsWith('git log -1')) return 'abc1234 A test commit\\n'
  if (cmd === 'git rev-parse HEAD') return 'abc1234def5678abc1234def5678abc1234def56\\n'
  if (cmd.startsWith('powershell -NoProfile -Command')) {
    const list = [{ ProcessId: process.pid, ParentProcessId: 1, ExecutablePath: process.execPath }]
    if (running()) list.push({ ProcessId: 4242, ParentProcessId: 1, ExecutablePath: join(E.CORVID_INSTALL_DIR, exe) })
    return JSON.stringify(list)
  }
  if (cmd.startsWith('ps -A')) return process.pid + ' 1 ' + process.execPath + '\\n' + (running() ? runPid + ' 1 ' + join(E.CORVID_INSTALL_DIR, exe) + ' --flag\\n' : '')
  if (cmd.startsWith('taskkill /IM')) throw new Error('not running')
  if (cmd === 'taskkill /PID 4242 /F /T') return (winRunning = false), ''
  if (cmd.startsWith('npx electron-builder')) {
    const built = E.MOCK_BUILT
    mkdirSync(join(built, exe, '..'), { recursive: true })
    writeFileSync(join(built, exe), 'app')
    mkdirSync(join(built, win || process.platform === 'linux' ? 'resources' : 'Contents/Resources', 'app.asar'), { recursive: true })
    return ''
  }
  if (cmd.startsWith('powershell -NoProfile -EncodedCommand ')) {
    rec({ kind: 'decoded', ps: Buffer.from(cmd.slice(38), 'base64').toString('utf16le') })
    return ''
  }
  return ''
}
export function spawn(file, args, o) {
  rec({ kind: 'spawn', file, args, o: pick(o) })
  if (E.MOCK_HEALTHY === '1' && file.startsWith(E.CORVID_INSTALL_DIR))
    writeFileSync(join(E.DASH_DATA_DIR, 'health.json'), JSON.stringify({ at: Date.now(), commit: 'abc1234def5678abc1234def5678abc1234def56' }))
  return { unref() {}, on() {}, pid: 0 }
}
// killTree (POSIX) only: the stand-in app "exits" when its pid is signalled
export function execFile(file, args, o, cb) {
  rec({ kind: 'execFile', file, args })
  if (file === 'ps') cb(null, process.pid + ' 1 ' + process.pid + ' S\\n' + (running() ? runPid + ' 1 ' + runPid + ' S\\n' : ''))
  else cb(new Error('not in the stand-in'))
}
`
)
const hooksFile = join(tmp, 'hooks.mjs')
writeFileSync(
  hooksFile,
  `const mock = ${JSON.stringify(pathToFileURL(mockFile).href)}
export async function resolve(s, c, next) {
  if ((s === 'node:child_process' || s === 'child_process') && c.parentURL !== mock) return { url: mock, shortCircuit: true }
  return next(s, c)
}`
)
const registerFile = join(tmp, 'register.mjs')
writeFileSync(registerFile, `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hooksFile).href)})\n`)

// ---------- one sandbox per version of the script ----------

/** A made-up main checkout with this version of deploy.mjs (and the platform layer it imports), plus throwaway
 *  %APPDATA%, %LOCALAPPDATA%, data and install folders. */
function sandbox(name, deploySource) {
  const box = join(tmp, name)
  const root = join(box, 'repo')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'deploy.mjs'), deploySource)
  cpSync(join(repo, 'src', 'main', 'platform', 'shared.mjs'), join(root, 'src', 'main', 'platform', 'shared.mjs'))
  mkdirSync(join(root, 'out', 'main'), { recursive: true })
  writeFileSync(join(root, 'out', 'main', 'index.js'), 'require("ssh2"); require("node:fs"); require("electron"); require("./x")')
  mkdirSync(join(root, 'resources'), { recursive: true })
  writeFileSync(join(root, 'resources', 'icon.png'), 'png')
  for (const d of ['roaming', 'local', 'data', 'home']) mkdirSync(join(box, d), { recursive: true })
  const built = onWindows ? join(root, 'dist', 'win-unpacked') : process.platform === 'darwin' ? join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Corvid.app') : join(root, 'dist', 'linux-unpacked')
  return { box, root, built, trace: join(box, 'trace.jsonl'), install: join(box, 'install', onWindows ? 'Corvid' : 'Corvid.app') }
}

/** Runs deploy.mjs once in `s` and returns what it did, with the sandbox path, times and pids made comparable. */
async function run(s, args, { healthy = true, running = false, env: extra = {} } = {}) {
  // kept installs are named by the second; two deploys within one would share a name
  await new Promise((r) => setTimeout(r, 1100))
  writeFileSync(s.trace, '')
  const env = { ...process.env }
  for (const k of ['DASHBOARD_PTY', 'ELECTRON_RUN_AS_NODE', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME']) delete env[k]
  Object.assign(env, {
    CORVID_INSTALL_DIR: s.install,
    APPDATA: join(s.box, 'roaming'),
    LOCALAPPDATA: join(s.box, 'local'),
    HOME: join(s.box, 'home'),
    DASH_DATA_DIR: join(s.box, 'data'),
    CORVID_HEALTH_SECS: '2',
    MOCK_TRACE: s.trace,
    MOCK_ROOT: s.root,
    MOCK_BUILT: s.built,
    MOCK_HEALTHY: healthy ? '1' : '0',
    MOCK_RUNNING: running ? '1' : '0',
    ...extra
  })
  // off Windows the "old app" is a real process of this test's, which deploy.mjs has to end through killTree
  const old = running && !onWindows ? spawn('sleep', ['30'], { stdio: 'ignore' }) : null
  if (old) env.MOCK_RUNNING_PID = String(old.pid)
  // async, so this process reaps the stand-in app as soon as it's killed
  const r = await new Promise((res) => {
    const p = spawn(process.execPath, ['--import', pathToFileURL(registerFile).href, join(s.root, 'scripts', 'deploy.mjs'), ...args], { env })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (b) => (stdout += b))
    p.stderr.on('data', (b) => (stderr += b))
    const timer = setTimeout(() => p.kill(), 60_000)
    p.on('close', (status) => (clearTimeout(timer), res({ status, stdout, stderr })))
  })
  const oldGone = !old || old.exitCode !== null || old.signalCode !== null
  if (old && !oldGone) old.kill('SIGKILL')
  const norm = (t) =>
    t
      .split(s.box).join('<box>')
      .split(s.box.replace(/\\/g, '/')).join('<box>')
      .split(JSON.stringify(s.box).slice(1, -1)).join('<box>')
      .replace(/corvid-verify-\d+/g, 'corvid-verify-<pid>')
      // the encoded PowerShell holds the sandbox's path; the "decoded" entry after it is compared instead
      .replace(/-EncodedCommand [A-Za-z0-9+/=]+/g, '-EncodedCommand <base64 of the decoded entry>')
      .replace(/^\[[^\]]*\] /gm, '')
      .replace(/\d{8}-\d{6}/g, '<stamp>')
      .split(tmpdir()).join('<tmp>')
  return {
    oldGone,
    status: r.status,
    log: norm(r.stdout),
    stderr: norm(r.stderr),
    trace: readFileSync(s.trace, 'utf8').split('\n').filter(Boolean).map((l) => norm(l)),
    files: listFiles(s.box).map(norm)
  }
}

const listFiles = (dir) => {
  const out = []
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      if (n === 'trace.jsonl') continue
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(dir, p).replace(/\\/g, '/') + (/notice|corvid-source/.test(n) ? ' ' + readFileSync(p, 'utf8').replace(/"at": ?\d+/, '"at":0') : ''))
    }
  }
  walk(dir)
  return out
}

/** The five runs, in order, in one sandbox. */
async function flow(s) {
  return [
    ['first install', await run(s, [])],
    ['update with the old app running', await run(s, [], { running: true })],
    ['a build that never reports healthy', await run(s, [], { healthy: false })],
    ['--rollback', await run(s, ['--rollback'])],
    ['--detach', await run(s, ['--detach'])]
  ]
}

const tagged = (() => {
  try {
    return execFileSync('git', ['show', 'pre-crossplatform:scripts/deploy.mjs'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
})()

/**
 * The deliberate changes since pre-crossplatform, applied to what the tagged script did; everything else must match.
 * #177: every run appends to deploy.log (not only a background one); a first install waits for health.json too;
 * a rolled-back deploy exits 2 and waits for the restored build; --rollback waits for the restored build. And a
 * throwaway install (CORVID_INSTALL_DIR, as every run here) never runs taskkill /IM: by name it would also end the
 * user's real Corvid. Only what runs from the throwaway folders is stopped, by pid, as before.
 */
function deliberate(name, b) {
  const r = { ...b, files: b.files.includes('data/deploy.log') ? b.files : [...b.files, 'data/deploy.log'] }
  r.trace = b.trace.filter((t) => !t.includes('taskkill /IM'))
  if (name === 'first install') r.log += 'The new build started and reported healthy.\n'
  if (name === 'a build that never reports healthy') {
    r.status = 2
    r.log += "The previous build didn't report healthy within 2s either. It was left in place; it may still be starting.\n"
  }
  if (name === '--rollback') r.log += 'The restored build started and reported healthy.\n'
  return r
}

test('win32: deploy.mjs does exactly what the pre-crossplatform one did, command for command', { skip: !onWindows ? 'Windows only' : !tagged && 'no pre-crossplatform tag here' }, async () => {
  const before = await flow(sandbox('before', tagged))
  const now = await flow(sandbox('now', readFileSync(join(repo, 'scripts', 'deploy.mjs'), 'utf8')))
  for (let i = 0; i < before.length; i++) {
    const [name, old] = before[i]
    const b = deliberate(name, old)
    const n = now[i][1]
    assert.equal(n.stderr, b.stderr, `${name}: stderr`)
    assert.equal(n.status, b.status, `${name}: exit code`)
    assert.deepEqual(n.trace, b.trace, `${name}: the commands and their options`)
    assert.equal(n.log, b.log, `${name}: the log`)
    assert.deepEqual([...n.files].sort(), [...b.files].sort(), `${name}: the files left behind`)
  }
  // and the flow did what it says: two kept installs, the bad build rolled back with a notice, then swapped back
  const [, first] = now[0]
  assert.match(first.log, /Package check passed \(1 modules load\)/)
  assert.ok(first.trace.some((t) => t.includes('npx electron-builder --win --dir')))
  assert.ok(now[1][1].trace.some((t) => t.includes('taskkill /PID 4242 /F /T')), 'the running copy is stopped by its pid')
  assert.ok(before.some(([, b]) => b.trace.some((t) => t.includes('taskkill /IM'))), 'the tagged script did stop by name')
  assert.ok(!now.some(([, n]) => n.trace.some((t) => t.includes('taskkill /IM'))), 'a throwaway install is never stopped by name')
  assert.match(now[1][1].log, /Kept the previous install in <box>.install.Corvid\.previous.<stamp>/)
  assert.match(now[2][1].log, /didn't report healthy within 2s\. Restoring the previous install/)
  assert.ok(now[2][1].files.some((f) => f.startsWith('data/deploy-notice.json') && f.includes('rolled back')))
  assert.match(now[3][1].log, /Restored the install kept as <stamp>/)
  assert.ok(now[4][1].trace.some((t) => t.includes('Win32_Process -MethodName Create') && t.includes('--detached-run')))
})

test('posix: the macOS or Linux profile builds, stops the old app by pid, keeps, installs, checks health, rolls back', { skip: onWindows && 'POSIX only' }, async () => {
  const s = sandbox('posix', readFileSync(join(repo, 'scripts', 'deploy.mjs'), 'utf8'))
  const [[, first], [, update], [, bad], [, back], [, detach]] = await flow(s)
  const mac = process.platform === 'darwin'
  assert.equal(first.status, 0, first.log + first.stderr)
  assert.ok(first.trace.some((t) => t.includes(`npx electron-builder ${mac ? '--mac' : '--linux'} --dir`)))
  assert.ok(!first.trace.some((t) => /taskkill|powershell/.test(t)), 'nothing Windows-only runs')
  assert.match(first.log, /Package check passed/)
  assert.match(first.log, /The new build started and reported healthy/)
  assert.ok(update.trace.some((t) => t.includes('ps -A -o pid=,ppid=,command=')), 'processes come from ps')
  assert.ok(update.oldGone, 'the old app (a real process this test started) was stopped by its pid')
  assert.match(update.log, /Kept the previous install in <box>.install.Corvid\.app\.previous.<stamp>/)
  assert.match(bad.log, /Restoring the previous install/)
  assert.equal(bad.status, 2, 'a rolled-back deploy exits 2')
  assert.match(back.log, /Restored the install kept as <stamp>/)
  assert.ok(detach.trace.some((t) => t.includes('"kind":"spawn"') && t.includes('--detached-run') && t.includes('"detached":true')), 'detached relaunch')
  // a throwaway install never writes the app-menu entry
  assert.ok(!existsSync(join(s.box, 'home', '.local', 'share', 'applications')))
})

// ---------- #177: first installs checked, no git, exit codes, deploy.log, the test-only failure switch ----------

const current = () => readFileSync(join(repo, 'scripts', 'deploy.mjs'), 'utf8')
const deployLog = (s) => readFileSync(join(s.box, 'data', 'deploy.log'), 'utf8')

test('a first install waits for health.json: healthy exits 0, never healthy exits 3 and stays in place', async () => {
  const good = sandbox('first-good', current())
  const ok = await run(good, [])
  assert.equal(ok.status, 0, ok.log + ok.stderr)
  assert.match(ok.log, /The new build started and reported healthy\./)
  const bad = sandbox('first-bad', current())
  const r = await run(bad, [], { healthy: false })
  assert.equal(r.status, 3, r.log + r.stderr)
  assert.match(r.log, /didn't report healthy within 2s, and there's no previous install to roll back to, so it was left in place/)
  assert.ok(existsSync(bad.install), 'the new build is left installed')
  assert.ok(!r.files.some((f) => f.includes('deploy-notice')), 'no rollback notice')
})

test('a copy without git deploys with its commit unknown', async () => {
  const s = sandbox('no-git', current())
  const r = await run(s, [], { env: { MOCK_NO_GIT: '1' } })
  assert.equal(r.status, 0, r.log + r.stderr)
  assert.match(r.log, /Building commit unknown: this folder isn't a git repository/)
  assert.match(r.log, /Installed\.[\s\S]*The new build started and reported healthy\./)
  const info = JSON.parse(readFileSync(join(s.install, 'corvid-build.json'), 'utf8'))
  assert.equal(info.commit, undefined)
  assert.equal(typeof info.time, 'number')
  // an update and a rollback still work, and the notice says the commit wasn't known
  await run(s, [], { env: { MOCK_NO_GIT: '1' } })
  const bad = await run(s, [], { env: { MOCK_NO_GIT: '1', CORVID_DEPLOY_FAIL_HEALTH: '1' } })
  assert.equal(bad.status, 2, bad.log + bad.stderr)
  assert.match(bad.log, /The last rebuild \(commit unknown\) didn't start, so Corvid rolled back to the previous build \(an earlier build\)/)
})

test('CORVID_DEPLOY_FAIL_HEALTH=1 rolls back even when the app reports healthy; exit 2, the restored build checked; deploy.log kept', async () => {
  const s = sandbox('fail-switch', current())
  assert.equal((await run(s, [])).status, 0)
  assert.equal((await run(s, [])).status, 0)
  const bad = await run(s, [], { env: { CORVID_DEPLOY_FAIL_HEALTH: '1' } })
  assert.equal(bad.status, 2, bad.log + bad.stderr)
  assert.match(bad.log, /CORVID_DEPLOY_FAIL_HEALTH=1 \(test only\)/)
  assert.match(bad.log, /Restoring the previous install/)
  assert.match(bad.log, /The previous build started and reported healthy\./)
  assert.ok(bad.files.some((f) => f.startsWith('data/deploy-notice.json') && f.includes('rolled back')))
  // --rollback checks the build it puts back; the switch only ever applies to a new build
  const back = await run(s, ['--rollback'], { env: { CORVID_DEPLOY_FAIL_HEALTH: '1' } })
  assert.equal(back.status, 0, back.log + back.stderr)
  assert.match(back.log, /The restored build started and reported healthy\./)
  const unhealthy = await run(s, ['--rollback'], { healthy: false })
  assert.equal(unhealthy.status, 3, unhealthy.log + unhealthy.stderr)
  assert.match(unhealthy.log, /The restored build didn't report healthy within 2s either/)
  // a terminal run appends to deploy.log every time, one header per run, and the rollback notice's pointer is true
  const text = deployLog(s)
  assert.equal(text.match(/^===== .* deploy( --rollback)? =====$/gm).length, 5)
  assert.match(text, /Restoring the previous install/)
  assert.match(text, /The restored build didn't report healthy/)
})

test('deploy.log moves to deploy.old.log once it passes 1 MB', async () => {
  const s = sandbox('rotate', current())
  writeFileSync(join(s.box, 'data', 'deploy.log'), 'x'.repeat(1024 * 1024 + 1))
  const r = await run(s, [])
  assert.equal(r.status, 0, r.log + r.stderr)
  assert.ok(statSync(join(s.box, 'data', 'deploy.old.log')).size > 1024 * 1024)
  assert.ok(deployLog(s).length < 10_000)
  assert.match(deployLog(s), /The new build started and reported healthy\./)
})
