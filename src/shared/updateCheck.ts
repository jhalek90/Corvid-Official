// The launch-time update check (#143): an install made by `npm run setup` has the public repo as a fetch-only remote
// called `upstream`. On launch Corvid fetches it and counts the commits on upstream/main that the local branch doesn't
// have. It only ever notifies: the user's click on "Create update task" puts a task on the board, and a worker does
// the merge and deploy when the user starts it. Pure helpers here, shared by the main process, the window and tests.

export type UpdateStatus =
  /** the check is switched off in Settings */
  | 'off'
  /** no `upstream` remote (the maintainer's checkout), no source folder, or a test copy */
  | 'not-install'
  | 'checking'
  | 'up-to-date'
  | 'available'
  /** the fetch failed: offline, or the public repo couldn't be reached */
  | 'failed'

export interface UpdateState {
  status: UpdateStatus
  /** commits on upstream/main that the local branch doesn't have */
  count?: number
  /** upstream/main's commit id when the check ran: what Dismiss remembers */
  upstream?: string
  /** the local branch it was compared with */
  branch?: string
  /** why the check failed or was skipped, for the log and Settings */
  detail?: string
  checkedAt?: number
  /** the open "Update Corvid from the public repo" task, if there is one: the banner isn't needed then */
  openTask?: number
}

/** What the window gets: the latest check and the dismissed upstream commit. */
export interface UpdateView {
  state?: UpdateState
  /** the upstream commit the user dismissed the banner for */
  dismissed?: string
}

export const UPDATE_TASK_TITLE = 'Update Corvid from the public repo'

/** How many changes the banner offers, or undefined when it shouldn't show. */
export function bannerCount(s: UpdateState | undefined, dismissed: string | undefined): number | undefined {
  if (!s || s.status !== 'available' || !s.count || !s.upstream) return undefined
  if (s.openTask) return undefined
  if (dismissed && dismissed === s.upstream) return undefined
  return s.count
}

export const bannerText = (count: number): string => `A Corvid update is available (${count} new change${count === 1 ? '' : 's'})`

/** The line Settings shows after Check now. */
export function checkSummary(s: UpdateState | undefined): string {
  switch (s?.status) {
    case undefined:
      return 'Not checked yet.'
    case 'checking':
      return 'Checking…'
    case 'off':
      return 'The launch check is off.'
    case 'not-install':
      return s.detail ?? "This copy has no upstream remote, so there's nothing to check."
    case 'failed':
      return "Couldn't reach the public repo. Corvid tries again on the next launch."
    case 'up-to-date':
      return 'Up to date with the public repo.'
    case 'available':
      return `${s.count} new change${s.count === 1 ? '' : 's'} on the public repo.${s.openTask ? ` Update task #${s.openTask} is on the board.` : ''}`
  }
}

/** The open (not Done) update task in the Corvid project, so a second click doesn't make another. */
export function openUpdateTask<T extends { id: number; title: string; column: string; projectId?: string }>(tasks: T[], projectId: string | undefined): T | undefined {
  return tasks.find((t) => t.title.trim() === UPDATE_TASK_TITLE && t.column !== 'done' && (!projectId || t.projectId === projectId))
}

/** What the worker on the update task is told to do. */
export function updateTaskNotes(branch = 'main'): string {
  return [
    `Bring this copy of Corvid up to date with the public repo. Created from the update notice; only the user starts it.`,
    ``,
    `1. Fetch the public repo: git fetch upstream (fetch only: never pull, and never push anywhere).`,
    `2. Show the user what's new on the board: the commit titles (git log --oneline ${branch}..upstream/main) and the changed files (git diff --stat ${branch}...upstream/main).`,
    `3. Merge upstream/main into the local ${branch} branch with a merge commit (git merge --no-ff upstream/main). If you work on a task branch, merge upstream/main into it and then bring it into ${branch} with the normal task merge. Never rebase, never reset, never force anything, never push. The upstream remote has pushing disabled on purpose; leave it that way.`,
    `4. If the merge conflicts with the user's own changes, resolve each conflict carefully, keeping what the user's local change meant to do. If you're unsure about any of them, run git merge --abort, stop, and ask the user on the board.`,
    `5. Run npm run typecheck and the tests (the npm run test-* scripts). If they fail, stop and report; don't deploy.`,
    `6. Last step: before deploying, tell the user plainly on the board that Corvid restarts and every running agent, you included, ends during the deploy. Then run npm run deploy (it builds, checks the new build starts, and rolls back if it doesn't).`
  ].join('\n')
}
