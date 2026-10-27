import { app } from 'electron'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  bumpVersion,
  checkDraft,
  deriveCapabilities,
  emptyPackager,
  packagerEstimate,
  headerField,
  MAX_TURNS,
  parseAgentReply,
  PLANNING_TURNS,
  setHeaderField,
  uniqueId,
  type LeakContext,
  type MergedFeature,
  type PackagerMessage,
  type PackagerMode,
  type PackagerState
} from '@shared/packager'
import { compareVersions, type ParsedExtension } from '@shared/extensions'
import { deterministicScan } from '@shared/extensionScan'
import { thesisDose } from '@shared/corvidThesis'
import { claudeDefaultModel, resolveClaude } from './claudeBin'
import { agentSettingsArgs } from './agentDeny'

// The packaging wizard (#100, Extensions 6/8). A chat in the Extensions tab, run by a "packaging agent": short
// `claude -p` turns, resumed by session id, in Corvid's own source folder with read-only tools (Read, Glob, Grep),
// no MCP servers and the deny rules (#91), so it can read the user's source but never secrets, connections or the
// data folder. Corvid gathers the git facts itself, fixes the header facts it knows (version, author, built_on, the
// measured effort), and runs the validator (#95) and a leak scan over every draft. Nothing here installs, builds,
// deploys or shares anything: the result is text, saved as a created extension that is "Not installed yet".
// The chat and the user's replies stay on this machine, in packager.json in the data folder.

export interface PackagerDeps {
  /** Corvid's own source folder (the built-in project), or undefined when it isn't on this machine */
  sourceDir: () => string | undefined
  ledgerIds: () => string[]
  /** a task's title and notes, when it still exists */
  task: (id: number) => { title: string; notes: string } | undefined
  /** board posts about a task, oldest first */
  boardPosts: (taskId: number) => string[]
  /** minutes an agent worked on a task, when known */
  minutesFor: (taskId: number) => number | undefined
  userName: () => string
  claudePath: () => string | undefined
  /** the user's project names and connection names, and hosts from their connections: never allowed in the output */
  leaks: () => LeakContext
  /** Corvid's version and the commit it was built from */
  build: () => { version: string; commit: string }
  /** the same checks as starting any agent: a free slot and the usage prompt (#93). Null to go ahead. */
  blocker: (label: string) => Promise<string | null>
  detail: (key: string) => { text: string; id: string; version: string } | null
  save: (text: string, replaceKey?: string, features?: string[]) => { ok: true; key: string } | { error: string }
  /** the freshest 5-hour usage, 0-100, when known */
  fiveHour: () => number | undefined
  changed: (s: PackagerState) => void
}

let deps: PackagerDeps
let state: PackagerState = emptyPackager()
let sessionId: string | undefined
let proc: ChildProcessWithoutNullStreams | null = null
let nextId = 1
/** what the diff said, for the leak scan and the header; in memory only, never stored */
let diffHosts: string[] = []
let measured: { files?: number; minutes?: number } = {}

const file = (): string => join(app.getPath('userData'), 'packager.json')

function persist(): void {
  try {
    const tmp = file() + '.tmp'
    writeFileSync(tmp, JSON.stringify({ version: 1, author: state.author, session: state.messages.length ? { ...state, busy: false, features: undefined } : null, sessionId, nextId }, null, 1))
    renameSync(tmp, file())
  } catch (e) {
    console.error('[packager] could not save the wizard draft', e)
  }
}

function changed(): void {
  persist()
  deps.changed(snapshot())
}

export function initPackager(d: PackagerDeps): void {
  deps = d
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { author?: string; session?: PackagerState | null; sessionId?: string; nextId?: number }
    state = raw.session ? { ...emptyPackager(), ...raw.session, busy: false, open: false } : emptyPackager()
    state.author = typeof raw.author === 'string' && raw.author.trim() ? raw.author : d.userName()
    sessionId = raw.session ? raw.sessionId : undefined
    nextId = raw.nextId ?? 1
  } catch {
    state = emptyPackager(d.userName())
  }
}

export const snapshot = (): PackagerState => ({ ...state, messages: [...state.messages] })

const say = (from: PackagerMessage['from'], text: string, extra: Partial<PackagerMessage> = {}): void => {
  state.messages.push({ id: nextId++, from, text, at: Date.now(), ...extra })
}

// ---------- git ----------

const git = (cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('git', args, { cwd, windowsHide: true, timeout: 20_000, encoding: 'utf8', maxBuffer }, (e, out) => (e ? reject(e) : resolve(out)))
  )

const MERGE_RE = /^Merge task-(\d+)-[^:]*:\s*(?:#\d+\s*)?(.*)$/

/** Recent merged features: merge commits of task branches on the source's current branch (#45). */
export async function listFeatures(): Promise<MergedFeature[] | { error: string }> {
  const dir = deps.sourceDir()
  if (!dir) return { error: "Corvid's source isn't on this machine, so there are no built features to pick from. Start from scratch instead." }
  let log: string
  try {
    log = await git(dir, ['log', '--merges', '--first-parent', '-n', '60', '--format=%h%x1f%ct%x1f%s'])
  } catch (e) {
    return { error: `Couldn't read the git history: ${(e as Error).message}` }
  }
  const rows = log.split('\n').map((l) => l.split('\x1f')).filter((r) => r.length === 3 && MERGE_RE.test(r[2]))
  const out: MergedFeature[] = []
  for (const [commit, ct, subject] of rows.slice(0, 40)) {
    const m = MERGE_RE.exec(subject)!
    const taskId = Number(m[1])
    let files: string[] = []
    try {
      files = (await git(dir, ['diff', '--name-only', `${commit}^1`, commit])).split('\n').filter(Boolean)
    } catch {
      /* a root merge or a pruned parent: no files */
    }
    out.push({ commit, taskId, title: deps.task(taskId)?.title ?? m[2], date: Number(ct) * 1000, files, minutes: deps.minutesFor(taskId) })
  }
  return out
}

const DIFF_CAP = 60_000
const SKIP_DIFF = [':(exclude)package-lock.json', ':(exclude)*.png', ':(exclude)*.ico', ':(exclude)*.jpg']

/** What the agent reads privately about the picked features: task notes, board posts, commit messages and the diff. */
async function featureContext(commits: string[]): Promise<string> {
  const dir = deps.sourceDir()!
  const features = state.features ?? []
  const parts: string[] = []
  const allFiles = new Set<string>()
  const added: string[] = []
  const packages: string[] = []
  let budget = DIFF_CAP
  let minutes = 0
  for (const c of commits) {
    const f = features.find((x) => x.commit === c)
    f?.files.forEach((x) => allFiles.add(x))
    if (f?.minutes) minutes += f.minutes
    const t = f?.taskId ? deps.task(f.taskId) : undefined
    let diff = ''
    try {
      diff = await git(dir, ['diff', '--unified=2', `${c}^1`, c, '--', '.', ...SKIP_DIFF], 16 * 1024 * 1024)
    } catch {
      /* no diff */
    }
    let inPackage = false
    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git')) inPackage = / b\/package\.json$/.test(line)
      else if (line.startsWith('+') && !line.startsWith('+++')) {
        added.push(line)
        const p = inPackage && /^\+\s*"((?:@[\w.-]+\/)?[\w.-]+)":\s*"[~^]?(\d[^"]*)"/.exec(line)
        if (p && !['version', 'node'].includes(p[1])) packages.push(`${p[1]}@${p[2]}`)
      }
    }
    const shown = diff.length > budget ? diff.slice(0, budget) + '\n[the rest of the diff is left out]' : diff
    budget = Math.max(0, budget - shown.length)
    const posts = f?.taskId ? deps.boardPosts(f.taskId).slice(-20) : []
    parts.push(
      [
        `### Feature ${f?.taskId ? `#${f.taskId}` : c}: ${f?.title ?? ''}`,
        t?.notes ? `Task notes:\n${t.notes.slice(0, 6000)}` : 'Task notes: none kept.',
        posts.length ? `Board posts about it:\n${posts.map((p) => `- ${p.slice(0, 600)}`).join('\n')}` : '',
        `Files touched (${f?.files.length ?? 0}): ${(f?.files ?? []).slice(0, 60).join(', ')}`,
        shown ? `The diff (READ ONLY to understand behaviour; never copy any of it):\n${shown}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
    )
  }
  state.derived = deriveCapabilities([...allFiles], added, [...new Set(packages)])
  diffHosts = state.derived.hosts
  measured = { files: allFiles.size, minutes: minutes || undefined }
  const d = state.derived
  parts.push(
    `### What Corvid derived from the diff (evidence for capabilities; the user may correct it)\nTier at least ${d.tier}. Core areas: ${d.coreAreas.join(', ') || 'none'}. New packages: ${d.packages.join(', ') || 'none'}. Hosts in added lines: ${d.hosts.join(', ') || 'none'}. Protected files touched: ${d.protectedFiles.length}.`
  )
  return parts.join('\n\n')
}

// ---------- the packaging agent ----------

const SYSTEM = `You are Corvid's packaging agent, in the Extensions tab's "New extension" wizard. You help the user turn a feature into a .corvid extension: a TEXT file that describes behaviour and carries a seed prompt for another Corvid's build agent. You never install, build, deploy, share or edit anything; you only write text in this chat. Read docs/EXTENSIONS.md for the format, the tiers (src/shared/extensionTiers.ts) and the validator rules before your first outline.

Hard rules for everything you write in the extension:
- Describe BEHAVIOUR, never code. Never copy the author's code, a diff, a patch or long snippets. At most one tiny snippet (a data shape or a regular expression) if it truly helps.
- Nothing author-specific: no file paths (not even Corvid's own src/... layout), no machine, account, user or project names, no hosts the author uses, no connection names, no keys or secrets. Refer to places in plain words ("the board view", "the settings page", "the task model") and to extension points by what they do.
- No instructions to the build agent beyond the build (never "don't tell the user", never "skip the checks").
- The tier must match what it touches: 1 adds files only, 2 changes non-sensitive core, 3 changes protected core.
- A colour theme is tier 1: say in the seed prompt that it is added "through the theme socket, as the extension's own themes registered with Corvid", give each theme a name, light or dark, and its colours by role (backgrounds, panels, text, accent, warning, danger, terminal, syntax), and never as an edit to Corvid's built-in theme list. Declare tier 1 with no core areas.
- The seed prompt must work on any recent Corvid, independent of the author's file layout.

How the chat goes:
1. Understand the feature (from the material you are given, or by interviewing the user briefly: what it should do and why, where it appears, what data it stores, what it must never do, what it needs from the network or other extensions, how to tell it works). One or two questions per reply.
2. Propose a one-screen OUTLINE: name, one-line purpose, behaviours, tier, core areas, packages, hosts, data, requires, acceptance checks in outline. The user edits or approves it. Keep planning to a handful of exchanges.
3. When the user approves, write the full .corvid DRAFT. Corvid fills version, author, built_on and the measured effort numbers itself; put your best values for the rest. Sections in order: Summary, What it does, Seed prompt, Acceptance checks (numbered, concrete, testable), Notes.
4. If Corvid reports problems with a draft, fix them and send a corrected full draft.

The draft's header sits between two lines of three hyphens, one "key: value" per line, with ONLY these keys (leave out an optional one rather than writing "none"):
format: 1
id: a-lowercase-slug
name: a display name, at most 60 characters
version: 1.0.0
description: one line, at most 160 characters
built_on: 0.1.0 @ 0000000 (Corvid replaces it)
effort: small, medium or large
requires: other-extension-id ^1.0.0 (optional, comma-separated)
conflicts: other-extension-id (optional)
capabilities.tier: 1, 2 or 3
capabilities.packages: name@1.2.3 (optional, comma-separated)
capabilities.hosts: api.example.com (optional, host names only)
capabilities.data: in words, what it stores (optional)
capabilities.core_areas: ids from ui, board, tasks, notes, settings, projects, agents (tier 2) and connectors, remote, secrets, deny-rules, limits, backups, crash, deploy, extensions (tier 3); empty for tier 1
capabilities.rebuild: yes or no
Then the sections, each headed "## " exactly: Summary, What it does, Seed prompt, Acceptance checks (lines "1. ", "2. ", ...), Notes (optional).

Reply format: answer with ONE JSON object and nothing else:
{"say": "your message to the user, plain words, short", "quick": ["up to 4 short quick replies"], "outline": {"name": "", "purpose": "", "behaviours": [""], "tier": 2, "coreAreas": [""], "packages": [""], "hosts": [""], "data": "", "requires": [""], "checks": [""]}, "draft": "the full .corvid text"}
Leave out "outline" and "draft" when you have none to propose this time.`

function finishHeader(text: string): string {
  const b = deps.build()
  let t = text.replace(/\r\n?/g, '\n').trim() + '\n'
  t = setHeaderField(t, 'format', '1')
  const taken = deps.ledgerIds().filter((id) => id !== state.editing?.id)
  const id = state.editing?.id ?? uniqueId(headerField(t, 'id') ?? headerField(t, 'name') ?? 'my-extension', taken)
  t = setHeaderField(t, 'id', id)
  const proposed = headerField(t, 'version') ?? '1.0.0'
  const version = state.editing ? (compareVersions(proposed, state.editing.version) > 0 ? proposed : bumpVersion(state.editing.version)) : '1.0.0'
  t = setHeaderField(t, 'version', version)
  t = setHeaderField(t, 'author', state.author.trim() || undefined)
  if (b.commit) t = setHeaderField(t, 'built_on', `${b.version} @ ${b.commit.slice(0, 12)}`)
  if (state.mode === 'built') {
    if (measured.files) t = setHeaderField(t, 'effort.files', String(measured.files))
    if (measured.minutes) t = setHeaderField(t, 'effort.minutes', String(measured.minutes))
  }
  // editing changes the hash, so any verification claim no longer holds (#101 re-verifies)
  for (const k of ['verified.commit', 'verified.at', 'verified.by']) t = setHeaderField(t, k, undefined)
  const checks = (t.split(/^## Acceptance checks\s*$/m)[1] ?? '').split(/^## /m)[0].match(/^\d+\.\s/gm)?.length
  if (checks) t = setHeaderField(t, 'effort.checks', String(checks))
  return t
}

/** The instant text checks from Extensions 2/8 (#96), the same any imported extension gets. Each flag must be fixed
 *  before the draft can be saved; the classifier runs later, from the tab, like for any extension. */
const textScan = (ext: ParsedExtension): string[] =>
  deterministicScan(ext.canonical, ext.header).flags.map((f) => `Text scan: ${f.label}${f.lines[0] ? ` (line ${f.lines[0].line})` : ''}.`)

const draftCheck = (text: string): ReturnType<typeof checkDraft> => checkDraft(text, leakContext(), state.mode === 'built' ? state.derived : undefined, textScan)

function leakContext(): LeakContext {
  const l = deps.leaks()
  let account = ''
  try {
    account = userInfo().username
  } catch {
    /* no account name */
  }
  return { words: [...l.words, account, hostname(), homedir()].filter(Boolean), hosts: [...l.hosts, ...diffHosts] }
}

/** Runs one model turn with `prompt` and handles the reply. */
async function turn(prompt: string): Promise<void> {
  const dir = deps.sourceDir()
  const bin = await resolveClaude(deps.claudePath())
  if (!bin) return fail("Claude Code wasn't found, so the packaging agent can't start.")
  if (state.turns >= MAX_TURNS) return fail(`The wizard stops at ${MAX_TURNS} turns. Save the draft you have, or close and start again.`)
  state.turns++
  state.busy = true
  changed()
  const args = [
    '-p',
    '--output-format', 'json',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', 'Read', 'Glob', 'Grep',
    '--allowedTools', 'Read', 'Glob', 'Grep',
    // the deny rules (#91): never the data folder (secrets, connections, backups) or secret files
    ...agentSettingsArgs(dir, dir),
    // what Corvid is (#202): extensions change the user's own copy, so the full page
    '--append-system-prompt', `${SYSTEM}\n\n${thesisDose('full')}`
  ]
  if (sessionId) args.push('--resume', sessionId)
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(bin.path, args, { cwd: dir ?? app.getPath('temp'), env, windowsHide: true })
  proc = child
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  const timer = setTimeout(() => child.kill(), 5 * 60_000)
  // the prompt goes on stdin: a diff is far longer than a Windows command line allows
  child.stdin.end(prompt)
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  clearTimeout(timer)
  if (proc !== child) return // stopped meanwhile
  proc = null
  state.busy = false
  let result = ''
  try {
    const j = JSON.parse(out.trim().split('\n').pop() ?? '') as { result?: string; session_id?: string; is_error?: boolean }
    if (j.session_id) sessionId = j.session_id
    if (j.is_error) return fail(`The packaging agent's turn ended with an error: ${(j.result ?? '').slice(0, 300)}`)
    result = j.result ?? ''
  } catch {
    return fail(code ? `The packaging agent stopped (exit ${code}). ${err.slice(0, 300)}` : 'The packaging agent gave no answer.')
  }
  handleReply(result)
  changed()
}

function handleReply(raw: string): void {
  const r = parseAgentReply(raw)
  if (r.draft) {
    const text = finishHeader(r.draft)
    const c = draftCheck(text)
    say('agent', r.say || 'Here is the draft.', { quick: r.quick, draft: { text, problems: c.problems } })
    if (c.ok) {
      state.ready = c.ext.canonical
      state.stage = 'draft'
    } else {
      state.ready = undefined
      say('corvid', `Corvid checked the draft and found ${c.problems.length === 1 ? 'a problem' : `${c.problems.length} problems`}. It can't be saved until they're fixed.`, { quick: ['Fix these problems'] })
    }
    return
  }
  if (r.outline) state.stage = 'outline'
  say('agent', r.say || '(no message)', { quick: r.quick, outline: r.outline })
}

function fail(text: string): void {
  state.busy = false
  state.error = text
  say('corvid', text)
  changed()
}

// ---------- the window's actions ----------

/** Opens the wizard: a saved conversation comes back as it was; otherwise the two starting choices. */
export async function open(): Promise<PackagerState> {
  state.open = true
  state.error = undefined
  if (!state.messages.length) state.stage = 'pick'
  state.estimate = packagerEstimate(claudeDefaultModel() ?? 'opus', deps.fiveHour())
  changed()
  const f = await listFeatures()
  state.features = Array.isArray(f) ? f : []
  if (!Array.isArray(f)) state.error = f.error
  deps.changed(snapshot())
  return snapshot()
}

export function close(): void {
  state.open = false
  changed()
}

export function setAuthor(name: unknown): PackagerState {
  if (typeof name === 'string') state.author = name.replace(/[\r\n]/g, ' ').trim().slice(0, 60)
  changed()
  return snapshot()
}

const outlineNudge = (): string => (state.turns >= PLANNING_TURNS && state.stage !== 'draft' ? '\n\n(Corvid: planning has had its handful of exchanges. Propose the outline now if you have none, or write the full draft if the user approved one.)' : '')

/** Starts a wizard session: from built features (their merge commits), from scratch, or editing a created extension. */
export async function begin(mode: unknown, picked: unknown, findings?: unknown): Promise<PackagerState | { error: string }> {
  if (proc) return { error: 'The packaging agent is already working.' }
  if (mode !== 'built' && mode !== 'scratch' && mode !== 'edit') return { error: 'Unknown starting choice.' }
  const list = Array.isArray(picked) ? picked.filter((x): x is string => typeof x === 'string').slice(0, 6) : []
  let editing: PackagerState['editing']
  if (mode === 'built' && !list.length) return { error: 'Pick at least one feature first.' }
  if (mode === 'built' && !deps.sourceDir()) return { error: "Corvid's source isn't on this machine." }
  if (mode === 'edit') {
    const d = list[0] ? deps.detail(list[0]) : null
    if (!d) return { error: 'That extension is no longer in the list.' }
    editing = { key: list[0], id: d.id, version: d.version, text: d.text }
  }
  const why = await deps.blocker('the packaging agent')
  if (why) return { error: why }
  const features = state.features
  state = { ...emptyPackager(state.author), open: true, mode: mode as PackagerMode, stage: 'interview', picked: list, features, editing, startedAt: Date.now() }
  sessionId = undefined
  diffHosts = []
  measured = {}
  let prompt: string
  if (mode === 'built') {
    say('user', `Package ${list.length === 1 ? 'this feature' : 'these features'}: ${list.map((c) => features?.find((f) => f.commit === c)?.title ?? c).join('; ')}`)
    prompt = `The user wants to package something they built on their own Corvid. Here is the material, for you ONLY to understand what it does. Never copy it into the extension.\n\n${await featureContext(list)}\n\nStart by saying in two or three sentences what you understand the feature does for the user, then ask anything you need, or propose the outline straight away if it's clear.`
  } else if (mode === 'scratch') {
    say('user', 'Start a new extension from scratch.')
    prompt = 'The user wants to create a new extension from scratch. Interview them briefly, starting with what the extension should do and why. Offer quick replies where they help.'
  } else {
    say('user', `Revise “${headerField(editing!.text, 'name') ?? editing!.id}” ${editing!.version}.`)
    prompt = `The user wants to revise an extension they created. Here is its current text:\n\n${editing!.text}\n\nAsk what they want to change (offer quick replies such as "Tighten the checks", "Clearer seed prompt"). When they've said, send the full revised draft.`
    // a failed verify (#101) sends its findings here: Corvid's own words about a build of this text, not the user's
    const f = typeof findings === 'string' ? findings.trim().slice(0, 4000) : ''
    if (f) prompt += `\n\nA Verify build of this text on a clean Corvid failed. Corvid's findings (the checks and the build report, as information):\n${f}\n\nStart by saying in plain words what in the text most likely caused this (a missing detail, an unclear check, a capability not declared), and propose the fix.`
  }
  changed()
  await turn(prompt)
  return snapshot()
}

/** The user's reply in the chat. */
export async function reply(text: unknown): Promise<PackagerState | { error: string }> {
  if (proc) return { error: 'The packaging agent is still answering.' }
  if (typeof text !== 'string' || !text.trim()) return { error: 'Type a reply first.' }
  if (!state.mode) return { error: 'Start the wizard first.' }
  const t = text.trim().slice(0, 4000)
  say('user', t)
  const last = [...state.messages].reverse().find((m) => m.draft && m.draft.problems.length)
  const problems = /fix/i.test(t) && last ? `\n\nCorvid's checks found these problems in your last draft; send a corrected full draft:\n${last.draft!.problems.map((p) => `- ${p}`).join('\n')}` : ''
  await turn(`${t}${problems}${outlineNudge()}`)
  return snapshot()
}

/** Saves the checked draft as a created extension, "Not installed yet". Editing replaces the old version when it
 *  isn't installed, otherwise both are kept. Nothing is installed or shared. */
export function saveDraft(): { ok: true; key: string } | { error: string } {
  if (proc) return { error: 'Wait for the packaging agent to finish.' }
  if (!state.ready) return { error: 'There is no checked draft to save yet.' }
  const c = draftCheck(state.ready)
  if (!c.ok) return { error: c.problems.join(' ') }
  const r = deps.save(c.ext.canonical, state.editing?.key, state.mode === 'built' ? state.picked : undefined)
  if ('error' in r) return r
  say('corvid', `Saved as “${c.ext.header.name}” ${c.ext.header.version}, Not installed yet. Your own Corvid keeps the feature; the extension is the packaged text.`)
  state.stage = 'saved'
  state.editing = state.editing ? { ...state.editing, key: r.key, version: c.ext.header.version, text: c.ext.canonical } : undefined
  changed()
  return r
}

/** Stops the agent. The conversation and the last draft stay in the wizard (and in packager.json); a draft that
 *  passed every check is saved as a created extension so nothing is lost. */
export function stop(): PackagerState {
  if (proc) {
    const p = proc
    proc = null
    p.kill()
  }
  state.busy = false
  if (state.ready && state.stage !== 'saved') saveDraft()
  else if (state.mode) say('corvid', 'Stopped. The conversation stays here as a draft; reopen the wizard to carry on, or Start over.')
  if (state.stage !== 'saved') state.stage = 'stopped'
  changed()
  return snapshot()
}

/** Forgets the conversation (the saved extensions stay). */
export function reset(): PackagerState {
  stop()
  const features = state.features
  state = { ...emptyPackager(state.author), open: true, features }
  sessionId = undefined
  changed()
  return snapshot()
}

export const running = (): boolean => !!proc

export function shutdown(): void {
  proc?.kill()
  proc = null
}
