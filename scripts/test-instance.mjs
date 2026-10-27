// The one sanctioned way to run a test copy of Corvid (#85). Each copy gets a fresh data folder, a free localhost
// port with a random token, and an owner record in a registry outside every repo. A copy is only ever stopped,
// killed or driven by its registry entry: the script first asks the copy who it is (process id, owner, data
// folder) and compares that with the entry, so two agents never drive each other's copy and nothing drives the
// real app (which never opens such a port). Nothing here kills by name or image.
//
//   npm run test-instance -- start --owner <task or agent> [--data empty|copy] [--from <data folder>]
//                                  [--assistant] [--workers] [--claude-dir <fake ~/.claude>] [--env KEY=VALUE ...]
//                                  [--seed]                       (fake lineage events in the copy's data folder, #203)
//   npm run test-instance -- start --owner <owner> --again <earlier id>   (a stopped copy's data folder, started again)
//   npm run test-instance -- start ... --hidden                     (starts in the tray, as the Windows login item does)
//   npm run test-instance -- show <id> --owner <owner>               (shows a hidden copy's window, like a tray click)
//   npm run test-instance -- list
//   npm run test-instance -- whoami|stop|kill <id> --owner <owner>
//   npm run test-instance -- eval <id> --owner <owner> "<js>"        (runs in the copy's window, awaits a promise)
//   npm run test-instance -- lineage-live <id> --owner <owner> [--task <n>] [--step 2]   (appends a few fake lineage
//                                  events through the copy's own writer, so the Context cloud's live path can be watched, #210)
//
// Build first (npm run build): a copy runs this checkout's out/ folder. Options: --data copy copies the real data
// folder (or --from <dir>) without secrets, the assistant's folder, the index or backups. --assistant and --workers
// opt in to Corvid's assistant and to real workers, which spend Claude usage. --env passes debug aids on
// (DASH_SHOT_DIR, DASH_SHOT_VIEWS, DASH_CLOSE_FINISHED_SEC, ...). kill ends the copy by force, by its process id,
// to test the unexpected-exit notice.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { appDataDir, killTree, pathsOf, realDataDir as pickRealDataDir } from '../src/main/platform/shared.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.CORVID_TEST_HOME || join(tmpdir(), 'corvid-test-instances')
const registryFile = join(home, 'registry.json')
// never copied into a test copy: secrets, Corvid's own conversation, caches, backups, logs
const SKIP = /^(secrets.*|connections.*|remote|mcp|assistant|index|backups|profile|running\.json|crash\.log.*|deploy.*|previous-builds|.*\.tmp|Cache|Code Cache|GPUCache|Local Storage|Session Storage|blob_storage|Network|Shared Dictionary|DawnCache|DawnGraphiteCache|DawnWebGPUCache|SingletonLock|lockfile)$/i

const args = process.argv.slice(2)
const cmd = args.shift()
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, v === undefined || v.startsWith('--') ? 1 : 2)
  return v === undefined || v.startsWith('--') ? true : v
}
const die = (msg) => {
  console.error(`test-instance: ${msg}`)
  process.exit(1)
}

// ---------- registry ----------

const readRegistry = () => {
  try {
    return JSON.parse(readFileSync(registryFile, 'utf8'))
  } catch {
    return []
  }
}
const writeRegistry = (list) => {
  mkdirSync(home, { recursive: true })
  writeFileSync(registryFile + '.tmp', JSON.stringify(list, null, 2))
  renameSync(registryFile + '.tmp', registryFile)
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** The entry, if it's this owner's. Refuses anyone else's copy. */
function entryFor(id, owner) {
  const e = readRegistry().find((x) => x.id === id)
  if (!e) die(`no test copy ${id} in the registry (npm run test-instance -- list)`)
  if (!owner) die('--owner is required: a copy is only ever driven by whoever started it')
  if (e.owner !== owner) die(`${id} belongs to ${e.owner}, not ${owner}: refusing to touch it`)
  return e
}

// ---------- talking to a copy ----------

async function call(e, path, body) {
  const res = await fetch(`http://127.0.0.1:${e.port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(path === '/eval' ? 10 * 60_000 : 5000)
  })
  const out = await res.json()
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`)
  return out
}

/** Asks the copy who it is and checks every answer against the registry before anything else is sent. */
export async function verify(e) {
  let who
  try {
    who = await call(e, '/whoami')
  } catch (err) {
    throw new Error(`${e.id} on port ${e.port} didn't answer as a test copy (${err.message}); nothing was sent`)
  }
  const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
  if (!who.test || who.pid !== e.pid || who.owner !== e.owner || !same(who.dataDir, e.dataDir))
    throw new Error(`the copy on port ${e.port} is not ${e.id} (it says pid ${who.pid}, owner ${who.owner}, data ${who.dataDir}); nothing was sent`)
  return who
}

/** For other scripts (ui-smoke): run JavaScript in a verified copy's window. */
export async function evalIn(id, owner, js) {
  const e = entryFor(id, owner)
  await verify(e)
  return (await call(e, '/eval', { js })).value
}

// ---------- commands ----------

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })

// the real app's data folder on this platform (#154): %APPDATA%, ~/Library/Application Support or ~/.config
const realDataDir = () => pickRealDataDir(appDataDir(), existsSync)

/** Whether `dir` is, or is inside, one of the real app's data folders on `platform` (every name it has had), however
 *  it's spelled: case and trailing separators are ignored, which only ever over-matches. A test copy's folder never
 *  may be. Paths are compared as they're written (no realpath), so this also works for another platform's paths. */
export function insideRealData(dir, platform = process.platform, env = process.env, home = homedir()) {
  const appData = appDataDir(platform, env, home)
  if (!appData) return false
  const { join: at, resolve: abs, sep } = pathsOf(platform)
  const key = (p) => abs(p).replace(/[\\/]+$/, '').toLowerCase()
  const d = key(dir)
  // the pre-rename name too, on every platform: refusing more is the safe direction
  return ['Claude Dashboard', 'Corvid']
    .map((n) => key(at(appData, n)))
    .some((r) => d === r || d.startsWith(r + sep))
}

async function start() {
  const owner = flag('owner')
  if (typeof owner !== 'string' || !/^[\w#. -]{1,60}$/.test(owner)) die('start needs --owner <task id or agent name>')
  if (!existsSync(join(repo, 'out', 'main', 'index.js'))) die(`no build in ${repo}\\out: run npm run build first`)
  const data = flag('data') ?? 'empty'
  const from = flag('from')
  const extraEnv = {}
  for (let v; (v = flag('env')) !== undefined; ) {
    const m = /^(\w+)=(.*)$/.exec(String(v))
    if (!m) die(`--env wants KEY=VALUE, got ${v}`)
    extraEnv[m[1]] = m[2]
  }
  const again = flag('again')
  const id = `${owner.replace(/[^\w-]+/g, '')}-${Date.now().toString(36)}`
  const dir = join(home, typeof again === 'string' ? again : id)
  const dataDir = join(dir, 'data')
  if (insideRealData(dataDir)) die(`refusing to put a test copy's data in the real data folder (${dataDir}); check CORVID_TEST_HOME`)
  if (typeof again === 'string') {
    // only a folder this script made, and not while its copy is still running
    if (!/^[\w-]+$/.test(again) || !existsSync(dataDir)) die(`no earlier test copy folder ${again} in ${home}`)
    if (readRegistry().some((x) => resolve(x.dataDir).toLowerCase() === resolve(dataDir).toLowerCase() && alive(x.pid))) die(`a copy on ${again}'s folder is still running`)
  } else mkdirSync(dataDir, { recursive: true })
  if (typeof again === 'string') {
    /* its own data as it was left */
  } else if (data === 'copy') {
    const src = typeof from === 'string' ? from : realDataDir()
    // read only: the real folder is copied from, never written to
    cpSync(src, dataDir, { recursive: true, filter: (p) => p === src || !SKIP.test(p.slice(src.length + 1).split(/[\\/]/)[0]) })
  } else if (data !== 'empty') die('--data is empty or copy')
  // fake data for views that are empty on a fresh copy (#203): only ever into this copy's own folder
  if (flag('seed')) {
    const { writeLineageSeed } = await import('./seed/lineage.mjs')
    writeLineageSeed(dataDir)
  }
  const port = await freePort()
  const token = randomBytes(24).toString('hex')
  const env = { ...process.env, ...extraEnv, DASH_DATA_DIR: dataDir, DASH_TEST_INSTANCE: owner, DASH_TEST_PORT: String(port), DASH_TEST_TOKEN: token }
  delete env.ELECTRON_RUN_AS_NODE
  if (flag('assistant')) env.DASH_TEST_ASSISTANT = '1'
  if (flag('workers')) env.DASH_TEST_WORKERS = '1'
  const claudeDir = flag('claude-dir')
  if (typeof claudeDir === 'string') env.CLAUDE_CONFIG_DIR = resolve(claudeDir)
  const electron = createRequire(import.meta.url)('electron')
  const log = openSync(join(dir, 'output.log'), 'a')
  const child = spawn(electron, ['.', ...(args.includes('--hidden') ? ['--hidden'] : [])], { cwd: repo, env, detached: true, stdio: ['ignore', log, log], windowsHide: false })
  child.unref()
  const entry = { id, owner, pid: child.pid, port, token, dataDir, log: join(dir, 'output.log'), repo, startedAt: new Date().toISOString() }
  writeRegistry([...readRegistry().filter((x) => alive(x.pid)), entry])
  // wait for it to answer as itself
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (!alive(child.pid)) die(`the copy exited at start-up; see ${entry.log}`)
    try {
      await verify(entry)
      console.log(JSON.stringify({ id, owner, pid: child.pid, port, dataDir }, null, 2))
      return
    } catch {
      /* not up yet */
    }
  }
  die(`${id} started (pid ${child.pid}) but didn't answer on port ${port} within a minute; see ${entry.log}`)
}

function list() {
  const all = readRegistry()
  const live = all.filter((e) => alive(e.pid))
  if (live.length !== all.length) writeRegistry(live)
  if (!live.length) return console.log('no test copies running')
  for (const e of live) console.log(`${e.id}  owner ${e.owner}  pid ${e.pid}  port ${e.port}  started ${e.startedAt}\n    ${e.dataDir}`)
}

const waitGone = async (pid, ms) => {
  for (let t = 0; t < ms && alive(pid); t += 250) await new Promise((r) => setTimeout(r, 250))
  return !alive(pid)
}
const forget = (id) => writeRegistry(readRegistry().filter((x) => x.id !== id && alive(x.pid)))
// by process id only, and only one this script started and has just verified. Its whole tree: taskkill /T /F on
// Windows, SIGTERM then SIGKILL elsewhere (#153). A failure (part of the tree was already gone) is ignored: whether
// it's dead is checked next.
const killPid = (pid) => killTree(pid, { timeoutMs: 10_000 })

async function stop(id, owner, force) {
  const e = entryFor(id, owner)
  if (!alive(e.pid)) return forget(id), console.log(`${id} had already exited`)
  await verify(e)
  if (force) {
    await killPid(e.pid)
    if (!(await waitGone(e.pid, 10_000))) die(`${id} (pid ${e.pid}) is still running after it was killed`)
    forget(id)
    return console.log(`${id} (pid ${e.pid}) killed`)
  }
  await call(e, '/quit', {})
  if (!(await waitGone(e.pid, 15_000))) {
    console.log(`${id} didn't quit within 15 s; ending it by its process id`)
    await killPid(e.pid)
  }
  forget(id)
  console.log(`${id} stopped`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    if (cmd === 'start') await start()
    else if (cmd === 'list') list()
    else if (cmd === 'whoami' || cmd === 'stop' || cmd === 'kill' || cmd === 'eval' || cmd === 'show' || cmd === 'lineage-live') {
      const id = args.shift()
      const owner = flag('owner')
      if (!id) die(`${cmd} needs a test copy id`)
      if (cmd === 'whoami') console.log(JSON.stringify(await verify(entryFor(id, owner)), null, 2))
      else if (cmd === 'eval') console.log(JSON.stringify(await evalIn(id, owner, args.join(' ')), null, 2))
      else if (cmd === 'show') {
        const e = entryFor(id, owner)
        await verify(e)
        console.log(JSON.stringify(await call(e, '/show', {})))
      } else if (cmd === 'lineage-live') {
        const e = entryFor(id, owner)
        await verify(e)
        console.log(JSON.stringify(await call(e, '/lineage-live', { task: flag('task'), step: flag('step') })))
      }
      else await stop(id, owner, cmd === 'kill')
    } else die('commands: start, list, whoami, stop, kill, eval, show, lineage-live (see the top of scripts/test-instance.mjs)')
  } catch (e) {
    die(e.message)
  }
}
