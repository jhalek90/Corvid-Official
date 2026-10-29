import { app } from 'electron'
import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLOSE_FINISHED_MAX, type AppConfig } from '@shared/types'
import { DEFAULT_DARK, DEFAULT_LIGHT, isSavedThemeId, themeDef } from '@shared/themes'
import { CUSTOM_VOICE_MAX, isBoardVoice } from '@shared/boardVoice'
import { checkUserName } from '@shared/userName'
import { isWelcomeMode } from '@shared/welcome'
import { TEST } from './testCopy'
import { KEEP_DAYS_MAX, KEEP_DAYS_MIN } from '@shared/board'
import { clampWorkers, cleanWorkerMinutes, SUGGESTED_WORKERS, WORKER_MINUTES } from '@shared/workerLimits'
import { CAP_MULTIPLE, cleanCapMultiple } from '@shared/costEstimate'
import { isModelChoice } from '@shared/models'
import { cleanCustomModels, isCustomModelRef } from '@shared/customModels'
import { isReasoningEffortSetting } from '@shared/reasoningEffort'
import { isWorkerPermissionMode } from '@shared/permissionMode'
import { defaultHotkey } from '@shared/platformInfo'
import { AGENT_PING_DEFAULTS, cleanPingLimits } from '@shared/agentPings'
import { checkClaudePathText } from './claudePath'

const DEFAULTS: AppConfig = {
  theme: DEFAULT_DARK,
  themeFollowSystem: false,
  themeLight: DEFAULT_LIGHT,
  themeDark: DEFAULT_DARK,
  usagePollSec: 180,
  notifications: true,
  openAtLogin: true,
  // Control+Alt+Space, or Command+Shift+Space on macOS (#156); a saved hotkey always wins
  hotkey: defaultHotkey(process.platform),
  pinnedProjects: [],
  addedProjects: [],
  snoozed: {},
  projectRoots: [],
  assistantMode: 'ask',
  assistantModel: 'haiku',
  // Claude Code's own default effort until the user picks one (#238), so nothing changes for existing copies
  assistantEffort: 'default',
  assistantPersonality: 'default',
  workerModel: 'default',
  workerEffort: 'default',
  // passes no --permission-mode until the user picks one (#306), so nothing changes for existing copies
  workerPermissionMode: 'default',
  userName: '',
  goofyNames: true,
  closeFinishedMinutes: 2,
  resumeMentioned: 'auto',
  wakeTagged: true,
  agentPings: false,
  agentPingWake: false,
  agentPingLimits: { ...AGENT_PING_DEFAULTS },
  untaggedToCorvid: true,
  formatMessages: true,
  boardVoice: 'crow',
  boardVoiceCustom: '',
  welcomeMessage: 'status',
  boardKeepDays: 14,
  disabledExtensions: [],
  limits: {
    maxWorkers: SUGGESTED_WORKERS,
    usageLimit: true,
    gate5h: 70,
    gate5hOn: true,
    gateWeek: 80,
    gateWeekOn: true,
    overLimit: 'ask',
    workerMinutes: WORKER_MINUTES.default
  },
  manyWorkersOk: false,
  agentGit: 'branches',
  agentGitOverrides: {},
  pushAfterMerge: false,
  updateCheck: true,
  extensionCapMultiple: CAP_MULTIPLE.default,
  ticker: true,
  crow: true,
  agentBirds: true,
  agentAvatars: true,
  crowLook: { hat: 'none', extra: 'none' }
}

/** A hand-edited name that breaks the rules goes back to the default; who else is called it is checked when it's set (config:set). */
const cleanUserName = (n: unknown): string => {
  const r = typeof n === 'string' ? checkUserName(n, []) : { name: '' }
  return 'name' in r ? r.name : ''
}

/** 0 (off) or a whole number of minutes from 1 to CLOSE_FINISHED_MAX; anything else is the default. */
const cleanCloseMinutes = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(CLOSE_FINISHED_MAX, Math.round(n))) : DEFAULTS.closeFinishedMinutes

/**
 * Why a saved Claude path (#194) can't be used, or null: the same text checks as Settings (text, length, no control
 * characters, absolute, no .bat/.cmd/.ps1 on Windows), then a file that is there and not a folder.
 */
export function claudePathProblem(p: unknown): string | null {
  const t = checkClaudePathText(p)
  if ('error' in t) return "isn't a usable path"
  try {
    return statSync(t.path).isFile() ? null : 'is a folder'
  } catch {
    return "doesn't exist"
  }
}

const file = (): string => join(app.getPath('userData'), 'config.json')

let current: AppConfig | null = null
/** What loading config.json had to repair (#85), for a quiet notice. */
const repairs: string[] = []
export const configRepairs = (): string[] => repairs

/** Obviously bad values from a hand-edited or overwritten config.json go back to a working value; good ones stay. */
function repair(c: AppConfig): void {
  const fix = (what: string): void => {
    repairs.push(what)
    console.warn(`[config] repaired: ${what}`)
  }
  if (c.claudePath !== undefined) {
    const why = claudePathProblem(c.claudePath)
    if (why) {
      fix(`the Claude path ${JSON.stringify(c.claudePath).slice(0, 300)} ${why}, so Corvid looks for claude itself`)
      delete c.claudePath
    }
  }
  if (typeof c.usagePollSec !== 'number' || !Number.isFinite(c.usagePollSec) || c.usagePollSec < 60 || c.usagePollSec > 600) {
    fix(`usage polling every ${c.usagePollSec} s is out of range, back to every ${DEFAULTS.usagePollSec / 60} min`)
    c.usagePollSec = DEFAULTS.usagePollSec
  }
  if (typeof c.boardKeepDays !== 'number' || c.boardKeepDays < KEEP_DAYS_MIN || c.boardKeepDays > KEEP_DAYS_MAX) {
    fix(`keeping board messages ${c.boardKeepDays} days is out of range, back to ${DEFAULTS.boardKeepDays}`)
    c.boardKeepDays = DEFAULTS.boardKeepDays
  }
  for (const k of ['gate5h', 'gateWeek'] as const)
    if (typeof c.limits[k] !== 'number' || c.limits[k] < 5 || c.limits[k] > 100) {
      fix(`the ${k === 'gate5h' ? '5-hour' : 'weekly'} usage gate ${c.limits[k]}% is out of range, back to ${DEFAULTS.limits[k]}%`)
      c.limits[k] = DEFAULTS.limits[k]
    }
  // the usage limit's switches (#93): configs from before them get the defaults through the merge in getConfig
  for (const k of ['usageLimit', 'gate5hOn', 'gateWeekOn'] as const)
    if (typeof c.limits[k] !== 'boolean') {
      fix(`the usage limit setting ${k} wasn't on or off, back to on`)
      c.limits[k] = DEFAULTS.limits[k]
    }
  if (c.limits.overLimit !== 'ask' && c.limits.overLimit !== 'block') {
    fix(`what happens above the usage limit (${JSON.stringify(c.limits.overLimit)}) isn't a choice, back to asking first`)
    c.limits.overLimit = DEFAULTS.limits.overLimit
  }
  if (cleanCapMultiple(c.extensionCapMultiple) !== c.extensionCapMultiple) {
    fix(`the extension budget cap ${JSON.stringify(c.extensionCapMultiple)} is out of range, now ${cleanCapMultiple(c.extensionCapMultiple)}x`)
    c.extensionCapMultiple = cleanCapMultiple(c.extensionCapMultiple)
  }
  // the user's own models (#313): each bad entry is dropped with a notice, the good ones stay as they are
  const custom = cleanCustomModels(c.models)
  for (const why of custom.dropped) fix(why)
  if (custom.models) c.models = custom.models
  // the models (#127): any of MODEL_CHOICES (Fable included) stays, an unknown one goes back to the default. A
  // well-formed custom:<id> stays too, even when its entry is gone (#313): N175 step 3 refuses to start it, never moves it to Claude
  if (!isModelChoice(c.assistantModel) && !isCustomModelRef(c.assistantModel)) {
    fix(`Corvid's model ${JSON.stringify(c.assistantModel)} isn't a model, back to ${DEFAULTS.assistantModel}`)
    c.assistantModel = DEFAULTS.assistantModel
  }
  if (c.workerModel !== 'default' && !isModelChoice(c.workerModel) && !isCustomModelRef(c.workerModel)) {
    fix(`the worker model ${JSON.stringify(c.workerModel)} isn't a model, back to your Claude Code default`)
    c.workerModel = DEFAULTS.workerModel
  }
  // the effort levels (#238): a level the CLI takes stays, anything else goes back to Claude Code's default
  for (const [k, what] of [['assistantEffort', "Corvid's effort"], ['workerEffort', 'the worker effort']] as const)
    if (!isReasoningEffortSetting(c[k])) {
      fix(`${what} ${JSON.stringify(c[k])} isn't an effort level, back to your Claude Code default`)
      c[k] = DEFAULTS[k]
    }
  // the worker permission mode (#306): only the modes Settings offers; bypassing every check is never one of them
  if (!isWorkerPermissionMode(c.workerPermissionMode)) {
    fix(`the worker permission mode ${JSON.stringify(c.workerPermissionMode)} isn't one Corvid offers, back to your Claude Code default`)
    c.workerPermissionMode = DEFAULTS.workerPermissionMode
  }
  if (c.scanModel !== undefined && !isModelChoice(c.scanModel)) {
    fix(`the scan model ${JSON.stringify(c.scanModel)} isn't a model, back to haiku`)
    delete c.scanModel
  }
  if (typeof c.hotkey !== 'string') {
    fix("the hotkey wasn't text, back to the default")
    c.hotkey = DEFAULTS.hotkey
  }
  for (const k of ['notifications', 'openAtLogin'] as const)
    if (typeof c[k] !== 'boolean') {
      fix(`${k} wasn't on or off, back to ${DEFAULTS[k] ? 'on' : 'off'}`)
      c[k] = DEFAULTS[k]
    }
}

export function getConfig(): AppConfig {
  if (current) return current
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8'))
    current = {
      ...DEFAULTS,
      ...saved,
      limits: { ...DEFAULTS.limits, ...saved.limits },
      crowLook: { ...DEFAULTS.crowLook, ...saved.crowLook }
    }
    // Configs from before the theme picker only have a theme; it becomes that kind's pick so the
    // toggle keeps going back to it. An unknown id (a theme since removed) falls back to the default. An extension
    // theme's id is kept even while its extension is off or gone (#114): the window shows the default theme of the
    // same kind meanwhile, and the pick comes back with the extension.
    const c = current!
    if (!isSavedThemeId(c.theme)) c.theme = DEFAULTS.theme
    if (!isSavedThemeId(c.themeLight)) c.themeLight = DEFAULTS.themeLight
    if (!isSavedThemeId(c.themeDark)) c.themeDark = DEFAULTS.themeDark
    if (!isBoardVoice(c.boardVoice)) c.boardVoice = DEFAULTS.boardVoice
    if (typeof c.boardVoiceCustom !== 'string') c.boardVoiceCustom = ''
    if (!isWelcomeMode(c.welcomeMessage)) c.welcomeMessage = DEFAULTS.welcomeMessage
    if (!Array.isArray(c.disabledExtensions)) c.disabledExtensions = []
    c.disabledExtensions = c.disabledExtensions.filter((x) => typeof x === 'string').slice(0, 200)
    c.userName = cleanUserName(c.userName)
    // a saved limit stays as it is; only one past the ceiling, or not a number, is brought back in range
    c.limits.maxWorkers = clampWorkers(c.limits.maxWorkers)
    c.limits.workerMinutes = cleanWorkerMinutes(c.limits.workerMinutes)
    c.closeFinishedMinutes = cleanCloseMinutes(c.closeFinishedMinutes)
    if (!['auto', 'ask', 'off'].includes(c.resumeMentioned)) c.resumeMentioned = DEFAULTS.resumeMentioned
    if (typeof c.wakeTagged !== 'boolean') c.wakeTagged = DEFAULTS.wakeTagged
    if (typeof c.untaggedToCorvid !== 'boolean') c.untaggedToCorvid = DEFAULTS.untaggedToCorvid
    // agent pings (#195): anything but a real true is off, and the numbers stay in range
    if (c.agentPings !== true) c.agentPings = false
    if (c.agentPingWake !== true) c.agentPingWake = false
    c.agentPingLimits = cleanPingLimits(c.agentPingLimits)
    if (typeof c.formatMessages !== 'boolean') c.formatMessages = DEFAULTS.formatMessages
    if (typeof c.updateCheck !== 'boolean') c.updateCheck = DEFAULTS.updateCheck
    // the suggestions switch (#202): absent means on; anything but a boolean is dropped, so it reads as on
    if (c.agentSuggestions !== undefined && typeof c.agentSuggestions !== 'boolean') delete c.agentSuggestions
    // the project-memory switch (#308): absent means off; anything but a boolean is dropped, so it reads as off. New
    // installs get it written as true (#325, in the catch below), which leaves the meaning of absent alone
    if (c.workerProjectMemory !== undefined && typeof c.workerProjectMemory !== 'boolean') delete c.workerProjectMemory
    // the chips switch (#206): the same, absent means on
    if (c.boardChips !== undefined && typeof c.boardChips !== 'boolean') delete c.boardChips
    if (c.updateDismissed !== undefined && typeof c.updateDismissed !== 'string') delete c.updateDismissed
    repair(c)
    // a test copy with a copied config must never resume (and so write to) the real Corvid conversation (#85)
    if (TEST && c.assistantSessionId) {
      console.warn('[test] ignoring the copied assistant session id')
      delete c.assistantSessionId
    }
    if (saved.themeLight === undefined && saved.themeDark === undefined) {
      if (themeDef(c.theme).kind === 'light') c.themeLight = c.theme
      else c.themeDark = c.theme
    }
  } catch (e) {
    current = { ...DEFAULTS }
    if (!existsSync(file())) {
      // a new install (#325): project memory is on, written into its first config.json. Not in DEFAULTS, so an older
      // config without the key (or a data folder that has Corvid's data but lost its config) still reads as off
      if (!['tasks.json', 'board'].some((x) => existsSync(join(app.getPath('userData'), x)))) {
        current.workerProjectMemory = true
        try {
          writeConfig(current)
        } catch (w) {
          console.warn('[config] could not write the first config.json', w)
        }
      }
    } else {
      // a config.json that's there but unreadable is kept aside, so the next save doesn't overwrite it with defaults
      const kept = `${file()}.unreadable-${Date.now()}`
      try {
        copyFileSync(file(), kept)
      } catch {
        /* the backups folder still has the last good one */
      }
      repairs.push(`config.json couldn't be read (${(e as Error).message}), so Corvid started with default settings. The old file is kept as ${kept}, and Settings → Restore from backup has earlier versions`)
      console.warn(`[config] unreadable, kept as ${kept}`, e)
    }
  }
  return current!
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  const before = getConfig().limits
  current = { ...getConfig(), ...patch }
  if (!isBoardVoice(current.boardVoice)) current.boardVoice = DEFAULTS.boardVoice
  current.boardVoiceCustom = String(current.boardVoiceCustom ?? '').slice(0, CUSTOM_VOICE_MAX)
  if (!isWelcomeMode(current.welcomeMessage)) current.welcomeMessage = DEFAULTS.welcomeMessage
  current.userName = cleanUserName(current.userName)
  current.disabledExtensions = Array.isArray(current.disabledExtensions) ? current.disabledExtensions.filter((x) => typeof x === 'string').slice(0, 200) : []
  for (const k of ['theme', 'themeLight', 'themeDark'] as const) if (!isSavedThemeId(current[k])) current[k] = DEFAULTS[k]
  current.extensionCapMultiple = cleanCapMultiple(current.extensionCapMultiple)
  for (const k of ['assistantEffort', 'workerEffort'] as const) if (!isReasoningEffortSetting(current[k])) current[k] = DEFAULTS[k]
  if (!isWorkerPermissionMode(current.workerPermissionMode)) current.workerPermissionMode = DEFAULTS.workerPermissionMode
  // custom models (#313): a bad entry never reaches the file; absent stays absent
  if (current.models !== undefined) current.models = cleanCustomModels(current.models).models
  // a partial limits object keeps the rest as they were, rather than dropping them
  current.limits = { ...before, ...current.limits }
  current.limits.maxWorkers = clampWorkers(current.limits.maxWorkers)
  current.limits.workerMinutes = cleanWorkerMinutes(current.limits.workerMinutes)
  if (current.limits.overLimit !== 'block') current.limits.overLimit = 'ask'
  // the limits keep agents in check, so every change to them is on record (#81)
  if (JSON.stringify(before) !== JSON.stringify(current.limits))
    console.warn(`[config] limits changed: ${JSON.stringify(before)} -> ${JSON.stringify(current.limits)}`)
  current.closeFinishedMinutes = cleanCloseMinutes(current.closeFinishedMinutes)
  current.agentPings = current.agentPings === true
  current.agentPingWake = current.agentPingWake === true
  current.agentPingLimits = cleanPingLimits(current.agentPingLimits)
  if (current.agentSuggestions !== undefined && typeof current.agentSuggestions !== 'boolean') delete current.agentSuggestions
  if (current.workerProjectMemory !== undefined && typeof current.workerProjectMemory !== 'boolean') delete current.workerProjectMemory
  // only setClaudePath in index.ts writes it, after Check and the user's yes; a bad value never reaches the file (#194)
  if (current.claudePath !== undefined && claudePathProblem(current.claudePath)) delete current.claudePath
  writeConfig(current)
  return current
}

/** Write and rename, so a crash mid-write can't leave a half-written config.json (#83). */
function writeConfig(c: AppConfig): void {
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(c, null, 2))
  renameSync(tmp, file())
}
