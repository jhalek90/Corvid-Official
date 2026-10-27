import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { logCrash } from './crashLog'
import type { StartKind } from '@shared/welcome'

// running.json in the data folder (#85): written at start-up, removed on a clean quit. Still there at the next
// start, with its process gone, means the last run ended unexpectedly (a crash, a kill, power loss). A deploy
// stops the app by force, so a deploy.log written after that run started counts as an intended restart.
// last-exit.json (#122) records what a clean quit was for: the user leaving, or the app restarting itself. The
// welcome message only greets after the first.

type Marker = { pid: number; startedAt: number }

const file = (): string => join(app.getPath('userData'), 'running.json')
const deployLog = (): string => join(app.getPath('userData'), 'deploy.log')
const exitFile = (): string => join(app.getPath('userData'), 'last-exit.json')

export interface LastExit {
  kind: 'quit' | 'restart'
  reason: string
  at: number
}

let startKind: StartKind = 'quit'
let lastExit: LastExit | undefined
/** How the last run ended, as checkLastRun found it. */
export const lastRunKind = (): StartKind => startKind
/** The last clean quit, when one was recorded. */
export const lastCleanExit = (): LastExit | undefined => lastExit

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Checks the last run's marker and writes this one. Returns the notice to show, if the last run ended unexpectedly. */
export function checkLastRun(): string | null {
  let notice: string | null = null
  try {
    const e = JSON.parse(readFileSync(exitFile(), 'utf8')) as LastExit
    if ((e.kind === 'quit' || e.kind === 'restart') && typeof e.at === 'number') lastExit = e
  } catch {
    /* none recorded yet */
  }
  const dataDir = app.getPath('userData')
  // nothing of Corvid's in the folder yet: a fresh install
  const fresh = !lastExit && !existsSync(file()) && !existsSync(join(dataDir, 'config.json')) && !existsSync(join(dataDir, 'board'))
  startKind = fresh ? 'first' : lastExit?.kind === 'restart' ? 'restart' : 'quit'
  try {
    const last = JSON.parse(readFileSync(file(), 'utf8')) as Marker
    let deployedSince = false
    try {
      deployedSince = statSync(deployLog()).mtimeMs > last.startedAt
    } catch {
      /* no deploy.log */
    }
    if (last.pid !== process.pid && !alive(last.pid) && !deployedSince) {
      logCrash('main', `Corvid was closed unexpectedly last time (process ${last.pid}, started ${new Date(last.startedAt).toLocaleString()})`, 'No clean quit was recorded: a crash, the process being killed, or the computer losing power.')
      notice = 'Corvid was closed unexpectedly last time. Details are in crash.log.'
      startKind = 'crash'
    } else if (deployedSince) {
      console.log('[run] the last run was ended by a deploy')
      startKind = 'deploy'
    } else if (last.pid !== process.pid) startKind = 'crash'
  } catch {
    /* no marker: the last run quit cleanly, or this is the first */
  }
  try {
    writeFileSync(file(), JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies Marker))
  } catch (e) {
    console.error('[run] cannot write running.json', e)
  }
  return notice
}

/** A clean quit: the marker goes. */
export function cleanExit(reason: string): void {
  console.log(`[run] clean exit: ${reason}`)
  rmSync(file(), { force: true })
  try {
    const kind = /^restart/i.test(reason) ? 'restart' : 'quit'
    writeFileSync(exitFile(), JSON.stringify({ kind, reason, at: Date.now() } satisfies LastExit))
  } catch (e) {
    console.error('[run] cannot write last-exit.json', e)
  }
}
