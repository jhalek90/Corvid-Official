import { app } from 'electron'
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '@shared/types'
import { hasUserName, userLabel } from '@shared/userName'
import { boardFacts, composeWelcome, shouldGreet, welcomeStyle, type WelcomeFacts, type WelcomeState } from '@shared/welcome'
import { lastCleanExit, lastRunKind } from './runMarker'
import { listMessages, post, snapshot } from './board'

// Corvid's "welcome back" on the board (#122). Only start-up code here calls it, once per process, when the window is
// first shown: there is no IPC, tool or board path to it, so nothing an agent or a message does can post one. It posts
// as the assistant, to the user, straight into the board store: not through boardPosted, so no in-app ping, no desktop
// notification, no wake for Corvid or any agent, and nothing counted against anyone's posting limits. Never a model call.

export interface WelcomeDeps {
  config: () => AppConfig
  doing: () => number
  approvals: () => number
  fiveHour: () => number | undefined
  commit: () => string
}

const stateFile = (): string => join(app.getPath('userData'), 'welcome.json')

function readState(): WelcomeState | undefined {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as WelcomeState
  } catch {
    return undefined
  }
}

function saveState(s: WelcomeState): void {
  try {
    const tmp = stateFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(s))
    renameSync(tmp, stateFile())
  } catch (e) {
    console.error('[welcome] cannot save welcome.json', e)
  }
}

const mtime = (name: string): number | undefined => {
  try {
    return statSync(join(app.getPath('userData'), name)).mtimeMs
  } catch {
    return undefined
  }
}

let started = false

/**
 * Decide at start-up whether this open gets a greeting; if it does, post it once the window first shows (at once for a
 * normal start, later for a hidden login start). Call once, after the board is loaded and before the window is shown.
 */
export function welcomeOnShow(win: Electron.BrowserWindow, deps: WelcomeDeps): void {
  if (started) return
  started = true
  const kind = lastRunKind()
  const saved = readState()
  // a data folder in use before #122 has had its first run: no "welcome to Corvid" for it
  const state: WelcomeState = saved ?? (kind === 'first' ? {} : { firstDone: true })
  if (!saved) saveState(state)
  const left = lastCleanExit()?.at
  // what the user had read before this start: the window marks the board read as soon as it shows it
  const seenUpTo = snapshot().seenUpTo
  win.once('show', () => {
    // a beat for the window to draw, and for a usage figure to arrive
    setTimeout(() => {
      try {
        greet(kind, state, left, seenUpTo, deps)
      } catch (e) {
        console.error('[welcome] failed', e)
      }
    }, 2500)
  })
}

function greet(kind: ReturnType<typeof lastRunKind>, state: WelcomeState, left: number | undefined, seenUpTo: number, deps: WelcomeDeps): void {
  const cfg = deps.config()
  const mode = cfg.welcomeMessage
  const now = Date.now()
  const decision = shouldGreet({ kind, mode, state, now, deployAt: mtime('deploy.log') })
  console.log(`[welcome] start: ${kind}; ${decision.greet ? `greeting (${decision.why})` : `no greeting: ${decision.why}`}`)
  if (!decision.greet) return
  const commit = deps.commit()
  const facts: WelcomeFacts = {
    ...boardFacts(listMessages(), seenUpTo),
    doing: deps.doing(),
    approvals: deps.approvals(),
    // a rollback notice newer than the last greeting, or a different build than the last greeting ran on
    build: (mtime('deploy-notice.json') ?? 0) > (state.lastGreetAt ?? Infinity) ? 'rolledback' : state.commit && commit && state.commit !== commit ? 'updated' : undefined,
    fiveHour: deps.fiveHour()
  }
  const out = composeWelcome({
    greet: decision.greet,
    mode,
    style: welcomeStyle(cfg.boardVoice, cfg.boardVoiceCustom, cfg.assistantPersonality),
    name: hasUserName(cfg.userName) ? userLabel(cfg.userName) : '',
    now: new Date(now),
    since: left ?? state.lastGreetAt,
    state,
    facts,
    hotkey: cfg.hotkey,
    mac: process.platform === 'darwin'
  })
  // remembered even when a terse voice had nothing to say, so the quiet window still holds
  saveState({ ...state, firstDone: true, lastGreetAt: now, lastLine: out?.lineId ?? state.lastLine, count: (state.count ?? 0) + 1, commit: commit || state.commit })
  if (!out) return
  post({ author: 'assistant', text: out.text, to: ['user'] })
}
