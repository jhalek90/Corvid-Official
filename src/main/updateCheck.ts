import { openUpdateTask, UPDATE_TASK_TITLE, updateTaskNotes, type UpdateState, type UpdateView } from '@shared/updateCheck'
import type { Task } from '@shared/types'
import { getConfig, setConfig } from './config'
import { sourceDir } from './corvidSelf'
import { builtinProject } from './projectStore'
import { createTask, listTasks } from './tasks'
import { TEST } from './testCopy'
import { checkRepo } from './updateGit'

// The launch-time update check (#143). Notify only: a background `git fetch upstream` of Corvid's own source, a calm
// banner when upstream/main has commits this copy doesn't, and an update task when the user clicks for one. Nothing
// here pulls, merges, pushes or installs. Offline or failing, it logs one line and stays quiet.

let state: UpdateState | undefined
let running: Promise<UpdateState> | undefined
let notify: (v: UpdateView) => void = () => {}

/** A test copy only checks when the test asks (CORVID_UPDATE_TEST=1), and then may point at a fake repo. */
const testForced = (): boolean => TEST && process.env.CORVID_UPDATE_TEST === '1'

function repo(): string | undefined {
  if (testForced() && process.env.CORVID_UPDATE_REPO) return process.env.CORVID_UPDATE_REPO
  return sourceDir()
}

const corvidProjectId = (): string | undefined => builtinProject()?.id

function withTask(s: UpdateState): UpdateState {
  const open = openUpdateTask(listTasks(), corvidProjectId())
  return { ...s, openTask: open?.id }
}

export const updateView = (): UpdateView => ({ state: state && withTask(state), dismissed: getConfig().updateDismissed })

/** Check now (Settings) or on launch (`manual` false: only when the setting is on). */
export function runUpdateCheck(manual: boolean): Promise<UpdateState> {
  if (running) return running
  running = (async (): Promise<UpdateState> => {
    if (TEST && !testForced()) return { status: 'not-install', detail: "This is a test copy, so it doesn't check for updates.", checkedAt: Date.now() }
    if (!manual && !getConfig().updateCheck) return { status: 'off', checkedAt: Date.now() }
    const dir = repo()
    if (!dir) return { status: 'not-install', detail: "Corvid's own project has no source folder, so there's nothing to check.", checkedAt: Date.now() }
    state = { status: 'checking' }
    notify(updateView())
    const r = await checkRepo(dir)
    if (r.status === 'failed') console.log(`[update] couldn't check the public repo: ${r.detail}`)
    else console.log(`[update] ${r.status}${r.count ? ` (${r.count} new)` : ''}`)
    return r
  })()
    .catch((e): UpdateState => {
      console.log(`[update] check failed: ${(e as Error).message}`)
      return { status: 'failed', detail: (e as Error).message, checkedAt: Date.now() }
    })
    .then((r) => {
      state = r
      running = undefined
      notify(updateView())
      return withTask(r)
    })
  return running
}

/** Shortly after launch, in the background, so it never slows the window. */
export function startUpdateCheck(send: (v: UpdateView) => void, delayMs = 8000): void {
  notify = send
  setTimeout(() => void runUpdateCheck(false), delayMs).unref?.()
}

/** Dismiss the banner for this upstream commit; it comes back when upstream moves on. */
export function dismissUpdate(): UpdateView {
  if (state?.upstream) setConfig({ updateDismissed: state.upstream })
  const v = updateView()
  notify(v)
  return v
}

/**
 * The user's click on "Create update task": the only way this task is made. Never exposed to agents, tools or the
 * board. An open one in the Corvid project is returned instead of making a second.
 */
export function createUpdateTask(): { task?: Task; existed?: boolean; error?: string } {
  const projectId = corvidProjectId()
  if (!projectId) return { error: "Corvid's own project isn't on the list, so there's nowhere to put the update task." }
  const open = openUpdateTask(listTasks(), projectId)
  if (open) return { task: open, existed: true }
  const task = createTask({ title: UPDATE_TASK_TITLE, notes: updateTaskNotes(state?.branch), column: 'next', projectId })
  notify(updateView())
  return { task }
}
