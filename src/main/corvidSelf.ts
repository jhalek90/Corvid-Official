import { app } from 'electron'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CorvidStatus, SetupItem } from '@shared/types'
import { ELECTRON_INSTALLER, electronNeedsDownload, gitInstallHint, installOf, killTree, nativeDeps, toNative } from './platform'
import { builtinProject, ensureBuiltin, isCorvidSource, setBuiltinSource } from './projectStore'

// Corvid's own project (#78): the source checkout the installed app is built from, its rebuild through
// scripts/deploy.mjs (which keeps the previous install and rolls back a build that doesn't start), and
// the setup for someone who only installed a build.

/**
 * The one switch for whether users may get Corvid's source. With it off, or no repository URL in
 * package.json's "repository" field, the clone button is hidden and the page says the source isn't available.
 */
export const SOURCE_AVAILABLE = true

declare const __CORVID_BUILD__: { commit: string; time: number; dirty: boolean }
const build = typeof __CORVID_BUILD__ === 'object' ? __CORVID_BUILD__ : { commit: '', time: 0, dirty: false }

const dataFile = (name: string): string => join(app.getPath('userData'), name)
/** Where the packaged app runs from (on macOS the .app bundle); in dev there's no install. */
const installDir = (): string => (app.isPackaged ? installOf(app.getPath('exe')).dir : '')

const readJson = <T,>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('git', args, { cwd, windowsHide: true, timeout: 15_000, encoding: 'utf8' }, (e, out) => (e ? reject(e) : resolve(out.trim())))
  )

/** The main checkout behind a folder (a worktree's parent repo), or the folder itself. */
function mainCheckout(dir: string): string {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    return dirname(toNative(common.trim()))
  } catch {
    return dir
  }
}

/**
 * Put Corvid's project on the list. Its source is found from the folder the last deploy built from
 * (deploy.mjs records it in <data>\corvid-source.json) and, in a dev run, the folder the app runs from.
 */
export function initCorvidSelf(): void {
  const recorded = readJson<{ source?: string }>(dataFile('corvid-source.json'))?.source
  const sources = [recorded, app.isPackaged ? undefined : mainCheckout(app.getAppPath())].filter((x): x is string => !!x)
  ensureBuiltin(sources, installDir() || app.getAppPath())
}

/** The built-in project's folder when it holds Corvid's source. */
export function sourceDir(): string | undefined {
  const p = builtinProject()
  const f = p && (p.folders.find((x) => x.primary) ?? p.folders[0])
  return f && isCorvidSource(f.path) ? f.path : undefined
}

function cloneUrl(): string | undefined {
  if (process.env.CORVID_SOURCE_URL) return process.env.CORVID_SOURCE_URL // testing: a local repository
  const repo = readJson<{ repository?: string | { url?: string } }>(join(app.getAppPath(), 'package.json'))?.repository
  const url = typeof repo === 'string' ? repo : repo?.url
  return url?.replace(/^git\+/, '') || undefined
}

/** Earlier installs kept by deploy.mjs (beside the install folder; on macOS under the data folder), newest first. */
function previousBuilds(): CorvidStatus['previous'] {
  const dir = app.isPackaged ? installOf(app.getPath('exe')).previousDir : ''
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name)
      const info = readJson<{ commit?: string; time?: number }>(join(path, 'corvid-build.json'))
      return { name, commit: info?.commit, at: info?.time ?? statSync(path).mtimeMs }
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1))
}

let deploy: { started: number; waiting: boolean; error?: string } | undefined
let waitTimer: NodeJS.Timeout | undefined

export async function corvidStatus(): Promise<CorvidStatus> {
  const source = sourceDir()
  const url = cloneUrl()
  const s: CorvidStatus = {
    version: app.getVersion(),
    commit: build.commit,
    builtAt: build.time,
    dirty: build.dirty,
    packaged: app.isPackaged,
    installDir: installDir(),
    projectId: builtinProject()?.id,
    source,
    canClone: SOURCE_AVAILABLE && !!url,
    cloneUrl: SOURCE_AVAILABLE ? url : undefined,
    previous: previousBuilds(),
    deploy: deploy && { started: deploy.started, waiting: deploy.waiting, error: deploy.error },
    notice: readJson<{ text: string }>(dataFile('deploy-notice.json'))?.text
  }
  if (source) {
    try {
      const head = (await git(source, ['status', '--porcelain=v1', '-b'])).split(/\r?\n/)
      const m = head[0].match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/)
      s.git = { branch: m?.[1] ?? '?', changed: head.length - 1, ahead: Number(m?.[2] ?? 0), behind: Number(m?.[3] ?? 0) }
      if (build.commit) {
        // the build's commit may not be in this checkout (built elsewhere): then say nothing about it
        s.git.installedBehind = Number(await git(source, ['rev-list', '--count', `${build.commit}..main`]).catch(() => NaN))
        if (!Number.isFinite(s.git.installedBehind)) delete s.git.installedBehind
      }
    } catch (e) {
      s.git = { branch: '?', changed: 0, ahead: 0, behind: 0, error: (e as Error).message.split('\n')[0] }
    }
  }
  return s
}

export const dismissNotice = (): void => rmSync(dataFile('deploy-notice.json'), { force: true })

/** The window is up: the heartbeat deploy.mjs waits for before it calls a new build healthy. */
export function markHealthy(): void {
  writeFileSync(dataFile('health.json'), JSON.stringify({ pid: process.pid, commit: build.commit, at: Date.now() }))
}

export const buildInfo = (): { version: string; commit: string; builtAt: number; dirty: boolean } => ({ version: app.getVersion(), commit: build.commit, builtAt: build.time, dirty: build.dirty })

// ---------- setup check ----------

const run = (cmd: string, args: string[], cwd?: string): Promise<string> =>
  new Promise((resolve, reject) =>
    // npm is a .cmd on Windows, which only starts through a shell
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 20_000, encoding: 'utf8', shell: process.platform === 'win32' }, (e, out) => (e ? reject(e) : resolve(out.trim())))
  )

const atLeast = (v: string, min: number[]): boolean => {
  const n = v.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < min.length; i++) if ((n[i] ?? 0) !== min[i]) return (n[i] ?? 0) > min[i]
  return true
}

/** What building Corvid needs, checked without installing anything. */
export async function checkSetup(): Promise<SetupItem[]> {
  const out: SetupItem[] = []
  const gitV = await run('git', ['--version']).catch(() => '')
  out.push(gitV ? { name: 'Git', ok: true, detail: gitV } : { name: 'Git', ok: false, detail: 'Not found', fix: `${gitInstallHint()}, then restart Corvid.` })
  const nodeV = await run('node', ['--version']).catch(() => '')
  // the same minimum as setup.mjs and package.json engines: Electron 44 needs 22.12+, the tests 22.18+ (type stripping)
  const nodeOk = !!nodeV && atLeast(nodeV, [22, 18])
  out.push({ name: 'Node.js', ok: nodeOk, detail: nodeV || 'Not found', fix: nodeOk ? undefined : 'Install Node.js 22 LTS or newer from nodejs.org (it includes npm), then restart Corvid.' })
  const npmV = await run('npm', ['--version']).catch(() => '')
  out.push({ name: 'npm', ok: !!npmV, detail: npmV || 'Not found', fix: npmV ? undefined : 'npm comes with Node.js; reinstall Node.js.' })
  const src = sourceDir()
  if (!src) {
    out.push({ name: 'Source', ok: false, detail: 'Not set up', fix: 'Get Corvid\'s source first.' })
    return out
  }
  const nm = join(src, 'node_modules')
  const has = (p: string): boolean => existsSync(join(nm, p))
  if (!existsSync(nm)) {
    out.push({ name: 'Dependencies', ok: false, detail: 'Not installed', fix: 'Run "Install dependencies" below.' })
    return out
  }
  out.push({ name: 'Dependencies', ok: has('.package-lock.json'), detail: has('.package-lock.json') ? 'Installed' : 'Incomplete', fix: has('.package-lock.json') ? undefined : 'Run "Install dependencies" again.' })
  // this platform's and CPU's prebuilt terminal library, and Electron's binary (#154)
  const native = nativeDeps()
  const pty = has(native.pty)
  out.push({ name: 'Terminal library (native)', ok: pty, detail: pty ? 'Prebuilt binary present' : `Missing ${native.pty}`, fix: pty ? undefined : 'Run "Install dependencies" again; it ships prebuilt, so no compiler is needed.' })
  const electron = has(native.electron) && has('electron/path.txt')
  out.push({ name: 'Electron', ok: electron, detail: electron ? 'Downloaded' : `Missing ${native.electron.split('/').pop()}`, fix: electron ? undefined : "Run \"Install dependencies\" again with a network connection; it downloads Electron's binary (or run node node_modules/electron/install.js in the source folder)." })
  out.push({ name: 'SSH library', ok: has('ssh2'), detail: has('ssh2') ? (has('cpu-features') ? 'Installed, with its optional native part' : 'Installed (the optional native speed-up is skipped, which is fine)') : 'Missing', fix: has('ssh2') ? undefined : 'Run "Install dependencies" again.' })
  return out
}

// ---------- clone and install ----------

/** Clone Corvid's source into `dir` (which must not exist yet) and make it the project's folder. */
export async function cloneSource(dir: string): Promise<{ ok: true } | { error: string }> {
  const url = cloneUrl()
  if (!SOURCE_AVAILABLE || !url) return { error: "Corvid's source isn't available for this install." }
  if (existsSync(dir) && readdirSync(dir).length) return { error: `${dir} isn't empty. Pick a new folder.` }
  try {
    await new Promise<void>((resolve, reject) =>
      // no prompts: the user's own git credentials are used if it needs any, never asked for here
      execFile('git', ['clone', url, dir], { windowsHide: true, timeout: 10 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, _o, err) =>
        e ? reject(Object.assign(e, { stderr: String(err) })) : resolve()
      )
    )
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string }
    if (err.code === 'ENOENT') return { error: `Git isn't installed (or not on PATH). ${gitInstallHint()}, restart Corvid and try again.` }
    const msg = (err.stderr || err.message).trim()
    if (/not found|does not exist|could not read Username|Authentication failed|terminal prompts disabled/i.test(msg))
      return { error: `Couldn't get the source from ${url}: the repository is private or doesn't exist yet. If you have access, sign in with your own git first. (${msg.split('\n').pop()})` }
    return { error: `git clone failed: ${msg.split('\n').slice(-2).join(' ')}` }
  }
  const r = setBuiltinSource(dir)
  return 'error' in r ? r : { ok: true }
}

let install: ChildProcess | undefined

/** npm install in the source folder, then Electron's binary if it's still missing (#175), with the output
 *  streamed to `line`; resolves with the exit code. */
export async function installDeps(line: (text: string) => void): Promise<{ code: number | null; error?: string }> {
  const src = sourceDir()
  if (!src) return { code: null, error: "Corvid's source isn't set up." }
  if (install) return { code: null, error: 'An install is already running.' }
  const r = await runStep(src, 'npm', ['install', '--no-fund', '--no-audit'], true, line)
  // the postinstall normally fetched it; not when npm runs with ignore-scripts or the source predates it
  const nm = join(src, 'node_modules')
  if (r.code !== 0 || !electronNeedsDownload(nm)) return r
  line("Downloading Electron's binary…")
  return runStep(src, 'node', [join(nm, ELECTRON_INSTALLER)], false, line)
}

/** One step of installDeps, in `install` so it can be cancelled. Node runs Electron's installer, which checks the
 *  download against the package's checksums and uses ELECTRON_MIRROR and proxy settings from the environment. */
function runStep(src: string, cmd: string, args: string[], shell: boolean, line: (text: string) => void): Promise<{ code: number | null; error?: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const p = spawn(cmd, args, { cwd: src, shell, windowsHide: true, env })
    install = p
    const feed = (b: Buffer): void => {
      for (const l of b.toString().split(/\r?\n/)) if (l.trim()) line(l)
    }
    p.stdout?.on('data', feed)
    p.stderr?.on('data', feed)
    p.on('error', (e) => {
      install = undefined
      resolve({ code: null, error: e.message })
    })
    p.on('close', (code) => {
      install = undefined
      resolve({ code })
    })
  })
}

export function cancelInstall(): boolean {
  if (!install?.pid) return false
  // the install's whole tree, by pid (#153): taskkill /T /F on Windows, SIGTERM then SIGKILL elsewhere
  const { pid } = install
  void killTree(pid, { timeoutMs: 10_000 }).then((err) => {
    if (err) console.warn(`[corvid] stopping npm install (pid ${pid}): ${err.message}`)
  })
  return true
}

// ---------- rebuild and rollback ----------

/** Start scripts/deploy.mjs from the source. It detaches, builds, and only then stops and replaces this app. */
function startDeploy(args: string[]): { error?: string } {
  const src = sourceDir()
  if (!src) return { error: "Corvid's source isn't set up." }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const p = spawn('node', [join(src, 'scripts', 'deploy.mjs'), '--detach', ...args], { cwd: src, windowsHide: true, env, stdio: 'ignore' })
    p.on('error', (e) => deploy && (deploy.error = `Couldn't start the deploy script: ${e.message}. Is Node.js installed?`))
    deploy = { started: Date.now(), waiting: false }
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** Rebuild now, or once no agent is running (`wait`). */
export function rebuild(wait: boolean, running: () => number): { error?: string } {
  if (waitTimer) clearInterval(waitTimer)
  waitTimer = undefined
  if (!wait || running() === 0) return startDeploy([])
  deploy = { started: Date.now(), waiting: true }
  waitTimer = setInterval(() => {
    if (running() > 0) return
    clearInterval(waitTimer)
    waitTimer = undefined
    startDeploy([])
  }, 10_000)
  return {}
}

export function cancelRebuild(): void {
  if (waitTimer) clearInterval(waitTimer)
  waitTimer = undefined
  if (deploy?.waiting) deploy = undefined
}

export const rollback = (): { error?: string } => (previousBuilds().length ? startDeploy(['--rollback']) : { error: 'No previous build is kept yet; one is saved at the next rebuild.' })

/** The last lines of deploy.log. */
export function deployLog(): string {
  try {
    return readFileSync(dataFile('deploy.log'), 'utf8').split(/\r?\n/).slice(-40).join('\n')
  } catch {
    return ''
  }
}
