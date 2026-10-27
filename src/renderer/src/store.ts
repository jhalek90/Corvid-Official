import { useSyncExternalStore } from 'react'
import type {
  AppConfig,
  ProjectRecord,
  ProjectsState,
  UnfiledState,
  AssistantSnapshot,
  ClaudeBinary,
  CrowLook,
  GitInfo,
  Task,
  IndexProgress,
  LaunchMode,
  LiveSession,
  LiveTokens,
  Note,
  SessionActivity,
  SessionSummary,
  ShellOption,
  TerminalInfo,
  UsageQuota,
  UsageStats
} from '@shared/types'
import type { BoardSnapshot } from '@shared/board'
import type { ImportOutcome } from '@shared/extensions'
import { taskFromMessage, type MessageAbout } from '@shared/taskFromMessage'
import { api, type RemoteSnapshot } from './api'
import { activeTheme, applyTheme, onOsThemeChange, osDark } from './theme'
import { isExtensionThemeId, isThemeId, themeDef, wantedTheme, type ThemeId } from '@shared/themes'
import { themeGoneReason } from './extensionSockets'
import { applyCrowLook } from './crowLook'
import { baseName } from '@shared/projects'
import { primaryFolder } from '@shared/projectList'
import {
  NARROW_MAIN,
  VIEWS,
  closeTab,
  findPane,
  focusedView,
  insertTab,
  loadLayout,
  paneOf,
  pruneShellTabs,
  pruneTermTabs,
  reveal,
  revealTerm,
  saveLayout,
  shellTab,
  shellTabs,
  termTab,
  termTabs,
  visibleShells,
  type PaneLayout,
  type Placement,
  type Room
} from './panes'
import { focusTerm, focusedTerm } from './components/AgentTerminal'

/** 'terminals' is the Agents view; the id predates the rename and is kept for saved layouts. */
export type View = 'tasks' | 'terminals' | 'usage' | 'projects' | 'notes' | 'settings' | 'connections' | 'extensions' | 'docs' | 'lineage'

export interface State {
  booted: boolean
  /** the theme on screen: the picked one, or the light/dark pick that matches the OS */
  theme: ThemeId
  sessions: Record<string, SessionSummary>
  activity: Record<string, SessionActivity>
  /** project key -> git status (null = no repo) */
  git: Record<string, GitInfo | null>
  /** project page being shown inside the Projects view */
  selectedProject?: string
  tasks: Task[]
  notes: Note[]
  /** the note open in the Notes view's editor */
  openNoteId?: string
  board: BoardSnapshot
  /** narrow Agents view: which of the two it shows */
  agentsPane: 'cards' | 'board'
  assistant: AssistantSnapshot
  explorerOpen: boolean
  /** folder the file explorer is showing; falls back to the newest project */
  explorerRoot?: string
  sideTermOpen: boolean
  /** the Connections tab (#88): which area it shows, and a connection to open */
  /** the Extensions tab (#95): the extension whose page is open, and whether to ask "Review and install?" */
  extensionsFocus?: { key?: string; review?: boolean }
  /** the Docs view (#188): the page open, like "settings/reference.md#profile" */
  docsPage?: string
  /** the outcome of the last import, shown until dismissed; conflicts wait here for the user's choice */
  extensionImports?: ImportOutcome[]
  connectionsFocus?: { area?: 'connections' | 'add' | 'connectors' | 'proposals' | 'activity'; connectionId?: string; projectId?: string }
  /** active tab in the sidebar terminal panel (sideActive() falls back when it has moved to a pane) */
  sideTermId?: string
  /** task editor dialog: an existing task, or a draft for a new one */
  taskEditor?: Partial<Task>
  progress: IndexProgress
  stats: UsageStats | null
  liveTokens: LiveTokens | null
  liveSessions: LiveSession[]
  quota: UsageQuota | null
  quotaLoading: boolean
  terminals: TerminalInfo[]
  config: AppConfig | null
  /** the user's profile picture as a blob: URL, already decoded; null shows the letter marker */
  userAvatar: string | null
  remote: RemoteSnapshot
  claude: ClaudeBinary | null
  claudeDefaultModel?: string
  home: string
  /** the user's project list (#73) and what's known about session folders */
  projects: ProjectsState
  /** the project switcher's choice (#77): the project id the views narrow to; unset is All projects (scope.ts) */
  scope?: string
  /** the Unfiled inbox (#74): session folders that match no project */
  unfiled: UnfiledState
  /** the focused pane's view; setting it reveals that view in the panes */
  view: View
  layout: PaneLayout
  /** session picked out in its project page's session list */
  selectedId?: string
  /** agents whose terminal is open inside their card, oldest first; at most MAX_INLINE */
  inlineTerms: string[]
  paletteOpen: boolean
  conflict?: { session: SessionSummary; live: LiveSession }
  /** the Locate / Move folder dialog (4/5), for one folder of a project */
  relocating?: { projectId: string; path: string; to?: string }
  toast?: Toast
}

export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

export function toggleExplorer(open?: boolean): void {
  const next = open ?? !state.explorerOpen
  writeLocal('explorerOpen', next ? '1' : '0')
  setState({ explorerOpen: next })
}

export function setExplorerRoot(path: string): void {
  writeLocal('explorerRoot', path)
  setState({ explorerRoot: path })
}

export function toggleSideTerm(open?: boolean): void {
  const next = open ?? !state.sideTermOpen
  writeLocal('sideTermOpen', next ? '1' : '0')
  setState({ sideTermOpen: next })
}


let shellList: Promise<ShellOption[]> | undefined
export const loadShells = (): Promise<ShellOption[]> => (shellList ??= api.shells().catch(() => []))

/** Shell picked last in the sidebar terminal; the "+" button opens this one. */
export function preferredShell(): string | undefined {
  return readLocal('sideShell') ?? undefined
}

/** Picking a shell from the menu also makes it the default for next time. */
export function pickShell(shellId: string): void {
  writeLocal('sideShell', shellId)
  void newSideShell(shellId)
}

let spawningSide = false

/**
 * Open a general shell (home folder unless cwd is given): in the side panel, showing it, or with `paneId`
 * as a tab in that pane (#111).
 */
export async function newSideShell(shellId = preferredShell(), cwd?: string, paneId?: string): Promise<void> {
  if (spawningSide) return
  spawningSide = true
  try {
    const shells = await loadShells()
    const shell = shells.find((x) => x.id === shellId) ?? shells[0]
    if (!shell) throw new Error('No shell found on this machine')
    // Number repeats of the same shell: PowerShell, PowerShell (2), …
    const same = state.terminals.filter(
      (t) => t.side && t.exited === undefined && (t.title === shell.label || t.title.startsWith(`${shell.label} (`))
    ).length
    const title = same ? `${shell.label} (${same + 1})` : shell.label
    const term = await api.sideShell({ shellId: shell.id, cwd, title })
    recentShell = term.termId
    const terminals = (s: State): TerminalInfo[] => (s.terminals.some((t) => t.termId === term.termId) ? s.terminals : [...s.terminals, term])
    if (paneId && findPane(state.layout, paneId)) {
      setState((s) => ({ terminals: terminals(s), layout: insertTab(s.layout, paneId, shellTab(term.termId)) }))
      return
    }
    setState((s) => ({ terminals: terminals(s), sideTermId: term.termId }))
    toggleSideTerm(true)
  } catch (e) {
    toast(String((e as Error).message ?? e), 'error')
  } finally {
    spawningSide = false
  }
}

// ---------- the general shells (#111) ----------
// A shell lives in one place at a time: in a pane, as a 'shell:<id>' tab, or (without a tab) docked in the
// side panel, which is where new ones open. Moving it only moves its xterm, so the process never restarts.

/** the shell used last (focused, opened or revealed), for Ctrl+` to bring back */
let recentShell: string | undefined
/** what had the keyboard before Ctrl+` gave it to a shell, for the next Ctrl+` to hand it back */
let beforeShell: HTMLElement | null = null

export const noteShell = (termId: string): void => void (recentShell = termId)

/** The shells docked in the side panel: every shell without a tab in the panes. */
export function dockedShells(s: Pick<State, 'terminals' | 'layout'>): TerminalInfo[] {
  const tabbed = new Set(shellTabs(s.layout))
  return s.terminals.filter((t) => t.side && !tabbed.has(t.termId))
}

/** The side panel's active shell: the one picked there, or its newest when that one moved to a pane or closed. */
export function sideActive(s: State): string | undefined {
  const docked = dockedShells(s)
  return docked.some((t) => t.termId === s.sideTermId) ? s.sideTermId : docked.at(-1)?.termId
}

/** The shells on screen: the side panel's, when it is open, then the ones showing in panes. */
export function shownShells(s: State): string[] {
  const side = s.sideTermOpen ? sideActive(s) : undefined
  const alive = new Set(s.terminals.filter((t) => t.side).map((t) => t.termId))
  return [...(side ? [side] : []), ...visibleShells(s.layout).filter((id) => alive.has(id))]
}

/** Moves a shell out of the side panel into the panes, where a new view would open (#109). */
export function moveShellToPane(termId: string): void {
  setState((s) => ({ layout: reveal(s.layout, shellTab(termId), placement()) }))
  takeFocus(termId)
}

/** Moves a shell from its pane back into the side panel, and shows it there. */
export function moveShellToSide(termId: string): void {
  writeLocal('sideTermOpen', '1')
  setState((s) => {
    const pane = paneOf(s.layout, shellTab(termId))
    return { layout: pane ? closeTab(s.layout, pane.id, shellTab(termId)) : s.layout, sideTermId: termId, sideTermOpen: true }
  })
  takeFocus(termId)
}

/** Ctrl+Shift+`: a new shell beside the one being typed in (its pane, or the side panel), else in the side panel. */
export function newShellHere(): void {
  const f = focusedTerm()
  const pane = f && state.terminals.some((t) => t.termId === f && t.side) ? paneOf(state.layout, shellTab(f)) : undefined
  void newSideShell(undefined, undefined, pane?.id)
}

function giveBack(): void {
  const el = beforeShell
  beforeShell = null
  if (el && el !== document.body && el.isConnected) el.focus()
  else (document.activeElement as HTMLElement | null)?.blur()
}

function takeFocus(termId: string): void {
  const el = document.activeElement as HTMLElement | null
  if (!el?.closest('.xterm')) beforeShell = el
  recentShell = termId
  // a shell just revealed or moved gets its slot on the next render; two frames let it win over whatever else
  // that render showed and focused
  if (!focusTerm(termId)) requestAnimationFrame(() => requestAnimationFrame(() => focusTerm(termId)))
}

/**
 * Ctrl+` (and the rail's Terminal button, with `rail`): a shell on screen gets the keyboard; one that already
 * has it hides the side panel, or hands the keyboard back when it is in a pane. With shells but none on screen
 * the latest shows where it lives; with none, a new one opens in the side panel.
 */
export function terminalKey(rail = false): void {
  const shells = state.terminals.filter((t) => t.side)
  const shown = shownShells(state)
  const side = state.sideTermOpen ? sideActive(state) : undefined
  const f = focusedTerm()
  // the rail's button can't tell what had the keyboard (clicking it moves the focus), so it toggles the panel as before
  if (side && (rail || f === side)) {
    toggleSideTerm(false)
    if (!rail) giveBack()
    return
  }
  if (f && shown.includes(f)) return giveBack()
  if (shown.length) return takeFocus(recentShell && shown.includes(recentShell) ? recentShell : shown[0])
  if (shells.length) {
    const id = shells.find((t) => t.termId === recentShell)?.termId ?? shells[shells.length - 1].termId
    if (paneOf(state.layout, shellTab(id))) setState((s) => ({ layout: reveal(s.layout, shellTab(id)) }))
    else {
      setState({ sideTermId: id })
      toggleSideTerm(true)
    }
    return takeFocus(id)
  }
  void newSideShell()
}

const initialLayout = loadLayout()

let state: State = {
  booted: false,
  theme: (document.documentElement.dataset.theme as ThemeId) ?? 'corvid',
  sessions: {},
  activity: {},
  git: {},
  projects: { projects: [], importOffered: true, missing: [], cwds: {} },
  unfiled: { entries: [], ignored: [], hidden: [], quiet: 0, seenAt: 0, ready: false },
  tasks: [],
  notes: [],
  board: { messages: [], seenUpTo: 0, keepDays: 14 },
  agentsPane: 'cards',
  inlineTerms: [],
  assistant: { state: 'offline', chat: [], workers: [], proposals: [], boardAsks: [] },
  explorerOpen: readLocal('explorerOpen') === '1',
  explorerRoot: readLocal('explorerRoot') ?? undefined,
  scope: readLocal('projectScope') || undefined,
  sideTermOpen: readLocal('sideTermOpen') === '1',
  progress: { done: 0, total: 0, ready: false },
  stats: null,
  liveTokens: null,
  liveSessions: [],
  quota: null,
  quotaLoading: false,
  terminals: [],
  config: null,
  userAvatar: null,
  remote: { systems: [], approvals: [], canEncrypt: true },
  claude: null,
  home: '',
  view: focusedView(initialLayout) ?? 'terminals',
  layout: initialLayout,
  paletteOpen: false
}

const listeners = new Set<() => void>()

export function getState(): State {
  return state
}

// ---------- where a newly opened view goes (#109) ----------

// A Ctrl+click (or a middle-click on a rail icon) opens the other way for the views that click opens:
// a tab when the setting is on new panes, a new pane when it is on tabs. It lasts for that one click.
let flipOpen = false
if (typeof window !== 'undefined')
  for (const type of ['click', 'auxclick'] as const)
    window.addEventListener(
      type,
      (e) => {
        flipOpen = e.ctrlKey || e.metaKey || e.button === 1
        if (flipOpen) setTimeout(() => (flipOpen = false))
      },
      true
    )

/** Where a view that isn't open yet goes: the setting (a new pane unless it says tabs), flipped by a Ctrl+click,
 *  and a tab anyway when the panes area is narrow. Pane sizes come from the screen, so a split always fits. */
export function placement(): Placement {
  const split = (state.config?.openViews !== 'tab') !== flipOpen
  const main = document.querySelector<HTMLElement>('.main')
  const rooms: Record<string, Room> = {}
  for (const el of document.querySelectorAll<HTMLElement>('.pane[data-pane]')) {
    const r = el.getBoundingClientRect()
    rooms[el.dataset.pane!] = { w: r.width, h: r.height }
  }
  return { openIn: split && main && main.clientWidth >= NARROW_MAIN ? 'split' : 'tab', rooms }
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const prev = state
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  // Keep `view` and the panes in step: navigating reveals a view, and focusing a pane changes `view`.
  if (p.view && !p.layout) state.layout = reveal(state.layout, p.view, placement())
  else if (state.layout !== prev.layout) state.view = focusedView(state.layout) ?? state.view
  if (state.layout !== prev.layout) saveLayout(state.layout)
  for (const l of listeners) l()
}

/** Calls `cb` after every state change; returns the unsubscribe. */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => selector(state)
  )
}

/** The user's name from Settings ('' until one is set), for the board, notes and mentions. */
export const useUserName = (): string => useStore((s) => s.config?.userName ?? '')

// ---------- actions ----------

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
  action?: { label: string; run: () => void }
}

let toastSeq = 0
export function toast(text: string, kind: 'info' | 'error' = 'info', action?: Toast['action'], about?: MessageAbout): void {
  const id = ++toastSeq
  // Any error can become a task: with a short title, the message in its notes and a project (#117)
  if (!action && kind === 'error') action = { label: 'Make task', run: () => void taskFromError(text, about) }
  setState({ toast: { id, text, kind, action } })
  setTimeout(() => getState().toast?.id === id && setState({ toast: undefined }), action ? 7000 : 4000)
}

// ---------- tasks ----------

export async function makeTask(input: Partial<Task> & { title: string }): Promise<Task> {
  const t = await api.createTask(input)
  toast(`Task #${t.id} added`, 'info', { label: 'View', run: () => setState({ view: 'tasks' }) })
  return t
}

/** "Make task" on an error (#117): a message about Corvid or an extension is filed under Corvid's own project, so
 *  Automate can run it; any other opens the task editor to pick the project first. */
export async function taskFromError(text: string, about?: MessageAbout): Promise<void> {
  const m = taskFromMessage(text, about)
  const corvid = m.corvid ? state.projects.projects.find((p) => p.builtin === 'corvid') : undefined
  if (corvid) await makeTask({ title: m.title, notes: m.notes, source: 'error', projectId: corvid.id })
  else editTask({ title: m.title, notes: m.notes, source: 'error' })
}

export function taskForSource(source: string): Task | undefined {
  return state.tasks.find((t) => t.source === source)
}

/** The one way to finish a task in the UI (#134): it is deleted, with a short window to undo (same id, notes, column). */
export async function finishTask(id: number): Promise<void> {
  const t = await api.removeTask(id)
  if (!t) return
  toast(`Removed #${t.id} ${t.title}`, 'info', {
    label: 'Undo',
    run: () => void api.createTask(t)
  })
}

/** Done's Remove all (#138): each one is deleted as finishTask does, and one Undo brings them all back. */
export async function finishTasks(ids: number[]): Promise<void> {
  const gone: Task[] = []
  for (const id of ids) {
    const t = await api.removeTask(id)
    if (t) gone.push(t)
  }
  if (!gone.length) return
  toast(`Removed ${gone.length} done task${gone.length === 1 ? '' : 's'}`, 'info', {
    label: 'Undo',
    run: () => void Promise.all(gone.map((t) => api.createTask(t)))
  })
}

export function editTask(draft: Partial<Task>): void {
  setState({ taskEditor: draft })
}

// ---------- docs ----------

/** Open the Docs view on a page by id (#188): "connections/overview", or with a heading, "settings/reference#profile".
 *  Every "Learn more" link goes through here. */
export function openDocs(id = 'index'): void {
  setState({ view: 'docs', docsPage: id })
}

// ---------- notes ----------

/** Open a note in the Notes view; opening marks an agent's note as read. */
export function openNote(id: string): void {
  setState({ view: 'notes', openNoteId: id })
  if (state.notes.find((n) => n.id === id)?.unread) void api.noteSeen(id)
}

export async function newNote(): Promise<void> {
  try {
    // a project chosen in the switcher (#77) is the new note's project
    const scoped = state.projects.projects.find((p) => p.id === state.scope)
    const n = await api.createNote({ name: 'Untitled note', text: '', project: scoped ? primaryFolder(scoped) || undefined : undefined })
    setState((s) => ({ notes: s.notes.some((x) => x.id === n.id) ? s.notes : [...s.notes, n] }))
    openNote(n.id)
  } catch (e) {
    toast(String((e as Error).message ?? e), 'error')
  }
}

/** Deleted notes go to the trash folder; the toast offers an undo for a few seconds. */
export async function removeNote(id: string): Promise<void> {
  const n = await api.deleteNote(id)
  if (!n) return
  if (state.openNoteId === id) setState({ openNoteId: undefined })
  toast(`Deleted ${n.id} ${n.name}`, 'info', { label: 'Undo', run: () => void api.restoreNote(n.id) })
}

// ---------- message board ----------

/** Show the message board in the Agents view. */
export function showBoard(): void {
  setState({ view: 'terminals', agentsPane: 'board' })
}

/** Talk to Corvid (Ctrl+J, the top bar's Ask Corvid): the board, opened out, its message box set to Corvid,
 *  from any view. `ask` fills in a question. */
export function askCorvid(ask = ''): void {
  showBoard()
  // the board may only now be mounting: let it render, then fill and focus its box
  setTimeout(() => window.dispatchEvent(new CustomEvent('corvid:ask', { detail: ask })), 60)
}

/** An ended agent's Resume (#62): "@name " at the start of the board's box, for the user to say what next and send. */
export function mentionOnBoard(name: string): void {
  showBoard()
  setTimeout(() => window.dispatchEvent(new CustomEvent('corvid:mention', { detail: name })), 60)
}

/** The board is on screen in the focused view: a toast about a new message there would only repeat it. */
function boardShowing(): boolean {
  return focusedView(state.layout) === 'terminals' && document.hasFocus()
}

// ---------- agents' terminals ----------
// An agent's terminal shows in one place at a time: inside its card, or in a tab of its own. The tab wins
// while it is open; closing it hands the terminal back to the card (open or folded, as it was).

/** Inline terminals open at once; opening another folds the one opened longest ago. */
export const MAX_INLINE = 3

/** Opens or folds the terminal inside an agent's card. */
export function toggleInline(termId: string, open = !state.inlineTerms.includes(termId)): void {
  setState((s) => {
    const rest = s.inlineTerms.filter((id) => id !== termId)
    return { inlineTerms: open ? [...rest, termId].slice(-MAX_INLINE) : rest }
  })
}

/** Shows an agent's terminal in its own tab, focusing the tab it already has. */
export function openTerminal(termId: string): void {
  setState((s) => ({ layout: revealTerm(s.layout, termId, placement()) }))
}

/** Closes an agent's tab; the agent keeps running and its terminal goes back to its card. */
export function closeTerminalTab(termId: string): void {
  const pane = paneOf(state.layout, termTab(termId))
  if (pane) setState((s) => ({ layout: closeTab(s.layout, pane.id, termTab(termId)) }))
}

export const hasTermTab = (s: State, termId: string): boolean => termTabs(s.layout).includes(termId)

export function liveFor(sessionId: string): LiveSession | undefined {
  return state.liveSessions.find((l) => l.sessionId === sessionId)
}

export function terminalFor(sessionId: string): TerminalInfo | undefined {
  return state.terminals.find((t) => t.sessionId === sessionId && t.exited === undefined)
}

/** A session lives on its folder's project page; this opens that page with the session picked out. */
export function showSession(sessionId: string, cwd?: string): void {
  const folder = state.sessions[sessionId]?.cwd || cwd || liveFor(sessionId)?.cwd
  if (!folder) return toast('That session has no folder on record, so it has no project page')
  setState({ view: 'projects', selectedProject: folder, selectedId: sessionId })
}

export function focusSession(sessionId: string): void {
  const term = terminalFor(sessionId)
  if (term) openTerminal(term.termId)
  else showSession(sessionId)
}

/** Go to wherever a live session is running: its agent here, its VS Code window, or its project page. */
export function jumpTo(live: LiveSession, s?: SessionSummary): void {
  if (live.termId) openTerminal(live.termId)
  else if (live.entrypoint?.includes('vscode')) void api.openVSCode(s?.cwd || live.cwd, live.sessionId)
  else showSession(live.sessionId, live.cwd)
}

export async function launch(session: SessionSummary, mode: LaunchMode, force = false): Promise<void> {
  if (session.deleted && mode !== 'new') {
    // the index keeps its title and summary; only Claude's transcript is gone (4/5)
    toast('Its transcript is gone (Claude Code removes old sessions), so it can’t be resumed. Its summary and history stay here.', 'error')
    return
  }
  if (mode === 'resume') {
    const existing = terminalFor(session.id)
    if (existing) {
      openTerminal(existing.termId)
      return
    }
    const live = liveFor(session.id)
    if (live && !live.termId && !force) {
      setState({ conflict: { session, live } })
      return
    }
  }
  try {
    const title = mode === 'fork' ? `⑂ ${session.title}` : session.title
    const term = await api.launch({ mode, cwd: session.cwd, title, sessionId: session.id })
    setState((s) => ({
      terminals: s.terminals.some((t) => t.termId === term.termId) ? s.terminals : [...s.terminals, term],
      layout: revealTerm(s.layout, term.termId, placement()),
      conflict: undefined
    }))
  } catch (e) {
    toast(String((e as Error).message ?? e), 'error')
  }
}

export async function newSession(cwd: string, title: string): Promise<void> {
  try {
    const term = await api.launch({ mode: 'new', cwd, title })
    setState((s) => ({
      terminals: s.terminals.some((t) => t.termId === term.termId) ? s.terminals : [...s.terminals, term],
      layout: revealTerm(s.layout, term.termId, placement())
    }))
  } catch (e) {
    toast(String((e as Error).message ?? e), 'error')
  }
}

/** New Project: pick a folder; one with no git also gets a session that runs git init. Opens it in Agents: the folder trust prompt shows there. */
export async function newProject(): Promise<void> {
  try {
    // with a project chosen in the switcher (#77), the folder picker opens beside its folder
    const scoped = state.projects.projects.find((p) => p.id === state.scope)
    const folder = scoped ? primaryFolder(scoped) : ''
    const r = await api.newProject(folder ? folder.replace(/[\\/][^\\/]+[\\/]?$/, '') || undefined : undefined)
    if (r.status === 'added') {
      toast(`Added ${baseName(r.path)} to Projects.`)
      openProject(r.path)
      return
    }
    if (r.status !== 'started') return
    const term = r.terminal
    setState((s) => ({
      terminals: s.terminals.some((t) => t.termId === term.termId) ? s.terminals : [...s.terminals, term],
      layout: revealTerm(s.layout, term.termId, placement())
    }))
    toast(`Added ${baseName(r.path)} to Projects. Claude is running git init there.`)
  } catch (e) {
    toast(String((e as Error).message ?? e), 'error')
  }
}

export async function refreshQuota(): Promise<void> {
  setState({ quotaLoading: true })
  try {
    await api.refreshUsage()
  } finally {
    setState({ quotaLoading: false })
  }
}

/** Change a project on the list (#73): name, pinned, archived. */
export function updateProject(id: string, patch: Partial<Pick<ProjectRecord, 'name' | 'pinned' | 'archived'>>): void {
  void api.updateProject(id, patch).catch((e) => toast(String((e as Error).message ?? e), 'error'))
}

export function togglePin(id: string): void {
  const p = state.projects.projects.find((x) => x.id === id)
  if (p) updateProject(id, { pinned: !p.pinned })
}

/** Put a folder on the list without the folder picker (the old-folders list, the import's skipped list). */
export async function addProjectPath(path: string, name?: string): Promise<void> {
  const r = await api.addProjectPath({ path, name })
  if ('error' in r) toast(r.error, 'error')
  else toast(`Added ${r.project.name} to Projects.`)
}

/** Extension themes seen this session, by id, so a notice can name one that has gone (#114). */
const themeNames = new Map<string, string>()
/** The extension theme that is wanted but missing right now, if any, so its notice shows once. */
let missingTheme: string | undefined

function showTheme(config: AppConfig): void {
  const theme = activeTheme(config)
  applyTheme(theme)
  if (theme !== state.theme) setState({ theme })
  // an extension theme that is off, removed or broken shows the default of its kind; say so once, and once when it's back
  const wanted = wantedTheme(config, osDark())
  if (isThemeId(wanted) && isExtensionThemeId(wanted)) themeNames.set(wanted, themeDef(wanted).name)
  if (!isThemeId(wanted) && isExtensionThemeId(wanted)) {
    if (missingTheme !== wanted) {
      missingTheme = wanted
      const name = themeNames.get(wanted) ?? `The theme ${wanted}`
      toast(`${name} isn't available because ${themeGoneReason(wanted)}, so Corvid switched to ${themeDef(theme).name} for now. Your pick is kept and comes back with the extension.`)
    }
  } else if (missingTheme) {
    if (missingTheme === wanted) toast(`${themeDef(wanted).name} is back.`)
    missingTheme = undefined
  }
}

/** Shows the theme again after the extension themes were reloaded (#114). */
export function reshowTheme(): void {
  if (state.config) showTheme(state.config)
}

/** Apply a config patch at once and save it, so a theme change doesn't wait on the round trip. */
function setThemePrefs(patch: Partial<AppConfig>): void {
  if (!state.config) return
  const config = { ...state.config, ...patch }
  setState({ config })
  showTheme(config)
  void api.setConfig(patch)
}

/** Pick a theme. It also becomes the light or dark pick, which Follow system and the toggle use. */
export function pickTheme(id: ThemeId): void {
  const slot = themeDef(id).kind === 'light' ? 'themeLight' : 'themeDark'
  setThemePrefs(state.config?.themeFollowSystem ? { [slot]: id } : { theme: id, [slot]: id })
}

export function setFollowSystem(on: boolean): void {
  const c = state.config
  if (!c) return
  // turning it off keeps whatever is on screen now
  setThemePrefs(on ? { themeFollowSystem: true } : { themeFollowSystem: false, theme: activeTheme(c) })
}

/** The title-bar button: swap between the light and dark picks. It stops following the system. */
export function toggleTheme(): void {
  const c = state.config
  if (!c) return
  const theme = themeDef(activeTheme(c)).kind === 'light' ? c.themeDark : c.themeLight
  setThemePrefs({ theme, themeFollowSystem: false })
}

/** Show or hide the crow mascot; remembered in config.json. Hiding offers an undo. */
export function setCrow(on: boolean): void {
  void api.setConfig({ crow: on })
  if (!on) toast('Crow hidden. Turn it back on in Settings.', 'info', { label: 'Undo', run: () => setCrow(true) })
}

/** Show or hide the agents' birds; remembered in config.json. Hiding offers an undo. */
export function setAgentBirds(on: boolean): void {
  void api.setConfig({ agentBirds: on })
  if (!on) toast('Agent birds hidden. Turn them back on in Settings.', 'info', { label: 'Undo', run: () => setAgentBirds(true) })
}

// The look applies here at once and is saved once the colour picker settles. Until that save is
// back, config pushes from main keep the local look so a slow round trip can't flick it back.
let lookTimer = 0
let lookLocal: CrowLook | null = null

/** Change how the crow looks, for the mascot and the avatar; remembered in config.json. */
export function setCrowLook(look: CrowLook): void {
  lookLocal = look
  applyCrowLook(look)
  setState((s) => (s.config ? { config: { ...s.config, crowLook: look } } : {}))
  clearTimeout(lookTimer)
  lookTimer = window.setTimeout(() => {
    void api.setConfig({ crowLook: look }).finally(() => {
      if (lookLocal === look) lookLocal = null
    })
  }, 300)
}

export function snooze(riskId: string, days = 7): void {
  const now = Date.now()
  const kept = Object.fromEntries(Object.entries(state.config?.snoozed ?? {}).filter(([, until]) => until > now))
  void api.setConfig({ snoozed: { ...kept, [riskId]: now + days * 86400_000 } })
}

// The profile picture is decoded once here and shared by URL, so a board of 100 messages, the notes
// and Settings all draw the same decoded image. The URL is only handed out after it decoded, so
// nothing jumps while it loads; one that won't decode leaves the letter marker.
let avatarSeq = 0
export async function showUserAvatar(bytes: Uint8Array | null): Promise<void> {
  const seq = ++avatarSeq
  const url = bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' })) : null
  if (url) {
    const img = new Image()
    img.src = url
    try {
      await img.decode()
    } catch {
      URL.revokeObjectURL(url)
      if (seq === avatarSeq) setAvatarUrl(null)
      return
    }
  }
  if (seq === avatarSeq) setAvatarUrl(url)
  else if (url) URL.revokeObjectURL(url)
}

function setAvatarUrl(url: string | null): void {
  const old = state.userAvatar
  setState({ userAvatar: url })
  if (old) URL.revokeObjectURL(old)
}

export function openProject(path: string): void {
  setState({ view: 'projects', selectedProject: path })
}

// ---------- wiring ----------

const agentIds = (terminals: TerminalInfo[]): Set<string> => new Set(terminals.filter((t) => !t.side).map((t) => t.termId))
const shellIds = (terminals: TerminalInfo[]): Set<string> => new Set(terminals.filter((t) => t.side).map((t) => t.termId))

export async function boot(): Promise<void> {
  const b = await api.bootstrap()
  showTheme(b.config)
  applyCrowLook(b.config.crowLook)
  setState({
    booted: true,
    sessions: Object.fromEntries(b.sessions.map((s) => [s.id, s])),
    activity: Object.fromEntries(b.activity.map((a) => [a.sessionId, a])),
    tasks: b.tasks,
    notes: b.notes,
    board: b.board,
    assistant: b.assistant,
    progress: b.progress,
    stats: b.stats,
    liveTokens: b.liveTokens,
    liveSessions: b.liveSessions,
    quota: b.quota,
    terminals: b.terminals,
    config: b.config,
    remote: b.remote,
    claude: b.claude,
    claudeDefaultModel: b.claudeDefaultModel,
    home: b.home,
    projects: b.projects,
    sideTermId: b.terminals.find((t) => t.side)?.termId,
    // tabs saved before a restart whose agents or shells are gone close quietly
    layout: pruneShellTabs(pruneTermTabs(state.layout, agentIds(b.terminals)), shellIds(b.terminals))
  })
  api.on('projects', (projects) => setState({ projects }))
  api.on('unfiled', (unfiled) => setState({ unfiled }))
  void api.unfiled().then((unfiled) => setState({ unfiled }))
  api.on('sessions:all', (list) => setState({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) }))
  api.on('sessions:updated', (list) =>
    setState((s) => {
      const next = { ...s.sessions }
      for (const x of list) {
        if (x.junk) delete next[x.id]
        else next[x.id] = x
      }
      return { sessions: next }
    })
  )
  api.on('index:progress', (progress) => setState({ progress }))
  api.on('activity', (items, replace) =>
    setState((s) => {
      const next = replace ? {} : { ...s.activity }
      for (const a of items) next[a.sessionId] = a
      return { activity: next }
    })
  )
  api.on('stats', (stats) => setState({ stats }))
  api.on('live:tokens', (liveTokens) => setState({ liveTokens }))
  api.on('live:sessions', (liveSessions) => setState({ liveSessions }))
  api.on('usage:quota', (quota) => setState({ quota }))
  api.on('terminals', (terminals) =>
    setState((s) => {
      // The sidebar keeps an active tab, falling back to its newest when that one closes.
      // A removed agent's terminal leaves its card and closes its tab.
      const side = terminals.filter((t) => t.side)
      const sideTermId = side.some((t) => t.termId === s.sideTermId) ? s.sideTermId : side.at(-1)?.termId
      const alive = agentIds(terminals)
      const inlineTerms = s.inlineTerms.filter((id) => alive.has(id))
      return { terminals, sideTermId, layout: pruneShellTabs(pruneTermTabs(s.layout, alive), shellIds(terminals)), inlineTerms: inlineTerms.length === s.inlineTerms.length ? s.inlineTerms : inlineTerms }
    })
  )
  api.on('nav:focus-session', focusSession)
  api.on('claude', (claude) => setState({ claude }))
  api.on('config', (pushed) => {
    const config = lookLocal ? { ...pushed, crowLook: lookLocal } : pushed
    setState({ config })
    showTheme(config)
    applyCrowLook(config.crowLook)
  })
  onOsThemeChange(() => state.config && showTheme(state.config))
  api.on('tasks', (tasks) => setState({ tasks }))
  api.on('notes', (notes) => setState({ notes }))
  api.on('note:left', (text, id) => toast(text, 'info', { label: 'Open', run: () => openNote(id) }))
  void api.profileAvatar().then(showUserAvatar, () => {})
  api.on('profile:avatar', (bytes) => void showUserAvatar(bytes))
  api.on('board', (board) => setState({ board }))
  api.on('board:ping', (text) => !boardShowing() && toast(text, 'info', { label: 'Open', run: showBoard }))
  api.on('remote', (remote) => setState({ remote }))
  api.on('assistant', (assistant) => {
    // a new worker proposal: say so wherever the user is; it waits in the Agents view
    const fresh = assistant.proposals.filter((p) => !state.assistant.proposals.some((q) => q.id === p.id))
    setState({ assistant })
    if (fresh.length && state.view !== 'terminals')
      toast(`A worker for #${fresh[0].taskId} awaits your approval.`, 'info', { label: 'Review', run: () => setState({ view: 'terminals', agentsPane: 'cards' }) })
  })
  api.on('toast', (text, kind) => toast(text, kind))
  api.on('nav:show', (t) => {
    if (t.note) openNote(t.note)
    else if (t.board) showBoard()
    else if (t.sessionId) showSession(t.sessionId)
    else if (t.project) setState({ view: 'projects', selectedProject: t.project })
    // Anything the app no longer has (the old Sessions and Live views) lands on Agents rather than an empty tab.
    else if (VIEWS.includes(t.view as View))
      setState({
        view: t.view as View,
        ...(t.view === 'projects' ? { selectedProject: undefined } : {}),
        // an approval notification opens the inbox (#88)
        ...(t.view === 'connections' ? { connectionsFocus: { area: 'activity' as const } } : {})
      })
    else setState({ view: 'terminals' })
  })
  api.on('git', (updates) =>
    setState((s) => {
      const next = { ...s.git }
      for (const u of updates) next[u.key] = u.info
      return { git: next }
    })
  )
}
