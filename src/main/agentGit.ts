import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canPushTo } from '@shared/gitRemote'
import { pathKey, samePath } from '@shared/pathKeys'
import { worktreeRoot } from '@shared/projects'
import { toNative } from './platform'
import { pathsOf } from './platform/shared.mjs'
import { TEST } from './testCopy'

// Feature branches for workers. Before a worker starts, the dashboard gives it its own git worktree
// on a task branch, in <repo>-worktrees\task-<id>-<slug> next to the repo, so several workers can
// edit one repo at once. When it's done, the worker calls merge_task_branch and the dashboard merges
// the branch into the default branch in the main folder, one merge per repo at a time.
// Nothing here forces, rewrites history, or touches a branch other than the task's and the default.

export interface AgentBranch {
  repo: string
  branch: string
  /** where the worker works; the repo folder itself when it works on the current branch */
  cwd: string
  defaultBranch: string
  /** the worktree folder, when it has one */
  worktree?: string
  /** a branch that was already there (restarted worker, follow-up) */
  reused: boolean
}

export type BranchPlan =
  | { kind: 'branch'; b: AgentBranch }
  /** work as before: in the folder, on whatever branch it has */
  | { kind: 'current'; reason?: string }

function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()))
      else resolve(stdout)
    })
  })
}
const ok = (cwd: string, args: string[]): Promise<boolean> => git(cwd, args).then(() => true, () => false)
/** A path git printed, as the OS writes it: / to \ on Windows, unchanged elsewhere (#151). */
const nativePath = (p: string, platform: string = process.platform): string => toNative(p.trim(), platform)

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 6)
      .join('-')
      .slice(0, 40)
      .replace(/-+$/, '') || 'work'
  )
}

/** The repo's default branch: origin's HEAD, else a local main or master. */
export async function defaultBranch(repo: string): Promise<string | null> {
  const origin = await git(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  const name = origin.trim().replace(/^origin\//, '')
  if (name && (await ok(repo, ['show-ref', '--verify', '-q', `refs/heads/${name}`]))) return name
  for (const b of ['main', 'master']) if (await ok(repo, ['show-ref', '--verify', '-q', `refs/heads/${b}`])) return b
  return null
}

/** The main working folder of the repo `path` is in (not a linked worktree), or null outside git. */
export async function mainRepo(path: string): Promise<string | null> {
  return repoOfCommonDir(await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 8000).catch(() => ''))
}

/** mainRepo's answer from git's common dir: the folder holding .git, or null (outside git, or a bare repo). */
export function repoOfCommonDir(common: string, platform: string = process.platform): string | null {
  if (!common.trim()) return null
  const dir = nativePath(common, platform)
  const { basename, dirname } = pathsOf(platform)
  return basename(dir).toLowerCase() === '.git' ? dirname(dir) : null
}

export interface WorktreeEntry {
  path: string
  branch?: string
}
async function worktrees(repo: string): Promise<WorktreeEntry[]> {
  return parseWorktrees(await git(repo, ['worktree', 'list', '--porcelain']).catch(() => ''))
}

/** `git worktree list --porcelain`, main folder first, with the paths as the OS writes them. */
export function parseWorktrees(out: string, platform: string = process.platform): WorktreeEntry[] {
  return out
    .split(/\r?\n\r?\n/)
    .map((block): WorktreeEntry | null => {
      const lines = block.split(/\r?\n/)
      const path = lines.find((l) => l.startsWith('worktree '))?.slice(9)
      return path ? { path: nativePath(path, platform), branch: lines.find((l) => l.startsWith('branch refs/heads/'))?.slice(18) } : null
    })
    .filter((x): x is WorktreeEntry => !!x)
}

const same = (a: string, b: string): boolean => samePath(a, b)

/** Whether a worktree's .git file (`gitdir: <link>`) points outside the repo's common git dir, i.e. the repo moved. */
export function linksElsewhere(link: string, gitDir: string, platform: string = process.platform): boolean {
  return !pathKey(nativePath(link, platform), platform).startsWith(pathKey(nativePath(gitDir, platform), platform))
}

/**
 * After a repo was moved (4/5): its linked worktrees whose folder git can't find, or whose .git file still points
 * at the old place. Only reads; `git worktree repair` in the repo fixes them, and that's the user's call.
 */
export async function staleWorktrees(repo: string): Promise<string[]> {
  const [, ...linked] = await worktrees(repo)
  const gitDir = nativePath(await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => ''))
  if (!gitDir) return []
  return linked
    .filter((t) => {
      if (!existsSync(t.path)) return true
      const link = /^gitdir:\s*(.+)$/m.exec(readFileSyncSafe(join(t.path, '.git')))?.[1]
      return !!link && linksElsewhere(link, gitDir)
    })
    .map((t) => t.path)
}
const readFileSyncSafe = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** Local branches the dashboard made for workers. */
export async function taskBranches(repo: string): Promise<string[]> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/task-*']).catch(() => '')
  return out.split('\n').map((s) => s.trim()).filter((s) => /^task-\d+-/.test(s))
}

/** Commits on `branch` that `base` doesn't have. */
export async function aheadOf(repo: string, base: string, branch: string): Promise<number> {
  const n = await git(repo, ['rev-list', '--count', `${base}..${branch}`]).catch(() => '0')
  return Number(n.trim()) || 0
}

/** Repos that can't be built outside their folder: Unity keeps a huge ignored Library next to Assets. */
const worktreeUnfit = (repo: string): string | null =>
  existsSync(join(repo, 'ProjectSettings', 'ProjectVersion.txt'))
    ? 'it is a Unity project, which would have to reimport everything in a second folder'
    : null

/**
 * Get a task's branch ready before its worker launches: reuse the task's branch and worktree if they
 * exist, otherwise branch from the default branch into a new worktree. Falls back to working on the
 * current branch (the old behaviour) when that's the only safe option, and says why.
 */
export async function prepareBranch(project: string, taskId: number, title: string): Promise<BranchPlan> {
  const repo = await mainRepo(project)
  if (!repo) return { kind: 'current', reason: 'the project is not a git repository' }
  if (!(await ok(repo, ['rev-parse', '--verify', '-q', 'HEAD']))) return { kind: 'current', reason: 'the repository has no commits yet, so the first commit goes on the default branch' }
  const base = await defaultBranch(repo)
  if (!base) return { kind: 'current', reason: 'no default branch (main or master) was found' }
  const unfit = worktreeUnfit(repo)
  if (unfit) return { kind: 'current', reason: `a separate worktree isn't workable here: ${unfit}` }

  const existing = (await taskBranches(repo)).find((b) => b.startsWith(`task-${taskId}-`))
  const branch = existing ?? `task-${taskId}-${slug(title)}`
  const trees = await worktrees(repo)
  const tree = trees.find((t) => t.branch === branch)
  if (tree && same(tree.path, repo)) return { kind: 'current', reason: `the main folder has ${branch} checked out` }
  if (tree && existsSync(tree.path)) {
    // the repo was moved and the worktree still links to the old place (4/5): git would fail in it
    if ((await staleWorktrees(repo)).some((t) => same(t, tree.path)))
      return { kind: 'current', reason: `its worktree ${tree.path} still links to the project's old folder; run "git worktree repair" in ${repo} to fix it` }
    return { kind: 'branch', b: { repo, branch, cwd: tree.path, defaultBranch: base, worktree: tree.path, reused: true } }
  }

  await git(repo, ['worktree', 'prune']).catch(() => {})
  const path = join(`${repo}-worktrees`, branch)
  if (existsSync(path)) return { kind: 'current', reason: `${path} already exists and isn't this task's worktree` }
  mkdirSync(dirname(path), { recursive: true })
  try {
    if (existing) await git(repo, ['worktree', 'add', path, branch])
    else await git(repo, ['worktree', 'add', '-b', branch, path, base])
  } catch (e) {
    return { kind: 'current', reason: `git worktree add failed: ${(e as Error).message.split('\n')[0]}` }
  }
  linkDeps(repo, path)
  await ignoreDepsLink(path)
  return { kind: 'branch', b: { repo, branch, cwd: path, defaultBranch: base, worktree: path, reused: !!existing } }
}

/**
 * On macOS and Linux the link is a plain symlink, and git sees a symlink as a file, so the common "node_modules/"
 * ignore rule (folders only) misses it: it would show as new, keep cleanUp from removing the worktree, and could be
 * committed. When git doesn't ignore it, add /node_modules to the repo's local, untracked info/exclude (#151).
 * Windows git treats the junction as a folder, so nothing is needed there.
 */
export async function ignoreDepsLink(tree: string, platform: string = process.platform): Promise<boolean> {
  try {
    if (platform === 'win32' || !lstatSync(join(tree, 'node_modules')).isSymbolicLink()) return false
  } catch {
    return false
  }
  if (await ok(tree, ['check-ignore', '-q', 'node_modules'])) return false
  const common = (await git(tree, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')).trim()
  if (!common) return false
  const file = join(common, 'info', 'exclude')
  try {
    const had = existsSync(file) ? readFileSync(file, 'utf8') : ''
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${had && !had.endsWith('\n') ? '\n' : ''}/node_modules\n`)
    return true
  } catch {
    return false
  }
}

/**
 * A fresh worktree has none of the ignored files, node_modules above all. It gets a junction (a plain
 * symlink on macOS and Linux) to the main folder's node_modules: instant, no second download of Electron, and native modules built for
 * this machine keep working. The cost: it's shared, so installing packages in the worktree would
 * change the main folder's. Workers are told to replace the link before installing anything.
 */
export function linkDeps(repo: string, tree: string): void {
  const src = join(repo, 'node_modules')
  const dst = join(tree, 'node_modules')
  if (!existsSync(src) || existsSync(dst)) return
  try {
    symlinkSync(src, dst, 'junction')
  } catch {
    /* the worker can still npm install */
  }
}

/** Remove the node_modules junction without ever recursing into what it points at. */
export function unlinkDeps(tree: string): void {
  const dst = join(tree, 'node_modules')
  try {
    if (!lstatSync(dst).isSymbolicLink()) return
  } catch {
    return
  }
  try {
    unlinkSync(dst)
  } catch {
    // a non-recursive rmdir removes a junction, and fails harmlessly on a real folder with files in it
    try {
      rmdirSync(dst)
    } catch {
      /* left in place */
    }
  }
}

// ---------- merging ----------

const locks = new Map<string, Promise<unknown>>()

/** Run `fn` with this repo's merge lock, waiting up to `waitMs` for an earlier merge to finish. */
async function withLock<T>(repo: string, waitMs: number, fn: () => Promise<T>): Promise<T | 'busy'> {
  const key = repo.toLowerCase()
  const started = Date.now()
  while (locks.has(key)) {
    if (Date.now() - started > waitMs) return 'busy'
    await Promise.race([locks.get(key), new Promise((r) => setTimeout(r, 1000))]).catch(() => {})
  }
  const p = fn()
  locks.set(key, p)
  try {
    return await p
  } finally {
    locks.delete(key)
  }
}

export interface MergeResult {
  ok: boolean
  /** merged and nothing left to do but clean up when the worker ends */
  merged?: boolean
  message: string
}

/**
 * Merge a worker's branch into the default branch, in the main folder, with a merge commit.
 * Refuses rather than forces: uncommitted work anywhere, the main folder busy or on another branch,
 * conflicts (aborted, so the default branch is exactly as it was). Pushes only when `push` is set.
 */
export async function mergeBranch(b: AgentBranch, subject: string, push: boolean, waitMs = 120_000, body?: string): Promise<MergeResult> {
  // a test copy never merges or pushes for real (#85)
  if (TEST) return { ok: false, message: 'This is a test copy of Corvid, so it merges and pushes nothing.' }
  const tree = b.worktree ?? b.cwd
  const own = await git(tree, ['status', '--porcelain', '--untracked-files=no']).catch((e) => `?? ${e.message}`)
  if (own.trim()) return { ok: false, message: `Your branch has uncommitted changes. Commit them on ${b.branch} first, then call this again.` }
  const ahead = await aheadOf(b.repo, b.defaultBranch, b.branch)
  if (!ahead) return { ok: true, message: `${b.branch} has no commits that ${b.defaultBranch} lacks, so there is nothing to merge. The branch will be removed when you finish.` }

  const r = await withLock(b.repo, waitMs, async (): Promise<MergeResult> => {
    const head = (await git(b.repo, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')).trim()
    if (head !== b.defaultBranch)
      return { ok: false, message: `The main folder (${b.repo}) is on ${head || 'a detached HEAD'}, not ${b.defaultBranch}, so nothing was merged. The user switched it; leave it to them.` }
    if (existsSync(join(b.repo, '.git', 'index.lock')) || existsSync(join(b.repo, '.git', 'MERGE_HEAD')))
      return { ok: false, message: `Another git process is using ${b.repo} (or a merge is already in progress there), so nothing was merged. Try again in a minute.` }
    const dirty = await git(b.repo, ['status', '--porcelain', '--untracked-files=no']).catch((e) => `?? ${e.message}`)
    if (dirty.trim())
      return { ok: false, message: `${b.defaultBranch} in ${b.repo} has uncommitted changes (the user's work in progress), so nothing was merged. ${b.branch} is left ready to merge.` }
    const before = (await git(b.repo, ['rev-parse', 'HEAD'])).trim()
    try {
      // body: further paragraphs, such as an extension's trailer (#98)
      await git(b.repo, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${b.branch}: ${subject}`.slice(0, 200), ...(body ? ['-m', body] : []), b.branch])
    } catch (e) {
      const conflicts = (await git(b.repo, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim().split('\n').filter(Boolean)
      if (existsSync(join(b.repo, '.git', 'MERGE_HEAD'))) await git(b.repo, ['merge', '--abort']).catch(() => {})
      const after = (await git(b.repo, ['rev-parse', 'HEAD']).catch(() => '')).trim()
      const intact = after === before && !(await git(b.repo, ['status', '--porcelain', '--untracked-files=no']).catch(() => 'x')).trim()
      return {
        ok: false,
        message:
          (conflicts.length
            ? `Merging ${b.branch} into ${b.defaultBranch} conflicts in ${conflicts.slice(0, 10).join(', ')}. `
            : `git merge failed: ${(e as Error).message.split('\n')[0]}. `) +
          (intact ? `The merge was aborted and ${b.defaultBranch} is exactly as it was. ` : `WARNING: ${b.repo} may not be back where it was; tell the user. `) +
          `${b.branch} is left as it is for the user to resolve. Don't retry and don't rebase.`
      }
    }
    let pushed = ''
    if (push) {
      const remote = (await git(b.repo, ['config', '--get', `branch.${b.defaultBranch}.remote`]).catch(() => '')).trim()
      const pushUrl = remote ? (await git(b.repo, ['remote', 'get-url', '--push', remote]).catch(() => '')).trim() : ''
      if (!remote) pushed = ` Push after merge is on, but ${b.defaultBranch} has no upstream, so nothing was pushed.`
      // an install's public repo (#143): fetch only, so skip quietly instead of failing a push
      else if (!canPushTo(pushUrl)) pushed = ` Push after merge is on, but ${remote} doesn't take pushes from this repository, so nothing was pushed.`
      else
        pushed = await git(b.repo, ['push', remote, `${b.defaultBranch}:${b.defaultBranch}`], 120_000).then(
          () => ` Pushed ${b.defaultBranch} to ${remote}.`,
          (e) => ` Push to ${remote} failed (${(e as Error).message.split('\n')[0]}); the merge stays local.`
        )
    }
    return {
      ok: true,
      merged: true,
      message: `Merged ${b.branch} (${ahead} commit${ahead === 1 ? '' : 's'}) into ${b.defaultBranch} with a merge commit.${pushed} The branch and worktree are removed when your session ends; make no more commits.`
    }
  })
  return r === 'busy' ? { ok: false, message: `Another merge into ${b.repo} kept the lock for over ${Math.round(waitMs / 1000)} s, so nothing was merged. ${b.branch} is left ready to merge.` } : r
}

/**
 * After the worker's process has ended (Windows can't delete a folder a process has open): remove the
 * worktree and the branch, but only when everything on it is in the default branch. `git branch -d`
 * refuses unmerged branches by itself; nothing is forced. Returns what was kept and why, if anything.
 */
export async function cleanUp(b: AgentBranch): Promise<string | null> {
  if (!b.worktree) return null
  const ahead = await aheadOf(b.repo, b.defaultBranch, b.branch)
  if (ahead) return `${b.branch} kept: ${ahead} commit${ahead === 1 ? '' : 's'} not merged into ${b.defaultBranch}.`
  const dirty = await git(b.worktree, ['status', '--porcelain']).catch(() => '')
  if (dirty.trim()) return `${b.branch} kept: its worktree has uncommitted files.`
  unlinkDeps(b.worktree)
  try {
    await git(b.repo, ['worktree', 'remove', b.worktree])
    await git(b.repo, ['branch', '-d', b.branch])
  } catch (e) {
    return `${b.branch} kept: ${(e as Error).message.split('\n')[0]}`
  }
  return null
}

/**
 * What closing a finished worker now would leave unmerged (#70), as the note its card shows, or null when nothing would.
 * Only reads: on a task branch, commits the default branch lacks or uncommitted files in the worktree (what cleanUp
 * would keep the branch for); on the current branch, uncommitted files in the folder. A check that fails counts as work.
 */
export async function unsavedWork(b: AgentBranch | undefined, folder: string): Promise<string | null> {
  try {
    if (b?.worktree) {
      const ahead = Number((await git(b.repo, ['rev-list', '--count', `${b.defaultBranch}..${b.branch}`])).trim())
      if (!Number.isFinite(ahead)) throw new Error('no count')
      if (ahead) return `Finished, but has unmerged work: ${ahead} commit${ahead === 1 ? '' : 's'} on ${b.branch} not merged into ${b.defaultBranch}`
      if ((await git(b.worktree, ['status', '--porcelain'])).trim()) return `Finished, but has uncommitted changes in ${b.branch}`
      return null
    }
    if (!(await mainRepo(folder))) return null
    if ((await git(folder, ['status', '--porcelain'])).trim()) return 'Finished, but its folder has uncommitted changes'
    return null
  } catch {
    return "Finished, but Corvid couldn't check its git for unmerged work"
  }
}

/** Branches a running worker is on (repo|branch, lowercased): still in progress, not forgotten. */
export const activeBranches = new Set<string>()
const activeKey = (repo: string, branch: string): string => `${repo}|${branch}`.toLowerCase()
export const setActive = (b: AgentBranch, on: boolean): void => void (on ? activeBranches.add(activeKey(b.repo, b.branch)) : activeBranches.delete(activeKey(b.repo, b.branch)))

/** Unmerged task branches no running worker is on, for the project risk. */
export async function unmergedTaskBranches(repo: string): Promise<{ name: string; ahead: number }[]> {
  if (worktreeRoot(repo)) return []
  const base = await defaultBranch(repo)
  if (!base) return []
  const out: { name: string; ahead: number }[] = []
  for (const name of await taskBranches(repo)) {
    if (activeBranches.has(activeKey(repo, name))) continue
    const ahead = await aheadOf(repo, base, name)
    if (ahead) out.push({ name, ahead })
  }
  return out
}
