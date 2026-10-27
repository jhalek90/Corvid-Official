import type { AgentPingLimits } from './agentPings'
import type { ThemeId } from './themes'
import type { BoardVoice } from './boardVoice'
import type { WelcomeMode } from './welcome'
import type { BoardAttachment } from './board'
import type { ReasoningEffort, ReasoningEffortSetting } from './reasoningEffort'

/** Work/Hobby, no longer shown or set (#82); kept only to type the values older files still hold. */
export type ProjectTag = 'work' | 'hobby'

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface SubagentInfo {
  id: string
  type: string
  description: string
}

export interface SessionSummary {
  id: string
  file: string
  projectDir: string
  cwd: string
  projectName: string
  title: string
  firstPrompt: string
  lastPrompt: string
  startedAt: number
  lastActivity: number
  gitBranch?: string
  entrypoint?: string
  userTurns: number
  assistantMsgs: number
  toolCalls: number
  tools: Record<string, number>
  models: Record<string, number>
  tokens: TokenTotals
  costUsd: number
  /** tokens the latest main-thread reply was sent with; 0 = no reply yet, or just compacted */
  context: number
  peakContext: number
  /** first reply's context minus the user's own words: system prompt, tools, CLAUDE.md, memory */
  baseContext: number
  subagents: SubagentInfo[]
  /** file path -> number of Edit/Write calls on it */
  editedFiles: Record<string, number>
  /** local date -> output tokens */
  dailyOutput: Record<string, number>
  /** distinct clock hours with at least one reply */
  activeHours: number
  sizeBytes: number
  /** transcript was removed by Claude Code's cleanup; summary kept for history */
  deleted: boolean
  /** no assistant turns at all, e.g. scripted `claude /usage` polls */
  junk: boolean
}

export type LiveStatus = 'busy' | 'idle' | 'waiting' | 'blocked' | string

export interface LiveSession {
  pid: number
  sessionId: string
  cwd: string
  status: LiveStatus
  waitingFor?: string
  name?: string
  kind?: string
  entrypoint?: string
  statusUpdatedAt?: number
  /** pty id when the process runs inside a dashboard terminal */
  termId?: string
}

export interface QuotaBar {
  label: string
  pct: number
  resetsAt: string
  resetsAtMs?: number
}

export interface UsageQuota {
  fetchedAt: number
  session?: QuotaBar
  weeks: QuotaBar[]
  notes: { heading: string; lines: string[] }[]
  error?: string
}

export interface MinuteBucket {
  t: number
  output: number
  input: number
}

export interface LiveTokens {
  minutes: MinuteBucket[]
  today: TokenTotals & { costUsd: number; messages: number; sessions: number }
}

export interface DailyModelTokens {
  date: string
  byModel: Record<string, number>
}

export interface UsageStats {
  daily: DailyModelTokens[]
  /** [weekday 0=Sun][hour] -> assistant messages over the window */
  heatmap: number[][]
  heatmapDays: number
  topProjects: { name: string; cwd: string; output: number; costUsd: number; sessions: number }[]
  totals: { sessions: number; costUsd: number; output: number; messages: number }
}

export interface ActivityEvent {
  ts: number
  kind: 'prompt' | 'tool' | 'say'
  tool?: string
  label: string
  /** set when the event came from a subagent's transcript */
  agent?: string
}

export interface AgentActivity {
  id: string
  type: string
  description: string
  lastTs: number
  lastLabel: string
}

/** Rolling "what is it doing" state for one session, derived from its transcript tail. */
export interface SessionActivity {
  sessionId: string
  turnStartedAt: number
  turnPrompt: string
  turnFiles: string[]
  turnTools: number
  turnOutput: number
  lastText: string
  lastTextAt: number
  agents: AgentActivity[]
  /** minute epoch -> output tokens, last 30 minutes of activity */
  minutes: Record<string, number>
  events: ActivityEvent[]
}

export interface TranscriptEntry {
  role: 'user' | 'assistant'
  ts: number
  text: string
}

export interface SearchHit {
  sessionId: string
  role: 'user' | 'assistant'
  ts: number
  snippet: string
  matchStart: number
  matchLength: number
}

export interface IndexProgress {
  done: number
  total: number
  ready: boolean
}

export interface TerminalInfo {
  termId: string
  title: string
  cwd: string
  sessionId?: string
  kind: 'claude' | 'shell'
  /** name (goofy or plain) of an agent the dashboard spawned (a worker, a New project session), shown as its label */
  agentName?: string
  /** lives in the sidebar terminal panel rather than the Terminals view */
  side?: boolean
  /** which ShellOption a sidebar terminal runs, for restarting it */
  shell?: string
  exited?: number
  createdAt: number
}

/** A shell the sidebar terminal can open; only ones installed on this machine are listed. */
export interface ShellOption {
  id: string
  label: string
}

export type LaunchMode = 'resume' | 'fork' | 'new'

export type ResumeMentioned = 'auto' | 'ask' | 'off'

export interface AppConfig {
  /** the picked theme, shown unless themeFollowSystem is on */
  theme: Theme
  /** switch between themeLight and themeDark with the OS's light/dark setting */
  themeFollowSystem: boolean
  /** the last light and dark themes picked; Follow system and the title-bar toggle use them */
  themeLight: Theme
  themeDark: Theme
  usagePollSec: number
  notifications: boolean
  openAtLogin: boolean
  hotkey: string
  claudePath?: string
  /** from before #82: kept in config.json as it was (the config is saved whole), never read */
  tagOverrides?: Record<string, ProjectTag>
  /** project folder paths, as first pinned */
  pinnedProjects: string[]
  /** folders added with New project; shown on the board even before Claude has a session there */
  addedProjects: { path: string; addedAt: number }[]
  /** risk id -> snoozed until (epoch ms) */
  snoozed: Record<string, number>
  /** default deny patterns (DENY_DEFAULTS) the user switched off (#91) */
  agentDenyOff?: string[]
  /** the user's own patterns of files agents may not read or edit */
  agentDenyExtra?: string[]
  /** project files the user deliberately lets agents read: "Allow this one" */
  agentDenyAllow?: { project: string; file: string }[]
  /** "Let agents propose connectors" (#92); undefined counts as on */
  agentDrafts?: boolean
  /** "Agents may suggest Corvid improvements" (#202): one "Corvid could:" line in a done post; undefined counts as on */
  agentSuggestions?: boolean
  /** "Show suggestion chips under the message box" (#206): chips picked from what's going on; undefined counts as on */
  boardChips?: boolean
  /** the page size of long connector results, in characters (#104); undefined: 20,000 */
  connectorPageChars?: number
  /** per project folder: findingKey()s of scan findings the user chose to ignore */
  secretIgnore?: Record<string, string[]>
  /** folders whose subfolders make up the archive; empty = derived from session history */
  projectRoots: string[]
  assistantMode: AssistantMode
  assistantModel: AssistantModel
  /** the reasoning effort Corvid runs at (#238); 'default' passes nothing, so Claude Code's own default applies */
  assistantEffort: ReasoningEffortSetting
  /** the model the extension scan's classifier runs on (#96); haiku when unset, to keep scans cheap */
  scanModel?: AssistantModel
  assistantPersonality: AssistantPersonality
  workerModel: WorkerModel
  /** the reasoning effort new workers run at (#238); 'default' passes nothing */
  workerEffort: ReasoningEffortSetting
  /** the user's name on the board, typed in Settings ("Your name"); '' shows as "user", which always addresses them too */
  userName: string
  /** give spawned agents goofy job-title names ("Senior Pixel Plumber"); off = plain ones ("Text Selector Agent") */
  goofyNames: boolean
  /** the user's board messages with no @mention go to Corvid (and a reply to an agent's message to that agent) (#69) */
  untaggedToCorvid: boolean
  /** draw agents' and Corvid's board messages with light formatting and highlights (#126); off = plain text. Display only */
  formatMessages: boolean
  /** what happens when the user @mentions an agent that has ended: resume it, offer a Resume button, or nothing */
  resumeMentioned: ResumeMentioned
  /** the user @mentioning a running agent types a short "Board: ..." message into its terminal once it's idle (#80) */
  wakeTagged: boolean
  /** agents' @mentions of running agents and @corvid are delivered like the user's (#195); off by default */
  agentPings: boolean
  /** an agent's ping can resume a finished agent (#195); only works while agentPings is on; off by default */
  agentPingWake: boolean
  /** the caps on agent pings (#195) */
  agentPingLimits: AgentPingLimits
  /** how agents sound on the message board; applies to workers started after it changes */
  boardVoice: BoardVoice
  /** the user's own guide, used when boardVoice is 'custom' (at most CUSTOM_VOICE_MAX characters) */
  boardVoiceCustom: string
  /** Corvid's "welcome back" on the board when the user opens the app (#122): off, the greeting only, or with a quick status */
  welcomeMessage: WelcomeMode
  /** message board messages older than this many days are removed (7 to 30) */
  boardKeepDays: number
  /** ids of extensions under src/extensions switched off (#102): they register nothing; any id not listed is on */
  disabledExtensions: string[]
  /** conversation to resume when the assistant process starts */
  assistantSessionId?: string
  limits: WorkerLimits
  /** the user confirmed once that they want more than CONFIRM_WORKERS_ABOVE workers at once; Settings asks only the first time */
  manyWorkersOk: boolean
  /** what a worker does with git: a task branch in its own worktree, merged when done; or the old way */
  agentGit: AgentGitMode
  /** per project (by projectKey), overriding agentGit */
  agentGitOverrides: Record<string, AgentGitMode>
  /** push the default branch after a worker's merge (never forced); off by default */
  pushAfterMerge: boolean
  /** on launch, fetch the public repo (`upstream`) and say when it has updates (#143); notify only */
  updateCheck: boolean
  /** the upstream/main commit the update banner was dismissed for; it shows again when upstream moves on */
  updateDismissed?: string
  /** the soft budget cap for extension builds (#97): ask Continue or Stop at this multiple of the likely estimate */
  extensionCapMultiple: number
  /** close an agent this many minutes after its done post, once it's idle and nothing else holds it (#70); 0 = never */
  closeFinishedMinutes: number
  /** where a view that isn't open anywhere opens (#109): a new pane split off an existing one, or a tab; unset is 'split' */
  openViews?: 'split' | 'tab'
  /** the live ticker along the bottom edge: the latest action across sessions and agents */
  ticker: boolean
  /** the crow mascot that wanders around the window */
  crow: boolean
  /** offer guided tours (#214): the first-run card and the board's "Show me around" chip; unset is on */
  offerTours?: boolean
  /** each live agent gets its own bird that flies about like the mascot; the mascot switch turns them off too */
  agentBirds: boolean
  /** each agent shows its own random crow; off, they all show the plain theme crow */
  agentAvatars: boolean
  /** how the crow looks, for both the mascot and the assistant's avatar */
  crowLook: CrowLook
}

export type CrowHat = 'none' | 'top' | 'wizard' | 'party' | 'cap' | 'crown' | 'beanie' | 'tricorn'
export type CrowExtra = 'none' | 'glasses' | 'bowtie'

export interface CrowLook {
  /** #rrggbb colours; unset keeps the theme's own crow */
  body?: string
  beak?: string
  eye?: string
  /** the sheen on the feathers, and the trim on hats and accessories */
  accent?: string
  hat: CrowHat
  extra: CrowExtra
}

export interface GitCommit {
  hash: string
  subject: string
  ts: number
  author: string
}

export interface GitInfo {
  /** the path that was asked about */
  path: string
  repoRoot: string
  /** repo found in a subfolder rather than at/above the path */
  nested: boolean
  branch: string
  upstream?: string
  ahead: number
  behind: number
  changed: number
  untracked: number
  conflicts: number
  remoteUrl?: string
  webUrl?: string
  lastCommit?: GitCommit
  /** workers' task branches with commits the default branch doesn't have */
  agentBranches?: { name: string; ahead: number }[]
  checkedAt: number
  error?: string
}

export interface GitChange {
  status: string
  path: string
}

export interface GitDetail {
  commits: GitCommit[]
  changes: GitChange[]
}

/** a label on a commit in the graph; `worktree` is the folder of another worktree that has it checked out */
export interface GraphRef {
  kind: 'branch' | 'remote' | 'tag' | 'head' | 'worktree'
  name: string
  /** the branch HEAD points at */
  current?: boolean
  worktree?: string
}

export interface GraphCommit extends GitCommit {
  parents: string[]
  refs: GraphRef[]
}

export interface GitGraph {
  /** newest first, in topological order (children before parents) */
  commits: GraphCommit[]
  /** more commits exist beyond the limit asked for */
  truncated: boolean
  /** hash HEAD points at, if it points at a commit */
  head?: string
  error?: string
}

export interface ArchiveEntry {
  path: string
  name: string
  root: string
  mtime: number
  hasGit: boolean
}

/** one row in the file explorer */
export interface FileEntry {
  name: string
  path: string
  dir: boolean
}

/** a named starting point for the explorer: home, desktop, a drive... */
export interface FilePlace {
  name: string
  path: string
}

/** head of a file for the explorer's preview pane; binary files carry no text, images come as a data URL (null when too big) */
export type FilePreview =
  | { size: number; text: string; truncated: boolean }
  | { size: number; binary: true }
  | { size: number; image: string | null }

export interface ClaudeBinary {
  path: string
  version: string
  /** where it was found; 'config' is the path the user chose in Settings (#194) */
  source: string
}

/** Settings' Check on a chosen Claude Code path (#194): the version, or a plain reason it can't be used. */
export type ClaudePathCheck = { ok: true; path: string; resolved?: string; version: string } | { ok: false; error: string }

/** Saving or resetting the Claude Code path: ok false with no error is Cancel in the confirmation. */
export interface ClaudePathSaved {
  ok: boolean
  error?: string
  claude: ClaudeBinary | null
}

/** 'done' (#138) holds finished tasks until they're removed; nothing is started on them */
export type TaskColumn = 'backlog' | 'next' | 'doing' | 'done'
/** the board's columns, left to right */
export const TASK_COLUMNS = ['backlog', 'next', 'doing', 'done'] as const satisfies readonly TaskColumn[]

export interface Task {
  id: number
  title: string
  notes: string
  column: TaskColumn
  /** position within its column, ascending */
  order: number
  /** the project's id (projects.json); set from the path on load for older tasks */
  projectId?: string
  /** the project's folder when the task was made or last resolved; kept so older tools still work */
  project?: string
  /** which of a multi-folder project's folders to work in (3/5), by path; unset = the primary folder */
  folder?: string
  sessionId?: string
  /** what raised it, e.g. a risk id like "d:\projects\example:no-git", or "error" */
  source?: string
  /** tasks this one should wait for, a soft hint only (blockers.ts); ids of deleted tasks are ignored */
  blockedBy?: number[]
  /** the model workers on this task run on (#136); unset = the worker model from Settings */
  model?: AssistantModel
  /** files the user attached in the task editor or on its card (#187), copied into task-files/t<id>/ in the data folder.
   *  Only the window adds or removes them: the task tools can't, and agents read them through read_task_file. */
  attachments?: BoardAttachment[]
  createdAt: number
  updatedAt: number
}

export interface TaskFile {
  nextId: number
  tasks: Task[]
}

/** a theme's id; the themes themselves are in themes.ts */
export type Theme = ThemeId

// ---------- assistant ----------

export type AssistantMode = 'auto' | 'ask'
export type AssistantModel = 'haiku' | 'sonnet' | 'opus' | 'fable'
/** tone of the assistant's replies; 'default' is the original behaviour */
export type AssistantPersonality = 'default' | 'strict' | 'casual'
/** 'default' = whatever Claude Code is configured to use */
export type WorkerModel = 'default' | AssistantModel

/** branches = a feature branch per task, merged into the default branch when done; current = commit where it is */
export type AgentGitMode = 'branches' | 'current'

export interface WorkerLimits {
  /** concurrent workers, 1 to HARD_MAX_WORKERS (@shared/workerLimits) */
  maxWorkers: number
  /** check usage before starting a new agent at all (#93); off means no check and no prompt */
  usageLimit: boolean
  /** a new agent at or above this 5-hour usage % asks first (or is blocked) */
  gate5h: number
  /** the 5-hour gate is used; off is "no limit" */
  gate5hOn: boolean
  /** a new agent at or above this weekly usage % asks first (or is blocked) */
  gateWeek: number
  /** the weekly gate is used; off is "no limit" */
  gateWeekOn: boolean
  /** above a gate: ask the user in a dialog first (the default), or refuse as before #93 */
  overLimit: 'ask' | 'block'
  /** stop a worker after this many minutes of work: sleep and waiting for the user don't count (#81) */
  workerMinutes: number
}

/** Close finished agents after this many quiet minutes: 0 is off, otherwise 1 to this. */
export const CLOSE_FINISHED_MAX = 60

export interface Worker {
  id: string
  taskId: number
  taskTitle: string
  /** its name (a goofy job title, or a plain one with Goofy agent names off), the main label */
  agentName?: string
  /** its random crow, made by the dashboard when it started (agentAvatar.ts) */
  avatar?: CrowLook
  model: WorkerModel
  /** the reasoning effort it was started with (#238); absent: Claude Code's default */
  effort?: ReasoningEffort
  termId: string
  project: string
  /** when this run began: a fresh time on every start, restart or resume */
  startedAt: number
  /** its time-limit clock (@shared/workerClock): work banked so far, and when the current counting stretch began */
  workedMs: number
  clockFrom?: number
  /** why its clock isn't counting: the PC is asleep, or it's waiting on you */
  paused?: 'sleep' | 'you'
  /** running = process alive; stopped = killed by limit or user; finished = closed by the dashboard after its done post
   *  and a quiet spell (#70); exited = process ended */
  state: 'running' | 'stopped' | 'finished' | 'exited'
  liveStatus?: LiveStatus
  sessionId?: string
  endedAt?: number
  reason?: string
  /** its task branch, when it works on one */
  branch?: string
  /** the folder it works in, when that's a worktree rather than the project folder */
  worktree?: string
  /** where its branch stands; message says why it was kept or what went wrong */
  git?: { state: 'working' | 'merged' | 'kept' | 'removed'; message?: string }
  /** when it posted its done post (post_message with done: true) in this turn of work; cleared once it works again */
  doneAt?: number
  /** while the countdown to closing a finished agent runs: when it ends (epoch ms) */
  closeAt?: number
  /** finished, but kept open because closing could lose work ("Finished, but has unmerged work") */
  closeHeld?: string
  /** the user pressed Keep open: no countdown until it works and posts done again */
  keepOpen?: boolean
}

export interface Proposal {
  id: string
  taskId: number
  taskTitle: string
  project: string
  instructions?: string
  createdAt: number
}

/** `board` on a chat item: the board message (its id) the user addressed to @corvid, and on Corvid's answer the same id,
 *  since that answer was also posted on the board. */
export type ChatItem =
  | { kind: 'user'; id: string; ts: number; text: string; board?: number }
  | { kind: 'assistant'; id: string; ts: number; text: string; streaming?: boolean; board?: number }
  | { kind: 'tool'; id: string; ts: number; name: string; input: unknown; status: 'running' | 'ok' | 'error'; result?: string }
  | { kind: 'note'; id: string; ts: number; text: string; tone: 'info' | 'warn' | 'error' }

export type AssistantState = 'offline' | 'starting' | 'idle' | 'thinking' | 'tool' | 'error'

export interface AssistantSnapshot {
  state: AssistantState
  chat: ChatItem[]
  workers: Worker[]
  proposals: Proposal[]
  /** why a limit would refuse a new worker right now (from the last known usage), if one would */
  blocker?: string
  lastTurn?: { costUsd: number; outputTokens: number; durationMs: number }
  /** from the CLI's rate_limit_event, 0-100 */
  liveQuota?: { fiveHour: number; week: number; at: number }
  /** the user's @corvid board messages that are waiting, being answered, or failed */
  boardAsks: BoardAsk[]
  /** the slash commands the board box offers (#71); missing until main sends a snapshot */
  commands?: import('./slashCommands').CommandList
}

/** One of the user's @corvid board messages on its way to Corvid. Answered ones are dropped: the reply is on the board. */
export interface BoardAsk {
  /** the board message */
  id: number
  /** skipped: an untagged message Corvid judged was for someone else, so it posted nothing */
  status: 'queued' | 'replying' | 'failed' | 'skipped'
  error?: string
}

export interface VoiceStatus {
  /** dictation runs on this platform at all (Windows only, #160); when false nothing else was checked */
  supported: boolean
  /** a claude.ai login is available to sign the speech-to-text socket */
  enabled: boolean
  /** the OS blocks microphone access for desktop apps */
  micDenied: boolean
  platform: string
}

// ---------- remote systems ----------

/** free = agents run anything; approve-writes = read-only runs freely, the rest waits for you;
 *  strict = every command waits for you. New systems start strict. */
export type SafetyLevel = 'free' | 'approve-writes' | 'strict'
export type RemoteAuth = 'key' | 'password'

/** Connection info only. Passwords and passphrases are kept apart, encrypted, and never leave
 *  the main process; this is what the renderer and exports see. */
export interface RemoteSystem {
  id: string
  /** what agents call it; unique, case-insensitive */
  name: string
  host: string
  port: number
  user: string
  auth: RemoteAuth
  /** path to the private key file (key auth); the key itself is never copied */
  keyPath?: string
  /** project folders whose agents may use this system */
  projects: string[]
  safety: SafetyLevel
  createdAt: number
  updatedAt: number
}

export interface RemoteSystemView extends RemoteSystem {
  hasPassword: boolean
  hasPassphrase: boolean
  /** remembered host key, e.g. "ssh-ed25519 SHA256:…" */
  hostKey?: string
}

/** What the renderer sends to save a system. A secret field left undefined keeps the stored
 *  value; null clears it. */
export interface RemoteSystemInput {
  id?: string
  name: string
  host: string
  port: number
  user: string
  auth: RemoteAuth
  keyPath?: string
  projects: string[]
  safety: SafetyLevel
  password?: string | null
  passphrase?: string | null
}

export interface RemoteApproval {
  id: string
  systemId: string
  systemName: string
  target: string
  command: string
  /** e.g. "worker #12" */
  agent: string
  project?: string
  /** why it needs you: the system is strict, or the command isn't recognised as read-only */
  why: string
  createdAt: number
  expiresAt: number
  /** 'connector' = first use of a connector version (#87); otherwise a command or operation */
  kind?: 'command' | 'connector'
  /** for a connector: the plain-language summary and the details shown under it */
  summary?: string
  details?: { label: string; items: string[] }[]
  /** a broad connector, or an admin operation: warn loudly */
  warn?: string
}

export type AuditDecision = 'auto' | 'approved' | 'denied' | 'timeout' | 'refused'

export interface AuditEntry {
  ts: number
  system: string
  target: string
  /** scrubbed of known secrets */
  command: string
  agent: string
  project?: string
  safety: SafetyLevel
  readOnly: boolean
  decision: AuditDecision
  /** "user", "auto (free)", "auto (read-only)", or why it was refused */
  approvedBy: string
  exitCode?: number | null
  error?: string
  durationMs?: number
  outputBytes?: number
}

// ---------- connections (#87) ----------

/** A user's instance of a connector: settings, which secret slots hold a value, safety level, linked projects.
 *  Slot references point into Corvid's encrypted store; the values never leave the main process. */
export interface Connection {
  id: string
  connectorId: string
  /** what agents call it; unique, case-insensitive */
  name: string
  /** non-secret settings, keyed by the manifest's config fields */
  config: Record<string, string | number | boolean>
  /** slot key -> where its encrypted value lives; main process only, never sent to the renderer */
  secretRefs: Record<string, string>
  safety: SafetyLevel
  /** admin operations run without asking; only honoured on a Free connection */
  adminWithoutAsking: boolean
  /** #73 project ids whose agents may use it; none means no agent sees it */
  projectIds: string[]
  /** project folders from an SSH server that matched no project when it was moved over */
  unlinkedPaths?: string[]
  /** 'remote' = mirrored from an SSH server in the Servers panel */
  origin: 'user' | 'remote'
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

/** What the renderer sees: no slot references, only whether each slot is set. */
export interface ConnectionView extends Omit<Connection, 'secretRefs'> {
  secretsSet: Record<string, boolean>
}

export interface ConnectorInfo {
  id: string
  name: string
  version: string
  runtime: string
  status: 'draft' | 'pending' | 'approved' | 'declined' | 'invalid'
  disabled?: boolean
  hash: string
  source: 'builtin' | 'user' | 'agent'
  draftedBy?: string
  /** an agent's draft, approved for this project only (#92); none: all projects */
  projectId?: string
  approvedHash?: string
  decidedAt?: number
  /** capabilitySummary: the plain-language description */
  summary: string
  operations: { name: string; class: 'read' | 'write' | 'admin' }[]
  errors?: string[]
}

/** Whether secrets can be saved now (#159): the backend safeStorage would use, and why not when they can't. */
export interface SecretStorageStatus {
  available: boolean
  /** dpapi, keychain, or on Linux electron's backend name (gnome_libsecret, kwallet…, basic_text, unknown) */
  backend: string
  /** plain text for the user when not available */
  reason?: string
}

export interface ConnectionsState {
  killSwitch: boolean
  /** whether secrets can be saved now; missing in older snapshots */
  secretStorage?: SecretStorageStatus
  connectors: ConnectorInfo[]
  connections: ConnectionView[]
  migration?: { firstAt: number; runs: number; confirmedAt?: number }
}

/** One connector in full, for the Connections tab (#88): the manifest is data only, slot labels, never a value. */
export interface ConnectorDetail extends ConnectorInfo {
  description: string
  targets: string[]
  reads: string[]
  writes: string[]
  admin: string[]
  secretLabels: string[]
  broad: boolean
  /** the manifest, formatted */
  manifestText: string
  /** the last approved version, when the one on disk differs from it */
  previousText?: string
  /** names of the connections that use it */
  usedBy: string[]
  /** what each connection fills in: settings, and the labels of its secret slots */
  configFields: { key: string; label: string; type: string; required?: boolean; default?: string | number | boolean; description?: string }[]
  secretSlots: { key: string; label: string; type: string; optional?: boolean }[]
}

/** A connector an agent proposed (#92): data only, inactive until the user approves it in the Connections tab. */
export interface ConnectorDraftView {
  id: string
  connectorId: string
  name: string
  version: string
  hash: string
  status: 'open' | 'approved' | 'declined' | 'replaced' | 'expired'
  agent: string
  agentName?: string
  taskId?: number
  projectId: string
  reason: string
  /** where the agent says the hosts and endpoints came from */
  source?: string
  createdAt: number
  expiresAt: number
  decidedAt?: number
  declineReason?: string
  scope?: 'project' | 'global'
  summary: string
  /** hosts or targets, each marked new when no approved connector reaches it yet */
  targets: { text: string; isNew: boolean }[]
  reads: string[]
  writes: string[]
  admin: string[]
  secretLabels: string[]
  manifestText: string
  /** the approved version this draft would replace, for the diff */
  previousText?: string
  previousVersion?: string
  tests?: { at: number; passed: boolean; results: { name: string; ok: boolean; detail: string }[] }
  testsDeclared: number
}

/** An agent's request that the user set up a connection (#92). The agent can't create one or enter a secret. */
export interface ConnectionRequestView {
  id: string
  connectorId: string
  connectorName: string
  suggestedName: string
  purpose: string
  agent: string
  agentName?: string
  taskId?: number
  projectId: string
  createdAt: number
  status: 'open' | 'done' | 'dismissed'
}

export interface DraftsState {
  enabled: boolean
  drafts: ConnectorDraftView[]
  requests: ConnectionRequestView[]
}

export type ManifestCheck ={ ok: true; id: string; name: string; version: string; summary: string; exists: boolean } | { ok: false; errors: string[] }

export type CallDecision = 'automatic' | 'approved' | 'denied' | 'timed out' | 'refused'

export interface ConnectionAuditEntry {
  ts: number
  agent: string
  project?: string
  connection: string
  connector: string
  operation: string
  class: 'read' | 'write' | 'admin'
  decision: CallDecision
  /** why it was refused, or who approved */
  detail?: string
  /** scrubbed of every known secret and its encodings */
  request: string
  resultBytes?: number
  durationMs?: number
  error?: string
  /** a paged result (#104): the page read, of how many, the held result's id and the bytes the agent got */
  page?: number
  pages?: number
  resultId?: string
  returnedBytes?: number
}

/** what Chromium reports about a right-click, forwarded so the renderer can draw the menu */
export interface ContextMenuInfo {
  selectionText: string
  isEditable: boolean
  canUndo: boolean
  canRedo: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
  /** empty unless the click was on a word the spell checker flagged */
  misspelledWord: string
  suggestions: string[]
  linkURL: string
}

export type ContextMenuAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'replace' | 'learn' | 'copyText'

/** who wrote a note: you, the assistant, or a spawned agent (a worker) */
export type NoteAuthor = 'user' | 'assistant' | 'agent'

/** A plain-text note, one Markdown file in <data>\notes\ with a small header. */
export interface Note {
  /** "N7": never changes, and never reused after a delete */
  id: string
  name: string
  text: string
  author: NoteAuthor
  /** the agent's goofy name, when an agent wrote it */
  agentName?: string
  /** the task the agent was working on */
  taskId?: number
  project?: string
  created: number
  updated: number
  /** who changed it last: "user", "assistant", an agent label like "Chief Whisperer (#12)", or "outside Corvid" */
  updatedBy?: string
  /** bytes of the text */
  size: number
  /** hash of the file as last read or written; an edit is refused when it no longer matches */
  rev: string
  file: string
  /** written by an agent or the assistant and not opened since */
  unread?: boolean
}

/** One folder of a project. Several per project are allowed (3/5); one is primary. */
export interface ProjectFolder {
  path: string
  primary: boolean
  /** a short name shown on cards and tabs, e.g. "app" or "website" (3/5) */
  label?: string
  /** paths this folder had before a move (4/5); still match sessions and tasks */
  pastPaths: string[]
}

/** A project the user keeps on their list (projects.json). The id never changes and is never reused. */
export interface ProjectRecord {
  id: string
  name: string
  /**
   * Work/Hobby from before #82: no longer shown or written for new projects. Records are saved as loaded,
   * so a stored value stays in projects.json; don't rebuild records field by field or it's lost.
   */
  tag?: ProjectTag
  pinned: boolean
  archived: boolean
  createdAt: number
  folders: ProjectFolder[]
  /** git remote URLs, for spotting a second clone */
  remotes: string[]
  /** the repo's first (root) commit, when it has one */
  firstCommit?: string
  /** Corvid's own project (#78): always on the list, can't be removed or archived */
  builtin?: 'corvid'
}

export interface ProjectsFile {
  version: 1
  nextId: number
  /** the one-time import preview was shown (imported or cancelled) */
  importOffered: boolean
  projects: ProjectRecord[]
  /** the Unfiled inbox's decisions (#74) */
  unfiled?: UnfiledDecisions
}

/** What the user decided in the Unfiled inbox (#74); kept in projects.json so it survives a restart. */
export interface UnfiledDecisions {
  /** folders never to show again, until restored from the Ignored list */
  ignored: { path: string; at: number }[]
  /** suggestions waved away, as "<folder key>|<suggestion id>" */
  dismissed: string[]
  /** when the inbox was last looked at; the Projects badge counts entries active since */
  seenAt: number
}

/** A folder Claude sessions ran in that matches no project and passed the skip rules and thresholds (#74). */
export interface UnfiledEntry {
  path: string
  name: string
  exists: boolean
  isRepo: boolean
  branch?: string
  remote?: string
  /** sessions here that file under no project */
  sessions: number
  lastActivity: number
  /** a one-line hint, e.g. a second clone of a project; id is what Dismiss remembers */
  suggestion?: { id: string; text: string; projectId?: string }
  /** the name or place reads as a throwaway; "Ignore all that look like scratch" picks these */
  scratch: boolean
}

export interface UnfiledState {
  entries: UnfiledEntry[]
  ignored: { path: string; at: number; sessions: number; lastActivity: number }[]
  /** unmatched folders the skip rules hide (worktrees, temp, Corvid's own); never shown or counted */
  hidden: string[]
  /** unmatched folders below the thresholds: not shown yet, still searchable and resumable */
  quiet: number
  seenAt: number
  /** false until the first scan finishes */
  ready: boolean
}

/** What main knows about a folder sessions ran in, for matching it to a project. */
export interface CwdFacts {
  /** the main repo's folder, from the repo's common git directory: a worktree gives its parent repo */
  repo?: string
  /** this folder is a linked git worktree, not the main checkout */
  worktree?: boolean
  remote?: string
}

export interface ProjectsState {
  projects: ProjectRecord[]
  importOffered: boolean
  /** ids of projects whose primary folder doesn't exist (shown as missing; 4/5 handles moves) */
  missing: string[]
  /** by normKey of a session's cwd */
  cwds: Record<string, CwdFacts>
  /** normKeys of folders that don't exist; each is shown as missing on its own (3/5) */
  missingFolders?: string[]
  /** a merge that can still be undone (3/5) */
  undoMerge?: { into: string; from: string; until: number }
}

/** What merging one project into another moves (3/5); shown before anything changes. */
export interface MergePreview {
  from: { id: string; name: string }
  into: { id: string; name: string }
  folders: string[]
  sessions: number
  tasks: { id: number; title: string }[]
  notes: { id: string; name: string }[]
  /** settings that come along, in words: pinned, per-folder agent git mode */
  settings: string[]
}

/** A folder the import found, with what the skip rules looked at. */
export interface ImportCandidate {
  path: string
  name: string
  pinned: boolean
  exists: boolean
  isRepo: boolean
  worktree: boolean
  /** the repo a worktree belongs to */
  parentRepo?: string
  remote?: string
  firstCommit?: string
  branch?: string
  sessions: number
  /** sessions Corvid started (task workers, New project, scripted polls) */
  corvidSessions: number
  lastActivity: number
  /** pinned or added by the user in the old model */
  userAdded: boolean
  /** set when the skip rules leave it out; the reason is shown */
  skip?: string
  /** already on the list, so importing it again does nothing */
  already?: boolean
  checked: boolean
}

/** How a folder picked for Locate / Move compares with the project (4/5): same = it looks like the same project. */
export type RelocateCheck = { same: boolean; why: string } | { error: string }
/** Corvid's own project (#78): the installed build, its source checkout and the deploy around them. */
export interface CorvidStatus {
  version: string
  /** the commit the running build was made from, baked in at build time ('' if unknown) */
  commit: string
  builtAt: number
  /** built with uncommitted changes */
  dirty: boolean
  packaged: boolean
  /** '' in a dev run */
  installDir: string
  projectId?: string
  /** the project's folder, when it holds Corvid's source; undefined = "Source not set up" */
  source?: string
  canClone: boolean
  cloneUrl?: string
  git?: { branch: string; changed: number; ahead: number; behind: number; installedBehind?: number; error?: string }
  /** earlier installs kept beside the install folder, newest first */
  previous: { name: string; commit?: string; at: number }[]
  /** a rebuild started from here; waiting = holding until agents finish */
  deploy?: { started: number; waiting: boolean; error?: string }
  /** what the last deploy wants the user to know (a rollback), until dismissed */
  notice?: string
}

export interface SetupItem {
  name: string
  ok: boolean
  detail: string
  fix?: string
}

/** What the desktop offers (#158), for Settings: a tray to close to, tray clicks (Linux trays only open the menu),
 *  desktop notifications (Linux needs a notification daemon), and a Wayland session (hotkeys need the portal). */
export type DesktopInfo = { tray: boolean; trayClicks: boolean; notifications: boolean; wayland: boolean }
