import './env'
import { execFile } from 'node:child_process'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { Worker } from 'node:worker_threads'
import createIndexer from './indexer/worker?nodeWorker'
import icon from '../../resources/icon.png?asset'
import trayIconPath from '../../resources/tray.png?asset'
// the one page every agent reads about Corvid (#202), bundled from the docs so the prompts never carry a second copy
import whatCorvidIs from '../../docs/getting-started/what-corvid-is.md?raw'
import { setThesisText } from '@shared/corvidThesis'
import { collectSuggestion } from './suggestions'
import trayAlertPath from '../../resources/tray-alert.png?asset'
import overlayAlertPath from '../../resources/overlay-alert.png?asset'
import trayTemplatePath from '../../resources/trayTemplate.png?asset'
import trayAlertTemplatePath from '../../resources/tray-alertTemplate.png?asset'
import type {
  AppConfig,
  DesktopInfo,
  IndexProgress,
  LaunchMode,
  LiveSession,
  LiveTokens,
  Note,
  ProjectRecord,
  Proposal,
  SessionActivity,
  SessionSummary,
  RemoteApproval,
  RemoteSystemInput,
  Task,
  TaskColumn,
  Theme,
  UsageQuota,
  UsageStats,
  ClaudePathSaved
} from '@shared/types'
import { configRepairs, getConfig, setConfig } from './config'
import { agentSettingsArgs, dataFolders } from './agentDeny'
import { scanProject } from './projectScan'
import { resolveTheme, themeChrome } from '@shared/themes'
import { CLAUDE_NOT_FOUND, claudeDefaultModel, forgetClaude, resolveClaude } from './claudeBin'
import { checkClaudePath } from './claudePath'
import { loadLoginEnv, loginEnvReady } from './platform/loginEnv'
import { terminalAvailable } from './platform/os'
import { fetchQuota, getQuota, startQuotaPolling } from './usage'
import { allModelsWeek, choiceLabel, cliModel, parseTaskModel, FABLE_MAYBE_UNAVAILABLE, FABLE_WARNING, fableWeek } from '@shared/models'
import { effortLabel } from '@shared/reasoningEffort'
import { watchLive } from './liveRegistry'
import * as pty from './pty'
import { openFileInVSCode, openFolder, openInTerminal, openInVSCode, revealFile } from './launch'
import { listDir, listDrives, listPlaces, readPreview } from './files'
import { deriveRoots, initProjects, isTracked, refreshAll, refreshPath, scanArchive, track } from './projects'
import { gitDetail, gitGraph } from './git'
import { newProject } from './newProject'
import * as extensions from './extensions'
import * as packager from './packager'
import * as extensionScan from './extensionScan'
import * as budget from './extensionBudget'
import * as install from './extensionInstall'
import * as buildProgress from './buildProgress'
import * as lifecycle from './extensionLifecycle'
import * as verify from './extensionVerify'
import * as resolveConflict from './extensionResolve'
import { addTaskFiles, arrangeColumn, createTask, fillProjectIds, initTasks, listTasks, removeTask, removeTaskFile, restoresFable, taskFilePath, taskFolder, updateTask } from './tasks'
import * as projectStore from './projectStore'
import * as corvidSelf from './corvidSelf'
import { createUpdateTask, dismissUpdate, runUpdateCheck, startUpdateCheck, updateView } from './updateCheck'
import { merge as mergeProjects, mergePreview } from './projectMerge'
import { folderName } from '@shared/projectList'
import { hotkeyFailText } from '@shared/platformInfo'
import * as unfiled from './unfiled'
import { startMcp, type McpEndpoint, type ToolDef } from './mcp'
import { appendNote, createNote, deleteNote, initNotes, listNotes, markSeen, notesDir, restoreNote, updateNote } from './notes'
import * as lineage from './lineage'
import { NOTES_PROMPT, noteTools } from './noteTools'
import { taskFilesPrompt, taskFileTools, TASK_FILES_SAFETY } from './taskFileTools'
import { attachmentPath, clearBoard, getMessage as boardMessage, initBoard, listMessages, markSeen as markBoardSeen, noteReadBy, post as boardPost, setDiscussion, setPing, prune as pruneBoard, snapshot as boardSnapshot } from './board'
import * as discussion from './discussion'
import { modelWeight, WINDOW_TOKENS } from '@shared/costEstimate'
import { BOARD_VOICES, effectiveVoice } from '@shared/boardVoice'
import { boardTools, corvidPrompt, postAsUser, postCorvidReply, saveMessageAsNote, WORKER_BOARD_REMINDER, workerBoardPrompt, type BoardDeps } from './boardTools'
import { ALL_CHANNEL, boardAuthor, GENERAL_CHANNEL, mentionables, nameKey, type BoardMessage } from '@shared/board'
import { clearStaleGrants, grantWorker, revokeWorker } from './agentAccess'
import * as remote from './remote'
import * as connectors from './connectors'
import * as connectorStore from './connectors/store'
import * as manage from './connectors/manage'
import * as drafts from './connectors/drafts'
import { testHttpConnection } from './connectors/http'
import { cancelUserRequest, planUserRequest, responseNoteText, sendUserRequest } from './connectors/userRequest'
import { checkDbConnection, testDbConnection } from './connectors/db'
import { isDialect } from './connectors/sqlRules'
import { scratchpadDir } from './connectors/upload'
import { deleteSystem, exportSystems, forgetHost, getSecret as remoteSecret, getSystem, listSystems, listViews, saveSystem } from './remote/store'
import { storageStatus } from './secureStorage'
import { readAudit } from './remote/audit'
import { testConnection } from './remote/ssh'
import { scrubber } from './remote/scrub'
import { assistantTools } from './assistantTools'
import * as assistant from './assistant'
import * as workers from './workers'
import type { ConfirmRequest } from './workers'
import * as wake from './wake'
import * as agentPing from './agentPing'
import { AGENT_PING_KEYS, cleanPingLimits, WAKE_WARNING } from '@shared/agentPings'
import * as invoke from './invoke'
import { runCommand, type CommandDeps } from './slashCommands'
import { extensionWorkerAccess, loadMainExtensions, mainExtensionStates } from './extensionSockets'
import { runExtensionCommand } from '../extensions/sockets/main'
import { DASHBOARD_COMMANDS, leadingCommand } from '@shared/slashCommands'
import { initVoice, shutdownVoice, startVoice, stopVoice, voiceAudio, voiceStatus } from './voice'
import { projectKey, projectPath } from '@shared/projects'
import { initContextMenu } from './contextMenu'
import { applyAutostart, closeAction, hasTray, hiddenStartAction, hotkeyFeature, isWayland, loginItemKind, needsYouBadge, restylesOverlay, titleBarArg, titleBarKind, titleBarOptions, trayClicks, trayImage, usesAppUserModelId } from './platform'
import { pickPicture, readAvatar, removeAvatar, saveAvatar } from './profile'
import { cutText } from '@shared/text'
import type { RequestClass, UserRequest } from '@shared/sendRequest'
import { checkUserName, hasUserName, userLabel } from '@shared/userName'
import { catchMainErrors, crashLogFile, logCrash } from './crashLog'
import { defaultDataDir, resolveDataDir } from './dataDir'
import { claudeHome, guardDebugPort, owner, REFUSED, startControlPort, TEST } from './testCopy'
import { applyPendingRestore, backupsSummary, initBackups, scheduleRestore } from './backups'
import { checkLastRun, cleanExit } from './runMarker'
import { welcomeOnShow } from './welcome'
import { registerTours, toursDir } from './tours'

// before anything else can throw: log main-process errors to crash.log and keep running (#83)
catchMainErrors()

// The app used to be "Claude Dashboard". Keep using its data folder where one exists instead of
// moving it: the assistant's Claude Code conversation is tied to the folder's path, and Windows
// won't rename it while an old copy or one of its terminals still has it open.
// DASH_DATA_DIR=<dir> (set by scripts/test-instance.mjs) makes this a test copy on its own folder; one pointed at
// the real folder, however it's spelled, refuses to start (#85).
setThesisText(whatCorvidIs)
const appData = app.getPath('appData')
const dataDir = resolveDataDir(appData, defaultDataDir(appData, app.getName(), () => app.getPath('userData')))
if ('error' in dataDir) {
  console.error(`[data] ${dataDir.error}`)
  app.exit(3)
  process.exit(3)
}
app.setPath('userData', dataDir.dir)
console.log(`[data] ${TEST ? `TEST copy for ${owner()}` : 'Corvid'} on ${dataDir.dir}`)
guardDebugPort()

// The lock is per data folder (Electron keys it on userData), so a test copy never blocks or quits the real app,
// and the other way round.
// A second launch on the same folder hands over to the first and does nothing else: it mustn't start up, write
// the running marker or take a backup on its way out.
const gotLock = app.requestSingleInstanceLock()
// Wayland: globalShortcut works only through the desktop's GlobalShortcuts portal, behind a Chromium feature (#158)
const portalFeature = hotkeyFeature()
if (portalFeature) {
  const features = app.commandLine.getSwitchValue('enable-features')
  app.commandLine.appendSwitch('enable-features', features ? `${features},${portalFeature}` : portalFeature)
}
if (!gotLock) app.quit()
if (usesAppUserModelId()) app.setAppUserModelId('dev.local.claude-dashboard')

let win: BrowserWindow | null = null
let tray: Tray | null = null
/** Whether the desktop shows a tray to come back from (Linux: asked over D-Bus at start; a test copy has none and
 *  keeps hiding as before). Without one, closing the window quits, or asks while terminals or agents run (#158). */
let trayShown = TEST || process.platform !== 'linux'
let trayProbe: Promise<unknown> = Promise.resolve()
let quitting = false
/** Why Corvid is quitting, for the log; any quit that gets as far as before-quit is a clean one (#85). */
let exitReason = 'quit'
/** Shown once by the window at start-up: an unexpected exit last time, repaired settings, a hotkey that's taken. */
const startupNotices: { text: string; log?: boolean }[] = []
// Launched by the Windows login item: stay in the tray until summoned.
const startHidden = process.argv.includes('--hidden')
/** Set once the window is ready to show; macOS also sends 'activate' at launch, which mustn't undo --hidden. */
let windowReady = false

const send = (channel: string, ...args: unknown[]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// ---------- indexer worker ----------

const sessions = new Map<string, SessionSummary>()
/** The assistant's own transcripts aren't "your" sessions; keep them out of every list. */
const isAssistantCwd = (cwd: string | undefined): boolean => !!cwd && projectKey(cwd) === projectKey(assistant.assistantDir())
const activity = new Map<string, SessionActivity>()
let progress: IndexProgress = { done: 0, total: 0, ready: false }
let stats: UsageStats | null = null
let liveTokens: LiveTokens | null = null
let liveSessions: LiveSession[] = []
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
let reqSeq = 0
let indexer: Worker

function startIndexer(): void {
  indexer = createIndexer({
    workerData: {
      projectsRoot: join(claudeHome(), 'projects'),
      cacheDir: join(app.getPath('userData'), 'index')
    }
  })
  indexer.on('message', (msg: any) => {
    switch (msg.type) {
      case 'progress':
        progress = msg.progress
        send('index:progress', progress)
        break
      case 'sessions': {
        const list = (msg.sessions as SessionSummary[]).filter((s) => !isAssistantCwd(s.cwd))
        sessions.clear()
        for (const s of list) sessions.set(s.id, s)
        send('sessions:all', list)
        void projectStore.learnCwds(list.map((s) => s.cwd)).then(() => unfiled.scan())
        break
      }
      case 'updated': {
        const list = (msg.sessions as SessionSummary[]).filter((s) => !isAssistantCwd(s.cwd))
        for (const s of list) sessions.set(s.id, s)
        if (list.length) send('sessions:updated', list)
        void projectStore.learnCwds(list.map((s) => s.cwd))
        if (list.length) unfiled.scheduleScan()
        break
      }
      case 'activity': {
        const items = (msg.items as SessionActivity[]).filter((a) => sessions.has(a.sessionId) || !msg.replace)
        if (msg.replace) activity.clear()
        for (const a of items) activity.set(a.sessionId, a)
        send('activity', items.filter((a) => !isAssistantCwd(sessions.get(a.sessionId)?.cwd)), !!msg.replace)
        break
      }
      case 'stats':
        stats = msg.stats
        send('stats', stats)
        break
      case 'live':
        liveTokens = msg.live
        send('live:tokens', liveTokens)
        break
      case 'result': {
        const p = pending.get(msg.reqId)
        pending.delete(msg.reqId)
        if (msg.error) p?.reject(new Error(msg.error))
        else p?.resolve(msg.data)
        break
      }
    }
  })
  indexer.on('error', (e) => console.error('[indexer] crashed', e))
}

function ask<T>(type: string, payload: Record<string, unknown>): Promise<T> {
  const reqId = ++reqSeq
  return new Promise<T>((resolve, reject) => {
    pending.set(reqId, { resolve, reject })
    indexer.postMessage({ type, reqId, ...payload })
  })
}

// ---------- window / tray ----------

// The theme on screen, which with Follow system on depends on the OS's light/dark setting.
const shownTheme = (): Theme => resolveTheme(getConfig(), nativeTheme.shouldUseDarkColors)

// Window background and the native min/max/close buttons, which CSS can't reach.
const titleBar = titleBarKind()
let chromeFor: Theme | undefined
function applyChrome(): void {
  const theme = shownTheme()
  if (!win || theme === chromeFor) return
  chromeFor = theme
  const c = themeChrome(theme)
  win.setBackgroundColor(c.bg)
  if (restylesOverlay(titleBar)) win.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbol, height: 40 })
}

function createWindow(): void {
  const theme = shownTheme()
  const chrome = themeChrome(theme)
  chromeFor = theme
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    backgroundColor: chrome.bg,
    icon,
    ...titleBarOptions(chrome, titleBar),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [titleBarArg(titleBar)],
      sandbox: true,
      contextIsolation: true
    }
  })
  let lastFocusRefresh = 0
  win.on('focus', () => {
    // a removable drive that came back (or went) shows at once, quietly (4/5)
    projectStore.recheckMissing()
    if (Date.now() - lastFocusRefresh < 30_000) return
    lastFocusRefresh = Date.now()
    void refreshAll()
  })
  if (TEST) {
    // a test copy says so wherever its title shows (taskbar, Alt+Tab), whatever the page sets
    const title = `TEST · ${owner()} · Corvid`
    win.setTitle(title)
    win.on('page-title-updated', (e) => {
      e.preventDefault()
      win?.setTitle(title)
    })
  }
  // Windows logging off or shutting down ends Corvid without a quit: still an intended exit
  win.on('session-end', () => cleanExit('Windows shut down or logged off'))
  win.once('ready-to-show', () => {
    windowReady = true
    if (!startHidden) win?.show()
    // started hidden at login with no tray to bring it back from: minimised in the taskbar instead
    else
      void trayProbe.then(() => {
        if (hiddenStartAction(trayShown) === 'minimize' && win && !win.isDestroyed()) (win.showInactive(), win.minimize())
      })
    setNeedsYouBadge(needsYou)
  })
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      const action = closeAction(trayShown, pty.listTerminals().length)
      if (action === 'hide') win?.hide()
      else if (action === 'quit') quitWithoutTray()
      else void askCloseWithoutTray()
    }
  })
  initContextMenu(win)
  watchWindowCrashes(win)
  // A file dropped where nothing handles it would otherwise open in the window, replacing Corvid (#95)
  win.webContents.on('will-navigate', (e, url) => {
    const own = process.env.ELECTRON_RENDERER_URL ? url.startsWith(process.env.ELECTRON_RENDERER_URL) : /\/renderer\/index\.html(?:[?#]|$)/.test(url)
    if (!own) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The theme rides in the URL so the first paint is already in the right colours.
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?theme=${theme}`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { theme } })
}

/** Linux with no tray (#158): closing the window can't leave Corvid running hidden. */
const quitWithoutTray = (): void => ((exitReason = 'window closed (no tray)'), (quitting = true), app.quit())

async function askCloseWithoutTray(): Promise<void> {
  if (!win || win.isDestroyed()) return
  const running = pty.listTerminals().length
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Minimise', 'Quit Corvid'],
    defaultId: 0,
    cancelId: 0,
    message: `${running === 1 ? 'A terminal or agent is' : `${running} terminals or agents are`} still running.`,
    detail: "This desktop has no system tray, so Corvid can't keep running hidden. Minimise it to keep them going, or quit to stop them."
  })
  if (response === 1) quitWithoutTray()
  else win?.minimize()
}

// ---------- window crashes (#83) ----------
// The agents and their terminals live in this process, so losing the window never stops them: a reload
// reattaches every terminal with its scrollback. Each crash goes to crash.log, and the window reloads by itself
// once; a second crash within RELOAD_GUARD_MS asks instead, so a window that crashes on load can't loop.

const RELOAD_GUARD_MS = 2 * 60_000
let lastAutoReload = 0
/** Shown by the next page load, then cleared. */
let crashNotice: string | null = null

function recoverWindow(w: BrowserWindow, what: string): void {
  if (w.isDestroyed()) return
  const reload = (): void => {
    crashNotice = `The window ${what} and was reloaded. Agents kept running. Details are in crash.log.`
    if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}?theme=${shownTheme()}`)
    else void w.loadFile(join(__dirname, '../renderer/index.html'), { query: { theme: shownTheme() } })
  }
  if (Date.now() - lastAutoReload > RELOAD_GUARD_MS) {
    lastAutoReload = Date.now()
    logCrash('window', `Reloading the window (${what})`)
    reload()
    return
  }
  logCrash('window', `Not reloading by itself again: the window ${what} twice within ${RELOAD_GUARD_MS / 60_000} minutes`)
  void dialog
    .showMessageBox(w, {
      type: 'error',
      title: 'Corvid',
      message: `Corvid's window ${what} again.`,
      detail: 'Agents and terminals are still running. Details are in crash.log in the data folder.',
      buttons: ['Reload', 'Open crash.log', 'Leave it'],
      defaultId: 0,
      cancelId: 2
    })
    .then(({ response }) => {
      if (response === 0) reload()
      if (response === 1) void shell.openPath(crashLogFile())
    })
}

function watchWindowCrashes(w: BrowserWindow): void {
  const wc = w.webContents
  wc.on('render-process-gone', (_e, d) => {
    logCrash('window', `Renderer process gone: ${d.reason} (exit code ${d.exitCode})`)
    // 'clean-exit' is a normal close, e.g. while quitting
    if (d.reason !== 'clean-exit' && !quitting) recoverWindow(w, 'crashed')
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // -3 is an aborted load, e.g. a reload that replaced it
    if (!isMainFrame || code === -3) return
    logCrash('window', `Page failed to load: ${desc} (${code})`, url)
    recoverWindow(w, 'failed to load')
  })
  wc.on('preload-error', (_e, path, error) => logCrash('window', `Preload script error in ${path}`, error.stack ?? error.message))
  let hungAt = 0
  w.on('unresponsive', () => {
    hungAt = Date.now()
    logCrash('window', 'The window stopped responding')
    void dialog
      .showMessageBox(w, {
        type: 'warning',
        title: 'Corvid',
        message: "Corvid's window isn't responding.",
        detail: 'Agents and terminals keep running either way. Reloading redraws the window; waiting gives it a chance to recover.',
        buttons: ['Wait', 'Reload'],
        defaultId: 0,
        cancelId: 0
      })
      .then(({ response }) => {
        if (response === 1 && !w.isDestroyed()) {
          crashNotice = "The window stopped responding and was reloaded. Agents kept running. Details are in crash.log."
          wc.reload()
        }
      })
  })
  w.on('responsive', () => {
    if (hungAt) logCrash('window', `The window is responding again after ${Math.round((Date.now() - hungAt) / 1000)} s`)
    hungAt = 0
  })
}

/** Errors the window reports itself: an error boundary caught one, or an uncaught error or rejection. A burst is cut
 *  short so a render loop can't flood the log. */
let reported: number[] = []
function rendererError(what: string, details: string): void {
  const now = Date.now()
  reported = reported.filter((t) => now - t < 60_000)
  if (reported.length >= 20) return
  reported.push(now)
  logCrash('renderer', String(what).slice(0, 500), String(details).slice(0, 8000))
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow(): void {
  if (win?.isVisible() && win.isFocused()) win.hide()
  else showWindow()
}

const sessionTitle = (id: string, fallback?: string): string => sessions.get(id)?.title ?? fallback ?? 'Claude session'

/** A spawned agent's goofy name and what it's actually working on, for notifications and the tray. */
function agentLabel(termId?: string): { name: string; detail: string } | undefined {
  const t = termId ? pty.listTerminals().find((x) => x.termId === termId) : undefined
  if (!t?.agentName) return undefined
  const w = workers.listWorkers().find((x) => x.termId === termId)
  const suffix = ` · ${t.agentName}`
  return { name: t.agentName, detail: w ? `#${w.taskId} ${w.taskTitle}` : t.title.endsWith(suffix) ? t.title.slice(0, -suffix.length) : t.title }
}

function updateTray(): void {
  if (!tray) return
  const q = getQuota()
  const parts = ['Corvid']
  if (q?.session) parts.push(`5h ${q.session.pct}%`)
  const week = allModelsWeek(q?.weeks)
  const fable = fableWeek(q?.weeks)
  if (week) parts.push(`week ${week.pct}%`)
  if (fable) parts.push(`Fable ${fable.pct}%`)
  tray.setToolTip(parts.join(' · '))
  const live = liveSessions.map((s) => ({
    label: `${s.status === 'busy' ? '◉' : s.status === 'waiting' || s.status === 'blocked' ? '◆' : '○'}  ${agentLabel(s.termId)?.name ?? sessionTitle(s.sessionId, s.name)}`,
    sublabel: s.status,
    click: () => {
      showWindow()
      send('nav:focus-session', s.sessionId)
    }
  }))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Corvid', click: showWindow },
      { type: 'separator' },
      ...(live.length ? live : [{ label: 'No live sessions', enabled: false }]),
      { type: 'separator' },
      { label: 'Refresh usage', click: () => void fetchQuota(onQuota) },
      { label: 'Quit', click: () => ((exitReason = 'quit from the tray'), (quitting = true), app.quit()) }
    ])
  )
}

function createTray(): void {
  if (TEST) return
  tray = new Tray(trayIcon(false))
  // GNOME's AppIndicator never sends clicks, so the menu carries Show Corvid and Quit; elsewhere a click toggles
  tray.on('click', toggleWindow)
  updateTray()
}

// ---------- always-on: badge, login item, Start Menu ----------

let needsYou = false

// The tray icon files by name (trayImage): macOS uses monochrome template images, so they suit light and dark menu bars
const trayFiles: Record<string, string> = {
  'tray.png': trayIconPath,
  'tray-alert.png': trayAlertPath,
  'trayTemplate.png': trayTemplatePath,
  'tray-alertTemplate.png': trayAlertTemplatePath
}
function trayIcon(alert: boolean): Electron.NativeImage {
  const names = trayImage()
  const img = nativeImage.createFromPath(trayFiles[alert ? names.alert : names.normal])
  if (process.platform === 'darwin') img.setTemplateImage(true)
  return img
}

/** Amber dot on the tray icon and taskbar button while any session waits on you (macOS: a Dock badge and one bounce;
 *  Linux: a badge count where the desktop shows one). */
function setNeedsYouBadge(on: boolean): void {
  const wasOn = needsYou
  needsYou = on
  tray?.setImage(trayIcon(on))
  const badge = needsYouBadge(on, wasOn)
  if (badge.kind === 'overlay') {
    if (win && !win.isDestroyed()) win.setOverlayIcon(badge.on ? nativeImage.createFromPath(overlayAlertPath) : null, badge.description)
  } else if (badge.kind === 'dock') {
    app.dock?.setBadge(badge.text)
    if (badge.bounce && !TEST) app.dock?.bounce('informational')
  } else {
    app.setBadgeCount(badge.count)
  }
}

function applyLoginItem(): void {
  // Only the packaged app registers itself; a dev run would register electron.exe. A test copy never touches it.
  if (!app.isPackaged || TEST) return
  if (loginItemKind() === 'autostart-desktop') {
    // Linux (#158): ~/.config/autostart/corvid.desktop; a throwaway install leaves the user's login alone
    if (process.env.CORVID_INSTALL_DIR) return
    try {
      applyAutostart(getConfig().openAtLogin, process.execPath)
    } catch (e) {
      console.warn('[login item] could not update the autostart entry', e)
    }
    return
  }
  app.setLoginItemSettings({ openAtLogin: getConfig().openAtLogin, path: process.execPath, args: ['--hidden'] })
}

function ensureStartMenuShortcut(): void {
  if (!app.isPackaged || TEST) return
  const programs = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  // Shortcut from before the rename; it shares our AppUserModelId, so it would compete for the toast name.
  try {
    rmSync(join(programs, 'Claude Dashboard.lnk'), { force: true })
  } catch {
    /* leave it */
  }
  const lnk = join(programs, 'Corvid.lnk')
  try {
    if (shell.readShortcutLink(lnk).target.toLowerCase() === process.execPath.toLowerCase()) return
  } catch {
    /* missing: create it */
  }
  shell.writeShortcutLink(lnk, {
    target: process.execPath,
    cwd: dirname(process.execPath),
    description: 'Claude Code sessions, live activity and usage',
    icon: process.execPath,
    iconIndex: 0,
    appUserModelId: 'dev.local.claude-dashboard'
  })
}

function onQuota(q: UsageQuota): void {
  workers.checkUsage(q.session?.pct, allModelsWeek(q.weeks)?.pct, fableWeek(q.weeks)?.pct)
  assistant.changed()
  send('usage:quota', q)
  updateTray()
}

/** Desktop notifications; a test copy never shows any (#85). */
const canNotify = (): boolean => !TEST && Notification.isSupported()

/** False when the hotkey couldn't be registered (taken by another app, or not a valid key). A test copy never
 *  registers one: it would fight the real app for it. */
function registerHotkey(accel: string): boolean {
  if (TEST) return true
  globalShortcut.unregisterAll()
  try {
    if (accel && !globalShortcut.register(accel, toggleWindow)) {
      console.warn('[hotkey] could not register', accel)
      return false
    }
  } catch (e) {
    console.warn('[hotkey] invalid accelerator', accel, e)
    return false
  }
  return true
}

// ---------- live sessions + notifications ----------

function startLive(): void {
  watchLive(
    (all) => {
      const list = all.filter((s) => !isAssistantCwd(s.cwd))
      const pids = pty.terminalPids()
      for (const s of list) {
        const termId = pids.get(s.pid)
        if (termId) {
          s.termId = termId
          pty.setTerminalSession(termId, s.sessionId)
        }
      }
      liveSessions = list
      send('live:sessions', list)
      workers.updateFromLive(list)
      const waiting = list.some((s) => s.status === 'waiting' || s.status === 'blocked')
      if (waiting !== needsYou) setNeedsYouBadge(waiting)
      updateTray()
    },
    ({ session }) => {
      // A turn just ended: whatever it changed should show up on the projects board.
      if (isTracked(session.cwd)) void refreshPath(session.cwd)
      // Corvid's own session ends a turn on every board reply: not a "ready for you" moment, so no notification (#84)
      if (isAssistantCwd(session.cwd)) return
      if (!getConfig().notifications || !canNotify()) return
      if (win?.isVisible() && win.isFocused()) return
      const needsYou = session.status === 'waiting' || session.status === 'blocked'
      const agent = agentLabel(session.termId)
      const status = needsYou ? `Needs you${session.waitingFor ? ` — ${session.waitingFor}` : ''}` : 'Finished — ready for you'
      const n = new Notification({
        title: agent?.name ?? sessionTitle(session.sessionId, session.name),
        body: agent ? `${agent.detail}\n${status}` : status,
        icon,
        silent: false
      })
      n.on('click', () => {
        showWindow()
        send('nav:focus-session', session.sessionId)
      })
      n.show()
    }
  )
}

// ---------- notes ----------

/** An agent or the assistant left a note (or added to one): a toast with Open, and a desktop
 *  notification when the window isn't in front. */
function noteLeft(note: Note, action: 'created' | 'appended', by: string): void {
  const text = `${by} ${action === 'created' ? 'left a note' : 'added to'} ${note.id} "${note.name}"`
  send('note:left', text, note.id)
  if (by !== 'Corvid') assistant.note(`${text}.`)
  if (!getConfig().notifications || !canNotify() || (win?.isVisible() && win.isFocused())) return
  const n = new Notification({ title: action === 'created' ? 'New note' : 'Note updated', body: text, icon })
  n.on('click', () => {
    showWindow()
    send('nav:show', { view: 'notes', note: note.id })
  })
  n.show()
}

// ---------- message board ----------

/** Who the board can address by name: running workers and other open terminals with a name (live), then the agents
 *  still on the board from earlier, the same list the board's @ popup offers. */
function boardAgents(): { name: string; taskId?: number; live: boolean }[] {
  const live = new Map<string, { name: string; taskId?: number }>()
  for (const w of workers.listWorkers())
    if (w.agentName && w.state === 'running') live.set(w.agentName.toLowerCase(), { name: w.agentName, taskId: w.taskId })
  for (const t of pty.listTerminals())
    if (t.agentName && t.exited === undefined && !live.has(t.agentName.toLowerCase())) live.set(t.agentName.toLowerCase(), { name: t.agentName })
  // workers that ended but are still listed come next, so their task number still finds them
  const ended = workers
    .listWorkers()
    .filter((w) => w.agentName && w.state !== 'running')
    .map((w) => ({ name: w.agentName!, taskId: w.taskId }))
  return mentionables([...live.values()], listMessages(), ended)
}

/** A message addressed to the user: a toast with Open, and a desktop notification when the window isn't in front.
 *  Quiet ones (Corvid's answers to the user's own @corvid messages) skip the toast. */
function boardPosted(m: BoardMessage, opts?: { quiet?: boolean }): void {
  // a finished agent's countdown starts over when a message is addressed to it or answers one of its posts (#70)
  const parent = m.replyTo ? boardMessage(m.replyTo) : undefined
  workers.addressed([...(m.to ?? []), ...(parent?.author === 'agent' && parent.agentName ? [parent.agentName] : [])], m.author === 'agent' ? m.taskId : undefined)
  if (m.author === 'user' || !m.to?.includes('user')) return
  const who = boardAuthor(m)
  const body = cutText(m.text, 180)
  if (!opts?.quiet) send('board:ping', `${who} ${m.question ? 'asks' : 'wrote to you'}: ${body}`, m.id)
  if (!getConfig().notifications || !canNotify() || (win?.isVisible() && win.isFocused())) return
  const n = new Notification({ title: m.question ? `Question from ${who}` : `Message from ${who}`, body, icon })
  n.on('click', () => {
    showWindow()
    send('nav:show', { view: 'terminals', board: true })
  })
  n.show()
}

/** Every agent name the user's name must not match: open agents, and any agent that posted or was addressed on the board. */
function agentNamesInUse(): string[] {
  const names = boardAgents().map((a) => a.name)
  for (const m of listMessages()) {
    if (m.author === 'agent' && m.agentName) names.push(m.agentName)
    for (const t of m.to ?? []) if (t !== 'user' && t !== 'assistant') names.push(t)
  }
  return names
}

/** The board's channel for a task (#145): its project's id. */
/** A channel the window named (#145): All, General or a project that exists; anything else is All. */
const boardChannel = (c: unknown): string =>
  c === GENERAL_CHANNEL || (typeof c === 'string' && c !== ALL_CHANNEL && !!projectStore.getProject(c)) ? String(c) : ALL_CHANNEL
const taskChannel = (taskId: number): string | undefined => listTasks().find((t) => t.id === taskId)?.projectId
const boardDeps: BoardDeps = {
  agents: boardAgents,
  posted: boardPosted,
  userName: () => getConfig().userName,
  done: (taskId, m) => {
    workers.markDone(taskId)
    // a "Corvid could:" line in a done post goes to the suggestions note (#202): the app collects, nobody is told
    if (m)
      collectSuggestion(
        { text: m.text, taskId, project: projectStore.getProject(taskChannel(taskId) ?? '')?.name },
        {
          find: (name) => listNotes().find((n) => n.name === name),
          create: (name, text) => createNote({ name, text }, { author: 'assistant' }),
          append: (id, text) => void appendNote(id, text, { author: 'assistant' })
        }
      )
  },
  projectOf: taskChannel,
  projectName: (id) => projectStore.getProject(id)?.name,
  // agent pings (#195): every switch and limit is checked in agentPing.ts, here in main
  agentPosted: (m, from) => agentPing.agentPosted(m, from),
  pings: () => ({ on: getConfig().agentPings, wake: getConfig().agentPings && getConfig().agentPingWake })
}

/** A question this worker asked the user on the board since it started, with no answer yet: a reply to it, or a message
 *  from the user to the agent after it. Such an agent is waiting on the user, so it's never closed as finished (#70). */
function unansweredQuestion(w: { taskId: number; agentName?: string; startedAt: number }): boolean {
  const list = listMessages()
  return list.some(
    (q) =>
      q.author === 'agent' &&
      q.question &&
      q.taskId === w.taskId &&
      q.ts >= w.startedAt &&
      !list.some((a) => a.author === 'user' && a.id > q.id && (a.replyTo === q.id || (!!w.agentName && !!a.to?.some((t) => nameKey(t) === nameKey(w.agentName!)))))
  )
}

// ---------- remote systems ----------

const remoteSnapshot = () => {
  const secretStorage = storageStatus()
  return { systems: listViews(), approvals: remote.listApprovals(), canEncrypt: secretStorage.available, secretStorage, drafts: drafts.draftsWaiting() }
}

/** An agent proposed a connector or asked for a connection (#92): a board notice and a notification, information only. */
function onDraftArrived(a: { kind: 'draft' | 'request'; agentName?: string; taskId?: number; text: string }): void {
  try {
    boardPosted(boardPost({ author: 'corvid', agentName: a.agentName, taskId: a.taskId, text: cutText(a.text, 1800) }))
  } catch (e) {
    console.error('board post failed', e)
  }
  if (!getConfig().notifications || !canNotify()) return
  const n = new Notification({ title: a.kind === 'draft' ? 'A connector was proposed' : 'An agent asks for a connection', body: a.text.slice(0, 200), icon })
  n.on('click', () => {
    showWindow()
    send('nav:show', { view: 'connections' })
  })
  n.show()
}

function onApprovalRequested(a: RemoteApproval): void {
  // Strict systems are for production: make sure the request is seen, focused or not.
  if (canNotify()) {
    const n = new Notification({
      title: a.kind === 'connector' ? `Approve the ${a.command} connector?` : `Approve a command on ${a.systemName}?`,
      body: (a.kind === 'connector' ? `${a.agent} wants to use ${a.systemName} for the first time.` : `${a.agent}: ${a.command}`).slice(0, 200),
      icon
    })
    n.on('click', () => {
      showWindow()
      send('nav:show', { view: 'connections' })
    })
    n.show()
  }
  win?.flashFrame(true)
}

// Connections (#87): state for inspecting and testing, and the kill switches. The Connections tab (part 2) builds
// on these. Nothing here returns a secret; setSecret only answers whether the slot is now set.
function registerConnectionsIpc(): void {
  ipcMain.handle('connections:state', () => connectorStore.connectionsState())
  ipcMain.handle('connections:audit', (_e, limit?: number) => connectorStore.readCallAudit(limit))
  ipcMain.handle('connections:killAll', (_e, on: boolean) => connectors.switchOffAll(!!on))
  ipcMain.handle('connections:disableConnector', (_e, id: string, off: boolean) => connectors.switchOffConnector(String(id), !!off))
  ipcMain.handle('connections:setSecret', (_e, id: string, slot: string, value: string | null) => {
    const set = connectorStore.setSecret(String(id), String(slot), value)
    send('remote', remoteSnapshot())
    return set
  })
  // The Connections tab (#88). Each change tells the window through the same 'remote' event the approvals use.
  const changed = <T>(r: T): T => (send('remote', remoteSnapshot()), r)
  ipcMain.handle('connections:save', (_e, input: connectorStore.ConnectionInput) => changed(connectorStore.saveConnection(checkDbConnection(input))))
  ipcMain.handle('connections:delete', (_e, id: string) => changed(connectorStore.deleteConnection(String(id))))
  ipcMain.handle('connections:test', async (_e, id: string) => {
    const c = connectorStore.getConnection(String(id))
    if (!c) return { ok: false, message: 'That connection no longer exists.' }
    const m = connectorStore.getManifest(c.connectorId)?.manifest
    // HTTP: the connection's safe GET (test_path), audited as test_connection (#89)
    if (m?.runtime === 'http') {
      const r = await testHttpConnection(c, m)
      send('remote', remoteSnapshot())
      return { ok: r.ok, message: r.message }
    }
    // databases: sign in and run a read-only SELECT 1 (#90)
    if (m && isDialect(m.runtime)) {
      const r = await testDbConnection(c, m)
      send('remote', remoteSnapshot())
      return { ok: r.ok, message: r.message }
    }
    const sys = c.connectorId === 'ssh' ? getSystem(c.id) : undefined
    // SSH connects and checks the host key, and runs nothing
    if (!sys) return { ok: false, message: "This connector doesn't offer a safe test yet." }
    try {
      const r = await testConnection(sys)
      return { ok: true, message: r.newHostKey ? `Connected. First connection: remembered host key ${r.newHostKey}.` : 'Connected; host key matches.' }
    } catch (e) {
      return { ok: false, message: scrubber()((e as Error).message) }
    } finally {
      send('remote', remoteSnapshot())
    }
  })
  // Send a request (#105): the user's own request; the response comes back to this window only
  ipcMain.handle('connections:planRequest', (_e, id: string, req: UserRequest) => planUserRequest(String(id), req))
  ipcMain.handle('connections:sendRequest', async (_e, id: string, reqId: string, req: UserRequest, confirmed: RequestClass | null) => {
    const r = await sendUserRequest(String(id), String(reqId), req, confirmed)
    send('remote', remoteSnapshot())
    return r
  })
  ipcMain.handle('connections:cancelRequest', (_e, reqId: string) => cancelUserRequest(String(reqId)))
  ipcMain.handle('connections:saveResponseNote', (_e, name: string, text: string) => {
    try {
      const n = responseNoteText(name, text)
      return { id: createNote(n, { author: 'user' }).id }
    } catch (e) {
      return { error: (e as Error).message }
    }
  })
  ipcMain.handle('connections:auditAll', (_e, limit?: number) => manage.mergedAudit(limit))
  ipcMain.handle('connections:connector', (_e, id: string) => manage.connectorDetail(String(id)))
  ipcMain.handle('connections:decideConnector', (_e, id: string, hash: string, approve: boolean) => changed(manage.decideConnector(String(id), String(hash), !!approve)))
  ipcMain.handle('connections:checkManifest', (_e, text: string) => manage.checkManifest(String(text ?? '')))
  ipcMain.handle('connections:importManifest', (_e, text: string) => changed(manage.importManifest(String(text ?? ''))))
  ipcMain.handle('connections:deleteConnector', (_e, id: string) => changed(manage.deleteConnector(String(id))))
  ipcMain.handle('connections:openManifest', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose a connector manifest', filters: [{ name: 'Connector manifest', extensions: ['json'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return undefined
    // a manifest is at most 64 KB; anything bigger is refused by the validator anyway
    return readFileSync(r.filePaths[0], 'utf8').slice(0, 256 * 1024)
  })
  ipcMain.handle('connections:openDoc', async () => {
    // the app folder holds the source when Corvid runs from its checkout; walk up from a built app's folder
    for (let dir = app.getAppPath(), i = 0; i < 4; i++, dir = dirname(dir)) {
      const doc = join(dir, 'docs', 'CONNECTORS.md')
      if (existsSync(doc)) return !(await shell.openPath(doc))
    }
    return false
  })
  // agent drafts (#92): every decision is the user's, made here; no agent path reaches these
  ipcMain.handle('connections:drafts', () => drafts.draftsState())
  ipcMain.handle('connections:approveDraft', (_e, id: string, hash: string, scope: string) => changed(drafts.approveDraft(String(id), String(hash), scope === 'global' ? 'global' : 'project')))
  ipcMain.handle('connections:declineDraft', (_e, id: string, reason?: string) => changed(drafts.declineDraft(String(id), reason === undefined ? undefined : String(reason))))
  ipcMain.handle('connections:extendDraft', (_e, id: string) => changed(drafts.extendDraft(String(id))))
  ipcMain.handle('connections:deleteDraft', (_e, id: string) => changed(drafts.deleteDraft(String(id))))
  ipcMain.handle('connections:promoteConnector', (_e, id: string) => changed(drafts.promoteConnector(String(id))))
  ipcMain.handle('connections:setRequest', (_e, id: string, status: string) => changed(drafts.setRequestStatus(String(id), status === 'done' ? 'done' : 'dismissed')))
  ipcMain.handle('connections:exportAudit', async () => {
    const r = await dialog.showSaveDialog(win!, { title: 'Export the connections log (no secrets, no results)', defaultPath: 'corvid-connections-log.jsonl' })
    if (r.canceled || !r.filePath) return false
    writeFileSync(r.filePath, manage.auditExport())
    return true
  })
}

function registerRemoteIpc(): void {
  ipcMain.handle('remote:list', () => remoteSnapshot())
  ipcMain.handle('remote:save', (_e, input: RemoteSystemInput) => {
    const v = saveSystem(input)
    connectorStore.syncRemote()
    send('remote', remoteSnapshot())
    return v
  })
  ipcMain.handle('remote:delete', (_e, id: string) => {
    deleteSystem(id)
    connectorStore.syncRemote()
    send('remote', remoteSnapshot())
  })
  ipcMain.handle('remote:forgetHost', (_e, id: string) => {
    forgetHost(id)
    send('remote', remoteSnapshot())
  })
  ipcMain.handle('remote:test', async (_e, id: string) => {
    const sys = getSystem(id)
    if (!sys) return { ok: false, message: 'That system no longer exists.' }
    try {
      const r = await testConnection(sys)
      send('remote', remoteSnapshot())
      return { ok: true, message: r.newHostKey ? `Connected. First connection: remembered host key ${r.newHostKey}.` : 'Connected; host key matches.' }
    } catch (e) {
      send('remote', remoteSnapshot())
      return { ok: false, message: scrubber()((e as Error).message) }
    }
  })
  ipcMain.handle('remote:decide', (_e, id: string, approve: boolean) => {
    remote.decide(id, approve)
    if (!remote.listApprovals().length) win?.flashFrame(false)
  })
  ipcMain.handle('remote:audit', (_e, limit?: number) => readAudit(limit))
  ipcMain.handle('remote:pickKey', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose the private key file',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('remote:export', async () => {
    const r = await dialog.showSaveDialog(win!, { title: 'Export remote systems (no secrets)', defaultPath: 'corvid-systems.json' })
    if (r.canceled || !r.filePath) return false
    writeFileSync(r.filePath, exportSystems())
    return true
  })
  // The profile picture: set only from the window, and every place that shows it hears the change at once.
  ipcMain.handle('profile:avatar', () => readAvatar())
  ipcMain.handle('profile:pick', () => pickPicture(win!))
  ipcMain.handle('profile:save', (_e, bytes: unknown) => send('profile:avatar', saveAvatar(bytes)))
  ipcMain.handle('profile:remove', () => {
    removeAvatar()
    send('profile:avatar', null)
  })
}

// ---------- IPC ----------

/** Folders whose subfolders are projects: as set in Settings, or worked out from session history. */
function projectRoots(): string[] {
  if (getConfig().projectRoots.length) return getConfig().projectRoots
  const home = projectKey(homedir())
  return deriveRoots([...new Set([...sessions.values()].map((s) => s.cwd && projectPath(s.cwd)).filter((c) => c && projectKey(c) !== home))])
}

function registerIpc(): void {
  ipcMain.handle('app:bootstrap', async () => ({
    sessions: [...sessions.values()],
    activity: [...activity.values()],
    tasks: listTasks(),
    notes: listNotes(),
    board: boardSnapshot(),
    assistant: assistant.snapshot(),
    progress,
    stats,
    liveTokens,
    liveSessions,
    quota: getQuota(),
    terminals: pty.listTerminals(),
    config: getConfig(),
    remote: remoteSnapshot(),
    claude: await resolveClaude(getConfig().claudePath),
    claudeDefaultModel: claudeDefaultModel(),
    home: homedir(),
    projects: projectStore.projectsState()
  }))
  ipcMain.handle('sessions:search', (_e, q: string) => ask('search', { q }))
  ipcMain.handle('sessions:refresh', () => indexer.postMessage({ type: 'refresh' }))
  ipcMain.handle('usage:refresh', () => fetchQuota(onQuota))

  ipcMain.handle(
    'pty:launch',
    async (_e, opts: { mode: LaunchMode; cwd: string; title: string; sessionId?: string }) => {
      const bin = await resolveClaude(getConfig().claudePath)
      if (!bin) throw new Error(CLAUDE_NOT_FOUND)
      // resuming a worker's session (Restart in Agents) keeps the name it had
      const agentName = opts.mode === 'resume' && opts.sessionId ? workers.listWorkers().find((w) => w.sessionId === opts.sessionId)?.agentName : undefined
      // Claude resumes a session by id from any folder (4/5), so a session from a moved folder opens in its new place;
      // a folder that's missing and wasn't relocated is refused instead of opening in the home folder
      const cwd = projectStore.currentPathFor(opts.cwd)
      if (!cwd) throw new Error(`${opts.cwd} is missing (moved, renamed, deleted, or on a drive that isn't connected). Use Locate folder… on its project page, then try again.`)
      return pty.launchClaude(bin.path, opts.mode, cwd, opts.title, opts.sessionId, agentName)
    }
  )
  ipcMain.handle('pty:shell', (_e, cwd: string, title: string) => pty.launchShell(cwd, title))
  ipcMain.handle('pty:shells', () => pty.availableShells())
  ipcMain.handle('pty:side', (_e, opts: { shellId?: string; title?: string; cwd?: string }) =>
    pty.launchSideShell(opts.shellId, opts.title, opts.cwd)
  )
  ipcMain.handle('pty:attach', (_e, termId: string) => pty.attach(termId))
  ipcMain.on('pty:input', (_e, termId: string, data: string) => {
    pty.write(termId, data)
    workers.typed(termId, String(data))
    if (workers.isTyping(String(data))) invoke.userTyped(termId)
  })
  ipcMain.on('pty:resize', (_e, termId: string, cols: number, rows: number) => pty.resize(termId, cols, rows))
  ipcMain.handle('pty:close', (_e, termId: string) => pty.close(termId))

  ipcMain.handle('open:vscode', (_e, cwd: string, sessionId?: string) => {
    // a session from a moved folder opens in the new place (4/5)
    const here = projectStore.currentPathFor(cwd)
    if (!here) throw new Error(`${cwd} is missing (moved, renamed, deleted, or on a drive that isn't connected). Use Locate folder… on its project page.`)
    return openInVSCode(here, sessionId)
  })
  ipcMain.handle(
    'open:wt',
    async (_e, opts: { mode: LaunchMode; cwd: string; sessionId?: string; title?: string }) => {
      const bin = await resolveClaude(getConfig().claudePath)
      if (!bin) throw new Error(CLAUDE_NOT_FOUND)
      const cwd = projectStore.currentPathFor(opts.cwd)
      if (!cwd) throw new Error(`${opts.cwd} is missing (moved, renamed, deleted, or on a drive that isn't connected). Use Locate folder… on its project page, then try again.`)
      openInTerminal(bin.path, cwd, opts.mode, opts.sessionId, opts.title)
    }
  )
  // the terminal button hides on Linux when no terminal is found; asked after the login shell's PATH is in (#157)
  ipcMain.handle('open:terminalAvailable', async () => {
    await loginEnvReady()
    return terminalAvailable()
  })
  // a task's model (#136): putting a task on Fable needs the user's yes in Corvid's own dialog, given when they pick it
  ipcMain.handle('tasks:pickFable', (_e, id?: number) => pickTaskFable(typeof id === 'number' ? id : undefined))
  ipcMain.handle('tasks:create', async (_e, input: Partial<Task> & { title: string }) =>
    createTask(input, { fable: parseTaskModel(input.model) === 'fable' && !restoresFable(input) && (await taskFableConsent(undefined)) })
  )
  ipcMain.handle('tasks:update', async (_e, id: number, patch: Partial<Task>) => {
    const toFable = 'model' in patch && parseTaskModel(patch.model) === 'fable' && listTasks().find((t) => t.id === id)?.model !== 'fable'
    return updateTask(id, patch, { fable: toFable && (await taskFableConsent(id)) })
  })
  ipcMain.handle('tasks:remove', (_e, id: number) => removeTask(id))
  // attached files (#187): only the window adds or removes them, as bytes it read when they were attached
  ipcMain.handle('tasks:addFiles', (e, id: number, files: unknown) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can attach files to a task.')
    const list = Array.isArray(files)
      ? files.map((f: any) => {
          if (!f || typeof f.name !== 'string' || !(f.data instanceof Uint8Array)) throw new Error('An attached file was not readable.')
          return { name: f.name, data: f.data as Uint8Array }
        })
      : []
    return addTaskFiles(Number(id), list)
  })
  ipcMain.handle('tasks:removeFile', (e, id: number, index: number) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can remove a task’s files.')
    return removeTaskFile(Number(id), Number(index))
  })
  // an attached image for the viewer, and any other file shown in its folder, never opened or run (as the board's, #147)
  ipcMain.handle('tasks:fileImage', (e, id: number, index: number) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can open attached files.')
    const found = taskFilePath(Number(id), Number(index))
    if (!found || found.att.kind !== 'image' || !existsSync(found.path)) throw new Error('That attached image is gone.')
    return new Uint8Array(readFileSync(found.path))
  })
  ipcMain.handle('tasks:revealFile', (e, id: number, index: number) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can open attached files.')
    const found = taskFilePath(Number(id), Number(index))
    if (!found || !existsSync(found.path)) throw new Error('That attached file is gone.')
    shell.showItemInFolder(found.path)
  })
  ipcMain.handle('tasks:arrange', (_e, column: TaskColumn, ids: number[]) => arrangeColumn(column, ids))
  ipcMain.handle('notes:create', (_e, input: { name: string; text: string; project?: string }) => createNote(input, { author: 'user' }))
  ipcMain.handle('notes:update', (_e, id: string, patch: { name?: string; text?: string }, baseRev?: string) =>
    updateNote(id, patch, { author: 'user' }, baseRev)
  )
  ipcMain.handle('notes:delete', (_e, id: string) => deleteNote(id))
  ipcMain.handle('notes:restore', (_e, id: string) => restoreNote(id))
  ipcMain.handle('notes:seen', (_e, id: string) => markSeen(id))
  ipcMain.handle('notes:folder', () => openFolder(notesDir()))
  // the Lineage view (#203): read-only, derived from the log and the data that exists now
  ipcMain.handle('lineage:graph', (_e, filter: { days?: number; taskId?: number; project?: string }) => lineage.lineageGraph({ notes: listNotes(), messages: listMessages(), tasks: listTasks() }, filter ?? {}))
  // Extensions (#95): the window's own handlers only. Importing validates and stores text; nothing is run or built,
  // and no agent or MCP tool can reach any of these.
  ipcMain.handle('extensions:list', () => extensions.list())
  ipcMain.handle('extensions:detail', (_e, key: string) => extensions.detail(String(key)))
  ipcMain.handle('extensions:importDropped', (_e, items: unknown) => extensions.importDropped(items))
  ipcMain.handle('extensions:pick', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import an extension',
      filters: [{ name: 'Corvid extension', extensions: ['corvid'] }],
      properties: ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : extensions.importFiles(r.filePaths.slice(0, 50), 'picker')
  })
  ipcMain.handle('extensions:importText', (_e, text: unknown) => [extensions.importText(text)])
  // the clipboard is read here, so Paste works without the window asking for clipboard permission
  ipcMain.handle('extensions:paste', async () => {
    const text = await clipboard.readText()
    return text.trim() ? [extensions.importText(text)] : [{ name: 'Pasted text', ok: false, errors: ['The clipboard is empty. Copy the text of a .corvid file first.'] }]
  })
  ipcMain.handle('extensions:resolve', (_e, token: unknown, choice: unknown) => extensions.resolveImport(token, choice))
  ipcMain.handle('extensions:sockets', () => mainExtensionStates())
  ipcMain.handle('extensions:delete', (_e, key: string) => extensions.remove(String(key)))
  // the packaging wizard (#100): a chat that only ever produces text
  ipcMain.handle('packager:state', () => packager.snapshot())
  ipcMain.handle('packager:open', () => packager.open())
  ipcMain.handle('packager:close', () => packager.close())
  ipcMain.handle('packager:begin', (_e, mode: unknown, picked: unknown, findings?: unknown) => packager.begin(mode, picked, findings))
  ipcMain.handle('packager:reply', (_e, text: unknown) => packager.reply(text))
  ipcMain.handle('packager:save', () => packager.saveDraft())
  ipcMain.handle('packager:stop', () => packager.stop())
  ipcMain.handle('packager:reset', () => packager.reset())
  ipcMain.handle('packager:author', (_e, name: unknown) => packager.setAuthor(name))
  // the scan (#96): the user starts it from the tab after a cost confirmation; over the usage limit, Corvid's own
  // dialog asks first (the #93 prompt). The classifier call can't act: see extensionScan.ts
  ipcMain.handle('extensions:scanUsage', () => workers.usageOverText(getConfig().scanModel ?? 'haiku'))
  ipcMain.handle('extensions:scan', async (_e, key: string) => {
    const over = await workers.usageOverText(getConfig().scanModel ?? 'haiku')
    if (over && !(await confirmScanOverLimit(over))) return { error: 'Not scanned: usage is over the limit and you chose Cancel.' }
    return extensionScan.scan(String(key))
  })
  ipcMain.handle('extensions:confirmWarning', (_e, key: string, phrase: unknown) => extensionScan.confirmWarning(String(key), phrase))
  ipcMain.handle('extensions:skipScan', (_e, key: string, phrase: unknown) => extensionScan.skipScan(String(key), phrase))
  // the estimate and the install confirmation (#97): Confirm needs the token prepareInstall made for this dialog
  ipcMain.handle('extensions:estimate', (_e, key: string) => budget.estimateFor(String(key)))
  ipcMain.handle('extensions:prepareInstall', (_e, key: string) => budget.prepareInstall(String(key)))
  ipcMain.handle('extensions:confirmInstall', (_e, key: unknown, token: unknown) => budget.confirmInstall(key, token))
  ipcMain.handle('extensions:accuracy', () => budget.accuracy())
  // the install pipeline (#98): only the window reaches these; no MCP tool or board message does
  ipcMain.handle('extensions:preflight', (_e, key: string) => install.preflight(String(key)))
  ipcMain.handle('extensions:confirmTier3', (_e, key: string, areas: unknown) => install.confirmTier3(String(key), areas))
  ipcMain.handle('extensions:diff', (_e, key: string) => install.fullDiff(String(key)))
  ipcMain.handle('extensions:merge', (_e, key: string, ack: { tip?: unknown; flagsRead?: unknown }) =>
    install.merge(String(key), { tip: String(ack?.tip ?? ''), flagsRead: ack?.flagsRead === true }).then((r) => ('ok' in r && lifecycle.afterMerge(String(key)), r)))
  ipcMain.handle('extensions:sendBack', (_e, key: string, note: unknown) => install.sendBack(String(key), note))
  ipcMain.handle('extensions:discard', (_e, key: string) => {
    const r = install.discard(String(key))
    if ('ok' in r) lifecycle.afterDiscard(String(key))
    return r
  })
  // the lifecycle (#99): disable, enable, remove, re-apply, rebuild; merging only from these window handlers
  const yes = (v: unknown): boolean => v === true
  ipcMain.handle('extensions:lifecycle', (_e, key: string) => lifecycle.info(String(key)))
  ipcMain.handle('extensions:disable', (_e, key: string, confirmed: unknown) => lifecycle.disable(String(key), yes(confirmed)))
  ipcMain.handle('extensions:enable', (_e, key: string, confirmed: unknown) => lifecycle.enable(String(key), yes(confirmed)))
  ipcMain.handle('extensions:remove', (_e, key: string, deleteText: unknown, confirmed: unknown) => lifecycle.remove(String(key), yes(deleteText), yes(confirmed)))
  ipcMain.handle('extensions:reapply', (_e, key: string, confirmed: unknown) => lifecycle.reapply(String(key), yes(confirmed)))
  ipcMain.handle('extensions:rebuild', (_e, key: string) => lifecycle.requestRebuild(String(key)))
  ipcMain.handle('extensions:pendingDiff', (_e, key: string) => lifecycle.pendingDiff(String(key)))
  ipcMain.handle('extensions:approvePending', async (_e, key: string, tip: unknown) => {
    // an agent's resolution (#117): its build task is finished once the user merged it
    const t = lifecycle.recordOf(String(key))?.lifecycle?.pending?.resolved?.taskId
    const r = await lifecycle.approve(String(key), String(tip ?? ''))
    if ('ok' in r) resolveConflict.afterApproved(t)
    return r
  })
  // Resolve with an agent (#117): the confirmation and every action come only from the extension's page
  ipcMain.handle('extensions:prepareResolve', (_e, key: string) => resolveConflict.prepareResolve(String(key)))
  ipcMain.handle('extensions:confirmResolve', (_e, key: unknown, token: unknown, protectedOk: unknown) => resolveConflict.confirmResolve(key, token, protectedOk))
  ipcMain.handle('extensions:stopResolve', (_e, key: string) => resolveConflict.stopResolve(String(key)))
  ipcMain.handle('extensions:leaveConflict', (_e, key: string) => resolveConflict.leaveConflict(String(key)))
  ipcMain.handle('extensions:sendBackResolved', (_e, key: string, note: unknown) => resolveConflict.sendBackResolved(String(key), note))
  ipcMain.handle('extensions:discardPending', (_e, key: string) => lifecycle.discardPending(String(key)))
  ipcMain.handle('extensions:textOf', (_e, key: string) => extensions.textOf(String(key)))
  // build progress (#108): read-only views, and Stop build (the same as the cap's Stop); no approve or merge here
  ipcMain.handle('extensions:stopBuild', (_e, key: string) => install.stopBuild(String(key)))
  ipcMain.handle('extensions:buildFiles', (_e, key: string) => buildProgress.touchedFiles(String(key)))
  ipcMain.handle('extensions:buildDiff', (_e, key: string) => buildProgress.diffSoFar(String(key)))
  ipcMain.handle('extensions:buildLive', () => ({ capAsking: buildProgress.capDialogOpen() }))
  // verify and share (#101): only from Corvid's window
  ipcMain.handle('extensions:verifyCheck', (_e, key: string) => verify.verifyCheck(String(key)))
  ipcMain.handle('extensions:prepareVerify', (_e, key: string, base: unknown) => verify.prepareVerify(String(key), base))
  ipcMain.handle('extensions:confirmVerify', (_e, key: unknown, token: unknown) => verify.confirmVerify(key, token))
  ipcMain.handle('extensions:sharePreview', (_e, key: string) => verify.sharePreview(String(key)))
  ipcMain.handle('extensions:share', (_e, key: string, how: unknown, leaksRead: unknown) => verify.share(String(key), how, leaksRead))
  // The board's message box: the only way a message is marked as the user's, and the only way a board message wakes
  // Corvid, whether it says @corvid or was untagged (#69). The MCP tools (every agent, and Corvid itself) post through
  // boardTools and never reach this; and only the app's own window may send it.
  ipcMain.handle('board:post', (e, text: string, replyTo?: number, opts?: { boardOnly?: boolean; channel?: string; files?: unknown }) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can post as you.')
    // attached files (#147): bytes the window read when they were attached, copied into the board's own folder
    const files = Array.isArray(opts?.files)
      ? opts.files.map((f: any) => {
          if (!f || typeof f.name !== 'string' || !(f.data instanceof Uint8Array)) throw new Error('An attached file was not readable.')
          return { name: f.name, data: f.data as Uint8Array }
        })
      : []
    if (files.length && leadingCommand(String(text ?? '').trim())) throw new Error('A slash command can’t carry attached files. Send the files in their own message.')
    // a slash command (#71): only from here, so only what the user typed in this window can run one. It goes to
    // Corvid whatever Board only or the untagged setting say.
    const cmd = runCommand(String(text ?? ''), replyTo, commandDeps, boardChannel(opts?.channel))
    if (cmd) return cmd
    const m = postAsUser(String(text ?? ''), replyTo, boardDeps, { untagged: getConfig().untaggedToCorvid, boardOnly: opts?.boardOnly === true, channel: boardChannel(opts?.channel), files })
    if (m.to?.includes('assistant')) assistant.askFromBoard(m)
    // running agents it mentions are woken (#80), ended ones come back (#62): only from here, the user's own typing,
    // never from the board tools
    invoke.userPosted(m)
    void wake.userPosted(m).catch((err) => console.error('resume failed', err))
    return m
  })
  // the status line under the user's message: Resume, Resume when a slot is free, Cancel the wait
  ipcMain.handle('board:wake', (e, id: number, who: string, action: 'now' | 'queue' | 'cancel') => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can resume an agent.')
    if (!['now', 'queue', 'cancel'].includes(action)) throw new Error('Unknown action.')
    return wake.wakeAction(Number(id), String(who), action)
  })
  // Retry on a failed message to Corvid: again only the user's own messages that addressed Corvid
  ipcMain.handle('board:askCorvid', (e, id: number) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can ask Corvid.')
    const m = boardMessage(Number(id))
    if (!m) throw new Error('That message is gone (it expired or the board was cleared).')
    if (m.author !== 'user' || !m.to?.includes('assistant')) throw new Error('Only your own messages to Corvid go to Corvid.')
    // a command goes again as typed: askFromBoard reads `command`, which only the box sets (see board:post)
    assistant.askFromBoard(m)
  })
  ipcMain.handle('board:seen', (_e, upTo: number, channel?: string) => markBoardSeen(Number(upTo), boardChannel(channel)))
  ipcMain.handle('board:clear', () => clearBoard())
  // an attached image for the board's thumbnail and viewer (#147): only images, only from the window
  ipcMain.handle('board:attachment', (e, id: number, index: number) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can open attached files.')
    const found = attachmentPath(Number(id), Number(index))
    if (!found || found.att.kind !== 'image') throw new Error('That attached image is gone (it expired or the board was cleared).')
    return new Uint8Array(readFileSync(found.path))
  })
  // any other attached file: shown in its folder, never opened or run from here
  ipcMain.handle('board:revealAttachment', (e, id: number, index: number) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can open attached files.')
    const found = attachmentPath(Number(id), Number(index))
    if (!found || !existsSync(found.path)) throw new Error('That attached file is gone (it expired or the board was cleared).')
    shell.showItemInFolder(found.path)
  })
  ipcMain.handle('board:saveNote', (_e, id: number) => saveMessageAsNote(id, (taskId) => listTasks().find((t) => t.id === taskId)?.project, getConfig().userName))
  // /discuss (#200): Stop and Save as note, from the window only
  ipcMain.handle('board:discussStop', (e) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can stop a discussion.')
    return discussion.stopDiscussion()
  })
  ipcMain.handle('board:discussSave', (e, id: number) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can save a discussion.')
    return discussion.saveDiscussionNote(Number(id))
  })
  ipcMain.handle('assistant:interrupt', () => assistant.interrupt())
  // the task board's Automate button: same path and limits as the assistant's start_worker
  ipcMain.handle('workers:request', async (_e, taskId: number) => {
    const r = await workers.requestWorker(taskId)
    if (r.proposal) assistant.note(`Proposed a worker for #${taskId} from the task board. Approve it in the Agents view to start.`)
    else if (r.worker)
      assistant.note(`Started ${r.worker.agentName ? `${r.worker.agentName} on` : 'a worker for'} #${taskId} from the task board.`)
    return r.error ?? (r.proposal ? 'proposed' : 'started')
  })
  ipcMain.handle('workers:stop', (_e, id: string) => void workers.stopWorker(id))
  ipcMain.handle('workers:dismiss', (_e, id: string) => workers.dismissWorker(id))
  // closing finished agents (#70): the terminals on screen hold them open, and Keep open on a card cancels the countdown
  ipcMain.on('workers:viewing', (_e, termIds: unknown) => workers.setViewing(termIds))
  ipcMain.handle('workers:keepOpen', (_e, id: string) => workers.keepOpen(String(id)))
  ipcMain.handle('workers:stopAll', () => {
    const n = workers.stopAll()
    if (n) assistant.note(`Stopped ${n} worker${n === 1 ? '' : 's'}.`, 'warn')
    return n
  })
  ipcMain.handle('voice:status', () => voiceStatus())
  ipcMain.handle('app:desktop-info', async (): Promise<DesktopInfo> => {
    await trayProbe
    return { tray: trayShown, trayClicks: trayClicks(), notifications: Notification.isSupported(), wayland: isWayland() }
  })
  ipcMain.handle('voice:start', (_e, id: string, keyterms: string[]) => startVoice(id, keyterms))
  ipcMain.on('voice:audio', (_e, id: string, chunk: Uint8Array) => voiceAudio(id, chunk))
  ipcMain.on('voice:stop', (_e, id: string) => stopVoice(id))
  ipcMain.handle('proposal:approve', (_e, id: string) => workers.approve(id))
  ipcMain.handle('proposal:reject', (_e, id: string) => workers.reject(id))
  ipcMain.handle('git:track', (_e, paths: string[]) => track(paths))
  ipcMain.handle('git:refresh', (_e, path?: string) => (path ? refreshPath(path) : refreshAll()))
  ipcMain.handle('git:detail', (_e, repoRoot: string) => gitDetail(repoRoot))
  ipcMain.handle('git:graph', (_e, repoRoot: string, limit: number) => gitGraph(repoRoot, limit))
  ipcMain.handle('projects:archive', async () => {
    const roots = projectRoots()
    return { roots, entries: await scanArchive(roots) }
  })
  ipcMain.handle('projects:new', (_e, defaultPath?: unknown) =>
    newProject(win!, typeof defaultPath === 'string' && defaultPath ? defaultPath : projectRoots()[0])
  )
  ipcMain.handle('projects:addPath', (_e, input: { path: string; name?: string; pinned?: boolean }) => projectStore.addProject({ path: input.path, name: input.name, pinned: input.pinned }))
  ipcMain.handle('projects:update', (_e, id: string, patch: Partial<ProjectRecord>) => projectStore.updateProject(id, patch))
  ipcMain.handle('projects:remove', (_e, id: string) => projectStore.removeProject(id))
  ipcMain.handle('projects:importPreview', () => projectStore.importCandidates())
  ipcMain.handle('projects:import', (_e, picks: { path: string; name?: string; pinned?: boolean }[]) => projectStore.applyImport(picks.map((p) => ({ path: p.path, name: p.name, pinned: p.pinned }))))
  ipcMain.handle('projects:importCancel', () => projectStore.markImportOffered())
  // several folders per project (3/5)
  ipcMain.handle('projects:pickFolder', async (_e, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose a folder to add to the project', buttonLabel: 'Add this folder', defaultPath, properties: ['openDirectory'] })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('projects:addFolder', (_e, id: string, path: string, label?: string) => projectStore.addFolder(id, path, label))
  ipcMain.handle('projects:removeFolder', (_e, id: string, path: string, newPrimary?: string) => projectStore.removeFolder(id, path, newPrimary))
  ipcMain.handle('projects:editFolder', (_e, id: string, path: string, patch: { primary?: boolean; label?: string; move?: number }) => projectStore.editFolder(id, path, patch))
  ipcMain.handle('projects:mergePreview', (_e, into: string, from: string) => mergePreview(into, from, [...sessions.values()]))
  ipcMain.handle('projects:merge', (_e, into: string, from: string) => mergeProjects(into, from))
  ipcMain.handle('projects:undoMerge', () => projectStore.undoMerge())
  ipcMain.handle('projects:relocateCheck', (_e, id: string, from: string, to: string) => projectStore.relocateCheck(id, from, to))
  ipcMain.handle('projects:relocate', (_e, id: string, from: string, to: string) => projectStore.relocateFolder(id, from, to))
  ipcMain.handle('projects:cloneSuggestions', (_e, id: string) => projectStore.cloneSuggestions(id))
  // Corvid's own project (#78)
  ipcMain.handle('corvid:status', () => corvidSelf.corvidStatus())
  ipcMain.handle('corvid:licenseText', () => {
    // a packaged build carries it beside the app (extraResources); a checkout has it at the repo root
    const dirs = [process.resourcesPath]
    for (let dir = app.getAppPath(), i = 0; i < 4; i++, dir = dirname(dir)) dirs.push(dir)
    for (const dir of dirs) {
      const file = join(dir, 'LICENSE')
      if (existsSync(file)) return readFileSync(file, 'utf8')
    }
    return null
  })
  ipcMain.handle('corvid:ready', () => corvidSelf.markHealthy())
  ipcMain.handle('corvid:dismissNotice', () => corvidSelf.dismissNotice())
  ipcMain.handle('corvid:checkSetup', () => corvidSelf.checkSetup())
  // the update check (#143): only the window's buttons reach these, never an agent, tool or board message
  ipcMain.handle('update:view', () => updateView())
  ipcMain.handle('update:check', async () => (await runUpdateCheck(true), updateView()))
  ipcMain.handle('update:dismiss', () => dismissUpdate())
  ipcMain.handle('update:createTask', () => createUpdateTask())
  ipcMain.handle('corvid:pickCloneFolder', async () => {
    const r = await dialog.showSaveDialog(win!, {
      title: "Where to put Corvid's source",
      defaultPath: join(app.getPath('documents'), 'Corvid source'),
      buttonLabel: 'Use this folder',
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    return r.canceled ? undefined : r.filePath
  })
  ipcMain.handle('corvid:clone', (_e, dir: string) => corvidSelf.cloneSource(dir))
  ipcMain.handle('corvid:setSource', (_e, dir: string) => projectStore.setBuiltinSource(dir))
  ipcMain.handle('corvid:install', () => (TEST ? { code: null, error: REFUSED } : corvidSelf.installDeps((line) => send('corvid:installLine', line))))
  ipcMain.handle('corvid:cancelInstall', () => corvidSelf.cancelInstall())
  ipcMain.handle('corvid:rebuild', (_e, wait: boolean) => (TEST ? { error: REFUSED } : corvidSelf.rebuild(!!wait, () => workers.runningWorkers().length)))
  ipcMain.handle('corvid:cancelRebuild', () => corvidSelf.cancelRebuild())
  ipcMain.handle('corvid:rollback', () => (TEST ? { error: REFUSED } : corvidSelf.rollback()))
  ipcMain.handle('corvid:deployLog', () => corvidSelf.deployLog())
  ipcMain.on('crash:report', (_e, what: string, details: string) => rendererError(what, details))
  ipcMain.handle('crash:notice', () => {
    const n = crashNotice
    crashNotice = null
    return n
  })
  ipcMain.handle('crash:openLog', () => shell.openPath(crashLogFile()))
  ipcMain.handle('startup:notices', () => startupNotices.splice(0))
  ipcMain.handle('app:testOwner', () => (TEST ? owner() : null))
  ipcMain.handle('backups:list', () => backupsSummary())
  ipcMain.handle('backups:restore', async (_e, item: string, name: string) => {
    const when = `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)} ${name.slice(9, 11)}:${name.slice(11, 13)}`
    const { response } = await dialog.showMessageBox(win!, {
      type: 'warning',
      title: 'Corvid',
      message: `Restore ${item} from the backup of ${when}?`,
      detail: 'The current version is backed up first, so this can be undone the same way. Corvid restarts to load it, which stops running agents.',
      buttons: ['Restore and restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1
    })
    if (response !== 0) return { cancelled: true }
    const r = scheduleRestore(item, name)
    if ('error' in r) return r
    exitReason = `restart after restoring ${item}`
    quitting = true
    app.relaunch()
    app.quit()
    return r
  })
  ipcMain.handle('unfiled:get', () => unfiled.unfiledState())
  ipcMain.handle('unfiled:scan', () => unfiled.scan())
  ipcMain.handle('unfiled:ignore', (_e, paths: string[]) => unfiled.ignore(paths))
  ipcMain.handle('unfiled:restore', (_e, paths: string[]) => unfiled.restore(paths))
  ipcMain.handle('unfiled:dismiss', (_e, path: string, id: string) => unfiled.dismissSuggestion(path, id))
  ipcMain.handle('unfiled:seen', () => unfiled.markSeen())
  ipcMain.handle('unfiled:addTo', (_e, id: string, path: string) => unfiled.addToProject(id, path))
  ipcMain.handle('open:reveal', (_e, file: string) => revealFile(file))
  ipcMain.handle('open:folder', (_e, dir: string) => openFolder(dir))
  ipcMain.handle('open:file', (_e, file: string, root?: string) => openFileInVSCode(file, root))
  ipcMain.handle('fs:list', (_e, dir: string) => listDir(dir))
  ipcMain.handle('fs:drives', () => listDrives())
  ipcMain.handle('fs:places', () => listPlaces())
  ipcMain.handle('fs:preview', (_e, file: string) => readPreview(file))

  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => applyConfig(patch))
  registerTours(ipcMain)
  // agent pings (#195): only Corvid's own window, and turning on wake-ups asks in a native dialog first
  ipcMain.handle('config:agentPings', (e, patch: unknown) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can change agent pings.')
    return setAgentPings(patch)
  })
  // the Claude Code path (#194): only Corvid's own window, and a new path asks in a native dialog first
  ipcMain.handle('claudePath:browse', async (e) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can choose the Claude Code path.')
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose the Claude Code program',
      buttonLabel: 'Choose',
      defaultPath: (await resolveClaude(getConfig().claudePath))?.path,
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Claude Code (claude.exe)', extensions: ['exe'] }] : []
    })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('claudePath:check', (e, path: unknown) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can check the Claude Code path.')
    return checkClaudePath(path)
  })
  ipcMain.handle('claudePath:set', (e, path: unknown) => {
    if (e.sender !== win?.webContents) throw new Error('Only the Corvid window can change the Claude Code path.')
    return setClaudePath(path)
  })
  ipcMain.handle('agentPings:stats', () => agentPing.pingStats())
  ipcMain.handle('secrets:scan', (_e, root: string) => scanProject(root))
  ipcMain.handle('secrets:denyInfo', () => ({ dataFolders: dataFolders(), platform: process.platform }))
}

/** The settings that pick a model (#127): switching any of them to Fable asks first. */
const MODEL_SETTINGS = { assistantModel: "Corvid's own model", workerModel: 'new workers', scanModel: 'extension scans' } as const

/**
 * Switching a model setting to Fable (#127): the user's own click in Corvid's window, never an agent's. Every way of
 * choosing it ends here (the strip, Settings, /model fable, the scan's selector), and no MCP tool or board message
 * can set a model. Already being on Fable, or loading saved settings, doesn't ask.
 */
async function confirmFable(what: string): Promise<boolean> {
  const q = getQuota()
  const maybe = q && !q.error && !fableWeek(q.weeks) ? `\n\nYour plan's usage shows no Fable limit, so Fable ${FABLE_MAYBE_UNAVAILABLE}.` : ''
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Use Fable?',
    message: `Use Fable for ${what}?`,
    detail: `${FABLE_WARNING} Use Fable anyway?${maybe}`,
    buttons: ['Use Fable', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const shown = win && !win.isDestroyed() ? win : null
  if (shown && !shown.isVisible()) showWindow()
  const a = shown ? await dialog.showMessageBox(shown, options) : await dialog.showMessageBox(options)
  return a.response === 0
}

/** Tasks the user just confirmed Fable for in the editor (#136), by id ("new" for one not added yet), until when. */
const fablePicked = new Map<string, number>()

/**
 * Picking Fable for a task in its editor (#136): the same "Use Fable / Cancel" dialog and plan check as the settings.
 * A yes covers that task's next save for half an hour. No task tool can reach this: only the editor's IPC call.
 */
async function pickTaskFable(id?: number): Promise<{ ok: boolean; problem?: string }> {
  if (!(await confirmFable(id === undefined ? 'this new task' : `task #${id}`))) return { ok: false }
  const problem = await fableProblem()
  if (problem) return { ok: false, problem: `${problem} The task keeps its model.` }
  fablePicked.set(String(id ?? 'new'), Date.now() + 30 * 60_000)
  return { ok: true }
}

/** A save that puts a task on Fable: the editor's earlier yes, or the dialog now. */
async function taskFableConsent(id?: number): Promise<boolean> {
  const key = String(id ?? 'new')
  const until = fablePicked.get(key)
  fablePicked.delete(key)
  if (until && until > Date.now()) return true
  const ok = (await pickTaskFable(id)).ok
  fablePicked.delete(key)
  return ok
}

const modelName = (m?: string): string => (m === 'default' ? 'your default model' : choiceLabel(m ?? 'haiku'))

/** Fable answered a short test call in this run: it's on the plan. */
let fableOk = false

/**
 * Whether the plan has Fable, checked once per run with one tiny call (a few output tokens) the first time something is
 * switched to it: null when it works, else the reason in plain words. A test copy never makes the call: it fakes the
 * answer with DASH_FAKE_FABLE_PROBE=fail (or "ok", the default).
 */
async function fableProblem(): Promise<string | null> {
  if (fableOk) return null
  if (TEST) {
    if (process.env.DASH_FAKE_FABLE_PROBE === 'fail') return "Fable isn't available on your plan (the test call said: model not available)."
    return null
  }
  const bin = await resolveClaude(getConfig().claudePath)
  if (!bin) return `${CLAUDE_NOT_FOUND} Corvid needs it to check that Fable works.`
  const out = await new Promise<{ err?: string; stdout: string }>((resolve) =>
    execFile(
      bin.path,
      ['-p', 'Reply with just: ok', '--model', cliModel('fable'), '--no-session-persistence', '--output-format', 'json', '--tools', ''],
      { cwd: app.getPath('userData'), timeout: 90_000, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => resolve({ err: err ? String(stderr || err.message) : undefined, stdout: String(stdout ?? '') })
    )
  )
  let r: { is_error?: boolean; result?: string } | null = null
  try {
    r = JSON.parse(out.stdout)
  } catch {
    r = null
  }
  if (r && !r.is_error) {
    fableOk = true
    return null
  }
  const why = (r?.result ?? out.err ?? out.stdout).trim().split(/\r?\n/)[0]?.slice(0, 200) || 'no answer'
  return /model|access|plan|permission|not.?found|not available|subscription/i.test(why)
    ? `Fable isn't available on your plan (the test call said: ${why}).`
    : `Fable didn't start on a short test call: ${why}`
}

/**
 * The agent-ping settings (#195), from Settings only (config:agentPings checks the sender). Turning wake-ups on needs the
 * user's click on Allow in a native dialog, like Fable (#127); Cancel changes nothing. Turning pings off drops the ones
 * waiting. No MCP tool, board message, slash command or config:set reaches these keys (applyConfig drops them).
 */
async function setAgentPings(raw: unknown): Promise<AppConfig> {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const prev = getConfig()
  const patch: Partial<AppConfig> = {}
  if (typeof p.agentPings === 'boolean') patch.agentPings = p.agentPings
  if (typeof p.agentPingWake === 'boolean') patch.agentPingWake = p.agentPingWake
  if (p.agentPingLimits && typeof p.agentPingLimits === 'object') patch.agentPingLimits = cleanPingLimits({ ...prev.agentPingLimits, ...p.agentPingLimits })
  if (patch.agentPingWake && !prev.agentPingWake) {
    const ok = await confirmAgentWake()
    if (!ok) delete patch.agentPingWake
  }
  if (!Object.keys(patch).length) {
    send('config', prev)
    return prev
  }
  const next = setConfig(patch)
  console.warn(`[config] agent pings: ${JSON.stringify({ on: next.agentPings, wake: next.agentPingWake, limits: next.agentPingLimits })}`)
  if (prev.agentPings && !next.agentPings) agentPing.switchedOff()
  send('config', next)
  return next
}

/**
 * The Claude Code path (#194), from Settings only (claudePath:set checks the sender). A path is checked again here
 * (Check in the window isn't trusted), then the user confirms it in a native dialog; null goes back to automatic
 * detection. No MCP tool, board message, slash command, extension or config:set reaches the key (applyConfig drops it).
 * Everything that starts Claude calls resolveClaude(getConfig().claudePath) each time, so new starts use it at once.
 */
async function setClaudePath(raw: unknown): Promise<ClaudePathSaved> {
  const prev = getConfig().claudePath
  const done = async (ok: boolean, error?: string): Promise<ClaudePathSaved> => {
    forgetClaude()
    const claude = await resolveClaude(getConfig().claudePath)
    send('config', getConfig())
    send('claude', claude)
    return { ok, error, claude }
  }
  if (raw === null) {
    if (prev === undefined) return done(true)
    setConfig({ claudePath: undefined })
    console.warn(`[config] Claude Code path: back to automatic detection (was ${JSON.stringify(prev)})`)
    assistant.reload()
    return done(true)
  }
  const c = await checkClaudePath(raw)
  if (!c.ok) return done(false, c.error)
  if (c.path === prev) return done(true)
  if (!(await confirmClaudePath(c.resolved ? `${c.path} (points to ${c.resolved})` : c.path, c.version))) return done(false)
  setConfig({ claudePath: c.path })
  console.warn(`[config] Claude Code path set by the user: ${JSON.stringify(c.path)}${c.resolved ? ` -> ${JSON.stringify(c.resolved)}` : ''}, version ${c.version} (was ${prev ? JSON.stringify(prev) : 'automatic'})`)
  assistant.reload()
  return done(true)
}

/** Run this program for agents and Corvid? Only the user's own click on Use this program in Corvid's window says yes. */
async function confirmClaudePath(path: string, version: string): Promise<boolean> {
  if (TEST && process.env.DASH_FAKE_CLAUDE_PATH_CONFIRM) return process.env.DASH_FAKE_CLAUDE_PATH_CONFIRM === 'allow'
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Use this Claude Code?',
    message: `Corvid will run this program for agents and Corvid: ${path}`,
    detail: `It answered as Claude Code ${version}. It runs with your Claude sign-in, for every agent, Corvid, usage checks and scans started from now on. Agents already running keep the program they started with.`,
    buttons: ['Use this program', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const shown = win && !win.isDestroyed() ? win : null
  if (shown && !shown.isVisible()) showWindow()
  const a = shown ? await dialog.showMessageBox(shown, options) : await dialog.showMessageBox(options)
  return a.response === 0
}

/** Allow agent pings to wake finished agents? Only the user's own click on Allow in Corvid's window says yes. */
async function confirmAgentWake(): Promise<boolean> {
  if (TEST && process.env.DASH_FAKE_WAKE_CONFIRM) return process.env.DASH_FAKE_WAKE_CONFIRM === 'allow'
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Let agent pings wake finished agents?',
    message: 'Let agent pings wake finished agents?',
    detail: `${WAKE_WARNING} At most ${getConfig().agentPingLimits.wakesPerHour} an hour, and never an agent you stopped or one stopped at the time limit.`,
    buttons: ['Allow', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const shown = win && !win.isDestroyed() ? win : null
  if (shown && !shown.isVisible()) showWindow()
  const a = shown ? await dialog.showMessageBox(shown, options) : await dialog.showMessageBox(options)
  return a.response === 0
}

/** A settings change from the user: Settings, the Corvid strip, or a /mode or /model command on the board. */
async function applyConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  {
    // the agent-ping keys (#195) change only through setAgentPings
    if (AGENT_PING_KEYS.some((k) => k in (patch ?? {}))) {
      patch = { ...patch }
      for (const k of AGENT_PING_KEYS) delete patch[k]
    }
    // the Claude Code path (#194) changes only through setClaudePath
    if (patch && 'claudePath' in patch) {
      patch = { ...patch }
      delete patch.claudePath
    }
    const prev = getConfig()
    // switching a model to Fable asks first (#127); Cancel, or a plan without Fable, keeps the previous model
    const toFable = (Object.keys(MODEL_SETTINGS) as (keyof typeof MODEL_SETTINGS)[]).filter((k) => patch[k] === 'fable' && prev[k] !== 'fable')
    if (toFable.length) {
      const ok = await confirmFable(toFable.map((k) => MODEL_SETTINGS[k]).join(' and '))
      const problem = ok ? await fableProblem() : null
      if (!ok || problem) {
        patch = { ...patch }
        for (const k of toFable) delete patch[k]
        if (problem)
          assistant.note(
            `${problem} Nothing was switched (${toFable.map((k) => `${MODEL_SETTINGS[k]}: ${modelName(prev[k])}`).join(', ')}).`,
            'warn'
          )
        if (!Object.keys(patch).length) {
          send('config', prev)
          return prev
        }
      }
    }
    // Your name: checked here too, against the agents as main sees them; Settings shows the same message first
    if (patch.userName !== undefined) {
      const r = checkUserName(String(patch.userName), agentNamesInUse())
      if ('error' in r) throw new Error(r.error)
      patch = { ...patch, userName: r.name }
    }
    const next = setConfig(patch)
    if (patch.hotkey !== undefined && patch.hotkey !== prev.hotkey) registerHotkey(next.hotkey)
    if (patch.usagePollSec !== undefined && patch.usagePollSec !== prev.usagePollSec) startQuotaPolling(onQuota)
    if (patch.openAtLogin !== undefined) applyLoginItem()
    if (patch.disabledExtensions && JSON.stringify(patch.disabledExtensions) !== JSON.stringify(prev.disabledExtensions)) loadExtensionSockets(true)
    if (patch.theme || patch.themeFollowSystem !== undefined || patch.themeLight || patch.themeDark) applyChrome()
    if (patch.assistantModel && patch.assistantModel !== prev.assistantModel)
      assistant.note(`Corvid switched to ${choiceLabel(patch.assistantModel)}; the conversation carries over.`)
    if (patch.assistantPersonality && patch.assistantPersonality !== prev.assistantPersonality)
      assistant.note(`Corvid's personality set to ${patch.assistantPersonality}; it applies from your next message.`)
    if (patch.boardVoice && patch.boardVoice !== prev.boardVoice)
      assistant.note(`Board voice set to ${BOARD_VOICES[patch.boardVoice].label}; it applies to workers started from now on.`)
    const renamed = patch.userName !== undefined && patch.userName !== prev.userName
    if (renamed) assistant.note(`Your board name is now ${userLabel(next.userName)}. Corvid uses it from your next message; workers started from now on are told it, and @user still works.`)
    if (patch.workerModel && patch.workerModel !== prev.workerModel)
      assistant.note(`New workers will use ${patch.workerModel === 'default' ? 'your Claude Code default model' : choiceLabel(patch.workerModel)}.`)
    // the effort levels (#238): Corvid's from its next session (the reload below), the workers' for new workers only
    if (patch.assistantEffort && patch.assistantEffort !== prev.assistantEffort)
      assistant.note(`Corvid's effort set to ${effortLabel(next.assistantEffort)}; the conversation carries over.`)
    if (patch.workerEffort && patch.workerEffort !== prev.workerEffort)
      assistant.note(`New workers will run at ${next.workerEffort === 'default' ? "your Claude Code default effort" : `${effortLabel(next.workerEffort)} effort`}.`)
    if (patch.assistantModel || patch.assistantEffort || patch.assistantMode || patch.assistantPersonality || patch.limits || renamed) assistant.reload()
    if (patch.assistantMode || patch.limits || patch.workerModel) assistant.changed()
    if (patch.boardKeepDays !== undefined && patch.boardKeepDays !== prev.boardKeepDays) {
      pruneBoard()
      send('board', boardSnapshot())
    }
    send('config', next)
    return next
  }
}

/** The extensions under src/extensions (#102), loaded into their sockets; again whenever their flags change. */
function loadExtensionSockets(reload = false): void {
  loadMainExtensions({
    enabled: (id) => !getConfig().disabledExtensions.includes(id),
    // before the window exists, a start-up notice; after, a toast
    notice: (text) => (win ? send('toast', text, 'error') : void startupNotices.push({ text, log: true })),
    takenCommands: () => [...DASHBOARD_COMMANDS, ...assistant.commandList().commands.filter((c) => c.source !== 'extension')].flatMap((c) => [c.name, ...(c.aliases ?? [])]),
    corvidFolder: corvidSelf.sourceDir
  })
  send('extensions:sockets', mainExtensionStates())
  // a theme extension switched on or off can change the theme on screen (#114)
  if (reload) applyChrome()
  // the board's command popup comes with Corvid's snapshot
  if (reload) assistant.changed()
}

const commandDeps: CommandDeps = {
  list: assistant.commandList,
  unavailable: assistant.unavailableCommand,
  post: (text, replyTo, command, channel) => postAsUser(text, replyTo, boardDeps, { untagged: false, command, channel }),
  notice: (text, replyTo) => boardPosted(boardPost({ author: 'corvid', text: cutText(text, 1800), replyTo })),
  ask: (m) => assistant.askFromBoard(m),
  runExtension: runExtensionCommand,
  config: getConfig,
  setConfig: applyConfig,
  reset: assistant.reset,
  interrupt: assistant.interrupt,
  quota: getQuota,
  liveQuota: assistant.getLiveQuota,
  // /discuss (#200): the command code passes origin 'window', the only origin the module accepts
  discuss: (o) => discussion.startDiscussion(o),
  discussStop: discussion.stopDiscussion
}

/**
 * The /discuss confirmation (#200): the same pattern as the Fable dialog, in Corvid's own window, and only the user's
 * Start click starts anything. Says what it costs (calls, model, a rough share of the usage windows) and where usage
 * is; when usage is over the gates (#93) the dialog carries that warning too, and the user may still start.
 */
async function confirmDiscussion(info: discussion.ConfirmInfo): Promise<boolean> {
  const fable = info.model === 'fable'
  const q = getQuota()
  const weight = modelWeight(info.model === 'default' ? (claudeDefaultModel() ?? 'opus') : info.model)
  // a panelist's reply is short: about 500 output tokens a call, a rough figure, not a measurement
  const tokens = info.calls * 500 * weight
  const share = (whole: number): string => `${(tokens * 100) / whole < 0.05 ? 'under 0.1' : ((tokens * 100) / whole).toFixed(1)}%`
  const usage = q && !q.error ? [q.session && `${q.session.label} ${q.session.pct}%`, ...q.weeks.map((w) => `${w.label} ${w.pct}%`)].filter(Boolean).join(', ') : 'unknown'
  const lines = [
    `Topic: ${info.topic}`,
    `${info.agents} agents, ${info.turns} turn${info.turns === 1 ? '' : 's'}: ${info.calls} short calls plus 1 for the summary, one at a time.`,
    `Panel: ${info.panel.join('; ')}.`,
    `Model: ${info.model === 'default' ? `your Claude Code default (${claudeDefaultModel() ?? 'not set'})` : choiceLabel(info.model as never)}.`,
    `Rough estimate: about ${share(WINDOW_TOKENS.fiveHour)} of the 5-hour window and ${share(WINDOW_TOKENS.week)} of the week (${Math.round(tokens / 1000)}k output tokens).`,
    `Usage now: ${usage}.`,
    'The panelists can only read files in this channel’s project; they can’t write, run anything, ping or use connections. /discuss stop ends it any time.',
    info.usageOver ? `\nOver the usage limit: ${info.usageOver}` : '',
    fable ? `\n${FABLE_WARNING}` : ''
  ].filter(Boolean)
  const options: Electron.MessageBoxOptions = {
    type: info.usageOver || fable ? 'warning' : 'question',
    title: 'Start a discussion?',
    message: `Start a discussion with ${info.agents} agents for ${info.turns} turn${info.turns === 1 ? '' : 's'}?`,
    detail: lines.join('\n'),
    buttons: [fable ? 'Start with Fable' : 'Start', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const shown = win && !win.isDestroyed() ? win : null
  if (shown && !shown.isVisible()) showWindow()
  const a = shown ? await dialog.showMessageBox(shown, options) : await dialog.showMessageBox(options)
  return a.response === 0
}

// Debug aid: DASH_SHOT_DIR=<dir> [DASH_SHOT_VIEWS=terminals|usage] captures each view to PNG, then quits.
async function debugShots(dir: string): Promise<void> {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  await wait(Number(process.env.DASH_SHOT_DELAY ?? 10_000))
  const size = /^(\d+)x(\d+)$/.exec(process.env.DASH_SHOT_SIZE ?? '')
  if (size) {
    win!.unmaximize()
    win!.setSize(Number(size[1]), Number(size[2]))
  }
  const steps = (process.env.DASH_SHOT_VIEWS ?? 'terminals').split('|')
  for (const [i, step] of steps.entries()) {
    const [view, js] = step.split('::')
    await win!.webContents.executeJavaScript(
      `window.__dash?.setState({ view: ${JSON.stringify(view)} }); setTimeout(() => { try { ${js ?? ''} } catch (e) { console.error(e) } }, 600)`
    )
    await wait(Number(process.env.DASH_SHOT_STEP ?? 1800))
    const img = await win!.webContents.capturePage()
    writeFileSync(join(dir, `${i}-${view}.png`), img.toPNG())
  }
  exitReason = 'screenshots done'
  quitting = true
  app.quit()
}

// ---------- assistant ----------

/** Freshest usage between `claude /usage` and the assistant's own rate-limit events. */
function freshestQuota(): { fiveHour?: number; week?: number; fable?: number; at: number; resets5h?: number } | null {
  // a test copy can fake usage for the usage-limit tests (#93): DASH_FAKE_USAGE=72,23 (5-hour, weekly), or "unknown"
  const fake = TEST ? process.env.DASH_FAKE_USAGE : undefined
  if (fake === 'unknown') return null
  if (fake) {
    const [fiveHour, week] = fake.split(',').map(Number)
    // Fable's weekly limit comes from the (fakeable, DASH_FAKE_FABLE) usage output: it isn't in the live events
    return { fiveHour, week, fable: fableWeek(getQuota()?.weeks)?.pct, at: Date.now(), resets5h: Date.now() + 90 * 60_000 }
  }
  const q = getQuota()
  const fable = q && !q.error ? fableWeek(q.weeks)?.pct : undefined
  const lq = assistant.getLiveQuota()
  const resets5h = q?.session?.resetsAtMs
  const fromUsage = q && !q.error ? { fiveHour: q.session?.pct, week: allModelsWeek(q.weeks)?.pct, fable, at: q.fetchedAt, resets5h } : null
  if (lq && (!fromUsage || lq.at > fromUsage.at)) return { ...lq, fable, resets5h }
  return fromUsage
}

/** A scan above the usage limit (#96): the same question as #93's, in Corvid's own message box. */
async function confirmScanOverLimit(text: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Usage limit',
    message: 'Scan this extension anyway?',
    detail: `${text}

A scan is two short classifier calls on your plan. Scan anyway?`,
    buttons: ['Scan anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const shown = win && !win.isDestroyed() ? win : null
  const a = shown ? await dialog.showMessageBox(shown, options) : await dialog.showMessageBox(options)
  return a.response === 0
}

/**
 * Starting an agent above the usage limit (#93): a native message box in Corvid's window (on its own when the window is
 * hidden, with a desktop notification), answered only by the user. Closing it or the timeout counts as Cancel.
 */
async function confirmOverLimit(r: ConfirmRequest): Promise<{ ok: boolean; dontAsk: boolean; timedOut: boolean }> {
  const stop = new AbortController()
  let timedOut = false
  // a test copy can shorten the wait to test the timeout: DASH_CONFIRM_TIMEOUT_SEC=<n>
  const testSec = TEST ? Number(process.env.DASH_CONFIRM_TIMEOUT_SEC) : 0
  const timer = setTimeout(
    () => {
      timedOut = true
      stop.abort()
    },
    testSec > 0 ? testSec * 1000 : r.timeoutMs
  )
  const shown = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() ? win : null
  if (!shown || !win?.isFocused()) {
    if (getConfig().notifications && canNotify()) {
      const n = new Notification({ title: `Start ${r.taskId ? `#${r.taskId}` : r.taskTitle} above the usage limit?`, body: 'Corvid is asking before it starts an agent. Answer in its dialog.', icon })
      n.on('click', () => showWindow())
      n.show()
    }
  }
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Usage limit',
    message: `Start ${r.taskId ? `#${r.taskId} ` : ''}${r.taskTitle.slice(0, 80)} anyway?`,
    detail: `${r.text}\n\nStart anyway?`,
    buttons: ['Start anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    checkboxLabel: "Don't ask again until usage resets",
    checkboxChecked: false,
    signal: stop.signal
  }
  try {
    const a = shown ? await dialog.showMessageBox(shown, options) : await dialog.showMessageBox(options)
    return { ok: !timedOut && a.response === 0, dontAsk: !timedOut && a.response === 0 && a.checkboxChecked, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

/** The soft budget cap's question while a build runs (#97): a native message box in Corvid's window, answered only by
 *  the user. Closing it counts as Continue (the next ask is one estimate later); only picking Stop ends the build. */
async function askBudgetCap(title: string, text: string): Promise<boolean> {
  const shown = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() ? win : null
  if ((!shown || !win?.isFocused()) && getConfig().notifications && canNotify()) {
    const n = new Notification({ title: 'A build passed its budget cap', body: 'Corvid is asking whether to continue. Answer in its dialog.', icon })
    n.on('click', () => showWindow())
    n.show()
  }
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Budget cap',
    message: title,
    detail: text,
    buttons: ['Continue', 'Stop the build'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const a = shown ? await dialog.showMessageBox(shown, options) : await dialog.showMessageBox(options)
  return a.response === 0
}

async function startAssistant(): Promise<void> {
  const endpoint = await startMcp(
    agentPing.gateTools(assistantTools({
      sessions: () => [...sessions.values()],
      live: () => liveSessions,
      activity: (id) => activity.get(id),
      config: getConfig,
      home: homedir(),
      quota: getQuota,
      liveQuota: assistant.getLiveQuota,
      liveTokens: () => liveTokens,
      stats: () => stats,
      search: (q) => ask('search', { q }),
      transcript: (id, limit) => ask('transcript', { id, limit }),
      show: (target) => send('nav:show', target),
      request: assistant.currentRequest,
      requestId: assistant.currentRequestId,
      noteLeft,
      playTour: (tour) => send('tour:play', tour),
      toursDir
    }).concat(boardTools({ kind: 'assistant' }, boardDeps), taskFileTools({ kind: 'assistant' })),
      // a turn an agent's ping started (#195) can only read, answer and add notes: refused here, at the tool, not by asking
      assistant.restrictedTurn
    )
  )
  initWorkers(endpoint)
  wake.initWake({
    running: (name) => boardAgents().some((a) => a.live && nameKey(a.name) === nameKey(name)),
    note: (text, tone) => {
      assistant.note(text, tone)
      send('toast', text, tone === 'info' ? 'info' : 'error')
    }
  })
  agentPing.initAgentPing({
    config: () => {
      const c = getConfig()
      return { on: c.agentPings, wake: c.agentPings && c.agentPingWake, limits: c.agentPingLimits }
    },
    running: (name) => boardAgents().some((a) => a.live && nameKey(a.name) === nameKey(name)),
    taskOf: (name) => workers.taskOfAgent(name),
    deliverAgent: (m, who) => invoke.agentPinged(m, who),
    deliverCorvid: (m) => assistant.askFromBoard(m),
    wakeBlocker: (taskId) => workers.agentWakeBlocker(taskId),
    wake: (taskId, prompt) => workers.resumeWorker(taskId, prompt),
    mark: (id, who, mark) => setPing(id, who, mark),
    notice: (text, replyTo) => {
      try {
        const parent = replyTo !== undefined ? boardMessage(replyTo) : undefined
        boardPosted(boardPost({ author: 'corvid', taskId: parent?.taskId, agentName: parent?.agentName, text: cutText(text, 1800), replyTo }))
      } catch (e) {
        console.error('board post failed', e)
      }
    },
    dropPending: () => {
      invoke.dropAgentPings()
      assistant.dropAgentAsks()
    }
  })
  invoke.initInvoke({
    find: (name) => {
      const t = pty.listTerminals().find((x) => x.exited === undefined && x.agentName && nameKey(x.agentName) === nameKey(name))
      if (!t) return null
      const l = liveSessions.find((s) => s.termId === t.termId)
      const w = workers.runningWorkers().find((x) => x.termId === t.termId)
      return { termId: t.termId, pid: l?.pid, status: l?.status, statusUpdatedAt: l?.statusUpdatedAt, taskId: w?.taskId }
    },
    write: pty.write,
    lastOutput: pty.lastOutput,
    delivered: (name) => workers.addressed([name])
  })
  assistant.setBoardHooks({
    prompt: (msgs) =>
      msgs[0]?.author === 'agent' ? agentPing.corvidPingPrompt(msgs[0]) : corvidPrompt(msgs, getConfig().userName, (id) => projectStore.getProject(id)?.name),
    reply: (id, text, actions) => void postCorvidReply(id, text, actions, boardDeps),
    seen: (id) => noteReadBy([id], 'assistant'),
    // Corvid's warnings and errors as a dashboard notice; a worker stopped at the time limit has its own announcement
    notice: (text, replyTo) => {
      if (/hit the \d+-minute limit/.test(text)) return
      try {
        boardPosted(boardPost({ author: 'corvid', text: cutText(text, 1800), ...(replyTo !== undefined && boardMessage(replyTo) ? { replyTo } : {}) }))
      } catch (e) {
        console.error('board notice failed', e)
      }
    }
  })
  assistant.initAssistant(
    endpoint,
    (snap) => {
      send('assistant', snap)
      proposalsChanged(snap.proposals)
    },
    (q) => workers.checkUsage(q.fiveHour, q.week)
  )
}

/** A worker proposal waiting for approval: a desktop notification when the window isn't in front (the window
 *  itself shows a toast and the "Awaiting your approval" area in the Agents view). Each proposal notifies once. */
const proposalsSeen = new Set<string>()
function proposalsChanged(proposals: Proposal[]): void {
  const fresh = proposals.filter((p) => !proposalsSeen.has(p.id))
  for (const p of fresh) proposalsSeen.add(p.id)
  if (!fresh.length || !getConfig().notifications || !canNotify() || (win?.isVisible() && win.isFocused())) return
  const p = fresh[0]
  const n = new Notification({ title: 'A worker awaits your approval', body: `#${p.taskId} ${p.taskTitle}`, icon })
  n.on('click', () => {
    showWindow()
    send('nav:show', { view: 'terminals' })
  })
  n.show()
}

/** Notes are kept per project, not per folder (3/5): any folder of a project stands for its primary folder. */
function projectHome(path: string): string {
  return projectStore.projectFolder(projectStore.projectIdForPath(path)) ?? path
}

/** For a worker's create_note: a project by name or path. */
function findProjectPath(q: string): string | undefined {
  const p = projectStore.resolveProject(q)
  return p ? projectStore.projectFolder(p.id) : undefined
}

/** A worker's board tools with its clock under every result, so it never has to guess the time (#81). */
const withClock = (tools: ToolDef[], workerId: string): ToolDef[] =>
  tools.map((t) => ({
    ...t,
    run: async (args) => {
      const out = await t.run(args)
      const clock = workers.clockNote(workerId)
      return typeof out === 'string' && clock ? `${out}\n${clock}` : out
    }
  }))

/** time_left: how much of its time limit a worker has used, measured by the dashboard. */
const clockTool = (workerId: string): ToolDef => ({
  name: 'time_left',
  description:
    'How long you have before the dashboard stops this session: minutes of work so far and minutes left, measured by the dashboard (time the computer sleeps or you wait for the user does not count). ' +
    'You cannot tell the time yourself, so call this before you cut work short, skip a step or say you are running out of time.',
  input: {},
  readOnly: true,
  run: () => workers.clockNote(workerId) ?? 'This session is not running as a worker, so no time limit applies.'
})

function initWorkers(endpoint: McpEndpoint): void {
  workers.initWorkers({
    access: (w) => {
      const build = install.isBuildTask(w.taskId)
      // a verify build (#101) gets the same tools and deny rules, on its clean throwaway branch
      const verifying = !build && verify.isVerifyTask(w.taskId)
      // an agent resolving a Remove or Disable conflict (#117): its own report tool, git prompt and deny rules
      const resolving = !build && !verifying && resolveConflict.isResolveTask(w.taskId)
      // the board voice is fixed when a worker starts; changing the setting applies to the next ones
      const voice = effectiveVoice(getConfig().boardVoice, getConfig().boardVoiceCustom)
      const granted = grantWorker(endpoint, w.id, [
        {
          tools: noteTools(
            { kind: 'agent', agentName: w.agentName, taskId: w.taskId, project: projectHome(w.project), request: () => w.request },
            { findProject: (q) => findProjectPath(q), left: noteLeft }
          ),
          allowed: ['list_notes', 'read_note', 'create_note', 'append_to_note', 'update_note', 'delete_note'],
          prompt: `${NOTES_PROMPT} Your note tools are mcp__corvid__list_notes, read_note, create_note, append_to_note, update_note and delete_note.`
        },
        {
          tools: [...withClock(boardTools({ kind: 'agent', agentName: w.agentName, taskId: w.taskId, avatar: w.avatar, voice }, boardDeps), w.id), clockTool(w.id)],
          allowed: ['read_messages', 'post_message', 'time_left'],
          prompt: `${workerBoardPrompt({ ...w, voice, customVoice: getConfig().boardVoiceCustom, userName: getConfig().userName, pings: { on: getConfig().agentPings, wake: getConfig().agentPings && getConfig().agentPingWake } })} Your board tools are mcp__corvid__read_messages and post_message.`,
          reminder: WORKER_BOARD_REMINDER
        },
        // files the user attached to its task (#187): read through this one tool, only its own task's
        {
          tools: taskFileTools({ kind: 'agent', taskId: w.taskId }),
          allowed: ['read_task_file'],
          prompt:
            taskFilesPrompt(listTasks().find((t) => t.id === w.taskId) ?? { id: w.taskId }) ||
            `Files the user attaches to your task later can be listed and read with mcp__corvid__read_task_file. ${TASK_FILES_SAFETY}`
        },
        remote.remoteAccess({ project: w.project, agent: `worker #${w.taskId}` }),
        connectors.connectionsAccess({
          project: w.project,
          agent: `worker #${w.taskId}`,
          cwd: w.cwd,
          // upload (#168) sends files only from its worktree and, once Corvid has seen its session, that session's scratchpad
          uploadRoots: () => {
            const sessionId = workers.listWorkers().find((x) => x.id === w.id)?.sessionId
            const pad = sessionId ? scratchpadDir(w.cwd, sessionId) : undefined
            return [w.cwd, ...(pad ? [pad] : [])]
          }
        }),
        drafts.draftAccess({ project: w.project, agent: `worker #${w.taskId}`, agentName: w.agentName, taskId: w.taskId }),
        extensionWorkerAccess({ project: w.project, agent: `worker #${w.taskId}`, taskId: w.taskId }),
        // an extension build (#98) gets submit_build_report and its own git prompt instead of merge_task_branch
        build ? install.buildAccess(w.taskId, w.branch) : verifying ? verify.verifyAccess(w.taskId, w.branch) : resolving ? resolveConflict.resolveAccess(w.taskId, w.branch) : (w.git ?? null),
        // and report_progress for the progress display (#108), bound to its own build
        build ? buildProgress.progressAccess(w.taskId, w.id) : null
      ])
      // files agents may not read (#91), with project rules relative to where it runs (its worktree or the folder);
      // an extension build's file tools are also denied the protected paths and the main checkout (#98)
      const extra = build
        ? install.buildDeny(w.taskId, w.cwd, w.branch?.repo ?? w.project)
        : verifying
          ? verify.verifyDeny(w.taskId, w.cwd, w.branch?.repo ?? w.project)
          : resolving
            ? resolveConflict.resolveDeny(w.taskId, w.cwd)
            : []
      return { ...granted, args: [...granted.args, ...agentSettingsArgs(w.project, w.cwd, undefined, extra)] }
    },
    gitChanged: (repo) => void refreshPath(repo),
    ended: (w) => {
      lineage.workerEnded(w)
      install.workerEnded(w.taskId, w.reason)
      verify.verifyEnded(w.taskId, w.reason)
      resolveConflict.workerEnded(w.taskId, w.reason)
      revokeWorker(endpoint, w.id)
      remote.cancelForAgent(`worker #${w.taskId}`)
      connectors.dropResultsOf(`worker #${w.taskId}`)
    },
    announce: (w, text) => {
      try {
        boardPosted(boardPost({ author: 'corvid', agentName: w.agentName, taskId: w.taskId, text }))
      } catch (e) {
        console.error('board post failed', e)
      }
    },
    waitingOnUser: (w) =>
      remote.listApprovals().some((a) => a.agent === `worker #${w.taskId}`) || unansweredQuestion(w) || (!!w.agentName && invoke.holding(w.agentName)),
    awaitingApproval: (w) => remote.listApprovals().some((a) => a.agent === `worker #${w.taskId}`),
    quota: freshestQuota,
    fableProblem,
    confirmOverLimit,
    refreshQuota: async () => void (await fetchQuota(onQuota)),
    // a worker works in the task's project's folder, looked up by id (#73)
    task: (id) => {
      const t = listTasks().find((x) => x.id === id)
      return t && { ...t, project: taskFolder(t) }
    },
    folderNote: (t) => {
      const p = t.projectId ? projectStore.getProject(t.projectId) : undefined
      if (!p || p.folders.length < 2) return undefined
      const f = p.folders.find((x) => projectKey(x.path) === projectKey(t.project ?? ''))
      if (!f) return undefined
      return `#${t.id} works in ${p.name}'s ${folderName(f)} folder${t.folder ? '' : ' (the primary one; no folder was chosen)'}.`
    },
    moveTask: (id, column) => void updateTask(id, { column }),
    changed: assistant.changed,
    note: (text, tone) => {
      assistant.note(text, tone)
      send('toast', text, tone === 'info' ? 'info' : 'error')
    }
  })
}

// ---------- lifecycle ----------

app.on('second-instance', showWindow)

app.whenReady().then(() => {
  if (!gotLock) return
  if (!TEST) trayProbe = hasTray().then((ok) => (trayShown = ok))
  // macOS GUI apps start with a minimal PATH: merge the login shell's into process.env for every spawn (#152)
  void loadLoginEnv()
  // a restore asked for before the restart, before anything reads the files (#85)
  const restored = applyPendingRestore()
  if (restored) startupNotices.push({ text: restored })
  const lastRun = checkLastRun()
  if (lastRun) startupNotices.push({ text: lastRun, log: true })
  getConfig() // loads (and repairs) config.json, if nothing has yet
  if (configRepairs().length) startupNotices.push({ text: `Settings repaired: ${configRepairs().join('; ')}.` })
  initBackups()
  pty.initPty(send)
  initProjects((updates) => send('git', updates))
  projectStore.initProjectStore({
    changed: (state) => {
      send('projects', state)
      fillProjectIds()
      connectorStore.syncRemote()
      unfiled.rebuild()
    },
    sessions: () => [...sessions.values()],
    agentSessions: workers.agentSessionIds
  })
  unfiled.initUnfiled({ changed: (state) => send('unfiled', state), sessions: () => [...sessions.values()] })
  extensions.initExtensions((list) => send('extensions', list))
  // what the packaging wizard (#100) and Share's final leak check (#101) look for: this PC's projects, folders and connections
  const extensionLeaks = (): { words: string[]; hosts: string[] } => {
    // a project called "Notes" or "Board" would flag every extension, so names that are Corvid's own words don't count
    const common = /^(?:corvid|dashboard|board|tasks?|notes?|agents?|settings|projects?|usage|extensions?|connections?|sessions?|live|test|tests|demo|sample|example|app)$/i
    const projects = projectStore.listProjects().filter((p) => !p.builtin && !common.test(p.name.trim()))
    const conns = connectorStore.listConnections()
    const hosts = conns.flatMap((c) => Object.values(c.config).flatMap((v) => (typeof v === 'string' ? [...v.matchAll(/(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((m) => m[1]) : [])))
    return { words: [...projects.map((p) => p.name), ...projects.flatMap((p) => p.folders.map((f) => f.path)), ...conns.map((c) => c.name)], hosts }
  }
  packager.initPackager({
    sourceDir: () => {
      const p = projectStore.builtinProject()
      const dir = p && projectStore.projectFolder(p.id)
      return dir && projectStore.isCorvidSource(dir) ? dir : undefined
    },
    ledgerIds: () => extensions.list().map((r) => r.id),
    task: (id) => listTasks().find((t) => t.id === id),
    boardPosts: (taskId) => listMessages().filter((m) => m.taskId === taskId || m.text.includes(`#${taskId}`)).map((m) => m.text),
    minutesFor: () => undefined,
    // the board name from Settings, or nothing when it's still the default "user"
    userName: () => (hasUserName(getConfig().userName) ? userLabel(getConfig().userName) : ''),
    claudePath: () => getConfig().claudePath,
    leaks: extensionLeaks,
    build: () => {
      const b = corvidSelf.buildInfo()
      return { version: b.version, commit: b.commit }
    },
    blocker: (label) => workers.extraAgentBlocker(label),
    detail: (key) => {
      const d = extensions.detail(key)
      return d?.text ? { text: d.text, id: d.record.id, version: d.record.version } : null
    },
    save: (text, replaceKey, features) => extensions.saveCreated(text, replaceKey, features),
    fiveHour: () => freshestQuota()?.fiveHour,
    changed: (s) => send('packager', s)
  })
  extensionScan.initScan({
    get: extensions.forScan,
    setScan: extensions.setScan,
    claude: async () => (await resolveClaude(getConfig().claudePath))?.path ?? null,
    model: () => getConfig().scanModel ?? 'haiku'
  })
  extensionScan.settleInterrupted(extensions.list())
  budget.initBudget({
    sessions: () => [...sessions.values()],
    quota: freshestQuota,
    askCap: (title, text) => buildProgress.whileCapAsk(() => askBudgetCap(title, text)),
    notice: (text, taskId) => {
      try {
        boardPosted(boardPost({ author: 'corvid', ...(taskId !== undefined ? { taskId } : {}), text: cutText(text, 1800) }))
      } catch (e) {
        console.error('board notice failed', e)
      }
    }
  })
  // the install pipeline (#98): starts only from the user's Confirm (#97); merging only from the review screen
  const buildTokens = (taskId: number): number | undefined => {
    const sid = workers.listWorkers().find((w) => w.taskId === taskId)?.sessionId
    return sid ? sessions.get(sid)?.tokens.output : undefined
  }
  install.initInstall({
    corvid: () => {
      const p = projectStore.builtinProject()
      const dir = corvidSelf.sourceDir()
      return p && dir ? { projectId: p.id, folder: dir } : undefined
    },
    setup: () => corvidSelf.checkSetup(),
    agentsIn: (folder) => workers.runningWorkers().filter((w) => w.project.toLowerCase() === folder.toLowerCase()).map((w) => w.agentName ?? `#${w.taskId}`),
    createTask: (t) => createTask({ ...t, column: 'next' }),
    removeTask: (id) => void removeTask(id),
    startWorker: (taskId, instructions) => workers.startWorker(taskId, instructions, undefined, true),
    resumeWorker: (taskId, message) => workers.resumeWorker(taskId, message),
    stopWorker: (id, reason) => void workers.stopWorker(id, reason),
    workerRunning: (taskId) => workers.runningWorkers().some((w) => w.taskId === taskId),
    outputTokens: buildTokens,
    watch: (o) => budget.watchBuild({ ...o, outputTokens: () => buildTokens(o.taskId) }),
    notice: (text, taskId) => {
      try {
        boardPosted(boardPost({ author: 'corvid', ...(taskId !== undefined ? { taskId } : {}), text: cutText(text, 1800) }))
      } catch (e) {
        console.error('board notice failed', e)
      }
    },
    gitChanged: (repo) => void refreshPath(repo),
    buildCommit: () => corvidSelf.buildInfo().commit
  })
  lifecycle.initLifecycle({
    corvid: () => {
      const p = projectStore.builtinProject()
      const dir = corvidSelf.sourceDir()
      return p && dir ? { projectId: p.id, folder: dir } : undefined
    },
    agentsIn: (folder) => workers.runningWorkers().filter((w) => w.project.toLowerCase() === folder.toLowerCase()).map((w) => w.agentName ?? `#${w.taskId}`),
    disabledIds: () => getConfig().disabledExtensions,
    setDisabledIds: (ids) => void applyConfig({ disabledExtensions: ids }),
    dataDir: () => app.getPath('userData'),
    gitChanged: (repo) => void refreshPath(repo)
  })
  // Resolve with an agent (#117): a conflicted Remove or Disable, resolved on its branch after the user's Confirm
  resolveConflict.initResolve({
    createTask: (t) => createTask({ ...t, column: 'next' }),
    removeTask: (id) => void removeTask(id),
    taskExists: (id) => listTasks().some((t) => t.id === id),
    corvidProjectId: () => projectStore.builtinProject()?.id,
    startWorker: (taskId, instructions) => workers.startWorker(taskId, instructions, undefined, true),
    resumeWorker: (taskId, message) => workers.resumeWorker(taskId, message),
    stopWorker: (id, reason) => void workers.stopWorker(id, reason),
    workerRunning: (taskId) => workers.runningWorkers().some((w) => w.taskId === taskId),
    estimate: (tier, chars) => budget.estimateResolve(tier, chars),
    prompt: (e) => budget.resolvePrompt(e),
    watch: (o) => budget.watchBuild({ ...o, outputTokens: () => buildTokens(o.taskId) }),
    notice: (text, taskId) => {
      try {
        boardPosted(boardPost({ author: 'corvid', ...(taskId !== undefined ? { taskId } : {}), text: cutText(text, 1800) }))
      } catch (e) {
        console.error('board notice failed', e)
      }
    },
    gitChanged: (repo) => void refreshPath(repo),
    dataDir: () => app.getPath('userData')
  })
  // verify and share (#101): a verify build on a clean throwaway copy, never merged; Share only saves or copies the text
  verify.initVerify({
    corvid: () => {
      const p = projectStore.builtinProject()
      const dir = corvidSelf.sourceDir()
      return p && dir ? { projectId: p.id, folder: dir } : undefined
    },
    estimateFor: (key) => budget.estimateFor(key),
    usageWarning: () => budget.usageWarning(),
    capMultiple: () => getConfig().extensionCapMultiple,
    createTask: (t) => createTask({ ...t, column: 'next' }),
    removeTask: (id) => void removeTask(id),
    startWorker: (taskId, instructions) => workers.startWorker(taskId, instructions, undefined, true),
    stopWorker: (id, reason) => void workers.stopWorker(id, reason),
    workerRunning: (taskId) => workers.runningWorkers().some((w) => w.taskId === taskId),
    watch: (o) => budget.watchBuild({ ...o, outputTokens: () => buildTokens(o.taskId) }),
    notice: (text, taskId) => {
      try {
        boardPosted(boardPost({ author: 'corvid', ...(taskId !== undefined ? { taskId } : {}), text: cutText(text, 1800) }))
      } catch (e) {
        console.error('board notice failed', e)
      }
    },
    leaks: () => {
      const l = extensionLeaks()
      let account = ''
      try {
        account = userInfo().username
      } catch {
        /* no account name */
      }
      const name = hasUserName(getConfig().userName) ? userLabel(getConfig().userName) : ''
      return { words: [...l.words, account, name, hostname(), homedir()].filter(Boolean), hosts: l.hosts }
    },
    savePath: async (name) => {
      const r = await dialog.showSaveDialog(win!, { title: 'Share the extension as a .corvid file', defaultPath: name, filters: [{ name: 'Corvid extension', extensions: ['corvid'] }] })
      return r.canceled ? undefined : r.filePath
    },
    copy: (text) => clipboard.writeText(text)
  })
  budget.onInstallConfirmed((key, estimate) => {
    void install.startBuild(key, estimate).then((r) => {
      if ('error' in r) send('toast', `The build didn't start: ${r.error}`, 'error')
    })
    return true
  })
  initTasks((tasks) => send('tasks', tasks), {
    resolve: (q) => {
      const p = projectStore.resolveProject(q)
      const folder = p && projectStore.projectFolder(p.id)
      return p && folder ? { id: p.id, folder } : undefined
    },
    forPath: projectStore.projectIdForPath,
    folder: projectStore.projectSubfolder
  })
  initNotes((notes) => send('notes', notes))
  lineage.initLineage(app.getPath('userData'))
  // the Context cloud hears about new events while it is open (#210): batched, about once a second
  lineage.setLineageSink((events) => send('lineage:appended', events))
  corvidSelf.initCorvidSelf()
  initBoard(join(app.getPath('userData'), 'board'), { keepDays: () => getConfig().boardKeepDays, changed: (b) => send('board', b), projectOfTask: taskChannel })
  // /discuss (#200): panelists post through board.post directly, never the agents' tool and its limits
  discussion.initDiscussion({
    post: boardPost,
    posted: boardPosted,
    messages: listMessages,
    setMark: setDiscussion,
    run: async (call) => {
      const bin = await resolveClaude(getConfig().claudePath)
      if (!bin) return { error: CLAUDE_NOT_FOUND }
      return discussion.runHeadless(call, bin.path, app.getPath('temp'))
    },
    confirm: confirmDiscussion,
    usageOver: (model) => workers.usageOverText(model),
    usageBlocks: () => getConfig().limits.overLimit === 'block',
    model: () => getConfig().workerModel,
    projectFolder: (channel) => (channel ? projectStore.projectFolder(channel) : undefined),
    // the panel gets the full thesis unless the discussion is in another project's channel (#202)
    corvidTopic: (channel) => !channel || channel === projectStore.builtinProject()?.id,
    takenNames: agentNamesInUse,
    takenLooks: () => workers.runningWorkers().flatMap((w) => (w.avatar ? [w.avatar] : [])),
    createNote: (name, text, project) => createNote({ name, text, project }, { author: 'user' }),
    userName: () => getConfig().userName
  })
  // one that was running when the app closed ends with a calm notice; nothing resumes
  discussion.cancelLeftovers()
  remote.initRemote({ changed: () => send('remote', remoteSnapshot()), approvalRequested: onApprovalRequested })
  connectorStore.initConnectorStore({ projectIdForPath: projectStore.projectIdForPath, remoteSystems: listSystems, remoteSecret })
  connectors.initConnectors({
    projectIdForPath: projectStore.projectIdForPath,
    changed: () => send('remote', remoteSnapshot()),
    pageChars: () => getConfig().connectorPageChars
  })
  drafts.initDrafts({
    projectIdForPath: projectStore.projectIdForPath,
    projectName: (id) => projectStore.getProject(id)?.name,
    enabled: () => getConfig().agentDrafts !== false,
    arrived: onDraftArrived,
    changed: () => send('remote', remoteSnapshot())
  })
  loadExtensionSockets()
  clearStaleGrants()
  registerRemoteIpc()
  registerConnectionsIpc()
  void startAssistant()
  registerIpc()
  initVoice({ send, refreshLogin: () => fetchQuota(onQuota) })
  startIndexer()
  createWindow()
  // the launch-time update check (#143): a background fetch of the public repo, notify only
  startUpdateCheck((v) => send('update:view', v))
  // the welcome back on the board (#122): decided now, posted when the window first shows
  if (win)
    welcomeOnShow(win, {
      config: getConfig,
      doing: () => listTasks().filter((t) => t.column === 'doing').length,
      approvals: () => drafts.draftsWaiting() + extensions.list().filter((r) => r.status === 'needs-review').length,
      fiveHour: () => freshestQuota()?.fiveHour,
      commit: () => corvidSelf.buildInfo().commit
    })
  // Follow system: the renderer swaps its own colours, the native frame needs telling
  nativeTheme.on('updated', applyChrome)
  createTray()
  startLive()
  // a test copy doesn't run `claude /usage`, which writes to ~/.claude
  if (!TEST) startQuotaPolling(onQuota)
  if (!registerHotkey(getConfig().hotkey))
    startupNotices.push({ text: hotkeyFailText(getConfig().hotkey, process.platform, process.env) })
  applyLoginItem()
  startControlPort(
    () => win,
    () => ((exitReason = 'quit by its test script'), (quitting = true), app.quit())
  )
  if (usesAppUserModelId()) ensureStartMenuShortcut()
  if (process.env.DASH_SHOT_DIR) void debugShots(process.env.DASH_SHOT_DIR)
})

app.on('before-quit', () => {
  if (gotLock) cleanExit(exitReason)
  quitting = true
  assistant.shutdown()
  packager.shutdown()
  shutdownVoice()
  pty.killAll()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  /* stay in tray */
})
// macOS: closing the window only hides it (as on Windows), and clicking the Dock icon brings it back. Cmd+Q and the
// Dock's Quit go through before-quit, which lets the window close. The activate at launch comes before the window is
// ready and is ignored, so a --hidden start stays hidden.
app.on('activate', () => {
  if (windowReady) showWindow()
})
