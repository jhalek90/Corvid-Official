import type { Tour, ToursState } from '@shared/tours'
import type { AgentPingStats } from '@shared/agentPings'
import type { LineageEvent, LineageGraph } from '@shared/lineage'
import type { SecretScan } from '@shared/secretRules'
import type { UpdateView } from '@shared/updateCheck'
import type { ExtensionDetail, ExtensionRecord, ImportOutcome, InstallPrompt, Preflight } from '@shared/extensions'
import type { SharePreview, VerifyCheck, VerifyPrompt } from '@shared/extensionVerify'
import type { CostEstimate } from '@shared/costEstimate'
import type { TouchedFile } from '@shared/buildProgress'
import type { LifecycleInfo, LifecycleResult, ResolvePrompt } from '@shared/extensionLifecycle'
import type { PackagerState } from '@shared/packager'
import type { LoadResult } from '../../extensions/sockets/load'
import type { ScanState } from '@shared/extensionScan'
import type { PlatformInfo } from '@shared/platformInfo'
import type {
  ConnectionAuditEntry,
  ConnectionView,
  ConnectorDetail,
  DraftsState,
  ManifestCheck,
  ConnectionsState,
  SecretStorageStatus,
  CorvidStatus,
  SetupItem,
  ImportCandidate,
  ProjectRecord,
  RelocateCheck,
  MergePreview,
  ProjectsState,
  UnfiledState,
  AppConfig,
  ContextMenuAction,
  ContextMenuInfo,
  AssistantSnapshot,
  ArchiveEntry,
  FileEntry,
  FilePlace,
  FilePreview,
  GitDetail,
  GitGraph,
  GitInfo,
  ClaudeBinary,
  ClaudePathCheck,
  ClaudePathSaved,
  IndexProgress,
  LaunchMode,
  LiveSession,
  LiveTokens,
  AuditEntry,
  Note,
  RemoteApproval,
  RemoteSystemInput,
  RemoteSystemView,
  SearchHit,
  SessionActivity,
  SessionSummary,
  Task,
  TaskColumn,
  ShellOption,
  TerminalInfo,
  UsageQuota,
  UsageStats,
  VoiceStatus,
  DesktopInfo
} from '@shared/types'
import type { BoardMessage, BoardSnapshot } from '@shared/board'
import type { RequestClass, UserRequest, UserRequestPlan, UserRequestRefusal, UserResponse } from '@shared/sendRequest'

export type SocketExtensionState = LoadResult & { counts: Record<string, number> }

export interface ConnectionInput {
  id?: string
  connectorId: string
  name: string
  config: Record<string, string | number | boolean>
  safety?: string
  adminWithoutAsking?: boolean
  projectIds: string[]
}

export interface RemoteSnapshot {
  systems: RemoteSystemView[]
  approvals: RemoteApproval[]
  /** system secure storage works; secrets can't be saved without it */
  canEncrypt: boolean
  /** the same, with the backend and the reason to show when it doesn't (#159) */
  secretStorage?: SecretStorageStatus
  /** agent drafts and set-up requests waiting for the user (#92) */
  drafts?: number
}

export interface Bootstrap {
  sessions: SessionSummary[]
  activity: SessionActivity[]
  tasks: Task[]
  notes: Note[]
  board: BoardSnapshot
  assistant: AssistantSnapshot
  progress: IndexProgress
  stats: UsageStats | null
  liveTokens: LiveTokens | null
  liveSessions: LiveSession[]
  quota: UsageQuota | null
  terminals: TerminalInfo[]
  config: AppConfig
  remote: RemoteSnapshot
  claude: ClaudeBinary | null
  claudeDefaultModel?: string
  home: string
  projects: ProjectsState
}

interface Events {
  claude: [ClaudeBinary | null]
  projects: [ProjectsState]
  unfiled: [UnfiledState]
  'ctx:menu': [ContextMenuInfo]
  'sessions:all': [SessionSummary[]]
  'sessions:updated': [SessionSummary[]]
  'index:progress': [IndexProgress]
  activity: [SessionActivity[], boolean]
  stats: [UsageStats]
  'live:tokens': [LiveTokens]
  'live:sessions': [LiveSession[]]
  'usage:quota': [UsageQuota]
  terminals: [TerminalInfo[]]
  'pty:data': [string, string]
  'pty:exit': [string, number]
  'nav:focus-session': [string]
  config: [AppConfig]
  git: [{ key: string; info: GitInfo | null }[]]
  tasks: [Task[]]
  notes: [Note[]]
  /** an agent or the assistant left a note: message, note id */
  'note:left': [string, string]
  board: [BoardSnapshot]
  /** a message addressed to the user: toast text, message id */
  'board:ping': [string, number]
  remote: [RemoteSnapshot]
  assistant: [AssistantSnapshot]
  'nav:show': [{ view: string; project?: string; sessionId?: string; note?: string; board?: boolean }]
  /** a tour Corvid the assistant made on the fly (#216); checked again before it plays */
  'tour:play': [unknown]
  toast: [string, 'info' | 'error']
  'update:view': [UpdateView]
  /** dictation id, everything transcribed so far */
  'voice:text': [string, string]
  /** dictation id, error message, error kind */
  'voice:end': [string, string | undefined, string | undefined]
  /** the user's profile picture changed: the stored PNG, or null when removed */
  'profile:avatar': [Uint8Array | null]
}

interface Api {
  bootstrap(): Promise<Bootstrap>
  search(q: string): Promise<SearchHit[]>
  refreshIndex(): Promise<void>
  refreshUsage(): Promise<UsageQuota>
  launch(opts: { mode: LaunchMode; cwd: string; title: string; sessionId?: string }): Promise<TerminalInfo>
  shell(cwd: string, title: string): Promise<TerminalInfo>
  /** shells installed on this machine, default first */
  shells(): Promise<ShellOption[]>
  /** a sidebar terminal; home folder unless cwd is given */
  sideShell(opts: { shellId?: string; title?: string; cwd?: string }): Promise<TerminalInfo>
  attach(termId: string): Promise<string>
  input(termId: string, data: string): void
  resize(termId: string, cols: number, rows: number): void
  /** Windows build number (e.g. 19045), for xterm's ConPTY handling; undefined elsewhere */
  windowsBuild?: number
  closeTerminal(termId: string): Promise<void>
  openVSCode(cwd: string, sessionId?: string): Promise<void>
  openWT(opts: { mode: LaunchMode; cwd: string; sessionId?: string; title?: string }): Promise<void>
  /** whether "Resume in a terminal window" can run here (Linux: a terminal was found) */
  terminalAvailable(): Promise<boolean>
  assistantInterrupt(): Promise<void>
  /** same as the assistant's start_worker: proposes in "ask" mode, starts in "auto".
   *  Resolves to 'proposed', 'started', or the reason it was refused. */
  requestWorker(taskId: number): Promise<string>
  stopWorker(id: string): Promise<void>
  /** remove a stopped or exited worker from the list */
  dismissWorker(id: string): Promise<void>
  /** the terminals on screen or focused; a finished agent shown there is never closed (#70) */
  viewingTerminals(termIds: string[]): void
  /** cancel a finished agent's countdown to closing, until it works and posts done again */
  keepOpen(id: string): Promise<void>
  stopAllWorkers(): Promise<number>
  approveProposal(id: string): Promise<void>
  rejectProposal(id: string): Promise<void>
  createTask(input: Partial<Task> & { title: string }): Promise<Task>
  updateTask(id: number, patch: Partial<Task>): Promise<Task | undefined>
  /** Picking Fable for a task (#136): Corvid's "Use Fable / Cancel" dialog and plan check; ok = the user said yes */
  pickTaskFable(id?: number): Promise<{ ok: boolean; problem?: string }>
  removeTask(id: number): Promise<Task | undefined>
  arrangeTasks(column: TaskColumn, ids: number[]): Promise<void>
  createNote(input: { name: string; text: string; project?: string }): Promise<Note>
  /** with baseRev, a note changed on disk since comes back as `conflict` instead of being overwritten */
  updateNote(id: string, patch: { name?: string; text?: string }, baseRev?: string): Promise<{ note: Note } | { conflict: Note }>
  /** moves it to the notes trash folder */
  deleteNote(id: string): Promise<Note | undefined>
  restoreNote(id: string): Promise<Note | undefined>
  noteSeen(id: string): Promise<void>
  openNotesFolder(): Promise<void>
  /** the Lineage view's graph (#203): read-only, derived in the main process from lineage.jsonl, notes, messages and tasks */
  lineageGraph(filter: { days?: number; taskId?: number; project?: string }): Promise<LineageGraph>
  /** events appended to the lineage log, in batches of about a second, while the window is open (#210) */
  onLineageAppended(cb: (events: LineageEvent[]) => void): () => void
  extensionsList(): Promise<ExtensionRecord[]>
  extensionDetail(key: string): Promise<ExtensionDetail | null>
  extensionsImportDropped(files: File[], maxBytes: number): Promise<ImportOutcome[]>
  extensionsPick(): Promise<ImportOutcome[]>
  extensionsImportText(text: string): Promise<ImportOutcome[]>
  extensionsPaste(): Promise<ImportOutcome[]>
  extensionsResolve(token: string, choice: 'replace' | 'keep' | 'skip'): Promise<ImportOutcome>
  extensionDelete(key: string): Promise<{ ok: true } | { error: string }>
  packagerState(): Promise<PackagerState>
  packagerOpen(): Promise<PackagerState>
  packagerClose(): Promise<void>
  packagerBegin(mode: 'built' | 'scratch' | 'edit', picked: string[], findings?: string): Promise<PackagerState | { error: string }>
  packagerReply(text: string): Promise<PackagerState | { error: string }>
  packagerSave(): Promise<{ ok: true; key: string } | { error: string }>
  packagerStop(): Promise<PackagerState>
  packagerReset(): Promise<PackagerState>
  packagerAuthor(name: string): Promise<PackagerState>
  onPackager(cb: (s: PackagerState) => void): () => void
  /** the #93 usage text when usage is over the limit, else null (#96) */
  extensionScanUsage(): Promise<string | null>
  extensionScan(key: string): Promise<ScanState | { error: string }>
  extensionConfirmWarning(key: string, phrase: string): Promise<ScanState | { error: string }>
  extensionSkipScan(key: string, phrase: string): Promise<ScanState | { error: string }>
  onExtensions(cb: (list: ExtensionRecord[]) => void): () => void
  extensionEstimate(key: string): Promise<CostEstimate | null>
  extensionPrepareInstall(key: string): Promise<InstallPrompt | { error: string }>
  extensionConfirmInstall(key: string, token: string): Promise<{ ok: true; estimate: CostEstimate; started: boolean; message: string } | { error: string }>
  extensionsAccuracy(): Promise<{ offBy: number; n: number } | null>
  /** the install pipeline (#98): window only */
  extensionPreflight(key: string): Promise<Preflight | { error: string }>
  extensionConfirmTier3(key: string, areas: string[]): Promise<{ ok: true } | { error: string }>
  extensionDiff(key: string): Promise<{ text: string; truncated: boolean } | { error: string }>
  extensionMerge(key: string, ack: { tip: string; flagsRead: boolean }): Promise<{ ok: true; message: string; mergeCommit?: string } | { error: string; rescanned?: boolean }>
  extensionSendBack(key: string, note: string): Promise<{ ok: true } | { error: string }>
  extensionDiscard(key: string): Promise<{ ok: true; message: string } | { error: string }>
  /** build progress (#108): Stop build (the cap's Stop), and read-only views of the running build */
  extensionStopBuild(key: string): Promise<{ ok: true; message: string } | { error: string }>
  extensionBuildFiles(key: string): Promise<{ files: TouchedFile[] } | { error: string }>
  extensionBuildDiff(key: string): Promise<{ text: string; truncated: boolean } | { error: string }>
  extensionBuildLive(): Promise<{ capAsking: boolean }>
  /** the lifecycle (#99): window only */
  extensionLifecycle(key: string): Promise<LifecycleInfo | { error: string }>
  extensionDisable(key: string, confirmed?: boolean): Promise<LifecycleResult>
  extensionEnable(key: string, confirmed?: boolean): Promise<LifecycleResult>
  extensionRemove(key: string, deleteText: boolean, confirmed?: boolean): Promise<LifecycleResult>
  extensionReapply(key: string, confirmed?: boolean): Promise<LifecycleResult>
  extensionRebuild(key: string): Promise<LifecycleResult>
  extensionPendingDiff(key: string): Promise<{ text: string } | { error: string }>
  extensionApprovePending(key: string, tip: string): Promise<LifecycleResult>
  extensionDiscardPending(key: string): Promise<LifecycleResult>
  extensionTextOf(key: string): Promise<string | null>
  /** verify and share (#101): window only */
  extensionVerifyCheck(key: string): Promise<VerifyCheck | { error: string }>
  extensionPrepareVerify(key: string, base: 'built-on' | 'main'): Promise<VerifyPrompt | { error: string }>
  extensionConfirmVerify(key: string, token: string): Promise<{ ok: true; taskId: number } | { error: string }>
  extensionPrepareResolve(key: string): Promise<ResolvePrompt | { error: string }>
  extensionConfirmResolve(key: string, token: string, protectedOk: boolean): Promise<{ ok: true; taskId: number } | { error: string }>
  extensionStopResolve(key: string): Promise<LifecycleResult>
  extensionLeaveConflict(key: string): Promise<LifecycleResult>
  extensionSendBackResolved(key: string, note: string): Promise<LifecycleResult>
  extensionSharePreview(key: string): Promise<SharePreview | { error: string }>
  extensionShare(key: string, how: 'file' | 'copy', leaksRead: boolean): Promise<{ ok: true; message: string } | { error: string } | { cancelled: true }>
  /** the extensions under src/extensions and what each registered in the main process (#102) */
  extensionSockets(): Promise<SocketExtensionState[]>
  onExtensionSockets(cb: (list: SocketExtensionState[]) => void): () => void
  /** posts as the user; rejects for secrets or over-long text */
  boardPost(text: string, replyTo?: number, opts?: { boardOnly?: boolean; channel?: string; files?: { name: string; data: Uint8Array }[] }): Promise<BoardMessage>
  /** an attached image's bytes, for the thumbnail and viewer (#147) */
  boardAttachment(id: number, index: number): Promise<Uint8Array>
  /** shows an attached file in its folder; never opens or runs it */
  boardRevealAttachment(id: number, index: number): Promise<void>
  /** files attached to a task (#187): added and removed only from the window */
  addTaskFiles(id: number, files: { name: string; data: Uint8Array }[]): Promise<Task>
  removeTaskFile(id: number, index: number): Promise<Task>
  taskFileImage(id: number, index: number): Promise<Uint8Array>
  revealTaskFile(id: number, index: number): Promise<void>
  boardSeen(upTo: number, channel?: string): Promise<void>
  /** removes every message; notes saved from them stay. Resolves to how many went. */
  boardClear(): Promise<number>
  /** resolves to the note's id */
  boardSaveNote(id: number): Promise<string>
  /** /discuss (#200): the header's Stop button; resolves to what happened */
  discussStop(): Promise<string>
  /** saves a whole discussion (transcript and summary) as a note; resolves to the note's id */
  discussSave(headerId: number): Promise<string>
  /** sends one of the user's own board messages to Corvid (@corvid or untagged) again (Retry) */
  boardAskCorvid(id: number): Promise<void>
  /** on the user's message that mentioned an ended agent: resume it now, when a slot is free, or cancel that wait (#62) */
  boardWake(id: number, who: string, action: 'now' | 'queue' | 'cancel'): Promise<void>
  gitTrack(paths: string[]): Promise<{ key: string; info: GitInfo | null }[]>
  gitRefresh(path?: string): Promise<void>
  gitDetail(repoRoot: string): Promise<GitDetail>
  /** history across all branches for the commit graph, newest first, at most `limit` commits */
  gitGraph(repoRoot: string, limit: number): Promise<GitGraph>
  archive(): Promise<{ roots: string[]; entries: ArchiveEntry[] }>
  /** folder picker, checks, then a short Claude session that runs git init; warnings are shown as dialogs */
  /** defaultPath: where the folder picker opens (beside the switcher's project, #77) */
  newProject(defaultPath?: string): Promise<
    | { status: 'started'; path: string; terminal: TerminalInfo; projectId?: string }
    | { status: 'added'; path: string; projectId: string }
    | { status: 'cancelled' }
    | { status: 'skipped'; reason: string }
  >
  /** put a folder on the project list; refused (with the project it belongs to) if it's already one, inside one or a worktree of one */
  addProjectPath(input: { path: string; name?: string; pinned?: boolean }): Promise<{ project: ProjectRecord } | { error: string; existing?: ProjectRecord }>
  updateProject(id: string, patch: Partial<Pick<ProjectRecord, 'name' | 'pinned' | 'archived'>>): Promise<ProjectRecord | undefined>
  /** takes it off the list only; nothing on disk changes */
  removeProject(id: string): Promise<boolean>
  // Corvid's own project (#78)
  corvidStatus(): Promise<CorvidStatus>
  /** the LICENSE text this install carries, or null when it has none */
  corvidLicenseText(): Promise<string | null>
  /** the window is up: the heartbeat a fresh deploy waits for */
  corvidReady(): Promise<void>
  corvidDismissNotice(): Promise<void>
  corvidCheckSetup(): Promise<SetupItem[]>
  corvidPickCloneFolder(): Promise<string | undefined>
  corvidClone(dir: string): Promise<{ ok: true } | { error: string }>
  corvidSetSource(dir: string): Promise<ProjectRecord | { error: string }>
  corvidInstall(): Promise<{ code: number | null; error?: string }>
  corvidCancelInstall(): Promise<boolean>
  onCorvidInstallLine(cb: (line: string) => void): () => void
  corvidRebuild(wait: boolean): Promise<{ error?: string }>
  corvidCancelRebuild(): Promise<void>
  corvidRollback(): Promise<{ error?: string }>
  corvidDeployLog(): Promise<string>
  /** the launch-time update check (#143) */
  updateView(): Promise<UpdateView>
  /** Settings' Check now: fetches the public repo even with the launch check off */
  updateCheck(): Promise<UpdateView>
  updateDismiss(): Promise<UpdateView>
  /** the banner's button: makes the update task, or returns the open one */
  updateCreateTask(): Promise<{ task?: Task; existed?: boolean; error?: string }>
  /** writes an error the window caught to crash.log (#83) */
  reportError(what: string, details: string): void
  /** "The window crashed and was reloaded…" once after a recovery, else null */
  crashNotice(): Promise<string | null>
  openCrashLog(): Promise<string>
  /** once at start-up: an unexpected exit last time, repaired settings, a taken hotkey (#85) */
  startupNotices(): Promise<{ text: string; log?: boolean }[]>
  /** who started this test copy, or null in the real app (#85) */
  testOwner(): Promise<string | null>
  listBackups(): Promise<{ item: string; backups: { name: string; at: number; size: number }[] }[]>
  /** asks first in a dialog; on yes, Corvid restarts */
  restoreBackup(item: string, name: string): Promise<{ cancelled?: boolean; error?: string; ok?: boolean }>
  importPreview(): Promise<ImportCandidate[]>
  importProjects(picks: { path: string; name?: string; pinned?: boolean }[]): Promise<{ added: number; skipped: number }>
  importCancel(): Promise<void>
  // several folders per project (3/5)
  pickFolder(defaultPath?: string): Promise<string | undefined>
  /** refused with a message, or { merge } when the folder is a one-folder project of its own */
  addFolder(id: string, path: string, label?: string): Promise<{ project: ProjectRecord; warning?: string } | { error: string } | { merge: string }>
  removeFolder(id: string, path: string, newPrimary?: string): Promise<{ project: ProjectRecord } | { error: string }>
  editFolder(id: string, path: string, patch: { primary?: boolean; label?: string; move?: number }): Promise<ProjectRecord | undefined>
  mergePreview(into: string, from: string): Promise<MergePreview | { error: string }>
  mergeProjects(into: string, from: string): Promise<{ project: ProjectRecord } | { error: string }>
  undoMerge(): Promise<{ error?: string }>
  // moved and missing folders (4/5)
  relocateCheck(id: string, from: string, to: string): Promise<RelocateCheck>
  /** point the folder at `to`; the old path joins its past paths. Nothing on disk changes. */
  relocateFolder(id: string, from: string, to: string): Promise<{ project: ProjectRecord; staleWorktrees: string[] } | { error: string }>
  /** existing clones with the project's git remote, not in any project yet */
  cloneSuggestions(id: string): Promise<string[]>
  /** the Unfiled inbox (#74): folders sessions ran in that match no project */
  unfiled(): Promise<UnfiledState>
  unfiledScan(): Promise<UnfiledState>
  unfiledIgnore(paths: string[]): Promise<void>
  unfiledRestore(paths: string[]): Promise<void>
  unfiledDismiss(path: string, suggestionId: string): Promise<void>
  unfiledSeen(): Promise<void>
  /** the folder becomes a past path (alias) of the project's main folder */
  unfiledAddTo(projectId: string, path: string): Promise<{ project: ProjectRecord } | { error: string }>
  reveal(file: string): Promise<void>
  openFolder(dir: string): Promise<void>
  /** in VS Code, in root's window when given */
  openFile(file: string, root?: string): Promise<void>
  listDir(dir: string): Promise<{ entries: FileEntry[]; truncated: number }>
  /** mounted drive roots ("C:\"), or "/" off Windows */
  listDrives(): Promise<FileEntry[]>
  /** home, desktop, documents, downloads */
  listPlaces(): Promise<FilePlace[]>
  previewFile(file: string): Promise<FilePreview>
  remoteList(): Promise<RemoteSnapshot>
  /** passwords go one way: in. The renderer only ever learns whether one is stored. */
  remoteSave(input: RemoteSystemInput): Promise<RemoteSystemView>
  remoteDelete(id: string): Promise<void>
  remoteTest(id: string): Promise<{ ok: boolean; message: string }>
  remoteForgetHost(id: string): Promise<void>
  remoteDecide(id: string, approve: boolean): Promise<void>
  /** newest first */
  remoteAudit(limit?: number): Promise<AuditEntry[]>
  /** connectors and connections (#87), for inspecting; no secrets, only whether each slot is set */
  connectionsState(): Promise<ConnectionsState>
  connectionsAudit(limit?: number): Promise<ConnectionAuditEntry[]>
  /** the kill switch: refuses every connector call while on */
  connectionsKillAll(on: boolean): Promise<void>
  connectionsDisableConnector(id: string, off: boolean): Promise<void>
  /** write-only: answers whether the slot is now set */
  connectionsSetSecret(id: string, slot: string, value: string | null): Promise<boolean>
  /** the Connections tab (#88) */
  connectionsSave(input: ConnectionInput): Promise<ConnectionView>
  connectionsDelete(id: string): Promise<void>
  connectionsTest(id: string): Promise<{ ok: boolean; message: string }>
  /** call's log and run_on's, newest first; scrubbed, never a result */
  connectionsAuditAll(limit?: number): Promise<ConnectionAuditEntry[]>
  connectionsConnector(id: string): Promise<ConnectorDetail | undefined>
  connectionsDecideConnector(id: string, hash: string, approve: boolean): Promise<void>
  connectionsCheckManifest(text: string): Promise<ManifestCheck>
  connectionsImportManifest(text: string): Promise<string>
  connectionsDeleteConnector(id: string): Promise<void>
  connectionsOpenManifest(): Promise<string | undefined>
  connectionsExportAudit(): Promise<boolean>
  connectionsPlanRequest(id: string, req: UserRequest): Promise<UserRequestPlan | UserRequestRefusal>
  connectionsSendRequest(id: string, reqId: string, req: UserRequest, confirmed: RequestClass | null): Promise<UserResponse | UserRequestRefusal>
  connectionsCancelRequest(reqId: string): Promise<void>
  connectionsSaveResponseNote(name: string, text: string): Promise<{ id?: string; error?: string }>
  /** opens docs/CONNECTORS.md; false when this install has no copy */
  connectionsOpenDoc(): Promise<boolean>
  /** connectors agents proposed and connections they asked for (#92); only the user decides, here */
  connectionsDrafts(): Promise<DraftsState>
  connectionsApproveDraft(id: string, hash: string, scope: 'project' | 'global'): Promise<void>
  connectionsDeclineDraft(id: string, reason?: string): Promise<void>
  connectionsExtendDraft(id: string): Promise<void>
  connectionsDeleteDraft(id: string): Promise<void>
  connectionsPromoteConnector(id: string): Promise<void>
  connectionsSetRequest(id: string, status: 'done' | 'dismissed'): Promise<void>
  remotePickKey(): Promise<string | undefined>
  /** false if cancelled */
  remoteExport(): Promise<boolean>
  /** the user's stored profile picture (a square PNG), or null for the letter marker */
  profileAvatar(): Promise<Uint8Array | null>
  /** the system file picker; the chosen file's bytes, never its path. null when cancelled. */
  profilePick(): Promise<{ bytes: Uint8Array } | { error: string } | null>
  /** stores the processed square PNG made in the window */
  profileSave(bytes: Uint8Array): Promise<void>
  profileRemove(): Promise<void>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  /** the agent-ping settings (#195): turning wake-ups on asks in a native dialog first */
  setAgentPings(patch: Partial<Pick<AppConfig, 'agentPings' | 'agentPingWake' | 'agentPingLimits'>>): Promise<AppConfig>
  agentPingStats(): Promise<AgentPingStats>
  /** the Claude Code path (#194): a native file picker, Check (runs only `<path> --version`), and Save or Reset (null) */
  claudePathBrowse(): Promise<string | undefined>
  claudePathCheck(path: string): Promise<ClaudePathCheck>
  claudePathSet(path: string | null): Promise<ClaudePathSaved>
  /** look through a project's files for likely secrets (#91): file, line and kind, never a value */
  scanSecrets(root: string): Promise<SecretScan>
  /** the data-folder rules agents always get: this copy's and the real app's */
  denyInfo(): Promise<{ dataFolders: string[]; platform: string }>
  /** edit commands act on whatever has focus, like their shortcuts; replace/learn take the word, copyText the text */
  contextMenuRun(action: ContextMenuAction, arg?: string): Promise<void>
  // guided tours (#214)
  toursUser(): Promise<{ tours: Tour[]; skipped: string[] }>
  toursState(): Promise<ToursState>
  toursOffered(): Promise<ToursState>
  tourFinished(id: string): Promise<ToursState>
  tourHinted(id: string): Promise<ToursState>
  toursFolder(): Promise<string>
  voiceStatus(): Promise<VoiceStatus>
  /** what the desktop offers: a tray, tray clicks, notifications, a Wayland session (#158) */
  desktopInfo(): Promise<DesktopInfo>
  voiceStart(id: string, keyterms: string[]): Promise<void>
  /** 16 kHz mono signed 16-bit little-endian PCM */
  voiceAudio(id: string, chunk: Uint8Array): void
  voiceStop(id: string): void
  /** which OS and how to name its modifier key (#149); shortcuts read it through keys.ts (#156) */
  platform: PlatformInfo
  on<K extends keyof Events>(channel: K, cb: (...args: Events[K]) => void): () => void
}

export const api = (window as unknown as { api: Api }).api
