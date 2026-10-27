import * as pty from '@lydell/node-pty'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { LaunchMode, ShellOption, TerminalInfo } from '@shared/types'
import { killTree, projectShell, shellList, type ShellDef } from './platform'

interface Term {
  info: TerminalInfo
  proc: pty.IPty
  buffer: string
  pending: string
  flush: NodeJS.Timeout | null
  /** when it last printed anything */
  outAt: number
  /** set once terminate() has started ending it */
  ending?: boolean
  /** terminate()'s next step, run when the process exits */
  gone?: () => void
}

const MAX_BUFFER = 512 * 1024
/** how long terminate() waits for the process tree to die before closing the console anyway */
const KILL_TIMEOUT = 8000
const terms = new Map<string, Term>()
const exitListeners: ((termId: string, code: number) => void)[] = []

export function onTerminalExit(fn: (termId: string, code: number) => void): void {
  exitListeners.push(fn)
}

type Emit = (channel: string, ...args: unknown[]) => void
let emit: Emit = () => {}

export function initPty(e: Emit): void {
  emit = e
}

export function claudeArgs(mode: LaunchMode, sessionId?: string): string[] {
  if (mode === 'new' || !sessionId) return []
  return mode === 'fork' ? ['--resume', sessionId, '--fork-session'] : ['--resume', sessionId]
}

function spawn(info: Omit<TerminalInfo, 'termId' | 'createdAt'>, file: string, args: string[]): TerminalInfo {
  const cwd = existsSync(info.cwd) ? info.cwd : homedir()
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd,
    // DASHBOARD_PTY lets scripts (e.g. deploy) know they're running inside the dashboard.
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', DASHBOARD_PTY: '1' } as Record<string, string>
  })
  const term: Term = {
    info: { ...info, cwd, termId: randomUUID(), createdAt: Date.now() },
    proc,
    buffer: '',
    pending: '',
    flush: null,
    outAt: Date.now()
  }
  terms.set(term.info.termId, term)

  proc.onData((d) => {
    term.outAt = Date.now()
    term.buffer += d
    if (term.buffer.length > MAX_BUFFER) term.buffer = term.buffer.slice(-MAX_BUFFER)
    term.pending += d
    term.flush ??= setTimeout(() => {
      term.flush = null
      // a closed tab's process can print a little more while it dies
      if (terms.has(term.info.termId)) emit('pty:data', term.info.termId, term.pending)
      term.pending = ''
    }, 8)
  })
  proc.onExit(({ exitCode }) => {
    term.info.exited = exitCode
    term.gone?.()
    for (const l of exitListeners) l(term.info.termId, exitCode)
    emit('pty:exit', term.info.termId, exitCode)
    emit('terminals', listTerminals())
  })
  emit('terminals', listTerminals())
  return term.info
}

export function launchClaude(
  bin: string,
  mode: LaunchMode,
  cwd: string,
  title: string,
  sessionId?: string,
  agentName?: string
): TerminalInfo {
  return spawn(
    { title, cwd, sessionId: mode === 'resume' ? sessionId : undefined, kind: 'claude', agentName },
    bin,
    claudeArgs(mode, sessionId)
  )
}

/** An interactive session that starts on a given prompt (an assistant worker). */
export function launchWorker(
  bin: string,
  cwd: string,
  title: string,
  prompt: string,
  systemAppend: string,
  extraArgs: string[] = [],
  agentName?: string
): TerminalInfo {
  return spawn({ title, cwd, kind: 'claude', agentName }, bin, ['--name', title, ...extraArgs, '--append-system-prompt', systemAppend, prompt])
}

/** Closes the pseudoconsole. With a client still attached this blocks the main process while Windows asks it to close (#140). */
function closeConsole(t: Term): void {
  const at = Date.now()
  try {
    t.proc.kill()
  } catch {
    /* already gone */
  }
  const took = Date.now() - at
  if (took > 500) console.warn(`[pty] closing the console of "${t.info.title}" blocked the main process for ${took} ms`)
}

/**
 * Ends a terminal's process without blocking the app (#140). On Windows, node-pty's kill() calls
 * ClosePseudoConsole, which waits on the main thread while every process in the console handles
 * the close (a CLI that cleans up on SIGHUP or ignores it holds it for 5 s or more). So the
 * process tree is killed first, off the main thread, and the console is closed once it is empty.
 * On macOS and Linux nothing blocks (#153): the tree (a SIGHUP-ignoring grandchild included) is
 * ended in the background, SIGTERM then SIGKILL, and the outcome is logged. node-pty tidies up the
 * terminal itself when the shell exits; kill() is not called first, as its SIGHUP would end the shell
 * before the tree is listed and leave its children to init.
 */
function terminate(t: Term): void {
  if (t.ending) return
  t.ending = true
  if (t.info.exited !== undefined) return closeConsole(t)
  // Windows: until a terminal first prints, node-pty may not know its pid (0: taskkill /T would walk the whole system)
  // and queues kill() until that output, so a shell killed before it printed kept its console and pipes open for
  // good (#233). Nothing in it can resist the close yet, so the queued kill() is all it needs.
  if (process.platform === 'win32' && !t.buffer) return closeConsole(t)
  if (process.platform !== 'win32') {
    const at = Date.now()
    void killTree(t.proc.pid, { timeoutMs: KILL_TIMEOUT }).then((err) => {
      if (err) console.warn(`[pty] ending "${t.info.title}" (pid ${t.proc.pid}): ${err.message}`)
      else console.log(`[pty] ended "${t.info.title}" (pid ${t.proc.pid}) and its processes in ${Date.now() - at} ms`)
    })
    return
  }
  const finish = (): void => {
    clearTimeout(timer)
    t.gone = undefined
    closeConsole(t)
  }
  const timer = setTimeout(() => {
    console.warn(`[pty] "${t.info.title}" (pid ${t.proc.pid}) still running ${KILL_TIMEOUT / 1000} s after taskkill; closing its console anyway`)
    finish()
  }, KILL_TIMEOUT)
  t.gone = finish
  void killTree(t.proc.pid, { timeoutMs: KILL_TIMEOUT }).then((err) => {
    if (err && t.info.exited === undefined) console.warn(`[pty] taskkill for "${t.info.title}" (pid ${t.proc.pid}) failed: ${err.message}`)
  })
}

/** Stop the process but keep the tab, so its output stays readable. */
export function kill(termId: string): void {
  const t = terms.get(termId)
  if (!t || t.info.exited !== undefined) return
  terminate(t)
}

/** A project's terminal: powershell.exe on Windows, the user's login shell elsewhere (platform/shells.ts). */
export function launchShell(cwd: string, title: string): TerminalInfo {
  const { file, args } = projectShell()
  return spawn({ title, cwd, kind: 'shell' }, file, args)
}

let shellCache: ShellDef[] | undefined

/** Installed shells, best default first: PowerShell 7 then Windows PowerShell, or the login shell (platform/shells.ts). */
function shells(): ShellDef[] {
  if (shellCache) return shellCache
  shellCache = shellList()
  return shellCache
}

export function availableShells(): ShellOption[] {
  return shells().map(({ id, label }) => ({ id, label }))
}

/** A shell for the sidebar panel, not tied to any project; starts in the home folder unless given one. */
export function launchSideShell(shellId: string | undefined, title: string | undefined, cwd?: string): TerminalInfo {
  const all = shells()
  const def = all.find((s) => s.id === shellId) ?? all[0]
  if (!def) throw new Error('No shell found')
  // WSL would otherwise start in /mnt/c/Users/<you>; given a folder, it opens there instead.
  const args = def.id === 'wsl' && !cwd ? ['--cd', '~'] : def.args
  return spawn({ title: title || def.label, cwd: cwd ?? homedir(), kind: 'shell', side: true, shell: def.id }, def.file, args)
}

export function listTerminals(): TerminalInfo[] {
  return [...terms.values()].map((t) => t.info)
}

/** pid -> termId, so the live registry can tell which session runs in which tab. */
export function terminalPids(): Map<number, string> {
  const m = new Map<number, string>()
  for (const t of terms.values()) if (t.info.exited === undefined) m.set(t.proc.pid, t.info.termId)
  return m
}

export function setTerminalSession(termId: string, sessionId: string): void {
  const t = terms.get(termId)
  if (t && t.info.sessionId !== sessionId) {
    t.info.sessionId = sessionId
    emit('terminals', listTerminals())
  }
}

/** When the terminal last printed anything, for telling a quiet agent from one still writing (#70). */
export const lastOutput = (termId: string): number | undefined => terms.get(termId)?.outAt

export function attach(termId: string): string {
  return terms.get(termId)?.buffer ?? ''
}

export function write(termId: string, data: string): void {
  terms.get(termId)?.proc.write(data)
}

export function resize(termId: string, cols: number, rows: number): void {
  const t = terms.get(termId)
  if (!t || t.info.exited !== undefined || cols < 2 || rows < 2) return
  // a full-screen app redraws everything on a resize, even to the size it already has (#79)
  if (t.proc.cols === cols && t.proc.rows === rows) return
  try {
    t.proc.resize(cols, rows)
  } catch {
    /* process just exited */
  }
}

/** Removes the terminal at once; its process (if still running) ends in the background. */
export function close(termId: string): void {
  const t = terms.get(termId)
  if (!t) return
  terms.delete(termId)
  emit('terminals', listTerminals())
  terminate(t)
}

export function killAll(): void {
  for (const t of terms.values()) {
    try {
      t.proc.kill()
    } catch {
      /* ignore */
    }
  }
}
