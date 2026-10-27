import { dialog, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TerminalInfo } from '@shared/types'
import { baseName, projectKey } from '@shared/projects'
import { getConfig } from './config'
import { threeSentences } from '@shared/corvidThesis'
import { addProject, checkAddable } from './projectStore'
import { CLAUDE_NOT_FOUND, resolveClaude } from './claudeBin'
import { checkNewFolder, refreshPath, track } from './projects'
import * as pty from './pty'
import { nameAgent } from './workers'

// New Project (#235: New Project again by the user's choice; was Add project #73, New project #21): pick a
// folder and it goes on the project list. A folder that is already a project, inside one or a worktree of
// one is refused. A folder with no git gets a short Claude session that runs `git init` there; files
// already in the folder stay as they are.

const WATCH_MS = 15 * 60_000

export type NewProjectResult =
  | { status: 'started'; path: string; terminal: TerminalInfo; projectId?: string }
  | { status: 'added'; path: string; projectId: string }
  | { status: 'cancelled' }
  | { status: 'skipped'; reason: string }

const PROMPT =
  'Set up this folder as a git repository for a new project. Run git init here, then run git rev-parse --show-toplevel ' +
  'to confirm the repository was created in this folder. Reply with one short line saying whether it worked, then stop.'

const SYSTEM =
  "You were started by the user's dashboard to turn this folder into a project. Your only job is to run git init in the " +
  'current folder and confirm it worked. Do not create, edit, move, or delete any files, do not stage or commit, do not ' +
  'add a remote, and do not add starter files such as README or CLAUDE.md. Files already here stay exactly as they are. ' +
  'If git init fails, say why in one line and stop; do not try workarounds. After confirming, stop and wait for the user.'

// Only what the job needs runs without a prompt; anything else asks as usual.
const ALLOWED = ['Bash(git init)', 'Bash(git rev-parse:*)', 'Bash(git status:*)']

export async function newProject(win: BrowserWindow, defaultPath: string | undefined): Promise<NewProjectResult> {
  const pick = await dialog.showOpenDialog(win, {
    title: 'Choose a folder to add as a project',
    buttonLabel: 'Add this folder',
    defaultPath,
    properties: ['openDirectory', 'createDirectory']
  })
  const path = pick.filePaths[0]
  if (pick.canceled || !path) return { status: 'cancelled' }
  const name = baseName(path)

  const dup = await checkAddable(path)
  if (dup) {
    await dialog.showMessageBox(win, { type: 'info', title: 'New Project', message: dup.error, detail: 'Nothing was added or changed.' })
    return { status: 'skipped', reason: dup.error }
  }

  const check = await checkNewFolder(path)
  if (check.kind === 'refuse') {
    await dialog.showMessageBox(win, { type: 'info', title: 'New Project', message: check.reason })
    return { status: 'skipped', reason: check.reason }
  }
  if (check.kind === 'existing') {
    // a repo already: it only needs to go on the list
    const r = await addProject({ path })
    if ('error' in r) {
      await dialog.showMessageBox(win, { type: 'info', title: 'New Project', message: r.error })
      return { status: 'skipped', reason: r.error }
    }
    track([path])
    return { status: 'added', path, projectId: r.project.id }
  }
  if (check.kind === 'nested') {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'New Project',
      message: check.inside ? `${name} is inside another git repository.` : `${name} has git repositories in its subfolders.`,
      detail: check.inside
        ? `It sits inside ${check.repoRoot}. A new repository here would be nested in that one, and the outer repository ` +
          `would stop tracking these files normally. Usually you want to work in ${baseName(check.repoRoot)} itself.`
        : `For example ${check.repoRoot}. A repository here would hold those as embedded repositories, which is rarely ` +
          `what you want. Usually you'd pick one of those project folders instead.`,
      buttons: ['Cancel', 'Create anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (r.response !== 1) return { status: 'cancelled' }
  }

  const bin = await resolveClaude(getConfig().claudePath)
  if (!bin) {
    const reason = `${CLAUDE_NOT_FOUND} No session could start, and nothing was changed.`
    await dialog.showMessageBox(win, { type: 'error', title: 'New Project', message: reason })
    return { status: 'skipped', reason }
  }

  // The Agents view knows these by the "New project ·" start, so the goofy name goes after it.
  const agentName = nameAgent({ seed: `new:${projectKey(path)}`, title: 'New project git init', project: path })
  const title = `New project · ${name}${agentName ? ` · ${agentName}` : ''}`
  // what Corvid is (#202): the three sentences only; this agent has one job and no done post
  const about = threeSentences()
  const terminal = pty.launchWorker(bin.path, path, title, PROMPT, about ? `${SYSTEM} About Corvid, the dashboard that started you: ${about}` : SYSTEM, ['--model', 'haiku', '--allowedTools', ...ALLOWED], agentName)

  const added = await addProject({ path })
  refreshWhenInitialised(path)
  return { status: 'started', path, terminal, projectId: 'project' in added ? added.project.id : undefined }
}

/** The board polls git every couple of minutes; refresh as soon as the repo appears instead. */
function refreshWhenInitialised(path: string): void {
  const started = Date.now()
  const timer = setInterval(() => {
    const done = existsSync(join(path, '.git'))
    if (!done && Date.now() - started < WATCH_MS) return
    clearInterval(timer)
    if (!done) return
    track([path])
    // give git a moment to finish writing
    setTimeout(() => void refreshPath(path), 1000)
  }, 2000)
}
